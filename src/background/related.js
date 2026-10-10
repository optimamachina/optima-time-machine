/* Time Machine for YouTube — the sidebar's related videos.
 *
 * YouTube's own related list for a 2008 video is mostly this week's videos:
 * regional news, whatever is trending, a livestream. Once the wall has been
 * through it there are two or three cards left, usually from the same
 * channel. Ranking the pool against the title can't fix that either — the
 * pool is whatever happened to be collected, not what this video is about.
 *
 * So the list is built the way you would build it by hand: by searching the
 * old years for what this video is about.
 *
 *   title   — the video's own title, tidied. Finds responses, re-uploads,
 *             parodies, other AMVs to the same song.
 *   topic   — the words that matter in the title, the uploader's tags and
 *             the category, minus the channel's own name. Finds other
 *             people's videos about the same thing.
 *   channel — the uploader's name. Finds the rest of their old uploads.
 *
 * Every search carries before:<cutoff + 1>, so YouTube does the date
 * filtering at the source, and every result still has to pass the wall.
 * The lists are interleaved so no one channel or search takes over,
 * topped up from the pool, and kept per video for a few days — revisiting a
 * video costs YouTube nothing, and a channel's own search is shared by every
 * video of that channel.
 */
(function (root) {
  'use strict';

  var Db = root.RTDb;
  var Innertube = root.RTInnertube;
  var Taste = root.RTTaste;
  var Rank = root.RTRank;
  var Crawler = root.RTCrawler;

  var VIDEO_CACHE_MS = 5 * 24 * 3600000;
  var CHANNEL_CACHE_MS = 7 * 24 * 3600000;
  var DAILY_SEARCHES = 400;
  var STATE_KEY = 'relatedState';
  var KEEP = 40; // how many to remember per video; the sidebar shows fewer

  // Two tabs, or a tab and the watchdog, asking about the same video share
  // one set of searches.
  var inflight = Object.create(null);

  /* A category word helps a topic search only where it names a genre. */
  var CATEGORY_WORDS = {
    'Comedy': 'comedy',
    'Gaming': 'gameplay',
    'Film & Animation': 'animation',
    'Sports': 'sports',
    'Autos & Vehicles': 'cars',
    'Pets & Animals': 'animals'
  };

  /* ------------------------------------------------------------- queries */

  function squash(text) {
    return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  /* The words that are only the channel's name. Tags like "barats" and
   * "bereta" on a BaratsAndBereta video would just find the channel again,
   * which the channel search already does. But "naruto" on a video from
   * xXNarutoFanXx is the whole point of the video, so a word only counts as
   * the name when, together with the others, it spells out most of it. */
  function channelWords(cur) {
    var name = squash(cur.channel);
    var out = Object.create(null);
    if (name.length < 3) return out;
    var candidates = [];
    Taste.tokenize(cur.title + ' ' + (cur.keywords || []).join(' ')).forEach(function (w) {
      var s = squash(w);
      if (s.length >= 3 && name.indexOf(s) !== -1 && candidates.indexOf(s) === -1) candidates.push(s);
    });
    var covered = candidates.reduce(function (n, w) { return n + w.length; }, 0);
    if (candidates.length && (candidates.indexOf(name) !== -1 || covered >= name.length * 0.6)) {
      candidates.forEach(function (w) { out[w] = true; });
    }
    return out;
  }

  var NOISE_RE = /\b(hq|hd|high quality|official( music)? video|official|full version|with lyrics|lyrics|720p|1080p|480p)\b/gi;

  /* "Naruto AMV - Numb [HQ] (Linkin Park)" -> "Naruto AMV Numb Linkin Park". */
  function cleanTitle(title, nameWords) {
    var t = String(title || '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(NOISE_RE, ' ')
      .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    var kept = t.split(' ').filter(function (w) { return w && !nameWords[squash(w)]; });
    return kept.slice(0, 8).join(' ');
  }

  /* Up to four words about the subject — the title's own, then the
   * uploader's tags — and the genre where the category names one. */
  function topicQuery(cur, nameWords) {
    var words = [];
    function add(w) {
      if (words.length >= 4 || nameWords[squash(w)] || words.indexOf(w) !== -1) return;
      words.push(w);
    }

    // The title first — the most specific thing anyone said about this
    // video.
    Taste.tokenize(cur.title).slice(0, 3).forEach(add);

    // Then the tags, a word at a time so "linkin park" after "linkin" adds
    // only "park".
    var tags = 0;
    (cur.keywords || []).forEach(function (k) {
      if (tags >= 2 || words.length >= 4) return;
      var before = words.length;
      Taste.tokenize(k).forEach(add);
      if (words.length > before) tags++;
    });

    // One word on its own ("number") finds anything at all.
    if (words.length < 2) return null;

    var cat = CATEGORY_WORDS[cur.category];
    if (cat && words.indexOf(cat) === -1) words.push(cat);
    return words.join(' ');
  }

  /* What to search for, and which of those searches can be answered from
   * cache. */
  function plan(cur, cfg) {
    var before = ' before:' + (cfg.cutoffYear + 1);
    var channelSquashed = squash(cur.channel);
    var nameWords = channelWords(cur);
    var out = [];

    var title = cleanTitle(cur.title, nameWords);
    if (title.length >= 2) out.push({ name: 'title', q: title + before });

    var topic = topicQuery(cur, nameWords);
    if (topic && topic.toLowerCase() !== title.toLowerCase()) out.push({ name: 'topic', q: topic + before });

    if (cur.channel) {
      out.push({
        name: 'channel',
        q: cur.channel + before,
        cacheKey: 'c:' + (cur.channelId || channelSquashed) + ':' + cfg.cutoffYear
      });
    }
    return out;
  }

  /* ----------------------------------------------------------- allowance */

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  /* Returns a reason not to search right now, or null — and when null,
   * books the searches against today's allowance. */
  async function allowance(n) {
    if (!n) return null;
    var paused = await Crawler.pausedUntil();
    if (paused) {
      return 'YouTube asked for a pause, so no new searches until ' +
        new Date(paused).toLocaleTimeString();
    }
    var res = await chrome.storage.session.get(STATE_KEY);
    var st = (res && res[STATE_KEY]) || {};
    if (st.day !== today()) st = { day: today(), used: 0 };
    if (st.used + n > DAILY_SEARCHES) {
      return 'the sidebar has made its ' + DAILY_SEARCHES + ' searches for today';
    }
    st.used += n;
    var patch = {};
    patch[STATE_KEY] = st;
    await chrome.storage.session.set(patch);
    return null;
  }

  /* ------------------------------------------------------------ assembly */

  function channelKeyOf(v) {
    return v.channelId || squash(v.channel) || null;
  }

  /* Deal the lists out in turn — topic gets two turns to everyone else's
   * one, because it is the list most likely to hold what you'd click next
   * that you haven't seen. The current video's channel may fill up to a
   * third of the list; any other channel three places. */
  var PATTERN = ['title', 'topic', 'channel', 'edges', 'topic', 'title', 'channel', 'topic'];

  function interleave(lists, cur, limit) {
    var out = [];
    var seen = Object.create(null);
    var perChannel = Object.create(null);
    var pos = Object.create(null);
    var own = channelKeyOf(cur);
    var ownCap = Math.max(4, Math.ceil(limit / 3));

    if (cur.id) seen[cur.id] = true;

    function takeFrom(name) {
      var list = lists[name] || [];
      for (var i = pos[name] || 0; i < list.length; i++) {
        var v = list[i];
        pos[name] = i + 1;
        if (!v || seen[v.id]) continue;
        var ck = channelKeyOf(v);
        var cap = ck && ck === own ? ownCap : 3;
        if (ck && (perChannel[ck] || 0) >= cap) continue;
        seen[v.id] = true;
        if (ck) perChannel[ck] = (perChannel[ck] || 0) + 1;
        v.via = name;
        out.push(v);
        return true;
      }
      return false;
    }

    for (var round = 0; out.length < limit && round < 200; round++) {
      var any = false;
      for (var p = 0; p < PATTERN.length && out.length < limit; p++) {
        if (takeFrom(PATTERN[p])) any = true;
      }
      if (!any) break;
    }
    return out;
  }

  /* Only the fields the sidebar draws. */
  function card(v) {
    return {
      id: v.id, title: v.title, channel: v.channel, channelId: v.channelId || null,
      thumb: v.thumb, year: v.year || null, exact: v.exact || 0,
      viewCount: v.viewCount == null ? null : v.viewCount, views: v.views || null,
      duration: v.duration || null, via: v.via || null
    };
  }

  async function searchList(q, cfg, tabId) {
    var data = await Innertube.search(q, null, { lenient: true, preferTabId: tabId });
    return Innertube.reap(data, cfg.cutoffYear);
  }

  async function freshBuild(cur, cfg, opts) {
    var queries = plan(cur, cfg);
    var lists = {};
    var errors = [];

    // A channel's search is shared by all of its videos.
    var network = [];
    for (var i = 0; i < queries.length; i++) {
      var q = queries[i];
      if (q.cacheKey) {
        var hit = await Db.getRelated(q.cacheKey);
        if (hit && Date.now() - hit.at < CHANNEL_CACHE_MS) {
          lists[q.name] = await Db.getVideos(hit.ids);
          continue;
        }
      }
      network.push(q);
    }

    var refused = await allowance(network.length);
    if (refused) {
      errors.push(refused);
      network = [];
    }

    await Promise.all(network.map(async function (q) {
      try {
        var found = await searchList(q.q, cfg, opts.tabId);
        lists[q.name] = found;
        if (found.length) await Db.putVideos(found, 'related:' + (cur.id || q.name));
        if (q.cacheKey) {
          await Db.putRelated({ key: q.cacheKey, ids: found.map(function (v) { return v.id; }), at: Date.now() });
        }
      } catch (err) {
        errors.push(String(err && err.message || err));
        if (err && err.rateLimited) {
          try { await Crawler.noteRefusal(err); } catch (e) { /* ignore */ }
        }
      }
    }));

    // The old videos YouTube itself listed beside this one, from this visit
    // and earlier ones.
    if (cur.id) lists.edges = await Db.getVideos(await Db.getEdges(cur.id));

    // Everything goes back through the pool's own records, so a video or
    // channel you hid stays hidden and exact years win over guesses.
    var names = Object.keys(lists);
    for (var n = 0; n < names.length; n++) {
      var ids = (lists[names[n]] || []).map(function (v) { return v.id; });
      lists[names[n]] = (await Db.getVideos(ids)).filter(opts.filter);
    }

    var ordered = interleave(lists, cur, KEEP);
    var counts = {};
    ordered.forEach(function (v) { counts[v.via] = (counts[v.via] || 0) + 1; });

    // Only a list that actually came from searching is worth remembering;
    // a failed round should be retried next time, not cached as empty.
    if (cur.id && network.length && errors.length < network.length && ordered.length) {
      await Db.putRelated({
        key: 'v:' + cur.id,
        ids: ordered.map(function (v) { return v.id; }),
        via: ordered.map(function (v) { return v.via; }),
        at: Date.now(),
        cutoff: cfg.cutoffYear
      });
    }

    return { videos: ordered, sources: counts, errors: errors, searched: network.length };
  }

  async function fromCache(cur, cfg, filter) {
    if (!cur.id) return null;
    var hit = await Db.getRelated('v:' + cur.id);
    if (!hit || hit.cutoff !== cfg.cutoffYear || Date.now() - hit.at > VIDEO_CACHE_MS) return null;
    var byId = Object.create(null);
    (await Db.getVideos(hit.ids)).forEach(function (v) { byId[v.id] = v; });
    var counts = {};
    var videos = [];
    hit.ids.forEach(function (id, i) {
      var v = byId[id];
      if (!v || !filter(v)) return;
      v.via = (hit.via && hit.via[i]) || null;
      counts[v.via] = (counts[v.via] || 0) + 1;
      videos.push(v);
    });
    if (videos.length < Math.min(8, hit.ids.length)) return null;
    return { videos: videos, sources: counts, errors: [], cached: true };
  }

  /* Top up from the pool when searching came back thin — or couldn't run. */
  async function topUp(result, cur, cfg, filter, limit) {
    var need = limit - result.videos.length;
    if (need <= 0) return result;
    var r = await Promise.all([Db.sample(3000, filter), cfg.learnInterests ? Taste.loadTaste() : {}]);
    var have = Object.create(null);
    result.videos.forEach(function (v) { have[v.id] = true; });
    var extra = Rank.rankRelated(r[0], cur, r[1], {
      limit: need,
      excludeIds: Object.keys(have)
    });
    extra.forEach(function (v) { v.via = 'pool'; });
    if (extra.length) result.sources.pool = (result.sources.pool || 0) + extra.length;
    result.videos = result.videos.concat(extra);
    result.eligible = r[0].length;
    return result;
  }

  /* cur:  { id, title, channel, channelId, keywords, category }
   * opts: { filter, exclude, limit, tabId } */
  async function related(cur, cfg, opts) {
    var limit = opts.limit || 24;
    var key = cur.id || cur.title || '?';

    var result = await fromCache(cur, cfg, opts.filter);
    if (!result) {
      if (!inflight[key]) {
        inflight[key] = freshBuild(cur, cfg, opts).finally(function () { delete inflight[key]; });
      }
      var built = await inflight[key];
      result = { videos: built.videos.slice(), sources: Object.assign({}, built.sources),
                 errors: built.errors.slice(), searched: built.searched };
    }

    // YouTube's own sidebar is right above; don't repeat it.
    var exclude = Object.create(null);
    (opts.exclude || []).forEach(function (id) { exclude[id] = true; });
    if (cur.id) exclude[cur.id] = true;
    result.videos = result.videos.filter(function (v) { return !exclude[v.id]; });

    if (result.videos.length < Math.min(limit, 12)) {
      result = await topUp(result, cur, cfg, function (v) { return opts.filter(v) && !exclude[v.id]; }, limit);
    }

    result.videos = result.videos.slice(0, limit).map(card);
    return result;
  }

  var api = {
    related: related,
    plan: plan,
    cleanTitle: cleanTitle,
    topicQuery: topicQuery,
    interleave: interleave
  };

  root.RTRelated = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
