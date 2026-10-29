// The dashboard's "Continue with Google" (src/dashauth.ts): the signed session cookie, and checking Google's ID token
// (Google's answer is a fake: offline).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-dashauth-'));
const { saveSettings } = await import('../src/config.ts');
const d = await import('../src/dashauth.ts');
const CLIENT = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';

test('no Google sign-in until both the client and an email are set', () => {
  assert.equal(d.googleClientId(), null);
  saveSettings({ dashboard: { googleClientId: CLIENT, googleEmails: [] } });
  assert.equal(d.googleClientId(), null);
  saveSettings({ dashboard: { googleClientId: CLIENT, googleEmails: [' J@Example.com ', 'not an email'] } });
  assert.equal(d.googleClientId(), CLIENT);
  assert.deepEqual(d.allowedEmails(), ['j@example.com']);
});

test('a session is the email it was made for; a forged, expired or removed one is nothing', () => {
  const v = d.signSession('j@example.com');
  assert.equal(d.sessionEmail(v), 'j@example.com');
  const [payload, sig] = v.split('.');
  const other = Buffer.from(JSON.stringify({ e: 'j@example.com', x: Date.now() + 9e12 })).toString('base64url');
  assert.equal(d.sessionEmail(`${other}.${sig}`), null, 'a changed payload with the old signature');
  assert.equal(d.sessionEmail(`${payload}.x${sig.slice(1)}`), null, 'a changed signature');
  assert.equal(d.sessionEmail(d.signSession('j@example.com', Date.now() - 31 * 86_400_000)), null, 'expired');
  assert.equal(d.sessionEmail('garbage'), null);
  saveSettings({ dashboard: { googleClientId: CLIENT, googleEmails: ['someone@else.com'] } });
  assert.equal(d.sessionEmail(v), null, 'removed from the list');
  saveSettings({ dashboard: { googleClientId: CLIENT, googleEmails: ['j@example.com'] } });
  assert.equal(d.sessionEmail(v), 'j@example.com');
});

const google = (answer: object, ok = true) => (async () => new Response(JSON.stringify(answer), { status: ok ? 200 : 400 })) as unknown as typeof fetch;
const TOKEN = 'aaa.bbb.ccc';
const good = { aud: CLIENT, iss: 'https://accounts.google.com', email: 'J@example.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 600) };

test('a Google token is let in only for our client, a verified email on the list, and while it lasts', async () => {
  assert.equal(await d.verifyGoogle(TOKEN, google(good)), 'j@example.com');
  await assert.rejects(d.verifyGoogle(TOKEN, google({ ...good, aud: 'other.apps.googleusercontent.com' })), /another app/);
  await assert.rejects(d.verifyGoogle(TOKEN, google({ ...good, iss: 'evil.com' })), /did not come from Google/);
  await assert.rejects(d.verifyGoogle(TOKEN, google({ ...good, email_verified: 'false' })), /no verified email/);
  await assert.rejects(d.verifyGoogle(TOKEN, google({ ...good, email: 'stranger@example.com' })), /not allowed/);
  await assert.rejects(d.verifyGoogle(TOKEN, google({ ...good, exp: '1' })), /expired/);
  await assert.rejects(d.verifyGoogle(TOKEN, google({ error: 'invalid_token' }, false)), /did not accept/);
  await assert.rejects(d.verifyGoogle('not a token', google(good)), /not a Google sign-in/);
});
