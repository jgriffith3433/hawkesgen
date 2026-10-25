// Which projects use Hawkes Net and how (net/projects.json, re-read when it changes): origins for the public ticket door,
// the key projects that may make tickets, transports, the room defaults and the limits (docs/net.md "Limits and usage").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS, DEFAULT_INTEREST } from '../../clients/js/hawkes-net-core.mjs';

export type RoomConfig = { topology: 'star' | 'pair'; profile: 'light' | 'medium' | 'heavy'; maxPlayers: number; p2pMax: number; interest: any; quant?: Record<string, number>; sendHz?: number };
export type Limits = { rooms: number; playersPerRoom: number; players: number; downBytesPerSec: number; upBytesPerSec: number; msgsPerSec: number; innerPerSec: number; messageBytes: number; ents: number; states: number; egressBytesPerSec: number; monthlyBytes: number };
export type NetProject = { id: string; name: string; origins: string[]; keyProjects: string[]; transports: ('p2p' | 'relay')[]; signal: string; defaults: RoomConfig; limits: Limits; testPrefix: string; listed: boolean };

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'net', 'projects.json');
const BASE_LIMITS: Limits = { rooms: 200, players: 2000, egressBytesPerSec: 5 * 1024 * 1024, monthlyBytes: 5e12, ...DEFAULT_LIMITS } as Limits;
const BASE_CONFIG: RoomConfig = { topology: 'star', profile: 'medium', maxPlayers: 64, p2pMax: 8, interest: DEFAULT_INTEREST };

let cache: { mtime: number; data: any } | null = null;
function read(file = FILE) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return { defaults: {}, projects: {} }; }
  if (cache && cache.mtime === mtime) return cache.data;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache = { mtime, data };
  return data;
}

const clean = (o: string) => String(o).replace(/\/+$/, '').toLowerCase();
/** A project's Hawkes Net settings: its entry over the file's defaults over the built-in ones. */
export function netProject(id: string): NetProject {
  const raw = read();
  const d = raw.defaults ?? {};
  const p = raw.projects?.[id];
  const pick = (k: string) => (p && p[k] !== undefined ? p[k] : d[k]);
  return {
    id,
    name: String(p?.name ?? id),
    origins: [...(Array.isArray(pick('origins')) ? pick('origins') : [])].map(clean),
    keyProjects: Array.isArray(pick('keyProjects')) ? pick('keyProjects').map(String) : [],
    transports: (Array.isArray(pick('transports')) ? pick('transports') : ['p2p', 'relay']).filter((t: string) => t === 'p2p' || t === 'relay'),
    signal: String(pick('signal') ?? 'hawkes'),
    defaults: { ...BASE_CONFIG, ...(d.defaults ?? {}), ...(p?.defaults ?? {}) },
    limits: { ...BASE_LIMITS, ...(d.limits ?? {}), ...(p?.limits ?? {}) },
    testPrefix: String(pick('testPrefix') ?? 't-'),
    listed: Boolean(p),
  };
}
export const listedProjects = () => Object.keys(read().projects ?? {});

/** May this origin ask for player tickets with no key? (The project's origins, or this machine on any port.) */
export function originAllowed(p: NetProject, origin: string) {
  const o = clean(origin);
  if (!o) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(o)) return true;
  return p.origins.includes(o);
}

const NUM = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
/** A room's config from a request, clamped to the project's (a game can ask for less, never more). */
export function roomConfig(p: NetProject, asked: any = {}): RoomConfig {
  const d = p.defaults;
  const a = asked && typeof asked === 'object' ? asked : {};
  const maxPlayers = NUM(a.maxPlayers, 1, Math.min(p.limits.playersPerRoom, 1000), Math.min(d.maxPlayers, p.limits.playersPerRoom));
  const topology = a.topology === 'pair' || a.topology === 'star' ? a.topology : d.topology;
  return {
    topology,
    profile: ['light', 'medium', 'heavy'].includes(a.profile) ? a.profile : d.profile,
    maxPlayers: topology === 'pair' ? Math.min(2, maxPlayers) : maxPlayers,
    p2pMax: NUM(a.p2pMax, 1, Math.min(24, maxPlayers), Math.min(d.p2pMax, maxPlayers)),
    interest: a.interest === null ? null : d.interest,
    // How often the relay sends each player a bundle: 30 (every 33 ms, physics worlds) or less for lighter games.
    sendHz: NUM(a.sendHz, 10, 60, Number(d.sendHz) || 30),
    ...(d.quant ? { quant: d.quant } : {}),
  };
}
