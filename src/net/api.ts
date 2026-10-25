// Hawkes Net's HTTP routes in Gen (docs/net.md, docs/api.md "Hawkes Net"):
//   POST /v1/net/ticket            a join ticket (a Gen key, or no key from the project's own sites: the public door)
//   GET  /v1/net/keys              the public keys nodes check tickets with
//   GET  /v1/net/status            nodes and rooms
//   POST /v1/net/publish           a server's world edits or event into a room, or every room under "<prefix>/*" (a Gen key)
//   POST /v1/net/room              is a room open, how many are in it (a Gen key)
//   POST /v1/net/nodes/heartbeat   a relay node says it's there (a node's Gen key)
//   POST /v1/net/nodes/room        a relay node's room opened, moved or closed
//   POST /v1/net/usage             a relay node's usage for the last minute
//   POST /v1/net/keys/rotate       a new signing key (owner)
//   GET  /sdk/net.mjs, /sdk/net-core.mjs (and @1): the client SDK, for pages that load it from Gen
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticate, canProject, requireRole, type Client } from '../auth.ts';
import { GenError } from '../util.ts';
import { netProject, originAllowed } from './registry.ts';
import * as svc from './service.ts';

const SDK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'clients', 'js');
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function readJson(req: IncomingMessage, limit = 256 * 1024) {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new GenError('Request body too large', { status: 413 }); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new GenError('Body is not valid JSON'); }
}
/** Nodes report with a key that may act for "hawkesnet" (or an admin key). */
function nodeClient(req: IncomingMessage): Client {
  const c = authenticate(req);
  if (!c) throw new GenError('A node key is needed', { status: 401 });
  if (!(c.role === 'owner' || c.role === 'admin' || canProject(c, 'hawkesnet'))) throw new GenError('This key is not a Hawkes Net node key', { status: 403 });
  return c;
}

const sdkCache = new Map<string, { mtime: number; body: Buffer; etag: string }>();
function sdkFile(name: string) {
  const file = path.join(SDK_DIR, name);
  const mtime = fs.statSync(file).mtimeMs;
  let c = sdkCache.get(name);
  if (!c || c.mtime !== mtime) {
    const body = fs.readFileSync(file);
    c = { mtime, body, etag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 20)}"` };
    sdkCache.set(name, c);
  }
  return c;
}

export async function handleNet(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
  const method = req.method ?? 'GET';
  try {
    // The SDK files, for pages that load them from Gen (games may also keep a copy: clients/js/sdk.json).
    // (hawkes-net.mjs imports ./hawkes-net-core.mjs, so both are also served under their own names.)
    const sdk = /^\/sdk\/(net|net-core|hawkes-net|hawkes-net-core)(@1)?\.mjs$/.exec(route);
    if (sdk && (method === 'GET' || method === 'HEAD')) {
      const f = sdkFile(sdk[1] === 'net' || sdk[1] === 'hawkes-net' ? 'hawkes-net.mjs' : 'hawkes-net-core.mjs');
      const headers = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': sdk[2] ? 'public, max-age=3600, stale-while-revalidate=86400' : 'public, max-age=300', ETag: f.etag, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };
      if (req.headers['if-none-match'] === f.etag) return void res.writeHead(304, headers).end();
      res.writeHead(200, { ...headers, 'Content-Length': f.body.length });
      return void res.end(method === 'HEAD' ? undefined : f.body);
    }

    if (route === '/v1/net/ticket') {
      // CORS for the public door: the project's own sites (checked again on the request, by project) and localhost.
      const origin = String(req.headers.origin ?? '');
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hawkesgen-Key, X-Hawkes-Client');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      if (method === 'OPTIONS') return void res.writeHead(204).end();
      if (method !== 'POST') return send(res, 405, { error: 'POST a ticket request' });
      const body = await readJson(req);
      const hasKey = Boolean(req.headers.authorization || req.headers['x-hawkesgen-key']);
      const client = authenticate(req);
      if (hasKey && !client) return send(res, 401, { error: 'Unknown or disabled API key' });
      // A browser page with no key goes through the public door (its origin), even on this machine; a program on this
      // machine with no key and no origin (a bot, a test) is the local owner.
      const viaDoor = !hasKey && Boolean(origin);
      const auth = svc.ticketAuth(req, viaDoor ? null : client);
      if (viaDoor && !originAllowed(netProject(String(body.project ?? '')), origin)) return send(res, 403, { error: 'This site may not ask for tickets for that project' });
      if (!viaDoor && !client) return send(res, 401, { error: 'A Gen API key, or a page on the project\'s own site' });
      return send(res, 200, svc.issueTicket(body, auth));
    }
    if (route === '/v1/net/keys' && method === 'GET') { res.setHeader('Access-Control-Allow-Origin', '*'); return send(res, 200, { keys: svc.publicKeys() }); }
    if (route === '/v1/net/status' && method === 'GET') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      // Public (no login on the server): totals only. Rooms per project (customers' project ids) need a key.
      const st = svc.status();
      if (authenticate(req)) return send(res, 200, st);
      const rooms = st.rooms as { rooms: number; players: number }[];
      return send(res, 200, { ...st, rooms: undefined, totals: { rooms: rooms.reduce((n, r) => n + Number(r.rooms), 0), players: rooms.reduce((n, r) => n + Number(r.players), 0) } });
    }
    if (route === '/v1/net/publish' && method === 'POST') {
      const c = authenticate(req);
      if (!c) return send(res, 401, { error: 'A Gen key is needed' });
      return send(res, 200, await svc.publish(c, await readJson(req, 2 * 1024 * 1024)));
    }
    if (route === '/v1/net/room' && method === 'POST') {
      const c = authenticate(req);
      if (!c) return send(res, 401, { error: 'A Gen key is needed' });
      return send(res, 200, svc.roomInfo(c, await readJson(req)));
    }
    if (route === '/v1/net/nodes/heartbeat' && method === 'POST') return send(res, 200, svc.heartbeat(await readJson(req), nodeClient(req)));
    if (route === '/v1/net/nodes/room' && method === 'POST') { nodeClient(req); return send(res, 200, svc.roomEvent(await readJson(req))); }
    if (route === '/v1/net/usage' && method === 'POST') { const c = nodeClient(req); return send(res, 200, svc.recordNetUsage(await readJson(req, 4 * 1024 * 1024), c)); }
    if (route === '/v1/net/keys/rotate' && method === 'POST') {
      const c = authenticate(req);
      if (!c) return send(res, 401, { error: 'A key is needed' });
      requireRole(c, 'owner');
      return send(res, 200, { keys: svc.rotateKeys() });
    }
    if (route === '/v1/net/nodes' && method === 'GET') { res.setHeader('Access-Control-Allow-Origin', '*'); return send(res, 200, { nodes: svc.status().nodes }); }
    return send(res, 404, { error: 'Not found' });
  } catch (e: any) {
    if (e instanceof GenError) return send(res, (e as any).status ?? 400, { error: e.message });
    console.error('[net]', e);
    return send(res, 500, { error: String(e?.message ?? e) });
  }
}
