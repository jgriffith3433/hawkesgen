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

/**
 * Deletes a Gen account for good (J, 2026-10-30: "on the admin portal I can delete accounts"). `confirm` must be the
 * account's email. In order: a paid plan is ended in Stripe now (if that fails nothing is deleted, so nobody is billed for
 * an account that's gone); its running and waiting jobs are cancelled; what it made (scenes, shots, library entries and
 * their versions, files' records, voices, jobs) and its sign-in links, editor connections, own AI keys and flags are
 * removed; then the account itself (its sessions, credit ledger, plans and games go with it). Files are stored once by
 * content and may be shared, so the bytes stay where they are; nothing points at them from this account any more. Usage
 * rows stay (the costs, under the project id alone). Admins can't be deleted here.
 */
export async function deleteAccount(userId: string, confirm: string, by: string) {
  const u = getUserById(userId);
  if (!u) throw new GenError(`No account ${userId}`, { status: 404 });
  if (isGenAdmin(u)) throw new GenError('An admin account can\'t be deleted here', { status: 400 });
  if (String(confirm ?? '').trim().toLowerCase() !== u.email.toLowerCase()) throw new GenError(`Type the account's email (${u.email}) to delete it`, { status: 400 });
  const sub = getUserSubscription(u.id);
  if (sub?.stripeSubscriptionId && sub.status !== 'canceled') {
    const { cancelSubscriptionNow } = await import('./subscriptions.ts');
    try { await cancelSubscriptionNow(sub.stripeSubscriptionId); }
    catch (e: any) { throw new GenError(`Their plan couldn't be ended in Stripe (${e.message}), so nothing was deleted. End it in Stripe, then delete again.`, { status: 502 }); }
  }
  const p = u.project;
  const { cancel } = await import('./jobs.ts');
  for (const j of db.prepare(`SELECT id FROM jobs WHERE project = ? AND status IN ('queued', 'running')`).all(p) as { id: string }[]) { try { cancel(j.id); } catch { /* already ending */ } }
  const { genAccountOrg } = await import('./orgsecrets.ts');
  const removed: Record<string, number> = {};
  const run = (name: string, sql: string, ...args: unknown[]) => {
    try { removed[name] = Number(db.prepare(sql).run(...(args as any[])).changes); } catch { /* a table this Gen doesn't have */ }
  };
  db.exec('BEGIN');
  try {
    run('versions', 'DELETE FROM versions WHERE entity IN (SELECT id FROM entities WHERE project = ?)', p);
    run('entities', 'DELETE FROM entities WHERE project = ?', p);
    run('levels', 'DELETE FROM asset_lods WHERE asset IN (SELECT id FROM assets WHERE project = ?)', p);
    run('levelState', 'DELETE FROM asset_lod_state WHERE asset IN (SELECT id FROM assets WHERE project = ?)', p);
    run('levelLinks', 'DELETE FROM asset_lod_links WHERE asset IN (SELECT id FROM assets WHERE project = ?)', p);
    run('files', 'DELETE FROM assets WHERE project = ?', p);
    run('uploads', 'DELETE FROM blob_owners WHERE project = ?', p);
    run('voices', 'DELETE FROM audio_voices WHERE project = ?', p);
    run('scenes', 'DELETE FROM scenes WHERE project = ?', p);
    run('sequences', 'DELETE FROM stage_sequences WHERE project = ?', p);
    run('jobs', 'DELETE FROM jobs WHERE project = ?', p);
    run('aiKeys', 'DELETE FROM org_secrets WHERE org = ?', genAccountOrg(p));
    run('editorTokens', 'DELETE FROM oauth_tokens WHERE connection_id IN (SELECT id FROM oauth_connections WHERE user_id = ?)', u.id);
    run('editors', 'DELETE FROM oauth_connections WHERE user_id = ?', u.id);
    run('codes', 'DELETE FROM oauth_codes WHERE user_id = ?', u.id);
    run('google', 'DELETE FROM user_google WHERE user_id = ?', u.id);
    run('flags', 'DELETE FROM user_flags WHERE user_id = ?', u.id);
    // The account itself never fails quietly: if it can't go, nothing above does either.
    removed.account = Number(db.prepare('DELETE FROM users WHERE id = ?').run(u.id).changes);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[accounts] ${by} deleted ${u.id} (${u.email}): ${JSON.stringify(removed)}`);
  return { deleted: u.id, email: u.email, removed, planEnded: Boolean(sub?.stripeSubscriptionId && sub.status !== 'canceled') };
}
