// Priority boosts and retakes (jobs.ts boostLabel, rerun): a label's boost lifts its queued jobs now and later ones as
// they come, and ends with priority 0; a retake changes params, swaps inputs and keeps the labels. A scratch data
// folder, no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-priority-'));
const { db, J } = await import('../src/db.ts');
const { submit, getJob, rerun, boostLabel, boostFor, queue } = await import('../src/jobs.ts');
(queue as any).pump = () => {}; // no servers here: jobs stay queued
const { putAsset } = await import('../src/library.ts');

const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;

test("a boost lifts a label's queued jobs and the ones that come later; priority 0 ends it", () => {
  const a = submit(owner, { tool: 'image.generate', project: 'sandbox', params: { prompt: 'video shot' }, labels: { studioChange: 'c_aaa' } });
  const other = submit(owner, { tool: 'image.generate', project: 'sandbox', params: { prompt: 'something else' }, labels: { studioChange: 'c_bbb' } });
  assert.equal(a.priority, 0);
  const r = boostLabel('studioChange', 'c_aaa', 5, 60);
  assert.equal(r.queued, 1);
  assert.equal(getJob(a.id)!.priority, 5);
  assert.equal(getJob(other.id)!.priority, 0);
  const later = submit(owner, { tool: 'image.generate', project: 'sandbox', params: { prompt: 'next shot' }, labels: { studioChange: 'c_aaa' } });
  assert.equal(later.priority, 5, 'submitted while boosted');
  assert.equal(boostFor({ studioChange: 'c_aaa' }), 5);
  boostLabel('studioChange', 'c_aaa', 0);
  assert.equal(getJob(a.id)!.priority, 0);
  assert.equal(getJob(later.id)!.priority, 0);
  assert.equal(submit(owner, { tool: 'image.generate', project: 'sandbox', params: { prompt: 'after' }, labels: { studioChange: 'c_aaa' } }).priority, 0);
  assert.throws(() => boostLabel('bad label!', 'x', 5), /label/);
});

test('a retake: a new seed, changed params, a swapped input, the same labels', () => {
  const j = submit(owner, { tool: 'image.generate', project: 'sandbox', params: { prompt: 'a door', seed: 7 }, labels: { studioChange: 'c_ccc' } });
  const again = rerun(owner, j.id, { params: { prompt: 'a door, warmer light' } });
  assert.equal(again.params.prompt, 'a door, warmer light');
  assert.notEqual(again.params.seed, 7);
  assert.deepEqual([again.labels.studioChange, again.labels.rerunOf], ['c_ccc', j.id]);
  assert.throws(() => rerun(owner, j.id, { inputs: { nope: 'asset:a_0000000000000000' } }), /has no input "nope"/);
  // An upscale of a new take: its video input swapped for the take.
  const take = putAsset({ data: Buffer.from('mp4 take'), ext: '.mp4', job: null as any, client: 'test', project: 'sandbox', tool: 'video.scene', recipe: { tool: 'video.scene', version: 1, params: {}, inputs: {} } as any } as any);
  const first = putAsset({ data: Buffer.from('mp4 first'), ext: '.mp4', job: null as any, client: 'test', project: 'sandbox', tool: 'video.scene', recipe: { tool: 'video.scene', version: 1, params: {}, inputs: {} } as any } as any);
  const up = submit(owner, { tool: 'video.upscale', project: 'sandbox', inputs: { video: `asset:${first.id}` } });
  db.prepare('UPDATE jobs SET status = ?, outputs = ? WHERE id = ?').run('done', J([]), up.id);
  const up2 = rerun(owner, up.id, { inputs: { video: `asset:${take.id}` }, priority: 5 });
  assert.equal(up2.inputs.video, take.path);
  assert.equal(up2.priority, 5);
});
