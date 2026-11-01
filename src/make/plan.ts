// The plan for one request (docs/make.md): the routed tool and its fallbacks, each with its params and inputs, the
// world's look (style line, negative, style board, canon) and the cast's identity (references, fixed descriptions, a
// LoRA) applied, the thresholds and the budget. Pure: the tool hands it the world, the identity and what it knows about
// each tool.

import crypto from 'node:crypto';
import { DEFAULT_THRESHOLDS } from '../quality/index.ts';
import type { WorldContext } from '../worlds.ts';
import { route, type MakeRequest } from './index.ts';
import type { RouteContext, RoutingData, ToolRoute } from './routing.ts';
import type { Kind, MakePlan, ToolPlan } from './loop.ts';
import type { MakeSettings } from './settings.ts';

export type ToolInfo = { output: string; params: Record<string, { type?: string; default?: unknown }>; inputs: Record<string, { required?: boolean; multiple?: boolean }> };

/** Who must be on-model: their reference assets (best first), local files of them for the face check, their fixed descriptions, a LoRA. */
export type IdentityInfo = { refs: string[]; files: string[]; words: string; lora: string | null };

export type PlanEnv = {
  data: RoutingData;
  settings: MakeSettings;
  world: WorldContext | null;
  identity: IdentityInfo;
  /** Local files of the world's style board (for the style check). */
  boardFiles?: string[];
  toolInfo: (id: string) => ToolInfo | null;
  routeCtx?: RouteContext;
};

const KINDS: Kind[] = ['image', 'video', 'mesh', 'audio'];

/** The request's prompt with the world's style line; a fixed identity description first when someone must be on-model. */
export function promptFor(req: Pick<MakeRequest, 'brief' | 'params'>, key: string, env: Pick<PlanEnv, 'world' | 'identity'>): string {
  const own = String(req.params?.[key] ?? '').trim() || req.brief.trim();
  const style = env.world?.look.style?.trim();
  const parts = [env.identity.words && !own.includes(env.identity.words) ? env.identity.words : '', own, style && !own.includes(style) ? style : ''];
  return parts.filter(Boolean).join(' ').slice(0, 4000);
}

export function buildPlan(req: Omit<MakeRequest, 'project'>, env: PlanEnv): MakePlan {
  const s = env.settings;
  const allowPaid = Boolean(req.allowPaid) && s.allowPaid;
  const r = route(req, { ...(env.routeCtx ?? {}), data: env.data, allowPaid, lora: Boolean(req.params?.lora || env.identity.lora) || undefined });

  const forTool = (id: string): ToolPlan | null => {
    const info = env.toolInfo(id);
    if (!info) return null;
    const entry: ToolRoute = env.data.tools[id] ?? { kind: (KINDS.includes(info.output as Kind) ? info.output : 'image') as Kind, prompt: 'prompt' in info.params ? 'prompt' : null, preview: null };
    const params: Record<string, any> = {};
    for (const [k, v] of Object.entries(req.params ?? {})) if (k in info.params && k !== 'seed' && k !== 'count') params[k] = v;
    // The final names the settings its preview lowers, so the two recipes differ only there.
    for (const k of Object.keys(entry.preview ?? {})) if (!(k in params) && info.params[k]?.default !== undefined) params[k] = info.params[k].default;
    if (entry.prompt) params[entry.prompt] = promptFor(req, entry.prompt, env);
    const neg = env.world?.look.negative?.trim();
    if (neg && entry.negative) params[entry.negative] = [params[entry.negative] ?? info.params[entry.negative]?.default ?? '', neg].filter((x) => String(x).trim()).join(', ');
    if ('lora' in info.params && !params.lora && env.identity.lora) params.lora = env.identity.lora;
    const inputs: Record<string, any> = {};
    for (const [k, v] of Object.entries(req.inputs ?? {})) if (k in info.inputs && v != null) inputs[k] = v;
    // A tool that names an input differently (video.i2v's start is the request's image).
    for (const [k, from] of Object.entries(entry.inputs ?? {})) if (inputs[k] == null && req.inputs?.[from] != null) inputs[k] = req.inputs[from];
    // References fill the tool's reference inputs that the request left empty, best first.
    const refs = env.identity.refs.map((a) => (a.startsWith('asset:') ? a : `asset:${a}`));
    let next = 0;
    for (const k of entry.refs ?? []) {
      if (next >= refs.length) break;
      if (info.inputs[k]?.multiple) {
        const cur = Array.isArray(inputs[k]) ? inputs[k] : inputs[k] ? [inputs[k]] : [];
        inputs[k] = [...cur, ...refs.slice(next).filter((x) => !cur.includes(x))].slice(0, 6);
        next = refs.length;
      } else if (inputs[k] == null) inputs[k] = refs[next++];
    }
    return { tool: id, entry, kind: entry.kind, params, inputs };
  };

  const first = forTool(r.tool);
  if (!first) throw new Error(`internal: ${r.tool} was routed but isn't a tool`);
  const canon = env.world?.canon?.length ? `\nThe world's rules, which it must not break: ${env.world.canon.join('; ')}` : '';
  const thresholds = { ...DEFAULT_THRESHOLDS, ...env.data.defaults.thresholds, ...s.thresholds };
  const budget = req.budgetCredits != null ? Math.max(0, Math.round(req.budgetCredits)) : s.defaultBudget;
  const styleWords = env.world?.look.style?.trim() || '';
  const board = env.boardFiles ?? [];
  return {
    quality: req.quality ?? 'final',
    brief: `${req.brief.trim()}${canon}`,
    why: r.why,
    first,
    fallbacks: r.fallbacks,
    forTool,
    identityRefs: env.identity.files,
    identityWords: env.identity.words,
    style: styleWords || board.length ? { ...(board.length ? { refs: board } : {}), ...(styleWords ? { words: styleWords } : {}) } : null,
    thresholds,
    previews: Math.max(1, Math.min(3, env.data.defaults.previews)),
    heroCandidates: Math.max(3, Math.min(4, env.data.defaults.heroCandidates)),
    maxRetries: Math.max(0, Math.min(2, s.maxRetries, env.data.defaults.maxRetries)),
    budget,
    baseSeed: Number(req.params?.seed) || seedOf(req),
    checkCredits: s.checkCredits,
    compareCredits: s.compareCredits,
  };
}

/** Seeds come from the request, so asking again asks for the same takes (and the library hands them back). */
export function seedOf(req: Omit<MakeRequest, 'project'>): number {
  const h = crypto.createHash('sha256').update(JSON.stringify([req.intent, req.brief, req.tool ?? null, req.params ?? {}, req.inputs ?? {}, req.refs ?? {}, req.world ?? null])).digest('hex');
  return (parseInt(h.slice(0, 7), 16) % 2_000_000_000) + 1;
}
