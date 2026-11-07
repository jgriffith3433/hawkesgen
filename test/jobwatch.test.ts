// The app follows jobs through one live stream (dashboard/gen/jobwatch.js), never by asking on a timer: a job is read
// when it's followed, follows its events, is read once more when it ends, and is read again when the stream (re)opens.
// The stream is open only while the page is on screen and something listens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobWatch } from '../dashboard/gen/jobwatch.js';

function harness(jobs: Record<string, any>) {
  const reads: string[] = [];
  let handlers: any = null, opts: any = null, opens = 0, closes = 0;
  let isHidden = false, vis: (() => void) | null = null;
  const w = createJobWatch({
    fetchJob: async (id: string) => { reads.push(id); if (!jobs[id]) throw new Error('gone'); return { ...jobs[id] }; },
    openStream: (h: any, o: any) => { handlers = h; opts = o; opens++; return { close() { closes++; } }; },
    hidden: () => isHidden,
    onVisible: (fn: () => void) => { vis = fn; },
  });
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    w, reads, tick,
    emit: (j: any) => handlers.job(j),
    live: () => opts.onState('live'),
    hide: (h: boolean) => { isHidden = h; vis?.(); },
    get opens() { return opens; }, get closes() { return closes; },
  };
}

test('a job is read once, follows its events, and is read once more when it ends', async () => {
  const jobs: Record<string, any> = { j1: { id: 'j1', status: 'queued', queue: { ahead: 2 } } };
  const h = harness(jobs);
  const steps: any[] = [];
  const done = h.w.follow('j1', (j: any) => steps.push(j));
  await h.tick();
  assert.equal(h.opens, 1);
  assert.deepEqual(h.reads, ['j1']);
  h.emit({ id: 'j1', status: 'running', detail: 'step 1' });
  h.emit({ id: 'other', status: 'running' });
  assert.equal(steps.at(-1).detail, 'step 1');
  assert.equal(h.reads.length, 1, 'events need no reads');
  jobs.j1 = { id: 'j1', status: 'done', outputs: [{ asset: 'a1', kind: 'image' }] };
  h.emit({ id: 'j1', status: 'done' });
  const j = await done;
  assert.equal(j.outputs[0].asset, 'a1');
  assert.deepEqual(h.reads, ['j1', 'j1']);
  assert.equal(h.w.following, 0);
  assert.equal(h.closes, 1, 'nothing left to follow: the stream closes');
});

test('an end before the stream opened is caught when it opens; a hidden page waits and catches up', async () => {
  const jobs: Record<string, any> = { j2: { id: 'j2', status: 'running' } };
  const h = harness(jobs);
  h.hide(true);
  const done = h.w.follow('j2');
  await h.tick();
  assert.equal(h.opens, 0, 'no stream while hidden');
  jobs.j2 = { id: 'j2', status: 'failed', error: 'no' };
  h.hide(false);
  assert.equal(h.opens, 1);
  h.live();
  assert.equal((await done).status, 'failed');
});

test('two callers share one follow; a first read that fails rejects', async () => {
  const jobs: Record<string, any> = { j3: { id: 'j3', status: 'running' } };
  const h = harness(jobs);
  const a = h.w.follow('j3'), b = h.w.follow('j3');
  await h.tick();
  assert.equal(h.reads.length, 1);
  jobs.j3 = { id: 'j3', status: 'cancelled' };
  h.emit({ id: 'j3', status: 'cancelled' });
  assert.equal((await a).status, 'cancelled');
  assert.equal((await b).status, 'cancelled');
  await assert.rejects(h.w.follow('nope'));
  assert.equal(h.w.following, 0);
});

test('listeners get every event and the reconnect; the stream follows whether anyone listens', async () => {
  const h = harness({});
  const seen: any[] = [];
  let back = 0;
  const stop = h.w.listen((j: any) => seen.push(j), () => back++);
  assert.equal(h.opens, 1);
  h.emit({ id: 'x', status: 'done' });
  assert.equal(seen.length, 1);
  h.hide(true);
  assert.equal(h.closes, 1);
  h.hide(false);
  assert.equal(back, 1, 'shown again: catch up');
  stop();
  assert.equal(h.closes, 2);
  assert.equal(h.w.open, false);
});
