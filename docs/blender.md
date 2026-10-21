# Blender to video

Hawkes Gen renders Blender shots on the GPU fleet and turns them into finished video. The camera, the action and
the timing come from Blender, exactly. The look comes from a video model that repaints the shot.

```
blender.render  ──>  depth / pose / edges videos + the first frame
                         │                     │
                         │              image.edit (the look: style, characters, light)
                         ▼                     ▼
                 video.control (LTX-2.3 IC-LoRA)  or  video.control-wan (Wan 2.2 Fun Control)
                         │
                         ▼
                  the finished shot (with sound, from LTX)
                         │
                         ▼
     video.compose (this PC or the control server, ffmpeg: order, transitions, music, voice, captions)
                         │
                         ▼
                  the finished cut: mp4 + .vtt + poster
```

Any project can do this through the API, the MCP (`hawkesgen_run`) or an asset manifest (Hawkes Studio).

## blender.render

It runs on a GPU server like any GPU job. The queue gives it a server, ComfyUI's models are unloaded first
(family `blender`), and Blender renders with Cycles on the GPU (OptiX).

Blender (5.0.1, the version on J's PC) installs itself on a server the first time it's needed: a 374 MB download,
about a minute. `server/bootstrap.sh` installs it too, so new servers and the next fleet image have it.

**Inputs:**

| Input | What |
|---|---|
| `scene` | A `.blend`, or a `.zip` of a project folder with its textures (give `blend` for the file inside it). |
| `files` | Models, animations and images the shot uses, referred to by index (`"file": 0` is the first). |

You need a `scene`, a `shot`, or both. A shot on top of a `.blend` adds characters and props to it, and only
replaces the camera when the shot names one.

**Params:**

| Param | Default | What |
|---|---|---|
| `shot` | | The scene to build (below). |
| `camera` | the scene's | The camera to render, by name, in a `.blend`. |
| `seconds` / `frames` | 5 s | Frames snap down to 8n + 1 (what LTX takes, which is also 4n + 1 for Wan); `snap: false` turns that off. |
| `fps` | 24 | LTX: 24. Wan: 16. |
| `width` / `height` | 1280 x 704 | LTX's size. Use 704 x 1280 for vertical. Keep both multiples of 32. |
| `passes` | beauty, depth, pose, edges | Also `normal` (camera-space normals) and `mask` (the characters white on black). |
| `engine` | cycles | The beauty pass. `eevee`, or `workbench` for a fast grey preview. The data passes always use Cycles. |
| `samples` | 32 | Cycles samples for the beauty pass (denoised). |
| `near` / `far` | measured | The depth range. By default it's measured over the shot, so depth doesn't flicker. |
| `save` | false | Also return the built shot as a `.blend`, to open in Blender and adjust. |

**Outputs**, titled so a chain can pick them (`$step1:depth`):

| Output | What |
|---|---|
| `beauty` | The render. |
| `depth` | Inverse depth: white near, black far, the way Depth Anything and MoGe make it. One range for the whole shot. |
| `pose` | OpenPose body skeletons (18 points, the standard colors), drawn from each rig's bones. Exact, even when limbs cross. |
| `edges` | Canny-style edges of the beauty pass. |
| `normal` | Camera-space normals. |
| `mask` | The characters, white on black. Objects in front of them hide them. |
| `first frame` | A PNG of the first beauty frame, to style with `image.edit`. |
| `shot` | The `.blend`, when `save` is on. |

The result (JSON) has the frame count, fps, size, depth range, the GPU it used, each character's animation and
height, warnings, and the seconds each pass took.

### The shot

```json
{
  "characters": [
    { "file": 0, "animation": "Walk", "height": 1.8, "position": [0, 0, 0], "facing": 90, "travel": 1.3 },
    { "file": 1, "animationFile": 2, "position": [2, 1, 0], "facing": -30 }
  ],
  "props": [{ "file": 3, "position": [1, 2, 0], "size": 1.2 }],
  "ground": { "size": 60, "color": "#2a2a2a" },
  "background": { "file": 4, "strength": 1, "rotation": 90 },
  "lights": "studio",
  "camera": { "move": "follow", "target": 0, "angle": 70, "distance": 4.5, "height": 1.5, "lens": 35, "handheld": 0.5 }
}
```

**Characters** (GLB/GLTF, FBX, OBJ, USD or `.blend`):
- `animation`: an action in the file, by name. PH Origins' `ch33-hero.glb` has Walk, Run, Idle, SitTalk, Jump and
  more. A wrong name fails and lists what the file has.
- `animationFile`: another file's animation, e.g. a Mixamo FBX. It's retargeted by bone name, so `mixamorig:` clips
  play on `mixamorig7:` rigs. Without either, the character stands in its rest pose.
- `loop` (default true): clips shorter than the shot repeat. `speed` scales the playback.
- `height`: scales the character to this many meters.
- `position`: where its feet go (meters).
- `facing`: degrees. 0 faces the default camera, which looks along +Y.
- `travel`: meters per second along its facing, for in-place walk cycles.
- Stray objects in an export that aren't on the rig (a sphere, a probe) are dropped; `keepAll: true` keeps them.

**Props:**
- `file`, `position`, `facing`
- `size`: scales the largest side to this many meters. Or `scale`.

**Ground:**
- `true`, or `{ size, color }`, or `false`.
- On by default when there's no `.blend`.

**Background:**
- `{ color }`
- `{ file, strength, rotation }`: an equirect sky, e.g. from `image.panorama`.

**Lights:** `studio` (key, fill, rim), `sun`, `night` or `none`. Without a `.blend` the default is studio.

**Camera:**

| Field | What |
|---|---|
| `move` | `static`, `push-in`, `pull-out`, `orbit`, `pan`, `truck`, `crane-up`, `crane-down` or `follow` (rides along with the character's hips). |
| `target` | A character index, or a point `[x, y, z]`. |
| `angle` | Degrees around the target. 0 is in front of the character. |
| `distance` / `height` / `lens` | Meters, meters, millimeters. |
| `amount` | How far the move goes: a share of the distance for push and pull, degrees for orbit, meters for the rest. |
| `aimHeight` | Where on the character to aim, as a share of its height (0.55). |
| `handheld` | 0 to about 2: a slow, smooth wobble. |

Moves ease in and out.

## mesh.rig: rig a generated character

`mesh.rig` takes a mesh from `mesh.views3d` (a GLB) and returns a rigged FBX, a rigged GLB, and a video of a
standard walk. Humanoids go through **Make-It-Animatable v2** (Mixamo bone names). Other organic bodies, and a
humanoid that model fails on when `kind` is `auto`, go through **SkinTokens**. Both install into their own Python
venvs the first time a server runs the tool (family `rig`, not a ComfyUI node, so the fleet image stays as it is).
Licenses, the pinned commits, and the disk and memory notes are in `docs/3d-characters.md` ("mesh.rig").

Blender still does the last step: plant the character, copy textures back when a model dropped them, bake the walk
(and any extra Mixamo clips), and render the preview. The older geometric rigger remains in `hawkes_rig.py` as
mode `rig` for its offline test; the tool does not call it.

**Inputs:** `mesh` (GLB/GLTF, FBX or OBJ) and optional `clips` (Mixamo FBX or GLB, baked on beside the walk).

**Params:** `kind` (`auto` or `humanoid`), `keepTextures` (true), `height`, `facing`, `fps` (30), `seconds` (4, the
walk preview). `names` and `actions` name the extra clips.

**Outputs:** `rigged` (GLB, clip `Walk`), `fbx`, `walk` (mp4) and `preview` (the first frame). The result includes
the bone names, the warnings, and `resources` (VRAM, RAM, disk).

Make-It-Animatable's skeleton is Mixamo's, fingers included (`mixamorig:Hips` and the finger chains). Unity's
Humanoid avatar reads those names. SkinTokens picks its own bone names for a non-humanoid.

The geometric joint finder in `hawkes_rig.py` (mode `rig`) is what `test/rig.test.ts` still runs offline: bone-heat
weights, no fingers, a turntable. The tool's classify mode uses the same shape check (two leg columns, a crotch gap,
arms out, taller than wide) to decide `auto`.

**Example** (`asset.make` from a front|back|left|right sheet of the character, `image.viewsheet` makes one, then the rig):

```json
{
  "tool": "asset.make",
  "params": {
    "steps": [
      { "tool": "mesh.views3d", "inputs": { "image": "$input:0" }, "save": "model" },
      { "tool": "mesh.rig", "inputs": { "mesh": "$prev" },
        "params": { "kind": "humanoid", "keepTextures": true, "height": 1.2 }, "save": "rigged" }
    ]
  },
  "inputs": { "files": ["character-4-view-sheet.png"] }
}
```

To try the script on this PC: `blender -b --factory-startup --python-exit-code 1 -P post/blender/hawkes_rig.py -- rig.json`,
where `rig.json` has `mesh`, `clips` (`[{ "file", "name" }]`), `out`, and optionally `height`, `facing`, `fps`, `weights`.
`test/rig.test.ts` runs it on a made-up humanoid (`test/fixtures/make_humanoid.py`) and reads the GLB back
(`test/fixtures/check_rig.py`); it skips where Blender isn't installed (`BLENDER=/path/to/blender` points it at one).

After the rig, `blender.character` does the rest: cleaning, baking, props, clips from other skeletons, clip edits, and
the FBX and GLB the games load. It's covered in `docs/3d-characters.md`.

## Repainting the shot

**`video.control`** (LTX-2.3 22B with the Union IC-LoRA, family `ltx-2.3`):
- `control`: the depth video (or pose, or edges).
- `image`: the first frame in the finished look.
- `prompt`: what happens and what it sounds like. Describe the motion and the sound, not the picture; the image
  carries the look. Put dialogue in quotes.

It makes sound too. The length comes from the control video, up to `seconds` (10).

Which control to give:
- **Depth** holds the layout and the camera.
- **Pose** holds the bodies and leaves the rest free.
- **Edges** hold the most detail.

**Plain footage** works too: `estimateDepth: true` reads depth with MoGe first. Use it for gameplay recordings
(playtest videos) or filmed clips.

**`video.control-wan`** (Wan 2.2 14B Fun Control, family `wan-fun-control`) is the alternative: no sound, 16 fps,
20 steps (slower). Render the shot at `fps: 16` and set `frames` to match. Its default size is 832 x 480.

**Models install on first use:**

| Tool | Download | What |
|---|---|---|
| `video.control` | about 40 GB | the LTX checkpoint, Gemma text encoder, the IC-LoRA and MoGe |
| `video.control-wan` | about 30 GB | two fp8 Wan models; the text encoder and VAE are already core |

**The first frame:**
- `image.edit` with the `first frame` as image 1 and character sheets as images 2–3, e.g. "Repaint this 3D render as
  a gritty live-action film still, night, rain; keep the composition and poses exactly". Run it as candidates and
  let Claude pick.
- `image.control` (render-to-art ControlNet) works from the depth's first frame instead.

## One recipe: asset.make

The whole chain is one recipe. Changing a later step only makes what's new. With `pickAt: 2`, the render runs once,
three stylings are made and Claude picks one, and the video runs on the winner.

```json
{
  "tool": "asset.make",
  "params": {
    "steps": [
      { "tool": "blender.render", "inputs": { "files": ["$input:0"] },
        "params": { "shot": { "characters": [{ "file": 0, "animation": "Walk", "height": 1.8, "travel": 1.3, "facing": 90 }],
                              "camera": { "move": "follow", "angle": 70, "distance": 4.5 } }, "seconds": 5 },
        "save": "render" },
      { "tool": "image.edit", "inputs": { "images": ["$step1:first frame", "$input:1"] },
        "params": { "prompt": "Repaint this 3D render as a cinematic live-action film still: a man in a dark suit (image 2 is his reference sheet) walks down a rain-soaked neon street at night. Keep the composition, camera and pose exactly.", "width": 1280, "height": 704 },
        "save": "look" },
      { "tool": "video.control", "inputs": { "control": "$step1:depth", "image": "$prev" },
        "params": { "prompt": "He walks steadily down the wet street, the camera tracking alongside; footsteps splash, rain hisses, distant traffic." },
        "save": "video" }
    ],
    "pickAt": 2, "candidates": 3, "pick": "on-model with the reference sheet, keeps the render's composition"
  },
  "inputs": { "files": ["C:/Projects/phoriginswebsite/assets/models/ch33-hero.glb", "C:/path/to/hero-reference-sheet.png"] }
}
```

**From Hawkes Studio:** the same `steps`, `pickAt`, `candidates` and `pick` go in a project's `hawkes.assets.json`,
and its `files` map `render.depth`, `look` and `video` to paths in the repo.

**From an MCP:** `hawkesgen_run` with `tool: "asset.make"` and the params above. Or call `blender.render`, then
`image.edit`, then `video.control` one at a time, passing outputs on as `asset:<id>`.

## The cut: video.compose

`video.compose` puts finished shots together with ffmpeg, on the machine the service runs on. It's free and takes
seconds. It handles the edit order, trims, cuts and transitions, each shot's own sound, music and voice tracks, and
captions. The output is a web H.264 mp4 (yuv420p, AAC, faststart), a `.vtt` when there are captions, and a poster PNG.
Clips of any size and frame rate are normalized: each is resampled to `fps` and letterboxed (`fit: pad`) or filled
(`fit: crop`) to `width` x `height`. Lengths snap to whole frames, so transitions land exactly.

**Inputs:** `clips` (videos) and `audio` (music, voice lines, beds), both lists. The timeline picks from them by index.

**Params:** `timeline` (below), `width`, `height` (1280 x 704), `fps` (24), `fit`, `captions` (`vtt`, `burn` or
`both`), `codec` (`h264`, or `h265`), `crf` (20), `poster`, `posterAt`.

**The timeline:**

| Field | What |
|---|---|
| `clips[]` | The cut in order (default: every clip, cut together). `clip` (input index; one clip can be used twice), `in`, `out` (seconds in the clip) |
| `clips[].transition` | How this clip goes **into the next**: `cut` (default), `crossfade`, `dissolve`, `fadeblack`, `fadewhite`, `wipeleft`, `wiperight`, `wipeup`, `wipedown`, `slideleft`, `slideright`, `circleopen`, `circleclose`. `seconds` is its length (0.5). `crossfade: 0.5` is short for both. A transition overlaps the two clips, so the cut gets shorter by its length |
| `clips[].sound` | Keep the clip's own sound (LTX shots have it). Default `timeline.sound`, else true. Its sound fades across transitions. `volume` scales it. `dialogue: true` makes ducked tracks dip under it |
| `audio[]` | `audio` (input index), `start` (seconds on the cut, or after the start of timeline clip `clip`), `in` (seconds into the file), `seconds` (longest it plays), `volume`, `fadeIn`, `fadeOut`, `loop` |
| `audio[].dialogue` | This track is a voice line |
| `audio[].duck` | Dip under dialogue. `true` / `"envelope"` dips to `duckTo` (0.3 of the volume) around each dialogue track or clip, with quarter-second ramps. `"sidechain"` compresses it under the dialogue's actual sound (a lower `duckTo` compresses harder) |
| `captions[]` | `text`, `start`, `end` (or `seconds`, 2.5), on the cut or relative to timeline clip `clip`. Or `track`: shown while that `audio[]` track plays (a voice line's caption) |
| `fadeIn`, `fadeOut` | From and to black at the start and the end, picture and sound |

```json
{
  "tool": "video.compose",
  "inputs": { "clips": ["asset:SHOT1", "asset:SHOT2"], "audio": ["asset:MUSIC", "asset:LINE1"] },
  "params": {
    "timeline": {
      "clips": [{ "clip": 0, "transition": "crossfade", "seconds": 0.5 }, { "clip": 1, "out": 4.5 }],
      "audio": [
        { "audio": 0, "volume": 0.3, "loop": true, "fadeIn": 1, "fadeOut": 2, "duck": true },
        { "audio": 1, "clip": 1, "start": 0.4, "dialogue": true }
      ],
      "captions": [{ "clip": 1, "start": 0.4, "end": 2.6, "text": "Who's there?" }],
      "fadeIn": 0.5, "fadeOut": 1
    },
    "width": 1280, "height": 704, "fps": 24
  }
}
```

The outputs are titled `cut`, `captions` and `poster`. The result has `duration`, `width`, `height`, `fps`, `bytes`,
and each clip's place on the cut (`clips[].start`, `end`). Anything left out goes in `notes`, such as a caption past
the end or a track that ducks when nothing is dialogue.

**Hawkes Video** (`hawkes-video`, `tools/cut.mjs`) builds the timeline from a production's `edit.json` and
`audio.json`. It makes the music cue (`audio.music`) and voice lines (`audio.voice`) first.

## Cost

On a running L40S, a 5 s shot (121 frames at 1280 x 704) takes:

| Step | Time | Source |
|---|---|---|
| `blender.render` | about a minute (beauty at 32 samples, plus three data passes) | estimated; needs a live run |
| `image.edit` | about 15 s per take | job history |
| `video.control` | about 2–3 minutes | estimated; needs a live run |

**Price a batch with `/v1/estimate` first** (it expands `asset.make` with `pickAt`). The first run on a server adds the
Blender install (1 minute) and the LTX model download (about 40 GB, 15–20 minutes).

## How it works

| File | What |
|---|---|
| `post/blender/hawkes_blender.py` | Runs inside Blender. Builds the shot and renders the passes as PNG sequences. Depth, normal and mask use emission-only material overrides with no bounces. It writes the pose keypoints from the bones (`pose.json`) and `info.json`. Progress lines start with `HB `. |
| `post/pose_draw.py` | Draws the skeletons with Pillow (ComfyUI's Python on the server). |
| `src/tools/compose.ts` | `video.compose`: `planCompose` turns the timeline into one ffmpeg filter graph (trim, fps, scale/pad, xfade or concat; each sound placed with `adelay`, the ducking, then `amix`). `test/compose.test.ts` checks the plan and makes real cuts of synthetic clips. |
| `src/tools/blender.ts` | The tool, and the script the server runs: Blender, the pose drawing, then ffmpeg to one mp4 per pass. |
| `src/providers/blender/` | The install (`install.ts`, shared with `bootstrap.sh`), and the per-job workspace on the server (`/var/tmp/hawkes-blender/<job>`). The render runs as a transient systemd unit, so a dropped SSH connection doesn't stop it and cancelling the job does. Hawkes Gen follows its log and counts the time as GPU time. |
| `test/blender.test.ts` | Runs the whole server script on this PC (Blender 5.0) with a small rigged character it makes itself (`test/fixtures/make_rig.py`). It skips where Blender isn't installed (CI). |

To try the Blender script on this PC:

```bash
"C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup -P post/blender/hawkes_blender.py -- spec.json
```

`spec.json` has `out`, `files`, `frames`, `fps`, `width`, `height`, `passes` and `shot`, the same as the tool's
params. `device: "cpu"` works anywhere.
