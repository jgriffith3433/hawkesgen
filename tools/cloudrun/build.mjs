#!/usr/bin/env node
// Builds the GPU worker image (server/cloudrun/) with Cloud Build into Artifact Registry. docs/cloudrun.md, "Deploy".
//
//   node tools/cloudrun/build.mjs [--project hawkes-staging] [--region us-east4] [--machine e2-highcpu-32] [--apply]
//
// The image holds ComfyUI at models.json's tag and its pinned custom nodes, and worker.py; no models. Its tag is
// <comfy tag>-<hash of the build context>, so the same sources never build twice (an existing tag is reported, not
// rebuilt). Without --apply it prints the gcloud commands and the context it would send; with --apply it creates the
// Artifact Registry repository if missing and submits the build (about 15-25 minutes; Cloud Build bills by the minute,
// roughly $0.06/min on e2-highcpu-32). The built tag goes to .data/cloudrun/image.json for deploy.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, loadServiceMap, contextFiles, imageTag, gcloud, saveState, STATE_DIR } from './lib.mjs';

const args = parseArgs();
const map = loadServiceMap();
const { files, comfy, hash } = contextFiles();
const tag = args.tag ?? imageTag(args, map);
const machine = args.machine ?? 'e2-highcpu-32';
const ctx = path.join(STATE_DIR, `build-${hash}`);

console.log(`Worker image ${tag}`);
console.log(`  ComfyUI ${comfy.tag} (${comfy.repo}), ${files['nodes.txt'].toString().trim().split('\n').length} custom nodes, context ${hash}`);

const repo = gcloud(args, ['artifacts', 'repositories', 'describe', map.repository, `--project=${args.project}`, `--location=${args.region}`, '--format=value(name)'], { read: true });
if (!repo) {
  console.log(`\nArtifact Registry repository ${map.repository} in ${args.region}: ${args.apply ? 'creating it' : 'not found (or gcloud missing); it would be made with'}`);
  gcloud(args, ['artifacts', 'repositories', 'create', map.repository, '--repository-format=docker', `--location=${args.region}`, `--project=${args.project}`, '--description=Hawkes Gen GPU worker images']);
}
const have = gcloud(args, ['artifacts', 'docker', 'images', 'describe', tag, `--project=${args.project}`, '--format=value(image_summary.digest)'], { read: true });
if (have) {
  console.log(`\nThat tag is already built (${have}); nothing to do.`);
  saveState('image.json', { tag, project: args.project, region: args.region, built: 'existing' });
  process.exit(0);
}

fs.rmSync(ctx, { recursive: true, force: true });
fs.mkdirSync(ctx, { recursive: true });
for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(ctx, name), data);
console.log(`\nBuild context written to ${ctx} (${Object.keys(files).join(', ')})`);

gcloud(args, [
  'builds', 'submit', ctx, `--project=${args.project}`, `--region=${args.region}`, `--tag=${tag}`,
  `--machine-type=${machine}`, '--disk-size=200', '--timeout=3600s',
]);
if (!args.apply) {
  console.log('\nDry run: nothing built. Add --apply to build (Cloud Build minutes, J\'s OK).');
  process.exit(0);
}
saveState('image.json', { tag, project: args.project, region: args.region, built: new Date().toISOString() });
console.log(`\nBuilt ${tag}. Next: node tools/cloudrun/deploy.mjs --project ${args.project} --region ${args.region}`);
