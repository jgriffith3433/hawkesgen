# Worlds: the layer above scenes

*2026-10-31. Phase 3 and the world parts of Phase 6 of `docs/worlds-roadmap.md`. Branch `claude/worlds-layer-d855b3`.*

A person describes a world in a sentence (or drops a mood board); the AI proposes it (its look, three characters, two
places, a story idea) and they keep what they like. The world's home shows its look and its members as cards. Every
job made inside the world carries its look without anyone asking, and a story keeps track of who wears and holds what
at every shot.

## What's built

### The kinds (`src/worldkinds.ts`)

Registered like the character kind (`registerKind`), plug and play by scene id. `KIND_IDS` in `src/scenes.ts` now lists
them, so `/v1/scenes` makes, lists, opens, saves, renders and duplicates them like any scene.

| Kind | Document |
|---|---|
| **world** | `title`, `logline`, `tone`, `rules` (the canon), `history`, `factions`, **`look`** (`style`, `negative`, `palette`, `board`, `grade`: `WorldLook` in `src/worlds.ts`), `board` (the style board's pictures as elements, so the AI can make them; `look.board` is their files), `members` (scene ids), `notes` |
| **place** | `description`, `panorama` (360°), `views` (named), `set` (a 3D model), `variants` (`kind` time or weather, named), `ambience` (a sound), `notes` |
| **prop** | `description`, `sheet`, `views`, `model`, `owner` (a character id), `notes` |
| **story** | `level` story / series / episode, `parent` (an episode's series), `number`, `logline`, `beats`, `script` (scenes: heading, place, time, action, lines by character id), `shots` (scene, title, what, framing, place, cast, props, `stage`: the stage shot made from it), `continuity` (events), `notes`. Each shot carries `state`, read-only |

- File-holding elements follow `src/scenekinds.ts`: `asset`, or `pending` (a job), `failed`, `gen` (the AI's mark). The
  kinds' `resolve` fills them in when jobs end; `KindDef.elements` (new, optional) hands them to `applyScene`, so the
  AI's `gen` marks and `el:` inputs work on the new kinds unchanged.
- **Any scene names its world with `doc.world`.** `registerKind` now wraps every kind's `normalize` so `world` survives
  whatever the kind's own normalizer knows (stage, timelines, character). The director's `createShot`/`saveShot`, which
  normalize before the store, carry it too.
- A world's members are the scenes it lists **and** every scene of the same project that names it.

### `src/worlds.ts` (the contract, implemented)

- `worldContext(project, worldId)`: the world's look and canon, and each character's, place's and prop's description and
  references. Characters through `identityPack` (`src/identity.ts`: the sheet first); places: panorama, views, variants;
  props: sheet, views. Another project's world is `null`.
- `withWorld(project, sceneDoc, tool, params, inputs)` / `applyLook(project, worldId, ...)`: the style line appended to
  `prompt` (not doubled when it's there), the negative to `negative`, the style board as `references` where the tool takes
  them and none were given (up to the tool's max). Only `image.*` and `video.*` tools; sound, 3D and the rest are left
  alone. Returns `labels.world`.
- **Inheritance on every job** (`inheritWorld`, registered with the new `onSubmit` hook in `src/jobs.ts`
  `prepareSubmit`, after presets): a job whose labels name the scene it came from (`scene`, else `editor`, else
  `director`; `labels.world` may also name a scene or world directly) and whose scene is in a world gets the look, and
  `labels.world` records which. `labels.world: "off"` turns it off. The scene must be in the job's own project.
  - The app sends `labels.scene` (the scene in front) on every job it runs (`media.js runJob`); Create's "More settings"
    has **Use the world's look** (on), which sends `world: "off"` when unticked.
  - The scene AIs (`/v1/scenes/:id/assistant`) already label jobs with `scene`; the world packs label each job with its
    own scene.
- `continuityAt(story, shotIndex)` (in `worldkinds.ts`, re-exported): folds the story's continuity events up to that
  shot. `wears` replaces, `injury`/`heal`, `holds`/`drops` (a prop is in one hand at a time), `at` (a place), `time` (else
  the script scene's time). Returns `{ time, people: { id: { wears, injuries, holds, at } }, props: { id: holder } }`.
  Every shot of a normalized story carries it as `state`, so the showrunner, the checks and "Make this shot" read it.
- `canonCheck(world, text, { project?, ask? })`: Claude lists the clear breaks of the world's rules (quote, why, the
  smallest fix); only the world's own rules are kept. No rules or no text: no call. `project` runs it on that project's
  own AI like every customer call; `ask` swaps the model (tests).

### The AIs (`src/worldai.ts`)

On the `src/sceneai.ts` pattern (the whole document back, jobs with `gen` marks, `applyScene`, proposals over
`autoCredits`), plus `create`: new scenes the answer proposes, made in the world (a world lists them as members).
`DOCS.character` is untouched (gen-identity's).

- **world**: the bible and the look; proposes three characters, two places and a story when it's new.
- **place / prop**: write it and make its pack.
- **story**: top down (logline, beats, script, shot list), the layer above kept unless asked; keeps continuity; sees the
  world's rules and its characters, places and props by id. Planned at high effort.
- Each turn sees the scene's world (`worldContext`): rules, look, members.
- **Start a world**: `startWorld(project, idea, board)` (the mood board's pictures go to Claude as images and become the
  world's style board), `parseProposal`, `keepWorld(project, proposal, keep)`.
- **Packs**: `placePackPlan` (panorama, a wide view, a 20-second ambience), `propPackPlan` (the sheet),
  `worldPackPlan` (two style-board pictures), `characterPackPlan` (front and portrait). `packScenes` prices them and runs
  them only when confirmed (or under the auto limit). **`placePackPlan` and `propPackPlan` are my stand-ins**, in
  `worldai.ts` under the names the brief gives; when gen-identity lands its own in `src/identity.ts`, `packPlan` should
  call those and these go.
- `useAsk(fn)` swaps the model call (the tests' mock).

### Routes (`src/worldroutes.ts`, one dispatch line in `src/api.ts`)

| Route | |
|---|---|
| `POST /v1/worlds/start {idea, board?, project?}` | A proposed world, nothing saved |
| `POST /v1/worlds/keep {proposal, keep?, make?, confirm?}` | The kept parts as scenes in the world; `make` prices their packs (runs them with `confirm`) |
| `GET /v1/worlds/:id` | The home: the world and its members by kind, each with its picture, a line about it, and whether it's waiting on jobs |
| `GET /v1/worlds/:id/context` | `worldContext` |
| `POST /v1/worlds/:id/canon {text}` | The rules the text breaks |
| `POST /v1/worlds/:id/packs {confirm?}` | Pictures for the world and every member missing them |
| `POST /v1/worlds/pack/:sceneId {confirm?}` | The same for one scene |
| `POST /v1/stories/:id/shots/:shotId/stage` | "Make this shot": a stage from the shot (its place's panorama as the sky, the cast spaced on the ground, the scene's lines by those characters, the place, time and continuity in the look, a lens from the framing), in the world, linked back as the shot's `stage`; made once |
| `POST /v1/scenes/:id/assistant`, `/apply` | For world, place, prop and story scenes (the other kinds stay in `src/api.ts`) |

House AI rules as the other assistants: a Gen account without its own Claude pays each turn in credits.

### The app (`dashboard/gen/`)

- `world.js`: **the world's home** (the look as a board with palette and style line; its rules; characters, places,
  props and stories as cards: tap to open, drag onto a stage or the timeline, a menu with "Use in a new shot" and "Make
  its pictures"; "Add" per section). Drops explain themselves: a picture joins the look, a character/place/prop/story
  joins the world, anything else says why not. The bar's action makes the missing pictures, priced. Knobs (style line,
  never-show, palette, grade, adding rules, history) under a closed **Fine-tune**.
- **Start a world** (`startWorld()` in `world.js`): a sentence or a dropped mood board (Media tiles, scenes' pictures,
  files from the computer); then the proposal as cards (the look, characters, places, props, the story) to keep, edit in
  place or throw away; "Make this world" makes it, opens its home and asks once, with the price, whether to make its
  pictures. It's the first starter under "+", in the palette, on every empty center ("Or start from an idea"), and opens
  once for a new account right after the tour (`tour.js` emits `tourDone`) when they have no world yet.
- `place.js`, `prop.js`: the pack as tiles (making, failed, empty with what to do), "Make its pack", "Use in a new shot"
  (a place: a stage with its panorama as the sky), a prop's 3D model the character way; drops explained (a 2:1 picture
  becomes the panorama, a GLB the set or model, a sound the ambience, a character a prop's owner).
- `story.js`: beats, script and shots as tabs; "Write the next part" asks the story AI for the next missing layer; each
  shot shows its place, cast, props and its state (continuity) and has **Make this shot** / **Open the shot**.
  Characters, places and props dropped on a shot join it.
- `worldbits.js` (shared), `worlds.css` (its own stylesheet). The AI pane knows the new kinds (World AI, Place AI, Prop
  AI, Story AI, with tips); the Scenes list filters World, Place and Story.

## What's verified

- `npm run typecheck`: clean.
- `test/worlds.test.ts` (11 tests): each kind normalized; `world` kept on any kind (character, stage); continuity at each
  shot (clothes, injuries healed, a prop changing hands, time from the script); `worldContext` (listed and naming
  members, identity-pack refs, another project's never); inheritance into a job's params and inputs (style, negative,
  board as references, off, sound left alone, no world, another project's scene); the canon check (mocked); the world AI's
  answer applied (board made, members created in the world, over the limit a proposal); the story AI's answer (layer
  kept, continuity into state; it sees the rules and the cast by id) and the place/prop pack plans; Start a world from a
  sentence through keep and the priced packs (12 jobs, each labelled with its scene); "Make this shot"; the routes
  (every kind, start, keep, home, context, the story shot, the world AI turn; another account gets 404).
- `test/saas-ui.test.ts`: the new modules' ids are on the page.
- In the app, on a local Gen (no keys, nothing spent): the world home, the story's shots with their state, "Make this
  shot" opening a stage with the cast, the line on the timeline and the look written; Start a world's sheet, its
  proposal cards (the start call stubbed in the page) and "Make this world" opening the new world and pricing its
  pictures (14 for 94 credits).
- Full `npm test`: everything passes except the 4 `test/bootstrap.test.ts` dry runs, which time out at 60 s on this
  Windows machine (they run `server/bootstrap.sh` under bash) and touch nothing here.

## What's left

- **Series and episodes**: an episode names its series (`parent`), but the series editor doesn't list its episodes yet,
  and nothing makes the next episode from the series.
- **Continuity checks on outputs**: every shot has its state; checking a finished frame against it belongs to the
  quality checks (gen-bench's `assess`) and the showrunner.
- **The grade** is stored (`look.grade.params`) and editable; applying it to finished shots is gen-finishing's.
- **Places on a stage**: dropping a place onto a stage doesn't set its sky yet (`director.js` explains drops of known
  kinds only). "Use in a new shot" does it.
- **Inheritance inside `asset.make` steps**: a chain gets the look on its own params only, not on each step's.
- The world AI's `create` makes scenes but doesn't start their packs; the person presses "Make the pictures".
- `placePackPlan` / `propPackPlan` move to gen-identity's versions when they land.

## Live runs to approve (priced)

Nothing here ran on a GPU or a paid model. What I'd run on beta, with J's OK:

| Run | What | Cost (estimate) |
|---|---|---|
| Start a world, 3 times | The world AI from a sentence (Claude, high effort) | about $0.10 a world, ~$0.30 |
| Its pictures, once | 2 board pictures, 3 × (front + portrait), 2 × (panorama + wide view + ambience): 14 jobs, quoted locally at 94 credits | about $0.94 |
| The story AI, one pilot | logline → beats → script → shot list, 4 turns at high effort | about $0.40 |
| Make 3 shots and film them | 3 stage shots filmed the usual way (`image.control` + `video.control`) with the world's look | price with `POST /v1/estimate` first; roughly $1 to $2 |
| Canon check, 5 scripts | Claude, low effort | under $0.05 |

Total about $3 to $4, plus the filming quote.

## Files outside my area

Small, additive edits to shared files:
- `src/scenes.ts`: the four kinds in `KIND_IDS`; `KindDef.elements`; `registerKind` keeps `doc.world` for every kind.
- `src/scenekinds.ts` `fileElements`: falls back to the kind's `elements` (one line).
- `src/jobs.ts`: `onSubmit` hooks, run in `prepareSubmit` after presets (5 lines).
- `src/api.ts`: one import and one dispatch line; the "kind:" error lists every kind.
- `src/director.ts` `createShot`, `saveShot`: carry `world` (2 lines).
- `dashboard/gen/scenes.js` (the four kinds in `KINDS`, the empty-timeline words), `starters.js` (Start a world),
  `ai.js` (the kinds' AI names, tips and empty words), `gen.js` (four imports), `tour.js` (`tourDone`), `media.js`
  (`runJob` sends the front scene and extra labels), `studio.js` (Use the world's look), `index.html` (the stylesheet,
  Scenes filter chips), `test/saas-ui.test.ts` (the new modules).
