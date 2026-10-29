// Playtests on RunPod (docs/playtest-runpod.md), with no RunPod: the settings (only a RunPod endpoint, a Pod's proxy or
// a local container), the order (the RunPod GPU first, then the CPU service), the headers (the API key only to RunPod's
// gateway, the image's own token always), retries through a cold start, the host and its usage row with the idle tail,
// the queue's own lane, the service's /ping and token lock (server.mjs run here), and the setup script's dry run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-playtest-runpod-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
const pc = await import('../src/providers/playtester/cloudrun.ts');
const { saveSettings, SETTINGS_DEFAULTS, ROOT } = await import('../src/config.ts');

const RP = 'https://wi67a2gkuwi9o5.api.runpod.ai';
const POD = 'https://jwkm96mkyfepig-8080.proxy.runpod.net';
const CPU_URL = 'https://gen-playtest-cpu-abc123-uk.a.run.app';
const ENV = { RUNPOD_API_KEY: 'rp_key', GPU_WORKER_TOKEN: 'gw_token' };

test('settings.playtest.runpod: off by default; only a RunPod endpoint, a Pod proxy or a local container; sizes and price clamped', () => {
  assert.equal(SETTINGS_DEFAULTS.playtest.runpod.url, null);
  const s = saveSettings({ playtest: { backend: 'runpod', runpod: { url: `${RP}/`, maxInstances: 50, tabsPerInstance: 0, gpu: 'RTX A4000', pricePerHour: 99, idleSeconds: 1 } } } as any);
  assert.equal(s.playtest.backend, 'runpod');
  assert.equal(s.playtest.runpod.url, RP);
  assert.equal(s.playtest.runpod.maxInstances, 20);
  assert.equal(s.playtest.runpod.tabsPerInstance, SETTINGS_DEFAULTS.playtest.runpod.tabsPerInstance);
  assert.equal(s.playtest.runpod.pricePerHour, SETTINGS_DEFAULTS.playtest.runpod.pricePerHour, 'an absurd price is refused');
  assert.equal(s.playtest.runpod.idleSeconds, 5);
  assert.equal(saveSettings({ playtest: { runpod: { url: POD } } } as any).playtest.runpod.url, POD, 'a Pod\'s HTTP proxy');
  assert.equal(saveSettings({ playtest: { runpod: { url: 'http://127.0.0.1:8095' } } } as any).playtest.runpod.url, 'http://127.0.0.1:8095');
  for (const bad of ['https://evil.example.com', 'http://wi67a2gkuwi9o5.api.runpod.ai', 'https://x.api.runpod.ai.evil.com', 'https://a.b.api.runpod.ai']) {
    assert.equal(saveSettings({ playtest: { runpod: { url: bad } } } as any).playtest.runpod.url, null, bad);
  }
  // A partial patch keeps the rest (and the other services' settings).
  saveSettings({ playtest: { runpod: { url: RP, gpu: 'RTX A4000' } } } as any);
  const again = saveSettings({ playtest: { cloudrunCpu: { url: CPU_URL } } } as any);
  assert.equal(again.playtest.runpod.url, RP);
  assert.equal(again.playtest.runpod.gpu, 'RTX A4000');
  saveSettings({ playtest: { backend: 'ec2', runpod: { url: null }, cloudrunCpu: { url: null } } } as any);
});

test('cloudPlaytestsFor: runpod tries the RunPod GPU, then the CPU service; its price, lanes and lane key', () => {
  const base = { backend: 'runpod', projects: {}, cloudrun: { url: null, maxInstances: 2, tabsPerInstance: 4, encode: 'service' }, cloudrunCpu: { url: CPU_URL, maxInstances: 4, tabsPerInstance: 1, encode: 'service', extra: [] }, runpod: { url: RP, maxInstances: 2, tabsPerInstance: 2, encode: 'service', gpu: 'RTX A4000', pricePerHour: 0.58, idleSeconds: 60 } } as any;
  const all = pc.cloudPlaytestsFor('x', { playtest: base });
  assert.deepEqual(all.map((c) => c.variant), ['runpod', 'cpu']);
  const rp = all[0];
  assert.equal(rp.name, 'runpod wi67a2gkuwi9o5');
  assert.equal(rp.region, 'RunPod');
  assert.equal(rp.software, null, 'a real GPU: frame rates count');
  assert.equal(rp.slow, 1);
  assert.equal(pc.cloudLanes(rp), 4);
  assert.equal(pc.cloudLaneKey(rp), 'playtest-runpod');
  assert.ok(Math.abs(rp.pricePerSecond * 3600 - 0.58) < 1e-9);
  // No endpoint: straight to the CPU service. "cloudrun" never tries RunPod.
  assert.deepEqual(pc.cloudPlaytestsFor('x', { playtest: { ...base, runpod: { ...base.runpod, url: null } } }).map((c) => c.variant), ['cpu']);
  assert.deepEqual(pc.cloudPlaytestsFor('x', { playtest: { ...base, backend: 'cloudrun' } }).map((c) => c.variant), ['cpu']);
  // Per product.
  assert.deepEqual(pc.cloudPlaytestsFor('dod', { playtest: { ...base, backend: 'ec2', projects: { dod: 'runpod' } } }).map((c) => c.variant), ['runpod', 'cpu']);
  // A Pod's proxy gets its pod id as the name.
  assert.equal(pc.runpodPlaytest({ ...base.runpod, url: POD }).name, 'runpod jwkm96mkyfepig');
});

test('headers: the RunPod API key only to RunPod\'s gateway, the image\'s token always', async () => {
  assert.deepEqual(pc.runpodHeaders(RP, ENV), { Authorization: 'Bearer rp_key', 'X-Hawkes-Token': 'gw_token' });
  assert.deepEqual(pc.runpodHeaders(POD, ENV), { 'X-Hawkes-Token': 'gw_token' }, 'a Pod proxy hands headers to the container: no API key');
  assert.deepEqual(pc.runpodHeaders('http://127.0.0.1:8095', ENV), { 'X-Hawkes-Token': 'gw_token' });
  assert.deepEqual(pc.runpodHeaders(RP, { ...ENV, PLAYTEST_RUNPOD_TOKEN: 'own' })['X-Hawkes-Token'], 'own', 'its own token first');
  assert.deepEqual(pc.runpodHeaders(RP, {}), {});
  let asked = 0;
  const idToken = async () => { asked++; return 'google'; };
  assert.deepEqual(await pc.headersFor({ url: RP, variant: 'runpod' }, idToken, ENV), { Authorization: 'Bearer rp_key', 'X-Hawkes-Token': 'gw_token' });
  assert.equal(asked, 0, 'no Google token for RunPod');
  assert.deepEqual(await pc.headersFor({ url: CPU_URL, variant: 'cpu' }, idToken, ENV), { Authorization: 'Bearer google' });
});

test('connectOne on RunPod: its headers, and it waits through a cold start (408, 504, 524)', async () => {
  const seen: any[] = [];
  let n = 0;
  const chromium = {
    connect: async (ws: string, o: any) => {
      seen.push({ ws, ...o.headers });
      n++;
      if (n === 1) throw new Error('browserType.connect: Unexpected server response: 408');
      if (n === 2) throw new Error('browserType.connect: Unexpected server response: 524');
      if (n === 3) throw new Error('Gateway Timeout');
      return { id: 'browser' };
    },
  };
  let now = 0;
  const steps: string[] = [];
  const b = await pc.connectOne(chromium, { url: RP, variant: 'runpod' }, { job: 'j_1', onStep: (s) => steps.push(s), deps: { idToken: async () => 'never', sleep: async (ms) => { now += ms; }, now: () => now, env: ENV } });
  assert.deepEqual(b, { id: 'browser' });
  assert.equal(steps.length, 3);
  assert.equal(seen[0].ws, 'wss://wi67a2gkuwi9o5.api.runpod.ai/pw');
  assert.equal(seen[0].Authorization, 'Bearer rp_key');
  assert.equal(seen[0]['X-Hawkes-Token'], 'gw_token');
  assert.equal(seen[0]['x-hawkes-job'], 'j_1');
  const denied = { connect: async () => { throw new Error('Unexpected server response: 401'); } };
  await assert.rejects(pc.connectOne(denied, { url: RP, variant: 'runpod' }, { deps: { idToken: async () => '', sleep: async () => {}, now: () => 0, env: ENV } }), /RunPod playtest service: .*401/);
});

test('openCloudPlaytestHost on RunPod: a GPU host, its label, and a runpod-playtest usage row with the cold start and idle tail', async () => {
  const usage: any[] = [];
  const browser = { contexts: () => [], isConnected: () => true, newContext: async () => ({}), close: async () => {} };
  const chromium = { connect: async () => browser };
  const c = pc.runpodPlaytest({ url: RP, maxInstances: 2, tabsPerInstance: 2, encode: 'service', gpu: 'RTX A4000', pricePerHour: 0.72, idleSeconds: 60 });
  const steps: string[] = [];
  const host = await pc.openCloudPlaytestHost(c, { pageUrl: 'https://doseofdestruction.com/Game/', job: 'j', chromium, step: (s) => steps.push(s), onUsage: (u) => usage.push(u), connectDeps: { idToken: async () => '', sleep: async () => {}, now: () => Date.now(), env: ENV } });
  assert.equal(host.backend, 'runpod');
  assert.equal(host.software, null);
  assert.equal(host.slow, 1);
  assert.equal(host.server, 'RunPod wi67a2gkuwi9o5 (RTX A4000)');
  assert.match(steps[0], /RunPod/);
  assert.equal(typeof host.encode, 'function');
  host.close();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].provider, 'runpod-playtest');
  assert.match(usage[0].detail, /60 s idle tail/);
  // The math: half the worker (1 tab of 2) for the play, the connect wait and the idle tail.
  const u = pc.runpodUsage(c, { seconds: 120, connectSeconds: 30, tabs: 1 });
  assert.ok(Math.abs(u.cost - (0.72 / 3600) * 0.5 * 210) < 1e-4, String(u.cost));
  assert.equal(u.amount, 120);
  assert.ok(Math.abs(pc.runpodUsage(c, { seconds: 100, connectSeconds: 0, tabs: 4 }).cost - (0.72 / 3600) * 160) < 1e-4, 'never more than the whole worker');
});

test('the queue: RunPod playtests take their own lane (playtest-runpod) of max workers x tabs', async () => {
  const { db } = await import('../src/db.ts');
  const { submit, queue } = await import('../src/jobs.ts');
  saveSettings({ playtest: { backend: 'ec2', projects: { gpugame: 'runpod' }, runpod: { url: RP, maxInstances: 1, tabsPerInstance: 2 } } } as any);
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
  const a = play();
  const b = play();
  const c = play();
  await q.fill();
  assert.ok(started.includes(a.id) && started.includes(b.id), 'one worker, two tabs');
  assert.ok(!started.includes(c.id), 'the third waits');
  assert.equal(q.lanes.get('playtest-runpod')?.size, 2);
  saveSettings({ playtest: { backend: 'ec2', projects: {}, runpod: { url: null } } } as any);
});

// ------------------------------------------------------------------ the service, run here

async function startService(env: Record<string, string>) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'playtest-cloudrun', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), HAWKES_ALLOW_SOFTWARE: '1', HAWKES_GL: 'angle-egl', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  const end = Date.now() + 60_000;
  const statuses = new Set<number>();
  for (;;) {
    const r = await fetch(`${url}/ping`).catch(() => null);
    if (r) statuses.add(r.status);
    if (r?.status === 200) break;
    if (Date.now() > end || child.exitCode !== null) {
      child.kill();
      throw new Error(`the service didn't get ready: ${log}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, child, statuses };
}

test('the service on RunPod: /ping 204 while the self-test runs then 200, and HAWKES_TOKEN locks everything else', async () => {
  const svc = await startService({ HAWKES_TOKEN: 'secret-token' });
  try {
    assert.ok([...svc.statuses].every((s) => s === 204 || s === 200), [...svc.statuses].join(','));
    assert.equal((await fetch(`${svc.url}/healthz`)).status, 200, 'liveness stays open');
    assert.equal((await fetch(`${svc.url}/selftest`)).status, 401);
    assert.equal((await fetch(`${svc.url}/ready`, { headers: { 'X-Hawkes-Token': 'wrong-token!' } })).status, 401);
    const st: any = await (await fetch(`${svc.url}/selftest`, { headers: { 'X-Hawkes-Token': 'secret-token' } })).json();
    assert.ok('driver' in st && 'machine' in st, 'the report says what the platform gave');
    assert.ok(st.machine.hostCpus >= 1);
    assert.ok('capabilities' in st.driver || st.mode === 'software');
    // A WebSocket without the token is refused before a browser starts.
    const refused = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${svc.url.replace('http', 'ws')}/pw`);
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('refused');
    });
    assert.equal(refused, 'refused');
  } finally {
    svc.child.kill();
  }
});

test('the service with no GPU path: /ping still answers (RunPod routes to it), /pw refuses at once with 412, and Gen doesn\'t retry that', async () => {
  const svc = await startService({ HAWKES_ALLOW_SOFTWARE: '0', HAWKES_FETCH_DRIVER: '0', HAWKES_GL: 'no-such-candidate' });
  try {
    assert.equal(await (await fetch(`${svc.url}/ping`)).text(), 'no GPU path');
    assert.equal((await fetch(`${svc.url}/ready`)).status, 503, 'Cloud Run\'s startup probe still fails');
    const status = await new Promise<string>((resolve) => {
      const req = http.request(`${svc.url}/pw`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      req.on('response', (r: any) => resolve(`${r.statusCode} ${r.statusMessage}`));
      req.on('upgrade', () => resolve('upgraded'));
      req.on('error', (e: any) => resolve(e.message));
      req.end();
    });
    assert.equal(status, '412 No GPU');
    assert.equal(pc.retryable(new Error('browserType.connect: Unexpected server response: 412')), false);
  } finally {
    svc.child.kill();
  }
});

test('the driver\'s graphics libraries: the right files out of NVIDIA\'s installer, NVIDIA\'s addresses, skipped when off', async () => {
  const gpu = await import('../server/playtest-cloudrun/gpu.mjs');
  for (const f of ['libEGL_nvidia.so.550.144.03', 'libGLX_nvidia.so.550.144.03', 'libGLESv2_nvidia.so.550.144.03', 'libnvidia-eglcore.so.550.144.03', 'libnvidia-glcore.so.550.144.03', 'libnvidia-glsi.so.550.144.03', 'libnvidia-gpucomp.so.550.144.03', 'libnvidia-glvkspirv.so.550.144.03']) assert.ok(gpu.GRAPHICS_LIBS.test(f), f);
  for (const f of ['libnvidia-encode.so.550.144.03', 'libcuda.so.550.144.03', 'nvidia-smi', 'libnvidia-ml.so.550.144.03']) assert.ok(!gpu.GRAPHICS_LIBS.test(f), f);
  assert.equal(gpu.DRIVER_URL('550.144.03'), 'https://download.nvidia.com/XFree86/Linux-x86_64/550.144.03/NVIDIA-Linux-x86_64-550.144.03.run');
  const old = process.env.HAWKES_FETCH_DRIVER;
  process.env.HAWKES_FETCH_DRIVER = '0';
  try {
    assert.deepEqual(await gpu.ensureGraphicsLibs(), { done: false, why: 'HAWKES_FETCH_DRIVER=0' });
  } finally {
    if (old === undefined) delete process.env.HAWKES_FETCH_DRIVER; else process.env.HAWKES_FETCH_DRIVER = old;
  }
});

// ------------------------------------------------------------------ setup

test('setup.mjs: a dry run prints a load-balancer endpoint, scale to zero, the settings, and no secret', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'playtest-runpod', 'setup.mjs'), '--image', 'ghcr.io/x/y:1'], { encoding: 'utf8', env: { ...process.env, RUNPOD_API_KEY: 'rp_secret_value', GPU_WORKER_TOKEN: 'gw_secret_value' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"type": "LB"/);
  assert.match(r.stdout, /"workersMin": 0/);
  assert.match(r.stdout, /"backend": "runpod"/);
  assert.match(r.stdout, /dry run/);
  assert.ok(!r.stdout.includes('rp_secret_value') && !r.stdout.includes('gw_secret_value'), 'secrets are never printed');
  assert.match(r.stdout, /HAWKES_TOKEN/);
});

test('the image workflow builds the same context as Cloud Run\'s L4 image, and pushes a copy to the public package', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'playtest-image.yml'), 'utf8');
  assert.match(wf, /playtest-image-\*/);
  assert.match(wf, /tools\/playtest-runpod\/image-context\.mjs/);
  assert.match(wf, /hawkes-gen-gpu:playtest-/);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-ptctx-'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'playtest-runpod', 'image-context.mjs'), out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^TAG=pw\d+\.\d+\.\d+-[0-9a-f]{10}$/m);
  assert.ok(['Dockerfile', 'server.mjs', 'gpu.mjs', '10_nvidia.json', 'nvidia_icd.json', 'package.json'].every((f) => fs.existsSync(path.join(out, f))));
  assert.ok(!fs.readFileSync(path.join(out, 'package.json'), 'utf8').includes('__PW_VERSION__'));
  fs.rmSync(out, { recursive: true, force: true });
});
