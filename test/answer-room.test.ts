// AI answers that ran out of room and error pages shown as answers (2026-11-02, J: "The answer ran out of room before it
// finished. Raise maxTokens." after the AI pane printed "<!DOCTYPE html>"). Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputBudget, STREAMED_FLOOR, TOO_LONG } from '../src/providers/budget.ts';
import worker from '../server/gen-edge/src/index.ts';
import { api, plainError, looksLikeMarkup } from '../dashboard/gen/lib.js';

test('every streamed Claude request has room to think and answer; bigger asks keep their number', () => {
  assert.equal(outputBudget(4000), STREAMED_FLOOR);
  assert.equal(outputBudget(800), STREAMED_FLOOR);
  assert.equal(outputBudget(undefined), STREAMED_FLOOR);
  assert.equal(outputBudget(100000), 100000);
  assert.equal(outputBudget(500000), 128000);
  assert.equal(outputBudget(800, false), 16000);
  assert.ok(STREAMED_FLOOR >= 32000);
  assert.doesNotMatch(TOO_LONG, /maxTokens|max_tokens/);
});

const env = { GEN_ORIGIN: 'https://gen.run.app', PORTAL_ORIGIN: 'https://hawkesgames.com', PORTAL_HOSTS: 'hawkesgen.ai' };
async function withFetch<T>(fake: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("the Worker answers JSON when Gen drops the connection (a restart mid-answer), never Cloudflare's HTML page", async () => {
  for (const host of ['hawkesgen.ai', 'beta.hawkesgen.ai']) {
    const res = await withFetch((async () => { throw new Error('Network connection lost.'); }) as typeof fetch,
      () => worker.fetch(new Request(`https://${host}/v1/showrunner/turn`, { method: 'POST', body: '{"messages":[]}', headers: { 'Content-Type': 'application/json' } }), env));
    assert.equal(res.status, 502, host);
    assert.match(res.headers.get('Content-Type') ?? '', /application\/json/);
    const j = await res.json() as any;
    assert.match(j.error, /try again/);
  }
  const page = await withFetch((async () => { throw new Error('reset'); }) as typeof fetch, () => worker.fetch(new Request('https://hawkesgen.ai/'), env));
  assert.equal(page.status, 502);
  assert.doesNotMatch(await page.text(), /</);
});

test("an API call neither Gen nor the portal has gets Gen's JSON 404, not the portal's HTML page", async () => {
  const res = await withFetch((async (u: any) => {
    const url = new URL(String(u));
    return url.hostname === 'gen.run.app'
      ? new Response('{"error":"No such scene"}', { status: 404, headers: { 'Content-Type': 'application/json' } })
      : new Response('<!DOCTYPE html>\n<html><body>Not found</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } });
  }) as typeof fetch, () => worker.fetch(new Request('https://hawkesgen.ai/v1/showrunner/turn', { method: 'POST', body: '{}' }), env));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'No such scene' });
});

test('the app never shows an error page or a cut-off answer as words', async () => {
  for (const [status, body] of [[502, '<!DOCTYPE html>\n<html lang="en-US"><head><title>Worker threw exception</title>'], [200, '{"say":"half an ans'], [524, '<html><head>'], [503, 'Service Unavailable']] as const) {
    const err: any = await withFetch((async () => new Response(body, { status })) as typeof fetch, () => api('/v1/showrunner/turn', { body: {} })).then(() => null, (e) => e);
    assert.ok(err, `${status} should fail`);
    assert.doesNotMatch(err.message, /<|html|half an/i, `${status}`);
    assert.match(err.message, /try again/);
  }
  assert.ok(looksLikeMarkup('<!DOCTYPE html>'));
  assert.ok(looksLikeMarkup('tml>\n<html><head>'));
  assert.doesNotMatch(plainError('<!DOCTYPE html>\n<html>'), /</);
  assert.equal(plainError('That answer got too long'), 'That answer got too long');
});

test("a signed-out call to a Gen route the portal lacks gets Gen's 401, not the portal's JSON 404", async () => {
  const res = await withFetch((async (u: any) => new URL(String(u)).hostname === 'gen.run.app'
    ? new Response('{"error":"Send an API key"}', { status: 401, headers: { 'Content-Type': 'application/json' } })
    : new Response('{"error":"Not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
  () => worker.fetch(new Request('https://hawkesgen.ai/v1/editor/tools'), env));
  assert.equal(res.status, 401);
});
