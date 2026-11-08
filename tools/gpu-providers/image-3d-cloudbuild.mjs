// Builds the 3D worker image (server/gpu3d) on Google Cloud Build, where the disk is as big as asked: five PyTorch
// venvs and Blender don't fit a GitHub runner's ~40 GB free (the first gpu3d-image builds ran out of disk). The image
// goes to Gen's private Artifact Registry repository (hawkes); .github/workflows/gpu3d-image.yml runs this with Gen's
// deployer identity (Workload Identity Federation, no key) and then copies the image to the public GHCR package
// (ghcr.io/jgriffith3433/hawkes-gen-gpu:3d-*) with crane, which streams layers and needs no disk. docs/3d-animation.md.
//
//   node tools/gpu-providers/image-3d-cloudbuild.mjs                     print the plan
//   node tools/gpu-providers/image-3d-cloudbuild.mjs --apply [--out F]   build and push; F gets IMAGE= and TAG= lines
//   options: --project hawkes-staging  --region us-east4  --repo hawkes  --machine E2_HIGHCPU_32  --disk 300
//
// Cloud Build bills by the build minute (an e2-highcpu-32 build of about 40 minutes is a dollar or two).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { contextFiles3d } from './image-context-3d.mjs';
import { APPLY, arg, say, header } from './lib.mjs';

const project = arg('project', 'hawkes-staging');
const region = arg('region', 'us-east4');
const repo = arg('repo', 'hawkes');
const machine = arg('machine', 'E2_HIGHCPU_32');
const disk = Number(arg('disk', '300'));
const out = arg('out');
const { files, hash } = contextFiles3d();
const tag = `3d-${hash}`;
const image = `${region}-docker.pkg.dev/${project}/${repo}/hawkes-gen-3d`;

const win = process.platform === 'win32';
const gcloud = (args) => {
  const r = spawnSync(win ? 'gcloud.cmd' : 'gcloud', args, { stdio: 'inherit', shell: win });
  if (r.status !== 0) throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed (exit ${r.status})`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen3d-ctx-'));
for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body.toString('utf8').replace(/\r\n/g, '\n'));
const config = {
  steps: [{ name: 'gcr.io/cloud-builders/docker', args: ['build', '--provenance=false', '-t', `${image}:${tag}`, '-t', `${image}:latest`, '.'] }],
  images: [`${image}:${tag}`, `${image}:latest`],
  options: { machineType: machine, diskSizeGb: disk },
  timeout: '7200s',
};
fs.writeFileSync(path.join(dir, 'cloudbuild.json'), JSON.stringify(config, null, 2));

header(`3D worker image on Cloud Build (${project}, ${region})`);
say(`image: ${image}:${tag} (and :latest), machine ${machine}, disk ${disk} GB`);
if (!APPLY) {
  say('\n(dry run: --apply builds and pushes)');
  process.exit(0);
}
gcloud(['builds', 'submit', dir, `--project=${project}`, `--region=${region}`, '--config', path.join(dir, 'cloudbuild.json')]);
say(`\nbuilt and pushed ${image}:${tag}`);
if (out) fs.appendFileSync(out, `IMAGE=${image}\nTAG=${tag}\n`);
