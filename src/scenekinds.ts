// The image, audio and character kinds of scene (src/scenes.ts). Video is src/editor.ts, stage src/director.ts.
//
//   image      a picture in layers, bottom first: images (a library file, or another scene's render: a stage photo, an
//              image scene), text and fills, each placed (center x, y and width w in pixels: a new file in the layer
//              keeps its size on the canvas), turned, faded and blended. The
//              app flattens it to render it; Gen's image tools work on any layer (the result replaces that layer's file).
//   audio      a multitrack: tracks (volume, pan, mute, solo) of clips (a library sound, or an audio scene's mixdown)
//              placed in time, trimmed, with gain and fades. The app mixes it down to render it.
//   character  a person or creature to cast: name, look, height, color, voice, a 3D model, pictures (portrait, front,
//              view sheet, references) and animation clips. A stage's cast member that names it plays them.
//
// Any element can wait on a job: `pending` is its job, and when the job ends the element gets the file (or `failed`).
// The AI marks elements to make with `gen` (src/sceneai.ts), which become `pending` when the jobs are submitted.

import crypto from 'node:crypto';
import { registerKind, sceneRef } from './scenes.ts';
import { keptRender } from './editor.ts';
import type { getJob } from './jobs.ts';

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const str = (v: unknown, max: number, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);
const color = (v: unknown, d: string | null) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
const asset = (v: unknown) => (typeof v === 'string' && /^a_[0-9a-f]{6,40}$/.test(v) ? v : null);
const job = (v: unknown) => (typeof v === 'string' && /^j_[0-9a-f]{6,40}$/.test(v) ? v : null);
const idOf = (v: unknown, prefix: string, seen: Set<string>) => {
  const id = typeof v === 'string' && new RegExp(`^${prefix}_[\\w-]{3,24}$`).test(v) && !seen.has(v) ? v : `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
  seen.add(id);
  return id;
};
/** What every element that holds a file carries: the file, the scene it plays, the job it waits on, why it failed, what the AI asked for. */
const fileFields = (e: any) => ({
  ...(asset(e?.asset) ? { asset: asset(e.asset) } : {}),
  ...(sceneRef(e?.scene) ? { scene: sceneRef(e.scene), ...(Number.isFinite(Number(e?.sceneVersion)) ? { sceneVersion: Number(e.sceneVersion) } : {}) } : {}),
  ...(job(e?.pending) ? { pending: job(e.pending) } : {}),
  ...(e?.failed ? { failed: String(e.failed).slice(0, 300) } : {}),
  ...(Number.isInteger(e?.gen) && e.gen >= 0 && e.gen < 20 ? { gen: e.gen } : {}),
});

/**
 * Fills in elements whose jobs ended: the first output of the wanted kind becomes the element's file. True when the
 * document changed.
 */
export function resolveElements(els: any[], want: string[], jobOf: typeof getJob): boolean {
  let changed = false;
  for (const e of els) {
    if (!e?.pending) continue;
    const j = jobOf(e.pending);
    if (!j) { delete e.pending; e.failed = 'The job is gone'; changed = true; continue; }
    if (j.status === 'done') {
      const out = j.outputs.find((o: any) => want.includes(o.kind) && !/mask/i.test(o.title ?? '')) ?? j.outputs.find((o: any) => want.includes(o.kind)) ?? null;
      if (out) { e.asset = out.asset; delete e.failed; } else e.failed = 'The job made nothing of that kind';
      delete e.pending;
      changed = true;
    } else if (j.status === 'failed' || j.status === 'cancelled') {
      delete e.pending;
      e.failed = String(j.error ?? j.status).split('\n')[0].slice(0, 300);
      changed = true;
    }
  }
  return changed;
}

// ------------------------------------------------------------------ image
export const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'lighten', 'darken', 'soft-light', 'difference'] as const;
export type Layer = {
  id: string; name: string; type: 'image' | 'text' | 'fill';
  asset?: string; scene?: string; sceneVersion?: number; pending?: string; failed?: string; gen?: number;
  x: number; y: number; w: number | null; rotation: number; opacity: number; blend: typeof BLENDS[number]; hidden?: boolean; locked?: boolean;
  text?: string; font?: string; size?: number; weight?: number; color?: string; align?: 'left' | 'center' | 'right';
};
export type ImageDoc = { v: 1; title: string; width: number; height: number; background: string | null; layers: Layer[]; render?: any };

export function normalizeImage(input: any): ImageDoc {
  const d = input && typeof input === 'object' ? input : {};
  const width = clamp(Math.round(num(d.width, 1344)), 16, 4096);
  const height = clamp(Math.round(num(d.height, 768)), 16, 4096);
  const seen = new Set<string>();
  const layers: Layer[] = (Array.isArray(d.layers) ? d.layers : []).slice(0, 64).filter((l: any) => l && typeof l === 'object').map((l: any, i: number) => {
    const type = l.type === 'text' ? 'text' : l.type === 'fill' ? 'fill' : 'image';
    return {
      id: idOf(l.id, 'l', seen), name: str(l.name, 60, type === 'text' ? 'Text' : type === 'fill' ? 'Fill' : `Layer ${i + 1}`) || `Layer ${i + 1}`, type,
      ...(type === 'image' ? fileFields(l) : Number.isInteger(l.gen) ? { gen: l.gen } : {}),
      x: r2(clamp(num(l.x, width / 2), -width * 4, width * 5)), y: r2(clamp(num(l.y, height / 2), -height * 4, height * 5)),
      w: l.w == null ? null : r2(clamp(num(l.w, width), 1, 40000)), rotation: r2(num(l.rotation, 0) % 360), opacity: r2(clamp(num(l.opacity, 1), 0, 1)),
      blend: (BLENDS as readonly string[]).includes(l.blend) ? l.blend : 'normal',
      ...(l.hidden ? { hidden: true } : {}), ...(l.locked ? { locked: true } : {}),
      ...(type === 'text' ? { text: str(l.text, 2000, 'Text'), font: str(l.font, 60, 'Inter') || 'Inter', size: r2(clamp(num(l.size, 72), 4, 1000)), weight: clamp(Math.round(num(l.weight, 700) / 100) * 100, 100, 900), color: color(l.color, '#ffffff')!, align: ['left', 'center', 'right'].includes(l.align) ? l.align : 'center' } : {}),
      ...(type === 'fill' ? { color: color(l.color, '#000000')! } : {}),
    };
  });
  return { v: 1, title: str(d.title, 120, 'Untitled image') || 'Untitled image', width, height, background: color(d.background, null), layers, ...(keptRender(d.render) ? { render: keptRender(d.render) } : {}) };
}

registerKind('image', {
  normalize: normalizeImage,
  blank: (title) => normalizeImage({ title: title === 'Untitled' ? 'Untitled image' : title, background: '#1b1e26' }),
  resolve: (doc: ImageDoc, jobOf) => resolveElements(doc.layers, ['image'], jobOf),
  uses: (doc: ImageDoc) => doc.layers.map((l) => l.scene).filter(Boolean) as string[],
});

// ------------------------------------------------------------------ audio
export type AudioClip = { id: string; label: string; asset?: string; scene?: string; sceneVersion?: number; pending?: string; failed?: string; gen?: number; start: number; in: number; out: number; duration?: number | null; gain: number; fadeIn: number; fadeOut: number };
export type Track = { id: string; name: string; volume: number; pan: number; mute?: boolean; solo?: boolean; color: string; clips: AudioClip[] };
export type AudioDoc = { v: 1; title: string; bpm: number | null; tracks: Track[]; render?: any };
const TRACK_COLORS = ['#1fa3b8', '#1fb88a', '#e0a83a', '#a15bff', '#ff6b81', '#5b6cff'];

export function normalizeAudio(input: any): AudioDoc {
  const d = input && typeof input === 'object' ? input : {};
  const tseen = new Set<string>(), cseen = new Set<string>();
  const tracks: Track[] = (Array.isArray(d.tracks) ? d.tracks : []).slice(0, 24).filter((t: any) => t && typeof t === 'object').map((t: any, i: number) => ({
    id: idOf(t.id, 't', tseen), name: str(t.name, 40, `Track ${i + 1}`) || `Track ${i + 1}`,
    volume: r2(clamp(num(t.volume, 1), 0, 2)), pan: r2(clamp(num(t.pan, 0), -1, 1)), ...(t.mute ? { mute: true } : {}), ...(t.solo ? { solo: true } : {}),
    color: color(t.color, TRACK_COLORS[i % TRACK_COLORS.length])!,
    clips: (Array.isArray(t.clips) ? t.clips : []).slice(0, 200).filter((c: any) => c && typeof c === 'object').map((c: any) => {
      const duration = c.duration == null ? null : Math.max(0, num(c.duration, 0)) || null;
      const inn = Math.max(0, num(c.in, 0));
      let out = num(c.out, duration ?? inn + 4);
      if (duration) out = Math.min(out, duration);
      if (out <= inn + 0.02) out = inn + 0.02;
      return {
        id: idOf(c.id, 'k', cseen), label: str(c.label, 120), ...fileFields(c),
        start: r3(clamp(num(c.start, 0), 0, 3600)), in: r3(inn), out: r3(out), duration: duration ? r3(duration) : null,
        gain: r2(clamp(num(c.gain, 1), 0, 4)), fadeIn: r2(clamp(num(c.fadeIn, 0), 0, 30)), fadeOut: r2(clamp(num(c.fadeOut, 0), 0, 30)),
      };
    }).filter((c: AudioClip) => c.asset || c.scene || c.pending || c.gen != null || c.failed),
  }));
  return { v: 1, title: str(d.title, 120, 'Untitled audio') || 'Untitled audio', bpm: d.bpm == null ? null : Math.round(clamp(num(d.bpm, 120), 30, 300)), tracks, ...(keptRender(d.render) ? { render: keptRender(d.render) } : {}) };
}

registerKind('audio', {
  normalize: normalizeAudio,
  blank: (title) => normalizeAudio({ title: title === 'Untitled' ? 'Untitled audio' : title, tracks: [{ name: 'Music' }, { name: 'Voice' }, { name: 'Sound' }] }),
  resolve: (doc: AudioDoc, jobOf) => resolveElements(doc.tracks.flatMap((t) => t.clips), ['audio'], jobOf),
  uses: (doc: AudioDoc) => doc.tracks.flatMap((t) => t.clips.map((c) => c.scene)).filter(Boolean) as string[],
});

// ------------------------------------------------------------------ character
export const PICTURE_ROLES = ['portrait', 'front', 'sheet', 'reference', 'turnaround', 'cutout'] as const;
export type Picture = { id: string; role: typeof PICTURE_ROLES[number]; asset?: string; pending?: string; failed?: string; gen?: number };
export type CharacterDoc = {
  v: 1; title: string; description: string; height: number; color: string; voice: string | null;
  model: { asset?: string; pending?: string; failed?: string; gen?: number } | null;
  pictures: Picture[]; clips: { name: string; asset?: string }[]; notes: string; render?: any;
};

export function normalizeCharacter(input: any): CharacterDoc {
  const d = input && typeof input === 'object' ? input : {};
  const seen = new Set<string>();
  const m = d.model && typeof d.model === 'object' ? fileFields(d.model) : null;
  return {
    v: 1, title: str(d.title ?? d.name, 80, 'Unnamed character') || 'Unnamed character',
    description: str(d.description, 1500), height: r2(clamp(num(d.height, 1.75), 0.1, 30)), color: color(d.color, '#c8a27a')!,
    voice: typeof d.voice === 'string' && /^[\w-]{4,64}$/.test(d.voice) ? d.voice : null,
    model: m && (m.asset || m.pending || m.failed || m.gen != null) ? { ...(m.asset ? { asset: m.asset } : {}), ...(m.pending ? { pending: m.pending } : {}), ...(m.failed ? { failed: m.failed } : {}), ...(m.gen != null ? { gen: m.gen } : {}) } : null,
    pictures: (Array.isArray(d.pictures) ? d.pictures : []).slice(0, 24).filter((p: any) => p && typeof p === 'object').map((p: any) => ({
      id: idOf(p.id, 'p', seen), role: (PICTURE_ROLES as readonly string[]).includes(p.role) ? p.role : 'reference',
      ...(asset(p.asset) ? { asset: asset(p.asset)! } : {}), ...(job(p.pending) ? { pending: job(p.pending)! } : {}),
      ...(p.failed ? { failed: String(p.failed).slice(0, 300) } : {}), ...(Number.isInteger(p.gen) && p.gen >= 0 && p.gen < 20 ? { gen: p.gen } : {}),
    })).filter((p: Picture) => p.asset || p.pending || p.failed || p.gen != null),
    clips: (Array.isArray(d.clips) ? d.clips : []).slice(0, 40).filter((c: any) => c && typeof c.name === 'string' && c.name.trim()).map((c: any) => ({ name: c.name.trim().slice(0, 60), ...(asset(c.asset) ? { asset: asset(c.asset)! } : {}) })),
    notes: str(d.notes, 4000),
    ...(keptRender(d.render) ? { render: keptRender(d.render) } : {}),
  };
}

registerKind('character', {
  normalize: normalizeCharacter,
  blank: (title) => normalizeCharacter({ title: title === 'Untitled' ? 'Unnamed character' : title }),
  resolve: (doc: CharacterDoc, jobOf) => {
    const a = resolveElements(doc.pictures, ['image'], jobOf);
    const b = doc.model ? resolveElements([doc.model], ['mesh'], jobOf) : false;
    return a || b;
  },
});

/** Every element of a scene that can hold a file (for the AI's `gen` marks and `el:` inputs). */
export function fileElements(kind: string, doc: any): any[] {
  if (kind === 'image') return doc.layers;
  if (kind === 'audio') return doc.tracks.flatMap((t: any) => t.clips);
  if (kind === 'character') return [...doc.pictures, ...(doc.model ? [doc.model] : [])];
  return [];
}
