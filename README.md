# optima time machine

YouTube, frozen in the year you pick. A browser extension for Chrome, Brave and Edge that keeps
everything uploaded after your cutoff (2009 by default) off the homepage, out of the sidebar and out of
search, and fills the gaps with old videos it finds for you. No account, no tracking, nothing sent to us.

Part of [optima machina](https://optimamachina.world): small tools that want nothing from you.

---

## install

1. Download `Optima-Time-Machine-<version>.zip` and unzip it somewhere you'll keep it (not Downloads:
   the browser loads it from wherever it sits, and moving it later breaks it).
2. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder, the one with `manifest.json` directly inside.
5. Reload any YouTube tab that was already open.

Chrome, Brave or Edge 111 or newer. It isn't on the Chrome Web Store yet, which is why it goes in this way.

To update: replace the folder's files with the new version, then click the reload arrow on the
extension's card and reload your YouTube tabs. Your settings and the videos it has found stay.

## what it does

- **the wall**: modern videos never reach the page. YouTube's own data is filtered before YouTube draws
  it, so there's no flicker and no gaps. Shorts, livestreams, mixes and ads in the feed go too.
- **search**: every search quietly gets YouTube's own `before:` filter, so results are old videos, not
  today's videos with most of them hidden.
- **the homepage**: rebuilt from old videos the extension has found, with no ranking by what you watch.
- **the sidebar**: the old videos from YouTube's own related list, then more found by searching the old
  years for the video's title, tags and channel.
- **autoplay** stays in the old years.
- **a cover** over the player if a newer video slips through (a link from outside, a playlist), with an
  optional "watch it anyway".
- **channel pages and subscriptions** can show every year, so you can see whether someone posted again.

Everything is in the settings page (the extension's toolbar button, then **settings**).

## privacy

- No account, no analytics, no telemetry, no server of ours. Nothing is ever sent to optima machina.
- Everything the extension collects and learns (the pool of old videos, your settings, hidden channels)
  stays in your browser's own storage. Uninstalling deletes it.
- The searches it makes on its own (the sidebar, background collecting) go to YouTube **anonymously**:
  no cookies, no sign-in header, no visitor id, a fixed generic client description. YouTube sees a
  logged-out visitor, so none of it lands in your history or shapes your recommendations.
- Only the actions you click yourself, **save to watch later** and **save to playlist**, go to YouTube
  as you, because that's the only way they can work.
- **Learning from what you watch is off** by default. When on, it counts words from titles you watch,
  on your computer only.
- The optional **AI suggestions** are the one feature that sends anything elsewhere, and only if you
  switch them on and give your own key. They send the cutoff year and up to 30 of the learned words to
  the provider you picked (Google Gemini or Anthropic). Never titles, channel names, video ids or
  anything about you. The extension can't reach those servers at all until you allow it.

## security

Audited 2026-10-09. What it guards:

- **API keys** are kept in their own slot in the extension's local storage, apart from the settings that
  the scripts on YouTube's pages read. Only the settings page and the background worker ever touch them.
  They are never synced, logged, put in a URL or written into the page. "forget my keys" removes them.
- **Network access** is limited to youtube.com. The AI providers are optional permissions, granted only
  when you switch the feature on and removed when you switch it off. The extension's own pages run under
  a strict Content-Security-Policy: only their own scripts, no plugins, no inline code, and the only
  outside servers they may contact are those two AI providers.
- **Anything that comes from a YouTube page is checked** before the extension keeps it, because any
  script on youtube.com could have written it: video ids must be real ids, text is length-capped,
  numbers must be numbers, and thumbnails may only come from YouTube's image servers.
- **The YouTube-page bridge** only makes the few kinds of request the extension needs (search, related
  videos, browse), always anonymously; signed-in requests are limited to saving to a playlist.
- **No `innerHTML`, `eval` or remote code** anywhere: everything shown is built as plain text, and no
  code is ever downloaded.
- No web-accessible resources, so websites can't probe for the extension's files.

Known limits: the scripts on YouTube's pages read your cutoff year from the page's own storage (it has
to be there before YouTube's first line of code runs), so YouTube's scripts could see that the
extension is installed and which year you picked. Keys sit unencrypted in the browser profile, like any
saved password in an extension; anyone with access to your computer's profile could read them.

### permissions, and why

| permission | why |
|---|---|
| youtube.com | to filter YouTube's pages and run the searches for old videos |
| storage, unlimitedStorage | to keep your settings and the pool of old videos on your computer |
| alarms, idle | to collect slowly in the background, by default only while you're away |
| scripting | to reconnect to YouTube tabs that were open when the extension was updated |
| generativelanguage.googleapis.com, api.anthropic.com (optional) | only for the AI suggestions, only after you allow it |

## if something looks wrong

- **Modern videos showing up, or the sidebar empty**: reload the tab first. YouTube changes its insides
  every few months; when it does, filtering can break until the extension is updated.
- **A page freezes** ("Page Unresponsive"): seen only with uBlock Origin / uBlock Origin Lite / Brave
  Shields running on YouTube at the same time, in older versions that rewrote YouTube's watch-page data.
  Since 1.3.0 watch pages are left untouched, and it hasn't come back so far. If it still happens,
  pause the ad blocker on youtube.com and tell us.
- **The pool stays at zero**: open youtube.com once and leave a tab open; collecting borrows it.
- On any YouTube page, `__rtStats()` in the console (`Ctrl+Shift+J`) shows what has been kept and removed.
- English YouTube only: dates are read from "14 years ago", so set YouTube's language to English.

## how it's made

Plain JavaScript, no dependencies, no build step. `src/inject/interceptor.js` runs inside YouTube's page
before YouTube does and filters its data; `src/content/feed.js` draws the homepage and sidebar;
`src/background/` collects, ranks and searches. `AGENTS.md` has the technical notes.
`tools/make-icon.js` draws the icon (`node tools/make-icon.js`).
`tools/package.py` builds the release zip and its checksum (`python tools/package.py`).

Ingredients: the code was written with Claude; the idea, every design decision and the testing by a
human.

## license

[MIT](LICENSE). Inter (`ui/fonts`) is under the SIL Open Font License, see `ui/fonts/inter.LICENSE.txt`.
