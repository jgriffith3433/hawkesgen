// The build VM: Unity builds of a project too big for Cloud Run (settings.unityBuild.projects[project] = "vm";
// docs/unity-cloudrun.md, "The build VM"). One small spot VM per project (hawkes-unity-<project>, made by
// tools/unity-cloudrun/vm.mjs) with a persistent disk that keeps the project's sources and Library between builds. It
// runs the same container as Cloud Run with HAWKES_PERSIST=1, from its startup script (server/unity-cloudrun/vm-startup.sh),
// and powers itself off when the build is done.
//
// One build: the same inputs and spec.json as a Cloud Run build (cloudrun.ts prepareBuild); Gen puts the spec's address
// in the instance's metadata (hawkes-spec), starts it, follows its log (Docker's gcplogs driver -> Cloud Logging) and
// result.json in the bucket, stops it, and lays the output down with the same code. Compute Engine REST with ADC (gcp.ts).

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../../config.ts';
import { GenError } from '../../util.ts';
import type { BuildSpec, BuildHooks } from './builder.ts';
import { cloudConfig, checkBuild, prepareBuild, progressFollower, finishBuildResult, type BuildOptions } from './cloudrun.ts';
import { cacheRepo, recordBuild } from './cache.ts';
import { gcsRead, getInstance, setInstanceMetadata, startInstance, stopInstance, logLines, type VmTarget } from './gcp.ts';

const fail = (message: string, kind = 'builder') => new GenError(message, { status: 409, kind });

/** The build VM's name for a project: hawkes-unity-<project>, lowercase, at most 63 characters. */
export function vmName(project: string) {
  const s = cacheRepo(project).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `hawkes-unity-${s}`.slice(0, 63).replace(/-$/, '');
}

/** What an instance status means for a build that is waiting for its result. */
export function vmPhase(status: string): 'starting' | 'running' | 'stopping' | 'stopped' {
  if (['PROVISIONING', 'STAGING', 'REPAIRING'].includes(status)) return 'starting';
  if (status === 'RUNNING') return 'running';
  if (['STOPPING', 'SUSPENDING'].includes(status)) return 'stopping';
  return 'stopped';
}

type VmJob = { instance: string; id: string; prefix: string; started: number; repo: string; saveKey: string | null; stateKey: string; clean: boolean };
const jobFile = (jobId: string) => path.join(paths.builder, 'vm-jobs', `${jobId}.json`);
const loadJob = (jobId: string): VmJob | null => { try { return JSON.parse(fs.readFileSync(jobFile(jobId), 'utf8')); } catch { return null; } };
function saveJob(jobId: string, j: VmJob) {
  fs.mkdirSync(path.dirname(jobFile(jobId)), { recursive: true });
  fs.writeFileSync(jobFile(jobId), JSON.stringify(j));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until the instance is stopped (a leftover run, an idle shutdown in progress); stops it if it keeps running. */
async function untilStopped(t: VmTarget, hooks: BuildHooks) {
  for (let i = 0; i < 40; i++) {
    const inst = await getInstance(t);
    if (!inst) throw fail(`The build VM ${t.name} is gone.`, 'config');
    const phase = vmPhase(inst.status);
    if (phase === 'stopped') return inst;
    if (i === 0) hooks.step(`the build VM is ${inst.status.toLowerCase()}; waiting for it to stop`);
    if (phase === 'running' && i === 6) await stopInstance(t); // a minute of RUNNING with no build of ours: a leftover
    await sleep(10_000);
  }
  throw fail(`The build VM ${t.name} didn't stop within 7 minutes.`);
}

/** Builds on the project's VM; resolves to the same shape as builder.ts runBuild. */
export async function runVmBuild(jobId: string, spec: BuildSpec, hooks: BuildHooks, opts: BuildOptions = {}) {
  const t0 = Date.now();
  const cfg = cloudConfig();
  const checked = checkBuild(spec, cfg, 'on the build VM');
  spec = checked.spec;
  const t: VmTarget = { project: cfg.gcp.project, zone: cfg.vm.zone, name: vmName(spec.project) };
  const tmp = fs.mkdtempSync(path.join(paths.tmp, 'vmbuild-'));

  let job = loadJob(jobId);
  if (job) {
    hooks.log(`the build was already started on ${job.instance}; following it`);
  } else {
    try {
      const inst = await getInstance(t);
      if (!inst) throw fail(`${spec.project} builds on its VM (settings.unityBuild.projects), but there is no ${t.name} in ${t.zone}. Make it: node tools/unity-cloudrun/vm.mjs --folder C:\\Projects\\${spec.project.replace(/\//g, '\\')} --apply`, 'config');
      await untilStopped(t, hooks);
      const p = await prepareBuild(jobId, spec, checked.unity, checked.target, hooks, opts, cfg, tmp);
      await setInstanceMetadata(t, { 'hawkes-spec': p.specUri, 'hawkes-job': jobId });
      hooks.step('starting the build VM');
      await startInstance(t);
      job = { instance: t.name, id: inst.id, prefix: p.prefix, started: Date.now(), repo: p.repo, saveKey: p.saveKey, stateKey: p.stateKey, clean: p.clean };
      saveJob(jobId, job);
      hooks.log(`build started on ${t.name} (${cfg.vm.machineType} spot, ${t.zone}; Unity ${checked.unity}${spec.method ? `, ${spec.method}` : ''})`);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  // Follow: the container's log, its result.json, and the instance (a spot VM can be taken back).
  const deadline = job.started + (cfg.timeoutMinutes + 25) * 60_000;
  const filter = `resource.type="gce_instance" AND resource.labels.instance_id="${job.id}" AND logName="projects/${t.project}/logs/gcplogs-docker-driver"`;
  let since = new Date(job.started - 60_000).toISOString();
  const follow = progressFollower(hooks);
  let stoppedSince = 0;
  let noResult = '';
  const end = (why: string) => {
    fs.rmSync(jobFile(jobId), { force: true });
    return why;
  };
  hooks.step('waiting for the build VM');
  for (;;) {
    if (hooks.signal?.aborted) {
      await stopInstance(t);
      end('cancelled');
      fs.rmSync(tmp, { recursive: true, force: true });
      throw fail('cancelled', 'cancelled');
    }
    try {
      const l = await logLines(t.project, filter, since);
      since = l.last;
      follow.take(l.lines);
    } catch (e: any) {
      hooks.log(`(couldn't read the build VM's log: ${e.message}; retrying)`);
    }
    if (await gcsRead(cfg.gcp.bucket, `${job.prefix}/result.json`).catch(() => null)) break;
    const inst = await getInstance(t).catch(() => null);
    if (inst && vmPhase(inst.status) === 'stopped') {
      // result.json is written before the VM powers off; give the bucket a minute to show it.
      stoppedSince ||= Date.now();
      if (Date.now() - stoppedSince > 60_000) {
        noResult = 'the build VM stopped before the build finished (a spot VM can be taken back by Google; run the build again)';
        break;
      }
    } else stoppedSince = 0;
    if (Date.now() > deadline) {
      await stopInstance(t);
      end('timeout');
      recordBuild(job.repo, job.stateKey, { ok: false, failure: 'other', at: new Date().toISOString(), job: jobId, kind: 'timeout', clean: job.clean }, cfg.cleanAfterFailures);
      fs.rmSync(tmp, { recursive: true, force: true });
      throw fail(`The build on ${t.name} ran past its limit (${cfg.timeoutMinutes} minutes plus 25 for setup) and the VM was stopped (last step: ${follow.lastStep || 'none'}).`, 'timeout');
    }
    await sleep(15_000);
  }
  end('done');
  // It powers itself off after the build; stop it anyway (a no-op if it already has), and take the spec off it so a
  // manual start never runs this build again.
  await stopInstance(t);
  await setInstanceMetadata(t, { 'hawkes-spec': null }).catch(() => {});
  const ran = (Date.now() - job.started) / 1000;
  return finishBuildResult(jobId, spec, hooks, {
    job: { prefix: job.prefix, repo: job.repo, stateKey: job.stateKey, clean: job.clean, label: `VM ${t.name}`, instance: t.name },
    ran, cost: (ran / 3600) * cfg.vm.pricePerHour, tmp, t0, bucket: cfg.gcp.bucket, cleanAfter: cfg.cleanAfterFailures,
    licenseLine: follow.licenseLine, noResult: noResult || 'no result.json',
  });
}
