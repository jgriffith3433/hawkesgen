// The timeline under video, image and audio scenes (J, 2026-10-29: "I think we can have everything be on a timeline ...
// the center should always be the visualization of what you are scrubbed on ... There should be a way to layer more
// than one type of scene on each track"). One document shape for all three; the kind decides the defaults, what the
// center shows (the picture, or the sound) and what export means (a video, the frame at the playhead, a mixdown).
//
// Tracks are ordered top to bottom, and a higher track draws over the ones below (like layers). Any clip can sit on
// any track: video, image, audio, text or a color fill, anywhere in time (J, 2026-10-30: "you should be able to place
// them where ever in time"). A track can be magnetic (its clips sit back to back from 0 in their order; off unless the
// person turns it on), hidden, locked, muted or soloed, with a volume and a pan. A clip plays `asset`
// (or another scene's render: `scene`) from `in` to `out` seconds of its source at `speed`, starting at `start` on the
// timeline; visual clips are placed by their center (x, y as shares of the frame), width (w, a share of the frame's
// width; none: fit the frame), rotation, opacity and blend; sound clips have volume, mute and fades.
//
// Version 1 documents (fixed tracks V1, T1, A1..A3) and the first image (layers) and audio (tracks of clips) scenes are
// converted on read (normalize), keeping their clip ids and the old track ids.

import crypto from 'node:crypto';
import { getJob } from './jobs.ts';
import { getTool } from './tools/index.ts';
import { aiCanUse } from './editor.ts';
import { sceneRef, type Render } from './scenes.ts';
import { clampTransitionSeconds, isTransitionType } from './transitions.ts';

export type Role = 'main' | 'video' | 'text' | 'audio' | 'any';
export type Track = { id: string; name: string; role: Role; magnetic?: boolean; hidden?: boolean; locked?: boolean; mute?: boolean; solo?: boolean; volume?: number; pan?: number; color?: string };
export const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'lighten', 'darken', 'soft-light', 'difference'] as const;
export type Clip = {
  id: string; track: string; kind: 'video' | 'image' | 'audio' | 'text' | 'fill';
  asset?: string | null; job?: string | null; pending?: boolean; failed?: string | null;
  label?: string; start: number; in: number; out: number; duration?: number | null;
  speed?: number; volume?: number; muted?: boolean; fadeIn?: number; fadeOut?: number;
  text?: string; font?: string; size?: number; weight?: number; color?: string; align?: 'left' | 'center' | 'right'; box?: string | null;
  x?: number; y?: number; w?: number | null; rotation?: number; opacity?: number; blend?: typeof BLENDS[number];
  transition?: string; transitionSeconds?: number; zoom?: { from?: number; to?: number; x?: number; y?: number };
  /** The scene this clip plays (a filmed stage, a rendered image, another video, an audio scene's mixdown); `asset` is its render. */
  scene?: string | null; sceneVersion?: number | null;
};
export type Kind = 'video' | 'image' | 'audio';
export type Doc = {
  v: 2; title: string; width: number; height: number; fps: number; fit?: 'pad' | 'crop';
  background?: string | null; length?: number | null; bpm?: number | null;
  tracks: Track[]; clips: Clip[]; render?: Render | null;
};

/** The tracks a version 1 document had, top first: text over the main video, then music, voice and sound. */
export const TRACKS: Track[] = [
  { id: 'T1', name: 'Text', role: 'text' },
  { id: 'V1', name: 'Video', role: 'main' },
  { id: 'A1', name: 'Music', role: 'audio' },
  { id: 'A2', name: 'Voice', role: 'audio' },
  { id: 'A3', name: 'Sound', role: 'audio' },
];
const COLORS = ['#5b6cff', '#a15bff', '#1fa3b8', '#1fb88a', '#e0a83a', '#ff6b81'];

export function blankTracks(kind: Kind): Track[] {
  if (kind === 'image') return [{ id: 'L3', name: 'Top', role: 'any' }, { id: 'L2', name: 'Middle', role: 'any' }, { id: 'L1', name: 'Background', role: 'any' }];
  if (kind === 'audio') return [{ id: 'A1', name: 'Music', role: 'audio' }, { id: 'A2', name: 'Voice', role: 'audio' }, { id: 'A3', name: 'Sound', role: 'audio' }];
  return TRACKS.map((t) => ({ ...t }));
}
export const newDoc = (title = 'Untitled', kind: Kind = 'video'): Doc => ({
  v: 2, title, width: kind === 'image' ? 1344 : 1280, height: kind === 'image' ? 768 : 720, fps: 30,
  ...(kind === 'image' ? { background: '#1b1e26', length: 5 } : {}), ...(kind === 'audio' ? { bpm: null } : {}),
  tracks: blankTracks(kind), clips: [],
});

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const color = (v: unknown, d: string | null) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
const newId = () => `c_${crypto.randomBytes(5).toString('hex')}`;
const trackId = () => `tr_${crypto.randomBytes(3).toString('hex')}`;

/** A clip's length on the timeline (seconds). */
export const clipLength = (c: Clip) => Math.max(0, (c.out - c.in) / (c.speed || 1));
export const clipEnd = (c: Clip) => c.start + clipLength(c);
export const docLength = (d: Doc) => Math.max(d.length ?? 0, d.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0));
export const isVisual = (c: Pick<Clip, 'kind'>) => c.kind === 'video' || c.kind === 'image' || c.kind === 'text' || c.kind === 'fill';
export const hasSound = (c: Pick<Clip, 'kind'>) => c.kind === 'video' || c.kind === 'audio';
export const trackOf = (d: Doc, id: string) => d.tracks.find((t) => t.id === id) ?? null;
export const isMagnetic = (d: Doc, id: string) => Boolean(trackOf(d, id)?.magnetic);

// ------------------------------------------------------------------ old documents
/** A version 1 video document, the first image (layers) or audio (tracks of clips) documents, as version 2. */
function upgrade(d: any): any {
  if (d.v === 2 && Array.isArray(d.tracks) && d.tracks.every((t: any) => t && typeof t.id === 'string')) return d;
  if (Array.isArray(d.layers)) {
    // Image layers (bottom first) become tracks (top first), each a clip that lasts the whole picture.
    const W = num(d.width, 1344), H = num(d.height, 768);
    const tracks: Track[] = [], clips: any[] = [];
    [...d.layers].reverse().forEach((l: any, i: number) => {
      const id = `L${d.layers.length - i}`;
      tracks.push({ id, name: String(l.name ?? `Layer ${i + 1}`).slice(0, 40), role: 'any', ...(l.hidden ? { hidden: true } : {}), ...(l.locked ? { locked: true } : {}) });
      const kind = l.type === 'text' ? 'text' : l.type === 'fill' ? 'fill' : 'image';
      clips.push({
        id: newId(), track: id, kind, start: 0, in: 0, out: 5, label: l.name,
        ...(kind === 'image' ? { asset: l.asset, scene: l.scene, sceneVersion: l.sceneVersion, ...(l.pending ? { job: l.pending, pending: true } : {}), failed: l.failed } : {}),
        x: num(l.x, W / 2) / W, y: num(l.y, H / 2) / H, ...(l.w != null ? { w: num(l.w, W) / W } : {}), rotation: l.rotation, opacity: l.opacity, blend: l.blend,
        ...(kind === 'text' ? { text: l.text, font: l.font, size: num(l.size, 72) / H, weight: l.weight, color: l.color, align: l.align } : {}),
        ...(kind === 'fill' ? { color: l.color } : {}),
      });
    });
    return { v: 2, title: d.title, width: W, height: H, fps: 30, background: d.background ?? null, length: 5, tracks, clips, render: d.render };
  }
  if (Array.isArray(d.tracks) && d.tracks.some((t: any) => Array.isArray(t?.clips))) {
    // Audio tracks with their clips: the tracks keep their mix; the clips come out onto the timeline.
    const tracks: Track[] = [], clips: any[] = [];
    for (const t of d.tracks) {
      const id = typeof t.id === 'string' && /^[A-Za-z][\w-]{0,15}$/.test(t.id) ? t.id : trackId();
      tracks.push({ id, name: t.name ?? 'Track', role: 'audio', volume: t.volume, pan: t.pan, ...(t.mute ? { mute: true } : {}), ...(t.solo ? { solo: true } : {}), color: t.color });
      for (const c of t.clips ?? []) clips.push({ id: newId(), track: id, kind: 'audio', asset: c.asset, scene: c.scene, sceneVersion: c.sceneVersion, ...(c.pending ? { job: c.pending, pending: true } : {}), failed: c.failed, label: c.label, start: c.start, in: c.in, out: c.out, duration: c.duration, volume: c.gain, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
    }
    return { v: 2, title: d.title, width: 1280, height: 720, fps: 30, bpm: d.bpm ?? null, tracks, clips, render: d.render };
  }
  // Version 1: the fixed tracks, top first.
  return { ...d, v: 2, tracks: TRACKS.map((t) => ({ ...t })) };
}

// ------------------------------------------------------------------ normalize
/** Cleans a document from anywhere (the app, the AI, MCP): known tracks, sane numbers, magnetic tracks laid out. */
export function normalize(input: any, kind: Kind = 'video'): Doc {
  const d = upgrade(input && typeof input === 'object' ? input : {});
  const seenT = new Set<string>();
  const tracks: Track[] = (Array.isArray(d.tracks) ? d.tracks : []).slice(0, 40).filter((t: any) => t && typeof t === 'object').map((t: any, i: number) => {
    let id = typeof t.id === 'string' && /^[A-Za-z][\w-]{0,15}$/.test(t.id) && !seenT.has(t.id) ? t.id : trackId();
    while (seenT.has(id)) id = trackId();
    seenT.add(id);
    const role: Role = ['main', 'video', 'text', 'audio', 'any'].includes(t.role) ? t.role : 'any';
    return {
      id, name: String(t.name ?? `Track ${i + 1}`).slice(0, 40) || `Track ${i + 1}`, role,
      ...(t.magnetic ? { magnetic: true } : {}), ...(t.hidden ? { hidden: true } : {}), ...(t.locked ? { locked: true } : {}),
      ...(t.mute ? { mute: true } : {}), ...(t.solo ? { solo: true } : {}),
      ...(t.volume != null && num(t.volume, 1) !== 1 ? { volume: r3(clamp(num(t.volume, 1), 0, 2)) } : {}),
      ...(t.pan ? { pan: r3(clamp(num(t.pan, 0), -1, 1)) } : {}),
      color: color(t.color, COLORS[i % COLORS.length])!,
    };
  });
  if (!tracks.length) tracks.push(...blankTracks(kind));
  const doc: Doc = {
    v: 2, title: String(d.title ?? 'Untitled').slice(0, 120) || 'Untitled',
    width: clamp(Math.round(num(d.width, kind === 'image' ? 1344 : 1280) / 2) * 2, 16, 4096), height: clamp(Math.round(num(d.height, kind === 'image' ? 768 : 720) / 2) * 2, 16, 4096),
    fps: clamp(num(d.fps, 30), 8, 60), ...(d.fit === 'crop' ? { fit: 'crop' as const } : {}),
    ...(d.background !== undefined ? { background: color(d.background, null) } : {}),
    ...(d.length != null ? { length: r3(clamp(num(d.length, 5), 0.1, 3600)) } : {}),
    ...(d.bpm != null ? { bpm: Math.round(clamp(num(d.bpm, 120), 30, 300)) } : {}),
    tracks, clips: [],
    ...(keptRender(d.render) ? { render: keptRender(d.render) } : {}),
  };
  const ids = new Set(tracks.map((t) => t.id));
  const seen = new Set<string>();
  for (const c0 of Array.isArray(d.clips) ? d.clips.slice(0, 1000) : []) {
    if (!c0 || typeof c0 !== 'object') continue;
    const track = ids.has(c0.track) ? c0.track : null;
    if (!track) continue;
    const kind: Clip['kind'] = ['video', 'image', 'audio', 'text', 'fill'].includes(c0.kind) ? c0.kind : c0.text != null ? 'text' : 'video';
    const id = typeof c0.id === 'string' && /^c_[\w-]{3,40}$/.test(c0.id) && !seen.has(c0.id) ? c0.id : newId();
    seen.add(id);
    const still = kind === 'image' || kind === 'text' || kind === 'fill';
    const duration = c0.duration == null || still ? null : Math.max(0, num(c0.duration, 0)) || null;
    const inn = still ? 0 : Math.max(0, num(c0.in, 0));
    let out = num(c0.out, still ? 3 : duration ?? inn + 3);
    if (duration) out = Math.min(out, duration);
    if (out <= inn + 0.04) out = inn + 0.04;
    const c: Clip = {
      id, track, kind, start: Math.max(0, r3(num(c0.start, 0))), in: r3(inn), out: r3(out), duration: duration ? r3(duration) : null,
      ...(c0.asset && typeof c0.asset === 'string' ? { asset: c0.asset.slice(0, 80) } : {}),
      ...(c0.job ? { job: String(c0.job) } : {}), ...(c0.pending ? { pending: true } : {}),
      ...(c0.failed ? { failed: String(c0.failed).slice(0, 300) } : {}),
      ...(c0.label ? { label: String(c0.label).slice(0, 200) } : {}),
      ...(c0.speed != null && num(c0.speed, 1) !== 1 && !still ? { speed: clamp(num(c0.speed, 1), 0.25, 4) } : {}),
      ...(c0.volume != null && num(c0.volume, 1) !== 1 ? { volume: r3(clamp(num(c0.volume, 1), 0, 4)) } : {}),
      ...(c0.muted ? { muted: true } : {}),
      ...(num(c0.fadeIn, 0) > 0 ? { fadeIn: r3(clamp(num(c0.fadeIn, 0), 0, 30)) } : {}),
      ...(num(c0.fadeOut, 0) > 0 ? { fadeOut: r3(clamp(num(c0.fadeOut, 0), 0, 30)) } : {}),
      ...(kind === 'text' ? {
        text: String(c0.text ?? '').slice(0, 2000), ...(c0.font ? { font: String(c0.font).slice(0, 60) } : {}),
        ...(c0.size != null ? { size: r4(clamp(num(c0.size, 0.06), 0.005, 1)) } : {}), ...(c0.weight != null ? { weight: clamp(Math.round(num(c0.weight, 700) / 100) * 100, 100, 900) } : {}),
        ...(color(c0.color, null) ? { color: color(c0.color, null)! } : {}), ...(['left', 'center', 'right'].includes(c0.align) ? { align: c0.align } : {}),
        ...(c0.box !== undefined ? { box: color(c0.box, null) } : {}),
      } : {}),
      ...(kind === 'fill' ? { color: color(c0.color, '#000000')! } : {}),
      // Placement on the frame: only what differs from "centered, fit to the frame, upright, opaque".
      ...(c0.x != null && num(c0.x, 0.5) !== 0.5 ? { x: r4(clamp(num(c0.x, 0.5), -3, 4)) } : {}),
      ...(c0.y != null && num(c0.y, 0.5) !== 0.5 ? { y: r4(clamp(num(c0.y, 0.5), -3, 4)) } : {}),
      ...(c0.w != null ? { w: r4(clamp(num(c0.w, 1), 0.005, 20)) } : {}),
      ...(num(c0.rotation, 0) ? { rotation: r3(num(c0.rotation, 0) % 360) } : {}),
      ...(c0.opacity != null && num(c0.opacity, 1) !== 1 ? { opacity: r3(clamp(num(c0.opacity, 1), 0, 1)) } : {}),
      ...((BLENDS as readonly string[]).includes(c0.blend) && c0.blend !== 'normal' ? { blend: c0.blend } : {}),
      ...(sceneRef(c0.scene) ? { scene: sceneRef(c0.scene), ...(Number.isFinite(Number(c0.sceneVersion)) ? { sceneVersion: Number(c0.sceneVersion) } : {}) } : {}),
      ...(c0.transition && c0.transition !== 'cut' && isTransitionType(String(c0.transition)) ? { transition: String(c0.transition), transitionSeconds: clampTransitionSeconds(c0.transitionSeconds, 0.5) } : {}),
      ...(c0.zoom && typeof c0.zoom === 'object' ? { zoom: { from: clamp(num(c0.zoom.from, 1), 1, 4), to: clamp(num(c0.zoom.to, 1), 1, 4), x: clamp(num(c0.zoom.x, 0.5), 0, 1), y: clamp(num(c0.zoom.y, 0.5), 0, 1) } } : {}),
    };
    if (!c.asset && !c.job && !c.scene && kind !== 'text' && kind !== 'fill' && !c.failed) continue;
    doc.clips.push(c);
  }
  return layout(doc);
}

/**
 * Magnetic tracks: their clips sit back to back from 0 in their order. Others keep their own starts, but clips on one
 * track never overlap (J, 2026-10-30): one that would start inside the clip before it slides to just after it (so an
 * AI's plan made before other clips arrived, or a paste, pushes later clips along instead of stacking them).
 */
export function layout(doc: Doc): Doc {
  for (const t of doc.tracks) {
    const cs = doc.clips.filter((x) => x.track === t.id).sort((a, b) => a.start - b.start);
    let at = 0;
    for (const c of cs) {
      if (t.magnetic) c.start = r3(at);
      else if (c.start < at - 0.001) c.start = r3(at);
      at = c.start + clipLength(c);
    }
  }
  const order = new Map(doc.tracks.map((t, i) => [t.id, i]));
  doc.clips.sort((a, b) => (a.track === b.track ? a.start - b.start : (order.get(a.track) ?? 0) - (order.get(b.track) ?? 0)));
  return doc;
}

/** A render as documents keep it: an asset, its kind, the scene's version then. */
export function keptRender(v: any): Render | null {
  if (!v || typeof v !== 'object' || !/^a_[0-9a-f]{6,40}$/.test(String(v.asset))) return null;
  return { asset: String(v.asset), kind: ['video', 'image', 'audio', 'mesh'].includes(v.kind) ? v.kind : 'video', version: Math.max(0, Math.round(Number(v.version) || 0)), at: Number(v.at) || 0 };
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

/** The track a clip of this kind goes on when none is named: the first that fits (main, then by role), else the first. */
export function defaultTrack(doc: Doc, kind: Clip['kind']): string {
  const by = (pred: (t: Track) => boolean) => doc.tracks.find(pred)?.id;
  if (kind === 'audio') return by((t) => t.role === 'audio') ?? by((t) => t.role === 'any') ?? doc.tracks[doc.tracks.length - 1].id;
  if (kind === 'text') return by((t) => t.role === 'text') ?? by((t) => t.role === 'any') ?? doc.tracks[0].id;
  return by((t) => t.role === 'main') ?? by((t) => t.role === 'video') ?? by((t) => t.role === 'any') ?? doc.tracks[0].id;
}

const VISUAL_KEYS = ['x', 'y', 'w', 'rotation', 'opacity', 'blend'] as const;
const STYLE_KEYS = ['font', 'size', 'weight', 'color', 'align', 'box'] as const;

/**
 * Applies edits in order. `clip:<id>` in a generate op's inputs stands for that clip's asset. Returns the new document
 * and, per op, what happened (an error never stops the ones after it).
 */
export function applyOps(doc0: Doc, ops: Op[], submit?: Submit, kind: Kind = 'video'): { doc: Doc; results: { op: string; ok: boolean; id?: string; job?: string; error?: string }[] } {
  const doc = normalize(JSON.parse(JSON.stringify(doc0)), kind);
  const results: { op: string; ok: boolean; id?: string; job?: string; error?: string }[] = [];
  const find = (id: unknown) => {
    const c = doc.clips.find((x) => x.id === id);
    if (!c) throw new Error(`no clip ${id}`);
    return c;
  };
  const trackFor = (want: unknown, k: Clip['kind']) => (typeof want === 'string' && trackOf(doc, want) ? want : defaultTrack(doc, k));
  /** Puts a clip on a magnetic track at an index (or after a clip, or at a time): a start just before the right place. */
  const placeMag = (c: Clip, where: Record<string, any>) => {
    const others = doc.clips.filter((x) => x.track === c.track && x !== c).sort((a, b) => a.start - b.start);
    let i = others.length;
    if (where.after) i = others.findIndex((x) => x.id === where.after) + 1 || others.length;
    else if (where.index != null) i = clamp(Math.round(where.index), 0, others.length);
    else if (where.start != null) { i = others.findIndex((x) => x.start + clipLength(x) / 2 > Number(where.start)); if (i < 0) i = others.length; }
    c.start = i < others.length ? others[i].start - 0.0005 : (others.length ? others[others.length - 1].start + 0.0005 : 0);
    layout(doc); // turn the ordering key into real times now (rounding later could tie it with a neighbour)
  };
  const place = (c: Clip, where: Record<string, any>, fallbackStart: number) => {
    if (isMagnetic(doc, c.track)) placeMag(c, where);
    else c.start = Math.max(0, num(where.start, fallbackStart));
  };
  const look = (c: Clip, op: Record<string, any>) => {
    for (const k of VISUAL_KEYS) if (k in op) (c as any)[k] = op[k];
    if (c.kind === 'text') for (const k of STYLE_KEYS) if (k in op) (c as any)[k] = op[k];
    if (c.kind === 'fill' && op.color) c.color = op.color;
  };
  for (const op of Array.isArray(ops) ? ops.slice(0, 100) : []) {
    try {
      switch (op?.op) {
        case 'add': {
          const k: Clip['kind'] = op.kind === 'fill' ? 'fill' : op.text != null || op.kind === 'text' ? 'text' : ['video', 'image', 'audio'].includes(op.kind) ? op.kind : 'video';
          if ((k === 'video' || k === 'image' || k === 'audio') && !op.asset && !op.scene) throw new Error('add needs an asset');
          const track = trackFor(op.track, k);
          const duration = op.duration != null ? Number(op.duration) : null;
          const still = k === 'image' || k === 'text' || k === 'fill';
          const c: Clip = {
            id: newId(), track, kind: k, start: 0, in: still ? 0 : Math.max(0, num(op.in, 0)),
            out: num(op.out, still ? num(op.seconds, 3) : duration ?? 5), duration: still ? null : duration,
            ...(op.asset ? { asset: String(op.asset) } : {}), ...(op.scene ? { scene: String(op.scene) } : {}), ...(op.label ? { label: String(op.label) } : {}),
            ...(k === 'text' ? { text: String(op.text ?? '') } : {}), ...(k === 'fill' ? { color: String(op.color ?? '#000000') } : {}),
          };
          if (still && op.end != null && op.start != null) c.out = Math.max(0.2, num(op.end, 3) - num(op.start, 0));
          look(c, op);
          doc.clips.push(c);
          // No time given: after the last clip on its track.
          place(c, op, isMagnetic(doc, track) ? docLength(doc) : doc.clips.filter((x) => x.track === track && x !== c).reduce((m, x) => Math.max(m, clipEnd(x)), 0));
          results.push({ op: 'add', ok: true, id: c.id });
          break;
        }
        case 'generate': {
          if (!submit) throw new Error('generating needs a signed-in account');
          const tool = String(op.tool ?? '');
          if (!getTool(tool)) throw new Error(`no tool ${tool}`);
          // The same list Create shows and the scene AI plans with: no raw graphs, builds or playtests from an edit.
          if (!aiCanUse(tool)) throw new Error(`${tool} is not available from the editor`);
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
          const k = KIND_OF_TOOL(tool);
          const seconds = expectedSeconds(tool, params);
          const where = op.place ?? {};
          if (where.replace) {
            const old = find(where.replace);
            const keep = old.kind === 'image' || old.kind === 'text' || old.kind === 'fill' ? clipLength(old) : seconds;
            Object.assign(old, { asset: null, job: job.id, pending: true, failed: null, kind: k === 'audio' && isVisual(old) ? old.kind : k, in: 0, out: k === 'image' ? keep : seconds, duration: k === 'image' ? null : seconds, label: op.label ?? old.label });
            delete old.scene;
            results.push({ op: 'generate', ok: true, id: old.id, job: job.id });
          } else if (where.track === null || where.library) {
            results.push({ op: 'generate', ok: true, job: job.id });
          } else {
            const track = trackFor(where.track, k);
            const c: Clip = {
              id: newId(), track, kind: k, start: 0, in: 0, out: seconds, duration: k === 'image' ? null : seconds, job: job.id, pending: true,
              label: op.label ?? String(params.prompt ?? params.text ?? tool).slice(0, 120),
            };
            look(c, where);
            doc.clips.push(c);
            place(c, where, isMagnetic(doc, track) ? docLength(doc) : doc.clips.filter((x) => x.track === track && x !== c).reduce((m, x) => Math.max(m, clipEnd(x)), 0));
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
          if (c.kind === 'image' || c.kind === 'text' || c.kind === 'fill') { right.in = 0; right.out = r3(clipLength(c) - (at - c.start)); c.out = r3(at - c.start); } else c.out = r3(cut);
          delete right.transition;
          if (c.transition) { right.transition = c.transition; right.transitionSeconds = c.transitionSeconds; delete c.transition; delete c.transitionSeconds; }
          doc.clips.push(right);
          layout(doc);
          results.push({ op: 'split', ok: true, id: right.id });
          break;
        }
        case 'move': {
          const c = find(op.id);
          if (typeof op.track === 'string') { if (!trackOf(doc, op.track)) throw new Error(`no track ${op.track}`); c.track = op.track; }
          place(c, op, c.start);
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
          // Cuts [start, end) out of the timeline: magnetic tracks close the gap; others lose what was inside and slide back.
          const a = Math.max(0, num(op.start, 0)), b = num(op.end, a);
          if (b <= a) throw new Error('empty range');
          const tracks: Set<string> = new Set(Array.isArray(op.tracks) ? op.tracks : doc.tracks.map((t) => t.id));
          const next: Clip[] = [];
          for (const c of doc.clips) {
            if (!tracks.has(c.track)) { next.push(c); continue; }
            const s = c.start, e = clipEnd(c), sp = c.speed || 1, mag = isMagnetic(doc, c.track);
            if (e <= a || s >= b) { if (s >= b && !mag) c.start = r3(s - (b - a)); next.push(c); continue; }
            if (s < a) next.push({ ...c, out: r3(c.in + (a - s) * sp) });
            if (e > b) next.push({ ...c, id: s < a ? newId() : c.id, start: mag ? a + 0.0001 : r3(a), in: c.kind === 'video' || c.kind === 'audio' ? r3(c.in + (b - s) * sp) : 0, ...(c.kind === 'video' || c.kind === 'audio' ? {} : { out: r3(e - b) }) });
          }
          doc.clips = next;
          layout(doc);
          results.push({ op: 'deleteRange', ok: true });
          break;
        }
        case 'set': {
          const c = find(op.id);
          for (const k of ['volume', 'speed', 'muted', 'transition', 'transitionSeconds', 'zoom', 'text', 'label', 'fadeIn', 'fadeOut'] as const) if (k in op) (c as any)[k] = op[k];
          look(c, op);
          if (op.start != null && !isMagnetic(doc, c.track)) c.start = Math.max(0, num(op.start, c.start));
          if (op.transition === 'cut' || op.transition === null) { delete c.transition; delete c.transitionSeconds; }
          else if (op.transition != null) {
            if (!isTransitionType(op.transition)) throw new Error(`transition is cut or ${['crossfade', 'fadeblack', 'fadewhite', 'slideleft', 'push'].join(', ')}`);
            c.transitionSeconds = clampTransitionSeconds(op.transitionSeconds ?? c.transitionSeconds ?? 0.5);
          } else if (op.transitionSeconds != null && c.transition) {
            c.transitionSeconds = clampTransitionSeconds(op.transitionSeconds);
          }
          results.push({ op: 'set', ok: true, id: c.id });
          break;
        }
        case 'transition': {
          // {"op":"transition","id":"c_...","type":"crossfade","seconds":0.5} add/change; type null|cut removes.
          const c = find(op.id);
          const tr = trackOf(doc, c.track);
          if (!tr || (tr.role !== 'main' && tr.role !== 'video')) throw new Error('transitions sit on a video track');
          const next = doc.clips.filter((x) => x.track === c.track).sort((a, b) => a.start - b.start);
          const i = next.findIndex((x) => x.id === c.id);
          if (i < 0 || i >= next.length - 1 || Math.abs(next[i + 1]!.start - clipEnd(c)) > 0.02) throw new Error('no adjacent clip after this one');
          const type = op.type ?? op.transition;
          if (type == null || type === 'cut' || type === '') {
            delete c.transition;
            delete c.transitionSeconds;
            results.push({ op: 'transition', ok: true, id: c.id });
            break;
          }
          if (!isTransitionType(type)) throw new Error(`transition is cut or crossfade, fadeblack, fadewhite, slideleft, push`);
          c.transition = type;
          c.transitionSeconds = clampTransitionSeconds(op.seconds ?? op.transitionSeconds ?? c.transitionSeconds ?? 0.5);
          // A transition can't be longer than either side of the join.
          const maxT = Math.min(clipLength(c), clipLength(next[i + 1]!)) - 0.05;
          if (c.transitionSeconds > maxT) c.transitionSeconds = clampTransitionSeconds(Math.max(0.2, maxT));
          results.push({ op: 'transition', ok: true, id: c.id });
          break;
        }
        case 'text': {
          const start = Math.max(0, num(op.start, 0));
          const c: Clip = { id: newId(), track: trackFor(op.track, 'text'), kind: 'text', start, in: 0, out: Math.max(0.2, num(op.end, start + 3) - start), text: String(op.text ?? '').slice(0, 2000) };
          look(c, op);
          doc.clips.push(c);
          if (isMagnetic(doc, c.track)) placeMag(c, { start });
          results.push({ op: 'text', ok: true, id: c.id });
          break;
        }
        case 'track': {
          // {"op":"track","add":{name, role, at}} | {"op":"track","id":..., "set":{name, hidden, locked, mute, solo, volume, pan, magnetic}} | {"op":"track","remove": id}
          if (op.add) {
            const t: Track = { id: trackId(), name: String(op.add.name ?? 'Track').slice(0, 40), role: ['main', 'video', 'text', 'audio', 'any'].includes(op.add.role) ? op.add.role : 'any' };
            const at = op.add.at != null ? clamp(Math.round(num(op.add.at, 0)), 0, doc.tracks.length) : t.role === 'audio' ? doc.tracks.length : 0;
            doc.tracks.splice(at, 0, t);
            results.push({ op: 'track', ok: true, id: t.id });
          } else if (op.remove) {
            if (!trackOf(doc, op.remove)) throw new Error(`no track ${op.remove}`);
            if (doc.tracks.length === 1) throw new Error('one track stays');
            doc.tracks = doc.tracks.filter((t) => t.id !== op.remove);
            doc.clips = doc.clips.filter((c) => c.track !== op.remove);
            results.push({ op: 'track', ok: true, id: op.remove });
          } else {
            const t = trackOf(doc, op.id);
            if (!t) throw new Error(`no track ${op.id}`);
            for (const k of ['name', 'hidden', 'locked', 'mute', 'solo', 'volume', 'pan', 'magnetic', 'role'] as const) if (op.set && k in op.set) (t as any)[k] = op.set[k];
            results.push({ op: 'track', ok: true, id: t.id });
          }
          break;
        }
        case 'settings': {
          if (op.title) doc.title = String(op.title).slice(0, 120);
          if (op.width) doc.width = clamp(Math.round(num(op.width, doc.width) / 2) * 2, 16, 4096);
          if (op.height) doc.height = clamp(Math.round(num(op.height, doc.height) / 2) * 2, 16, 4096);
          if (op.fps) doc.fps = clamp(num(op.fps, doc.fps), 8, 60);
          if (op.fit === 'crop' || op.fit === 'pad') doc.fit = op.fit;
          if ('background' in op) doc.background = op.background;
          if ('length' in op) doc.length = op.length;
          if ('bpm' in op) doc.bpm = op.bpm;
          results.push({ op: 'settings', ok: true });
          break;
        }
        default: throw new Error(`unknown op ${op?.op}`);
      }
    } catch (e: any) {
      results.push({ op: String(op?.op ?? '?'), ok: false, error: String(e?.message ?? e) });
    }
  }
  return { doc: normalize(doc, kind), results };
}

/** Fills in clips whose jobs ended: the output (of the clip's kind) when done, the error when failed. */
export function resolvePending(doc: Doc, jobOf: (id: string) => ReturnType<typeof getJob> = getJob): boolean {
  let changed = false;
  for (const c of doc.clips) {
    if (!c.pending || !c.job) continue;
    const j = jobOf(c.job);
    if (!j) { c.pending = false; c.failed = 'The job is gone'; changed = true; continue; }
    if (j.status === 'done') {
      const want = c.kind === 'audio' ? ['audio'] : c.kind === 'image' ? ['image', 'video'] : ['video', 'image'];
      const out = j.outputs.find((o: any) => want.includes(o.kind) && !/mask/i.test(o.title ?? '')) ?? j.outputs.find((o: any) => want.includes(o.kind)) ?? j.outputs[0];
      if (!out) { c.pending = false; c.failed = 'The job made nothing'; changed = true; continue; }
      c.asset = out.asset;
      c.pending = false;
      if (isVisual(c) && (out.kind === 'image' || out.kind === 'video')) c.kind = out.kind;
      changed = true;
    } else if (j.status === 'failed' || j.status === 'cancelled') {
      c.pending = false;
      c.failed = (j.error ?? j.status).split('\n')[0].slice(0, 300);
      changed = true;
    }
  }
  return changed;
}
