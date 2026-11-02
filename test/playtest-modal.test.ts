// Playtests on Modal and the provider order (docs/playtest-runpod.md, "Modal" and "Provider order"), with no Modal: the
// settings (only a *.modal.run endpoint or a local container), the order (Studio's, software always last, disabled ones
// left out, a project's own backend still wins), Modal's headers (the proxy token only to modal.run), a refusal for
// money that ends the try at once, the host and its usage row, cooldowns, the runner router, the queue's lane and the
// deploy script's app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-playtest-modal-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
const pc = await import('../src/providers/playtester/cloudrun.ts');
const { saveSettings, SETTINGS_DEFAULTS, cleanPlaytestOrder, cleanRunners } = await import('../src/config.ts');
const { markDown, resetHealth } = await import('../src/providers/gpu/health.ts');
const { setRunpodCredit } = await import('../src/providers/gpu/credit.ts');

const MODAL = 'https://jgriffith3433--hawkes-gen-playtest-browser.modal.run';
const RP = 'https://43vc12r3r5gj4n.api.runpod.ai';
const CPU_URL = 'https://gen-playtest-cpu-abc123-uk.a.run.app';
const L4_URL = 'https://gen-playtest-abc123-uc.a.run.app';
const ENV = { MODAL_PROXY_KEY: 'wk-1', MODAL_PROXY_SECRET: 'ws-1', GPU_WORKER_TOKEN: 'gw_token', RUNPOD_API_KEY: 'rp' };
const CPU_SPEC = { name: 'gen-playtest-cpu', region: 'europe-west2', gpu: null, cpu: 4, memoryGi: 8, maxInstances: 4, tabsPerInstance: 1, timeoutSeconds: 3600, variant: 'cpu' as const };
const GPU_SPEC = { name: 'gen-playtest', region: 'us-central1', gpu: 'nvidia-l4', cpu: 8, memoryGi: 32, maxInstances: 2, tabsPerInstance: 4, timeoutSeconds: 3600, variant: 'gpu' as const };
const specs = { cpu: CPU_SPEC, gpu: GPU_SPEC };

test('settings.playtest.modal: off by default; only a modal.run endpoint or a local container; sizes clamped', () => {
  assert.equal(SETTINGS_DEFAULTS.playtest.modal.url, null);
  assert.deepEqual(SETTINGS_DEFAULTS.playtest.order, []);
  const s = saveSettings({ playtest: { modal: { url: `${MODAL}/`, maxInstances: 99, tabsPerInstance: 2, gpu: 'L4', pricePerHour: 1.12 } } } as any);
  assert.equal(s.playtest.modal.url, MODAL);
  assert.equal(s.playtest.modal.maxInstances, 20);
  assert.equal(saveSettings({ playtest: { modal: { url: 'http://127.0.0.1:8095' } } } as any).playtest.modal.url, 'http://127.0.0.1:8095');
  for (const bad of ['https://evil.example.com', 'http://x--y.modal.run', 'https://x.modal.run.evil.com', 'https://a.b.modal.run']) {
    assert.equal(saveSettings({ playtest: { modal: { url: bad } } } as any).playtest.modal.url, null, bad);
  }
  // A partial patch keeps the rest.
  saveSettings({ playtest: { modal: { url: MODAL } } } as any);
  assert.equal(saveSettings({ playtest: { runpod: { url: RP } } } as any).playtest.modal.url, MODAL);
  assert.equal(saveSettings({}).playtest.runpod.workerQuota, 10, 'RunPod\'s account worker quota defaults to 10');
  saveSettings({ playtest: { modal: { url: null }, runpod: { url: null } } } as any);
});

test('the provider order: known ids once, software WebGL always last', () => {
  assert.deepEqual(cleanPlaytestOrder(['cloudrun-cpu', 'modal', 'aws', 'runpod', 'modal', 7]), ['modal', 'runpod', 'cloudrun-cpu']);
  assert.deepEqual(cleanPlaytestOrder('runpod'), []);
  const s = saveSettings({ playtest: { order: ['cloudrun-cpu', 'runpod', 'modal'], disabled: ['nope', 'cloudrun'] } } as any);
  assert.deepEqual(s.playtest.order, ['runpod', 'modal', 'cloudrun-cpu']);
  assert.deepEqual(s.playtest.disabled, ['cloudrun']);
  saveSettings({ playtest: { order: [], disabled: [] } } as any);
});

test('cloudPlaytestsFor: the order when set (disabled ones out), else the backend; a project\'s own backend wins', () => {
  const base = { ...SETTINGS_DEFAULTS.playtest, backend: 'runpod' as const, runpod: { ...SETTINGS_DEFAULTS.playtest.runpod, url: RP }, modal: { ...SETTINGS_DEFAULTS.playtest.modal, url: MODAL }, cloudrun: { ...SETTINGS_DEFAULTS.playtest.cloudrun, url: L4_URL }, cloudrunCpu: { ...SETTINGS_DEFAULTS.playtest.cloudrunCpu, url: CPU_URL } };
  const variants = (t: any, project: string | null = null) => pc.cloudPlaytestsFor(project, { playtest: t }, specs).map((c) => c.variant);
  assert.deepEqual(variants(base), ['runpod', 'modal', 'cpu'], 'no order: the backend rule, with Modal as the second GPU provider');
  assert.deepEqual(variants({ ...base, modal: { ...base.modal, url: null } }), ['runpod', 'cpu'], 'no order, Modal not deployed: as before');
  assert.deepEqual(variants({ ...base, backend: 'cloudrun' }), ['gpu', 'modal', 'cpu']);
  assert.deepEqual(variants({ ...base, order: ['runpod', 'modal', 'cloudrun-cpu'] }), ['runpod', 'modal', 'cpu']);
  assert.deepEqual(variants({ ...base, order: ['modal', 'runpod', 'cloudrun', 'cloudrun-cpu'], disabled: ['runpod'] }), ['modal', 'gpu', 'cpu']);
  assert.deepEqual(variants({ ...base, order: ['modal', 'cloudrun-cpu'], modal: { ...base.modal, url: null } }), ['cpu'], 'Modal not deployed: skipped');
  assert.deepEqual(variants({ ...base, order: ['modal', 'cloudrun-cpu'], projects: { siteonly: 'cloudrun-cpu' } }, 'siteonly'), ['cpu'], 'a project\'s own backend');
  const m = pc.cloudPlaytestsFor(null, { playtest: { ...base, order: ['modal'] } }, specs)[0];
  assert.equal(m.name, 'modal hawkes-gen-playtest-browser');
  assert.equal(m.region, 'Modal');
  assert.equal(m.software, null);
  assert.ok(Math.abs(m.pricePerSecond - 1.12 / 3600) < 1e-9);
  assert.equal(pc.cloudLaneKey(m), 'playtest-modal');
  assert.equal(pc.providerOfVariant('modal'), 'modal');
  assert.equal(pc.providerOfVariant('gpu'), 'cloudrun');
  assert.equal(pc.providerOfVariant('cpu'), 'cloudrun-cpu');
});

test('Modal\'s headers: the proxy token only to *.modal.run, the image\'s token always', async () => {
  assert.deepEqual(pc.modalHeaders(MODAL, ENV), { 'Modal-Key': 'wk-1', 'Modal-Secret': 'ws-1', 'X-Hawkes-Token': 'gw_token' });
  assert.deepEqual(pc.modalHeaders('http://127.0.0.1:8095', ENV), { 'X-Hawkes-Token': 'gw_token' }, 'a local container never sees the proxy token');
  assert.deepEqual(pc.modalHeaders(MODAL, { ...ENV, PLAYTEST_MODAL_TOKEN: 'own' })['X-Hawkes-Token'], 'own');
  assert.deepEqual(pc.modalHeaders(MODAL, { GPU_WORKER_TOKEN: 'gw' }), { 'X-Hawkes-Token': 'gw' }, 'no proxy token: none sent');
  assert.deepEqual(await pc.headersFor({ url: MODAL, variant: 'modal' }, async () => 'never', ENV), pc.modalHeaders(MODAL, ENV));
});

test('connectOne on Modal: waits through a cold start, but a refusal for money ends the try at once', async () => {
  let now = 0;
  const deps = { idToken: async () => 'never', sleep: async (ms: number) => { now += ms; }, now: () => now, env: ENV };
  let calls = 0;
  let sent: any = null;
  const slow = { connect: async (_ws: string, o: any) => { sent = o.headers; if (++calls < 3) throw new Error('browserType.connect: Timeout 300000ms exceeded'); return { id: 'gpu' }; } };
  assert.deepEqual(await pc.connectOne(slow, { url: MODAL, variant: 'modal' }, { timeoutMs: 12 * 60_000, deps }), { id: 'gpu' });
  assert.equal(sent['Modal-Key'], 'wk-1');
  calls = 0;
  const broke = { connect: async () => { calls++; throw new Error('WebSocket error: 402 Payment Required (workspace spend limit reached)'); } };
  await assert.rejects(pc.connectOne(broke, { url: MODAL, variant: 'modal' }, { deps }), /^Error: Modal playtest service: .*402/);
  assert.equal(calls, 1, 'not tried again');
  assert.ok(pc.refusedForMoney(new Error('billing limit reached')));
  assert.ok(!pc.refusedForMoney(new Error('503 Service Unavailable')));
});

test('openCloudPlaytestHost on Modal: a GPU host, its label, and a modal-playtest usage row', async () => {
  const usage: any[] = [];
  const browser = { contexts: () => [], isConnected: () => true, newContext: async () => ({}), close: async () => {} };
  const c = pc.modalPlaytest({ ...SETTINGS_DEFAULTS.playtest.modal, url: MODAL });
  const steps: string[] = [];
  const host = await pc.openCloudPlaytestHost(c, { pageUrl: 'https://doseofdestruction.com/Game/', chromium: { connect: async () => browser }, step: (s) => steps.push(s), onUsage: (u) => usage.push(u), connectDeps: { idToken: async () => '', sleep: async () => {}, now: () => Date.now(), env: ENV } });
  assert.equal(host.backend, 'modal');
  assert.equal(host.software, null);
  assert.equal(host.server, 'Modal hawkes-gen-playtest-browser (L4)');
  assert.match(steps[0], /Modal/);
  host.close();
  assert.equal(usage[0].provider, 'modal-playtest');
  assert.match(usage[0].detail, /container's 60 s idle tail/);
});

test('cooldowns: a provider that refused us is skipped by key; a router runner by its own key', () => {
  resetHealth();
  const m = pc.modalPlaytest({ ...SETTINGS_DEFAULTS.playtest.modal, url: MODAL });
  assert.equal(pc.providerDown(m), null);
  markDown(pc.providerHealthKey('modal'), 'Modal playtest service: 402', 60_000);
  assert.match(pc.providerDown(m)!.reason, /402/);
  assert.equal(pc.providerDown({ ...m, runner: 'modal-a' }), null, 'a runner cools down under runner:<id>');
  markDown('runner:modal-a', 'x', 60_000);
  assert.ok(pc.providerDown({ ...m, runner: 'modal-a' }));
  resetHealth();
});

test('the runner router: Modal as an implicit web runner and as a listed one', async () => {
  const { runnersFor, runnerCandidates, browserService, resetRunners } = await import('../src/providers/playtester/runners.ts');
  resetRunners();
  const t = { ...SETTINGS_DEFAULTS.playtest, order: ['runpod', 'modal', 'cloudrun-cpu'] as any, runpod: { ...SETTINGS_DEFAULTS.playtest.runpod, url: RP }, modal: { ...SETTINGS_DEFAULTS.playtest.modal, url: MODAL }, cloudrunCpu: { ...SETTINGS_DEFAULTS.playtest.cloudrunCpu, url: CPU_URL } };
  const ids = runnersFor(null, { playtest: t }, specs).map((x) => `${x.runner.id}:${x.runner.provider}`);
  assert.deepEqual(ids, ['runpod:runpod', 'modal:modal', 'cloudrun-cpu-europe-west2:cloudrun-cpu']);
  // RunPod out of credit: the router skips it with the reason and Modal comes first, before software.
  setRunpodCredit({ balance: -0.01, at: Date.now() });
  const c = runnerCandidates({ project: null }, 'web', 'studio', { playtest: t }, { get: (k) => (ENV as any)[k], specs });
  assert.deepEqual(c.choices.map((x) => x.runner.id), ['modal', 'cloudrun-cpu-europe-west2']);
  assert.match(c.skipped.join('\n'), /runpod: RunPod is out of credit/);
  setRunpodCredit(null);
  const [listed] = cleanRunners([{ id: 'modal-l4', provider: 'modal', url: null, targets: ['web'], maxConcurrent: 4 }]);
  assert.equal(listed.provider, 'modal');
  const svc = browserService(listed, { playtest: t });
  assert.equal(svc?.variant, 'modal');
  assert.equal(svc?.url, MODAL);
  assert.equal(svc?.maxInstances, 2, '4 runs at 2 browsers a container');
});

test('the queue: with RunPod out of credit, a playtest takes the next provider\'s lane (Modal), not RunPod\'s', async () => {
  const { db } = await import('../src/db.ts');
  const { submit, queue } = await import('../src/jobs.ts');
  saveSettings({ playtest: { backend: 'runpod', order: ['runpod', 'modal', 'cloudrun-cpu'], runpod: { url: RP, maxInstances: 5, tabsPerInstance: 2 }, modal: { url: MODAL, maxInstances: 1, tabsPerInstance: 2 } } } as any);
  setRunpodCredit({ balance: -0.01, at: Date.now() });
  process.env.RUNPOD_API_KEY = 'rp';
  const q = queue as any;
  q.pump = () => {};
  const started: string[] = [];
  q.runJob = (j: { id: string }) => {
    started.push(j.id);
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(j.id);
    return new Promise(() => {});
  };
  const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;
  const play = () => submit(owner, { tool: 'playtest.run', project: 'gpugame', params: { url: 'https://doseofdestruction.com/Game/', gpu: 'require' } });
  const [a, b, c] = [play(), play(), play()];
  await q.fill();
  assert.ok(started.includes(a.id) && started.includes(b.id));
  assert.ok(!started.includes(c.id), 'Modal\'s one container plays two');
  assert.equal(q.lanes.get('playtest-modal')?.size, 2);
  delete process.env.RUNPOD_API_KEY;
  setRunpodCredit(null);
});

test('the deploy script: a scale-to-zero GPU web endpoint behind proxy auth, with no secret in the file', async () => {
  const { playtestApp, pricePerHour } = await import('../tools/playtest-modal/deploy.mjs' as any);
  const py: string = playtestApp({ image: 'ghcr.io/jgriffith3433/hawkes-gen-playtest:latest', app: 'hawkes-gen-playtest', gpu: 'L4', max: 2, tabs: 2, idle: 60, token: 'secret-value' });
  assert.match(py, /requires_proxy_auth=True/);
  assert.match(py, /gpu="L4"/);
  assert.match(py, /max_containers=2/);
  assert.match(py, /scaledown_window=60/);
  assert.match(py, /"HAWKES_TABS": "2"/);
  assert.match(py, /modal\.Secret\.from_name\("hawkes-gen-playtest"\)/);
  assert.doesNotMatch(py, /min_containers|keep_warm|secret-value/);
  assert.equal(pricePerHour('L4'), 1.12);
});
