// One writer of Gen's databases at a time (ported from Hawkes Studio, where studio-beta lost J's new game, its agent
// change and his Approve cards on a deploy, 2026-10-31). Cloud Run's max-instances 1 is per revision: during a deploy,
// and for a while after it (CPU is always allocated, so an idle instance lingers), the old revision's instance keeps
// running and Litestream keeps streaming its copy as its own generation. The new instance restores a different, older
// generation, and everything the old one writes after that is on a copy nobody reads.
//
// The lease lives in the state bucket beside the databases (db/):
//   lease.json        {id, rev, at}: who holds it. Only a starting instance writes it (claim).
//   alive-<id>        the holder's heartbeat, every 5 s, with the generation it streams for each database (for a holder
//                     that dies).
//   released-<id>     the holder has stopped writing and Litestream made its last sync (written after it exits), with
//                     each database's Litestream generation: the next instance restores exactly those, never a guess.
// A starting instance claims before it restores (entrypoint.sh: node src/cloudlease.ts claim), then waits for the
// previous holder's released-<id>, up to 30 s, unless that holder was already silent for 15 s before the claim (crashed,
// or already gone). The holder checks the lease every 5 s (watchLease); when another instance claimed it, it saves its
// state files and exits, Litestream syncs one last time, and entrypoint.sh writes released-<id> (cloudlease.ts release).
// Nothing here may open a database: an empty one would make `litestream restore -if-db-not-exists` skip.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { Gcs, gcs } from './providers/gcp/gcs.ts';
import { stateBucket } from './cloudhost.ts';

/** The databases Litestream streams (litestream.yml). */
export const DBS = ['hawkesgen.db', 'analytics.db'] as const;
const ID_FILE = process.env.HAWKESGEN_LEASE_ID_FILE || '/tmp/hawkes-lease-id';
// The generation to restore for each database (entrypoint.sh passes it to litestream restore -generation), when the last
// holder named one: <prefix><db>.
const GEN_PREFIX = process.env.HAWKESGEN_LEASE_GEN_PREFIX || '/tmp/hawkes-restore-generation-';
// Litestream's own record of the generation this instance streams (beside each database).
const DATA = process.env.HAWKESGEN_LITESTREAM_DIR || '/data';
const GEN = /^[0-9a-f]{16}$/;
export type Lease = { id: string; rev: string | null; at: number };
type Generations = Partial<Record<(typeof DBS)[number], string>>;

let store: Gcs | null = null;
/** Tests swap in a Cloud Storage stand-in. */
export function setLeaseGcs(g: Gcs | null) {
  store = g;
}
const g = () => store ?? gcs();
const uri = (bucket: string, name: string) => `gs://${bucket}/db/${name}`;
const put = (bucket: string, name: string, value: unknown) => g().write(uri(bucket, name), Buffer.from(JSON.stringify(value)), 'application/json');

const readJsonObj = async <T>(bucket: string, name: string): Promise<T | null> => {
  const b = await g().read(uri(bucket, name)).catch(() => null);
  if (!b) return null;
  try { return JSON.parse(b.toString('utf8')) as T; } catch { return null; }
};

/** This instance's lease id (written by claim, read by the server and by release). */
export const myLeaseId = () => { try { return fs.readFileSync(ID_FILE, 'utf8').trim() || null; } catch { return null; } };

/** Only well-formed generations of known databases. */
const cleanGens = (v: unknown): Generations => {
  const out: Generations = {};
  if (v && typeof v === 'object') for (const db of DBS) { const x = String((v as any)[db] ?? ''); if (GEN.test(x)) out[db] = x; }
  return out;
};
/** Tells entrypoint.sh which generation to restore for each database (and forgets any older choice). */
const writeRestore = (gens: Generations) => {
  for (const db of DBS) {
    const f = `${GEN_PREFIX}${db}`;
    if (gens[db]) fs.writeFileSync(f, gens[db]!);
    else fs.rmSync(f, { force: true });
  }
};

/**
 * Takes the lease and waits until the previous holder has stopped writing: its released-<id>, or (only when its
 * heartbeat was already `staleMs` old at the claim) at once, at most `waitMs`. Returns what happened, for the log.
 */
export async function claim(o: { waitMs?: number; staleMs?: number; pollMs?: number; now?: () => number; rev?: string | null } = {}) {
  const bucket = stateBucket();
  if (!bucket) return { claimed: false, why: 'no state bucket' };
  const now = o.now ?? Date.now;
  const waitMs = o.waitMs ?? 30_000, staleMs = o.staleMs ?? 15_000, pollMs = o.pollMs ?? 1000;
  const prev = await readJsonObj<Lease>(bucket, 'lease.json');
  const mine: Lease = { id: `l_${crypto.randomBytes(6).toString('hex')}`, rev: o.rev !== undefined ? o.rev : process.env.K_REVISION ?? null, at: now() };
  // An older revision never takes the databases from a newer one: Cloud Run can start a fresh instance of the old
  // revision during a deploy (Studio, 2026-10-31). It doesn't start (entrypoint.sh).
  if (prev && revNumber(prev.rev) > revNumber(mine.rev)) return { claimed: false, id: null, previous: prev.id, how: 'newer holds it', holder: prev.rev };
  // Whether the holder was already gone before this claim (no heartbeat for staleMs): then nobody hands over. A holder
  // that was alive gets its full time to stop: seeing the claim (5 s), saving state (8 s), Litestream's last sync.
  const beat0 = prev ? await readBeat(bucket, prev.id) : { at: 0, generations: {} };
  await put(bucket, 'lease.json', mine);
  fs.writeFileSync(ID_FILE, mine.id);
  await put(bucket, `alive-${mine.id}`, beat(now()));
  writeRestore({});
  if (!prev) return { claimed: true, id: mine.id, previous: null, waited: 0, how: 'first' };
  const start = now();
  const gone = now() - beat0.at > staleMs;
  for (;;) {
    const rel = await readJsonObj<{ generations?: unknown }>(bucket, `released-${prev.id}`);
    if (rel) {
      const generation = cleanGens(rel.generations);
      writeRestore(generation);
      return { claimed: true, id: mine.id, previous: prev.id, waited: now() - start, how: 'released', generation };
    }
    if (gone) {
      // A holder that died: its last heartbeat names the generations it streamed, so even this restore is exact.
      writeRestore(beat0.generations);
      return { claimed: true, id: mine.id, previous: prev.id, waited: now() - start, how: 'quiet', generation: beat0.generations };
    }
    if (now() - start >= waitMs) return { claimed: true, id: mine.id, previous: prev.id, waited: now() - start, how: 'timed out' };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** This instance's Litestream generation of each database (none before Litestream has made one). */
const localGenerations = (): Generations => {
  const out: Generations = {};
  for (const db of DBS) {
    try { const x = fs.readFileSync(`${DATA}/.${db}-litestream/generation`, 'utf8').trim(); if (GEN.test(x)) out[db] = x; } catch { /* none yet */ }
  }
  return out;
};
const beat = (at: number) => ({ at, generations: localGenerations() });
/** A holder's heartbeat: when, and the generations it streams. */
async function readBeat(bucket: string, id: string): Promise<{ at: number; generations: Generations }> {
  const j = await readJsonObj<{ at?: unknown; generations?: unknown }>(bucket, `alive-${id}`);
  return { at: Number(j?.at) || 0, generations: cleanGens(j?.generations) };
}

/** A Cloud Run revision's number (gen-beta-00043-9r2 → 43); 0 when unknown (J's PC, tests). */
export const revNumber = (rev: string | null | undefined) => Number(/-(\d+)-[a-z0-9]+$/.exec(String(rev ?? ''))?.[1] ?? 0);

/** Written once this instance's Litestream has made its last sync: the next holder may restore. */
export async function release(id = myLeaseId()) {
  const bucket = stateBucket();
  if (!bucket || !id) return false;
  await put(bucket, `released-${id}`, { at: Date.now(), generations: localGenerations() });
  await g().del(uri(bucket, `alive-${id}`)).catch(() => {});
  return true;
}

/**
 * The holder's side: a heartbeat every `everyMs`, and `onLost` once another instance has claimed the lease (it then saves
 * its state and exits, so its databases stop changing). Returns a stop function (tests).
 */
export function watchLease(onLost: (by: Lease) => void, o: { everyMs?: number } = {}) {
  const bucket = stateBucket();
  const id = myLeaseId();
  if (!bucket || !id) return () => {};
  let lost = false;
  const tick = async () => {
    if (lost) return;
    const lease = await readJsonObj<Lease>(bucket, 'lease.json');
    if (lease && lease.id !== id) {
      lost = true;
      onLost(lease);
      return;
    }
    await put(bucket, `alive-${id}`, beat(Date.now())).catch(() => {});
  };
  const t = setInterval(() => void tick().catch(() => {}), o.everyMs ?? 5000);
  t.unref();
  return () => clearInterval(t);
}

// entrypoint.sh: node src/cloudlease.ts claim | release
if (process.argv[1]?.endsWith('cloudlease.ts')) {
  const what = process.argv[2];
  if (what === 'claim') {
    const r: any = await claim().catch((e) => ({ claimed: false, why: String(e.message ?? e) }));
    console.log(`[lease] ${JSON.stringify(r)}`);
    // A newer revision holds the databases: this old one must not start (exit 3 tells entrypoint.sh).
    if (r.how === 'newer holds it') process.exit(3);
  }
  else if (what === 'release') console.log(`[lease] released ${await release().catch(() => false)}`);
}
