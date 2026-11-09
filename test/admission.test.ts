// Taking a job at all (src/jobs.ts admitJob): the cap on jobs waiting per project, the daily spend ceiling, and that a
// refusal reserves nothing. Plus the AI gate (src/aigate.ts): per-account cap, place in line, a bounded wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_PASSWORD_LOGIN = '1';
process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-admit-'));
process.env.HAWKESGEN_STARTER_CREDITS = '1000';

const { handle } = await import('../src/api.ts');
const { queue, spentToday, admitJob, cancel } = await import('../src/jobs.ts');
(queue as any).pump = () => {};
const { saveSettings, loadSettings } = await import('../src/config.ts');
const { recordUsage } = await import('../src/usage.ts');
const { createClient } = await import('../src/auth.ts');
const { createGate } = await import('../src/aigate.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

async function call(route: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
async function signup(email: string) {
  const r = await call('/v1/users/signup', {}, { email, password: 'password123' });
  return { Authorization: `Bearer ${r.body.apiKey}` };
}
const credits = async (auth: Record<string, string>) => (await call('/v1/billing/ledger', auth)).body.credits as number;
const vid = (auth: Record<string, string>) => call('/v1/jobs', auth, { tool: 'video.t2v', params: { prompt: 'a drone shot' } });

test('queueing past the cap is a plain 429 and reserves nothing; credits balance after cancelling', async () => {
  saveSettings({ queue: { ...loadSettings().queue, maxQueuedPerProject: 3, dailyCeilingUsd: 0 } });
  const auth = await signup('queuer@example.com');
  const start = await credits(auth);
  const made: string[] = [];
  for (let i = 0; i < 3; i++) { const r = await vid(auth); assert.equal(r.status, 200); made.push(r.body.jobs[0].id); }
  const held = await credits(auth);
  assert.ok(held < start);
  const over = await vid(auth);
  assert.equal(over.status, 429);
  assert.match(over.body.error, /Too many jobs are waiting/);
  assert.match(over.body.error, /Nothing was charged/);
  assert.equal(await credits(auth), held, 'the refused job reserved nothing');
  // Another customer is not held up by this one's line.
  const other = await signup('other@example.com');
  assert.equal((await vid(other)).status, 200);
  for (const id of made) cancel(id);
  assert.equal(await credits(auth), start, 'every reservation came back');
});

test('at the daily ceiling customers get "busy, try again later" and nothing is reserved; exempt callers run', async () => {
  saveSettings({ queue: { ...loadSettings().queue, maxQueuedPerProject: 50, dailyCeilingUsd: 10 } });
  const auth = await signup('ceiling@example.com');
  const start = await credits(auth);
  assert.equal((await vid(auth)).status, 200);
  recordUsage({ client: 'x', project: 'usr_somebody', provider: 'runpod', unit: 'gpu-seconds', amount: 100, cost: 11 });
  spentToday(Date.now(), true);
  const r = await vid(auth);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /busy right now.*try again later/);
  const first = start - (await credits(auth));
  assert.ok(first > 0 && first < start);
  // The studio's own project and an admin key are exempt; so is a pipeline's step.
  const owner = createClient('owner', 'owner').client as any;
  assert.doesNotThrow(() => admitJob(owner, 'hawkesgen'));
  const cust = createClient('cust', 'user', ['usr_aaaa']).client as any;
  assert.doesNotThrow(() => admitJob(cust, 'usr_aaaa', { parent: 'j_1' }));
  assert.throws(() => admitJob(cust, 'usr_aaaa'), /busy right now/);
  saveSettings({ queue: { ...loadSettings().queue, dailyCeilingUsd: 0 } });
  spentToday(Date.now(), true);
});

test('the AI gate: a place in line, a per-account cap, a bounded wait, and slots handed on in order', async () => {
  const gate = createGate(() => 1);
  const first = await gate.acquire({ who: 'u_a', maxPerUser: 2 });
  const seen: any[] = [];
  const second = gate.acquire({ who: 'u_b', maxPerUser: 2, maxWaitMs: 5000, onWait: (e) => seen.push(e) });
  const third = gate.acquire({ who: 'u_c', maxPerUser: 2, maxWaitMs: 40 });
  await assert.rejects(third, (e: any) => e.status === 503 && /busy right now \(you were number 2 in line\)/.test(e.message));
  assert.deepEqual(seen[0], { state: 'waiting', position: 1, ahead: 0 });
  first();
  const got = await second;
  assert.equal(seen.at(-1).state, 'running');
  assert.equal(gate.load().running, 1);
  await assert.rejects(gate.acquire({ who: 'u_b', maxPerUser: 1 }), (e: any) => e.status === 429 && /already have 1 AI requests/.test(e.message));
  got();
  assert.deepEqual(gate.load(), { running: 0, waiting: 0, cap: 1 });
});
