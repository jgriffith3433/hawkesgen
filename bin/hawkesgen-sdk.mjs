#!/usr/bin/env node
// Keeps every product's copy of Hawkes Gen's JS SDK current (clients/js/sdk.json lists where each keeps it).
//
//   node bin/hawkesgen-sdk.mjs status            every copy, its version, and whether it matches clients/js
//   node bin/hawkesgen-sdk.mjs sync [--only repo] write the current files where they differ (then commit in each repo)
//
// Copies, not a package: each product's own CI and site build must work without this private repo.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'clients', 'js');
const PROJECTS = path.resolve(ROOT, '..');
const sdk = JSON.parse(fs.readFileSync(path.join(JS, 'sdk.json'), 'utf8'));
const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const norm = (b) => b.toString('utf8').replace(/\r\n/g, '\n');
const hash = (f) => crypto.createHash('sha256').update(norm(fs.readFileSync(f))).digest('hex');
const versionOf = (f) => /(?:CLIENT_VERSION|UI_VERSION|ANALYTICS_VERSION) = (\d+)/.exec(fs.readFileSync(f, 'utf8'))?.[1] ?? '?';

let behind = 0;
let written = 0;
for (const [repo, dirs] of Object.entries(sdk.consumers)) {
  if (only && repo !== only) continue;
  const base = path.join(PROJECTS, repo);
  if (!fs.existsSync(base)) {
    console.log(`${repo}: not here`);
    continue;
  }
  for (const [dir, files] of Object.entries(dirs)) {
    for (const f of files) {
      const src = path.join(JS, f);
      const dest = path.join(base, dir, f);
      const same = fs.existsSync(dest) && hash(dest) === hash(src);
      if (cmd === 'sync' && !same) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, norm(fs.readFileSync(src)));
        written++;
      }
      if (!same) behind++;
      console.log(`${same ? 'current' : cmd === 'sync' ? 'written' : 'BEHIND '}  ${repo}/${dir}${f}  v${fs.existsSync(dest) && !(cmd === 'sync' && !same) ? versionOf(dest) : versionOf(src)}`);
    }
  }
}
console.log(cmd === 'sync' ? `${written} file(s) written; commit them in each repo` : `${behind} copy(ies) behind`);
if (cmd === 'status' && behind && args.includes('--check')) process.exit(1);
