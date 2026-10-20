// image.sheet: views of one character laid side by side in one equal-cell sheet with ffmpeg (free, local). It is the
// input mesh.views3d wants: front, back, left, right in that order.

import fs from 'node:fs';
import type { Tool } from './types.ts';
import { run } from '../util.ts';

/** The ffmpeg filter graph: each view scaled to fit its cell, padded to the cell, then stacked left to right. */
export function planSheet(n: number, cell: number, color: string): string {
  const parts = Array.from({ length: n }, (_, i) =>
    `[${i}:v]scale=${cell}:${cell}:force_original_aspect_ratio=decrease,pad=${cell}:${cell}:(ow-iw)/2:(oh-ih)/2:color=0x${color}[v${i}]`);
  const tail = n === 1 ? `[v0]null[out]` : `${Array.from({ length: n }, (_, i) => `[v${i}]`).join('')}hstack=inputs=${n}[out]`;
  return [...parts, tail].join(';');
}

export const sheetTool: Tool = {
  id: 'image.sheet',
  version: 1,
  title: 'Turnaround sheet',
  description: 'Lays 2-6 views of one character side by side in equal square cells (free, on this machine). Give them front, back, left, right in that order to make the sheet mesh.views3d reads. Views should share scale, framing and a plain background (use image.cutout first).',
  provider: 'local',
  output: 'image',
  inputs: { views: { kind: 'image', required: true, multiple: true, max: 6, description: 'The views, left to right.' } },
  params: {
    cell: { type: 'integer', min: 256, max: 2048, default: 1024, description: 'Each view\'s square cell, in pixels.' },
    color: { type: 'string', default: 'ffffff', description: 'Background color (hex).', advanced: true },
  },
  async run(ctx) {
    const views = (Array.isArray(ctx.inputs.views) ? ctx.inputs.views : [ctx.inputs.views]) as string[];
    if (views.length < 2) throw new Error('image.sheet needs at least 2 views');
    const cell = Math.round(Number(ctx.params.cell));
    const color = String(ctx.params.color).replace(/^#/, '');
    const out = ctx.tmp('sheet.png');
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const v of views) args.push('-i', v);
    args.push('-filter_complex', planSheet(views.length, cell, color), '-map', '[out]', '-frames:v', '1', out);
    ctx.step(`laying ${views.length} view(s) into a sheet`);
    await run('ffmpeg', args, { signal: ctx.signal });
    await ctx.emit({ data: fs.readFileSync(out), ext: '.png', title: 'sheet', meta: { views: views.length, width: cell * views.length, height: cell } });
    ctx.result({ views: views.length, width: cell * views.length, height: cell });
  },
};
