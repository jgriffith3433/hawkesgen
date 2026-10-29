// The CDN's origin (src/api.ts /cdn/sha256/<hash>, behind server/gen-cdn): reaches the route through the whole handler
// (it once fell into the dashboard's static files and answered 404), streams one library object by hash with no key,
// serves only projects storage.cdnProjects lets out (never customers' by default), and on Cloud Run answers only
// Cloudflare's edge.
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
const { db } = await import('../src/db.ts');
const { cdnProject } = await import('../src/storage.ts');

const SHA = 'ab'.repeat(32);
const PRIVATE = 'ef'.repeat(32);
const asset = (id: string, project: string, sha: string) => db.prepare(
  "INSERT INTO assets (id, client, project, tool, kind, mime, path, bytes, sha256, recipe, recipe_key, created) VALUES (?, 'c', ?, 't', 'image', 'image/png', '/x.png', 7, ?, '{}', 'k', 0)",
).run(id, project, sha);
asset('a_game', 'doseofdestruction', SHA);
asset('a_customer', 'usr_00000000000000aa', PRIVATE);

const asked: string[] = [];
setTokens({ access: async () => 'tok', id: async () => 'id' });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (!url.startsWith('https://storage.googleapis.com/')) return realFetch(input, init);
  asked.push(url);
  if (url.includes('sha256')) return new Response('PNGDATA', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '7' } });
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

test("unknown hashes, customers' files and other /cdn/ paths never touch the bucket", async () => {
  const before = asked.length;
  assert.equal((await realFetch(`${gen}/cdn/sha256/${'cd'.repeat(32)}`)).status, 404);
  assert.equal((await realFetch(`${gen}/cdn/sha256/${PRIVATE}`)).status, 404);
  for (const p of ['/cdn/sha256/short', '/cdn/sha256/', `/cdn/other/${SHA}`]) assert.notEqual((await realFetch(`${gen}${p}`)).status, 200, p);
  assert.equal(asked.length, before);
});

test('on Cloud Run only Cloudflare\'s edge may call it', async () => {
  process.env.K_SERVICE = 'gen';
  try {
    const direct = await realFetch(`${gen}/cdn/sha256/${SHA}`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    assert.equal(direct.status, 403);
    const edge = await realFetch(`${gen}/cdn/sha256/${SHA}`, { headers: { 'X-Forwarded-For': '203.0.113.9, 172.70.1.2' } });
    assert.equal(edge.status, 200);
  } finally {
    delete process.env.K_SERVICE;
  }
});

test('cdnProjects: * is every project but customers\'; names and prefixes add them', () => {
  assert.equal(cdnProject('sickofit', ['*']), true);
  assert.equal(cdnProject('usr_00000000000000aa', ['*']), false);
  assert.equal(cdnProject('ustg_00000000000000aa', ['*']), false);
  assert.equal(cdnProject('usr_00000000000000aa', ['usr_00000000000000aa']), true);
  assert.equal(cdnProject('usr_00000000000000aa', ['usr_*']), true);
  assert.equal(cdnProject('usr_00000000000000aa', ['u*']), false);
  assert.equal(cdnProject('doseofdestruction', ['dose*']), true);
  assert.equal(cdnProject('sickofit', ['dose*']), false);
  assert.equal(cdnProject('sickofit', []), false);
});
