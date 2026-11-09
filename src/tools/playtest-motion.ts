// Motion for the playtest review: the judge watches short stretches of the run's video, not only stills.
//
// A still can't show a camera snap, jitter, a hitch or a body clipping through a wall as it moves; 15 frames a second
// can. Each window is ~1.2 s of the video at 15 fps tiled into one contact sheet (6 x 3, read left to right, top to
// bottom), so Claude sees motion at the cost of one image per window. Windows sit on the feel sensor's flags first
// (bugs, then the most repeated), then problems and scene changes, then even spacing across the run.
//
// videoFreezes() is a per-frame hitch detector that needs nothing from the game: ffmpeg's freezedetect on the recording.
// The screencast repeats the last frame when the game draws nothing new, so a short freeze in the middle of motion is a
// hitch a player sees. Long freezes (a menu, a still title card) are not counted.

import fs from 'node:fs';
import type { RunContext } from './types.ts';
import { run as runProc } from '../util.ts';

export const MOTION_FPS = 15;
export const MOTION_SECONDS = 1.2;
export const MOTION_COLS = 6;
export const MOTION_ROWS = 3;
/** A freeze this long or longer in the middle of motion is a hitch; from HITCH_MAX on it's a still screen, not a hitch. */
export const HITCH_MIN = 0.15;
export const HITCH_MAX = 1.0;

export type MotionMark = { t: number; reason: string; priority: number; scene?: string; detail?: string };
export type MotionWindow = { start: number; end: number; t: number; reason: string; scene?: string; detail?: string };

/**
 * Where the windows go: marks by priority (lower first), then time; a window never overlaps one already picked; what's
 * left is filled with even spacing over the run. Pure, so it's tested without ffmpeg.
 */
export function pickMotionWindows(marks: MotionMark[], seconds: number, { max = 6, len = MOTION_SECONDS, lead = 0.8 } = {}): MotionWindow[] {
  const dur = Math.max(0, Number(seconds) || 0);
  if (!max || dur < len) return [];
  const out: MotionWindow[] = [];
  const clash = (s: number) => out.some((w) => s < w.end && s + len > w.start);
  const add = (m: { t: number; reason: string; scene?: string; detail?: string }) => {
    const start = Math.min(Math.max(0, m.t - lead), Math.max(0, dur - len));
    if (out.length >= max || clash(start)) return;
    out.push({ start: round(start), end: round(start + len), t: round(m.t), reason: m.reason, ...(m.scene ? { scene: m.scene } : {}), ...(m.detail ? { detail: m.detail.slice(0, 160) } : {}) });
  };
  const sorted = marks.filter((m) => Number.isFinite(m.t) && m.t >= 0 && m.t <= dur).sort((a, b) => a.priority - b.priority || a.t - b.t);
  // At most two thirds from marks, so the run's ordinary play is watched too.
  const fromMarks = Math.max(1, Math.ceil(max * 2 / 3));
  for (const m of sorted) {
    if (out.length >= fromMarks) break;
    add(m);
  }
  for (let i = 0, want = max - out.length; i < want * 3 && out.length < max; i++) {
    const t = ((i % want) + 0.5 + Math.floor(i / want) * 0.33) * (dur / want);
    add({ t: Math.min(dur, t), reason: 'play' });
  }
  return out.sort((a, b) => a.start - b.start);
}

const round = (x: number) => Math.round(x * 100) / 100;

/** The marks a playtest result offers: feel flags (bugs first), problems with a time, then scene shots. */
export function motionMarks(result: any, shots: { meta: any }[]): MotionMark[] {
  const marks: MotionMark[] = [];
  const flags: any[] = Array.isArray(result?.feel) ? result.feel : [];
  const withRt = flags.find((f) => f?.rt != null);
  const offset = withRt ? withRt.rt - withRt.t : 0;
  for (const f of flags) {
    const t = f.rt ?? (Number.isFinite(f.t) ? Math.max(0, f.t + offset) : NaN);
    marks.push({ t, reason: `feel:${f.kind}`, priority: f.severity === 'bug' ? 0 : (f.count ?? 1) > 1 ? 1 : 2, scene: f.scene, detail: f.detail });
  }
  for (const s of shots) {
    const r = String(s.meta?.reason ?? '');
    const t = Number(s.meta?.t);
    if (r === 'problem') marks.push({ t, reason: 'problem', priority: 1, scene: s.meta.scene });
    else if (r === 'scene') marks.push({ t, reason: 'scene', priority: 3, scene: s.meta.scene });
  }
  return marks;
}

/** One contact sheet per window (MOTION_FPS frames tiled), written to ctx.tmp; windows that fail are left out. */
export async function motionStrips(ctx: RunContext, video: string, windows: MotionWindow[], { width = 256 } = {}) {
  const out: (MotionWindow & { file: string; frames: number })[] = [];
  if (!fs.existsSync(video)) return out;
  const frames = MOTION_COLS * MOTION_ROWS;
  for (const [i, w] of windows.entries()) {
    const file = ctx.tmp(`motion-${i}.jpg`);
    try {
      await runProc('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(w.start), '-i', video, '-t', String(w.end - w.start), '-an',
        '-vf', `fps=${MOTION_FPS},scale=${width}:-2,tile=${MOTION_COLS}x${MOTION_ROWS}:padding=2:color=white`, '-frames:v', '1', '-q:v', '4', file],
        { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]) });
      if (fs.existsSync(file) && fs.statSync(file).size > 1000) out.push({ ...w, file, frames });
    } catch (e: any) {
      ctx.log(`motion strip at ${w.start}s: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return out;
}

/** freezedetect's log -> freezes [{ t, seconds }]; an unfinished freeze (the video ended) is dropped. Pure. */
export function parseFreezes(log: string) {
  const out: { t: number; seconds: number }[] = [];
  let start: number | null = null;
  for (const line of String(log).split('\n')) {
    const s = /freeze_start[=:]\s*([\d.]+)/.exec(line);
    if (s) { start = Number(s[1]); continue; }
    const d = /freeze_duration[=:]\s*([\d.]+)/.exec(line);
    if (d && start != null) { out.push({ t: round(start), seconds: round(Number(d[1])) }); start = null; }
  }
  return out;
}

/** Short freezes in the middle of motion: hitches a player sees. */
export function hitchesOf(freezes: { t: number; seconds: number }[]) {
  return freezes.filter((f) => f.seconds >= HITCH_MIN && f.seconds < HITCH_MAX).map((f) => ({ t: f.t, ms: Math.round(f.seconds * 1000) }));
}

/** The recording's hitches (see the header). Null when ffmpeg couldn't read it. */
export async function videoFreezes(ctx: RunContext, video: string) {
  if (!fs.existsSync(video)) return null;
  try {
    // freezedetect's events go to a file (the metadata filter's print), not stderr, which runProc keeps only on failure.
    const file = ctx.tmp('freezes.txt');
    await runProc('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-an', '-vf', `freezedetect=n=-60dB:d=${HITCH_MIN},metadata=mode=print:file=${file.replace(/[\\:']/g, (c) => `\\${c}`)}`, '-f', 'null', '-'],
      { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]) });
    const freezes = parseFreezes(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    return { freezes: freezes.length, hitches: hitchesOf(freezes) };
  } catch (e: any) {
    ctx.log(`video freezes: ${String(e?.message ?? e).slice(0, 200)}`);
    return null;
  }
}

/** What the review is told about the motion sheets (indexes start at `first`). */
export function motionLegend(strips: MotionWindow[], first: number) {
  if (!strips.length) return '';
  return [
    `MOTION (${strips.length} contact sheets, each ${MOTION_SECONDS} s of the video at ${MOTION_FPS} fps: ${MOTION_COLS * MOTION_ROWS} frames read left to right, top to bottom).`,
    'Judge movement here: a camera that snaps, jumps or shakes between neighbouring frames, the camera passing into walls, a',
    'character or prop sliding through geometry, popping, jitter, or the same frame repeated (a hitch). These are bugs a',
    'player feels even when every still looks fine. Cite these indexes as evidence like screenshots.',
    ...strips.map((w, i) => `[${first + i}] ${w.start}s to ${w.end}s around ${w.reason} at ${w.t}s${w.scene ? ` (${w.scene})` : ''}${w.detail ? `: ${w.detail}` : ''}`),
  ].join('\n');
}
