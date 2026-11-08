// Backups (src/backup.ts, docs/gen-cloudrun.md "Backups"): an online backup of a database that is being written to is
// restored into a scratch database, and its row counts and credit balances match; and no write waits more than a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { backupToFile, restoreFile, fingerprint, stallMeter, type Manifest } from '../src/backup.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkes-backup-test-'));
const live = path.join(tmp, 'hawkesgen.db');

function seed() {
  const d = new DatabaseSync(live);
  d.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  d.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, credits INTEGER NOT NULL);
          CREATE TABLE credit_ledger (id INTEGER PRIMARY KEY, user_id TEXT, delta INTEGER, note TEXT);
          CREATE TABLE jobs (id INTEGER PRIMARY KEY, log TEXT);`);
  d.exec('BEGIN');
  const u = d.prepare('INSERT INTO users VALUES (?, ?, ?)');
  const l = d.prepare('INSERT INTO credit_ledger (user_id, delta, note) VALUES (?, ?, ?)');
  const j = d.prepare('INSERT INTO jobs (log) VALUES (?)');
  for (let i = 0; i < 300; i++) { u.run(`u${i}`, `u${i}@example.com`, 100 + i); l.run(`u${i}`, 100 + i, 'Starter bonus'); }
  for (let i = 0; i < 20000; i++) j.run('x'.repeat(400));
  d.exec('COMMIT');
  return d;
}

// A second process writing the whole time, like Gen's queue: it reports the longest one write took.
const WRITER = `
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync(process.argv[2]);
d.exec('PRAGMA busy_timeout = 5000');
const ins = d.prepare('INSERT INTO jobs (log) VALUES (?)');
let worst = 0, n = 0;
const stop = Date.now() + Number(process.argv[3]);
while (Date.now() < stop) {
  const t = performance.now();
  ins.run('w'.repeat(400));
  worst = Math.max(worst, performance.now() - t);
  n++;
  await new Promise((r) => setTimeout(r, 1));
}
console.log(JSON.stringify({ worst, n }));
`;

test('a backup taken while Gen writes restores into a scratch database with the same rows and credits', async () => {
  const d = seed();
  const writerFile = path.join(tmp, 'writer.mjs');
  fs.writeFileSync(writerFile, WRITER);
  const w = spawn(process.execPath, [writerFile, live, '4000'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  w.stdout.on('data', (c) => (out += c));
  await new Promise((r) => setTimeout(r, 300)); // let it start writing

  const meter = stallMeter();
  const b = await backupToFile(live, 'hawkesgen', path.join(tmp, 'out'), 'test', () => meter.max());
  meter.stop();
  // Sum of credits is moved by a real purchase after the backup: the backup must not see it.
  d.prepare('UPDATE users SET credits = credits + 500 WHERE id = ?').run('u1');
  await new Promise((r) => w.on('close', r));
  const writer = JSON.parse(out) as { worst: number; n: number };

  const manifest = JSON.parse(fs.readFileSync(b.manifest, 'utf8')) as Manifest;
  const scratch = path.join(tmp, 'scratch', 'restored.db');
  const bad = await restoreFile(b.gz, scratch, manifest);
  assert.deepEqual(bad, [], 'the restored database matches the manifest');

  const r = fingerprint(scratch);
  assert.equal(r.integrity, 'ok');
  assert.equal(r.rows.users, 300);
  assert.equal(r.rows.credit_ledger, 300);
  assert.equal(r.credits, 300 * 100 + (299 * 300) / 2, 'credit balances match what the accounts held');
  assert.ok(r.rows.jobs >= 20000, 'rows written before and during the backup are in it');
  assert.notEqual(fingerprint(live).credits, r.credits, 'later changes are not in the backup');

  // The criterion: writers are never locked for more than a second.
  assert.ok(writer.n > 100, `the writer made ${writer.n} writes during the test`);
  assert.ok(writer.worst < 1000, `the slowest write waited ${writer.worst.toFixed(1)} ms`);
  assert.ok(manifest.writeStallMs < 1000, `the event loop stalled ${manifest.writeStallMs} ms`);
  console.log(`[backup] ${manifest.bytes} bytes -> ${manifest.gzBytes} gz in ${manifest.ms} ms; ${writer.n} concurrent writes, slowest ${writer.worst.toFixed(1)} ms; loop stall ${manifest.writeStallMs} ms`);
  d.close();
});

test('a restore that does not match its manifest says what differs', async () => {
  const b = await backupToFile(live, 'hawkesgen', path.join(tmp, 'out2'), 'test');
  const m = JSON.parse(fs.readFileSync(b.manifest, 'utf8')) as Manifest;
  m.rows.users += 1;
  m.credits = (m.credits ?? 0) + 1;
  const bad = await restoreFile(b.gz, path.join(tmp, 'scratch', 'bad.db'), m);
  assert.equal(bad.length, 2);
});
