# Load harness and mock providers

`node tools/load/run.mjs --users 300` pushes N test accounts through a **local copy** of Gen with every paid or GPU
provider replaced by an instant stand-in, and prints a pass/fail table. It spends $0 and touches no RunPod, Modal or fleet.

## Mock providers: `HAWKESGEN_MOCK_PROVIDERS=1` (`src/mockproviders.ts`)
- Every tool whose provider is `comfy` (GPU), `elevenlabs`, `anthropic` or `gemini` runs on the local lane and emits a tiny
  real file (8x8 PNG, a quarter-second WAV, an empty GLB, a stub MP4) or a mock result, with usage `mock` at $0.
  `ask()` (Claude) answers `mock answer` (`{}` for schema calls). Wiring: `reloadTools()` in `src/tools/index.ts`.
- Pipelines (asset.make, make.checked) run unchanged; their child jobs are the mocked ones. Library, queue, credits,
  events and routes are the real code.
- **Impossible on live.** Honoured only when `HAWKESGEN_LANE` is `beta`, `dev`, `local` or `test`, and (except beta) only on
  loopback. Unset or `live` lane: `server.ts` refuses to start with the flag set, and `mockProvidersOn()` is false anyway.
  `test/mockproviders.test.ts` covers both, and that with the flag unset tools are untouched.
- `GET /v1/health` carries `mock: { providers, flagRefused, realCost, realCostRows }` (real spend recorded since boot,
  usage rows other than `mock`) and `process: { pid, startedAt, rssMb, heapMb }`.

## The harness (`tools/load/run.mjs`)
Starts its own copy (scratch data folder, free port, lane `local`, test sign-in on, big starter credits, no provider keys),
signs in `--users` accounts with `POST /v1/users/test-session`, holds `GET /v1/events` for each, and submits mock jobs at
`--rate` per user per second (default 0.2) for `--duration` seconds (20). Options: `--storms signup,uploads,restart`
(default all), `--p95-ms`, `--lag-ms`, `--rss-mb`, `--drain`, `--keep`.
- Storms: **sign-up burst** (all accounts at once), **20 parallel uploads** (2 MiB blobs), **mid-run restart** (SIGTERM, start
  again; streams reconnect, queued jobs must still finish).
- Table: p50/p95/p99 per route, 429 and 5xx counts, connection errors, peak memory, worst event-loop lag, starts/pids,
  jobs finished, streams that heard their jobs, real cost.
- It aborts (exit 2) if health shows the live lane, mocks off, or any real provider cost; refuses a non-local `--url`.
  Exit 0 all passed, 1 a check failed.
- **No timers in the product:** the harness holds streams and samples health every 2 s itself; the app gains none.

## First findings (300 users, all storms, default rate)
The harness works and it already finds something real: the sign-up burst blocks the event loop for ~6 s (300 sign-ins
took ~12 s, p95 11 s; the rest of the run is fast: POST /v1/jobs p95 ~240 ms, 836 of 836 jobs finished, restart back in
~1.4 s, peak memory 340 MB). So `node tools/load/run.mjs --users 300` currently prints FAIL on the sign-in route and on
event-loop lag; that is the stability item's (i_c8587ff818df) first thing to fix (look at what `googleSignin` does
synchronously per new account), not a harness fault.

## The request limiter (`src/ratelimit.ts`, test `test/ratelimit.test.ts`)
A token bucket per caller and class of route, checked first in `handle` (api.ts), before any routing. Over the limit: `429`,
`Retry-After` (whole seconds) and `{ error, retryAfter }` in plain words; the app already words a 429 (`lib.js friendly`).
| Class | Routes | Burst / per minute |
|---|---|---|
| strict | `/oauth/*`, non-GET `/v1/users/*` (sign-in, sign-up, keys); keyed by address only | 20 / 15 |
| moderate | POST `/v1/jobs`, `/v1/estimate`, `/v1/assistant/*`, `.../assistant` | 60 / 120 |
| standard | every other write under `/v1` | 120 / 600 |
| generous | GET reads, `/v1/events`, GET `/v1/users/*` | 300 / 3000 |
| never | `/v1/health`, `/v1/billing/webhook`, anything outside `/v1` and `/oauth` (the app's files, `/mcp`, `/dl`) | |
- **Who:** the API key or session (hashed, never stored) plus `X-Hawkesgen-Project` (the portal's one key acts for many customers),
  else the address. The address is `clientIp` (analytics/collect.ts): Cloudflare's header only from Cloudflare's ranges,
  `X-Forwarded-For` only from Cloud Run's front end or a loopback proxy. Never a header from a direct connection.
- **Tune:** `settings.rateLimit` `{ enabled, strict|moderate|standard|generous: { burst, perMinute } }`; `HAWKESGEN_RATELIMIT=off`.
- **One instance:** buckets live in memory, so they reset on restart and are per instance (Gen runs one).
- **Harness:** each load user gets its own address (`X-Forwarded-For`, trusted on loopback), and the `limits` storm hammers
  sign-in from one address (expects 429 + Retry-After) and `/v1/health` (expects none). Those calls are not in the route table,
  so "429s under 1%" still judges normal use.
