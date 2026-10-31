// One writer of Gen's databases at a time (src/cloudlease.ts; ported from Studio, where a deploy's old instance kept
// writing its own copy and J's new game, its agent change and his Approve cards were lost, 2026-10-31). A stand-in for
// Cloud Storage; no Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-lease-'));
process.env.HAWKESGEN_STATE_BUCKET = 'lease-test';
process.env.HAWKESGEN_LEASE_ID_FILE = path.join(tmp, 'lease-id');
process.env.HAWKESGEN_LEASE_GEN_PREFIX = path.join(tmp, 'restore-generation-');
process.env.HAWKESGEN_LITESTREAM_DIR = tmp;

const { Gcs } = await import('../src/providers/gcp/gcs.ts');
const L = await import('../src/cloudlease.ts');

const objects = new Map<string, Buffer>();
const fetchImpl = (async (input: any, init: any = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  let m = /upload\/storage\/v1\/b\/[^/]+\/o\?uploadType=media&name=([^&]+)/.exec(url);
  if (m) { objects.set(decodeURIComponent(m[1]), Buffer.from(init.body)); return json(200, {}); }
  m = /storage\/v1\/b\/[^/]+\/o\/([^?]+)\?alt=media$/.exec(url);
  if (m) { const b = objects.get(decodeURIComponent(m[1])); return b ? new Response(new Uint8Array(b)) : json(404, {}); }
  m = /storage\/v1\/b\/[^/]+\/o\/([^?]+)$/.exec(url);
  if (m && method === 'DELETE') { objects.delete(decodeURIComponent(m[1])); return json(200, {}); }
  return json(404, { error: { message: `no stand-in for ${method} ${url}` } });
}) as typeof fetch;
L.setLeaseGcs(new Gcs({ fetchImpl, tokens: { access: async () => 'test-token', id: async () => 'test-id' } }));

const restoreOf = (db: string) => { try { return fs.readFileSync(`${process.env.HAWKESGEN_LEASE_GEN_PREFIX}${db}`, 'utf8'); } catch { return null; } };
const streams = (db: string, gen: string) => { fs.mkdirSync(path.join(tmp, `.${db}-litestream`), { recursive: true }); fs.writeFileSync(path.join(tmp, `.${db}-litestream`, 'generation'), `${gen}\n`); };

test('the first instance takes the lease at once', async () => {
  const r: any = await L.claim();
  assert.equal(r.how, 'first');
  assert.equal(L.myLeaseId(), r.id);
  assert.equal(JSON.parse(objects.get('db/lease.json')!.toString()).id, r.id);
  assert.ok(objects.has(`db/alive-${r.id}`));
});

test('a deploy: the new instance waits for the old one to stop and restores exactly the generations it wrote', async () => {
  const old = L.myLeaseId()!;
  let lostTo: string | null = null;
  const stop = L.watchLease((by) => { lostTo = by.id; }, { everyMs: 20 });
  streams('hawkesgen.db', '5ee59909c639c135');
  streams('analytics.db', '0a1b2c3d4e5f6071');
  const claiming = L.claim({ pollMs: 10, waitMs: 5000 });
  const released = (async () => {
    while (!lostTo) await new Promise((r) => setTimeout(r, 10));
    await L.release(old);
  })();
  const [r]: any[] = await Promise.all([claiming, released]);
  stop();
  assert.equal(r.previous, old);
  assert.equal(r.how, 'released');
  assert.deepEqual(r.generation, { 'hawkesgen.db': '5ee59909c639c135', 'analytics.db': '0a1b2c3d4e5f6071' });
  assert.equal(restoreOf('hawkesgen.db'), '5ee59909c639c135', 'entrypoint.sh restores this generation');
  assert.equal(restoreOf('analytics.db'), '0a1b2c3d4e5f6071');
  assert.equal(lostTo, r.id, 'the old instance learned who took over');
  assert.ok(!objects.has(`db/alive-${old}`), 'its heartbeat is gone');
});

test('a stray instance of an older revision never takes the databases from a newer one (it stays down)', async () => {
  assert.equal(L.revNumber('gen-beta-00043-9r2'), 43);
  assert.equal(L.revNumber(null), 0);
  const newer: any = await L.claim({ rev: 'gen-beta-00043-9r2', pollMs: 10, staleMs: 0 });
  assert.equal(newer.claimed, true);
  const before = objects.get('db/lease.json')!.toString();
  const old: any = await L.claim({ rev: 'gen-beta-00042-fxq' });
  assert.equal(old.claimed, false);
  assert.equal(old.how, 'newer holds it');
  assert.equal(objects.get('db/lease.json')!.toString(), before, 'the lease is untouched');
  objects.set(`db/released-${newer.id}`, Buffer.from('{}'));
  const again: any = await L.claim({ rev: 'gen-beta-00043-9r2', pollMs: 10 });
  assert.equal(again.claimed, true);
  assert.equal(restoreOf('hawkesgen.db'), null, 'a release that names no generation leaves the restore to Litestream');
});

test('a holder that is shutting down gets its time; only one already silent before the claim is skipped', async () => {
  const holder = L.myLeaseId()!;
  objects.set(`db/alive-${holder}`, Buffer.from(JSON.stringify({ at: Date.now() })));
  const r: any = await L.claim({ rev: 'gen-beta-00044-a1b', pollMs: 10, staleMs: 15_000, waitMs: 300 });
  assert.equal(r.how, 'timed out');
});

test("a crashed holder doesn't hold a new instance up, and its last heartbeat names what to restore", async () => {
  const dead = L.myLeaseId()!;
  objects.set(`db/alive-${dead}`, Buffer.from(JSON.stringify({ at: Date.now() - 60_000, generations: { 'hawkesgen.db': '062800f778d554ed', 'analytics.db': 'nope' } })));
  const r: any = await L.claim({ rev: 'gen-beta-00045-c2d', pollMs: 10, staleMs: 15_000 });
  assert.equal(r.how, 'quiet');
  assert.ok(r.waited < 1000);
  assert.deepEqual(r.generation, { 'hawkesgen.db': '062800f778d554ed' });
  assert.equal(restoreOf('hawkesgen.db'), '062800f778d554ed', 'restored by name, never a guess');
  assert.equal(restoreOf('analytics.db'), null, 'a malformed generation is never passed on');
});
