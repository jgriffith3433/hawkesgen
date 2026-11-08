// Buying credits end to end (billing.ts): the pack's Checkout session, the app's return (GET /v1/billing/checkout/<id>:
// the balance, the receipt, a declined card, an expired session), the webhook racing the return (granted once either
// way), delayed payments, a plan's return, and the owner's webhook set-up. Stripe is a local stand-in (STRIPE_API_BASE)
// and the webhooks are signed as Stripe signs them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-checkout-'));
process.env.HAWKESGEN_STARTER_CREDITS = '50';
process.env.STRIPE_SECRET_KEY = 'sk_test_local';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local';

// The Stripe stand-in: records what Gen asked for and answers from `sessions` and `endpoints`.
const asked: { method: string; path: string; form: URLSearchParams }[] = [];
const sessions = new Map<string, any>();
let endpoints: any[] = [];
let made = 0;
const stripe = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const url = req.url ?? '';
  asked.push({ method: req.method ?? 'GET', path: url, form: new URLSearchParams(body) });
  const json = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/v1/checkout/sessions' && req.method === 'POST') return json(200, { id: 'cs_test_new1', url: 'https://checkout.stripe.test/cs_test_new1' });
  const m = url.match(/^\/v1\/checkout\/sessions\/([^?]+)/);
  if (m) return sessions.has(m[1]) ? json(200, sessions.get(m[1])) : json(404, { error: { message: 'No such checkout.session' } });
  if (url.startsWith('/v1/webhook_endpoints?')) return json(200, { data: endpoints });
  if (url === '/v1/webhook_endpoints' && req.method === 'POST') {
    const e = { id: `we_made${++made}`, url: new URLSearchParams(body).get('url'), secret: 'whsec_made_by_stripe' };
    endpoints.push({ id: e.id, url: e.url });
    return json(200, e);
  }
  const we = url.match(/^\/v1\/webhook_endpoints\/(we_\w+)$/);
  if (we && req.method === 'DELETE') { endpoints = endpoints.filter((e) => e.id !== we[1]); return json(200, { id: we[1], deleted: true }); }
  if (we) return json(200, { id: we[1] });
  return json(404, { error: { message: 'stand-in: no such route' } });
});
await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', () => r()));
process.env.STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as any).port}`;

const { handle } = await import('../src/api.ts');
const { signupUser } = await import('../src/users.ts');
const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => { server.close(); stripe.close(); });

const buyer = signupUser({ email: 'buyer@example.com', password: 'secret-123', name: 'Buyer' });
const other = signupUser({ email: 'other@example.com', password: 'secret-123', name: 'Other' });
const as = (who: { sessionToken: string }, route: string, body?: unknown, origin = 'https://beta.hawkesgen.ai') => fetch(base + route, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { cookie: `hg_session=${who.sessionToken}`, Origin: origin, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const hook = (event: unknown) => {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${payload}`).digest('hex');
  return fetch(`${base}/v1/billing/webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${v1}` }, body: payload });
};
const credits = async (who = buyer) => ((await (await as(who, '/v1/users/me')).json()) as any).user.credits as number;
const packSession = (id: string, over: Record<string, any> = {}) => ({
  id, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 2500, currency: 'usd',
  client_reference_id: buyer.user.id, customer: 'cus_buyer',
  metadata: { product: 'gen', user_id: buyer.user.id, pack_id: 'creator_25', credits: '2750' },
  payment_intent: { id: `pi_${id}`, status: 'succeeded', latest_charge: { id: `ch_${id}`, receipt_url: `https://pay.stripe.com/receipts/${id}` } },
  ...over,
});

test('a pack checkout: payment mode back to the app it came from, with the receipt emailed and the tag on the payment', async () => {
  const r = await as(buyer, '/v1/billing/checkout', { packId: 'creator_25' });
  assert.equal(r.status, 200, await r.clone().text());
  const out = (await r.json()) as any;
  assert.equal(out.url, 'https://checkout.stripe.test/cs_test_new1');
  const f = asked.at(-1)!.form;
  assert.equal(f.get('mode'), 'payment');
  assert.equal(f.get('success_url'), 'https://beta.hawkesgen.ai/?billing=success&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(f.get('cancel_url'), 'https://beta.hawkesgen.ai/?billing=cancelled');
  assert.equal(f.get('metadata[product]'), 'gen');
  assert.equal(f.get('line_items[0][price_data][unit_amount]'), '2500');
  assert.equal(f.get('payment_intent_data[receipt_email]'), 'buyer@example.com');
  assert.equal(f.get('payment_intent_data[metadata][product]'), 'gen');
  assert.equal(f.get('customer_creation'), 'always');
  // Another site's Origin never becomes the return address.
  await as(buyer, '/v1/billing/checkout', { packId: 'starter_10' }, 'https://evil.example');
  assert.equal(asked.at(-1)!.form.get('success_url'), 'https://hawkesgen.ai/?billing=success&session_id={CHECKOUT_SESSION_ID}');
  assert.equal((await as(buyer, '/v1/billing/checkout', { packId: 'nope' })).status, 400);
});

test('back from Checkout before the webhook: the return grants the pack once, shows the balance and the receipt', async () => {
  const before = await credits();
  sessions.set('cs_test_paid1', packSession('cs_test_paid1'));
  const r = await as(buyer, '/v1/billing/checkout/cs_test_paid1');
  assert.equal(r.status, 200, await r.clone().text());
  const st = (await r.json()) as any;
  assert.equal(st.status, 'paid');
  assert.equal(st.credits, 2750);
  assert.equal(st.balance, before + 2750);
  assert.equal(st.receiptUrl, 'https://pay.stripe.com/receipts/cs_test_paid1');
  assert.match(asked.at(-1)!.path, /expand\[\]=payment_intent\.latest_charge/);
  // Opening it again (the receipt) and the webhook arriving late change nothing.
  assert.equal(((await (await as(buyer, '/v1/billing/checkout/cs_test_paid1')).json()) as any).balance, before + 2750);
  const late = (await (await hook({ type: 'checkout.session.completed', data: { object: packSession('cs_test_paid1') } })).json()) as any;
  assert.equal(late.duplicate, true);
  assert.equal(late.creditsAdded, 0);
  assert.equal(await credits(), before + 2750);
  // The account now has a Stripe customer: its cards and receipts open in the billing portal.
  assert.equal(((await (await as(buyer, '/v1/users/me')).json()) as any).user.hasBilling, true);
});

test('the webhook first, then the return: still once', async () => {
  const before = await credits();
  const s = packSession('cs_test_paid2', { metadata: { product: 'gen', user_id: buyer.user.id, pack_id: 'starter_10', credits: '1000' } });
  sessions.set('cs_test_paid2', s);
  const h = (await (await hook({ type: 'checkout.session.completed', data: { object: s } })).json()) as any;
  assert.equal(h.creditsAdded, 1000);
  const st = (await (await as(buyer, '/v1/billing/checkout/cs_test_paid2')).json()) as any;
  assert.equal(st.status, 'paid');
  assert.equal(st.balance, before + 1000);
  assert.equal(await credits(), before + 1000);
});

test('the pack decides the credits, not the metadata', async () => {
  const before = await credits();
  const s = packSession('cs_test_meta', { metadata: { product: 'gen', user_id: buyer.user.id, pack_id: 'starter_10', credits: '999999' } });
  await hook({ type: 'checkout.session.completed', data: { object: s } });
  assert.equal(await credits(), before + 1000);
});

test('a declined card, an abandoned checkout and an expired one: nothing granted, plain words for the app', async () => {
  const before = await credits();
  sessions.set('cs_test_declined', packSession('cs_test_declined', {
    status: 'open', payment_status: 'unpaid',
    payment_intent: { id: 'pi_d', status: 'requires_payment_method', last_payment_error: { code: 'card_declined', message: 'Your card was declined.' }, latest_charge: null },
  }));
  const d = (await (await as(buyer, '/v1/billing/checkout/cs_test_declined')).json()) as any;
  assert.equal(d.status, 'declined');
  assert.equal(d.declined, 'Your card was declined.');
  assert.equal(d.receiptUrl, null);
  sessions.set('cs_test_open', packSession('cs_test_open', { status: 'open', payment_status: 'unpaid', payment_intent: null }));
  assert.equal(((await (await as(buyer, '/v1/billing/checkout/cs_test_open')).json()) as any).status, 'open');
  sessions.set('cs_test_expired', packSession('cs_test_expired', { status: 'expired', payment_status: 'unpaid', payment_intent: null }));
  assert.equal(((await (await as(buyer, '/v1/billing/checkout/cs_test_expired')).json()) as any).status, 'expired');
  const ex = (await (await hook({ type: 'checkout.session.expired', data: { object: sessions.get('cs_test_expired') } })).json()) as any;
  assert.equal(ex.charged, false);
  assert.equal(await credits(), before);
});

test("someone else's checkout, or a made-up id, is not found", async () => {
  sessions.set('cs_test_theirs', packSession('cs_test_theirs'));
  assert.equal((await as(other, '/v1/billing/checkout/cs_test_theirs')).status, 404);
  assert.equal((await as(buyer, '/v1/billing/checkout/../../v1/customers')).status, 404);
  assert.equal((await as(buyer, '/v1/billing/checkout/cs_test_missing123')).status, 502);
  assert.equal(await credits(other), 50);
});

test('a delayed payment: completed unpaid waits, async_payment_succeeded grants, async_payment_failed charges nothing', async () => {
  const before = await credits();
  const s = packSession('cs_test_async', { payment_status: 'unpaid' });
  sessions.set('cs_test_async', s);
  const pend = (await (await hook({ type: 'checkout.session.completed', data: { object: s } })).json()) as any;
  assert.equal(pend.pending, true);
  assert.equal(((await (await as(buyer, '/v1/billing/checkout/cs_test_async')).json()) as any).status, 'processing');
  assert.equal(await credits(), before);
  const ok = (await (await hook({ type: 'checkout.session.async_payment_succeeded', data: { object: { ...s, payment_status: 'paid' } } })).json()) as any;
  assert.equal(ok.creditsAdded, 2750);
  const failed = (await (await hook({ type: 'checkout.session.async_payment_failed', data: { object: packSession('cs_test_async2', { payment_status: 'unpaid' }) } })).json()) as any;
  assert.equal(failed.charged, false);
  assert.equal(await credits(), before + 2750);
});

test("a plan's return records it and grants the paid month once, with the invoice as the receipt", async () => {
  await fetch(`${base}/v1/subscriptions/plans`); // seeds the plans
  const before = await credits();
  sessions.set('cs_test_plan', {
    id: 'cs_test_plan', mode: 'subscription', status: 'complete', payment_status: 'paid', amount_total: 1200, currency: 'usd',
    client_reference_id: buyer.user.id, customer: 'cus_buyer',
    metadata: { product: 'gen', user_id: buyer.user.id, plan_id: 'gen_creator' },
    subscription: { id: 'sub_plan1', latest_invoice: { id: 'in_plan1', status: 'paid', hosted_invoice_url: 'https://invoice.stripe.com/i/in_plan1', subscription: 'sub_plan1', subscription_details: { metadata: { product: 'gen', user_id: buyer.user.id, plan_id: 'gen_creator' } } } },
  });
  const st = (await (await as(buyer, '/v1/billing/checkout/cs_test_plan')).json()) as any;
  assert.equal(st.status, 'paid');
  assert.equal(st.mode, 'subscription');
  assert.equal(st.receiptUrl, 'https://invoice.stripe.com/i/in_plan1');
  assert.equal(st.balance, before + 1500);
  const sub = ((await (await as(buyer, '/v1/subscriptions/me')).json()) as any).subscription;
  assert.equal(sub.planId, 'gen_creator');
  const late = (await (await hook({ type: 'invoice.paid', data: { object: { id: 'in_plan1', subscription: 'sub_plan1' } } })).json()) as any;
  assert.equal(late.duplicate, true);
  assert.equal(await credits(), before + 1500);
});

test('/v1/health says whether payments are on and in which mode, never a key', async () => {
  const h = (await (await fetch(`${base}/v1/health`)).json()) as any;
  assert.deepEqual(h.stripe, { configured: true, mode: 'test', webhook: true });
  assert.ok(!JSON.stringify(h).includes('sk_test_local'));
});

test("the owner's webhook set-up: only this lane's URL, Gen's events, the secret kept and never shown", async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  endpoints = [{ id: 'we_other', url: 'https://sickofit.example/api/stripe' }, { id: 'we_portal', url: 'https://hawkesgames.com/v1/billing/webhook' }];
  // Not the owner: refused.
  assert.equal((await as(buyer, '/v1/billing/webhook/setup', {})).status, 403);
  const setup = (body: unknown) => fetch(`${base}/v1/billing/webhook/setup`, { method: 'POST', headers: { Origin: 'https://beta.hawkesgen.ai', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const r = await setup({});
  const out = (await r.json()) as any;
  assert.equal(r.status, 200, JSON.stringify(out));
  assert.equal(out.action, 'created');
  assert.equal(out.url, 'https://beta.hawkesgen.ai/v1/billing/webhook');
  assert.equal(out.status.hasWebhookSecret, true);
  assert.ok(!JSON.stringify(out).includes('whsec_made_by_stripe'));
  const made = asked.find((a) => a.method === 'POST' && a.path === '/v1/webhook_endpoints')!;
  assert.ok([...made.form.entries()].some(([k, v]) => k.startsWith('enabled_events') && v === 'checkout.session.async_payment_succeeded'));
  // The other products' endpoints were never touched.
  assert.ok(!asked.some((a) => /we_other|we_portal/.test(a.path)));
  assert.deepEqual(endpoints.map((e) => e.id).slice(0, 2), ['we_other', 'we_portal']);
  // Again: the same endpoint gets the events, nothing new is made.
  const again = (await (await setup({})).json()) as any;
  assert.equal(again.action, 'updated');
  assert.equal(endpoints.length, 3);
  // A webhook signed with the kept secret is accepted.
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_made_by_stripe';
  assert.equal((await hook({ type: 'checkout.session.expired', data: { object: packSession('cs_test_x') } })).status, 200);
});

test('an endpoint for this URL whose secret Gen lacks is replaced only when asked', async () => {
  // Clear the kept secret (the runtime file) and the environment's.
  await fetch(`${base}/v1/billing/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webhookSecret: '' }) });
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const setup = (body: unknown) => fetch(`${base}/v1/billing/webhook/setup`, { method: 'POST', headers: { Origin: 'https://beta.hawkesgen.ai', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const r = await setup({});
  assert.equal(r.status, 409);
  const ours = endpoints.find((e) => e.url === 'https://beta.hawkesgen.ai/v1/billing/webhook')!.id;
  const rep = (await (await setup({ replace: true })).json()) as any;
  assert.equal(rep.action, 'replaced');
  assert.ok(!endpoints.some((e) => e.id === ours));
  assert.equal(endpoints.filter((e) => e.url === 'https://beta.hawkesgen.ai/v1/billing/webhook').length, 1);
  assert.ok(endpoints.some((e) => e.id === 'we_other'));
});
