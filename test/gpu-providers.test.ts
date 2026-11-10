// GPU providers beyond the fleet and Cloud Run (docs/gpu-providers.md), with no account anywhere: the settings, the
// routing order and its fallback (unset order = the old rule, exactly), cooldowns, the fleet's egress rule, the storage
// broker's tokens and route, V4 signed URLs checked with a real RSA key, the run protocol against a fake RunPod/Modal,
// a job falling from a refusing provider to the next through the queue, and worker.py's BrokerStore against the broker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-gpu-providers-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
process.env.HAWKESGEN_PUBLIC_URL = 'https://gen.example.test';
delete process.env.K_SERVICE;

const { loadServiceMap, cloudRoute } = await import('../src/providers/cloudrun/services.ts');
const { cloudComfyRun, runKey, setCloudDeps } = await import('../src/providers/cloudrun/run.ts');
const { gpuCandidates, orderFor, endpointService } = await import('../src/providers/gpu/route.ts');
const { markDown, markUp, isDown, resetHealth, awsRefused, COOLDOWN, healthOf, BUSY_WAIT_MS, DEFAULT_COLD_WAIT_MS, WARM_MS } = await import('../src/providers/gpu/health.ts');
const { checkRunpodCredit, runpodCreditProblem, runpodCredit, setRunpodCredit } = await import('../src/providers/gpu/credit.ts');
const { brokerToken, readToken, allowed, resetBrokerKey } = await import('../src/providers/gpu/broker.ts');
const { handleBroker } = await import('../src/providers/gpu/brokerRoute.ts');
const { signedGetUrl } = await import('../src/providers/gpu/sign.ts');
const { fleetBlocked, NO_EGRESS } = await import('../src/providers/gpu/egress.ts');
const { endpointHeaders } = await import('../src/providers/gpu/auth.ts');
const { fleetCredentialProblem } = await import('../src/providers/gpu/route.ts');
const { gpuStatus } = await import('../src/providers/gpu/status.ts');
const { cleanProviders, saveSettings, loadSettings, SETTINGS_DEFAULTS, ROOT } = await import('../src/config.ts');

const map = loadServiceMap();
const KEYS: Record<string, string> = { RUNPOD_API_KEY: 'rp-key', MODAL_PROXY_KEY: 'wk-1', MODAL_PROXY_SECRET: 'ws-1', GPU_HTTP_TOKEN: 'h-tok', AWS_ACCESS_KEY_ID: 'ak', AWS_SECRET_ACCESS_KEY: 'sk' };
const get = (k: string) => KEYS[k];
const none = () => undefined;
const comfyTool = { provider: 'comfy', gpuSeconds: () => 30 } as any;
const ep = (over: any = {}) => ({ id: 'runpod-a', provider: 'runpod', url: 'https://abc.api.runpod.ai', families: ['*'], gpu: 'L40S', pricePerHour: 1.75, maxConcurrent: 2, graphLimitSeconds: 300, enabled: true, ...over });
const gpuSettings = (gpu: any = {}) => ({
  gpu: { backend: 'fleet', families: {}, providers: [], order: [], familyOrder: {}, ...gpu, cloudrun: { bucket: 'bkt', urls: {}, services: {}, ...(gpu.cloudrun ?? {}) } },
  fleet: { ...SETTINGS_DEFAULTS.fleet },
}) as any;

// ------------------------------------------------------------------ settings

test('settings: an existing file has no order and no providers, so nothing changes', () => {
  assert.deepEqual(SETTINGS_DEFAULTS.gpu.providers, []);
  assert.deepEqual(SETTINGS_DEFAULTS.gpu.order, []);
  assert.deepEqual(SETTINGS_DEFAULTS.gpu.familyOrder, {});
  assert.equal(SETTINGS_DEFAULTS.fleet.openComfyPort, false);
  assert.equal(SETTINGS_DEFAULTS.fleet.egressIp, '');
  saveSettings({ gpu: { backend: 'fleet', families: { 'z-image': 'cloudrun' } } } as any);
  const s = loadSettings();
  assert.deepEqual([s.gpu.order, s.gpu.providers, s.gpu.familyOrder], [[], [], {}]);
  assert.equal(s.gpu.families['z-image'], 'cloudrun');
});

test('settings: endpoints are validated, ids unique, orders keep only known ids, RunPod defaults to its 5.5 min limit', () => {
  const g = cleanProviders({
    providers: [
      ep(), ep({ id: 'runpod-a' }), ep({ id: 'fleet' }), ep({ id: 'bad url', url: 'http://x' }), ep({ id: 'm', provider: 'modal', url: 'http://insecure.example' }),
      { id: 'mod', provider: 'modal', url: 'https://ws--app-worker.modal.run/', families: ['video', '../x'], pricePerHour: 999 },
      { id: 'rp2', provider: 'runpod', url: 'https://q.api.runpod.ai' }, ep({ id: 'aws', provider: 'aws' }),
    ],
    order: ['cloudrun', 'mod', 'nope', 'fleet', 'mod'],
    familyOrder: { video: ['rp2', 'zzz'], 'bad family!': ['fleet'] },
  });
  assert.deepEqual(g.providers.map((p: any) => p.id), ['runpod-a', 'mod', 'rp2']);
  const mod = g.providers.find((p: any) => p.id === 'mod')!;
  assert.equal(mod.url, 'https://ws--app-worker.modal.run');
  assert.deepEqual(mod.families, ['video']);
  assert.equal(mod.pricePerHour, 100, 'a price is held to 0..100 an hour');
  assert.equal(mod.graphLimitSeconds, 3300);
  assert.equal(g.providers.find((p: any) => p.id === 'rp2')!.graphLimitSeconds, 300);
  assert.deepEqual(g.order, ['cloudrun', 'mod', 'fleet']);
  assert.deepEqual(g.familyOrder.video, ['rp2']);
  assert.equal(orderFor({ gpu: g } as any, 'video').join(), 'rp2,mod', 'an endpoint naming the family follows its own list');
  assert.equal(orderFor({ gpu: g } as any, 'z-image').join(), 'cloudrun,mod,fleet');
});

test('a second endpoint for a family is its fallback without editing familyOrder (2026-11-08: 3D had nowhere to go)', () => {
  const ep3 = (id: string, extra: any = {}) => ({ id, provider: 'runpod', url: `https://${id}.example`, families: ['rig', 'motion', 'mocap', 'blender'], gpu: 'L40S', pricePerHour: 1.75, maxConcurrent: 1, graphLimitSeconds: 1800, enabled: true, ...extra });
  const gpu: any = {
    providers: [
      { id: 'runpod', provider: 'runpod', url: 'https://r.example', families: ['*'], enabled: true },
      ep3('runpod-3d'), ep3('modal-3d', { provider: 'modal' }), ep3('off-3d', { enabled: false }),
    ],
    order: ['runpod', 'modal', 'fleet'],
    familyOrder: { motion: ['runpod-3d', 'fleet'], rig: ['modal-3d'] },
  };
  assert.equal(orderFor({ gpu }, 'motion').join(), 'runpod-3d,modal-3d,fleet', 'named endpoints go before the fleet; turned-off ones are left out');
  assert.equal(orderFor({ gpu }, 'rig').join(), 'modal-3d,runpod-3d', 'already listed ones keep their place');
  assert.equal(orderFor({ gpu }, 'z-image').join(), 'runpod,modal,fleet', 'families without their own list are unchanged');
  assert.equal(orderFor({ gpu }, null).join(), 'runpod,modal,fleet');
});

test('mesh.views3d stays on Comfy * endpoints; 3D familyOrder does not pin it to runpod-3d', () => {
  resetHealth();
  const s = gpuSettings({
    providers: [
      ep({ id: 'runpod', families: ['*'], graphLimitSeconds: 3300 }),
      ep({ id: 'runpod-3d', families: ['rig', 'motion', 'mocap', 'blender'], graphLimitSeconds: 1800 }),
    ],
    order: ['runpod', 'runpod-3d', 'fleet'],
    familyOrder: { motion: ['runpod-3d', 'fleet'], rig: ['runpod-3d', 'fleet'] },
  });
  const c = gpuCandidates({ family: 'mesh.views3d', params: {}, labels: {} }, comfyTool, s, map, Date.now(), get);
  const lanes = c.choices.map((x: any) => (x.kind === 'fleet' ? 'fleet' : x.service.lane));
  assert.ok(lanes.includes('runpod'), JSON.stringify(lanes));
  assert.ok(!lanes.includes('runpod-3d'), 'Comfy mesh.views3d must not go to the 3D image endpoint');
});

test('a RunPod worker lets a graph run 30 min (Gen holds it); the 300 s limit still picks which graphs go there', () => {
  const s = gpuSettings({ providers: [ep({ id: 'runpod', families: ['*'], graphLimitSeconds: 300 })], order: ['runpod', 'fleet'] });
  // Beta 2026-11-10: Pixal3D (a ComfyUI graph) ran past 300 s on a cold worker and the worker stopped it.
  const c = gpuCandidates({ family: 'mesh.views3d', params: {}, labels: {} }, comfyTool, s, map, Date.now(), get);
  const svc = c.choices.find((x: any) => x.kind === 'service') as any;
  assert.equal(svc.service.graphLimitSeconds, 1800);
  const long = gpuCandidates({ family: 'mesh.views3d', params: {}, labels: {} }, { ...comfyTool, gpuSeconds: () => 900 }, s, map, Date.now(), get);
  assert.ok(!long.choices.some((x: any) => x.kind === 'service'), 'a graph estimated past 300 s still skips RunPod');
});

test('endpointService: waitForInstanceMs is short only when lastOk is fresh; true cold uses coldStartSeconds', () => {
  resetHealth();
  const cold = endpointService(ep({ id: 'runpod-a', coldStartSeconds: 900 }), 'z-image', map, 'bkt', get);
  assert.equal(cold.waitForInstanceMs, 900_000, 'stale/null lastOk → coldStartSeconds');
  assert.equal(cold.coldStartMs, 900_000);
  const unset = endpointService(ep({ id: 'runpod-b' }), 'z-image', map, 'bkt', get);
  assert.equal(unset.waitForInstanceMs, DEFAULT_COLD_WAIT_MS, 'no coldStartSeconds → 12 min cold wait');
  assert.equal(unset.coldStartMs, undefined);
  markUp('runpod-a');
  const warm = endpointService(ep({ id: 'runpod-a', coldStartSeconds: 900 }), 'z-image', map, 'bkt', get);
  assert.equal(warm.waitForInstanceMs, BUSY_WAIT_MS, 'fresh lastOk → busy wait only');
  const stale = endpointService(ep({ id: 'runpod-a', coldStartSeconds: 900 }), 'z-image', map, 'bkt', get, Date.now() + WARM_MS + 1);
  assert.equal(stale.waitForInstanceMs, 900_000, 'lastOk older than WARM_MS → cold wait again');
  resetHealth();
});

// ------------------------------------------------------------------ routing

test('routing with no order is the old rule, exactly (Cloud Run when settings send the family there, else the fleet)', () => {
  const cases = [
    gpuSettings(),
    gpuSettings({ families: { 'z-image': 'cloudrun' } }),
    gpuSettings({ families: { 'z-image': 'cloudrun' }, cloudrun: { urls: { 'gen-z-image': 'https://z.run.app' } } }),
    gpuSettings({ backend: 'cloudrun', cloudrun: { urls: { 'gen-z-image': 'https://z.run.app' } } }),
    gpuSettings({ backend: 'cloudrun', cloudrun: { bucket: null, urls: { 'gen-z-image': 'https://z.run.app' } } }),
  ];
  const jobs = [
    { family: 'z-image', params: {}, labels: {} },
    { family: 'z-image', params: {}, labels: { gpuBackend: 'fleet' } },
    { family: 'blender', params: {}, labels: {} },
  ];
  for (const s of cases) for (const j of jobs) for (const tool of [comfyTool, { ...comfyTool, server: 'ssh' }, { provider: 'local' }]) {
    const old = cloudRoute(j, tool, s, map);
    const now = gpuCandidates(j, tool, s, map, Date.now(), get);
    assert.equal(now.choices.length, 1);
    if (old.service) {
      assert.equal(now.choices[0].kind, 'service');
      const svc = (now.choices[0] as any).service;
      assert.equal(svc.name, old.service.name);
      assert.equal(svc.url, old.service.url);
      assert.equal(svc.headers, undefined, 'Cloud Run keeps its Google ID token');
      assert.equal(svc.broker, undefined, 'and its own bucket access');
    } else assert.equal(now.choices[0].kind, 'fleet');
  }
});

test('routing by order: skips what is not set up, cooling down, already tried, another family or too long a graph', () => {
  resetHealth();
  const s = gpuSettings({
    order: ['mod', 'runpod-a', 'cloudrun', 'http-x', 'fleet'],
    providers: [ep(), ep({ id: 'mod', provider: 'modal', url: 'https://m.modal.run', families: ['video'], graphLimitSeconds: 3300 }), ep({ id: 'http-x', provider: 'http', url: 'https://gpu.example' })],
    cloudrun: { urls: { 'gen-z-image': 'https://z.run.app' } },
  });
  const job = { family: 'z-image', params: {}, labels: {} };
  let r = gpuCandidates(job, comfyTool, s, map, Date.now(), get);
  assert.deepEqual(r.choices.map((c: any) => c.kind === 'fleet' ? 'fleet' : c.service.lane), ['runpod-a', 'gen-z-image', 'http-x', 'fleet']);
  assert.ok(r.skipped.some((x: string) => /mod: doesn't run the z-image family/.test(x)));
  const rp = (r.choices[0] as any).service;
  assert.equal(rp.provider, 'runpod');
  assert.equal(rp.broker, true);
  assert.equal(rp.preload.size, 0, 'no preloads elsewhere');
  assert.ok(rp.familyModels.length > 0, 'the family\'s models ride along');
  assert.equal(rp.headers().Authorization, 'Bearer rp-key');

  // No keys: those endpoints and the fleet (no AWS credentials) are skipped with the reason, as lasting; Cloud Run stays.
  r = gpuCandidates(job, comfyTool, s, map, Date.now(), none);
  assert.deepEqual(r.choices.map((c: any) => c.kind === 'fleet' ? 'fleet' : c.service.lane), ['gen-z-image']);
  assert.ok(r.blockers.some((b: any) => /^fleet: no AWS credentials/.test(b.reason) && b.lasting), JSON.stringify(r.blockers));
  assert.ok(r.skipped.some((x: string) => /runpod-a: RUNPOD_API_KEY not set/.test(x)));
  // A job that only the fleet can run gets no choice and a lasting blocker, so it fails at once instead of trying AWS.
  r = gpuCandidates({ ...job, labels: { gpuBackend: 'fleet' } }, comfyTool, s, map, Date.now(), none);
  assert.equal(r.choices.length, 0);
  assert.equal(r.blockers[0].lasting, true);
  // Federation or an instance role counts as credentials.
  assert.equal(fleetCredentialProblem((k: string) => ({ HAWKES_AWS_FEDERATION: 'gce' } as any)[k]), '');
  assert.equal(fleetCredentialProblem((k: string) => ({ K_SERVICE: 'gen', HAWKES_AWS_ROLE_ARN: 'arn' } as any)[k]), '');
  assert.equal(fleetCredentialProblem((k: string) => ({ HAWKES_AWS_ROLE: '1' } as any)[k]), '');

  // Cooling down and already tried.
  markDown('runpod-a', 'no GPU free', COOLDOWN.capacity);
  r = gpuCandidates({ ...job, labels: { gpuTried: ['gen-z-image'] } }, comfyTool, s, map, Date.now(), get);
  assert.deepEqual(r.choices.map((c: any) => c.kind === 'fleet' ? 'fleet' : c.service.lane), ['http-x', 'fleet']);
  assert.ok(r.skipped.some((x: string) => /runpod-a: no GPU free \(skipped for 5 min\)/.test(x)));
  assert.ok(isDown('runpod-a'));
  assert.equal(isDown('runpod-a', Date.now() + COOLDOWN.capacity + 1), null, 'the cooldown ends');

  // A graph longer than RunPod's 300 s goes elsewhere; SSH tools and forced jobs get the fleet alone.
  resetHealth();
  r = gpuCandidates(job, { provider: 'comfy', gpuSeconds: () => 900 } as any, s, map, Date.now(), get);
  assert.ok(!r.choices.some((c: any) => c.kind === 'service' && c.service.lane === 'runpod-a'));
  assert.deepEqual(gpuCandidates(job, { ...comfyTool, server: 'ssh' }, s, map, Date.now(), get).choices, [{ kind: 'fleet' }]);
  assert.deepEqual(gpuCandidates({ ...job, labels: { gpuBackend: 'fleet' } }, comfyTool, s, map, Date.now(), get).choices, [{ kind: 'fleet' }]);

  // Turned off; no public URL for the broker.
  const off = gpuSettings({ ...s.gpu, providers: [ep({ enabled: false })], order: ['runpod-a'] });
  assert.equal(gpuCandidates(job, comfyTool, off, map, Date.now(), get).choices.length, 0);
  const saved = process.env.HAWKESGEN_PUBLIC_URL;
  delete process.env.HAWKESGEN_PUBLIC_URL;
  try {
    r = gpuCandidates(job, comfyTool, gpuSettings({ providers: [ep()], order: ['runpod-a'] }), map, Date.now(), get);
    assert.equal(r.choices.length, 0);
    assert.match(r.skipped.join(), /HAWKESGEN_PUBLIC_URL/);
  } finally { process.env.HAWKESGEN_PUBLIC_URL = saved; }
});

test('auth headers per provider; a missing key is an "unavailable" auth error', () => {
  assert.deepEqual(endpointHeaders('modal', get), { 'Modal-Key': 'wk-1', 'Modal-Secret': 'ws-1' });
  assert.deepEqual(endpointHeaders('http', get), { Authorization: 'Bearer h-tok' });
  assert.equal(endpointHeaders('runpod', (k) => ({ ...KEYS, GPU_WORKER_TOKEN: 'w' })[k])['X-Hawkes-Worker-Token'], 'w');
  assert.throws(() => endpointHeaders('runpod', none), (e: any) => e.unavailable && e.auth);
});

// ------------------------------------------------------------------ the fleet: AWS refusals and egress

test('AWS refusing our credentials or a suspended account is recognised (the fleet then cools down quietly)', () => {
  for (const m of [
    'The security token included in the request is invalid.',
    'AWS was not able to validate the provided access credentials (AuthFailure)',
    'InvalidClientTokenId: The security token included in the request is invalid',
    'Your account is suspended (AccountSuspended)',
    'OptInRequired: You are not subscribed to this service',
  ]) assert.ok(awsRefused(m), m);
  for (const m of ['InsufficientInstanceCapacity', 'no GPU server is ready', 'ECONNRESET']) assert.ok(!awsRefused(m), m);
});

test('egress: on Cloud Run the fleet needs a fixed address or the explicit open port; elsewhere nothing changes', () => {
  const env = (o: Record<string, string>) => (k: string) => o[k];
  assert.equal(fleetBlocked({}, env({})), null, 'J\'s PC or a VM');
  assert.equal(fleetBlocked({}, env({ K_SERVICE: 'gen' })), NO_EGRESS);
  assert.equal(fleetBlocked({ egressIp: '34.1.2.3' }, env({ K_SERVICE: 'gen' })), null);
  assert.equal(fleetBlocked({}, env({ K_SERVICE: 'gen', HAWKES_PUBLIC_IP: '34.1.2.3' })), null);
  assert.equal(fleetBlocked({ egressIp: 'nope' }, env({ K_SERVICE: 'gen' })), NO_EGRESS);
  assert.equal(fleetBlocked({ openComfyPort: true }, env({ K_SERVICE: 'gen' })), null);
  // The status shows it.
  const st = gpuStatus({ ...gpuSettings(), fleet: { ...SETTINGS_DEFAULTS.fleet } }, map, env({ K_SERVICE: 'gen' }));
  const fleet = st.providers.find((p: any) => p.id === 'fleet')!;
  assert.equal(fleet.ready, false);
  assert.equal(fleet.problem, NO_EGRESS);
  assert.equal(st.legacy, true);
});

// ------------------------------------------------------------------ the broker

const KEY = 'a'.repeat(64);

test('broker tokens: one run, its own folder read-write, inputs and models read-only, expired or forged refused', () => {
  resetBrokerKey();
  const now = 1_700_000_000_000;
  const t = brokerToken(KEY, 'my.bucket', now);
  assert.deepEqual(readToken(t, now + 1000), { key: KEY, bucket: 'my.bucket' });
  assert.equal(readToken(t, now + 7 * 3600_000), null, 'expired after 6 hours');
  assert.equal(readToken(t.slice(0, -2) + 'xx', now), null, 'forged signature');
  assert.equal(readToken(t.replace(KEY, 'b'.repeat(64)), now), null, 'another run');
  assert.equal(readToken('junk', now), null);
  const run = { key: KEY, bucket: 'my.bucket' };
  assert.ok(allowed(run, 'write', `gs://my.bucket/cloudrun/runs/${KEY}/00-out.png`));
  assert.ok(allowed(run, 'read', `gs://my.bucket/cloudrun/runs/${KEY}/manifest.json`));
  assert.ok(allowed(run, 'url', 'gs://my.bucket/models/vae/ae.safetensors'));
  assert.ok(allowed(run, 'read', 'gs://my.bucket/cloudrun/inputs/abc.png'));
  assert.ok(!allowed(run, 'write', 'gs://my.bucket/models/vae/ae.safetensors'), 'models are read-only');
  assert.ok(!allowed(run, 'write', 'gs://my.bucket/cloudrun/inputs/abc.png'));
  assert.ok(!allowed(run, 'read', `gs://my.bucket/cloudrun/runs/${'b'.repeat(64)}/manifest.json`), 'another run\'s folder');
  assert.ok(!allowed(run, 'read', 'gs://other/models/x'), 'another bucket');
  assert.ok(!allowed(run, 'read', `gs://my.bucket/cloudrun/runs/${KEY}/../../library/x`), 'no ..');
  assert.ok(!allowed(run, 'read', 'gs://my.bucket/library/secret.png'));
});

/** The broker route on a real port, over in-memory objects. */
async function brokerServer(objects: Map<string, Buffer>, signer: any = null, sources: Record<string, { url: string; size: number }> = {}) {
  const deps = {
    source: async (uri: string) => sources[uri] ?? null,
    stat: async (uri: string) => (objects.has(uri) ? { size: objects.get(uri)!.length } : null),
    write: async (uri: string, data: Buffer) => { objects.set(uri, data); },
    open: async (uri: string, range?: string) => {
      const b = objects.get(uri);
      if (!b) return null;
      const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!m) return new Response(new Uint8Array(b), { status: 200, headers: { 'content-length': String(b.length) } });
      const [s, e] = [Number(m[1]), Math.min(Number(m[2]), b.length - 1)];
      return new Response(new Uint8Array(b.subarray(s, e + 1)), { status: 206, headers: { 'content-length': String(e - s + 1), 'content-range': `bytes ${s}-${e}/${b.length}` } });
    },
    signer: async () => signer,
  };
  const srv = http.createServer((req, res) => void handleBroker(req, res, new URL(req.url!, 'http://localhost'), deps as any));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, url: `http://127.0.0.1:${(srv.address() as any).port}/v1/gpu/broker` };
}

test('the broker route: stat, read with ranges, write, url (proxy without a signer), and refusals', async () => {
  resetBrokerKey();
  const objects = new Map([['gs://bkt/models/vae/ae.safetensors', Buffer.from('0123456789')]]);
  const { srv, url } = await brokerServer(objects);
  try {
    const tok = brokerToken(KEY, 'bkt');
    const call = (op: string, uri: string, init: any = {}) => fetch(`${url}?op=${op}&uri=${encodeURIComponent(uri)}`, { ...init, headers: { 'X-Hawkes-Run-Token': tok, ...(init.headers ?? {}) } });
    assert.deepEqual(await (await call('stat', 'gs://bkt/models/vae/ae.safetensors')).json(), { size: 10 });
    assert.equal((await call('stat', 'gs://bkt/models/vae/none')).status, 404);
    const part = await call('read', 'gs://bkt/models/vae/ae.safetensors', { headers: { Range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '2345');
    assert.deepEqual(await (await call('url', 'gs://bkt/models/vae/ae.safetensors')).json(), { proxy: true, size: 10 });
    const out = `gs://bkt/cloudrun/runs/${KEY}/00-out.png`;
    assert.equal((await call('write', out, { method: 'PUT', body: 'png!' })).status, 200);
    assert.equal(objects.get(out)!.toString(), 'png!');
    assert.equal((await call('write', 'gs://bkt/models/vae/ae.safetensors', { method: 'PUT', body: 'x' })).status, 403);
    assert.equal((await call('write', out)).status, 403, 'a write must be a PUT');
    assert.equal((await fetch(`${url}?op=stat&uri=${encodeURIComponent(out)}`)).status, 401, 'no token');
    assert.equal((await fetch(`${url}?op=stat&uri=${encodeURIComponent(out)}`, { headers: { 'X-Hawkes-Run-Token': brokerToken(KEY, 'other') } })).status, 403, 'a token for another bucket');
  } finally { srv.close(); }
});

test('a model the bucket lacks comes from its public source (Hugging Face): url and stat answer it, nothing else does', async () => {
  resetBrokerKey();
  const hf = 'https://huggingface.co/x/y/resolve/main/z.safetensors';
  const { srv, url } = await brokerServer(new Map(), null, { 'gs://bkt/models/vae/z.safetensors': { url: hf, size: 123 } });
  try {
    const tok = brokerToken(KEY, 'bkt');
    const call = (op: string, uri: string) => fetch(`${url}?op=${op}&uri=${encodeURIComponent(uri)}`, { headers: { 'X-Hawkes-Run-Token': tok } });
    assert.deepEqual(await (await call('url', 'gs://bkt/models/vae/z.safetensors')).json(), { url: hf, size: 123, from: 'huggingface' });
    assert.deepEqual(await (await call('stat', 'gs://bkt/models/vae/z.safetensors')).json(), { size: 123 });
    assert.equal((await call('url', 'gs://bkt/models/vae/unknown.safetensors')).status, 404);
    assert.equal((await call('url', `gs://bkt/cloudrun/runs/${KEY}/nothing.png`)).status, 404, 'only models have a public source');
  } finally { srv.close(); }
});

test('the real model lookup finds models.json entries by dir/file (no network for an unknown file)', async () => {
  const { defaultBrokerDeps } = await import('../src/providers/gpu/brokerRoute.ts');
  assert.equal(await defaultBrokerDeps().source('gs://bkt/models/vae/not-a-model.safetensors'), null);
  assert.equal(await defaultBrokerDeps().source('gs://bkt/cloudrun/inputs/x.png'), null);
});

test('V4 signed URLs: the canonical request is signed as the service account (checked with a real RSA key)', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signer = { email: 'gen-control@hawkes-staging.iam.gserviceaccount.com', sign: async (b: Buffer) => crypto.sign('RSA-SHA256', b, privateKey) };
  const now = new Date('2026-10-28T12:34:56Z');
  const u = new URL(await signedGetUrl('gs://bkt/models/diffusion models/a+b.safetensors', signer, 900, now));
  assert.equal(u.host, 'storage.googleapis.com');
  assert.equal(u.pathname, '/bkt/models/diffusion%20models/a%2Bb.safetensors');
  assert.equal(u.searchParams.get('X-Goog-Algorithm'), 'GOOG4-RSA-SHA256');
  assert.equal(u.searchParams.get('X-Goog-Credential'), `${signer.email}/20261028/auto/storage/goog4_request`);
  assert.equal(u.searchParams.get('X-Goog-Date'), '20261028T123456Z');
  assert.equal(u.searchParams.get('X-Goog-Expires'), '900');
  assert.equal(u.searchParams.get('X-Goog-SignedHeaders'), 'host');
  // Rebuild what Google checks and verify the signature against it.
  const query = u.search.slice(1).split('&').filter((p) => !p.startsWith('X-Goog-Signature=')).join('&');
  const canonical = ['GET', u.pathname, query, 'host:storage.googleapis.com\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', '20261028T123456Z', '20261028/auto/storage/goog4_request', crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(toSign), publicKey, Buffer.from(u.searchParams.get('X-Goog-Signature')!, 'hex')));
  // With a signer, the broker hands out the signed URL instead of streaming.
  const objects = new Map([['gs://bkt/models/vae/ae.safetensors', Buffer.from('x')]]);
  const { srv, url } = await brokerServer(objects, signer);
  try {
    const r = await (await fetch(`${url}?op=url&uri=${encodeURIComponent('gs://bkt/models/vae/ae.safetensors')}`, { headers: { 'X-Hawkes-Run-Token': brokerToken(KEY, 'bkt') } })).json() as any;
    assert.equal(r.size, 1);
    assert.match(r.url, /^https:\/\/storage\.googleapis\.com\/bkt\/models\/vae\/ae\.safetensors\?X-Goog-Algorithm=GOOG4-RSA-SHA256/);
  } finally { srv.close(); }
});

// ------------------------------------------------------------------ the run protocol elsewhere

function fakeProvider(behave: (body: any, n: number) => any[] | { status: number }) {
  const objects = new Map<string, Buffer>();
  const posts: any[] = [];
  let clock = 1_000_000;
  const store = {
    async stat(uri: string) { return objects.has(uri) ? { name: uri, size: objects.get(uri)!.length } : null; },
    async read(uri: string) { return objects.get(uri) ?? null; },
    async readJson(uri: string) { const b = objects.get(uri); return b ? JSON.parse(b.toString()) : null; },
    async write(uri: string, data: Buffer | string) { objects.set(uri, Buffer.from(data)); },
    async writeJson(uri: string, v: unknown) { objects.set(uri, Buffer.from(JSON.stringify(v))); },
  };
  return {
    objects, posts,
    deps: {
      store, idToken: async () => { throw new Error('no Google ID token elsewhere'); },
      sleep: async (ms: number) => { clock += ms; }, now: () => clock,
      fetch: (async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        posts.push({ url, body, headers: init.headers });
        const lines = behave(body, posts.length);
        if (!Array.isArray(lines)) return new Response('no', { status: lines.status });
        const enc = new TextEncoder();
        return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } }), { status: 200 });
      }) as any,
    },
  };
}
const done = (body: any, objects: Map<string, Buffer>) => {
  const uri = `${body.out}00-out.png`;
  objects.set(uri, Buffer.from('made'));
  const d = { t: 'done', files: [{ filename: 'out.png', subfolder: '', type: 'output', node: '9', uri, bytes: 4 }], seconds: 20, cold: null };
  objects.set(`${body.out}manifest.json`, Buffer.from(JSON.stringify(d)));
  return [d];
};
const hooks = () => {
  const h = { steps: [] as string[], signal: new AbortController().signal };
  return Object.assign(h, { step: (d: string) => h.steps.push(d), progress: () => {}, keepGraph: () => {}, addSeconds: () => {} });
};

test('a run on RunPod: its key in the headers, the broker store with this run\'s token, the graph\'s models along', async () => {
  resetBrokerKey();
  const s = gpuSettings({ providers: [ep()], order: ['runpod-a'] });
  const svc = (gpuCandidates({ family: 'z-image', params: {}, labels: {} }, comfyTool, s, map, Date.now(), get).choices[0] as any).service;
  const model = svc.familyModels[0] as string;
  const file = model.split('/').slice(1).join('/');
  const f = fakeProvider((body) => done(body, f.objects));
  const graph = { '1': { class_type: 'Loader', inputs: { name: file } }, '9': { class_type: 'SaveImage', inputs: {} } } as any;
  const files = await cloudComfyRun({ id: 'j_rp' }, svc, hooks() as any, f.deps as any).runGraph(graph);
  assert.equal(files[0].filename, 'out.png');
  const p = f.posts[0];
  assert.equal(p.url, 'https://abc.api.runpod.ai/run');
  assert.equal(p.headers.Authorization, 'Bearer rp-key');
  const key = runKey('j_rp', graph);
  assert.equal(p.body.store.broker, 'https://gen.example.test/v1/gpu/broker');
  assert.deepEqual(readToken(p.body.store.token), { key, bucket: 'bkt' });
  assert.ok(p.body.models.some((m: any) => `${m.dir}/${m.file}` === model), 'a family model the graph names rides along');
  // The worker's own stop is the held cap, not the 300 s routing limit: Gen holds the worker past each LB hold.
  assert.equal(p.body.timeoutSeconds, 1800);
});

test('a provider that refuses our key, or has no GPU in its wait, throws "unavailable" (the queue moves on)', async () => {
  const s = gpuSettings({ providers: [ep(), ep({ id: 'mod', provider: 'modal', url: 'https://m.modal.run' })], order: ['runpod-a', 'mod'] });
  const [rp, md] = gpuCandidates({ family: 'z-image', params: {}, labels: {} }, comfyTool, s, map, Date.now(), get).choices.map((c: any) => c.service);
  const denied = fakeProvider(() => ({ status: 401 }));
  await assert.rejects(cloudComfyRun({ id: 'j_401' }, rp, hooks() as any, denied.deps as any).runGraph({} as any), (e: any) => e.unavailable && e.auth && /refused Gen's credentials/.test(e.message));
  // Warm (it ran a job a moment ago): a busy provider gets its 3 minutes.
  markUp('mod', 1_000_000);
  const busy = fakeProvider(() => ({ status: 429 }));
  const bh = hooks();
  await assert.rejects(cloudComfyRun({ id: 'j_429' }, md, bh as any, busy.deps as any).runGraph({} as any), (e: any) => e.unavailable && e.capacity && /no modal GPU came free in 3 minutes/.test(e.message));
  assert.ok(bh.steps.some((x) => /waiting for a free modal GPU/.test(x)), JSON.stringify(bh.steps));
  assert.equal(denied.posts[0].headers['Modal-Key'], undefined);
  assert.equal(busy.posts[0].headers['Modal-Key'], 'wk-1');
});

// ------------------------------------------------------------------ through the queue

test('the queue: a job whose first provider refuses goes to the next, finishes there, and the first cools down', async () => {
  resetHealth();
  Object.assign(process.env, KEYS);
  const f = fakeProvider((body, n) => (n === 1 ? { status: 401 } : done(body, f.objects)));
  setCloudDeps(f.deps as any);
  saveSettings({ gpu: { providers: [ep({ id: 'mod', provider: 'modal', url: 'https://m.modal.run', graphLimitSeconds: 3300 }), ep({ graphLimitSeconds: 3300 })], order: ['mod', 'runpod-a'], cloudrun: { bucket: 'bkt', urls: {}, services: {} } } } as any);
  try {
    const { submit, getJob, queue } = await import('../src/jobs.ts');
    const { db } = await import('../src/db.ts');
    const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;
    const job = submit(owner, { tool: 'comfy.graph', project: 'sandbox', params: { family: 'z-image', graph: { '9': { class_type: 'SaveImage', inputs: { seed: '{{seed}}' } } } } });
    for (let i = 0; i < 200 && !['done', 'failed'].includes(getJob(job.id)!.status); i++) {
      (queue as any).pump();
      await new Promise((r) => setTimeout(r, 20));
    }
    const j = getJob(job.id)!;
    assert.equal(j.status, 'done', j.error ?? j.detail ?? '');
    assert.equal(j.server, 'runpod:runpod-a');
    assert.deepEqual(f.posts.map((p) => p.url), ['https://m.modal.run/run', 'https://abc.api.runpod.ai/run']);
    assert.deepEqual(j.labels.gpuTried, ['mod']);
    const h = healthOf('mod');
    assert.equal(h.down, true);
    assert.match(h.lastError!.reason, /refused Gen's credentials/);
    assert.ok(h.until! - Date.now() > COOLDOWN.auth - 60_000, 'a key problem cools down for 30 minutes');
    const u = db.prepare("SELECT * FROM usage WHERE job = ? AND provider = 'runpod-gpu'").get(job.id) as any;
    assert.ok(u, 'usage under the provider that ran it');
    assert.ok(Math.abs(u.cost - 20 * (1.75 / 3600)) < 1e-6);
  } finally {
    setCloudDeps(null);
    resetHealth();
    saveSettings({ gpu: { providers: [], order: [], familyOrder: {} } } as any);
  }
});

// ------------------------------------------------------------------ worker.py through the broker

test('worker.py BrokerStore: stat, read, write and a ranged download through the broker (no Google identity)', async (t) => {
  const py = ['python3', 'python', 'py'].find((p) => spawnSync(p, ['--version']).status === 0);
  if (!py) return t.skip('no Python here');
  resetBrokerKey();
  const model = crypto.randomBytes(150_000);
  const objects = new Map<string, Buffer>([['gs://bkt/models/vae/ae.safetensors', model], [`gs://bkt/cloudrun/runs/${KEY}/manifest.json`, Buffer.from('{"t":"done"}')]]);
  const { srv, url } = await brokerServer(objects);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-broker-py-'));
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'server', 'cloudrun'))})
import worker
worker.CHUNK = 40000
if not hasattr(worker.os, "pwrite"):  # Windows (the worker runs on Linux): seek and write under a lock
    import threading
    _lock = threading.Lock()
    def _pwrite(fd, buf, off):
        with _lock:
            import msvcrt
            msvcrt.setmode(fd, worker.os.O_BINARY)
            worker.os.lseek(fd, off, 0)
            return worker.os.write(fd, buf)
    worker.os.pwrite = _pwrite
st = worker.store_for({"store": {"broker": sys.argv[1], "token": sys.argv[2]}})
out = "gs://bkt/cloudrun/runs/${KEY}/"
st.write(out + "heartbeat.json", b'{"at": 1}', "application/json")
size = st.download("gs://bkt/models/vae/ae.safetensors", sys.argv[3] + "/ae.safetensors", parallel=3)
denied = None
try:
    st.write("gs://bkt/models/vae/ae.safetensors", b"x")
except Exception as e:
    denied = getattr(e, "code", str(e))
print(json.dumps({"size": size, "manifest": json.loads(st.read(out + "manifest.json")), "stat": st.stat(out + "none"), "denied": denied}))
`;
  try {
    const r = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const p = spawn(py, ['-c', code, url, brokerToken(KEY, 'bkt'), tmp], { env: { ...process.env, STORAGE: 'broker' } });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (c) => resolve({ code: c ?? 1, out, err }));
    });
    assert.equal(r.code, 0, r.err);
    const res = JSON.parse(r.out.trim().split('\n').pop()!);
    assert.equal(res.size, model.length);
    assert.ok(fs.readFileSync(path.join(tmp, 'ae.safetensors')).equals(model), 'the ranged download is byte for byte');
    assert.deepEqual(res.manifest, { t: 'done' });
    assert.equal(res.stat, null);
    assert.equal(res.denied, 403);
    assert.equal(objects.get(`gs://bkt/cloudrun/runs/${KEY}/heartbeat.json`)!.toString(), '{"at": 1}');
  } finally { srv.close(); }
});

test('the broker hands out a signed upload link (put) for the run\'s own folder only; no signer: proxy', async () => {
  resetBrokerKey();
  const signer = { email: 'gen@p.iam.gserviceaccount.com', sign: async () => Buffer.from('sig') };
  const { srv, url } = await brokerServer(new Map(), signer);
  const none = await brokerServer(new Map(), null);
  try {
    const tok = brokerToken(KEY, 'bkt');
    const call = (base: string, op: string, uri: string, method = 'GET') => fetch(`${base}?op=${op}&uri=${encodeURIComponent(uri)}`, { method, headers: { 'X-Hawkes-Run-Token': tok } });
    const out = `gs://bkt/cloudrun/runs/${KEY}/00-model.glb`;
    const u = new URL(((await (await call(url, 'put', out)).json()) as any).url);
    assert.equal(u.host, 'storage.googleapis.com');
    assert.equal(u.pathname, `/bkt/cloudrun/runs/${KEY}/00-model.glb`);
    assert.ok(u.searchParams.get('X-Goog-Signature'));
    assert.equal((await call(url, 'put', 'gs://bkt/models/vae/ae.safetensors')).status, 403, 'not outside this run');
    assert.equal((await call(url, 'put', out, 'PUT')).status, 403, 'put is a GET');
    assert.deepEqual(await (await call(none.url, 'put', out)).json(), { proxy: true });
  } finally { srv.close(); none.srv.close(); }
});

test('worker.py BrokerStore: an output over 32 MiB goes straight to storage with the signed link, never through the broker', async (t) => {
  const py = ['python3', 'python', 'py'].find((p) => spawnSync(p, ['--version']).status === 0);
  if (!py) return t.skip('no Python here');
  resetBrokerKey();
  const signer = { email: 'gen@p.iam.gserviceaccount.com', sign: async () => Buffer.from('sig') };
  const objects = new Map<string, Buffer>();
  const { srv, url } = await brokerServer(objects, signer);
  // The broker as Cloud Run is: a request body over 32 MiB is refused.
  const via = { writes: 0 };
  const front = http.createServer((req, res) => {
    if (req.method === 'PUT') {
      via.writes++;
      if (Number(req.headers['content-length'] ?? 0) > 32 * 1024 * 1024) { req.resume(); res.writeHead(413); return res.end('Request Entity Too Large'); }
    }
    void fetch(`${url}${req.url!.replace('/v1/gpu/broker', '')}`, { method: req.method, headers: { 'X-Hawkes-Run-Token': String(req.headers['x-hawkes-run-token']) }, body: req.method === 'PUT' ? (req as any) : undefined, duplex: 'half' } as any)
      .then(async (r) => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(Buffer.from(await r.arrayBuffer())); });
  });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()));
  // Cloud Storage: takes the PUT the signed link names.
  let stored = 0;
  const storage = http.createServer((req, res) => {
    req.on('data', (c: Buffer) => { stored += c.length; });
    req.on('end', () => { res.writeHead(200); res.end(); });
  });
  await new Promise<void>((r) => storage.listen(0, '127.0.0.1', () => r()));
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'server', 'cloudrun'))})
import worker
st = worker.store_for({"store": {"broker": sys.argv[1], "token": sys.argv[2]}})
real = st._put_signed
st._put_signed = lambda link, uri, data, ct: real(sys.argv[3] + "/upload", uri, data, ct)  # the signed link, pointed at the fake bucket
out = "gs://bkt/cloudrun/runs/${KEY}/00-model.glb"
r = st.write(out, b"g" * (33 * 1024 * 1024), "model/gltf-binary")
print(json.dumps(r))
`;
  try {
    const r = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const p = spawn(py, ['-c', code, `http://127.0.0.1:${(front.address() as any).port}/v1/gpu/broker`, brokerToken(KEY, 'bkt'), `http://127.0.0.1:${(storage.address() as any).port}`], { env: { ...process.env, STORAGE: 'broker' } });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (c) => resolve({ code: c ?? 1, out, err }));
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out.trim().split('\n').pop()!).direct, true);
    assert.equal(stored, 33 * 1024 * 1024, 'all of it reached storage');
    assert.equal(via.writes, 0, 'no body passed through the broker');
  } finally { srv.close(); front.close(); storage.close(); }
});

// ------------------------------------------------------------------ cold starts and RunPod's credit

test('a cold provider says it is starting a GPU (not "waiting for a free" one) and gets the cold start\'s time for 429/503', async () => {
  resetHealth();
  const s = gpuSettings({ providers: [ep({ id: 'mod', provider: 'modal', url: 'https://m.modal.run', graphLimitSeconds: 3300 })], order: ['mod'] });
  const md = (gpuCandidates({ family: 'z-image', params: {}, labels: {} }, comfyTool, s, map, Date.now(), get).choices[0] as any).service;
  // 503 for 8 minutes while the container starts (past the warm 3-minute wait), then the answer.
  let f: ReturnType<typeof fakeProvider>;
  f = fakeProvider((body, n) => (n <= 32 ? { status: 503 } : done(body, f.objects)));
  const h = hooks();
  const files = await cloudComfyRun({ id: 'j_coldmodal' }, md, h as any, f.deps as any).runGraph({ '9': { class_type: 'SaveImage', inputs: {} } } as any);
  assert.equal(files[0].filename, 'out.png');
  assert.match(h.steps[0], /starting a modal GPU \(none has run for a while; a cold start takes several minutes\)/);
  assert.ok(!h.steps.some((x) => /waiting for a free/.test(x)), JSON.stringify(h.steps));
  // Past the cold allowance it is still handed on.
  const never = fakeProvider(() => ({ status: 503 }));
  await assert.rejects(cloudComfyRun({ id: 'j_coldnever' }, md, hooks() as any, never.deps as any).runGraph({} as any), (e: any) => e.unavailable && /came free in 12 minutes/.test(e.message));
});

test('RunPod out of credit: its endpoints and playtest runners are skipped, a waiting job moves on, the card shows it', async () => {
  resetHealth();
  const fake = (balance: unknown, status = 200) => (async (url: string, init: any) => {
    assert.equal(url, 'https://api.runpod.io/graphql');
    assert.equal(init.headers.Authorization, 'Bearer rp-key');
    return new Response(JSON.stringify({ data: { myself: { clientBalance: balance } } }), { status });
  }) as any;
  // No key: nothing read, nothing skipped.
  assert.equal(await checkRunpodCredit(none, fake(1)), null);
  assert.equal(await checkRunpodCredit(get, fake(-0.006)).then((c: any) => c.balance), -0.006);
  assert.match(runpodCreditProblem(get)!, /RunPod is out of credit \(balance \$-0\.01\): add funds/);
  assert.equal(runpodCreditProblem(none), null, 'without a key RunPod is not set up anyway');
  const s = gpuSettings({ order: ['runpod-a', 'mod'], providers: [ep(), ep({ id: 'mod', provider: 'modal', url: 'https://m.modal.run' })] });
  const r = gpuCandidates({ family: 'z-image', params: {}, labels: {} }, comfyTool, s, map, Date.now(), get);
  assert.deepEqual(r.choices.map((c: any) => c.service.lane), ['mod']);
  assert.ok(r.skipped.some((x: string) => /runpod-a: RunPod is out of credit/.test(x)), JSON.stringify(r.skipped));
  const st = gpuStatus(s, map, get);
  assert.match(st.providers.find((p: any) => p.id === 'runpod-a')!.problem!, /out of credit/);
  assert.equal(st.runpodCredit!.empty, true);
  assert.equal(st.runpodCredit!.low, true);
  // A job already on RunPod (picked before the balance ran out) hands itself on instead of waiting at the gateway.
  setRunpodCredit({ balance: 3, at: Date.now() });
  const rp = (gpuCandidates({ family: 'z-image', params: {}, labels: {} }, comfyTool, s, map, Date.now(), get).choices[0] as any).service;
  setRunpodCredit({ balance: -0.006, at: Date.now() });
  const prev = process.env.RUNPOD_API_KEY;
  process.env.RUNPOD_API_KEY = 'rp-key';
  try {
    const f = fakeProvider((body) => done(body, f.objects));
    await assert.rejects(cloudComfyRun({ id: 'j_broke' }, rp, hooks() as any, f.deps as any).runGraph({} as any), (e: any) => e.unavailable && /out of credit/.test(e.message));
    assert.equal(f.posts.length, 0, 'nothing posted to the gateway');
  } finally {
    if (prev === undefined) delete process.env.RUNPOD_API_KEY; else process.env.RUNPOD_API_KEY = prev;
  }
  // Funds added: the next check clears it. RunPod's own error answer changes nothing.
  await checkRunpodCredit(get, fake(25));
  assert.equal(runpodCreditProblem(get), null);
  assert.equal(runpodCredit().low, false);
  assert.equal(await checkRunpodCredit(get, (async () => new Response('{"errors":[{"message":"bad key"}]}', { status: 401 })) as any), null);
  assert.equal(runpodCreditProblem(get), null);
  setRunpodCredit(null);
});

test('RunPod credit: a stale empty reading skips nothing, and an empty one is read again before a run skips RunPod', async () => {
  const { recheckEmptyRunpodCredit, RECHECK_EMPTY_MS } = await import('../src/providers/gpu/credit.ts');
  const get = (k: string) => (k === 'RUNPOD_API_KEY' ? 'rp-key' : undefined);
  let reads = 0;
  const fake = (balance: number) => (async () => { reads++; return new Response(JSON.stringify({ data: { myself: { clientBalance: balance } } }), { status: 200 }); }) as any;
  const t0 = 1_000_000_000;
  // Empty a moment ago: skipped, and not read again yet.
  setRunpodCredit({ balance: -0.006, at: t0 });
  assert.match(runpodCreditProblem(get, t0 + 1_000)!, /out of credit/);
  await recheckEmptyRunpodCredit(get, fake(25), () => t0 + RECHECK_EMPTY_MS - 1);
  assert.equal(reads, 0);
  // Older than that: read again, and funds added since count for this run.
  await recheckEmptyRunpodCredit(get, fake(25), () => t0 + RECHECK_EMPTY_MS + 1);
  assert.equal(reads, 1);
  assert.equal(runpodCreditProblem(get, t0 + RECHECK_EMPTY_MS + 2), null);
  // A positive reading is the watch's to keep fresh: no extra call.
  await recheckEmptyRunpodCredit(get, fake(25), () => t0 + 10 * RECHECK_EMPTY_MS);
  assert.equal(reads, 1);
  // RunPod stopped answering: an empty reading from long ago no longer keeps RunPod off.
  setRunpodCredit({ balance: -0.006, at: t0 });
  assert.equal(runpodCreditProblem(get, t0 + 16 * 60_000), null);
  setRunpodCredit(null);
});
