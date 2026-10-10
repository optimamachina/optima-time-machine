/* Time Machine for YouTube — service worker.
 *
 * Owns the pool, runs the crawler, answers the content script's requests for
 * videos. MV3 workers get torn down aggressively, so nothing important lives
 * in memory here — state is in IndexedDB and chrome.storage, and an alarm
 * wakes us back up.
 */

importScripts(
  '../shared/dates.js',
  '../shared/extract.js',
  '../shared/seeds.js',
  './db.js',
  './innertube.js',
  './taste.js',
  './rank.js',
  './crawler.js',
  './related.js'
);

var Db = self.RTDb;
var Seeds = self.RTSeeds;
var Innertube = self.RTInnertube;
var Taste = self.RTTaste;
var Rank = self.RTRank;
var Crawler = self.RTCrawler;
var Related = self.RTRelated;

/* ------------------------------------------------------------------ setup */

async function getSettings() {
  var res = await chrome.storage.local.get('settings');
  return Object.assign({}, Seeds.DEFAULT_SETTINGS, (res && res.settings) || {});
}

function ensureAlarms() {
  chrome.alarms.create('crawl', { periodInMinutes: 0.5 });
  chrome.alarms.create('taste', { periodInMinutes: 180 });
  chrome.alarms.create('seedRefresh', { periodInMinutes: 30 });
}

/* Chrome does not re-inject content scripts into tabs that were open when
 * an extension is loaded or updated; their old scripts are orphaned and go
 * quiet. Put the bridge back so collecting keeps working from those tabs.
 * The page's own surfaces need a reload, and the bridge says so. */
async function reviveOpenTabs() {
  var tabs;
  try {
    tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  } catch (e) {
    return;
  }
  for (var i = 0; i < (tabs || []).length; i++) {
    var t = tabs[i];
    if (t.discarded || t.status === 'unloaded') continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: t.id },
        files: ['src/content/bridge.js']
      });
    } catch (e) { /* not a page we can touch */ }
  }
}

chrome.runtime.onInstalled.addListener(async function (details) {
  reviveOpenTabs();
  var res = await chrome.storage.local.get('settings');
  var settings = res && res.settings;
  if (!settings) {
    await chrome.storage.local.set({ settings: Seeds.DEFAULT_SETTINGS });
  } else {
    // Settings from earlier builds: fill in new keys, retire the dated
    // model id.
    var merged = Object.assign({}, Seeds.DEFAULT_SETTINGS, settings);
    // 1.1.x switched the sidebar section off on every update, and its
    // checkbox was never wired up, so everyone upgrading has it off without
    // having chosen that. The section is now built from searches for what
    // the video is about, so it comes back on once. After this, it's yours.
    if (!(settings.settingsVersion >= 2)) {
      merged.sidebarRelated = true;
      merged.settingsVersion = 2;
    }
    // 1.2.0: pre-algorithm by default. What you watch no longer steers
    // anything unless you switch learning back on; the old tallies go.
    if (!(merged.settingsVersion >= 3)) {
      merged.learnInterests = false;
      merged.learnedSeeds = [];
      merged.settingsVersion = 3;
      await chrome.storage.local.remove('taste');
    }
    delete merged.takeOverSidebar;
    // 1.3.0: view limits and camera-roll searches are gone (limits starved the homepage)
    delete merged.minViews;
    delete merged.maxViews;
    delete merged.cameraSearches;
    if (/^claude-haiku-4-5-\d+$/.test(merged.aiModel || '')) merged.aiModel = Seeds.DEFAULT_SETTINGS.aiModel;
    if (merged.anthropicKey && !merged.geminiKey && !settings.aiProvider) merged.aiProvider = 'anthropic';
    // API keys used to sit inside settings, which the YouTube-page scripts
    // read. They move to their own slot that only the worker and the
    // settings page touch.
    if (merged.geminiKey || merged.anthropicKey) {
      var had = (await chrome.storage.local.get('aiKeys')).aiKeys || {};
      await chrome.storage.local.set({ aiKeys: {
        geminiKey: had.geminiKey || merged.geminiKey || '',
        anthropicKey: had.anthropicKey || merged.anthropicKey || ''
      } });
    }
    delete merged.geminiKey;
    delete merged.anthropicKey;
    await chrome.storage.local.set({ settings: merged });
  }
  ensureAlarms();

  if (details && details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(ensureAlarms);

chrome.alarms.onAlarm.addListener(async function (alarm) {
  if (alarm.name === 'crawl') {
    await Crawler.tick(false);
  } else if (alarm.name === 'taste') {
    var cfg = await getSettings();
    if (cfg.aiExpansion) await Taste.expandWithAi(cfg, false);
  } else if (alarm.name === 'seedRefresh') {
    // Keep the learned seeds visible to the crawler without it reaching
    // into taste storage directly.
    var seeds = await Taste.learnedSeeds(30);
    var res = await chrome.storage.local.get('settings');
    var s = Object.assign({}, Seeds.DEFAULT_SETTINGS, (res && res.settings) || {});
    s.learnedSeeds = s.learnInterests ? seeds : [];
    await chrome.storage.local.set({ settings: s });
  }
});

/* The idle event only fires on change, so a freshly woken worker would
 * otherwise have no idea whether you're at the keyboard. Ask outright. */
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener(function (newState) {
  Crawler.setIdle(newState !== 'active');
});
chrome.idle.queryState(60).then(function (state) {
  Crawler.setIdle(state !== 'active');
});

/* --------------------------------------------------------------- messages */

/* Anything that arrives from a YouTube tab passed through the page, where
 * any script on youtube.com could have written it. Only well-formed video
 * records get in: an 11-character id, short plain strings, numbers that are
 * numbers, thumbnails only from YouTube's own image servers. */
var VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
var THUMB_HOST = /^https:\/\/(i\d?\.ytimg\.com|yt3\.ggpht\.com)\//;

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function cleanRecord(r) {
  if (!r || typeof r !== 'object' || !VIDEO_ID.test(r.id || '')) return null;
  var title = str(r.title, 300).trim();
  if (!title) return null;
  return {
    id: r.id,
    title: title,
    channel: str(r.channel, 120),
    channelId: /^UC[A-Za-z0-9_-]{20,30}$/.test(r.channelId || '') ? r.channelId : null,
    thumb: THUMB_HOST.test(r.thumb || '') ? str(r.thumb, 500) : null,
    ago: str(r.ago, 60) || null,
    views: str(r.views, 60) || null,
    viewCount: num(r.viewCount),
    duration: /^(\d+:)?\d{1,2}:\d{2}$/.test(r.duration || '') ? r.duration : null,
    year: num(r.year),
    ts: num(r.ts)
  };
}

function cleanPlayer(p) {
  if (!p || typeof p !== 'object' || !VIDEO_ID.test(p.id || '')) return {};
  return {
    id: p.id,
    title: str(p.title, 300),
    channel: str(p.channel, 120),
    channelId: /^UC[A-Za-z0-9_-]{20,30}$/.test(p.channelId || '') ? p.channelId : null,
    exactDate: !isNaN(Date.parse(p.exactDate)) ? str(p.exactDate, 40) : null,
    viewCount: num(p.viewCount),
    lengthSeconds: num(p.lengthSeconds),
    keywords: Array.isArray(p.keywords) ? p.keywords.filter(function (k) { return typeof k === 'string'; }).slice(0, 30).map(function (k) { return k.slice(0, 60); }) : [],
    category: str(p.category, 60) || null,
    live: !!p.live
  };
}

function poolFilter(cfg) {
  var hiddenChannels = cfg.hiddenChannels || [];
  return function (v) {
    if (v.hidden) return false;
    if (hiddenChannels.length && (
        (v.channelId && hiddenChannels.indexOf(v.channelId) !== -1) ||
        (v.channel && hiddenChannels.indexOf(v.channel) !== -1))) return false;
    if (v.year && v.year > cfg.cutoffYear) return false;
    return true;
  };
}

async function handlePlayer(p) {
  if (!p.id || !/^[A-Za-z0-9_-]{11}$/.test(p.id)) return { ok: false };
  if (!p.title || !String(p.title).trim()) return { ok: false };
  // A stream has no upload date worth learning from.
  if (p.live) return { ok: true };

  var cfg = await getSettings();
  var exactYear = p.exactDate ? new Date(p.exactDate).getFullYear() : null;
  var existing = await Db.getVideo(p.id);

  if (existing && exactYear && exactYear > cfg.cutoffYear) {
    // The feed guessed wrong from "n years ago"; the player knows better.
    await Db.deleteVideo(p.id);
    return { ok: true, removed: true };
  }

  if (existing) {
    await Db.updateVideo(p.id, function (rec) {
      rec.watched = 1;
      if (exactYear) { rec.year = exactYear; rec.exact = 1; }
      if (p.exactDate) rec.ts = new Date(p.exactDate).getTime();
      if (p.viewCount != null) rec.viewCount = p.viewCount;
      if (!rec.channel && p.channel) rec.channel = p.channel;
      if (!rec.channelId && p.channelId) rec.channelId = p.channelId;
      if (Array.isArray(p.keywords) && p.keywords.length) rec.keywords = p.keywords.slice(0, 30);
      if (p.category) rec.category = p.category;
      rec.lastSeen = Date.now();
    });
  } else if (exactYear && exactYear <= cfg.cutoffYear) {
    await Db.putVideos([{
      id: p.id,
      title: p.title,
      channel: p.channel,
      channelId: p.channelId,
      year: exactYear,
      ts: new Date(p.exactDate).getTime(),
      viewCount: p.viewCount
    }], 'watch');
    await Db.updateVideo(p.id, function (rec) {
      rec.watched = 1;
      rec.exact = 1;
      if (Array.isArray(p.keywords) && p.keywords.length) rec.keywords = p.keywords.slice(0, 30);
      if (p.category) rec.category = p.category;
    });
  }

  if (cfg.learnInterests && exactYear && exactYear <= cfg.cutoffYear) {
    await Taste.recordWatch(p);
  }
  return { ok: true };
}

async function handle(msg, sender) {
  var cfg;
  switch (msg.type) {

    case 'harvest': {
      // A batch can mix a watch page's related list with search results or
      // a previous page's leftovers, so each record keeps the video it was
      // listed beside — which is also the edge the sidebar uses later.
      var batch = Array.isArray(msg.batch) ? msg.batch : [];
      var groups = Object.create(null);
      batch.forEach(function (e) {
        var v = e && cleanRecord(e.v);
        if (!v) return;
        var from = e.from && VIDEO_ID.test(e.from) ? e.from : '';
        (groups[from] = groups[from] || []).push(v);
      });
      var added = 0;
      var froms = Object.keys(groups);
      for (var gi = 0; gi < froms.length; gi++) {
        var f = froms[gi];
        added += await Db.putVideos(groups[f], f ? 'graph:' + f : 'feed');
        if (f) await Db.addEdges(f, groups[f].map(function (v) { return v.id; }));
      }
      return { ok: true, added: added };
    }

    case 'innertube':
      Innertube.setCredentials(msg.payload);
      return { ok: true };

    case 'player':
      return handlePlayer(cleanPlayer(msg.payload));

    case 'feed': {
      cfg = await getSettings();
      // Without interest learning, what you watched has no say in ranking.
      var r = await Promise.all([Db.sample(6000, poolFilter(cfg)), cfg.learnInterests ? Taste.loadTaste() : {}]);
      var ranked = Rank.rankFeed(r[0], r[1], {
        limit: msg.limit || 36,
        excludeIds: msg.exclude || [],
        maxYear: cfg.cutoffYear
      });
      Db.markShown(ranked.map(function (v) { return v.id; })).catch(function () {});
      var total = await Db.countVideos();
      return { ok: true, videos: ranked, poolSize: total, eligible: r[0].length };
    }

    case 'related': {
      cfg = await getSettings();
      var stored = msg.videoId ? await Db.getVideo(msg.videoId) : null;
      // What the page says about the video beats what the pool remembers.
      var current = {
        id: msg.videoId || null,
        title: msg.title || (stored && stored.title) || '',
        channel: msg.channel || (stored && stored.channel) || '',
        channelId: msg.channelId || (stored && stored.channelId) || null,
        keywords: (msg.keywords && msg.keywords.length ? msg.keywords : (stored && stored.keywords)) || [],
        category: msg.category || (stored && stored.category) || null
      };
      var rel = await Related.related(current, cfg, {
        filter: poolFilter(cfg),
        exclude: msg.exclude || [],
        limit: msg.limit || 24,
        tabId: sender && sender.tab ? sender.tab.id : null
      });
      Db.markShown(rel.videos.map(function (v) { return v.id; })).catch(function () {});
      return {
        ok: true,
        videos: rel.videos,
        sources: rel.sources,
        cached: !!rel.cached,
        note: rel.errors && rel.errors.length ? rel.errors[0] : null,
        poolSize: await Db.countVideos(),
        eligible: rel.eligible
      };
    }

    case 'hideChannel': {
      var key = msg.channelId || msg.channel;
      if (!key) return { ok: false, error: 'no channel' };
      cfg = await getSettings();
      var list = (cfg.hiddenChannels || []).slice();
      if (list.indexOf(key) === -1) list.push(key);
      if (msg.channel && msg.channelId && list.indexOf(msg.channel) === -1) list.push(msg.channel);
      var stored = await chrome.storage.local.get('settings');
      var next = Object.assign({}, Seeds.DEFAULT_SETTINGS, (stored && stored.settings) || {});
      next.hiddenChannels = list;
      await chrome.storage.local.set({ settings: next });
      return { ok: true, hiddenChannels: list };
    }

    case 'status': {
      var st = await Promise.all([Crawler.status(), getSettings(), Taste.loadTaste()]);
      return {
        ok: true,
        crawler: st[0],
        settings: st[1],
        taste: {
          watched: st[2].watched || 0,
          topTerms: Taste.topTerms(st[2], 24),
          topChannels: Taste.topChannels(st[2], 12),
          aiSeeds: st[2].aiSeeds || [],
          banned: st[2].banned || [],
          lastAi: st[2].lastAi || 0,
          lastAiError: st[2].lastAiError || null
        }
      };
    }

    case 'primePool': {
      var pr = await Crawler.primePool(msg.rounds || 5);
      return Object.assign({ ok: true }, pr);
    }

    case 'crawlNow': {
      var result = await Crawler.tick(true);
      var status = await Crawler.status();
      return { ok: true, result: result, crawler: status };
    }

    case 'runAi': {
      cfg = await getSettings();
      return { ok: true, result: await Taste.expandWithAi(cfg, true) };
    }

    case 'banTerm':
      await Taste.banTerm(msg.term);
      return { ok: true };

    case 'hideVideo':
      await Db.updateVideo(msg.id, function (rec) { rec.hidden = 1; });
      return { ok: true };

    case 'unbanTerm':
      await Taste.unbanTerm(msg.term);
      return { ok: true };

    case 'recent': {
      var rows = await Db.recent(msg.limit || 20);
      return {
        ok: true,
        videos: rows.map(function (v) {
          return { id: v.id, title: v.title, channel: v.channel, year: v.year,
                   ago: v.ago, degree: v.degree, source: v.source, exact: v.exact };
        })
      };
    }

    case 'scrub':
      cfg = await getSettings();
      return { ok: true, report: await Db.scrub(cfg.cutoffYear) };

    case 'purge':
      cfg = await getSettings();
      return { ok: true, removed: await Db.purgeAfter(cfg.cutoffYear) };

    case 'clearPool':
      await Db.clearAll();
      return { ok: true };

    default:
      return { ok: false, error: 'unknown message ' + msg.type };
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type || msg.type === 'ytFetch') return false;
  handle(msg, sender).then(sendResponse, function (e) {
    sendResponse({ ok: false, error: String(e && e.message || e) });
  });
  return true;
});
