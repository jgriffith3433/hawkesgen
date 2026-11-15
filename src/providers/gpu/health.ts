// Which GPU providers are usable right now (docs/gpu-providers.md): a provider that refused us (no capacity, no quota,
// a bad key, unreachable, AWS refusing its credentials) is skipped for a cooldown, so the queue sends its jobs to the
// next provider in settings.gpu.order instead of waiting on it. In memory: a restart gives every provider a new chance.

export type Down = { until: number; reason: string; at: number };

const down = new Map<string, Down>();
const lastOk = new Map<string, number>();
const lastError = new Map<string, { reason: string; at: number }>();

/** Cooldowns by kind of trouble: capacity clears up soon, a bad key or an account problem doesn't. */
export const COOLDOWN = { capacity: 5 * 60_000, unreachable: 10 * 60_000, auth: 30 * 60_000 } as const;

/** An endpoint that ran a job this recently still has a worker up (Modal's scaledown_window is 20 minutes). */
export const WARM_MS = 20 * 60_000;
/** Busy-endpoint wait when lastOk is fresh: hand the job on after this. */
export const BUSY_WAIT_MS = 3 * 60_000;
/**
 * Cap on waiting for any worker to accept a POST (headers / assign). Below RunPod's ~5.5 minute LB hold so each try
 * fails over (or the next POST goes in on a true cold) instead of sitting through one silent hold.
 */
export const PRE_WORKER_MS = 4 * 60_000;
/** Default cold-start wait when lastOk is stale and the endpoint has no coldStartSeconds. */
export const DEFAULT_COLD_WAIT_MS = 12 * 60_000;

export function markDown(id: string, reason: string, ms: number = COOLDOWN.unreachable, now = Date.now()) {
  down.set(id, { until: now + ms, reason, at: now });
  lastError.set(id, { reason, at: now });
}

export function markUp(id: string, now = Date.now()) {
  down.delete(id);
  lastOk.set(id, now);
}

/** The cooldown a provider is in, or null. */
export function isDown(id: string, now = Date.now()): Down | null {
  const d = down.get(id);
  if (!d) return null;
  if (d.until <= now) { down.delete(id); return null; }
  return d;
}

/** Whether a cooldown is for trouble that won't clear on its own (a key refused, the account suspended): the queue
 *  then fails a job that has nowhere else to go instead of letting it wait (src/providers/gpu/nogpu.ts). */
export const lastingDown = (d: Down) => d.until - d.at >= COOLDOWN.auth;

/** Every provider's state, for GET /v1/gpu/providers and the dashboard. */
export function healthOf(id: string, now = Date.now()) {
  const d = isDown(id, now);
  return { down: !!d, reason: d?.reason ?? null, until: d?.until ?? null, lastOk: lastOk.get(id) ?? null, lastError: lastError.get(id) ?? null };
}

/** Tests start clean. */
export function resetHealth() {
  down.clear();
  lastOk.clear();
  lastError.clear();
}

/** Whether an AWS error means the account or its key can't be used (then the fleet is skipped, not waited on). */
export const awsRefused = (message: string) =>
  /InvalidClientTokenId|UnrecognizedClient|AuthFailure|SignatureDoesNotMatch|AccountSuspended|OptInRequired|Blocked|security token included in the request is invalid|credentials/i.test(message);
