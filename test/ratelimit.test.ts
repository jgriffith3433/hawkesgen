// The request limiter (src/ratelimit.ts): over the limit a route answers 429 with Retry-After, under it nothing changes,
// /v1/health and the Stripe webhook are never limited, and callers don't share a bucket. Scratch data folder, random port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-ratelimit-'));
const { handle } = await import('../src/api.ts');
const { createClient } = await import('../src/auth.ts');
const { classify, take, resetLimits, DEFAULT_RULES } = await import('../src/ratelimit.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

const key = createClient('limited (test)', 'admin', ['*']).key;
const other = createClient('another (test)', 'admin', ['*']).key;
// The loopback proxy rule of clientIp: the last X-Forwarded-For entry is the visitor.
const call = (route: string, o: { method?: string; key?: string; ip?: string; body?: any; headers?: Record<string, string> } = {}) =>
  fetch(base + route, {
    method: o.method ?? 'GET',
    headers: { ...(o.key ? { authorization: `Bearer ${o.key}` } : {}), ...(o.ip ? { 'x-forwarded-for': o.ip } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}), ...o.headers },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });

test('classes of route', () => {
  assert.equal(classify('GET', '/v1/health'), null);
  assert.equal(classify('POST', '/v1/billing/webhook'), null);
  assert.equal(classify('GET', '/gen/app.js'), null);
  assert.equal(classify('POST', '/v1/users/google'), 'strict');
  assert.equal(classify('POST', '/v1/users/test-session'), 'strict');
  assert.equal(classify('GET', '/oauth/authorize'), 'strict');
  assert.equal(classify('POST', '/oauth/token'), 'strict');
  assert.equal(classify('GET', '/v1/users/me'), 'generous');
  assert.equal(classify('POST', '/v1/jobs'), 'moderate');
  assert.equal(classify('POST', '/v1/estimate'), 'moderate');
  assert.equal(classify('POST', '/v1/assistant/chat'), 'moderate');
  assert.equal(classify('POST', '/v1/scenes/sn_abc123/assistant'), 'moderate');
  assert.equal(classify('GET', '/v1/jobs'), 'generous');
  assert.equal(classify('GET', '/v1/events'), 'generous');
  assert.equal(classify('PUT', '/v1/scenes/sn_abc123'), 'standard');
});

test('the bucket spends its burst, refills over time and says how long to wait', () => {
  const rule = { burst: 3, perMinute: 60 }; // one token a second
  for (let i = 0; i < 3; i++) assert.equal(take('t1', rule, 1000).ok, true);
  const no = take('t1', rule, 1000);
  assert.equal(no.ok, false);
  assert.equal(no.retryAfter, 1);
  assert.equal(take('t1', rule, 2100).ok, true); // a second later there is one again
  assert.equal(take('t1', rule, 2100).ok, false);
  assert.equal(take('t2', rule, 1000).ok, true); // another caller is untouched
});

test('above the limit a route answers 429 with Retry-After and a plain error; below it nothing changes', async () => {
  resetLimits();
  const burst = DEFAULT_RULES.strict.burst;
  const ip = '203.0.113.7';
  // Below the limit: the route answers as it always did (a bad body is a 4xx of its own, never 429).
  const hit = () => call('/v1/users/google', { method: 'POST', ip, body: { credential: 'nope' } });
  for (let i = 0; i < burst - 2; i++) assert.notEqual((await hit()).status, 429, `request ${i + 1} of ${burst}`);
  let r = await hit(), n = burst - 1;
  while (r.status !== 429 && n < burst * 3) { r = await hit(); n++; }
  assert.equal(r.status, 429, `no 429 in ${n} requests`);
  const wait = Number(r.headers.get('retry-after'));
  assert.ok(Number.isInteger(wait) && wait >= 1, `Retry-After ${r.headers.get('retry-after')}`);
  assert.match(r.headers.get('content-type') ?? '', /json/);
  const body: any = await r.json();
  assert.match(body.error, /wait \d+ seconds?/);
  assert.equal(body.retryAfter, wait);
  // Another address is not held up by it, and reads from the same address stay open.
  assert.notEqual((await call('/v1/users/google', { method: 'POST', ip: '203.0.113.8', body: { credential: 'nope' } })).status, 429);
  assert.equal((await call('/v1/users/google', { ip })).status, 200);
});

test('a signed-in caller is limited on its own key, not its neighbours', async () => {
  resetLimits();
  const burst = DEFAULT_RULES.moderate.burst;
  const est = (k: string) => call('/v1/estimate', { method: 'POST', key: k, body: { steps: [] } });
  // Fire fast in one go (a loaded machine refills a few tokens meanwhile): the first 429 must come soon after the burst.
  let r = await est(key), n = 1;
  while (r.status !== 429 && n < burst * 4) { r = await est(key); n++; }
  assert.equal(r.status, 429, `no 429 in ${n} requests`);
  assert.ok(n > burst / 2, `limited too early, after ${n}`);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.notEqual((await est(other)).status, 429);
  // Reads are in their own, larger bucket: the same key can still look at its jobs.
  assert.equal((await call('/v1/jobs?limit=1', { key })).status, 200);
});

test('/v1/health and the Stripe webhook are never limited', async () => {
  resetLimits();
  const n = DEFAULT_RULES.generous.burst + 50;
  for (let i = 0; i < n; i++) {
    const r = await call('/v1/health', { ip: '198.51.100.9' });
    if (r.status !== 200) assert.fail(`health gave ${r.status} on request ${i + 1}`);
  }
  // The webhook refuses a bad signature in its own way, but is never answered with 429.
  for (let i = 0; i < DEFAULT_RULES.standard.burst + 50; i++) {
    const r = await call('/v1/billing/webhook', { method: 'POST', ip: '198.51.100.9', body: { type: 'ping' }, headers: { 'stripe-signature': 't=1,v1=bad' } });
    if (r.status === 429) assert.fail(`webhook limited on request ${i + 1}`);
    await r.arrayBuffer();
  }
});

test('the address is believed only from the trusted hop: a forged header cannot dodge a strict bucket from a non-proxy socket', async () => {
  const { callerKey } = await import('../src/ratelimit.ts');
  const req: any = (sock: string, h: Record<string, string>) => ({ socket: { remoteAddress: sock }, headers: h });
  // Directly connected from outside (no proxy): the header is ignored, the socket is the caller.
  assert.equal(callerKey(req('192.0.2.5', { 'x-forwarded-for': '1.2.3.4' }), 'strict'), 'ip:192.0.2.5');
  // Behind the loopback proxy: its last hop.
  assert.equal(callerKey(req('127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }), 'strict'), 'ip:1.2.3.4');
  // A credential never changes a strict key.
  assert.equal(callerKey(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4', authorization: 'Bearer abc' }), 'strict'), 'ip:1.2.3.4');
  assert.match(callerKey(req('127.0.0.1', { authorization: 'Bearer abc' }), 'moderate'), /^k:/);
});

test("Gen's own calls (the self token from this machine) are never limited: a batch of jobs can't fail each other", async () => {
  const { SELF_TOKEN } = await import('../src/auth.ts');
  resetLimits();
  for (let i = 0; i < DEFAULT_RULES.moderate.burst + 30; i++) {
    const r = await call('/v1/estimate', { method: 'POST', key: SELF_TOKEN, body: { items: [] }, headers: { 'x-hawkesgen-project': 'starter' } });
    await r.arrayBuffer();
    if (r.status === 429) assert.fail(`self call limited on request ${i + 1}`);
  }
  // Anyone else with the same pattern still is.
  resetLimits();
  let limited = false;
  for (let i = 0; i < DEFAULT_RULES.moderate.burst + 5 && !limited; i++) {
    const r = await call('/v1/estimate', { method: 'POST', key, body: { items: [] } });
    await r.arrayBuffer();
    limited = r.status === 429;
  }
  assert.ok(limited);
});
