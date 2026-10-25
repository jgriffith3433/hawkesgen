// ElevenLabs: voice lines, sound effects and the voice library. One client
// for every project (Sick Of It, PH Origins and Dose Of Destruction each had
// their own). Throttle handling follows DoD's devApi.mjs: 429 is either "too
// many at once" (wait and retry) or "out of credits" (stop); the detail
// status tells them apart. Requests go over IPv4 (family 4), as DoD found the
// API more reliable that way.

import https from 'node:https';
import { env } from '../config.ts';
import { GenError, sleep } from '../util.ts';

type Res = { status: number; headers: Record<string, any>; buffer: Buffer };

function key() {
  const k = env('ELEVENLABS_API_KEY');
  if (!k) throw new GenError('ELEVENLABS_API_KEY is not in hawkesgen/.env', { status: 503, kind: 'auth' });
  return k;
}

/** A file and fields for a multipart/form-data request (speech-to-speech, audio isolation). */
export type Form = { fields?: Record<string, string>; file: { field: string; name: string; type: string; data: Buffer } };
function multipart(form: Form) {
  const boundary = `----hawkesgen${Date.now().toString(16)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(form.fields ?? {})) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${form.file.field}"; filename="${form.file.name}"\r\nContent-Type: ${form.file.type}\r\n\r\n`), form.file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { type: `multipart/form-data; boundary=${boundary}`, data: Buffer.concat(parts) };
}

// Billing block: a 401 payment_issue / payment_required (or 402) means an unpaid invoice. Retrying cannot help, so for
// 30 minutes every ElevenLabs call fails at once without reaching ElevenLabs. After that one call goes through as the
// probe: success clears the block, a payment failure renews it. In memory: a restart starts clean (and probes once).
export const BILLING_BLOCK_MS = 30 * 60 * 1000;
export const BILLING_MESSAGE = 'ElevenLabs is blocked by an unpaid invoice; J must pay it. Do not retry. To continue without it, use the open suite (the default): clone that character\'s existing recording with audio.voice-clone (reference: the clip, referenceText: what it says) and speak with audio.voice voice: gv_..., or design a new voice with audio.voice-design and keep it with audio.voice-save. audio.sfx and audio.music run open too.';
let billing: { since: number; until: number; detail: string; probing: boolean } | null = null;
let clock = () => Date.now();
/** Tests only: a fake clock, and a way to forget the block. */
export function _testReset(now?: () => number) {
  billing = null;
  clock = now ?? (() => Date.now());
}
export function billingState() {
  if (!billing) return { blocked: false as const };
  return { blocked: true as const, since: billing.since, until: billing.until, probeDue: clock() >= billing.until, detail: billing.detail, message: BILLING_MESSAGE };
}
const paymentFailure = (r: Res) => {
  if (r.status === 402) return true;
  if (r.status !== 401) return false;
  return /payment_issue|payment_required/.test(detailStatus(r) + r.buffer.toString('utf8').slice(0, 500));
};
function billingGate() {
  if (!billing) return false;
  if (clock() < billing.until || billing.probing) throw new GenError(BILLING_MESSAGE, { status: 402, kind: 'billing' });
  billing.probing = true;
  return true;
}

async function call(url: string, opts: { method?: string; body?: unknown; form?: Form } = {}): Promise<Res> {
  const probe = billingGate();
  try {
    const r = await rawCall(url, opts);
    if (paymentFailure(r)) {
      const now = clock();
      billing = { since: billing?.since ?? now, until: now + BILLING_BLOCK_MS, detail: `${r.status}: ${r.buffer.toString('utf8').slice(0, 200)}`, probing: false };
    } else if (probe && r.status < 500) billing = null;
    else if (probe && billing) billing.probing = false;
    return r;
  } catch (e) {
    if (probe && billing) billing.probing = false;
    throw e;
  }
}

function rawCall(url: string, { method = 'GET', body, form }: { method?: string; body?: unknown; form?: Form } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'xi-api-key': key() };
    const mp = form ? multipart(form) : null;
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers.Accept = 'application/octet-stream';
    }
    if (mp) {
      headers['Content-Type'] = mp.type;
      headers['Content-Length'] = String(mp.data.length);
    }
    const req = https.request(url, { method, headers, family: 4, timeout: 120000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('ElevenLabs timed out')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    if (mp) req.write(mp.data);
    req.end();
  });
}

const ok = (r: Res) => r.status >= 200 && r.status < 300 && r.buffer[0] !== 0x7b;
const detailStatus = (r: Res) => {
  try {
    return String(JSON.parse(r.buffer.toString('utf8'))?.detail?.status ?? '');
  } catch {
    return '';
  }
};
const throttled = (r: Res) => r.status === 503 || (r.status === 429 && !/quota/.test(detailStatus(r))) || /too_many_concurrent|rate_limit|system_busy/.test(detailStatus(r));
const retryAfter = (r: Res, tries: number) => {
  const s = Number(r.headers?.['retry-after']);
  return Number.isFinite(s) && s > 0 ? Math.min(60, s) : Math.min(30, 2 ** tries);
};
function failure(r: Res) {
  if (paymentFailure(r)) return new GenError(`${BILLING_MESSAGE} (ElevenLabs ${r.status})`, { status: 402, kind: 'billing' });
  const detail = detailStatus(r);
  const kind = throttled(r) ? 'throttled' : /quota|credits/.test(detail) || r.status === 402 ? 'quota' : r.status === 401 ? 'auth' : 'failed';
  return new GenError(`ElevenLabs ${r.status}: ${r.buffer.toString('utf8').slice(0, 300)}`, { status: kind === 'throttled' ? 429 : 502, kind });
}

async function callRetry(url: string, opts: { method?: string; body?: unknown; form?: Form }, signal?: AbortSignal) {
  for (let tries = 1; ; tries++) {
    if (signal?.aborted) throw new Error('Cancelled');
    let r: Res;
    try {
      r = await call(url, opts);
    } catch (e) {
      if (tries >= 3 || (e instanceof GenError && e.kind === 'billing')) throw e;
      await sleep(2000 * tries);
      continue;
    }
    if (!throttled(r)) return r;
    if (tries >= 5) throw failure(r);
    await sleep(retryAfter(r, tries) * 1000);
  }
}

export async function speak({ text, voice, model = 'eleven_v4', format = 'mp3_44100_128', settings }: { text: string; voice: string; model?: string; format?: string; settings?: Record<string, unknown> }, signal?: AbortSignal) {
  if (!/^[A-Za-z0-9]{8,40}$/.test(voice)) throw new GenError('voice must be an ElevenLabs voice id');
  const r = await callRetry(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=${encodeURIComponent(format)}`, {
    method: 'POST',
    body: { text, model_id: model, ...(settings ? { voice_settings: settings } : {}) },
  }, signal);
  if (!ok(r)) throw failure(r);
  return r.buffer;
}

/**
 * Text to Dialogue (eleven_v3): a whole conversation voiced in one generation, so the speakers take turns, react and
 * interrupt like people instead of lines read one by one. lines: [{ text, voice }] in order (at most 10 voices; keep
 * the text under about 2,000 characters). Returns the audio and when each line starts and ends.
 */
export async function dialogue({ lines, model = 'eleven_v3', format = 'mp3_44100_128', seed, settings }: { lines: { text: string; voice: string }[]; model?: string; format?: string; seed?: number; settings?: Record<string, unknown> }, signal?: AbortSignal) {
  if (!lines.length) throw new GenError('lines is empty');
  for (const l of lines) if (!/^[A-Za-z0-9]{8,40}$/.test(l.voice)) throw new GenError(`"${l.voice}" is not an ElevenLabs voice id`);
  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  if (chars > 3000) throw new GenError(`${chars} characters is too long for one dialogue (keep it under about 2,000): split the scene`);
  const r = await callRetry(`https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps?output_format=${encodeURIComponent(format)}`, {
    method: 'POST',
    body: { inputs: lines.map((l) => ({ text: l.text, voice_id: l.voice })), model_id: model, ...(seed !== undefined ? { seed } : {}), ...(settings ? { settings } : {}) },
  }, signal);
  if (r.status < 200 || r.status >= 300) throw failure(r);
  const json = JSON.parse(r.buffer.toString('utf8'));
  const audio = Buffer.from(json.audio_base64 ?? json.audio_base_64 ?? '', 'base64');
  if (!audio.length) throw new GenError('ElevenLabs returned no dialogue audio');
  const segments = (json.voice_segments ?? []).map((s: any) => ({
    line: Number(s.dialogue_input_index ?? s.input_index ?? 0), voice: String(s.voice_id ?? ''),
    start: Number(s.start_time_seconds ?? 0), end: Number(s.end_time_seconds ?? 0),
  }));
  return { audio, segments, chars };
}

/**
 * Speech to Speech (voice changer): the same performance, timing and emotion in another voice. For putting a cast
 * character's voice on a delivery that was acted (J on a phone, a model that voiced the scene itself) without moving a
 * syllable, so lips stay on it.
 */
export async function voiceChange({ audio, name = 'performance.mp3', type = 'audio/mpeg', voice, model = 'eleven_multilingual_sts_v2', format = 'mp3_44100_128', removeNoise = true, settings }: { audio: Buffer; name?: string; type?: string; voice: string; model?: string; format?: string; removeNoise?: boolean; settings?: Record<string, unknown> }, signal?: AbortSignal) {
  if (!/^[A-Za-z0-9]{8,40}$/.test(voice)) throw new GenError('voice must be an ElevenLabs voice id');
  const fields: Record<string, string> = { model_id: model, remove_background_noise: String(removeNoise) };
  if (settings) fields.voice_settings = JSON.stringify(settings);
  const r = await callRetry(`https://api.elevenlabs.io/v1/speech-to-speech/${voice}?output_format=${encodeURIComponent(format)}`, { method: 'POST', form: { fields, file: { field: 'audio', name, type, data: audio } } }, signal);
  if (!ok(r)) throw failure(r);
  return r.buffer;
}

/** Audio isolation: the voices from a recording, without the room, music or effects under them. */
export async function isolateVoice({ audio, name = 'mix.mp3', type = 'audio/mpeg' }: { audio: Buffer; name?: string; type?: string }, signal?: AbortSignal) {
  const r = await callRetry('https://api.elevenlabs.io/v1/audio-isolation', { method: 'POST', form: { file: { field: 'audio', name, type, data: audio } } }, signal);
  if (!ok(r)) throw failure(r);
  return r.buffer;
}

export async function soundEffect({ text, duration, loop = false, influence = 0.55, model = 'eleven_text_to_sound_v2', format = 'mp3_44100_128' }: { text: string; duration?: number; loop?: boolean; influence?: number; model?: string; format?: string }, signal?: AbortSignal) {
  const body: Record<string, unknown> = { text, model_id: model, prompt_influence: Math.max(0, Math.min(1, influence)), loop };
  if (duration) body.duration_seconds = Math.max(0.5, Math.min(30, duration));
  const r = await callRetry(`https://api.elevenlabs.io/v1/sound-generation?output_format=${encodeURIComponent(format)}`, { method: 'POST', body }, signal);
  if (!ok(r)) throw failure(r);
  return r.buffer;
}

/** Voice Design: a few candidate voices for a description, each with preview audio. Nothing is saved to the account. */
export async function designVoice({ description, text, model = 'eleven_ttv_v3' }: { description: string; text?: string; model?: string }, signal?: AbortSignal) {
  const body: Record<string, unknown> = { voice_description: description, model_id: model };
  const sample = (text ?? '').trim();
  if (sample.length >= 100) body.text = sample.slice(0, 1000);
  else body.auto_generate_text = true;
  const r = await callRetry('https://api.elevenlabs.io/v1/text-to-voice/design?output_format=mp3_44100_128', { method: 'POST', body }, signal);
  if (r.status < 200 || r.status >= 300) throw failure(r);
  const json = JSON.parse(r.buffer.toString('utf8'));
  return {
    text: String(json.text ?? sample),
    previews: (json.previews ?? []).map((p: any) => ({ generatedVoiceId: String(p.generated_voice_id), audio: Buffer.from(p.audio_base_64 ?? '', 'base64') })),
  };
}

/** Saves a Voice Design candidate to the account's voice library. Returns the new voice id. */
export async function saveDesignedVoice({ name, description, generatedVoiceId }: { name: string; description: string; generatedVoiceId: string }, signal?: AbortSignal) {
  const r = await callRetry('https://api.elevenlabs.io/v1/text-to-voice', {
    method: 'POST',
    body: { voice_name: name, voice_description: description, generated_voice_id: generatedVoiceId },
  }, signal);
  if (r.status < 200 || r.status >= 300) throw failure(r);
  voiceCache = null;
  const voiceId = JSON.parse(r.buffer.toString('utf8')).voice_id;
  if (!voiceId) throw new GenError('ElevenLabs did not return a voice id');
  return String(voiceId);
}

/** Deletes a saved voice from the account's voice library (frees a slot). */
export async function deleteVoice(voiceId: string, signal?: AbortSignal) {
  if (!/^[A-Za-z0-9]{8,40}$/.test(voiceId)) throw new GenError('voiceId must be an ElevenLabs voice id');
  const r = await callRetry(`https://api.elevenlabs.io/v1/voices/${voiceId}`, { method: 'DELETE' }, signal);
  if (r.status < 200 || r.status >= 300) throw failure(r);
  voiceCache = null;
}

let voiceCache: { at: number; value: any[] } | null = null;

/** The account's voice library (cached for 10 minutes). */
export async function voices({ force = false } = {}) {
  if (!force && voiceCache && Date.now() - voiceCache.at < 10 * 60 * 1000) return voiceCache.value;
  const r = await call('https://api.elevenlabs.io/v1/voices');
  if (r.status < 200 || r.status >= 300) throw failure(r);
  const value = (JSON.parse(r.buffer.toString('utf8')).voices ?? []).map((v: any) => ({
    id: v.voice_id, name: v.name, category: v.category ?? '', description: v.description ?? '', labels: v.labels ?? {}, preview: v.preview_url ?? '', created: Number(v.created_at_unix) > 0 ? Number(v.created_at_unix) * 1000 : null,
  }));
  voiceCache = { at: Date.now(), value };
  return value;
}

export const configured = () => Boolean(env('ELEVENLABS_API_KEY'));
