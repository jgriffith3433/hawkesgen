// J, 2026-11-11: no warm idle RunPod workers. Gen puts every endpoint on the rule when it starts (src/providers/gpu/runpodIdle.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyIdleRule, wastesIdle, idleWorkers } from '../src/providers/gpu/runpodIdle.ts';
import { RUNPOD_IDLE_SECONDS } from '../src/providers/playtester/capacity.ts';
// @ts-ignore: the setup scripts' plain JS
import * as tools from '../tools/gpu-providers/runpod-v2.mjs';

const ENDPOINTS = [
  { id: 'gpu', name: 'hawkes-gen-gpu', workers: { min: 0, max: 3, idleTimeout: 600 } },
  { id: 'd3', name: 'hawkes-gen-3d', workers: { min: 0, max: 1, idleTimeout: 900 } },
  { id: 'warm', name: 'warm', workers: { min: 1, max: 2, idleTimeout: 30 } },
  { id: 'pt', name: 'playtest-gfx', workers: { min: 0, max: 4, idleTimeout: 60 } },
  { id: 'off', name: 'unity-render', workers: { min: 0, max: 0, idleTimeout: 5 } },
];

function fake(eps = ENDPOINTS, fail?: string) {
  const calls: { method: string; url: string; body: any }[] = [];
  const fetcher = (async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    if (fail && url.includes(fail)) return new Response(JSON.stringify({ title: 'nope' }), { status: 500 });
    if (method === 'GET') return new Response(JSON.stringify({ endpoints: eps, pagination: {} }));
    return new Response(JSON.stringify({ id: url.split('/').pop() }));
  }) as typeof fetch;
  return { calls, fetcher };
}
const key = (k: string) => (k === 'RUNPOD_API_KEY' ? 'sekret' : undefined);

test('the start rule is the setup scripts\' rule', () => {
  assert.equal(RUNPOD_IDLE_SECONDS, tools.IDLE_SECONDS);
  for (const ep of ENDPOINTS) assert.equal(wastesIdle(ep), tools.wastesIdle(ep), ep.name);
  for (const m of [0, 1, 3, 10]) assert.deepEqual(idleWorkers(m), tools.idleWorkers(m));
});

test('at start Gen PATCHes only the endpoints that keep warm or long-idle workers, and only their workers', async () => {
  const { calls, fetcher } = fake();
  const r = await applyIdleRule(key as any, fetcher);
  assert.equal(r!.error, null);
  assert.equal(r!.checked, 5);
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(patches.map((c) => c.url.split('/').pop()).sort(), ['d3', 'gpu', 'warm']);
  for (const p of patches) {
    assert.deepEqual(Object.keys(p.body), ['workers']);
    assert.equal(p.body.workers.min, 0);
    assert.ok(p.body.workers.idleTimeout <= 60);
  }
  assert.equal(patches.find((p) => p.url.endsWith('/gpu'))!.body.workers.max, 3);
});

test('an account already on the rule gets no change at all', async () => {
  const { calls, fetcher } = fake(ENDPOINTS.filter((e) => !wastesIdle(e)));
  const r = await applyIdleRule(key as any, fetcher);
  assert.equal(r!.changed.length, 0);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});

test('a RunPod error comes back as error with the key hidden, and the other endpoints still change', async () => {
  const { fetcher } = fake(ENDPOINTS, '/serverless/gpu');
  const r = await applyIdleRule(key as any, fetcher);
  assert.match(r!.error!, /gpu: 500/);
  assert.deepEqual(r!.changed.map((c) => c.id).sort(), ['d3', 'warm']);
  const none = await applyIdleRule((() => undefined) as any, fake().fetcher);
  assert.equal(none, null);
});

test('random accounts: after the start rule, no endpoint keeps a warm or long-idle worker and max never changes', async () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const eps = Array.from({ length: 1 + rnd(6) }, (_, i) => ({ id: `e${i}`, name: `e${i}`, workers: { min: rnd(3), max: rnd(6), idleTimeout: [5, 30, 60, 61, 120, 300, 600, 900, 3600][rnd(9)] } }));
    const { calls, fetcher } = fake(eps);
    await applyIdleRule(key as any, fetcher);
    const after = eps.map((e) => {
      const p = calls.find((c) => c.method === 'PATCH' && c.url.endsWith(`/${e.id}`));
      return p ? { ...e, workers: p.body.workers } : e;
    });
    for (const [i, e] of after.entries()) {
      assert.equal(wastesIdle(e), false, JSON.stringify(eps[i]));
      assert.equal(e.workers.max, eps[i].workers.max);
    }
  }
});

test('Gen applies the rule when it starts (server.ts), once, not on a timer', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const at = src.indexOf("import('./providers/gpu/runpodIdle.ts')");
  assert.ok(at > src.indexOf('queue.start()'), 'started with the queue');
  assert.ok(at < src.indexOf('if (process.env.K_SERVICE) return;'), 'also on Cloud Run');
  const mod = fs.readFileSync(new URL('../src/providers/gpu/runpodIdle.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(mod, /setInterval|setTimeout/);
});
