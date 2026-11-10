// The Cloud Run GPU backend (docs/cloudrun.md), with no Google Cloud: the service map's sanity, the routing rule, the
// per-graph request protocol against a fake service and bucket (inputs up, outputs down, a run answered from its
// manifest after a restart, waiting on a heartbeat, a busy service, cancel, the time limit), a whole job through the
// queue with its cost in usage, the GCS library store, and the worker's Python helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cloudrun-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
const { loadServiceMap, cloudRoute, pricePerSecond, serviceForFamily, allServices } = await import('../src/providers/cloudrun/services.ts');
const { cloudComfyRun, runKey, jobSeed, inputsOf, stableJson, setCloudDeps } = await import('../src/providers/cloudrun/run.ts');
const { getTool } = await import('../src/tools/index.ts');
const { saveSettings, loadSettings, ROOT } = await import('../src/config.ts');
const { gcsStore } = await import('../src/storage.ts');
const { Gcs } = await import('../src/providers/gcp/gcs.ts');

const map = loadServiceMap();

// ------------------------------------------------------------------ the map

test('services.json: every service fits its GPU minimums, every family has one service, prices are there', () => {
  const seen = new Map<string, string>();
  for (const [name, s] of Object.entries(map.services)) {
    const g = map.gpus[s.gpu];
    assert.ok(g, `${name}: GPU ${s.gpu} is described`);
    assert.ok(s.cpu >= g.minCpu && s.memoryGi >= g.minMemoryGi, `${name}: at least ${g.minCpu} vCPU and ${g.minMemoryGi} GiB`);
    assert.ok(s.maxInstances >= 1 && s.maxInstances <= 10, `${name}: a sane max instances`);
    assert.ok(['download', 'mount'].includes(s.load));
    assert.ok(pricePerSecond(map, s) > 0);
    for (const f of s.families) {
      assert.ok(!seen.has(f), `${f} is in ${seen.get(f)} and ${name}`);
      seen.set(f, name);
    }
  }
  // Families whose tools work over SSH never go to Cloud Run.
  for (const f of ['blender', 'rig', 'motion']) assert.ok(!seen.has(f), `${f} stays on the fleet`);
});

test('services.json: every model a service preloads has a download source (models.json or a workflow)', () => {
  const sources = new Set<string>();
  for (const m of JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'models.json'), 'utf8')).models) sources.add(`${m.dir}/${m.file}`);
  for (const d of fs.readdirSync(path.join(ROOT, 'workflows'))) {
    const f = path.join(ROOT, 'workflows', d, 'workflow.json');
    if (fs.existsSync(f)) for (const m of JSON.parse(fs.readFileSync(f, 'utf8')).models ?? []) if (m.url) sources.add(`${m.dir}/${m.file}`);
  }
  sources.add('loras/qwen-image-edit-2511-multiple-angles-lora.safetensors'); // graphs.ts ANGLES_LORA
  for (const [name, s] of Object.entries(allServices(map))) for (const m of s.models) assert.ok(sources.has(m), `${name}: ${m} has a source`);
});

// ------------------------------------------------------------------ routing

const settingsWith = (gpu: any) => ({ gpu: { backend: 'fleet', families: {}, ...gpu, cloudrun: { bucket: 'b', urls: {}, services: {}, ...(gpu.cloudrun ?? {}) } } }) as any;

test('routing: Cloud Run only when the family says so, the service is deployed and the tool is ComfyUI only', () => {
  const tool = { provider: 'comfy', gpuSeconds: () => 30 } as any;
  const job = { family: 'z-image', params: {}, labels: {} };
  const urls = { 'gen-z-image': 'https://gen-z-image-abc.a.run.app' };
  assert.equal(cloudRoute(job, tool, settingsWith({}), map).service, null, 'fleet by default');
  assert.equal(cloudRoute(job, tool, settingsWith({ backend: 'cloudrun' }), map).service, null, 'not deployed: no URL');
  const r = cloudRoute(job, tool, settingsWith({ backend: 'cloudrun', cloudrun: { urls } }), map);
  assert.equal(r.service?.name, 'gen-z-image');
  assert.equal(r.service?.maxInstances, map.services['gen-z-image'].maxInstances, 'concurrency = max instances');
  assert.equal(cloudRoute(job, tool, settingsWith({ backend: 'fleet', families: { 'z-image': 'cloudrun' }, cloudrun: { urls } }), map).service?.name, 'gen-z-image', 'per-family override');
  assert.equal(cloudRoute(job, tool, settingsWith({ backend: 'cloudrun', families: { 'z-image': 'fleet' }, cloudrun: { urls } }), map).service, null);
  assert.equal(cloudRoute(job, { ...tool, server: 'ssh' }, settingsWith({ backend: 'cloudrun', cloudrun: { urls } }), map).service, null, 'SSH tools stay on the fleet');
  assert.equal(cloudRoute({ ...job, labels: { gpuBackend: 'fleet' } }, tool, settingsWith({ backend: 'cloudrun', cloudrun: { urls } }), map).service, null, 'a job sent back to the fleet stays there');
  assert.equal(cloudRoute(job, { ...tool, gpuSeconds: () => 3 * 3600 }, settingsWith({ backend: 'cloudrun', cloudrun: { urls } }), map).service, null, 'a graph past the limit goes to the fleet');
  assert.equal(cloudRoute({ ...job, family: 'blender' }, tool, settingsWith({ backend: 'cloudrun', cloudrun: { urls } }), map).service, null, 'unmapped family');
  assert.equal(serviceForFamily(map, 'qwen-edit', { 'qwen-edit': 'gen-qwen-edit-l4' }), 'gen-qwen-edit-l4', 'a pilot alternative by settings');
});

test('the SSH tools and the 3D tools are marked, so they never route to Cloud Run', () => {
  for (const id of ['lora.train', 'image.character']) assert.equal(getTool(id)?.server, 'ssh', id);
  // The 3D tools run a script on the fleet or a GPU worker with the 3D image (docs/3d-animation.md): never ComfyUI services.
  const urls = { 'gen-z-image': 'https://gen-z-image-abc.a.run.app' };
  for (const id of ['blender.render', 'blender.character', 'mesh.rig', 'motion.from-text', 'motion.from-video']) {
    const t = getTool(id)!;
    assert.equal(t.image, '3d', id);
    assert.equal(t.server, undefined, `${id} is no longer SSH-only`);
    assert.equal(cloudRoute({ family: String(t.family), params: {}, labels: {} }, t, settingsWith({ backend: 'cloudrun', cloudrun: { urls } }), map!).service, null, id);
  }
  assert.equal(getTool('image.generate')?.server, undefined);
  assert.equal(getTool('image.generate')?.image, undefined);
});

test('settings.gpu is cleaned: bad URLs, backends and names are dropped; urls merge on save', () => {
  saveSettings({ gpu: { backend: 'cloudrun', families: { 'z-image': 'cloudrun', bad: 'mars' } as any, cloudrun: { bucket: 'hawkes-staging-gen-gpu', urls: { 'gen-z-image': 'https://gen-z-image-x.a.run.app/', evil: 'http://x' }, services: {} } } } as any);
  saveSettings({ gpu: { cloudrun: { urls: { 'gen-qwen-edit': 'https://gen-qwen-edit-x.a.run.app' } } } } as any);
  const g = loadSettings().gpu;
  assert.equal(g.backend, 'cloudrun');
  assert.deepEqual(g.families, { 'z-image': 'cloudrun' });
  assert.deepEqual(g.cloudrun.urls, { 'gen-z-image': 'https://gen-z-image-x.a.run.app', 'gen-qwen-edit': 'https://gen-qwen-edit-x.a.run.app' });
  saveSettings({ gpu: { backend: 'fleet', families: {}, cloudrun: { bucket: null, urls: {}, services: {} } } } as any);
});

// ------------------------------------------------------------------ keys

test('run keys and seeds are stable, so a job picked up again finds its runs', () => {
  const g1 = { '1': { class_type: 'A', inputs: { b: 1, a: 'x' } } };
  const g2 = { '1': { inputs: { a: 'x', b: 1 }, class_type: 'A' } };
  assert.equal(stableJson(g1), stableJson(g2));
  assert.equal(runKey('j_1', g1), runKey('j_1', g2));
  assert.notEqual(runKey('j_1', g1), runKey('j_2', g1));
  assert.equal(jobSeed('j_1', 0), jobSeed('j_1', 0));
  assert.notEqual(jobSeed('j_1', 0), jobSeed('j_1', 1));
  assert.ok(jobSeed('j_1', 3) >= 1 && jobSeed('j_1', 3) < 2 ** 31);
  const names = new Map([['hawkesgen/abc.png', 'gs://b/in/abc.png'], ['hawkesgen/zzz.png', 'gs://b/in/zzz.png']]);
  assert.deepEqual(inputsOf({ '1': { inputs: { image: 'hawkesgen/abc.png [input]', n: 3 } } }, names), { 'hawkesgen/abc.png': 'gs://b/in/abc.png' });
});

// ------------------------------------------------------------------ a fake service and bucket

type Fake = ReturnType<typeof fakeCloud>;
function fakeCloud(behave: (body: any, fake: any) => any[] | { status: number } = () => []) {
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
  const fake = {
    objects, posts, store,
    deps: {
      store: store as any,
      idToken: async () => 'id-token',
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      fetch: (async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        posts.push({ url, body, auth: init.headers.Authorization });
        const lines = behave(body, fake);
        if (!Array.isArray(lines)) return new Response('busy', { status: lines.status });
        const enc = new TextEncoder();
        return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } }), { status: 200 });
      }) as any,
    },
  };
  return fake;
}

/** What the worker does on success: writes the outputs and the manifest, answers done. */
function succeed(body: any, fake: Fake) {
  for (const [name, uri] of Object.entries<string>(body.files)) assert.ok(fake.objects.has(uri), `input ${name} is in the bucket before the run`);
  const uri = `${body.out}00-out.png`;
  fake.objects.set(uri, Buffer.from(`made from ${Object.keys(body.files).join(',')}`));
  const done = { t: 'done', files: [{ filename: 'out.png', subfolder: '', type: 'output', node: '9', uri, bytes: 10 }], seconds: 12, cold: { startupSeconds: 40 } };
  fake.objects.set(`${body.out}manifest.json`, Buffer.from(JSON.stringify(done)));
  return [{ t: 'progress', detail: 'running for 5s' }, done];
}

const svc = (over: any = {}) => ({ name: 'gen-z-image', url: 'https://gen-z-image.run.app', gpu: 'nvidia-l4', maxInstances: 2, pricePerSecond: 0.0004, graphLimitSeconds: 3300, preload: new Set(['vae/ae.safetensors']), bucket: 'bkt', ...over });
const hooks = (over: any = {}) => {
  const h = { steps: [] as string[], seconds: 0, startup: 0, graphs: 0, signal: new AbortController().signal, ...over };
  return Object.assign(h, {
    step: (d: string) => h.steps.push(d),
    progress: () => {},
    keepGraph: () => { h.graphs++; },
    addSeconds: (s: number, st: number) => { h.seconds += s; h.startup += st; },
  });
};

test('a graph is one request: inputs go to the bucket first, outputs come back from it, extra models ride along', async () => {
  const fake = fakeCloud(succeed);
  const h = hooks();
  const c = cloudComfyRun({ id: 'j_a' }, svc() as any, h as any, fake.deps as any);
  const name = await c.uploadBuffer(Buffer.from('png bytes'), 'pose.png');
  assert.match(name, /^hawkesgen\/[0-9a-f]{16}\.png$/);
  await c.ensureModels([{ dir: 'vae', file: 'ae.safetensors', url: '' }, { dir: 'loras', file: 'extra.safetensors', url: '' }] as any);
  const files = await c.runGraph({ '1': { class_type: 'LoadImage', inputs: { image: name } } } as any);
  assert.equal(fake.posts.length, 1);
  const p = fake.posts[0];
  assert.equal(p.url, 'https://gen-z-image.run.app/run');
  assert.equal(p.auth, 'Bearer id-token');
  assert.deepEqual(Object.keys(p.body.files), [name]);
  assert.deepEqual(p.body.models, [{ dir: 'loras', file: 'extra.safetensors' }], 'preloaded models are not sent');
  assert.equal(p.body.out, `gs://bkt/cloudrun/runs/${p.body.key}/`);
  assert.equal((await c.download(files[0])).toString(), `made from ${name}`);
  assert.equal(h.seconds, 12);
  assert.equal(h.startup, 40, 'the cold start is the job\'s that paid for it');
  assert.equal(h.graphs, 1);
});

test('after a restart, a finished run is answered from its manifest without the GPU', async () => {
  const fake = fakeCloud(succeed);
  const graph = { '1': { class_type: 'X', inputs: { seed: 5 } } } as any;
  await cloudComfyRun({ id: 'j_b' }, svc() as any, hooks() as any, fake.deps as any).runGraph(graph);
  assert.equal(fake.posts.length, 1);
  // The same job, the same graph (deterministic seeds): no second request.
  const h = hooks();
  const files = await cloudComfyRun({ id: 'j_b' }, svc() as any, h as any, fake.deps as any).runGraph(structuredClone(graph));
  assert.equal(fake.posts.length, 1, 'no new run');
  assert.equal(files[0].filename, 'out.png');
  assert.ok(h.steps.some((s: string) => /already ran/.test(s)));
});

test('a run still going elsewhere (fresh heartbeat) is waited for, not run twice', async () => {
  const fake = fakeCloud(succeed);
  const graph = { '1': { class_type: 'X', inputs: { seed: 6 } } } as any;
  const out = `gs://bkt/cloudrun/runs/${runKey('j_c', graph)}/`;
  fake.objects.set(`${out}heartbeat.json`, Buffer.from(JSON.stringify({ at: fake.deps.now(), detail: 'running for 40s' })));
  let polls = 0;
  fake.deps.sleep = async (ms: number) => {
    polls++;
    if (polls === 2) fake.objects.set(`${out}manifest.json`, Buffer.from(JSON.stringify({ t: 'done', files: [{ filename: 'late.png', subfolder: '', type: 'output', uri: `${out}00-late.png` }], seconds: 30 })));
    void ms;
  };
  const files = await cloudComfyRun({ id: 'j_c' }, svc() as any, hooks() as any, fake.deps as any).runGraph(graph);
  assert.equal(fake.posts.length, 0);
  assert.equal(files[0].filename, 'late.png');
});

test('a busy service (429) is waited out; a broken stream falls back to the manifest', async () => {
  let n = 0;
  const fake = fakeCloud((body, f) => {
    n++;
    if (n === 1) return { status: 429 };
    // The stream breaks before the answer, but the instance finished and left its manifest.
    succeed(body, f);
    return [{ t: 'progress', detail: 'saving' }];
  });
  const h = hooks();
  const files = await cloudComfyRun({ id: 'j_d' }, svc() as any, h as any, fake.deps as any).runGraph({ '1': { class_type: 'X', inputs: {} } } as any);
  assert.equal(fake.posts.length, 2);
  assert.equal(files[0].filename, 'out.png');
  assert.ok(h.steps.some((s: string) => /waiting for a free Cloud Run GPU/.test(s)));
});

test('errors: over the time limit is flagged (the queue sends it to the fleet), a missing model says how to fix it', async () => {
  const over = fakeCloud(() => [{ t: 'error', message: 'ran past this service\'s 3300 s limit', overLimit: true, seconds: 3300 }]);
  await assert.rejects(cloudComfyRun({ id: 'j_e' }, svc() as any, hooks() as any, over.deps as any).runGraph({} as any), (e: any) => e.overLimit === true);
  const missing = fakeCloud(() => [{ t: 'error', message: 'ComfyUI rejected the workflow', missingModels: ['x.safetensors'], seconds: 1 }]);
  await assert.rejects(cloudComfyRun({ id: 'j_f' }, svc() as any, hooks() as any, missing.deps as any).runGraph({} as any), /models-sync/);
  const denied = fakeCloud(() => ({ status: 403 }));
  await assert.rejects(cloudComfyRun({ id: 'j_g' }, svc() as any, hooks() as any, denied.deps as any).runGraph({} as any), /run.invoker/);
  // A worker whose disk is full can't take the job: the provider cools down and the job goes to the next one (2026-10-30).
  const full = fakeCloud(() => [{ t: 'error', message: '[Errno 28] No space left on device', seconds: 2 }]);
  await assert.rejects(cloudComfyRun({ id: 'j_h' }, svc() as any, hooks() as any, full.deps as any).runGraph({} as any), (e: any) => e.unavailable === true && e.diskFull === true && /ran out of disk/.test(e.message));
});

test('cancelling writes the cancel marker the instance watches for', async () => {
  const ac = new AbortController();
  const fake = fakeCloud(() => { ac.abort(); return []; });
  const graph = { '1': { class_type: 'X', inputs: { seed: 9 } } } as any;
  await assert.rejects(cloudComfyRun({ id: 'j_h' }, svc() as any, hooks({ signal: ac.signal }) as any, fake.deps as any).runGraph(graph), /Cancelled/);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fake.objects.has(`gs://bkt/cloudrun/runs/${runKey('j_h', graph)}/cancel`));
});

// ------------------------------------------------------------------ through the queue

test('the queue sends a z-image job to its Cloud Run service and records the instance seconds as its cost', async () => {
  const fake = fakeCloud(succeed);
  setCloudDeps(fake.deps as any);
  saveSettings({ gpu: { backend: 'fleet', families: { 'z-image': 'cloudrun' }, cloudrun: { bucket: 'bkt', urls: { 'gen-z-image': 'https://gen-z-image.run.app' }, services: {} } } } as any);
  const { submit, getJob, queue } = await import('../src/jobs.ts');
  const { db } = await import('../src/db.ts');
  const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;
  const job = submit(owner, { tool: 'comfy.graph', project: 'sandbox', params: { family: 'z-image', graph: { '9': { class_type: 'SaveImage', inputs: { seed: '{{seed}}' } } } } });
  for (let i = 0; i < 100 && !['done', 'failed'].includes(getJob(job.id)!.status); i++) {
    (queue as any).pump();
    await new Promise((r) => setTimeout(r, 20));
  }
  const j = getJob(job.id)!;
  assert.equal(j.status, 'done', j.error ?? '');
  assert.equal(j.server, 'cloudrun:gen-z-image');
  assert.equal(j.outputs.length, 1);
  assert.equal(fake.posts.length, 1);
  assert.equal(fake.posts[0].body.graph['9'].inputs.seed, jobSeed(job.id, 0), 'a seed derived from the job id');
  const u = db.prepare("SELECT * FROM usage WHERE job = ? AND provider = 'gcp-gpu'").get(job.id) as any;
  assert.ok(u, 'usage recorded');
  assert.equal(u.amount, 52, 'run seconds plus the cold start');
  assert.ok(Math.abs(u.cost - 52 * pricePerSecond(map, map.services['gen-z-image'])) < 1e-5, 'instance seconds x the service price');
  setCloudDeps(null);
  saveSettings({ gpu: { backend: 'fleet', families: {}, cloudrun: { bucket: null, urls: {}, services: {} } } } as any);

});

// ------------------------------------------------------------------ storage

test('the GCS library store keeps the same keys and metadata as S3', async () => {
  const objects = new Map<string, { data: Buffer; contentType?: string; cacheControl?: string }>();
  const client = {
    async stat(uri: string) { const o = objects.get(uri); return o ? { name: uri, size: o.data.length, contentType: o.contentType, cacheControl: o.cacheControl } : null; },
    async writeFile(uri: string, file: string, contentType: string, cacheControl: string) { objects.set(uri, { data: fs.readFileSync(file), contentType, cacheControl }); },
    async patch(uri: string, meta: any) { Object.assign(objects.get(uri)!, meta); },
    async del(uri: string) { objects.delete(uri); },
    async download(uri: string, dest: string) { fs.writeFileSync(dest, objects.get(uri)!.data); },
  };
  const s = gcsStore('lib', client as any);
  const f = path.join(process.env.HAWKESGEN_DATA_DIR!, 'x.txt');
  fs.writeFileSync(f, 'hello');
  assert.equal(await s.has('sha256/abc'), false);
  await s.put('sha256/abc', f, 5, 'text/plain');
  assert.equal(await s.has('sha256/abc'), true);
  assert.equal(objects.get('gs://lib/sha256/abc')!.cacheControl, 'public, max-age=31536000, immutable');
  assert.deepEqual(await s.head!('sha256/abc'), { contentType: 'text/plain', cacheControl: 'public, max-age=31536000, immutable' });
  const back = path.join(process.env.HAWKESGEN_DATA_DIR!, 'back.txt');
  await s.get('sha256/abc', back);
  assert.equal(fs.readFileSync(back, 'utf8'), 'hello');
  await s.del!(['sha256/abc']);
  assert.equal(await s.has('sha256/abc'), false);
});

test('the GCS client: a small write is one request; a resumable upload sends the right range and finishes', async () => {
  const calls: { url: string; method: string; headers: Headers; body?: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body });
    if (String(url).includes('uploadType=resumable')) return new Response('', { status: 200, headers: { location: 'https://upload.example/session1' } });
    if (url === 'https://upload.example/session1') return new Response('{}', { status: 200 });
    return new Response('{}', { status: 200 });
  }) as any;
  const g = new Gcs({ fetchImpl, tokens: { access: async () => 'tok', id: async () => 'id' } });
  await g.write('gs://b/a/b c.json', '{"x":1}', 'application/json');
  assert.match(calls[0].url, /uploadType=media&name=a%2Fb%20c\.json/);
  assert.equal(calls[0].headers.get('authorization'), 'Bearer tok');
  calls.length = 0;
  const session = await g.startResumable('gs://b/big.bin', 10, 'application/octet-stream');
  await g.writeStream('gs://b/big.bin', (async function* () { yield new Uint8Array([1, 2, 3, 4]); yield new Uint8Array([5, 6, 7, 8, 9, 10]); })(), 10, 'application/octet-stream', undefined, { session });
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.headers.get('content-range'), 'bytes 0-9/10');
  // Resuming from byte 4 with a stream that starts there (a Range read): only bytes 4-9 go.
  calls.length = 0;
  await g.writeStream('gs://b/big.bin', (async function* () { yield new Uint8Array([5, 6, 7, 8, 9, 10]); })(), 10, 'application/octet-stream', undefined, { session, from: 4, streamOffset: 4 });
  assert.equal(calls[0].headers.get('content-range'), 'bytes 4-9/10');
});

// ------------------------------------------------------------------ the worker

test('worker.py compiles, and its helpers fill defaults, list outputs and find models in the mount', (t) => {
  const py = ['python3', 'python', 'py'].find((p) => spawnSync(p, ['--version']).status === 0);
  if (!py) return t.skip('no Python here');
  const dir = path.join(ROOT, 'server', 'cloudrun');
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-mount-'));
  const comfy = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-comfy-'));
  fs.mkdirSync(path.join(mount, 'loras'), { recursive: true });
  fs.writeFileSync(path.join(mount, 'loras', 'x.safetensors'), 'w');
  fs.mkdirSync(path.join(comfy, 'models', 'vae'), { recursive: true });
  fs.writeFileSync(path.join(comfy, 'models', 'vae', 'ae.safetensors'), 'w');
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dir)})
import worker
worker.object_info = {"KSampler": {"input": {"required": {"seed": ["INT", {"default": 0}], "sampler_name": [["euler", "dpm"], {}], "model": ["MODEL"]}}}}
g = {"1": {"class_type": "KSampler", "inputs": {"model": ["2", 0]}}, "2": {"class_type": "L", "inputs": {"lora": "x.safetensors", "vae": "ae.safetensors"}}}
worker.fill_defaults(g)
files = worker.output_files({"9": {"images": [{"filename": "a.png", "subfolder": "", "type": "output"}, {"filename": "t.png", "type": "temp"}]}})
print(json.dumps({"inputs": g["1"]["inputs"], "files": files, "models": worker.graph_models(g)}))
`;
  const r = spawnSync(py, ['-c', code], { encoding: 'utf8', env: { ...process.env, MODELS_MOUNT: mount, COMFY_DIR: comfy } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.deepEqual(out.inputs, { model: ['2', 0], seed: 0, sampler_name: 'euler' });
  assert.deepEqual(out.files, [{ filename: 'a.png', subfolder: '', type: 'output', node: '9' }]);
  assert.deepEqual(out.models, ['loras/x.safetensors'], 'only what the instance lacks and the mount has');
});

test("worker.py makes room: old run leftovers go, then the least recently used models, never the job's own", (t) => {
  const py = ['python3', 'python', 'py'].find((p) => spawnSync(p, ['--version']).status === 0);
  if (!py) return t.skip('no Python here');
  const dir = path.join(ROOT, 'server', 'cloudrun');
  const comfy = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-room-'));
  const put = (rel: string, body: string, ageS: number) => {
    const p = path.join(comfy, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    const t0 = Date.now() / 1000 - ageS;
    fs.utimesSync(p, t0, t0);
  };
  put('input/hawkesgen/old.png', 'x', 7200);
  put('input/hawkesgen/fresh.png', 'x', 10);
  put('models/vae/oldest.safetensors', 'xx', 9000);
  put('models/vae/older.safetensors', 'xx', 8000);
  put('models/vae/needed.safetensors', 'xx', 9500);
  const code = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(dir)})
import worker
start = {p: os.path.getsize(p) for p in [os.path.join(worker.COMFY_DIR, 'models', 'vae', f) for f in ('oldest.safetensors', 'older.safetensors', 'needed.safetensors')]}
# The disk, standing in: what's free is what has been removed.
worker.free_bytes = lambda: sum(s for p, s in start.items() if not os.path.exists(p))
freed = worker.make_room(keep=[os.path.join(worker.COMFY_DIR, 'models', 'vae', 'needed.safetensors')], need=2)
left = sorted(os.path.relpath(os.path.join(d, f), worker.COMFY_DIR).replace(os.sep, '/') for d, _, fs in os.walk(worker.COMFY_DIR) for f in fs)
print(json.dumps({"freed": freed, "left": left}))
`;
  const r = spawnSync(py, ['-c', code], { encoding: 'utf8', env: { ...process.env, COMFY_DIR: comfy } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.equal(out.freed, 2);
  assert.deepEqual(out.left, ['input/hawkesgen/fresh.png', 'models/vae/needed.safetensors', 'models/vae/older.safetensors'],
    'the old input went; the oldest model went; the one the job needs stayed even though it is older still');
});

test("worker.py makes room for what a job downloads, and a failed run leaves nothing behind", (t) => {
  const py = ['python3', 'python', 'py'].find((p) => spawnSync(p, ['--version']).status === 0);
  if (!py) return t.skip('no Python here');
  const dir = path.join(ROOT, 'server', 'cloudrun');
  const comfy = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-room2-'));
  const code = `
import json, os, sys, time
sys.path.insert(0, ${JSON.stringify(dir)})
import worker
asked = []
worker.make_room = lambda keep=(), need=None, on_step=None: asked.append(need) or 0
class Store:
    def stat(self, uri): return {"size": 30 * 10**9} if uri.endswith("big.safetensors") else None
    def download(self, uri, dest, parallel=4):
        os.makedirs(os.path.dirname(dest), exist_ok=True); open(dest, "w").close(); return 0
worker.MODEL_LOAD = "download"
worker.mounted = lambda: False
worker.place_models(["diffusion_models/big.safetensors", "vae/small.safetensors"], store=Store(), bucket="b")
# A run whose graph fails half way: its partial output and its input are gone once the run lets go of the GPU.
out = os.path.join(worker.COMFY_DIR, "output", "hawkesgen", "u1", "partial.mp4")
os.makedirs(os.path.dirname(out), exist_ok=True); open(out, "w").write("x")
inp = os.path.join(worker.COMFY_DIR, "input", "hawkesgen", "in.png")
os.makedirs(os.path.dirname(inp), exist_ok=True); open(inp, "w").write("x")
class R:
    key = "k"; finished = False
    def __init__(self, req): pass
    def execute(self): raise RuntimeError("graph failed")
    def emit(self, ev): pass
worker.Run = R
import threading
r, _ = worker.begin_run({"key": "k"})
for th in threading.enumerate():
    if th is not threading.current_thread(): th.join(5)
print(json.dumps({"need": asked[0], "min": worker.MIN_FREE, "left": [p for p in (out, inp) if os.path.exists(p)]}))
`;
  const r = spawnSync(py, ['-c', code], { encoding: 'utf8', env: { ...process.env, COMFY_DIR: comfy } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.equal(out.need, out.min + 30e9, 'room for the 30 GB model plus the margin, not the margin alone');
  assert.deepEqual(out.left, []);
});

test('worker.py runs an open audio model for a hawkes_audio request: run.py in its venv, the takes uploaded', (t) => {
  if (process.platform === 'win32') return t.skip('the fake model venv is a shell script');
  const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
  if (!py) return t.skip('no Python here');
  const dir = path.join(ROOT, 'server', 'cloudrun');
  const audio = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-audio-root-'));
  const comfy = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-comfy-'));
  fs.mkdirSync(path.join(audio, 'qwen3-tts', 'venv', 'bin'), { recursive: true });
  // The "model": writes a take and result.json the way post/audio/run.py does, and says a step.
  const fakePy = path.join(audio, 'qwen3-tts', 'venv', 'bin', 'python');
  fs.writeFileSync(fakePy, '#!/bin/sh\nmkdir -p out\necho "HB step loading qwen3-tts"\nprintf wav > out/take0.wav\nprintf \'{"items":[{"id":"take0","seconds":1}]}\' > out/result.json\n', { mode: 0o755 });
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dir)})
import worker
worker.comfy = lambda *a, **k: {}
class Store:
    def __init__(self): self.w = {}
    def stat(self, uri): return None
    def read(self, uri): return None
    def write(self, uri, data, ct="application/octet-stream"): self.w[uri] = data
    def download(self, uri, dest, parallel=4): pass
store = Store()
worker.store_for = lambda req: store
r = worker.Run({"key": "k1", "out": "gs://b/cloudrun/runs/k1/", "graph": {"hawkes_audio": {"task": "speak", "model": "qwen3-tts", "items": [{"id": "take0", "text": "hi"}]}}})
steps = []
r.step = lambda d: steps.append(d)
final = r._execute()
missing = worker.Run({"key": "k2", "out": "gs://b/cloudrun/runs/k2/", "graph": {"hawkes_audio": {"model": "voxcpm2", "items": []}}})
try:
    missing._execute(); err = None
except Exception as e:
    err = str(e)
print(json.dumps({"final": final, "steps": steps, "written": sorted(store.w), "err": err}))
`;
  const r = spawnSync(py, ['-c', code], { encoding: 'utf8', env: { ...process.env, AUDIO_ROOT: audio, COMFY_DIR: comfy } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.equal(out.final.t, 'done');
  assert.deepEqual(out.final.files.map((f: any) => f.filename), ['result.json', 'take0.wav']);
  // The heartbeat moves while the model runs (Gen reads it after a restart); the outputs are the takes and result.json.
  assert.deepEqual(out.written.filter((u: string) => !u.endsWith('/heartbeat.json')), ['gs://b/cloudrun/runs/k1/00-result.json', 'gs://b/cloudrun/runs/k1/01-take0.wav']);
  assert.ok(out.steps.includes('loading qwen3-tts'), JSON.stringify(out.steps));
  assert.match(out.err, /no open audio model 'voxcpm2' \(it has qwen3-tts\)/);
});

test('false cold: stale lastOk + headers timeout is capacity (not a long cold pull)', async () => {
  const { resetHealth } = await import('../src/providers/gpu/health.ts');
  resetHealth();
  const fake = fakeCloud(succeed);
  fake.deps.fetch = (async () => {
    await fake.deps.sleep(300_000);
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
  }) as any;
  const h = hooks();
  const ep = svc({ name: 'runpod', provider: 'runpod', headers: () => ({}), waitForInstanceMs: 12 * 60_000, preload: new Set() });
  const err = await cloudComfyRun({ id: 'j_zombie' }, ep as any, h as any, fake.deps as any).runGraph({ '9': { class_type: 'SaveImage', inputs: {} } } as any).then(() => null, (e) => e);
  assert.equal(err?.unavailable, true);
  assert.equal(err?.capacity, true);
  assert.ok(h.steps.some((s: string) => /cold start/.test(s)), 'banner once when lastOk is stale');
  assert.ok(!h.steps.some((s: string) => /still starting/.test(s)), 'must not keep waiting as a cold pull');
});

test('warm lastOk: headers timeout retries without a cold-start banner, then capacity', async () => {
  const { markUp, resetHealth } = await import('../src/providers/gpu/health.ts');
  resetHealth();
  markUp('runpod');
  let calls = 0;
  const fake = fakeCloud(succeed);
  fake.deps.fetch = (async () => {
    calls++;
    await fake.deps.sleep(60_000);
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
  }) as any;
  const h = hooks();
  const ep = svc({ name: 'runpod', provider: 'runpod', lane: 'runpod', headers: () => ({}), waitForInstanceMs: 3 * 60_000, preload: new Set() });
  const err = await cloudComfyRun({ id: 'j_warm_to' }, ep as any, h as any, fake.deps as any).runGraph({ '9': { class_type: 'SaveImage', inputs: {} } } as any).then(() => null, (e) => e);
  assert.equal(err?.unavailable, true);
  assert.ok(calls >= 2, `retried while warm, got ${calls}`);
  assert.ok(!h.steps.some((s: string) => /cold start/.test(s)), JSON.stringify(h.steps));
  resetHealth();
});

test('false cold: assign-fail with stale lastOk cools as capacity under the pre-worker cap', async () => {
  const { resetHealth, PRE_WORKER_MS } = await import('../src/providers/gpu/health.ts');
  resetHealth();
  const fake = fakeCloud(succeed);
  fake.deps.fetch = (async () => new Response(JSON.stringify({ status: 400, title: 'Bad Request', detail: 'failed to assign worker' }), { status: 400 })) as any;
  const h = hooks();
  // Long cold wait configured, but assign-fail must not sit through it.
  const ep = svc({ name: 'runpod', provider: 'runpod', headers: () => ({}), waitForInstanceMs: 12 * 60_000, preload: new Set() });
  const started = fake.deps.now();
  const err = await cloudComfyRun({ id: 'j_assign_cold' }, ep as any, h as any, fake.deps as any).runGraph({ '9': { class_type: 'SaveImage', inputs: {} } } as any).then(() => null, (e) => e);
  assert.equal(err?.unavailable, true);
  assert.equal(err?.capacity, true);
  assert.ok(fake.deps.now() - started <= PRE_WORKER_MS + 20_000, `waited ${fake.deps.now() - started}ms, want <= pre-worker cap`);
  assert.ok(h.steps.some((s: string) => /cold start/.test(s)));
});

test('RunPod\'s "failed to assign worker" on a warm endpoint is waited out like a busy service', async () => {
  const { markUp, resetHealth } = await import('../src/providers/gpu/health.ts');
  resetHealth();
  markUp('runpod');
  let calls = 0;
  const fake = fakeCloud(succeed);
  const real = fake.deps.fetch;
  fake.deps.fetch = (async (url: string, init: any) => {
    if (++calls <= 2) return new Response(JSON.stringify({ status: 400, title: 'Bad Request', detail: 'failed to assign worker' }), { status: 400 });
    return real(url, init);
  }) as any;
  const h = hooks();
  const ep = svc({ name: 'runpod', provider: 'runpod', lane: 'runpod', headers: () => ({}), waitForInstanceMs: 3 * 60_000, preload: new Set() });
  const files = await cloudComfyRun({ id: 'j_assign' }, ep as any, h as any, fake.deps as any).runGraph({ '9': { class_type: 'SaveImage', inputs: {} } } as any);
  assert.equal(files.length, 1);
  assert.equal(calls, 3);
  assert.ok(h.steps.some((s: string) => /waiting for a free/.test(s)), JSON.stringify(h.steps));
  assert.ok(!h.steps.some((s: string) => /cold start/.test(s)), JSON.stringify(h.steps));
  resetHealth();
});

test('401/403 from a provider fails over at once (auth cool)', async () => {
  const fake = fakeCloud(succeed);
  fake.deps.fetch = (async () => new Response('nope', { status: 401 })) as any;
  const ep = svc({ name: 'runpod', provider: 'runpod', headers: () => ({}), waitForInstanceMs: 3 * 60_000, preload: new Set() });
  const err = await cloudComfyRun({ id: 'j_auth' }, ep as any, hooks() as any, fake.deps as any).runGraph({ '9': { class_type: 'SaveImage', inputs: {} } } as any).then(() => null, (e) => e);
  assert.equal(err?.unavailable, true);
  assert.equal(err?.auth, true);
});
