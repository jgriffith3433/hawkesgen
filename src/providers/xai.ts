// Grok 4.7 through xAI's Responses API (https://api.x.ai/v1/responses). Studio's brain setting
// sends writing, review and JSON calls here when the brain is Grok (Claude usage is out, J 2026-10-19).
// The coding agents use the same API from hawkesstudio/bin/grok-agent.mjs. XAI_API_KEY lives in .env
// and, on the server, in the hawkes/gen secret (fetched into the service environment).

import fs from 'node:fs';
import { env } from '../config.ts';
import { GenError, mimeOf } from '../util.ts';

export const GROK_MODEL = 'grok-4.7';
/** Dollars per million tokens under 200k prompt tokens: input, output, cache read. */
const PRICE: [number, number, number] = [2, 6, 0.5];

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

export const configured = () => Boolean(env('XAI_API_KEY'));

/** Claude role aliases and Claude model ids become Grok. An id that already starts with grok- is kept. */
export function modelId(model?: string) {
  const m = (model ?? '').trim();
  if (m.startsWith('grok-')) return m;
  return GROK_MODEL;
}

export function costOf(usage: any) {
  const inn = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const out = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  const cached = Number(usage?.cache_read_input_tokens ?? usage?.cached_tokens ?? 0);
  const [inp, output, read] = PRICE;
  return (Math.max(0, inn - cached) * inp + cached * read + out * output) / 1e6;
}

function textOf(data: any) {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text;
  const parts: string[] = [];
  for (const item of data?.output ?? []) {
    if (item?.type === 'message') {
      for (const c of item.content ?? []) if (typeof c?.text === 'string') parts.push(c.text);
    } else if (typeof item?.text === 'string') parts.push(item.text);
  }
  return parts.join('');
}

type AskParams = { prompt: string; system?: string; images?: string[]; model?: string; effort?: string; maxTokens?: number; schema?: Record<string, unknown> };

/** One request: text (and images) in, text or JSON out. */
export async function ask({ prompt, system, images = [], model, maxTokens = 16000, schema }: AskParams, signal?: AbortSignal): Promise<{ text: string; model: string; usage: any; cost: number; billing: 'xai' }> {
  const key = env('XAI_API_KEY');
  if (!key) throw new GenError('XAI_API_KEY is not set. Add it to hawkesgen/.env and the hawkes/gen secret, then restart Gen.', { status: 503, kind: 'auth' });
  const content: any[] = [];
  for (const file of images) {
    const mime = mimeOf(file);
    if (!IMAGE_TYPES.has(mime)) throw new GenError(`Grok reads PNG or JPEG images, not ${file}`);
    content.push({ type: 'input_image', image_url: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` });
  }
  content.push({ type: 'input_text', text: prompt });
  const used = modelId(model);
  let response: Response;
  try {
    response = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: used,
        instructions: system?.trim() || 'Answer the request directly.',
        input: [{ role: 'user', content }],
        max_output_tokens: maxTokens,
        ...(schema ? { text: { format: { type: 'json_schema', name: 'result', strict: true, schema } } } : {}),
      }),
      signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new GenError('Grok call was cancelled.', { status: 499, kind: 'cancelled' });
    throw new GenError(`Grok call failed: ${e?.message ?? e}`, { status: 502 });
  }
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message ?? data?.error ?? response.statusText;
    const kind = response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'throttled' : undefined;
    throw new GenError(`Grok API error ${response.status}: ${msg}`, { status: response.status === 429 ? 429 : 502, kind });
  }
  const text = textOf(data);
  if (!text.trim()) throw new GenError('Grok returned an empty answer.', { status: 502 });
  const usage = data.usage ?? {};
  return { text, model: data.model ?? used, usage, cost: costOf(usage), billing: 'xai' };
}
