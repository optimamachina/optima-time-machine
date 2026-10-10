/* Time Machine for YouTube — bridge.
 *
 * Runs in the extension's isolated world at document_start. Three jobs:
 *   1. Mirror settings into localStorage so the MAIN-world interceptor can
 *      read them synchronously — an async storage read would lose the race
 *      against YouTube's inlined first payload.
 *   2. Relay harvested videos and captured credentials to the service
 *      worker, which owns the pool.
 *   3. Lend this tab to the service worker for API calls.
 */
(function () {
  'use strict';

  var CFG_KEY = '__rt_cfg';

  /* ---------------------------------------------------------------- config */

  function mirrorConfig(settings) {
    if (!settings) return;
    try {
      window.localStorage.setItem(CFG_KEY, JSON.stringify({
        enabled: settings.enabled,
        cutoffYear: settings.cutoffYear,
        strict: settings.strict,
        killShorts: settings.killShorts,
        searchOldOnly: settings.searchOldOnly,
        channelPagesUnfiltered: settings.channelPagesUnfiltered,
        subsUnfiltered: settings.subsUnfiltered,
        takeOverHome: settings.takeOverHome !== false,
        sidebarRelated: settings.sidebarRelated !== false
      }));
    } catch (e) { /* storage disabled */ }
    document.documentElement.setAttribute('data-rt-enabled', settings.enabled ? '1' : '0');
    document.documentElement.setAttribute('data-rt-cutoff', String(settings.cutoffYear));
  }

  chrome.storage.local.get('settings').then(function (res) {
    if (res && res.settings) mirrorConfig(res.settings);
  });

  /* When the extension is updated, the worker re-injects this file into
   * tabs that are already open so collecting keeps working. The page's own
   * surfaces can't be swapped that way, so say so. */
  if (document.documentElement.getAttribute('data-rt-bridge')) {
    var note = document.createElement('div');
    note.id = 'rt-updated';
    note.textContent = 'optima time machine was updated. reload this page to get the new version.';
    note.style.cssText = 'position:fixed;left:50%;bottom:24px;translate:-50% 0;z-index:9999;' +
      'background:#222;color:#fff;font:bold 12px Arial,Helvetica,sans-serif;padding:8px 14px;' +
      'border-radius:3px;cursor:pointer';
    note.title = 'click to reload';
    note.addEventListener('click', function () { location.reload(); });
    (document.body || document.documentElement).appendChild(note);
  }
  document.documentElement.setAttribute('data-rt-bridge', chrome.runtime.getManifest().version);

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.settings) {
      mirrorConfig(changes.settings.newValue);
      window.dispatchEvent(new CustomEvent('rt-settings-changed'));
    }
  });

  /* ----------------------------------------------------------------- relay */

  async function send(msg) {
    try {
      await chrome.runtime.sendMessage(msg);
    } catch (e) {
      // "receiving end does not exist" during worker restarts, or the
      // context was invalidated by an extension reload. Nothing to do.
    }
  }

  /* What the page has said about the videos it showed, kept for feed.js,
   * which shares this world: each video's player details (title, channel,
   * tags, exact date) and which cards YouTube's own sidebar kept for it. */
  var players = window.__rtPlayers = window.__rtPlayers || {};
  var native = window.__rtNative = window.__rtNative || {};
  var autoplay = window.__rtAutoplay = window.__rtAutoplay || {};
  var lastSent = { id: null, at: 0 };

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__rt !== true) return;

    if (d.type === 'harvest' && Array.isArray(d.batch) && d.batch.length) {
      send({ type: 'harvest', batch: d.batch, origin: location.href });
    } else if (d.type === 'innertube') {
      send({ type: 'innertube', payload: d.payload });
    } else if (d.type === 'player' && d.payload && d.payload.id) {
      var p = d.payload;
      // The player can answer twice for one video (after an ad, on a quality
      // change). One watch is one watch.
      if (lastSent.id !== p.id || Date.now() - lastSent.at > 30 * 60000) {
        lastSent = { id: p.id, at: Date.now() };
        send({ type: 'player', payload: p });
      }
      players[p.id] = p;
      window.__rtCurrentPlayer = p;
      window.dispatchEvent(new CustomEvent('rt-player-info', { detail: p }));
    } else if (d.type === 'watchNext' && d.payload && d.payload.videoId) {
      // The old videos in YouTube's own related list for this video, in
      // YouTube's order, and where its autoplay is headed.
      var w = d.payload;
      var items = Array.isArray(w.items) ? w.items : [];
      var list = w.append ? (native[w.videoId] || []).slice() : [];
      items.forEach(function (r) {
        if (r && r.id && !list.some(function (x) { return x.id === r.id; })) list.push(r);
      });
      native[w.videoId] = list;
      if (!w.append) autoplay[w.videoId] = w.autoplay || null;
      window.dispatchEvent(new CustomEvent('rt-native', { detail: { videoId: w.videoId } }));
    }
  });

  /* ------------------------------------------------------------- tab fetch
   *
   * A fetch made from the worker carries none of the page's cookies, origin
   * or referer. The same request issued from here is same-origin and, with
   * the SAPISIDHASH header a signed-in page attaches, indistinguishable from
   * the site's own traffic. This runs in the isolated world, so the page's
   * interceptor never sees it and the worker gets unfiltered results.
   */
  async function authHeader() {
    var m = document.cookie.match(/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/);
    if (!m) return null;
    try {
      var ts = Math.floor(Date.now() / 1000);
      var bytes = new TextEncoder().encode(ts + ' ' + m[1] + ' https://www.youtube.com');
      var digest = await crypto.subtle.digest('SHA-1', bytes);
      var hex = Array.prototype.map.call(new Uint8Array(digest), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
      return 'SAPISIDHASH ' + ts + '_' + hex;
    } catch (e) {
      return null;
    }
  }

  /* Two kinds of request go out from here:
   *
   *   anonymous  — everything the extension asks for on its own (the
   *                sidebar's searches, background collecting). No cookies,
   *                no sign-in header, no visitor id: YouTube sees a logged-out
   *                visitor, so none of it lands in your history or shapes your
   *                recommendations.
   *   signed in  — only what you click yourself: saving a video to Watch
   *                later or a playlist, which can only be done as you.
   */
  async function ytFetch(msg, signedIn) {
    var headers = {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': /^[\d.]{3,24}$/.test(msg.clientVersion || '') ? msg.clientVersion : '2.20260901.00.00'
    };
    if (signedIn) {
      headers['X-Origin'] = 'https://www.youtube.com';
      var visitor = msg.body && msg.body.context && msg.body.context.client &&
        msg.body.context.client.visitorData;
      if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
      var auth = await authHeader();
      if (auth) {
        headers.Authorization = auth;
        headers['X-Goog-AuthUser'] = '0';
      }
    }

    // A request that never answers would hold the worker's reply open
    // forever; give up after a while and let it try elsewhere.
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 15000);
    try {
      var res = await fetch('/youtubei/v1/' + msg.endpoint + '?prettyPrint=false', {
        method: 'POST',
        credentials: signedIn ? 'include' : 'omit',
        headers: headers,
        body: JSON.stringify(msg.body || {}),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('timed out');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return false;
    if (msg.type === 'ping') {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;
    }
    if (msg.type !== 'ytFetch') return false;
    // Only endpoints the extension actually uses, and never as you.
    if (!/^(search|next|browse)$/.test(String(msg.endpoint || ''))) {
      sendResponse({ ok: false, error: 'endpoint not allowed' });
      return false;
    }
    ytFetch(msg, false)
      .then(function (data) { sendResponse({ ok: true, data: data }); })
      .catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
    return true; // keep the channel open for the async reply
  });

  /* Let the feed layer ask the worker for videos without knowing about
   * messaging plumbing. */
  window.__rtRequest = async function (type, payload) {
    try {
      return await chrome.runtime.sendMessage(Object.assign({ type: type }, payload || {}));
    } catch (e) {
      return null;
    }
  };

  /* And let it talk to YouTube as the signed-in user — for saving a card to
   * a playlist straight from the feed. Same request the site's own menu
   * makes. Throws when nothing is captured yet or YouTube says no. */
  window.__rtYt = async function (endpoint, body) {
    var res = await chrome.storage.local.get('innertube');
    var creds = res && res.innertube;
    if (!creds || !creds.context) throw new Error('not ready yet — reload the page once');
    if (!/^(browse\/edit_playlist|playlist\/get_add_to_playlist)$/.test(String(endpoint))) {
      throw new Error('not allowed');
    }
    return ytFetch({
      endpoint: endpoint,
      clientVersion: creds.clientVersion,
      body: Object.assign({ context: creds.context }, body || {})
    }, true);
  };
})();
