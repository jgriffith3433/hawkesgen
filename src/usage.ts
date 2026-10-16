// What every job used and cost, per client and project: GPU seconds, voice
// characters, Claude tokens. The base for cost reports now, and for billing
// clients later.

import { db } from './db.ts';

export function recordUsage(u: { client: string; project: string; job?: string | null; provider: string; unit: string; amount: number; cost?: number; detail?: string }) {
  db.prepare('INSERT INTO usage (at, client, project, job, provider, unit, amount, cost, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    Date.now(), u.client, u.project, u.job ?? null, u.provider, u.unit, u.amount, Math.round((u.cost ?? 0) * 1e6) / 1e6, u.detail ?? null,
  );
}

/** Totals since a time, grouped by project, client, provider or day. */
export function usageSummary({ since = 0, by = 'project' }: { since?: number; by?: 'project' | 'client' | 'provider' | 'day' } = {}) {
  const group = by === 'day' ? "strftime('%Y-%m-%d', at / 1000, 'unixepoch')" : by;
  const rows = db.prepare(`SELECT ${group} AS grp, provider, unit, SUM(amount) AS amount, SUM(cost) AS cost, COUNT(DISTINCT job) AS jobs
                           FROM usage WHERE at >= ? GROUP BY grp, provider, unit ORDER BY grp`).all(since) as any[];
  const total = (db.prepare('SELECT SUM(cost) AS cost FROM usage WHERE at >= ?').get(since) as { cost: number | null }).cost ?? 0;
  return { since, by, rows, total: Math.round(total * 10000) / 10000 };
}
