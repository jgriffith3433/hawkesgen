// The library: every file Hawkes Gen makes, with the recipe that made it.
//
// Files live in DATA_DIR/library/<yyyy-mm>/<asset id><ext>; the database row
// says who asked (client, project), which tool, the seed, any labels the
// caller attached (fighter: "susan", clip: "jab"), tags and a star, so the
// dashboard can browse work across every project and reuse it elsewhere.
//
// A recipe is everything that decides an output: tool, tool version, params
// and the hashes of the input files. recipe_key hashes it without the seed,
// so "is there a current asset for this?" holds for every take.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { db, parseRow, J } from './db.ts';
import { paths } from './config.ts';
import { id, sha256, kindOf, mimeOf, extOf, stableStringify, GenError } from './util.ts';
import { backup } from './storage.ts';
import { projectScopeSql, canProject, type Client } from './auth.ts';

export type Recipe = {
  tool: string;
  version: number;
  params: Record<string, unknown>;
  /** Input name -> sha256 (or a list for multi-file inputs). */
  inputs: Record<string, string | string[]>;
  models?: string[];
  seed?: number | null;
};

export type Asset = {
  id: string; job: string | null; client: string; project: string; tool: string; kind: string; mime: string;
  path: string; bytes: number; sha256: string; seed: number | null; recipe: Recipe; recipe_key: string;
  labels: Record<string, unknown>; tags: string[]; title: string | null; starred: number; meta: Record<string, unknown>; created: number;
};

const JSON_COLS = ['recipe', 'labels', 'tags', 'meta'];

export function recipeKey(r: Recipe): string {
  const { seed: _seed, ...rest } = r;
  const params = { ...(rest.params ?? {}) };
  delete params.seed;
  return sha256(stableStringify({ ...rest, params }));
}

type NewAsset = {
  mime?: string; ext?: string; job?: string | null; client: string; project: string; tool: string;
  seed?: number | null; recipe: Recipe; labels?: Record<string, unknown>; title?: string; meta?: Record<string, unknown>;
};

/** Where an asset's file goes, and its mime. */
function assetTarget(a: NewAsset) {
  const assetId = id('a', 8);
  const mime = a.mime ?? (a.ext ? mimeOf(`x${a.ext}`) : 'application/octet-stream');
  const ext = a.ext ?? extOf(mime);
  const dir = path.join(paths.library, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  return { assetId, mime, file: path.join(dir, `${assetId}${ext}`) };
}

/** Writes the row for a file that is in the library folder, and queues its backup. */
function insertAsset(a: NewAsset, t: { assetId: string; mime: string; file: string }, bytes: number, hash: string): Asset {
  const recipe = { ...a.recipe, seed: a.seed ?? a.recipe.seed ?? null };
  const row = {
    id: t.assetId, job: a.job ?? null, client: a.client, project: a.project, tool: a.tool, kind: kindOf(t.mime), mime: t.mime,
    path: t.file, bytes, sha256: hash, seed: recipe.seed, recipe: J(recipe), recipe_key: recipeKey(recipe),
    labels: J(a.labels ?? {}), tags: '[]', title: a.title ?? null, starred: 0, meta: J(a.meta ?? {}), created: Date.now(),
  };
  db.prepare(`INSERT INTO assets (id, job, client, project, tool, kind, mime, path, bytes, sha256, seed, recipe, recipe_key, labels, tags, title, starred, meta, created)
              VALUES (:id, :job, :client, :project, :tool, :kind, :mime, :path, :bytes, :sha256, :seed, :recipe, :recipe_key, :labels, :tags, :title, :starred, :meta, :created)`).run(row);
  // Also to S3 (in the background), so the library survives this disk (src/storage.ts).
  backup({ sha256: row.sha256, path: t.file, bytes: row.bytes, mime: t.mime });
  return getAsset(t.assetId)!;
}

export function putAsset(a: NewAsset & { data: Buffer }): Asset {
  const t = assetTarget(a);
  fs.writeFileSync(t.file, a.data);
  return insertAsset(a, t, a.data.length, sha256(a.data));
}

/**
 * Keeps a file that is already on this disk as an asset by streaming it into the library (hashing as it goes), so a
 * build output of a gigabyte never sits in memory (a 4 GiB Cloud Run instance died reading one whole, 2026-11-04).
 */
export async function putAssetFile(a: NewAsset & { file: string }): Promise<Asset> {
  const t = assetTarget(a);
  const hash = crypto.createHash('sha256');
  const src = fs.createReadStream(a.file);
  src.on('data', (c) => hash.update(c));
  try {
    await pipeline(src, fs.createWriteStream(t.file));
  } catch (e) {
    fs.rmSync(t.file, { force: true });
    throw e;
  }
  return insertAsset(a, t, fs.statSync(t.file).size, hash.digest('hex'));
}

/** Keeps an uploaded temp file (already hashed, see src/uploads.ts) as an asset by moving it into the library: nothing is read into memory. */
export function putAssetUpload(a: NewAsset & { file: string; sha256: string; bytes: number }): Asset {
  const t = assetTarget(a);
  moveFile(a.file, t.file);
  return insertAsset(a, t, a.bytes, a.sha256);
}

/** Keeps an uploaded temp file as a blob by its hash (the file is removed when the blob is already there). */
export function putBlobUpload(file: string, hash: string, ext = ''): string {
  const dest = path.join(paths.blobs, hash.slice(0, 2), `${hash}${ext}`);
  if (fs.existsSync(dest)) fs.rmSync(file, { force: true });
  else { fs.mkdirSync(path.dirname(dest), { recursive: true }); moveFile(file, dest); }
  return hash;
}

function moveFile(from: string, to: string) {
  try { fs.renameSync(from, to); } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to); fs.rmSync(from, { force: true });
  }
}

export function getAsset(assetId: string): Asset | null {
  return parseRow<Asset>(db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId), JSON_COLS) ?? null;
}

export function listAssets(q: { project?: string; kind?: string; tool?: string; client?: string; text?: string; starred?: boolean; job?: string; playtest?: boolean; limit?: number; offset?: number; projects?: string[] } = {}) {
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  if (q.project) { where.push('project = :project'); args.project = q.project; }
  if (q.kind) {
    if (q.kind === 'shot' || q.kind === 'screenshots') where.push("(kind = 'image' OR json_extract(meta, '$.playtest') IN ('shot', 'diff'))");
    else if (q.kind === 'report') where.push("(kind = 'text' OR json_extract(meta, '$.playtest') = 'report')");
    else { where.push('kind = :kind'); args.kind = q.kind; }
  }
  if (q.tool) { where.push('tool = :tool'); args.tool = q.tool; }
  if (q.client) { where.push('client = :client'); args.client = q.client; }
  if (q.job) { where.push('job = :job'); args.job = q.job; }
  if (q.playtest) {
    where.push("(tool = 'playtest.run' OR json_extract(meta, '$.playtest') IS NOT NULL)");
  } else if (q.tool !== 'playtest.run' && !q.job) {
    where.push("(tool != 'playtest.run' AND json_extract(meta, '$.playtest') IS NULL)");
  }
  if (q.starred) where.push('starred = 1');
  if (q.text) { where.push('(title LIKE :text OR labels LIKE :text OR tags LIKE :text OR recipe LIKE :text)'); args.text = `%${q.text}%`; }
  if (q.projects) { const scope = projectScopeSql(q.projects); if (scope) where.push(scope); }
  // A low copy a job made beside its model belongs to the model (src/lod.ts): it isn't listed on its own.
  if (!q.job) where.push('id NOT IN (SELECT low FROM asset_lod_links)');
  const sql = `FROM assets ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const limit = Math.max(1, Math.min(500, q.limit ?? 60));
  const items = db.prepare(`SELECT * ${sql} ORDER BY created DESC LIMIT ${limit} OFFSET ${Math.max(0, q.offset ?? 0)}`).all(args as any).map((r) => parseRow<Asset>(r, JSON_COLS));
  const total = (db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(args as any) as { n: number }).n;
  return { items, total };
}

export function updateAsset(assetId: string, patch: { title?: string | null; tags?: string[]; starred?: boolean; labels?: Record<string, unknown> }) {
  const a = getAsset(assetId);
  if (!a) throw new GenError('No such asset', { status: 404 });
  db.prepare('UPDATE assets SET title = ?, tags = ?, starred = ?, labels = ? WHERE id = ?').run(
    patch.title !== undefined ? patch.title : a.title,
    J(patch.tags ?? a.tags),
    patch.starred !== undefined ? (patch.starred ? 1 : 0) : a.starred,
    J(patch.labels ?? a.labels),
    assetId,
  );
  return getAsset(assetId)!;
}

/** Removes an asset and its file. The dashboard asks first. */
export function deleteAsset(assetId: string) {
  const a = getAsset(assetId);
  if (!a) return false;
  fs.rmSync(a.path, { force: true });
  // Its levels of detail go with it (the rows by the foreign key; the files here).
  for (const l of db.prepare('SELECT path FROM asset_lods WHERE asset = ?').all(assetId) as { path: string }[]) fs.rmSync(l.path, { force: true });
  db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
  return true;
}

/** The newest asset made from this recipe (any seed). */
export function findByRecipe(key: string, project?: string, projects: string[] = ['*']): Asset | null {
  // `projects` limits the search to what the caller may see (a customer never finds another customer's asset).
  const scope = projectScopeSql(projects);
  const row = project
    ? db.prepare('SELECT * FROM assets WHERE recipe_key = ? AND project = ? ORDER BY created DESC LIMIT 1').get(key, project)
    : db.prepare(`SELECT * FROM assets WHERE recipe_key = ?${scope ? ` AND ${scope}` : ''} ORDER BY created DESC LIMIT 1`).get(key);
  return parseRow<Asset>(row, JSON_COLS) ?? null;
}

/** Every asset made from this recipe (any seed) in a project, oldest first: the takes already paid for. */
export function findAllByRecipe(key: string, project: string): Asset[] {
  return (db.prepare('SELECT * FROM assets WHERE recipe_key = ? AND project = ? ORDER BY created ASC').all(key, project) as any[]).map((r) => parseRow<Asset>(r, JSON_COLS)!);
}

// ------------------------------------------------------------------ blobs
// Uploaded input files, stored by content. A caller on another machine
// uploads once (POST /v1/blobs) and refers to "blob:<sha256>".

export function putBlob(data: Buffer, ext = ''): string {
  const hash = sha256(data);
  const file = path.join(paths.blobs, hash.slice(0, 2), `${hash}${ext}`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  return hash;
}

// Who uploaded a blob. Files are stored once by content, but a customer may only use a blob it uploaded itself (or one
// behind an asset it can see): knowing a hash is not access. A row per uploader: the key's id, and its one project when
// the key works in one (the portal narrows its key to a customer per call).
db.exec(`CREATE TABLE IF NOT EXISTS blob_owners (sha TEXT NOT NULL, client TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, PRIMARY KEY (sha, client, project))`);

const oneProject = (c: Pick<Client, 'projects'>) => (c.projects.length === 1 && !c.projects[0].includes('*') ? c.projects[0] : '');

export function ownBlob(hash: string, client: Pick<Client, 'id' | 'projects'>) {
  db.prepare('INSERT OR IGNORE INTO blob_owners (sha, client, project, created) VALUES (?, ?, ?, ?)').run(hash, client.id, oneProject(client), Date.now());
}

/** Whether this caller may use blob:<hash>: every project's keys may; others only blobs they uploaded or that back an asset they can see. */
export function canUseBlob(client: Client, hash: string): boolean {
  if (client.projects.includes('*')) return true;
  const rows = db.prepare('SELECT client, project FROM blob_owners WHERE sha = ?').all(hash) as { client: string; project: string }[];
  if (rows.some((r) => (r.client === client.id && (!r.project || canProject(client, r.project))) || (r.project && canProject(client, r.project)))) return true;
  const scope = projectScopeSql(client.projects);
  return Boolean(db.prepare(`SELECT 1 FROM assets WHERE sha256 = ?${scope ? ` AND ${scope}` : ''} LIMIT 1`).get(hash));
}

// Blobs whose bytes are in the library bucket (sha256/<hash>, the same key an asset with those bytes has): big uploads
// that went straight there (POST /v1/blobs/upload, src/bigupload.ts). Any instance may not have them on disk yet:
// blobPath answers where the file goes, and storage.ts ensureBlob / ensureInputs fetch it before it is read.
db.exec(`CREATE TABLE IF NOT EXISTS blob_remote (sha TEXT PRIMARY KEY, ext TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL, created INTEGER NOT NULL)`);

/** Records that blob:<hash> is in the bucket (with the extension its local copy gets). */
export function putBlobRemote(hash: string, ext: string, bytes: number) {
  db.prepare('INSERT OR IGNORE INTO blob_remote (sha, ext, bytes, created) VALUES (?, ?, ?, ?)').run(hash, ext, bytes, Date.now());
}
export function blobRemote(hash: string): { ext: string; bytes: number } | null {
  return (db.prepare('SELECT ext, bytes FROM blob_remote WHERE sha = ?').get(hash) as { ext: string; bytes: number } | undefined) ?? null;
}
/** The sha a local blob file is named by, or null when the path isn't a blob's. */
export function blobShaOf(file: string): string | null {
  if (path.resolve(path.dirname(path.dirname(file))) !== path.resolve(paths.blobs)) return null;
  return /^([0-9a-f]{64})/.exec(path.basename(file))?.[1] ?? null;
}

/** The blob's local file: on disk, or (for one only in the bucket) where it will be once fetched. Null when Gen has no such blob. */
export function blobPath(hash: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const dir = path.join(paths.blobs, hash.slice(0, 2));
  const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.startsWith(hash) && !n.endsWith('.part')) : undefined;
  if (f) return path.join(dir, f);
  const r = blobRemote(hash);
  return r ? path.join(dir, `${hash}${r.ext}`) : null;
}
