// Writes the GPU worker's build folder (the same files and node pins tools/cloudrun/build.mjs sends to Cloud Build) for a
// build anywhere else: .github/workflows/gpu-image.yml builds it on GitHub and pushes it to GHCR, which RunPod and Modal
// can pull without a Google key (docs/gpu-providers.md, "The image").
//
//   node tools/gpu-providers/image-context.mjs <dir>      prints COMFY_REPO=, COMFY_TAG= and TAG= lines (for $GITHUB_OUTPUT)

import fs from 'node:fs';
import path from 'node:path';
import { contextFiles } from '../cloudrun/lib.mjs';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/gpu-providers/image-context.mjs <dir>'); process.exit(2); }
const { files, comfy, hash } = contextFiles();
fs.mkdirSync(dir, { recursive: true });
for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
// The tag names what's inside (ComfyUI's tag and the context hash), as the Cloud Build image's does.
console.log(`COMFY_REPO=${comfy.repo}\nCOMFY_TAG=${comfy.tag}\nTAG=${comfy.tag}-${hash}`);
