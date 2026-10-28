#!/usr/bin/env node
// Deploys (or updates) the CPU services from server/cpu-cloudrun/service.json. docs/cpu-cloudrun.md, "Deploy".
//
//   node tools/cpu-cloudrun/deploy.mjs [--project hawkes-staging] [--region us-east4] [--class light,heavy]
//        [--image <tag>] [--bucket <name>] [--gen-sa <email>] [--setup] [--apply]
//
// --setup first makes what the services need: the bucket gs://<project>-gen-cpu in the region (uniform access, no
// public access, inputs and run outputs deleted after 7 days: Gen files every output in its own library), the
// service account gen-cpu@ with objectAdmin on that bucket only, and Gen's account (gen-control@, as for the GPU
// services) with objectAdmin there too. Then each class's service (gen-cpu, gen-cpu-heavy): same image, scale to
// zero, request-based billing, its size and concurrency, applied with `gcloud run services replace` (running it again
// updates), and roles/run.invoker for Gen's account only (never allUsers). Without --apply: prints every command and
// the service YAMLs, changes nothing. At the end it prints the settings patch that points Gen at them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, gcloud, saveState, readState, STATE_DIR } from '../cloudrun/lib.mjs';
import { loadSpec, imageTag, bucketOf, serviceYaml, pricePerHour } from './lib.mjs';

const args = parseArgs();
const spec = loadSpec();
if (!process.argv.some((a) => a.startsWith('--region'))) args.region = spec.region;
const P = `--project=${args.project}`;
const bucket = bucketOf(args);
const image = args.image ?? readState('cpu-image.json')?.tag ?? imageTag(args, spec);
const runSa = `gen-cpu@${args.project}.iam.gserviceaccount.com`;
const genSa = args.genSa ?? `gen-control@${args.project}.iam.gserviceaccount.com`;
const classes = (args.class ? String(args.class).split(',') : Object.keys(spec.classes)).map((c) => c.trim()).filter(Boolean);
for (const c of classes) if (!spec.classes[c]) throw new Error(`no class ${c} in server/cpu-cloudrun/service.json (${Object.keys(spec.classes).join(', ')})`);

console.log(`Project ${args.project}, region ${args.region}, image ${image}`);
console.log(`Bucket gs://${bucket}, the services run as ${runSa}, Gen calls as ${genSa}\n`);

/** gcloud for a grant on an account that may have been made a moment ago: IAM can say "does not exist" for a minute. */
function grant(cmd) {
  for (let i = 0; ; i++) {
    try {
      return gcloud(args, [...cmd, '--format=none']);
    } catch (e) {
      if (i >= 9) throw e;
      console.log('  (not yet: trying again in 10 s)');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
    }
  }
}

if (args.setup) {
  console.log('Setup: the bucket, the service account, access');
  if (!gcloud(args, ['storage', 'buckets', 'describe', `gs://${bucket}`, P, '--format=value(name)'], { read: true })) {
    gcloud(args, ['storage', 'buckets', 'create', `gs://${bucket}`, P, `--location=${args.region}`, '--uniform-bucket-level-access', '--public-access-prevention']);
  }
  const lc = path.join(os.tmpdir(), 'hawkes-gen-cpu-lifecycle.json');
  fs.writeFileSync(lc, JSON.stringify({ rule: [{ action: { type: 'Delete' }, condition: { age: 7, matchesPrefix: ['cpu/'] } }] }));
  gcloud(args, ['storage', 'buckets', 'update', `gs://${bucket}`, P, `--lifecycle-file=${lc}`]);
  for (const [sa, title] of [[runSa, 'Hawkes Gen CPU service'], [genSa, 'Hawkes Gen control server']]) {
    if (!gcloud(args, ['iam', 'service-accounts', 'describe', sa, P, '--format=value(email)'], { read: true })) {
      gcloud(args, ['iam', 'service-accounts', 'create', sa.split('@')[0], P, `--display-name=${title}`]);
    }
    // The service reads inputs and writes outputs; Gen writes inputs and reads outputs.
    grant(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, P, `--member=serviceAccount:${sa}`, '--role=roles/storage.objectAdmin']);
  }
  console.log('');
}

const urls = {};
for (const cls of classes) {
  const c = spec.classes[cls];
  console.log(`${c.name} (${cls}): ${c.cpu} vCPU, ${c.memoryGi} GiB, ${c.concurrency} request(s) per instance, max ${c.maxInstances}, ${c.timeoutSeconds} s per request, about $${pricePerHour(spec, cls).toFixed(3)}/hour while a request runs`);
  const file = path.join(STATE_DIR, `service-${c.name}.yaml`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // JSON is YAML: gcloud reads it as is.
  fs.writeFileSync(file, JSON.stringify(serviceYaml(spec, cls, { image, region: args.region, serviceAccount: runSa, bucket }), null, 2));
  console.log(`  service definition: ${file}`);
  gcloud(args, ['run', 'services', 'replace', file, P, `--region=${args.region}`]);
  grant(['run', 'services', 'add-iam-policy-binding', c.name, P, `--region=${args.region}`, `--member=serviceAccount:${genSa}`, '--role=roles/run.invoker']);
  const policy = gcloud(args, ['run', 'services', 'get-iam-policy', c.name, P, `--region=${args.region}`, '--format=json'], { read: true });
  if (policy && /allUsers|allAuthenticatedUsers/.test(policy)) console.log(`  WARNING: ${c.name} is open to allUsers/allAuthenticatedUsers: remove that binding (only Gen's account may call it)`);
  const url = gcloud(args, ['run', 'services', 'describe', c.name, P, `--region=${args.region}`, '--format=value(status.url)'], { read: true });
  if (url) urls[cls] = url;
  console.log('');
}

const patch = { cpu: { cloudrun: { bucket, urls } } };
if (!args.apply) {
  console.log('Dry run: nothing deployed. Add --apply to deploy (scale to zero: nothing bills until a job comes).');
  if (Object.keys(urls).length) console.log(`\nServices already deployed answer at: ${JSON.stringify(urls)}`);
  process.exit(0);
}
saveState('cpu-urls.json', { ...readState('cpu-urls.json', {}), ...urls, bucket });
console.log('Point Gen at them (POST /v1/settings, owner key). Nothing moves until settings.cpu says cloudrun (all tools, or one):');
console.log(JSON.stringify(patch, null, 2));
console.log('  then e.g. { "cpu": { "tools": { "image.transform": "cloudrun" } } } to try one tool, or { "cpu": { "backend": "cloudrun" } } for all.');
