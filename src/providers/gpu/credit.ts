// RunPod's account balance (docs/gpu-providers.md, "Credit"). RunPod starts no worker for an account at or below $0, but
// its gateway doesn't say so: requests just wait (2026-11-01: four playtests sat at "opening a browser on RunPod" with
// the balance at -$0.006). So Gen reads the balance itself (GraphQL myself.clientBalance, with RUNPOD_API_KEY) every few
// minutes, skips RunPod for GPU jobs and playtests while it is empty (the job goes to the next provider with that
// reason), and shows a low balance on the dashboard's GPU providers card before it runs out. In memory, like health.ts.
import { env } from '../../config.ts';
import type { Secrets } from './auth.ts';

export type Credit = { balance: number; at: number };

/** Below this RunPod warns by email; the dashboard shows it too. */
export const LOW_CREDIT = 5;
const EVERY_MS = 2 * 60_000;
const GRAPHQL = 'https://api.runpod.io/graphql';

let last: Credit | null = null;
let lastError: { reason: string; at: number } | null = null;
let checking: Promise<Credit | null> | null = null;

/** Reads the balance now (one at a time). Null without a key or when RunPod doesn't answer (then nothing is skipped). */
export function checkRunpodCredit(get: Secrets = env, fetcher: typeof fetch = fetch, now = Date.now): Promise<Credit | null> {
  const key = get('RUNPOD_API_KEY');
  if (!key) return Promise.resolve(null);
  checking ??= (async () => {
    try {
      const r = await fetcher(GRAPHQL, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ myself { clientBalance } }' }), signal: AbortSignal.timeout(15_000),
      });
      const j: any = await r.json().catch(() => null);
      const balance = Number(j?.data?.myself?.clientBalance);
      if (!r.ok || !Number.isFinite(balance)) throw new Error(`${r.status} ${JSON.stringify(j?.errors?.[0]?.message ?? j).slice(0, 200)}`);
      const was = last;
      last = { balance, at: now() };
      lastError = null;
      if (balance <= 0 && (!was || was.balance > 0)) console.warn(`[gpu] RunPod is out of credit ($${balance.toFixed(2)}): RunPod is skipped until funds are added`);
      else if (balance < LOW_CREDIT && (!was || was.balance >= LOW_CREDIT)) console.warn(`[gpu] RunPod credit is low ($${balance.toFixed(2)})`);
      return last;
    } catch (e: any) {
      lastError = { reason: String(e?.message ?? e), at: now() };
      return null;
    } finally {
      checking = null;
    }
  })();
  return checking;
}

/** Why RunPod can't run anything now (its balance is empty), or null. Reads the last check (the watch keeps it fresh). */
export function runpodCreditProblem(get: Secrets = env): string | null {
  if (!get('RUNPOD_API_KEY') || !last || last.balance > 0) return null;
  return `RunPod is out of credit (balance $${last.balance.toFixed(2)}): add funds at runpod.io (Billing)`;
}

/** For GET /v1/gpu/providers and the dashboard. */
export function runpodCredit() {
  return last ? { balance: last.balance, at: last.at, low: last.balance < LOW_CREDIT, empty: last.balance <= 0, error: lastError } : { balance: null, at: null, low: false, empty: false, error: lastError };
}

/** Checks every few minutes while Gen runs (server.ts). */
export function startCreditWatch(get: Secrets = env) {
  if (!get('RUNPOD_API_KEY')) return;
  void checkRunpodCredit(get);
  setInterval(() => void checkRunpodCredit(get), EVERY_MS).unref();
}

/** Tests start clean, or with a balance. */
export function setRunpodCredit(c: Credit | null) {
  last = c;
  lastError = null;
}
