// Starter-credit limits (J, 2026-11-07: stop starter-credit farming). Every new account is counted; the starter credits go
// to at most `settings.signups.perIpPerDay` new accounts from one address a (UTC) day, and at most
// `settings.signups.starterCreditsPerDay` credits in all. Over a cap the account still signs in, without the grant, and is
// told how to get credits. Existing accounts and the ledger are never touched; there is no email check.
import { db } from './db.ts';
import { loadSettings } from './config.ts';

db.exec(`CREATE TABLE IF NOT EXISTS signup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, ip TEXT, credits INTEGER NOT NULL, refused TEXT, created INTEGER NOT NULL)`);
db.exec('CREATE INDEX IF NOT EXISTS signup_log_day ON signup_log (day, ip)');

export const STARTER_REFUSED_MESSAGE =
  "Welcome! You're in, but today's free starter credits have run out for new accounts. Add credits from your account menu, or come back tomorrow.";

const today = () => new Date().toISOString().slice(0, 10);

/** Whether a new account from `ip` gets `credits` starter credits now. No address (a direct call): only the daily total applies. */
export function decideStarter(ip: string | null, credits: number): { grant: true } | { grant: false; reason: 'ip' | 'daily' } {
  if (credits <= 0) return { grant: true };
  const { perIpPerDay, starterCreditsPerDay } = loadSettings().signups;
  const day = today();
  if (ip) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM signup_log WHERE day = ? AND ip = ? AND credits > 0').get(day, ip) as { n: number }).n;
    if (n >= perIpPerDay) return { grant: false, reason: 'ip' };
  }
  const given = (db.prepare('SELECT COALESCE(SUM(credits), 0) AS s FROM signup_log WHERE day = ?').get(day) as { s: number }).s;
  if (given + credits > starterCreditsPerDay) return { grant: false, reason: 'daily' };
  return { grant: true };
}

/** Counts a new account: what it was given, or why the grant was refused. */
export function recordSignup(ip: string | null, credits: number, refused: string | null) {
  db.prepare('INSERT INTO signup_log (day, ip, credits, refused, created) VALUES (?, ?, ?, ?, ?)').run(today(), ip, credits, refused, Date.now());
}

/** For /v1/health: new accounts, grants refused, and starter credits given, today and in all. */
export function signupStats() {
  const q = (where: string, ...a: any[]) => db.prepare(`SELECT COUNT(*) AS signups, COALESCE(SUM(refused IS NOT NULL), 0) AS refusedGrants, COALESCE(SUM(credits), 0) AS starterCredits FROM signup_log ${where}`).get(...a) as any;
  const pick = (r: any) => ({ signups: r.signups, refusedGrants: r.refusedGrants, starterCredits: r.starterCredits });
  return { today: pick(q('WHERE day = ?', today())), total: pick(q('')), limits: loadSettings().signups };
}
