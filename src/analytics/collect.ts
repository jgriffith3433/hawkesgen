// POST /v1/analytics/collect: the public door every product's pages send events to (docs/analytics.md). No key:
// the product registry says which origins may send for which product. Batches are validated and trimmed, enriched
// (place from the IP, browser/OS/device from the user agent) and stored. The IP is used for the place and the rate
// limit and, as a salted one-way hash, to group a player's sessions by network (store.ts netOf), then dropped:
// never stored, never logged. The page never gets a 5xx.

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { products, envFor, type Product } from './registry.ts';
import { parseUA } from './ua.ts';
import { lookup, type Geo } from './geo.ts';
import { ingest, knownNames, addName, netOf, type Batch, type Ev } from './store.ts';
import { datacenterOf } from './datacenter.ts';
import { authenticate } from '../auth.ts';

export const LIMITS = {
  body: 64 * 1024,
  events: 200,
  propKeys: 30,
  ctxKeys: 12,
  key: /^[A-Za-z_][A-Za-z0-9_]{0,39}$/,
  name: /^[a-z][a-z0-9_]{1,39}$/,
  string: 300,
  longStrings: { text: 2000, message: 1000, stack: 4000 } as Record<string, number>,
  depth: 3,
  array: 50,
  propsBytes: 4096,
  bigPropsBytes: 16384, // exit (the last events and the game's state), error (the stack)
  perMinute: { batches: 60, events: 1200 },
};

export const STANDARD = new Set([
  'page_view', 'session_start', 'session_end', 'game_load_start', 'game_ready', 'screen', 'run_start', 'run_end',
  'level_start', 'level_end', 'death', 'progress', 'checkpoint', 'choice', 'feature', 'video', 'feedback', 'error',
  'perf', 'outbound', 'exit', 'frustration', 'engage',
]);

const str = (v: unknown, max: number, re?: RegExp): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  if (!s || (re && !re.test(s))) return null;
  return s;
};

/** A value trimmed to the limits: strings cut, objects and arrays capped in size and depth. */
function clean(v: any, key: string, depth: number): any {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, LIMITS.longStrings[key] ?? LIMITS.string);
  if (depth >= LIMITS.depth) return undefined;
  if (Array.isArray(v)) return v.slice(0, LIMITS.array).map((x) => clean(x, key, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (n >= LIMITS.propKeys) break;
      if (!LIMITS.key.test(k)) continue;
      const c = clean(x, k, depth + 1);
      if (c === undefined) continue;
      out[k] = c;
      n++;
    }
    return out;
  }
  return undefined;
}

export function cleanProps(name: string, v: unknown): Record<string, any> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = clean(v, '', 0) as Record<string, any>;
  const cap = name === 'exit' || name === 'error' ? LIMITS.bigPropsBytes : LIMITS.propsBytes;
  if (JSON.stringify(out).length <= cap) return Object.keys(out).length ? out : null;
  // Too big: keep the plain values, drop the nested ones.
  const flat: Record<string, any> = { _trimmed: true };
  for (const [k, x] of Object.entries(out)) if (x === null || typeof x !== 'object') flat[k] = typeof x === 'string' ? x.slice(0, 200) : x;
  return flat;
}

function cleanCtx(v: unknown): Record<string, any> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, any> = {};
  for (const [k, x] of Object.entries(v)) {
    if (Object.keys(out).length >= LIMITS.ctxKeys) break;
    if (!LIMITS.key.test(k)) continue;
    if (typeof x === 'string') out[k] = x.slice(0, 100);
    else if ((typeof x === 'number' && Number.isFinite(x)) || typeof x === 'boolean') out[k] = x;
  }
  return Object.keys(out).length ? out : null;
}

/** The path of a page (no query or hash: they can carry anything). */
function pathOf(v: unknown): string | null {
  const s = str(v, 2000);
  if (!s) return null;
  let p = s;
  try {
    if (/^https?:\/\//i.test(s)) p = new URL(s).pathname;
  } catch {}
  return p.split(/[?#]/)[0].slice(0, 200) || '/';
}

function referrerOf(v: unknown, origin: string): string | null {
  const s = str(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.origin.toLowerCase() === origin.toLowerCase()) return null; // a page of the same site
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 200);
  } catch {
    return null;
  }
}

export type Meta = { origin: string; ua: string; ip: string | null; now: number };
export type Result = { batch: Batch | null; accepted: number; dropped: number; reason?: string };

/** Checks and trims one posted batch. Nothing here keeps the IP: it only goes to the place lookup. */
export function normalize(body: any, meta: Meta, geo: (ip: string | null) => Geo | null = lookup): Result {
  const total = Array.isArray(body?.events) ? body.events.length : 0;
  const drop = (reason: string): Result => ({ batch: null, accepted: 0, dropped: total, reason });
  if (!body || typeof body !== 'object') return drop('not an object');
  const product: Product | undefined = products().get(String(body.product ?? ''));
  if (!product) return drop('unknown product');
  const firstPage = pathOf(body.events?.[0]?.page) ?? pathOf(body.page) ?? '';
  const env = envFor(product, meta.origin, firstPage);
  if (!env) return drop('origin not registered for this product');
  const anon = str(body.anon, 64, /^[\w-]{8,64}$/);
  const session = str(body.session, 64, /^[\w-]{8,64}$/);
  if (!anon || !session) return drop('anon and session ids are required (8-64 of A-Z a-z 0-9 _ -)');
  // The site's own account id (hawkesAnalytics.identify): pseudonymous, no email or name.
  const user = str(body.user, 64, /^[\w-]{4,64}$/);
  if (!total) return drop('no events');

  const known = knownNames(product.id);
  const events: Ev[] = [];
  let dropped = 0;
  for (const raw of body.events.slice(0, LIMITS.events)) {
    const name = str(raw?.name, 40, LIMITS.name);
    const seq = Number(raw?.seq);
    if (!name || !Number.isInteger(seq) || seq < 0 || seq > 1e9) {
      dropped++;
      continue;
    }
    if (!STANDARD.has(name) && !known.has(name)) {
      if (known.size >= product.customEvents) {
        dropped++;
        continue;
      }
      addName(product.id, name);
    }
    const props = cleanProps(name, raw.props);
    const ctx = cleanCtx(raw.ctx);
    const t = Number(raw.t);
    const active = Number(raw.active);
    events.push({
      name, seq,
      t: Number.isFinite(t) && t > 0 ? Math.round(t) : meta.now,
      page: pathOf(raw.page),
      screen: str(raw.screen, 100),
      level: str(props?.level, 100) ?? str(ctx?.level, 100),
      active: Number.isFinite(active) && active >= 0 ? Math.min(Math.round(active), 24 * 3600 * 1000) : null,
      ctx, props,
    });
  }
  dropped += Math.max(0, total - LIMITS.events);
  if (!events.length) return { batch: null, accepted: 0, dropped, reason: 'no valid events' };

  const agent = parseUA(meta.ua);
  const flags = body.flags && typeof body.flags === 'object' ? body.flags : {};
  const d = body.device && typeof body.device === 'object' ? body.device : {};
  const entry = body.entry && typeof body.entry === 'object' ? body.entry : {};
  const utm = entry.utm && typeof entry.utm === 'object' ? entry.utm : {};
  const build = body.build && typeof body.build === 'object' ? body.build : {};
  const batch: Batch = {
    product: product.id, env, anon, session, user,
    build: { version: str(build.version, 40), commit: str(build.commit, 40, /^[0-9a-f]{4,40}$/i), date: str(build.date, 40) },
    device: {
      screen: str(d.screen, 20, /^\d{2,5}x\d{2,5}$/),
      lang: str(d.lang, 35, /^[A-Za-z0-9-]+$/),
      gpu: str(d.gpu, 120),
      tz: str(d.tz, 64, /^[A-Za-z0-9_+\-/]+$/),
      touch: Math.max(0, Math.min(20, Number(d.touch) || 0)),
    },
    entry: {
      referrer: referrerOf(entry.referrer, meta.origin),
      landing: pathOf(entry.landing),
      utm: Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].map((k) => [k, str(utm[k], 100)])),
    },
    agent,
    geo: geo(meta.ip),
    net: netOf(meta.ip),
    dc: ((h) => (h ? `${h.kind}:${h.name}` : null))(datacenterOf(meta.ip)),
    bot: agent.bot || flags.webdriver === true || flags.playtest === true,
    botReason: agent.bot ? 'user agent' : flags.webdriver === true ? 'webdriver' : flags.playtest === true ? 'playtest' : null,
    internal: flags.internal === true,
    at: meta.now,
    events,
  };
  return { batch, accepted: events.length, dropped };
}

// ---------------------------------------------------------------- rate limit (per IP, in memory, hashed)
const SALT = crypto.randomBytes(16);
const windows = new Map<string, { start: number; batches: number; events: number }>();
export function rateLimited(ip: string | null, events: number, now = Date.now()): boolean {
  const k = crypto.createHash('sha256').update(SALT).update(ip ?? 'none').digest('base64url').slice(0, 16);
  let w = windows.get(k);
  if (!w || now - w.start > 60_000) {
    w = { start: now, batches: 0, events: 0 };
    windows.set(k, w);
    if (windows.size > 50_000) for (const [key, x] of windows) if (now - x.start > 60_000) windows.delete(key);
  }
  w.batches++;
  w.events += events;
  return w.batches > LIMITS.perMinute.batches || w.events > LIMITS.perMinute.events;
}
export const resetRateLimits = () => windows.clear();

/** The visitor's IP: Caddy's X-Forwarded-For (its last entry is the address Caddy saw) when the request came through it. */
export function clientIp(req: IncomingMessage): string | null {
  const sock = req.socket.remoteAddress ?? '';
  const loop = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return (loop && xff.length ? xff[xff.length - 1] : sock) || null;
}

/** An origin any registered product accepts (for CORS). */
export function originAllowed(origin: string): boolean {
  if (!origin) return false;
  for (const p of products().values()) if (envFor(p, origin)) return true;
  return false;
}

function reply(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * A site's own server passing on its visitors' batches (POST /v1/analytics/relay; the hawkesgen.com portal does, for
 * games that run in a sandbox with no origin of their own): with a Gen key, it says the page's origin, the visitor's
 * address and browser. Its own route because Caddy drops any key sent to the public collect door.
 */
function relayed(req: IncomingMessage): { origin: string; ip: string | null; ua: string } | null {
  const origin = String(req.headers['x-hawkes-relay-origin'] ?? '');
  // A real key, never "this machine": requests through Caddy come from loopback.
  if (!origin || !/^Bearer hg_/.test(String(req.headers.authorization ?? '')) || !authenticate(req)) return null;
  const ip = String(req.headers['x-hawkes-visitor-ip'] ?? '').trim();
  return { origin, ip: /^[0-9a-f.:]{3,45}$/i.test(ip) ? ip : null, ua: String(req.headers['x-hawkes-visitor-ua'] ?? '').slice(0, 500) };
}

export async function handleCollect(req: IncomingMessage, res: ServerResponse, o: { relay?: boolean } = {}) {
  try {
    const relay = o.relay ? relayed(req) : null;
    if (o.relay && !relay) return reply(res, 401, { ok: false, error: 'A relay needs a Gen key and X-Hawkes-Relay-Origin' });
    const origin = relay?.origin ?? String(req.headers.origin ?? '');
    if (originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return void (res.writeHead(204), res.end());
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST a batch' });

    // JSON, sent as application/json or text/plain (navigator.sendBeacon without a preflight).
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > LIMITS.body) {
        req.resume();
        return reply(res, 413, { ok: false, error: `The batch is over ${LIMITS.body} bytes` });
      }
      chunks.push(c as Buffer);
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(res, 400, { ok: false, error: 'The body is not JSON' });
    }
    let ip = relay ? relay.ip : clientIp(req);
    const n = Array.isArray(body?.events) ? body.events.length : 0;
    if (rateLimited(ip, n)) {
      ip = null;
      return reply(res, 429, { ok: false, accepted: 0, dropped: n, error: 'Too many events from this address; try again in a minute' });
    }
    const r = normalize(body, { origin, ua: relay ? relay.ua : String(req.headers['user-agent'] ?? ''), ip, now: Date.now() });
    ip = null;
    if (!r.batch) return reply(res, 202, { ok: false, accepted: 0, dropped: r.dropped, reason: r.reason });
    const added = ingest(r.batch);
    return reply(res, 202, { ok: true, accepted: added, dropped: r.dropped + (r.accepted - added) });
  } catch (e: any) {
    // Never a 5xx to the page: the error is ours to read (no IP in it), the page carries on.
    console.warn(`[analytics] collect: ${e?.message ?? e}`);
    return reply(res, 202, { ok: false, accepted: 0, reason: 'not stored' });
  }
}
