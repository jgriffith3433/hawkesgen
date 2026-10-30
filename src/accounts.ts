// Gen app accounts, for the owner in /admin > Accounts (J, 2026-10-29: "a section to manage accounts, much like the
// portal has where you can gift credits and all that"): search, one account in full (credits, ledger, plan, recent
// jobs, what it spent), gift credits with a note, add or remove credits, and disable or enable an account. A disabled
// account's sessions and keys stop working (users.ts authenticateRequest) until it is enabled again.

import { db } from './db.ts';
import { GenError } from './util.ts';
import { getUserById, toPublicUser, isGenAdmin, isDisabled, type UserRow } from './users.ts';
import { grantCredits, chargeCredits, getUserLedger, getUserSubscription } from './billing.ts';


const spentOf = (userId: string) => (db.prepare(`SELECT COALESCE(-SUM(delta), 0) AS spent FROM credit_ledger WHERE user_id = ? AND kind IN ('job_reserve', 'job_refund', 'ai_turn')`).get(userId) as { spent: number }).spent;
const row = (u: UserRow) => ({ ...toPublicUser(u), disabled: isDisabled(u.id), admin: isGenAdmin(u), spent: spentOf(u.id) });

/** Accounts newest first, or those whose email, name or id has `q`. */
export function listGenAccounts({ q = '', limit = 100, offset = 0 }: { q?: string; limit?: number; offset?: number } = {}) {
  const like = `%${String(q).trim().toLowerCase()}%`;
  const where = q ? 'WHERE lower(email) LIKE ? OR lower(COALESCE(name, \'\')) LIKE ? OR id LIKE ?' : '';
  const args = q ? [like, like, like] : [];
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  const items = (db.prepare(`SELECT * FROM users ${where} ORDER BY created DESC LIMIT ? OFFSET ?`).all(...args, n, Math.max(0, Number(offset) || 0)) as UserRow[]).map(row);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(...args) as { n: number }).n;
  return { items, total };
}

/** The numbers at the top of the tab. */
export function accountsOverview() {
  const day = 24 * 3600 * 1000;
  const one = (sql: string, ...a: number[]) => Number((db.prepare(sql).get(...a) as { n: number | null }).n ?? 0);
  return {
    accounts: one('SELECT COUNT(*) AS n FROM users'),
    new7d: one('SELECT COUNT(*) AS n FROM users WHERE created > ?', Date.now() - 7 * day),
    active7d: one('SELECT COUNT(*) AS n FROM users WHERE last_login > ?', Date.now() - 7 * day),
    creditsHeld: one('SELECT SUM(credits) AS n FROM users'),
    spent30d: one(`SELECT -SUM(delta) AS n FROM credit_ledger WHERE kind IN ('job_reserve', 'job_refund', 'ai_turn') AND created > ?`, Date.now() - 30 * day),
    bought30d: one(`SELECT SUM(delta) AS n FROM credit_ledger WHERE kind IN ('stripe_purchase', 'subscription_credits') AND created > ?`, Date.now() - 30 * day),
  };
}

/** One account in full. */
export function genAccount(userId: string) {
  const u = getUserById(userId);
  if (!u) throw new GenError(`No account ${userId}`, { status: 404 });
  const jobs = db.prepare('SELECT id, tool, status, created, error FROM jobs WHERE project = ? ORDER BY created DESC LIMIT 25').all(u.project) as any[];
  const flags = db.prepare('SELECT note, updated, by FROM user_flags WHERE user_id = ?').get(userId) ?? null;
  return { account: row(u), ledger: getUserLedger(userId, 60).entries, subscription: getUserSubscription(userId), jobs: jobs.map((j) => ({ ...j, error: j.error ? String(j.error).slice(0, 200) : null })), flags };
}

/** A gift: credits with a note the account sees in its ledger. */
export function giftCredits(userId: string, credits: number, note: string) {
  const n = Math.round(Number(credits));
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new GenError('Gift between 1 and 1,000,000 credits', { status: 400 });
  grantCredits(userId, n, { kind: 'admin_gift', detail: note?.trim() ? `Gift: ${note.trim().slice(0, 200)}` : `A gift of ${n} credits from Hawkes Gen` });
  return genAccount(userId);
}

/** Adds (delta > 0) or removes (delta < 0) credits, with the reason in the ledger. */
export function adjustCredits(userId: string, delta: number, note: string) {
  const d = Math.round(Number(delta));
  if (!Number.isFinite(d) || d === 0 || Math.abs(d) > 1_000_000) throw new GenError('Change credits by a whole number (not 0)', { status: 400 });
  // The account sees this line in its own ledger: the reason, not who did it.
  const why = note?.trim() ? note.trim().slice(0, 200) : 'Adjusted by Hawkes Gen';
  if (d > 0) grantCredits(userId, d, { kind: 'admin_grant', detail: why });
  else chargeCredits(userId, -d, 'admin_remove', why);
  return genAccount(userId);
}

export function setDisabled(userId: string, disabled: boolean, note: string, by: string) {
  const u = getUserById(userId);
  if (!u) throw new GenError(`No account ${userId}`, { status: 404 });
  if (disabled && isGenAdmin(u)) throw new GenError('An admin account can\'t be disabled here', { status: 400 });
  db.prepare(`INSERT INTO user_flags (user_id, disabled, note, updated, by) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET disabled = excluded.disabled, note = excluded.note, updated = excluded.updated, by = excluded.by`)
    .run(userId, disabled ? 1 : 0, note?.trim() || null, Date.now(), by);
  if (disabled) db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  return genAccount(userId);
}
