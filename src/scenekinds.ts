// The character kind of scene (src/scenes.ts). Video, image and audio are timelines (src/timeline.ts, registered in
// src/editor.ts), stage is src/director.ts.
//
//   character  a person or creature to cast: name, look, height, color, voice, a 3D model, pictures (portrait, front,
//              view sheet, references) and animation clips. A stage's cast member that names it plays them.
//
// Any element can wait on a job: `pending` is its job, and when the job ends the element gets the file (or `failed`).
// The AI marks elements to make with `gen` (src/sceneai.ts), which become `pending` when the jobs are submitted.

import crypto from 'node:crypto';
import { registerKind, sceneRef, kindOf } from './scenes.ts';
import { keptRender } from './editor.ts';
import type { getJob } from './jobs.ts';
import { normalizeLock, normalizeLora, type Lock, type LoraState } from './identity.ts';

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (n: number) => Math.round(n * 100) / 100;
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
      // `from` names the output to take when the job makes several (an asset.make chain's saved steps).
      const named = e.from ? j.outputs.find((o: any) => want.includes(o.kind) && (o.title === e.from || String(o.title ?? '').startsWith(`${e.from}.`))) : null;
      const out = named ?? j.outputs.find((o: any) => want.includes(o.kind) && !/mask/i.test(o.title ?? '')) ?? j.outputs.find((o: any) => want.includes(o.kind)) ?? null;
      if (out) { e.asset = out.asset; delete e.failed; } else e.failed = 'The job made nothing of that kind';
      delete e.pending;
      delete e.from;
      changed = true;
    } else if (j.status === 'failed' || j.status === 'cancelled') {
      delete e.pending;
      e.failed = String(j.error ?? j.status).split('\n')[0].slice(0, 300);
      changed = true;
    }
  }
  return changed;
}

// ------------------------------------------------------------------ character
export const PICTURE_ROLES = ['portrait', 'front', 'sheet', 'reference', 'turnaround', 'cutout'] as const;
export type Picture = { id: string; role: typeof PICTURE_ROLES[number]; asset?: string; pending?: string; failed?: string; gen?: number; from?: string };
export type CharacterDoc = {
  v: 1; title: string; description: string; height: number; color: string; voice: string | null;
  model: { asset?: string; pending?: string; failed?: string; gen?: number } | null;
  pictures: Picture[]; clips: { name: string; asset?: string }[]; notes: string; render?: any;
  /** The identity pack (src/identity.ts): the approved sheet and fixed description; `at` null is a draft. */
  lock?: Lock;
  /** Their LoRA (lora.train), once it's asked for. */
  lora?: LoraState;
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
      ...(typeof p.from === 'string' && /^[\w.-]{1,40}$/.test(p.from) && (p.pending || p.gen != null) ? { from: p.from } : {}),
    })).filter((p: Picture) => p.asset || p.pending || p.failed || p.gen != null),
    clips: (Array.isArray(d.clips) ? d.clips : []).slice(0, 40).filter((c: any) => c && typeof c.name === 'string' && c.name.trim()).map((c: any) => ({ name: c.name.trim().slice(0, 60), ...(asset(c.asset) ? { asset: asset(c.asset)! } : {}) })),
    notes: str(d.notes, 4000),
    ...(keptRender(d.render) ? { render: keptRender(d.render) } : {}),
    ...(normalizeLock(d.lock) ? { lock: normalizeLock(d.lock)! } : {}),
    ...(normalizeLora(d.lora) ? { lora: normalizeLora(d.lora)! } : {}),
  };
}

/**
 * A LoRA being trained: when its job ends, the trained file (the lora.train step's own output, which image.character
 * reads its trigger from) and its trigger word, or why it failed. True when the document changed.
 */
export function resolveLora(doc: CharacterDoc, jobOf: typeof getJob): boolean {
  const l = doc.lora;
  if (l?.state !== 'training' || !l.pending) return false;
  const j = jobOf(l.pending);
  if (!j) { doc.lora = { trigger: l.trigger, state: 'failed', failed: 'The job is gone' }; return true; }
  if (j.status === 'done') {
    // Through asset.make the chain names the lora.train job; its output carries the LoRA's meta.
    const step = ((j.result as any)?.chain ?? []).find((c: any) => c.tool === 'lora.train');
    const train = step ? jobOf(step.job) : j;
    const out = train?.outputs?.find((o: any) => o.kind === 'file') ?? train?.outputs?.[0];
    doc.lora = out ? { asset: out.asset, trigger: String((train?.result as any)?.trigger ?? l.trigger), state: 'ready' } : { trigger: l.trigger, state: 'failed', failed: 'Training made no file' };
    return true;
  }
  if (j.status === 'failed' || j.status === 'cancelled') {
    doc.lora = { trigger: l.trigger, state: 'failed', failed: String(j.error ?? j.status).split('\n')[0].slice(0, 300) };
    return true;
  }
  return false;
}

registerKind('character', {
  normalize: normalizeCharacter,
  blank: (title) => normalizeCharacter({ title: title === 'Untitled' ? 'Unnamed character' : title }),
  resolve: (doc: CharacterDoc, jobOf) => {
    const a = resolveElements(doc.pictures, ['image'], jobOf);
    const b = doc.model ? resolveElements([doc.model], ['mesh'], jobOf) : false;
    const c = resolveLora(doc, jobOf);
    return a || b || c;
  },
});

/** Every element of a scene that can hold a file (for the AI's `gen` marks and `el:` inputs). */
export function fileElements(kind: string, doc: any): any[] {
  if (kind === 'character') return [...doc.pictures, ...(doc.model ? [doc.model] : [])];
  return kindOf(kind).elements?.(doc) ?? [];
}
