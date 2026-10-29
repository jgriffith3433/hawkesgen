// What Gen does for Hawkes Net, which runs on its own box (https://net.hawkesgen.ai; the service is net/ in this repo,
// docs/net.md). Three things, nothing else:
//   GET  /v1/net/whoami   the calling key (id, name, role, projects; narrowed by X-Hawkesgen-Project like every Gen call):
//                         how the box checks Gen API keys (it keeps an answer a minute)
//   POST /v1/net/usage    the box's usage for the last minute, filed in Gen's usage table (provider hawkesnet), with the
//                         key of the project "hawkesnet" the box holds
//   GET  /v1/net/usage    the caller's own Hawkes Net usage (its key's projects only): per day and in all, ?days= (30)
//   anything else under /v1/net/ and the SDK files (/sdk/hawkes-net*.mjs, /sdk/net*.mjs): a 308 to the box, so old
//                         pages and clients that still ask Gen find it (a browser's preflight is answered here)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticate, canProject, projectScopeSql } from './auth.ts';
import { db } from './db.ts';
import { env } from './config.ts';
import { recordUsage } from './usage.ts';

/** The Hawkes Net service of this Gen's lane (HAWKESGEN_NET_URL to point elsewhere, e.g. a box on this PC): gen-beta
 *  (HAWKESGEN_LANE=beta) sends to beta Net, live Gen to live Net, so beta never touches live (2026-10-29). */
export const netUrl = () => (env('HAWKESGEN_NET_URL') ?? (env('HAWKESGEN_LANE') === 'beta' ? 'https://hawkesnet.hawkesgen.ai' : 'https://net.hawkesgen.ai')).replace(/\/+$/, '');
/** What the relay costs per GB out (EC2 data transfer, us-east-1), for the usage rows. */
const RELAY_GB_COST = () => Number(env('HAWKESNET_GB_COST') ?? 0.09);

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function readJson(req: IncomingMessage, limit = 4 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return null; }
}

/** A usage report from the box: player-seconds and bytes per project and transport. Test rooms and peer to peer cost 0. */
export function recordNetUsage(rep: any, clientId: string) {
  let n = 0;
  for (const r of Array.isArray(rep?.rows) ? rep.rows.slice(0, 500) : []) {
    if (typeof r?.project !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(r.project)) continue;
    const transport = r.transport === 'relay' ? 'relay' : 'p2p';
    const minutes = Math.max(0, Number(r.playerSeconds) || 0) / 60;
    const gb = Math.max(0, Number(r.bytesOut) || 0) / 1e9;
    const detail = JSON.stringify({ node: String(rep.node ?? '').slice(0, 60), transport, test: Boolean(r.test), peakPlayers: r.peakPlayers | 0, peakRooms: r.peakRooms | 0, skipped: r.skipped | 0, slowDrops: r.slowDrops | 0, refused: r.refused ?? null, inGb: Math.round(((Number(r.bytesIn) || 0) / 1e9) * 1e6) / 1e6 });
    const base = { client: clientId, project: r.project, job: null, detail };
    if (minutes) recordUsage({ ...base, provider: 'hawkesnet', unit: `player-minute:${transport}`, amount: Math.round(minutes * 1000) / 1000, cost: 0 });
    if (gb) recordUsage({ ...base, provider: 'hawkesnet', unit: `gb:${transport}`, amount: Math.round(gb * 1e6) / 1e6, cost: r.test || transport === 'p2p' ? 0 : gb * RELAY_GB_COST() });
    n++;
  }
  return { ok: true, rows: n };
}

/** Hawkes Net usage of these projects (a key's own), per day and unit, and the totals: player-minutes, GB, dollars. */
export function netUsage(projects: string[], days = 30) {
  const since = Date.now() - days * 24 * 3600_000;
  const scope = projectScopeSql(projects);
  const rows = db.prepare(`SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, project, unit, SUM(amount) AS amount, SUM(cost) AS cost
                           FROM usage WHERE provider = 'hawkesnet' AND at >= ?${scope ? ` AND ${scope}` : ''} GROUP BY day, project, unit ORDER BY day`).all(since) as { day: string; project: string; unit: string; amount: number; cost: number }[];
  const total = { playerMinutes: 0, relayGb: 0, p2pGb: 0, cost: 0 };
  for (const r of rows) {
    if (r.unit.startsWith('player-minute:')) total.playerMinutes += r.amount;
    else if (r.unit === 'gb:relay') total.relayGb += r.amount;
    else if (r.unit === 'gb:p2p') total.p2pGb += r.amount;
    total.cost += r.cost || 0;
  }
  return { days, rows, total };
}

export async function handleNetBridge(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
  const method = req.method ?? 'GET';
  if (route === '/v1/net/whoami' && method === 'GET') {
    const c = authenticate(req);
    if (!c) return send(res, 401, { error: 'Unknown or disabled API key' });
    return send(res, 200, { client: { id: c.id, name: c.name, role: c.role, projects: c.projects } });
  }
  if (route === '/v1/net/usage' && method === 'POST') {
    const c = authenticate(req);
    if (!c) return send(res, 401, { error: 'A key is needed' });
    if (!(c.role === 'owner' || c.role === 'admin' || canProject(c, 'hawkesnet'))) return send(res, 403, { error: 'This key is not a Hawkes Net key' });
    const rep = await readJson(req);
    if (!rep) return send(res, 400, { error: 'Body is not valid JSON, or too large' });
    return send(res, 200, recordNetUsage(rep, c.id));
  }
  if (route === '/v1/net/usage' && method === 'GET') {
    const c = authenticate(req);
    if (!c) return send(res, 401, { error: 'A key is needed' });
    const days = Math.max(1, Math.min(90, Number(new URL(req.url ?? route, 'http://x').searchParams.get('days')) || 30));
    return send(res, 200, netUsage(c.projects, days));
  }
  // Everything else is the box's.
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': String(req.headers.origin ?? '*'),
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hawkesgen-Key, X-Hawkes-Client, X-Hawkesgen-Project',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    });
    return void res.end();
  }
  const url = new URL(req.url ?? route, 'http://x');
  res.writeHead(308, { Location: `${netUrl()}${route}${url.search}`, 'Access-Control-Allow-Origin': String(req.headers.origin ?? '*'), 'Cache-Control': 'no-store' });
  res.end();
}
