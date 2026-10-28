// Unity builds on Google Cloud Run jobs (docs/unity-cloudrun.md): the other backend of unity.build and unity.test
// (settings.unityBuild.backend = "cloudrun"; the Windows build server, builder.ts, stays as the fallback).
//
// One build:
//   1. Here: work out the exact commit of every repo the build needs (the project, its local file: packages), pack
//      what differs from that commit (uncommitted edits) and the website folder (its big old Game/v<n> files left
//      out, a stub in their place), write the build's spec, and put them in gs://<bucket>/unity-builds/<job>/.
//   2. Start one execution of the Cloud Run job with HAWKES_SPEC pointing at the spec. The container
//      (server/unity-cloudrun/entrypoint.sh) fetches the sources at those commits, restores the Library cache, activates
//      Unity, runs the project's own batch method, and uploads what changed in the website plus result.json.
//   3. Here: follow the execution and its log, then lay the website changes into the site folder (or siteDir) exactly
//      as the build server's pull-back does, and return the same shape as runBuild.
// The hard limit is settings.unityBuild.timeoutMinutes (the container stops Unity at it; the execution's own timeout
// is a little longer, and Gen cancels it if it overruns that).

import fs from 'node:fs';
import path from 'node:path';
import { paths, loadSettings } from '../../config.ts';
import { GenError } from '../../util.ts';
import {
  type BuildSpec, type BuildHooks, UNITY_EXCLUDE, SITE_EXCLUDE, standIn, unityVersionOf, localPackages, repoOf, walk, localGit,
  progressOf, LICENSE_RE, HARD_LICENSE_RE, applyPulledSite, proc, TAR, mb, localFile,
} from './builder.ts';
import { gcsWrite, gcsRead, gcsDownload, gcsList, gcsDelete, runJob, getExecution, cancelExecution, executionLogs, type CloudRunTarget } from './gcp.ts';
import {
  cacheKeys, cacheRepo, cacheStateOf, recordBuild, shouldRunClean, failureKind, parseCloudResult, forgetCache, stubFolderOf,
  siteInputKeep, STUB, type CloudResult,
} from './cache.ts';

const fail = (message: string, kind = 'builder') => new GenError(message, { status: 409, kind });

/** Cloud Run prices (instance-based billing for jobs, Tier 1 regions, 2025 list prices): per vCPU-second and GiB-second. */
export const CLOUDRUN_PRICE = { cpuSecond: 0.000018, gibSecond: 0.000002 };
/** Dollars for `seconds` of one task with `cpu` vCPUs and `gib` GiB. */
export const cloudRunCost = (seconds: number, cpu = 8, gib = 32) => seconds * (cpu * CLOUDRUN_PRICE.cpuSecond + gib * CLOUDRUN_PRICE.gibSecond);

/** Library folders never cached: Unity remakes them, and some only grow (BuildCache is the Scriptable Build Pipeline's: 20 GB in Sick Of It). */
export const CACHE_EXCLUDE = ['Library/BuildCache', 'Library/Search', 'Library/TempArtifacts', 'Library/Logs', 'Library/il2cpp_android_*', 'Library/Bee/tmp'];
/** The biggest overlay of uncommitted edits a cloud build accepts (they're uploaded from here). */
const OVERLAY_MAX = 2 * 1024 ** 3;

export function cloudConfig() {
  const u = loadSettings().unityBuild;
  const g = u.gcp;
  const missing = (['project', 'bucket'] as const).filter((k) => !g[k]);
  if (missing.length) throw fail(`Cloud builds aren't set up: settings.unityBuild.gcp.${missing.join(' and .')} ${missing.length > 1 ? 'are' : 'is'} empty (docs/unity-cloudrun.md, "What J sets up").`, 'config');
  return { ...u, target: { project: g.project, region: g.region, job: g.job } as CloudRunTarget };
}

// ---------------------------------------------------------------- sources

export type RepoSpec = { slug: string; top: string; commit: string; branch: string | null; sparse: string[] };

/** Every repo the build needs at an exact commit, and the files here that differ from those commits. */
export function sourcesOf(spec: BuildSpec) {
  const roots: [string, string[], string?][] = [[spec.project, UNITY_EXCLUDE, spec.projectDir], ...localPackages(spec.project, spec.projectDir).map((p) => [p, ['.git']] as [string, string[]])];
  const repos = new Map<string, RepoSpec>();
  const overlay: { key: string; file: string; size: number }[] = [];
  const deletes: string[] = [];
  let projectBranch: string | null = null;
  for (const [root, exclude, from] of roots) {
    const repo = repoOf(root, from);
    if (!repo) throw fail(`${root} isn't in a GitHub repo with an origin, so a cloud build can't fetch it. Push it to GitHub, or build on the build server (settings.unityBuild.backend "builder").`, 'source');
    const pushed = localGit(repo.dir, ['branch', '-r', '--contains', 'HEAD']);
    const head = localGit(repo.dir, ['rev-parse', 'HEAD']).out.trim();
    // HEAD when GitHub has it, else the commit the work is based on (the difference is sent as the overlay).
    const commit = pushed.ok && pushed.out.trim() ? head : repo.base;
    const branch = localGit(repo.dir, ['symbolic-ref', '--short', '-q', 'HEAD']).out.trim() || null;
    if (root === spec.project) projectBranch = branch;
    const inside = root === repo.top ? '' : root.slice(repo.top.length + 1);
    const prev = repos.get(repo.slug);
    if (prev && prev.commit !== commit) throw fail(`${repo.slug} is needed at two commits (${prev.commit.slice(0, 7)} and ${commit.slice(0, 7)}).`, 'source');
    const r = prev ?? { slug: repo.slug, top: repo.top, commit, branch, sparse: [] };
    if (inside && !r.sparse.includes(inside)) r.sparse.push(inside);
    if (!inside) r.sparse = [];
    repos.set(repo.slug, r);
    // What differs from that commit under this root: tracked edits, deletions, untracked (not ignored) files.
    const under = (p: string) => {
      const rel = `${repo.top}/${p}`.replace(/^\/+/, '');
      if (!(rel === root || rel.startsWith(`${root}/`))) return null;
      const first = rel.slice(root.length + 1).split('/')[0].toLowerCase();
      return exclude.some((e) => e.toLowerCase() === first) ? null : rel;
    };
    const changed = new Set<string>();
    for (const line of localGit(repo.dir, ['-c', 'core.quotepath=off', 'diff', '--name-status', '--no-renames', commit]).out.split('\n').filter(Boolean)) {
      const [st, p] = line.split('\t');
      const rel = under(p);
      if (!rel) continue;
      if (st === 'D') deletes.push(rel);
      else changed.add(rel);
    }
    for (const p of localGit(repo.dir, ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean)) {
      const rel = under(p);
      if (rel) changed.add(rel);
    }
    for (const key of changed) {
      const file = localFile(root, key, from);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) overlay.push({ key, file, size: fs.statSync(file).size });
    }
  }
  return { repos: [...repos.values()], overlay, deletes, projectBranch };
}

/** Copies files into a staging folder by key and tars it (gzip): portable on Windows' tar and GNU tar. */
async function packFiles(files: { key: string; file: string }[], tmp: string, name: string) {
  const stage = path.join(tmp, `${name}-stage`);
  for (const f of files) {
    const dest = path.join(stage, f.key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.file, dest);
  }
  const tgz = path.join(tmp, `${name}.tgz`);
  const tops = [...new Set(files.map((f) => f.key.split('/')[0]))];
  await proc(TAR, ['-czf', tgz, '-C', stage, ...tops], 3_600_000, 'tar');
  fs.rmSync(stage, { recursive: true, force: true });
  return tgz;
}

/** The website folder as the build's input: everything but the big files of old Game/v<n> folders, with a stub in each. */
export function siteInput(site: string, siteDir?: string) {
  const files = walk(site, SITE_EXCLUDE, siteDir);
  const keep: { key: string; file: string; size: number }[] = [];
  const stubs = new Map<string, string[]>();
  for (const [key, [size]] of Object.entries(files)) {
    const rel = key.slice(site.length + 1);
    const v = /^Game\/v[1-9]\d*(?=\/)/.exec(rel)?.[0];
    if (v && !stubs.has(v)) stubs.set(v, []);
    if (siteInputKeep(rel, size)) keep.push({ key, file: localFile(site, key, siteDir), size });
    else stubs.get(v!)!.push(rel);
  }
  return { keep, stubs };
}

// ------------------------------------------------------------------ state

type CloudJob = { execution: string; prefix: string; started: number; repo: string; saveKey: string | null; stateKey: string; clean: boolean };
const jobFile = (jobId: string) => path.join(paths.builder, 'cloud-jobs', `${jobId}.json`);
const loadJob = (jobId: string): CloudJob | null => { try { return JSON.parse(fs.readFileSync(jobFile(jobId), 'utf8')); } catch { return null; } };
function saveJob(jobId: string, j: CloudJob) {
  fs.mkdirSync(path.dirname(jobFile(jobId)), { recursive: true });
  fs.writeFileSync(jobFile(jobId), JSON.stringify(j));
}

// ------------------------------------------------------------------ build

export type BuildOptions = { cache?: string; clean?: boolean };

/** Builds on Cloud Run; resolves to the same shape as builder.ts runBuild. */
export async function runCloudBuild(jobId: string, spec: BuildSpec, hooks: BuildHooks, opts: BuildOptions = {}) {
  const t0 = Date.now();
  const cfg = cloudConfig();
  const target = spec.target ?? 'WebGL';
  spec = { ...spec, projectDir: standIn(spec.projectDir, 'projectDir'), siteDir: standIn(spec.siteDir, 'siteDir') };
  if (spec.siteDir && !spec.site) throw fail('siteDir needs site (the website folder it stands in for).');
  if (target !== 'WebGL') throw fail(`Cloud builds make WebGL only (the image has the WebGL module); ${target} needs the build server.`, 'config');
  const unity = unityVersionOf(spec.project, spec.projectDir);
  if (unity !== cfg.gcp.unity) throw fail(`${spec.project} uses Unity ${unity}, but the cloud image has ${cfg.gcp.unity}. Build a new image for it (tools/unity-cloudrun/build-image.mjs) or use the build server.`, 'config');
  const bucket = cfg.gcp.bucket;
  const repo = cacheRepo(spec.project);
  const tmp = fs.mkdtempSync(path.join(paths.tmp, 'cloudbuild-'));

  let job = loadJob(jobId);
  if (job) {
    hooks.log(`the cloud build was already started (${job.execution.split('/').pop()}); following it`);
  } else {
    hooks.step('working out the commits to build');
    const src = sourcesOf(spec);
    const overlayBytes = src.overlay.reduce((n, f) => n + f.size, 0);
    if (overlayBytes > OVERLAY_MAX) throw fail(`${src.overlay.length} uncommitted files (${mb(overlayBytes)}) differ from GitHub: commit and push them, or use the build server.`, 'source');
    for (const r of src.repos) hooks.log(`${r.slug} at ${r.commit.slice(0, 12)}${r.branch ? ` (${r.branch})` : ''}${r.sparse.length ? `: ${r.sparse.join(', ')}` : ''}`);
    const keys = cacheKeys({ branch: src.projectBranch, explicit: opts.cache });
    const stateKey = keys.save ?? keys.restore[0];
    const decision = shouldRunClean(cacheStateOf(repo, stateKey), opts.clean);
    if (decision.clean) hooks.log(`clean build: ${decision.reason}`);
    const prefix = `unity-builds/${jobId}`;
    hooks.step('uploading the build inputs');
    let overlay: string | null = null;
    if (src.overlay.length) {
      const tgz = await packFiles(src.overlay, tmp, 'overlay');
      await gcsWrite(bucket, `${prefix}/overlay.tgz`, tgz);
      overlay = `${prefix}/overlay.tgz`;
      hooks.log(`${src.overlay.length} uncommitted files (${mb(overlayBytes)}) go with the build`);
    }
    let siteIn: string | null = null;
    let stubs: Record<string, number> = {};
    if (spec.site) {
      const s = siteInput(spec.site, spec.siteDir);
      const stubFiles = [...s.stubs.entries()].map(([dir, omitted]) => {
        const f = path.join(tmp, `stub-${dir.replace(/\//g, '_')}`);
        fs.writeFileSync(f, `Hawkes Gen cloud build: ${omitted.length} big files of this folder stay on the machine that started the build.\n${omitted.join('\n')}\n`);
        return { key: `${spec.site}/${dir}/${STUB}`, file: f, size: 0 };
      });
      const tgz = await packFiles([...s.keep, ...stubFiles], tmp, 'site');
      await gcsWrite(bucket, `${prefix}/site-in.tgz`, tgz);
      siteIn = `${prefix}/site-in.tgz`;
      stubs = Object.fromEntries([...s.stubs.entries()].map(([d, o]) => [d, o.length]));
      hooks.log(`website input: ${s.keep.length} files (${mb(fs.statSync(tgz).size)} packed)${Object.keys(stubs).length ? `; ${Object.keys(stubs).join(', ')} stubbed` : ''}`);
    }
    const body = {
      v: 1, job: jobId, unity, target, project: spec.project, site: spec.site ?? null,
      method: spec.method ?? null, tests: spec.tests ?? null, testFilter: spec.testFilter ?? null,
      args: spec.args ?? [], env: spec.env ?? {},
      repos: src.repos, overlay, deletes: src.deletes, siteInput: siteIn,
      cache: { bucket, prefix: `unity-cache/${repo}`, restore: decision.clean ? [] : keys.restore, save: keys.save, clean: decision.clean, reason: decision.reason, exclude: CACHE_EXCLUDE },
      out: { bucket, prefix },
      timeoutMinutes: cfg.timeoutMinutes,
    };
    await gcsWrite(bucket, `${prefix}/spec.json`, Buffer.from(JSON.stringify(body, null, 2)), 'application/json');
    hooks.step('starting the cloud build');
    // The execution may run 15 minutes past the build's own limit (fetch, cache, upload); Gen cancels it after that.
    const execution = await runJob(cfg.target, { HAWKES_SPEC: `gs://${bucket}/${prefix}/spec.json` }, (cfg.timeoutMinutes + 15) * 60);
    job = { execution, prefix, started: Date.now(), repo, saveKey: keys.save, stateKey, clean: decision.clean };
    saveJob(jobId, job);
    hooks.log(`cloud build started: ${execution.split('/').pop()} (Unity ${unity}, ${target}${spec.method ? `, ${spec.method}` : ''}${decision.clean ? ', clean' : ''})`);
  }

  // Follow the execution and its log.
  const deadline = job.started + (cfg.timeoutMinutes + 25) * 60_000;
  let since = new Date(job.started - 60_000).toISOString();
  let lastStep = '';
  let licenseLine = '';
  let state = await getExecution(job.execution);
  hooks.step('waiting for the cloud machine');
  for (;;) {
    if (hooks.signal?.aborted) {
      await cancelExecution(job.execution);
      fs.rmSync(jobFile(jobId), { force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
      throw fail('cancelled', 'cancelled');
    }
    try {
      const l = await executionLogs(cfg.target.project, job.execution, since);
      since = l.last;
      for (const line of l.lines) {
        if (LICENSE_RE.test(line)) licenseLine ||= line.trim();
        const s = progressOf(line);
        if (s && s !== lastStep) {
          lastStep = s;
          hooks.step(s);
          if (/error|fail|license|Deploy|Step \d|\[Hawkes\]|Exiting/i.test(s)) hooks.log(s);
        }
      }
    } catch (e: any) {
      hooks.log(`(couldn't read the cloud build's log: ${e.message}; retrying)`);
    }
    if (state.done) break;
    if (Date.now() > deadline) {
      await cancelExecution(job.execution);
      fs.rmSync(jobFile(jobId), { force: true });
      recordBuild(job.repo, job.stateKey, { ok: false, failure: 'other', at: new Date().toISOString(), job: jobId, kind: 'timeout', clean: job.clean }, cfg.cleanAfterFailures);
      fs.rmSync(tmp, { recursive: true, force: true });
      throw fail(`The cloud build ran past its limit (${cfg.timeoutMinutes} minutes plus 25 for setup) and was cancelled (last step: ${lastStep || 'none'}).`, 'timeout');
    }
    await new Promise((r) => setTimeout(r, 10_000));
    try {
      state = await getExecution(job.execution);
    } catch (e: any) {
      hooks.log(`(couldn't reach Cloud Run: ${e.message}; retrying)`);
    }
  }
  fs.rmSync(jobFile(jobId), { force: true });
  return finishCloudBuild(jobId, spec, hooks, { job, state, tmp, t0, cpu: cfg.gcp.cpu, gib: cfg.gcp.memoryGiB, bucket, cleanAfter: cfg.cleanAfterFailures, licenseLine });
}

async function finishCloudBuild(jobId: string, spec: BuildSpec, hooks: BuildHooks, o: { job: CloudJob; state: Awaited<ReturnType<typeof getExecution>>; tmp: string; t0: number; cpu: number; gib: number; bucket: string; cleanAfter: number; licenseLine: string }) {
  const { job, state, tmp, bucket } = o;
  const ran = state.started && state.completed ? (Date.parse(state.completed) - Date.parse(state.started)) / 1000 : (Date.now() - job.started) / 1000;
  const seconds = Math.round((Date.now() - o.t0) / 1000);
  const cost = cloudRunCost(ran, o.cpu, o.gib);
  const raw = await gcsRead(bucket, `${job.prefix}/result.json`).catch(() => null);
  const logBuf = (await gcsRead(bucket, `${job.prefix}/unity.log`).catch(() => null)) ?? Buffer.from('');
  const logText = logBuf.toString('utf8');
  const logTail = logText.split(/\r?\n/).slice(-60).join('\n');
  const base = { exitCode: null as number | null, seconds, cost, log: logBuf, results: null as Buffer | null, logTail, tmp, project: [] as string[], site: null as null | { changed: string[]; deleted: string[]; bytes: number } };
  const at = new Date().toISOString();
  let result: CloudResult | null = null;
  try {
    if (raw) result = parseCloudResult(raw);
  } catch (e: any) {
    hooks.log(`(the cloud build's result couldn't be read: ${e.message})`);
  }
  if (!result) {
    const why = state.cancelled ? 'it was cancelled in Cloud Run' : state.message || 'no result.json';
    recordBuild(job.repo, job.stateKey, { ok: false, failure: failureKind(logText), at, job: jobId, clean: job.clean }, o.cleanAfter);
    return { ...base, ok: false, error: `The cloud build ended without a result (${why}; execution ${job.execution.split('/').pop()}).`, kind: 'builder', errors: [] as string[], cloud: { execution: job.execution } };
  }
  const cloud = { execution: job.execution, cache: result.cache, stages: result.seconds, memoryPeakBytes: result.memoryPeakBytes, ranSeconds: Math.round(ran) };
  if (result.cache.restoredFrom) hooks.log(`Library cache: restored ${result.cache.restoredFrom} (${mb(result.cache.restoredBytes)})`);
  else hooks.log(`Library cache: none restored${result.cache.reason ? ` (${result.cache.reason})` : ''}`);
  if (result.cache.saved) hooks.log(`Library cache: saved ${result.cache.savedKey} (${mb(result.cache.savedBytes)})`);
  else if (result.cache.skipped) hooks.log(`Library cache: not saved (${result.cache.skipped})`);

  let results: Buffer | null = null;
  if (spec.tests && result.results) results = await gcsRead(bucket, result.results).catch(() => null);
  if (spec.tests && results) {
    recordBuild(job.repo, job.stateKey, { ok: true, at, job: jobId, restored: result.cache.restoredFrom, clean: job.clean }, o.cleanAfter);
    return { ...base, exitCode: result.exitCode, results, ok: true, error: null, kind: null, errors: [] as string[], cloud };
  }

  if (!result.ok) {
    const lines = logText.split(/\r?\n/);
    const hardLicense = result.kind === 'license' ? (result.error ?? o.licenseLine) : lines.find((l) => HARD_LICENSE_RE.test(l));
    const kind = hardLicense ? 'license' : result.kind ?? 'build';
    recordBuild(job.repo, job.stateKey, { ok: false, failure: failureKind(logText, kind), at, job: jobId, kind, restored: result.cache.restoredFrom, clean: job.clean }, o.cleanAfter);
    if (hardLicense) {
      return { ...base, exitCode: result.exitCode, ok: false, error: `Unity isn't licensed in the cloud build (${String(hardLicense).trim().slice(0, 300)}). Put the contents of Unity_lic.ulf in the secret unity-license (docs/unity-cloudrun.md, "License"), then build again.`, kind: 'license', errors: result.errors, cloud };
    }
    const errors = result.errors.length ? result.errors : [...new Set(lines.filter((l) => /\[GameDeploy\].*(ERROR|FAILED)|DEPLOY FAILED|\[Hawkes\].*(error|failed)|error CS\d+|BuildFailedException|Build Failed|Exception:|error:/i.test(l) && !/Licensing::/i.test(l)).map((l) => l.trim()))].slice(0, 20);
    const lastLine = errors[0] ?? lines.filter((l) => l.trim() && !/Licensing::/i.test(l)).slice(-1)[0]?.trim();
    const error = result.error ? `${result.error}${lastLine && !result.error.includes(lastLine) ? `: ${lastLine}` : ''}` : `Unity exited with code ${result.exitCode}${lastLine ? `: ${lastLine}` : ''}`;
    return { ...base, exitCode: result.exitCode, ok: false, error, kind, errors, cloud };
  }

  // Lay the website changes into the site folder here.
  let site: { changed: string[]; deleted: string[]; bytes: number } | null = null;
  if (spec.site && result.output) {
    const out = result.output;
    const changed = out.changed.map((f) => `${spec.site}/${f.path}`);
    const bytes = out.changed.reduce((n, f) => n + f.size, 0);
    const deletedDirs: string[] = [];
    const deleted: string[] = [];
    for (const rel of out.deleted) {
      const dir = stubFolderOf(rel);
      if (dir) deletedDirs.push(`${spec.site}/${dir}`);
      else deleted.push(`${spec.site}/${rel}`);
    }
    let tgz: string | null = null;
    if (changed.length) {
      hooks.step('downloading the build');
      tgz = path.join(tmp, 'site.tgz');
      await gcsDownload(bucket, out.object, tgz);
      hooks.log(`downloading ${changed.length} files (${mb(bytes)}) into ${spec.siteDir ? path.relative(paths.projects, spec.siteDir).replace(/\\/g, '/') : spec.site}`);
    }
    await applyPulledSite(spec as BuildSpec & { site: string }, tmp, tgz, changed, deleted, deletedDirs);
    site = { changed, deleted: [...deleted, ...deletedDirs], bytes };
  }
  recordBuild(job.repo, job.stateKey, { ok: true, at, job: jobId, restored: result.cache.restoredFrom, clean: job.clean }, o.cleanAfter);
  // The build's inputs and outputs aren't needed any more (the result and the log stay for a look later).
  for (const k of ['overlay.tgz', 'site-in.tgz', 'site.tgz']) await gcsDelete(bucket, `${job.prefix}/${k}`).catch(() => {});
  return { ...base, exitCode: result.exitCode ?? 0, ok: true, error: null, kind: null, errors: [] as string[], site, cloud };
}

// ------------------------------------------------------------- the caches

export type CacheRow = { repo: string; key: string; bytes: number; libraryBytes: number | null; files: number | null; savedAt: string; ageDays: number; unity: string | null; commit: string | null; streak: number; cleanNext: boolean; lastBuild: unknown };

/** Every Library cache in the bucket, with what made it and how its builds went. */
export async function listCaches(): Promise<CacheRow[]> {
  const { gcp } = cloudConfig();
  const objects = await gcsList(gcp.bucket, 'unity-cache/');
  const rows: CacheRow[] = [];
  for (const o of objects) {
    const m = /^unity-cache\/([^/]+)\/([^/]+)\.tar\.zst$/.exec(o.name);
    if (!m) continue;
    const meta = await gcsRead(gcp.bucket, `unity-cache/${m[1]}/${m[2]}.json`).then((b) => (b ? JSON.parse(b.toString('utf8')) : {})).catch(() => ({}));
    const st = cacheStateOf(m[1], m[2]);
    const savedAt = String(meta.savedAt ?? o.updated);
    rows.push({
      repo: m[1], key: m[2], bytes: o.size, libraryBytes: meta.libraryBytes ?? null, files: meta.files ?? null, savedAt,
      ageDays: Math.round((Date.now() - Date.parse(savedAt)) / 8.64e6) / 10, unity: meta.unity ?? null, commit: meta.commit ?? null,
      streak: st?.streak ?? 0, cleanNext: Boolean(st?.cleanNext), lastBuild: st?.lastBuild ?? null,
    });
  }
  return rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.key.localeCompare(b.key));
}

/** Deletes one repo's caches (or one key): the next build of it starts from a clean import and saves a new one. */
export async function clearCache(repoOrProject: string, key?: string) {
  const { gcp } = cloudConfig();
  const repo = cacheRepo(repoOrProject);
  const objects = await gcsList(gcp.bucket, `unity-cache/${repo}/`);
  const gone: string[] = [];
  for (const o of objects) {
    const k = /\/([^/]+)\.(tar\.zst|json)$/.exec(o.name)?.[1];
    if (key && k !== key) continue;
    await gcsDelete(gcp.bucket, o.name);
    gone.push(o.name);
  }
  forgetCache(repo, key);
  return { repo, key: key ?? null, deleted: gone };
}
