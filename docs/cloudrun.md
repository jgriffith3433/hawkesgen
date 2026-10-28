# GPU jobs on Cloud Run

Moving Gen's GPU work off the AWS fleet onto Google Cloud Run GPU services: they scale to zero, bill per second,
and start an instance only when a job arrives. More than half of what the AWS fleet cost over the last 30 days was
servers sitting idle. **Nothing here is deployed.** The code is behind a setting that defaults to the fleet.

| Piece | Where |
|---|---|
| The worker image (ComfyUI + HTTP wrapper) | `server/cloudrun/Dockerfile`, `entrypoint.sh`, `worker.py` |
| Which service runs each family, its GPU, size and models | `server/cloudrun/services.json` |
| Gen's side (routing, the per-graph protocol, cost) | `src/providers/cloudrun/services.ts`, `run.ts`, the GPU lane in `src/jobs.ts` (`fillCloud`) |
| Google credentials and a small Cloud Storage client | `src/providers/gcp/gcs.ts` |
| The library in Google Cloud Storage | `src/storage.ts` (`gcsStore`, `storage.provider: "gcs"`), `tools/storage-copy.mjs` |
| Scripts (dry run unless `--apply`) | `tools/cloudrun/models-sync.mjs`, `build.mjs`, `deploy.mjs` |
| Tests (no Google Cloud needed) | `test/cloudrun.test.ts` |

## Design

**One request runs one graph.** A Gen tool's code stays as it is: it uploads files, runs graphs and downloads
outputs through `ctx.comfy`. On Cloud Run, `ctx.comfy` (`run.ts`) works like this:

- **Upload:** a file goes to `gs://<bucket>/cloudrun/inputs/<sha256><ext>`, once for each content.
- **`runGraph`:** sends one `POST /run` with the graph, the `gs://` URI of every input the graph names, any models
  the service doesn't preload, and the output prefix. Whichever instance takes the request fetches the inputs,
  runs the graph on its own ComfyUI, writes the outputs to `gs://<bucket>/cloudrun/runs/<key>/` and lists them in its
  answer.
- **Download:** reads an output back from the bucket.

A job never needs to reach the same instance twice. For every workflow tool, `image.edit`, `video.i2v` and the other
code-built tools, one graph is one take. A multi-pass tool (a paint pass, then a detail pass) sends one request per
pass, and the pass-1 output goes back up as an input. That costs a few MB of transfer and buys statelessness.

This is a deliberate step back from "the whole job in one request". Doing that would mean running Gen's tool code
inside the container (its library, presets, Claude calls, Python post-processing). Per-graph requests keep one
implementation of every tool, and the 60-minute limit then applies to one graph, not to a whole job.

**The protocol** (`worker.py`, the docstring has the details):

- `GET /ready` is the startup probe. It answers 200 only once the models are in place and ComfyUI answers.
- `POST /run` streams NDJSON:
  - progress lines, at least one every 15 s, so no proxy idles the stream out
  - then one `done` line (the files as `gs://` URIs, the run's seconds, and the cold start if this request paid for
    one), or one `error` line (`lost`, `overLimit`, `missingModels`)
- Concurrency is 1 per instance, and the wrapper serializes too.
- The wrapper fills each node's missing required settings from ComfyUI's own defaults, as `Comfy.prepare` does on
  the fleet.
- A graph that names a model the instance lacks gets it linked from the mounted bucket.

**Idempotent by run key** (`sha256(job id + graph)`):

- **Deterministic seeds.** Jobs on Cloud Run take seeds derived from their id when the caller gave none
  (`jobSeed`), so a job picked up again after a Gen restart rebuilds the same graphs and the same keys.
- **Lookup before running.** Before posting, Gen reads `runs/<key>/manifest.json`. A finished run is answered from
  it without the GPU. If `heartbeat.json` moved in the last minute, the run is still going on some instance, so Gen
  waits for it instead of running it twice.
- **Restarts and dropped connections.** A client that disconnects does not cancel the run. The instance keeps going:
  Cloud Run GPU services use instance-based billing, so CPU stays allocated without a request. When it finishes, it
  leaves its manifest.
- **Cancel.** Cancelling a job writes `runs/<key>/cancel`. The instance checks for it every 5 s and interrupts
  ComfyUI.
- **Run files expire.** The bucket's lifecycle rule deletes everything under `cloudrun/` after 7 days. Outputs are
  in Gen's library by then.

**Routing** (`cloudRoute`). A GPU job goes to its family's service only when every one of these holds:

1. `settings.gpu.families[family]` (or `settings.gpu.backend`) is `cloudrun`.
2. `services.json` maps the family to a service, or `settings.gpu.cloudrun.services` overrides the mapping.
3. That service has a URL in `settings.gpu.cloudrun.urls`, which means it is deployed.
4. `settings.gpu.cloudrun.bucket` is set.
5. The tool isn't marked `server: 'ssh'`.
6. The tool's own `gpuSeconds` estimate for one graph is under `graphLimitSeconds` (3,300 s).

Everything else stays on the AWS fleet, unchanged.

A graph that still runs past the limit comes back with `overLimit`. The job then goes back in line once with
`labels.gpuBackend: "fleet"`.

Each service runs at most `maxInstances` of Gen's jobs at once. That number is both its Cloud Run ceiling and Gen's
lane limit, so Cloud Run never has to queue or refuse Gen's requests. A 429 or 503 is still waited out, for up to 45
minutes. Fair sharing between customer projects (`perProjectGpu`, `fairOrder`) counts Cloud Run jobs and fleet jobs
together.

**Cost per job.** Usage gets a `gcp-gpu` row with unit `instance_seconds`:

- **The amount** is the run's seconds on the instance, plus the cold start when this job's request started the
  instance.
- **The price** is the service's price per second: GPU, plus vCPUs, plus memory, under instance-based billing.
- **What it leaves out:** the idle minutes before Cloud Run scales an instance down belong to no single job. Read
  them from the billing export: the Cloud Run SKUs, minus the sum of the `gcp-gpu` rows.

`job.gpu_seconds` counts run seconds as before, so estimates keep working.

**Credentials.** Gen calls the services with a Google ID token for Gen's service account (`gen-control@…`), which
holds `roles/run.invoker` on each service and nothing broader. No service allows `allUsers`. The tokens come from
Application Default Credentials (`google-auth-library`, the only new dependency):

- **The control server (AWS EC2): workload identity federation from AWS. No key on disk.**
  - Make a pool and an AWS provider for account 028793236279 and the control server's role.
  - Write the config with `gcloud iam workload-identity-pools create-cred-config … --aws --output-file=gcp-wif.json`.
  - Set `GOOGLE_APPLICATION_CREDENTIALS` to that file and `HAWKESGEN_GCP_IMPERSONATE=gen-control@<project>.iam.gserviceaccount.com`.
  - Grant the federated principal `roles/iam.serviceAccountTokenCreator` on `gen-control`.
  - Impersonation is needed because federated and user credentials can't mint Cloud Run ID tokens themselves.
- **J's PC:** run `gcloud auth application-default login`, set the same `HAWKESGEN_GCP_IMPERSONATE`, and give J
  TokenCreator on `gen-control`.

**What the code adds to settings** (all off by default):

```json
{
  "gpu": {
    "backend": "fleet",
    "families": { "z-image": "cloudrun", "qwen-edit": "cloudrun" },
    "cloudrun": {
      "bucket": "hawkes-staging-gen-gpu",
      "urls": { "gen-z-image": "https://gen-z-image-….run.app" },
      "services": {}
    }
  },
  "storage": { "bucket": "…", "provider": "s3" }
}
```

## Models

Google's GPU best-practices page compares four ways to load models:

| Method | Google's guidance |
|---|---|
| Container image | Best below about 10 GB. Every model change rebuilds the image. |
| Cloud Storage FUSE mount | Simplest. Reads lazily. |
| Parallel download from Cloud Storage | Fastest startup, but the files live in the instance's in-memory filesystem and count against its memory. |
| Internet | Slowest and least reliable. |

The guide also recommends Direct VPC egress (all traffic) with Private Google Access for Cloud Storage throughput.
`deploy.mjs --network default --subnet default` sets that up.

Our families are 20 to 95 GB each, so the image holds no models. Every service mounts the bucket read-only at
`/mnt/models` (`only-dir=models`). Each one then picks one of two modes (`load` in `services.json`):

- **`download`**, for busy families whose models fit in memory alongside ComfyUI:
  - Which services: `gen-qwen-edit` (31 GB), `gen-wan` (the wan-i2v set, 39 GB), `gen-3d` (21 GB). All are RTX PRO
    6000 instances with 80 GiB.
  - How: `worker.py` copies the preload list into ComfyUI's models folder with parallel 64 MB range reads (16 per
    file, 4 files at once) before `/ready` passes.
  - Why: every job then runs at full speed from the first one, and the startup probe holds traffic until it does.
- **`mount`**, for big or rarely used sets, and for every L4 service:
  - What it does: models are symlinked from the FUSE mount and read on first use. No memory is used.
  - Why the L4 services: an L4 instance is sized at 32 GiB (Google's recommendation), and z-image's 24 GB of files
    plus ComfyUI's staging copy would not fit in memory.
  - Why the big sets: MiniMax (65 GB), LTX (75 GB) and the other Qwen image models (95 GB) are more than memory
    holds.
  - The cost: the first job on a cold instance reads its models at FUSE speed (pilot: measure it).

Models a job uses beyond the preload list, in either mode, come from the mount, linked by name from the graph. A
`download` service therefore still runs its rarer families, such as wan-animate on `gen-wan`.

`tools/cloudrun/models-sync.mjs` fills `gs://<bucket>/models/<dir>/<file>` from the Hugging Face URLs in
`models.json` and the workflow manifests:

- **What it copies:** every model of every family a service runs, not just its preloads: 86 files, 545 GB, about $11
  a month in one US region.
- **Resumable:** the upload sessions are kept in `.data/cloudrun/models-sync.json`, and an HTTP Range read restarts
  where the bucket left off.
- **No local disk:** it streams from Hugging Face straight into Cloud Storage.

## The service map

These prices are for one instance while it is up, Tier 1 (us-central1), instance-based billing, no zonal redundancy:

| Rate | Price |
|---|---|
| vCPU | $0.000018/s |
| GiB of memory | $0.000002/s |
| L4 | $0.0001867/s ($0.67/h) |
| RTX PRO 6000 | **$0.00036522/s ($1.31/h)**, from cloud.google.com/run/pricing as found 2026-10-28 |

**Check both GPU rates on cloud.google.com/run/pricing before deciding anything** (the page may have changed). The prices sit in `services.json` and the code reads them from there.

**Instance costs:**

| Shape | Price |
|---|---|
| L4 instance: 8 vCPU, 32 GiB | **$1.42/h** |
| RTX PRO 6000 instance: 20 vCPU, 80 GiB (its minimum) | **$3.19/h** |

**The services.** "Last 30 days" is the work they would have taken.

| Service | GPU | Families | Load | Max | Last 30 days | At these rates |
|---|---|---|---|---|---|---|
| `gen-z-image` | L4 | z-image (image.generate, image.control) | mount | 2 | ~1,470 jobs, under 11 h (lora.train stays on the fleet) | under $16 |
| `gen-utility` | L4 | birefnet, sam3, esrgan, film, depth-anything-3, image.geometry, sdpose, image.pose-detect, seedvr2, marigold, ace-step, hunyuan3d, hunyuan3d-mv | mount | 2 | ~2,800 jobs, ~6 h | ~$9 |
| `gen-qwen-edit` | RTX PRO 6000 | qwen-edit | download | 2 | 3,997 jobs, 39.2 h | ~$125 |
| `gen-qwen-image` | RTX PRO 6000 | qwen-image-2512, qwen-edit-2509, qwen-layered | mount | 1 | ~20 jobs, ~1 h | ~$3 |
| `gen-wan` | RTX PRO 6000 | wan-i2v, wan-animate, wan-infinitetalk, wan-t2v, wan-fun-control, wan-animate2, wan21-scail | download (i2v) | 2 | ~820 jobs, 24.5 h | ~$78 |
| `gen-3d` | RTX PRO 6000 | mesh.views3d, trellis2 | download | 2 | 514 jobs, 48.8 h | ~$156 |
| `gen-minimax` | RTX PRO 6000 | minimax-h3 | mount | 1 | 48 jobs, 10.8 h | ~$34 |
| `gen-ltx` | RTX PRO 6000 | ltx-2.3 | mount | 1 | 22 jobs, ~1.5 h | ~$5 |
| `gen-qwen-edit-l4` (pilot alternative) | L4 | none unless settings point qwen-edit at it | mount | 1 | n/a | $1.42/h |

**Read this table carefully.** An RTX PRO 6000 instance ($3.19/h) costs about 1.7 times an AWS L40S server ($1.86/h),
but Cloud Run bills only while a job runs (plus the idle tail below), and the fleet ran at under half utilization:
about $4.10 per hour of useful work. So even before any speed difference the RTX services cost less per useful hour, and
the 96 GB card holds a whole family (both Wan experts, Qwen-Edit with its text encoder) without reloading. All the
services above, at last month's hours, come to roughly $425 plus the idle tail, against $718 for the AWS fleet that month.

The L4 services are clearly cheaper than the fleet. The idle tail adds to every burst: Cloud Run keeps an idle
instance for up to about 10 minutes, billed. That is about $1.06 per RTX instance and $0.24 per L4 instance. With
J's bursty days that is roughly $50 to $250 a month across services.

**The pilot exists to replace these estimates with measured dollars per job.**

Quota: on first deploy in a region, Cloud Run grants 3 L4 and 3 RTX PRO 6000 (no zonal redundancy):

| GPU | Max instances, full map | Default grant |
|---|---|---|
| L4 | 4 | 3 |
| RTX PRO 6000 | 9 | 3 |

**Request increases before going beyond the pilot.** The quota metrics are
`run.googleapis.com/nvidia_l4_gpu_allocation_no_zonal_redundancy` and
`run.googleapis.com/nvidia_rtx_pro_6000_gpu_allocation_no_zonal_redundancy`. The pilot uses 3 L4 (2 + 1 for the
alternative) and 2 RTX.

**Regions.** For Cloud Run services, the RTX PRO 6000 is in us-central1 (not us-east4); the L4 is in both. Put
everything in **us-central1**: the bucket, Artifact Registry and every service. The scripts default to us-east4 as
asked. With that default, `deploy.mjs` moves RTX services to us-central1 and warns about cross-region reads.

## What stays on VMs, and why

| Work | Why |
|---|---|
| `blender.render`, `blender.character` (family blender) | Renders run up to 90 minutes, past Cloud Run's 60-minute request limit. They also run Blender over SSH on the server. Cloud Run *jobs* (not services) allow longer tasks: a later option, once their GPU availability is checked. |
| `mesh.rig`, `motion.from-text` (rig, motion) | Their own venvs, plus Blender, over SSH. |
| The open audio models (`audio:*`: voxcpm2, qwen3-tts, moss…) | One venv each, run by `post/audio/run.py` over SSH. Phase 2: a second worker image with the venvs behind the same `/run` protocol, on L4. |
| `lora.train`, `image.character` (z-image family) | They copy training images and LoRA files to and from the server over SSH. Training takes 22 to 42 minutes. |
| `api-kling`, `api-seedance` | Partner API nodes that wait on someone else's servers. A GPU is wasted on them. Later: the same image on a CPU-only service. |
| Playtests, the Unity build server | Not ComfyUI. Each has its own Cloud Run design: `docs/playtest-cloudrun.md`, `docs/unity-cloudrun.md`. |

These tools carry `server: 'ssh'` (`src/tools/types.ts`), so routing never sends them to Cloud Run, whatever the
settings say.

## Cold starts (expected; the pilot measures them)

| Step | Expected |
|---|---|
| GPU instance with driver | ~5 s (Google's figure) |
| Image (~10 GB: torch cu128 + ComfyUI + nodes; streamed) | 20-90 s, first pull per region slowest |
| Models, `download` (31 GB qwen-edit, 39 GB wan) | 20-60 s at 1-2 GB/s with Direct VPC; slower without |
| ComfyUI start (custom node imports) | 15-30 s |
| First job: models into VRAM | `download`: 10-20 s; `mount`: the FUSE read, 1-3 min for 24 GB |

That gives about **1.5-3 minutes** from the first request to a running job on a cold service. Warm instances take
jobs straight away. The fleet today takes several minutes to start a stopped server. Every request's answer carries
`cold.startupSeconds`, and `worker.py` logs `ready in N s` and each model load's GB/s.

## Moving the library

`src/storage.ts` can keep the library in GCS behind the same `Store` interface: same keys (`sha256/<hash>`), same
Content-Type and Cache-Control. To move it:

1. Make the bucket (private, uniform access).
2. Run `node tools/storage-copy.mjs --to <gcs bucket>`. It is a dry run: it lists both sides and prints the count,
   the GB and the AWS egress cost.
3. Run it again with `--apply`. Interrupted runs resume, and nothing is deleted.
4. Set `storage.provider: "gcs"` and `storage.bucket: <gcs bucket>`.

The CDN setting (`storage.cdn`) points at CloudFront today. Moving it is a separate step.

## Pilot on hawkes-staging: z-image on L4, qwen-edit on RTX PRO 6000

Everything below is J's to approve. It creates billable resources: about 55 GB of storage, about 20 minutes of
Cloud Build, and the instances while they run. A pilot of about 2 RTX hours and 1 L4 hour comes to roughly **$15 to
$20**.

0. **Prerequisites (once).**
   - Install the Google Cloud CLI.
   - Make sure `hawkes-staging` has billing.
   - Run:
     ```
     gcloud config set project hawkes-staging
     gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com storage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com compute.googleapis.com
     gcloud compute networks subnets update default --region=us-central1 --enable-private-ip-google-access
     ```
1. **Models (55 GB).** Run it without `--apply` first to read the plan:
   ```
   node tools/cloudrun/models-sync.mjs --project hawkes-staging --region us-central1 --service gen-z-image,gen-qwen-edit
   node tools/cloudrun/models-sync.mjs --project hawkes-staging --region us-central1 --service gen-z-image,gen-qwen-edit --apply
   ```
   This makes the bucket `hawkes-staging-gen-gpu` with the 7-day rule on `cloudrun/`, then copies.
2. **Image.**
   ```
   node tools/cloudrun/build.mjs --project hawkes-staging --region us-central1 --apply
   ```
3. **Services.** `--setup` makes `gen-gpu-worker@` and `gen-control@` and grants them the bucket:
   ```
   node tools/cloudrun/deploy.mjs --project hawkes-staging --region us-central1 --service gen-z-image,gen-qwen-edit --setup --network default --subnet default --apply
   ```
   It prints the services' URLs and the settings patch.
4. **Credentials, on J's PC first.**
   ```
   gcloud auth application-default login
   gcloud iam service-accounts add-iam-policy-binding gen-control@hawkes-staging.iam.gserviceaccount.com --member=user:<J's Google account> --role=roles/iam.serviceAccountTokenCreator
   ```
   Then add `HAWKESGEN_GCP_IMPERSONATE=gen-control@hawkes-staging.iam.gserviceaccount.com` to `.env`.
5. **Point a local Gen at it** (not gen.hawkesgen.ai):
   ```
   POST /v1/settings {"gpu": {"families": {"z-image": "cloudrun", "qwen-edit": "cloudrun"}, "cloudrun": {"bucket": "hawkes-staging-gen-gpu", "urls": {…from step 3…}}}}
   ```
   Restart Gen.
6. **Measure.** Each one goes in the job's log and in `GET /v1/jobs/:id`:
   - **Cold:** after 15 idle minutes, one `image.generate` and one `image.edit`. Note `cold.startupSeconds`, the job
     time, and `gcloud run services logs read gen-qwen-edit --region us-central1` (`ready in`, model GB/s).
   - **Warm:** 20 of each in a row. Compare per-job time with the fleet's recent jobs (`GET /v1/jobs/timings`).
   - **Burst:** 10 `image.edit` at once. Check that 2 instances start, the rest wait in Gen's lane, and nothing gets
     a 429 storm.
   - **Restart:** restart Gen mid-job. The job should be picked up again and answered from its manifest or heartbeat,
     with no second run.
   - **Cancel:** cancel mid-job. The `cancel` marker appears and the instance log shows the interrupt.
   - **The L4 alternative:**
     ```
     node tools/cloudrun/deploy.mjs --project hawkes-staging --region us-central1 --service gen-qwen-edit-l4 --apply
     ```
     Set `"cloudrun": {"services": {"qwen-edit": "gen-qwen-edit-l4"}, "urls": {"gen-qwen-edit-l4": "…"}}`, repeat the
     warm run, and compare the takes side by side.
   - **Cost:** the `gcp-gpu` usage rows against the billing export after a day. The difference is the idle tail.
7. **Decide per family** from dollars per job and the time a job takes. Afterwards, set the families back to
   `fleet`. Idle services cost nothing beyond storage. Delete them with `gcloud run services delete <name> --region
   us-central1` if the pilot says no.

## Risks and open questions

- **The RTX PRO 6000 price and status.**
  - Price: the rate above is an estimate.
  - Status: some Google pages still call the GPU Preview, which means no SLA and changeable terms.
  - Region: for services it is offered in us-central1 only (in the US).
- **Quota.** The defaults (3 + 3) cover the pilot, not the full map. Request increases before going further.
- **Memory.** It is unverified that the 80 GiB RTX instance holds a `download` service's models (up to 39 GB) next
  to ComfyUI's staging copy. The pilot shows it. If not, switch that service to `mount`.
- **Model licenses.** Nothing is redistributed: the image holds no weights, and the bucket is private. The
  licenses still govern how outputs are used. Check these before customers use them through Cloud Run, as on the
  fleet:
  - Hunyuan3D 2.1: Tencent's community license excludes the EU, UK and South Korea.
  - LTX-2.3: Lightricks' community license.
  - Gemma: the encoder LoRA included.
  - MiniMax-H3.
  - SAM 3.1.
  - Qwen, Wan, Z-Image, TRELLIS, BiRefNet and ESRGAN are permissive (Apache/MIT/BSD).
  - ComfyUI is GPL-3. The image stays in our private Artifact Registry.
- **Flags to confirm on the first deploy.**
  - The startup probe allows 10 minutes (period 10 s × 60). Check Cloud Run's current maximum.
  - The `run.googleapis.com/gpu-zonal-redundancy-disabled` annotation.
  - The `only-dir=models` mount option.
  - The deploy runs `gcloud run services replace` on the generated YAML. `.data/cloudrun/service-*.yaml` holds it for
    review.
- **The idle tail is real money on RTX instances.** It isn't in the per-job usage (see Cost per job).
- **Cross-region.** If anything stays in us-east4 while the RTX services sit in us-central1, model reads pay
  inter-region transfer and are slower.
