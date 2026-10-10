/* Time Machine for YouTube — default settings and starter seeds.
 *
 * Seeds are only the ignition. Once you watch anything, the related-video
 * graph takes over and these matter much less. They're grouped so whole
 * clusters can be pruned in one go from the settings page, and every single
 * term can be removed or added to from there too.
 */
(function (root) {
  'use strict';

  var SEED_CLUSTERS = {
    'Anime & AMV': [
      'naruto amv', 'bleach amv', 'dbz amv', 'inuyasha amv', 'death note amv',
      'code geass amv', 'fullmetal alchemist amv', 'amv hell', 'anime music video',
      'amv contest', 'naruto shippuden opening', 'linkin park amv', 'evangelion amv',
      'gundam seed amv', 'anime mv', 'best amv'
    ],
    'Flash & Newgrounds': [
      'newgrounds', 'flash animation', 'madness combat', 'salad fingers',
      'xiao xiao', 'stick fight flash', 'albino blacksheep', 'homestar runner',
      'weebl', 'badger badger badger', 'animator vs animation', 'flash cartoon',
      'sprite comic', 'stick figure animation'
    ],
    'Internet culture': [
      'youtube poop', 'ytp', 'numa numa', 'chocolate rain', 'leeroy jenkins',
      'dramatic chipmunk', 'trololo', 'keyboard cat', 'banana phone',
      'rickroll', 'charlie bit my finger', 'star wars kid', 'end of ze world',
      'badgers mushroom snake', 'lolcats', 'ebaums world'
    ],
    'Skating & tech decks': [
      'tech deck tricks', 'fingerboard', 'skate montage', 'flatground tricks',
      'kickflip tutorial', 'skatepark session', 'skate edit', 'handrail skate',
      'tech deck park', 'fingerboard tricks', 'street skating', 'skate slam'
    ],
    'PSP & old tech': [
      'psp homebrew', 'psp custom firmware', 'cfw psp', 'psp umd', 'psp themes',
      'psp gameplay', 'ipod nano review', 'razr v3', 'nintendo ds hack',
      'psp emulator', 'zune review', 'motorola sidekick'
    ],
    'Toys': [
      'bionicle', 'beyblade', 'lego stop motion', 'transformers stop motion',
      'action figure review', 'hot wheels', 'nerf mod', 'lego brickfilm',
      'gundam model', 'yugioh cards', 'pokemon cards opening'
    ],
    'Emo, nu metal & scene': [
      'emo hair tutorial', 'scene kid', 'myspace', 'screamo', 'linkin park live',
      'slipknot live', 'korn live', 'limp bizkit', 'system of a down live',
      'deftones live', 'taking back sunday', 'my chemical romance live',
      'scene hair', 'crunkcore'
    ],
    'Sketch comedy': [
      'sketch comedy', 'smosh', 'collegehumor', 'barats and bereta',
      'whitest kids u know', 'channel 101', 'lonely island', 'ask a ninja',
      'the mean kitty song', 'comedy skit', 'short film comedy'
    ],
    'Amateur & obscure': [
      'my first video', 'webcam video', 'me and my friends', 'bored at home',
      'random video', 'home video', 'testing my camera', 'nothing to do',
      'me singing', 'my room tour', 'first vlog', 'me and my dog',
      'messing around', 'stupid video'
    ],
    'Gaming': [
      'machinima', 'red vs blue', 'halo 3 montage', 'cod4 montage',
      'runescape', 'habbo hotel', 'club penguin', 'gmod machinima',
      'counter strike frag movie', 'wow machinima', 'speedrun 2008',
      'let\'s play 2008', 'nintendo 64 gameplay'
    ],
    'Japan': [
      'japanese commercial', 'japanese game show', 'gaki no tsukai',
      'japan vlog', 'tokyo street', 'akihabara', 'harajuku fashion',
      'japanese prank show', 'japanese arcade', 'jpop pv', 'japan trip',
      'japanese candy', 'japanese vending machine', 'shibuya crossing',
      'japanese tv show', 'learn japanese lesson'
    ]
  };

  var OWN_CLUSTER = 'Your own';

  function norm(term) {
    return String(term || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /* The clusters as the user has edited them: defaults minus what they
   * removed, plus what they added, plus their own free-form category. */
  function effectiveClusters(settings) {
    settings = settings || {};
    var removed = (settings.removedSeeds || []).map(norm);
    var added = settings.addedSeeds || {};
    var out = {};
    var name;

    for (name in SEED_CLUSTERS) {
      if (!Object.prototype.hasOwnProperty.call(SEED_CLUSTERS, name)) continue;
      out[name] = SEED_CLUSTERS[name].filter(function (t) {
        return removed.indexOf(norm(t)) === -1;
      });
    }
    for (name in added) {
      if (!Object.prototype.hasOwnProperty.call(added, name)) continue;
      if (!out[name]) out[name] = [];
      (added[name] || []).forEach(function (t) {
        if (out[name].map(norm).indexOf(norm(t)) === -1) out[name].push(t);
      });
    }
    out[OWN_CLUSTER] = (settings.customSeeds || []).slice();
    return out;
  }

  /* Every enabled search term, flattened. */
  function allSeeds(settings) {
    var clusters = effectiveClusters(settings);
    var disabled = (settings && settings.disabledClusters) || [];
    var out = [];
    for (var name in clusters) {
      if (!Object.prototype.hasOwnProperty.call(clusters, name)) continue;
      if (disabled.indexOf(name) !== -1) continue;
      out = out.concat(clusters[name]);
    }
    return out;
  }

  var DEFAULT_SETTINGS = {
    enabled: true,
    cutoffYear: 2009,
    strict: true,
    killShorts: true,
    searchOldOnly: true,
    blockWatchPage: true,
    allowEscapeHatch: true,
    takeOverHome: true,
    // YouTube's own related list stays, filtered by the wall; underneath it
    // goes a section of old videos found by searching for what the video is
    // about (see src/background/related.js).
    sidebarRelated: true,
    autoplayFromPool: false,
    channelPagesUnfiltered: true,
    subsUnfiltered: true,

    crawlEnabled: true,
    crawlPerMinute: 4,
    crawlDailyCap: 500,
    crawlOnlyWhenIdle: true,
    crawlPlaylists: true,
    seedSearches: true,

    learnInterests: false,
    aiExpansion: false,
    aiProvider: 'gemini',
    geminiModel: 'gemini-3.5-flash',
    aiModel: 'claude-haiku-4-5',

    disabledClusters: [],
    removedSeeds: [],
    addedSeeds: {},
    customSeeds: [],
    hiddenChannels: [],
    poolTarget: 20000,

    showYearBadge: true,

    settingsVersion: 3
  };

  var api = {
    SEED_CLUSTERS: SEED_CLUSTERS,
    OWN_CLUSTER: OWN_CLUSTER,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    effectiveClusters: effectiveClusters,
    allSeeds: allSeeds,
    norm: norm
  };

  root.RTSeeds = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
