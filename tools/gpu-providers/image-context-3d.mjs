// Writes the 3D worker image's build folder (server/gpu3d/Dockerfile, worker.py, the entrypoint and the four install
// scripts generated from src/providers/*/install.ts with weights: false). .github/workflows/gpu3d-image.yml builds it
// on GitHub and pushes ghcr.io/jgriffith3433/hawkes-gen-gpu:3d-<hash> (docs/3d-animation.md, "The image").
//
//   node tools/gpu-providers/image-context-3d.mjs <dir>      prints TAG= (for $GITHUB_OUTPUT)
//   node tools/gpu-providers/image-context-3d.mjs --print    lists the files and the tag, writes nothing

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installScript as blender } from '../../src/providers/blender/install.ts';
import { installScript as rig } from '../../src/providers/rig/install.ts';
import { installScript as motion } from '../../src/providers/motion/install.ts';
import { installScript as mocap } from '../../src/providers/mocap/install.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The build folder's files (name -> contents). */
export function contextFiles3d() {
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p));
  const sh = (body) => Buffer.from(`#!/bin/bash\n${body}\n`);
  const files = {
    Dockerfile: read('server', 'gpu3d', 'Dockerfile'),
    'worker.py': read('server', 'cloudrun', 'worker.py'),
    'entrypoint.sh': read('server', 'cloudrun', 'entrypoint.sh'),
    // Root in the build: no sudo. Blender's script is shared with the fleet's bootstrap.
    'install-blender.sh': sh(blender('')),
    'install-rig.sh': sh(rig('', { weights: false })),
    'install-motion.sh': sh(motion('', { weights: false })),
    'install-mocap.sh': sh(mocap('', { weights: false })),
  };
  const h = crypto.createHash('sha256');
  // Line endings don't count: a Windows checkout must name the same tag GitHub's build pushes.
  for (const [k, v] of Object.entries(files)) h.update(k).update(v.toString('utf8').replace(/\r\n/g, '\n'));
  return { files, hash: h.digest('hex').slice(0, 10) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, hash } = contextFiles3d();
  if (process.argv.includes('--print')) {
    for (const [k, v] of Object.entries(files)) console.log(`${k}  ${v.length} bytes`);
    console.log(`TAG=3d-${hash}`);
    process.exit(0);
  }
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node tools/gpu-providers/image-context-3d.mjs <dir> | --print'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body.toString('utf8').replace(/\r\n/g, '\n'));
  console.log(`TAG=3d-${hash}`);
}
