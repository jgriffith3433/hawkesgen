# The making loop (`make.checked`)

Phase 2 of `docs/worlds-roadmap.md`: one way every AI action makes things, so nothing reaches the person unchecked.

```
POST /v1/jobs { "tool": "make.checked", "project": "u_…", "params": {
  "intent": "shot-dialogue",
  "brief": "Mira, close up, says \"We leave at dawn.\" Night, a lantern below her face.",
  "quality": "final",                      // draft | final | hero
  "inputs": { "image": "asset:a_…", "audio": "asset:a_…" },
  "refs": { "identity": ["<character scene id or asset id>"], "style": ["a_…"] },
  "world": "<world scene id>",
  "budgetCredits": 300
} }
```

The params are `MakeRequest` (`src/make/index.ts`) without `project`. The job's result is a `MakeOutcome`: the asset, its
`QualityReport`, how many tries, the credits spent, every take with its score, the changes made after failed checks, and
`needsYou` (plain words) when nothing passed. The final take is also emitted as the job's output `result`.

## Files

| Path | What |
|---|---|
| `src/make/index.ts` | The contract: `MakeRequest`, `MakeIntent`, `route()`, `MakeOutcome` (extended additively: `allowPaid` on the request; `tool`, `why`, `takes`, `changes`, `stopped` on the outcome; `skipped` on a `Route`; `route()` takes an optional context) |
| `knowledge/routing.json` | Routing as data: per intent, rules in order (`when` → tool order), per tool its kind, prompt param, reference inputs, preview params, the params a fix may change, paid or not; default thresholds, preview and tournament counts, max retries |
| `src/make/routing.ts` | Loads and checks the routing data (`checkRouting`), `pickTools`: the first matching rule's tools, minus tools this Gen lacks, offline ones (SSH fleet down), paid ones unless allowed, and ones whose required inputs the request can't fill |
| `src/make/plan.ts` | `buildPlan`: the routed tool and each fallback with its params and inputs; the world's style line, negative, board and canon; the cast's fixed descriptions, reference pictures (filling the tool's reference inputs) and LoRA; thresholds; the budget; a seed from the request |
| `src/make/loop.ts` | `runLoop` over injected deps (render a child, assess, quote, compare): draft / final / hero, `applyFix`, the budget stop, provider fallbacks, `worstCase`, `needsYouText` |
| `src/make/tool.ts` | The tool `make.checked` (pipeline): real deps (children through Gen's API on Gen's key, `reuse: true`, keyed by parent and step; `assess` from `src/quality`; Claude comparisons from three frames per video), `admit` (tenancy), `quote` |
| `src/make/settings.ts` | The owner's knobs, `.data/make-settings.json` |
| `src/make/feedback.ts` | `make_feedback`, `make_proposals`; `recordFeedback`, `summarize`, `runSummary`, `decideProposal`, the approved overlay, library picks from the event bus, the daily run |
| `src/make/routes.ts` | `/v1/make/*` |
| `test/make.test.ts` | Everything below, on fakes |

## The loop

1. **Route** (`knowledge/routing.json`). Starting rules:
   - dialogue close-up, one speaker: `video.perform`, then `video.lipsync`, then `video.talk`; two speakers: `video.talk`, `video.scene`, `video.seedance`
   - staged action with a depth video (`inputs.control`): `video.control`, then `video.control-wan`; two or more people from references: `video.scene`, `video.seedance`; otherwise `video.i2v`, `video.extend`
   - two people sharing a scene with references: `video.scene`, then `video.seedance` (paid: only when the request and the owner allow it)
   - continuing a shot: `video.extend`; a recast performance: `video.replace`
   - stills: `image.generate`; with references `image.edit`; with a character's LoRA `image.character`
   - first frames, sheets, skyboxes, 3D, voice, effects, music: one tool each (see the file)

   What the request says about the shot comes from what it carries: `inputs.control` is a depth video, `inputs.audio` a
   line, `refs.identity` (or `params.people`) the number of people, `params.seconds` the length, `params.lora` a LoRA.
   A tool is skipped when this Gen doesn't have it, when it needs the SSH fleet and the fleet is down, when it's paid and
   not allowed, or when the request can't fill its required inputs (`video.scene` needs a `set`).
2. **Apply the world and the cast.** `worldContext(project, world)` (gen-worlds; null until it lands): the style line goes
   at the end of the prompt, the negative is merged into the tool's negative, the canon is added to the brief the checks
   judge, the style board goes to the style check. `refs.identity` entries are asset ids or character scene ids; a
   character goes through `identityPack` (gen-identity): its fixed description goes at the front of the prompt, its
   references fill the tool's reference inputs the request left empty (`image.edit`'s `images`, `video.scene`'s
   `image`/`image2`/`image3`...), the first four pictures go to the face check, its LoRA to `image.character`.
3. **Previews** (`quality: "final"`): `defaults.previews` (2) takes with the tool's `preview` params (lower size, fewer
   frames, shorter) and seeds `base`, `base+1`. Tools whose preview is `null` (voice, effects) go straight to the final.
4. **Assess** each (`src/quality/index.ts assess`: identity against the references, the brief's yes/no questions, faults,
   style).
5. **The final**: the best preview (passing first, then score) at full settings with the same seed and inputs. The final
   recipe names every setting its preview lowered, so the two differ only there.
6. **Assess** the final.
7. **On a fail**, `applyFix` turns the report into a targeted change: failed questions go into the prompt as "Make sure:
   …" and the checker's `fix` after them; faults go into the negative and raise the steps; a drifting face puts the fixed
   description first and changes the seed; "stiff / puppet / too literal" lowers the strength by 0.15 (not under 0.55);
   "ignores the stage" raises it; a broken take (or one where nothing else could change) gets a new seed. At most
   `maxRetries` (2) more tries. Failing previews don't pay for a final until the last try.
8. **Report** the outcome; when no take passed, the best one comes back with `needsYou`, e.g. "None of the 7 takes
   passed every check, so this one needs you. Here's the closest. What's still off: Is she holding the lantern (empty
   hands). Say what's wrong in your own words, or keep it if it's close enough." No model, provider or machine names.

`quality: "draft"`: one render, one check. `quality: "hero"`: `heroCandidates` (3) finals; king of the hill in pairs (each
comparison is Claude looking at both, three frames per video; a mesh or a sound is decided by the checks' scores); the
last comparison's rewrite of the winner's prompt makes one refined take on the winner's seed, compared once more; then
the same retries if the winner still fails its checks.

**Provider errors**: a child that fails (its servers, a timeout, a 5xx at submit) hands the same request to the next tool
of the rule, with that tool's own params and preview; the outcome's `changes` says "switched to another model after a
server error". A cancelled parent stops.

**The budget**: every child is priced before it's queued (`billing.ts childCredits`: its work with the margin, no
standalone floor), plus `checkCredits` per check and `compareCredits` per comparison. A step that would pass the budget
stops the loop: `stopped: "budget"`, the best take so far, `needsYou` saying so. A child the library hands back
(`reuse`) costs nothing.

**The price, up front**: `quoteJobCredits('make.checked', …)` (and `POST /v1/estimate`-style callers, `POST
/v1/make/quote`) returns the loop's worst case (every preview, final, check, comparison and retry), capped by the
budget, never under the routed tool's floor. That's what the parent is charged (children run on Gen's key, unbilled).
The breakdown lists the parts.

## Learning from people

- `make_feedback` rows: kind (`pick`, `discard`, `redo`, `rating` 1-5, `complaint` with a note), source, the asset and
  job, and the recipe looked up from them (tool, params; for a take of the loop, its intent and score). Uploads are
  ignored (nothing was made).
- Recorded from: `POST /v1/make/feedback` (the app and the other parts); the library's picks and discards (version made
  current or discarded, from the event bus: no edit to `src/entities.ts`); the app's "Make another" in Details (`redo`)
  and deleting a made clip from the timeline (`discard`), each one `sendFeedback` call (`dashboard/gen/lib.js`).
- The summarizer (`runSummary`, daily from `startMakeLearning`, or `POST /v1/make/proposals/summarize`) looks at the last
  60 days and proposes:
  - a numeric setting whose high or low values are rejected far more often than the rest (at least 5 takes, 60% or more
    rejected and 25 points worse than the rest): "video.perform with strength over 0.6 got redone 70% of the time (7 of
    10), against 17% otherwise (6 takes)", as a craft note for that setting and an `iterate` line, `measured: true`
  - the same complaint said 3 or more times after one tool: a craft note
  - two tools of one routing rule where the first choice is rejected 25 points more often than a later one (5 takes
    each): a routing change putting the better one first
- Proposals go to the owner-only **Making** tab of `/admin` (`GET /v1/make/proposals`). Nothing is applied until the owner
  approves. Approving applies it at once as an overlay (`routing()` and `src/knowledge.ts notes()` read the approved
  ones); `{ "write": true }` also writes it into `knowledge/tools.json` / `knowledge/routing.json` (only that entry is
  rewritten) for a commit. On Cloud Run the overlay is what counts: the files there are replaced on every deploy, the
  database isn't. A rejected proposal is never proposed again.

## Owner settings

`GET/PUT /v1/make/settings` (owner), the Making tab: `defaultBudget` (400 credits; a request without a budget uses it),
`maxRetries` (0-2, default 2), `thresholds` (overrides of `knowledge/routing.json`'s: checklist 0.85, identity 0.15,
style 0.7), `allowPaid` (off: paid partner models are never routed to, whatever the request says), `checkCredits` (2),
`compareCredits` (2).

## Routes

| Route | Who | What |
|---|---|---|
| `POST /v1/make/feedback` | anyone, on their own assets | `{kind, asset \| job \| tool, rating?, note?, source?}` |
| `GET /v1/make/feedback` | admin | `?tool=&project=&limit=` |
| `POST /v1/make/quote` | anyone | a make.checked request: its worst case |
| `POST /v1/make/route` | anyone | `{intent, inputs?, refs?, params?, allowPaid?}`: the tool, the fallbacks, what was skipped and why, the preview |
| `GET /v1/make/proposals` | owner | `?status=open` |
| `POST /v1/make/proposals/summarize` | owner | `{days?}` |
| `POST /v1/make/proposals/:id` | owner | `{approve, write?}` |
| `GET/PUT /v1/make/settings` | owner | the knobs |

## Tenancy

Children run on Gen's key, so `make.checked`'s `admit` checks every file the request names against the caller at submit:
`inputs` (any depth), `refs.identity` asset ids, `refs.style`, `params.lora` must be the caller's (`canProject` on the
asset, `canUseBlob` for blobs); raw paths are for the owner only. A character scene in `refs.identity` is read only from
the job's own project. Customers may pin only the generative tools the routing data names (never `unity.*` and the
like). Tested in `test/make.test.ts` ("admit").

## Verified (offline, everything mocked)

`test/make.test.ts`, 18 tests: the routing data names only real tools, params and inputs; a routing table per intent
(including skips for offline, missing, paid and unfillable tools); the plan applies the world and the cast; a failed check
becomes a targeted change; an image's two previews then the final with the best preview's seed; a failed final fixed and
retried until it passes; the budget stop; the needsYou path; a draft; a hero tournament on a staged action shot; a
dialogue shot falling back from `video.perform` to `video.lipsync` on a server failure; no fallback left; the worst-case
quote and the budget cap; tenancy; the settings; feedback aggregation, proposals, approval overlays; feedback from an
asset's recipe and from library picks; the single-entry JSON rewrite.

## Decisions made without J (change any of them)

- The worst case is charged up front (like every job's reserve). Settling to what was actually spent (refunding the rest)
  needs a partial refund in `billing.ts`; not built.
- Children are priced at their work with the margin, not a standalone job's floor, so a preview really is cheaper; the
  call keeps the routed tool's floor. With no job history, a preview is priced from the tool's own guess (often the same
  as its final); history scales by pixels and frames.
- Tools whose `preview` is null (voice, effects) skip previews.
- A failing preview set retries without paying for a final, except on the last try (then the best preview's final is made
  anyway, so the person gets a full take).
- The routing data's `maxRetries` and the owner's setting both cap retries (the lower wins; never above 2).
- `image.character` is first for stills only when a LoRA is known (`params.lora` or the character's pack).

## What's left

- Gen Bench (gen-bench) replaces the placeholder checks; until then every check passes, so the loop always takes the first
  passing route. The thresholds should be tuned on the bench.
- `worldContext` (gen-worlds) and the identity pack's `lock` (gen-identity) are read through the contracts; nothing to
  change here when they land.
- The showrunner (gen-showrunner) and the app's AI should submit `make.checked` instead of raw tools; the review card can
  show `takes`, `changes` and `needsYou`.
- A 1-5 rating and a "what's wrong" box in the app would feed `rating` and `complaint` (the API takes them now).
- Partial refunds (above).

## Live runs to approve (priced)

Worst case per call, from `quoteJobCredits` on an empty job history (tool guesses; the real quote uses history), budget
not capping. 1 credit = $0.01. A typical run passes on the first try and costs about a third of the final-quality
number.

| Intent (routed tool) | draft | final | hero |
|---|---|---|---|
| image (`image.generate`) | 5 | 36 | 30 |
| first frame (`image.control`) | 7 | 63 | 48 |
| character sheet (`image.viewsheet`) | 15 | 27 | 24 |
| dialogue close-up (`video.perform`) | 96 | 864 | 582 |
| staged action (`video.control`) | 40 | 234 | 162 |
| two people from references (`video.scene`) | 142 | 1278 | 858 |
| continuing a shot (`video.extend`) | 96 | 864 | 582 |
| recast (`video.replace`) | 142 | 1278 | 858 |
| 3D prop (`mesh.views3d`) | 50 | 63 | 50 |
| voice (`audio.voice`) | 14 | 42 | 90 |
| music (`audio.music`) | 20 | 63 | 48 |

The video numbers are high because, with no history, a tool's own GPU guess doesn't shrink for a preview; once a tool
has finished jobs, previews are priced from the median scaled by pixels and frames. The default budget (400) caps every
call anyway.

The first runs worth paying for, on a GPU provider that's already up, each `quality: "final"` with a 400-credit budget:
1. an image of a character from their sheet (`image.edit` with references): about 20 credits typical;
2. a dialogue close-up of 5 seconds (`video.perform`): about 150-300 credits typical;
3. a staged action shot from the director's depth video (`video.control`): about 100-150 credits typical;
4. the same action shot at `quality: "hero"`: up to 260 credits.

Total about 600-750 credits ($6-7.50) with the real checks from Gen Bench switched on; run them after gen-bench lands so
the checks measure something.
