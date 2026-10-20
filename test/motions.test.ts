// The CC0 motion library: the Quaternius catalog (names, tags, duration, loop, the license on disk), library search,
// and the shared/motions preset turning clip names into blender.character ops that file onto a character.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-motion-'));

const { findClip, searchMotions, motionsForQuery, expandMotionRequest, sliceClip, motionRecord } = await import('../src/motions.ts');
const { checkOps } = await import('../src/tools/character.ts');
const L = await import('../src/entities.ts');

test('the free CC0 packs are catalogued, license file included, paid editions left out', () => {
  const raw = JSON.parse(fs.readFileSync('motions/quaternius.json', 'utf8'));
  assert.equal(raw.license, 'CC0-1.0');
  assert.deepEqual(raw.packs.map((p: any) => [p.id, p.clips.length]), [['ual1', 46], ['ual2', 43]]);
  for (const p of raw.packs) {
    assert.equal(p.license, 'CC0-1.0');
    assert.equal(p.edition, 'standard');
    assert.match(fs.readFileSync(p.licenseFile, 'utf8'), /CC0 1\.0 Universal/);
    assert.match(p.note, /paid/);
    assert.match(p.zipSha256, /^[0-9a-f]{64}$/);
  }
  const walk = findClip('Walk_Loop');
  assert.equal(walk.pack, 'ual1');
  assert.equal(walk.loop, true);
  assert.equal(walk.bones, 'rigify');
  assert.ok(walk.tags.includes('locomotion') && walk.duration > 0);
  assert.equal(findClip('ual1/Death01').loop, false);
  assert.ok(findClip('ual1/Death01').tags.includes('death'));
  assert.ok(findClip('Punch_Jab').tags.includes('melee'));
  assert.ok(findClip('Hit_Chest').tags.includes('hit'));
  assert.ok(findClip('Idle_Loop').tags.includes('idle'));
  assert.equal(findClip('ual2/Melee_Hook').bones, 'unreal');
  assert.throws(() => findClip('A_TPose'), /more than one pack/);
  assert.throws(() => findClip('NotAClip'), /No motion clip/);
});

test('library search finds clips by tag and hides them from an empty browse', () => {
  const melee = searchMotions('melee');
  assert.ok(melee.total >= 8);
  assert.ok(melee.items.every((i) => i.tags.includes('melee')));
  assert.ok(melee.items.some((i) => i.title === 'Sword_Attack' && i.meta.loop === false && i.meta.duration > 0));
  assert.equal(melee.items[0].id.startsWith('motion:'), true);
  assert.equal(melee.items[0].tool, 'motion.library');
  const one = motionRecord('motion:ual1/Walk_Loop');
  assert.equal(one.meta.loop, true);
  assert.ok(one.tags.includes('locomotion'));
  assert.equal(motionsForQuery({}).total, 0);
  assert.equal(motionsForQuery({ tool: 'motion.library' }).total, 89);
  assert.equal(motionsForQuery({ text: 'death', kind: 'image' }).total, 0);
  assert.equal(motionsForQuery({ text: 'death', kind: 'file' }).total, searchMotions('death').total);
  assert.equal(motionsForQuery({ text: 'idle', starred: true }).total, 0);
});

test('shared/motions retargets the named clips onto the character and files each one', () => {
  const owner = { id: 't', name: 'J', role: 'owner' as const, projects: ['*'] };
  const e = L.createEntity(owner, { project: 'phorigins', name: 'Pierce', kind: 'character3d' });
  const spec = expandMotionRequest(owner, {
    tool: 'blender.character',
    params: { clips: ['Walk_Loop', 'Idle_Loop', 'ual2/Melee_Hook'], entity: e.id, fps: 30, preview: true },
    inputs: { files: ['slot:./rig'] },
    labels: {},
  })!;
  assert.deepEqual(spec.inputs.files, ['slot:./rig', 'motion:ual1/Walk_Loop', 'motion:ual1/Idle_Loop', 'motion:ual2/Melee_Hook']);
  assert.equal(spec.labels.entity, e.id);
  assert.equal(spec.labels.slot, 'animation/walk-loop');
  assert.equal((spec.labels.slots as any)['walk-loop'], 'animation/walk-loop');
  assert.equal((spec.labels.slots as any)['idle-loop'], 'animation/idle-loop');
  assert.equal((spec.labels.slots as any)['melee-hook'], 'animation/melee-hook');
  assert.equal((spec.labels.slots as any)['preview/melee-hook'], 'preview/melee-hook');
  assert.equal(spec.params.clips, undefined);
  assert.equal(spec.params.fps, 30);
  const ops = spec.params.ops as any[];
  assert.equal(ops[0].op, 'import');
  assert.deepEqual(ops[1], { op: 'retarget', file: 1, from: 'rigify', name: 'walk-loop' });
  assert.equal(ops[2].name, 'idle-loop');
  assert.equal(ops[3].from, 'unreal');
  assert.equal(ops[3].name, 'melee-hook');
  const exported = ops.filter((o) => o.op === 'export');
  assert.deepEqual(exported.map((o) => o.title), ['walk-loop', 'idle-loop', 'melee-hook']);
  assert.equal(ops.at(-1).op, 'preview');
  assert.deepEqual(ops.at(-1).clips, ['walk-loop', 'idle-loop', 'melee-hook']);
  assert.doesNotThrow(() => checkOps(ops, ['/c.glb', '/w.glb', '/i.glb', '/m.glb']));

  const both = expandMotionRequest(owner, {
    tool: 'blender.character',
    params: { clips: 'ual1/A_TPose, ual2/A_TPose', entity: e.id },
    inputs: { files: 'asset:a_rig' },
  })!;
  const titles = (both.params.ops as any[]).filter((o) => o.op === 'export').map((o) => o.title);
  assert.equal(new Set(titles).size, 2);

  assert.throws(() => expandMotionRequest(owner, { tool: 'blender.character', params: { clips: ['NoSuch'], entity: e.id }, inputs: { files: ['/c.glb'] } }), /No motion clip/);
  assert.throws(() => expandMotionRequest(owner, { tool: 'blender.character', params: { clips: ['Walk_Loop'] }, inputs: { files: ['/c.glb'] } }), /entity is the character/);
  assert.equal(expandMotionRequest(owner, { tool: 'blender.character', params: { ops: [] }, inputs: {} }), null);
});

test('one clip can be split out of a pack GLB', () => {
  const bin = Buffer.alloc(16);
  bin.writeFloatLE(0, 0);
  bin.writeFloatLE(1, 4);
  bin.writeFloatLE(0, 8);
  bin.writeFloatLE(0.5, 12);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Hips' }],
    animations: [
      { name: 'Walk', samplers: [{ input: 0, output: 0, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] },
      { name: 'Idle', samplers: [{ input: 1, output: 1, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', max: [1], min: [0] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', max: [0.5], min: [0] },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 8 },
      { buffer: 0, byteOffset: 8, byteLength: 8 },
    ],
    buffers: [{ byteLength: 16 }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  if (pad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
  const out = Buffer.alloc(12 + 8 + jsonBuf.length + 8 + bin.length);
  out.write('glTF', 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4E4F534A, 16);
  jsonBuf.copy(out, 20);
  const at = 20 + jsonBuf.length;
  out.writeUInt32LE(bin.length, at);
  out.writeUInt32LE(0x004E4942, at + 4);
  bin.copy(out, at + 8);

  const sliced = sliceClip(out, 'Idle');
  assert.equal(sliced.toString('utf8', 0, 4), 'glTF');
  const len = sliced.readUInt32LE(12);
  const got = JSON.parse(sliced.subarray(20, 20 + len).toString('utf8'));
  assert.deepEqual(got.animations.map((a: any) => a.name), ['Idle']);
  assert.equal(got.accessors.length, 1);
  assert.equal(got.buffers[0].byteLength, 8);
  assert.equal(got.bufferViews[0].byteOffset, 0);
  const binAt = 20 + len + 8;
  assert.equal(sliced.readFloatLE(binAt), 0);
  assert.equal(sliced.readFloatLE(binAt + 4), 0.5);
  assert.throws(() => sliceClip(out, 'Run'), /No animation Run/);
});
