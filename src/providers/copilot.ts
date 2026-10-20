// Writing, review and JSON calls through the GitHub Copilot CLI on the Copilot plan. No tools wanted: a prompt in, text
// out. COPILOT_GITHUB_TOKEN is a fine-grained token with "Copilot Requests" (hawkes/copilot on the server), or the
// server has a `copilot login`. A Claude model id from a caller is dropped so Copilot's own default answers (Copilot
// names models with dots: claude-sonnet-4.5). Tests point HAWKESGEN_COPILOT at a stand-in.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config.ts';
import { GenError } from '../util.ts';

export const configured = () => {
  if (env('COPILOT_GITHUB_TOKEN') || env('HAWKESGEN_COPILOT')) return true;
  const home = env('COPILOT_HOME') || path.join(os.homedir(), '.copilot');
  return ['config.json', 'apps.json', 'hosts.json'].some((f) => fs.existsSync(path.join(home, f)));
};

function bin() {
  if (env('HAWKESGEN_COPILOT')) return env('HAWKESGEN_COPILOT')!;
  const home = os.homedir();
  const found = ['/usr/local/bin/copilot', '/usr/bin/copilot', path.join(home, '.local', 'bin', 'copilot'), '/home/hawkes/.local/bin/copilot'].find((p) => fs.existsSync(p));
  if (found) return found;
  // Windows: npm's copilot.cmd shim can't take a prompt safely; run its loader with node.
  if (process.platform === 'win32') {
    for (const d of String(process.env.PATH || '').split(path.delimiter)) {
      const loader = path.join(d, 'node_modules', '@github', 'copilot', 'npm-loader.js');
      if (fs.existsSync(loader)) return loader;
    }
  }
  return 'copilot';
}

/** Claude Code's ids (claude-opus-5-5) and aliases mean nothing to Copilot: '' = its default. Its own ids pass. */
export function modelId(model?: string) {
  const m = (model ?? '').trim();
  if (!m || /^(opus|sonnet|haiku|auto)$/i.test(m) || /^claude-[a-z]+-\d+-\d+(-\d+)?$/i.test(m)) return '';
  return m;
}

/** The answer and the error in the CLI's JSONL (events are {type, data}); tolerant of events it doesn't know. */
export function parseJsonl(out: string) {
  let text = '';
  let streamed = '';
  let error = '';
  let model = '';
  for (const line of out.split('\n')) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const d = e?.data && typeof e.data === 'object' ? e.data : e ?? {};
    if (e?.type === 'assistant.message_delta') streamed += d.deltaContent ?? '';
    else if (e?.type === 'assistant.message') {
      if (d.content && !d.parentToolCallId) text = String(d.content);
      model = d.model ?? model;
      streamed = '';
    } else if (e?.type === 'assistant.usage') model = d.model ?? model;
    else if (e?.type === 'session.error' || e?.type === 'error') error = [d.errorType, d.statusCode, d.errorCode, d.message].filter(Boolean).join(' ') || JSON.stringify(d).slice(0, 300);
  }
  return { text: text || streamed, error, model };
}

export async function ask(input: { prompt: string; system?: string; images?: string[]; model?: string; schema?: Record<string, unknown> }, signal?: AbortSignal) {
  const model = modelId(input.model);
  const prompt = [
    input.system?.trim(),
    input.prompt,
    input.schema ? `Reply with only JSON matching this schema:\n${JSON.stringify(input.schema)}` : '',
    input.images?.length ? `Image files:\n${input.images.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const pre: string[] = env('HAWKESGEN_COPILOT_ARGS') ? JSON.parse(env('HAWKESGEN_COPILOT_ARGS')!) : [];
  const args = [...pre, '-p', prompt, '--output-format', 'json', '--allow-all', '--no-ask-user', '--no-auto-update', ...(model ? ['--model', model] : [])];
  const res = await new Promise<{ text: string; model: string }>((resolve, reject) => {
    const exe = bin();
    const script = /\.(mjs|cjs|js)$/i.test(exe);
    const child = spawn(script ? process.execPath : exe, script ? [exe, ...args] : args, { env: { ...process.env, NO_COLOR: '1', ...(env('COPILOT_GITHUB_TOKEN') ? { COPILOT_GITHUB_TOKEN: env('COPILOT_GITHUB_TOKEN')! } : {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const kill = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new GenError(`Copilot harness failed to start: ${e.message}`, { status: 503, kind: 'auth' })));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(new GenError('Cancelled', { status: 499, kind: 'cancelled' }));
      const p = parseJsonl(out);
      if (p.error || code || !p.text) return reject(new GenError(`Copilot: ${(p.error || err || out).trim().split('\n').slice(-6).join(' ').slice(0, 300) || `exit ${code}`}`, { status: 502 }));
      resolve({ text: p.text, model: p.model });
    });
  });
  return { text: res.text, model: res.model || model || 'copilot', usage: {}, cost: 0, billing: 'copilot' as const };
}
