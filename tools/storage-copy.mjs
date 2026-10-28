#!/usr/bin/env node
// Copies the library's files from the S3 bucket to a Google Cloud Storage bucket, by content key (sha256/<hash>, the
// same key on both sides: src/storage.ts), keeping each object's Content-Type and Cache-Control. docs/cloudrun.md,
// "Moving the library".
//
//   node tools/storage-copy.mjs --to <gcs bucket> [--from <s3 bucket>] [--prefix sha256/] [--parallel 8] [--limit N] [--apply]
//
// --from defaults to the library's bucket (HAWKESGEN_LIBRARY_BUCKET or settings.storage.bucket). Dry run by default:
// lists both buckets and prints what would be copied, how much, and roughly what AWS charges to send it out. --apply
// copies what GCS doesn't have yet (or has at another size). Resumable: content keys never change, so a run that stops
// is simply run again (it copies only what's missing; a big file's upload session is kept in
// .data/cloudrun/storage-copy.json and continues from the bytes GCS already has). Nothing is deleted from either side.
// Credentials: AWS from hawkesgen/.env (or the instance role), Google from Application Default Credentials.
//
// After the copy, switching the library over is a setting: storage.provider "gcs" and storage.bucket <gcs bucket>.

import { Readable } from 'node:stream';
import { parseArgs, saveState, readState, gb } from './cloudrun/lib.mjs';

const args = parseArgs();
const { Gcs } = await import('../src/providers/gcp/gcs.ts');
const { loadSettings, env } = await import('../src/config.ts');
const { awsConfig } = await import('../src/providers/comfy/fleet.ts');
const S = await import('@aws-sdk/client-s3');

const from = args.from ?? (env('HAWKESGEN_LIBRARY_BUCKET') && env('HAWKESGEN_LIBRARY_BUCKET') !== 'off' ? env('HAWKESGEN_LIBRARY_BUCKET') : loadSettings().storage.bucket);
const to = args.to;
const prefix = args.prefix ?? 'sha256/';
const parallel = Math.max(1, Math.min(32, Number(args.parallel) || 8));
const limit = args.limit ? Number(args.limit) : Infinity;
const EGRESS_PER_GB = 0.09; // AWS data transfer out to the internet, first 10 TB/month (verify on aws.amazon.com/s3/pricing)
if (!from || !to) {
  console.log('Usage: node tools/storage-copy.mjs --to <gcs bucket> [--from <s3 bucket>] [--apply]');
  process.exit(2);
}

const s3 = new S.S3Client({ ...awsConfig(), region: env('HAWKESGEN_LIBRARY_REGION') ?? 'us-east-1' });
const gcs = new Gcs();

console.log(`S3 s3://${from}/${prefix} -> GCS gs://${to}/${prefix}`);
const have = new Map();
for await (const o of gcs.list(to, prefix)) have.set(o.name, o.size);
console.log(`  GCS has ${have.size} objects under ${prefix}`);

const todo = [];
let listed = 0;
let bytes = 0;
let token;
do {
  const r = await s3.send(new S.ListObjectsV2Command({ Bucket: from, Prefix: prefix, ContinuationToken: token }));
  for (const o of r.Contents ?? []) {
    listed++;
    if (have.get(o.Key) === o.Size) continue;
    if (todo.length < limit) {
      todo.push({ key: o.Key, size: o.Size });
      bytes += o.Size;
    }
  }
  token = r.IsTruncated ? r.NextContinuationToken : undefined;
} while (token);
console.log(`  S3 has ${listed} objects; ${todo.length} to copy (${gb(bytes)}), about $${(bytes / 1e9 * EGRESS_PER_GB).toFixed(2)} of AWS egress`);

if (!args.apply) {
  for (const t of todo.slice(0, 10)) console.log(`    ${t.key} (${gb(t.size)})`);
  if (todo.length > 10) console.log(`    ... and ${todo.length - 10} more`);
  console.log('\nDry run: nothing copied. Add --apply to copy.');
  process.exit(0);
}

const sessions = readState('storage-copy.json', {});
let done = 0;
let failed = 0;
let sent = 0;
const t0 = Date.now();

async function copy({ key, size }) {
  const uri = `gs://${to}/${key}`;
  const obj = await s3.send(new S.GetObjectCommand({ Bucket: from, Key: key }));
  const type = obj.ContentType ?? 'application/octet-stream';
  const cache = obj.CacheControl ?? undefined;
  if (size <= 32 * 1024 * 1024) {
    const data = Buffer.from(await obj.Body.transformToByteArray());
    await gcs.write(uri, data, type, cache);
    return;
  }
  // Big file: a resumable session we keep, so a crash continues where the bucket left off.
  await obj.Body.destroy?.();
  let s = sessions[uri];
  let offset = 0;
  if (s && s.size === size) {
    offset = await gcs.resumableOffset(s.session, size).catch(() => 0);
    if (offset === -1) return;
  } else {
    s = { session: await gcs.startResumable(uri, size, type, cache), size };
    sessions[uri] = s;
    saveState('storage-copy.json', sessions);
  }
  const part = await s3.send(new S.GetObjectCommand({ Bucket: from, Key: key, Range: offset ? `bytes=${offset}-` : undefined }));
  await gcs.writeStream(uri, Readable.from(part.Body), size, type, cache, { session: s.session, from: offset, streamOffset: offset });
  delete sessions[uri];
  saveState('storage-copy.json', sessions);
}

const queue = [...todo];
await Promise.all(Array.from({ length: parallel }, async () => {
  for (let t = queue.shift(); t; t = queue.shift()) {
    try {
      await copy(t);
      done++;
      sent += t.size;
    } catch (e) {
      failed++;
      console.log(`  FAILED ${t.key}: ${e.message}`);
    }
    if ((done + failed) % 200 === 0) console.log(`  ${done + failed} of ${todo.length} (${gb(sent)}, ${(sent / 1e6 / Math.max(1, (Date.now() - t0) / 1000)).toFixed(0)} MB/s)`);
  }
}));
console.log(`\nCopied ${done} (${gb(sent)}); ${failed} failed${failed ? ' (run again to retry them)' : ''}.`);
process.exit(failed ? 1 : 0);
