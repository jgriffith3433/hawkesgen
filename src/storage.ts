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

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { awsConfig } from './providers/comfy/fleet.ts';
import { loadSettings } from './config.ts';

const REGION = 'us-east-1';
export const bucket = (): string | null => {
  const b = process.env.HAWKESGEN_LIBRARY_BUCKET ?? loadSettings().storage.bucket;
  return b && b !== 'off' ? String(b) : null;
};
export const keyOf = (sha: string) => `sha256/${sha}`;

/** What storage needs from S3 (the real client, or a fake in tests). */
export type Store = {
  has(key: string): Promise<boolean>;
  put(key: string, file: string, size: number): Promise<void>;
  get(key: string, dest: string): Promise<void>;
};

let store: Store | null = null;
/** Tests swap in a fake. */
export function setStore(s: Store | null) {
  store = s;
}

async function s3Store(b: string): Promise<Store> {
  const S = await import('@aws-sdk/client-s3');
  const c = new S.S3Client({ ...awsConfig(), region: REGION });
  let ready = false;
  const ensure = async () => {
    if (ready) return;
    try {
      await c.send(new S.HeadBucketCommand({ Bucket: b }));
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode !== 404 && e?.name !== 'NotFound') throw e;
      await c.send(new S.CreateBucketCommand({ Bucket: b, ObjectOwnership: 'BucketOwnerEnforced' }));
      await c.send(new S.PutPublicAccessBlockCommand({ Bucket: b, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
      console.log(`[storage] created the private bucket ${b}`);
    }
    ready = true;
  };
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
    async put(key, file, size) {
      await ensure();
      await c.send(new S.PutObjectCommand({ Bucket: b, Key: key, Body: fs.createReadStream(file), ContentLength: size }));
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

async function getStore(): Promise<Store | null> {
  if (store) return store;
  const b = bucket();
  if (!b) return null;
  store = await s3Store(b);
  return store;
}

// ------------------------------------------------------------------ backups

db.exec('CREATE TABLE IF NOT EXISTS backups (sha256 TEXT PRIMARY KEY, at INTEGER NOT NULL)');
const isBackedUp = (sha: string) => !!db.prepare('SELECT 1 FROM backups WHERE sha256 = ?').get(sha);
const markBackedUp = (sha: string) => db.prepare('INSERT OR IGNORE INTO backups (sha256, at) VALUES (?, ?)').run(sha, Date.now());

const queue: { sha: string; file: string; bytes: number }[] = [];
const queued = new Set<string>();
let running = 0;
let failures = 0;
let lastError: string | null = null;
const idleWaiters: (() => void)[] = [];

function pump() {
  while (running < 2 && queue.length) {
    const item = queue.shift()!;
    running++;
    void (async () => {
      try {
        const s = await getStore();
        if (!s) return;
        if (!fs.existsSync(item.file)) return;
        const key = keyOf(item.sha);
        if (!(await s.has(key))) await s.put(key, item.file, item.bytes);
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
export function backup(a: { sha256: string; path: string; bytes: number }) {
  if (!bucket() && !store) return;
  if (queued.has(a.sha256) || isBackedUp(a.sha256)) return;
  queued.add(a.sha256);
  queue.push({ sha: a.sha256, file: a.path, bytes: a.bytes });
  pump();
}

/** Resolves when nothing is queued or uploading (tests, and the backfill route's answer). */
export function idle(): Promise<void> {
  if (!running && !queue.length) return Promise.resolve();
  return new Promise((r) => idleWaiters.push(r));
}

/** Queues every asset not backed up yet. -> how many were queued. */
export function backfill({ limit = 100000 } = {}) {
  const rows = db.prepare('SELECT a.sha256, a.path, a.bytes FROM assets a LEFT JOIN backups b ON b.sha256 = a.sha256 WHERE b.sha256 IS NULL GROUP BY a.sha256 LIMIT ?').all(limit) as { sha256: string; path: string; bytes: number }[];
  for (const r of rows) backup(r);
  return rows.length;
}

export function status() {
  const assets = db.prepare('SELECT COUNT(DISTINCT sha256) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM assets').get() as { files: number; bytes: number };
  const done = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(x.bytes), 0) AS bytes FROM backups b JOIN (SELECT sha256, MAX(bytes) AS bytes FROM assets GROUP BY sha256) x ON x.sha256 = b.sha256').get() as { files: number; bytes: number };
  return { bucket: bucket(), files: assets.files, backedUp: done.files, bytes: assets.bytes, backedUpBytes: done.bytes, queued: queue.length + running, failures, lastError };
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
