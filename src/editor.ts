// The Gen app's editor (dashboard/gen/): projects (a timeline document per account), the edits on them, and the AI
// editor. One implementation of every edit (`applyOps`) serves the app's AI pane, the API and the MCP tools
// (editor_*), so whatever edits a project (the person, the AI, Claude over MCP) edits the same document.
//
// The document: tracks V1 (the main video track, magnetic: clips sit back to back in order), T1 (text on screen) and
// A1..A3 (audio, placed freely). A clip shows `asset` from `in` to `out` seconds of its source at `speed`; a clip
// waiting on a job has `job` and `pending` until the job ends (resolvePending fills the asset in). Nothing is added
// that the person didn't ask for: no fades or transitions unless set on a clip.

import crypto from 'node:crypto';
import { db } from './db.ts';
import { GenError } from './util.ts';
import { getJob } from './jobs.ts';
import { getTool } from './tools/index.ts';
import { ask, callScope } from './providers/anthropic.ts';
import { orgOfProject, isGenAccountProject } from './orgsecrets.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS editor_projects (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  doc TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS editor_projects_project ON editor_projects (project, updated DESC);
`);

export type TrackId = 'V1' | 'T1' | 'A1' | 'A2' | 'A3';
export const TRACKS: { id: TrackId; kind: 'video' | 'text' | 'audio'; name: string }[] = [
  { id: 'V1', kind: 'video', name: 'Video' },
  { id: 'T1', kind: 'text', name: 'Text' },
  { id: 'A1', kind: 'audio', name: 'Music' },
  { id: 'A2', kind: 'audio', name: 'Voice' },
  { id: 'A3', kind: 'audio', name: 'Sound' },
];
const TRACK_IDS = new Set(TRACKS.map((t) => t.id));

export type Clip = {
  id: string; track: TrackId; kind: 'video' | 'image' | 'audio' | 'text';
  asset?: string | null; job?: string | null; pending?: boolean; failed?: string | null;
  label?: string; start: number; in: number; out: number; duration?: number | null;
  speed?: number; volume?: number; muted?: boolean; text?: string;
  transition?: string; transitionSeconds?: number; zoom?: { from?: number; to?: number; x?: number; y?: number };
};
export type Doc = { v: 1; title: string; width: number; height: number; fps: number; fit?: 'pad' | 'crop'; tracks: typeof TRACKS; clips: Clip[] };

export const newDoc = (title = 'Untitled'): Doc => ({ v: 1, title, width: 1280, height: 720, fps: 30, tracks: TRACKS, clips: [] });

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const newId = () => `c_${crypto.randomBytes(5).toString('hex')}`;

/** A clip's length on the timeline (seconds). */
export const clipLength = (c: Clip) => Math.max(0, (c.out - c.in) / (c.speed || 1));
export const docLength = (d: Doc) => d.clips.reduce((m, c) => Math.max(m, c.start + clipLength(c)), 0);

/** Cleans a document from anywhere (the app, the AI, MCP): known tracks, sane numbers, V1 laid back to back. */
export function normalize(input: any): Doc {
  const d = input && typeof input === 'object' ? input : {};
  const doc: Doc = {
    v: 1, title: String(d.title ?? 'Untitled').slice(0, 120) || 'Untitled',
    width: clamp(Math.round(num(d.width, 1280) / 2) * 2, 64, 3840), height: clamp(Math.round(num(d.height, 720) / 2) * 2, 64, 3840),
    fps: clamp(num(d.fps, 30), 8, 60), ...(d.fit === 'crop' ? { fit: 'crop' as const } : {}), tracks: TRACKS, clips: [],
  };
  const seen = new Set<string>();
  for (const c0 of Array.isArray(d.clips) ? d.clips.slice(0, 600) : []) {
    if (!c0 || typeof c0 !== 'object' || !TRACK_IDS.has(c0.track)) continue;
    const track = c0.track as TrackId;
    const kind = track === 'T1' ? 'text' : track === 'V1' ? (c0.kind === 'image' ? 'image' : 'video') : 'audio';
    let id = typeof c0.id === 'string' && /^c_[\w-]{3,40}$/.test(c0.id) && !seen.has(c0.id) ? c0.id : newId();
    seen.add(id);
    const duration = c0.duration == null ? null : Math.max(0, num(c0.duration, 0)) || null;
    const inn = Math.max(0, num(c0.in, 0));
    let out = num(c0.out, kind === 'image' || kind === 'text' ? inn + 3 : duration ?? inn + 3);
    if (duration && kind !== 'image' && kind !== 'text') out = Math.min(out, duration);
    if (out <= inn + 0.04) out = inn + 0.04;
    const c: Clip = {
      id, track, kind, start: Math.max(0, r3(num(c0.start, 0))), in: r3(inn), out: r3(out), duration: duration ? r3(duration) : null,
      ...(c0.asset ? { asset: String(c0.asset) } : {}), ...(c0.job ? { job: String(c0.job) } : {}),
      ...(c0.pending ? { pending: true } : {}), ...(c0.failed ? { failed: String(c0.failed).slice(0, 300) } : {}),
      ...(c0.label ? { label: String(c0.label).slice(0, 200) } : {}),
      ...(c0.speed != null && num(c0.speed, 1) !== 1 ? { speed: clamp(num(c0.speed, 1), 0.25, 4) } : {}),
      ...(c0.volume != null && num(c0.volume, 1) !== 1 ? { volume: clamp(num(c0.volume, 1), 0, 4) } : {}),
      ...(c0.muted ? { muted: true } : {}),
      ...(kind === 'text' ? { text: String(c0.text ?? '').slice(0, 500) } : {}),
      ...(c0.transition && c0.transition !== 'cut' ? { transition: String(c0.transition).slice(0, 30), transitionSeconds: clamp(num(c0.transitionSeconds, 0.5), 0.1, 3) } : {}),
      ...(c0.zoom && typeof c0.zoom === 'object' ? { zoom: { from: clamp(num(c0.zoom.from, 1), 1, 4), to: clamp(num(c0.zoom.to, 1), 1, 4), x: clamp(num(c0.zoom.x, 0.5), 0, 1), y: clamp(num(c0.zoom.y, 0.5), 0, 1) } } : {}),
    };
    if (!c.asset && !c.job && kind !== 'text') continue;
    doc.clips.push(c);
  }
  return layout(doc);
}

/** V1 is magnetic: its clips sit back to back from 0 in their order. Other tracks keep their own starts. */
export function layout(doc: Doc): Doc {
  const v1 = doc.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);
  let t = 0;
  for (const c of v1) { c.start = r3(t); t += clipLength(c); }
  doc.clips.sort((a, b) => (a.track === b.track ? a.start - b.start : a.track.localeCompare(b.track)));
  return doc;
}

// ------------------------------------------------------------------ edits
export type Op = Record<string, any> & { op: string };
export type Submit = (spec: { tool: string; params: Record<string, any>; inputs: Record<string, any>; label?: string }) => { id: string };

/** Seconds a job's output will likely last (for its waiting clip), from its params. */
export function expectedSeconds(tool: string, p: Record<string, any> = {}) {
  if (p.frames && p.fps) return r3(Number(p.frames) / Number(p.fps));
  if (p.seconds) return Number(p.seconds);
  if (p.duration) return Number(p.duration);
  if (tool.startsWith('image.')) return 3;
  return 5;
}
const KIND_OF_TOOL = (tool: string): Clip['kind'] => (tool.startsWith('audio.') ? 'audio' : tool.startsWith('image.') ? 'image' : 'video');

/**
 * Applies edits in order. `clip:<id>` in a generate op's inputs stands for that clip's asset. Returns the new document
 * and, per op, what happened (an error never stops the ones after it).
 */
export function applyOps(doc0: Doc, ops: Op[], submit?: Submit): { doc: Doc; results: { op: string; ok: boolean; id?: string; job?: string; error?: string }[] } {
  const doc = normalize(JSON.parse(JSON.stringify(doc0)));
  const results: { op: string; ok: boolean; id?: string; job?: string; error?: string }[] = [];
  const find = (id: unknown) => {
    const c = doc.clips.find((x) => x.id === id);
    if (!c) throw new Error(`no clip ${id}`);
    return c;
  };
  const v1Index = (c: Clip) => doc.clips.filter((x) => x.track === 'V1').sort((a, b) => a.start - b.start).indexOf(c);
  /** Puts a V1 clip at an index (or after a clip, or at a time), by giving it a start just before the right place. */
  const placeV1 = (c: Clip, where: Record<string, any>) => {
    const others = doc.clips.filter((x) => x.track === 'V1' && x !== c).sort((a, b) => a.start - b.start);
    let i = others.length;
    if (where.after) i = others.findIndex((x) => x.id === where.after) + 1 || others.length;
    else if (where.index != null) i = clamp(Math.round(where.index), 0, others.length);
    else if (where.start != null) { i = others.findIndex((x) => x.start + clipLength(x) / 2 > Number(where.start)); if (i < 0) i = others.length; }
    c.start = i < others.length ? others[i].start - 0.0005 : (others.length ? others[others.length - 1].start + 0.0005 : 0);
    layout(doc); // turn the ordering key into real times now (rounding later could tie it with a neighbour)
  };
  for (const op of Array.isArray(ops) ? ops.slice(0, 100) : []) {
    try {
      switch (op?.op) {
        case 'add': {
          const track = (TRACK_IDS.has(op.track) ? op.track : op.text != null ? 'T1' : 'V1') as TrackId;
          const kind: Clip['kind'] = track === 'T1' ? 'text' : track === 'V1' ? (op.kind === 'image' ? 'image' : 'video') : 'audio';
          if (kind !== 'text' && !op.asset) throw new Error('add needs an asset');
          const duration = op.duration != null ? Number(op.duration) : null;
          const c: Clip = {
            id: newId(), track, kind, start: Math.max(0, num(op.start, docLength(doc))), in: Math.max(0, num(op.in, 0)),
            out: num(op.out, kind === 'image' || kind === 'text' ? num(op.in, 0) + num(op.seconds, 3) : duration ?? 5), duration,
            ...(op.asset ? { asset: String(op.asset) } : {}), ...(op.label ? { label: String(op.label) } : {}),
            ...(kind === 'text' ? { text: String(op.text ?? '') } : {}),
          };
          if (kind === 'text' && op.end != null) c.out = c.in + Math.max(0.2, num(op.end, c.start + 3) - c.start);
          doc.clips.push(c);
          if (track === 'V1') placeV1(c, op);
          results.push({ op: 'add', ok: true, id: c.id });
          break;
        }
        case 'generate': {
          if (!submit) throw new Error('generating needs a signed-in account');
          const tool = String(op.tool ?? '');
          if (!getTool(tool)) throw new Error(`no tool ${tool}`);
          const inputs: Record<string, any> = {};
          for (const [k, v] of Object.entries(op.inputs ?? {})) {
            const one = (x: unknown) => {
              const s = String(x);
              if (s.startsWith('clip:')) { const c = find(s.slice(5)); if (!c.asset) throw new Error(`clip ${c.id} has no file yet`); return `asset:${c.asset}`; }
              return /^(asset|blob):/.test(s) ? s : `asset:${s}`;
            };
            inputs[k] = Array.isArray(v) ? v.map(one) : one(v);
          }
          const params = op.params && typeof op.params === 'object' ? op.params : {};
          const job = submit({ tool, params, inputs, label: op.label });
          const kind = KIND_OF_TOOL(tool);
          const seconds = expectedSeconds(tool, params);
          const place = op.place ?? {};
          if (place.replace) {
            const old = find(place.replace);
            Object.assign(old, { asset: null, job: job.id, pending: true, failed: null, in: 0, out: kind === 'image' ? clipLength(old) : seconds, duration: kind === 'image' ? null : seconds, label: op.label ?? old.label });
            if (old.track === 'V1') old.kind = kind === 'audio' ? old.kind : (kind as 'video' | 'image');
            results.push({ op: 'generate', ok: true, id: old.id, job: job.id });
          } else if (place.track === null || place.library) {
            results.push({ op: 'generate', ok: true, job: job.id });
          } else {
            const track = (TRACK_IDS.has(place.track) ? place.track : kind === 'audio' ? 'A1' : 'V1') as TrackId;
            const c: Clip = {
              id: newId(), track, kind: track === 'V1' ? (kind === 'audio' ? 'video' : kind) : 'audio', start: Math.max(0, num(place.start, track === 'V1' ? docLength(doc) : 0)),
              in: 0, out: seconds, duration: kind === 'image' ? null : seconds, job: job.id, pending: true, label: op.label ?? String(params.prompt ?? params.text ?? tool).slice(0, 120),
            };
            doc.clips.push(c);
            if (track === 'V1') placeV1(c, place);
            results.push({ op: 'generate', ok: true, id: c.id, job: job.id });
          }
          break;
        }
        case 'trim': {
          const c = find(op.id);
          if (op.in != null) c.in = Math.max(0, num(op.in, c.in));
          if (op.out != null) c.out = num(op.out, c.out);
          if (op.length != null) c.out = c.in + Math.max(0.04, num(op.length, clipLength(c))) * (c.speed || 1);
          if (c.duration && c.kind !== 'image') c.out = Math.min(c.out, c.duration);
          if (c.out <= c.in + 0.04) throw new Error('that trim leaves nothing');
          results.push({ op: 'trim', ok: true, id: c.id });
          break;
        }
        case 'split': {
          const c = find(op.id);
          const at = num(op.at, c.start + clipLength(c) / 2);
          if (at <= c.start + 0.05 || at >= c.start + clipLength(c) - 0.05) throw new Error('split point is not inside the clip');
          const cut = c.in + (at - c.start) * (c.speed || 1);
          const right: Clip = { ...JSON.parse(JSON.stringify(c)), id: newId(), in: r3(cut), start: at + 0.0001 };
          c.out = r3(cut);
          delete right.transition; // the cut between the halves is a plain cut
          if (c.transition) { right.transition = c.transition; right.transitionSeconds = c.transitionSeconds; delete c.transition; delete c.transitionSeconds; }
          doc.clips.push(right);
          if (c.track === 'V1') layout(doc);
          results.push({ op: 'split', ok: true, id: right.id });
          break;
        }
        case 'move': {
          const c = find(op.id);
          if (op.track && TRACK_IDS.has(op.track) && op.track !== c.track) {
            const fits = (op.track === 'V1') === (c.track === 'V1') && (op.track === 'T1') === (c.track === 'T1');
            if (!fits) throw new Error(`a ${c.kind} clip can't go on ${op.track}`);
            c.track = op.track;
          }
          if (c.track === 'V1') placeV1(c, op);
          else if (op.start != null) c.start = Math.max(0, num(op.start, c.start));
          results.push({ op: 'move', ok: true, id: c.id });
          break;
        }
        case 'delete': {
          const c = find(op.id);
          doc.clips = doc.clips.filter((x) => x !== c);
          results.push({ op: 'delete', ok: true, id: c.id });
          break;
        }
        case 'deleteRange': {
          // Cuts [start, end) out of the timeline: V1 closes the gap; other tracks lose what was inside and slide back.
          const a = Math.max(0, num(op.start, 0)), b = num(op.end, a);
          if (b <= a) throw new Error('empty range');
          const tracks: Set<string> = new Set(Array.isArray(op.tracks) ? op.tracks : TRACKS.map((t) => t.id));
          const next: Clip[] = [];
          for (const c of doc.clips) {
            if (!tracks.has(c.track)) { next.push(c); continue; }
            const s = c.start, e = c.start + clipLength(c), sp = c.speed || 1;
            if (e <= a || s >= b) { if (s >= b && c.track !== 'V1') c.start = r3(s - (b - a)); next.push(c); continue; }
            if (s < a) next.push({ ...c, out: r3(c.in + (a - s) * sp) });
            if (e > b) next.push({ ...c, id: s < a ? newId() : c.id, start: c.track === 'V1' ? a + 0.0001 : r3(a), in: r3(c.in + (b - s) * sp) });
          }
          doc.clips = next;
          layout(doc);
          results.push({ op: 'deleteRange', ok: true });
          break;
        }
        case 'set': {
          const c = find(op.id);
          for (const k of ['volume', 'speed', 'muted', 'transition', 'transitionSeconds', 'zoom', 'text', 'label']) if (k in op) (c as any)[k] = op[k];
          if (op.transition === 'cut' || op.transition === null) { delete c.transition; delete c.transitionSeconds; }
          results.push({ op: 'set', ok: true, id: c.id });
          break;
        }
        case 'text': {
          const start = Math.max(0, num(op.start, 0));
          const c: Clip = { id: newId(), track: 'T1', kind: 'text', start, in: 0, out: Math.max(0.2, num(op.end, start + 3) - start), text: String(op.text ?? '').slice(0, 500) };
          doc.clips.push(c);
          results.push({ op: 'text', ok: true, id: c.id });
          break;
        }
        case 'settings': {
          if (op.title) doc.title = String(op.title).slice(0, 120);
          if (op.width) doc.width = clamp(Math.round(num(op.width, doc.width) / 2) * 2, 64, 3840);
          if (op.height) doc.height = clamp(Math.round(num(op.height, doc.height) / 2) * 2, 64, 3840);
          if (op.fps) doc.fps = clamp(num(op.fps, doc.fps), 8, 60);
          if (op.fit === 'crop' || op.fit === 'pad') doc.fit = op.fit;
          results.push({ op: 'settings', ok: true });
          break;
        }
        default: throw new Error(`unknown op ${op?.op}`);
      }
    } catch (e: any) {
      results.push({ op: String(op?.op ?? '?'), ok: false, error: String(e?.message ?? e) });
    }
  }
  return { doc: normalize(doc), results };
}

/** Fills in clips whose jobs ended: the output (of the clip's kind) when done, the error when failed. */
export function resolvePending(doc: Doc, jobOf: (id: string) => ReturnType<typeof getJob> = getJob): boolean {
  let changed = false;
  for (const c of doc.clips) {
    if (!c.pending || !c.job) continue;
    const j = jobOf(c.job);
    if (!j) { c.pending = false; c.failed = 'The job is gone'; changed = true; continue; }
    if (j.status === 'done') {
      const want = c.track === 'V1' ? ['video', 'image'] : ['audio'];
      const out = j.outputs.find((o) => want.includes(o.kind)) ?? j.outputs[0];
      if (!out) { c.pending = false; c.failed = 'The job made nothing'; changed = true; continue; }
      c.asset = out.asset;
      c.pending = false;
      if (c.track === 'V1') c.kind = out.kind === 'image' ? 'image' : 'video';
      changed = true;
    } else if (j.status === 'failed' || j.status === 'cancelled') {
      c.pending = false;
      c.failed = (j.error ?? j.status).split('\n')[0].slice(0, 300);
      changed = true;
    }
  }
  return changed;
}

// ------------------------------------------------------------------ projects
type Row = { id: string; project: string; title: string; doc: string; version: number; created: number; updated: number };
export type Project = { id: string; project: string; title: string; doc: Doc; version: number; created: number; updated: number };
const fromRow = (r: Row): Project => ({ ...r, doc: normalize(JSON.parse(r.doc)) });

export function listProjects(project: string, limit = 50) {
  return (db.prepare('SELECT id, project, title, version, created, updated FROM editor_projects WHERE project = ? ORDER BY updated DESC LIMIT ?').all(project, limit) as Omit<Row, 'doc'>[]);
}
export function createProject(project: string, doc?: unknown): Project {
  const d = doc ? normalize(doc) : newDoc();
  const now = Date.now();
  const id = `ep_${crypto.randomBytes(6).toString('hex')}`;
  db.prepare('INSERT INTO editor_projects (id, project, title, doc, version, created, updated) VALUES (?, ?, ?, ?, 1, ?, ?)').run(id, project, d.title, JSON.stringify(d), now, now);
  return { id, project, title: d.title, doc: d, version: 1, created: now, updated: now };
}
/** One project, with any finished jobs filled in (saved, so every reader sees the same). `canSee` checks the caller. */
export function getProject(id: string, canSee: (project: string) => boolean): Project {
  const r = db.prepare('SELECT * FROM editor_projects WHERE id = ?').get(id) as Row | undefined;
  if (!r || !canSee(r.project)) throw new GenError('No such project', { status: 404 });
  const p = fromRow(r);
  if (resolvePending(p.doc)) return saveDoc(p, p.doc);
  return p;
}
/** Saves a document. With `version`, refuses when someone else saved in between (409 with the newer project). */
export function saveDoc(p: Project, doc: unknown, version?: number): Project {
  const d = normalize(doc);
  const now = Date.now();
  const r = version != null
    ? db.prepare('UPDATE editor_projects SET doc = ?, title = ?, version = version + 1, updated = ? WHERE id = ? AND version = ?').run(JSON.stringify(d), d.title, now, p.id, version)
    : db.prepare('UPDATE editor_projects SET doc = ?, title = ?, version = version + 1, updated = ? WHERE id = ?').run(JSON.stringify(d), d.title, now, p.id);
  if (!r.changes) {
    const cur = fromRow(db.prepare('SELECT * FROM editor_projects WHERE id = ?').get(p.id) as Row);
    throw Object.assign(new GenError('Someone else changed this project: reload it', { status: 409 }), { project: cur });
  }
  return fromRow(db.prepare('SELECT * FROM editor_projects WHERE id = ?').get(p.id) as Row);
}
export function deleteProject(id: string, canSee: (project: string) => boolean) {
  const r = db.prepare('SELECT project FROM editor_projects WHERE id = ?').get(id) as { project: string } | undefined;
  if (!r || !canSee(r.project)) throw new GenError('No such project', { status: 404 });
  db.prepare('DELETE FROM editor_projects WHERE id = ?').run(id);
}

// ------------------------------------------------------------------ the AI editor
/** What the AI editor may run, with what it's for. Only tools this Gen has are offered. */
export const EDITOR_TOOLS: { tool: string; use: string }[] = [
  { tool: 'image.generate', use: 'a new image from words. params prompt, width, height' },
  { tool: 'image.edit', use: 'change a whole image with words. inputs images: [clip or asset]; params prompt' },
  { tool: 'image.repaint', use: 'change only a painted area of an image. inputs image, mask (the person\'s painted mask, given as selection.mask); params prompt' },
  { tool: 'image.expand', use: 'widen or reframe an image, filling the new area. inputs image; params aspect ("16:9", "9:16", "1:1") or left/right/top/bottom px, prompt' },
  { tool: 'image.cutout', use: 'remove the background. inputs image' },
  { tool: 'image.upscale', use: 'a sharper, bigger image. inputs image' },
  { tool: 'image.relight', use: 'new lighting or time of day. inputs image; params prompt' },
  { tool: 'video.i2v', use: 'animate an image into a clip. inputs start (image), optional end (image); params prompt (describe the motion fully: who moves, how, where to; big clear motion), width, height (multiples of 16, about 832x480 wide, 480x832 tall, 640x640 square), frames (4n+1, 16 fps: 49 = 3 s, 81 = 5 s), fps 16' },
  { tool: 'video.t2v', use: 'a clip from words. params prompt, seconds' },
  { tool: 'video.change', use: 'change something in a video clip, following its motion. inputs video, optional mask (first frame); params prompt' },
  { tool: 'video.control', use: 'restyle a whole clip in a new look from a restyled first frame. inputs control (video), image (the styled frame); params prompt' },
  { tool: 'video.replace', use: 'swap the person in a clip for the character in an image. inputs image, video; params prompt' },
  { tool: 'video.motion', use: 'a still character performs the motion of a clip. inputs image, video; params prompt' },
  { tool: 'video.extend', use: 'continue a shot from a frame (use video.frame at "last" first). inputs image; params prompt, seconds' },
  { tool: 'video.frame', use: 'grab a frame of a clip as an image. inputs video; params at (seconds, "first" or "last")' },
  { tool: 'video.still', use: 'an image as a clip. inputs image; params seconds, zoom' },
  { tool: 'video.upscale', use: 'a sharper, 4x bigger clip. inputs video' },
  { tool: 'video.interpolate', use: 'smoother motion (more frames). inputs video; params multiplier' },
  { tool: 'video.lipsync', use: 'a character from an image says an audio line. inputs image, audio; params prompt' },
  { tool: 'audio.music', use: 'music. params prompt, seconds' },
  { tool: 'audio.voice', use: 'a spoken line. params text, voice (an id from "voices" in the project data: pick by name, gender, age, accent), provider "elevenlabs"' },
  { tool: 'audio.sfx', use: 'a sound effect. params text, duration, provider "elevenlabs"' },
  // audio.revoice and the open voice models run only on the SSH GPU fleet (AWS, suspended since 2026-10-28): offered
  // again once the open audio models have a GPU provider.
  // The studio's tools: game art, 3D and sound. Their results go to the library (place {"library":true}), never the timeline.
  { tool: 'image.panorama', use: 'a 360° equirectangular skybox. params prompt. Library only' },
  { tool: 'texture.maps', use: 'PBR material maps (normal, roughness, height...) from a seamless texture. inputs image. Library only' },
  { tool: 'image.angles', use: 'a character turnaround from 8 angles. inputs image. Library only' },
  { tool: 'image.viewsheet', use: 'a 4-view sheet (front, back, left, right) of a character for 3D. inputs image (front view, clean background); params form (what it is). Library only' },
  { tool: 'mesh.views3d', use: 'a textured 3D model (GLB) from a 4-view sheet. inputs image (the sheet from image.viewsheet). Library only' },
  { tool: 'mesh.textured', use: 'a textured 3D model (GLB) from one image of a prop; params allowSingleView true. inputs image. Library only' },
  { tool: 'video.talk', use: 'a portrait talks along to an audio line. inputs image, audio; params prompt' },
  { tool: 'video.animate', use: 'a character image moves like a driving video. inputs reference (image), motion (video); params prompt' },
];

/** Tools the app never lists in Create: the studio's machinery, plumbing the editor runs itself, and admin work. */
const NOT_IN_CATALOG = /^(comfy\.graph|unity\.|playtest\.|asset\.lod|media\.|file\.import|library\.|lora\.train|audio\.voice-(list|delete|save)|film\.|video\.compose|video\.still|image\.frame|video\.fit|llm\.)/;

/**
 * Every tool the app's Create pane offers: Gen's own description of it (params, inputs, outputs), and whether it can
 * run now. Tools that work over SSH need the GPU fleet (AWS, suspended since 2026-10-28) and say so with ready: false.
 */
export async function catalog(describe: (t: any) => any, all: any[], fleetDown: boolean) {
  return all.filter((t) => !NOT_IN_CATALOG.test(t.id)).map((t) => ({ ...describe(t), ready: !(t.server === 'ssh' && fleetDown) }));
}

// ------------------------------------------------------------------ voices
export type EditorVoice = { id: string; name: string; about: string; preview: string };
/**
 * The voices the app and the AI editor offer: ElevenLabs' own premade voices only (never the account's cloned or
 * designed ones: those are the studio's characters). Empty when ElevenLabs isn't set up.
 */
export async function editorVoices(): Promise<EditorVoice[]> {
  try {
    const eleven = await import('./providers/elevenlabs.ts');
    if (!eleven.configured()) return [];
    return (await eleven.voices()).filter((v: any) => v.category === 'premade').map((v: any) => ({
      id: v.id, name: v.name, preview: v.preview,
      about: [v.labels?.gender, v.labels?.age, v.labels?.accent, v.labels?.descriptive ?? v.labels?.description, v.labels?.use_case ?? v.labels?.['use case']].filter(Boolean).join(', ') || v.description || '',
    })).slice(0, 40);
  } catch {
    return [];
  }
}
export const availableEditorTools = () => EDITOR_TOOLS.filter((t) => getTool(t.tool));

export type AssistantMessage = { role: 'user' | 'assistant'; text: string };
export type Selection = { clips?: string[]; range?: { start: number; end: number } | null; playhead?: number; mask?: string | null; frame?: string | null };

const OPS_DOC = `Edits (each an object in "ops"):
- {"op":"add","track":"V1"|"T1"|"A1"|"A2"|"A3","asset":"a_...","kind":"video"|"image","in":s,"out":s,"start":s,"index":n,"after":"c_..."} put a library file on the timeline (V1 takes index/after; audio tracks take start)
- {"op":"generate","tool":"...","params":{...},"inputs":{"name":"clip:c_..."|"a_..."|"blob:..."},"place":{"track":"V1","after":"c_..."}|{"replace":"c_..."}|{"library":true},"label":"short name"} run a tool; its result lands where "place" says (a waiting clip shows until it's done)
- {"op":"trim","id":"c_...","in":s,"out":s} or {"op":"trim","id":"c_...","length":s}  (in/out are seconds of the clip's source)
- {"op":"split","id":"c_...","at":s}  (timeline seconds)
- {"op":"move","id":"c_...","index":n|"after":"c_..."|"start":s}
- {"op":"delete","id":"c_..."}   {"op":"deleteRange","start":s,"end":s,"tracks":["V1",...]}
- {"op":"set","id":"c_...","volume":0-4,"speed":0.25-4,"muted":bool,"transition":"cut"|"crossfade"|"fadeblack"|"dissolve"|"wipeleft","transitionSeconds":s,"zoom":{"from":1,"to":1.3,"x":0.5,"y":0.4},"text":"..."}
- {"op":"text","text":"...","start":s,"end":s}  words on screen
- {"op":"settings","width":w,"height":h,"fps":n,"title":"...","fit":"crop"|"pad"}  (fit: clips of another shape fill the frame, cropped, or fit inside it with bars)`;

function systemPrompt() {
  return `You are the AI inside Hawkes Gen, a creative studio on a generative AI platform: a video editor, plus tools for images and textures, 3D models, voices, sound and music, and a library of everything the person makes. The person edits a timeline and talks to you; you change their project by returning edits, and you make things for their library (game art, skyboxes, materials, 3D models) with generate ops placed {"library":true}. A 3D model (kind "mesh") never goes on the timeline. Be decisive and do what they ask in as few edits as it takes. When something is ambiguous, make the sensible choice and say what you did; ask a question only when you truly can't proceed.

The timeline: V1 is the main video track (clips play back to back in order; images show as stills), T1 is text on screen, A1 music, A2 voice, A3 sound effects (audio clips start at any time). Times are seconds. The person's selection tells you what "this", "these", "here" mean: selected clips, a selected time range, the playhead, and possibly a painted mask (selection.mask, a blob to pass as the mask input) on a frame.

Generating costs the person credits (1 credit = 1 cent); prefer one good take over many, and don't regenerate what exists. Never add fades, transitions or music they didn't ask for. To change what's IN a clip use tools (a generate op with place.replace keeps its spot); to change timing use trim/split/move/delete. To work on one frame of a video (edit it, continue from it) grab it first with video.frame, in the same answer: a later op can't use an earlier op's output, so when a step needs another's result, do the first step now and say you'll continue once it's ready.

Tools you can run:
${availableEditorTools().map((t) => `- ${t.tool}: ${t.use}`).join('\n')}

${OPS_DOC}

Answer with JSON only: {"say": "one or two short sentences to the person", "ops": [ ... ]}.`;
}

const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['say', 'ops'],
  properties: { say: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } },
};

/** What the AI sees of the project: the clips (no internals), lengths, the selection, and recent library files. */
export function contextFor(doc: Doc, selection: Selection, library: { id: string; kind: string; title?: string | null; prompt?: string | null; duration?: number | null }[], voices: EditorVoice[] = []) {
  const clips = doc.clips.map((c) => ({
    id: c.id, track: c.track, kind: c.kind, start: r3(c.start), length: r3(clipLength(c)), in: c.in, out: c.out,
    ...(c.duration ? { sourceLength: c.duration } : {}), ...(c.asset ? { asset: c.asset } : {}), ...(c.pending ? { pending: true } : {}),
    ...(c.failed ? { failed: c.failed } : {}), ...(c.label ? { label: c.label } : {}), ...(c.text ? { text: c.text } : {}),
    ...(c.speed ? { speed: c.speed } : {}), ...(c.volume != null ? { volume: c.volume } : {}), ...(c.muted ? { muted: true } : {}),
    ...(c.transition ? { transition: c.transition } : {}),
  }));
  return { project: { title: doc.title, width: doc.width, height: doc.height, fps: doc.fps, fit: doc.fit ?? 'pad', length: r3(docLength(doc)) }, clips, selection, library: library.slice(0, 40), ...(voices.length ? { voices: voices.map((v) => ({ id: v.id, name: v.name, about: v.about })) } : {}) };
}

/** Pulls the answer's JSON out (models sometimes wrap it in a fence or a sentence). */
export function parseAnswer(text: string): { say: string; ops: Op[] } {
  let t = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try {
    const j = JSON.parse(t);
    return { say: String(j.say ?? '').slice(0, 2000), ops: Array.isArray(j.ops) ? j.ops.filter((o: any) => o && typeof o.op === 'string') : [] };
  } catch {
    return { say: String(text ?? '').slice(0, 2000), ops: [] };
  }
}

type TurnInput = { project: string; doc: Doc; selection: Selection; messages: AssistantMessage[]; library: Parameters<typeof contextFor>[2]; voices?: EditorVoice[] };

/** The AI editor's request: its instructions, and the project, selection and conversation. */
export function assistantPrompt(a: TurnInput) {
  const convo = a.messages.slice(-16).map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${String(m.text).slice(0, 4000)}`).join('\n\n');
  const prompt = `The project now:\n${JSON.stringify(contextFor(a.doc, a.selection, a.library, a.voices ?? []))}\n\nThe conversation (the last line is what to do now):\n${convo}`;
  return { system: systemPrompt(), prompt, schema: ANSWER_SCHEMA, maxTokens: 4000, effort: 'medium' };
}

/**
 * One AI editor turn: the conversation, the project and selection in; the answer's words and edits out. Runs on the
 * account's own Claude when it has one (callScope with its org: its API key or subscription), else, for a Gen app
 * account, on the house AI (src/houseai.ts): `house` says so, and `cost` is what the call cost, to charge in credits.
 */
export async function assistantTurn(a: TurnInput): Promise<{ say: string; ops: Op[]; model: string; house: boolean; cost: number }> {
  const org = orgOfProject(a.project);
  const r = await callScope.run({ customer: true, org, house: isGenAccountProject(a.project) }, () => ask(assistantPrompt(a)));
  return { ...parseAnswer(r.text), model: r.model, house: !['byok', 'subscription'].includes(r.billing), cost: r.cost ?? 0 };
}
