// AWS Bedrock provider for Claude models: a fallback when the direct Anthropic API hits billing/credit limits.
//
// Bedrock provides Claude models through AWS APIs. Pricing is often lower than direct API, and it uses AWS
// credentials instead of an Anthropic API key. Models are named "anthropic.claude-*".

import fs from 'node:fs';
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { env } from '../config.ts';
import { GenError, mimeOf } from '../util.ts';
import { outputBudget, TOO_LONG } from './budget.ts';

// Map Claude model names to Bedrock model IDs
const MODEL_MAP: Record<string, string> = {
  'claude-opus-5-5': 'anthropic.claude-3-opus-20240229-v1:0', // Opus 3 until 5.5 is on Bedrock
  'claude-opus-5': 'anthropic.claude-3-opus-20240229-v1:0',
  'claude-sonnet-5-5': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'claude-haiku-5-5': 'anthropic.claude-3-5-haiku-20241022-v1:0',
  'claude-fable-5-1': 'anthropic.claude-3-5-haiku-20241022-v1:0', // Fable not on Bedrock, use Haiku
};

/** Bedrock pricing per million tokens: input, output. Cache reads are same as input on Bedrock. */
const BEDROCK_PRICES: Record<string, [number, number]> = {
  'anthropic.claude-3-opus-20240229-v1:0': [15, 75],
  'anthropic.claude-3-5-sonnet-20241022-v2:0': [3, 15],
  'anthropic.claude-3-5-haiku-20241022-v1:0': [0.8, 4],
};

export function costOf(modelId: string, usage: any) {
  const [inp, out] = BEDROCK_PRICES[modelId] ?? [3, 15];
  const tokensIn = (usage?.input_tokens ?? 0);
  return (tokensIn * inp + (usage?.output_tokens ?? 0) * out) / 1e6;
}

let client: BedrockRuntimeClient | null = null;

function bedrock() {
  // Use explicit credentials if provided, else fall back to AWS SDK's default chain (instance role, etc)
  const key = env('AWS_BEDROCK_KEY') || env('AWS_ACCESS_KEY_ID');
  const secret = env('AWS_BEDROCK_SECRET') || env('AWS_SECRET_ACCESS_KEY');
  const region = env('AWS_BEDROCK_REGION') || env('AWS_DEFAULT_REGION') || 'us-east-1';

  if (!key || !secret) {
    throw new GenError('AWS_BEDROCK_KEY and AWS_BEDROCK_SECRET (or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) are needed in .env', { status: 503, kind: 'auth' });
  }

  client ??= new BedrockRuntimeClient({
    region,
    credentials: { accessKeyId: key, secretAccessKey: secret },
  });
  return client;
}

export const configured = () => {
  const key = env('AWS_BEDROCK_KEY') || env('AWS_ACCESS_KEY_ID');
  const secret = env('AWS_BEDROCK_SECRET') || env('AWS_SECRET_ACCESS_KEY');
  return Boolean(key && secret);
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

type AskParams = {
  prompt: string;
  system?: string;
  images?: string[];
  model?: string;
  effort?: string;
  maxTokens?: number;
  schema?: Record<string, unknown>;
};

type AskResult = {
  text: string;
  model: string;
  usage: any;
  cost: number;
  billing: 'bedrock';
};

/** Claude on AWS Bedrock: same interface as anthropic.ts ask(). */
export async function ask(p: AskParams, signal?: AbortSignal): Promise<AskResult> {
  const model = p.model ?? 'claude-sonnet-5-5';
  const bedrockModelId = MODEL_MAP[model] ?? MODEL_MAP['claude-sonnet-5-5'];
  const maxTokens = outputBudget(p.maxTokens, false);

  // Build Anthropic-formatted request body (Bedrock uses Anthropic's message format)
  const content: any[] = [];

  // Add images first
  if (p.images?.length) {
    for (const file of p.images) {
      const mime = mimeOf(file);
      if (!IMAGE_TYPES.has(mime)) throw new GenError(`Claude reads PNG, JPEG, WebP or GIF images, not ${file}`);
      const data = fs.readFileSync(file).toString('base64');
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data },
      });
    }
  }

  // Add text prompt
  content.push({ type: 'text', text: p.prompt });

  const body: any = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };

  if (p.system) body.system = p.system;

  // Bedrock doesn't support effort or server-side fallbacks like the Anthropic API
  // For JSON schema, we'll add it to the system prompt
  if (p.schema) {
    const schemaPrompt = `\n\nYou must respond with valid JSON matching this schema:\n${JSON.stringify(p.schema, null, 2)}`;
    body.system = (body.system || '') + schemaPrompt;
  }

  try {
    // Non-streaming call (Bedrock streaming is complex and Studio doesn't need it)
    const command = new InvokeModelCommand({
      modelId: bedrockModelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    });

    const response = await bedrock().send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    // Bedrock returns Anthropic-format response
    if (responseBody.stop_reason === 'max_tokens') {
      throw new GenError(TOO_LONG, { status: 422, kind: 'too-long' });
    }

    const text = responseBody.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    const usage = {
      input_tokens: responseBody.usage?.input_tokens ?? 0,
      output_tokens: responseBody.usage?.output_tokens ?? 0,
    };

    return {
      text,
      model: bedrockModelId,
      usage,
      cost: costOf(bedrockModelId, usage),
      billing: 'bedrock',
    };
  } catch (e: any) {
    if (e.name === 'ThrottlingException') {
      throw new GenError('Bedrock is rate limited; try again in a minute.', { status: 429, kind: 'throttled' });
    }
    if (e.name === 'ValidationException' || e.name === 'AccessDeniedException') {
      throw new GenError(`Bedrock access error: ${e.message}`, { status: 403, kind: 'auth' });
    }
    if (e.name === 'ModelNotReadyException' || e.name === 'ResourceNotFoundException') {
      throw new GenError(`Bedrock model ${bedrockModelId} not available in this region.`, { status: 503, kind: 'other' });
    }
    throw new GenError(`Bedrock error: ${e.message}`, { status: 502 });
  }
}

/** Extract JSON from text (for schema responses). */
export function extractJson(text: string): string {
  const t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) return fence[1].trim();
  // Find JSON object bounds
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}
