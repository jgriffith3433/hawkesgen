// The director gate: the rubric, the numbers, and the adjust-and-look-again loop, driven with fakes (no Blender, no Claude).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rubric, numericFindings, runGate, cleanFixes, gatePrompt, VERDICT_SCHEMA, STILL_SHARES, type RenderOut, type Verdict } from '../src/film/gate.ts';
import { planShot, positionAt, facingAt, type Shot } from '../src/film/shot.ts';

const shot: Shot = {
  speaker: 1,
  characters: [
    { file: 0, position: [-2, 0], height: 1.8, facing: 90, beats: [{ animation: 'Walk', to: [0.5, 0], seconds: 2 }, { animation: 'Idle', seconds: 2, lookAt: 1 }], attachments: [{ prop: 0, bone: 'right hand' }] },
    { file: 1, position: [2, 0], height: 1.8, facing: -90, animation: 'Idle' },
  ],
  props: [{ file: 2 }],
  camera: { target: 1, distance: 4, height: 1.6, angle: 30 },
};
const SECONDS = 4;

/** What Blender would report for a plan that was followed. */
function honest(s: Shot): RenderOut {
  const plan = planShot(s, SECONDS);
  return {
    sheet: '/tmp/sheet.png', job: 'j_fake',
    stills: STILL_SHARES.map((t) => ({ t, characters: plan.timelines.map((tl) => { const p = positionAt(tl, t * SECONDS); return { index: tl.character, x: p[0], y: p[1], facing: facingAt(tl, t * SECONDS) }; }) })),
    characters: [{ index: 0, segments: [{ animation: 'Walk', ground: 1.25, playback: 0.8, slide: 1 }] }],
  };
}
const allPass = (checks: { id: string }[]): Verdict => ({ pass: true, checks: checks.map((c) => ({ id: c.id, pass: true, note: 'ok' })), fixes: [], summary: 'Looks right.' });

test('rubric: only the checks that apply', () => {
  const ids = (s: Shot) => rubric(s, planShot(s, SECONDS)).map((c) => c.id);
  assert.deepEqual(ids(shot), ['grip:0:0', 'face-clear', 'faces:0:1', 'travel:0', 'in-frame']);
  assert.deepEqual(ids({ characters: [{ file: 0 }] }), ['in-frame']);
  const extra = rubric({ characters: [{ file: 0 }, { file: 1, position: [3, 0] }] }, planShot({ characters: [{ file: 0 }, { file: 1, position: [3, 0] }] }, 2), { faces: [[1, 0]] });
  assert.ok(extra.some((c) => c.id === 'faces:1:0'));
});

test('numbers: a character that stood still while the plan walked it is a failed finding; a followed plan passes', () => {
  const plan = planShot(shot, SECONDS);
  const good = numericFindings(plan, honest(shot).stills, SECONDS, honest(shot).characters);
  assert.ok(good.every((f) => f.pass), JSON.stringify(good));
  const stuck = honest(shot).stills.map((s) => ({ ...s, characters: s.characters.map((c) => (c.index === 0 ? { ...c, x: -2, y: 0 } : c)) }));
  const bad = numericFindings(plan, stuck, SECONDS);
  const placed = bad.find((f) => f.id === 'placed:0')!;
  assert.equal(placed.pass, false);
  assert.match(placed.note, /the plan has/);
  // Feet sliding: the stride was clamped.
  const slide = numericFindings(plan, honest(shot).stills, SECONDS, [{ index: 0, segments: [{ animation: 'Walk', ground: 3, playback: 2.5, slide: 0.5, note: 'clamped: the Walk stride wants 3.10x' }] }]);
  assert.equal(slide.find((f) => f.id.startsWith('stride:'))!.pass, false);
  // 3D mesh overlap reported by BVHTree in stills[].overlaps fails numericFindings.
  const overlapped = honest(shot).stills.map((s, idx) => (idx === 2 ? { ...s, overlaps: [{ a: 0, b: 1, faces: 14 }] } : { ...s, overlaps: [] }));
  const ovFind = numericFindings(plan, overlapped, SECONDS).find((f) => f.id === 'overlap:0:1')!;
  assert.equal(ovFind.pass, false);
  assert.match(ovFind.note, /3D meshes overlap/);
});

test('gate: a shot that passes on the first look costs one render', async () => {
  let renders = 0;
  const r = await runGate({ shot, seconds: SECONDS, nFiles: 3, render: async (s) => { renders++; return honest(s); }, judge: async ({ checks }) => allPass(checks) });
  assert.equal(r.pass, true);
  assert.equal(renders, 1);
  assert.equal(r.tries, 0);
});

test('gate: a failing look adjusts what Claude says and looks again', async () => {
  const seen: number[] = [];
  const r = await runGate({
    shot, seconds: SECONDS, nFiles: 3,
    render: async (s) => { seen.push(s.camera!.angle); return honest(s); },
    judge: async ({ checks, prompt }) => {
      if (seen.length === 1) {
        assert.match(prompt, /top-left t=0/);
        return {
          pass: false, summary: 'The camera is too far round, so the speaker is hidden.',
          checks: checks.map((c) => ({ id: c.id, pass: c.id !== 'face-clear', note: c.id === 'face-clear' ? 'character 0 hides the face in frame 3' : 'ok' })),
          fixes: [{ target: 'camera', index: -1, attachment: -1, field: 'angle', values: [-30], reason: 'swing to the other side' }],
        };
      }
      return allPass(checks);
    },
  });
  assert.equal(r.pass, true);
  assert.deepEqual(seen, [30, -30]);
  assert.equal(r.shot.camera!.angle, -30);
  assert.equal(shot.camera!.angle, 30, 'the caller\'s shot is untouched');
  assert.equal(r.tries, 1);
  assert.ok(r.rounds[0].applied.some((a) => /camera angle = -30/.test(a)));
});

test('gate: gives up after two adjustments and says what still fails', async () => {
  let renders = 0;
  const r = await runGate({
    shot, seconds: SECONDS, nFiles: 3,
    render: async (s) => { renders++; return honest(s); },
    judge: async ({ checks }) => ({
      pass: false, summary: 'The prop floats.', checks: checks.map((c) => ({ id: c.id, pass: !c.id.startsWith('grip'), note: c.id.startsWith('grip') ? 'floats beside the hand' : 'ok' })),
      fixes: [{ target: 'attachment', index: 0, attachment: 0, field: 'offset', values: [0, 0.02 * renders, 0], reason: 'move it into the hand' }],
    }),
    maxTries: 2,
  });
  assert.equal(r.pass, false);
  assert.equal(renders, 3, 'one look and two re-checks, no more');
  assert.match(r.summary, /grip:0:0 \(floats beside the hand\)/);
  assert.deepEqual((r.shot.characters![0].attachments![0] as any).offset, [0, 0.04, 0]);
});

test('gate: Claude cannot pass a shot the numbers fail, and a fix that makes no sense is dropped', async () => {
  const liar: RenderOut = { ...honest(shot), stills: honest(shot).stills.map((s) => ({ ...s, characters: s.characters.map((c) => ({ ...c, x: 40 })) })) };
  let renders = 0;
  const r = await runGate({
    shot, seconds: SECONDS, nFiles: 3,
    render: async () => { renders++; return liar; },
    judge: async ({ checks }) => ({ ...allPass(checks), fixes: [{ target: 'camera', index: -1, attachment: -1, field: 'distance', values: [9000], reason: 'nonsense' }] }),
  });
  assert.equal(r.pass, false);
  assert.equal(renders, 1, 'with nothing valid to adjust it stops instead of re-rendering the same shot');
  assert.match(r.summary, /placed:0/);
  const cleaned = cleanFixes(shot, [{ target: 'camera', index: -1, attachment: -1, field: 'distance', values: [9000] }, { target: 'character', index: 1, attachment: -1, field: 'facing', values: [-45] }]);
  assert.equal(cleaned.applied.length, 1);
  assert.equal(cleaned.shot.characters![1].facing, -45);
});

test('gate: someone hiding the speaker is fixed before the first render', async () => {
  const hidden: Shot = {
    speaker: 1,
    characters: [{ file: 0, position: [0, -1.5], height: 1.8, facing: 180 }, { file: 1, position: [0, 0], height: 1.8 }],
    camera: { target: 1, distance: 4, height: 1.6 },
  };
  const angles: number[] = [];
  const r = await runGate({
    shot: hidden, seconds: 2, nFiles: 2,
    render: async (s) => { angles.push(s.camera!.angle ?? 0); const plan = planShot(s, 2); return { sheet: 's.png', stills: STILL_SHARES.map((t) => ({ t, characters: plan.timelines.map((tl) => ({ index: tl.character, x: tl.segments[0].from[0], y: tl.segments[0].from[1], facing: tl.segments[0].faceFrom })) })) }; },
    judge: async ({ checks }) => allPass(checks),
  });
  assert.equal(r.pass, true);
  assert.notEqual(angles[0], 0, 'the camera moved off the blocked line before the render');
  assert.ok(r.rounds[0].applied.length > 0);
});

test('gate: a shot that cannot be built stops with the reason, no render', async () => {
  let renders = 0;
  const r = await runGate({ shot: { characters: [{ file: 9 }] }, seconds: 2, nFiles: 2, render: async (s) => { renders++; return honest(s); }, judge: async ({ checks }) => allPass(checks) });
  assert.equal(r.pass, false);
  assert.equal(renders, 0);
  assert.match(r.summary, /can't be built/);
});

test('the verdict schema is strict (every object closed) and the prompt carries the contact sheet layout and fixes', () => {
  const walk = (o: any) => { if (o && typeof o === 'object') { if (o.type === 'object') assert.equal(o.additionalProperties, false); Object.values(o).forEach(walk); } };
  walk(VERDICT_SCHEMA);
  const plan = planShot(shot, SECONDS);
  const p = gatePrompt(shot, plan, rubric(shot, plan), [], honest(shot).stills, SECONDS);
  assert.match(p, /bottom-right 100%/);
  assert.match(p, /camera: angle, distance, height/);
  assert.match(p, /grip:0:0/);
});
