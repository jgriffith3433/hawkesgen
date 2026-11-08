import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pickMotionWindows, motionMarks, parseFreezes, hitchesOf, motionLegend, motionStrips, videoFreezes, MOTION_SECONDS } from '../src/tools/playtest-motion.ts';

test('pickMotionWindows puts flag windows first, never overlaps and fills the rest evenly', () => {
  const w = pickMotionWindows([
    { t: 10, reason: 'scene', priority: 3 },
    { t: 30, reason: 'feel:camera-snap', priority: 0 },
    { t: 30.3, reason: 'feel:jitter', priority: 1 },
    { t: 55, reason: 'problem', priority: 1 },
  ], 60, { max: 6 });
  assert.equal(w.length, 6);
  for (let i = 1; i < w.length; i++) assert.ok(w[i].start >= w[i - 1].end, 'no overlap');
  assert.ok(w.some((x) => x.reason === 'feel:camera-snap' && x.start <= 30 && x.end >= 30), 'the snap is inside a window');
  assert.ok(!w.some((x) => x.reason === 'feel:jitter'), 'a mark inside a picked window is not watched twice');
  assert.ok(w.filter((x) => x.reason === 'play').length >= 2, 'ordinary play is watched too');
  for (const x of w) assert.ok(Math.abs(x.end - x.start - MOTION_SECONDS) < 0.01 && x.end <= 60);
});

test('pickMotionWindows: nothing for a run shorter than a window or max 0', () => {
  assert.deepEqual(pickMotionWindows([{ t: 0.5, reason: 'problem', priority: 1 }], 1), []);
  assert.deepEqual(pickMotionWindows([], 60, { max: 0 }), []);
});

test('motionMarks: bug flags first, problems, then scenes', () => {
  const m = motionMarks({ feel: [{ kind: 'stuck', severity: 'bug', t: 5, rt: 7 }, { kind: 'hitch', severity: 'polish', t: 9 }] }, [{ meta: { reason: 'problem', t: 3 } }, { meta: { reason: 'scene', t: 1, scene: 'Town' } }, { meta: { reason: 'interval', t: 2 } }]);
  assert.equal(m.length, 4);
  assert.equal(m.find((x) => x.reason === 'feel:stuck')!.priority, 0);
  assert.equal(m.find((x) => x.reason === 'feel:hitch')!.t, 11, 'shifted by the first flag\'s offset');
  assert.equal(m.find((x) => x.reason === 'scene')!.scene, 'Town');
});

test('parseFreezes and hitchesOf keep short freezes only', () => {
  const log = 'frame:1\nlavfi.freezedetect.freeze_start=1.96667\nlavfi.freezedetect.freeze_duration=0.433333\nlavfi.freezedetect.freeze_end=2.4\nlavfi.freezedetect.freeze_start=5\nlavfi.freezedetect.freeze_duration=3\nlavfi.freezedetect.freeze_start=9\n';
  const f = parseFreezes(log);
  assert.deepEqual(f, [{ t: 1.97, seconds: 0.43 }, { t: 5, seconds: 3 }]);
  assert.deepEqual(hitchesOf(f), [{ t: 1.97, ms: 430 }]);
});

test('motionLegend numbers the sheets after the stills', () => {
  const l = motionLegend([{ start: 1, end: 2.2, t: 1.8, reason: 'feel:camera-snap', scene: 'Town' }], 16);
  assert.match(l, /\[16\] 1s to 2.2s around feel:camera-snap/);
  assert.equal(motionLegend([], 3), '');
});

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('motionStrips and videoFreezes on a real video with a stall', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
  const mp4 = path.join(dir, 'v.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
    '-filter_complex', '[0]tpad=stop_mode=clone:stop_duration=0.4[a];[a][1]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
  const ctx: any = { signal: new AbortController().signal, tmp: (n: string) => path.join(dir, n), log: () => {} };
  const strips = await motionStrips(ctx, mp4, [{ start: 1, end: 2.2, t: 1.8, reason: 'play' }]);
  assert.equal(strips.length, 1);
  assert.ok(fs.statSync(strips[0].file).size > 1000);
  const fr = await videoFreezes(ctx, mp4);
  assert.ok(fr && fr.hitches.length === 1 && fr.hitches[0].ms >= 300 && fr.hitches[0].ms < 600, JSON.stringify(fr));
  fs.rmSync(dir, { recursive: true, force: true });
});
