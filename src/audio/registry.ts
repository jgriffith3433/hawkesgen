// The open audio models Gen can run on the GPU fleet (docs/audio.md). One entry per model: what it does, what it
// weighs, its license (checked on the model's own page; `checked` says when and where), and how the tools reach it.
//
// Nothing here was run on a GPU yet (phase 1: design, wire, price). `adapter: 'verified'` means the runner was run
// against the real package; every entry is 'written' (coded from the package's documented API) or 'planned'. The
// audition (tools/audition.mjs) is what moves a model to settings.audio.verified, which is what `provider: auto` trusts.

export type AudioKind = 'voice' | 'sfx' | 'music' | 'foley';
export type Capability = 'speak' | 'direction' | 'clone' | 'design' | 'dialogue' | 'convert' | 'sfx' | 'loop' | 'foley';

export type AudioModel = {
  id: string;
  title: string;
  kind: AudioKind;
  caps: Capability[];
  /** How the model takes direction (docs/audio.md "Direction"). instruct: a plain sentence; tags: inline tags and numeric knobs; none. */
  direction: 'instruct' | 'tags' | 'none';
  repo: string;
  /** Hugging Face repo(s) of the weights. */
  weights: string[];
  /** Code pin. 'main' until the first install records the commit it got (the READY mark keeps it). */
  ref: string;
  /** pip requirements installed in the model's own venv. */
  pip: string[];
  sizeGb: number;
  vramGb: number;
  license: { code: string; weights: string; commercial: true | false | 'verify'; note: string; checked: string };
  adapter: 'written' | 'planned';
  /** Wall-clock GPU seconds per second of audio made (a guess until the audition measures it) and a fixed load cost. */
  gpuPerAudioSecond: number;
  gpuLoadSeconds: number;
  sampleRate: number;
  languages: string[];
  /** Why it is not selectable, if it is not. */
  blocked?: string;
  /** A model that runs as a ComfyUI workflow (not a venv): that workflow's family. */
  comfy?: string;
};

const CHECKED = '2026-10-25 from the model pages named in `note`; re-check before shipping a product on it';

export const AUDIO_MODELS: AudioModel[] = [
  {
    id: 'moss-tts', title: 'MOSS-TTS v1.5 (1.7B)', kind: 'voice',
    caps: ['speak', 'direction', 'clone', 'design', 'dialogue'], direction: 'instruct',
    repo: 'https://github.com/OpenMOSS/MOSS-TTS', weights: ['OpenMOSS-Team/MOSS-TTS'], ref: 'main',
    pip: ['torch', 'torchaudio', 'transformers', 'soundfile', 'accelerate'],
    sizeGb: 6, vramGb: 12,
    license: { code: 'Apache-2.0', weights: 'Apache-2.0', commercial: true, note: 'OpenMOSS-Team model card and github.com/OpenMOSS/MOSS-TTS; the 4B and 8B variants share the license (8B is about 18 GB, not installed by default)', checked: CHECKED },
    adapter: 'planned', gpuPerAudioSecond: 1.2, gpuLoadSeconds: 60, sampleRate: 24000, languages: ['en', 'zh', 'multi'],
    blocked: 'the runner adapter (post/audio/run.py) is not written; Qwen3-TTS speaks',
  },
  {
    id: 'qwen3-tts', title: 'Qwen3-TTS (1.7B)', kind: 'voice',
    caps: ['speak', 'direction', 'clone', 'design'], direction: 'instruct',
    repo: 'https://github.com/QwenLM/Qwen3-TTS', weights: ['Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'], ref: 'main',
    pip: ['qwen-tts', 'soundfile'],
    sizeGb: 14, vramGb: 10,
    license: { code: 'Apache-2.0', weights: 'Apache-2.0', commercial: true, note: 'Qwen model cards (Apache-2.0). Pins transformers==4.57.3: its own venv, nothing else shares it', checked: CHECKED },
    adapter: 'written', gpuPerAudioSecond: 1.5, gpuLoadSeconds: 45, sampleRate: 24000, languages: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'],
  },
  {
    id: 'voxcpm2', title: 'VoxCPM2 (2B, 48 kHz)', kind: 'voice',
    caps: ['speak', 'direction', 'clone', 'design'], direction: 'instruct',
    repo: 'https://github.com/OpenBMB/VoxCPM', weights: ['openbmb/VoxCPM2'], ref: 'main',
    pip: ['voxcpm', 'soundfile'],
    sizeGb: 5, vramGb: 10,
    license: { code: 'Apache-2.0', weights: 'Apache-2.0', commercial: true, note: 'openbmb/VoxCPM2 model card. Voice design: a parenthesised description in front of the text', checked: CHECKED },
    adapter: 'written', gpuPerAudioSecond: 1.0, gpuLoadSeconds: 40, sampleRate: 48000, languages: ['en', 'zh', 'multi'],
  },
  {
    id: 'chatterbox', title: 'Chatterbox (Resemble AI)', kind: 'voice',
    caps: ['speak', 'direction', 'clone'], direction: 'tags',
    repo: 'https://github.com/resemble-ai/chatterbox', weights: ['ResembleAI/chatterbox'], ref: 'main',
    pip: ['chatterbox-tts', 'soundfile'],
    sizeGb: 4, vramGb: 8,
    license: { code: 'MIT', weights: 'MIT', commercial: true, note: 'resemble-ai/chatterbox LICENSE. Outputs carry Resemble\'s imperceptible Perth watermark', checked: CHECKED },
    adapter: 'written', gpuPerAudioSecond: 0.8, gpuLoadSeconds: 30, sampleRate: 24000, languages: ['en'],
  },
  {
    id: 'moss-soundeffect', title: 'MOSS-SoundEffect v2 (1.3B)', kind: 'sfx',
    caps: ['sfx', 'loop'], direction: 'none',
    repo: 'https://github.com/OpenMOSS/MOSS-TTS', weights: ['OpenMOSS-Team/MOSS-SoundEffect'], ref: 'main',
    pip: ['torch', 'torchaudio', 'transformers', 'soundfile', 'accelerate'],
    sizeGb: 5, vramGb: 10,
    license: { code: 'Apache-2.0', weights: 'verify', commercial: 'verify', note: 'The MOSS family is Apache-2.0; the v2 sound-effect card was not confirmed. Verify before it is used for a shipped product', checked: CHECKED },
    adapter: 'planned', gpuPerAudioSecond: 1.0, gpuLoadSeconds: 40, sampleRate: 24000, languages: ['en'],
    blocked: 'the runner adapter (post/audio/run.py) is not written; sound effects run on Stable Audio 3',
  },
  {
    id: 'stable-audio-3', title: 'Stable Audio 3 Medium (ComfyUI)', kind: 'sfx',
    caps: ['sfx', 'loop'], direction: 'none',
    repo: 'https://github.com/Stability-AI/stable-audio-3', weights: ['Comfy-Org/stable-audio-3'], ref: 'workflows/audio-sfx-sa3',
    pip: [],
    sizeGb: 9.7, vramGb: 12,
    license: { code: 'Stability AI Community License', weights: 'Stability AI Community License', commercial: true, note: 'Free for commercial use under US$1M annual revenue, enterprise license above that. ComfyUI\'s own template (audio_stable_audio_3_medium) without its Qwen prompt rewrite: workflows/audio-sfx-sa3', checked: CHECKED },
    adapter: 'written', gpuPerAudioSecond: 0.3, gpuLoadSeconds: 20, sampleRate: 44100, languages: ['en'],
    comfy: 'stable-audio',
  },
  {
    id: 'mmaudio', title: 'MMAudio (video to foley)', kind: 'foley',
    caps: ['foley'], direction: 'none',
    repo: 'https://github.com/hkchengrex/MMAudio', weights: ['hkchengrex/MMAudio'], ref: 'main',
    pip: [], sizeGb: 4, vramGb: 12,
    license: { code: 'MIT', weights: 'verify', commercial: 'verify', note: 'Code is MIT; the weights\' terms were not confirmed (some releases are non-commercial). Optional, not wired', checked: CHECKED },
    adapter: 'planned', gpuPerAudioSecond: 1, gpuLoadSeconds: 40, sampleRate: 44100, languages: [],
    blocked: 'optional video-to-foley: weights license unverified, left for a later phase',
  },
  {
    id: 'ace-step-1.5-xl', title: 'ACE-Step 1.5 XL (music)', kind: 'music',
    caps: ['loop'], direction: 'none',
    repo: 'https://github.com/ace-step/ACE-Step-1.5', weights: ['Comfy-Org/ace_step_1.5_ComfyUI_files'], ref: 'workflows/audio-music',
    pip: [], sizeGb: 12, vramGb: 20,
    license: { code: 'MIT', weights: 'MIT', commercial: true, note: 'Already installed as the audio.music workflow', checked: CHECKED },
    adapter: 'written', gpuPerAudioSecond: 0.5, gpuLoadSeconds: 60, sampleRate: 48000, languages: ['multi'],
  },
  {
    id: 'minimax-music-3', title: 'MiniMax Music 3', kind: 'music',
    caps: [], direction: 'none', repo: '', weights: [], ref: '', pip: [], sizeGb: 0, vramGb: 0,
    license: { code: 'API partner node', weights: 'hosted', commercial: 'verify', note: 'License sources conflict (open weights vs hosted API terms). To be read on the provider page before any use', checked: CHECKED },
    adapter: 'planned', gpuPerAudioSecond: 0, gpuLoadSeconds: 0, sampleRate: 44100, languages: [],
    blocked: 'evaluation only: license sources conflict, nothing wired',
  },
  {
    id: 'fish-audio-drama', title: 'Fish Audio Drama 3', kind: 'voice',
    caps: [], direction: 'instruct', repo: '', weights: [], ref: '', pip: [], sizeGb: 70, vramGb: 80,
    license: { code: 'unchecked', weights: 'unchecked', commercial: 'verify', note: 'Earlier Fish Speech / S1 weights were non-commercial; 35B MoE does not fit the fleet\'s L40S / T4 servers anyway', checked: CHECKED },
    adapter: 'planned', gpuPerAudioSecond: 0, gpuLoadSeconds: 0, sampleRate: 44100, languages: [],
    blocked: 'too heavy for the fleet and commercial terms unchecked',
  },
];

/** Models the tools never select: non-commercial licenses, recorded so nobody adds them by mistake. */
export const REFUSED_MODELS = [
  { id: 'f5-tts', why: 'F5-TTS weights are CC-BY-NC' },
  { id: 'fish-speech', why: 'Fish Speech / OpenAudio S1 weights are non-commercial' },
  { id: 'xtts-v2', why: 'XTTS v2 is under the Coqui Public Model License (non-commercial)' },
];

export const modelById = (id: string) => AUDIO_MODELS.find((m) => m.id === id) ?? null;

/** Models a tool may run: not blocked, not non-commercial, has the capability. A 'verify' license is selectable but the result carries the warning (licenseNote). */
export function selectable(kind: AudioKind, cap: Capability): AudioModel[] {
  return AUDIO_MODELS.filter((m) => m.kind === kind && m.caps.includes(cap) && !m.blocked && m.license.commercial !== false);
}

/** The model id list for a param's `values`. */
export const voiceModels = () => selectable('voice', 'speak').map((m) => m.id);
export const sfxModels = () => selectable('sfx', 'sfx').map((m) => m.id);
