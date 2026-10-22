// motion.from-text: planning (prompt, key poses, constraints), the server script, licenses, the character3d
// motion/* recipe, and (where Blender is installed) smplh_to_bvh.py's self-test. CI has no Blender, so that skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-mft-'));

const { planMotion, kimodoConstraints, retargetOps, motionJobScript } = await import('../src/tools/motion.ts');
const { chooseBackend, installScript, MOTION_LICENSES, KIMODO_MODEL, READY_MARK, MIN_FREE_BYTES } = await import('../src/providers/motion/install.ts');
const { checkOps } = await import('../src/tools/character.ts');
const { getTool } = await import('../src/tools/index.ts');
const { getProjectPresets } = await import('../src/presets.ts');
const L = await import('../src/entities.ts');
const { putAsset } = await import('../src/library.ts');

test('planMotion: a sentence, key poses by seconds or at, takes, loop/inPlace', () => {
  const plain = planMotion({ prompt: 'A person throws a straight right punch.' });
  assert.equal(plain.prompt, 'A person throws a straight right punch');
  assert.equal(plain.modelPrompt, 'A person throws a straight right punch');
  assert.deepEqual(plain.durations, [2]);
  assert.equal(plain.takes, 1);
  assert.equal(plain.loop, false);

  const swing = planMotion({
    prompt: 'A person swings a baseball bat with both hands',
    poses: [
      { text: 'windup, the bat cocked back over the right shoulder', seconds: 0.6 },
      { text: 'contact, the bat level in front of the chest', seconds: 0.3 },
      { text: 'follow-through, the bat finishing over the left shoulder', seconds: 0.7 },
    ],
    takes: 3, inPlace: true,
  });
  assert.deepEqual(swing.durations, [0.6, 0.3, 0.7]);
  assert.equal(swing.seconds, 1.6);
  assert.equal(swing.takes, 3);
  assert.equal(swing.inPlace, true);
  assert.match(swing.modelPrompt, /windup.*contact.*follow-through/);
  assert.deepEqual(swing.clips, ['take0', 'take1', 'take2']);

  const timed = planMotion({
    prompt: 'A kick',
    seconds: 1.2,
    poses: [{ text: 'chamber', at: 0.4 }, { text: 'extend', at: 0.8 }, { text: 'plant', at: 1.2 }],
  });
  assert.deepEqual(timed.durations, [0.4, 0.4, 0.4]);

  const even = planMotion({
    prompt: 'A punch',
    seconds: 0.9,
    poses: [{ text: 'ready' }, { text: 'hit' }, { text: 'recover' }],
  });
  assert.deepEqual(even.durations, [0.3, 0.3, 0.3]);

  assert.throws(() => planMotion({ prompt: 'x' }), /3 to 500/);
  assert.throws(() => planMotion({ prompt: 'A punch', seconds: 20 }), /0\.4 and 12/);
  assert.throws(() => planMotion({ prompt: 'A punch', takes: 9 }), /1 to 8/);
  assert.throws(() => planMotion({
    prompt: 'A punch',
    poses: [{ text: 'windup over the shoulder', seconds: 0.5 }, { text: 'contact in front', at: 1 }],
  }), /every pose a seconds length/);
});

test('kimodoConstraints: root2d in seconds, or native frame_indices', () => {
  assert.equal(kimodoConstraints(null, 30), null);
  const root = kimodoConstraints([{ type: 'root2d', at: [0, 1], path: [[0, 0], [0, 1]] }], 30);
  assert.deepEqual(root![0], { type: 'root2d', frame_indices: [0, 30], smooth_root_2d: [[0, 0], [0, 1]] });
  const native = kimodoConstraints([{ type: 'joint', frame_indices: [10, 20], joint: 'LeftHand' }], 30);
  assert.equal(native![0].frame_indices![1], 20);
  assert.throws(() => kimodoConstraints([{ type: 'root2d', at: [0], path: [[0, 0], [1, 1]] }], 30), /one entry/);
});

test('retargetOps and motionJobScript: Kimodo first, HY-Motion fallback, soma then smpl via stamp', () => {
  const ops = retargetOps(['take0', 'take1'], 'soma', { loop: true, inPlace: true });
  assert.equal(ops[0].op, 'import');
  assert.deepEqual(ops[1], { op: 'retarget', file: 1, name: 'take0', from: 'soma' });
  assert.ok(ops.some((o) => o.op === 'inplace' && o.clip === 'take0'));
  assert.ok(ops.some((o) => o.op === 'loop' && o.clip === 'take1'));
  assert.ok(ops.some((o) => o.op === 'preview' && Array.isArray(o.clips) && (o.clips as string[]).includes('take1')));
  checkOps(ops, ['/r.glb', '/take-0.bvh', '/take-1.bvh']);

  const s = motionJobScript({ character: true }, {
    blender: '/opt/blender/blender', kimodo: '/opt/hawkes-motion/kimodo/.venv/bin/python',
    hy: '/opt/hawkes-motion/hymotion/.venv/bin/python', hyRoot: '/opt/hawkes-motion/hymotion/src',
    hyModel: '/opt/hawkes-motion/hymotion/ckpts/tencent/HY-Motion-1.0',
  });
  assert.match(s, /kimodo_run\.py/);
  assert.match(s, /hymotion_run\.py/);
  assert.match(s, /smplh_to_bvh\.py/);
  assert.match(s, /stamp\.py/);
  assert.match(s, /hawkes_character\.py -- spec\.json/);
  assert.match(s, /using HY-Motion 1\.0/);
  assert.doesNotMatch(motionJobScript({ character: false }), /hawkes_character/);
});

test('licenses: Kimodo SOMA is commercial; SMPL-X and SMPL body weights are not installed', () => {
  assert.equal(chooseBackend(true), 'kimodo');
  assert.equal(chooseBackend(false), 'hymotion');
  assert.equal(KIMODO_MODEL, 'Kimodo-SOMA-RP-v1.2');
  assert.ok(MIN_FREE_BYTES >= 60 * 1024 ** 3);
  const by = Object.fromEntries(MOTION_LICENSES.map((x) => [x.id, x]));
  assert.equal(by['kimodo-soma-rp-v1.2'].commercial, true);
  assert.match(by['kimodo-soma-rp-v1.2'].weights, /NVIDIA Open Model/);
  assert.equal(by['kimodo-smplx'].commercial, false);
  assert.equal(by['smpl-body'].commercial, false);
  assert.match(by['smpl-body'].note!, /not downloaded/i);
  assert.equal(by['hy-motion-1.0'].commercial, true);
  const script = installScript();
  assert.match(script, new RegExp(READY_MARK.replace(/ /g, '.*')));
  assert.match(script, /Kimodo-SOMA-RP-v1\.2/);
  assert.doesNotMatch(script, /Kimodo-SMPLX/);
  assert.doesNotMatch(script, /smplx_model|SMPL_NEUTRAL|smpl_models/);
});

test('motion.from-text is a built-in tool; character3d motion/* uses it on the rig', () => {
  const tool = getTool('motion.from-text');
  assert.ok(tool && tool.family === 'motion' && tool.version === 1 && tool.provider === 'comfy');
  assert.equal(tool!.params.prompt.required, true);
  assert.equal(tool!.params.takes.max, 8);
  assert.ok(tool!.inputs.character);

  for (const p of ['phorigins', 'sickofit', 'doseofdestruction']) {
    assert.ok(getProjectPresets(p)!.kinds?.character3d?.slots?.['motion/*'], p);
  }
  const owner = { id: 'test', name: 'J', role: 'owner', projects: ['*'] } as any;
  const file = (tag: string, ext: string) => putAsset({
    data: Buffer.from(tag), ext, client: 'test', project: 'phorigins', tool: 'file.import',
    recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any,
  });
  const e = L.createEntity(owner, {
    project: 'phorigins', name: 'Pierce', kind: 'character3d',
    data: { slots: { 'motion/swing': { prompt: 'A person swings a baseball bat with both hands' } } },
  });
  const rig = file('rigged', '.glb');
  L.addVersion(owner, { entity: e.id, slot: 'rig', asset: rig.id, status: 'current' });
  const spec: any = L.slotJobSpec(owner, { entity: e.id, slot: 'motion/swing' });
  assert.equal(spec.tool, 'motion.from-text');
  assert.equal(spec.params.prompt, 'A person swings a baseball bat with both hands');
  assert.deepEqual(spec.inputs.character, 'slot:./rig');
  assert.equal(spec.labels.slots.glb, 'motion/swing');
  assert.equal(spec.labels.slots.preview, 'preview/swing');
});

const blender = process.env.HAWKES_NO_BLENDER ? undefined : [process.env.BLENDER, 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe', '/opt/blender/blender', '/usr/bin/blender']
  .find((p) => p && fs.existsSync(p));

test('smplh_to_bvh selftest: a zero pose and a bent elbow write a SMPL-named BVH', {
  skip: !blender ? 'no Blender here' : false,
  timeout: 120_000,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smplh-'));
  try {
    const r = spawnSync(blender!, [
      '-b', '--factory-startup', '--python-exit-code', '1',
      '-P', path.resolve('post/motion/smplh_to_bvh.py'), '--', '--selftest', dir,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').slice(-20).join('\n'));
    assert.match(r.stdout + r.stderr, /selftest ok/);
    assert.ok(fs.existsSync(path.join(dir, 'zero.bvh')));
    assert.ok(fs.existsSync(path.join(dir, 'elbow.bvh')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
