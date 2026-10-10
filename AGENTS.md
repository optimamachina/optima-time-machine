# AGENTS.md

Technical notes for **Optima Time Machine**, a Manifest V3 extension for Chrome, Brave and Edge that
makes YouTube behave as if frozen at a cutoff year (default 2009). User-facing docs are in `README.md`;
the look follows the Optima Machina design language (`ui/optima.css`, lowercase words, one blue).

## layout

```text
manifest.json
src/
  inject/interceptor.js  MAIN world, document_start: wraps fetch/XHR, filters YouTube's JSON,
                         reads watch pages (read-only), in-page navigation for our cards
  shared/dates.js        "14 years ago" -> a date range -> pass / block / uncertain / unknown
  shared/extract.js      renderer-independent card extraction (videoRenderer, lockupViewModel, ...)
  shared/seeds.js        default settings and starter search terms
  content/bridge.js      isolated world, document_start: settings mirror, page <-> worker relay,
                         YouTube requests for the worker (anonymous) and for saving (signed in)
  content/feed.js        homepage grid, watch-page sidebar, block screen, autoplay, watchdog
  content/feed.css       what the extension draws inside YouTube (follows YouTube's light/dark)
  background/sw.js       service worker: message router, validation, settings migration, alarms
  background/db.js       IndexedDB: videos (the pool), frontier, edges, related cache
  background/crawler.js  rate-limited background collecting
  background/innertube.js YouTube requests through an open tab; reap() = extract + the wall
  background/related.js  sidebar: before:-limited searches for title, topic and channel
  background/rank.js     homepage ranking and diversification (no watch-history input unless learning is on)
  background/taste.js    optional interest learning and optional AI search-term suggestions
ui/                      popup, settings page, optima.css, Inter, the logo
icons/                   toolbar icons; tools/make-icon.js draws them (a blue play button pressed into plastic)
```

## how YouTube loads pages (verified September 2026)

| navigation | request | notes |
|---|---|---|
| full page load | none | `ytInitialData` / `ytInitialPlayerResponse` inlined; caught by property setters |
| click to a watch page | `POST /youtubei/v1/get_watch` | streamed JSON array `[{playerResponse}, {watchNextResponse}]` |
| more sidebar / comments | `POST /youtubei/v1/next` with a continuation | `appendContinuationItemsAction.targetId`: `watch-next-feed` or `comments-section` |
| home / channel / subscriptions | `POST /youtubei/v1/browse` | sent before the address bar changes; zone comes from `browseId` in the body |
| search | `POST /youtubei/v1/search` | rewritten with `before:<cutoff+1>` before sending |
| previews, miniplayer | `POST /youtubei/v1/player` | read only when the id matches the page's video |

`yt-navigate` dispatched on `ytd-app` from the MAIN world performs an in-page navigation (our cards post
a `navigate` message to the interceptor). The page can contain two `#related` containers; YouTube moves
its list between them, so `feed.js` follows the parent of `ytd-watch-next-secondary-results-renderer`.

## watch pages are read-only

Editing YouTube's watch-page data (removing sidebar cards, autoplay targets, menu items) made pages lock
up — a pinned CPU core, gray or unclickable tab, DevTools unable to pause — whenever an ad blocker
(uBlock Origin, uBlock Origin Lite, Brave Shields) was editing the same data. Neither extension alone
did it, and with our hooks installed but changing nothing it never happened. So:

- `get_watch`, `next` and the initial watch `ytInitialData` reach YouTube exactly as sent. A copy is read
  (`observeWatch`) for: the old videos in YouTube's related list (announced as `watchNext`), where
  autoplay is headed, and the player's exact date and tags (`player`).
- `feed.js` draws its own sidebar (`#rt-related`) next to YouTube's list and sets `html[data-rt-sidebar]`
  only while it is on the page; `feed.css` hides YouTube's list under that flag. If ours fails, YouTube's
  list shows rather than nothing. YouTube's old picks are mixed in at most four, every third place,
  because signed in they are personalised from watch history.
- Autoplay: on `ended`, if YouTube's autoplay is on and its target isn't old, the first video in our
  sidebar plays instead (skipped for ads).
- Search, home, channel and subscription payloads are still filtered in place (`filterPayload`); those
  were never implicated.

## the sidebar's related videos

`related.js` runs three searches with `before:<cutoff+1>`: the cleaned title, a topic query (title words,
up to two tags, a genre word from the category, minus words spelling the channel name) and the channel
name. Results pass the wall (`Innertube.reap`), go into the pool, come back out through the pool's own
records (so hidden videos/channels stay hidden), and are interleaved title/topic/channel/edges with
channel caps. Cached per video (5 days) and per channel (7 days); a separate 400-a-day allowance; never
while YouTube has asked the collector to back off.

## privacy and security rules (audited 2026-10-09)

- Requests the extension makes on its own are **anonymous**: `bridge.js` `ytFetch(msg, false)` sends no
  cookies (`credentials: 'omit'`), no SAPISIDHASH, no visitor id, and `innertube.js` sends a minimal
  context (`WEB`, client version, `hl: en`, `gl: US`). Only `__rtYt` (save to watch later / playlist,
  user-initiated) is signed in, and only for `browse/edit_playlist` and `playlist/get_add_to_playlist`.
- The bridge's worker channel only accepts `search`, `next`, `browse`.
- API keys live in `chrome.storage.local` under `aiKeys`, never in `settings` (which content scripts read
  and several places rewrite whole). `sw.js` migrates old keys out of `settings`; `options.js` saves
  settings with keys stripped.
- AI hosts are `optional_host_permissions`, requested when the feature is switched on (or "ask now"),
  removed when switched off; `taste.js` refuses to call without the permission. The prompt contains the
  cutoff year and learned words only.
- Everything arriving from a page is validated in `sw.js` (`cleanRecord`, `cleanPlayer`) and
  `innertube.setCredentials`; thumbnails must be on `i*.ytimg.com` / `yt3.ggpht.com` (also enforced
  when drawing).
- Extension pages: CSP `default-src 'self'`, `connect-src` only the two AI hosts, no inline script,
  no web-accessible resources. No `innerHTML` or `eval` anywhere.
- Learning from watches is off by default (settings v3 migration also cleared old tallies).

## development

- No build step. Load the folder unpacked; after changing content scripts, reload the extension and
  the YouTube tab.
- `__rtStats()` in a YouTube tab's console shows filter counts. `localStorage.__rt_off = 'feed,filter'`
  (parts: guards, fetch, xhr, getwatch, filter, feed, related) switches parts off for bisecting; remove
  it afterwards.
- Preserve the interceptor's time budget and bounded recursion, the crawler's pacing and budgets, and
  the anonymous/signed-in split. When changing watch-page UI, account for in-page navigation and
  YouTube replacing containers; initialisation must not depend on one selector.
- Relative dates are parsed in English only; the extension's own requests always ask for English.
- Release: bump `version` in `manifest.json`, then `python tools/package.py` writes
  `releases/Optima-Time-Machine-<version>.zip` and `.sha256` (same source, same checksum).
