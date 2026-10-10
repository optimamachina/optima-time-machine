/* Time Machine for YouTube — page-context interceptor.
 *
 * Declared in the manifest as a MAIN-world content script at document_start,
 * so it runs in the page's own JavaScript world before a single line of
 * YouTube's code — which is the whole point: it can replace window.fetch and
 * XMLHttpRequest before YouTube's application code ever calls them. Every
 * recommendation, sidebar entry, search result and Short arrives as JSON from
 * /youtubei/v1/*. We edit that JSON in flight, so YouTube renders a page that
 * never contained the blocked videos at all. No flicker, no gaps.
 *
 * As of September 2026 YouTube loads a watch page in one of two ways:
 *
 *   full page load  — the page and its sidebar inlined as ytInitialData and
 *                     ytInitialPlayerResponse
 *   in-page click   — one streamed POST to /youtubei/v1/get_watch, a JSON
 *                     array of [ {playerResponse}, {watchNextResponse} ]
 *
 * The old /next + /player pair is now only used for loading more comments
 * and more sidebar. Watch pages are only ever read, never rewritten — see
 * "watch pages" below for why.
 *
 * It also harvests everything that *passes* into the pool, which is how the
 * recommendation graph gets built for free while you browse.
 */
(function () {
  'use strict';

  if (window.__rtInterceptorLoaded) return;
  window.__rtInterceptorLoaded = true;

  var Dates = self.RTDates;
  var Extract = self.RTExtract;
  if (!Dates || !Extract) {
    console.warn('[TimeMachine] helpers missing, interceptor idle');
    return;
  }

  /* Troubleshooting switches. Set in the page console, then reload:
   *   localStorage.__rt_off = 'getwatch,menus'
   * Parts: guards, fetch, xhr, getwatch, filter (and feed, related in
   * feed.js). Empty or missing means everything is on. */
  var OFF = (function () {
    try { return String(window.localStorage.getItem('__rt_off') || '').split(/[\s,]+/); }
    catch (e) { return []; }
  })();
  function off(part) { return OFF.indexOf(part) !== -1; }

  /* ---------------------------------------------------------------- config */

  var DEFAULTS = {
    enabled: true, cutoffYear: 2009, strict: true, killShorts: true, searchOldOnly: true,
    channelPagesUnfiltered: true, subsUnfiltered: true,
    takeOverHome: true, sidebarRelated: true
  };
  var CFG_KEY = '__rt_cfg';

  // Read synchronously on every call. localStorage is shared between the page
  // and the extension's content script, which sidesteps the async gap that
  // would otherwise let the very first payload through unfiltered.
  function cfg() {
    try {
      var raw = window.localStorage.getItem(CFG_KEY);
      if (!raw) return DEFAULTS;
      var p = JSON.parse(raw);
      return {
        enabled: p.enabled !== false,
        cutoffYear: p.cutoffYear || DEFAULTS.cutoffYear,
        strict: p.strict !== false,
        killShorts: p.killShorts !== false,
        searchOldOnly: p.searchOldOnly !== false,
        channelPagesUnfiltered: p.channelPagesUnfiltered !== false,
        subsUnfiltered: p.subsUnfiltered !== false,
        takeOverHome: p.takeOverHome !== false,
        sidebarRelated: p.sidebarRelated !== false
      };
    } catch (e) {
      return DEFAULTS;
    }
  }

  /* --------------------------------------------------------------- harvest */

  var harvestQueue = [];
  var harvestTimer = null;
  var HARVEST_CAP = 400;

  function harvest(rec, sourceId) {
    // If the worker is asleep the queue can back up. Drop the oldest rather
    // than growing forever; the same videos come round again anyway.
    if (harvestQueue.length >= HARVEST_CAP) harvestQueue.shift();
    harvestQueue.push({ v: rec, from: sourceId || null });
    if (harvestTimer) return;
    harvestTimer = setTimeout(flushHarvest, 1200);
  }

  function flushHarvest() {
    harvestTimer = null;
    if (!harvestQueue.length) return;
    var batch = harvestQueue.splice(0, harvestQueue.length);
    window.postMessage({ __rt: true, type: 'harvest', batch: batch }, location.origin);
  }

  function announce(type, payload) {
    window.postMessage({ __rt: true, type: type, payload: payload }, location.origin);
  }

  /* ------------------------------------------------------------ page mode */

  var CHANNEL_PATH_RE = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/|$)/;

  function zoneFromPath() {
    if (CHANNEL_PATH_RE.test(location.pathname)) return 'channel';
    if (location.pathname.indexOf('/feed/subscriptions') === 0) return 'subs';
    if (location.pathname === '/' || location.pathname === '') return 'home';
    return null;
  }

  function currentVideoId() {
    try {
      var id = new URL(location.href).searchParams.get('v');
      return id && Extract.VIDEO_ID_RE.test(id) ? id : null;
    } catch (e) { return null; }
  }

  /* Which surface a request is for. The address bar lags a click by a
   * request or two — the browse call for a channel goes out while the URL
   * still says /watch — so the request body decides wherever it can: a
   * channel is fetched by its UC… id, the subscriptions feed as
   * FEsubscriptions, the homepage as FEwhat_to_watch. Continuations carry no
   * id, and by the time you scroll the address bar has caught up. */
  function zoneFor(req) {
    var id = req && typeof req.browseId === 'string' ? req.browseId : null;
    if (id) {
      if (id.indexOf('UC') === 0) return 'channel';
      if (id === 'FEsubscriptions') return 'subs';
      if (id === 'FEwhat_to_watch') return 'home';
      return null;
    }
    return zoneFromPath();
  }

  /* -------------------------------------------------------- request bodies
   *
   * YouTube calls fetch(new Request(url, {body})) — the body lives inside
   * the Request, not in init — and it may gzip that body. Read it from
   * wherever it is, inflate it if needed. The Request is cloned
   * synchronously, before the original is handed to the network, so reading
   * never delays or consumes the real request.
   */
  function isGzip(buf) {
    var b = new Uint8Array(buf);
    return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
  }

  function gunzip(buf) {
    return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }

  function gzip(text) {
    return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  }

  /* Resolves to { text, gzip } or null. */
  function requestBody(input, init) {
    if (init && typeof init.body === 'string') return Promise.resolve({ text: init.body, gzip: false });
    // A streamed body can only be read once, and the network needs it.
    if (init && init.body && typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream) {
      return Promise.resolve(null);
    }
    var src = null;
    try {
      if (init && init.body && typeof init.body !== 'string') src = new Response(init.body).arrayBuffer();
      else if (typeof Request !== 'undefined' && input instanceof Request && input.body) src = input.clone().arrayBuffer();
    } catch (e) { src = null; }
    if (!src) return Promise.resolve(null);
    return src.then(function (buf) {
      if (isGzip(buf)) {
        if (typeof DecompressionStream === 'undefined') return null;
        return gunzip(buf).then(function (t) { return { text: t, gzip: true }; });
      }
      return { text: new TextDecoder().decode(buf), gzip: false };
    }).catch(function () { return null; });
  }

  function parseJson(text) {
    if (typeof text !== 'string' || !text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /* ------------------------------------------------------------- searching
   *
   * A search for "tech deck" returns today's tech deck videos, which the
   * wall then removes one page at a time until nothing but channels is
   * left. YouTube's own "before:" operator fixes that at the source, so
   * every search quietly gets "before:<cutoff + 1>" appended — unless you
   * typed a before:/after: yourself.
   */
  var DATE_OP_RE = /\b(before|after):/i;

  function oldQuery(q, conf) {
    q = String(q || '').trim();
    if (!q || DATE_OP_RE.test(q)) return q;
    return q + ' before:' + (conf.cutoffYear + 1);
  }

  /* Soft navigations search through POST /search with the query in the
   * body. Returns the body to send, rewritten or untouched. */
  function rewriteSearchBody(body, conf) {
    if (typeof body !== 'string' || !conf.enabled || !conf.searchOldOnly) return body;
    try {
      var data = JSON.parse(body);
      if (typeof data.query !== 'string' || data.continuation) return body;
      var q = oldQuery(data.query, conf);
      if (q === data.query) return body;
      data.query = q;
      return JSON.stringify(data);
    } catch (e) {
      return body;
    }
  }

  /* A full page load of /results has its query in the URL and its results
   * inlined by the server. Nothing to rewrite in flight, so re-request the
   * page with the operator added — this runs at document_start, before
   * anything has drawn. */
  (function redirectSearch() {
    if (location.pathname !== '/results') return;
    var conf = cfg();
    if (!conf.enabled || !conf.searchOldOnly) return;
    var u = new URL(location.href);
    var q = u.searchParams.get('search_query');
    if (!q) return;
    var old = oldQuery(q, conf);
    if (old === q) return;
    u.searchParams.set('search_query', old);
    location.replace(u.pathname + u.search);
  })();

  /* ---------------------------------------------------------------- filter */

  var stats = { removed: 0, kept: 0, shorts: 0, live: 0, mixes: 0, ads: 0,
                uncertain: 0, undescribable: 0, bailouts: 0, passthrough: 0,
                continuationsCut: 0, emptyShelves: 0, searchesRewritten: 0,
                getWatch: 0, lastMs: 0, maxMs: 0 };

  // Readable from the page console as __rtStats() when something looks wrong.
  window.__rtStats = function () {
    return JSON.parse(JSON.stringify({ stats: stats, config: cfg(), zone: zoneFromPath() }));
  };

  /* One pass over one payload. `mode` is 'filter' on ordinary pages and
   * 'harvest' on channel pages, where the year wall is lifted so you can see
   * whether an old channel has posted since — but ads, Shorts and live
   * streams still go, and anything old still gets collected. */
  function newRun(conf, opts) {
    return {
      conf: conf,
      mode: opts.lifted ? 'harvest' : 'filter',
      sourceId: opts.sourceId || null,
      removed: 0,
      kept: 0,
      keptIds: Object.create(null),
      deadline: Date.now() + TIME_BUDGET_MS,
      overBudget: false
    };
  }

  function shouldDrop(item, cls, run) {
    var conf = run.conf;

    if (cls.kind === 'nuke') {
      if (cls.ad) { stats.ads++; return true; }
      if (cls.shorts) {
        stats.shorts++;
        return !!conf.killShorts;
      }
      return true;
    }

    if (cls.kind !== 'item') return false;

    var rec = Extract.describe(item);

    // An item we can't describe is an item we can't date. Under a hard wall
    // that has to go; under a loose one we let it render.
    if (!rec) {
      stats.undescribable++;
      return run.mode === 'filter' && !!conf.strict;
    }

    if (rec.ad) { stats.ads++; return true; }

    // Live streams and premieres have no upload date at all. They are, by
    // definition, happening now.
    if (rec.live) { stats.live++; return true; }

    // A Mix is a queue built from current recommendations wearing a video's
    // clothes. Never old, never wanted.
    if (rec.mix) { stats.mixes++; return true; }

    // Shorts sometimes arrive dressed as ordinary videos.
    if (conf.killShorts && rec.shortish) { stats.shorts++; return true; }

    if (/radioRenderer/i.test(cls.key || '')) return true;

    var v = Dates.verdict(rec.ago, conf.cutoffYear);
    var ok = v.state === 'pass' || (v.state !== 'block' && !conf.strict);

    if (!ok && run.mode === 'filter') {
      stats.removed++;
      return true;
    }
    if (!ok) stats.passthrough++;
    else stats.kept++;
    run.kept++;
    run.keptIds[rec.id] = true;

    // Rendering can be lenient; the pool must not be. Only a confident pass
    // earns a place in the pool, because pool entries seed the graph walk
    // and compound.
    if (v.state === 'pass' && v.info) {
      rec.year = new Date(v.info.estimate).getFullYear();
      rec.ts = v.info.estimate;
      harvest(rec, run.sourceId);
    } else if (v.state === 'uncertain') {
      stats.uncertain++;
    }

    return false;
  }

  /* A hard ceiling on how long one payload can hold the main thread. A
   * sidebar's worth of cards takes a few milliseconds, so this only trips on
   * something pathological — and then the rest of the payload is left as
   * YouTube sent it rather than freezing the tab. */
  var TIME_BUDGET_MS = 150;

  function walk(node, run, depth) {
    if (depth > 30 || node === null || typeof node !== 'object') return;
    if (run.overBudget) return;
    if (Date.now() > run.deadline) {
      run.overBudget = true;
      stats.bailouts++;
      return;
    }

    if (Array.isArray(node)) {
      for (var i = node.length - 1; i >= 0; i--) {
        var el = node[i];
        var plain = Extract.isPlainObject(el);
        if (plain) {
          var cls = Extract.classify(el);
          if (shouldDrop(el, cls, run)) {
            node.splice(i, 1);
            run.removed++;
            continue;
          }
          // A kept video contains only its own metadata — never another feed
          // item. Descending into it re-scans a subtree for nothing.
          if (cls.kind === 'item') continue;
        }
        walk(el, run, depth + 1);
        // A shelf whose every item was just removed is a heading over
        // nothing — "Shorts", "DIY Science Fun ✨" — so it goes too.
        if (plain && Extract.isEmptyShelf(el)) {
          node.splice(i, 1);
          run.removed++;
          stats.emptyShelves++;
        }
      }
      return;
    }

    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      walk(node[k], run, depth + 1);
    }
  }

  function isContinuation(el) {
    return Extract.isPlainObject(el) && Extract.firstKey(el) === 'continuationItemRenderer';
  }

  function stripContinuations(node, depth) {
    var cut = 0;
    if (depth > 30 || node === null || typeof node !== 'object') return 0;
    if (Array.isArray(node)) {
      for (var i = node.length - 1; i >= 0; i--) {
        if (isContinuation(node[i])) {
          node.splice(i, 1);
          cut++;
        } else {
          cut += stripContinuations(node[i], depth + 1);
        }
      }
      return cut;
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      cut += stripContinuations(node[k], depth + 1);
    }
    return cut;
  }

  /* When a list comes back with every item removed, YouTube sees an empty
   * container and immediately asks for the next page — and the next. Five
   * empty pages in a row on one screen is enough: after that the "load
   * more" token is cut out of the payload so the loop ends. Watch pages are
   * handled separately below, because there a blanket cut would also take
   * the comments' "load more" with it. */
  var EMPTY_PAGES_ALLOWED = 5;
  var emptyStreak = 0;
  var streakKey = null;

  function emptyPagePolicy(data, run) {
    var key = location.pathname + location.search;
    if (key !== streakKey) {
      streakKey = key;
      emptyStreak = 0;
    }
    if (run.kept > 0) {
      emptyStreak = 0;
      return 0;
    }
    if (run.removed === 0) return 0;
    emptyStreak++;
    if (emptyStreak < EMPTY_PAGES_ALLOWED) return 0;
    var cut = stripContinuations(data, 0);
    stats.continuationsCut += cut;
    return cut;
  }

  /* ----------------------------------------------------------- watch pages
   *
   * Watch pages are read, never rewritten. Tested live in Chrome and Brave
   * (September 2026): with an ad blocker also editing YouTube's data — uBlock
   * Origin, uBlock Origin Lite, Brave Shields — a watch page whose sidebar we
   * had edited would lock up within a page or two (a pinned CPU core, a gray
   * or unclickable tab). With either extension alone, or with ours hooked in
   * but changing nothing, it never did. Every version that trimmed the
   * sidebar had it.
   *
   * So YouTube gets its watch data exactly as sent. What the extension needs
   * from it is read off a copy: which of YouTube's own related videos are
   * old enough (feed.js shows those first, in a sidebar of its own, and
   * hides YouTube's list), what autoplay has lined up next, and the player's
   * exact upload date.
   */
  var WATCH_FEED = 'watch-next-feed';

  function endpointVideoId(ep) {
    var w = ep && ep.watchEndpoint;
    return w && typeof w.videoId === 'string' ? w.videoId : null;
  }

  function watchIdOf(wn) {
    return endpointVideoId(wn && wn.currentVideoEndpoint);
  }

  function findWatchFeed(node, depth) {
    if (depth > 12 || node === null || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        var f = findWatchFeed(node[i], depth + 1);
        if (f) return f;
      }
      return null;
    }
    if (node.targetId === WATCH_FEED && Array.isArray(node.contents)) return node.contents;
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var r = findWatchFeed(node[k], depth + 1);
      if (r) return r;
    }
    return null;
  }

  function autoplayTarget(wn) {
    var two = wn.contents && wn.contents.twoColumnWatchNextResults;
    var sets = two && two.autoplay && two.autoplay.autoplay && two.autoplay.autoplay.sets;
    if (Array.isArray(sets)) {
      for (var i = 0; i < sets.length; i++) {
        var id = endpointVideoId(sets[i] && sets[i].autoplayVideo);
        if (id) return id;
      }
    }
    var po = wn.playerOverlays && wn.playerOverlays.playerOverlayRenderer;
    var next = po && po.autoplay && po.autoplay.playerOverlayAutoplayRenderer;
    return next && typeof next.videoId === 'string' ? next.videoId : null;
  }

  /* Reads one watch-next payload (a page, or more sidebar for one) and
   * announces the old videos in YouTube's related list, in YouTube's order,
   * plus where autoplay is headed. Old ones go into the pool, attached to
   * this video. Nothing in `wn` is changed. */
  function observeWatch(wn, videoId) {
    var conf = cfg();
    if (!conf.enabled || !Extract.isPlainObject(wn) || off('filter')) return;
    var t0 = Date.now();
    var two = wn.contents && wn.contents.twoColumnWatchNextResults;
    var lists = [];
    var feed = two && findWatchFeed(two.secondaryResults, 0);
    if (feed) lists.push(feed);
    (wn.onResponseReceivedEndpoints || []).forEach(function (ep) {
      var act = ep && (ep.appendContinuationItemsAction || ep.reloadContinuationItemsCommand);
      if (act && act.targetId === WATCH_FEED && Array.isArray(act.continuationItems)) lists.push(act.continuationItems);
    });
    if (!lists.length) return; // comments, or something else entirely

    var items = [];
    var seen = Object.create(null);
    lists.forEach(function (list) {
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!Extract.isPlainObject(el) || Extract.classify(el).kind !== 'item') continue;
        var rec = Extract.describe(el);
        if (!rec || seen[rec.id]) continue;
        seen[rec.id] = true;
        if (rec.ad || rec.live || rec.mix || (conf.killShorts && rec.shortish)) {
          stats.removed++;
          continue;
        }
        var v = Dates.verdict(rec.ago, conf.cutoffYear);
        if (!(v.state === 'pass' || (v.state !== 'block' && !conf.strict))) {
          stats.removed++;
          continue;
        }
        stats.kept++;
        if (v.state === 'pass' && v.info) {
          rec.year = new Date(v.info.estimate).getFullYear();
          rec.ts = v.info.estimate;
          harvest(rec, videoId);
        }
        items.push(rec);
      }
    });

    var auto = two ? autoplayTarget(wn) : null;
    stats.lastMs = Date.now() - t0;
    if (stats.lastMs > stats.maxMs) stats.maxMs = stats.lastMs;
    if (!videoId) return;
    announce('watchNext', {
      videoId: videoId,
      items: items,
      append: !two,
      autoplay: auto ? { id: auto, old: !!seen[auto] && items.some(function (r) { return r.id === auto; }) } : null
    });
  }

  /* A get_watch body: [ {playerResponse}, {watchNextResponse} ], or an
   * object with those keys. */
  function observeGetWatch(text, req) {
    var data = parseJson(text);
    var parts = Array.isArray(data) ? data : (Extract.isPlainObject(data) ? [data] : []);
    var videoId = req && typeof req.videoId === 'string' ? req.videoId : null;
    parts.forEach(function (p) {
      if (!Extract.isPlainObject(p)) return;
      if (Extract.isPlainObject(p.playerResponse)) {
        readPlayer(p.playerResponse, null);
        var vd = p.playerResponse.videoDetails;
        if (vd && vd.videoId) videoId = videoId || vd.videoId;
      }
    });
    parts.forEach(function (p) {
      if (Extract.isPlainObject(p) && Extract.isPlainObject(p.watchNextResponse)) {
        observeWatch(p.watchNextResponse, watchIdOf(p.watchNextResponse) || videoId || currentVideoId());
      }
    });
  }

  /* Returns the number of changes made, so the caller can skip
   * re-serialising a payload that didn't change.
   *
   *   opts.zone      'channel' | 'subs' | 'home' | null
   *
   * Never used on watch pages; see observeWatch.
   */
  function filterPayload(data, opts) {
    if (off('filter')) return 0;
    var conf = cfg();
    if (!conf.enabled || !data || typeof data !== 'object') return 0;
    opts = opts || {};

    var zone = opts.zone || null;
    var lifted = (zone === 'channel' && conf.channelPagesUnfiltered) ||
                 (zone === 'subs' && conf.subsUnfiltered);
    var run = newRun(conf, { lifted: lifted, sourceId: null });

    var t0 = Date.now();
    try {
      walk(data, run, 0);
    } catch (e) {
      console.warn('[TimeMachine] filter error', e);
    }

    var changed = run.removed;
    try {
      if (zone === 'home' && conf.takeOverHome) {
        // The native home grid is hidden and replaced; there is no reason to
        // let it page in more of today's feed behind the curtain.
        var cut = stripContinuations(data, 0);
        stats.continuationsCut += cut;
        changed += cut;
      } else {
        changed += emptyPagePolicy(data, run);
      }
    } catch (e2) {
      console.warn('[TimeMachine] tidy error', e2);
    }

    stats.lastMs = Date.now() - t0;
    if (stats.lastMs > stats.maxMs) stats.maxMs = stats.lastMs;
    return changed;
  }

  /* ----------------------------------------------- the player's exact date
   *
   * The player response knows the real upload date, the tags and the
   * category. That is what the block screen, the pool's exact years, the
   * interest learning and the related section all run on.
   *
   * Only the video the page is actually showing counts. Hover previews on
   * search results and the miniplayer fetch player responses for other
   * videos, and those must neither be "watched" nor covered up.
   */
  function readPlayer(data, expectedId) {
    try {
      if (!data || typeof data !== 'object') return;
      var mf = data.microformat && data.microformat.playerMicroformatRenderer;
      var vd = data.videoDetails;
      if (!mf && !vd) return;

      var id = (vd && vd.videoId) || (mf && mf.externalVideoId) || null;
      if (!id || !Extract.VIDEO_ID_RE.test(id)) return;
      if (expectedId && id !== expectedId) return;

      var publish = mf && (mf.publishDate || mf.uploadDate);
      var keywords = vd && Array.isArray(vd.keywords) ? vd.keywords.slice(0, 30) : [];

      announce('player', {
        id: id,
        title: (vd && vd.title) || (mf && mf.title && mf.title.simpleText) || '',
        channel: (vd && vd.author) || (mf && mf.ownerChannelName) || '',
        channelId: (vd && vd.channelId) || (mf && mf.externalChannelId) || null,
        exactDate: publish || null,
        viewCount: vd && vd.viewCount ? parseInt(vd.viewCount, 10) : null,
        lengthSeconds: vd && vd.lengthSeconds ? parseInt(vd.lengthSeconds, 10) : null,
        keywords: keywords,
        category: (mf && mf.category) || null,
        live: !!(vd && (vd.isLive || vd.isUpcoming || vd.isLiveContent))
      });
    } catch (e) { /* non-fatal */ }
  }

  function responseHeaders(res) {
    var h = new Headers();
    var ct = null;
    try { ct = res.headers && res.headers.get ? res.headers.get('content-type') : null; }
    catch (e) { ct = null; }
    h.set('Content-Type', ct || 'application/json; charset=utf-8');
    return h;
  }

  /* ------------------------------------------------------------ fetch patch */

  function endpointOf(url) {
    var m = /\/youtubei\/v1\/([A-Za-z_]+(?:\/[A-Za-z_]+)*)/.exec(url || '');
    return m ? m[1] : null;
  }

  // What each endpoint gets. Everything else passes through untouched.
  var HANDLED = { browse: 1, next: 1, search: 1, get_watch: 1, player: 1 };

  /* Rebuilding a response means rebuilding its headers. The original ones
   * describe the original body: a content-length for different bytes, and
   * often a content-encoding for a body the browser has already decoded.
   * Only the content type survives. */
  function rebuild(body, res) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers: responseHeaders(res) });
  }

  var origFetch = window.fetch;

  /* The same request with a different body, compressed the way the
   * original was so its headers stay truthful. Resolves to [input, init]. */
  function withBody(input, init, text, wasGzip) {
    var canZip = typeof CompressionStream !== 'undefined';
    var bodyP = wasGzip && canZip ? gzip(text) : Promise.resolve(text);
    return bodyP.then(function (body) {
      var headers = null;
      if (wasGzip && !canZip) {
        headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
        headers.delete('content-encoding');
      }
      if (!(input instanceof Request)) {
        var ni = Object.assign({}, init, { body: body });
        if (headers) ni.headers = headers;
        return [input, ni];
      }
      var opts = { body: body };
      if (headers) opts.headers = headers;
      return [new Request(input, opts), undefined];
    });
  }

  var patchedFetch = function (input, init) {
    var self = this;
    var args = arguments;
    var url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
    } catch (e) { url = ''; }

    var ep = endpointOf(url);
    if (!ep || !HANDLED[ep] || (ep === 'get_watch' && off('getwatch'))) return origFetch.apply(self, args);

    var conf = cfg();
    if (!conf.enabled) return origFetch.apply(self, args);

    // Searches have to be rewritten before they are sent.
    if (ep === 'search' && conf.searchOldOnly) {
      return requestBody(input, init).then(function (b) {
        if (!b) return { p: origFetch.call(self, input, init), req: null };
        var rewritten = rewriteSearchBody(b.text, conf);
        if (rewritten === b.text) return { p: origFetch.call(self, input, init), req: parseJson(b.text) };
        stats.searchesRewritten++;
        return withBody(input, init, rewritten, b.gzip).then(function (pair) {
          return { p: origFetch.call(self, pair[0], pair[1]), req: parseJson(rewritten) };
        });
      }).catch(function () {
        return { p: origFetch.call(self, input, init), req: null };
      }).then(function (s) {
        return s.p.then(function (res) { return handleResponse(res, ep, s.req); });
      });
    }

    // Everything else goes out at once. The body is copied first, and read
    // while the request is in flight.
    var bodyP = requestBody(input, init);
    var resP = origFetch.apply(self, args);
    return resP.then(function (res) {
      return bodyP.then(function (b) {
        return handleResponse(res, ep, b ? parseJson(b.text) : null);
      });
    });
  };

  if (!off('fetch')) window.fetch = patchedFetch;

  function handleResponse(res, ep, req) {
    if (!res || !res.ok) return res;

    // Disabled means disabled: not "parse it anyway and change nothing".
    var conf = cfg();
    if (!conf.enabled) return res;

    if (ep === 'player') {
      // Read-only: we want the exact publish date, but never rewrite the
      // player response.
      try {
        res.clone().json().then(function (data) { readPlayer(data, currentVideoId()); }).catch(function () {});
      } catch (e) { /* ignore */ }
      return res;
    }

    if (ep === 'get_watch' || ep === 'next') {
      // Watch pages are read-only (see observeWatch): YouTube gets the
      // response it was sent, and a copy is read alongside.
      stats.getWatch += ep === 'get_watch' ? 1 : 0;
      try {
        res.clone().text().then(function (text) {
          if (ep === 'get_watch') { observeGetWatch(text, req); return; }
          var data = parseJson(text);
          if (data) {
            var vid = (req && typeof req.videoId === 'string' && !req.continuation)
              ? req.videoId : (watchIdOf(data) || currentVideoId());
            observeWatch(data, vid);
          }
        }).catch(function () {});
      } catch (e) { /* ignore */ }
      return res;
    }

    // Consume the original body rather than cloning it. A clone whose other
    // branch is never read stays buffered for the life of the page.
    return res.text().then(function (text) {
      var data = parseJson(text);
      if (!data) return rebuild(text, res);
      var changed = filterPayload(data, { zone: zoneFor(req) });
      return rebuild(changed > 0 ? JSON.stringify(data) : text, res);
    }, function () {
      return res;
    });
  }

  /* ------------------------------------------------------------- XHR patch
   *
   * XHR bodies arrive progressively, and responseText can be read many times
   * while the transfer is still in flight. Caching the first read caches a
   * half-delivered body. So: pass through untouched until the transfer is
   * genuinely complete.
   */

  var XHR = window.XMLHttpRequest;
  var origOpen = XHR.prototype.open;
  var origSend = XHR.prototype.send;

  var patchedOpen = function (method, url) {
    this.__rtUrl = url;
    return origOpen.apply(this, arguments);
  };

  var patchedSend = function (body) {
    var xhr = this;
    var ep = endpointOf(String(xhr.__rtUrl || ''));

    if (ep === 'search' && typeof body === 'string') {
      var rewritten = rewriteSearchBody(body, cfg());
      if (rewritten !== body) {
        body = rewritten;
        arguments[0] = body;
      }
    }

    if (!ep || !HANDLED[ep] || ep === 'player' || (ep === 'get_watch' && off('getwatch')) || !cfg().enabled) {
      return origSend.apply(this, arguments);
    }

    var descText = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
    var descResp = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');
    if (!descText || !descText.get) return origSend.apply(this, arguments);

    var req = typeof body === 'string' ? parseJson(body) : null;
    var cached = null;

    function compute() {
      var raw;
      try { raw = descText.get.call(xhr); } catch (e) { return null; }

      // Still arriving: never look at it, never remember it.
      if (xhr.readyState !== 4) return raw;
      if (cached !== null) return cached;
      if (!raw) return raw;

      try {
        if (ep === 'get_watch') {
          observeGetWatch(raw, req);
          cached = raw;
        } else if (ep === 'next') {
          var wn = JSON.parse(raw);
          observeWatch(wn, (req && req.videoId && !req.continuation) ? req.videoId : (watchIdOf(wn) || currentVideoId()));
          cached = raw;
        } else {
          var data = JSON.parse(raw);
          cached = filterPayload(data, { zone: zoneFor(req) }) > 0 ? JSON.stringify(data) : raw;
        }
      } catch (e) {
        cached = raw;
      }
      return cached;
    }

    try {
      Object.defineProperty(xhr, 'responseText', { get: compute, configurable: true });
      Object.defineProperty(xhr, 'response', {
        get: function () {
          var type = xhr.responseType;
          if (type === '' || type === 'text') return compute();
          if (type === 'json') {
            if (xhr.readyState !== 4) return descResp.get.call(xhr);
            var t = compute();
            try { return t ? JSON.parse(t) : descResp.get.call(xhr); }
            catch (e) { return descResp.get.call(xhr); }
          }
          // arraybuffer, blob, document: leave entirely alone.
          return descResp.get.call(xhr);
        },
        configurable: true
      });
    } catch (e) { /* some builds lock these down; fall through */ }

    return origSend.apply(this, arguments);
  };

  if (!off('xhr')) {
    XHR.prototype.open = patchedOpen;
    XHR.prototype.send = patchedSend;
  }

  /* ------------------------------------------- initial page data interception
   *
   * The first page load isn't a fetch at all — YouTube inlines the whole page
   * into the HTML as `ytInitialData`. A property setter filters it the moment
   * their inline script assigns it, before any renderer can read it.
   */
  /* Ad blockers hook these same two globals — uBlock Origin strips the ads
   * out of ytInitialPlayerResponse this way — and content scripts from
   * different extensions run in no particular order. Replacing a hook that
   * is already there silently switches the other one off (that is why ads
   * came back with this extension installed). So whatever was there first
   * stays in the chain: our handler sees the value, then theirs does. If
   * theirs arrives after ours, it chains ours the same way. */
  function guardGlobal(name, handler) {
    var prior = Object.getOwnPropertyDescriptor(window, name);
    if (prior && prior.configurable === false) return;
    var store = prior && 'value' in prior ? prior.value : undefined;
    var priorGet = prior && typeof prior.get === 'function' ? prior.get : null;
    var priorSet = prior && typeof prior.set === 'function' ? prior.set : null;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () {
          return priorGet ? priorGet.call(window) : store;
        },
        set: function (val) {
          var out = val;
          try { out = handler(val); } catch (e) { out = val; }
          if (priorSet) priorSet.call(window, out);
          else store = out;
        }
      });
    } catch (e) { /* locked by someone else; leave it to them */ }
  }

  if (!off('guards')) guardGlobal('ytInitialData', function (val) {
    if (val && typeof val === 'object') {
      if (val.contents && val.contents.twoColumnWatchNextResults) {
        observeWatch(val, watchIdOf(val) || currentVideoId()); // read-only
      } else {
        filterPayload(val, { zone: zoneFromPath() }); // mutates in place
      }
    }
    return val;
  });

  if (!off('guards')) guardGlobal('ytInitialPlayerResponse', function (val) {
    readPlayer(val, currentVideoId());
    return val;
  });

  /* ------------------------------------------------------------ navigation
   *
   * The extension's own cards live in the content script's world, where
   * YouTube's router can't be reached. They post a message here instead, and
   * this asks the router for an in-page navigation — the same event
   * YouTube's own links fire — so opening an old video from the feed or the
   * sidebar is as quick as clicking one of YouTube's. If the router doesn't
   * take it, a plain page load does.
   */
  function navigateTo(videoId) {
    var url = '/watch?v=' + videoId;
    var from = location.href;
    var app = document.querySelector('ytd-app');
    if (!app) { location.href = url; return; }
    try {
      app.dispatchEvent(new CustomEvent('yt-navigate', {
        bubbles: true,
        composed: true,
        detail: {
          endpoint: {
            commandMetadata: { webCommandMetadata: { url: url, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } },
            watchEndpoint: { videoId: videoId }
          }
        }
      }));
    } catch (e) {
      location.href = url;
      return;
    }
    // Only if the page never moved at all. By now you may well have clicked
    // on to something else, and that must not be undone.
    setTimeout(function () {
      if (location.href === from) location.href = url;
    }, 6000);
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__rt !== true || d.type !== 'navigate') return;
    if (typeof d.videoId !== 'string' || !Extract.VIDEO_ID_RE.test(d.videoId)) return;
    navigateTo(d.videoId);
  });

  /* ------------------------------------------------- innertube credentials
   *
   * The background crawler needs the same client context the page uses,
   * otherwise its requests look nothing like a browser's. Grab it once the
   * page config exists and hand it over.
   */
  function grabConfig(attempt) {
    try {
      var y = window.ytcfg;
      if (y && typeof y.get === 'function') {
        var ctx = y.get('INNERTUBE_CONTEXT');
        var ver = y.get('INNERTUBE_CLIENT_VERSION');
        var key = y.get('INNERTUBE_API_KEY');
        var visitor = y.get('VISITOR_DATA');
        if (ctx) {
          // A signed-out session is identified by its visitor id. The page
          // sends it on every request; without it YouTube may refuse ours.
          if (visitor && ctx.client && !ctx.client.visitorData) {
            ctx = JSON.parse(JSON.stringify(ctx));
            ctx.client.visitorData = visitor;
          }
          announce('innertube', { key: key || null, context: ctx, clientVersion: ver });
          return;
        }
      }
    } catch (e) { /* not ready */ }
    if ((attempt || 0) < 40) {
      setTimeout(function () { grabConfig((attempt || 0) + 1); }, 250);
    }
  }
  grabConfig(0);

  window.addEventListener('pagehide', flushHarvest);
  setInterval(flushHarvest, 4000);
})();
