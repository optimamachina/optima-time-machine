/* Time Machine for YouTube — the visible half.
 *
 * Filtering alone leaves you with an empty homepage, which is useless. So we
 * don't filter the home feed at all — we replace it. YouTube's grid gets
 * hidden and we draw our own from the pool the interceptor has been building.
 *
 * The watch-page sidebar is replaced too. YouTube's own related list for an
 * old video is mostly today's uploads, and editing YouTube's watch data to
 * thin it out made pages lock up whenever an ad blocker was editing the same
 * data (see interceptor.js). So YouTube's list is left as sent and hidden,
 * and ours is drawn in its place: first the old videos YouTube itself
 * recommended, then old videos found by searching the old years for what
 * this video is about — its title, its tags, its channel (see
 * src/background/related.js).
 *
 * YouTube rebuilds parts of its page whenever it likes, and navigates
 * without reloading, so nothing here renders once and hopes: a watchdog
 * checks every second that our surfaces belong to the page on screen and
 * repairs whichever doesn't. The look is 2008.
 */
(function () {
  'use strict';

  // Troubleshooting switches, shared with the interceptor through the
  // page's localStorage: 'feed' leaves this script out entirely, 'related'
  // only the sidebar section.
  var OFF = (function () {
    try { return String(window.localStorage.getItem('__rt_off') || '').split(/[\s,]+/); }
    catch (e) { return []; }
  })();
  if (OFF.indexOf('feed') !== -1) return;
  var relatedOff = OFF.indexOf('related') !== -1;

  var settings = null;
  var shownIds = [];
  var loading = false;
  var lastKey = null;
  var homeObserver = null;
  var EAGER_IMAGES = 8;

  var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  var CHANNEL_PATH_RE = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/|$)/;

  /* ------------------------------------------------------------- settings */

  async function loadSettings() {
    var res = await chrome.storage.local.get('settings');
    settings = res && res.settings ? res.settings : null;
    return settings;
  }

  /* The worker rewrites settings every half hour to store learned seeds.
   * Only a change that alters what's on screen is worth a re-render. */
  var VISIBLE_KEYS = ['enabled', 'cutoffYear', 'takeOverHome', 'sidebarRelated',
    'showYearBadge', 'killShorts', 'searchOldOnly', 'channelPagesUnfiltered', 'subsUnfiltered',
    'autoplayFromPool', 'blockWatchPage', 'allowEscapeHatch',
    'hiddenChannels'];

  function same(a, b) {
    return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.settings) return;
    var before = settings || {};
    settings = changes.settings.newValue;
    var changed = VISIBLE_KEYS.some(function (k) {
      return !same(before[k], (settings || {})[k]);
    });
    if (!changed) return;
    related = { videoId: null, res: null, pending: null };
    var side = document.getElementById('rt-related');
    if (side) side.remove();
    reset();
    route();
  });

  /* -------------------------------------------------------------- helpers */

  function alive() {
    // After the extension is reloaded, this copy of the script is orphaned:
    // chrome.runtime.id disappears and every chrome.* call throws.
    try { return !!chrome.runtime.id; } catch (e) { return false; }
  }

  function req(type, payload) {
    if (typeof window.__rtRequest !== 'function') return Promise.resolve(null);
    return window.__rtRequest(type, payload);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /* Polls rather than observing every DOM mutation: a watch page makes
   * thousands of those while it loads, and this only needs to notice one
   * element turning up. Resolves null if the page moved on first. */
  function waitFor(find, timeout) {
    var key = navKey();
    var started = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        if (navKey() !== key) return resolve(null);
        var found = find();
        if (found) return resolve(found);
        if (Date.now() - started > (timeout || 10000)) return resolve(null);
        setTimeout(poll, 150);
      })();
    });
  }

  function pageType() {
    var p = location.pathname;
    if (p === '/' || p === '') return 'home';
    if (p === '/watch') return 'watch';
    if (p.indexOf('/feed/subscriptions') === 0) return 'subs';
    if (p.indexOf('/shorts/') === 0) return 'shorts';
    if (CHANNEL_PATH_RE.test(p)) return 'channel';
    return 'other';
  }

  function currentVideoId() {
    try {
      var id = new URL(location.href).searchParams.get('v');
      return id && VIDEO_ID_RE.test(id) ? id : null;
    } catch (e) { return null; }
  }

  /* What counts as "a different page". A watch page is its video: YouTube
   * adds and drops other parameters (&t=, &pp=) on the same video. */
  function navKey() {
    if (location.pathname === '/watch') return '/watch?v=' + currentVideoId();
    return location.pathname + location.search;
  }

  function viewsText(video) {
    if (video.viewCount !== null && video.viewCount !== undefined) {
      return video.viewCount.toLocaleString();
    }
    if (video.views) return String(video.views).replace(/\s*views?$/i, '');
    return null;
  }

  function thumbImage(video, index, small) {
    var img = document.createElement('img');
    // Only YouTube's own image servers: a record that came through the page
    // never gets to point an image at anywhere else.
    var ownThumb = /^https:\/\/(i\d?\.ytimg\.com|yt3\.ggpht\.com)\//.test(video.thumb || '');
    img.src = ownThumb ? video.thumb : ('https://i.ytimg.com/vi/' + video.id + (small ? '/mqdefault.jpg' : '/hqdefault.jpg'));
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.width = small ? 120 : 480;
    img.height = small ? 90 : 360;
    img.decoding = 'async';
    if (index >= EAGER_IMAGES) img.loading = 'lazy';
    img.onerror = function () {
      img.onerror = null;
      img.src = 'https://i.ytimg.com/vi/' + video.id + '/mqdefault.jpg';
    };
    return img;
  }

  function metaLine(label, value, cls) {
    var line = el('div', 'rt-line ' + (cls || ''));
    line.appendChild(el('span', 'rt-line-label', label + ' '));
    line.appendChild(el('span', 'rt-line-value', value));
    return line;
  }

  /* Why a list came back empty, in the user's terms. */
  function emptyReason(res) {
    var pool = res.poolSize || 0;
    var eligible = res.eligible || 0;
    if (!pool) return 'nothing in the pool yet. watch a couple of old videos, or run a round of searches in settings.';
    if (!eligible) {
      return pool.toLocaleString() + ' videos in the pool, but none are within the cutoff. ' +
        'try "clean out bad entries" in settings.';
    }
    return 'only ' + eligible + ' videos match right now, and you have seen them. Give collecting some time.';
  }

  /* ------------------------------------------------------------ navigation
   *
   * A plain click opens the video in-page, through YouTube's own router
   * (the interceptor, which lives in the page's world, does the asking). A
   * middle-click, a modified click or "open in new tab" still gets the
   * ordinary link.
   */
  function navigate(videoId) {
    var from = location.href;
    window.postMessage({ __rt: true, type: 'navigate', videoId: videoId }, location.origin);
    // If nothing in the page took the message, go the long way round — but
    // only if the page never moved, so a quick next click isn't undone.
    setTimeout(function () {
      if (location.href === from) location.href = '/watch?v=' + videoId;
    }, 6500);
  }

  function linkTo(a, video) {
    a.href = '/watch?v=' + video.id;
    a.addEventListener('click', function (ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      closeMenu();
      navigate(video.id);
    });
  }

  /* ---------------------------------------------------------------- toast */

  var toastTimer = null;
  function toast(text, isError) {
    var node = document.getElementById('rt-toast');
    if (!node) {
      node = el('div', 'rt-host rt-toast');
      node.id = 'rt-toast';
      node.setAttribute('role', 'status');
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.classList.toggle('rt-toast-error', !!isError);
    node.classList.add('rt-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('rt-show'); }, 2600);
  }

  /* ------------------------------------------------------------ card menu
   *
   * One shared menu, moved next to whichever "…" was clicked. Saving goes
   * through the same private endpoints YouTube's own menu uses, issued from
   * this tab as the signed-in user.
   */
  var menu = null;
  var menuVideo = null;

  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
    menuVideo = null;
  }

  document.addEventListener('click', function (ev) {
    if (menu && !menu.contains(ev.target)) closeMenu();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeMenu();
  });

  function menuItem(label, onPick) {
    var b = el('button', 'rt-menu-item', label);
    b.type = 'button';
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      onPick(b);
    });
    return b;
  }

  async function saveTo(playlistId, playlistTitle, video) {
    try {
      var res = await window.__rtYt('browse/edit_playlist', {
        playlistId: playlistId,
        actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: video.id }]
      });
      if (res && /SUCCEEDED/.test(res.status || '')) {
        toast('saved to ' + playlistTitle);
      } else {
        toast('youtube didn\'t save it. are you signed in?', true);
      }
    } catch (e) {
      toast('couldn\'t save (' + String(e && e.message || e) + ')', true);
    }
    closeMenu();
  }

  async function showPlaylists(video, host) {
    host.replaceChildren(el('div', 'rt-menu-note', 'loading your playlists…'));
    var lists = [];
    try {
      var res = await window.__rtYt('playlist/get_add_to_playlist', { videoIds: [video.id] });
      var contents = (res && res.contents) || [];
      contents.forEach(function (c) {
        var r = c && c.addToPlaylistRenderer;
        (r && r.playlists || []).forEach(function (p) {
          var o = p && p.playlistAddToOptionRenderer;
          if (!o || !o.playlistId) return;
          var title = (o.title && (o.title.simpleText || (o.title.runs && o.title.runs[0] && o.title.runs[0].text))) || o.playlistId;
          lists.push({ id: o.playlistId, title: title, has: o.containsSelectedVideos === 'ALL' });
        });
      });
    } catch (e) {
      host.replaceChildren(el('div', 'rt-menu-note', 'couldn\'t load your playlists. are you signed in?'));
      return;
    }
    if (!lists.length) {
      host.replaceChildren(el('div', 'rt-menu-note', 'no playlists found.'));
      return;
    }
    host.replaceChildren();
    lists.forEach(function (p) {
      host.appendChild(menuItem((p.has ? '✓ ' : '') + p.title, function () {
        saveTo(p.id, p.title, video);
      }));
    });
  }

  function removeCardsOfChannel(video) {
    document.querySelectorAll('.rt-card, .rt-row').forEach(function (n) {
      var v = n.__rtVideo;
      if (!v) return;
      if ((video.channelId && v.channelId === video.channelId) ||
          (video.channel && v.channel === video.channel)) n.remove();
    });
  }

  function openMenu(button, video, card) {
    if (menu && menuVideo === video) { closeMenu(); return; }
    closeMenu();
    menuVideo = video;

    menu = el('div', 'rt-host rt-menu');
    menu.setAttribute('role', 'menu');

    menu.appendChild(menuItem('save to watch later', function () {
      saveTo('WL', 'watch later', video);
    }));
    menu.appendChild(menuItem('save to playlist…', function (b) {
      var host = el('div', 'rt-menu-sub');
      b.replaceWith(host);
      showPlaylists(video, host);
    }));
    if (video.channelId) {
      menu.appendChild(menuItem('go to channel', function () {
        location.href = '/channel/' + video.channelId;
      }));
    }
    menu.appendChild(menuItem('hide this video', function () {
      req('hideVideo', { id: video.id });
      card.remove();
      toast('hidden. it won\'t come back.');
      closeMenu();
    }));
    if (video.channel || video.channelId) {
      menu.appendChild(menuItem('hide everything from ' + (video.channel || 'this channel'), function () {
        req('hideChannel', { channelId: video.channelId || null, channel: video.channel || null });
        removeCardsOfChannel(video);
        toast('hidden ' + (video.channel || 'that channel') + '. undo it in settings, under the wall.');
        closeMenu();
      }));
    }

    var rect = button.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 260)) + 'px';
    menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    document.body.appendChild(menu);
  }

  function menuButton(video, card) {
    var b = el('button', 'rt-more', '⋯');
    b.type = 'button';
    b.title = 'save or hide';
    b.setAttribute('aria-label', 'more options');
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openMenu(b, video, card);
    });
    return b;
  }

  /* ----------------------------------------------------------- card build */

  function buildCard(video, index) {
    var card = el('div', 'rt-card');
    card.__rtVideo = video;
    var a = el('a', 'rt-card-link');
    linkTo(a, video);

    var thumbWrap = el('div', 'rt-thumb');
    thumbWrap.appendChild(thumbImage(video, index, false));
    if (video.duration) thumbWrap.appendChild(el('span', 'rt-duration', video.duration));
    if (settings && settings.showYearBadge && video.year) {
      var badge = el('span', 'rt-year', String(video.year));
      if (video.exact) badge.classList.add('rt-exact');
      thumbWrap.appendChild(badge);
    }
    a.appendChild(thumbWrap);

    var meta = el('div', 'rt-meta');
    meta.appendChild(el('div', 'rt-title', video.title));
    if (video.channel) meta.appendChild(metaLine('from', video.channel, 'rt-from'));
    var views = viewsText(video);
    if (views) meta.appendChild(metaLine('views', views));
    if (video.year) meta.appendChild(metaLine('added', String(video.year)));
    a.appendChild(meta);

    card.appendChild(a);
    card.appendChild(menuButton(video, card));
    return card;
  }

  function buildRow(video, index) {
    var row = el('div', 'rt-row');
    row.__rtVideo = video;
    var a = el('a', 'rt-row-link');
    linkTo(a, video);

    var thumbWrap = el('div', 'rt-thumb rt-thumb-small');
    thumbWrap.appendChild(thumbImage(video, index, true));
    if (video.duration) thumbWrap.appendChild(el('span', 'rt-duration', video.duration));
    a.appendChild(thumbWrap);

    var meta = el('div', 'rt-meta');
    meta.appendChild(el('div', 'rt-title', video.title));
    if (video.channel) meta.appendChild(metaLine('from', video.channel, 'rt-from'));
    var bits = [];
    var views = viewsText(video);
    if (views) bits.push('views ' + views);
    if (video.year) bits.push(String(video.year));
    if (bits.length) meta.appendChild(el('div', 'rt-line', bits.join(' · ')));
    a.appendChild(meta);

    row.appendChild(a);
    row.appendChild(menuButton(video, row));
    return row;
  }

  /* ------------------------------------------------------------- homepage */

  function hideNativeHome() {
    var browse = document.querySelector('ytd-browse[page-subtype="home"]');
    if (!browse) return null;
    browse.querySelectorAll('ytd-rich-grid-renderer, #chips-wrapper, ytd-feed-filter-chip-bar-renderer')
      .forEach(function (n) { n.classList.add('rt-hidden'); });
    return browse;
  }

  function renderHome() {
    if (document.getElementById('rt-home')) return;
    var browse = hideNativeHome();
    if (!browse) return;

    shownIds = [];

    var host = el('div', 'rt-host');
    host.id = 'rt-home';

    var header = el('div', 'rt-bar');
    header.appendChild(el('span', 'rt-bar-title', 'videos from ' + settings.cutoffYear + ' and earlier'));
    var status = el('span', 'rt-bar-status', 'loading the pool…');
    header.appendChild(status);
    var reshuffle = el('button', 'rt-btn', 'reshuffle');
    reshuffle.type = 'button';
    reshuffle.addEventListener('click', function () {
      shownIds = [];
      grid.replaceChildren();
      loadMore(grid, status);
    });
    header.appendChild(reshuffle);
    host.appendChild(header);

    var grid = el('div', 'rt-grid');
    host.appendChild(grid);

    var sentinel = el('div', 'rt-sentinel');
    host.appendChild(sentinel);

    var target = browse.querySelector('ytd-rich-grid-renderer');
    if (target && target.parentNode) {
      target.parentNode.insertBefore(host, target);
    } else {
      browse.appendChild(host);
    }

    loadMore(grid, status);

    if (homeObserver) homeObserver.disconnect();
    homeObserver = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && grid.isConnected) loadMore(grid, status);
    }, { rootMargin: '600px' });
    homeObserver.observe(sentinel);
  }

  function loadMore(grid, status) {
    if (loading) return;
    loading = true;

    req('feed', { limit: 36, exclude: shownIds.slice(-400) }).then(function (res) {
      loading = false;
      if (!res || !res.ok) {
        status.textContent = 'couldn\'t reach the pool' + (res && res.error ? ': ' + res.error : '. If the extension was just updated, reload this page.');
        return;
      }
      var videos = res.videos || [];
      var cards = grid.querySelectorAll('.rt-card').length;

      if (!videos.length) {
        // Nothing more. With nothing on screen either, say why — once; the
        // infinite-scroll sentinel is right there and will keep asking.
        if (!cards && !grid.querySelector('.rt-empty')) {
          if (!res.poolSize) renderEmptyState(grid, status);
          else status.textContent = emptyReason(res);
        }
        return;
      }

      var frag = document.createDocumentFragment();
      var index = cards;
      videos.forEach(function (v) {
        shownIds.push(v.id);
        if (!v.title || !String(v.title).trim()) return;
        frag.appendChild(buildCard(v, index++));
      });
      grid.appendChild(frag);

      var scope = (res.eligible !== undefined && res.eligible !== res.poolSize)
        ? res.eligible.toLocaleString() + ' within your limits, ' + (res.poolSize || 0).toLocaleString() + ' in the pool'
        : (res.poolSize || 0).toLocaleString() + ' in the pool';
      status.textContent = grid.querySelectorAll('.rt-card').length + ' shown · ' + scope;
    }).catch(function (e) {
      loading = false;
      status.textContent = 'feed error: ' + String(e && e.message || e);
    });
  }

  function renderEmptyState(grid, status) {
    status.textContent = 'the pool is empty.';
    var box = el('div', 'rt-empty');
    box.appendChild(el('p', null,
      'nothing found yet. fill the pool with a round of searches, or just ' +
      'watch a few old videos and it will build itself from what YouTube says ' +
      'is related to them.'));
    var go = el('button', 'rt-btn rt-btn-primary', 'fill the pool');
    go.type = 'button';
    go.addEventListener('click', function () {
      go.disabled = true;
      go.textContent = 'searching…';
      req('primePool', { rounds: 6 }).then(function (r) {
        go.disabled = false;
        go.textContent = 'fill the pool';
        if (r && r.ok && r.added > 0) {
          box.remove();
          loadMore(grid, status);
        } else {
          go.textContent = 'try again';
          status.textContent = (r && r.reasons && r.reasons[0]) ||
            'no results. the settings page says why.';
        }
      });
    });
    box.appendChild(go);
    grid.appendChild(box);
  }

  /* -------------------------------------------------------------- sidebar
   *
   * YouTube's list stays. Ours goes under it, and leaves out whatever
   * YouTube's already shows, so nothing appears twice. The list for a video
   * is asked for once and kept, so YouTube swapping the sidebar's container
   * — which it does when the player changes size — costs a redraw, not a
   * request.
   */
  var related = { videoId: null, res: null, pending: null };

  /* The page can have two #related containers (YouTube moves its list
   * between them as the layout changes), so follow YouTube's list. */
  function sidebarContainer() {
    var native = document.querySelector('ytd-watch-next-secondary-results-renderer');
    var home = native && native.parentElement;
    return home || document.querySelector('#secondary #related') ||
      document.querySelector('#related') ||
      document.querySelector('#secondary-inner');
  }

  /* YouTube's list is hidden (feed.css) only while ours is on the page. */
  function syncSidebarFlag() {
    var h = document.getElementById('rt-related');
    var on = !!(h && h.isConnected && pageType() === 'watch');
    var root = document.documentElement;
    if (on !== root.hasAttribute('data-rt-sidebar')) {
      if (on) root.setAttribute('data-rt-sidebar', '1');
      else root.removeAttribute('data-rt-sidebar');
    }
  }

  /* The old videos in YouTube's own related list for this video, read off
   * YouTube's data by the interceptor, in YouTube's order. */
  function nativeItems(videoId) {
    return ((window.__rtNative || {})[videoId] || []).slice();
  }

  function nativeIds(videoId) {
    return nativeItems(videoId).map(function (r) { return r.id; });
  }

  /* The player's own account of the video — title, channel, tags,
   * category — which the related searches are built from. It is usually
   * already here by the time the page changes; if not, wait briefly, then
   * make do with what the page shows. */
  function playerInfo(videoId, timeout) {
    var have = (window.__rtPlayers || {})[videoId];
    if (have) return Promise.resolve(have);
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        window.removeEventListener('rt-player-info', onInfo);
        resolve(v);
      }
      function onInfo(ev) {
        if (ev.detail && ev.detail.id === videoId) finish(ev.detail);
      }
      window.addEventListener('rt-player-info', onInfo);
      setTimeout(function () { finish(null); }, timeout);
    });
  }

  function pageInfo() {
    var h1 = document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1');
    var owner = document.querySelector('ytd-watch-metadata #owner #channel-name a, #owner #channel-name a, ytd-video-owner-renderer #channel-name a');
    return {
      title: h1 ? h1.textContent.trim() : '',
      channel: owner ? owner.textContent.trim() : ''
    };
  }

  async function fetchRelated(videoId) {
    // With searching switched off the sidebar is YouTube's own old picks
    // alone.
    if (settings && settings.sidebarRelated === false) return { ok: true, videos: [] };
    var info = await playerInfo(videoId, 2500);
    if (!info) {
      // The heading is drawn a moment after the page; searching with no
      // title would find nothing worth showing.
      await waitFor(function () { return pageInfo().title; }, 5000);
      var fallback = pageInfo();
      info = { title: fallback.title, channel: fallback.channel };
    }
    return req('related', {
      videoId: videoId,
      title: info.title || '',
      channel: info.channel || '',
      channelId: info.channelId || null,
      keywords: info.keywords || [],
      category: info.category || null,
      exclude: nativeIds(videoId),
      limit: 24
    });
  }

  function titled(v) {
    return v && v.title && String(v.title).trim();
  }

  /* Draws what is known so far. `res` is the worker's answer, or null while
   * it is still searching — YouTube's own old picks can be shown before it
   * comes back. */
  function drawRelated(host, res) {
    var status = host.querySelector('.rt-bar-status');
    var list = host.querySelector('.rt-list');

    var natives = nativeItems(host.__rtVideo).filter(titled);
    var seen = Object.create(null);
    natives.forEach(function (r) { seen[r.id] = true; });
    var found = (res && res.ok && res.videos || []).filter(function (v) {
      return titled(v) && !seen[v.id];
    });
    // YouTube's own picks are personalised from your watch history, so they
    // are not allowed to lead: at most four, dealt in every third place.
    var all = [];
    var picks = natives.slice(0, 4);
    for (var fi = 0; fi < found.length || picks.length; fi++) {
      if (picks.length && (all.length % 3 === 2 || fi >= found.length)) all.push(picks.shift());
      if (fi < found.length) all.push(found[fi]);
    }

    if (!res && !all.length) return; // still looking, nothing to show yet

    list.replaceChildren();
    if (!all.length) {
      if (!res.ok) {
        status.textContent = 'couldn\'t reach the pool' + (res.error ? ': ' + res.error : '');
        list.appendChild(el('div', 'rt-side-empty', 'if the extension was just updated, reload this page.'));
      } else {
        status.textContent = res.note || ((res.poolSize || 0).toLocaleString() + ' in the pool');
        list.appendChild(el('div', 'rt-side-empty', res.note
          ? 'nothing found this time: ' + res.note + '.'
          : emptyReason(res)));
      }
      return;
    }

    var frag = document.createDocumentFragment();
    all.forEach(function (v, i) { frag.appendChild(buildRow(v, i)); });
    list.appendChild(frag);
    status.textContent = !res ? all.length + ' so far · searching…'
      : !res.ok ? all.length + ' videos · search failed'
      : all.length + ' videos' + (res.note ? ' · ' + res.note : '');
  }

  function buildSidebar() {
    var host = el('div', 'rt-host rt-side');
    host.id = 'rt-related';
    var bar = el('div', 'rt-bar rt-bar-side');
    bar.appendChild(el('span', 'rt-bar-title'));
    bar.appendChild(el('span', 'rt-bar-status'));
    host.appendChild(bar);
    host.appendChild(el('div', 'rt-list'));
    return host;
  }

  /* One sidebar, kept from one watch page to the next and refilled, so
   * YouTube's own list never flashes up in between. */
  function renderRelated() {
    var videoId = currentVideoId();
    if (!videoId) return;

    var host = document.getElementById('rt-related');
    if (host && host.__rtVideo === videoId && host.isConnected) return;

    var container = sidebarContainer();
    if (!container) return;
    if (!host) host = buildSidebar();
    if (host.parentNode !== container) container.insertBefore(host, container.firstChild);

    host.__rtVideo = videoId;
    host.querySelector('.rt-bar-title').textContent = 'related videos from ' + settings.cutoffYear + ' and earlier';
    host.querySelector('.rt-bar-status').textContent = 'searching…';
    host.querySelector('.rt-list').replaceChildren(
      el('div', 'rt-side-empty', 'looking for old videos like this one…'));

    if (related.videoId === videoId && related.res) {
      drawRelated(host, related.res);
      return;
    }
    drawRelated(host, null);
    if (related.videoId !== videoId) related = { videoId: videoId, res: null, pending: null };
    if (!related.pending) {
      var mine = related;
      mine.pending = fetchRelated(videoId).catch(function (e) {
        return { ok: false, error: String(e && e.message || e) };
      }).then(function (res) {
        mine.res = res;
        // Forget a failure, so coming back to this video tries again.
        if (!res || !res.ok) mine.pending = null;
        return res;
      });
    }
    related.pending.then(function (res) {
      if (related.videoId !== videoId) return; // moved on while it searched
      var h = document.getElementById('rt-related');
      if (h && h.__rtVideo === videoId) drawRelated(h, res);
    });
  }

  // YouTube's own picks can arrive after the search has already come back
  // (more sidebar loaded later) — redraw with them.
  window.addEventListener('rt-native', function (ev) {
    var id = ev.detail && ev.detail.videoId;
    var h = document.getElementById('rt-related');
    if (h && h.__rtVideo === id) drawRelated(h, related.videoId === id ? related.res : null);
  });

  /* When a video ends with YouTube's autoplay on, YouTube counts down to
   * whatever it lined up — usually something new. If that isn't one of the
   * old ones, the first video in our sidebar plays instead, straight away.
   * With YouTube's autoplay off nothing happens, unless "Keep playing old
   * videos" is set in the extension's settings. */
  var autoplayVideo = null;

  function youtubeAutoplayOn() {
    var b = document.querySelector('#movie_player .ytp-autonav-toggle-button');
    return !!b && b.getAttribute('aria-checked') === 'true';
  }

  function firstSidebarVideo(videoId) {
    var h = document.getElementById('rt-related');
    var row = h && h.__rtVideo === videoId && h.querySelector('.rt-row');
    return row && row.__rtVideo ? row.__rtVideo.id : null;
  }

  function bindAutoplay() {
    var video = document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('video.html5-main-video');
    if (!video || video === autoplayVideo) return;
    autoplayVideo = video;
    video.addEventListener('ended', function () {
      if (!settings || !settings.enabled || pageType() !== 'watch') return;
      // An ad ending is not the video ending.
      if (document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting')) return;
      var from = currentVideoId();
      var info = (window.__rtPlayers || {})[from];
      if (info && info.lengthSeconds && Math.abs(video.duration - info.lengthSeconds) > 5) return;
      var planned = (window.__rtAutoplay || {})[from];
      var youtubeOn = youtubeAutoplayOn();
      if (youtubeOn && planned && planned.old) return; // YouTube is headed somewhere old
      if (!youtubeOn && !settings.autoplayFromPool) return;
      var next = firstSidebarVideo(from);
      if (next) navigate(next);
    });
  }

  /* --------------------------------------------------------- lifted zones */

  function renderZoneNote(text) {
    if (document.getElementById('rt-zone-note')) return;
    var browse = document.querySelector('ytd-browse');
    if (!browse) return;
    var note = el('div', 'rt-host rt-note');
    note.id = 'rt-zone-note';
    note.appendChild(el('span', 'rt-note-text', text));
    browse.insertBefore(note, browse.firstChild);
  }

  /* --------------------------------------------------------- watch gating
   *
   * The player's exact upload date decides. It usually arrives before the
   * page has finished changing, so it is looked up by video id whenever the
   * page settles, rather than acted on the moment it lands.
   */
  var letThrough = Object.create(null);

  function blockedYear(videoId) {
    var info = (window.__rtPlayers || {})[videoId];
    if (!info || !info.exactDate) return null;
    var year = new Date(info.exactDate).getFullYear();
    return year > settings.cutoffYear ? year : null;
  }

  /* YouTube starts playback on its own once the player is ready, which can
   * be after the cover went up. While the cover is on, playing is undone. */
  function holdPlayback(video) {
    if (!video || video.__rtHold) return;
    video.__rtHold = true;
    video.addEventListener('play', function () {
      var cover = document.getElementById('rt-block');
      if (cover && cover.__rtVideo === currentVideoId()) {
        try { video.pause(); } catch (e) { /* ignore */ }
      }
    });
  }

  function showBlockScreen(videoId, year) {
    var existing = document.getElementById('rt-block');
    if (existing && existing.__rtVideo === videoId && existing.isConnected) return;
    if (existing) existing.remove();

    var player = document.querySelector('#movie_player') ||
      document.querySelector('ytd-player');
    if (!player) return;

    var info = (window.__rtPlayers || {})[videoId] || {};
    var video = player.querySelector('video') || document.querySelector('video');
    if (video) {
      try { video.pause(); } catch (e) { /* ignore */ }
      holdPlayback(video);
    }

    var overlay = el('div', 'rt-block');
    overlay.id = 'rt-block';
    overlay.__rtVideo = videoId;

    var inner = el('div', 'rt-block-inner');
    inner.appendChild(el('div', 'rt-block-year', String(year)));
    inner.appendChild(el('div', 'rt-block-msg',
      'this video is from after your cutoff of ' + settings.cutoffYear + '.'));
    if (info.title) inner.appendChild(el('div', 'rt-block-title', info.title));

    var actions = el('div', 'rt-block-actions');
    var back = el('button', 'rt-btn rt-btn-primary', 'back to the feed');
    back.type = 'button';
    back.addEventListener('click', function () { location.href = '/'; });
    actions.appendChild(back);

    if (settings.allowEscapeHatch) {
      var anyway = el('button', 'rt-btn', 'watch it anyway');
      anyway.type = 'button';
      anyway.addEventListener('click', function () {
        letThrough[videoId] = true;
        overlay.remove();
        if (video) { try { video.play(); } catch (e) { /* ignore */ } }
      });
      actions.appendChild(anyway);
    }

    inner.appendChild(actions);
    overlay.appendChild(inner);
    player.appendChild(overlay);
  }

  function checkBlock() {
    if (!settings || !settings.enabled || !settings.blockWatchPage) return;
    if (pageType() !== 'watch') return;
    var videoId = currentVideoId();
    if (!videoId || letThrough[videoId]) return;
    var year = blockedYear(videoId);
    if (year) showBlockScreen(videoId, year);
  }

  window.addEventListener('rt-player-info', function (ev) {
    if (ev.detail && ev.detail.id === currentVideoId()) setTimeout(checkBlock, 50);
  });

  /* ---------------------------------------------------------------- shorts */

  function bounceShorts() {
    if (!settings || !settings.killShorts) return;
    if (location.pathname.indexOf('/shorts/') !== 0) return;
    var id = location.pathname.split('/shorts/')[1];
    if (id) location.replace('/watch?v=' + id.split(/[?&#]/)[0]);
    else location.replace('/');
  }

  /* ---------------------------------------------------------------- route */

  function reset() {
    loading = false;
    closeMenu();
    if (homeObserver) { homeObserver.disconnect(); homeObserver = null; }
    ['rt-home', 'rt-block', 'rt-zone-note'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.remove();
    });
    // The sidebar stays from one watch page to the next (renderRelated
    // refills it), so YouTube's own list never shows in between.
    if (pageType() !== 'watch') {
      var side = document.getElementById('rt-related');
      if (side) side.remove();
    }
    document.querySelectorAll('.rt-hidden').forEach(function (n) {
      n.classList.remove('rt-hidden');
    });
  }

  function route() {
    if (!settings || !settings.enabled) return;

    bounceShorts();
    var type = pageType();

    if (type === 'home' && settings.takeOverHome) {
      waitFor(function () {
        return document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
      }, 12000).then(function (found) { if (found) renderHome(); });
    } else if (type === 'watch') {
      checkBlock();
      bindAutoplay();
      if (!relatedOff) {
        // The sidebar's container can turn up late and differs between
        // layouts; attach to whichever exists first. The watchdog repairs it
        // if YouTube swaps it out afterwards.
        waitFor(sidebarContainer, 12000).then(function (found) { if (found) renderRelated(); });
      }
    } else if (type === 'channel' && settings.channelPagesUnfiltered) {
      waitFor(function () { return document.querySelector('ytd-browse'); }, 12000).then(function (found) {
        if (!found) return;
        renderZoneNote('optima time machine: channel pages show every year, so you can see what this channel did after ' +
          settings.cutoffYear + '.');
      });
    } else if (type === 'subs' && settings.subsUnfiltered) {
      waitFor(function () { return document.querySelector('ytd-browse'); }, 12000).then(function (found) {
        if (found) renderZoneNote('optima time machine: subscriptions show every year.');
      });
    }
  }

  /* The watchdog. YouTube swaps containers under us; if our surface is
   * gone, or belongs to the page before, put it right. Cheap: a few id
   * lookups a second. */
  function ensure() {
    if (!settings || !settings.enabled) return;
    var type = pageType();
    if (type === 'home' && settings.takeOverHome) {
      if (!document.getElementById('rt-home')) renderHome();
      else hideNativeHome();
    } else if (type === 'watch') {
      checkBlock();
      bindAutoplay();
      if (!relatedOff) {
        var host = document.getElementById('rt-related');
        if (!host || host.__rtVideo !== currentVideoId() || !host.isConnected) renderRelated();
        else {
          var c = sidebarContainer();
          if (c && host.parentNode !== c) c.insertBefore(host, c.firstChild);
        }
      }
    }
    syncSidebarFlag();
  }

  function onNavigate() {
    if (!alive()) { stop(); return; }
    var key = navKey();
    if (key === lastKey) {
      ensure();
      return;
    }
    lastKey = key;
    reset();
    route();
    syncSidebarFlag();
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  document.addEventListener('yt-page-data-updated', onNavigate);
  window.addEventListener('popstate', onNavigate);
  var watchdog = setInterval(onNavigate, 1000);

  function stop() {
    clearInterval(watchdog);
    document.removeEventListener('yt-navigate-finish', onNavigate);
    document.removeEventListener('yt-page-data-updated', onNavigate);
    window.removeEventListener('popstate', onNavigate);
    settings = null;
  }

  /* A newer copy of this script (injected after an update) tells us to step
   * aside, so two versions never fight over the same page. */
  document.addEventListener('rt-supersede', stop);

  loadSettings().then(function () {
    lastKey = navKey();
    route();
  }).catch(function () { /* orphaned before it started */ });
})();
