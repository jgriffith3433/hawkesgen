// image.repaint and image.expand: the geometry (crop boxes, padding, model sizes) and, with Pillow, the whole tool run
// against a fake ComfyUI that returns a flat color as "the model's picture": the graphs are built and checked, and the
// composite keeps every pixel outside the mask. No GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-edit-'));
const { getTool } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const { repaintCrop, modelSize, expandPlan, parseAspect } = await import('../src/tools/edit.ts');

const python = [path.join('.venv', 'Scripts', 'python.exe'), path.join('.venv', 'bin', 'python'), 'python3', 'python']
  .find((p) => (p.includes(path.sep) ? fs.existsSync(p) : spawnSync(p, ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0));
const pillow = !!python && spawnSync(python, ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;
const py = (code: string) => {
  const r = spawnSync(python!, ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test('modelSize: about a megapixel, the same shape, sides multiples of 16', () => {
  const a = modelSize(512, 512);
  assert.deepEqual(a, { width: 1024, height: 1024 });
  const b = modelSize(1920, 1080);
  assert.equal(b.width % 16, 0);
  assert.equal(b.height % 16, 0);
  assert.ok(Math.abs(b.width / b.height - 16 / 9) < 0.03);
  assert.ok(b.width * b.height < 1.1e6 && b.width * b.height > 0.9e6);
  const tall = modelSize(100, 4000);
  assert.ok(tall.height <= 2048);
});

test('repaintCrop: the mask box plus a margin, at least 512 a side, inside the picture, never past 2:1', () => {
  // A small mark in the middle of a big picture: 512x512 around it.
  const c = repaintCrop(2000, 1500, [1000, 700, 1040, 740]);
  assert.equal(c[2] - c[0], 512);
  assert.equal(c[3] - c[1], 512);
  assert.ok(c[0] <= 1000 && c[2] >= 1040 && c[1] <= 700 && c[3] >= 740, 'contains the mask');
  // Near a corner: shifted inside, not cut.
  const k = repaintCrop(2000, 1500, [0, 0, 30, 30]);
  assert.deepEqual(k, [0, 0, 512, 512]);
  // A long thin mask: margins, and at most 2:1.
  const l = repaintCrop(3000, 2000, [100, 900, 2500, 950]);
  const w = l[2] - l[0];
  const h = l[3] - l[1];
  assert.ok(w / h <= 2.001, `${w}x${h}`);
  assert.ok(l[0] <= 100 && l[2] >= 2500);
  // A small picture: the whole of it.
  assert.deepEqual(repaintCrop(300, 200, [10, 10, 20, 20]), [0, 0, 300, 200]);
  // A big mask: its box plus a third of its long side.
  const big = repaintCrop(4000, 4000, [1000, 1000, 2000, 2000]);
  assert.equal(big[2] - big[0], 1000 + 2 * 350);
});

test('expandPlan: pixels per side, or an aspect reached centered; capped at 2048', () => {
  const px = expandPlan(1000, 1000, { left: 200, right: 0, top: 100, bottom: 0 });
  assert.equal(px.width, 1200);
  assert.equal(px.height, 1100);
  assert.deepEqual(px.rect, [200, 100, 1000, 1000]);
  const wide = expandPlan(1080, 1080, { aspect: '16:9' });
  assert.equal(wide.height, 1080);
  assert.equal(wide.width, 1920);
  assert.deepEqual(wide.rect, [420, 0, 1080, 1080]);
  const tall = expandPlan(1920, 1080, { aspect: '9:16' });
  assert.ok(Math.max(tall.width, tall.height) <= 2048);
  assert.ok(Math.abs(tall.width / tall.height - 9 / 16) < 0.01, `${tall.width}x${tall.height}`);
  assert.ok(tall.scale < 1);
  assert.equal(tall.rect[2], tall.width, 'the original spans the width');
  assert.equal(tall.model.width % 16, 0);
  assert.throws(() => expandPlan(1000, 1000, { aspect: '1:1' }), /Nothing to expand/);
  assert.throws(() => expandPlan(1000, 1000, {}), /Nothing to expand/);
  assert.throws(() => expandPlan(1000, 1000, { left: 10, aspect: '16:9' }), /not both/);
  assert.throws(() => expandPlan(100, 100, { left: 500 }), /four times/);
  assert.equal(parseAspect('2.39:1'), 2.39);
  assert.throws(() => parseAspect('wide'), /aspect/);
});

test('image.expand refuses a call with nothing to do before it is queued', () => {
  const t = getTool('image.expand')!;
  assert.throws(() => t.guard!({ params: validateParams(t, {}), inputs: { image: 'x' } }), /Nothing to expand/);
  assert.throws(() => t.guard!({ params: validateParams(t, { aspect: 'square' }), inputs: { image: 'x' } }), /aspect/);
  t.guard!({ params: validateParams(t, { aspect: '9:16' }), inputs: { image: 'x' } });
});

/** Runs a comfy tool with a fake server: every graph "makes" a flat color at the size its ImageScale asks for. */
async function runFake(toolId: string, params: Record<string, unknown>, inputs: Record<string, unknown>, color = '255,0,0') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-run-'));
  const tool = getTool(toolId)!;
  const graphs: any[] = [];
  const uploads: string[] = [];
  const emitted: any[] = [];
  let result: any = null;
  const comfy = {
    server: { id: 'fake', region: 'x', price: 0 },
    upload: async (f: string) => { uploads.push(f); return `up-${uploads.length}.png`; },
    runGraph: async (g: any) => { graphs.push(g); return [{ filename: 'out.png', subfolder: '', type: 'output' }]; },
    download: async () => {
      const scale: any = Object.values(graphs.at(-1)).find((n: any) => n.class_type === 'ImageScale');
      const out = path.join(dir, `model-${graphs.length}.png`);
      py(`from PIL import Image; Image.new('RGB', (${scale.inputs.width}, ${scale.inputs.height}), (${color})).save(r'${out}')`);
      return fs.readFileSync(out);
    },
  };
  await tool.run({
    job: { id: 'j_test', client: 't', project: 'usr_test', tool: toolId, labels: {} },
    params: validateParams(tool, params), inputs, done: 0, outputs: [], signal: new AbortController().signal,
    step: () => {}, log: () => {}, tmp: (n: string) => path.join(dir, n),
    emit: async (o: any) => { emitted.push(o); }, result: (v: any) => { result = v; }, seed: (n: number) => 100 + n, usage: () => {},
    python: async (script: string, args: string[]) => {
      const r = spawnSync(python!, [path.join('post', script), ...args], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    },
    comfy,
  } as any);
  return { graphs, uploads, emitted, result, dir };
}

test('image.repaint: crops around the mask, edits with the Qwen graph, and changes nothing outside the mask', async (t) => {
  if (!pillow) return t.skip('no Python with Pillow');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repaint-src-'));
  const img = path.join(dir, 'img.png');
  const mask = path.join(dir, 'mask.png');
  // A gradient picture (so a shifted paste would show), and a transparent mask with an opaque 100x80 stroke.
  py(`from PIL import Image
im = Image.new('RGB', (1200, 900))
im.putdata([((x * 7) % 256, (y * 5) % 256, 90) for y in range(900) for x in range(1200)])
im.save(r'${img}')
m = Image.new('RGBA', (600, 450), (0, 0, 0, 0))
from PIL import ImageDraw
ImageDraw.Draw(m).rectangle([300, 200, 349, 239], fill=(255, 128, 0, 255))
m.save(r'${mask}')`);
  const r = await runFake('image.repaint', { prompt: 'a blue vase', count: 2 }, { image: img, mask });
  assert.equal(r.graphs.length, 2, 'one graph per take');
  const g = r.graphs[0];
  const nodes = Object.values(g) as any[];
  assert.ok(nodes.some((n) => n.class_type === 'UNETLoader' && /qwen_image_edit_2511/.test(n.inputs.unet_name)), 'the image.edit model');
  const enc = nodes.find((n) => n.class_type === 'TextEncodeQwenImageEditPlus' && /blue vase/.test(n.inputs.prompt));
  assert.match(enc.inputs.prompt, /outlines in red/);
  assert.ok(enc.inputs.image2, 'the guide is image 2');
  assert.equal(r.uploads.length, 2, 'the crop and the guide');
  // The mask (stretched 2x to the picture) is x 600-700, y 400-480: the crop is 512x512 around it.
  assert.deepEqual(r.result.crop, [394, 184, 906, 696]);
  assert.equal(r.result.full, false);
  assert.equal(r.emitted.length, 2);
  const out = path.join(r.dir, 'check.png');
  fs.writeFileSync(out, r.emitted[0].data);
  // Outside the mask: the original, exactly. Inside, away from the feathered edge: the model's red.
  const res = JSON.parse(py(`import json
from PIL import Image
a = Image.open(r'${img}').convert('RGB'); b = Image.open(r'${out}').convert('RGB')
diff = 0
for y in range(0, 900, 3):
  for x in range(0, 1200, 3):
    inside = 600 <= x < 700 and 400 <= y < 480
    if not inside and a.getpixel((x, y)) != b.getpixel((x, y)): diff += 1
print(json.dumps({'size': b.size, 'outsideChanged': diff, 'center': b.getpixel((650, 440))}))`));
  assert.deepEqual(res.size, [1200, 900]);
  assert.equal(res.outsideChanged, 0);
  assert.deepEqual(res.center, [255, 0, 0]);
});

test('image.repaint: an empty mask is refused; a full mask edits the whole picture', async (t) => {
  if (!pillow) return t.skip('no Python with Pillow');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repaint-edge-'));
  const img = path.join(dir, 'img.png');
  const empty = path.join(dir, 'empty.png');
  const full = path.join(dir, 'full.png');
  py(`from PIL import Image
Image.new('RGB', (640, 480), (10, 200, 10)).save(r'${img}')
Image.new('L', (640, 480), 0).save(r'${empty}')
Image.new('L', (64, 48), 255).save(r'${full}')`);
  await assert.rejects(runFake('image.repaint', { prompt: 'x' }, { image: img, mask: empty }), /mask is empty/);
  const r = await runFake('image.repaint', { prompt: 'make it night' }, { image: img, mask: full }, '0,0,255');
  assert.equal(r.result.full, true);
  assert.deepEqual(r.result.crop, [0, 0, 640, 480]);
  assert.equal(r.uploads.length, 1, 'no guide for a whole-picture edit');
  const out = path.join(r.dir, 'full.png');
  fs.writeFileSync(out, r.emitted[0].data);
  assert.equal(py(`from PIL import Image; im = Image.open(r'${out}').convert('RGB'); print(im.size, im.getpixel((0, 0)), im.getpixel((639, 479)))`), '(640, 480) (0, 0, 255) (0, 0, 255)');
});

test('image.expand: pads with blurred edges, the model fills it, the original comes back sharp in place', async (t) => {
  if (!pillow) return t.skip('no Python with Pillow');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expand-src-'));
  const img = path.join(dir, 'img.png');
  py(`from PIL import Image
im = Image.new('RGB', (800, 800))
im.putdata([((x * 3) % 256, (y * 3) % 256, 40) for y in range(800) for x in range(800)])
im.save(r'${img}')`);
  const r = await runFake('image.expand', { aspect: '16:9', prompt: 'more forest' }, { image: img }, '0,0,0');
  assert.equal(r.graphs.length, 1);
  const enc = (Object.values(r.graphs[0]) as any[]).find((n) => n.class_type === 'TextEncodeQwenImageEditPlus' && /more forest/.test(n.inputs.prompt));
  assert.ok(enc, 'the prompt names the new area');
  assert.equal(r.result.height, 800);
  assert.equal(r.result.width, 1422);
  const canvas = path.join(r.dir, 'canvas.png');
  const out = path.join(r.dir, 'check.png');
  fs.writeFileSync(out, r.emitted[0].data);
  const res = JSON.parse(py(`import json
from PIL import Image
a = Image.open(r'${img}').convert('RGB'); b = Image.open(r'${out}').convert('RGB'); c = Image.open(r'${canvas}').convert('RGB')
x0 = ${r.result.rect[0]}
same = all(a.getpixel((x, y)) == b.getpixel((x0 + x, y)) for y in range(0, 800, 7) for x in range(40, 760, 7))
print(json.dumps({'size': b.size, 'canvas': c.size, 'centerSame': same, 'edge': b.getpixel((5, 400)), 'prefill': c.getpixel((5, 400))}))`));
  assert.deepEqual(res.size, [1422, 800]);
  assert.deepEqual(res.canvas, [1422, 800]);
  assert.equal(res.centerSame, true, 'the original pixels, inside the seam');
  assert.deepEqual(res.edge, [0, 0, 0], 'the new area is the model\'s');
  assert.notDeepEqual(res.prefill, [0, 0, 0], 'the pre-fill carried the edge colors out');
});
