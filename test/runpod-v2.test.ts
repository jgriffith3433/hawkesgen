// tools/gpu-providers/runpod-v2.mjs: the RunPod API v2 helper the setup scripts share (REST v1 retires 2026-11-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const lib: any = await import(String(new URL('../tools/gpu-providers/runpod-v2.mjs', import.meta.url)));

const CATALOG = [
  { id: 'NVIDIA RTX A4000', pool: 'AMPERE_16' }, { id: 'NVIDIA RTX A4500', pool: 'AMPERE_16' },
  { id: 'NVIDIA L4', pool: 'AMPERE_24' }, { id: 'NVIDIA RTX A5000', pool: 'AMPERE_24' },
  { id: 'NVIDIA RTX PRO 6000 Blackwell MIG 1g.24gb', pool: 'AMPERE_24' }, { id: 'NVIDIA L40S', pool: 'ADA_48_PRO' },
];

test('an allow-list becomes pools plus every other type in them excluded (a new MIG slice included)', () => {
  const gpu = lib.gpuFor(['NVIDIA RTX A4000', 'NVIDIA L4'], { pools: ['AMPERE_16', 'AMPERE_24'], catalog: CATALOG });
  assert.deepEqual(gpu, { pools: ['AMPERE_16', 'AMPERE_24'], excludedTypes: ['NVIDIA RTX A4500', 'NVIDIA RTX A5000', 'NVIDIA RTX PRO 6000 Blackwell MIG 1g.24gb'], count: 1 });
});

test('pools come from the models when none are given; a model outside the pools is refused', () => {
  assert.deepEqual(lib.gpuFor(['NVIDIA L40S'], { catalog: CATALOG }).pools, ['ADA_48_PRO']);
  assert.throws(() => lib.gpuFor(['NVIDIA L40S'], { pools: ['AMPERE_16'], catalog: CATALOG }), /not in the pools/);
  assert.throws(() => lib.gpuFor(['NVIDIA Made Up'], { catalog: CATALOG }), /No serverless pool/);
});

test('a load-balancer endpoint body in v2 shape', () => {
  const body = lib.lbEndpoint({ name: 'x', templateId: 't1', gpu: { pools: ['AMPERE_16'], excludedTypes: [], count: 1 }, max: 2, idle: 60, perWorker: 2, timeoutMs: 1000 });
  assert.equal(body.type, 'LOAD_BALANCER');
  assert.deepEqual(body.workers, { min: 0, max: 2, idleTimeout: 60 });
  assert.deepEqual(body.scaling, { type: 'REQUEST_COUNT', requestCount: 2 });
  assert.equal(body.timeout, 1000);
  assert.equal('workersMax' in body || 'scalerType' in body || 'gpuIds' in body, false);
});

test('the client walks pages, reads RFC 9457 errors and never calls REST v1', async () => {
  const calls: string[] = [];
  const pages: Record<string, any> = {
    '': { endpoints: [{ id: 'a', name: 'one' }], pagination: { hasNextPage: true, nextCursor: 'c2' } },
    c2: { endpoints: [{ id: 'b', name: 'two -fb' }], pagination: { hasNextPage: false, nextCursor: null } },
  };
  const fetch = async (url: string, init: any) => {
    calls.push(`${init.method} ${url}`);
    assert.equal(init.headers.Authorization, 'Bearer k');
    if (url.includes('/serverless/bad')) return new Response(JSON.stringify({ title: 'Not Found', status: 404, detail: 'no endpoint bad' }), { status: 404 });
    const cursor = new URL(url).searchParams.get('cursor') ?? '';
    return new Response(JSON.stringify(pages[cursor]), { status: 200 });
  };
  const api = lib.runpod('k', { fetch });
  assert.deepEqual((await api.list('/serverless', 'endpoints')).map((e: any) => e.id), ['a', 'b']);
  assert.equal((await lib.findEndpoint(api, 'two'))?.id, 'b');
  await assert.rejects(api.req('GET', '/serverless/bad'), /404 Not Found: no endpoint bad/);
  assert.ok(calls.every((c) => c.includes('https://api.runpod.io/v2/') && !c.includes('rest.runpod.io')));
});

test('checkPlan reads only (GETs) and says what --apply would change', async () => {
  const methods: string[] = [];
  const fetch = async (url: string, init: any) => {
    methods.push(init.method);
    const p = new URL(url).pathname;
    const body = p.endsWith('/catalog/gpus') ? { gpus: CATALOG, pagination: {} }
      : p.endsWith('/templates') ? { templates: [{ id: 't1', name: 'x', image: 'old' }], pagination: {} }
      : p.endsWith('/serverless') ? { endpoints: [{ id: 'e1', name: 'x' }], pagination: {} }
      : { id: 'e1', type: 'LOAD_BALANCER', workers: { min: 0, max: 1, idleTimeout: 60 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const lines = await lib.checkPlan(lib.runpod('k', { fetch }), {
    template: { name: 'x', image: 'new' }, name: 'x', gpuTypes: ['NVIDIA L4'], pools: null,
    endpointBody: (tid: string, gpu: any) => lib.lbEndpoint({ name: 'x', templateId: tid, gpu, max: 2, idle: 60, perWorker: 1, timeoutMs: 1 }),
  });
  assert.ok(methods.every((m) => m === 'GET'));
  assert.match(lines.join('\n'), /template t1: would PATCH \(image now old, wanted new\)/);
  assert.match(lines.join('\n'), /endpoint e1 \(x\): would PATCH/);
});
