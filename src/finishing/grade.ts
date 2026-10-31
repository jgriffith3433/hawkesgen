// One color grade per world (docs/finishing.md): a LUT (.cube asset) or simple params turned into ffmpeg filters, plus
// optional film grain and a vignette. video.compose applies it to the whole cut (an optional `grade` param), and
// video.grade applies it to any clip. Pure: the tests check the filter strings.

import { GenError } from '../util.ts';

/** Simple grade params. Every one is optional; 0 (or 1 for the multipliers) leaves the picture as it is. */
export type GradeParams = {
  /** 1 = as is; 1.15 = more contrast. 0.5 to 2. */
  contrast?: number;
  /** 1 = as is; 0 = black and white. 0 to 3. */
  saturation?: number;
  /** -1 (cool, blue) to 1 (warm, orange). */
  warmth?: number;
  /** -1 (green) to 1 (magenta). */
  tint?: number;
  /** Raises the blacks: 0 to 0.3. */
  lift?: number;
  /** Midtones: 1 = as is; above 1 brighter. 0.5 to 2. */
  gamma?: number;
  /** Highlights: 1 = as is; 0.8 darker, 1.2 brighter. 0.5 to 1.5. */
  gain?: number;
  /** -0.5 to 0.5. */
  brightness?: number;
};

export type Grade = {
  /** A LUT file path (resolved from a .cube asset before planning). */
  lutFile?: string;
  params?: GradeParams;
  /** Film grain, 0 (none) to 1 (heavy). */
  grain?: number;
  /** Vignette, 0 (none) to 1 (strong). */
  vignette?: number;
};

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const f3 = (n: number) => String(Math.round(n * 1000) / 1000);
/** ffmpeg filter-graph escaping for a path inside a filter argument (Windows drive colons, quotes). */
export const escapeFilterPath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** True when the grade changes nothing. */
export function isNeutral(g: Grade | null | undefined): boolean {
  return !g || gradeFilters(g).length === 0;
}

/** The ffmpeg filters (in order) for a grade. Empty for a neutral grade. */
export function gradeFilters(g: Grade): string[] {
  const out: string[] = [];
  // The LUT first (the world's look), then the simple params trim it. Filters stay one linear chain (compose joins them).
  if (g.lutFile) out.push(`lut3d=file='${escapeFilterPath(g.lutFile)}'`);
  const p = g.params ?? {};
  // Lift and gain as levels: lift raises the output black point, gain scales the white point.
  const lift = clamp(p.lift, 0, 0.3, 0);
  const gain = clamp(p.gain, 0.5, 1.5, 1);
  if (lift > 0.001 || Math.abs(gain - 1) > 0.001) {
    const omax = Math.min(1, gain);
    const imax = gain > 1 ? 1 / gain : 1;
    out.push(`colorlevels=romin=${f3(lift)}:gomin=${f3(lift)}:bomin=${f3(lift)}:romax=${f3(omax)}:gomax=${f3(omax)}:bomax=${f3(omax)}:rimax=${f3(imax)}:gimax=${f3(imax)}:bimax=${f3(imax)}`);
  }
  const eq: string[] = [];
  const contrast = clamp(p.contrast, 0.5, 2, 1);
  const saturation = clamp(p.saturation, 0, 3, 1);
  const gamma = clamp(p.gamma, 0.5, 2, 1);
  const brightness = clamp(p.brightness, -0.5, 0.5, 0);
  if (Math.abs(contrast - 1) > 0.001) eq.push(`contrast=${f3(contrast)}`);
  if (Math.abs(brightness) > 0.001) eq.push(`brightness=${f3(brightness)}`);
  if (Math.abs(saturation - 1) > 0.001) eq.push(`saturation=${f3(saturation)}`);
  if (Math.abs(gamma - 1) > 0.001) eq.push(`gamma=${f3(gamma)}`);
  if (eq.length) out.push(`eq=${eq.join(':')}`);
  // Warmth pushes red up and blue down (and back), tint pushes green against magenta; strongest in the midtones.
  const warmth = clamp(p.warmth, -1, 1, 0);
  const tint = clamp(p.tint, -1, 1, 0);
  if (Math.abs(warmth) > 0.001 || Math.abs(tint) > 0.001) {
    const w = warmth * 0.25, t = tint * 0.2;
    out.push(`colorbalance=rs=${f3(w * 0.5)}:bs=${f3(-w * 0.5)}:rm=${f3(w)}:gm=${f3(-t)}:bm=${f3(-w)}:rh=${f3(w * 0.4)}:bh=${f3(-w * 0.4)}`);
  }
  const vignette = clamp(g.vignette, 0, 1, 0);
  if (vignette > 0.001) out.push(`vignette=angle=${f3(0.2 + vignette * 0.5)}`);
  const grain = clamp(g.grain, 0, 1, 0);
  if (grain > 0.001) out.push(`noise=c0s=${Math.round(4 + grain * 20)}:c0f=t+u`);
  return out;
}

/** The grade a world's look names (`WorldLook.grade`), with the LUT asset resolved to a file by the caller. */
export function gradeFromWorld(look: { grade: { lut?: string; params?: Record<string, number> } | null } | null | undefined, lutFile?: string | null): Grade | null {
  const g = look?.grade;
  if (!g) return null;
  return { ...(lutFile ? { lutFile } : {}), ...(g.params ? { params: g.params as GradeParams, grain: g.params.grain, vignette: g.params.vignette } : {}) };
}

/** A `grade` param as given to a tool (an object, or JSON) checked into a Grade (LUT file set by the caller). */
export function parseGrade(v: unknown): Grade | null {
  if (v == null || v === '') return null;
  const o = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { throw new GenError('grade is JSON: { "params": { "contrast": 1.1, "warmth": 0.2 }, "grain": 0.2 }'); } })() : v;
  if (typeof o !== 'object' || Array.isArray(o)) throw new GenError('grade is an object: { params, grain, vignette }');
  const params = (o as any).params && typeof (o as any).params === 'object' ? (o as any).params : Object.fromEntries(Object.entries(o).filter(([k]) => ['contrast', 'saturation', 'warmth', 'tint', 'lift', 'gamma', 'gain', 'brightness'].includes(k)));
  return { params, grain: (o as any).grain, vignette: (o as any).vignette };
}

/** Grade presets the app offers as simple choices (a world's own grade comes first). */
export const GRADE_PRESETS: Record<string, Grade> = {
  natural: { params: {} },
  warm: { params: { warmth: 0.35, contrast: 1.05, saturation: 1.05 } },
  cool: { params: { warmth: -0.35, contrast: 1.05, saturation: 0.95 } },
  filmic: { params: { contrast: 1.12, saturation: 0.9, lift: 0.04, gain: 0.97 }, grain: 0.25, vignette: 0.3 },
  noir: { params: { saturation: 0, contrast: 1.3, gamma: 0.95 }, grain: 0.4, vignette: 0.5 },
  vivid: { params: { saturation: 1.3, contrast: 1.1 } },
  faded: { params: { lift: 0.1, contrast: 0.9, saturation: 0.8 }, grain: 0.2 },
};
