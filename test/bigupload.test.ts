// Big uploads straight to the bucket (src/bigupload.ts): POST /v1/blobs/upload and /v1/blobs/upload/done, with the
// bucket and the signer faked. A scratch data folder and a random port; no Google, no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-bigupload-'));
const { handle } = await import('../src/api.ts');
const { createClient } = await import('../src/auth.ts');
const big = await import('../src/bigupload.ts');
const storage = await import('../src/storage.ts');
const { blobPath } = await import('../src/library.ts');

const BUCKET = 'bkt';
const objects = new Map<string, Buffer>();
const calls: string[] = [];
let slowMedia = 0;
const fakeStore = {
  stat: async (uri: string) => (objects.has(uri) ? { name: uri, size: objects.get(uri)!.length } : null),
  media: async (uri: string) => {
    if (slowMedia) await new Promise((r) => setTimeout(r, slowMedia));
    return objects.has(uri) ? new Response(new Uint8Array(objects.get(uri)!)) : null;
  },
  del: async (uri: string) => { calls.push(`del ${uri}`); objects.delete(uri); },
  copy: async (a: string, b: string) => { calls.push(`copy ${a} ${b}`); objects.set(b, objects.get(a)!); },
  startResumable: async (uri: string, size: number) => { calls.push(`resumable ${uri} ${size}`); return `https://resumable.test/${encodeURIComponent(uri)}`; },
};
let bucketOn = true;
big.setBigUploadDeps({
  bucket: () => (bucketOn ? BUCKET : null),
  store: fakeStore as any,
  signer: async () => ({ email: 'gen@test.iam.gserviceaccount.com', sign: async () => Buffer.from('signature') }),
});
// The library store the restores read from: the same fake bucket.
storage.setStore({
  has: async (key) => objects.has(`gs://${BUCKET}/${key}`),
  put: async () => {},
  get: async (key, dest) => {
    const b = objects.get(`gs://${BUCKET}/${key}`);
    if (!b) throw new Error('no such object');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, b);
  },
});

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => { server.close(); big.setBigUploadDeps(null); storage.setStore(null); });

const owner = createClient('farm (test)', 'admin', ['*']).key;
const call = async (key: string, route: string, body: unknown) => {
  const r = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
/** What the caller's PUT does: the bytes land on the upload's staging key. */
const put = (upload: string, data: Buffer) => objects.set(`gs://${BUCKET}/uploads/${upload}`, data);

test('a file goes up by a signed PUT, is checked, and works as blob:<sha> on any instance', async () => {
  const data = Buffer.from('a render farm pack '.repeat(1000));
  const h = sha(data);
  const start = await call(owner, '/v1/blobs/upload', { sha256: h, bytes: data.length, filename: 'pack.tar' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.method, 'PUT');
  assert.match(start.body.url, /^https:\/\/storage\.googleapis\.com\/bkt\/uploads\/bu_\w+\?.*X-Goog-Signature=/);
  assert.match(start.body.url, /X-Goog-Expires=7200/);
  // Not uploaded yet: done says so.
  const early = await call(owner, '/v1/blobs/upload/done', { sha256: h });
  assert.equal(early.status, 409);
  put(start.body.upload, data);
  const done = await call(owner, '/v1/blobs/upload/done', { sha256: h });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.blob, `blob:${h}`);
  // Moved to the content key, staging gone.
  assert.ok(objects.has(`gs://${BUCKET}/sha256/${h}`));
  assert.ok(!objects.has(`gs://${BUCKET}/uploads/${start.body.upload}`));
  // Not on this disk: blobPath names where it goes, and ensureInputs / ensureBlob bring it back from the bucket.
  const p = blobPath(h)!;
  assert.ok(p.endsWith(`${h}.tar`));
  assert.ok(!fs.existsSync(p));
  await storage.ensureInputs({ pack: p });
  assert.deepEqual(fs.readFileSync(p), data);
  fs.rmSync(p);
  assert.equal(await storage.ensureBlob(h), p);
  assert.ok(fs.existsSync(p));
  // A job takes it as an input.
  const job = await call(owner, '/v1/jobs', { tool: 'media.probe', project: 'sandbox', inputs: { file: `blob:${h}` } });
  assert.notEqual(job.status, 404, JSON.stringify(job.body));
  // The same file again: Gen says it has it, nothing to send.
  const again = await call(owner, '/v1/blobs/upload', { sha256: h, bytes: data.length, filename: 'pack.tar' });
  assert.deepEqual([again.body.exists, again.body.blob], [true, `blob:${h}`]);
  // A retried done after the answer was lost still answers.
  const late = await call(owner, '/v1/blobs/upload/done', { sha256: h });
  assert.equal(late.body.blob, `blob:${h}`);
});

test('big files get a resumable session', async () => {
  const h = sha(Buffer.from('big'));
  const r = await call(owner, '/v1/blobs/upload', { sha256: h, bytes: big.RESUMABLE_AT + 1, filename: 'big.tar' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.method, 'resumable');
  assert.match(r.body.url, /^https:\/\/resumable\.test\//);
  assert.ok(calls.some((c) => c.startsWith('resumable ') && c.endsWith(` ${big.RESUMABLE_AT + 1}`)));
});

test('bytes that are not the hash, or not the size, are refused and dropped', async () => {
  const data = Buffer.from('the real bytes');
  const h = sha(data);
  const s1 = await call(owner, '/v1/blobs/upload', { sha256: h, bytes: data.length, filename: 'x.bin' });
  put(s1.body.upload, Buffer.from('other bytes!!!'));
  const bad = await call(owner, '/v1/blobs/upload/done', { sha256: h });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /don't match/);
  assert.ok(!objects.has(`gs://${BUCKET}/uploads/${s1.body.upload}`));
  assert.ok(!objects.has(`gs://${BUCKET}/sha256/${h}`));
  const s2 = await call(owner, '/v1/blobs/upload', { sha256: h, bytes: data.length, filename: 'x.bin' });
  put(s2.body.upload, Buffer.from('short'));
  const short = await call(owner, '/v1/blobs/upload/done', { sha256: h });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /bytes, not/);
});

test('a slow check answers "verifying", and asking again gets the blob', async () => {
  const { finishUpload, startUpload } = big;
  const client = { id: 'cl_slow', role: 'admin', projects: ['*'] } as any;
  const data = Buffer.from('slow to read');
  const h = sha(data);
  const s = await startUpload(client, { sha256: h, bytes: data.length, filename: 'a.bin' }, 1e9) as any;
  put(s.upload, data);
  slowMedia = 150;
  try {
    const [st1, b1] = await finishUpload(client, { sha256: h }, 10);
    assert.equal(st1, 202);
    assert.equal((b1 as any).state, 'verifying');
    const [st2, b2] = await finishUpload(client, { sha256: h }, 2000);
    assert.equal(st2, 200);
    assert.equal((b2 as any).blob, `blob:${h}`);
  } finally { slowMedia = 0; }
});

test('without a GCS bucket the route says to use POST /v1/blobs', async () => {
  bucketOn = false;
  try {
    const r = await call(owner, '/v1/blobs/upload', { sha256: 'a'.repeat(64), bytes: 10, filename: 'x' });
    assert.equal(r.status, 409);
    assert.equal(r.body.kind, 'no_bucket');
  } finally { bucketOn = true; }
  const tooBig = await call(owner, '/v1/blobs/upload', { sha256: 'a'.repeat(64), bytes: 50 * 2 ** 30, filename: 'x' });
  assert.equal(tooBig.status, 413);
  const badSha = await call(owner, '/v1/blobs/upload', { sha256: 'nope', bytes: 10 });
  assert.equal(badSha.status, 400);
});
