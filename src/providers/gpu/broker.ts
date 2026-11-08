// The storage broker (docs/gpu-providers.md, "Files"): a worker on a provider without a Google identity (RunPod,
// Modal, any host) reaches the run's files through Gen, never with credentials of its own. Each request names one
// gs:// object and carries the run's token, which Gen signed for that run alone and which expires:
//
//   GET  /v1/gpu/broker?op=stat&uri=   the object's metadata (size), or 404
//   GET  /v1/gpu/broker?op=url&uri=    {url}: a V4 signed URL to download from Cloud Storage directly (models are GBs),
//                                      or {proxy: true} when Gen can't sign (then op=read)
//   GET  /v1/gpu/broker?op=read&uri=   the bytes, through Gen
//   PUT  /v1/gpu/broker?op=write&uri=  writes the body there
//
// A token may read and write gs://<bucket>/cloudrun/runs/<its key>/ (outputs, heartbeat, manifest, cancel), and only
// read gs://<bucket>/cloudrun/inputs/ and gs://<bucket>/models/. Everything else is refused.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, env } from '../../config.ts';

export const BROKER_ROUTE = '/v1/gpu/broker';
const TTL_MS = 6 * 3600_000;

let secret: Buffer | null = null;
function key(): Buffer {
  if (secret) return secret;
  const file = path.join(DATA_DIR, 'gpu-broker.key');
  try { secret = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); } catch { /* not made yet */ }
  if (!secret || secret.length < 32) {
    secret = crypto.randomBytes(32);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
  }
  return secret;
}
/** Tests: forget the cached secret (a new data folder). */
export const resetBrokerKey = () => { secret = null; };

const mac = (s: string) => crypto.createHmac('sha256', key()).update(s).digest('base64url');

/** A run's token: its key, the bucket, an expiry, signed. */
export function brokerToken(runKey: string, bucket: string, now = Date.now()) {
  const body = `${runKey}.${bucket}.${now + TTL_MS}`;
  return `${body}.${mac(body)}`;
}

/** The run a token is for, or null (forged, expired, malformed). */
export function readToken(token: string, now = Date.now()): { key: string; bucket: string } | null {
  const parts = String(token ?? '').split('.');
  if (parts.length < 4) return null;
  const sig = parts.pop()!;
  const exp = Number(parts.pop());
  const k = parts.shift()!;
  const bucket = parts.join('.');
  const want = Buffer.from(mac(`${k}.${bucket}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (!Number.isFinite(exp) || exp < now || !/^[0-9a-f]{64}$/.test(k)) return null;
  return { key: k, bucket };
}

/** Whether a token for this run may do `op` on `uri`. */
export function allowed(run: { key: string; bucket: string }, op: string, uri: string): boolean {
  const pre = `gs://${run.bucket}/`;
  if (!uri.startsWith(pre) || uri.includes('..') || /[\r\n]/.test(uri)) return false;
  const name = uri.slice(pre.length);
  if (name.startsWith(`cloudrun/runs/${run.key}/`)) return ['stat', 'read', 'url', 'write', 'put'].includes(op);
  if (name.startsWith('cloudrun/inputs/') || name.startsWith('models/')) return ['stat', 'read', 'url'].includes(op);
  return false;
}

/** Where workers reach the broker (Gen's public address). */
export const brokerUrl = () => `${(env('HAWKESGEN_PUBLIC_URL') ?? '').replace(/\/+$/, '')}${BROKER_ROUTE}`;
