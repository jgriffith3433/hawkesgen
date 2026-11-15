// `npm run typecheck`: tsc over the project, fetching the locked TypeScript first when this checkout has none.
// Studio's checks run in a clone whose node_modules may lack the dev tools (2026-11-08: "sh: 1: tsc: not found" failed a
// change whose types were fine), and they run `npm test` at the same time. So an existing node_modules is never touched
// (an `npm ci` here deleted it under the running tests: six test files failed with ERR_MODULE_NOT_FOUND): TypeScript and
// @types/node, at the versions in package-lock.json, go into a folder of their own and tsc reads the node types from
// there. Only a checkout with no node_modules at all gets `npm ci`. It never skips the check: no tsc is a failure.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmOpts = { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' };
const has = (dir) => fs.existsSync(path.join(dir, 'typescript', 'bin', 'tsc')) && fs.existsSync(path.join(dir, '@types', 'node', 'package.json'));

let modules = nm;
if (!fs.existsSync(nm)) {
  console.log('typecheck: no node_modules; installing the locked packages (npm ci) first');
  spawnSync(npm, ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], npmOpts);
} else if (!has(nm)) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const ts = lock.packages?.['node_modules/typescript']?.version;
  const types = lock.packages?.['node_modules/@types/node']?.version;
  if (!ts || !types) { console.error('typecheck: package-lock.json has no typescript or @types/node'); process.exit(1); }
  const side = path.join(os.tmpdir(), `hawkesgen-typecheck-${ts}-${types}`);
  modules = path.join(side, 'node_modules');
  if (!has(modules)) {
    console.log(`typecheck: no TypeScript in node_modules; fetching typescript@${ts} and @types/node@${types} into ${side} (node_modules is left alone)`);
    fs.mkdirSync(side, { recursive: true });
    spawnSync(npm, ['install', '--prefix', side, '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', `typescript@${ts}`, `@types/node@${types}`], { ...npmOpts, cwd: side });
  }
}

if (!has(modules)) {
  console.error('typecheck: could not install TypeScript; run `npm ci` and try again');
  process.exit(1);
}
const args = [path.join(modules, 'typescript', 'bin', 'tsc'), '-p', root];
if (modules !== nm) args.push('--typeRoots', path.join(modules, '@types'));
const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
