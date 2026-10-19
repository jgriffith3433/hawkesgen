// Writing, review and JSON calls through Cursor's `agent` on the Cursor plan. No tools: a prompt in, text out.
// CURSOR_API_KEY is the account key (hawkes/cursor on the server). A Claude model id from a caller is Grok 4.7
// here, so a third-party model is not billed on top of the plan. Tests point HAWKESGEN_CURSOR at a stand-in.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config.ts';
import { GenError } from '../util.ts';

export const CURSOR_MODEL = 'grok-4.7';
export const configured = () => Boolean(env('CURSOR_API_KEY') || env('HAWKESGEN_CURSOR'));

function bin() {
  if (env('HAWKESGEN_CURSOR')) return env('HAWKESGEN_CURSOR')!;
  const home = os.homedir();
  const found = ['/usr/local/bin/agent', path.join(home, '.local', 'bin', 'agent'), '/home/hawkes/.local/bin/agent'].find((p) => fs.existsSync(p));
  return found || 'agent';
}

/** Claude ids stay on the plan's Grok. A Cursor model id is used as given. */
export function modelId(model?: string) {
  if (!model || model.startsWith('claude')) return CURSOR_MODEL;
  return model;
}

export async function ask(input: { prompt: string; system?: string; images?: string[]; model?: string; schema?: Record<string, unknown> }, signal?: AbortSignal) {
  const model = modelId(input.model);
  const prompt = [
    input.system?.trim(),
    input.prompt,
    input.schema ? `Reply with only JSON matching this schema:\n${JSON.stringify(input.schema)}` : '',
    input.images?.length ? `Image files:\n${input.images.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const pre: string[] = env('HAWKESGEN_CURSOR_ARGS') ? JSON.parse(env('HAWKESGEN_CURSOR_ARGS')!) : [];
  const args = [...pre, '-p', '--output-format', 'json', '--force', '--trust', '--model', model, prompt];
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin(), args, { env: process.env, windowsHide: true });
    let out = '';
    let err = '';
    const kill = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new GenError(`Cursor harness failed to start: ${e.message}`, { status: 503, kind: 'auth' })));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(new GenError('Cancelled', { status: 499, kind: 'cancelled' }));
      let parsed: any;
      try { parsed = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { parsed = null; }
      if (!parsed || parsed.is_error || code) return reject(new GenError(`Cursor: ${String(parsed?.result ?? err).trim().slice(0, 300) || `exit ${code}`}`, { status: 502 }));
      resolve(String(parsed.result ?? ''));
    });
  });
  return { text, model, usage: {}, cost: 0, billing: 'cursor' as const };
}
