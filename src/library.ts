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
import path from 'node:path';
import { db, parseRow, J } from './db.ts';
import { paths } from './config.ts';
import { id, sha256, kindOf, mimeOf, extOf, stableStringify, GenError } from './util.ts';
import { backup } from './storage.ts';
import { projectScopeSql } from './auth.ts';

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

export function putAsset(a: {
  data: Buffer; mime?: string; ext?: string; job?: string | null; client: string; project: string; tool: string;
  seed?: number | null; recipe: Recipe; labels?: Record<string, unknown>; title?: string; meta?: Record<string, unknown>;
}): Asset {
  const assetId = id('a', 8);
  const mime = a.mime ?? (a.ext ? mimeOf(`x${a.ext}`) : 'application/octet-stream');
  const ext = a.ext ?? extOf(mime);
  const month = new Date().toISOString().slice(0, 7);
  const dir = path.join(paths.library, month);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${assetId}${ext}`);
  fs.writeFileSync(file, a.data);
  const recipe = { ...a.recipe, seed: a.seed ?? a.recipe.seed ?? null };
  const row = {
    id: assetId, job: a.job ?? null, client: a.client, project: a.project, tool: a.tool, kind: kindOf(mime), mime,
    path: file, bytes: a.data.length, sha256: sha256(a.data), seed: recipe.seed, recipe: J(recipe), recipe_key: recipeKey(recipe),
    labels: J(a.labels ?? {}), tags: '[]', title: a.title ?? null, starred: 0, meta: J(a.meta ?? {}), created: Date.now(),
  };
  db.prepare(`INSERT INTO assets (id, job, client, project, tool, kind, mime, path, bytes, sha256, seed, recipe, recipe_key, labels, tags, title, starred, meta, created)
              VALUES (:id, :job, :client, :project, :tool, :kind, :mime, :path, :bytes, :sha256, :seed, :recipe, :recipe_key, :labels, :tags, :title, :starred, :meta, :created)`).run(row);
  // Also to S3 (in the background), so the library survives this disk (src/storage.ts).
  backup({ sha256: row.sha256, path: file, bytes: row.bytes });
  return getAsset(assetId)!;
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
  db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
  return true;
}

/** The newest asset made from this recipe (any seed). */
export function findByRecipe(key: string, project?: string): Asset | null {
  const row = project
    ? db.prepare('SELECT * FROM assets WHERE recipe_key = ? AND project = ? ORDER BY created DESC LIMIT 1').get(key, project)
    : db.prepare('SELECT * FROM assets WHERE recipe_key = ? ORDER BY created DESC LIMIT 1').get(key);
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

export function blobPath(hash: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const dir = path.join(paths.blobs, hash.slice(0, 2));
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => n.startsWith(hash));
  return f ? path.join(dir, f) : null;
}
