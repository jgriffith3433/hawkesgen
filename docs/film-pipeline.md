# The film pipeline

Blender is the motion-control rig, ComfyUI is the cinematographer, Claude Vision is the gate. Blender decides where
everyone is, how they move and where the camera goes, exactly. A video model repaints it. A cheap look at the staging
comes first, so no GPU money is spent repainting a shot where the prop floats or a head hides the speaker.

```
shot (characters, beats, props in hands, set, effects, camera)
   │
   ▼
film.gate ── four eevee frames as a contact sheet ── Claude Vision, strict rubric ── adjust, look again (twice at most)
   │ the approved shot
   ▼
blender.render ── beauty, depth, pose, edges, (normal, mask, layers) + the first frame
   │
   ├─ video.control-mix ── depth + pose + edges in one control video
   ▼
image.edit (Qwen 2511, reference sheets) × 3 ── Claude picks ── image.relight ── image.restore (SeedVR2)
   │ the keyframe
   ▼
video.control (LTX-2.3 IC-LoRA; Wan 2.2 Fun Control as the fallback) ── video.upscale ── video.interpolate
   │
   ├─ close-ups: blender frame ── image.edit portrait ── audio.voice ── video.talk (InfiniteTalk)
   ├─ effects:   one character's matte ── video.control ── video.composite (glow, bloom, protected face)
   ▼
video.compose ── the trailer: wides and close-ups, 2 to 4 s a shot, voice ducking the music
```

Everything is a normal job or an `asset.make` recipe, so takes the library already has are never paid for twice.
`film.plan` builds the recipe from a shot and a few choices, lints it, and prices it. It costs nothing and touches no GPU.

| Piece | Tool or file | What it does |
|---|---|---|
| Shots | `blender.render` v2 (`post/blender/hawkes_blender.py`) | Beats, props in hands, PBR set, effects, DOF, stills, per-character mattes. The shot format is in `docs/blender.md`. |
| Planner | `src/film/shot.ts` | Beats to a timeline, keeping characters apart, the lint, the camera maths, the gate's bounded fixes. Pure, no I/O. |
| Gate | `film.gate`, `src/film/gate.ts` | The contact sheet, the rubric, the numbers, the adjust loop. |
| Recipes | `src/film/recipes.ts`, `film.plan` | `cinemaPass`, `dialogueCloseup`, `vfxLayers`, `characterLora`, `trailerCut`; each returns `asset.make` params. |
| ffmpeg tools | `video.matte`, `video.composite`, `video.control-mix` (`src/tools/film-video.ts`) | Free, on the control server. |
| Pricing | `POST /v1/estimate`, `film.plan` | `asset.make` expands into its steps; `film.gate` into its preview renders. |

## 1. The shot

`docs/blender.md` has the whole format. What the film pipeline added to `blender.render`:

- **`beats`** per character: a list of actions in order, resolved by the planner into a timeline the Blender script plays
  (`walk to the door`, `turn to him`, `draw`). A move takes `distance / pace` (or the `seconds` you give), the character
  faces where it goes, and **the clip's playback speed is matched to the ground speed**: the script measures how fast the
  planted foot slides back past the hips in the clip and plays it at the speed where that equals the ground speed, so the
  feet don't slide. Characters are kept out of each other's way (a walk through someone swings around, a walk into
  someone stops short); the plan says what it did.
- **`attachments`**: a prop goes to a bone (`right hand`, `left hand`, `head`, `hips`, `spine`, or the rig's own bone name) and follows it for the whole shot.
- **`ground.material`, `walls`**: PBR from `texture.maps` outputs (albedo, normal, roughness), tiled every `tile` meters.
- **`background.file`**: a 360° equirect sky from `image.panorama` (already on main).
- **`vfx`**: `muzzle-flash`, `flashlight` (a spot light with a visible beam) and `pulse` (an explosion or lightning glow),
  synced to seconds and riding a prop or a bone. **`camera.dof`** and a **`turntable`** move.
- **Passes**: `depth`, `pose` (OpenPose 18), `edges`, `normal`, `mask`, the first frame, and **`layers`** (one matte video
  per character, the others hold it out). **`stills`** returns frames as PNGs (a list of shares of the shot, or a count)
  and the result says where each character stood in each.

## 2. The director gate (`film.gate`)

Before any ComfyUI or Cycles spend. It renders four eevee frames (t = 0, 33, 66, 100%) of the real shot, tiles them 2 x 2
and sends the sheet to Claude Vision with the shot, where Blender says everyone stood, and a rubric that has only the
checks that apply:

| Check | Asked when |
|---|---|
| `grip:<character>:<n>` the prop is visibly gripped in the named hand, not floating or clipping | the character has `attachments` |
| `face-clear` nobody and nothing occludes the speaker's face | the shot has `speaker` |
| `faces:<a>:<b>` a faces b when they interact | a beat has `lookAt: <character>`, or `intent.faces` |
| `travel:<n>` the character really travelled, forward, not on the spot or gliding | a segment moves |
| `in-frame` everyone is in the frame and nothing blocks the camera | always |

The numbers are checked without Claude: each character stood where the plan put it at each still, faced the way the
plan turned it, and each walk clip's feet kept pace with the ground (`stride:<n>:<clip>`). A camera that would put
someone between itself and the speaker's face is found by geometry before the first render and moved off the line.

On failure Claude proposes the smallest fixes from a **fixed list** (character `position`/`facing`/`travel`/`height`, camera `angle`/`distance`/`height`/`lens`/`aimHeight`/`amount`/`target`, an attachment's `offset`/`rotation`/`grip`/`size`, a prop's `position`/`facing`/`size`), each
bounded; a fix that doesn't apply is dropped, not trusted. The adjusted shot is re-planned and looked at again, **at
most `maxTries` (2) times**. Claude's overall `pass` can't override a failing number.

The result has `pass`, `shot` (the approved one), what each round changed and found, and the contact sheets are outputs.
`onFail: "stop"` (the default) fails the job, so an `asset.make` recipe stops before spending anything else.

```json
{ "tool": "film.gate", "params": { "shot": { "...": "..." }, "seconds": 5, "intent": { "faces": [[0, 1]] } }, "inputs": { "files": ["hero.glb", "gun.glb"] } }
```

In an `asset.make` recipe the approved shot goes to the next step as `"shot": "$step1.result.shot"`: params can take a
step's returned value (`$stepN.result.path`, `$prev.result`), not only its files.

## 3. The cinema pass (`cinemaPass`, recipe `cinema`)

`film.plan { recipe: "cinema", options: {...} }` returns the `asset.make` params. Files: the shot's own files first (its
indexes stay as they are), then up to two character reference sheets.

```json
{
  "recipe": "cinema",
  "options": {
    "shot": { "characters": [{ "file": 0, "height": 1.8, "position": [-1.5, 0], "facing": 90,
                               "beats": [{ "animation": "Walk", "to": [0.5, 0], "seconds": 2 }, { "animation": "Idle", "seconds": 3, "lookAt": 1 }],
                               "attachments": [{ "prop": 0, "bone": "right hand", "grip": [0.5, 0.5, 0.2] }] },
                             { "file": 1, "height": 1.7, "position": [2.5, 0.5], "facing": -90 }],
              "props": [{ "file": 2, "size": 0.8 }], "speaker": 1,
              "camera": { "move": "push-in", "target": 1, "distance": 4, "height": 1.6, "angle": -30, "dof": true } },
    "look": "A rain-soaked neon alley at night, gritty live-action film still.",
    "motion": "He walks up to her through the rain; footsteps splash; distant traffic.",
    "refs": [3], "relight": "cold neon key from the right, wet reflections"
  }
}
```

| Option | Default | |
|---|---|---|
| `seconds`, `fps`, `width`, `height` | 5, 24, 1280, 704 | Wan: 16 fps, 832 x 480 |
| `refs` | none | up to two reference-sheet inputs (after the shot's files); Claude sees them when picking |
| `gate` | true | `maxTries`, `intent` pass through |
| `controls` | `depth+pose+edges` | `depth`, `depth+pose`, `depth+pose+edges` (mixed by `video.control-mix`) |
| `relight` | off | a lighting prompt for `image.relight` |
| `restore` | true | SeedVR2 on the keyframe (it scales 4x: a 1280 x 704 keyframe becomes 5120 x 2816) |
| `engine` | `ltx` | `wan` runs `video.control-wan` (16 fps, no sound, about 7 minutes a shot) |
| `upscale`, `interpolate` | true; off for LTX, 2 for Wan | |
| `candidates` | 3 | the repaint is the best-of-N step (`pickAt`), judged for on-model, composition kept and a clean frame |

The chain: `film.gate` → `blender.render` → `video.control-mix` → `image.edit` (best of 3, Qwen 2511, the first frame
and the reference sheets) → `image.relight` → `image.restore` → `video.control` → `video.upscale` → `video.interpolate`.
Saves: `gate`, `render.*`, `control`, `keyframe`, `shot`. In a project's `hawkes.assets.json`, an entry is the
returned `steps`, `candidates`, `pickAt`, `pick` and `refs` under `asset.make` params, with `files` listing the inputs in order.

**Controls.** The IC-LoRA takes one control video. The mix lays pose and edges over depth (the brightest wins, pose
and edges dimmed), which keeps the layout and adds the lines. The first live run should try one shot with
`controls: "depth"` beside the mix and keep what repaints better.

## 4. The dialogue close-up (`dialogueCloseup`, recipe `dialogue`)

A Blender frame of the speaker (camera at eye level, an 85 mm lens, shallow focus; just the still, so it is cheap) →
`image.edit` portrait in the scene's light (best of 2) → `audio.voice` → `video.talk` (InfiniteTalk), lips following the
voice. `video.talk` makes two passes of `frames` each, so the clip is 2 x frames / fps whatever the audio length; the
recipe sizes it to cover the line (`seconds`, or guessed from the words: pass the real length) and the cut trims it.

## 5. Layered VFX (`vfxLayers`, recipe `vfx`)

Two characters, an effect on one. `blender.render` with `layers` gives each character alone as a matte. The control
video (depth + pose) is cut to the effect character's matte (`video.matte`), so the video model repaints that
character only; `video.composite` puts that layer on the finished base shot inside the matte (grown and feathered, so
an aura reaches past the body), screens a bloom of its bright parts on top, and keeps both off the protected
character's matte, so the effect never muddies their face. Pass the base shot (`$input:N` or `asset:ID`) and the shot
the gate approved.

## 6. The character LoRA (`characterLora`, recipe `lora`)

Turntable stills out of Blender (a full-body ring and a bust ring, 8 each by default, a clean grey background) →
`lora.train` with `autoCaption` (Claude captions what changes per image: view, pose, framing; never the look) → four
on-model reference stills with `image.character`. `lora.train` trains on Z-Image Turbo, so **`image.character` is where the
LoRA is used**; those reference stills go to `image.edit` as reference sheets (`cinemaPass` `refs`). `image.edit`
(Qwen) and `video.control` (LTX) don't load that LoRA themselves.

## 7. The trailer (`trailerCut`, recipe `trailer`)

`film.plan { recipe: "trailer", options: { shots: [{ id, kind: "wide" | "closeup" | "vfx", options }], music: true } }`
plans every shot's recipe, prices each and the whole, and builds the `video.compose` timeline: every shot 2 to 4 s (a
dialogue shot as long as its line plus a breath, up to 5 s; a longer line is a note to split it), wides keep the sound
LTX made at 70%, close-ups take their own voice line, the music ducks under every line, captions on the lines, fades at the
ends. Notes flag a clip too short for the pace and three of the same kind in a row. The cut's `clips` and `audio` are labels
(`shot:<id>`, `voice:<id>`, `music:trailer`) to swap for the finished assets.

## What it costs

`film.plan` prices with job history where this service has it, else the tools' own guesses (marked in the lines). Figures
before any live run, L40S (`g6e.xlarge`, $1.861/h), 5 s shots, no history yet:

| Piece | GPU time | Notes |
|---|---|---|
| A wide: gate (about 1.5 looks) + render + look x 3 + restore + `video.control` + upscale | about 11 min | gate 2 min, render 3 min, looks 45 s, restore 90 s, LTX 150 s, upscale 90 s |
| A dialogue close-up | about 5 min | + about $0.03 of voice |
| A VFX layer (on top of its base shot) | about 7 min | |
| A character LoRA (once per character) | about 30 min | $0.90 |
| Composite, matte, control mix, the cut | seconds | ffmpeg, free |

**One trailer, 14 shots** (9 wides, 4 close-ups, 1 effect layer): 7,665 s of work + model loads + a boot = **2.4 GPU hours:
$4.40 of GPU, about $0.12 of voice**, $4.52. Left running, the idle tail adds up to $1.86; on two servers it is 78 minutes
of wall time for $4.95. Claude's picks and gate calls are $0 on the Max plan. Add $0.90 per character for a LoRA. The numbers
are guesses until job history exists; the first shot made live replaces them. To approve for a real run: **about $12**
($4.52 for the trailer, $1.80 for two LoRAs, $1.50 to re-roll a third of the shots, and room for the guesses being low),
starting with one live wide for about $0.35 to check them. Submit all the shots at once: the queue batches by model family, so each model loads once instead of once a shot.

## Not live-tested

Verified here: the planner, the gate loop (with fakes), every recipe's wiring and prices, the ffmpeg tools on synthetic
clips, and the whole Blender script in Blender 5.0.1 (beats, stride matching, held props, PBR, effects, DOF, layers,
stills). **Not verified, because no GPU was touched:** the eevee frames on a real GPU server, Claude Vision's judgement of
real sheets, `image.relight` and `image.restore` in the chain, the IC-LoRA with a mixed control video, `video.talk` on a
rendered portrait, and the 5120 x 2816 SeedVR2 keyframe's memory on the L40S.

## Files and tests

`src/film/{shot,gate,recipes}.ts`, `src/tools/{film,film-video}.ts`, `post/blender/hawkes_blender.py`;
`test/film-shot.test.ts`, `film-gate.test.ts`, `film-recipes.test.ts`, `film-estimate.test.ts`, `film-video.test.ts`, and
`test/blender.test.ts` (the Blender script, run where Blender is installed; point `BLENDER` at one).
