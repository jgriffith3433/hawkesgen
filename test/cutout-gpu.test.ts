// Remove background on the GPU (src/tools/cutout-gpu.ts): image.cutout hands BiRefNet calls to image.cutout-gpu when a
// GPU provider can take them, the GPU makes only the mask, crop/pad/glow stay in post/cutout.py --mask, and a GPU failure
// other than "this provider can't take it now" makes the cutout on the CPU instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cutout-gpu-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
process.env.HAWKESGEN_PUBLIC_URL = 'https://gen.example.test';
delete process.env.K_SERVICE;

const { reloadTools, getTool } = await import('../src/tools/index.ts');
const { cutoutStaysLocal, cutoutGpuTool, CUTOUT_GPU } = await import('../src/tools/cutout-gpu.ts');
const { loadServiceMap } = await import('../src/providers/cloudrun/services.ts');
const { markDown, resetHealth } = await import('../src/providers/gpu/health.ts');
const { SETTINGS_DEFAULTS, ROOT } = await import('../src/config.ts');

reloadTools();
const map = loadServiceMap();
const KEYS: Record<string, string> = { RUNPOD_API_KEY: 'rp-key' };
const get = (k: string) => KEYS[k];
const ep = (over: any = {}) => ({ id: 'runpod', provider: 'runpod', url: 'https://abc.api.runpod.ai', families: ['*'], gpu: 'L40S', pricePerHour: 1.75, maxConcurrent: 2, graphLimitSeconds: 300, enabled: true, ...over });
const settings = (gpu: any = {}) => ({
  ...SETTINGS_DEFAULTS,
  gpu: { backend: 'fleet', families: {}, providers: [], order: [], familyOrder: {}, ...gpu, cloudrun: { bucket: 'bkt', urls: {}, services: {}, ...(gpu.cloudrun ?? {}) } },
  fleet: { ...SETTINGS_DEFAULTS.fleet },
}) as any;
const withRunpod = settings({ providers: [ep()], order: ['runpod', 'fleet'] });

test('image.cutout goes to the GPU when a provider can take it, else stays on the CPU', () => {
  resetHealth();
  assert.equal(cutoutStaysLocal({ mode: 'birefnet' }, { settings: withRunpod, map, get }), null);
  assert.equal(cutoutStaysLocal({}, { settings: withRunpod, map, get }), null, 'birefnet is the default mode');
  assert.match(cutoutStaysLocal({ mode: 'isnet' }, { settings: withRunpod, map, get })!, /isnet runs on the CPU/);
  assert.match(cutoutStaysLocal({ mode: 'union' }, { settings: withRunpod, map, get })!, /union runs on the CPU/);
  // No GPU set up, only the fleet (a cutout would wait for a server to start), or the provider's key missing.
  assert.match(cutoutStaysLocal({ mode: 'birefnet' }, { settings: settings(), map, get })!, /no GPU provider/);
  assert.match(cutoutStaysLocal({ mode: 'birefnet' }, { settings: settings({ order: ['fleet'] }), map, get })!, /no GPU provider/);
  assert.match(cutoutStaysLocal({ mode: 'birefnet' }, { settings: withRunpod, map, get: () => undefined })!, /no GPU provider/);
  // Cooling down after refusing a job: back to the CPU until it's up again.
  markDown('runpod', 'no GPU free', 60_000);
  assert.match(cutoutStaysLocal({ mode: 'birefnet' }, { settings: withRunpod, map, get })!, /runpod/);
  resetHealth();
  assert.equal(cutoutStaysLocal({ mode: 'birefnet' }, { settings: withRunpod, map, get: (k) => (k === 'HAWKESGEN_CUTOUT_GPU' ? '0' : get(k)) }), 'HAWKESGEN_CUTOUT_GPU=0');
});

test('the GPU tool takes image.cutout\'s params and runs as a BiRefNet GPU job', () => {
  const cpu = getTool('image.cutout')!;
  const gpu = getTool(CUTOUT_GPU)!;
  assert.equal(typeof cpu.route, 'function');
  assert.equal(gpu.provider, 'comfy');
  assert.equal(gpu.family, 'birefnet');
  assert.deepEqual(Object.keys(gpu.params), Object.keys(cpu.params));
  assert.deepEqual(gpu.models!({}), ['birefnet.safetensors']);
});

function fakeCtx(runGraph: (g: any) => Promise<any[]>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cutout-run-'));
  const src = path.join(dir, 'in.png');
  fs.writeFileSync(src, 'png');
  const calls: { graph?: any; python?: string[]; logs: string[]; steps: string[]; emitted?: any; result?: any } = { logs: [], steps: [] };
  const ctx: any = {
    job: { id: 'j1', client: 'c', project: 'p1', tool: CUTOUT_GPU, labels: {} },
    params: { mode: 'birefnet', glow: false, crop: true, pad: 16 },
    inputs: { image: src },
    done: 0, outputs: [], signal: new AbortController().signal,
    step: (d: string) => calls.steps.push(d), log: (l: string) => calls.logs.push(l),
    tmp: (n: string) => path.join(dir, n),
    emit: async (o: any) => { calls.emitted = o; }, result: (v: any) => { calls.result = v; },
    seed: () => 0, usage: () => {},
    python: async (script: string, args: string[]) => {
      assert.equal(script, 'cutout.py');
      calls.python = args;
      fs.writeFileSync(args[1], 'cut');
      return JSON.stringify({ box: [0, 0, 1, 1], size: [1, 1], model: 'birefnet' });
    },
    comfy: {
      server: { id: 'runpod:runpod', region: 'x', price: 1.75 },
      upload: async () => 'hawkesgen/abc.png', uploadBuffer: async () => 'x',
      ensureModels: async () => {}, timed: async (w: any) => w(),
      runGraph: async (g: any) => { calls.graph = g; return runGraph(g); },
      download: async () => Buffer.from('mask'),
    },
  };
  return { ctx, calls };
}

test('the GPU makes only the mask; crop, pad and glow run here on it', async () => {
  const { ctx, calls } = fakeCtx(async () => [{ filename: 'm.png', subfolder: '', type: 'output', node: '20' }]);
  await cutoutGpuTool.run(ctx);
  const saves = Object.entries(calls.graph).filter(([, n]: any) => n.class_type === 'SaveImage').map(([id]) => id);
  assert.deepEqual(saves, ['20'], 'one save: the mask');
  assert.equal(calls.graph['17'].inputs.image, 'hawkesgen/abc.png');
  assert.equal(calls.graph['20'].inputs.filename_prefix, 'hawkesgen/p1/image.cutout-gpu-j1', 'a name of the job\'s own (a warm ComfyUI caches identical graphs)');
  assert.ok(!calls.graph.cut && !calls.graph.inv);
  assert.deepEqual(calls.python!.slice(2), ['--mode', 'birefnet', '--pad', '16', '--mask', ctx.tmp('mask.png')]);
  assert.equal(fs.readFileSync(ctx.tmp('mask.png'), 'utf8'), 'mask');
  assert.equal(calls.result.gpu, true);
  assert.ok(calls.logs.some((l) => /on the GPU \(runpod:runpod\)/.test(l)));
});

test('a GPU failure makes the cutout on the CPU; "can\'t take it now" moves the job to the next provider', async () => {
  const broken = fakeCtx(async () => { throw new Error('ComfyUI rejected the workflow: no RemoveBackground node'); });
  await cutoutGpuTool.run(broken.ctx);
  assert.ok(!broken.calls.python!.includes('--mask'), 'the model runs here');
  assert.ok(broken.calls.logs.some((l) => /cutting out here on the CPU/.test(l)));
  assert.ok(broken.calls.emitted);
  const busy = fakeCtx(async () => { throw Object.assign(new Error('runpod: no GPU free'), { unavailable: true }); });
  await assert.rejects(cutoutGpuTool.run(busy.ctx), /no GPU free/);
  assert.equal(busy.calls.python, undefined);
});

test('cutout.py --mask cuts out with a given mask: alpha from it, cropped with the pad', { skip: spawnSync('python3', ['-c', 'import PIL']).status !== 0 && 'no Pillow here' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cutout-mask-'));
  const make = `
from PIL import Image, ImageDraw
img = Image.new("RGB", (100, 80), (200, 50, 50)); img.save("${dir}/in.png")
m = Image.new("L", (100, 80), 0); ImageDraw.Draw(m).rectangle([30, 20, 59, 49], fill=255); m.save("${dir}/mask.png")
rgba = Image.new("RGBA", (100, 80), (0, 0, 0, 0)); rgba.putalpha(m); rgba.save("${dir}/cut.png")
`;
  assert.equal(spawnSync('python3', ['-c', make]).status, 0);
  for (const mask of ['mask.png', 'cut.png']) {
    const r = spawnSync('python3', [path.join(ROOT, 'post', 'cutout.py'), `${dir}/in.png`, `${dir}/out.png`, '--pad', '4', '--mask', `${dir}/${mask}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const info = JSON.parse(r.stdout.trim().split('\n').pop()!);
    assert.equal(info.model, 'birefnet');
    // The MaxFilter(5) in cutout.py grows the box by 2 px each way, then the pad.
    assert.deepEqual(info.box, [24, 14, 66, 56], mask);
    assert.deepEqual(info.size, [42, 42]);
    const px = spawnSync('python3', ['-c', `from PIL import Image; i = Image.open("${dir}/out.png"); print(i.mode, i.getpixel((21, 21))[3], i.getpixel((1, 1))[3])`], { encoding: 'utf8' }).stdout.trim();
    assert.equal(px, 'RGBA 255 0');
  }
});

test('worker.py reports the GPU memory a graph held at its peak', { skip: spawnSync('python3', ['--version']).status !== 0 && 'no Python here' }, () => {
  const code = `
import json, sys, time
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'server', 'cloudrun'))})
import worker
free = [48 * 2**30]
def comfy(route, body=None, timeout=60):
    assert route == "/system_stats"
    return {"devices": [{"name": "cuda:0 NVIDIA L40S", "vram_total": 48 * 2**30, "vram_free": free[0]}]}
worker.comfy = comfy
class Run: pass
run = Run()
def graph(g, extra, r):
    free[0] = 44 * 2**30
    time.sleep(0.5)
    free[0] = 46 * 2**30
    return ["file"]
worker._run_graph = graph
assert worker.run_graph({}, None, run) == ["file"]
print(json.dumps(run.vram))
`;
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()!), { peakMB: 4096, totalMB: 49152, gpu: 'cuda:0 NVIDIA L40S' });
});
