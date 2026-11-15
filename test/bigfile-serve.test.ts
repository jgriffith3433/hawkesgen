// A file past 64 MiB (a finished unity.build artifact is about 70 MB) comes out of /v1/files and /v1/assets/<id>/file whole:
// every byte, the right length and checksum, on Cloud Run's chunked path and off it, and again as a range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-bigfile-'));
const { handle } = await import('../src/api.ts');
const { createClient } = await import('../src/auth.ts');
const { putAsset } = await import('../src/library.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => { server.close(); delete process.env.K_SERVICE; });

const SIZE = 70 * 1024 * 1024;
const data = crypto.randomBytes(SIZE);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const want = sha(data);
const asset = putAsset({ data, mime: 'application/gzip', client: 't', project: 'usr_big', tool: 'unity.build', recipe: { tool: 'unity.build', params: { n: 1 } } as any });
const key = createClient('big (test)', 'user', ['usr_big']).key;
const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers: { authorization: `Bearer ${key}`, ...headers } });

for (const onRun of [false, true]) {
  for (const route of ['/v1/files/', '/v1/assets/']) {
    test(`a 70 MiB file arrives whole from ${route} ${onRun ? 'on Cloud Run' : 'off it'}`, async () => {
      if (onRun) process.env.K_SERVICE = 'gen'; else delete process.env.K_SERVICE;
      const r = await get(`${route}${asset.id}${route === '/v1/assets/' ? '/file' : ''}`);
      assert.equal(r.status, 200);
      const body = Buffer.from(await r.arrayBuffer());
      assert.equal(body.length, SIZE);
      assert.equal(sha(body), want);
    });
  }
}

test('a range of the big file is exact', async () => {
  process.env.K_SERVICE = 'gen';
  const start = 40 * 1024 * 1024, end = SIZE - 1;
  const r = await get(`/v1/files/${asset.id}`, { range: `bytes=${start}-${end}` });
  assert.equal(r.status, 206);
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(body.length, end - start + 1);
  assert.equal(sha(body), sha(data.subarray(start, end + 1)));
});
