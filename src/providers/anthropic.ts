// Claude, for designing, writing and reviewing (level ideas, art direction,
// lore, barks), with images for vision and a JSON schema for structured
// output. The request shape matches what Dose Of Destruction's map idea and
// review tools already use: streaming, adaptive thinking with an effort level,
// structured output through output_config.format, and server-side refusal
// fallbacks ("default" routing) turned on.
//
// Since 2026-10-18 (J: "Switch to max plan") calls go to Claude Code on J's Max plan by default (claudecode.ts);
// settings.claude.backend "api" brings back the API key path below, "bedrock" uses AWS Bedrock.

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { env, loadSettings } from '../config.ts';
import * as maxPlan from './claudecode.ts';
import { houseRoute, houseCanFallBack } from '../houseai.ts';
import * as cursor from './cursor.ts';
import * as copilot from './copilot.ts';
import * as bedrock from './bedrock.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { orgSecret } from '../orgsecrets.ts';
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
const orgClients = new Map<string, Anthropic>();
/** Gen's own API client, or (`apiKey`) one for an org's own key (orgsecrets.ts), kept per key. */
function anthropic(apiKey?: string) {
  if (apiKey) {
    let c = orgClients.get(apiKey);
    if (!c) {
      if (orgClients.size > 200) orgClients.clear();
      c = new Anthropic({ apiKey });
      orgClients.set(apiKey, c);
    }
    return c;
  }
  const key = env('ANTHROPIC_API_KEY');
  if (!key) throw new GenError('ANTHROPIC_API_KEY is not in hawkesgen/.env', { status: 503, kind: 'auth' });
  client ??= new Anthropic({ apiKey: key });
  return client;
}

export const backend = () => loadSettings().claude.backend;

/** Who a job's Claude calls are for (src/jobs.ts sets it around every tool run): a customer's run on its org's own key or
 *  subscription only (ask() below), never Gen's key, J's Max plan, Cursor or Copilot. `house`: a Gen app account, whose
 *  calls without its own access run on the house AI the owner set in /admin (src/houseai.ts). */
export const callScope = new AsyncLocalStorage<{ customer: boolean; org?: string | null; house?: boolean }>();
/** Whether the running job is a customer's (whatever the Claude setting). */
export const customerJob = () => callScope.getStore()?.customer === true;

/** The API path needs its key; the Max plan path needs only the CLI. Cursor needs CURSOR_API_KEY. Bedrock needs AWS creds. */
export const configured = () => {
  const b = loadSettings().brain;
  return b === 'cursor' ? cursor.configured()
    : b === 'copilot' ? copilot.configured()
    : backend() === 'api' ? Boolean(env('ANTHROPIC_API_KEY'))
    : backend() === 'bedrock' ? bedrock.configured()
    : true;
};

type Billing = 'max-plan' | 'api' | 'bedrock' | 'xai' | 'cursor' | 'copilot' | 'byok' | 'subscription';
/** A call's usage record: "max-plan", "cursor" or "copilot" at $0, "xai" for a direct xAI call, "bedrock" for AWS Bedrock, or "anthropic" billed per token. */
export function usageOf(r: { model: string; usage: any; cost: number; billing: Billing }, detail: string = r.model) {
  // byok: the org's own Anthropic key (Anthropic bills them); subscription: the org's own Claude plan ($0 to us).
  const provider = r.billing === 'max-plan' ? 'max-plan' : r.billing === 'cursor' ? 'cursor' : r.billing === 'copilot' ? 'copilot' : r.billing === 'xai' ? 'xai' : r.billing === 'bedrock' ? 'bedrock' : r.billing === 'byok' ? 'anthropic-byok' : r.billing === 'subscription' ? 'claude-subscription' : 'anthropic';
  return { provider, unit: 'tokens', amount: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), cost: r.cost, detail };
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

type AskParams = {
  prompt: string; system?: string; images?: string[]; model?: string; effort?: string; maxTokens?: number; schema?: Record<string, unknown>;
  /** The answer's text so far, each time more arrives (the API and Max plan paths; the others call it once at the end). */
  onText?: (soFar: string) => void;
};

/** One request: text (and images) in, text or schema-valid JSON out. Routes by settings.brain and settings.claude.backend. */
export async function ask(p: AskParams, signal?: AbortSignal): Promise<{ text: string; model: string; usage: any; cost: number; billing: Billing }> {
  // A customer's job never runs on our key or J's plan (J, 2026-10-29: "they can use their own key or log into claude
  // and use their subscription (not our key/plan)"): its org's own Anthropic API key, else its own Claude subscription
  // (orgsecrets.ts), else it's refused with what to do.
  const scope = callScope.getStore();
  const org = scope?.org ?? null;
  const ownKey = org ? orgSecret(org, 'anthropic') : null;
  if (ownKey) {
    const r = await askApi(p, signal, ownKey);
    return { ...(p.schema ? { ...r, text: maxPlan.extractJson(r.text) } : r), billing: 'byok' as const };
  }
  const ownSub = org ? orgSecret(org, 'claude-subscription') : null;
  if (ownSub) return maxPlan.ask({ ...p, model: p.model ?? DEFAULT_MODEL, effort: p.effort ?? 'high' }, signal, { token: ownSub });
  if (scope?.customer && scope.house) {
    // A Gen app account: the house AI (J, 2026-10-29: "users don't have to deal with this and it just works").
    const route = houseRoute();
    if (route.via === 'api') {
      try {
        const r = await askApi(p, signal, route.key, 'house');
        return p.schema ? { ...r, text: maxPlan.extractJson(r.text) } : r;
      } catch (e: any) {
        // "auto": a key that fails (rejected, out of credit) falls back to Gen's Claude login when there is one.
        if (e?.kind !== 'auth' || !houseCanFallBack()) throw e;
      }
    }
    if (route.via === 'api' || route.via === 'claude') return maxPlan.ask({ ...p, model: p.model ?? DEFAULT_MODEL, effort: p.effort ?? 'high' }, signal);
    throw new GenError(route.why, { status: 503 });
  }
  if (scope?.customer) {
    throw new GenError('Claude needs your own access: add your Anthropic API key, or sign in with your Claude subscription, in your hawkesgen.ai settings.', { status: 402, kind: 'auth' });
  }
  const brain = loadSettings().brain;
  if (brain === 'cursor' || brain === 'copilot') {
    const { onText, ...q } = p;
    const r = await (brain === 'cursor' ? cursor : copilot).ask({ ...q, model: loadSettings().model || p.model }, signal);
    onText?.(r.text);
    return p.schema ? { ...r, text: maxPlan.answerText({ result: r.text }, p.schema) } : r;
  }
  const back = backend();
  if (back === 'bedrock') {
    const { onText, ...q } = p;
    const r = await bedrock.ask(q, signal);
    onText?.(r.text);
    return p.schema ? { ...r, text: bedrock.extractJson(r.text) } : r;
  }
  if (back === 'api') {
    const r = await askApi(p, signal);
    return p.schema ? { ...r, text: maxPlan.extractJson(r.text) } : r;
  }
  return maxPlan.ask({ ...p, model: p.model ?? DEFAULT_MODEL, effort: p.effort ?? 'high' }, signal);
}

/** The API key path: billed per token. */
/** True when every object in a JSON schema says `additionalProperties: false`, which structured output requires. */
export function isClosedSchema(s: unknown): boolean {
  if (Array.isArray(s)) return s.every(isClosedSchema);
  if (!s || typeof s !== 'object') return true;
  const o = s as Record<string, unknown>;
  const isObject = o.type === 'object' || (Array.isArray(o.type) && o.type.includes('object'));
  if (isObject && o.additionalProperties !== false) return false;
  return Object.entries(o).every(([k, v]) => k === 'enum' || k === 'const' || k === 'default' || isClosedSchema(v));
}

async function askApi({ prompt, system, images = [], model = DEFAULT_MODEL, effort = 'high', maxTokens = 16000, schema, onText }: AskParams, signal?: AbortSignal, apiKey?: string, whose: 'org' | 'house' = 'org') {
  const content: any[] = images.map((file) => {
    const mime = mimeOf(file);
    if (!IMAGE_TYPES.has(mime)) throw new GenError(`Claude reads PNG, JPEG, WebP or GIF images, not ${file}`);
    return { type: 'image', source: { type: 'base64', media_type: mime, data: fs.readFileSync(file).toString('base64') } };
  });
  content.push({ type: 'text', text: prompt });
  let response: any;
  try {
    const stream = anthropic(apiKey).beta.messages.stream({
      model,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // Structured output only takes closed schemas; an open one (the assistants' free-form ops, shots and docs) is left to
      // the prompt's "JSON only" and the callers' tolerant parsers instead of being refused with a 400.
      output_config: { effort, ...(schema && isClosedSchema(schema) ? { format: { type: 'json_schema', schema } } : {}) },
      // The system prompt is cached: callers like the portal's Overseer send the same long guide with every message.
      ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
      messages: [{ role: 'user', content }],
    } as any, { signal });
    if (onText) {
      let soFar = '';
      onText('');
      stream.on('text', (delta: string) => { soFar += delta; try { onText(soFar); } catch { /* the listener's problem */ } });
    }
    response = await stream.finalMessage();
  } catch (e: any) {
    // The house key failing (rejected, out of credit) is the owner's to fix, not the person's: they get a plain line, the
    // log gets the reason, and the house AI may fall back to a Claude login (ask()).
    if (whose === 'house' && (e instanceof Anthropic.AuthenticationError || (e instanceof Anthropic.APIError && [400, 401, 402, 403].includes(Number(e.status))))) {
      console.error(`[houseai] the house Anthropic API key failed (fix it in /admin > AI): ${e.message}`);
      throw new GenError("The AI isn't available right now. Please try again later.", { status: 503, kind: 'auth' });
    }
    if (e instanceof Anthropic.AuthenticationError) throw new GenError(!apiKey ? 'The ANTHROPIC_API_KEY in .env was rejected.' : whose === 'house' ? "The AI isn't available right now. Please try again later." : "Your org's Anthropic API key was rejected: replace it in your hawkesgen.ai settings.", { status: 502, kind: 'auth' });
    if (e instanceof Anthropic.RateLimitError) throw new GenError('Claude is rate limited right now; try again in a minute.', { status: 429, kind: 'throttled' });
    if (e instanceof Anthropic.APIError) throw new GenError(`Claude API error ${e.status}: ${e.message}`, { status: 502 });
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new GenError(`Claude declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}.`, { status: 422, kind: 'refusal' });
  if (response.stop_reason === 'max_tokens') throw new GenError('The answer ran out of room before it finished. Raise maxTokens.', { status: 422 });
  const text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  return { text, model: response.model as string, usage: response.usage, cost: costOf(response.model, response.usage), billing: 'api' as const };
}
