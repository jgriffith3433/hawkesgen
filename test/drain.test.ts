// A restart drains first (src/jobs.ts Queue.drain, src/cloudhost.ts drainJobs). 2026-11-07: seven 10-minute playtests were
// stopped "interrupted 5 times by Hawkes Gen restarting": five merges in two hours, each deploy cutting them off, and every
// cut counted against the crash limit. Now a stop takes no new jobs, waits for the running ones (by job events, no polling) up
// to a cap, and marks what is left as cut off by a planned restart, which the next start picks up without using the crash limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-drain-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
delete process.env.K_SERVICE;

const { submit, getJob, queue, cancel, MAX_RESUMES, MAX_DRAIN_RESUMES } = await import('../src/jobs.ts');
const { db } = await import('../src/db.ts');
const { drainMs } = await import('../src/cloudhost.ts');
const owner = { id: 'c_test', role: 'owner', projects: ['*'] } as any;
const graph = { family: 'z-image', graph: { '9': { class_type: 'SaveImage', inputs: {} } } };
const make = () => submit(owner, { tool: 'comfy.graph', project: 'sandbox', params: graph });

test('drain waits for a running job to finish, then reports nothing left', async () => {
  const a = make();
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(a.id);
  queue.draining = false;
  const p = queue.drain(5000);
  // The queue hears a job's change as an event: the same one the app listens to.
  const { events } = await import('../src/bus.ts');
  setTimeout(() => { db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(a.id); events.emit('job', { id: a.id }); }, 30);
  assert.equal(await p, 0);
  // Marked at the start of the wait (a hard kill never reaches the end of it); harmless once the job is done.
});

test('six planned restarts during one long job (a Unity build) never use the crash limit', async () => {
  const j = make();
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(j.id);
  for (let i = 1; i <= 6; i++) {
    queue.draining = false;
    // SIGTERM, then the instance is killed before the wait ends: only the mark made at the start survives.
    void queue.drain(300);
    assert.ok(getJob(j.id)!.labels.drained, `restart ${i}: marked at once`);
    (queue as any).start();
    const now = getJob(j.id)!;
    assert.notEqual(now.status, 'failed', `restart ${i}`);
    assert.equal(now.resumed, 0, 'no crash resume counted');
    assert.equal(now.labels.drainResumes, i);
    // The pick-up runs it again (here: straight back to running, as the queue would).
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(j.id);
  }
  db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(j.id);
  const { events } = await import('../src/bus.ts');
  events.emit('job', { id: j.id }); // lets the pending drain waits end
  assert.equal(getJob(j.id)!.status, 'done');
});

test('while draining nothing new starts; a job still running at the cap is marked for a planned pick-up', async () => {
  const a = make();
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(a.id);
  const left = await queue.drain(30);
  assert.equal(left, 1);
  assert.ok(queue.draining);
  const queued = make();
  await queue.fill();
  assert.equal(getJob(queued.id)!.status, 'queued', 'a draining queue starts nothing');
  assert.ok(getJob(a.id)!.labels.drained);
  cancel(queued.id);
});

test('a planned restart does not use the crash limit; a crash still does', async () => {
  const planned = make();
  const crashed = make();
  db.prepare("UPDATE jobs SET status = 'running', resumed = ? WHERE id = ?").run(MAX_RESUMES, planned.id);
  db.prepare("UPDATE jobs SET labels = ? WHERE id = ?").run(JSON.stringify({ drained: Date.now() }), planned.id);
  db.prepare("UPDATE jobs SET status = 'running', resumed = ? WHERE id = ?").run(MAX_RESUMES, crashed.id);
  queue.draining = false;
  (queue as any).start();
  const p = getJob(planned.id)!;
  assert.notEqual(p.status, 'failed');
  assert.equal(p.resumed, MAX_RESUMES);
  assert.equal(p.labels.drainResumes, 1);
  assert.equal(p.labels.drained, undefined);
  assert.equal(getJob(crashed.id)!.status, 'failed');
  if (['queued', 'running'].includes(p.status)) cancel(planned.id);
});

test('planned restarts have a limit of their own', async () => {
  const j = make();
  db.prepare("UPDATE jobs SET status = 'running', labels = ? WHERE id = ?").run(JSON.stringify({ drained: 1, drainResumes: MAX_DRAIN_RESUMES }), j.id);
  (queue as any).start();
  assert.equal(getJob(j.id)!.status, 'failed');
});

test('the wait is short on Cloud Run (its stop allows 10 s), long elsewhere, and can be set', () => {
  delete process.env.HAWKESGEN_DRAIN_SECONDS;
  assert.equal(drainMs(), 120_000);
  process.env.K_SERVICE = 'gen';
  assert.equal(drainMs(), 2000);
  process.env.HAWKESGEN_DRAIN_SECONDS = '6';
  assert.equal(drainMs(), 6000);
  delete process.env.K_SERVICE; delete process.env.HAWKESGEN_DRAIN_SECONDS;
});
