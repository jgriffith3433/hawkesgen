// The playtest "feel" layer (hawkesstudio docs/playtest.md#feel): what players find annoying in a 3D game.
// - The game's sensor (hawkesstudio clients/web/hawkes-feel.js, or the Unity HawkesFeel component) pushes each flag
//   the moment it happens through a Playwright binding (window.__hawkesPlaytestPush): no polling.
// - The runner takes a screenshot at each flag and, after the run, cuts a short clip around the worst ones.
// - A cheap vision pass (Haiku) scores a handful of frames against the polish rubric (ugly buildings, z-fighting,
//   floating objects, stretched textures, clipping); its hits and the flags go to the review and on to Studio,
//   where each becomes a bug that can be replayed at the same spot (seed + spot).
import fs from 'node:fs';
import type { RunContext } from './types.ts';
import { run as runProc } from '../util.ts';
import { ask, usageOf } from '../providers/anthropic.ts';

export const PUSH_BINDING = '__hawkesPlaytestPush';

export type FeelFlag = {
  id: string; kind: string; severity: 'bug' | 'polish'; t: number; pos: number[] | null;
  cam?: { pos: number[] | null; yaw: number; pitch: number }; seed?: number; scene?: string; value?: number; detail: string; count?: number;
  /** runner time (seconds since recording began) when the flag arrived: lines it up with the video and shots */
  rt?: number;
  /** "x,y,z[,yaw]": options.spot for a replay at this place */
  spot?: string;
  shot?: string | null; clip?: string | null;
};

export const FEEL_KINDS = ['camera-snap', 'camera-jump', 'camera-blocked', 'below-ground', 'fell-out', 'inside-geometry', 'stuck', 'collision-pop', 'jitter', 'hitch'];
const MAX_FLAGS = 200;
const MAX_FEEL_SHOTS = 24;
const SHOT_GAP_MS = 1500;

const num = (x: any) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);

/** A flag from the page, cleaned: only the fields we know, bounded strings and numbers. Null when it isn't one. */
export function cleanFlag(raw: any, rt?: number): FeelFlag | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind ?? '').slice(0, 40);
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) return null;
  const pos = Array.isArray(raw.pos) && raw.pos.length >= 3 ? raw.pos.slice(0, 3).map(num) : null;
  const validPos = pos && pos.every((v: any) => v != null) ? (pos as number[]) : null;
  const cam = raw.cam && typeof raw.cam === 'object'
    ? { pos: Array.isArray(raw.cam.pos) ? raw.cam.pos.slice(0, 3).map(num) : null, yaw: num(raw.cam.yaw) ?? 0, pitch: num(raw.cam.pitch) ?? 0 }
    : undefined;
  const f: FeelFlag = {
    id: String(raw.id ?? `feel-${kind}`).slice(0, 40),
    kind,
    severity: raw.severity === 'bug' ? 'bug' : 'polish',
    t: num(raw.t) ?? 0,
    pos: validPos,
    ...(cam ? { cam } : {}),
    ...(Number.isFinite(Number(raw.seed)) ? { seed: Number(raw.seed) } : {}),
    ...(raw.scene ? { scene: String(raw.scene).slice(0, 80) } : {}),
    ...(num(raw.value) != null ? { value: num(raw.value)! } : {}),
    detail: String(raw.detail ?? kind).slice(0, 200),
    count: Math.max(1, Math.min(1e6, Math.round(Number(raw.count) || 1))),
    ...(rt != null ? { rt } : {}),
  };
  if (validPos) f.spot = `${validPos.join(',')}${cam ? `,${cam.yaw}` : ''}`;
  return f;
}

/** Collects the flags a run pushes, and says when one deserves a screenshot. */
export class FeelLog {
  flags: FeelFlag[] = [];
  private lastShot = 0;
  private shots = 0;
  /** A pushed message; returns the flag when a screenshot should be taken for it now. */
  push(msg: any, rt: number, now = Date.now()): FeelFlag | null {
    if (!msg || msg.type !== 'feel') return null;
    const f = cleanFlag(msg.flag, rt);
    if (!f || this.flags.length >= MAX_FLAGS) return null;
    const had = this.flags.find((x) => x.id === f.id);
    if (had) { Object.assign(had, { count: f.count, value: f.value ?? had.value }); return null; }
    this.flags.push(f);
    if (this.shots >= MAX_FEEL_SHOTS || now - this.lastShot < SHOT_GAP_MS) return null;
    this.lastShot = now;
    this.shots++;
    return f;
  }
  /** The report's own list (report().feel), for flags the binding missed (a page that pushed before it existed). */
  merge(fromReport: any) {
    for (const raw of Array.isArray(fromReport) ? fromReport : []) {
      const f = cleanFlag(raw);
      if (!f) continue;
      const had = this.flags.find((x) => x.id === f.id);
      if (had) { had.count = Math.max(had.count ?? 1, f.count ?? 1); continue; }
      if (this.flags.length < MAX_FLAGS) this.flags.push(f);
    }
  }
}

/** The worst flags first: bugs, then by how often they happened. */
export function rankFlags(flags: FeelFlag[]): FeelFlag[] {
  return [...flags].sort((a, b) => (a.severity === b.severity ? (b.count ?? 1) - (a.count ?? 1) : a.severity === 'bug' ? -1 : 1));
}

/** Where a flag sits on the recording: its arrival time, else the page's own time shifted by the first flag's offset. */
export function flagTime(f: FeelFlag, offset: number) {
  return f.rt ?? Math.max(0, f.t + offset);
}

/** Short clips (lead seconds before, tail after) around the worst flags, cut from the run's mp4. Sets flag.clip. */
export async function cutFeelClips(ctx: RunContext, mp4: string, flags: FeelFlag[], lastAsset: () => string | null, { max = 6, lead = 2.5, tail = 1.5 } = {}) {
  if (!fs.existsSync(mp4) || !flags.length) return 0;
  const withRt = flags.find((f) => f.rt != null);
  const offset = withRt ? withRt.rt! - withRt.t : 0;
  let n = 0;
  for (const f of rankFlags(flags).slice(0, max)) {
    const at = flagTime(f, offset);
    const start = Math.max(0, at - lead);
    const out = ctx.tmp(`clip-${f.id}.mp4`);
    try {
      await runProc('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(start), '-i', mp4, '-t', String(lead + tail), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]) });
      if (!fs.existsSync(out) || fs.statSync(out).size < 1000) continue;
      await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', mime: 'video/mp4', title: `${Math.round(at * 10) / 10}s ${f.detail}`, meta: { playtest: 'clip', flag: f.id, kind: f.kind, t: Math.round(at * 10) / 10 } });
      f.clip = lastAsset();
      n++;
    } catch (e: any) {
      ctx.log(`feel clip ${f.id}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return n;
}

export const POLISH_KINDS = ['ugly-building', 'z-fighting', 'floating-object', 'stretched-texture', 'clipping', 'missing-texture', 'camera-inside', 'bad-lighting', 'other'];

export const POLISH_RUBRIC = `Polish rubric for 3D game frames. Flag only what a player would notice and find ugly or broken:
- ugly-building: a building or structure that looks wrong: boxy placeholder, broken roof, gaps, wrong scale, melted geometry
- z-fighting: two surfaces flickering/striped through each other (overlapping coplanar faces)
- floating-object: an object hovering above the ground or sunk into it when it should sit on it
- stretched-texture: a texture visibly smeared, stretched or tiled wrongly
- clipping: a character, prop or the camera passing through a wall, floor or another object
- missing-texture: pink/black checker, plain white or grey untextured surfaces where detail is expected
- camera-inside: the view is inside geometry or blocked by a near wall, the player can't see their character
- bad-lighting: pitch-black or blown-out areas where the player should see
Ignore menus, loading screens, intended stylisation (low-poly, toon) and UI. A clean frame gets no hits.`;

const POLISH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['frames'],
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['frame', 'score', 'hits'],
        properties: {
          frame: { type: 'integer', description: 'The frame index' },
          score: { type: 'integer', description: '1 (ugly or broken) to 10 (polished)' },
          hits: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['kind', 'severity', 'where', 'detail'],
              properties: {
                kind: { type: 'string', enum: POLISH_KINDS },
                severity: { type: 'string', enum: ['bug', 'polish'] },
                where: { type: 'string', description: 'Where in the frame (e.g. "left, the tall red building")' },
                detail: { type: 'string', description: 'What is wrong, one sentence' },
              },
            },
          },
        },
      },
    },
  },
};

export type PolishFrame = { asset: string | null; file: string; t: number; reason: string; scene?: string };
export type PolishHit = { kind: string; severity: 'bug' | 'polish'; where: string; detail: string; t: number; asset: string | null; scene?: string; flag?: string };

/** Which frames the polish pass looks at: flag shots first, then evenly spread ones; at most max. */
export function pickPolishFrames<T extends { reason: string }>(shots: T[], max: number): T[] {
  const feel = shots.filter((s) => s.reason.startsWith('feel:'));
  const rest = shots.filter((s) => !s.reason.startsWith('feel:') && !['loaded'].includes(s.reason));
  const picked = new Set<T>(feel.slice(0, Math.ceil(max / 2)));
  const want = max - picked.size;
  for (let i = 0; i < want && rest.length; i++) picked.add(rest[Math.floor((i * rest.length) / Math.max(1, want))]);
  return shots.filter((s) => picked.has(s));
}

/**
 * The cheap vision pass: Haiku scores the frames against the rubric in one request (about 1.6k input tokens a
 * frame, so 10 frames cost a couple of cents). Returns the hits and an average score, or null when it couldn't run.
 */
export async function polishScan(ctx: RunContext, frames: PolishFrame[], { model = 'claude-haiku-5-5', product = '' } = {}) {
  if (!frames.length) return null;
  const legend = frames.map((f, i) => `[${i}] t=${f.t}s ${f.reason}${f.scene ? ` (${f.scene})` : ''}`).join('\n');
  const prompt = [
    product ? `GAME\n${product}` : '',
    POLISH_RUBRIC,
    `FRAMES (score each one, by index)\n${legend}`,
    'Frames named feel:<kind> were taken the moment the game\'s own sensor noticed that problem: check whether the frame shows it.',
  ].filter(Boolean).join('\n\n');
  const r = await ask({ prompt, system: 'You are a strict 3D art and polish reviewer. Answer only with the JSON asked for.', images: frames.map((f) => f.file), model, maxTokens: 3000, schema: POLISH_SCHEMA }, ctx.signal);
  ctx.usage(usageOf(r, `${r.model} polish scan`));
  const out = JSON.parse(r.text);
  const hits: PolishHit[] = [];
  const scores: number[] = [];
  for (const fr of Array.isArray(out.frames) ? out.frames : []) {
    const f = frames[fr.frame];
    if (!f) continue;
    if (Number.isFinite(fr.score)) scores.push(Math.max(1, Math.min(10, fr.score)));
    for (const h of Array.isArray(fr.hits) ? fr.hits.slice(0, 4) : []) {
      if (!POLISH_KINDS.includes(h.kind)) continue;
      hits.push({ kind: h.kind, severity: h.severity === 'bug' ? 'bug' : 'polish', where: String(h.where ?? '').slice(0, 160), detail: String(h.detail ?? '').slice(0, 300), t: f.t, asset: f.asset, ...(f.scene ? { scene: f.scene } : {}), ...(f.reason.startsWith('feel:') ? { flag: f.reason.slice(5) } : {}) });
    }
  }
  return { model: r.model, frames: frames.length, score: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null, hits: hits.slice(0, 30) };
}

/** What the review is told about the feel layer (empty when the run had none). */
export function feelBrief(result: any) {
  const flags: FeelFlag[] = Array.isArray(result?.feel) ? result.feel : [];
  const hits: PolishHit[] = Array.isArray(result?.polish?.hits) ? result.polish.hits : [];
  if (!flags.length && !hits.length) return '';
  const lines = [
    'FEEL AND POLISH (the game\'s own sensor flagged these moments, and a vision pass scored frames; screenshots named feel:<kind> are the flag moments).',
    'Treat repeated or bug-severity flags as real problems a player hits: camera snaps and jumps, the camera behind walls, falling through the floor,',
    'getting stuck on geometry, collision shoves and jitter, frame hitches. Name the place (scene + position) in the title and fix.',
    ...rankFlags(flags).slice(0, 30).map((f) => `- ${f.kind} x${f.count ?? 1} at t=${f.rt ?? f.t}s${f.scene ? ` in ${f.scene}` : ''}${f.pos ? ` pos ${f.pos.join(',')}` : ''}: ${f.detail}`),
    ...hits.slice(0, 20).map((h) => `- vision ${h.kind} (${h.severity}) at t=${h.t}s${h.scene ? ` in ${h.scene}` : ''}: ${h.where}: ${h.detail}`),
  ];
  return lines.join('\n');
}
