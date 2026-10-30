// The house voices: ready-made Gen voices every account can cast (the app's voice lists, the AI, the director), so a
// voice-over never needs ElevenLabs. Each is a voice description and a seed for Qwen3-TTS's voice design. Once
// tools/house-voices.mjs has designed one and saved it to the `shared` project under its id (a reference clip), every
// line clones that clip, so a character sounds the same in every line; until then each line is designed from the
// description and seed.

import { isGenVoiceId, listVoices, type Voice } from './voicelib.ts';

export type HouseVoice = { id: string; name: string; about: string; description: string; seed: number };

export const HOUSE_VOICES: HouseVoice[] = [
  { id: 'hv_narrator_warm', name: 'Morgan', about: 'male, middle-aged, American, warm narrator', description: 'A warm, deep male narrator in his forties with a calm American accent, rich and trustworthy, like a documentary voice-over.', seed: 1101 },
  { id: 'hv_narrator_bright', name: 'Claire', about: 'female, 30s, American, clear narrator', description: 'A clear, friendly female narrator in her thirties with a neutral American accent, bright and articulate, like a polished explainer video.', seed: 1102 },
  { id: 'hv_trailer', name: 'Rex', about: 'male, deep, cinematic trailer voice', description: 'A very deep, gravelly male movie-trailer voice, slow and dramatic, with weight on every word.', seed: 1103 },
  { id: 'hv_young_hero', name: 'Jamie', about: 'young adult, upbeat hero', description: 'An energetic young adult man in his early twenties, upbeat and a little cocky, quick and expressive, like a video game hero.', seed: 1104 },
  { id: 'hv_heroine', name: 'Ava', about: 'female, 20s, confident lead', description: 'A confident young woman in her mid-twenties, determined and warm, with a natural American accent, like the lead of an adventure game.', seed: 1105 },
  { id: 'hv_villain', name: 'Victor', about: 'male, low, menacing villain', description: 'A low, smooth, menacing male villain voice, cold and controlled, speaking slowly with quiet threat and a slight British accent.', seed: 1106 },
  { id: 'hv_elder', name: 'Walter', about: 'male, old, gravelly storyteller', description: 'An old man in his seventies with a gravelly, kind voice, unhurried and wise, like a grandfather telling a story by the fire.', seed: 1107 },
  { id: 'hv_british', name: 'Eleanor', about: 'female, British, elegant', description: 'An elegant British woman in her forties with a crisp Received Pronunciation accent, poised, precise and slightly dry.', seed: 1108 },
  { id: 'hv_kid', name: 'Pip', about: 'child, playful', description: 'A playful, curious child of about ten, high and bright, excited and full of wonder.', seed: 1109 },
  { id: 'hv_ai', name: 'Unit', about: 'calm synthetic assistant', description: 'A calm, even, slightly synthetic assistant voice, gender-neutral, precise and helpful, with smooth clean delivery.', seed: 1110 },
  { id: 'hv_announcer', name: 'Max', about: 'male, loud, hype announcer', description: 'A loud, hyped-up male sports and arena announcer, big energy, punchy and booming.', seed: 1111 },
  { id: 'hv_whisper', name: 'Iris', about: 'female, soft, intimate', description: 'A soft, breathy young woman speaking close to the microphone, gentle and intimate, almost a whisper.', seed: 1112 },
];

export const isHouseVoiceId = (v: unknown) => typeof v === 'string' && /^hv_[a-z0-9_]+$/.test(v);
/** A Gen voice (gv_) or a house voice (hv_): voices the open models speak. Anything else is ElevenLabs'. */
export const isOwnVoiceId = (v: unknown) => isGenVoiceId(v) || isHouseVoiceId(v);
export const houseVoice = (id: string) => HOUSE_VOICES.find((v) => v.id === id) ?? null;

/** The saved reference of a house voice (tools/house-voices.mjs made it), when there is one. */
export function houseReference(id: string): Voice | null {
  try {
    return listVoices({ project: 'shared', status: 'saved' }).find((v) => v.name === id && v.refFile) ?? null;
  } catch {
    return null;
  }
}
