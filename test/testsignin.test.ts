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
