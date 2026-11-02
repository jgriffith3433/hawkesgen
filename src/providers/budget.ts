// How much a Claude request may write, and what a person reads when an answer still doesn't fit (anthropic.ts, bedrock.ts).

/**
 * The output budget a request is sent with. Thinking is always on for the current Claude models (Opus 5.5 can't turn it
 * off; `output_config.effort` only sets how deep it goes), and thinking is paid out of the same `max_tokens` as the answer.
 * So a caller's `maxTokens` sized for the answer alone (800 for a note, 4000 for the AI editor's JSON) runs out before
 * the answer finishes whenever the model thinks a little longer (2026-11-02: the AI pane's "ran out of room" on a plain
 * "Why not"). The cap is only a ceiling: a token is billed when it's written, not when it's allowed. So every streamed
 * request gets at least STREAMED_FLOOR, and a call that wants more keeps its own number (up to the model's 128K).
 */
export const STREAMED_FLOOR = 64000;
/** Non-streamed requests (Bedrock) stay under the SDKs' HTTP timeouts with less. */
export const UNSTREAMED_FLOOR = 16000;
export const MAX_OUTPUT = 128000;
export const outputBudget = (asked: number | undefined, streamed = true) =>
  Math.min(MAX_OUTPUT, Math.max(Number(asked) || 0, streamed ? STREAMED_FLOOR : UNSTREAMED_FLOOR));
/** What a person reads when an answer still didn't fit (no setting names: customers can't raise anything). */
export const TOO_LONG = 'That answer got too long to finish in one go. Try asking for a smaller part of it at a time.';
