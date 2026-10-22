// Gemini through the Gemini API (generativelanguage.googleapis.com), for what Claude can't do: watch a video with its
// sound. Studio's critic (video.review) sends each cut here so the review hears the voices, sees the lips move and feels
// the timing instead of reading contact sheets. GEMINI_API_KEY is in .env and, on the server, the hawkes/gemini secret
// (/run/hawkes/gemini.env, which hawkes-gen reads).

import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config.ts';
import { GenError, sleep, mimeOf } from '../util.ts';

const API = 'https://generativelanguage.googleapis.com';
/** The newest model that watches video (J's key, 2026-10-22); the fallback when it isn't available to the key. */
export const REVIEW_MODEL = env('GEMINI_REVIEW_MODEL') || 'gemini-4-argon';
export const FALLBACK_MODEL = 'gemini-3.8-flash';
/** Approximate dollars per million tokens (input, output) for the usage ledger; Google's bill is the truth. */
const PRICE: Record<string, [number, number]> = { 'gemini-4-argon': [2.5, 15], 'gemini-3.8-flash': [0.3, 2.5] };

export const configured = () => Boolean(env('GEMINI_API_KEY'));
function key() {
  const k = env('GEMINI_API_KEY');
  if (!k) throw new GenError('GEMINI_API_KEY is not set (hawkesgen/.env; on the server the hawkes/gemini secret)', { status: 503, kind: 'auth' });
  return k;
}

export function costOf(model: string, usage: any) {
  const [i, o] = PRICE[model] ?? PRICE['gemini-4-argon'];
  return (Number(usage?.promptTokenCount ?? 0) * i + (Number(usage?.candidatesTokenCount ?? 0) + Number(usage?.thoughtsTokenCount ?? 0)) * o) / 1e6;
}

async function api(url: string, init: RequestInit, signal?: AbortSignal) {
  for (let tries = 1; ; tries++) {
    const r = await fetch(url, { ...init, headers: { 'x-goog-api-key': key(), ...(init.headers ?? {}) }, signal });
    if (r.ok) return r;
    const text = await r.text();
    // Out of quota (the free tier allows none of some models): no point waiting.
    const quota = r.status === 429 && /quota|limit: 0|billing/i.test(text);
    if (quota) throw new GenError(`Gemini quota: ${text.slice(0, 300)}`, { status: 429, kind: 'quota' });
    // Busy or rate limited: wait and try again a few times.
    if ((r.status === 429 || r.status === 503 || r.status === 500) && tries < 5) {
      await sleep(Math.min(60, 4 * 2 ** tries) * 1000);
      continue;
    }
    throw new GenError(`Gemini ${r.status}: ${text.slice(0, 400)}`, { status: r.status === 429 ? 429 : 502, kind: r.status === 429 ? 'throttled' : r.status === 401 || r.status === 403 ? 'auth' : 'failed' });
  }
}

/**
 * A media file as a part of a request: inline when small, else through the Files API (uploaded, then waited on until
 * Google has processed it). Returns the part.
 */
export async function mediaPart(file: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const mime = mimeOf(file) || 'video/mp4';
  const size = fs.statSync(file).size;
  if (size < 14 * 1024 * 1024) return { inline_data: { mime_type: mime, data: fs.readFileSync(file).toString('base64') } };
  const start = await api(`${API}/upload/v1beta/files`, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: path.basename(file) } }),
  }, signal);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new GenError('Gemini did not give an upload address');
  const done = await api(uploadUrl, { method: 'POST', headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Length': String(size) }, body: fs.readFileSync(file) }, signal);
  let f = (await done.json()).file;
  for (let i = 0; f?.state === 'PROCESSING' && i < 60; i++) {
    await sleep(5000);
    f = await (await api(`${API}/v1beta/${f.name}`, { method: 'GET' }, signal)).json();
  }
  if (f?.state !== 'ACTIVE') throw new GenError(`Gemini couldn't process ${path.basename(file)} (${f?.state ?? 'no file'})`);
  return { file_data: { mime_type: mime, file_uri: f.uri } };
}

/** One generateContent call with JSON out (responseSchema). Falls back to FALLBACK_MODEL when the model isn't there. */
export async function askJson({ parts, schema, model = REVIEW_MODEL, temperature = 0.4 }: { parts: Record<string, unknown>[]; schema: Record<string, unknown>; model?: string; temperature?: number }, signal?: AbortSignal) {
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature } });
  let used = model;
  let r: Response;
  try {
    r = await api(`${API}/v1beta/models/${used}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, signal);
  } catch (e: any) {
    // Not there for this key, or none of it on its tier (no billing): the fallback model.
    if (!/Gemini 404|not found|not supported|Gemini quota/i.test(String(e.message)) || used === FALLBACK_MODEL) throw e;
    used = FALLBACK_MODEL;
    r = await api(`${API}/v1beta/models/${used}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, signal);
  }
  const data = await r.json();
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  if (!text) throw new GenError(`Gemini gave no answer (${data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? 'empty'})`);
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GenError(`Gemini's answer wasn't JSON: ${text.slice(0, 200)}`);
  }
  return { value, model: used, usage: data?.usageMetadata ?? {} };
}
