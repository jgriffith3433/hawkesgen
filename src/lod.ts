// The LOD system: smaller copies of every image and model in the library, made by Gen itself as part of making the
// asset, and kept with the asset (one id; its levels hang off it, never separate assets in lists, search or bills).
//
//   images (texture, sprite, sky, picture)  every power-of-two size below the long side (128 ... 2048) as WebP, the
//                                            shape and transparency kept; the full size as WebP when that's smaller
//                                            (post/lod.py, Pillow). Level = the long side, px.
//   models (GLB)                             a low (~12% of the triangles, textures an eighth of the model's, 128-256 px), a mid when it pays
//                                            (~40%, <= 1024 px) and, for 4096 px textures, a high with them at 2048
//                                            (src/lod-mesh.ts: gltf-transform + meshoptimizer on the CPU; never a GPU
//                                            server). Level = triangles.
//
// How they get made: when a job finishes (only top-level jobs: a pipeline's steps are intermediate) or a file is
// uploaded, its images and GLBs are queued (queueLods). Of an asset.make chain's saved outputs only these are:
// its cutouts (the library's thumbnail) and the last step's result (the model, the texture);
// the in-between (view sheets and views, masks, raw meshes) get none (kept(), pruneLods() clears old ones). Anything
// asked for by id (GET /v1/lods) still gets levels: what's really used never goes without. A moment later one `asset.lod` job takes the batch: provider
// local, its own lane (`lod`, one at a time, behind every customer's CPU job), the lowest priority, the child processes
// at the lowest OS priority. It runs as Gen (client `gen`, project `hawkesgen.lod`): nobody is charged, nothing is
// listed in a customer's jobs. Idempotent per asset and LOD_VERSION (asset_lod_state); `backfill` queues the rest.
//
// A job that already made a low copy (blender.character's `lod` op: "model.high" and "model.lod1") is linked instead
// (asset_lod_links): the low is hidden from lists and becomes the model's low level (its textures made small).
//
// Reading: lodSummary(asset) (GET /v1/assets/:id `lods`, list rows, GET /v1/lods?ids=), pickLod(asset, n) (the file
// for GET /v1/assets/:id/file?lod=n: the largest level <= n, else the smallest; a level the same size as the
// original is served instead of it, being the smaller file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { db } from './db.ts';
import { paths, ROOT, loadSettings } from './config.ts';
import { getAsset, type Asset } from './library.ts';
import { backup, forget } from './storage.ts';
import type { Tool } from './tools/types.ts';

/** Bump when the levels made would change: assets made at an older version are redone by the backfill. */
export const LOD_VERSION = 1;
/** The project and client LOD jobs run as (Gen itself). */
export const LOD_PROJECT = 'hawkesgen.lod';
export const LOD_CLIENT = { id: 'gen', name: 'Hawkes Gen', role: 'owner' as const, projects: ['*'] };
const IMAGE_MIME = /^image\/(png|jpeg|webp)$/;
/** Steps whose picture is a chain's cutout (kept: it's the thumbnail), not in-between work. */
const CUTOUT_TOOLS = new Set(['image.remove-background', 'image.cutout']);
const MESH_MIME = /^model\/gltf-binary$/;
/** Assets per job: images are quick (a second or two each), models take longer. */
const BATCH = { image: 24, mesh: 4 };

// (The tables are in db.ts: asset_lods, asset_lod_state, asset_lod_links.)

/** Whether an asset is a kept result rather than in-between work: not a pipeline step's output, and of an asset.make
 *  chain's saved outputs only its last step's result and its cutouts (a background-removal step's picture, not its
 *  mask: the library's thumbnail). (Not "the first step": a best-of-N pick saves its candidates before the cutout.) */
export function kept(a: Pick<Asset, 'id' | 'job' | 'title' | 'meta'> | null | undefined): boolean {
  if (!a) return false;
  if (a.job) {
    const j = db.prepare("SELECT json_extract(labels, '$.parent') AS parent FROM jobs WHERE id = ?").get(a.job) as { parent: string | null } | undefined;
    if (j && j.parent) return false;
  }
  const m = (a.meta ?? {}) as { save?: string; step?: number; from?: string };
  if (!m.save || !a.job || !Number.isFinite(m.step)) return true;
  const r = db.prepare("SELECT MAX(json_extract(meta, '$.step')) AS last FROM assets WHERE job = ? AND json_extract(meta, '$.save') IS NOT NULL").get(a.job) as { last: number };
  if (m.step === r.last) return true;
  const from = m.from ? (db.prepare('SELECT title, tool FROM assets WHERE id = ?').get(m.from) as { title: string | null; tool: string } | undefined) : undefined;
  return Boolean(from && CUTOUT_TOOLS.has(from.tool) && !/mask/i.test(`${a.title ?? ''} ${from.title ?? ''}`));
}

/** What kind of levels an asset gets: 'image', 'mesh', or null (none: sounds, videos, a playtest's screenshots...). */
export function lodKind(a: Pick<Asset, 'mime' | 'meta' | 'tool'> | null | undefined): 'image' | 'mesh' | null {
  if (!a || a.tool === 'playtest.run' || (a.meta && (a.meta as any).playtest)) return null;
  if (IMAGE_MIME.test(a.mime)) return 'image';
  if (MESH_MIME.test(a.mime)) return 'mesh';
  return null;
}

// ------------------------------------------------------------------ queueing
const pending = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;

/** These assets get their levels made soon (in one batch job). Repeats, done ones and linked lows do nothing. */
export function queueLods(ids: string[], o: { now?: boolean; asked?: boolean } = {}) {
  let queued = 0;
  for (const id of ids) {
    if (!/^a_[0-9a-f]+$/.test(id) || pending.has(id)) continue;
    const a = getAsset(id);
    if (!lodKind(a)) continue;
    if (!o.asked && !kept(a)) continue;
    if (db.prepare('SELECT 1 FROM asset_lod_links WHERE low = ?').get(id)) continue;
    const s = db.prepare('SELECT version, state, tries FROM asset_lod_state WHERE asset = ?').get(id) as { version: number; state: string; tries: number } | undefined;
    if (s && s.version >= LOD_VERSION && s.state !== 'pruned' && (s.state !== 'failed' || s.tries >= 3)) continue;
    db.prepare(`INSERT INTO asset_lod_state (asset, version, state, updated) VALUES (?, ?, 'queued', ?)
                ON CONFLICT(asset) DO UPDATE SET version = excluded.version, state = 'queued', job = NULL, updated = excluded.updated`).run(id, LOD_VERSION, Date.now());
    pending.add(id);
    queued++;
  }
  if (queued) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flushLods(), o.now ? 0 : 1500);
    flushTimer.unref?.();
  }
  return queued;
}

/** The queued assets as asset.lod jobs, a batch each (images together, models together). */
export async function flushLods() {
  flushTimer = null;
  const ids = [...pending];
  pending.clear();
  if (!ids.length) return [];
  const { submit } = await import('./jobs.ts');
  const byKind: Record<'image' | 'mesh', string[]> = { image: [], mesh: [] };
  for (const id of ids) { const k = lodKind(getAsset(id)); if (k) byKind[k].push(id); }
  const jobs: string[] = [];
  for (const kind of ['image', 'mesh'] as const) {
    const list = byKind[kind];
    for (let i = 0; i < list.length; i += BATCH[kind]) {
      const batch = list.slice(i, i + BATCH[kind]);
      // (No job key: asset_lod_state already keeps each asset to one queued job, and a key would hand back an old job
      // when an asset is queued again after a failure or a new LOD version.)
      const job = submit(LOD_CLIENT, { tool: 'asset.lod', project: LOD_PROJECT, params: { assets: batch }, labels: { lod: kind, count: batch.length }, priority: -10 } as any);
      db.prepare(`UPDATE asset_lod_state SET job = ? WHERE asset IN (${batch.map(() => '?').join(',')})`).run(job.id, ...batch);
      jobs.push(job.id);
    }
  }
  return jobs;
}

/**
 * A finished job: links the low copies it made to their models, and queues its images and models (only a top-level
 * job's: a pipeline's steps are intermediate work, and its own outputs are what's kept). Called by the queue.
 */
export function afterJob(job: { id: string; tool: string; labels?: Record<string, unknown>; outputs: { asset: string; mime?: string; title?: string | null }[] }) {
  if (job.tool === 'asset.lod' || !job.outputs?.length) return { linked: 0, queued: 0 };
  const linked = linkLows(job.outputs);
  const queued = job.labels?.parent ? 0 : queueLods(job.outputs.map((o) => o.asset));
  return { linked, queued };
}

const LOW_TITLE = /(?:^|[._\- ])lod\d+$/i;
/** In one job's outputs, GLBs titled "...lod1" are the low copies of the biggest other GLB with the same stem. */
export function linkLows(outputs: { asset: string; mime?: string; title?: string | null }[]) {
  const glbs = outputs.filter((o) => MESH_MIME.test(String(o.mime ?? ''))).map((o) => ({ ...o, a: getAsset(o.asset) })).filter((o) => o.a);
  const lows = glbs.filter((o) => LOW_TITLE.test(String(o.title ?? o.a!.title ?? '')));
  if (!lows.length) return 0;
  const highs = glbs.filter((o) => !lows.includes(o));
  const stem = (t: string) => t.replace(LOW_TITLE, '').replace(/[._\- ]?(high|full|lod0)$/i, '').toLowerCase();
  let n = 0;
  for (const low of lows) {
    const s = stem(String(low.title ?? low.a!.title ?? ''));
    const candidates = highs.filter((h) => stem(String(h.title ?? h.a!.title ?? '')) === s);
    const high = (candidates.length ? candidates : highs).sort((x, y) => y.a!.bytes - x.a!.bytes)[0];
    if (!high) continue;
    n += Number(db.prepare('INSERT OR IGNORE INTO asset_lod_links (low, asset) VALUES (?, ?)').run(low.asset, high.asset).changes);
  }
  return n;
}

/** A queued asset whose job isn't waiting or running any more (SQL on asset_lod_state as s). */
const LOST = "s.state = 'queued' AND s.updated < (unixepoch() - 60) * 1000 AND (s.job IS NULL OR NOT EXISTS (SELECT 1 FROM jobs q WHERE q.id = s.job AND q.status IN ('queued', 'running')))";

/** Everything that should have levels and doesn't (at this version) is queued: newest first, a project or kind only. */
export function backfillLods(o: { project?: string; kind?: 'image' | 'mesh'; limit?: number; dryRun?: boolean } = {}) {
  // Links first: lows that finished jobs made before the LOD system existed.
  let linked = 0;
  const jobsWithLows = db.prepare(`SELECT DISTINCT a.job FROM assets a WHERE a.mime = 'model/gltf-binary' AND a.job IS NOT NULL AND (a.title LIKE '%lod_' OR a.title LIKE '%LOD_')${o.project ? ' AND a.project = ?' : ''}`).all(...(o.project ? [o.project] : [])) as { job: string }[];
  for (const { job } of jobsWithLows) {
    const outs = db.prepare('SELECT id AS asset, mime, title FROM assets WHERE job = ?').all(job) as any[];
    if (!o.dryRun) linked += linkLows(outs);
  }
  const where = [
    "(a.mime IN ('image/png', 'image/jpeg', 'image/webp', 'model/gltf-binary'))",
    "a.tool != 'playtest.run'",
    "json_extract(a.meta, '$.playtest') IS NULL",
    // Only what was kept: uploads and top-level jobs' outputs (a pipeline's steps are its intermediate work).
    "(a.job IS NULL OR j.id IS NULL OR json_extract(j.labels, '$.parent') IS NULL)",
    'a.id NOT IN (SELECT low FROM asset_lod_links)',
    // (Pruned ones too: the rule for what's kept may have changed since; kept() below decides.)
    `(s.asset IS NULL OR s.version < ${LOD_VERSION} OR s.state = 'pruned' OR (s.state = 'failed' AND s.tries < 3) OR (${LOST}))`,
  ];
  const args: string[] = [];
  if (o.project) { where.push('a.project = ?'); args.push(o.project); }
  if (o.kind === 'image') where.push("a.mime LIKE 'image/%'");
  if (o.kind === 'mesh') where.push("a.mime = 'model/gltf-binary'");
  const rows = db.prepare(`SELECT a.id FROM assets a LEFT JOIN jobs j ON j.id = a.job LEFT JOIN asset_lod_state s ON s.asset = a.id WHERE ${where.join(' AND ')} ORDER BY a.created DESC LIMIT ${Math.max(1, Math.min(100_000, o.limit ?? 100_000))}`).all(...args) as { id: string }[];
  const wanted = rows.filter((r) => kept(getAsset(r.id)));
  if (o.dryRun) return { linked: jobsWithLows.length, queued: 0, found: wanted.length, skipped: rows.length - wanted.length };
  // (A 'queued' row whose job is gone or ended without it, a restart between queueing and the job: queued again.)
  db.exec(`UPDATE asset_lod_state AS s SET state = 'failed' WHERE ${LOST}`);
  const queued = queueLods(wanted.map((r) => r.id), { now: true });
  return { linked, queued, found: wanted.length, skipped: rows.length - wanted.length };
}

/**
 * Clears levels made for in-between work (a pipeline's steps, an asset.make chain's middle steps and masks: what kept()
 * says no to): their files here and their copies in S3, so they cost neither disk nor storage. Their state becomes
 * 'pruned' (asked for by id later, they're made again). -> { assets, levels, bytes } (what would go, with dryRun).
 */
export async function pruneLods(o: { project?: string; dryRun?: boolean; limit?: number } = {}) {
  const rows = db.prepare(`SELECT DISTINCT l.asset FROM asset_lods l JOIN assets a ON a.id = l.asset${o.project ? ' WHERE a.project = ?' : ''}`).all(...(o.project ? [o.project] : [])) as { asset: string }[];
  const gone = rows.map((r) => r.asset).filter((id) => !kept(getAsset(id))).slice(0, Math.max(1, Math.min(1_000_000, o.limit ?? 1_000_000)));
  let levels = 0, bytes = 0;
  const shas: string[] = [];
  for (const id of gone) {
    const ls = db.prepare('SELECT path, bytes, sha256 FROM asset_lods WHERE asset = ?').all(id) as { path: string; bytes: number; sha256: string }[];
    levels += ls.length;
    for (const l of ls) bytes += l.bytes;
    if (o.dryRun) continue;
    db.prepare('DELETE FROM asset_lods WHERE asset = ?').run(id);
    setState(id, 'pruned');
    for (const l of ls) {
      // A file another asset's level or an asset itself still uses (the same content) stays.
      if (!db.prepare('SELECT 1 FROM asset_lods WHERE path = ?').get(l.path)) fs.rmSync(l.path, { force: true });
      shas.push(l.sha256);
    }
  }
  const s3 = o.dryRun ? 0 : await forget(shas);
  return { assets: gone.length, levels, bytes, s3 };
}

/** How far along it is: assets by state, levels made and their bytes, jobs waiting. */
export function lodStatus() {
  const by = Object.fromEntries((db.prepare('SELECT state, COUNT(*) AS n FROM asset_lod_state GROUP BY state').all() as { state: string; n: number }[]).map((r) => [r.state, r.n]));
  const l = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM asset_lods').get() as { n: number; bytes: number };
  const links = (db.prepare('SELECT COUNT(*) AS n FROM asset_lod_links').get() as { n: number }).n;
  const jobs = Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE tool = 'asset.lod' GROUP BY status").all() as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  return { version: LOD_VERSION, assets: by, levels: l.n, bytes: l.bytes, links, jobs };
}

// ------------------------------------------------------------------ making them
const PYTHON = [
  path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
  path.join(ROOT, '.venv', 'bin', 'python'),
  path.join(paths.projects, 'hawkesgen', '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p)) ?? (process.platform === 'win32' ? 'python' : 'python3');

/** A child process at the lowest OS priority (customers' jobs and the HTTP server come first). Resolves to stdout. */
function runLow(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try { if (c.pid) os.setPriority(c.pid, 19); } catch { /* not allowed here: it still runs */ }
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; if (err.length > 20_000) err = err.slice(-20_000); });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(args[0] ?? cmd)} exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`))));
  });
}
const lastJson = (s: string) => JSON.parse(s.trim().split('\n').pop() || '{}');
const sha256File = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Where an asset's levels live: beside it in the library (same month folder), named by the asset and level. */
const stemOf = (a: Asset) => path.join(path.dirname(a.path), `${a.id}.lod`);

function saveLevels(a: Asset, rows: { level: number; role?: string | null; mime: string; path: string; width?: number | null; height?: number | null; triangles?: number | null; texture?: number | null }[]) {
  const put = db.prepare(`INSERT INTO asset_lods (asset, level, role, mime, bytes, width, height, triangles, texture, path, sha256, created)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const old = db.prepare('SELECT path FROM asset_lods WHERE asset = ?').all(a.id) as { path: string }[];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM asset_lods WHERE asset = ?').run(a.id);
    for (const r of rows) {
      const bytes = fs.statSync(r.path).size;
      const sha = sha256File(r.path);
      put.run(a.id, r.level, r.role ?? null, r.mime, bytes, r.width ?? null, r.height ?? null, r.triangles ?? null, r.texture ?? null, r.path, sha, Date.now());
      backup({ sha256: sha, path: r.path, bytes });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Files of an older version that aren't used any more.
  const keep = new Set(rows.map((r) => r.path));
  for (const o of old) if (!keep.has(o.path)) fs.rmSync(o.path, { force: true });
}

function setState(id: string, state: string, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra);
  db.prepare(`UPDATE asset_lod_state SET state = ?, version = ?, updated = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE asset = ?`).run(state, LOD_VERSION, Date.now(), ...(Object.values(extra) as any[]), id);
}

/** Makes images' levels, a batch in one Python process. */
async function makeImages(list: Asset[], signal?: AbortSignal, log?: (s: string) => void) {
  if (!list.length) return;
  const planFile = path.join(paths.tmp, `lod-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(planFile, JSON.stringify({ images: list.map((a) => ({ in: a.path, out: stemOf(a) })) }));
  try {
    const res = lastJson(await runLow(PYTHON, [path.join(paths.post, 'lod.py'), planFile], signal)).images as any[];
    list.forEach((a, i) => {
      const r = res[i] ?? { error: 'no answer' };
      if (r.error) { setState(a.id, 'failed', { error: String(r.error).slice(0, 300), tries: tries(a.id) + 1 }); log?.(`${a.id}: ${r.error}`); return; }
      if (r.skipped) { setState(a.id, 'skipped', { error: String(r.skipped).slice(0, 300), width: r.width ?? null, height: r.height ?? null }); return; }
      saveLevels(a, (r.levels as any[]).map((l) => ({ level: l.level, mime: 'image/webp', path: l.path, width: l.width, height: l.height })));
      setState(a.id, r.levels.length ? 'done' : 'skipped', { width: r.width, height: r.height, error: r.levels.length ? null : 'small already' });
      log?.(`${a.id}: ${r.width}x${r.height}, ${r.levels.length} level${r.levels.length === 1 ? '' : 's'}`);
    });
  } finally {
    fs.rmSync(planFile, { force: true });
  }
}
const tries = (id: string) => Number((db.prepare('SELECT tries FROM asset_lod_state WHERE asset = ?').get(id) as { tries: number } | undefined)?.tries ?? 0);

/** Makes one model's levels in its own process (src/lod-mesh.ts). */
async function makeMesh(a: Asset, signal?: AbortSignal, log?: (s: string) => void) {
  const low = db.prepare('SELECT low FROM asset_lod_links WHERE asset = ? LIMIT 1').get(a.id) as { low: string } | undefined;
  const source = low ? getAsset(low.low)?.path : undefined;
  const planFile = path.join(paths.tmp, `lod-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(planFile, JSON.stringify({ in: a.path, out: stemOf(a), python: PYTHON, script: path.join(paths.post, 'lod.py'), source }));
  try {
    const r = lastJson(await runLow(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'lod-mesh.ts'), planFile], signal));
    saveLevels(a, (r.levels as any[]).map((l) => ({ level: l.level, role: l.role, mime: 'model/gltf-binary', path: l.path, triangles: l.level, texture: l.texture })));
    setState(a.id, r.levels.length ? 'done' : 'skipped', { triangles: r.triangles, texture: r.texture, error: r.levels.length ? null : 'small already' });
    log?.(`${a.id}: ${r.triangles} triangles, ${r.texture} px textures -> ${r.levels.map((l: any) => `${l.role} ${l.level}`).join(', ') || 'nothing to make'}${source ? ' (low from the job\'s own copy)' : ''}`);
  } catch (e: any) {
    setState(a.id, 'failed', { error: String(e?.message ?? e).slice(0, 300), tries: tries(a.id) + 1 });
    log?.(`${a.id}: ${e?.message ?? e}`);
  } finally {
    fs.rmSync(planFile, { force: true });
  }
}

/** Makes the levels of these assets (skipping any done at this version). */
export async function makeLods(ids: string[], o: { signal?: AbortSignal; log?: (s: string) => void; step?: (s: string) => void } = {}) {
  const todo: Asset[] = [];
  for (const id of ids) {
    const a = getAsset(id);
    if (!a || !lodKind(a)) continue;
    const s = db.prepare('SELECT version, state FROM asset_lod_state WHERE asset = ?').get(id) as { version: number; state: string } | undefined;
    if (s && s.version >= LOD_VERSION && ['done', 'skipped'].includes(s.state)) continue;
    if (!s) db.prepare("INSERT INTO asset_lod_state (asset, version, state, updated) VALUES (?, ?, 'queued', ?)").run(id, LOD_VERSION, Date.now());
    // A library file not on this disk (a new server) comes back from S3 first.
    if (!fs.existsSync(a.path)) {
      const { ensureLocal } = await import('./storage.ts');
      if (!(await ensureLocal(a))) { setState(a.id, 'failed', { error: 'the file is missing here and not in S3', tries: 3 }); continue; }
    }
    todo.push(a);
  }
  const images = todo.filter((a) => lodKind(a) === 'image');
  const meshes = todo.filter((a) => lodKind(a) === 'mesh');
  if (images.length) { o.step?.(`making the levels of ${images.length} image${images.length === 1 ? '' : 's'}`); await makeImages(images, o.signal, o.log); }
  for (const [i, a] of meshes.entries()) { o.step?.(`model ${i + 1} of ${meshes.length}: ${a.title ?? a.id}`); await makeMesh(a, o.signal, o.log); }
  return { made: todo.length };
}

/** The tool the queue runs: `asset.lod` (internal: users can't submit it; billing.ts INTERNAL_ONLY_TOOLS). */
export const assetLodTool: Tool = {
  id: 'asset.lod',
  version: LOD_VERSION,
  title: 'Levels of detail',
  description: "Makes the smaller copies of images and models that belong to them (Gen queues it itself when an asset is saved). CPU only, its own lane, never charged.",
  provider: 'local',
  lane: { name: 'lod', limit: () => loadSettings().concurrency.lod ?? 1, yieldTo: ['local'] },
  output: 'file',
  inputs: {},
  params: { assets: { type: 'json', required: true, description: 'Asset ids (a_...)' } },
  async run(ctx) {
    const ids = (Array.isArray(ctx.params.assets) ? ctx.params.assets : []).map(String);
    const lines: string[] = [];
    const r = await makeLods(ids, { signal: ctx.signal, step: ctx.step, log: (s) => { lines.push(s); ctx.log(s); } });
    ctx.result({ ...r, assets: ids.length, summary: lodSummaries(ids) });
  },
};

// ------------------------------------------------------------------ reading them
export type LodLevel = { level: number; bytes: number; w?: number; h?: number; tris?: number; tex?: number; role?: string; sha: string };
export type LodSummary = {
  kind: 'image' | 'mesh';
  state: string;
  /** The original: images [w, h]; models triangles and the biggest texture (px). */
  size?: [number, number];
  tris?: number;
  tex?: number;
  bytes: number;
  sha: string;
  /** Smallest first. */
  levels: LodLevel[];
};

/** The levels of these assets, by id (compact: lists and bundles carry them inline). Ids without any are left out. */
export function lodSummaries(ids: string[]): Record<string, LodSummary> {
  const out: Record<string, LodSummary> = {};
  const list = [...new Set(ids.filter((x) => /^a_[0-9a-f]+$/.test(x)))];
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    const q = chunk.map(() => '?').join(',');
    const assets = db.prepare(`SELECT a.id, a.mime, a.bytes, a.sha256, s.state, s.width, s.height, s.triangles, s.texture FROM assets a JOIN asset_lod_state s ON s.asset = a.id WHERE a.id IN (${q})`).all(...chunk) as any[];
    for (const a of assets) {
      const kind = MESH_MIME.test(a.mime) ? 'mesh' : 'image';
      out[a.id] = {
        kind, state: a.state, bytes: a.bytes, sha: a.sha256.slice(0, 16), levels: [],
        ...(kind === 'image' ? (a.width ? { size: [a.width, a.height] as [number, number] } : {}) : { tris: a.triangles ?? undefined, tex: a.texture ?? undefined }),
      };
    }
    for (const r of db.prepare(`SELECT * FROM asset_lods WHERE asset IN (${q}) ORDER BY asset, level`).all(...chunk) as any[]) {
      const s = out[r.asset];
      if (!s) continue;
      s.levels.push(s.kind === 'image'
        ? { level: r.level, bytes: r.bytes, w: r.width, h: r.height, sha: r.sha256.slice(0, 16) }
        : { level: r.level, bytes: r.bytes, tris: r.triangles, tex: r.texture, role: r.role, sha: r.sha256.slice(0, 16) });
    }
  }
  return out;
}
export const lodSummary = (id: string): LodSummary | null => lodSummaries([id])[id] ?? null;

/** The file for `?lod=n`: the largest level <= n, else the smallest; null means the original (n is at least its size,
 *  or it has no levels). A level as big as the original stands in for it (the same pixels or triangles, a smaller file). */
export function pickLod(assetId: string, n: number): { level: number; path: string; mime: string; sha256: string; bytes: number } | null {
  if (!(n > 0)) return null;
  const rows = db.prepare('SELECT level, path, mime, sha256, bytes FROM asset_lods WHERE asset = ? ORDER BY level').all(assetId) as { level: number; path: string; mime: string; sha256: string; bytes: number }[];
  if (!rows.length) return null;
  const s = db.prepare('SELECT width, height, triangles FROM asset_lod_state WHERE asset = ?').get(assetId) as { width: number | null; height: number | null; triangles: number | null } | undefined;
  const full = s ? (s.triangles ?? Math.max(s.width ?? 0, s.height ?? 0)) : 0;
  const fit = rows.filter((r) => r.level <= n);
  const best = fit.length ? fit[fit.length - 1] : rows[0];
  // Asked for more than the biggest level, and the original is bigger than it: the original.
  if (full && n >= full && best.level < full) return null;
  return best;
}

/** Linked lows: low copies that belong to a model (lists leave them out). */
export const isLinkedLow = (id: string) => Boolean(db.prepare('SELECT 1 FROM asset_lod_links WHERE low = ?').get(id));
