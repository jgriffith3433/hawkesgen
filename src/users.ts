// Multi-tenant SaaS user accounts, scrypt password hashing, session cookies,
// and unified request authentication (session cookie + API key).

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { env, loadSettings } from './config.ts';
import { authenticate, createClient, getClient, setClientDisabled, type Client } from './auth.ts';
import { id, sha256, GenError } from './util.ts';
import { genOAuth } from './genoauth.ts';
import { decideStarter, recordSignup, STARTER_REFUSED_MESSAGE } from './signupcap.ts';

export type AuthClient = Client & { userId?: string };

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  project: string;
  client_id: string | null;
  credits: number;
  stripe_customer_id: string | null;
  created: number;
  last_login: number | null;
};

export type PublicUser = {
  id: string;
  email: string;
  name: string | null;
  project: string;
  credits: number;
  created: number;
  last_login: number | null;
  hasBilling: boolean;
};

export const SESSION_COOKIE = 'hg_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    project: u.project,
    credits: u.credits,
    created: u.created,
    last_login: u.last_login,
    /** Has paid through Stripe (the billing portal has something to show). */
    hasBilling: Boolean(u.stripe_customer_id),
  };
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, expected);
}

export function starterCredits(): number {
  const raw = env('HAWKESGEN_STARTER_CREDITS');
  if (raw === undefined || raw === '') return 50;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

export function getUserById(userId: string): UserRow | null {
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined) ?? null;
}

export function getUserByEmail(email: string): UserRow | null {
  const norm = String(email ?? '').trim().toLowerCase();
  if (!norm) return null;
  return (db.prepare('SELECT * FROM users WHERE email = ?').get(norm) as UserRow | undefined) ?? null;
}

export function getUserForClient(c: Client | AuthClient): UserRow | null {
  const userId = (c as AuthClient).userId;
  if (userId) {
    const byId = getUserById(userId);
    if (byId) return byId;
  }
  const byClientOrId = db.prepare('SELECT * FROM users WHERE id = ? OR client_id = ?').get(c.id, c.id) as UserRow | undefined;
  if (byClientOrId) return byClientOrId;
  if (c.role === 'user' && c.projects.length === 1 && c.projects[0].startsWith('u_') && !c.projects[0].includes('*')) {
    return (db.prepare('SELECT * FROM users WHERE project = ?').get(c.projects[0]) as UserRow | undefined) ?? null;
  }
  return null;
}

export function signupUser(input: { email?: unknown; password?: unknown; name?: unknown }, opts: { starter?: number } = {}) {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new GenError('Enter a valid email address');
  const password = typeof input.password === 'string' ? input.password : '';
  if (password.length < 6) throw new GenError('Password must be at least 6 characters');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : email.split('@')[0];

  if (getUserByEmail(email)) throw new GenError('An account with that email already exists', { status: 409 });

  const userId = id('u', 6);
  const project = userId;
  const pwdHash = hashPassword(password);
  const starter = opts.starter ?? starterCredits();
  const now = Date.now();

  db.exec('BEGIN');
  let apiKey = '';
  try {
    const minted = createClient(email, 'user', [project]);
    apiKey = minted.key;
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, project, client_id, credits, stripe_customer_id, created, last_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(userId, email, name, pwdHash, project, minted.client.id, starter, now, now);

    if (starter > 0) {
      db.prepare(
        `INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, detail, job_id, stripe_session_id, created)
         VALUES (?, ?, ?, ?, 'signup_bonus', ?, NULL, NULL, ?)`,
      ).run(id('tx', 6), userId, starter, starter, `Starter bonus (${starter} credits)`, now);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const user = getUserById(userId)!;
  const session = createSession(user.id);
  return { user: toPublicUser(user), apiKey, sessionToken: session.token };
}

// Continue with Google (J, 2026-10-29: one Google account signs in to every product, each keeping its own account): a
// Gen account is found by Google's permanent id (`google_sub`), else by its email (an account made with a password
// before, now linked), else made. Passwords are off (passwordsAllowed).
// Accounts the owner disabled in /admin > Accounts (src/accounts.ts): their sessions and keys stop working.
db.exec('CREATE TABLE IF NOT EXISTS user_flags (user_id TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0, note TEXT, updated INTEGER NOT NULL, by TEXT)');
export function isDisabled(userId: string): boolean {
  return Boolean((db.prepare('SELECT disabled FROM user_flags WHERE user_id = ?').get(userId) as { disabled: number } | undefined)?.disabled);
}
db.exec('CREATE TABLE IF NOT EXISTS user_google (user_id TEXT PRIMARY KEY, sub TEXT UNIQUE NOT NULL, linked INTEGER NOT NULL)');

/**
 * Email-and-password sign-up and sign-in: off everywhere (J, 2026-10-30: "I don't want email and password"); Google is the
 * way in. HAWKESGEN_PASSWORD_LOGIN=1 turns them on for automated tests and throwaway local copies only.
 */
export const passwordsAllowed = () => env('HAWKESGEN_PASSWORD_LOGIN') === '1';

/** A Gen account that is an admin: its email is on settings.dashboard.googleEmails and it signed in with Google. */
export function isGenAdmin(user: Pick<UserRow, 'id' | 'email'>): boolean {
  if (!loadSettings().dashboard.googleEmails.includes(user.email.toLowerCase())) return false;
  return Boolean(db.prepare('SELECT 1 FROM user_google WHERE user_id = ?').get(user.id));
}

export function googleSignin(who: { sub: string | null; email: string; name: string | null }, ip?: string | null, opts: { loadTest?: boolean } = {}) {
  if (!who.sub) throw new GenError('That Google sign-in has no account id. Try again.', { status: 401 });
  const email = who.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new GenError('That Google account has no usable email');
  const bySub = db.prepare('SELECT user_id FROM user_google WHERE sub = ?').get(who.sub) as { user_id: string } | undefined;
  let user = bySub ? getUserById(bySub.user_id) : getUserByEmail(email);
  if (user && !bySub) db.prepare('INSERT OR IGNORE INTO user_google (user_id, sub, linked) VALUES (?, ?, ?)').run(user.id, who.sub, Date.now());
  if (!user) {
    // A new account: no password (an unusable hash), the starter credits, its own project and key, as signupUser does.
    // Over the per-address or daily cap (src/signupcap.ts) the account is made and signed in, without the starter grant.
    // A load-test account (the test sign-in on beta, project `load-*`, src/testsignin.ts) takes no starter grant and is not
    // counted against the per-address or daily caps, which stay as they are for everyone else.
    const asked = opts.loadTest ? 0 : starterCredits();
    const verdict = decideStarter(ip ?? null, asked);
    const starter = verdict.grant ? asked : 0;
    const made = signupUser({ email, password: crypto.randomBytes(24).toString('base64url'), name: who.name ?? undefined }, { starter });
    if (!opts.loadTest) recordSignup(ip ?? null, starter, verdict.grant ? null : verdict.reason);
    db.prepare("UPDATE users SET password_hash = 'google' WHERE id = ?").run(made.user.id);
    db.prepare('INSERT INTO user_google (user_id, sub, linked) VALUES (?, ?, ?)').run(made.user.id, who.sub, Date.now());
    return { user: made.user, sessionToken: made.sessionToken, created: true, notice: verdict.grant || asked <= 0 ? undefined : STARTER_REFUSED_MESSAGE };
  }
  const now = Date.now();
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now, user.id);
  user = getUserById(user.id)!;
  const session = createSession(user.id);
  return { user: toPublicUser(user), sessionToken: session.token, created: false, notice: undefined as string | undefined };
}

export function loginUser(input: { email?: unknown; password?: unknown }) {
  const email = String(input.email ?? '').trim().toLowerCase();
  const password = typeof input.password === 'string' ? input.password : '';
  if (!email || !password) throw new GenError('Email and password are required');

  const user = getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new GenError('Invalid email or password', { status: 401 });
  }

  const now = Date.now();
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now, user.id);
  user.last_login = now;
  const session = createSession(user.id);
  return { user: toPublicUser(user), sessionToken: session.token };
}

export function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;
  db.prepare('INSERT INTO user_sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now,
    expires,
  );
  return { token, expires };
}

export function deleteSession(token: string | null | undefined) {
  if (!token) return;
  db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(sha256(token));
}

export function rotateUserApiKey(userId: string) {
  const user = getUserById(userId);
  if (!user) throw new GenError('User not found', { status: 404 });
  db.exec('BEGIN');
  try {
    if (user.client_id) setClientDisabled(user.client_id, true);
    const minted = createClient(user.email, 'user', [user.project]);
    db.prepare('UPDATE users SET client_id = ? WHERE id = ?').run(minted.client.id, user.id);
    db.exec('COMMIT');
    return { apiKey: minted.key, prefix: minted.client.prefix, client: minted.client };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = String(req.headers.cookie ?? '');
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function getSessionToken(req: IncomingMessage): string | null {
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE] || null;
}

export function isPublicSaas(req?: IncomingMessage): boolean {
  if (env('HAWKESGEN_PUBLIC_SAAS') === '1') return true;
  if (req?.headers['x-hawkes-public-saas'] === '1') return true;
  return false;
}

function isSecureRequest(req: IncomingMessage): boolean {
  if (isPublicSaas(req)) return true;
  if (String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https') return true;
  if ((req.socket as any)?.encrypted) return true;
  return false;
}

export function setSessionCookie(res: ServerResponse, req: IncomingMessage, token: string) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

export function clearSessionCookie(res: ServerResponse, req: IncomingMessage) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

/**
 * Authenticates a request via `hg_session` cookie first, then falls back to `authenticate(req)` (API key or local owner).
 * When `isPublicSaas(req)` is true, anonymous requests without a session cookie or API key return `null`.
 */
export function authenticateRequest(req: IncomingMessage): AuthClient | null {
  const sessionToken = getSessionToken(req);
  if (sessionToken) {
    const row = db.prepare('SELECT user_id, expires FROM user_sessions WHERE token_hash = ?').get(sha256(sessionToken)) as
      | { user_id: string; expires: number }
      | undefined;
    if (row) {
      if (row.expires > Date.now()) {
        const user = getUserById(row.user_id);
        if (user && !isDisabled(user.id)) {
          // The admins (settings.dashboard.googleEmails: J) signed in with Google are Gen's owner too, so one sign-in
          // opens the app and /admin (J, 2026-10-29). A password account with the same email never is.
          if (isGenAdmin(user)) return { id: user.id, name: user.email, role: 'owner', projects: ['*'], userId: user.id };
          return {
            id: user.id,
            name: user.email,
            role: 'user',
            projects: [user.project],
            userId: user.id,
          };
        }
      } else {
        db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(sha256(sessionToken));
      }
    }
  }

  const authHeader = String(req.headers.authorization ?? '');
  // An editor signed in through OAuth (src/genoauth.ts): its hgm_ token is the Gen account that allowed it.
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (genOAuth.owns(bearerToken)) {
    const access = genOAuth.verify(bearerToken);
    const user = access && getUserById(access.userId);
    if (!user || isDisabled(user.id)) return null;
    if (isGenAdmin(user)) return { id: user.id, name: user.email, role: 'owner', projects: ['*'], userId: user.id };
    return { id: user.id, name: user.email, role: 'user', projects: [user.project], userId: user.id };
  }
  const hasApiKey =
    (authHeader.startsWith('Bearer ') && authHeader.slice(7).trim().length > 0) ||
    String(req.headers['x-hawkesgen-key'] ?? '').trim().length > 0;

  if (isPublicSaas(req) && !hasApiKey) {
    return null;
  }

  const client = authenticate(req);
  if (!client) return null;

  const user = getUserForClient(client);
  if (user && isDisabled(user.id)) return null;
  if (user) {
    return {
      ...client,
      role: 'user',
      projects: [user.project],
      userId: user.id,
    };
  }
  return client;
}

export function getUserProfile(client: AuthClient) {
  const user = getUserForClient(client);
  if (!user) throw new GenError('Not signed in as a user account', { status: 404 });
  const linkedClient = user.client_id ? getClient(user.client_id) : null;
  return {
    user: toPublicUser(user),
    client: linkedClient ? { id: linkedClient.id, prefix: linkedClient.prefix, role: linkedClient.role, projects: linkedClient.projects, created: linkedClient.created, last_used: linkedClient.last_used } : null,
  };
}
