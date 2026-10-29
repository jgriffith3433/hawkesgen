#!/usr/bin/env node
// Builds the Unity cloud build image (server/unity-cloudrun) with Cloud Build and pushes it to Artifact Registry.
//
//   node tools/unity-cloudrun/build-image.mjs --project <gcp-project> [--region us-east4] [--apply]
//
// The tag is <unity>-<hash of the Dockerfile and entrypoint>, so the same files never build twice and the job can be
// pinned to an exact image. Costs: Cloud Build minutes on e2-highcpu-8 (about $0.016/min; a build is ~10-15 min, the
// GameCI base is 7.4 GB) and Artifact Registry storage (~$0.10/GB-month, ~7.5 GB per image kept).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, APPLY, config, imageBase, gcloud, gcloudQuery, done } from './common.mjs';

const c = config();
const dir = path.join(ROOT, 'server', 'unity-cloudrun');
const hash = crypto.createHash('sha256');
for (const f of ['Dockerfile', 'entrypoint.sh', 'github.sh', 'r2.mjs']) hash.update(fs.readFileSync(path.join(dir, f)));
const tag = `${c.unity}-${hash.digest('hex').slice(0, 10)}`;
const image = `${imageBase(c)}:${tag}`;

console.log(`Image: ${image}\n`);
if (gcloudQuery(['artifacts', 'repositories', 'describe', c.registry, `--location=${c.region}`, `--project=${c.project}`, '--format=value(name)']) === null) {
  console.log(`The Artifact Registry repository "${c.registry}" isn't there (or gcloud can't see it): making it.`);
  gcloud(['artifacts', 'repositories', 'create', c.registry, '--repository-format=docker', `--location=${c.region}`, `--project=${c.project}`, '--description=Hawkes Gen build images']);
}
if (gcloudQuery(['artifacts', 'docker', 'images', 'describe', image, `--project=${c.project}`, '--format=value(image_summary.digest)'])) {
  console.log('That image is already built (same Dockerfile and entrypoint). Nothing to do.');
  console.log(`Deploy it: node tools/unity-cloudrun/deploy-job.mjs --project ${c.project} --image ${image}`);
  process.exit(0);
}
gcloud(['builds', 'submit', dir, `--project=${c.project}`, `--region=${c.region}`, `--tag=${image}`, '--disk-size=100', '--timeout=3600s']);
console.log(`\nNext: node tools/unity-cloudrun/deploy-job.mjs --project ${c.project} --image ${image}${APPLY ? '' : ' (after this runs with --apply)'}`);
done();
