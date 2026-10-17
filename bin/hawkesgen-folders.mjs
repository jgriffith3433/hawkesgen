#!/usr/bin/env node
// Folders <-> the Hawkes Gen library, for any product (clients/js/hawkesgen-folders.mjs has the mapping format).
//
//   node bin/hawkesgen-folders.mjs status <mapping.json> [--only Break]
//   node bin/hawkesgen-folders.mjs import <mapping.json> [--only Break] [--dry] [--adopt]   (--adopt: the folders' current files win)
//   node bin/hawkesgen-folders.mjs export <mapping.json> [--only Break] [--dry]
//
// Hawkes Gen is found the usual way (HAWKESGEN_URL / HAWKESGEN_KEY, ~/.hawkes/client.json, else this PC).

import { HawkesGen } from '../clients/js/hawkesgen.mjs';
import { loadMapping, importFolders, exportFolders } from '../clients/js/hawkesgen-folders.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const [cmd, file] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');
if (!['status', 'import', 'export'].includes(cmd) || !file) {
  console.error('usage: hawkesgen-folders.mjs status|import|export <mapping.json> [--only <folder>] [--dry]');
  process.exit(2);
}
const m = loadMapping(file);
const gen = new HawkesGen({ project: m.project });
const only = val('only');
const tally = (report) => {
  const n = {};
  for (const r of report) n[r.action] = (n[r.action] ?? 0) + 1;
  return Object.entries(n).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
};
try {
  if (cmd === 'import' || cmd === 'status') {
    const r = await importFolders(gen, m, { only, dry: cmd === 'status' || flag('dry'), adopt: flag('adopt'), log: (l) => console.log(l) });
    for (const x of r.filter((x) => x.action !== 'same').slice(0, cmd === 'status' ? 60 : 0)) console.log(`${x.action.padEnd(12)} ${x.entity}${x.slot ? ` ${x.slot}` : ''}${x.file ? `  ${x.file}` : ''}`);
    console.log(`${cmd === 'import' && !flag('dry') ? 'import' : 'to import'}: ${tally(r)}`);
  } else {
    const r = await exportFolders(gen, m, { only, dry: flag('dry'), log: (l) => console.log(l) });
    console.log(`export: ${tally(r)}`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
