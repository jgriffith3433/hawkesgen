import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { checkOps } = await import('../src/tools/character.ts');

const files = ['/in/hero.glb', '/in/front.png', '/in/back.png'];

test('shared/character3d-mv: refs point at earlier steps and its Blender ops pass checkOps', async () => {
  const { getProjectPresets } = await import('../src/presets.ts');
  const p: any = getProjectPresets('shared')!.presets['character3d-mv'];
  const steps: any[] = p.params.steps;
  steps.forEach((s, i) => {
    for (const v of JSON.stringify(s.inputs ?? {}).match(/\$step(\d+)/g) ?? []) assert.ok(Number(v.slice(5)) <= i, `${s.save}: ${v}`);
  });
  const bl = steps.find((s) => s.tool === 'blender.character');
  assert.equal(bl.inputs.files.length, 3);
  checkOps(bl.params.ops, ['/a.glb', '/b.png', '/c.png']);
  assert.ok(p.params.pickAt <= steps.findIndex((s) => s.tool === 'blender.character'));
});

test('shared/character3d-4v: steps use real tools, refs point at earlier steps, sheet takes front|back|left|right', async () => {
  const { getProjectPresets } = await import('../src/presets.ts');
  const { reloadTools, getTool } = await import('../src/tools/index.ts');
  reloadTools();
  const p: any = getProjectPresets('shared')!.presets['character3d-4v'];
  const steps: any[] = p.params.steps;
  steps.forEach((s, i) => {
    assert.ok(getTool(s.tool), `unknown tool ${s.tool}`);
    for (const v of JSON.stringify(s.inputs ?? {}).match(/\$step(\d+)/g) ?? []) assert.ok(Number(v.slice(5)) <= i, `${s.save}: ${v}`);
  });
  const sheet = steps.find((s) => s.tool === 'image.sheet');
  const saves = ['cutout', 'back', 'left', 'right'];
  assert.deepEqual(sheet.inputs.views.map((v: string) => steps[Number(v.slice(5, v.indexOf(':'))) - 1].save), saves);
  const bl = steps.find((s) => s.tool === 'blender.character');
  checkOps(bl.params.ops, ['/a.glb']);
  assert.equal(steps[Number(/^\$step(\d+)/.exec(bl.inputs.files[0])![1]) - 1].tool, 'mesh.views3d');
  assert.match(bl.inputs.files[0], /:mesh$/, 'mesh.views3d also emits preview PNGs: the ref must pick the GLB');
});

test('presets never feed a background-removal step\'s mask (its first output) onward: refs must name :cutout', async () => {
  const { getProjectPresets } = await import('../src/presets.ts');
  const all: any = getProjectPresets('shared')!.presets;
  for (const [name, preset] of Object.entries<any>(all)) {
    const steps: any[] = preset.params?.steps ?? [];
    steps.forEach((s, i) => {
      for (const ref of JSON.stringify(s.inputs ?? {}).match(/\$(?:prev|step\d+)(?::[a-z]+)?/g) ?? []) {
        const n = ref.startsWith('$prev') ? i : Number(/^\$step(\d+)/.exec(ref)![1]);
        if (steps[n - 1]?.tool === 'image.remove-background') assert.match(ref, /:cutout$/, `${name} step ${i + 1} (${s.save}): ${ref} would pass the mask`);
      }
    });
  }
});

test('checkOps: repair, retopo, project and lod ops are validated', () => {
  const plan = checkOps([
    { op: 'import', file: 0 },
    { op: 'report' },
    { op: 'fix', shards: 0.02, holes: 12 },
    { op: 'symmetrize' },
    { op: 'retopo', faces: 8000 },
    { op: 'bake' },
    { op: 'project', views: [{ file: 1, view: 'front' }, { file: 2, view: 'back' }, { file: 1, view: 45 }] },
    { op: 'lod', levels: [0.5, 0.25] },
    { op: 'export', format: 'glb' },
  ], files);
  assert.equal(plan.ops.length, 9);
  assert.throws(() => checkOps([{ op: 'import', file: 0 }, { op: 'retopo', faces: 5 }], files), /faces/);
  assert.throws(() => checkOps([{ op: 'import', file: 0 }, { op: 'retopo', mode: 'blob' }], files), /mode/);
  assert.throws(() => checkOps([{ op: 'import', file: 0 }, { op: 'lod', levels: [2] }], files), /levels/);
  assert.throws(() => checkOps([{ op: 'import', file: 0 }, { op: 'project' }], files), /views/);
  assert.throws(() => checkOps([{ op: 'import', file: 0 }, { op: 'project', views: [{ file: 1, view: 'up' }] }], files), /view/);
  assert.throws(() => checkOps([{ op: 'import', file: 0 }, { op: 'project', views: [{ file: 9, view: 'front' }] }], files));
  assert.throws(() => checkOps([{ op: 'import', file: 0 }, { op: 'fix', bogus: 1 }], files));
});

const blender = [process.env.BLENDER, 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe', '/opt/blender/blender', '/usr/bin/blender']
  .find((p) => p && fs.existsSync(p));
const python = ['python', 'python3'].find((p) => spawnSync(p, ['--version']).status === 0);
const skip = !blender ? 'no Blender here' : false;

test('Blender: a messy generated mesh is repaired, retopologised, projected from views and LOD-ed', { skip, timeout: 240_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgart-'));
  const mk = spawnSync(blender!, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', 'test/fixtures/make_messy.py', '--', path.join(dir, 'messy.glb'), path.join(dir, 'front.png'), path.join(dir, 'back.png')], { encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr || mk.stdout);
  const out = path.join(dir, 'out');
  const spec = {
    out, fps: 30, device: 'cpu',
    files: [path.join(dir, 'messy.glb'), path.join(dir, 'front.png'), path.join(dir, 'back.png')],
    ops: [
      { op: 'import', file: 0 },
      { op: 'report' },
      { op: 'fix' },
      { op: 'symmetrize' },
      { op: 'retopo', faces: 4000 },
      { op: 'report' },
      { op: 'bake', size: 512 },
      { op: 'project', size: 512, views: [{ file: 1, view: 'front' }, { file: 2, view: 'back' }] },
      { op: 'budget', target: 'web' },
      { op: 'lod', levels: [0.5] },
      { op: 'export', format: 'glb' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
  const r = spawnSync(blender!, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', 'post/blender/hawkes_character.py', '--', path.join(dir, 'spec.json')], { encoding: 'utf8', cwd: process.cwd(), timeout: 220_000 });
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || '').slice(-2000));
  const info = JSON.parse(fs.readFileSync(path.join(out, 'character.json'), 'utf8'));
  const reports = info.ops.filter((o: any) => o.op === 'report');
  assert.equal(reports.length, 2);
  const [before, after] = reports.map((o: any) => o.metrics ?? o);
  assert.ok((after.score ?? 0) >= (before.score ?? 0), `score ${before.score} -> ${after.score}`);
  assert.equal(after.boundary_edges ?? 0, 0);
  const names = fs.readdirSync(path.join(out, 'files'));
  assert.ok(names.some((n) => /_LOD1\.glb$/.test(n)), names.join(','));
  assert.ok(names.some((n) => /_color\.png$/.test(n)), names.join(','));
  assert.equal(info.budget.target, 'web');
  assert.equal(info.budget.checks.texture.value, 512);
  assert.ok(info.budget.checks.triangles.value > 0 && info.budget.checks.triangles.value <= 9000, JSON.stringify(info.budget));
  void python;
});

test('Blender: ORM packing, collision proxies and a Draco GLB', { skip, timeout: 240_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgart2-'));
  const mk = spawnSync(blender!, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', 'test/fixtures/make_messy.py', '--', path.join(dir, 'messy.glb'), path.join(dir, 'front.png'), path.join(dir, 'back.png')], { encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr || mk.stdout);
  const out = path.join(dir, 'out');
  const spec = {
    out, fps: 30, device: 'cpu',
    files: [path.join(dir, 'messy.glb'), path.join(dir, 'front.png')],
    ops: [
      { op: 'import', file: 0 },
      { op: 'pack', ao: 1, size: 256 },
      { op: 'collision', mode: 'hulls', parts: 4, name: 'dummy' },
      { op: 'collision', mode: 'capsule' },
      { op: 'export', format: 'glb', name: 'plain' },
      { op: 'export', format: 'glb', name: 'small', compress: 'draco', textures: 'webp' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
  const r = spawnSync(blender!, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', 'post/blender/hawkes_character.py', '--', path.join(dir, 'spec.json')], { encoding: 'utf8', cwd: process.cwd(), timeout: 220_000 });
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || '').slice(-2000));
  const info = JSON.parse(fs.readFileSync(path.join(out, 'character.json'), 'utf8'));
  const [pack, hulls, capsule, plain, small] = info.ops.slice(1);
  assert.equal(pack.packed.length > 0 ? pack.packed[0].size : 0, 256, JSON.stringify(pack));
  assert.ok(hulls.hulls >= 2 && hulls.faces.every((f: number) => f <= 64), JSON.stringify(hulls));
  assert.ok(capsule.capsule.radius > 0 && capsule.capsule.height > 0);
  const files = fs.readdirSync(path.join(out, 'files'));
  assert.ok(files.includes('dummy_collision.glb'), files.join(','));
  assert.ok(small.bytes < plain.bytes, `draco ${small.bytes} vs plain ${plain.bytes}`);
});

test('checkOps: pack, collision and compressed export are validated', () => {
  const imp = { op: 'import', file: 0 };
  checkOps([imp, { op: 'pack', size: 1024 }, { op: 'collision', mode: 'hulls', parts: 6 }, { op: 'export', format: 'glb', compress: 'draco', textures: 'webp' }], ['a.glb']);
  assert.throws(() => checkOps([imp, { op: 'collision', mode: 'sphere' }], ['a.glb']), /mode is/);
  assert.throws(() => checkOps([imp, { op: 'pack', ao: 0 }], ['a.glb']), /takes/);
  assert.throws(() => checkOps([imp, { op: 'export', format: 'glb', compress: 'zip' }], ['a.glb']), /compress/);
  assert.throws(() => checkOps([imp, { op: 'collision', faces: 2 }], ['a.glb']), /faces/);
});
