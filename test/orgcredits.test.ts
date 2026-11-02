// A customer Studio's jobs paid from its balance in Studio's control plane (src/orgcredits.ts): Gen charges a cell's
// key (role user, org_<hex> and org_<hex>.*, no Gen account) before the job exists, refuses at 402 with the control
// plane's words, refuses when it can't reach it (fail closed), refunds a failed or cancelled job once, charges nothing
// for a job handed back (reuse, the same key), never touches owner or other keys, and an MCP job is charged the same.
// A stand-in control plane on a random port; a scratch data folder; no GPU (the queue doesn't run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-orgcredits-'));
// /mcp calls Gen at 127.0.0.1:PORT: the test server listens there.
const free = http.createServer();
await new Promise<void>((r) => free.listen(0, '127.0.0.1', () => r()));
process.env.HAWKESGEN_PORT = String((free.address() as any).port);
await new Promise<void>((r) => free.close(() => r()));

// The stand-in control plane: a balance per org, charges once per job, refunds once.
const KEY = 'test-gen-to-control-key';
const ORG = 'org_00112233aabbccdd';
const state = { balance: new Map<string, number>([[ORG, 50]]), charges: new Map<string, number>(), refunds: [] as string[], calls: [] as any[], down: false };
const control = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const b = raw ? JSON.parse(raw) : {};
  state.calls.push({ url: req.url, auth: req.headers.authorization, body: b });
  const send = (s: number, j: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (state.down) return send(503, { error: 'down' });
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'gen key' });
  if (!state.balance.has(b.genOrg)) return send(404, { error: 'No studio has that Gen org' });
  const have = state.balance.get(b.genOrg)!;
  if (req.url === '/api/cells/gen/charge') {
    if (state.charges.has(b.job)) return send(200, { ok: true, duplicate: true, credits: have });
    if (have < b.credits) return send(402, { error: `This studio is out of credits: ${b.tool} needs ${b.credits} and ${have} are left. Add credits or upgrade your plan in Settings → Plan and credits.`, credits: { need: b.credits, have, topUp: true } });
    state.balance.set(b.genOrg, have - b.credits);
    state.charges.set(b.job, b.credits);
    return send(200, { ok: true, duplicate: false, credits: have - b.credits });
  }
  if (req.url === '/api/cells/gen/refund') {
    const c = state.charges.get(b.job);
    if (!c) return send(404, { error: 'No such charge' });
    if (state.refunds.includes(b.job)) return send(200, { ok: true, refunded: 0, credits: have });
    state.refunds.push(b.job);
    state.balance.set(b.genOrg, have + c);
    return send(200, { ok: true, refunded: c, credits: have + c });
  }
  send(404, {});
});
await new Promise<void>((r) => control.listen(0, '127.0.0.1', () => r()));
process.env.HAWKESGEN_ORG_CREDITS_URL = `http://127.0.0.1:${(control.address() as any).port}`;
process.env.HAWKESGEN_ORG_CREDITS_KEY = KEY;

const { handle } = await import('../src/api.ts');
const { createClient } = await import('../src/auth.ts');
const { getJob, failJob, cancel, queue } = await import('../src/jobs.ts');
const { quoteJobCredits } = await import('../src/billing.ts');
const { settleOrgCharges } = await import('../src/orgcredits.ts');
const { db } = await import('../src/db.ts');
(queue as any).pump = () => {}; // no servers here: jobs stay queued

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(Number(process.env.HAWKESGEN_PORT), '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${process.env.HAWKESGEN_PORT}`;
test.after(() => { server.close(); control.close(); });

const cell = createClient('Hawkes Studio cell acme (test)', 'user', [ORG, `${ORG}.*`]).key;
const owner = createClient('owner (test)', 'owner', ['*']).key;
const game = createClient('a studio game (test)', 'user', ['doseofdestruction']).key;

const call = async (key: string, route: string, body?: unknown) => {
  const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const price = (prompt: string) => quoteJobCredits({ project: `${ORG}.game`, tool: 'image.generate', params: { prompt } }).credits;
const charges = () => state.calls.filter((c) => c.url === '/api/cells/gen/charge');
const balance = () => state.balance.get(ORG)!;

test('health says Gen charges orgs, and the key is never in the settings', async () => {
  const h = await call(owner, '/v1/health');
  assert.equal(h.body.orgCredits, true);
  const s = await call(owner, '/v1/settings');
  assert.ok(!JSON.stringify(s.body).includes(KEY));
});

test("a cell's job is charged to its org before it exists, at Gen's own price", async () => {
  const before = balance(), n = charges().length;
  const need = price('a red door');
  assert.ok(need > 0 && need <= before, `price ${need}`);
  const r = await call(cell, '/v1/jobs', { tool: 'image.generate', project: `${ORG}.game`, params: { prompt: 'a red door' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const job = r.body.jobs[0];
  assert.equal(job.labels.orgCredits, need);
  const c = charges().slice(n);
  assert.equal(c.length, 1);
  assert.deepEqual({ ...c[0].body }, { genOrg: ORG, credits: need, job: job.id, tool: 'image.generate' });
  assert.equal(c[0].auth, `Bearer ${KEY}`);
  assert.equal(balance(), before - need);
});

test('a failed job is refunded once; a cancelled one too', async () => {
  const r = await call(cell, '/v1/jobs', { tool: 'image.generate', project: `${ORG}.game`, params: { prompt: 'fails' } });
  const id = r.body.jobs[0].id;
  const before = balance();
  failJob(id, 'boom');
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal(balance(), before + price('fails'));
  await settleOrgCharges((j) => getJob(j)?.status ?? null);
  assert.equal(state.refunds.filter((x) => x === id).length, 1, 'refunded once');
  const r2 = await call(cell, '/v1/jobs', { tool: 'image.generate', project: `${ORG}.game`, params: { prompt: 'cancelled' } });
  const b2 = balance();
  cancel(r2.body.jobs[0].id);
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal(balance(), b2 + price('cancelled'));
});

test('a refund the control plane missed is given back by the settler', async () => {
  const r = await call(cell, '/v1/jobs', { tool: 'image.generate', project: `${ORG}.game`, params: { prompt: 'late refund' } });
  const id = r.body.jobs[0].id;
  state.down = true;
  failJob(id, 'boom');
  await new Promise((ok) => setTimeout(ok, 200));
  assert.ok(!state.refunds.includes(id));
  state.down = false;
  const done = await settleOrgCharges((j) => getJob(j)?.status ?? null);
  assert.ok(done.includes(id));
  assert.ok(state.refunds.includes(id));
});

test('short: 402 kind credits with the control plane\'s words, and no job', async () => {
  state.balance.set(ORG, 0);
  const jobsBefore = (db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n;
  const r = await call(cell, '/v1/jobs', { tool: 'image.generate', project: `${ORG}.game`, params: { prompt: 'too poor' } });
  assert.equal(r.status, 402);
  assert.equal(r.body.kind, 'credits');
  assert.match(r.body.error, /This studio is out of credits: image\.generate needs \d+ and 0 are left/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n, jobsBefore);
  state.balance.set(ORG, 1000);
});

test('the control plane unreachable: refused (fail closed), no job', async () => {
  state.down = true;
  const jobsBefore = (db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n;
  const r = await call(cell, '/v1/jobs', { tool: 'image.generate', project: `${ORG}.game`, params: { prompt: 'offline' } });
  state.down = false;
  assert.equal(r.status, 503);
  assert.equal(r.body.kind, 'credits');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n, jobsBefore);
  const saved = process.env.HAWKESGEN_ORG_CREDITS_URL;
  process.env.HAWKESGEN_ORG_CREDITS_URL = 'http://127.0.0.1:1';
  const r2 = await call(cell, '/v1/jobs', { tool: 'image.generate', project: `${ORG}.game`, params: { prompt: 'no route' } });
  process.env.HAWKESGEN_ORG_CREDITS_URL = saved;
  assert.equal(r2.status, 503);
  assert.match(r2.body.error, /couldn't reach the studio's billing/);
});

test('a job handed back by the same key costs nothing; a rerun is charged', async () => {
  const first = await call(cell, '/v1/jobs', { tool: 'image.generate', project: `${ORG}.game`, params: { prompt: 'keyed' }, key: 'k-1' });
  const n = charges().length, b = balance();
  const again = await call(cell, '/v1/jobs', { tool: 'image.generate', project: `${ORG}.game`, params: { prompt: 'keyed' }, key: 'k-1' });
  assert.equal(again.body.jobs[0].id, first.body.jobs[0].id);
  assert.equal(charges().length, n);
  assert.equal(balance(), b);
  const rr = await call(cell, `/v1/jobs/${first.body.jobs[0].id}/rerun`, {});
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  assert.equal(charges().length, n + 1);
  assert.equal(charges().at(-1).body.job, rr.body.id);
});

test('owner keys, J\'s game keys and Gen itself are never charged', async () => {
  const n = charges().length;
  assert.equal((await call(owner, '/v1/jobs', { tool: 'image.generate', project: `${ORG}.game`, params: { prompt: 'J' } })).status, 200);
  assert.equal((await call(owner, '/v1/jobs', { tool: 'image.generate', project: 'sandbox', params: { prompt: 'J' } })).status, 200);
  assert.equal((await call(game, '/v1/jobs', { tool: 'image.generate', params: { prompt: 'game' } })).status, 200);
  assert.equal(charges().length, n);
});

test('an MCP job (hawkesgen_run over /mcp with the cell key) is charged too', async () => {
  const n = charges().length;
  const r = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${cell}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hawkesgen_run', arguments: { tool: 'image.generate', project: `${ORG}.mcp`, params: { prompt: 'via mcp' }, wait: false, reuse: false } } }),
  });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  assert.equal(charges().length, n + 1, text);
  assert.equal(charges().at(-1).body.genOrg, ORG);
});

test('a Unity customer build is charged its flat price (per machine size) the same way', async () => {
  const n = charges().length;
  const params = { github: { repo: 'acme/rocket-game', commit: 'c'.repeat(40), token: 'ghs_customerInstallationToken0123456789', ref: 'refs/heads/main' }, target: 'web', out: 'artifact' };
  const r = await call(cell, '/v1/jobs', { tool: 'unity.build', project: `${ORG}.rocket`, params });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(charges().length, n + 1);
  assert.equal(charges().at(-1).body.credits, 50, 'the default size, m (4 vCPU, 16 GiB): half of the full machine');
  assert.equal(charges().at(-1).body.tool, 'unity.build');
  const big = await call(cell, '/v1/jobs', { tool: 'unity.build', project: `${ORG}.rocket`, params: { ...params, machine: 'xl' } });
  assert.equal(big.status, 200, JSON.stringify(big.body));
  assert.equal(charges().at(-1).body.credits, 100);
});

test("Studio's public names are called on Cloud Run directly, never through Cloudflare", async () => {
  const { directControlUrl } = await import('../src/orgcredits.ts');
  assert.equal(directControlUrl('https://studio.hawkesgen.ai'), 'https://studio-388576319982.us-east4.run.app');
  assert.equal(directControlUrl('https://studio-beta.hawkesgen.ai'), 'https://studio-beta-388576319982.us-central1.run.app');
  assert.equal(directControlUrl('http://127.0.0.1:9'), 'http://127.0.0.1:9');
  process.env.HAWKESGEN_ORG_CREDITS_DIRECT = '0';
  try { assert.equal(directControlUrl('https://studio.hawkesgen.ai'), 'https://studio.hawkesgen.ai'); }
  finally { delete process.env.HAWKESGEN_ORG_CREDITS_DIRECT; }
});
