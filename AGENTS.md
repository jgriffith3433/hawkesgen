# Hawkes Gen — agent guide

The shared generative-AI service for every Hawkes Biomedical game and site. Games describe **what** they want
(edit this image, a clip from this pose, a material, a song, speak this line, answer as JSON). Hawkes Gen
decides **how**: which GPU server, which ComfyUI workflow and models, which API. It keeps the result and the
recipe that made it. Projects never touch AWS, ComfyUI or API keys.

- `README.md` is the overview and the tool list.
- `docs/art-playbook.md` is the art playbook: which tool for which job, recipes, performance budgets. Read it before making game art.
- `docs/workflows.md` covers ComfyUI workflows as tools.
- `docs/api.md` lists every route.
- `docs/comfyui.md` records what works on the GPU servers.
- `docs/blender.md` covers Blender shots to video (`blender.render`, `video.control`) and rigging generated characters (`mesh.rig`).
- `docs/film-pipeline.md` covers the film pipeline: shots with beats and props in hands, the director gate (`film.gate`), the cinema, dialogue, VFX-layer and LoRA recipes (`film.plan`), the trailer cut and what a trailer costs. **Making a trailer, a cutscene or any shot with Blender as the motion rig: start with `film.plan`, run `film.gate` before spending GPU.**
- `docs/3d-characters.md` covers `blender.character` (clean, bake, props, retarget, clip edits, FBX/GLB), the `character3d` kind, the CC0 Quaternius motion library (`motion:<pack>/<clip>`, preset `shared/motions`), and `motion.from-text` (Kimodo SOMA / HY-Motion).
- `docs/net.md` is **Hawkes Net**: multiplayer for every game (one client SDK, p2p host-star and relay transports, `auto`, binary protocol v3, tickets, limits, usage, hosting, measured cost per 1,000 players). Its first section says what is built and how to use it; the rest is the design.
- `docs/audio.md` covers the sound suite: open voice/SFX models on the fleet (primary), ElevenLabs (secondary), `provider` routing, the Gen voice library, direction, post-processing, the audition (`tools/audition.mjs`) and what still needs a GPU run.
- `docs/library.md` covers the library every product builds on: entities, slots, versions, slot references, make/revise/pick.
- `docs/analytics.md` is the player-analytics contract (events every product sends, the collect door, the queries).
- `DESIGN.md` has J's decisions and the roadmap.
- `CLAUDE.md` just imports this file; edit this one.

**Deploys:** this folder is the private repo `jgriffith3433/hawkesgen`. Every push to `main` deploys it to the cloud
(gen.hawkesgen.com): CI (`.github/workflows/ci.yml`: typecheck and tests) must pass, then the control server pulls it
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
| `src/tools/` | Tools written in code. `types.ts` (what a tool is), `comfy.ts` (image.edit, image.paint, video.i2v, video.animate, comfy.graph), `api.ts` (ElevenLabs voice, sfx and voice design; Claude), `local.ts` (this PC), `compose.ts` (video.compose: the finished cut with ffmpeg), `index.ts` (the list, plus every workflow folder) |
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
| `src/tools/build.ts`, `playtest.ts`, `pipeline.ts` | `unity.build`; `playtest.run` (Playwright) and `playtest.review` (Claude); `asset.make` (chains, best-of-N with canon and references, library reuse) |
| `src/analytics/`, `analytics/products.json` | Player analytics (docs/analytics.md): `collect.ts` (the public door: validation, limits, CORS, rate limit), `geo.ts` + `mmdb.ts` (DB-IP Lite GeoIP), `ua.ts`, `store.ts` (`.data/analytics.db`: events, sessions, daily rollups, the purge), `query.ts` + `routes.ts` (the reads). The registry lists each product's origins |
| `src/net/`, `clients/js/hawkes-net*.mjs`, `net/projects.json`, `docs/net.md` | **Hawkes Net** (multiplayer): `node.ts` (a relay node: standalone `node src/net/node.ts`, or the one Gen runs itself at `/v1/net/ws`), `rooms.ts` + `worker.ts` (rooms pinned to worker processes), `ws.ts` (WebSocket, no deps), `tickets.ts` (Ed25519), `service.ts` + `api.ts` (tickets, the directory, heartbeats, usage, publish, status), `registry.ts` (`net/projects.json`: origins, key projects, room defaults, limits). The SDK is `clients/js/hawkes-net.mjs` with `hawkes-net-core.mjs` (room logic + binary protocol, also run in p2p hosts' pages), served at `/sdk/hawkes-net.mjs`; demo `/net.html`; load test `tools/net-load.mjs`. Tests `test/net-*.test.ts` |
| `src/estimate.ts` | Cost estimates for a planned batch (`POST /v1/estimate`) |
| `src/machines.ts` | The Machines monitor (`GET /v1/machines`, the dashboard tab): the GPU servers, build server and playtester measured over SSH (CPU, memory, GPU, disk, network, idle clock) every minute while running, 7 days of history in `machine_samples`, and the alerts |
| `src/providers/elevenlabs.ts`, `anthropic.ts`, `cursor.ts` | API clients. Every writing call goes through `anthropic.ts` `ask()`. `settings.brain` `cursor` runs Cursor's `agent` on the Cursor plan (`cursor.ts`, `CURSOR_API_KEY`, model Grok 4.7). `copilot` runs the GitHub Copilot CLI (`copilot.ts`, `copilot -p --output-format json`, `COPILOT_GITHUB_TOKEN` or a server login, $0, usage as `copilot`). `claude` runs Claude Code on J's Max plan by default (`claudecode.ts`: `claude -p`, stream-json, $0, usage as `max-plan`, capped by `settings.claude`); `settings.claude.backend: "api"` brings back the API key |
| `src/audio/`, `src/providers/audio/`, `src/tools/audio-open.ts`, `post/audio/`, `tools/audition.mjs` | **The sound suite** (docs/audio.md): `registry.ts` (open models, licenses, refused ones), `direction.ts` (direction mapped per model), `plan.ts` (model pick, `routeAudio`: audio.voice/sfx/dialogue/... hand a call to the open twin via `Tool.route` at submit), `voicelib.ts` (Gen voices `gv_`, table `audio_voices`), `post.ts` (ffmpeg: LUFS, clipping, silence, loops), `verify.ts` (word error rate). GPU side: one venv per model under `/opt/hawkes-audio` installed by a detached, verified, resumable unit, run by `post/audio/run.py`. `HAWKESGEN_AUDIO_MOCK=1` swaps the GPU for ffmpeg tones |
| `src/lod.ts`, `src/lod-mesh.ts`, `post/lod.py` | **The LOD system**: every kept image's and GLB's levels of detail belong to the asset (`asset_lods`, `asset_lod_state`, `asset_lod_links` in db.ts; one id, never separate assets). `afterJob` (the queue, when a top-level job finishes) and uploads queue them; `asset.lod` makes them in batches on the CPU (its own `lod` lane, one at a time, yielding to customers' local jobs, lowest priority, child processes at the lowest OS priority; client `gen`, project `hawkesgen.lod`, never charged): images with Pillow (`post/lod.py`), models with gltf-transform + meshoptimizer + Draco in their own process (`src/lod-mesh.ts`; never a GPU server). A job's own low copy (`model.lod1`) is linked to its model, hidden from lists, and used as the low level's geometry. `GET /v1/assets/:id` and list rows carry `lods`; `GET /v1/lods?ids=`; `GET /v1/assets/:id/file?lod=n&v=hash` (ETag, immutable when versioned); `hawkesgen lod status|backfill`. Bump `LOD_VERSION` when the levels made change. docs/api.md "Levels of detail" |
| `src/storage.ts` | The library's files in S3 (opt-in: `settings.storage.bucket`): every new file backed up by content in the background, `backfill` for older ones, and missing files restored on demand (a job's inputs, a download) or all at once (`hawkesgen storage restore`) |
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

## Playtests

`playtest.run` opens a page in Chromium (headless, but on the real GPU through ANGLE/D3D11) and plays it through the
game's playtest contract (`C:\Projects\hawkesstudio\docs\playtest.md`), or a generic smoke test, or a crawl
(`mode: site`). It records video (mp4), screenshots (every few seconds and at events), console errors, failed
requests, load time and fps. `playtest.review` sends the frames and the report to Claude with the product's story and
returns a verdict, scores and findings.
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

Products keep copies of the JS SDK (`clients/js`: the client, the web components, the folder bridge): their own CI
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
