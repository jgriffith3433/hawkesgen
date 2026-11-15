#!/usr/bin/env node
// Clear stuck Cloud Run job executions that hold us-east4 vCPU (hawkes-unity-build* and studio-cell-agent*).
// Dry-run by default: lists every incomplete execution with age (minutes) and vCPU. With --apply, cancels those
// older than --older-than (default 90) and prints the freed vCPU (sum of the cancelled ones' vCPU).
//
//   node tools/clear-stuck-executions.mjs
//   node tools/clear-stuck-executions.mjs --apply
//   node tools/clear-stuck-executions.mjs --project hawkes-staging --region us-east4 --older-than 90 --apply
//
// Queued executions (no start time) refuse :cancel and are deleted instead (same as Studio's ops-jobs-stop).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gcloudBin } from './gcloud-bin.mjs';
import { APPLY, flag, die, done } from './unity-cloudrun/common.mjs';

/** Job name prefixes this tool may touch. Never a Cloud Run service. */
export const JOB_PREFIXES = ['hawkes-unity-build', 'studio-cell-agent'];

/** Cloud Run CPU limit string ("8", "1000m") → vCPU number. */
export function parseCpu(limit) {
  if (limit == null || limit === '') return 1;
  const s = String(limit).trim();
  if (s.endsWith('m')) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 1000 : 1;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Age in whole minutes from an RFC3339 timestamp (or null → 0). */
export function ageMinutes(iso, nowMs = Date.now()) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 60_000));
}

/** True when the job name is one this tool clears. */
export function isTargetJob(name) {
  return JOB_PREFIXES.some((p) => name === p || name.startsWith(`${p}-`));
}

/**
 * From raw incomplete executions (each: name, job, createTime, startTime, vcpu), pick what to list and cancel.
 * Incomplete means no completionTime (caller filters that). Age uses createTime, else startTime.
 */
export function planClear(rows, { olderThanMin = 90, nowMs = Date.now() } = {}) {
  const listed = rows.map((r) => {
    const when = r.createTime || r.startTime || null;
    const age = ageMinutes(when, nowMs);
    const vcpu = Number(r.vcpu) > 0 ? Number(r.vcpu) : 1;
    return { ...r, ageMin: age, vcpu, when };
  }).sort((a, b) => b.ageMin - a.ageMin || a.name.localeCompare(b.name));
  const cancel = listed.filter((r) => r.ageMin >= olderThanMin);
  const freedVcpu = cancel.reduce((s, r) => s + r.vcpu, 0);
  return { listed, cancel, freedVcpu, olderThanMin };
}

function gcloudCapture(args) {
  if (process.argv.includes('--offline')) return null;
  const [bin, pre] = gcloudBin();
  const r = spawnSync(bin, [...pre, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) die(`Couldn't run gcloud (${r.error.message}). Install the Google Cloud CLI and run "gcloud auth login".`);
  if (r.status !== 0) return null;
  return (r.stdout ?? '').trim();
}

function gcloudRun(args) {
  const line = `gcloud ${args.join(' ')}`;
  console.log(`${APPLY ? '>' : '  (dry run)'} ${line}`);
  if (!APPLY) return { ok: true };
  const [bin, pre] = gcloudBin();
  const r = spawnSync(bin, [...pre, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) die(`Couldn't run gcloud (${r.error.message}).`);
  return { ok: r.status === 0, err: (r.stderr || r.stdout || '').trim() };
}

/** Load incomplete target executions from Cloud Run (or empty when offline / unreachable). */
export function loadIncomplete({ project, region }) {
  if (process.argv.includes('--offline')) return [];
  const jobsOut = gcloudCapture(['run', 'jobs', 'list', `--project=${project}`, `--region=${region}`, '--format=value(metadata.name)']);
  if (jobsOut == null) die(`Couldn't list Cloud Run jobs in ${project} ${region}.`);
  const jobs = jobsOut.split(/\n/).map((s) => s.trim()).filter(Boolean).filter(isTargetJob);
  const rows = [];
  for (const job of jobs) {
    const cpuRaw = gcloudCapture([
      'run', 'jobs', 'describe', job, `--project=${project}`, `--region=${region}`,
      '--format=value(spec.template.spec.template.spec.containers[0].resources.limits.cpu)',
    ]);
    const vcpu = parseCpu(cpuRaw);
    // name, create, start, completion — incomplete = no completion time
    const list = gcloudCapture([
      'run', 'jobs', 'executions', 'list', `--job=${job}`, `--project=${project}`, `--region=${region}`,
      '--limit=500',
      '--format=value(metadata.name,metadata.creationTimestamp,status.startTime,status.completionTime)',
    ]);
    if (list == null) continue;
    for (const line of list.split(/\n/)) {
      if (!line.trim()) continue;
      const [name, createTime, startTime, completionTime] = line.split(/\t/);
      if (completionTime) continue;
      rows.push({
        name: name || '',
        job,
        createTime: createTime || '',
        startTime: startTime || '',
        vcpu,
      });
    }
  }
  return rows;
}

/** Cancel one execution; delete if still queued (no startTime). */
export function clearOne(exec, { project, region }) {
  const cancel = gcloudRun([
    'run', 'jobs', 'executions', 'cancel', exec.name,
    `--project=${project}`, `--region=${region}`, '--quiet', '--async',
  ]);
  if (cancel.ok) return { action: 'cancel', ok: true };
  if (!exec.startTime) {
    const del = gcloudRun([
      'run', 'jobs', 'executions', 'delete', exec.name,
      `--project=${project}`, `--region=${region}`, '--quiet', '--async',
    ]);
    if (del.ok) return { action: 'delete', ok: true };
    return { action: 'delete', ok: false, err: del.err };
  }
  return { action: 'cancel', ok: false, err: cancel.err };
}

function formatRow(r) {
  const state = r.startTime ? 'running' : 'queued';
  return `${r.name}\tjob=${r.job}\tage=${r.ageMin}m\tvCPU=${r.vcpu}\t${state}`;
}

function main() {
  const project = flag('project', 'hawkes-staging');
  const region = flag('region', 'us-east4');
  const olderThanMin = Number(flag('older-than', '90'));
  if (!Number.isFinite(olderThanMin) || olderThanMin < 0) die('--older-than must be a non-negative number of minutes.');

  console.log(`Stuck Cloud Run executions in ${project} ${region}`);
  console.log(`Jobs: ${JOB_PREFIXES.map((p) => p + '*').join(', ')}`);
  console.log(`Threshold: ${olderThanMin} min (cancel with --apply); dry-run is the default.\n`);

  const rows = loadIncomplete({ project, region });
  const plan = planClear(rows, { olderThanMin });

  if (!plan.listed.length) {
    console.log('No incomplete hawkes-unity-build* or studio-cell-agent* executions.');
  } else {
    console.log(`# Incomplete (${plan.listed.length})`);
    for (const r of plan.listed) console.log(formatRow(r));
  }

  console.log(`\n# Would cancel (age >= ${olderThanMin} min): ${plan.cancel.length}`);
  for (const r of plan.cancel) console.log(formatRow(r));

  let freed = 0;
  let cancelled = 0;
  if (APPLY) {
    console.log('\n# Applying');
    for (const r of plan.cancel) {
      const res = clearOne(r, { project, region });
      if (res.ok) {
        cancelled += 1;
        freed += r.vcpu;
        console.log(`  ${res.action} ${r.name} (+${r.vcpu} vCPU)`);
      } else {
        console.log(`  (could not ${res.action} ${r.name}${res.err ? `: ${res.err.split('\n')[0]}` : ''})`);
      }
    }
  } else {
    freed = plan.freedVcpu;
  }

  // Printed total: on apply, only what actually cancelled; on dry-run, the sum of what would cancel.
  console.log(`\nfreed vCPU: ${freed}${APPLY ? ` (cancelled ${cancelled})` : ' (dry run — nothing cancelled)'}`);
  if (APPLY && cancelled !== plan.cancel.length) {
    console.log(`(wanted ${plan.cancel.length}; ${plan.cancel.length - cancelled} failed)`);
  }
  done();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
