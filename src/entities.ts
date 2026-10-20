// The library's structure: what every product's tools (level editors, dev tools, Unity windows, Studio, agents) build
// on, so a concept edited in one place is the same thing everywhere.
//
//   entity   a thing a product cares about: "doseofdestruction/break" (a fighter), "phorigins/lobby" (a set),
//            "hawkesvideo/tower-walk-01" (a shot). It has a kind, a name and data (canon, look, any spec the
//            product keeps: { canon, look, slots: { side: { brief, make } } }).
//   slot     a named role on an entity: concept, reference, side, pose/air, clip/jab, model, animation/walk, voice/hi.
//   version  one file in a slot (a library asset), numbered per slot: a take (a candidate), current (the one in use:
//            at most one per slot), old (was current) or discarded. It keeps a note (feedback) and what it was made
//            from (made_from: the slot versions and assets a job used).
//
// Slot references work anywhere a job takes a file or a param: "slot:doseofdestruction/break/side" is that slot's
// current version (also @3 for version 3, @latest for the newest take). Inside an entity's own recipes "slot:./side"
// means the same entity. A job made for a slot (labels { entity, slot }) files its outputs there as takes when it
// ends, so "make", "revise" and best-of-N all land where the editor is looking.

import { db, parseRow, J } from './db.ts';
import { events } from './bus.ts';
import { getAsset, type Asset } from './library.ts';
import { canProject, type Client } from './auth.ts';
import { getProjectPresets } from './presets.ts';
import { id as newId, GenError } from './util.ts';

export type Entity = {
  id: string; project: string; slug: string; kind: string; name: string;
  data: Record<string, any>; tags: string[]; archived: number; created: number; updated: number;
};
export type VersionStatus = 'take' | 'current' | 'old' | 'discarded';
export type Version = {
  id: string; entity: string; slot: string; n: number; asset: string; status: VersionStatus; note: string; by: string;
  job: string | null; made_from: MadeFrom[]; created: number; updated: number;
};
export type MadeFrom = { ref?: string; entity?: string; slot?: string; version?: string; n?: number; asset: string };

const STATUSES: VersionStatus[] = ['take', 'current', 'old', 'discarded'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLOT = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*){0,3}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export const toSlug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

function emit(type: string, entity: string, extra: Record<string, unknown> = {}) {
  events.emit('library', { type, entity, at: Date.now(), ...extra });
}

// ------------------------------------------------------------------ entities

export function getEntityRow(entityId: string): Entity | null {
  return parseRow<Entity>(db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId), ['data', 'tags']) ?? null;
}

function mustEntity(client: Client | null, entityId: string): Entity {
  const e = getEntityRow(entityId);
  if (!e || (client && !canProject(client, e.project))) throw new GenError(`No entity ${entityId}`, { status: 404 });
  return e;
}

export function createEntity(client: Client, b: { project: string; slug?: string; name: string; kind: string; data?: Record<string, any>; tags?: string[]; upsert?: boolean }) {
  const project = String(b.project ?? '');
  if (!PROJECT.test(project)) throw new GenError('project is required');
  if (!canProject(client, project)) throw new GenError(`No access to project ${project}`, { status: 403 });
  const name = String(b.name ?? '').trim();
  if (!name) throw new GenError('name is required');
  const slug = b.slug ? String(b.slug) : toSlug(name);
  if (!SLUG.test(slug)) throw new GenError('slug is lowercase words and dashes');
  const kind = toSlug(b.kind ?? '');
  if (!kind) throw new GenError('kind is required (character, stage, prop, shot...)');
  const entityId = `${project}/${slug}`;
  const existing = getEntityRow(entityId);
  if (existing) {
    if (!b.upsert) throw new GenError(`${entityId} already exists`, { status: 409 });
    return updateEntity(client, entityId, { name, kind, data: b.data, tags: b.tags });
  }
  const now = Date.now();
  db.prepare('INSERT INTO entities (id, project, slug, kind, name, data, tags, archived, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(entityId, project, slug, kind, name, J(b.data ?? {}), J(b.tags ?? []), now, now);
  emit('entity', entityId, { change: 'created' });
  return getEntity(client, entityId);
}

/** Changes an entity. data is merged one level deep (data.slots too), so editors can set one field. */
export function updateEntity(client: Client, entityId: string, patch: { name?: string; kind?: string; data?: Record<string, any>; tags?: string[]; archived?: boolean }) {
  const e = mustEntity(client, entityId);
  const data = { ...e.data };
  for (const [k, v] of Object.entries(patch.data ?? {})) {
    if (v === null) delete data[k];
    else if (k === 'slots' && v && typeof v === 'object') data.slots = { ...(data.slots ?? {}), ...v };
    else data[k] = v;
  }
  db.prepare('UPDATE entities SET name = ?, kind = ?, data = ?, tags = ?, archived = ?, updated = ? WHERE id = ?').run(
    patch.name?.trim() || e.name, patch.kind ? toSlug(patch.kind) : e.kind, J(data), J(patch.tags ?? e.tags),
    patch.archived === undefined ? e.archived : patch.archived ? 1 : 0, Date.now(), entityId,
  );
  emit('entity', entityId, { change: 'updated' });
  return getEntity(client, entityId);
}

/**
 * The slots of an entity: for each, its current version, the newest take and counts. waiting: the takes nobody has
 * looked at since the pick (made after the current version became current), or every take while nothing is picked.
 */
function slotSummary(entityId: string) {
  const rows = db.prepare('SELECT * FROM versions WHERE entity = ? ORDER BY slot, n').all(entityId).map((r) => parseRow<Version>(r, ['made_from']));
  const slots: Record<string, { current: ReturnType<typeof versionView> | null; latest: ReturnType<typeof versionView> | null; takes: number; waiting: number; versions: number; updated: number }> = {};
  const picked: Record<string, number> = {};
  for (const v of rows) if (v.status === 'current') picked[v.slot] = v.updated;
  for (const v of rows) {
    const s = (slots[v.slot] ??= { current: null, latest: null, takes: 0, waiting: 0, versions: 0, updated: 0 });
    s.versions++;
    if (v.status === 'take') {
      s.takes++;
      if (picked[v.slot] === undefined || v.created > picked[v.slot]) s.waiting++;
    }
    if (v.status === 'current') s.current = versionView(v);
    if (v.status !== 'discarded') s.latest = versionView(v);
    s.updated = Math.max(s.updated, v.updated);
  }
  return slots;
}

export function getEntity(client: Client | null, entityId: string) {
  const e = mustEntity(client, entityId);
  return { ...e, slots: slotSummary(entityId) };
}

export function listEntities(client: Client, q: { project?: string; kind?: string; text?: string; tag?: string; archived?: boolean; limit?: number; offset?: number } = {}) {
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  if (q.project) {
    if (!canProject(client, q.project)) throw new GenError(`No access to project ${q.project}`, { status: 403 });
    where.push('project = :project');
    args.project = q.project;
  }
  if (q.kind) { where.push('kind = :kind'); args.kind = q.kind; }
  if (q.text) { where.push('(name LIKE :text OR slug LIKE :text OR data LIKE :text OR tags LIKE :text)'); args.text = `%${q.text}%`; }
  if (q.tag) { where.push('tags LIKE :tag'); args.tag = `%"${q.tag}"%`; }
  if (!q.archived) where.push('archived = 0');
  if (!client.projects.includes('*')) where.push(`project IN (${client.projects.map((p) => `'${p.replace(/'/g, "''")}'`).join(',') || "''"})`);
  const sql = `FROM entities ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const limit = Math.max(1, Math.min(500, q.limit ?? 100));
  const rows = db.prepare(`SELECT * ${sql} ORDER BY project, kind, name LIMIT ${limit} OFFSET ${Math.max(0, q.offset ?? 0)}`).all(args as any).map((r) => parseRow<Entity>(r, ['data', 'tags']));
  const total = (db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(args as any) as { n: number }).n;
  return { items: rows.map((e) => ({ ...e, slots: slotSummary(e.id) })), total };
}

// ------------------------------------------------------------------ versions

/** A version as the API shows it: with its asset's file facts, what made it and the job's prompt. */
export function versionView(v: Version) {
  const a = getAsset(v.asset);
  return {
    ...v,
    file: a ? { kind: a.kind, mime: a.mime, bytes: a.bytes, sha256: a.sha256, title: a.title, tool: a.tool, url: `/v1/files/${a.id}`, prompt: (a.recipe?.params as any)?.prompt ?? null, seed: a.seed } : null,
  };
}

function getVersionRow(versionId: string): Version | null {
  return parseRow<Version>(db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId), ['made_from']) ?? null;
}

export function slotHistory(client: Client, entityId: string, slot: string, { discarded = true } = {}) {
  mustEntity(client, entityId);
  const rows = db.prepare(`SELECT * FROM versions WHERE entity = ? AND slot = ? ${discarded ? '' : "AND status != 'discarded'"} ORDER BY n DESC`).all(entityId, slot).map((r) => parseRow<Version>(r, ['made_from']));
  return { entity: entityId, slot, versions: rows.map(versionView) };
}

/** Files an asset into a slot. status "current" makes it the one in use (the old current becomes old). */
export function addVersion(client: Client | null, b: { entity: string; slot: string; asset: string; status?: VersionStatus; note?: string; by?: string; job?: string | null; madeFrom?: MadeFrom[] }) {
  const e = mustEntity(client, b.entity);
  const slot = String(b.slot ?? '');
  if (!SLOT.test(slot)) throw new GenError('slot is lowercase words, dashes and up to three slashes (pose/air)');
  const a = getAsset(String(b.asset ?? '').replace(/^asset:/, ''));
  if (!a) throw new GenError(`No asset ${b.asset}`, { status: 404 });
  if (client && !canProject(client, a.project)) throw new GenError(`No access to asset ${a.id}`, { status: 403 });
  const status: VersionStatus = b.status ?? 'take';
  if (!STATUSES.includes(status)) throw new GenError(`status is ${STATUSES.join(', ')}`);
  const now = Date.now();
  const versionId = newId('v', 6);
  db.exec('BEGIN');
  try {
    const n = ((db.prepare('SELECT MAX(n) AS n FROM versions WHERE entity = ? AND slot = ?').get(e.id, slot) as { n: number | null }).n ?? 0) + 1;
    if (status === 'current') db.prepare("UPDATE versions SET status = 'old', updated = ? WHERE entity = ? AND slot = ? AND status = 'current'").run(now, e.id, slot);
    db.prepare('INSERT INTO versions (id, entity, slot, n, asset, status, note, by, job, made_from, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(versionId, e.id, slot, n, a.id, status, b.note ?? '', b.by ?? client?.name ?? '', b.job ?? a.job ?? null, J(b.madeFrom ?? []), now, now);
    db.prepare('UPDATE entities SET updated = ? WHERE id = ?').run(now, e.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  emit('version', e.id, { slot, version: versionId, status });
  return versionView(getVersionRow(versionId)!);
}

/** Pick (current), back to take, old or discard; and/or change the note. */
export function updateVersion(client: Client, versionId: string, patch: { status?: VersionStatus; note?: string }) {
  const v = getVersionRow(versionId);
  if (!v) throw new GenError(`No version ${versionId}`, { status: 404 });
  mustEntity(client, v.entity);
  const now = Date.now();
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new GenError(`status is ${STATUSES.join(', ')}`);
    db.exec('BEGIN');
    try {
      if (patch.status === 'current') db.prepare("UPDATE versions SET status = 'old', updated = ? WHERE entity = ? AND slot = ? AND status = 'current' AND id != ?").run(now, v.entity, v.slot, v.id);
      db.prepare('UPDATE versions SET status = ?, updated = ? WHERE id = ?').run(patch.status, now, v.id);
      db.prepare('UPDATE entities SET updated = ? WHERE id = ?').run(now, v.entity);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  if (patch.note !== undefined) db.prepare('UPDATE versions SET note = ?, updated = ? WHERE id = ?').run(String(patch.note).slice(0, 4000), now, v.id);
  emit('version', v.entity, { slot: v.slot, version: v.id, status: patch.status ?? v.status });
  return versionView(getVersionRow(v.id)!);
}

// ------------------------------------------------------------------ slot references

/** "slot:<project>/<slug>/<slot>[@n|@current|@latest]" -> the version it means. `self` is the entity "./" refers to. */
export function resolveSlotRef(client: Client | null, ref: string, self?: string): { version: Version; asset: Asset } {
  const m = /^slot:(.+?)(?:@(\d+|current|latest))?$/.exec(ref);
  if (!m) throw new GenError(`Bad slot reference ${ref}`);
  let body = m[1];
  if (body.startsWith('./')) {
    if (!self) throw new GenError(`${ref}: "./" only works inside an entity's own recipe`);
    body = `${self}/${body.slice(2)}`;
  }
  const parts = body.split('/');
  if (parts.length < 3) throw new GenError(`${ref}: give project/entity/slot`);
  const entityId = `${parts[0]}/${parts[1]}`;
  const slot = parts.slice(2).join('/');
  mustEntity(client, entityId);
  const which = m[2] ?? 'current';
  const row = which === 'current'
    ? db.prepare("SELECT * FROM versions WHERE entity = ? AND slot = ? AND status = 'current'").get(entityId, slot)
    : which === 'latest'
      ? db.prepare("SELECT * FROM versions WHERE entity = ? AND slot = ? AND status != 'discarded' ORDER BY n DESC LIMIT 1").get(entityId, slot)
      : db.prepare('SELECT * FROM versions WHERE entity = ? AND slot = ? AND n = ?').get(entityId, slot, Number(which));
  const v = parseRow<Version>(row, ['made_from']);
  if (!v) throw new GenError(which === 'current' ? `${entityId} has no current ${slot} (pick a take first)` : `${entityId} has no ${slot} version ${which}`, { status: 404 });
  const asset = getAsset(v.asset);
  if (!asset) throw new GenError(`${ref}: its file is gone`, { status: 404 });
  return { version: v, asset };
}

/**
 * Replaces every slot reference in a job's params and inputs (deeply: asset.make steps too) with the asset it means
 * now, so the job's recipe follows the slot: change the current side view and everything made from it reads as out
 * of date. Returns what was used, for the outputs' made_from.
 */
export function expandSlotRefs<T>(client: Client | null, value: T, self?: string): { value: T; used: MadeFrom[] } {
  const used: MadeFrom[] = [];
  const walk = (v: any): any => {
    if (typeof v === 'string' && v.startsWith('slot:')) {
      const { version, asset } = resolveSlotRef(client, v, self);
      used.push({ ref: v, entity: version.entity, slot: version.slot, version: version.id, n: version.n, asset: asset.id });
      return `asset:${asset.id}`;
    }
    if (typeof v === 'string' && /^\$step\d+:|^\$prev:|^\$input:/.test(v)) return v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), used };
}

// ------------------------------------------------------------------ making things for a slot

export type MakeSpec = {
  tool?: string; preset?: string; params?: Record<string, any>; inputs?: Record<string, any>;
  /** A chain (asset.make): its steps, candidates, pick, pickAt; `saves` maps a step's save name to a slot. */
  steps?: any[]; candidates?: number; pick?: string; pickAt?: number; saves?: Record<string, string>;
  /** Input indexes shown to Claude as on-model references when picking candidates (asset.make `refs`). */
  refs?: number[];
};

/** How a slot is made, from the request, else the entity's data.slots, else the project's kinds (presets file). */
export function makeSpecFor(e: Entity, slot: string, given?: MakeSpec | null): MakeSpec | null {
  if (given && (given.tool || given.preset || given.steps)) return given;
  const own = e.data?.slots?.[slot]?.make;
  if (own) return { ...own, ...(given ?? {}) };
  const kinds = (getProjectPresets(e.project) as any)?.kinds ?? {};
  const slots = kinds[e.kind]?.slots ?? {};
  const hit = slots[slot] ?? Object.entries<any>(slots).find(([pat]) => pat.endsWith('/*') && slot.startsWith(pat.slice(0, -1)))?.[1];
  if (!hit) return null;
  // character3d robots: data.form=robot uses makeRobot (template rig) instead of mesh.rig.
  const form = String(e.data?.form ?? 'humanoid').toLowerCase();
  const make = form === 'robot' && hit.makeRobot ? hit.makeRobot : hit.make;
  return make ? { ...make, ...(given ?? {}) } : null;
}

/** Fills {name}, {canon}, {look}, {brief}, {feedback}, {style}, {slot}, {part} (the slot's last word) in a recipe. */
export function fillTemplate<T>(value: T, vars: Record<string, string>): T {
  const walk = (v: any): any => {
    if (typeof v === 'string') return v.includes('{') ? v.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all)).replace(/\s{2,}/g, ' ').trim() : v;
    if (Array.isArray(v)) return v.map(walk);
    // Keys too: a recipe's saves map titles like "preview/{part}" to slots.
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k), walk(x)]));
    return v;
  };
  return walk(value);
}

/**
 * The job spec that makes something for a slot (the caller submits it). Its outputs come back to the slot as takes:
 * a single tool's outputs all go to the slot, or with `saves` where it says by output title (others are left out); a
 * chain's saved outputs go where `saves` says (others to the slot).
 */
export function slotJobSpec(client: Client, b: { entity: string; slot: string; make?: MakeSpec | null; feedback?: string; count?: number; params?: Record<string, any>; note?: string }) {
  const e = mustEntity(client, b.entity);
  const slot = String(b.slot ?? '');
  if (!SLOT.test(slot)) throw new GenError('Bad slot name');
  const spec = makeSpecFor(e, slot, b.make);
  if (!spec) throw new GenError(`Nothing says how to make ${e.id} ${slot}: give make { tool | preset | steps }, or set data.slots.${slot}.make on the entity, or kinds.${e.kind}.slots in presets/${e.project}.json`);
  const pp = getProjectPresets(e.project);
  const vars = {
    name: e.name, canon: String(e.data?.canon ?? ''), look: String(e.data?.look ?? ''), brief: String(e.data?.slots?.[slot]?.brief ?? ''),
    feedback: b.feedback ? String(b.feedback) : '', style: pp?.style ?? '', slot, part: slot.split('/').pop() ?? slot,
    form: String(e.data?.form ?? 'humanoid'), template: String(e.data?.template ?? ''),
    unityProject: String(e.data?.unityProject ?? ''), triangles: String(e.data?.triangles ?? '25000'),
  } as Record<string, string>;
  // The slot's own data fills the rest ({start} and {end} of a clip, say).
  for (const [k, v] of Object.entries<any>(e.data?.slots?.[slot] ?? {})) if ((typeof v === 'string' || typeof v === 'number') && !(k in vars)) vars[k] = String(v);
  // Entity-level string/number fields fill leftover {keys} (e.g. {prompt} on motion/*).
  for (const [k, v] of Object.entries<any>(e.data ?? {})) if ((typeof v === 'string' || typeof v === 'number') && !(k in vars)) vars[k] = String(v);
  const filled = fillTemplate(spec, vars);
  // An input still naming a blank ({end} with no end pose) is left out: optional inputs stay optional.
  if (filled.inputs) {
    const blank = (v: any) => typeof v === 'string' && /\{\w+\}/.test(v);
    filled.inputs = Object.fromEntries(Object.entries(filled.inputs).map(([k, v]) => [k, Array.isArray(v) ? v.filter((x) => !blank(x)) : v]).filter(([, v]) => !blank(v) && !(Array.isArray(v) && !v.length)));
  }
  const labels: Record<string, unknown> = { entity: e.id, slot };
  if (b.note || b.feedback) labels.note = b.note ?? b.feedback;
  if (filled.steps) {
    if (filled.saves) labels.slots = filled.saves;
    return {
      tool: 'asset.make', project: e.project, self: e.id, labels,
      params: {
        steps: filled.steps, candidates: filled.candidates ?? 1,
        ...(filled.pick ? { pick: filled.pick } : {}), ...(filled.pickAt ? { pickAt: filled.pickAt } : {}),
        ...(Array.isArray(filled.refs) ? { refs: filled.refs } : {}),
      },
      inputs: filled.inputs ?? {},
    };
  }
  const params = { ...(filled.params ?? {}), ...(b.params ?? {}) };
  if (b.count) params.count = b.count;
  if (b.feedback && typeof params.prompt === 'string' && !spec.params?.prompt?.includes?.('{feedback}')) params.prompt = `${params.prompt} ${b.feedback}`.trim();
  // A tool that makes several things (blender.character: a GLB and a preview) files each by its title, as a chain does.
  if (filled.saves) labels.slots = filled.saves;
  return { tool: filled.tool, preset: filled.preset, project: e.project, self: e.id, labels, params, inputs: filled.inputs ?? {} };
}

/**
 * Revising a version with feedback ("make the visor bigger"): an image is edited in place with image.edit (the rest of
 * it stays); anything else is made again by the same tool and params, with the feedback added to the prompt.
 */
export function reviseJobSpec(client: Client, b: { entity: string; slot: string; feedback: string; version?: string; count?: number; references?: string[] }) {
  const e = mustEntity(client, b.entity);
  if (!String(b.feedback ?? '').trim()) throw new GenError('feedback is required');
  const ref = b.version ? `slot:${e.id}/${b.slot}@${b.version}` : `slot:${e.id}/${b.slot}`;
  const { version, asset } = resolveSlotRef(client, ref);
  const labels = { entity: e.id, slot: b.slot, note: b.feedback, revises: version.id };
  if (asset.kind === 'image') {
    return {
      tool: 'image.edit', project: e.project, self: e.id, labels,
      params: { prompt: `${b.feedback}. Keep everything else about image 1 the same.`, count: b.count ?? 1 },
      inputs: { images: [`asset:${asset.id}`, ...(b.references ?? []).slice(0, 2)] },
    };
  }
  const job = asset.job ? (db.prepare('SELECT tool, params, inputs FROM jobs WHERE id = ?').get(asset.job) as any) : null;
  if (!job) throw new GenError(`${ref} wasn't made by a job here, so there's nothing to make again: make a new take instead`);
  const params = JSON.parse(job.params);
  delete params.seed;
  if (typeof params.prompt === 'string') params.prompt = `${params.prompt} ${b.feedback}`.trim();
  if (b.count) params.count = b.count;
  const toRef = (p: string) => {
    const a = db.prepare('SELECT id FROM assets WHERE path = ?').get(p) as { id: string } | undefined;
    if (a) return `asset:${a.id}`;
    const blob = /([0-9a-f]{64})[^\\/]*$/.exec(p);
    return blob ? `blob:${blob[1]}` : p;
  };
  const inputs = Object.fromEntries(Object.entries<any>(JSON.parse(job.inputs)).map(([k, v]) => [k, Array.isArray(v) ? v.map(toRef) : toRef(v)]));
  return { tool: job.tool, project: e.project, self: e.id, labels, params, inputs };
}

/** When a job made for a slot ends, its outputs become takes there. Called by the queue. */
export function fileJobOutputs(job: { id: string; status: string; labels: Record<string, any>; outputs: { asset: string; title?: string | null }[] }) {
  const L = job.labels ?? {};
  if (job.status !== 'done' || !L.entity || !L.slot || !getEntityRow(String(L.entity))) return [];
  const map: Record<string, string> | null = L.slots && typeof L.slots === 'object' ? L.slots : null;
  const madeFrom: MadeFrom[] = Array.isArray(L.madeFrom) ? L.madeFrom : [];
  const out: ReturnType<typeof versionView>[] = [];
  for (const o of job.outputs ?? []) {
    const title = String(o.title ?? '');
    const slot = map ? map[title] ?? map[title.split('.')[0]] ?? null : String(L.slot);
    if (!slot) continue;
    // Already there (a resumed job, or the library handing back the same take again): don't file it twice.
    if (db.prepare('SELECT 1 FROM versions WHERE entity = ? AND slot = ? AND asset = ?').get(String(L.entity), slot, o.asset)) continue;
    out.push(addVersion(null, { entity: String(L.entity), slot, asset: o.asset, status: 'take', note: L.note ? String(L.note) : '', by: L.by ? String(L.by) : '', job: job.id, madeFrom }));
  }
  return out;
}
