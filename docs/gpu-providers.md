# GPU providers

Gen's GPU jobs (every ComfyUI tool) can run in several places. Settings choose them and set the order. When one can't
take a job, the job goes to the next.

| id in the order | What it is | How Gen calls it | Files |
|---|---|---|---|
| `fleet` | The AWS servers (g6e.xlarge, L40S): `src/providers/comfy/fleet.ts`, docs/comfyui.md | ComfyUI behind each server's token proxy | The server's disk; Gen uploads and downloads |
| `cloudrun` | The family's Cloud Run GPU service: docs/cloudrun.md | `POST /run` with a Google ID token | Cloud Storage, with the service's own identity |
| an endpoint id | `settings.gpu.providers`: **RunPod**, **Modal** or any **http** host running the same worker image | `POST /run`, the provider's own auth | Cloud Storage **through Gen's broker** (below): no Google credentials there |

The code is in `src/providers/gpu/`:

- `route.ts`: the order, and what gets skipped and why
- `health.ts`: cooldowns and last errors
- `auth.ts`: each provider's headers
- `broker.ts`, `brokerRoute.ts`, `sign.ts`: the files
- `egress.ts`: reaching the fleet from Cloud Run
- `status.ts`: `GET /v1/gpu/providers`

The queue side is the GPU lane in `src/jobs.ts`. The run protocol is unchanged and shared, in
`src/providers/cloudrun/run.ts` and `server/cloudrun/worker.py`.

## Settings

```jsonc
"gpu": {
  "backend": "fleet", "families": {}, "cloudrun": { ... },          // as before (docs/cloudrun.md)
  "providers": [
    { "id": "runpod", "provider": "runpod", "url": "https://<endpoint id>.api.runpod.ai",
      "families": ["*"], "gpu": "L40S", "pricePerHour": 1.75, "maxConcurrent": 2, "graphLimitSeconds": 300, "enabled": true },
    { "id": "modal", "provider": "modal", "url": "https://<workspace>--hawkes-gen-gpu-worker.modal.run",
      "families": ["*"], "gpu": "L40S", "pricePerHour": 2.40, "maxConcurrent": 2, "graphLimitSeconds": 3300, "enabled": true }
  ],
  "order": ["cloudrun", "runpod", "modal", "fleet"],   // every family
  "familyOrder": { "video": ["modal", "fleet"] }       // one family's own order
},
"fleet": { ..., "egressIp": "", "openComfyPort": false }
```

**No `order` and no `familyOrder` is the old rule, exactly.** A family goes to its Cloud Run service when
`backend`/`families` say `cloudrun` and the service is deployed. Everything else goes to the fleet. A Cloud Run failure
fails the job as before. An existing settings file has neither key, so it behaves as it did.
`test/gpu-providers.test.ts` checks this against `cloudRoute` for every combination.

With an order, each job's providers are taken in that order. A provider is **skipped** when:

- it is cooling down
- this job already failed there (`labels.gpuTried`)
- it is turned off (`enabled: false`)
- it doesn't run the job's family
- one graph may run longer than its `graphLimitSeconds`
- its key isn't in Gen's environment
- `settings.gpu.cloudrun.bucket` or `HAWKESGEN_PUBLIC_URL` is missing (the broker needs both)
- for `fleet` only: the fleet can't be reached from here (below)

Tools that work over SSH (`server: 'ssh'`: Blender, rigging, motion) and jobs labelled `gpuBackend: "fleet"` always go to
the fleet.

The job takes the first provider that has room. Room is the endpoint's `maxConcurrent` jobs at once, or Cloud Run's
`maxInstances`. When every provider has room taken, the job waits for the first one.

**Fallback.** These make a provider **cool down**, and the job goes back in the line for the next provider:

| What happened | Cooldown |
|---|---|
| No GPU free within 3 minutes (429/503 the whole time) | 5 min |
| Unreachable | 10 min |
| 401/403: our key refused | 30 min |

When every provider in the order has been tried, the job's tried list is cleared. It then waits ("no GPU provider can
take it now: …", with each reason) and tries again once one is back.

Cooldowns live in memory, so a restart gives every provider a new chance. A successful run clears the provider's cooldown.

**The AWS fleet cools down quietly.** It gets one 30-minute cooldown, instead of an error on every job, when:

- AWS refuses Gen's credentials (invalid, expired, the account suspended or not opted in: `health.ts awsRefused`)
- the fleet can't be reached from Cloud Run

With an order set, its jobs go to the next provider. With no order, the fleet is still the only place. If it is
unreachable, its jobs wait with that one message, and auto start doesn't run.

The dashboard's **Settings > GPU providers** card lists every provider in order, with:

- its kind, host, GPU and $/hour
- the families it runs
- ready, or why not (not set up, or cooling down until when, and why)
- its last error

It can change the order and turn endpoints on or off. `GET /v1/gpu/providers` (admin) returns the same as JSON.

A job's `server` names where it ran (`runpod:runpod`, `cloudrun:gen-z-image`). Its usage row is
`<provider>-gpu` (`runpod-gpu`, `modal-gpu`, `http-gpu`) or `gcp-gpu`, priced at the endpoint's `pricePerHour` for the
seconds the runs took.

## Files: the broker (no Google credentials elsewhere)

A worker on RunPod or Modal has no Google identity, and none is given to it. Each request names the run and carries:

```json
"store": { "broker": "https://<Gen>/v1/gpu/broker", "token": "<run key>.<bucket>.<expiry>.<HMAC>" }
```

The worker (`STORAGE=broker`) then makes every Cloud Storage call of that run through Gen:

| Request | Answer |
|---|---|
| `GET ?op=stat&uri=gs://…` | size, or 404 |
| `GET ?op=url&uri=…` | a **V4 signed URL** valid 15 minutes, or `{proxy: true}` when Gen can't sign |
| `GET ?op=read&uri=…` | the bytes through Gen, with Range |
| `PUT ?op=write&uri=…` | outputs, heartbeat, manifest |

The worker downloads models and inputs straight from Cloud Storage with the signed URL, in parallel ranged reads like on
Cloud Run, so gigabytes never pass through Gen.

- **The token** is signed by Gen with a key in `.data/gpu-broker.key` and lasts 6 hours.
  - It may read and write `gs://<bucket>/cloudrun/runs/<its run key>/`.
  - It may only read `cloudrun/inputs/` and `models/`.
  - It can do nothing else. A path with `..` is refused, and so is another bucket.
  - Gen's ordinary key check doesn't apply to this route: the token is the credential.
- **Signing** uses IAM `signBlob`, signing as Gen's own service account, so no private key exists anywhere.
  - On Cloud Run the account comes from the metadata server. `tools/gen-cloudrun/deploy.mjs` grants it
    `roles/iam.serviceAccountTokenCreator` on itself.
  - On J's PC, `HAWKESGEN_GCP_IMPERSONATE` names the account.
  - Without either, the broker streams the files through Gen instead (slower for models, but it works).
- The manifest, heartbeat and cancel files are the same objects Gen reads for Cloud Run. So resume after a restart, a
  dropped stream, waiting on a running graph and cancel all work unchanged.
- The worker also answers `GET /ping` (RunPod's health check: 200 when ready, 204 while starting).
- When `WORKER_TOKEN` is set, it refuses `POST /run` without `X-Hawkes-Worker-Token`. That is Gen's `GPU_WORKER_TOKEN`:
  an extra lock on top of the provider's own auth.

**Long graphs.** Both providers end an HTTP request before a long graph finishes:

- RunPod's load balancer ends one at 5.5 minutes. (A WebSocket is not cut there: one held 12 minutes in a test on
  2026-10-29; playtests use that, docs/playtest-runpod.md.)
- Modal's web endpoints end one at 150 s and answer a 303.

The worker keeps running when the request ends. Gen then follows the run by its heartbeat and takes the manifest. That is
the same path a dropped Cloud Run stream takes. But a host may stop an instance that has no request open:

- **Modal:** the generated app keeps containers 20 minutes after the last request (`scaledown_window=1200`).
- **RunPod:** idle workers stop after the endpoint's idle timeout. So RunPod endpoints default to `graphLimitSeconds: 300`,
  and longer graphs (video) go to the next provider.

## Secrets

All of these live in Gen's environment, mounted from Secret Manager by `tools/gen-cloudrun/deploy.mjs` when they are in
`hawkesgen/.env`. They are never printed or committed.

| Variable | For |
|---|---|
| `RUNPOD_API_KEY` | `Authorization: Bearer` to the RunPod endpoint |
| `MODAL_PROXY_KEY`, `MODAL_PROXY_SECRET` | `Modal-Key` / `Modal-Secret` (a Modal proxy auth token) |
| `GPU_HTTP_TOKEN` | `Authorization: Bearer` to an `http` endpoint |
| `GPU_WORKER_TOKEN` | optional; sent as `X-Hawkes-Worker-Token`, checked by the worker's `WORKER_TOKEN` |
| `HAWKESGEN_PUBLIC_URL` | where workers reach the broker (deploy.mjs already sets it) |

An endpoint whose key is missing shows "… not set" and is skipped. An endpoint that answers 401/403 cools down for 30 minutes.

## Models: from Hugging Face now, provider volumes later

**Now** (J, 2026-10-29: "for now, download from hugging face"): a model a job needs that isn't in the models bucket is
downloaded by the worker straight from its public URL in `server/models.json`. The broker's `url` and `stat` answer
with that URL and its size (`brokerRoute.ts modelSource`); the worker downloads it in parallel ranges like a signed URL
(checked: Hugging Face's CDN honours ranges through the redirect). Free egress, nothing to store or keep in sync. The cost
is time: each cold worker downloads its job's models first (Z-Image about 24 GB, a minute or two). A model in the bucket
still wins. New models: add them to `models.json` with a public `url`.

**Later, when cold starts should be faster (J agreed the shape, not started):** one endpoint and one volume per kind of
work, so the models sit next to the GPU (the AWS fleet baked them into its AMI; a provider volume is the equivalent, the
container image stays small). Gen already routes by family (`families` on each `settings.gpu.providers` entry).

| Endpoint | Families | Provider | GPU | Volume |
|---|---|---|---|---|
| image | z-image, qwen-image / qwen-edit, utility (cutout, depth, upscale, segment, pose) | RunPod (load balancer: requests end at 5.5 min) | L40S | ~120 GB, ~$8/month |
| 3D | trellis2, hunyuan3d, multi-view | RunPod | L40S | ~50 GB, ~$3.50/month |
| video | wan (i2v, animate, infinitetalk, t2v, control), ltx-2.3, minimax-h3 | Modal (requests up to ~55 min) | L40S, or 80 GB if Wan needs it | ~200 GB |
| audio | ACE-Step, Stable Audio 3, Qwen3-TTS (its venv is in the worker image; docs/audio.md "Where it runs") | any | 24 GB card | ~35 GB with the Hugging Face cache at `MODELS_MOUNT/hf` |

The work: a fill job per volume (Hugging Face into the volume: a cheap RunPod CPU pod, a Modal function), MODEL_LOAD
mount with MODELS_MOUNT on each endpoint, one settings entry per endpoint with its families. A family lives on one
provider (no fallback across them unless its models are copied to both). RunPod volumes tie an endpoint to one
datacenter: pick one with L40S to spare.

## The image

**A new image on RunPod** (2026-10-30): `node tools/gpu-providers/runpod.mjs --image ghcr.io/jgriffith3433/hawkes-gen-gpu:<tag>
--update <endpoint id> --apply` swaps the image in the endpoint's own template (env, worker token and disk kept). New workers
start on it, but **RunPod keeps reusing a warm worker on the old image** (FlashBoot): add `--recycle` to end those (a job
running on one is cut off and retried). The tag is `<comfy tag>-<context hash>` (`image-context.mjs` prints it; line endings
don't count, so a Windows checkout names the tag GitHub's build pushes). Check it exists before pointing an endpoint at it
(`docker manifest inspect`): a missing tag leaves every new worker unhealthy and RunPod holds requests until they time out.
The first start on a host pulls about 6 GB, minutes: Gen waits up to 12 minutes past its usual wait for headers
(`run.ts COLD_START_MS`), and RunPod's 400 "failed to assign worker" (no GPU of its types free) waits like a busy service.
Modal's app file (`.data/modal/modal_app.py`) is rewritten by `modal.mjs --image ...`; deploying it needs the modal CLI.

It is the Cloud Run GPU image (`server/cloudrun/`, built by `tools/cloudrun/build.mjs` in Cloud Build). It holds ComfyUI
and its custom nodes, no models and no secrets. Models come per request through the broker, or from a network volume
mounted at `MODELS_MOUNT`.

RunPod and Modal can't read Google's Artifact Registry without a Google key, so they pull it from GHCR. **Build it
there by pushing a tag** `gpu-image-<anything>` (or run the "GPU image" workflow by hand):
`.github/workflows/gpu-image.yml` writes the same build folder (`tools/gpu-providers/image-context.mjs`) and pushes
`ghcr.io/jgriffith3433/hawkes-gen-gpu:<comfy tag>-<context hash>` and `:latest` with GitHub's own token. The package
starts private: give RunPod/Modal a GitHub read token (`read:packages`) as registry auth, or make the package public
(it holds no keys and no models). Or copy an image Cloud Build already made, with `crane`:

```bash
crane copy us-east4-docker.pkg.dev/hawkes-staging/hawkes-gen/gen-gpu:<tag> ghcr.io/jgriffith3433/hawkes-gen-gpu:<tag>
```

Put the result in `GPU_WORKER_IMAGE` in `.env`, or pass it with `--image`.

## Setting up a provider

Each script prints what it would do. `--apply` changes things (J's call: provider accounts, keys and deploys are his).

### RunPod (`tools/gpu-providers/runpod.mjs`)

1. Make a RunPod account, add credit and create an API key. Put it in `hawkesgen/.env` as `RUNPOD_API_KEY`.
2. Run `node tools/gpu-providers/runpod.mjs --image ghcr.io/…:<tag> --apply`. It creates the serverless template:
   - port 8080
   - `PORT` and `PORT_HEALTH` 8080
   - `STORAGE=broker`, `MODEL_LOAD=none`
   - `WORKER_TOKEN`, when `GPU_WORKER_TOKEN` is in .env
3. In RunPod's console, go to **Serverless > New Endpoint**:
   - import the template
   - endpoint type **Load balancer** (RunPod's REST API has no field for this type, checked 2026-10-28; its GraphQL
     `saveEndpoint` does take `type: "LB"`, as `tools/playtest-runpod/setup.mjs` uses, 2026-10-29)
   - GPU: L40S
   - workers 0 to 2, idle timeout 600 s, FlashBoot on
   - health path `/ping`
   - optional: a network volume at `/mnt/models`
4. Run `node tools/gpu-providers/runpod.mjs --image … --endpoint <endpoint id>`. It prints the settings entry. Add it with
   `POST /v1/settings` (keep any endpoints already there) and put `runpod` in `gpu.order`.
5. Deploy Gen (`tools/gen-cloudrun/deploy.ps1`). It mounts `RUNPOD_API_KEY`.

### Modal (`tools/gpu-providers/modal.mjs`)

1. Make a Modal account and install the CLI: `pip install modal`, then `modal setup`.
2. Create a **proxy auth token** (Modal dashboard > Settings > Proxy Auth Tokens). Put it in `hawkesgen/.env` as
   `MODAL_PROXY_KEY` and `MODAL_PROXY_SECRET`.
3. Run `node tools/gpu-providers/modal.mjs --image ghcr.io/…:<tag> --apply`. It:
   - writes `.data/modal/modal_app.py`: `@modal.web_server(8080, requires_proxy_auth=True)`, L40S, 4 cores, 32 GiB, at
     most 2 containers, kept 20 minutes
   - puts `GPU_WORKER_TOKEN` in the Modal secret `hawkes-gen-worker`
   - runs `modal deploy`

   For a private GHCR image, also pass `--registry-secret <a Modal secret with REGISTRY_USERNAME/PASSWORD>`.
4. Run it again with `--url <the web endpoint URL>`. It prints the settings entry. Add it and put `modal` in `gpu.order`.
5. Deploy Gen. It mounts `MODAL_PROXY_KEY` and `MODAL_PROXY_SECRET`.

### Any other host (`http`)

Run the image anywhere with a GPU:

- `PORT=8080`, `STORAGE=broker`, `MODEL_LOAD=none`
- optionally `WORKER_TOKEN`
- behind HTTPS that checks `Authorization: Bearer <GPU_HTTP_TOKEN>`, or rely on `WORKER_TOKEN`, sent as
  `X-Hawkes-Worker-Token`

Add `{ "id": "…", "provider": "http", "url": "https://…" , … }`.

## The fleet from Cloud Run

On Cloud Run, Gen reaches AWS without keys. The metadata server's Google ID token (audience `hawkes-control-aws`) is
traded with STS for the role `hawkes/hawkes-control-gce` (`AssumeRoleWithWebIdentity`, `src/providers/gceaws.ts`).
`fleet.ts awsConfig()` uses that when `HAWKES_AWS_FEDERATION=gce` (the control VM) or when it runs on Cloud Run with
`HAWKES_AWS_ROLE_ARN`. On J's PC the `.env` keys work as before.

**J's AWS step (once).** Run `node deploy/gcp/aws-federation.mjs --apply` with AWS admin credentials. The role's trust
policy now has two statements:

- the control VM's account (`hawkes-control@hawkes-prod`)
- **Gen on Cloud Run's account** (`gen-control@hawkes-staging`)

Each pins its own unique id as both `aud` and `sub`, and the audience. The script finds the id with gcloud, or takes
`--gen-sa-id <number>`. Then deploy Gen with `--aws-role arn:aws:iam::028793236279:role/hawkes/hawkes-control-gce`, or
put `HAWKES_AWS_ROLE_ARN` in .env.

**Reaching the servers.** Their security groups open the ComfyUI proxy and SSH to one address (`refreshAccess`), and
Cloud Run has no fixed address. There are two ways:

- **(a) A fixed egress IP (recommended).** Cloud Run Direct VPC egress through Cloud NAT with a reserved static address.
  - Set it up with `node tools/gpu-providers/egress.mjs` (prints the gcloud commands), then `--apply`.
  - Then set `settings.fleet.egressIp` to the address (or deploy with `--egress-ip`, which sets `HAWKES_PUBLIC_IP`).
  - `refreshAccess` and launches let that address in. It stays in when J's PC refreshes the groups too (`allowedIps`).
  - Cost (cloud.google.com/vpc/network-pricing, cloud.google.com/nat/pricing): the static IP about $0.005/hour
    (~$3.65/month), Cloud NAT about $0.0014/hour plus $0.045/GB processed. Direct VPC egress itself is free.
  - Gen's traffic to the fleet is graphs, small inputs and outputs: cents a month.
- **(b) The ComfyUI port open to everyone, behind each server's token.** This is `settings.fleet.openComfyPort: true`, an
  explicit setting that is off by default.
  - Only the proxy port opens to `0.0.0.0/0`. SSH stays limited to the known addresses.
  - SSH-based work from Cloud Run (model installs, Blender, rigging) still needs (a).

With neither, Gen on Cloud Run **refuses to open the security group**. The fleet shows "Gen runs on Cloud Run, which has
no fixed address…" and is skipped, so jobs go to the next provider in the order.

## Prices (per hour of GPU while a job runs)

| Where | GPU | $/hour | Source |
|---|---|---|---|
| AWS fleet | L40S 48 GB (g6e.xlarge) | ~1.86 on demand, plus ~$43/month disk per server | AGENTS.md, `fleet.ts TYPES` |
| Cloud Run | L4 24 GB (+ vCPU, memory) | from `services.json` (`pricePerSecond`) | docs/cloudrun.md |
| RunPod Serverless | L40S / L40 / 6000 Ada 48 GB | 1.75 | runpod.io/pricing, 2026-10-28 |
| RunPod Serverless | A6000 / A40 48 GB | 1.22 | same |
| RunPod Serverless | A100 80 GB | 2.72 | same |
| RunPod Serverless | H100 80 GB | 4.79 | same |
| RunPod Serverless | L4 / A5000 / 3090 24 GB | 0.69 | same |
| Modal | L40S | 1.95 GPU ($0.000542/s), about 2.40 with 4 cores and 32 GiB | modal.com/pricing, 2026-10-28 |
| Modal | L4 | 0.80 ($0.000222/s) | same |
| Modal | A100 80 GB | 2.50 ($0.000694/s) | same |
| Modal | H100 | 3.95 ($0.001097/s) | same |

Modal also bills CPU at $0.0000131 per physical core-second and memory at $0.00000222 per GiB-second.
RunPod's page shows one hourly rate per tier. Its flex and active per-second rates are in its console.
Both bill only while a worker runs: scale to zero.
