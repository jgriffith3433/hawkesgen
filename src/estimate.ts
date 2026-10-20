// Cost estimates before spending: how long a batch of jobs keeps the GPU busy, what the APIs cost, and the dollars.
//
//   POST /v1/estimate { project, items: [{ tool | preset, params, count, label }], servers? }
//
// GPU time per job comes from this service's own history (the median of the last finished jobs of that tool, scaled
// by frames and pixels for images and video), else the tool's own guess (`gpuSeconds`). API tools (Claude,
// ElevenLabs) use the median cost of their past jobs. asset.make is expanded into its steps: the pick step (the first, or pickAt) times
// `candidates`, one Claude pick, the rest once. Each model family adds one model load, a stopped server adds its boot,
// and a server left on idles for the fleet's idle minutes before stopping itself: all are counted, so the number J
// approves is the number he pays.

import { db } from './db.ts';
import { getTool } from './tools/index.ts';
import { validateParams } from './tools/validate.ts';
import { applyPreset } from './presets.ts';
import { loadSettings } from './config.ts';
import { TYPES } from './providers/comfy/fleet.ts';
import { GenError } from './util.ts';
import type { Tool } from './tools/types.ts';

export type EstimateItem = { tool?: string; preset?: string; params?: Record<string, any>; count?: number; label?: string };
type Line = { label: string; tool: string; count: number; gpuSeconds: number; apiCost: number; family: string | null; basis: string };

const PRICE = TYPES['g6e.xlarge'].price;
const MODEL_LOAD_SECONDS = 100; // first job of a family on a server (measured: 105 s images, 146 s Wan video)
const BOOT_SECONDS = 240; // a stopped server to ready
const PICK_COST = 0.04; // one Claude vision pick over a handful of candidates

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
/**
 * How much bigger a job is than a past one: pixels and frames where both say (a past image.edit with no size, which
 * kept its input's size, can't be compared by pixels with one at 1280x704), and the count.
 */
export function scaleFrom(cur: Record<string, any>, past: Record<string, any>) {
  const px = (p: Record<string, any>) => (Number(p.width) || 0) * (Number(p.height) || 0);
  const frames = (p: Record<string, any>) => Number(p.frames) || Number(p.length) || 0;
  let r = (Number(cur.count) || 1) / (Number(past.count) || 1);
  if (px(cur) && px(past)) r *= px(cur) / px(past);
  if (frames(cur) && frames(past)) r *= frames(cur) / frames(past);
  return r;
}

function history(tool: string) {
  const rows = db.prepare(
    `SELECT params, gpu_seconds, cost FROM jobs WHERE tool = ? AND status = 'done' AND finished > ? ORDER BY finished DESC LIMIT 40`,
  ).all(tool, Date.now() - 120 * 86400_000) as { params: string; gpu_seconds: number; cost: number }[];
  return rows.map((r) => ({ params: JSON.parse(r.params || '{}'), gpu: r.gpu_seconds, cost: r.cost }));
}

function lineFor(tool: Tool, params: Record<string, any>, count: number, label: string): Line {
  const past = history(tool.id);
  if (tool.provider === 'comfy' || tool.family) {
    const gpuPast = past.filter((h) => h.gpu > 0);
    let per: number;
    let basis: string;
    if (gpuPast.length >= 2) {
      // Scaled by size, so a 81-frame 960p clip isn't priced like a 33-frame 480p one.
      per = median(gpuPast.map((h) => h.gpu * scaleFrom(params, h.params)));
      basis = `median of ${gpuPast.length} past jobs`;
    } else {
      per = tool.gpuSeconds?.(params) ?? 30;
      basis = 'the tool\'s own guess (no history yet)';
    }
    return { label, tool: tool.id, count, gpuSeconds: Math.round(per * count), apiCost: 0, family: (typeof tool.family === 'function' ? tool.family(params) : tool.family) ?? null, basis };
  }
  // Claude on the Max plan costs nothing per call (settings.claude.backend).
  if (tool.provider === 'anthropic' && loadSettings().brain === 'cursor') return { label, tool: tool.id, count, gpuSeconds: 0, apiCost: 0, family: null, basis: 'Cursor plan' };
  if (tool.provider === 'anthropic' && loadSettings().brain === 'copilot') return { label, tool: tool.id, count, gpuSeconds: 0, apiCost: 0, family: null, basis: 'Copilot plan' };
  if (tool.provider === 'anthropic' && loadSettings().claude.backend === 'max-plan') return { label, tool: tool.id, count, gpuSeconds: 0, apiCost: 0, family: null, basis: 'Claude Max plan ($0 per call)' };
  const costPast = past.map((h) => h.cost).filter((c) => c > 0);
  const per = costPast.length ? median(costPast) : tool.provider === 'anthropic' ? 0.05 : tool.provider === 'elevenlabs' ? 0.03 : 0;
  return { label, tool: tool.id, count, gpuSeconds: 0, apiCost: Math.round(per * count * 1000) / 1000, family: null, basis: costPast.length ? `median of ${costPast.length} past jobs` : 'a typical job' };
}

function resolve(project: string, it: EstimateItem): { tool: Tool; params: Record<string, any> } {
  const applied = applyPreset({ project, tool: it.tool, preset: it.preset, params: it.params ?? {} }, (id) => getTool(id)?.params ?? null);
  const tool = getTool(applied.tool ?? '');
  if (!tool) throw new GenError(`Unknown tool: ${applied.tool ?? it.tool ?? it.preset}`);
  let params: Record<string, any>;
  try {
    params = validateParams(tool, applied.params ?? {});
  } catch {
    params = applied.params ?? {}; // an estimate shouldn't fail on a missing prompt
  }
  return { tool, params };
}

export function estimate(project: string, items: EstimateItem[], opts: { servers?: number; running?: number } = {}) {
  if (!Array.isArray(items) || !items.length) throw new GenError('items: give a list of { tool | preset, params, count }');
  const lines: Line[] = [];
  for (const [i, it] of items.entries()) {
    const count = Math.max(0, Math.round(it.count ?? 1));
    if (!count) continue;
    const label = it.label ?? it.preset ?? it.tool ?? `item ${i + 1}`;
    const { tool, params } = resolve(project, it);
    if (tool.id === 'asset.make') {
      const steps: any[] = Array.isArray(params.steps) ? params.steps : [];
      const n = Math.max(1, Number(params.candidates) || 1);
      const pickAt = Math.min(steps.length, Math.max(1, Number(params.pickAt) || 1)) - 1;
      steps.forEach((s, k) => {
        const r = resolve(project, s);
        lines.push(lineFor(r.tool, r.params, count * (k === pickAt ? n : 1), `${label} · step ${k + 1}`));
      });
      const pick = ['cursor', 'copilot'].includes(loadSettings().brain) || loadSettings().claude.backend === 'max-plan' ? 0 : PICK_COST;
      if (n > 1) lines.push({ label: `${label} · pick`, tool: 'llm (pick)', count, gpuSeconds: 0, apiCost: pick * count, family: null, basis: loadSettings().brain === 'cursor' ? 'one Cursor pick per asset' : loadSettings().brain === 'copilot' ? 'one Copilot pick per asset' : 'one Claude pick per asset' });
      continue;
    }
    lines.push(lineFor(tool, params, count, label));
  }
  const fleet = loadSettings().fleet;
  const families = [...new Set(lines.filter((l) => l.gpuSeconds > 0).map((l) => l.family ?? l.tool))];
  const work = lines.reduce((s, l) => s + l.gpuSeconds, 0);
  const cap = Math.max(1, Math.min(fleet.servers, opts.servers ?? fleet.servers));
  // One server per ~20 GPU-minutes of work, up to the cap: more servers only pay off for big batches.
  const servers = work ? Math.min(cap, Math.max(1, Math.round(work / 1200))) : 0;
  const running = Math.min(servers, Math.max(0, opts.running ?? 0));
  const loads = families.length * MODEL_LOAD_SECONDS * Math.max(1, servers);
  const boots = (servers - running) * BOOT_SECONDS;
  const idle = servers * fleet.idleMinutes * 60;
  const gpuSeconds = work + loads + boots;
  const gpuCost = (gpuSeconds / 3600) * PRICE;
  const idleCost = (idle / 3600) * PRICE;
  const apiCost = lines.reduce((s, l) => s + l.apiCost, 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    project, lines,
    gpu: { work, modelLoads: loads, boots, seconds: gpuSeconds, hours: r2(gpuSeconds / 3600), servers, families, pricePerHour: PRICE },
    wallMinutes: servers ? Math.ceil((work / servers + loads / servers + (boots ? BOOT_SECONDS : 0)) / 60) : 0,
    cost: { gpu: r2(gpuCost), api: r2(apiCost), idleTail: r2(idleCost), total: r2(gpuCost + apiCost), withIdleTail: r2(gpuCost + apiCost + idleCost) },
    note: servers
      ? `${servers} server${servers > 1 ? 's' : ''} for about ${Math.ceil((gpuSeconds / servers) / 60)} min each. Stopping them when the batch ends saves the idle tail (${fleet.idleMinutes} min each, $${r2(idleCost)}).`
      : 'No GPU work.',
  };
}
