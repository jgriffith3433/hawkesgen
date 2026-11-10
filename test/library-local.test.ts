// Library files on an instance that doesn't have them (src/storage.ts localPath / localAsset, src/library.ts
// libraryShaOf). On Cloud Run each instance's /data is only a cache: an asset.make chain failed at its third step with
// "ENOENT ... open '/data/library/2026-11/a_....png'" because an earlier step's file (or a take the library handed back)
// wasn't on the instance that went on with it. Here the file is in storage (a fake store) and gone from this disk, and
// every way a step reads it brings it back first. A scratch data folder, no GPU, no cloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-local-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'test-bucket';
const storage = await import('../src/storage.ts');
const { db, J } = await import('../src/db.ts');
const { putAsset, libraryShaOf } = await import('../src/library.ts');
const { submit, getJob, queue } = await import('../src/jobs.ts');
(queue as any).pump = () => {}; // no servers here: jobs stay queued
const { getTool } = await import('../src/tools/index.ts');
const { firstAsset } = await import('../src/tools/chain.ts');
const { sha256File } = await import('../src/util.ts');

const objects = new Map<string, Buffer>();
const fake = {
  gets: 0,
  async has(key: string) { return objects.has(key); },
  async put(key: string, file: string) { objects.set(key, fs.readFileSync(file)); },
  async get(key: string, dest: string) {
    fake.gets++;
    const b = objects.get(key);
    if (!b) throw new Error('NoSuchKey');
    await new Promise((r) => setImmediate(r)); // a real download takes a while: lets two readers overlap
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, b);
  },
};
storage.setStore(fake);

const owner = { id: 'test', name: 'J', role: 'owner', projects: ['*'] } as any;
const png = (tag: string, extra: Record<string, unknown> = {}) => putAsset({
  data: Buffer.from(`png ${tag}`), ext: '.png', client: 'test', project: 'p', tool: 'file.import',
  recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any, ...extra,
});
/** Made on "another instance": in storage, not on this disk. */
const elsewhere = async (tag: string, extra: Record<string, unknown> = {}) => {
  const a = png(tag, extra);
  await storage.idle();
  fs.rmSync(a.path);
  return a;
};

test('a library file that is in storage but not on this disk is restored before it is read', async () => {
  const a = await elsewhere('cutout');
  assert.equal(fs.existsSync(a.path), false);
  fake.gets = 0;
  // Two readers at once (the step runner and a tool) share one download.
  const [p1, p2] = await Promise.all([storage.localPath(a), storage.localPath(a)]);
  assert.equal(p1, a.path);
  assert.equal(p2, a.path);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'png cutout');
  assert.equal(fake.gets, 1);

  fs.rmSync(a.path);
  const b = await storage.localAsset(`asset:${a.id}`);
  assert.equal(b?.id, a.id);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'png cutout');
  assert.equal(await storage.localAsset('a_0000000000000000'), null);
});

test('a file that is nowhere fails in plain words, not ENOENT', async () => {
  const a = png('lost');
  await storage.idle();
  objects.delete(storage.keyOf(a.sha256));
  fs.rmSync(a.path);
  await assert.rejects(storage.localPath(a, "step 2's cutout"), (e: any) => !/ENOENT/.test(e.message) && /step 2's cutout's file is not on this server/.test(e.message));
});

test("a step's input from an earlier step: the library is asked by hash (no read), and the file comes back before the run", async () => {
  const front = await elsewhere('front');

  // An earlier run of the next step already made a take from this input (as runJob files it).
  fs.writeFileSync(front.path, 'png front'); // on disk while that run hashed it
  const first = submit(owner, { project: 'p', tool: 'image.remove-background', inputs: { image: `asset:${front.id}` } } as any);
  const tool = getTool(first.tool)!;
  const recipe = { tool: tool.id, version: tool.version, params: first.params, inputs: { image: await sha256File(front.path) }, models: tool.models?.(first.params) } as any;
  const take = png('take', { job: first.id, tool: tool.id, recipe });
  db.prepare('UPDATE jobs SET status = ?, outputs = ? WHERE id = ?').run('done', J([{ asset: take.id, kind: 'image', mime: 'image/png', seed: null }]), first.id);
  await storage.idle();
  fs.rmSync(front.path);

  // The chain's next submit with reuse used to read the missing file for its recipe key and die with ENOENT.
  const again = submit(owner, { project: 'p', tool: 'image.remove-background', inputs: { image: `asset:${front.id}` }, reuse: true } as any);
  assert.equal(again.id, first.id);
  assert.equal((again as any).reused, true);
  assert.equal(libraryShaOf(front.path), front.sha256);
  assert.equal(fs.existsSync(front.path), false, 'asked without the file');

  // A new job on it: its input is restored before the tool runs.
  const job = submit(owner, { project: 'p', tool: 'image.remove-background', params: { seed: 7 }, inputs: { image: `asset:${front.id}` } } as any);
  assert.equal(fs.existsSync(String(job.inputs.image)), false);
  await storage.ensureInputs(getJob(job.id)!.inputs);
  assert.equal(fs.readFileSync(front.path, 'utf8'), 'png front');
});

test("a child job's output a tool goes on with (firstAsset) is on this disk", async () => {
  const out = await elsewhere('edit');
  const a = await firstAsset({ tool: 'image.edit', outputs: [{ asset: out.id, kind: 'image' }] }, 'image');
  assert.equal(a.id, out.id);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'png edit');
});
