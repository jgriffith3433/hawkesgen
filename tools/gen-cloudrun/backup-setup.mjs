#!/usr/bin/env node
// Sets up Gen's scheduled backups on Cloud Run (docs/gen-cloudrun.md, "Backups"): the separate backup bucket with its
// retention, Gen's permission on it, the setting that names it, and a Cloud Scheduler job that calls POST /v1/admin/backup.
// Prints every command; changes nothing without --apply (needs gcloud signed in as J). Safe to repeat. Never touches live
// unless you pass --lane live.
//
//   node tools/gen-cloudrun/backup-setup.mjs --lane beta [--project hawkes-staging] [--region us-east4]
//        [--keep-days 30] [--schedule "15 3 * * *"] [--url https://beta.hawkesgen.ai] [--apply]
//   The scheduler needs the lane's owner key: pass it as env GEN_OWNER_KEY (never printed; it is stored in the job's header).
import { flag, gcloud, gcloudQuery, die, APPLY } from '../unity-cloudrun/common.mjs';

const lane = flag('lane');
if (!['beta', 'live'].includes(lane ?? '')) die('Which lane? --lane beta (try it there first) or --lane live.');
const project = flag('project', 'hawkes-staging');
const region = flag('region', 'us-east4');
const keepDays = Number(flag('keep-days', 30));
const schedule = flag('schedule', '15 3 * * *');
const service = lane === 'beta' ? 'gen-beta' : 'gen';
const url = flag('url', lane === 'beta' ? 'https://beta.hawkesgen.ai' : 'https://hawkesgen.ai');
const bucket = flag('bucket', `${project}-gen-backups`);
const sa = `gen-control@${project}.iam.gserviceaccount.com`;
const P = `--project=${project}`;
const key = process.env.GEN_OWNER_KEY || '<owner key>';
if (APPLY && key === '<owner key>') die('Set GEN_OWNER_KEY to the lane\'s owner key first (it goes into the scheduler job\'s header).');

console.log(`Backups for ${service} (${lane}): bucket gs://${bucket}, kept ${keepDays} days, schedule "${schedule}" UTC\n`);
console.log('# Bucket (separate from the state and library buckets), private, with retention');
if (gcloudQuery(['storage', 'buckets', 'describe', `gs://${bucket}`, P, '--format=value(name)']) === null) {
  gcloud(['storage', 'buckets', 'create', `gs://${bucket}`, P, `--location=${region}`, '--uniform-bucket-level-access', '--public-access-prevention']);
}
// Backups older than keep-days are deleted by Cloud Storage itself. Soft delete gives a week to undo a mistaken delete.
const lifecycle = JSON.stringify({ rule: [{ action: { type: 'Delete' }, condition: { age: keepDays } }] });
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const lc = path.join(os.tmpdir(), 'gen-backup-lifecycle.json');
fs.writeFileSync(lc, lifecycle);
gcloud(['storage', 'buckets', 'update', `gs://${bucket}`, P, `--lifecycle-file=${lc}`, '--format=none']);
console.log('\n# Gen may write backups (and nothing may delete them but the lifecycle rule: creator, not admin)');
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, P, `--member=serviceAccount:${sa}`, '--role=roles/storage.objectCreator', '--format=none'], { retries: 3 });
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, P, `--member=serviceAccount:${sa}`, '--role=roles/storage.objectViewer', '--format=none'], { retries: 3 });
console.log('\n# Tell the service where to put them (a new revision; Gen restarts once)');
gcloud(['run', 'services', 'update', service, P, `--region=${region}`, `--update-env-vars=HAWKESGEN_BACKUP_BUCKET=${bucket}`, '--format=none']);
console.log('\n# The schedule: Cloud Scheduler calls the admin route once a day (it wakes the instance if idle)');
const verb = gcloudQuery(['scheduler', 'jobs', 'describe', `${service}-backup`, P, `--location=${region}`, '--format=value(name)']) === null ? 'create' : 'update';
gcloud(['services', 'enable', 'cloudscheduler.googleapis.com', P, '--format=none']);
gcloud(['scheduler', 'jobs', verb, 'http', `${service}-backup`, P, `--location=${region}`, `--schedule=${schedule}`, '--time-zone=Etc/UTC',
  `--uri=${url}/v1/admin/backup`, '--http-method=POST', `--headers=Authorization=Bearer ${key}`, '--attempt-deadline=15m', '--max-retry-attempts=2', '--format=none']);
console.log(`\n# Try it now\n  gcloud scheduler jobs run ${service}-backup ${P} --location=${region}\n  node tools/gen-cloudrun/restore-backup.mjs --list --bucket ${bucket} --lane ${lane}`);
if (!APPLY) console.log('\n(dry run: nothing was changed. Add --apply once gcloud is signed in.)');
