// Build tools: Unity WebGL builds on the build server (src/providers/builder/builder.ts) or on Google Cloud Run
// (src/providers/builder/cloudrun.ts, docs/unity-cloudrun.md).

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { runBuild, type BuildSpec, type BuildHooks } from '../providers/builder/builder.ts';
import { runCloudBuild, type BuildOptions } from '../providers/builder/cloudrun.ts';
import { runVmBuild } from '../providers/builder/vm.ts';
import { githubBuildOf } from '../providers/builder/github.ts';
import { paths, loadSettings, unityBackendOf, type UnityBackend } from '../config.ts';
import { GenError } from '../util.ts';

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
    'server if it is stopped; it powers itself off when idle.',
  provider: 'builder',
  output: 'file',
  inputs: {},
  params: {
    project: { type: 'string', required: true, description: 'The Unity project folder under C:\\Projects', example: 'sickofitgame-unity' },
    site: { type: 'string', description: 'The website folder the build writes into (pulled back afterwards)', example: 'sickofitgamewebsite' },
    method: { type: 'string', description: 'The static method to run (-executeMethod): the project\'s batch deploy', example: 'YoobaWebBuild.FullDeploy' },
    target: { type: 'enum', values: ['WebGL', 'StandaloneWindows64', 'Android'], default: 'WebGL' },
    projectDir: { type: 'string', description: 'A folder under C:\\Projects to build in place of the project (an agent change\'s worktree); the server still builds it as the project, with its Library', advanced: true },
    siteDir: { type: 'string', description: 'A folder under C:\\Projects that gets the build instead of the website folder (a scratch copy of it), so the real site is untouched', advanced: true },
    env: { type: 'json', description: 'Environment variables for the build (e.g. {"BUILD_VERSION": "12"})', advanced: true },
    args: { type: 'json', description: 'Extra Unity command-line arguments (a list)', advanced: true },
    backend: { type: 'enum', values: ['auto', 'builder', 'cloudrun', 'vm'], default: 'auto', description: 'Where to build: auto uses settings.unityBuild.backend', advanced: true },
    cache: { type: 'string', description: 'Cloud builds: the Library cache to restore and save (default: the branch, beta or main; other branches restore beta and save nothing)', advanced: true },
    clean: { type: 'boolean', default: false, description: 'Cloud builds: build without the Library cache (a full import); a success saves a fresh cache', advanced: true },
    github: { type: 'json', description: 'GitHub mode (cloud only, docs/unity-cloudrun.md): {"repo": "owner/source", "commit": "<sha>", "siteRepo": "owner/website", "branch": "beta", "ref": "build-..."}. The container fetches that commit, builds, and commits Game/v<n> plus the loader to the website repo branch (beta; never main) and pushes it. Nothing is laid down here', advanced: true },
  },
  async run(ctx) {
    const p = ctx.params;
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
