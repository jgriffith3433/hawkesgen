// Build tools: Unity WebGL builds on the build server (src/providers/builder/builder.ts) or on Google Cloud Run
// (src/providers/builder/cloudrun.ts, docs/unity-cloudrun.md).

import fs from 'node:fs';
import { getAsset } from '../library.ts';
import path from 'node:path';
import type { Tool } from './types.ts';
import { runBuild, type BuildSpec, type BuildHooks } from '../providers/builder/builder.ts';
import { runCloudBuild, cloudConfig, cloudBuildStarted, forgetFinishedBuild, releaseFinishedBuild, regionsOf, endCloudBuild, type BuildOptions } from '../providers/builder/cloudrun.ts';
import { resolveMachine, nextBigger, customerJobForMachine, type Machine } from '../providers/builder/sizes.ts';
import { isCustomerMode, admitCustomer, customerBuildOf, freshCustomerToken, dropCustomerSecrets, TOKEN_KIND, probeProject, unityImages, jobForVersion, customerJobFor, assertCustomerBuildsOn } from '../providers/builder/customer.ts';
import { refundOrgCharge } from '../orgcredits.ts';
import type { RunContext } from './types.ts';
import { runVmBuild } from '../providers/builder/vm.ts';
import { githubBuildOf } from '../providers/builder/github.ts';
import { paths, loadSettings, unityBackendOf, type UnityBackend } from '../config.ts';
import { GenError } from '../util.ts';
import { db } from '../db.ts';

/** Which backend runs a build: the param when given, else the project's own (settings.unityBuild.projects), else settings.unityBuild.backend. */
export function buildBackend(param?: unknown, project?: string, u = loadSettings().unityBuild): UnityBackend {
  return unityBackendOf({ backend: param, project }, u);
}

/**
 * GitHub mode needs a cloud backend (the container fetches and pushes): the project's own when it is one, else Cloud Run.
 * An explicit backend "builder" is refused rather than quietly moved.
 */
export function githubBackend(param: unknown, chosen: UnityBackend): UnityBackend {
  if (param === 'builder') throw new GenError('A GitHub-mode build (github param) runs in the cloud: backend cloudrun or vm, not builder.', { status: 400, kind: 'params' });
  return chosen === 'builder' ? 'cloudrun' : chosen;
}

/** One Unity batch run on the chosen backend (the same result shape from each). */
async function build(jobId: string, spec: BuildSpec, hooks: BuildHooks, backend: UnityBackend, opts: BuildOptions = {}) {
  if (backend === 'cloudrun') {
    const r = await runCloudBuild(jobId, spec, hooks, opts);
    return { ...r, backend, usage: 'gcp-cloudrun' };
  }
  if (backend === 'vm') {
    const r = await runVmBuild(jobId, spec, hooks, opts);
    return { ...r, backend, usage: 'gcp-vm' };
  }
  const r = await runBuild(jobId, spec, hooks);
  return { ...r, backend, usage: 'aws-builder', cloud: undefined };
}

export const unityBuild: Tool = {
  id: 'unity.build',
  version: 1,
  title: 'Build a Unity game (WebGL)',
  description:
    'Builds a Unity project on the AWS build server, which keeps each project\'s Library so builds are incremental. ' +
    'Uploads only what changed, runs the project\'s own batch deploy method (which writes Game/v<n> into its website ' +
    'folder), then downloads the new build into the website folder here (or into siteDir, a scratch copy of it). ' +
    'Nothing is committed or pushed, except in GitHub mode (the github param: cloud only, the source and website from ' +
    'GitHub, the build committed to the website repo beta branch and pushed, never main). Starts the ' +
    'server if it is stopped; it powers itself off when idle. Customer mode (any key; docs/unity-cloudrun.md): github ' +
    '{ repo, commit, token, ref? } with out "artifact" builds that repo\'s Unity project on Cloud Run (WebGL) and returns ' +
    'the output folder as a .tar.gz library asset (result.artifact).',
  provider: 'builder',
  output: 'file',
  inputs: {},
  params: {
    project: { type: 'string', description: 'The Unity project folder under C:\\Projects (required except in customer mode)', example: 'sickofitgame-unity' },
    site: { type: 'string', description: 'The website folder the build writes into (pulled back afterwards)', example: 'sickofitgamewebsite' },
    method: { type: 'string', description: 'The static method to run (-executeMethod): the project\'s batch deploy', example: 'YoobaWebBuild.FullDeploy' },
    target: { type: 'string', default: 'WebGL', description: 'WebGL, StandaloneWindows64 or Android (the build server); customer mode: "web" only (WebGL)' },
    path: { type: 'string', description: 'Customer mode: the Unity project folder in the repo (default: the folder with ProjectSettings/ProjectVersion.txt)', example: 'Game' },
    out: { type: 'enum', values: ['artifact', 'none'], description: 'Customer mode: "artifact" returns the build output as a .tar.gz library asset (result.artifact); with check, absent or "none"' },
    check: { type: 'boolean', description: 'Customer mode: a compile-only check. Unity (the project\'s own version, its Library cache restored, never saved) imports and compiles the scripts and exits: no player build, no build method, no artifact. The result lists the compiler errors { file, line, col, code, message } and what the run took and cost. Default machine: settings unityBuild.gcp.checkSize (m); reserves UNITY_CHECK_CREDITS (15) and settles by machine-minutes' },
    projectDir: { type: 'string', description: 'A folder under C:\\Projects to build in place of the project (an agent change\'s worktree); the server still builds it as the project, with its Library', advanced: true },
    siteDir: { type: 'string', description: 'A folder under C:\\Projects that gets the build instead of the website folder (a scratch copy of it), so the real site is untouched', advanced: true },
    env: { type: 'json', description: 'Environment variables for the build (e.g. {"BUILD_VERSION": "12"})', advanced: true },
    args: { type: 'json', description: 'Extra Unity command-line arguments (a list)', advanced: true },
    backend: { type: 'enum', values: ['auto', 'builder', 'cloudrun', 'vm'], default: 'auto', description: 'Where to build: auto uses settings.unityBuild.backend', advanced: true },
    cache: { type: 'string', description: 'Cloud builds: the Library cache to restore and save (default: the branch, beta or main; other branches restore beta and save nothing)', advanced: true },
    clean: { type: 'boolean', default: false, description: 'Cloud builds: build without the Library cache (a full import); a success saves a fresh cache', advanced: true },
    machine: { type: 'json', description: 'Customer mode: the build machine, a size name from settings.unityBuild.gcp.sizes (s 2 vCPU/8 GiB, m 4/16, l 6/24, xl 8/32; default settings customerSize, m) or {"cpu": 4, "memoryGiB": 16} (2 vCPU up to 8 GiB, 4 up to 16, 6 up to 24, 8 up to 32). A build that runs out of memory is built again once a size up.', example: 'm', orString: true, advanced: true },
    github: { type: 'json', description: 'GitHub mode (cloud only, docs/unity-cloudrun.md): {"repo": "owner/source", "commit": "<sha>", "siteRepo": "owner/website", "branch": "beta", "ref": "build-..."}. The container fetches that commit, builds, and commits Game/v<n> plus the loader to the website repo branch (beta; never main) and pushes it. Nothing is laid down here. Customer mode: {"repo": "owner/name", "commit": "<sha>", "token": "<short-lived GitHub token>", "ref": "..."} with out "artifact" (the token is held in memory for the job only, never stored)', advanced: true },
  },
  admit({ params }) {
    if (params.check !== undefined && params.check !== null && typeof params.check !== 'boolean') throw new GenError('check must be true or false (a compile-only run)', { status: 400, kind: 'params' });
    if (params.check === true && !isCustomerMode(params)) throw new GenError('check is for customer builds: github { repo, commit, token } with check true (out unset or "none")', { status: 400, kind: 'params' });
    if (isCustomerMode(params)) return admitCustomer(params);
    if (!params.project) throw new GenError('project is required (the Unity project folder), or customer mode: github { repo, commit, token } with out "artifact"', { status: 400, kind: 'params' });
    if (params.out || params.check) throw new GenError('out "artifact" and check are customer mode: it needs github { repo, commit, token }', { status: 400, kind: 'params' });
    if (params.machine !== undefined && params.machine !== null && params.machine !== '') throw new GenError('machine is for customer builds (github with a token, out "artifact"); J\'s builds take settings.unityBuild.gcp cpu and memoryGiB', { status: 400, kind: 'params' });
    if (!['WebGL', 'StandaloneWindows64', 'Android'].includes(String(params.target ?? 'WebGL'))) throw new GenError('target must be one of WebGL, StandaloneWindows64, Android', { status: 400, kind: 'params' });
    return params;
  },
  // A build cancelled or failed outside its run still had executions in Cloud Run: they are ended (none stays queued).
  ended: (jobId: string) => endCloudBuild(jobId),
  async run(ctx) {
    const p = ctx.params;
    if (isCustomerMode(p)) return runCustomerBuild(ctx);
    const github = p.github ? githubBuildOf(p.github, String(p.project), p.site || undefined) : undefined;
    const backend = github ? githubBackend(p.backend, buildBackend(p.backend, p.project)) : buildBackend(p.backend, p.project);
    if (github) ctx.log(`GitHub mode: ${github.repo}@${github.commit.slice(0, 12)}${github.ref ? ` (${github.ref})` : ''} -> ${github.siteRepo} ${github.branch}, on ${backend}`);
    const r = await build(ctx.job.id, {
      project: p.project, site: p.site || undefined, method: p.method || undefined, target: p.target,
      projectDir: p.projectDir || undefined, siteDir: p.siteDir || undefined,
      env: p.env && typeof p.env === 'object' ? p.env : undefined, args: Array.isArray(p.args) ? p.args.map(String) : undefined,
      ...(github ? { github } : {}),
    }, { step: ctx.step, log: ctx.log, signal: ctx.signal }, backend, { cache: p.cache || undefined, clean: p.clean === true });
    try {
      ctx.usage({ provider: r.usage, unit: 'seconds', amount: r.seconds, cost: r.cost, detail: p.project });
      await ctx.emit({ data: r.log, ext: 'log', mime: 'text/plain', title: `Unity log (${p.project})` });
      const version = r.site?.changed.map((f) => f.match(/\/Game\/v(\d+)\//)?.[1]).find(Boolean) ?? null;
      ctx.result({
        ok: r.ok, exitCode: r.exitCode, seconds: r.seconds, cost: Math.round(r.cost * 1000) / 1000, version,
        site: r.site ? { folder: github ? `github:${github.siteRepo}@${github.branch}` : p.siteDir || p.site, changed: r.site.changed.length, deleted: r.site.deleted.length, bytes: r.site.bytes, files: r.site.changed.slice(0, 50) } : null,
        projectFilesChangedOnServer: r.project?.length ?? 0,
        errors: (r as any).errors ?? [],
        logTail: r.ok ? undefined : r.logTail,
        backend,
        ...(github ? { github: { repo: github.repo, commit: github.commit, ref: github.ref, siteRepo: github.siteRepo, branch: github.branch }, pushed: (r as { pushed?: unknown }).pushed ?? null, packages: (r as { packages?: unknown }).packages ?? {} } : {}),
        ...(r.cloud ? { cloud: r.cloud } : {}),
        ...((r as { movedToVm?: string }).movedToVm ? { movedToVm: (r as { movedToVm?: string }).movedToVm } : {}),
      });
      if (!r.ok) throw new GenError(r.error ?? 'build failed', { kind: r.kind ?? 'build' });
      ctx.log(`built in ${Math.round(r.seconds / 60)} min${version ? `: Game/v${version}` : ''}, about $${r.cost.toFixed(2)}`);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  },
};

/** Fetch for asking GitHub where the project is (the tests stub it). */
export const ghFetch = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) };

/**
 * Customer mode (docs/unity-cloudrun.md, "Customer mode"): ask GitHub (the customer's token) for the project and its
 * Unity version, fail fast on a version without an image, build on that version's Cloud Run job, keep the output as a
 * .tar.gz asset of the job's project. The token is dropped from the vault when the job ends.
 */
export async function runCustomerBuild(ctx: RunContext) {
  const b = customerBuildOf(ctx.params);
  const cfg = cloudConfig();
  try {
    // The output was already kept (this job resumed after Gen died between keeping it and finishing): the build is done.
    const kept = b.check ? undefined : (ctx.outputs as { asset?: string; mime?: string }[]).find((o) => o.mime === 'application/gzip' && o.asset);
    const keptAsset = kept ? getAsset(kept.asset!) : null;
    if (keptAsset) {
      ctx.log(`the build's output was already kept (${keptAsset.id}); not building again`);
      ctx.result({
        ok: true, exitCode: 0, resumed: true, artifact: { asset: keptAsset.id, url: `/v1/assets/${keptAsset.id}/file`, bytes: keptAsset.bytes, files: Number(keptAsset.meta?.files ?? 0) },
        unity: keptAsset.meta?.unity ?? null, github: { repo: b.repo, commit: b.commit, ref: b.ref, path: b.path }, method: b.method, target: 'web', errors: [], backend: 'cloudrun',
      });
      await releaseFinishedBuild(ctx.job.id);
      return;
    }
    // A build already running (Gen restarted, or another instance took the job over) is followed, not asked about again.
    const started = await cloudBuildStarted(ctx.job.id);
    let probe = { path: b.path ?? '.', version: '' };
    let job = '';
    let token = '';
    let baseJob = '';
    // The machine size asked for (sizes.ts; absent: settings' customerSize, m). A resumed build keeps the one it noted.
    const asked: Machine = resolveMachine(b.machine, { sizes: cfg.gcp.sizes, customerSize: b.check ? cfg.gcp.checkSize : cfg.gcp.customerSize });
    let machine: Machine = asked;
    let warning: string | undefined;
    const onSize = async (m: Machine) => {
      const got = await customerJobForMachine({ base: baseJob, machine: m, own: { cpu: cfg.gcp.cpu, memoryGiB: cfg.gcp.memoryGiB }, project: cfg.gcp.project, regions: regionsOf(cfg), sizes: cfg.gcp.sizes, log: ctx.log });
      job = got.job;
      machine = got.machine;
      if (got.warning) warning = got.warning;
    };
    if (!started) {
      // Customer builds run only on their own job (its account reaches nothing): refused at once when there is none.
      assertCustomerBuildsOn(cfg.gcp);
      token = await freshCustomerToken(b, ctx.job.id, { log: ctx.log });
      ctx.step('reading the project from GitHub');
      try {
        probe = await probeProject(b, token, ghFetch.fetch as typeof fetch);
      } catch (e: any) {
        // GitHub refused the token (401): ask Studio for a fresh one once, just before the fetch.
        if (e?.kind !== TOKEN_KIND || !b.refresh) throw e;
        token = await freshCustomerToken(b, ctx.job.id, { log: ctx.log, force: true });
        probe = await probeProject(b, token, ghFetch.fetch as typeof fetch);
      }
      baseJob = customerJobFor(jobForVersion(probe.version, unityImages(cfg.gcp)), cfg.gcp);
      await onSize(asked);
      ctx.log(`customer build: ${b.repo}@${b.commit.slice(0, 12)}${b.ref ? ` (${b.ref})` : ''}, project ${probe.path === '.' ? 'at the repo root' : probe.path}, Unity ${probe.version}${b.check ? ', compile-only check (no player build, Library cache restored, never saved)' : b.method ? `, ${b.method}` : ', every enabled scene'}, machine ${machine.name} (${machine.cpu} vCPU, ${machine.memoryGiB} GiB)`);
    }
    const build = () => runCloudBuild(ctx.job.id, {
      project: probe.path === '.' ? 'src' : `src/${probe.path}`, method: b.check ? undefined : b.method ?? undefined, target: 'WebGL',
      env: ctx.params.env && typeof ctx.params.env === 'object' ? ctx.params.env : undefined,
      customer: { repo: b.repo, commit: b.commit, ref: b.ref, path: probe.path, owner: ctx.job.project, version: probe.version, job, token, machine, ...(b.check ? { check: true } : {}) },
    }, { step: ctx.step, log: ctx.log, signal: ctx.signal });
    let r: any = await build();
    let spent = { seconds: r.seconds, cost: r.cost };
    let retried: { from: Machine; to: Machine } | null = null;
    // Out of memory (Cloud Run's "Memory limit ... exceeded"): built again once, a size up (never past the biggest).
    // Only a build this run started (a resumed one has no token or job here).
    let up = !r.ok && r.oom && token ? nextBigger(r.machine ?? machine, cfg.gcp.sizes) : null;
    if (up) {
      // The build may have run for an hour: the token it started with must still be fresh enough to fetch with.
      try { token = await freshCustomerToken(b, ctx.job.id, { log: ctx.log }); } catch (e: any) {
        if (e?.kind !== TOKEN_KIND) throw e;
        ctx.log('the build ran out of memory, but its GitHub token is too old to build again; resubmit it with a fresh token');
        up = null;
      }
    }
    if (up) {
      const from: Machine = r.machine ?? machine;
      fs.rmSync(r.tmp, { recursive: true, force: true });
      ctx.log(`the build ran out of memory on ${from.name} (${from.cpu} vCPU, ${from.memoryGiB} GiB): building again on ${up.name} (${up.cpu} vCPU, ${up.memoryGiB} GiB)`);
      ctx.usage({ provider: 'gcp-cloudrun', unit: 'seconds', amount: r.seconds, cost: r.cost, detail: `${b.repo} ${b.commit.slice(0, 7)} (out of memory on ${from.name})` });
      await forgetFinishedBuild(ctx.job.id);
      await onSize(up);
      ctx.step(`building again on ${machine.name}`);
      r = await build();
      retried = { from, to: r.machine ?? machine };
      spent = { seconds: spent.seconds + r.seconds, cost: spent.cost + r.cost };
    }
    token = '';
    const ran: Machine = r.machine ?? machine;
    try {
      ctx.usage({ provider: 'gcp-cloudrun', unit: 'seconds', amount: r.seconds, cost: r.cost, detail: `${b.repo} ${b.commit.slice(0, 7)}` });
      await ctx.emit({ data: r.log, ext: 'log', mime: 'text/plain', title: `Unity log (${b.repo})` });
      let artifact: { asset: string; url: string; bytes: number; files: number } | null = null;
      // A compile-only check's time and cost, settled against what it reserved (billing.ts, orgcredits.ts).
      let credits: { used: number; refunded: number } | undefined;
      if (b.check) {
        // Loaded here: billing.ts imports the tool list, which imports this file.
        const { checkCreditsUsed, refundJobCreditsDown } = await import('../billing.ts');
        const used = checkCreditsUsed(spent.cost);
        const why = `Compile-only check used ${Math.round(spent.seconds)} s, about $${spent.cost.toFixed(3)}`;
        const refunded = refundJobCreditsDown(ctx.job.id, used, why) || (await refundOrgCharge(ctx.job.id, why, orgReserved(ctx.job.id) - used));
        credits = { used, refunded };
      }
      if (r.ok && r.artifact && !b.check) {
        // Streamed into the library: the archive can be a gigabyte, and the instance has 4 GiB.
        await (ctx.emitFile ?? ((o) => ctx.emit({ ...o, data: fs.readFileSync(o.file) })))({ file: r.artifact.file, ext: 'tar.gz', mime: 'application/gzip', title: `WebGL build (${b.repo} ${b.commit.slice(0, 7)})`, meta: { repo: b.repo, commit: b.commit, unity: r.unity ?? probe.version, files: r.artifact.files } });
        const asset = ctx.outputs[ctx.outputs.length - 1] as { asset?: string };
        artifact = { asset: String(asset.asset), url: `/v1/assets/${asset.asset}/file`, bytes: r.artifact.bytes, files: r.artifact.files };
        await releaseFinishedBuild(ctx.job.id);
      }
      ctx.result({
        ok: r.ok, exitCode: r.exitCode, seconds: r.seconds, cost: Math.round(r.cost * 1000) / 1000,
        unity: r.unity ?? probe.version, artifact,
        github: { repo: b.repo, commit: b.commit, ref: b.ref, path: probe.path },
        method: b.check ? null : b.method, target: 'web', errors: r.errors ?? [], logTail: r.ok ? undefined : r.logTail,
        ...(b.check ? { check: true, credits } : {}),
        backend: 'cloudrun', ...(r.cloud ? { cloud: r.cloud } : {}),
        // The machine it ran on, and what was asked (sizes.ts); a retry a size up after running out of memory says so.
        machine: { name: ran.name, cpu: ran.cpu, memoryGiB: ran.memoryGiB }, machineAsked: asked.name,
        ...(retried ? { retried: { reason: 'out of memory', from: retried.from.name, to: retried.to.name, note: `ran out of memory on ${retried.from.name} (${retried.from.cpu} vCPU, ${retried.from.memoryGiB} GiB); built again on ${retried.to.name} (${retried.to.cpu} vCPU, ${retried.to.memoryGiB} GiB)` }, totalSeconds: Math.round(spent.seconds), totalCost: Math.round(spent.cost * 1000) / 1000 } : {}),
        ...(warning ? { warnings: [warning] } : {}),
        ...(r.recovered ? { recovered: 'kept from an earlier execution of this job that had already built it' } : {}),
      });
      if (b.check) await releaseFinishedBuild(ctx.job.id);
      if (!r.ok) throw new GenError(r.error ?? 'build failed', { kind: r.kind ?? 'build' });
      if (b.check) {
        ctx.log(`compiled: no errors, ${Math.round(r.seconds)} s on ${ran.name} (${ran.cpu} vCPU, ${ran.memoryGiB} GiB), about $${r.cost.toFixed(3)}${credits ? `, ${credits.used} credits` : ''}`);
        return;
      }
      ctx.log(`built in ${Math.round(r.seconds / 60)} min on ${ran.name} (${ran.cpu} vCPU, ${ran.memoryGiB} GiB): ${artifact?.files ?? 0} files, about $${r.cost.toFixed(2)}`);
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  } finally {
    dropCustomerSecrets(b);
  }
}

/** What a Studio's charge for this job was, in credits (0 when it wasn't charged to a studio). */
function orgReserved(jobId: string): number {
  return Number((db.prepare('SELECT credits FROM org_charges WHERE job = ? AND refunded IS NULL').get(jobId) as { credits?: number } | undefined)?.credits ?? 0);
}

/** Totals and failures from an NUnit 3 results file (what Unity's -runTests writes). */
export function parseNUnit(xml: string) {
  const attr = (tag: string, name: string) => Number(new RegExp(`<${tag}[^>]*\\s${name}="(\\d+)"`).exec(xml)?.[1] ?? 0);
  const failures: { name: string; message: string }[] = [];
  const re = /<test-case\b[^>]*\sfullname="([^"]*)"[^>]*\sresult="Failed"[^>]*>([\s\S]*?)<\/test-case>/g;
  for (let m; (m = re.exec(xml)) && failures.length < 50; ) {
    const msg = /<message><!\[CDATA\[([\s\S]*?)\]\]><\/message>/.exec(m[2])?.[1] ?? '';
    failures.push({ name: m[1], message: msg.trim().slice(0, 600) });
  }
  return { total: attr('test-run', 'total'), passed: attr('test-run', 'passed'), failed: attr('test-run', 'failed'), skipped: attr('test-run', 'skipped'), failures };
}

export const unityTest: Tool = {
  id: 'unity.test',
  version: 2,
  title: 'Run a Unity project\'s tests (on the build server)',
  description:
    'Runs EditMode or PlayMode tests in batch mode on the AWS build server (incremental, like unity.build), so J can keep ' +
    'the editor open here. Returns totals and each failure; the NUnit XML and the Unity log are outputs. Optional fbx input: ' +
    'copies the file to Assets/HawkesGenCheck/character.fbx in the project before the run (for the HawkesGen.Humanoid ' +
    'EditMode check in com.hawkes.gen: avatar.isValid, isHuman, no missing required bones).',
  provider: 'builder',
  output: 'json',
  inputs: {
    fbx: { kind: 'file', description: 'Optional FBX placed at Assets/HawkesGenCheck/character.fbx for the Humanoid avatar check' },
  },
  params: {
    project: { type: 'string', required: true, description: 'The Unity project folder under C:\\Projects', example: 'sickofitgame-unity' },
    platform: { type: 'enum', values: ['EditMode', 'PlayMode'], default: 'EditMode' },
    category: { type: 'string', description: 'Only tests in this category (-testCategory), e.g. Playtest or HawkesGen.Humanoid' },
    target: { type: 'enum', values: ['WebGL', 'StandaloneWindows64'], default: 'WebGL', advanced: true },
    backend: { type: 'enum', values: ['auto', 'builder', 'cloudrun', 'vm'], default: 'auto', description: 'Where to run: auto uses settings.unityBuild.backend (an fbx check always runs on the build server)', advanced: true },
  },
  async run(ctx) {
    const p = ctx.params;
    const fbx = ctx.inputs.fbx as string | undefined;
    if (fbx) {
      const destDir = path.join(paths.projects, p.project, 'Assets', 'HawkesGenCheck');
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, 'character.fbx');
      fs.copyFileSync(fbx, dest);
      ctx.log(`placed FBX at ${p.project}/Assets/HawkesGenCheck/character.fbx for Humanoid check`);
      ctx.step('FBX ready for EditMode Humanoid check');
    }
    const category = p.category || (fbx ? 'HawkesGen.Humanoid' : undefined);
    // The FBX is placed in the project folder here, which only the build server mirrors: that check stays there.
    const backend = fbx ? 'builder' : buildBackend(p.backend, p.project);
    const r = await build(ctx.job.id, { project: p.project, target: p.target, tests: p.platform, testFilter: category }, { step: ctx.step, log: ctx.log, signal: ctx.signal }, backend);
    try {
      ctx.usage({ provider: r.usage, unit: 'seconds', amount: r.seconds, cost: r.cost, detail: `${p.project} tests` });
      await ctx.emit({ data: r.log, ext: 'log', mime: 'text/plain', title: `Unity log (${p.project} ${p.platform} tests)` });
      if (!r.ok || !r.results) throw new GenError(r.error ?? `the test run produced no results (Unity exit ${r.exitCode})`, { kind: r.kind ?? 'build' });
      await ctx.emit({ data: r.results, ext: 'xml', mime: 'application/xml', title: 'Test results (NUnit)' });
      const t = parseNUnit(r.results.toString('utf8'));
      const humanoid = category === 'HawkesGen.Humanoid' ? {
        ok: t.failed === 0 && t.passed > 0,
        passed: t.passed, failed: t.failed, failures: t.failures,
      } : undefined;
      ctx.result({ ...t, platform: p.platform, category: category ?? null, humanoid, seconds: r.seconds, cost: Math.round(r.cost * 1000) / 1000 });
      ctx.log(`${t.passed}/${t.total} passed, ${t.failed} failed${humanoid ? ` (Humanoid ${humanoid.ok ? 'ok' : 'failed'})` : ''}`);
      if (humanoid && !humanoid.ok) throw new GenError(`Humanoid check failed: ${t.failures.map((f) => f.message || f.name).join('; ') || `${t.failed} failed`}`, { kind: 'build' });
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  },
};
