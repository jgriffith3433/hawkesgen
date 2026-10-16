// Playtest helpers that need no browser: the hard time limit every await gets, and the screenshot diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { within } from '../src/tools/playtest.ts';

test('within: passes a result through, and rejects as stuck past the limit', async () => {
  assert.equal(await within(Promise.resolve(7), 1000, 'quick'), 7);
  const t = Date.now();
  await assert.rejects(within(new Promise(() => {}), 50, 'the page'), (e: any) => e.name === 'Stuck' && /the page hung/.test(e.message));
  assert.ok(Date.now() - t < 1000);
});

const python = [path.join('.venv', 'Scripts', 'python.exe'), path.join('.venv', 'bin', 'python')].find((p) => fs.existsSync(p));

test('visdiff.py: the same screenshot scores 0, a different one scores high', { skip: !python && 'no .venv' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visdiff-'));
  const make = `from PIL import Image, ImageDraw
a = Image.new('RGB', (640, 360), (30, 40, 60)); ImageDraw.Draw(a).rectangle([100, 100, 300, 250], fill=(220, 200, 40)); a.save(r'${dir}/a.jpg')
b = Image.new('RGB', (640, 360), (200, 60, 60)); ImageDraw.Draw(b).ellipse([300, 50, 600, 330], fill=(20, 20, 20)); b.save(r'${dir}/b.jpg')`;
  assert.equal(spawnSync(python!, ['-I', '-c', make]).status, 0);
  fs.writeFileSync(path.join(dir, 'pairs.json'), JSON.stringify([{ a: path.join(dir, 'a.jpg'), b: path.join(dir, 'a.jpg') }, { a: path.join(dir, 'a.jpg'), b: path.join(dir, 'b.jpg') }]));
  const r = spawnSync(python!, ['-I', path.join('post', 'visdiff.py'), path.join(dir, 'pairs.json'), path.join(dir, 'out')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [same, other] = JSON.parse(r.stdout);
  assert.equal(same.score, 0);
  assert.ok(other.score > 0.25, `score ${other.score}`);
  assert.ok(fs.statSync(other.diff).size > 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('FrameClock: holds each frame for the ticks it was on screen, at a constant rate', async () => {
  const { FrameClock } = await import('../src/tools/screencast.ts');
  const out: string[] = [];
  const clock = new FrameClock(10, (f) => out.push(f.toString()));
  clock.push(Buffer.from('a'), 100);
  clock.push(Buffer.from('b'), 100.25); // a was up for 0.25 s: ticks 100.0, 100.1, 100.2
  clock.push(Buffer.from('c'), 100.26); // b was replaced before the next tick (100.3): never written
  clock.end(100.5);
  assert.deepEqual(out, ['a', 'a', 'a', 'c', 'c']);
  assert.equal(clock.frames, 3);
  assert.equal(clock.written, 5);
  // A long freeze is filled with the last frame, up to a cap, and the clock carries on.
  const long = new FrameClock(1, () => {});
  long.push(Buffer.from('x'), 0);
  long.push(Buffer.from('y'), 10_000);
  assert.equal(long.written, 600);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('screencast: an MJPEG stream from the clock becomes a 30 fps mp4 at the viewport size', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const { FrameClock, mjpegToMp4Args } = await import('../src/tools/screencast.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screencast-'));
  // Two different frames, a size that isn't the viewport's (the mp4 is scaled and padded to it).
  for (const [i, color] of ['red', 'blue'].entries()) {
    assert.equal(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=${color}:s=640x400`, '-frames:v', '1', path.join(dir, `${i}.jpg`)]).status, 0);
  }
  const frames = [0, 1].map((i) => fs.readFileSync(path.join(dir, `${i}.jpg`)));
  const chunks: Buffer[] = [];
  const clock = new FrameClock(30, (f) => chunks.push(f));
  clock.push(frames[0], 1000);
  clock.push(frames[1], 1001);
  clock.end(1002);
  fs.writeFileSync(path.join(dir, 's.mjpeg'), Buffer.concat(chunks));
  const out = path.join(dir, 's.mp4');
  const r = spawnSync('ffmpeg', mjpegToMp4Args(path.join(dir, 's.mjpeg'), out, { width: 1280, height: 721 }), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), '1280,722,30/1,60');
  fs.rmSync(dir, { recursive: true, force: true });
});
