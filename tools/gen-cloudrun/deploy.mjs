#!/usr/bin/env node
// Deploys Hawkes Gen as the Cloud Run service `gen` (docs/gen-cloudrun.md). Prints every step; changes things only
// with --apply. J runs it through deploy.ps1 (IAM and secret writes are his).
//
//   node tools/gen-cloudrun/deploy.mjs [--lane live|beta] [--project hawkes-staging] [--region us-east4] [--apply]
//
// 1. APIs; the state bucket (the databases through Litestream, settings) and the library bucket (every file).
// 2. Gen's account gen-control@ (the GPU and CPU services already take its calls): the buckets, Unity cloud builds
//    (run.developer, logging.viewer, acting as the build job's account), its secrets.
// 3. Secrets: the provider keys from this PC's hawkesgen\.env (values are never printed) and a new owner key.
// 4. The service: the image tools/gen-cloudrun/build.mjs made, one instance at most, none while idle, CPU while an
//    instance lives (the queue runs between requests), open to the internet (Gen checks keys itself).
// 5. Its own URL into its environment (the keep-alive), the starting settings, and this PC's ~/.hawkes/client.json
//    pointed at it (the old one kept as client.aws.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { flag, gcloud, gcloudQuery, die, done, ROOT, APPLY } from '../unity-cloudrun/common.mjs';

const project = flag('project', 'hawkes-staging');
const region = flag('region', 'us-east4');
// The lane (J, 2026-10-28: dev -> beta -> main): live is `gen` (gen.hawkesgen.ai, from main); beta is `gen-beta`
// (gen-beta.hawkesgen.ai, from beta) with its own database, library and owner key, so testing never touches live
// customers. Same image, same account, same provider keys.
const lane = flag('lane', 'live');
if (!['live', 'beta'].includes(lane)) die(`--lane is live or beta, not ${lane}`);
const beta = lane === 'beta';
const service = flag('service', beta ? 'gen-beta' : 'gen');
const P = `--project=${project}`;
const sa = `gen-control@${project}.iam.gserviceaccount.com`;
const stateBucket = flag('state-bucket', `${project}-${beta ? 'gen-beta' : 'gen'}-state`);
const libraryBucket = flag('library-bucket', `${project}-${beta ? 'gen-beta' : 'gen'}-library`);
const ownerSecret = beta ? 'gen-beta-owner-key' : 'gen-owner-key';
const unityBucket = `hawkes-unity-${project}`;
const unityJobSa = `hawkes-unity-build@${project}.iam.gserviceaccount.com`;

const imageFile = path.join(ROOT, '.data', 'cloudrun', 'gen-image.json');
const image = flag('image', fs.existsSync(imageFile) ? JSON.parse(fs.readFileSync(imageFile, 'utf8')).tag : null);
if (!image) die('No image yet: node tools/gen-cloudrun/build.mjs --apply');
console.log(`Gen on Cloud Run: ${service} in ${project} / ${region}\nImage ${image}\nRuns as ${sa}\n`);

console.log('# APIs');
gcloud(['services', 'enable', 'run.googleapis.com', 'secretmanager.googleapis.com', 'artifactregistry.googleapis.com', 'cloudbuild.googleapis.com', 'storage.googleapis.com', P, '--format=none']);

console.log('\n# Buckets');
for (const b of [stateBucket, libraryBucket]) {
  if (gcloudQuery(['storage', 'buckets', 'describe', `gs://${b}`, P, '--format=value(name)']) === null) {
    gcloud(['storage', 'buckets', 'create', `gs://${b}`, P, `--location=${region}`, '--uniform-bucket-level-access', '--public-access-prevention']);
  }
}
// Old versions of the state (settings, Litestream's snapshots) are kept a while: a bad write can be undone.
gcloud(['storage', 'buckets', 'update', `gs://${stateBucket}`, P, '--versioning', '--format=none']);

console.log('\n# Gen\'s account and what it may do');
if (gcloudQuery(['iam', 'service-accounts', 'describe', sa, P, '--format=value(email)']) === null) {
  gcloud(['iam', 'service-accounts', 'create', 'gen-control', P, '--display-name=Hawkes Gen (the service and its calls to the GPU, CPU and build jobs)']);
}
for (const b of [stateBucket, libraryBucket]) {
  gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${b}`, P, `--member=serviceAccount:${sa}`, '--role=roles/storage.objectAdmin', '--format=none'], { retries: 9 });
}
if (gcloudQuery(['storage', 'buckets', 'describe', `gs://${unityBucket}`, P, '--format=value(name)']) !== null) {
  gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${unityBucket}`, P, `--member=serviceAccount:${sa}`, '--role=roles/storage.objectAdmin', '--format=none'], { retries: 9 });
}
// run.developer: start and follow Unity build jobs and call the GPU and CPU services; logging.viewer: read build logs.
for (const role of ['roles/run.developer', 'roles/logging.viewer', 'roles/logging.logWriter']) {
  gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${sa}`, `--role=${role}`, '--condition=None', '--format=none'], { retries: 9 });
}
// Signing as itself (IAM signBlob): the GPU broker's short-lived signed URLs for workers on other providers
// (src/providers/gpu/sign.ts, docs/gpu-providers.md). No key file: IAM signs.
gcloud(['iam', 'service-accounts', 'add-iam-policy-binding', sa, P, `--member=serviceAccount:${sa}`, '--role=roles/iam.serviceAccountTokenCreator', '--format=none'], { retries: 9 });
if (gcloudQuery(['iam', 'service-accounts', 'describe', unityJobSa, P, '--format=value(email)']) !== null) {
  gcloud(['iam', 'service-accounts', 'add-iam-policy-binding', unityJobSa, P, `--member=serviceAccount:${sa}`, '--role=roles/iam.serviceAccountUser', '--format=none'], { retries: 9 });
}

console.log('\n# Secrets (values never printed)');
// Provider keys from this PC's .env. AWS keys stay behind: nothing on Google uses them.
const envFile = path.join(ROOT, '.env');
const envVals = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) envVals[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const KEYS = ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'COMFY_ORG_API_KEY', 'COPILOT_GITHUB_TOKEN', 'CURSOR_API_KEY',
  // GPU providers beyond Google's (docs/gpu-providers.md), each only when J has put it in .env.
  'RUNPOD_API_KEY', 'MODAL_PROXY_KEY', 'MODAL_PROXY_SECRET', 'GPU_HTTP_TOKEN', 'GPU_WORKER_TOKEN'];
const secretName = (k) => `gen-${k.toLowerCase().replace(/_/g, '-')}`;
const mounted = [];
function putSecret(name, value) {
  if (gcloudQuery(['secrets', 'describe', name, P, '--format=value(name)']) === null) {
    gcloud(['secrets', 'create', name, P, '--replication-policy=automatic', '--format=none']);
  }
  if (APPLY) {
    const tmp = path.join(os.tmpdir(), `gen-secret-${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(tmp, value, { mode: 0o600 });
    try { gcloud(['secrets', 'versions', 'add', name, `--data-file=${tmp}`, P, '--format=none']); } finally { fs.rmSync(tmp, { force: true }); }
  } else console.log(`  (dry run) gcloud secrets versions add ${name} --data-file=<a temporary file with the value>`);
  gcloud(['secrets', 'add-iam-policy-binding', name, P, `--member=serviceAccount:${sa}`, '--role=roles/secretmanager.secretAccessor', '--format=none'], { retries: 9 });
}
for (const k of KEYS) {
  if (!envVals[k]) { console.log(`  ${k}: not in .env, skipped`); continue; }
  // Only a new value is added: the same key twice would just be a second identical version.
  const name = secretName(k);
  const latest = gcloudQuery(['secrets', 'versions', 'access', 'latest', `--secret=${name}`, P]);
  if (latest !== envVals[k]) putSecret(name, envVals[k]);
  else console.log(`  ${name}: unchanged`);
  mounted.push(`${k}=${name}:latest`);
}
// The owner key: made once, kept in Secret Manager; Gen makes it the owner on an empty database (src/cloudhost.ts).
let ownerKey = gcloudQuery(['secrets', 'versions', 'access', 'latest', `--secret=${ownerSecret}`, P]);
if (!ownerKey) {
  ownerKey = `hg_${crypto.randomBytes(24).toString('base64url')}`;
  putSecret(ownerSecret, ownerKey);
}
mounted.push(`HAWKESGEN_OWNER_KEY=${ownerSecret}:latest`);

console.log('\n# The service');
const envVars = [
  `HAWKESGEN_LANE=${lane}`,
  `HAWKESGEN_STATE_BUCKET=${stateBucket}`,
  'HAWKESGEN_LIBRARY_STORE=gcs',
  `HAWKESGEN_LIBRARY_BUCKET=${libraryBucket}`,
];
// The AWS fleet without keys (optional): the metadata server's identity token traded for the role made by
// deploy/gcp/aws-federation.mjs (src/providers/gceaws.ts). --aws-role <arn>, or HAWKES_AWS_ROLE_ARN in .env.
const awsRole = flag('aws-role', envVals.HAWKES_AWS_ROLE_ARN || '');
if (awsRole) envVars.push(`HAWKES_AWS_ROLE_ARN=${awsRole}`);
else console.log('  HAWKES_AWS_ROLE_ARN: not set, so the AWS fleet stays off from Cloud Run (docs/gpu-providers.md)');
// The fixed address the fleet's security groups let in (tools/gpu-providers/egress.mjs makes it): --egress-ip <ip>.
const egressIp = flag('egress-ip', '');
if (egressIp) envVars.push(`HAWKES_PUBLIC_IP=${egressIp}`);
gcloud(['run', 'deploy', service, `--image=${image}`, `--region=${region}`, P,
  `--service-account=${sa}`, '--allow-unauthenticated',
  '--min-instances=0', '--max-instances=1', '--no-cpu-throttling', '--cpu=2', '--memory=4Gi',
  '--concurrency=80', '--timeout=3600', '--execution-environment=gen2',
  `--set-env-vars=${envVars.join(',')}`, `--set-secrets=${mounted.join(',')}`, '--format=none']);
if (!APPLY) { done(); process.exit(0); }

const url = gcloudQuery(['run', 'services', 'describe', service, `--region=${region}`, P, '--format=value(status.url)']);
if (!url) die('The service has no URL yet: run this again in a minute.');
console.log(`\nService URL: ${url}`);
gcloud(['run', 'services', 'update', service, `--region=${region}`, P, `--update-env-vars=HAWKESGEN_PUBLIC_URL=${url}`, '--format=none']);

console.log('\n# Waiting for it to answer');
let ok = false;
for (let i = 0; i < 30 && !ok; i++) {
  ok = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.ok).catch(() => false);
  if (!ok) await new Promise((r) => setTimeout(r, 5000));
}
if (!ok) die(`${url}/v1/health doesn't answer yet: look at the logs (gcloud run services logs read ${service} --region ${region} ${P})`);
const auth = { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' };
const who = await fetch(`${url}/v1/clients`, { headers: auth }).then((r) => r.status);
if (who !== 200) die(`The owner key was refused (${who}).`);
console.log('  health ok, owner key accepted');

// Starting settings: Unity builds on Cloud Run (the pilot's job and bucket; breakingthrough first, as planned).
const settings = {
  storage: { provider: 'gcs', bucket: libraryBucket },
  unityBuild: { gcp: { project, region, job: 'hawkes-unity-build', bucket: unityBucket }, projects: { breakingthrough: 'cloudrun' } },
};
const s = await fetch(`${url}/v1/settings`, { method: 'POST', headers: auth, body: JSON.stringify(settings) });
console.log(`  settings: ${s.ok ? 'saved' : `refused (${s.status}): ${(await s.text()).slice(0, 200)}`}`);

// This PC's clients (CLI, MCP, project tools) use ~/.hawkes/client.json: point it at the new Gen.
const cj = path.join(os.homedir(), '.hawkes', 'client.json');
if (beta && fs.existsSync(cj)) {
  // Beta never replaces live in this PC's clients: kept beside it for tools that ask for beta.
  const cur = JSON.parse(fs.readFileSync(cj, 'utf8'));
  fs.writeFileSync(cj, JSON.stringify({ ...cur, genBetaUrl: url, genBetaKey: ownerKey }, null, 2));
  console.log(`  ${cj}: genBetaUrl and genBetaKey saved (live's genUrl unchanged)`);
} else if (fs.existsSync(cj)) {
  const cur = JSON.parse(fs.readFileSync(cj, 'utf8'));
  const backup = path.join(path.dirname(cj), 'client.aws.json');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(cur, null, 2));
  fs.writeFileSync(cj, JSON.stringify({ ...cur, genUrl: url, genKey: ownerKey }, null, 2));
  console.log(`  ${cj} now points at ${url} (the old one: ${backup})`);
}
done();
