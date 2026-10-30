// The platform token (hawkesstudio docs/platform-plan.md 4.2): the portal (hawkesgames.com) is the account system, so Gen holds no
// customer accounts of its own for the platform. A customer's call carries a short-lived JWT the portal signed (EdDSA,
// Ed25519; minted at POST <portal>/v1/platform/token) instead of an hg_ key. Gen checks it against the portal's public
// keys (<portal>/.well-known/jwks.json, cached) and turns its claims into a Client: role user, the org's projects only.
//
// Projects: an org works in `org_<hex>` and `org_<hex>.<anything>` (a game, a product). A personal org also keeps its
// owner's older work in `usr_<hex>` (the project the portal has used for that account so far), so nothing they made
// before orgs disappears.
//
// Jobs: what an org may run is its token's scopes (playtest.* needs "playtest", unity.* "build", the rest "generate").
// Billing for jobs submitted straight to Gen with a token isn't connected yet (the portal's credits are per account, not
// per org): until it is, only orgs on settings.platform.freeOrgs (design partners, J's own) may submit; everyone else
// reads, and runs jobs through the portal as before.

import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { env, loadSettings } from './config.ts';
import { GenError } from './util.ts';

export type PlatformClaims = {
  iss: string; aud: string | string[]; org: string; user: string; project?: string; role: 'owner' | 'admin' | 'member' | 'viewer';
  plan: string; entitlements: Record<string, any>; scopes: string[]; exp: number; iat?: number; nbf?: number;
};
type Jwk = { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string };

const ORG_ID = /^org_[0-9a-f]{8,32}$/;
const ROLES = new Set(['owner', 'admin', 'member', 'viewer']);
export const SCOPE_OF_TOOL = (tool: string) => (tool.startsWith('playtest.') ? 'playtest' : tool.startsWith('unity.') ? 'build' : 'generate');

/** The portal this lane trusts: settings.platform.issuer, else hawkesgames.com (live) or beta.hawkesgames.com (beta; the
 *  portal was hawkesgen.ai before it moved, docs/domain-move.md in hawkesgenwebsite). */
export function issuer(): string {
  const s = loadSettings().platform.issuer;
  return (s || (env('HAWKESGEN_LANE') === 'beta' ? 'https://beta.hawkesgames.com' : 'https://hawkesgames.com')).replace(/\/+$/, '');
}

let keys: { iss: string; at: number; jwks: Jwk[] } | null = null;
let fetching: Promise<void> | null = null;
const FRESH_MS = 5 * 60_000;
const RETRY_MS = 30_000;

async function fetchKeys(iss: string) {
  try {
    const r = await fetch(`${iss}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { keys?: Jwk[] };
    keys = { iss, at: Date.now(), jwks: (j.keys ?? []).filter((k) => k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && typeof k.kid === 'string') };
  } catch (e) {
    console.error(`[platform] could not read ${iss}/.well-known/jwks.json: ${(e as Error).message}`);
    // Keep what we had; try again soon rather than on every request.
    keys = keys && keys.iss === iss ? { ...keys, at: Date.now() - FRESH_MS + RETRY_MS } : { iss, at: Date.now() - FRESH_MS + RETRY_MS, jwks: [] };
  }
}

/** A bearer that is a JWT (three base64url parts), else null. */
export function bearerJwt(req: IncomingMessage): string | null {
  const h = String(req.headers.authorization ?? '');
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(t) ? t : null;
}

/** Before authenticate() (which is synchronous): fetch the portal's keys when a token arrives and they're stale or don't
 *  have its key id (a rotated key), at most every 30 s. */
export async function primePlatform(req: IncomingMessage) {
  const t = bearerJwt(req);
  if (!t) return;
  const iss = issuer();
  let kid = '';
  try { kid = JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8')).kid ?? ''; } catch { return; }
  const stale = !keys || keys.iss !== iss || Date.now() - keys.at > FRESH_MS;
  const unknown = keys && !keys.jwks.some((k) => k.kid === kid) && Date.now() - keys.at > RETRY_MS;
  if (!stale && !unknown) return;
  fetching ??= fetchKeys(iss).finally(() => { fetching = null; });
  await fetching;
}

/** For tests: use these keys instead of fetching them. */
export function setPlatformKeys(jwks: Jwk[], iss = issuer()) {
  keys = { iss, at: Date.now(), jwks };
}

/** Checks a platform token: EdDSA with a key of the portal's, the issuer, audience "hawkesgen", the time. Throws why. */
export function verifyPlatformToken(token: string, now = Date.now()): PlatformClaims {
  const parts = token.split('.');
  let head: any, claims: any;
  try {
    head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('not a JWT');
  }
  if (head?.alg !== 'EdDSA') throw new Error('alg must be EdDSA');
  const iss = issuer();
  const jwk = keys?.iss === iss ? keys.jwks.find((k) => k.kid === head.kid) : undefined;
  if (!jwk) throw new Error('unknown key id');
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error('bad signature');
  const sec = Math.floor(now / 1000);
  if (claims.iss !== iss) throw new Error('wrong issuer');
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes('hawkesgen')) throw new Error('wrong audience');
  if (!(Number(claims.exp) > sec - 30)) throw new Error('expired');
  if (Number(claims.nbf ?? claims.iat ?? 0) > sec + 30) throw new Error('not yet valid');
  if (!ORG_ID.test(String(claims.org)) || !ROLES.has(claims.role) || !Array.isArray(claims.scopes) || typeof claims.user !== 'string') throw new Error('missing claims');
  return claims as PlatformClaims;
}

/** The projects an org's token may work in. */
export function orgProjects(c: Pick<PlatformClaims, 'org' | 'user' | 'project'>): string[] {
  const out = [c.org, `${c.org}.*`];
  // A personal org (org_<hex> of the account usr_<hex>) keeps the account's own project from before orgs.
  const hex = c.org.slice(4);
  if (c.project && /^[a-z][a-z0-9]{0,15}_[0-9a-f]{8,32}$/.test(c.project) && c.user.endsWith(`_${hex}`) && c.project.endsWith(`_${hex}`)) out.push(c.project);
  return out;
}

/** Whether a token's client may submit this tool now: its scope, and (until billing is connected) a free org. */
export function checkSubmit(c: { org?: string; scopes?: string[]; orgRole?: string }, tool: string) {
  if (!c.org) return;
  if (c.orgRole === 'viewer') throw new GenError('Viewers can look but not run jobs', { status: 403 });
  const need = SCOPE_OF_TOOL(tool);
  if (!c.scopes?.includes(need)) throw new GenError(`This token wasn't granted "${need}" (it has: ${(c.scopes ?? []).join(', ') || 'none'})`, { status: 403 });
  if (!loadSettings().platform.freeOrgs.includes(c.org)) {
    throw new GenError('Run jobs through hawkesgames.com for now: billing for jobs sent straight to Gen with a platform token is not connected yet', { status: 402 });
  }
}
