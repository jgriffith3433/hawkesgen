# The CPU suite on Cloud Run

Gen's CPU tools (no GPU, no API key: Pillow, ffmpeg, rembg, numpy, gltf-transform) can run on Google Cloud Run instead
of the control server, one tool or all of them, chosen in settings. **Local stays the default**: nothing moves until
`settings.cpu` says so. The same tool code runs in both places; there is no second copy.

| Piece | Where |
|---|---|
| The suite: which tools, their area, weight, typical seconds | `src/cpu/suite.ts` (`CPU_SUITE`, `STAYS_LOCAL`, `describeSuite`) |
| The service's work (run a tool against Cloud Storage; the LOD commands) | `src/cpu/worker.ts` |
| The service's HTTP door | `server/cpu-cloudrun/server.ts` |
| The image | `server/cpu-cloudrun/Dockerfile`, `requirements.txt`; context from `tools/cpu-cloudrun/lib.mjs` |
| Sizes, concurrency, prices | `server/cpu-cloudrun/service.json` |
| Gen's side: routing, the request, fallback, `cpuExec`, `GET /v1/cpu` | `src/providers/cloudrun/cpu.ts` |
| The queue's lane and cost | `src/jobs.ts` (`local-cloud` lane, `runJob(..., cpu)`, usage `gcp-cpu`) |
| The LOD system's level making | `src/lod.ts` (`levelCommand`) |
| Setup | `tools/cpu-cloudrun/build.mjs`, `deploy.mjs`, `deploy.ps1` (J's one-shot) |
| Tests | `test/cpu-cloudrun.test.ts` |

## The suite

| Tool | What it's for | Weight (service) | Typical call |
|---|---|---|---|
| `image.transform` | resize, crop, trim, pad, power-of-two, pixel art, outline, tint... in order | light (gen-cpu) | 2 s |
| `image.cutout` | background removal (BiRefNet, ISNet, both), glow mode | heavy (gen-cpu-heavy) | 20 s |
| `image.frame` | a cutout on a flat color, feet near the bottom (first frames for video) | light | 2 s |
| `image.sheet` | 2-6 views side by side (the turnaround mesh.views3d reads) | light | 3 s |
| `image.tile` | make a texture tile without seams | light | 2 s |
| `texture.maps` | albedo, normal and roughness maps from one texture | light | 5 s |
| `sprite.sheet` | a clip or frames to a keyed PNG atlas, frame JSON and GIF | light | 8 s |
| `media.probe` | size, length, rate and codecs of a file | light | 1 s |
| `video.fit` | resample and frame a driving video for the video models | light | 10 s |
| `video.compose` | shots into a finished cut: trims, transitions, music, captions | heavy | 60 s |
| `video.matte`, `video.composite`, `video.control-mix` | the film pipeline's ffmpeg passes | heavy | 30-40 s |
| `splat.build` | a Gaussian splat and its preview | heavy | 45 s |

Stay on Gen's machine (`STAYS_LOCAL`, also in `GET /v1/cpu`): `file.import` (it only files a file), `film.gate` and
`film.plan` (they orchestrate Claude calls and read the library), and `asset.lod`'s bookkeeping (the library's
database). `asset.lod`'s **level making** does go to the service (below).

Adding a CPU tool to the suite: it must import only pure modules (no `db.ts`, `library.ts`, `config` settings), use
only `ctx` (inputs, `tmp`, `emit`, `result`, `python`) and `util.run` for ffmpeg; add it to `CPU_SUITE` with its weight.
`test/cpu-cloudrun.test.ts` checks the image's import closure stays clean, so a tool that reaches for the database
fails the test before it fails in the cloud.

## Design

**A service, not a job per call.** Most CPU calls take seconds; a Cloud Run job execution takes 10-30 s just to start,
which would be most of the bill and all of the wait. A scale-to-zero **service** keeps an instance warm for about 15
minutes after a request, so a burst of calls (an asset.make step, a batch of sprite sheets) pays one start. Every job is
one HTTP request that runs the whole tool; Cloud Run's request limit is 60 minutes, more than any CPU tool takes (the
longest, a long `video.compose`, is minutes), so **no tool needs a Cloud Run job**. If one ever did, it would get a job
the way Unity builds do (`docs/unity-cloudrun.md`).

**Two services from one image, by weight.** One size can't fit both a 2-second resize and a 60-second encode:
- `gen-cpu` (light: 2 vCPU, 4 GiB, **4 requests per instance**, max 10): small work shares an instance, so a burst of
  resizes costs one instance.
- `gen-cpu-heavy` (heavy: 4 vCPU, 8 GiB, **1 request per instance**, max 10): cutouts, encodes and splats get every core,
  and each job's seconds (so its cost) are its own.

A tool goes to its class's URL, else the other one (a pilot with only `gen-cpu` deployed runs everything there).

**The same code.** The service runs the tool's own `run()` (`src/cpu/suite.ts` imports the registered tools), with a
context whose inputs were downloaded from the bucket and whose `emit` writes to it. Gen reads each output back and files
it with its own `ctx.emit`, so outputs, recipes, credits, the library and the levels of detail behave exactly as for a
local run. `python` is the image's venv, ffmpeg the image's.

**Request-based billing.** CPU is allocated only while a request runs (`cpu-throttling: true`), and billed per 100 ms of
request time, plus the instance's start when a request had to wait for one. Idle warm instances cost nothing.

## The protocol

`POST /tool` (Cloud Run's IAM checks Gen's identity first; Gen sends an ID token for the service URL):
```json
{ "key": "<sha256 of job, tool, version, params, input hashes>", "job": "j_...", "tool": "image.cutout", "version": 1,
  "params": {...}, "inputs": { "image": { "uri": "gs://<bucket>/cpu/inputs/<sha256>.png", "name": "hero.png" } },
  "done": 0, "seeds": [], "out": "gs://<bucket>/cpu/runs/<key>/" }
```
The answer streams NDJSON: `step`, `log`, `emit` (`i`, `uri`, `ext`, `mime`, `seed`, `title`, `meta`), `result`,
`usage`, `beat` (every 20 s), then `done` (`seconds`, `cold`, `startupSeconds`) or `error` (`message`; `user` when it is
the tool's own refusal, `stale` when the image's tool is another version).
- **Inputs** go to `cpu/inputs/<sha256><ext>` once per content; their names are kept (tools read extensions).
- **Seeds**: `params.seed` counting up, else derived from the job id (as for GPU jobs on Cloud Run), the same on both sides.
- **Resume**: a finished run leaves `manifest.json` (every event); a retry or a Gen restart replays it without running
  again. Outputs Gen already has are skipped by index on both sides (`done`).
- **A broken stream** is asked again (up to 3 times). **Cancel** closes the request; the service aborts the tool (its
  child processes die, and it stops at its next output) and writes no manifest.
- **Fallback**: if the service can't be reached, answers 5xx, has an older version of the tool, or no instance comes free
  in 10 minutes (429), and nothing was filed yet, **the job runs here** and says so in its log. The tool's own errors
  (bad params) fail the job as they would here.
- `POST /exec` runs the LOD system's commands for `asset.lod` (`lod-images`: post/lod.py on a batch; `lod-mesh`:
  src/lod-mesh.ts on one GLB). Each level comes back to Gen's own `<stem><suffix>` beside the asset, so `saveLevels` and
  everything after it is unchanged; a failure falls back to making them here.

The bucket `gs://<project>-gen-cpu` (us-east4, uniform access, no public access) deletes `cpu/` after 7 days: nothing
lives there, Gen keeps every output in its library.

## Settings

```json
{ "cpu": {
    "backend": "local",
    "tools": { "image.transform": "cloudrun", "asset.lod": "cloudrun" },
    "cloudrun": { "urls": { "light": "https://gen-cpu-....run.app", "heavy": "https://gen-cpu-heavy-....run.app" },
                  "bucket": "hawkes-staging-gen-cpu", "concurrent": 16 } } }
```
- `backend`: `local` (default) or `cloudrun` for every suite tool; `tools` overrides per tool (`asset.lod` too).
- `cloudrun.urls`: `light` and `heavy`; `null` removes one (a patch merges). Without a URL or the bucket, tools run here.
- `cloudrun.concurrent`: jobs sent to Cloud Run at once (the `local-cloud` lane, apart from the local lane's limit).
- `POST /v1/settings` (owner key) changes them; no restart.

`GET /v1/cpu`: every suite tool with where it runs now and why, the two services (size, URL, price per hour), the
prices, what stays local, and the last 100 requests (median wall and billed seconds, cold starts, failures).
A CPU job on Cloud Run shows `server: cloudrun:gen-cpu` and records usage `gcp-cpu` (`instance_seconds`, cost).

## Prices

Request-based billing, Tier 1 (us-east4), as known in 2026 (`service.json`, `verified: false`: check
cloud.google.com/run/pricing): $0.000024 per vCPU-second, $0.0000025 per GiB-second, $0.40 per million requests; free
each month per billing account: 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million requests.

| | Light (2 vCPU, 4 GiB) | Heavy (4 vCPU, 8 GiB) |
|---|---|---|
| Per second while a request runs | $0.000058 | $0.000116 |
| Per hour of requests | $0.21 | $0.42 |

| Typical call | Cost |
|---|---|
| `image.transform` (2 s, light) | $0.0001 |
| `sprite.sheet` (8 s, light) | $0.0005 |
| `image.cutout` (20 s, heavy) | $0.0023 |
| `splat.build` (45 s, heavy) | $0.0052 |
| `video.compose` (60 s, heavy) | $0.0070 |
| a cold start (the request waits for an instance: a few seconds, estimated) | its seconds at the class rate |

A light call billed alone is the upper bound: with 4 requests sharing an instance, Cloud Run bills the instance once.

**At Studio's volume** (an estimate: a day of 300 images' and 30 models' levels, 500 transforms, 100 cutouts, 50 sprite
sheets, 10 cuts) that is about 17,000 vCPU-seconds a day, about **520,000 vCPU-seconds and 1 million GiB-seconds a
month: about $15, or $10 after the free tier**, plus Cloud Storage for a week of inputs and outputs (cents). If Gen
itself still runs outside Google Cloud, outputs leaving Google cost internet transfer (about $0.12/GB: 60 GB a month is
about $7); in-region with Gen on a GCE VM it is free.

**Versus the control server**: today the same work runs on the control server's CPU for no separate bill, but it shares
those cores with Studio, the agents and Talk (a batch of cutouts slows everything), and the server must be sized for the
peaks. On Cloud Run it runs as wide as needed (10 instances per class) and costs nothing when idle, so the control
server can be one size smaller (an e2-standard-2 instead of an e2-standard-4 saves about $50 a month), which more than
pays for it.

## Deploy

J runs (it creates a bucket, a service account and permissions; safe to run again):
```
powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesgen\tools\cpu-cloudrun\deploy.ps1
```
1. `node tools/cpu-cloudrun/build.mjs --project hawkes-staging --apply`: the image (Cloud Build, default machine, about
   10 minutes, a few cents), tagged by the hash of its context.
2. `node tools/cpu-cloudrun/deploy.mjs --project hawkes-staging --setup --apply`: the bucket, `gen-cpu@` (objectAdmin on
   that bucket only), Gen's `gen-control@` (objectAdmin there, `run.invoker` on both services), the two services.
Without `--apply` both print what they would do. `deploy.mjs` ends with the settings patch.

Then, one tool first:
```
POST /v1/settings  { "cpu": { "tools": { "image.transform": "cloudrun" }, "cloudrun": { "urls": { ... }, "bucket": "hawkes-staging-gen-cpu" } } }
```
run a few, read `GET /v1/cpu` (wall and billed seconds, cold starts), then `{ "cpu": { "backend": "cloudrun" } }`.
Gen's credentials must be able to mint ID tokens for the services (`docs/cloudrun.md`, "Credentials").

## What is verified

- Every suite tool's code runs unchanged through the worker: `test/cpu-cloudrun.test.ts` drives Gen's client against the
  real worker over a fake fetch and an in-memory bucket (transform, texture maps, sprite sheet, probe, video.fit cancel,
  LOD images and a GLB, a job through the real queue with its usage).
- The service starts from the build context alone and answers `/healthz` (run locally with this PC's Node and Python).
- Not yet: the image built and run in Cloud Run (cold start time, BiRefNet speed on 4 vCPUs, real billed seconds).
- **BiRefNet's memory** (measured 2026-11-01 on 4 vCPUs, rembg 2.0.86, onnxruntime 1.31, a 1024 px image): about
  8.5 GB at its peak with onnxruntime's memory arena off (`post/cutout.py` turns it off; 9.8 GB with it on), about
  45 s; BiRefNet lite needs about 7 GB; ISNet 1.3 GB and 3 s. So **gen-cpu-heavy's 8 GiB is not enough for BiRefNet**:
  it needs 16 GiB (`service.json`, then a deploy). Until then, and on Gen's own 4 GiB Cloud Run instance, `cutout.py`
  sees there isn't room (`HAWKESGEN_BIREFNET_GB`, default 9) and makes the mask with ISNet, saying so in the job's log
  and the output's `meta.fallback`, instead of being killed mid-run (beta, 2026-11-01: every cutout failed that way).
- **BiRefNet on the GPU instead** (J, 2026-11-01): when a GPU provider can take it now (RunPod, Modal or a Cloud Run GPU
  service in `settings.gpu`; the AWS fleet doesn't count), `image.cutout` in BiRefNet mode hands the call to
  `image.cutout-gpu` at submit (`src/tools/cutout-gpu.ts`). The GPU makes only the mask (the image.remove-background
  workflow's graph, family `birefnet`); glow, crop and pad run on Gen in `cutout.py --mask`, so the result is the same.
  A GPU failure other than "can't take it now" (which moves the job to the next provider) makes the cutout on the CPU
  in the same job, as before. ISNet and union stay on the CPU. `HAWKESGEN_CUTOUT_GPU=0` turns it off.
