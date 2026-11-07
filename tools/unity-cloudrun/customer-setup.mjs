#!/usr/bin/env node
// Sets up the isolated Cloud Run job customer builds run on (docs/unity-cloudrun.md, "Customer mode"). Prints the gcloud
// commands; changes nothing without --apply.
//
//   node tools/unity-cloudrun/customer-setup.mjs [--project <gcp-project>] [--region us-east4] [--all]
//        [--for-job <job>] [--image <image>] [--shared-license] [--serial] [--timeout-minutes 40] [--sizes] [--offline] [--apply]
//
// --sizes also makes one job per machine size (settings.unityBuild.gcp.sizes; "<customer job>-<size>", the same job with
// other --cpu/--memory; the size equal to --cpu/--memory is the customer job itself). Gen makes a missing one at build
// time when its account may create jobs, and falls back to the customer job (with a warning) when it may not.
//
// Why: a customer's editor scripts run inside Unity, so whatever Google identity the build's container has, their code
// has too. J's job runs as hawkes-unity-build, which can read and write the whole bucket (J's Library caches, other
// builds). Customer builds therefore run only on a job of their own:
//   - Service account unity-customer@<project>: NO role on any bucket, no project role, nothing else. Its one grant is
//     secretAccessor on the Unity license secrets the job mounts (Cloud Run reads a mounted secret as the job's account).
//   - The job (settings.unityBuild.gcp.customerJob, default hawkes-unity-build-customer; for another Unity version's job
//     "<job>-customer", --all makes every one): the same image and size as J's job, env HAWKES_CUSTOMER_JOB=1 (the
//     container reaches the bucket only through the signed URLs Gen hands each execution), and no secret but the Unity
//     license: never GITHUB_TOKEN, never R2_BUILDS_TOKEN.
//   - License secrets: by default a Unity account of their own (unity-customer-email, unity-customer-password; with
//     --serial unity-customer-serial), because the job's account can read whatever it mounts, and so can the customer's
//     code through the metadata server. --shared-license mounts J's unity-email / unity-password instead (then a
//     customer's code can read J's Unity password: not recommended).
//   - Gen's service accounts (gen-control on Cloud Run, hawkes-gen on J's PC) may run that job with overrides
//     (roles/run.jobsExecutorWithOverrides on the job only) and act as unity-customer (on that account only). Gen signs
//     the URLs as itself (roles/iam.serviceAccountTokenCreator on itself: tools/gen-cloudrun/deploy.mjs grants it).
import { APPLY, config, flag, gcloud, gcloudQuery, die, done } from './common.mjs';

const c = config();
const P = `--project=${c.project}`;
const R = `--region=${c.region}`;
const customerSa = `unity-customer@${c.project}.iam.gserviceaccount.com`;
const genSas = [`gen-control@${c.project}.iam.gserviceaccount.com`, `hawkes-gen@${c.project}.iam.gserviceaccount.com`];
const timeoutMin = Number(flag('timeout-minutes', 40));
const shared = process.argv.includes('--shared-license');
const serial = process.argv.includes('--serial');
if (!c.customerJob) die('settings.unityBuild.gcp.customerJob is empty: pass --customer-job hawkes-unity-build-customer.');

// Which of J's jobs get a customer twin: --for-job, every version's job (--all), else the main job.
const own = [...new Set([c.job, ...Object.values(c.images)])];
const forJob = flag('for-job');
const jobs = forJob ? [forJob] : process.argv.includes('--all') ? own : [c.job];
const twin = (job) => (job === c.job ? c.customerJob : `${job}-customer`);
for (const j of jobs) if (own.includes(twin(j))) die(`The customer job for ${j} would be ${twin(j)}, which is one of J's own jobs.`);

console.log(`Project ${c.project}, region ${c.region}\nCustomer builds: ${jobs.map((j) => `${j} -> ${twin(j)}`).join(', ')}\nRuns as ${customerSa} (no roles)\n`);

console.log('# The customer service account: no roles anywhere');
if (gcloudQuery(['iam', 'service-accounts', 'describe', customerSa, P, '--format=value(email)']) === null) {
  gcloud(['iam', 'service-accounts', 'create', 'unity-customer', P, '--display-name=Hawkes Unity customer builds (no access to anything)']);
}
// Show any project role it has picked up (there must be none).
const roles = gcloudQuery(['projects', 'get-iam-policy', c.project, '--flatten=bindings[].members', `--filter=bindings.members:serviceAccount:${customerSa}`, '--format=value(bindings.role)']);
if (roles) console.log(`  WARNING: ${customerSa} has project roles it must not have: ${roles.split(/\s+/).join(', ')}. Remove them:\n${roles.split(/\s+/).map((r) => `    gcloud projects remove-iam-policy-binding ${c.project} --member=serviceAccount:${customerSa} --role=${r}`).join('\n')}`);
else if (roles === '') console.log('  (no project roles: good)');
if (c.bucket) {
  const onBucket = gcloudQuery(['storage', 'buckets', 'get-iam-policy', `gs://${c.bucket}`, P, '--flatten=bindings[].members', `--filter=bindings.members:serviceAccount:${customerSa}`, '--format=value(bindings.role)']);
  if (onBucket) console.log(`  WARNING: ${customerSa} has roles on gs://${c.bucket}: ${onBucket}. Remove them (gcloud storage buckets remove-iam-policy-binding).`);
}

console.log(`\n# The Unity license secrets it mounts (${shared ? "J's own: --shared-license" : 'a Unity account of their own'})`);
const secrets = shared
  ? [['unity-email', 'UNITY_EMAIL'], ['unity-password', 'UNITY_PASSWORD'], ...(serial ? [['unity-serial', 'UNITY_SERIAL']] : [])]
  : [['unity-customer-email', 'UNITY_EMAIL'], ['unity-customer-password', 'UNITY_PASSWORD'], ...(serial ? [['unity-customer-serial', 'UNITY_SERIAL']] : [])];
if (shared) console.log('  WARNING: the job\'s account can read these secrets, and a customer\'s editor code can use that account: it could read J\'s Unity password.');
const missingValues = [];
for (const [name] of secrets) {
  if (gcloudQuery(['secrets', 'describe', name, P, '--format=value(name)']) === null) gcloud(['secrets', 'create', name, P, '--replication-policy=automatic']);
  // Its only grant: read these secrets (Cloud Run mounts a secret as the job's account).
  gcloud(['secrets', 'add-iam-policy-binding', name, P, `--member=serviceAccount:${customerSa}`, '--role=roles/secretmanager.secretAccessor', '--format=none'], { retries: 9 });
  if (!gcloudQuery(['secrets', 'versions', 'list', name, P, '--limit=1', '--format=value(name)'])) missingValues.push(name);
}
if (missingValues.length) {
  console.log(`\nThese secrets have no value yet: ${missingValues.join(', ')}. Add each from a file holding only the value (no newline at the end), then delete the file:`);
  for (const n of missingValues) console.log(`  gcloud secrets versions add ${n} --data-file=<a file holding only the value> ${P}`);
  console.log('  (a Unity account without two-factor sign-in, used only by customer builds)');
  if (APPLY) { console.error('\nAdd them, then run this again with --apply.'); process.exit(3); }
}

// The jobs to deploy for one customer job: itself, and with --sizes one per other machine size.
const withSizes = process.argv.includes('--sizes');
const sizedOf = (cj) => [
  { name: cj, cpu: c.cpu, memoryGiB: c.memoryGiB },
  ...(withSizes ? Object.entries(c.sizes).filter(([, v]) => !(Number(v.cpu) === c.cpu && Number(v.memoryGiB) === c.memoryGiB)).map(([k, v]) => ({ name: `${cj}-${k}`, cpu: Number(v.cpu), memoryGiB: Number(v.memoryGiB), size: k })) : []),
];

for (const job of jobs) for (const sized of sizedOf(twin(job))) {
  const cj = sized.name;
  console.log(`\n# The customer job ${cj} (from ${job}${sized.size ? `, size ${sized.size}: ${sized.cpu} vCPU, ${sized.memoryGiB} GiB` : ''})`);
  const image = flag('image') ?? gcloudQuery(['run', 'jobs', 'describe', job, R, P, '--format=value(spec.template.spec.template.spec.containers[0].image)'])
    ?? (APPLY ? die(`Couldn't read ${job}'s image: pass --image <the image J's job runs> (or --for-job another job).`) : `<the image ${job} runs>`);
  gcloud([
    'run', 'jobs', 'deploy', cj, P, R, `--image=${image}`,
    `--cpu=${sized.cpu}`, `--memory=${sized.memoryGiB}Gi`, '--tasks=1', '--max-retries=0', `--task-timeout=${(timeoutMin + 15) * 60}s`,
    '--execution-environment=gen2', `--service-account=${customerSa}`,
    // Only the Unity license: never GITHUB_TOKEN, never R2_BUILDS_TOKEN. --set-secrets replaces any others.
    `--set-secrets=${secrets.map(([n, e]) => `${e}=${n}:latest`).join(',')}`,
    '--set-env-vars=HAWKES_WORK=/work,HAWKES_CUSTOMER_JOB=1',
    `--labels=project=hawkes-gen,role=unity-build-customer${sized.size ? `,hawkes-size=${sized.size}` : ''}`,
  ]);
  console.log(`\n# Gen may run ${cj} (that job only) and act as ${customerSa} (that account only)`);
  for (const sa of genSas) {
    if (gcloudQuery(['iam', 'service-accounts', 'describe', sa, P, '--format=value(email)']) === null && !process.argv.includes('--offline')) { console.log(`  (${sa} isn't there: skipped)`); continue; }
    gcloud(['run', 'jobs', 'add-iam-policy-binding', cj, P, R, `--member=serviceAccount:${sa}`, '--role=roles/run.jobsExecutorWithOverrides', '--format=none'], { retries: 9 });
    gcloud(['iam', 'service-accounts', 'add-iam-policy-binding', customerSa, P, `--member=serviceAccount:${sa}`, '--role=roles/iam.serviceAccountUser', '--format=none'], { retries: 9 });
  }
}

console.log(`
Check the license on the customer job (activates, opens a project, returns the license):
  gcloud run jobs execute ${twin(jobs[0])} ${R} ${P} --update-env-vars=HAWKES_LICENSE_CHECK=1 --wait
Then in Hawkes Gen (owner, each lane): POST /v1/settings with
  { "unityBuild": { "gcp": { "customerJob": "${c.customerJob}" } } }
Gen checks the job before every customer build (it runs as ${customerSa}, sets HAWKES_CUSTOMER_JOB=1, mounts only
UNITY_*) and refuses customer builds otherwise.`);
done();
