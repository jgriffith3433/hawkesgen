// Edits that chain other tools: video.change (change something in a clip) and audio.revoice (a new voice for a clip).
//
// A tool holds one kind of machine (a GPU family, or a CPU lane), and these need several: a Qwen-Image-Edit frame, then an
// LTX-2.3 video; a transcriber, then a speech model. So, like asset.make, they are `pipeline` tools: each GPU step is a
// child job queued through Gen's own API (labels.parent, a stable key so a resumed parent finds its children, reuse so
// the same recipe is never paid twice), and the cheap ffmpeg work (taking a frame, putting the sound back, fitting the
// voice's timing) runs here in the parent. The children are submitted with Gen's own key, so a customer is charged once,
// at the parent's quote (billing.ts floors), and the parent's inputs were already checked against the customer at submit.
// The plans (which steps, which params) are pure and tested offline (test/chain-tools.test.ts).

import fs from 'node:fs';
import type { RunContext, Tool } from './types.ts';
import { GenError, run } from '../util.ts';
import { getAsset } from '../library.ts';
import { probe, cfrRate, rotationOf, frameArgs, type ProbeInfo } from './media.ts';
import { analyze, ff } from '../audio/post.ts';
// @ts-ignore: plain JS client
import { HawkesGen } from '../../clients/js/hawkesgen.mjs';
import { SELF_TOKEN, SELF_URL } from '../auth.ts';

export type ChildSpec = { tool: string; params: Record<string, unknown>; inputs: Record<string, unknown> };

/** A size LTX-2.3 takes for a w x h clip: the same shape, the long side `long` (1280), sides multiples of 32. */
export function controlSize(w: number, h: number, long = 1280): { width: number; height: number } {
  if (!(w > 0 && h > 0)) throw new GenError('The video has no picture size');
  const s = long / Math.max(w, h);
  const r32 = (v: number) => Math.min(1920, Math.max(256, Math.round(v / 32) * 32));
  return { width: r32(w * s), height: r32(h * s) };
}

/** What video.change runs: the frame edit (masked or whole), then video.control over the original. "$frame" is the
 *  first frame taken here, "$edited" the edit step's first output. */
export function videoChangePlan(info: ProbeInfo, p: Record<string, any>, hasMask: boolean): { edit: ChildSpec; control: ChildSpec; seconds: number; hasSound: boolean } {
  const v = (info.streams ?? []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new GenError('That file has no video picture');
  const duration = Number(info.format?.duration) || Number(v.duration) || 0;
  if (!(duration > 0)) throw new GenError('Could not read the video\'s length');
  let [w, h] = [Number(v.width), Number(v.height)];
  if (rotationOf(v) === 90 || rotationOf(v) === 270) [w, h] = [h, w];
  const size = controlSize(w, h, Number(p.long) || 1280);
  const fps = Math.min(50, Math.max(8, Math.round(cfrRate(v))));
  const seconds = Math.round(Math.min(20, duration) * 100) / 100;
  const seed = p.seed !== undefined ? { seed: p.seed } : {};
  const edit: ChildSpec = hasMask
    ? { tool: 'image.repaint', params: { prompt: p.prompt, feather: p.feather ?? 12, ...seed }, inputs: { image: '$frame', mask: '$mask' } }
    : { tool: 'image.edit', params: { prompt: p.prompt, ...seed }, inputs: { images: ['$frame'] } };
  const motion = String(p.motion ?? '').trim() || `The same shot as the original clip: the same motion, camera move and timing, with this change carried through every frame: ${p.prompt}.`;
  const control: ChildSpec = {
    tool: 'video.control',
    params: { prompt: motion, width: size.width, height: size.height, fps, seconds, estimateDepth: true, ...(p.strength !== undefined ? { strength: p.strength } : {}), ...seed },
    inputs: { control: '$video', image: '$edited' },
  };
  return { edit, control, seconds, hasSound: (info.streams ?? []).some((s) => s.codec_type === 'audio') };
}

/** The tempo that fits a new line of `spoken` seconds into the original's `target` seconds, within [min, max] (outside it
 *  speech sounds wrong; the rest is made up with silence, or the line runs on). */
export function fitTempo(spoken: number, target: number, o: { min?: number; max?: number } = {}): { tempo: number; seconds: number; clamped: boolean } {
  const { min = 0.8, max = 1.25 } = o;
  if (!(spoken > 0) || !(target > 0)) return { tempo: 1, seconds: Math.max(0, spoken), clamped: false };
  const want = spoken / target;
  const tempo = Math.min(max, Math.max(min, want));
  return { tempo: Math.round(tempo * 1000) / 1000, seconds: Math.round((spoken / tempo) * 1000) / 1000, clamped: Math.abs(tempo - want) > 1e-6 };
}

/** The ffmpeg audio filter for the fitted voice: the tempo, then the original's lead-in silence, then padding to `total`. */
export function fitFilter(fit: { tempo: number }, leadSeconds: number, total: number | null): string {
  const parts: string[] = [];
  if (Math.abs(fit.tempo - 1) > 1e-3) parts.push(`atempo=${fit.tempo}`);
  const ms = Math.max(0, Math.round(leadSeconds * 1000));
  if (ms) parts.push(`adelay=${ms}:all=1`);
  if (total && total > 0) parts.push(`apad=whole_dur=${Math.round(total * 1000) / 1000}`);
  return parts.join(',') || 'anull';
}

// ------------------------------------------------------------------------------------------------ children

export type Gen = { submit: (tool: string, o: any) => Promise<any>; wait: (id: string, o: any) => Promise<any> };

let clientFor: ((ctx: RunContext) => Gen) | null = null;
/** Tests only: a fake Gen for the children (null puts the real one back). */
export function _setChainClient(f: ((ctx: RunContext) => Gen) | null) {
  clientFor = f;
}
export function genClient(ctx: RunContext): Gen {
  return clientFor ? clientFor(ctx) : new HawkesGen({ url: SELF_URL(), key: SELF_TOKEN, project: ctx.job.project });
}

/** Runs one child job and waits for it. `name` keys it, so a resumed parent picks the same child up again. */
export async function child(ctx: RunContext, gen: Gen, name: string, spec: ChildSpec) {
  const job = await gen.submit(spec.tool, { params: spec.params, inputs: spec.inputs, labels: { parent: ctx.job.id, step: name }, key: `${ctx.job.id}:${name}`, reuse: true });
  ctx.log(`${name}: ${job.tool} (${job.id}${job.reused ? ', from the library' : ''})`);
  const done = job.status === 'done' ? job : await gen.wait(job.id, { throwOnFail: false, signal: ctx.signal, onUpdate: (j: any) => ctx.step(`${name}: ${j.detail}`) });
  // A step no GPU could run says so in the same plain words (src/providers/gpu/nogpu.ts): that is the whole story.
  if (done.status === 'failed' && /^No GPU /.test(String(done.error ?? ''))) throw new GenError(String(done.error));
  if (done.status !== 'done') throw new GenError(`${name} (${done.tool}) ${done.status}: ${done.error ?? done.detail}`);
  return done;
}

export const firstAsset = (job: any, kind?: string) => {
  const o = (job.outputs ?? []).find((x: any) => !kind || x.kind === kind) ?? job.outputs?.[0];
  const a = o ? getAsset(o.asset) : null;
  if (!a) throw new GenError(`${job.tool} made nothing to pass on`);
  return a as { id: string; path: string; kind: string; mime?: string };
};

const subst = (v: unknown, vars: Record<string, string>): unknown => {
  if (Array.isArray(v)) return v.map((x) => subst(x, vars));
  if (typeof v === 'string' && v.startsWith('$')) {
    if (!(v in vars)) throw new GenError(`internal: ${v} is not set`);
    return vars[v];
  }
  return v;
};
const bind = (s: ChildSpec, vars: Record<string, string>): ChildSpec => ({ ...s, inputs: Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, subst(v, vars)])) });

// ------------------------------------------------------------------------------------------------ video.change

export const videoChangeTool: Tool = {
  id: 'video.change',
  version: 1,
  title: 'Change something in a video',
  description: 'Changes something in a clip as the prompt says (a different jacket, day to night, a prop swapped, a new art style) and carries the change through every frame, following the original motion. Optionally a mask on the first frame says where. How: the first frame is edited (image.repaint with the mask, else image.edit), then video.control (LTX-2.3, depth read from the original) repaints the whole clip from that frame; the original sound is kept. Up to 20 seconds.',
  provider: 'pipeline',
  // Only for estimates and the price (the GPU work is the children's): the expensive part is video.control.
  family: 'ltx-2.3',
  output: 'video',
  inputs: {
    video: { kind: 'video', required: true, description: 'The clip to change.' },
    mask: { kind: 'image', description: 'Optional: where to change it, on the first frame (white or opaque = change).' },
  },
  params: {
    prompt: { type: 'text', required: true, description: 'The change, e.g. "make his jacket red leather".' },
    motion: { type: 'text', description: 'What happens and what it sounds like, for the video model (default: "the same motion as the original" plus the change).', advanced: true },
    keepSound: { type: 'boolean', default: true, description: 'Keep the original clip\'s sound (else the video model\'s own).' },
    feather: { type: 'integer', min: 0, max: 128, default: 12, advanced: true, description: 'Soft edge of the masked edit.' },
    strength: { type: 'number', min: 0, max: 1, advanced: true, description: 'How strictly the motion follows the original (video.control strength, default 1).' },
    long: { type: 'integer', min: 512, max: 1920, default: 1280, advanced: true, description: 'Long side of the generated clip.' },
    seed: { type: 'integer', min: 1, max: 2 ** 48, advanced: true },
  },
  gpuSeconds: (p) => 15 + 150 * Math.min(20, Number(p.seconds) || 10) / 10,
  async run(ctx) {
    const p = ctx.params;
    const video = ctx.inputs.video as string;
    const mask = ctx.inputs.mask as string | undefined;
    const info = await probe(video, ctx.signal);
    const plan = videoChangePlan(info, p, Boolean(mask));
    ctx.step('taking the first frame');
    const frame = ctx.tmp('first.png');
    await run('ffmpeg', frameArgs(video, frame, 'first', null), { signal: ctx.signal });
    const gen = genClient(ctx);
    const edited = firstAsset(await child(ctx, gen, 'frame', bind(plan.edit, { $frame: frame, ...(mask ? { $mask: mask } : {}) })), 'image');
    const made = firstAsset(await child(ctx, gen, 'video', bind(plan.control, { $video: video, $edited: `asset:${edited.id}` })), 'video');
    let out = made.path;
    if (p.keepSound !== false && plan.hasSound) {
      ctx.step('putting the original sound back');
      out = ctx.tmp('changed.mp4');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', made.path, '-i', video, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out], { signal: ctx.signal });
    }
    await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', title: 'video', meta: { frame: edited.id, from: made.id, seconds: plan.seconds } });
    await ctx.emit({ data: fs.readFileSync(edited.path), ext: '.png', title: 'first frame', meta: { from: edited.id } });
    ctx.result({ frame: edited.id, video: made.id, steps: [plan.edit.tool, plan.control.tool], seconds: plan.seconds, keptSound: out !== made.path });
  },
};

// ------------------------------------------------------------------------------------------------ audio.revoice

export const audioRevoiceTool: Tool = {
  id: 'audio.revoice',
  version: 1,
  title: 'Give it a new voice',
  description: 'Says the same words in a different voice: the speech in a clip (audio, or a video\'s sound) is transcribed (audio.transcribe), spoken again by an open voice model in a voice you describe in words or a saved Gen voice (audio.voice), fitted to the original\'s timing (starting where it started, sped up or slowed down by at most 25%) and, for a video, put back on it. One speaker at a time; music and effects under the voice are replaced too. Give text to skip the transcription.',
  provider: 'pipeline',
  output: 'audio',
  inputs: {
    audio: { kind: 'audio', description: 'The speech.' },
    video: { kind: 'video', description: 'Or a video: it comes back with the new voice.' },
  },
  params: {
    description: { type: 'text', description: 'The new voice in words, e.g. "a deep, calm older man with a slight rasp".' },
    voice: { type: 'string', description: 'Or a saved Gen voice id (gv_...).' },
    text: { type: 'text', description: 'What is said (skips the transcription).' },
    language: { type: 'string', description: 'Language code (en, es, ...).', advanced: true },
    direction: { type: 'json', orString: true, description: 'How to say it (see audio.voice): a sentence or an object.', advanced: true },
    fit: { type: 'boolean', default: true, description: 'Fit the new line to the original\'s timing.' },
  },
  gpuSeconds: () => 60,
  guard({ params, inputs }) {
    if (!params.description && !params.voice) throw new GenError('Describe the new voice (description) or give a saved Gen voice (voice: gv_...)');
    if (params.voice && !/^gv_/.test(String(params.voice))) throw new GenError('voice is a Gen voice id (gv_...); to use an ElevenLabs voice, see audio.voice-change');
    if (!inputs.audio && !inputs.video) throw new GenError('Give audio or a video');
  },
  async run(ctx) {
    const p = ctx.params;
    const video = ctx.inputs.video as string | undefined;
    const src = (ctx.inputs.audio as string | undefined) ?? video!;
    const orig = ctx.tmp('original.wav');
    ctx.step('taking the sound');
    await ff(['-y', '-i', src, '-vn', '-ac', '1', '-ar', '44100', orig], { signal: ctx.signal });
    const before = await analyze(orig, { signal: ctx.signal });
    if (before.silent) throw new GenError('There is no speech in that clip (it is silent)');
    const gen = genClient(ctx);
    let text = String(p.text ?? '').trim();
    if (!text) {
      const t = await child(ctx, gen, 'transcribe', { tool: 'audio.transcribe', params: { ...(p.language ? { language: p.language } : {}) }, inputs: { audio: orig } });
      text = String(t.result?.text ?? '').trim();
      if (!text) throw new GenError('No words were heard in that clip; give the text instead');
    }
    const voiceParams: Record<string, unknown> = { text, provider: 'open', ...(p.voice ? { voice: p.voice } : { description: p.description }), ...(p.language ? { language: p.language } : {}), ...(p.direction ? { direction: p.direction } : {}) };
    const spoken = firstAsset(await child(ctx, gen, 'voice', { tool: 'audio.voice', params: voiceParams, inputs: {} }), 'audio');
    const after = await analyze(spoken.path, { signal: ctx.signal });
    const target = Math.max(0.1, before.seconds - before.leadingSilence - before.trailingSilence);
    const speech = Math.max(0.1, after.seconds - after.leadingSilence - after.trailingSilence);
    const fit = p.fit === false ? { tempo: 1, seconds: speech, clamped: false } : fitTempo(speech, target);
    ctx.log(`original speech ${target.toFixed(2)}s, new ${speech.toFixed(2)}s, tempo ${fit.tempo}${fit.clamped ? ' (clamped: the timing differs)' : ''}`);
    const total = Math.max(before.seconds, before.leadingSilence + fit.seconds);
    const voiced = ctx.tmp('voice.wav');
    // The new take, trimmed of its own silence, at the fitted tempo, starting where the original's speech started.
    const trim = `atrim=start=${after.leadingSilence}:end=${Math.max(after.leadingSilence + 0.05, after.seconds - after.trailingSilence)},asetpts=PTS-STARTPTS`;
    await ff(['-y', '-i', spoken.path, '-af', `${trim},${fitFilter(fit, p.fit === false ? 0 : before.leadingSilence, total)}`, '-ar', '44100', '-ac', '1', voiced], { signal: ctx.signal });
    const mp3 = ctx.tmp('voice.mp3');
    await ff(['-y', '-i', voiced, '-c:a', 'libmp3lame', '-q:a', '2', mp3], { signal: ctx.signal });
    const meta = { text, tempo: fit.tempo, clamped: fit.clamped, seconds: Math.round(total * 1000) / 1000, from: spoken.id };
    if (video) {
      ctx.step('putting the new voice on the video');
      const out = ctx.tmp('revoiced.mp4');
      const vlen = before.seconds;
      // A line that runs on holds the last frame rather than being cut off.
      const hold = total - vlen > 0.05 ? ['-vf', `tpad=stop_mode=clone:stop_duration=${Math.round((total - vlen) * 1000) / 1000}`, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy'];
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', voiced, '-map', '0:v:0', '-map', '1:a:0', ...hold, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { signal: ctx.signal });
      await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', title: 'video', meta });
    }
    await ctx.emit({ data: fs.readFileSync(mp3), ext: '.mp3', title: 'voice', meta });
    ctx.result(meta);
  },
};
