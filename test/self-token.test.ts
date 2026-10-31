// Gen calling itself (asset.make's steps, chains, the judge, the view sheet, film plans) on Cloud Run, where "this machine
// is the owner" is off (2026-10-30: every chain failed with "Send an API key"): a token made at start, from this machine only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-self-'));
process.env.K_SERVICE = 'gen-test';
const A = await import('../src/auth.ts');
const req = (h: Record<string, string>, ip: string) => ({ headers: h, socket: { remoteAddress: ip } }) as any;

test("Gen's own token works from this machine on Cloud Run, nowhere else, and nothing else does", () => {
  try {
    assert.equal(A.authenticate(req({}, '127.0.0.1')), null, "on Cloud Run this machine isn't the owner by itself");
    assert.equal(A.authenticate(req({ authorization: `Bearer ${A.SELF_TOKEN}` }, '127.0.0.1'))?.role, 'owner');
    assert.equal(A.authenticate(req({ authorization: `Bearer ${A.SELF_TOKEN}` }, '::ffff:127.0.0.1'))?.role, 'owner');
    assert.equal(A.authenticate(req({ authorization: `Bearer ${A.SELF_TOKEN}` }, '203.0.113.9')), null, 'from outside it is nothing');
    assert.match(A.SELF_TOKEN, /^hgself_[\w-]{32}$/);
    assert.match(A.SELF_URL(), /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    delete process.env.K_SERVICE;
  }
});
