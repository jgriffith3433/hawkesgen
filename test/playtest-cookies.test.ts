// playtest.run's cookies param (2026-10-29): Hawkes Studio sends a short-lived beta-site pass so its playtests of beta
// sites (sb-<sub>.hawkesgen.ai, behind Studio's sign-in) get in. Only well-formed cookies for real hosts pass, always
// Secure and HttpOnly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pageCookies, playtestRunTool } = await import('../src/tools/playtest.ts');

test('pageCookies keeps well-formed cookies for real hosts, Secure and HttpOnly, at most 8', () => {
  assert.deepEqual(pageCookies([{ name: 'hawkes_pass_beta', value: 'v1.beta.123.dQ.sig', domain: '.hawkesgen.ai' }]),
    [{ name: 'hawkes_pass_beta', value: 'v1.beta.123.dQ.sig', domain: '.hawkesgen.ai', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  for (const bad of [{ name: 'a b', value: 'x', domain: '.hawkesgen.ai' }, { name: 'a', value: 'x;y', domain: '.hawkesgen.ai' },
    { name: 'a', value: 'x', domain: 'localhost' }, { name: 'a', value: 1, domain: '.hawkesgen.ai' }, null]) {
    assert.deepEqual(pageCookies([bad]), [], JSON.stringify(bad));
  }
  assert.deepEqual(pageCookies('not a list'), []);
  assert.equal(pageCookies(Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, value: 'v', domain: '.hawkesgen.ai' }))).length, 8);
  assert.ok(playtestRunTool.params.cookies, 'the tool takes the param');
});
