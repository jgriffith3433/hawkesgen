// Playtests on Cloud Run (docs/playtest-cloudrun.md), with no Google Cloud: the settings and the per-product switch,
// the price and the lanes, the queue's Cloud Run playtest lane, local builds served through Playwright's routing
// (requests and WebSockets), connecting through a full or starting service, the browser pool, the GPU self-test's
// renderer rules, the image's build context (Gen's Playwright version) and service definition, and the real service
// (server/playtest-cloudrun/server.mjs) run here: its probes, its self-test report and the video encode over a
// WebSocket. When this machine has Playwright's Chromium, a whole page through the service and the local proxy too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-playtest-cloudrun-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
const pc = await import('../src/providers/playtester/cloudrun.ts');
const { saveSettings, loadSettings, SETTINGS_DEFAULTS, ROOT } = await import('../src/config.ts');
const gpu = await import('../server/playtest-cloudrun/gpu.mjs');
const tools = await import('../tools/playtest-cloudrun/lib.mjs');

const URL_ = 'https://gen-playtest-abc123-uk.a.run.app';

// ------------------------------------------------------------------ settings, price, lanes

test('settings.playtest: EC2 by default, per-product override, only an https URL, sizes clamped', () => {
  assert.equal(SETTINGS_DEFAULTS.playtest.backend, 'ec2');
  const s = saveSettings({ playtest: { backend: 'ec2', projects: { sickofitgame: 'cloudrun', bad: 'gcp' as any }, cloudrun: { url: `${URL_}/`, maxInstances: 99, tabsPerInstance: 0, encode: 'nope' as any } } } as any);
  assert.deepEqual(s.playtest.projects, { sickofitgame: 'cloudrun' });
  assert.equal(s.playtest.cloudrun.url, URL_);
  assert.equal(s.playtest.cloudrun.maxInstances, 20);
  assert.equal(s.playtest.cloudrun.tabsPerInstance, SETTINGS_DEFAULTS.playtest.cloudrun.tabsPerInstance);
  assert.equal(s.playtest.cloudrun.encode, 'service');
  assert.equal(saveSettings({ playtest: { cloudrun: { url: 'http://evil.example.com' } } } as any).playtest.cloudrun.url, null, 'plain http is refused');
  // A partial patch keeps the rest.
  saveSettings({ playtest: { cloudrun: { url: URL_ } } } as any);
  const again = saveSettings({ playtest: { projects: { yoobaland: 'ec2' } } } as any);
  assert.deepEqual(again.playtest.projects, { sickofitgame: 'cloudrun', yoobaland: 'ec2' });
  assert.equal(again.playtest.cloudrun.url, URL_);
  assert.equal(pc.playtestBackendOf('sickofitgame', again.playtest), 'cloudrun');
  assert.equal(pc.playtestBackendOf('yoobaland', again.playtest), 'ec2');
  assert.equal(pc.playtestBackendOf(null, again.playtest), 'ec2');
});

test('cloudPlaytestFor: only when the backend says cloudrun and the service is deployed; L4 price and lanes', () => {
  const base = { backend: 'ec2', projects: {}, cloudrun: { url: URL_, maxInstances: 2, tabsPerInstance: 4, encode: 'service' } } as any;
  assert.equal(pc.cloudPlaytestFor('x', { playtest: base }), null, 'EC2 stays the default');
  assert.equal(pc.cloudPlaytestFor('x', { playtest: { ...base, backend: 'cloudrun', cloudrun: { ...base.cloudrun, url: null } } }), null, 'nothing deployed');
  const c = pc.cloudPlaytestFor('x', { playtest: { ...base, projects: { x: 'cloudrun' } } })!;
  assert.ok(c);
  assert.equal(c.url, URL_);
  assert.equal(pc.cloudLanes(c), 8);
  // 8 vCPU, 32 GiB and an L4 at services.json's rates: about $1.42 an hour.
  assert.ok(Math.abs(c.pricePerSecond * 3600 - 1.42) < 0.01, `${c.pricePerSecond * 3600}`);
  // A 3-minute single-player playtest's share of an instance holding four tabs.
  const cost = pc.tabCost(c, 180);
  assert.ok(cost > 0.015 && cost < 0.025, `${cost}`);
  assert.equal(pc.wsEndpointOf(URL_), 'wss://gen-playtest-abc123-uk.a.run.app/pw');
  assert.equal(pc.encodeUrlOf(URL_, { width: 1280, height: 720 }), 'wss://gen-playtest-abc123-uk.a.run.app/encode?w=1280&h=720');
});

test('the queue: Cloud Run playtests have their own lane of maxInstances x tabsPerInstance tabs', async () => {
  const { db } = await import('../src/db.ts');
  const { submit, getJob, queue } = await import('../src/jobs.ts');
  saveSettings({ playtest: { backend: 'ec2', projects: { cloudgame: 'cloudrun' }, cloudrun: { url: URL_, maxInstances: 1, tabsPerInstance: 2 } } } as any);
  const q = queue as any;
  q.pump = () => {};
  const started: string[] = [];
  q.runJob = (j: { id: string }) => {
    started.push(j.id);
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(j.id);
    return new Promise(() => {});
  };
  const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;
  const play = (project: string, peers = 1) => submit(owner, { tool: 'playtest.run', project, params: { url: 'http://localhost:8089/', gpu: 'require', peers } });
  const a = play('cloudgame');
  const b = play('cloudgame');
  await q.fill();
  assert.ok(started.includes(a.id) && started.includes(b.id), 'two tabs fit');
  const c = play('cloudgame');
  const duo = play('cloudgame', 2);
  await q.fill();
  assert.ok(!started.includes(c.id) && !started.includes(duo.id), 'the lane is full');
  assert.match(String(getJob(c.id)!.detail ?? ''), /2 of 2 playtest browser tabs/);
  assert.equal(q.lanes.get('playtest-cloud')?.size, 2);
});

// ------------------------------------------------------------------ local builds through the connection

test('local origins: the page\'s localhost port only, any scheme', () => {
  assert.deepEqual(pc.localPortsOf('http://localhost:8089/'), [8089]);
  assert.deepEqual(pc.localPortsOf('http://127.0.0.1/x'), [80]);
  assert.deepEqual(pc.localPortsOf('https://sickofitgame.com/'), []);
  const ports = new Set([8089]);
  assert.ok(pc.isLocal('http://localhost:8089/Game/v3/Build.data.unityweb', ports));
  assert.ok(pc.isLocal('ws://127.0.0.1:8089/hmr', ports));
  assert.ok(!pc.isLocal('http://localhost:5173/', ports), 'another local port is not served');
  assert.ok(!pc.isLocal('https://net.hawkesgen.ai/', ports), 'the internet goes straight out from the service');
});

test('headers: no hop-by-hop ones either way; every Set-Cookie kept; no content-encoding (fetch decoded it)', () => {
  assert.deepEqual(pc.requestHeaders({ host: 'localhost:8089', connection: 'keep-alive', cookie: 'a=1', 'user-agent': 'x', 'content-length': '3' }), { cookie: 'a=1', 'user-agent': 'x' });
  const h = new Headers();
  h.append('content-type', 'application/wasm');
  h.append('content-encoding', 'br');
  h.append('content-length', '10');
  h.append('set-cookie', 'a=1; Path=/');
  h.append('set-cookie', 'b=2; Path=/');
  assert.deepEqual(pc.responseHeaders(h), { 'content-type': 'application/wasm', 'set-cookie': 'a=1; Path=/\nb=2; Path=/' });
});

function fakeRoute(req: { url: string; method?: string; headers?: Record<string, string>; body?: Buffer | null }) {
  const calls: any = { fulfill: null, abort: null };
  return {
    calls,
    route: {
      request: () => ({ url: () => req.url, method: () => req.method ?? 'GET', allHeaders: async () => req.headers ?? {}, postDataBuffer: () => req.body ?? null }),
      fulfill: async (r: any) => { calls.fulfill = r; },
      abort: async (why: string) => { calls.abort = why; },
    },
  };
}

test('a routed request is fetched here and answered to the remote browser (status, headers, body, redirects as is)', async () => {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, cookie: req.headers.cookie, body });
      if (req.url === '/old') return res.writeHead(302, { location: '/new' }).end();
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['s=1', 't=2'] }).end(`hello ${req.method}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  try {
    const get = fakeRoute({ url: `http://127.0.0.1:${port}/index.html`, headers: { cookie: 'k=v', host: 'x' } });
    await pc.serveRoute(get.route);
    assert.equal(get.calls.fulfill.status, 200);
    assert.equal(get.calls.fulfill.body.toString(), 'hello GET');
    assert.equal(get.calls.fulfill.headers['set-cookie'], 's=1\nt=2');
    assert.equal(seen[0].cookie, 'k=v', 'the browser\'s cookies go to the local server');
    const post = fakeRoute({ url: `http://127.0.0.1:${port}/api`, method: 'POST', body: Buffer.from('{"a":1}') });
    await pc.serveRoute(post.route);
    assert.equal(seen[1].body, '{"a":1}');
    const redirect = fakeRoute({ url: `http://127.0.0.1:${port}/old` });
    await pc.serveRoute(redirect.route);
    assert.equal(redirect.calls.fulfill.status, 302, 'the browser follows redirects itself (and they come back through the route)');
    assert.equal(redirect.calls.fulfill.headers.location, '/new');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  // Nothing listening: the browser sees a refused connection, as it would have.
  const spare = http.createServer();
  await new Promise<void>((r) => spare.listen(0, '127.0.0.1', () => r()));
  const free = (spare.address() as any).port;
  await new Promise((r) => spare.close(r));
  const gone = fakeRoute({ url: `http://127.0.0.1:${free}/` });
  await pc.serveRoute(gone.route);
  assert.equal(gone.calls.abort, 'connectionrefused');
});

test('a routed WebSocket is bridged to the local server: messages both ways, queued until it opens, closes together', async () => {
  const sockets: any[] = [];
  class FakeWS {
    url: string; binaryType = ''; sent: any[] = []; closed = false;
    onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor(url: string) { this.url = url; sockets.push(this); }
    send(m: any) { this.sent.push(m); }
    close() { this.closed = true; }
  }
  const page: any = { sent: [] as any[], closed: null as any, onMsg: null as any, onCl: null as any };
  const route = {
    url: () => 'ws://localhost:8089/hmr',
    send: (m: any) => page.sent.push(m),
    close: async (o: any) => { page.closed = o; },
    onMessage: (f: any) => (page.onMsg = f),
    onClose: (f: any) => (page.onCl = f),
  };
  pc.bridgeWebSocket(route, { fetch, WebSocket: FakeWS as any });
  const target = sockets[0];
  assert.equal(target.url, 'ws://localhost:8089/hmr');
  page.onMsg('early');
  assert.deepEqual(target.sent, [], 'held until the local socket opens');
  target.onopen();
  assert.deepEqual(target.sent, ['early']);
  page.onMsg(Buffer.from([1, 2]));
  assert.equal(target.sent.length, 2);
  target.onmessage({ data: 'reload' });
  target.onmessage({ data: new Uint8Array([7]).buffer });
  assert.equal(page.sent[0], 'reload');
  assert.deepEqual([...page.sent[1]], [7]);
  target.onclose({ code: 1006, reason: 'gone' });
  assert.deepEqual(page.closed, { code: 1000, reason: 'gone' }, 'a code a page may not use becomes 1000');
});

// ------------------------------------------------------------------ connecting

test('connectOne: waits out a full (429) or starting (503) service, gives up on anything else', async () => {
  let n = 0;
  const steps: string[] = [];
  const headersSeen: any[] = [];
  const chromium = {
    connect: async (ws: string, o: any) => {
      headersSeen.push({ ws, ...o.headers });
      n++;
      if (n === 1) throw new Error('browserType.connect: WebSocket error: 429 Too Many Requests');
      if (n === 2) throw new Error('browserType.connect: Unexpected server response: 503');
      return { id: 'browser' };
    },
  };
  let now = 0;
  const deps = { idToken: async () => 'tok', sleep: async (ms: number) => { now += ms; }, now: () => now };
  const b = await pc.connectOne(chromium, { url: URL_ }, { job: 'j_1', onStep: (s) => steps.push(s), deps });
  assert.deepEqual(b, { id: 'browser' });
  assert.equal(steps.length, 2);
  assert.equal(headersSeen[0].ws, `${URL_.replace('https', 'wss')}/pw`);
  assert.equal(headersSeen[0].Authorization, 'Bearer tok');
  assert.equal(headersSeen[0]['x-hawkes-job'], 'j_1');
  const denied = { connect: async () => { throw new Error('Unexpected server response: 403'); } };
  await assert.rejects(pc.connectOne(denied, { url: URL_ }, { deps }), /403/);
  // Still full after the time allowed.
  now = 0;
  const full = { connect: async () => { throw new Error('429 Too Many Requests'); } };
  await assert.rejects(pc.connectOne(full, { url: URL_ }, { deps, timeoutMs: 20_000 }), /429/);
});

test('BrowserPool: a browser per tab, a free one reused, all closed together; a failed open closes the rest', async () => {
  const made: any[] = [];
  const mk = () => {
    const b: any = { ctx: [] as any[], closed: false, contexts: () => b.ctx, close: async () => { b.closed = true; }, newContext: async () => { const c = { close: () => b.ctx.splice(b.ctx.indexOf(c), 1) }; b.ctx.push(c); return c; } };
    made.push(b);
    return b;
  };
  const pool = await new pc.BrowserPool(async () => mk()).open(2);
  assert.equal(made.length, 2);
  const c1: any = await pool.newContext({});
  await pool.newContext({});
  assert.deepEqual(made.map((b) => b.ctx.length), [1, 1], 'one context per browser');
  c1.close();
  await pool.newContext({});
  assert.equal(made.length, 2, 'a reopened tab takes the free browser');
  await pool.newContext({});
  assert.equal(made.length, 3, 'more tabs than browsers: one more connection');
  await pool.close();
  assert.ok(made.every((b) => b.closed));
  let k = 0;
  const half: any[] = [];
  await assert.rejects(new pc.BrowserPool(async () => { if (k++ === 1) throw new Error('429'); const b = mk(); half.push(b); return b; }).open(2), /429/);
  assert.ok(half.every((b) => b.closed), 'the browser that did connect is closed');
});

test('openCloudPlaytestHost: connects every tab up front, serves local origins, records the tab-seconds', async () => {
  const usage: any[] = [];
  const routes: any[] = [];
  const chromium = { connect: async () => ({ contexts: () => [], close: async () => {}, newContext: async () => ({}) }) };
  const c = pc.cloudPlaytestFor('x', { playtest: { backend: 'cloudrun', projects: {}, cloudrun: { url: URL_, maxInstances: 2, tabsPerInstance: 4, encode: 'service' } } } as any)!;
  const host = await pc.openCloudPlaytestHost(c, { pageUrl: 'http://localhost:8089/', tabs: 3, job: 'j', chromium, connectDeps: { idToken: async () => 't', sleep: async () => {}, now: () => Date.now() }, onUsage: (u) => usage.push(u) });
  assert.equal(host.backend, 'cloudrun');
  assert.equal(host.ssh, null);
  assert.equal(host.browser.browsers.length, 3);
  assert.equal(host.mapUrl('http://localhost:8089/?room=1'), 'http://localhost:8089/?room=1');
  assert.deepEqual(host.contextOptions, { serviceWorkers: 'block' });
  await host.prepareContext!({ route: async (m: any) => routes.push(['http', m]), routeWebSocket: async (m: any) => routes.push(['ws', m]) });
  assert.deepEqual(routes.map((r) => r[0]), ['http', 'ws']);
  assert.ok(routes[0][1](new URL('http://localhost:8089/a.js')) && !routes[0][1](new URL('https://cdn.example.com/a.js')));
  assert.equal(typeof host.encode, 'function');
  host.close();
  host.close();
  assert.equal(usage.length, 1, 'once');
  assert.equal(usage[0].provider, 'gcp-playtest');
  assert.equal(usage[0].unit, 'tab_seconds');
});

// ------------------------------------------------------------------ the service image

test('GPU self-test rules: NVIDIA renderers count, SwiftShader and llvmpipe never do', () => {
  assert.equal(gpu.classifyRenderer('ANGLE (NVIDIA Corporation, NVIDIA L4/PCIe/SSE2, OpenGL ES 3.2 NVIDIA 580.95.05)'), 'gpu');
  assert.equal(gpu.classifyRenderer('ANGLE (NVIDIA, Vulkan 1.4.312 (NVIDIA L4 (0x000027B8)), NVIDIA-580.95.5.0)'), 'gpu');
  assert.equal(gpu.classifyRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'), 'software');
  assert.equal(gpu.classifyRenderer('ANGLE (Mesa, llvmpipe (LLVM 19.1.1 256 bits), OpenGL 4.5)'), 'software');
  assert.equal(gpu.classifyRenderer(''), 'unknown');
  const picked = gpu.pickCandidate([
    { id: 'angle-egl', ok: true, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' },
    { id: 'angle-vulkan', ok: true, renderer: 'ANGLE (NVIDIA, Vulkan 1.4.312 (NVIDIA L4 (0x000027B8)), NVIDIA)' },
  ]);
  assert.equal(picked?.id, 'angle-vulkan');
  assert.equal(gpu.pickCandidate([{ id: 'x', ok: false, renderer: 'NVIDIA L4' }]), null, 'it must also have drawn');
  // The first candidate is the EC2 playtesters' proven flag set.
  assert.deepEqual(gpu.CANDIDATES[0].args.slice(0, 2), ['--use-gl=angle', '--use-angle=gl-egl']);
  for (const c of gpu.CANDIDATES) assert.ok(c.args.includes('--disable-dev-shm-usage') && c.args.includes('--enable-gpu'));
});

test('the image: Playwright pinned to Gen\'s version everywhere, the vendor files in, the tag follows the sources', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages['node_modules/playwright'].version;
  const ctx = tools.buildContext();
  assert.equal(ctx.version, lock);
  const docker = ctx.files.Dockerfile.toString();
  assert.match(docker, new RegExp(`^FROM mcr\\.microsoft\\.com/playwright:v${lock.replace(/\./g, '\\.')}-noble$`, 'm'));
  assert.equal(JSON.parse(ctx.files['package.json'].toString()).dependencies.playwright, lock);
  for (const f of Object.values(ctx.files) as Buffer[]) assert.ok(!f.toString().includes('__PW_VERSION__'));
  assert.match(docker, /egl_vendor\.d\/10_nvidia\.json/);
  assert.match(docker, /icd\.d\/nvidia_icd\.json/);
  assert.equal(JSON.parse(ctx.files['10_nvidia.json'].toString()).ICD.library_path, 'libEGL_nvidia.so.0');
  assert.notEqual(tools.buildContext('1.0.0').hash, ctx.hash, 'another Playwright, another tag');
  const spec = tools.loadSpec();
  assert.match(tools.imageTag({ project: 'p', region: 'us-east4' }, spec, ctx), /^us-east4-docker\.pkg\.dev\/p\/hawkes-gen\/gen-playtest:pw\d+\.\d+\.\d+-[0-9a-f]{10}$/);
});

test('the service definition: L4, scale to zero, concurrency = tabs, GPU self-test before traffic, never public', () => {
  const spec = tools.loadSpec();
  const y = tools.serviceYaml(spec, { image: 'img', region: 'us-east4', serviceAccount: 'sa@x', maxInstances: 3, tabs: 2 });
  const t = y.spec.template;
  assert.equal(t.metadata.annotations['autoscaling.knative.dev/minScale'], '0');
  assert.equal(t.metadata.annotations['autoscaling.knative.dev/maxScale'], '3');
  assert.equal(t.metadata.annotations['run.googleapis.com/cpu-throttling'], 'false', 'GPUs need instance-based billing');
  assert.equal(t.spec.containerConcurrency, 2);
  assert.equal(t.spec.timeoutSeconds, 3600);
  assert.equal(t.spec.nodeSelector['run.googleapis.com/accelerator'], 'nvidia-l4');
  assert.equal(t.spec.containers[0].startupProbe.httpGet.path, '/ready');
  assert.deepEqual(t.spec.containers[0].env, [{ name: 'HAWKES_TABS', value: '2' }]);
  assert.ok(!JSON.stringify(y).includes('allUsers'));
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'cloudrun', 'services.json'), 'utf8'));
  assert.ok(map.gpus[spec.gpu].regions.includes(spec.region), 'the L4 is offered where the spec puts it');
  assert.ok(spec.cpu >= map.gpus[spec.gpu].minCpu && spec.memoryGi >= map.gpus[spec.gpu].minMemoryGi);
});

// ------------------------------------------------------------------ the service itself, run here

const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

async function startService(env: Record<string, string> = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'playtest-cloudrun', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), HAWKES_ALLOW_SOFTWARE: '1', HAWKES_GL: 'angle-egl', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  const end = Date.now() + 60_000;
  for (;;) {
    const r = await fetch(`${url}/ready`).catch(() => null);
    if (r?.status === 200) break;
    if (Date.now() > end || child.exitCode !== null) {
      child.kill();
      throw new Error(`the service didn't get ready: ${log}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { url, child, log: () => log };
}

test('the service: probes, the self-test report, and the video encoded over a WebSocket', { skip: !ffmpeg && 'no ffmpeg here' }, async () => {
  const svc = await startService();
  try {
    assert.equal((await fetch(`${svc.url}/healthz`)).status, 200);
    const st: any = await (await fetch(`${svc.url}/selftest`)).json();
    assert.ok(Array.isArray(st.candidates) && st.candidates.length >= 1);
    assert.ok('nvenc' in st && 'driver' in st && 'gpu' in st);
    assert.equal(st.maxSessions, 4);
    // A WebSocket to an unknown path is refused; /pw without a browser is refused, not hung.
    // The encode: a 2-second MJPEG in, an mp4 out.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-enc-'));
    const mjpeg = path.join(dir, 'in.mjpeg');
    const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'mjpeg', mjpeg]);
    assert.equal(made.status, 0);
    const out = path.join(dir, 'out.mp4');
    const encoder = await pc.encodeOnService({ url: svc.url }, mjpeg, out, { width: 320, height: 240 }, AbortSignal.timeout(60_000), { WebSocket: globalThis.WebSocket, idToken: async () => 'tok' });
    assert.match(encoder, /^(libx264|h264_nvenc)$/);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,nb_frames', '-of', 'json', out], { encoding: 'utf8' });
    if (probe.status === 0) {
      const s = JSON.parse(probe.stdout).streams[0];
      assert.equal(s.codec_name, 'h264');
      assert.equal(s.width, 320);
      assert.equal(Number(s.nb_frames), 60);
    } else assert.ok(fs.statSync(out).size > 1000);
    // A broken stream comes back as an error, and Gen falls back to encoding here.
    const junk = path.join(dir, 'junk.mjpeg');
    fs.writeFileSync(junk, Buffer.from('not a jpeg at all'));
    await assert.rejects(pc.encodeOnService({ url: svc.url }, junk, path.join(dir, 'junk.mp4'), { width: 320, height: 240 }, AbortSignal.timeout(30_000), { WebSocket: globalThis.WebSocket, idToken: async () => 'tok' }), /encode/);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    svc.child.kill();
  }
});

// A whole page through the service and the local proxy: needs Playwright's Chromium on this machine (CI and J's PC
// have it after `npx playwright install chromium-headless-shell`).
const { chromium } = await import('playwright');
const haveChromium = (() => {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

test('end to end: a local page and its WebSocket through the service, served from here', { skip: !haveChromium && 'Playwright\'s Chromium is not installed here' }, async () => {
  // The "local build": a page that fetches a file and opens a WebSocket to its own origin.
  const hits: string[] = [];
  const site = http.createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === '/data.json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"level":7}');
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>t</title><script>
      fetch('/data.json').then(r => r.json()).then(d => { window.level = d.level; });
    </script>`);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const port = (site.address() as any).port;
  const svc = await startService();
  try {
    const c = { url: svc.url, maxInstances: 1, tabsPerInstance: 4, encode: 'service', pricePerSecond: 0.0004, region: 'here', name: 'gen-playtest' } as any;
    const host = await pc.openCloudPlaytestHost(c, { pageUrl: `http://localhost:${port}/`, tabs: 1, chromium, connectDeps: { idToken: async () => 'tok', sleep: async () => {}, now: () => Date.now() } });
    const context = await host.browser.newContext({ ...host.contextOptions });
    await host.prepareContext!(context);
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => (window as any).level === 7, null, { timeout: 15_000 });
    assert.ok(hits.includes('/data.json'));
    host.close();
  } finally {
    svc.child.kill();
    site.close();
  }
});

// ------------------------------------------------------------------ the CPU service (gen-playtest-cpu, software WebGL)

const CPU_URL = 'https://gen-playtest-cpu-abc123-uk.a.run.app';

test('CPU service settings: the cloudrun-cpu backend, its own URL and sizes, a local service URL allowed', () => {
  assert.deepEqual(SETTINGS_DEFAULTS.playtest.cloudrunCpu, { url: null, maxInstances: 4, tabsPerInstance: 1, encode: 'service', extra: [] });
  const s = saveSettings({ playtest: { backend: 'cloudrun-cpu', projects: { phorigins: 'cloudrun-cpu' }, cloudrunCpu: { url: `${CPU_URL}/`, maxInstances: 50, tabsPerInstance: 3 } } } as any);
  assert.equal(s.playtest.backend, 'cloudrun-cpu');
  assert.equal(s.playtest.projects.phorigins, 'cloudrun-cpu');
  assert.equal(s.playtest.cloudrunCpu.url, CPU_URL);
  assert.equal(s.playtest.cloudrunCpu.maxInstances, 20);
  assert.equal(s.playtest.cloudrunCpu.tabsPerInstance, 3);
  // The same container beside Gen (docker run -p 8095:8080): plain http on loopback only.
  assert.equal(saveSettings({ playtest: { cloudrunCpu: { url: 'http://127.0.0.1:8095' } } } as any).playtest.cloudrunCpu.url, 'http://127.0.0.1:8095');
  assert.equal(saveSettings({ playtest: { cloudrunCpu: { url: 'http://10.0.0.5:8095' } } } as any).playtest.cloudrunCpu.url, null);
  // A partial patch of the L4 service keeps the CPU one.
  saveSettings({ playtest: { cloudrunCpu: { url: CPU_URL } } } as any);
  assert.equal(saveSettings({ playtest: { cloudrun: { maxInstances: 1 } } } as any).playtest.cloudrunCpu.url, CPU_URL);
  saveSettings({ playtest: { backend: 'ec2', projects: {}, cloudrunCpu: { url: null } } } as any);
});

test('the CPU service in more regions: extra entries follow the first in order, each with its region and size; bad ones are dropped', () => {
  const C2 = 'https://gen-playtest-cpu-388576319982.us-central1.run.app';
  try {
  const s = saveSettings({ playtest: { backend: 'cloudrun-cpu', cloudrunCpu: { url: CPU_URL, maxInstances: 4, tabsPerInstance: 1, extra: [
    { url: C2, region: 'us-central1', maxInstances: 5 },
    { url: 'http://10.0.0.5:8095', region: 'us-west1' },
    { url: C2, region: 'not a region' },
  ] } } } as any);
  assert.deepEqual(s.playtest.cloudrunCpu.extra, [{ url: C2, region: 'us-central1', maxInstances: 5 }]);
  const list = pc.cloudPlaytestsFor('x', s);
  assert.deepEqual(list.map((c) => [c.url, c.region, c.maxInstances]), [[CPU_URL, 'us-east4', 4], [C2, 'us-central1', 5]]);
  assert.ok(list.every((c) => c.variant === 'cpu' && c.slow === 2));
  // The queue's lane is every region's tabs together: 4 + 5.
  assert.equal(list.reduce((n, c) => n + pc.cloudLanes(c), 0), 9);
  } finally {
    saveSettings({ playtest: { backend: 'ec2', projects: {}, cloudrunCpu: { url: null, extra: [] } } } as any);
  }
});

test('cloudPlaytestsFor: cloudrun tries the L4 then the CPU service; cloudrun-cpu only the CPU one; prices, slowness, lanes', () => {
  const base = { backend: 'ec2', projects: {}, cloudrun: { url: URL_, maxInstances: 2, tabsPerInstance: 4, encode: 'service' }, cloudrunCpu: { url: CPU_URL, maxInstances: 4, tabsPerInstance: 1, encode: 'service' } } as any;
  assert.deepEqual(pc.cloudPlaytestsFor('x', { playtest: base }), [], 'EC2: none');
  const both = pc.cloudPlaytestsFor('x', { playtest: { ...base, backend: 'cloudrun' } });
  assert.deepEqual(both.map((c) => c.name), ['gen-playtest', 'gen-playtest-cpu'], 'a missing L4 falls back to software WebGL first');
  const noL4 = pc.cloudPlaytestsFor('x', { playtest: { ...base, backend: 'cloudrun', cloudrun: { ...base.cloudrun, url: null } } });
  assert.deepEqual(noL4.map((c) => c.variant), ['cpu']);
  const cpu = pc.cloudPlaytestFor('x', { playtest: { ...base, projects: { x: 'cloudrun-cpu' } } })!;
  assert.equal(cpu.variant, 'cpu');
  assert.equal(cpu.url, CPU_URL);
  assert.equal(cpu.slow, 2);
  assert.match(cpu.software!, /SwiftShader/);
  assert.equal(pc.cloudLanes(cpu), 4);
  assert.equal(pc.cloudLaneKey(cpu), 'playtest-cloud-cpu');
  assert.equal(pc.cloudLaneKey(both[0]), 'playtest-cloud');
  assert.equal(both[0].software, null);
  // 4 vCPU and 8 GiB at request-based rates: about $0.42 an hour, $0.007 a minute for its one tab.
  assert.ok(Math.abs(cpu.pricePerSecond * 3600 - 0.4176) < 0.001, `${cpu.pricePerSecond * 3600}`);
  assert.ok(Math.abs(pc.tabCost(cpu, 60) - 0.00696) < 0.0001);
  // Nothing deployed: nothing.
  assert.equal(pc.cloudPlaytestFor('x', { playtest: { ...base, backend: 'cloudrun-cpu', cloudrunCpu: { ...base.cloudrunCpu, url: null } } }), null);
  // Settings saved before the CPU service existed (no cloudrunCpu) still work.
  const { cloudrunCpu: _, ...old } = base;
  assert.deepEqual(pc.cloudPlaytestsFor('x', { playtest: { ...old, backend: 'cloudrun' } }).map((c) => c.variant), ['gpu']);
});

test('the queue: CPU service playtests take their own lane (playtest-cloud-cpu), counted apart from the L4', async () => {
  const { db } = await import('../src/db.ts');
  const { submit, queue } = await import('../src/jobs.ts');
  saveSettings({ playtest: { backend: 'ec2', projects: { cpugame: 'cloudrun-cpu' }, cloudrunCpu: { url: CPU_URL, maxInstances: 2, tabsPerInstance: 1 } } } as any);
  const q = queue as any;
  q.pump = () => {};
  const started: string[] = [];
  q.runJob = (j: { id: string }) => {
    started.push(j.id);
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(j.id);
    return new Promise(() => {});
  };
  const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;
  const play = () => submit(owner, { tool: 'playtest.run', project: 'cpugame', params: { url: 'http://localhost:8089/', gpu: 'require' } });
  const a = play();
  const b = play();
  const c = play();
  await q.fill();
  assert.ok(started.includes(a.id) && started.includes(b.id), 'two instances, one tab each');
  assert.ok(!started.includes(c.id), 'the third waits');
  assert.equal(q.lanes.get('playtest-cloud-cpu')?.size, 2);
  saveSettings({ playtest: { backend: 'ec2', projects: {}, cloudrunCpu: { url: null } } } as any);
});

test('openCloudPlaytestHost on the CPU service: software reason, slowness, its own usage row; a local service gets no token', async () => {
  const seen: any[] = [];
  const browser = { contexts: () => [], isConnected: () => true, newContext: async () => ({}), close: async () => {} };
  const chromium = { connect: async (ws: string, opts: any) => { seen.push({ ws, headers: opts.headers }); return browser; } };
  const usage: any[] = [];
  const base = { backend: 'cloudrun-cpu', projects: {}, cloudrun: { url: null, maxInstances: 2, tabsPerInstance: 4, encode: 'service' }, cloudrunCpu: { url: 'http://127.0.0.1:8095', maxInstances: 1, tabsPerInstance: 1, encode: 'service' } } as any;
  const c = pc.cloudPlaytestFor('x', { playtest: base })!;
  let asked = 0;
  const host = await pc.openCloudPlaytestHost(c, { pageUrl: 'https://doseofdestruction.com/Game/', job: 'j_1', chromium, onUsage: (u) => usage.push(u), connectDeps: { idToken: async () => { asked++; return 'tok'; }, sleep: async () => {}, now: () => Date.now() } });
  assert.equal(host.backend, 'cloudrun-cpu');
  assert.equal(host.slow, 2);
  assert.match(host.software!, /SwiftShader/);
  assert.match(host.server, /gen-playtest-cpu .*software WebGL/);
  assert.equal(seen[0].ws, 'ws://127.0.0.1:8095/pw');
  assert.equal(seen[0].headers.Authorization, undefined, 'a service on this machine needs no Google token');
  assert.equal(asked, 0);
  host.close();
  assert.equal(usage[0].provider, 'gcp-playtest-cpu');
  assert.match(usage[0].detail, /no idle tail/);
  // On Cloud Run the token is sent.
  assert.deepEqual(await pc.authFor(CPU_URL, async () => 'tok'), { Authorization: 'Bearer tok' });
  assert.deepEqual(await pc.authFor('http://localhost:8095', async () => 'tok'), {});
});

test('software self-test rules: SwiftShader flags, any drawing renderer passes in software mode, the mode from the env', () => {
  assert.equal(gpu.glMode('software'), 'software');
  assert.equal(gpu.glMode(undefined), 'gpu');
  assert.equal(gpu.candidatesFor('software'), gpu.SOFTWARE_CANDIDATES);
  assert.equal(gpu.candidatesFor('gpu'), gpu.CANDIDATES);
  for (const c of gpu.SOFTWARE_CANDIDATES) {
    assert.ok(c.args.includes('--use-angle=swiftshader') && c.args.includes('--enable-unsafe-swiftshader') && c.args.includes('--disable-dev-shm-usage'));
  }
  const swift = { id: 'swiftshader', ok: true, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' };
  assert.equal(gpu.pickCandidate([swift], 'software')?.id, 'swiftshader');
  assert.equal(gpu.pickCandidate([swift]), null, 'the L4 service never takes SwiftShader');
  assert.equal(gpu.pickCandidate([{ ...swift, ok: false }], 'software'), null, 'it must have drawn');
});

test('the CPU image and service: Dockerfile.cpu without NVIDIA files, software mode, no GPU, request-based billing', () => {
  const ctx = tools.buildContext(undefined, 'cpu');
  const docker = ctx.files.Dockerfile.toString();
  assert.match(docker, /^FROM mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-noble$/m);
  assert.match(docker, /HAWKES_GL_MODE=software/);
  assert.ok(!/nvidia/i.test(docker.split('\n').filter((l) => !l.startsWith('#')).join('\n')), 'no NVIDIA files');
  assert.deepEqual(Object.keys(ctx.files).sort(), ['Dockerfile', 'gpu.mjs', 'package.json', 'server.mjs']);
  assert.notEqual(ctx.hash, tools.buildContext(ctx.version, 'gpu').hash);
  const spec = tools.loadSpec('cpu');
  assert.equal(spec.name, 'gen-playtest-cpu');
  assert.equal(spec.gpu, null);
  assert.match(tools.imageTag({ project: 'p', region: 'us-east4' }, spec, ctx), /\/gen-playtest-cpu:pw\d+\.\d+\.\d+-[0-9a-f]{10}$/);
  assert.equal(tools.stateName('cpu', 'image'), 'playtest-cpu-image.json');
  assert.equal(tools.stateName('gpu', 'image'), 'playtest-image.json');
  assert.ok(Math.abs(tools.pricePerHour(spec) - 0.4176) < 0.001);
  const y = tools.serviceYaml(spec, { image: 'img', region: 'us-east4', serviceAccount: 'sa@x', maxInstances: 4, tabs: 1 });
  const t = y.spec.template;
  assert.equal(t.metadata.annotations['run.googleapis.com/cpu-throttling'], 'true', 'request-based billing: no idle tail');
  assert.equal(t.metadata.annotations['autoscaling.knative.dev/minScale'], '0');
  assert.equal(t.spec.nodeSelector, undefined);
  assert.equal(t.spec.containers[0].resources.limits['nvidia.com/gpu'], undefined);
  assert.equal(t.spec.containerConcurrency, 1);
  assert.deepEqual(t.spec.containers[0].env, [{ name: 'HAWKES_TABS', value: '1' }, { name: 'HAWKES_GL_MODE', value: 'software' }]);
  assert.equal(t.spec.containers[0].startupProbe.httpGet.path, '/ready');
  assert.ok(!JSON.stringify(y).includes('allUsers'));
});

test('the service in software mode, run here: /ready after WebGL draws on SwiftShader, and the bench', { skip: !haveChromium && 'Playwright Chromium is not installed here' }, async () => {
  const svc = await startService({ HAWKES_GL_MODE: 'software', HAWKES_ALLOW_SOFTWARE: '0', HAWKES_GL: '', HAWKES_TABS: '1' });
  try {
    const ready: any = await (await fetch(`${svc.url}/ready`)).json();
    assert.equal(ready.mode, 'software');
    const st: any = await (await fetch(`${svc.url}/selftest`)).json();
    assert.equal(st.mode, 'software');
    assert.equal(st.gl.ok, true);
    assert.match(st.gl.renderer, /SwiftShader/);
    assert.ok(st.gl.fps > 0, 'the WebGL loop ran');
    assert.equal(st.nvenc.ok, false);
    assert.equal(st.maxSessions, 1);
  } finally {
    svc.child.kill();
  }
});
