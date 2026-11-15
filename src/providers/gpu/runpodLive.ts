// What RunPod is really doing, for GET /v1/fleet (the dashboard's fleet card and the hawkesgen_fleet tool), which
// otherwise shows only the AWS fleet. Read from RunPod itself on request (cached a minute), never polled:
// - the balance and what the account spends per hour right now (GraphQL myself.clientBalance / currentSpendPerHr),
// - each serverless endpoint's workers (API v2 /health). Gen's endpoints are LOAD_BALANCER endpoints: requests go
//   straight to a worker, so RunPod's job counters stay 0 even while a worker serves Gen. "0 jobs" is normal — never
//   treat it as stuck/zombie or recycle for that (2026-11-10 correction); currentSpendPerHr is what bills.
// - what each endpoint and pod cost over the last 24 hours, by hour (REST /v1/billing), so a drained balance has a cause.
// Reads only. No key or a RunPod error comes back as `error` instead of throwing.
import { env } from '../../config.ts';
import type { Secrets } from './auth.ts';

const GRAPHQL = 'https://api.runpod.io/graphql';
const V2 = 'https://api.runpod.ai/v2';
const V2_LIST = 'https://api.runpod.io/v2/serverless?limit=100';
const REST = 'https://rest.runpod.io/v1';
const CACHE_MS = 60_000;

export type EndpointLive = { id: string; name: string; type: string | null; workersMax: number | null; workers: Record<string, number> | null };
export type SpendRow = { id: string; name: string | null; usd: number; seconds: number; lastHour: string | null };
export type RunpodLive = {
  at: number; balance: number | null; spendPerHour: number | null;
  endpoints: EndpointLive[]; last24h: { endpoints: SpendRow[]; pods: SpendRow[]; totalUsd: number } | null;
  error: string | null; note: string;
};

let cached: RunpodLive | null = null;
let reading: Promise<RunpodLive | null> | null = null;

const rowsOf = (j: any): any[] => (Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.records) ? j.records : []);

/** Sums RunPod billing records (amount in USD, timeBilledMs) by endpoint or pod, biggest first. */
export function spendBy(records: any[], idKey: 'endpointId' | 'podId', names: Record<string, string> = {}): SpendRow[] {
  const by = new Map<string, SpendRow>();
  for (const r of records) {
    const usd = Number(r?.amount ?? 0);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    const id = String(r?.[idKey] ?? r?.id ?? '?');
    const row = by.get(id) ?? { id, name: names[id] ?? null, usd: 0, seconds: 0, lastHour: null };
    row.usd += usd;
    row.seconds += Math.round(Number(r?.timeBilledMs ?? 0) / 1000);
    const t = r?.time ? String(r.time) : null;
    if (t && (!row.lastHour || t > row.lastHour)) row.lastHour = t;
    by.set(id, row);
  }
  return [...by.values()].map((r) => ({ ...r, usd: Math.round(r.usd * 100) / 100 })).sort((a, b) => b.usd - a.usd);
}

export async function readRunpodLive(get: Secrets = env, fetcher: typeof fetch = fetch, now = Date.now): Promise<RunpodLive | null> {
  const key = get('RUNPOD_API_KEY');
  if (!key) return null;
  if (cached && now() - cached.at < CACHE_MS) return cached;
  reading ??= (async () => {
    const auth = { Authorization: `Bearer ${key}` };
    const call = async (url: string, init: RequestInit = {}) => {
      const r = await fetcher(url, { ...init, headers: { ...auth, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
      const j: any = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`${new URL(url).pathname}: ${r.status} ${JSON.stringify(j?.error ?? j?.errors?.[0]?.message ?? j ?? '').slice(0, 160)}`);
      return j;
    };
    const errors: string[] = [];
    const out: RunpodLive = {
      at: now(), balance: null, spendPerHour: null, endpoints: [], last24h: null, error: null,
      note: "LOAD_BALANCER endpoints keep RunPod's job counters at 0 while serving; that is not stuck — do not recycle for it. spendPerHour is what bills.",
    };
    await Promise.all([
      call(GRAPHQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ myself { clientBalance currentSpendPerHr } }' }) })
        .then((j) => { out.balance = Number(j?.data?.myself?.clientBalance ?? NaN); out.spendPerHour = Number(j?.data?.myself?.currentSpendPerHr ?? NaN); })
        .catch((e) => errors.push(String(e?.message ?? e))),
      call(V2_LIST)
        .then(async (j) => {
          const eps = rowsOf(j?.endpoints ?? j);
          out.endpoints = await Promise.all(eps.map(async (e: any) => ({
            id: String(e.id), name: String(e.name ?? e.id), type: e.type ?? null, workersMax: e.workers?.max ?? e.workersMax ?? null,
            workers: await call(`${V2}/${e.id}/health`).then((h) => h?.workers ?? null, () => null),
          })));
        })
        .catch((e) => errors.push(String(e?.message ?? e))),
    ]);
    if (Number.isNaN(out.balance)) out.balance = null;
    if (Number.isNaN(out.spendPerHour)) out.spendPerHour = null;
    const names = Object.fromEntries(out.endpoints.map((e) => [e.id, e.name]));
    const end = new Date(now()).toISOString();
    const start = new Date(now() - 24 * 3600_000).toISOString();
    const bill = (kind: string, grouping: string) =>
      call(`${REST}/billing/${kind}?bucketSize=hour&grouping=${grouping}&startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`).then(rowsOf);
    const [eps, pods] = await Promise.all([
      bill('endpoints', 'endpointId').catch((e) => (errors.push(String(e?.message ?? e)), null)),
      bill('pods', 'podId').catch((e) => (errors.push(String(e?.message ?? e)), null)),
    ]);
    if (eps || pods) {
      const endpoints = spendBy(eps ?? [], 'endpointId', names);
      const podRows = spendBy(pods ?? [], 'podId');
      out.last24h = { endpoints, pods: podRows, totalUsd: Math.round([...endpoints, ...podRows].reduce((s, r) => s + r.usd, 0) * 100) / 100 };
    }
    out.error = errors.length ? errors.join('; ').replaceAll(key, '***') : null;
    cached = out;
    return out;
  })().finally(() => { reading = null; });
  return reading;
}

/** Tests start clean. */
export function resetRunpodLive() { cached = null; reading = null; }
