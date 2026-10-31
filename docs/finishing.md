# Finishing: sound, the cut, the look, delivery, and worlds into games

*Phases 5 and 7 of `docs/worlds-roadmap.md`. Built 2026-10-31 by the gen-finishing session, offline (no GPU, no money).*

What turns a pile of clips into a show, and a world into a game. Everything here is a tool, so the AI, the app, MCP and
any project call it the same way, and every result keeps its recipe.

| Tool | What it does | Runs on | Floor (credits) |
|---|---|---|---|
| `audio.score` | Music written to a cut: tempo fitted to the cuts, a mood per section, hit points | pipeline: `audio.music` per section, stitched here | 25 |
| `audio.ambience` | Room tone and ambience per place across its shots | pipeline: `audio.sfx` per place, laid here | 16 |
| `audio.mix` | Dialogue first, music ducked under it, ambience and effects; -14 LUFS, -1 dBTP; checked | CPU (ffmpeg) | 3 |
| `edit.pace` | Trims, order, J-cuts and L-cuts as timeline ops (one undo step) | CPU, pure | 1 |
| `video.grade` | A world's grade (LUT or simple settings), grain, vignette on a clip | CPU | 3 |
| `video.compose` (+`grade`, `world`, `lut`, `finalPass`) | The same grade on a whole cut; the final upscale queued after it | CPU | 3 |
| `video.titles` | Title card, end credits (cast by character name, "Made with Hawkes Gen"), captions soft or burned | CPU | 3 |
| `video.reframe` | 16:9, 9:16, 1:1, 4:5 with the subject kept in frame | CPU | 3 |
| `video.thumbnails` | Claude picks three strong frames; each gets a title treatment | CPU + Claude (Sonnet, a few small frames) | 5 |
| `video.trailer` | A 30-60 s trailer: Claude picks moments, then the edit, score and title | pipeline: `audio.score`, `video.compose` | 40 |
| `video.deliver` | The app's Export sheet in one job, and the delivery sheet | pipeline: the tools above | 15 |
| `world.export` | A world as a zip for games: models, pictures, voices, skyboxes, sets, the look, `world.json` | CPU | 1 |

Floors are in `src/billing.ts` `toolFloorCredits` (provisional, like the other finishing-era prices). Pipeline tools'
children run on Gen's own key (unbilled), as `asset.make` and the chain tools do, so the parent's price covers them.

Code: `src/finishing/` (pure plans: `sound.ts`, `grade.ts`, `cut.ts`, `deliver.ts`, `export.ts`, plus `world-grade.ts`
which resolves a job's grade), the tools in `src/tools/finishing.ts`, the app side in `dashboard/gen/deliver.js`, the
game loaders in `clients/js/hawkes-world.mjs` and `clients/unity/com.hawkes.gen/Editor/WorldPackImporter.cs`. Tests:
`test/finishing.test.ts`.

## Sound for a cut

### `audio.score`

1. **Cut points.** From `spans` (a compose result's `clips`), or `cuts` (seconds or `{ at, weight }`). Story `beats`
   weigh 3 (a cut within 0.3 s of a beat becomes a weight-3 cut), scene changes 2, plain cuts 1.
2. **Tempo** (`fitTempo`). Every whole-number BPM in the mood's range (`MOOD_TEMPO`: calm 60-92, tense 90-128, action
   120-170...) is scored: a cut within `tolerance` (60 ms) of a beat counts in full at 0 error, falling off linearly; a
   cut on a half beat counts a quarter. The music starts on a downbeat at 0. Ties go to the middle of the range. The
   music model takes whole BPMs, which is why the search is over integers.
3. **Sections** (`planSections`). Each mood change starts a section on the bar nearest it (4 beats a bar); sections under
   two bars merge. One mood: one `audio.music` request at the cut's length. Several: one request per section (its
   length plus the crossfade), stitched with equal-power crossfades on the downbeats, then a fade out at the end.
4. **Returns** the track (WAV, 48 kHz) and `hits`: every cut with its beat, bar and error, and every section start;
   `snap` proposes moving each cut to its nearest beat when that's within 0.25 s (an editor can apply it with
   `edit.pace`-style ops).

### `audio.ambience`

Shots with their place (`[{ place, start, end, description }]`; with `world`, a world place's id or name fills in the
description). Consecutive shots in one place share one stretch; each place gets one bed from `audio.sfx` (`loop: true`,
`provider: open`: Gen's own Stable Audio 3), looped under its stretches with 0.75 s crossfades at the place changes.

### `audio.mix`

The order a re-recording mixer works in (`MIX_ORDER`):

1. **Dialogue** is measured and brought to -18 LUFS (`dialogueLufs`).
2. **Music** sits 9 LU under the dialogue, then a compressor keyed by the dialogue ducks it while anyone speaks
   (`sidechaincompress`, ratio 6, 15 ms attack, 400 ms release).
3. **Ambience** sits 18 LU under, ducked lightly (ratio 3); **effects** 4 LU under, not ducked.
4. **Master:** one gain to the target (-14 LUFS for the web; -16 podcasts, -23/-24 broadcast), then a limiter half a dB
   under the true-peak ceiling (-1 dBTP), since true peaks run past a sample-peak limiter. If the limiter pulled the
   loudness off by more than 0.5 LU, the master is redone from the premix aiming past the target by the difference (at
   most 3 passes).
5. **Checked** with `audio/post.ts` `analyze` and `judge`: loudness within 1 LU, true peak, clipping, silence.

Without dialogue, music leads at -16 LUFS before the master. Give a `video` and it comes back with the mix as its sound.

Measured in the tests on ffmpeg-made audio (three voice lines, a beat-pulse score, pink-noise ambience): the master
lands within 1 LU of -14 with true peaks under -0.5 dBTP.

## The cut: `edit.pace`

From a video scene (`scene`) or a timeline document, `planPace` (`src/finishing/cut.ts`) answers with timeline ops
(`applyOps`), so the app applies them as one undo step:

- **Order:** beats that name clips (`[{ clip }]`, story order) put those shots first, in that order (`move` ops).
- **Trims:** air before a shot's first line beyond 0.35 s (`head`) and after its last line beyond 0.5 s (`tail`) is
  trimmed; a shot with no line is held at most `maxSilent` seconds (0 leaves them). No shot goes under a second.
- **L-cuts:** a line that runs to its shot's end with another shot after it: the picture cuts `leadFrames` (6) early,
  so the line finishes over the next shot.
- **J-cuts:** a line that opens a shot starts `leadFrames` before the picture cuts to it (never into the line before).
- Lines on the Voice track move with their shots (`set` start ops); one overlap per join.

The AI editor can call it like any tool and apply `result.ops`.

## Look: one grade per world

`gradeFilters` (`src/finishing/grade.ts`) turns a grade into one linear chain of ffmpeg filters:

| Setting | Filter |
|---|---|
| LUT (`.cube`) | `lut3d` (first: the world's look; the settings trim it) |
| lift, gain | `colorlevels` (output black point; white point, or the input white point for gain over 1) |
| contrast, brightness, saturation, gamma | `eq` |
| warmth, tint | `colorbalance` (shadows, midtones, highlights; strongest in the midtones) |
| vignette | `vignette` |
| grain | `noise` (temporal, uniform) |

Values are clamped to sane ranges; a neutral grade is no filter at all. Presets for the app's simple choices:
natural, warm, cool, filmic, noir, vivid, faded (`GRADE_PRESETS`).

- **`video.compose`** takes `grade` (a preset or settings), `world`, a `lut` input, `grain` and `vignette`. The grade
  runs over the whole cut before fades and captions, so every shot gets the same one. Version unchanged (2): without
  these params a cut is what it was.
- **Compose stays pure** because it also runs in the CPU Cloud Run service, whose image carries no library, queue or
  database (`test/cpu-cloudrun.test.ts` checks the import closure). So a world's grade is read **at submit**: compose's
  `admit` (installed by `src/tools/finishing.ts`, `world-grade.ts worldGradeAtSubmit`) turns `world` into the world's
  `grade` settings when none is given, which also puts the grade in the job's recipe. A world's LUT is an asset, so the
  caller passes it as the `lut` input. The final pass is queued through a hook the same file installs
  (`setFinalPass`); compose run anywhere else says it was skipped.
- **`finalPass: "upscale"`** queues `video.upscale` on the finished cut and `image.restore` on its poster, without
  waiting: restore and upscale happen on the final cut only, never per take. The job ids come back in
  `result.finalPass`.
- **`video.grade`** applies the same to any clip.

`worldContext` returns null until gen-worlds lands; then a world's grade reaches every cut that names the world.

## Delivery

- **Titles and credits** (`video.titles`, `planCredits`): a title card (the title, then "Story · A story of World"), the
  end credits (Starring and the cast by character name, from `cast` or the world's characters; "Created by" when given;
  "Made with Hawkes Gen" last), in cards of up to 8 lines, 2.5 s a card. Drawn with libass (the same renderer as
  compose's burned captions), so no font file is needed.
- **Captions:** from `captionList` or an `.srt`/`.vtt` file, moved by the title card. Soft: a `.vtt`, an `.srt` and a
  `mov_text` caption track in the mp4. Burned: drawn into the picture. Or both.
- **Shapes** (`video.reframe`, `planReframe`): the largest crop of the ratio inside the frame, panned to the subject.
  Subject positions over time (`[{ t, x, y }]`: a stage shot's cast, `subjectFromCast` takes the middle of everyone on
  screen) become a piecewise-linear crop x(t), smoothed so a pan never moves faster than a quarter of the frame a
  second. Without positions: the centre. Delivered at the platform's size (1080x1920, 1080x1080, 1080x1350, 1920x1080),
  scaled up at most 2x (a small source gets a smaller file).
- **Thumbnails** (`video.thumbnails`): one candidate per shot (or nine evenly), sent to Claude (Sonnet, 480-wide JPEGs)
  to pick three strong, different frames with a 2-5 word title each (`settlePicks` drops repeats and fills from a
  spread). Each becomes a 1280x720 PNG with a bold title. Without Claude access it picks a spread and says so.
- **Trailers** (`video.trailer`): Claude gets the script and shot list and answers with 6-14 moments in trailer order
  (hook, build, climax, button), up to three text cards and a tagline (`TRAILER_SCHEMA`). `settleTrailer` keeps moments
  inside the episode, drops overlaps and slivers, and trims the longest moments until the trailer (with cards and the
  end title) fits. Then `audio.score` (mood epic by default) and `video.compose` cut it with crossfades into fades to
  black, the score ducked under the episode's own dialogue.
- **The delivery sheet** (`video.deliver`): titles and captions, the shapes (the cut's own shape skipped), thumbnails,
  optionally a trailer (a failed trailer is a note, not a failed delivery), then a JSON sheet listing every file
  (kind, title, asset, format, size, length, what it's for), grouped master, shapes, captions, trailer, thumbnails.

## Worlds into games: `world.export`

From `worldContext(project, world)` (`_setWorldSource` in tests), a zip whose top folder is the world's slug:

```
frostmoon/
  world.json                     the manifest (format hawkes.world/1)
  README.md                      what's inside and how to import it
  look/palette.gpl  look/grade.cube  look/board/board-1.png
  characters/maya/model.glb  model.fbx  pictures/sheet.png  voice/sample-1.wav  clips/wave.glb
  places/the-harbor/skybox.png  set.glb  ambience.wav  views/view-1.png
  props/lantern/model.glb  pictures/picture-1.png
```

- **Characters:** the identity pack (`identityPack` on the character scene: the locked sheet first, the fixed
  description, the model), plus the member's refs; FBX when the document or refs have one; voice samples from audio
  refs; animation clips from the character document.
- **Places:** the 2:1 picture is the skybox (equirectangular); a mesh is the 3D set; audio is the ambience; other
  pictures are views.
- **Props:** a mesh and pictures.
- **The look:** style line, negative, palette (also as a GIMP palette, which Unity, Krita and Aseprite read), the grade
  (LUT file and settings), the style board.
- **`world.json`** (`WorldManifest` in `src/finishing/export.ts`): `world` (id, name, canon), `look`, `characters`,
  `places`, `props` (each with id, name, description and its file paths), `files` (every file: path, role, library
  asset id, kind, mime, bytes, sha256, and its **recipe**: tool, version, params, inputs, seed, when it was made, the
  job), `made`, and `missing` (refs that couldn't be found, so a pack never silently drops something).
- The zip writer is Node's zlib (deflate; already-compressed files stored), no new dependency.

**Loading it:**
- **Unity:** `Hawkes Gen > Import World Pack...` (`WorldPackImporter.cs`) unzips into `Assets/HawkesWorlds/<world>/`,
  makes a Skybox/Panoramic material per place and a `WorldPack` asset listing everything (FBX preferred over GLB for
  characters, since its rig imports as Humanoid). GLB needs glTFast (`com.unity.cloud.gltfast`).
- **Web games:** `clients/js/hawkes-world.mjs`: `loadWorldPack(url)`, then `world.character(name)`, `world.url(path)`,
  `world.palette()`, `world.file(path).recipe`; `threeSkybox`, `babylonSkybox`, `babylonModel`. No dependency: the
  engine module is passed in. Not in `clients/js/sdk.json` yet (no product consumes it); add it there when one does.
- **Hawkes Games and the portal** (`C:\Projects\hawkesgenwebsite`, not edited): the shape to import is `world.json`
  above. A portal page can list a world pack's characters, places and props from the manifest alone, show each file's
  recipe as its history, and hand the zip to Hawkes Games' loader (which can use `hawkes-world.mjs` directly).

## The app

- **Export → "Get it ready to share"** (`deliver.js mountDeliver`, mounted under a finished export by `tools.js`):
  chips for the shapes (Wide, Tall, Square, Portrait; Wide hidden when the cut is already wide), captions (none, viewers
  can turn on, in the picture; the timeline's text clips are the captions), Title and credits, Thumbnails, A trailer,
  the price from `/v1/billing/quote`, and one solid "Make them" button. The files come back as a list with downloads.
  No knobs: the grade and reframe settings stay with the tools and the AI.
- **"Take this world into a game"** (`deliver.js exportWorld`, `worldExportButton(worldId, title)`): for the world's home
  (gen-worlds) to place. It runs `world.export` and offers the zip's download in a toast.

## Verified

- `npm run typecheck` clean; `test/finishing.test.ts` (20 tests) passes on ffmpeg 8.0.1 (Windows): tempo fitting,
  sections and stitching, ambience, the mix order and targets, the grade filters, the reframe math, captions and
  credits, the trailer plan, the pace (applied with `applyOps`), and the tools run for real: a mocked 3-shot cut gets a
  world grade in compose, scored music (fake `audio.music`), ambience (fake `audio.sfx`), a mix within 1 LU of -14 LUFS,
  titles, credits and captions, and a 9:16 version; the final pass queues its children; the trailer and delivery
  chains; `world.export` makes a zip whose `world.json` paths and sizes match its contents, every file with a recipe.
- Not verified: the Unity importer has not been compiled in Unity (no Unity here); open a project with the package in
  batch mode to check (`HawkesGen.Editor.dll` in the log). The app sheet was not clicked through in a browser.

## Left

- **Face detection for reframes.** `image.segment` is GPU and the CPU venv has no OpenCV; reframes use subject
  positions when given, else the centre. Next: the app passes the stage cast's projected positions (`subjectFromCast`),
  and a cheap CPU face finder (OpenCV's YuNet, a 300 KB ONNX model) in the CPU suite.
- **Per-character voice samples** in the export: a house or Gen voice's reference clip is a voice-library file, not an
  asset; the manifest names the voice id. Export it once voices are assets.
- **Dialogue with emotion from the script** (Phase 5's first bullet) is the showrunner's: it already exists as
  `audio.dialogue` with direction; wiring the script's emotion into it belongs to gen-showrunner.
- **Snap the cut to the score:** `audio.score` returns `snap`; turning it into `trim` ops is a small `edit.pace` option.
- **The grade picker in the app:** the world's grade applies through `world`; a "Look" chip row in the Export sheet
  could set a preset for cuts outside a world.
- `/admin` estimates: the new tools have floors but no measured `gpuSeconds` history yet.

## Live runs to approve (priced)

Prices from `POST /v1/estimate` once J approves; rough figures from the tools' `gpuSeconds` and today's fleet rates
(an L4 or A10-class GPU at about $0.80-1.90/hr on RunPod/Modal):

| Run | What it spends | Rough cost |
|---|---|---|
| Score a 2-minute cut, 3 sections | 3 x `audio.music` (~45 s each, ACE-Step turbo, about 20 GPU s per take) | ~1-2 GPU min ≈ **$0.03-0.06** |
| Ambience for 4 places | 4 x `audio.sfx` (Stable Audio 3, ~30 GPU s each) | ~2 GPU min ≈ **$0.03-0.06** |
| A 45 s trailer from a 5-minute episode | 1 Claude call (Opus, ~6k tokens ≈ $0.10-0.20) + 1 score (~$0.02) + compose (CPU) | **≈ $0.15-0.25** |
| Thumbnails | 1 Sonnet call with 9 small frames | **≈ $0.01-0.02** |
| Final pass on a 2-minute cut | `video.upscale` (~4-6 GPU min) + `image.restore` (~10 GPU s) | **≈ $0.08-0.20** |
| Full delivery (titles, 3 shapes, thumbnails, trailer) | the above, minus the upscale | **≈ $0.20-0.30** |

Suggested first live run (needs J's OK): score and mix the Gen Bench "3-shot scene with one recurring prop" and
"30-second trailer" briefs end to end on beta, listen to the score's hits on the cuts, and measure the master's LUFS on
the delivered mp4.
