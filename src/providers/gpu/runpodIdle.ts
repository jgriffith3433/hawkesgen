// Every RunPod endpoint of the account keeps no warm worker and lets an idle one go within RUNPOD_IDLE_SECONDS (J,
// 2026-11-11: "Make sure runpod isn't wasted on builds and playtests if at all possible"; that morning the GPU and 3D
// endpoints, set up in RunPod's console, kept idle workers 600 s and 900 s and four workers sat idle and billing).
//
// Gen applies it once when it starts (server.ts), so each deploy puts the whole account back on the rule, including an
// endpoint someone made or changed in the console. Nothing polls: one list call per start, and a PATCH only for an
// endpoint that breaks the rule (only its workers' min and idle change; max, image and everything else stay).
// A long run is never cut by the short idle: Gen holds a request open for the whole run and re-attaches at once when
// RunPod ends one (providers/cloudrun/run.ts), so a worker is idle only once its run is over.
// The setup scripts use the same rule (tools/gpu-providers/runpod-v2.mjs IDLE_SECONDS; a test keeps the two equal).
import { env } from '../../config.ts';
import type { Secrets } from './auth.ts';
import { RUNPOD_IDLE_SECONDS } from '../playtester/capacity.ts';

const API = 'https://api.runpod.io/v2';

export type EndpointWorkers = { min?: number; max?: number; idleTimeout?: number };

/** Whether an endpoint keeps warm workers or idle ones longer than RUNPOD_IDLE_SECONDS. */
export const wastesIdle = (ep: { workers?: EndpointWorkers } | null | undefined) =>
  Number(ep?.workers?.min ?? 0) > 0 || Number(ep?.workers?.idleTimeout ?? 0) > RUNPOD_IDLE_SECONDS;

/** The workers an endpoint keeps under the rule: max stays, none warm, idle at most RUNPOD_IDLE_SECONDS. */
export const idleWorkers = (max: number, idle: number = RUNPOD_IDLE_SECONDS) =>
  ({ min: 0, max, idleTimeout: Math.max(5, Math.min(RUNPOD_IDLE_SECONDS, Number(idle) || RUNPOD_IDLE_SECONDS)) });

export type IdleResult = { checked: number; changed: { id: string; name: string; from: EndpointWorkers; to: EndpointWorkers }[]; error: string | null };

/** Puts every endpoint of the account on the rule. Never throws: a RunPod error comes back as `error`. */
export async function applyIdleRule(get: Secrets = env, fetcher: typeof fetch = fetch): Promise<IdleResult | null> {
  const key = get('RUNPOD_API_KEY');
  if (!key) return null;
  const out: IdleResult = { checked: 0, changed: [], error: null };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetcher(`${API}${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`RunPod ${method} ${path}: ${r.status} ${String(j?.title ?? j?.detail ?? j?.message ?? '').slice(0, 200)}`);
    return j;
  };
  try {
    const eps: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const j = await call('GET', `/serverless?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      eps.push(...(Array.isArray(j) ? j : j?.endpoints ?? []));
      cursor = j?.pagination?.nextCursor ?? null;
      if (!cursor) break;
    }
    for (const ep of eps) {
      out.checked++;
      if (!wastesIdle(ep)) continue;
      const to = idleWorkers(Number(ep.workers?.max ?? 0));
      try {
        await call('PATCH', `/serverless/${ep.id}`, { workers: to });
        out.changed.push({ id: String(ep.id), name: String(ep.name ?? ep.id), from: { ...ep.workers }, to });
      } catch (e: any) {
        out.error = [out.error, String(e?.message ?? e)].filter(Boolean).join('; ');
      }
    }
  } catch (e: any) {
    out.error = String(e?.message ?? e);
  }
  if (out.error) out.error = out.error.replaceAll(key, '***');
  return out;
}
