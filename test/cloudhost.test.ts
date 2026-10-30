// Gen on Cloud Run (src/cloudhost.ts): which state files are synced to Cloud Storage, and only when they change.
// Offline: a scratch folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedFiles, isStateFile } from '../src/cloudhost.ts';

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-cloudhost-'));
  const put = (rel: string, data = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
  return { dir, put };
}

test('settings and small state files are synced; databases, the library, blobs and scratch never are', () => {
  const { dir, put } = scratch();
  for (const f of ['settings.json', 'cloudrun/image.json', 'comfy-cache/object_info.json',
    'hawkesgen.db', 'hawkesgen.db-wal', 'hawkesgen.db-shm', 'analytics.db', 'library/a/b.png', 'blobs/x', 'tmp/y', 'graphs/g.json', 'fleet/key.pem', 'comfy-cache/templates/t.json']) put(f);
  assert.deepEqual(changedFiles(dir, new Map()).sort(), ['cloudrun/image.json', 'comfy-cache/object_info.json', 'settings.json']);
});

test("Litestream's working folders never sync (2026-10-30: pulling them raced Litestream, the pull stopped before settings.json)", () => {
  const { dir, put } = scratch();
  for (const f of ['settings.json', '.analytics.db-litestream/generations/5391/wal/00000038.wal', '.hawkesgen.db-litestream/generation', 'x.litestream/y']) put(f);
  assert.deepEqual(changedFiles(dir, new Map()), ['settings.json']);
  assert.ok(isStateFile('settings.json') && isStateFile('claude/accounts.json'));
  assert.ok(!isStateFile('.analytics.db-litestream/generations/5391/wal/00000038.wal') && !isStateFile('.hawkesgen.db-litestream/generation'));
});

test('a file is pushed again only after it changes', () => {
  const { dir, put } = scratch();
  put('settings.json', '{"a":1}');
  const seen = new Map<string, string>();
  assert.deepEqual(changedFiles(dir, seen), ['settings.json']);
  assert.deepEqual(changedFiles(dir, seen), []);
  put('settings.json', '{"a":22}');
  assert.deepEqual(changedFiles(dir, seen), ['settings.json']);
});

test('files over 20 MB stay out of the state sync', () => {
  const { dir, put } = scratch();
  put('big.json', 'x'.repeat(21 * 1024 * 1024));
  assert.deepEqual(changedFiles(dir, new Map()), []);
});
