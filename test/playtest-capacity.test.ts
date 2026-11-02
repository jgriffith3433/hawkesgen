// Studio's playtest capacity setting (GET / PUT /v1/playtest/capacity), with a fake RunPod: what the account allows (the
// quota minus the other endpoints), browsers -> workers.max (rounded up, clamped), RunPod's own quota refusal taken and
// remembered, the lane following at once, the provider order Studio sends (only the ticked ones: the rest switched off),
// AWS listed but never switched on, Modal's endpoint, and the route's auth (customers never, the owner to change).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-playtest-capacity-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
const cap = await import('../src/providers/playtester/capacity.ts');
const { saveSettings, loadSettings } = await import('../src/config.ts');
const { runpodEndpointMax, setRunpodEndpointMax } = await import('../src/providers/playtester/runpodcap.ts');
const { setRunpodCredit } = await import('../src/providers/gpu/credit.ts');

const RP = 'https://43vc12r3r5gj4n.api.runpod.ai';
const MODAL = 'https://jgriffith3433--hawkes-gen-playtest-browser.modal.run';
const get = (k: string) => ({ RUNPOD_API_KEY: 'rp_key', MODAL_PROXY_KEY: 'k', MODAL_PROXY_SECRET: 's' } as Record<string, string>)[k];

/** A RunPod API v2 with three endpoints (as on 2026-11-01) and its quota rule. */
function fakeRunpod({ quota = 10, playtest = 5 } = {}) {
  const eps = [
    { id: 'jcttiz8lw75vca', name: 'hawkes-play-native', workers: { min: 0, max: 2, idleTimeout: 60 } },
    { id: '43vc12r3r5gj4n', name: 'hawkes-gen-playtest-gfx', workers: { min: 0, max: playtest, idleTimeout: 60 } },
    { id: '3wmex1ido3rymg', name: 'hawkes-gen-gpu', workers: { min: 0, max: 3, idleTimeout: 60 } },
  ];
  const calls: { method: string; path: string; body?: any; auth?: string }[] = [];
  const fetcher = (async (url: string, init: any = {}) => {
    const p = url.replace('https://api.runpod.io/v2', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? 'GET', path: p, body, auth: init.headers?.Authorization });
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
    if (p.startsWith('/serverless?')) return json(200, { endpoints: eps, pagination: {} });
    const m = /^\/serverless\/([a-z0-9]+)$/.exec(p);
    if (m && init.method === 'PATCH') {
      const ep = eps.find((e) => e.id === m[1])!;
      const others = eps.filter((e) => e !== ep).reduce((n, e) => n + e.workers.max, 0);
      if (others + body.workers.max > quota) return json(400, { title: 'Bad Request', detail: `Max workers across all endpoints must not exceed your workers quota (${quota}). Reduce the max workers for other endpoints or lower the max worker count for this endpoint to at most ${quota - others}.` });
      Object.assign(ep.workers, body.workers);
      return json(200, ep);
    }
    return json(404, { title: 'Not Found' });
  }) as unknown as typeof fetch;
  return { eps, calls, fetcher };
}

const base = () => saveSettings({ playtest: { backend: 'runpod', order: [], disabled: [], runpod: { url: RP, tabsPerInstance: 2, maxInstances: 2, workerQuota: 10 }, modal: { url: null }, cloudrunCpu: { url: 'https://gen-playtest-cpu-abc-nw.a.run.app' } } } as any);

test('GET: browsers now, the most the account allows, and every provider with why it can\'t play (AWS off)', async () => {
  base();
  setRunpodEndpointMax(null);
  setRunpodCredit({ balance: -0.006, at: Date.now() });
  const { fetcher } = fakeRunpod();
  const c = await cap.playtestCapacity(loadSettings(), { get, fetcher });
  assert.equal(c.browsers, 10, '5 workers x 2');
  assert.equal(c.workers, 5);
  assert.equal(c.perWorker, 2);
  assert.equal(c.maxBrowsers, 10, 'quota 10 minus 2 + 3 on the other endpoints = 5 workers');
  assert.deepEqual(c.order, ['runpod', 'modal', 'cloudrun-cpu'], 'no order set: the backend rule, Modal as the second GPU provider');
  assert.deepEqual(c.providers.map((p) => p.id), ['runpod', 'modal', 'cloudrun-cpu', 'cloudrun', 'aws']);
  const rp = c.providers[0];
  assert.equal(rp.enabled, true);
  assert.equal(rp.ok, false);
  assert.match(rp.reason!, /out of credit/);
  assert.deepEqual(rp.credit, { ok: false, balance: -0.006 });
  assert.equal(rp.maxBrowsers, 10);
  const modal = c.providers.find((p) => p.id === 'modal')!;
  assert.equal(modal.enabled, true, 'in the default order, after RunPod');
  assert.equal(modal.ok, false);
  assert.match(modal.reason!, /not deployed/);
  const aws = c.providers.find((p) => p.id === 'aws')!;
  assert.equal(aws.selectable, false);
  assert.equal(aws.enabled, false);
  assert.match(aws.reason!, /suspended/);
  assert.equal(c.providers.find((p) => p.id === 'cloudrun-cpu')!.kind, 'software');
  assert.equal(runpodEndpointMax(RP), 5, 'the reading feeds the lane');
  setRunpodCredit(null);
});

test('GET without a key or RunPod answering: settings\' numbers and the reason, no throw', async () => {
  base();
  setRunpodEndpointMax(null);
  const c = await cap.playtestCapacity(loadSettings(), { get: () => undefined, fetcher: (async () => { throw new Error('no'); }) as any });
  assert.equal(c.browsers, 4, 'settings: 2 workers x 2');
  assert.equal(c.maxBrowsers, null);
  assert.match((c.runpod as any).readError, /RUNPOD_API_KEY/);
});

test('PUT browsers: workers.max = ceil(browsers / 2), only workers changed, the lane follows at once', async () => {
  base();
  const r = fakeRunpod({ playtest: 2 });
  const out = await cap.setPlaytestCapacity({ browsers: 7 }, loadSettings(), { get, fetcher: r.fetcher });
  assert.deepEqual(out.applied, { requested: 7, workers: 4, browsers: 8, clamped: null });
  const patch = r.calls.find((x) => x.method === 'PATCH')!;
  assert.deepEqual(patch.body, { workers: { min: 0, max: 4, idleTimeout: 60 } }, 'nothing but workers');
  assert.equal(patch.auth, 'Bearer rp_key');
  assert.equal(runpodEndpointMax(RP), 4);
  assert.equal(out.browsers, 8);
});

test('PUT browsers past the account: clamped to quota minus the other endpoints, and said so', async () => {
  base();
  const r = fakeRunpod({ playtest: 2 });
  const out = await cap.setPlaytestCapacity({ browsers: 20 }, loadSettings(), { get, fetcher: r.fetcher });
  assert.equal(out.applied.workers, 5);
  assert.equal(out.applied.browsers, 10);
  assert.match(out.applied.clamped!, /quota is 10 .* other endpoints have 5: this endpoint may have 5 \(10 browsers\)/);
});

test('PUT browsers: RunPod\'s own quota refusal (a lower quota than Gen knew) is taken, applied and remembered', async () => {
  base();
  const r = fakeRunpod({ quota: 8, playtest: 2 });
  const out = await cap.setPlaytestCapacity({ browsers: 10 }, loadSettings(), { get, fetcher: r.fetcher });
  assert.equal(out.applied.workers, 3, 'RunPod said at most 3');
  assert.match(out.applied.clamped!, /workers quota \(8\)/);
  assert.equal(loadSettings().playtest.runpod.workerQuota, 8);
  assert.equal(out.maxBrowsers, 6);
});

test('PUT browsers: refused without a key, for a bad number, or without a RunPod endpoint', async () => {
  base();
  const r = fakeRunpod();
  await assert.rejects(cap.setPlaytestCapacity({ browsers: 4 }, loadSettings(), { get: () => undefined, fetcher: r.fetcher }), (e: any) => e.status === 503);
  for (const bad of [0, -2, 1.5, 'x', 99]) await assert.rejects(cap.setPlaytestCapacity({ browsers: bad }, loadSettings(), { get, fetcher: r.fetcher }), (e: any) => e.status === 400, String(bad));
  saveSettings({ playtest: { runpod: { url: null } } } as any);
  await assert.rejects(cap.setPlaytestCapacity({ browsers: 4 }, loadSettings(), { get, fetcher: r.fetcher }), (e: any) => e.status === 409);
  await assert.rejects(cap.setPlaytestCapacity({}, loadSettings(), { get, fetcher: r.fetcher }), /nothing to change/);
  assert.equal(r.calls.filter((x) => x.method === 'PATCH').length, 0);
});

test('PUT providers: Studio sends the ticked ones in order; the rest are switched off; software stays last; AWS never on', async () => {
  base();
  const r = fakeRunpod();
  const out = await cap.setPlaytestCapacity({ providers: ['cloudrun-cpu', 'modal', 'runpod'] }, loadSettings(), { get, fetcher: r.fetcher });
  assert.deepEqual(out.applied.providers, ['modal', 'runpod', 'cloudrun-cpu']);
  assert.deepEqual(loadSettings().playtest.order, ['modal', 'runpod', 'cloudrun', 'cloudrun-cpu']);
  assert.deepEqual(loadSettings().playtest.disabled, ['cloudrun']);
  assert.deepEqual(out.providers.map((p) => `${p.id}:${p.enabled}`), ['modal:true', 'runpod:true', 'cloudrun-cpu:true', 'cloudrun:false', 'aws:false'], 'every provider comes back, unticked ones too');
  const again = await cap.setPlaytestCapacity({ providers: ['runpod'] }, loadSettings(), { get, fetcher: r.fetcher });
  assert.deepEqual(again.order, ['runpod'], 'unticked: switched off, not merely moved');
  assert.deepEqual(loadSettings().playtest.disabled.sort(), ['cloudrun', 'cloudrun-cpu', 'modal']);
  const objs = await cap.setPlaytestCapacity({ providers: [{ id: 'runpod' }, { id: 'modal', enabled: false }, { id: 'aws', enabled: false }] }, loadSettings(), { get, fetcher: r.fetcher });
  assert.deepEqual(objs.order, ['runpod']);
  await assert.rejects(cap.setPlaytestCapacity({ providers: ['aws'] }, loadSettings(), { get, fetcher: r.fetcher }), (e: any) => e.status === 409 && /suspended/.test(e.message));
  await assert.rejects(cap.setPlaytestCapacity({ providers: ['gcp'] }, loadSettings(), { get, fetcher: r.fetcher }), /unknown provider/);
  await assert.rejects(cap.setPlaytestCapacity({ providers: [] }, loadSettings(), { get, fetcher: r.fetcher }), /at least one/);
  await assert.rejects(cap.setPlaytestCapacity({ providers: 'runpod' }, loadSettings(), { get, fetcher: r.fetcher }), (e: any) => e.status === 400);
});

test('PUT modal: the endpoint once deployed; a URL that isn\'t Modal\'s is refused before anything is saved', async () => {
  base();
  const r = fakeRunpod();
  await assert.rejects(cap.setPlaytestCapacity({ modal: { url: 'https://evil.example.com' } }, loadSettings(), { get, fetcher: r.fetcher }), /modal\.url/);
  assert.equal(loadSettings().playtest.modal.url, null);
  const out = await cap.setPlaytestCapacity({ modal: { url: MODAL, maxInstances: 3 }, providers: ['runpod', 'modal', 'cloudrun-cpu'] }, loadSettings(), { get, fetcher: r.fetcher });
  assert.equal(out.applied.modal!.url, MODAL);
  const m = out.providers.find((p) => p.id === 'modal')!;
  assert.equal(m.deployed, true);
  assert.equal(m.ok, true);
  assert.equal(m.browsers, 6);
});

test('the route: customers never reach it; admins read; only the owner changes it; a bad body is a 4xx with the reason', async () => {
  const http = await import('node:http');
  const { handle } = await import('../src/api.ts');
  const { createClient } = await import('../src/auth.ts');
  saveSettings({ queue: { projects: ['usr_*'] } } as any);
  base();
  const server = http.createServer((req, res) => handle(req, res).catch((e: any) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/playtest/capacity`;
  const customer = createClient('a customer (test)', 'user', ['usr_cccc']).key;
  const admin = createClient('admin (test)', 'admin', ['*']).key;
  const owner = createClient('studio (test)', 'owner', ['*']).key;
  const call = (key: string, method = 'GET', body?: unknown) => fetch(url, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await call(customer)).status, 403);
    assert.equal((await call(customer, 'PUT', { providers: ['runpod'] })).status, 403);
    const got = await call(admin);
    assert.equal(got.status, 200);
    assert.ok(Array.isArray((await got.json() as any).providers));
    assert.equal((await call(admin, 'PUT', { providers: ['runpod'] })).status, 403);
    const bad = await call(owner, 'PUT', { providers: ['gcp'] });
    assert.equal(bad.status, 400);
    assert.match((await bad.json() as any).error, /unknown provider/);
    const ok = await call(owner, 'PUT', { providers: ['runpod', 'cloudrun-cpu'] });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json() as any).applied.providers, ['runpod', 'cloudrun-cpu']);
  } finally {
    server.close();
  }
});
