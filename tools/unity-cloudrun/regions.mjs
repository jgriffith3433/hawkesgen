#!/usr/bin/env node
// Every region a Gen builds Unity in, in one place: which jobs each has and on which image, and (with --image and
// --apply) the same image everywhere, customer twins included. Gen's own settings name the regions (unityBuild.gcp.region
// then .regions), read from the running Gen, so this never works from a guess (2026-10-31: live Gen's main region was
// us-west1, set up by hand long before, with no customer job; a customer build failed there).
//
//   node tools/unity-cloudrun/regions.mjs [--lane live|beta]                  what each region has (exit 1 if they differ)
//   node tools/unity-cloudrun/regions.mjs --image <image> [--lane ...] --apply  deploy-job + customer-setup in each region
//
// Reads ~/.hawkes/client.json (genUrl/genKey, or genBetaUrl/genBetaKey). Prints first; changes things only with --apply.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APPLY, flag, gcloudQuery, die, ROOT } from './common.mjs';

const lane = flag('lane', 'live');
if (!['live', 'beta'].includes(lane)) die('--lane is live or beta');
const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hawkes', 'client.json'), 'utf8'));
const url = String(lane === 'beta' ? c.genBetaUrl : c.genUrl).replace(/\/+$/, '');
const key = lane === 'beta' ? c.genBetaKey : c.genKey;
const r = await fetch(`${url}/v1/settings`, { headers: { authorization: `Bearer ${key}` } });
if (!r.ok) die(`${url} didn't give its settings (${r.status})`);
const s = await r.json();
const g = (s.settings ?? s).unityBuild?.gcp ?? {};
const project = flag('project', g.project);
if (!project || !g.bucket) die(`${lane} Gen has no unityBuild.gcp project or bucket`);
const regions = [g.region, ...(g.regions ?? [])].filter((x, i, a) => x && a.indexOf(x) === i);
const own = [...new Set([g.job, ...Object.values(g.images ?? {})])];
const jobs = g.customerJob ? [...own, ...own.map((j) => (j === g.job ? g.customerJob : `${j}-customer`))] : own;
const image = flag('image');

const imageOf = (job, region) => gcloudQuery(['run', 'jobs', 'describe', job, `--region=${region}`, `--project=${project}`, '--format=value(spec.template.spec.template.spec.containers[0].image)']);
const table = () => {
  const rows = [];
  for (const region of regions) for (const job of jobs) rows.push({ region, job, image: imageOf(job, region) });
  return rows;
};

console.log(`${lane} Gen (${url}): builds in ${regions.join(', ')} (first is the main one)\nJobs: ${jobs.join(', ')}\n`);
const before = table();
for (const x of before) console.log(`  ${x.region.padEnd(12)} ${x.job.padEnd(32)} ${x.image ? x.image.split('/').pop() : 'MISSING'}`);
const images = new Set(before.map((x) => x.image));
const ok = !before.some((x) => !x.image) && images.size === 1;
console.log(ok ? '\nEvery region has every job on the same image.' : '\nThe regions differ: a missing job or another image means a build there fails or runs older code.');

if (!image) {
  if (!ok) console.log(`Bring them in line: node tools/unity-cloudrun/regions.mjs --lane ${lane} --image <image> --apply`);
  process.exit(ok ? 0 : 1);
}
for (const region of regions) {
  const args = [['tools/unity-cloudrun/deploy-job.mjs', '--project', project, '--region', region, '--bucket', g.bucket, '--image', image], ['tools/unity-cloudrun/customer-setup.mjs', '--project', project, '--region', region, ...(Object.keys(g.images ?? {}).length ? ['--all'] : [])]];
  for (const a of args) {
    if (a[0].includes('customer') && !g.customerJob) continue;
    console.log(`\n> node ${a.join(' ')}${APPLY ? ' --apply' : ''}`);
    if (!APPLY) continue;
    const run = spawnSync(process.execPath, [...a, '--apply'], { cwd: ROOT, stdio: 'inherit' });
    if (run.status !== 0) die(`${a[0]} failed in ${region}; the regions after it weren't touched.`);
  }
}
if (APPLY) {
  const after = table();
  const bad = after.filter((x) => x.image !== image);
  console.log(bad.length ? `\nStill different: ${bad.map((x) => `${x.region}/${x.job}`).join(', ')}` : `\nEvery region has every job on ${image.split('/').pop()}.`);
  process.exit(bad.length ? 1 : 0);
}
console.log('\nDry run: add --apply to make these changes.');
