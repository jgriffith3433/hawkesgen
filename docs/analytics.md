# Analytics: the contract

Hawkes Gen's own player analytics, part of its SDK and API. Every product's pages send events to
`POST /v1/analytics/collect`; Gen stores them in its own database (`.data/analytics.db`), adds where and on what the
player is, and answers questions about them on `GET /v1/analytics/...`: where players drop off and why, what they like
and don't, which browsers and places they come from, and how one build compares with the next. No third party sees
anything. Code: `src/analytics/`. Registry: `analytics/products.json`. Tests: `test/analytics.test.ts`.

This page is the contract the JS SDK, the Unity bridge and the products build against. Field names are exact.
The SDK itself: `clients/js/hawkes-analytics.js` (quick start just below), tested in `test/analytics-sdk.test.ts`.
**Its home is its own public repo, [jgriffith3433/hawkes-analytics](https://github.com/jgriffith3433/hawkes-analytics)
(since 2026-11-01):** the browser SDK, the npm loader `@hawkesgen/analytics` and the Unity package, released by tag
(`v1.<SDK version>.<patch>`). Edit them there; `node tools/sync-analytics-sdk.mjs <tag | beta>` brings Gen's copy in
`clients/` (the one Gen serves) up to a release. Studio's Hawkes Analytics plugin installs from that repo.

## Quick start

### A web page or web game

One script tag, in every page of the product (game pages and website pages alike):

```html
<script src="https://hawkesgen.ai/sdk/analytics@1.js" data-product="phorigins" data-build="0.9.1" defer></script>
```

- `data-product` (required: the id in `analytics/products.json`), `data-build` (a version string), `data-endpoint`
  (default `https://hawkesgen.ai/v1/analytics/collect`), `data-debug="1"`.
- Or set `window.HAWKES_BUILD = { version, commit, date }` before it (it wins over `data-build`), or call
  `hawkesAnalytics.init({ product, build, endpoint, debug, context })` yourself.
- **Always load it from Gen; never keep a copy** (J, 2026-10-27): a Gen deploy then updates every site at once, and the
  bot rules stay the same everywhere. Every product does (DoD, PH Origins and Imagine Live TV dropped their copies).
  A bundled game puts the tag in its HTML before its module (no `data-product`) and calls
  `hawkesAnalytics.init({ product, build })`; until the SDK loads, push calls into `window.hawkesAnalyticsQ` as
  `[method, ...args]` (the SDK runs them when it arrives), so the game never depends on Gen (PH Origins'
  `src/game/analytics.ts` `sdk()`). Copy only the `.d.ts` for the compiler. Breaking changes ship as `analytics@2.js`.

That alone gives page views (SPA route changes too), sessions, active time, referrer and UTM, the device, load
timings (`page_load`: ttfb, dom, load), errors and unhandled rejections (once per signature), fps per active minute
(`perf`), outbound links (`outbound`), rage clicks (`rage_click`), and an `exit` snapshot when the page hides.

What the game adds (all optional; none of them ever throws):

```js
const a = window.hawkesAnalytics;
a.loadStart();                           // game_load_start: the engine starts loading
a.ready();                               // game_ready: the player can play (ms since loadStart, else since navigation)
a.screen('title');                       // screen
a.setContext({ mode: 'story', character: 'susan' });   // copied onto every event; null removes a key
a.levelStart(2);                         // level_start (attempts counted); sets ctx.level
a.death('imp', { where: 'bridge' });     // death; counted into the open level
a.levelEnd(2, 'complete', { score: 10 }); // level_end with duration (s) and deaths
a.choice('door', 'left');  a.feature('rewind');  a.video('intro', 'skip', 3.2);
a.feedback({ rating: 4, text: 'fun', context: 'level 2' });
a.frustration('out_of_credits', { route: '/v1/jobs' });   // something got in the player's way
a.engage('drive', 60);                  // seconds spent on an activity since its last engage
a.identify('usr_0123456789abcdef');     // the site's own account id (null on sign-out)
a.activity();                           // input the SDK can't see (a game in a sandboxed iframe)
a.track('shop_purchase', { item: 'boots' });   // custom: ^[a-z][a-z0-9_]{1,39}$
a.error(err, 'asset');
```

**The feedback card** (`ask`): a small, dismissible card in the corner (thumbs or 1–5 stars, an optional comment),
keyboard and touch friendly, in a shadow root so the page's CSS can't touch it, and keys typed in it don't reach the
game. Call it at a natural pause (after a level, on a death screen, at the end of a story branch), **never mid-play**.
Each `id` shows at most once per session, and not again for 7 days after the player closes it. It resolves with the
answer (or `null`) and sends a `feedback` event.

```js
const answer = await hawkesAnalytics.ask({ id: 'after-level-2', question: 'How was that level?', context: 'level 2',
  kind: 'stars', comment: true, theme: { background: '#111', color: '#fff', accent: '#e33', font: 'Georgia', radius: '6px' } });
```

**Accounts (SDK 2):** `identify(id)` ties the sessions from then on to the site's own account id (4–64 of
`A-Z a-z 0-9 _ -`; never an email or a name), remembered in `localStorage` (`hawkes.user`) until `identify(null)`.
Each batch then carries `user`, the session row keeps it (`user_id`), and the `accounts` route answers per account.
A page with no storage of its own (a sandboxed iframe) can be given both ids: `init({ anon, user })`.

**Identity and flags:** an anonymous random id in `localStorage` (`hawkes.anon`, with `hawkes.first` and
`hawkes.visits`); no cookies, no fingerprinting. The session lives in `sessionStorage` (a reload continues it, a new
tab or 30 idle minutes start a new one). `env` comes from the hostname. **A person, not a bot (SDK v3):** active time
starts with the first real input of the session (a trusted pointer, touch, key, wheel or mouse move; events a page
script dispatches don't count, and neither does showing the tab before then), sent once as `first_input`; `activity()`
counts as one (a sandboxed frame's forwarded input). `flags.automation` names what browser automation left on the page
(Playwright's, Selenium's or PhantomJS's globals, ChromeDriver's `cdc_` keys, a `webdriver` attribute on `<html>`).
The DevTools-protocol probe some vendors use isn't done: it logs to the console and fires for anyone with DevTools
open. `flags.webdriver` is `navigator.webdriver`;
`flags.playtest` is set when the page was opened with `?playtest=`/`?hawkesPlaytest` or the runner called
`hawkesPlaytest.start()`. Open any page once with `?hawkes-internal=1` to mark that browser as J's (remembered;
`?hawkes-internal=0` clears it). `hawkesAnalytics.optOut()` / `optIn()` (remembered) stop and restart everything.

**Sending:** batches every 5 s or at 20 events, one session per batch, under 60 KB; `sendBeacon` (text/plain), else
`fetch` with `keepalive`. While offline, or when both fail, batches wait in `localStorage` (`hawkes.outbox`, up to 40
batches / 300 KB) and go on the next visit or when the browser is back online.

**Debug:** `?hawkes-analytics-debug=1` or `init({ debug: true })` logs each event to the console and keeps every
event on `window.hawkesAnalytics.debugLog` (each gets `sent` when its batch goes out), so a playtest can read what
went out.

### A Unity WebGL game

`com.hawkes.analytics` from the hawkes-analytics repo (a runtime package; `com.hawkes.gen` is editor-only). Studio's
Plugins installs it; by hand:

1. `Packages/manifest.json`: `"com.hawkes.analytics": "https://github.com/jgriffith3433/hawkes-analytics.git?path=/Packages/com.hawkes.analytics#v1.3.0"`
   (a git URL pinned to a tag, so cloud builds can fetch it; never a `file:` path on someone's disk).
2. Assets > Create > Hawkes > Analytics Settings, saved as `Assets/Resources/HawkesAnalyticsSettings.asset`; set the
   product. It starts itself when the game boots.
3. Call it from the game:

```csharp
using Hawkes;
HawkesAnalytics.Ready();
HawkesAnalytics.SetContext("character", "susan");
HawkesAnalytics.LevelStart("3");
HawkesAnalytics.Death("imp", new Dictionary<string, object> { { "where", "bridge" } });
HawkesAnalytics.LevelEnd("3", "complete");
HawkesAnalytics.Track("shop_purchase", "{\"item\":\"boots\"}");   // props as a dictionary or a JSON string
HawkesAnalytics.Ask("after-level-3", "How was that level?", "level 3", stars: true);
```

The `.jslib` calls `window.hawkesAnalytics`. If the page hasn't loaded the SDK, it adds the script tag itself
(`sdkUrl` in the settings) with the product, so **the game's website needs no change**; calls made before it loads
are queued (`window.hawkesAnalyticsQ`) and played back. The build is `Application.version`, plus `+v<n>` when the
build was loaded from a `Game/v<n>/` folder, unless the page sets `window.HAWKES_BUILD`. Uncaught exceptions become
`error` events (`source: unity`). In the Editor and outside WebGL nothing is sent (`logOutsideWebGL` logs each
call to the Console).

## Sending events

### The batch

```http
POST https://hawkesgen.ai/v1/analytics/collect
Content-Type: text/plain;charset=UTF-8          (or application/json)

{
  "product": "sickofit",
  "build": { "version": "1.4.2", "commit": "a1b2c3d", "date": "2026-10-18T14:02:00Z" },
  "env": "live",
  "anon": "a_8f3k2j9d0s7x",
  "session": "s_k2j3h4g5f6d7",
  "flags": { "webdriver": false, "playtest": false, "internal": false },
  "device": { "screen": "1920x1080", "lang": "en-US", "tz": "America/New_York", "touch": 0, "gpu": "ANGLE (NVIDIA GeForce RTX 3060 ...)" },
  "entry": { "referrer": "https://www.reddit.com/r/indiegames/", "landing": "/Game/", "utm": { "source": "reddit", "medium": "social", "campaign": "launch" } },
  "events": [
    { "name": "level_start", "seq": 12, "t": 1760796120000, "active": 84000, "page": "/Game/", "screen": "level",
      "ctx": { "level": "2", "mode": "story", "character": "susan" }, "props": { "level": "2" } }
  ]
}
→ 202 { "ok": true, "accepted": 1, "dropped": 0 }
```

| Field | What | Rules |
|---|---|---|
| `product` | The product id in `analytics/products.json` | Unknown products are dropped |
| `build.version` | The build players are on (the game's version string) | ≤ 40 chars |
| `build.commit` | The commit it was built from | 4–40 hex chars |
| `build.date` | When it was built (ISO 8601) | ≤ 40 chars |
| `env` | `live` \| `beta` \| `preview` \| `local`, from the page's hostname | Informational: **the server decides the env from the Origin** (below) |
| `anon` | An anonymous player id: random, kept in `localStorage` (`hawkes.anon`), never tied to a person | 8–64 of `A-Z a-z 0-9 _ -`; required |
| `session` | A random id per session: new after 30 minutes without activity or a new tab | 8–64 of `A-Z a-z 0-9 _ -`; required |
| `user` | The site's own account id (`identify`), when the player is signed in | 4–64 of `A-Z a-z 0-9 _ -`; optional |
| `flags.webdriver` | `navigator.webdriver` | `true` marks the session as a bot |
| `flags.playtest` | Studio's playtests (the page was opened by `playtest.run`: `?hawkesPlaytest`, or `window.hawkesPlaytest` driven by a bot) | `true` marks the session as a bot |
| `flags.internal` | J's own devices: opted in by `localStorage['hawkes.internal'] = '1'` (open a page once with `?hawkes-internal=1`, or the SDK's `internal(true)`) | `true` marks the session internal |
| `device.screen` | `screen.width x screen.height` | `WxH` |
| `device.lang` | `navigator.language` | ≤ 35 chars |
| `device.tz` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | used when the GeoIP has no time zone |
| `device.touch` | `navigator.maxTouchPoints` | iPads that say "Macintosh" become tablets |
| `device.gpu` | The WebGL renderer (`WEBGL_debug_renderer_info`), when the game has a context | ≤ 120 chars |
| `entry` | Where the session came from: `document.referrer`, the landing path, the UTM tags of the landing URL | Send it with the first batch of a session (later batches may repeat it; the first one wins). Same-site referrers count as direct; only host + path are kept |
| `events` | Up to 200 per batch | See below |

Each event:

| Field | What |
|---|---|
| `name` | A standard name (below) or a custom one: `^[a-z][a-z0-9_]{1,39}$` |
| `seq` | 0, 1, 2… per session, never reused. Required: the server ignores a `(session, seq)` it already has, so a retried beacon never counts twice |
| `t` | Client time, ms since the epoch (`Date.now()`) |
| `active` | Active ms in this session so far: time the tab was visible and the player wasn't idle for more than 60 s. Not tab-hidden time |
| `page` | `location.pathname` (the server drops any query or hash) |
| `screen` | What the game shows now (`title`, `menu`, `level`, `cutscene`, `shop`…) |
| `ctx` | The context the game has set (`level`, `mode`, `character`, `difficulty`…): up to 12 keys, plain values, strings ≤ 100 chars. The SDK copies it onto every event |
| `props` | The event's own values (below) |

### Sending

- Batch in memory; send every 5 s while there are events (or at 20 events), and on `visibilitychange` → hidden and `pagehide` with
  `navigator.sendBeacon(url, JSON.stringify(batch))`. A string body goes as `text/plain`, so there's **no CORS
  preflight**. Use `fetch(url, { method: 'POST', body, keepalive: true })` when `sendBeacon` returns false.
- Keep each batch under **64 KB** (bigger ones are refused with 413); split when needed.
- While the tab is visible and the player active, send a `perf` event every minute (it also keeps "active now" right).
- The answer doesn't matter to the page (beacons don't read it). It is `202` with `accepted`/`dropped`, `400` for a
  body that isn't JSON, `413` over 64 KB, `429` over the rate limit. **Never a 5xx**: if Gen fails to store a batch it
  still answers `202 { ok: false }`.

### Limits

| Limit | Value |
|---|---|
| Body | 64 KB |
| Events per batch | 200 (the rest are dropped) |
| Rate, per IP | 60 batches and 1,200 events a minute (then `429` for the rest of the minute) |
| Props | 30 keys per object, keys `^[A-Za-z_][A-Za-z0-9_]{0,39}$`, nesting 3 levels deep, arrays 50 items |
| Strings | 300 chars; `text` 2,000, `message` 1,000, `stack` 4,000 |
| Props size | 4 KB serialized (`exit` and `error`: 16 KB); over it, only the plain values are kept (each ≤ 200 chars) with `_trimmed: true` |
| `ctx` | 12 keys, plain values, strings ≤ 100 |
| Custom event names | 50 distinct per product (`customEvents` in the registry); new names past that are dropped |

Invalid events (a bad name, no `seq`) are dropped one by one; the rest of the batch is kept.

### Origins and envs

CORS answers only the product's registered origins (`analytics/products.json`), and a batch from any other origin is
dropped. The Origin header, not the body, sets the env:

| Origin | env |
|---|---|
| One of the product's `origins` (its live domain, with and without `www.`) | `live` |
| `https://<beta>.hawkesgen.ai` (the product's beta subdomain) | `beta` |
| the same, with pages under `/c/<change>/` | `preview` |
| `http(s)://localhost:<any>` or `127.0.0.1:<any>` | `local` |

Add a product or a domain by editing `analytics/products.json` (re-read on change, no restart). `levels` there sets
the default funnel's order.

## Standard events

| Name | When | Props |
|---|---|---|
| `page_view` | Each page (and each in-app route change) | `title?` |
| `session_start` | The first event of a session | `returning: bool` (the anon id existed) |
| `session_end` | The page hides or closes, or 30 idle minutes end the session | `active` (seconds of active time, not tab-hidden time) |
| `first_input` | The session's first real input (SDK v3), once | `kind` (`pointer`, `touch`, `key`, `wheel`, `mouse`, `forwarded`), `after` (seconds since the page loaded) |
| `game_load_start` | The game starts loading (Unity loader created, engine init) | — |
| `game_ready` | The player can play (title screen interactive) | `ms` (since `game_load_start`). A session with `game_load_start` and no `game_ready` is a player who gave up while loading |
| `screen` | The game changes screen | `name` (also sets the event's `screen`) |
| `run_start` / `run_end` | A run (a campaign, an arcade run, a match) | `run?`, `mode?`; `run_end`: `result` (`win` \| `lose` \| `quit`), `duration` (s), `score?` |
| `level_start` | A level begins (each attempt) | `level` (or `ctx.level`), `attempt?` |
| `level_end` | A level ends | `level`, `result`: `complete` \| `death` \| `quit` \| `restart`, `duration` (s), `deaths`, `score?` |
| `death` | The player dies | `cause` (what killed them: `imp`, `fall`, `timer`), `where` (a named spot) or `x`, `y` (game units) |
| `progress` | Progress inside a level or the game | `step` (a number that only grows), `of?`, `label?` |
| `checkpoint` | A checkpoint is reached | `step`, `label?` |
| `choice` | A choice in dialogue or a branch | `node` (where), `option` (what they picked) |
| `feature` | A feature is used | `name` (`rewind`, a fighter's id, `settings.volume`…), `value?` |
| `video` | A video or cutscene | `action`: `play` \| `complete` \| `skip`, `id`, `at` (seconds into it) |
| `feedback` | The player rates or comments | `rating`: `up` \| `down` or 1–5, `text?`, `context?` (what they rated: `level 2`, `the ending`) |
| `error` | An uncaught error or a failed load | `message`, `stack?`, `source` (`window`, `promise`, `unity`, `asset`) |
| `perf` | Each active minute | `fps` (median in that minute), `fps_p10` (10th percentile), `memory` (MB: `performance.memory` or Unity's), `gpu?` |
| `outbound` | A link off the site | `url` (host + path) |
| `frustration` | Something got in the player's way (SDK 2: `frustration(kind, props)`) | `kind` (`out_of_credits`, `server_error`, `request_failed`, `job_failed`, `assistant_failed`, `assistant_slow`…), `route?` / `page`, anything else. Counted per session with `rage_click` (`sessions.frustrations`) |
| `engage` | Time spent on an activity (SDK 2: `engage(name, seconds)`) | `name` (`play`, `build`, `drive`, `fly`…), `seconds` since the last `engage` of that name (≤ 3,600). Count only active time |
| `exit` | With `session_end` when the page goes away (once per hide that had something new: SDK 2) | `recent` (the last 20 events: `name`, `t`, `screen`, `level`), `state` (the game's `window.hawkesPlaytest.state()`, trimmed to 16 KB), `active` (seconds) |

**Custom events:** any other name that fits `^[a-z][a-z0-9_]{1,39}$` (`shop_purchase`, `fighter_unlock`), with props
within the limits. Prefer a standard event with props (`feature` with `name`) to a new name.

## Server enrichment

- **Place:** country (ISO code), region, city and time zone from the client IP: Caddy's `X-Forwarded-For` when the
  request came through Caddy, else the socket. The free **DB-IP Lite city** database (CC BY 4.0, "IP Geolocation by
  DB-IP", no account or key) is downloaded into `.data/geo/dbip-city-lite.mmdb` on start and refreshed when over a
  month old (`HAWKESGEN_GEO=off` skips it); `src/analytics/mmdb.ts` reads it. DB-IP Lite has no time zones, so the
  browser's `device.tz` fills in.
- **The IP is then thrown away:** never written to the database, a log or an error. The rate limit keys on a hash of it
  with a random salt that lives only in memory.
- **The network** (`net`, `store.ts netOf`): a salted one-way hash of the IP (IPv6: its /64), with a salt that lives
  only in the analytics database. It groups one person's sessions across sites, browsers and private windows (J tests in
  private windows on many devices, where the anon id is new every time) for the players list and "that was me".
- **User agent** (`src/analytics/ua.ts`): browser + version, OS + version, device (`desktop` \| `phone` \| `tablet`),
  and a bot flag: isbot's maintained pattern list (`isbot-patterns.ts`, public domain, copied in) plus ours (crawlers,
  link previews, monitors, headless browsers, HTTP libraries).
- **Server receive time** (`at`) on every event; the client's `t` is kept for durations inside a session.
- **Bots** (`store.ts botVerdict`; the session's `bot` and `bot_reason`). Always a bot: a bot user agent (`user
  agent`), `flags.webdriver` (`webdriver`), Studio's playtests (`playtest`), `flags.automation` (`automation
  (__playwright__binding__)`), an IP in a crawler's published range (`crawler (Googlebot)`: Google's crawlers and
  link-preview fetchers, Bingbot, OpenAI's bots), and J's "not a person" (`marked`). A bot unless a person touched the
  page: an IP in a cloud's published range (`data centre (AWS)`: AWS, Google Cloud, Oracle Cloud, DigitalOcean). The
  session's `first_input` (its `input` column) makes it a person (someone on a VPN on a cloud server); active time
  alone doesn't (SDK v2 counted the first minute after load), and pages on an older SDK never send it, so their cloud
  visits stay bots. The ranges are the owners' own files
  (`datacenter.ts`), downloaded into `.data/geo/datacenter.json` and refreshed daily (`HAWKESGEN_DC=off` turns it
  off); the session keeps which one (`dc`), never the IP. iCloud Private Relay and phone networks aren't in any of
  them. Sessions from before reasons were kept stay as they were.
- **Engaged sessions** (`query.ts ENGAGED`, like GA4's): 10 s or more of active play, or 2 or more pages after a
  first input. Shorter ones are real visits (a bounce, or a game too slow to load) and stay; `engaged=1` keeps only
  engaged ones. Pages on SDK v2 counted the first minute as active, so their engaged sessions are looser.
- **Marks:** `bot` (above) and `internal` (`flags.internal`, or a "that was me" mark on the session's network or anon
  id). Both are left out of every answer unless asked for (`bots=1`, `internal=1`).
- **"That was me" and "not a person"** (`marks` table with `what` me \| bot; `mark` / `unmark`): J marks a network or a
  browser from the players list (Studio's Analytics tab). Every session it matches becomes internal (me) or a bot,
  past and future, and the rollups of those days are redone. Marking a network also marks the anon ids seen on it, so
  those browsers keep the mark on other networks (mobile data). A mark replaces the other kind; unmarking takes the
  anon marks back too, and the sessions are judged again.

## Storage

`.data/analytics.db` (node:sqlite, WAL), apart from the main database:
- `events`: every event (product, session, seq, at, t, name, page, screen, level, active, ctx, props), indexed by
  product + time, product + name + time, product + level + time and session + seq (unique: retries are ignored).
  **Kept 13 months.**
- `sessions`: one row per session, updated as its events arrive: the account (`user_id`), what got in the way (`frustrations`), start and end, active time, events, pages, max
  progress, last screen / level / event, when the open level started, load and ready time, deaths, errors, levels
  completed, the exit snapshot, device (browser, OS, device, screen, language, GPU), place, referrer + landing + UTM,
  build (version, commit, date), env, `bot` and `internal`. Kept forever (the exit snapshot goes after 13 months).
- `daily`: per product, UTC day, env, build and traffic (`human`, `bot`, `internal`): events, sessions and players per
  event name, plus `*` (sessions started, players, active seconds). Recomputed every 10 minutes for today and
  yesterday, and for any day before raw events are purged. **Kept forever.**

## Reading it (Gen key)

Every route takes the filters; `GET` only; the key needs access to the product (`projects` on the key).

| Filter | |
|---|---|
| `range` | `today`, `24h`, `7d`, `14d`, `30d` (default), `90d`, `180d`, `365d` |
| `from`, `to` | ISO dates or ms (override `range`; a `to` date includes that whole day) |
| `env` | `live` (default), `beta`, `preview`, `local`, a comma list, or `all` |
| `build`, `device`, `browser`, `country` | exact match (`country` is the ISO code) |
| `user` | one account (the `identify` id): every section is then just its sessions |
| `bots=1`, `internal=1` | include them (left out by default) |
| `engaged=1` | only engaged sessions (10 s or more of active play, or 2 or more pages) |

Times are UTC. A session belongs to the range it started in; events to the range they arrived in.

| Route | What |
|---|---|
| `GET /v1/analytics/products` | The registry |
| `GET /v1/analytics/overview` | Every product in the registry (even one with no events): `activeNow` (sessions with a batch in the last 5 minutes), `today` / `7d` / `30d` visitors and sessions with `previous` and `trend` (against the period before of the same length), `daily` (30 days), new vs returning visitors, median active seconds, D1/D7 retention, the biggest drop-off, error rate, rating, and whether it is alive: `lastEventAt` (ms, the newest stored event, null when none), `events24h` (events in the last 24 hours from people), `botEvents24h` (events in the last 24 hours from sessions flagged as bots: playtests, crawlers, data centres, automation), `quiet` (true when there was no event in the last 24 hours, human or bot) |

The liveness fields follow the `env` filter (live by default; `env=all` for every env) and leave out J's internal sessions unless `internal=1`. They ignore the range, `build`, `device`, `browser`, `country`, `user` and `engaged` filters, since they are about now. They are read from `events` joined to `sessions` on the events' indexes (`events_time`: a 24-hour range, and the same index backwards for the last event), so the overview stays cheap as the table grows.
| `GET /v1/analytics/:product` | Every section below at once |
| `…/:product/traffic` | Referrers (host, and host + path), UTM source / medium / campaign, landing pages, countries, regions, cities, browsers, OS, devices, screen sizes, languages, time zones: sessions and visitors each |
| `…/:product/sessions` | Length distribution (active time), sessions per player, median and p90 active seconds |
| `…/:product/sessions/list?limit&offset` | The sessions, newest first (anonymous: the anon id, never an IP) |
| `GET /v1/analytics/players?limit&offset` | Admin. Who visits, across products: one row per network (else per anon id, for sessions from before networks were kept) with sessions, engaged sessions, browsers, products, devices, places, accounts, envs, referrers, active seconds, errors, `me` (marked as J), `bot` (marked, or every session a bot) with `botReasons` and `datacenter`. Declared bots (user agent, webdriver, playtests) left out; data-centre, crawler and marked ones kept, internal kept. `real` / `me` / `botRows`, `realSessions`, `engagedSessions`, and `bots`: every bot session in the range by reason |
| `GET /v1/analytics/marks`, `POST /v1/analytics/marks {kind: net\|anon, value, what?: me\|bot, on?, note?}` | Admin. J's "that was me" (`me`, the default) and "not a person" (`bot`) marks; `on: false` (or the older `me: false`) takes one back. Returns how many sessions changed |
| `…/:product/sessions/:id` | One session and its event timeline (`offsetMs` from its first event) |
| `…/:product/retention` | D1/D7/D30 by first-seen week (Monday, UTC) and in total |
| `…/:product/segments` | Who sticks around: players first seen in the range, grouped by their first session (`entry`, `source` (UTM or referrer host), `device`, `input`, `account`, `hadFun` (a `first_fun` event), `played` (the `progress` steps labelled `minutes_played`)), each with players, D1/D7 and the first session's median active time; and `features`: for every `feature` used in a first session, D1/D7 with it against without it and the lift. Small groups are listed with their n |
| `…/:product/funnel?steps=&by=player\|session` | Ordered steps; each step `name[:key=value…]` (`game_ready,level_start:level=1,level_end:level=1:result=complete`; keys are `level`, `screen`, or a prop or ctx key). By default: the registry's `funnel` (a site's own steps, e.g. Hawkes Gen's page_view → signup → job_start → purchase); else `game_ready`, then the registry's `levels`, else the levels players started (most played first), else `progress` steps. Count, `fromPrevious`, `fromStart`, and `biggestLoss` |
| `…/:product/dropoff` | Where sessions end: `beforeReady` (sessions that loaded and gave up, their share, median and p90 wait), `byLevel` (with the median seconds into the level when it was still open), `byScreen`, `byEvent`, `biggest` |
| `…/:product/levels` | Per level: attempts, players, completes, completion rate, quit rate (quits + sessions that ended inside it), restarts, deaths and deaths per attempt, median seconds to complete, median retries before the first win, winners and players who never won |
| `…/:product/deaths` | By cause, by level, by position (`where`, or `x,y` in 5-unit cells), by level and cause |
| `…/:product/features` | Each feature: uses, players, sessions, share of sessions, and the median active time of sessions that used it against those that didn't. Each choice node: options with players and share |
| `…/:product/engagement` | Time per activity from `engage`: seconds, players, accounts, share of players and of active time, median and p90 seconds per player |
| `…/:product/frustration` | What got in players' way: `frustration` events by `kind`, `rage_click` and `error`, each with sessions, players, accounts, share of sessions, the pages, the latest, and `leftAfterRate` (sessions that ended within 2 minutes of it; sessions still going don't count); rage clicks by page and target; the latest 30 |
| `…/:product/accounts?limit&offset` | Signed-in accounts (`identify`), newest first: sessions, browsers, devices, active time, the activities they spend time on (`engage`), the features they used, what got in their way, their latest ratings and their milestones (`signup`, `purchase`, `game_create`… and the registry funnel's steps). `…/accounts/:user` is one, with its sessions |
| `…/:product/feedback` | Average stars, thumbs up/down, the distribution, the latest comments with their context, level, screen and build |
| `…/:product/errors` | Grouped by signature (the message without numbers, ids and URLs, plus the top stack frame): count, sessions and players affected, browsers, builds, sources, first and last seen, a sample. And the error rate (sessions with an error) |
| `…/:product/perf` | Ready rate, ready time p50/p90 overall and by device, fps median / p10 and memory by device and by GPU |
| `…/:product/builds?a=&b=` | Every KPI for two builds side by side (by default the two newest in the range): sessions, players, median active time, ready rate, ready time, error rate, level completion, deaths per session, progress, rating, fps |
| `…/:product/export?what=events\|sessions&format=csv\|json&limit=` | Raw rows (up to 100,000) |
| `…/:product/insights` | The biggest changes against the previous period of the same length, and the worst drop-offs, as sentences with their numbers and sample sizes (`{ kind, text, n, data }`). Nothing is said under the minimum sample: 30 sessions in each period, 20 attempts per level in each period, 20 players at a funnel step, 5 sessions for an error |

### Definitions

- **Visitor / player:** a distinct `anon` id. **New:** first seen (in that env, with the same filters) inside the range.
- **Active time:** the largest `active` the session sent (or `session_end`'s `active`). SDK v3: visible time within
  60 s of a real input, from the first one on.
- **Retention (rolling):** of the players first seen in a cohort whose day *n* has come, the share with a session on
  UTC day *n* after their first day, or later.
- **Funnel:** a player (or session) counts at step *k* if they did steps 1…*k* in that order inside the range.
- **Drop-off:** sessions still active in the last 5 minutes aren't counted. "Before ready": the session sent
  `game_load_start` and never `game_ready`; its wait is its last event's time minus the load start.
- **Retries before the first win:** the level starts a player needed before their first `complete`, minus one.

## The public route (Caddy)

The collect door and the SDK files are public on hawkesgen.ai (`hawkesstudio/deploy/caddyfile.mjs`, the
`@analytics` block, ahead of the sign-in). Gen checks the origin, the size and the rate itself.

**Relays.** A site whose pages can't send themselves (hawkesgen.ai's games run in a sandbox with no origin) sends to
its own server, which passes the batch on to `POST /v1/analytics/relay` (its own route: Caddy drops any key sent to
the collect door) with a Gen key (`Authorization: Bearer hg_…`, never "this machine") and
`X-Hawkes-Relay-Origin` (the page's origin: it sets the env like an Origin header would), `X-Hawkes-Visitor-Ip` (for
the place and the rate limit, then dropped) and `X-Hawkes-Visitor-Ua`. Without a valid key those headers are ignored.

The Caddy block, for reference:

```caddy
	# Player analytics and the SDK files (docs/analytics.md in hawkesgen): public, no login. Gen checks the origin,
	# the size and the rate itself; Caddy passes the visitor's address in X-Forwarded-For (Gen uses it for the
	# country and city, then drops it).
	@analytics {
		path /v1/analytics/collect /sdk/*
	}
	handle @analytics {
		request_body {
			max_size 64KB
		}
		reverse_proxy 127.0.0.1:8790
	}
```

Keep `header_up Authorization` out of this block: the collect door needs no key, and a forwarded key would make the
request an owner's. `/sdk/*` serves the JS SDK (`/sdk/analytics.js`, `/sdk/analytics@1.js`). Until this is deployed,
pages (and Unity games) that load the SDK from Gen get the sign-in page instead of the script: a console error, nothing
sent, the game unaffected. Check with:

```bash
curl -si https://hawkesgen.ai/v1/analytics/collect -H 'Origin: https://sickofitgame.com' -A 'Mozilla/5.0 Chrome/141.0' \
  -H 'Content-Type: text/plain' --data '{"product":"sickofit","anon":"test_anon_1","session":"test_sess_1","flags":{"internal":true},"events":[{"name":"page_view","seq":0}]}'
# → 202 {"ok":true,"accepted":1,...} with Access-Control-Allow-Origin: https://sickofitgame.com
# (curl's own user agent counts as a bot: such sessions show only with bots=1)
```
