// Takes are paid for once (submit with `reuse`), and estimates come from history. A scratch data folder, no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-reuse-'));
const { db, J } = await import('../src/db.ts');
const { submit, getJob, jobRecipeKey, queue } = await import('../src/jobs.ts');
(queue as any).pump = () => {}; // no servers here: jobs stay queued
const { putAsset } = await import('../src/library.ts');
const { getTool } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const { estimate, scaleFrom } = await import('../src/estimate.ts');

const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;

/** A finished image.generate job with one output, as if a server had made it. */
function finished(prompt: string, seed: number, gpu = 12) {
  const tool = getTool('image.generate')!;
  const job = submit(owner, { tool: tool.id, project: 'sandbox', params: { prompt, seed } });
  const a = putAsset({
    data: Buffer.from(`png ${prompt} ${seed}`), ext: '.png', job: job.id, client: 'test', project: 'sandbox', tool: tool.id, seed,
    recipe: { tool: tool.id, version: tool.version, params: job.params, inputs: {}, models: tool.models?.(job.params), seed } as any,
  });
  db.prepare('UPDATE jobs SET status = ?, outputs = ?, gpu_seconds = ?, finished = ? WHERE id = ?')
    .run('done', J([{ asset: a.id, seed, mime: 'image/png', kind: 'image' }]), gpu, Date.now(), job.id);
  return { job: getJob(job.id)!, asset: a.id };
}

test('reuse hands back a finished job of the same recipe, any seed, skipping excluded takes', () => {
  const t1 = finished('a red door', 11);
  const t2 = finished('a red door', 12);
  const again = submit(owner, { tool: 'image.generate', project: 'sandbox', params: { prompt: 'a red door', seed: 99 }, reuse: true }) as any;
  assert.equal(again.reused, true);
  assert.equal(again.id, t1.job.id);
  const second = submit(owner, { tool: 'image.generate', project: 'sandbox', params: { prompt: 'a red door', seed: 100 }, reuse: { exclude: [t1.asset] } }) as any;
  assert.equal(second.id, t2.job.id);
  const third = submit(owner, { tool: 'image.generate', project: 'sandbox', params: { prompt: 'a red door', seed: 101 }, reuse: { exclude: [t1.asset, t2.asset] } }) as any;
  assert.ok(!third.reused, 'a third take is new');
  const other = submit(owner, { tool: 'image.generate', project: 'sandbox', params: { prompt: 'a blue door' }, reuse: true }) as any;
  assert.ok(!other.reused, 'a different prompt is a different recipe');
  const plain = submit(owner, { tool: 'image.generate', project: 'sandbox', params: { prompt: 'a red door' } }) as any;
  assert.ok(!plain.reused, 'no reuse unless asked');
});

test('the recipe key ignores the seed', () => {
  const tool = getTool('image.generate')!;
  const a = jobRecipeKey(tool, validateParams(tool, { prompt: 'x', seed: 1 }), {});
  const b = jobRecipeKey(tool, validateParams(tool, { prompt: 'x', seed: 2 }), {});
  assert.equal(a, b);
});

test('estimates come from history and count loads, boots and the idle tail', () => {
  const e = estimate('sandbox', [
    { tool: 'image.generate', params: { prompt: 'x' }, count: 10, label: 'tiles' },
    { tool: 'asset.make', params: { steps: [{ tool: 'image.generate', params: { prompt: 'y' } }, { tool: 'image.upscale', params: {} }], candidates: 4 }, count: 2, label: 'props' },
  ]);
  const tiles = e.lines.find((l: any) => l.label === 'tiles')!;
  assert.match(tiles.basis, /past jobs/);
  assert.equal(tiles.gpuSeconds, 120); // 10 x the 12 s median of the jobs above
  const step1 = e.lines.find((l: any) => l.label === 'props · step 1')!;
  assert.equal(step1.count, 8); // 2 assets x 4 candidates
  assert.ok(e.lines.some((l: any) => l.label === 'props · pick'));
  assert.ok(e.gpu.servers >= 1 && e.gpu.boots > 0 && e.gpu.modelLoads > 0);
  assert.ok(e.cost.withIdleTail > e.cost.total && e.cost.total > 0);
});

test('estimates scale history by size only where both jobs give it', () => {
  assert.equal(scaleFrom({ width: 1280, height: 704, frames: 81 }, { width: 640, height: 352, frames: 81 }), 4);
  assert.equal(scaleFrom({ frames: 81 }, { frames: 33, width: 640, height: 640 }), 81 / 33);
  // A past job with no size (it kept its input's size) isn't a 1-pixel job.
  assert.equal(scaleFrom({ width: 1280, height: 704 }, { prompt: 'x' }), 1);
  assert.equal(scaleFrom({ count: 3 }, {}), 3);
});

test('submit with an asset: input whose library file is gone says so (404), not ENOENT', async () => {
  const { submitJob } = await import('../src/jobs.ts');
  const a = putAsset({ data: Buffer.from('BVH-ish'), ext: '.bvh', client: 'test', project: 'sandbox', tool: 'upload', recipe: { tool: 'upload', version: 1, params: {}, inputs: {} } as any });
  fs.rmSync(a.path);
  await assert.rejects(
    submitJob(owner, { tool: 'blender.character', project: 'sandbox', params: {}, inputs: { files: [`asset:${a.id}`] } } as any),
    (e: any) => e.status === 404 && /missing here/.test(e.message) && !/ENOENT/.test(e.message),
  );
});

test('estimates price a tool by its mode: motion.from-text with a character vs BVH only', () => {
  const tool = getTool('motion.from-text')!;
  const add = (inputs: Record<string, string>, gpu: number) => {
    const job = submit(owner, { tool: tool.id, project: 'sandbox', params: { prompt: 'a person walks', seconds: 2, takes: 2 }, inputs });
    db.prepare('UPDATE jobs SET status = ?, gpu_seconds = ?, finished = ? WHERE id = ?').run('done', gpu, Date.now(), job.id);
  };
  const a = putAsset({ data: Buffer.from('glb-ish'), ext: '.glb', client: 'test', project: 'sandbox', tool: 'upload', recipe: { tool: 'upload', version: 1, params: {}, inputs: {} } as any });
  const item = { tool: tool.id, params: { prompt: 'a person walks', takes: 2 } };
  const before = estimate('sandbox', [{ ...item, inputs: {} }]).gpu.work;
  assert.ok(before <= 40, `BVH-only guess ${before}`);
  add({ character: a.path }, 340); add({ character: a.path }, 360); add({}, 28); add({}, 32);
  const bvh = estimate('sandbox', [{ ...item, inputs: {} }]);
  const withChar = estimate('sandbox', [{ ...item, inputs: { character: a.path } }]);
  const unsaid = estimate('sandbox', [item]);
  assert.ok(bvh.gpu.work <= 40, `${bvh.gpu.work}`);
  assert.ok(withChar.gpu.work >= 330 && withChar.gpu.work <= 370, `${withChar.gpu.work}`);
  assert.equal(unsaid.gpu.work, withChar.gpu.work);
  assert.match(String(bvh.lines[0].basis), /bvh-only/);
});
