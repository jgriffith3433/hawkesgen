// 3D animation (docs/3d-animation.md): the 3D tools' workspace on a GPU worker (one hawkes_job request per script, files
// by upload, folders back, HB lines replayed), routing to endpoints that name the 3D families (never "*" or Cloud Run),
// readiness, the installers' image mode and weights steps, the 3D image's build folder, motion.from-video's plan and
// script, the motion check on real BVH text, worker.py running a hawkes_job, the character3d mocap/* recipes, the
// animation intent, and the MCP tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-anim3d-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
process.env.HAWKESGEN_PUBLIC_URL = 'https://gen.example.test';
delete process.env.K_SERVICE;

const { workerWorkspace, weightsPrelude, JOB_ROOT } = await import('../src/providers/workspace.ts');
const { gpuCandidates, toolReady } = await import('../src/providers/gpu/route.ts');
const { loadServiceMap } = await import('../src/providers/cloudrun/services.ts');
const { getTool } = await import('../src/tools/index.ts');
const { SETTINGS_DEFAULTS, ROOT } = await import('../src/config.ts');
const rigInstall = await import('../src/providers/rig/install.ts');
const motionInstall = await import('../src/providers/motion/install.ts');
const mocapInstall = await import('../src/providers/mocap/install.ts');
const { planMocap, mocapJobScript } = await import('../src/tools/mocap.ts');
const { motionJobScript, bestTake, readChecks } = await import('../src/tools/motion.ts');
const { rigJobScript } = await import('../src/tools/rig.ts');
const { makeSpecFor } = await import('../src/entities.ts');
const { routing } = await import('../src/make/routing.ts');
const { MAKE_INTENTS } = await import('../src/make/tool.ts');
const { makeTools } = await import('../src/mcp-make.ts');
const { contextFiles3d } = await import('../tools/gpu-providers/image-context-3d.mjs');

const map = loadServiceMap();
const get = (k: string) => ({ RUNPOD_API_KEY: 'rp', GPU_HTTP_TOKEN: 'h' } as Record<string, string>)[k];
const ep = (over: any = {}) => ({ id: 'runpod-a', provider: 'runpod', url: 'https://abc.api.runpod.ai', families: ['*'], gpu: 'L40S', pricePerHour: 1.75, maxConcurrent: 2, graphLimitSeconds: 300, enabled: true, ...over });
const gpuSettings = (gpu: any = {}) => ({ gpu: { backend: 'fleet', families: {}, providers: [], order: [], familyOrder: {}, ...gpu, cloudrun: { bucket: 'bkt', urls: {}, services: {}, ...(gpu.cloudrun ?? {}) } }, fleet: { ...SETTINGS_DEFAULTS.fleet } }) as any;
const py = ['python3', 'python', 'py'].find((p) => spawnSync(p, ['--version']).status === 0 && !/Microsoft Store/.test(String(spawnSync(p, ['--version']).stderr)));

// ------------------------------------------------------------------ the workspace on a worker

/** A worker that runs nothing: it records the request and answers with the files it was told to "make". */
function fakeWorker(made: Record<string, string>, fail?: string) {
  const uploads: string[] = [];
  const requests: any[] = [];
  const c: any = {
    server: { id: 'cloudrun:runpod-3d', region: 'gcp', price: 1 },
    async upload(file: string) { uploads.push(file); return `hawkesgen/${path.basename(file).replace(/[^\w.]/g, '_')}`; },
    async uploadBuffer() { return 'x'; },
    async runGraph(graph: any) {
      requests.push(graph);
      if (fail) throw new Error(fail);
      return [...Object.keys(made).map((f) => ({ filename: f, subfolder: '', type: 'output', uri: `gs://b/${f}` })), { filename: '_hb.txt', subfolder: '', type: 'output', uri: 'gs://b/_hb.txt' }];
    },
    async download(f: any) { return Buffer.from(f.filename === '_hb.txt' ? 'HB step one\nHB warning careful\nHB frame 1 2' : made[f.filename]); },
    async ensureModels() {},
    timed: (w: any) => w(),
  };
  return { c, uploads, requests };
}

test('a 3D job on a worker is one hawkes_job request: files by upload (once), texts inline, the collected folder back, HB lines replayed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-ws-'));
  const mesh = path.join(dir, 'hero.glb');
  fs.writeFileSync(mesh, 'glb');
  const { c, uploads, requests } = fakeWorker({ 'res/rigged.glb': 'RIG', 'res/rig.json': '{"bones":[]}' });
  const ws = workerWorkspace(c, 'j_abc', path.join(dir, 'stage'));
  assert.equal(ws.dir, `${JOB_ROOT}/j_abc`);
  assert.equal(ws.persistent, false);
  assert.equal(ws.where, 'runpod-3d');
  await ws.put({ 'in/mesh.glb': mesh });
  await ws.write({ 'prep.json': '{"a":1}' });
  const lines: string[] = [];
  await ws.run('echo hi', { onLine: (l) => lines.push(l) });
  const job = requests[0].hawkes_job;
  assert.deepEqual(Object.keys(job).sort(), ['collect', 'dir', 'files', 'script', 'texts']);
  assert.equal(job.dir, '/var/tmp/hawkes-blender/j_abc');
  assert.deepEqual(job.files, { 'in/mesh.glb': 'hawkesgen/hero.glb' });
  assert.deepEqual(job.texts, { 'prep.json': '{"a":1}' });
  assert.deepEqual(job.collect, ['res']);
  assert.deepEqual(lines, ['step one', 'warning careful', 'frame 1 2']);
  const out = path.join(dir, 'out');
  const got = await ws.get('res', out);
  assert.deepEqual(got.map((f) => path.basename(f)).sort(), ['rig.json', 'rigged.glb']);
  assert.equal(fs.readFileSync(path.join(out, 'rigged.glb'), 'utf8'), 'RIG');
  // A second run (blender.character's robot labelling) sends every file again by its uploaded name, uploading nothing twice.
  await ws.write({ 'spec.json': '{}' });
  await ws.run('echo again', {});
  assert.equal(uploads.length, 1);
  assert.deepEqual(Object.keys(requests[1].hawkes_job.texts).sort(), ['prep.json', 'spec.json']);
  await assert.rejects(ws.get('out', path.join(dir, 'o2')), /not collected/);
  await assert.rejects(ws.put({ '../evil': mesh }), /Bad file name/);
  await ws.clean();
});

test('a provider running the ComfyUI image refuses a hawkes_job: the job is told to move on (unavailable)', async () => {
  const { c } = fakeWorker({}, 'runpod: Cannot execute because node hawkes_job does not exist (missing_node_type)');
  const ws = workerWorkspace(c, 'j_x');
  await assert.rejects(ws.run('true', {}), (e: any) => e.unavailable === true && /3D worker image/.test(e.message));
  await ws.clean();
});

test('weightsPrelude only acts on a worker (HAWKES_WEIGHTS set), and every weights step takes the lock and links', () => {
  assert.equal(weightsPrelude([]), '');
  const p = weightsPrelude([rigInstall.weightsScript()]);
  assert.match(p, /^if \[ -n "\$\{HAWKES_WEIGHTS:-\}" \]; then/);
  assert.match(p, /export HAWKES_HF_HOME="\$HAWKES_WEIGHTS\/hf"/);
  for (const s of [rigInstall.weightsScript(), motionInstall.weightsScript(), mocapInstall.weightsScript()]) {
    assert.match(s, /flock 9/);
    assert.match(s, /\.lock"/);
  }
  assert.match(rigInstall.weightsScript(), /ln -sfn "\$HAWKES_WEIGHTS\/rig\/mia\/output" "\/opt\/hawkes-rig\/mia\/src\/output"/);
  assert.match(motionInstall.hyWeightsScript(), /hymotion\/ckpts\/tencent/);
  // The job scripts start with it and read the worker's Hugging Face cache when there is one.
  const rig = rigJobScript({ kind: 'auto', keepTextures: true, fps: 30, frames: 31 });
  assert.match(rig, /HAWKES_WEIGHTS/);
  assert.match(rig, /export HF_HOME="\$\{HAWKES_HF_HOME:-\/opt\/hawkes-rig\/hf\}"/);
  assert.match(motionJobScript({ character: true }), /check\.py/);
  for (const s of [rig, motionJobScript({ character: false })]) assert.equal(spawnSync('bash', ['-n'], { input: s }).status ?? 0, 0, 'bash parses it');
});

// ------------------------------------------------------------------ routing and readiness

test('3D tools go to the fleet or an endpoint that names their family, never a "*" (ComfyUI) endpoint or Cloud Run', () => {
  const rig = getTool('mesh.rig')!;
  const job = { family: 'rig', params: {}, labels: {} };
  const s = gpuSettings({
    providers: [ep(), ep({ id: 'runpod-3d', families: ['rig', 'motion', 'mocap', 'blender'], graphLimitSeconds: 1800 })],
    order: ['cloudrun', 'runpod-a', 'runpod-3d', 'fleet'],
  });
  const r = gpuCandidates(job, rig, s, map, Date.now(), get);
  // (The fleet follows only where AWS credentials exist; this test has none, so it is skipped with a reason.)
  assert.deepEqual(r.choices.map((c: any) => (c.kind === 'fleet' ? 'fleet' : c.service.lane)).filter((x: string) => x !== 'fleet'), ['runpod-3d']);
  assert.ok(r.skipped.some((x: string) => /runpod-a: runs the ComfyUI image/.test(x)), JSON.stringify(r.skipped));
  assert.ok(r.skipped.some((x: string) => /cloudrun: the tool needs the 3D worker image/.test(x)), JSON.stringify(r.skipped));
  // A ComfyUI tool never lands on the 3D endpoint.
  const zi = gpuCandidates({ family: 'z-image', params: {}, labels: {} }, { provider: 'comfy', gpuSeconds: () => 30 } as any, s, map, Date.now(), get);
  assert.ok(!zi.choices.some((c: any) => c.kind === 'service' && c.service.lane === 'runpod-3d'));
  // familyOrder sends the 3D families there with no default order at all.
  const fo = gpuSettings({ providers: [ep({ id: 'runpod-3d', families: ['rig'], graphLimitSeconds: 1800 })], familyOrder: { rig: ['runpod-3d', 'fleet'] } });
  assert.equal(gpuCandidates(job, rig, fo, map, Date.now(), get).choices.map((c: any) => (c.kind === 'fleet' ? 'fleet' : c.service.lane))[0], 'runpod-3d');
});

test('an endpoint can allow a longer first start (the 3D image is big): coldStartSeconds reaches the run as coldStartMs', async () => {
  const { cleanProviders } = await import('../src/config.ts');
  const { endpointService } = await import('../src/providers/gpu/route.ts');
  const g = cleanProviders({ providers: [ep({ id: 'runpod-3d', families: ['rig'], coldStartSeconds: 1800 }), ep({ id: 'runpod-b', coldStartSeconds: 99999 }), ep({ id: 'runpod-c' })] } as any);
  assert.equal(g.providers[0].coldStartSeconds, 1800);
  assert.equal(g.providers[1].coldStartSeconds, 7200, 'capped at two hours');
  assert.equal(g.providers[2].coldStartSeconds, undefined, 'unset stays unset (the 12-minute default)');
  assert.equal(endpointService(g.providers[0], 'rig', map!, 'bkt', get).coldStartMs, 1_800_000);
  assert.equal(endpointService(g.providers[2], 'rig', map!, 'bkt', get).coldStartMs, undefined);
});

test('readiness: a 3D tool is ready with the fleet up or an enabled endpoint naming its family; SSH tools need the fleet', () => {
  const rig = getTool('mesh.rig')!;
  const none = gpuSettings();
  assert.equal(toolReady(rig, { fleetDown: true, settings: none }), false);
  assert.equal(toolReady(rig, { fleetDown: false, settings: none }), true);
  assert.equal(toolReady(rig, { fleetDown: true, settings: gpuSettings({ providers: [ep({ families: ['*'] })] }) }), false, '"*" is the ComfyUI image');
  assert.equal(toolReady(rig, { fleetDown: true, settings: gpuSettings({ providers: [ep({ families: ['rig'] })] }) }), true);
  assert.equal(toolReady(rig, { fleetDown: true, settings: gpuSettings({ providers: [ep({ families: ['rig'], enabled: false })] }) }), false);
  assert.equal(toolReady(getTool('lora.train'), { fleetDown: true, settings: gpuSettings({ providers: [ep({ families: ['*'] })] }) }), false);
  assert.equal(toolReady(getTool('image.generate'), { fleetDown: true, settings: none }), true);
  for (const id of ['blender.render', 'blender.character', 'mesh.rig', 'motion.from-text', 'motion.from-video']) assert.equal(getTool(id)?.image, '3d', id);
  assert.deepEqual(['blender', 'blender', 'rig', 'motion', 'mocap'], ['blender.render', 'blender.character', 'mesh.rig', 'motion.from-text', 'motion.from-video'].map((id) => getTool(id)?.family));
});

// ------------------------------------------------------------------ the image

test('the 3D image installs code and venvs only (no weights, no disk check), from the same scripts as the fleet', () => {
  for (const mod of [rigInstall, motionInstall, mocapInstall]) {
    const img = mod.installScript('', { weights: false });
    const fleet = mod.installScript();
    assert.doesNotMatch(img, /snapshot_download|hf_hub_download|download\.py --model/, 'no weights in the image');
    assert.match(img, /false && if \[ "\$AVAIL"/, 'the free-disk check is off in the image');
    assert.doesNotMatch(img, /sudo /);
    assert.match(fleet, /snapshot_download|hf_hub_download/, 'the fleet install still fetches weights');
    assert.equal(spawnSync('bash', ['-n'], { input: img }).status ?? 0, 0);
  }
  const { files, hash } = contextFiles3d();
  assert.deepEqual(Object.keys(files).sort(), ['Dockerfile', 'entrypoint.sh', 'install-blender.sh', 'install-mocap.sh', 'install-motion.sh', 'install-rig.sh', 'worker.py']);
  assert.match(files.Dockerfile.toString(), /HAWKES_COMFY=0/);
  assert.match(String(files['install-mocap.sh']), new RegExp(mocapInstall.GEMX_COMMIT));
  assert.match(hash, /^[0-9a-f]{10}$/);
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'gpu3d-image.yml'), 'utf8');
  assert.match(wf, /gpu3d-image-\*/);
  assert.match(wf, /image-3d-cloudbuild\.mjs/, 'built on Cloud Build: a runner disk is too small');
  assert.match(wf, /crane copy/);
  assert.match(wf, /hawkes-gen-gpu/, 'into the public package');
});

// ------------------------------------------------------------------ motion.from-video

test('motion.from-video: the plan checks its params; the script runs GEM-X, the self-checking SOMA BVH, the check, then the retarget', () => {
  assert.deepEqual(planMocap({}), { start: 0, seconds: 0, camera: 'background', loop: false, inPlace: false, name: 'mocap' });
  assert.equal(planMocap({ camera: 'still' }).camera, 'static');
  assert.equal(planMocap({ name: 'Spin Kick!' }).name, 'SpinKick');
  assert.throws(() => planMocap({ seconds: 61 }), /up to 60/);
  assert.throws(() => planMocap({ start: -1 }), /seconds into the video/);
  assert.throws(() => planMocap({ camera: 'drone' }), /auto, still or moving/);
  const s = mocapJobScript({ ext: '.mp4', plan: planMocap({ start: 1.5, seconds: 4, camera: 'still' }), character: true });
  assert.match(s, /gemx_run\.py --video in\/clip\.mp4 .*--camera static --start 1\.5 --seconds 4/);
  assert.match(s, /soma_to_bvh\.py out\/mocap\/soma\.npz out\/bvhs\/take-0\.bvh/);
  assert.match(s, /check\.py/);
  assert.match(s, /hawkes_character\.py -- spec\.json/);
  assert.match(s, /MW="\$\{HAWKES_WEIGHTS:\+\$HAWKES_WEIGHTS\/mocap\}"; MW="\$\{MW:-\/opt\/hawkes-mocap\/weights\}"/);
  assert.doesNotMatch(mocapJobScript({ ext: '.mp4', plan: planMocap({}), character: false }), /hawkes_character/);
  assert.equal(spawnSync('bash', ['-n'], { input: s }).status ?? 0, 0);
  const t = getTool('motion.from-video')!;
  assert.equal(t.inputs.video.required, true);
  assert.ok(t.inputs.character);
  // Only commercially usable models are installed; GVHMR and SMPL are listed as not installed.
  const by = Object.fromEntries(mocapInstall.MOCAP_LICENSES.map((x) => [x.id, x]));
  assert.equal(by['gem-x'].commercial, true);
  assert.equal(by.gvhmr.commercial, false);
  assert.doesNotMatch(mocapInstall.installScript(), /GVHMR|smplx|SMPL_NEUTRAL/i);
});

// ------------------------------------------------------------------ the motion check

const BVH = (frames: number, f: (i: number) => number[]) => `HIERARCHY
ROOT Hips
{
 OFFSET 0 0 0
 CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation
 JOINT LeftUpLeg
 {
  OFFSET 10 0 0
  CHANNELS 3 Zrotation Yrotation Xrotation
  JOINT LeftLeg
  {
   OFFSET 0 -45 0
   CHANNELS 3 Zrotation Yrotation Xrotation
   JOINT LeftFoot
   {
    OFFSET 0 -45 0
    CHANNELS 3 Zrotation Yrotation Xrotation
    End Site
    {
     OFFSET 0 0 10
    }
   }
  }
 }
}
MOTION
Frames: ${frames}
Frame Time: ${1 / 30}
${Array.from({ length: frames }, (_, i) => f(i).join(' ')).join('\n')}
`;

test('the motion check: a still pose passes; a sliding foot, a pop and travel are named with what to try', (t) => {
  if (!py) return t.skip('no Python here');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-check-'));
  const run = (name: string, text: string, ...flags: string[]) => {
    fs.writeFileSync(path.join(dir, name), text);
    const r = spawnSync(py, [path.join(ROOT, 'post', 'motion', 'check.py'), path.join(dir, name), ...flags], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
  };
  const still = run('still.bvh', BVH(30, () => [0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), '--loop', '--in-place');
  assert.equal(still.ok, true, JSON.stringify(still));
  assert.equal(still.metrics.unitMeters, 0.01, 'centimeters detected from the hips height');
  const bad = run('bad.bvh', BVH(40, (i) => [i * 3, 90 + (i === 20 ? 80 : 0), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), '--in-place');
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p: string) => /slide/.test(p)), JSON.stringify(bad.problems));
  assert.ok(bad.problems.some((p: string) => /jumps/.test(p)));
  assert.ok(bad.problems.some((p: string) => /stay in place/.test(p)));
  assert.match(bad.fix, /inPlace/);
  // The tools read res/check-N.json and name the best take.
  fs.writeFileSync(path.join(dir, 'check-0.json'), JSON.stringify(bad));
  fs.writeFileSync(path.join(dir, 'check-1.json'), JSON.stringify(still));
  const checks = readChecks(dir, 3);
  assert.equal(checks[2], null);
  assert.equal(bestTake(checks), 1);
});

// ------------------------------------------------------------------ worker.py

test('worker.py runs a hawkes_job: inputs and texts into the job folder, the script, the collected files and its HB lines back', (t) => {
  if (process.platform === 'win32') return t.skip('the job folder is /var/tmp (Linux)');
  if (!py) return t.skip('no Python here');
  const dir = path.join(ROOT, 'server', 'cloudrun');
  const io = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-io-'));
  fs.mkdirSync(path.join(io, 'input', 'hawkesgen'), { recursive: true });
  fs.writeFileSync(path.join(io, 'input', 'hawkesgen', 'mesh.glb'), 'GLB');
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dir)})
import worker
class Store:
    def __init__(self): self.w = {}
    def stat(self, uri): return None
    def read(self, uri): return None
    def write(self, uri, data, ct="application/octet-stream"): self.w[uri] = data
    def download(self, uri, dest, parallel=4): pass
store = Store()
worker.store_for = lambda req: store
script = "set -e\\necho 'HB step rigging'\\nmkdir -p res\\ncp in/mesh.glb res/rigged.glb\\ncat spec.json > res/spec.json\\necho \\"$HF_TOKEN\\" > res/token.txt\\n"
r = worker.Run({"key": "k1", "out": "gs://b/runs/k1/", "extra": {"hf_token": "hf_x"}, "files": {"hawkesgen/mesh.glb": "gs://b/in/mesh.glb"},
  "graph": {"hawkes_job": {"dir": "/var/tmp/hawkes-blender/j_test1", "script": script, "files": {"in/mesh.glb": "hawkesgen/mesh.glb"}, "texts": {"spec.json": "{\\"a\\": 1}"}, "collect": ["res"]}}})
steps = []
r.step = lambda d: steps.append(d)
final = r._execute()
bad = worker.Run({"key": "k2", "out": "gs://b/runs/k2/", "graph": {"hawkes_job": {"dir": "/etc", "script": "true"}}})
try:
    bad._execute(); err = None
except Exception as e:
    err = str(e)
print(json.dumps({"final": final, "steps": steps, "written": {k: v.decode() for k, v in store.w.items()}, "err": err}))
`;
  const r = spawnSync(py, ['-c', code], { encoding: 'utf8', env: { ...process.env, COMFY_DIR: io, HAWKES_COMFY: '0', HAWKES_WEIGHTS: path.join(io, 'w') } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.equal(out.final.t, 'done');
  assert.deepEqual(out.final.files.map((f: any) => f.filename).sort(), ['_hb.txt', 'res/rigged.glb', 'res/spec.json', 'res/token.txt']);
  const w = out.written;
  assert.equal(Object.entries(w).find(([k]) => k.endsWith('res_rigged.glb'))?.[1], 'GLB');
  assert.equal((Object.entries(w).find(([k]) => k.endsWith('res_token.txt'))?.[1] as string).trim(), 'hf_x', 'the token reaches the script');
  assert.match(Object.entries(w).find(([k]) => k.endsWith('_hb.txt'))?.[1] as string, /HB step rigging/);
  assert.ok(out.steps.includes('rigging'));
  assert.match(out.err, /bad job folder/);
  assert.equal(fs.existsSync('/var/tmp/hawkes-blender/j_test1'), false, 'the job folder is removed');
});

// ------------------------------------------------------------------ recipes, the making loop, MCP

test('character3d mocap/*: a source video uses motion.from-video; none films the character itself first', () => {
  const e = (slots: any) => ({ id: 'phorigins/pierce', project: 'phorigins', kind: 'character3d', name: 'Pierce', data: { slots } }) as any;
  const withVideo = makeSpecFor(e({ 'mocap/spin': { source: 'asset:abc' } }), 'mocap/spin')!;
  assert.equal(withVideo.tool, 'motion.from-video');
  const self = makeSpecFor(e({ 'mocap/spin': { prompt: 'he spins on one foot' } }), 'mocap/spin')!;
  assert.deepEqual(self.steps!.map((s: any) => s.tool), ['blender.render', 'video.i2v', 'motion.from-video']);
  assert.deepEqual(self.saves, { 'clip.glb': 'mocap/{part}', 'clip.preview': 'preview/{part}' });
  // A robot still gets its own rig recipe (the source rule is only for slots that have makeWithoutSource).
  assert.equal(makeSpecFor({ ...e({}), data: { form: 'robot' } }, 'rig')!.tool, 'blender.character');
});

test('make.checked: the animation intent routes to motion.from-video with a video, else motion.from-text, judged as a video', () => {
  assert.ok(MAKE_INTENTS.includes('animation' as any));
  const r = routing();
  assert.deepEqual(r.intents.animation[0].tools, ['motion.from-video', 'motion.from-text']);
  assert.equal(r.tools['motion.from-text'].kind, 'video');
  assert.equal(r.tools['motion.from-text'].prompt, 'prompt');
  assert.equal(r.tools['motion.from-video'].prompt, null);
});

test('the MCP tools for animation: rig, move from words, from video (or the character filmed), stock, add, export, check', async () => {
  const submitted: any[] = [];
  const gen = {
    submit: async (tool: string, o: any) => { submitted.push({ tool, ...o }); return { id: `j${submitted.length}`, tool }; },
    request: async (p: string) => (p.startsWith('/assets?') ? { items: [{ id: 'motion:ual1/Walk_Loop', title: 'Walk_Loop', tags: ['locomotion'] }], total: 1 } : {}),
  };
  const tools = makeTools({ gen, account: 'u_test', finish: async (job) => job, remote: false });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ['rig_character', 'animate_character', 'animate_from_video', 'stock_animations', 'add_animations', 'export_character', 'check_animation']) assert.ok(by[n], n);
  await by.rig_character.run({ model: 'asset:m', humanoid: true, height: 1.7 });
  assert.deepEqual([submitted[0].tool, submitted[0].params], ['mesh.rig', { kind: 'humanoid', height: 1.7 }]);
  await by.animate_character.run({ model: 'asset:m', motion: 'a punch', in_place: true, takes: 3 });
  assert.deepEqual(submitted[1].params, { prompt: 'a punch', inPlace: true, takes: 3 });
  await by.animate_from_video.run({ model: 'asset:m', video: 'asset:v', still_camera: true });
  assert.equal(submitted[2].tool, 'motion.from-video');
  assert.deepEqual(submitted[2].inputs, { video: 'asset:v', character: 'asset:m' });
  await by.animate_from_video.run({ model: 'asset:m', motion: 'she spins and kicks' });
  assert.equal(submitted[3].tool, 'asset.make');
  assert.deepEqual(submitted[3].params.steps.map((s: any) => s.tool), ['blender.render', 'video.i2v', 'motion.from-video']);
  await assert.rejects(by.animate_from_video.run({ model: 'asset:m' }), /Give video/);
  const stock: any = await by.stock_animations.run({ search: "walk" });
  assert.equal(stock.clips[0].id, 'motion:ual1/Walk_Loop');
  await by.add_animations.run({ model: 'asset:m', clips: ['motion:ual1/Walk_Loop'], in_place: true });
  const ops = submitted[4].params.ops;
  assert.deepEqual(ops.map((o: any) => o.op), ['import', 'retarget', 'inplace', 'export', 'export']);
  assert.deepEqual(submitted[4].inputs.files, ['asset:m', 'motion:ual1/Walk_Loop']);
  await by.export_character.run({ model: 'asset:m', engine: 'unity' });
  assert.deepEqual(submitted[5].params.ops.filter((o: any) => o.op === 'export').map((o: any) => o.format), ['fbx']);
  await by.check_animation.run({ clip: 'asset:b', loop: true });
  assert.deepEqual([submitted[6].tool, submitted[6].params], ['motion.check', { loop: true }]);
});
