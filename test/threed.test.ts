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
const { imageSize } = await import('../src/tools/threed.ts');
const { viewPrompt, subjectOf, badViews } = await import('../src/tools/viewsheet.ts');

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
