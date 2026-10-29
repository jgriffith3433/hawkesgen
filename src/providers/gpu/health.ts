// Which GPU providers are usable right now (docs/gpu-providers.md): a provider that refused us (no capacity, no quota,
// a bad key, unreachable, AWS refusing its credentials) is skipped for a cooldown, so the queue sends its jobs to the
// next provider in settings.gpu.order instead of waiting on it. In memory: a restart gives every provider a new chance.

export type Down = { until: number; reason: string; at: number };

const down = new Map<string, Down>();
const lastOk = new Map<string, number>();
const lastError = new Map<string, { reason: string; at: number }>();

/** Cooldowns by kind of trouble: capacity clears up soon, a bad key or an account problem doesn't. */
export const COOLDOWN = { capacity: 5 * 60_000, unreachable: 10 * 60_000, auth: 30 * 60_000 } as const;

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
