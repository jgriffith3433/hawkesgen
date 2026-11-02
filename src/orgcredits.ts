// Customers' Studios pay for their Gen work from one balance, kept by Hawkes Studio's control plane (J's Studio,
// hawkesstudio docs/studio-customers.md "Billing"). A cell's Gen key (role user, projects `org_<hex>` and
// `org_<hex>.*`, made by hawkesstudio cells.ts ensureGenKey) has no Gen account behind it, so Gen's own credits
// (users.ts, billing.ts reserveJobCredits) never covered it. Here Gen charges that org's balance in the control plane
// for every job such a key creates, whatever the path (POST /v1/jobs, /v1/run, reruns, entity make, the director, the
// MCP at /mcp, which calls /v1/jobs with the caller's key):
//   1. the job is priced the way Gen prices its accounts (billing.ts quoteJobCredits: the same quote the cell shows)
//   2. POST <control>/api/cells/gen/charge {genOrg, credits, job, tool} with the control plane's key, before the job
//      exists: 402 refuses the job (kind 'credits', the control plane's own "This studio is out of credits: ..."),
//      anything else that isn't a yes (unreachable, 5xx, an org it doesn't know) refuses it too: fail closed
//   3. a job that fails or is cancelled is refunded (POST <control>/api/cells/gen/refund {genOrg, job}), once; refunds
//      that can't reach the control plane are retried every 2 minutes until they do (the org_charges table)
// Jobs a reuse or the same key hands back cost nothing (they never reach createJob). Owner and admin keys, Gen calling
// itself (chains' steps), Gen app accounts, the portal's keys, platform tokens and settings.platform.freeOrgs are
// never charged here. Off until both the URL (settings.orgCredits.url or HAWKESGEN_ORG_CREDITS_URL) and the key
// (HAWKESGEN_ORG_CREDITS_KEY, a secret: never logged or returned) are set; /v1/health says `orgCredits: true` when on,
// and a cell then stops charging on its own side (hawkesstudio credits.ts).

import { db } from './db.ts';
import { env, loadSettings } from './config.ts';
import { GenError } from './util.ts';

db.exec(`CREATE TABLE IF NOT EXISTS org_charges (job TEXT PRIMARY KEY, org TEXT NOT NULL, credits INTEGER NOT NULL, tool TEXT, created INTEGER NOT NULL, refunded INTEGER, refund_error TEXT)`);

const ORG_ID = /^org_[0-9a-f]{8,32}$/;

export type OrgCharge = { org: string; credits: number };

/**
 * Studio's public names (Cloudflare Workers, server/studio-edge in hawkesstudio) and the Cloud Run services behind them.
 * Gen calls the control plane for every charged job and refund: server to server, so straight to Cloud Run and never
 * through a Cloudflare Worker (2026-11-02: Workers usage must grow with people, not with Gen's own calls). Studio's gate
 * lets /api/cells/gen/charge and /refund through on its own address too (hawkesstudio src/cloudauth.ts). Settings keep
 * the public name (what people read); HAWKESGEN_ORG_CREDITS_DIRECT=0 calls it as written.
 */
const STUDIO_DIRECT: Record<string, string> = {
  'https://studio.hawkesgen.ai': 'https://studio-388576319982.us-east4.run.app',
  'https://studio-beta.hawkesgen.ai': 'https://studio-beta-388576319982.us-central1.run.app',
};
export const directControlUrl = (url: string) => (env('HAWKESGEN_ORG_CREDITS_DIRECT') === '0' ? url : STUDIO_DIRECT[url.toLowerCase()] ?? url);

/** The control plane's address and key, or null when Gen doesn't charge orgs (older setup: the cell charges itself). */
export function orgCreditsConfig(): { url: string; key: string } | null {
  const url = directControlUrl((loadSettings().orgCredits?.url || env('HAWKESGEN_ORG_CREDITS_URL') || '').trim().replace(/\/+$/, ''));
  const key = (env('HAWKESGEN_ORG_CREDITS_KEY') || '').trim();
  return url && key ? { url, key } : null;
}
export const orgCreditsOn = () => orgCreditsConfig() !== null;

type ClientLike = { id: string; role: string; projects: string[]; org?: string };

/**
 * The Gen org whose Studio balance pays for this client's job in `project`, or null: only a customer's cell key (role
 * user, every project of the key `org_<hex>` or `org_<hex>.*` of one org, the job in that org), with no Gen account
 * (`hasAccount`), not a platform token (src/platform.ts bills those) and not one of settings.platform.freeOrgs.
 */
export function billedOrg(client: ClientLike, project: string, hasAccount: boolean): string | null {
  if (client.role !== 'user' || client.org || hasAccount) return null;
  const org = String(project ?? '').split('.')[0];
  if (!ORG_ID.test(org)) return null;
  if (!client.projects.length || !client.projects.every((p) => p === org || p === `${org}.*`)) return null;
  if (loadSettings().platform.freeOrgs.includes(org)) return null;
  return org;
}

async function control(what: 'charge' | 'refund', body: Record<string, unknown>) {
  const cfg = orgCreditsConfig();
  if (!cfg) throw new GenError('Studio credits are not set up on this Gen', { status: 503 });
  const r = await fetch(`${cfg.url}/api/cells/gen/${what}`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

/**
 * Takes the job's price from its org's balance before the job exists. Throws GenError 402 kind 'credits' when the
 * studio is short (the control plane's message), and refuses (fail closed) on anything else that isn't a yes.
 */
export async function chargeOrg(org: string, job: string, credits: number, tool: string): Promise<OrgCharge> {
  const amount = Math.max(0, Math.round(Number(credits) || 0));
  if (!amount) return { org, credits: 0 };
  let r: { status: number; body: any };
  try {
    r = await control('charge', { genOrg: org, credits: amount, job, tool });
  } catch (e: any) {
    console.warn(`[orgcredits] charging ${org} for ${job}: ${e?.message ?? e}`);
    throw new GenError("Hawkes Gen couldn't reach the studio's billing to charge this job, so it wasn't started. Try again in a minute.", { status: 503, kind: 'credits' });
  }
  if (r.status === 402) {
    const need = r.body?.credits?.need ?? amount, have = r.body?.credits?.have;
    throw new GenError(String(r.body?.error || `This studio is out of credits: ${tool} needs ${need}${have === undefined ? '' : ` and ${have} are left`}. Add credits or upgrade your plan in Settings → Plan and credits.`), { status: 402, kind: 'credits' });
  }
  if (r.status !== 200 || r.body?.ok !== true) {
    console.warn(`[orgcredits] charging ${org} for ${job}: the control plane answered ${r.status}`);
    throw new GenError(`The studio's billing refused this job (${r.status}${r.body?.error ? `: ${String(r.body.error).slice(0, 160)}` : ''}), so it wasn't started.`, { status: r.status === 404 ? 403 : 503, kind: 'credits' });
  }
  db.prepare('INSERT OR REPLACE INTO org_charges (job, org, credits, tool, created) VALUES (?, ?, ?, ?, ?)').run(job, org, amount, tool, Date.now());
  return { org, credits: amount };
}

/** Gives a job's charge back (it failed, was cancelled, or never got made). Once; retried later when unreachable. */
export async function refundOrgCharge(job: string, reason = 'Job failed or cancelled'): Promise<number> {
  const row = db.prepare('SELECT * FROM org_charges WHERE job = ? AND refunded IS NULL').get(job) as { job: string; org: string; credits: number } | undefined;
  if (!row) return 0;
  try {
    const r = await control('refund', { genOrg: row.org, job: row.job, credits: row.credits, reason: String(reason).slice(0, 200) });
    // 404: the control plane has no such charge (nothing to give back).
    if (r.status !== 200 && r.status !== 404) throw new Error(`the control plane answered ${r.status}`);
    db.prepare('UPDATE org_charges SET refunded = ?, refund_error = NULL WHERE job = ?').run(Date.now(), row.job);
    return Number(r.body?.refunded ?? 0);
  } catch (e: any) {
    db.prepare('UPDATE org_charges SET refund_error = ? WHERE job = ?').run(String(e?.message ?? e).slice(0, 200), row.job);
    console.warn(`[orgcredits] refund of ${row.job}: ${e?.message ?? e} (retried later)`);
    return 0;
  }
}

/** Refunds charged jobs that ended failed or cancelled and weren't refunded yet (any path that missed it, retries). */
export async function settleOrgCharges(statusOf: (job: string) => string | null): Promise<string[]> {
  if (!orgCreditsOn()) return [];
  const out: string[] = [];
  const rows = db.prepare('SELECT job FROM org_charges WHERE refunded IS NULL ORDER BY created LIMIT 200').all() as { job: string }[];
  for (const { job } of rows) {
    const st = statusOf(job);
    if (st === 'failed' || st === 'cancelled' || st === null) {
      await refundOrgCharge(job, st === null ? 'Job was never made' : `Job ${st}`);
      if ((db.prepare('SELECT refunded FROM org_charges WHERE job = ?').get(job) as any)?.refunded) out.push(job);
    } else if (st === 'done') db.prepare('UPDATE org_charges SET refunded = 0 WHERE job = ?').run(job); // settled: kept
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
export function startOrgChargeSettler(statusOf: (job: string) => string | null, every = 2 * 60_000) {
  if (timer) return;
  timer = setInterval(() => void settleOrgCharges(statusOf).catch((e) => console.warn(`[orgcredits] settling: ${e.message}`)), every);
  timer.unref();
}
