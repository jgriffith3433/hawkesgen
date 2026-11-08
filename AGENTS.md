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
- **The making loop** (`docs/make.md`, `src/make/`): AI actions make things through `make.checked` (params = `MakeRequest` minus
  `project`), never raw tools, so nothing reaches the person unchecked. Routing lives in `knowledge/routing.json` (checked by
  `test/make.test.ts`); picks, discards, redos, ratings and complaints go to `POST /v1/make/feedback` and become proposed
  craft notes and routing changes the owner approves.
- `docs/api.md` lists every route.
- `docs/comfyui.md` records what works on the GPU servers.
- `docs/playtest-runpod.md` covers **playtests on a real GPU on RunPod** (`backend: "runpod"`): the same browser image on a RunPod serverless load-balancer endpoint (WebSockets held 12+ minutes there), the driver's graphics libraries fetched when a host lacks them, the CPU service as fallback, what was measured (DoD 52 fps, Yooba Land 54 fps, about $0.01 a smoke run), `tools/playtest-runpod/setup.mjs` and J's steps.
- `docs/playtest-cloudrun.md` covers playtests on Cloud Run (the L4 browser service, how WebGL gets the GPU, local builds through the connection, cost per playtest, the pilot) and **the CPU service `gen-playtest-cpu`** (no GPU: WebGL on SwiftShader, `backend: "cloudrun-cpu"`, one tab per 4 vCPU instance, request-based billing at about $0.007 a playtest minute, what was measured, J's `deploy-cpu.ps1`).
- `docs/cloudrun.md` covers GPU jobs on Google Cloud Run (scale to zero): the worker image (`server/cloudrun/`), the family → service map (`services.json`), routing by `settings.gpu` (fleet stays the default), the per-graph request protocol, the scripts in `tools/cloudrun/` (dry run unless `--apply`; deploying needs J's OK) and the pilot steps.
- `docs/gpu-providers.md` covers GPU jobs on more than one provider: `settings.gpu.order` / `familyOrder` over `fleet`, `cloudrun` and endpoints in `settings.gpu.providers` (RunPod, Modal, any HTTPS host running the worker image), cooldowns and fallback, **when no GPU can run a job** (`src/providers/gpu/nogpu.ts`: fail at once when nothing will come back, else wait at most `queue.gpuWaitMinutes`; no job left "running" with nothing running it; restarts capped; steps stop with their job), the storage broker (workers elsewhere get no Google credentials: a run token and V4 signed URLs), the fleet from Cloud Run (keyless AWS, a fixed egress IP or `fleet.openComfyPort`), prices, and the setup scripts in `tools/gpu-providers/` (print first, `--apply` to change). No order set: the old rule, unchanged.
- `docs/cpu-cloudrun.md` covers the CPU suite on Cloud Run: the CPU tools (cutout, transform, sprite sheets, maps, probe, video fit/compose/matte/composite/control-mix, splats, LOD levels) on the scale-to-zero services gen-cpu and gen-cpu-heavy, the same tool code (`src/cpu/`), routing by `settings.cpu` (local stays the default), the protocol, fallback to here, prices, `GET /v1/cpu`, and `tools/cpu-cloudrun/` (J's `deploy.ps1`).
- `docs/finishing.md` covers **finishing a show and taking a world into a game**: music scored to a cut, ambience, the mix, pacing with J- and L-cuts, one grade per world, titles, captions, the platform shapes, thumbnails, trailers, the delivery sheet, and `world.export` (the pack, its `world.json`, the Unity importer and the web loader), with the priced live runs.
- `docs/blender.md` covers Blender shots to video (`blender.render`, `video.control`) and rigging generated characters (`mesh.rig`).
- `docs/film-pipeline.md` covers the film pipeline: shots with beats and props in hands, the director gate (`film.gate`), the cinema, dialogue, VFX-layer and LoRA recipes (`film.plan`), the trailer cut and what a trailer costs. **Making a trailer, a cutscene or any shot with Blender as the motion rig: start with `film.plan`, run `film.gate` before spending GPU.**
- `docs/3d-animation.md` covers **where the 3D tools run** (`image: '3d'`: blender.character, blender.render, mesh.rig, motion.from-text, motion.from-video): the 3D worker image (`server/gpu3d`, `ghcr.io/jgriffith3433/hawkes-gen-gpu:3d-latest`, built by a `gpu3d-image-*` tag) on RunPod/Modal endpoints that name the families `rig`, `motion`, `mocap`, `blender`, or the fleet over SSH; one `{ hawkes_job }` request per script (`src/providers/workspace.ts`, `worker.py _job`; refused without a worker token); weights once per volume (`HAWKES_WEIGHTS`); `motion.from-video` (GEM-X, self-checking SOMA BVH), `motion.check`, the `animation` intent, the MCP tools and setup (`runpod.mjs` / `modal.mjs --kind 3d`).
- `docs/3d-characters.md` covers `blender.character` (clean, bake, props, retarget, clip edits, FBX/GLB), the `character3d` kind, the CC0 Quaternius motion library (`motion:<pack>/<clip>`, preset `shared/motions`), and `motion.from-text` (Kimodo SOMA / HY-Motion).
- **Hawkes Net** (multiplayer) is its own repo since 2026-10-26: `jgriffith3433/hawkesnet` (C:\Projects\hawkesnet: the service, the relay, the SDK `@hawkesgen/net` and the Unity package; its design is its `docs/net.md`). Gen keeps only its bridge, `src/netbridge.ts`.
- `docs/audio.md` covers the sound suite: Gen's own voice and sound models (primary) on any GPU provider (Qwen3-TTS in the worker image, Stable Audio 3 as a ComfyUI workflow), ElevenLabs (secondary), `provider` routing, the house voices, the Gen voice library, direction, post-processing, the audition (`tools/audition.mjs`) and what still needs a GPU run.
- `docs/library.md` covers the library every product builds on: entities, slots, versions, slot references, make/revise/pick.
- **Identity: the same character in every shot** (`docs/identity.md`): a character's pack (`lock` = the approved sheet and a fixed 50-80-word description; `lora` once they recur) is made by "Make their look" and approved with "Lock their look". Every first frame is one `asset.make` job: `image.control` paints the stage, then one `image.edit` pass per known character with their sheet and a render of their 3D model from the shot camera; the fixed words go unchanged into the look, video and talk prompts; the Blender path takes the sheets as `refs`. `identityPack` is the contract; place and prop pack plans are there for the world kinds.
- `docs/worlds.md` covers **worlds** (the layer above scenes): the world, place, prop and story kinds, `worldContext`, the world's look inherited by every job made inside one (`labels.world: "off"` turns it off), continuity per shot, canon checks, the world AIs, Start a world and the world's home.
- **The app as a Hawkes Studio project** (hawkesstudio `docs/projects.md`): `/v1/health` says the commit it runs (`commit`, from `HAWKESGEN_COMMIT` that CI sets); `POST /v1/users/test-session` is the beta-only test sign-in for Studio's playtests (`src/testsignin.ts`, the secret at `PUT /v1/admin/test-signin`); `POST /v1/users/test-session/github` signs a GitHub Actions run of an allowed repo (by repository id, `src/githubsignin.ts` `REPOS`: the Unity plugin's smoke test) into its test account by the run's OIDC token, beta only, no secret; `dashboard/gen/playtest.js` is its playtest bot (no GPU spent); its beta's 🐞 button loads a Studio project's report line when set (`PUT /v1/admin/report-script`, `src/studioreport.ts`); `dashboard/gen/report.js` gives reports their context. Customers never read infrastructure names (`src/publictext.ts`).
- **The showrunner** (`docs/showrunner.md`, `src/showrunner/`; roadmap Phase 4): the AI pane sends every message to `POST /v1/showrunner/turn`. Small edits go to the scene's own assistant unchanged (same answer, same cost; it looks at the frames first when the words point at results); productions ("a 60-second teaser about...") are planned top down at high effort, critiqued, priced and shown as one approval card, then run on the server as a resumable production (`productions` table) through `make.checked` (or the routed tool until it exists) to a cut video scene, checked shot by shot with `assess`. Review mode (`review.js`) re-takes one shot of a cut with Keep or Undo; memory per account sits under Account > Your AI.
- `docs/analytics.md` is the player-analytics contract (events every product sends, the collect door, the queries).
- `DESIGN.md` has J's decisions and the roadmap.
- `CLAUDE.md` just imports this file; edit this one.

**No polling:** use server push (`GET /v1/events`) or on-demand fetches. A new `setInterval`/`setTimeout` that fetches needs a written reason. (J, 2026-11-02: "Please stop implementing polling if at all possible it causes all the problems"; polling through the Cloudflare edge burned 100k requests on 2026-11-01.) Pages open `GET /v1/events` once (`dashboard/gen/stream.js`, shared by `jobwatch.js` `on`/`listen`) and hear `job`, `library`, `production`, `scene` and, for admins, `machines` and `bench`; everything else is fetched on page open, on a user action or on an event, and an idle page makes zero requests. To tell pages about a new kind of change, `events.emit(...)` on the bus (`src/bus.ts`) and send it in the `/v1/events` handler in `src/api.ts`. `test/no-polling.test.ts` fails on a new `setInterval` in `dashboard/` unless it makes no request and is listed there with its reason.

**When a call fails** (`dashboard/gen/trouble.js`, J, 2026-11-08): every page words a failure through `explain`/`trouble`/`troubleNote` (offline, 401 sign-in that keeps the work, 402 Add credits with the price, 429 "try again in N s" from `Retry-After`, 503): one plain sentence and a next step, never raw JSON, a trace or a key. `api()` throws status 0 when offline and emits `sessionEnded` on a 401 from anything but `/v1/users/me`. The "Reconnecting…" chip follows `jobWatch().onState` (no timers). Playtest scenario `trouble`; test `test/trouble.test.ts`.

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
| `src/tools/blender.ts`, `src/providers/blender/` | `blender.render`: Blender 5.0 on a GPU server (installed on first use; `install.ts` is shared with `bootstrap.sh`), a job workspace in `/var/tmp/hawkes-blender`, a detached render followed over SSH. The scripts are `post/blender/hawkes_blender.py` (inside Blender) and `post/pose_draw.py`. `src/tools/rig.ts` is `mesh.rig` (family `rig`: Make-It-Animatable and SkinTokens in their own venvs, installed on first use, then Blender for the walk; `post/rig/`, `post/blender/hawkes_rig.py`); `src/tools/character.ts` is `blender.character` (`post/blender/hawkes_character.py`: named ops only, checked by `checkOps` before a server is claimed); `src/tools/motion.ts` is `motion.from-text` (family `motion`: Kimodo SOMA + HY-Motion fallback in `/opt/hawkes-motion`, then retarget via blender.character; `post/motion/`); `src/tools/mocap.ts` is `motion.from-video` (family `mocap`: GEM-X in `/opt/hawkes-mocap`, `post/mocap/gemx_run.py`, `post/motion/soma_to_bvh.py`); `src/tools/motioncheck.ts` is `motion.check` (`post/motion/check.py`). All of them run through `src/providers/workspace.ts` (the fleet over SSH, or a GPU worker with the 3D image: docs/3d-animation.md) |
| `src/tools/local.ts` `sprite.sheet`, `image.transform` | sprite.sheet: a clip (or frames) to a game sprite sheet with ffmpeg (frames spread evenly, a flat background keyed to transparency with colorkey + despill, the PNG atlas, frame JSON (TexturePacker hash), a GIF; `loop` drops the repeated last frame). image.transform: `post/transform.py` (Pillow), steps in order: resize, scale, crop, trim, pad, square, pot, flip, rotate, pixelate, colors, outline, tint, grayscale |
| `src/tools/threed.ts`, `viewsheet.ts` | The "always more than one view" rule (refusals, deprecation notices, tool order) and `image.viewsheet` (back/left/right views, Claude's consistency check, the sheet) |
| `src/tools/build.ts`, `playtest.ts`, `pipeline.ts` | `unity.build`; `playtest.run` (Playwright, or a native runner for desktop targets) and `playtest.review` (Claude); `asset.make` (chains, best-of-N with canon and references, library reuse) |
| `src/providers/playtester/` | Where playtests play: `playtester.ts` (the EC2 playtesters), `cloudrun.ts` (the browser services: RunPod, Cloud Run L4 and CPU), `intake.ts` (customers' builds, SSRF checks, the GitHub token vault, staging), `runners.ts` (the runner router), `native.ts` (the session protocol to native runners). docs/playtest-runners.md |
| `src/analytics/`, `analytics/products.json` | Player analytics (docs/analytics.md): `collect.ts` (the public door: validation, limits, CORS, rate limit), `geo.ts` + `mmdb.ts` (DB-IP Lite GeoIP), `ua.ts`, `store.ts` (`.data/analytics.db`: events, sessions, daily rollups, the purge), `query.ts` + `routes.ts` (the reads). The registry lists each product's origins |
| `src/showrunner/`, `dashboard/gen/showrunner.js`, `review.js`, `memory.js` | **The showrunner** (docs/showrunner.md): `classify.ts` (edit or production, by words), `plan.ts` (the plan, `lintPlan`: 180° rule, continuity, pacing, canon; the planner and critique prompts), `steps.ts` (a plan as steps, each a MakeRequest through `make.checked` when it exists, else the routed tool; the card), `production.ts` (table `productions`: the resumable state machine, the cut, the review pass, review mode's fixes), `memory.ts` (table `showrunner_memory`, per account), `vision.ts` (frames and contact sheets for turns about results), `deps.ts` (every outside call, mocked in `test/showrunner.test.ts`), `routes.ts` (`/v1/showrunner/*`) |
| `src/netbridge.ts` | **Hawkes Net's bridge.** Hawkes Net (multiplayer, `https://net.hawkesgen.ai`) is its own repo, `jgriffith3433/hawkesnet`. Gen's whole part: `GET /v1/net/whoami` (the box checks API keys with it), `POST /v1/net/usage` (the box's usage into Gen's usage table) and a 308 to the box for the rest of `/v1/net/` and the SDK files (`/sdk/hawkes-net*.mjs`). Test `test/netbridge.test.ts` |
| `src/identity.ts`, `src/identity-film.ts`, `src/identityroutes.ts` | **Identity packs** (docs/identity.md): the character's lock and LoRA, Make their look (`lookPlan`, `describeRequest`), `loraOffer`/`loraPlan`, `placePackPlan`/`propPackPlan`; the first-frame job with every cast member's pack (`firstFramePlan`, used by `director.ts firstFrameFor`); routes `/v1/scenes/:id/identity...`, `/v1/director/prompts`, `/v1/director/identity-check`. Test `test/identity.test.ts` |
| `src/worldkinds.ts`, `src/worlds.ts`, `src/worldai.ts`, `src/worldroutes.ts` | **Worlds** (docs/worlds.md): the world, place, prop and story kinds (`continuityAt`), `worldContext` / `withWorld` / `inheritWorld` (the `onSubmit` hook in `jobs.ts`) / `canonCheck`, the world kinds' AIs, Start a world and the packs, `/v1/worlds/*` and `/v1/stories/:id/shots/:shot/stage`. App: `dashboard/gen/world.js`, `place.js`, `prop.js`, `story.js`, `worldbits.js`, `worlds.css`. Test `test/worlds.test.ts` |
| `src/finishing/`, `src/tools/finishing.ts`, `dashboard/gen/deliver.js`, `clients/js/hawkes-world.mjs`, `clients/unity/com.hawkes.gen/Editor/WorldPackImporter.cs` | **Finishing and worlds into games** (docs/finishing.md): `audio.score` (tempo fitted so cuts land on beats, sections by mood), `audio.ambience`, `audio.mix` (dialogue first, music ducked, -14 LUFS / -1 dBTP), `edit.pace` (trims, J- and L-cuts as timeline ops), the world grade (`grade.ts`; `video.compose` `grade`/`world`/`lut`/`finalPass`, `video.grade`), `video.titles`, `video.reframe`, `video.thumbnails`, `video.trailer`, `video.deliver` (the Export sheet's job and delivery sheet), `world.export` (a zip and `world.json`, every file with its recipe). Test `test/finishing.test.ts` |
| `src/aimock.ts`, `test/aimock.test.ts` | **The AI mock** (docs/ai-mock.md): `HAWKESGEN_AI_MOCK=1` lets a test sign-in account (`playtest:` Google id) queue canned answers for `ask()` (match by prompt substring or by order, settable `cost`), via `POST /v1/test/ai-mock` or `queueAnswers`. It sits inside `ask()`, below the routes; off without the flag, never for real users. Playtest scenario `aimock` |
| `src/ratelimit.ts` | **The request limiter** (docs/load.md): a token bucket per caller and route class (strict /v1/users writes and /oauth, moderate jobs, estimate and assistants, generous reads and events), run first in `handle`; 429 + `Retry-After`; never `/v1/health` or the Stripe webhook; `settings.rateLimit`. Test `test/ratelimit.test.ts` |
| `src/estimate.ts` | Cost estimates for a planned batch (`POST /v1/estimate`) |
| `src/make/`, `knowledge/routing.json` | **The making loop** (docs/make.md): the tool `make.checked` (route by intent from `knowledge/routing.json`, the world's look and the cast's references applied, cheap previews, `src/quality` checks, the final on the best preview's seed, targeted fixes and at most two retries within the budget, a hero tournament, `needsYou`), priced at its worst case (`Tool.quote`); `make_feedback` and the summarizer's proposals (owner approves in `/admin` > Making; approved ones apply as an overlay); owner knobs `/v1/make/settings`. Test `test/make.test.ts` |
| `src/machines.ts` | The Machines monitor (`GET /v1/machines`, the dashboard tab): the GPU servers, build server and playtester measured over SSH (CPU, memory, GPU, disk, network, idle clock) every minute while running, 7 days of history in `machine_samples`, and the alerts |
| `src/providers/elevenlabs.ts`, `anthropic.ts`, `cursor.ts` | API clients. Every writing call goes through `anthropic.ts` `ask()`. `settings.brain` `cursor` runs Cursor's `agent` on the Cursor plan (`cursor.ts`, `CURSOR_API_KEY`, model Grok 4.7). `copilot` runs the GitHub Copilot CLI (`copilot.ts`, `copilot -p --output-format json`, `COPILOT_GITHUB_TOKEN` or a server login, $0, usage as `copilot`). `claude` runs Claude Code on J's Max plan by default (`claudecode.ts`: `claude -p`, stream-json, $0, usage as `max-plan`, capped by `settings.claude`); `settings.claude.backend: "api"` brings back the API key  Claude logins: signed in from /admin > AI (`claude setup-token` in a pseudo-terminal, Linux only) or **pasted** (`POST /v1/claude/token`, `claude-accounts.ts addToken`: run `claude setup-token` anywhere, Windows too, and paste the `sk-ant-oat01-` line). On Windows Gen runs the `claude.exe` behind npm's `claude.cmd` (`claudecode.ts claudeProgram`) |
| `src/audio/`, `src/providers/audio/`, `src/tools/audio-open.ts`, `post/audio/`, `tools/audition.mjs`, `tools/house-voices.mjs`, `workflows/audio-sfx-sa3` | **The sound suite** (docs/audio.md): `registry.ts` (open models, licenses, refused ones), `house.ts` (the house voices `hv_`), `direction.ts` (direction mapped per model), `plan.ts` (model pick, `routeAudio`: audio.voice/sfx/dialogue/... hand a call to the open twin via `Tool.route` at submit), `voicelib.ts` (Gen voices `gv_`, table `audio_voices`), `post.ts` (ffmpeg: LUFS, clipping, silence, loops), `verify.ts` (word error rate). GPU side: one venv per model under `/opt/hawkes-audio`, run by `post/audio/run.py`: baked into the GPU worker image for RunPod and Modal (Qwen3-TTS and the transcriber; a `{ hawkes_audio }` request, `server/cloudrun/worker.py`), or installed on a fleet server by a detached, verified, resumable unit. Sound effects are the Stable Audio 3 workflow. `HAWKESGEN_AUDIO_MOCK=1` swaps the GPU for ffmpeg tones |
| `src/lod.ts`, `src/lod-mesh.ts`, `post/lod.py` | **The LOD system**: every kept image's and GLB's levels of detail belong to the asset (`asset_lods`, `asset_lod_state`, `asset_lod_links` in db.ts; one id, never separate assets). `afterJob` (the queue, when a top-level job finishes) and uploads queue them; `asset.lod` makes them in batches on the CPU (its own `lod` lane, one at a time, yielding to customers' local jobs, lowest priority, child processes at the lowest OS priority; client `gen`, project `hawkesgen.lod`, never charged): images with Pillow (`post/lod.py`), models with gltf-transform + meshoptimizer + Draco in their own process (`src/lod-mesh.ts`; never a GPU server). A job's own low copy (`model.lod1`) is linked to its model, hidden from lists, and used as the low level's geometry. `GET /v1/assets/:id` and list rows carry `lods`; `GET /v1/lods?ids=`; `GET /v1/assets/:id/file?lod=n&v=hash` (ETag, immutable when versioned); `hawkesgen lod status|backfill`. Bump `LOD_VERSION` when the levels made change. docs/api.md "Levels of detail" |
| `src/providers/cloudrun/`, `src/providers/gcp/gcs.ts` | The Cloud Run GPU backend (docs/cloudrun.md): `services.ts` (the map, prices, `cloudRoute`), `run.ts` (`ctx.comfy` as one request per graph, run keys, manifest/heartbeat resume, cancel marker), the queue's `fillCloud` lane in `jobs.ts`; `gcs.ts` is Google credentials (ADC, `HAWKESGEN_GCP_IMPERSONATE`) and a small Cloud Storage client. Tools that work over SSH carry `server: 'ssh'` and never go there |
| `src/providers/gpu/` | GPU providers (docs/gpu-providers.md): `route.ts` (`gpuCandidates`: the order, what is skipped and why; no order = `cloudRoute` exactly), `health.ts` (cooldowns, last errors, `awsRefused`), `auth.ts` (each provider's headers from env), `broker.ts` + `brokerRoute.ts` (`/v1/gpu/broker`: a run token for one run's files) and `sign.ts` (V4 signed URLs through IAM signBlob), `egress.ts` (the fleet from Cloud Run), `status.ts` (`GET /v1/gpu/providers`, the dashboard's Settings > GPU providers card). The queue's GPU lane in `jobs.ts` takes the first provider with room and requeues a job on the next when one is unavailable. Tests `test/gpu-providers.test.ts` |
| `src/cpu/`, `src/providers/cloudrun/cpu.ts`, `server/cpu-cloudrun/` | The CPU suite on Cloud Run (docs/cpu-cloudrun.md): `suite.ts` (the tools, weights, what stays local; the service imports only pure modules, a test checks it), `worker.ts` (a tool's own `run()` against Cloud Storage, and `asset.lod`'s two commands), `server.ts` (the service's door), `cpu.ts` (`cpuRoute` by `settings.cpu`, `runCpuRemote` with resume, retry and fallback to here, `cpuExec` for `src/lod.ts`, `cpuStatus` for `GET /v1/cpu`); the queue's `local-cloud` lane and usage `gcp-cpu` in `jobs.ts`. Setup in `tools/cpu-cloudrun/` |
| `src/quality/`, `src/bench/`, `post/quality/`, `src/tools/quality.ts`, `dashboard/bench.js` | **The quality checks and Gen Bench** (docs/bench.md): `assess()` (identity: insightface buffalo_l on the CPU, `post/quality/identity.py`; the brief as yes/no questions and their answers, the faults per kind, the look: Claude Sonnet through `ask()`; a pass and a `fix`), the tools `quality.identity` / `.checklist` / `.assess`, `HAWKESGEN_QUALITY_MOCK=1` / `withQualityMock`. The bench: 30 briefs (`src/bench/briefs.json`) through the app's real path, every output scored (`bench_runs`, `bench_results`, `bench_ratings`, `bench_cast`), mock runs offline, the market baseline, J's ratings and each score's agreement with them, the admin Bench tab, `/v1/bench/*`, `POST /v1/quality/assess`, `hawkesgen bench` |
| `src/storage.ts` | The library's files in S3 (opt-in: `settings.storage.bucket`; `storage.provider: "gcs"` keeps them in Google Cloud Storage instead, `tools/storage-copy.mjs` copies S3 → GCS): every new file backed up by content in the background, `backfill` for older ones, and missing files restored on demand (a job's inputs, a download) or all at once (`hawkesgen storage restore`) |
| `src/entities.ts`, `src/bus.ts` | The library's structure (docs/library.md): entities (`project/slug`), slots, versions (take, current, old, discarded), `slot:` references expanded at submit, slot recipes (request, entity data, or the project's `kinds` in presets), and filing a job's outputs into its slot. `bus.ts` is the event bus (`job`, `library`) behind `GET /v1/events` |
| `src/library.ts`, `usage.ts`, `auth.ts`, `config.ts`, `db.ts` | Assets and recipes, costs, API keys and roles, settings and paths, SQLite (node:sqlite) |
| `src/mcp.ts`, `mcp-tools.ts`, `mcp-make.ts`, `mcp-http.ts`, `mcp-core.ts`, `mcp-oauth.ts`, `genoauth.ts`, `links.ts` | The MCP server: stdio (`mcp.ts`, talks to the running service over HTTP) and `/mcp` over HTTPS (`mcp-http.ts`); both share the tools (`mcp-tools.ts`). **Signing in is OAuth** (J, 2026-10-30: "no pasted keys"): with no token `/mcp` answers 401 naming `/.well-known/oauth-protected-resource/mcp`; the editor registers itself, opens `/oauth/authorize` (Continue with Google, then Allow) and gets an `hgm_` token that is the Gen account everywhere a key is (`users.ts authenticateRequest`); connections are listed and revoked at `/v1/users/me/connections`. Keys and platform tokens still work. **The friendly tools** (`mcp-make.ts`, the app's Create groups for an editor: generate_image, edit_image, remove_background, upscale_image, make_texture, make_skybox, character_views, make_3d_model, rig_character, animate_character, animate_image, make_video, make_sprite_sheet, voice_line, sound_effect, make_music, list_voices, upload_file, account) work in the account's own project; outputs come back as signed download links (`/dl/`, a day) and uploads go through one-time links (`/up/`, `curl -T`, 30 minutes; `links.ts`). `mcp-core.ts` and `mcp-oauth.ts` are the same files as in hawkesstudio. Test `test/mcp-oauth.test.ts`. The gen-edge Worker keeps these paths on Gen (`genOnly`) |
| `post/` | Python: `prep.py` (frame, motion, canvas), `cutout.py` (rembg; ISNet where there is no room for BiRefNet's ~8.5 GB, `--mask` for a mask made on the GPU by `image.cutout-gpu`, which BiRefNet cutouts go to when a GPU provider is up: `src/tools/cutout-gpu.ts`, docs/cpu-cloudrun.md), `texture.py` (tile, material maps) |
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
- **Customer mode** (`github` with the customer's own `token`, `out: "artifact"`; `src/providers/builder/customer.ts`):
  the one way a `user` key may run `unity.build`. Their repo at one commit on Cloud Run (the customer twin of its Unity version's job,
  `settings.unityBuild.gcp.images`), the output back as a `.tar.gz` asset; the token stays in memory only. Isolated: only on the customer job
  (`gcp.customerJob`, account `unity-customer@` with no roles, checked before each build), the bucket only through
  per-execution V4 signed URLs (`HAWKES_SIGNED`); setup `tools/unity-cloudrun/customer-setup.mjs`. docs/unity-cloudrun.md, "Customer mode".
  **Machine sizes** (`machine` param, `settings.unityBuild.gcp.sizes` / `customerSize`, default `m` = 4 vCPU / 16 GiB;
  `src/providers/builder/sizes.ts`): one Cloud Run job per size (`<customer job>-<size>`, xl = the customer job), made or
  brought in line by Gen from the customer job (else the customer job, with a warning), out of memory = once more a size
  up; priced and charged per size (`billing.ts unityBuildCredits`). Test `test/unity-build-sizes.test.ts`.

## The app (hawkesgen.ai `/`)

Hawkes Gen is a product of its own (J, 2026-10-29): people sign up at hawkesgen.ai with Gen's own accounts
(`src/users.ts`: email and password, starter credits, Stripe packs), separate from hawkesgen.ai's and Studio's. The
portal and Studio use Gen in the back end with their own keys.
- **The app** (`dashboard/gen/`: plain HTML, CSS and ES modules over `/v1`, no build step) is at `/`: one page for
  everything Gen makes, a video editor with generative AI built in (J, 2026-10-29: "a proper video editor" with "a bad
  ass AI editor on the right pane"), and the whole studio the portal's Asset Studio was heading for (J, 2026-10-29:
  "keep this sleek interface and do much much more", "all in one place", the assistant on the side, one page).
  - **Scenes** (`src/scenes.ts`, `scenes.js`; J, 2026-10-29: "put in the idea of scenes and make them plug and play with
    each other ... the edit tab shouldn't just be about videos ... Make tabs too"). Everything a person makes is a scene
    of a kind, in one table (`scenes`: id, project, kind, title, doc, version), each kind registering how its document is
    checked (`registerKind`: normalize, blank, resolve finished jobs, the scenes it uses):
    - `video`, `image`, `audio`: a timeline (src/timeline.ts, registered in src/editor.ts). `stage` (src/director.ts): a
      3D shot. `character` (src/scenekinds.ts): a person or creature to cast.
    - The editor's projects (`editor_projects`, live) and the director's shots came in once with their ids
      (`scene_migrations`); `/v1/editor/projects` and `/v1/director/shots` are views onto the store (MCP keeps working).
    - **Plug and play:** a document names other scenes (a timeline clip's `scene`, a stage cast member's `character`);
      `uses` lists them with their render. A scene's `render` is its latest
      output (`PUT /v1/scenes/:id/render`: the export, the film, the flattened picture, the mixdown, a character's face).
      A clip or layer that plays a scene keeps `sceneVersion`; when the scene renders again, the editor offers to update
      (`staleBar`). A character's name, look, voice, height and model reach every shot that casts them
      (`castFromCharacters`, on every read and save).
    - Timeline clips and a character's pictures and model can wait on jobs (filled in on read: `resolvePending`,
      `resolveElements`).
    - **The app:** open scenes are tabs in the bar (open, close, reorder by drag, rename by double-click, remembered per
      browser; "+" makes any kind). Each kind has an editor with one shape (`registerEditor`: mount, unmount, panel,
      undo/redo, the bar's action, accepts/drop, rename, and either `timelineKind` or the lanes it lends the timeline):
      `editor.js` (video, image and audio: the timeline below), `director.js` (stage: the Shot panel, Film it, Photo; it
      lends the timeline its lanes), `character.js` (the sheet: look, voice with preview, pictures by role, the 3D model
      and its clips; Make their pictures; Make the 3D model through cutout, view sheet and mesh.views3d, optionally
      rigged; Stage them). `scenedoc.js` is the character editor's document (versioned saves, undo, following jobs).
    - The left pane's **Scenes** tab lists every scene (search, kind); drag one into the scene in front (onto the center
      or a track): a character onto a stage; a stage's film, an image scene's picture, a video's export or an audio
      scene's mixdown onto any track of a timeline. Each row's menu has Open, Use in
      the scene in front, Duplicate and Delete.
    - **The AI:** video, image and audio scenes have the AI editor (`applyOps` over the timeline, told the kind: an image
      is the frame at the playhead, audio is the mix). **The character AI** (`src/sceneai.ts`, `POST
      /v1/scenes/:id/assistant`) answers with the whole sheet and the jobs to run; an element to make is marked `gen: n`,
      a job's input `el:<id>` is an element's file; over the auto limit it comes back as a proposal (`POST .../apply`).
      House AI and credits as the others. The AI pane follows the tab in front (AI editor, AI director, Image AI, Audio
      AI, Character AI).
    - Sequences (a stage's shot list) were called scenes before: `stage_sequences`, `doc.sequence`,
      `/v1/director/sequences/:id`. Filming a sequence makes a new video scene whose clips play each shot.
  - Buttons: primary actions are solid (`--text` on dark), never gradients (J, 2026-10-29: "Get rid of these blue gradient
    buttons, they scream made with AI"). The accent color marks selection and focus only.
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
  - **The timeline is everything** (J, 2026-10-29: "I think we can have everything be on a timeline. Let's make the
    timeline always visible and the center should always be the visualization of what you are scrubbed on ... There
    should be a way to layer more than one type of scene on each track ... make things like unity editor (just minus the
    docking) ... on mobile I can drag and drop things onto the timeline"):
    - **One document** (`src/timeline.ts`, version 2) under video, image and audio scenes: tracks top first (a higher
      track draws over the ones below), each with a role (main, video, text, audio, any), `magnetic` (clips back to back;
      off unless the person turns it on: J, 2026-10-30, "you should be able to place them where ever in time"), hidden,
      locked, mute, solo, volume, pan. Clips on one track never overlap (`fitStart`: a dragged clip stops against its
      neighbours or jumps to the nearest gap; trims stop at them; and `layout`, on the server and in the app, slides any
      clip that would start inside the one before to just after it, so an AI plan or a paste pushes later clips along). Any clip on any track: video, image, audio, text or
      a color `fill`, placed on the frame by `x`, `y` (its center, shares of the frame) and `w` (a share of the width;
      none: fit the frame), turned, faded, blended; sound with volume and fades. Version 1 video documents and the first
      image (layers) and audio (tracks of clips) documents convert on read, keeping their clip ids. Edits (`applyOps`)
      add `track` ops (add, set, remove) and placement on `add`/`set`. `test/timeline.test.ts`.
    - **The center** (`player.js`) is the timeline drawn live at the playhead on one canvas at the scene's size: every
      visible track from the bottom up, transitions at the main track's joins, text, push-ins. Sound goes through
      WebAudio (clip gain and fades, track volume, pan, mute, solo) into an analyser; an audio scene's center shows each
      track's waveform scrolling past the playhead, the spectrum while it plays, and the words being said (text clips,
      voice lines' labels). The selected visual clip has handles on the canvas (move, size from a corner, turn from the
      top; snaps to the middle and to 15°).
    - **Exports** become the scene's render: a video scene's is `video.compose` when the cut is plain (pictures and
      clips only on the magnetic track, fitting the frame; text as captions; sound anywhere), else the timeline plays
      once in the browser and records (canvas + mix, `recordTimeline`, webm converted by Gen); an image scene's is the
      frame at the playhead as a PNG (`frameAt`); an audio scene's is the mixdown WAV (`mixdown`, an
      OfflineAudioContext over the same rules).
    - **Adding** goes to the selected track at the playhead whatever its kind (Media's "+", the Inspector, Create's "Add
      to timeline"); with none selected, the track that fits. Ctrl+C, Ctrl+X and Ctrl+V copy, cut and paste clips at the
      playhead (between scenes too: the clipboard is kept in the browser), keeping their spacing and tracks. Adding where a clip already is makes a new layer (a track
      over that one; for sound, under it); with no track asked for, the nearest free track of the same sort first.
      Dropping onto the empty row under the tracks makes a new track.
    - **Saving:** every editor saves on its own a moment after a change; the tab shows `*` until it has, Ctrl+S saves
      now. Ctrl+O (or "+" > Open a scene…) opens a picker of every scene, fresh from Gen. The interface isn't selectable
      text (only fields and the AI's words). The center outlines the frame and shows its size.
    - **Media:** a click picks a tile, a double-click shows it in the center, the "+" adds it.
    - **Browsing the library** (`media.js`): the grid shows thumbnails (clips play muted on hover), filter chips by image, video,
      audio and 3D (`#mediaFilter`), a search box (`#mediaSearch`), and a detail drawer (`openDrawer`, `#mediaDrawer`: the
      prompt, the recipe, **Use in timeline**; Enter or the tile's info button opens it, Esc closes). The `library` playtest
      scenario (`playtest.js`) plays filters, hover, search and the drawer.
    - **First visit and first steps** (J, 2026-10-30: "When a user first enters the website if they aren't logged in then it
      should show a landing type of experience ... selling what it can do. Show 3 categories and highlight its strengths
      ... If it's a new account do a very quick tutorial, just show them 3 sections media, timeline and AI chat. Make it
      modern and not annoying"):
      - `landing.js`: signed out, a welcome covers the app (hero with a small live sketch of the studio, Start free and
        Sign in; three categories Edit, Direct, Generate; four strengths; a closing call to action). "Look around first"
        hides it for the visit; signing in closes it; the help menu's "What Hawkes Gen does" shows it again.
      - `tour.js`: a new account (the sign-in says `created`, or the account is under 30 minutes old) gets three cards,
        each lighting up Media, the timeline and the AI (on a phone: their bottom tabs and the timeline). Next, Back,
        Skip, arrow keys, Esc; once per account in this browser.
      - The bar's **?** menu: Take the quick tour, Keyboard shortcuts (also the `?` key), What Hawkes Gen does, Terms,
        Privacy, Contact.
    - **Friendliness** (J, 2026-10-30: "Everything you can think of to make it powerful and user friendly"):
      - **Start from an idea** (`starters.js`): "+" and an empty scene offer briefs per kind (trailer, slideshow,
        talking character, poster, thumbnail, podcast intro, ambience, two-person scene, a new character); picking one
        makes the scene and asks its AI to build it.
      - **Search everything** (`palette.js`, Ctrl+K or the bar's search): scenes, new scenes and ideas, actions on the
        scene in front, panes, every Create tool; anything else is "Ask the AI".
      - **Progress where the work is**: a waiting clip says "In line (2 ahead)" or its step; the bar's "Making n" pill
        counts what's being made or uploaded (click: Media). A finished job with no place says so ("Look").
      - **Friendly errors** (`lib.js friendly`, `media.js showError`): plain words and the fix (Add credits, Try
        again); the credits pill turns amber under 25.
      - **Undo toasts** after deleting clips, cutting a stretch or removing a track.
      - **Back where you left off**: each timeline scene keeps its playhead, zoom and scroll in the browser.
      - **Names from content**: an "Untitled" scene takes the name of the first thing put in it; a name that's taken
        gets a number (`scenes.js uniqueTitle`: "Poster 2").
      - **File drops**: on the timeline or the center they go into the scene in front (a stage takes them where
        dropped); elsewhere to Media, with "Add to the timeline" on the toast.
      - **Share** (`POST /v1/assets/:id?share=1`, `links.ts shareLink`): a signed link anyone can open for a week, shown
        in the browser (`/dl/...`, inline); from the export and the viewer, the phone's share sheet on phones.
      - Media marks files the scene in front uses ("In use"); phones pinch-zoom the timeline and get bigger handles.
      - **Waiting clips** (J, 2026-10-30): one status per job (`project.js PROGRESS`, `lib.js jobStatusText`: "In line (2
        ahead)", or "Waiting for a free server" when the queue says none can take it) on the clip, the picture and its
        Media tile; Media lists the scene's waiting clips beside its own jobs, each with Stop (`stopClip`: cancels the
        job, undoable); clips waiting when the page opens are followed at once.
      - **The AI pane queues**: a message sent while the AI is answering waits its turn (shown, the box cleared, Remove)
        and goes next; the send button spins while it works but always takes input.
      - **Account**: the avatar opens a menu (who, credits, Account and credits, Add credits, Admin for admins, Help,
        Sign out last); the account sheet is credits first, packs and plans as cards, your own AI tucked away.
    - **Usability rules** (J, 2026-10-30: "The point of the AI is that it's supposed to help with these finer tuning and we
      want to hide away most advanced knobs and stay away from input fields if possible. It needs to feel more drag and
      drop, and if I am dragging something that's not supported then it should tell me why"):
      - **Every drag explains itself** (`dragdrop.js`): a note follows the pointer or finger saying what the drop does
        ("Add to "Music" at 0:03") or, in red, why it can't and what to do instead; letting go there toasts the reason.
        Targets register `check`/`show`/`drop`; editors answer `explain(item)` (`timelineRefusal` for timelines,
        `stageExplain`, the character's). What's dragged is told at dragstart (`setDrag`).
      - **Simple first, knobs under "Fine-tune"** (closed): the Inspector leads with "Ask the AI" chips for what's
        selected (`askAi`, one tap sends), Gen's tools, then sliders, chips and swatches; numbers and menus wait below.
      - **Adjust by dragging**: on the frame (move, size, turn), on the timeline (move, trim, fade dots at a sound clip's
        top corners).
      - **Empty states start you off**: an empty scene's center offers Upload, From Media and Ask the AI; added things
        land where you see them (the playhead goes to them; on the main track they go after the last clip if the
        playhead's spot is taken: `startFor`).
      - Clicking a clip brings its Inspector forward on a desktop (not while a Create form is open); the tools under the
        center hide while the Inspector shows them.
    - **The Inspector** (`editor.js`, the left pane's tab): Gen's tools for the selected clip first (`tools.js clipTools`:
      Remove background, Edit, Repaint, Expand, Relight, Upscale, Animate; for clips Change, Restyle, Swap, Continue...;
      also at the top of a clip's right-click menu), then the clip (track, start, length, speed, place,
      size, turn, opacity, blend, push-in, words and their style, color, volume, fades), the selected track (name,
      color, hide, lock, magnetic, mute, solo, volume, pan), or the scene (shape, fit, background, length, tempo, fps).
    - **Other kinds keep the timeline on screen:** a stage lends it lanes (each person's moves, which stretch; camera
      keys and lines, which move; the playhead is the stage's: `director.js` `LANES`); a character says it has none.
  - Layout: Media, Create, Scenes and the Inspector on the left (`media.js`, `studio.js`, `scenes.js`, `editor.js`), the
    center with the tools for what's selected (`player.js`, `tools.js`), the AI on the right (`ai.js`), the timeline
    below (`timeline.js`). **Areas size like a desktop editor's** (`gen.js` `AREAS`): drag an edge; drag it past half its
    smallest size and the area folds away (its edge stays to drag it back; the timeline folds to its bar); double-click
    an edge to fold or unfold; sizes kept per browser. **On a phone** the center and the timeline stay on screen with a
    sheet below for Media, Create, Scenes, the Inspector or the AI (bottom tabs; the sheet and the timeline size by their
    top edges, nearly the whole screen: a strip of the picture and the timeline's bar always stay; J, 2026-11-01: menus
    open as sheets from the bottom and scroll inside, the page never zooms, no logo in the bar), and a Media tile or a Scenes row drags onto a track with a finger: hold it, then drag (`dragdrop.js`:
    a ghost follows, the track lights up; the timeline and the center register as drop targets).
  - **The project** (`project.js`, `src/editor.ts`): the timeline scene in front, saved to Gen
    (`/v1/editor/projects/:id`, any timeline kind, with a version: a save that crosses another one gets 409 and the
    newer document), undo and redo, waiting clips filled in when their jobs end, edits made elsewhere (the AI, MCP,
    another tab) picked up. A new video starts with Text, Video (magnetic), Music, Voice and Sound; an image with Top,
    Middle and Background; audio with Music, Voice and Sound. Nothing is added that the person didn't ask for: no fades
    or transitions unless set.
  - **Timeline:** track heads (name: double-click to rename; hide, lock, mute, solo; a menu with volume, pan, magnetic,
    move up or down, add above or below, remove); drag a clip to move it, to any unlocked track (a magnetic track
    reorders); edge handles trim; snapping; split (S); delete; duplicate; a selected time range (drag on an empty track
    or shift-drag the ruler; I and O); transitions at the main track's joins; zoom (Ctrl+wheel); bars on the ruler for
    an audio scene with a tempo; keyboard (Space, arrows, Ctrl+Z / Ctrl+Shift+Z, T for text; arrows nudge the selected
    picture in an image scene, Alt+arrows elsewhere). Thumbnails and waveforms are made in the browser (`lib.js`).
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
    effect, each priced; with "Add to timeline", sounds land at the playhead on their track and music at 0. Voice-overs and sound effects run on Gen's own models (J, 2026-10-30: "We have our own
    audio jobs on gen right? We should use those"; "fast and cheap ... AND we want quality"): voices on Qwen3-TTS in the
    house voices (`GET /v1/editor/voices`, `editorVoices`, `src/audio/house.ts`: `hv_` ids, never ElevenLabs or the
    account's own character voices), sound effects on Stable Audio 3, both on RunPod or Modal like every GPU job
    (docs/audio.md, "Where it runs"). `audio.revoice` stays out: changing a voice is ElevenLabs only. **Uploads** by button or drop anywhere (on the timeline: placed too). **3D files** (`model3d.js`; J, 2026-11-08: an FBX on a stage "just turns into a box"): everything reads GLB, so an FBX or OBJ is converted to GLB in the browser before it goes up (FBXLoader/OBJLoader, vertices merged, GLTFExporter with the skeleton and every clip). Pictures dropped or picked with it become its textures by name, then by shared words (`head_basemap.png` gets `Person_Head.png`), and a lone picture fills the first texture asked for. Material maps (normal, gloss...) are left out of Media. The note says what was kept and what is missing. FBX files uploaded before this are read by the stage's FBXLoader fallback.
  - **Export** (a video scene) maps a plain cut onto `video.compose` (pictures first become clips with `video.still`;
    captions burned in; a track named Voice is dialogue, one named Music ducks under it), and renders a layered one in
    the browser (above).
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
    - **Scenes** (J, 2026-10-29: the shot list): a scene (`director_scenes`; each shot's doc has `scene` and `order`) is shots
      in order that share the shape, the look, the set and the film settings, and each cast member's identity (name,
      look, model, clip, height, color, voice) by id: a save carries those to the other shots (`shareAcross`); blocking,
      camera, action and lines stay per shot. The Shot tab's strip lists the shots (open, move earlier or later, Next
      shot adds one after with the same cast where they stand; on a lone shot it makes the scene). `GET/PUT
      /v1/director/scenes/:id` (title, order), `POST /v1/director/shots/:id/next`; a shot's GET and PUT carry
      `sceneInfo`.
    - **The AI director plans scenes**: it sees every shot of the scene and the voices, and answers with every shot in
      order (`shots`, `current`, `sceneTitle`; `applyDirector`): kept shots by `shotId`, new ones made, ones it leaves out
      leave the scene (never deleted); two or more shots make a scene. Coverage like an editor cuts it (establishing,
      over-the-shoulder, reverse, close-ups), continuity, the 180° rule, a voice for every speaker.
    - **Dialogue**: `lines` per shot (`who` a cast index, `text`, `at` seconds) and a `voice` per cast member (a house
      voice, `/v1/editor/voices`). A shot is `kind` `action` (filmed from the stage) or `talk` (a dialogue close-up:
      the first line in the speaker's voice drives video.talk on the painted first frame, InfiniteTalk's size per shape,
      frames from the line's length). Lines are made with audio.voice and laid on the Voice track at their moment; an
      action shot's own sound plays at half under them (its prompt asks for room tone, not words), a talk shot's is
      muted.
    - **Film the sequence** (the strip's button): every shot recorded on this stage in turn (`withShot` borrows its
      document; nothing saves meanwhile), all filmed at once, each take becoming its shot's render, then cut into a new
      video scene (`cutOf`: clips that play each shot, lines on Voice, a talk shot's sound muted). A failed shot is
      reported and the rest are cut. Filming one shot makes its take the stage's render ("Put it in a new video").
    - **Placing things** (J, 2026-10-30): click a person or prop to select it, then its gizmo (three.js
      TransformControls): Move on the ground, Turn, Size (a person's height), switched by the bar at the top of the stage
      or W, E, R; Delete removes, Escape lets go; walk markers still drag on the ground. Right-click a person or prop
      for its menu (modes, face the camera, point the camera at them, add a walk, make a model a person, change the
      model or what a screen shows, duplicate, remove), or the ground to add a person, a box, a model, a picture or a
      character there. The UI says "3D", never "Blender".
    - **Drops on the stage** put things where they're dropped: a character joins the cast, a 3D model becomes a prop, and
      a picture, a video or a scene's render (an image, a video, another stage's film) becomes a **screen** (a prop with
      `shape: "screen"`, `media`, and `scene` / `sceneVersion` when it shows a scene; `size` is its width). Screens are
      filmed as they look; the 3D render pipeline leaves them out.
    - **Photo**: the stage at the playhead through the shot camera, painted in the look; it opens as an image scene, or
      animates (video.i2v).
    - The Create list starts with **Direct a shot or a scene**, which opens a new stage tab.
    - **Blender** (`POST .../blender`, `?quote=1` prices it): the same shot through `film/recipes.ts cinemaPass` as one
      `asset.make` (gate, blender.render, best-of-3 keyframe, video.control, upscale). Every cast member needs a model;
      it queues until the fleet is back.
  - `test/editor.test.ts` covers the document and routes; `test/timeline.test.ts` the timeline (old documents
    converted, any clip on any track, track edits); `test/scenes.test.ts` the store, the migration, the kinds,
    characters in shots, the character AI's answers and the routes; `test/director.test.ts` the house AI, admin accounts and
    the director; `test/saas-ui.test.ts` checks every id the modules look up
    is on the page.

  Sign-in is **Continue with Google** (`POST /v1/users/google`, `users.ts googleSignin`), inline: the first Generate
  asks, then goes on. One Google account signs in to every product (portal, Studio, Gen), each keeping its own
  account. A Gen account is found by Google's permanent id (`user_google`), else by its email (an older account,
  linked), else made with the starter credits. **No email and password** (J, 2026-10-30: "I don't want email and
  password"): off everywhere, local runs included (410 `google_only`); `HAWKESGEN_PASSWORD_LOGIN=1` turns them on only for
  automated tests and throwaway local copies without a Google client. The app uses the admin
  dashboard's Google client (`settings.dashboard.googleClientId`); its JavaScript origins must list each Gen address.
  The editor's timeline lives in the browser (`localStorage`).
- **Paying** (`src/subscriptions.ts`, `src/billing.ts`, `test/subscriptions.test.ts`):
  - **Plans:** monthly plans grant credits every paid month. Defaults (provisional): Creator $12 = 1,500 credits,
    Pro $39 = 5,500, seeded when the table is empty; the owner changes them at `POST /v1/subscriptions/plans`.
  - **Credit packs** (`billing.ts`, `test/billing-checkout.test.ts`): one-off. `POST /v1/billing/checkout` makes a Checkout
    session in payment mode (tagged `product: gen` on the session and its payment, the receipt emailed to the account,
    one Stripe customer per account) that returns to the app it came from (only Gen's own addresses, `returnOrigin`).
    Back in the app (`account.js backFromCheckout`) one `GET /v1/billing/checkout/<id>` says paid, processing, declined
    (Stripe's own words), cancelled or expired, gives the balance and Stripe's receipt, and grants a paid pack if the
    webhook hasn't yet: both go through `fulfilPackSession`, keyed by the session in the ledger, so credits come once. A
    pack's credits are Gen's number, not the metadata's. No polling: the balance is asked again when the sheet opens and
    when the page comes back into view (at most every 30 s). The sheet lists the last purchases with their receipts and
    says "Test mode" with the test card when Stripe's keys are test keys. Playtest scenario `checkout` (no Stripe call).
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
    `POST /v1/billing/config`: /admin Settings > Payments, keys never shown again) and a webhook endpoint at
    `https://<gen>/v1/billing/webhook` for `GEN_WEBHOOK_EVENTS` (the checkout's completed, async succeeded and failed,
    expired; `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` and `.deleted`). **Set up the
    webhook** (`POST /v1/billing/webhook/setup`, owner) makes or updates the endpoint for exactly this address and keeps
    its signing secret; it never touches another URL's endpoint, and replaces one for this address only when asked.
    `/v1/health` says `stripe: { configured, mode, webhook }` (never a key). Beta uses test keys; going live is the live
    keys on live Gen and Set up the webhook there.
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

- **Customers' Studios pay from their Studio balance** (`src/orgcredits.ts`, `test/orgcredits.test.ts`; hawkesstudio
  `docs/studio-customers.md` "Billing"). A cell's key (role user, projects `org_<hex>` and `org_<hex>.*`, made by
  Studio's control plane) has no Gen account, so its jobs are charged to its org's credits in Studio's control plane,
  one bank for every path: `createJob` (via `submitJob` / `rerunJob`, which every HTTP route uses: `/v1/jobs`, `/v1/run`,
  reruns, entity make, the director, upload normalizing, and `/mcp`, which calls `/v1/jobs` with the caller's key) prices
  the job with `quoteJobCredits` and calls `POST <control>/api/cells/gen/charge {genOrg, credits, job, tool}` before the
  job exists. 402 refuses it (kind `credits`, the control plane's own "This studio is out of credits: ..."); unreachable
  or any other answer refuses it too (fail closed, 503). A job that fails or is cancelled is refunded
  (`/api/cells/gen/refund {genOrg, job}`, once; misses retried every 2 minutes from `org_charges`). A job handed back by
  `reuse` or the same `key` never reaches createJob: free. Owner and admin keys, Gen itself (chains' steps), Gen app
  accounts, the portal's keys, platform tokens and `settings.platform.freeOrgs` are never charged. The synchronous
  `submit`/`rerun` (scenes' and the editor's AI) refuse such a key while this is on (403 kind `credits`), so nothing is
  free. A charged job carries the label `orgCredits`. **Turning it on, per lane:** the control plane's key (Studio:
  `GET /api/cells/gen-key`, platform admin only) goes in the secret `<service>-org-credits-key` (`gen-org-credits-key`,
  `gen-beta-org-credits-key`), mounted as `HAWKESGEN_ORG_CREDITS_KEY` by `tools/gen-cloudrun/deploy.mjs` once it exists
  (locally: `.env`); the URL in `settings.orgCredits.url` (`POST /v1/settings {"orgCredits":{"url":"https://studio.hawkesgen.ai"}}`,
  beta: studio-beta's) or `HAWKESGEN_ORG_CREDITS_URL`. Both set: `/v1/health` says `orgCredits: true`, and cells stop
  charging on their own side. The key is never logged or returned.

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
- **S3 (off by default since the AWS suspension):** with `HAWKES_PLAYTEST_BUCKET=<bucket>` each run's video and report
  also go to `s3://<bucket>/<project>/<date>/<job>/` (private, Infrequent Access after 30 days; created on first use).
  `result.s3` has the keys; Studio serves them through short-lived signed links, and otherwise from Gen's library.
- **Video:** on a GPU machine, a CDP screencast (`src/tools/screencast.ts`: every frame Chromium draws, kept at a steady
  30 fps, encoded after the run on the machine that played it: NVENC, else libx264; on the control server only if that fails), about 30 distinct fps even with two playtests on the
  playtester; elsewhere, or if the screencast won't start, Playwright's `recordVideo` (25 fps). `recorder` forces one;
  `result.recorder` says which. Measurements and the alternatives tried (tab capture): `docs/playtest-video.md`.
- **Reviews converge** (`playtest.review` v3): at most `maxFindings` (default 5) new findings, worst first, polish and ideas
  only without bugs; `known` (the caller's backlog) is never reported again, and the answer says by id which known ones
  look fixed or still present; `mode` full / verify / regression (the last two report only regressions and blockers);
  `bar` (the product's quality bar) is judged as `meetsBar`. `settleReview` enforces the caps and mode on the answer
  (tested in `test/playtest.test.ts`). Studio's side: `hawkesstudio/docs/daily.md` ("Reviews converge").
- **Motion** (`playtest.review` v5, `src/tools/playtest-motion.ts`): besides the stills, the judge sees `motion`
  (default 6) contact sheets, each 1.2 s of the run's video at 15 fps tiled 6x3, placed on the feel flags (bugs first),
  problems and scenes, the rest spread over the run; they're filed as `playtest: 'motion'` assets so findings cite them.
  ffmpeg's `freezedetect` on the recording finds hitches with nothing from the game (a freeze of 150 ms to 1 s in the
  middle of motion; not on software rendering). `review.motion` has the sheets, the hitches and `worstHitchMs`; Studio
  holds the hard limits (`hawkesstudio/docs/quality.md`). No video or no ffmpeg: stills only, said in `motion.note`.
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

## Quality checks and Gen Bench

Every AI-made output is meant to pass `src/quality` `assess()` before a person sees it (docs/worlds-roadmap.md principle
2): face identity against the character's references, the brief's yes/no questions, the obvious faults for its kind and
the look, with a `fix` for the next try. Gen Bench (docs/bench.md, the admin Bench tab) runs 30 fixed briefs through the
app and scores them so a change to prompts, models or checks is measured, not believed. **Run a mock bench
(`hawkesgen bench run --mock`, free) after changing the assistants or the checks.** Real runs are the owner's, priced first.

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
