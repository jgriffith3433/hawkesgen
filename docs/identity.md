# Identity: the same character in every shot

*Phase 1 of `docs/worlds-roadmap.md`, built 2026-10-31 on branch `claude/worlds-identity-6bb48c`. Offline: nothing here
has run on a GPU yet. The live runs that would prove it are priced at the end, for J to approve.*

**The problem it fixes:** a character scene had pictures, but filming never used them. `filmPrompts` passed names and
loose words to `image.control` and `video.control`, so every first frame redrew the face.

**The rules it follows** (from the research behind the roadmap): lock one canonical sheet and attach it to every
generation; never let one shot set the next shot's look; paste a fixed 50-80-word description into every prompt; train
a LoRA for characters who recur.

## What a character carries now (`src/identity.ts`, `src/scenekinds.ts`)

| Field | What |
|---|---|
| `lock: { sheet, description, at }` | The identity pack. `sheet` is a picture of theirs (asset id), `description` the fixed words, `at` when the person locked it. `at: null` is a draft (made, not approved yet): still used, since it beats the loose words. Only a whole pack (sheet and words) can be locked; `at: true` (the AI locking on the person's word) becomes now. |
| `lora: { asset, trigger, state, pending, failed }` | Their LoRA. `training` (with its job), `ready` (the `lora.train` output, which `image.character` reads its trigger from), `failed`. |
| `pictures[].from` | When a picture waits on an `asset.make` chain that saves several steps, the saved step it takes (the AI makes the front and the sheet in one job). |

Old documents load unchanged (no lock, no LoRA). `identityPack(doc)` (the shared contract) reads them: the locked sheet
first, then front, portrait, references; the fixed description (else the loose words); the LoRA only once it's ready;
their model; and `locked` (an additive field).

A cast member who plays a character scene takes the fixed description as their description (`castFromCharacters`), so
the AI director and every prompt see the same words.

## Making and locking the pack

**"Make their look"** (the character editor's "Their look" box, `dashboard/gen/character.js`):
1. the front picture, only when there isn't one: `image.generate`, full body, relaxed A-pose, **empty hands** (props
   drift between angles), plain light grey background (`frontPrompt`);
2. the sheet: `image.edit` (Qwen-Image-Edit-2511) over the front picture at 2048×1152: the same front view, a
   three-quarter view and four expressions (neutral, smiling, angry, surprised), no text (`sheetPrompt`). Chosen over
   `image.viewsheet` because the viewsheet makes back/left/right turnarounds for 3D, not expressions, and costs a
   Claude check; the sheet is for faces;
3. the fixed description: Claude writes 50-80 words from their words and both pictures (`describeRequest`,
   `POST /v1/scenes/:id/identity/describe`, house AI rules and credits as the character AI), cut to 80 words at a
   sentence (`fitDescription`). Saved as a draft lock.

The person reads it (the words are editable until locked), then **"Lock their look"**. **Unlock** puts it back to a
draft; **Redo** makes it again. The character AI does the same (`DOCS.character` in `src/sceneai.ts`): it makes the
front and sheet in one chain with `from` marks, writes `lock.description`, leaves `at` null unless told to lock.

Routes (`src/identityroutes.ts`, one dispatch line in `src/api.ts`):

| Route | What |
|---|---|
| `GET /v1/scenes/:id/identity` | `{ pack, plan, lora }`: the pack, the Make-their-look jobs, the LoRA offer |
| `POST /v1/scenes/:id/identity/describe` | writes the fixed description, saves the draft lock |
| `POST /v1/scenes/:id/identity/lock` | `{description?, sheet?}`; needs a sheet that is one of their pictures, and words |
| `POST /v1/scenes/:id/identity/unlock` | back to a draft |
| `POST /v1/scenes/:id/identity/lora[?quote=1]` | prices, then trains |
| `POST /v1/director/prompts` | `{doc, shot?, look?, camera?, screen?, loraReady?, strong?}`: the prompts plus `firstFrame` and `packs` (replaces the old route; same fields, more) |
| `POST /v1/director/identity-check` | `{asset, shot? or doc}`: `assess` on the first frame against each known face |

## References in every shot (`src/identity-film.ts`, `src/director.ts`, `dashboard/gen/director.js`)

**The chosen way, from what the tools take.** `image.control` takes one control image and no references;
`image.edit` (Qwen-Image-Edit-2511) takes three images: one to edit and two references. So a first frame is one
`asset.make` job:

1. **paint**: `image.control` paints the stage's first frame in the look (or `image.edit` edits it, as the shot's
   film settings say). The layout, camera and poses stay. Its prompt carries every known character's fixed description,
   unchanged.
2. **on-model**: one `image.edit` pass per known character (locked first, at most three), on the frame so far, with
   their sheet and either **the camera render** (below) or a second picture of them. The prompt names who to repaint,
   where they stand in frame (left/center/right, measured on the stage), pastes the fixed description, and says to keep
   everything else.
3. **LoRA**: a character with a trained LoRA first gets a picture of them at this shot's angle from `image.character`
   (front/three-quarter/side/back from the camera's angle against their facing: `viewOf`), which becomes the pass's first
   reference, the sheet the second. Only when `image.character` can run now (it needs the SSH fleet).

With no one known it is the paint job alone, exactly as before. The video then starts from the on-model frame:
`video.control` / `video.control-wan` (their prompt carries the fixed descriptions too) and **talk shots**
(`video.talk` starts from the same on-model frame, and its prompt carries the speaker's fixed description).

**The reference from the shot's own camera** (`record()` in `dashboard/gen/director.js`): when any cast member has a 3D
model, the stage renders the frame-1 pose again from the shot camera with only the modeled cast visible (stand-ins,
props and the ground hidden) on a plain light grey background, at the film's size. It is uploaded with the first
frame and is image 3 of the on-model pass: their own body, at exactly this angle and pose. No reference-image tool has
a model to render, so this one is Gen's alone.

**The identity check** (`identityCheck`): after the first frame, `assess` (`src/quality/index.ts`) runs with each known
character's first three pictures as `identityRefs`. On a fail the frame is made again with `strong: true` (two pictures
of the person instead of the render, firmer words, best of two picked by Claude against the references); the take with
the smaller distance is kept, and a take that still fails is marked (`identity: { pass, distance }` on the take, and the
status line says a face may not match). Until the bench work lands `assess` always passes, so the retry never fires.

**The Blender path** (`blenderRecipe(s, packs)`): up to two sheets (locked first) go after the shot's own files as
`cinemaPass` `refs`, so the best-of-3 keyframe is painted with them (`image.edit` images 2 and 3) and picked against
them; the fixed descriptions go in as `canon`. The route now passes `refs` and `canon` to `asset.make`.

**Photo** (the stage at the playhead) uses the same first-frame job, without a camera render.

## LoRAs for characters who recur

- **Offered** (`loraOffer`) once the look is locked and they are cast in 3 or more shots, or have 8 or more pictures
  (cut-outs don't count): "Keep Maya consistent everywhere", priced first in a confirm.
- **The job** (`loraPlan`): one `asset.make`: their pictures, topped up to six with new angles of the front picture
  (`image.edit` with the Multiple-Angles LoRA), then `lora.train` (Claude's per-image captions, the fixed description as
  the caption base). `lora.train` stays out of Create (`NOT_IN_CATALOG` unchanged): the app reaches it only through this
  route. `image.character` was already in the catalog; nothing in `src/editor.ts` needed to change.
- **State** on the character: "Learning their look…" while it trains, "Locked in" once ready, the reason and "Try
  again" if it failed. `resolveLora` fills it in from the chain's `lora.train` step.
- **No training has run**: tests submit and cancel the job; the queue never starts it.

## Places and props (for gen-worlds)

`placePackPlan(description, { style })`: a 360° panorama (`image.panorama`), then three key views painted from it
(`image.edit`: wide establishing, eye level, the reverse angle), saved `panorama`, `view-wide`, `view-eye`,
`view-reverse`. `propPackPlan(description, { style })`: the prop alone (`image.generate`, nothing else in frame, no hands),
cut out, then a checked 4-view sheet (`image.viewsheet`, form prop), saved `front` and `sheet`. Both return
`asset.make` `steps`.

## Verified (offline)

`test/identity.test.ts` (16 tests): normalizing the document (old ones too), the pack, Make their look, the fixed
description, LoRA eligibility, the LoRA plan and its resolve, chain pictures with `from`, the prompts carrying the fixed
description unchanged in the look, video and talk, the first-frame job (sheet and camera render as references, several
characters, the strong retry, the LoRA pass), the identity check with a failing mock `assess`, place and prop packs,
packs read from the store, the Blender recipe's refs and canon, and over HTTP: lock, unlock, the LoRA priced then
submitted, the prompts and first frame for a stage with a locked character (the mock run), the check, and another
account refused.

Not verified: anything on a GPU; the browser paths (camera render, the look box) were syntax-checked, not clicked
through.

## Left

- Trial FLUX.2 [dev] (up to 6 references) against Qwen-Image-Edit-2511 for the on-model pass on Gen Bench, and keep
  the winner (`firstFramePlan` is the one place to change).
- Reference-to-video routing for shots that suit it (`video.scene`, `video.perform`): the making loop's router.
- Rules for real people's likenesses before references ship to customers (roadmap risk).
- A takes table: the identity mark on a take lives only in the film sheet for now.

## Live runs to prove it (priced by `hawkesgen_estimate`; need J's OK)

| Run | What | GPU | Cost |
|---|---|---|---|
| **A. Packs + a 20-shot scene** | 3 characters: Make their look (3 fronts, 3 sheets); a 20-shot scene, each first frame painted and put on-model (about 30 passes), filmed with `video.control` 5 s. Score identity on Gen Bench against the same scene filmed the old way. | ~1.8 GPU h | **$3.33** (about $10.78 if servers idle an hour after) |
| **B. One LoRA** | 3 extra angles, `lora.train` on 6 images, 20 `image.character` pictures at each shot's angle | ~0.75 GPU h | **$1.39** (about $5.11 with the idle tail) |
| **C. The same scene, old way** (baseline for A) | 20 painted first frames + 20 shots, no packs | ~1.5 GPU h | about $2.80 |

Plus Claude for the three descriptions and the strong-retry picks (cents). Estimates for `image.edit`,
`image.control`, `video.control` and `lora.train` are the tools' own guesses (no job history yet).
