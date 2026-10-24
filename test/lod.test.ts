// The LOD system (src/lod.ts): levels belong to their asset (asset_lods), the asset.lod job and its lane, ?lod= on the
// file route (largest level <= n, else the smallest; content-addressed caching), linking a job's own low copy to its
// model (and hiding it from lists), and the backfill queueing each asset once. A scratch data folder and a random port;
// the image and model work really runs (Pillow from the .venv, gltf-transform), skipped without the .venv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-lod-'));
const { db } = await import('../src/db.ts');
const { putAsset, listAssets, deleteAsset } = await import('../src/library.ts');
const lod = await import('../src/lod.ts');
const { queue, getJob } = await import('../src/jobs.ts');
const { handle } = await import('../src/api.ts');
const { Document, NodeIO } = await import('@gltf-transform/core');

const python = [path.join('.venv', 'Scripts', 'python.exe'), path.join('.venv', 'bin', 'python')].find((p) => fs.existsSync(p));
const pillow = python && spawnSync(python, ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;

// The queue doesn't run anything by itself here: the tests run the work (makeLods) and drive fill() by hand.
const q = queue as any;
q.pump = () => {};
const started: string[] = [];
q.runJob = (j: { id: string }) => { started.push(j.id); db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(j.id); return new Promise(() => {}); };

/** A real PNG: w x h, RGBA with a soft alpha edge (like a sprite) or RGB. */
function png(w: number, h: number, alpha = false) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * ch + 1) + 1 + x * ch;
    raw[o] = (x * 7 + y * 3) & 255; raw[o + 1] = (x ^ y) & 255; raw[o + 2] = (y * 5) & 255;
    if (alpha) raw[o + 3] = x < w / 4 ? 0 : 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A GLB: a grid of n x n quads with a w px texture inside. */
async function glb(n: number, texPx: number) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { pos.push(i / n, Math.sin(i * 0.7) * Math.cos(j * 0.5) * 0.1, j / n); uv.push(i / n, j / n); }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * (n + 1) + i; idx.push(k, k + n + 1, k + 1, k + 1, k + n + 1, k + n + 2); }
  const tex = doc.createTexture('base').setImage(new Uint8Array(png(texPx, texPx))).setMimeType('image/png');
  const mat = doc.createMaterial('m').setBaseColorTexture(tex);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buf))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buf))
    .setMaterial(mat);
  const mesh = doc.createMesh('grid').addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('grid').setMesh(mesh));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

const recipe = { tool: 'test', version: 1, params: {}, inputs: {} };
const image = (w: number, h: number, o: { alpha?: boolean; project?: string; job?: string | null } = {}) =>
  putAsset({ data: png(w, h, o.alpha), ext: '.png', client: 'test', project: o.project ?? 'sandbox', tool: 'test', recipe, job: o.job ?? null });

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

test('an image gets its levels with the asset: power-of-two sizes, its shape kept, WebP; one id', async (t) => {
  if (!pillow) return t.skip('no .venv with Pillow');
  const sky = image(1200, 600);
  await lod.makeLods([sky.id]);
  const s = lod.lodSummary(sky.id)!;
  assert.equal(s.kind, 'image');
  assert.equal(s.state, 'done');
  assert.deepEqual(s.size, [1200, 600]);
  assert.deepEqual(s.levels.map((l) => l.level), [128, 256, 512, 1024, 1200], 'every power of two below, then the full size as WebP');
  assert.deepEqual([s.levels[1].w, s.levels[1].h], [256, 128], 'a 2:1 sky stays 2:1');
  for (const l of s.levels) assert.ok(l.bytes > 0 && l.sha.length === 16);
  // Levels aren't assets: the library still lists one thing.
  assert.equal(listAssets({ project: 'sandbox' }).items.filter((a) => a.id === sky.id).length, 1);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM assets').get() as any).n), 1);
  // Doing it again makes nothing new.
  const before = db.prepare('SELECT sha256 FROM asset_lods WHERE asset = ? ORDER BY level').all(sky.id);
  await lod.makeLods([sky.id]);
  assert.deepEqual(db.prepare('SELECT sha256 FROM asset_lods WHERE asset = ? ORDER BY level').all(sky.id), before);

  // A sprite keeps its transparency.
  const sprite = image(300, 300, { alpha: true });
  await lod.makeLods([sprite.id]);
  const row = db.prepare('SELECT path FROM asset_lods WHERE asset = ? AND level = 128').get(sprite.id) as { path: string };
  const r = spawnSync(python!, ['-c', `from PIL import Image; im = Image.open(r'${row.path}'); print(im.mode, im.getextrema()[3][0])`], { encoding: 'utf8' });
  assert.match(r.stdout.trim(), /^RGBA 0$/);
});

test('GET /file?lod=n: the largest level at most n, else the smallest; immutable when the link names the file', async (t) => {
  if (!pillow) return t.skip('no .venv with Pillow');
  const a = image(1200, 600);
  await lod.makeLods([a.id]);
  const s = lod.lodSummary(a.id)!;
  const get = (qs: string, headers: Record<string, string> = {}) => fetch(`${base}/v1/assets/${a.id}/file${qs}`, { headers });
  let r = await get('?lod=300');
  assert.equal(r.headers.get('x-lod-level'), '256');
  assert.equal(r.headers.get('content-type'), 'image/webp');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=300');
  assert.equal(Number(r.headers.get('content-length')), s.levels[1].bytes);
  r = await get('?lod=50');
  assert.equal(r.headers.get('x-lod-level'), '128', 'smaller than every level: the smallest');
  r = await get('?lod=99999');
  assert.equal(r.headers.get('x-lod-level'), '1200', 'the full-size WebP stands in for the PNG');
  r = await get('');
  assert.equal(r.headers.get('content-type'), 'image/png', 'no lod: the original');
  // Versioned: cached for good, and a revalidation is a 304.
  r = await get(`?lod=256&v=${s.levels[1].sha}`);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const etag = r.headers.get('etag')!;
  await r.arrayBuffer();
  r = await get('?lod=256', { 'If-None-Match': etag });
  assert.equal(r.status, 304);
  // The asset carries its summary; many at once in one request.
  const one = await (await fetch(`${base}/v1/assets/${a.id}`)).json();
  assert.equal(one.lods.levels.length, 5);
  const many = await (await fetch(`${base}/v1/lods?ids=${a.id},a_0000000000000000`)).json();
  assert.deepEqual(Object.keys(many.lods), [a.id]);
});

test('pickLod: the original when asked for more than the biggest level and the original is bigger', () => {
  const a = image(64, 64);
  db.prepare("INSERT INTO asset_lod_state (asset, version, state, width, height, updated) VALUES (?, 1, 'done', 4096, 4096, 0)").run(a.id);
  for (const level of [128, 2048]) db.prepare("INSERT INTO asset_lods (asset, level, mime, bytes, path, sha256, created) VALUES (?, ?, 'image/webp', 1, ?, 'x', 0)").run(a.id, level, `/x/${level}`);
  assert.equal(lod.pickLod(a.id, 2048)!.level, 2048);
  assert.equal(lod.pickLod(a.id, 1000)!.level, 128);
  assert.equal(lod.pickLod(a.id, 4096), null, 'the 4096 original');
  assert.equal(lod.pickLod(a.id, 0), null);
  deleteAsset(a.id);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM asset_lods WHERE asset = ?').get(a.id) as any).n), 0, 'its levels go with it');
});

test('a model: a low (fewer triangles, small textures) and a mid, on the CPU; the 4096 px texture gets a high at 2048', async (t) => {
  if (!pillow) return t.skip('no .venv with Pillow');
  const m = putAsset({ data: await glb(60, 4096), ext: '.glb', mime: 'model/gltf-binary', client: 'test', project: 'sandbox', tool: 'test', recipe });
  await lod.makeLods([m.id]);
  const s = lod.lodSummary(m.id)!;
  assert.equal(s.kind, 'mesh');
  assert.equal(s.tris, 7200);
  assert.equal(s.tex, 4096);
  const by = Object.fromEntries(s.levels.map((l) => [l.role, l]));
  assert.ok(by.low && by.low.tris! < 7200 * 0.3, `low: ${by.low?.tris} triangles`);
  assert.ok(by.low.tex! <= 256);
  assert.ok(by.mid && by.mid.tex! <= 1024);
  assert.equal(by.high.tris, 7200, 'every triangle');
  assert.equal(by.high.tex, 2048);
  // ?lod= for models counts triangles: the low for anything below the mid.
  assert.equal(lod.pickLod(m.id, by.low.tris! + 1)!.level, by.low.tris);
});

test("linking: a job's own low copy (model.lod1) becomes its model's, and isn't listed", () => {
  db.prepare("INSERT INTO jobs (id, client, project, tool, params, inputs, status, created) VALUES ('j_link', 'test', 'usr_link000000000000', 'asset.make', '{}', '{}', 'done', 0)").run();
  const put = (title: string, size: number) => putAsset({ data: Buffer.alloc(size, 1), ext: '.glb', mime: 'model/gltf-binary', client: 'test', project: 'usr_link000000000000', tool: 'asset.make', recipe, job: 'j_link', title });
  const high = put('model.high', 5000);
  const low = put('model.lod1', 500);
  const pic = image(64, 64, { job: 'j_link', project: 'usr_link000000000000' });
  const r = lod.afterJob({ id: 'j_link', tool: 'asset.make', labels: {}, outputs: [high, low, pic].map((a) => ({ asset: a.id, mime: a.mime, title: a.title })) });
  assert.equal(r.linked, 1);
  assert.deepEqual(db.prepare('SELECT low, asset FROM asset_lod_links').all().map((x: any) => ({ ...x })), [{ low: low.id, asset: high.id }]);
  const listed = listAssets({ project: 'usr_link000000000000', tool: 'asset.make' }).items.map((a) => a.id);
  assert.ok(listed.includes(high.id) && !listed.includes(low.id), 'the low belongs to the model');
  // The model and the picture are queued for their levels; the low isn't (it is the model's).
  const states = Object.fromEntries((db.prepare('SELECT asset, state FROM asset_lod_state WHERE asset IN (?, ?, ?)').all(high.id, low.id, pic.id) as any[]).map((x) => [x.asset, x.state]));
  assert.equal(states[high.id], 'queued');
  assert.equal(states[pic.id], 'queued');
  assert.equal(states[low.id], undefined);
  // A pipeline's step job (labels.parent) links but queues nothing: its outputs are intermediate.
  assert.equal(lod.afterJob({ id: 'j_step', tool: 'image.edit', labels: { parent: 'j_link' }, outputs: [{ asset: image(64, 64).id, mime: 'image/png' }] }).queued, 0);
});

test('backfill queues each asset once, as asset.lod jobs of Gen (low priority, its own project, not charged)', async () => {
  await lod.flushLods(); // (what the tests above queued)
  db.exec('DELETE FROM asset_lod_state');
  const a = image(300, 200, { project: 'usr_00000000000000c0' });
  const b = image(300, 200, { project: 'other' });
  const first = lod.backfillLods({ project: 'usr_00000000000000c0' });
  assert.equal(first.queued, 1);
  const jobs = await lod.flushLods();
  assert.equal(jobs.length, 1);
  const j = getJob(jobs[0])!;
  assert.equal(j.tool, 'asset.lod');
  assert.equal(j.project, lod.LOD_PROJECT);
  assert.equal(j.client, 'gen');
  assert.equal(j.priority, -10);
  assert.deepEqual(j.params.assets, [a.id]);
  assert.equal(lod.backfillLods({ project: 'usr_00000000000000c0' }).queued, 0, 'queued already: nothing twice');
  // A project whose games don't load levels (settings.lod.projects: usr_*, ubeta_*): nothing automatic, asked for by id yes.
  lod.backfillLods();
  assert.equal(db.prepare('SELECT state FROM asset_lod_state WHERE asset = ?').get(b.id), undefined, "another product's image gets none on its own");
  assert.equal(lod.queueLods([b.id], { asked: true }), 1, 'asked for by id: made');
  await lod.flushLods();
});

test('the lod lane: one at a time, and only while no customer CPU job runs or waits', async () => {
  db.exec("UPDATE jobs SET status = 'done'");
  started.length = 0;
  const owner = { id: 'test', name: 'test', role: 'owner', projects: ['*'] } as any;
  const { submit } = await import('../src/jobs.ts');
  const l1 = submit(lod.LOD_CLIENT as any, { tool: 'asset.lod', project: lod.LOD_PROJECT, params: { assets: ['a_1'] }, priority: -10 } as any);
  const l2 = submit(lod.LOD_CLIENT as any, { tool: 'asset.lod', project: lod.LOD_PROJECT, params: { assets: ['a_2'] }, priority: -10 } as any);
  const customer = submit(owner, { tool: 'image.transform', project: 'usr_0000000000000001', params: { ops: [{ op: 'grayscale' }] }, inputs: { image: `asset:${image(32, 32).id}` } } as any);
  await q.fill();
  assert.ok(started.includes(customer.id), "the customer's job runs");
  assert.ok(!started.includes(l1.id) && !started.includes(l2.id), 'LOD work waits while it runs');
  assert.match(String(getJob(l1.id)!.detail), /local jobs go first/);
  q.lanes.get('local')?.clear();
  db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(customer.id);
  await q.fill();
  assert.ok(started.includes(l1.id), 'then one LOD job');
  assert.ok(!started.includes(l2.id), 'one at a time');
  // Users can't submit it themselves.
  const user = { id: 'u', name: 'u', role: 'user', projects: ['usr_*'] } as any;
  assert.throws(() => submit(user, { tool: 'asset.lod', project: 'usr_0000000000000001', params: { assets: [] } } as any), /internal-only/);
});

test("in-between work gets no levels: of an asset.make chain only the first step's picture and the last step's result; prune clears the rest here and in S3", async (t) => {
  const storage = await import('../src/storage.ts');
  const objects = new Map<string, number>();
  const deleted: string[] = [];
  storage.setStore({ async has(k) { return objects.has(k); }, async put(k, _f, size) { objects.set(k, size); }, async get() {}, async del(keys) { for (const k of keys) { deleted.push(k); objects.delete(k); } } });
  t.after(() => storage.setStore(null));
  const job = 'j_make_lodtest';
  const step = (n: number, save: string, title: string, from?: string) => putAsset({ data: png(300, 300 + n), ext: '.png', client: 'test', project: 'usr_chain0000000000', tool: 'asset.make', recipe, job, title, meta: { save, step: n, ...(from ? { from } : {}) } });
  // A best-of-3 pick saves its candidates first (step 1), then the cutout (a background-removal step's picture and mask).
  const candidate = step(1, 'picked', 'picked');
  const src = image(300, 300, { project: 'usr_chain0000000000' });
  const mask = image(300, 301, { project: 'usr_chain0000000000' });
  db.prepare("UPDATE assets SET tool = 'image.remove-background', title = 'cutout' WHERE id = ?").run(src.id);
  db.prepare("UPDATE assets SET tool = 'image.remove-background', title = 'mask' WHERE id = ?").run(mask.id);
  const cutout = step(2, 'cutout', 'cutout', src.id);
  const maskOut = step(2, 'cutout', 'cutout', mask.id);
  const view = step(3, 'views', 'views');
  const result = step(5, 'texture', 'texture');
  assert.deepEqual([candidate, cutout, maskOut, view, result].map((a) => lod.kept(a)), [false, true, false, false, true]);
  // A finished chain queues only its ends.
  db.exec('DELETE FROM asset_lod_state');
  const q1 = lod.afterJob({ id: job, tool: 'asset.make', outputs: [candidate, cutout, maskOut, view, result].map((a) => ({ asset: a.id, mime: a.mime, title: a.title })) });
  assert.equal(q1.queued, 2);
  await lod.flushLods();
  if (!pillow) return t.skip('no .venv with Pillow (the prune half needs real levels)');
  // Levels made for the view before this rule (as the old backfill did): the prune clears them, files and S3 copies.
  await lod.makeLods([view.id, result.id]);
  await storage.idle();
  const viewLevels = db.prepare('SELECT path, sha256 FROM asset_lods WHERE asset = ?').all(view.id) as { path: string; sha256: string }[];
  assert.ok(viewLevels.length > 0);
  const dry = await lod.pruneLods({ project: 'usr_chain0000000000', dryRun: true });
  assert.equal(dry.assets, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asset_lods WHERE asset = ?').get(view.id)!.n, viewLevels.length, 'a dry run changes nothing');
  const r = await lod.pruneLods({ project: 'usr_chain0000000000' });
  assert.equal(r.assets, 1);
  assert.equal(r.levels, viewLevels.length);
  assert.equal(r.s3, viewLevels.length);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asset_lods WHERE asset = ?').get(view.id)!.n, 0);
  for (const l of viewLevels) { assert.ok(!fs.existsSync(l.path)); assert.ok(deleted.includes(storage.keyOf(l.sha256))); }
  assert.ok((db.prepare('SELECT COUNT(*) AS n FROM asset_lods WHERE asset = ?').get(result.id) as any).n > 0, 'the result keeps its levels');
  assert.equal((db.prepare('SELECT state FROM asset_lod_state WHERE asset = ?').get(view.id) as any).state, 'pruned');
  // The route answers with its own numbers (the status beside them, not over them).
  const route = await (await fetch(`${base}/v1/lods/prune`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'usr_chain0000000000', dryRun: true }) })).json();
  assert.equal(route.assets, 0, 'nothing left to clear');
  assert.equal(route.levels, 0);
  assert.equal(typeof route.status.levels, 'number');
  // Asked for by id (it's used after all): made again.
  assert.equal(lod.queueLods([view.id], { asked: true }), 1);
  assert.equal(lod.queueLods([view.id]), 0, 'already queued');
  await lod.flushLods();
});
