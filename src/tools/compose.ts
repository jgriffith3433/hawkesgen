// video.compose: shots into a finished cut on this machine with ffmpeg (free). The edit order, trims, cuts and
// transitions, each clip's own sound, music and voice tracks (ducked under dialogue), captions (burned in or a .vtt),
// fades from and to black, then a web H.264 mp4 and a poster. Mixed sizes and frame rates are normalized first.
//
// planCompose() turns the timeline and what ffprobe says about each input into one ffmpeg filter graph (no I/O, so the
// tests check it directly); the tool probes, plans, runs ffmpeg and emits the results.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { run, filterScriptArgs } from '../util.ts';

export type Probe = { duration: number; video: boolean; audio: boolean; width?: number; height?: number; fps?: number };

export type ClipSpec = {
  /** Which `clips` input (default: its place in the list). */
  clip?: number;
  in?: number;
  out?: number;
  /** How this clip goes into the next: cut (default), crossfade, or another xfade transition. */
  transition?: string;
  /** Transition length (default 0.5 s for anything but a cut). */
  seconds?: number;
  /** Shorthand: crossfade this many seconds into the next. */
  crossfade?: number;
  /** Keep the clip's own sound (default: timeline.sound, else true). */
  sound?: boolean;
  volume?: number;
  /** Its sound is dialogue: ducked tracks dip under it. */
  dialogue?: boolean;
  /** Play faster (2 = twice as fast) or slower (0.5), picture and sound: 0.25 to 4. */
  speed?: number;
  /**
   * Punch in or push in on part of the frame: `to` is the zoom at the clip's end (1 = the whole frame, 2 = half of it),
   * `from` at its start (default the same as `to`: a static punch-in); `x`, `y` (0 to 1) where the zoomed frame sits
   * (0.5, 0.5 = the centre; 0.5, 0.2 = near the top, a face in a medium shot).
   */
  zoom?: { from?: number; to?: number; x?: number; y?: number };
};

export type TrackSpec = {
  /** Which `audio` input (default: its place in the list). */
  audio?: number;
  /** Start in seconds: on the timeline, or after the start of timeline clip `clip`. */
  start?: number;
  clip?: number;
  /** Where to start inside the file. */
  in?: number;
  /** Longest it plays (default: to its end, or the end of the cut). */
  seconds?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean;
  /** Dip under dialogue: true or "envelope" (a volume envelope around the dialogue), or "sidechain" (a compressor keyed by it). */
  duck?: boolean | 'envelope' | 'sidechain';
  /** The level it dips to (envelope: gain, default 0.3; sidechain: sets the compression). */
  duckTo?: number;
  /** This track is dialogue (a voice line). */
  dialogue?: boolean;
};

/** On the cut, or relative to timeline clip `clip`; or `track`: shown while timeline.audio[track] plays (a voice line). */
export type CaptionSpec = { text: string; start?: number; end?: number; seconds?: number; clip?: number; track?: number };

export type Timeline = {
  clips?: ClipSpec[];
  audio?: TrackSpec[];
  captions?: CaptionSpec[];
  /** Keep every clip's own sound unless a clip says otherwise (default true). */
  sound?: boolean;
  /** Fade from black at the start and to black at the end (seconds; picture and sound). */
  fadeIn?: number;
  fadeOut?: number;
};

export type ComposeOptions = { width: number; height: number; fps: number; fit: 'pad' | 'crop'; color: string; burn: boolean; captionsFile?: string };

/** The transitions a clip can go into the next with (timeline name -> ffmpeg xfade). */
export const TRANSITIONS: Record<string, string> = {
  crossfade: 'fade', dissolve: 'dissolve', fadeblack: 'fadeblack', fadewhite: 'fadewhite',
  wipeleft: 'wipeleft', wiperight: 'wiperight', wipeup: 'wipeup', wipedown: 'wipedown',
  slideleft: 'slideleft', slideright: 'slideright', circleopen: 'circleopen', circleclose: 'circleclose',
};

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const f3 = (n: number) => String(Math.round(n * 1000) / 1000);

export type Caption = { start: number; end: number; text: string };

export type Plan = {
  /** One entry per ffmpeg input, in order: the file and whether it loops. */
  inputs: { kind: 'clip' | 'audio'; index: number; loop: boolean; seek?: number }[];
  filter: string;
  duration: number;
  frames: number;
  clips: { clip: number; start: number; end: number; in: number; out: number; transition: string | null; seconds: number }[];
  captions: Caption[];
  notes: string[];
};

/** A clip's zoom as a zoompan after the fit (one output frame per input frame, so timing is untouched); '' for none. */
export function zoomOf(z: ClipSpec['zoom'], frames: number, o: ComposeOptions): string {
  if (!z) return '';
  const clampZ = (v: unknown, d: number) => Math.min(4, Math.max(1, num(v, d)));
  const to = clampZ(z.to, 1);
  const from = clampZ(z.from, to);
  if (from === 1 && to === 1) return '';
  const x = Math.min(1, Math.max(0, num(z.x, 0.5)));
  const y = Math.min(1, Math.max(0, num(z.y, 0.5)));
  const zoom = from === to ? f3(to) : `${f3(from)}+${f3(to - from)}*min(on/${Math.max(1, frames - 1)},1)`;
  return `,zoompan=z='${zoom}':x='(iw-iw/zoom)*${f3(x)}':y='(ih-ih/zoom)*${f3(y)}':d=1:s=${o.width}x${o.height}:fps=${o.fps}`;
}

/** atempo steps for a speed (each step 0.5 to 2). */
function tempoOf(speed: number): string[] {
  const out: string[] = [];
  let left = speed;
  while (left > 2) { out.push('atempo=2'); left /= 2; }
  while (left < 0.5) { out.push('atempo=0.5'); left /= 0.5; }
  if (Math.abs(left - 1) > 1e-3) out.push(`atempo=${f3(left)}`);
  return out;
}

export function planCompose(tl: Timeline, clips: Probe[], audio: Probe[], o: ComposeOptions): Plan {
  const F = o.fps;
  const specs: ClipSpec[] = tl.clips?.length ? tl.clips : clips.map((_, i) => ({ clip: i }));
  if (!specs.length) throw new Error('No clips: give at least one video in "clips"');
  const notes: string[] = [];
  const inputs: Plan['inputs'] = [];
  const filters: string[] = [];

  // Every length snaps to whole frames, so xfade offsets land exactly.
  const segs = specs.map((c, i) => {
    const src = c.clip ?? i;
    const p = clips[src];
    if (!p) throw new Error(`timeline.clips[${i}]: no clip ${src} (${clips.length} given)`);
    if (!p.video) throw new Error(`timeline.clips[${i}]: clip ${src} has no video stream`);
    const tin = Math.max(0, num(c.in, 0));
    const tout = Math.min(p.duration, num(c.out, p.duration));
    const speed = Math.min(4, Math.max(0.25, num(c.speed, 1)));
    const n = Math.round(((tout - tin) / speed) * F);
    if (n < 2) throw new Error(`timeline.clips[${i}]: in ${f3(tin)} and out ${f3(tout)} leave nothing (clip ${src} is ${f3(p.duration)} s)`);
    let transition: string | null = c.transition ?? (c.crossfade ? 'crossfade' : 'cut');
    if (transition === 'cut') transition = null;
    if (transition && !TRANSITIONS[transition]) throw new Error(`timeline.clips[${i}]: transition is cut or ${Object.keys(TRANSITIONS).join(', ')}`);
    const xs = transition ? num(c.crossfade ?? c.seconds, 0.5) : 0;
    return { i, src, p, tin, tout, n, speed, transition, x: Math.round(xs * F), spec: c };
  });
  segs[segs.length - 1].x = 0;
  segs[segs.length - 1].transition = null;
  for (const s of segs) {
    if (!s.transition) s.x = 0;
    else if (s.x < 1) { s.x = 0; s.transition = null; }
  }
  for (let k = 0; k < segs.length; k++) {
    const before = k ? segs[k - 1].x : 0;
    if (segs[k].x && segs[k].x >= segs[k + 1].n) throw new Error(`timeline.clips[${k}]: the ${f3(segs[k].x / F)} s transition is longer than the next clip`);
    if (before + segs[k].x >= segs[k].n) throw new Error(`timeline.clips[${k}]: its transitions (${f3(before / F)} s in, ${f3(segs[k].x / F)} s out) overlap; the clip is ${f3(segs[k].n / F)} s`);
  }
  const startF: number[] = [0];
  for (let k = 1; k < segs.length; k++) startF[k] = startF[k - 1] + segs[k - 1].n - segs[k - 1].x;
  const frames = startF[segs.length - 1] + segs[segs.length - 1].n;
  const total = frames / F;
  const start = (k: number) => startF[k] / F;

  // Video: each clip trimmed, at the output rate, fitted into the frame, exactly n frames; then cut or xfade together.
  const fit = o.fit === 'crop'
    ? `scale=${o.width}:${o.height}:force_original_aspect_ratio=increase,crop=${o.width}:${o.height}`
    : `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=${o.color}`;
  const clipInput: number[] = [];
  segs.forEach((s, k) => {
    // Each clip seeks to its in point (-ss on the input): 30 shots cut from one long render don't decode it 30 times
    // from the start. The trims are then from 0.
    clipInput[k] = inputs.push({ kind: 'clip', index: s.src, loop: false, ...(s.tin > 0 ? { seek: s.tin } : {}) }) - 1;
    const pts = s.speed === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${f3(s.speed)}`;
    filters.push(`[${clipInput[k]}:v]trim=start=0:end=${f3(s.tout - s.tin)},${pts},fps=${F},${fit}${zoomOf(s.spec.zoom, s.n, o)},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${s.n},setpts=PTS-STARTPTS,settb=1/${F}[v${k}]`);
  });
  let acc = 'v0';
  for (let k = 1; k < segs.length; k++) {
    const prev = segs[k - 1];
    const out = `x${k}`;
    filters.push(prev.x
      ? `[${acc}][v${k}]xfade=transition=${TRANSITIONS[prev.transition!]}:duration=${f3(prev.x / F)}:offset=${f3(start(k))},settb=1/${F}[${out}]`
      : `[${acc}][v${k}]concat=n=2:v=1:a=0,settb=1/${F}[${out}]`);
    acc = out;
  }
  const fadeIn = Math.max(0, num(tl.fadeIn, 0));
  const fadeOut = Math.max(0, num(tl.fadeOut, 0));
  const vpost: string[] = [];
  if (fadeIn) vpost.push(`fade=t=in:st=0:d=${f3(fadeIn)}`);
  if (fadeOut) vpost.push(`fade=t=out:st=${f3(Math.max(0, total - fadeOut))}:d=${f3(fadeOut)}`);


  // Sound: a silent bed the length of the cut, each kept clip sound at its place (faded across transitions), then the tracks.
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const mix: string[] = [];
  const dialogue: string[] = [];
  const spans: [number, number][] = [];
  filters.push(`anullsrc=r=48000:cl=stereo,atrim=end=${f3(total)}[abed]`);
  segs.forEach((s, k) => {
    if (!(s.spec.sound ?? tl.sound ?? true)) return;
    if (!s.p.audio) return;
    const d = s.n / F;
    const xin = k ? segs[k - 1].x / F : 0;
    const xout = s.x / F;
    const chain = [`atrim=start=0:end=${f3(d * s.speed)}`, 'asetpts=PTS-STARTPTS', ...tempoOf(s.speed), fmt, `apad=whole_dur=${f3(d)}`, `atrim=end=${f3(d)}`];
    if (xin) chain.push(`afade=t=in:d=${f3(xin)}`);
    if (xout) chain.push(`afade=t=out:st=${f3(d - xout)}:d=${f3(xout)}`);
    if (s.spec.volume !== undefined) chain.push(`volume=${f3(num(s.spec.volume, 1))}`);
    chain.push(`adelay=delays=${Math.round(start(k) * 1000)}:all=1`);
    filters.push(`[${clipInput[k]}:a]${chain.join(',')}[ca${k}]`);
    if (s.spec.dialogue) {
      dialogue.push(`ca${k}`);
      spans.push([start(k), start(k) + d]);
    } else mix.push(`ca${k}`);
  });

  type Placed = { label: string; spec: TrackSpec; j: number };
  const placed: Placed[] = [];
  const trackSpans: [number, number][] = [];
  (tl.audio ?? []).forEach((t, j) => {
    const src = t.audio ?? j;
    const p = audio[src];
    if (!p) throw new Error(`timeline.audio[${j}]: no audio ${src} (${audio.length} given)`);
    if (!p.audio) throw new Error(`timeline.audio[${j}]: audio ${src} has no sound`);
    if (t.clip !== undefined && !segs[t.clip]) throw new Error(`timeline.audio[${j}]: no timeline clip ${t.clip}`);
    const at = (t.clip !== undefined ? start(t.clip) : 0) + Math.max(0, num(t.start, 0));
    const tin = Math.max(0, num(t.in, 0));
    const len = Math.min(num(t.seconds, Infinity), t.loop ? Infinity : p.duration - tin, total - at);
    if (!(len > 0.05)) {
      notes.push(`audio ${j} starts after the cut ends (or is empty); left out`);
      return;
    }
    trackSpans[j] = [at, at + len];
    const n = inputs.push({ kind: 'audio', index: src, loop: !!t.loop }) - 1;
    const chain = [`atrim=start=${f3(tin)}:end=${f3(tin + len)}`, 'asetpts=PTS-STARTPTS', fmt];
    const fi = Math.min(num(t.fadeIn, 0), len / 2);
    const fo = Math.min(num(t.fadeOut, 0), len / 2);
    if (fi > 0) chain.push(`afade=t=in:d=${f3(fi)}`);
    if (fo > 0) chain.push(`afade=t=out:st=${f3(len - fo)}:d=${f3(fo)}`);
    if (t.volume !== undefined) chain.push(`volume=${f3(num(t.volume, 1))}`);
    chain.push(`adelay=delays=${Math.round(at * 1000)}:all=1`);
    filters.push(`[${n}:a]${chain.join(',')}[ta${j}]`);
    if (t.dialogue) {
      dialogue.push(`ta${j}`);
      spans.push([at, at + len]);
    } else placed.push({ label: `ta${j}`, spec: t, j });
  });

  // Ducking. The envelope dips around each dialogue span with short ramps; the sidechain compresses under the dialogue itself.
  const ducked = placed.filter((x) => x.spec.duck);
  const sidechained = ducked.filter((x) => x.spec.duck === 'sidechain');
  if (ducked.length && !dialogue.length) notes.push('a track ducks, but nothing is dialogue (mark voice tracks or clips "dialogue": true); not ducked');
  const dialogueOut: string[] = [];
  const keys: string[] = [];
  if (dialogue.length && sidechained.length) {
    // Each dialogue stream goes to the mix and into the key.
    const keyIn: string[] = [];
    for (const d of dialogue) {
      filters.push(`[${d}]asplit=2[${d}m][${d}k]`);
      dialogueOut.push(`${d}m`);
      keyIn.push(`[${d}k]`);
    }
    const key = keyIn.length > 1 ? `${keyIn.join('')}amix=inputs=${keyIn.length}:duration=longest:normalize=0` : `${keyIn[0]}anull`;
    for (let i = 0; i < sidechained.length; i++) keys.push(`key${i}`);
    filters.push(`${key},apad,asplit=${keys.length}${keys.map((k) => `[${k}]`).join('')}`);
  } else dialogueOut.push(...dialogue);
  for (const x of placed) {
    if (!x.spec.duck || !dialogue.length) {
      mix.push(x.label);
      continue;
    }
    const level = Math.min(1, Math.max(0, num(x.spec.duckTo, 0.3)));
    if (x.spec.duck === 'sidechain') {
      const ratio = f3(Math.min(20, Math.max(2, 1 / Math.max(level, 0.05))));
      filters.push(`[${x.label}][${keys.shift()}]sidechaincompress=threshold=0.02:ratio=${ratio}:attack=20:release=350[d${x.label}]`);
    } else {
      const r = 0.25;
      const expr = spans.map(([s, e]) => `(1-${f3(1 - level)}*clip(min((t-${f3(s - r)})/${r},(${f3(e + r)}-t)/${r}),0,1))`).join('*');
      filters.push(`[${x.label}]volume='${expr}':eval=frame[d${x.label}]`);
    }
    mix.push(`d${x.label}`);
  }
  mix.push(...dialogueOut);

  const apost = [`atrim=end=${f3(total)}`];
  if (fadeIn) apost.push(`afade=t=in:d=${f3(fadeIn)}`);
  if (fadeOut) apost.push(`afade=t=out:st=${f3(Math.max(0, total - fadeOut))}:d=${f3(fadeOut)}`);
  apost.push('alimiter=limit=0.95:level=0');
  filters.push(mix.length
    ? `[abed]${mix.map((m) => `[${m}]`).join('')}amix=inputs=${mix.length + 1}:duration=first:dropout_transition=0:normalize=0,${apost.join(',')}[aout]`
    : `[abed]${apost.join(',')}[aout]`);

  // Captions, on the timeline (once the tracks are placed, for captions that follow one).
  const captions: Caption[] = (tl.captions ?? []).map((c, i) => {
    if (!c || typeof c.text !== 'string' || !c.text.trim()) throw new Error(`timeline.captions[${i}]: no text`);
    if (c.track !== undefined) {
      // A caption on a voice line shows while it plays.
      const span = trackSpans[c.track];
      if (!tl.audio?.[c.track]) throw new Error(`timeline.captions[${i}]: no track ${c.track} in timeline.audio`);
      if (!span) return { start: 0, end: 0, text: c.text.trim() }; // its track was left out: so is the caption
      return { start: span[0], end: Math.min(total, span[1]), text: c.text.trim() };
    }
    if (c.clip !== undefined && !segs[c.clip]) throw new Error(`timeline.captions[${i}]: no timeline clip ${c.clip}`);
    const base = c.clip !== undefined ? start(c.clip) : 0;
    const s = base + num(c.start, 0);
    const e = c.end !== undefined ? base + num(c.end, 0) : s + num(c.seconds, 2.5);
    return { start: Math.max(0, s), end: Math.min(total, e), text: c.text.trim() };
  }).filter((c, i) => {
    if (c.end - c.start >= 0.05) return true;
    notes.push(`caption ${i} is outside the cut; left out`);
    return false;
  }).sort((a, b) => a.start - b.start);
  if (o.burn && captions.length) {
    // libass sizes are on a 288-line canvas, so this scales with the frame.
    vpost.push(`subtitles=${o.captionsFile ?? 'captions.srt'}:force_style='FontName=Arial,FontSize=16,Outline=1.5,Shadow=0,MarginV=18,BorderStyle=1'`);
  }
  filters.push(`[${acc}]${[...vpost, 'format=yuv420p'].join(',')}[vout]`);

  return {
    inputs, filter: filters.join(';\n'), duration: total, frames, captions, notes,
    clips: segs.map((s, k) => ({ clip: s.src, start: start(k), end: start(k) + s.n / F, in: s.tin, out: s.tin + s.n / F, transition: s.transition, seconds: s.x / F })),
  };
}

const stamp = (t: number, sep: string) => {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`;
};

export const toVtt = (cs: Caption[]) => `WEBVTT\n\n${cs.map((c, i) => `${i + 1}\n${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n')}`;
export const toSrt = (cs: Caption[]) => cs.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n');

/** What a file is, for planning: length, streams, size and rate. */
export async function probeMedia(file: string, signal?: AbortSignal): Promise<Probe> {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate,duration', '-of', 'json', file], { signal }));
  const streams: any[] = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const [fn, fd] = String(v?.r_frame_rate ?? '0/1').split('/').map(Number);
  const duration = Number(j.format?.duration ?? v?.duration ?? a?.duration);
  if (!(duration > 0)) throw new Error(`${path.basename(file)}: ffprobe found no duration`);
  return { duration, video: !!v, audio: !!a, width: v?.width, height: v?.height, fps: fd ? fn / fd : undefined };
}

export const composeTool: Tool = {
  id: 'video.compose',
  version: 2,
  title: 'Compose a cut',
  description: 'Puts shots together into a finished video with ffmpeg on this machine (free): edit order, trims, cuts or crossfades, each clip\'s own sound, music and voice tracks (ducked under dialogue), captions (a .vtt, or burned in), fades. Mixed sizes and frame rates are normalized. Returns a web H.264 mp4, the .vtt and a poster PNG. The timeline format is in docs/blender.md.',
  provider: 'local',
  output: 'video',
  inputs: {
    clips: { kind: 'video', required: true, multiple: true, max: 200, description: 'The shots. timeline.clips picks them by index (default: all, in order).' },
    audio: { kind: 'audio', multiple: true, max: 100, description: 'Music, voice lines, sound beds. timeline.audio places them by index.' },
  },
  params: {
    timeline: {
      type: 'json',
      description: 'clips: [{ clip, in, out, transition (cut | crossfade | dissolve | fadeblack | wipeleft...: into the next), seconds, sound, volume, dialogue, speed (0.25-4), zoom ({ from, to: 1-4, x, y: 0-1 where it sits }: a punch-in or push-in) }]; audio: [{ audio, start, clip, in, seconds, volume, fadeIn, fadeOut, loop, duck (true | sidechain), duckTo, dialogue }]; captions: [{ text, start, end, clip } or { text, track }]; sound; fadeIn; fadeOut.',
      example: { clips: [{ clip: 0, transition: 'crossfade', seconds: 0.5 }, { clip: 1, out: 4 }], audio: [{ audio: 0, volume: 0.3, loop: true, fadeOut: 2, duck: true }, { audio: 1, clip: 1, start: 0.5, dialogue: true }], captions: [{ clip: 1, start: 0.5, end: 3, text: 'Who is there?' }], fadeIn: 0.5, fadeOut: 1 },
    },
    width: { type: 'integer', min: 64, max: 3840, default: 1280 },
    height: { type: 'integer', min: 64, max: 3840, default: 704 },
    fps: { type: 'number', min: 8, max: 60, default: 24 },
    fit: { type: 'enum', values: ['pad', 'crop'], default: 'pad', description: 'Clips of another shape: letterbox (pad) or fill the frame (crop).' },
    color: { type: 'string', default: '000000', description: 'Padding color (hex).', advanced: true },
    captions: { type: 'enum', values: ['vtt', 'burn', 'both'], default: 'vtt', description: 'Captions as a .vtt output, burned into the picture, or both.' },
    codec: { type: 'enum', values: ['h264', 'h265'], default: 'h264', description: 'h264 plays everywhere on the web.', advanced: true },
    crf: { type: 'integer', min: 12, max: 35, default: 20, description: 'Quality (lower is better and bigger).', advanced: true },
    poster: { type: 'boolean', default: true, description: 'Also a PNG still for the player.' },
    posterAt: { type: 'number', min: 0, description: 'Seconds into the cut for the poster (default: the middle of the first clip).', advanced: true },
  },
  async run(ctx) {
    const p = ctx.params;
    const tl: Timeline = typeof p.timeline === 'string' ? JSON.parse(p.timeline) : (p.timeline ?? {});
    const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []) as string[];
    const clipFiles = list(ctx.inputs.clips);
    const audioFiles = list(ctx.inputs.audio);
    ctx.step(`probing ${clipFiles.length + audioFiles.length} file(s)`);
    const clips = await Promise.all(clipFiles.map((f) => probeMedia(f, ctx.signal)));
    const audio = await Promise.all(audioFiles.map((f) => probeMedia(f, ctx.signal)));
    const burn = p.captions === 'burn' || p.captions === 'both';
    const fps = Number(p.fps);
    const width = Math.round(Number(p.width) / 2) * 2;
    const height = Math.round(Number(p.height) / 2) * 2;
    const plan = planCompose(tl, clips, audio, { width, height, fps, fit: p.fit, color: String(p.color).replace(/^#/, ''), burn });
    for (const n of plan.notes) ctx.log(n);

    const out = ctx.tmp('cut.mp4');
    const dir = path.dirname(out);
    if (burn && plan.captions.length) fs.writeFileSync(path.join(dir, 'captions.srt'), toSrt(plan.captions));
    const graph = path.join(dir, 'compose.filter');
    fs.writeFileSync(graph, plan.filter);
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const i of plan.inputs) {
      if (i.loop) args.push('-stream_loop', '-1');
      if (i.seek) args.push('-ss', f3(i.seek));
      args.push('-i', i.kind === 'clip' ? clipFiles[i.index] : audioFiles[i.index]);
    }
    const video = p.codec === 'h265' ? ['-c:v', 'libx265', '-tag:v', 'hvc1'] : ['-c:v', 'libx264', '-profile:v', 'high'];
    args.push(...filterScriptArgs('compose.filter'), '-map', '[vout]', '-map', '[aout]',
      ...video, '-preset', 'medium', '-crf', String(p.crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', f3(plan.duration), 'cut.mp4');
    ctx.step(`composing ${plan.clips.length} clip(s), ${f3(plan.duration)} s`);
    ctx.log(`ffmpeg ${args.join(' ')}\n${plan.filter}`);
    await run('ffmpeg', args, { cwd: dir, signal: ctx.signal });

    const made = await probeMedia(out, ctx.signal);
    const result = {
      duration: Math.round(made.duration * 1000) / 1000, width: made.width, height: made.height, fps: made.fps,
      bytes: fs.statSync(out).size, codec: p.codec, clips: plan.clips, captions: plan.captions.length, notes: plan.notes,
    };
    const emits: { make: () => Promise<Buffer> | Buffer; ext: string; title: string; meta?: Record<string, unknown> }[] = [
      { make: () => fs.readFileSync(out), ext: '.mp4', title: 'cut', meta: { duration: result.duration, width: result.width, height: result.height, fps: result.fps } },
    ];
    if (plan.captions.length && p.captions !== 'burn') emits.push({ make: () => Buffer.from(toVtt(plan.captions)), ext: '.vtt', title: 'captions' });
    if (p.poster) {
      const at = Math.min(Math.max(0, num(p.posterAt, (plan.clips[0].end - plan.clips[0].start) / 2)), Math.max(0, made.duration - 0.05));
      emits.push({
        make: async () => {
          const png = path.join(dir, 'poster.png');
          await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', f3(at), '-i', out, '-frames:v', '1', png], { signal: ctx.signal });
          return fs.readFileSync(png);
        },
        ext: '.png', title: 'poster', meta: { at },
      });
    }
    for (let i = ctx.done; i < emits.length; i++) {
      const e = emits[i];
      await ctx.emit({ data: await e.make(), ext: e.ext, title: e.title, meta: e.meta });
    }
    ctx.result(result);
  },
};
