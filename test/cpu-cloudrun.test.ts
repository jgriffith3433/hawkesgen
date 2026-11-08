// The CPU suite on Cloud Run (docs/cpu-cloudrun.md): settings and routing, then Gen's client (src/providers/cloudrun/cpu.ts)
// talking to the real service code (src/cpu/worker.ts) through a fake fetch that streams its events, with an in-memory
// bucket. The tools really run (Pillow, ffmpeg, gltf-transform): the image ones are skipped without a .venv with
// Pillow (here, or HAWKESGEN_TEST_PYTHON), the video ones without ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cpu-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
const { saveSettings, loadSettings, ROOT } = await import('../src/config.ts');
const cpu = await import('../src/providers/cloudrun/cpu.ts');
const { runTool, runExec } = await import('../src/cpu/worker.ts');
const { CPU_SUITE, describeSuite } = await import('../src/cpu/suite.ts');
const { getTool } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const { GenError } = await import('../src/util.ts');

const python = [path.join(ROOT, '.venv', 'Scripts', 'python.exe'), path.join(ROOT, '.venv', 'bin', 'python'), process.env.HAWKESGEN_TEST_PYTHON ?? '']
  .find((p) => p && fs.existsSync(p));
const pillow = !!python && spawnSync(python, ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;
const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;

const BUCKET = 'hawkes-test-cpu';
const svc = { cls: 'light' as const, name: 'gen-cpu', url: 'https://gen-cpu-x.a.run.app', bucket: BUCKET, pricePerSecond: 0.00006, timeoutSeconds: 900 };

/** A bucket in memory: what Gen reads and writes (stat, read, readJson, write) and what the service does (download). */
function memStore() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async stat(uri: string) { const b = objects.get(uri); return b ? { name: uri, size: b.length } as any : null; },
    async read(uri: string) { return objects.get(uri) ?? null; },
    async readJson(uri: string) { const b = objects.get(uri); return b ? JSON.parse(b.toString('utf8')) : null; },
    async write(uri: string, data: Buffer | string) { objects.set(uri, Buffer.from(data)); },
    async writeJson(uri: string, v: unknown) { objects.set(uri, Buffer.from(JSON.stringify(v))); },
    async download(uri: string, dest: string) {
      const b = objects.get(uri);
      if (!b) throw new Error(`no ${uri}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, b);
    },
  };
}

/**
 * The service, without a network: each POST runs the real worker and streams its NDJSON. `before` can answer instead
 * (a 429, a refusal, a thrown connection error) for the first calls.
 */
function fakeService(store: ReturnType<typeof memStore>, o: { before?: (n: number) => Response | Error | null; breakAfterEmits?: number } = {}) {
  const calls: { route: string; body: any }[] = [];
  let streams = 0;
  const fetchImpl = (async (url: string, init: any) => {
    const route = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ route, body });
    const early = o.before?.(calls.length);
    if (early instanceof Error) throw early;
    if (early) return early;
    const abort = new AbortController();
    init.signal?.addEventListener('abort', () => abort.abort());
    let emits = 0;
    const first = ++streams === 1;
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const enc = new TextEncoder();
        let broken = false;
        const send = (ev: any) => {
          if (broken) return;
          c.enqueue(enc.encode(`${JSON.stringify(ev)}\n`));
          if (ev.t === 'emit' && o.breakAfterEmits && ++emits >= o.breakAfterEmits && first) {
            // As the real service: a closed connection aborts the tool.
            broken = true;
            abort.abort();
            c.error(new Error('socket hang up'));
          }
        };
        const env = { store, python: python ?? 'python', root: ROOT, signal: abort.signal, send };
        const end = route === '/tool' ? await runTool(body, env) : await runExec(body, env);
        if (broken) return;
        send({ ...end, cold: calls.length === 1, startupSeconds: calls.length === 1 ? 1.5 : 0 });
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  }) as unknown as typeof fetch;
  const deps: any = { store, fetch: fetchImpl, idToken: async () => 'id-token', sleep: async () => {}, now: () => Date.now() };
  return { calls, deps };
}

/** A context like jobs.ts gives a tool, recording what Gen files. */
function genCtx(toolId: string, params: Record<string, unknown>, inputs: Record<string, string | string[]>, signal = new AbortController().signal) {
  const tool = getTool(toolId)!;
  const emitted: any[] = [];
  const outputs: { seed: number | null }[] = [];
  const steps: string[] = [];
  let result: unknown = null;
  const ctx: any = {
    job: { id: `j_${toolId}`, client: 't', project: 't', tool: toolId, labels: {} },
    params: validateParams(tool, params), inputs, done: 0, outputs, signal,
    step: (s: string) => steps.push(s), log: () => {}, tmp: (n: string) => path.join(os.tmpdir(), n),
    emit: async (o: any) => { emitted.push(o); outputs.push({ seed: o.seed ?? null }); },
    result: (v: unknown) => { result = v; }, seed: () => 1, usage: () => {},
    python: async () => { throw new Error('the tool must not run here'); },
  };
  return { tool, ctx, emitted, steps, get result() { return result; } };
}

/** A real PNG, w x h RGB. */
function png(w: number, h: number) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 7) & 255; raw[o + 1] = (x ^ y) & 255; raw[o + 2] = (y * 5) & 255; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const tmpFile = (name: string, data: Buffer) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-in-')), name);
  fs.writeFileSync(f, data);
  return f;
};
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

// ------------------------------------------------------------------ settings and routing

test('settings.cpu: local by default; only known backends, tool ids, https URLs and a bucket name are kept', () => {
  assert.equal(loadSettings().cpu.backend, 'local');
  saveSettings({ cpu: { backend: 'mars', tools: { 'image.cutout': 'cloudrun', 'bad id!': 'cloudrun', 'image.tile': 'moon' }, cloudrun: { urls: { light: 'https://gen-cpu-x.a.run.app/', heavy: 'http://evil' }, bucket: 'Bad Bucket', concurrent: 999 } } } as any);
  const c = loadSettings().cpu;
  assert.equal(c.backend, 'local');
  assert.deepEqual(c.tools, { 'image.cutout': 'cloudrun' });
  assert.deepEqual(c.cloudrun.urls, { light: 'https://gen-cpu-x.a.run.app' });
  assert.equal(c.cloudrun.bucket, null);
  assert.equal(c.cloudrun.concurrent, 200);
  // A later save adds the heavy URL without dropping the light one.
  saveSettings({ cpu: { cloudrun: { urls: { heavy: 'https://gen-cpu-heavy-x.a.run.app' }, bucket: BUCKET } } } as any);
  assert.deepEqual(loadSettings().cpu.cloudrun.urls, { light: 'https://gen-cpu-x.a.run.app', heavy: 'https://gen-cpu-heavy-x.a.run.app' });
  // null removes a URL (a patch merges, so leaving one out keeps it).
  saveSettings({ cpu: { cloudrun: { urls: { heavy: null } } } } as any);
  assert.deepEqual(loadSettings().cpu.cloudrun.urls, { light: 'https://gen-cpu-x.a.run.app' });
  saveSettings({ cpu: { backend: 'local', tools: {}, cloudrun: { urls: { light: null, heavy: null }, bucket: null, concurrent: 16 } } } as any);
});

test('routing: a suite tool goes to its class\'s service, else the other one; the rest stay here and say why', () => {
  const s = (cpuSet: any) => ({ cpu: { backend: 'local', tools: {}, ...cpuSet, cloudrun: { urls: {}, bucket: BUCKET, concurrent: 16, ...cpuSet.cloudrun } } }) as any;
  const both = s({ backend: 'cloudrun', cloudrun: { urls: { light: 'https://l.run.app', heavy: 'https://h.run.app' } } });
  assert.equal(cpu.cpuRoute('image.transform', both).service?.name, 'gen-cpu');
  assert.equal(cpu.cpuRoute('image.cutout', both).service?.name, 'gen-cpu-heavy');
  assert.equal(cpu.cpuRoute('video.compose', both).service?.url, 'https://h.run.app');
  assert.equal(cpu.cpuRoute('asset.lod', both).service?.cls, 'heavy');
  // Only the light service: heavy tools use it.
  assert.equal(cpu.cpuRoute('image.cutout', s({ backend: 'cloudrun', cloudrun: { urls: { light: 'https://l.run.app' } } })).service?.url, 'https://l.run.app');
  // Per-tool overrides both ways.
  const one = s({ backend: 'local', tools: { 'sprite.sheet': 'cloudrun' }, cloudrun: { urls: { light: 'https://l.run.app' } } });
  assert.ok(cpu.cpuRoute('sprite.sheet', one).service);
  assert.match(cpu.cpuRoute('image.tile', one).why!, /runs it here/);
  assert.match(cpu.cpuRoute('image.tile', s({ backend: 'cloudrun', tools: { 'image.tile': 'local' }, cloudrun: { urls: { light: 'https://l.run.app' } } })).why!, /runs it here/);
  // Not in the suite, no URL, no bucket.
  assert.match(cpu.cpuRoute('film.plan', both).why!, /Claude/);
  assert.match(cpu.cpuRoute('image.edit', both).why!, /not in the CPU suite/);
  assert.match(cpu.cpuRoute('image.tile', s({ backend: 'cloudrun' })).why!, /no CPU service/);
  assert.match(cpu.cpuRoute('image.tile', { cpu: { ...both.cpu, cloudrun: { ...both.cpu.cloudrun, bucket: null } } } as any).why!, /bucket/);
  assert.equal(cpu.cpuCloudEnabled(s({ backend: 'local' })), false);
  assert.equal(cpu.cpuCloudEnabled(one), true);
});

test('the suite: every tool is a provider-local tool with a real description and a price per class', () => {
  const spec = cpu.loadCpuSpec();
  for (const { tool, typicalSeconds } of CPU_SUITE) {
    assert.equal(tool.provider, 'local', tool.id);
    assert.ok(tool.description.length > 60, `${tool.id} has a description worth showing`);
    assert.doesNotMatch(tool.description, /this machine|this PC/, `${tool.id} doesn't claim to run on one machine`);
    assert.ok(typicalSeconds > 0);
    assert.equal(getTool(tool.id), tool, `${tool.id} is the registered tool, not a copy`);
  }
  assert.equal(describeSuite().length, CPU_SUITE.length);
  // Request-based billing in us-east4: 2 vCPU + 4 GiB, and 4 vCPU + 8 GiB.
  assert.ok(Math.abs(cpu.classPrice(spec, 'light') - (2 * 0.000024 + 4 * 0.0000025)) < 1e-12);
  assert.ok(Math.abs(cpu.classPrice(spec, 'heavy') - (4 * 0.000024 + 8 * 0.0000025)) < 1e-12);
  assert.equal(spec.classes.heavy.concurrency, 1);
});

// ------------------------------------------------------------------ the protocol, against the real worker

test('image.transform runs on the service: the output comes back through the bucket and is filed here', async (t) => {
  if (!pillow) return t.skip('no .venv with Pillow');
  const store = memStore();
  const { calls, deps } = fakeService(store);
  const src = tmpFile('sprite.png', png(200, 100));
  const g = genCtx('image.transform', { ops: [{ op: 'resize', width: 64, height: 64, fit: 'contain' }], format: 'png' }, { image: src });
  const seconds: number[] = [];
  const ran = await cpu.runCpuRemote({ id: 'j_t1' }, g.tool, g.ctx, svc, { addSeconds: (s, cold, up) => seconds.push(s, up, cold ? 1 : 0) }, deps);
  assert.equal(ran, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/tool');
  assert.equal(calls[0].body.tool, 'image.transform');
  assert.equal(calls[0].body.version, g.tool.version);
  assert.match(calls[0].body.inputs.image.uri, new RegExp(`^gs://${BUCKET}/cpu/inputs/[0-9a-f]{64}\\.png$`));
  assert.equal(calls[0].body.inputs.image.name, 'sprite.png');
  assert.equal(g.emitted.length, 1);
  assert.equal(pngSize(g.emitted[0].data)[0], 64, 'resized on the service');
  assert.equal(g.emitted[0].ext, '.png');
  assert.ok(g.result, 'the result came through');
  assert.equal(seconds[2], 1, 'the first request counts the cold start');
  assert.ok(store.objects.has(`${calls[0].body.out}manifest.json`));

  // The same job again (a Gen restart after it finished): the manifest answers, nothing is posted.
  const again = genCtx('image.transform', { ops: [{ op: 'resize', width: 64, height: 64, fit: 'contain' }], format: 'png' }, { image: src });
  assert.equal(await cpu.runCpuRemote({ id: 'j_t1' }, again.tool, again.ctx, svc, { addSeconds: () => {} }, deps), true);
  assert.equal(calls.length, 1);
  assert.equal(again.emitted.length, 1);
  assert.ok(again.steps.some((s) => /already finished/.test(s)));
});

test('a broken stream is asked again and outputs Gen has are not filed twice; 429 waits its turn', async (t) => {
  if (!pillow) return t.skip('no .venv with Pillow');
  const store = memStore();
  // texture.maps makes three outputs: the stream breaks after the first.
  const { calls, deps } = fakeService(store, { breakAfterEmits: 1, before: (n) => (n === 1 ? new Response('busy', { status: 429 }) : null) });
  const g = genCtx('texture.maps', { strength: 2 }, { image: tmpFile('wall.png', png(64, 64)) });
  assert.equal(await cpu.runCpuRemote({ id: 'j_maps' }, g.tool, g.ctx, svc, { addSeconds: () => {} }, deps), true);
  assert.deepEqual(g.emitted.map((e) => e.title), ['albedo', 'normal', 'roughness']);
  assert.equal(calls.length, 3, `429, the broken one, the retry: ${JSON.stringify(g.steps)} ${JSON.stringify(calls.map((c) => [c.route, c.body.done]))}`);
  assert.equal(calls[2].body.done, 1, 'the retry says Gen has one');
  assert.ok(g.steps.some((s) => /waiting for a free instance/.test(s)));
});

test('the tool\'s own refusal reads as it would here; an unreachable or older service runs the job here', async (t) => {
  if (!pillow) return t.skip('no .venv with Pillow');
  const store = memStore();
  const { deps } = fakeService(store);
  const bad = genCtx('image.transform', { ops: [{ op: 'trim' }] }, { image: tmpFile('a.png', png(8, 8)) });
  bad.ctx.params.ops = [];
  await assert.rejects(cpu.runCpuRemote({ id: 'j_bad' }, bad.tool, bad.ctx, svc, { addSeconds: () => {} }, deps), (e: any) => e instanceof GenError && /ops: 1 to 20 steps/.test(e.message));

  const down = fakeService(store, { before: () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) });
  const g = genCtx('image.transform', { ops: [{ op: 'trim' }] }, { image: tmpFile('b.png', png(8, 8)) });
  assert.equal(await cpu.runCpuRemote({ id: 'j_down' }, g.tool, g.ctx, svc, { addSeconds: () => {} }, down.deps), false);
  assert.ok(g.steps.some((s) => /ECONNREFUSED.*running it here/.test(s)));

  const older = genCtx('image.transform', { ops: [{ op: 'trim' }] }, { image: tmpFile('c.png', png(8, 8)) });
  const real = older.tool;
  const newer = { ...real, version: real.version + 1 };
  assert.equal(await cpu.runCpuRemote({ id: 'j_old' }, newer as any, older.ctx, svc, { addSeconds: () => {} }, deps), false);
  assert.ok(older.steps.some((s) => /older image.transform.*running it here/.test(s)));
  assert.match(String(cpu.cpuStatus(loadSettings()).recent.last[0].error), /older/);
});

test('cancelling closes the request and the service stops the tool', async (t) => {
  if (!ffmpeg) return t.skip('no ffmpeg');
  if (!pillow) return t.skip('no .venv with Pillow'); // video.fit runs post/prep.py, which imports Pillow
  const store = memStore();
  const { deps } = fakeService(store);
  const video =path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-v-')), 'long.mp4');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24', '-t', '60', '-pix_fmt', 'yuv420p', video]);
  const abort = new AbortController();
  const g = genCtx('video.fit', { width: 640, height: 640, maxFrames: 481, fps: 24 }, { video }, abort.signal);
  setTimeout(() => abort.abort(), 300);
  await assert.rejects(cpu.runCpuRemote({ id: 'j_cancel' }, g.tool, g.ctx, svc, { addSeconds: () => {} }, deps), /Cancelled/);
});

test('sprite.sheet and media.probe from a real clip, on the service', async (t) => {
  if (!ffmpeg) return t.skip('no ffmpeg');
  const store = memStore();
  const { deps } = fakeService(store);
  const clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-clip-')), 'walk.mp4');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x320:rate=16', '-t', '2', '-pix_fmt', 'yuv420p', clip]);
  const sheet = genCtx('sprite.sheet', { frames: 8, cell: 64, key: '00ff00' }, { video: clip });
  assert.equal(await cpu.runCpuRemote({ id: 'j_sheet' }, sheet.tool, sheet.ctx, svc, { addSeconds: () => {} }, deps), true);
  assert.deepEqual(sheet.emitted.map((e) => e.ext), ['.png', '.json', '.gif']);
  assert.deepEqual(pngSize(sheet.emitted[0].data), [256, 128], '8 frames of 64 px: 4x2');
  assert.equal(JSON.parse(sheet.emitted[1].data.toString()).meta.count, 8);
  const probe = genCtx('media.probe', {}, { file: clip });
  assert.equal(await cpu.runCpuRemote({ id: 'j_probe' }, probe.tool, probe.ctx, svc, { addSeconds: () => {} }, deps), true);
  assert.equal((probe.result as any).streams[0].width, 320);
});

// ------------------------------------------------------------------ the LOD system's commands

test('lod-images and lod-mesh on the service: levels land at Gen\'s own <stem><suffix>', async (t) => {
  if (!pillow) return t.skip('no .venv with Pillow');
  const store = memStore();
  const { calls, deps } = fakeService(store);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-lod-'));
  const img = path.join(dir, 'a_sky.png');
  fs.writeFileSync(img, png(1200, 600));
  const stem = path.join(dir, 'a_sky.lod');
  const r = await cpu.cpuExec('lod-images', { images: [{ in: img, out: stem }] }, { ...svc, cls: 'heavy' }, {}, deps);
  assert.equal(calls[0].route, '/exec');
  const levels = r.images[0].levels;
  assert.deepEqual(levels.map((l: any) => l.level), [128, 256, 512, 1024, 1200]);
  for (const l of levels) {
    assert.ok(l.path.startsWith(stem) && fs.existsSync(l.path), `${l.path} is beside the asset`);
    assert.equal(l.uri, undefined);
  }

  const { Document, NodeIO } = await import('@gltf-transform/core');
  const doc = new Document();
  const buf = doc.createBuffer();
  const n = 40;
  const pos: number[] = [], idx: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i / n, Math.sin(i * 0.7) * 0.1, j / n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * (n + 1) + i; idx.push(k, k + n + 1, k + 1, k + 1, k + n + 1, k + n + 2); }
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buf));
  doc.createScene().addChild(doc.createNode('grid').setMesh(doc.createMesh('grid').addPrimitive(prim)));
  const model = path.join(dir, 'a_rock.glb');
  fs.writeFileSync(model, Buffer.from(await new NodeIO().writeBinary(doc)));
  const mstem = path.join(dir, 'a_rock.lod');
  const m = await cpu.cpuExec('lod-mesh', { in: model, out: mstem, python: 'unused', script: 'unused' }, { ...svc, cls: 'heavy' }, {}, deps);
  assert.equal(m.triangles, n * n * 2);
  assert.ok(m.levels.length >= 1);
  for (const l of m.levels) assert.ok(l.path.startsWith(mstem) && l.path.endsWith('.glb') && fs.statSync(l.path).size > 0);
});

test('GET /v1/cpu: every suite tool says where it runs and why; prices per class', () => {
  saveSettings({ cpu: { backend: 'cloudrun', tools: { 'image.cutout': 'local' }, cloudrun: { urls: { light: 'https://gen-cpu-x.a.run.app' }, bucket: BUCKET, concurrent: 8 } } } as any);
  const s = cpu.cpuStatus(loadSettings());
  const by = Object.fromEntries(s.suite.map((t: any) => [t.id, t]));
  assert.equal(by['image.transform'].runs, 'cloudrun:gen-cpu');
  assert.equal(by['image.cutout'].runs, 'local');
  assert.equal(by['video.compose'].runs, 'cloudrun:gen-cpu', 'heavy tools use the light service while heavy has no URL');
  assert.equal(s.services!.heavy.url, null);
  assert.ok(s.services!.light.pricePerHour > 0);
  assert.ok(s.staysLocal['film.plan']);
  saveSettings({ cpu: { backend: 'local', tools: {}, cloudrun: { urls: { light: null, heavy: null }, bucket: null, concurrent: 16 } } } as any);
});

// ------------------------------------------------------------------ through the queue

test('the queue sends an image.transform job to gen-cpu, files its output and records the instance seconds as its cost', async (t) => {
  if (!pillow) return t.skip('no .venv with Pillow');
  const store = memStore();
  const fake = fakeService(store);
  cpu.setCpuDeps(fake.deps as any);
  saveSettings({ cpu: { backend: 'local', tools: { 'image.transform': 'cloudrun' }, cloudrun: { urls: { light: 'https://gen-cpu-x.a.run.app' }, bucket: BUCKET, concurrent: 4 } } } as any);
  const { submit, getJob, queue } = await import('../src/jobs.ts');
  const { db } = await import('../src/db.ts');
  const { getAsset } = await import('../src/library.ts');
  const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;
  const job = submit(owner, { tool: 'image.transform', project: 'sandbox', params: { ops: [{ op: 'resize', width: 32, height: 32 }] }, inputs: { image: tmpFile('q.png', png(100, 100)) } });
  for (let i = 0; i < 200 && !['done', 'failed'].includes(getJob(job.id)!.status); i++) {
    (queue as any).pump();
    await new Promise((r) => setTimeout(r, 25));
  }
  const j = getJob(job.id)!;
  assert.equal(j.status, 'done', j.error ?? '');
  assert.equal(j.server, 'cloudrun:gen-cpu');
  assert.equal(j.outputs.length, 1);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(pngSize(fs.readFileSync(getAsset(j.outputs[0].asset)!.path)), [32, 32], 'the service\'s output, filed in the library');
  const u = db.prepare("SELECT * FROM usage WHERE job = ? AND provider = 'gcp-cpu'").get(job.id) as any;
  assert.ok(u, 'usage recorded');
  assert.ok(u.amount >= 1.5, 'run seconds plus the cold start');
  assert.ok(Math.abs(u.cost - u.amount * cpu.classPrice(cpu.loadCpuSpec(), 'light')) < 1e-5);
  cpu.setCpuDeps(null);
  saveSettings({ cpu: { backend: 'local', tools: {}, cloudrun: { urls: { light: null, heavy: null }, bucket: null, concurrent: 16 } } } as any);
});

test('asset.lod routed to Cloud Run: makeLods sends the image work to /exec and keeps the levels with the asset', async (t) => {
  if (!pillow) return t.skip('no .venv with Pillow');
  const store = memStore();
  const fake = fakeService(store);
  cpu.setCpuDeps(fake.deps as any);
  saveSettings({ cpu: { backend: 'local', tools: { 'asset.lod': 'cloudrun' }, cloudrun: { urls: { heavy: 'https://gen-cpu-heavy-x.a.run.app' }, bucket: BUCKET, concurrent: 4 } } } as any);
  const { putAsset } = await import('../src/library.ts');
  const lod = await import('../src/lod.ts');
  const a = putAsset({ data: png(600, 300), ext: '.png', client: 'test', project: 'sandbox', tool: 'test', recipe: { tool: 'test', version: 1, params: {}, inputs: {} } });
  await lod.makeLods([a.id]);
  assert.equal(fake.calls.filter((c) => c.route === '/exec').length, 1);
  const s = lod.lodSummary(a.id)!;
  assert.equal(s.state, 'done');
  assert.deepEqual(s.levels.map((l: any) => l.level), [128, 256, 512, 600]);
  cpu.setCpuDeps(null);
  saveSettings({ cpu: { backend: 'local', tools: {}, cloudrun: { urls: { light: null, heavy: null }, bucket: null, concurrent: 16 } } } as any);
});

// ------------------------------------------------------------------ the image and the services

test('the image carries only what the service imports: no database, queue or library, and Gen\'s exact package versions', async () => {
  const lib = await import('../tools/cpu-cloudrun/lib.mjs');
  const { files, packages } = lib.sourceClosure();
  for (const must of ['server/cpu-cloudrun/server.ts', 'src/cpu/worker.ts', 'src/cpu/suite.ts', 'src/tools/local.ts', 'src/tools/compose.ts', 'src/tools/film-video.ts', 'src/tools/sheet.ts', 'src/lod-mesh.ts', 'src/util.ts']) assert.ok(files.includes(must), must);
  for (const never of ['src/db.ts', 'src/jobs.ts', 'src/library.ts', 'src/lod.ts', 'src/api.ts', 'src/tools/index.ts']) assert.ok(!files.includes(never), `${never} stays out of the service`);
  assert.deepEqual(packages.filter((p: string) => !lib.NODE_PACKAGES.includes(p)), []);
  const pkg = JSON.parse(lib.packageJson());
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.dependencies['meshoptimizer'], lock.packages['node_modules/meshoptimizer'].version);
  const ctx = lib.buildContext();
  assert.ok(ctx.files['app/post/cutout.py'] && ctx.files['app/post/lod.py'] && ctx.files.Dockerfile);
  assert.ok(!Object.keys(ctx.files).some((f) => /\.env|\.data|\.pem/.test(f)), 'no secrets or data in the context');
  assert.match(ctx.hash, /^[0-9a-f]{12}$/);
  assert.equal(lib.buildContext().hash, ctx.hash, 'the same sources give the same tag');
});

test('the services: scale to zero, request-based billing, the class\'s size; Gen\'s settings patch shape', async () => {
  const lib = await import('../tools/cpu-cloudrun/lib.mjs');
  const spec = lib.loadSpec();
  for (const cls of ['light', 'heavy']) {
    const y = lib.serviceYaml(spec, cls, { image: 'img', region: 'us-east4', serviceAccount: 'gen-cpu@p.iam.gserviceaccount.com', bucket: 'b' });
    const a = y.spec.template.metadata.annotations;
    assert.equal(a['autoscaling.knative.dev/minScale'], '0');
    assert.equal(a['run.googleapis.com/cpu-throttling'], 'true', 'CPU billed only while a request runs');
    assert.equal(y.spec.template.spec.containerConcurrency, spec.classes[cls].concurrency);
    assert.equal(y.spec.template.spec.containers[0].resources.limits.cpu, String(spec.classes[cls].cpu));
    assert.equal(y.metadata.name, spec.classes[cls].name);
  }
  assert.equal(lib.bucketOf({ project: 'hawkes-staging' }), 'hawkes-staging-gen-cpu');
});
