// Starter-credit farming (src/signupcap.ts): per-address and daily caps, refused grants still sign in, existing accounts untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cap-'));
const { googleSignin } = await import('../src/users.ts');
const { db } = await import('../src/db.ts');
const { saveSettings, loadSettings } = await import('../src/config.ts');
const { signupStats } = await import('../src/signupcap.ts');

test('20 accounts from one address: only the cap get starter credits, the rest sign in with a plain message', () => {
  const old = googleSignin({ sub: 'old-1', email: 'old@example.com', name: 'Old' }, '9.9.9.9');
  const oldBefore = JSON.stringify([db.prepare('SELECT credits FROM users WHERE id = ?').get(old.user.id), db.prepare('SELECT * FROM credit_ledger WHERE user_id = ?').all(old.user.id)]);
  const cap = loadSettings().signups.perIpPerDay;
  const r = Array.from({ length: 20 }, (_, i) => googleSignin({ sub: `farm-${i}`, email: `farm${i}@example.com`, name: null }, '1.2.3.4'));
  assert.equal(r.filter((x) => x.user.credits > 0).length, cap);
  for (const x of r.slice(cap)) {
    assert.equal(x.user.credits, 0);
    assert.ok(x.sessionToken && x.created);
    assert.match(x.notice ?? "", /credits/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ?').get(x.user.id) as any).n, 0);
  }
  // another address still gets its grant; a refused account signing in again changes nothing
  assert.ok(googleSignin({ sub: 'other', email: 'other@example.com', name: null }, '5.6.7.8').user.credits > 0);
  assert.equal(googleSignin({ sub: 'farm-19', email: 'farm19@example.com', name: null }, '1.2.3.4').user.credits, 0);
  // existing user: balance and ledger unchanged
  const oldAfter = JSON.stringify([db.prepare('SELECT credits FROM users WHERE id = ?').get(old.user.id), db.prepare('SELECT * FROM credit_ledger WHERE user_id = ?').all(old.user.id)]);
  assert.equal(oldAfter, oldBefore);
  const s = signupStats();
  assert.equal(s.today.signups, 22);
  assert.equal(s.today.refusedGrants, 20 - cap);
});

test('a global daily cap stops grants from any address', () => {
  saveSettings({ ...loadSettings(), signups: { perIpPerDay: 100, starterCreditsPerDay: signupStats().today.starterCredits + 50 } });
  assert.ok(googleSignin({ sub: 'g1', email: 'g1@example.com', name: null }, '8.8.1.1').user.credits > 0);
  const g2 = googleSignin({ sub: 'g2', email: 'g2@example.com', name: null }, '8.8.1.2');
  assert.equal(g2.user.credits, 0);
  assert.ok(g2.notice);
});
