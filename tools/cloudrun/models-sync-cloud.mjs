// Runs models-sync.mjs inside Google Cloud Build instead of on this PC: the 50+ GB of models go from Hugging Face to
// Cloud Storage over Google's network (minutes), not down and up a home connection (hours). Same arguments as
// models-sync.mjs; prints the plan and changes nothing without --apply.
//   node tools/cloudrun/models-sync-cloud.mjs --project hawkes-staging --region us-central1 --service gen-z-image,gen-qwen-edit [--apply]
// The build runs as the project's Cloud Build service account (the default compute account on new projects), which
// needs object write on the models bucket: grant it once (models-sync.mjs prints the bucket name):
//   gcloud storage buckets add-iam-policy-binding gs://<bucket> --member=serviceAccount:<number>-compute@developer.gserviceaccount.com --role=roles/storage.objectAdmin
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const pass = args.filter((a) => a !== '--apply');
const arg = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const project = arg('project') ?? 'hawkes-staging';
const region = arg('region') ?? 'us-central1';
const gcloud = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd') : 'gcloud';

// The source the build gets: the repo without data, packages or worktrees (models-sync needs src/ and tools/).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-models-sync-'));
for (const f of ['package.json', 'package-lock.json', 'tsconfig.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
for (const d of ['src', 'tools', 'server', 'workflows']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true, filter: (p) => !/node_modules|[\\/]\.data[\\/]/.test(p) });
const cmd = ['npm ci --no-audit --no-fund --ignore-scripts', `node tools/cloudrun/models-sync.mjs ${pass.map((a) => `'${a.replace(/'/g, '')}'`).join(' ')} --apply`].join(' && ');
fs.writeFileSync(path.join(dir, 'cloudbuild.yaml'), [
  'steps:',
  '  - name: node:24',
  '    entrypoint: bash',
  `    args: ['-c', ${JSON.stringify(cmd)}]`,
  `    env: ['GOOGLE_CLOUD_PROJECT=${project}']`,
  'timeout: 7200s',
  'options:',
  '  machineType: E2_HIGHCPU_8',
  '  logging: CLOUD_LOGGING_ONLY',
  '',
].join('\n'));
console.log(`Source for the build: ${dir}`);
console.log(`The build runs: ${cmd}`);
const submit = ['builds', 'submit', dir, `--project=${project}`, `--region=${region}`, `--config=${path.join(dir, 'cloudbuild.yaml')}`];
if (!apply) {
  console.log(`would run: gcloud ${submit.join(' ')}`);
  console.log('Dry run: nothing submitted. Add --apply (Cloud Build minutes, about $0.02 a minute; storage as models-sync.mjs prints).');
  process.exit(0);
}
const r = spawnSync(`"${gcloud}"`, submit, { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
