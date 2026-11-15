// Claude through Claude Code (`claude -p`) on J's Max plan: the default backend for every Claude call Gen makes
// (settings.claude.backend; "api" goes back to the API key in anthropic.ts). Same request and answer as the API path:
// text and images in (base64 image blocks in a stream-json user message), text out, or JSON that matches a schema
// (--json-schema, returned as JSON text so callers parse it as before). No tools, no MCP servers, no settings files,
// no saved session, in an empty scratch folder: a plain question and answer.
//
// Login: the CLI's own. On the control server that's J's subscription token (CLAUDE_CODE_OAUTH_TOKEN): from Gen's
// environment or .env, else the Claude account picked in Studio's Settings, else the secret hawkes/claude in
// /run/hawkes/claude.env (claudeEnvFiles below), which Gen's user can read. The API key is always removed from the CLI's environment: Claude
// Code prefers it over the subscription, and billing it is exactly what this backend avoids.
//
// Calls at once are capped (settings.claude.concurrency, default 3; an AI turn also waits a bounded time, src/aigate.ts), each has a timeout (settings.claude.timeoutMinutes),
// and a rate limit or overload waits and tries again a few times. Tests run a fake CLI: HAWKESGEN_CLAUDE (the program)
// and HAWKESGEN_CLAUDE_ARGS (a JSON array before the CLI's own arguments).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, env, loadSettings, paths } from '../config.ts';
import { GenError, id, mimeOf, sleep } from '../util.ts';
import { createGate, type WaitInfo } from '../aigate.ts';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export type AskInput = {
  prompt: string; system?: string; images?: string[]; model: string; effort?: string; maxTokens?: number; schema?: Record<string, unknown>;
  /** The answer's text so far, each time more arrives (--include-partial-messages). A retry starts it again from "". */
  onText?: (soFar: string) => void;
};
export type AskOptions = {
  timeoutMs?: number; retryDelaysMs?: number[];
  /** A customer org's own Claude subscription token (orgsecrets.ts), instead of J's. */
  token?: string;
  /** An AI turn's account (its project): capped at settings.claude.maxPerUser at once, and it waits at most settings.claude.maxWaitSeconds for a slot, telling `onWait` its place. */
  who?: string;
  onWait?: (e: WaitInfo) => void;
};

// ------------------------------------------------------------- calls at once
// The gate (src/aigate.ts): `concurrency` slots; an AI turn (one with `who`) also has a per-account cap and a bounded wait.
const gate = createGate(() => loadSettings().claude.concurrency);

/** Calls running and waiting now (for tests and the dashboard). */
export const load = () => gate.load();

// -------------------------------------------------------------------- login
/**
 * The account in use, read on every call (switching needs no restart): the one picked in Gen's own Settings
 * (.data/claude/active.env, src/claude-accounts.ts; it also adopts the environment's token as an account), else
 * CLAUDE_CODE_OAUTH_TOKEN, else the one picked in Studio's Settings on the same machine
 * (hawkesstudio/.data/claude/active.env), else the server's secret (/run/hawkes/claude.env). HAWKESGEN_CLAUDE_ENV names
 * one file instead.
 */
export function claudeEnvFiles() {
  const one = env('HAWKESGEN_CLAUDE_ENV');
  return one ? [one] : [path.join(DATA_DIR, 'claude', 'active.env'), path.resolve(ROOT, '..', 'hawkesstudio', '.data', 'claude', 'active.env'), '/run/hawkes/claude.env'];
}

const tokenIn = (file: string) => {
  try {
    const m = /^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.*?)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
    return m?.[1].replace(/^['"]|['"]$/g, '') || undefined;
  } catch { return undefined; }
};

export function subscriptionToken(): string | undefined {
  const [first, ...rest] = claudeEnvFiles();
  if (!env('HAWKESGEN_CLAUDE_ENV')) {
    const picked = tokenIn(first);
    if (picked) return picked;
  }
  const own = env('CLAUDE_CODE_OAUTH_TOKEN');
  if (own) return own;
  for (const file of env('HAWKESGEN_CLAUDE_ENV') ? [first] : rest) {
    const token = tokenIn(file);
    if (token) return token;
  }
  return undefined;
}

/** The CLI's environment: J's subscription, or (`own`) a customer org's own subscription token (orgsecrets.ts). */
function cliEnv(own?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  delete out.ANTHROPIC_API_KEY;
  const token = own ?? subscriptionToken();
  if (token) out.CLAUDE_CODE_OAUTH_TOKEN = token;
  return out;
}

// ---------------------------------------------------------------- one call
/** A system prompt longer than this goes in a file (--system-prompt-file): one argument may be at most 128 KB on Linux
 *  (MAX_ARG_STRLEN), and the portal's assistant sends its whole engine guide as the system prompt ("spawn E2BIG"). */
export const SYSTEM_INLINE_MAX = 16_000;

/**
 * The Claude Code program. On Windows `claude` on the PATH is npm's claude.cmd, which Node won't spawn without a shell;
 * it only runs the real claude.exe beside it (node_modules/@anthropic-ai/claude-code/bin), so Gen runs that directly.
 */
let winClaude: string | null | undefined;
export function claudeProgram(): string {
  if (env('HAWKESGEN_CLAUDE')) return env('HAWKESGEN_CLAUDE')!;
  if (process.platform !== 'win32') return 'claude';
  if (winClaude === undefined) {
    winClaude = null;
    const dirs = [...String(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')].filter(Boolean);
    for (const d of dirs) {
      const exe = path.join(d, 'claude.exe');
      if (fs.existsSync(exe)) { winClaude = exe; break; }
      const inner = path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(path.join(d, 'claude.cmd')) && fs.existsSync(inner)) { winClaude = inner; break; }
    }
  }
  return winClaude ?? 'claude';
}

/** Program and arguments for one call. A long system prompt is written into `dir` (the call's own folder). */
export function cliArgs({ model, effort, system, schema, onText }: AskInput, dir?: string) {
  const file = claudeProgram();
  const pre: string[] = env('HAWKESGEN_CLAUDE_ARGS') ? JSON.parse(env('HAWKESGEN_CLAUDE_ARGS')!) : [];
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands',
  ];
  const sys = system?.trim() ? system : 'You are Claude. Answer the request directly.';
  if (dir && sys.length > SYSTEM_INLINE_MAX) {
    const f = path.join(dir, 'system.md');
    fs.writeFileSync(f, sys);
    args.push('--system-prompt-file', f);
  } else args.push('--system-prompt', sys);
  if (effort) args.push('--effort', effort);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (onText) args.push('--include-partial-messages');
  return { file, args: [...pre, ...args] };
}

/** The stream-json user message: the images, then the prompt. */
export function userMessage(prompt: string, images: string[] = []) {
  const content: any[] = images.map((file) => {
    const mime = mimeOf(file);
    if (!IMAGE_TYPES.has(mime)) throw new GenError(`Claude reads PNG, JPEG, WebP or GIF images, not ${file}`);
    return { type: 'image', source: { type: 'base64', media_type: mime, data: fs.readFileSync(file).toString('base64') } };
  });
  content.push({ type: 'text', text: prompt });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

type Outcome = { result?: any; model?: string; stderr: string; code: number | null };

function runOnce(input: AskInput, timeoutMs: number, signal?: AbortSignal, token?: string): Promise<Outcome> {
  const cwd = path.join(paths.tmp, 'claude', id('c'));
  fs.mkdirSync(cwd, { recursive: true });
  const { file, args } = cliArgs(input, cwd);
  const stdin = userMessage(input.prompt, input.images);
  return new Promise<Outcome>((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: cliEnv(token), windowsHide: true });
    let buf = '';
    let stderr = '';
    let result: any;
    let model: string | undefined;
    let ended: GenError | null = null;
    let soFar = '';
    if (input.onText) input.onText('');
    const line = (l: string) => {
      if (!l.trim()) return;
      let m: any;
      try { m = JSON.parse(l); } catch { return; }
      if (m.type === 'assistant' && m.message?.model && m.message.model !== '<synthetic>') model = m.message.model;
      // The answer as it is written: text deltas of the model's own message (not a tool's).
      if (input.onText && m.type === 'stream_event' && !m.parent_tool_use_id && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
        soFar += String(m.event.delta.text ?? '');
        try { input.onText(soFar); } catch { /* the listener's problem */ }
      }
      if (m.type === 'result') result = m;
    };
    const kill = (why: GenError) => {
      ended ??= why;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => kill(new GenError(`Claude (Max plan) took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped.`, { status: 504, kind: 'timeout' })), timeoutMs);
    const onAbort = () => kill(new GenError('Cancelled', { status: 499, kind: 'cancelled' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.stdin.on('error', () => {}); // a CLI that exits early (not logged in) closes stdin under us
    child.stdin.end(stdin);
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fs.rmSync(cwd, { recursive: true, force: true });
    };
    child.on('error', (e: any) => {
      done();
      reject(e?.code === 'ENOENT' ? new GenError(`Claude Code (${file}) is not installed on this server`, { status: 503, kind: 'auth' }) : e);
    });
    child.on('close', (code) => {
      line(buf);
      done();
      if (ended) reject(ended);
      else resolve({ result, model, stderr, code });
    });
  });
}

const THROTTLED = /rate.?limit|usage limit|hit your limit|overloaded|too many requests|\b(429|529)\b/i;
const AUTH = /not logged in|\/login|authentication|invalid (api key|token|bearer)|oauth token|unauthori[sz]ed/i;

/** What went wrong in one call, or null when it answered: a throttle is worth another try, the rest are not. */
export function failureOf(o: Outcome): GenError | null {
  const r = o.result;
  if (r && !r.is_error) {
    if (r.stop_reason === 'refusal') return new GenError('Claude declined this request.', { status: 422, kind: 'refusal' });
    return null;
  }
  const why = String(r?.result || r?.error || o.stderr || `claude exited ${o.code}`).trim().slice(-600);
  const status = Number(r?.api_error_status) || 0;
  if (status === 429 || status === 529 || THROTTLED.test(why)) return new GenError(`Claude (Max plan) is rate limited: ${why}`, { status: 429, kind: 'throttled' });
  if (status === 401 || status === 403 || AUTH.test(why)) return new GenError(`Claude Code on this server is not signed in to the Max plan (${why}). Set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or switch settings.claude.backend to "api".`, { status: 502, kind: 'auth' });
  if (status >= 500) return new GenError(`Claude error ${status}: ${why}`, { status: 502, kind: 'throttled' });
  return new GenError(`Claude (Max plan) failed: ${why}`, { status: 502 });
}

/** First balanced `{…}` or `[…]` block (whichever opens first), respecting strings so brackets in values don't throw off the depth. */
function firstJsonBlock(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const parses = (s: string) => { try { JSON.parse(s); return true; } catch { return false; } };

/** The JSON in a model's reply: bare, wrapped in a ```json fence (with or without prose around it), or the first balanced
 *  block. A reply with no JSON in it comes back trimmed and unchanged, so the caller's JSON.parse still fails loudly. */
export function extractJson(reply: string): string {
  const text = reply.trim();
  if (parses(text)) return text;
  const candidates: string[] = [];
  const fenced = /```[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i.exec(text);
  if (fenced) candidates.push(fenced[1].trim());
  const open = /^```[ \t]*(?:json)?\s*/i.exec(text);
  if (open) candidates.push(text.slice(open[0].length).replace(/\s*```\s*$/, '').trim());
  candidates.push(text);
  for (const c of candidates) {
    if (parses(c)) return c;
    const block = firstJsonBlock(c);
    if (block && parses(block)) return block;
  }
  return text;
}

/** The answer's text: for a schema, the structured output as JSON text, or the JSON pulled out of the reply (see extractJson). */
export function answerText(r: any, schema?: unknown): string {
  if (schema && r.structured_output !== undefined && r.structured_output !== null) return JSON.stringify(r.structured_output);
  const text = String(r.result ?? '');
  return schema ? extractJson(text) : text;
}

/** One request through Claude Code, with the cap, the timeout and retries on rate limits. */
export async function ask(input: AskInput, signal?: AbortSignal, opts: AskOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? loadSettings().claude.timeoutMinutes * 60_000;
  // A turn someone is waiting on (`who`) gets one quick retry on a rate limit, then a plain error they can retry:
  // minutes of silent backoff read as "it just thinks forever". Gen's own calls keep the long backoff.
  const delays = opts.retryDelaysMs ?? (opts.who ? [5_000] : [20_000, 60_000, 120_000]);
  for (let attempt = 0; ; attempt++) {
    const cl = loadSettings().claude;
    const release = await gate.acquire({ signal, who: opts.who, maxPerUser: cl.maxPerUser, maxWaitMs: cl.maxWaitSeconds * 1000, onWait: opts.onWait });
    let o: Outcome;
    try {
      o = await runOnce(input, timeoutMs, signal, opts.token);
    } finally {
      release();
    }
    const err = failureOf(o);
    if (err && opts.token && err.kind === 'auth') throw new GenError("Your Claude subscription sign-in didn't work (it may have expired): sign in again in your hawkesgen.ai settings.", { status: 502, kind: 'auth' });
    if (!err) {
      const r = o.result;
      return { text: answerText(r, input.schema), model: o.model ?? input.model, usage: r.usage ?? {}, cost: 0, billing: opts.token ? ('subscription' as const) : ('max-plan' as const) };
    }
    if (err.kind !== 'throttled' || attempt >= delays.length) throw err;
    await Promise.race([sleep(delays[attempt]), new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
    if (signal?.aborted) throw new GenError('Cancelled', { status: 499, kind: 'cancelled' });
  }
}
