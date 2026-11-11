// Gen tells Hawkes Studio when its lane runs a deploy, so a play of that commit starts then (J, 2026-11-11: "Use the
// deploy's completion event, not polling"). src/studioannounce.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { announceDeployed, resetAnnounce, announceState, ANNOUNCE_GAP_MS, studioUrl } from '../src/studioannounce.ts';

const ENV: Record<string, string> = { K_SERVICE: 'gen-beta', HAWKESGEN_COMMIT: 'abc1234def', HAWKESGEN_LANE: 'beta' };
const get = (e: Record<string, string>) => (k: string) => e[k];
const fake = (seen: (n: number) => boolean | number) => {
  const calls: { url: string; init: any }[] = [];
  let posts = 0;
  const f = (async (url: string, init: any) => {
    calls.push({ url, init });
    if (url.startsWith('http://metadata.google.internal/')) return new Response('id.token.sig');
    posts++;
    const s = seen(posts);
    if (typeof s === 'number') return new Response(JSON.stringify({ error: 'down' }), { status: s });
    return new Response(JSON.stringify({ ok: true, seen: s }));
  }) as unknown as typeof fetch;
  return { f, calls, posts: () => posts };
};

test("it says which repo, lane and commit, with the service's own Google ID token for Studio's address", async () => {
  resetAnnounce();
  const { f, calls } = fake(() => true);
  assert.equal(await announceDeployed({ get: get(ENV), fetcher: f, now: () => 1 }), 'seen');
  assert.match(calls[0].url, /identity\?audience=https%3A%2F%2Fstudio\.hawkesgen\.ai%2Fo%2Fj-studio-4f12&format=full$/);
  assert.equal(calls[0].init.headers['Metadata-Flavor'], 'Google');
  assert.equal(calls[1].url, 'https://studio.hawkesgen.ai/o/j-studio-4f12/api/hooks/deployed');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer id.token.sig');
  assert.deepEqual(JSON.parse(calls[1].init.body), { repo: 'jgriffith3433/hawkesgen', lane: 'beta', commit: 'abc1234def' });
});

test('once Studio has seen it, the instance says nothing more', async () => {
  resetAnnounce();
  const { f, posts } = fake(() => true);
  let t = 0;
  await announceDeployed({ get: get(ENV), fetcher: f, now: () => t });
  for (let i = 0; i < 20; i++) { t += ANNOUNCE_GAP_MS * 2; assert.equal(await announceDeployed({ get: get(ENV), fetcher: f, now: () => t }), 'skipped'); }
  assert.equal(posts(), 1);
});

test('not seen yet (traffic still on the old revision): says it again on a later health request, at most once a gap', async () => {
  resetAnnounce();
  const { f, posts } = fake((n) => n >= 3);
  let t = 0;
  assert.equal(await announceDeployed({ get: get(ENV), fetcher: f, now: () => t }), 'not-yet');
  t += 1000;
  assert.equal(await announceDeployed({ get: get(ENV), fetcher: f, now: () => t }), 'skipped');
  t += ANNOUNCE_GAP_MS;
  assert.equal(await announceDeployed({ get: get(ENV), fetcher: f, now: () => t }), 'not-yet');
  t += ANNOUNCE_GAP_MS;
  assert.equal(await announceDeployed({ get: get(ENV), fetcher: f, now: () => t }), 'seen');
  assert.equal(posts(), 3);
  assert.equal(announceState().seen, true);
});

test('Studio down or refusing: it never throws, and tries again on a later health request', async () => {
  resetAnnounce();
  const { f } = fake((n) => (n === 1 ? 503 : true));
  let t = 0;
  assert.equal(await announceDeployed({ get: get(ENV), fetcher: f, now: () => t }), 'failed');
  t += ANNOUNCE_GAP_MS;
  assert.equal(await announceDeployed({ get: get(ENV), fetcher: f, now: () => t }), 'seen');
});

test('not on Cloud Run, or no commit: nothing is said', async () => {
  resetAnnounce();
  const { f, calls } = fake(() => true);
  assert.equal(await announceDeployed({ get: get({ HAWKESGEN_COMMIT: 'abc1234' }), fetcher: f }), 'skipped');
  assert.equal(await announceDeployed({ get: get({ K_SERVICE: 'gen' }), fetcher: f }), 'skipped');
  assert.equal(calls.length, 0);
  assert.equal(studioUrl(get({ HAWKES_STUDIO_URL: 'https://studio.example.com/o/x/' })), 'https://studio.example.com/o/x');
});

test('the live lane says live', async () => {
  resetAnnounce();
  const { f, calls } = fake(() => true);
  await announceDeployed({ get: get({ ...ENV, HAWKESGEN_LANE: '' }), fetcher: f });
  assert.equal(JSON.parse(calls[1].init.body).lane, 'live');
});

test('two health requests at once make one call', async () => {
  resetAnnounce();
  const { f, posts } = fake(() => true);
  const [a, b] = await Promise.all([announceDeployed({ get: get(ENV), fetcher: f }), announceDeployed({ get: get(ENV), fetcher: f })]);
  assert.deepEqual([a, b].sort(), ['seen', 'skipped']);
  assert.equal(posts(), 1);
});

test('random health requests: one call per gap at most, none after seen, and nothing runs on its own', async () => {
  let seed = 11;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 100; round++) {
    resetAnnounce();
    const seenAt = 1 + rnd(5);
    const { f, posts } = fake((n) => (rnd(6) === 0 ? 500 : n >= seenAt));
    let t = 0;
    const at: number[] = [];
    for (let i = 0; i < 40; i++) {
      t += rnd(15_000);
      const before = posts();
      await announceDeployed({ get: get(ENV), fetcher: f, now: () => t });
      if (posts() > before) at.push(t);
    }
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= ANNOUNCE_GAP_MS);
    if (announceState().seen) assert.equal(at.length, posts());
  }
  const src = fs.readFileSync(new URL('../src/studioannounce.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /setInterval|setTimeout/);
  const api = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(api, /route === '\/v1\/health'[\s\S]{0,1200}announceDeployed\(\)/);
});
