// Tools that run on this machine: no GPU server, no API key.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { run } from '../util.ts';

export const cutoutTool: Tool = {
  id: 'image.cutout',
  version: 1,
  title: 'Cut out the subject',
  description: 'Removes the background with a segmentation model (BiRefNet by default; ISNet, or both combined for wispy edges). Glow mode keeps fire and light on a black backdrop as soft light. Runs on this PC (about a minute on the CPU).',
  provider: 'local',
  output: 'image',
  inputs: { image: { kind: 'image', required: true } },
  params: {
    mode: { type: 'enum', values: ['birefnet', 'isnet', 'union'], default: 'birefnet' },
    glow: { type: 'boolean', default: false },
    crop: { type: 'boolean', default: true, description: 'Crop to the subject with a margin.' },
    pad: { type: 'integer', min: 0, max: 256, default: 16, advanced: true },
  },
  async run(ctx) {
    const out = ctx.tmp('cutout.png');
    ctx.step(`cutting out with ${ctx.params.mode}`);
    const args = [ctx.inputs.image, out, '--mode', ctx.params.mode, '--pad', String(ctx.params.pad)];
    if (ctx.params.glow) args.push('--glow');
    if (!ctx.params.crop) args.push('--no-crop');
    const info = JSON.parse((await ctx.python('cutout.py', args)).trim().split('\n').pop() || '{}');
    await ctx.emit({ data: fs.readFileSync(out), ext: '.png', meta: info });
    ctx.result(info);
  },
};

export const frameTool: Tool = {
  id: 'image.frame',
  version: 1,
  title: 'Frame on a flat background',
  description: 'Fits an image (a cutout, a pose) into a frame on a flat color with the feet near the bottom, the way video models want a first frame. Every pose framed with the same fill shares one scale.',
  provider: 'local',
  output: 'image',
  inputs: { image: { kind: 'image', required: true } },
  params: {
    width: { type: 'integer', min: 64, max: 2048, default: 640 },
    height: { type: 'integer', min: 64, max: 2048, default: 640 },
    fill: { type: 'number', min: 0.1, max: 1, default: 0.78, description: 'Share of the frame height the figure takes.' },
    color: { type: 'string', default: '00ff00', description: 'Background color (hex).' },
    bottom: { type: 'number', min: 0, max: 0.5, default: 0.06, description: 'Gap under the feet, as a share of the height.' },
  },
  async run(ctx) {
    const p = ctx.params;
    const out = ctx.tmp('framed.png');
    await ctx.python('prep.py', ['frame', ctx.inputs.image, out, String(p.width), String(p.height), String(p.fill), String(p.color).replace(/^#/, ''), String(p.bottom)]);
    await ctx.emit({ data: fs.readFileSync(out), ext: '.png' });
  },
};

export const videoFitTool: Tool = {
  id: 'video.fit',
  version: 1,
  title: 'Fit a driving video',
  description: 'Resamples a video to the rate video models make (16 fps), fits it into a frame and cuts it to a maximum length. Returns the frame count. Use before video.animate.',
  provider: 'local',
  output: 'video',
  inputs: { video: { kind: 'video', required: true } },
  params: {
    width: { type: 'integer', min: 64, max: 1920, default: 640 },
    height: { type: 'integer', min: 64, max: 1920, default: 640 },
    maxFrames: { type: 'integer', min: 5, max: 481, default: 77 },
    fps: { type: 'integer', min: 4, max: 60, default: 16 },
  },
  async run(ctx) {
    const p = ctx.params;
    const out = ctx.tmp('fit.mp4');
    const frames = Number((await ctx.python('prep.py', ['motion', ctx.inputs.video, out, String(p.width), String(p.height), String(p.maxFrames), String(p.fps)])).trim());
    await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', meta: { frames } });
    ctx.result({ frames });
  },
};

export const tileTool: Tool = {
  id: 'image.tile',
  version: 1,
  title: 'Make seamless',
  description: 'Makes an image tile seamlessly (crossfades it with a half-shifted copy).',
  provider: 'local',
  output: 'image',
  inputs: { image: { kind: 'image', required: true } },
  params: { blend: { type: 'number', min: 0.05, max: 0.5, default: 0.25 } },
  async run(ctx) {
    const out = ctx.tmp('tiled.png');
    await ctx.python('texture.py', ['tile', ctx.inputs.image, out, String(ctx.params.blend)]);
    await ctx.emit({ data: fs.readFileSync(out), ext: '.png' });
  },
};

export const materialMapsTool: Tool = {
  id: 'texture.maps',
  version: 1,
  title: 'Material maps',
  description: 'From one albedo texture: the albedo with baked lighting flattened, a normal map (OpenGL, +Y up) and a roughness map, for Babylon.js or Unity materials. Pair with image.generate seamless:true.',
  provider: 'local',
  output: 'image',
  inputs: { image: { kind: 'image', required: true } },
  params: { strength: { type: 'number', min: 0.1, max: 10, default: 2, description: 'Normal map bump strength.' } },
  async run(ctx) {
    const dir = ctx.tmp('maps');
    await ctx.python('texture.py', ['maps', ctx.inputs.image, dir, String(ctx.params.strength)]);
    for (const name of ['albedo', 'normal', 'roughness']) {
      await ctx.emit({ data: fs.readFileSync(path.join(dir, `${name}.png`)), ext: '.png', title: name, meta: { map: name } });
    }
  },
};

export const probeTool: Tool = {
  id: 'media.probe',
  version: 1,
  title: 'Probe media',
  description: 'Size, length, frame rate and codecs of an image, video or audio file (ffprobe).',
  provider: 'local',
  output: 'json',
  inputs: { file: { kind: 'file', required: true } },
  params: {},
  async run(ctx) {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,sample_rate,channels', '-of', 'json', ctx.inputs.file]);
    ctx.result(JSON.parse(out));
  },
};

export const importTool: Tool = {
  id: 'file.import',
  version: 1,
  title: 'Import a file',
  description: 'Puts a file into the library as it is (a screenshot from a bug report, a reference image), with a title and meta, so it gets an asset id and a /v1/files link like any output. Nothing is generated.',
  provider: 'local',
  output: 'file',
  inputs: { file: { kind: 'file', required: true } },
  params: {
    title: { type: 'string', description: 'The asset title.' },
    meta: { type: 'json', description: 'Anything to keep with it (e.g. { "report": "f_..." }).', advanced: true },
  },
  async run(ctx) {
    const ext = path.extname(ctx.inputs.file).toLowerCase() || undefined;
    const meta = ctx.params.meta && typeof ctx.params.meta === 'object' ? ctx.params.meta : undefined;
    await ctx.emit({ data: fs.readFileSync(ctx.inputs.file), ext, title: ctx.params.title ? String(ctx.params.title).slice(0, 200) : undefined, meta });
  },
};
