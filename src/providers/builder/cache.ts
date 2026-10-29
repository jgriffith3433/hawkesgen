// The Unity Library caches of the cloud builds (cloudrun.ts, docs/unity-cloudrun.md): which cache a build restores
// and saves, when a build runs clean, and what a cloud build's result says. The rules are pure functions (tested in
// test/unity-cloudrun.test.ts); the state is one JSON file in DATA_DIR/builder.
//
// Layout in the bucket:
//   gs://<bucket>/unity-cache/<repo>/<key>.tar.zst    the Library (zstd tar), written only after a successful build
//   gs://<bucket>/unity-cache/<repo>/<key>.json       what made it: size, files, unity version, commit, when
//   gs://<bucket>/unity-builds/<job>/...              one build: spec, inputs, result.json, site.tgz, unity.log

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../../config.ts';

/** The branches whose cache is shared; any other branch (an agent's change) restores from these and saves nothing. */
export const SHARED_KEYS = ['beta', 'main'];

/** A safe cache / repo name: letters, digits, dot, dash, underscore (slashes become "--"). */
export function cacheName(s: string) {
  return String(s).trim().replace(/[\\/]+/g, '--').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '').slice(0, 64) || 'default';
}

/** The repo folder a project's caches live under: its path under the projects folder ("YoobaLand/YoobaLand" -> "YoobaLand--YoobaLand"). */
export const cacheRepo = (project: string) => cacheName(project);

/**
 * Which caches a build restores (first found wins) and which one it saves.
 * - An explicit name (the `cache` param) is used for both.
 * - main and beta use their own, falling back to the other (beta's is nearly always the warmer one).
 * - Any other branch (an agent's change, a detached checkout) restores beta, then main, and saves nothing: one cache
 *   per feature branch would be a full import each time and a bucket full of copies.
 */
export function cacheKeys({ branch, explicit }: { branch?: string | null; explicit?: string | null }): { restore: string[]; save: string | null } {
  if (explicit) {
    const k = cacheName(explicit);
    return { restore: [k], save: k };
  }
  const b = branch ? cacheName(branch) : '';
  if (b && SHARED_KEYS.includes(b)) return { restore: [b, ...SHARED_KEYS.filter((k) => k !== b)], save: b };
  return { restore: [...SHARED_KEYS], save: null };
}

/**
 * Failure lines that point at a broken Library rather than at the project: a corrupt asset database, a broken Bee
 * graph, a crash while opening the project. A compile error (error CS...) or a deploy error is the project's own.
 */
export const CACHE_SUSPECT_RE = new RegExp([
  'ArtifactDB', 'SourceAssetDB', 'asset database (is )?corrupt', 'database (is )?corrupt', 'MDB_', 'mdb_(env|txn)', 'LMDB',
  'Failed to open (the )?(artifact|asset) ?(database|DB)', 'Rebuilding Library because', 'Library/Bee/.*(corrupt|invalid|failed to load)',
  'Bee.*(dag|DAG).*(corrupt|could not|failed to (read|load))', 'Failed to load .*Library/', 'Library/PackageCache.*(missing|corrupt|not found)',
  'Crash!!!', 'Segmentation fault', 'SIGSEGV', 'Native Crash Reporting', 'ScriptAssemblies.*(could not|failed to) (load|be loaded)',
].join('|'), 'i');

export type FailureKind = 'cache' | 'other';

/** Whether a failed build's log looks like a broken Library (counts toward the clean rebuild). */
export function failureKind(log: string, kind?: string | null): FailureKind {
  if (kind === 'license' || kind === 'source' || kind === 'auth') return 'other';
  // The project's own errors come first: a compile error is never the cache's fault.
  if (/error CS\d{4}/.test(log)) return 'other';
  return CACHE_SUSPECT_RE.test(log) ? 'cache' : 'other';
}

export type CacheState = Record<string, { streak: number; cleanNext?: boolean; lastBuild?: { at: string; ok: boolean; job: string; kind?: string | null; restored?: string | null; clean?: boolean } }>;

/** How many cache-looking failures in a row make the next build run clean. */
export const CLEAN_AFTER_DEFAULT = 2;

/** The state after a build of one repo/cache: success resets the streak; a cache-looking failure adds one. */
export function nextCacheState(prev: CacheState[string] | undefined, outcome: { ok: boolean; failure?: FailureKind; at: string; job: string; kind?: string | null; restored?: string | null; clean?: boolean }, cleanAfter = CLEAN_AFTER_DEFAULT): CacheState[string] {
  const streak = outcome.ok ? 0 : outcome.failure === 'cache' ? (prev?.streak ?? 0) + 1 : prev?.streak ?? 0;
  return {
    streak,
    // A clean build that fails for a cache-looking reason keeps the next one clean too; a success ends it.
    cleanNext: outcome.ok ? false : streak >= cleanAfter || Boolean(prev?.cleanNext && outcome.failure === 'cache'),
    lastBuild: { at: outcome.at, ok: outcome.ok, job: outcome.job, kind: outcome.kind ?? null, restored: outcome.restored ?? null, clean: outcome.clean ?? false },
  };
}

/** Whether this build skips the cache: asked for (`clean`), or the rule says so after a streak of cache failures. */
export function shouldRunClean(state: CacheState[string] | undefined, asked?: boolean) {
  if (asked) return { clean: true, reason: 'asked for a clean build' };
  if (state?.cleanNext) return { clean: true, reason: `the last ${state.streak} build(s) failed in a way that looks like a broken Library` };
  return { clean: false, reason: '' };
}

const stateFile = () => path.join(paths.builder, 'cloud-cache.json');
const stateKey = (repo: string, key: string) => `${repo}/${key}`;

export function loadCacheState(): CacheState {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function saveCacheState(s: CacheState) {
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
}
export function cacheStateOf(repo: string, key: string) {
  return loadCacheState()[stateKey(repo, key)];
}
export function recordBuild(repo: string, key: string, outcome: Parameters<typeof nextCacheState>[1], cleanAfter?: number) {
  const s = loadCacheState();
  s[stateKey(repo, key)] = nextCacheState(s[stateKey(repo, key)], outcome, cleanAfter);
  saveCacheState(s);
  return s[stateKey(repo, key)];
}
/** After "clear cache": the next build of that repo (or key) restores nothing; the streak starts over. */
export function forgetCache(repo: string, key?: string) {
  const s = loadCacheState();
  for (const k of Object.keys(s)) if (k === stateKey(repo, key ?? '') || (!key && k.startsWith(`${repo}/`))) delete s[k];
  saveCacheState(s);
}

// ----------------------------------------------------------- build results

export type CloudSiteFile = { path: string; size: number };
export type CloudResult = {
  v: number; ok: boolean; stage: string; kind: string | null; error: string | null; exitCode: number | null;
  seconds: Record<string, number>; unity: string | null;
  cache: { restoredFrom: string | null; restoredBytes: number; clean: boolean; reason: string; saved: boolean; savedKey: string | null; savedBytes: number; skipped: string | null };
  output: { object: string; bytes: number; changed: CloudSiteFile[]; deleted: string[] } | null;
  results: string | null; log: string | null; memoryPeakBytes: number | null; errors: string[];
  /** GitHub mode: what the container pushed to the website repo (github.ts); null otherwise or when nothing changed. */
  pushed: CloudPush | null;
  /** GitHub mode: the commit each local file: package repo was fetched at ({ hawkesgen: sha }). */
  packages: Record<string, string>;
};

/** A GitHub-mode build's push: the website repo, the branch (never main), the new commit, and the source commit built. */
export type CloudPush = { repo: string; branch: string; commit: string; before: string | null; source: string; files: number };

const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
/** Paths inside the site folder: relative, forward slashes, no "..". */
const safeRel = (p: unknown) => {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return s && !s.startsWith('/') && !s.split('/').includes('..') && !/^[A-Za-z]:/.test(s) ? s : null;
};

/** Reads the container's result.json, tolerating missing fields; throws on something that isn't a result. */
export function parseCloudResult(raw: string | Buffer): CloudResult {
  let j: any;
  try {
    j = JSON.parse(String(raw).replace(/^﻿/, ''));
  } catch (e: any) {
    throw new Error(`the cloud build's result isn't JSON (${e.message})`);
  }
  if (!j || typeof j !== 'object' || typeof j.ok !== 'boolean') throw new Error('the cloud build\'s result has no "ok"');
  const c = j.cache ?? {};
  const o = j.output;
  const output = o && typeof o === 'object' && str(o.object) ? {
    object: String(o.object), bytes: num(o.bytes),
    changed: (Array.isArray(o.changed) ? o.changed : []).map((f: any) => ({ path: safeRel(f?.path), size: num(f?.size) })).filter((f: any) => f.path) as CloudSiteFile[],
    deleted: (Array.isArray(o.deleted) ? o.deleted : []).map(safeRel).filter(Boolean) as string[],
  } : null;
  return {
    v: num(j.v, 1), ok: j.ok, stage: String(j.stage ?? (j.ok ? 'done' : 'unknown')), kind: str(j.kind), error: str(j.error),
    exitCode: j.exitCode === null || j.exitCode === undefined ? null : num(j.exitCode),
    seconds: Object.fromEntries(Object.entries(j.seconds ?? {}).map(([k, v]) => [k, num(v)])),
    unity: str(j.unity),
    cache: {
      restoredFrom: str(c.restoredFrom), restoredBytes: num(c.restoredBytes), clean: Boolean(c.clean), reason: String(c.reason ?? ''),
      saved: Boolean(c.saved), savedKey: str(c.savedKey), savedBytes: num(c.savedBytes), skipped: str(c.skipped),
    },
    output, results: str(j.results), log: str(j.log), memoryPeakBytes: j.memoryPeakBytes ? num(j.memoryPeakBytes) : null,
    errors: (Array.isArray(j.errors) ? j.errors : []).map(String).slice(0, 20),
    pushed: pushOf(j.pushed),
    packages: Object.fromEntries(Object.entries(j.packages && typeof j.packages === 'object' ? j.packages : {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)])),
  };
}

const SHA = /^[0-9a-f]{40}$/;
/** The `pushed` block of a result, or null when it isn't a real push (and never one to a protected branch). */
function pushOf(p: any): CloudPush | null {
  if (!p || typeof p !== 'object') return null;
  const repo = str(p.repo), branch = str(p.branch), commit = str(p.commit), source = str(p.source);
  if (!repo || !branch || !commit || !SHA.test(commit) || !source) return null;
  if (['main', 'master'].includes(branch.toLowerCase())) throw new Error(`the cloud build says it pushed ${branch}, which a build never does`);
  return { repo, branch, commit, before: str(p.before), source, files: num(p.files) };
}

/** The stub a site's old Game/v<n> folder is replaced by in the build's input (its big files stay here). */
export const STUB = '.hawkes-stub';

/** A deleted stub means the build removed that whole Game/v<n> folder: the folder to remove here, else null. */
export function stubFolderOf(rel: string) {
  return rel.endsWith(`/${STUB}`) ? rel.slice(0, -(STUB.length + 1)) : null;
}

/** Files of the site that go into the build's input: everything, but only the small files of numbered Game/v<n> folders. */
export function siteInputKeep(rel: string, size: number, bigBytes = 256 * 1024) {
  const m = /^Game\/v([1-9]\d*)\/(.+)$/.exec(rel.replace(/\\/g, '/'));
  if (!m) return true;
  return size < bigBytes;
}
