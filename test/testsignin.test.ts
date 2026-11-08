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
