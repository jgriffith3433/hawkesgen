// blender.render: the frame and pass rules, and (where Blender is installed) the whole render script run here
// exactly as a GPU server runs it: a rigged character built in Blender, a 9-frame shot, then the pose drawing and
// the videos. CI has no Blender, so that part skips there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shotFrames, shotPasses, renderScript } from '../src/tools/blender.ts';

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

const blender = [process.env.BLENDER, 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe', '/opt/blender/blender', '/usr/bin/blender']
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
