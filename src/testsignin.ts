// Hawkes Studio's playtests signed in (J, 2026-10-30: Studio playing Gen's app as a project, where almost everything is
// behind Continue with Google). Studio posts a short-lived token signed with this project's test sign-in secret
// (hawkesstudio src/playtest-signin.ts):
//   POST /v1/users/test-session  { project, exp, nonce, sig }   sig = base64url HMAC-SHA256(secret, `${project}.${exp}.${nonce}`)
// On the beta lane only (or HAWKESGEN_TEST_SIGNIN=1 on a local copy), with the secret the owner set (PUT
// /v1/admin/test-signin), a valid, unexpired, unused token signs in the project's own test account,
// playtest+<project>@playtest.hawkesgen.ai (made the first time, like a Google sign-in), and answers with its session
// cookie. Never on live, never anyone else's account.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, env } from './config.ts';
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

/** The project's test account, as a Google sign-in would make it. */
export const testAccountOf = (project: string) => ({ sub: `playtest:${project}`, email: `playtest+${project}@playtest.hawkesgen.ai`, name: `Playtest (${project})` });
