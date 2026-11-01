# The showrunner

*2026-10-31. Phase 4 of `docs/worlds-roadmap.md`: one AI that runs the show. Code in `src/showrunner/`, the app's side in
`dashboard/gen/ai.js`, `showrunner.js`, `review.js` and `memory.js`, tests in `test/showrunner.test.ts`.*

Before this, the AI pane talked to three separate assistants (the AI editor, the AI director, the character AI), each
one Claude call at medium effort that answered in JSON and never saw what it made. Now every message goes to one entry,
and the showrunner decides who answers.

## What it does

1. **One entry, with roles.** `POST /v1/showrunner/turn` takes the conversation, the scene in front, the selection and
   the world. A first step (`classify.ts`, words only, no Claude call) decides:
   - **a small edit** ("make this slow motion", "move the camera behind her"): handed to the scene's own assistant
     through its own route (`/v1/editor/projects/:id/assistant`, `/v1/director/shots/:id/assistant`,
     `/v1/scenes/:id/assistant`), as the same caller. The answer is that route's own answer plus `role`, so the app
     handles it as before and it costs exactly what it did.
   - **a production** ("a 5-minute pilot about smugglers on a frozen moon", "a trailer for my world", "a new character
     for this story"): the planner. With no scene open, any whole idea of six words or more is planned too.
   Roles: `showrunner` for productions; small edits answer as `editor` (video), `director` (stage), `art director`
   (image, character) or `sound` (audio). The AI pane shows the role above each answer and keeps its head label.
2. **The planner, top down** (`plan.ts`): one Claude call at high effort writes the whole production as text: the
   world (only when there isn't one), the characters (each with a 50 to 80 word description written once and pasted
   unchanged into every shot), the places, the story (logline, beats, script) and the shot list (type, place, cast,
   seconds, camera angle around the action line, framing, move, action, lines). It sees the world (`worldContext`),
   the person's characters (their `identityPack` descriptions), the house voices and the account's memory.
   - **Checked twice:** `lintPlan` checks what a program can (the 180° rule between consecutive shots that share two
     people in one place, lines said by someone in the shot, lines that fit their shot, the total against the length
     asked for, canon words nobody may say), then a critique call at high effort (the script supervisor and editor:
     continuity, pacing, canon, concrete descriptions) fixes the plan; if the lint still finds something, one more
     round. What's left is shown on the card as "Worth a look".
   - Every layer is text and is approved on the card before anything costs GPU.
3. **The approval card** (`steps.ts cardFor`, `showrunner.js`): counts per kind (world, characters, places, shots,
   pictures, clips, voice lines, music, the cut), about how long (machine minutes / 3 running at once), the price
   (the sum of each step's quote: `make.checked`'s own up-front price when that tool exists, else the routed tool's
   `quoteJobCredits`), and the most the review may add for re-takes (`fixCredits`, 25% of the shots' price). The plan
   itself is under "The plan" (closed). Buttons: **Approve**, **Change** (the next message changes this plan, keeping
   its keys), **Not now**. A production at or under the auto limit (40 credits, both numbers) starts at once.
4. **Productions on the server** (`production.ts`, table `productions`): an approved plan is a list of steps (each a
   job or a scene write) that name what they wait for and take earlier steps' files (`$step:<id>`). The runner starts
   what's ready, collects finished jobs, retries a failed job once, skips what depended on a failure (the cut and the
   review go on with what exists), and saves after every change: nothing lives only in memory, so a restart carries on
   (`startRunner`: job events, a 15 s timer, and a pass 2 s after start). Progress goes out on `/v1/events` (event
   `production`), the last one with a notice ("“The Keeper” is ready.") that the app toasts with Open the cut.
   - **Steps:** world, characters (scene, then a front picture), places (a wide view), the story, the stage shots in a
     sequence (the director's shot docs: cast linked to the character scenes), per shot the voice lines, the first
     frame and the shot, the score, the cut (a video scene: shots on Video in order, each line on Voice at its moment,
     the score on Music at 60%), then the review.
   - **Every generating step is a MakeRequest** (`src/make/index.ts`). When this Gen has `make.checked` (gen-make's
     checked making loop), the step is submitted as `make.checked` with the MakeRequest (minus `project`) as params and
     its best take is filed (`result.asset`). When it doesn't (it isn't on this branch), the step goes to the routed tool
     (`route()`), with pinned tools where the server path needs them. Both are tested.
   - **Filming without the browser:** a shot's first frame is `image.edit` on the place's wide view with the cast's
     pictures as references (up to 3; `image.generate` when there are none), then by what the shot is: dialogue is
     `video.talk` on the first frame with its first line, two people with pictures are `video.scene` (both pictures and
     the frame as the set), everything else is `video.i2v` from the first frame (the stage's `video.control` needs the
     browser's depth render). **With the page open**, it can tell the production (`/browser`) and claim action shots
     (`/claim`, `/finish` with the filmed file); a claimed shot not brought back in 15 minutes is filmed here.
   - **Pause** (nothing new starts), **Resume**, **Stop**: running jobs are cancelled (`src/jobs.ts` refunds them by its
     own rules) and steps that never started were never charged: credits are reserved per job as it's submitted, so
     the card's total is what an uninterrupted run costs, not a hold. Approve refuses (402) when the account's credits
     don't cover the card.
5. **It sees its work** (`vision.ts`): a turn whose words point at results ("fix the second shot", "her face changed",
   "shot 3 looks off") gets pictures: three frames of the shot it names (by position or the selection), or a contact
   sheet of every shot's middle frame. For small edits (whose assistants take words), the showrunner looks first and
   adds what it saw to the person's message ("What the showrunner saw in shot 2: her coat turns red..."); the answer
   says `looked`. **After a production's cut**, the review step checks each shot with `assess` (`src/quality`: identity
   against the characters' pictures, the brief, faults, the world's style) and re-takes the failures with the check's
   fix added, within the fix allowance, then recuts.
6. **Memory per account** (`memory.ts`, table `showrunner_memory`, keyed by the account's own project, never another's):
   the looks they approved, the average shot length of their cuts, changes they ask for again and again (darker,
   faster cuts, closer framing... counted from their messages and kept fixes), characters across productions, and their
   own notes. Only what's settled (asked twice, in two productions) goes into the few lines every plan gets. Account >
   Your AI > "What your AI remembers" shows it, removes any part, turns learning off, or forgets everything.
7. **Review mode** (`review.js`, `POST /v1/showrunner/review`): on a cut the showrunner made, play it, Mark this moment,
   drag a box on the frame if it helps, and say what's wrong. The showrunner gets that frame and the shot as planned,
   writes what to add to the shot's description and whether the picture itself must change (then the first frame is
   redone too), and starts a **fix production** (the same machinery, priced; over the auto limit it asks). When it's
   done, before and after play side by side: **Keep** puts the new take in the cut, **Undo** leaves (or puts back) the old.

## How to use it

- In the app: type anything in the AI pane. "a 60-second teaser about a lighthouse keeper and a sea creature" brings
  the card; Approve; the card follows the production (you can close the page); Open the cut; Review it.
- Over the API: `docs/api.md`, "The showrunner".
- Turning the runner off in a process (tests): `HAWKESGEN_SHOWRUNNER_RUNNER=0`.

## Decisions (made without J, to revisit)

- **Classifying by words, not a model.** Free, instant and the same every time; a small edit keeps its old cost. The
  cost is misses on unusual phrasing; "Change" and the planner's own `say` recover. A cheap model could replace it later.
- **Small edits go through the existing routes in-process** (`routes.ts delegate`): the assistants' internals,
  charging and proposals stay exactly as they were, and their owners (gen-identity) keep their files.
- **The card's price is the sum of per-step quotes**, charged per job as it runs, plus a stated fix allowance. The
  alternative (reserving the whole total at approval) would lock a person's credits for an hour of work.
- **The story, world and place kinds are gen-worlds'.** When a kind isn't registered (this branch), the world stays in
  the production record, places are only their pictures, and the story is kept in `out.storyDoc` in the story kind's
  shape (`level`, `logline`, `beats`, `script`, `shots`) to file once the kind lands. With the kinds present, the scenes
  are made and named with `doc.world`.
- **Stage shots are written from the plan**, not through `directorTurn` per shot (one call per shot would multiply the
  planning cost for no new information; the critique already checks the blocking rules).
- **Planning turns on the house AI are charged** like the AI editor's (`turnCredits` per call: the plan and each
  critique round).

## Verified

- `npm run typecheck`: clean.
- `test/showrunner.test.ts` (13 tests, every outside call mocked through `deps.ts setDeps`): classifying requests;
  `lintPlan`'s four rules; a plan written at high effort that passes its critique (the crossing fixed); the card's counts
  and price, and `make.checked`'s worst case; **the done criterion**: "a 60-second teaser about a lighthouse keeper and a
  sea creature" gives a plan, a card over the auto limit with nothing spent, then an approved production that runs
  through a simulated restart to a cut video scene (6 shots in order, the line and the score, characters with front
  pictures, stage shots with renders); the `make.checked` fallback both ways; the review pass re-taking a failing shot
  and recutting; pause, resume and cancel; review mode replacing one shot with Keep and Undo; small edits delegated
  (no extra AI call) and the look-first note; memory learned, summarised, edited and isolated; the routes as two
  accounts (delegation through the real editor route, productions and memory private, 402 on approve without credits).
- Not verified: the app in a browser (the front end passes `node --check` and `test/saas-ui.test.ts`), and any live
  Claude or GPU run.

## What's left

- **The director's stage claiming shots** (`director.js`): the server side (`/browser`, `/claim`, `/finish`) is built
  and tested by hand only; the stage's "Film it" doesn't call it yet, so every production films on the server.
- **Server-side reference rendering of 3D cast** (gen-identity's camera-render reference) once it exists: the first
  frame should take it as image 1.
- **`assess` is a placeholder** until gen-bench lands: the review pass passes everything until then.
- **Sound beyond lines and score** (room tone, foley, the mix) and the export to a file are gen-finishing's; the cut is a
  video scene the app exports as today.
- Planning a whole series (episodes as productions under a series) once gen-worlds' series kind exists.
- A "Productions" list in the app (the route exists; cards live in the conversation they were made in).

## Live runs to approve (priced, nothing run)

Prices from this Gen's own `quoteJobCredits` (no job history yet, so tool guesses and floors; 1 credit = 1 cent).

| Run | What | Credits (customer price) | Raw cost to Gen |
|---|---|---|---|
| **A 1-minute production end to end** | 15 shots of 4 s: 3 pictures (2 characters, 1 place), 15 first frames, 11 shots from the first frame, 3 dialogue shots, 1 two-person shot, 3 voice lines, the score; the cut and review | **849** (+ up to 175 for re-takes): image.generate 15, image.edit 75, video.i2v 440, video.talk 120, video.scene 140, audio.voice 39, audio.music 20 | about $2.80 of GPU at the 3x margin, plus about $0.30 of Claude (a plan and a critique at high effort) |
| The same through `make.checked` | once gen-make lands: its up-front worst case per step | quote then | |
| A review-mode fix | one first frame and one shot | about 45 | about $0.15 |
| The planner alone, 10 briefs | plan + critique, no GPU (checks the plans against J's eye) | 0 GPU; about 20 credits of house AI | about $3 of Claude |

Suggested order: the planner alone first (cheap, shows whether the plans are good), then one 1-minute production on
beta with J watching the card, then a review-mode fix on its cut.
