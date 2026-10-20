# 3D characters

Gen makes a game character as kind **`character3d`** (every project has it in `presets/shared/kinds.json`). One
preset, **`shared/character3d`**, runs the whole humanoid chain as a single `asset.make`. Slot-by-slot recipes let
you remake one piece. Price a batch with `POST /v1/estimate` / `hawkesgen_estimate` before starting servers.

```
concept ─image.edit─> apose ─cutout─> cutout ─image.angles─> angles
                              └─────────────> mesh.textured (best-of-N @ 100k faces, judged from 4-angle stills)
                                      └─blender.character clean+bake─> mesh
                                            ├─mesh.rig─> rig (humanoid)
                                            └─split+template+clips─> rig (robot: data.form=robot)
                                                  └─animation/* / motion/* / shared/motions─> clips
                                                        └─export/fbx, export/glb, check/humanoid
```

## Making a character

1. **Create the entity** with kind `character3d`, a `look` line, and (for Unity) `unityProject` (folder under
   `C:\Projects` that already has `com.hawkes.gen`):

   ```bash
   POST /v1/entities { "project": "phorigins", "name": "Pierce", "kind": "character3d",
                       "data": { "look": "…", "unityProject": "sickofitgame-unity" } }
   ```

2. **Put a concept in** (`slot: concept`): upload a full-body reference, or `POST …/slots/concept/make`.

3. **Either one recipe** (humanoid, from the concept image as `inputs.files[0]`):

   ```json
   { "tool": "asset.make", "preset": "shared/character3d", "project": "phorigins",
     "inputs": { "files": ["asset:<concept>"] } }
   ```

   Or **slot by slot** (each files onto the entity): `apose` → `cutout` → `angles` → `mesh` → `rig` →
   `animation/walk` (with `data.slots.animation/walk.source`) → `export/fbx` → `check/humanoid`.

4. **Robots / creatures** (Spider Bot, Yo Bot): after `mesh` is current, set `data.form` to `"robot"` and
   `data.template` to `spider` | `quadarm` | `biped` | `chain`, then remake `rig`. That runs split + template +
   procedural clips and writes a Generic FBX (not Humanoid). Skip `check/humanoid`.

5. **Clips:** prefer Quaternius (`source: "motion:ual1/Walk_Loop"` on `animation/walk`, or preset `shared/motions`).
   New moves: `motion/<name>` with `data.prompt` (`motion.from-text`). Edits: remake `animation/<name>` with
   blender.character ops (`trim`, `loop`, `inplace`, …) via an entity override `make`, or a one-off
   `blender.character` job.

6. **Unity check:** remake `check/humanoid`. Gen copies `export/fbx` into the project's
   `Assets/HawkesGenCheck/character.fbx`, runs EditMode category `HawkesGen.Humanoid`, and returns
   `result.humanoid` (`ok`, failures). Needs the build server (~$0.77/hr while up).

### Costs per step (order of magnitude on a running g6e; first use of a family downloads models)

| Step | Tool | Rough cost |
|---|---|---|
| A-pose | `image.edit` (Qwen 2511) | ~$0.05–0.15 |
| Cutout | `image.remove-background` | a few cents |
| Angles | `image.angles` | ~$0.10–0.30 |
| Mesh (×4 candidates @ 100k faces) | `mesh.textured` + 4-angle pick renders | ~$1–3 (never ask for few faces; clean after) |
| Clean + bake | `blender.character` | ~$0.05–0.20 |
| Humanoid rig | `mesh.rig` | ~$0.20–0.50 (first install on a server is more) |
| Robot rig | `blender.character` split/template/clips | ~$0.10–0.40 |
| Library clip | `blender.character` retarget | ~$0.05–0.15 |
| Text clip | `motion.from-text` | ~$0.30–1 (first install heavy) |
| Export FBX/GLB | `blender.character` | ~$0.05–0.15 |
| Humanoid check | `unity.test` | build-server minutes (~$0.02–0.10) |

A full humanoid from concept through rig is often a few dollars of GPU when mesh best-of-N runs; estimate first.

---

## blender.character

`blender.character` runs a chain of **named Blender ops** on one 3D character, in one job, on a GPU server. It is
for everything after a character has a mesh: cleaning it to a game budget, baking its textures, giving it a prop,
bringing animation clips onto it from other skeletons, editing those clips, and writing the files the games load.
There is no free-form Blender Python. Each op is a fixed function in `post/blender/hawkes_character.py`, and Gen
checks the list (`checkOps` in `src/tools/character.ts`) before it claims a server.

It runs on blender.render's machinery (`src/providers/blender/`): family `blender`, Blender 5.0.1 installed on first
use, a job folder in `/var/tmp/hawkes-blender`, and a detached run followed over SSH.

## A job

```json
{
  "tool": "blender.character",
  "project": "phorigins",
  "inputs": { "files": ["asset:<rigged hero GLB>", "asset:<Walking.fbx from Mixamo>", "asset:<bat GLB>"] },
  "params": {
    "ops": [
      { "op": "import", "file": 0 },
      { "op": "clean", "triangles": 25000 },
      { "op": "attach", "file": 2, "bone": "RightHand", "offset": [0, 0.08, 0.02], "rotation": [90, 0, 0], "size": 0.85, "origin": "bottom" },
      { "op": "retarget", "file": 1, "name": "Walk" },
      { "op": "inplace", "clip": "Walk" },
      { "op": "loop", "clip": "Walk", "blend": 6 },
      { "op": "export", "format": "fbx" },
      { "op": "export", "format": "glb" },
      { "op": "preview" }
    ]
  }
}
```

`files` is a list; ops refer to files by their index. `fps` (default 30, Mixamo's) is the rate clips are sampled and
exported at. Outputs come back titled `fbx`, `glb`, `blend`, `turntable`, `still`, and `preview/<clip>` (one video per
clip). The job's result has the height, triangle count, bone names (each bone's canonical name and its axes), the
clips with their frame counts, what each op did, and the warnings.

## The ops

### Cleaner generated characters (preset `shared/character3d-mv`)

Generated meshes are the problem: floating shards, holes, lopsided bodies, 100k noisy triangles and a texture guessed on the back. `shared/character3d-mv` runs: A-pose → cutout → a back view made from the same cutout → `mesh.textured` best-of-4 → Blender `report`, `fix`, `symmetrize`, `retopo` (about 8k quads), `bake`, `project` (front and back pictures painted onto the mesh), `report`, `lod` → `mesh.rig`. Tested: the Blender ops, locally, on a deliberately messy mesh (`test/character-art.test.ts`); the preset's references and ops are validated. Not tested end to end: the GPU steps (the generated back view may not match the front, and `mesh.textured`'s facing direction is assumed to be -Y), and nothing measures yet whether it beats `shared/character3d` on real characters. Compare the two `report` scores and the turntables first.

## The ops

The first op is always `import`. The rest run in order, and any op can come more than once.

| Op | Fields | What it does |
|---|---|---|
| `import` | `file`, `height`, `facing`, `clips` (true), `names`, `map` | The character: GLB/GLTF, FBX or OBJ, with its skeleton and the clips in the file (unless `clips: false`). The object transforms are baked in, so 1 unit = 1 m (a Mixamo FBX comes in at 0.01 scale and turned 90°). It stands on the ground, centered, facing -Y. `facing: "auto"` reads the facing from the hips and shoulders; a number gives the current facing in degrees. `height` scales to that many meters. |
| `clean` | `triangles` (25000), `merge` (0.0001 m), `normals` (true) | Merges vertices closer than `merge`, recalculates normals to face outward, and collapse-decimates to the triangle budget. Shape keys are dropped, with a warning. A copy of the uncleaned mesh is kept as the bake source. The result says how far the surface moved (`silhouette`: max and 99th percentile, in meters), and there is a warning when the 99th percentile is over 1% of the height. |
| `bake` | `size` (2048, max 2048), `maps` (`["color", "normal"]`), `high`, `samples` (8), `margin` (16), `extrusion`, `distance`, `roughness` (0.8) | Joins the meshes into one, unwraps them with a new smart-UV map, and bakes base color and a tangent-space normal map from the high-poly. The high-poly is file `high`, else the copy `clean` kept, else the mesh as it was. The meshes get one material with the maps, packed into every export. |
| `report` | none | Scores the mesh 0 to 100 (clean from 80, usable from 60, otherwise messy): triangles, loose pieces, tiny floating shards, boundary and non-manifold edges, degenerate and thin triangles, left/right asymmetry. Put one before and one after the repair ops to see what changed. |
| `fix` | `shards` (0.02), `holes` (12), `merge` (0.0001 m), `smooth` (0) | Repairs a generated mesh: merges doubles, removes degenerate faces and loose edges, deletes pieces smaller than `shards` of the biggest piece's area, fills holes up to `holes` edges, recalculates normals. Returns before and after metrics. |
| `symmetrize` | `side` (`auto`, `+X`, `-X`), `center`, `merge` | Mirrors the denser half over the other so a lopsided generated figure is left/right the same. Static meshes only (before rigging). |
| `retopo` | `faces` (8000), `mode` (`quad` or `voxel`), `symmetry`, `fix` (true), `seed` | Rebuilds the surface with clean quads (Quadriflow; voxel remesh and decimate as a fallback). The original is kept as the bake source, and the result reports the silhouette error against it. Fails on a rigged character: retopologise before `mesh.rig`. |
| `project` | `views!` (`[{ file, view: front/left/back/right or degrees, weight }]`), `size` (2048), `sharpness` (2), `margin`, `rebuild_uv` | Paints the color texture from cutout pictures (a PNG per view, background removed) projected onto the mesh. Each texel takes its color from the views that face it, weighted by angle, with occlusion; texels no view sees keep the baked color; seams are dilated. Writes `<name>_color.png` and sets the material. Azimuth: 0 front (the camera at -Y), 90 the character's left, 180 back, 270 right. Run it after `bake`. |
| `lod` | `levels` (`[0.5, 0.25, 0.1]`), `name` | Writes a lower-detail GLB per ratio (`character_LOD1.glb`…). |
| `attach` | `file`, `bone`, `offset` (m), `rotation` (degrees XYZ), `size` or `scale`, `origin` (`file`, `center`, `bottom` or `top`), `name` | A prop parented to a bone. `offset` and `rotation` are in the bone's own axes; Mixamo bones point along +Y. `origin` is the grip point: `bottom` for a bat held at the handle. `size` scales the prop's longest side to that many meters. It exports as a child of the bone. |
| `retarget` | `file` (an index, a list, or `"*"` for every file no other op uses), `name`, `action`, `from` (auto), `map`, `inPlace`, `scale` | Clips from another skeleton: FBX, GLB or BVH. Every animation in the file comes over, or only `action`; `name` renames a single clip. Details below. |
| `trim` | `clip`, `start`, `end`, `as` | Keeps frames `start` to `end` (1-based, inclusive). |
| `loop` | `clip`, `blend` (8), `as` | Makes a seamless loop. The last `blend` frames cross-fade into the first ones, and the clip then starts after them, so its last frame leads straight into its first. The clip gets `blend` frames shorter. Root travel carries over. |
| `inplace` | `clip`, `mode` (`travel` or `lock`), `as` | Removes the walk. `travel` (the default) removes the hips' straight-line travel on the ground and keeps the sway; `lock` pins the hips' ground position. The result says how many meters were removed. |
| `speed` | `clip`, `factor`, `as` | 2 is twice as fast (half the frames), 0.5 is slow motion. In-betweens are interpolated. |
| `mirror` | `clip`, `as` | Swaps left and right, as in a mirror. Twins are matched by bone name; the rest pose should be symmetric. |
| `reverse` | `clip`, `as` | Plays the clip backwards (Holster from Draw). |
| `concat` | `clips` (two or more), `name`, `blend` (0) | Plays the clips one after another. Each clip starts where the last one ended on the ground. With `blend`, the clips cross-fade over that many frames. |
| `pose` | `clip`, `bones`, `frame` (1) or `frames`, `mode` (`set` or `add`), `ease` (0), `length`, `as` | Sets key poses from JSON. Details below. |
| `copy`, `rename`, `remove` | `clip`, `name` / `clips` | Copies, renames or removes clips. |
| `split` | `by` (`connected`, `centers` or `both`), `kind`, `parts`, `label`, `angles`, `segments`, `size` | Hard-surface robots: cut the mesh into named parts. `connected` splits loose pieces; `centers` (or a `kind` guess / Claude labels) assigns vertices to the nearest part centre. `label: true` renders four angles and asks Claude for centres that match the template roles, then continues. |
| `template` | `kind!` (`spider`, `quadarm`, `biped`, `chain`), `parts`, `segments`, `smooth` (0.02 m) | Builds a robot skeleton fitted to the parts and binds each part rigidly to one bone (a short blend only where parts meet). Replaces any previous armature. Spider = 6 legs; quadarm = 4 legs + 2 arms (Yo Bot); biped = simple humanoid; chain = `segments` bones along the long axis. |
| `clips` | `list` / `clips` (default set), `kind`, `segments` | Procedural takes for the current template: walk / run (gait `tripod` or `wave`), idle sway, attack (`stab` / `swipe` / `slam`), hit, death, jump. Omit `list` for the full starter set. |
| `angles` | `size` (512) | Four orthographic stills (front / right / back / left) without changing the mesh. Titles `angle/front`… Used when `asset.make` picks among mesh candidates. |
| `export` | `format` (`fbx`, `glb` or `blend`), `name` (`character`), `clips` (all), `bones` (FBX: `mixamo`, or `generic` / `keep` for robots), `title` (the format, unless set) | Writes the file. `title` is the name the library files it under when one job writes several GLBs. Details below. |
| `preview` | `turntable` (true), `clips` (all), `size` (512), `seconds` (6), `engine` (cycles), `samples` (16), `maxFrames` (300) | Makes a turntable of the rest pose (the camera goes once around) and a still, plus a video of each clip from a three-quarter view. The camera follows a clip that travels. All of these are rendered by `hawkes_blender.py` (blender.render's shot) from a GLB of the character. |

### Hard-surface robots

For creatures that are not humanoid (Spider Bot, Yo Bot, a chained tentacle), skip `mesh.rig` and do this after `mesh.textured`:

```json
{
  "ops": [
    { "op": "import", "file": 0 },
    { "op": "split", "kind": "quadarm", "label": true },
    { "op": "template", "kind": "quadarm" },
    { "op": "clips" },
    { "op": "export", "format": "fbx", "bones": "generic" },
    { "op": "export", "format": "glb" },
    { "op": "preview" }
  ]
}
```

- **`split` + `label: true`:** Blender renders front / right / back / left stills; Claude returns a centre per template role (`body`, `leg_fl`, …); the mesh is cut by nearest centre. Without `label`, pass `parts: [{ "name": "body", "center": [0,0,0.4] }, …]` yourself, or let `kind` guess centres from the vertex cloud.
- **`template`:** one bone per part (upper + tip for limbs). Export FBX with `bones: "generic"` so Unity uses a Generic avatar (not Humanoid / Mixamo).
- **`clips`:** parameters on each entry: `type`, `gait` (`tripod` for spiders, `wave` otherwise), `attack`, `seconds`, `name`.

The edit ops (`trim`, `loop`, `inplace`, `speed`, `mirror` and `reverse`) change the clip in place. With `as`, they
write a new clip and leave the original alone. With `clip: "*"`, they apply to every clip.

### Retargeting

Retargeting matches **bone directions in the world**, not bone names alone. It works like this:

1. For each bone, it compares the direction from its joint to the next joint (upper arm to elbow) on both skeletons at
   rest.
2. It turns the character's rest pose so that each bone points where the source's does.
3. It applies the source's motion from its own rest pose on top.

A T-pose Mixamo clip therefore plays right on an A-pose rig (mesh.rig's), and an A-pose mocap clip plays right on a
T-pose character. Renaming tracks alone would put the arms 45° off. Both skeletons are turned to face the same way.
Root motion (the hips' travel) is scaled by the ratio of hip heights, so a short character takes shorter steps.
`scale` overrides that ratio, and `inPlace: true` drops the ground travel. Bones the source doesn't have keep their rest
pose relative to their parent, and the result lists them as `missing`.

Bones are matched by **canonical names** (Mixamo's, without a prefix: `Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`,
`Head`, `LeftShoulder`, `LeftArm`, `LeftForeArm`, `LeftHand`, `LeftUpLeg`, `LeftLeg`, `LeftFoot`, `LeftToeBase`, and the
fingers as `LeftHandIndex1`...). Each skeleton's names are read through the scheme that matches most of its bones
(`from` or `names` picks one):

| Scheme | Hips / spine | Arm | Leg |
|---|---|---|---|
| `mixamo` | `mixamorig:Hips`, `Spine`, `Spine1`, `Spine2` (any `mixamorigN:` prefix, or none) | `LeftShoulder`, `LeftArm`, `LeftForeArm`, `LeftHand` | `LeftUpLeg`, `LeftLeg`, `LeftFoot`, `LeftToeBase` |
| `unity` | `Hips`, `Spine`, `Chest`, `UpperChest` | `LeftShoulder`, `LeftUpperArm`, `LeftLowerArm`, `LeftHand` | `LeftUpperLeg`, `LeftLowerLeg`, `LeftFoot`, `LeftToes` |
| `unreal` | `pelvis`, `spine_01`..`spine_03` | `clavicle_l`, `upperarm_l`, `lowerarm_l`, `hand_l` | `thigh_l`, `calf_l`, `foot_l`, `ball_l` |
| `rigify` | `DEF-spine` (or `DEF-hips`), `DEF-spine.001`..`.003`, `DEF-spine.004` or `DEF-neck`, `DEF-spine.006` or `DEF-head` | `DEF-shoulder.L`, `DEF-upper_arm.L`, `DEF-forearm.L`, `DEF-hand.L` | `DEF-thigh.L`, `DEF-shin.L`, `DEF-foot.L`, `DEF-toe.L` |
| `smpl` (SMPL, SMPL-H, AMASS BVH) | `pelvis`, `spine1`..`spine3` | `left_collar`, `left_shoulder` (upper arm), `left_elbow`, `left_wrist` | `left_hip`, `left_knee`, `left_ankle`, `left_foot` |
| `soma` (Kimodo somaskel77, the BVH from `motion.from-text`) | `Hips`, `Spine1`, `Spine2`, `Chest`, `Neck1` | `LeftShoulder`, `LeftArm`, `LeftForeArm`, `LeftHand` | `LeftLeg` (thigh), `LeftShin`, `LeftFoot`, `LeftToeBase` |
| `bvh` (classic BVH) | `Hips`, `Abdomen`, `Chest`, `Chest2` | `LeftCollar`, `LeftShoulder` (upper arm), `LeftElbow`, `LeftWrist` | `LeftHip`, `LeftKnee`, `LeftAnkle`, `LeftToe` |

Left/right can also be spelled `L_`, `l_`, `.L`, `_l` and so on. CMU-style BVH uses Mixamo-like names and reads as
`mixamo`. For anything else, `map` names the bones yourself: `{ "Bip01 L UpperArm": "LeftArm", ... }`. It works on
`import` (the character) and on `retarget` (the source). BVH files are Y-up, as mocap exports are.

### Key poses from JSON

An agent can author or fix a pose without Blender:

```json
{ "op": "pose", "clip": "Wave", "frame": 12, "ease": 6, "bones": { "RightArm": [0, 0, -70], "RightForeArm": [0, 0, -40] } }
{ "op": "pose", "clip": "Point", "length": 30, "frames": [10, 30], "bones": { "RightArm": [0, 0, -80], "Head": { "quat": [0.98, 0, 0.2, 0] } } }
```

- **Values:** each bone's rotation relative to its rest pose, as Euler XYZ degrees in the bone's own axes. These are
  the numbers Blender shows in pose mode. `{ "quat": [w, x, y, z] }` also works.
- **The bone's axes:** the result lists each bone's `axes`, its X, Y and Z directions in the world (+Z up, character
  facing -Y). Mixamo bones point along +Y, so a rotation about the bone's Z axis swings it.
- **`mode`:** `set` replaces the rotation; `add` turns from the current one.
- **`ease`:** blends that many frames on each side into the new pose.
- **A new clip:** with `length`, a clip that doesn't exist yet starts from the rest pose.
- **Bone names:** canonical (`RightArm`) or the rig's own (`mixamorig7:RightArm`).

### Exports

- **FBX for Unity:**
  - Bones are renamed to Mixamo names (`mixamorig:Hips`...), so Unity's **Humanoid** avatar maps them on its own.
    `bones: "keep"` or `bones: "generic"` keeps the rig's own names (use this for robot templates). A warning lists the
    Humanoid bones the Mixamo path doesn't have.
  - Each clip is a named take (an NLA strip). In Unity they show as `Walk`, `Idle`... on the model's Animation tab.
  - Scale: 1 unit = 1 m (*FBX All* scaling, -Z forward, Y up, no leaf bones). Textures are embedded.
  - Unity's Humanoid works best from a T-pose rest. A mesh.rig character rests in its A-pose; use *Enforce T-Pose* in
    the avatar's Configure screen if Unity complains.
- **GLB for the web:** one animation per clip, by name, with skins, the prop and the baked maps. Babylon.js and
  three.js play them by name.
- **`.blend`:** the scene with every clip as an action, to open and finish by hand.

## The library: kind `character3d`

`presets/shared/kinds.json` holds kinds every project has. A project's own kinds in `presets/<project>.json` add to
them, and replace one of the same name. Reads of a project's presets (`GET /v1/presets/<project>`, the UI, slot recipes)
include the shared kinds. A save drops any shared kind it didn't change.

`character3d` has these slots:

| Slot | Made by | From |
|---|---|---|
| `concept` | `image.generate` (or upload) | name and look: a turnaround / reference |
| `apose` | `image.edit` (Qwen 2511) | `concept`: "same character, A-pose, arms 45 degrees down, legs apart, front view, plain background" |
| `cutout` | `image.remove-background` | `apose` |
| `angles` | `image.angles` | `cutout`: side/back and other views |
| `mesh` | `asset.make`: `mesh.textured` @ **100k faces**, 4 candidates, Claude picks from **4-angle Blender stills** against the concept (`refs`), then `blender.character` clean (25k tris) + bake | `cutout` (+ concept as ref) |
| `rig` | humanoid: `mesh.rig`; robot (`data.form=robot`): `blender.character` split/template/clips (`data.template`) | `mesh`; walk/turntable → `preview/turntable` |
| `motion/<clip>` | `motion.from-text` | `rig` + slot `data.prompt`. Prefer Quaternius on `animation/<clip>` when a library move fits. |
| `animation/<clip>` | `blender.character` (retarget, export, preview) | `rig` + `data.source` (`asset:`, `slot:`, or `motion:ual1/Walk_Loop`) |
| `preview/turntable`, `preview/<clip>` | `blender.character` (preview) | `rig`, or `animation/<clip>` / `motion/<clip>` |
| `export/fbx`, `export/glb` | `blender.character` (import, retarget `*`, export) | `rig` (+ optional clip files) |
| `check/humanoid` | `unity.test` EditMode `HawkesGen.Humanoid` | `export/fbx`; needs `data.unityProject` |

Entity data fields used by recipes: `look`, `canon`, `form` (`humanoid` \| `robot`), `template` (robot kind),
`unityProject`, `triangles` (documented; clean default is 25k in the shared recipes).

A recipe's `saves` map files a single tool's outputs by title, as in a chain. For example, `{ "glb": "animation/{part}",
"preview/{part}": "preview/{part}" }`; template fields work in the keys too. Outputs the map leaves out (the still) are
not filed.

```bash
# a new character with a walk from Mixamo
POST /v1/entities { "project": "phorigins", "name": "Pierce", "kind": "character3d",
                    "data": { "look": "…", "unityProject": "sickofitgame-unity",
                              "slots": { "animation/walk": { "source": "asset:<Walking.fbx>" } } } }
POST /v1/entities/phorigins/pierce/slots/concept/make
# then apose, cutout, angles, mesh, rig, animation/walk, export/fbx, check/humanoid
# or: preset shared/character3d with the concept as inputs.files[0]
```

## mesh.rig

`mesh.rig` (version 2, family `rig`) rigs the mesh before `blender.character` sees it. It is not a ComfyUI node and
it is not on the fleet image. The first job on a server installs two venvs under `/opt/hawkes-rig` (the Blender
install pattern in `src/providers/rig/install.ts`) and refuses to start unless the disk has 30 GB free.

| | Humanoid | Anything else |
|---|---|---|
| Param | `kind: humanoid`, or `kind: auto` when the mesh is an upright biped with its arms out | `kind: auto` when it is not, and when Make-It-Animatable fails |
| Model | Make-It-Animatable v2, commit `bbd8b158d888` | SkinTokens (TokenRig), commit `273b691d3598` |
| Skeleton | Mixamo names (`mixamorig:Hips`, fingers included) | Whatever SkinTokens predicts for that body. Not Mixamo. Retarget a Mixamo clip onto it only after `blender.character` can name the bones. |
| License | Code MIT. Weights Apache-2.0 (`jasongzy/Make-It-Animatable`, `output/best/v2`, about 3.05 GB). The shape encoder is Hunyuan3D 2.1's VAE (`hunyuan3d-vae-v2-1`, about 625 MB) under Tencent's community license: commercial use is allowed under 1 million monthly users, outside the EU, UK and South Korea. `mesh.from-image` already runs that model. | Code MIT. Weights MIT (`VAST-AI/SkinTokens`, about 1.6 GB). It reads the Qwen3-0.6B config (Apache-2.0) and not Qwen's own weights. |

UniRig (MIT code, MIT weights) is the predecessor. It is not installed: SkinTokens replaces it, and a second venv
would spend the disk for a worse skin. The paid Auto-Rig Pro addon is not cloned. The Mixamo dataset on Hugging
Face is gated, so the 52-bone template Make-It-Animatable reads (`data/Mixamo/bones.fbx`) is generated on the
server from the bone names and parents (`post/rig/make_template.py`). The attention mask only uses those parents.

**Params:** `kind` (`humanoid` or `auto`), `keepTextures` (default true: copy the source materials back when the
model dropped them and the vertex count still matches). `height` and `facing` are applied before the model runs.

**Outputs:** `rigged` (GLB, with a clip named Walk), `fbx`, `walk` (the preview), `preview` (its first frame). The
walk is a one-second cycle repeated for `seconds` (default 4), played in place. A `character3d` rig files the GLB
on `rig` and the video on `preview/turntable`.

**Memory, as published, before a server has measured a run.** The job result's `resources` is the measurement
(VRAM used and total, RAM available and total, disk used and free, sampled around each model, plus the install's
`du` of `/opt/hawkes-rig`).

- **VRAM:** SkinTokens asks for 14 GB. Make-It-Animatable v2 is a feed-forward net on the Hunyuan shape VAE; the
  fleet's L40S has 48 GB. SkinTokens uses 10 beams at 32 GB and up, 4 beams from 20 GB, 2 beams below that.
- **RAM:** a g6e.xlarge has 32 GB. The two models are never loaded together. One at a time fits; the sample line
  `memAvailableBytes` says what was free.
- **Disk:** the pinned weight files are about 3.05 GB (Make-It-Animatable) + 0.6 GB (Hunyuan VAE) + 1.6 GB
  (SkinTokens), and then two PyTorch venvs. The install records the real `diskBytes`.

The first run on a server is the download (several minutes, on the order of a dollar of GPU time while it waits).
Later runs are the inference plus a short Blender preview.

## The motion library

Quaternius's **Universal Animation Library** and **Universal Animation Library 2** are in the library as CC0 clips
(locomotion, melee, hits, deaths, idles, and the rest of each free pack). They are humanoid clips on a
Mixamo-compatible rig. Library 1's bones read as Rigify (`DEF-hips`, `DEF-upper_arm.L`, …). Library 2's read as Unreal
(`pelvis`, `upperarm_l`, …). `blender.character` retargets either onto a Mixamo rig.

What shipped is the **free Standard edition** of each pack. The license file in each zip is CC0 1.0; the text is
`motions/licenses/ual1-license.txt` and `motions/licenses/ual2-license.txt`, and the clip list is
`motions/quaternius.json` (name, tags, duration in seconds, loop). Quaternius advertises 120+ and 130+ clips. Those
counts are the paid Pro and Source zips. Those were not downloaded.

The free packs are 46 clips and 43 clips. A name ending in `_Loop` loops; the others play once.

Search them like any other library file. `hawkesgen_library` with `search: "melee"` (or `tool: "motion.library"` for
the whole list) returns each clip's name, tags, duration and whether it loops. The id is `motion:ual1/Walk_Loop` or
`motion:ual2/Melee_Hook`. The same id is a file input: the zip is downloaded the first time a job uses a clip, checked
against the sha256 in the catalog, and that one clip is split out as its own GLB.

One clip on a character the slot already knows how to make:

```json
{ "source": "motion:ual1/Walk_Loop" }
```

on `animation/walk`. Several at once is the preset `shared/motions`:

```json
{
  "tool": "blender.character",
  "preset": "shared/motions",
  "project": "phorigins",
  "params": { "clips": ["Walk_Loop", "Idle_Loop", "ual2/Melee_Hook"], "entity": "phorigins/pierce", "preview": false },
  "inputs": { "files": ["slot:phorigins/pierce/rig"] }
}
```

`clips` is up to 16 names. A name that is in both packs has to say which (`ual1/A_TPose`). `entity` is the character
the results are filed on: each clip becomes a take of `animation/<name>` (`animation/walk-loop`, …). `preview: true`
also files a video on `preview/<name>`. The character file is the rigged GLB or FBX (a `slot:` or `asset:` reference).

## motion.from-text

`motion.from-text` (version 1, family `motion`) makes a humanoid clip from a sentence. It is not a ComfyUI node and
it is not on the fleet image. The first job on a server installs two venvs under `/opt/hawkes-motion` and refuses to
start unless the disk has 60 GB free. Prefer a Quaternius clip from the motion library when one already fits; this
tool is for a new move that is not in those packs.

Kimodo writes the BVH itself, on its **SOMA** skeleton (`somaskel77`), with a standard T-pose as the rest pose.
`blender.character` retargets that BVH with bone names `soma`. The SMPL-X Kimodo checkpoint is not installed: that one
is a NVIDIA research license, and SMPL's body-model weights are non-commercial.

| | What runs |
|---|---|
| Model | Kimodo-SOMA-RP-v1.2 (`nvidia/Kimodo-SOMA-RP-v1.2`, code commit `e1c219c99b4b`) |
| Skeleton | SOMA, 77 joints. Not SMPL. |
| License | Code Apache-2.0. Weights: **NVIDIA Open Model License**. That license grants a perpetual, worldwide, no-charge right to use, sell and distribute the model. NVIDIA claims no ownership of the outputs. Use stays inside NVIDIA's Trustworthy AI terms. The model card says it is ready for commercial use, including animation for games. |
| Text encoder | Meta-Llama-3-8B-Instruct (Llama 3 Community License, commercial use under 700 million monthly users). It is gated. The server needs a Hugging Face token that has been granted that model, in `/opt/hawkes-motion/hf/token` (Gen writes one there when `HF_TOKEN` or `HUGGING_FACE_HUB_TOKEN` is set in Gen's `.env`). Without it Kimodo is skipped. |
| Fallback | HY-Motion 1.0 (commit `4e426f5a1021`), only when Kimodo writes no BVH. Tencent's community license: commercial use under 1 million monthly users, outside the EU, the UK and South Korea (the same shape of terms as Hunyuan3D). It predicts SMPL-H pose numbers. Those are written to a BVH with SMPL joint names (`from: "smpl"`). The SMPL mesh weights are not downloaded. Text encoder: CLIP (MIT) and Qwen3-8B (Apache-2.0). |

**Params:** `prompt` (a sentence), `seconds` (0.4 to 12, default 2), `loop`, `inPlace`, `poses`, `constraints`, `takes` (1 to 8).
`loop` and `inPlace` need a `character` (a rigged GLB or FBX). They are blender.character's loop and inplace ops, applied
after the retarget. `inPlace` is what you want for a punch that should not walk forward. `loop` is for an idle.

**Key poses.** `poses` is the windup, the contact and the follow-through. Each entry is `{ "text", "seconds" }` or
`{ "text", "at" }` (`at` is seconds from the start). Kimodo hears one sentence per pose, and the lengths are the
durations. A bat swing:

```json
{
  "prompt": "A person swings a baseball bat with both hands",
  "poses": [
    { "text": "windup, the bat cocked back over the right shoulder", "seconds": 0.6 },
    { "text": "contact, the bat level in front of the chest", "seconds": 0.3 },
    { "text": "follow-through, the bat finishing over the left shoulder", "seconds": 0.7 }
  ]
}
```

`constraints` is optional and advanced: a Kimodo constraints list, or root waypoints
`{ "type": "root2d", "at": [0, 1.2], "path": [[0, 0], [0, 1.2]] }` (meters, x and z on the ground).

**Outputs.** `bvh` is the generated motion. With a character: `glb` and `fbx` are that clip on the rig (Mixamo bone
names on the FBX), and `preview` is a video of it. One of each per take. A `character3d` slot `motion/<clip>` files
the GLB on itself and the video on `preview/<clip>`.

**Best of N.** `takes` (2 to 8) makes that many variations in one job. Give the slot a saves map
`{ "glb": "motion/<clip>", "preview": "preview/<clip>" }` so every preview lands in one slot and every GLB in the
other, in the same order. Then `library.judge` on the preview slot, with `criteria` set to the same prompt, picks the
video. The GLB with the same `take` (on the asset) is the clip that goes with it.

```json
{ "tool": "library.judge", "params": { "entity": "phorigins/pierce", "slot": "preview/swing", "criteria": "A person swings a baseball bat with both hands" } }
```

### Prompts that work for game moves

Kimodo was trained on motion-capture descriptions. Write a full sentence in the present tense, name the limbs, and
say how the move ends. One action. Two to three seconds is enough for an attack. The skeleton has no prop: the bat,
sword or gun is attached afterwards with blender.character (`attach` on `RightHand`).

| Move | Prompt | Notes |
|---|---|---|
| Jab | A person throws a straight right punch and returns the fist to a ready stance in front of the chest. | `inPlace: true`, about 0.8 seconds. |
| Cross | A person turns the hips and throws a right cross, then brings the hand back to guard. | `inPlace: true`, about 1 second. |
| Bat swing | A person swings a baseball bat with both hands. | Use the three poses above (windup, contact, follow-through). `inPlace: true`, about 1.6 seconds. |
| Kick | A person chamber-kicks with the right leg to the front and sets the foot back down beside the left. | `inPlace: true`, about 1.2 seconds. |
| Hit in the chest | A person is struck in the chest, the shoulders rock back, and they catch their balance without falling. | `inPlace: true`, about 1 second. Do not say "ragdoll". |
| Hit that staggers | A person takes a heavy hit on the left shoulder and stumbles two steps to the right, staying upright. | Leave `inPlace` off so the stumble travels. |
| Death, drop | A person clutches their chest, sinks to their knees, and falls onto their back, then lies still. | 3 to 4 seconds. Not a loop. |
| Death, forward | A person is hit hard in the head and falls forward onto the ground, then lies face down. | 3 seconds. |
| Idle | A person stands, shifts their weight from one foot to the other, and settles. | `loop: true`, `inPlace: true`, 2 to 4 seconds. |
| Walk | A person walks forward at a steady pace, arms swinging. | Leave `inPlace` off. `loop: true` if it will tile. |

Prompts that come back muddy: a single word ("attack"), several unrelated actions in one sentence, or a camera
direction ("side view of a punch"). Ask for the body, not the shot.

## Tested

`test/character.test.ts` runs the whole server script where Blender is installed:

- **The character:** `test/fixtures/make_character.py`, a skinned FBX with Mixamo names in a T-pose.
- **The clip:** `test/fixtures/make_mocap.py`, an SMPL-named BVH in an A-pose that walks 1 m and raises an arm.
- **Retarget:** every limb of the retargeted clip points where the mocap's does (cosine > 0.98), and the travel is
  scaled to the legs.
- **Edits:** `inplace` removes the travel, `mirror` mirrors, and every edit has the right frame count.
- **Exports:** the FBX has Mixamo names, a take per clip and the same height as the GLB.
- **Previews:** the preview videos have the right size and length.

CI has no Blender, so that test skips there.

The first live check used PH Origins' own characters: all 16 PH clips of `ch33-hero.glb` were retargeted onto
`ch44-hero.glb` (a different Mixamo character, 5% taller), and the GLB and FBX were read back. The limb directions
matched the source on every frame checked, and the height stayed 1.898 m in both files. That run took 53 s on 4 CPU
cores with no GPU (16 clips, 3,200 frames), with about 750 MB of memory at the peak.

## Cost

See **Costs per step** at the top for the full character recipe. For a lone `blender.character` job:

- **Ops alone:** seconds to a minute, CPU-bound on the GPU server.
- **A 2K bake:** about a minute on the GPU.
- **Previews:** Cycles at 16 samples, a few seconds per 100 frames on the GPU.
- **Total:** a typical job is 1 to 4 minutes of a g5/g6 server, a few cents.
- **Estimate:** `POST /v1/estimate` counts `30 s + 4 s per op`, plus 60 s for a bake and 120 s for previews, until job
  history replaces it.
