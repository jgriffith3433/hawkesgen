// GPU tools: ComfyUI on the AWS fleet. Defaults are the settings Dose Of
// Destruction tuned (its content/generation.json defaults); callers can pass
// any of them to override.

import path from 'node:path';
import fs from 'node:fs';
import type { Tool, RunContext, ParamSpec } from './types.ts';
import { imageEdit, imageToVideo, animate, FAMILY_MODELS, ANGLES_LORA } from '../providers/comfy/graphs.ts';
import type { Graph } from '../providers/comfy/client.ts';
import { GenError } from '../util.ts';

export const common: Record<string, ParamSpec> = {
  seed: { type: 'integer', min: 1, max: 2 ** 48, description: 'Seed for the first output; the next ones count up. Random when empty.' },
  count: { type: 'integer', min: 1, max: 8, default: 1, description: 'How many outputs (takes) to make.' },
  sampler: { type: 'string', default: 'euler', advanced: true },
  scheduler: { type: 'string', default: 'simple', advanced: true },
};

export const qwenSettings: Record<string, ParamSpec> = {
  steps: { type: 'integer', min: 1, max: 60, default: 4, advanced: true },
  cfg: { type: 'number', min: 0, max: 20, default: 1, advanced: true },
  shift: { type: 'number', min: 0, max: 20, default: 3.1, advanced: true },
  lora: { type: 'number', min: 0, max: 2, default: 1, description: 'Lightning LoRA strength.', advanced: true },
  denoise: { type: 'number', min: 0, max: 1, default: 1, description: 'Below 1 keeps more of image 1 (its shapes and layout).' },
};

export const qwenS = (p: Record<string, any>) => ({ steps: p.steps, cfg: p.cfg, shift: p.shift, lora: p.lora, sampler: p.sampler, scheduler: p.scheduler, denoise: p.denoise, angles: p.angles });

/** Saves every take of a graph-per-seed tool. */
async function takes(ctx: RunContext, build: (seed: number) => Graph, ext: string, label: string) {
  const c = ctx.comfy!;
  const n = ctx.params.count ?? 1;
  for (let i = ctx.done; i < n; i++) {
    const seed = ctx.seed(i);
    ctx.step(`${label} ${i + 1} of ${n}`);
    const files = await c.runGraph(build(seed));
    if (!files.length) throw new Error('The workflow finished without saving anything');
    const data = await c.download(files[0]);
    await ctx.emit({ data, ext: path.extname(files[0].filename) || ext, seed });
  }
}

export const imageEditTool: Tool = {
  id: 'image.edit',
  version: 1,
  title: 'Edit an image',
  description: 'Qwen-Image-Edit 2511: change image 1 as the prompt says (turn a character side-on, put them in a pose, repaint a blockout), with up to two more images as references. Set width and height to paint over image 1 at exactly that size.',
  provider: 'comfy',
  family: 'qwen-edit',
  output: 'image',
  inputs: { images: { kind: 'image', multiple: true, max: 3, required: true, description: 'Image 1 is edited; images 2 and 3 are references.' } },
  params: {
    prompt: { type: 'text', required: true },
    negative: { type: 'text', default: '', advanced: true },
    width: { type: 'integer', min: 64, max: 4096, description: 'With height: scale image 1 to exactly this size (sets the output size). Up to 4096 wide for a 4:1 turnaround.' },
    height: { type: 'integer', min: 64, max: 2048 },
    angles: { type: 'number', min: 0, max: 1.5, default: 0, description: 'Strength of the Multiple-Angles LoRA (0 = off; 0.9 to turn the camera). With it, prompt "<sks> [front view | right side view | back view | left side view | front-right quarter view ...] [eye-level shot | elevated shot | high-angle shot | low-angle shot] [close-up | medium shot | wide shot]".', advanced: true },
    ...qwenSettings,
    ...common,
  },
  models: (p) => [...FAMILY_MODELS['qwen-edit'], ...(Number(p.angles) > 0 ? [ANGLES_LORA.file] : [])],
  gpuSeconds: () => 15,
  async run(ctx) {
    const c = ctx.comfy!;
    const p = ctx.params;
    if ((p.width === undefined) !== (p.height === undefined)) throw new GenError('Give both width and height, or neither');
    if (Number(p.width) * Number(p.height) > 4.2e6) throw new GenError('width x height is at most about 4 megapixels (4096x1024)');
    if (Number(p.angles) > 0) await c.ensureModels([ANGLES_LORA]);
    ctx.step('uploading the images');
    const images: string[] = [];
    for (const [i, f] of ctx.inputs.images.entries()) {
      if (i === 0 && p.width !== undefined) {
        // Scaling to exactly width x height stretches a non-square source; pad it instead, flat, so no alpha grid is copied.
        const fitted = ctx.tmp('fit.png');
        await ctx.python('prep.py', ['fit', f, fitted, String(p.width), String(p.height)]);
        images.push(await c.upload(fitted));
      } else images.push(await c.upload(f));
    }
    await takes(ctx, (seed) => imageEdit({ images, prompt: p.prompt, negative: p.negative, seed, width: p.width, height: p.height, prefix: `hawkesgen/${ctx.job.project}`, s: qwenS(p) }), '.png', 'image');
  },
};

export const imagePaintTool: Tool = {
  id: 'image.paint',
  version: 1,
  title: 'Paint with references',
  description: 'Qwen-Image-Edit 2511 painting a new picture on a blank canvas of the size you ask for, styled on up to two reference images (a mood board, the art direction, a character sheet). Use image.generate for plain text-to-image. With seamless on, the result tiles.',
  provider: 'comfy',
  family: 'qwen-edit',
  output: 'image',
  inputs: { references: { kind: 'image', multiple: true, max: 2, description: 'Style references (palette, light, art direction). Content gets copied, so prefer a blurred mood board for layout-free style.' } },
  params: {
    prompt: { type: 'text', required: true },
    width: { type: 'integer', min: 256, max: 2048, default: 1024 },
    height: { type: 'integer', min: 256, max: 2048, default: 1024 },
    canvas: { type: 'string', default: '808080', description: 'Canvas color (hex) the painting starts from.', advanced: true },
    seamless: { type: 'boolean', default: false, description: 'Make the result tile seamlessly (textures).' },
    blend: { type: 'number', min: 0.05, max: 0.5, default: 0.25, description: 'How wide the seamless crossfade is.', advanced: true },
    negative: { type: 'text', default: '', advanced: true },
    ...qwenSettings,
    ...common,
  },
  models: () => FAMILY_MODELS['qwen-edit'],
  gpuSeconds: () => 20,
  async run(ctx) {
    const c = ctx.comfy!;
    const p = ctx.params;
    const canvas = ctx.tmp('canvas.png');
    await ctx.python('prep.py', ['canvas', canvas, String(p.width), String(p.height), String(p.canvas).replace(/^#/, '')]);
    ctx.step('uploading the canvas');
    const images = [await c.upload(canvas)];
    for (const f of ctx.inputs.references ?? []) images.push(await c.upload(f));
    const prompt = `Replace this blank canvas entirely with a new image: ${p.prompt}`;
    const n = p.count ?? 1;
    for (let i = ctx.done; i < n; i++) {
      const seed = ctx.seed(i);
      ctx.step(`painting ${i + 1} of ${n} (${p.width}x${p.height})`);
      const files = await c.runGraph(imageEdit({ images, prompt, negative: p.negative, seed, width: p.width, height: p.height, prefix: `hawkesgen/${ctx.job.project}`, s: qwenS(p) }));
      if (!files.length) throw new Error('The workflow finished without saving anything');
      let data = await c.download(files[0]);
      if (p.seamless) {
        const src = ctx.tmp(`raw-${seed}.png`);
        const out = ctx.tmp(`tiled-${seed}.png`);
        fs.writeFileSync(src, data);
        await ctx.python('texture.py', ['tile', src, out, String(p.blend)]);
        data = fs.readFileSync(out);
      }
      await ctx.emit({ data, ext: '.png', seed });
    }
  },
};

const wanSettings: Record<string, ParamSpec> = {
  steps: { type: 'integer', min: 1, max: 60, default: 8, advanced: true },
  split: { type: 'integer', min: 1, max: 59, default: 4, description: 'Step where the low-noise (detail) model takes over.', advanced: true },
  motionSteps: { type: 'integer', min: 0, max: 30, default: 0, description: 'Steps on the plain high-noise model at cfgHigh, for stronger motion.', advanced: true },
  cfgHigh: { type: 'number', min: 0, max: 20, default: 2, advanced: true },
  cfg: { type: 'number', min: 0, max: 20, default: 1, advanced: true },
  shift: { type: 'number', min: 0, max: 20, default: 5, advanced: true },
  loraHigh: { type: 'number', min: 0, max: 2, default: 0.7, advanced: true },
  loraLow: { type: 'number', min: 0, max: 2, default: 1, advanced: true },
  loraVersion: { type: 'integer', min: 1, max: 2, default: 2, description: '2: lightx2v 1022 LoRAs (more motion).', advanced: true },
  motionAmplitude: { type: 'number', min: 1, max: 2, default: 1, description: 'Above 1 pushes motion (start frame only).', advanced: true },
};

/** Wan wants 4n + 1 frames. */
const wanFrames = (n: number) => Math.max(5, Math.round((n - 1) / 4) * 4 + 1);

export const videoI2vTool: Tool = {
  id: 'video.i2v',
  version: 1,
  title: 'Image to video',
  description: 'Wan 2.2 14B: a short clip that starts on an image and, with an end image, ends on it (the same image twice makes a clean loop). Characters, screen loops, ambient motion.',
  provider: 'comfy',
  family: 'wan-i2v',
  output: 'video',
  inputs: {
    start: { kind: 'image', required: true, description: 'The first frame.' },
    end: { kind: 'image', description: 'The last frame (first-last-frame mode).' },
  },
  params: {
    prompt: { type: 'text', required: true },
    negative: { type: 'text', default: '', advanced: true },
    width: { type: 'integer', min: 256, max: 1280, default: 640 },
    height: { type: 'integer', min: 256, max: 1280, default: 640 },
    frames: { type: 'integer', min: 5, max: 161, default: 33, description: 'Frame count (rounded to 4n + 1).' },
    fps: { type: 'integer', min: 8, max: 30, default: 16 },
    ...wanSettings,
    ...common,
  },
  models: (p) => [...FAMILY_MODELS['wan-i2v'], ...imageToVideo({ image: 'x', prompt: '', seed: 1, s: p }).loras],
  gpuSeconds: (p) => 70 * ((p.frames ?? 33) / 33),
  async run(ctx) {
    const c = ctx.comfy!;
    const p = ctx.params;
    ctx.step('uploading the frames');
    const image = await c.upload(ctx.inputs.start);
    const end = ctx.inputs.end ? (ctx.inputs.end === ctx.inputs.start ? image : await c.upload(ctx.inputs.end)) : undefined;
    const frames = wanFrames(p.frames);
    await takes(ctx, (seed) => imageToVideo({ image, end, prompt: p.prompt, negative: p.negative, width: p.width, height: p.height, frames, fps: p.fps, seed, prefix: `hawkesgen/${ctx.job.project}`, s: p }).graph, '.mp4', `clip (${frames} frames)`);
  },
};

export const videoAnimateTool: Tool = {
  id: 'video.animate',
  version: 1,
  title: 'Animate from a motion video',
  description: 'Wan 2.2 Animate: the reference image performs the driving video\'s motion (poses read with DWPose). A flat green reference keys cleanly. Prepare the motion with video.fit first (16 fps, frame size).',
  provider: 'comfy',
  family: 'wan-animate',
  output: 'video',
  inputs: {
    reference: { kind: 'image', required: true, description: 'Who performs (on a flat background).' },
    motion: { kind: 'video', required: true, description: 'The driving video.' },
  },
  params: {
    prompt: { type: 'text', required: true },
    negative: { type: 'text', default: '', advanced: true },
    width: { type: 'integer', min: 256, max: 1280, default: 640 },
    height: { type: 'integer', min: 256, max: 1280, default: 640 },
    frames: { type: 'integer', min: 5, max: 161, default: 77, description: 'At most the driving video\'s frame count (rounded down to 4n + 1).' },
    fps: { type: 'integer', min: 8, max: 30, default: 16 },
    steps: { type: 'integer', min: 1, max: 60, default: 6, advanced: true },
    cfg: { type: 'number', min: 0, max: 20, default: 1, advanced: true },
    shift: { type: 'number', min: 0, max: 20, default: 8, advanced: true },
    lora: { type: 'number', min: 0, max: 2, default: 1, advanced: true },
    hands: { type: 'boolean', default: true, advanced: true },
    face: { type: 'boolean', default: true, advanced: true },
    poseResolution: { type: 'integer', min: 256, max: 1024, default: 512, advanced: true },
    ...common,
  },
  models: () => FAMILY_MODELS['wan-animate'],
  gpuSeconds: (p) => 90 * ((p.frames ?? 77) / 77),
  async run(ctx) {
    const c = ctx.comfy!;
    const p = ctx.params;
    ctx.step('uploading the reference and the motion');
    const reference = await c.upload(ctx.inputs.reference);
    const motion = await c.upload(ctx.inputs.motion);
    const frames = Math.max(5, Math.floor((p.frames - 1) / 4) * 4 + 1);
    await takes(ctx, (seed) => animate({ reference, motion, prompt: p.prompt, negative: p.negative, width: p.width, height: p.height, frames, fps: p.fps, seed, prefix: `hawkesgen/${ctx.job.project}`, s: p }), '.mp4', `clip (${frames} frames)`);
  },
};

/**
 * Any ComfyUI API graph, for experiments before a workflow becomes a tool.
 * Strings "{{input:N}}" become the uploaded name of files[N], "{{seed}}" the
 * seed (as a number when it is the whole value).
 */
export const comfyGraphTool: Tool = {
  id: 'comfy.graph',
  version: 1,
  title: 'Run a ComfyUI graph',
  description: 'Runs any ComfyUI API-format graph on the fleet (the escape hatch for trying a workflow before it becomes a tool). In the graph, "{{input:0}}" is the first uploaded file and "{{seed}}" the seed. Every saved image, video or mesh comes back.',
  provider: 'comfy',
  family: (p) => p.family,
  output: 'file',
  inputs: { files: { kind: 'file', multiple: true, max: 8 } },
  params: {
    graph: { type: 'json', required: true, description: 'ComfyUI API-format graph.' },
    family: { type: 'string', required: true, description: 'Which models it loads, e.g. qwen-edit, wan-i2v, wan-animate, or a new name (the server unloads models when this changes).' },
    seed: common.seed,
    count: common.count,
  },
  async run(ctx) {
    const c = ctx.comfy!;
    const names: string[] = [];
    for (const f of ctx.inputs.files ?? []) names.push(await c.upload(f));
    const n = ctx.params.count ?? 1;
    for (let i = ctx.done; i < n; i++) {
      const seed = ctx.seed(i);
      const fill = (v: any): any => {
        if (typeof v === 'string') {
          if (v === '{{seed}}') return seed;
          return v.replace(/\{\{input:(\d+)\}\}/g, (_, k) => names[Number(k)] ?? '').replaceAll('{{seed}}', String(seed));
        }
        if (Array.isArray(v)) return v.map(fill);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
        return v;
      };
      ctx.step(`graph run ${i + 1} of ${n}`);
      const files = await c.runGraph(fill(ctx.params.graph));
      for (const f of files) await ctx.emit({ data: await c.download(f), ext: path.extname(f.filename) || '.bin', seed, meta: { comfyName: f.filename } });
    }
  },
};
