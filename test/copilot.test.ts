// GitHub Copilot answers Gen's writing calls when settings.brain is copilot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-copilot-'));
process.env.HAWKESGEN_DATA_DIR = dir;
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ brain: 'copilot' }));
process.env.HAWKESGEN_COPILOT = process.execPath;
process.env.HAWKESGEN_COPILOT_ARGS = JSON.stringify([path.resolve('test/fixtures/fake-copilot.mjs')]);

const { loadSettings } = await import('../src/config.ts');
const { ask, usageOf, configured } = await import('../src/providers/anthropic.ts');
const { modelId, parseJsonl } = await import('../src/providers/copilot.ts');

test('copilot is a saved harness', () => {
  assert.equal(loadSettings().brain, 'copilot');
  assert.equal(configured(), true);
});

test('Claude model ids are dropped, Copilot ids pass', () => {
  assert.equal(modelId('claude-haiku-5-5'), '');
  assert.equal(modelId('sonnet'), '');
  assert.equal(modelId('gpt-5.4'), 'gpt-5.4');
});

test('parseJsonl reads the answer and errors', () => {
  assert.equal(parseJsonl('{"type":"assistant.message","data":{"content":"hi"}}\nnot json').text, 'hi');
  assert.match(parseJsonl('{"type":"session.error","data":{"message":"quota exceeded"}}').error, /quota/);
});

test('ask() runs the Copilot harness and does not bill tokens', async () => {
  const r = await ask({ prompt: 'Return JSON', model: 'claude-haiku-5-5' });
  assert.equal(r.billing, 'copilot');
  assert.equal(r.text, '{"ok":true}');
  assert.equal(r.cost, 0);
  assert.equal(usageOf(r).provider, 'copilot');
});
