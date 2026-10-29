// Writes the playtest browser image's build folder (server/playtest-cloudrun/ with Gen's Playwright version filled in:
// the same files tools/playtest-cloudrun/build.mjs sends to Cloud Build for the L4 service) for a build on GitHub:
// .github/workflows/playtest-image.yml builds it and pushes it to GHCR, which RunPod pulls (docs/playtest-runpod.md).
//
//   node tools/playtest-runpod/image-context.mjs <dir>      prints TAG=pw<version>-<context hash> (for $GITHUB_OUTPUT)

import fs from 'node:fs';
import path from 'node:path';
import { buildContext } from '../playtest-cloudrun/lib.mjs';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/playtest-runpod/image-context.mjs <dir>'); process.exit(2); }
const ctx = buildContext(undefined, 'gpu');
fs.mkdirSync(dir, { recursive: true });
for (const [name, body] of Object.entries(ctx.files)) fs.writeFileSync(path.join(dir, name), body);
console.log(`TAG=pw${ctx.version}-${ctx.hash}`);
