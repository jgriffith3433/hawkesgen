# Worlds: the roadmap

*2026-10-31. A plan, not a record of what's built (`AGENTS.md` is that). J's direction, in J's words: "use AI to do most of
the heavy lifting for you and hide most advanced settings unless you need them to keep it sleek" and "It needs to be
better than anything on the market, or no one will use it."*

**The goal:** a person describes a world, and Gen's AI builds it and everything in it: its look, places, characters,
props, stories, episodes and whole shows. Every picture, clip, model and sound it hands back is on-model, on-style and
free of obvious faults, and the person never has to touch a setting to get there.

**Why Gen can win:** other tools make clips. Gen already has what productions need around the clip: a 3D stage that
pins down blocking and the camera, characters that carry their look, voice and model into every shot, a library where
every take keeps its recipe, a timeline, sound, 3D, and an AI that edits. What's missing is the layer that makes the
results *reliably good and consistent*, and a world above the scenes to hold it all together.

---

## Where it stands today

| Area | What exists | What's missing |
|---|---|---|
| **Scenes** (`src/scenes.ts`) | Kinds: video, image, audio (timelines), stage (the director), character. Scenes plug into each other. | No world, place, prop, story or episode kinds. Nothing above a scene ties a body of work together. |
| **Characters** (`src/scenekinds.ts`) | Description, height, voice, 3D model, pictures by role (front, portrait, sheet, reference). | **Shots never see the pictures.** `filmPrompts` (`src/director.ts`) passes names and descriptions only, so every first frame redraws the face. No locked description, no LoRA, no identity check. |
| **Art direction** | `presets/<project>.json` for J's products. In the app: three style chips in Create (`studio.js` `STYLES`). | No style a person's whole world inherits. Each job is styled on its own. |
| **Models** (`workflows/`, `src/tools/`) | About 70 tools, including reference-to-video: `video.scene`, `video.keyframes`, `video.extend` (MiniMax H3), `video.perform` (LTX ID-LoRA), `video.replace`, `video.kling` (Kling O3) and `video.seedance` (Seedance 2.5) through partner nodes. | The director films with `image.control` then `video.control` only. Nothing picks the right model for each shot. |
| **Quality machinery** | `asset.make` (best-of-N, picked by Claude against references and canon), `library.judge`, `film.gate`, craft notes for 35 tools (`knowledge/tools.json`). | The app's assistants don't use any of it. Most craft notes are unmeasured (`docs/art-playbook.md` rule 6). No numbers anywhere. |
| **The assistants** (`src/editor.ts`, `src/director.ts`, `src/sceneai.ts`) | Three separate AIs: editor, director, character. Each answers in JSON with edits and jobs. | One call at medium effort, and never shown what it made. No planning above the scene. No memory of what the person likes. |
| **Long work** | Filming a sequence works. | It runs in the browser, so the page must stay open ("Keep this page open until it's cut"). An episode can't render on its own. |
| **Measurement** | Studio playtests the app. | No set of briefs, no scores, no comparison with other products. "Better than the market" can't be checked. |

---

## Principles for everything below

1. **The AI does the work; the person decides.** People say what they want and approve the plan and its price. They
   never pick a model, a seed or a sampler. Every knob still exists under "Fine-tune" for those who want it.
2. **Nothing reaches the person unchecked.** Every result the AI makes passes its checks (identity, style, the brief,
   obvious faults) before it's shown. A failed check is a retry with a specific fix, not a bad result shown to the person.
3. **Previews are cheap; finals cost.** Try ideas at low resolution or with a fast render, check them, then spend on
   the one that passed.
4. **One source of truth per thing.** A character, place, prop or style is defined once in the world, and everything
   that shows it reads from there.
5. **Measured, not believed.** Every change to prompts, models or checks runs the test set before it ships.
6. **The price before the work.** Big jobs come as one card: what will be made, and what it costs.

---

## Phase 0: measure (do first; everything else depends on it)

**Gen Bench:** a fixed set of about 30 briefs that covers every kind of output:
- a character sheet
- a talking close-up
- a two-person argument across 5 shots
- a poster
- a skybox
- a prop and a rigged character
- a 30-second trailer
- a 3-shot scene with one recurring prop

Each brief runs through the real app path (the assistants, not hand-picked tools) on beta, on a schedule and after
every change, and is scored:

| Score | How |
|---|---|
| **Identity** | ArcFace cosine distance between each frame's face and the character's sheet, plus the spread across frames (insightface on the CPU suite). Published references: real video 0.084, Runway Gen-3 0.235 (Face Consistency Benchmark, arXiv 2505.11425). Target below 0.15. |
| **Following the brief** | The brief turned into yes/no questions ("Is she holding the lantern? Is it night?"). A vision model answers each one per output; the score is the share answered yes. |
| **Style** | Matches the world's look: Claude compares the output with the style board. |
| **Faults** | Extra fingers, melted faces, text garbage, flicker, broken meshes: one checklist per kind. |
| **Cost and time** | Credits and minutes per finished output, and per finished minute of video. |

- **Checked against J's eye:** J rates a sample each week. A score that disagrees with J gets fixed before anyone trusts it.
- **The market baseline:** the same briefs made the way a skilled creator would today (Kling, Seedance, Runway and
  Nano Banana-style chains, partly through the partner nodes Gen already has), scored the same way. "Better than
  anything on the market" becomes a number per brief.
- **Where it shows:** a Bench tab in `/admin` with the trend per score, and each run's outputs to look at.

**Size:** medium. Mostly CPU work and Claude calls; GPU spend is the runs themselves (price them with `hawkesgen_estimate`
and get J's OK).

---

## Phase 1: identity (the biggest visible win)

Make "the same character in every shot" true, then do the same for places and props.

1. **The identity pack.** Every character gets, made by the AI when the character is created:
   - a canonical sheet: front, three-quarter and full-body outfit, plus a few expressions, with nothing in their hands
     (props drift between angles)
   - a fixed description of 50 to 80 words, written once and pasted unchanged into every prompt that draws them
   - their voice, and their 3D model when asked for

   The sheet is approved once (the person can redo it), then locked. **Never let one shot set the next shot's look:**
   every shot reads from the sheet.
2. **References in every shot.** Everything that draws a character gets their sheet:
   - **First frames:** `image.control` / `image.edit` with the sheet as references. Trial Qwen-Image-Edit-2511 against
     FLUX.2 [dev] (up to 6 references) on Gen Bench and keep the winner.
   - **Reference-to-video** for shots that suit it (below, in routing).
   - **A reference from the shot's own camera:** when a character has a 3D model, render it from the shot camera in
     that pose and use the render as that shot's reference. This one is Gen's alone: reference-image tools have no model
     to render.
3. **LoRAs for characters that recur.** Once a character has enough approved pictures, train a LoRA without being asked
   (`lora.train`, now hidden from the app by `NOT_IN_CATALOG` in `src/editor.ts`) and draw them with `image.character`.
   The person sees only "Maya is now locked in".
4. **The identity check.** The ArcFace score from Phase 0 runs on every face that should be a known character. Below
   the bar, the result is retried, not shown.
5. **Places and props get packs too.** A place has a 360° panorama, key views and, optionally, a 3D set. A recurring prop
   has its own sheet. Both are attached the same way.

**Done when:** Gen Bench's identity score across a 20-shot scene is under the target, and beats the market baseline.

---

## Phase 2: checks, routing and cheap previews

One way of making things, which every AI action uses.

1. **The making loop** (one server-side pipeline, built on `asset.make`):
   1. plan
   2. a cheap preview, or several (low resolution, few frames, a fast 3D render)
   3. checks: the yes/no questions, identity, style, faults
   4. the final render of the preview that passed
   5. the same checks on the final
   6. shown to the person

   Failed checks feed a targeted fix (prompt, references, settings) for at most two retries within the request's budget,
   then an honest "this one needs you" with the best take.
2. **Model routing per shot.** The planner picks the model for what the shot is, with fallbacks:
   - a dialogue close-up: `video.perform` / `video.lipsync`
   - action staged on the stage: `video.control`
   - two characters sharing a scene: `video.scene` or `video.seedance`
   - continuing a shot: `video.extend`
   - a real performance recast: `video.replace`

   Routing rules live in data (like the craft notes), are tested on Gen Bench, and change as models do. The paid
   partner models are used where they win, priced honestly.
3. **A tournament for expensive shots.** For a hero shot, make three or four, compare them in pairs, and refine the
   winner (VISTA-style). Only where the extra cost is worth it.
4. **Learning.** Every pick, discard, redo and complaint ("too stiff", "her face changed") is recorded against the
   recipe. What repeats becomes a craft note marked measured, and a routing rule. The craft notes stop being guesses.

**Done when:** Gen Bench's brief and fault scores beat the market baseline, at a cost per finished minute J accepts.

---

## Phase 3: the world layer

New scene kinds above the scenes that exist, all plug-and-play like today's:

| Kind | Holds |
|---|---|
| **World** | The bible: tone, rules, history, factions; **the look** (a style board, palette, lens and lighting habits, and a color grade that every output inherits, replacing the style chips for app users); its characters, places, props and stories. |
| **Place** | Its pack (Phase 1), how it looks at each time of day and in each weather, its sounds. |
| **Prop** | Its sheet, its 3D model, who owns it. |
| **Story / Series / Episode** | A logline, then beats, then a script, then a shot list (written top down, which readers prefer roughly 2 to 1 over writing straight through). Episodes belong to a series; a series belongs to a world. |

- **Continuity tracking:** the state of things at every point in the story (who wears what, injuries, who holds which
  prop, time of day, where everyone is), tracked from the script and carried into every shot (the item-state idea from
  SCORE, arXiv 2503.23512). A shot that breaks continuity fails its checks.
- **Canon checks:** the world's rules ("the moon is always red", "no one says the founder's name") are checked on scripts
  and outputs, like Studio's canon.
- **Everything inherits:** a job made inside a world gets the world's look, characters' packs and canon without the
  person saying so.

---

## Phase 4: one AI that runs the show

The three assistants become one, with roles: showrunner and writer, art director, director, editor, sound.

- **Plan from the top down.** "A 5-minute pilot about smugglers on a frozen moon" becomes the world (if there isn't
  one), the characters' packs, the places, a beat sheet, a script, a shot list, then the shots, the cut, the sound.
  Each layer is approved quickly and cheaply before the next one costs anything.
- **One approval card per production:** what will be made, how long it takes, what it costs. Small edits under the
  automatic limit just happen, as now (`autoCredits`).
- **Productions run on the server.** An episode renders, checks, retries and cuts with the page closed, resumes after a
  restart, and tells the person when it's done (today's sequence filming needs the page open).
- **It sees its work.** Every turn can look at what it made: frames, contact sheets, the cut. "Fix the second shot" works
  because it has seen the second shot.
- **It remembers the person:** the looks they keep, the pacing they cut to, what they always change. That memory is
  stored per account, never shared.
- **Thinking matched to the job:** high effort and a critique pass for planning a story or a sequence (the 180° rule,
  continuity, pacing); medium for small edits.

---

## Phase 5: finishing

What separates a show from a pile of clips:

- **Sound:**
  - dialogue in each character's voice, with emotion from the script
  - music scored to the cut (tempo and hits on the edits)
  - room tone and foley per place
  - a mix that ducks music under dialogue
- **The cut:** pacing from the script's beats, coverage cut like an editor would, J-cuts and L-cuts.
- **Look:** one color grade per world across every shot, restore and upscale on the final cut only, film grain to taste.
- **Delivery:** titles, credits, captions, the aspect ratios each platform wants, episode thumbnails and trailers made
  from the episode.

---

## Phase 6: the sleek front

- **Start a world:** one sentence or a mood board, then the AI proposes the world (look, three characters, two places,
  a story idea) as cards to keep, change or throw away.
- **The world's home:** its characters, places, props, stories and episodes as visual cards, everything one click from
  being used.
- **Review mode:** watch the cut, tap a moment, say what's wrong; the AI fixes that moment and shows before and after.
- **Fine-tune stays hidden:** every advanced control is still one tap away for those who want it, never in the way.
- **Honest progress:** what's being made, what passed, what was retried and why, in plain words (no model names, as now:
  `lib.js plainWords`).

---

## Phase 7: what no one else can offer

- **Worlds become games.** A world's characters already have rigged 3D models, its places panoramas and sets, its props
  meshes: export them to Hawkes Games and Unity, playable, with multiplayer through Hawkes Net. No video tool can do this.
- **Shared universes:** collaborators in one world with roles; worlds published for others to watch, remix or build in.
- **Ownership:** every asset carries its recipe and history, so the person can show what they made and how.

---

## Order and size

| Step | Size | Needs |
|---|---|---|
| Phase 0: Gen Bench, scores, the market baseline | M | GPU budget for runs (J's OK) |
| Phase 1.1–1.2: identity pack, references in every shot | M | Phase 0 to prove it |
| Phase 1.3–1.5: LoRAs, identity check, place and prop packs | M | GPU for LoRA training |
| Phase 2: the making loop, routing, learning | L | Phases 0 and 1 |
| Phase 3: world, place, prop, story kinds; continuity | L | Phase 1 packs |
| Phase 4: one AI, server-side productions | L | Phases 2 and 3 |
| Phase 5: finishing | M | Phase 4 |
| Phase 6: the sleek front | M, alongside each phase | |
| Phase 7: games, sharing | L | Phase 3 |

**Start:** Phase 0 and Phase 1.1–1.2 together. The bench proves the identity work, and the identity work gives the bench
its first win to show.

## Risks

- **Cost:** checks and previews add Claude and GPU spend. Keep the checks cheap (CPU face scores, Sonnet with few
  frames) and measure cost per finished minute from day one.
- **Judges that are wrong:** a vision model can approve bad work. Check the judges against J's ratings before trusting
  them (Phase 0).
- **Open models trail closed ones:** route to the partner models where they win, and pass the cost through. Gen's
  advantage is everything around the model, not the model itself.
- **Likeness and IP:** a person's real face or a famous character as a reference needs rules before Phase 1 ships.
- **Scope:** each phase has to make the app better on its own; nothing waits for Phase 7 to be worth using.

## Sources (from the research behind this plan)

- Character consistency practice: [LTX](https://ltx.io/blog/how-to-maintain-character-consistency-in-ai-video), [scenema](https://scenema.ai/articles/how-to-keep-character-consistency-in-ai-video), [martini](https://martini.art/en/blog/how-to-build-consistent-ai-character), [magichour](https://magichour.ai/blog/how-to-keep-characters-consistent-in-ai-video)
- Pipelines: MovieAgent [arXiv 2503.07314](https://arxiv.org/abs/2503.07314), StoryAgent [arXiv 2411.04925](https://arxiv.org/html/2411.04925v2), AniMaker [arXiv 2506.10540](https://arxiv.org/pdf/2506.10540)
- Self-checking loops: VISTA [site](https://g-vista.github.io/), yes/no adherence checks [arXiv 2608.12290](https://arxiv.org/pdf/2608.12290)
- Identity scores: Face Consistency Benchmark [arXiv 2505.11425](https://arxiv.org/pdf/2505.11425)
- Story continuity: SCORE [arXiv 2503.23512](https://arxiv.org/html/2503.23512v5)
- Reference models: Phantom [runcomfy](https://www.runcomfy.com/comfyui-workflows/comfyui-phantom-subject-to-video), FLUX.2 multi-reference [BFL](https://help.bfl.ai/articles/6546682167-what-is-multi-reference-editing)
