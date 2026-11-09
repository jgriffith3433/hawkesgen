# The AI mock (`HAWKESGEN_AI_MOCK=1`)

Canned answers for `ask()` (`src/providers/anthropic.ts`), so tests and Studio's beta playtests can drive the editor,
director, scene and showrunner routes without calling Claude. Same idea as `HAWKESGEN_QUALITY_MOCK` and
`HAWKESGEN_AUDIO_MOCK`, but for the writing calls.

**Where it sits.** Inside `ask()`, below every route: prompts, `callScope`, answer parsing, the house AI's credit
charge and `applyOps` all run unchanged. Only the model call is replaced (`src/aimock.ts`, `takeAnswer`).

**Who gets it.** All three must hold, or `ask()` behaves exactly as before:
1. `HAWKESGEN_AI_MOCK=1` is set on this Gen (never set it on live).
2. The call is for an account made by the test sign-in (`POST /v1/users/test-session`, or its GitHub twin): the only way
   an account gets a `playtest:<project>` Google id (`user_google`). Real users, API keys, orgs and Gen's own jobs never do.
3. That account has an answer queued for the call. With none, the call runs for real.

**Queueing.** Each test account has its own queue, kept in memory (a restart clears it).
- `POST /v1/test/ai-mock` with the test session cookie: `{ answers: [...] }`, or one answer as the body. `GET` shows
  what is queued, `DELETE` clears it. 404 for anyone else, or with the flag off.
- In process: `queueAnswers(userId, answers)`, `clearAnswers`, `mockStatus` from `src/aimock.ts`.

An answer: `{ match?, text | json, cost?, model?, times? }`.
- `match`: a substring of the prompt or system text. No `match`: the next call, in order. A matching answer is taken
  before an ordered one.
- `json` is sent as the answer's text (`{ say, ops }` for the editor); `text` as is.
- `cost`: dollars the call reports (default 0). The house AI turns it into credits (`ai_turn`), so charging can be tested.
- `times`: how many calls it answers (default 1). `model` defaults to `mock`.

**Playtest.** The `aimock` scenario (`dashboard/gen/playtest.js`) queues one editor answer (named setup shortcut), types
a message into the AI pane and shows the canned words and the title they add.

**Tests.** `test/aimock.test.ts`: a queued answer and its cost, the editor assistant's ops from it, the flag unset, and a
non-test account refused.

`test/ai-assistants.test.ts` drives `POST /v1/editor/projects/:id/assistant` and `/apply` through the real route with the mock: one test per op type (add, generate, trim, split, move, delete, deleteRange, set, text, track, settings: clip change and version bump), the `ai_turn` row and exact debit, `aiCredits`, the `autoCredits` now/proposed split, 402, 503 (house AI off, no key, rejected key via a local fake API), 409, another user's project (404, nothing changes), `parseAnswer` on garbage, forged `role` turns and 60 messages trimmed to 16.

`test/ai-surfaces.test.ts` runs the same matrix on the other AI surfaces, through their real routes: the AI director (`POST /v1/director/shots/:id/assistant`), the scene AI (`POST /v1/scenes/:id/assistant` and `/apply`, character scenes), the showrunner (`POST /v1/showrunner/turn` and the production buttons) and the MCP tools `hawkesgen_editor_ask` / `hawkesgen_editor_apply`. Each has the charge (one `ai_turn` row, exact debit), 402 (the model is never called), 503 (house AI off, no key, rejected key), another user's id = 404 (nothing asked, charged or changed) and a garbage answer. The showrunner's queue calls and prices are swapped (`setDeps`), so a production is seen starting steps without spending: the card and its price, nothing started before approve, `autoCredits` from the body (default 40, negative = 0, junk never runs by itself), pause starts nothing, cancel never charges the steps that had not started. Also recorded:
- A `generate` op naming `comfy.graph`, `unity.build` or `playtest.run`: the AI editor's op only checks the tool exists, so `comfy.graph` is queued and `playtest.run` reaches its own checks (only `unity.build` is refused, by the queue); the scene AI drops all three (`aiCanUse`). Wanted behaviour is a `todo` test.
- The legacy `POST /v1/assistant/chat` and `/v1/assistant/code-suggestions` run as the AI editor does: a customer's call takes its org's own Claude, else the house AI for a Gen app account, charged `ai_turn` (402 at zero credits, 503 with the house AI off) and recorded as a usage row naming the house route. The studio's own Claude is never used for them (`src/assistant.ts` `customerAsk`; tests in `test/ai-surfaces.test.ts`).
- Test-writing traps: the SDK client is cached per key with the base URL it first saw (use a new fake key per fake server); a fake API must read the request before answering or a big prompt ends as a connection error, not a 401.
