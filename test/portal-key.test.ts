// The hawkesgen.com portal's key: one 'user' key with the pattern project 'usr_*'. On a customer's behalf it narrows
// itself to their project with X-Hawkesgen-Project, so Gen's own checks keep customers apart. Without the header it sees
// every usr_ project (the portal settles credits from the events) and nothing else; internal tools stay closed, and Gen
// charges it no credits (the portal keeps them).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-portal-'));

const { handle } = await import('../src/api.ts');
const { queue } = await import('../src/jobs.ts');
(queue as any).pump = () => {}; // keep submitted jobs queued in offline tests
const { createClient, canProject, fixedProject, projectScopeSql } = await import('../src/auth.ts');
const { putAsset } = await import('../src/library.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

const portal = createClient('hawkesgen.com portal', 'user', ['usr_*']);
const other = createClient('studio', 'user', ['sickofit']);
async function call(route: string, key: string, opts: { body?: unknown; as?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (opts.as) headers['X-Hawkesgen-Project'] = opts.as;
  const r = await fetch(base + route, { method: opts.body ? 'POST' : 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
}
const image = (prompt: string) => ({ tool: 'image.generate', params: { prompt } });

test('patterns: usr_* reaches every usr_ project and nothing else', () => {
  const c = { id: 'x', name: 'x', role: 'user' as const, projects: ['usr_*'] };
  assert.equal(canProject(c, 'usr_abc'), true);
  assert.equal(canProject(c, 'sickofit'), false);
  assert.equal(canProject(c, 'usrabc'), false);
  assert.equal(fixedProject(c), null);
  assert.equal(fixedProject({ ...c, projects: ['usr_abc'] }), 'usr_abc');
  assert.equal(projectScopeSql(['*']), null);
  assert.equal(projectScopeSql(['usr_*', 'shared']), "(project LIKE 'usr\\_%' ESCAPE '\\' OR project IN ('shared'))");
});

test("narrowed to a customer, the portal key submits into their project and sees only their jobs", async () => {
  const a = await call('/v1/jobs', portal.key, { as: 'usr_alice', body: { ...image('a lantern'), project: 'usr_bob' } });
  assert.equal(a.status, 200);
  assert.equal(a.body.jobs[0].project, 'usr_alice');
  const b = await call('/v1/jobs', portal.key, { as: 'usr_bob', body: image('a kettle') });
  await call('/v1/jobs', other.key, { body: { ...image('a slime'), project: 'sickofit' } });

  assert.deepEqual((await call('/v1/jobs', portal.key, { as: 'usr_alice' })).body.jobs.map((j: any) => j.project), ['usr_alice']);
  assert.equal((await call(`/v1/jobs/${b.body.jobs[0].id}`, portal.key, { as: 'usr_alice' })).status, 404);
  assert.equal((await call(`/v1/jobs/${b.body.jobs[0].id}`, portal.key, { as: 'usr_bob' })).status, 200);

  // Narrowing never widens: another product's project, or a bad name, is no key at all.
  assert.equal((await call('/v1/jobs', portal.key, { as: 'sickofit' })).status, 401);
  assert.equal((await call('/v1/jobs', portal.key, { as: "usr_'x" })).status, 401);
  assert.equal((await call('/v1/jobs', other.key, { as: 'usr_alice' })).status, 401);

  // Un-narrowed, the portal sees every customer's jobs (it settles credits from them), never another product's.
  assert.deepEqual((await call('/v1/jobs', portal.key)).body.jobs.map((j: any) => j.project).sort(), ['usr_alice', 'usr_bob']);
  assert.equal((await call('/v1/jobs', portal.key, { body: { ...image('x'), project: 'sickofit' } })).status, 403);
});

test('internal tools stay closed to the portal key', async () => {
  assert.equal((await call('/v1/jobs', portal.key, { as: 'usr_alice', body: { tool: 'unity.build', params: {} } })).status, 403);
});

test("assets: a customer's files are theirs alone", async () => {
  const recipe = { tool: 'image.generate', version: 1, params: {}, inputs: {} };
  const mine = putAsset({ data: Buffer.from('alice'), ext: '.png', client: portal.client.id, project: 'usr_alice', tool: 'image.generate', recipe, title: 'Alice' });
  const bobs = putAsset({ data: Buffer.from('bob'), ext: '.png', client: portal.client.id, project: 'usr_bob', tool: 'image.generate', recipe, title: 'Bob' });
  const theirs = putAsset({ data: Buffer.from('slime'), ext: '.png', client: other.client.id, project: 'sickofit', tool: 'image.generate', recipe, title: 'Slime' });
  const list = await call('/v1/assets', portal.key, { as: 'usr_alice' });
  assert.equal(list.status, 200);
  const ids = (list.body.items ?? list.body).map((x: any) => x.id);
  assert.ok(ids.includes(mine.id));
  assert.ok(!ids.includes(bobs.id) && !ids.includes(theirs.id));
  for (const id of [bobs.id, theirs.id]) assert.ok([403, 404].includes((await call(`/v1/assets/${id}`, portal.key, { as: 'usr_alice' })).status));
  assert.equal((await call(`/v1/assets/${mine.id}`, portal.key, { as: 'usr_alice' })).status, 200);
});

test("a queued job's place in line counts the jobs ahead in its lane, never what they are", async () => {
  const first = await call('/v1/jobs', portal.key, { as: 'usr_queue', body: image('first') });
  const second = await call('/v1/jobs', portal.key, { as: 'usr_queue', body: image('second') });
  const a = await call(`/v1/jobs/${first.body.jobs[0].id}`, portal.key, { as: 'usr_queue' });
  const b = await call(`/v1/jobs/${second.body.jobs[0].id}`, portal.key, { as: 'usr_queue' });
  assert.equal(b.body.queue.lane, 'gpu');
  assert.equal(b.body.queue.ahead, a.body.queue.ahead + 1);
  assert.deepEqual(Object.keys(b.body.queue).sort(), ['ahead', 'lane']);
});
