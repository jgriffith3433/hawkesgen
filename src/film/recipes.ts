// The film pipeline's recipes (docs/film-pipeline.md): asset.make params built from a shot and a few choices. Each builder
// returns what asset.make takes (`steps`, `candidates`, `pickAt`, `pick`, `refs`), so the result drops into a call to
// asset.make, a preset, or a project's hawkes.assets.json as it is.
//
//   cinemaPass        gate -> Blender render -> look (best of 3) -> relight -> restore -> video.control -> upscale -> interpolate
//   dialogueCloseup   Blender close-up frame -> portrait -> voice line -> video.talk (lips follow the voice)
//   vfxLayers         two characters on separate mattes: the effect on one, composited with glow, never on the other's face
//   characterLora     turntable stills -> lora.train (autoCaption) -> on-model reference stills
//   trailerCut        the finished shots into a video.compose timeline at trailer pace (2-4 s), voice ducking the music
//
// All pure: no I/O, so the tests check the plans, and film.plan prices them with Hawkes Gen's own estimate.

import { GenError } from '../util.ts';
import { shotFrames } from '../tools/blender.ts';
import type { Shot } from './shot.ts';

export type Step = { tool: string; params?: Record<string, unknown>; inputs?: Record<string, unknown>; save?: string };
export type Recipe = {
  steps: Step[];
  candidates: number;
  pickAt: number;
  pick: string;
  refs?: number[];
  canon?: string;
  /** What the caller passes as asset.make's `files`, in order. */
  files: string[];
  notes: string[];
};

const $input = (i: number) => `$input:${i}`;
/** video.talk makes two passes of `frames` each (a clip of 2 x frames / fps whatever the audio length), and a pass is 4n + 1 frames. */
export const talkFrames = (seconds: number, fps: number) => Math.max(33, Math.ceil((seconds * fps / 2 - 1) / 4) * 4 + 1);

/** Every file index a shot points at (characters, animations, props, sky, texture maps), so the render gets exactly those. */
export function shotFileRefs(shot: Shot): number[] {
  const refs = new Set<number>();
  const add = (v: unknown) => { if (typeof v === 'number' && Number.isInteger(v) && v >= 0) refs.add(v); };
  for (const c of shot.characters ?? []) {
    add(c.file);
    add(c.animationFile);
    for (const b of c.beats ?? []) add(b.animationFile);
    for (const a of c.attachments ?? []) add(a.file);
  }
  for (const p of shot.props ?? []) add((p as any).file);
  add((shot.background as any)?.file);
  const mat = (m: any) => { if (m && typeof m === 'object') for (const k of ['albedo', 'color', 'normal', 'roughness', 'metallic', 'ao', 'height']) add(m[k]); };
  mat((shot.ground as any)?.material);
  for (const w of Array.isArray(shot.walls) ? shot.walls : []) mat((w as any).material);
  return [...refs].sort((a, b) => a - b);
}

/** The `files` list for a render step: files 0..max of the shot (the indexes the shot uses stay as they are). */
export function renderFiles(shot: Shot): string[] {
  const refs = shotFileRefs(shot);
  if (!refs.length) throw new GenError('The shot uses no files: characters need a file (characters[].file)');
  return Array.from({ length: Math.max(...refs) + 1 }, (_, i) => $input(i));
}

const GUARD = 'Keep the composition, camera, framing and every pose exactly as in image 1.';
const REF_LINE = (n: number) => (n === 1 ? ' Image 2 is the character reference sheet: match its faces, outfits and colors.' : n >= 2 ? ' Images 2 and 3 are character reference sheets: match their faces, outfits and colors.' : '');

export type CinemaOptions = {
  shot: Shot;
  /** The look: what the finished frame is (the repaint prompt). */
  look: string;
  /** What happens and what it sounds like (the video prompt). */
  motion: string;
  seconds?: number;
  fps?: number;
  width?: number;
  height?: number;
  /** Indexes into asset.make `files` of character reference sheets (at most two). */
  refs?: number[];
  /** Relight the keyframe to match the scene: a lighting prompt, or false to skip. */
  relight?: string | false;
  /** Director gate before any ComfyUI spend (default true). */
  gate?: boolean;
  intent?: Record<string, unknown>;
  maxTries?: number;
  /** Which control(s) lock the video: depth, depth+pose or depth+pose+edges (default). */
  controls?: 'depth' | 'depth+pose' | 'depth+pose+edges';
  engine?: 'ltx' | 'wan';
  /** SeedVR2 on the keyframe (default true). */
  restore?: boolean;
  /** 4x ESRGAN on the finished video (default true). */
  upscale?: boolean;
  /** Frame interpolation multiplier on the finished video (default: 2 for Wan, off for LTX). */
  interpolate?: number | false;
  candidates?: number;
  canon?: string;
  /** Add the layer mattes to the render (for vfxLayers to reuse). */
  layers?: boolean;
};

/** Blender as the motion-control rig, ComfyUI as the cinematographer: the whole shot, gated first. */
export function cinemaPass(o: CinemaOptions): Recipe {
  const seconds = o.seconds ?? 5;
  const wan = o.engine === 'wan';
  const fps = o.fps ?? (wan ? 16 : 24);
  const width = o.width ?? (wan ? 832 : 1280);
  const height = o.height ?? (wan ? 480 : 704);
  const refs = o.refs ?? [];
  if (refs.length > 2) throw new GenError('refs: at most two reference sheets (image.edit takes three images, the first is the render)');
  const files = renderFiles(o.shot);
  for (const r of refs) if (r < files.length) throw new GenError(`refs: input ${r} is a render file (0 to ${files.length - 1}); put reference sheets after them`);
  const controls = o.controls ?? 'depth+pose+edges';
  const notes: string[] = [];
  const steps: Step[] = [];
  const frames = shotFrames({ seconds, fps });

  const gate = o.gate !== false;
  if (gate) {
    steps.push({ tool: 'film.gate', params: { shot: o.shot, seconds, fps, width, height, intent: o.intent, maxTries: o.maxTries ?? 2 }, inputs: { files }, save: 'gate' });
  }
  const passes = ['beauty', 'depth', 'pose', 'edges', ...(o.layers ? ['layers'] : [])];
  steps.push({
    tool: 'blender.render',
    params: { shot: gate ? '$step1.result.shot' : o.shot, seconds, fps, width, height, passes },
    inputs: { files }, save: 'render',
  });
  const render = steps.length;
  if (controls !== 'depth') {
    const picked = controls === 'depth+pose' ? ['depth', 'pose'] : ['depth', 'pose', 'edges'];
    steps.push({ tool: 'video.control-mix', params: { weights: [1, 0.8, 0.5].slice(0, picked.length) }, inputs: { videos: picked.map((p) => `$step${render}:${p}`) }, save: 'control' });
  }
  const control = controls === 'depth' ? `$step${render}:depth` : `$step${steps.length}:control`;
  steps.push({
    tool: 'image.edit',
    params: { prompt: `${o.look} ${GUARD}${REF_LINE(refs.length)}`, width, height },
    inputs: { images: [`$step${render}:first frame`, ...refs.map($input)] },
  });
  const pickAt = steps.length;
  if (o.relight) steps.push({ tool: 'image.relight', params: { prompt: o.relight }, inputs: { image: '$prev' } });
  if (o.restore !== false) steps.push({ tool: 'image.restore', inputs: { image: '$prev' }, save: 'keyframe' });
  else steps[steps.length - 1].save = 'keyframe';
  const keyframe = steps.length;
  if (wan) {
    steps.push({ tool: 'video.control-wan', params: { prompt: o.motion, width, height, frames, fps }, inputs: { control, image: `$step${keyframe}` } });
    notes.push('Wan 2.2 Fun Control: 16 fps, no sound, 20 steps (about 7 minutes a shot). LTX-2.3 is the default.');
  } else {
    steps.push({ tool: 'video.control', params: { prompt: o.motion, width, height, fps, seconds }, inputs: { control, image: `$step${keyframe}` } });
  }
  if (o.upscale !== false) steps.push({ tool: 'video.upscale', inputs: { video: '$prev' } });
  const mult = o.interpolate === undefined ? (wan ? 2 : false) : o.interpolate;
  if (mult) steps.push({ tool: 'video.interpolate', params: { multiplier: mult }, inputs: { video: '$prev' } });
  steps[steps.length - 1].save = 'shot';
  if (controls === 'depth+pose+edges') notes.push('The control is a mix of depth, pose and edges (video.control-mix). If a repaint drifts, run the shot again with controls: "depth".');
  if (o.restore !== false) notes.push('SeedVR2 scales 4x: a 1280x704 keyframe becomes 5120x2816. Set restore: false if the server runs out of memory.');
  return {
    steps, candidates: o.candidates ?? 3, pickAt,
    pick: 'On-model with the reference sheets (faces, outfits, colors), keeps the render\'s composition, camera and poses exactly, one clean frame: no extra people, hands and faces intact, the described look and light.',
    refs: refs.length ? refs : undefined, canon: o.canon,
    files: [...files.map((_, i) => `file ${i}: the shot's own files (characters, props, sky, texture maps) as shot.* indexes them`), ...refs.map((r) => `file ${r}: a character reference sheet`)],
    notes,
  };
}

export type DialogueOptions = {
  shot: Shot;
  /** The speaker (a character index of the shot). */
  speaker: number;
  line: string;
  /** ElevenLabs voice id. */
  voice: string;
  /** How the portrait is lit and styled (matches the wide shots). */
  look: string;
  /** What the face does while speaking (video prompt). */
  motion?: string;
  /** The line's length in seconds (default: from the words). Pass the real length if you know it. */
  seconds?: number;
  fps?: number;
  width?: number;
  height?: number;
  refs?: number[];
  framing?: 'close' | 'medium';
  voiceModel?: string;
  candidates?: number;
};

/** About how long a line takes to say, from its words (about 2.5 per second, plus a breath). */
export function lineSeconds(text: string) {
  const words = text.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  return Math.round(Math.min(12, Math.max(1.5, words / 2.5 + 0.5)) * 10) / 10;
}

/** The close-up for a dialogue line: a Blender frame of the speaker, a portrait in the scene's light, then InfiniteTalk driven by the voice. */
export function dialogueCloseup(o: DialogueOptions): Recipe {
  const chars = o.shot.characters ?? [];
  if (!Number.isInteger(o.speaker) || o.speaker < 0 || o.speaker >= chars.length) throw new GenError(`speaker ${o.speaker} is not a character of the shot`);
  if (!o.line?.trim()) throw new GenError('Give the line the speaker says');
  const fps = o.fps ?? 25;
  const width = o.width ?? 832;
  const height = o.height ?? 480;
  const seconds = o.seconds ?? lineSeconds(o.line);
  const refs = o.refs ?? [];
  const sp = chars[o.speaker];
  const h = typeof sp.height === 'number' ? sp.height : 1.75;
  const medium = o.framing === 'medium';
  // A close-up: camera at eye level in front of the speaker, a long lens, shallow focus. Beats are dropped (it is one frame).
  const closeShot: Shot = {
    ...o.shot,
    characters: chars.map(({ beats, ...c }) => c),
    camera: { move: 'static', target: o.speaker, angle: 0, distance: (medium ? 2.0 : 1.15) * (h / 1.75), height: h * (medium ? 0.82 : 0.9), aimHeight: medium ? 0.8 : 0.92, lens: medium ? 60 : 85, dof: { fstop: 2.0 } },
    speaker: o.speaker,
  };
  const files = renderFiles(closeShot);
  for (const r of refs) if (r < files.length) throw new GenError(`refs: input ${r} is a render file (0 to ${files.length - 1}); put reference sheets after them`);
  const steps: Step[] = [
    { tool: 'blender.render', params: { shot: closeShot, width, height, passes: [], stills: [0], engine: 'eevee', fps }, inputs: { files }, save: 'frame' },
    {
      tool: 'image.edit',
      params: { prompt: `${o.look} A portrait of the speaker, facing the camera, eyes open and sharp, mouth relaxed and just parted as if about to speak. Match the scene's lighting. Keep the identity, framing and head pose of image 1.${REF_LINE(refs.length)}`, width, height },
      inputs: { images: ['$step1:still 1', ...refs.map($input)] },
    },
    { tool: 'audio.voice', params: { text: o.line, voice: o.voice, ...(o.voiceModel ? { model: o.voiceModel } : {}) }, save: 'voice' },
    {
      tool: 'video.talk',
      params: { prompt: o.motion ?? 'speaking naturally to the camera: lips, jaw and a little head and body motion follow the voice', width, height, frames: talkFrames(seconds, fps), fps },
      inputs: { image: '$step2', audio: '$step3' }, save: 'closeup',
    },
  ];
  return {
    steps, candidates: o.candidates ?? 2, pickAt: 2,
    pick: 'The speaker\'s face on-model with the references, sharp eyes, a relaxed mouth that can start talking (not mid-word, not smiling wide), lighting consistent with the scene, nothing covering the face.',
    refs: refs.length ? refs : undefined,
    files: [...files.map((_, i) => `file ${i}: the shot's own files`), ...refs.map((r) => `file ${r}: a character reference sheet`)],
    notes: [`video.talk makes two passes of ${talkFrames(seconds, fps)} frames (${(2 * talkFrames(seconds, fps) / fps).toFixed(1)} s at ${fps} fps) for a ${seconds} s line${o.seconds ? '' : ' (guessed from the words: pass seconds with the real length of the voice line)'}; the face is still after the voice ends, so trim the clip in the cut. One speaker per clip.`],
  };
}

export type VfxOptions = {
  /** The shot the gate approved (the same one the base shot was made from). */
  shot: Shot;
  /** The finished base shot: `$input:N` or `asset:ID`. */
  base: string;
  /** The character that gets the effect (index), and the one it must never touch (default: the other). */
  fx: number;
  protect?: number;
  /** The look of the effect frame: what the effect character looks like with the effect on. */
  look: string;
  motion: string;
  seconds?: number;
  fps?: number;
  width?: number;
  height?: number;
  refs?: number[];
  glow?: number;
  bloom?: number;
  grow?: number;
  feather?: number;
  controls?: 'depth' | 'depth+pose' | 'depth+pose+edges';
  candidates?: number;
};

/** An effect on one character only: that character's matte keeps the video model off the other one, and the composite never covers its face. */
export function vfxLayers(o: VfxOptions): Recipe {
  const chars = o.shot.characters ?? [];
  if (chars.length < 2) throw new GenError('Layered VFX needs a shot with two characters');
  const protect = o.protect ?? (o.fx === 0 ? 1 : 0);
  for (const [k, v] of [['fx', o.fx], ['protect', protect]] as const) if (!Number.isInteger(v) || v < 0 || v >= chars.length) throw new GenError(`${k} ${v} is not a character of the shot`);
  if (o.fx === protect) throw new GenError('fx and protect must be different characters');
  const seconds = o.seconds ?? 5;
  const fps = o.fps ?? 24;
  const width = o.width ?? 1280;
  const height = o.height ?? 704;
  const refs = o.refs ?? [];
  const files = renderFiles(o.shot);
  const controls = o.controls ?? 'depth+pose';
  const picked = controls === 'depth' ? ['depth'] : controls === 'depth+pose' ? ['depth', 'pose'] : ['depth', 'pose', 'edges'];
  const steps: Step[] = [
    { tool: 'blender.render', params: { shot: o.shot, seconds, fps, width, height, passes: ['beauty', 'depth', 'pose', 'edges', 'layers'] }, inputs: { files }, save: 'render' },
  ];
  if (picked.length > 1) steps.push({ tool: 'video.control-mix', params: { weights: [1, 0.8, 0.5].slice(0, picked.length) }, inputs: { videos: picked.map((p) => '$step1:' + p) } });
  const control = picked.length > 1 ? '$prev' : '$step1:depth';
  steps.push({ tool: 'video.matte', params: { grow: o.grow ?? 10, feather: o.feather ?? 5 }, inputs: { video: control, matte: `$step1:layer ${o.fx}` }, save: 'control' });
  const matte = steps.length;
  steps.push({
    tool: 'image.edit',
    params: { prompt: `${o.look} The effect appears on character ${o.fx} only; the other character stays exactly as in image 1, face untouched. ${GUARD}${REF_LINE(refs.length)}`, width, height },
    inputs: { images: ['$step1:first frame', ...refs.map($input)] },
  });
  const pickAt = steps.length;
  steps.push({ tool: 'video.control', params: { prompt: o.motion, width, height, fps, seconds }, inputs: { control: `$step${matte}`, image: '$prev' }, save: 'fx' });
  steps.push({
    tool: 'video.composite',
    params: { glow: o.glow ?? 0.6, bloom: o.bloom ?? 24, grow: o.grow ?? 10, feather: o.feather ?? 6 },
    inputs: { base: o.base, fx: '$prev', matte: `$step1:layer ${o.fx}`, protect: `$step1:layer ${protect}` }, save: 'shot',
  });
  return {
    steps, candidates: o.candidates ?? 3, pickAt,
    pick: `The effect is only on character ${o.fx}; the other character's face is clean and unchanged; the effect reads clearly and matches the render's composition.`,
    refs: refs.length ? refs : undefined,
    files: [...files.map((_, i) => `file ${i}: the shot's own files`), ...refs.map((r) => `file ${r}: a character reference sheet`)],
    notes: ['The base shot is made first (cinemaPass); the effect layer reuses its render when the shot and sizes are the same. The effect layer runs on character ' + o.fx + '\'s depth and pose only, so the video model never paints on the other character.'],
  };
}

export type LoraOptions = {
  /** Index into asset.make `files` of the character GLB/FBX (the model, rigged or not). */
  character?: number;
  name: string;
  /** What the character is (after the trigger word in every caption). */
  caption: string;
  height?: number;
  /** A clip to hold (an idle pose); the rest pose when absent. */
  animation?: string;
  /** Stills per ring: a full-body ring and a bust ring (default 8 each: 16 images). */
  stills?: number;
  steps?: number;
  /** Also draw four on-model reference stills with the trained LoRA (default true). */
  reference?: boolean;
};

/** A character that stays on-model: turntable stills out of Blender train a LoRA, which draws the reference stills image.edit and video.control are given. */
export function characterLora(o: LoraOptions): Recipe {
  const file = o.character ?? 0;
  const per = Math.max(4, Math.min(15, o.stills ?? 8));
  const h = o.height ?? 1.8;
  const shares = Array.from({ length: per }, (_, k) => k / per);
  const ring = (distance: number, height: number, aimHeight: number, lens: number) => ({
    characters: [{ file: 0, height: h, position: [0, 0], facing: 0, ...(o.animation ? { animation: o.animation } : {}) }],
    ground: false, lights: 'studio', background: { color: '#9a9a9a' },
    camera: { move: 'turntable', target: 0, distance, height: h * aimHeight, aimHeight, lens },
  });
  const common = { width: 1024, height: 1024, passes: [], stills: shares, engine: 'cycles', samples: 24, seconds: 1 };
  const inputs = { files: [$input(file)] };
  const steps: Step[] = [
    { tool: 'blender.render', params: { ...common, shot: ring(3.4 * (h / 1.8), 0.55, 0.55, 45) }, inputs, save: 'turntable' },
    { tool: 'blender.render', params: { ...common, shot: ring(1.5 * (h / 1.8), 0.9, 0.92, 85) }, inputs, save: 'bust' },
    {
      tool: 'lora.train',
      params: { name: o.name, caption: o.caption, autoCaption: true, ...(o.steps ? { steps: o.steps } : {}) },
      inputs: { images: [...shares.map((_, k) => `$step1:still ${k + 1}`), ...shares.map((_, k) => `$step2:still ${k + 1}`)] }, save: 'lora',
    },
  ];
  if (o.reference !== false) {
    steps.push({
      tool: 'image.character',
      params: { lora: '$prev', prompt: `${o.caption}, standing, full body, neutral pose, facing the camera, plain light grey background`, count: 4, width: 1024, height: 1024 },
      save: 'reference',
    });
  }
  return {
    steps, candidates: 1, pickAt: 1, pick: 'the best result',
    files: [`file ${file}: the character model (GLB, FBX or .blend)`],
    notes: [
      `${per * 2} stills: ${per} full-body and ${per} bust, 360° around the character (a clean grey background; lora.train frames them).`,
      'lora.train trains on Z-Image Turbo, so image.character draws the character on-model. The reference stills it makes go to image.edit as reference images (cinemaPass refs); image.edit (Qwen) and video.control (LTX) do not load that LoRA themselves.',
    ],
  };
}

// ---------------------------------------------------------------- the trailer cut

export type TrailerShot = {
  id: string;
  kind: 'wide' | 'closeup' | 'vfx' | 'insert';
  /** The finished clip: `asset:ID` or a label the caller maps to a file. */
  clip: string;
  /** The clip's length in seconds. */
  seconds: number;
  /** Where to start in the clip (default 0). */
  in?: number;
  dialogue?: { audio: string; text: string; seconds: number };
  /** How this shot goes into the next (default cut). */
  transition?: string;
};

export type TrailerCut = {
  /** video.compose params. */
  params: { timeline: Record<string, unknown>; width: number; height: number; fps: number; captions: 'both' };
  /** video.compose inputs, in the order the timeline indexes them. */
  inputs: { clips: string[]; audio: string[] };
  duration: number;
  notes: string[];
};

/**
 * The cut: wides and close-ups at trailer pace (every shot 2 to 4 s; a dialogue shot runs as long as its line, up to
 * `maxDialogue`), each line's voice ducking the music, captions on the lines, fades at the ends.
 */
export function trailerCut(shots: TrailerShot[], o: { music?: string; pace?: { min?: number; max?: number }; maxDialogue?: number; width?: number; height?: number; fps?: number; fadeIn?: number; fadeOut?: number } = {}): TrailerCut {
  if (!shots.length) throw new GenError('Give at least one shot');
  const min = o.pace?.min ?? 2;
  const max = o.pace?.max ?? 4;
  const maxDlg = o.maxDialogue ?? Math.max(max, 5);
  const notes: string[] = [];
  const clips: string[] = [];
  const audio: string[] = [];
  const tlClips: Record<string, unknown>[] = [];
  const tlAudio: Record<string, unknown>[] = [];
  const captions: Record<string, unknown>[] = [];
  let t = 0;
  let run = 0;
  let lastKind = '';
  const ids = new Set<string>();
  for (const s of shots) {
    if (ids.has(s.id)) throw new GenError(`shot id ${s.id} is used twice`);
    ids.add(s.id);
    if (!(s.seconds > 0)) throw new GenError(`${s.id}: seconds is the clip's length`);
    const start = s.in ?? 0;
    const room = s.seconds - start;
    let len: number;
    if (s.dialogue) {
      const want = s.dialogue.seconds + 0.35;
      len = Math.min(want, maxDlg, room);
      if (want > maxDlg) notes.push(`${s.id}: the line runs ${s.dialogue.seconds.toFixed(1)} s, longer than ${maxDlg} s; split it into two close-ups for trailer pace`);
    } else {
      len = Math.min(max, room);
      if (len < min - 1e-6) notes.push(`${s.id}: the clip has only ${room.toFixed(1)} s from ${start} s, under the ${min} s pace; make it longer or accept a quick cut`);
    }
    const ci = clips.indexOf(s.clip) >= 0 ? clips.indexOf(s.clip) : clips.push(s.clip) - 1;
    const k = tlClips.length;
    // A close-up's sound is its own voice line, laid separately; a wide keeps the sound LTX made, a little under.
    const clip: Record<string, unknown> = { clip: ci, in: start, out: start + len, sound: s.kind !== 'closeup', ...(s.kind === 'closeup' ? {} : { volume: 0.7 }) };
    if (s.transition && s.transition !== 'cut') {
      clip.transition = s.transition;
      clip.seconds = 0.3;
    }
    tlClips.push(clip);
    if (s.dialogue) {
      const ai = audio.indexOf(s.dialogue.audio) >= 0 ? audio.indexOf(s.dialogue.audio) : audio.push(s.dialogue.audio) - 1;
      tlAudio.push({ audio: ai, clip: k, start: 0.15, dialogue: true });
      captions.push({ clip: k, start: 0.15, end: Math.min(len - 0.05, 0.15 + s.dialogue.seconds), text: s.dialogue.text });
    }
    run = s.kind === lastKind ? run + 1 : 1;
    if (run === 3) notes.push(`three ${s.kind} shots in a row ending at ${s.id}: cut to a different kind of shot`);
    lastKind = s.kind;
    t += len - (s.transition && s.transition !== 'cut' ? 0.3 : 0);
  }
  if (o.music) {
    const mi = audio.length;
    audio.push(o.music);
    tlAudio.unshift({ audio: mi, volume: 0.55, fadeIn: 1, fadeOut: 2.5, duck: true, duckTo: 0.35 });
  }
  const tl: Record<string, unknown> = { clips: tlClips, audio: tlAudio, captions, fadeIn: o.fadeIn ?? 0.3, fadeOut: o.fadeOut ?? 1 };
  return { params: { timeline: tl, width: o.width ?? 1280, height: o.height ?? 704, fps: o.fps ?? 24, captions: 'both' }, inputs: { clips, audio }, duration: Math.round(t * 100) / 100, notes };
}
