#!/usr/bin/env node
// Builds the CPU service's image (server/cpu-cloudrun/) with Cloud Build into Artifact Registry. docs/cpu-cloudrun.md.
//
//   node tools/cpu-cloudrun/build.mjs [--project hawkes-staging] [--region us-east4] [--machine default] [--apply]
//
// The context is only what the service runs (tools/cpu-cloudrun/lib.mjs buildContext: the Gen files server.ts and
// src/lod-mesh.ts import, post/*.py, the Dockerfile, requirements.txt, package.json at Gen's versions). Its tag is the
// hash of that context, so the same sources never build twice. Without --apply it writes the context for review and
// prints the commands; with --apply it creates the repository if missing and submits the build (about 10 minutes on the
// default machine: a few cents). The tag goes to .data/cloudrun/cpu-image.json for deploy.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, gcloud, saveState, STATE_DIR } from '../cloudrun/lib.mjs';
import { loadSpec, buildContext, imageTag } from './lib.mjs';

const args = parseArgs();
const spec = loadSpec();
if (!process.argv.some((a) => a.startsWith('--region'))) args.region = spec.region;
const ctx = buildContext();
const tag = args.tag ?? imageTag(args, spec, ctx);
const machine = args.machine ?? 'default';
const dir = path.join(STATE_DIR, `cpu-build-${ctx.hash}`);

console.log(`CPU image ${tag}`);
console.log(`  ${ctx.sources.length} Gen source files: ${ctx.sources.join(', ')}`);

const repo = gcloud(args, ['artifacts', 'repositories', 'describe', spec.repository, `--project=${args.project}`, `--location=${args.region}`, '--format=value(name)'], { read: true });
if (!repo) {
  console.log(`\nArtifact Registry repository ${spec.repository} in ${args.region}: ${args.apply ? 'creating it' : 'not found (or gcloud missing); it would be made with'}`);
  gcloud(args, ['artifacts', 'repositories', 'create', spec.repository, '--repository-format=docker', `--location=${args.region}`, `--project=${args.project}`, '--description=Hawkes Gen images']);
}
const have = gcloud(args, ['artifacts', 'docker', 'images', 'describe', tag, `--project=${args.project}`, '--format=value(image_summary.digest)'], { read: true });
if (have) {
  console.log(`\nThat tag is already built (${have}); nothing to do.`);
  saveState('cpu-image.json', { tag, project: args.project, region: args.region, built: 'existing' });
  process.exit(0);
}

fs.rmSync(dir, { recursive: true, force: true });
for (const [name, data] of Object.entries(ctx.files)) {
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}
console.log(`\nBuild context written to ${dir} (${Object.keys(ctx.files).length} files)`);

gcloud(args, [
  'builds', 'submit', dir, `--project=${args.project}`, `--region=${args.region}`, `--tag=${tag}`,
  ...(machine === 'default' ? [] : [`--machine-type=${machine}`]), '--timeout=2400s',
]);
if (!args.apply) {
  console.log('\nDry run: nothing built. Add --apply to build (Cloud Build minutes, a few cents).');
  process.exit(0);
}
saveState('cpu-image.json', { tag, project: args.project, region: args.region, built: new Date().toISOString() });
console.log(`\nBuilt ${tag}. Next: node tools/cpu-cloudrun/deploy.mjs --project ${args.project} --setup --apply (or tools/cpu-cloudrun/deploy.ps1)`);
