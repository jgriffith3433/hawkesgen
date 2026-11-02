// A signed /v1/files link opens one asset with no session (Studio's playtest video links); nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-signed-'));
const { handle } = await import('../src/api.ts');
const { createClient } = await import('../src/auth.ts');
const { putAsset } = await import('../src/library.ts');
const { signedFileUrl } = await import('../src/links.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

const mk = (txt: string) => putAsset({ data: Buffer.from(txt), mime: 'text/plain', client: 't', project: 'usr_aaaa', tool: 'test', recipe: { tool: 'test', params: { txt } } as any });
const A = mk('asset A'), B = mk('asset B');
const owner = createClient('owner (test)', 'user', ['usr_aaaa']).key;
const other = createClient('other (test)', 'user', ['usr_bbbb']).key;

test('unsigned is 401, a valid signature is 200', async () => {
  assert.equal((await fetch(`${base}/v1/files/${A.id}`, { headers: { authorization: "Bearer hg_none" } })).status, 401);
  const { url } = signedFileUrl(base, A.id);
  const r = await fetch(url);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'asset A');
});

test('tampered, expired and another asset\'s signature are 401', async () => {
  const { url } = signedFileUrl(base, A.id);
  const u = new URL(url);
  const bad = new URL(url); bad.searchParams.set('sig', u.searchParams.get('sig')!.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')));
  assert.equal((await fetch(bad)).status, 401);
  const later = new URL(url); later.searchParams.set('exp', String(Number(u.searchParams.get('exp')) + 1000));
  assert.equal((await fetch(later)).status, 401);
  assert.equal((await fetch(signedFileUrl(base, A.id, 60_000, Date.now() - 3600_000).url)).status, 401);
  const swap = new URL(`${base}/v1/files/${B.id}`); swap.search = u.search;
  assert.equal((await fetch(swap)).status, 401);
});

test('the owner gets a signed link from the API; another customer cannot', async () => {
  const h = (k: string) => ({ headers: { authorization: `Bearer ${k}` }, method: 'POST' });
  assert.equal((await fetch(`${base}/v1/assets/${A.id}?sign=1`, h(other))).status, 404);
  const r = await fetch(`${base}/v1/assets/${A.id}?sign=1`, h(owner));
  assert.equal(r.status, 200);
  const { url } = await r.json() as any;
  assert.equal((await fetch(base + url)).status, 200);
  // a signed-in key still works as before, and another customer's key still can't read it
  assert.equal((await fetch(`${base}/v1/files/${A.id}`, { headers: { authorization: `Bearer ${owner}` } })).status, 200);
  assert.equal((await fetch(`${base}/v1/files/${A.id}`, { headers: { authorization: `Bearer ${other}` } })).status, 404);
});
