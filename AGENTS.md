# Hawkes Gen — agent guide

The shared generative-AI service for every Hawkes Biomedical game and site. Games describe **what** they want
(edit this image, a clip from this pose, a material, a song, speak this line, answer as JSON). Hawkes Gen
decides **how**: which GPU server, which ComfyUI workflow and models, which API. It keeps the result and the
recipe that made it. Projects never touch AWS, ComfyUI or API keys.

- `README.md` is the overview and the tool list.
- `docs/workflows.md` covers ComfyUI workflows as tools.
- `docs/api.md` lists every route.
- `docs/comfyui.md` records what works on the GPU servers.
- `docs/blender.md` covers Blender shots to video (`blender.render`, `video.control`).
- `docs/library.md` covers the library every product builds on: entities, slots, versions, slot references, make/revise/pick.
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
| `src/tools/` | Tools written in code. `types.ts` (what a tool is), `comfy.ts` (image.edit, image.paint, video.i2v, video.animate, comfy.graph), `api.ts` (ElevenLabs voice, sfx and voice design; Claude), `local.ts` (this PC), `index.ts` (the list, plus every workflow folder) |
| `src/workflows/` | `convert.ts` (ComfyUI UI → API format, and checks), `registry.ts` (workflow folders, draft manifests), `tool.ts` (a folder as a Tool), `catalog.ts` (the template library cached from a server; import) |
| `workflows/` | **The workflow tools** (manifest + graph + source each): image.generate, image.angles, image.upscale, image.panorama, image.depth, image.normals, image.albedo, image.remove-background, image.segment, video.t2v, video.control, video.control-wan, video.upscale, video.interpolate, mesh.from-image, mesh.textured, audio.music |
| `presets/<project>.json` | Each project's art direction: style line, negative, named presets (tool + prompt template + params) |
| `src/presets.ts` | Loading and applying presets |
| `src/providers/comfy/` | `fleet.ts` (AWS launch/start/stop/adopt, SSH, model install/prune), `client.ts` (ComfyUI HTTP), `graphs.ts` (the code-built graphs), `retry.ts` (keep trying) |
| `src/providers/builder/builder.ts` | The Unity build server: launch (Windows + Unity via `server/builder/bootstrap.ps1`), start/stop, SSH, incremental sync of `C:\Projects` folders, detached builds (`server/builder/build.ps1`), pulling the build back |
| `src/tools/blender.ts`, `src/providers/blender/` | `blender.render`: Blender 5.0 on a GPU server (installed on first use; `install.ts` is shared with `bootstrap.sh`), a job workspace in `/var/tmp/hawkes-blender`, a detached render followed over SSH. The scripts are `post/blender/hawkes_blender.py` (inside Blender) and `post/pose_draw.py` |
| `src/tools/build.ts`, `playtest.ts`, `pipeline.ts` | `unity.build`; `playtest.run` (Playwright) and `playtest.review` (Claude); `asset.make` (chains, best-of-N with canon and references, library reuse) |
| `src/estimate.ts` | Cost estimates for a planned batch (`POST /v1/estimate`) |
| `src/providers/elevenlabs.ts`, `anthropic.ts` | API clients |
| `src/storage.ts` | The library's files in S3 (opt-in: `settings.storage.bucket`): every new file backed up by content in the background, `backfill` for older ones, and missing files restored on demand (a job's inputs, a download) or all at once (`hawkesgen storage restore`) |
| `src/entities.ts`, `src/bus.ts` | The library's structure (docs/library.md): entities (`project/slug`), slots, versions (take, current, old, discarded), `slot:` references expanded at submit, slot recipes (request, entity data, or the project's `kinds` in presets), and filing a job's outputs into its slot. `bus.ts` is the event bus (`job`, `library`) behind `GET /v1/events` |
| `src/library.ts`, `usage.ts`, `auth.ts`, `config.ts`, `db.ts` | Assets and recipes, costs, API keys and roles, settings and paths, SQLite (node:sqlite) |
| `src/mcp.ts`, `mcp-tools.ts`, `mcp-http.ts`, `mcp-core.ts` | The MCP server: stdio (`mcp.ts`, talks to the running service over HTTP) and `/mcp` over HTTPS with the caller's API key (`mcp-http.ts`); both share the tools (`mcp-tools.ts`). `mcp-core.ts` is the same file as in hawkesstudio. Setup for Claude anywhere: `hawkesstudio/docs/cloud.md` |
| `post/` | Python: `prep.py` (frame, motion, canvas), `cutout.py` (rembg), `texture.py` (tile, material maps) |
| `server/` | What GPU servers install at launch: `bootstrap.sh`, `models.json` (core models by family), `templates/` |
| `dashboard/` | The web UI (plain JS over the API) |
| `clients/` | `js/hawkesgen.mjs`, `python/hawkesgen.py`, `unity/com.hawkes.gen` (editor package). Projects copy the JS/Python files; Unity projects reference the package by path |
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
- **Where the browser runs:** on the Linux control server, the **playtester** first (`src/providers/playtester/`: a
  g4dn.xlarge with a T4, about $0.53/hr; any game playtest starts it when it's off (site crawls don't), Studio's daily run also stops it at the end; it installs itself from
  `server/playtester/bootstrap.sh` and powers off after 20 idle minutes; `hawkesgen playtester status|launch|start|stop`),
  else a ready GPU fleet server, else software. On this PC, its own GPU.
- **Lanes:** two playtests at a time on the playtester, three on a GPU fleet server, one on this PC or in software (the
  local browser also takes turns inside `playtest.run`).
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
| Dose Of Destruction | `tools/gpu/gen.mjs` + `jobs.mjs`: the GPU tab and every fighter/stage job. Sound and voice tabs: `audio.*`. Map designer and art review: `llm.json` |
| Sick Of It | `Tools/Art/art.mjs` (enemy art). Window > Hawkes Gen in Unity. SickOfIt > Audio > Sound Generator (`Assets/Scripts/Tools/Editor/Audio/HawkesGenAudio.cs`): `audio.sfx`, `audio.voice`, `audio.voice-design`, `audio.voice-save` and `recipes/check` through `com.hawkes.gen` |
| PH Origins | `tools/voiceLines.mjs`, `tools/soundEffects.mjs` (`audio.*`), `tools/genMaterial.mjs` (materials) |
| Breaking Through, Yooba Land | Window > Hawkes Gen (Unity package) |
| Every project folder | The `hawkesgen` MCP server in `.mcp.json`, plus a "Generative AI: Hawkes Gen" section in its AGENTS.md |

The JS client in projects is a copy of `clients/js/hawkesgen.mjs` (`CLIENT_VERSION` in the file). Copy it
again when it changes. The library's web components (`hawkesgen-ui.mjs`, `UI_VERSION`) and the folder bridge
(`hawkesgen-folders.mjs`) are copied the same way; DoD has all three
(`src/devtools/hawkesgen/` for the browser, `tools/gpu/` for its dev server).
- `doseofdestructionwebsite/tools/gpu/hawkesgen.mjs`
- `phoriginswebsite/tools/hawkesgen.mjs`
- `sickofitgame-unity/Tools/Art/hawkesgen.mjs`

## Checking your changes

- `npm run typecheck` and `npm test`, then restart the service.
- Run a tool from the dashboard's Tools tab or `hawkesgen.cmd run <tool> ...`. Local tools are free.
- Every job keeps its log, params, inputs and ComfyUI graphs (dashboard → job). Drag a graph into ComfyUI to
  debug it.
- The Unity package: compile-check it by opening a Unity project in batch mode (exit 0, and
  `HawkesGen.Editor.dll` in the log).
