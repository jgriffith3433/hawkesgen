// Customers can't see or use each other's work (docs/platform: Phase 0). Two hawkesgen.ai customers behind the portal's
// one key (narrowed per call with X-Hawkesgen-Project, as the portal does) and a customer's own key try every door
// that once leaked: another's blob, another's asset through recipes/check, server paths, presets, usage, the studio's
// machinery, and raising their own priority. A scratch data folder and a random port; no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-tenancy-'));
const { handle, isCustomer } = await import('../src/api.ts');
const { createClient } = await import('../src/auth.ts');
const { db } = await import('../src/db.ts');
const { fairOrder } = await import('../src/jobs.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

const portal = createClient('hawkesgen.ai portal (test)', 'user', ['usr_*']).key;
const own = createClient('a customer (test)', 'user', ['usr_cccc']).key;
const studio = createClient('studio (test)', 'admin', ['*']).key;

const call = (key: string, route: string, init: { method?: string; body?: any; project?: string; raw?: Buffer } = {}) =>
  fetch(base + route, {
    method: init.method ?? (init.body || init.raw ? 'POST' : 'GET'),
    headers: {
      authorization: `Bearer ${key}`,
      ...(init.project ? { 'x-hawkesgen-project': init.project } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.raw ? new Uint8Array(init.raw) : init.body ? JSON.stringify(init.body) : undefined,
  });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) as any });

test('a blob is usable only by whoever uploaded it', async () => {
  const up = await json(await call(portal, '/v1/blobs', { project: 'usr_aaaa', raw: Buffer.from('aaaa secret level') }));
  assert.equal(up.status, 200);
  const blob = up.body.blob as string;
  // Customer B names A's blob as a job input: as if it didn't exist.
  const b = await json(await call(portal, '/v1/jobs', { project: 'usr_bbbb', body: { tool: 'media.probe', inputs: { file: blob } } }));
  assert.equal(b.status, 404, JSON.stringify(b.body));
  assert.match(b.body.error, /No blob/);
  // recipes/check with A's blob: B gets nothing back about it.
  const rc = await json(await call(portal, '/v1/recipes/check', { project: 'usr_bbbb', body: { tool: 'media.probe', inputs: { file: blob } } }));
  assert.equal(rc.status, 200);
  assert.equal(rc.body.asset, null);
  // A itself may (the job is accepted; whether media.probe runs here doesn't matter).
  const a = await json(await call(portal, '/v1/jobs', { project: 'usr_aaaa', body: { tool: 'media.probe', inputs: { file: blob } } }));
  assert.notEqual(a.status, 404, JSON.stringify(a.body));
  // The studio's admin key sees every project's blobs, as before.
  const s = await json(await call(studio, '/v1/jobs', { body: { tool: 'media.probe', project: 'sandbox', inputs: { file: blob } } }));
  assert.notEqual(s.status, 404, JSON.stringify(s.body));
});

test('recipes/check never returns another customer\'s asset or hashes server files', async () => {
  // An asset of customer A's, as an upload makes it.
  const up = await json(await call(portal, '/v1/assets?title=a.txt', { project: 'usr_aaaa', raw: Buffer.from('aaaa asset') }));
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const recipe = { tool: 'file.import', params: { title: 'a.txt' }, inputs: {} };
  const asB = await json(await call(portal, '/v1/recipes/check', { project: 'usr_bbbb', body: recipe }));
  assert.equal(asB.body.asset, null);
  const otherProject = await json(await call(portal, '/v1/recipes/check', { project: 'usr_bbbb', body: { ...recipe, project: 'usr_aaaa' } }));
  assert.equal(otherProject.status, 403);
  const paths = await json(await call(own, '/v1/recipes/check', { body: { tool: 'media.probe', inputs: { file: path.join(process.env.HAWKESGEN_DATA_DIR!, 'hawkesgen.db') } } }));
  assert.equal(paths.status, 403);
});

test('presets and usage are a customer\'s own', async () => {
  db.prepare('INSERT INTO usage (at, client, project, job, provider, unit, amount, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(Date.now(), 'x', 'usr_aaaa', null, 'anthropic', 'tokens', 10, 1.5);
  db.prepare('INSERT INTO usage (at, client, project, job, provider, unit, amount, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(Date.now(), 'x', 'doseofdestruction', null, 'anthropic', 'tokens', 10, 9);
  const u = await json(await call(own, '/v1/usage'));
  assert.equal(u.status, 200);
  assert.equal(u.body.total, 0);
  assert.ok(u.body.rows.every((r: any) => r.grp === 'usr_cccc'), JSON.stringify(u.body.rows));
  const ua = await json(await call(portal, '/v1/usage', { project: 'usr_aaaa' }));
  assert.equal(ua.body.total, 1.5);
  const all = await json(await call(studio, '/v1/usage'));
  assert.ok(all.body.total >= 10.5);
  const p = await json(await call(own, '/v1/presets'));
  assert.ok(p.body.projects.every((x: any) => x.project === 'shared' || x.project === 'usr_cccc'), JSON.stringify(p.body.projects.map((x: any) => x.project)));
});

test('the studio\'s machinery is closed to customers', async () => {
  for (const route of ['/v1/settings', '/v1/fleet', '/v1/machines', '/v1/storage', '/v1/clients', '/v1/workflows', '/v1/playtests/live', '/v1/claude/accounts', '/v1/gpu/providers']) {
    const r = await call(own, route);
    assert.equal(r.status, 403, route);
  }
  assert.equal((await call(studio, '/v1/settings')).status, 200);
  // The studio's own products' user keys (not customer projects) are not customers.
  assert.equal(isCustomer({ id: 'c', name: 'dod', role: 'user', projects: ['doseofdestruction'] }), false);
  assert.equal(isCustomer({ id: 'c', name: 'portal', role: 'user', projects: ['usr_*'] }), true);
});

test('a customer can\'t raise its own jobs\' priority', async () => {
  const r = await json(await call(own, '/v1/jobs', { body: { tool: 'llm.text', params: { prompt: 'hi' }, priority: 10 } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.jobs[0].id;
  assert.equal((db.prepare('SELECT priority FROM jobs WHERE id = ?').get(id) as any).priority, 0);
  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(id);
});

test('lanes alternate between customers (fairOrder with no cap)', () => {
  const t = Date.now();
  const open = [
    ...[1, 2, 3].map((i) => ({ id: `a${i}`, project: 'usr_a', family: null, priority: 0, created: t + i, exempt: false })),
    { id: 'b1', project: 'usr_b', family: null, priority: 0, created: t + 10, exempt: false },
  ];
  assert.deepEqual(fairOrder(open, new Map([['usr_a', 1]]), Infinity).map((j) => j.id), ['b1', 'a1', 'a2', 'a3']);
});
