// Transition ops (applyOps) and the per-frame preview maths (src/transitions.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, newDoc, clipEnd } from '../src/timeline.ts';
import {
  clampTransitionSeconds, sampleTransition, precomputeTransition, sampleAt, TRANSITION_MIN, TRANSITION_MAX,
} from '../src/transitions.ts';

test('clampTransitionSeconds stays in 0.2–2', () => {
  assert.equal(clampTransitionSeconds(0.05), TRANSITION_MIN);
  assert.equal(clampTransitionSeconds(9), TRANSITION_MAX);
  assert.equal(clampTransitionSeconds(1.25), 1.25);
  assert.equal(clampTransitionSeconds('nope', 0.5), 0.5);
});

test('sampleTransition: crossfade alphas sum to ~1', () => {
  for (const k of [0, 0.25, 0.5, 0.75, 1]) {
    const s = sampleTransition('crossfade', k);
    assert.ok(Math.abs(s.aOut + s.aIn - 1) < 1e-9, `k=${k}`);
    assert.equal(s.fill, null);
  }
});

test('sampleTransition: dip to black peaks at the midpoint', () => {
  const mid = sampleTransition('fadeblack', 0.5);
  assert.equal(mid.fill, '#000');
  assert.ok(mid.fillA > 0.99);
  assert.ok(mid.aOut < 0.01);
  assert.ok(mid.aIn < 0.01);
  const early = sampleTransition('fadeblack', 0.25);
  assert.ok(early.aOut > 0.4 && early.fillA > 0.4);
  const late = sampleTransition('fadewhite', 0.75);
  assert.equal(late.fill, '#fff');
  assert.ok(late.aIn > 0.4 && late.fillA > 0.4);
});

test('sampleTransition: slide and push move the incoming from the right', () => {
  const slide = sampleTransition('slideleft', 0.5);
  assert.ok(slide.oxIn > 0.4 && slide.oxIn < 0.6);
  assert.ok(slide.clipIn && Math.abs(slide.clipIn.w - 0.5) < 1e-9);
  const push = sampleTransition('push', 0.5);
  assert.ok(push.oxOut < -0.4);
  assert.ok(push.oxIn > 0.4);
});

test('precomputeTransition + sampleAt: middle frame is the midpoint sample', () => {
  const table = precomputeTransition('crossfade', 1, 10);
  assert.equal(table.length, 10);
  const mid = sampleAt(table, 4.55, 5, 1); // join at 5 s, 1 s long → mid ~4.5
  assert.ok(mid);
  assert.ok(Math.abs(mid!.aOut - 0.5) < 0.1);
  assert.equal(sampleAt(table, 3.5, 5, 1), null, 'before the join window');
  assert.equal(sampleAt(table, 5.1, 5, 1), null, 'after the join');
});

test('applyOps transition: add, resize, remove on adjacent main-track clips', () => {
  let d = newDoc('xf', 'video');
  ({ doc: d } = applyOps(d, [
    { op: 'add', asset: 'a_1', kind: 'video', track: 'V1', start: 0, duration: 3 },
    { op: 'add', asset: 'a_2', kind: 'video', track: 'V1', start: 3, duration: 3 },
  ]));
  const a = d.clips.find((c) => c.asset === 'a_1')!;
  assert.equal(clipEnd(a), 3);

  let r = applyOps(d, [{ op: 'transition', id: a.id, type: 'crossfade', seconds: 0.8 }]);
  assert.equal(r.results[0]!.ok, true);
  d = r.doc;
  const withXf = d.clips.find((c) => c.id === a.id)!;
  assert.equal(withXf.transition, 'crossfade');
  assert.equal(withXf.transitionSeconds, 0.8);

  r = applyOps(d, [{ op: 'transition', id: a.id, type: 'fadeblack', seconds: 0.1 }]);
  d = r.doc;
  assert.equal(d.clips.find((c) => c.id === a.id)!.transition, 'fadeblack');
  assert.equal(d.clips.find((c) => c.id === a.id)!.transitionSeconds, 0.2, 'clamped up to 0.2');

  r = applyOps(d, [{ op: 'transition', id: a.id, type: null }]);
  d = r.doc;
  assert.equal(d.clips.find((c) => c.id === a.id)!.transition, undefined);
  assert.equal(r.results[0]!.ok, true);
});

test('applyOps transition: refuses a gap, a bad type, and a non-video track', () => {
  let d = newDoc('xf', 'video');
  ({ doc: d } = applyOps(d, [
    { op: 'add', asset: 'a_1', kind: 'video', track: 'V1', start: 0, duration: 2 },
    { op: 'add', asset: 'a_2', kind: 'video', track: 'V1', start: 3, duration: 2 },
    { op: 'add', kind: 'fill', color: '#112233', track: 'T1', start: 0, seconds: 2 },
    { op: 'add', kind: 'fill', color: '#332211', track: 'T1', start: 2, seconds: 2 },
  ]));
  const gap = d.clips.find((c) => c.asset === 'a_1')!;
  const textTrack = d.clips.find((c) => c.color === '#112233')!;
  assert.equal(applyOps(d, [{ op: 'transition', id: gap.id, type: 'crossfade' }]).results[0]!.ok, false);
  assert.equal(applyOps(d, [{ op: 'transition', id: textTrack.id, type: 'crossfade' }]).results[0]!.ok, false);

  ({ doc: d } = applyOps(d, [{ op: 'move', id: gap.id, start: 0 }, { op: 'move', id: d.clips.find((c) => c.asset === 'a_2')!.id, start: 2 }]));
  const a = d.clips.find((c) => c.asset === 'a_1')!;
  assert.equal(applyOps(d, [{ op: 'transition', id: a.id, type: 'spin' }]).results[0]!.ok, false);
});

test('applyOps set still clears a transition with cut/null and clamps seconds', () => {
  let d = newDoc('xf', 'video');
  ({ doc: d } = applyOps(d, [
    { op: 'add', asset: 'a_1', kind: 'video', track: 'V1', start: 0, duration: 4 },
    { op: 'add', asset: 'a_2', kind: 'video', track: 'V1', start: 4, duration: 4 },
  ]));
  const id = d.clips.find((c) => c.asset === 'a_1')!.id;
  ({ doc: d } = applyOps(d, [{ op: 'set', id, transition: 'push', transitionSeconds: 3 }]));
  assert.equal(d.clips.find((c) => c.id === id)!.transition, 'push');
  assert.equal(d.clips.find((c) => c.id === id)!.transitionSeconds, 2);
  ({ doc: d } = applyOps(d, [{ op: 'set', id, transition: 'cut' }]));
  assert.equal(d.clips.find((c) => c.id === id)!.transition, undefined);
});
