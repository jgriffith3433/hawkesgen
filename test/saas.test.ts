// Multi-tenant SaaS tests: user signup/login/logout, session cookie auth, API key rotation,
// strict tenant isolation (User A vs User B across jobs, assets, entities, and internal tools),
// credit quoting, upfront job credit reservation, 402 insufficient credits, automatic refund on
// failure/cancel, Stripe webhook signature verification & idempotency, and GET /v1/portfolio.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-saas-'));
process.env.HAWKESGEN_STARTER_CREDITS = '50';

const { handle } = await import('../src/api.ts');
const { queue, failJob } = await import('../src/jobs.ts');
(queue as any).pump = () => {}; // keep submitted jobs queued in offline tests
const { putAsset } = await import('../src/library.ts');
const { quoteJobCredits, refundJobCredits } = await import('../src/billing.ts');

const server = http.createServer((req, res) =>
  handle(req, res).catch((e) => {
    res.writeHead(500);
    res.end(String(e));
  }),
);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as any).port;
const baseUrl = `http://127.0.0.1:${port}`;

test.after(() => server.close());

async function reqJson(
  route: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string | Buffer } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let payload: string | Buffer | undefined;
  if (opts.rawBody !== undefined) {
    payload = opts.rawBody;
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${route}`, {
    method: opts.method ?? (payload !== undefined ? 'POST' : 'GET'),
    headers,
    body: payload as any,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { status: res.status, body: json, setCookie, headers: res.headers };
}

function extractSessionCookie(setCookie: string): string {
  const m = /hg_session=([^;]*)/.exec(setCookie);
  return m ? `hg_session=${m[1]}` : '';
}

test('signup, login, session cookie auth, logout, and API key rotation', async () => {
  // 1. Signup User A
  const sA = await reqJson('/v1/users/signup', {
    body: { email: 'Alice@Example.com', password: 'password123', name: 'Alice' },
  });
  assert.equal(sA.status, 200);
  assert.equal(sA.body.user.email, 'alice@example.com');
  assert.equal(sA.body.user.name, 'Alice');
  assert.equal(sA.body.user.credits, 50);
  assert.match(sA.body.user.project, /^u_[0-9a-f]+$/);
  assert.match(sA.body.apiKey, /^hg_/);
  const cookieA = extractSessionCookie(sA.setCookie);
  assert.ok(cookieA.startsWith('hg_session=') && cookieA.length > 20);
  assert.match(sA.setCookie, /HttpOnly/);
  assert.match(sA.setCookie, /SameSite=Lax/);

  // Duplicate signup is rejected with 409
  const dup = await reqJson('/v1/users/signup', {
    body: { email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(dup.status, 409);

  // 2. Authenticate with session cookie on GET /v1/users/me
  const meCookie = await reqJson('/v1/users/me', { headers: { Cookie: cookieA } });
  assert.equal(meCookie.status, 200);
  assert.equal(meCookie.body.user.id, sA.body.user.id);
  assert.equal(meCookie.body.user.credits, 50);
  assert.deepEqual(meCookie.body.client.projects, [sA.body.user.project]);

  // 3. Authenticate with initial API key
  const oldKey = sA.body.apiKey;
  const meKey = await reqJson('/v1/users/me', { headers: { Authorization: `Bearer ${oldKey}` } });
  assert.equal(meKey.status, 200);
  assert.equal(meKey.body.user.email, 'alice@example.com');

  // 4. Rotate API key: old key is disabled, new key works
  const rot = await reqJson('/v1/users/api-key', { method: 'POST', headers: { Cookie: cookieA } });
  assert.equal(rot.status, 200);
  assert.match(rot.body.apiKey, /^hg_/);
  assert.notEqual(rot.body.apiKey, oldKey);

  // Old key should fail when HAWKESGEN_PUBLIC_SAAS=1
  process.env.HAWKESGEN_PUBLIC_SAAS = '1';
  try {
    const anonRes = await reqJson('/v1/users/me');
    assert.equal(anonRes.status, 401);

    const oldKeyRes = await reqJson('/v1/users/me', { headers: { Authorization: `Bearer ${oldKey}` } });
    assert.equal(oldKeyRes.status, 401);

    const newKeyRes = await reqJson('/v1/users/me', { headers: { Authorization: `Bearer ${rot.body.apiKey}` } });
    assert.equal(newKeyRes.status, 200);
    assert.equal(newKeyRes.body.user.id, sA.body.user.id);
  } finally {
    delete process.env.HAWKESGEN_PUBLIC_SAAS;
  }

  // 5. Logout clears session and invalidates token
  const out = await reqJson('/v1/users/logout', { method: 'POST', headers: { Cookie: cookieA } });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);

  process.env.HAWKESGEN_PUBLIC_SAAS = '1';
  try {
    const afterLogout = await reqJson('/v1/users/me', { headers: { Cookie: cookieA } });
    assert.equal(afterLogout.status, 401);
  } finally {
    delete process.env.HAWKESGEN_PUBLIC_SAAS;
  }

  // 6. Login issues a fresh session cookie
  const badLogin = await reqJson('/v1/users/login', {
    body: { email: 'alice@example.com', password: 'wrongpassword' },
  });
  assert.equal(badLogin.status, 401);

  const login = await reqJson('/v1/users/login', {
    body: { email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(login.status, 200);
  const freshCookie = extractSessionCookie(login.setCookie);
  assert.ok(freshCookie.length > 20);
  const meAgain = await reqJson('/v1/users/me', { headers: { Cookie: freshCookie } });
  assert.equal(meAgain.status, 200);
  assert.equal(meAgain.body.user.id, sA.body.user.id);
});

test('strict multi-tenant isolation between User A and User B (jobs, assets, entities, internal tools)', async () => {
  const uA = await reqJson('/v1/users/signup', {
    body: { email: 'tenanta@example.com', password: 'password123', name: 'Tenant A' },
  });
  const uB = await reqJson('/v1/users/signup', {
    body: { email: 'tenantb@example.com', password: 'password123', name: 'Tenant B' },
  });
  const keyA = uA.body.apiKey;
  const keyB = uB.body.apiKey;
  const projA = uA.body.user.project;
  const projB = uB.body.user.project;
  const authA = { Authorization: `Bearer ${keyA}` };
  const authB = { Authorization: `Bearer ${keyB}` };

  // 1. Submitting a job as User A forces project = projA even if another project is sent
  const jobResA = await reqJson('/v1/jobs', {
    headers: authA,
    body: { project: projB, tool: 'image.generate', params: { prompt: 'a neon cyber samurai' } },
  });
  assert.equal(jobResA.status, 200);
  const jobA = jobResA.body.jobs[0];
  assert.equal(jobA.project, projA);

  // User B cannot see User A's job in list or by ID
  const jobsListB = await reqJson('/v1/jobs', { headers: authB });
  assert.equal(jobsListB.status, 200);
  assert.equal(jobsListB.body.jobs.length, 0);

  const jobGetByB = await reqJson(`/v1/jobs/${jobA.id}`, { headers: authB });
  assert.equal(jobGetByB.status, 404);

  const jobsCrossQuery = await reqJson(`/v1/jobs?project=${projA}`, { headers: authB });
  assert.equal(jobsCrossQuery.status, 403);

  // 2. Assets isolation: create an asset for User A, one for User B, and one public asset
  const assetA = putAsset({
    data: Buffer.from('asset-a-bytes'),
    ext: '.png',
    client: uA.body.user.id,
    project: projA,
    tool: 'image.generate',
    recipe: { tool: 'image.generate', version: 1, params: { prompt: 'a' }, inputs: {} },
    title: 'Alice Private Asset',
  });
  const assetB = putAsset({
    data: Buffer.from('asset-b-bytes'),
    ext: '.png',
    client: uB.body.user.id,
    project: projB,
    tool: 'image.generate',
    recipe: { tool: 'image.generate', version: 1, params: { prompt: 'b' }, inputs: {} },
    title: 'Bob Private Asset',
  });
  const assetPublic = putAsset({
    data: Buffer.from('public-bytes'),
    ext: '.png',
    client: 'local',
    project: 'public',
    tool: 'image.generate',
    recipe: { tool: 'image.generate', version: 1, params: { prompt: 'pub' }, inputs: {} },
    title: 'Public Showcase Asset',
  });

  // GET /v1/assets and GET /v1/library for User A only return projA assets
  const listAssetsA = await reqJson('/v1/assets', { headers: authA });
  assert.equal(listAssetsA.status, 200);
  assert.deepEqual(listAssetsA.body.items.map((x: any) => x.id), [assetA.id]);

  const listLibB = await reqJson('/v1/library', { headers: authB });
  assert.equal(listLibB.status, 200);
  assert.deepEqual(listLibB.body.items.map((x: any) => x.id), [assetB.id]);

  // User A cannot fetch User B's asset metadata or file
  assert.equal((await reqJson(`/v1/assets/${assetB.id}`, { headers: authA })).status, 404);
  assert.equal((await reqJson(`/v1/assets/${assetB.id}/file`, { headers: authA })).status, 404);
  assert.equal((await reqJson(`/v1/files/${assetB.id}`, { headers: authA })).status, 404);

  // User A CAN fetch their own asset and public assets
  assert.equal((await reqJson(`/v1/assets/${assetA.id}`, { headers: authA })).status, 200);
  assert.equal((await reqJson(`/v1/assets/${assetA.id}/file`, { headers: authA })).status, 200);
  assert.equal((await reqJson(`/v1/assets/${assetPublic.id}`, { headers: authA })).status, 200);
  assert.equal((await reqJson(`/v1/assets/${assetPublic.id}/file`, { headers: authA })).status, 200);
  // But User A cannot PATCH a public asset
  assert.equal((await reqJson(`/v1/assets/${assetPublic.id}`, { method: 'PATCH', headers: authA, body: { title: 'Hacked' } })).status, 403);

  // 3. Entities isolation
  const entA = await reqJson('/v1/entities', {
    headers: authA,
    body: { name: 'Hero A', kind: 'character' },
  });
  assert.equal(entA.status, 200);
  assert.equal(entA.body.project, projA);
  assert.equal(entA.body.id, `${projA}/hero-a`);

  // User B cannot create an entity in projA or read/patch User A's entity
  const crossEntCreate = await reqJson('/v1/entities', {
    headers: authB,
    body: { project: projA, name: 'Intruder', kind: 'character' },
  });
  assert.equal(crossEntCreate.status, 403);

  const listEntB = await reqJson('/v1/entities', { headers: authB });
  assert.equal(listEntB.status, 200);
  assert.equal(listEntB.body.items.length, 0);

  assert.equal((await reqJson(`/v1/entities/${projA}/hero-a`, { headers: authB })).status, 403);
  assert.equal((await reqJson(`/v1/entities/${projA}/hero-a`, { method: 'PATCH', headers: authB, body: { name: 'Stolen' } })).status, 403);

  // 4. Internal-only tools blocked with 403 for role === 'user'
  for (const internalTool of ['unity.build', 'unity.test', 'playtest.run', 'playtest.review']) {
    const blocked = await reqJson('/v1/jobs', {
      headers: authA,
      body: { tool: internalTool, params: {} },
    });
    assert.equal(blocked.status, 403, `Expected ${internalTool} to return 403 for user role`);
  }
});

test('credit packs, quoting, upfront reservation, 402 insufficient credits, and automatic refund on cancel/failure', async () => {
  // 1. Public credit packs endpoint
  const packsRes = await reqJson('/v1/billing/packs');
  assert.equal(packsRes.status, 200);
  assert.deepEqual(
    packsRes.body.packs.map((p: any) => [p.id, p.priceCents, p.credits]),
    [
      ['starter_10', 1000, 1000],
      ['creator_25', 2500, 2750],
      ['studio_100', 10000, 12000],
    ],
  );

  // 2. Tool credit quoting across categories
  assert.ok(quoteJobCredits('image.cutout', {}).credits >= 2 && quoteJobCredits('image.cutout', {}).credits <= 5);
  assert.ok(quoteJobCredits('texture.maps', {}).credits >= 5);
  assert.ok(quoteJobCredits('image.generate', { prompt: 'test' }).credits >= 5);
  assert.ok(quoteJobCredits('audio.sfx', { prompt: 'laser' }).credits >= 8);
  assert.ok(quoteJobCredits('audio.music', { prompt: 'synthwave' }).credits >= 20);
  assert.ok(quoteJobCredits('mesh.rig', {}).credits >= 20);
  assert.ok(quoteJobCredits('video.i2v', { prompt: 'walk' }).credits >= 40);
  assert.ok(quoteJobCredits('mesh.views3d', {}).credits >= 50);
  const chainQuote = quoteJobCredits('asset.make', {
    steps: [
      { tool: 'image.generate', params: { prompt: 'prop' } },
      { tool: 'image.remove-background', params: {} },
    ],
    candidates: 2,
  });
  assert.ok(chainQuote.credits >= 12);

  // 3. Signup user (starts with 50 credits)
  const signup = await reqJson('/v1/users/signup', {
    body: { email: 'spender@example.com', password: 'password123' },
  });
  const auth = { Authorization: `Bearer ${signup.body.apiKey}` };

  // Quote via API
  const qApi = await reqJson('/v1/billing/quote', {
    headers: auth,
    body: { tool: 'image.generate', params: { prompt: 'castle' } },
  });
  assert.equal(qApi.status, 200);
  assert.equal(qApi.body.userCredits, 50);
  assert.equal(qApi.body.canAfford, true);
  const imgCredits = qApi.body.credits;
  assert.ok(imgCredits >= 5);

  // 4. Submit a video job (40 credits) -> reserves 40 credits, leaving 10 credits
  const vidQuote = quoteJobCredits('video.t2v', { prompt: 'cinematic drone shot' }).credits;
  assert.equal(vidQuote, 40);
  const job1Res = await reqJson('/v1/jobs', {
    headers: auth,
    body: { tool: 'video.t2v', params: { prompt: 'cinematic drone shot' } },
  });
  assert.equal(job1Res.status, 200);
  const job1 = job1Res.body.jobs[0];

  const ledger1 = await reqJson('/v1/billing/ledger', { headers: auth });
  assert.equal(ledger1.status, 200);
  assert.equal(ledger1.body.credits, 50 - vidQuote);
  assert.equal(ledger1.body.entries[0].kind, 'job_reserve');
  assert.equal(ledger1.body.entries[0].delta, -vidQuote);
  assert.equal(ledger1.body.entries[0].job_id, job1.id);

  // 5. Submitting another 40-credit video job now fails with 402 Insufficient credits
  const jobInsufficient = await reqJson('/v1/jobs', {
    headers: auth,
    body: { tool: 'video.t2v', params: { prompt: 'second drone shot' } },
  });
  assert.equal(jobInsufficient.status, 402);
  assert.match(jobInsufficient.body.error, /Insufficient credits/);

  // 6. Cancelling job1 automatically refunds the 40 credits
  const cancelRes = await reqJson(`/v1/jobs/${job1.id}/cancel`, { method: 'POST', headers: auth });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.status, 'cancelled');

  // Calling refundJobCredits again is idempotent
  refundJobCredits(job1.id);

  const ledgerAfterCancel = await reqJson('/v1/billing/ledger', { headers: auth });
  assert.equal(ledgerAfterCancel.body.credits, 50);
  assert.equal(ledgerAfterCancel.body.entries[0].kind, 'job_refund');
  assert.equal(ledgerAfterCancel.body.entries[0].delta, vidQuote);

  // 7. Submit another job and simulate failure -> automatically refunds reserved credits
  const job2Res = await reqJson('/v1/jobs', {
    headers: auth,
    body: { tool: 'audio.music', params: { prompt: 'boss battle theme' } },
  });
  assert.equal(job2Res.status, 200);
  const job2 = job2Res.body.jobs[0];
  failJob(job2.id, 'GPU worker disconnected');

  const ledgerAfterFail = await reqJson('/v1/billing/ledger', { headers: auth });
  assert.equal(ledgerAfterFail.body.credits, 50);
  assert.equal(ledgerAfterFail.body.entries[0].kind, 'job_refund');
  assert.equal(ledgerAfterFail.body.entries[0].job_id, job2.id);
});

test('Stripe checkout (503 when unconfigured) and webhook signature verification + idempotent credit grant', async () => {
  const signup = await reqJson('/v1/users/signup', {
    body: { email: 'buyer@example.com', password: 'password123' },
  });
  const userId = signup.body.user.id;
  const auth = { Authorization: `Bearer ${signup.body.apiKey}` };

  // 1. Checkout returns 503 when STRIPE_SECRET_KEY is not set
  delete process.env.STRIPE_SECRET_KEY;
  const noStripe = await reqJson('/v1/billing/checkout', {
    headers: auth,
    body: { packId: 'creator_25' },
  });
  assert.equal(noStripe.status, 503);
  assert.match(noStripe.body.error, /Stripe is not configured/);

  // 2. Webhook signature verification & credit grant
  const webhookSecret = 'whsec_test_secret_key_12345';
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  try {
    const eventPayload = JSON.stringify({
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_session_2750',
          payment_status: 'paid',
          customer: 'cus_test_buyer',
          client_reference_id: userId,
          metadata: {
            user_id: userId,
            pack_id: 'creator_25',
            credits: '2750',
          },
        },
      },
    });

    // Invalid signature -> 400
    const badSig = await reqJson('/v1/billing/webhook', {
      rawBody: eventPayload,
      headers: { 'Stripe-Signature': `t=${Math.floor(Date.now() / 1000)},v1=deadbeef` },
    });
    assert.equal(badSig.status, 400);

    // Expired timestamp -> 400
    const oldTs = Math.floor(Date.now() / 1000) - 1000;
    const oldHmac = crypto.createHmac('sha256', webhookSecret).update(`${oldTs}.${eventPayload}`).digest('hex');
    const expiredSig = await reqJson('/v1/billing/webhook', {
      rawBody: eventPayload,
      headers: { 'Stripe-Signature': `t=${oldTs},v1=${oldHmac}` },
    });
    assert.equal(expiredSig.status, 400);

    // Valid signature -> 200 and grants 2,750 credits (50 + 2750 = 2800)
    const nowTs = Math.floor(Date.now() / 1000);
    const validHmac = crypto.createHmac('sha256', webhookSecret).update(`${nowTs}.${eventPayload}`).digest('hex');
    const okHook = await reqJson('/v1/billing/webhook', {
      rawBody: eventPayload,
      headers: { 'Stripe-Signature': `t=${nowTs},v1=${validHmac}` },
    });
    assert.equal(okHook.status, 200);
    assert.equal(okHook.body.ok, true);
    assert.equal(okHook.body.duplicate, false);
    assert.equal(okHook.body.creditsAdded, 2750);
    assert.equal(okHook.body.balance, 2800);

    // Replaying the exact same webhook session ID is idempotent (no double credit)
    const replayHook = await reqJson('/v1/billing/webhook', {
      rawBody: eventPayload,
      headers: { 'Stripe-Signature': `t=${nowTs},v1=${validHmac}` },
    });
    assert.equal(replayHook.status, 200);
    assert.equal(replayHook.body.duplicate, true);
    assert.equal(replayHook.body.creditsAdded, 0);
    assert.equal(replayHook.body.balance, 2800);

    const ledger = await reqJson('/v1/billing/ledger', { headers: auth });
    assert.equal(ledger.body.credits, 2800);
    const purchases = ledger.body.entries.filter((e: any) => e.kind === 'stripe_purchase');
    assert.equal(purchases.length, 1);
    assert.equal(purchases[0].delta, 2750);
    assert.equal(purchases[0].stripe_session_id, 'cs_test_session_2750');
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

test('GET /v1/portfolio returns the Built With Hawkes Gen production showcase', async () => {
  const res = await reqJson('/v1/portfolio');
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Built With Hawkes Gen');
  assert.equal(res.body.items.length, 7);
  const projects = res.body.items.map((x: any) => x.project);
  assert.deepEqual(projects, [
    'doseofdestruction',
    'phorigins',
    'sickofit',
    'yoobaland',
    'theplacedepartment',
    'imaginelivetv',
    'icanbe',
  ]);
  for (const item of res.body.items) {
    assert.ok(item.title && item.genre && item.liveUrl.startsWith('https://'));
    assert.ok(item.description.length > 20);
    assert.ok(item.assetCounts.total > 0);
    assert.ok(Array.isArray(item.tools) && item.tools.length > 0);
    assert.ok(Array.isArray(item.pipelines) && item.pipelines.length > 0);
  }
});

test('runtime Stripe config (GET/POST /v1/billing/config and GET /v1/billing/packs) and X-Hawkes-Public-Saas: 1 header', async () => {
  const signup = await reqJson('/v1/users/signup', {
    body: { email: 'nonowner@example.com', password: 'password123' },
  });
  const userAuth = { Authorization: `Bearer ${signup.body.apiKey}` };

  // 1. Non-owner cannot read or write /v1/billing/config
  assert.equal((await reqJson('/v1/billing/config', { headers: userAuth })).status, 403);
  assert.equal((await reqJson('/v1/billing/config', { method: 'POST', headers: userAuth, body: { publishableKey: 'pk_test_123' } })).status, 403);

  // 2. Owner can read and save runtime Stripe config in .data/stripe.json
  const initialCfg = await reqJson('/v1/billing/config');
  assert.equal(initialCfg.status, 200);
  assert.equal(initialCfg.body.configured, false);
  assert.equal(initialCfg.body.publishableKey, null);
  assert.equal(initialCfg.body.mode, null);

  const savedCfg = await reqJson('/v1/billing/config', {
    method: 'POST',
    body: {
      secretKey: 'sk_live_runtime_test_999',
      publishableKey: 'pk_live_runtime_pub_999',
      webhookSecret: 'whsec_runtime_hook_999',
    },
  });
  assert.equal(savedCfg.status, 200);
  assert.equal(savedCfg.body.configured, true);
  assert.equal(savedCfg.body.hasSecretKey, true);
  assert.equal(savedCfg.body.hasPublishableKey, true);
  assert.equal(savedCfg.body.hasWebhookSecret, true);
  assert.equal(savedCfg.body.publishableKey, 'pk_live_runtime_pub_999');
  assert.equal(savedCfg.body.mode, 'live');
  assert.equal('secretKey' in savedCfg.body, false);
  assert.equal('webhookSecret' in savedCfg.body, false);

  // 3. GET /v1/billing/packs includes stripe.publishableKey, configured, and mode
  const packsRes = await reqJson('/v1/billing/packs');
  assert.equal(packsRes.status, 200);
  assert.deepEqual(packsRes.body.stripe, {
    configured: true,
    publishableKey: 'pk_live_runtime_pub_999',
    mode: 'live',
  });

  // Clean up runtime Stripe config so other tests see clean state
  await reqJson('/v1/billing/config', {
    method: 'POST',
    body: { secretKey: '', publishableKey: '', webhookSecret: '' },
  });

  // 4. X-Hawkes-Public-Saas: 1 serves dashboard/public/landing.html at / and requires auth on /v1/me
  const adminRoot = await reqJson('/');
  assert.equal(adminRoot.status, 200);
  assert.equal(typeof adminRoot.body, 'string');
  assert.ok(!adminRoot.body.includes('Build Web Games with AI'));

  const publicRoot = await reqJson('/', { headers: { 'X-Hawkes-Public-Saas': '1' } });
  assert.equal(publicRoot.status, 200);
  assert.equal(typeof publicRoot.body, 'string');
  assert.ok(publicRoot.body.includes('Build Web Games with AI'));

  const localMe = await reqJson('/v1/me');
  assert.equal(localMe.status, 200);
  assert.equal(localMe.body.role, 'owner');

  const publicAnonMe = await reqJson('/v1/me', { headers: { 'X-Hawkes-Public-Saas': '1' } });
  assert.equal(publicAnonMe.status, 401);

  const publicAuthMe = await reqJson('/v1/me', {
    headers: { 'X-Hawkes-Public-Saas': '1', ...userAuth },
  });
  assert.equal(publicAuthMe.status, 200);
  assert.equal(publicAuthMe.body.role, 'user');
});
