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
