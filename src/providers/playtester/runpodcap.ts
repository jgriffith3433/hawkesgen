// The RunPod playtest endpoint's own worker limit (docs/playtest-runpod.md, "Lane"). Gen's playtest lane is
// maxInstances x tabsPerInstance browser tabs, and maxInstances used to be a hand-kept copy of the endpoint's
// workers.max in settings.playtest.runpod: raising the endpoint did nothing until someone also edited Gen's settings
// (2026-11-01: 13 playtests queued behind "4 of 4 playtest browser tabs in use"). So Gen reads workers.max from RunPod
// itself (API v2, GET /v2/serverless/<id>, with RUNPOD_API_KEY) every few minutes, and the lane follows it both ways.
// Unknown (no key, a Pod or a local container, RunPod not answering): settings.playtest.runpod.maxInstances as before.
// In memory, like gpu/credit.ts.
import { env } from '../../config.ts';
import type { Secrets } from '../gpu/auth.ts';

export type EndpointMax = { id: string; max: number; at: number };

const EVERY_MS = 2 * 60_000;
/** A reading older than this is not trusted (RunPod stopped answering): settings win again. */
const STALE_MS = 15 * 60_000;
/** The most workers Gen will plan for, whatever the endpoint says (settings.playtest.runpod.maxInstances' own ceiling). */
export const MAX_WORKERS = 20;
const API = 'https://api.runpod.io/v2';

let last: EndpointMax | null = null;
let checking: Promise<EndpointMax | null> | null = null;

/** The endpoint id of a RunPod serverless gateway URL (https://<id>.api.runpod.ai), else null. */
export const endpointIdOf = (url: string | null | undefined) => (url ? /^https:\/\/([a-z0-9]+)\.api\.runpod\.ai\/?$/.exec(url)?.[1] ?? null : null);

/** Reads the endpoint's workers.max now (one at a time). Null without a key, for a non-gateway URL, or on any error. */
export function checkRunpodEndpointMax(url: string | null | undefined, get: Secrets = env, fetcher: typeof fetch = fetch, now = Date.now): Promise<EndpointMax | null> {
  const id = endpointIdOf(url);
  const key = get('RUNPOD_API_KEY');
  if (!id || !key) return Promise.resolve(null);
  checking ??= (async () => {
    try {
      const r = await fetcher(`${API}/serverless/${id}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      const j: any = await r.json().catch(() => null);
      const max = Math.round(Number(j?.workers?.max ?? j?.workersMax));
      if (!r.ok || !Number.isFinite(max) || max < 1) throw new Error(`${r.status}`);
      const was = last;
      last = { id, max: Math.min(MAX_WORKERS, max), at: now() };
      if (!was || was.id !== id || was.max !== last.max) console.log(`[playtest] RunPod endpoint ${id} allows ${last.max} workers: the playtest lane follows it`);
      return last;
    } catch {
      return null;
    } finally {
      checking = null;
    }
  })();
  return checking;
}

/** The endpoint's workers.max from the last fresh reading for this URL, or null (then settings decide). */
export function runpodEndpointMax(url: string | null | undefined, now = Date.now): number | null {
  const id = endpointIdOf(url);
  if (!id || !last || last.id !== id || now() - last.at > STALE_MS) return null;
  return last.max;
}

/** Reads it every few minutes while Gen runs (server.ts), for whatever URL settings name at the time. */
export function startEndpointWatch(urlNow: () => string | null | undefined, get: Secrets = env) {
  if (!get('RUNPOD_API_KEY')) return;
  const tick = () => void checkRunpodEndpointMax(urlNow(), get);
  tick();
  setInterval(tick, EVERY_MS).unref();
}

/** Tests start clean, or with a reading. */
export function setRunpodEndpointMax(m: EndpointMax | null) {
  last = m;
}
