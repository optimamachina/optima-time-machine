/* Time Machine for YouTube — talking to YouTube the way YouTube does.
 *
 * The crawler needs related-video lists and search results without opening
 * tabs. Rather than scraping HTML, we call the same private /youtubei/v1
 * endpoints the site itself uses, reusing the client context the page
 * handed us. The request is always issued from an open YouTube tab (see
 * bridge.js) so it carries the same cookies, origin and auth header as the
 * site's own traffic. A request from the worker itself has none of those
 * and YouTube refuses it with a 403 — so there is no fallback: no usable
 * tab means "not ready", never "rate limited".
 */
(function (root) {
  'use strict';

  var Extract = root.RTExtract;
  var Dates = root.RTDates;

  var creds = null;
  var lastError = null;

  var FALLBACK_VERSION = '2.20260901.00.00';
  var FALLBACK_CONTEXT = {
    client: {
      clientName: 'WEB',
      clientVersion: FALLBACK_VERSION,
      hl: 'en',
      gl: 'US'
    }
  };

  var NOT_READY_MSG =
    'the open YouTube tab is not answering. Tabs opened before the extension ' +
    'was updated go quiet — reload that tab (F5) or open a new youtube.com tab.';
  var NO_TAB_MSG = 'no youtube.com tab is open. Open one and leave it open.';

  function setCredentials(payload) {
    if (!payload || !payload.context || typeof payload.context !== 'object') return;
    // It came through the page; keep it a sane size and shape.
    if (JSON.stringify(payload.context).length > 20000) return;
    if (payload.clientVersion && !/^[\d.]{3,24}$/.test(payload.clientVersion)) return;
    creds = {
      key: payload.key || null,
      context: payload.context,
      clientVersion: payload.clientVersion || FALLBACK_VERSION,
      capturedAt: Date.now()
    };
    chrome.storage.local.set({ innertube: creds });
  }

  async function loadCredentials() {
    if (creds) return creds;
    var res = await chrome.storage.local.get('innertube');
    if (res && res.innertube && res.innertube.context) creds = res.innertube;
    return creds;
  }

  function fail(message, flags) {
    var err = new Error(message);
    Object.assign(err, flags || {});
    lastError = message;
    return err;
  }

  /* Every open YouTube tab that could plausibly answer, best first. A tab
   * that asked for something itself (the sidebar) goes to the front. */
  async function candidateTabs(preferTabId) {
    var tabs;
    try {
      tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    } catch (e) {
      return [];
    }
    return (tabs || [])
      .filter(function (t) { return !t.discarded && t.status !== 'unloaded'; })
      .sort(function (a, b) {
        var sa = (a.id === preferTabId ? 4 : 0) + (a.status === 'complete' ? 2 : 0) + (a.active ? 1 : 0);
        var sb = (b.id === preferTabId ? 4 : 0) + (b.status === 'complete' ? 2 : 0) + (b.active ? 1 : 0);
        return sb - sa;
      });
  }

  /* chrome.tabs.sendMessage has no timeout of its own. */
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no answer from the tab')); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); },
                   function (e) { clearTimeout(timer); reject(e); });
    });
  }

  /* Our own requests always ask for English. The dates in the answer are
   * what the wall reads, and "hace 14 años" isn't something it can read —
   * whatever language you browse YouTube in. */
  /* Only what YouTube needs to answer: which web client this is, in English
   * and for one fixed region. Nothing from your own page's context (visitor
   * id, screen size, time zone, browser details) goes along. */
  function englishContext(context) {
    var version = context && context.client && /^[\d.]{3,24}$/.test(context.client.clientVersion || '')
      ? context.client.clientVersion : FALLBACK_VERSION;
    return { client: { clientName: 'WEB', clientVersion: version, hl: 'en', gl: 'US' } };
  }

  async function callViaTab(name, payload, c, preferTabId) {
    var tabs = await candidateTabs(preferTabId);
    if (!tabs.length) throw fail(NO_TAB_MSG, { notReady: true, transient: true });

    for (var i = 0; i < tabs.length; i++) {
      var res;
      try {
        res = await withTimeout(chrome.tabs.sendMessage(tabs[i].id, {
          type: 'ytFetch',
          endpoint: name,
          clientVersion: c.clientVersion,
          body: payload
        }), 20000);
      } catch (e) {
        // "Receiving end does not exist": an orphaned or still-loading tab.
        continue;
      }
      if (!res) continue;
      if (res.ok) return res.data;

      // The tab answered and YouTube said no. That is a real answer.
      var m = /HTTP (\d+)/.exec(res.error || '');
      var status = m ? parseInt(m[1], 10) : 0;
      if (status === 429 || status === 403) {
        throw fail('YouTube refused the request (HTTP ' + status + ')',
          { rateLimited: true, transient: true, status: status });
      }
      throw fail(name + ' failed: ' + (res.error || 'unknown error'), { transient: true, status: status });
    }

    throw fail(NOT_READY_MSG, { notReady: true, transient: true });
  }

  /* `opts.lenient` lets a request go out before the page has handed over its
   * own context — the sidebar asks as soon as a watch page opens, and the
   * tab's cookies identify the session either way. */
  async function call(name, body, opts) {
    opts = opts || {};
    var c = await loadCredentials();
    if (!c) {
      if (!opts.lenient) throw fail('no innertube credentials yet', { notReady: true, transient: true });
      c = { context: FALLBACK_CONTEXT, clientVersion: FALLBACK_VERSION };
    }
    var payload = Object.assign({ context: englishContext(c.context) }, body);
    var data = await callViaTab(name, payload, c, opts.preferTabId);
    lastError = null;
    return data;
  }

  /* Is there a tab that will answer at all? Cheap: no YouTube request. */
  async function ready() {
    var tabs = await candidateTabs();
    for (var i = 0; i < tabs.length; i++) {
      try {
        var res = await chrome.tabs.sendMessage(tabs[i].id, { type: 'ping' });
        if (res && res.ok) return true;
      } catch (e) { /* next */ }
    }
    return false;
  }

  /* Pull every video-shaped item out of an arbitrary innertube payload and
   * keep only the ones at or before the cutoff. Reuses the same extraction
   * code the interceptor uses, so both sides agree on what a video is. */
  function reap(data, cutoffYear) {
    var found = [];
    var seen = Object.create(null);

    (function walk(node, depth) {
      if (depth > 30 || node === null || typeof node !== 'object') return;

      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }

      var cls = Extract.classify(node);
      if (cls.kind === 'item') {
        var rec = Extract.describe(node);
        if (rec && rec.id && !seen[rec.id] && !rec.shortish && !rec.live && !rec.mix && !rec.ad) {
          var v = Dates.verdict(rec.ago, cutoffYear);
          if (v.state === 'pass') {
            seen[rec.id] = true;
            rec.year = v.info ? new Date(v.info.estimate).getFullYear() : null;
            rec.ts = v.info ? v.info.estimate : null;
            found.push(rec);
          }
        }
        return;
      }

      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        walk(node[k], depth + 1);
      }
    })(data, 0);

    return found;
  }

  function related(videoId) {
    return call('next', { videoId: videoId });
  }

  function search(query, params, opts) {
    var body = { query: query };
    if (params) body.params = params;
    return call('search', body, opts);
  }

  function browse(browseId, params) {
    var body = { browseId: browseId };
    if (params) body.params = params;
    return call('browse', body);
  }

  function playlist(playlistId) {
    var id = playlistId.indexOf('VL') === 0 ? playlistId : 'VL' + playlistId;
    return call('browse', { browseId: id });
  }

  /* Search filter params are base64 protobuf blobs. This one is stable and
   * widely documented: restrict results to playlists. */
  var FILTER_PLAYLISTS = 'EgIQAw%3D%3D';

  function findPlaylistIds(data, limit) {
    var out = [];
    (function walk(node, depth) {
      if (depth > 25 || node === null || typeof node !== 'object' || out.length >= limit) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (typeof node.playlistId === 'string' && node.playlistId.indexOf('PL') === 0) {
        if (out.indexOf(node.playlistId) === -1) out.push(node.playlistId);
      }
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        walk(node[k], depth + 1);
      }
    })(data, 0);
    return out;
  }

  var api = {
    setCredentials: setCredentials,
    loadCredentials: loadCredentials,
    hasCredentials: function () { return !!creds; },
    lastError: function () { return lastError; },
    ready: ready,
    related: related,
    search: search,
    browse: browse,
    playlist: playlist,
    reap: reap,
    findPlaylistIds: findPlaylistIds,
    FILTER_PLAYLISTS: FILTER_PLAYLISTS
  };

  root.RTInnertube = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
