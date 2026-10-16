// Tools backed by hosted APIs: ElevenLabs (voice, sound) and Claude (text,
// JSON, vision).

import type { Tool } from './types.ts';
import { loadSettings } from '../config.ts';
import { speak, soundEffect, designVoice, saveDesignedVoice } from '../providers/elevenlabs.ts';
import { ask, DEFAULT_MODEL, MODELS } from '../providers/anthropic.ts';
import { GenError } from '../util.ts';

export const voiceTool: Tool = {
  id: 'audio.voice',
  version: 1,
  title: 'Speak a line',
  description: 'ElevenLabs text to speech with a voice from the account\'s library (GET /v1/providers/elevenlabs/voices). eleven_v3 and eleven_v4 take delivery tags like [sighs] in the text.',
  provider: 'elevenlabs',
  output: 'audio',
  inputs: {},
  params: {
    text: { type: 'text', required: true },
    voice: { type: 'string', required: true, description: 'ElevenLabs voice id.' },
    model: { type: 'string', default: 'eleven_v4', description: 'eleven_v4, eleven_v3, eleven_multilingual_v2...' },
    format: { type: 'string', default: 'mp3_44100_128', advanced: true },
    settings: { type: 'json', description: 'voice_settings (stability, similarity_boost, style...).', advanced: true },
    count: { type: 'integer', min: 1, max: 4, default: 1, description: 'Takes.' },
  },
  async run(ctx) {
    const p = ctx.params;
    for (let i = ctx.done; i < p.count; i++) {
      ctx.step(`take ${i + 1} of ${p.count}`);
      const data = await speak({ text: p.text, voice: p.voice, model: p.model, format: p.format, settings: p.settings }, ctx.signal);
      ctx.usage({ provider: 'elevenlabs', unit: 'characters', amount: p.text.length, cost: (p.text.length / 1000) * loadSettings().rates.elevenlabsPer1kChars, detail: p.model });
      await ctx.emit({ data, ext: p.format.startsWith('mp3') ? '.mp3' : p.format.startsWith('pcm') ? '.pcm' : '.bin' });
    }
  },
};

export const sfxTool: Tool = {
  id: 'audio.sfx',
  version: 1,
  title: 'Sound effect',
  description: 'ElevenLabs sound generation: one description, one sound. Leave duration empty on a hit so the model picks the length; set loop and a duration only for beds the game repeats.',
  provider: 'elevenlabs',
  output: 'audio',
  inputs: {},
  params: {
    text: { type: 'text', required: true },
    duration: { type: 'number', min: 0.5, max: 30, description: 'Seconds (empty: the model decides).' },
    loop: { type: 'boolean', default: false },
    influence: { type: 'number', min: 0, max: 1, default: 0.55, description: 'How tightly it follows the description.' },
    model: { type: 'string', default: 'eleven_text_to_sound_v2', advanced: true },
    format: { type: 'string', default: 'mp3_44100_128', advanced: true },
    count: { type: 'integer', min: 1, max: 4, default: 1, description: 'Takes.' },
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
  description: 'ElevenLabs Voice Design: candidate voices (usually 3) from a description, each as a preview clip. Nothing is saved to the account; the result lists each candidate\'s generatedVoiceId (same order as the outputs) for audio.voice-save. Previews expire after a while.',
  provider: 'elevenlabs',
  output: 'audio',
  inputs: {},
  params: {
    description: { type: 'text', required: true, description: 'Age, tone, accent, attitude, recording quality.' },
    text: { type: 'text', description: 'What the previews say (100-1000 characters). Empty or shorter: ElevenLabs writes it.' },
    model: { type: 'string', default: 'eleven_ttv_v3', advanced: true },
  },
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
  description: 'Saves an audio.voice-design candidate (its generatedVoiceId) to the ElevenLabs voice library. The result is { voiceId } for audio.voice.',
  provider: 'elevenlabs',
  output: 'json',
  inputs: {},
  params: {
    generatedVoiceId: { type: 'string', required: true },
    name: { type: 'string', required: true, description: 'Name in the voice library, e.g. "Sick Of It - player".' },
    description: { type: 'text', required: true },
  },
  async run(ctx) {
    const p = ctx.params;
    ctx.step('saving the voice');
    const voiceId = await saveDesignedVoice({ name: p.name, description: p.description, generatedVoiceId: p.generatedVoiceId }, ctx.signal);
    ctx.result({ voiceId });
  },
};

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
    const r = await ask({ prompt: p.prompt, system: p.system, images: ctx.inputs.images ?? [], model: p.model, effort: p.effort, maxTokens: p.maxTokens }, ctx.signal);
    ctx.usage({ provider: 'anthropic', unit: 'tokens', amount: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), cost: r.cost, detail: r.model });
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
    const r = await ask({ prompt: p.prompt, system: p.system, images: ctx.inputs.images ?? [], model: p.model, effort: p.effort, maxTokens: p.maxTokens, schema: p.schema }, ctx.signal);
    ctx.usage({ provider: 'anthropic', unit: 'tokens', amount: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), cost: r.cost, detail: r.model });
    let value: unknown;
    try {
      value = JSON.parse(r.text);
    } catch {
      throw new GenError('Claude returned something that is not JSON');
    }
    ctx.result({ value, model: r.model, usage: r.usage });
  },
};
