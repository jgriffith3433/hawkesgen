// Cursor answers Gen's writing calls when settings.brain is cursor, including a settings file that never chose a harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cursor-'));
process.env.HAWKESGEN_DATA_DIR = dir;
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ fleet: { servers: 2 } }));
process.env.HAWKESGEN_CURSOR = process.execPath;
process.env.HAWKESGEN_CURSOR_ARGS = JSON.stringify([path.resolve('test/fixtures/fake-agent.mjs')]);
process.env.CURSOR_API_KEY = 'cursor-test';

const { loadSettings, saveSettings } = await import('../src/config.ts');
const { ask, usageOf } = await import('../src/providers/anthropic.ts');

test('an existing settings file with no harness runs on Cursor', () => {
  assert.equal(loadSettings().brain, 'cursor');
});

test('ask() runs the Cursor harness and does not bill tokens', async () => {
  const r = await ask({ prompt: 'Return JSON', system: 'json only', model: 'claude-haiku-5-5', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } });
  assert.equal(r.billing, 'cursor');
  assert.equal(r.model, 'grok-4.7');
  assert.equal(r.text, '{"ok":true}');
  assert.equal(r.cost, 0);
  assert.equal(usageOf(r).provider, 'cursor');
  saveSettings({ brain: 'claude' });
  assert.equal(loadSettings().brain, 'claude');
});
