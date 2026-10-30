// Media plumbing for the editor (CPU, ffmpeg and Pillow, no GPU): video.frame (one frame as an image), video.still (an
// image as a clip) and media.normalize (any upload to files every tool and browser reads). The decisions (what needs
// normalizing, the ffmpeg arguments, the sizes) are pure and tested (test/media-tools.test.ts). This file imports only
// pure modules, like the rest of the CPU suite (src/cpu/suite.ts), so it can move to gen-cpu later.

import fs from 'node:fs';
import type { Tool } from './types.ts';
import { run, GenError } from '../util.ts';
import { zoomOf } from './compose.ts';

// ------------------------------------------------------------------------------------------------ probing

export type ProbeStream = {
  codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string;
  r_frame_rate?: string; avg_frame_rate?: string; nb_frames?: string; duration?: string;
  tags?: Record<string, string>; side_data_list?: { rotation?: number }[]; disposition?: { attached_pic?: number };
};
export type ProbeInfo = { streams?: ProbeStream[]; format?: { format_name?: string; duration?: string } };

export async function probe(file: string, signal?: AbortSignal): Promise<ProbeInfo> {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,duration:stream_tags=rotate:stream_side_data=rotation:stream_disposition=attached_pic', '-of', 'json', file], { signal });
  return JSON.parse(out);
}

const rate = (r?: string) => {
  const [a, b] = String(r ?? '').split('/').map(Number);
  return a > 0 && (b || 1) > 0 ? a / (b || 1) : 0;
};

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'jpegls', 'webp', 'gif', 'bmp', 'tiff', 'heic', 'hevc_image', 'av1_image', 'jpeg2000', 'pam', 'ppm', 'pgm', 'targa', 'qoi', 'psd', 'svg', 'avif']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif', '.jfif', '.tga', '.psd', '.qoi']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wma', '.aiff', '.aif', '.amr', '.weba']);

export type MediaKind = 'image' | 'video' | 'audio' | 'other';

/** What a file is, from its probe (or its extension when ffprobe couldn't read it, as with some HEIC files). */
export function mediaKind(info: ProbeInfo | null, ext = ''): MediaKind {
  const e = ext.toLowerCase();
  const streams = info?.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (v) {
    const still = IMAGE_CODECS.has(String(v.codec_name)) || /image2|png_pipe|jpeg_pipe|webp_pipe|gif|heif|tiff|bmp/.test(String(info?.format?.format_name ?? ''));
    if (still || IMAGE_EXTS.has(e)) return 'image';
    return 'video';
  }
  if (a) return 'audio';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (AUDIO_EXTS.has(e)) return 'audio';
  return 'other';
}

/** The picture's rotation from its metadata (phones store portrait video as landscape plus a rotation). */
export function rotationOf(s: ProbeStream | undefined): number {
  const r = Number(s?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? s?.tags?.rotate ?? 0) || 0;
  return ((Math.round(r) % 360) + 360) % 360;
}

/** Even sides at most `maxSide` long, the same shape (rotation applied: ffmpeg turns the picture upright). */
export function evenFit(w: number, h: number, maxSide = 1920, rotation = 0): { width: number; height: number } {
  if (!(w > 0 && h > 0)) throw new GenError('The video has no picture size');
  if (rotation === 90 || rotation === 270) [w, h] = [h, w];
  const s = Math.min(1, maxSide / Math.max(w, h));
  const even = (v: number) => Math.max(2, Math.floor((v * s) / 2) * 2);
  return { width: even(w), height: even(h) };
}

/** A constant frame rate for the output: the stream's average (variable-rate phone video averages fine), 1 to 60, else 30. */
export function cfrRate(s: ProbeStream | undefined): number {
  const avg = rate(s?.avg_frame_rate);
  const r = rate(s?.r_frame_rate);
  const pick = avg > 0 && avg <= 120 ? avg : r > 0 && r <= 120 ? r : 30;
  const clamped = Math.min(60, Math.max(1, pick));
  // Keep NTSC rates exact (23.976, 29.97, 59.94); round anything else to 3 decimals.
  for (const k of [24, 30, 60]) if (Math.abs(clamped - (k * 1000) / 1001) < 0.01) return Math.round(((k * 1000) / 1001) * 1000) / 1000;
  return Math.round(clamped * 1000) / 1000;
}

export type NormalizeCheck = { kind: MediaKind; needed: boolean; reasons: string[] };

/**
 * Whether a file needs media.normalize before the editor's tools and every browser can use it. Already fine: H.264
 * yuv420p MP4/MOV video with even sides at most 1920 long, a constant frame rate and AAC (or no) sound; PNG or RGB/gray
 * JPEG images; MP3, AAC or WAV audio. Anything else (WebM, MKV, AVI, HEVC, odd sizes, variable frame rate, WebP, HEIC,
 * GIF, CMYK JPEG, Opus, FLAC...) needs it.
 */
export function normalizeCheck(info: ProbeInfo | null, ext = ''): NormalizeCheck {
  const kind = mediaKind(info, ext);
  const reasons: string[] = [];
  const e = ext.toLowerCase();
  const fmt = String(info?.format?.format_name ?? '');
  const streams = info?.streams ?? [];
  if (kind === 'video') {
    const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)!;
    const a = streams.find((s) => s.codec_type === 'audio');
    if (!/mp4|mov/.test(fmt) || !['.mp4', '.m4v', '.mov'].includes(e || '.mp4')) reasons.push(`container ${fmt || e || 'unknown'}`);
    if (v.codec_name !== 'h264') reasons.push(`video codec ${v.codec_name ?? 'unknown'}`);
    if (v.pix_fmt && v.pix_fmt !== 'yuv420p' && v.pix_fmt !== 'yuvj420p') reasons.push(`pixel format ${v.pix_fmt}`);
    if (Number(v.width) % 2 || Number(v.height) % 2) reasons.push(`odd size ${v.width}x${v.height}`);
    if (Math.max(Number(v.width) || 0, Number(v.height) || 0) > 1920) reasons.push(`larger than 1920 (${v.width}x${v.height})`);
    const avg = rate(v.avg_frame_rate);
    const r = rate(v.r_frame_rate);
    if (avg > 0 && r > 0 && Math.abs(avg - r) / r > 0.02) reasons.push(`variable frame rate (${Math.round(avg * 100) / 100} average, ${Math.round(r * 100) / 100} nominal)`);
    if (r > 60.5 && avg > 60.5) reasons.push(`frame rate ${Math.round(r)} over 60`);
    if (a && a.codec_name !== 'aac') reasons.push(`sound codec ${a.codec_name ?? 'unknown'}`);
    if (rotationOf(v)) reasons.push(`rotated ${rotationOf(v)} degrees in metadata`);
  } else if (kind === 'image') {
    const v = streams.find((s) => s.codec_type === 'video');
    const codec = String(v?.codec_name ?? '');
    const pngOk = codec === 'png' || (!codec && e === '.png');
    // An RGB or gray JPEG decodes as yuvj4xxp or gray; a CMYK or YCCK one as cmyk/ycck, or 4-channel gbrap (ffmpeg 8).
    const pix = String(v?.pix_fmt ?? '');
    const cmyk = /cmyk|ycck|gbrap/i.test(pix);
    const jpgOk = (codec === 'mjpeg' || (!codec && /\.jpe?g$/.test(e))) && !cmyk && (!pix || /^(yuvj?4\d\dp|gray)/.test(pix));
    if (!pngOk && !jpgOk) reasons.push(cmyk ? 'CMYK JPEG' : `image format ${codec || e || 'unknown'}${codec === 'mjpeg' && pix ? ` (${pix})` : ''}`);
  } else if (kind === 'audio') {
    const a = streams.find((s) => s.codec_type === 'audio');
    const codec = String(a?.codec_name ?? '');
    if (!(codec === 'mp3' || codec === 'aac' || codec.startsWith('pcm_'))) reasons.push(`sound format ${codec || e || 'unknown'}`);
  }
  return { kind, needed: reasons.length > 0, reasons };
}

/** The ffmpeg arguments that make a video H.264 yuv420p MP4 with AAC sound (silence added when it has none). */
export function normalizeVideoArgs(info: ProbeInfo, src: string, out: string, o: { maxSide?: number; crf?: number } = {}): string[] {
  const v = (info.streams ?? []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new GenError('No video stream in the file');
  const a = (info.streams ?? []).find((s) => s.codec_type === 'audio');
  const { width, height } = evenFit(Number(v.width), Number(v.height), o.maxSide ?? 1920, rotationOf(v));
  const fps = cfrRate(v);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src];
  if (!a) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push(
    '-map', '0:v:0', '-map', a ? '0:a:0' : '1:a:0',
    '-vf', `scale=${width}:${height}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p`,
    '-fps_mode', 'cfr', '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(o.crf ?? 20), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-shortest', '-movflags', '+faststart', '-map_metadata', '-1', out,
  );
  return args;
}

/** The ffmpeg arguments that make any sound file an MP3 (the first audio stream; cover art dropped). */
export function normalizeAudioArgs(src: string, out: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-ar', '44100', '-map_metadata', '-1', out];
}

// ------------------------------------------------------------------------------------------------ tools

export const mediaNormalizeTool: Tool = {
  id: 'media.normalize',
  version: 1,
  title: 'Make a file editor-ready',
  description: 'Converts an upload into files every tool and browser reads: any video (MOV, WebM, MKV, AVI, HEVC, variable frame rate, odd sizes, phone rotation) becomes an H.264 MP4 with AAC sound, even sides at most 1920 long and a constant frame rate; any image (WebP, GIF first frame, BMP, TIFF, CMYK JPEG, HEIC where supported) becomes PNG (with transparency) or JPEG; any sound becomes MP3. Uploads that need it are queued for it automatically (POST /v1/assets says needsNormalize). CPU only.',
  provider: 'local',
  output: 'file',
  inputs: { file: { kind: 'file', required: true, description: 'The video, image or sound file.' } },
  params: {
    maxSide: { type: 'integer', min: 256, max: 1920, default: 1920, description: 'Longest video side.', advanced: true },
    force: { type: 'boolean', default: false, description: 'Convert even when the file is already fine.', advanced: true },
  },
  async run(ctx) {
    const src = ctx.inputs.file as string;
    const ext = (/\.[a-z0-9]+$/i.exec(src)?.[0] ?? '').toLowerCase();
    let info: ProbeInfo | null = null;
    try { info = await probe(src, ctx.signal); } catch (e) { ctx.log(`ffprobe could not read it (${e instanceof Error ? e.message : e}); going by its extension`); }
    const check = normalizeCheck(info, ext);
    ctx.log(`${check.kind}: ${check.needed ? check.reasons.join(', ') : 'already fine'}`);
    if (check.kind === 'other') throw new GenError('This is not a video, image or sound file Gen can read');
    if (!check.needed && !ctx.params.force) {
      // Already fine: the same bytes come back, so the app can treat every upload the same way.
      await ctx.emit({ data: fs.readFileSync(src), ext: ext || undefined, title: 'normalized', meta: { unchanged: true, kind: check.kind } });
      ctx.result({ kind: check.kind, changed: false, reasons: [] });
      return;
    }
    if (check.kind === 'video') {
      const out = ctx.tmp('normalized.mp4');
      ctx.step(`converting the video (${check.reasons.join(', ') || 'forced'})`);
      await run('ffmpeg', normalizeVideoArgs(info!, src, out, { maxSide: ctx.params.maxSide }), { signal: ctx.signal });
      const after = await probe(out, ctx.signal);
      const v = after.streams?.find((s) => s.codec_type === 'video');
      const meta = { kind: 'video', width: v?.width, height: v?.height, fps: cfrRate(v), duration: Number(after.format?.duration) || null, reasons: check.reasons };
      await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', title: 'normalized', meta });
      ctx.result({ ...meta, changed: true });
    } else if (check.kind === 'audio') {
      const out = ctx.tmp('normalized.mp3');
      ctx.step('converting the sound to MP3');
      await run('ffmpeg', normalizeAudioArgs(src, out), { signal: ctx.signal });
      await ctx.emit({ data: fs.readFileSync(out), ext: '.mp3', title: 'normalized', meta: { kind: 'audio', reasons: check.reasons } });
      ctx.result({ kind: 'audio', changed: true, reasons: check.reasons });
    } else {
      ctx.step('converting the image');
      const base = ctx.tmp('normalized');
      const r = JSON.parse((await ctx.python('media.py', ['image', src, base])).trim().split('\n').pop() || '{}');
      if (!r.file) throw new GenError(r.error ?? 'Could not read the image');
      await ctx.emit({ data: fs.readFileSync(r.file), ext: r.ext, title: 'normalized', meta: { kind: 'image', width: r.width, height: r.height, reasons: check.reasons } });
      ctx.result({ kind: 'image', changed: true, width: r.width, height: r.height, format: r.ext.slice(1), reasons: check.reasons });
    }
  },
};

/** ffmpeg arguments for one frame of a video at `at` ("first", "last" or seconds). */
export function frameArgs(src: string, out: string, at: string | number, duration: number | null): string[] {
  const base = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (at === 'first' || at === 0 || at === '0') return [...base, '-i', src, '-frames:v', '1', out];
  if (at === 'last') {
    // Decode the last second and keep overwriting the one picture: what's left is the true last frame.
    return [...base, '-sseof', '-1', '-i', src, '-update', '1', out];
  }
  const t = Number(at);
  if (!Number.isFinite(t) || t < 0) throw new GenError('at is "first", "last" or a time in seconds');
  if (duration !== null && t > duration + 0.001) throw new GenError(`at ${t}s is past the end of the video (${Math.round(duration * 100) / 100}s)`);
  return [...base, '-ss', String(Math.round(t * 1000) / 1000), '-i', src, '-frames:v', '1', out];
}

export const videoFrameTool: Tool = {
  id: 'video.frame',
  version: 1,
  title: 'Grab a frame',
  description: 'One frame of a video as an image (PNG, or JPEG): at a time in seconds, or "first" or "last" (the true last frame, for continuing a clip from where it ends). Use it to edit a frame (image.edit, image.repaint) or start the next clip from it (video.i2v). CPU only.',
  provider: 'local',
  output: 'image',
  inputs: { video: { kind: 'video', required: true } },
  params: {
    at: { type: 'string', default: 'first', description: '"first", "last", or seconds from the start (e.g. 2.5).', example: 'last' },
    format: { type: 'enum', values: ['png', 'jpg'], default: 'png', advanced: true },
  },
  async run(ctx) {
    const src = ctx.inputs.video as string;
    const at = String(ctx.params.at ?? 'first').trim().toLowerCase();
    const info = await probe(src, ctx.signal);
    if (mediaKind(info) !== 'video') throw new GenError('That file has no video picture');
    const duration = Number(info.format?.duration) || null;
    const out = ctx.tmp(`frame.${ctx.params.format === 'jpg' ? 'jpg' : 'png'}`);
    ctx.step(`taking the ${at === 'first' || at === 'last' ? at : `${at}s`} frame`);
    const args = frameArgs(src, out, at === 'first' || at === 'last' ? at : Number(at), duration);
    if (ctx.params.format === 'jpg') args.splice(args.length - 1, 0, '-q:v', '2');
    await run('ffmpeg', args, { signal: ctx.signal });
    if (!fs.existsSync(out) || !fs.statSync(out).size) throw new GenError('No frame there (the video may be shorter than it says)');
    const v = (await probe(out, ctx.signal)).streams?.[0];
    const meta = { at, width: v?.width, height: v?.height, duration };
    await ctx.emit({ data: fs.readFileSync(out), ext: ctx.params.format === 'jpg' ? '.jpg' : '.png', title: 'frame', meta });
    ctx.result(meta);
  },
};

/** The ffmpeg arguments for video.still: the image looped for `seconds`, scaled to fit (padded), optionally pushing in. */
export function stillArgs(src: string, out: string, o: { width: number; height: number; seconds: number; fps: number; zoom?: { from?: number; to?: number; x?: number; y?: number } | null }): string[] {
  const frames = Math.max(1, Math.round(o.seconds * o.fps));
  const fit = `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  const zoom = zoomOf(o.zoom ?? undefined, frames, { width: o.width, height: o.height, fps: o.fps, fit: 'pad', color: '000000', burn: false });
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', String(o.fps), '-i', src,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', `format=rgb24,${fit}${zoom},format=yuv420p`,
    '-frames:v', String(frames), '-r', String(o.fps),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-tune', 'stillimage',
    '-c:a', 'aac', '-b:a', '128k', '-t', String(Math.round((frames / o.fps) * 1000) / 1000),
    '-movflags', '+faststart', out,
  ];
}

export const videoStillTool: Tool = {
  id: 'video.still',
  version: 1,
  title: 'Still image as a clip',
  description: 'Turns an image into a video clip (H.264 MP4 with a silent sound track) of a few seconds, so it can go on a timeline with video.compose: at the image\'s own size (made even) or a width and height you give (fitted, with black bars), optionally with a slow push-in (zoom from 1 to 1.2, say). CPU only.',
  provider: 'local',
  output: 'video',
  inputs: { image: { kind: 'image', required: true } },
  params: {
    seconds: { type: 'number', min: 0.2, max: 60, default: 3 },
    width: { type: 'integer', min: 64, max: 3840, description: 'With height: the clip\'s size (the image is fitted). Default: the image\'s own size, at most 1920 on its long side.' },
    height: { type: 'integer', min: 64, max: 3840 },
    fps: { type: 'integer', min: 1, max: 60, default: 30, advanced: true },
    zoom: { type: 'json', description: 'A push-in: { from, to } (1 = the whole picture, 2 = half of it) and where it heads, { x, y } from 0 to 1.', example: { from: 1, to: 1.15 } },
  },
  async run(ctx) {
    const p = ctx.params;
    if ((p.width === undefined) !== (p.height === undefined)) throw new GenError('Give both width and height, or neither');
    const src = ctx.inputs.image as string;
    let size: { width: number; height: number };
    if (p.width !== undefined) size = { width: Math.floor(p.width / 2) * 2, height: Math.floor(p.height / 2) * 2 };
    else {
      const v = (await probe(src, ctx.signal)).streams?.find((s) => s.codec_type === 'video');
      size = evenFit(Number(v?.width), Number(v?.height), 1920);
    }
    const zoom = p.zoom && typeof p.zoom === 'object' ? p.zoom : null;
    const out = ctx.tmp('still.mp4');
    ctx.step(`${p.seconds}s at ${size.width}x${size.height}`);
    await run('ffmpeg', stillArgs(src, out, { ...size, seconds: Number(p.seconds), fps: Number(p.fps), zoom }), { signal: ctx.signal });
    const meta = { width: size.width, height: size.height, seconds: Number(p.seconds), fps: Number(p.fps) };
    await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', title: 'clip', meta });
    ctx.result(meta);
  },
};
