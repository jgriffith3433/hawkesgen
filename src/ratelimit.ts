// The request limiter (a token bucket per caller and class of route), run first in api.ts `handle`.
//
//   strict    /v1/users/* writes (sign-in, sign-up, keys) and /oauth/*: keyed by the caller's address, since these are
//             where nobody is signed in yet.
//   moderate  POST /v1/jobs, /v1/estimate and the assistant routes (the AI pane, the scene, director and editor AIs).
//   generous  GET reads (and /v1/events opening, /v1/users/me).
//   standard  every other write.
//   never     /v1/health, the Stripe webhook and the GPU workers' storage broker (its run token is the credential); anything outside /v1 and /oauth (the app's own files, /mcp, /dl).
//
// A caller is its API key or session (hashed, never stored), plus X-Hawkesgen-Project (the portal's one key acts for many
// customers), else its client address. The address is only believed from trusted places: `clientIp` (analytics/collect.ts)
// takes the Cloudflare Worker's X-Hawkes-Client-IP only when the connecting hop is in Cloudflare's ranges, and
// X-Forwarded-For only from Cloud Run's front end or a loopback proxy. No timers: buckets refill when looked at, and
// idle ones are dropped when the table grows.
// Over the limit: 429, Retry-After (whole seconds) and `{ error, retryAfter }`. Tunable in settings.rateLimit
// ({ enabled, <class>: { burst, perMinute } }); HAWKESGEN_RATELIMIT=off turns it off.
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { clientIp } from './analytics/collect.ts';
import { loadSettings } from './config.ts';

export type LimitClass = 'strict' | 'moderate' | 'standard' | 'generous';
export type Rule = { burst: number; perMinute: number };

export const DEFAULT_RULES: Record<LimitClass, Rule> = {
  strict: { burst: 20, perMinute: 15 },
  moderate: { burst: 60, perMinute: 120 },
  standard: { burst: 120, perMinute: 600 },
  generous: { burst: 300, perMinute: 3000 },
};

/** Which class a request is in, or null when it is never limited. */
export function classify(method: string, route: string): LimitClass | null {
  if (route === '/v1/health' || route === '/v1/billing/webhook' || route === '/v1/gpu/broker' || /^\/v1\/[\w/-]*webhooks?(\/|$)/.test(route)) return null;
  if (route.startsWith('/oauth/')) return 'strict';
  if (!route.startsWith('/v1/')) return null;
  const read = method === 'GET' || method === 'HEAD';
  if (route === '/v1/events') return 'generous';
  if (route.startsWith('/v1/users/')) return read ? 'generous' : 'strict';
  if (read) return 'generous';
  if (route === '/v1/jobs' || route === '/v1/estimate' || route.startsWith('/v1/assistant/') || /\/assistant$/.test(route)) return 'moderate';
  return 'standard';
}

type Bucket = { tokens: number; at: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;

export const resetLimits = () => buckets.clear();

function rulesNow(): { on: boolean; rules: Record<LimitClass, Rule> } {
  const s: any = loadSettings();
  const cfg = s.rateLimit ?? {};
  const rules = { ...DEFAULT_RULES };
  for (const k of Object.keys(rules) as LimitClass[]) {
    const r = cfg[k];
    if (r && Number(r.burst) > 0 && Number(r.perMinute) > 0) rules[k] = { burst: Number(r.burst), perMinute: Number(r.perMinute) };
  }
  return { on: cfg.enabled !== false && process.env.HAWKESGEN_RATELIMIT !== 'off', rules };
}

const cookieValue = (req: IncomingMessage, name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(req.headers.cookie ?? ''))?.[1] ?? '';

/** Who is asking, as a short opaque id: the credential's hash (+ the project it narrows to), else the address. */
export function callerKey(req: IncomingMessage, cls: LimitClass): string {
  const ip = clientIp(req) ?? 'unknown';
  if (cls === 'strict') return `ip:${ip}`; // before anyone is signed in: the address, whatever credential is waved
  const h = req.headers;
  const auth = String(h.authorization ?? '');
  const cred = (auth.startsWith('Bearer ') ? auth.slice(7) : '') || String(h['x-hawkesgen-key'] ?? '') || cookieValue(req, 'hg_session') || cookieValue(req, 'hg_key');
  if (!cred.trim()) return `ip:${ip}`;
  const project = String(h['x-hawkesgen-project'] ?? '');
  return `k:${crypto.createHash('sha256').update(cred.trim()).digest('base64url').slice(0, 16)}:${project}`;
}

/** Take one token. `retryAfter` (seconds, at least 1) is set when there is none. */
export function take(key: string, rule: Rule, now = Date.now()): { ok: boolean; retryAfter: number } {
  const rate = rule.perMinute / 60000; // tokens per ms
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) for (const [k, v] of buckets) if (now - v.at > 120_000) buckets.delete(k);
    b = { tokens: rule.burst, at: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(rule.burst, b.tokens + (now - b.at) * rate);
  b.at = now;
  if (b.tokens >= 1) { b.tokens -= 1; return { ok: true, retryAfter: 0 }; }
  return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
}

/** The check `handle` runs first. Null: carry on. Otherwise the seconds to wait. */
export function limit(req: IncomingMessage, method: string, route: string): number | null {
  const cls = classify(method, route);
  if (!cls) return null;
  const { on, rules } = rulesNow();
  if (!on) return null;
  const r = take(`${cls}|${callerKey(req, cls)}`, rules[cls]);
  return r.ok ? null : r.retryAfter;
}
