// The film pipeline's tools (docs/film-pipeline.md):
//
//   film.gate  the director gate: four cheap eevee frames of a shot as a contact sheet, judged by Claude Vision against a strict
//              rubric, adjusted and re-checked (twice at most) before any ComfyUI or Cycles spend. Hands the approved shot on
//              in its result (asset.make step params: "$step1.result.shot").
//   film.plan  a recipe (cinema pass, dialogue close-up, layered VFX, character LoRA, the trailer) built from a shot and a few
//              choices, linted, and priced with Hawkes Gen's own estimate. Free, no GPU: it only plans.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError, run } from '../util.ts';
import { getAsset } from '../library.ts';
import { ensureLocal } from '../storage.ts';
import { ask, usageOf } from '../providers/anthropic.ts';
// @ts-ignore: plain JS client
import { HawkesGen } from '../../clients/js/hawkesgen.mjs';
import { SELF_TOKEN, SELF_URL } from '../auth.ts';
import { shotFrames } from './blender.ts';
import { GATE_SYSTEM, STILL_SHARES, VERDICT_SCHEMA, runGate, type RenderOut, type Verdict } from '../film/gate.ts';
import { lintShot, type Shot } from '../film/shot.ts';
import { cinemaPass, dialogueCloseup, vfxLayers, characterLora, trailerCut, lineSeconds, type Recipe, type TrailerShot } from '../film/recipes.ts';
import { estimate } from '../estimate.ts';

/** Four stills tiled 2x2 into one contact sheet (top-left, top-right, bottom-left, bottom-right in order). */
export async function tileSheet(stills: string[], out: string, signal?: AbortSignal) {
  if (stills.length !== 4) throw new GenError(`A contact sheet needs 4 stills, got ${stills.length}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...stills.flatMap((f) => ['-i', f]),
    '-filter_complex', '[0:v][1:v]hstack=inputs=2[a];[2:v][3:v]hstack=inputs=2[b];[a][b]vstack=inputs=2[out]', '-map', '[out]', '-frames:v', '1', out];
  await run('ffmpeg', args, { signal });
  if (!fs.existsSync(out)) throw new GenError('ffmpeg made no contact sheet');
}

type GenLike = { submit(tool: string, opts: Record<string, unknown>): Promise<any>; wait(id: string, opts?: Record<string, unknown>): Promise<any> };

/**
 * One look: the shot as four eevee stills (a blender.render job, reused when the library has it), tiled into the contact sheet,
 * with where Blender says each character stood in each (and how the walk clips' feet kept pace).
 */
export async function previewRender(
  gen: GenLike,
  ctx: { job: { id: string }; step(s: string): void; tmp(n: string): string; signal: AbortSignal },
  o: { shot: Shot; frames: number; fps: number; width: number; height: number; engine: string; files: string[] },
  attempt: number,
): Promise<RenderOut> {
  ctx.step(`look ${attempt + 1}: four eevee frames`);
  const job = await gen.submit('blender.render', {
    params: { shot: o.shot, frames: o.frames, fps: o.fps, width: o.width, height: o.height, passes: [], stills: STILL_SHARES, engine: o.engine, samples: 16 },
    inputs: { files: o.files },
    labels: { parent: ctx.job.id, step: `gate-${attempt}` }, reuse: true,
  });
  const done = job.status === 'done' ? job : await gen.wait(job.id, { throwOnFail: false, signal: ctx.signal });
  if (done.status !== 'done') throw new GenError(`the gate's preview render ${done.status}: ${done.error ?? done.detail}`);
  const stills: string[] = [];
  for (const x of (done.outputs ?? [])
    .filter((x: any) => /^still \d+$/i.test(String(x.title ?? '')))
    .sort((a: any, b: any) => parseInt(String(a.title).slice(6)) - parseInt(String(b.title).slice(6)))) {
    const a = getAsset(x.asset);
    if (a && (await ensureLocal(a))) stills.push(a.path);
  }
  if (stills.length !== 4) throw new GenError(`the preview made ${stills.length} stills, not 4`);
  const sheet = ctx.tmp(`sheet-${attempt}.png`);
  await tileSheet(stills, sheet, ctx.signal);
  const r = done.result ?? {};
  if (!Array.isArray(r.stills) || r.stills.length !== 4) throw new GenError('the preview did not say where the characters stood (blender.render result.stills)');
  return { sheet, job: done.id, stills: r.stills, characters: (r.characters ?? []).map((c: any) => ({ index: c.index, segments: c.segments })) };
}

export const filmGateTool: Tool = {
  id: 'film.gate',
  version: 1,
  title: 'Director gate (contact sheet, Claude Vision)',
  description:
    'Checks a Blender shot before any ComfyUI or Cycles spend: renders four fast eevee frames (t = 0, 33, 66, 100%), tiles them into a contact sheet and ' +
    'has Claude Vision judge it against a strict rubric (prop visibly gripped, nobody occluding the speaker\'s face, characters facing who they interact with, ' +
    'the character really travelled instead of moonwalking). On failure it adjusts coordinates and angles and checks again, up to maxTries times. ' +
    'The result has the approved shot (result.shot), what it changed and the verdict. docs/film-pipeline.md.',
  provider: 'pipeline',
  output: 'json',
  inputs: { files: { kind: 'file', multiple: true, max: 24, description: 'The same files the shot renders with (characters[].file = 0 is the first).' } },
  params: {
    shot: { type: 'json', required: true, description: 'The shot (blender.render\'s shot; speaker is the character who talks).' },
    seconds: { type: 'number', min: 0.4, max: 30, default: 5, description: 'The length of the real shot (the beats are checked over it).' },
    fps: { type: 'integer', min: 8, max: 60, default: 24, description: 'Frame rate of the real shot.' },
    width: { type: 'integer', min: 256, max: 2048, default: 1280, description: 'The real shot\'s size (the contact sheet keeps its shape).' },
    height: { type: 'integer', min: 256, max: 2048, default: 704 },
    intent: { type: 'json', description: 'More to check: { faces: [[a, b]], notes: "what the director wants" }.' },
    maxTries: { type: 'integer', min: 0, max: 3, default: 2, description: 'Adjust-and-check rounds after the first look.' },
    engine: { type: 'enum', values: ['eevee', 'workbench'], default: 'eevee', advanced: true },
    onFail: { type: 'enum', values: ['stop', 'continue'], default: 'stop', description: 'stop: fail the job (and so the recipe) when the shot still fails; continue: pass the best shot on.' },
  },
  gpuSeconds: () => 60,
  async run(ctx) {
    const p = ctx.params;
    const shot = (typeof p.shot === 'string' ? JSON.parse(p.shot) : p.shot) as Shot;
    if (!shot || typeof shot !== 'object') throw new GenError('shot must be an object');
    const files: string[] = ctx.inputs.files ?? [];
    const frames = shotFrames({ seconds: p.seconds, fps: p.fps });
    const seconds = (frames - 1) / p.fps;
    const cw = 640;
    const ch = Math.max(2, Math.round((cw * p.height) / p.width / 2) * 2);
    const gen = new HawkesGen({ url: SELF_URL(), key: SELF_TOKEN, project: ctx.job.project });
    const sheets: string[] = [];

    const render = async (s: Shot, attempt: number): Promise<RenderOut> => {
      const out = await previewRender(gen, ctx, { shot: s, frames, fps: p.fps, width: cw, height: ch, engine: p.engine, files }, attempt);
      sheets.push(out.sheet);
      return out;
    };

    const judge = async (input: { prompt: string; sheet: string }): Promise<Verdict> => {
      ctx.step('Claude is judging the contact sheet');
      const r = await ask({ system: GATE_SYSTEM, prompt: input.prompt, images: [input.sheet], schema: VERDICT_SCHEMA, effort: 'medium', maxTokens: 4000 }, ctx.signal);
      ctx.usage(usageOf(r, `${r.model} gate`));
      return JSON.parse(r.text);
    };

    const res = await runGate({ shot, seconds, intent: p.intent ?? {}, maxTries: p.maxTries, nFiles: files.length, render, judge, log: (l) => ctx.log(l) });
    const emits: { data: Buffer; ext: string; title: string }[] = sheets.map((f, i) => ({ data: fs.readFileSync(f), ext: '.png', title: `contact sheet ${i + 1}` }));
    emits.push({ data: Buffer.from(JSON.stringify(res.shot, null, 2)), ext: '.json', title: 'shot' });
    for (let i = ctx.done; i < emits.length; i++) await ctx.emit(emits[i]);
    ctx.result({
      pass: res.pass, shot: res.shot, tries: res.tries, summary: res.summary,
      rounds: res.rounds.map((r) => ({ attempt: r.attempt, job: r.job, findings: r.findings, summary: r.summary, applied: r.applied })),
    });
    if (!res.pass && p.onFail === 'stop') throw new GenError(`The shot did not pass the director gate after ${res.tries} adjustment${res.tries === 1 ? '' : 's'}: ${res.summary}`);
  },
};

// ---------------------------------------------------------------- film.plan

type ShotSpec = { id: string; kind: 'wide' | 'closeup' | 'vfx'; options: any; seconds?: number; dialogue?: { text?: string; seconds?: number } };

/** Builds one recipe by name. */
export function buildRecipe(kind: string, options: any): Recipe {
  switch (kind) {
    case 'cinema': return cinemaPass(options);
    case 'dialogue': return dialogueCloseup(options);
    case 'vfx': return vfxLayers(options);
    case 'lora': return characterLora(options);
    default: throw new GenError(`Unknown recipe ${kind} (cinema, dialogue, vfx, lora, trailer)`);
  }
}

const asItem = (r: Recipe, label: string) => ({
  tool: 'asset.make', label, count: 1,
  params: { steps: r.steps, candidates: r.candidates, pickAt: r.pickAt, pick: r.pick, ...(r.refs ? { refs: r.refs } : {}) },
});

/** The shot's lint, for the recipes that have one. */
function lintFor(options: any, recipe: Recipe) {
  if (!options?.shot) return [];
  const seconds = Number(options.seconds ?? 5);
  return lintShot(options.shot, seconds, recipe.files.length).issues;
}

export const filmPlanTool: Tool = {
  id: 'film.plan',
  version: 1,
  title: 'Plan a film recipe (and price it)',
  description:
    'Builds a film recipe from a shot and a few choices, lints the shot, and prices it with this service\'s own estimate (no GPU, free). recipe: cinema (gate, Blender render, ' +
    'look best-of-3, relight, restore, video.control, upscale, interpolate), dialogue (close-up with a lip-synced voice line), vfx (an effect on one of two characters, ' +
    'composited), lora (turntable stills train a character LoRA) or trailer (a list of shots: each one\'s recipe, the cut at trailer pace, and the whole cost). ' +
    'The result\'s recipe.steps go straight into asset.make (or a project\'s hawkes.assets.json). docs/film-pipeline.md has every option.',
  provider: 'local',
  output: 'json',
  inputs: {},
  params: {
    recipe: { type: 'enum', values: ['cinema', 'dialogue', 'vfx', 'lora', 'trailer'], required: true },
    options: { type: 'json', required: true, description: 'The recipe\'s options (docs/film-pipeline.md). trailer: { shots: [{ id, kind: wide | closeup | vfx, options, seconds, dialogue }], music }.' },
    estimate: { type: 'boolean', default: true, description: 'Also price it (GPU time from past jobs, else the tools\' own guess).' },
  },
  async run(ctx) {
    const kind = ctx.params.recipe as string;
    const options = typeof ctx.params.options === 'string' ? JSON.parse(ctx.params.options) : ctx.params.options;
    const project = ctx.job.project;
    if (kind !== 'trailer') {
      const recipe = buildRecipe(kind, options);
      const lint = lintFor(options, recipe);
      const est = ctx.params.estimate ? estimate(project, [asItem(recipe, kind)]) : null;
      ctx.result({ recipe, lint, estimate: est });
      return;
    }
    const shots: ShotSpec[] = options?.shots;
    if (!Array.isArray(shots) || !shots.length) throw new GenError('trailer: options.shots is a list of { id, kind, options }');
    const kinds: Record<string, string> = { wide: 'cinema', closeup: 'dialogue', vfx: 'vfx' };
    const planned = shots.map((s) => {
      if (!kinds[s.kind]) throw new GenError(`shot ${s.id}: kind is wide, closeup or vfx`);
      const recipe = buildRecipe(kinds[s.kind], s.options);
      return { spec: s, recipe, lint: lintFor(s.options, recipe) };
    });
    const trailerShots: TrailerShot[] = planned.map(({ spec, recipe }) => {
      if (spec.kind === 'closeup') {
        const talk = recipe.steps.find((x) => x.tool === 'video.talk')!.params as { frames: number; fps: number };
        const secs = (2 * talk.frames) / talk.fps;
        return { id: spec.id, kind: 'closeup', clip: `shot:${spec.id}`, seconds: secs, dialogue: { audio: `voice:${spec.id}`, text: spec.options.line, seconds: Number(spec.dialogue?.seconds ?? spec.options.seconds ?? lineSeconds(spec.options.line)) } };
      }
      return { id: spec.id, kind: 'wide', clip: `shot:${spec.id}`, seconds: Number(spec.options?.seconds ?? 5) };
    });
    const cut = trailerCut(trailerShots, { music: options.music ? `music:trailer` : undefined, pace: options.pace, width: options.width, height: options.height, fps: options.fps });
    let total: ReturnType<typeof estimate> | null = null;
    const perShot = planned.map(({ spec, recipe, lint }) => {
      if (!ctx.params.estimate) return { id: spec.id, kind: spec.kind, recipe, lint, estimate: null };
      const e = estimate(project, [asItem(recipe, spec.id)]);
      return { id: spec.id, kind: spec.kind, recipe, lint, estimate: { gpuSeconds: e.gpu.work, api: e.cost.api, lines: e.lines } };
    });
    if (ctx.params.estimate) total = estimate(project, planned.map(({ spec, recipe }) => asItem(recipe, spec.id)), { servers: options.servers });
    ctx.result({ shots: perShot, cut, estimate: total });
  },
};
