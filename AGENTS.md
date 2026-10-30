# Hawkes Gen — agent guide

**Lanes, local dev and deploys:** `LANES.md` (branches dev -> beta -> main; `dev.bat`, `deploy-beta.bat`, `deploy-prod.bat`, `status.bat`, `links.bat`, `sync.bat`; beta and live links).

The shared generative-AI service for every Hawkes Biomedical game and site. Games describe **what** they want
(edit this image, a clip from this pose, a material, a song, speak this line, answer as JSON). Hawkes Gen
decides **how**: which GPU server, which ComfyUI workflow and models, which API. It keeps the result and the
recipe that made it. Projects never touch AWS, ComfyUI or API keys.

- `README.md` is the overview and the tool list.
- `docs/art-playbook.md` is the art playbook: which tool for which job, recipes, performance budgets. Read it before making game art.
- `docs/workflows.md` covers ComfyUI workflows as tools.
- **What Gen knows about its tools** (`src/knowledge.ts`, `knowledge/tools.json`; J, 2026-10-29: "having knowledge of how
  models, workflows, and helper nodes and all parameters in the nodes all work together and what people have done to keep
  iterating on them ... expose all that in a way that's useful and not overwhelming to both the user and the AI"). A tool's
  card (`GET /v1/knowledge/tools/:id`) joins its own description, its workflow folder (models, every graph node, every
  literal setting, which param or input drives which node, which settings can change) and the craft notes in
  `knowledge/tools.json` (role, what each input is in the picture, how the settings pull on each other, what to change
  when a result is wrong, what it pairs with, whether it was measured). **Add notes when you learn something about a
  tool** (a setting that fixed a result, a pairing that works): that file is where the craft lives, and the app and the AI
  read it as it changes (`test/knowledge.test.ts` checks every key is a real param, input or editable node setting).
  `toolMap` is one line per tool for the AI; `toolCraft` the full notes and node settings of a few tools.
- **Every node setting** (`src/workflows/tool.ts` `nodeSettings`, `applyNodeOverrides`): a workflow tool takes
  `params.nodes` `{ "<node>.<input>": value }` for any literal setting on its graph's nodes (sampler, scheduler, a LoRA's
  `strength_model`, a guide's frame, a decode's tile size...). Files, models, prompts and paths stay locked; a setting a
  param drives is changed through the param; the type must match. They are part of the recipe, so a take is reproducible.
- `docs/api.md` lists every route.
- `docs/comfyui.md` records what works on the GPU servers.
- `docs/playtest-runpod.md` covers **playtests on a real GPU on RunPod** (`backend: "runpod"`): the same browser image on a RunPod serverless load-balancer endpoint (WebSockets held 12+ minutes there), the driver's graphics libraries fetched when a host lacks them, the CPU service as fallback, what was measured (DoD 52 fps, Yooba Land 54 fps, about $0.01 a smoke run), `tools/playtest-runpod/setup.mjs` and J's steps.
- `docs/playtest-cloudrun.md` covers playtests on Cloud Run (the L4 browser service, how WebGL gets the GPU, local builds through the connection, cost per playtest, the pilot) and **the CPU service `gen-playtest-cpu`** (no GPU: WebGL on SwiftShader, `backend: "cloudrun-cpu"`, one tab per 4 vCPU instance, request-based billing at about $0.007 a playtest minute, what was measured, J's `deploy-cpu.ps1`).
- `docs/cloudrun.md` covers GPU jobs on Google Cloud Run (scale to zero): the worker image (`server/cloudrun/`), the family → service map (`services.json`), routing by `settings.gpu` (fleet stays the default), the per-graph request protocol, the scripts in `tools/cloudrun/` (dry run unless `--apply`; deploying needs J's OK) and the pilot steps.
- `docs/gpu-providers.md` covers GPU jobs on more than one provider: `settings.gpu.order` / `familyOrder` over `fleet`, `cloudrun` and endpoints in `settings.gpu.providers` (RunPod, Modal, any HTTPS host running the worker image), cooldowns and fallback, the storage broker (workers elsewhere get no Google credentials: a run token and V4 signed URLs), the fleet from Cloud Run (keyless AWS, a fixed egress IP or `fleet.openComfyPort`), prices, and the setup scripts in `tools/gpu-providers/` (print first, `--apply` to change). No order set: the old rule, unchanged.
- `docs/cpu-cloudrun.md` covers the CPU suite on Cloud Run: the CPU tools (cutout, transform, sprite sheets, maps, probe, video fit/compose/matte/composite/control-mix, splats, LOD levels) on the scale-to-zero services gen-cpu and gen-cpu-heavy, the same tool code (`src/cpu/`), routing by `settings.cpu` (local stays the default), the protocol, fallback to here, prices, `GET /v1/cpu`, and `tools/cpu-cloudrun/` (J's `deploy.ps1`).
- `docs/blender.md` covers Blender shots to video (`blender.render`, `video.control`) and rigging generated characters (`mesh.rig`).
- `docs/film-pipeline.md` covers the film pipeline: shots with beats and props in hands, the director gate (`film.gate`), the cinema, dialogue, VFX-layer and LoRA recipes (`film.plan`), the trailer cut and what a trailer costs. **Making a trailer, a cutscene or any shot with Blender as the motion rig: start with `film.plan`, run `film.gate` before spending GPU.**
- `docs/3d-characters.md` covers `blender.character` (clean, bake, props, retarget, clip edits, FBX/GLB), the `character3d` kind, the CC0 Quaternius motion library (`motion:<pack>/<clip>`, preset `shared/motions`), and `motion.from-text` (Kimodo SOMA / HY-Motion).
- **Hawkes Net** (multiplayer) is its own repo since 2026-10-26: `jgriffith3433/hawkesnet` (C:\Projects\hawkesnet: the service, the relay, the SDK `@hawkesgen/net` and the Unity package; its design is its `docs/net.md`). Gen keeps only its bridge, `src/netbridge.ts`.
- `docs/audio.md` covers the sound suite: open voice/SFX models on the fleet (primary), ElevenLabs (secondary), `provider` routing, the Gen voice library, direction, post-processing, the audition (`tools/audition.mjs`) and what still needs a GPU run.
- `docs/library.md` covers the library every product builds on: entities, slots, versions, slot references, make/revise/pick.
- `docs/analytics.md` is the player-analytics contract (events every product sends, the collect door, the queries).
- `DESIGN.md` has J's decisions and the roadmap.
- `CLAUDE.md` just imports this file; edit this one.

**Deploys:** this folder is the private repo `jgriffith3433/hawkesgen`. Every push to `main` deploys it to the cloud
(hawkesgen.ai): CI (`.github/workflows/ci.yml`: typecheck and tests) must pass, then the control server pulls it
within a few minutes, waiting while jobs run (`hawkesstudio/deploy/hawkes-pull.mjs`). Push to main only with J's OK,
after `npm run typecheck` and `npm test`; commit only your own files (other sessions edit here too). Roll back with
`git revert` + push. Details: `hawkesstudio/docs/cloud.md` ("How code gets to the server").

The owner is **J**. Do not commit unless asked. Anything that costs money needs J's OK first: launching or
starting GPU servers, syncing core models, big generation batches. A single test run on a server that is
already running costs cents. **Price it first:** `POST /v1/estimate` (MCP `hawkesgen_estimate`) turns a planned batch into
GPU hours and dollars from this service's own job history (`src/estimate.ts`); put that number in the question to J.
**Never pay twice:** submit with `reuse` (asset.make does on every step) so a recipe the library already has comes back
from it.

## Run

```bash
auto-start.bat            # or: npm start   ->  http://127.0.0.1:8790 (dashboard + /v1 API)
auto-stop.bat             # running jobs resume on the next start
npm run typecheck         # tsc, no emit
npm test                  # workflows, presets and the converter (offline, uses .data/comfy-cache)
hawkesgen.cmd status      # CLI (or: node bin/hawkesgen.mjs ...)
node bin/hawkesgen-mcp.mjs   # the MCP server (projects' .mcp.json start it)
```

Node 24 runs the TypeScript in `src/` directly (type stripping): **erasable syntax only** (no enums, no
namespaces, no parameter properties), and imports end in `.ts`. Python tools run in `.venv` (rembg, Pillow,
numpy). Secrets are in `.env` (gitignored; `.env.example` lists them). **Restart the service after changing
`src/`.** Workflows and presets reload without a restart (`POST /v1/workflows/reload`; presets are read on
each job).

## Layout

| Path | What |
|---|---|
| `src/server.ts`, `src/api.ts` | HTTP server on :8790; every `/v1` route and the dashboard's files |
| `src/jobs.ts` | The queue: lanes per provider, GPU scheduling by model family, model installs, resume after restart, job keys, presets applied on submit |
| `src/tools/` | Tools written in code. `types.ts` (what a tool is), `comfy.ts` (image.edit, image.paint, video.i2v, video.animate, comfy.graph), `api.ts` (ElevenLabs voice, sfx and voice design; Claude), `local.ts` (this PC), `compose.ts` (video.compose: the finished cut with ffmpeg), `edit.ts` (image.repaint, image.expand: Qwen-Image-Edit on a crop or a padded canvas, composited with Pillow in `post/edit.py`), `media.ts` (video.frame, video.still, media.normalize and the upload check), `chain.ts` (video.change, audio.revoice: pipeline tools that queue child jobs like asset.make, on Gen's key, priced once at the parent), `index.ts` (the list, plus every workflow folder) |
| `src/workflows/` | `convert.ts` (ComfyUI UI → API format, and checks), `registry.ts` (workflow folders, draft manifests), `tool.ts` (a folder as a Tool), `catalog.ts` (the template library cached from a server; import) |
| `workflows/` | **The workflow tools** (manifest + graph + source each): image.generate, image.angles, image.upscale, image.panorama, image.depth, image.normals, image.albedo, image.remove-background, image.segment, video.t2v, video.control, video.control-wan, video.upscale, video.interpolate, mesh.views3d (the way images become 3D: always more than one view, see docs/3d-characters.md), mesh.from-image, mesh.textured and mesh.from-views (deprecated; single image refused without allowSingleView), audio.music |
| `presets/<project>.json` | Each project's art direction: style line, negative, named presets (tool + prompt template + params) |
| `src/presets.ts` | Loading and applying presets |
| `src/providers/comfy/` | `fleet.ts` (AWS launch/start/stop/adopt, SSH, model install/prune), `client.ts` (ComfyUI HTTP), `graphs.ts` (the code-built graphs), `retry.ts` (keep trying) |
| `src/providers/builder/builder.ts` | The Unity build server: launch (Windows + Unity via `server/builder/bootstrap.ps1`), start/stop, SSH, incremental sync of `C:\Projects` folders, detached builds (`server/builder/build.ps1`), pulling the build back |
| `src/film/`, `src/tools/film.ts`, `src/tools/film-video.ts` | The film pipeline (docs/film-pipeline.md): `shot.ts` (beats to a timeline, anti-overlap, the lint, the gate's bounded fixes), `gate.ts` (the rubric, the numbers, the adjust-and-look-again loop), `recipes.ts` (cinema pass, dialogue close-up, VFX layers, LoRA, trailer cut: all return `asset.make` params). Tools: `film.gate`, `film.plan`, `video.matte`, `video.composite`, `video.control-mix` |
| `src/tools/blender.ts`, `src/providers/blender/` | `blender.render`: Blender 5.0 on a GPU server (installed on first use; `install.ts` is shared with `bootstrap.sh`), a job workspace in `/var/tmp/hawkes-blender`, a detached render followed over SSH. The scripts are `post/blender/hawkes_blender.py` (inside Blender) and `post/pose_draw.py`. `src/tools/rig.ts` is `mesh.rig` (family `rig`: Make-It-Animatable and SkinTokens in their own venvs, installed on first use, then Blender for the walk; `post/rig/`, `post/blender/hawkes_rig.py`); `src/tools/character.ts` is `blender.character` (`post/blender/hawkes_character.py`: named ops only, checked by `checkOps` before a server is claimed); `src/tools/motion.ts` is `motion.from-text` (family `motion`: Kimodo SOMA + HY-Motion fallback in `/opt/hawkes-motion`, then retarget via blender.character; `post/motion/`) |
| `src/tools/local.ts` `sprite.sheet`, `image.transform` | sprite.sheet: a clip (or frames) to a game sprite sheet with ffmpeg (frames spread evenly, a flat background keyed to transparency with colorkey + despill, the PNG atlas, frame JSON (TexturePacker hash), a GIF; `loop` drops the repeated last frame). image.transform: `post/transform.py` (Pillow), steps in order: resize, scale, crop, trim, pad, square, pot, flip, rotate, pixelate, colors, outline, tint, grayscale |
| `src/tools/threed.ts`, `viewsheet.ts` | The "always more than one view" rule (refusals, deprecation notices, tool order) and `image.viewsheet` (back/left/right views, Claude's consistency check, the sheet) |
| `src/tools/build.ts`, `playtest.ts`, `pipeline.ts` | `unity.build`; `playtest.run` (Playwright, or a native runner for desktop targets) and `playtest.review` (Claude); `asset.make` (chains, best-of-N with canon and references, library reuse) |
| `src/providers/playtester/` | Where playtests play: `playtester.ts` (the EC2 playtesters), `cloudrun.ts` (the browser services: RunPod, Cloud Run L4 and CPU), `intake.ts` (customers' builds, SSRF checks, the GitHub token vault, staging), `runners.ts` (the runner router), `native.ts` (the session protocol to native runners). docs/playtest-runners.md |
| `src/analytics/`, `analytics/products.json` | Player analytics (docs/analytics.md): `collect.ts` (the public door: validation, limits, CORS, rate limit), `geo.ts` + `mmdb.ts` (DB-IP Lite GeoIP), `ua.ts`, `store.ts` (`.data/analytics.db`: events, sessions, daily rollups, the purge), `query.ts` + `routes.ts` (the reads). The registry lists each product's origins |
| `src/netbridge.ts` | **Hawkes Net's bridge.** Hawkes Net (multiplayer, `https://net.hawkesgen.ai`) is its own repo, `jgriffith3433/hawkesnet`. Gen's whole part: `GET /v1/net/whoami` (the box checks API keys with it), `POST /v1/net/usage` (the box's usage into Gen's usage table) and a 308 to the box for the rest of `/v1/net/` and the SDK files (`/sdk/hawkes-net*.mjs`). Test `test/netbridge.test.ts` |
| `src/estimate.ts` | Cost estimates for a planned batch (`POST /v1/estimate`) |
| `src/machines.ts` | The Machines monitor (`GET /v1/machines`, the dashboard tab): the GPU servers, build server and playtester measured over SSH (CPU, memory, GPU, disk, network, idle clock) every minute while running, 7 days of history in `machine_samples`, and the alerts |
| `src/providers/elevenlabs.ts`, `anthropic.ts`, `cursor.ts` | API clients. Every writing call goes through `anthropic.ts` `ask()`. `settings.brain` `cursor` runs Cursor's `agent` on the Cursor plan (`cursor.ts`, `CURSOR_API_KEY`, model Grok 4.7). `copilot` runs the GitHub Copilot CLI (`copilot.ts`, `copilot -p --output-format json`, `COPILOT_GITHUB_TOKEN` or a server login, $0, usage as `copilot`). `claude` runs Claude Code on J's Max plan by default (`claudecode.ts`: `claude -p`, stream-json, $0, usage as `max-plan`, capped by `settings.claude`); `settings.claude.backend: "api"` brings back the API key |
| `src/audio/`, `src/providers/audio/`, `src/tools/audio-open.ts`, `post/audio/`, `tools/audition.mjs` | **The sound suite** (docs/audio.md): `registry.ts` (open models, licenses, refused ones), `direction.ts` (direction mapped per model), `plan.ts` (model pick, `routeAudio`: audio.voice/sfx/dialogue/... hand a call to the open twin via `Tool.route` at submit), `voicelib.ts` (Gen voices `gv_`, table `audio_voices`), `post.ts` (ffmpeg: LUFS, clipping, silence, loops), `verify.ts` (word error rate). GPU side: one venv per model under `/opt/hawkes-audio` installed by a detached, verified, resumable unit, run by `post/audio/run.py`. `HAWKESGEN_AUDIO_MOCK=1` swaps the GPU for ffmpeg tones |
| `src/lod.ts`, `src/lod-mesh.ts`, `post/lod.py` | **The LOD system**: every kept image's and GLB's levels of detail belong to the asset (`asset_lods`, `asset_lod_state`, `asset_lod_links` in db.ts; one id, never separate assets). `afterJob` (the queue, when a top-level job finishes) and uploads queue them; `asset.lod` makes them in batches on the CPU (its own `lod` lane, one at a time, yielding to customers' local jobs, lowest priority, child processes at the lowest OS priority; client `gen`, project `hawkesgen.lod`, never charged): images with Pillow (`post/lod.py`), models with gltf-transform + meshoptimizer + Draco in their own process (`src/lod-mesh.ts`; never a GPU server). A job's own low copy (`model.lod1`) is linked to its model, hidden from lists, and used as the low level's geometry. `GET /v1/assets/:id` and list rows carry `lods`; `GET /v1/lods?ids=`; `GET /v1/assets/:id/file?lod=n&v=hash` (ETag, immutable when versioned); `hawkesgen lod status|backfill`. Bump `LOD_VERSION` when the levels made change. docs/api.md "Levels of detail" |
| `src/providers/cloudrun/`, `src/providers/gcp/gcs.ts` | The Cloud Run GPU backend (docs/cloudrun.md): `services.ts` (the map, prices, `cloudRoute`), `run.ts` (`ctx.comfy` as one request per graph, run keys, manifest/heartbeat resume, cancel marker), the queue's `fillCloud` lane in `jobs.ts`; `gcs.ts` is Google credentials (ADC, `HAWKESGEN_GCP_IMPERSONATE`) and a small Cloud Storage client. Tools that work over SSH carry `server: 'ssh'` and never go there |
| `src/providers/gpu/` | GPU providers (docs/gpu-providers.md): `route.ts` (`gpuCandidates`: the order, what is skipped and why; no order = `cloudRoute` exactly), `health.ts` (cooldowns, last errors, `awsRefused`), `auth.ts` (each provider's headers from env), `broker.ts` + `brokerRoute.ts` (`/v1/gpu/broker`: a run token for one run's files) and `sign.ts` (V4 signed URLs through IAM signBlob), `egress.ts` (the fleet from Cloud Run), `status.ts` (`GET /v1/gpu/providers`, the dashboard's Settings > GPU providers card). The queue's GPU lane in `jobs.ts` takes the first provider with room and requeues a job on the next when one is unavailable. Tests `test/gpu-providers.test.ts` |
| `src/cpu/`, `src/providers/cloudrun/cpu.ts`, `server/cpu-cloudrun/` | The CPU suite on Cloud Run (docs/cpu-cloudrun.md): `suite.ts` (the tools, weights, what stays local; the service imports only pure modules, a test checks it), `worker.ts` (a tool's own `run()` against Cloud Storage, and `asset.lod`'s two commands), `server.ts` (the service's door), `cpu.ts` (`cpuRoute` by `settings.cpu`, `runCpuRemote` with resume, retry and fallback to here, `cpuExec` for `src/lod.ts`, `cpuStatus` for `GET /v1/cpu`); the queue's `local-cloud` lane and usage `gcp-cpu` in `jobs.ts`. Setup in `tools/cpu-cloudrun/` |
| `src/storage.ts` | The library's files in S3 (opt-in: `settings.storage.bucket`; `storage.provider: "gcs"` keeps them in Google Cloud Storage instead, `tools/storage-copy.mjs` copies S3 → GCS): every new file backed up by content in the background, `backfill` for older ones, and missing files restored on demand (a job's inputs, a download) or all at once (`hawkesgen storage restore`) |
| `src/entities.ts`, `src/bus.ts` | The library's structure (docs/library.md): entities (`project/slug`), slots, versions (take, current, old, discarded), `slot:` references expanded at submit, slot recipes (request, entity data, or the project's `kinds` in presets), and filing a job's outputs into its slot. `bus.ts` is the event bus (`job`, `library`) behind `GET /v1/events` |
| `src/library.ts`, `usage.ts`, `auth.ts`, `config.ts`, `db.ts` | Assets and recipes, costs, API keys and roles, settings and paths, SQLite (node:sqlite) |
| `src/mcp.ts`, `mcp-tools.ts`, `mcp-http.ts`, `mcp-core.ts` | The MCP server: stdio (`mcp.ts`, talks to the running service over HTTP) and `/mcp` over HTTPS with the caller's API key (`mcp-http.ts`); both share the tools (`mcp-tools.ts`). `mcp-core.ts` is the same file as in hawkesstudio. Setup for Claude anywhere: `hawkesstudio/docs/cloud.md` |
| `post/` | Python: `prep.py` (frame, motion, canvas), `cutout.py` (rembg), `texture.py` (tile, material maps) |
| `server/` | What GPU servers install at launch: `bootstrap.sh`, `models.json` (core models by family), `templates/` |
| `dashboard/` | The web UI (plain JS over the API) |
| `clients/` | `js/hawkesgen.mjs`, `python/hawkesgen.py`, `unity/com.hawkes.gen` (editor package). Projects copy the JS/Python files; Unity projects reference the package by path. Player analytics: `js/hawkes-analytics.js` (the page SDK, served at `/sdk/analytics@1.js`; `.mjs` and `.d.ts` beside it) and `unity/com.hawkes.analytics` (the runtime WebGL bridge) |
| `test/` | `node --test` suites |
| `.data/` | Everything generated: `hawkesgen.db`, `library/`, `blobs/`, `fleet/` (tokens, SSH keys), `graphs/`, `comfy-cache/` (object_info, template index, templates, thumbnails), `tmp/` |

## Adding a capability

**Prefer a workflow** (no code). Import a ComfyUI template or J's exported workflow (dashboard → Workflows,
`POST /v1/workflows/import`, or the MCP `hawkesgen_import_workflow`), then curate the manifest:
- title and description (what it's for, and when to use another tool instead)
- params with sensible limits; hide knobs behind `advanced`
- the right `family`
- outputs with titles
- models (reuse ones the servers already have where the architecture matches)

`docs/workflows.md` has the manifest format. Then `npm test` and one live run. **Bump `version` when results
change.**

**Write a tool in code** only when a workflow can't express it: multi-step logic, local post-processing,
non-ComfyUI providers.
1. Write it in `src/tools/`: `id` (`area.verb`), `version`, `provider`, `family`, `inputs`, `params`, `run(ctx)`.
2. In `run`, use these:
   - `ctx.comfy`: `upload`, `runGraph`, `download`, `ensureModels`
   - `ctx.python('script.py', args)`
   - `ctx.emit({ data, ext, seed, title })` for each output
   - `ctx.result(v)` for values
   - `ctx.usage(...)` for API costs
   - `ctx.step('…')` for progress
3. Loop takes from `ctx.done` / `ctx.outputs` so resumed jobs skip what they made.
4. Add it to `BUILT_IN` in `src/tools/index.ts`.

**New project art direction:** add or edit `presets/<project>.json`. `npm test` checks every preset against its
tool. Keep style lines grounded in the project's own docs; don't invent a look for a project that hasn't
chosen one.

## Build server (Unity WebGL)

- One Windows machine (`hawkesgen builder status|launch|start|stop|rdp|ssh`), `m7i.2xlarge`, about $0.77/hr while
  running, 300 GB disk (~$24/month). It stops itself after 30 idle minutes; a build job starts it.
- It mirrors `C:\Projects`: a build sends only the files that changed (size + mtime against what was sent last;
  manifests in `.data/builder/manifests`), for the project, its website folder and its local `file:` packages.
  Library/Temp/Logs are never sent: the server keeps its own, which is the point.
- The build runs the project's own batch deploy method (`-executeMethod`), detached from SSH; Hawkes Gen follows the
  log. What changed in the website folder is pulled back into J's checkout (never committed).
- Unity Personal is licensed by signing in to Unity Hub on the server once (Remote Desktop file and password in
  `.data/builder/`). A build that fails with a license error says so.
- SSH commands run in PowerShell. Avoid double quotes in commands sent over SSH (Windows quoting); upload a script
  instead.
- **Google Cloud Run backend** (`docs/unity-cloudrun.md`): `settings.unityBuild.backend` / `.projects` pick `builder`
  (this box) or `cloudrun` (a Cloud Run job per build: exact commits from GitHub, the Library from a cache in Cloud
  Storage, `server/unity-cloudrun/`, `src/providers/builder/cloudrun.ts`, `cache.ts`, `gcp.ts`). Same result shape.
  Caches: `hawkesgen builder caches | clear-cache <project> [key]`. Setup scripts in `tools/unity-cloudrun/` print
  first and change things only with `--apply`. Every backend stops a build at `settings.unityBuild.timeoutMinutes` (40).
  A third backend, `vm` (per project, `src/providers/builder/vm.ts`, `tools/unity-cloudrun/vm.mjs`), runs the same
  container on the project's own spot VM with a disk that keeps its Library; a Cloud Run build peaking over
  `vmAt` (85%) of its memory moves its project there. Unity Personal is activated each build with the account's email and
  password (secrets `unity-email`, `unity-password`) through the Unity Licensing Client, and returned after;
  `HAWKES_LICENSE_CHECK=1` checks only that.
- **GitHub mode** (`unity.build` param `github`, `src/providers/builder/github.ts`, `server/unity-cloudrun/github.sh`):
  the source at one commit and the website's `beta` from GitHub, the build committed and pushed to that beta by the
  container (never main). Studio uses it for build tags (`git tag build-x && git push origin build-x` in a Unity source
  repo). docs/unity-cloudrun.md, "GitHub mode".

## The app (hawkesgen.ai `/`)

Hawkes Gen is a product of its own (J, 2026-10-29): people sign up at hawkesgen.ai with Gen's own accounts
(`src/users.ts`: email and password, starter credits, Stripe packs), separate from hawkesgen.ai's and Studio's. The
portal and Studio use Gen in the back end with their own keys.
- **The app** (`dashboard/gen/`: plain HTML, CSS and ES modules over `/v1`, no build step) is at `/`: one page for
  everything Gen makes, a video editor with generative AI built in (J, 2026-10-29: "a proper video editor" with "a bad
  ass AI editor on the right pane"), and the whole studio the portal's Asset Studio was heading for (J, 2026-10-29:
  "keep this sleek interface and do much much more", "all in one place", the assistant on the side, one page).
  - **Create** (`studio.js`, the left pane's second tab): every tool from `GET /v1/editor/catalog`, in groups (images
    and textures, video, 3D and rigging, animation, voice and sound, chains). `GROUPS` names and orders them with a
    plain one-line description each; a tool Gen adds that no group names shows under "More" by itself. Each form is
    drawn from the tool's own params and inputs (advanced ones under "More settings"), with friendlier controls where
    they help: a shape instead of width and height, seconds instead of frames, the voice list, styles for images.
    Inputs come from the library (a picker, a dragged Media tile, the file open in the viewer) or an upload. Under each
    form, closed: **How it works · every setting** (the tool's card: craft notes, models, pairings, and every node of its
    ComfyUI graph with its settings; changed ones go with that job as `nodes`). Results
    go to Media and open in the viewer; pictures, clips and sounds can go straight onto the timeline. Chains are
    `asset.make` steps (`$prev`). Tools that need the SSH fleet show "Offline" while it is down.
  - **The library** is Media: pictures, clips, sounds and 3D models (GLB in `<model-viewer>`, loaded from jsdelivr on
    first use). A file open in the viewer has **Use in…** (every tool whose first or required input takes it),
    Download, and Details (its recipe, and Make another with a new seed). Results open the cutout, not the mask, when a
    tool returns both.
  - Layout: Media and Create on the left (`media.js`, `studio.js`), the viewer with the tools for what's selected in the middle
    (`player.js`, `tools.js`), the AI editor on the right (`ai.js`), the timeline below (`timeline.js`). Panes resize
    (sizes kept per browser); on a phone one pane at a time behind bottom tabs.
  - **The project** (`project.js`, `src/editor.ts`): one timeline document per project, saved to Gen
    (`/v1/editor/projects`, with a version: a save that crosses another one gets 409 and the newer document), undo and
    redo, waiting clips filled in when their jobs end, edits made elsewhere (the AI, MCP, another tab) picked up. Tracks:
    V1 the main video track (magnetic: clips back to back, pictures as stills), T1 text on screen, A1 music, A2 voice,
    A3 sound. Nothing is added that the person didn't ask for: no fades or transitions unless set.
  - **Timeline:** drag to move (V1 reorders), edge handles to trim, snapping, split (S), delete, duplicate, a selected
    time range (drag on an empty track or shift-drag the ruler; I and O), transitions at V1's joins, speed, volume,
    mute, push-in, zoom (Ctrl+wheel), keyboard (Space, arrows, Ctrl+Z / Ctrl+Shift+Z, T for text). Thumbnails and
    waveforms are made in the browser (`lib.js`).
  - **Tools on what's selected** (`tools.js`; only tools this Gen has, from `GET /v1/editor/tools`): pictures: Animate
    (`video.i2v`), Edit (`image.edit`), Repaint area (`image.repaint`, a painted mask), Expand (`image.expand`), Relight,
    Remove background (`image.cutout`), Upscale. Clips: Change something (`video.change`, mask on the first frame),
    Restyle, Swap a person (`video.replace`), Continue the shot (`video.frame` last, then `video.i2v`), Grab this frame,
    New voice (`audio.revoice`), Upscale, Smooth motion. A result on a timeline clip replaces it in its spot.
  - **Animate's prompt:** Wan follows a description of motion, not an instruction. "Make it fly" on a bird gave a
    still bird; the same words wrapped by `motionPrompt` took off, and a full description (what the AI editor writes)
    did best (A/B on gen-beta, 2026-10-29). `video.i2v` also defaults its negative to Wan's standard one
    (`WAN_NEGATIVE`, v2).
  - **Generate** is now part of Create: image (with styles), video from words (`video.t2v`), music, voice-over, sound
    effect, each priced; with "Add to timeline", sounds land at the playhead on their track and music at 0. Voice-overs and sound effects run on ElevenLabs (`provider:
    "elevenlabs"`) with its premade voices only (`GET /v1/editor/voices`, `editorVoices`: never the account's cloned or
    designed character voices), because the open audio models run only on the SSH GPU fleet (AWS, suspended); for the
    same reason `audio.revoice` is left out of the editor's tools until they have a GPU provider. **Uploads** by button or drop anywhere (on the timeline: placed too).
  - **Export** maps the timeline onto `video.compose` (pictures first become clips with `video.still`); captions burned in.
  - **The AI editor** (`ai.js`, `src/editor.ts` `assistantTurn`): it knows every tool (`toolMap`, the usual ones with
    how the editor uses them, chains through `asset.make` and node settings: `CRAFT_DOC`) and gets the full craft of the
    tools a request likely needs (`relevantTools`); it sees the timeline, the selection (clips, a range,
    the playhead, a painted mask) and recent media (3D models too), makes library things with the studio tools in
    `EDITOR_TOOLS` (skyboxes, material maps, 4-view sheets, 3D models; placed `{"library":true}`), and answers with edits (`applyOps`, the same code the API and MCP
    use) that Gen applies. Generation over `autoCredits` (40) comes back as `proposed` for one tap. Every AI edit is one
    undo step. It runs on the account's own Claude (Account > Your AI: `/v1/users/me/ai/anthropic` or
    `/claude-subscription`, stored like orgs' keys under `genAccountOrg`), never ours; without one the pane says how to
    connect it. MCP: `hawkesgen_editor`, `hawkesgen_editor_apply`, `hawkesgen_editor_ask`.
  - **The director** (`director.js`, `stage-math.js`, `src/director.ts`; J, 2026-10-29: "allow the users to design scenes
    for creating 'the perfect shot' ... they will make use of the AI to design 3d scenes. Then we render this out using
    gen"). The Director button in the bar turns the viewer into a 3D stage (three.js 0.170 from jsdelivr through the
    page's import map), the left pane gets a Shot tab and the AI pane becomes the AI director.
    - A shot (`/v1/director/shots`, table `director_shots`, saved with a version like editor projects) is
      blender.render's shot format plus the words: a cast (a library 3D model each, or a stand-in mannequin of the
      right height), beats (walk to, look at, turn), props (models or shapes), the set (ground, sky color or a 360°
      panorama, studio/sun/night light), the camera (the ten blender moves, angle, distance, height, lens, amount,
      handheld), the look (the first frame) and what happens (the video), length and shape.
    - The stage plays it the way blender.render would (`stage-math.js` `poseAt`, `cameraAt`: Blender's axes and
      facing; tested in `test/director.test.ts`). People, props and walk markers drag on the ground (kept within
      25 m); "Camera" looks through the shot camera, "Free look" flies around it.
    - The AI director (`POST /v1/director/shots/:id/assistant`, `directorTurn`) answers with the whole shot, changed;
      house AI rules and credits as the AI editor. It sees the selection (the playhead, a selected stretch, the selected
      person or prop) and the filming tools' craft (`toolCraft`), so "pull back here" writes camera keys for that stretch
      and "the faces melt" changes the film settings.
    - **Camera keys** (`camera.keys`: t, angle, distance, height, lens, aimHeight): the camera at those times, eased between;
      they replace the move (follow and handheld still apply). Key the camera at the playhead in the Camera section;
      diamonds on the time bar. Blender films the move, not the keys (its recipe says so).
    - **A stretch of the shot**: In and Out on the bar (or I and O) select it for the AI.
    - **Look / Depth** on the bar shows the stage as the video model gets it.
    - **Filming** (the Shot tab's last section, closed by default; `film` in the shot): the video model (`ltx`:
      video.control, 24 fps, 8n + 1 frames, sound; `wan`: video.control-wan, 16 fps, 4n + 1, Wan's sizes), the first-frame
      tool (`image.control` paints over the stage, `image.edit` edits it), how strictly it follows the stage and the
      first frame, and every node setting of both workflows (the Create drawer, saved as `film.nodes`, `film.keyframeNodes`).
    - **Film it** (works without Blender or the SSH fleet): the browser records the first frame and a depth video
      (white near, black far, one range measured over the shot) at the film's size and 24 fps, 8n + 1 frames; both are
      uploaded (webm converted by media.normalize); `image.control` paints the first frame in the look and
      `video.control` (LTX-2.3 IC-LoRA) films the depth from it. Stand-ins become the described characters.
    - **Blender** (`POST .../blender`, `?quote=1` prices it): the same shot through `film/recipes.ts cinemaPass` as one
      `asset.make` (gate, blender.render, best-of-3 keyframe, video.control, upscale). Every cast member needs a model;
      it queues until the fleet is back.
  - `test/editor.test.ts` covers the document and routes; `test/director.test.ts` the house AI, admin accounts and the
    director; `test/saas-ui.test.ts` checks every id the modules look up
    is on the page.

  Sign-in is **Continue with Google** (`POST /v1/users/google`, `users.ts googleSignin`), inline: the first Generate
  asks, then goes on. One Google account signs in to every product (portal, Studio, Gen), each keeping its own
  account. A Gen account is found by Google's permanent id (`user_google`), else by its email (an older account,
  linked), else made with the starter credits. Email and password are off on the cloud lanes (410 `google_only`;
  `HAWKESGEN_PASSWORD_LOGIN=1` turns them back on) and stay for local runs and tests. The app uses the admin
  dashboard's Google client (`settings.dashboard.googleClientId`); its JavaScript origins must list each Gen address.
  The editor's timeline lives in the browser (`localStorage`).
- **Paying** (`src/subscriptions.ts`, `src/billing.ts`, `test/subscriptions.test.ts`):
  - **Plans:** monthly plans grant credits every paid month. Defaults (provisional): Creator $12 = 1,500 credits,
    Pro $39 = 5,500, seeded when the table is empty; the owner changes them at `POST /v1/subscriptions/plans`.
  - **Credit packs:** one-off, as before.
  - **Stripe:** a Checkout session in subscription mode (`POST /v1/subscriptions/checkout`). Webhooks
    (`/v1/billing/webhook`) record it, grant credits once per paid invoice (`invoice:<id>` in the ledger), follow
    cancel and status, and mark a failed payment `past_due` (still the current plan).
  - **Management:** cancel and resume at the month's end (`/v1/subscriptions/cancel|resume`), and Stripe's billing
    portal (`POST /v1/billing/portal`).
  - **One Stripe account for three products** (J, 2026-10-29): the portal, Gen and Studio share it, so every webhook
    endpoint gets every event. Gen tags what it makes (`metadata.product = "gen"`, on the checkout and the
    subscription) and acts only on its own (`billing.ts isGenEvent`: the tag, else a subscription it knows, else a Gen
    account). Others' events get a 200 and nothing else, so Stripe never retries or disables the endpoint over them.
  - **Set-up:** Stripe needs its keys on each lane (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, or
    `POST /v1/billing/config`) and a webhook endpoint at `https://<gen>/v1/billing/webhook` for
    `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` and
    `customer.subscription.deleted`.
- **Admins sign in once:** a Gen account whose email is on `settings.dashboard.googleEmails` (J) and that signed in with
  Google is Gen's owner too (`users.ts isGenAdmin`). The app shows it an Admin link, `/admin` works with the same
  sign-in, and its own work stays in its own project (the app always names it). A password account with that email
  never is.
- **The admin dashboard** is `/admin` (its files are served beside it: `/admin/app.js` is `dashboard/app.js`). Owner
  and admin keys, or Google for `settings.dashboard.googleEmails`. The app links there for admins.
  - **AI** (`/v1/admin/ai`, owner only; `src/houseai.ts`): the house AI every Gen account uses (J, 2026-10-29: "Don't make
    users sign into claude ... we can use mine for the website ... it just works"). An Anthropic API key stored
    encrypted (`HOUSE_ORG` in the org secret store; else the service's `ANTHROPIC_API_KEY`), Gen's Claude logins (the
    Claude accounts card moved here from Settings), which serves accounts (`auto` key then login, `api`, `claude`,
    `off`), and the price: each AI editor or director turn on the house AI costs the call's cost x `markup` in credits,
    at least `minCredits` (`ai_turn` in the ledger). A key that fails (rejected, out of credit) gives the person a plain
    "isn't available" (the log says why) and, on `auto`, falls back to a login. Consumer plans are for one person: the
    tab says so, and `auto` prefers the key.
  - **Accounts** (`/v1/admin/accounts...`, `src/accounts.ts`; J: "much like the portal has where you can gift credits"):
    numbers (accounts, new and active this week, credits held, spent and bought), search, one account (credits, spent,
    plan, ledger, recent jobs), gift credits with a note, add or remove credits with a reason (the account sees the
    note in its ledger, never who), disable or enable (`user_flags`: sessions and keys stop working; admins can't be
    disabled).
- The old Hawkes Play pages stay at `/home`, `/app` and `/play`.

## Customers (tenancy)

Gen is sold to customers (hawkesstudio `docs/platform-plan.md`), so one customer must never see or use another's
work. A **customer** is a key with role `user` whose projects are all customer projects (`settings.queue.projects`:
`usr_*`, `ustg_*`, `u_*`, `org_*`…; the portal's one key narrows itself per call with `X-Hawkesgen-Project`). The
studio's own products' user keys are not customers. `test/tenancy.test.ts` tries each rule as another customer; add a
case there whenever you add a route or an input kind.
- **Blobs:** stored once by content, but `blob_owners` records who uploaded each (`ownBlob`). `canUseBlob` lets a
  customer use only its own uploads or blobs behind assets it can see. Knowing a hash is not access.
- **Reads:** jobs, assets, entities, `recipes/check` (`findByRecipe` takes the caller's projects), presets (own and
  `shared`) and usage (own projects) are scoped. Raw server paths are owner-only everywhere.
- **The studio's machinery** (`OPS_ROUTES` in `src/api.ts`: fleet, machines, settings, storage, clients, workflows,
  Claude logins, everyone's live playtests…) answers 403 to customers.
- **Priority:** customers can lower their own jobs, never raise them or ride a boost (`createJob`).
- **Fair queues:** `fairOrder` on the GPU and on every API and local lane; one customer takes at most
  `queue.perProjectLane` slots of a lane (playtests count tabs) and `queue.perProjectGpu` GPU jobs.
- **Platform tokens** (`src/platform.ts`, `test/platform-token.test.ts`): hawkesgen.ai is the account system. A
  customer may call Gen (and `/mcp`) with the portal's short-lived JWT instead of an `hg_` key. It is checked against
  the portal's keys (`/.well-known/jwks.json`, cached 5 minutes, fetched again for an unknown key id) and becomes a
  `user` client of one org:
  - projects `org_<hex>` and `org_<hex>.*`, plus the owner's older `usr_<hex>` for a personal org
  - its `scopes` decide what it may run (`playtest.*` needs `playtest`, `unity.*` `build`, the rest `generate`)
  - viewers can't run jobs
  - billing for jobs sent straight to Gen with a token isn't connected yet, so only `settings.platform.freeOrgs` may
    submit (402 otherwise)

  `settings.platform.issuer` names the portal (empty: hawkesgen.ai, or beta.hawkesgen.ai when `HAWKESGEN_LANE=beta`).
- **Claude: the customer's own, never ours** (J, 2026-10-29), **except Gen app accounts** (`u_<hex>`, J, later the
  same day): they get the house AI when they have no key or subscription of their own (`callScope` `house`,
  `isGenAccountProject`, `src/houseai.ts`; the admin's AI tab above). Portal orgs (`org_*`, `usr_*`) are unchanged. A customer's job runs inside `callScope`
  (`providers/anthropic.ts`, with the job's org from `orgOfProject`: `org_<hex>`, `org_<hex>.*`, and a portal
  account's `usr_<hex>` / `ustg_<hex>` as its personal org).
  - Its Claude calls run on the org's own Anthropic API key, else its own Claude subscription (a `claude setup-token`
    sign-in token: Claude Code runs on their plan).
  - With neither, the call fails with a 402 saying how to add one. Never Gen's key, Bedrock, J's Max plan, Cursor or
    Copilot.
  - Both are stored encrypted per org (`src/orgsecrets.ts`, AES-256-GCM with `HAWKESGEN_SECRETS_KEY`) and set by the
    org's owners and admins: `GET/PUT/DELETE /v1/org/keys/anthropic|claude-subscription`, with a platform token. Only
    "set" and the last 4 characters come back.
  - Usage is recorded as `anthropic-byok` or `claude-subscription` (not ours to bill).
  - Customers' playtest reviews default to Sonnet and may only review their own project's playtests.

## Playtests

`playtest.run` opens a page in Chromium (headless, but on the real GPU through ANGLE/D3D11) and plays it through the
game's playtest contract (`C:\Projects\hawkesstudio\docs\playtest.md`), or a generic smoke test, or a crawl
(`mode: site`). It records video (mp4), screenshots (every few seconds and at events), console errors, failed
requests, load time and fps. `playtest.review` sends the frames and the report to Claude with the product's story and
returns a verdict, scores and findings.
- **Builds, targets and runners** (`docs/playtest-runners.md`; `src/providers/playtester/intake.ts`, `runners.ts`,
  `native.ts`): `build` takes `blob:`/`asset:` archives, a URL or `{ github: { repo, release | run | ref, token? } }`;
  `target` is `web | electron | linux | proton | windows`, with `exe` and `args`. **Gen never fetches or serves a
  customer's build itself:** archives go to the library bucket (`playtest-builds/<project>/<sha>`) and runners get a
  signed link, GitHub builds resolve to GitHub's own links, and a web archive is served by the browser service
  (`server/playtest-cloudrun/site.mjs`, `X-Hawkes-Site`, `http://build.hawkes.test/`). Customers' URLs must be public
  (SSRF checks at submit and run), a GitHub token stays in memory only, and customers' runs play only on runners whose
  `lanes` take customers (never here, never through `proxyLocal`, which is J's local dev only). The router
  (`settings.playtest.runners`, `runnerCandidates`, like `gpuCandidates`) picks by target and lane, first with room,
  with cooldowns and fallback; with none set, the browser services above are the implicit web runners. Desktop runs
  speak the session protocol to `hawkes-play-native` and add `crashes`, `logs` and `perf` to the result.
  `playtest.run` and `playtest.review` are priced (`billing.ts playtestCost`, provisional). Add a case to
  `test/tenancy.test.ts` for any new build form.
- **Never stuck:** every await in `playtest.run` has a hard limit (`within()`), and a watchdog kills the browser and
  tunnel if the run overruns. A hung browser, tunnel or page ends the run as outcome `stuck` (with `result.stuck`
  saying what hung) and keeps what it recorded: shots, the video so far, the report.
- **Where the browser runs:** on the Linux control server, a **playtester** first (`src/providers/playtester/`: g4dn.xlarge
  machines with a T4, about $0.53/hr each; up to `HAWKES_PLAYTESTERS_MAX` (2), in any fleet region: every instance named
  hawkesgen-playtester is one). A playtest claims lanes on a ready one with room (the busiest that fits, so others go
  idle), else starts a stopped one (site crawls don't start one); Studio's daily run stops them at the end; each installs
  itself from `server/playtester/bootstrap.sh` and powers off after 20 idle minutes;
  `hawkesgen playtester status|launch [region=..]|start|stop [id=i-..]`. Else a ready GPU fleet server, else software.
  On this PC, its own GPU.
- **Cloud Run backend** (`docs/playtest-cloudrun.md`, not deployed yet): `settings.playtest.backend` / `.projects` pick
  `ec2` (the playtesters, the default) or `cloudrun` (the `gen-playtest` service with an L4, scale to zero;
  `server/playtest-cloudrun/`, `src/providers/playtester/cloudrun.ts`, `openGpuHost`). One WebSocket per tab with a
  Google ID token; local builds are served from here through Playwright's `route()`/`routeWebSocket()` (no tunnel); the
  video encodes on the service (NVENC) over a WebSocket, else here; its own `playtest-cloud` lane of maxInstances x
  tabsPerInstance tabs. A GPU self-test gates the service's `/ready` (`hawkesgen playtester cloud selftest`). Any
  failure falls back to the playtesters. Scripts in `tools/playtest-cloudrun/` print first, `--apply` to change.
- **RunPod backend** (`docs/playtest-runpod.md`): `runpod` plays on a RunPod serverless load-balancer endpoint with a real
  NVIDIA GPU (`settings.playtest.runpod`), the same image and connection as Cloud Run; headers `Authorization: Bearer
  RUNPOD_API_KEY` (gateway only) and `X-Hawkes-Token` (the image's `HAWKES_TOKEN`); its own lane `playtest-runpod`; usage
  `runpod-playtest`; falls back to the CPU service, then the playtesters. Setup: `tools/playtest-runpod/setup.mjs`.
- **CPU backend** (`docs/playtest-cloudrun.md`, "The CPU service"; AWS suspended and no GPU quota since 2026-10-28):
  `cloudrun-cpu` plays on `gen-playtest-cpu`, the same server (`HAWKES_GL_MODE=software`, `Dockerfile.cpu`,
  `service-cpu.json`) with WebGL on SwiftShader: one tab per 4 vCPU / 8 GiB instance, request-based billing (no idle
  tail), its own lane `playtest-cloud-cpu`, `settings.playtest.cloudrunCpu`. The run reports `software: true` (the review
  ignores frame rates), and `slow` (2) doubles the boot wait and the default scenario limit. `cloudrun` falls back to it
  before the playtesters. A playtest service URL may also be `http://127.0.0.1:<port>` (the container beside Gen, no
  token). `hawkesgen playtester cloud cpu selftest`; J's `tools/playtest-cloudrun/deploy-cpu.ps1` (dry run, `-Apply`,
  `-Settings`).
- **Lanes count browser tabs** (a multiplayer run is one per player): each playtester's by its type
  (`PLAYTESTER_TYPES[..].lanes`: g4dn.xlarge 2, g4dn.2xlarge 4), summed over every playtester that exists (the queue,
  `jobs.ts`); three on a GPU fleet server; one on this PC or in software (the local browser also takes turns inside
  `playtest.run`). An empty lane always takes one job, so a run with more players than lanes still plays.
- **Live** (`src/tools/livePlay.ts`, for Studio's Playtests page): `GET /v1/playtests/live` (everything playing and
  waiting, with each one's step, players' bot state and note, problems, console errors), `GET /v1/jobs/:id/live` (one, in
  full: every step, the timeline), `GET /v1/jobs/:id/live.mjpeg?player=&fps=` (the newest screencast frames as MJPEG for
  an `<img>`, 1 to 15 fps, only while someone watches) and `/frame` (one JPEG).
- **S3:** each run's video and report also go to `s3://hawkes-playtests-028793236279/<project>/<date>/<job>/`
  (private, objects to Infrequent Access after 30 days; created on first use). `HAWKES_PLAYTEST_BUCKET=off` skips it.
  `result.s3` has the keys; Studio serves them through short-lived signed links.
- **Video:** on a GPU machine, a CDP screencast (`src/tools/screencast.ts`: every frame Chromium draws, kept at a steady
  30 fps, encoded after the run on the machine that played it: NVENC, else libx264; on the control server only if that fails), about 30 distinct fps even with two playtests on the
  playtester; elsewhere, or if the screencast won't start, Playwright's `recordVideo` (25 fps). `recorder` forces one;
  `result.recorder` says which. Measurements and the alternatives tried (tab capture): `docs/playtest-video.md`.
- **Reviews converge** (`playtest.review` v3): at most `maxFindings` (default 5) new findings, worst first, polish and ideas
  only without bugs; `known` (the caller's backlog) is never reported again, and the answer says by id which known ones
  look fixed or still present; `mode` full / verify / regression (the last two report only regressions and blockers);
  `bar` (the product's quality bar) is judged as `meetsBar`. `settleReview` enforces the caps and mode on the answer
  (tested in `test/playtest.test.ts`). Studio's side: `hawkesstudio/docs/daily.md` ("Reviews converge").
- **Multiplayer:** `peers: 2..4` opens that many contexts in one browser, each at the URL with a shared random `room` and
  `peer=<i>` (peer 0 plays `scenario`, the others `scenarioPeers` or the same), and needs the contract. The videos are
  stacked here with ffmpeg (two side by side, three or four in a half-size 2x2 grid; `stackArgs`); problems, events and
  log lines are labelled `peer <i>` (`mergePeers`), `result.peers` has each player. `peers: 1` takes the old code path.
- **Watching live:** `GET /v1/jobs/:id/shots` (and `/shots/:i`) reads a run's screenshots while it plays, from its tmp
  files (`src/tools/liveShots.ts` holds the list), then from the filed assets once it ends. `docs/api.md` has the shape.
- **Phone:** `mobile: true` plays at 390x844 with touch; the review then scores touch controls, text size and layout.
- **Visual regression:** `baseline` (the previous run's job) compares screenshots at matching events (load, ready,
  each scene, each page, the end) with `post/visdiff.py` (1 - SSIM). Big changes (>= 25%) become `diff` images and go
  to the review with the previous frames.

## GPU rules (read `docs/comfyui.md`)

- ComfyUI runs with `--disable-pinned-memory` on 32 GB machines. Don't change server flags or core models
  without reading `docs/comfyui.md`.
- Different families don't share the GPU. The queue unloads (`/free`) on a family change and gives a free
  server the oldest job of the family it already has loaded. Keep `family` right on every GPU tool.
- Workflow models install on a server on first use (with a disk check). Least-recently-used non-core models
  are pruned when space is short (`fleet.autoPrune`).
- Concept images get copied when given as content. Pass a blurred mood board for style only.
- Installs resume on every boot until ready, and a stuck or failed install powers itself off (`docs/comfyui.md`,
  "Installs resume"; dry run in `test/bootstrap.test.ts`). Keep each `server/bootstrap.sh` step idempotent behind its
  `begin`/`mark` marker.
- New servers launch from the **fleet image** (an AMI with ComfyUI and the core models, `src/providers/comfy/image.ts`,
  `server/firstboot.sh`, `server/image-prep.sh`) and are ready in minutes; without a matching image they install from
  bootstrap.sh. Launched from the image they are **disposable**: idle, they are terminated, not stopped. When
  models.json or the ComfyUI tag changes, build a new image (`hawkesgen fleet image build`, J's OK: it costs a server
  hour and storage). `docs/comfyui.md`, "The fleet image".
- Servers adopted from DoD keep `flavor: dod` (auth user `dod`, `/dod/status.json`); new ones are
  `flavor: gen`. **Never terminate a server without J asking.**

## Who uses it

| Project | How |
|---|---|
| Dose Of Destruction | `tools/gpu/gen.mjs` + `jobs.mjs`: the GPU tab and every fighter/stage job. Sound and voice tabs: `audio.*`. Map designer and art review: `llm.json`. Library tab (fighters, `hawkes.library.json`); the GPU tab's jobs, picks and discards are mirrored into the library (`tools/devApi.mjs` `mirror`) |
| Sick Of It | `Tools/Art/art.mjs` (enemy art). Window > Hawkes Gen in Unity. SickOfIt > Audio > Sound Generator (`Assets/Scripts/Tools/Editor/Audio/HawkesGenAudio.cs`): `audio.sfx`, `audio.voice`, `audio.voice-design`, `audio.voice-save` and `recipes/check` through `com.hawkes.gen` |
| PH Origins | `tools/voiceLines.mjs`, `tools/soundEffects.mjs` (`audio.*`), `tools/genMaterial.mjs` (materials). Level editor Tools > Library (`src/editor/library.ts`, `tools/genLibrary.mjs`): characters and props from `assets/models` |
| Breaking Through, Yooba Land | Window > Hawkes Gen (Unity package) |
| Every project folder | The `hawkesgen` MCP server in `.mcp.json`, plus a "Generative AI: Hawkes Gen" section in its AGENTS.md |

The analytics SDK is never copied: every page loads it from Gen (`/sdk/analytics@1.js`; docs/analytics.md). Products keep copies of the rest of the JS SDK (`clients/js`: the client, the web components, the folder bridge): their own CI
and site builds can't read this private repo. `clients/js/sdk.json` lists where each product keeps them, and
`node bin/hawkesgen-sdk.mjs sync` writes the current files into every one (`status` lists the ones behind). Sync and
commit in each product after changing `clients/js`, and bump `CLIENT_VERSION` (or `UI_VERSION`, `ANALYTICS_VERSION`) when behavior
changes. Every client sends `X-Hawkes-Client` (js/7, py/6, unity/0.2.1); `GET /v1/health` lists callers behind.

## SSH to GPU servers

`sshRun`, `scpToServer` and `sshTarget` (`fleet.ts`) use the instance's key pair, and when a server rejects it ("Permission denied (publickey)") try every other `.pem` in `.data/fleet` and remember the one that works. Errors name the server, its address and the key file and quote ssh's real last lines (`sshFailure`); the icacls hint is Windows only and only for a real "unprotected private key".

## Checking your changes

- `npm run typecheck` and `npm test`, then restart the service.
- Run a tool from the dashboard's Tools tab or `hawkesgen.cmd run <tool> ...`. Local tools are free.
- Every job keeps its log, params, inputs and ComfyUI graphs (dashboard → job). Drag a graph into ComfyUI to
  debug it.
- The Unity package: compile-check it by opening a Unity project in batch mode (exit 0, and
  `HawkesGen.Editor.dll` in the log).
