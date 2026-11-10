// Tools backed by hosted APIs: ElevenLabs (voice, sound) and Claude (text,
// JSON, vision).

import type { RunContext, Tool } from './types.ts';
import { loadSettings } from '../config.ts';
import fs from 'node:fs';
import { speak, soundEffect, designVoice, saveDesignedVoice, dialogue, voiceChange, isolateVoice } from '../providers/elevenlabs.ts';
import { ask, callScope, DEFAULT_MODEL, MODELS, usageOf } from '../providers/anthropic.ts';
import { GenError, run } from '../util.ts';
import { voiceOpenParams, referenceInput, sfxExtra, dialogueExtra, designExtra, saveExtra, listExtra, deleteExtra } from '../audio/params.ts';
import { routeAudio } from '../audio/plan.ts';

export const voiceTool: Tool = {
  id: 'audio.voice',
  version: 1,
  title: 'Speak a line',
  description: 'Speaks a line on the open models of the Gen GPU fleet (MOSS-TTS, Qwen3-TTS, VoxCPM2, Chatterbox): the default. Voice: a Gen voice (voice: gv_..., from audio.voice-design / audio.voice-clone / audio.voice-list), a cloned reference sample, or a description. direction (emotion, delivery, pace), openModel, verify (word-error check), language, seed and post-processing params are open-path params. Secondary: ElevenLabs text to speech runs only with provider: "elevenlabs" or an ElevenLabs voice id (old content; model eleven_v4 / eleven_v3 take delivery tags like [sighs]).',
  provider: 'elevenlabs',
  output: 'audio',
  inputs: { ...referenceInput },
  route: (p) => routeAudio('voice', p),
  params: {
    text: { type: 'text', required: true },
    voice: { type: 'string', description: 'ElevenLabs voice id, or a Gen voice id (gv_..., open models).' },
    model: { type: 'string', default: 'eleven_v4', description: 'eleven_v4, eleven_v3, eleven_multilingual_v2...' },
    format: { type: 'string', default: 'mp3_44100_128', advanced: true },
    settings: { type: 'json', description: 'voice_settings (stability, similarity_boost, style...).', advanced: true },
    count: { type: 'integer', min: 1, max: 4, default: 1, description: 'Takes.' },
    ...voiceOpenParams,
  },
  async run(ctx) {
    const p = ctx.params;
    if (!p.voice) throw new GenError('This is the ElevenLabs path and it needs an ElevenLabs voice id. For a new voice use the open suite: leave provider unset and give a Gen voice (gv_...), a reference sample or a description.');
    for (let i = ctx.done; i < p.count; i++) {
      ctx.step(`take ${i + 1} of ${p.count}`);
      const data = await speak({ text: p.text, voice: p.voice, model: p.model, format: p.format, settings: p.settings }, ctx.signal);
      ctx.usage({ provider: 'elevenlabs', unit: 'characters', amount: p.text.length, cost: (p.text.length / 1000) * loadSettings().rates.elevenlabsPer1kChars, detail: p.model });
      await ctx.emit({ data, ext: p.format.startsWith('mp3') ? '.mp3' : p.format.startsWith('pcm') ? '.pcm' : '.bin' });
    }
  },
};

/** The script's lines with their voices: [{ who, text }] with a cast { who: voiceId }, or [{ voice, text }]. */
export function dialogueLines(lines: unknown, cast: unknown): { who: string; text: string; voice: string }[] {
  if (!Array.isArray(lines) || !lines.length) throw new GenError('lines is a list of { who, text } (with cast) or { voice, text }');
  const c = (cast && typeof cast === 'object' ? cast : {}) as Record<string, string>;
  const byName = new Map(Object.entries(c).map(([k, v]) => [k.trim().toLowerCase(), String(v)]));
  return lines.map((l: any, i) => {
    const text = String(l?.text ?? '').trim();
    if (!text) throw new GenError(`line ${i + 1} has no text`);
    const who = String(l?.who ?? l?.speaker ?? '').trim();
    const voice = String(l?.voice ?? byName.get(who.toLowerCase()) ?? '').trim();
    if (!voice) throw new GenError(`line ${i + 1}${who ? ` (${who})` : ''} has no voice: give it a voice id, or put ${who || 'its speaker'} in cast`);
    return { who: who || voice, text, voice };
  });
}

const seconds = async (file: string, signal?: AbortSignal) => Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { signal })).trim()) || 0;

/**
 * The table read: a whole scene's dialogue voiced in one take (ElevenLabs Text to Dialogue, eleven_v3), so the
 * characters answer each other with real timing (a beat before a hard line, a quick comeback, a laugh over a word)
 * instead of lines read one at a time and joined with gaps. Its track and each line's start and end drive the edit, the
 * rough draft and the lip sync. Delivery tags work in the text: [sighs], [whispers], [laughs], [interrupting].
 */
export const dialogueTool: Tool = {
  id: 'audio.dialogue',
  version: 1,
  title: "Table read: a scene's dialogue in one take",
  description: 'A scene\'s dialogue on the open models (default): every line in its character\'s Gen voice (cast { who: gv_... }), per-line direction, laid on one track. Secondary: ElevenLabs Text to Dialogue (eleven_v3), used only with provider: "elevenlabs" or ElevenLabs voice ids in the cast: every line of a scene voiced together, the speakers taking turns and reacting like people. lines: [{ who, text }] with cast { who: voiceId } (or [{ voice, text }]); delivery tags like [sighs] [whispers] [interrupting] in the text. Outputs the dialogue track, each line as its own clip (stems), and when each line starts and ends. Keep a scene under about 2,000 characters.',
  provider: 'elevenlabs',
  output: 'audio',
  inputs: {},
  route: (p) => routeAudio('dialogue', p),
  params: {
    lines: { type: 'json', required: true, description: '[{ "who": "Exit Punk", "text": "[out of breath] I\'m eleven seconds late." }, ...] in order', example: [{ who: 'The Mechanic', text: "You're late." }, { who: 'Exit Punk', text: "[out of breath] I'm eleven seconds late." }] },
    cast: { type: 'json', description: '{ "Exit Punk": "<voice id>", ... } (the product\'s voice file)', example: { 'The Mechanic': 'voice-id', 'Exit Punk': 'voice-id' } },
    stems: { type: 'boolean', default: true, description: 'Also each line as its own clip (for lip sync per shot)' },
    model: { type: 'string', default: 'eleven_v3', advanced: true },
    format: { type: 'string', default: 'mp3_44100_128', advanced: true },
    count: { type: 'integer', min: 1, max: 3, default: 1, description: 'Takes (each a different read)' },
    ...voiceOpenParams,
    ...dialogueExtra,
  },
  async run(ctx) {
    const p = ctx.params;
    const lines = dialogueLines(p.lines, p.cast);
    const takes: any[] = [];
    for (let i = 0; i < p.count; i++) {
      ctx.step(`take ${i + 1} of ${p.count}`);
      const r = await dialogue({ lines: lines.map((l) => ({ text: l.text, voice: l.voice })), model: p.model, format: p.format }, ctx.signal);
      ctx.usage({ provider: 'elevenlabs', unit: 'characters', amount: r.chars, cost: (r.chars / 1000) * loadSettings().rates.elevenlabsPer1kChars, detail: `${p.model} dialogue` });
      const file = ctx.tmp(`dialogue-${i}.mp3`);
      fs.writeFileSync(file, r.audio);
      const segments = lines.map((l, k) => {
        const seg = r.segments.filter((s) => s.line === k);
        return { line: k, who: l.who, text: l.text, start: seg.length ? Math.min(...seg.map((s) => s.start)) : null, end: seg.length ? Math.max(...seg.map((s) => s.end)) : null };
      });
      const length = await seconds(file, ctx.signal);
      await ctx.emit({ data: r.audio, ext: '.mp3', title: i ? `dialogue (take ${i + 1})` : 'dialogue', meta: { seconds: length, segments } });
      if (p.stems) {
        for (const s of segments) {
          if (s.start === null || s.end === null) continue;
          const out = ctx.tmp(`line-${i}-${s.line}.mp3`);
          // A little air either side, so a cut on the line doesn't clip a breath.
          await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, s.start - 0.08)), '-to', String(s.end + 0.12), '-i', file, '-c:a', 'libmp3lame', '-q:a', '2', out], { signal: ctx.signal });
          await ctx.emit({ data: fs.readFileSync(out), ext: '.mp3', title: `line ${s.line + 1}: ${s.who}${i ? ` (take ${i + 1})` : ''}`, meta: { line: s.line, who: s.who, text: s.text, start: s.start, end: s.end } });
        }
      }
      takes.push({ seconds: length, segments });
    }
    ctx.result({ takes, seconds: takes[0]?.seconds, segments: takes[0]?.segments });
  },
};

/**
 * The voice changer: a performance's delivery (timing, breaths, emotion) in a cast character's voice. For an acted take
 * (J on a phone through video.replace, a scene a model voiced itself) whose acting is right but whose voice isn't ours:
 * the syllables don't move, so the lips stay on them. A video comes back with the new voice as its sound.
 */
export const voiceChangeTool: Tool = {
  id: 'audio.voice-change',
  version: 1,
  title: 'Voice changer: the same performance in a cast voice',
  description: "ElevenLabs only (no open model yet; it never runs unless called, and fails while ElevenLabs billing is blocked). Speech to Speech: the delivery of a recording, word for word and beat for beat, in another voice (a cast character's voice id). Give audio, or a video (its sound is changed and put back). isolate first takes the voice off music and effects. For one speaker at a time: cut a two-person scene into each speaker's lines first.",
  provider: 'elevenlabs',
  output: 'audio',
  inputs: {
    audio: { kind: 'audio', description: 'The performance (one speaker)' },
    video: { kind: 'video', description: 'Or a video: its sound is changed and the video comes back with it' },
  },
  params: {
    voice: { type: 'string', required: true, description: 'The cast voice (ElevenLabs voice id)' },
    isolate: { type: 'boolean', default: true, description: 'Take the voice off music, room and effects first' },
    model: { type: 'string', default: 'eleven_multilingual_sts_v2', advanced: true },
    settings: { type: 'json', advanced: true, description: 'voice_settings (stability, similarity_boost, style)' },
    provider: voiceOpenParams.provider,
  },
  route: (p) => routeAudio('change', p),
  async run(ctx) {
    const p = ctx.params;
    const video = ctx.inputs.video as string | undefined;
    const audioIn = ctx.inputs.audio as string | undefined;
    if (!video && !audioIn) throw new GenError('Give audio or a video');
    const source = audioIn ?? ctx.tmp('performance.mp3');
    if (video) {
      ctx.step('taking the sound off the video');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', '2', source], { signal: ctx.signal });
    }
    let audio: Buffer = fs.readFileSync(source);
    if (p.isolate) {
      ctx.step('isolating the voice');
      audio = await isolateVoice({ audio, name: 'performance.mp3' }, ctx.signal);
    }
    ctx.step('changing the voice');
    const voiced = await voiceChange({ audio, voice: p.voice, model: p.model, settings: p.settings, removeNoise: !p.isolate }, ctx.signal);
    const length = await seconds(source, ctx.signal);
    // Speech to speech bills like speech by the minute of audio; isolation too: counted here as characters' worth.
    ctx.usage({ provider: 'elevenlabs', unit: 'seconds', amount: length, cost: (length / 60) * (p.isolate ? 2 : 1) * loadSettings().rates.elevenlabsPer1kChars, detail: `${p.model} speech to speech` });
    await ctx.emit({ data: voiced, ext: '.mp3', title: 'voice' });
    if (video) {
      ctx.step('putting the voice back on the video');
      const v = ctx.tmp('voice.mp3');
      const out = ctx.tmp('performance.mp4');
      fs.writeFileSync(v, voiced);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', v, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-af', 'apad', '-shortest', '-movflags', '+faststart', out], { signal: ctx.signal });
      await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', title: 'video' });
    }
  },
};

export const sfxTool: Tool = {
  id: 'audio.sfx',
  version: 1,
  title: 'Sound effect',
  description: 'A sound effect on the open models of the Gen GPU fleet (MOSS-SoundEffect; default): one description, one sound, or variants (a list of prompts) for one game event. Leave duration empty on a hit so the model picks the length; set loop and a duration only for beds the game repeats. Normalised and trimmed. Secondary: ElevenLabs sound generation, only with provider: "elevenlabs".',
  provider: 'elevenlabs',
  output: 'audio',
  inputs: {},
  route: (p) => routeAudio('sfx', p),
  params: {
    text: { type: 'text', required: true },
    duration: { type: 'number', min: 0.5, max: 30, description: 'Seconds (empty: the model decides).' },
    loop: { type: 'boolean', default: false },
    influence: { type: 'number', min: 0, max: 1, default: 0.55, description: 'How tightly it follows the description.' },
    model: { type: 'string', default: 'eleven_text_to_sound_v3', advanced: true },
    format: { type: 'string', default: 'mp3_44100_128', advanced: true },
    count: { type: 'integer', min: 1, max: 4, default: 1, description: 'Takes.' },
    ...voiceOpenParams,
    ...sfxExtra,
  },
  async run(ctx) {
    const p = ctx.params;
    for (let i = ctx.done; i < p.count; i++) {
      ctx.step(`take ${i + 1} of ${p.count}`);
      const data = await soundEffect({ text: p.text, duration: p.duration, loop: p.loop, influence: p.influence, model: p.model, format: p.format }, ctx.signal);
      // Sound generation is billed by length; estimate from the duration (or a typical 4 s hit).
      const chars = Math.round((p.duration ?? 4) * 40);
      ctx.usage({ provider: 'elevenlabs', unit: 'characters', amount: chars, cost: (chars / 1000) * loadSettings().rates.elevenlabsPer1kChars, detail: 'sfx (estimated)' });
      await ctx.emit({ data, ext: '.mp3' });
    }
  },
};

export const voiceDesignTool: Tool = {
  id: 'audio.voice-design',
  version: 1,
  title: 'Design a voice',
  description: 'Designs candidate voices (default 3, candidates param) from a description on the open models (Qwen3-TTS / VoxCPM2; default), each saved in the Gen voice library as a candidate (gv_...) with its preview clip. audio.voice-save keeps the one you choose. No slot cap. Secondary: ElevenLabs Voice Design, only with provider: "elevenlabs" (previews expire; ids are ElevenLabs generatedVoiceIds).',
  provider: 'elevenlabs',
  output: 'audio',
  inputs: {},
  params: {
    description: { type: 'text', required: true, description: 'Age, tone, accent, attitude, recording quality.' },
    text: { type: 'text', description: 'What the previews say (100-1000 characters). Empty or shorter: ElevenLabs writes it.' },
    model: { type: 'string', default: 'eleven_ttv_v3', advanced: true },
    ...designExtra,
    ...voiceOpenParams,
  },
  route: (p) => routeAudio('design', p),
  async run(ctx) {
    const p = ctx.params;
    ctx.step('designing voices');
    const { text, previews } = await designVoice({ description: p.description, text: p.text, model: p.model }, ctx.signal);
    ctx.usage({ provider: 'elevenlabs', unit: 'characters', amount: text.length * previews.length, cost: ((text.length * previews.length) / 1000) * loadSettings().rates.elevenlabsPer1kChars, detail: 'voice design (estimated)' });
    for (let i = ctx.done; i < previews.length; i++)
      await ctx.emit({ data: previews[i].audio, ext: '.mp3', title: `candidate ${i + 1}`, meta: { generatedVoiceId: previews[i].generatedVoiceId } });
    ctx.result({ text, candidates: previews.map((c) => c.generatedVoiceId) });
  },
};

export const voiceSaveTool: Tool = {
  id: 'audio.voice-save',
  version: 1,
  title: 'Save a designed voice',
  description: 'Keeps an audio.voice-design candidate (generatedVoiceId: gv_...) in the Gen voice library under a name (default; no slot cap). The result is { voiceId } for audio.voice. Secondary: with provider: "elevenlabs", saves an ElevenLabs candidate to the ElevenLabs account.',
  provider: 'elevenlabs',
  output: 'json',
  inputs: {},
  params: {
    generatedVoiceId: { type: 'string', required: true },
    name: { type: 'string', required: true, description: 'Name in the voice library, e.g. "Sick Of It - player".' },
    description: { type: 'text', required: true },
    ...saveExtra,
  },
  route: (p) => routeAudio('save', p),
  async run(ctx) {
    const p = ctx.params;
    ctx.step('saving the voice');
    const voiceId = await saveDesignedVoice({ name: p.name, description: p.description, generatedVoiceId: p.generatedVoiceId }, ctx.signal);
    ctx.result({ voiceId });
  },
};

/** The answer as it is written, readable while the job runs: `result.partial` (the text so far) and `result.chars`,
 *  saved at most every PARTIAL_MS so a caller polling GET /v1/jobs/:id (or listening to /v1/events) can act on it early
 *  (the portal's Overseer builds the world from it line by line). The finished result replaces it. */
const PARTIAL_MS = 250;
function partials(ctx: RunContext) {
  let last = 0;
  let timer: NodeJS.Timeout | null = null;
  let text = '';
  let stopped = false;
  const flush = () => { timer = null; last = Date.now(); if (!stopped && !ctx.signal.aborted) ctx.result({ partial: text, chars: text.length }); };
  return {
    onText: (soFar: string) => {
      text = soFar;
      if (timer || stopped) return;
      const wait = PARTIAL_MS - (Date.now() - last);
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    },
    /** No more partials (before the finished result, or on failure). */
    stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}

/** A job someone is waiting on (labels `waiting`, e.g. the portal's Overseer answer, a player watching): its Claude
 *  call is that person's turn (`who` = the job's project), so it goes ahead of Gen's own background calls, waits a bounded
 *  time for a slot and fails plainly instead of backing off for minutes (src/aigate.ts, claudecode.ts). */
export function waitedOn<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
  if (!ctx.job?.labels?.waiting) return fn();
  return callScope.run({ customer: false, ...callScope.getStore(), who: ctx.job.project }, fn);
}

const llmParams = {
  prompt: { type: 'text', required: true },
  system: { type: 'text' },
  model: { type: 'enum', values: MODELS, default: DEFAULT_MODEL },
  effort: { type: 'enum', values: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
  maxTokens: { type: 'integer', min: 256, max: 128000, default: 16000, advanced: true },
} as const;

export const llmTextTool: Tool = {
  id: 'llm.text',
  version: 1,
  title: 'Ask Claude',
  description: 'Claude writes or answers: lore, barks, descriptions, prompts for other tools. Attach images for vision (art review, describing a concept). Returns the text.',
  provider: 'anthropic',
  output: 'text',
  inputs: { images: { kind: 'image', multiple: true, max: 20 } },
  params: { ...llmParams } as any,
  async run(ctx) {
    const p = ctx.params;
    ctx.step(`asking ${p.model}`);
    const live = partials(ctx);
    const r = await waitedOn(ctx, () => ask({ prompt: p.prompt, system: p.system, images: ctx.inputs.images ?? [], model: p.model, effort: p.effort, maxTokens: p.maxTokens, onText: live.onText }, ctx.signal)).finally(live.stop);
    ctx.usage(usageOf(r));
    ctx.result({ text: r.text, model: r.model, usage: r.usage });
  },
};

export const llmJsonTool: Tool = {
  id: 'llm.json',
  version: 1,
  title: 'Claude, as JSON',
  description: 'Claude answers as JSON that matches your schema (structured output): level designs, dressing plans, review scores with fixes. Attach images for vision. Returns the parsed object.',
  provider: 'anthropic',
  output: 'json',
  inputs: { images: { kind: 'image', multiple: true, max: 20 } },
  params: { ...llmParams, schema: { type: 'json', required: true, description: 'JSON Schema for the answer (objects need additionalProperties: false).' } } as any,
  async run(ctx) {
    const p = ctx.params;
    if (!p.schema || typeof p.schema !== 'object') throw new GenError('schema must be a JSON Schema object');
    ctx.step(`asking ${p.model} for JSON`);
    const live = partials(ctx);
    const r = await waitedOn(ctx, () => ask({ prompt: p.prompt, system: p.system, images: ctx.inputs.images ?? [], model: p.model, effort: p.effort, maxTokens: p.maxTokens, schema: p.schema, onText: live.onText }, ctx.signal)).finally(live.stop);
    ctx.usage(usageOf(r));
    let value: unknown;
    try {
      value = JSON.parse(r.text);
    } catch {
      throw new GenError('Claude returned something that is not JSON');
    }
    ctx.result({ value, model: r.model, usage: r.usage });
  },
};
