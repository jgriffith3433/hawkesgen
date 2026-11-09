// Hawkes Studio's playtests signed in (src/testsignin.ts): a token signed with the project's secret signs in that
// project's own test account, on the beta lane only; anything else is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-testsignin-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');
process.env.HAWKESGEN_RATELIMIT = 'off'; // this file tries many sign-ins from one address; the limiter has its own test
delete process.env.HAWKESGEN_LANE;
delete process.env.HAWKESGEN_TEST_SIGNIN;

const { handle } = await import('../src/api.ts');
const TS = await import('../src/testsignin.ts');
const SECRET = `tss_${'a'.repeat(43)}`;
const token = (project: string, { secret = SECRET, exp = Math.floor(Date.now() / 1000) + 300, nonce = crypto.randomBytes(12).toString('hex') } = {}) =>
  ({ project, exp, nonce, sig: crypto.createHmac('sha256', secret).update(`${project}.${exp}.${nonce}`).digest('base64url') });

test("a Studio token signs in the project's own test account, on beta only, once", async () => {
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (body: unknown) => fetch(`${base}/v1/users/test-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(token('hawkesgen-app'))).status, 404, 'off on live (no beta lane)');
    process.env.HAWKESGEN_TEST_SIGNIN = '1';
    assert.equal((await post(token('hawkesgen-app'))).status, 503, 'no secret set yet');
    assert.throws(() => TS.setTestSignInSecret('not-a-secret'), /tss_/);
    assert.deepEqual(TS.setTestSignInSecret(SECRET), { on: true, set: true, last4: 'aaaa' });
    const good = token('hawkesgen-app');
    const r = await post(good);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie') ?? '', /hg_session=/);
    const body = await r.json();
    assert.equal(body.user.email, 'playtest+hawkesgen-app@playtest.hawkesgen.ai');
    assert.equal((await post(good)).status, 401, 'a token is used once');
    assert.equal((await post(token('hawkesgen-app', { secret: `tss_${'b'.repeat(43)}` }))).status, 401, 'another secret');
    assert.equal((await post(token('hawkesgen-app', { exp: Math.floor(Date.now() / 1000) - 10 }))).status, 401, 'expired');
    const again = await (await post(token('hawkesgen-app'))).json();
    assert.equal(again.user.id, body.user.id, 'the same test account every time');
    assert.equal(again.created, false);
  } finally {
    delete process.env.HAWKESGEN_TEST_SIGNIN;
    server.close();
  }
});

test("load-* test accounts skip the starter grant and the sign-up cap, others keep both, and a load account deletes itself", async () => {
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { db } = await import('../src/db.ts');
  process.env.HAWKESGEN_TEST_SIGNIN = '1';
  process.env.HAWKESGEN_STARTER_CREDITS = '500';
  TS.setTestSignInSecret(SECRET);
  try {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM signup_log').get() as any).n;
    const load = await (await post('/v1/users/test-session', token('load-0001'))).json();
    assert.equal((db.prepare('SELECT credits FROM users WHERE id = ?').get(load.user.id) as any).credits, 0, 'no starter grant');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM signup_log').get() as any).n, before, 'not counted against the caps');
    const other = await (await post('/v1/users/test-session', token('hawkesgen-other'))).json();
    assert.equal((db.prepare('SELECT credits FROM users WHERE id = ?').get(other.user.id) as any).credits, 500, 'other test accounts keep the grant');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM signup_log').get() as any).n, before + 1);
    assert.equal((await post('/v1/users/test-session/delete', token('hawkesgen-other'))).status, 403, 'only load-* can be deleted');
    const del = await post('/v1/users/test-session/delete', token('load-0001'));
    assert.equal(del.status, 200);
    assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get(load.user.id), undefined);
    assert.equal((await (await post('/v1/users/test-session/delete', token('load-0001'))).json()).deleted, null, 'already gone');
  } finally {
    delete process.env.HAWKESGEN_TEST_SIGNIN; delete process.env.HAWKESGEN_STARTER_CREDITS;
    server.close();
  }
});

test("the app's 🐞 line: a Studio project's report script, at a Studio's root or under its org", async () => {
  const R = await import('../src/studioreport.ts');
  const key = `rk_${'b'.repeat(32)}`;
  for (const s of [`https://studio-beta.hawkesgen.ai/r/hawkesgen-app.js?k=${key}`, `https://studio.hawkesgen.ai/o/acme-1a2b/r/gen-app.js?k=${key}`]) assert.equal(R.setReportScript(s).script, s);
  assert.throws(() => R.setReportScript('https://evil.example.com/x.js'), /not a Studio project report script/);
  assert.throws(() => R.setReportScript(`https://studio.hawkesgen.ai/r/gen-app.js?k=${key}" onload="x`), /not a Studio project report script/);
  assert.equal(R.setReportScript('').script, null);
});

test("a GitHub Actions run of the Unity plugin's repo signs in its test account, on beta only, once, and nothing else", async () => {
  const GH = await import('../src/githubsignin.ts');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  GH.setKeySource(async () => [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }]);
  const now = Math.floor(Date.now() / 1000);
  const jwt = (claims: Record<string, unknown> = {}, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = { iss: GH.ISSUER, aud: GH.AUDIENCE, exp: now + 300, nbf: now - 5, repository_id: '1429202968', repository: 'jgriffith3433/hawkesgen-unity', runner_environment: 'github-hosted', jti: crypto.randomUUID(), ...claims };
    const head = `${enc({ alg, kid, typ: 'JWT' })}.${enc(body)}`;
    return `${head}.${crypto.sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
  };
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (token: string) => fetch(`${base}/v1/users/test-session/github`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  try {
    delete process.env.HAWKESGEN_LANE; delete process.env.HAWKESGEN_TEST_SIGNIN;
    assert.equal((await post(jwt())).status, 404, 'off on live');
    process.env.HAWKESGEN_LANE = 'live';
    assert.equal((await post(jwt())).status, 404, 'off on any lane but beta');
    process.env.HAWKESGEN_LANE = 'beta';
    const good = jwt();
    const r = await post(good);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie') ?? '', /hg_session=/);
    const body = await r.json();
    assert.equal(body.user.email, 'playtest+hawkesgen-unity@playtest.hawkesgen.ai', 'only the fixed test account');
    const U = await import('../src/users.ts');
    assert.equal(U.isGenAdmin(body.user), false, 'never an admin');
    assert.equal((await post(good)).status, 401, 'each token once');
    assert.equal((await post(jwt({ repository_id: '1', repository: 'someone/else' }))).status, 401, 'another repository');
    assert.equal((await post(jwt({ repository_id: '999', repository: 'jgriffith3433/hawkesgen-unity' }))).status, 401, 'the name alone is not enough');
    assert.equal((await post(jwt({ aud: 'something-else' }))).status, 401, 'another audience');
    assert.equal((await post(jwt({ iss: 'https://evil.example.com' }))).status, 401, 'another issuer');
    assert.equal((await post(jwt({ exp: now - 10 }))).status, 401, 'expired');
    assert.equal((await post(jwt({ runner_environment: 'self-hosted' }))).status, 401, 'a self-hosted runner');
    assert.equal((await post(jwt({ jti: '' }))).status, 401, 'no token id');
    assert.equal((await post(jwt({}, { key: other.privateKey }))).status, 401, 'signed with another key');
    assert.equal((await post(jwt({}, { kid: 'nope' }))).status, 401, 'an unknown key id');
    assert.equal((await post(jwt({}, { alg: 'none' }))).status, 401, 'no algorithm swaps');
    assert.equal((await post('not.a.token')).status, 401);
    const again = await (await post(jwt())).json();
    assert.equal(again.user.id, body.user.id, 'the same test account every time');
  } finally {
    delete process.env.HAWKESGEN_LANE;
    server.close();
  }
});

test("a token the issuing Studio confirms signs in on beta with no secret; unconfirmed, foreign and live are refused; the HMAC path still works", async () => {
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (body: unknown) => fetch(`${base}/v1/users/test-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } };
  const studio = (project: string, issuer: string, o: { exp?: number } = {}) => ({ ...token(project, { secret: `tss_${'c'.repeat(43)}`, ...o }), issuer });
  globalThis.fetch = (async (url: any, init?: any) => {
    if (!String(url).includes('/api/signin/verify')) return realFetch(url, init);
    asked.push(String(url));
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    TS.setTestSignInSecret('');
    delete process.env.HAWKESGEN_LANE; delete process.env.HAWKESGEN_TEST_SIGNIN;
    assert.equal((await post(studio('hawkesgen-app', 'https://studio.hawkesgen.ai'))).status, 404, 'live refuses');
    assert.equal(asked.length, 0, 'live never asks Studio');
    process.env.HAWKESGEN_LANE = 'beta';
    const good = studio('hawkesgen-app', 'https://studio.hawkesgen.ai');
    const r = await post(good);
    assert.equal(r.status, 200, 'no secret set: Studio confirms');
    assert.match(r.headers.get('set-cookie') ?? '', /hg_session=/);
    assert.equal((await r.json()).user.email, 'playtest+hawkesgen-app@playtest.hawkesgen.ai');
    assert.equal(asked.length, 1);
    assert.ok(asked[0].endsWith('/api/signin/verify'));
    assert.equal((await post(good)).status, 401, 'once');
    assert.equal(asked.length, 1, 'a replay never reaches Studio');
    answer = { status: 401, body: { ok: false } };
    assert.equal((await post(studio('hawkesgen-app', 'https://studio.hawkesgen.ai'))).status, 401, 'Studio says no');
    answer = { status: 200, body: { ok: false } };
    assert.equal((await post(studio('hawkesgen-app', 'https://studio.hawkesgen.ai'))).status, 401, 'ok must be true');
    answer = { status: 200, body: { ok: true } };
    const n = asked.length;
    for (const issuer of ['https://evil.example.com', 'http://studio.hawkesgen.ai', 'https://studio.hawkesgen.ai.evil.com', 'https://studio.hawkesgen.ai/x', 'https://studio.hawkesgen.ai/?a=1', 'https://u:p@studio.hawkesgen.ai', 'nonsense'])
      assert.equal((await post(studio('hawkesgen-app', issuer))).status, 401, `foreign issuer ${issuer}`);
    assert.equal((await post(studio('hawkesgen-app', 'https://studio.hawkesgen.ai', { exp: Math.floor(Date.now() / 1000) - 10 }))).status, 401, 'expired');
    assert.equal((await post(studio('load-0001', 'https://studio.hawkesgen.ai'))).status, 401, 'load-* is the secret path only');
    assert.equal(asked.length, n, 'none of those reached Studio');
    assert.equal((await post(studio('hawkesgen-app', 'https://studio.hawkesgen.ai/o/acme-1a2b'))).status, 200, 'a customer cell of a trusted Studio');
    assert.match(asked.at(-1)!, /studio\.hawkesgen\.ai\/o\/acme-1a2b\/api\/signin\/verify$/);
    assert.equal((await post(studio('hawkesgen-app', 'https://studio-beta.hawkesgen.ai'))).status, 200, 'Studio beta');
    // The HMAC secret still works (and a token with an issuer that the secret signed needs no Studio).
    TS.setTestSignInSecret(SECRET);
    const m = asked.length;
    assert.equal((await post(token('hawkesgen-app'))).status, 200, 'HMAC, no issuer');
    assert.equal((await post({ ...token('hawkesgen-app'), issuer: 'https://studio.hawkesgen.ai' })).status, 200, 'HMAC with an issuer');
    assert.equal(asked.length, m, 'HMAC never asks Studio');
    assert.equal((await post(token('hawkesgen-app', { secret: `tss_${'b'.repeat(43)}` }))).status, 401, 'wrong secret, no issuer');
    assert.equal((await post(token('load-0002'))).status, 200, 'load harness unchanged');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.HAWKESGEN_LANE; delete process.env.HAWKESGEN_TEST_SIGNIN;
    TS.setTestSignInSecret('');
    server.close();
  }
});
