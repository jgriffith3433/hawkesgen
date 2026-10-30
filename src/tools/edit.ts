// Editing parts of a picture with Qwen-Image-Edit 2511 (the same graph image.edit runs): image.repaint changes the area
// a mask marks and leaves every other pixel as it was; image.expand grows the canvas and lets the model continue the
// scene into the new border. The geometry (crop boxes, padding, model sizes) is pure and tested here
// (test/edit-tools.test.ts); the pixels are Pillow in post/edit.py.

import fs from 'node:fs';
import type { Tool, RunContext } from './types.ts';
import { imageEdit, FAMILY_MODELS } from '../providers/comfy/graphs.ts';
import { GenError } from '../util.ts';
import { common, qwenSettings, qwenS } from './comfy.ts';

export type Box = [number, number, number, number];

const round16 = (v: number) => Math.max(64, Math.round(v / 16) * 16);

/**
 * The size Qwen-Image-Edit works at for a w x h picture: the same shape at about `area` pixels (it is trained near one
 * megapixel, so small crops are scaled up for detail and big ones down), sides multiples of 16, the long side at most
 * maxSide.
 */
export function modelSize(w: number, h: number, area = 1024 * 1024, maxSide = 2048): { width: number; height: number } {
  if (!(w > 0 && h > 0)) throw new GenError('modelSize: empty picture');
  let s = Math.sqrt(area / (w * h));
  if (Math.max(w, h) * s > maxSide) s = maxSide / Math.max(w, h);
  return { width: Math.min(maxSide, round16(w * s)), height: Math.min(maxSide, round16(h * s)) };
}

/**
 * The part of a W x H picture image.repaint sends to the model for a mask whose bounding box is `box`: the box plus a
 * generous margin (a third of its long side, at least 64 px) for context, at least `minSize` on each side (or the whole
 * side when the picture is smaller), never more than `maxAspect` to 1, kept inside the picture (shifted, not cut).
 */
export function repaintCrop(W: number, H: number, box: Box, o: { minSize?: number; marginFrac?: number; minMargin?: number; maxAspect?: number } = {}): Box {
  const { minSize = 512, marginFrac = 0.35, minMargin = 64, maxAspect = 2 } = o;
  const [x0, y0, x1, y1] = box;
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);
  const m = Math.max(minMargin, Math.round(marginFrac * Math.max(bw, bh)));
  let cw = Math.max(bw + 2 * m, Math.min(minSize, W));
  let ch = Math.max(bh + 2 * m, Math.min(minSize, H));
  if (cw / ch > maxAspect) ch = Math.ceil(cw / maxAspect);
  if (ch / cw > maxAspect) cw = Math.ceil(ch / maxAspect);
  cw = Math.min(cw, W);
  ch = Math.min(ch, H);
  const place = (c: number, size: number, total: number) => Math.max(0, Math.min(total - size, Math.round(c - size / 2)));
  const x = place((x0 + x1) / 2, cw, W);
  const y = place((y0 + y1) / 2, ch, H);
  return [x, y, x + cw, y + ch];
}

/** "16:9", "9:16", "1:1", "4:3", "2.39:1" or a number (width / height). */
export function parseAspect(a: unknown): number {
  if (typeof a === 'number') {
    if (a > 0) return a;
  } else {
    const s = String(a ?? '').trim();
    const m = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i.exec(s);
    if (m && Number(m[1]) > 0 && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
    if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 0) return Number(s);
  }
  throw new GenError(`aspect is a shape like "16:9" or "9:16" (got ${JSON.stringify(a)})`);
}

export type ExpandPlan = {
  /** The finished picture's size. */
  width: number;
  height: number;
  /** Where the original sits in it, and at what size: [x, y, w, h]. */
  rect: [number, number, number, number];
  /** The padding asked for, in the original's pixels. */
  pad: { left: number; right: number; top: number; bottom: number };
  /** The size the model paints at. */
  model: { width: number; height: number };
  /** Below 1 when the result was scaled down to fit maxSide. */
  scale: number;
};

/**
 * What image.expand makes from a W x H picture: px of new canvas on each side, or the canvas that reaches `aspect` with
 * the picture centered. The result's long side is at most maxSide (the original is scaled down with it when needed).
 */
export function expandPlan(W: number, H: number, p: { left?: number; right?: number; top?: number; bottom?: number; aspect?: unknown }, maxSide = 2048): ExpandPlan {
  let pad = { left: Math.max(0, Math.round(Number(p.left) || 0)), right: Math.max(0, Math.round(Number(p.right) || 0)), top: Math.max(0, Math.round(Number(p.top) || 0)), bottom: Math.max(0, Math.round(Number(p.bottom) || 0)) };
  if (p.aspect !== undefined && p.aspect !== null && p.aspect !== '') {
    if (pad.left || pad.right || pad.top || pad.bottom) throw new GenError('Give aspect, or left/right/top/bottom, not both');
    const r = parseAspect(p.aspect);
    if (r < 0.2 || r > 5) throw new GenError('aspect is between 1:5 and 5:1');
    if (W / H < r) {
      const extra = Math.round(H * r) - W;
      pad = { left: Math.floor(extra / 2), right: extra - Math.floor(extra / 2), top: 0, bottom: 0 };
    } else {
      const extra = Math.round(W / r) - H;
      pad = { left: 0, right: 0, top: Math.floor(extra / 2), bottom: extra - Math.floor(extra / 2) };
    }
  }
  if (!pad.left && !pad.right && !pad.top && !pad.bottom) throw new GenError('Nothing to expand: give left, right, top or bottom (px), or an aspect such as "16:9" the picture doesn\'t already have');
  const CW = W + pad.left + pad.right;
  const CH = H + pad.top + pad.bottom;
  if (CW / W > 4 || CH / H > 4) throw new GenError('Expand at most to four times the width or height at once (do it in steps for more)');
  const scale = Math.min(1, maxSide / Math.max(CW, CH));
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const width = even(CW * scale);
  const height = even(CH * scale);
  const w = Math.min(width, Math.round(W * scale));
  const h = Math.min(height, Math.round(H * scale));
  const x = Math.min(width - w, Math.round(pad.left * scale));
  const y = Math.min(height - h, Math.round(pad.top * scale));
  return { width, height, rect: [x, y, w, h], pad, model: modelSize(width, height, 1.6e6, 2048), scale: Math.round(scale * 10000) / 10000 };
}

const lastJson = (s: string) => JSON.parse(s.trim().split('\n').pop() || '{}');

/** One Qwen-Image-Edit take of `images` at the model size; returns the local file. */
async function editTake(ctx: RunContext, images: string[], prompt: string, size: { width: number; height: number }, seed: number): Promise<string> {
  const c = ctx.comfy!;
  const p = ctx.params;
  const files = await c.runGraph(imageEdit({ images, prompt, negative: p.negative, seed, width: size.width, height: size.height, prefix: `hawkesgen/${ctx.job.project}`, s: qwenS(p) }));
  if (!files.length) throw new Error('The workflow finished without saving anything');
  const raw = ctx.tmp(`edited-${seed}.png`);
  fs.writeFileSync(raw, await c.download(files[0]));
  return raw;
}

export const imageRepaintTool: Tool = {
  id: 'image.repaint',
  version: 1,
  title: 'Repaint an area',
  description: 'Changes only the area a mask marks, as the prompt says (swap an object, fix a hand, change a shirt, remove something), and leaves every pixel outside it exactly as it was. The mask is an image: white on black, or opaque strokes on transparency. The marked area is cropped with room around it, edited with Qwen-Image-Edit 2511 (the same model as image.edit), and blended back through a feathered edge. A mask covering the whole picture is a plain edit of it; for that, image.edit is the same thing.',
  provider: 'comfy',
  family: 'qwen-edit',
  output: 'image',
  inputs: {
    image: { kind: 'image', required: true, description: 'The picture to change.' },
    mask: { kind: 'image', required: true, description: 'Where to change it: white (or opaque) = repaint, black (or transparent) = keep. Any size; it is stretched to the picture.' },
    reference: { kind: 'image', description: 'Optional: a picture of what should go there (an object, a face, a pattern).' },
  },
  params: {
    prompt: { type: 'text', required: true, description: 'What the marked area should become.' },
    feather: { type: 'integer', min: 0, max: 128, default: 12, description: 'Soft edge, in pixels, inside the mask\'s border.' },
    guide: { type: 'boolean', default: true, description: 'Show the model the marked area outlined in red (a second image), so it changes the right thing.', advanced: true },
    negative: { type: 'text', default: '', advanced: true },
    ...qwenSettings,
    ...common,
  },
  models: () => FAMILY_MODELS['qwen-edit'],
  gpuSeconds: () => 15,
  async run(ctx) {
    const c = ctx.comfy!;
    const p = ctx.params;
    const { image, mask } = ctx.inputs as { image: string; mask: string };
    ctx.step('reading the mask');
    const info = lastJson(await ctx.python('edit.py', ['bbox', image, mask]));
    if (!info.box || Number(info.coverage) < 0.0002) throw new GenError('The mask is empty: paint the area to change in white (or opaque) on black (or transparent)');
    const W = Number(info.width);
    const H = Number(info.height);
    const full = Number(info.coverage) >= 0.98;
    const box: Box = full ? [0, 0, W, H] : repaintCrop(W, H, info.box as Box);
    const size = modelSize(box[2] - box[0], box[3] - box[1]);
    const crop = ctx.tmp('crop.png');
    const guide = ctx.tmp('guide.png');
    await ctx.python('edit.py', ['crop', image, mask, box.join(','), String(size.width), String(size.height), crop, guide]);
    ctx.step('uploading');
    const images = [await c.upload(crop)];
    const useGuide = p.guide !== false && !full;
    if (useGuide) images.push(await c.upload(guide));
    if (ctx.inputs.reference) images.push(await c.upload(ctx.inputs.reference));
    const refNote = ctx.inputs.reference ? ` Use image ${images.length} as the reference for what goes there.` : '';
    const prompt = useGuide
      ? `In image 1, change only the area that image 2 tints and outlines in red: ${p.prompt}. Keep everything outside that area exactly as it is. The result has no red tint or outline.${refNote}`
      : `${p.prompt}${refNote}`;
    const n = p.count ?? 1;
    for (let i = ctx.done; i < n; i++) {
      const seed = ctx.seed(i);
      ctx.step(`repainting ${i + 1} of ${n} (${size.width}x${size.height})`);
      const raw = await editTake(ctx, images, prompt, size, seed);
      const out = ctx.tmp(`repainted-${seed}.png`);
      await ctx.python('edit.py', ['paste', image, mask, raw, box.join(','), String(full ? 0 : p.feather ?? 12), out]);
      await ctx.emit({ data: fs.readFileSync(out), ext: '.png', seed, meta: { crop: box, modelSize: size, full } });
    }
    ctx.result({ crop: box, modelSize: size, full, coverage: info.coverage });
  },
};

export const imageExpandTool: Tool = {
  id: 'image.expand',
  version: 1,
  title: 'Expand the picture',
  description: 'Makes the canvas bigger and fills the new area so the scene carries on seamlessly: give pixels to add on any side (left, right, top, bottom), or an aspect such as "16:9" or "9:16" to reach with the picture centered. Optionally say what is in the new area. The original pixels are kept, blended in with a soft seam. Qwen-Image-Edit 2511; the result is at most 2048 px on its long side.',
  provider: 'comfy',
  family: 'qwen-edit',
  output: 'image',
  inputs: { image: { kind: 'image', required: true } },
  params: {
    left: { type: 'integer', min: 0, max: 4096, description: 'Pixels to add on the left.' },
    right: { type: 'integer', min: 0, max: 4096, description: 'Pixels to add on the right.' },
    top: { type: 'integer', min: 0, max: 4096, description: 'Pixels to add on top.' },
    bottom: { type: 'integer', min: 0, max: 4096, description: 'Pixels to add at the bottom.' },
    aspect: { type: 'string', description: 'Instead of pixels: the shape to reach, centered (e.g. "16:9", "9:16", "1:1", "4:5").', example: '16:9' },
    prompt: { type: 'text', description: 'What is in the new area (optional; the scene just continues without it).' },
    feather: { type: 'integer', min: 0, max: 128, default: 16, description: 'Width of the soft seam, in pixels.', advanced: true },
    negative: { type: 'text', default: '', advanced: true },
    ...qwenSettings,
    ...common,
  },
  models: () => FAMILY_MODELS['qwen-edit'],
  gpuSeconds: () => 20,
  guard({ params }) {
    // Refuse a call with nothing to do before it takes a GPU (the size is checked again when the picture is read).
    const any = ['left', 'right', 'top', 'bottom'].some((k) => Number(params[k]) > 0);
    if (!any && (params.aspect === undefined || params.aspect === '')) throw new GenError('Nothing to expand: give left, right, top or bottom (px), or an aspect such as "16:9"');
    if (any && params.aspect) throw new GenError('Give aspect, or left/right/top/bottom, not both');
    if (params.aspect) parseAspect(params.aspect);
  },
  async run(ctx) {
    const c = ctx.comfy!;
    const p = ctx.params;
    const image = ctx.inputs.image as string;
    const info = lastJson(await ctx.python('edit.py', ['bbox', image, image]));
    const plan = expandPlan(Number(info.width), Number(info.height), p);
    ctx.step(`new canvas ${plan.width}x${plan.height}`);
    const canvas = ctx.tmp('canvas.png');
    await ctx.python('edit.py', ['pad', image, String(plan.width), String(plan.height), plan.rect.join(','), canvas]);
    const images = [await c.upload(canvas)];
    const prompt = `Fill the blurred border of this picture so the scene continues outward seamlessly: the same style, lighting, colors and perspective, with natural detail and no visible seam or frame. Keep the sharp center exactly as it is.${p.prompt ? ` In the new area: ${p.prompt}.` : ''}`;
    const n = p.count ?? 1;
    for (let i = ctx.done; i < n; i++) {
      const seed = ctx.seed(i);
      ctx.step(`expanding ${i + 1} of ${n} (${plan.model.width}x${plan.model.height})`);
      const raw = await editTake(ctx, images, prompt, plan.model, seed);
      const out = ctx.tmp(`expanded-${seed}.png`);
      await ctx.python('edit.py', ['seam', image, raw, String(plan.width), String(plan.height), plan.rect.join(','), String(p.feather ?? 16), out]);
      await ctx.emit({ data: fs.readFileSync(out), ext: '.png', seed, meta: { width: plan.width, height: plan.height, rect: plan.rect } });
    }
    ctx.result(plan);
  },
};
