import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A signed-out first visit logs no console error: the web app skips /v1/users/me when hg.in is unset, and that route
// still answers 401 to API clients with no key (acceptance: f_9f2b737d5561).

test('signed out: the web app skips the session probe without hg.in', () => {
  const html = readFileSync(new URL('../dashboard/gen/index.html', import.meta.url), 'utf8');
  assert.match(html, /localStorage\.getItem\('hg\.in'\) === '1'/);
  // The early /v1/users/me fetch must sit inside `if (hinted)`, not run on every visit.
  const hintIf = html.indexOf('if (hinted)');
  const earlyFetch = html.indexOf("fetch('/v1/users/me'");
  assert.ok(hintIf > 0 && earlyFetch > hintIf, 'the early probe must be behind the hg.in hint');

  const account = readFileSync(new URL('../dashboard/gen/account.js', import.meta.url), 'utf8');
  assert.match(account, /hinted = localStorage\.getItem\('hg\.in'\) === '1'/);
  assert.match(account, /if \(hinted\) state\.user = \(await api\('\/v1\/users\/me'\)\)\.user/);
  assert.match(account, /else state\.user = null/);
  assert.match(account, /localStorage\.removeItem\('hg\.in'\)/, 'sign-out clears the hint before reload');
});

test('playtest runs set the session hint, except the signed-out scenarios', () => {
  // Studio's bot signs in with a cookie but starts with empty storage: without hg.in the app never asked who it was
  // and every editor scenario sat on the landing page (no-lost-work, editor-fit, polished-cut).
  const html = readFileSync(new URL('../dashboard/gen/index.html', import.meta.url), 'utf8');
  const set = html.indexOf("localStorage.setItem('hg.in', '1')");
  assert.ok(set > 0 && set < html.indexOf('if (hinted)'), 'the playtest hint is set before the probe decision');
  assert.match(html, /get\('playtest'\)/);
  assert.match(html, /pt !== 'signedout' && pt !== 'first-paint'/);
  // The scenarios that play the signed-out path are the ones left out.
  const pt = readFileSync(new URL('../dashboard/gen/playtest.js', import.meta.url), 'utf8');
  assert.match(pt, /id === 'signedout'/);
  assert.match(pt, /id === 'first-paint'/);
  assert.match(pt, /no-lost-work failed at "open editor"/);
});

test('signed out: /v1/users/me without a key still answers 401', async () => {
  process.env.HAWKESGEN_PUBLIC_SAAS = '1';
  process.env.HAWKESGEN_RATELIMIT = 'off';
  const { handle } = await import('../src/api.ts');
  const server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/users/me`);
    assert.equal(res.status, 401);
    const body = await res.json() as { error?: string };
    assert.match(String(body.error ?? ''), /API key|sign in/i);
  } finally {
    delete process.env.HAWKESGEN_PUBLIC_SAAS;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('signed out: the landing buttons centre their labels and the playtest checks the skip', () => {
  const css = readFileSync(new URL('../dashboard/gen/gen.css', import.meta.url), 'utf8');
  assert.match(css, /\.ld-cta button \{[^}]*justify-content: center/);
  const pt = readFileSync(new URL('../dashboard/gen/playtest.js', import.meta.url), 'utf8');
  assert.match(pt, /t\.metric\('meProbed'/);
  assert.match(pt, /session-probe-skipped/);
  assert.match(pt, /signed-out loadMe called/);
  assert.doesNotMatch(
    readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'),
    /return send\(res, 200, \{ user: null \}\)/,
    'anonymous /v1/users/me must not soft-answer 200 (API clients rely on 401)',
  );
});
