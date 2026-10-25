// mesh.rig: the clip naming and script rules, and (where Blender is installed) the whole server script run here exactly
// as a GPU server runs it: an unrigged A-pose humanoid (test/fixtures/make_humanoid.py) rigged, the "Wave" clip of
// test/fixtures/make_rig.py baked onto it, the GLB read back (test/fixtures/check_rig.py), and the turntable video.
// CI has no Blender, so that part skips there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { clipNames, rigScript, turnFrames, turntableSpec } from '../src/tools/rig.ts';
import { getTool } from '../src/tools/index.ts';

test('clipNames: given names, else the file name; library hashes become ClipN; no two the same', () => {
  const files = ['/a/Walking.fbx', '/lib/0f1e2d3c4b5a69788796a5b4c3d2e1f0.fbx', '/a/Idle.glb'];
  assert.deepEqual(clipNames(files, ['Walk']).map((c) => c.name), ['Walk', 'Clip2', 'Idle']);
  assert.deepEqual(clipNames(files, null, [null, 'Take 001']).map((c) => c.action), [null, 'Take 001', null]);
  assert.throws(() => clipNames(['/a/Run.fbx', '/b/Run.fbx'], null), /Two clips are named Run/);
  assert.throws(() => clipNames(files, 'Walk'), /names must be a list/);
});

test('rigScript and turntableSpec: the rig, then the orbit render of the first clip', () => {
  const s = rigScript({ fps: 24, frames: turnFrames({ seconds: 6 }), turntable: true });
  assert.match(s, /hawkes_rig\.py -- rig\.json/);
  assert.match(s, /hawkes_blender\.py -- turn\.json/);
  assert.match(s, /-frames:v 145/);
  assert.doesNotMatch(rigScript({ fps: 24, frames: 9, turntable: false }), /hawkes_blender/);
  const t = turntableSpec({ out: 'o', glb: 'r.glb', clip: 'Walk', frames: 9, fps: 24, size: 512, engine: 'cycles', samples: 8 });
  assert.equal(t.shot.characters[0].animation, 'Walk');
  assert.equal(t.shot.camera.move, 'orbit');
  assert.equal(t.shot.camera.amount, 360);
  assert.equal('animation' in turntableSpec({ ...{ out: 'o', glb: 'r.glb', frames: 9, fps: 24, size: 512, engine: 'cycles', samples: 8 }, clip: null }).shot.characters[0], false);
  const tool = getTool('mesh.rig');
  assert.ok(tool && tool.family === 'rig' && tool.version === 2 && tool.output === 'mesh');
  assert.deepEqual(tool!.params.kind.values, ['humanoid', 'auto']);
  assert.equal(tool!.params.keepTextures.default, true);
});

const blender = process.env.HAWKES_NO_BLENDER ? undefined : [process.env.BLENDER, 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe', '/opt/blender/blender', '/usr/bin/blender']
  .find((p) => p && fs.existsSync(p));
const bash = process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe'].find((p) => fs.existsSync(p)) : '/bin/bash';
const python = [path.join('.venv', 'Scripts', 'python.exe'), path.join('.venv', 'bin', 'python')].find((p) => fs.existsSync(p))
  ?? (spawnSync('python3', ['--version']).status === 0 ? 'python3' : undefined);
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : ['C:/ffmpeg/bin/ffmpeg.exe'].find((p) => fs.existsSync(p));
const skip = !blender ? 'no Blender here' : !bash ? 'no bash' : !python ? 'no Python' : !ffmpeg ? 'no ffmpeg' : false;

test('mesh.rig script: an A-pose humanoid rigged, a clip baked on it by bone name, the GLB read back, a turntable', { skip, timeout: 900_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(`${dir}/in`);
    const run = (script: string, args: string[]) => {
      const r = spawnSync(blender!, ['-b', '--factory-startup', '-P', path.resolve(script), '--', ...args], { encoding: 'utf8' });
      return r.stdout + r.stderr;
    };
    let log = run('test/fixtures/make_humanoid.py', [`${dir}/in/mesh.glb`]);
    assert.ok(fs.existsSync(`${dir}/in/mesh.glb`), log);
    log = run('test/fixtures/make_rig.py', [`${dir}/in/clip0.glb`]);
    assert.ok(fs.existsSync(`${dir}/in/clip0.glb`), log);
    fs.copyFileSync('post/blender/hawkes_rig.py', `${dir}/hawkes_rig.py`);
    fs.copyFileSync('post/blender/hawkes_blender.py', `${dir}/hawkes_blender.py`);
    const clips = clipNames([`${dir}/in/clip0.glb`], ['Wave']);
    fs.writeFileSync(`${dir}/rig.json`, JSON.stringify({ mesh: `${dir}/in/mesh.glb`, clips, out: `${dir}/out`, fps: 24, height: 1.8 }));
    const frames = 9;
    // Cycles on the CPU: Workbench and EEVEE need a GL driver, which servers without a display may not have.
    fs.writeFileSync(`${dir}/turn.json`, JSON.stringify(turntableSpec({ out: `${dir}/out/turn`, glb: `${dir}/out/rigged.glb`, clip: 'Wave', frames, fps: 24, size: 256, engine: 'cycles', samples: 1, device: 'cpu' })));
    const py = python!.includes('/') || python!.includes('\\') ? path.resolve(python!).replace(/\\/g, '/') : python!;
    fs.writeFileSync(`${dir}/run.sh`, rigScript({ fps: 24, frames, turntable: true }, { blender: blender!, python3: py, ffmpeg: ffmpeg! }));
    const r = spawnSync(bash!, ['run.sh'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').filter((l) => !/^Fra:|INFO/.test(l)).slice(-30).join('\n'));
    for (const f of ['rigged.glb', 'rig.json', 'turntable.mp4', 'preview.png']) assert.ok(fs.existsSync(`${dir}/res/${f}`), f);

    const info = JSON.parse(fs.readFileSync(`${dir}/res/rig.json`, 'utf8'));
    assert.ok(Math.abs(info.height - 1.8) < 0.01, `height ${info.height}`);
    assert.deepEqual(info.warnings, []);
    assert.equal(info.clips[0].name, 'Wave');
    // The joints land on the body (make_humanoid.py: crotch about 0.86 m, shoulders 0.19 m out at 1.45 m, hand tips 0.75 m out).
    const j = info.joints;
    assert.ok(j.Hips[2] > 0.75 && j.Hips[2] < 1.0, `hips ${j.Hips}`);
    assert.ok(Math.abs(j.LeftArm[0] - 0.19) < 0.05 && Math.abs(j.LeftArm[2] - 1.45) < 0.1, `shoulder ${j.LeftArm}`);
    assert.ok(j.LeftHand[0] > 0.5 && j.RightHand[0] < -0.5, `hands ${j.LeftHand} ${j.RightHand}`);
    assert.ok(j.LeftToe_End[1] < j.LeftFoot[1], 'toes point to the front (-Y)');

    const out = run('test/fixtures/check_rig.py', [`${dir}/res/rigged.glb`, `${dir}/in/clip0.glb`, 'Wave']);
    const line = out.split('\n').find((l) => l.startsWith('CHECK '));
    assert.ok(line, out.split('\n').slice(-20).join('\n'));
    const got = JSON.parse(line!.slice(6));
    assert.ok(got.bones.includes('mixamorig:Hips') && got.bones.includes('mixamorig:LeftForeArm') && got.bones.includes('mixamorig:RightToeBase'));
    assert.deepEqual(got.actions, ['Wave']);
    assert.equal(got.skinned, true);
    for (const b of ['Hips', 'Spine', 'Head', 'LeftArm', 'LeftForeArm', 'RightHand', 'LeftUpLeg', 'RightLeg', 'LeftFoot']) assert.ok(got.groups[`mixamorig:${b}`] > 50, `${b} moves ${got.groups[`mixamorig:${b}`]} vertices`);
    // The clip's arm swing lands on the new rig: the hand travels the same way as on the clip's own skeleton.
    const move = (h: number[][]) => h[1].map((v, i) => v - h[0][i]);
    const a = move(got.hand), b = move(got.clipHand);
    const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
    assert.ok(Math.hypot(...a) > 0.2 && cos > 0.9, `rig hand moved ${a}, clip hand ${b}`);

    const probe = spawnSync(ffmpeg!.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', `${dir}/res/turntable.mp4`], { encoding: 'utf8' });
    assert.equal(probe.stdout.trim(), '256,256,9');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rig install script: python3.11 comes from deadsnakes when apt lacks it, and a failure says where', async () => {
  const { installScript } = await import('../src/providers/rig/install.ts');
  const s = installScript();
  assert.match(s, /ppa:deadsnakes\/ppa/);
  assert.match(s, /rig install failed/);
});
