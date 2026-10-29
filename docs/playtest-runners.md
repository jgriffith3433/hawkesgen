# Playtest runners: customers' builds, the router, the session protocol

`playtest.run` plays customers' builds as well as the studio's own pages (hawkesstudio `docs/platform-plan.md` 3.3–3.5
and 4.5). Gen is the **conductor**: it takes the build, picks a runner by target, and turns what the runner sends into
the job's result. **Runners** are the machines that play: the browser services we already have (RunPod, Cloud Run L4,
Cloud Run CPU) for pages, and `hawkes-play-native` (Linux + Proton, later Windows) for desktop builds and Electron.

Code: `src/providers/playtester/intake.ts` (builds, SSRF), `runners.ts` (the router), `native.ts` (the session protocol),
`src/tools/playtest.ts` (`admit`, `webRoute`, `runNative`), `server/playtest-cloudrun/site.mjs` (the browser service
serving a build itself). Tests: `test/playtest-intake.test.ts`, the playtest case in `test/tenancy.test.ts`.

## The call

```json
POST /v1/jobs
{ "tool": "playtest.run", "project": "usr_…",
  "params": { "build": "blob:<sha256>", "target": "proton", "exe": "MyGame.exe", "args": ["-screen-fullscreen", "0"],
              "scenario": "smoke", "timeout": 300 } }
```

- `build` (or `url`, the old name, still works for pages):
  - `"blob:<sha256>"` or `"asset:<id>"`: a zip, tar or tar.gz of the build folder (`POST /v1/blobs` first). A customer
    may use only its own uploads or assets it can see (`canUseBlob`, `canProject`); knowing a hash is not access.
  - a URL, or `{ "url": … }`: a hosted page (web), or an archive to download (desktop targets).
  - `{ "github": { "repo": "owner/name", "release": "v1.2" | "latest", "asset"?: <file name> } }`, `{ … "run": <Actions
    run id>, "artifact"?: <name> }` or `{ … "ref": <branch, tag or commit> }`, with `"token"?: <a GitHub token>`.
    Actions artifacts need a token even for public repos.
- `target`: `web` (default) | `electron` | `linux` | `proton` | `windows`.
- `exe`: inside the build, the executable (desktop) or the page (web, default `index.html`). Relative, no `..`.
- `args`: a desktop build's command line (strings, at most 32).

Everything else (`scenario`, `mode`, `options`, `seed`, `speed`, `timeout`, `bootTimeout`, `width`/`height`,
`shotEvery`) means what it always did. `peers` (multiplayer) is web only for now.

## What Gen never does

- **Fetch or serve a customer's build from its own host.**
  - An archive Gen holds (an upload or an asset) is copied once, by content, to the library bucket at
    `gs://<settings.storage.bucket>/playtest-builds/<project>/<sha256>` and the runner gets a V4 signed link (6 hours)
    to it. Set a lifecycle rule on that prefix to delete after 7 days (plan 3.5). Without a gcs library bucket and a
    service account that can sign (`src/providers/gpu/sign.ts`), such runs fail with a 503 that says so.
  - A GitHub build: Gen asks `api.github.com` where it is (the release asset, the artifact zip, the zipball) with
    `redirect: manual` and hands the runner GitHub's own short-lived link. It never downloads it.
  - A URL is handed over as it is.
  - Gen's loopback proxy (`proxyLocal` in `cloudrun.ts`, Playwright routing of `localhost` origins) stays for J's own
    local builds: it never applies to a customer's run or to a build a runner serves.
- **Open a customer's URL that points inside.** At submit (`checkPublicUrl`): http(s) only, no `user:pass@`, and not
  `localhost`, `*.internal`, `*.local`, single-label names, the metadata server or any private, loopback, link-local,
  CGNAT, multicast or IPv4-mapped IPv6 address, however written (`2130706433`, `0x7f.1`, `[::ffff:7f00:1]`). When the run
  starts (`publicUrl`): every address the name resolves to must be public. A name can still change its answer between
  that check and the runner's browser (DNS rebinding): runners are throwaway machines with no credentials, and their
  egress firewall (plan 3.4, 6.4) is what stops that reaching anything of ours.
- **Store or log a GitHub token.** `admit` moves it into an in-memory vault (`holdToken`, 12 hours) and the job's
  params carry only `tokenRef`. It is dropped when the run ends. A job resumed after a restart has no token and fails
  saying "submit again with the token". J's decision: tokens per call now, a GitHub App maybe later.
- **Play a customer's run in a browser on Gen's machine or on the playtesters.** Customers' runs get `gpu: "require"`
  and go only to runners whose `lanes` include `customer`; with none free they fail, never fall back.

A customer's `baseline` must be a job of its own project.

## The router (`settings.playtest.runners`)

```json
"runners": [
  { "id": "runpod-web", "provider": "runpod", "url": null, "targets": ["web"], "lanes": ["studio", "customer"],
    "pricePerSecond": 0.00008, "maxConcurrent": 4 },
  { "id": "cpu-web", "provider": "cloudrun-cpu", "url": null, "targets": ["web"], "lanes": ["studio", "customer"],
    "pricePerSecond": 0.0001, "maxConcurrent": 4 },
  { "id": "native-proton", "provider": "native", "url": "https://play-native.example", "targets": ["linux", "proton", "electron"],
    "lanes": ["customer"], "pricePerSecond": 0.00017, "maxConcurrent": 2, "tokenEnv": "PLAY_NATIVE_TOKEN" }
]
```

- `provider`: `runpod`, `cloudrun`, `cloudrun-cpu` (the browser services; `url: null` takes theirs from
  `settings.playtest.runpod` / `.cloudrun` / `.cloudrunCpu`) or `native` (a `hawkes-play-native` runner; `url`
  required). Browser runners play `web`; native runners play everything else (Electron is launched on the runner).
- `lanes`: whose builds it takes. `studio` is our own products, `customer` is untrusted builds (plan 3.5 wants those
  in a separate project; a runner for customers only is how that is expressed here).
- `pricePerSecond`: our cost of one run there (dollars), for the usage row. `maxConcurrent`: runs at once.
- `tokenEnv`: the environment variable (or secret) holding the native runner's key, sent as `X-Hawkes-Token`.
- `runnerCandidates(job, target, lane)` gives the ones usable now, first with room first: turned off, wrong target,
  wrong lane, already failed for this run (`labels.runnersTried`), cooling down (`gpu/health.ts`, key `runner:<id>`:
  2 min when full, 10 when unreachable, 30 when it refused the key) and missing keys are skipped and said why; full
  ones go last. A runner that refuses or can't be reached cools down and the next is tried.
- **With no runners set**, web runs keep today's order (`settings.playtest.backend`: RunPod, then the L4, then the CPU
  service, `cloudPlaytestsFor`) as implicit runners for both lanes, and nothing plays desktop targets. The studio's own
  page runs are unchanged: the playtesters and this PC's browser stay their fallback.
- The queue's lanes: router web runs share `playtest-runners`, native runs `playtest-native`, each as big as the sum of
  `maxConcurrent` of the runners for that target (`jobs.ts`). Per-customer fairness (`queue.perProjectLane`) applies.

## Web builds the runner serves itself

For an upload, asset or GitHub build on `web`, Gen connects to the browser service's `/pw` with
`X-Hawkes-Site: base64url({ url, kind, sha256, name })`. Before the browser starts, the service (`site.mjs`):
1. downloads the archive from the signed link (4 GB at most, `HAWKES_SITE_MAX_BYTES`), checks its sha256 when given;
2. unpacks it (`unzip`; `tar` for tar and tar.gz: members with `..` or absolute paths dropped; symlinks removed; at most
   200,000 files and 8 GB, `HAWKES_SITE_MAX_UNPACKED`), and serves the one folder inside when the archive wraps the
   build in one (zipballs, many artifacts);
3. serves it on `127.0.0.1:<random>` (paths can't leave the folder; `.br`/`.gz` files with their Content-Encoding for
   Unity and Godot; COOP/COEP for SharedArrayBuffer);
4. launches Chromium with `--host-resolver-rules=MAP build.hawkes.test:80 127.0.0.1:<port>`.

The page is `http://build.hawkes.test/<exe>`. Builds stay unpacked per instance (by checksum) while it lives, so the
tabs of a run and later runs of the same build share one. A build that can't be fetched or unpacked answers 422
`Build Failed`, which doesn't cool the runner down. **The image needs a rebuild for this** (`unzip`, `site.mjs`):
until then, runs of archived web builds fail at the connection.

## The session protocol (conductor ⇄ native runner), version 1

One WebSocket per run: `wss://<runner>/session`, headers `X-Hawkes-Token` (the runner's key) and `X-Hawkes-Job`,
plus `Authorization: Bearer <key>` when the runner sits behind a gateway that wants one (the entry's `gatewayKeyEnv`:
`RUNPOD_API_KEY` for RunPod's load balancer). The desktop runner (`hawkes-play-native`, docs/play-native.md) speaks this
through `server/play-native/genproto.mjs`; `test/play-native-proto.test.ts` plays this client against it.
Text messages are JSON with a `type`; binary messages start with a type byte: `1` a live frame (JPEG), `2` a chunk of the
file being sent. `t` is seconds since the run started.

Conductor → runner:

| Message | |
|---|---|
| `start` | `{ v: 1, job, project, target, build: { url, kind: "archive" \| "page", sha256?, name?, bytes? }, exe, args, scenario, mode, options, seed, speed, timeout, bootTimeout, width, height, shotEvery, liveFps }`. The first message. `build.url` is a signed link the runner downloads itself |
| `input` | `{ … }` real OS input for the AI player (later) |
| `stop` | `{ reason }`: wrap up now and send what you have (cancel, or the conductor's time limit) |

Runner → conductor:

| Message | |
|---|---|
| `accepted` | `{ runner, machine?, gpu?, os? }`: it will play. Must come within 5 minutes (a cold start) |
| `refused` | `{ reason, retry }`: it won't (busy, no GPU, unknown target). The conductor cools it down and tries the next runner |
| `step` | `{ text }`: progress for the job's steps |
| `log` | `{ t, stream: stdout \| stderr \| player \| sdk, line }` (first 5,000 kept) |
| `state` | `{ t, … }` the contract's state (scene, progress, fps, note) as the SDK reports it |
| `event` | `{ t, … }` a contract event |
| `crash` | `{ t, kind: exit \| signal \| exception \| hang, code?, signal?, message, stack?, dump? }` (`dump` names a file sent below) |
| `perf` | `{ t, fps: { average, worst, p1 }, frameTimes: { p50, p95, p99, max } (ms), cpu, gpu, memoryMB, vramMB: { average, max }, source }`; `final: true` on the summary |
| `file` … `fileEnd` | `{ name, kind: video \| shot \| log \| dump \| report, mime, bytes, t?, reason?, scene? }`, then binary `2` chunks, then `{ type: "fileEnd", name, sha256 }`. One file at a time; 2 GB a file, 4 GB a run |
| `result` | `{ outcome: won \| lost \| done \| stuck \| error \| crashed, seconds, loadSeconds, contract, scenarios, report: { metrics, events, log }, problems: [{ severity, message, source }], software?, softwareBecause?, renderer? }`, then the runner closes (1000) |

Files come back over the session rather than to signed upload URLs: Gen files every one in its library anyway. Signed
uploads can come later for multi-GB dumps. The reference fake runner is in `test/playtest-intake.test.ts` (`goodRun`).
The game side of a native run (the SDK talking to the runner over `HAWKES_PLAYTEST=ws://127.0.0.1:<port>/<token>`) is
hawkesstudio `docs/playtest.md`, "The native transport".

## Results

Native runs keep `playtest.run`'s shape (`outcome`, `problems`, `console`, `timeline`, `shots`, `video`, `report`, …) with
`url: null` and these added:
- `target`, `build` (what it was, never a link or token), `runner: { id, machine, gpu, os }`
- `crashes` (each one) and `crashGroups` (`[{ signature, count }]` by the first stack line), each group a `blocker`
  problem: "crashed 3 times: …"; a `dump` file becomes an asset, linked as `crashes[i].dumpAsset`
- `logs: { lines, first (200), last (100) }`; lines with error, exception or fatal count as console errors
- `perf` (the final block plus up to 300 samples); `fps` is `perf.fps` for the review
- `files`: logs and dumps filed as assets

Web results add `target` and `build`. Usage: `playtest-native` seconds × the runner's `pricePerSecond`; browser runs keep
their existing rows.

## Prices (provisional)

`playtest.run` and `playtest.review` are sold (no longer in `INTERNAL_ONLY_TOOLS`); `unity.build` and `unity.test` stay
internal. `src/billing.ts` (`playtestCost`), at cost × 3 like every tool, from the plan's section 7 estimates until runs
with design partners are measured:

| | Our cost | Floor |
|---|---|---|
| web minute | $0.005 | 3 credits a run |
| Electron minute | $0.008 | 4 |
| Linux / Proton minute | $0.01 | 5 |
| Windows minute | $0.03 | 15 |

A run is quoted for its `timeout` (else 3 minutes for `smoke`, 5 otherwise; a crawl 4 s a page) plus a start-up
allowance (1 min web, 1.5 Linux/Electron, 2 Proton, 4 Windows), times `peers`. `playtest.review` is priced by
`frames` and `model`: 6,000 prompt tokens + 1,600 a frame in, 3,000 out, at the model's list price; floor 3 credits.
