// Gen subscriptions (src/subscriptions.ts): a plan's checkout goes to Stripe in subscription mode; Stripe's webhooks
// record the subscription, grant the month's credits once per paid invoice, follow cancel and status changes, and mark
// a failed payment. Stripe is a local stand-in (STRIPE_API_BASE) and the webhooks are signed as Stripe signs them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-subs-'));
process.env.STRIPE_SECRET_KEY = 'sk_test_local';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local';

// The Stripe stand-in: records what Gen asked for.
const asked: { path: string; form: URLSearchParams }[] = [];
const stripe = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  asked.push({ path: req.url ?? '', form: new URLSearchParams(body) });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url?.startsWith('/v1/checkout/sessions')) return res.end(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' }));
  if (req.url?.startsWith('/v1/billing_portal/sessions')) return res.end(JSON.stringify({ url: 'https://billing.stripe.test/p' }));
  return res.end(JSON.stringify({ id: 'sub_1', cancel_at_period_end: true }));
});
await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', () => r()));
process.env.STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as any).port}`;

const { handle } = await import('../src/api.ts');
const { signupUser } = await import('../src/users.ts');
const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => { server.close(); stripe.close(); });

const me = signupUser({ email: 'sub@example.com', password: 'secret-123', name: 'Sub' });
const cookie = `hg_session=${me.sessionToken}`;
const call = (route: string, body?: unknown) => fetch(base + route, {
  method: body === undefined ? 'GET' : 'POST', headers: { cookie, Origin: 'https://gen.hawkesgen.ai', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const hook = (event: unknown) => {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', 'whsec_local').update(`${t}.${payload}`).digest('hex');
  return fetch(`${base}/v1/billing/webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${v1}` }, body: payload });
};
const credits = async () => ((await (await call('/v1/users/me')).json()) as any).user.credits as number;
const subNow = async () => ((await (await call('/v1/subscriptions/me')).json()) as any).subscription;

test('the plans are public and seeded; checkout is a monthly subscription for the signed-in account', async () => {
  const plans = (await (await fetch(`${base}/v1/subscriptions/plans`)).json()) as any;
  assert.deepEqual(plans.plans.map((p: any) => p.id), ['gen_creator', 'gen_pro']);
  const r = await call('/v1/subscriptions/checkout', { planId: 'gen_creator' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(((await r.json()) as any).url, 'https://checkout.stripe.test/cs_test_1');
  const f = asked.at(-1)!.form;
  assert.equal(f.get('mode'), 'subscription');
  assert.equal(f.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(f.get('metadata[user_id]'), me.user.id);
  assert.equal(f.get('subscription_data[metadata][plan_id]'), 'gen_creator');
  assert.equal((await call('/v1/subscriptions/checkout', { planId: 'nope' })).status, 404);
});

test('the webhooks: subscribed, credits once per paid invoice, cancel, payment failed, ended', async () => {
  const start = await credits();
  assert.equal((await hook({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', client_reference_id: me.user.id, metadata: { user_id: me.user.id, plan_id: 'gen_creator' }, payment_status: 'paid' } } })).status, 200);
  assert.equal((await subNow()).planId, 'gen_creator');
  const invoice = { type: 'invoice.paid', data: { object: { id: 'in_1', subscription: 'sub_1', customer: 'cus_1', lines: { data: [{ period: { start: 1_800_000_000, end: 1_802_600_000 } }] } } } };
  assert.equal((await hook(invoice)).status, 200);
  assert.equal(await credits(), start + 1500);
  assert.equal((await hook(invoice)).status, 200, 'Stripe retries');
  assert.equal(await credits(), start + 1500, 'not granted twice');
  assert.equal((await subNow()).currentPeriodEnd, 1_802_600_000 * 1000);
  // A second month.
  await hook({ ...invoice, data: { object: { ...invoice.data.object, id: 'in_2' } } });
  assert.equal(await credits(), start + 3000);
  // Cancel at the month's end, from the account sheet: Stripe told, and the flag kept.
  assert.equal((await call('/v1/subscriptions/cancel', {})).status, 200);
  assert.equal(asked.at(-1)!.form.get('cancel_at_period_end'), 'true');
  assert.equal((await subNow()).cancelAtPeriodEnd, 1);
  await hook({ type: 'invoice.payment_failed', data: { object: { subscription: 'sub_1' } } });
  assert.equal((await subNow()).status, 'past_due');
  assert.equal((await call('/v1/subscriptions/checkout', { planId: 'gen_pro' })).status, 409, 'not a second plan while one is past due');
  await hook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled' } } });
  assert.equal(await subNow(), null, 'no active plan once it ended');
  assert.equal(await credits(), start + 3000, 'credits granted before stay');
  // The billing portal for someone who has paid.
  const p = await call('/v1/billing/portal', {});
  assert.equal(((await p.json()) as any).url, 'https://billing.stripe.test/p');
});

test('a forged webhook is refused', async () => {
  const r = await fetch(`${base}/v1/billing/webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${Math.floor(Date.now() / 1000)},v1=deadbeef` }, body: JSON.stringify({ type: 'invoice.paid' }) });
  assert.notEqual(r.status, 200);
});

test('one Stripe account for three products: the others\' events are answered 200 and ignored', async () => {
  const before = await credits();
  // The portal's subscription checkout and invoice (tagged), and an untagged one for an account Gen doesn't have.
  for (const ev of [
    { type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_portal', metadata: { product: 'portal', user_id: 'usr_1234abcd', plan_id: 'maker' }, payment_status: 'paid' } } },
    { type: 'invoice.paid', data: { object: { id: 'in_p', subscription: 'sub_portal', subscription_details: { metadata: { product: 'portal', user_id: 'usr_1234abcd' } } } } },
    { type: 'checkout.session.completed', data: { object: { mode: 'payment', payment_status: 'paid', id: 'cs_x', metadata: { user_id: 'usr_9999', credits: '1000' } } } },
    { type: 'customer.subscription.updated', data: { object: { id: 'sub_studio', status: 'active', metadata: { product: 'studio' } } } },
  ]) {
    const r = await hook(ev);
    assert.equal(r.status, 200, `${ev.type}: ${await r.clone().text()}`);
    assert.match(String(((await r.json()) as any).ignored), /not a Hawkes Gen event/);
  }
  assert.equal(await credits(), before);
  // Gen's own checkout is tagged.
  await call('/v1/subscriptions/checkout', { planId: 'gen_creator' });
  assert.equal(asked.at(-1)!.form.get('metadata[product]'), 'gen');
  assert.equal(asked.at(-1)!.form.get('subscription_data[metadata][product]'), 'gen');
});
