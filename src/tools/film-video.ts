// The film pipeline's ffmpeg tools (free, on the machine the service runs on): docs/film-pipeline.md.
//
//   video.matte        a control video (or any video) cut to a character's matte: black outside it. Run the video model
//                      on one character only.
//   video.composite    layered VFX: a repainted shot's effect layer goes on the base shot only inside one character's
//                      matte, with glow and bloom, and never over the protected matte (the other character's face).
//   video.control-mix  depth + pose + edges in one control video, for the IC-LoRA that takes a single control.
//
// The planners (matteFilter, compositeFilter, mixFilter) are pure and return the ffmpeg filter graph, so the tests check
// them directly and also run them on synthetic clips.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError, run } from '../util.ts';
import { probeMedia } from './compose.ts';

const f3 = (n: number) => String(Math.round(n * 1000) / 1000);
const clampNum = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** A matte as a gray video the size of the target: grown (a soft expand), feathered, optionally inverted. */
export function matteChain(input: string, out: string, w: number, h: number, o: { grow?: number; feather?: number; invert?: boolean; fps?: number }) {
  const steps = [`scale=${w}:${h}:flags=bilinear`, 'format=gray'];
  if (o.fps) steps.push(`fps=${f3(o.fps)}`);
  const grow = clampNum(o.grow, 0, 200, 0);
  if (grow > 0) steps.push(`gblur=sigma=${f3(Math.max(0.5, grow / 1.5))}`, `lutyuv=y='clip(val*6,0,255)'`);
  const feather = clampNum(o.feather, 0, 200, 0);
  if (feather > 0) steps.push(`gblur=sigma=${f3(feather)}`);
  if (o.invert) steps.push('negate');
  return `[${input}]${steps.join(',')}[${out}]`;
}

/** The filter graph of video.matte: input 0 the video, input 1 its matte; output [out]. */
export function matteFilter(w: number, h: number, o: { grow?: number; feather?: number; invert?: boolean; fps?: number }) {
  return [
    matteChain('1:v', 'm', w, h, o),
    `[0:v]scale=${w}:${h},format=gbrp[v]`,
    '[m]format=gbrp[mr]',
    '[v][mr]blend=all_mode=multiply,format=yuv420p[out]',
  ].join(';');
}

export type CompositeOptions = { grow?: number; feather?: number; glow?: number; bloom?: number; threshold?: number; hasProtect: boolean; protectGrow?: number };

/**
 * The filter graph of video.composite. Inputs: 0 base, 1 effect layer, 2 the effect character's matte, 3 (optional) the matte of
 * what to protect. Where the matte is, the effect layer replaces the base; the matte is grown a little (the glow and the
 * fringe of an aura live outside the body) and never covers the protected matte. The glow is the effect layer's bright
 * parts, blurred, screened on top, and also kept off the protected area. Output [out].
 */
export function compositeFilter(w: number, h: number, fps: number, o: CompositeOptions) {
  const glow = clampNum(o.glow, 0, 3, 0.6);
  const bloom = clampNum(o.bloom, 1, 200, 24);
  const threshold = clampNum(o.threshold, 0, 255, 150);
  const g: string[] = [
    matteChain('2:v', 'm0', w, h, { grow: o.grow ?? 10, feather: o.feather ?? 6, fps }),
  ];
  if (o.hasProtect) {
    g.push(matteChain('3:v', 'p', w, h, { grow: o.protectGrow ?? 6, feather: o.feather ?? 6, invert: true, fps }));
    g.push('[p]split=2[pa][pb]');
    g.push('[m0][pa]blend=all_mode=multiply[m]');
    g.push('[m]split=2[m1][m2]');
  } else {
    g.push('[m0]split=2[m1][m2]');
  }
  g.push(`[0:v]scale=${w}:${h},fps=${f3(fps)},format=gbrp[b]`);
  g.push(`[1:v]scale=${w}:${h},fps=${f3(fps)},format=gbrp${glow > 0 ? ',split=2[fx][fxb]' : '[fx]'}`);
  g.push('[m1]format=gray[mk]');
  g.push('[b][fx][mk]maskedmerge[comp]');
  if (glow > 0) {
    // The bright parts of the effect, only where it is allowed, blurred wide, then screened over the composite.
    const k = f3(255 / Math.max(1, 255 - threshold));
    g.push(`[fxb]lutrgb=r='clip((val-${f3(threshold)})*${k},0,255)':g='clip((val-${f3(threshold)})*${k},0,255)':b='clip((val-${f3(threshold)})*${k},0,255)'[bright]`);
    g.push('[m2]format=gbrp[mglow]');
    // The glow may leak a little past the matte (that is what glow is), but not into the protected area.
    if (o.hasProtect) {
      g.push(`[bright][mglow]blend=all_mode=multiply,gblur=sigma=${f3(bloom)}[bloom0]`);
      g.push('[pb]format=gbrp[pkeep]');
      g.push('[bloom0][pkeep]blend=all_mode=multiply[bloom]');
    } else {
      g.push(`[bright][mglow]blend=all_mode=multiply,gblur=sigma=${f3(bloom)}[bloom]`);
    }
    g.push(`[comp][bloom]blend=all_mode=screen:all_opacity=${f3(glow)},format=yuv420p[out]`);
  } else {
    g.push('[comp]format=yuv420p[out]');
    g.push('[m2]nullsink');
    if (o.hasProtect) g.push('[pb]nullsink');
  }
  return g.join(';');
}

/** The filter graph of video.control-mix: every input to the first one's size, weighted, then lightened (or screened, or averaged) together. */
export function mixFilter(n: number, w: number, h: number, fps: number, o: { mode?: string; weights?: number[] }) {
  const mode = o.mode ?? 'lighten';
  if (!['lighten', 'screen', 'average'].includes(mode)) throw new GenError('mode is lighten, screen or average');
  const g: string[] = [];
  for (let i = 0; i < n; i++) {
    const wt = clampNum(o.weights?.[i], 0, 1, 1);
    g.push(`[${i}:v]scale=${w}:${h},fps=${f3(fps)},format=gbrp${wt < 1 ? `,lutrgb=r='val*${f3(wt)}':g='val*${f3(wt)}':b='val*${f3(wt)}'` : ''}[c${i}]`);
  }
  let cur = 'c0';
  for (let i = 1; i < n; i++) {
    const to = i === n - 1 ? 'mixed' : `x${i}`;
    g.push(`[${cur}][c${i}]blend=all_mode=${mode}[${to}]`);
    cur = to;
  }
  if (n === 1) g.push('[c0]null[mixed]');
  g.push('[mixed]format=yuv420p[out]');
  return g.join(';');
}

const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []) as string[];

async function encode(ctx: any, args: string[], filter: string, out: string, audioFrom?: string) {
  const dir = path.dirname(out);
  fs.writeFileSync(path.join(dir, 'graph.filter'), filter);
  const full = ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-filter_complex_script', 'graph.filter', '-map', '[out]'];
  if (audioFrom) full.push('-map', `${audioFrom}:a?`, '-c:a', 'aac', '-b:a', '192k');
  full.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-shortest', path.basename(out));
  ctx.log(`ffmpeg ${full.join(' ')}\n${filter}`);
  await run('ffmpeg', full, { cwd: dir, signal: ctx.signal });
}

export const videoMatteTool: Tool = {
  id: 'video.matte',
  version: 1,
  title: 'Cut a video to a matte',
  description: 'Keeps a video only where a character\'s matte is (black elsewhere), with an optional soft grow and feather. Use it on a blender.render control video (depth, pose, edges) and a layer matte (passes: ["layers"]) so the video model repaints one character only. ffmpeg on this machine, free.',
  provider: 'local',
  output: 'video',
  inputs: {
    video: { kind: 'video', required: true, description: 'The video to cut (a control video from blender.render).' },
    matte: { kind: 'video', required: true, description: 'White where to keep it (blender.render layer N, or mask).' },
  },
  params: {
    grow: { type: 'number', min: 0, max: 200, default: 8, description: 'Pixels to grow the matte by (room for an aura around the body).' },
    feather: { type: 'number', min: 0, max: 200, default: 4, description: 'Pixels of soft edge.' },
    invert: { type: 'boolean', default: false, description: 'Keep everything except the matte.' },
  },
  async run(ctx) {
    const p = ctx.params;
    const [video, matte] = [ctx.inputs.video, ctx.inputs.matte];
    const v = await probeMedia(video, ctx.signal);
    if (!v.width || !v.height) throw new GenError('video has no picture');
    const out = ctx.tmp('matte.mp4');
    ctx.step('cutting the video to the matte');
    await encode(ctx, ['-i', video, '-i', matte], matteFilter(v.width, v.height, { grow: p.grow, feather: p.feather, invert: p.invert, fps: v.fps }), out);
    const made = await probeMedia(out, ctx.signal);
    await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', title: 'matted', meta: { width: made.width, height: made.height, duration: made.duration } });
    ctx.result({ width: made.width, height: made.height, duration: made.duration, fps: made.fps });
  },
};

export const videoCompositeTool: Tool = {
  id: 'video.composite',
  version: 1,
  title: 'Layered VFX composite',
  description: 'Puts an effect layer on a base shot only inside one character\'s matte, with glow and bloom, never over the protected matte (the other character, so effects don\'t muddy their face). Render both characters on layers (blender.render passes ["layers"]), run the effect (aura, fire, lightning) on one character through the video model, then composite it here. Output keeps the base shot\'s sound. ffmpeg on this machine, free.',
  provider: 'local',
  output: 'video',
  inputs: {
    base: { kind: 'video', required: true, description: 'The finished shot (the look of everything).' },
    fx: { kind: 'video', required: true, description: 'The effect layer: the same shot repainted with the effect on one character.' },
    matte: { kind: 'video', required: true, description: 'Where the effect lives: the effect character\'s layer matte.' },
    protect: { kind: 'video', description: 'What the effect must never touch (the other character\'s layer matte).' },
  },
  params: {
    grow: { type: 'number', min: 0, max: 200, default: 10, description: 'Pixels the effect matte grows by (an aura reaches past the body).' },
    feather: { type: 'number', min: 0, max: 200, default: 6, description: 'Soft edge of the matte in pixels.' },
    glow: { type: 'number', min: 0, max: 3, default: 0.6, description: 'Strength of the glow (0 off).' },
    bloom: { type: 'number', min: 1, max: 200, default: 24, description: 'Radius of the bloom in pixels.' },
    threshold: { type: 'number', min: 0, max: 254, default: 150, description: 'Brightness (0-255) above which the effect glows.', advanced: true },
    protectGrow: { type: 'number', min: 0, max: 200, default: 6, description: 'Pixels of safety margin around the protected matte.', advanced: true },
  },
  async run(ctx) {
    const p = ctx.params;
    const base = await probeMedia(ctx.inputs.base, ctx.signal);
    if (!base.width || !base.height) throw new GenError('base has no picture');
    const fps = base.fps ?? 24;
    const hasProtect = !!ctx.inputs.protect;
    const out = ctx.tmp('composite.mp4');
    ctx.step('compositing the effect layer');
    const inputs = ['-i', ctx.inputs.base, '-i', ctx.inputs.fx, '-i', ctx.inputs.matte, ...(hasProtect ? ['-i', ctx.inputs.protect] : [])];
    await encode(ctx, inputs, compositeFilter(base.width, base.height, fps, { grow: p.grow, feather: p.feather, glow: p.glow, bloom: p.bloom, threshold: p.threshold, protectGrow: p.protectGrow, hasProtect }), out, '0');
    const made = await probeMedia(out, ctx.signal);
    await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', title: 'composite', meta: { width: made.width, height: made.height, duration: made.duration } });
    ctx.result({ width: made.width, height: made.height, duration: made.duration, fps: made.fps, protected: hasProtect });
  },
};

export const videoControlMixTool: Tool = {
  id: 'video.control-mix',
  version: 1,
  title: 'Mix control videos (depth + pose + edges)',
  description: 'Lays several control videos from blender.render into one (the brightest wins: depth keeps the layout, the pose skeleton and the edges draw over it), because video.control takes one control video. Weights dim a control. The mix is built to keep depth\'s layout and add the lines; if a repaint drifts, fall back to depth alone. ffmpeg on this machine, free.',
  provider: 'local',
  output: 'video',
  inputs: { videos: { kind: 'video', multiple: true, required: true, max: 6, description: 'depth, pose, edges... in that order.' } },
  params: {
    mode: { type: 'enum', values: ['lighten', 'screen', 'average'], default: 'lighten' },
    weights: { type: 'json', description: 'One 0-1 weight per video, e.g. [1, 0.8, 0.5].', example: [1, 0.8, 0.5] },
  },
  async run(ctx) {
    const files = list(ctx.inputs.videos);
    if (files.length < 2) throw new GenError('Give at least two control videos to mix');
    const first = await probeMedia(files[0], ctx.signal);
    if (!first.width || !first.height) throw new GenError('the first video has no picture');
    const out = ctx.tmp('mix.mp4');
    ctx.step(`mixing ${files.length} control videos`);
    const weights = Array.isArray(ctx.params.weights) ? ctx.params.weights.map(Number) : undefined;
    await encode(ctx, files.flatMap((f) => ['-i', f]), mixFilter(files.length, first.width, first.height, first.fps ?? 24, { mode: ctx.params.mode, weights }), out);
    const made = await probeMedia(out, ctx.signal);
    await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', title: 'control', meta: { width: made.width, height: made.height, duration: made.duration } });
    ctx.result({ width: made.width, height: made.height, duration: made.duration, fps: made.fps, inputs: files.length });
  },
};
