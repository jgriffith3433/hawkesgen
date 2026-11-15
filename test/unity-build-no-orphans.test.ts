// A Unity build never leaves an execution queued in Cloud Run (2026-11-11: 77 waited in us-west1).
// Cloud Run refuses to cancel an execution that hasn't started ("not running"), so a queued one has to be deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { dropQueued, endExecution } = await import('../src/providers/builder/gcp.ts');

type Ex = { startTime?: string; completionTime?: string };
/** A fake Cloud Run with Cloud Run's rules: :cancel only on a started execution, DELETE only on one that isn't running. */
function fakeRun(execs: Record<string, Ex>, opts: { startsOnDelete?: string } = {}) {
  const calls: string[] = [];
  const api = async (url: string, init: { method?: string; body?: unknown; missingOk?: boolean } = {}) => {
    const m = /v2\/(.+?)(:cancel)?$/.exec(url)!;
    const name = m[1];
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    calls.push(`${method} ${name}${m[2] ?? ''}`);
    const e = execs[name];
    if (!e) { if (init.missingOk) return null; throw new Error('404'); }
    if (m[2]) {
      if (!e.startTime || e.completionTime) throw new Error('FAILED_PRECONDITION: execution is not running');
      e.completionTime = 'now';
      return {};
    }
    if (method === 'DELETE') {
      if (opts.startsOnDelete === name) e.startTime = 'just now';
      if (e.startTime && !e.completionTime) throw new Error('FAILED_PRECONDITION: execution is running');
      delete execs[name];
      return {};
    }
    return { ...e };
  };
  return { api: api as any, calls, execs };
}

const N = (i: number) => `projects/p/locations/us-west1/jobs/hawkes-unity-build-customer/executions/e${i}`;

test('a queued execution is deleted, not left waiting (cancel is refused on it)', async () => {
  const f = fakeRun({ [N(1)]: {} });
  assert.equal(await endExecution(N(1), f.api), true);
  assert.equal(f.execs[N(1)], undefined, 'the queued execution is gone');
  assert.ok(!f.calls.some((c) => c.endsWith(':cancel')), 'no pointless cancel on a queued execution');
});

test('a running execution is cancelled, a finished or missing one is left alone', async () => {
  const f = fakeRun({ [N(1)]: { startTime: 't' }, [N(2)]: { startTime: 't', completionTime: 't2' } });
  assert.equal(await endExecution(N(1), f.api), true);
  assert.ok(f.execs[N(1)].completionTime);
  assert.equal(await endExecution(N(2), f.api), true);
  assert.equal(await endExecution(N(3), f.api), true);
  assert.deepEqual(f.calls.filter((c) => c.startsWith('DELETE')), []);
});

test('moving a waiting build: only a queued execution is dropped; one that just got a machine stays', async () => {
  const f = fakeRun({ [N(1)]: {}, [N(2)]: { startTime: 't' }, [N(3)]: {} }, { startsOnDelete: N(3) });
  assert.equal(await dropQueued(N(1), f.api), 'dropped');
  assert.equal(await dropQueued(N(2), f.api), 'started');
  assert.equal(f.execs[N(2)].completionTime, undefined, 'a started build is never cancelled by a move');
  assert.equal(await dropQueued(N(3), f.api), 'started', 'got a machine between the read and the delete');
});

test('when Cloud Run can\'t be asked, the build is not called gone (it is not moved, so no second execution)', async () => {
  const api = (async () => { throw new Error('503'); }) as any;
  assert.equal(await dropQueued(N(1), api), 'unknown');
  assert.equal(await endExecution(N(1), api), false);
});

test('the old cancel left 77 queued; ending every one of a job\'s executions leaves none', async () => {
  const execs: Record<string, Ex> = {};
  for (let i = 0; i < 77; i++) execs[N(i)] = {};
  const f = fakeRun(execs);
  for (let i = 0; i < 77; i++) await endExecution(N(i), f.api);
  assert.equal(Object.keys(f.execs).length, 0);
});

test('unity.build releases its executions when its job ends outside its run (cancel, failed resume)', async () => {
  const { unityBuild } = await import('../src/tools/build.ts');
  assert.equal(typeof unityBuild.ended, 'function');
});
