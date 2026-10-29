#!/usr/bin/env node
// Creates or updates everything the Unity cloud builds use in one Google Cloud project, then the Cloud Run job itself.
//
//   node tools/unity-cloudrun/deploy-job.mjs --project <gcp-project> --bucket <bucket> --image <image> [--region us-east4]
//        [--serial] [--timeout-minutes 40] [--offline] [--apply]
//
// What it sets up (each step is safe to run again):
//   - APIs: Cloud Run, Cloud Build, Artifact Registry, Secret Manager, Cloud Logging, IAM.
//   - The bucket (uniform access, in the job's region), with a lifecycle rule: unity-builds/ objects go after 14 days.
//     Caches (unity-cache/) are kept until replaced or cleared.
//   - Two service accounts: hawkes-unity-build (what the job runs as: reads/writes the bucket, reads the secrets, writes
//     logs) and hawkes-gen (what Hawkes Gen uses: runs the job with overrides, reads its logs, reads/writes the bucket).
//   - The secrets the job reads (made empty if missing; J adds the values, see docs/unity-cloudrun.md):
//       unity-email, unity-password (UNITY_EMAIL, UNITY_PASSWORD: the Unity account each build signs in with to activate
//       a Personal license, returned after), github-token (GITHUB_TOKEN), and with --serial: unity-serial (Plus/Pro).
//   - The job: 8 vCPU, 32 GiB (the most Cloud Run gives), one task, no retries, task timeout = build limit + 15 min,
//     second-generation execution environment.
import { APPLY, config, flag, imageBase, runtimeSa, genSa, gcloud, gcloudQuery, die, done } from './common.mjs';

const c = config();
if (!c.bucket) die('Which bucket? Pass --bucket <name> (e.g. hawkes-unity-<project>), or set settings.unityBuild.gcp.bucket.');
const image = flag('image') ?? die(`Which image? Pass --image ${imageBase(c)}:<tag> (build-image.mjs prints it).`);
const serial = process.argv.includes('--serial');
const timeoutMin = Number(flag('timeout-minutes', 40));
const P = `--project=${c.project}`;
const rsa = runtimeSa(c);
const gsa = genSa(c);

console.log(`Project ${c.project}, region ${c.region}, job ${c.job}, bucket gs://${c.bucket}\nImage ${image}\n`);

console.log('# APIs');
gcloud(['services', 'enable', 'run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'secretmanager.googleapis.com', 'logging.googleapis.com', 'iam.googleapis.com', P]);

console.log('\n# The bucket');
if (gcloudQuery(['storage', 'buckets', 'describe', `gs://${c.bucket}`, P, '--format=value(name)']) === null) {
  gcloud(['storage', 'buckets', 'create', `gs://${c.bucket}`, P, `--location=${c.region}`, '--uniform-bucket-level-access', '--public-access-prevention']);
}
// Lifecycle: a build's inputs, outputs and log go after 14 days.
const lifecycle = JSON.stringify({ rule: [{ action: { type: 'Delete' }, condition: { age: 14, matchesPrefix: ['unity-builds/'] } }] });
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const lcFile = path.join(os.tmpdir(), 'hawkes-unity-lifecycle.json');
fs.writeFileSync(lcFile, lifecycle);
gcloud(['storage', 'buckets', 'update', `gs://${c.bucket}`, P, `--lifecycle-file=${lcFile}`]);

console.log('\n# Service accounts');
for (const [name, title] of [['hawkes-unity-build', 'Hawkes Unity cloud build (the job)'], ['hawkes-gen', 'Hawkes Gen (starts and follows the builds)']]) {
  if (gcloudQuery(['iam', 'service-accounts', 'describe', `${name}@${c.project}.iam.gserviceaccount.com`, P, '--format=value(email)']) === null) {
    gcloud(['iam', 'service-accounts', 'create', name, P, `--display-name=${title}`]);
  }
}
const bucketRole = (sa) => gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${c.bucket}`, P, `--member=serviceAccount:${sa}`, '--role=roles/storage.objectAdmin', '--format=none'], { retries: 9 });
bucketRole(rsa);
bucketRole(gsa);
gcloud(['projects', 'add-iam-policy-binding', c.project, `--member=serviceAccount:${rsa}`, '--role=roles/logging.logWriter', '--condition=None', '--format=none'], { retries: 9 });
gcloud(['projects', 'add-iam-policy-binding', c.project, `--member=serviceAccount:${gsa}`, '--role=roles/logging.viewer', '--condition=None', '--format=none'], { retries: 9 });
// run.developer includes run.jobs.runWithOverrides and executions get/cancel; actAs on the job's account to start it.
gcloud(['projects', 'add-iam-policy-binding', c.project, `--member=serviceAccount:${gsa}`, '--role=roles/run.developer', '--condition=None', '--format=none'], { retries: 9 });
gcloud(['iam', 'service-accounts', 'add-iam-policy-binding', rsa, P, `--member=serviceAccount:${gsa}`, '--role=roles/iam.serviceAccountUser', '--format=none'], { retries: 9 });

console.log('\n# Secrets (values are J\'s to add; see docs/unity-cloudrun.md)');
const secrets = [['unity-email', 'UNITY_EMAIL'], ['unity-password', 'UNITY_PASSWORD'], ['github-token', 'GITHUB_TOKEN'], ['r2-builds', 'R2_BUILDS_TOKEN'], ...(serial ? [['unity-serial', 'UNITY_SERIAL']] : [])];
const missingValues = [];
for (const [name] of secrets) {
  if (gcloudQuery(['secrets', 'describe', name, P, '--format=value(name)']) === null) {
    gcloud(['secrets', 'create', name, P, '--replication-policy=automatic']);
  }
  gcloud(['secrets', 'add-iam-policy-binding', name, P, `--member=serviceAccount:${rsa}`, '--role=roles/secretmanager.secretAccessor', '--format=none'], { retries: 9 });
  if (!gcloudQuery(['secrets', 'versions', 'list', name, P, '--limit=1', '--format=value(name)'])) missingValues.push(name);
}
if (missingValues.length) {
  console.log(`\nThese secrets have no value yet, so the job can't be deployed until J adds them: ${missingValues.join(', ')}`);
  console.log(`  powershell -ExecutionPolicy Bypass -File tools\\unity-cloudrun\\add-secrets.ps1 -Project ${c.project}`);
  console.log('  (it asks for the Unity email, the Unity password and the GitHub token without showing them, and adds each as a secret version)');
  // Exit 3: everything is ready but the secrets' values (pilot.ps1 goes on to ask for them).
  if (APPLY) { console.error('\nAdd them, then run this again with --apply.'); process.exit(3); }
}

console.log('\n# The job');
gcloud([
  'run', 'jobs', 'deploy', c.job, P, `--region=${c.region}`, `--image=${image}`,
  `--cpu=${c.cpu}`, `--memory=${c.memoryGiB}Gi`, '--tasks=1', '--max-retries=0', `--task-timeout=${(timeoutMin + 15) * 60}s`,
  '--execution-environment=gen2', `--service-account=${rsa}`,
  `--set-secrets=${secrets.map(([n, e]) => `${e}=${n}:latest`).join(',')}`,
  '--set-env-vars=HAWKES_WORK=/work',
  '--labels=project=hawkes-gen,role=unity-build',
]);

console.log(`
Then in Hawkes Gen (owner): POST /v1/settings with
  { "unityBuild": { "gcp": { "project": "${c.project}", "region": "${c.region}", "job": "${c.job}", "bucket": "${c.bucket}" }, "projects": { "breakingthrough": "cloudrun" } } }
(the pilot: only breakingthrough goes to the cloud; "backend": "cloudrun" later moves every project without its own entry)
and GOOGLE_APPLICATION_CREDENTIALS in Gen's .env pointing at a key for ${gsa}
  (gcloud iam service-accounts keys create hawkes-gen-gcp.json --iam-account=${gsa} ${P}).`);
done();
