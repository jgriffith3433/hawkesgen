// Customers' builds for playtest.run (hawkesstudio docs/platform-plan.md 3.5 and 4.5; docs/playtest-runners.md):
//
//   build: "blob:<sha256>" | "asset:<id>"           a zip or tar(.gz) of the build, uploaded to Gen
//          "https://…" or { url }                   a hosted page (web) or an archive to download (desktop)
//          { github: { repo, release | run | ref, asset?, artifact?, token? } }
//
// Gen never fetches or serves a customer's build from its own host. An archive Gen holds is copied to the library
// bucket under playtest-builds/<project>/<sha256> and the runner gets a signed URL to it; a GitHub build resolves to
// GitHub's own short-lived download link (Gen asks api.github.com where it is, and never downloads it); a URL is handed
// to the runner as it is, after checking it isn't a private, loopback or metadata address (SSRF). A GitHub token is
// passed per call and kept in memory and, encrypted, in the token store (below), never in the job's params, a log or any row in clear (J's
// decision: tokens now, a GitHub App maybe later); a job whose token is gone or expired fails and says so.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import { GenError } from '../../util.ts';
import { db } from '../../db.ts';
import { env } from '../../config.ts';
import type { PlaytestTarget } from '../../config.ts';

export type BuildRef =
  | { kind: 'url'; url: string }
  | { kind: 'blob'; sha: string }
  | { kind: 'asset'; id: string }
  | { kind: 'github'; repo: string; release?: string; asset?: string; run?: number; artifact?: string; ref?: string; tokenRef?: string };

/** What a runner fetches: a URL it may download (signed or public), and what it is. */
export type FetchableBuild = { url: string; kind: 'page' | 'archive'; sha256?: string; name?: string; bytes?: number; source: string };

// ------------------------------------------------------------------ SSRF

/** Whether an IP address is private, loopback, link-local (the metadata server), multicast or otherwise not the internet. */
export function privateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && Number(ip.split('.')[2]) === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (s === '::' || s === '::1') return true;
    // IPv4 mapped or translated (::ffff:a.b.c.d, ::ffff:7f00:1, 64:ff9b::a.b.c.d): judge the IPv4 address inside.
    const mapped = /^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return privateAddress(mapped[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return privateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    const first = parseInt(s.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || s.startsWith('::');
  }
  return true;
}

const BLOCKED_HOSTS = /^(localhost|metadata|metadata\.google\.internal|instance-data)$|\.(localhost|internal|local|lan|home|corp|intranet|localdomain)$/i;

/**
 * A customer's URL as a runner may open or download it: http(s) only, no user:password, and not a private, loopback or
 * metadata address written as a name or a number (the URL parser turns 2130706433 and 0x7f.1 into 127.0.0.1). Throws a
 * GenError saying why. Names are checked again when the run starts (publicUrl), against what they resolve to.
 */
export function checkPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GenError(`Not a URL: ${String(raw).slice(0, 200)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new GenError('A build URL must be http or https');
  if (u.username || u.password) throw new GenError('A build URL can\'t carry a user name or password');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTS.test(host) || !host.includes('.') && !net.isIP(host)) throw new GenError(`${u.hostname} is not a public address: playtests open builds on the internet (for a build on your own machine, upload it, or use hawkes connect)`, { status: 400 });
  if (net.isIP(host) && privateAddress(host)) throw new GenError(`${u.hostname} is a private or loopback address: playtests open builds on the internet`, { status: 400 });
  return u;
}

export type Lookup = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: Lookup = (host) => dns.lookup(host, { all: true, verbatim: true });

/** checkPublicUrl, and every address the name resolves to is public (a name pointing at 10.x or 127.x is refused). */
export async function publicUrl(raw: string, lookup: Lookup = defaultLookup): Promise<URL> {
  const u = checkPublicUrl(raw);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return u;
  const addrs = await lookup(host).catch((e: any) => { throw new GenError(`${host} doesn't resolve (${e.code ?? e.message})`, { status: 400 }); });
  if (!addrs.length) throw new GenError(`${host} doesn't resolve`, { status: 400 });
  const bad = addrs.find((a) => privateAddress(a.address));
  if (bad) throw new GenError(`${host} resolves to ${bad.address}, a private or loopback address: playtests open builds on the internet`, { status: 400 });
  return u;
}

// ------------------------------------------------------------------ the token vault

type Held = { token: string; until: number; at: number };
const vault = new Map<string, Held>();
const TOKEN_TTL_MS = 12 * 3600_000;

// A token held for a job that waits in the queue and then builds for an hour must survive Cloud Run recycling the
// instance (2026-11-03: every customer Unity build died with "token is gone"). So the memory copy is backed by an
// encrypted row (AES-256-GCM, HAWKESGEN_SECRETS_KEY, the reference as AAD) with the same TTL: the token is never stored
// in clear, never in a job's params, a log or any other row. Without the key only memory is used, and the log says so.
db.exec(`CREATE TABLE IF NOT EXISTS held_tokens (ref TEXT PRIMARY KEY, iv TEXT NOT NULL, tag TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL, until INTEGER NOT NULL)`);

function vaultKey(): Buffer | null {
  const raw = env('HAWKESGEN_SECRETS_KEY');
  const k = raw ? Buffer.from(raw, 'base64') : null;
  return k && k.length === 32 ? k : null;
}

function persistToken(ref: string, h: Held) {
  const key = vaultKey();
  if (!key) { console.warn(`[tokens] ${ref} is held in memory only: HAWKESGEN_SECRETS_KEY isn't set, so a restart will lose it`); return; }
  try {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(ref));
    const data = Buffer.concat([c.update(h.token, 'utf8'), c.final()]);
    db.prepare('INSERT OR REPLACE INTO held_tokens (ref, iv, tag, data, at, until) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ref, iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64'), h.at, h.until);
  } catch (e) {
    console.error(`[tokens] could not store ${ref}: ${(e as Error).message}`);
  }
}

function storedToken(ref: string): Held | null {
  const r = db.prepare('SELECT iv, tag, data, at, until FROM held_tokens WHERE ref = ?').get(ref) as { iv: string; tag: string; data: string; at: number; until: number } | undefined;
  if (!r) return null;
  const key = vaultKey();
  if (!key) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.iv, 'base64'));
    d.setAAD(Buffer.from(ref));
    d.setAuthTag(Buffer.from(r.tag, 'base64'));
    const token = Buffer.concat([d.update(Buffer.from(r.data, 'base64')), d.final()]).toString('utf8');
    return { token, at: r.at, until: r.until };
  } catch (e) {
    console.error(`[tokens] could not read ${ref}: ${(e as Error).message}`);
    return null;
  }
}

/** Keeps a GitHub token for one job (memory, and encrypted at rest); the job's params carry only the returned reference. */
export function holdToken(token: string, now = Date.now()): string {
  for (const [k, v] of vault) if (v.until < now) vault.delete(k);
  try { db.prepare('DELETE FROM held_tokens WHERE until < ?').run(now); } catch { /* the store is a backup */ }
  const ref = `tok_${crypto.randomBytes(12).toString('hex')}`;
  const h = { token, at: now, until: now + TOKEN_TTL_MS };
  vault.set(ref, h);
  persistToken(ref, h);
  return ref;
}

/** Puts a new token behind an existing reference (a refreshed one), age starting now. */
export function replaceToken(ref: string, token: string, now = Date.now()): void {
  const h = { token, at: now, until: now + TOKEN_TTL_MS };
  vault.set(ref, h);
  persistToken(ref, h);
}

/** Why a token isn't there: never held (or the store can't say), held and past its time, or dropped by its job. */
export type TokenLookup = { token: string; ageSeconds: number; from: 'memory' | 'store' } | { token: null; why: 'expired' | 'missing'; ageSeconds?: number };

/** The token behind a reference, from memory first, then the encrypted store (a restarted Gen), with what happened. */
export function lookupToken(ref: string | undefined, now = Date.now()): TokenLookup {
  if (!ref) return { token: null, why: 'missing' };
  const m = vault.get(ref);
  if (m) {
    if (m.until < now) return { token: null, why: 'expired', ageSeconds: Math.round((now - m.at) / 1000) };
    return { token: m.token, ageSeconds: Math.round((now - m.at) / 1000), from: 'memory' };
  }
  const s = storedToken(ref);
  if (!s) return { token: null, why: 'missing' };
  if (s.until < now) return { token: null, why: 'expired', ageSeconds: Math.round((now - s.at) / 1000) };
  vault.set(ref, s);
  return { token: s.token, ageSeconds: Math.round((now - s.at) / 1000), from: 'store' };
}

/** The token behind a reference, or null (expired, dropped, or lost with no stored copy). */
export function tokenFor(ref: string | undefined, now = Date.now()): string | null {
  return lookupToken(ref, now).token;
}
/** Forgets a token once its job is done with it (memory and store). */
export const dropToken = (ref: string | undefined) => {
  if (!ref) return;
  vault.delete(ref);
  try { db.prepare('DELETE FROM held_tokens WHERE ref = ?').run(ref); } catch { /* nothing stored */ }
};
/** Tests: a restart (the memory copy is gone, the store stays). */
export const forgetMemoryTokens = () => vault.clear();

// ------------------------------------------------------------------ the build param

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const NAME = /^[^\x00-\x1f/\\]{1,200}$/;

/**
 * playtest.run's `build` (and `url`) as a BuildRef, checked: the forms above, a GitHub token moved into the vault, and
 * for customers a public URL. Throws a GenError saying what's wrong. Runs at submit (playtest.run's admit).
 */
export function parseBuild(build: unknown, url: unknown, { customer, tokenRef }: { customer: boolean; /** A stored build's token reference, kept as it is. */ tokenRef?: string }): BuildRef | null {
  if (build === undefined || build === null || build === '') {
    if (url === undefined || url === null || url === '') return null;
    build = url;
  }
  if (typeof build === 'string') {
    if (build.startsWith('blob:')) {
      const sha = build.slice(5);
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new GenError('build blob:<sha256>: upload the archive to /v1/blobs first');
      return { kind: 'blob', sha };
    }
    if (build.startsWith('asset:')) {
      const id = build.slice(6);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new GenError('build asset:<id>: not an asset id');
      return { kind: 'asset', id };
    }
    if (customer) checkPublicUrl(build);
    else new URL(build); // throws on nonsense
    return { kind: 'url', url: build };
  }
  if (typeof build !== 'object' || Array.isArray(build)) throw new GenError('build: "blob:<sha>", "asset:<id>", a URL, { url } or { github: { repo, release | run | ref } }');
  const b = build as Record<string, any>;
  // A build already checked once (a job's stored params, rerun): checked again the same way, its token reference kept.
  if (b.kind === 'blob') return parseBuild(`blob:${b.sha}`, null, { customer });
  if (b.kind === 'asset') return parseBuild(`asset:${b.id}`, null, { customer });
  if (b.kind === 'url' && typeof b.url === 'string') return parseBuild(b.url, null, { customer });
  if (b.kind === 'github') {
    const { kind: _k, tokenRef, token: _t, ...g } = b;
    return parseBuild({ github: g }, null, { customer, tokenRef: typeof tokenRef === 'string' && /^tok_[0-9a-f]{24}$/.test(tokenRef) ? tokenRef : undefined });
  }
  if (typeof b.url === 'string') return parseBuild(b.url, null, { customer });
  const g = b.github;
  if (!g || typeof g !== 'object') throw new GenError('build: give a URL, blob:, asset: or { github: { repo, release | run | ref } }');
  if (!REPO.test(String(g.repo ?? ''))) throw new GenError('build.github.repo: owner/name');
  const out: Extract<BuildRef, { kind: 'github' }> = { kind: 'github', repo: String(g.repo) };
  const ways = ['release', 'run', 'ref'].filter((k) => g[k] !== undefined && g[k] !== null && g[k] !== '');
  if (ways.length !== 1) throw new GenError('build.github: give exactly one of release (a tag, or "latest"), run (an Actions run id) or ref (a branch, tag or commit)');
  if (g.release !== undefined && g.release !== null && g.release !== '') {
    if (!/^[A-Za-z0-9_.\/-]{1,200}$/.test(String(g.release))) throw new GenError('build.github.release: a tag name or "latest"');
    out.release = String(g.release);
    if (g.asset !== undefined) {
      if (!NAME.test(String(g.asset))) throw new GenError('build.github.asset: the release asset\'s file name');
      out.asset = String(g.asset);
    }
  }
  if (g.run !== undefined && g.run !== null && g.run !== '') {
    const run = Number(g.run);
    if (!Number.isSafeInteger(run) || run <= 0) throw new GenError('build.github.run: an Actions run id (a number)');
    out.run = run;
    if (g.artifact !== undefined) {
      if (!NAME.test(String(g.artifact))) throw new GenError('build.github.artifact: the artifact\'s name');
      out.artifact = String(g.artifact);
    }
  }
  if (g.ref !== undefined && g.ref !== null && g.ref !== '') {
    if (!/^[A-Za-z0-9_.\/-]{1,200}$/.test(String(g.ref)) || String(g.ref).includes('..')) throw new GenError('build.github.ref: a branch, tag or commit');
    out.ref = String(g.ref);
  }
  if (tokenRef) out.tokenRef = tokenRef;
  else if (g.token !== undefined && g.token !== null && g.token !== '') {
    const token = String(g.token);
    if (!/^(gh[pousr]_|github_pat_)[A-Za-z0-9_.=+/-]{20,1024}$/.test(token)) throw new GenError('build.github.token: a GitHub token (ghp_…, github_pat_…)');
    out.tokenRef = holdToken(token);
  }
  if (out.run && !out.tokenRef) throw new GenError('build.github.run: Actions artifacts need a token (build.github.token) even for public repos');
  return out;
}

/** The build as it is stored in the job's params (no token: its reference). */
export const storedBuild = (b: BuildRef | null): Record<string, unknown> | null => (b ? { ...b } : null);

/** An exe or page path inside a build: relative, no "..", no drive letters. */
export function checkEntry(p: unknown, what = 'exe'): string | null {
  if (p === undefined || p === null || p === '') return null;
  const s = String(p).replace(/\\/g, '/');
  if (s.length > 300 || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').some((x) => x === '..') || /[\x00-\x1f]/.test(s)) throw new GenError(`${what}: a path inside the build (relative, no ..)`);
  return s;
}

/** Command-line arguments for a desktop build: strings, at most 32, each at most 500 characters. */
export function checkArgs(a: unknown): string[] {
  if (a === undefined || a === null) return [];
  if (!Array.isArray(a) || a.length > 32 || a.some((x) => typeof x !== 'string' || x.length > 500 || /[\x00]/.test(x))) throw new GenError('args: a list of strings (at most 32)');
  return a as string[];
}

/** Which targets a build form makes sense for: a URL page plays on web; archives play anywhere. */
export function checkTarget(target: PlaytestTarget, build: BuildRef | null) {
  if (!build) throw new GenError('playtest.run needs a build: a url, blob:, asset: or github');
  if (target !== 'web' && build.kind === 'url' && /\.html?$|\/$/.test(new URL(build.url).pathname)) {
    throw new GenError(`A ${target} playtest needs the build as an archive (a zip or tar.gz URL, blob:, asset: or github), not a page`);
  }
}

// ------------------------------------------------------------------ GitHub

export type Fetch = typeof fetch;
const GH = 'https://api.github.com';

/** GitHub's answer to "where do I download this": the Location of a redirect (a signed link, minutes long). */
async function redirectOf(f: Fetch, url: string, headers: Record<string, string>, what: string): Promise<string> {
  const r = await f(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const loc = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && loc) return loc;
  if (r.status === 401 || r.status === 403) throw new GenError(`GitHub refused ${what} (${r.status}): the token can't read it`, { status: 400 });
  if (r.status === 404) throw new GenError(`GitHub has no ${what} (404: a private repo needs a token that can read it)`, { status: 400 });
  throw new GenError(`GitHub answered ${r.status} for ${what}`, { status: 502 });
}

async function ghJson(f: Fetch, url: string, headers: Record<string, string>, what: string): Promise<any> {
  const r = await f(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (r.status === 401 || r.status === 403) throw new GenError(`GitHub refused ${what} (${r.status}): the token can't read it`, { status: 400 });
  if (r.status === 404) throw new GenError(`GitHub has no ${what} (404: a private repo needs a token that can read it)`, { status: 400 });
  if (!r.ok) throw new GenError(`GitHub answered ${r.status} for ${what}`, { status: 502 });
  return r.json();
}

const ARCHIVE = /\.(zip|tar|tgz|tar\.gz)$/i;

/**
 * A GitHub build as a link the runner downloads itself: a release asset, an Actions artifact (a zip) or the source at a
 * ref (a zipball). Gen only asks api.github.com where it is; the token never leaves Gen and is never logged.
 */
export async function resolveGithub(b: Extract<BuildRef, { kind: 'github' }>, { fetch: f = fetch, token = tokenFor(b.tokenRef) }: { fetch?: Fetch; token?: string | null } = {}): Promise<FetchableBuild> {
  if (b.tokenRef && !token) throw new GenError('The GitHub token for this build is gone (Gen restarted, or it expired): submit the playtest again with the token', { status: 400 });
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hawkesgen-playtest', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const repo = b.repo;
  if (b.release) {
    const rel = await ghJson(f, `${GH}/repos/${repo}/releases/${b.release === 'latest' ? 'latest' : `tags/${encodeURIComponent(b.release)}`}`, headers, `release ${b.release} in ${repo}`);
    const assets: any[] = Array.isArray(rel.assets) ? rel.assets : [];
    const a = b.asset ? assets.find((x) => x.name === b.asset) : assets.length === 1 ? assets[0] : assets.find((x) => ARCHIVE.test(String(x.name)));
    if (!a) throw new GenError(`Release ${b.release} in ${repo} has ${b.asset ? `no asset "${b.asset}"` : 'no zip or tar.gz asset'} (it has: ${assets.map((x) => x.name).join(', ') || 'none'})`, { status: 400 });
    const url = await redirectOf(f, `${GH}/repos/${repo}/releases/assets/${a.id}`, { ...headers, Accept: 'application/octet-stream' }, `release asset ${a.name}`);
    return { url, kind: 'archive', name: String(a.name), bytes: Number(a.size) || undefined, source: `github ${repo} release ${rel.tag_name ?? b.release} ${a.name}` };
  }
  if (b.run) {
    const list = await ghJson(f, `${GH}/repos/${repo}/actions/runs/${b.run}/artifacts?per_page=100`, headers, `the artifacts of run ${b.run} in ${repo}`);
    const arts: any[] = (Array.isArray(list.artifacts) ? list.artifacts : []).filter((x) => !x.expired);
    const a = b.artifact ? arts.find((x) => x.name === b.artifact) : arts.length === 1 ? arts[0] : null;
    if (!a) throw new GenError(`Run ${b.run} in ${repo} has ${b.artifact ? `no artifact "${b.artifact}"` : arts.length ? `${arts.length} artifacts: name one (build.github.artifact)` : 'no artifacts (or they expired)'} (${arts.map((x) => x.name).join(', ') || 'none'})`, { status: 400 });
    const url = await redirectOf(f, `${GH}/repos/${repo}/actions/artifacts/${a.id}/zip`, headers, `artifact ${a.name}`);
    return { url, kind: 'archive', name: `${a.name}.zip`, bytes: Number(a.size_in_bytes) || undefined, source: `github ${repo} run ${b.run} artifact ${a.name}` };
  }
  const url = await redirectOf(f, `${GH}/repos/${repo}/zipball/${encodeURIComponent(b.ref!)}`, headers, `${repo} at ${b.ref}`);
  return { url, kind: 'archive', name: `${repo.replace('/', '-')}-${b.ref}.zip`, source: `github ${repo} at ${b.ref}` };
}

// ------------------------------------------------------------------ archives Gen holds: to the bucket, signed

/** Zip, tar or gzip, by the file's first bytes; null for anything else (a playtest build is an archive). */
export function archiveKind(file: string): 'zip' | 'tar' | 'tgz' | null {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(512);
    const n = fs.readSync(fd, head, 0, 512, 0);
    if (n >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
    if (n >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tgz';
    if (n >= 262 && head.toString('latin1', 257, 262) === 'ustar') return 'tar';
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export type Stager = {
  stat(uri: string): Promise<unknown | null>;
  writeFile(uri: string, file: string, contentType?: string): Promise<unknown>;
  sign(uri: string, seconds: number): Promise<string>;
};

/** Where an org's builds live in the library bucket: by content, under the project (plan 3.5: kept 7 days by a lifecycle rule). */
export const buildObject = (bucket: string, project: string, sha: string) => `gs://${bucket}/playtest-builds/${project}/${sha}`;

/**
 * An archive Gen holds (an upload or an asset), put where the runner can fetch it: the library bucket under the job's
 * project, by content (uploaded once), and a signed link for this run. Gen never serves it itself.
 */
export async function stageArchive(file: string, sha: string, project: string, bucket: string | null, stager: Stager | null, ttlSeconds = 6 * 3600): Promise<FetchableBuild> {
  const kind = archiveKind(file);
  if (!kind) throw new GenError('The build must be a zip, tar or tar.gz archive of the build folder', { status: 400 });
  if (!bucket || !stager) throw new GenError('Runners fetch builds from the library bucket: set settings.storage.bucket (provider gcs) and give Gen a service account that can sign URLs', { status: 503 });
  const uri = buildObject(bucket, project, sha);
  if (!(await stager.stat(uri))) await stager.writeFile(uri, file, kind === 'zip' ? 'application/zip' : kind === 'tar' ? 'application/x-tar' : 'application/gzip');
  return { url: await stager.sign(uri, ttlSeconds), kind: 'archive', sha256: sha, name: `build.${kind === 'tgz' ? 'tar.gz' : kind}`, bytes: fs.statSync(file).size, source: `upload ${sha.slice(0, 12)}` };
}

/** Gen's stager: the library bucket (settings.storage, gcs) and IAM signBlob. Null when either is missing. */
export async function defaultStager(): Promise<{ bucket: string | null; stager: Stager | null }> {
  const { loadSettings } = await import('../../config.ts');
  const s = loadSettings().storage;
  const bucket = s.provider === 'gcs' && s.bucket ? s.bucket : null;
  const { signer, signedGetUrl } = await import('../gpu/sign.ts');
  const who = await signer().catch(() => null);
  if (!bucket || !who) return { bucket, stager: null };
  const { gcs } = await import('../gcp/gcs.ts');
  const g = gcs();
  return { bucket, stager: { stat: (u) => g.stat(u), writeFile: (u, f, t) => g.writeFile(u, f, t), sign: (u, sec) => signedGetUrl(u, who, sec) } };
}
