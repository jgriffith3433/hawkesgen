// A stand-in for `claude -p --input-format stream-json --output-format stream-json` (test/claudecode.test.ts).
// FAKE_CLAUDE_LOG: a folder that gets one JSON file per call (arguments, the stdin message, the environment's keys).
// FAKE_CLAUDE_MODE: ok (default), throttle-once, auth, slow. --include-partial-messages streams the text answer first.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const log = process.env.FAKE_CLAUDE_LOG;
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
let input = '';
for await (const d of process.stdin) input += d;
const msg = JSON.parse(input.trim());
const start = Date.now();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const model = args[args.indexOf('--model') + 1];

if (mode === 'slow') await new Promise((r) => setTimeout(r, 10_000));
if (mode === 'ok') await new Promise((r) => setTimeout(r, 150));
let n = 0;
if (log) {
  n = fs.readdirSync(log).length;
  fs.writeFileSync(path.join(log, `${n}-${process.pid}.json`), JSON.stringify({
    args, msg, start, end: Date.now(), apiKey: 'ANTHROPIC_API_KEY' in process.env, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, cwd: process.cwd(),
  }));
}
out({ type: 'system', subtype: 'init', model });
if (mode === 'auth') {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: {} });
  process.exit(1);
}
if (mode === 'throttle-once' && n === 0) {
  out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: 429 rate_limit_error', usage: {} });
  process.exit(1);
}
const content = msg.message.content;
const images = content.filter((c) => c.type === 'image').length;
const text = content.find((c) => c.type === 'text').text;
const schema = args.includes('--json-schema');
out({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
// --include-partial-messages: the answer in pieces first, as Claude Code streams them.
if (args.includes('--include-partial-messages') && !schema) {
  const whole = `echo: ${text} (${images} images)`;
  out({ type: 'stream_event', event: { type: 'message_start' } });
  for (let i = 0; i < whole.length; i += 4) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: whole.slice(i, i + 4) } } });
    await new Promise((r) => setTimeout(r, 5));
  }
  out({ type: 'stream_event', parent_tool_use_id: 'toolu_x', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NOT OURS' } } });
}
out({
  type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', total_cost_usd: 0.01,
  result: schema ? '```json\n{"ignored":true}\n```' : `echo: ${text} (${images} images)`,
  ...(schema ? { structured_output: { echo: text, images } } : {}),
  usage: { input_tokens: 10, output_tokens: 5 },
});
