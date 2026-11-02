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
  // Modal's endpoints now name their region before modal.run.
  const REGIONAL = 'https://ws--hawkes-gen-playtest-browser.us-east.modal.run';
  assert.equal(saveSettings({ playtest: { modal: { url: REGIONAL } } } as any).playtest.modal.url, REGIONAL);
  assert.equal(pc.modalPlaytest({ ...SETTINGS_DEFAULTS.playtest.modal, url: REGIONAL }).name, 'modal hawkes-gen-playtest-browser');
  for (const bad of ['https://evil.example.com', 'http://x--y.modal.run', 'https://x.modal.run.evil.com', 'https://a.b.modal.run', 'https://a.us-east.b.modal.run', 'https://a.us-east.modal.run.evil.com']) {
    assert.equal(saveSettings({ playtest: { modal: { url: bad } } } as any).playtest.modal.url, null, bad);
  }
  // The deploy's PLAYTEST_MODAL_URL wins over the saved one; a bad one is ignored.
  process.env.PLAYTEST_MODAL_URL = 'https://ws--hawkes-gen-playtest-browser.us-east.modal.run/';
  assert.equal(saveSettings({ playtest: { modal: { url: null } } } as any).playtest.modal.url, 'https://ws--hawkes-gen-playtest-browser.us-east.modal.run');
  process.env.PLAYTEST_MODAL_URL = 'https://evil.example.com';
  assert.equal(saveSettings({ playtest: { modal: { url: null } } } as any).playtest.modal.url, null);
  delete process.env.PLAYTEST_MODAL_URL;
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
  assert.deepEqual(variants(base), ['runpod', 'modal', 'gpu', 'cpu'], 'no order: the backend\'s GPU first, then every other GPU provider set up, then software');
  assert.deepEqual(variants({ ...base, backend: 'cloudrun' }), ['gpu', 'runpod', 'modal', 'cpu'], 'the L4 backend falls back to the other GPUs too');
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
  assert.equal(pc.modalHeaders('https://ws--app-browser.us-east.modal.run', ENV)['Modal-Key'], 'wk-1', 'a regional endpoint is Modal too');
  assert.equal(pc.modalHeaders('https://ws--app-browser.us-east.modal.run.evil.com', ENV)['Modal-Key'], undefined);
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
  assert.match(py, /"HAWKES_WS_DEFLATE": "0"/, 'no WebSocket compression behind Modal\'s relay');
  assert.match(py, /modal\.Secret\.from_name\("hawkes-gen-playtest"\)/);
  // :latest is pulled again on every deploy (Modal keeps a registry image it built); a pinned tag is not rebuilt.
  assert.match(py, /from_registry\("ghcr\.io\/jgriffith3433\/hawkes-gen-playtest:latest", add_python="3\.12", force_build=True\)/);
  const pinned: string = playtestApp({ image: 'ghcr.io/jgriffith3433/hawkes-gen-playtest:pw1.64.1-70ef888099', app: 'hawkes-gen-playtest', gpu: 'L4', max: 2, tabs: 2, idle: 60, token: '' });
  assert.doesNotMatch(pinned, /force_build/);
  assert.doesNotMatch(py, /min_containers|keep_warm|secret-value/);
  assert.equal(pricePerHour('L4'), 1.12);
});

test('RunPod out of credit with no other GPU set up: the runner router says which GPU providers are missing', async () => {
  const { runnerCandidates, resetRunners } = await import('../src/providers/playtester/runners.ts');
  resetRunners();
  resetHealth();
  setRunpodCredit({ balance: -0.006, at: Date.now() });
  const t = { ...SETTINGS_DEFAULTS.playtest, backend: 'runpod' as const, runpod: { ...SETTINGS_DEFAULTS.playtest.runpod, url: RP }, cloudrunCpu: { ...SETTINGS_DEFAULTS.playtest.cloudrunCpu, url: CPU_URL } };
  const get = (k: string) => (ENV as Record<string, string>)[k];
  const c = runnerCandidates({ project: null }, 'web', 'studio', { playtest: t }, { get, specs });
  assert.deepEqual(c.choices.map((x) => x.runner.provider), ['cloudrun-cpu'], 'only software is left');
  assert.ok(c.skipped.some((s) => /^runpod.*out of credit/.test(s)), c.skipped.join(' | '));
  assert.ok(c.skipped.some((s) => /^modal: no Modal playtest browser deployed/.test(s)), c.skipped.join(' | '));
  assert.ok(c.skipped.some((s) => /^cloudrun: no L4/.test(s)), c.skipped.join(' | '));
  // With Modal deployed, it is the fallback before software, without setting an order.
  const withModal = runnerCandidates({ project: null }, 'web', 'studio', { playtest: { ...t, modal: { ...t.modal, url: MODAL } } }, { get, specs });
  assert.deepEqual(withModal.choices.map((x) => x.runner.provider), ['modal', 'cloudrun-cpu']);
  setRunpodCredit(null);
});

test('behind Modal the browser server is never offered permessage-deflate (Modal\'s relay closes on a compressed frame)', async () => {
  const gpu = await import('../server/playtest-cloudrun/gpu.mjs' as any);
  assert.equal(gpu.wsDeflateAllowed({}), true, 'Cloud Run and RunPod keep compression');
  assert.equal(gpu.wsDeflateAllowed({ MODAL_TASK_ID: 'ta-1' }), false, 'a Modal container turns it off by itself');
  assert.equal(gpu.wsDeflateAllowed({ HAWKES_WS_DEFLATE: '0' }), false);
  assert.equal(gpu.wsDeflateAllowed({ MODAL_TASK_ID: 'ta-1', HAWKES_WS_DEFLATE: '1' }), true, 'an explicit 1 wins');
  const raw = ['Host', 'x--hawkes-gen-playtest-browser.modal.run', 'Upgrade', 'websocket', 'Connection', 'Upgrade', 'Sec-WebSocket-Key', 'k==',
    'Sec-WebSocket-Version', '13', 'Sec-WebSocket-Extensions', 'permessage-deflate; client_max_window_bits', 'X-Hawkes-Token', 't',
    'Modal-Key', 'mk', 'Modal-Secret', 'ms', 'Authorization', 'Bearer x', 'X-Hawkes-Job', 'j_1'];
  const off: string[] = gpu.browserHandshake(raw, 4321, { deflate: false });
  assert.ok(off.includes('Host: 127.0.0.1:4321'));
  assert.ok(off.includes('Sec-WebSocket-Key: k==') && off.includes('Upgrade: websocket') && off.includes('X-Hawkes-Job: j_1'));
  assert.ok(!off.some((l) => /^sec-websocket-extensions:/i.test(l)), 'no deflate offer reaches the browser server');
  assert.ok(!off.some((l) => /^(x-hawkes-token|modal-key|modal-secret|authorization):/i.test(l)), 'no credentials either');
  const on: string[] = gpu.browserHandshake(raw, 4321, { deflate: true });
  assert.ok(on.includes('Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits'), 'elsewhere the offer is passed on');
});

test('main redeploys Modal by itself: playtest-image.yml builds on main and calls the deploy with the pinned tag', () => {
  const dir = path.join(import.meta.dirname, '..', '.github', 'workflows');
  const image = fs.readFileSync(path.join(dir, 'playtest-image.yml'), 'utf8');
  const deploy = fs.readFileSync(path.join(dir, 'ops-modal-playtest-deploy.yml'), 'utf8');
  // Triggers: main (by paths), the old tags and the hand run; never beta.
  assert.match(image, /branches: \[main\]/);
  assert.ok(!/branches:.*beta/.test(image), 'never on beta');
  assert.ok(!/pull_request/.test(image), 'never on pull requests');
  assert.match(image, /tags: \['playtest-image-\*'\]/);
  assert.match(image, /workflow_dispatch:/);
  for (const p of ['server/playtest-cloudrun/**', 'tools/playtest-cloudrun/lib.mjs', 'tools/playtest-runpod/image-context.mjs', 'tools/playtest-modal/**', 'package-lock.json']) {
    assert.ok(image.includes(`- ${p}`), `paths include ${p}`);
  }
  // An existing tag isn't built again, and the deploy gets the exact tag, not :latest.
  assert.match(image, /docker manifest inspect/);
  assert.match(image, /uses: \.\/\.github\/workflows\/ops-modal-playtest-deploy\.yml/);
  assert.match(image, /image: \$\{\{ needs\.image\.outputs\.image \}\}/);
  assert.match(image, /hawkes-gen-playtest:\$\{\{ steps\.ctx\.outputs\.TAG \}\}/);
  assert.match(image, /github\.ref == 'refs\/heads\/main'/);
  // The deploy is reusable, keeps its hand run and inputs, and stays in the production environment.
  assert.match(deploy, /workflow_call:/);
  assert.match(deploy, /workflow_dispatch:/);
  assert.match(deploy, /environment: production/);
  assert.match(deploy, /default: ghcr\.io\/jgriffith3433\/hawkes-gen-playtest:latest/);
});

test('a gateway that never gave a browser in its whole first wait cools down; later short tries and runners do not', async () => {
  const { providerCooldownMs, GATEWAY_STUCK_COOLDOWN_MS } = await import('../src/providers/comfy/playtestHost.ts');
  const deps = { refusedForMoney: (w: string) => /\b402\b/.test(w), runnerCooldown: (w: string) => (/401/.test(w) ? 30 * 60_000 : 10 * 60_000) };
  const stuck = 'Modal playtest service: browserType.connect: Timeout 110995ms exceeded.';
  assert.equal(providerCooldownMs({ variant: 'modal' }, stuck, deps), GATEWAY_STUCK_COOLDOWN_MS);
  assert.equal(providerCooldownMs({ variant: 'runpod' }, stuck, deps), GATEWAY_STUCK_COOLDOWN_MS);
  assert.equal(providerCooldownMs({ variant: 'modal' }, stuck, { ...deps, round: 2 }), null, 'a later round tries for 40 s only');
  assert.equal(providerCooldownMs({ variant: 'modal', runner: 'modal-a' }, stuck, deps), null, 'a runner cools down under its own key');
  assert.equal(providerCooldownMs({ variant: 'cpu' }, stuck, deps), null);
  assert.equal(providerCooldownMs({ variant: 'modal' }, 'Modal playtest service: 402 Payment Required', deps), 30 * 60_000);
  assert.equal(providerCooldownMs({ variant: 'modal' }, 'Modal playtest service: 503 Service Unavailable', deps), null);
});
