// Raw uploads stream to disk and are counted (src/uploads.ts): a slot per caller and in total, a 429 in plain words,
// a size cap by role, and the stored file is byte-identical with the right hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-uploads-'));
const { takeUpload, uploadLimits, uploadsNow } = await import('../src/uploads.ts');
const { handle } = await import('../src/api.ts');
const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as any).port;

test('a 4th concurrent upload from one caller is a plain 429; releasing frees the slot', () => {
  const rel = [takeUpload('u1'), takeUpload('u1'), takeUpload('u1')];
  assert.throws(() => takeUpload('u1'), (e: any) => e.status === 429 && /uploads at once/.test(e.message));
  const other = takeUpload('u2'); // another caller is unaffected
  rel[0](); rel[0](); // twice is safe
  const again = takeUpload('u1');
  [...rel, other, again].forEach((r) => r());
  assert.equal(uploadsNow().total, 0);
});

test('the total across callers is capped too', () => {
  const lim = uploadLimits();
  const held: (() => void)[] = [];
  for (let i = 0; i < lim.total; i++) held.push(takeUpload(`c${i}`));
  assert.throws(() => takeUpload('late'), (e: any) => e.status === 429 && /Too many uploads/.test(e.message));
  held.forEach((r) => r());
});

test('the user role has a lower size cap', () => {
  const l = uploadLimits();
  assert.ok(l.maxBytes('user') < l.maxBytes('admin'));
});

test('a raw upload streams to the library with the right bytes and hash, and leaves no temp file', async () => {
  const body = crypto.randomBytes(3 * 1024 * 1024);
  const r = await fetch(`http://127.0.0.1:${port}/v1/assets?project=sandbox`, { method: 'POST', headers: { 'Content-Type': 'video/mp4', 'X-Filename': encodeURIComponent('clip é.mp4'), 'Content-Length': String(body.length) }, body });
  const j: any = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.bytes, body.length);
  assert.equal(j.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(fs.readFileSync(j.path).equals(body), true);
  const blob = await fetch(`http://127.0.0.1:${port}/v1/blobs`, { method: 'POST', headers: { 'X-Filename': 'a.bin' }, body });
  assert.equal(((await blob.json()) as any).blob, `blob:${j.sha256}`);
  const left = fs.readdirSync(path.join(process.env.HAWKESGEN_DATA_DIR!, 'tmp', 'uploads'));
  assert.deepEqual(left, []);
});

test('an upload over the cap is refused with 413 and nothing is kept', async () => {
  process.env.HAWKESGEN_UPLOAD_MAX = '1000';
  const r = await fetch(`http://127.0.0.1:${port}/v1/blobs`, { method: 'POST', body: Buffer.alloc(5000) });
  delete process.env.HAWKESGEN_UPLOAD_MAX;
  assert.equal(r.status, 413);
  assert.match(((await r.json()) as any).error, /too big/);
  assert.deepEqual(fs.readdirSync(path.join(process.env.HAWKESGEN_DATA_DIR!, 'tmp', 'uploads')), []);
});

test.after(() => server.close());
