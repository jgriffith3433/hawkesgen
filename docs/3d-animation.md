# 3D animation: rigs, moves and where they run

Gen's humanoid pipeline makes a character, rigs it, puts moves on it and exports it for Unity and the web. The tools
and their ops are in `docs/3d-characters.md`. This doc covers:

- where the tools run since AWS went down: the **3D worker image** on RunPod or Modal, or the fleet when it's back;
- the newer pieces: **motion from video**, the **motion check**, the `animation` intent and the editor's ways in;
- how to set it all up.

## What there is

> **For J: Kimodo never runs yet (2026-11-08).** Gen's Hugging Face token has no access to `meta-llama/Meta-Llama-3-8B-Instruct`,
> the text encoder Kimodo needs. The log says "Kimodo will be skipped", then "using HY-Motion 1.0", so **every take is made
> by the HY-Motion fallback**. To get Kimodo: sign in to Hugging Face with the account that owns Gen's token, open the Llama 3
> model page and request access (Meta approves it, usually quickly). HY-Motion makes no finger motion, and "float" prompts give
> kneeling with the head back unless "upright, head level looking straight ahead" is in the prompt and every key pose.

**Bone names (2026-11-08).** The import reads a rig's body (limbs, spine, head) and its fingers separately, so a rig that names
its limbs the Unity way (LeftUpperLeg, LeftLowerArm, Chest, LeftToes) and its fingers the Mixamo way (LeftHandIndex1) imports with
no map (`names: "unity+mixamo"` in the report). A retarget that finds none of the eight limb bones (thighs, shins, upper arms,
forearms) fails the job instead of warning. `motion.from-text` and `motion.from-video` take `names` and `map` for the character
(passed to the import op), and their `checks` also say when the retarget lost a limb or the FBX isn't a Unity Humanoid.


| Need | Tool | Notes |
|---|---|---|
| A rig on a model | `mesh.rig` | Humanoid: a Mixamo-named skeleton (fingers too) by Make-It-Animatable. Anything else: SkinTokens. Rigged GLB + FBX + a walk video. |
| A stock move | `blender.character` (`retarget` a `motion:ual1/...` clip) | 89 CC0 Quaternius clips (walks, runs, idles, melee, hits, deaths, jumps). Free to use, cheapest. |
| A new move from words | `motion.from-text` | Kimodo (SOMA skeleton), HY-Motion fallback. Key poses, takes, loop, in place. |
| A move from a video | **`motion.from-video`** | NVIDIA GEM-X (body motion from one ordinary video, SOMA skeleton, feet planted by its contact pass). Anyone's footage, or the character filmed doing it (below). |
| Is the move any good? | **`motion.check`** (and inside both motion tools) | Foot slide, feet below the ground, joint pops, jitter, loop seam, travel. Free. |
| Clips from anywhere onto any rig | `blender.character` `retarget` | Mixamo, Unity, Unreal, Rigify, SMPL, SOMA and BVH bone names; rest-pose aware. |
| Into engines | `blender.character` `export` | FBX with `mixamorig:` names (Unity Humanoid with no setup), GLB (Draco/WebP) for Babylon/three.js. |
| A film shot | `blender.render` | Shots with characters, beats and control passes (docs/blender.md). |

Every one of these is a job (`/v1/jobs`, the CLI's `run`, any client), an MCP tool, and a Create form in the app.

## Where they run

The 3D tools (`image: '3d'` on the tool) run a bash script in a job folder, `/var/tmp/hawkes-blender/<job>`
(`src/providers/workspace.ts`). That folder is in one of two places:

- **A GPU worker running the 3D image** (`server/gpu3d/Dockerfile`, `ghcr.io/jgriffith3433/hawkes-gen-gpu:3d-latest`): RunPod,
  Modal or any HTTPS host.
  - Each script run is **one request**, `{ hawkes_job: { dir, script, files, texts, collect } }`, through the same
    protocol and broker a ComfyUI graph uses (`src/providers/cloudrun/run.ts`, `server/cloudrun/worker.py` `_job`).
  - The files go up by content. The worker writes them into the folder, runs `bash run.sh`, and sends back the folders
    asked for plus the script's `HB ...` lines. The tool reads those back as if they had come in live.
  - Resume, cancel and heartbeats work as for graphs.
  - Gen's Hugging Face token rides in the request's `extra` (never in the stored graph) for gated weights.
- **A fleet server over SSH**, as before: installs on first use and keeps the folder between runs. That needs AWS back.

The image installs Blender 5.0.1 and the rig, motion and mocap venvs at **the same paths as the fleet**: `/opt/blender`,
`/opt/hawkes-rig`, `/opt/hawkes-motion`, `/opt/hawkes-mocap`. It does this from the same TypeScript the fleet's installers
use, with `weights: false` (`tools/gpu-providers/image-context-3d.mjs` writes the scripts). So one job script runs in
both places.

**Weights load on first use.** A worker's script starts with a weights step (`weightsPrelude`, each model's
`weightsScript()`). It fetches what that model needs into `HAWKES_WEIGHTS` once, under a `flock`, then links the files
where the code reads them.

| Where `HAWKES_WEIGHTS` points | Used when |
|---|---|
| `/runpod-volume/hawkes-weights` | A RunPod network volume is attached |
| `/weights/hawkes-weights` | The Modal Volume `hawkes-gen-3d-weights` (`tools/gpu-providers/modal.mjs --kind 3d`) |
| `MODELS_MOUNT` | Some other mounted volume |
| The container disk | No volume: every cold worker downloads again |

What gets downloaded, once per volume:

| Weights | Size |
|---|---|
| Rig: Make-It-Animatable, Hunyuan VAE, SkinTokens | ~5 GB |
| Kimodo and Llama 3 8B | ~20 GB |
| HY-Motion and Qwen3-8B (only when Kimodo fails) | ~20 GB |
| GEM-X and SOMA | ~4 GB |

**Routing** (`src/providers/gpu/route.ts`):

- A 3D tool goes to the fleet, or to an endpoint that **names its family**: `rig`, `motion`, `mocap` or `blender`.
- An endpoint with `families: ["*"]` runs the ComfyUI image and never gets a 3D job.
- Cloud Run's ComfyUI services never do either.
- If a provider answers with the ComfyUI image anyway, it is marked unavailable and the job moves on.
- `toolReady` tells the app's Create list and `make.checked` whether a 3D tool can run now: the fleet is up, or an
  enabled endpoint names its family.

**Security.** A `hawkes_job` is a bash script, so the 3D worker refuses one unless it has a `WORKER_TOKEN` and the
request carries it (Gen's `GPU_WORKER_TOKEN`). The only exception is `HAWKES_ALLOW_UNTOKENED_JOBS=1`, for a private
test box.

## Setting it up (J's steps; nothing costs money until a job runs)

1. **The image.** Push a tag `gpu3d-image-<anything>` (or run the "3D worker image" workflow by hand). GitHub builds
   `server/gpu3d` and pushes `ghcr.io/jgriffith3433/hawkes-gen-gpu:3d-<hash>` and `:3d-latest` (the public package: a new one would start private). To see the files and the
   tag without building, run `node tools/gpu-providers/image-context-3d.mjs --print`.
2. **The worker token.** `GPU_WORKER_TOKEN` in `hawkesgen/.env` and in Gen's environment on each lane. The 3D endpoint
   gets it as `WORKER_TOKEN` (the scripts below put it there).
3. **The endpoint.** Pick one:
   - **RunPod:** `node tools/gpu-providers/runpod.mjs --kind 3d` (add `--apply` to create the template). Then, in the
     console:
     - a load-balancer endpoint, GPU L40S (48 GB; HY-Motion wants 26 GB, SkinTokens 14 GB);
     - max workers 2, idle timeout 900 s;
     - a **network volume** of about 150 GB in the same region.

     Run it again with `--endpoint <id>` for Gen's settings entry.
   - **Modal:** `node tools/gpu-providers/modal.mjs --kind 3d --apply`. It deploys with the weights Volume; run it again
     with `--url <endpoint>` for the entry.
4. **Gen's settings.** `POST /v1/settings` with the printed entry: the provider with
   `families: ["rig","motion","mocap","blender"]`, `graphLimitSeconds` 1800, and `familyOrder` sending those families
   to it, then the fleet. Both lists replace what's there, so include the existing ones.
5. **Gated Llama.** `HF_TOKEN` in Gen's environment, with access granted to `meta-llama/Meta-Llama-3-8B-Instruct`, for
   Kimodo. Without it, `motion.from-text` falls back to HY-Motion.
6. **Warm the volume (optional, about 10 GPU minutes, roughly $0.30 on an L40S).** Run one `mesh.rig`, one
   `motion.from-text` and one `motion.from-video`. After that, each job is only the inference.

RunPod's load balancer ends a request at about 5.5 minutes. A longer job goes on with no request open while Gen follows
its heartbeat, so the endpoint's idle timeout must outlast it. 900 s covers warm jobs. A first job on an empty volume can
take longer, and if the worker stops, Gen retries it.

## Motion from video (`motion.from-video`)

GEM-X runs Body Motion native77 (final775) through `gem-infer motion-video --postprocess`:

1. It finds the main person (YOLOX) and reads 77 2D keypoints (ViTPose) and Body Pose features.
2. It estimates the camera's turn (`camera: auto`) or trusts a locked camera (`still`).
3. It predicts world-space SOMA motion, then plants the feet with its contact/IK pass.

`post/mocap/gemx_run.py` writes three things:

- the rotations;
- the root;
- **SOMA's own joint positions**.

Then `post/motion/soma_to_bvh.py`, running in Kimodo's venv, writes the **same SOMA BVH Kimodo writes**: its
`somaskel77`, standard T-pose rest. It doesn't trust the rotation convention: it runs each candidate through Kimodo's
forward kinematics and compares bone directions with GEM-X's joints. It keeps the best match, and refuses below 0.9
mean cosine rather than write twisted limbs. `result.conversion` says which convention won and its score.

Joint order is checked by name. GEM-X's `SOMA77_JOINT_NAMES` and Kimodo's skeleton were the same on 2026-11-07. From
there it's motion.from-text's back half: the check, `blender.character retarget` (`from: soma`), loop or in place,
exports and the preview.

- **Inputs:** `video` (one person, the whole body in frame, up to 60 s); optional `character` (the rig).
- **Params:** `start`, `seconds`, `camera` (`auto` | `still` | `moving`), `loop`, `inPlace`, `name`.
- **Outputs:** `bvh`; with a character also `glb`, `fbx` and `preview`.
- **Result:** frames, the `check`, the `conversion`, licenses.

**The character films itself.** When there's no footage, a still of the rig goes through `video.i2v` (the move written
as it happens, the whole body in frame, a still camera), and then `motion.from-video` reads it back. This handles moves
words can't pin down. Three ways in:

- the `character3d` slot `mocap/<name>`: its `makeWithoutSource` recipe runs when the slot has no `source`;
- MCP `animate_from_video` with `motion` and no `video`;
- the app's character sheet, "Move from a video".

**Licenses:** GEM-X code is Apache-2.0 and its weights are under the NVIDIA Open Model License. Its card says it's
ready for commercial use. GVHMR, WHAM, TRAM and the SMPL family are not installed (research-only or SMPL
non-commercial). `MOCAP_LICENSES` in `src/providers/mocap/install.ts` is checked in `test/mocap.test.ts`.

## The motion check (`motion.check`, `post/motion/check.py`)

Plain Python (no packages), so it runs anywhere. It reads any BVH and runs forward kinematics:

| Measure | What it is | Flag above |
|---|---|---|
| `footSkate` | A planted foot's horizontal speed | 0.25 m/s |
| `penetration` | How far a foot goes under the clip's ground | 3 cm |
| `pops` | Frames where a joint moves faster than 12 m/s | any |
| `jitter` | Mean jerk scaled to the body | 1.0 |
| `loopSeam` | With `loop`: last pose vs first, hips-relative | 5 cm |
| `travel` | With `inPlace`: how far the hips move over the ground | 0.15 m |
| `heightRange` | The hips' vertical range | not flagged |

It returns `{ ok, problems, metrics, fix }`. The motion tools run it on every take into `result.checks`.
`motion.from-text` also names `result.best`, the take with the fewest problems and the least slide and shake. It is
the numbers half of judging motion. The eyes half is `library.judge` on the preview video, judged moving, never from a
still.

## The making loop (`make.checked`, intent `animation`)

`knowledge/routing.json` routes `animation` to `motion.from-video` when the request gives `inputs.video`, else to
`motion.from-text` (the brief is the prompt). Give the rig as `inputs.character`.

- The take judged is the **preview video**: `assess` with the brief, kind `video`.
- The clip's GLB, FBX and BVH come back beside the result.

## The editor's ways in

**MCP** (`src/mcp-make.ts`):

| Tool | What it does |
|---|---|
| `rig_character` | A skeleton on a model; humanoid and height are optional |
| `animate_character` | A move from words: takes, loop, in place |
| `animate_from_video` | A move from a video, or the character films itself |
| `stock_animations` | Search the CC0 library |
| `add_animations` | Stock, Mixamo or BVH clips onto a rig, loop or in place |
| `export_character` | `unity` FBX or `web` GLB with every clip |
| `check_animation` | The motion check on a BVH |

**The app:**

- Create > Animation lists Text to 3D skeletal motion, Video to 3D motion (mocap) and Check an animation.
- 3D & rigging has Auto-rig and the 3D character pipeline.
- The character sheet has **Rig it**, **Move from words**, **Stock move** and **Move from a video**. Each new move is
  merged into their model with `blender.character`, so the clip list grows and every stage that casts them can use it.

**The assistants:**

- **Character AI** (`src/sceneai.ts`): "make him walk", "give her a punch like in my video" become one `asset.make`
  chain. It rigs first if the model has no clips, picks a stock clip when one fits (the prompt carries the real list
  from `motions/quaternius.json`, so it never invents a name), else `motion.from-text` or `motion.from-video`, and
  merges every new clip into the model with `blender.character`. Checked with real turns on 2026-11-08: stock
  Walk_Loop plus a text move; a stock punch plus a video move.
- **AI editor** (`EDITOR_TOOLS`): `mesh.rig`, `motion.from-text` and `motion.from-video`, with results going to the
  library.
- **AI director:** a cast member's `animation` must be a clip their model has. When a move is missing, it picks the
  closest one and points to the character sheet or the Character AI (it can't run jobs itself).

**The library:** the `character3d` kind gains `mocap/*` beside `motion/*` and `animation/*` (`presets/shared/kinds.json`).

## Engines

- **Unity:** the FBX export renames bones `mixamorig:*`, so the Humanoid avatar maps with no setup. `check/humanoid`
  proves it in EditMode.
- **Babylon.js 9:** `AnimatorAvatar.retargetAnimationGroup` retargets by bone name, so a clip exported with Mixamo names
  plays on any Mixamo-named rig in the browser. Use 9.7 or later: an earlier release clobbered a running clip.
  Dose Of Destruction is on 9.30.

  ```js
  const avatar = new BABYLON.AnimatorAvatar('hero', heroRoot);
  const walk = avatar.retargetAnimationGroup(clipContainer.animationGroups[0], { animationGroupName: 'Walk', fixGroundReference: true });
  walk.start(true);
  ```

- **PH Origins** (Babylon 7) has no `AnimatorAvatar`. Bake the clips into the character's GLB in Gen
  (`add_animations` / `export_character web`), or move it to Babylon 9.
- **three.js:** `AnimationMixer` on the exported GLB; one action per clip.

## What has and hasn't run (2026-11-07)

**Verified:**

- The job scripts ran in Blender 5.0.1 on J's PC, where the tests could reach Blender.
- The motion check was run on synthetic clips.
- The worker's `hawkes_job` handler ran in a test.
- Routing, readiness and the workspace were covered by `npm test`.

**Not run yet:** the 3D image build, a RunPod or Modal 3D endpoint, and real GEM-X, Kimodo, Make-It-Animatable and
SkinTokens inference on a worker. Those need the image built and the endpoint set up (steps 1–4), and GPU time, which
needs J's OK.
