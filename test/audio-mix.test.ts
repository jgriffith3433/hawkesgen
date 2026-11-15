// Auto-duck envelope and track roles used by the editor's preview, mixdown and video.compose export.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DUCK_TO, DUCK_DB, trackMixRole, isDialogueTrack, isMusicTrack,
  dialogueSpans, duckFactorAt, shouldDuckClip, composeAudioPlan,
} from '../dashboard/gen/audio-mix.js';

test('DUCK_TO is about −10 dB', () => {
  assert.ok(Math.abs(20 * Math.log10(DUCK_TO) + DUCK_DB) < 0.05);
  assert.ok(DUCK_TO > 0.3 && DUCK_TO < 0.33);
});

test('track roles: Voice is dialogue, Music is music', () => {
  assert.equal(trackMixRole('Voice'), 'dialogue');
  assert.equal(trackMixRole('Dialogue'), 'dialogue');
  assert.equal(trackMixRole('Music'), 'music');
  assert.equal(trackMixRole('Score'), 'music');
  assert.equal(trackMixRole('Sound'), 'other');
  assert.equal(isDialogueTrack({ name: 'Voice' }), true);
  assert.equal(isMusicTrack({ name: 'Music' }), true);
  assert.equal(isMusicTrack({ name: 'Voice' }), false);
});

test('dialogueSpans only keeps sounding clips on audible dialogue tracks', () => {
  const tracks: Record<string, { name: string; mute?: boolean }> = {
    A1: { name: 'Music' },
    A2: { name: 'Voice' },
    A3: { name: 'Sound' },
    A4: { name: 'Voice', mute: true },
  };
  const trackOf = (id: string) => tracks[id];
  const clipEnd = (c: { start: number; out: number; in: number }) => c.start + (c.out - c.in);
  const audible = (id: string) => !tracks[id]?.mute;
  const spans = dialogueSpans([
    { track: 'A1', kind: 'audio', asset: 'a_m', start: 0, in: 0, out: 20 },
    { track: 'A2', kind: 'audio', asset: 'a_v', start: 8, in: 0, out: 4 },
    { track: 'A2', kind: 'audio', asset: 'a_v2', start: 14, in: 0, out: 2, muted: true },
    { track: 'A2', kind: 'audio', asset: 'a_v3', start: 16, in: 0, out: 2, volume: 0 },
    { track: 'A3', kind: 'audio', asset: 'a_s', start: 1, in: 0, out: 2 },
    { track: 'A4', kind: 'audio', asset: 'a_vm', start: 2, in: 0, out: 2 },
  ], trackOf, clipEnd, audible);
  assert.deepEqual(spans, [[8, 12]]);
});

test('duckFactorAt: full level clear of dialogue, ~10 dB under a line, back up after release', () => {
  const spans = [[8, 12]] as [number, number][];
  const open = duckFactorAt(2, spans);
  const under = duckFactorAt(10, spans);
  const after = duckFactorAt(14, spans);
  assert.ok(Math.abs(open - 1) < 1e-9, `open ${open}`);
  assert.ok(Math.abs(under - DUCK_TO) < 0.02, `under ${under}`);
  assert.ok(Math.abs(after - 1) < 0.02, `after ${after}`);
  // Mid-attack is between open and ducked.
  const midIn = duckFactorAt(8 - 0.125, spans);
  assert.ok(midIn < open && midIn > under, `attack ${midIn}`);
});

test('shouldDuckClip: only music with a file', () => {
  const trackOf = (id: string) => ({ name: id === 'm' ? 'Music' : 'Voice' });
  assert.equal(shouldDuckClip({ track: 'm', kind: 'audio', asset: 'a' }, trackOf), true);
  assert.equal(shouldDuckClip({ track: 'v', kind: 'audio', asset: 'a' }, trackOf), false);
  assert.equal(shouldDuckClip({ track: 'm', kind: 'audio', muted: true, asset: 'a' }, trackOf), false);
});

test('composeAudioPlan: Music ducks under Voice; muted Voice does not duck', () => {
  const trackOf = (id: string) => ({ name: id === 'm' ? 'Music' : 'Voice' });
  const clips = [
    { id: '1', track: 'm', kind: 'audio', asset: 'a_m', start: 0, in: 0, out: 20, fadeIn: 1 },
    { id: '2', track: 'v', kind: 'audio', asset: 'a_v', start: 8, in: 0, out: 4 },
  ];
  const plan = composeAudioPlan(clips, trackOf);
  assert.equal(plan[0].duck, true);
  assert.equal(plan[0].duckTo, DUCK_TO);
  assert.equal(plan[0].fadeIn, 1);
  assert.equal(plan[1].dialogue, true);
  const muted = composeAudioPlan([{ ...clips[0] }, { ...clips[1], muted: true }], trackOf);
  assert.equal(muted[0].duck, undefined);
  assert.equal(muted[1].dialogue, undefined);
  assert.equal(muted[1].volume, 0);
});
