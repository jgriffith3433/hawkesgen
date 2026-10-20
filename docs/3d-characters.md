# 3D characters: blender.character

`blender.character` runs a chain of **named Blender ops** on one 3D character, in one job, on a GPU server. It is
for everything after a character has a mesh: cleaning it to a game budget, baking its textures, giving it a prop,
bringing animation clips onto it from other skeletons, editing those clips, and writing the files the games load.
There is no free-form Blender Python. Each op is a fixed function in `post/blender/hawkes_character.py`, and Gen
checks the list (`checkOps` in `src/tools/character.ts`) before it claims a server.

It runs on blender.render's machinery (`src/providers/blender/`): family `blender`, Blender 5.0.1 installed on first
use, a job folder in `/var/tmp/hawkes-blender`, and a detached run followed over SSH.

```
concept ──image.edit──> apose ──mesh.textured──> mesh ──mesh.rig──> rig ──blender.character──> animation/<clip>
                                                                      └──blender.character──> export/fbx, export/glb, preview/*
```

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

The first op is always `import`. The rest run in order, and any op can come more than once.

| Op | Fields | What it does |
|---|---|---|
| `import` | `file`, `height`, `facing`, `clips` (true), `names`, `map` | The character: GLB/GLTF, FBX or OBJ, with its skeleton and the clips in the file (unless `clips: false`). The object transforms are baked in, so 1 unit = 1 m (a Mixamo FBX comes in at 0.01 scale and turned 90°). It stands on the ground, centered, facing -Y. `facing: "auto"` reads the facing from the hips and shoulders; a number gives the current facing in degrees. `height` scales to that many meters. |
| `clean` | `triangles` (25000), `merge` (0.0001 m), `normals` (true) | Merges vertices closer than `merge`, recalculates normals to face outward, and collapse-decimates to the triangle budget. Shape keys are dropped, with a warning. A copy of the uncleaned mesh is kept as the bake source. The result says how far the surface moved (`silhouette`: max and 99th percentile, in meters), and there is a warning when the 99th percentile is over 1% of the height. |
| `bake` | `size` (2048, max 2048), `maps` (`["color", "normal"]`), `high`, `samples` (8), `margin` (16), `extrusion`, `distance`, `roughness` (0.8) | Joins the meshes into one, unwraps them with a new smart-UV map, and bakes base color and a tangent-space normal map from the high-poly. The high-poly is file `high`, else the copy `clean` kept, else the mesh as it was. The meshes get one material with the maps, packed into every export. |
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
| `smpl` (SMPL and SOMA-style mocap, AMASS BVH) | `pelvis`, `spine1`..`spine3` | `left_collar`, `left_shoulder` (upper arm), `left_elbow`, `left_wrist` | `left_hip`, `left_knee`, `left_ankle`, `left_foot` |
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
| `concept` | `image.generate` | the entity's name and look: a turnaround sheet |
| `apose` | `image.edit` | `concept`: the front view alone, in an A-pose |
| `mesh` | `mesh.textured` | `apose` |
| `rig` | `mesh.rig` (1.8 m, kind humanoid) | `mesh`; its walk video goes to `preview/turntable` |
| `animation/<clip>` | `blender.character` (import, retarget, export glb, preview) | `rig` plus the slot's `data.source` (an `asset:` or `slot:` reference, or a library clip `motion:ual1/Walk_Loop`: a Mixamo FBX, a GLB or a BVH). The GLB goes to the slot, the video to `preview/<clip>`. |
| `preview/turntable`, `preview/<clip>` | `blender.character` (preview) | `rig`, or `animation/<clip>` |
| `export/fbx`, `export/glb` | `blender.character` (import, retarget `*`, export) | `rig`. To take clips along, make it with `inputs: { files: ["slot:./rig", "slot:./animation/walk", "slot:./animation/idle"] }` |

A recipe's `saves` map files a single tool's outputs by title, as in a chain. For example, `{ "glb": "animation/{part}",
"preview/{part}": "preview/{part}" }`; template fields work in the keys too. Outputs the map leaves out (the still) are
not filed.

```bash
# a new character with a walk from Mixamo
POST /v1/entities { "project": "phorigins", "name": "Pierce", "kind": "character3d",
                    "data": { "look": "...", "slots": { "animation/walk": { "source": "asset:<Walking.fbx>" } } } }
POST /v1/entities/phorigins/pierce/slots/concept/make     # then apose, mesh, rig, animation/walk, export/fbx
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

- **Ops alone:** seconds to a minute, CPU-bound on the GPU server.
- **A 2K bake:** about a minute on the GPU.
- **Previews:** Cycles at 16 samples, a few seconds per 100 frames on the GPU.
- **Total:** a typical job is 1 to 4 minutes of a g5/g6 server, a few cents.
- **Estimate:** `POST /v1/estimate` counts `30 s + 4 s per op`, plus 60 s for a bake and 120 s for previews, until job
  history replaces it.
