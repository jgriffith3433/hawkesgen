// Big uploads straight to the bucket (docs/api.md, "Blobs"). POST /v1/blobs streams the body through Gen, and Cloud Run
// refuses a request over 32 MiB, so the TK Shock render farm's 1 GB packs died with "fetch failed". Here the bytes go
// from the caller to Cloud Storage and never through Gen:
//
//   POST /v1/blobs/upload       { sha256, bytes, filename }: the caller hashed the file first.
//                               -> { blob, exists: true } when Gen has it and the caller may use it already, else
//                                  { upload, method: "PUT", url, bytes } (a V4 signed PUT, 2 hours) for files up to
//                                  RESUMABLE_AT, or { upload, method: "resumable", url, bytes } (a resumable session the
//                                  caller sends in chunks with Content-Range; no credential needed with the URL).
//   POST /v1/blobs/upload/done  { sha256 } (or { upload }): Gen checks the object's size, reads it once to check its
//                               sha256, moves it to sha256/<hash> and records the blob as the caller's (ownBlob).
//                               -> { blob, bytes }, or 202 { state: "verifying" } while a big file is still being read
//                                  (ask again: the read goes on in the background).
//
// The bytes land in a staging key of their own (uploads/<id>), never on sha256/<hash> directly: what a caller sends is
// only trusted once Gen has hashed it. Knowing a hash is not access (AGENTS.md, "Customers"): `exists` is said only to a
// caller that may already use the blob; anyone else uploads the bytes like a new file, which proves they have them.
// Then blob:<hash> works as a job input everywhere: blobPath names its local file, and storage.ts ensureInputs /
// ensureBlob fetch it from the bucket on any instance before a job reads it (a GPU worker gets it as any input).
//
// Needs the library bucket on Google Cloud Storage (settings.storage.provider "gcs"); signed PUTs need Gen's signer
// (sign.ts), and without one every upload uses a resumable session, which Gen opens with its own credentials.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { GenError, id } from './util.ts';
import { gcs, gsUri, type Gcs } from './providers/gcp/gcs.ts';
import { signedUrl, signer as genSigner, type Signer } from './providers/gpu/sign.ts';
import * as storage from './storage.ts';
import { blobPath, blobRemote, canUseBlob, ownBlob, putBlobRemote } from './library.ts';
import type { Client } from './auth.ts';

/** Above this a resumable session instead of one signed PUT (a dropped connection resumes, not restarts). */
export const RESUMABLE_AT = 256 * 1024 * 1024;
/** How long a signed PUT (and a pending upload) stays good. */
const PUT_SECONDS = 2 * 3600;
const PENDING_MS = 24 * 3600_000;
/** How long /done waits for the hash before answering "verifying" (the edge gives up on a request at 100 s). */
const WAIT_MS = 50_000;

export type BigDeps = {
  bucket: () => string | null;
  store: Pick<Gcs, 'stat' | 'media' | 'del' | 'copy' | 'startResumable'>;
  signer: () => Promise<Signer | null>;
};
const realDeps = (): BigDeps => ({
  bucket: () => (storage.provider() === 'gcs' ? storage.bucket() : null),
  store: gcs(),
  signer: genSigner,
});
let override: BigDeps | null = null;
/** Tests swap in a fake bucket and signer. */
export function setBigUploadDeps(d: BigDeps | null) {
  override = d;
}
const deps = () => override ?? realDeps();

db.exec(`CREATE TABLE IF NOT EXISTS blob_uploads (id TEXT PRIMARY KEY, sha TEXT NOT NULL, bytes INTEGER NOT NULL, ext TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL, projects TEXT NOT NULL, created INTEGER NOT NULL)`);
type Pending = { id: string; sha: string; bytes: number; ext: string; client: string; projects: string; created: number };

const SHA = /^[0-9a-f]{64}$/;
const extOfName = (name: string) => path.extname(String(name ?? '')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
const stagingKey = (uploadId: string) => `uploads/${uploadId}`;

function needBucket(d: BigDeps): string {
  const b = d.bucket();
  if (!b) throw new GenError('This Gen has no Cloud Storage bucket for big uploads: send the file to POST /v1/blobs', { status: 409, kind: 'no_bucket' });
  return b;
}

/** Does Gen hold these bytes: on this disk, or in the bucket (an earlier big upload or a library file)? */
async function held(d: BigDeps, b: string, sha: string): Promise<boolean> {
  const p = blobPath(sha);
  if (p && fs.existsSync(p)) return true;
  if (blobRemote(sha)) return true;
  return Boolean(await d.store.stat(gsUri(b, storage.keyOf(sha))));
}

/** POST /v1/blobs/upload. `maxBytes` is the caller's cap. */
export async function startUpload(client: Client, body: any, maxBytes: number) {
  const sha = String(body?.sha256 ?? '').toLowerCase();
  const bytes = Number(body?.bytes);
  if (!SHA.test(sha)) throw new GenError('sha256 must be the file\'s SHA-256 in hex');
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new GenError('bytes must be the file\'s size');
  if (bytes > maxBytes) throw new GenError(`Files up to ${Math.floor(maxBytes / 2 ** 20)} MB`, { status: 413 });
  const ext = extOfName(body?.filename);
  const d = deps();
  const b = needBucket(d);
  // Said only to a caller that may use the blob already; anyone else sends the bytes (proof they have them).
  if (canUseBlob(client, sha) && (await held(d, b, sha))) {
    const p = blobPath(sha);
    if (!(p && fs.existsSync(p)) && !blobRemote(sha)) putBlobRemote(sha, ext, bytes);
    ownBlob(sha, client);
    return { blob: `blob:${sha}`, exists: true, bytes };
  }
  const uploadId = id('bu', 12);
  db.prepare('INSERT INTO blob_uploads (id, sha, bytes, ext, client, projects, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uploadId, sha, bytes, ext, client.id, JSON.stringify(client.projects), Date.now());
  db.prepare('DELETE FROM blob_uploads WHERE created < ?').run(Date.now() - PENDING_MS * 7);
  const uri = gsUri(b, stagingKey(uploadId));
  const s = bytes <= RESUMABLE_AT ? await d.signer() : null;
  if (s) {
    const url = await signedUrl('PUT', uri, s, PUT_SECONDS);
    return { upload: uploadId, method: 'PUT', url, bytes, expires: Date.now() + PUT_SECONDS * 1000 };
  }
  const url = await d.store.startResumable(uri, bytes, 'application/octet-stream');
  return { upload: uploadId, method: 'resumable', url, bytes, expires: Date.now() + 7 * 24 * 3600_000 };
}

/** Background reads, so a second /done joins the first instead of reading again. */
const verifying = new Map<string, Promise<{ blob: string; bytes: number }>>();
const failed = new Map<string, unknown>();

async function hashObject(store: BigDeps['store'], uri: string): Promise<string> {
  const r = await store.media(uri);
  if (!r?.body) throw new GenError('The upload is gone from the bucket: upload it again', { status: 409 });
  const h = crypto.createHash('sha256');
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) h.update(chunk);
  return h.digest('hex');
}

async function finish(d: BigDeps, b: string, u: Pending): Promise<{ blob: string; bytes: number }> {
  const staging = gsUri(b, stagingKey(u.id));
  const o = await d.store.stat(staging);
  if (!o) throw new GenError('Nothing was uploaded yet: send the file to the upload URL first', { status: 409, kind: 'not_uploaded' });
  if (o.size !== u.bytes) {
    await d.store.del(staging).catch(() => undefined);
    db.prepare('DELETE FROM blob_uploads WHERE id = ?').run(u.id);
    throw new GenError(`The upload has ${o.size} bytes, not ${u.bytes}: start again`, { status: 400 });
  }
  const got = await hashObject(d.store, staging);
  if (got !== u.sha) {
    await d.store.del(staging).catch(() => undefined);
    db.prepare('DELETE FROM blob_uploads WHERE id = ?').run(u.id);
    throw new GenError('The uploaded bytes don\'t match that sha256: start again', { status: 400 });
  }
  const final = gsUri(b, storage.keyOf(u.sha));
  if (!(await d.store.stat(final))) await d.store.copy(staging, final, { contentType: 'application/octet-stream', cacheControl: storage.CACHE_CONTROL });
  await d.store.del(staging).catch(() => undefined);
  putBlobRemote(u.sha, u.ext, u.bytes);
  ownBlob(u.sha, { id: u.client, projects: JSON.parse(u.projects) });
  db.prepare('DELETE FROM blob_uploads WHERE id = ?').run(u.id);
  return { blob: `blob:${u.sha}`, bytes: u.bytes };
}

/** POST /v1/blobs/upload/done. -> [status, body]. */
export async function finishUpload(client: Client, body: any, waitMs = WAIT_MS): Promise<[number, unknown]> {
  const d = deps();
  const b = needBucket(d);
  const uploadId = typeof body?.upload === 'string' ? body.upload : null;
  const sha = String(body?.sha256 ?? '').toLowerCase();
  if (!uploadId && !SHA.test(sha)) throw new GenError('Send sha256 (or the upload id)');
  // Only the caller's own pending upload: another key can't finish (or learn about) it.
  const u = (uploadId
    ? db.prepare('SELECT * FROM blob_uploads WHERE id = ? AND client = ? AND created > ?').get(uploadId, client.id, Date.now() - PENDING_MS)
    : db.prepare('SELECT * FROM blob_uploads WHERE sha = ? AND client = ? AND created > ? ORDER BY created DESC LIMIT 1').get(sha, client.id, Date.now() - PENDING_MS)) as Pending | undefined;
  if (!u || (uploadId && sha && u.sha !== sha)) {
    const why = failed.get(`${client.id}:${sha}`);
    if (why) { failed.delete(`${client.id}:${sha}`); throw why; }
    // Finished already (a retried /done after the answer was lost): the blob is theirs.
    if (SHA.test(sha) && blobRemote(sha) && canUseBlob(client, sha)) return [200, { blob: `blob:${sha}`, bytes: blobRemote(sha)!.bytes }];
    throw new GenError('No upload of that file is waiting: start with POST /v1/blobs/upload', { status: 404 });
  }
  let p = verifying.get(u.id);
  if (!p) {
    p = finish(d, b, u);
    verifying.set(u.id, p);
    p.then(() => verifying.delete(u.id), (e) => {
      verifying.delete(u.id);
      // A check that failed after its caller stopped waiting: the next /done says why.
      failed.set(`${client.id}:${u.sha}`, e);
      setTimeout(() => failed.delete(`${client.id}:${u.sha}`), 3600_000).unref?.();
    });
  }
  const timeout = new Promise<null>((r) => { const t = setTimeout(() => r(null), waitMs); t.unref?.(); });
  let done: { blob: string; bytes: number } | null;
  try {
    done = await Promise.race([p, timeout]);
  } catch (e) {
    failed.delete(`${client.id}:${u.sha}`); // this caller hears it now
    throw e;
  }
  if (!done) return [202, { state: 'verifying', upload: u.id, note: 'Gen is checking the file: ask again in a moment' }];
  return [200, done];
}
