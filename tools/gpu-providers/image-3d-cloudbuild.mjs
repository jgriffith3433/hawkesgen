// Builds the 3D worker image (server/gpu3d) on Google Cloud Build, where the disk is as big as asked: five PyTorch
// venvs and Blender don't fit a GitHub runner's ~40 GB free (the first gpu3d-image builds ran out of disk). The image
// goes to Gen's private Artifact Registry repository (hawkes); .github/workflows/gpu3d-image.yml runs this with Gen's
// deployer identity (Workload Identity Federation, no key) and then copies the image to the public GHCR package
// (ghcr.io/jgriffith3433/hawkes-gen-gpu:3d-*) with crane, which streams layers and needs no disk. docs/3d-animation.md.
//
//   node tools/gpu-providers/image-3d-cloudbuild.mjs                     print the plan
//   node tools/gpu-providers/image-3d-cloudbuild.mjs --apply [--out F]   build and push; F gets IMAGE= and TAG= lines
//   options: --project hawkes-staging  --region us-east4  --repo hawkes  --machine <type>  --disk 300
//
// Cloud Build bills by the build minute (the default machine, about an hour: well under a dollar).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { contextFiles3d } from './image-context-3d.mjs';
import { APPLY, arg, say, header } from './lib.mjs';

const project = arg('project', 'hawkes-staging');
const region = arg('region', 'us-east4');
const repo = arg('repo', 'hawkes');
// The default machine: larger ones need a quota this project doesn't have (FAILED_PRECONDITION on E2_HIGHCPU_32).
const machine = arg('machine', '');
const disk = Number(arg('disk', '300'));
const out = arg('out');
const { files, hash } = contextFiles3d();
const tag = `3d-${hash}`;
const image = `${region}-docker.pkg.dev/${project}/${repo}/hawkes-gen-3d`;

const win = process.platform === 'win32';
const gcloud = (args, capture = false) => {
  const r = spawnSync(win ? 'gcloud.cmd' : 'gcloud', args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', shell: win, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed (exit ${r.status})`);
  return capture ? r.stdout.trim() : '';
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen3d-ctx-'));
for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body.toString('utf8').replace(/\r\n/g, '\n'));
const config = {
  steps: [{ name: 'gcr.io/cloud-builders/docker', args: ['build', '-t', `${image}:${tag}`, '-t', `${image}:latest`, '.'] }],
  images: [`${image}:${tag}`, `${image}:latest`],
  options: { ...(machine ? { machineType: machine } : {}), diskSizeGb: disk },
  timeout: '10800s',
};
fs.writeFileSync(path.join(dir, 'cloudbuild.json'), JSON.stringify(config, null, 2));

header(`3D worker image on Cloud Build (${project}, ${region})`);
say(`image: ${image}:${tag} (and :latest), machine ${machine || 'default'}, disk ${disk} GB`);
if (!APPLY) {
  say('\n(dry run: --apply builds and pushes)');
  process.exit(0);
}
// As tools/gen-cloudrun/build.mjs does for CI's deployer: a named staging folder (gcloud then skips the default bucket's
// owner check, which needs project-wide listing), started without waiting, its status read every 30 s (streaming the
// logs needs project Viewer).
const id = gcloud(['builds', 'submit', dir, `--project=${project}`, `--region=${region}`, '--config', path.join(dir, 'cloudbuild.json'),
  `--gcs-source-staging-dir=gs://${project}_cloudbuild/source`, '--async', '--format=value(id)'], true);
if (!id) throw new Error('Cloud Build gave no build id');
say(`build ${id} started: https://console.cloud.google.com/cloud-build/builds;region=${region}/${id}?project=${project}`);
for (let i = 0; ; i++) {
  await new Promise((r) => setTimeout(r, 30_000));
  const st = gcloud(['builds', 'describe', id, `--project=${project}`, `--region=${region}`, '--format=value(status)'], true);
  if (i % 4 === 0 || !['QUEUED', 'WORKING'].includes(st)) say(`${new Date().toISOString()} ${st}`);
  if (st === 'SUCCESS') break;
  if (!['QUEUED', 'WORKING', 'PENDING'].includes(st)) throw new Error(`Cloud Build ${id} ended ${st}`);
}
say(`\nbuilt and pushed ${image}:${tag}`);
if (out) fs.appendFileSync(out, `IMAGE=${image}\nTAG=${tag}\n`);
