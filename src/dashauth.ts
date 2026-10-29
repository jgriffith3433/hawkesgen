// The dashboard's "Continue with Google" (J, 2026-10-28: "omg yes. google auth"): Google's sign-in button gives the
// page an ID token; Gen asks Google whether it is real and meant for settings.dashboard.googleClientId, and lets in the
// accounts in settings.dashboard.googleEmails as the owner. The session is a signed cookie (the email and an expiry,
// HMAC-SHA256 with a secret kept in .data/dashboard.key, which goes to the state bucket on Cloud Run), checked against
// the list on every request, so removing an email signs it out everywhere. The key sign-in (auth.ts KEY_COOKIE) stays.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, loadSettings } from './config.ts';

export const DASH_COOKIE = 'hg_dash';
export const DASH_DAYS = 30;

let secret: Buffer | null = null;
function key(): Buffer {
  if (secret) return secret;
  const file = path.join(DATA_DIR, 'dashboard.key');
  try { secret = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); } catch { /* not made yet */ }
  if (!secret || secret.length < 32) {
    secret = crypto.randomBytes(32);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
  }
  return secret;
}
/** Tests: forget the cached secret (a new data folder). */
export const resetDashKey = () => { secret = null; };

const mac = (payload: string) => crypto.createHmac('sha256', key()).update(payload).digest('base64url');

/** The emails let in, from settings (lower case). */
export const allowedEmails = () => loadSettings().dashboard.googleEmails;
/** The client id the sign-in button uses, or null while Google sign-in isn't set up (no client or no emails). */
export function googleClientId(): string | null {
  const d = loadSettings().dashboard;
  return d.googleClientId && d.googleEmails.length ? d.googleClientId : null;
}

/** A session cookie's value for this email. */
export function signSession(email: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ e: email.toLowerCase(), x: now + DASH_DAYS * 86_400_000 })).toString('base64url');
  return `${payload}.${mac(payload)}`;
}

/** The email a session cookie is for, or null: a bad signature, an expired one, or an email no longer on the list. */
export function sessionEmail(value: string, now = Date.now()): string | null {
  const [payload, sig] = String(value ?? '').split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof e !== 'string' || typeof x !== 'number' || x < now) return null;
    return allowedEmails().includes(e) ? e : null;
  } catch { return null; }
}

/** The client id Gen's Google sign-in uses for anyone (the app's customer accounts), or null when none is set. */
export const googleClientIdAny = (): string | null => loadSettings().dashboard.googleClientId || null;

export type GoogleIdentity = { sub: string | null; email: string; name: string | null };

/**
 * Checks a Google ID token with Google (the tokeninfo endpoint: signature, expiry) and that it was issued for our
 * client to a verified email. Returns who it is (Google's permanent account id `sub` when it has one, the email, the
 * name); throws a
 * sentence otherwise. `fetchImpl` is for tests.
 */
export async function checkGoogleToken(credential: string, fetchImpl: typeof fetch = fetch): Promise<GoogleIdentity> {
  const clientId = googleClientIdAny();
  if (!clientId) throw new Error('Google sign-in is not set up on this Gen.');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(credential ?? ''))) throw new Error('That is not a Google sign-in.');
  const r = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error('Google did not accept that sign-in. Try again.');
  const t = await r.json() as { aud?: string; iss?: string; sub?: string; email?: string; email_verified?: string | boolean; exp?: string; name?: string };
  if (t.aud !== clientId) throw new Error('That sign-in was made for another app.');
  if (t.iss !== 'accounts.google.com' && t.iss !== 'https://accounts.google.com') throw new Error('That sign-in did not come from Google.');
  if (Number(t.exp) * 1000 < Date.now()) throw new Error('That sign-in has expired. Try again.');
  const email = String(t.email ?? '').toLowerCase();
  if (!(t.email_verified === true || t.email_verified === 'true') || !email) throw new Error('That Google account has no verified email.');
  return { sub: /^\d{5,40}$/.test(String(t.sub ?? '')) ? String(t.sub) : null, email, name: t.name ? String(t.name).slice(0, 120) : null };
}

/** The admin dashboard's Google sign-in: a checked token whose email is on settings.dashboard.googleEmails. */
export async function verifyGoogle(credential: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!googleClientId()) throw new Error('Google sign-in is not set up on this Gen.');
  const { email } = await checkGoogleToken(credential, fetchImpl);
  if (!allowedEmails().includes(email)) throw new Error(`${email} is not allowed into this Gen.`);
  return email;
}
