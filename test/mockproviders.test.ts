// HAWKESGEN_MOCK_PROVIDERS (src/mockproviders.ts): off by default and refused on the live lane; on, provider tools answer at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-mockprov-'));
delete process.env.HAWKESGEN_MOCK_PROVIDERS;
const M = await import('../src/mockproviders.ts');
const { getTool, reloadTools, TOOLS } = await import('../src/tools/index.ts');

const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;

test('with the flag unset, provider tools are exactly as before', () => {
  const before = TOOLS.filter((t) => ['comfy', 'elevenlabs', 'anthropic', 'gemini'].includes(t.provider));
  assert.ok(before.length > 5);
  reloadTools();
  assert.equal(getTool('image.generate')!.provider, 'comfy');
  assert.ok(!getTool('image.generate')!.description.includes('mocked'));
  assert.equal(M.mockProvidersOn(env({})), false);
  assert.equal(M.mockHealth().providers, false);
  assert.doesNotThrow(() => M.assertMockProviders(env({})));
});

test('the flag is refused on the live lane, set or not, and the server would not start', () => {
  for (const lane of [{}, { HAWKESGEN_LANE: 'live' }, { HAWKESGEN_LANE: 'LIVE' }, { HAWKESGEN_LANE: 'prod' }, { HAWKESGEN_LANE: '' }]) {
    const e = env({ HAWKESGEN_MOCK_PROVIDERS: '1', ...lane });
    assert.equal(M.mockProvidersOn(e), false, JSON.stringify(lane));
    assert.throws(() => M.assertMockProviders(e), /refused/);
  }
  // a local copy listening beyond loopback is refused too
  const open = env({ HAWKESGEN_MOCK_PROVIDERS: '1', HAWKESGEN_LANE: 'local', HAWKESGEN_HOST: '0.0.0.0' });
  assert.equal(M.mockProvidersOn(open), false);
  assert.throws(() => M.assertMockProviders(open), /loopback/);
});

test('beta and local copies may turn it on', () => {
  assert.equal(M.mockProvidersOn(env({ HAWKESGEN_MOCK_PROVIDERS: '1', HAWKESGEN_LANE: 'beta', HAWKESGEN_HOST: '0.0.0.0' })), true);
  assert.equal(M.mockProvidersOn(env({ HAWKESGEN_MOCK_PROVIDERS: '1', HAWKESGEN_LANE: 'local' })), true);
  assert.equal(M.mockProvidersOn(env({ HAWKESGEN_LANE: 'local' })), false, 'the flag itself is still needed');
});

test('a mocked tool runs on the local lane and answers with real small files and no cost', async () => {
  const t = getTool('image.generate')!;
  const m = M.mockTool(t);
  assert.equal(m.provider, 'local');
  assert.equal(M.mockTool(getTool('playtest.run')!).provider, getTool('playtest.run')!.provider, 'non-provider tools are untouched');
  const emitted: any[] = []; const usage: any[] = [];
  await m.run({ done: 0, seed: (n: number) => 7 + n, step() {}, emit: async (o: any) => { emitted.push(o); }, usage: (u: any) => usage.push(u), result() {}, params: {} } as any);
  assert.equal(emitted.length, 1);
  assert.deepEqual([...emitted[0].data.subarray(0, 4)], [137, 80, 78, 71]);
  assert.deepEqual(usage.map((u) => [u.provider, u.cost]), [['mock', 0]]);
  assert.equal(M.mockWav(1).subarray(0, 4).toString(), 'RIFF');
});
