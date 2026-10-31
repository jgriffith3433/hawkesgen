# Gen Bench and the quality checks

*Phase 0 of `docs/worlds-roadmap.md`, 2026-10-31. What's built, how to use it, what's verified, what's left, and the
live runs that need J's OK (priced below).*

Two things live here:

1. **The quality checks** (`src/quality/`): every check an AI-made output passes before a person sees it. The making
   loop (`make.checked`), identity, the showrunner and the bench all call `assess()`.
2. **Gen Bench** (`src/bench/`): 30 fixed briefs run through the app's real path, every output scored, stored, compared
   with the market baseline and with J's eye. The Bench tab in `/admin` shows it.

---

## The quality checks

`src/quality/index.ts` is the shared contract. Its signatures are unchanged; the fields added since are optional:

| Added | Why |
|---|---|
| `IdentityResult.frames`, `.refFaces` | how many frames were checked, and whether the references showed a face at all (0: nothing was compared) |
| `ChecklistResult.skipped` | a 3D model or a sound can't be judged by looking: the score is 1 and claims nothing |
| `QualityReport.errors` | checks that couldn't run (no face models, the AI unavailable). They don't fail the output: they measured nothing |
| `identityScore(…, opts?)` | an optional third argument (frames, signal, a `python` runner so a job uses `ctx.python`) |
| `verdicts()`, `fixFor()`, `withQualityMock()`, `setQualityMock()`, `setQualityAsk()`, `meter()` | new exports |

| Check | File | How |
|---|---|---|
| **identity** | `identity.ts`, `post/quality/identity.py` | insightface **buffalo_l** on the CPU (SCRFD-10G detection, ArcFace R50). A picture is one frame; a clip is 8 frames spread over it (ffmpeg). Per frame, every face is compared with every reference face (1 − cosine) and the **best-matching face** is taken as the character (others in the shot are someone else). Returns the mean distance, each frame's, the spread (standard deviation) and the faces found; `null` with no face. A sheet's reference counts every face of about the same size. |
| **questions** | `judge.ts` | The brief becomes 4-8 concrete yes/no questions ("yes" means it was followed), by Claude Sonnet at low effort, structured output. |
| **checklist** | `judge.ts` | Each question answered from the output (a clip: 4 frames) with a short reason; references are shown too, marked as references. Score = share answered yes. A missing answer is no. |
| **faults** | `faults.ts` | Picture: blank (ffmpeg signalstats), then what a viewer notices (hands and fingers, melted or doubled faces, extra limbs, garbled text, seams) by Claude. Clip: blank frames and flicker (brightness jumping and coming back, a-b-a, over the first 10 s), then the same look over 4 frames. 3D model: the GLB itself (opens, has triangles, no NaN positions, not a point or a flat sheet, under 300k triangles; Draco-compressed geometry isn't read). Sound: the audio gate Gen already has (`src/audio/post.ts`: silent, clipped, long silences). `blender.character report` measures more but needs a GPU server: too dear for every take. |
| **style** | `judge.ts` | Claude grades the output against the style board pictures and/or the look in words, 0-10 (palette, light, rendering, lens, mood; not content), as a share. |
| **assess** | `index.ts` | All that apply, in parallel. Pass: distance ≤ 0.15 (or no face), checklist ≥ 0.85, no faults, style ≥ 0.7. On a fail, **`fix`**: what failed and what usually fixes it ("The face is off-model (distance 0.31, …): give the character's sheet as a reference, paste their fixed description unchanged…", "Not following the brief: "Is it night" was no…", "Faults: an extra finger… add "deformed hands, extra fingers" to the negative"). No extra Claude call. |

**Where they run.** Claude calls go through `src/providers/anthropic.ts ask()`, so a customer's job runs on its own
Claude like any other. The face script runs with Gen's Python: `HAWKES_PYTHON`, else the project's `.venv`. The face
models download on first use (~280 MB) into `HAWKESGEN_FACE_MODELS` or `~/.insightface` (insightface's own folder, so
both share one copy). With the `insightface` package installed it is used; without it (no wheel for some Pythons) the
same two ONNX models run directly with onnxruntime and OpenCV, giving the same distances to within 0.01.
Python needs: `numpy`, `onnxruntime`, `opencv-python-headless`, `pillow` (and optionally `insightface`).

**As tools** (`src/tools/quality.ts`, `quality-identity.ts`; cards in `knowledge/tools.json`):
- `quality.identity` (local, free): inputs `file`, `refs`. In the CPU suite (`src/cpu/suite.ts`, area `quality`), so
  `settings.cpu` can send it to gen-cpu. **The service image needs `opencv-python-headless` and the face models**; the
  build context now carries `post/quality/*.py` (`tools/cpu-cloudrun/lib.mjs`). Not deployed (J's).
- `quality.checklist` (anthropic lane): inputs `file`, `refs`; params `brief`, `questions`.
- `quality.assess` (anthropic lane): inputs `file`, `identityRefs`, `styleRefs`; params `brief`, `style`, `questions`,
  `thresholds`. Claude's calls are reported as usage.

**HTTP:** `POST /v1/quality/assess {brief, asset, kind?, identityRefs?: [asset], style?: {refs?: [asset], words?}, questions?, thresholds?}`
answers the report and its Claude cost, synchronously (admins only). Other parts of Gen call `assess()` directly.

**Mock:** `HAWKESGEN_QUALITY_MOCK=1`, `setQualityMock(true)` or `withQualityMock(work)` (scoped to that work only)
gives the same shapes with no Python, ffmpeg or Claude: scores from a hash of the file, so a run repeats exactly.
Tests swap Claude with `setQualityAsk(stub)`.

---

## Gen Bench

**Briefs:** `src/bench/briefs.json`, 30 of them, each with an id, a `version` (scores compare across runs of the same
version), the kind scored, the app path (`via`), the cast in it, the look, and a rough `plan` for the price. They cover
the roadmap's list (a character sheet, a talking close-up, a two-person argument over 5 shots, a poster, a skybox, a
prop and a rigged character, a 30-second trailer, a 3-shot scene with a recurring prop) and more: expressions, a group
of four, hands, readable text, a product still, a creature, a texture, time of day, fast action, continuing a shot, a
set piece, voice lines, two voices, sound effects, ambience, theme music, the same look on a new subject, a thumbnail.

**The cast:** four characters (Maya, Brann, Iko, Captain Vell) with fixed descriptions. Identity is scored against
their reference pictures: set by asset id in the Bench tab (`PUT /v1/bench/cast/:id`), else a real run makes one
portrait each first (`image.generate` with `reuse` and a fixed key, project `genbench-cast`, kept for later runs).

**A real run** (`src/bench/runner.ts`), per brief, in its own project `genbench-<run>-<brief>`:
1. a scene of the brief's kind through `POST /v1/scenes`;
2. the brief, with each character's description and reference asset and the look in words, sent to that scene's AI:
   the AI editor (`/v1/editor/projects/:id/assistant`) for video, image and audio, the character AI
   (`/v1/scenes/:id/assistant`) for characters; anything proposed over the auto limit is applied (the run's price was
   accepted); `make` briefs submit `make.checked` when this Gen has it, else the tool `route()` names;
3. it waits for the project's jobs (an hour at most), then scores each output of the brief's kind (the last 6) with
   `assess`, cost and time spread over them.
Calls go to this Gen over HTTP with its own token (`SELF_TOKEN`), as the app's would.

**A mock run** does the same plumbing with stand-ins: small real files made in Node (`src/bench/synth.ts`: a PNG, a
WAV, a GLB box; a "video" is its poster frame) filed as assets in `genbench-mock`, scored by the mock checks. Free,
offline, about 4 seconds for all 30 briefs. CI and the other sessions use it.

**The market baseline:** upload a file made elsewhere for a brief (Bench tab > "Add a baseline output", or
`POST /v1/bench/baseline {brief, asset, label}`): it lands in a baseline run per label ("Kling 3 + Nano Banana") and is
scored exactly like Gen's. Every run's view shows each brief's baseline outputs beside Gen's, with who wins per score.

**J's ratings:** 1-5 buttons on every scored output (`POST /v1/bench/results/:id/rate`, `rating: null` clears).
`GET /v1/bench` reports, per score, Spearman's rank correlation with the ratings, and for pass the share where it
matches "rated 4 or 5". A score is **trusted** at 0.5 or more over 10 or more ratings, and marked **disagrees** below:
fix that score before anyone believes it (roadmap risk "judges that are wrong").

**Tables** (`src/bench/store.ts`): `bench_runs`, `bench_results` (one per output: the report and its flattened scores,
credits, cost, seconds), `bench_ratings`, `bench_cast`. A run going when Gen restarts is marked failed.

**The Bench tab** (`dashboard/bench.js`, the admin dashboard): the trend per score (real runs; mock runs until there is
one), the runs, each run's outputs side by side with the baseline (media, pass, brief share, face distance and spread,
look, cost, every question with its answer and reason, faults, the fix), the rating buttons, the agreement table, the
cast, the baselines, and "Mock run" / "Real run…" (owner only: shows the estimate first and sends the price back as
`confirmCost`; a stale price gets 409 with the new one).

**Routes** (admins only; listed in `OPS_ROUTES`, so customers get 403):

| Route | What |
|---|---|
| `GET /v1/bench` | briefs, cast, runs with summaries, agreement, how many rated |
| `GET /v1/bench/runs/:id` | results (with `assetKind`), the baseline's results for the same briefs, Gen vs baseline per brief |
| `POST /v1/bench/estimate {briefs?}` | a real run's price: GPU from `src/estimate.ts`, Claude from typical sizes |
| `POST /v1/bench/runs {mode, briefs?, label?, confirmCost?}` | mock: any admin; real: the owner, with `confirmCost` = the estimate's total |
| `POST /v1/bench/runs/:id/cancel` | stops after the brief in hand |
| `POST /v1/bench/baseline {brief, asset, label}` | a baseline output |
| `POST /v1/bench/results/:id/rate {rating, note?}` | J's rating |
| `PUT /v1/bench/cast/:id {assets}` | a character's references |
| `POST /v1/quality/assess` | above |

**CLI:** `hawkesgen bench` (the runs), `hawkesgen bench status <run>` (each output's verdict and fix),
`hawkesgen bench run --mock [--briefs a,b]`, `hawkesgen bench run` (prints the price, asks, then runs).

---

## Verified (2026-10-31, on J's PC, no GPU)

- `npm run typecheck` and `npm test` pass (the new `test/quality.test.ts`, `test/bench.test.ts`, and a case in
  `test/tenancy.test.ts`).
- **Identity on real photos**, insightface's own sample pictures (a face cut from its group photo as the reference):
  an altered copy of that face (mirrored, smaller, darker, washed out, JPEG 60) **0.060**; the same face found among the
  six in the group photo **0.022** (the best match is taken); a different person **1.04**. The package and the
  direct-ONNX path agree (0.0604 and 0.0604; 1.0444 and 1.0445). A 4-second clip of the group photo then the altered
  face (squashed to 640x448) sampled 8 frames through ffmpeg: 0.028 on the group frames, 0.237 on the squashed ones
  (stretching a face moves it, as it should), mean 0.13, spread 0.10, 28 faces. The clip's 50 frames: none blank, no
  flicker. The first run downloads the models (about a minute). (Pictures from other Hawkes projects were not used.)
- **A real `assess`** on the group photo (brief: six friends playing poker under a hanging lamp; the look: a warm,
  faded 1990s magazine photo): 8 questions all answered yes with sensible reasons ("counted: left woman, dark-haired
  woman, …"), no faults, look 0.9, identity found 6 faces and matched the reference, pass. 4 Claude calls on the Max
  plan, $0, about 2 minutes (the Claude Code path is slow to start; the API path is faster).
- **A mock run end to end**: all 30 briefs, 33 outputs filed, scored, summarised, rated, a baseline added and compared;
  the Bench tab draws it (checked in a browser against this worktree on a spare port: the trend, the runs, the side-by-side cards with every answer and fix, 3 models, 5 sounds and 25 pictures rendering, a rating saved).

## Left

- **Real runs haven't run** (no money spent). The first one is J's call (below).
- **Stage briefs:** the director films in the browser today, so no brief goes through the stage yet; the multi-shot
  briefs go through the AI editor. When the showrunner's server-side productions land (Phase 4), point those briefs at
  them.
- **Whole cuts:** a trailer's AI editor run leaves clips on a timeline; the export is in the browser, so the bench scores
  the clips, not the cut. Score the export once a server-side render exists (Phase 5, `video.compose`).
- **3D and sound by looking:** the checklist skips them. Next: render a GLB's turntable (the LOD previews or
  `blender.character preview`) and judge those frames; transcribe voice lines (`src/audio/verify.ts` word error rate).
- **The CPU service image:** add `opencv-python-headless` to `server/cpu-cloudrun/requirements.txt` and bake the face
  models (`python post/quality/identity.py` once at build with any two pictures, or copy `~/.insightface`) before
  sending `quality.identity` there. Until then keep it local (the default).
- **Calibration:** the thresholds (0.15, 0.85, 0.7) come from the roadmap; tune them against J's ratings once there are
  enough (the agreement table says when).
- **A schedule:** run the mock on every change (cheap) and a real run weekly, once J approves the spend.

## Live runs for J to approve

Prices from `POST /v1/bench/estimate` on this PC's job history, which is thin for some tools: re-run the estimate on
beta before approving (the Bench tab does it each time).

| Run | What | About |
|---|---|---|
| Cast portraits | 4 × `image.generate` (kept and reused by later runs) | under $0.05 GPU |
| One cheap brief per kind | `poster`, `sfx-door`, `prop-lantern`, `talking-closeup` | $1.18 ($0.62 GPU, $0.56 Claude); $2.40 with the fleet's idle tail |
| The whole bench | 30 briefs, about 45 outputs, 1.9 GPU hours, Claude for the turns and the checks | $8.44 ($3.52 GPU, $4.92 Claude); about $14 with the idle tail |
| The market baseline | the same 30 briefs made elsewhere (Kling, Seedance, Runway, Nano Banana) by J or a contractor | their subscriptions, outside Gen |

Priced 2026-10-31 with `estimateRun` on a copy of J's local job history: `image.generate` from its own past jobs, most
video, voice, 3D and music tools from their own guesses (no history here yet), so treat the GPU side as a floor and
re-price on beta first. The AI may also make more than each brief's `plan` (extra takes). The Claude figure is API
pricing: on a Claude login it is $0.
