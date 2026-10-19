// The live view of a running playtest (src/tools/livePlay.ts): steps are kept as the run reports them, the snapshot reads
// the run's own state only when asked, frames come from the screencast (else the newest screenshot), and the entry goes
// with the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginLive, liveSnapshot, liveFrame, isLive, livePlaytester } from '../src/tools/livePlay.ts';

function fakeCtx(id: string, params: Record<string, any> = {}) {
  const steps: string[] = [];
  const ctx: any = {
    job: { id, client: 'c', project: 'demo', tool: 'playtest.run', labels: {} },
    params: { url: 'http://localhost:8089/', scenario: 'smoke', ...params },
    step: (d: string) => steps.push(d),
  };
  return { ctx, steps };
}

test('livePlay: steps, players, problems and the newest frame while it plays; gone after', () => {
  const { ctx, steps } = fakeCtx('j_live1');
  const live = beginLive(ctx);
  ctx.step('opening Chromium');
  ctx.step('loading the page');
  // The run's own step function still gets every step.
  assert.deepEqual(steps, ['opening Chromium', 'loading the page']);
  const problems: any[] = [];
  const consoleLines: any[] = [{ type: 'warning', text: 'w', t: 1 }];
  const recorder = { latest: Buffer.from('jpeg-1'), latestAt: 1000 };
  let state: any = null;
  live.source(() => ({
    host: 'i-1 (us-east-1)', playtester: 'i-1', recorder: 'screencast', contract: true, scenario: { id: 'smoke', title: 'Smoke', seconds: 60 },
    players: [{ i: 0, scenario: 'smoke', state, recorder }], problems, console: consoleLines, failed: [], shots: [], timeline: [{ t: 1, progress: 0.5, fps: 59.6 }], loadSeconds: 2.5, outcome: null,
  }));
  state = { status: 'running', scene: 'level-1', progress: 0.5, fps: 59.6, note: 'jumping the gap', metrics: { deaths: 1 } };
  problems.push({ severity: 'bug', message: 'fell through the floor', source: 'game' });
  consoleLines.push({ type: 'error', text: 'TypeError: x is undefined', t: 2 });

  assert.ok(isLive('j_live1'));
  assert.equal(livePlaytester('j_live1'), 'i-1');
  const s: any = liveSnapshot('j_live1');
  assert.equal(s.step, 'loading the page');
  assert.equal(s.players[0].state.scene, 'level-1');
  assert.equal(s.players[0].state.fps, 60);
  assert.equal(s.players[0].state.note, 'jumping the gap');
  assert.equal(s.problems.count, 1);
  assert.equal(s.console.errors, 1);
  assert.equal(s.console.warnings, 1);
  assert.equal(s.timeline, undefined, 'the light snapshot has no timeline');
  const full: any = liveSnapshot('j_live1', { full: true });
  assert.equal(full.steps.length, 2);
  assert.equal(full.timeline.length, 1);

  const f: any = liveFrame('j_live1', 0);
  assert.equal(f.jpeg.toString(), 'jpeg-1');

  live.end();
  assert.equal(isLive('j_live1'), false);
  assert.equal(liveSnapshot('j_live1'), null);
});

test('livePlay: without a screencast frame, the newest screenshot; a source that throws still gives the steps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveplay-'));
  const shot = path.join(dir, 'shot.jpg');
  fs.writeFileSync(shot, 'shot-jpeg');
  const { ctx } = fakeCtx('j_live2', { peers: 2 });
  const live = beginLive(ctx);
  live.source(() => ({ players: [{ i: 0, scenario: 'a', state: null, recorder: null }], shots: [{ file: shot }] }));
  const f: any = liveFrame('j_live2', 0);
  assert.equal(f.file, shot);
  live.source(() => { throw new Error('between states'); });
  ctx.step('peer 1: playing');
  const s: any = liveSnapshot('j_live2');
  assert.equal(s.step, 'peer 1: playing');
  assert.equal(s.peers, 2);
  live.end();
  fs.rmSync(dir, { recursive: true, force: true });
});
