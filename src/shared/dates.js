/* Time Machine for YouTube — relative date handling.
 *
 * YouTube almost never hands out an absolute upload date in feed payloads.
 * It gives you "14 years ago" — or, since the lockup redesign, "14y ago" with
 * the long form tucked into an accessibility label. Every date we work with
 * is therefore a range, not a point: "1 year ago" means somewhere between 12
 * and 24 months back.
 *
 * We track both ends of that range so the wall can be conservative on
 * purpose — a video is only allowed through if even its *newest possible*
 * upload date sits at or before the cutoff.
 */
(function (root) {
  'use strict';

  var UNIT_MS = {
    second: 1000,
    minute: 60000,
    hour: 3600000,
    day: 86400000,
    week: 604800000,
    month: 2629800000,
    year: 31557600000
  };

  var UNIT_ALIAS = {
    s: 'second', sec: 'second', second: 'second',
    m: 'minute', min: 'minute', minute: 'minute',
    h: 'hour', hr: 'hour', hour: 'hour',
    d: 'day', day: 'day',
    w: 'week', wk: 'week', week: 'week',
    mo: 'month', month: 'month',
    y: 'year', yr: 'year', year: 'year'
  };

  // "14 years ago", "Streamed 3 months ago", "1mo ago", "14y ago".
  // English UI only — noted in the README.
  var AGO_RE = /(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mo|years?|yrs?|[smhdwy])\s+ago\b/i;

  function parseRelative(text, now) {
    if (!text || typeof text !== 'string') return null;
    var m = text.match(AGO_RE);
    if (!m) return null;

    var n = parseInt(m[1], 10);
    var raw = m[2].toLowerCase().replace(/s$/, '');
    // "mins" -> "min", but "s" alone must survive the plural strip.
    if (raw === '') raw = 's';
    var unit = UNIT_ALIAS[raw];
    var step = UNIT_MS[unit];
    if (!step || !isFinite(n)) return null;

    now = now || Date.now();

    // "n years ago" is displayed for anything in [n, n+1) years old.
    var newest = now - n * step;
    var oldest = now - (n + 1) * step;

    return {
      unit: unit,
      amount: n,
      newest: newest,
      oldest: oldest,
      estimate: Math.round((newest + oldest) / 2),
      newestYear: new Date(newest).getFullYear(),
      oldestYear: new Date(oldest).getFullYear()
    };
  }

  function yearOf(ts) {
    return new Date(ts).getFullYear();
  }

  /* Verdict for a single video against the wall.
   *
   *   'pass'      — definitely at or before the cutoff
   *   'block'     — definitely after the cutoff
   *   'uncertain' — the display string straddles the cutoff boundary
   *   'unknown'   — no parseable date at all
   */
  function verdict(relativeText, cutoffYear, now) {
    var r = parseRelative(relativeText, now);
    if (!r) return { state: 'unknown', info: null };

    if (r.newestYear <= cutoffYear) return { state: 'pass', info: r };
    if (r.oldestYear > cutoffYear) return { state: 'block', info: r };
    return { state: 'uncertain', info: r };
  }

  /* strict=true  → uncertain and unknown are dropped (a true hard wall)
   * strict=false → uncertain is kept, unknown is kept */
  function allowed(relativeText, cutoffYear, strict, now) {
    var v = verdict(relativeText, cutoffYear, now);
    if (v.state === 'pass') return true;
    if (v.state === 'block') return false;
    return !strict;
  }

  var api = {
    parseRelative: parseRelative,
    verdict: verdict,
    allowed: allowed,
    yearOf: yearOf,
    AGO_RE: AGO_RE,
    UNIT_MS: UNIT_MS
  };

  root.RTDates = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
