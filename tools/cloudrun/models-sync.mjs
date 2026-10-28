#!/usr/bin/env node
// Copies each Cloud Run service's models into gs://<bucket>/models/<dir>/<file> from where server/models.json and the
// workflow manifests download them (Hugging Face). docs/cloudrun.md, "Models".
//
//   node tools/cloudrun/models-sync.mjs [--project hawkes-staging] [--region us-east4] [--bucket <name>]
//        [--service gen-z-image,gen-qwen-edit] [--no-sizes] [--parallel 2] [--apply]
//
// Without --apply it prints each model, its size, whether the bucket has it and what storage costs a month, and the
// gcloud command that would create the bucket; it changes nothing. With --apply it creates the bucket if missing
// (uniform access, public access prevented, runs under cloudrun/ deleted after 7 days) and copies what's missing,
// streaming from Hugging Face straight into Cloud Storage (nothing lands on this disk). Copies are resumable: a run that
// stops continues each file from the bytes the bucket already has (.data/cloudrun/models-sync.json). HF_TOKEN in the
// environment or .env is sent for gated models. Credentials: Application Default Credentials (docs/cloudrun.md).

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parseArgs, loadServiceMap, pickServices, modelSources, serviceModels, bucketOf, gcloud, saveState, readState, gb, STATE_DIR } from './lib.mjs';

const args = parseArgs();
if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n'));
  process.exit(0);
}
const map = loadServiceMap();
const bucket = bucketOf(args, map);
const services = pickServices(args, map);
const sources = modelSources();
const STORAGE_PER_GB_MONTH = 0.02; // Standard storage, one US region (verify on cloud.google.com/storage/pricing)

const { Gcs } = await import('../../src/providers/gcp/gcs.ts');
const { env } = await import('../../src/config.ts');
const store = new Gcs();
const hfToken = env('HF_TOKEN');
const hfHeaders = hfToken ? { Authorization: `Bearer ${hfToken}` } : {};

const preload = new Set(services.flatMap((s) => s.models));
const wanted = [...new Set(services.flatMap((s) => serviceModels(s)))];
const noSource = wanted.filter((m) => !sources.has(m));

console.log(`Models bucket gs://${bucket} (project ${args.project}), ${services.length} service(s): ${services.map((s) => s.name).join(', ')}`);
if (noSource.length) console.log(`\n  No download source for ${noSource.length} model(s) (add a url in models.json or the workflow): ${noSource.join(', ')}`);

/** The file's size from Hugging Face (HEAD follows the redirect to the CDN). */
async function sizeOf(url) {
  const r = await fetch(url, { method: 'HEAD', headers: hfHeaders, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status}`);
  return Number(r.headers.get('x-linked-size') ?? r.headers.get('content-length') ?? 0) || null;
}

// One probe first: without credentials every stat would fail the same way.
let canRead = true;
try {
  await store.stat(`gs://${bucket}/models/.probe`);
} catch (e) {
  canRead = false;
  console.log(`\n  Couldn't read the bucket (${e.message.split('\n')[0]}); listing what a full copy would do.`);
}
const rows = [];
await Promise.all(wanted.filter((m) => sources.has(m)).map(async (m) => {
  const url = sources.get(m);
  const row = { model: m, url, size: null, have: null, note: '' };
  rows.push(row);
  if (!args.noSizes) row.size = await sizeOf(url).catch((e) => { row.note = `size: ${e.message}`; return null; });
  if (canRead) {
    try {
      const o = await store.stat(`gs://${bucket}/models/${m}`);
      row.have = o ? (row.size && o.size !== row.size ? 'wrong size' : 'yes') : 'no';
    } catch (e) {
      row.note = `bucket: ${e.message.split('\n')[0]}`;
    }
  }
}));
rows.sort((a, b) => a.model.localeCompare(b.model));

const todo = rows.filter((r) => r.have !== 'yes');
console.log('\n  (* = preloaded by its service at startup; the rest are read from the mount when a job uses them)');
for (const r of rows) console.log(`  ${r.have === 'yes' ? 'have   ' : r.have === 'wrong size' ? 'REDO   ' : 'copy   '} ${preload.has(r.model) ? '*' : ' '} ${r.model.padEnd(78)} ${r.size ? gb(r.size).padStart(8) : '       ?'}${r.note ? `  (${r.note})` : ''}`);
const total = rows.reduce((a, r) => a + (r.size ?? 0), 0);
const copy = todo.reduce((a, r) => a + (r.size ?? 0), 0);
console.log(`\n  ${rows.length} models, ${gb(total)} in all; ${todo.length} to copy (${gb(copy)}). Storage about $${(total / 1e9 * STORAGE_PER_GB_MONTH).toFixed(2)}/month.`);

const exists = gcloud(args, ['storage', 'buckets', 'describe', `gs://${bucket}`, `--project=${args.project}`, '--format=value(name)'], { read: true });
const lifecycle = path.join(STATE_DIR, 'lifecycle.json');
if (!exists) {
  console.log(`\nThe bucket ${exists === null && !args.apply ? 'may not exist (or gcloud is missing)' : 'does not exist'}; it would be made with:`);
  gcloud(args, ['storage', 'buckets', 'create', `gs://${bucket}`, `--project=${args.project}`, `--location=${args.region}`, '--uniform-bucket-level-access', '--public-access-prevention']);
  if (args.apply) {
    saveState('lifecycle.json', { rule: [{ action: { type: 'Delete' }, condition: { age: 7, matchesPrefix: ['cloudrun/'] } }] });
    gcloud(args, ['storage', 'buckets', 'update', `gs://${bucket}`, `--lifecycle-file=${lifecycle}`]);
  } else console.log(`  would set a lifecycle rule: delete cloudrun/ (run inputs and outputs) after 7 days`);
}

if (!args.apply) {
  console.log('\nDry run: nothing copied. Add --apply to copy (J\'s OK: it is storage cost, and Hugging Face egress is free).');
  process.exit(0);
}

// ------------------------------------------------------------------ copy
const sessions = readState('models-sync.json', {});
const parallel = Math.max(1, Math.min(8, Number(args.parallel) || 2));
let failed = 0;

async function copyOne(r) {
  const uri = `gs://${bucket}/models/${r.model}`;
  const size = r.size ?? (await sizeOf(r.url));
  if (!size) throw new Error('unknown size');
  let s = sessions[uri];
  let offset = 0;
  if (s && s.size === size && s.url === r.url) {
    offset = await store.resumableOffset(s.session, size).catch(() => 0);
    if (offset === -1) return console.log(`  done already: ${r.model}`);
  } else {
    s = { session: await store.startResumable(uri, size, 'application/octet-stream', undefined, { source: r.url }), size, url: r.url };
    sessions[uri] = s;
    saveState('models-sync.json', sessions);
  }
  const res = await fetch(r.url, { headers: { ...hfHeaders, ...(offset ? { Range: `bytes=${offset}-` } : {}) }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
  const t = Date.now();
  let last = 0;
  console.log(`  copying ${r.model} (${gb(size)}${offset ? `, from ${gb(offset)}` : ''})`);
  await store.writeStream(uri, Readable.fromWeb(res.body), size, 'application/octet-stream', undefined, {
    session: s.session, from: offset, streamOffset: res.status === 206 ? offset : 0, metadata: { source: r.url },
    onChunk: (sent) => {
      if (sent - last > 2e9 || sent === size) {
        last = sent;
        console.log(`    ${r.model}: ${gb(sent)} of ${gb(size)} (${((sent - offset) / 1e6 / Math.max(1, (Date.now() - t) / 1000)).toFixed(0)} MB/s)`);
      }
    },
  });
  const o = await store.stat(uri);
  if (!o || o.size !== size) throw new Error(`the bucket has ${o?.size ?? 0} bytes, expected ${size}`);
  delete sessions[uri];
  saveState('models-sync.json', sessions);
}

const queue = [...todo];
await Promise.all(Array.from({ length: parallel }, async () => {
  for (let r = queue.shift(); r; r = queue.shift()) {
    try {
      await copyOne(r);
    } catch (e) {
      failed++;
      console.log(`  FAILED ${r.model}: ${e.message} (run again to resume)`);
    }
  }
}));
console.log(failed ? `\n${failed} model(s) failed; run again to resume them.` : '\nEvery model is in the bucket.');
process.exit(failed ? 1 : 0);
