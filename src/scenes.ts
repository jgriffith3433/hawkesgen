// Scenes: every document a person makes in the Gen app, of any kind, in one store (J, 2026-10-29: "put in the idea of
// scenes and make them plug and play with each other ... the edit tab shouldn't just be about videos. It should be able
// to edit any kind of scene"). A kind decides what its document is and how it's checked:
//   video      a timeline (src/editor.ts): clips, text, music, voice, sound
//   stage      a 3D shot (src/director.ts): cast, props, set, camera, lines, how it's filmed
//   image      a timeline whose frame at the playhead is the picture (src/timeline.ts): tracks as layers
//   audio      a timeline of sound (src/timeline.ts): tracks with volume, pan, mute and solo; export is the mixdown
//   character  a person or creature (src/scenekinds.ts): look, voice, height, 3D model, references, clips
//   world, place, prop, story   the layer above scenes (src/worldkinds.ts): a world's bible and look, its places, props
//              and stories. Any scene may name its world with `doc.world` (kept here for every kind).
// Scenes plug into each other: a scene's document can name others (a stage cast member is a character scene, a video
// clip is a filmed stage or a rendered image, an audio clip is another audio scene's mixdown); `uses` lists them, and a
// scene's `render` is its latest output (the film, the picture, the mixdown) that the scenes using it play.
//
// The kinds register themselves (registerKind) so this store never imports them. The editor's and director's own routes
// (/v1/editor/projects, /v1/director/shots) are views onto this store; their ids (ep_, sh_) are kept, new scenes are sn_.

import crypto from 'node:crypto';
import { db } from './db.ts';
import { GenError } from './util.ts';
import { getJob } from './jobs.ts';

export const KIND_IDS = ['video', 'stage', 'image', 'audio', 'character', 'world', 'place', 'prop', 'story'] as const;
export type Kind = typeof KIND_IDS[number];

export type Render = { asset: string; kind: 'video' | 'image' | 'audio' | 'mesh'; version: number; at: number };
export type KindDef = {
  /** The document checked and kept in range. */
  normalize(doc: any): any;
  /** A new, empty document. */
  blank(title: string): any;
  /** Fills in finished jobs (waiting elements); true when the document changed. */
  resolve?(doc: any, jobOf: (id: string) => ReturnType<typeof getJob>): boolean;
  /** The scenes this document uses (by id). */
  uses?(doc: any): string[];
  /** The elements that can hold a file (the AI's `gen` marks and `el:` inputs: src/sceneai.ts applyScene). */
  elements?(doc: any): any[];
};

const KINDS = new Map<Kind, KindDef>();
export function registerKind(kind: Kind, def: KindDef) {
  // Every kind keeps the world it belongs to (src/worlds.ts worldOf), whatever its own normalize knows.
  const own = def.normalize;
  KINDS.set(kind, { ...def, normalize: (doc: any) => {
    const n = own(doc);
    const w = sceneRef(doc?.world);
    if (n && typeof n === 'object') { if (w) n.world = w; else delete n.world; }
    return n;
  } });
}
export function kindOf(kind: string): KindDef {
  const d = KINDS.get(kind as Kind);
  if (!d) throw new GenError(`No kind of scene "${kind}"`, { status: 400 });
  return d;
}

db.exec(`
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  doc TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scenes_project ON scenes (project, kind, updated DESC);
CREATE TABLE IF NOT EXISTS scene_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL);
`);

/** Once: the editor's projects (live since 2026-10-29) and the director's shots come into the store, ids kept. */
function migrate(name: string, table: string, kind: Kind) {
  if (db.prepare('SELECT 1 FROM scene_migrations WHERE name = ?').get(name)) return;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (exists) {
    db.prepare(`INSERT OR IGNORE INTO scenes (id, project, kind, title, doc, version, created, updated)
                SELECT id, project, ?, title, doc, version, created, updated FROM ${table}`).run(kind);
  }
  db.prepare('INSERT INTO scene_migrations (name, at) VALUES (?, ?)').run(name, Date.now());
}
migrate('editor_projects', 'editor_projects', 'video');
migrate('director_shots', 'director_shots', 'stage');

type Row = { id: string; project: string; kind: Kind; title: string; doc: string; version: number; created: number; updated: number };
export type Scene<D = any> = { id: string; project: string; kind: Kind; title: string; doc: D; version: number; created: number; updated: number };
const titleOf = (d: any) => String(d?.title ?? d?.name ?? 'Untitled').slice(0, 120) || 'Untitled';
const fromRow = (r: Row): Scene => ({ ...r, doc: kindOf(r.kind).normalize(JSON.parse(r.doc)) });
const rowOf = (id: string) => db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as Row | undefined;

export type SceneSummary = { id: string; kind: Kind; title: string; version: number; created: number; updated: number; render: Render | null };

/** A project's scenes, newest first; of one kind, or every kind. */
export function listScenes(project: string, kind?: string | null, limit = 200): SceneSummary[] {
  const rows = (kind
    ? db.prepare(`SELECT id, kind, title, version, created, updated, json_extract(doc, '$.render') AS render FROM scenes WHERE project = ? AND kind = ? ORDER BY updated DESC LIMIT ?`).all(project, kind, limit)
    : db.prepare(`SELECT id, kind, title, version, created, updated, json_extract(doc, '$.render') AS render FROM scenes WHERE project = ? ORDER BY updated DESC LIMIT ?`).all(project, limit)) as any[];
  return rows.map((r) => ({ ...r, render: r.render ? JSON.parse(r.render) : null }));
}

export function createScene(project: string, kind: Kind, doc?: unknown, prefix = 'sn'): Scene {
  const k = kindOf(kind);
  const d = k.normalize(doc ?? k.blank('Untitled'));
  const id = `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
  const now = Date.now();
  db.prepare('INSERT INTO scenes (id, project, kind, title, doc, version, created, updated) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(id, project, kind, titleOf(d), JSON.stringify(d), now, now);
  return { id, project, kind, title: titleOf(d), doc: d, version: 1, created: now, updated: now };
}

/** One scene, with any finished jobs filled in (and saved, so every reader sees the same). `canSee` checks the caller; `kind` insists on one. */
export function getScene(id: string, canSee: (project: string) => boolean, kind?: Kind): Scene {
  const r = rowOf(id);
  if (!r || !canSee(r.project) || (kind && r.kind !== kind)) throw new GenError('No such scene', { status: 404 });
  const s = fromRow(r);
  if (kindOf(s.kind).resolve?.(s.doc, getJob)) return saveScene(s, s.doc);
  return s;
}

/** Saves a scene's document. With `version`, refuses when someone else saved in between (409, with the newer scene). */
export function saveScene(s: Scene, doc: unknown, version?: number): Scene {
  const d = kindOf(s.kind).normalize(doc);
  const now = Date.now();
  const r = version != null
    ? db.prepare('UPDATE scenes SET doc = ?, title = ?, version = version + 1, updated = ? WHERE id = ? AND version = ?').run(JSON.stringify(d), titleOf(d), now, s.id, version)
    : db.prepare('UPDATE scenes SET doc = ?, title = ?, version = version + 1, updated = ? WHERE id = ?').run(JSON.stringify(d), titleOf(d), now, s.id);
  if (!r.changes) {
    const cur = rowOf(s.id);
    if (!cur) throw new GenError('No such scene', { status: 404 });
    throw Object.assign(new GenError('This scene changed somewhere else', { status: 409 }), { scene: fromRow(cur) });
  }
  return fromRow(rowOf(s.id)!);
}

export function deleteScene(id: string, canSee: (project: string) => boolean, kind?: Kind) {
  const r = rowOf(id);
  if (!r || !canSee(r.project) || (kind && r.kind !== kind)) throw new GenError('No such scene', { status: 404 });
  db.prepare('DELETE FROM scenes WHERE id = ?').run(id);
}

/** Records a scene's latest output (its film, picture or mixdown), for the scenes that use it. */
export function setRender(s: Scene, render: { asset: string; kind: Render['kind'] }): Scene {
  if (!/^a_[0-9a-f]{6,40}$/.test(render.asset)) throw new GenError('render: an asset id', { status: 400 });
  if (!['video', 'image', 'audio', 'mesh'].includes(render.kind)) throw new GenError('render: kind video, image, audio or mesh', { status: 400 });
  return saveScene(s, { ...s.doc, render: { asset: render.asset, kind: render.kind, version: s.version + 1, at: Date.now() } });
}

/** The scenes a scene uses, as summaries (the caller's own only): what plugs in, and whether it changed since. */
export function usedBy(s: Scene, canSee: (project: string) => boolean): SceneSummary[] {
  const ids = [...new Set(kindOf(s.kind).uses?.(s.doc) ?? [])].slice(0, 100);
  const out: SceneSummary[] = [];
  for (const id of ids) {
    const r = db.prepare(`SELECT id, project, kind, title, version, created, updated, json_extract(doc, '$.render') AS render FROM scenes WHERE id = ?`).get(id) as any;
    if (r && canSee(r.project)) out.push({ id: r.id, kind: r.kind, title: r.title, version: r.version, created: r.created, updated: r.updated, render: r.render ? JSON.parse(r.render) : null });
  }
  return out;
}

/** A scene id as documents name it. */
export const SCENE_ID = /^(sn|ep|sh)_[0-9a-f]{6,24}$/;
export const sceneRef = (v: unknown) => (typeof v === 'string' && SCENE_ID.test(v) ? v : null);
