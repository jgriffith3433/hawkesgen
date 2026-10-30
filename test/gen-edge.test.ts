// The gen.hawkesgen.ai Worker (server/gen-edge/src/index.ts) on the names that were the customer portal's
// (hawkesgen.ai before it moved to hawkesgames.com, docs/domain-move.md): Gen's paths to Gen, old portal pages redirected,
// the portal's other paths passed on, and /v1 and /mcp by who is calling. Offline: fetch is a fake that answers per origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/gen-edge/src/index.ts';

const env = { GEN_ORIGIN: 'https://gen.run.app', PORTAL_ORIGIN: 'https://hawkesgames.com', PORTAL_HOSTS: 'hawkesgen.ai,www.hawkesgen.ai' };

/** Runs the Worker with fetch answering `answers[origin]` (a status) and records where each request went. */
async function run(url: string, init: RequestInit = {}, answers: Record<string, number> = {}) {
  const seen: { to: string; method: string; body: string | null; host: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: URL | string, o: RequestInit = {}) => {
    const to = new URL(String(u));
    const body = o.body == null ? null : await new Response(o.body as BodyInit).text();
    seen.push({ to: to.origin + to.pathname + to.search, method: o.method ?? 'GET', body, host: new Headers(o.headers).get('X-Forwarded-Host') });
    return new Response('{}', { status: answers[to.origin] ?? 200 });
  }) as typeof fetch;
  try {
    const res = await worker.fetch(new Request(url, init), env);
    return { res, seen };
  } finally {
    globalThis.fetch = real;
  }
}

test('gen.hawkesgen.ai: everything to Gen, as before', async () => {
  const { res, seen } = await run('https://gen.hawkesgen.ai/connect', { headers: { Accept: 'text/html' } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.map((s) => s.to), ['https://gen.run.app/connect']);
  assert.equal(seen[0].host, 'gen.hawkesgen.ai');
});

test('hawkesgen.ai: the dashboard and the SDKs are Gen\'s', async () => {
  for (const p of ['/', '/sdk/analytics@1.js', '/client/hawkesgen.mjs']) {
    const { seen } = await run(`https://hawkesgen.ai${p}`, { headers: { Accept: 'text/html' } });
    assert.deepEqual(seen.map((s) => s.to), [`https://gen.run.app${p}`], p);
  }
});

test('hawkesgen.ai: an old portal page is redirected to hawkesgames.com, query and all', async () => {
  const { res, seen } = await run('https://hawkesgen.ai/play/my-game?room=x', { headers: { Accept: 'text/html,application/xhtml+xml' } });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://hawkesgames.com/play/my-game?room=x');
  assert.equal(seen.length, 0);
});

test('hawkesgen.ai: the portal\'s other paths are passed on (an upload link with curl -T, a token refresh)', async () => {
  const up = await run('https://hawkesgen.ai/up/tok/hero.png', { method: 'PUT', body: 'bytes' });
  assert.deepEqual(up.seen.map((s) => [s.to, s.method, s.body]), [['https://hawkesgames.com/up/tok/hero.png', 'PUT', 'bytes']]);
  const tok = await run('https://hawkesgen.ai/oauth/token', { method: 'POST', body: 'grant_type=refresh_token' });
  assert.deepEqual(tok.seen.map((s) => s.to), ['https://hawkesgames.com/oauth/token']);
});

test('hawkesgen.ai /v1 and /mcp: by who is calling', async () => {
  const oauth = await run('https://hawkesgen.ai/mcp', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer hgo_abc' } });
  assert.deepEqual(oauth.seen.map((s) => s.to), ['https://hawkesgames.com/mcp'], 'a portal OAuth token');
  const cookie = await run('https://hawkesgen.ai/v1/users/me', { headers: { Cookie: 'a=1; __session=s' } });
  assert.deepEqual(cookie.seen.map((s) => s.to), ['https://hawkesgames.com/v1/users/me'], 'the portal\'s session');
  const jwt = await run('https://hawkesgen.ai/v1/jobs', { headers: { Authorization: 'Bearer eyJh.eyJi.c2ln' } }, { 'https://gen.run.app': 401 });
  assert.deepEqual(jwt.seen.map((s) => s.to), ['https://gen.run.app/v1/jobs'], 'a platform token stays with Gen, even refused');
});

test('hawkesgen.ai /v1: an hg_ key Gen knows stays there; one it doesn\'t goes to the portal with the same body', async () => {
  const ok = await run('https://hawkesgen.ai/v1/jobs', { method: 'POST', body: '{"tool":"x"}', headers: { Authorization: 'Bearer hg_gen', 'Content-Length': '12' } });
  assert.deepEqual(ok.seen.map((s) => s.to), ['https://gen.run.app/v1/jobs']);
  const { res, seen } = await run('https://hawkesgen.ai/v1/jobs', { method: 'POST', body: '{"tool":"x"}', headers: { Authorization: 'Bearer hg_portal', 'Content-Length': '12' } }, { 'https://gen.run.app': 401 });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.map((s) => [s.to, s.body]), [['https://gen.run.app/v1/jobs', '{"tool":"x"}'], ['https://hawkesgames.com/v1/jobs', '{"tool":"x"}']]);
  const open = await run('https://hawkesgen.ai/v1/gallery', {}, { 'https://gen.run.app': 404 });
  assert.deepEqual(open.seen.map((s) => s.to), ['https://gen.run.app/v1/gallery', 'https://hawkesgames.com/v1/gallery'], 'a route only the portal has');
});

test('hawkesgen.ai /v1: a body of unknown size goes to Gen alone (nothing kept to send twice)', async () => {
  const { seen } = await run('https://hawkesgen.ai/v1/assets', { method: 'POST', body: 'x' }, { 'https://gen.run.app': 401 });
  assert.deepEqual(seen.map((s) => s.to), ['https://gen.run.app/v1/assets']);
});
