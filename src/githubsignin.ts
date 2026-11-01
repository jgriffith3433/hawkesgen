// A GitHub Actions run of an allowed repository signed in as that repository's test account, on beta Gen only, with no
// shared secret (J, 2026-11-01: "no laptop steps"; the Unity plugin's smoke test signs in through Gen's real OAuth
// flow, which needs a signed-in browser session to press Allow).
//   POST /v1/users/test-session/github  { token }   token = the run's GitHub OIDC token, audience AUDIENCE
// GitHub signs who the run is (issuer token.actions.githubusercontent.com, RS256 with its published keys). Only a
// repository in REPOS (by GitHub's numeric id, which is never reused, not by its name) on a GitHub-hosted runner is
// taken, each token once, and it signs in only that repository's fixed test account (testAccountOf in testsignin.ts:
// playtest+<project>@playtest.hawkesgen.ai, never an admin: no Google id, not on the admin list). Off unless test
// sign-ins are on (testSignInOn: the beta lane, or a local copy that asks); live answers 404.

import crypto from 'node:crypto';
import { GenError } from './util.ts';
import { testSignInOn } from './testsignin.ts';

export const ISSUER = 'https://token.actions.githubusercontent.com';
export const AUDIENCE = 'hawkesgen-test-signin';
/** The repositories whose runs may sign in, by GitHub repository id, and the test project each signs in as. */
export const REPOS: Record<string, string> = {
  '1429202968': 'hawkesgen-unity', // jgriffith3433/hawkesgen-unity: the Unity plugin's smoke test
};

type Jwk = crypto.JsonWebKey & { kid?: string };
let cache: { at: number; keys: Jwk[] } = { at: 0, keys: [] };
let fetchKeys = async (): Promise<Jwk[]> => {
  const r = await fetch(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new GenError(`GitHub's signing keys answered HTTP ${r.status}`, { status: 503 });
  return ((await r.json()) as { keys?: Jwk[] }).keys ?? [];
};
/** Tests only: where the signing keys come from. */
export function setKeySource(fn: () => Promise<Jwk[]>) { fetchKeys = fn; cache = { at: 0, keys: [] }; }

async function keys(force = false) {
  if (!force && cache.keys.length && Date.now() - cache.at < 60 * 60_000) return cache.keys;
  cache = { at: Date.now(), keys: await fetchKeys() };
  return cache.keys;
}

const used = new Map<string, number>();
const refuse = (why: string) => new GenError(`Not a test sign-in: ${why}`, { status: 401 });
const part = (s: string) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };

/** The test project a valid token signs in as; throws (404 off, 401 anything else). */
export async function checkGitHubToken(token: unknown, now = Date.now()): Promise<string> {
  if (!testSignInOn()) throw new GenError('Test sign-ins are off here', { status: 404 });
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw refuse('not a token');
  const header = part(parts[0]), claims = part(parts[1]);
  if (!header || !claims) throw refuse('not a token');
  if (header.alg !== 'RS256') throw refuse('unexpected algorithm');
  let jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw refuse('unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw refuse('bad signature');
  const nowS = Math.floor(now / 1000);
  if (claims.iss !== ISSUER) throw refuse('wrong issuer');
  if (![claims.aud].flat().includes(AUDIENCE)) throw refuse('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp < nowS) throw refuse('expired');
  if (typeof claims.nbf === 'number' && claims.nbf > nowS + 30) throw refuse('not valid yet');
  const project = REPOS[String(claims.repository_id ?? '')];
  if (!project) throw refuse('this repository may not sign in');
  if (claims.runner_environment !== 'github-hosted') throw refuse('only GitHub-hosted runners');
  const id = String(claims.jti ?? '');
  if (!id) throw refuse('no token id');
  for (const [k, t] of used) if (t < nowS) used.delete(k);
  if (used.has(id)) throw refuse('that token was used already');
  used.set(id, claims.exp);
  return project;
}
