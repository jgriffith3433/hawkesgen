// Transition maths for the editor preview and applyOps (kept in step with dashboard/gen/transitions.js).
// Progress k is 0 at the start of the join (mostly the outgoing clip) and 1 at the end (mostly the incoming).
// Offsets are shares of the frame width/height (positive x = to the right).

export const TRANSITION_MIN = 0.2;
export const TRANSITION_MAX = 2;

/** Types the AI and the join menu can set (names match video.compose's xfade map; `push` is a push-left). */
export const TRANSITION_TYPES = [
  'crossfade', 'dissolve', 'fadeblack', 'fadewhite',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'push',
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

export type TransitionSample = {
  /** Outgoing clip opacity (0..1). */
  aOut: number;
  /** Incoming clip opacity (0..1). */
  aIn: number;
  /** Outgoing clip offset as shares of the frame (x right, y down). */
  oxOut: number;
  oyOut: number;
  /** Incoming clip offset as shares of the frame. */
  oxIn: number;
  oyIn: number;
  /** Dip fill colour when fading through black/white, else null. */
  fill: '#000' | '#fff' | null;
  /** Dip fill opacity (0..1). */
  fillA: number;
  /** Soft wipe: keep the right/left/… fraction of the frame for the incoming clip (null = full frame). */
  clipIn: { x: number; y: number; w: number; h: number } | null;
};

const TYPES = new Set<string>(TRANSITION_TYPES);

export function isTransitionType(v: unknown): v is TransitionType {
  return typeof v === 'string' && TYPES.has(v);
}

/** Seconds clamped to the editor's handle range (0.2–2). */
export function clampTransitionSeconds(v: unknown, fallback = 0.5): number {
  const n = Number(v);
  const d = Number.isFinite(n) ? n : fallback;
  return Math.min(TRANSITION_MAX, Math.max(TRANSITION_MIN, Math.round(d * 100) / 100));
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * One sample of a transition at progress k (0..1). Matches ffmpeg xfade for the named types; `push` is a push-left
 * (outgoing slides off left while incoming enters from the right) so the preview and a browser export stay in step.
 */
export function sampleTransition(type: string, k0: number): TransitionSample {
  const k = clamp01(k0);
  const base: TransitionSample = { aOut: 1, aIn: 1, oxOut: 0, oyOut: 0, oxIn: 0, oyIn: 0, fill: null, fillA: 0, clipIn: null };
  if (!type || type === 'cut') return { ...base, aIn: 0 };

  if (type === 'crossfade' || type === 'dissolve') {
    return { ...base, aOut: 1 - k, aIn: k };
  }

  if (type === 'fadeblack' || type === 'fadewhite') {
    const fill = type === 'fadewhite' ? '#fff' : '#000';
    if (k < 0.5) {
      const u = k * 2;
      return { ...base, aOut: 1 - u, aIn: 0, fill, fillA: u };
    }
    const u = (k - 0.5) * 2;
    return { ...base, aOut: 0, aIn: u, fill, fillA: 1 - u };
  }

  if (type === 'wipeleft') return { ...base, aOut: 1, aIn: 1, clipIn: { x: 1 - k, y: 0, w: k, h: 1 } };
  if (type === 'wiperight') return { ...base, aOut: 1, aIn: 1, clipIn: { x: 0, y: 0, w: k, h: 1 } };
  if (type === 'wipeup') return { ...base, aOut: 1, aIn: 1, clipIn: { x: 0, y: 1 - k, w: 1, h: k } };
  if (type === 'wipedown') return { ...base, aOut: 1, aIn: 1, clipIn: { x: 0, y: 0, w: 1, h: k } };

  if (type === 'slideleft') {
    // Incoming slides in from the right over a still outgoing (ffmpeg slideleft).
    return { ...base, oxIn: 1 - k, clipIn: { x: 1 - k, y: 0, w: k, h: 1 } };
  }
  if (type === 'slideright') {
    return { ...base, oxIn: k - 1, clipIn: { x: 0, y: 0, w: k, h: 1 } };
  }
  if (type === 'push') {
    // Push left: outgoing slides off, incoming enters from the right.
    return { ...base, oxOut: -k, oxIn: 1 - k };
  }

  // Unknown: treat as a crossfade so a stale document still blends.
  return { ...base, aOut: 1 - k, aIn: k };
}

/**
 * Precompute samples for one join at `fps` (one entry per output frame across the transition).
 * `progress` for frame i is (i + 0.5) / frames so the middle frame is the midpoint.
 */
export function precomputeTransition(type: string, seconds: number, fps: number): TransitionSample[] {
  const T = clampTransitionSeconds(seconds);
  const frames = Math.max(1, Math.round(T * Math.max(1, fps)));
  const out: TransitionSample[] = [];
  for (let i = 0; i < frames; i++) out.push(sampleTransition(type, (i + 0.5) / frames));
  return out;
}

/** Look up a precomputed sample for timeline time `t` inside a join that ends at `joinEnd` and lasts `seconds`. */
export function sampleAt(table: TransitionSample[], t: number, joinEnd: number, seconds: number): TransitionSample | null {
  const T = clampTransitionSeconds(seconds);
  const start = joinEnd - T;
  if (t < start || t >= joinEnd || !table.length) return null;
  const u = (t - start) / T;
  const i = Math.min(table.length - 1, Math.max(0, Math.floor(u * table.length)));
  return table[i]!;
}
