// Hawkes Net inside Gen (docs/net.md): the signing keys, tickets, the directory (which node holds which room), node
// heartbeats, usage into Gen's usage table, server-side publishes, and the node Gen runs itself (wss://<gen>/v1/net/ws,
// for beta and small loads; relay boxes run src/net/node.ts on their own).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { db } from '../db.ts';
import { DATA_DIR, env } from '../config.ts';
import { canProject, type Client } from '../auth.ts';
import { recordUsage } from '../usage.ts';
import { GenError } from '../util.ts';
import { netProject, originAllowed, roomConfig, type NetProject } from './registry.ts';
import { newKeyPair, exportPrivate, exportPublic, importPrivate, importPublic, signToken, TICKET_PREFIX, PUBLISH_PREFIX, type KeyPair } from './tickets.ts';
import { NetNode, type GenLink, type NodeRecord } from './node.ts';
import { VERSION as NET_VERSION, PROTOCOL } from '../../clients/js/hawkes-net-core.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS net_nodes (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, admin_url TEXT, region TEXT, status TEXT NOT NULL, players INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 1000, load REAL NOT NULL DEFAULT 0, rooms INTEGER NOT NULL DEFAULT 0, version TEXT, workers INTEGER NOT NULL DEFAULT 0,
  embedded INTEGER NOT NULL DEFAULT 0, client TEXT, beat_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS net_rooms (
  project TEXT NOT NULL, room TEXT NOT NULL, node TEXT, epoch INTEGER NOT NULL DEFAULT 1, next_ord INTEGER NOT NULL DEFAULT 1,
  transport TEXT NOT NULL DEFAULT 'p2p', config TEXT NOT NULL, players INTEGER NOT NULL DEFAULT 0, opened_at INTEGER NOT NULL, seen_at INTEGER NOT NULL,
  PRIMARY KEY (project, room)
);
CREATE INDEX IF NOT EXISTS net_rooms_node ON net_rooms (node);
`);

const BEAT_STALE_MS = 35_000;
export const ICE = [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
/** What the relay costs per GB out (EC2 data transfer, us-east-1), for the usage rows. */
const RELAY_GB_COST = Number(env('HAWKESNET_GB_COST') ?? 0.09);

// ------------------------------------------------------------------ keys
// One Ed25519 key pair signs every ticket and publish token; the previous one stays valid for a day after a rotation.
const KEY_FILE = path.join(DATA_DIR, 'net', 'keys.json');
type KeyFile = { current: { kid: string; priv: string; pub: string; at: number }; previous?: { kid: string; priv: string; pub: string; at: number } | null };
let keyCache: { pair: KeyPair; file: KeyFile } | null = null;
function keys() {
  if (keyCache) return keyCache;
  let file: KeyFile | null = null;
  try { file = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch {}
  if (!file?.current?.priv) {
    const k = newKeyPair();
    file = { current: { kid: k.kid, priv: exportPrivate(k.privateKey), pub: exportPublic(k.publicKey), at: Date.now() }, previous: null };
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  }
  const c = file.current;
  keyCache = { file, pair: { kid: c.kid, privateKey: importPrivate(c.priv), publicKey: importPublic(c.pub) } };
  return keyCache;
}
/** The public keys nodes check tickets with (GET /v1/net/keys: public, nothing secret in it). */
export function publicKeys() {
  const f = keys().file;
  const out = [{ kid: f.current.kid, pub: f.current.pub }];
  if (f.previous && Date.now() - f.current.at < 24 * 3600_000) out.push({ kid: f.previous.kid, pub: f.previous.pub });
  return out;
}
/** A new signing key; the old one keeps working for a day (nodes fetch keys every minute). */
export function rotateKeys() {
  const k = newKeyPair();
  const f = keys().file;
  const next: KeyFile = { current: { kid: k.kid, priv: exportPrivate(k.privateKey), pub: exportPublic(k.publicKey), at: Date.now() }, previous: f.current };
  fs.writeFileSync(KEY_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  keyCache = null;
  return publicKeys();
}

// ------------------------------------------------------------------ the directory
type NodeRow = { id: string; url: string; admin_url: string | null; region: string; status: string; players: number; capacity: number; load: number; rooms: number; version: string; workers: number; embedded: number; client: string | null; beat_at: number };
type RoomRow = { project: string; room: string; node: string | null; epoch: number; next_ord: number; transport: string; config: string; players: number; opened_at: number; seen_at: number };

const live = (n: NodeRow | undefined | null, now = Date.now()) => Boolean(n && n.status === 'up' && now - n.beat_at < BEAT_STALE_MS);
export function nodes(): NodeRow[] { return db.prepare('SELECT * FROM net_nodes ORDER BY id').all() as NodeRow[]; }
const nodeById = (id: string | null) => (id ? (db.prepare('SELECT * FROM net_nodes WHERE id = ?').get(id) as NodeRow | undefined) : undefined);
/** The least loaded live node with room for more players (the node inside Gen last: relay boxes first). */
function pickNode(): NodeRow | null {
  const now = Date.now();
  const list = nodes().filter((n) => live(n, now) && n.players < n.capacity);
  list.sort((a, b) => (a.embedded - b.embedded) || (a.players / a.capacity + a.load) - (b.players / b.capacity + b.load));
  return list[0] ?? null;
}

export function heartbeat(rec: NodeRecord, client: Client | null) {
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(String(rec.id))) throw new GenError('Bad node id');
  if (!/^wss?:\/\//.test(String(rec.url))) throw new GenError('A node url is ws:// or wss://');
  db.prepare(`INSERT INTO net_nodes (id, url, admin_url, region, status, players, capacity, load, rooms, version, workers, embedded, client, beat_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET url = excluded.url, admin_url = excluded.admin_url, region = excluded.region, status = excluded.status, players = excluded.players,
                capacity = excluded.capacity, load = excluded.load, rooms = excluded.rooms, version = excluded.version, workers = excluded.workers, embedded = excluded.embedded,
                client = excluded.client, beat_at = excluded.beat_at`)
    .run(rec.id, rec.url, rec.adminUrl ?? null, rec.region ?? 'us-east-1', rec.status === 'draining' ? 'draining' : 'up', Math.max(0, rec.players | 0), Math.max(1, rec.capacity | 0), Number(rec.load) || 0, Math.max(0, rec.rooms | 0), String(rec.version ?? ''), rec.workers | 0, rec.embedded ? 1 : 0, client?.id ?? null, Date.now());
  return { ok: true };
}
export function roomEvent(e: { node: string; project: string; room: string; event: string; transport: string; players: number }) {
  const now = Date.now();
  // A closed room keeps its row (and its join order, so peer ids never repeat) until the sweep, hours later.
  if (e.event === 'closed') { db.prepare('UPDATE net_rooms SET players = 0, seen_at = ? WHERE project = ? AND room = ? AND node = ?').run(now, e.project, e.room, e.node); return { ok: true }; }
  db.prepare('UPDATE net_rooms SET transport = ?, seen_at = ?, players = ? WHERE project = ? AND room = ?').run(e.transport === 'relay' ? 'relay' : 'p2p', now, Math.max(0, e.players | 0), e.project, e.room);
  return { ok: true };
}

/** A node's usage report: player-minutes and GB per project, filed in Gen's usage table (src/usage.ts). */
export function recordNetUsage(rep: { node: string; rows: any[] }, client: Client | null) {
  let n = 0;
  for (const r of Array.isArray(rep.rows) ? rep.rows.slice(0, 500) : []) {
    if (typeof r?.project !== 'string') continue;
    const transport = r.transport === 'relay' ? 'relay' : 'p2p';
    const minutes = Math.max(0, Number(r.playerSeconds) || 0) / 60;
    const gb = Math.max(0, Number(r.bytesOut) || 0) / 1e9;
    const detail = JSON.stringify({ node: rep.node, transport, test: Boolean(r.test), peakPlayers: r.peakPlayers | 0, peakRooms: r.peakRooms | 0, skipped: r.skipped | 0, slowDrops: r.slowDrops | 0, refused: r.refused ?? null, inGb: Math.round(((Number(r.bytesIn) || 0) / 1e9) * 1e6) / 1e6 });
    const base = { client: client?.id ?? 'hawkesnet', project: r.project, job: null, detail };
    if (minutes) recordUsage({ ...base, provider: 'hawkesnet', unit: `player-minute:${transport}`, amount: Math.round(minutes * 1000) / 1000, cost: 0 });
    if (gb) recordUsage({ ...base, provider: 'hawkesnet', unit: `gb:${transport}`, amount: Math.round(gb * 1e6) / 1e6, cost: r.test || transport === 'p2p' ? 0 : gb * RELAY_GB_COST });
    n++;
  }
  return { ok: true, rows: n };
}

// Rows of rooms empty for six hours go (a ticket lives 90 s and a resume token 10 minutes, so their peer ids are long
// dead); at most once a minute.
let sweptAt = 0;
function sweepRooms(now: number) {
  if (now - sweptAt < 60_000) return;
  sweptAt = now;
  db.prepare('DELETE FROM net_rooms WHERE players = 0 AND seen_at < ?').run(now - 6 * 3600_000);
}

// ------------------------------------------------------------------ tickets
const ROOM_RE = /^[a-z0-9][a-z0-9/_.-]{0,63}$/i;
/** May this key make tickets for this Hawkes Net project? Its own project, or a key-project pattern the entry lists. */
export function keyMayIssue(c: Client, p: NetProject) {
  if (c.role === 'owner' || c.projects.includes('*') || canProject(c, p.id)) return true;
  // A key whose own projects entry is the pattern (the portal's key: usr_*) may; the same key narrowed to one customer
  // (X-Hawkesgen-Project: usr_x) may not act for the whole project.
  return c.projects.some((cp) => p.keyProjects.includes(cp));
}

// The public door (no key, by Origin): per address and per project, in memory.
const doorHits = new Map<string, number[]>();
function doorLimit(key: string, max: number, ms = 60_000) {
  const now = Date.now();
  const recent = (doorHits.get(key) ?? []).filter((t) => now - t < ms);
  if (recent.length >= max) throw new GenError('Too many tickets; wait a moment', { status: 429 });
  recent.push(now);
  doorHits.set(key, recent);
  if (doorHits.size > 50_000) for (const [k, v] of doorHits) if (!v.length || now - v[v.length - 1] > ms) doorHits.delete(k);
}

export type TicketAuth = { client: Client | null; origin: string; ip: string | null; host: string | null; proto: string };

export function issueTicket(body: any, auth: TicketAuth) {
  const project = String(body?.project ?? '');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(project)) throw new GenError('project is the Hawkes Net project id');
  const p = netProject(project);
  const room = String(body?.room ?? '');
  if (!ROOM_RE.test(room)) throw new GenError('room is 1 to 64 of letters, digits and / _ . -');
  let role = ['player', 'spectator', 'bot', 'test'].includes(body?.role) ? body.role : 'player';
  if (auth.client) {
    if (!keyMayIssue(auth.client, p)) throw new GenError(`This key can't make tickets for ${project}`, { status: 403 });
  } else {
    if (!p.listed || !originAllowed(p, auth.origin)) throw new GenError('Tickets without a key only for the project\'s own sites', { status: 403 });
    if (role === 'bot' || role === 'test') throw new GenError('bot and test tickets need an API key', { status: 403 });
    doorLimit(`ip:${auth.ip ?? '?'}`, 30);
    doorLimit(`prj:${project}`, 3000);
  }
  const choice = ['auto', 'p2p', 'relay'].includes(body?.transport) ? body.transport : 'auto';
  let tr = p.transports.filter((t) => choice === 'auto' || t === choice);
  if (!tr.length) tr = p.transports.slice(0, 1);
  if (!tr.length) throw new GenError(`${project} may not use Hawkes Net`, { status: 403 });
  const protocols: number[] = Array.isArray(body?.client?.protocols) ? body.client.protocols.map(Number) : [PROTOCOL];
  if (!protocols.includes(3) && !protocols.includes(2)) throw new GenError('This SDK is too old for Hawkes Net; reload', { status: 426 });
  const now = Date.now();

  // The room: where it lives (one node), its config (fixed by its first ticket) and the next join order.
  const tx = db.prepare('BEGIN IMMEDIATE');
  tx.run();
  let row: RoomRow;
  let node: NodeRow | null;
  try {
    row = db.prepare('SELECT * FROM net_rooms WHERE project = ? AND room = ?').get(project, room) as RoomRow;
    node = row ? nodeById(row.node) ?? null : null;
    if (!row || !live(node, now)) {
      // A new room, or its node went away: the least loaded live node takes it (a new epoch, so old tickets fail).
      sweepRooms(now);
      // Rooms with people in them count toward the limit; rooms asked for but not joined yet have their own, larger cap
      // (so tickets for rooms nobody enters can't lock a project out of new rooms).
      const open = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(players), 0) AS players FROM net_rooms WHERE project = ? AND players > 0 AND seen_at > ?").get(project, now - 10 * 60_000) as { n: number; players: number };
      if (!row && open.n >= p.limits.rooms) throw new GenError(`${project} has ${open.n} rooms open, its limit`, { status: 429 });
      const waiting = (db.prepare('SELECT COUNT(*) AS n FROM net_rooms WHERE project = ? AND players = 0 AND seen_at > ?').get(project, now - 5 * 60_000) as { n: number }).n;
      if (!row && waiting >= p.limits.rooms * 5) throw new GenError(`${project} has too many rooms waiting for players`, { status: 429 });
      if (open.players >= p.limits.players) throw new GenError(`${project} has ${open.players} players online, its limit`, { status: 429 });
      node = pickNode();
      if (!node) throw new GenError('No Hawkes Net node is up right now; try again in a minute', { status: 503 });
      const cfg = roomConfig(p, body?.config);
      if (!row) {
        db.prepare('INSERT INTO net_rooms (project, room, node, epoch, next_ord, transport, config, players, opened_at, seen_at) VALUES (?, ?, ?, 1, 1, ?, ?, 0, ?, ?)').run(project, room, node.id, choice === 'relay' ? 'relay' : 'p2p', JSON.stringify(cfg), now, now);
      } else db.prepare('UPDATE net_rooms SET node = ?, epoch = epoch + 1, seen_at = ? WHERE project = ? AND room = ?').run(node.id, now, project, room);
      row = db.prepare('SELECT * FROM net_rooms WHERE project = ? AND room = ?').get(project, room) as RoomRow;
    }
    db.prepare('UPDATE net_rooms SET next_ord = next_ord + 1, seen_at = ? WHERE project = ? AND room = ?').run(now, project, room);
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  const cfg = JSON.parse(row.config);
  const ord = row.next_ord;
  const peer = `p${ord}`;
  const name = typeof body?.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || null : null;
  const sub = typeof body?.sub === 'string' && body.sub ? body.sub.slice(0, 64) : crypto.randomBytes(8).toString('hex');
  const k = keys().pair;
  const iat = Math.floor(now / 1000);
  const payload = {
    v: 1, kid: k.kid, prj: project, room, peer, ord, sub, nm: name, role, tr, want: choice, node: node!.id, epoch: row.epoch,
    lim: p.limits, cfg, iat, exp: iat + 90, jti: crypto.randomBytes(9).toString('base64url'),
  };
  const ticket = signToken(TICKET_PREFIX, payload, k.privateKey);
  const url = node!.embedded ? embeddedUrl(auth) : node!.url;
  return { ticket, peer, ord, config: cfg, relayUrl: url, signalUrl: url, transports: tr, ice: ICE, expiresAt: (iat + 90) * 1000, node: node!.id, epoch: row.epoch, protocol: protocols.includes(3) ? 3 : 2, sdk: NET_VERSION };
}
/** The node inside Gen is reached where the caller reached Gen. */
function embeddedUrl(a: TicketAuth) {
  const fixed = env('HAWKESGEN_NET_URL');
  if (fixed) return fixed;
  const loop = !a.host || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(a.host);
  // On the cloud server a caller on this machine (the beta portal) hands the ticket to players' browsers, which reach
  // Gen at its public name.
  if (loop && env('HAWKES_AWS_ROLE')) return 'wss://gen.hawkesgen.com/v1/net/ws';
  if (!a.host) return `ws://127.0.0.1:${env('HAWKESGEN_PORT') ?? 8790}/v1/net/ws`;
  return `${a.proto === 'https' ? 'wss' : 'ws'}://${a.host}/v1/net/ws`;
}

// ------------------------------------------------------------------ server-side publish (world edits, server events)
/** Sends world edits or an event into a room from a server (the portal saving a scene). Nothing happens when the room
 *  isn't open. Signed with Gen's key, so the node takes it from no one else. */
export async function publish(client: Client, body: any) {
  const project = String(body?.project ?? '');
  const room = String(body?.room ?? '');
  const p = netProject(project);
  if (!keyMayIssue(client, p)) throw new GenError(`This key can't publish to ${project}`, { status: 403 });
  // "<prefix>/*": every open room under it (a game's edit room and all its play rooms hear one world edit).
  if (room.endsWith('/*')) {
    const prefix = room.slice(0, -1);
    if (!ROOM_RE.test(prefix.slice(0, -1)) || prefix.length < 3) throw new GenError('Bad room prefix');
    const names = (db.prepare("SELECT room FROM net_rooms WHERE project = ? AND players > 0 AND substr(room, 1, ?) = ? LIMIT 200").all(project, prefix.length, prefix) as { room: string }[]).map((r) => r.room);
    let delivered = 0;
    for (const name of names) delivered += Number((await publish(client, { ...body, room: name })).delivered) || 0;
    return { delivered, rooms: names.length, open: names.length > 0 };
  }
  if (!ROOM_RE.test(room)) throw new GenError('Bad room');
  const row = db.prepare('SELECT node FROM net_rooms WHERE project = ? AND room = ?').get(project, room) as { node: string | null } | undefined;
  const node = row ? nodeById(row.node) : null;
  if (!row || !node || !live(node)) return { delivered: 0, open: false };
  const k = keys().pair;
  const iat = Math.floor(Date.now() / 1000);
  const token = signToken(PUBLISH_PREFIX, { v: 1, kid: k.kid, prj: project, room, iat, exp: iat + 30, jti: crypto.randomBytes(9).toString('base64url') }, k.privateKey);
  const msg = { ops: Array.isArray(body.ops) ? body.ops : undefined, by: typeof body.by === 'string' ? body.by.slice(0, 60) : 'server', fx: typeof body.fx === 'string' ? body.fx.slice(0, 20) : null, event: body.event && typeof body.event.name === 'string' ? { name: body.event.name, data: body.event.data ?? null } : undefined, except: typeof body.except === 'string' ? body.except : null, kick: body.kick && typeof body.kick === 'object' ? { sub: typeof body.kick.sub === 'string' && body.kick.sub ? body.kick.sub.slice(0, 64) : null } : undefined };
  if (node.embedded && embedded) return { open: true, ...(await embedded.publish(token, msg)) };
  if (!node.admin_url) return { delivered: 0, open: true, error: 'This node takes no publishes' };
  const r = await fetch(`${node.admin_url.replace(/\/+$/, '')}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!r) return { delivered: 0, open: true, error: 'Node not answering' };
  return { open: true, ...(await r.json().catch(() => ({}))) };
}

/** Is a room open (someone in it, on a live node), how many are in it, and on what? (Invitations ask before loading.) */
export function roomInfo(client: Client, body: any) {
  const project = String(body?.project ?? '');
  const room = String(body?.room ?? '');
  const p = netProject(project);
  if (!keyMayIssue(client, p)) throw new GenError(`This key can't read ${project}`, { status: 403 });
  if (!ROOM_RE.test(room)) throw new GenError('Bad room');
  const row = db.prepare('SELECT * FROM net_rooms WHERE project = ? AND room = ?').get(project, room) as RoomRow | undefined;
  const node = row ? nodeById(row.node) : null;
  const open = Boolean(row && live(node) && row.players > 0);
  return { open, players: open ? row!.players : 0, transport: row?.transport ?? null, limit: row ? JSON.parse(row.config).maxPlayers : netProject(project).defaults.maxPlayers };
}

// ------------------------------------------------------------------ status
export function status() {
  const now = Date.now();
  const ns = nodes().map((n) => ({ id: n.id, url: n.url, region: n.region, status: live(n, now) ? n.status : 'down', players: n.players, capacity: n.capacity, load: n.load, rooms: n.rooms, version: n.version, workers: n.workers, embedded: Boolean(n.embedded), beatAgoMs: now - n.beat_at }));
  const rooms = db.prepare("SELECT project, transport, COUNT(*) AS rooms, COALESCE(SUM(players), 0) AS players FROM net_rooms WHERE seen_at > ? GROUP BY project, transport").all(now - 10 * 60_000);
  return { version: NET_VERSION, protocol: PROTOCOL, up: ns.some((n) => n.status === 'up'), nodes: ns, rooms };
}

// ------------------------------------------------------------------ the node inside Gen
let embedded: NetNode | null = null;
const inProcess: GenLink = {
  keys: async () => publicKeys(),
  heartbeat: async (rec) => { heartbeat(rec, null); },
  room: async (e) => { roomEvent(e as any); },
  usage: async (rep) => { recordNetUsage(rep, null); },
};
/** Starts the node Gen runs itself (settings: HAWKESGEN_NET_EMBEDDED=0 turns it off, HAWKESGEN_NET_WORKERS its worker processes). */
export async function startEmbedded() {
  if (embedded || env('HAWKESGEN_NET_EMBEDDED') === '0') return embedded;
  const workers = Number(env('HAWKESGEN_NET_WORKERS') ?? 1);
  embedded = new NetNode({ id: env('HAWKESGEN_NET_NODE_ID') ?? 'gen', url: env('HAWKESGEN_NET_URL') ?? `ws://127.0.0.1:${env('HAWKESGEN_PORT') ?? 8790}/v1/net/ws`, adminUrl: null, embedded: true, capacity: Number(env('HAWKESGEN_NET_CAPACITY') ?? 1500), workers, link: inProcess });
  await embedded.start();
  return embedded;
}
export const embeddedNode = () => embedded;
export async function stopEmbedded() { if (embedded) { await embedded.drain(3000).catch(() => {}); embedded.stop(); embedded = null; } }

/** Who a ticket request is from (the public door uses the origin and the address). */
export function ticketAuth(req: IncomingMessage, client: Client | null): TicketAuth {
  const sock = req.socket.remoteAddress ?? '';
  const loop = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = (loop && xff.length ? xff[xff.length - 1] : sock) || null;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || ((req.socket as any).encrypted ? 'https' : 'http');
  return { client, origin: String(req.headers.origin ?? ''), ip, host: String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '') || null, proto };
}
