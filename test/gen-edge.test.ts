// The gen.hawkesgen.ai Worker (server/gen-edge/src/index.ts) on the names that were the customer portal's: hawkesgen.ai
// is Hawkes Gen's own app now (J, 2026-10-29: three products, HawkesGen.ai, hawkesgames.com, Studio), and what Gen
// doesn't have is the portal's, which moved to hawkesgames.com (hawkesgenwebsite docs/domain-move.md). Offline: fetch is
// a fake that answers per origin and path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/gen-edge/src/index.ts';

const env = { GEN_ORIGIN: 'https://gen.run.app', PORTAL_ORIGIN: 'https://hawkesgames.com', PORTAL_HOSTS: 'hawkesgen.ai,www.hawkesgen.ai' };
const HTML = { Accept: 'text/html,application/xhtml+xml' };

/** Runs the Worker with fetch answering `answers[origin + path]` or `answers[origin]` (a status, default 200). */
async function run(url: string, init: RequestInit = {}, answers: Record<string, number> = {}) {
  const seen: { to: string; method: string; body: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: URL | string, o: RequestInit = {}) => {
    const to = new URL(String(u));
    const body = o.body == null ? null : await new Response(o.body as BodyInit).text();
    seen.push({ to: to.origin + to.pathname + to.search, method: o.method ?? 'GET', body });
    return new Response('{}', { status: answers[to.origin + to.pathname] ?? answers[to.origin] ?? 200 });
  }) as typeof fetch;
  try {
    return { res: await worker.fetch(new Request(url, init), env), seen };
  } finally {
    globalThis.fetch = real;
  }
}
const to = (s: { to: string }[]) => s.map((x) => x.to);

test('gen.hawkesgen.ai: everything to Gen, as before', async () => {
  const { res, seen } = await run('https://gen.hawkesgen.ai/connect', { headers: HTML }, { 'https://gen.run.app': 404 });
  assert.equal(res.status, 404);
  assert.deepEqual(to(seen), ['https://gen.run.app/connect']);
});

test("hawkesgen.ai: Gen's app and pages are Gen's (the app, /legal, /admin, the SDKs)", async () => {
  for (const p of ['/', '/legal', '/admin', '/admin/app.js', '/gen/app.js', '/sdk/analytics@1.js', '/client/hawkesgen.mjs']) {
    const { res, seen } = await run(`https://hawkesgen.ai${p}`, { headers: HTML });
    assert.equal(res.status, 200, p);
    assert.deepEqual(to(seen), [`https://gen.run.app${p}`], p);
  }
});

test("hawkesgen.ai: an old portal page Gen doesn't have is redirected to hawkesgames.com, query and all", async () => {
  const { res, seen } = await run('https://hawkesgen.ai/play/my-game?room=x', { headers: HTML }, { 'https://gen.run.app': 404 });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://hawkesgames.com/play/my-game?room=x');
  assert.deepEqual(to(seen), ['https://gen.run.app/play/my-game?room=x']);
});

test("hawkesgen.ai: the portal's other paths are passed on (an upload link with curl -T, a token refresh)", async () => {
  const up = await run('https://hawkesgen.ai/up/tok/hero.png', { method: 'PUT', body: 'bytes', headers: { 'Content-Length': '5' } }, { 'https://gen.run.app': 404 });
  assert.deepEqual(up.seen.map((s) => [s.to, s.method, s.body]), [['https://gen.run.app/up/tok/hero.png', 'PUT', 'bytes'], ['https://hawkesgames.com/up/tok/hero.png', 'PUT', 'bytes']]);
  const tok = await run('https://hawkesgen.ai/oauth/token', { method: 'POST', body: 'grant_type=refresh_token', headers: { 'Content-Length': '24' } }, { 'https://gen.run.app': 404 });
  assert.deepEqual(to(tok.seen), ['https://gen.run.app/oauth/token', 'https://hawkesgames.com/oauth/token']);
});

test('hawkesgen.ai: by what the caller carries', async () => {
  const oauth = await run('https://hawkesgen.ai/mcp', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer hgo_abc' } });
  assert.deepEqual(to(oauth.seen), ['https://hawkesgames.com/mcp'], 'a portal OAuth token');
  const cookie = await run('https://hawkesgen.ai/v1/users/me', { headers: { Cookie: 'a=1; __session=s' } });
  assert.deepEqual(to(cookie.seen), ['https://hawkesgames.com/v1/users/me'], "the portal's session on the API");
  const page = await run('https://hawkesgen.ai/', { headers: { ...HTML, Cookie: '__session=s' } });
  assert.deepEqual(to(page.seen), ['https://gen.run.app/'], "the portal's old cookie doesn't take Gen's app away");
  const jwt = await run('https://hawkesgen.ai/v1/jobs', { headers: { Authorization: 'Bearer eyJh.eyJi.c2ln' } }, { 'https://gen.run.app': 401 });
  assert.deepEqual(to(jwt.seen), ['https://gen.run.app/v1/jobs'], 'a platform token stays with Gen, even refused');
});

test("hawkesgen.ai /v1: an hg_ key Gen knows stays there; one it refuses goes to the portal with the same body", async () => {
  const ok = await run('https://hawkesgen.ai/v1/jobs', { method: 'POST', body: '{"tool":"x"}', headers: { Authorization: 'Bearer hg_gen', 'Content-Length': '12' } });
  assert.deepEqual(to(ok.seen), ['https://gen.run.app/v1/jobs']);
  const { res, seen } = await run('https://hawkesgen.ai/v1/jobs', { method: 'POST', body: '{"tool":"x"}', headers: { Authorization: 'Bearer hg_portal', 'Content-Length': '12' } }, { 'https://gen.run.app': 401 });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.map((s) => [s.to, s.body]), [['https://gen.run.app/v1/jobs', '{"tool":"x"}'], ['https://hawkesgames.com/v1/jobs', '{"tool":"x"}']]);
  const page401 = await run('https://hawkesgen.ai/admin', { headers: HTML }, { 'https://gen.run.app': 401 });
  assert.equal(page401.res.status, 401, "Gen's own sign-in wall on a page stays Gen's");
  assert.deepEqual(to(page401.seen), ['https://gen.run.app/admin']);
});

test("hawkesgen.ai: Gen's Stripe webhook is Gen's (the portal's moved to hawkesgames.com)", async () => {
  const { seen } = await run('https://hawkesgen.ai/v1/billing/webhook', { method: 'POST', body: '{}', headers: { 'Stripe-Signature': 't=1,v1=x', 'Content-Length': '2' } }, { 'https://gen.run.app': 400 });
  assert.deepEqual(to(seen), ['https://gen.run.app/v1/billing/webhook']);
});

test('hawkesgen.ai: a body of unknown size goes to Gen alone (nothing kept to send twice)', async () => {
  const { seen } = await run('https://hawkesgen.ai/v1/assets', { method: 'POST', body: 'x' }, { 'https://gen.run.app': 401 });
  assert.deepEqual(to(seen), ['https://gen.run.app/v1/assets']);
});
