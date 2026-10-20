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
  void python;
});
