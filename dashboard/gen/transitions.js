// Transition maths for the canvas preview (kept in step with src/transitions.ts). Precompute once when the doc
// changes; the rAF loop only indexes the table — no layout reads.

export const TRANSITION_MIN = 0.2;
export const TRANSITION_MAX = 2;

export const TRANSITION_TYPES = [
  'crossfade', 'dissolve', 'fadeblack', 'fadewhite',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'push',
];

const TYPES = new Set(TRANSITION_TYPES);

export function isTransitionType(v) {
  return typeof v === 'string' && TYPES.has(v);
}

export function clampTransitionSeconds(v, fallback = 0.5) {
  const n = Number(v);
  const d = Number.isFinite(n) ? n : fallback;
  return Math.min(TRANSITION_MAX, Math.max(TRANSITION_MIN, Math.round(d * 100) / 100));
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** One sample at progress k (0..1). Same rules as src/transitions.ts. */
export function sampleTransition(type, k0) {
  const k = clamp01(k0);
  const base = { aOut: 1, aIn: 1, oxOut: 0, oyOut: 0, oxIn: 0, oyIn: 0, fill: null, fillA: 0, clipIn: null };
  if (!type || type === 'cut') return { ...base, aIn: 0 };

  if (type === 'crossfade' || type === 'dissolve') return { ...base, aOut: 1 - k, aIn: k };

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

  if (type === 'slideleft') return { ...base, oxIn: 1 - k, clipIn: { x: 1 - k, y: 0, w: k, h: 1 } };
  if (type === 'slideright') return { ...base, oxIn: k - 1, clipIn: { x: 0, y: 0, w: k, h: 1 } };
  if (type === 'push') return { ...base, oxOut: -k, oxIn: 1 - k };

  return { ...base, aOut: 1 - k, aIn: k };
}

export function precomputeTransition(type, seconds, fps) {
  const T = clampTransitionSeconds(seconds);
  const frames = Math.max(1, Math.round(T * Math.max(1, fps)));
  const out = [];
  for (let i = 0; i < frames; i++) out.push(sampleTransition(type, (i + 0.5) / frames));
  return out;
}

export function sampleAt(table, t, joinEnd, seconds) {
  const T = clampTransitionSeconds(seconds);
  const start = joinEnd - T;
  if (t < start || t >= joinEnd || !table.length) return null;
  const u = (t - start) / T;
  const i = Math.min(table.length - 1, Math.max(0, Math.floor(u * table.length)));
  return table[i];
}

/** Labels for the join menu (brief: crossfade, dip to black/white, slide/push). */
export const TRANSITION_MENU = [
  ['cut', 'Cut'],
  ['crossfade', 'Crossfade'],
  ['fadeblack', 'Dip to black'],
  ['fadewhite', 'Dip to white'],
  ['slideleft', 'Slide'],
  ['push', 'Push'],
];
