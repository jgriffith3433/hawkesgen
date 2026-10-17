// Playtest helpers that need no browser: the hard time limit every await gets, and the screenshot diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { within, settleReview } from '../src/tools/playtest.ts';

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

test('screencast: the encode on the recording machine (through ssh) makes the same 30 fps mp4', { skip: (!hasFfmpeg || process.platform === 'win32') && 'no ffmpeg or bash' }, async () => {
  const { FrameClock, remoteEncodeScript } = await import('../src/tools/screencast.ts');
  const { encodeRemotely } = await import('../src/tools/playtest.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-encode-'));
  assert.equal(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=green:s=640x400', '-frames:v', '1', path.join(dir, 'f.jpg')]).status, 0);
  const chunks: Buffer[] = [];
  const clock = new FrameClock(30, (f) => chunks.push(f));
  clock.push(fs.readFileSync(path.join(dir, 'f.jpg')), 1000);
  clock.end(1002);
  fs.writeFileSync(path.join(dir, 's.mjpeg'), Buffer.concat(chunks));
  // A stand-in ssh that runs the command here, the way the remote shell would.
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'ssh'), '#!/bin/bash\nexec bash -c "${@: -1}"\n', { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${path.join(dir, 'bin')}:${PATH}`;
  try {
    const out = path.join(dir, 's.mp4');
    const encoder = await encodeRemotely({ args: ['-i', 'key'], dest: 'ubuntu@host' }, remoteEncodeScript({ width: 1280, height: 721 }), path.join(dir, 's.mjpeg'), out, AbortSignal.timeout(60_000));
    assert.match(encoder, /^(libx264|h264_nvenc)$/);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_frames', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    assert.equal(probe.stdout.trim(), 'h264,1280,722,30/1,60');
    // A failing encode rejects (the caller then encodes here).
    await assert.rejects(encodeRemotely({ args: [], dest: 'x' }, 'echo broken >&2; exit 5', path.join(dir, 's.mjpeg'), path.join(dir, 'bad.mp4'), AbortSignal.timeout(60_000)), /broken/);
  } finally {
    process.env.PATH = PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settleReview: worst first, polish only without bugs, capped, mode-limited, known ids only', () => {
  const f = (severity: string, title: string, regression = false) => ({ severity, title, regression });
  const r = settleReview({ verdict: 'fix-first', findings: [f('polish', 'p1'), f('bug', 'b1'), f('idea', 'i1'), f('bug', 'b2'), f('blocker', 'x1')], known: [{ id: 'f_1', status: 'fixed' }, { id: 'f_nope', status: 'present' }] }, { maxFindings: 2, known: [{ id: 'f_1', title: 't' }] });
  assert.deepEqual(r.findings.map((x: any) => x.title), ['x1', 'b1']);
  assert.equal(r.trimmed, 3);
  assert.deepEqual(r.known.map((k: any) => k.id), ['f_1']);
  const polish = settleReview({ verdict: 'fix-first', findings: [f('idea', 'i1'), f('polish', 'p1')] }, {});
  assert.deepEqual(polish.findings.map((x: any) => x.title), ['p1', 'i1']);
  const verify = settleReview({ verdict: 'fix-first', findings: [f('bug', 'old'), f('bug', 'worse', true), f('polish', 'p', true)] }, { mode: 'verify' });
  assert.deepEqual(verify.findings.map((x: any) => x.title), ['worse']);
  const ship = settleReview({ verdict: 'ship', findings: [f('bug', 'a'), f('bug', 'b'), f('bug', 'c')] }, {});
  assert.equal(ship.findings.length, 2);
  const shipBlocked = settleReview({ verdict: 'ship', findings: [f('blocker', 'a')] }, {});
  assert.equal(shipBlocked.verdict, 'fix-first');
  assert.deepEqual(settleReview({ verdict: 'ship', findings: [] }, {}).findings, []);
});

test('settleCriteria: one answer per criterion, in order, unclear when skipped', async () => {
  const { settleCriteria } = await import('../src/tools/playtest.ts');
  const r = settleCriteria({ criteria: [{ criterion: 'B shows', met: 'no', evidence: 'frame 3' }, { criterion: 'A shows', met: 'yes', evidence: 'frame 1' }] }, ['A shows', 'B shows', 'C shows']);
  assert.deepEqual(r.criteria.map((c: any) => c.met), ['yes', 'no', 'unclear']);
  assert.equal(settleCriteria({ criteria: [{ met: 'yes' }] }, []).criteria, undefined);
});
