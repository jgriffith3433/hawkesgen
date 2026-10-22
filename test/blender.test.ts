// blender.render: the frame and pass rules, and (where Blender is installed) the whole render script run here
// exactly as a GPU server runs it: a rigged character built in Blender, a 9-frame shot, then the pose drawing and
// the videos. CI has no Blender, so that part skips there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shotFrames, shotPasses, renderScript, resolveShot } from '../src/tools/blender.ts';

test('shotFrames: seconds x fps + 1, snapped down to 8n + 1', () => {
  assert.equal(shotFrames({ seconds: 5, fps: 24 }), 121);
  assert.equal(shotFrames({ seconds: 3, fps: 16 }), 49);
  assert.equal(shotFrames({ frames: 100 }), 97);
  assert.equal(shotFrames({ frames: 3 }), 9);
  assert.equal(shotFrames({ frames: 100, snap: false }), 100);
  for (const n of [9, 17, 81, 121]) assert.equal((shotFrames({ frames: n }) - 1) % 8, 0);
});

test('shotPasses: known passes only; edges bring the beauty pass', () => {
  assert.deepEqual(shotPasses(undefined), ['beauty', 'depth', 'pose', 'edges']);
  assert.deepEqual(shotPasses(['depth', 'edges']), ['beauty', 'depth', 'edges']);
  assert.throws(() => shotPasses(['depth', 'canny']), /Unknown pass canny/);
});

test('renderScript: a zip is unpacked and its .blend found; edges come from the beauty pass', () => {
  const s = renderScript({ blend: null, zip: 'in/scene.zip', fps: 24, frames: 49, edges: true });
  assert.match(s, /zipfile/);
  assert.match(s, /find in\/project -name "\*\.blend"/);
  assert.match(s, /edgedetect/);
  assert.match(s, /-frames:v 49/);
  const named = renderScript({ blend: null, zip: 'in/scene.zip', zipBlend: 'scenes/a.blend', fps: 24, frames: 9, edges: false });
  assert.match(named, /BLEND="in\/project\/scenes\/a\.blend"/);
  assert.doesNotMatch(named, /edgedetect/);
});

// HAWKES_NO_BLENDER: skip like CI does (hawkesstudio/deploy/local-deploy.mjs checks a commit with it).
const blender = process.env.HAWKES_NO_BLENDER ? undefined : [process.env.BLENDER, 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe', '/opt/blender/blender', '/usr/bin/blender']
  .find((p) => p && fs.existsSync(p));
const bash = process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe'].find((p) => fs.existsSync(p)) : '/bin/bash';
const python = [path.join('.venv', 'Scripts', 'python.exe'), path.join('.venv', 'bin', 'python')].find((p) => fs.existsSync(p));
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : ['C:/ffmpeg/bin/ffmpeg.exe'].find((p) => fs.existsSync(p));
const skip = !blender ? 'no Blender here' : !bash ? 'no bash' : !python ? 'no .venv' : !ffmpeg ? 'no ffmpeg' : false;

test('blender.render script: a rigged character waving, every pass as a video, pose keypoints on the body', { skip, timeout: 600_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(`${dir}/in`);
    const made = spawnSync(blender!, ['-b', '--factory-startup', '-P', path.resolve('test/fixtures/make_rig.py'), '--', `${dir}/in/0.glb`], { encoding: 'utf8' });
    assert.ok(fs.existsSync(`${dir}/in/0.glb`), made.stdout + made.stderr);
    fs.copyFileSync('post/blender/hawkes_blender.py', `${dir}/hawkes_blender.py`);
    fs.copyFileSync('post/pose_draw.py', `${dir}/pose_draw.py`);
    const frames = shotFrames({ frames: 9 });
    fs.writeFileSync(`${dir}/spec.json`, JSON.stringify({
      out: `${dir}/out`, files: [`${dir}/in/0.glb`], frames, fps: 24, width: 320, height: 192, engine: 'workbench', device: 'cpu',
      passes: ['beauty', 'depth', 'mask', 'pose'],
      shot: { characters: [{ file: 0, animation: 'Wave', height: 1.8 }], camera: { move: 'push-in', distance: 4 } },
    }));
    const py = path.resolve(python!).replace(/\\/g, '/');
    const script = renderScript({ blend: null, zip: null, fps: 24, frames, edges: true }, { blender: blender!, python: py, python3: py, ffmpeg: ffmpeg! });
    fs.writeFileSync(`${dir}/run.sh`, script);
    const r = spawnSync(bash!, ['run.sh'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').filter((l) => !/^Fra:/.test(l)).slice(-30).join('\n'));

    for (const f of ['beauty.mp4', 'depth.mp4', 'mask.mp4', 'pose.mp4', 'edges.mp4', 'first.png', 'info.json']) assert.ok(fs.existsSync(`${dir}/res/${f}`), f);
    const info = JSON.parse(fs.readFileSync(`${dir}/res/info.json`, 'utf8'));
    assert.equal(info.frames, 9);
    assert.equal(info.characters[0].animation, 'Wave');
    assert.ok(Math.abs(info.characters[0].height - 1.8) < 0.05, `height ${info.characters[0].height}`);
    assert.ok(info.near > 0 && info.far > info.near);
    // Every body joint found on the rig (prefix "rig:" instead of Mixamo's), and on screen.
    const pose = JSON.parse(fs.readFileSync(`${dir}/out/pose.json`, 'utf8'));
    assert.equal(pose.frames.length, 9);
    const kps = pose.frames[0][0];
    assert.equal(kps.length, 18);
    assert.equal(kps.filter((k: number[]) => k[2] > 0).length, 18, JSON.stringify(info.poseBones));
    // The left wrist moves as the arm waves.
    const wrist = (f: number) => pose.frames[f][0][7];
    assert.ok(Math.hypot(wrist(0)[0] - wrist(5)[0], wrist(0)[1] - wrist(5)[1]) > 5);
    const probe = spawnSync(ffmpeg!.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', `${dir}/res/depth.mp4`], { encoding: 'utf8' });
    assert.equal(probe.stdout.trim(), '320,192,9');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shotPasses: layers need no beauty; an empty list is allowed (stills only)', () => {
  assert.deepEqual(shotPasses(['layers']), ['layers']);
  assert.deepEqual(shotPasses([]), []);
});

test('resolveShot: beats become a timeline per character; a bad shot throws before any render', () => {
  const { shot, notes } = resolveShot({
    characters: [{ file: 0, position: [0, 0], beats: [{ animation: 'Walk', to: [3, 0], seconds: 2 }] }, { file: 1, position: [5, 0] }],
  }, 73, 24, 2) as any;
  assert.equal(shot.characters[0].timeline.length, 2); // the walk, then the last clip standing to the end
  assert.equal(shot.characters[1].timeline, undefined, 'no beats, no timeline: the old path');
  assert.ok(Array.isArray(notes));
  assert.throws(() => resolveShot({ characters: [{ file: 7 }] }, 25, 24, 2), /can't be built[\s\S]*file 7/);
  assert.throws(() => resolveShot({ characters: [{ file: 0, attachments: [{ prop: 2 }] }], props: [] }, 25, 24, 2), /prop 2/);
  // A face hidden behind someone doesn't stop a render (the gate judges it).
  assert.doesNotThrow(() => resolveShot({ speaker: 1, characters: [{ file: 0, position: [0, -1.5], height: 1.8, facing: 180 }, { file: 1, position: [0, 0], height: 1.8 }], camera: { target: 1, distance: 4, height: 1.6 } }, 25, 24, 2));
});

test('film shot: beats with a stride-matched walk, a prop held in the hand, PBR floor and wall, muzzle flash and flashlight, DOF, layers, stills', { skip, timeout: 600_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbf-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(`${dir}/in`);
    for (const [script, out, extra] of [['make_rig.py', '0.glb', ['--walk']], ['make_prop.py', '1.glb', []]] as const) {
      spawnSync(blender!, ['-b', '--factory-startup', '-P', path.resolve('test/fixtures', script), '--', `${dir}/in/${out}`, ...extra], { encoding: 'utf8' });
      assert.ok(fs.existsSync(`${dir}/in/${out}`), script);
    }
    // Texture maps: albedo, normal, roughness (flat colors are enough to check the wiring).
    ['red', 'blue', 'gray'].forEach((c, i) => spawnSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=16x16`, '-frames:v', '1', `${dir}/in/${i + 2}.png`]));
    fs.copyFileSync('post/blender/hawkes_blender.py', `${dir}/hawkes_blender.py`);
    fs.copyFileSync('post/pose_draw.py', `${dir}/pose_draw.py`);
    const frames = shotFrames({ frames: 25 });
    const { shot } = resolveShot({
      characters: [
        {
          file: 0, height: 1.8, position: [-1.5, 0], facing: 90,
          beats: [{ animation: 'Walk', to: [0.5, 0], seconds: 0.5 }, { animation: 'Wave', seconds: 0.5, lookAt: 1 }],
          attachments: [{ prop: 0, bone: 'right hand', grip: [0.5, 0.5, 0.25] }],
        },
        { file: 0, height: 1.7, position: [2.5, 0.5], facing: -90, animation: 'Wave' },
      ],
      props: [{ file: 1, size: 0.8 }],
      ground: { size: 20, material: { albedo: 2, normal: 3, roughness: 4, tile: 2 } },
      walls: [{ from: [-6, 4], to: [6, 4], height: 3, material: { albedo: 2, tile: 1.5 } }],
      vfx: [
        { type: 'muzzle-flash', attach: { prop: 0, offset: [0, 0, 0.5] }, at: 0.5, seconds: 0.1 },
        { type: 'flashlight', attach: { character: 1, bone: 'head' }, target: { character: 0 }, angle: 30, from: 0.25 },
      ],
      camera: { move: 'orbit', amount: 20, target: [0.5, 0.5, 1], distance: 9, height: 1.5, lens: 28, dof: { fstop: 2.8 } },
    }, frames, 24, 5) as any;
    fs.writeFileSync(`${dir}/spec.json`, JSON.stringify({
      out: `${dir}/out`, files: [0, 1, 2, 3, 4].map((i) => `${dir}/in/${i}.${i < 2 ? 'glb' : 'png'}`), frames, fps: 24, width: 320, height: 192, engine: 'workbench', device: 'cpu',
      passes: ['beauty', 'depth', 'normal', 'mask', 'layers'], stills: [0, 0.33, 0.66, 1], save: true, shot,
    }));
    const py = path.resolve(python!).replace(/\\/g, '/');
    fs.writeFileSync(`${dir}/run.sh`, renderScript({ blend: null, zip: null, fps: 24, frames, edges: false }, { blender: blender!, python: py, python3: py, ffmpeg: ffmpeg! }));
    const r = spawnSync(bash!, ['run.sh'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').filter((l) => !/^(Fra:|HB frame|\d\d:\d\d)/.test(l)).slice(-30).join('\n'));

    for (const f of ['beauty.mp4', 'depth.mp4', 'normal.mp4', 'mask.mp4', 'layer0.mp4', 'layer1.mp4', 'stills/01.png', 'stills/04.png', 'shot.blend']) assert.ok(fs.existsSync(`${dir}/res/${f}`), f);
    const info = JSON.parse(fs.readFileSync(`${dir}/res/info.json`, 'utf8'));
    // The walk's clip speed was matched to the ground speed: the planted foot keeps pace (no sliding).
    const seg = info.characters[0].segments[0];
    assert.equal(seg.animation, 'Walk');
    assert.ok(Math.abs(seg.slide - 1) < 0.05, JSON.stringify(seg));
    assert.ok(seg.playback !== 1 && seg.playback > 0.3, JSON.stringify(seg));
    assert.equal(info.characters[0].attachments[0].bone, 'rig:RightHand');
    // The stills say where everyone stands: character 0 walked 2 m along +X, and turned toward character 1.
    assert.equal(info.stills.length, 4);
    const [a, d] = [info.stills[0].characters[0], info.stills[3].characters[0]];
    assert.ok(Math.abs(a.x - -1.5) < 0.05 && Math.abs(d.x - 0.5) < 0.05, `x ${a.x} -> ${d.x}`);
    assert.ok(Math.abs(a.facing - 90) < 1, `${a.facing}`);
    assert.ok(Math.abs(d.facing - 90) < 20 && d.facing !== a.facing, `${d.facing}`);
    // Each character alone on its layer: both matter, and they don't overlap.
    const frame = (n: string) => spawnSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${dir}/res/${n}.mp4`, '-frames:v', '1', `${dir}/${n}.png`]);
    frame('layer0'); frame('layer1');
    const both = spawnSync(py, ['-I', '-c', `
from PIL import Image
a = Image.open("${dir}/layer0.png").convert("L"); b = Image.open("${dir}/layer1.png").convert("L")
A = {p for p, v in enumerate(a.get_flattened_data() if hasattr(a, 'get_flattened_data') else a.getdata()) if v > 128}; B = {p for p, v in enumerate(b.get_flattened_data() if hasattr(b, 'get_flattened_data') else b.getdata()) if v > 128}
print(len(A), len(B), len(A & B))`], { encoding: 'utf8' });
    const [na, nb, nab] = both.stdout.trim().split(' ').map(Number);
    assert.ok(na > 50 && nb > 50 && nab === 0, both.stdout + both.stderr);

    const chk = spawnSync(blender!, ['-b', `${dir}/res/shot.blend`, '--factory-startup', '-P', path.resolve('test/fixtures/check_film.py')], { encoding: 'utf8' });
    const line = chk.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, chk.stdout.slice(-1500) + chk.stderr.slice(-1500));
    const res = JSON.parse(line.slice(7));
    assert.ok(res.held.every((x: number) => x < 0.02), `the prop stays on the palm: ${res.held}`);
    assert.ok(res.inside.every(Boolean), 'the palm is inside the prop');
    assert.deepEqual(res.mover.map((m: number[]) => m[1]), [-1.5, -0.5, 0.5, 0.5, 0.5].map((x) => x), JSON.stringify(res.mover));
    // The muzzle flash fires at 0.5 s (frame 13) for a tenth of a second, and not before or after.
    const energy = Object.fromEntries(res.energy);
    assert.ok(energy[13] > 100 && energy[1] === 0 && energy[25] === 0, JSON.stringify(res.energy));
    assert.deepEqual(res.ground, { images: 3, normalMap: true, colorspaces: ['Non-Color', 'Non-Color', 'sRGB'], uvMax: 10 });
    assert.deepEqual(res.dof, [true, 2.8]);
    assert.equal(res.beam, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
