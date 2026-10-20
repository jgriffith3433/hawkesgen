# Hawkes Gen

The generative R&D floor of Hawkes Biomedical: one local service that every game and site uses for custom
generative AI, so projects never deal with GPU servers, ComfyUI, models or API keys.

- **A Unity build server on AWS** (Windows, Unity 6 + WebGL) that keeps every project's Library, so WebGL builds are
  incremental. Hawkes Studio (`C:\Projects\hawkesstudio`) drives it with the playtest and review tools every day.
- **A GPU fleet on AWS running ComfyUI.** Hawkes Gen launches, starts and stops the servers and shares them
  between projects through one queue. It installs each workflow's models the first time a job needs them,
  and frees disk when space runs short. Queued GPU jobs start stopped servers by themselves (`fleet.auto`;
  launching new ones needs `fleet.autoLaunch`, off).
- **Workflows as data.** Any ComfyUI workflow becomes a tool: browse ComfyUI's 245 open-source templates
  (or drop in your own export) and import it. Its inputs, prompts, seeds, sizes, outputs and model download
  links are found for you.
- **ElevenLabs** for voice lines and sound effects. **Claude** for writing, JSON designs and art review.
- **Local tools** on this PC: cutouts, framing, seamless tiling, material maps, video prep.
- **Presets**: each project's art direction (a style line plus named recipes), shared by games, agents and
  people.
- **A library** of everything made, with the recipe that made it, browsable across projects.
- **Usage and cost** per project and per API key.
- **Player analytics** for every product: its own collect door, GeoIP and user agents on the server (no IP kept),
  sessions, funnels, drop-off, retention, levels, errors, perf, builds side by side and plain-sentence insights
  (`docs/analytics.md`). Pages add one script tag (`/sdk/analytics@1.js`); Unity WebGL games add the
  `com.hawkes.analytics` package.
- **Clients for everything:**
  - JS and Python libraries
  - a Unity editor package
  - a CLI
  - an MCP server, so Claude Code (or any agent) in any project folder can use it directly

## Start

```bash
auto-start.bat
```

This opens the dashboard at http://127.0.0.1:8790. The first run installs Node packages and a Python `.venv`.
Keys go in `.env` (see `.env.example`). The dashboard has these tabs:
- Overview
- Jobs
- Library (with 3D previews)
- GPU fleet (servers, models per server, costs)
- Tools (try any tool)
- Presets
- Workflows (the template library and your workflows)
- Usage
- Settings (API keys)

## Tools

| Area | Tools |
|---|---|
| Images | `image.generate` (Z-Image Turbo text-to-image; `seamless` for textures), `image.edit` (Qwen-Image-Edit), `image.paint` (paint styled on references), `image.control` (paint over a render or sketch with ControlNet: grey-box to finished art), `image.relight`, `image.angles` (a character from 8 camera angles), `image.upscale` (Real-ESRGAN), `image.restore` (SeedVR2, finer), `image.panorama` (360° skies) |
| Characters | `lora.train` (train a character LoRA on its poses, with per-image captions or Claude-written ones, on the GPU fleet), `image.character` (draw that character on-model in any pose or scene) |
| Analysis and masks | `image.remove-background` (BiRefNet on the GPU), `image.segment` (SAM 3, find by text), `image.layers` (split into RGBA layers), `image.pose` / `video.pose` (SDPose whole-body pose maps), `image.depth` (Depth Anything 3), `image.normals` and `image.albedo` (Marigold v2) |
| Video | `video.i2v` (Wan 2.2 image-to-video and first-last-frame loops), `video.animate` and `video.motion` (motion transfer; Wan Animate 2), `video.talk` (InfiniteTalk: a character speaks or sings a voice track), `video.t2v` (Wan 2.2 text-to-video), `video.control` (repaint a control video, depth, pose or edges, in any look, with sound; LTX-2.3 IC-LoRA) and `video.control-wan` (Wan 2.2 Fun Control), `video.upscale`, `video.interpolate` (FILM) |
| Blender | `blender.render` (a Blender shot on a GPU server: a .blend, or characters, animations, props, sky and a camera move built from files; returns the render plus depth, pose, edges, normal and mask videos for `video.control`) |
| 3D | `mesh.from-image` (Hunyuan3D 2.1 shape), `mesh.from-views` (Hunyuan3D multi-view: front + side), `mesh.textured` (Pixal3D / TRELLIS 2 with PBR textures), `mesh.rig` (rig and skin a GLB on the GPU fleet: Make-It-Animatable for a humanoid, Mixamo bone names; SkinTokens otherwise; a rigged FBX and GLB plus a walk preview. Its own venv, installed on first use), `blender.character` (named Blender ops on a 3D character in one job: clean and decimate, bake UVs and maps, attach a prop to a bone, retarget clips across skeletons, clip edits and key poses from JSON, FBX for Unity and GLB for the web, preview videos) |
| Audio | `audio.music` (ACE-Step 1.5 songs and loops), `audio.voice` and `audio.sfx` (ElevenLabs), `audio.voice-design` + `audio.voice-save` (ElevenLabs Voice Design: candidates, then save one to the voice library) |
| Language | `llm.text` and `llm.json` (Claude, with images for vision) |
| On this PC | `video.compose` (shots into a finished cut: order, trims, cuts and crossfades, each shot's sound, music and voice ducked under dialogue, captions; a web mp4, a .vtt and a poster; ffmpeg, free), `image.cutout`, `image.frame`, `image.tile`, `texture.maps`, `video.fit`, `media.probe`, `file.import` (a file into the library as it is) |
| Builds | `unity.build` (Unity WebGL on the AWS build server, incremental: keeps each project's Library) |
| Playtests | `playtest.run` (play a game in Chromium through its playtest contract, or smoke-test or crawl a site; video, screenshots, console, fps), `playtest.review` (Claude watches it and files a few new findings: capped, told the known ones, a mode per run kind, judged against the product's quality bar) |
| Pipelines | `asset.make` (a chain of tools as one recipe; best-of-N images or videos, at any step, picked by Claude against the art direction, canon and on-model references; takes the library already has are reused) |
| Library | Entities (a fighter, a stage, a shot) with slots (concept, side, pose/air, clip/jab) and every version of each (takes, current, old): make, revise with feedback, pick, live events, and `slot:` references in any job. One API for every product's tools, Studio, Unity and Claude: `docs/library.md` |
| Anything else | `comfy.graph` (run a raw graph), or import a workflow (dashboard → Workflows) |

## Use it

**From an agent** (Claude Code, Cursor): every project folder's `.mcp.json` has the `hawkesgen` server.
- Ask for "a seamless lab-tile texture for PH Origins". The agent reads the project's presets and runs the tool.
- MCP tools: `hawkesgen_tools`, `hawkesgen_run`, `hawkesgen_presets`, `hawkesgen_library`, `hawkesgen_jobs`,
  `hawkesgen_job`, `hawkesgen_cancel`, `hawkesgen_fleet`, `hawkesgen_estimate` (what a batch costs, before starting servers), `hawkesgen_templates`, `hawkesgen_import_workflow`.

**From the command line:**

```bash
hawkesgen.cmd tools
hawkesgen.cmd run - --project phorigins --preset sky --param prompt="night city from the 58th floor, rain" --out out/
hawkesgen.cmd run image.generate --project sandbox --param prompt="cracked hospital tiles" --param seamless=true --out out/
hawkesgen.cmd fleet status
hawkesgen.cmd fleet image status          # the machine image new servers launch from (build | prune | cancel)
```

**From code** (copy `clients/js/hawkesgen.mjs` or `clients/python/hawkesgen.py` into the project):

```js
import { HawkesGen } from './hawkesgen.mjs';
const gen = new HawkesGen({ project: 'sickofit' });
const job = await gen.run(null, { preset: 'enemy-concept', params: { prompt: 'a hell imp with an ember' } });
await gen.download(job.outputs[0].asset, 'imp.png');
```

**From Unity:** add `"com.hawkes.gen": "file:C:/Projects/hawkesgen/clients/unity/com.hawkes.gen"` to
`Packages/manifest.json`, then open Window > Hawkes Gen. Results import into `Assets/HawkesGen/`.

**Player analytics on a page** (`clients/js/hawkes-analytics.js`; the quick start is in `docs/analytics.md`):

```html
<script src="https://gen.hawkesgen.com/sdk/analytics@1.js" data-product="sickofit" data-build="1.4.2" defer></script>
<script>hawkesAnalytics.levelStart(1); /* … */ hawkesAnalytics.levelEnd(1, 'complete');</script>
```

**Player analytics in a Unity WebGL game:** add `"com.hawkes.analytics": "file:C:/Projects/hawkesgen/clients/unity/com.hawkes.analytics"`,
create `Assets/Resources/HawkesAnalyticsSettings.asset` (Assets > Create > Hawkes > Analytics Settings, set the
product), and call `Hawkes.HawkesAnalytics.LevelStart("1")` and friends. The website needs no change: the bridge
loads the SDK into the page.

## Docs

| File | What |
|---|---|
| `AGENTS.md` | How it's built, the rules, adding tools |
| `docs/workflows.md` | Turning ComfyUI workflows into tools, and the manifest format |
| `docs/api.md` | Every API route |
| `docs/comfyui.md` | What works on the GPU servers (and what hangs them) |
| `docs/library.md` | The library: entities, slots, versions, and how a product's tools use it |
| `docs/analytics.md` | Player analytics: the event contract every product follows, the collect door, the query API |
| `docs/blender.md` | Blender shots to video: `blender.render`, the shot format, `video.control`, and the cut (`video.compose`); rigging a generated character (`mesh.rig`) |
| `docs/3d-characters.md` | `blender.character`: every op (clean, bake, attach, retarget and its bone-name schemes, clip edits, key poses, FBX/GLB exports, previews) and the library kind `character3d` |
| `DESIGN.md` | J's decisions and the roadmap |
