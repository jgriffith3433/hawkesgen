// `npm run typecheck`: tsc over the project, installing the locked dev tools first when this checkout has none.
// Studio's checks run in a fresh clone without node_modules (2026-11-08: "sh: 1: tsc: not found" failed a change whose
// types were fine). The install is `npm ci` from package-lock.json, so the check uses the same TypeScript and @types/node
// as everyone else; it never skips the check: no tsc after the install is a failure.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const typesNode = path.join(root, 'node_modules', '@types', 'node', 'package.json');

if (!fs.existsSync(tsc) || !fs.existsSync(typesNode)) {
  console.log('typecheck: no TypeScript in node_modules; installing the locked packages (npm ci) first');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0 || !fs.existsSync(tsc)) {
    console.error('typecheck: could not install TypeScript (npm ci failed); run `npm ci` and try again');
    process.exit(r.status || 1);
  }
}

const r = spawnSync(process.execPath, [tsc, '-p', root], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
