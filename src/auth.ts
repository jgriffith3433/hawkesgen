// API clients. Each game, website or (one day) paying customer gets a key
// (hg_...). Requests carry it as "Authorization: Bearer hg_..." or
// "X-Hawkesgen-Key". Only its hash is stored.
//
// Roles:
//   owner  everything, including actions that cost money (launch, start, scale) and keys
//   admin  fleet start/stop and settings, no key management
//   user   submit jobs and read its own projects' jobs and assets
//
// With settings.localOpen (default on), a request from this machine without
// a key acts as the owner, so local tools work with no setup.

import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { db, parseRow, J } from './db.ts';
import { loadSettings } from './config.ts';
import { id, sha256, GenError } from './util.ts';
import { DASH_COOKIE, sessionEmail } from './dashauth.ts';

export type Client = { id: string; name: string; role: 'owner' | 'admin' | 'user'; projects: string[] };

export const LOCAL_OWNER: Client = { id: 'local', name: 'This machine', role: 'owner', projects: ['*'] };

export function createClient(name: string, role: Client['role'] = 'user', projects: string[] = ['*']) {
  if (!['owner', 'admin', 'user'].includes(role)) throw new GenError(`Unknown role: ${role}`);
  const key = `hg_${crypto.randomBytes(24).toString('base64url')}`;
  const clientId = id('c', 6);
  db.prepare('INSERT INTO clients (id, name, prefix, key_hash, role, projects, created) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    clientId, name, key.slice(0, 7), sha256(key), role, J(projects), Date.now(),
  );
  return { client: getClient(clientId), key };
}

export function getClient(clientId: string) {
  return parseRow(db.prepare('SELECT id, name, prefix, role, projects, created, last_used, disabled FROM clients WHERE id = ?').get(clientId), ['projects']);
}

export function listClients() {
  return db.prepare('SELECT id, name, prefix, role, projects, created, last_used, disabled FROM clients ORDER BY created').all().map((r) => parseRow(r, ['projects']));
}

export function setClientDisabled(clientId: string, disabled: boolean) {
  db.prepare('UPDATE clients SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, clientId);
}

const isLoopback = (addr = '') => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

/** The dashboard's sign-in (api.ts /v1/dashboard/signin): an owner or admin key in an HttpOnly, SameSite=Strict cookie,
 *  so the dashboard's links, images and event stream (which can't send a header) work where "this machine" isn't J's PC. */
export const KEY_COOKIE = 'hg_key';
const cookieOf = (req: IncomingMessage, name: string) => {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(req.headers.cookie ?? ''));
  try { return m ? decodeURIComponent(m[1]).trim() : ''; } catch { return ''; }
};
const cookieKey = (req: IncomingMessage) => cookieOf(req, KEY_COOKIE);

/** A dashboard key: an enabled owner or admin key, else null. */
export function dashboardClient(key: string): Client | null {
  const row: any = db.prepare('SELECT * FROM clients WHERE key_hash = ?').get(sha256(String(key ?? '').trim()));
  if (!row || row.disabled || !['owner', 'admin'].includes(row.role)) return null;
  return { id: row.id, name: row.name, role: row.role, projects: JSON.parse(row.projects) };
}

/** The client a request comes from, or null. */
export function authenticate(req: IncomingMessage): Client | null {
  const header = String(req.headers.authorization ?? '');
  const sent = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-hawkesgen-key'] ?? '').trim();
  const fromCookie = sent ? '' : cookieKey(req);
  if (fromCookie && !dashboardClient(fromCookie)) return null;
  // Signed in with Google (dashauth.ts): the owner, while the email is on settings.dashboard.googleEmails.
  if (!sent && !fromCookie) {
    const email = sessionEmail(cookieOf(req, DASH_COOKIE));
    if (email) return { id: `google:${email}`, name: email, role: 'owner', projects: ['*'] };
  }
  const key = sent || fromCookie;
  if (key) {
    const row: any = db.prepare('SELECT * FROM clients WHERE key_hash = ?').get(sha256(key));
    if (!row || row.disabled) return null;
    db.prepare('UPDATE clients SET last_used = ? WHERE id = ?').run(Date.now(), row.id);
    const c: Client = { id: row.id, name: row.name, role: row.role, projects: JSON.parse(row.projects) };
    // A key can narrow itself to one of its projects for this request (the portal acts for one customer at a time),
    // so every check below (jobs by id, events, inputs, slot references, files) is that customer's alone.
    const only = String(req.headers['x-hawkesgen-project'] ?? '').trim();
    if (only) return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(only) && canProject(c, only) ? { ...c, projects: [only] } : null;
    return c;
  }
  // Never on Cloud Run: "this machine" is the platform's front end there, not J's PC.
  if (loadSettings().localOpen && !process.env.K_SERVICE && isLoopback(req.socket.remoteAddress)) return LOCAL_OWNER;
  return null;
}

// A key's projects are names, '*' (all), or a prefix pattern like 'u_*': the hawkesgen.ai portal holds one key and
// works in a project per customer (u_<id>), naming it on every call.
const matches = (p: string, project: string) => p === '*' || p === project || (p.endsWith('*') && project.startsWith(p.slice(0, -1)));

export function canProject(c: Client, project: string) {
  return c.projects.some((p) => matches(p, project));
}

/** The one project a user key always works in, or null when the caller names it (the owner, a pattern key). */
export function fixedProject(c: Client): string | null {
  return c.role === 'user' && c.projects.length === 1 && !c.projects[0].includes('*') ? c.projects[0] : null;
}

/** SQL limiting a `project` column to what these projects allow, or null for everything. */
export function projectScopeSql(projects: string[]): string | null {
  if (projects.includes('*')) return null;
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const names = projects.filter((p) => !p.endsWith('*'));
  const parts = projects.filter((p) => p.endsWith('*')).map((p) => `project LIKE ${q(p.slice(0, -1).replace(/[\\%_]/g, (ch) => `\\${ch}`) + '%')} ESCAPE '\\'`);
  if (names.length) parts.push(`project IN (${names.map(q).join(',')})`);
  return parts.length ? `(${parts.join(' OR ')})` : "project IN ('')";
}

export function requireRole(c: Client, role: 'owner' | 'admin') {
  const rank = { user: 0, admin: 1, owner: 2 };
  if (rank[c.role] < rank[role]) throw new GenError(`This needs the ${role} role`, { status: 403 });
}
