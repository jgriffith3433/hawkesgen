// Hawkes Gen on Google Cloud Run (docs/gen-cloudrun.md): one instance at most, none while idle.
//   - The databases (hawkesgen.db, analytics.db) are streamed to Cloud Storage by Litestream around this process
//     (server/gen-cloudrun/entrypoint.sh) and restored before it starts.
//   - The small state files beside them (settings.json, the Cloud Run image refs, caches worth keeping) are synced here:
//     pulled before anything reads them, pushed when they change and when Cloud Run stops the instance.
//   - Library files live in Cloud Storage (settings.storage.provider "gcs"); the instance's disk is only a cache.
//   - While jobs are queued or running, the service calls its own health route every 45 s: Cloud Run keeps an instance
//     that is serving requests, so the queue never loses its machine mid-job, and the instance goes away once idle.
//   - On an empty database, HAWKESGEN_OWNER_KEY (from Secret Manager) becomes the owner's key: there is no "this machine"
//     on Cloud Run to trust instead.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, env } from './config.ts';

/** True inside Cloud Run (K_SERVICE is set by the platform for services, CLOUD_RUN_JOB for jobs). */
export const onCloudRun = () => !!process.env.K_SERVICE;

const STATE_PREFIX = 'state/';
/** What is synced: small files under DATA_DIR, never the databases (Litestream's), the library, blobs or scratch. */
const SKIP = /^(hawkesgen\.db|analytics\.db)(-wal|-shm|-journal)?$|^(library|blobs|tmp|graphs|fleet|builder|comfy-cache\/(templates|thumbs))(\/|$)|\.litestream/;
const MAX_BYTES = 20 * 1024 * 1024;

function walk(dir: string, base = dir): string[] {
  let out: string[] = [];
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (SKIP.test(rel)) continue;
    if (e.isDirectory()) out = out.concat(walk(full, base));
    else if (e.isFile() && fs.statSync(full).size <= MAX_BYTES) out.push(rel);
  }
  return out;
}

/** The files to push: those whose size or mtime changed since the last push (`seen`). Exported for the tests. */
export function changedFiles(dir: string, seen: Map<string, string>) {
  const out: string[] = [];
  for (const rel of walk(dir)) {
    const st = fs.statSync(path.join(dir, rel));
    const sig = `${st.size}:${st.mtimeMs}`;
    if (seen.get(rel) !== sig) { out.push(rel); seen.set(rel, sig); }
  }
  return out;
}

export function stateBucket() {
  return env('HAWKESGEN_STATE_BUCKET') ?? null;
}

/** Before the rest of Gen loads: brings the state files down from Cloud Storage (a fresh instance has none). */
export async function pullState() {
  const bucket = stateBucket();
  if (!bucket) return 0;
  const { gcs } = await import('./providers/gcp/gcs.ts');
  const g = gcs();
  let n = 0;
  for await (const o of g.list(bucket, STATE_PREFIX)) {
    const rel = o.name.slice(STATE_PREFIX.length);
    if (!rel || SKIP.test(rel)) continue;
    const data = await g.read(`gs://${bucket}/${o.name}`);
    if (!data) continue;
    const dest = path.join(DATA_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    n++;
  }
  return n;
}

const seen = new Map<string, string>();
let pushing: Promise<number> | null = null;

/** Pushes the state files that changed. One push at a time; a second call while one runs waits for it. */
export function pushState(): Promise<number> {
  const bucket = stateBucket();
  if (!bucket) return Promise.resolve(0);
  if (pushing) return pushing;
  pushing = (async () => {
    const { gcs } = await import('./providers/gcp/gcs.ts');
    const g = gcs();
    let n = 0;
    for (const rel of changedFiles(DATA_DIR, seen)) {
      await g.writeFile(`gs://${bucket}/${STATE_PREFIX}${rel}`, path.join(DATA_DIR, rel));
      n++;
    }
    return n;
  })().finally(() => { pushing = null; });
  return pushing;
}

/** Whether the queue has work: queued or running jobs (top-level or steps). */
export async function busy() {
  const { db } = await import('./db.ts');
  const r = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')").get() as { n: number };
  return r.n > 0;
}

/** The service's own address (Cloud Run gives it to the deploy, which passes it on). */
const selfUrl = () => (env('HAWKESGEN_PUBLIC_URL') ?? '').replace(/\/+$/, '');

/** Starts the push loop, the keep-alive and the stop handler. */
export function startCloudHost({ every = 30_000, ping = 45_000 } = {}) {
  // Mark what came down from the bucket as already pushed, so the first loop sends only real changes.
  changedFiles(DATA_DIR, seen);
  setInterval(() => void pushState().catch((e) => console.warn(`[cloudhost] state push: ${e.message}`)), every).unref();
  const url = selfUrl();
  if (url) {
    setInterval(() => void busy().then(async (b) => { if (b) await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(20_000) }); }).catch(() => {}), ping).unref();
  } else console.warn('[cloudhost] HAWKESGEN_PUBLIC_URL is not set: nothing keeps the instance up while jobs run');
}

/** Cloud Run sends SIGTERM and allows 10 s: push the state first. Returns once it's done or after 8 s. */
export async function flushOnStop() {
  await Promise.race([pushState().catch((e) => console.warn(`[cloudhost] final push: ${e.message}`)), new Promise((r) => setTimeout(r, 8000))]);
}

/** On a database with no owner yet, makes HAWKESGEN_OWNER_KEY the owner's key (only its hash is stored). */
export async function ensureOwner() {
  const key = (process.env.HAWKESGEN_OWNER_KEY ?? '').trim();
  if (!key) return null;
  const { db } = await import('./db.ts');
  const { sha256, id } = await import('./util.ts');
  const hash = sha256(key);
  if (db.prepare('SELECT id FROM clients WHERE key_hash = ?').get(hash)) return null;
  if (db.prepare("SELECT id FROM clients WHERE role = 'owner' AND disabled IS NOT 1").get()) return null;
  const clientId = id('c', 6);
  db.prepare('INSERT INTO clients (id, name, prefix, key_hash, role, projects, created) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    clientId, 'J (owner, Cloud Run)', key.slice(0, 7), hash, 'owner', JSON.stringify(['*']), Date.now(),
  );
  return clientId;
}
