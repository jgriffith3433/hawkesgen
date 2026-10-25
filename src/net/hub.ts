// The Hawkes Net box (net.hawkesgen.com): everything multiplayer, off the control server (J, 2026-10-25: "i dont want the
// control server doing EVEN MORE"). One process serves Hawkes Net's routes (tickets, the directory, publish, room info,
// node heartbeats, keys, status, the SDK files: src/net/api.ts) from its own data folder, and runs a relay node with worker
// processes (src/net/node.ts) on this box. More relay boxes join by pointing `node src/net/node.ts` here (NET_GEN_URL).
// Gen is asked only to check API keys (GET /v1/net/whoami, kept a minute) and is sent usage once a minute.
//
//   node src/net/hub.ts        settings from the environment (deploy/net/hawkes-net.env.example):
//     NET_PORT (8800), NET_HOST (127.0.0.1: Caddy in front), NET_DATA_DIR (the directory and signing keys),
//     NET_GEN_URL (https://gen.hawkesgen.com), NET_GEN_KEY (a Gen key for the project "hawkesnet": usage),
//     NET_PUBLIC_URL (wss://net.hawkesgen.com/v1/net/ws), NET_WORKERS (relay worker processes, default the CPU count),
//     NET_CAPACITY (players this box takes before new rooms go elsewhere)
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const env = (k: string, d = '') => process.env[k] ?? d;
const genUrl = env('NET_GEN_URL', 'https://gen.hawkesgen.com').replace(/\/+$/, '');
const genKey = env('NET_GEN_KEY');
if (!genKey) { console.error('[net] NET_GEN_KEY is required (a Gen API key for the project "hawkesnet")'); process.exit(1); }

// Gen's modules keep their data in HAWKESGEN_DATA_DIR: here that is this box's own folder (the directory, the keys).
process.env.HAWKESGEN_DATA_DIR = path.resolve(env('NET_DATA_DIR', path.join(os.homedir(), 'net-data')));
process.env.HAWKESGEN_NET_URL = env('NET_PUBLIC_URL', 'wss://net.hawkesgen.com/v1/net/ws');
process.env.HAWKESGEN_NET_WORKERS = env('NET_WORKERS', String(Math.max(1, os.availableParallelism())));
process.env.HAWKESGEN_NET_CAPACITY = env('NET_CAPACITY', '4000');
process.env.HAWKESGEN_NET_NODE_ID = env('NET_NODE_ID', `net-${os.hostname()}`);
process.env.HAWKESGEN_NET_EMBEDDED = '1';
process.env.HAWKESGEN_NET_USAGE_MS = env('NET_USAGE_MS', '60000');
process.env.HAWKESGEN_NET_HUB = '0';

const { saveSettings, loadSettings } = await import('../config.ts');
// Nothing on this machine is trusted for being on it: localhost is never a ticket door here (registry.ts originAllowed).
if (loadSettings().localOpen) saveSettings({ localOpen: false });
const svc = await import('./service.ts');
const api = await import('./api.ts');
const { refuse } = await import('./ws.ts');
type Client = import('../auth.ts').Client;
api.serveHere();

// ------------------------------------------------------------------ keys, checked with Gen and kept a minute
const known = new Map<string, { at: number; client: Client | null }>();
const KEEP_MS = 60_000, KEEP_NO_MS = 10_000;
async function checkKey(req: IncomingMessage): Promise<Client | null> {
  const header = String(req.headers.authorization ?? '');
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-hawkesgen-key'] ?? '').trim();
  if (!key) return null;
  const only = String(req.headers['x-hawkesgen-project'] ?? '').trim();
  const id = crypto.createHash('sha256').update(`${key}\n${only}`).digest('base64url');
  const had = known.get(id);
  if (had && Date.now() - had.at < (had.client ? KEEP_MS : KEEP_NO_MS)) return had.client;
  let client: Client | null = null;
  try {
    const r = await fetch(`${genUrl}/v1/net/whoami`, { headers: { Authorization: `Bearer ${key}`, ...(only ? { 'X-Hawkesgen-Project': only } : {}) }, signal: AbortSignal.timeout(5000) });
    if (r.ok) { const j: any = await r.json(); const c = j?.client; if (c && typeof c.id === 'string' && Array.isArray(c.projects)) client = { id: c.id, name: String(c.name ?? ''), role: c.role, projects: c.projects.map(String) }; }
    else if (r.status >= 500) { if (had) return had.client; throw new Error(`Gen answered ${r.status}`); }
  } catch (e) {
    // Gen unreachable: a key it vouched for lately still works; a new one waits.
    if (had?.client) return had.client;
    console.warn(`[net] key check: ${(e as Error).message}`);
    return null;
  }
  known.set(id, { at: Date.now(), client });
  if (known.size > 20_000) for (const [k, v] of known) if (Date.now() - v.at > KEEP_MS) known.delete(k);
  return client;
}
api.useKeyCheck(checkKey);

// ------------------------------------------------------------------ usage to Gen, once a minute, kept until it lands
const outbox: { node: string; rows: any[] }[] = [];
svc.sendUsageTo((rep) => { if (Array.isArray(rep?.rows) && rep.rows.length) { outbox.push(rep); if (outbox.length > 1440) outbox.shift(); } });
async function flushUsage() {
  while (outbox.length) {
    const rep = outbox[0];
    try {
      const r = await fetch(`${genUrl}/v1/net/usage`, { method: 'POST', headers: { Authorization: `Bearer ${genKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(rep), signal: AbortSignal.timeout(10_000) });
      if (!r.ok && r.status < 500) { console.warn(`[net] usage refused by Gen (${r.status}): ${(await r.text()).slice(0, 200)}`); outbox.shift(); continue; }
      if (!r.ok) return;
      outbox.shift();
    } catch { return; }
  }
}
setInterval(() => void flushUsage(), Number(env('NET_USAGE_MS', '60000'))).unref();

// ------------------------------------------------------------------ the server
const node = await svc.startEmbedded();
if (!node) { console.error('[net] the relay node did not start'); process.exit(1); }
const server = http.createServer((req, res) => {
  const route = new URL(req.url ?? '/', 'http://x').pathname;
  if (route === '/healthz' || route === '/') {
    const st = svc.status();
    res.writeHead(st.up ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify({ ok: st.up, service: 'hawkes-net', version: st.version, usageWaiting: outbox.length }));
  }
  if (route.startsWith('/v1/net/') || route.startsWith('/sdk/')) return void api.handleNet(req, res, route);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"Not found"}');
});
server.on('upgrade', (req, socket, head) => {
  const route = new URL(req.url ?? '/', 'http://x').pathname;
  if (route !== '/v1/net/ws' && route !== '/v3') return refuse(socket, 404, 'Not found');
  node.upgrade(req, socket, head);
});
server.keepAliveTimeout = 75_000;
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
const port = Number(env('NET_PORT', '8800'));
server.listen(port, env('NET_HOST', '127.0.0.1'), () => console.log(`[net] Hawkes Net on :${port}: node ${node.o.id}, ${node.workers.length} worker(s), Gen ${genUrl}`));

let leaving = false;
const leave = async () => {
  if (leaving) return;
  leaving = true;
  console.log('[net] draining');
  server.close();
  await svc.stopEmbedded(); // drains the rooms and reports their last usage
  await flushUsage().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void leave());
process.on('SIGINT', () => void leave());
process.on('uncaughtException', (e) => console.error('[net] uncaught:', e));
process.on('unhandledRejection', (e) => console.error('[net] unhandled:', e));
