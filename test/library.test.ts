// The library's structure (src/entities.ts): entities, slots and versions; slot references in jobs; takes filed when
// a job made for a slot ends. A scratch data folder, no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-lib-'));
const { db, J } = await import('../src/db.ts');
const { submit, getJob, queue } = await import('../src/jobs.ts');
(queue as any).pump = () => {}; // no servers here: jobs stay queued
const { putAsset } = await import('../src/library.ts');
const L = await import('../src/entities.ts');
const { getTool } = await import('../src/tools/index.ts');
const { sha256File } = await import('../src/util.ts');

const owner = { id: 'test', name: 'J', role: 'owner', projects: ['*'] } as any;
const dodOnly = { id: 'dod', name: 'dod tools', role: 'user', projects: ['doseofdestruction'] } as any;

const png = (tag: string) => putAsset({
  data: Buffer.from(`png ${tag}`), ext: '.png', client: 'test', project: 'doseofdestruction', tool: 'file.import',
  recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any,
});

test('an entity with slots: takes, one current per slot, old and discarded', () => {
  const e = L.createEntity(owner, { project: 'doseofdestruction', name: 'Break', kind: 'Character', data: { canon: 'pink power armor' } });
  assert.equal(e.id, 'doseofdestruction/break');
  assert.equal(e.kind, 'character');
  assert.throws(() => L.createEntity(owner, { project: 'doseofdestruction', name: 'Break', kind: 'character' }), /already exists/);

  const v1 = L.addVersion(owner, { entity: e.id, slot: 'side', asset: png('side1').id });
  const v2 = L.addVersion(owner, { entity: e.id, slot: 'side', asset: png('side2').id, note: 'bigger visor' });
  assert.deepEqual([v1.n, v2.n, v1.status], [1, 2, 'take']);
  L.updateVersion(owner, v1.id, { status: 'current' });
  L.updateVersion(owner, v2.id, { status: 'current' });
  const h = L.slotHistory(owner, e.id, 'side');
  assert.deepEqual(h.versions.map((v) => [v.n, v.status]), [[2, 'current'], [1, 'old']]);
  assert.equal(h.versions[0].note, 'bigger visor');
  assert.equal(h.versions[0].file?.kind, 'image');

  L.addVersion(owner, { entity: e.id, slot: 'pose/air', asset: png('air').id, status: 'current' });
  const got = L.getEntity(owner, e.id);
  assert.equal(got.slots.side.current?.n, 2);
  assert.equal(got.slots['pose/air'].current?.n, 1);
  assert.throws(() => L.addVersion(owner, { entity: e.id, slot: 'Pose Air', asset: png('x').id }), /slot is lowercase/);
});

test('updates merge data, and a client only sees its projects', () => {
  const e = L.updateEntity(owner, 'doseofdestruction/break', { data: { look: 'neon', slots: { side: { brief: 'facing right' } } } });
  assert.equal(e.data.canon, 'pink power armor');
  assert.equal(e.data.slots.side.brief, 'facing right');
  L.createEntity(owner, { project: 'phorigins', name: 'Pierce', kind: 'character' });
  assert.equal(L.listEntities(dodOnly).items.every((x) => x.project === 'doseofdestruction'), true);
  assert.throws(() => L.getEntity(dodOnly, 'phorigins/pierce'), /No entity/);
  assert.equal(L.listEntities(owner, { kind: 'character' }).total, 2);
});

test('slot references: current, a version number, latest, "./" inside an entity; deep in chain params', () => {
  const cur = L.resolveSlotRef(owner, 'slot:doseofdestruction/break/side');
  assert.equal(cur.version.n, 2);
  assert.equal(L.resolveSlotRef(owner, 'slot:doseofdestruction/break/side@1').version.n, 1);
  assert.equal(L.resolveSlotRef(owner, 'slot:./pose/air', 'doseofdestruction/break').version.slot, 'pose/air');
  assert.throws(() => L.resolveSlotRef(owner, 'slot:doseofdestruction/break/clip/jab'), /no current clip\/jab/);

  const { value, used } = L.expandSlotRefs(owner, { steps: [{ tool: 'video.i2v', inputs: { start: 'slot:./side', end: '$step1:depth' } }] }, 'doseofdestruction/break');
  assert.equal(value.steps[0].inputs.start, `asset:${cur.asset.id}`);
  assert.equal(value.steps[0].inputs.end, '$step1:depth');
  assert.deepEqual(used.map((u) => [u.slot, u.n]), [['side', 2]]);
});

test('a job made for a slot uses its references and files its outputs there as takes', async () => {
  const spec = L.slotJobSpec(owner, {
    entity: 'doseofdestruction/break', slot: 'pose/crouch',
    make: { tool: 'image.edit', params: { prompt: '{name} crouching, {canon}' }, inputs: { images: ['slot:./side'] } },
    feedback: 'lower stance',
  });
  assert.equal((spec.params as any).prompt, 'Break crouching, pink power armor lower stance');
  const job = submit(owner, spec as any);
  assert.equal(job.labels.entity, 'doseofdestruction/break');
  assert.equal((job.labels.madeFrom as any[])[0].slot, 'side');
  assert.ok(String(job.inputs.images[0]).endsWith('.png'));

  // The queue would run it; here it "finishes" with two outputs that carry its recipe, as runJob writes them.
  const tool = getTool('image.edit')!;
  const recipe = { tool: tool.id, version: tool.version, params: job.params, inputs: { images: [await sha256File(job.inputs.images[0])] }, models: tool.models?.(job.params) } as any;
  const outs = ['crouch1', 'crouch2'].map((t, k) => putAsset({ data: Buffer.from(t), ext: '.png', job: job.id, client: 'test', project: 'doseofdestruction', tool: tool.id, seed: k + 1, recipe }))
    .map((a) => ({ asset: a.id, title: null }));
  db.prepare('UPDATE jobs SET status = ?, outputs = ? WHERE id = ?').run('done', J(outs), job.id);
  const filed = L.fileJobOutputs(getJob(job.id)! as any);
  assert.deepEqual(filed.map((v) => [v.slot, v.n, v.status, v.made_from[0]?.slot]), [['pose/crouch', 1, 'take', 'side'], ['pose/crouch', 2, 'take', 'side']]);
  assert.equal(filed[0].note, 'lower stance');
  assert.equal(L.fileJobOutputs(getJob(job.id)! as any).length, 0, 'not filed twice');

  // Handed back by reuse for the same slot: nothing new; for another slot: filed there too.
  const again = submit(owner, { ...(spec as any), reuse: true });
  assert.equal(again.id, job.id);
  assert.equal(L.slotHistory(owner, 'doseofdestruction/break', 'pose/crouch').versions.length, 2);
  submit(owner, { ...(spec as any), labels: { ...spec.labels, slot: 'pose/crouch-alt' }, reuse: true });
  assert.equal(L.slotHistory(owner, 'doseofdestruction/break', 'pose/crouch-alt').versions.length, 2);
});

test('a chain files its saved outputs by slot; revising an image edits it with the feedback', () => {
  const spec = L.slotJobSpec(owner, {
    entity: 'doseofdestruction/break', slot: 'clip/jab',
    make: { steps: [{ tool: 'image.edit', inputs: { images: ['slot:./side'] }, params: { prompt: 'jab' }, save: 'start' }], candidates: 2, saves: { start: 'pose/jab-start', video: 'clip/jab' } },
  });
  assert.equal(spec.tool, 'asset.make');
  assert.deepEqual(spec.labels.slots, { start: 'pose/jab-start', video: 'clip/jab' });
  const filed = L.fileJobOutputs({ id: 'j_x', status: 'done', labels: spec.labels, outputs: [{ asset: png('s').id, title: 'start' }, { asset: png('v').id, title: 'video' }] });
  assert.deepEqual(filed.map((v) => v.slot), ['pose/jab-start', 'clip/jab']);

  const r = L.reviseJobSpec(owner, { entity: 'doseofdestruction/break', slot: 'side', feedback: 'make the visor bigger' });
  assert.equal(r.tool, 'image.edit');
  assert.match(r.params.prompt, /make the visor bigger/);
  assert.equal(r.inputs.images[0], `asset:${L.resolveSlotRef(owner, 'slot:doseofdestruction/break/side').asset.id}`);
  assert.throws(() => L.slotJobSpec(owner, { entity: 'doseofdestruction/break', slot: 'voice/hi' }), /Nothing says how to make/);
});

test("a project's kinds say how slots are made: a fighter's clip from its start pose, the unset end left out", () => {
  const e = L.createEntity(owner, { project: 'doseofdestruction', name: 'Susan', kind: 'fighter', data: { look: 'red jacket', slots: { 'clip/jab': { start: 'side', brief: 'a quick jab' } } } });
  L.addVersion(owner, { entity: e.id, slot: 'side', asset: png('susan-side').id, status: 'current' });
  const spec = L.slotJobSpec(owner, { entity: e.id, slot: 'clip/jab' });
  assert.equal(spec.tool, 'video.i2v');
  assert.deepEqual(Object.keys(spec.inputs), ['start']);
  assert.match((spec.params as any).prompt, /^Susan, red jacket, a quick jab\. Side view/);
  const job = submit(owner, spec as any);
  assert.equal((job.labels.madeFrom as any[])[0].slot, 'side');
  const pose = L.slotJobSpec(owner, { entity: e.id, slot: 'pose/crouch', feedback: 'lower' });
  assert.equal(pose.tool, 'image.edit');
  assert.match((pose.params as any).prompt, /lower$/);
});
