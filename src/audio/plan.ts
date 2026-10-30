// Planning for the open audio tools, with no I/O so the tests need no server: which model, what the model is told,
// the takes, the price. Routing (audio.voice -> the open tool or ElevenLabs) is here too.

import { GenError } from '../util.ts';
import { loadSettings } from '../config.ts';
import { AUDIO_MODELS, modelById, selectable, type AudioModel, type Capability } from './registry.ts';
import { mapDirection, type Mapped } from './direction.ts';
import { getVoice, isGenVoiceId, refPath, type Voice } from './voicelib.ts';
import { houseReference, houseVoice, isHouseVoiceId, isOwnVoiceId } from './house.ts';

export type Provider = 'open' | 'elevenlabs' | 'auto';

/** Preference when several models can do the job: the audition list's order, models whose adapter is written first. */
// Qwen3-TTS first: it speaks, takes direction, designs and clones, and it is the one in the GPU worker image
// (server/cloudrun/Dockerfile). Stable Audio 3 is the sound effects (a ComfyUI workflow).
const ORDER = ['qwen3-tts', 'voxcpm2', 'chatterbox', 'stable-audio-3', 'moss-tts', 'moss-soundeffect'];
const rank = (m: AudioModel) => (m.adapter === 'written' ? 0 : 10) + ORDER.indexOf(m.id);

export const verifiedModels = () => new Set(loadSettings().audio.verified);

/** The model for a job. `wanted`: the caller's choice ('auto' or empty picks). `need`: what it has to do. */
export function pickModel(kind: 'voice' | 'sfx', need: Capability[], wanted?: string, verified: Set<string> = verifiedModels(), opts: { onlyVerified?: boolean } = {}): AudioModel {
  if (wanted && wanted !== 'auto') {
    const m = modelById(wanted);
    if (!m || m.kind !== kind) throw new GenError(`${wanted} is not a ${kind} model (${selectable(kind, kind === 'voice' ? 'speak' : 'sfx').map((x) => x.id).join(', ')})`);
    if (m.blocked) throw new GenError(`${m.id} cannot be used: ${m.blocked}`);
    if (m.license.commercial === false) throw new GenError(`${m.id} is not licensed for commercial use`);
    const lacking = need.filter((c) => !m.caps.includes(c));
    if (lacking.length) throw new GenError(`${m.id} cannot ${lacking.join(' / ')}; models that can: ${selectable(kind, need[0]).filter((x) => need.every((c) => x.caps.includes(c))).map((x) => x.id).join(', ') || 'none'}`);
    return m;
  }
  const fits = selectable(kind, kind === 'voice' ? 'speak' : 'sfx').filter((m) => need.every((c) => m.caps.includes(c)));
  const pool = opts.onlyVerified ? fits.filter((m) => verified.has(m.id)) : fits;
  if (!pool.length) throw new GenError(`No ${opts.onlyVerified ? 'verified ' : ''}open ${kind} model can ${need.join(' + ') || 'do this'} yet`, { status: 409 });
  // Verified first, then by preference.
  return [...pool].sort((a, b) => Number(verified.has(b.id)) - Number(verified.has(a.id)) || rank(a) - rank(b))[0];
}

export type SpeakItem = {
  id: string; text: string; instruct: string | null; exaggeration: number | null; cfgWeight: number | null; speed: number | null;
  description: string | null; refFile: string | null; refText: string | null; language: string; seed: number; dropped: string[];
};

export type VoiceCall = {
  text?: string; voice?: string; direction?: unknown; description?: string; language?: string; openModel?: string; count?: number; seed?: number;
};

const need = (voice: Voice | null, c: VoiceCall, reference: boolean): Capability[] => {
  const n: Capability[] = ['speak'];
  if (c.direction != null && c.direction !== '') n.push('direction');
  if (reference) n.push('clone');
  else if (voice?.description || c.description) n.push('design');
  return n;
};

/** One speak job's plan: the model, one item per take. `reference`: an uploaded sample for this call (clone on the fly). */
export function planSpeak(c: VoiceCall, o: { reference?: string | null; referenceText?: string | null; verified?: Set<string>; seed: (n: number) => number }): { model: AudioModel; voice: Voice | null; items: SpeakItem[]; warnings: string[] } {
  const text = String(c.text ?? '').trim();
  if (!text) throw new GenError('text is required');
  let voice: Voice | null = null;
  // A house voice (src/audio/house.ts): its saved reference when it has one (the same voice every line), else its description.
  const house = isHouseVoiceId(c.voice) ? houseVoice(String(c.voice)) : null;
  if (isHouseVoiceId(c.voice) && !house) throw new GenError(`No house voice ${c.voice}`, { status: 404 });
  if (house) voice = houseReference(house.id);
  else if (c.voice) {
    if (!isGenVoiceId(c.voice)) throw new GenError(`voice ${c.voice} is not a Gen voice id (gv_...); ElevenLabs ids run with provider: "elevenlabs"`);
    voice = getVoice(c.voice);
    if (!voice) throw new GenError(`No voice ${c.voice} in the Gen voice library`, { status: 404 });
  }
  const ref = o.reference ?? (voice ? refPath(voice) : null);
  const refText = o.referenceText ?? voice?.refText ?? null;
  const description = c.description ?? voice?.description ?? house?.description ?? null;
  // A designed voice with no reference clip can only be spoken by the model that designed it (its description is its voice).
  const wanted = c.openModel && c.openModel !== 'auto' ? c.openModel : !ref && voice?.model && modelById(voice.model) ? voice.model : undefined;
  const model = pickModel('voice', need(voice, c, Boolean(ref)), wanted, o.verified);
  const warnings: string[] = [];
  if (model.license.commercial === 'verify') warnings.push(`${model.id}: commercial license not confirmed (${model.license.note})`);
  const count = Math.max(1, Math.min(4, Number(c.count) || 1));
  const items: SpeakItem[] = Array.from({ length: count }, (_, i) => {
    const m: Mapped = mapDirection(model, text, c.direction);
    return {
      id: `take${i}`, text: m.text, instruct: m.instruct, exaggeration: m.exaggeration, cfgWeight: m.cfgWeight, speed: m.speed,
      description, refFile: ref, refText, language: c.language ?? voice?.language ?? 'en', seed: house && !ref && c.seed == null ? house.seed + i : o.seed(i), dropped: m.dropped,
    };
  });
  return { model, voice, items, warnings };
}

/** GPU seconds for a speak job: the model load, the speech (about 15 characters a second), and the server's own overhead. */
export function speakGpuSeconds(model: AudioModel, chars: number, takes: number, asr = false): number {
  const audio = Math.max(1, chars / 15);
  return Math.round(model.gpuLoadSeconds + 30 + audio * model.gpuPerAudioSecond * takes + (asr ? 20 : 0));
}

/** Loudness target for a project and kind: `<project>:<kind>`, `<project>`, `default:<kind>`, `default`. */
export function targetLufs(project: string, kind: 'voice' | 'sfx' | 'music', override?: number | null): number | null {
  if (override === null) return null;
  if (typeof override === 'number') return override;
  const t = loadSettings().audio.targetLufs;
  return t[`${project}:${kind}`] ?? t[project] ?? t[`default:${kind}`] ?? t.default ?? null;
}

/** Tool ids. The shared names route here unless a call asks for ElevenLabs. */
export const OPEN = {
  voice: 'audio.voice-open', sfx: 'audio.sfx-open', dialogue: 'audio.dialogue-open', design: 'audio.voice-design-open',
  save: 'audio.voice-save-open', list: 'audio.voice-list-open', delete: 'audio.voice-delete-open',
} as const;

function provider(p: Record<string, any>): Provider {
  const v = p.provider;
  if (v === undefined || v === null || v === '') return 'auto';
  if (v !== 'open' && v !== 'elevenlabs' && v !== 'auto') throw new GenError('provider is open, elevenlabs or auto');
  return v;
}

/**
 * Routes a call on one of the shared audio.* names. The open suite is the default (J, 2026-10-25: ElevenLabs is secondary).
 * ElevenLabs runs only when the call says provider "elevenlabs", or carries an ElevenLabs voice id (old content: speak and
 * dialogue). `auto` (provider unset) is the open path; there is no silent fall back to ElevenLabs for the library tools
 * (list, design, save, delete) or for sound effects. voice-change has no open model yet and stays on ElevenLabs.
 */
export function routeAudio(tool: 'voice' | 'sfx' | 'dialogue' | 'design' | 'save' | 'list' | 'delete' | 'change', p: Record<string, any>): string | null {
  const prov = provider(p);
  if (tool === 'change') {
    if (prov === 'open') throw new GenError('audio.voice-change has no open model yet (Chatterbox VC is the candidate); it runs on ElevenLabs only: use provider "elevenlabs"');
    return null;
  }
  if (prov === 'elevenlabs') return null;
  if (prov === 'auto') {
    // Old content: a call that names an ElevenLabs voice id keeps its ElevenLabs voice.
    if (tool === 'voice' && p.voice && !isOwnVoiceId(p.voice)) return null;
    if (tool === 'dialogue') {
      const cast = Object.values((p.cast && typeof p.cast === 'object' ? p.cast : {}) as Record<string, unknown>).concat(Array.isArray(p.lines) ? p.lines.map((l: any) => l?.voice) : []).filter(Boolean);
      if (cast.some((v) => !isOwnVoiceId(v))) return null;
    }
  }
  return OPEN[tool];
}

export { AUDIO_MODELS };
