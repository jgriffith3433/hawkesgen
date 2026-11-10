// Scheduled, consistent backups of Gen's SQLite databases (docs/gen-cloudrun.md, "Backups").
//
// SQLite's online backup API (node:sqlite `backup`) copies the database page by page while Gen keeps running: it holds a
// read transaction, and in WAL mode a reader never blocks the writer, so writes are not locked out (the test measures the
// longest a write waited). A raw copy of the .db file could catch it mid-write. The copy is checked (integrity_check, row
// counts, the sum of every account's credits), compressed and put in a separate bucket with a manifest of those numbers.
// A restore (tools/gen-cloudrun/restore-backup.mjs) checks the same numbers again against the manifest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

export type Manifest = {
  name: string;
  lane: string;
  db: string;
  made: string;
  /** Rows in every table. */
  rows: Record<string, number>;
  /** The sum of users.credits (null when the database has no users table, e.g. analytics.db). */
  credits: number | null;
  /** How long the backup ran, and the longest the source database was unavailable to writers (WAL: none expected). */
  ms: number;
  writeStallMs: number;
  bytes: number;
  gzBytes: number;
};

const tablesOf = (d: DatabaseSync) =>
  (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);

/** Row counts of every table and the sum of users.credits, read from one file. */
export function fingerprint(file: string): { rows: Record<string, number>; credits: number | null; integrity: string } {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const rows: Record<string, number> = {};
    const tables = tablesOf(d);
    for (const t of tables) rows[t] = Number((d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n);
    const credits = tables.includes('users') ? Number((d.prepare('SELECT COALESCE(SUM(credits), 0) AS c FROM users').get() as { c: number }).c) : null;
    const integrity = String((d.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check);
    return { rows, credits, integrity };
  } finally {
    d.close();
  }
}

/**
 * An online backup of the database file `source` into `dest`, in a worker thread with its own connection (so Gen's event
 * loop keeps serving). All pages are copied in ONE step: SQLite restarts a stepped backup whenever another connection
 * writes between steps, so a busy database would never finish. One step holds only a read snapshot, which in WAL mode never
 * blocks a writer (and never waits for one: the snapshot is the moment it starts).
 */
export async function onlineBackup(source: string, dest: string): Promise<void> {
  fs.rmSync(dest, { force: true });
  const code = `const { workerData: w } = require('node:worker_threads');
    const { DatabaseSync, backup } = require('node:sqlite');
    const d = new DatabaseSync(w.source, { readOnly: true });
    d.exec('PRAGMA busy_timeout = 5000');
    backup(d, w.dest, { rate: 2147483647 }).then(() => { d.close(); }, (e) => { setImmediate(() => { throw e; }); });`;
  await new Promise<void>((resolve, reject) => {
    const wk = new Worker(code, { eval: true, workerData: { source, dest } });
    wk.once('error', reject);
    wk.once('exit', (c) => (c === 0 ? resolve() : reject(new Error(`backup worker exited ${c}`))));
  });
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Back one database up to a gzip file and a manifest in `outDir`. `writeStallMs` is measured by the caller (or 0). */
export async function backupToFile(source: string, name: string, outDir: string, lane = 'live', stall: () => number = () => 0) {
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const raw = path.join(outDir, `${name}.copy`);
  await onlineBackup(source, raw);
  const fp = fingerprint(raw);
  if (fp.integrity !== 'ok') throw new Error(`backup of ${name} failed its integrity check: ${fp.integrity}`);
  const base = `${name}-${stamp()}`;
  const gz = path.join(outDir, `${base}.db.gz`);
  await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 6 }), fs.createWriteStream(gz));
  const manifest: Manifest = {
    name: base, lane, db: name, made: new Date().toISOString(), rows: fp.rows, credits: fp.credits,
    ms: Date.now() - t0, writeStallMs: stall(), bytes: fs.statSync(raw).size, gzBytes: fs.statSync(gz).size,
  };
  fs.rmSync(raw, { force: true });
  const mf = path.join(outDir, `${base}.json`);
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));
  return { gz, manifest: mf, data: manifest };
}

/** Watches the event loop while a backup runs: the longest gap between turns, a floor for how long Gen could not write. */
export function stallMeter() {
  let last = Date.now();
  let worst = 0;
  const t = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last - 50); last = n; }, 50);
  t.unref();
  return { max: () => Math.max(0, worst), stop: () => clearInterval(t) };
}

export const backupBucket = () => process.env.HAWKESGEN_BACKUP_BUCKET || null;

/**
 * Back up hawkesgen.db (the live file) and analytics.db to the backup bucket. Called by `POST /v1/admin/backup`
 * (Cloud Scheduler, once a day) and by the owner. Objects: `<lane>/<db>-<time>.db.gz` and `.json`.
 */
export async function runBackup(opts: { dbFile: string; analyticsFile?: string; lane?: string; bucket?: string | null }) {
  const bucket = opts.bucket ?? backupBucket();
  if (!bucket) throw new Error('No backup bucket: set HAWKESGEN_BACKUP_BUCKET (docs/gen-cloudrun.md, "Backups")');
  const lane = opts.lane ?? process.env.HAWKESGEN_LANE ?? 'live';
  const { gcs } = await import('./providers/gcp/gcs.ts');
  const g = gcs();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkes-backup-'));
  const out: Manifest[] = [];
  try {
    const targets: { name: string; file: string }[] = [{ name: 'hawkesgen', file: opts.dbFile }];
    if (opts.analyticsFile && fs.existsSync(opts.analyticsFile)) targets.push({ name: 'analytics', file: opts.analyticsFile });
    for (const t of targets) {
      const meter = stallMeter();
      try {
        const r = await backupToFile(t.file, t.name, tmp, lane, () => meter.max());
        await g.writeFile(`gs://${bucket}/${lane}/${path.basename(r.gz)}`, r.gz, 'application/gzip');
        await g.writeFile(`gs://${bucket}/${lane}/${path.basename(r.manifest)}`, r.manifest, 'application/json');
        out.push(r.data);
      } finally {
        meter.stop();
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

/** Restore a backup file (.db.gz) into `dest` and compare it with its manifest. Returns the differences (empty = it matches). */
export async function restoreFile(gz: string, dest: string, manifest: Manifest): Promise<string[]> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });
  await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(dest));
  const fp = fingerprint(dest);
  const bad: string[] = [];
  if (fp.integrity !== 'ok') bad.push(`integrity_check: ${fp.integrity}`);
  for (const [t, n] of Object.entries(manifest.rows)) if (fp.rows[t] !== n) bad.push(`${t}: ${fp.rows[t] ?? 'missing'} rows, backup said ${n}`);
  for (const t of Object.keys(fp.rows)) if (!(t in manifest.rows)) bad.push(`${t}: not in the backup's manifest`);
  if (fp.credits !== manifest.credits) bad.push(`credits: ${fp.credits}, backup said ${manifest.credits}`);
  return bad;
}
