// Claude, for designing, writing and reviewing (level ideas, art direction,
// lore, barks), with images for vision and a JSON schema for structured
// output. The request shape matches what Dose Of Destruction's map idea and
// review tools already use: streaming, adaptive thinking with an effort level,
// structured output through output_config.format, and server-side refusal
// fallbacks ("default" routing) turned on.
//
// Since 2026-10-18 (J: "Switch to max plan") calls go to Claude Code on J's Max plan by default (claudecode.ts);
// settings.claude.backend "api" brings back the API key path below.

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { env, loadSettings } from '../config.ts';
import * as maxPlan from './claudecode.ts';
import * as cursor from './cursor.ts';
import * as copilot from './copilot.ts';
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

export const backend = () => loadSettings().claude.backend;

/** The API path needs its key; the Max plan path needs only the CLI. Cursor needs CURSOR_API_KEY. */
export const configured = () => { const b = loadSettings().brain; return b === 'cursor' ? cursor.configured() : b === 'copilot' ? copilot.configured() : backend() === 'api' ? Boolean(env('ANTHROPIC_API_KEY')) : true; };

type Billing = 'max-plan' | 'api' | 'xai' | 'cursor' | 'copilot';
/** A call's usage record: "max-plan", "cursor" or "copilot" at $0, "xai" for a direct xAI call, or "anthropic" billed per token. */
export function usageOf(r: { model: string; usage: any; cost: number; billing: Billing }, detail: string = r.model) {
  const provider = r.billing === 'max-plan' ? 'max-plan' : r.billing === 'cursor' ? 'cursor' : r.billing === 'copilot' ? 'copilot' : r.billing === 'xai' ? 'xai' : 'anthropic';
  return { provider, unit: 'tokens', amount: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), cost: r.cost, detail };
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

type AskParams = { prompt: string; system?: string; images?: string[]; model?: string; effort?: string; maxTokens?: number; schema?: Record<string, unknown> };

/** One request: text (and images) in, text or schema-valid JSON out. Grok when settings.brain is grok; otherwise settings.claude.backend. */
export async function ask(p: AskParams, signal?: AbortSignal): Promise<{ text: string; model: string; usage: any; cost: number; billing: Billing }> {
  if (loadSettings().brain === 'cursor') return cursor.ask({ ...p, model: loadSettings().model || p.model }, signal);
  if (loadSettings().brain === 'copilot') return copilot.ask({ ...p, model: loadSettings().model || p.model }, signal);
  if (backend() === 'api') return askApi(p, signal);
  return maxPlan.ask({ ...p, model: p.model ?? DEFAULT_MODEL, effort: p.effort ?? 'high' }, signal);
}

/** The API key path: billed per token. */
async function askApi({ prompt, system, images = [], model = DEFAULT_MODEL, effort = 'high', maxTokens = 16000, schema }: AskParams, signal?: AbortSignal) {
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
  return { text, model: response.model as string, usage: response.usage, cost: costOf(response.model, response.usage), billing: 'api' as const };
}
