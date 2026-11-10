// make.checked: the making loop as a job (docs/make.md). Params are a MakeRequest without `project`; the result is a
// MakeOutcome. Like asset.make and the chains in chain.ts it is a `pipeline` tool: every render is a child job queued
// through Gen's own API on Gen's key (labels.parent, a stable key so a resumed parent finds its children, `reuse` so a
// recipe the library has is never paid again), and the caller is charged once, at the parent's quote: the loop's worst
// case, capped by the budget (`quote` below, read by billing.ts quoteJobCredits).
//
// This module must not import src/tools/index.ts (or anything that does) at the top: tools/index imports it. What it
// needs from there is loaded inside run().

import fs from 'node:fs';
import type { Tool, RunContext } from '../tools/types.ts';
import { GenError } from '../util.ts';
import { canProject, type Client } from '../auth.ts';
import { canUseBlob, getAsset } from '../library.ts';
import { ensureLocal, localPath } from '../storage.ts';
import { ask, usageOf } from '../providers/anthropic.ts';
import { videoFrames } from '../tools/pipeline.ts';
import { assess } from '../quality/index.ts';
import { worldContext, worldOf } from '../worlds.ts';
import { identityPack } from '../identity.ts';
import type { MakeRequest, MakeIntent } from './index.ts';
import { routing } from './routing.ts';
import { buildPlan, type IdentityInfo, type ToolInfo } from './plan.ts';
import { runLoop, worstCase, ProviderFailure, type MakeDeps, type Take } from './loop.ts';
import { makeSettings } from './settings.ts';
// @ts-ignore: plain JS client
import { HawkesGen } from '../../clients/js/hawkesgen.mjs';
import { SELF_TOKEN, SELF_URL } from '../auth.ts';
import { loadSettings } from '../config.ts';
import { toolReady } from '../providers/gpu/route.ts';

export const MAKE_INTENTS: MakeIntent[] = [
  'image', 'character-sheet', 'first-frame', 'texture', 'skybox', 'prop-3d', 'character-3d',
  'shot-action', 'shot-dialogue', 'shot-two-people', 'shot-continue', 'shot-recast', 'voice', 'sfx', 'music', 'animation',
];

// ------------------------------------------------------------------------------------------------ test seams

type Gen = { submit: (tool: string, o: any) => Promise<any>; wait: (id: string, o: any) => Promise<any> };
let clientFor: ((ctx: RunContext) => Gen) | null = null;
let depsOverride: Partial<MakeDeps> | null = null;
/** Tests only: a fake Gen for the children (null puts the real one back). */
export function _setMakeClient(f: ((ctx: RunContext) => Gen) | null) {
  clientFor = f;
}
/** Tests only: replace any of the loop's deps (assess, compare, quote...). */
export function _setMakeDeps(d: Partial<MakeDeps> | null) {
  depsOverride = d;
}

// ------------------------------------------------------------------------------------------------ the request

/** The request a job's params carry. */
export function requestOf(p: Record<string, any>): Omit<MakeRequest, 'project'> {
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined);
  const refs = obj(p.refs);
  return {
    intent: p.intent,
    brief: String(p.brief ?? ''),
    ...(p.tool ? { tool: String(p.tool) } : {}),
    params: obj(p.params) ?? {},
    inputs: obj(p.inputs) ?? {},
    refs: { identity: Array.isArray(refs?.identity) ? refs!.identity.map(String) : [], style: Array.isArray(refs?.style) ? refs!.style.map(String) : [] },
    world: p.world ? String(p.world) : null,
    ...(p.budgetCredits != null ? { budgetCredits: Number(p.budgetCredits) } : {}),
    quality: p.quality ?? 'final',
    allowPaid: Boolean(p.allowPaid),
  };
}

/** Every file reference a request carries (inputs, references, a LoRA): what admit checks against the caller. */
export function refsOf(req: Omit<MakeRequest, 'project'>): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(req.inputs ?? {});
  walk(req.refs?.style ?? []);
  if (req.params?.lora) walk(req.params.lora);
  return out;
}

const ASSET_ID = /^a_[0-9a-f]{6,}$/;

/** The files of the first `max` of these image assets that can be had on this instance (restored from storage first). */
async function localImages(ids: string[], max: number): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= max) break;
    const a = getAsset(id);
    if (a?.kind === 'image' && (await ensureLocal(a))) out.push(a.path);
  }
  return out;
}

/** Who must be on-model: asset ids as they are, character scenes through their identity pack. */
async function identityOf(req: Omit<MakeRequest, 'project'>, project: string): Promise<IdentityInfo> {
  const refs: string[] = [];
  const words: string[] = [];
  let lora: string | null = null;
  const { getScene } = await import('../scenes.ts');
  for (const r of req.refs?.identity ?? []) {
    const id = r.replace(/^asset:/, '');
    if (ASSET_ID.test(id)) { refs.push(id); continue; }
    try {
      const s = getScene(id, (p) => p === project, 'character' as any);
      const pack = identityPack(s.doc);
      refs.push(...pack.refs);
      if (pack.description) words.push(pack.description);
      if (!lora && pack.lora) lora = pack.lora.asset;
    } catch { /* not a character this project can see: left out */ }
  }
  const uniq = [...new Set(refs)];
  const files = await localImages(uniq, 4);
  return { refs: uniq, files, words: words.join(' '), lora };
}

const infoOf = (t: Tool | null): ToolInfo | null => (t ? { output: t.output, params: t.params, inputs: t.inputs } : null);

// ------------------------------------------------------------------------------------------------ the real deps

const COMPARE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['winner', 'why', 'refine'],
  properties: {
    winner: { type: 'integer', description: '0 for the first take, 1 for the second' },
    why: { type: 'string' },
    refine: { type: 'string', description: 'The winning take\'s prompt, rewritten to fix what is still wrong with it (the same subject and length; say what to change, not what is fine)' },
  },
};

async function viewsOf(t: Take, ctx: RunContext, k: string): Promise<string[]> {
  if (/\.(png|jpe?g|webp)$/i.test(t.file)) return [t.file];
  if (/\.(mp4|webm|mov)$/i.test(t.file)) return videoFrames(t.file, ctx.tmp(`cmp-${k}`), ctx.signal).catch(() => []);
  return [];
}

function realDeps(ctx: RunContext, quoteChild: (tool: string, params: Record<string, any>) => number): MakeDeps & { siblings: Map<string, any[]> } {
  /** A motion take's other outputs (the clip's GLB, FBX, BVH), by the asset that was judged (its preview video). */
  const siblings = new Map<string, any[]>();
  const gen: Gen = clientFor ? clientFor(ctx) : new HawkesGen({ url: SELF_URL(), key: SELF_TOKEN, project: ctx.job.project });
  return {
    siblings,
    async render(s) {
      let job: any;
      try {
        job = await gen.submit(s.tool, { params: s.params, inputs: s.inputs, labels: { parent: ctx.job.id, step: s.name }, key: `${ctx.job.id}:${s.name}:${s.tool}`, reuse: true });
      } catch (e: any) {
        if (Number(e?.status) >= 500) throw new ProviderFailure(String(e?.message ?? e));
        throw e;
      }
      ctx.log(`${s.name}: ${job.tool} (${job.id}${job.reused ? ', from the library' : ''})`);
      const done = ['done', 'failed', 'cancelled'].includes(job.status) ? job : await gen.wait(job.id, { throwOnFail: false, signal: ctx.signal, onUpdate: (j: any) => ctx.step(`${s.name}: ${j.detail}`) });
      if (done.status === 'cancelled' && ctx.signal.aborted) throw new GenError('cancelled');
      // A child that failed (its servers, its model, a timeout) hands the same request to the next tool.
      if (done.status !== 'done') throw new ProviderFailure(`${done.tool} ${done.status}: ${done.error ?? done.detail ?? ''}`);
      // A humanoid clip (motion.from-text / from-video) is judged moving: its preview video is the take; the clip's
      // GLB, FBX and BVH ride along and come back with the result.
      const motion = /^motion\.from-/.test(String(done.tool));
      const o = motion
        ? (done.outputs ?? []).find((x: any) => x.kind === 'video' || /preview/.test(String(x.title))) ?? done.outputs?.[0]
        : (done.outputs ?? []).find((x: any) => x.kind === 'mesh') ?? done.outputs?.[0];
      const a = o ? getAsset(o.asset) : null;
      if (!a) throw new ProviderFailure(`${done.tool} made nothing`);
      if (motion) siblings.set(a.id, (done.outputs ?? []).filter((x: any) => x.asset !== a.id));
      return { asset: a.id, file: await localPath(a, `${done.tool}'s take`), job: done.id, reused: Boolean(job.reused) };
    },
    assess: (a) => assess(a),
    quote: quoteChild,
    async compare(a, b, brief) {
      const [va, vb] = await Promise.all([viewsOf(a, ctx, 'a'), viewsOf(b, ctx, 'b')]);
      // What Claude can't look at (a mesh, a sound) is decided by the checks' scores.
      if (!va.length || va.length !== vb.length) return { winner: b.score > a.score ? 1 : 0, why: 'by the checks\' scores' };
      const promptKey = Object.keys(a.params).find((k) => ['prompt', 'text', 'look'].includes(k));
      const r = await ask({
        system: 'You are a film and art director judging two takes made for the same brief. Choose the one that better fits the brief: the right subject and action, on-model with the people described, no broken hands, faces or text, the intended look. Then rewrite the winner\'s prompt so a new take fixes what is still wrong.',
        prompt: `Brief: ${brief.slice(0, 3000)}\nThe winner's prompt now: ${promptKey ? String(a.params[promptKey]).slice(0, 2000) : '(none)'} / ${promptKey ? String(b.params[promptKey]).slice(0, 2000) : ''}\nThe first ${va.length} image(s) are take 0${va.length > 1 ? ' (start, middle, end)' : ''}; the next ${vb.length} are take 1.`,
        images: [...va, ...vb], schema: COMPARE_SCHEMA, effort: 'medium', maxTokens: 3000,
      }, ctx.signal);
      ctx.usage(usageOf(r, `${r.model} compare`));
      const j = JSON.parse(r.text);
      return { winner: Number(j.winner) === 1 ? 1 : 0, why: String(j.why ?? ''), refine: String(j.refine ?? '') };
    },
    log: (l) => ctx.log(l),
    step: (d) => ctx.step(d),
  };
}

// ------------------------------------------------------------------------------------------------ the tool

export const makeCheckedTool: Tool = {
  id: 'make.checked',
  version: 1,
  title: 'Make it, checked',
  description:
    'Makes what you describe and checks it before you see it. Gen picks the tool for what it is (a still, a dialogue close-up, ' +
    'an action shot on the stage, two people in a scene, a sound...), applies the world\'s look and the cast\'s references, ' +
    'makes cheap previews, checks each against the brief (yes/no questions, faces, faults, the look), makes the best one at full ' +
    'quality with the same seed, checks it again, and fixes and retries what fails (at most twice, never past the budget). ' +
    'quality: draft (one take, one check), final (previews then the final), hero (several finals compared in pairs, the winner refined).',
  provider: 'pipeline',
  output: 'file',
  inputs: {},
  params: {
    intent: { type: 'enum', required: true, values: MAKE_INTENTS, description: 'What is being made: the router picks a tool for it.' },
    brief: { type: 'text', required: true, description: 'What it should be, in words: the prompt and what the checks judge against.' },
    quality: { type: 'enum', values: ['draft', 'final', 'hero'], default: 'final', description: 'draft: one take; final: previews then the final; hero: a tournament.' },
    budgetCredits: { type: 'integer', min: 1, max: 100_000, description: 'The most this may spend, retries included (default: the owner\'s setting).' },
    world: { type: 'string', description: 'The world scene it belongs to: its look and canon apply.' },
    refs: { type: 'json', description: '{ identity: [asset ids or character scene ids], style: [asset ids] }', advanced: true },
    inputs: { type: 'json', description: 'Files for the tool by input name (asset:<id> or blob:<sha256>): image, audio, control (a depth video), video...', advanced: true },
    params: { type: 'json', description: 'Settings for the tool (seconds, width, people...); anything the tool doesn\'t take is ignored.', advanced: true },
    tool: { type: 'string', description: 'Pin a tool instead of routing.', advanced: true },
    allowPaid: { type: 'boolean', default: false, description: 'Partner models billed per call may be used (the owner must allow them too).', advanced: true },
  },
  guard({ params }) {
    if (!String(params.brief ?? '').trim()) throw new GenError('Say what to make (brief)');
    if (params.tool === 'make.checked' || params.tool === 'asset.make') throw new GenError('make.checked cannot pin itself or asset.make');
  },
  admit({ params, client: c }) {
    const req = requestOf(params);
    const client = c as Client;
    const owner = client.projects.includes('*');
    // Children run on Gen's key, so every file the request names is checked against the caller here.
    for (const ref of refsOf(req)) {
      if (ref.startsWith('motion:')) continue;
      const id = ref.startsWith('asset:') ? ref.slice(6) : ASSET_ID.test(ref) ? ref : null;
      if (id) {
        const a = getAsset(id);
        if (!a || !canProject(client, a.project)) throw new GenError(`No access to ${ref}`, { status: 403 });
      } else if (ref.startsWith('blob:')) {
        if (!canUseBlob(client, ref.slice(5))) throw new GenError(`No blob ${ref.slice(5)}`, { status: 404 });
      } else if (!owner || client.role !== 'owner') throw new GenError(`Send files as asset:<id> or blob:<sha256> (${ref.slice(0, 60)})`, { status: 403 });
    }
    for (const r of req.refs?.identity ?? []) {
      const id = r.replace(/^asset:/, '');
      if (ASSET_ID.test(id)) {
        const a = getAsset(id);
        if (!a || !canProject(client, a.project)) throw new GenError(`No access to ${r}`, { status: 403 });
      }
    }
    // Customers pin only the generative tools the router knows (never the studio's machinery).
    if (req.tool && client.role !== 'owner' && !routing().tools[req.tool]) throw new GenError(`make.checked can't pin ${req.tool}`, { status: 403 });
    return params;
  },
  quote(params, q) {
    const req = requestOf(params);
    try {
      const plan = buildPlan(req, { data: routing(), settings: makeSettings(), world: null, identity: { refs: (req.refs?.identity ?? []).map((r) => r.replace(/^asset:/, '')), files: [], words: '', lora: null }, toolInfo: (id) => infoOf(q.getTool(id)), routeCtx: { has: (id) => Boolean(q.getTool(id)) } });
      const w = worstCase(plan, q.child);
      return { credits: Math.max(1, w.credits), breakdown: [...w.lines, ...(w.credits < w.uncapped ? [{ label: `capped at the budget (${plan.budget})`, credits: w.credits - w.uncapped }] : [])], tool: plan.first.tool };
    } catch {
      return null;
    }
  },
  async run(ctx) {
    const { getTool } = await import('../tools/index.ts');
    const { childCredits } = await import('../billing.ts');
    const { isDown } = await import('../providers/gpu/health.ts');
    const { awsConfig } = await import('../providers/comfy/fleet.ts');
    const project = ctx.job.project;
    const req = requestOf(ctx.params);
    const fleetDown = (() => { try { awsConfig(); return Boolean(isDown('fleet')); } catch { return true; } })();
    const gpuSettings = (() => { try { return loadSettings(); } catch { return null; } })();
    const worldId = worldOf({ world: req.world }) ?? req.world ?? null;
    const world = worldId ? worldContext(project, worldId) : null;
    if (worldId && !world) ctx.log(`world ${worldId}: none to apply (yet)`);
    const identity = await identityOf(req, project);
    const boardIds = [...(world?.look.board ?? []), ...(req.refs?.style ?? []).map((s) => s.replace(/^asset:/, ''))];
    const boardFiles = await localImages(boardIds, 6);
    const plan = buildPlan(req, {
      data: routing(), settings: makeSettings(), world, identity, boardFiles,
      toolInfo: (id) => infoOf(getTool(id)),
      routeCtx: {
        has: (id) => Boolean(getTool(id)),
        ready: (id) => toolReady(getTool(id), { fleetDown, settings: gpuSettings }),
        inputsOf: (id) => getTool(id)?.inputs ?? null,
      },
    });
    ctx.log(`${req.intent} (${plan.quality}): ${plan.first.tool}${plan.fallbacks.length ? `, then ${plan.fallbacks.join(', ')}` : ''}: ${plan.why}${world ? `; world "${world.title}"` : ''}${identity.refs.length ? `; ${identity.refs.length} reference(s)` : ''}; budget ${plan.budget ?? 'none'}`);
    const quoteChild = (tool: string, params: Record<string, any>) => {
      try { return childCredits(tool, params, project); } catch { return 0; }
    };
    const deps = { ...realDeps(ctx, quoteChild), ...(depsOverride ?? {}) } as MakeDeps;
    const outcome = await runLoop(plan, deps);
    const a = outcome.asset ? getAsset(outcome.asset) : null;
    if (a) {
      await ctx.emit({ data: fs.readFileSync(await localPath(a, 'the chosen take')), mime: a.mime, seed: a.seed, title: 'result', meta: { from: a.id, pass: Boolean(outcome.report?.pass), tries: outcome.tries, tool: outcome.tool, ...(outcome.needsYou ? { needsYou: outcome.needsYou } : {}) } });
      // A humanoid clip: the result is its preview video; the clip itself (GLB, FBX, BVH) comes back beside it.
      for (const o of (deps as any).siblings?.get(a.id) ?? []) {
        const b = getAsset(o.asset);
        if (b && (await ensureLocal(b))) await ctx.emit({ data: fs.readFileSync(b.path), mime: b.mime, seed: b.seed, title: String(o.title ?? b.title ?? 'clip'), meta: { from: b.id, tool: outcome.tool } });
      }
    }
    ctx.result({ ...outcome, intent: req.intent, quality: plan.quality, budget: plan.budget });
  },
};
