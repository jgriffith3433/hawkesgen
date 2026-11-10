// The local journal of unsaved timeline edits (IndexedDB, in this browser). Every change is written here before it goes
// to Gen, so a reload, a crash or a dropped connection never loses it. An op is a whole-document step:
// { seq, scene, base, doc }, where base is the server version the edit was made on. Ops replay in seq order (the last
// one wins, so replay never conflicts); one is cleared once a save that included it succeeds.

const DB = 'hawkes-gen-journal';
const STORE = 'ops';

/** Ops in the order they were made. seq is a time plus a counter, so tabs and reloads never reorder or collide. */
let counter = 0;
export const nextSeq = () => Date.now() * 1000 + (counter++ % 1000);
export const ordered = (ops) => [...ops].sort((a, b) => a.seq - b.seq);

/** The document to show on load: the newest op made on top of this server version (or later); older ones are superseded. */
export function replay(ops, scene, serverVersion) {
  const mine = ordered(ops.filter((o) => o.scene === scene && o.base >= serverVersion));
  return mine.length ? mine[mine.length - 1] : null;
}

// A memory copy is the fallback when IndexedDB isn't there (private windows, blocked storage).
const memory = new Map();
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'seq' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
async function run(mode, fn) {
  const db = await open();
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out?.result ?? true);
      tx.onerror = tx.onabort = () => resolve(null);
    });
  } catch { return null; }
}

/** Writes one op (an edit not saved yet). Keeps only the newest per scene: each op holds the whole document. */
export async function append(op) {
  memory.set(op.scene, op);
  await run('readwrite', (s) => {
    const all = s.getAll();
    all.onsuccess = () => { for (const o of all.result) if (o.scene === op.scene && o.seq < op.seq) s.delete(o.seq); };
    return s.put(op);
  });
}
/** Every op kept for a scene. */
export async function pending(scene) {
  const rows = await run('readonly', (s) => s.getAll());
  const list = Array.isArray(rows) ? rows : [];
  const m = memory.get(scene);
  if (m && !list.some((o) => o.seq === m.seq)) list.push(m);
  return list.filter((o) => o.scene === scene);
}
/** Forgets a scene's ops up to seq: they are saved. */
export async function clear(scene, upTo = Infinity) {
  if (memory.get(scene)?.seq <= upTo) memory.delete(scene);
  await run('readwrite', (s) => {
    const all = s.getAll();
    all.onsuccess = () => { for (const o of all.result) if (o.scene === scene && o.seq <= upTo) s.delete(o.seq); };
    return all;
  });
}
