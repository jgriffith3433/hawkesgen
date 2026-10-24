// Image to 3D always takes more than one view: the single-image tools refuse unless the call says allowSingleView,
// mesh.views3d refuses a picture that is not a sheet, and the view-sheet tool's prompts and check are sound. No GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-3d-'));
const { submit, queue } = await import('../src/jobs.ts');
(queue as any).pump = () => {}; // no servers here: jobs stay queued
const { TOOLS, getTool } = await import('../src/tools/index.ts');
const { putAsset } = await import('../src/library.ts');
const threed = await import('../src/tools/threed.ts');
const { imageSize } = threed;
const { viewPrompt, subjectOf, badViews, propCheck, anglePrompt, turnaroundPrompt, TURNAROUND } = await import('../src/tools/viewsheet.ts');

const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;

/** A solid-color PNG of this size, as a library asset. */
function png(width: number, height: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-3d-img-'));
  const f = path.join(dir, 'x.png');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=${width}x${height}`, '-frames:v', '1', f]);
  assert.equal(r.status, 0, String(r.stderr));
  const a = putAsset({ data: fs.readFileSync(f), ext: '.png', job: null as any, client: 'test', project: 'sandbox', tool: 'test', seed: null, recipe: { tool: 'test', version: 1, params: { width, height }, inputs: {} } as any });
  return `asset:${a.id}`;
}
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('mesh.views3d is listed first; the single-view tools are deprecated and last among the mesh tools', () => {
  assert.equal(TOOLS[0].id, 'mesh.views3d');
  const ids = TOOLS.map((t) => t.id);
  assert.ok(ids.indexOf('image.viewsheet') < ids.indexOf('image.generate'));
  for (const id of ['mesh.textured', 'mesh.from-image', 'mesh.from-views']) {
    assert.match(getTool(id)!.description, /^DEPRECATED \(one view guesses the back; use mesh\.views3d\)/, id);
    assert.ok(ids.indexOf(id) > ids.indexOf('image.generate'), `${id} is after the everyday tools`);
  }
  assert.match(getTool('mesh.views3d')!.description, /always more than one view/i);
});

test('a single image to mesh.textured or mesh.from-image is refused, and the error says how to get the views', { skip: !hasFfmpeg && 'no ffmpeg here' }, () => {
  for (const tool of ['mesh.textured', 'mesh.from-image']) {
    let err: any;
    try { submit(owner, { tool, project: 'sandbox', params: {}, inputs: { image: png(1024, 1024) } }); } catch (e) { err = e; }
    assert.ok(err, `${tool} should refuse`);
    assert.match(err.message, /ONE image/);
    assert.match(err.message, /mesh\.views3d/);
    assert.match(err.message, /image\.viewsheet/);
    assert.match(err.message, /image\.sheet/);
    assert.match(err.message, /allowSingleView: true/);
  }
});

test('allowSingleView: true is the escape hatch for props and blockouts', { skip: !hasFfmpeg && 'no ffmpeg here' }, () => {
  for (const tool of ['mesh.textured', 'mesh.from-image']) {
    const job = submit(owner, { tool, project: 'sandbox', params: { allowSingleView: true }, inputs: { image: png(512, 512) } });
    assert.equal(job.status, 'queued');
    assert.equal(job.params.allowSingleView, true);
  }
});

test('a refused call also stops a character recipe step run by an agent through reuse', { skip: !hasFfmpeg && 'no ffmpeg here' }, () => {
  assert.throws(() => submit(owner, { tool: 'mesh.textured', project: 'phorigins', params: { faces: 100000 }, inputs: { image: png(1024, 1024) }, reuse: true, labels: { entity: 'phorigins/hero' } }), /ONE image/);
});

test('mesh.views3d refuses a single view but takes a 4-view sheet', { skip: !hasFfmpeg && 'no ffmpeg here' }, () => {
  assert.throws(() => submit(owner, { tool: 'mesh.views3d', project: 'sandbox', inputs: { image: png(1024, 1024) } }), /single view/);
  const ok = submit(owner, { tool: 'mesh.views3d', project: 'sandbox', inputs: { image: png(4096, 1024) } });
  assert.equal(ok.status, 'queued');
});

test('imageSize reads PNG headers and has no opinion about other files', { skip: !hasFfmpeg && 'no ffmpeg here' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-3d-size-'));
  const p = path.join(dir, 'a.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=300x100', '-frames:v', '1', p]);
  assert.deepEqual(imageSize(p), { width: 300, height: 100 });
  const j = path.join(dir, 'a.jpg');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x80', '-frames:v', '1', j]);
  assert.deepEqual(imageSize(j), { width: 320, height: 80 });
  const t = path.join(dir, 'a.txt');
  fs.writeFileSync(t, 'hello');
  assert.equal(imageSize(t), null);
  assert.equal(imageSize(path.join(dir, 'missing.png')), null);
});

test('image.viewsheet: true views, flat grey light, limbs kept apart for robots and creatures, objects without a pose', () => {
  for (const v of ['back', 'left', 'right'] as const) {
    const humanoid = viewPrompt(v, 'humanoid');
    assert.match(humanoid, /plain flat light grey background/);
    assert.match(humanoid, /flat even lighting/);
    assert.match(humanoid, /same (design|colors)|exact same design/);
    assert.doesNotMatch(humanoid, /separated/);
    assert.match(viewPrompt(v, 'creature'), /fully separated from the body[^.]*each one is completely visible/);
    assert.doesNotMatch(viewPrompt(v, 'prop'), /arms|A-pose|character/i);
  }
  assert.match(viewPrompt('back', 'humanoid'), /directly behind/);
  assert.match(viewPrompt('left', 'humanoid'), /90 degree side profile/);
  assert.equal(subjectOf('humanoid'), 'humanoid');
  assert.equal(subjectOf(undefined), 'humanoid');
  assert.equal(subjectOf('robot'), 'creature');
  assert.equal(subjectOf('Spider'), 'creature');
  assert.equal(subjectOf('prop'), 'prop');
});

test('the view check rejects a view Claude flags or does not mention', () => {
  const verdict = { summary: '', views: [{ view: 'back', ok: true, problem: '' }, { view: 'left', ok: false, problem: 'has four arms' }] };
  assert.deepEqual(badViews(verdict as any), ['left', 'right']);
  assert.deepEqual(badViews({ summary: '', views: ['back', 'left', 'right'].map((view) => ({ view, ok: true, problem: '' })) }), []);
});

test('image.viewsheet takes the front and optional own views, sheet cells of at least 1024', () => {
  const t = getTool('image.viewsheet')!;
  assert.ok(t.inputs.image.required);
  for (const k of ['back', 'left', 'right']) assert.ok(t.inputs[k] && !t.inputs[k].required, k);
  assert.ok(t.params.cell.min! >= 1024);
  assert.equal(t.provider, 'pipeline');
});

test('the view check of an object accepts look-alike sides of a symmetric object, and still refuses a changed one', () => {
  // The character rules (back of the head, profiles facing opposite ways) refused 31 of 55 starter props on 2026-10-23.
  const c = propCheck('The object: a red apple\n', ['f', 'b', 'l', 'r']);
  assert.match(c.prompt, /symmetric/);
  assert.match(c.prompt, /do not refuse a view for looking like another view/);
  assert.match(c.prompt, /different or changed object/);
  assert.doesNotMatch(c.prompt + c.system, /head|limbs|outfit|character/i);
  assert.deepEqual(c.images, ['f', 'b', 'l', 'r']);
});

test('mesh.views3d: four views, or one sheet; never a partial set or a single picture', () => {
  const { views3dSources, VIEW_ORDER } = threed;
  assert.deepEqual([...VIEW_ORDER], ['front', 'back', 'left', 'right']);
  const four = { front: 'f.png', back: 'b.png', left: 'l.png', right: 'r.png' };
  assert.deepEqual(views3dSources(four), { views: four });
  assert.throws(() => views3dSources({ front: 'f.png', back: 'b.png' }), /all four views[^]*only front, back/);
  assert.throws(() => views3dSources({}), /four views/);
  assert.deepEqual(views3dSources({ image: 'missing-sheet.png' }), { sheet: 'missing-sheet.png' });
  const t = getTool('mesh.views3d')!;
  for (const v of ['image', ...VIEW_ORDER]) assert.ok(t.inputs[v] && !t.inputs[v].required, v);
});

test('mesh.views3d hands each view to the Pixal3D input of the same name (left is left), with no fixed crops', () => {
  const m = JSON.parse(fs.readFileSync(path.join('workflows', 'mesh-views3d', 'workflow.json'), 'utf8'));
  const g = JSON.parse(fs.readFileSync(path.join('workflows', 'mesh-views3d', 'graph.json'), 'utf8'));
  const cond = Object.values<any>(g).find((n) => n.class_type === 'Pixal3DMultiViewConditioning');
  assert.equal(cond.inputs.fov, 20);
  for (const v of ['front', 'back', 'left', 'right']) {
    const [load] = m.inputs[v].targets[0];
    assert.equal(g[load].class_type, 'LoadImage', v);
    // Follow the conditioning's input back through the save that keeps what Pixal3D received.
    let ref = cond.inputs[v];
    while (ref[0] !== load) {
      const n = g[ref[0]];
      assert.ok(n && n.class_type === 'SaveImageAdvanced', `${v} reaches ${n?.class_type} instead of its LoadImage`);
      assert.equal(n._meta.title, `${v} view`);
      ref = n.inputs.images;
    }
  }
  assert.equal(Object.values<any>(g).filter((n) => /ImageCrop|RemoveBackground/.test(n.class_type)).length, 0, 'framing is done in code, at one scale');
  assert.deepEqual(m.inputs.image.targets, []);
});

const python = [path.join('.venv', 'Scripts', 'python.exe'), path.join('.venv', 'bin', 'python')].find((p) => fs.existsSync(p));
const pillow = python && spawnSync(python, ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;

test('a sheet splits into front, back, left, right by its width, and the views are framed at one scale on black', { skip: !pillow && 'no .venv with Pillow' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-3d-split-'));
  const sheet = path.join(dir, 'sheet.png');
  // Four 300 px cells on grey: a red, green, blue and yellow box; the sides narrower, the back drawn at half the size.
  const make = spawnSync(python!, ['-c', [
    'from PIL import Image',
    'im = Image.new("RGB", (1200, 300), (230, 230, 230))',
    'im.paste((200, 0, 0), (50, 50, 250, 250))',
    'im.paste((0, 200, 0), (400, 100, 500, 200))',
    'im.paste((0, 0, 200), (720, 50, 780, 250))',
    'im.paste((200, 200, 0), (1020, 50, 1080, 250))',
    `im.save(${JSON.stringify(sheet)})`,
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(make.status, 0, make.stderr);
  const parts = threed.VIEW_ORDER.map((v: string) => path.join(dir, `${v}.png`));
  const split = spawnSync(python!, [path.join('post', 'prep.py'), 'split', sheet, '4', ...parts], { encoding: 'utf8' });
  assert.equal(split.status, 0, split.stderr);
  const framed = threed.VIEW_ORDER.map((v: string) => path.join(dir, `framed-${v}.png`));
  const r = spawnSync(python!, [path.join('post', 'prep.py'), 'views', '256', '1.1', ...parts, ...framed], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const info = JSON.parse(r.stdout);
  assert.equal(info.heightRatio, 2, 'the back was drawn at half the height');
  // Every view ends up the same height (the object is as tall from any side), the widest spanning 1/1.1 of the frame.
  const heights = info.views.map((v: any) => v.size[1]);
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `heights ${heights}`);
  assert.ok(Math.abs(info.views[0].size[0] - 256 / 1.1) <= 2, `front width ${info.views[0].size[0]}`);
  const px = spawnSync(python!, ['-c', `from PIL import Image\nfor f in ${JSON.stringify(framed)}:\n  im = Image.open(f).convert("RGB")\n  print(im.size, im.getpixel((2, 2)), im.getpixel((128, 128)))`], { encoding: 'utf8' });
  assert.deepEqual(px.stdout.trim().split(/\r?\n/), [
    '(256, 256) (0, 0, 0) (200, 0, 0)',
    '(256, 256) (0, 0, 0) (0, 200, 0)',
    '(256, 256) (0, 0, 0) (0, 0, 200)',
    '(256, 256) (0, 0, 0) (200, 200, 0)',
  ]);
});

test('image.viewsheet: exact camera words by default, the angles LoRA or one turnaround front|left|back|right on request', () => {
  const t = getTool('image.viewsheet')!;
  assert.equal(t.params.method.default, 'prose');
  assert.deepEqual(t.params.method.values, ['prose', 'angles', 'turnaround']);
  assert.ok(t.version >= 4);
  assert.equal(t.params.straighten.default, undefined, 'on for props, off for characters unless set');
  assert.equal(anglePrompt('back'), '<sks> back view eye-level shot medium shot');
  for (const v of ['back', 'left', 'right'] as const) assert.match(anglePrompt(v), /^<sks> (back view|left side view|right side view) eye-level shot medium shot$/);
  assert.deepEqual([...TURNAROUND], ['front', 'left', 'back', 'right']);
  const p = turnaroundPrompt('prop');
  assert.ok(p.indexOf('Panel 1') < p.indexOf('Panel 2') && p.indexOf('Panel 2') < p.indexOf('Panel 3'));
  assert.match(p, /Panel 2[^.]*camera moved to the left, the object facing the right edge/);
  assert.match(p, /Panel 4[^.]*camera moved to the right, the object facing the left edge/);
  assert.doesNotMatch(p, /character|pose/);
  assert.match(viewPrompt('left', 'humanoid'), /^An exact 90 degree side profile of the same character, the camera moved 90 degrees to the left, the front of it facing the right edge of the picture/);
  assert.match(viewPrompt('right', 'prop'), /^An exact 90 degree side profile of the same object, the camera moved 90 degrees to the right, the front of it facing the left edge/);
  assert.match(viewPrompt('back', 'prop'), /^The back of the same object, seen from directly behind/);
  assert.equal(getTool('image.edit')!.params.angles.default, 0);
});
