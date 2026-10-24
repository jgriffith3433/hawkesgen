// Claude on the Max plan (src/providers/claudecode.ts) through a fake `claude` CLI: the request and answer shapes the
// API path had, JSON mode, images, the API key kept out, the subscription token passed in, the cap on calls at once,
// retries on a rate limit, the timeout, and usage at $0 as "max-plan".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-claude-'));
process.env.HAWKESGEN_DATA_DIR = path.join(scratch, 'data');
process.env.HAWKESGEN_CLAUDE = process.execPath;
process.env.HAWKESGEN_CLAUDE_ARGS = JSON.stringify([path.resolve('test/fixtures/fake-claude.mjs')]);
process.env.HAWKESGEN_CLAUDE_ENV = path.join(scratch, 'claude.env');
fs.writeFileSync(process.env.HAWKESGEN_CLAUDE_ENV, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n');
process.env.ANTHROPIC_API_KEY = 'sk-ant-api-out-of-credits';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const { loadSettings, saveSettings } = await import('../src/config.ts');
const { ask, usageOf, configured } = await import('../src/providers/anthropic.ts');
const maxPlan = await import('../src/providers/claudecode.ts');
const { estimate } = await import('../src/estimate.ts');

function freshLog(mode = 'ok') {
  const dir = fs.mkdtempSync(path.join(scratch, 'log-'));
  process.env.FAKE_CLAUDE_LOG = dir;
  process.env.FAKE_CLAUDE_MODE = mode;
  return () => fs.readdirSync(dir).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

test('the Max plan is the default backend, with a cap of 3 and a timeout', () => {
  assert.deepEqual(loadSettings().claude, { backend: 'max-plan', concurrency: 3, timeoutMinutes: 10 });
  assert.equal(configured(), true);
});

test('text with images: same answer shape, the API key removed, the subscription token passed, $0 as max-plan', async () => {
  const calls = freshLog();
  const img = path.join(scratch, 'frame.png');
  fs.writeFileSync(img, Buffer.from('89504e47', 'hex'));
  const r = await ask({ prompt: 'Describe this', system: 'You review games.', images: [img, img], model: 'claude-sonnet-5-5', effort: 'high' });
  assert.equal(r.text, 'echo: Describe this (2 images)');
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(r.cost, 0);
  assert.equal(r.billing, 'max-plan');
  assert.deepEqual(usageOf(r, 'judge'), { provider: 'max-plan', unit: 'tokens', amount: 15, cost: 0, detail: 'judge' });
  const [c] = calls();
  assert.equal(c.apiKey, false);
  assert.equal(c.token, 'sk-ant-oat-test');
  assert.equal(c.args[c.args.indexOf('--system-prompt') + 1], 'You review games.');
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(c.args[c.args.indexOf('--tools') + 1], '');
  assert.equal(c.msg.message.content[0].source.media_type, 'image/png');
  assert.equal(c.msg.message.content[2].text, 'Describe this');
  assert.ok(!fs.existsSync(c.cwd), 'the scratch folder is removed');
});

test('JSON mode: the schema goes to --json-schema and the structured output comes back as JSON text', async () => {
  const calls = freshLog();
  const schema = { type: 'object', properties: { echo: { type: 'string' }, images: { type: 'integer' } }, required: ['echo', 'images'], additionalProperties: false };
  const r = await ask({ prompt: 'Score it', model: 'claude-sonnet-5-5', schema });
  assert.deepEqual(JSON.parse(r.text), { echo: 'Score it', images: 0 });
  const [c] = calls();
  assert.deepEqual(JSON.parse(c.args[c.args.indexOf('--json-schema') + 1]), schema);
});

test('answerText with a schema: pure JSON, fenced JSON, and a prose preamble before the object', () => {
  const schema = { type: 'object' };
  assert.equal(maxPlan.answerText({ result: '{"a":1}' }, schema), '{"a":1}');
  assert.equal(maxPlan.answerText({ result: '```json\n{"a":1}\n```' }, schema), '{"a":1}');
  // Claude (Max plan) sometimes leads with "I'll review…" instead of pure JSON; playtest.review JSON.parses this.
  const withPreamble = 'I\'ll review this playtest carefully.\n{"verdict":"pass","findings":[]}';
  assert.equal(maxPlan.answerText({ result: withPreamble }, schema), '{"verdict":"pass","findings":[]}');
  assert.deepEqual(JSON.parse(maxPlan.answerText({ result: withPreamble }, schema)), { verdict: 'pass', findings: [] });
});

test('answerText unwraps fenced JSON, fenced JSON after prose, arrays, and keeps no-JSON replies strict', () => {
  const schema = { type: 'object' };
  const obj = '{"verdict":"pass","note":"has } and ``` inside","findings":[1,2]}';
  assert.equal(maxPlan.answerText({ result: '```json\n' + obj + '\n```' }, schema), obj);
  assert.equal(maxPlan.answerText({ result: '```\n' + obj + '\n```\n' }, schema), obj);
  assert.equal(maxPlan.answerText({ result: 'Here is my review:\n\n```json\n' + obj + '\n```\nHope it helps.' }, schema), obj);
  assert.equal(maxPlan.answerText({ result: '```json {"a":1}```' }, schema), '{"a":1}');
  assert.equal(maxPlan.answerText({ result: '```json\n{"a":1}' }, schema), '{"a":1}');
  assert.equal(maxPlan.answerText({ result: 'Sure: [{"a":1},{"b":[2]}] done' }, schema), '[{"a":1},{"b":[2]}]');
  assert.equal(maxPlan.answerText({ result: '  ' + obj + '\n' }, schema), obj);
  assert.throws(() => JSON.parse(maxPlan.answerText({ result: 'I could not do that.' }, schema)));
  assert.equal(maxPlan.answerText({ result: '```json\n{"a":1}\n```' }), '```json\n{"a":1}\n```');
});

test('no more than the cap at once', async () => {
  saveSettings({ claude: { ...loadSettings().claude, concurrency: 2 } });
  const calls = freshLog();
  await Promise.all(Array.from({ length: 5 }, (_, i) => ask({ prompt: `p${i}`, model: 'claude-sonnet-5-5' })));
  const spans = calls().map((c) => [c.start, c.end]);
  assert.equal(spans.length, 5);
  for (const [s] of spans) assert.ok(spans.filter(([a, b]) => a <= s && s < b).length <= 2, 'at most 2 running at once');
  assert.equal(maxPlan.load().running, 0);
  saveSettings({ claude: { ...loadSettings().claude, concurrency: 3 } });
});

test('a rate limit waits and tries again', async () => {
  const calls = freshLog('throttle-once');
  const r = await maxPlan.ask({ prompt: 'again', model: 'claude-sonnet-5-5' }, undefined, { retryDelaysMs: [10] });
  assert.equal(r.text, 'echo: again (0 images)');
  assert.equal(calls().length, 2);
});

test('not signed in fails at once with a clear message', async () => {
  const calls = freshLog('auth');
  await assert.rejects(maxPlan.ask({ prompt: 'x', model: 'claude-sonnet-5-5' }, undefined, { retryDelaysMs: [10, 10] }), (e: any) => e.kind === 'auth' && /not signed in/.test(e.message));
  assert.equal(calls().length, 1);
});

test('a call that runs too long is stopped', async () => {
  freshLog('slow');
  const t = Date.now();
  await assert.rejects(maxPlan.ask({ prompt: 'x', model: 'claude-sonnet-5-5' }, undefined, { timeoutMs: 300 }), (e: any) => e.kind === 'timeout');
  assert.ok(Date.now() - t < 5000);
  assert.equal(maxPlan.load().running, 0);
});

test('a cancelled job stops its call', async () => {
  freshLog('slow');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(maxPlan.ask({ prompt: 'x', model: 'claude-sonnet-5-5' }, ac.signal), (e: any) => e.kind === 'cancelled');
});

test('estimates price Claude jobs at $0 on the Max plan', () => {
  const r = estimate('sandbox', [{ tool: 'llm.json', count: 4, params: { prompt: 'x', schema: { type: 'object' } } }] as any);
  assert.equal(r.lines[0].apiCost, 0);
  assert.equal(r.cost.total, 0);
});

test('the API backend is still there behind the setting', () => {
  saveSettings({ claude: { ...loadSettings().claude, backend: 'api' } });
  assert.equal(loadSettings().claude.backend, 'api');
  saveSettings({ claude: { ...loadSettings().claude, backend: 'max-plan' } });
});

test('a long system prompt goes in a file (one argument over 128 KB fails to start: spawn E2BIG)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sys-'));
  const short = maxPlan.cliArgs({ prompt: 'hi', model: 'claude-opus-5-5', system: 'Be brief.' }, dir).args;
  assert.equal(short[short.indexOf('--system-prompt') + 1], 'Be brief.');
  assert.ok(!short.includes('--system-prompt-file'));
  const guide = 'The engine guide. '.repeat(20_000); // ~360 KB, like the portal's assistant
  const long = maxPlan.cliArgs({ prompt: 'make a mountain', model: 'claude-opus-5-5', system: guide }, dir).args;
  assert.ok(!long.includes('--system-prompt'), 'not inline');
  const f = long[long.indexOf('--system-prompt-file') + 1];
  assert.equal(fs.readFileSync(f, 'utf8'), guide);
  assert.ok(long.every((a) => a.length < 100_000), 'every argument short');
});
