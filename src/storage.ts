// The library's files in S3, so what Gen has made survives the server's disk. Every asset is uploaded once, by
// content (s3://<bucket>/sha256/<hash>), as it is made; the local file stays the working copy. A file missing on disk
// (a new server, a lost disk) comes back from S3 the first time it's asked for, and `restore` brings everything back.
//
// On when a bucket is set: settings.storage.bucket (dashboard Settings, or POST /v1/settings), or
// HAWKESGEN_LIBRARY_BUCKET ("off" turns it off). Off by default, so tests and a fresh checkout never touch S3. The
// cloud server uses hawkes-gen-library-028793236279.
//
// Uploads run in the background (two at a time) and are retried on the next start; `backfill` queues every asset made
// before this existed. The bucket is private and is created the first time (us-east-1, like the control server).
//
// Google Cloud Storage instead of S3: settings.storage.provider "gcs" (or HAWKESGEN_LIBRARY_STORE=gcs), the same
// bucket setting naming a GCS bucket, credentials from Application Default Credentials (src/providers/gcp/gcs.ts). Same
// keys (sha256/<hash>), same metadata. The GCS bucket is never created here: make it with the location and access
// rules J chose (docs/cloudrun.md). tools/storage-copy.mjs copies an S3 bucket's objects into it.

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { awsConfig } from './providers/comfy/fleet.ts';
import { loadSettings } from './config.ts';
import { mimeOf } from './util.ts';
import { gcs, gsUri, type Gcs } from './providers/gcp/gcs.ts';

const REGION = 'us-east-1';
export const bucket = (): string | null => {
  const b = process.env.HAWKESGEN_LIBRARY_BUCKET ?? loadSettings().storage.bucket;
  return b && b !== 'off' ? String(b) : null;
};
export const keyOf = (sha: string) => `sha256/${sha}`;
/** Which cloud holds the bucket: S3 (the default) or Google Cloud Storage. */
export const provider = (): 's3' | 'gcs' => {
  const p = process.env.HAWKESGEN_LIBRARY_STORE ?? loadSettings().storage.provider;
  return p === 'gcs' ? 'gcs' : 's3';
};

/** Keys are sha256/<hash>, so a key's bytes never change: browsers and a CDN may keep them forever. */
export const CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** The Content-Type an object is stored with: the asset's mime, but never one a browser would run as a page (HTML, SVG). */
export const safeMime = (mime: string | null | undefined) => {
  const m = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return !m || m === 'text/html' || m === 'image/svg+xml' || m === 'application/xhtml+xml' ? 'application/octet-stream' : m;
};

/** What storage needs from S3 (the real client, or a fake in tests). */
export type Store = {
  has(key: string): Promise<boolean>;
  put(key: string, file: string, size: number, contentType: string): Promise<void>;
  /** An object's metadata (null when it isn't there). */
  head?(key: string): Promise<{ contentType?: string; cacheControl?: string } | null>;
  /** Rewrites an object's metadata in place (CopyObject onto itself, MetadataDirective REPLACE). */
  setMeta?(key: string, contentType: string): Promise<void>;
  get(key: string, dest: string): Promise<void>;
  /** Deletes these objects (missing ones are fine). */
  del?(keys: string[]): Promise<void>;
};

let store: Store | null = null;
/** Tests swap in a fake. */
export function setStore(s: Store | null) {
  store = s;
}

async function s3Store(b: string): Promise<Store> {
  const S = await import('@aws-sdk/client-s3');
  const c = new S.S3Client({ ...awsConfig(), region: REGION });
  // Once, shared: two uploads starting together must not both try to create the bucket.
  let ready: Promise<void> | null = null;
  const ensure = () => (ready ??= (async () => {
    try {
      await c.send(new S.HeadBucketCommand({ Bucket: b }));
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode !== 404 && e?.name !== 'NotFound') throw e;
      await c.send(new S.CreateBucketCommand({ Bucket: b, ObjectOwnership: 'BucketOwnerEnforced' }));
      await c.send(new S.PutPublicAccessBlockCommand({ Bucket: b, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
      console.log(`[storage] created the private bucket ${b}`);
    }
  })().catch((e) => {
    ready = null;
    throw e;
  }));
  return {
    async has(key) {
      await ensure();
      try {
        await c.send(new S.HeadObjectCommand({ Bucket: b, Key: key }));
        return true;
      } catch (e: any) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return false;
        throw e;
      }
    },
    async put(key, file, size, contentType) {
      await ensure();
      await c.send(new S.PutObjectCommand({ Bucket: b, Key: key, Body: fs.createReadStream(file), ContentLength: size, ContentType: contentType, CacheControl: CACHE_CONTROL }));
    },
    async head(key) {
      await ensure();
      try {
        const r: any = await c.send(new S.HeadObjectCommand({ Bucket: b, Key: key }));
        return { contentType: r.ContentType, cacheControl: r.CacheControl };
      } catch (e: any) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null;
        throw e;
      }
    },
    async setMeta(key, contentType) {
      await ensure();
      await c.send(new S.CopyObjectCommand({ Bucket: b, Key: key, CopySource: `${b}/${key.split('/').map(encodeURIComponent).join('/')}`, ContentType: contentType, CacheControl: CACHE_CONTROL, MetadataDirective: 'REPLACE' }));
    },
    async del(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await c.send(new S.DeleteObjectsCommand({ Bucket: b, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
      }
    },
    async get(key, dest) {
      const r: any = await c.send(new S.GetObjectCommand({ Bucket: b, Key: key }));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part`;
      await new Promise<void>((resolve, reject) => r.Body.pipe(fs.createWriteStream(tmp)).on('finish', () => resolve()).on('error', reject));
      fs.renameSync(tmp, dest);
    },
  };
}

/** The library in a Google Cloud Storage bucket, behind the same Store interface. `client` is for tests. */
export function gcsStore(b: string, client: Gcs = gcs()): Store {
  const uri = (key: string) => gsUri(b, key);
  return {
    async has(key) {
      return (await client.stat(uri(key))) !== null;
    },
    async put(key, file, _size, contentType) {
      await client.writeFile(uri(key), file, contentType, CACHE_CONTROL);
    },
    async head(key) {
      const o = await client.stat(uri(key));
      return o ? { contentType: o.contentType, cacheControl: o.cacheControl } : null;
    },
    async setMeta(key, contentType) {
      await client.patch(uri(key), { contentType, cacheControl: CACHE_CONTROL });
    },
    async del(keys) {
      for (const k of keys) await client.del(uri(k));
    },
    async get(key, dest) {
      await client.download(uri(key), dest);
    },
  };
}

async function getStore(): Promise<Store | null> {
  if (store) return store;
  const b = bucket();
  if (!b) return null;
  store = provider() === 'gcs' ? gcsStore(b) : await s3Store(b);
  return store;
}

// ------------------------------------------------------------------ backups

db.exec('CREATE TABLE IF NOT EXISTS backups (sha256 TEXT PRIMARY KEY, at INTEGER NOT NULL)');
const isBackedUp = (sha: string) => !!db.prepare('SELECT 1 FROM backups WHERE sha256 = ?').get(sha);
const markBackedUp = (sha: string) => db.prepare('INSERT OR IGNORE INTO backups (sha256, at) VALUES (?, ?)').run(sha, Date.now());

const queue: { sha: string; file: string; bytes: number; mime: string }[] = [];
const queued = new Set<string>();
let running = 0;
const CONCURRENCY = 4; // uploads start the moment an asset or level is made; four at a time
let failures = 0;
let lastError: string | null = null;
const idleWaiters: (() => void)[] = [];

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const item = queue.shift()!;
    running++;
    void (async () => {
      try {
        const s = await getStore();
        if (!s) return;
        if (!fs.existsSync(item.file)) return;
        const key = keyOf(item.sha);
        if (!(await s.has(key))) await s.put(key, item.file, item.bytes, safeMime(item.mime));
        markBackedUp(item.sha);
      } catch (e: any) {
        failures++;
        lastError = e?.message ?? String(e);
        console.warn(`[storage] couldn't back up ${item.sha.slice(0, 12)}: ${lastError}`);
      } finally {
        queued.delete(item.sha);
        running--;
        if (!running && !queue.length) idleWaiters.splice(0).forEach((f) => f());
        pump();
      }
    })();
  }
}

/** Queues an asset's file for S3 (once per content). Called as each asset is made. */
export function backup(a: { sha256: string; path: string; bytes: number; mime?: string }) {
  if (!bucket() && !store) return;
  if (queued.has(a.sha256) || isBackedUp(a.sha256)) return;
  queued.add(a.sha256);
  queue.push({ sha: a.sha256, file: a.path, bytes: a.bytes, mime: a.mime ?? mimeOf(a.path) });
  pump();
}

/** Resolves when nothing is queued or uploading (tests, and the backfill route's answer). */
/**
 * Files that were cleared (levels of detail of in-between work): their copies in S3 go too, unless an asset or another
 * level still has the same content. Ones still waiting to upload are dropped from the queue. -> how many were deleted.
 */
export async function forget(shas: string[]): Promise<number> {
  const stillUsed = (sha: string) => Boolean(db.prepare('SELECT 1 FROM assets WHERE sha256 = ?').get(sha) || db.prepare('SELECT 1 FROM asset_lods WHERE sha256 = ?').get(sha));
  const drop = [...new Set(shas)].filter((sha) => !stillUsed(sha));
  if (!drop.length) return 0;
  for (let i = queue.length - 1; i >= 0; i--) if (drop.includes(queue[i].sha)) { queued.delete(queue[i].sha); queue.splice(i, 1); }
  const backed = drop.filter(isBackedUp);
  const st = await getStore();
  if (st && st.del && backed.length) await st.del(backed.map(keyOf));
  const off = db.prepare('DELETE FROM backups WHERE sha256 = ?');
  for (const sha of backed) off.run(sha);
  return backed.length;
}

export function idle(): Promise<void> {
  if (!running && !queue.length) return Promise.resolve();
  return new Promise((r) => idleWaiters.push(r));
}

/** Is this content in the bucket (so a CDN link to sha256/<hash> will work)? */
export const inS3 = (sha: string) => isBackedUp(sha);

/** The public CDN link for this content (`<storage.cdn>/sha256/<hash>`), only when storage.cdn is set and the file is in S3;
 *  otherwise undefined and callers keep the API's file route. Anyone holding the link can read the file. */
export function cdnUrl(sha: string): string | undefined {
  const base = loadSettings().storage.cdn;
  return base && isBackedUp(sha) ? `${base}/sha256/${sha}` : undefined;
}

/** Queues every asset not backed up yet. -> how many were queued. */
export function backfill({ limit = 100000 } = {}) {
  const rows = db.prepare('SELECT a.sha256, a.path, a.bytes, a.mime FROM assets a LEFT JOIN backups b ON b.sha256 = a.sha256 WHERE b.sha256 IS NULL GROUP BY a.sha256 LIMIT ?').all(limit) as { sha256: string; path: string; bytes: number; mime: string }[];
  for (const r of rows) backup(r);
  return rows.length;
}

export function status() {
  const assets = db.prepare('SELECT COUNT(DISTINCT sha256) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM assets').get() as { files: number; bytes: number };
  const done = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(x.bytes), 0) AS bytes FROM backups b JOIN (SELECT sha256, MAX(bytes) AS bytes FROM assets GROUP BY sha256) x ON x.sha256 = b.sha256').get() as { files: number; bytes: number };
  return { bucket: bucket(), files: assets.files, backedUp: done.files, bytes: assets.bytes, backedUpBytes: done.bytes, queued: queue.length + running, queueLength: queue.length, uploading: running, failures, lastError };
}

// ------------------------------------------------------------------ metadata

db.exec('CREATE TABLE IF NOT EXISTS backup_meta (sha256 TEXT PRIMARY KEY, at INTEGER NOT NULL)');

/**
 * Objects uploaded before ContentType and CacheControl were set get them now (CopyObject onto itself, REPLACE). One
 * batch per call, in sha order after `after`; objects already right are remembered, so a run that stops resumes where
 * it left off. Dry run (the default) only counts. -> counts and the cursor for the next batch (null at the end).
 */
export async function fixMetadata({ apply = false, limit = 200, after = '' } = {}) {
  const s = await getStore();
  if (!s || !s.head || !s.setMeta) throw new Error('No bucket (or a store that cannot read metadata)');
  // Every backed-up content with the mime of an asset or level that has it.
  const rows = db.prepare(`SELECT b.sha256, COALESCE((SELECT mime FROM assets WHERE sha256 = b.sha256 LIMIT 1), (SELECT mime FROM asset_lods WHERE sha256 = b.sha256 LIMIT 1)) AS mime
    FROM backups b WHERE b.sha256 > ? AND b.sha256 NOT IN (SELECT sha256 FROM backup_meta) ORDER BY b.sha256 LIMIT ?`).all(after, limit) as { sha256: string; mime: string | null }[];
  const r = { checked: 0, ok: 0, wrong: 0, fixed: 0, missing: 0, failed: 0, next: rows.length === limit ? rows[rows.length - 1].sha256 : (null as string | null) };
  const done = db.prepare('INSERT OR IGNORE INTO backup_meta (sha256, at) VALUES (?, ?)');
  const todo = [...rows];
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
    for (let row = todo.shift(); row; row = todo.shift()) {
      r.checked++;
      try {
        const key = keyOf(row.sha256);
        const want = safeMime(row.mime ?? 'application/octet-stream');
        const h = await s.head!(key);
        if (!h) { r.missing++; continue; }
        if (h.contentType === want && h.cacheControl === CACHE_CONTROL) { r.ok++; done.run(row.sha256, Date.now()); continue; }
        r.wrong++;
        if (apply) {
          await s.setMeta!(key, want);
          r.fixed++;
          done.run(row.sha256, Date.now());
        }
      } catch (e: any) {
        r.failed++;
        lastError = e?.message ?? String(e);
      }
    }
  }));
  return r;
}

// ------------------------------------------------------------------ restores

/** Makes sure an asset's file is on disk, fetching it from S3 when it's missing. -> false when it can't be had. */
export async function ensureLocal(a: { sha256: string; path: string }): Promise<boolean> {
  if (fs.existsSync(a.path)) return true;
  const s = await getStore();
  if (!s) return false;
  try {
    await s.get(keyOf(a.sha256), a.path);
    return true;
  } catch (e: any) {
    console.warn(`[storage] couldn't restore ${a.path}: ${e?.message ?? e}`);
    return false;
  }
}

/** A job's input files that are library files missing on disk come back from S3 before it runs. */
export async function ensureInputs(inputs: Record<string, string | string[]>) {
  for (const v of Object.values(inputs ?? {})) {
    for (const p of Array.isArray(v) ? v : [v]) {
      if (typeof p !== 'string' || fs.existsSync(p)) continue;
      const a = db.prepare('SELECT sha256, path FROM assets WHERE path = ?').get(p) as { sha256: string; path: string } | undefined;
      if (a) await ensureLocal(a);
    }
  }
}

/** Brings back every missing library file from S3 (a new disk). -> counts. */
export async function restoreAll({ onProgress = (_: string) => {} } = {}) {
  const rows = db.prepare('SELECT sha256, path FROM assets').all() as { sha256: string; path: string }[];
  let restored = 0;
  let missing = 0;
  for (const r of rows) {
    if (fs.existsSync(r.path)) continue;
    if (await ensureLocal(r)) {
      restored++;
      if (restored % 50 === 0) onProgress(`${restored} restored`);
    } else missing++;
  }
  return { checked: rows.length, restored, missing };
}

/** Uploads left over from the last run start again. */
export function resumeOnStart() {
  if (!bucket()) return;
  setTimeout(() => {
    try {
      const n = backfill({ limit: 5000 });
      if (n) console.log(`[storage] backing up ${n} library file(s) to S3`);
    } catch (e: any) {
      console.warn(`[storage] backfill: ${e.message}`);
    }
  }, 30_000).unref();
}
