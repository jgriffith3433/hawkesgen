// blender.character: the ops checked before a server is claimed, the server script, FBX/BVH/.blend filing, the shared
// character3d kind's recipes, and (where Blender is installed) the whole server script run here exactly as a GPU server
// runs it: a skinned Mixamo-named FBX character (test/fixtures/make_character.py) cleaned, baked, given a bat, an
// SMPL-named A-pose BVH clip (test/fixtures/make_mocap.py) retargeted onto its T-pose rig, every clip edit, the FBX, GLB
// and .blend written and read back (test/fixtures/check_character.py), and the preview videos. CI has no Blender, so
// that part skips there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-char-'));
const { checkOps, characterScript } = await import('../src/tools/character.ts');
const { getTool } = await import('../src/tools/index.ts');
const { mimeOf, kindOf } = await import('../src/util.ts');
const { getProjectPresets } = await import('../src/presets.ts');
const { putAsset } = await import('../src/library.ts');
const L = await import('../src/entities.ts');

const files = ['/in/hero.fbx', '/in/walk.bvh', '/in/bat.glb', '/in/clip.glb'];

test('checkOps: import first, files by index of the right type, known ops and fields', () => {
  const plan = checkOps([
    { op: 'import', file: 0 }, { op: 'clean', triangles: 25000 }, { op: 'bake', size: 2048 },
    { op: 'attach', file: 2, bone: 'RightHand', offset: [0, 0.1, 0] }, { op: 'retarget', file: [1, 3] },
    { op: 'loop', clip: 'walk', blend: 6 }, { op: 'pose', clip: 'wave', bones: { RightArm: [0, 0, 90] } },
    { op: 'export', format: 'fbx' }, { op: 'export', format: 'glb' }, { op: 'preview' },
  ], files);
  assert.deepEqual(plan.exports, ['fbx', 'glb']);
  assert.ok(plan.bake && plan.previews && plan.turntable);
  assert.doesNotThrow(() => checkOps([{ op: 'import', file: 0 }, { op: 'retarget', file: '*' }], files));
  const bad: [unknown, RegExp][] = [
    [[], /ops must be a list/],
    [[{ op: 'clean' }], /import the character first/],
    [[{ op: 'import', file: 1 }], /file 1 is \.bvh; this op takes \.glb/],
    [[{ op: 'import', file: 0 }, { op: 'import', file: 2 }], /one import per job/],
    [[{ op: 'import', file: 9 }], /index of one of the job's files \(0 to 3\)/],
    [[{ op: 'import', file: 0 }, { op: 'attach', file: 2 }], /bone is required/],
    [[{ op: 'import', file: 0 }, { op: 'bake', size: 4096 }], /2K at most/],
    [[{ op: 'import', file: 0 }, { op: 'retarget', file: 1, from: 'maya' }], /bone names are auto/],
    [[{ op: 'import', file: 0 }, { op: 'speed', clip: 'walk', factor: 0 }], /factor is required|factor is 0\.05/],
    [[{ op: 'import', file: 0 }, { op: 'export', format: 'usd' }], /format is fbx, glb or blend/],
    [[{ op: 'import', file: 0 }, { op: 'python', code: 'x' }], /unknown op "python"/],
    [[{ op: 'import', file: 0, script: 'x' }], /unknown field script/],
  ];
  for (const [ops, re] of bad) assert.throws(() => checkOps(ops, files), re, JSON.stringify(ops));
});

test('characterScript: the ops in Blender, then each preview shot rendered and encoded', () => {
  const s = characterScript();
  assert.match(s, /hawkes_character\.py -- spec\.json/);
  assert.match(s, /for s in out\/previews\/\*\.json/);
  assert.match(s, /hawkes_blender\.py -- "\$s"/);
  assert.match(s, /res\/preview-\$n\.mp4/);
  const tool = getTool('blender.character');
  assert.ok(tool && tool.family === 'blender' && tool.output === 'mesh' && tool.inputs.files.multiple);
  assert.equal(tool!.version, 6);
});

test('checkOps: angles op (four stills for mesh judging)', () => {
  assert.doesNotThrow(() => checkOps([{ op: 'import', file: 0 }, { op: 'angles', size: 256 }], files));
  assert.throws(() => checkOps([{ op: 'import', file: 0 }, { op: 'angles', size: 64 }], files), /angles: size/);
});

test('checkOps: robot split / template / clips and generic FBX bones', () => {
  const plan = checkOps([
    { op: 'import', file: 0 },
    { op: 'split', kind: 'quadarm', label: true },
    { op: 'template', kind: 'quadarm' },
    { op: 'clips', list: [{ type: 'walk', gait: 'wave' }, { type: 'attack', attack: 'stab' }, 'idle'] },
    { op: 'export', format: 'fbx', bones: 'generic' },
    { op: 'export', format: 'glb' },
  ], files);
  assert.deepEqual(plan.exports, ['fbx', 'glb']);
  assert.equal(plan.ops[1].angles, true, 'label: true turns angles on for Claude');
  assert.doesNotThrow(() => checkOps([
    { op: 'import', file: 0 }, { op: 'split', kind: 'spider' }, { op: 'template', kind: 'spider' }, { op: 'clips' },
  ], files));
  const bad: [unknown, RegExp][] = [
    [[{ op: 'import', file: 0 }, { op: 'template', kind: 'dragon' }], /kind is spider/],
    [[{ op: 'import', file: 0 }, { op: 'split', by: 'uv' }], /by is connected/],
    [[{ op: 'import', file: 0 }, { op: 'clips', list: [{ type: 'dance' }] }], /type is walk/],
    [[{ op: 'import', file: 0 }, { op: 'export', format: 'fbx', bones: 'maya' }], /bones is mixamo/],
  ];
  for (const [ops, re] of bad) assert.throws(() => checkOps(ops, files), re, JSON.stringify(ops));
});

test('FBX, BVH and .blend files have types, so they file as meshes and files (not .bin)', () => {
  assert.equal(mimeOf('a.fbx'), 'model/vnd.fbx');
  assert.equal(kindOf(mimeOf('a.FBX')), 'mesh');
  assert.equal(kindOf(mimeOf('a.blend')), 'file');
  assert.equal(kindOf(mimeOf('a.bvh')), 'file');
  const a = putAsset({ data: Buffer.from('fbx'), ext: '.fbx', client: 'test', project: 'phorigins', tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any });
  assert.equal(a.kind, 'mesh');
  assert.ok(a.path.endsWith('.fbx'), a.path);
});

test('character3d is a kind in every project: an animation slot retargets its source onto the rig and files the GLB and the preview', () => {
  for (const p of ['phorigins', 'sickofit', 'doseofdestruction']) assert.ok(getProjectPresets(p)!.kinds?.character3d, p);
  assert.ok(getProjectPresets('phorigins')!.kinds?.character, "a project's own kinds stay");
  const owner = { id: 'test', name: 'J', role: 'owner', projects: ['*'] } as any;
  const file = (tag: string, ext: string) => putAsset({ data: Buffer.from(tag), ext, client: 'test', project: 'phorigins', tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any });
  const clip = file('mixamo walk', '.fbx');
  const e = L.createEntity(owner, { project: 'phorigins', name: 'Pierce', kind: 'character3d', data: { slots: { 'animation/walk': { source: `asset:${clip.id}` } } } });
  const rig = file('rigged pierce', '.glb');
  L.addVersion(owner, { entity: e.id, slot: 'rig', asset: rig.id, status: 'current' });
  const spec: any = L.slotJobSpec(owner, { entity: e.id, slot: 'animation/walk' });
  assert.equal(spec.tool, 'blender.character');
  assert.deepEqual(spec.inputs.files, ['slot:./rig', `asset:${clip.id}`]);
  assert.equal(spec.params.ops[1].name, 'walk');
  assert.deepEqual(spec.labels.slots, { glb: 'animation/walk', 'preview/walk': 'preview/walk' });
  assert.doesNotThrow(() => checkOps(spec.params.ops, ['/r.glb', '/w.fbx']));
  const preview = file('mp4', '.mp4');
  const filed = L.fileJobOutputs({ id: 'j1', status: 'done', labels: spec.labels, outputs: [{ asset: rig.id, title: 'glb' }, { asset: preview.id, title: 'preview/walk' }, { asset: preview.id, title: 'still' }] });
  assert.deepEqual(filed.map((v: any) => v.slot).sort(), ['animation/walk', 'preview/walk']);
  // Without a source the input is left out, and the job says what's missing before a server is claimed.
  const e2 = L.createEntity(owner, { project: 'phorigins', name: 'Nobody', kind: 'character3d' });
  L.addVersion(owner, { entity: e2.id, slot: 'rig', asset: rig.id, status: 'current' });
  const s2: any = L.slotJobSpec(owner, { entity: e2.id, slot: 'animation/run' });
  assert.deepEqual(s2.inputs.files, ['slot:./rig']);
  assert.throws(() => checkOps(s2.params.ops, ['/r.glb']), /retarget: file must be the index/);
  assert.equal((L.slotJobSpec(owner, { entity: e2.id, slot: 'preview/turntable' }) as any).labels.slots.turntable, 'preview/turntable');
});

test('character3d mesh is an asset.make chain (from the four-view sheet, best-of-N); robot form uses makeRobot; check/humanoid needs unityProject', () => {
  const owner = { id: 'test', name: 'J', role: 'owner', projects: ['*'] } as any;
  const kind = getProjectPresets('phorigins')!.kinds!.character3d;
  for (const s of ['concept', 'apose', 'cutout', 'sheet', 'mesh', 'rig', 'export/fbx', 'check/humanoid']) {
    assert.ok(kind.slots[s]?.make || kind.slots[s]?.makeRobot, s);
  }
  const e = L.createEntity(owner, { project: 'phorigins', name: 'Hero', kind: 'character3d', data: { look: 'a knight' } });
  const mesh: any = L.slotJobSpec(owner, { entity: e.id, slot: 'mesh' });
  assert.equal(mesh.tool, 'asset.make');
  assert.equal(mesh.params.candidates, 3);
  assert.equal(mesh.params.pickAt, 1);
  assert.equal(mesh.params.steps[0].tool, 'mesh.views3d');
  assert.equal(mesh.params.steps[0].inputs.image, 'slot:./sheet', 'the mesh is made from the view sheet, never one picture');
  assert.equal(mesh.params.steps[0].inputs.image2, undefined);
  const sheet: any = L.slotJobSpec(owner, { entity: e.id, slot: 'sheet' });
  assert.equal(sheet.tool, 'image.viewsheet');
  assert.equal(sheet.params.form, 'humanoid');
  assert.equal(sheet.params.cell, 1024);
  assert.equal(sheet.inputs.image, 'slot:./cutout');
  assert.equal(mesh.params.steps[1].tool, 'blender.character');
  assert.deepEqual(mesh.params.refs, [0]);
  assert.deepEqual(mesh.inputs.files, ['slot:./concept']);
  const apose: any = L.slotJobSpec(owner, { entity: e.id, slot: 'apose' });
  assert.match(apose.params.prompt, /A-pose|arms 45 degrees down/i);
  const robot = L.createEntity(owner, {
    project: 'phorigins', name: 'Spider', kind: 'character3d',
    data: { form: 'robot', template: 'spider' },
  });
  const rigRobot: any = L.slotJobSpec(owner, { entity: robot.id, slot: 'rig' });
  assert.equal(rigRobot.tool, 'blender.character');
  assert.ok(rigRobot.params.ops.some((o: any) => o.op === 'template' && o.kind === 'spider'));
  assert.ok(rigRobot.params.ops.some((o: any) => o.op === 'export' && o.bones === 'generic'));
  const robotSheet: any = L.slotJobSpec(owner, { entity: robot.id, slot: 'sheet' });
  assert.equal(robotSheet.params.form, 'robot', 'a robot sheet keeps its limbs apart (subjectOf)');
  const human = L.createEntity(owner, { project: 'phorigins', name: 'Human', kind: 'character3d' });
  const rigHuman: any = L.slotJobSpec(owner, { entity: human.id, slot: 'rig' });
  assert.equal(rigHuman.tool, 'mesh.rig');
  const checked = L.createEntity(owner, {
    project: 'phorigins', name: 'Checked', kind: 'character3d',
    data: { unityProject: 'sickofitgame-unity' },
  });
  const check: any = L.slotJobSpec(owner, { entity: checked.id, slot: 'check/humanoid' });
  assert.equal(check.tool, 'unity.test');
  assert.equal(check.params.project, 'sickofitgame-unity');
  assert.equal(check.params.category, 'HawkesGen.Humanoid');
  assert.deepEqual(check.inputs.fbx, 'slot:./export/fbx');
});

// HAWKES_NO_BLENDER: skip like CI does (hawkesstudio/deploy/local-deploy.mjs checks a commit with it).
const blender = process.env.HAWKES_NO_BLENDER ? undefined : [process.env.BLENDER, 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe', '/opt/blender/blender', '/usr/bin/blender']
  .find((p) => p && fs.existsSync(p));
const bash = process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe'].find((p) => fs.existsSync(p)) : '/bin/bash';
const python = [path.join('.venv', 'Scripts', 'python.exe'), path.join('.venv', 'bin', 'python')].find((p) => fs.existsSync(p))
  ?? (spawnSync('python3', ['--version']).status === 0 ? 'python3' : undefined);
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : ['C:/ffmpeg/bin/ffmpeg.exe'].find((p) => fs.existsSync(p));
const skip = !blender ? 'no Blender here' : !bash ? 'no bash' : !python ? 'no Python' : !ffmpeg ? 'no ffmpeg' : false;

test('blender.character script: clean, bake, a prop, a cross-skeleton retarget, every clip edit, FBX/GLB/.blend, previews', { skip, timeout: 900_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(`${dir}/in`);
    const run = (script: string, args: string[]) => {
      const r = spawnSync(blender!, ['-b', '--factory-startup', '-P', path.resolve(script), '--', ...args], { encoding: 'utf8' });
      return r.stdout + r.stderr;
    };
    let log = run('test/fixtures/make_character.py', [`${dir}/in/0.fbx`]);
    assert.ok(fs.existsSync(`${dir}/in/0.fbx`), log);
    log = run('test/fixtures/make_mocap.py', [`${dir}/in/1.bvh`]);
    assert.ok(fs.existsSync(`${dir}/in/1.bvh`), log);
    // A bat: a 4 cm x 4 cm x 80 cm box.
    fs.writeFileSync(`${dir}/in/2.obj`, 'v 0 0 0\nv 0.04 0 0\nv 0.04 0.04 0\nv 0 0.04 0\nv 0 0 0.8\nv 0.04 0 0.8\nv 0.04 0.04 0.8\nv 0 0.04 0.8\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 4 8 5 1\n');
    fs.copyFileSync('post/blender/hawkes_character.py', `${dir}/hawkes_character.py`);
    fs.copyFileSync('post/blender/hawkes_robot.py', `${dir}/hawkes_robot.py`);
    fs.copyFileSync('post/blender/hawkes_blender.py', `${dir}/hawkes_blender.py`);
    const ops = [
      { op: 'import', file: 0 },
      { op: 'clean', triangles: 8000 },
      { op: 'bake', size: 128, samples: 1 },
      { op: 'attach', file: 2, bone: 'RightHand', offset: [0, 0.05, 0], size: 0.8, origin: 'bottom', name: 'bat' },
      { op: 'retarget', file: 1, name: 'Raise' },
      { op: 'copy', clip: 'Raise', name: 'RaiseLoop' },
      { op: 'loop', clip: 'RaiseLoop', blend: 4 },
      { op: 'inplace', clip: 'Raise', as: 'RaiseInPlace' },
      { op: 'speed', clip: 'Raise', factor: 2, as: 'RaiseFast' },
      { op: 'reverse', clip: 'Raise', as: 'RaiseBack' },
      { op: 'mirror', clip: 'Raise', as: 'RaiseRight' },
      { op: 'trim', clip: 'Raise', start: 1, end: 10, as: 'RaiseShort' },
      { op: 'concat', clips: ['Wave', 'Raise'], name: 'Combo', blend: 3 },
      { op: 'pose', clip: 'Point', length: 10, frame: 5, ease: 3, bones: { RightArm: [0, 0, -60] } },
      { op: 'export', format: 'fbx' },
      { op: 'export', format: 'glb' },
      { op: 'export', format: 'blend' },
      { op: 'preview', size: 128, samples: 1, seconds: 0.5, maxFrames: 8, clips: ['Raise'] },
    ];
    const ins = ['0.fbx', '1.bvh', '2.obj'].map((f) => `${dir}/in/${f}`);
    checkOps(ops, ins);
    // Cycles on the CPU: servers without a display may have no GL for EEVEE or Workbench.
    fs.writeFileSync(`${dir}/spec.json`, JSON.stringify({ out: `${dir}/out`, files: ins, fps: 30, device: 'cpu', ops }));
    const py = python!.includes('/') || python!.includes('\\') ? path.resolve(python!).replace(/\\/g, '/') : python!;
    fs.writeFileSync(`${dir}/run.sh`, characterScript({ blender: blender!, python3: py, ffmpeg: ffmpeg! }));
    const r = spawnSync(bash!, ['run.sh'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').filter((l) => !/^Fra:|INFO/.test(l)).slice(-30).join('\n'));
    for (const f of ['character.json', 'character.fbx', 'character.glb', 'character.blend', 'preview-00.mp4', 'preview-00.png', 'preview-01.mp4']) assert.ok(fs.existsSync(`${dir}/res/${f}`), f);

    const info = JSON.parse(fs.readFileSync(`${dir}/res/character.json`, 'utf8'));
    assert.deepEqual(info.warnings, []);
    assert.equal(info.names, 'mixamo');
    assert.ok(Math.abs(info.height - 1.77) < 0.02, `height ${info.height}`);
    const op = (name: string) => info.ops.find((o: any) => o.op === name);
    assert.ok(op('clean').triangles <= 8400 && op('clean').silhouette.p99 < 0.02, JSON.stringify(op('clean')));
    assert.equal(op('retarget').clips[0].names, 'smpl');
    assert.deepEqual(info.outputs.map((o: any) => o.title), ['fbx', 'glb', 'blend']);
    assert.deepEqual(info.previews.map((o: any) => o.title), ['turntable', 'still', 'preview/Raise']);

    const check = (args: string[]) => {
      const out = run('test/fixtures/check_character.py', args);
      const line = out.split('\n').find((l) => l.startsWith('CHECK '));
      assert.ok(line, out.split('\n').slice(-20).join('\n'));
      return JSON.parse(line!.slice(6));
    };
    // The GLB: every clip at its length, the bat on the hand, the baked maps; the A-pose SMPL clip on the T-pose rig with
    // each limb pointing where the mocap's does, and the walk scaled to this character's legs.
    const glb = check([`${dir}/res/character.glb`, 'Raise', `${dir}/in/1.bvh`, '1']);
    assert.deepEqual(glb.actions, { Wave: 24, Raise: 20, RaiseLoop: 16, RaiseInPlace: 20, RaiseFast: 11, RaiseBack: 20, RaiseRight: 20, RaiseShort: 10, Combo: 41, Point: 10 });
    assert.equal(glb.skinned, true);
    assert.deepEqual(glb.children, ['bat']);
    assert.ok(glb.images.includes('Body_color') && glb.images.includes('Body_normal'), glb.images);
    for (const [limb, cos] of Object.entries<number>(glb.cos)) assert.ok(cos > 0.98, `${limb} ${cos}`);
    assert.ok(glb.travel > 0.9 && glb.travel < 1.2, `travel ${glb.travel}`);
    assert.ok(check([`${dir}/res/character.glb`, 'RaiseInPlace', `${dir}/in/1.bvh`, '1']).travel < 0.01);
    const mirror = check([`${dir}/res/character.glb`, '--mirror', 'Raise', 'RaiseRight']).mirror;
    for (const [limb, cos] of Object.entries<number>(mirror)) assert.ok(cos > 0.98, `mirrored ${limb} ${cos}`);
    // The FBX for Unity: Mixamo names, a take per clip, the same height (1 unit = 1 m), skinned, the bat along.
    const fbx = check([`${dir}/res/character.fbx`, 'Raise', `${dir}/in/1.bvh`, '1']);
    assert.ok(fbx.bones.every((b: string) => b.startsWith('mixamorig:')), fbx.bones);
    assert.deepEqual(Object.keys(fbx.actions).sort(), Object.keys(glb.actions).sort());
    assert.ok(Math.abs(fbx.height - glb.height) < 0.01, `fbx ${fbx.height} glb ${glb.height}`);
    assert.ok(fbx.skinned && fbx.children.includes('bat'));
    for (const [limb, cos] of Object.entries<number>(fbx.cos)) assert.ok(cos > 0.98, `fbx ${limb} ${cos}`);

    const probe = spawnSync(ffmpeg!.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', `${dir}/res/preview-01.mp4`], { encoding: 'utf8' });
    assert.equal(probe.stdout.trim(), '128,128,8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('blender.character robot: split, quadarm template, procedural clips, generic FBX/GLB', { skip, timeout: 600_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-robot-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(`${dir}/in`);
    const run = (script: string, args: string[]) => {
      const r = spawnSync(blender!, ['-b', '--factory-startup', '-P', path.resolve(script), '--', ...args], { encoding: 'utf8' });
      return r.stdout + r.stderr;
    };
    let log = run('test/fixtures/make_robot.py', [`${dir}/in/0.glb`]);
    assert.ok(fs.existsSync(`${dir}/in/0.glb`), log);
    fs.copyFileSync('post/blender/hawkes_character.py', `${dir}/hawkes_character.py`);
    fs.copyFileSync('post/blender/hawkes_robot.py', `${dir}/hawkes_robot.py`);
    fs.copyFileSync('post/blender/hawkes_blender.py', `${dir}/hawkes_blender.py`);
    const ops = [
      { op: 'import', file: 0 },
      { op: 'split', by: 'connected', kind: 'quadarm' },
      { op: 'template', kind: 'quadarm' },
      { op: 'clips', list: [{ type: 'idle', seconds: 0.4 }, { type: 'walk', gait: 'wave', seconds: 0.5 }, { type: 'attack', attack: 'stab', seconds: 0.4 }] },
      { op: 'export', format: 'fbx', bones: 'generic' },
      { op: 'export', format: 'glb' },
    ];
    const ins = [`${dir}/in/0.glb`];
    checkOps(ops, ins);
    fs.writeFileSync(`${dir}/spec.json`, JSON.stringify({ out: `${dir}/out`, files: ins, fps: 30, device: 'cpu', ops }));
    const py = python!.includes('/') || python!.includes('\\') ? path.resolve(python!).replace(/\\/g, '/') : python!;
    fs.writeFileSync(`${dir}/run.sh`, characterScript({ blender: blender!, python3: py, ffmpeg: ffmpeg! }));
    const r = spawnSync(bash!, ['run.sh'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').filter((l) => !/^Fra:|INFO/.test(l)).slice(-40).join('\n'));
    for (const f of ['character.json', 'character.fbx', 'character.glb']) assert.ok(fs.existsSync(`${dir}/res/${f}`), f);
    const info = JSON.parse(fs.readFileSync(`${dir}/res/character.json`, 'utf8'));
    assert.equal(info.ops.find((o: any) => o.op === 'template')?.kind, 'quadarm');
    assert.ok(info.bones?.some((b: any) => b.name === 'Body'), JSON.stringify(info.bones?.map((b: any) => b.name)));
    assert.ok(info.bones?.some((b: any) => b.name === 'LegFL'), 'expected LegFL');
    assert.ok(info.clips?.length >= 3, JSON.stringify(info.clips));
    assert.equal(info.names, 'robot:quadarm');
    const fbxBones = spawnSync(blender!, ['-b', '--factory-startup', '-P', path.resolve('test/fixtures/check_character.py'), '--', `${dir}/res/character.fbx`], { encoding: 'utf8' });
    const line = (fbxBones.stdout + fbxBones.stderr).split('\n').find((l) => l.startsWith('CHECK '));
    assert.ok(line, fbxBones.stdout + fbxBones.stderr);
    const fbx = JSON.parse(line!.slice(6));
    assert.ok(fbx.bones.includes('Body') && !fbx.bones.some((b: string) => b.startsWith('mixamorig:')), fbx.bones);
    assert.ok(fbx.skinned);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('blender.character bake and lod: gaps filled (no black between islands), each level welded, decimated and baked onto its own UVs, skin kept', { skip, timeout: 600_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(`${dir}/in`);
    const run = (script: string, args: string[]) => {
      const r = spawnSync(blender!, ['-b', '--factory-startup', '-P', path.resolve(script), '--', ...args], { encoding: 'utf8' });
      return r.stdout + r.stderr;
    };
    const log = run('test/fixtures/make_character.py', [`${dir}/in/0.fbx`]);
    assert.ok(fs.existsSync(`${dir}/in/0.fbx`), log);
    fs.copyFileSync('post/blender/hawkes_character.py', `${dir}/hawkes_character.py`);
    fs.copyFileSync('post/blender/hawkes_robot.py', `${dir}/hawkes_robot.py`);
    fs.copyFileSync('post/blender/hawkes_blender.py', `${dir}/hawkes_blender.py`);
    const ops = [
      { op: 'import', file: 0 },
      { op: 'bake', size: 256, samples: 1, maps: ['color'] },
      { op: 'export', format: 'glb' },
      { op: 'lod', levels: [0.5, 0.2], sizes: [128, 64], samples: 1 },
    ];
    const ins = [`${dir}/in/0.fbx`];
    checkOps(ops, ins);
    fs.writeFileSync(`${dir}/spec.json`, JSON.stringify({ out: `${dir}/out`, files: ins, fps: 30, device: 'cpu', ops }));
    const py = python!.includes('/') || python!.includes('\\') ? path.resolve(python!).replace(/\\/g, '/') : python!;
    fs.writeFileSync(`${dir}/run.sh`, characterScript({ blender: blender!, python3: py, ffmpeg: ffmpeg! }));
    const r = spawnSync(bash!, ['run.sh'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').filter((l) => !/^Fra:|INFO/.test(l)).slice(-30).join('\n'));
    const info = JSON.parse(fs.readFileSync(`${dir}/res/character.json`, 'utf8'));
    const bake = info.ops.find((o: any) => o.op === 'bake');
    assert.ok(bake.misses.color < 0.02, `misses ${JSON.stringify(bake.misses)}`);
    const lod = info.ops.find((o: any) => o.op === 'lod');
    assert.equal(lod.rebaked, true);
    assert.deepEqual(lod.levels.map((l: any) => l.texture), [128, 64]);
    assert.ok(lod.levels[0].welded > 0, 'the FBX splits vertices at seams; the level welds them');
    const check = (file: string) => {
      const out = run('test/fixtures/check_texture.py', [file]);
      const line = out.split('\n').find((l) => l.startsWith('CHECK '));
      assert.ok(line, out.split('\n').slice(-20).join('\n'));
      return JSON.parse(line!.slice(6));
    };
    // The test grid has a little black lettering; what matters is that the empty space between the islands is not black.
    const near = check(`${dir}/res/character.glb`);
    for (const [name, im] of Object.entries<any>(near.images)) assert.ok(im.black < 0.05, `${name}: ${(im.black * 100).toFixed(1)}% black`);
    for (const [k, l] of lod.levels.entries()) {
      const got = check(`${dir}/res/${l.file}`);
      assert.ok(got.skinned, `${l.file} keeps the skin`);
      assert.ok(Math.abs(got.triangles - l.triangles) <= 2, `${l.file}: ${got.triangles} triangles, said ${l.triangles}`);
      const ims = Object.values<any>(got.images);
      assert.equal(ims.length, 1, `${l.file} has its own one texture: ${JSON.stringify(got.images)}`);
      assert.deepEqual(ims[0].size, [[128, 128], [64, 64]][k]);
      assert.ok(ims[0].black < 0.05, `${l.file}: ${(ims[0].black * 100).toFixed(1)}% black`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
