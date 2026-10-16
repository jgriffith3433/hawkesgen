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

/** The client a request comes from, or null. */
export function authenticate(req: IncomingMessage): Client | null {
  const header = String(req.headers.authorization ?? '');
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-hawkesgen-key'] ?? '').trim();
  if (key) {
    const row: any = db.prepare('SELECT * FROM clients WHERE key_hash = ?').get(sha256(key));
    if (!row || row.disabled) return null;
    db.prepare('UPDATE clients SET last_used = ? WHERE id = ?').run(Date.now(), row.id);
    return { id: row.id, name: row.name, role: row.role, projects: JSON.parse(row.projects) };
  }
  if (loadSettings().localOpen && isLoopback(req.socket.remoteAddress)) return LOCAL_OWNER;
  return null;
}

export function canProject(c: Client, project: string) {
  return c.projects.includes('*') || c.projects.includes(project);
}

export function requireRole(c: Client, role: 'owner' | 'admin') {
  const rank = { user: 0, admin: 1, owner: 2 };
  if (rank[c.role] < rank[role]) throw new GenError(`This needs the ${role} role`, { status: 403 });
}
