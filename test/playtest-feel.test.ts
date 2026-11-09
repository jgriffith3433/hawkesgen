import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFlag, FeelLog, rankFlags, flagTime, pickPolishFrames, feelBrief } from '../src/tools/playtest-feel.ts';

test('cleanFlag keeps known fields, bounds them and builds the replay spot', () => {
  const f = cleanFlag({ id: 'feel-1', kind: 'below-ground', severity: 'bug', t: 12.345, pos: [1.234, -2, 3], cam: { pos: [0, 2, -4], yaw: 90, pitch: -10 }, seed: 7, scene: 'City', detail: 'x'.repeat(500), count: 3, evil: '<script>' }, 14.2)!;
  assert.equal(f.kind, 'below-ground');
  assert.equal(f.severity, 'bug');
  assert.deepEqual(f.pos, [1.23, -2, 3]);
  assert.equal(f.spot, '1.23,-2,3,90');
  assert.equal(f.seed, 7);
  assert.equal(f.rt, 14.2);
  assert.equal(f.detail.length, 200);
  assert.equal((f as any).evil, undefined);
});

test('cleanFlag refuses junk', () => {
  assert.equal(cleanFlag(null), null);
  assert.equal(cleanFlag({ kind: 'Bad Kind!' }), null);
  assert.equal(cleanFlag({ kind: 'hitch', pos: ['a', 1, 2] })!.pos, null);
  assert.equal(cleanFlag({ kind: 'hitch', severity: 'blocker' })!.severity, 'polish');
});

test('FeelLog takes feel pushes, updates repeats and spaces out screenshots', () => {
  const log = new FeelLog();
  assert.equal(log.push({ type: 'other' }, 1, 0), null);
  const a = log.push({ type: 'feel', flag: { id: 'feel-1', kind: 'camera-snap', t: 1 } }, 1, 10_000);
  assert.ok(a, 'first flag gets a shot');
  assert.equal(log.push({ type: 'feel', flag: { id: 'feel-2', kind: 'hitch', t: 1.2 } }, 1.2, 10_500), null, 'too soon for another shot');
  assert.equal(log.flags.length, 2);
  log.push({ type: 'feel', flag: { id: 'feel-1', kind: 'camera-snap', t: 1, count: 5 } }, 3, 20_000);
  assert.equal(log.flags.length, 2);
  assert.equal(log.flags[0].count, 5);
  log.merge([{ id: 'feel-3', kind: 'stuck', severity: 'bug', t: 9 }, { id: 'feel-2', kind: 'hitch', count: 4 }]);
  assert.equal(log.flags.length, 3);
  assert.equal(log.flags.find((f) => f.id === 'feel-2')!.count, 4);
});

test('rankFlags puts bugs first, then the most frequent', () => {
  const r = rankFlags([
    { id: 'a', kind: 'hitch', severity: 'polish', t: 0, pos: null, detail: '', count: 9 },
    { id: 'b', kind: 'stuck', severity: 'bug', t: 0, pos: null, detail: '', count: 1 },
    { id: 'c', kind: 'camera-snap', severity: 'polish', t: 0, pos: null, detail: '', count: 20 },
  ]);
  assert.deepEqual(r.map((f) => f.id), ['b', 'c', 'a']);
});

test('flagTime uses the arrival time, else shifts page time by the known offset', () => {
  assert.equal(flagTime({ id: 'a', kind: 'k', severity: 'polish', t: 3, pos: null, detail: '', rt: 8 }, 0), 8);
  assert.equal(flagTime({ id: 'a', kind: 'k', severity: 'polish', t: 3, pos: null, detail: '' }, 5), 8);
});

test('pickPolishFrames favours flag shots, then spreads the rest, never the loading frame', () => {
  const shots = [
    { reason: 'loaded' }, { reason: 'ready' }, { reason: 'every' }, { reason: 'feel:camera-snap' }, { reason: 'every' },
    { reason: 'every' }, { reason: 'feel:stuck' }, { reason: 'end' },
  ];
  const picked = pickPolishFrames(shots, 4);
  assert.equal(picked.length, 4);
  assert.ok(picked.some((s) => s.reason === 'feel:camera-snap'));
  assert.ok(picked.some((s) => s.reason === 'feel:stuck'));
  assert.ok(!picked.some((s) => s.reason === 'loaded'));
});

test('feelBrief is empty without flags and lists them with place otherwise', () => {
  assert.equal(feelBrief({}), '');
  const b = feelBrief({ feel: [{ id: 'f', kind: 'below-ground', severity: 'bug', t: 2, rt: 4, pos: [1, -3, 2], scene: 'Docks', detail: 'fell through', count: 2 }], polish: { hits: [{ kind: 'z-fighting', severity: 'polish', where: 'left wall', detail: 'flicker', t: 5, asset: null }] } });
  assert.match(b, /below-ground x2 at t=4s in Docks pos 1,-3,2/);
  assert.match(b, /vision z-fighting/);
});
