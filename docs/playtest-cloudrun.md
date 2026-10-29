# Playtests on Cloud Run

Moving `playtest.run`'s browser from the EC2 playtesters (g4dn.xlarge with a T4, a Playwright browser server reached
over an SSH tunnel) to a Google Cloud Run service with an NVIDIA L4 that scales to zero. **Nothing here is deployed.**
The code sits behind `settings.playtest`, which defaults to EC2, and every Cloud Run failure falls back to the
playtesters.

**Without a GPU (since 2026-10-28):** AWS is suspended and Google refused GPU quota, so the L4 can't run. The same
service runs on plain CPUs with WebGL on SwiftShader as `gen-playtest-cpu` (`backend: "cloudrun-cpu"`). See "The CPU
service" below for what differs, what was measured, the cost (about $0.007 a playtest minute) and J's steps.

| Piece | Where |
|---|---|
| The service image (Playwright's image at Gen's version, ffmpeg, the NVIDIA EGL/Vulkan vendor files) | `server/playtest-cloudrun/Dockerfile`, `package.json`, `10_nvidia.json`, `nvidia_icd.json` |
| The service: a browser per WebSocket, the GPU self-test, the video encode | `server/playtest-cloudrun/server.mjs`, `gpu.mjs` |
| Its size, region and tabs | `server/playtest-cloudrun/service.json` |
| Gen's side: routing, local builds through the connection, the pool, the encode, cost | `src/providers/playtester/cloudrun.ts`, `openGpuHost` in `src/providers/comfy/playtestHost.ts`, `src/tools/playtest.ts`, the `playtest-cloud` lane in `src/jobs.ts` |
| Scripts (dry run unless `--apply`) | `tools/playtest-cloudrun/build.mjs`, `deploy.mjs`, `lib.mjs` |
| Tests (no Google Cloud needed) | `test/playtest-cloudrun.test.ts` |

## Design

**One WebSocket is one tab.** Gen calls `chromium.connect('wss://<service>/pw', { headers: { Authorization: 'Bearer
<ID token>' } })`. Cloud Run checks the token: only Gen's service account (`gen-control@`) holds `roles/run.invoker`,
never `allUsers`. The token comes from the same Application Default Credentials as the GPU services (`gcpTokens()` in
`src/providers/gcp/gcs.ts`; `HAWKESGEN_GCP_IMPERSONATE` on the control server). For each connection the service starts
its own Chromium with `launchServer` and the GPU flags the self-test chose, then pipes the socket to it byte for byte.
The browser closes when the connection does.

- A multiplayer run (`peers: 2..4`) opens one connection per player. `BrowserPool` makes those look like one browser to
  `playtest.ts`: `newContext()` takes a connected browser with no open context. The players may land on different
  instances. That's fine: they meet in the Hawkes Net room, not in the browser.
- Because a connection is a tab, Cloud Run's `containerConcurrency` is `tabsPerInstance`. It caps the tabs on one
  instance exactly.
- One playtest is one connection per tab for its whole run, 1 to 3 minutes. Cloud Run allows 60.
- Run-server's per-connection launch options are not used, because Chromium would then render in software. That was
  the EC2 lesson.

**Lanes.** The queue (`jobs.ts`) gives Cloud Run playtests a lane of their own, `playtest-cloud`, of `maxInstances ×
tabsPerInstance` tabs (2 × 4 = 8 by default). It counts tabs the same way as the EC2 lane: a multiplayer run weighs
its players, and an empty lane always takes one. Gen therefore never asks Cloud Run for more than it has. A 429
(service full) or 503 (instance starting) is still waited out, up to 6 minutes per connection with backoff
(`connectOne`). The existing "never stuck" rules all hold:

- `openGpuHost` is bounded at 20 minutes.
- Every await in the run has its `within()`.
- The watchdog's `kill()` closes the pool, which closes every WebSocket, and Cloud Run's instance then kills those
  browsers.
- `close()` is idempotent and records usage once.

**The switch** (`settings.playtest`, `POST /v1/settings`):

```json
{
  "playtest": {
    "backend": "ec2",
    "projects": { "sickofitgame": "cloudrun" },
    "cloudrun": { "url": "https://gen-playtest-….run.app", "maxInstances": 2, "tabsPerInstance": 4, "encode": "service" }
  }
}
```

- `backend` is the default. `projects` sets it per product (the Gen job's `project`).
- Cloud Run is used only when the URL is set.
- If the connection fails (credentials, quota, the service down), the step says why and the run takes the playtesters
  (`openPlaytestHost`), so EC2 is the fallback with no change.
- `gpu: off` and J's PC (Windows, its own GPU) never use either.

### How WebGL gets the GPU

What Cloud Run gives a GPU container, from Google's GPU page (docs.cloud.google.com/run/docs/configuring/services/gpu):

- Driver 580.x (CUDA 13.0).
- "driver libraries are mounted under `/usr/local/nvidia/lib64`", which Cloud Run appends to `LD_LIBRARY_PATH`.

Nothing on that page covers graphics. It does not say whether EGL, Vulkan or NVENC are exposed. The design does not
assume they are; the service proves it at startup.

1. **What the image adds.** No NVIDIA libraries, since those come from the mount. It adds:
   - the GLVND EGL loader and the Vulkan loader;
   - `/usr/share/glvnd/egl_vendor.d/10_nvidia.json`, which points at `libEGL_nvidia.so.0`;
   - `/etc/vulkan/icd.d/nvidia_icd.json`, which points at `libGLX_nvidia.so.0`, the NVIDIA Vulkan ICD.

   Both are resolved through `LD_LIBRARY_PATH`. This is the usual fix for NVIDIA EGL in containers that only get the
   driver's libraries; Hugging Face's MuJoCo GPU image does exactly this, and GLVND finds a vendor only through these
   files. Mesa's Vulkan drivers are removed, so a missing NVIDIA path fails loudly instead of rendering on llvmpipe.
2. **The self-test** (`gpu.mjs`, run before `/ready` passes, so the startup probe holds traffic until it is done).
   Each candidate flag set, in order:

   | Candidate | Flags | Notes |
   |---|---|---|
   | `angle-egl` | `--use-gl=angle --use-angle=gl-egl` | The EC2 playtesters' set, proven on the T4 |
   | `angle-vulkan` | `--use-angle=vulkan --enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE --disable-vulkan-surface` | The headless-Linux-without-X path in Chromium's own GPU docs |
   | `angle-egl-chromium`, `angle-vulkan-chromium` | The same two | In Playwright's new-headless `chromium` channel |

   Every candidate also gets `--enable-gpu --ignore-gpu-blocklist --disable-dev-shm-usage`. For each one, the service:
   - launches headless Chromium;
   - makes a WebGL2 context, clears it and reads a pixel back (it really draws);
   - reads `UNMASKED_RENDERER_WEBGL`;
   - reads `chrome://gpu`'s feature lines ("WebGL: Hardware accelerated", `GL_RENDERER`).

   The first candidate whose renderer names the NVIDIA GPU, and not SwiftShader or llvmpipe (`classifyRenderer`), is
   used for every browser the instance starts. If none does, `/ready` stays 503 and the instance never takes a
   playtest.
3. **Evidence on demand.** `hawkesgen playtester cloud selftest` (`GET /v1/playtester/cloud?selftest=1`) returns:
   - every candidate's renderer, vendor and `chrome://gpu` lines;
   - the mounted libraries matching EGL, GLX, Vulkan, encode or cuvid;
   - `nvidia-smi`'s line;
   - whether `h264_nvenc` works.

   `fresh=1` reruns the test. `all=1` tries every path instead of stopping at the first that works. The pilot records
   this output in this document.

**Known risk.** If Cloud Run's mount lacks `libEGL_nvidia`/`libGLX_nvidia` (a compute-only driver mount), no candidate
passes. What then:

- The service never becomes ready, and Gen falls back to EC2.
- The pilot's first deploy answers the question in minutes, for about $0.05.
- The way out would be the GPU on a GCE VM, which is a different design. Until the pilot says otherwise, the claim
  "WebGL on the L4" is a hypothesis with a test, not a fact.

### Local builds (what the SSH -R tunnel did)

Studio plays its local and beta builds at `http://localhost:<port>` on the control server, where Gen runs. On Cloud
Run, nothing is uploaded and nothing listens on the internet:

- **Requests.** `proxyLocal` installs `context.route()` for the page's own origin (`localhost`, `127.0.0.1` or `[::1]`
  at the page's port, the same rule as the tunnel). The remote browser's request crosses the Playwright connection.
  Gen fetches it from the local server, with the browser's headers and cookies, `redirect: manual`, and a 120 s limit.
  The answer goes back with `route.fulfill()`: status, headers, every `Set-Cookie`, and the body.
- **WebSockets.** `context.routeWebSocket()` is bridged to a Node WebSocket to the local server (a dev server's reload
  socket, a local game server).
- **Service workers** are blocked on those contexts (`serviceWorkers: 'block'`), because routing doesn't see a service
  worker's fetches.
- **Everything else** goes straight out from the service: live sites, CDNs, net.hawkesgen.ai and beta Hawkes Net.
- **Why this is enough.** It works the same for a static build, a Vite dev server and a server app. It needs no bucket,
  no signed URLs and no second route into the container.

The cost is that every local file crosses the connection, from AWS to Google. A Unity WebGL build is 20 to 60 MB per
playtest: a few seconds and about $0.005 of AWS egress. Playwright's routing also turns off the HTTP cache for the
context, which a fresh playtest doesn't use anyway.

**Studio-login-protected beta sites.** Gen passes no cookies or login today: Studio plays beta through its own local
copy at `http://localhost:<port>` (`hawkesstudio/src/pipeline.ts`, `serveDir`), and live sites are public. Both keep
working:

- Local copies go through the routing above.
- Login cookies a local server sets reach the remote browser through `Set-Cookie`, and come back with its requests.

If Studio ever plays a protected `https://<sub>.hawkesgen.ai/` directly, it would need to pass a cookie (a
`playtest.run` param that would `context.addCookies`). That gap is the same on EC2.

### Video

The screencast is unchanged. Its frames already come to Gen over CDP, through the same connection:

- `ScreencastRecorder` writes the MJPEG here.
- `livePlay.ts`'s MJPEG stream and `/frame` read the newest frame while the run plays, so the live view works as
  before.

After the run, with `encode: "service"` (the default):

- The MJPEG goes to the service's `/encode` over a WebSocket. Cloud Run caps an HTTP/1 request body at 32 MiB, and a
  3-minute MJPEG is 200 to 300 MB. WebSocket messages have no such cap.
- The service encodes with `h264_nvenc` when the self-test found NVENC (the L4 has it; whether the mount includes
  `libnvidia-encode` is part of the self-test), else `libx264` on its 8 vCPUs.
- The mp4 streams back.
- Any failure encodes here as before.

`encode: "here"` skips the service. It saves the upload (about $0.02 per 3-minute run) and costs the control server
about 30 to 60 s of one core per run.

Multiplayer videos are stacked here with ffmpeg, as before.

### Cost per playtest

The rates are from `server/cloudrun/services.json` (Tier 1, instance-based billing, no zonal redundancy). Check them
on cloud.google.com/run/pricing.

| Rate | Price |
|---|---|
| L4 | $0.0001867/s ($0.67/h) |
| 8 vCPU | $0.000144/s |
| 32 GiB | $0.000064/s |
| **Instance** | **$0.000395/s = $1.42/h**, $0.024 a minute |

| Case | Compute | Transfer (frames back, upload to encode) | About |
|---|---|---|---|
| 3-min single-player run, instance shared by 4 tabs | $0.018 | ~$0.03 + $0.02 | **$0.07** |
| 3-min run alone on a warm instance | $0.071 | ~$0.05 | **$0.12** |
| 3-min run alone, cold, nobody after it | $0.071 + ~$0.02 cold start + the idle tail (up to ~10-15 min: $0.24-0.36) | ~$0.05 | **$0.40-0.50** |
| 1-min agent check on a warm instance | $0.024 | ~$0.02 | **$0.04** |
| 2-player 3-min run (2 tabs) | $0.036-0.14 | ~$0.10 | **$0.14-0.25** |

**Transfer.** Frames are JPEG at quality 60, ~45 KB at 720p, 30 a second: about 240 MB for 3 minutes. They pay
Google's internet egress (~$0.12/GB) on the way to AWS. With `encode: service` they pay AWS egress (~$0.09/GB) back up.

**Comparison.**

- A g4dn.xlarge playtester is $0.53/h for 2 tabs. Cloud Run's L4 instance is **2.7× that per hour**, and roughly 2.7×
  per tab-hour at 4 tabs.
- Cloud Run wins only on what EC2 wastes:
  - every start of a playtester buys at least 20 idle minutes ($0.18);
  - a playtester waits for a run's whole window;
  - an EC2 start takes minutes, and two playtesters cap the parallelism.
- Cloud Run loses on busy, continuous stretches and on transfer.

**Count the idle tail.** Cloud Run keeps an idle instance up to ~10-15 minutes and bills it under instance-based
billing. A day of scattered single playtests pays a tail for most of them. Studio's daily run, back to back, pays one.

The per-tab share is recorded as a `gcp-playtest` usage row (unit `tab_seconds`), so the job's cost shows up. The idle
tail and transfer are not in it. Read them from the billing export, as for the GPU services.

**A cheaper shape to try in the pilot:** 4 vCPU / 16 GiB (the L4's minimum, $1.05/h) with 2 tabs per instance, which
matches what a g4dn.xlarge plays. Change `service.json` and redeploy.

### Cold start (expected; the pilot measures it)

| Step | Expected |
|---|---|
| GPU instance with driver | ~5 s (Google's figure) |
| Image pull (~2-2.5 GB: Playwright's noble image + ffmpeg) | 15-60 s; the first pull per region is slowest, and Cloud Run caches it after |
| Self-test (one Chromium launch and probe if the first path works; up to four if not) | 3-20 s |
| A browser per connection once warm | ~1 s |

So the first playtest after an idle spell waits about **30-90 s** for its browser. Today a stopped playtester takes
2-4 minutes. Warm instances answer at once. A multiplayer run connects all its players in parallel.

## The CPU service (gen-playtest-cpu): software WebGL, no GPU

**Why.** AWS (and its T4 playtesters) was suspended on 2026-10-28, and Google refused the project GPU quota for lack
of usage history, so the L4 service above can't run. Without a GPU nothing playtested. `gen-playtest-cpu` is the same
service on plain Cloud Run CPUs: Chromium draws WebGL with **SwiftShader** (Chromium's own CPU implementation of
Vulkan, under ANGLE). The L4 design stays as it is for when quota or RunPod exists.

| Piece | Where |
|---|---|
| The image: Playwright's at Gen's version, ffmpeg, `HAWKES_GL_MODE=software`; no NVIDIA files | `server/playtest-cloudrun/Dockerfile.cpu` |
| The same server and self-test, in software mode | `server.mjs`, `gpu.mjs` (`SOFTWARE_CANDIDATES`, `glMode`, `PAGE_BENCH`) |
| Its size, tabs, slowness and request-based prices | `server/playtest-cloudrun/service-cpu.json` |
| Gen's side | `cloudPlaytestsFor`, `cloudLaneKey`, `CPU_SOFTWARE_WHY` in `src/providers/playtester/cloudrun.ts`; the fallback loop in `openGpuHost`; `host.software` / `host.slow` in `src/tools/playtest.ts` |
| Scripts (dry run unless `--apply`) | `tools/playtest-cloudrun/build.mjs --variant cpu`, `deploy.mjs --variant cpu`, J's `deploy-cpu.ps1` |
| Tests | `test/playtest-cloudrun.test.ts` (the CPU tests run the service here in software mode) |

**What differs from the L4 service.**

- **The self-test** (`gpu.mjs`, `HAWKES_GL_MODE=software`). The candidates are `swiftshader` (the headless shell) and
  `swiftshader-chromium` (new headless), with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` plus
  the base flags. A candidate passes when WebGL2 draws and reads back. The renderer string is reported
  (`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) ...), SwiftShader driver)`). It also times a 1280x720
  fragment-shader loop for 3 s and reports `gl.fps`, a rough number for how fast this instance draws. `/ready` passes
  only after that, and `/selftest` shows `mode: "software"` and `gl` (`gpu` is the same object under its old name).
  NVENC and the driver checks are skipped.
- **One tab per instance** (`tabsPerInstance: 1`, `containerConcurrency: 1`), 4 vCPU and 8 GiB, up to 4 instances.
  Measured below: a second tab halves the frame rate and broke a bot.
- **Request-based billing** (`run.googleapis.com/cpu-throttling: "true"`). A tab's WebSocket is a request for its whole
  run, so the instance has its CPU while it plays and costs nothing between playtests. There is no idle tail, unlike
  the L4. No GPU quota, no zonal-redundancy setting.
- **Slower limits.** The spec's `slow` (2) reaches Gen as `host.slow`. `playtest.run` doubles `bootTimeout` and the
  default scenario limit (2x the scenario's `seconds` becomes 4x). An explicit `timeout` is kept as given. The game's
  own bot timers are not stretched: a game whose bot waits by wall clock can still time out on a slow instance.
- **The run says it was software.** `result.software` is true (the renderer is SwiftShader), and `softwareBecause` is
  `CPU_SOFTWARE_WHY`. The low-frame-rate warning is not raised. The review is told frame rates and smoothness mean
  nothing (as for any software run). `result.browser` is `Cloud Run gen-playtest-cpu (us-east4, software WebGL)`.
- **Video** as before: the CDP screencast comes to Gen, then is encoded with libx264 on the service's `/encode` (the
  encode is its own short request after the tab closes), else here.
- **Usage** rows are `gcp-playtest-cpu` (unit `tab_seconds`) at the spec's request-based rates.

**Settings** (`POST /v1/settings`):

```json
{
  "playtest": {
    "backend": "cloudrun-cpu",
    "cloudrunCpu": { "url": "https://gen-playtest-cpu-….run.app", "maxInstances": 4, "tabsPerInstance": 1, "encode": "service" }
  }
}
```

- `backend` (or `projects.<product>`) can be `ec2`, `cloudrun` (the L4) or `cloudrun-cpu`.
- **Fallback, in order, each step told in the job's log.**
  - `cloudrun` tries the L4 service, then the CPU service when `cloudrunCpu.url` is set, then the playtesters.
  - `cloudrun-cpu` tries the CPU service, then the playtesters.
  - The playtesters fall back to a GPU fleet server, then to software in Gen's own process. With AWS suspended, those
    later steps are not there.
- The CPU service has its own lane in the queue, `playtest-cloud-cpu`, of `maxInstances × tabsPerInstance` tabs (4).
  It is counted apart from the L4's `playtest-cloud`.
- **A local service.** `cloudrunCpu.url` (or `cloudrun.url`) may be `http://127.0.0.1:<port>` or
  `http://localhost:<port>`: the same container run beside Gen (`docker run -p 8095:8080 <image>`). Gen sends it no
  Google token. That is how this was proven on J's PC.
- **Check it.** `hawkesgen playtester cloud cpu [selftest]` (`GET /v1/playtester/cloud?variant=cpu&selftest=1`)
  returns the settings, the lanes, the price and the service's self-test.

### Measured (2026-10-29)

Each run was Dose Of Destruction's `smoke` (title, menus, character select, a City Top match, back to the menu) through
the whole path: Gen's `playtest.run`, then `openGpuHost`, then the CPU service (`server.mjs` in software mode), with
the screencast and the encode on the service. `software: true` in every result.

| Where | CPUs | Load | Run | fps avg (worst) | Outcome |
|---|---|---|---|---|---|
| J's PC, local build (`dist/`, through the proxy) | all 14 threads | 4.1 s | 40 s | 36 (19) | done; the video encoded on the service (libx264, 1280x720, 1207 frames) |
| J's PC, live site | 4 logical (affinity 0xF: 2 P-cores) | 1.7 s | 44 s | 20 (2) | done |
| J's PC, live site | 2 logical (one P-core) | 1.2 s | 50 s | 19 (4) | done |
| J's PC, live site | 8 logical (P+E cores) | 2.0 s | 47 s | 17 (1) | done |
| J's PC, live site, **two tabs at once** | 4 logical | 3.1 / 3.3 s | 89 / 111 s | 11 / 8 | done / **stuck** (bot: "timed out waiting for Quit") |
| The real image in Cloud Build (`e2-standard-2`, `docker run --cpus=2 --memory=6g`) | 2 shared vCPU | 3.1 s | 94 s | 8.3 (0) | **stuck** (bot: "timed out waiting for the match to start"); the stage still drew in full |

- **Self-test bench** (`gl.fps`): ~52 on 4 logical CPUs here, **17.2** in Cloud Build's 2 vCPU. The test took 4.5 s
  here and 11 s there, so `/ready` came 11 s after start.
- **Memory**: one tab peaked at 1.8 GB working set (1.55 GB private) over 5 Chromium processes. 8 GiB leaves room for
  Unity games' wasm heaps; 4 GiB would do for DoD.
- **What it shows.**
  - One tab per instance. A second halves the frame rate.
  - Per-core speed matters more than core count: 2, 4 and 8 threads here gave about the same.
  - Cloud Build's slow shared cores were too slow. Cloud Run's vCPUs are faster than `e2-standard-2`'s, but how much
    faster is the one number not measured yet (Cloud Build refused 8-vCPU machines on this project's quota).
- **The rule for after the deploy.** Run `deploy-cpu.ps1 -Settings`; it prints the bench. Under ~35, set `"cpu": 8` in
  `service-cpu.json` and deploy again. At 8 vCPU it is about $0.83 an hour while a tab plays.
- **Image**: `us-east4-docker.pkg.dev/hawkes-staging/hawkes-gen/gen-playtest-cpu:pw1.64.1-5803d4c11a` is built and
  pushed (Cloud Build, 2026-10-29), so `build.mjs --variant cpu --apply` finds it and skips the build while the sources
  are unchanged.

### Cost per playtest (CPU service)

The rates are request-based, Tier 1 (us-east4): $0.000024 per vCPU-second and $0.0000025 per GiB-second, the same
rates as `server/cpu-cloudrun/service.json`. They are not yet checked against the bill.

| Rate | Price |
|---|---|
| 4 vCPU + 8 GiB, while a tab is connected | $0.000116/s = **$0.42/h, $0.007 a playtest minute** |
| The same at 8 vCPU (if the bench says so) | $0.000212/s = $0.76/h, $0.013 a minute |
| Idle | $0: no idle tail (request-based) |

- **Per run.** A 1-minute smoke costs about **$0.007**, plus the encode (10-20 s of the same instance, ~$0.002). A
  3-minute run is about **$0.025**.
- **A day.** Studio's daily run of ~20 playtest minutes is about $0.15.
- **Free tier.** Cloud Run's free tier (180,000 vCPU-seconds a month per billing account, shared with gen-cpu) covers
  about 12 hours of these playtests a month.
- **Transfer.** Gen (`gen`, `gen-beta`) is in us-east4 too, so the screencast frames and local files cross within the
  region. Check the first bill.
- **Cold start.** Each start pulls the image (~2 GB; Cloud Run caches it), then runs the self-test (~11 s). Expect
  about 20-40 s before the first tab; a warm instance answers at once.

### J's steps

1. Merge `playtest-cpu` into `dev`, and `git pull` in `C:\Projects\hawkesgen`. The script runs from there.
2. Read the dry run:
   `powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesgen\tools\playtest-cloudrun\deploy-cpu.ps1`
3. Deploy: `... deploy-cpu.ps1 -Apply`. The image is already built. This step makes the account `gen-playtest@` (no
   roles) and the service, and grants `roles/run.invoker` to `gen-control@` only.
4. Point Gen at it: `... deploy-cpu.ps1 -Settings`. It patches beta Gen, then live Gen
   (`backend: "cloudrun-cpu"` and `cloudrunCpu`) with the keys in `~/.hawkes/client.json`. It prints each lane's
   self-test and the bench.
5. Tell Claude. It plays `studio.cmd playtest doseofdestruction smoke --wait` and one product of each kind (a web game
   and a Unity game), then checks the videos and frame rates. If the bench was under 35, first set `"cpu": 8`.
6. **Undo.** `POST /v1/settings {"playtest": {"backend": "ec2"}}` stops using it. Then
   `gcloud run services delete gen-playtest-cpu --region us-east4` removes it. Idle, it costs nothing.

## Pilot (J's OK: it bills while instances run)

About $1 to $3 in all: a few minutes of Cloud Build, a dozen playtests, the idle tails.

0. **Prerequisites.**
   - The `hawkes-staging` project and APIs from `docs/cloudrun.md`, step 0.
   - Gen's credentials from `docs/cloudrun.md`, step 4 (the same `gen-control@` and `HAWKESGEN_GCP_IMPERSONATE`).
   - The control server (AWS, us-east-1) reaches us-east4 in about 2 ms. That matters, because every Playwright call
     is a round trip.
1. **Build the image.** Read the dry run first:
   ```
   node tools/playtest-cloudrun/build.mjs --project hawkes-staging
   node tools/playtest-cloudrun/build.mjs --project hawkes-staging --apply
   ```
2. **Deploy.** `--setup` makes `gen-playtest@`, which has no roles. The first deploy in us-east4 grants 3 L4 quota.
   ```
   node tools/playtest-cloudrun/deploy.mjs --project hawkes-staging --setup
   node tools/playtest-cloudrun/deploy.mjs --project hawkes-staging --setup --apply
   ```
   It prints the URL and the settings patch.
3. **Prove the GPU before anything plays.**
   - Set only the URL: `POST /v1/settings {"playtest": {"cloudrun": {"url": "…"}}}`. That moves no product.
   - Run `hawkesgen playtester cloud selftest all` and check:
     - `gpu.ok: true`, and a renderer naming the NVIDIA L4;
     - which candidate won;
     - `nvenc.ok`;
     - the `driver.libs` list.

   **If `gpu.ok` is false, stop:** the mount has no graphics libraries. Paste the report into this document and keep
   EC2.
4. **One product on Cloud Run.** `POST /v1/settings {"playtest": {"projects": {"sickofitgame": "cloudrun"}}}`, then
   play:
   - `studio.cmd playtest sickofitgame smoke --wait` (a local build through the proxy);
   - the live site;
   - a phone run.

   Compare fps, load time and the video with the last EC2 runs of the same scenario.
5. **Multiplayer.** A `peers: 2` run of Dose Of Destruction: two connections, the room meeting, the stacked video.
6. **Burst and limits.** Six playtests at once. Check that:
   - 8 tabs are admitted and the rest wait in Gen's lane;
   - a second instance starts;
   - no 429 storm happens.
7. **Never stuck.** Cancel a run mid-play. In `gcloud run services logs read gen-playtest --region us-east4`, the
   session should end within seconds.
8. **Cost.** Compare the `gcp-playtest` usage rows with the billing export after a day; the difference is the idle
   tail plus transfer.
9. **Decide per product,** then either set `"backend": "cloudrun"` or delete the service with
   `gcloud run services delete gen-playtest --region us-east4`. Idle, it costs nothing beyond the image's storage
   (cents).

## Risks and open questions

- **Graphics in the driver mount.** This is the deciding unknown (see above). The self-test makes it a two-minute
  check.
- **Headless Chromium on the L4.** EGL through ANGLE worked on the T4 with a full driver install; here only the mount
  exists. Vulkan is the second path. If a renderer passes but games run slowly, compare candidates with `all=1`.
- **Transfer adds a per-run cost** that EC2 in-region didn't have: about $0.03-0.05 per 3 minutes. Lower quality or
  frame rate would reduce it; the review's frames would change too.
- **The idle tail** is billed under instance-based billing. Scattered single runs pay it many times.
- **Large local files** (a 60 MB `.data.unityweb`) cross the Playwright connection base64-encoded in one message. That
  works, but costs memory on both sides during the transfer.
- **Service workers are blocked** for local pages on Cloud Run. A game that relies on one for loading would behave
  differently from EC2; none does today.
- **Quota.** 3 L4 per region by default. The GPU services in `docs/cloudrun.md` use L4s too: share or raise.
- **The 60-minute request cap** limits a playtest's connection. Runs are 1 to 3 minutes; a `timeout` near 3600 s would
  hit it.
