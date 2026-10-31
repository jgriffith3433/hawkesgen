// Gen subscriptions (J, 2026-10-29: Gen is a product of its own; sign in, subscribe or add credits, use it). A plan is a
// monthly price that grants credits each paid month (1 credit = $0.01), on top of the one-off credit packs (billing.ts).
// Stripe does the money: a Checkout session in subscription mode, then its webhooks: checkout.session.completed
// records the subscription, invoice.paid grants that month's credits once per invoice, customer.subscription.updated /
// deleted keep its status and period, invoice.payment_failed marks it past due (credits already granted stay). Cancel
// and resume act at the period's end; the Stripe billing portal manages cards and receipts.
//
// The default plans are seeded when the table is empty; prices are provisional until J sets them (owner:
// POST /v1/subscriptions/plans).

import { db } from './db.ts';
import { env } from './config.ts';
import { GenError } from './util.ts';
import type { UserRow } from './users.ts';
import {
  listSubscriptionPlans, getSubscriptionPlan, createSubscriptionPlan, createUserSubscription, updateUserSubscription,
  getUserSubscription, grantCredits, stripeKeys, type UserSubscription,
} from './billing.ts';

/** Provisional plans (J sets the real ones). */
export const DEFAULT_PLANS = [
  { id: 'gen_creator', name: 'Creator', priceCents: 1200, creditsPerMonth: 1500 },
  { id: 'gen_pro', name: 'Pro', priceCents: 3900, creditsPerMonth: 5500 },
] as const;

export function seedPlans() {
  if (listSubscriptionPlans().length) return;
  for (const p of DEFAULT_PLANS) createSubscriptionPlan({ ...p, maxGames: 0, maxMembersPerGame: 0, stripePriceId: null, active: 1 });
}

async function stripe(path: string, form?: URLSearchParams, method = form ? 'POST' : 'GET') {
  const { secretKey } = stripeKeys();
  if (!secretKey) throw new GenError('Payments are not set up on this Gen yet.', { status: 503 });
  const base = (env('STRIPE_API_BASE') ?? 'https://api.stripe.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${secretKey}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form?.toString(), signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new GenError(data?.error?.message ?? `Stripe error (HTTP ${res.status})`, { status: 502 });
  return data;
}

/** A Stripe Checkout session for a plan: the person goes to `url`, pays, and comes back to the app. */
export async function subscriptionCheckout(user: UserRow, planId: string, origin: string) {
  const plan = getSubscriptionPlan(planId);
  if (!plan) throw new GenError(`Unknown plan "${planId}"`, { status: 404 });
  const current = getUserSubscription(user.id);
  if (current && current.status !== 'canceled') throw new GenError('You already have a plan: manage it from your account.', { status: 409 });
  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('client_reference_id', user.id);
  if (user.stripe_customer_id) form.set('customer', user.stripe_customer_id);
  else form.set('customer_email', user.email);
  form.set('success_url', `${origin}/?checkout=success#create`);
  form.set('cancel_url', `${origin}/?checkout=cancelled#create`);
  // The product tag: the portal and Studio share this Stripe account and ignore what isn't theirs (billing.ts isGenEvent).
  form.set('metadata[product]', 'gen');
  form.set('metadata[user_id]', user.id);
  form.set('metadata[plan_id]', plan.id);
  form.set('subscription_data[metadata][product]', 'gen');
  form.set('subscription_data[metadata][user_id]', user.id);
  form.set('subscription_data[metadata][plan_id]', plan.id);
  form.set('line_items[0][quantity]', '1');
  if (plan.stripePriceId) form.set('line_items[0][price]', plan.stripePriceId);
  else {
    form.set('line_items[0][price_data][currency]', 'usd');
    form.set('line_items[0][price_data][unit_amount]', String(plan.priceCents));
    form.set('line_items[0][price_data][recurring][interval]', 'month');
    form.set('line_items[0][price_data][product_data][name]', `Hawkes Gen ${plan.name}`);
  }
  const s = await stripe('checkout/sessions', form);
  return { url: s.url as string, sessionId: s.id as string, plan };
}

const subByStripe = (stripeId: string) => db.prepare('SELECT id, user_id, plan_id FROM user_subscriptions WHERE stripe_subscription_id = ?').get(stripeId) as { id: string; user_id: string; plan_id: string } | undefined;
const secs = (v: unknown) => (Number(v) > 0 ? Number(v) * 1000 : null);
const STATUS: Record<string, UserSubscription['status']> = { active: 'active', trialing: 'trialing', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled' };

/** A Stripe event about a subscription; null when the event isn't one. Called from billing.ts handleStripeWebhook. */
export function subscriptionEvent(event: any): Record<string, unknown> | null {
  const o = event?.data?.object ?? {};
  switch (event?.type) {
    case 'checkout.session.completed': {
      if (o.mode !== 'subscription') return null;
      const userId = String(o.metadata?.user_id ?? o.client_reference_id ?? '');
      const planId = String(o.metadata?.plan_id ?? '');
      const stripeId = String(o.subscription ?? '');
      if (!userId || !planId || !stripeId) throw new GenError('A subscription checkout without user, plan or subscription', { status: 400 });
      if (typeof o.customer === 'string') db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL').run(o.customer, userId);
      if (!subByStripe(stripeId)) {
        const now = Date.now();
        createUserSubscription({ id: '', userId, planId, stripeSubscriptionId: stripeId, status: 'active', currentPeriodStart: now, currentPeriodEnd: now + 31 * 86_400_000, cancelAtPeriodEnd: 0 } as any);
      }
      return { ok: true, type: event.type, subscription: stripeId };
    }
    case 'invoice.paid': {
      const stripeId = String(o.subscription ?? o.parent?.subscription_details?.subscription ?? '');
      if (!stripeId) return null; // not a subscription's invoice
      const sub = subByStripe(stripeId);
      const meta = o.subscription_details?.metadata ?? o.parent?.subscription_details?.metadata ?? {};
      const userId = sub?.user_id ?? String(meta.user_id ?? '');
      const plan = getSubscriptionPlan(sub?.plan_id ?? String(meta.plan_id ?? ''));
      if (!userId || !plan) throw new GenError(`An invoice for an unknown subscription (${stripeId})`, { status: 400 });
      // Once per invoice (Stripe retries webhooks): the ledger refuses a second grant for the same key.
      const r = grantCredits(userId, plan.creditsPerMonth, { kind: 'subscription_credits', detail: `${plan.name} plan: this month's credits`, stripeSessionId: `invoice:${o.id}`, stripeCustomerId: typeof o.customer === 'string' ? o.customer : null });
      const line = o.lines?.data?.[0]?.period;
      if (sub && line) updateUserSubscription(sub.id, { status: 'active', currentPeriodStart: secs(line.start) ?? undefined, currentPeriodEnd: secs(line.end) ?? undefined });
      return { ok: true, type: event.type, duplicate: r.duplicate, creditsAdded: r.duplicate ? 0 : plan.creditsPerMonth };
    }
    case 'invoice.payment_failed': {
      const sub = subByStripe(String(o.subscription ?? o.parent?.subscription_details?.subscription ?? ''));
      if (!sub) return null;
      updateUserSubscription(sub.id, { status: 'past_due' });
      return { ok: true, type: event.type };
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = subByStripe(String(o.id ?? ''));
      if (!sub) return { ok: true, type: event.type, ignored: true };
      const item = o.items?.data?.[0] ?? {};
      updateUserSubscription(sub.id, {
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : STATUS[o.status] ?? 'active',
        cancelAtPeriodEnd: o.cancel_at_period_end ? 1 : 0,
        ...(secs(o.current_period_end ?? item.current_period_end) ? { currentPeriodEnd: secs(o.current_period_end ?? item.current_period_end)! } : {}),
        ...(secs(o.current_period_start ?? item.current_period_start) ? { currentPeriodStart: secs(o.current_period_start ?? item.current_period_start)! } : {}),
      });
      return { ok: true, type: event.type };
    }
    default:
      return null;
  }
}

/** Cancels at the end of the paid month (`resume` undoes it before then). */
export async function setCancelAtPeriodEnd(user: UserRow, cancel: boolean) {
  const sub = getUserSubscription(user.id);
  if (!sub?.stripeSubscriptionId) throw new GenError('You have no plan.', { status: 404 });
  await stripe(`subscriptions/${encodeURIComponent(sub.stripeSubscriptionId)}`, new URLSearchParams({ cancel_at_period_end: cancel ? 'true' : 'false' }));
  updateUserSubscription(sub.id, { cancelAtPeriodEnd: cancel ? 1 : 0 });
  return getUserSubscription(user.id);
}

/** Stripe's billing portal: cards, receipts, cancel. */
export async function billingPortal(user: UserRow, origin: string) {
  if (!user.stripe_customer_id) throw new GenError('Nothing to manage yet: you have not paid for anything.', { status: 404 });
  const s = await stripe('billing_portal/sessions', new URLSearchParams({ customer: user.stripe_customer_id, return_url: `${origin}/#create` }));
  return { url: s.url as string };
}

/** Ends a plan in Stripe now (an account being deleted: nothing more is charged). */
export async function cancelSubscriptionNow(stripeSubscriptionId: string) {
  await stripe(`subscriptions/${encodeURIComponent(stripeSubscriptionId)}`, undefined, 'DELETE');
}
