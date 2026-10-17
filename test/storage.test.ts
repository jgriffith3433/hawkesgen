// The library's files in S3 (src/storage.ts), against a fake store: each new asset is backed up once by content, a
// backfill catches what came before, and a missing file comes back for a job's input or a download. No AWS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-storage-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'off';
const storage = await import('../src/storage.ts');
const { putAsset } = await import('../src/library.ts');

const objects = new Map<string, Buffer>();
const fake = {
  puts: 0,
  async has(key: string) { return objects.has(key); },
  async put(key: string, file: string) { fake.puts++; objects.set(key, fs.readFileSync(file)); },
  async get(key: string, dest: string) {
    const b = objects.get(key);
    if (!b) throw new Error('NoSuchKey');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, b);
  },
};
const make = (text: string) => putAsset({ data: Buffer.from(text), ext: '.txt', client: 't', project: 'p', tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any });

test('off by default: nothing is uploaded and status says so', () => {
  make('before the bucket');
  assert.equal(storage.bucket(), null);
  assert.equal(storage.status().backedUp, 0);
});

test('backfill, then every new asset once by content; a missing file comes back', async () => {
  process.env.HAWKESGEN_LIBRARY_BUCKET = 'test-bucket';
  storage.setStore(fake);
  assert.equal(storage.backfill(), 1); // the asset made while it was off
  await storage.idle();
  const a = make('hello');
  make('hello'); // same bytes: stored once
  await storage.idle();
  assert.equal(fake.puts, 2);
  const st = storage.status();
  assert.equal(st.backedUp, st.files);
  assert.equal(storage.backfill(), 0);

  // A new disk: the file is gone, a job's input or a download brings it back.
  fs.rmSync(a.path);
  await storage.ensureInputs({ file: a.path });
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'hello');
  fs.rmSync(a.path);
  const r = await storage.restoreAll();
  assert.equal(r.restored, 1);
  assert.equal(r.missing, 0);
});
