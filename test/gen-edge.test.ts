// The hawkesgen.ai Worker (server/gen-edge/src/index.ts) on the names that were the customer portal's: hawkesgen.ai
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

test("hawkesgen.ai: the portal's other paths Gen doesn't have are passed on (a play asset, a report)", async () => {
  const asset = await run('https://hawkesgen.ai/play-asset/g/abc/hero.glb', {}, { 'https://gen.run.app': 404 });
  assert.deepEqual(to(asset.seen), ['https://gen.run.app/play-asset/g/abc/hero.glb', 'https://hawkesgames.com/play-asset/g/abc/hero.glb']);
  const report = await run('https://hawkesgen.ai/v1/play/my-game/report', { method: 'POST', body: 'broken', headers: { 'Content-Length': '6' } }, { 'https://gen.run.app': 404 });
  assert.deepEqual(report.seen.map((s) => [s.to, s.body]), [['https://gen.run.app/v1/play/my-game/report', 'broken'], ['https://hawkesgames.com/v1/play/my-game/report', 'broken']]);
});

test('hawkesgen.ai: by what the caller carries', async () => {
  const oauth = await run('https://hawkesgen.ai/v1/jobs', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer hgo_abc' } });
  assert.deepEqual(to(oauth.seen), ['https://hawkesgames.com/v1/jobs'], 'a portal OAuth token');
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

test("hawkesgen.ai: Gen's MCP, its sign-in and its signed links are Gen's alone, refused or not (2026-10-30)", async () => {
  for (const p of ['/mcp', '/oauth/token', '/oauth/authorize?x=1', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/dl/a.b/x.png', '/up/a.b/x.png']) {
    const { res, seen } = await run(`https://hawkesgen.ai${p}`, { method: 'POST', body: '{}', headers: { 'Content-Length': '2', Authorization: 'Bearer hgo_old' } }, { 'https://gen.run.app': 401 });
    assert.equal(res.status, 401, p);
    assert.deepEqual(to(seen), [`https://gen.run.app${p}`], p);
  }
});

// A deploy's handover (2026-11-02): for about half a minute Cloud Run answers with Google's HTML error page, or Gen's
// stand-in for the old copy answers 503 X-Hawkes-Restarting. Reads wait it out; writes and the stream never see HTML.
import { restarting, setWait, RETRY_WAITS } from '../server/gen-edge/src/index.ts';

async function runSeq(url: string, init: RequestInit, answers: (() => Response)[]) {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => answers[Math.min(n++, answers.length - 1)]()) as typeof fetch;
  setWait(async () => {});
  try {
    return { res: await worker.fetch(new Request(url, init), env), tries: n };
  } finally {
    globalThis.fetch = real;
  }
}
const googlePage = () => new Response('<html><title>500 Server Error</title></html>', { status: 500, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const standby = () => new Response('{"error":"restarting"}', { status: 503, headers: { 'Content-Type': 'application/json', 'X-Hawkes-Restarting': '1' } });
const stream = () => new Response(': hello\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

test('restarting: Google\'s HTML error page and the stand-in, not Gen\'s own JSON errors', () => {
  assert.equal(restarting(googlePage()), true);
  assert.equal(restarting(standby()), true);
  assert.equal(restarting(new Response('{"error":"x"}', { status: 500, headers: { 'Content-Type': 'application/json' } })), false);
  assert.equal(restarting(new Response('{"error":"busy"}', { status: 503, headers: { 'Content-Type': 'application/json' } })), false);
  assert.equal(restarting(new Response('ok', { status: 200, headers: { 'Content-Type': 'text/html' } })), false);
});

test('the event stream waits out a restart and then is Gen\'s own stream', async () => {
  const { res, tries } = await runSeq('https://hawkesgen.ai/v1/events', { headers: { Accept: 'text/event-stream' } }, [googlePage, standby, stream]);
  assert.equal(tries, 3);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), ': hello\n\n');
});

test('the event stream, Gen still down after the waits: a stream that tells the browser to open it again, never HTML', async () => {
  const { res, tries } = await runSeq('https://hawkesgen.ai/v1/events', {}, [googlePage]);
  assert.equal(tries, RETRY_WAITS.length + 1);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type') ?? '', /text\/event-stream/);
  assert.match(await res.text(), /^retry: 5000\n/);
});

test('an API read still failing gets Gen\'s JSON error shape; a write is never sent twice', async () => {
  const read = await runSeq('https://hawkesgen.ai/v1/assets', {}, [googlePage]);
  assert.equal(read.res.status, 503);
  assert.equal((await read.res.json()).kind, 'restarting');
  const write = await runSeq('https://hawkesgen.ai/v1/jobs', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Content-Length': '2' } }, [googlePage, stream]);
  assert.equal(write.tries, 1);
  assert.equal(write.res.status, 503);
  assert.match(write.res.headers.get('Content-Type') ?? '', /application\/json/);
});

test('a page during a restart: a short plain page, not Google\'s', async () => {
  const { res } = await runSeq('https://hawkesgen.ai/', { headers: HTML }, [googlePage]);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /restarting/);
});
