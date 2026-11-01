// Signed links for MCP editors, which can't send a Gen credential with a plain download or upload (J, 2026-10-30: the
// portal's tools moved to Gen's MCP). HMAC with the dashboard secret (dashauth.ts signPayload); nothing stored but the
// used upload nonces.
//   /dl/<token>/<name>   GET one file of the library, for a day: the token names the asset
//   /up/<token>/<name>   PUT (or POST) the bytes once, within 30 minutes (curl -T file <url>): the token names the person
//                        and project the upload belongs to; the answer is blob:<sha> to pass as a tool input

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { signPayload } from './dashauth.ts';
import { putBlob, ownBlob } from './library.ts';

const DL_TTL = 24 * 3600 * 1000;
const UP_TTL = 30 * 60 * 1000;
const UP_MAX = 2 * 1024 * 1024 * 1024;
db.exec('CREATE TABLE IF NOT EXISTS upload_links_used (nonce TEXT PRIMARY KEY, used INTEGER NOT NULL)');

const pack = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(o: object) {
  const p = pack(o);
  return `${p}.${signPayload(p)}`;
}
function open<T>(token: string): T | null {
  const [p, mac] = token.split('.');
  if (!p || !mac) return null;
  const want = signPayload(p);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return o && Number(o.exp) > Date.now() ? (o as T) : null;
  } catch {
    return null;
  }
}
const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'file';

/** A link that downloads one asset for a day, with no credential. */
export function downloadLink(base: string, assetId: string, name = assetId, now = Date.now()) {
  return `${base.replace(/\/+$/, '')}/dl/${sign({ k: 'dl', a: assetId, exp: now + DL_TTL })}/${safeName(name)}`;
}

/** The app's share link: anyone with it sees the file in their browser (not a download) for a week. */
export const SHARE_TTL = 7 * 24 * 3600 * 1000;
export function shareLink(base: string, assetId: string, name = assetId, now = Date.now()) {
  return `${base.replace(/\/+$/, '')}/dl/${sign({ k: 'dl', a: assetId, v: 1, exp: now + SHARE_TTL })}/${safeName(name)}`;
}

/** A one-time upload link (curl -T file <url>) whose blob belongs to this caller. */
export function uploadLink(base: string, owner: { id: string; projects: string[] }, filename: string, now = Date.now()) {
  return `${base.replace(/\/+$/, '')}/up/${sign({ k: 'up', c: owner.id, p: owner.projects, n: crypto.randomBytes(9).toString('base64url'), exp: now + UP_TTL })}/${safeName(filename)}`;
}

/** The asset a download link names, or null. The route then serves it like /v1/files (api.ts). */
export function downloadTarget(route: string): string | null {
  return linkTarget(route)?.asset ?? null;
}
/** The asset a link names and whether it's a share (shown in the browser rather than downloaded). */
export function linkTarget(route: string): { asset: string; view: boolean } | null {
  const m = /^\/dl\/([\w-]+\.[\w-]+)\/[^/]*$/.exec(route);
  const o = m && open<{ k: string; a: string; v?: number }>(m[1]);
  return o && o.k === 'dl' && /^a_[0-9a-f]+$/.test(o.a) ? { asset: o.a, view: o.v === 1 } : null;
}

/** Handles PUT/POST /up/<token>/<name>; false when the route isn't an upload link. */
export async function handleUpload(req: IncomingMessage, res: ServerResponse, route: string): Promise<boolean> {
  const m = /^\/up\/([\w-]+\.[\w-]+)\/([^/]*)$/.exec(route);
  if (!m) return false;
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
  if (req.method !== 'PUT' && req.method !== 'POST') return reply(405, { error: 'PUT the file here (curl -T file <this url>)' });
  const o = open<{ k: string; c: string; p: string[]; n: string }>(m[1]);
  if (!o || o.k !== 'up') return reply(403, { error: 'This upload link is invalid or expired: ask for a new one' });
  try { db.prepare('INSERT INTO upload_links_used (nonce, used) VALUES (?, ?)').run(o.n, Date.now()); } catch { return reply(409, { error: 'This upload link was used already: ask for a new one' }); }
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > UP_MAX) return reply(413, { error: 'Files up to 2 GB' });
    chunks.push(c);
  }
  if (!n) return reply(400, { error: 'Send the file as the request body (curl -T file <this url>)' });
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(m[2])?.[0] ?? '').toLowerCase();
  const sha = putBlob(Buffer.concat(chunks), ext);
  ownBlob(sha, { id: o.c, projects: o.p });
  return reply(200, { blob: `blob:${sha}`, ref: `blob:${sha}`, bytes: n, use: `Pass "blob:${sha}" as the tool's input` });
}
