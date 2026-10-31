// Params the shared audio.* names and their open-model twins have in common. New params on an existing tool carry no
// default on purpose: validateParams fills defaults into the stored params, which would change the recipe of every call
// that does not use them and make existing assets look out of date.

import type { InputSpec, ParamSpec } from '../tools/types.ts';

export const providerParam: ParamSpec = {
  type: 'enum', values: ['open', 'elevenlabs', 'auto'],
  description: 'Unset (or open) runs the open models on the Gen GPU fleet: the default. elevenlabs runs ElevenLabs, the secondary provider, and is only used when asked (or when the call carries an ElevenLabs voice id, old content). docs/audio.md.',
};

export const directionParam: ParamSpec = {
  // A sentence is as good as an object (direction.ts): the AI editor writes "warm, unhurried" and was refused (2026-10-30).
  type: 'json', orString: true, example: { emotion: 'tired', delivery: 'almost whispering', pace: 'slow', intensity: 0.4 },
  description: 'How to say it: a sentence ("tired, almost whispering"), or { emotion, delivery, pace: slow|normal|fast, style, intensity: 0..1, notes }. [tags] in the text count too. Each model maps it its own way (docs/audio.md "Direction"); what a model cannot do comes back in result.dropped. Open path only.',
};

export const postParams: Record<string, ParamSpec> = {
  normalize: { type: 'boolean', description: 'Loudness-normalise to the product\'s target (settings.audio.targetLufs). Unset: on for the open path.' },
  targetLufs: { type: 'number', min: -40, max: -5, description: 'Override the loudness target (LUFS).', advanced: true },
  trim: { type: 'boolean', description: 'Trim silence at both ends (open path; unset: on).' },
  fade: { type: 'number', min: 0, max: 5, description: 'Fade in and out, seconds (open path).', advanced: true },
  sampleRate: { type: 'integer', min: 8000, max: 96000, description: 'Resample the result (open path).', advanced: true },
};

export const voiceOpenParams: Record<string, ParamSpec> = {
  provider: providerParam,
  openModel: { type: 'string', description: 'Open model: auto (default), qwen3-tts, voxcpm2, chatterbox, moss-tts. See GET /v1/audio/models.' },
  direction: directionParam,
  language: { type: 'string', description: 'Language code (en, zh, ...). Open path.', advanced: true },
  description: { type: 'text', description: 'Open path: describe the voice when the call has no voice id or reference.' },
  referenceText: { type: 'string', description: 'What the reference clip says (clone quality is better with it). Open path.', advanced: true },
  verify: { type: 'boolean', description: 'Transcribe each take and check it says the text (word error rate). Open path.' },
  seed: { type: 'integer', min: 1, max: 2 ** 31 - 1, advanced: true, description: 'Seed of the first take; the next count up. Open path.' },
  ...postParams,
};

export const referenceInput: Record<string, InputSpec> = {
  reference: { kind: 'audio', description: 'A 3 to 10 second sample of the voice to clone (open path).' },
};

export const sfxExtra: Record<string, ParamSpec> = {
  variants: { type: 'json', description: 'Open path: a list of prompt variations for one event; each is one take (count is ignored).', example: ['boot on gravel, heavy', 'boot on gravel, light', 'boot on gravel, dragging'] },
  crossfade: { type: 'number', min: 0.1, max: 4, description: 'Loop crossfade in seconds (default 1).', advanced: true },
};
export const dialogueExtra: Record<string, ParamSpec> = {
  gapMs: { type: 'integer', min: 0, max: 3000, description: 'Silence between lines, ms (default 250).', advanced: true },
};
export const designExtra: Record<string, ParamSpec> = {
  candidates: { type: 'integer', min: 1, max: 6, description: 'Candidates (open path; default 3).' },
};
export const saveExtra: Record<string, ParamSpec> = {
  provider: providerParam,
  elevenlabsId: { type: 'string', description: 'The ElevenLabs voice id this character uses today (kept as the fallback).', advanced: true },
};
export const listExtra: Record<string, ParamSpec> = {
  provider: providerParam,
  project: { type: 'string', description: 'Open path: project, or * for all (default: the caller\'s).' },
  candidates: { type: 'boolean', description: 'Open path: include unsaved candidates.' },
};
export const deleteExtra: Record<string, ParamSpec> = { provider: providerParam };
