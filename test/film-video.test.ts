// video.matte, video.composite and video.control-mix: the filter graphs, run for real on synthetic clips with ffmpeg (free,
// offline). Where ffmpeg or the .venv (Pillow, to read pixels) is missing the runs skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { matteFilter, compositeFilter, mixFilter } from '../src/tools/film-video.ts';

test('filter graphs: matte, composite and mix wire every input and keep the protected matte out of the glow', () => {
  const m = matteFilter(320, 192, { grow: 8, feather: 4, fps: 24 });
  assert.match(m, /\[1:v\]scale=320:192/);
  assert.match(m, /blend=all_mode=multiply/);
  const c = compositeFilter(320, 192, 24, { hasProtect: true, glow: 0.6, bloom: 20 });
  for (const i of ['0:v', '1:v', '2:v', '3:v']) assert.ok(c.includes(`[${i}]`), i);
  assert.match(c, /maskedmerge/);
  assert.match(c, /\[bloom0\]\[pkeep\]blend=all_mode=multiply\[bloom\]/, 'the protected area keeps the glow off');
  const plain = compositeFilter(320, 192, 24, { hasProtect: false, glow: 0 });
  assert.ok(!plain.includes('3:v') && !plain.includes('bloom'));
  assert.match(mixFilter(3, 320, 192, 24, { weights: [1, 0.5, 0.25] }), /lutrgb=r='val\*0\.5'/);
  assert.throws(() => mixFilter(2, 64, 64, 24, { mode: 'multiply' }), /lighten, screen or average/);
});

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null;
const python = [path.join('.venv', 'bin', 'python'), path.join('.venv', 'Scripts', 'python.exe')].find((p) => fs.existsSync(p));
const skip = !ffmpeg ? 'no ffmpeg' : !python ? 'no .venv' : false;

/** A clip of one flat color, with white boxes drawn on it (for mattes). */
function clip(file: string, color: string, boxes: [number, number, number, number][] = [], frames = 6) {
  const vf = boxes.map(([x, y, w, h]) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=white:t=fill`).join(',') || 'null';
  const r = spawnSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=160x96:r=12:d=${frames / 12}`, '-vf', `${vf},format=yuv420p`, '-c:v', 'libx264', '-crf', '8', file]);
  assert.equal(r.status, 0, String(r.stderr));
}
function pixels(dir: string, file: string, points: [number, number][]): number[][] {
  const png = path.join(dir, `${path.basename(file)}.png`);
  spawnSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', 'select=eq(n\\,2)', '-frames:v', '1', png]);
  const r = spawnSync(path.resolve(python!), ['-I', '-c', `
from PIL import Image
im = Image.open(${JSON.stringify(png)}).convert("RGB")
print(";".join(",".join(map(str, im.getpixel((x, y)))) for x, y in ${JSON.stringify(points)}))`], { encoding: 'utf8' });
  return r.stdout.trim().split(';').map((s) => s.split(',').map(Number));
}
const frameCount = (dir: string, f: string) => Number(spawnSync(ffmpeg!.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());
const sh = (cmd: string[]) => { const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };

test('video.matte: the video stays inside the matte and is black outside', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbm-'));
  try {
    clip(`${dir}/depth.mp4`, 'gray');
    clip(`${dir}/matte.mp4`, 'black', [[20, 20, 40, 40]]);
    fs.writeFileSync(`${dir}/g.filter`, matteFilter(160, 96, { grow: 0, feather: 0, fps: 12 }));
    sh([ffmpeg!, '-hide_banner', '-loglevel', 'error', '-y', '-i', `${dir}/depth.mp4`, '-i', `${dir}/matte.mp4`, '-filter_complex_script', `${dir}/g.filter`, '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${dir}/out.mp4`]);
    const [inside, outside] = pixels(dir, `${dir}/out.mp4`, [[40, 40], [120, 70]]);
    assert.ok(inside[0] > 100 && inside[0] < 160, `inside keeps the gray: ${inside}`);
    assert.ok(outside[0] < 20, `outside is black: ${outside}`);
    assert.equal(frameCount(dir, `${dir}/out.mp4`), 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('video.composite: the effect shows inside its matte (and a margin), glows, and never touches the protected character', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbc-'));
  try {
    clip(`${dir}/base.mp4`, '0x2040c0');
    clip(`${dir}/fx.mp4`, '0xff2000');
    clip(`${dir}/a.mp4`, 'black', [[20, 28, 40, 40]]);
    clip(`${dir}/b.mp4`, 'black', [[78, 28, 40, 40]]); // the other character, 18 px from A
    fs.writeFileSync(`${dir}/g.filter`, compositeFilter(160, 96, 12, { grow: 6, feather: 2, glow: 0.8, bloom: 8, hasProtect: true }));
    sh([ffmpeg!, '-hide_banner', '-loglevel', 'error', '-y', '-i', `${dir}/base.mp4`, '-i', `${dir}/fx.mp4`, '-i', `${dir}/a.mp4`, '-i', `${dir}/b.mp4`, '-filter_complex_script', `${dir}/g.filter`, '-map', '[out]', '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', `${dir}/out.mp4`]);
    const [inA, farAway, inB, nextToB, nearA] = pixels(dir, `${dir}/out.mp4`, [[40, 48], [150, 10], [98, 48], [80, 48], [16, 48]]);
    const red = (p: number[]) => p[0] > 170 && p[2] < 140;
    const blue = (p: number[]) => p[2] > 140 && p[0] < 90;
    assert.ok(red(inA), `the effect covers A: ${inA}`);
    assert.ok(blue(farAway), `far from both it is the base: ${farAway}`);
    assert.ok(blue(inB), `B is untouched: ${inB}`);
    assert.ok(blue(nextToB), `no effect or glow on B's edge: ${nextToB}`);
    assert.ok(nearA[0] > 90, `the glow and margin reach past A's body: ${nearA}`);
    assert.equal(frameCount(dir, `${dir}/out.mp4`), 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('video.control-mix: the brightest control wins at each pixel; weights dim one', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbx-'));
  try {
    clip(`${dir}/depth.mp4`, '0x404040');
    clip(`${dir}/pose.mp4`, 'black', [[20, 20, 30, 30]]);
    clip(`${dir}/edges.mp4`, 'black', [[90, 20, 30, 30]]);
    fs.writeFileSync(`${dir}/g.filter`, mixFilter(3, 160, 96, 12, { weights: [1, 1, 0.5] }));
    sh([ffmpeg!, '-hide_banner', '-loglevel', 'error', '-y', ...['depth', 'pose', 'edges'].flatMap((n) => ['-i', `${dir}/${n}.mp4`]), '-filter_complex_script', `${dir}/g.filter`, '-map', '[out]', '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', `${dir}/out.mp4`]);
    const [pose, edges, depth] = pixels(dir, `${dir}/out.mp4`, [[30, 30], [100, 30], [5, 80]]);
    assert.ok(pose[0] > 220, `pose line: ${pose}`);
    assert.ok(edges[0] > 100 && edges[0] < 150, `edges at half weight: ${edges}`);
    assert.ok(depth[0] > 40 && depth[0] < 90, `depth underneath: ${depth}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
