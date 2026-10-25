// Direction: how a caller says HOW a line is delivered, and what each open model does with it.
//
// A caller gives `direction` as a plain sentence ("tired, almost whispering, slow") or as an object
// { emotion, delivery, pace, style, intensity, notes }, and may also put ElevenLabs-style tags in the text
// ("[sighs] I'm eleven seconds late."). mapDirection turns that into what one model takes:
//   instruct models (MOSS-TTS, Qwen3-TTS, VoxCPM2): one natural-language instruction, the tags folded into it;
//   tags models (Chatterbox): numeric knobs (exaggeration, cfg_weight) from emotion and pace, tags kept only if the
//     model reads them (paralinguistic [laugh] [cough] [chuckle]), the rest folded into knobs;
//   none: the text only.
// Whatever a model cannot do is returned in `dropped`, so the job result says so instead of pretending.

import { GenError } from '../util.ts';
import type { AudioModel } from './registry.ts';

export type Direction = { emotion?: string; delivery?: string; pace?: 'slow' | 'normal' | 'fast' | string; style?: string; intensity?: number; notes?: string };

export type Mapped = {
  /** The text the model speaks (tags removed or kept as the model reads them). */
  text: string;
  /** The natural-language instruction, for instruct models. */
  instruct: string | null;
  /** Chatterbox-style knobs. */
  exaggeration: number | null;
  cfgWeight: number | null;
  /** Speed multiplier where the model has one (1 = as is). */
  speed: number | null;
  dropped: string[];
};

const TAG = /\[([^\]\n]{1,40})\]/g;
// Tags Chatterbox reads in the text itself.
const PARALINGUISTIC = new Set(['laugh', 'chuckle', 'cough', 'sigh', 'gasp', 'groan', 'sniff', 'shush', 'clear throat']);

const EMOTION_LEVEL: Record<string, number> = {
  calm: 0.3, flat: 0.2, neutral: 0.4, tired: 0.35, sad: 0.5, warm: 0.5, happy: 0.65, excited: 0.8, angry: 0.85, furious: 0.95, scared: 0.75, shouting: 0.9, menacing: 0.7, whispering: 0.3,
};

export function parseDirection(raw: unknown): Direction {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'string') return { notes: raw.trim() };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new GenError('direction is a sentence, or an object { emotion, delivery, pace, style, intensity, notes }');
  const o = raw as Record<string, unknown>;
  const str = (k: string) => (o[k] == null || o[k] === '' ? undefined : String(o[k]).trim());
  const intensity = o.intensity == null ? undefined : Number(o.intensity);
  if (intensity !== undefined && !(intensity >= 0 && intensity <= 1)) throw new GenError('direction.intensity is between 0 and 1');
  const pace = str('pace');
  if (pace && !['slow', 'normal', 'fast'].includes(pace)) throw new GenError('direction.pace is slow, normal or fast');
  return { emotion: str('emotion'), delivery: str('delivery'), pace, style: str('style'), intensity, notes: str('notes') };
}

/** Text without its [tags], and the tags found. */
export function splitTags(text: string): { clean: string; tags: string[] } {
  const tags: string[] = [];
  const clean = text.replace(TAG, (_, t: string) => { tags.push(t.trim().toLowerCase()); return ''; }).replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  return { clean, tags };
}

/** One sentence from the direction and the tags: "Delivery: tired, whispering; slow pace; sighs." */
export function instructionOf(d: Direction, tags: string[]): string | null {
  const parts: string[] = [];
  if (d.emotion) parts.push(d.emotion);
  if (d.delivery) parts.push(d.delivery);
  if (d.style) parts.push(`${d.style} style`);
  if (d.pace && d.pace !== 'normal') parts.push(`${d.pace} pace`);
  if (d.intensity !== undefined) parts.push(d.intensity >= 0.75 ? 'strongly felt' : d.intensity <= 0.25 ? 'understated' : 'moderately expressive');
  if (d.notes) parts.push(d.notes.replace(/\.+$/, ''));
  if (tags.length) parts.push(`with ${tags.join(', ')}`);
  return parts.length ? parts.join(', ') : null;
}

export function mapDirection(model: Pick<AudioModel, 'direction'>, text: string, directionRaw: unknown): Mapped {
  const d = parseDirection(directionRaw);
  const { clean, tags } = splitTags(String(text ?? ''));
  const speed = d.pace === 'slow' ? 0.85 : d.pace === 'fast' ? 1.15 : null;
  if (model.direction === 'instruct') {
    return { text: clean, instruct: instructionOf(d, tags), exaggeration: null, cfgWeight: null, speed: null, dropped: [] };
  }
  if (model.direction === 'tags') {
    const level = d.intensity ?? EMOTION_LEVEL[(d.emotion ?? '').toLowerCase()] ?? (d.emotion || d.delivery || tags.length ? 0.6 : 0.5);
    const kept = tags.filter((t) => PARALINGUISTIC.has(t));
    const dropped = [...tags.filter((t) => !PARALINGUISTIC.has(t)).map((t) => `tag [${t}]`), ...(d.style ? [`style "${d.style}"`] : []), ...(d.delivery ? [`delivery "${d.delivery}"`] : []), ...(d.notes ? [`notes "${d.notes}"`] : [])];
    // Chatterbox card: lower cfg_weight (about 0.3) for a faster pace, higher for a slower, deliberate one.
    const cfgWeight = d.pace === 'fast' ? 0.3 : d.pace === 'slow' ? 0.7 : 0.5;
    return {
      text: [clean, ...kept.map((t) => `[${t}]`)].join(' ').trim(), instruct: null,
      exaggeration: Math.round(Math.max(0.25, Math.min(1.5, 0.25 + level * 1.0)) * 100) / 100, cfgWeight, speed: null, dropped,
    };
  }
  const dropped = [...tags.map((t) => `tag [${t}]`), ...(instructionOf(d, []) ? ['direction'] : [])];
  return { text: clean, instruct: null, exaggeration: null, cfgWeight: null, speed, dropped };
}
