/* Time Machine for YouTube — pulling meaning out of YouTube's JSON.
 *
 * YouTube renames and reshapes its renderers constantly. Hard-coding paths
 * like `videoRenderer.publishedTimeText.simpleText` works until the Tuesday it
 * doesn't. So instead of walking known paths, we bounded-depth scan each item
 * for the *shapes* we care about: an 11-character video id, a string that
 * looks like "n years ago", a title, a channel. That survives renames.
 *
 * As of the 2026 lockup redesign every home and sidebar item is a
 * `lockupViewModel`. Its metadata rows carry the channel name, an abbreviated
 * view count ("1M") and an abbreviated age ("1mo ago"), each with the long
 * form in an accessibility label. The scan reads both.
 */
(function (root) {
  'use strict';

  var Dates = root.RTDates;

  var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  var AGO_RE = Dates ? Dates.AGO_RE :
    /(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mo|years?|yrs?|[smhdwy])\s+ago\b/i;
  var VIEWS_RE = /^([\d.,]+)\s*([KMB]|thousand|million|billion)?\s+views?$/i;
  var NO_VIEWS_RE = /^no views$/i;
  var DURATION_RE = /^(\d+:)?\d{1,2}:\d{2}$/;

  /* Renderer keys that represent a single watchable item. */
  var ITEM_KEYS = [
    'videoRenderer',
    'gridVideoRenderer',
    'compactVideoRenderer',
    'richItemRenderer',
    'playlistVideoRenderer',
    'playlistPanelVideoRenderer',
    'videoWithContextRenderer',
    'compactMovieRenderer',
    'endScreenVideoRenderer',
    'lockupViewModel',
    'videoLockupViewModel',
    'compactPlaylistRenderer',
    'gridPlaylistRenderer',
    'playlistRenderer',
    'radioRenderer',
    'compactRadioRenderer',
    'movieRenderer',
    'gridMovieRenderer'
  ];

  /* Anything matching these is removed unconditionally: Shorts surfaces,
   * ads, and the promotional shelves YouTube keeps bolting onto the feed. */
  var NUKE_KEYS = [
    'reelItemRenderer',
    'reelShelfRenderer',
    'shortsLockupViewModel',
    'reelPlayerOverlayRenderer',
    'adSlotRenderer',
    'displayAdRenderer',
    'promotedVideoRenderer',
    'promotedSparklesWebRenderer',
    'promotedSparklesTextSearchRenderer',
    'compactPromotedVideoRenderer',
    'searchPyvRenderer',
    'carouselAdRenderer',
    'inFeedAdLayoutRenderer',
    'statementBannerRenderer',
    'clarificationRenderer',
    'emergencyOneboxRenderer',
    'primetimePromoRenderer',
    'brandVideoShelfRenderer',
    'brandVideoSingletonRenderer',
    'miniGameCardViewModel',
    'gameCardViewModel',
    'feedNudgeRenderer',
    'merchandiseShelfRenderer',
    'ticketShelfRenderer',
    'postRenderer',
    'backstagePostThreadRenderer',
    'sharedPostRenderer'
  ];

  /* A lockup whose metadata is one of these is an ad wearing a video's
   * clothes. It carries a real video id and a headline, so nothing else
   * would catch it. */
  var AD_METADATA_KEYS = ['feedAdMetadataViewModel', 'adMetadataViewModel'];
  var AD_KEY_RE = /^(ad[A-Z]|feedAd|inFeedAd|promoted)/;

  /* Shelf titles that are always modern-surface noise regardless of contents. */
  var NUKE_SHELF_TITLES = [
    'shorts', 'trending', 'breaking news', 'for you', 'previously watched',
    'recommended', 'latest posts', 'new to you', 'live now',
    'from your subscriptions', 'today', 'fundraisers', 'courses',
    'trending shorts', 'popular shorts'
  ];

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function firstKey(obj) {
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) return k;
    return null;
  }

  /* "1.2K" / "1M" / "1,204" / "1 million" -> number. Null when unreadable. */
  function parseViews(text) {
    if (!text || typeof text !== 'string') return null;
    var s = text.trim();
    if (NO_VIEWS_RE.test(s)) return 0;
    var m = s.match(VIEWS_RE);
    if (!m) return null;
    var n = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(n)) return null;
    var suffix = (m[2] || '').toLowerCase();
    if (suffix === 'k' || suffix === 'thousand') n *= 1e3;
    else if (suffix === 'm' || suffix === 'million') n *= 1e6;
    else if (suffix === 'b' || suffix === 'billion') n *= 1e9;
    return Math.round(n);
  }

  /* Parts of a card that never say anything about the video itself, but can
   * be most of its bytes: the "…" menu (every lockup carries a full copy of
   * its own share/queue/playlist sheet), tracking blobs, and preloading
   * hints for the player. Skipping them keeps the string budget for the
   * title and metadata rows. */
  var SKIP_KEYS = {
    menu: 1, menuButton: 1, trackingParams: 1, clickTrackingParams: 1,
    loggingDirectives: 1, loggingContext: 1, watchEndpointSupportedOnesieConfig: 1,
    watchEndpointSupportedPrefetchConfig: 1, richThumbnail: 1, inlinePlaybackEndpoint: 1,
    animatedThumbnailOverlayViewModel: 1, thumbnailHoverOverlayViewModel: 1
  };

  /* Bounded-depth string harvest. Collects every string in the subtree so we
   * can pattern-match against it, and short-circuits on very deep objects so a
   * pathological payload can't stall the page. */
  function collect(node, out, depth, budget) {
    if (depth > 12 || out.count > budget) return;
    if (typeof node === 'string') {
      out.strings.push(node);
      out.count++;
      return;
    }
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length && out.count < budget; i++) {
        collect(node[i], out, depth + 1, budget);
      }
      return;
    }
    if (isPlainObject(node)) {
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        if (SKIP_KEYS[k]) continue;
        if (out.count > budget) break;
        var v = node[k];
        if (k === 'videoId' && typeof v === 'string' && VIDEO_ID_RE.test(v)) {
          if (!out.videoId) out.videoId = v;
        }
        if (k === 'contentId' && typeof v === 'string' && VIDEO_ID_RE.test(v)) {
          if (!out.videoId) out.videoId = v;
        }
        if (k === 'playlistId' && typeof v === 'string') {
          if (!out.playlistId) out.playlistId = v;
        }
        if (k === 'browseId' && typeof v === 'string' && v.indexOf('UC') === 0) {
          if (!out.channelId) out.channelId = v;
        }
        if (k === 'canonicalBaseUrl' && typeof v === 'string') {
          if (!out.channelUrl) out.channelUrl = v;
        }
        if (k === 'url' && typeof v === 'string' && v.indexOf('/shorts/') !== -1) {
          out.shortsUrl = true;
        }
        if ((k === 'style' || k === 'contentType') && v === 'SHORTS') {
          out.shortsFlag = true;
        }
        if ((k === 'isLiveNow' || k === 'isLive' || k === 'isUpcoming') && v === true) {
          out.live = true;
        }
        if (k === 'contentType' && typeof v === 'string' && /PLAYLIST|MIX|RADIO/i.test(v)) {
          out.mix = true;
        }
        // A playlistId starting RD is a radio/mix — but an ordinary music
        // video's link carries one too ("play this, then a mix of similar"),
        // so on its own it says nothing about the card. Mix cards are caught
        // by their renderer or content type instead.
        // Whole words only: BADGE_STYLE_TYPE_LIVE_NOW, not ..._DELIVERED.
        if ((k === 'style' || k === 'badgeStyle') && typeof v === 'string' && /(^|_)(LIVE|UPCOMING)(_|$)/.test(v)) {
          out.live = true;
        }
        if (k === 'label' && typeof v === 'string' && /^(live|upcoming|premiere)/i.test(v)) {
          out.live = true;
        }
        if (AD_KEY_RE.test(k) || (k === 'label' && v === 'Sponsored')) {
          out.ad = true;
        }
        if (k === 'thumbnails' && Array.isArray(v) && v.length && !out.thumb) {
          var best = v[v.length - 1];
          if (best && typeof best.url === 'string') out.thumb = best.url;
        }
        // Lockups keep the long form of abbreviated metadata here.
        if (k === 'accessibilityLabel' && typeof v === 'string') {
          out.labels.push(v);
        }
        collect(v, out, depth + 1, budget);
      }
    }
  }

  /* Live streams, premieres and scheduled videos have no upload date — they
   * show a watcher count or a countdown instead. Everything here is anchored:
   * unanchored /watching/ flags "watching paint dry", and unanchored /live/
   * flags half the concert footage on old YouTube. */
  var LIVE_PATTERNS = [
    /\d[\d,.\s]*(watching|waiting)\b/i,
    /^\s*watching(\s+now)?\s*$/i,
    /^\s*live\s*$/i,
    /^premieres\b/i,
    /^scheduled for\b/i,
    /^started streaming\b/i
  ];

  function looksLive(str) {
    for (var i = 0; i < LIVE_PATTERNS.length; i++) {
      if (LIVE_PATTERNS[i].test(str)) return true;
    }
    return false;
  }

  /* Mixes and auto-generated radio playlists are assembled fresh from
   * whatever YouTube is pushing right now. They carry a video id and a title,
   * so they pass every other check, but they have no upload date and are not
   * a video at all. */
  var MIX_PATTERNS = [
    /^mix\s*[-–—]/i,
    /^my mix\b/i,
    /^radio\s*[-–—]/i,
    /\bmix\b.*\bplaylist\b/i
  ];

  function looksMix(str) {
    for (var i = 0; i < MIX_PATTERNS.length; i++) {
      if (MIX_PATTERNS[i].test(str)) return true;
    }
    return false;
  }

  function scan(item) {
    var out = {
      strings: [], labels: [], count: 0,
      videoId: null, playlistId: null, channelId: null, channelUrl: null,
      thumb: null, shortsUrl: false, shortsFlag: false, live: false, mix: false,
      ad: false
    };
    collect(item, out, 0, 900);

    var ago = null, views = null, duration = null, channelFromLabel = null;
    var all = out.strings;
    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      if (!ago && AGO_RE.test(s)) ago = s;
      if (!views && (VIEWS_RE.test(s) || NO_VIEWS_RE.test(s))) views = s;
      if (!duration && DURATION_RE.test(s) && s.length <= 8) duration = s;
      if (!out.live && looksLive(s)) out.live = true;
      if (!out.mix && looksMix(s)) out.mix = true;
      if (!channelFromLabel && s.indexOf('Go to channel ') === 0) {
        channelFromLabel = s.slice('Go to channel '.length).trim();
      }
    }

    // Prefer the spelled-out accessibility form of an age or view count when
    // both exist: "1 month ago" over "1mo ago", "1 million views" over "1M".
    for (var j = 0; j < out.labels.length; j++) {
      var l = out.labels[j];
      if (AGO_RE.test(l)) ago = l;
      if (VIEWS_RE.test(l) || NO_VIEWS_RE.test(l)) views = l;
    }

    return {
      videoId: out.videoId,
      playlistId: out.playlistId,
      channelId: out.channelId,
      channelUrl: out.channelUrl,
      channelFromLabel: channelFromLabel,
      thumb: out.thumb,
      ago: ago,
      views: views,
      duration: duration,
      live: out.live,
      mix: out.mix,
      ad: out.ad,
      shortish: out.shortsUrl || out.shortsFlag,
      strings: out.strings
    };
  }

  /* Title and channel need a little more care than "first plausible string",
   * so we try the common paths first and fall back to heuristics. */
  function readTitle(item) {
    var paths = [
      ['title', 'runs', 0, 'text'],
      ['title', 'simpleText'],
      ['title', 'content'],
      ['headline', 'simpleText'],
      ['headline', 'content'],
      ['metadata', 'lockupMetadataViewModel', 'title', 'content'],
      ['header', 'sectionHeaderViewModel', 'headline', 'content'],
      ['header', 'shelfHeaderViewModel', 'title', 'content'],
      ['header', 'richShelfHeaderRenderer', 'title', 'runs', 0, 'text'],
      ['title', 'accessibility', 'accessibilityData', 'label']
    ];
    for (var i = 0; i < paths.length; i++) {
      var v = dig(item, paths[i]);
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  function readChannel(item) {
    var paths = [
      ['longBylineText', 'runs', 0, 'text'],
      ['shortBylineText', 'runs', 0, 'text'],
      ['ownerText', 'runs', 0, 'text'],
      ['videoOwnerRenderer', 'title', 'runs', 0, 'text'],
      ['metadata', 'lockupMetadataViewModel', 'metadata', 'contentMetadataViewModel',
        'metadataRows', 0, 'metadataParts', 0, 'text', 'content']
    ];
    for (var i = 0; i < paths.length; i++) {
      var v = dig(item, paths[i]);
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  function dig(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[path[i]];
    }
    return cur;
  }

  /* Feed items arrive inside wrappers that carry no meaning of their own —
   * a richItemRenderer holding a video, a richSectionRenderer holding a shelf.
   * Judging the wrapper instead of its payload is how ads sneak through and
   * how nuked shelves get left behind as empty husks, so always unwrap first. */
  function unwrap(item) {
    if (!isPlainObject(item)) return item;
    if (item.richItemRenderer && item.richItemRenderer.content) {
      return unwrap(item.richItemRenderer.content);
    }
    if (item.richSectionRenderer && item.richSectionRenderer.content) {
      return unwrap(item.richSectionRenderer.content);
    }
    return item;
  }

  function isShortsHeading(heading) {
    return !!heading && /\bshorts?\b/i.test(heading);
  }

  function isAdLockup(lockup) {
    if (!isPlainObject(lockup) || !isPlainObject(lockup.metadata)) return false;
    return AD_METADATA_KEYS.indexOf(firstKey(lockup.metadata)) !== -1;
  }

  /* Containers that group items and mean nothing once the items are gone:
   * every kind of shelf, and the home feed's section wrapper. */
  var SHELF_KEY_RE = /shelf/i;

  function isShelfKey(key) {
    return !!key && (SHELF_KEY_RE.test(key) || key === 'richSectionRenderer');
  }

  /* Things that count as "content" when deciding whether a shelf is empty. */
  var CONTENT_KEY_RE = /^(channelRenderer|gridChannelRenderer|continuationItemRenderer)$/;

  function hasContent(node, depth) {
    if (depth > 14 || node === null || typeof node !== 'object') return false;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) if (hasContent(node[i], depth + 1)) return true;
      return false;
    }
    var key = firstKey(node);
    if (key && (ITEM_KEYS.indexOf(key) !== -1 || CONTENT_KEY_RE.test(key))) return true;
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (hasContent(node[k], depth + 1)) return true;
    }
    return false;
  }

  /* True for a shelf that no longer holds anything worth drawing — a
   * header with nothing under it. Judged after filtering. */
  function isEmptyShelf(item) {
    var target = unwrap(item);
    if (!isPlainObject(target)) return false;
    var key = firstKey(target);
    if (!isShelfKey(key)) return false;
    return !hasContent(target[key], 0);
  }

  function classify(item) {
    if (!isPlainObject(item)) return { kind: 'other' };

    var target = unwrap(item);
    var key = firstKey(target);
    if (!key) return { kind: 'other' };

    if (/reel|shorts/i.test(key)) return { kind: 'nuke', key: key, shorts: true };
    if (NUKE_KEYS.indexOf(key) !== -1) return { kind: 'nuke', key: key, shorts: false };
    if (key === 'lockupViewModel' && isAdLockup(target[key])) {
      return { kind: 'nuke', key: key, shorts: false, ad: true };
    }

    // Shelves get judged by their heading rather than their container type.
    if (/shelfRenderer|shelfViewModel/i.test(key)) {
      var heading = (readTitle(target[key]) || '').toLowerCase().trim();
      for (var i = 0; i < NUKE_SHELF_TITLES.length; i++) {
        if (heading && heading.indexOf(NUKE_SHELF_TITLES[i]) !== -1) {
          return { kind: 'nuke', key: key, heading: heading, shorts: isShortsHeading(heading) };
        }
      }
      return { kind: 'shelf', key: key, heading: heading };
    }

    if (ITEM_KEYS.indexOf(key) !== -1) return { kind: 'item', key: key };
    return { kind: 'other', key: key };
  }

  /* Build the record we store in the pool.
   *
   * A real video card always carries a title, so a title-less item is some
   * other kind of object that happened to contain a video id — a tracking
   * blob, a shelf header, an ad. And the id itself must be exactly 11
   * characters, because other id-shaped fields turn up all over these
   * payloads and would otherwise be stored as videos that don't exist.
   */
  function describe(item) {
    var target = unwrap(item);
    var key = firstKey(target);
    var body = (key && isPlainObject(target[key])) ? target[key] : target;
    var s = scan(target);

    if (!s.videoId || !VIDEO_ID_RE.test(s.videoId)) return null;

    var title = readTitle(body) || readTitle(target) || '';
    title = title.trim();
    if (!title) return null;

    return {
      id: s.videoId,
      title: title,
      channel: readChannel(body) || readChannel(target) || s.channelFromLabel || '',
      channelId: s.channelId || null,
      channelUrl: s.channelUrl || null,
      thumb: s.thumb || ('https://i.ytimg.com/vi/' + s.videoId + '/hqdefault.jpg'),
      ago: s.ago || null,
      views: s.views || null,
      viewCount: parseViews(s.views),
      duration: s.duration || null,
      live: !!s.live,
      mix: !!s.mix || /radio/i.test(key || ''),
      ad: !!s.ad,
      shortish: !!s.shortish
    };
  }

  var api = {
    classify: classify,
    describe: describe,
    scan: scan,
    unwrap: unwrap,
    readTitle: readTitle,
    readChannel: readChannel,
    parseViews: parseViews,
    isShelfKey: isShelfKey,
    isEmptyShelf: isEmptyShelf,
    isPlainObject: isPlainObject,
    firstKey: firstKey,
    VIDEO_ID_RE: VIDEO_ID_RE,
    ITEM_KEYS: ITEM_KEYS,
    NUKE_KEYS: NUKE_KEYS
  };

  root.RTExtract = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
