// Shared bits of the Unity cloud build scripts (docs/unity-cloudrun.md). Every script prints what it would do and
// changes nothing without --apply. They drive the gcloud CLI (Google Cloud SDK), signed in as J.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gcloudBin } from '../gcloud-bin.mjs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APPLY = process.argv.includes('--apply');

/** --name value (or --name=value) from the command line. */
export function flag(name, fallback) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return fallback;
}

/** settings.unityBuild.gcp from Gen's settings file, with command-line flags over it. */
export function config() {
  let gcp = {};
  let vm = {};
  try {
    const dataDir = process.env.HAWKESGEN_DATA_DIR ?? path.join(ROOT, '.data');
    const u = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).unityBuild ?? {};
    gcp = u.gcp ?? {};
    vm = u.vm ?? {};
  } catch { /* no settings yet */ }
  const c = {
    project: flag('project', gcp.project ?? ''),
    region: flag('region', gcp.region ?? 'us-east4'),
    job: flag('job', gcp.job ?? 'hawkes-unity-build'),
    bucket: flag('bucket', gcp.bucket ?? ''),
    unity: flag('unity', gcp.unity ?? '6000.3.7f1'),
    registry: flag('registry', 'hawkes'),
    cpu: Number(flag('cpu', gcp.cpu ?? 8)),
    memoryGiB: Number(flag('memory', gcp.memoryGiB ?? 32)),
    zone: flag('zone', vm.zone ?? 'us-east4-a'),
    machineType: flag('machine-type', vm.machineType ?? 'n2-standard-8'),
  };
  if (!c.project) die('Which Google Cloud project? Pass --project <id> (or set settings.unityBuild.gcp.project in Gen).');
  return c;
}

export const imageBase = (c) => `${c.region}-docker.pkg.dev/${c.project}/${c.registry}/unity-build`;
export const runtimeSa = (c) => `hawkes-unity-build@${c.project}.iam.gserviceaccount.com`;
export const genSa = (c) => `hawkes-gen@${c.project}.iam.gserviceaccount.com`;

export function die(msg) {
  console.error(msg);
  process.exit(1);
}

const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** Prints a gcloud command; with --apply runs it (stops on failure unless `okToFail`). */
export function gcloud(args, { okToFail = false, capture = false } = {}) {
  console.log(`${APPLY ? '>' : '  (dry run)'} gcloud ${args.map(quote).join(' ')}`);
  if (!APPLY) return { ok: true, out: '' };
  const [bin, pre] = gcloudBin();
  const r = spawnSync(bin, [...pre, ...args], { stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (r.error) die(`Couldn't run gcloud (${r.error.message}). Install the Google Cloud CLI and run "gcloud auth login".`);
  if (r.status !== 0 && !okToFail) die(`gcloud failed (exit ${r.status}).`);
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** Runs a read-only gcloud query even without --apply (to show what exists); null when it fails. */
export function gcloudQuery(args) {
  if (process.argv.includes('--offline')) return null; // print the whole plan without asking Google anything
  const [bin2, pre2] = gcloudBin();
  const r = spawnSync(bin2, [...pre2, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

export function done() {
  console.log(APPLY ? '\ndone.' : '\nNothing was changed. Run again with --apply to do it.');
}
