#!/usr/bin/env node
// Deploys (or updates) the playtest service on Cloud Run. docs/playtest-cloudrun.md, "Pilot".
//
//   node tools/playtest-cloudrun/deploy.mjs [--variant gpu|cpu] [--project hawkes-staging] [--region us-east4] [--image <tag>]
//        [--max-instances 2] [--tabs 4] [--gen-sa <email>] [--worker-sa <email>] [--setup] [--apply]
//
// --variant cpu deploys gen-playtest-cpu (service-cpu.json: no GPU, WebGL on SwiftShader, request-based billing, so no
// idle tail and no GPU quota) under the same account and invoker rules; its patch is settings.playtest.cloudrunCpu.
//
// One NVIDIA L4 per instance (8 vCPU, 32 GiB), scale to zero, at most --max-instances, containerConcurrency = --tabs
// (one WebSocket = one browser tab), instance-based billing, no GPU zonal redundancy, a 60-minute request limit, the
// startup probe on /ready (the GPU self-test must find a GL path that draws on the NVIDIA GPU before traffic), the
// service account gen-playtest@ (no roles: the browser needs nothing from Google Cloud), and roles/run.invoker for
// Gen's service account only (never allUsers). Written as a Knative YAML (.data/cloudrun/service-gen-playtest.yaml)
// and applied with `gcloud run services replace`, so running it again updates it. --setup creates gen-playtest@ (and
// gen-control@ if this project has no Cloud Run GPU services yet). Without --apply: prints every command, changes
// nothing. At the end it prints the settings patch that points Gen at it.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, gcloud, saveState, readState, STATE_DIR, loadServiceMap } from '../cloudrun/lib.mjs';
import { loadSpec, imageTag, serviceYaml, pricePerHour, variantOf, stateName } from './lib.mjs';

const args = parseArgs();
const variant = variantOf(args.variant);
const spec = loadSpec(variant);
if (!process.argv.some((a) => a.startsWith('--region'))) args.region = spec.region;
const map = loadServiceMap();
if (spec.gpu) {
  const gpu = map.gpus[spec.gpu];
  if (!gpu.regions.includes(args.region)) throw new Error(`${spec.gpu} isn't offered for Cloud Run services in ${args.region} (offered: ${gpu.regions.join(', ')})`);
  if (spec.cpu < gpu.minCpu || spec.memoryGi < gpu.minMemoryGi) throw new Error(`${spec.gpu} needs at least ${gpu.minCpu} vCPU and ${gpu.minMemoryGi} GiB`);
}
const asked = Math.max(1, Math.min(20, Number(args.maxInstances ?? spec.maxInstances)));
// The live region (us-east4: gen, studio and the Studio cells run there and share its Cloud Run CPU quota) gets at
// most one CPU browser instance, whatever was asked: 2026-11-11, four 4 vCPU CPU browsers held 16 of us-east4's 20 vCPU
// and Studio's own server couldn't start. Matches LIVE_REGION_CPU_INSTANCES in src/providers/playtester/cloudrun.ts.
const LIVE_REGION = process.env.REGION_LIVE || 'us-east4';
const maxInstances = variant === 'cpu' && args.region === LIVE_REGION ? Math.min(asked, 1) : asked;
if (maxInstances < asked) console.log(`${args.region} is the live region: at most ${maxInstances} instance(s) (asked ${asked})`);
const tabs = Math.max(1, Math.min(8, Number(args.tabs ?? spec.tabsPerInstance)));
const image = args.image ?? readState(stateName(variant, 'image'))?.tag ?? imageTag(args, spec);
const workerSa = args.workerSa ?? `gen-playtest@${args.project}.iam.gserviceaccount.com`;
const genSa = args.genSa ?? `gen-control@${args.project}.iam.gserviceaccount.com`;
const perHour = pricePerHour(spec, map);

console.log(`Project ${args.project}, region ${args.region}, image ${image}`);
console.log(`${spec.name}: ${spec.gpu ? `${spec.gpu} x1` : 'no GPU (WebGL on SwiftShader)'}, ${spec.cpu} vCPU, ${spec.memoryGi} GiB, up to ${maxInstances} instance(s) x ${tabs} tabs = ${maxInstances * tabs} playtest tabs at once`);
console.log(spec.gpu
  ? `  about $${perHour.toFixed(2)}/hour per instance while up (scale to zero: nothing when idle beyond Cloud Run's idle tail)`
  : `  about $${perHour.toFixed(3)}/hour per instance while a tab is connected (request-based billing: nothing between playtests)`);
console.log(`  runs as ${workerSa}; only ${genSa} may call it\n`);

if (args.setup) {
  console.log('Setup: service accounts');
  for (const [sa, title] of [[workerSa, 'Hawkes Gen playtest browsers (no roles)'], [genSa, 'Hawkes Gen control server']]) {
    const have = gcloud(args, ['iam', 'service-accounts', 'describe', sa, `--project=${args.project}`, '--format=value(email)'], { read: true });
    if (!have) gcloud(args, ['iam', 'service-accounts', 'create', sa.split('@')[0], `--project=${args.project}`, `--display-name=${title}`]);
  }
  console.log('');
}

const yaml = serviceYaml(spec, { image, region: args.region, serviceAccount: workerSa, maxInstances, tabs });
const file = path.join(STATE_DIR, `service-${spec.name}.yaml`);
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(file, JSON.stringify(yaml, null, 2));
console.log(`service definition: ${file}`);
gcloud(args, ['run', 'services', 'replace', file, `--project=${args.project}`, `--region=${args.region}`]);
const bind = ['run', 'services', 'add-iam-policy-binding', spec.name, `--project=${args.project}`, `--region=${args.region}`, `--member=serviceAccount:${genSa}`, '--role=roles/run.invoker'];
// GitHub's deployer (roles/run.developer) may not set a service's IAM policy: the service is up either way, and the line
// below says what its owner runs once so Gen may call it.
try { gcloud(args, bind); } catch (e) { console.log(`WARNING: ${e.message}. Gen can't call ${spec.name} until the project's owner runs once: gcloud ${bind.join(' ')}`); }
const policy = gcloud(args, ['run', 'services', 'get-iam-policy', spec.name, `--project=${args.project}`, `--region=${args.region}`, '--format=json'], { read: true });
if (policy && /allUsers|allAuthenticatedUsers/.test(policy)) console.log(`WARNING: ${spec.name} is open to allUsers/allAuthenticatedUsers: remove that binding (only Gen's account may call it)`);
const url = gcloud(args, ['run', 'services', 'describe', spec.name, `--project=${args.project}`, `--region=${args.region}`, '--format=value(status.url)'], { read: true });

const key = variant === 'cpu' ? 'cloudrunCpu' : 'cloudrun';
const patch = { playtest: { [key]: { url: url || '<the service URL>', maxInstances, tabsPerInstance: tabs } } };
if (!args.apply) {
  console.log(`\nDry run: nothing deployed. Add --apply to deploy (J's OK: ${spec.gpu ? 'L4 quota, and instances bill while up' : 'instances bill while a playtest is connected'}).`);
  if (url) console.log(`The service already answers at ${url}`);
  console.log(`The settings patch it would print: ${JSON.stringify(patch)}`);
  process.exit(0);
}
saveState(stateName(variant, 'url'), { url, region: args.region, maxInstances, tabs });
console.log('\nPoint Gen at it (POST /v1/settings, owner key). Playtests move only for the products you name, or all with "backend":');
console.log(JSON.stringify({ ...patch, playtest: { ...patch.playtest, ...(variant === 'cpu' ? { backend: 'cloudrun-cpu' } : { projects: { '<product>': 'cloudrun' } }) } }, null, 2));
console.log(`Then: hawkesgen playtester cloud${variant === 'cpu' ? ' cpu' : ''} selftest`);
