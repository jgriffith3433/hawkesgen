// Hawkes Studio's playtests signed in (J, 2026-10-30: Studio playing Gen's app as a project, where almost everything is
// behind Continue with Google). Studio posts a short-lived token signed with this project's test sign-in secret
// (hawkesstudio src/playtest-signin.ts):
//   POST /v1/users/test-session  { project, exp, nonce, sig }   sig = base64url HMAC-SHA256(secret, `${project}.${exp}.${nonce}`)
// On the beta lane only (or HAWKESGEN_TEST_SIGNIN=1 on a local copy), with the secret the owner set (PUT
// /v1/admin/test-signin), a valid, unexpired, unused token signs in the project's own test account,
// playtest+<project>@playtest.hawkesgen.ai (made the first time, like a Google sign-in), and answers with its session
// cookie. Never on live, never anyone else's account.
// No secret to copy (hawkesstudio playtest-signin.ts verifyViaIssuer): the token also names its `issuer`, and when the
// secret doesn't vouch for it Gen asks that Studio (POST <issuer>/api/signin/verify) whether it signed it. Only Studio
// origins on the trusted list are ever asked (`allowedIssuer`), never an address taken from the token as it is.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, env } from './config.ts';
import { directControlUrl } from './orgcredits.ts';
import { GenError } from './util.ts';

const FILE = () => path.join(DATA_DIR, 'test-signin.json');

/** Whether this Gen takes test sign-ins at all: its beta lane, or a local copy that asks for it. */
export const testSignInOn = () => env('HAWKESGEN_LANE') === 'beta' || env('HAWKESGEN_TEST_SIGNIN') === '1';

const secret = (): string | null => { try { return String(JSON.parse(fs.readFileSync(FILE(), 'utf8')).secret ?? '') || null; } catch { return null; } };

/** The owner sets (or clears) the secret Studio's project page shows. Only "set" and the last 4 come back. */
export function setTestSignInSecret(value: unknown) {
  const s = String(value ?? '').trim();
  if (s && !/^tss_[\w-]{20,}$/.test(s)) throw new GenError('That is not a Studio test sign-in secret (it starts with tss_)', { status: 400 });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (s) fs.writeFileSync(FILE(), JSON.stringify({ secret: s, at: Date.now() }), { mode: 0o600 });
  else fs.rmSync(FILE(), { force: true });
  return testSignInStatus();
}
export const testSignInStatus = () => { const s = secret(); return { on: testSignInOn(), set: Boolean(s), last4: s ? s.slice(-4) : null }; };

const used = new Map<string, number>();

/** The project a valid token is for; throws (401) for anything else. */
export function checkTestToken(b: any, now = Date.now()): string {
  if (!testSignInOn()) throw new GenError('Test sign-ins are off here', { status: 404 });
  const s = secret();
  if (!s) throw new GenError('No test sign-in secret is set on this Gen', { status: 503 });
  const project = String(b?.project ?? ''), exp = Number(b?.exp), nonce = String(b?.nonce ?? ''), sig = String(b?.sig ?? '');
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(project) || !/^[0-9a-f]{16,64}$/.test(nonce) || !Number.isFinite(exp)) throw new GenError('Not a test sign-in token', { status: 401 });
  const nowS = Math.floor(now / 1000);
  if (exp < nowS || exp > nowS + 600) throw new GenError('That test sign-in token has expired', { status: 401 });
  const want = Buffer.from(crypto.createHmac('sha256', s).update(`${project}.${exp}.${nonce}`).digest('base64url'));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new GenError('That test sign-in token is not signed with this Gen\'s secret', { status: 401 });
  for (const [k, t] of used) if (t < nowS) used.delete(k);
  if (used.has(nonce)) throw new GenError('That test sign-in token was used already', { status: 401 });
  used.set(nonce, exp);
  return project;
}

/** Studios whose playtest sign-in tokens Gen beta confirms with them (HAWKESGEN_SIGNIN_ISSUERS: comma-separated https origins, replaces these). */
export const DEFAULT_ISSUERS = ['https://studio.hawkesgen.ai', 'https://studio-beta.hawkesgen.ai'];
const issuerList = () => (env('HAWKESGEN_SIGNIN_ISSUERS') || '').split(',').map((s) => s.trim()).filter(Boolean);

/** A Studio address we may ask: a trusted origin, at its root or one customer cell (/o/<org>). Its base, or null. */
export function allowedIssuer(issuer: unknown, issuers: string[] = issuerList().length ? issuerList() : DEFAULT_ISSUERS): string | null {
  let u: URL;
  try { u = new URL(String(issuer)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  if (!issuers.some((o) => { try { return new URL(o).origin === u.origin; } catch { return false; } })) return null;
  if (!/^(\/|\/o\/[a-z0-9-]{1,60}\/?)$/.test(u.pathname)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Whether the secret itself signed this token (nothing is spent). */
const signedWithSecret = (b: any, s: string): boolean => {
  const want = Buffer.from(crypto.createHmac('sha256', s).update(`${b?.project}.${b?.exp}.${b?.nonce}`).digest('base64url'));
  const got = Buffer.from(String(b?.sig ?? ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};

/**
 * The route's check: the HMAC secret first (load harness, older setups; unchanged), else, for a token that names an
 * `issuer`, that Studio's own answer. A Studio-confirmed token never signs in a `load-*` account (those are the secret's).
 * `fetchImpl` is for tests.
 */
export async function checkTestTokenAny(b: any, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!testSignInOn()) throw new GenError('Test sign-ins are off here', { status: 404 });
  const hasIssuer = b?.issuer !== undefined && b?.issuer !== null && b?.issuer !== '';
  if (!hasIssuer) return checkTestToken(b, now);
  const s = secret();
  if (s && signedWithSecret(b, s)) return checkTestToken(b, now);
  const base = allowedIssuer(b.issuer);
  if (!base) throw new GenError('That test sign-in token comes from a Studio this Gen does not trust', { status: 401 });
  const project = String(b?.project ?? ''), exp = Number(b?.exp), nonce = String(b?.nonce ?? ''), sig = String(b?.sig ?? '');
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(project) || isLoadProject(project) || !/^[0-9a-f]{16,64}$/.test(nonce) || sig.length > 200 || !Number.isFinite(exp)) throw new GenError('Not a test sign-in token', { status: 401 });
  const nowS = Math.floor(now / 1000);
  if (exp < nowS || exp > nowS + 600) throw new GenError('That test sign-in token has expired', { status: 401 });
  if (used.has(nonce)) throw new GenError('That test sign-in token was used already', { status: 401 });
  // Server to server, straight to the Studio (never through the edge Worker), as Gen's other calls to it.
  const url = new URL(base); url.pathname = url.pathname.replace(/\/+$/, '') + '/api/signin/verify';
  if (url.pathname === '/api/signin/verify') { const d = new URL(directControlUrl(url.origin)); url.protocol = d.protocol; url.host = d.host; }
  let r: Response;
  try {
    r = await fetchImpl(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, exp, nonce, sig }), redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  } catch { throw new GenError('Could not reach the Studio that signed the token', { status: 401 }); }
  const j = r.ok ? await r.json().catch(() => null) as any : null;
  if (j?.ok !== true) throw new GenError('The Studio that signed the token did not confirm it', { status: 401 });
  for (const [k, t] of used) if (t < nowS) used.delete(k);
  used.set(nonce, exp);
  return project;
}

/** The project's test account, as a Google sign-in would make it. */
export const testAccountOf = (project: string) => ({ sub: `playtest:${project}`, email: `playtest+${project}@playtest.hawkesgen.ai`, name: `Playtest (${project})` });

/** Load-test accounts (tools/load/remote.mjs): project `load-*`. They skip the starter grant and the sign-up caps, and may be deleted by their own token. */
export const isLoadProject = (project: string) => /^load-[a-z0-9-]{1,32}$/.test(project);
