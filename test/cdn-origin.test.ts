// The CDN's origin (src/api.ts /cdn/sha256/<hash>, behind server/gen-cdn): reaches the route through the whole handler
// (it once fell into the dashboard's static files and answered 404), streams one library object by hash with no key,
// and serves nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cdn-'));
process.env.HAWKESGEN_LIBRARY_BUCKET = 'lib-bucket';
process.env.HAWKESGEN_LIBRARY_STORE = 'gcs';
const { handle } = await import('../src/api.ts');
const { setTokens } = await import('../src/providers/gcp/gcs.ts');

const SHA = 'ab'.repeat(32);
const asked: string[] = [];
setTokens({ access: async () => 'tok', id: async () => 'id' });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (!url.startsWith('https://storage.googleapis.com/')) return realFetch(input, init);
  asked.push(url);
  if (url.includes(encodeURIComponent(`sha256/${SHA}`))) return new Response('PNGDATA', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '7' } });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const gen = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => { globalThis.fetch = realFetch; setTokens(null); server.closeAllConnections(); server.close(); });

test('/cdn/sha256/<hash> streams that object from the library bucket, cacheable forever, with no key', async () => {
  const r = await realFetch(`${gen}/cdn/sha256/${SHA}`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'PNGDATA');
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('cache-control') ?? '', /immutable/);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.ok(asked.some((u) => u.includes('/b/lib-bucket/o/') && u.includes('alt=media')));
});

test('a hash not in the bucket is 404; other /cdn/ paths never touch the bucket', async () => {
  assert.equal((await realFetch(`${gen}/cdn/sha256/${'cd'.repeat(32)}`)).status, 404);
  const before = asked.length;
  for (const p of ['/cdn/sha256/short', '/cdn/sha256/', `/cdn/other/${SHA}`]) assert.notEqual((await realFetch(`${gen}${p}`)).status, 200, p);
  assert.equal(asked.length, before);
});
