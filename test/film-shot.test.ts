// The film pipeline's shot planner: beats into a timeline, keeping characters apart, the lint and the gate's fixes.
// Pure functions, no Blender and no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShot, lintShot, applyFixes, autoFixes, positionAt, facingAt, facingToward, dirOf, firstOverlap, occluders, cameraAt, defaultPace, type Shot } from '../src/film/shot.ts';

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('facing: 0 faces the camera (-Y), 90 faces +X; facingToward inverts dirOf', () => {
  near(dirOf(0)[1], -1);
  near(dirOf(90)[0], 1);
  for (const deg of [-170, -45, 0, 30, 90, 135]) {
    const [dx, dy] = dirOf(deg);
    near(facingToward(dx, dy), deg);
  }
});

test('beats: a walk takes distance / pace, the character ends at `to` facing where it went', () => {
  const shot: Shot = { characters: [{ file: 0, height: 1.75, position: [0, 0], beats: [{ animation: 'Walk', to: [4, 0], pace: 2 }] }] };
  const plan = planShot(shot, 5);
  const tl = plan.timelines[0];
  near(tl.segments[0].t1, 2);
  near(tl.segments[0].ground, 2);
  near(positionAt(tl, 1)[0], 2);
  near(positionAt(tl, 4)[0], 4);
  // Facing +X is 90 degrees; the turn is done a moment into the move.
  near(facingAt(tl, 1), 90);
  // The last clip carries on, standing, to the end of the shot.
  assert.equal(tl.segments.length, 2);
  near(tl.segments[1].t1, 5);
  assert.equal(tl.segments[1].ground, 0);
});

test('beats: explicit seconds fix the duration and set the ground speed', () => {
  const plan = planShot({ characters: [{ file: 0, beats: [{ animation: 'Run', to: [0, 6], seconds: 2 }] }] }, 3);
  near(plan.timelines[0].segments[0].ground, 3);
});

test('beats: a standing beat with lookAt turns to a character where it stands', () => {
  const shot: Shot = {
    characters: [
      { file: 0, position: [0, 0], facing: 0, beats: [{ animation: 'Idle', seconds: 1 }, { animation: 'Idle', seconds: 2, lookAt: 1 }] },
      { file: 1, position: [3, 0], beats: [{ animation: 'Idle', seconds: 3 }] },
    ],
  };
  const tl = planShot(shot, 3).timelines[0];
  near(facingAt(tl, 0.5), 0);
  near(facingAt(tl, 2.9), 90); // toward +X
});

test('beats: lookAt follows a character that walks (aimed where it stands as the turn ends)', () => {
  const shot: Shot = {
    characters: [
      { file: 0, position: [0, 0], beats: [{ animation: 'Idle', seconds: 3, lookAt: 1, turn: 0.5 }] },
      { file: 1, position: [0, 4], beats: [{ animation: 'Walk', to: [6, 4], seconds: 3 }] },
    ],
  };
  const plan = planShot(shot, 3);
  // At 0.5 s character 1 is a sixth of the way along its path: x = 1.
  near(facingAt(plan.timelines[0], 3), facingToward(1, 4), 0.5);
});

test('beats: gaps carry the previous clip on; bad beats throw', () => {
  const plan = planShot({ characters: [{ file: 0, beats: [{ animation: 'Idle', seconds: 1 }, { at: 2, animation: 'Wave', seconds: 1 }] }] }, 3);
  assert.equal(plan.timelines[0].segments.length, 3);
  near(plan.timelines[0].segments[1].t0, 1);
  near(plan.timelines[0].segments[1].t1, 2);
  assert.throws(() => planShot({ characters: [{ file: 0, beats: [{ animation: 'Idle', seconds: 2 }, { at: 1, seconds: 1 }] }] }, 3), /before the previous beat ends/);
  assert.throws(() => planShot({ characters: [{ file: 0, beats: [{ animation: 'Idle' }] }] }, 3), /give seconds/);
  assert.throws(() => planShot({ characters: [{ file: 0, beats: [{ animation: 'Walk', to: [1] }] }] }, 3), /\[x, y\]/);
  assert.throws(() => planShot({ characters: [{ file: 0, beats: [{ seconds: 1, lookAt: 5 }] }] }, 3), /not another character/);
});

test('beats: defaults by clip name scale with height', () => {
  assert.ok(defaultPace('Run_Loop', 1.75) > defaultPace('Walk', 1.75));
  near(defaultPace('Walk', 3.5), defaultPace('Walk', 1.75) * 2);
});

test('anti-overlap: a walk through a standing character swings around it; a walk into it stops short', () => {
  const through: Shot = {
    characters: [
      { file: 0, position: [-4, 0], beats: [{ animation: 'Walk', to: [4, 0], seconds: 6 }] },
      { file: 1, position: [0, 0], beats: [{ animation: 'Idle', seconds: 6 }] },
    ],
  };
  const plan = planShot(through, 6);
  assert.equal(firstOverlap(plan.timelines, 6), null);
  assert.ok(plan.moved.some((m) => /swings around/.test(m)));
  // Still ends where it was sent.
  near(positionAt(plan.timelines[0], 6)[0], 4);

  const into: Shot = {
    characters: [
      { file: 0, position: [0, 0], beats: [{ animation: 'Idle', seconds: 4 }] },
      { file: 1, position: [-4, 0], beats: [{ animation: 'Walk', to: [0, 0], seconds: 4 }] },
    ],
  };
  const p2 = planShot(into, 4);
  assert.equal(firstOverlap(p2.timelines, 4), null);
  assert.ok(p2.moved.some((m) => /stops .* short/.test(m)));
  assert.ok(positionAt(p2.timelines[1], 4)[0] < -0.4);
});

test('anti-overlap: two characters that start inside each other are reported, not moved', () => {
  const plan = planShot({ characters: [{ file: 0, position: [0, 0] }, { file: 1, position: [0.2, 0] }] }, 2);
  assert.ok(plan.notes.some((n) => /closer than their size allows/.test(n)));
});

test('camera: the planner places the camera the way the Blender script does', () => {
  const shot: Shot = { characters: [{ file: 0, height: 1.8, position: [0, 0], facing: 0 }], camera: { move: 'push-in', distance: 4, height: 1.5 } };
  const plan = planShot(shot, 4);
  const a = cameraAt(shot, plan, 0, 4);
  near(a.pos[0], 0);
  near(a.pos[1], -4); // in front of a character that faces -Y
  near(a.pos[2], 1.5);
  const b = cameraAt(shot, plan, 4, 4);
  near(b.pos[1], -4 * 0.65); // pushed in 35%
  // 90 degrees around: camera on the character's +X side... (angle turns counter-clockwise)
  const c = cameraAt({ ...shot, camera: { distance: 4, angle: 90 } }, plan, 0, 4);
  near(c.pos[0], 4);
});

test('lint: someone between the camera and the speaker is an error, and the auto fix swings the camera', () => {
  const shot: Shot = {
    speaker: 1,
    characters: [
      { file: 0, position: [0, -1.5], height: 1.8, facing: 180 },
      { file: 1, position: [0, 0], height: 1.8, facing: 0 },
    ],
    camera: { target: 1, distance: 4, height: 1.6 },
  };
  const { issues, plan } = lintShot(shot, 3, 2);
  assert.ok(issues.some((i) => i.check === 'occlusion' && i.level === 'error'), JSON.stringify(issues));
  assert.deepEqual(occluders(shot, plan!, 3, 1).map((o) => o.character), [0]);
  const fixes = autoFixes(shot, 3);
  assert.ok(fixes.some((f) => f.target === 'camera' && f.field === 'angle'), JSON.stringify(fixes));
  const { shot: fixed } = applyFixes(shot, fixes);
  assert.ok(!lintShot(fixed, 3, 2).issues.some((i) => i.check === 'occlusion'));
  // Nothing blocking: no issue.
  assert.ok(!lintShot(fixed, 3, 2).issues.some((i) => i.level === 'error'));
});

test('lint: attachments name a prop or a file that exists; moonwalking clips are flagged', () => {
  const bad: Shot = { characters: [{ file: 0, attachments: [{ bone: 'right hand' }, { prop: 3 }, { prop: 0, offset: [1, 2] }] }], props: [{ file: 1 }] };
  const issues = lintShot(bad, 2, 2).issues.filter((i) => i.check === 'attachment');
  assert.equal(issues.filter((i) => i.level === 'error').length, 3);
  const glide = lintShot({ characters: [{ file: 0, beats: [{ animation: 'Idle', to: [5, 0], seconds: 3 }] }] }, 3, 1).issues;
  assert.ok(glide.some((i) => i.check === 'moonwalk' && /glides/.test(i.message)));
  const spot = lintShot({ characters: [{ file: 0, animation: 'Walk' }] }, 3, 1).issues;
  assert.ok(spot.some((i) => i.check === 'moonwalk' && /on the spot/.test(i.message)));
  const fine = lintShot({ characters: [{ file: 0, animation: 'Walk', travel: 1.3 }] }, 3, 1).issues;
  assert.ok(!fine.some((i) => i.check === 'moonwalk'));
});

test('fixes: bounded fields only, copies the shot, says what changed', () => {
  const shot: Shot = { characters: [{ file: 0, position: [0, 0], facing: 0 }], props: [{ file: 1 }], camera: { distance: 4 } };
  const r = applyFixes(shot, [
    { target: 'character', index: 0, field: 'facing', values: [45], reason: 'faces him' },
    { target: 'camera', field: 'distance', values: [3] },
    { target: 'prop', index: 0, field: 'position', values: [1, 2, 0] },
  ]);
  assert.equal(r.shot.characters![0].facing, 45);
  assert.equal(r.shot.camera!.distance, 3);
  assert.equal(shot.camera!.distance, 4, 'the original is untouched');
  assert.match(r.applied[0], /faces him/);
  assert.throws(() => applyFixes(shot, [{ target: 'camera', field: 'distance', values: [400] }]), /must be/);
  assert.throws(() => applyFixes(shot, [{ target: 'camera', field: 'shake', values: [1] }]), /no adjustable/);
  assert.throws(() => applyFixes(shot, [{ target: 'character', index: 4, field: 'facing', values: [1] }]), /no character/);
  assert.throws(() => applyFixes(shot, [{ target: 'character', index: 0, field: 'position', values: [1] }]), /takes 2/);
});
