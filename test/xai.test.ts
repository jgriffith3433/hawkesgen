// Grok answers Gen's writing calls when settings.brain is grok, including a settings file that never chose a brain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-xai-'));
process.env.HAWKESGEN_DATA_DIR = dir;
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ fleet: { servers: 2 } }));
process.env.XAI_API_KEY = 'xai-test';

const { loadSettings, saveSettings } = await import('../src/config.ts');
const { ask, usageOf } = await import('../src/providers/anthropic.ts');

test('an existing settings file with no brain runs on Grok', () => {
  assert.equal(loadSettings().brain, 'grok');
});

test('ask() posts to the xAI responses API and prices the tokens', async () => {
  const seen: any[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      id: 'resp_1', model: 'grok-4.7',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const r = await ask({ prompt: 'Return JSON', system: 'json only', model: 'claude-haiku-5-5', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } });
    assert.equal(r.billing, 'xai');
    assert.equal(r.model, 'grok-4.7');
    assert.equal(r.text, '{"ok":true}');
    assert.equal(r.cost, 8);
    assert.equal(usageOf(r).provider, 'xai');
    assert.equal(seen[0].url, 'https://api.x.ai/v1/responses');
    assert.equal(seen[0].body.model, 'grok-4.7');
    assert.equal(seen[0].body.text.format.type, 'json_schema');
    saveSettings({ brain: 'claude' });
    assert.equal(loadSettings().brain, 'claude');
  } finally {
    globalThis.fetch = orig;
  }
});
