# Hawkes Gen — design

*2026-10-15. J's decisions are recorded below; this file is the plan, `AGENTS.md` is how it works today.*

One local service that every game and website uses for custom generative AI, so projects never deal with the
AWS fleet, ComfyUI, models or API keys. Built to grow into a service other people could pay for.

## Decisions (J, 2026-10-15)

1. **Name:** Hawkes Gen (`C:\Projects\hawkesgen`). "Hawkes Lab" was taken.
2. **Shape:** a local service (HTTP API + dashboard) that current and future games and sites call. Projects
   don't know about AWS, ComfyUI or keys.
3. **Scope:** ComfyUI, ElevenLabs and Claude, plus local tools (rembg and whatever the projects need), and
   room for more providers.
4. **Language:** TypeScript service (Node 24, no build step), Python only for image/video post-processing.
5. **First integration:** Dose Of Destruction, because it uses the most and proves what an integration looks like.
6. **Servers:** take over DoD's existing GPU servers (their disks hold ~90 GB of models).
7. **Outputs:** keep projects' files where they are now, and also keep a browsable **library** of everything
   generated, so work can be reused across projects.
8. **PH Origins next:** painted materials (tileable albedo + normal/roughness), signs/screens/posters, skies,
   short screen loops, maybe image-to-3D props; Claude for dressing plans and art review.
9. **Later:** possibly a paid service. Build the seams now (API keys, per-client usage), not the billing.

## Why

Before Hawkes Gen, DoD owned the whole GPU stack (`tools/gpu/`, ~2,400 lines) and Sick Of It's `art.mjs`
imported DoD's files by path, so two queues shared one fleet and swapped models on each other. ElevenLabs had
three separate clients with four "out of date" formats. PH Origins was about to need a third copy.

## How it works

```
 DoD devtools ─┐                                         ┌─▶ AWS EC2 GPU fleet (ComfyUI behind nginx,
 Sick Of It ───┤   Hawkes Gen  127.0.0.1:8790            │     token auth, your IP only, idle power-off)
 PH Origins ───┼─▶  one queue (lanes per provider,       ├─▶ ElevenLabs
 agents / CLI ─┤     GPU jobs grouped by model family)   ├─▶ Claude
 dashboard ────┘    tools · library · recipes · usage    └─▶ this PC: rembg, ffmpeg, Pillow/numpy
```

- **Tools** are generic capabilities (`image.edit`, `video.i2v`, `audio.voice`, `llm.json`, `image.cutout`…).
  Projects keep their own meaning (fighters, levels, enemies) and pass it as labels.
- **Jobs** run tools. The GPU lane gives a free server the oldest job of the model family it already has loaded,
  so models swap as little as possible. Jobs survive restarts; a job `key` makes retries free.
- **Library + recipes:** every output is stored with the tool version, params, input hashes and models that made
  it. `recipes/check` answers "is this current?" for any project, replacing per-project metadata formats.
- **Usage:** GPU seconds × server price, ElevenLabs characters, Claude tokens, per project and API key.
- **Workflows:** any ComfyUI workflow becomes a tool (manifest + graph), see `docs/workflows.md`.
- **Presets:** each project's art direction, applied on submit and kept in the recipe.
- **Clients:** JS, Python, Unity, CLI and MCP.

## Status

Built and tested (2026-10-15):

- **Service:** queue, library, recipes, usage, API keys and roles, dashboard (9 tabs), CLI, MCP server.
- **Clients:** JS (v2), Python, and a Unity editor package (`com.hawkes.gen`, Window > Hawkes Gen).
- **Fleet:** DoD's code ported and its 8 servers adopted. Workflow models install on demand per server, with a
  disk check, and least-recently-used non-core models are pruned when space runs short.
- **Workflows as data:** ComfyUI's template library (237 of 245 convert cleanly) and J's own exports become
  tools with no code. There are 15 curated workflow tools, plus 15 tools written in code; see the README.
- **Presets:** an art-direction file for each of the 8 projects.
- **Verified on a live L40S:**
  - image.edit, image.generate (with seamless tiling), image.upscale, image.depth
  - image.remove-background, image.segment, image.angles
  - video.upscale, video.interpolate
  - mesh.from-image, mesh.textured (PBR GLB); since 2026-10-21 deprecated for characters: mesh.views3d from a 4-view sheet is the only way (J: one image never made a usable mesh)
  - audio.music, llm.json
  - DoD's real side-view job, DoD's GPU tab, and its sound, voice and Claude calls
- **Projects:**
  - **DoD** is fully on Hawkes Gen (GPU, audio, Claude). Its old `tools/gpu` AWS/ComfyUI code and SDK packages
    are gone.
  - **PH Origins:** voice lines, sound effects and `tools/genMaterial.mjs`.
  - **Sick Of It:** `art.mjs`.
  - **Every project folder** has the MCP server.
  - **Unity projects:** Sick Of It, Yooba Land and Breaking Through reference the package.

### Added on 2026-10-15 (evening): building and testing, not just generating

J asked to playtest every product every day and talk through the results in chat. Hawkes Gen became the engine for
**Hawkes Studio** (`C:\Projects\hawkesstudio`), which runs the daily loop:

- **The Unity build server** (`unity.build`, `unity.test`): one Windows EC2 machine, kept between builds so each
  project's Library survives. Builds are incremental: only changed files are sent, and the project's own batch deploy
  runs. It's Windows because Unity Personal is activated by signing in to Unity Hub, which J does once.
- **Playtests** (`playtest.run`, `playtest.review`): Playwright plays each game through its playtest contract, and
  Claude reviews the frames.
- **Pipelines** (`asset.make`): tool chains with best-of-N picking by Claude, which drive the `hawkes.assets.json`
  asset manifests.
- **More ComfyUI workflows:** layers, relight, pose (image and video), ControlNet render-to-art, multi-view to 3D,
  SeedVR2 restore, Wan Animate 2, and InfiniteTalk lip-sync.

### Added on 2026-10-17: Blender to video

J wants projects to make video from Blender scenes through the API and MCP. `blender.render` renders a shot on a GPU
server (Blender 5.0.1, Cycles on the GPU, installed on first use) from a .blend or from a shot built out of the
projects' own characters (GLB/FBX with their animations, Mixamo clips retargeted by bone name), props, a sky and a
camera move. It returns the render plus control videos: depth, OpenPose skeletons from the rigs, edges, normals and a
character mask. `video.control` (LTX-2.3 IC-LoRA Union, with sound) and `video.control-wan` (Wan 2.2 Fun Control)
repaint the shot in any look from a styled first frame. `asset.make` can pick candidates at any step (`pickAt`) and
pass on outputs by title (`$step1:depth`), so the chain is one recipe. `docs/blender.md`. Verified on this PC
(the Blender script and every pass); the GPU servers and the two video models still need a live run.

### Added on 2026-10-21: the film pipeline

J: "Yeah try it out. Make our content creation machine amazing." Blender is the motion-control rig, ComfyUI the cinematographer,
Claude Vision the gate. `blender.render` v2: beats (a timeline of actions with stride-matched walks, characters kept apart),
props attached to hand bones, PBR floors and walls, muzzle flashes and flashlights, depth of field, per-character mattes and
stills. `film.gate`: four eevee frames judged against a strict rubric before any ComfyUI or Cycles spend, adjusted and
re-checked twice at most. `film.plan`: the cinema pass, dialogue close-up (InfiniteTalk), layered VFX, character LoRA and
trailer-cut recipes for `asset.make`, priced from the plan. `docs/film-pipeline.md`. Verified offline and in Blender; the GPU
steps (eevee on a server, relight, restore, the mixed control, InfiniteTalk) need a live run, which needs J's budget.

### Added on 2026-10-18: player analytics (decision m_e4959acc8abd)

J: "Let's use our own home grown solution that posts to our hawkesgen.com studio ... make sure to capture the build
they are on, date etc ... make a new one for our hawkes gen so we can even add it to our product page for hawkes gen
as part of the sdk/api ... implement analytics fully so I know where players are dropping off, why, what they like,
what they don't like, browsers, location etc."

Analytics is part of Gen's SDK and API, not a third-party script: `POST /v1/analytics/collect` (public, per-product
origins, `sendBeacon`-friendly), enrichment on the server (DB-IP Lite GeoIP, user agents, bot and internal marks; the
IP is never stored), its own database (raw events 13 months, sessions and daily rollups forever) and a query API for
Studio and agents (overview, funnels, drop-off, retention, levels, errors, perf, builds side by side, insights).
`docs/analytics.md` is the contract. Order: this backend, then the JS SDK and the Unity bridge, then Studio's
dashboard, then the products. The public Caddy route waits for J's OK (the snippet is in the doc).

It is also a **paid-service candidate**: the same door and queries work for anyone's game with a product entry and
a key, the way the rest of Gen does (see Roadmap 5).

## Roadmap

1. ~~**Sick Of It audio:** move the C# ElevenLabs sound generator to `audio.sfx` through `com.hawkes.gen`.~~ Done
   (Oct 2026): `audio.sfx`, `audio.voice`, plus the new `audio.voice-design` / `audio.voice-save`.
2. **PH Origins:**
   - signs, posters and screen loops (`image.generate` + `video.i2v`)
   - skies from `image.panorama` in the level editor
   - Claude dressing plans and room reviews (`llm.json` with screenshots)
3. **More workflows:** LoRA training per character (keep the 33 fighters on-model), live-tested versions of the new
   imports (layers, relight, pose, control, multi-view, restore, motion, talk).
4. **Seamless textures, better:** tile in latent space (circular padding) instead of the crossfade, which
   leaves soft bands.
5. **Hosted (the paid-service path):** the API already takes blobs and keys and meters usage per client. To
   host it:
   - run the service on a small always-on instance
   - store the library in S3
   - put HTTPS and auth in front
   - add per-client limits, and invoices from `usage`
   - offer analytics (docs/analytics.md) to other studios' games: a product entry per customer, their own origins

   Do this only when it pays.
