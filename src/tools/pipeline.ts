// asset.make: one finished asset from a chain of tools, with best-of-N picking by Claude.
//
//   steps: [
//     { "preset": "material", "params": { "prompt": "cracked lab floor tiles" }, "save": "albedo" },
//     { "tool": "image.normals", "inputs": { "image": "$prev" }, "save": "normal" }
//   ]
//   candidates: 4, pick: "reads clearly at small size; matches the art direction"
//
// The first step runs `candidates` times (different seeds); Claude looks at them and picks one; the rest of the
// chain runs on the winner. "$prev" is the previous step's (first) output, "$step1".. any earlier step's, "$input:name"
// one of this job's inputs. Each step is a normal job (labelled with this one), queued through Hawkes Gen's own API,
// so the queue, fleet and library work as usual.
//
// Takes are paid for once: every step asks Gen for a finished job of exactly its recipe first (`reuse`), so changing a
// later step, the pick or the candidate count only makes what's new, and seeds come from the recipe so a re-run asks
// for the same takes. All candidates are queued together (one model load, side by side on several servers). Claude
// picks against the criteria, the art direction, the `canon` (character and world facts) and any reference images
// (`refs`); video candidates are judged from three frames each. Steps with "save" are kept as this job's outputs
// (titled by the save name), so projects can map them to files (Hawkes Studio's asset manifests do).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Tool } from './types.ts';
import { GenError, run } from '../util.ts';
import { getAsset } from '../library.ts';
import { ask } from '../providers/anthropic.ts';
// @ts-ignore: plain JS client
import { HawkesGen } from '../../clients/js/hawkesgen.mjs';

type StepSpec = { tool?: string; preset?: string; params?: Record<string, unknown>; inputs?: Record<string, unknown>; save?: string };

const PICK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['best', 'reason', 'ranking'],
  properties: {
    best: { type: 'integer', description: 'Index of the best candidate' },
    reason: { type: 'string' },
    ranking: { type: 'array', items: { type: 'integer' }, description: 'All candidate indexes, best first' },
  },
};

export const assetMakeTool: Tool = {
  id: 'asset.make',
  version: 3,
  title: 'Make an asset (chain + best of N)',
  description:
    'Runs a chain of tools as one recipe (e.g. generate a material, then its normal map; or generate a character, cut it out, ' +
    'upscale it). The first step can make several candidates (images or videos) and Claude picks the best against your criteria, ' +
    'the project\'s art direction, the canon and on-model references. Steps marked "save" become this job\'s outputs. Takes the ' +
    'library already has for the same recipe are reused, not paid for again. One recipe, so "is this asset up to date?" works ' +
    'for the whole chain.',
  provider: 'pipeline',
  output: 'file',
  inputs: { files: { kind: 'file', multiple: true, max: 16, description: 'Inputs the steps use as "$input:0", "$input:1"…' } },
  params: {
    steps: { type: 'json', required: true, description: 'The chain: [{ tool | preset, params, inputs, save }]' },
    candidates: { type: 'integer', default: 1, min: 1, max: 8, description: 'How many versions of the first step to make and choose from' },
    pick: { type: 'text', description: 'What makes a candidate the best (Claude chooses with this)' },
    style: { type: 'text', description: 'The art direction to judge against (default: the project\'s preset style line)', advanced: true },
    canon: { type: 'text', description: 'Canon the pick must respect: who the character is, what they wear and carry, what the world never shows', advanced: true },
    refs: { type: 'json', description: 'Input indexes shown to Claude as on-model references before the candidates, e.g. [0]', advanced: true },
    fresh: { type: 'boolean', default: false, description: 'Make new takes even when the library has this recipe (more choices)', advanced: true },
  },
  async run(ctx) {
    const steps = ctx.params.steps as StepSpec[];
    if (!Array.isArray(steps) || !steps.length) throw new GenError('steps must be a non-empty list');
    for (const [i, s] of steps.entries()) {
      if (!s.tool && !s.preset) throw new GenError(`step ${i + 1} needs a tool or a preset`);
      if (s.tool === 'asset.make') throw new GenError('A step of asset.make cannot be asset.make');
    }
    const gen = new HawkesGen({ url: `http://127.0.0.1:${process.env.HAWKESGEN_PORT || 8790}`, project: ctx.job.project });
    const inputFiles: string[] = ctx.inputs.files ?? [];
    const made: { job: string; outputs: any[] }[] = [];
    const chain: any[] = [];

    const resolve = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(resolve);
      if (typeof v !== 'string') return v;
      if (v === '$prev') return firstOf(made.length - 1);
      const st = /^\$step(\d+)$/.exec(v);
      if (st) return firstOf(Number(st[1]) - 1);
      const inp = /^\$input:(\d+)$/.exec(v);
      if (inp) {
        const f = inputFiles[Number(inp[1])];
        if (!f) throw new GenError(`no input ${inp[1]}`);
        return f;
      }
      return v;
    };
    const firstOf = (i: number) => {
      const o = made[i]?.outputs?.[0];
      if (!o) throw new GenError(`step ${i + 1} has no output to pass on`);
      return `asset:${o.asset}`;
    };

    // Seeds come from the recipe, so a re-run asks for the same takes (and the library hands them back).
    const base = Number(ctx.params.seed) || (parseInt(crypto.createHash('sha256').update(JSON.stringify(steps)).digest('hex').slice(0, 7), 16) % 2_000_000_000) + 1;
    const used: string[] = [];
    let reused = 0;
    const submitStep = async (i: number, s: StepSpec, extra: Record<string, unknown> = {}) => {
      const inputs = Object.fromEntries(Object.entries(s.inputs ?? {}).map(([k, v]) => [k, resolve(v)]));
      const job = await gen.submit(s.tool ?? null, {
        preset: s.preset, params: { ...(s.params ?? {}), ...extra }, inputs,
        labels: { parent: ctx.job.id, step: i + 1 }, key: `${ctx.job.id}:${i}:${JSON.stringify(extra)}`,
        reuse: ctx.params.fresh ? false : { exclude: [...used] },
      });
      if (job.reused) {
        reused++;
        if (job.outputs?.[0]?.asset) used.push(job.outputs[0].asset);
      }
      ctx.log(`step ${i + 1}: ${job.tool} (${job.id}${job.reused ? ', from the library' : ''})`);
      return job;
    };
    const waitStep = async (i: number, job: any) => {
      const done = job.status === 'done' ? job : await gen.wait(job.id, { throwOnFail: false, onUpdate: (j: any) => ctx.step(`step ${i + 1}/${steps.length} ${j.tool}: ${j.detail}`), signal: ctx.signal });
      if (done.status !== 'done') throw new GenError(`step ${i + 1} (${done.tool}) ${done.status}: ${done.error ?? done.detail}`);
      return done;
    };

    // Step 1, as candidates: all queued first, then waited on together.
    const n = Math.max(1, ctx.params.candidates ?? 1);
    const queued: any[] = [];
    for (let c = 0; c < n; c++) queued.push(await submitStep(0, steps[0], n > 1 || ctx.params.seed ? { seed: base + c } : {}));
    const firstJobs = await Promise.all(queued.map((j) => waitStep(0, j)));
    let winner = firstJobs[0];
    let picked: any = null;
    if (n > 1) {
      const outs = firstJobs.map((j) => j.outputs?.[0]).filter(Boolean);
      const assets = outs.map((o) => getAsset(o.asset)).filter(Boolean) as any[];
      // What Claude looks at per candidate: the image, or three frames of a video.
      const views: string[][] = [];
      for (const [k, a] of assets.entries()) {
        if (a.kind === 'image') views.push([a.path]);
        else if (a.kind === 'video') views.push(await videoFrames(a.path, ctx.tmp(`cand-${k}`), ctx.signal).catch(() => []));
        else views.push([]);
      }
      if (assets.length === outs.length && assets.length > 1 && views.every((v) => v.length === views[0].length && v.length)) {
        ctx.step(`Claude is choosing between ${assets.length} candidates`);
        const style = ctx.params.style ?? (await gen.presets(ctx.job.project).catch(() => null))?.style ?? '';
        const refIdx: number[] = Array.isArray(ctx.params.refs) ? ctx.params.refs.map(Number) : [];
        const refs = refIdx.map((i) => inputFiles[i]).filter((f) => f && /\.(png|jpe?g|webp|gif)$/i.test(f));
        const per = views[0].length;
        const layout = (refs.length ? `The first ${refs.length} image(s) are on-model references (what the subject must look like), not candidates. Then ` : 'The images are ') +
          (per > 1 ? `the candidates, ${per} frames each (start, middle, end of its video), candidates 0 to ${views.length - 1} in order.` : `the candidates 0 to ${views.length - 1}, in order.`);
        const r = await ask({
          system: 'You are the art director for a small game studio. Choose the candidate that best fits the brief, the criteria, the art direction and the canon. Prefer clean, usable game assets: correct subject, on-model with the references, readable silhouette, no artifacts, no text unless asked. A candidate that breaks canon loses even if it looks better.',
          prompt: `Brief (the first step's params): ${JSON.stringify(steps[0].params ?? {}).slice(0, 2000)}\n${steps[0].preset ? `Preset: ${steps[0].preset}\n` : ''}Criteria: ${ctx.params.pick ?? 'the best result for the brief'}\nArt direction: ${style || 'none given'}\n${ctx.params.canon ? `Canon: ${String(ctx.params.canon).slice(0, 3000)}\n` : ''}\n${layout}`,
          images: [...refs, ...views.flat()], schema: PICK_SCHEMA, effort: 'medium', maxTokens: 4000,
        }, ctx.signal);
        ctx.usage({ provider: 'anthropic', unit: 'tokens', amount: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), cost: r.cost, detail: `${r.model} pick` });
        picked = JSON.parse(r.text);
        const best = Math.max(0, Math.min(firstJobs.length - 1, Number(picked.best) || 0));
        winner = firstJobs[best];
        ctx.log(`picked candidate ${best}: ${picked.reason}`);
      }
    }
    made.push({ job: winner.id, outputs: winner.outputs });
    chain.push({ step: 1, tool: winner.tool, job: winner.id, candidates: firstJobs.map((j: any) => j.id), picked });

    for (let i = 1; i < steps.length; i++) {
      const j = await waitStep(i, await submitStep(i, steps[i]));
      made.push({ job: j.id, outputs: j.outputs });
      chain.push({ step: i + 1, tool: j.tool, job: j.id });
    }

    // Saved steps become this job's outputs (the last step is saved when none says so).
    const saves = steps.map((s, i) => (s.save ? { i, name: s.save } : null)).filter(Boolean) as { i: number; name: string }[];
    if (!saves.length) saves.push({ i: steps.length - 1, name: 'result' });
    const final: any[] = [];
    for (const s of saves) {
      for (const [k, o] of (made[s.i].outputs ?? []).entries()) {
        const a = getAsset(o.asset);
        if (!a) continue;
        const sub = String(o.title ?? a.title ?? k + 1).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const name = made[s.i].outputs.length > 1 ? `${s.name}.${sub || k + 1}` : s.name;
        await ctx.emit({ data: fs.readFileSync(a.path), mime: a.mime, seed: a.seed, title: name, meta: { save: name, step: s.i + 1, from: a.id } });
        final.push({ save: name, from: a.id });
      }
    }
    ctx.result({ chain, picked, saved: final, reused });
  },
};

/** Three frames (start, middle, end) of a video as PNGs, for Claude to judge it by. */
async function videoFrames(file: string, dir: string, signal: AbortSignal): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const dur = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { signal })).trim()) || 2;
  const out: string[] = [];
  for (const [k, t] of [0.05, 0.5, 0.95].entries()) {
    const f = path.join(dir, `f${k}.png`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, dur * t - 0.05)), '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', f], { signal });
    if (fs.existsSync(f)) out.push(f);
  }
  if (out.length !== 3) throw new GenError('could not read frames from a video candidate');
  return out;
}
