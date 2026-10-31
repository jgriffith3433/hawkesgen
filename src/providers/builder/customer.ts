// Customer mode of the Unity cloud build (docs/unity-cloudrun.md, "Customer mode"; hawkesstudio docs/builds.md, "unity ->
// Hawkes Gen"): a customer's Studio (a Gen key with role "user") builds ITS OWN Unity project from GitHub on Gen's Cloud
// Run build job and gets the output back as a library asset (a .tar.gz of the build folder).
//
//   params: { github: { repo, commit, token, ref? }, path?, method?, target: "web", out: "artifact" }
//
// The token is a short-lived GitHub installation token that Studio passes per job. It is moved into the in-memory token
// vault at submit (src/providers/playtester/intake.ts holdToken: the job's params keep only its tok_ reference), read
// once when the build starts, handed to that one Cloud Run execution as an env override (HAWKES_GITHUB_TOKEN), and used
// there only as an http.extraheader for the fetch. It is never in the stored params, spec.json, the log, the library
// recipe or any row. Gen's own GitHub secret is never used for a customer: the container unsets it in this mode.
//
// Before anything is started, Gen asks GitHub (with that token) where the Unity project is and which Unity it uses; a
// version Gen has no image for fails at once (kind 'config'), naming the project's version and the supported ones.

import { GenError } from '../../util.ts';
import { holdToken, tokenFor } from '../playtester/intake.ts';
import { cacheName } from './cache.ts';

const bad = (message: string, kind = 'params') => new GenError(message, { status: 400, kind });
const config = (message: string) => new GenError(message, { status: 400, kind: 'config' });

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
/** A GitHub token: installation tokens (ghs_), user-to-server (ghu_), classic and fine-grained PATs. */
const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;
const TOKEN_REF_RE = /^tok_[0-9a-f]{24}$/;
const PATH_RE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9 _.\/-]{1,200}$/;
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,120}$/;

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
};

/** Whether unity.build params ask for customer mode: a GitHub token (or, stored, its reference) and out "artifact". */
export function isCustomerMode(params: Record<string, any> | undefined): boolean {
  if (!params || params.out !== 'artifact') return false;
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
export function admitCustomer(params: Record<string, any>, hold: (token: string) => string = holdToken): Record<string, any> {
  const p = { ...params };
  let g = p.github;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { throw bad('github must be an object: { repo, commit, token, ref? }'); } }
  if (!g || typeof g !== 'object' || Array.isArray(g)) throw bad('github must be an object: { repo, commit, token, ref? }');
  const extra = Object.keys(g).filter((k) => !['repo', 'commit', 'token', 'ref'].includes(k));
  if (extra.length) throw bad(`customer builds take github { repo, commit, token, ref? } (not ${extra.join(', ')}): the output comes back as an asset, nothing is pushed`);
  for (const k of ['site', 'projectDir', 'siteDir', 'cache', 'backend', 'args']) {
    if (p[k] !== undefined && p[k] !== null && p[k] !== '' && !(k === 'backend' && (p[k] === 'auto' || p[k] === 'cloudrun'))) throw bad(`${k} isn't for customer builds (github with a token, out "artifact")`);
  }
  const repo = String(g.repo ?? '').trim();
  const commit = String(g.commit ?? '').trim().toLowerCase();
  const token = String(g.token ?? '').trim();
  if (!SLUG_RE.test(repo)) throw bad(`github.repo must be "owner/name" (got "${repo.slice(0, 100)}")`);
  if (!SHA_RE.test(commit)) throw bad('github.commit must be the full commit sha, 40 hex characters');
  // Never echo the token back, even a malformed one.
  if (!TOKEN_RE.test(token)) throw bad('github.token must be a GitHub token (a short-lived installation token, ghs_…)');
  const ref = g.ref === undefined || g.ref === null || g.ref === '' ? null : String(g.ref).trim();
  if (ref !== null && !REF_RE.test(ref)) throw bad(`github.ref "${ref.slice(0, 120)}" has characters a ref can't`);
  const path = p.path === undefined || p.path === null || p.path === '' ? null : normalPath(String(p.path));
  const method = p.method ? String(p.method).trim() : null;
  if (method !== null && !METHOD_RE.test(method)) throw bad(`method must be a static method's full name, Namespace.Class.Method (got "${method.slice(0, 120)}")`);
  customerTarget(p.target);
  const env = p.env && typeof p.env === 'object' && !Array.isArray(p.env) ? p.env : null;
  if (env) for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || /^(HAWKES_|UNITY_|GITHUB_|R2_|GCS_|GOOGLE_|CLOUD_RUN|LD_|BASH|ENV$|PATH$|HOME$)/.test(k)) throw bad(`env ${k}: a plain name that isn't one of the build's own (HAWKES_, UNITY_, GITHUB_, ...)`);
    if (typeof v !== 'string' || v.length > 1000) throw bad(`env ${k} must be a string (at most 1000 characters)`);
  }
  if (Object.keys(env ?? {}).length > 32) throw bad('env takes at most 32 variables');
  const stored: Record<string, unknown> = { repo, commit, tokenRef: hold(token) };
  if (ref) stored.ref = ref;
  p.github = stored;
  p.target = 'web';
  p.out = 'artifact';
  if (path) p.path = path; else delete p.path;
  if (method) p.method = method; else delete p.method;
  if (!env || !Object.keys(env).length) delete p.env;
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
    repo, commit, ref: g.ref ? String(g.ref) : null, tokenRef: String(g.tokenRef),
    path: params.path ? normalPath(String(params.path)) : null, method: params.method ? String(params.method) : null,
  };
}

/** The token behind a customer build, or a clear error (Gen restarted since the job was submitted, or it expired). */
export function customerToken(b: CustomerBuild, lookup: (ref: string) => string | null = tokenFor): string {
  const t = lookup(b.tokenRef);
  if (!t) throw new GenError('The GitHub token for this build is gone (Gen restarted, or it expired): submit the build again with a fresh token', { status: 400, kind: 'source' });
  return t;
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
  if (r.status === 401 || r.status === 403) throw new GenError(`GitHub refused ${what} (${r.status}): the token can't read the repo`, { status: 400, kind: 'source' });
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
  return cacheName(`cust--${owner}--${repo.replace('/', '--')}${path && path !== '.' ? `--${path}` : ''}`);
}

