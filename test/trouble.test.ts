// What the person reads when a call fails (dashboard/gen/trouble.js, lib.js friendly/api): one plain sentence and a next
// step for offline, 401, 402, 429 (with Retry-After) and 503, and never raw JSON, a trace or a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, bus, ApiError } from '../dashboard/gen/lib.js';
import { explain, scrub } from '../dashboard/gen/trouble.js';

const junk = 'Traceback (most recent call last):\n  File "x.py", line 3\nhg_0123456789abcdef';
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => async () => new Response(JSON.stringify(body), { status, headers });

test('each state has its sentence and next step', async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as any;
    let e = await api('/v1/assets').catch((x) => x);
    assert.equal(e.status, 0);
    assert.match(explain(e).text, /Can.t reach Gen/);
    assert.equal(explain(e).label, 'Try again');

    globalThis.fetch = answer(402, { error: 'not enough credits ' + junk }) as any;
    e = await api('/v1/jobs', { body: {} }).catch((x) => x);
    assert.match(explain(e).text, /out of credits.*\$10/);
    assert.equal(explain(e).label, 'Add credits');

    globalThis.fetch = answer(429, { error: 'slow down' }, { 'Retry-After': '7' }) as any;
    e = await api('/v1/jobs', { body: {} }).catch((x) => x);
    assert.equal(e.retryAfter, 7);
    assert.equal(explain(e).text, 'Too many requests, try again in 7 s.');

    globalThis.fetch = answer(503, { error: 'no gpu ' + junk }) as any;
    e = await api('/v1/jobs', { body: {} }).catch((x) => x);
    assert.match(explain(e).text, /busy or resting/);
    assert.equal(explain(e).label, 'Try again');
    for (const s of ['offline', 402, 503]) assert.doesNotMatch(explain(e).text, /Traceback|hg_|[{}]/, String(s));
  } finally { globalThis.fetch = real; }
});

test('a 401 on any call but the session probe says the session ended', async () => {
  const real = globalThis.fetch;
  const seen: string[] = [];
  const off = bus.on('sessionEnded', (p: string) => seen.push(p));
  try {
    globalThis.fetch = answer(401, { error: 'sign in' }) as any;
    const e = await api('/v1/assets').catch((x) => x);
    await api('/v1/users/me').catch(() => {});
    assert.deepEqual(seen, ['/v1/assets']);
    assert.equal(explain(e).label, 'Sign in');
    assert.match(explain(e).text, /signed out.*your work/);
  } finally { globalThis.fetch = real; off(); }
});

test('raw JSON, traces and keys never reach a sentence', () => {
  assert.equal(scrub('{"error":"boom"}'), 'Something went wrong.');
  assert.doesNotMatch(scrub('failed with hg_0123456789abcdef'), /hg_0123/);
  assert.doesNotMatch(explain(new ApiError(junk, 500, null)).text, /Traceback|hg_|File/);
});
