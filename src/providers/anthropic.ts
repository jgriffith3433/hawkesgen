// Claude, for designing, writing and reviewing (level ideas, art direction,
// lore, barks), with images for vision and a JSON schema for structured
// output. The request shape matches what Dose Of Destruction's map idea and
// review tools already use: streaming, adaptive thinking with an effort level,
// structured output through output_config.format, and server-side refusal
// fallbacks ("default" routing) turned on.

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config.ts';
import { GenError, mimeOf } from '../util.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5'];

/** Dollars per million tokens: input, output, cache read. List prices for usage reports. */
const PRICES: Record<string, [number, number, number]> = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
};

export function costOf(model: string, usage: any) {
  const [inp, out, read] = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  const tokensIn = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) * 1.25;
  return (tokensIn * inp + (usage?.cache_read_input_tokens ?? 0) * read + (usage?.output_tokens ?? 0) * out) / 1e6;
}

let client: Anthropic | null = null;
function anthropic() {
  const key = env('ANTHROPIC_API_KEY');
  if (!key) throw new GenError('ANTHROPIC_API_KEY is not in hawkesgen/.env', { status: 503, kind: 'auth' });
  client ??= new Anthropic({ apiKey: key });
  return client;
}

export const configured = () => Boolean(env('ANTHROPIC_API_KEY'));

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** One request: text (and images) in, text or schema-valid JSON out. */
export async function ask({ prompt, system, images = [], model = DEFAULT_MODEL, effort = 'high', maxTokens = 16000, schema }: {
  prompt: string; system?: string; images?: string[]; model?: string; effort?: string; maxTokens?: number; schema?: Record<string, unknown>;
}, signal?: AbortSignal) {
  const content: any[] = images.map((file) => {
    const mime = mimeOf(file);
    if (!IMAGE_TYPES.has(mime)) throw new GenError(`Claude reads PNG, JPEG, WebP or GIF images, not ${file}`);
    return { type: 'image', source: { type: 'base64', media_type: mime, data: fs.readFileSync(file).toString('base64') } };
  });
  content.push({ type: 'text', text: prompt });
  let response: any;
  try {
    response = await anthropic().beta.messages.stream({
      model,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content }],
    } as any, { signal }).finalMessage();
  } catch (e: any) {
    if (e instanceof Anthropic.AuthenticationError) throw new GenError('The ANTHROPIC_API_KEY in .env was rejected.', { status: 502, kind: 'auth' });
    if (e instanceof Anthropic.RateLimitError) throw new GenError('Claude is rate limited right now; try again in a minute.', { status: 429, kind: 'throttled' });
    if (e instanceof Anthropic.APIError) throw new GenError(`Claude API error ${e.status}: ${e.message}`, { status: 502 });
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new GenError(`Claude declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}.`, { status: 422, kind: 'refusal' });
  if (response.stop_reason === 'max_tokens') throw new GenError('The answer ran out of room before it finished. Raise maxTokens.', { status: 422 });
  const text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  return { text, model: response.model as string, usage: response.usage, cost: costOf(response.model, response.usage) };
}
