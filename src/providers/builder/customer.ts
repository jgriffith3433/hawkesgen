import crypto from 'node:crypto';
// Customer mode of the Unity cloud build (docs/unity-cloudrun.md, "Customer mode"; hawkesstudio docs/builds.md, "unity ->
// Hawkes Gen"): a customer's Studio (a Gen key with role "user") builds ITS OWN Unity project from GitHub on Gen's Cloud
// Run build job and gets the output back as a library asset (a .tar.gz of the build folder).
//
//   params: { github: { repo, commit, token, ref?, refresh?: { url, build, key } }, path?, method?, target: "web", out: "artifact" }
//
// The token is a short-lived GitHub installation token that Studio passes per job. It is moved into the in-memory token
// vault at submit (src/providers/playtester/intake.ts holdToken: the job's params keep only its tok_ reference; the vault
// is memory backed by an encrypted row, so a restarted Gen still has it), read once when the build starts (a missing or
// expired one fails the job at once, before any Unity time: kind 'token', Studio resubmits with a fresh one), handed to that one Cloud Run execution as an env override (HAWKES_GITHUB_TOKEN), and used
// there only as an http.extraheader for the fetch. It is never in the stored params, spec.json, the log, the library
// recipe or any row. Gen's own GitHub secret is never used for a customer: the container unsets it in this mode.
//
// Isolation (docs/unity-cloudrun.md, "Customer mode"): the customer's editor scripts run inside Unity, so a customer build
// runs only on its own Cloud Run job (settings.unityBuild.gcp.customerJob; other versions: "<job>-customer"), whose
// service account (unity-customer@<project>) has no role on any bucket. Gen checks that job before each build (it
// exists, runs as that account, mounts no secret but UNITY_*), and everything the container reads or writes in the
// bucket goes through V4 signed URLs Gen makes for that one execution (env HAWKES_SIGNED): the spec, that customer's
// own Library cache, and the job's own output, log and result. Nothing else.
//
// Before anything is started, Gen asks GitHub (with that token) where the Unity project is and which Unity it uses; a
// version Gen has no image for fails at once (kind 'config'), naming the project's version and the supported ones.

import { GenError } from '../../util.ts';
import { holdToken, lookupToken, replaceToken, dropToken, publicUrl, checkPublicUrl, type TokenLookup } from '../playtester/intake.ts';
import { cacheName } from './cache.ts';
import { gapi, type CloudRunTarget } from './gcp.ts';
import { resolveMachine, storedMachine, type MachineSizes } from './sizes.ts';
import { loadSettings } from '../../config.ts';

const bad = (message: string, kind = 'params') => new GenError(message, { status: 400, kind });
const config = (message: string) => new GenError(message, { status: 400, kind: 'config' });

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
/** A GitHub token: installation tokens (ghs_), user-to-server (ghu_), classic and fine-grained PATs. Only the prefix,
 *  a sane length and no spaces or quotes are checked: GitHub's newer installation tokens are 380+ characters with more
 *  than letters and digits (a customer Studio's real one was refused twice, 2026-10-31); GitHub decides if it's valid. */
export const TOKEN_RE = /^(gh[pousr]_|github_pat_)[A-Za-z0-9_.=+/-]{20,1024}$/;
const TOKEN_REF_RE = /^tok_[0-9a-f]{24}$/;
const PATH_RE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9 _.\/-]{1,200}$/;
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const REFRESH_BUILD_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const REFRESH_KEY_RE = /^[0-9a-f]{64}$/;

/** The build method the container adds when none is given (server/unity-cloudrun/HawkesBuild.cs). */
export const DEFAULT_METHOD = 'HawkesGenCloud.HawkesBuild.Build';

/** A customer build as the job keeps it: no token, its vault reference. */
export type CustomerBuild = {
  repo: string;
  commit: string;
  ref: string | null;
  /** The Unity project folder in the repo ("." the root); null: found at run time (the folder with ProjectSettings/ProjectVersion.txt). */
  path: string | null;
  /** -executeMethod; null: Gen's own HawkesBuild.Build (every enabled scene to WebGL). */
  method: string | null;
  tokenRef: string;
  /** Where Gen asks for a fresh token just before the fetch (Studio's gen-token); the key is held in the vault, never here. */
  refresh: { url: string; build: string; keyRef: string } | null;
  /** A compile-only check (check.ts): Unity imports and compiles, nothing is built or kept. */
  check: boolean;
  /** The machine size asked for (sizes.ts): a size name, { cpu, memoryGiB }, or null for settings' customerSize. */
  machine: string | { cpu: number; memoryGiB: number } | null;
};

/** Whether `out` is what a compile-only check takes: absent or "none" (it makes no artifact). */
const noOut = (out: unknown) => out === undefined || out === null || out === '' || out === 'none';

/** Whether unity.build params ask for customer mode: a GitHub token (or, stored, its reference) and out "artifact", or
 *  `check` (with out absent or "none"). A `check` of any type counts, so a wrong one is refused by admit, not as a stranger's. */
export function isCustomerMode(params: Record<string, any> | undefined): boolean {
  if (!params) return false;
  const asksCheck = params.check !== undefined && params.check !== null;
  if (!(params.out === 'artifact' || (asksCheck && noOut(params.out)))) return false;
  let g = params.github;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { return false; } }
  if (!g || typeof g !== 'object' || Array.isArray(g)) return false;
  return (typeof g.token === 'string' && g.token.trim() !== '') || (typeof g.tokenRef === 'string' && TOKEN_REF_RE.test(g.tokenRef));
}

/** The target a customer build makes: "web" (or WebGL); anything else fails with kind 'config'. */
export function customerTarget(target: unknown): 'WebGL' {
  const t = target === undefined || target === null || target === '' ? 'web' : String(target);
  if (t === 'web' || t === 'WebGL') return 'WebGL';
  throw config(`target "${t}" can't be built in the cloud: the build image makes WebGL only (target "web").`);
}

/**
 * Checks customer-mode params at submit and moves the token into the vault. Returns the params to store: github has
 * tokenRef in place of token; siteRepo, branch, site, projectDir, siteDir and the rest of J's mode are refused.
 */
export function admitCustomer(params: Record<string, any>, hold: (token: string) => string = holdToken, gcp: { sizes: MachineSizes; customerSize: string; checkSize?: string } = loadSettings().unityBuild.gcp): Record<string, any> {
  const p = { ...params };
  // check: a compile-only run (check.ts). A boolean only; it builds nothing, so no out, no method.
  if (p.check !== undefined && p.check !== null && typeof p.check !== 'boolean') throw bad('check must be true or false (a compile-only run: Unity imports and compiles the project, nothing is built)');
  const check = p.check === true;
  if (check) {
    if (p.out !== undefined && !noOut(p.out)) throw bad('a check builds nothing, so it takes no out "artifact": leave out unset (or "none")');
    if (p.method) throw bad("a check runs no build method: leave method out (it only imports and compiles the project)");
  } else if (p.out !== 'artifact') throw bad('customer builds take out "artifact" (or check: true for a compile-only run)');
  let g = p.github;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { throw bad('github must be an object: { repo, commit, token, ref? }'); } }
  if (!g || typeof g !== 'object' || Array.isArray(g)) throw bad('github must be an object: { repo, commit, token, ref? }');
  const extra = Object.keys(g).filter((k) => !['repo', 'commit', 'token', 'ref', 'refresh'].includes(k));
  if (extra.length) throw bad(`customer builds take github { repo, commit, token, ref?, refresh? } (not ${extra.join(', ')}): the output comes back as an asset, nothing is pushed`);
  for (const k of ['site', 'projectDir', 'siteDir', 'cache', 'backend', 'args']) {
    if (p[k] !== undefined && p[k] !== null && p[k] !== '' && !(k === 'backend' && (p[k] === 'auto' || p[k] === 'cloudrun'))) throw bad(`${k} isn't for customer builds (github with a token, out "artifact")`);
  }
  const repo = String(g.repo ?? '').trim();
  const commit = String(g.commit ?? '').trim().toLowerCase();
  const token = String(g.token ?? '').trim();
  if (!SLUG_RE.test(repo)) throw bad(`github.repo must be "owner/name" (got "${repo.slice(0, 100)}")`);
  if (!SHA_RE.test(commit)) throw bad('github.commit must be the full commit sha, 40 hex characters');
  // Never echo the token back, even a malformed one.
  if (!TOKEN_RE.test(token)) throw bad(`github.token must be a GitHub token (a short-lived installation token, ghs_…); got ${token.length} characters starting "${/^[a-z_]{1,4}/.exec(token)?.[0] ?? ''}"`);
  const ref = g.ref === undefined || g.ref === null || g.ref === '' ? null : String(g.ref).trim();
  if (ref !== null && !REF_RE.test(ref)) throw bad(`github.ref "${ref.slice(0, 120)}" has characters a ref can't`);
  // refresh: where Gen asks for a fresh token right before the fetch. The key opens one build's one repo; it is held like
  // the token and never stored with the job.
  let refresh: { url: string; build: string; key: string } | null = null;
  if (g.refresh !== undefined && g.refresh !== null) {
    const r = g.refresh;
    if (typeof r !== 'object' || Array.isArray(r)) throw bad('github.refresh must be { url, build, key }');
    const url = String(r.url ?? '').trim();
    const build = String(r.build ?? '').trim();
    const key = String(r.key ?? '').trim();
    let u: URL;
    try { u = checkPublicUrl(url); } catch (e: any) { throw bad(`github.refresh.url ${e.message}`); }
    if (u.protocol !== 'https:') throw bad('github.refresh.url must be https');
    if (!REFRESH_BUILD_RE.test(build)) throw bad('github.refresh.build must be the build id (letters, digits, - _ .)');
    if (!REFRESH_KEY_RE.test(key)) throw bad('github.refresh.key must be the 64-character key Studio made for this build');
    refresh = { url: u.toString(), build, key };
  }
  const path = p.path === undefined || p.path === null || p.path === '' ? null : normalPath(String(p.path));
  const method = p.method ? String(p.method).trim() : null;
  if (method !== null && !METHOD_RE.test(method)) throw bad(`method must be a static method's full name, Namespace.Class.Method (got "${method.slice(0, 120)}")`);
  customerTarget(p.target);
  const env = p.env && typeof p.env === 'object' && !Array.isArray(p.env) ? p.env : null;
  if (env) for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || /^(HAWKES_|UNITY_|GITHUB_|R2_|GCS_|GOOGLE_|CLOUD_RUN|LD_|BASH|ENV$|PATH$|HOME$)/.test(k)) throw bad(`env ${k}: a plain name that isn't one of the build's own (HAWKES_, UNITY_, GITHUB_, ...)`);
    if (typeof v !== 'string' || v.length > 1000) throw bad(`env ${k} must be a string (at most 1000 characters)`);
    // No control characters: the container reads env NUL-separated, but a newline or NUL is never a real setting.
    if (/[\u0000-\u001f\u007f]/.test(v)) throw bad(`env ${k} has a control character (a newline?): one plain line only`);
  }
  if (Object.keys(env ?? {}).length > 32) throw bad('env takes at most 32 variables');
  const stored: Record<string, unknown> = { repo, commit, tokenRef: hold(token) };
  if (ref) stored.ref = ref;
  if (refresh) stored.refresh = { url: refresh.url, build: refresh.build, keyRef: hold(refresh.key) };
  p.github = stored;
  p.target = 'web';
  if (check) { p.check = true; p.out = 'none'; } else { delete p.check; p.out = 'artifact'; }
  if (path) p.path = path; else delete p.path;
  if (method) p.method = method; else delete p.method;
  if (!env || !Object.keys(env).length) delete p.env;
  // The machine size (sizes.ts): checked here, stored as its name (or { cpu, memoryGiB }); absent: settings' default.
  if (p.machine === undefined || p.machine === null || p.machine === '') delete p.machine;
  else p.machine = storedMachine(resolveMachine(p.machine, { sizes: gcp.sizes, customerSize: check ? gcp.checkSize ?? gcp.customerSize : gcp.customerSize }), gcp.sizes);
  for (const k of ['site', 'projectDir', 'siteDir', 'cache', 'args', 'clean', 'project']) delete p[k];
  // Always Cloud Run (the queue's builder-cloud lane): never the build server or a project's VM.
  p.backend = 'cloudrun';
  return p;
}

/** "Game/", "./Game" -> "Game"; "." stays "." (the repo root). */
export function normalPath(raw: string): string {
  const s = raw.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (s === '' || s === '.') return '.';
  if (!PATH_RE.test(s)) throw bad(`path must be a plain folder in the repo (got "${raw.slice(0, 200)}")`);
  return s;
}

/** The stored params back as a CustomerBuild (the run reads only these). */
export function customerBuildOf(params: Record<string, any>): CustomerBuild {
  const g = params.github ?? {};
  const repo = String(g.repo ?? '');
  const commit = String(g.commit ?? '');
  if (!SLUG_RE.test(repo) || !SHA_RE.test(commit)) throw bad('github.repo and github.commit are needed');
  if (!TOKEN_REF_RE.test(String(g.tokenRef ?? ''))) throw bad('this customer build has no token (submit it again with github.token)');
  return {
    repo, commit, ref: g.ref ? String(g.ref) : null, tokenRef: String(g.tokenRef), check: params.check === true,
    refresh: g.refresh && typeof g.refresh === 'object' && g.refresh.url && TOKEN_REF_RE.test(String(g.refresh.keyRef ?? '')) ? { url: String(g.refresh.url), build: String(g.refresh.build ?? ''), keyRef: String(g.refresh.keyRef) } : null,
    path: params.path ? normalPath(String(params.path)) : null, method: params.method ? String(params.method) : null,
    machine: params.machine === undefined || params.machine === null || params.machine === '' ? null : params.machine,
  };
}

/** The kind a failure carries when Studio must send a fresh GitHub token (the build never started: nothing was spent). */
export const TOKEN_KIND = 'token';

/**
 * A token older than this starts no new build. GitHub's installation tokens last an hour and a build fetches its source
 * some minutes after it starts (a queue wait, the machine, the image), so one held 45 minutes would die at the fetch,
 * after Cloud Run time was spent; the vault keeps tokens 12 hours (intake.ts) only so a restarted Gen still has them.
 */
export const TOKEN_MAX_AGE_SECONDS = 45 * 60;

/**
 * The token behind a customer build: memory first, then the encrypted store (so a recycled Gen instance doesn't lose
 * it). Missing or expired: a 'token' failure at once, before any Unity time is spent, saying which it was and that
 * Studio should resubmit with a fresh token (installation tokens last an hour, so a long queue can outlive one). The
 * log line says whether it came from memory, came back from the store after a restart, expired, or was never found.
 */
export function customerToken(b: CustomerBuild, lookup: (ref: string) => TokenLookup | string | null = lookupToken, log: (m: string) => void = console.log): string {
  const raw = lookup(b.tokenRef);
  const r: TokenLookup = typeof raw === 'string' ? { token: raw, ageSeconds: 0, from: 'memory' } : raw ?? { token: null, why: 'missing' };
  if (r.token !== null && r.ageSeconds > TOKEN_MAX_AGE_SECONDS) {
    log(`customer build token: ${Math.round(r.ageSeconds / 60)} min old (GitHub's last an hour, a build needs it at its start); asking Studio for a fresh one`);
    throw new GenError(
      `The GitHub token for this build is ${Math.round(r.ageSeconds / 60)} minutes old, too old to start a build with (GitHub's installation tokens last an hour and the build fetches its source after it starts). Nothing was built: resubmit it with a fresh token.`,
      { status: 400, kind: TOKEN_KIND });
  }
  if (r.token !== null) {
    log(`customer build token: ${r.from === 'store' ? 'restored from the encrypted store (Gen restarted since submit)' : 'found in memory'}, ${r.ageSeconds}s since submit`);
    return r.token;
  }
  const age = r.ageSeconds !== undefined ? ` (held ${Math.round(r.ageSeconds / 60)} min)` : '';
  log(r.why === 'expired'
    ? `customer build token: expired${age}; asking Studio for a fresh one`
    : 'customer build token: not found in memory or the store (dropped, never held, or Gen restarted with no secrets key); asking Studio for a fresh one');
  throw new GenError(
    r.why === 'expired'
      ? `The GitHub token for this build expired${age} before the build could start. Nothing was built: resubmit it with a fresh token.`
      : 'Hawkes Gen no longer has the GitHub token for this build (it was dropped, or Gen restarted and could not restore it). Nothing was built: resubmit it with a fresh token.',
    { status: 400, kind: TOKEN_KIND });
}

/** Forgets the refresh key and the token a customer build held (memory and store). */
export function dropCustomerSecrets(b: Pick<CustomerBuild, 'tokenRef' | 'refresh'>) {
  dropToken(b.tokenRef);
  if (b.refresh) dropToken(b.refresh.keyRef);
}

type Post = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<Response>;

/**
 * Asks Studio for a fresh GitHub token for this build (github.refresh): POST { job, build, key } to the url, get
 * { token, repo, commit, expiresAt }. The answer must be for this build's own repo and commit. The new token replaces the
 * held one (same reference), so a later step reads it from the vault. Any failure is kind 'token': nothing was built.
 * Neither the key nor a token is ever logged or put in a message.
 */
export async function refreshCustomerToken(b: CustomerBuild, jobId: string, o: { post?: Post; resolve?: typeof publicUrl; log?: (m: string) => void; now?: number } = {}): Promise<string> {
  const log = o.log ?? console.log;
  const r = b.refresh;
  const fail = (why: string): never => { throw new GenError(`Hawkes Gen could not get a fresh GitHub token for this build from Studio (${why}). Nothing was built.`, { status: 400, kind: TOKEN_KIND }); };
  if (!r) return fail('this build has no way to ask');
  const key = lookupToken(r.keyRef).token;
  if (!key) return fail('the key for it was dropped, or Gen restarted and could not restore it');
  let res: Response;
  try {
    await (o.resolve ?? publicUrl)(r.url);
    res = await (o.post ?? ((url, init) => fetch(url, init)))(r.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'hawkesgen-unity-build' },
      body: JSON.stringify({ job: jobId, build: r.build, key }), signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
  } catch (e: any) {
    return fail(`it did not answer: ${String(e?.message ?? e).replace(key, '…').slice(0, 120)}`);
  }
  if (!res.ok) return fail(`it answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { token?: unknown; repo?: unknown; commit?: unknown; expiresAt?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!TOKEN_RE.test(token)) return fail('its answer had no usable token');
  if (body?.repo !== undefined && String(body.repo).toLowerCase() !== b.repo.toLowerCase()) return fail('its token is for another repo');
  if (body?.commit !== undefined && String(body.commit).toLowerCase() !== b.commit) return fail('its token is for another commit');
  const exp = body?.expiresAt !== undefined ? Date.parse(String(body.expiresAt)) : NaN;
  if (Number.isFinite(exp) && exp < (o.now ?? Date.now()) + 2 * 60_000) return fail('its token is about to expire');
  replaceToken(b.tokenRef, token);
  log(`customer build token: a fresh one from Studio${Number.isFinite(exp) ? `, good for ${Math.round((exp - (o.now ?? Date.now())) / 60_000)} min` : ''}`);
  return token;
}

/**
 * The token to start a build with. With github.refresh, a held token that is too old, missing or expired is replaced by
 * a fresh one from Studio (queue time no longer matters); `force` asks again whatever the held one says (GitHub gave a
 * 401). Without refresh this is customerToken. Only a failed refresh fails the build with kind 'token'.
 */
export async function freshCustomerToken(b: CustomerBuild, jobId: string, o: { force?: boolean; lookup?: Parameters<typeof customerToken>[1]; log?: (m: string) => void; post?: Post; resolve?: typeof publicUrl } = {}): Promise<string> {
  const log = o.log ?? console.log;
  if (!b.refresh) return customerToken(b, o.lookup, log);
  if (!o.force) {
    try { return customerToken(b, o.lookup, log); } catch (e: any) { if (e?.kind !== TOKEN_KIND) throw e; }
  } else log('customer build token: GitHub refused it (401); asking Studio for a fresh one');
  return refreshCustomerToken(b, jobId, { log, post: o.post, resolve: o.resolve });
}

// ------------------------------------------------------------------ images by Unity version

/** The Unity versions Gen can build, each with the Cloud Run job that runs its image (settings.unityBuild.gcp.images). */
export function unityImages(gcp: { unity: string; job: string; images?: Record<string, string> }): Record<string, string> {
  const own = gcp.images && Object.keys(gcp.images).length ? gcp.images : {};
  return Object.keys(own).length ? own : { [gcp.unity]: gcp.job };
}

/** The Cloud Run job for a Unity version, or a 'config' failure naming the version and the supported ones. */
export function jobForVersion(version: string, images: Record<string, string>): string {
  const job = images[version];
  if (job) return job;
  const supported = Object.keys(images).sort();
  throw config(`This project uses Unity ${version}, which Hawkes Gen has no build image for. Supported: ${supported.join(', ') || 'none'}. Change the project's Unity version to one of those, or ask for ${version} to be added.`);
}

/** m_EditorVersion from a ProjectVersion.txt. */
export function editorVersionOf(text: string): string | null {
  return /^m_EditorVersion:\s*(\S+)/m.exec(text)?.[1] ?? null;
}

// ------------------------------------------------------------------ asking GitHub first

type Fetch = typeof fetch;
const API = 'https://api.github.com';
const PV = 'ProjectSettings/ProjectVersion.txt';

function ghHeaders(token: string, raw = false) {
  return { Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hawkesgen-unity-build', Authorization: `Bearer ${token}` };
}

async function ghFail(r: Response, what: string): Promise<never> {
  // 401: GitHub no longer takes the token (an installation token lasts an hour): Studio sends a fresh one.
  if (r.status === 401) throw new GenError(`GitHub refused ${what} (401): the token has expired or was revoked. Nothing was built: resubmit it with a fresh token.`, { status: 400, kind: TOKEN_KIND });
  if (r.status === 403) throw new GenError(`GitHub refused ${what} (${r.status}): the token can't read the repo`, { status: 400, kind: 'source' });
  if (r.status === 404 || r.status === 422) throw new GenError(`GitHub has no ${what} (${r.status}): is the commit pushed, and can the token read the repo?`, { status: 400, kind: 'source' });
  throw new GenError(`GitHub answered ${r.status} for ${what}`, { status: 502, kind: 'source' });
}

/** Folders that are never a project of their own (Unity's, packages' samples, dependencies). */
const SKIP_RE = /(^|\/)(Library|Temp|Logs|node_modules|Packages|PackageCache|\.git)\//;

/** The project folder in a repo tree: the shallowest folder holding ProjectSettings/ProjectVersion.txt. */
export function projectPathIn(paths: string[]): string | null {
  const found = paths.filter((p) => (p === PV || p.endsWith(`/${PV}`)) && !SKIP_RE.test(p)).map((p) => (p === PV ? '.' : p.slice(0, -PV.length - 1)));
  found.sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.split('/').length - b.split('/').length || a.localeCompare(b)));
  return found[0] ?? null;
}

/**
 * Where the Unity project is at that commit and which Unity it uses, read from GitHub with the customer's token (never
 * logged). `path` given: that folder's ProjectVersion.txt; else the repo tree is searched for it.
 */
export async function probeProject(b: { repo: string; commit: string; path: string | null }, token: string, f: Fetch = fetch): Promise<{ path: string; version: string }> {
  let folder = b.path;
  if (!folder) {
    const r = await f(`${API}/repos/${b.repo}/git/trees/${b.commit}?recursive=1`, { headers: ghHeaders(token) });
    if (!r.ok) await ghFail(r, `the tree of ${b.repo} at ${b.commit.slice(0, 12)}`);
    const tree = (await r.json()) as { tree?: { path: string; type: string }[]; truncated?: boolean };
    folder = projectPathIn((tree.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path));
    if (!folder) {
      throw config(tree.truncated
        ? `${b.repo} is too big to search for the Unity project: set path (the folder with ProjectSettings/ProjectVersion.txt).`
        : `${b.repo} at ${b.commit.slice(0, 12)} has no Unity project (no ProjectSettings/ProjectVersion.txt).`);
    }
  }
  const file = folder === '.' ? PV : `${folder}/${PV}`;
  const r = await f(`${API}/repos/${b.repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${b.commit}`, { headers: ghHeaders(token, true) });
  if (r.status === 404) throw config(`${b.repo} at ${b.commit.slice(0, 12)} has no ${file}: path "${folder}" isn't a Unity project.`);
  if (!r.ok) await ghFail(r, file);
  const text = await r.text();
  const version = editorVersionOf(text.startsWith('{') ? safeContent(text) : text);
  if (!version) throw config(`${file} in ${b.repo} doesn't name a Unity version (m_EditorVersion).`);
  return { path: folder, version };
}

/** The contents API's JSON form (when the raw Accept is ignored): base64 content. */
function safeContent(text: string): string {
  try { const j = JSON.parse(text); return j.content ? Buffer.from(String(j.content), 'base64').toString('utf8') : ''; } catch { return text; }
}

/** The Library cache of a customer's project: its own per Gen project and repo, never shared with J's or another's. */
export function customerCacheRepo(owner: string, repo: string, path: string) {
  // The full name hashed onto a readable prefix: names were cut to 64 characters, so two projects of one customer could
  // share (and overwrite) one Library cache (2026-10-31 review).
  const full = `cust--${owner}--${repo.replace('/', '--')}${path && path !== '.' ? `--${path}` : ''}`;
  return cacheName(`${cacheName(full).slice(0, 52)}-${crypto.createHash('sha256').update(full).digest('hex').slice(0, 10)}`);
}


// ------------------------------------------------------------------ isolation: the customer job and signed URLs

/** The service account customer builds run as: no role on any bucket, no other grant (customer-setup.mjs makes it). */
export const CUSTOMER_SA = 'unity-customer';
export const customerServiceAccount = (project: string) => `${CUSTOMER_SA}@${project}.iam.gserviceaccount.com`;
const SETUP = 'node tools/unity-cloudrun/customer-setup.mjs --apply';

type JobsConfig = { job: string; images?: Record<string, string>; customerJob: string };

/** Customer builds are on only when settings.unityBuild.gcp.customerJob names their job; else a 'config' failure. */
export function assertCustomerBuildsOn(gcp: JobsConfig) {
  if (!gcp.customerJob) {
    throw config(`Customer builds are off: they run only on their own Cloud Run job, whose service account can't reach Hawkes Gen's bucket, and settings.unityBuild.gcp.customerJob is empty. Make the job with ${SETUP} (docs/unity-cloudrun.md, "Customer mode"), then set customerJob.`);
  }
}

/**
 * The customer twin of one of J's build jobs: `customerJob` for `job` itself, "<job>-customer" for another version's
 * job (one settings line per version stays one line). Never one of J's own jobs.
 */
export function customerJobFor(job: string, gcp: JobsConfig): string {
  assertCustomerBuildsOn(gcp);
  const twin = job === gcp.job ? gcp.customerJob : `${job}-customer`;
  const own = new Set([gcp.job, ...Object.values(gcp.images ?? {})]);
  if (own.has(twin)) throw config(`The customer job "${twin}" is one of Hawkes Gen's own build jobs: customer builds need their own (${SETUP}).`);
  return twin;
}

const jobChecks = new Map<string, number>();
/** Tests: check the job again on the next build. */
export function forgetCustomerJobChecks() { jobChecks.clear(); }

/**
 * Checks the customer job before a build is started on it (remembered 10 minutes): it exists, runs as unity-customer,
 * sets HAWKES_CUSTOMER_JOB=1 (the container then reaches the bucket only through signed URLs), and hands the build no
 * secret but the Unity license (UNITY_EMAIL, UNITY_PASSWORD, UNITY_SERIAL). Anything else: 'config', run the setup.
 */
export async function checkCustomerJob(t: CloudRunTarget, get: (url: string) => Promise<any> = (url) => gapi(url, { missingOk: true })) {
  const key = `${t.project}/${t.region}/${t.job}`;
  if ((jobChecks.get(key) ?? 0) > Date.now()) return;
  const j = await get(`https://run.googleapis.com/v2/projects/${t.project}/locations/${t.region}/jobs/${t.job}`);
  if (!j) throw config(`Customer builds run only on their own Cloud Run job, and ${t.job} isn't there (${t.project}, ${t.region}). Make it: ${SETUP} (docs/unity-cloudrun.md, "Customer mode").`);
  const tpl = j.template?.template ?? {};
  const sa = String(tpl.serviceAccount ?? '');
  const want = customerServiceAccount(t.project);
  if (sa !== want) throw config(`The Cloud Run job ${t.job} runs as ${sa || 'the default compute account'}, not ${want} (the account with no access to anything), so no customer build runs on it. Run ${SETUP} again.`);
  const containers = (tpl.containers ?? []) as { env?: { name: string; value?: string; valueSource?: { secretKeyRef?: unknown } }[] }[];
  const env = containers.flatMap((c) => c.env ?? []);
  const extra = env.filter((e) => e.valueSource?.secretKeyRef && !/^UNITY_(EMAIL|PASSWORD|SERIAL)$/.test(e.name)).map((e) => e.name);
  const volumes = ((tpl.volumes ?? []) as { name: string; secret?: unknown }[]).filter((v) => v.secret).map((v) => v.name);
  if (extra.length || volumes.length) throw config(`The Cloud Run job ${t.job} hands the build secrets a customer build must never see (${[...extra, ...volumes].join(', ')}); only UNITY_EMAIL, UNITY_PASSWORD and UNITY_SERIAL. Run ${SETUP} again.`);
  if (!env.some((e) => e.name === 'HAWKES_CUSTOMER_JOB' && e.value === '1')) throw config(`The Cloud Run job ${t.job} doesn't set HAWKES_CUSTOMER_JOB=1 (the container's signed-URL-only mode). Run ${SETUP} again.`);
  jobChecks.set(key, Date.now() + 10 * 60_000);
}

/** What the container may read and write in the bucket, one signed URL per object (env HAWKES_SIGNED). */
export type SignedUrls = { bucket: string; get: Record<string, string>; put: Record<string, string> };

/** How long a customer build's URLs live: the build's limit, the execution's 15 minutes of setup, 15 more of margin. */
/** The build limit + 15 for the execution + 15 of margin + 20 for region moves (each waits up to 3 minutes for a machine
 *  before starting again elsewhere; links signed at prepare time must outlast them: 2026-10-31 review). */
export const customerUrlSeconds = (timeoutMinutes: number) => (timeoutMinutes + 50) * 60;

const BUILD_PREFIX_RE = /^unity-builds\/[A-Za-z0-9_-]+$/;
const CUST_CACHE_RE = /^unity-cache\/cust--[A-Za-z0-9_.-]+$/;
const KEY_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * The signed URLs of one customer build: GET its spec and its own Library cache (each restore key whose archive
 * exists: the archive and its .json), PUT its output (artifact.tgz), log (unity.log) and result (result.json) under the
 * job's prefix, and its cache back (the save key: archive and .json). Only a customer cache (unity-cache/cust--...),
 * only that job's prefix. `sign(method, key)` signs one object of `bucket`.
 */
export async function customerSignedUrls(o: {
  bucket: string; prefix: string; cachePrefix: string; restore: string[]; save: string | null;
  sign: (method: 'GET' | 'PUT', key: string) => Promise<string>;
  /** A compile-only check (check.ts) hands back no artifact: no URL to write one. */
  artifact?: boolean;
}): Promise<SignedUrls> {
  const no = (m: string) => new GenError(m, { status: 500, kind: 'builder' });
  if (!BUILD_PREFIX_RE.test(o.prefix)) throw no(`not a build's prefix: ${o.prefix}`);
  if (!CUST_CACHE_RE.test(o.cachePrefix)) throw no(`not a customer's Library cache: ${o.cachePrefix}`);
  if ([...o.restore, ...(o.save ? [o.save] : [])].some((k) => !KEY_RE.test(k))) throw no('a cache key with characters a key can\'t have');
  const get: Record<string, string> = {};
  const put: Record<string, string> = {};
  for (const k of [`${o.prefix}/spec.json`, ...o.restore.flatMap((r) => [`${o.cachePrefix}/${r}.tar.zst`, `${o.cachePrefix}/${r}.json`])]) get[k] = await o.sign('GET', k);
  for (const k of [...(o.artifact === false ? [] : [`${o.prefix}/artifact.tgz`]), `${o.prefix}/unity.log`, `${o.prefix}/result.json`, ...(o.save ? [`${o.cachePrefix}/${o.save}.tar.zst`, `${o.cachePrefix}/${o.save}.json`] : [])]) put[k] = await o.sign('PUT', k);
  return { bucket: o.bucket, get, put };
}
