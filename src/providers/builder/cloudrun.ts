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
import { paths, loadSettings, saveSettings } from '../../config.ts';
import { GenError } from '../../util.ts';
import {
  type BuildSpec, type BuildHooks, UNITY_EXCLUDE, SITE_EXCLUDE, standIn, unityVersionOf, localPackages, repoOf, walk, localGit,
  progressOf, LICENSE_RE, HARD_LICENSE_RE, applyPulledSite, proc, TAR, mb, localFile,
} from './builder.ts';
import { gcsWrite, gcsRead, gcsDownload, gcsList, gcsDelete, runJob, getExecution, cancelExecution, executionLogs, jobExists, regionOfExecution, type CloudRunTarget } from './gcp.ts';
import {
  cacheKeys, cacheRepo, cacheStateOf, recordBuild, shouldRunClean, failureKind, parseCloudResult, forgetCache, stubFolderOf,
  siteInputKeep, STUB, type CloudResult,
} from './cache.ts';
import { githubRepos, githubSite, buildCommitMessage, R2_BUILDS } from './github.ts';
import { customerCacheRepo, DEFAULT_METHOD, checkCustomerJob, customerSignedUrls, customerUrlSeconds } from './customer.ts';
import { signer as gcsSigner, signedUrl, type Signer } from '../gpu/sign.ts';

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
// The running execution is noted here and next to the build's spec in the bucket: on Cloud Run this folder is the
// instance's memory, so a replaced instance found no note, started the build again beside the one still running, and
// the second waited for the first's quota (Sick Of It, 2026-10-29).
const jobKey = (jobId: string) => `unity-builds/${jobId}/cloud-job.json`;
async function loadJob(jobId: string, bucket?: string): Promise<CloudJob | null> {
  try { return JSON.parse(fs.readFileSync(jobFile(jobId), 'utf8')); } catch {}
  if (!bucket) return null;
  try { const b = await gcsRead(bucket, jobKey(jobId)); return b ? JSON.parse(b.toString('utf8')) : null; } catch { return null; }
}
async function saveJob(jobId: string, j: CloudJob, bucket?: string) {
  fs.mkdirSync(path.dirname(jobFile(jobId)), { recursive: true });
  fs.writeFileSync(jobFile(jobId), JSON.stringify(j));
  if (bucket) await gcsWrite(bucket, jobKey(jobId), Buffer.from(JSON.stringify(j)), 'application/json').catch(() => {});
}

/** Whether this job's cloud build was already started (noted here or in the bucket): it is followed, not started again. */
export async function cloudBuildStarted(jobId: string) {
  return Boolean(await loadJob(jobId, cloudConfig().gcp.bucket));
}

// ------------------------------------------------------------------ build

export type BuildOptions = { cache?: string; clean?: boolean };

/** The checks every backend makes first; returns the spec with its stand-ins resolved and the Unity version. */
export function checkBuild(spec: BuildSpec, cfg: ReturnType<typeof cloudConfig>, where: string) {
  const target = spec.target ?? 'WebGL';
  if (spec.customer) {
    // Customer mode: Gen read the project's Unity version from GitHub and picked the job of that image (customer.ts).
    if (target !== 'WebGL') throw fail(`Builds ${where} make WebGL only (the image has the WebGL module); target "${target}" can't be built in the cloud.`, 'config');
    if (spec.projectDir || spec.siteDir || spec.site || spec.tests || spec.github) throw fail('a customer build takes only its repo, commit, path and method: the output comes back as an asset.');
    return { spec, unity: spec.customer.version, target };
  }
  if (spec.github) {
    // Nothing here to read: the container checks ProjectSettings/ProjectVersion.txt against the image itself.
    if (target !== 'WebGL') throw fail(`Builds ${where} make WebGL only (the image has the WebGL module); ${target} needs the build server.`, 'config');
    if (spec.projectDir || spec.siteDir) throw fail('projectDir and siteDir are for builds from folders here; a GitHub-mode build fetches its sources and pushes its own result.');
    if (spec.tests) throw fail('GitHub mode builds and pushes; run tests from folders (unity.test).');
    if (!spec.site) throw fail('a GitHub-mode build needs site (the website folder its build method writes).');
    return { spec, unity: cfg.gcp.unity, target };
  }
  spec = { ...spec, projectDir: standIn(spec.projectDir, 'projectDir'), siteDir: standIn(spec.siteDir, 'siteDir') };
  if (spec.siteDir && !spec.site) throw fail('siteDir needs site (the website folder it stands in for).');
  if (target !== 'WebGL') throw fail(`Builds ${where} make WebGL only (the image has the WebGL module); ${target} needs the build server.`, 'config');
  const unity = unityVersionOf(spec.project, spec.projectDir);
  if (unity !== cfg.gcp.unity) throw fail(`${spec.project} uses Unity ${unity}, but the build image has ${cfg.gcp.unity}. Build a new image for it (tools/unity-cloudrun/build-image.mjs) or use the build server.`, 'config');
  return { spec, unity, target };
}

export type Prepared = { prefix: string; specUri: string; repo: string; saveKey: string | null; stateKey: string; clean: boolean; restore: string[] };

/** Works out the commits, uploads the inputs and writes spec.json; the same for Cloud Run and the build VM. */
export async function prepareBuild(jobId: string, spec: BuildSpec, unity: string, target: string, hooks: BuildHooks, opts: BuildOptions, cfg: ReturnType<typeof cloudConfig>, tmp: string): Promise<Prepared> {
  const bucket = cfg.gcp.bucket;
  const cust = spec.customer;
  // A customer's Library cache is its own (per Gen project and repo): never J's, never another customer's.
  const repo = cust ? customerCacheRepo(cust.owner, cust.repo, cust.path) : cacheRepo(spec.project);
  hooks.step('working out the commits to build');
  const gh = spec.github;
  // GitHub mode: the commit asked for, nothing uncommitted, no website from here (the container checks out its branch).
  // Customer mode: the whole repo at that commit (a project may use packages beside it), nothing from here.
  const src = cust ? { repos: [{ slug: cust.repo, top: 'src', commit: cust.commit, branch: null, sparse: [] }] as RepoSpec[], overlay: [] as { key: string; file: string; size: number }[], deletes: [] as string[], projectBranch: null as string | null }
    : gh ? { repos: githubRepos(gh, spec.project), overlay: [] as { key: string; file: string; size: number }[], deletes: [] as string[], projectBranch: gh.cacheBranch } : sourcesOf(spec);
  if (gh) hooks.log(`GitHub mode${gh.ref ? ` (${gh.ref})` : ''}: the build is pushed to ${gh.siteRepo} ${gh.branch}; packages ${Object.entries(gh.packages).map(([k, v]) => `${k}@${v}`).join(', ')}`);
  const overlayBytes = src.overlay.reduce((n, f) => n + f.size, 0);
  if (overlayBytes > OVERLAY_MAX) throw fail(`${src.overlay.length} uncommitted files (${mb(overlayBytes)}) differ from GitHub: commit and push them, or use the build server.`, 'source');
  for (const r of src.repos) hooks.log(`${r.slug} at ${r.commit.slice(0, 12)}${r.branch ? ` (${r.branch})` : ''}${r.sparse.length ? `: ${r.sparse.join(', ')}` : ''}`);
  const keys = cust ? cacheKeys({ explicit: 'build' }) : cacheKeys({ branch: src.projectBranch, explicit: opts.cache });
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
  if (spec.site && !gh) {
    const s = siteInput(spec.site, spec.siteDir);
    const stubFiles = [...s.stubs.entries()].map(([dir, omitted]) => {
      const f = path.join(tmp, `stub-${dir.replace(/\//g, '_')}`);
      fs.writeFileSync(f, `Hawkes Gen cloud build: ${omitted.length} big files of this folder stay on the machine that started the build.\n${omitted.join('\n')}\n`);
      return { key: `${spec.site}/${dir}/${STUB}`, file: f, size: 0 };
    });
    const tgz = await packFiles([...s.keep, ...stubFiles], tmp, 'site');
    await gcsWrite(bucket, `${prefix}/site-in.tgz`, tgz);
    siteIn = `${prefix}/site-in.tgz`;
    const stubbed = [...s.stubs.keys()];
    hooks.log(`website input: ${s.keep.length} files (${mb(fs.statSync(tgz).size)} packed)${stubbed.length ? `; ${stubbed.join(', ')} stubbed` : ''}`);
  }
  const body = {
    v: 1, job: jobId, unity, target, project: spec.project, site: spec.site ?? null,
    method: cust ? spec.method ?? DEFAULT_METHOD : spec.method ?? null, tests: spec.tests ?? null, testFilter: spec.testFilter ?? null,
    args: spec.args ?? [], env: spec.env ?? {},
    repos: src.repos, overlay, deletes: src.deletes, siteInput: siteIn,
    cache: { bucket, prefix: `unity-cache/${repo}`, restore: decision.clean ? [] : keys.restore, save: keys.save, clean: decision.clean, reason: decision.reason, exclude: CACHE_EXCLUDE },
    out: { bucket, prefix },
    timeoutMinutes: cfg.timeoutMinutes,
    // Customer mode (customer.ts): no token here; it goes to the execution as HAWKES_GITHUB_TOKEN only.
    customer: cust ? { repo: cust.repo, commit: cust.commit, ref: cust.ref, path: cust.path, defaultMethod: !spec.method, out: 'artifact' } : null,
    github: gh ? { owner: gh.repo.split('/')[0], site: githubSite(gh, spec.site!), packages: gh.packages, ref: gh.ref, message: buildCommitMessage(gh, spec.project), builds: gh.builds ? { game: gh.builds, ...R2_BUILDS, ...(loadSettings().unityBuild as any).r2 } : null } : null,
  };
  await gcsWrite(bucket, `${prefix}/spec.json`, Buffer.from(JSON.stringify(body, null, 2)), 'application/json');
  return { prefix, specUri: `gs://${bucket}/${prefix}/spec.json`, repo, saveKey: keys.save, stateKey, clean: decision.clean, restore: decision.clean ? [] : keys.restore };
}

/**
 * The signed URLs of one customer build (customer.ts customerSignedUrls): a restore key gets GET URLs only when its
 * archive is in the bucket; they live the build's limit plus 30 minutes.
 */
export async function customerSigned(cfg: ReturnType<typeof cloudConfig>, p: Prepared, s: Signer) {
  const bucket = cfg.gcp.bucket;
  const cachePrefix = `unity-cache/${p.repo}`;
  const have = p.restore.length ? new Set((await gcsList(bucket, `${cachePrefix}/`)).map((o) => o.name)) : new Set<string>();
  const seconds = customerUrlSeconds(cfg.timeoutMinutes);
  return customerSignedUrls({
    bucket, prefix: p.prefix, cachePrefix, restore: p.restore.filter((k) => have.has(`${cachePrefix}/${k}.tar.zst`)), save: p.saveKey,
    sign: (method, key) => signedUrl(method, `gs://${bucket}/${key}`, s, seconds),
  });
}

/** Shows the build's progress lines (the same as the build server's) and remembers the first license line. */
export function progressFollower(hooks: BuildHooks) {
  const f = {
    lastStep: '', licenseLine: '',
    take(lines: string[]) {
      for (const line of lines) {
        if (LICENSE_RE.test(line)) f.licenseLine ||= line.trim();
        const s = progressOf(line);
        if (s && s !== f.lastStep) {
          f.lastStep = s;
          hooks.step(s);
          if (/error|fail|license|Deploy|Step \d|\[Hawkes\]|Exiting/i.test(s)) hooks.log(s);
        }
      }
    },
  };
  return f;
}

/** Builds on Cloud Run; resolves to the same shape as builder.ts runBuild. */
/** How long a build waits for a machine in one region before trying the next. */
const CAPACITY_WAIT_MS = 3 * 60_000;

/** The build's regions in order: the main one, then settings.unityBuild.gcp.regions. */
export const regionsOf = (cfg: { gcp: { region: string; regions?: string[] } }) => [cfg.gcp.region, ...(cfg.gcp.regions ?? []).filter((r) => r !== cfg.gcp.region)];

/** Starts the execution in the first region from `from` that has the job (customer jobs checked there too); a region
 *  whose job is missing, or that refuses the start (quota, unavailable), is skipped with a log line. */
async function startInRegion(regions: string[], from: number, target: CloudRunTarget, envs: Record<string, string>, timeoutMinutes: number, customer: boolean, hooks: BuildHooks): Promise<{ name: string }> {
  let last: unknown = null;
  for (let i = from; i < regions.length; i++) {
    const t = { ...target, region: regions[i] };
    try {
      if (i > 0 && !(await jobExists(t))) { hooks.log(`(${regions[i]} has no ${t.job} job; skipped)`); continue; }
      if (customer && i > 0) await checkCustomerJob(t);
      return { name: await runJob(t, envs, (timeoutMinutes + 15) * 60) };
    } catch (e: any) {
      last = e;
      if (i === regions.length - 1) break;
      hooks.log(`(${regions[i]} couldn't start the build: ${e.message}; trying ${regions[i + 1]})`);
    }
  }
  throw last ?? fail(`None of the build regions (${regions.slice(from).join(', ')}) has the job ${target.job}.`, 'config');
}

export async function runCloudBuild(jobId: string, spec: BuildSpec, hooks: BuildHooks, opts: BuildOptions = {}) {
  const t0 = Date.now();
  const cfg = cloudConfig();
  const checked = checkBuild(spec, cfg, 'on Cloud Run');
  spec = checked.spec;
  const tmp = fs.mkdtempSync(path.join(paths.tmp, 'cloudbuild-'));

  let job = await loadJob(jobId, cfg.gcp.bucket);
  // The env the build was started with, kept in memory only (a customer's token is in it) so a full region can hand it on.
  let startEnvs: Record<string, string> | null = null;
  const baseTarget = spec.customer ? { ...cfg.target, job: spec.customer.job } : cfg.target;
  if (job) {
    hooks.log(`the cloud build was already started (${job.execution.split('/').pop()}); following it`);
  } else {
    let p: Prepared;
    // Customer mode: only on the customer job (its account reaches nothing), checked before anything is uploaded.
    const target = baseTarget;
    let sign: Signer | null = null;
    try {
      if (spec.customer) {
        await checkCustomerJob(target);
        sign = await gcsSigner();
        if (!sign) throw fail('Customer builds reach the bucket only through signed URLs, and Hawkes Gen can\'t sign here: on Cloud Run it signs as its own service account (roles/iam.serviceAccountTokenCreator on itself); on a PC set HAWKESGEN_GCP_IMPERSONATE to that account.', 'config');
      }
      p = await prepareBuild(jobId, spec, checked.unity, checked.target, hooks, opts, cfg, tmp);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    hooks.step('starting the cloud build');
    // The execution may run 15 minutes past the build's own limit (fetch, cache, upload); Gen cancels it after that.
    // Customer mode: the customer job of the project's Unity version, the customer's token for this execution only, and
    // one signed URL per object the container may touch (its account has no access to the bucket).
    const envs: Record<string, string> = { HAWKES_SPEC: p.specUri };
    if (spec.customer) {
      envs.HAWKES_GITHUB_TOKEN = spec.customer.token;
      envs.HAWKES_SIGNED = JSON.stringify(await customerSigned(cfg, p, sign!));
    }
    startEnvs = envs;
    const execution = await startInRegion(regionsOf(cfg), 0, target, envs, cfg.timeoutMinutes, !!spec.customer, hooks);
    job = { execution: execution.name, prefix: p.prefix, started: Date.now(), repo: p.repo, saveKey: p.saveKey, stateKey: p.stateKey, clean: p.clean };
    await saveJob(jobId, job, cfg.gcp.bucket);
    hooks.log(`cloud build started: ${execution.name.split('/').pop()} in ${regionOfExecution(execution.name)} (Unity ${checked.unity}, ${checked.target}${spec.method ? `, ${spec.method}` : ''}${p.clean ? ', clean' : ''})`);
  }

  // Follow the execution and its log.
  const deadline = job.started + (cfg.timeoutMinutes + 25) * 60_000;
  let since = new Date(job.started - 60_000).toISOString();
  const follow = progressFollower(hooks);
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
      follow.take(l.lines);
    } catch (e: any) {
      hooks.log(`(couldn't read the cloud build's log: ${e.message}; retrying)`);
    }
    if (state.done) break;
    // No machine free in this region: hand the build to the next region that has the job (only while this process has
    // the env it started with; a resumed follow just waits).
    if (state.waitingForCapacity && startEnvs && Date.now() - job.started > CAPACITY_WAIT_MS) {
      const regions = regionsOf(cfg);
      const at = regions.indexOf(regionOfExecution(job.execution));
      if (at >= 0 && at < regions.length - 1) {
        try {
          const next = await startInRegion(regions, at + 1, baseTarget, startEnvs, cfg.timeoutMinutes, !!spec.customer, hooks);
          await cancelExecution(job.execution);
          hooks.log(`${regionOfExecution(job.execution)} had no machine free for ${Math.round((Date.now() - job.started) / 60_000)} min: moved the build to ${regionOfExecution(next.name)} (${next.name.split('/').pop()})`);
          job = { ...job, execution: next.name, started: Date.now() };
          await saveJob(jobId, job, cfg.gcp.bucket);
          state = await getExecution(job.execution);
          continue;
        } catch (e: any) {
          hooks.log(`(no other region could take the build: ${e.message}; waiting here)`);
          startEnvs = null;
        }
      }
    }
    if (Date.now() > deadline) {
      await cancelExecution(job.execution);
      fs.rmSync(jobFile(jobId), { force: true });
      recordBuild(job.repo, job.stateKey, { ok: false, failure: 'other', at: new Date().toISOString(), job: jobId, kind: 'timeout', clean: job.clean }, cfg.cleanAfterFailures);
      fs.rmSync(tmp, { recursive: true, force: true });
      throw fail(`The cloud build ran past its limit (${cfg.timeoutMinutes} minutes plus 25 for setup) and was cancelled (last step: ${follow.lastStep || 'none'}).`, 'timeout');
    }
    await new Promise((r) => setTimeout(r, 10_000));
    try {
      state = await getExecution(job.execution);
    } catch (e: any) {
      hooks.log(`(couldn't reach Cloud Run: ${e.message}; retrying)`);
    }
  }
  fs.rmSync(jobFile(jobId), { force: true });
  const ran = state.started && state.completed ? (Date.parse(state.completed) - Date.parse(state.started)) / 1000 : (Date.now() - job.started) / 1000;
  const oom = /memory limit|out of memory|OOM/i.test(state.message);
  const r = await finishBuildResult(jobId, spec, hooks, {
    job: { ...job, label: `execution ${job.execution.split('/').pop()}` }, ran, cost: cloudRunCost(ran, cfg.gcp.cpu, cfg.gcp.memoryGiB), tmp, t0,
    bucket: cfg.gcp.bucket, cleanAfter: cfg.cleanAfterFailures, licenseLine: follow.licenseLine,
    noResult: state.cancelled ? 'it was cancelled in Cloud Run' : state.message || 'no result.json',
  });
  // Too big for Cloud Run: the next build of this project goes to its build VM (vm.ts), and the job says so.
  const limit = cfg.gcp.memoryGiB * 1024 ** 3;
  const peak = (r.cloud as { memoryPeakBytes?: number | null } | undefined)?.memoryPeakBytes ?? null;
  const move = !spec.customer && shouldMoveToVm({ peakBytes: peak, limitBytes: limit, oom: oom && !r.ok, at: cfg.vmAt });
  if (move) {
    const moved = markProjectForVm(spec.project);
    const msg = `${spec.project} ${move === 'oom' ? 'ran out of memory on Cloud Run' : `peaked at ${mb(peak!)} of Cloud Run's ${cfg.gcp.memoryGiB} GiB (over ${Math.round(cfg.vmAt * 100)}%)`}: ${moved ? 'its next build runs on its build VM (settings.unityBuild.projects); make the VM first if it isn\'t there: node tools/unity-cloudrun/vm.mjs --folder <project> --apply' : 'it already builds on its VM'}.`;
    hooks.log(msg);
    (r as { movedToVm?: string }).movedToVm = msg;
  }
  return r;
}

/** Whether a Cloud Run build was too big for Cloud Run: its peak passed `at` of the limit, or it was killed for memory. */
export function shouldMoveToVm({ peakBytes, limitBytes, oom, at }: { peakBytes: number | null; limitBytes: number; oom: boolean; at: number }): 'oom' | 'peak' | null {
  if (at <= 0) return null;
  if (oom) return 'oom';
  return peakBytes !== null && peakBytes > at * limitBytes ? 'peak' : null;
}

/** Sets the project's backend to "vm"; false when it already was. */
export function markProjectForVm(project: string) {
  const u = loadSettings().unityBuild;
  const key = project.replace(/\\/g, '/');
  if (u.projects[key] === 'vm') return false;
  saveSettings({ unityBuild: { ...u, projects: { ...u.projects, [key]: 'vm' } } });
  return true;
}

export type FinishOptions = {
  job: { prefix: string; repo: string; stateKey: string; clean: boolean; label: string; execution?: string; instance?: string };
  ran: number; cost: number; tmp: string; t0: number; bucket: string; cleanAfter: number; licenseLine: string; noResult: string;
};

/** Reads result.json and the log, lays the website changes down, records the cache outcome (both cloud backends). */
export async function finishBuildResult(jobId: string, spec: BuildSpec, hooks: BuildHooks, o: FinishOptions) {
  const { job, tmp, bucket } = o;
  const seconds = Math.round((Date.now() - o.t0) / 1000);
  const raw = await gcsRead(bucket, `${job.prefix}/result.json`).catch(() => null);
  const logBuf = (await gcsRead(bucket, `${job.prefix}/unity.log`).catch(() => null)) ?? Buffer.from('');
  const logText = logBuf.toString('utf8');
  const logTail = logText.split(/\r?\n/).slice(-60).join('\n');
  const base = { exitCode: null as number | null, seconds, cost: o.cost, log: logBuf, results: null as Buffer | null, logTail, tmp, project: [] as string[], site: null as null | { changed: string[]; deleted: string[]; bytes: number } };
  const at = new Date().toISOString();
  let result: CloudResult | null = null;
  try {
    if (raw) result = parseCloudResult(raw);
  } catch (e: any) {
    hooks.log(`(the build's result couldn't be read: ${e.message})`);
  }
  const where = { execution: job.execution, instance: job.instance };
  if (!result) {
    recordBuild(job.repo, job.stateKey, { ok: false, failure: failureKind(logText), at, job: jobId, clean: job.clean }, o.cleanAfter);
    return { ...base, ok: false, error: `The build ended without a result (${o.noResult}; ${job.label}).`, kind: 'builder', errors: [] as string[], cloud: { ...where, memoryPeakBytes: null as number | null } };
  }
  const cloud = { ...where, cache: result.cache, stages: result.seconds, memoryPeakBytes: result.memoryPeakBytes, ranSeconds: Math.round(o.ran) };
  if (result.cache.restoredFrom) hooks.log(`Library cache: restored ${result.cache.restoredFrom}${result.cache.restoredBytes ? ` (${mb(result.cache.restoredBytes)})` : ''}`);
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
    if (hardLicense) return { ...base, exitCode: result.exitCode, ok: false, error: licenseMessage(String(hardLicense)), kind: 'license', errors: result.errors, cloud };
    const errors = result.errors.length ? result.errors : [...new Set(lines.filter((l) => /\[GameDeploy\].*(ERROR|FAILED)|DEPLOY FAILED|\[Hawkes\].*(error|failed)|error CS\d+|BuildFailedException|Build Failed|Exception:|error:/i.test(l) && !/Licensing::/i.test(l)).map((l) => l.trim()))].slice(0, 20);
    const lastLine = errors[0] ?? lines.filter((l) => l.trim() && !/Licensing::/i.test(l)).slice(-1)[0]?.trim();
    const error = result.error ? `${result.error}${lastLine && !result.error.includes(lastLine) ? `: ${lastLine}` : ''}` : `Unity exited with code ${result.exitCode}${lastLine ? `: ${lastLine}` : ''}`;
    return { ...base, exitCode: result.exitCode, ok: false, error, kind, errors, cloud };
  }

  // Customer mode: the output folder came back as one .tar.gz; the tool keeps it as a library asset.
  if (spec.customer) {
    const out = result.output;
    if (!out || out.object !== `${job.prefix}/artifact.tgz`) {
      recordBuild(job.repo, job.stateKey, { ok: false, failure: 'other', at, job: jobId, kind: 'output', clean: job.clean }, o.cleanAfter);
      return { ...base, exitCode: result.exitCode, ok: false, error: 'The build finished but sent back no output.', kind: 'output', errors: [] as string[], cloud };
    }
    hooks.step('downloading the build');
    const file = path.join(tmp, 'artifact.tgz');
    await gcsDownload(bucket, out.object, file);
    hooks.log(`build output: ${out.files ?? 0} files, ${mb(fs.statSync(file).size)} packed`);
    recordBuild(job.repo, job.stateKey, { ok: true, at, job: jobId, restored: result.cache.restoredFrom, clean: job.clean }, o.cleanAfter);
    await gcsDelete(bucket, out.object).catch(() => {});
    return { ...base, exitCode: result.exitCode ?? 0, ok: true, error: null, kind: null, errors: [] as string[], artifact: { file, bytes: fs.statSync(file).size, files: out.files ?? 0, rawBytes: out.bytes }, unity: result.unity, cloud };
  }

  // GitHub mode: the container committed and pushed the build itself; nothing to lay down here.
  if (spec.github) {
    const out = result.output;
    const site = out ? {
      changed: out.changed.map((f) => `${spec.site}/${f.path}`),
      deleted: out.deleted.map((rel) => `${spec.site}/${stubFolderOf(rel) ?? rel}`),
      bytes: out.changed.reduce((n, f) => n + f.size, 0),
    } : null;
    const pushed = result.pushed;
    if (pushed) hooks.log(`pushed ${pushed.repo} ${pushed.branch}: ${pushed.before ? `${pushed.before.slice(0, 7)} -> ` : ''}${pushed.commit.slice(0, 7)} (${pushed.files} files, source ${pushed.source.slice(0, 7)})`);
    else hooks.log(`nothing to push: the build changed nothing in ${spec.github.siteRepo} ${spec.github.branch}`);
    recordBuild(job.repo, job.stateKey, { ok: true, at, job: jobId, restored: result.cache.restoredFrom, clean: job.clean }, o.cleanAfter);
    if (Object.keys(result.packages).length) hooks.log(`packages: ${Object.entries(result.packages).map(([k, v]) => `${k} ${v.slice(0, 12)}`).join(', ')}`);
    return { ...base, exitCode: result.exitCode ?? 0, ok: true, error: null, kind: null, errors: [] as string[], site, pushed, packages: result.packages, cloud };
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

/** The words for a license failure (the container's plain reason, or Unity's own line). */
export function licenseMessage(reason: string) {
  return `Unity isn't licensed in the cloud build: ${reason.trim().slice(0, 300)}. The build signs in to Unity with the secrets unity-email and unity-password (docs/unity-cloudrun.md, "License"); fix them and build again.`;
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
