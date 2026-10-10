/* Time Machine for YouTube — turning a pool into a feed.
 *
 * The pool is a bag of thousands of videos. What makes it feel like a feed
 * rather than a shuffle is the blend:
 *
 *   graph centrality — how many different related-lists a video turned up in
 *   taste match      — overlap with words that recur in things you watched
 *   freshness to you — never shown beats shown once beats shown ten times
 *   noise            — a deliberate slice of pure chance, so it can't collapse
 *                      into showing you the same forty videos forever
 *
 * Then a page is diversified: one video per channel, a few per search or
 * playlist, and no single title word more than a handful of times. A
 * channel with four hundred episodes in the pool gets one slot per screen
 * like everyone else.
 */
(function (root) {
  'use strict';

  var Taste = root.RTTaste;

  /* Only terms that recur across several watched videos count as taste. One
   * watch of an emo hair tutorial should not turn the feed into hair. */
  function buildTasteIndex(taste) {
    var idx = Object.create(null);
    var terms = taste && taste.terms ? taste.terms : {};
    var df = taste && taste.df ? taste.df : {};
    var max = 1;
    var k;
    for (k in terms) {
      if ((df[k] || 0) < Taste.MIN_VIDEOS) continue;
      if (terms[k] > max) max = terms[k];
    }
    for (k in terms) {
      if ((df[k] || 0) < Taste.MIN_VIDEOS) continue;
      idx[k] = terms[k] / max;
    }
    return idx;
  }

  function tasteScore(video, idx) {
    if (!idx) return 0;
    var words = Taste.tokenize(video.title);
    if (!words.length) return 0;
    var total = 0;
    for (var i = 0; i < words.length; i++) {
      if (idx[words[i]]) total += idx[words[i]];
      if (i < words.length - 1) {
        var bg = words[i] + ' ' + words[i + 1];
        if (idx[bg]) total += idx[bg] * 1.5;
      }
    }
    return Math.min(total / 3, 1);
  }

  function score(video, idx, now) {
    var degree = Math.log1p(video.degree || 1) / Math.log(12); // saturates ~12
    var taste = tasteScore(video, idx);

    var shown = video.shown || 0;
    var freshness = 1 / (1 + shown * 1.4);

    // Something shown a while ago is fair game again.
    var rested = video.lastShown ? Math.min((now - video.lastShown) / (72 * 3600000), 1) : 1;

    var noise = Math.random();

    return (
      degree * 0.22 +
      taste * 0.30 +
      freshness * 0.20 +
      rested * 0.08 +
      noise * 0.20
    ) - (video.watched ? 0.35 : 0);
  }

  function channelKey(v) {
    return v.channelId || (v.channel ? Taste.tokenize(v.channel).join(' ') || v.channel : null);
  }

  /* Batch sources — one search, one playlist, one related list — are the
   * ones that flood a page with twenty near-identical results. */
  function batchSource(v) {
    var s = v.source || '';
    return /^(seed|playlist|graph):/.test(s) ? s : null;
  }

  function diversify(sorted, limit, caps) {
    caps = caps || {};
    var maxPerChannel = caps.channel || 1;
    var maxPerSource = caps.source || 3;
    var maxTokenRepeat = caps.token || 3;

    var out = [];
    var overflow = [];
    var perChannel = Object.create(null);
    var perSource = Object.create(null);
    var tokenSeen = Object.create(null);

    for (var i = 0; i < sorted.length && out.length < limit; i++) {
      var v = sorted[i];
      var ck = channelKey(v);
      var sk = batchSource(v);
      var words = Taste.tokenize(v.title);

      var repeat = 0;
      for (var w = 0; w < words.length; w++) {
        if ((tokenSeen[words[w]] || 0) > repeat) repeat = tokenSeen[words[w]];
      }

      if ((ck && (perChannel[ck] || 0) >= maxPerChannel) ||
          (sk && (perSource[sk] || 0) >= maxPerSource) ||
          repeat >= maxTokenRepeat) {
        overflow.push(v);
        continue;
      }

      if (ck) perChannel[ck] = (perChannel[ck] || 0) + 1;
      if (sk) perSource[sk] = (perSource[sk] || 0) + 1;
      for (var t = 0; t < words.length; t++) tokenSeen[words[t]] = (tokenSeen[words[t]] || 0) + 1;
      out.push(v);
    }

    // Only when the pool is too small to fill a page do the capped ones
    // come back, and even then a channel gets at most a few.
    var relaxed = Object.create(null);
    for (var j = 0; j < overflow.length && out.length < limit; j++) {
      var o = overflow[j];
      var okey = channelKey(o) || '?';
      if ((relaxed[okey] || 0) >= 3) continue;
      relaxed[okey] = (relaxed[okey] || 0) + 1;
      out.push(o);
    }
    return out;
  }

  function rankFeed(videos, taste, options) {
    options = options || {};
    var limit = options.limit || 40;
    var idx = buildTasteIndex(taste);
    var now = Date.now();

    var scored = videos
      .filter(function (v) {
        if (options.excludeId && v.id === options.excludeId) return false;
        if (options.excludeIds && options.excludeIds.indexOf(v.id) !== -1) return false;
        if (options.maxYear && v.year && v.year > options.maxYear) return false;
        return true;
      })
      .map(function (v) {
        return { v: v, s: score(v, idx, now) };
      })
      .sort(function (a, b) { return b.s - a.s; })
      .map(function (x) { return x.v; });

    return diversify(scored, limit, { channel: 1, source: 3, token: 3 });
  }

  /* Sidebar wants things adjacent to what's playing, not a fresh feed.
   *
   * Best evidence of adjacency is YouTube's own word: a pool entry first
   * seen in this video's related list. Then the same channel, then title
   * overlap. Videos already on screen in YouTube's list are excluded. */
  function rankRelated(videos, current, taste, options) {
    options = options || {};
    var limit = options.limit || 20;
    var idx = buildTasteIndex(taste);
    var now = Date.now();
    var exclude = Object.create(null);
    (options.excludeIds || []).forEach(function (id) { exclude[id] = true; });

    var currentWords = current ? Taste.tokenize(current.title) : [];
    var wordSet = Object.create(null);
    currentWords.forEach(function (w) { wordSet[w] = true; });
    var neighbourTag = current && current.id ? 'graph:' + current.id : null;
    var currentChannel = current ? channelKey(current) : null;

    var scored = videos
      .filter(function (v) {
        return (!current || v.id !== current.id) && !v.watched && !exclude[v.id];
      })
      .map(function (v) {
        var overlap = 0;
        var words = Taste.tokenize(v.title);
        for (var i = 0; i < words.length; i++) if (wordSet[words[i]]) overlap++;
        var neighbour = neighbourTag && v.source === neighbourTag ? 0.6 : 0;
        var sameChannel = currentChannel && channelKey(v) === currentChannel ? 0.25 : 0;
        var adjacency = neighbour + Math.min(overlap / 4, 1) * 0.45 + sameChannel;
        // Generic feed/search entries are useful only as a fallback. A video
        // harvested from this video's own related response is much stronger
        // evidence of relevance and should dominate the sidebar.
        var sourceBoost = neighbour ? 2.5 : 0;
        return { v: v, s: sourceBoost + adjacency + score(v, idx, now) * 0.55 };
      })
      .sort(function (a, b) { return b.s - a.s; })
      .map(function (x) { return x.v; });

    // The sidebar is meant to be adjacent, so it may share more words.
    var related = scored.filter(function (x) { return neighbourTag && x.v.source === neighbourTag; });
    var pool = related.length >= Math.min(limit, 8) ? related : scored;
    return diversify(pool, limit, { channel: 5, source: 12, token: 10 });
  }

  var api = {
    rankFeed: rankFeed,
    rankRelated: rankRelated,
    score: score,
    buildTasteIndex: buildTasteIndex
  };

  root.RTRank = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
