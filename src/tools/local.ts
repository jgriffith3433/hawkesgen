// Tools that run on this machine: no GPU server, no API key.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { run, GenError } from '../util.ts';

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

export const splatBuildTool: Tool = {
  id: 'splat.build',
  version: 1,
  title: 'Build 3D Gaussian Splat (.splat)',
  description:
    'Builds a 3D Gaussian Splat (.splat, 32 bytes per splat for Babylon.js GaussianSplattingMesh) and a rendered 2D preview PNG ' +
    'from an input image (+ optional depth map) or a procedural/parametric scene recipe (subway-tunnel, subway-station, or subway-car-full ' +
    'matching PH Origins Level 7 coordinates). Runs locally on the CPU.',
  provider: 'local',
  output: 'mesh',
  inputs: {
    image: { kind: 'image', required: false, description: 'Reference image or panorama to lift into 3D Gaussian splats.' },
    depth: { kind: 'image', required: false, description: 'Optional grayscale depth map (bright = near or far depending on scene).' },
  },
  params: {
    presetScene: {
      type: 'enum',
      values: ['auto', 'subway-tunnel', 'subway-station', 'subway-car-full'],
      default: 'auto',
      description: 'Parametric scene layout (matching PH Origins Level 7 coordinates) or auto (image lift when image is given, else subway-car-full).',
    },
    maxSplats: {
      type: 'integer',
      min: 64,
      max: 500000,
      default: 180000,
      description: 'Maximum splat count (180,000 default for mobile-safe 60fps; up to 500,000 for desktop).',
    },
    density: {
      type: 'number',
      min: 0.1,
      max: 4.0,
      default: 1.0,
      description: 'Sampling density multiplier before capping to maxSplats.',
    },
    splatScale: {
      type: 'number',
      min: 0.1,
      max: 5.0,
      default: 1.0,
      description: 'Scale multiplier for individual 3D Gaussians.',
    },
    bounds: {
      type: 'string',
      default: '0,18,0,2.8,-2.6,6.5',
      description: 'World-space bounding box xMin,xMax,yMin,yMax,zMin,zMax in meters.',
      advanced: true,
    },
    mode: {
      type: 'enum',
      values: ['auto', 'relief', 'panorama'],
      default: 'auto',
      description: 'How an input image is projected into 3D space.',
      advanced: true,
    },
    seed: {
      type: 'integer',
      min: 0,
      max: 2147483647,
      default: 42,
      advanced: true,
    },
  },
  async run(ctx) {
    const p = ctx.params;
    if (p.presetScene === 'auto' && !ctx.inputs.image) {
      // Allow default procedural build when neither image nor explicit presetScene is set, or if presetScene is given
    }
    const outSplat = ctx.tmp('scene.splat');
    const outPreview = ctx.tmp('preview.png');
    const seed = ctx.seed(0);
    ctx.step(`building Gaussian splat (${p.presetScene}, max ${p.maxSplats} splats)`);
    const args = [
      '--out-splat', outSplat,
      '--out-preview', outPreview,
      '--preset-scene', String(p.presetScene ?? 'auto'),
      '--max-splats', String(p.maxSplats ?? 180000),
      '--density', String(p.density ?? 1.0),
      '--splat-scale', String(p.splatScale ?? 1.0),
      '--bounds', String(p.bounds ?? '0,18,0,2.8,-2.6,6.5'),
      '--mode', String(p.mode ?? 'auto'),
      '--seed', String(seed),
    ];
    if (ctx.inputs.image) args.push('--image', String(ctx.inputs.image));
    if (ctx.inputs.depth) args.push('--depth', String(ctx.inputs.depth));
    const stdout = await ctx.python('splat.py', args);
    const info = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    const splatBuf = fs.readFileSync(outSplat);
    if (splatBuf.length === 0 || splatBuf.length % 32 !== 0) {
      throw new GenError(`splat.build produced invalid .splat buffer (${splatBuf.length} bytes, must be a positive multiple of 32)`);
    }
    await ctx.emit({ data: splatBuf, ext: '.splat', seed, title: 'splat', meta: info });
    await ctx.emit({ data: fs.readFileSync(outPreview), ext: '.png', seed, title: 'preview', meta: info });
    ctx.result(info);
  },
};

/** The grid a sprite sheet uses: the given columns, else the squarest one with the fewest empty cells (8 -> 4x2). */
export function spriteGrid(count: number, columns = 0) {
  if (columns) {
    const cols = Math.max(1, Math.min(count, columns));
    return { cols, rows: Math.ceil(count / cols) };
  }
  // From the squarest grid outward; the first with the fewest empty cells wins, and nothing past twice as wide as tall.
  let best: { cols: number; rows: number } | null = null;
  for (let cols = Math.ceil(Math.sqrt(count)); cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    if (best && cols > 2 * rows && best.cols * best.rows - count <= 1) break;
    if (!best || rows * cols - count < best.rows * best.cols - count) best = { cols, rows };
  }
  return best ?? { cols: 1, rows: 1 };
}

/** The ffmpeg filters that key a flat background out: RGB distance (grey armor isn't "a bit green", as it is to
 *  chromakey), then the color's spill pulled off the edges (green or blue screens). */
export function keyFilter(key: string, similarity: number, blend: number) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(key.slice(i, i + 2), 16));
  const spill = g > r + 64 && g > b + 64 ? 'green' : b > r + 64 && b > g + 64 ? 'blue' : '';
  return [`colorkey=0x${key}:${similarity}:${blend}`, spill ? `despill=type=${spill}:mix=0.6:expand=0.1:alpha=0` : ''].filter(Boolean).join(',');
}

/** `count` indexes spread evenly over `total` frames, first and last included. A loop ends where it began, so its last
 *  frame repeats the first: it is left out and the frames spread over one cycle. */
export function pickFrames(total: number, count: number, loop = false) {
  if (loop && total > 2) {
    const cycle = total - 1;
    if (cycle <= count) return Array.from({ length: cycle }, (_, i) => i);
    return Array.from({ length: count }, (_, i) => Math.round((i * cycle) / count));
  }
  if (total <= count) return Array.from({ length: total }, (_, i) => i);
  return Array.from({ length: count }, (_, i) => Math.round((i * (total - 1)) / (count - 1 || 1)));
}

export const spriteSheetTool: Tool = {
  id: 'sprite.sheet',
  version: 2,
  title: 'Sprite sheet',
  description: 'An animation (a clip from video.i2v, or frames) as a game-ready sprite sheet, with ffmpeg (free): evenly spaced frames, a flat background keyed out to transparency (animate on a flat color, e.g. image.frame on 00ff00, then key 00ff00), one PNG atlas, the frame rectangles as JSON (Unity, Godot, Phaser, TexturePacker hash) and an animated GIF preview.',
  provider: 'local',
  output: 'image',
  inputs: {
    video: { kind: 'video', description: 'The animation. Or give frames instead.' },
    frames: { kind: 'image', multiple: true, max: 64, description: 'The frames, in order (instead of a video).' },
  },
  params: {
    // Not `count`: that means "how many takes" everywhere else, and is what pricing multiplies by.
    frames: { type: 'integer', min: 2, max: 64, default: 8, description: 'How many frames the sheet has (spread evenly over the clip).' },
    columns: { type: 'integer', min: 0, max: 64, default: 0, description: 'Frames per row; 0 picks a square-ish grid.' },
    cell: { type: 'integer', min: 32, max: 1024, default: 256, description: 'Width of one frame in pixels (height keeps the aspect).' },
    key: { type: 'string', default: '', description: 'Background color to make transparent (hex, e.g. 00ff00); empty keeps the background.' },
    similarity: { type: 'number', min: 0.01, max: 0.6, default: 0.3, description: 'How close to the key color a pixel must be to go transparent.', advanced: true },
    blend: { type: 'number', min: 0, max: 0.5, default: 0.1, description: 'Soft edge around the keyed area.', advanced: true },
    loop: { type: 'boolean', default: false, description: 'The clip loops (ends on its first frame): leave the repeat out so the cycle plays smoothly.' },
    fps: { type: 'integer', min: 1, max: 60, default: 12, description: 'Playback rate written to the JSON and the preview.' },
    name: { type: 'string', default: 'frame', description: 'Frame names in the JSON (frame_00, frame_01, ...).', advanced: true },
  },
  async run(ctx) {
    const p = ctx.params;
    const frames = Array.isArray(ctx.inputs.frames) ? ctx.inputs.frames : ctx.inputs.frames ? [ctx.inputs.frames] : [];
    if (!ctx.inputs.video && !frames.length) throw new GenError('Give a video or frames');
    const key = String(p.key ?? '').replace(/^#/, '').trim();
    if (key && !/^[0-9a-f]{6}$/i.test(key)) throw new GenError('key is a hex color like 00ff00');
    const vf = [key ? keyFilter(key, Number(p.similarity), Number(p.blend)) : '', `scale=${p.cell}:-2:flags=lanczos`, 'format=rgba'].filter(Boolean).join(',');

    // Every frame, keyed and scaled, then the chosen ones renumbered in order.
    const all = ctx.tmp('all');
    const sel = ctx.tmp('sel');
    fs.mkdirSync(all, { recursive: true });
    fs.mkdirSync(sel, { recursive: true });
    ctx.step('reading frames');
    if (ctx.inputs.video) {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', ctx.inputs.video, '-vf', vf, '-vsync', '0', path.join(all, '%05d.png')]);
    } else {
      for (const [i, f] of frames.entries()) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', f, '-vf', vf, '-frames:v', '1', path.join(all, `${String(i + 1).padStart(5, '0')}.png`)]);
    }
    const files = fs.readdirSync(all).filter((f) => f.endsWith('.png')).sort();
    if (!files.length) throw new GenError('No frames in the input');
    const picked = pickFrames(files.length, Number(p.frames), Boolean(p.loop) && Boolean(ctx.inputs.video));
    picked.forEach((idx, i) => fs.copyFileSync(path.join(all, files[idx]), path.join(sel, `${String(i + 1).padStart(5, '0')}.png`)));

    const { cols, rows } = spriteGrid(picked.length, Number(p.columns));
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', path.join(sel, '00001.png')]));
    const w = Number(probe.streams?.[0]?.width) || Number(p.cell);
    const h = Number(probe.streams?.[0]?.height) || Number(p.cell);

    ctx.step(`laying out ${picked.length} frames (${cols}x${rows})`);
    const atlas = ctx.tmp('sheet.png');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(sel, '%05d.png'), '-vf', `format=rgba,tile=${cols}x${rows}:color=0x00000000`, '-frames:v', '1', atlas]);
    const gif = ctx.tmp('preview.gif');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(p.fps), '-i', path.join(sel, '%05d.png'), '-vf', 'split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128', '-loop', '0', gif]);

    const name = String(p.name || 'frame').replace(/[^\w-]/g, '') || 'frame';
    const rects = picked.map((_, i) => ({ name: `${name}_${String(i).padStart(2, '0')}`, x: (i % cols) * w, y: Math.floor(i / cols) * h, w, h }));
    const sheet = {
      frames: Object.fromEntries(rects.map((r) => [r.name, { frame: { x: r.x, y: r.y, w: r.w, h: r.h }, rotated: false, trimmed: false, sourceSize: { w: r.w, h: r.h } }])),
      animations: { [name]: rects.map((r) => r.name) },
      meta: { app: 'Hawkes Gen sprite.sheet', image: 'sheet.png', size: { w: cols * w, h: rows * h }, format: 'RGBA8888', scale: '1', fps: Number(p.fps), columns: cols, rows, frameWidth: w, frameHeight: h, count: picked.length },
    };
    await ctx.emit({ data: fs.readFileSync(atlas), ext: '.png', title: 'sprite sheet', meta: sheet.meta });
    await ctx.emit({ data: Buffer.from(JSON.stringify(sheet, null, 2)), ext: '.json', title: 'sprite sheet frames' });
    await ctx.emit({ data: fs.readFileSync(gif), ext: '.gif', title: 'preview' });
    ctx.result(sheet.meta);
  },
};

export const transformTool: Tool = {
  id: 'image.transform',
  version: 1,
  title: 'Transform an image',
  description: 'Everyday fixes for game art, free and fast (Pillow on this machine), as steps applied in order: resize (contain, cover, stretch; pixel: true for nearest-neighbour), scale, crop, trim to the visible pixels, pad, square, pot (power-of-two sides), flip, rotate, pixelate (pixel art: size, palette colors, upscale), colors (palette), outline (sprite outline), tint, grayscale. Out as PNG, WebP or JPEG.',
  provider: 'local',
  output: 'image',
  inputs: { image: { kind: 'image', required: true } },
  params: {
    ops: { type: 'json', required: true, description: 'The steps, e.g. [{"op":"trim","pad":4},{"op":"pixelate","size":64,"colors":16},{"op":"outline","width":1}].', example: [{ op: 'trim' }, { op: 'resize', width: 128, height: 128 }] },
    format: { type: 'enum', values: ['png', 'webp', 'jpg'], default: 'png' },
    quality: { type: 'integer', min: 1, max: 100, default: 90, advanced: true, description: 'WebP and JPEG quality.' },
  },
  async run(ctx) {
    const ops = Array.isArray(ctx.params.ops) ? ctx.params.ops : [];
    if (!ops.length || ops.length > 20) throw new GenError('ops: 1 to 20 steps');
    const fmt = String(ctx.params.format);
    const out = ctx.tmp(`transformed.${fmt}`);
    ctx.step(ops.map((o: any) => o?.op).join(', '));
    const info = JSON.parse((await ctx.python('transform.py', [ctx.inputs.image, out, JSON.stringify(ops), fmt, String(ctx.params.quality)])).trim().split('\n').pop() || '{}');
    await ctx.emit({ data: fs.readFileSync(out), ext: `.${fmt}`, meta: info });
    ctx.result(info);
  },
};
