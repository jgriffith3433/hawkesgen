// Credit pricing, tool quoting, atomic credit reservation/refunds, credit ledger,
// and Stripe Checkout + Webhook verification.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { env, DATA_DIR, loadSettings } from './config.ts';
import { estimate } from './estimate.ts';
import { costOf, DEFAULT_MODEL } from './providers/anthropic.ts';
import { getTool } from './tools/index.ts';
import { applyPreset } from './presets.ts';
import { getUserById, type UserRow } from './users.ts';
import { id, GenError } from './util.ts';
import { subscriptionEvent } from './subscriptions.ts';
import { isCustomerMode } from './providers/builder/customer.ts';
import { resolveMachine, type Machine } from './providers/builder/sizes.ts';

const STRIPE_CONFIG_FILE = path.join(DATA_DIR, 'stripe.json');

type StripeConfigFile = {
  secretKey?: string;
  publishableKey?: string;
  webhookSecret?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};

export type StripeStatus = {
  configured: boolean;
  hasSecretKey: boolean;
  hasPublishableKey: boolean;
  hasWebhookSecret: boolean;
  publishableKey: string | null;
  mode: 'live' | 'test' | null;
};

function readStripeConfigFile(): StripeConfigFile {
  try {
    if (!fs.existsSync(STRIPE_CONFIG_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(STRIPE_CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Stripe's keys (the runtime config file, else the environment), for subscriptions.ts. */
export const stripeKeys = () => loadStripeKeys();

function loadStripeKeys() {
  const file = readStripeConfigFile();
  const secretKey = (file.secretKey ?? file.STRIPE_SECRET_KEY ?? '').trim() || env('STRIPE_SECRET_KEY') || undefined;
  const publishableKey = (file.publishableKey ?? file.STRIPE_PUBLISHABLE_KEY ?? '').trim() || env('STRIPE_PUBLISHABLE_KEY') || undefined;
  const webhookSecret = (file.webhookSecret ?? file.STRIPE_WEBHOOK_SECRET ?? '').trim() || env('STRIPE_WEBHOOK_SECRET') || undefined;
  return { secretKey, publishableKey, webhookSecret };
}

export function getStripeStatus(): StripeStatus {
  const { secretKey, publishableKey, webhookSecret } = loadStripeKeys();
  let mode: 'live' | 'test' | null = null;
  if (secretKey?.includes('_live_') || publishableKey?.includes('_live_')) {
    mode = 'live';
  } else if (secretKey?.includes('_test_') || publishableKey?.includes('_test_')) {
    mode = 'test';
  }
  return {
    configured: Boolean(secretKey),
    hasSecretKey: Boolean(secretKey),
    hasPublishableKey: Boolean(publishableKey),
    hasWebhookSecret: Boolean(webhookSecret),
    publishableKey: publishableKey || null,
    mode,
  };
}

export function saveStripeConfig(input: {
  secretKey?: unknown;
  publishableKey?: unknown;
  webhookSecret?: unknown;
  STRIPE_SECRET_KEY?: unknown;
  STRIPE_PUBLISHABLE_KEY?: unknown;
  STRIPE_WEBHOOK_SECRET?: unknown;
} = {}): StripeStatus {
  const cur = readStripeConfigFile();
  const next: { secretKey?: string; publishableKey?: string; webhookSecret?: string } = {
    secretKey: (cur.secretKey ?? cur.STRIPE_SECRET_KEY ?? '').trim() || undefined,
    publishableKey: (cur.publishableKey ?? cur.STRIPE_PUBLISHABLE_KEY ?? '').trim() || undefined,
    webhookSecret: (cur.webhookSecret ?? cur.STRIPE_WEBHOOK_SECRET ?? '').trim() || undefined,
  };

  const rawSecret = input.secretKey !== undefined ? input.secretKey : input.STRIPE_SECRET_KEY;
  if (rawSecret !== undefined) {
    const v = typeof rawSecret === 'string' ? rawSecret.trim() : '';
    next.secretKey = v || undefined;
  }

  const rawPub = input.publishableKey !== undefined ? input.publishableKey : input.STRIPE_PUBLISHABLE_KEY;
  if (rawPub !== undefined) {
    const v = typeof rawPub === 'string' ? rawPub.trim() : '';
    next.publishableKey = v || undefined;
  }

  const rawWh = input.webhookSecret !== undefined ? input.webhookSecret : input.STRIPE_WEBHOOK_SECRET;
  if (rawWh !== undefined) {
    const v = typeof rawWh === 'string' ? rawWh.trim() : '';
    next.webhookSecret = v || undefined;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STRIPE_CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(STRIPE_CONFIG_FILE, 0o600);
  } catch {
    // ignore on filesystems that do not support chmod
  }
  return getStripeStatus();
}

export type CreditLedgerKind = 'signup_bonus' | 'stripe_purchase' | 'subscription_credits' | 'job_reserve' | 'job_refund' | 'admin_grant' | 'admin_gift' | 'admin_remove' | 'ai_turn';

export type CreditLedgerEntry = {
  id: string;
  user_id: string;
  delta: number;
  balance_after: number;
  kind: CreditLedgerKind;
  detail: string | null;
  job_id: string | null;
  stripe_session_id: string | null;
  created: number;
};

export type CreditPack = {
  id: 'starter_10' | 'creator_25' | 'studio_100';
  name: string;
  label: string;
  priceCents: number;
  priceUsd: number;
  credits: number;
  bonusPercent: number;
};

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: 'starter_10',
    name: 'Starter Pack',
    label: 'Starter Pack — 1,000 Credits',
    priceCents: 1000,
    priceUsd: 10,
    credits: 1000,
    bonusPercent: 0,
  },
  {
    id: 'creator_25',
    name: 'Creator Pack',
    label: 'Creator Pack — 2,750 Credits · 10% Bonus',
    priceCents: 2500,
    priceUsd: 25,
    credits: 2750,
    bonusPercent: 10,
  },
  {
    id: 'studio_100',
    name: 'Studio Pack',
    label: 'Studio Pack — 12,000 Credits · 20% Bonus',
    priceCents: 10000,
    priceUsd: 100,
    credits: 12000,
    bonusPercent: 20,
  },
];

export const COMMERCIAL_MARGIN = 3;

export const INTERNAL_ONLY_TOOLS = new Set([
  'unity.build',
  'unity.test',
  'asset.lod', // the LOD system's own work (src/lod.ts): Gen queues it, nobody else
]);

// ------------------------------------------------------------------ playtests (hawkesstudio docs/platform-plan.md 7)
//
// PROVISIONAL: the plan's unit-cost estimates, to be replaced once runs with design partners are measured. What a minute
// of a run costs us by target (a web tab on RunPod is about $0.58/h over 2 tabs; Proton ~$0.01/min; real Windows
// $0.02-0.04/min, VM time dominates), the minutes a run is quoted for, and a floor per run (credits; 1 credit = $0.01).

/** Our cost of one minute of a playtest, by target (dollars). Provisional (plan 7). */
export const PLAYTEST_MINUTE_USD: Record<string, number> = { web: 0.005, electron: 0.008, linux: 0.01, proton: 0.01, windows: 0.03 };
/** The least a run costs, by target (credits). Provisional. */
export const PLAYTEST_FLOOR_CREDITS: Record<string, number> = { web: 3, electron: 4, linux: 5, proton: 5, windows: 15 };
/** Minutes quoted for starting a run (a cold browser or machine, fetching the build), by target. Provisional. */
const PLAYTEST_BOOT_MINUTES: Record<string, number> = { web: 1, electron: 1.5, linux: 1.5, proton: 2, windows: 4 };
/** playtest.review: tokens per frame (a 1280x720 JPEG), the prompt (report, story, known findings) and the answer. Provisional. */
const REVIEW_TOKENS = { perFrame: 1600, prompt: 6000, answer: 3000 };

/** The minutes a playtest.run is quoted for: its time limit (or a smoke's usual length), plus starting up, times its players. */
export function playtestMinutes(params: Record<string, any>): number {
  const target = String(params.target ?? 'web');
  const peers = Math.max(1, Math.min(4, Number(params.peers) || 1));
  const play = params.mode === 'site'
    ? Math.max(1, Number(params.maxPages) || 40) * 4 / 60
    : (Number(params.timeout) || (String(params.scenario ?? 'smoke') === 'smoke' ? 180 : 300)) / 60;
  return Math.round((play + (PLAYTEST_BOOT_MINUTES[target] ?? 2)) * peers * 100) / 100;
}

/** A playtest tool's raw cost and floor (null for other tools): playtest.run by target and minutes, playtest.review by frames and model. */
export function playtestCost(toolId: string, params: Record<string, any>): { usd: number; floor: number; basis: string } | null {
  if (toolId === 'playtest.run') {
    const target = String(params.target ?? 'web');
    const minutes = playtestMinutes(params);
    const perMinute = PLAYTEST_MINUTE_USD[target] ?? PLAYTEST_MINUTE_USD.windows;
    return { usd: minutes * perMinute, floor: PLAYTEST_FLOOR_CREDITS[target] ?? 15, basis: `${target}: ${minutes} min at $${perMinute}/min (provisional)` };
  }
  if (toolId === 'playtest.review') {
    const frames = Math.max(4, Math.min(40, Number(params.frames) || 16));
    const model = String(params.model || DEFAULT_MODEL);
    const usd = costOf(model, { input_tokens: REVIEW_TOKENS.prompt + frames * REVIEW_TOKENS.perFrame, output_tokens: REVIEW_TOKENS.answer });
    return { usd, floor: 3, basis: `${frames} frames on ${model} (provisional)` };
  }
  return null;
}

export function isInternalOnlyTool(toolId: string): boolean {
  return INTERNAL_ONLY_TOOLS.has(toolId);
}

/**
 * Whether a customer key (role user) may run this internal-only tool with these params: unity.build in customer mode
 * only (github with the customer's own token, out "artifact": providers/builder/customer.ts). Never Gen's own repos or
 * secrets, never a push.
 */
export function customerMayRun(toolId: string, params: Record<string, any> | undefined): boolean {
  return toolId === 'unity.build' && isCustomerMode(params);
}

/**
 * A customer's Unity cloud build on the full machine, flat (credits; 1 credit = $0.01; smaller sizes: unityBuildCredits). Our cost is Cloud Run at 8 vCPU / 32 GiB, about
 * $0.0125 a minute: an incremental build of 10 minutes is about $0.13, a clean import of 40 about $0.50. 100 credits
 * ($1.00) covers a 40-minute build at 2x and breaks even at 80 minutes (past the default limit). Provisional, like the
 * playtest prices: measure, then move to per-minute settling.
 */
export const UNITY_BUILD_CREDITS = 100;

/**
 * The flat credits of a customer build on a machine size (sizes.ts): UNITY_BUILD_CREDITS is the full machine (the
 * customer job's own 8 vCPU / 32 GiB); a smaller one costs its share of Cloud Run's price (m 4/16: 50, s 2/8: 25).
 * J, 2026-11-01: "$1 a build feels wrong to me".
 */
export function unityBuildCredits(m: { cpu: number; memoryGiB: number }, full: { cpu: number; memoryGiB: number }): number {
  const rate = (x: { cpu: number; memoryGiB: number }) => x.cpu * 18 + x.memoryGiB * 2;
  return Math.max(10, Math.round(UNITY_BUILD_CREDITS * rate(m) / rate(full)));
}

/** unity.build in customer mode is priced flat per machine size; anything else is not this function's. */
export function buildCost(toolId: string, params: Record<string, any>): { usd: number; floor: number; basis: string } | null {
  if (toolId !== 'unity.build' || !isCustomerMode(params)) return null;
  const gcp = loadSettings().unityBuild.gcp;
  let m: Machine;
  try { m = resolveMachine(params.machine, gcp); } catch { m = resolveMachine(undefined, gcp); }
  const credits = unityBuildCredits(m, { cpu: gcp.cpu, memoryGiB: gcp.memoryGiB });
  return { usd: credits / 100 / COMMERCIAL_MARGIN, floor: credits, basis: `Unity cloud build on ${m.name} (${m.cpu} vCPU, ${m.memoryGiB} GiB), flat ${credits} credits (provisional)` };
}

export function listCreditPacks(): CreditPack[] {
  return CREDIT_PACKS;
}

export function getCreditPack(packId: string): CreditPack | null {
  return CREDIT_PACKS.find((p) => p.id === packId) ?? null;
}

/**
 * Sensible minimum floor in credits (1 credit = $0.01) for a single execution of a tool.
 */
export function toolFloorCredits(toolId: string): number {
  // The editor's plumbing (ffmpeg on the CPU): a frame, a still as a clip, an upload made editor-ready.
  if (toolId === 'video.frame' || toolId === 'media.normalize') return 1;
  if (toolId === 'video.still') return 2;
  // Chains, priced for their children too (those run on Gen's own key, unbilled): a frame edit plus a video.control
  // clip; a transcription plus a spoken line.
  if (toolId === 'video.change') return 60;
  if (toolId === 'audio.revoice') return 20;
  if (toolId === 'audio.transcribe') return 5;
  // Finishing (src/tools/finishing.ts, provisional): ffmpeg work is near free; chains are priced for their children
  // (music sections, ambience beds, Claude's picks, a trailer's score), which run on Gen's own key.
  if (toolId === 'edit.pace' || toolId === 'world.export') return 1;
  if (toolId === 'video.grade' || toolId === 'video.reframe' || toolId === 'video.titles' || toolId === 'audio.mix') return 3;
  if (toolId === 'video.thumbnails') return 5;
  if (toolId === 'audio.ambience') return 16;
  if (toolId === 'audio.score') return 25;
  if (toolId === 'video.deliver') return 15;
  if (toolId === 'video.trailer') return 40;
  if (toolId === 'texture.maps' || toolId === 'image.normals' || toolId === 'image.albedo' || toolId === 'image.depth' || toolId === 'image.segment') {
    return 5;
  }
  if (toolId === 'image.cutout' || toolId === 'image.cutout-gpu' || toolId === 'image.remove-background' || toolId === 'image.frame' || toolId === 'image.tile' || toolId === 'image.sheet' || toolId === 'sprite.sheet' || toolId === 'image.transform' || toolId === 'video.fit' || toolId === 'media.probe' || toolId === 'file.import') {
    return 2;
  }
  if (toolId === 'image.viewsheet' || toolId === 'image.character') {
    return 15;
  }
  if (toolId.startsWith('image.')) {
    return 5;
  }
  if (toolId === 'audio.music') {
    return 20;
  }
  if (toolId.startsWith('audio.')) {
    return 8;
  }
  if (toolId === 'mesh.rig' || toolId === 'motion.from-text' || toolId === 'blender.character' || toolId === 'blender.render') {
    return 20;
  }
  if (toolId === 'mesh.from-image' || toolId === 'mesh.textured' || toolId === 'mesh.views3d' || toolId === 'mesh.from-views' || toolId === 'splat.build') {
    return 50;
  }
  // Cutting and compositing run on the CPU with ffmpeg (free to us): a small floor, not a GPU video's.
  if (toolId === 'video.compose' || toolId === 'video.composite' || toolId === 'video.matte' || toolId === 'video.control-mix') {
    return 3;
  }
  if (toolId.startsWith('video.')) {
    return 40;
  }
  if (toolId === 'lora.train') {
    return 150;
  }
  if (toolId === 'llm.text' || toolId === 'llm.json' || toolId === 'library.judge' || toolId === 'film.plan' || toolId === 'film.gate') {
    return 3;
  }
  return 5;
}

export function quoteJobCredits(
  toolOrSpec: string | { project?: string; tool?: string; preset?: string; params?: Record<string, any>; count?: number },
  paramsArg: Record<string, any> = {},
  projectArg = 'sandbox',
) {
  const spec = typeof toolOrSpec === 'string'
    ? { project: projectArg, tool: toolOrSpec, params: paramsArg }
    : { project: toolOrSpec.project ?? projectArg, tool: toolOrSpec.tool, preset: toolOrSpec.preset, params: toolOrSpec.params ?? paramsArg, count: toolOrSpec.count };

  const applied = applyPreset(
    { project: spec.project, tool: spec.tool, preset: spec.preset, params: spec.params ?? {} },
    (tid) => getTool(tid)?.params ?? null,
  );
  const resolvedToolId = applied.tool ?? spec.tool ?? '';
  const tool = getTool(resolvedToolId);
  if (!tool) throw new GenError(`Unknown tool: ${resolvedToolId || spec.preset}`, { status: 404 });
  const params = applied.params ?? {};
  const itemCount = Math.max(1, Math.round(Number(spec.count ?? params.count ?? 1)));

  // A tool that prices itself (make.checked: its loop's worst case). Its children run on Gen's key, so each is priced at
  // its work with the margin, not a standalone job's floor (a cheap preview stays cheap); the call keeps its main tool's floor.
  const own = tool.quote?.(params, { project: spec.project, child: (t, p) => childCredits(t, p, spec.project), getTool });
  if (own) {
    const credits = Math.max(1, Math.ceil(own.credits), own.tool ? toolFloorCredits(own.tool) : 0) * itemCount;
    return {
      tool: tool.id, credits, usdEquivalent: credits / 100, margin: COMMERCIAL_MARGIN, rawCostUsd: Math.round((credits / 100 / COMMERCIAL_MARGIN) * 10000) / 10000,
      breakdown: own.breakdown.map((b) => ({ label: b.label, tool: own.tool ?? tool.id, count: itemCount, gpuSeconds: 0, apiCost: 0, rawUsd: 0, floorCredits: 0, credits: b.credits * itemCount, basis: 'worst case of the making loop' })),
    };
  }

  // Playtests are priced by what they run on, not the GPU estimate (plan 7; provisional).
  const pt = playtestCost(tool.id, params) ?? buildCost(tool.id, params);
  if (pt) {
    const rawUsd = pt.usd * itemCount;
    const credits = Math.max(1, pt.floor * itemCount, Math.ceil(rawUsd * COMMERCIAL_MARGIN * 100));
    return {
      tool: tool.id, credits, usdEquivalent: credits / 100, margin: COMMERCIAL_MARGIN, rawCostUsd: Math.round(rawUsd * 10000) / 10000,
      breakdown: [{ label: tool.id, tool: tool.id, count: itemCount, gpuSeconds: 0, apiCost: Math.round(rawUsd * 10000) / 10000, rawUsd: Math.round(rawUsd * 10000) / 10000, floorCredits: pt.floor * itemCount, credits, basis: pt.basis }],
    };
  }

  const est = estimate({
    project: spec.project,
    items: [{ tool: tool.id, params, count: 1 }],
  });

  // Compute work-based USD from the estimate's lines (GPU work seconds at the fleet hourly rate + API cost).
  const gpuPricePerHour = est.gpu.pricePerHour || 1.86;
  const breakdown = est.lines.map((line) => {
    const stepToolId = line.tool === 'llm (pick)' ? 'llm.json' : line.tool;
    const rawStepUsd = (line.gpuSeconds / 3600) * gpuPricePerHour + line.apiCost;
    const marginedCredits = Math.ceil(rawStepUsd * COMMERCIAL_MARGIN * 100);
    const floor = toolFloorCredits(stepToolId) * Math.max(1, Math.round(line.count));
    const stepCredits = Math.max(floor, marginedCredits);
    return {
      label: line.label,
      tool: line.tool,
      count: line.count,
      gpuSeconds: line.gpuSeconds,
      apiCost: line.apiCost,
      rawUsd: Math.round(rawStepUsd * 10000) / 10000,
      floorCredits: floor,
      credits: stepCredits,
      basis: line.basis,
    };
  });

  const totalRawUsd = breakdown.reduce((sum, b) => sum + b.rawUsd, 0);
  const sumStepCredits = breakdown.reduce((sum, b) => sum + b.credits, 0);
  const topFloor = tool.id === 'asset.make'
    ? breakdown.reduce((sum, b) => sum + b.floorCredits, 0)
    : toolFloorCredits(tool.id) * itemCount;
  const credits = Math.max(1, topFloor, sumStepCredits, Math.ceil(totalRawUsd * COMMERCIAL_MARGIN * 100));
  const usdEquivalent = Math.round(credits) / 100;

  return {
    tool: tool.id,
    credits,
    usdEquivalent,
    margin: COMMERCIAL_MARGIN,
    rawCostUsd: Math.round(totalRawUsd * 10000) / 10000,
    breakdown,
  };
}

/** One child job of a pipeline tool, in credits: its work with the margin, without a standalone job's floor. */
export function childCredits(toolId: string, params: Record<string, any>, project = 'sandbox'): number {
  return Math.max(1, Math.ceil(quoteJobCredits(toolId, params, project).rawCostUsd * COMMERCIAL_MARGIN * 100));
}

export function reserveJobCredits(userId: string, jobId: string, credits: number, detail: string): CreditLedgerEntry {
  const amount = Math.max(0, Math.round(credits));
  const now = Date.now();
  const txId = id('tx', 6);
  db.exec('BEGIN');
  try {
    const user = getUserById(userId);
    if (!user) throw new GenError('User account not found', { status: 404 });
    if (user.credits < amount) {
      throw new GenError(
        `Insufficient credits (need ${amount}, have ${user.credits}). Buy credits to run this generation.`,
        { status: 402 },
      );
    }
    const nextBalance = user.credits - amount;
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(nextBalance, user.id);
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, detail, job_id, stripe_session_id, created)
       VALUES (?, ?, ?, ?, 'job_reserve', ?, ?, NULL, ?)`,
    ).run(txId, user.id, -amount, nextBalance, detail, jobId, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db.prepare('SELECT * FROM credit_ledger WHERE id = ?').get(txId) as CreditLedgerEntry;
}

/**
 * Idempotently refunds reserved credits for a job when it transitions to `failed` or `cancelled`.
 */
export function refundJobCredits(jobId: string, reason = 'Job failed or cancelled'): CreditLedgerEntry | null {
  if (!jobId) return null;
  db.exec('BEGIN');
  try {
    const reserve = db.prepare(
      "SELECT * FROM credit_ledger WHERE job_id = ? AND kind = 'job_reserve' LIMIT 1",
    ).get(jobId) as CreditLedgerEntry | undefined;
    if (!reserve) {
      db.exec('COMMIT');
      return null;
    }
    const existingRefund = db.prepare(
      "SELECT * FROM credit_ledger WHERE job_id = ? AND kind = 'job_refund' LIMIT 1",
    ).get(jobId) as CreditLedgerEntry | undefined;
    if (existingRefund) {
      db.exec('COMMIT');
      return existingRefund;
    }
    const refundAmount = Math.abs(reserve.delta);
    const user = getUserById(reserve.user_id);
    if (!user) {
      db.exec('COMMIT');
      return null;
    }
    const nextBalance = user.credits + refundAmount;
    const txId = id('tx', 6);
    const now = Date.now();
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(nextBalance, user.id);
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, detail, job_id, stripe_session_id, created)
       VALUES (?, ?, ?, ?, 'job_refund', ?, ?, NULL, ?)`,
    ).run(txId, user.id, refundAmount, nextBalance, `${reason} (${jobId})`, jobId, now);
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM credit_ledger WHERE id = ?').get(txId) as CreditLedgerEntry;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function grantCredits(
  userId: string,
  credits: number,
  opts: { kind?: CreditLedgerKind; detail?: string; stripeSessionId?: string | null; stripeCustomerId?: string | null } = {},
) {
  const amount = Math.round(Number(credits));
  if (!Number.isFinite(amount) || amount <= 0) throw new GenError('Credits must be a positive integer');
  const kind: CreditLedgerKind = opts.kind ?? 'admin_grant';
  const stripeSessionId = opts.stripeSessionId ?? null;

  db.exec('BEGIN');
  try {
    if (stripeSessionId) {
      const dup = db.prepare('SELECT * FROM credit_ledger WHERE stripe_session_id = ?').get(stripeSessionId) as CreditLedgerEntry | undefined;
      if (dup) {
        const curUser = getUserById(dup.user_id);
        db.exec('COMMIT');
        return { duplicate: true, entry: dup, balance: curUser?.credits ?? dup.balance_after };
      }
    }
    const user = getUserById(userId);
    if (!user) throw new GenError(`User ${userId} not found`, { status: 404 });
    const nextBalance = user.credits + amount;
    if (opts.stripeCustomerId) {
      db.prepare('UPDATE users SET credits = ?, stripe_customer_id = ? WHERE id = ?').run(nextBalance, opts.stripeCustomerId, user.id);
    } else {
      db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(nextBalance, user.id);
    }
    const txId = id('tx', 6);
    const now = Date.now();
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, detail, job_id, stripe_session_id, created)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(txId, user.id, amount, nextBalance, kind, opts.detail ?? `${kind}: +${amount} credits`, stripeSessionId, now);
    db.exec('COMMIT');
    const entry = db.prepare('SELECT * FROM credit_ledger WHERE id = ?').get(txId) as CreditLedgerEntry;
    return { duplicate: false, entry, balance: nextBalance };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Takes credits that aren't a job's: an AI editor turn on the house AI (src/houseai.ts), or the owner removing credits
 * in /admin. Never below zero: the balance is checked before the work, and what's left is taken if it ran over.
 */
export function chargeCredits(userId: string, credits: number, kind: CreditLedgerKind, detail: string): { charged: number; balance: number } {
  const want = Math.max(0, Math.round(Number(credits) || 0));
  db.exec('BEGIN');
  try {
    const user = getUserById(userId);
    if (!user) throw new GenError(`User ${userId} not found`, { status: 404 });
    const charged = Math.min(want, Math.max(0, user.credits));
    const balance = user.credits - charged;
    if (charged > 0) {
      db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(balance, user.id);
      db.prepare(`INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, detail, job_id, stripe_session_id, created)
                  VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`).run(id('tx', 6), user.id, -charged, balance, kind, detail, Date.now());
    }
    db.exec('COMMIT');
    return { charged, balance };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getUserLedger(userId: string, limit = 100) {
  const user = getUserById(userId);
  if (!user) throw new GenError('User not found', { status: 404 });
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const entries = db.prepare(
    'SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY created DESC, rowid DESC LIMIT ?',
  ).all(userId, lim) as CreditLedgerEntry[];
  return {
    credits: user.credits,
    entries,
  };
}

export async function createStripeCheckoutSession(
  user: UserRow,
  body: { packId?: unknown; successUrl?: unknown; cancelUrl?: unknown },
  defaultOrigin = 'https://hawkesgen.ai',
) {
  const packId = String(body.packId ?? '').trim();
  const pack = getCreditPack(packId);
  if (!pack) {
    throw new GenError(`Unknown credit pack "${packId}". Choose one of: ${CREDIT_PACKS.map((p) => p.id).join(', ')}`);
  }

  const { secretKey } = loadStripeKeys();
  if (!secretKey) {
    throw new GenError('Stripe is not configured yet (STRIPE_SECRET_KEY is not set on this server).', { status: 503 });
  }

  const successUrl = typeof body.successUrl === 'string' && /^https?:\/\//.test(body.successUrl)
    ? body.successUrl
    : `${defaultOrigin}/?billing=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = typeof body.cancelUrl === 'string' && /^https?:\/\//.test(body.cancelUrl)
    ? body.cancelUrl
    : `${defaultOrigin}/?billing=cancelled`;

  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('client_reference_id', user.id);
  form.set('customer_email', user.email);
  form.set('success_url', successUrl);
  form.set('cancel_url', cancelUrl);
  form.set('metadata[product]', 'gen');
  form.set('metadata[user_id]', user.id);
  form.set('metadata[pack_id]', pack.id);
  form.set('metadata[credits]', String(pack.credits));
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', 'usd');
  form.set('line_items[0][price_data][unit_amount]', String(pack.priceCents));
  form.set('line_items[0][price_data][product_data][name]', pack.label);
  form.set('line_items[0][price_data][product_data][description]', `${pack.credits.toLocaleString('en-US')} Hawkes Gen generation credits`);

  const apiBase = (env('STRIPE_API_BASE') ?? 'https://api.stripe.com').replace(/\/+$/, '');
  const res = await fetch(`${apiBase}/v1/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GenError(data?.error?.message ?? `Stripe checkout error (HTTP ${res.status})`, { status: 502 });
  }
  return {
    url: data.url as string,
    sessionId: data.id as string,
    pack,
  };
}

export function verifyStripeSignature(rawBody: Buffer | string, signatureHeader: string, webhookSecret?: string, toleranceSec = 300) {
  const secret = webhookSecret ?? loadStripeKeys().webhookSecret;
  if (!secret) {
    throw new GenError('Stripe webhook is not configured yet (STRIPE_WEBHOOK_SECRET is not set).', { status: 503 });
  }
  if (!signatureHeader) {
    throw new GenError('Missing Stripe-Signature header', { status: 400 });
  }

  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't') timestamp = Number(v);
    else if (k === 'v1' && v) signatures.push(v);
  }

  if (!Number.isFinite(timestamp) || timestamp <= 0 || !signatures.length) {
    throw new GenError('Malformed Stripe-Signature header', { status: 400 });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > toleranceSec) {
    throw new GenError('Stripe webhook timestamp outside tolerance window', { status: 400 });
  }

  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signedPayload = `${timestamp}.${payload}`;
  const expectedHex = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  const matched = signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig) || sig.length !== expectedHex.length) return false;
    const sigBuf = Buffer.from(sig, 'hex');
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });

  if (!matched) {
    throw new GenError('Invalid Stripe webhook signature', { status: 400 });
  }
}

/** Whether a Stripe event is Gen's: tagged product "gen" (every checkout Gen makes is), else about a subscription Gen
 *  knows, else for a Gen account (untagged checkouts from before the tag). Another product's tag is never Gen's. */
export function isGenEvent(event: any): boolean {
  const o = event?.data?.object ?? {};
  const meta = { ...(o.parent?.subscription_details?.metadata ?? {}), ...(o.subscription_details?.metadata ?? {}), ...(o.metadata ?? {}) };
  if (typeof meta.product === 'string' && meta.product) return meta.product === 'gen';
  const subId = String(event?.type ?? '').startsWith('customer.subscription.') ? o.id : (o.subscription ?? o.parent?.subscription_details?.subscription);
  if (subId && db.prepare('SELECT 1 FROM user_subscriptions WHERE stripe_subscription_id = ?').get(String(subId))) return true;
  const userId = String(meta.user_id ?? o.client_reference_id ?? '');
  return Boolean(userId && getUserById(userId));
}

export function handleStripeWebhook(rawBody: Buffer | string, signatureHeader: string) {
  verifyStripeSignature(rawBody, signatureHeader);
  let event: any;
  try {
    event = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  } catch {
    throw new GenError('Webhook body is not valid JSON', { status: 400 });
  }

  // One Stripe account serves the portal, Gen and Studio (J, 2026-10-29), and every endpoint gets every event: Gen acts
  // only on its own and answers 200 to the rest, so Stripe never retries or disables this endpoint over them.
  if (!isGenEvent(event)) return { ok: true, type: event?.type ?? 'unknown', ignored: 'not a Hawkes Gen event' };

  // Subscriptions (subscriptions.ts): their checkout, invoices and status changes.
  const sub = subscriptionEvent(event);
  if (sub) return sub;

  if (event?.type === 'checkout.session.completed') {
    const session = event.data?.object ?? {};
    if (session.payment_status === 'paid') {
      const userId = String(session.metadata?.user_id ?? session.client_reference_id ?? '').trim();
      const credits = Math.round(Number(session.metadata?.credits ?? 0));
      const packId = String(session.metadata?.pack_id ?? '').trim();
      const sessionId = String(session.id ?? '').trim();
      if (!userId || !sessionId || credits <= 0) {
        throw new GenError('Stripe checkout session missing metadata (user_id, credits, or id)', { status: 400 });
      }
      const pack = getCreditPack(packId);
      const detail = pack ? `Purchased ${pack.label}` : `Stripe credit purchase (+${credits} credits)`;
      const res = grantCredits(userId, credits, {
        kind: 'stripe_purchase',
        detail,
        stripeSessionId: sessionId,
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
      });
      return {
        ok: true,
        type: event.type,
        duplicate: res.duplicate,
        creditsAdded: res.duplicate ? 0 : credits,
        balance: res.balance,
      };
    }
  }

  return { ok: true, type: event?.type ?? 'unknown', ignored: true };
}

// ---------------------------------------------------------------- Subscriptions

export type SubscriptionPlan = {
  id: string;
  name: string;
  priceCents: number;
  creditsPerMonth: number;
  maxGames: number;
  maxMembersPerGame: number;
  stripePriceId: string | null;
  active: number;
  created: number;
};

export type UserSubscription = {
  id: string;
  userId: string;
  planId: string;
  stripeSubscriptionId: string | null;
  status: 'active' | 'canceled' | 'past_due' | 'trialing';
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: number;
  created: number;
  updated: number;
};

export function getSubscriptionPlan(planId: string): SubscriptionPlan | null {
  const row = db.prepare('SELECT * FROM subscription_plans WHERE id = ? AND active = 1').get(planId) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    priceCents: row.price_cents,
    creditsPerMonth: row.credits_per_month,
    maxGames: row.max_games,
    maxMembersPerGame: row.max_members_per_game,
    stripePriceId: row.stripe_price_id,
    active: row.active,
    created: row.created,
  };
}

export function listSubscriptionPlans(): SubscriptionPlan[] {
  const rows = db.prepare('SELECT * FROM subscription_plans WHERE active = 1 ORDER BY price_cents').all() as any[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    priceCents: row.price_cents,
    creditsPerMonth: row.credits_per_month,
    maxGames: row.max_games,
    maxMembersPerGame: row.max_members_per_game,
    stripePriceId: row.stripe_price_id,
    active: row.active,
    created: row.created,
  }));
}

export function createSubscriptionPlan(plan: Omit<SubscriptionPlan, 'created'>): SubscriptionPlan {
  const now = Date.now();
  db.prepare(
    `INSERT INTO subscription_plans (id, name, price_cents, credits_per_month, max_games, max_members_per_game, stripe_price_id, active, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.id,
    plan.name,
    plan.priceCents,
    plan.creditsPerMonth,
    plan.maxGames,
    plan.maxMembersPerGame,
    plan.stripePriceId,
    plan.active,
    now,
  );
  return { ...plan, created: now };
}

export function getUserSubscription(userId: string): UserSubscription | null {
  const row = db.prepare(
    // past_due stays current (the plan shows "payment failed" and can't be bought twice) until Stripe ends it.
    "SELECT * FROM user_subscriptions WHERE user_id = ? AND status IN ('active', 'trialing', 'past_due') ORDER BY created DESC LIMIT 1",
  ).get(userId) as any;
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    created: row.created,
    updated: row.updated,
  };
}

export function createUserSubscription(sub: Omit<UserSubscription, 'created' | 'updated'>): UserSubscription {
  const now = Date.now();
  const subId = id('sub', 8);
  db.prepare(
    `INSERT INTO user_subscriptions (id, user_id, plan_id, stripe_subscription_id, status, current_period_start, current_period_end, cancel_at_period_end, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    subId,
    sub.userId,
    sub.planId,
    sub.stripeSubscriptionId,
    sub.status,
    sub.currentPeriodStart,
    sub.currentPeriodEnd,
    sub.cancelAtPeriodEnd,
    now,
    now,
  );
  return { ...sub, id: subId, created: now, updated: now };
}

export function updateUserSubscription(
  subId: string,
  updates: Partial<Pick<UserSubscription, 'status' | 'currentPeriodStart' | 'currentPeriodEnd' | 'cancelAtPeriodEnd'>>,
): void {
  const fields: string[] = [];
  const values: any[] = [];
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.currentPeriodStart !== undefined) {
    fields.push('current_period_start = ?');
    values.push(updates.currentPeriodStart);
  }
  if (updates.currentPeriodEnd !== undefined) {
    fields.push('current_period_end = ?');
    values.push(updates.currentPeriodEnd);
  }
  if (updates.cancelAtPeriodEnd !== undefined) {
    fields.push('cancel_at_period_end = ?');
    values.push(updates.cancelAtPeriodEnd);
  }
  if (!fields.length) return;
  fields.push('updated = ?');
  values.push(Date.now());
  values.push(subId);
  db.prepare(`UPDATE user_subscriptions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Allocate monthly credits to a user based on their subscription plan.
 * Called when a subscription renews (via Stripe webhook or a cron).
 */
export function allocateMonthlyCredits(userId: string): { allocated: boolean; credits: number } {
  const sub = getUserSubscription(userId);
  if (!sub || (sub.status !== 'active' && sub.status !== 'trialing')) {
    return { allocated: false, credits: 0 };
  }
  const plan = getSubscriptionPlan(sub.planId);
  if (!plan) return { allocated: false, credits: 0 };

  grantCredits(userId, plan.creditsPerMonth, {
    kind: 'admin_grant',
    detail: `Monthly credit allocation: ${plan.name}`,
  });

  return { allocated: true, credits: plan.creditsPerMonth };
}
