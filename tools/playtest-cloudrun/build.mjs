#!/usr/bin/env node
// Builds the playtest service's image (server/playtest-cloudrun/) with Cloud Build into Artifact Registry.
// docs/playtest-cloudrun.md, "Pilot".
//
//   node tools/playtest-cloudrun/build.mjs [--variant gpu|cpu] [--project hawkes-staging] [--region us-east4] [--machine default] [--apply]
//
// --variant cpu builds gen-playtest-cpu from Dockerfile.cpu (no NVIDIA files: WebGL on SwiftShader); its tag goes to
// .data/cloudrun/playtest-cpu-image.json.
//
// The image is Playwright's own (mcr.microsoft.com/playwright:v<Gen's version>-noble) plus ffmpeg, the GLVND EGL and
// Vulkan loaders with the NVIDIA vendor files, and the service (server.mjs, gpu.mjs). Its tag is
// pw<version>-<hash of the context>, so the same sources never build twice. Without --apply it prints the commands and
// writes the context for review; with --apply it creates the Artifact Registry repository if missing and submits the
// build (about 5 minutes; Cloud Build bills by the minute, a few cents on the default machine). The tag goes to
// .data/cloudrun/playtest-image.json for deploy.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, gcloud, saveState, STATE_DIR } from '../cloudrun/lib.mjs';
import { loadSpec, buildContext, imageTag, variantOf, stateName } from './lib.mjs';

const args = parseArgs();
const variant = variantOf(args.variant);
const spec = loadSpec(variant);
if (!process.argv.some((a) => a.startsWith('--region'))) args.region = spec.region;
const ctx = buildContext(undefined, variant);
const tag = args.tag ?? imageTag(args, spec, ctx);
const machine = args.machine ?? 'default';
const dir = path.join(STATE_DIR, `playtest-build-${variant}-${ctx.hash}`);

console.log(`Playtest image (${variant}) ${tag}`);
console.log(`  Playwright ${ctx.version} (Gen's package-lock.json), context ${ctx.hash}`);

const repo = gcloud(args, ['artifacts', 'repositories', 'describe', spec.repository, `--project=${args.project}`, `--location=${args.region}`, '--format=value(name)'], { read: true });
if (!repo) {
  console.log(`\nArtifact Registry repository ${spec.repository} in ${args.region}: ${args.apply ? 'creating it' : 'not found (or gcloud missing); it would be made with'}`);
  gcloud(args, ['artifacts', 'repositories', 'create', spec.repository, '--repository-format=docker', `--location=${args.region}`, `--project=${args.project}`, '--description=Hawkes Gen images']);
}
const have = gcloud(args, ['artifacts', 'docker', 'images', 'describe', tag, `--project=${args.project}`, '--format=value(image_summary.digest)'], { read: true });
if (have) {
  console.log(`\nThat tag is already built (${have}); nothing to do.`);
  saveState(stateName(variant, 'image'), { tag, project: args.project, region: args.region, built: 'existing' });
  process.exit(0);
}

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
for (const [name, data] of Object.entries(ctx.files)) fs.writeFileSync(path.join(dir, name), data);
console.log(`\nBuild context written to ${dir} (${Object.keys(ctx.files).join(', ')})`);

gcloud(args, [
  'builds', 'submit', dir, `--project=${args.project}`, `--region=${args.region}`, `--tag=${tag}`,
  ...(machine === 'default' ? [] : [`--machine-type=${machine}`]), '--timeout=1800s',
]);
if (!args.apply) {
  console.log('\nDry run: nothing built. Add --apply to build (Cloud Build minutes, J\'s OK).');
  process.exit(0);
}
saveState(stateName(variant, 'image'), { tag, project: args.project, region: args.region, built: new Date().toISOString() });
console.log(`\nBuilt ${tag}. Next: node tools/playtest-cloudrun/deploy.mjs${variant === 'cpu' ? ' --variant cpu' : ''} --project ${args.project} --region ${args.region}`);
