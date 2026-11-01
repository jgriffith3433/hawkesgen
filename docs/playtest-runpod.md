# Playtests on RunPod (a real GPU browser)

Since 2026-10-28 there are no AWS playtesters and Google gave no GPU quota, so playtests ran on the Cloud Run CPU service
(`docs/playtest-cloudrun.md`, "The CPU service"): WebGL on SwiftShader at 6 to 7 fps for Dose Of Destruction and Yooba
Land, too slow for their bots. This puts the same browser service on a **RunPod serverless load-balancer endpoint** with
a real NVIDIA GPU. Games play at 50+ fps, and the CPU service stays as the fallback.

## What RunPod supports (checked 2026-10-29)

- **WebSockets on load-balancer endpoints: yes, and for longer than the HTTP limit.** RunPod's docs give load-balancer
  requests a 5.5-minute processing timeout and a 2-minute wait for a worker
  ([overview](https://docs.runpod.io/serverless/load-balancing/overview)), and show WebSockets on the same endpoints with
  `Authorization: Bearer <API key>` on the handshake
  ([build a worker](https://docs.runpod.io/serverless/load-balancing/build-a-worker)). They say nothing on WebSocket
  length, so it was tested: a tiny endpoint (node:22-alpine, an RTX A4000-class worker) **held one WebSocket for 12
  minutes** (720 s, a message every 15 s, closed by the client) with no drop at 5.5 minutes. A playtest holds one for
  1 to 10 minutes.
- **The gateway checks the API key and removes it.** The worker never sees `Authorization`; any other header (here
  `X-Hawkes-Token`) arrives. Cloudflare fronts it (`cf-*` headers).
- **Health:** the gateway polls `GET /ping` on `PORT_HEALTH` (200 healthy, 204 initializing). **A worker whose /ping
  never says 200 gets no traffic, and the gateway holds requests for it until the client gives up** (seen 2026-10-29:
  requests hung for 5 minutes). `server.mjs` therefore answers 200 once its self-test is over, whatever it found, and a
  worker without a GPU path refuses `/pw` with `412 No GPU` (Gen moves on at once).
- **Endpoints can be made by API.** RunPod's API v2 (`https://api.runpod.io/v2/serverless`) takes
  `type: "LOAD_BALANCER"`, with the GPU models as `gpu.pools` plus `gpu.excludedTypes` (every other type in those pools,
  from `GET /v2/catalog/gpus`). `tools/playtest-runpod/setup.mjs` uses it through `tools/gpu-providers/runpod-v2.mjs`;
  nothing has to be clicked in the console. REST v1 is retired on 2026-11-15 and GraphQL in early 2027, so no script
  uses either.
- **Worker logs by API:** `GET https://api.runpod.io/v2/serverless/<endpoint>/workers/<worker>/logs` (Server-Sent
  Events; [docs](https://docs.runpod.io/api-reference-v2/serverless/stream-serverless-worker-logs)).
- **Prices** (flex workers, [runpod.io/pricing](https://www.runpod.io/pricing), 2026-10-29): 16 GB tier (A4000, A4500,
  RTX 4000/2000 Ada) $0.58/h, 24 GB (L4, A5000, 3090) $0.69/h. Billed from the worker's start until its idle timeout
  after the last request.

## Design, and why serverless rather than a Pod or a queue

The browser service is the same image as Cloud Run's L4 service (`server/playtest-cloudrun/`: Playwright's own image,
`server.mjs`, `gpu.mjs`), run as a RunPod load-balancer endpoint. Gen connects exactly as it does to Cloud Run:
`chromium.connect('wss://<endpoint>.api.runpod.ai/pw')`, one connection per tab, local builds served through the
connection, the video encoded on the worker (NVENC) over `/encode`. Only the headers differ.

- **Not a Pod started on demand (fallback a).** A Pod is cheaper per hour (A4000 community $0.17/h) and works with the
  same image (proved below), but Gen would have to start, watch and stop it: a cold start of 10 minutes on a new machine
  (the image pull, and RunPod's proxy took several more minutes to route), no guarantee a stopped Pod's GPU is free
  again, and a Pod left running is a bill that never stops. The serverless endpoint scales to zero by itself, so nothing
  can leak. A Pod URL (`https://<pod>-8080.proxy.runpod.net`) is still accepted in `settings.playtest.runpod.url` for a
  manual test; Gen sends it only the image token, never the API key.
- **Not a queue endpoint with the playtest inside the worker (fallback b).** It needs no live connection, but the whole
  of `playtest.run` (the bots, the live view, local builds, the review's frames) would have to move into the worker and
  come back through the storage broker. WebSockets proved long enough, so the live connection stays and nothing in
  `playtest.run` changes.

### Gen's side

- **Settings:** `settings.playtest.backend` (or `.projects[<product>]`) `"runpod"` and `settings.playtest.runpod`:
  `{ url, maxInstances, tabsPerInstance, encode, gpu, pricePerHour, idleSeconds }`. `url` must be
  `https://<id>.api.runpod.ai`, a Pod proxy, or `http://127.0.0.1:<port>`.
- **Order** (`cloudPlaytestsFor`, `openGpuHost`): the RunPod endpoint first, then the CPU service (`cloudrunCpu`, every
  region), then the playtesters. RunPod gets its full 5-minute wait on the first round (a cold start), then 40 s per
  try like the other services.
- **Headers** (`runpodHeaders`): `Authorization: Bearer RUNPOD_API_KEY` only to `*.api.runpod.ai`, and `X-Hawkes-Token`
  (`PLAYTEST_RUNPOD_TOKEN`, else `GPU_WORKER_TOKEN`) always. The image checks the token as `HAWKES_TOKEN` on `/pw`,
  `/encode`, `/selftest` and `/ready` (`/ping` and `/healthz` stay open for the gateway).
- **Retries:** a cold start may answer 408, 504 or 524 (Cloudflare); they are retried like 429/503. 412 (no GPU) is not.
- **Lane:** `playtest-runpod`, `maxInstances x tabsPerInstance` tabs. Since 2026-11-01 `maxInstances` is the
  endpoint's own `workers.max`, read from RunPod every 2 minutes (`src/providers/playtester/runpodcap.ts`); the setting
  is only the fallback when RunPod can't be read. To change how many playtests run at once, change the endpoint:
  `ops-playtest-capacity.yml` (or `node tools/playtest-runpod/capacity.mjs --max N --apply`), which touches only
  `workers.max`. Per-second billing means more workers play the same queue sooner for about the same money.
- **Usage:** a `runpod-playtest` row per playtest (`runpodUsage`): the tabs' share of a worker for the connect wait, the
  play and the idle tail. It is an upper bound when playtests follow each other on a warm worker.
- **Check it:** `GET /v1/playtester/cloud?variant=runpod&selftest=1` (starts a worker: about a cent).

### The image on RunPod

- **Built on GitHub to GHCR:** push a tag `playtest-image-<anything>` (`.github/workflows/playtest-image.yml`). It
  pushes `ghcr.io/jgriffith3433/hawkes-gen-playtest:pw<version>-<hash>` and `:latest`, and the same image as
  `ghcr.io/jgriffith3433/hawkes-gen-gpu:playtest-pw<version>-<hash>` (that package is already public; GitHub makes a new
  package private, and RunPod can't pull a private one without a registry credential).
- **The driver's graphics libraries.** RunPod mounts the NVIDIA driver into the container through the NVIDIA runtime
  (`/usr/lib/x86_64-linux-gnu`). Pods and most serverless hosts get the graphics libraries too (`libEGL_nvidia`, Chromium
  draws through ANGLE on EGL), but **one serverless host had only compute and video**: EGL fell back to Mesa's llvmpipe
  and every GPU candidate failed. So at startup `gpu.mjs ensureGraphicsLibs` checks for `libEGL_nvidia`; when missing,
  it downloads the installer for the host's exact driver version from NVIDIA (`download.nvidia.com/XFree86/...`, ~300
  MB), extracts it (5 s, nothing installed), copies the graphics libraries to `/opt/nvidia-gl`, and points the GLVND and
  Vulkan vendor files there. `HAWKES_FETCH_DRIVER=0` turns it off. The self-test report's `graphics` says what happened.
- Each GL candidate in the self-test now has a hard deadline, so a hung GPU process fails the test instead of holding
  `/ping` at 204.

## Provider order and Modal (2026-11-01)

Web playtests try browser providers in `settings.playtest.order` (Studio's playtest setting writes it through
`PUT /v1/playtest/capacity`): `runpod`, `modal`, `cloudrun` (the L4 service), `cloudrun-cpu` (software WebGL). Software is
always moved last, so a game takes any GPU first; ids in `settings.playtest.disabled` are left out; a project's own backend
(`settings.playtest.projects`) still wins. Empty order: `backend` decides as before. A provider that is out of credit
(RunPod's balance, `gpu/credit.ts`) is skipped with the reason, and one that refused us for money or a key (a 402, a spend
limit, 401/403) cools down for 30 minutes (`playtest:<id>` in `gpu/health.ts`), so the next playtests go straight to the
next provider. The queue's lane follows the first provider a run will actually use.

**Modal** runs the same image (`ghcr.io/jgriffith3433/hawkes-gen-playtest:latest`, public) as a Modal web endpoint on an
L4: `tools/playtest-modal/deploy.mjs` writes the app (`@modal.web_server(8080, requires_proxy_auth=True)`, `max_containers`,
`scaledown_window=60`, no warm containers: scale to zero) and `--apply` deploys it. The workflow
`ops-modal-playtest-deploy.yml` (production environment, main only; the `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` that
`ops-modal-deploy.yml` uses, and `GPU_WORKER_TOKEN` as the image's `HAWKES_TOKEN`) runs it and prints the endpoint URL.
Gen calls it with the Modal proxy token it already has for GPU jobs (`MODAL_PROXY_KEY` / `MODAL_PROXY_SECRET`) and
`X-Hawkes-Token` (`PLAYTEST_MODAL_TOKEN`, else `GPU_WORKER_TOKEN`). Then set `settings.playtest.modal.url` (and put `modal`
in the order): `PUT /v1/playtest/capacity {"modal": {"url": "https://<workspace>--hawkes-gen-playtest-browser.modal.run"}}`.
Check it with `GET /v1/playtester/cloud?variant=modal&selftest=1` (starts a container: about $0.02). About $1.12/hour per
container while one runs (L4 $0.80, 4 cores, 16 GiB), two browsers each; usage rows are `modal-playtest`.
Not verified yet: whether Modal's GPU sandbox gives Chromium a graphics path (EGL/Vulkan). If it doesn't, the image's
self-test fails, `/pw` answers 412 "No GPU" and the run moves on to the next provider.

## Measured (2026-10-29)

Each is Gen's real `playtest.run` (scratch Gen from this branch on J's PC, `gpu: require`), the browser on RunPod, the
live site, the `smoke` scenario, the screencast encoded on the worker with NVENC.

| Game | Where | Load | Run | fps avg (worst, p5) | Outcome | Cost (Gen's row) |
|---|---|---|---|---|---|---|
| Dose Of Destruction | serverless endpoint, warm (RTX A4500) | 1.8 s | 39 s | **52** (7, 7) | done | $0.008 |
| Dose Of Destruction | serverless endpoint, from zero (FlashBoot, ~29 s to the page) | 1.9 s | 39 s | **52** (7, 7) | done | $0.010 |
| Yooba Land | serverless endpoint, warm | 1.2 s | 57 s | **54** (8, 28) | done | $0.010 |
| Dose Of Destruction | Pod, RTX A4000 | 1.6 s | 38 s | 54 (8, 8) | done | $0.002 |
| Yooba Land | Pod, RTX A4000 | 1.2 s | 54 s | 55 (6, 25) | done | $0.003 |
| (before) DoD / Yooba Land | Cloud Run CPU service | | | 6 to 7 | bots time out | |

- The worst frames are the loading moments (scene changes); the match itself runs at the display rate.
- Self-test on RunPod: `ANGLE (NVIDIA Corporation, NVIDIA RTX A4500/PCIe/SSE2, OpenGL ES 3.2)` via `angle-egl` in
  0.6 s; NVENC works. A worker reported 48 host CPUs and no cgroup CPU limit (`machine` in the report).
- **Cold start:** from zero on a machine that had the image, about 30 s to the first page; a machine pulling the image
  for the first time took minutes (one worker's first requests waited over 5 minutes, which is why RunPod gets the full
  wait on the first round).
- **Total spent on all of this work's tests:** about $1.05 (the WebSocket test endpoint $0.15, the diagnostic Pod about
  $0.10, the playtest endpoint's workers about $0.80 including the debugging of the hung worker). A warm DoD smoke run is
  about a cent.

## J's steps

1. **The image is public** (done 2026-10-29: `ghcr.io/jgriffith3433/hawkes-gen-playtest:latest`, checked with an
   anonymous pull; GitHub once flipped it back to private, so check that before blaming RunPod for a failed pull).
2. **Endpoint** (`43vc12r3r5gj4n`, `hawkes-gen-playtest-gfx` (2026-10-29), exact GPU models: RTX A4000, A4500, RTX 4000 Ada, RTX 2000 Ada. Never a pool alone: RunPod put PRO 6000 MIG slices (CUDA, no graphics) in AMPERE_24, and workers stay on the machine they were first placed on, so a new GPU list needs a new endpoint. The old `wi67a2gkuwi9o5` is unused, max 2
   workers, idle 60 s). To make or update it: `node tools/playtest-runpod/setup.mjs` (prints the plan), then `--apply`
   (with `--image ghcr.io/jgriffith3433/hawkes-gen-playtest:latest` once the package is public). Free until a playtest
   starts a worker.
3. **Gen's environment:** `RUNPOD_API_KEY` and `GPU_WORKER_TOKEN` are already mounted on the cloud Gen
   (`tools/gen-cloudrun/deploy.mjs`); the endpoint's `HAWKES_TOKEN` is `GPU_WORKER_TOKEN`.
4. **Settings** (after this branch reaches Gen): the block `setup.mjs` prints, e.g.
   `{"playtest":{"backend":"runpod","runpod":{"url":"https://wi67a2gkuwi9o5.api.runpod.ai","maxInstances":2,"tabsPerInstance":2,"encode":"service","gpu":"RTX A4000 class (16 GB)","pricePerHour":0.58,"idleSeconds":60}}}`
   (keep `cloudrunCpu` as it is: it is the fallback).

## Not verified yet

- **The driver-library fetch on a host that lacks them.** Its pieces were tested (the installer's URL and extraction
  in a container, the file list), but no RunPod worker landed on such a host after it was built.
- Two tabs on one worker (`tabsPerInstance: 2`), multiplayer runs, and a local build through the proxy on RunPod.
- RunPod's bill against Gen's usage rows over a day of runs.
