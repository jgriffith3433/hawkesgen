// The pipeline lane (jobs.ts fill): at most settings.concurrency.pipeline top-level pipelines at once, but a pipeline that is a step of another
// job (asset.make's image.viewsheet) never waits behind that cap: its parent holds a slot and waits for it. Six
// asset.make jobs once held every slot while their view-sheet steps waited for one, and nothing finished (2026-10-23).
// A scratch data folder; runJob is stubbed (jobs are marked running and never end), so nothing really runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-pipeline-lane-'));
const { db } = await import('../src/db.ts');
const { submit, getJob, queue, switchTo } = await import('../src/jobs.ts');
const { saveSettings } = await import('../src/config.ts');
saveSettings({ concurrency: { pipeline: 6 } } as any); // the cap is a setting (default 200); six here to fill it
const q = queue as any;
q.pump = () => {};
const started: string[] = [];
q.runJob = (j: { id: string }) => {
  started.push(j.id);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(j.id);
  return new Promise(() => {}); // holds its slot, like a pipeline waiting on its steps
};

const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;
const steps = [{ tool: 'image.generate', params: { prompt: 'a crate' } }];

test('six top-level pipelines fill the lane; a seventh waits, but their own pipeline steps still start', async () => {
  const parents = Array.from({ length: 6 }, (_, i) => submit(owner, { tool: 'asset.make', project: 'sandbox', params: { steps: [{ ...steps[0], params: { prompt: `thing ${i}` } }] } }));
  await q.fill();
  assert.deepEqual(new Set(started), new Set(parents.map((p) => p.id)), 'the first six run');

  const seventh = submit(owner, { tool: 'asset.make', project: 'sandbox', params: { steps: [{ ...steps[0], params: { prompt: 'thing 7' } }] } });
  const step = submit(owner, { tool: 'asset.make', project: 'sandbox', params: { steps: [{ ...steps[0], params: { prompt: 'a step' } }] }, labels: { parent: parents[0].id, step: 3 } });
  await q.fill();
  assert.ok(started.includes(step.id), "a parent's pipeline step starts although six pipelines run");
  assert.ok(!started.includes(seventh.id), 'a seventh top-level pipeline still waits');
  assert.match(String(getJob(seventh.id)!.detail ?? ''), /pipeline jobs already running/);
});

test('a GPU server that has to switch models takes the family with the most work waiting, never past a higher priority', () => {
  const j = (id: string, family: string, priority = 0) => ({ id, family, priority });
  // Oldest first: one lone birefnet job, then a pile of image-edit jobs.
  const open = [j('a', 'birefnet'), j('b', 'qwen-edit'), j('c', 'qwen-edit'), j('d', 'qwen-edit'), j('e', 'z-image')];
  assert.equal(switchTo(open)!.id, 'b', 'the oldest job of the biggest pile');
  // A tie keeps the oldest job's family.
  assert.equal(switchTo([j('a', 'birefnet'), j('b', 'qwen-edit'), j('c', 'birefnet'), j('d', 'qwen-edit')])!.id, 'a');
  // A boosted job (J is waiting on it) goes first whatever the piles say.
  assert.equal(switchTo([j('v', 'wan', 5), j('b', 'qwen-edit'), j('c', 'qwen-edit')])!.id, 'v');
  assert.equal(switchTo([]), null);
});
