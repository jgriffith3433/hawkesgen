#!/usr/bin/env node
// Brings Gen's copy of the analytics SDK up to a release of its own repo, jgriffith3433/hawkes-analytics (public, MIT;
// docs/analytics.md). Gen serves clients/js/hawkes-analytics.js at /sdk/analytics@1.js, so a new SDK version reaches
// players when this copy changes and Gen deploys. The SDK is edited in hawkes-analytics, not here.
//
//   node tools/sync-analytics-sdk.mjs v1.3.0        copy that tag's files into clients/
//   node tools/sync-analytics-sdk.mjs beta          the newest on its beta branch (for Gen's beta)
//   node tools/sync-analytics-sdk.mjs v1.3.0 --check   exit 1 when the copy differs (changes nothing)
//
// No token: the repo is public. Then run `npm test` (test/analytics-sdk.test.ts runs the copy).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'jgriffith3433/hawkes-analytics';
const FILES = [
  ['hawkes-analytics.js', 'clients/js/hawkes-analytics.js'],
  ['hawkes-analytics.d.ts', 'clients/js/hawkes-analytics.d.ts'],
  ['hawkes-analytics.mjs', 'clients/js/hawkes-analytics.mjs'],
  ['hawkes-analytics.d.mts', 'clients/js/hawkes-analytics.d.mts'],
  ['Packages/com.hawkes.analytics/Runtime/HawkesAnalytics.cs', 'clients/unity/com.hawkes.analytics/Runtime/HawkesAnalytics.cs'],
  ['Packages/com.hawkes.analytics/Runtime/HawkesAnalyticsSettings.cs', 'clients/unity/com.hawkes.analytics/Runtime/HawkesAnalyticsSettings.cs'],
  ['Packages/com.hawkes.analytics/Runtime/Plugins/WebGL/HawkesAnalytics.jslib', 'clients/unity/com.hawkes.analytics/Runtime/Plugins/WebGL/HawkesAnalytics.jslib'],
];

const args = process.argv.slice(2);
const ref = args.find((a) => !a.startsWith('--'));
const check = args.includes('--check');
if (!ref || !/^(v\d+\.\d+\.\d+|beta|main|dev)$/.test(ref)) {
  console.error('usage: node tools/sync-analytics-sdk.mjs <v1.2.3 | beta | main> [--check]');
  process.exit(2);
}

let changed = 0;
for (const [from, to] of FILES) {
  const url = `https://raw.githubusercontent.com/${REPO}/${ref}/${from}`;
  const r = await fetch(url);
  if (!r.ok) {
    console.error(`${url}: ${r.status}`);
    process.exit(1);
  }
  const body = await r.text();
  const dest = path.join(ROOT, to);
  const now = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  if (now === body) continue;
  changed++;
  console.log(`${check ? 'differs' : 'updated'}: ${to}`);
  if (!check) fs.writeFileSync(dest, body);
}
console.log(changed ? `${changed} file(s) ${check ? 'differ from' : 'now match'} ${REPO}@${ref}` : `clients/ matches ${REPO}@${ref}`);
process.exit(check && changed ? 1 : 0);
