/* Time Machine for YouTube — the crawler.
 *
 * Three ways the pool grows, in order of how good the results are:
 *
 *   1. Graph walk. Take a video already in the pool, ask YouTube what's
 *      related to it, keep the pre-cutoff results. Old videos have old
 *      neighbours, so this compounds fast and stays on-taste.
 *   2. Playlist mining. A 2009 playlist called "amv's :)" was assembled by a
 *      human with exactly the taste you're after. Highest signal per request.
 *   3. Seed search. Only really needed to prime an empty pool, or to break
 *      out of a rut.
 *
 * All of it is rate-limited, idle-gated, capped per day, and backs off when
 * YouTube pushes back. Three kinds of failure are kept apart on purpose:
 *
 *   not ready    — no tab to ask, or it isn't answering. Costs nothing, so
 *                  no back-off; just say so and try again next tick.
 *   rate limited — YouTube answered 429/403. Long back-off, doubling.
 *   hiccup       — anything else. Short back-off.
 *
 * The worker that runs this is torn down every 30 seconds of quiet, so the
 * crawler's own memory lives in chrome.storage.session.
 */
(function (root) {
  'use strict';

  var Db = root.RTDb;
  var Innertube = root.RTInnertube;
  var Seeds = root.RTSeeds;

  var STATE_KEY = 'crawlerState';
  var DEFAULT_STATE = {
    lastRun: 0,
    lastError: null,
    lastActivity: null,
    idle: false,
    windowStart: 0,
    windowUsed: 0,
    dayKey: '',
    dayUsed: 0,
    backoffUntil: 0,
    backoffMs: 0,
    backoffKind: null
  };

  // In-memory only: a second tick arriving while one is in flight should
  // simply skip. If the worker dies mid-run this resets, which is correct.
  var running = false;

  async function loadState() {
    var res = await chrome.storage.session.get(STATE_KEY);
    return Object.assign({}, DEFAULT_STATE, (res && res[STATE_KEY]) || {});
  }

  async function saveState(st) {
    var patch = {};
    patch[STATE_KEY] = st;
    await chrome.storage.session.set(patch);
  }

  async function settings() {
    var res = await chrome.storage.local.get('settings');
    return Object.assign({}, Seeds.DEFAULT_SETTINGS, (res && res.settings) || {});
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  /* Returns a human-readable reason not to make a request right now, or
   * null. Rolls the per-minute and per-day windows as a side effect. */
  function budgetReason(st, cfg, ignoreMinute) {
    var now = Date.now();
    if (now - st.windowStart > 60000) {
      st.windowStart = now;
      st.windowUsed = 0;
    }
    if (st.dayKey !== today()) {
      st.dayKey = today();
      st.dayUsed = 0;
    }
    if (st.backoffUntil > now) {
      return 'paused until ' + new Date(st.backoffUntil).toLocaleTimeString() +
        (st.backoffKind === 'rate' ? ' because YouTube refused a request' : ' after an error') +
        (st.lastError ? ' (' + st.lastError + ')' : '');
    }
    if (cfg.crawlDailyCap > 0 && st.dayUsed >= cfg.crawlDailyCap) {
      return 'daily cap of ' + cfg.crawlDailyCap + ' requests reached; resets at midnight';
    }
    if (!ignoreMinute && st.windowUsed >= cfg.crawlPerMinute) {
      return 'per-minute budget used; the next round starts shortly';
    }
    return null;
  }

  function spend(st) {
    st.windowUsed++;
    st.dayUsed++;
  }

  function noteSuccess(st) {
    st.backoffMs = 0;
    st.backoffUntil = 0;
    st.backoffKind = null;
    st.lastError = null;
  }

  function noteError(st, err) {
    st.lastError = String(err && err.message || err);
    if (err && err.notReady) {
      // Nothing was sent, nothing to protect against.
      return;
    }
    if (err && err.rateLimited) {
      st.backoffKind = 'rate';
      st.backoffMs = Math.min(Math.max(st.backoffMs * 2, 15 * 60000), 6 * 3600000);
    } else {
      st.backoffKind = 'error';
      st.backoffMs = Math.min(Math.max(st.backoffMs * 2, 2 * 60000), 30 * 60000);
    }
    st.backoffUntil = Date.now() + st.backoffMs;
  }

  function pause(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* Jittered delay so requests don't land on a metronome. Capped well under
   * the worker's idle timeout. */
  function humanPause(perMinute) {
    var base = 60000 / Math.max(1, perMinute);
    var jitter = base * (0.6 + Math.random() * 0.8);
    return pause(Math.min(jitter, 20000));
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function isHiddenChannel(cfg, rec) {
    if (!rec) return false;
    var list = cfg.hiddenChannels || [];
    return (rec.channelId && list.indexOf(rec.channelId) !== -1) ||
           (rec.channel && list.indexOf(rec.channel) !== -1);
  }

  /* A channel with this many videos in the pool already is a rut. Walking
   * from another of its videos yields twenty more of the same. */
  var CHANNEL_SATURATED = 40;

  /* Keep one related list from being twenty episodes of the same show. */
  var PER_CHANNEL_PER_BATCH = 6;

  function thinByChannel(found) {
    var seen = Object.create(null);
    return found.filter(function (rec) {
      var key = rec.channelId || rec.channel || null;
      if (!key) return true;
      seen[key] = (seen[key] || 0) + 1;
      return seen[key] <= PER_CHANNEL_PER_BATCH;
    });
  }

  /* ------------------------------------------------------------ graph walk */

  /* Which video to ask about next. Skip hidden and saturated channels.
   * Frontier entries that are skipped for good are marked done so they don't come
   * back every tick. */
  async function pickFrontier(cfg) {
    var rows = await Db.nextFrontier(40);
    if (!rows.length) return null;
    for (var i = 0; i < rows.length; i++) {
      var rec = await Db.getVideo(rows[i].id);
      if (!rec) continue;
      if (isHiddenChannel(cfg, rec)) { await Db.markFrontierDone(rows[i].id); continue; }
      if (rec.channelId && (await Db.countChannel(rec.channelId)) >= CHANNEL_SATURATED) {
        await Db.markFrontierDone(rows[i].id);
        continue;
      }
      return rows[i];
    }
    return null;
  }

  async function walkGraph(cfg, st) {
    var target = await pickFrontier(cfg);
    if (!target) return { did: false, reason: 'frontier empty' };

    try {
      var data = await Innertube.related(target.id);
      spend(st);
      var found = thinByChannel(Innertube.reap(data, cfg.cutoffYear));
      var added = await Db.putVideos(found, 'graph:' + target.id);
      await Db.markFrontierDone(target.id);
      noteSuccess(st);
      st.lastActivity = 'graph walk from ' + target.id + ': +' + added;
      return { did: true, added: added, found: found.length };
    } catch (err) {
      noteError(st, err);
      // A transient failure leaves the video on the frontier for another go.
      if (!err || !err.transient) await Db.markFrontierDone(target.id);
      return { did: false, reason: st.lastError };
    }
  }

  /* -------------------------------------------------------- playlist mining */

  async function minePlaylists(cfg, st) {
    var seeds = Seeds.allSeeds(cfg);
    if (!seeds.length) return { did: false, reason: 'no seeds' };

    var term = pick(seeds);
    var query = term + ' before:' + (cfg.cutoffYear + 1);

    try {
      var data = await Innertube.search(query, Innertube.FILTER_PLAYLISTS);
      spend(st);
      var ids = Innertube.findPlaylistIds(data, 3);
      if (!ids.length) {
        noteSuccess(st);
        st.lastActivity = 'no playlists for "' + term + '"';
        return { did: true, added: 0, found: 0 };
      }

      await humanPause(cfg.crawlPerMinute);
      var pdata = await Innertube.playlist(pick(ids));
      spend(st);
      var found = thinByChannel(Innertube.reap(pdata, cfg.cutoffYear));
      var added = await Db.putVideos(found, 'playlist:' + term);
      noteSuccess(st);
      st.lastActivity = 'playlist "' + term + '": +' + added;
      return { did: true, added: added, found: found.length };
    } catch (err) {
      noteError(st, err);
      return { did: false, reason: st.lastError };
    }
  }

  /* ----------------------------------------------------------- seed search */

  async function seedSearch(cfg, st) {
    var seeds = Seeds.allSeeds(cfg).concat(cfg.learnedSeeds || []);
    if (!seeds.length) return { did: false, reason: 'no seeds' };

    var term = pick(seeds);
    var query = term + ' before:' + (cfg.cutoffYear + 1);

    try {
      var data = await Innertube.search(query);
      spend(st);
      var found = thinByChannel(Innertube.reap(data, cfg.cutoffYear));
      var added = await Db.putVideos(found, 'seed:' + term);
      noteSuccess(st);
      st.lastActivity = 'search "' + term + '": +' + added;
      return { did: true, added: added, found: found.length, term: term };
    } catch (err) {
      noteError(st, err);
      return { did: false, reason: st.lastError };
    }
  }

  /* -------------------------------------------------------------- schedule */

  function pickStrategy(cfg, poolSize, frontierSize) {
    var roll = Math.random();

    // An empty pool needs ignition before the graph is worth walking.
    if (poolSize < 60) return cfg.seedSearches ? seedSearch : walkGraph;
    if (frontierSize === 0) {
      return cfg.crawlPlaylists ? minePlaylists : (cfg.seedSearches ? seedSearch : null);
    }

    if (roll < 0.65) return walkGraph;
    if (roll < 0.85 && cfg.crawlPlaylists) return minePlaylists;
    if (cfg.seedSearches) return seedSearch;
    return walkGraph;
  }

  async function checkReady(st) {
    if (!(await Innertube.loadCredentials())) {
      st.lastError = 'no API credentials yet. Open youtube.com in a tab, ' +
        'let it finish loading, then try again.';
      return false;
    }
    if (!(await Innertube.ready())) {
      st.lastError = 'the open YouTube tab is not answering. Tabs opened before the ' +
        'extension was updated go quiet — reload that tab (F5) or open a new youtube.com tab.';
      return false;
    }
    return true;
  }

  /* One scheduled round. `force` is the "Collect now" button: it ignores the
   * idle gate, the per-minute window, and any pause that wasn't caused by
   * YouTube refusing a request — but never the daily cap or a rate-limit
   * pause, which exist to protect the account. */
  async function tick(force) {
    if (running) return { did: false, reason: 'a round is already running' };
    running = true;

    try {
      var cfg = await settings();
      var st = await loadState();
      var result;

      if (force && st.backoffUntil && st.backoffKind !== 'rate') {
        st.backoffUntil = 0;
        st.backoffMs = 0;
        st.backoffKind = null;
      }

      var reason = null;
      if (!cfg.enabled) reason = 'filtering is switched off';
      else if (!cfg.crawlEnabled) reason = 'background collecting is switched off';
      else if (!force && cfg.crawlOnlyWhenIdle && !st.idle) {
        reason = 'waiting until you are away from the computer';
      }
      if (!reason) reason = budgetReason(st, cfg, !!force);

      if (reason) {
        result = { did: false, reason: reason };
      } else if (!(await checkReady(st))) {
        result = { did: false, reason: st.lastError };
      } else {
        result = await run(cfg, st, !!force);
      }

      await saveState(st);
      return result;
    } catch (err) {
      return { did: false, reason: String(err && err.message || err) };
    } finally {
      running = false;
    }
  }

  async function run(cfg, st, force) {
    var counts = await Promise.all([Db.countVideos(), Db.frontierSize()]);
    var poolSize = counts[0];
    var frontier = counts[1];
    if (poolSize >= cfg.poolTarget) {
      return { did: false, reason: 'the pool is at its target size of ' + cfg.poolTarget };
    }

    // The alarm fires twice a minute, so each round makes a share of the
    // per-minute budget, spaced out like a person clicking.
    var perTick = force ? 1 : Math.max(1, Math.round(cfg.crawlPerMinute / 2));
    var last = { did: false, reason: 'nothing to do' };

    for (var i = 0; i < perTick; i++) {
      if (i > 0) {
        await humanPause(cfg.crawlPerMinute);
        var stop = budgetReason(st, cfg, force);
        if (stop) break;
      }
      var strategy = pickStrategy(cfg, poolSize, frontier);
      if (!strategy) return { did: false, reason: 'nothing to do: turn on playlists or seed searches' };
      last = await strategy(cfg, st);
      st.lastRun = Date.now();
      if (!last.did) break;
      if (last.added) poolSize += last.added;
    }
    return last;
  }

  /* "Run a round of searches": a burst of seed searches to ignite an empty
   * pool. Ignores the idle gate, respects the daily cap and a rate-limit
   * pause, and paces itself so the burst still reads as browsing. */
  async function primePool(rounds) {
    if (running) return { added: 0, found: 0, reasons: ['a round is already running'] };
    running = true;
    try {
      var cfg = await settings();
      var st = await loadState();
      var total = 0, found = 0, reasons = [], terms = [];

      if (st.backoffUntil && st.backoffKind !== 'rate') {
        st.backoffUntil = 0;
        st.backoffMs = 0;
        st.backoffKind = null;
      }

      if (!(await checkReady(st))) {
        await saveState(st);
        return { added: 0, found: 0, reasons: [st.lastError] };
      }

      for (var i = 0; i < (rounds || 5); i++) {
        var stop = budgetReason(st, cfg, true);
        if (stop) { reasons.push(stop); break; }
        var r = await seedSearch(cfg, st);
        if (r.did) {
          total += r.added || 0;
          found += r.found || 0;
          if (r.term) terms.push(r.term);
        } else if (r.reason && reasons.indexOf(r.reason) === -1) {
          reasons.push(r.reason);
          if (st.backoffUntil > Date.now()) break;
        }
        await pause(2000 + Math.random() * 2500);
      }
      await saveState(st);
      return { added: total, found: found, reasons: reasons, terms: terms };
    } finally {
      running = false;
    }
  }

  /* The sidebar searches on demand, for you, but YouTube sees one client.
   * If it has asked us to back off, the sidebar backs off too — and if the
   * sidebar is the one refused, the collector pauses with it. */
  async function pausedUntil() {
    var st = await loadState();
    return st.backoffUntil > Date.now() && st.backoffKind === 'rate' ? st.backoffUntil : 0;
  }

  async function noteRefusal(err) {
    var st = await loadState();
    noteError(st, err);
    await saveState(st);
  }

  async function setIdle(isIdle) {
    var st = await loadState();
    st.idle = !!isIdle;
    await saveState(st);
  }

  async function status() {
    var r = await Promise.all([
      Db.countVideos(), Db.frontierSize(), loadState(), Innertube.loadCredentials()
    ]);
    var st = r[2];
    if (st.dayKey !== today()) st.dayUsed = 0;
    return {
      pool: r[0],
      frontier: r[1],
      lastRun: st.lastRun,
      lastError: st.lastError,
      lastActivity: st.lastActivity,
      idle: st.idle,
      dayUsed: st.dayUsed,
      backoffUntil: st.backoffUntil > Date.now() ? st.backoffUntil : 0,
      backoffKind: st.backoffUntil > Date.now() ? st.backoffKind : null,
      hasCreds: !!r[3]
    };
  }

  var api = {
    tick: tick,
    primePool: primePool,
    setIdle: setIdle,
    status: status,
    pausedUntil: pausedUntil,
    noteRefusal: noteRefusal
  };

  root.RTCrawler = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
