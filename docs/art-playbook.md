# Art playbook: which tool, which recipe, which budget

For agents making game art with Hawkes Gen. Read this before picking tools. Tool details: `hawkesgen_tools { tool }`.
GPU rules and server notes: `comfyui.md`. Blender ops: `3d-characters.md`. Workflow tools: `workflows.md`.

## Rules

1. **Price first.** `hawkesgen_estimate` before any batch. Heavy 3D chains run on the GPU server; no server up means the job waits.
2. **Report before you fix.** Run `blender.character` with `report` (and `budget`) on a mesh before repairing it, and again after. Keep the better one.
3. **Pick best-of-N, not first.** `asset.make` with `candidates`, `pick` and `pickAt`. A judged pick is cheaper than a bad asset in the game.
4. **Characters from several views, never one.** A single front picture makes the model guess the back and sides: that is where messy meshes come from.
5. **Every mesh gets a budget.** Run `budget` for the game's target. Over budget means retopo, LODs, or a smaller texture, not shipping it.
6. **Nothing here is measured on the GPU yet** unless a doc says so. Say so in your report when you ran an untested chain.

## Pick a tool

| You need | Use | Notes |
|---|---|---|
| Concept art, props, UI, textures | `image.generate`, `image.control` | Z-Image-Turbo. Control: depth, pose, canny. |
| Change an image keeping the design | `image.edit` | Use for A-pose, other angles, recolors. |
| Fill or extend part of an image | `image.paint` | Inpaint and outpaint. |
| Same character from another angle | `image.angles` | Qwen multi-angle (ComfyUI template `template_qwen_multiangle.app`). |
| Transparent cutout | `image.remove-background` | Always before 3D. |
| Four views into one sheet | `image.sheet` | Free, local. front, back, left, right. |
| 3D from one image, quick | `mesh.from-image` (HY 3D 2.1), `mesh.textured` (TRELLIS.2, PBR) | Back is guessed. |
| 3D from several views | `mesh.views3d` (Pixal3D multi-view + TRELLIS.2), `mesh.from-views` (HY 3D 2.0 MV) | Best shape and texture. Needs the 4-view sheet. |
| Fix, retopo, bake, LOD, budget | `blender.character` | Ops table in `3d-characters.md`. |
| Rig a humanoid | `mesh.rig` | Then `blender.character` for clips, `motion:` library for CC0 clips. |
| Clips from text | `motion.from-text` | Kimodo SOMA / HY-Motion. |
| Depth, normals, albedo from an image | `image.depth`, `image.normals`, `image.albedo` | For material maps. Seamless: `image.tile`. |
| Upscale or restore | `image.upscale`, `image.restore` (SeedVR2), `video.upscale` | |
| Video, cutscenes | `video.t2v`, `video.i2v`, `video.control`, `video.motion` | Wan 2.2, LTX 2.3. Cut with `video.compose`. |
| Music, voice, sfx | `audio.music`, `voice`, `sfx` | |

Not installed yet, available as ComfyUI templates (import with `hawkesgen_import_workflow`): Qwen Image 2.1 Edit, Flux.2 Klein edit,
Flux Kontext, SAM3 segmentation, SDPose pose estimation, SeedVR2 7B, LTX 2.5, Wan Dancer, Hunyuan Video 1.5, Stable Audio 3, MoGe
geometry. Browse with `hawkesgen_templates { search }` (search by category word: "3d", "upscale", "audio").

## Recipes

- **Game character (clean):** preset `shared/character3d-4v`. Concept → A-pose → cutout → back, left, right views → sheet →
  `mesh.views3d` → Blender report, fix, symmetrize, retopo (~8k), bake, report, LODs → `mesh.rig`. Models are heavy (about 9 GB).
- **Game character (lighter):** preset `shared/character3d-mv` (front + back, `mesh.textured`, front/back projection).
- **Animations:** `shared/motions` and the CC0 `motion:` library first; `motion.from-text` for what the library lacks. Retarget, trim, loop
  and in-place with `blender.character` clip ops.
- **Props and environments:** `image.generate` → `image.remove-background` → `mesh.textured` → Blender `fix`, `retopo`, `lod`, `budget`.
- **Tiling materials:** `image.generate` → `image.tile`, then `image.normals` / `image.albedo` for the maps.

## Performance budgets (starting points, per object)

`blender.character { op: "budget", target }` checks these. Override any limit in the op. Add `strict: true` to fail the run.

| Target | Triangles | Materials | Bones | Texture |
|---|---|---|---|---|
| web | 15,000 | 2 | 60 | 1024 |
| mobile | 10,000 | 2 | 50 | 1024 |
| desktop | 60,000 | 4 | 150 | 2048 |
| hero | 120,000 | 6 | 200 | 4096 |

Rules of thumb: one material and one texture set per character; LOD1 at 50%, LOD2 at 25%, LOD3 at 10%; bake detail into the normal
map, not the mesh; share atlases across props; keep textures a power of two.

## Failure modes seen

- Floating shards, holes, doubled vertices, flipped normals: `fix`. Uneven sides: `symmetrize`.
- Dense triangle soup from the generator (100k+): `retopo`, with the raw mesh as the bake source.
- Back of the character smeared: you used one view. Use four.
- `bmesh.ops.holes_fill` does nothing in Blender 5.0; the ops use `edgeloop_fill`.
- Blender tests skip in CI (no Blender); they run on a developer machine.
