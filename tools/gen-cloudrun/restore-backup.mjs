#!/usr/bin/env node
// Restore one of Gen's scheduled backups (docs/gen-cloudrun.md, "Backups") into a SCRATCH database file and check it.
// It never touches a running Gen or its data: it downloads the backup, unpacks it to --to, and compares row counts and
// the sum of credits with the backup's manifest. Putting a restored file into service is a separate, deliberate step
// (the docs list it).
//
//   node tools/gen-cloudrun/restore-backup.mjs --bucket <backup bucket> [--lane beta] [--db hawkesgen|analytics]
//        [--at latest|<name like hawkesgen-20261108T031500Z>] --to ./scratch/restored.db
//   node tools/gen-cloudrun/restore-backup.mjs --list --bucket <backup bucket> --lane beta
//   node tools/gen-cloudrun/restore-backup.mjs --file backup.db.gz --manifest backup.json --to ./scratch/restored.db   (local files)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { flag, die } from '../unity-cloudrun/common.mjs';
import { restoreFile } from '../../src/backup.ts';

const bucket = flag('bucket', process.env.HAWKESGEN_BACKUP_BUCKET);
const lane = flag('lane', 'live');
const dbName = flag('db', 'hawkesgen');
const at = flag('at', 'latest');
const to = flag('to');
const list = process.argv.includes('--list');

async function main() {
  let gz = flag('file');
  let manifest = flag('manifest');
  if (!gz) {
    if (!bucket) die('Name the backup bucket: --bucket <name> (or HAWKESGEN_BACKUP_BUCKET), or give --file and --manifest.');
    const { gcs } = await import('../../src/providers/gcp/gcs.ts');
    const g = gcs();
    const names = [];
    for await (const o of g.list(bucket, `${lane}/${dbName}-`)) if (o.name.endsWith('.json')) names.push(o.name.slice(lane.length + 1, -5));
    names.sort();
    if (list) { console.log(names.join('\n') || '(no backups)'); return; }
    const name = at === 'latest' ? names.at(-1) : at;
    if (!name || (at !== 'latest' && !names.includes(name))) die(`No backup ${at} for ${lane}/${dbName} in ${bucket}. Try --list.`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkes-restore-'));
    gz = path.join(dir, `${name}.db.gz`);
    manifest = path.join(dir, `${name}.json`);
    await g.download(`gs://${bucket}/${lane}/${name}.db.gz`, gz);
    await g.download(`gs://${bucket}/${lane}/${name}.json`, manifest);
    console.log(`Downloaded ${name}`);
  }
  if (!to) die('Where to? --to <path of the scratch database file>');
  if (!manifest) die('Give --manifest with --file.');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const bad = await restoreFile(gz, path.resolve(to), m);
  const tables = Object.keys(m.rows).length;
  const total = Object.values(m.rows).reduce((a, b) => a + b, 0);
  console.log(`Backup ${m.name} (made ${m.made}): ${tables} tables, ${total} rows${m.credits === null ? '' : `, ${m.credits} credits held`}.`);
  if (bad.length) { console.error(`DOES NOT MATCH:\n  ${bad.join('\n  ')}`); process.exit(2); }
  console.log(`Restored to ${path.resolve(to)}: integrity ok, every table's row count and the credits match the backup.`);
}
main().catch((e) => die(e.message));
