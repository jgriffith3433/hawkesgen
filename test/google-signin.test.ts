// Continue with Google for Gen's own accounts (users.ts googleSignin, dashauth.ts checkGoogleToken): one Google account
// signs in to Gen (as to the portal and Studio, each with its own account). Found by Google's permanent id, else by
// email (an older password account, linked), else made with the starter credits. Passwords are off on the cloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-google-'));
const { googleSignin, signupUser, loginUser, passwordsAllowed } = await import('../src/users.ts');
const { checkGoogleToken } = await import('../src/dashauth.ts');
const { saveSettings } = await import('../src/config.ts');

test('a new Google account gets a Gen account with the starter credits; the same Google id finds it again', () => {
  const a = googleSignin({ sub: '1000000000001', email: 'New@Example.com', name: 'New Person' });
  assert.equal(a.created, true);
  assert.equal(a.user.email, 'new@example.com');
  assert.ok(a.user.credits > 0);
  // The email changed at Google: the id still finds the same account.
  const b = googleSignin({ sub: '1000000000001', email: 'renamed@example.com', name: null });
  assert.equal(b.created, false);
  assert.equal(b.user.id, a.user.id);
  // No password works on a Google-made account.
  assert.throws(() => loginUser({ email: 'new@example.com', password: 'anything-at-all' }), /Invalid email or password/);
});

test('an older password account is linked by its email, not duplicated', () => {
  const old = signupUser({ email: 'old@example.com', password: 'secret-123', name: 'Old' });
  const g = googleSignin({ sub: '1000000000002', email: 'old@example.com', name: 'Old' });
  assert.equal(g.created, false);
  assert.equal(g.user.id, old.user.id);
  assert.equal(googleSignin({ sub: '1000000000002', email: 'old@example.com', name: null }).user.id, old.user.id);
});

test('passwords are off on the cloud unless turned on', () => {
  assert.equal(passwordsAllowed(), true, 'local runs and tests');
  process.env.K_SERVICE = 'gen';
  try {
    assert.equal(passwordsAllowed(), false);
    process.env.HAWKESGEN_PASSWORD_LOGIN = '1';
    assert.equal(passwordsAllowed(), true);
  } finally {
    delete process.env.K_SERVICE;
    delete process.env.HAWKESGEN_PASSWORD_LOGIN;
  }
});

test('a Google token is checked: our client, Google as issuer, a verified email, an account id', async () => {
  saveSettings({ dashboard: { googleClientId: '123456-abc.apps.googleusercontent.com', googleEmails: [] } } as any);
  const answer = (t: Record<string, unknown>) => (async () => new Response(JSON.stringify(t), { status: 200 })) as unknown as typeof fetch;
  const good = { aud: '123456-abc.apps.googleusercontent.com', iss: 'https://accounts.google.com', sub: '1000000000003', email: 'A@b.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 600), name: 'A' };
  const jwt = 'aaa.bbb.ccc';
  assert.deepEqual(await checkGoogleToken(jwt, answer(good)), { sub: '1000000000003', email: 'a@b.com', name: 'A' });
  await assert.rejects(checkGoogleToken(jwt, answer({ ...good, aud: 'other' })), /another app/);
  await assert.rejects(checkGoogleToken(jwt, answer({ ...good, iss: 'evil.example' })), /did not come from Google/);
  await assert.rejects(checkGoogleToken(jwt, answer({ ...good, email_verified: 'false' })), /no verified email/);
  assert.equal((await checkGoogleToken(jwt, answer({ ...good, sub: undefined }))).sub, null, 'the admin sign-in needs no id; an account does');
  assert.throws(() => googleSignin({ sub: '', email: 'x@y.com', name: null }), /account id/);
  await assert.rejects(checkGoogleToken('not-a-token', answer(good)), /not a Google sign-in/);
});
