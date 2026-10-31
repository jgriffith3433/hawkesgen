// What the showrunner reaches outside itself: Claude, the queue, prices, the library, frames and the quality checks. One
// object, so tests swap every part for a mock (test/showrunner.test.ts) and nothing here spends money there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '../auth.ts';
import { assess, type AssessInput, type QualityReport } from '../quality/index.ts';
import { ask, callScope } from '../providers/anthropic.ts';
import { orgOfProject, isGenAccountProject } from '../orgsecrets.ts';
import { submit, getJob, cancel } from '../jobs.ts';
import { getAsset } from '../library.ts';
import { quoteJobCredits, chargeCredits } from '../billing.ts';
import { getTool } from '../tools/index.ts';
import { videoFrames } from '../tools/pipeline.ts';
import { turnCredits } from '../houseai.ts';
import { run } from '../util.ts';

export type AskInput = { system?: string; prompt: string; images?: string[]; schema?: Record<string, unknown>; maxTokens?: number; effort?: 'low' | 'medium' | 'high' };
export type AskOutput = { text: string; cost: number; house: boolean; model: string };
export type JobLike = { id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; outputs: { asset: string; kind: string; title?: string | null }[]; error: string | null; detail?: string };
export type SubmitSpec = { project: string; tool: string; params: Record<string, any>; inputs: Record<string, any>; labels: Record<string, unknown> };

export type Deps = {
  /** One Claude call for a project: its own key or subscription, else the house AI (callScope). */
  ask(project: string, p: AskInput): Promise<AskOutput>;
  submit(client: Client, spec: SubmitSpec): { id: string };
  job(id: string): JobLike | null;
  cancel(id: string): void;
  /** Credits a job would cost (0 when it can't be priced). */
  quote(project: string, tool: string, params: Record<string, any>): number;
  hasTool(id: string): boolean;
  /** A library file's local path and kind (null: missing). */
  assetPath(id: string): string | null;
  assetKind(id: string): string | null;
  /** A few frames of a video as PNGs (start, middle, end). */
  frames(file: string): Promise<string[]>;
  /** One frame of a video at `t` seconds (PNG), for review mode. */
  frameAt(file: string, t: number): Promise<string | null>;
  /** Several pictures in one (a contact sheet), at most 16. */
  sheet(files: string[]): Promise<string | null>;
  assess(a: AssessInput): Promise<QualityReport>;
  /** Charges a Gen account's house AI call in credits (payer null: the account runs on its own Claude). */
  chargeAi(payer: string | null, cost: number, what: string): number;
  now(): number;
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sr-'));

const REAL: Deps = {
  async ask(project, p) {
    const r = await callScope.run({ customer: true, org: orgOfProject(project), house: isGenAccountProject(project) }, () => ask(p));
    return { text: r.text, cost: r.cost ?? 0, house: !['byok', 'subscription'].includes(r.billing), model: r.model };
  },
  submit: (client, spec) => submit(client, spec),
  job: (id) => getJob(id) as JobLike | null,
  cancel: (id) => { try { cancel(id); } catch { /* already over */ } },
  quote(project, tool, params) {
    try { return Number((quoteJobCredits({ project, tool, params }) as any)?.credits ?? 0); } catch { return 0; }
  },
  hasTool: (id) => Boolean(getTool(id)),
  assetPath: (id) => getAsset(id)?.path ?? null,
  assetKind: (id) => getAsset(id)?.kind ?? null,
  frames: (file) => videoFrames(file, tmp(), AbortSignal.timeout(60_000)),
  async frameAt(file, t) {
    const out = path.join(tmp(), 'frame.png');
    try { await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', 'scale=768:-2', out], { signal: AbortSignal.timeout(30_000) }); } catch { return null; }
    return fs.existsSync(out) ? out : null;
  },
  async sheet(files) {
    const list = files.slice(0, 16);
    if (list.length <= 1) return list[0] ?? null;
    const cols = Math.min(4, list.length);
    const out = path.join(tmp(), 'sheet.png');
    const scale = list.map((_, i) => `[${i}:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2[v${i}]`).join(';');
    const layout = list.map((_, i) => `${(i % cols) * 320}_${Math.floor(i / cols) * 180}`).join('|');
    try {
      await run('ffmpeg', ['-y', '-loglevel', 'error', ...list.flatMap((f) => ['-i', f]), '-filter_complex', `${scale};${list.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${list.length}:layout=${layout}:fill=black`, '-frames:v', '1', out], { signal: AbortSignal.timeout(30_000) });
    } catch { return list[0]; }
    return fs.existsSync(out) ? out : list[0];
  },
  assess: (a) => assess(a),
  chargeAi(payer, cost, what) {
    if (!payer) return 0;
    try { return chargeCredits(payer, turnCredits(cost), 'ai_turn', what.slice(0, 120)).charged; } catch { return 0; }
  },
  now: () => Date.now(),
};

let override: Deps | null = null;
/** Tests: some or all dependencies mocked (the rest stay real). Null puts the real ones back. */
export function setDeps(d: Partial<Deps> | null) { override = d ? { ...REAL, ...d } : null; }
export const deps = (): Deps => override ?? REAL;
