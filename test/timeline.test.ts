// The timeline under video, image and audio scenes (src/timeline.ts): old documents converted on read, any clip on any
// track, magnetic tracks, placement on the frame, track edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, applyOps, docLength, clipLength, newDoc } from '../src/timeline.ts';

test('version 1 video documents keep their clips and get the tracks, top first', () => {
  const d = normalize({ v: 1, title: 'Old', clips: [{ id: 'c_aaa', track: 'V1', kind: 'video', asset: 'a_1', in: 0, out: 4, duration: 4 }, { id: 'c_bbb', track: 'T1', text: 'Hi', start: 1, out: 2 }, { track: 'A1', kind: 'audio', asset: 'a_2', out: 3 }] });
  assert.equal(d.v, 2);
  assert.deepEqual(d.tracks.map((t) => t.id), ['T1', 'V1', 'A1', 'A2', 'A3']);
  assert.equal(d.tracks[1].magnetic, undefined, 'clips go anywhere in time unless a track is made magnetic');
  assert.equal(d.clips.length, 3);
  assert.equal(d.clips.find((c) => c.id === 'c_bbb')!.kind, 'text');
});

test('the first image documents become tracks of clips placed by shares of the frame', () => {
  const d = normalize({ title: 'Poster', width: 1000, height: 500, background: '#112233', layers: [
    { id: 'l_bg', name: 'Back', asset: 'a_1234abcd', x: 500, y: 250, w: null },
    { id: 'l_t', name: 'Title', type: 'text', text: 'NIGHT', x: 250, y: 100, size: 50, color: '#FF0000' },
  ] }, 'image');
  assert.deepEqual(d.tracks.map((t) => t.name), ['Title', 'Back'], 'the top layer is the top track');
  const t = d.clips.find((c) => c.kind === 'text')!;
  assert.equal(t.x, 0.25);
  assert.equal(t.y, 0.2);
  assert.equal(t.size, 0.1);
  assert.equal(t.color, '#ff0000');
  const bg = d.clips.find((c) => c.kind === 'image')!;
  assert.equal(bg.x, undefined, 'centered is the default');
  assert.equal(d.background, '#112233');
});

test('the first audio documents keep their mix and their clips', () => {
  const d = normalize({ title: 'Mix', bpm: 90, tracks: [{ id: 't_music', name: 'Music', volume: 0.5, pan: -0.5, mute: true, clips: [{ asset: 'a_1', start: 2, in: 1, out: 5, gain: 2, fadeIn: 1 }] }] }, 'audio');
  assert.equal(d.bpm, 90);
  assert.equal(d.tracks[0].volume, 0.5);
  assert.equal(d.tracks[0].mute, true);
  assert.equal(d.clips[0].track, 't_music');
  assert.equal(d.clips[0].volume, 2);
  assert.equal(d.clips[0].fadeIn, 1);
  assert.equal(d.clips[0].start, 2);
});

test('any clip goes on any track; a magnetic track lays its clips back to back', () => {
  let d = newDoc('x', 'video');
  ({ doc: d } = applyOps(d, [
    { op: 'track', id: 'V1', set: { magnetic: true } },
    { op: 'add', asset: 'a_1', kind: 'video', duration: 4 },
    { op: 'add', asset: 'a_2', kind: 'image', seconds: 2 },
    { op: 'add', asset: 'a_3', kind: 'image', track: 'T1', start: 1, seconds: 3, x: 0.8, y: 0.2, w: 0.25, opacity: 0.5 },
    { op: 'add', kind: 'fill', color: '#000000', track: 'A2', start: 0, seconds: 1 },
  ]));
  const v1 = d.clips.filter((c) => c.track === 'V1');
  assert.deepEqual(v1.map((c) => c.start), [0, 4]);
  const over = d.clips.find((c) => c.asset === 'a_3')!;
  assert.equal(over.track, 'T1');
  assert.equal(over.w, 0.25);
  assert.equal(over.opacity, 0.5);
  assert.equal(clipLength(over), 3);
  assert.ok(d.clips.some((c) => c.kind === 'fill' && c.track === 'A2'));
  assert.equal(docLength(d), 6);
});

test('track edits: add, set, remove (with its clips)', () => {
  let d = newDoc('x', 'image');
  const r = applyOps(d, [{ op: 'track', add: { name: 'Glow', at: 0 } }]);
  d = r.doc;
  const id = r.results[0].id!;
  assert.equal(d.tracks[0].name, 'Glow');
  ({ doc: d } = applyOps(d, [{ op: 'add', asset: 'a_9', kind: 'image', track: id, seconds: 5 }, { op: 'track', id, set: { hidden: true, opacity: 3 } }], undefined, 'image'));
  assert.equal(d.tracks[0].hidden, true);
  ({ doc: d } = applyOps(d, [{ op: 'track', remove: id }], undefined, 'image'));
  assert.equal(d.tracks.length, 3);
  assert.equal(d.clips.length, 0);
});

test('moving a clip between tracks and splitting a picture', () => {
  let d = newDoc('x', 'video');
  ({ doc: d } = applyOps(d, [{ op: 'add', asset: 'a_1', kind: 'image', track: 'A1', start: 2, seconds: 4 }]));
  const id = d.clips[0].id;
  ({ doc: d } = applyOps(d, [{ op: 'move', id, track: 'T1', start: 1 }, { op: 'split', id, at: 2 }]));
  const parts = d.clips.filter((c) => c.track === 'T1');
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((c) => [c.start, clipLength(c)]), [[1, 1], [2, 3]]);
});
