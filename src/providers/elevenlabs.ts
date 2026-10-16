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

function call(url: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'xi-api-key': key() };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers.Accept = 'application/octet-stream';
    }
    const req = https.request(url, { method, headers, family: 4, timeout: 120000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('ElevenLabs timed out')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
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
  const detail = detailStatus(r);
  const kind = throttled(r) ? 'throttled' : /quota|credits/.test(detail) || r.status === 402 ? 'quota' : r.status === 401 ? 'auth' : 'failed';
  return new GenError(`ElevenLabs ${r.status}: ${r.buffer.toString('utf8').slice(0, 300)}`, { status: kind === 'throttled' ? 429 : 502, kind });
}

async function callRetry(url: string, opts: { method?: string; body?: unknown }, signal?: AbortSignal) {
  for (let tries = 1; ; tries++) {
    if (signal?.aborted) throw new Error('Cancelled');
    let r: Res;
    try {
      r = await call(url, opts);
    } catch (e) {
      if (tries >= 3) throw e;
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

let voiceCache: { at: number; value: any[] } | null = null;

/** The account's voice library (cached for 10 minutes). */
export async function voices({ force = false } = {}) {
  if (!force && voiceCache && Date.now() - voiceCache.at < 10 * 60 * 1000) return voiceCache.value;
  const r = await call('https://api.elevenlabs.io/v1/voices');
  if (r.status < 200 || r.status >= 300) throw failure(r);
  const value = (JSON.parse(r.buffer.toString('utf8')).voices ?? []).map((v: any) => ({
    id: v.voice_id, name: v.name, category: v.category ?? '', description: v.description ?? '', labels: v.labels ?? {}, preview: v.preview_url ?? '',
  }));
  voiceCache = { at: Date.now(), value };
  return value;
}

export const configured = () => Boolean(env('ELEVENLABS_API_KEY'));
