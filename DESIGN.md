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
  - mesh.from-image, mesh.textured (PBR GLB)
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

   Do this only when it pays.
