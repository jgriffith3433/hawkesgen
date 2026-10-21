// image.viewsheet: the view sheet mesh.views3d needs, made from the front view of a character. It makes the true back,
// left and right views of the SAME character (Qwen-Image-Edit 2511 through image.edit, each one cut out), has Claude look
// at all four for the same character (colors, props, proportions, limb count, and that each view really looks the way it
// should), makes a bad view again, and only then lays front|back|left|right side by side on flat grey. A mismatched sheet
// stops here, for cents, instead of costing a 3D run. docs/3d-characters.md ("Always more than one view").

import fs from 'node:fs';
import type { Tool } from './types.ts';
import { GenError, run } from '../util.ts';
import { getAsset } from '../library.ts';
import { ask, usageOf } from '../providers/anthropic.ts';
import { planSheet } from './sheet.ts';
import { imageSize } from './threed.ts';
// @ts-ignore: plain JS client
import { HawkesGen } from '../../clients/js/hawkesgen.mjs';

export const VIEWS = ['front', 'back', 'left', 'right'] as const;
type View = (typeof VIEWS)[number];
const MADE = ['back', 'left', 'right'] as const;

const LIGHT = 'Full body from head to feet, flat even lighting with no cast shadows, plain flat light grey background (no checkerboard, no transparency grid, no floor), nothing else in the picture.';
const BASE = `same size and position in the frame, the same pose as the reference (keep it a neutral standing pose, arms away from the body), the exact same design, colors, outfit, props and proportions. ${LIGHT}`;
const PROP_BASE = 'same size and position in the frame, the exact same design, shape, colors, materials and proportions. The whole object in frame, flat even lighting with no cast shadows, plain flat light grey background (no checkerboard, no transparency grid, no floor), nothing else in the picture.';
const SIDE = {
  back: 'seen from directly behind, a true back view (180 degrees from the front), ',
  left: 'seen from the left side, a true 90 degree side profile, ',
  right: 'seen from the right side, a true 90 degree side profile, ',
};
/** Robots, spiders and other creatures: the views must keep every limb apart and visible. */
const LIMBS = ' Keep every leg, arm and limb fully separated from the body and from the others, spread out so each one is completely visible and none is hidden behind the body or another limb; the same number of limbs as the reference, none added, merged or lost.';

export type Subject = 'humanoid' | 'creature' | 'prop';
/** The image.edit prompt for one view. creature: limbs kept apart (Spider Bot, Yo Bot); prop: an object, no pose. */
export function viewPrompt(view: (typeof MADE)[number], subject: Subject): string {
  const who = subject === 'prop' ? 'the same object' : 'the same character';
  const text = `${who} ${SIDE[view]}${subject === 'prop' ? PROP_BASE : BASE}${subject === 'creature' ? LIMBS : ''}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** humanoid is the default; prop is an object; anything else (robot, spider, creature...) keeps its limbs apart in the views. */
export function subjectOf(form: unknown): Subject {
  const f = String(form ?? '').trim().toLowerCase();
  if (['', 'humanoid', 'human', 'biped'].includes(f)) return 'humanoid';
  return ['prop', 'object', 'item'].includes(f) ? 'prop' : 'creature';
}

const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['views', 'summary'],
  properties: {
    views: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['view', 'ok', 'problem'],
        properties: {
          view: { type: 'string', enum: [...MADE] },
          ok: { type: 'boolean', description: 'true when this view is the same character, seen from the right direction' },
          problem: { type: 'string', description: 'What is wrong (empty when ok)' },
        },
      },
    },
    summary: { type: 'string' },
  },
};
export type ViewCheck = { views: { view: string; ok: boolean; problem: string }[]; summary: string };

/** The views the check rejected (a view Claude didn't mention counts as fine only when the answer is otherwise complete). */
export function badViews(check: ViewCheck, views: readonly string[] = MADE): string[] {
  const out: string[] = [];
  for (const v of views) {
    const c = check.views.find((x) => x.view === v);
    if (!c || !c.ok) out.push(v);
  }
  return out;
}

export const viewSheetTool: Tool = {
  id: 'image.viewsheet',
  version: 1,
  title: 'View sheet for 3D (back, left, right + consistency check)',
  description: 'From the cut-out FRONT view of a character (neutral or A-pose, whole body, at least 1024 px), makes the true back, left and right views of the same character ' +
    '(Qwen-Image-Edit 2511, flat even light, plain grey background, each cut out), has Claude check that all four are the same character (colors, props, proportions, limb count) and that each looks the right way, ' +
    'makes a bad view again (up to retries), and lays front|back|left|right in one sheet: the input of mesh.views3d, so image-to-3D always has more than one view. ' +
    'Fails before any 3D GPU time when the views still do not match. For robots and creatures set form (limbs are kept apart and visible in every view). ' +
    'Outputs: sheet, front, back, left, right. Pass back, left or right yourself to use your own view for it.',
  provider: 'pipeline',
  output: 'image',
  inputs: {
    image: { kind: 'image', required: true, description: 'The front view, cut out (image.remove-background), whole body, neutral or A-pose.' },
    back: { kind: 'image', description: 'Your own back view (cut out) instead of a generated one.' },
    left: { kind: 'image', description: 'Your own left-side view (cut out).' },
    right: { kind: 'image', description: 'Your own right-side view (cut out).' },
  },
  params: {
    form: { type: 'string', default: 'humanoid', description: 'humanoid; robot / creature / spider...: limbs are kept separated and visible in every view; prop: an object, no pose.' },
    look: { type: 'text', description: 'Who or what it is, for the checker (e.g. "Spider Bot: a chrome spider robot with six legs and a red eye").', advanced: true },
    cell: { type: 'integer', min: 1024, max: 2048, default: 1024, description: 'Each view\'s square cell in pixels (1024 or more).' },
    retries: { type: 'integer', min: 0, max: 4, default: 2, description: 'How many times a rejected view is made again before the job gives up.' },
    check: { type: 'boolean', default: true, description: 'Have Claude compare the views before the sheet is made. Switch off only for a sheet you already trust.', advanced: true },
    background: { type: 'string', default: 'e6e6e6', description: 'Sheet background (hex, flat light grey).', advanced: true },
    seed: { type: 'integer', min: 0, max: 2 ** 31, description: 'Seed for the first take of each view; retries count up. Derived from the inputs when empty.', advanced: true },
  },
  gpuSeconds: () => 60,
  async run(ctx) {
    const front: string = ctx.inputs.image;
    const cell = Math.round(Number(ctx.params.cell));
    const retries = Math.round(Number(ctx.params.retries));
    const bg = String(ctx.params.background).replace(/^#/, '');
    const subject = subjectOf(ctx.params.form);
    const creature = subject === 'creature';
    const size = imageSize(front);
    if (size && Math.max(size.width, size.height) < 1024) ctx.log(`warning: the front view is ${size.width}x${size.height}; 1024 px or more makes a better mesh`);

    const gen = new HawkesGen({ url: `http://127.0.0.1:${process.env.HAWKESGEN_PORT || 8790}`, project: ctx.job.project });
    const supplied: Partial<Record<View, string>> = {};
    for (const v of MADE) if (ctx.inputs[v]) supplied[v] = ctx.inputs[v];
    const files: Record<string, string> = { front, ...supplied };
    const rejected: Record<string, string[]> = { back: [], left: [], right: [] };
    const base = Number(ctx.params.seed) || 1 + (Number.parseInt(pathHash(front), 16) % 1_000_000);
    const attempts: unknown[] = [];

    const submit = async (tool: string, view: string, attempt: number, step: string, body: Record<string, any>) => {
      const job = await gen.submit(tool, { ...body, labels: { parent: ctx.job.id, step: `${view} ${step}` }, key: `${ctx.job.id}:${view}:${attempt}:${step}` });
      const done = job.status === 'done' ? job : await gen.wait(job.id, { throwOnFail: false, onUpdate: (j: any) => ctx.step(`${view} ${step}: ${j.detail}`), signal: ctx.signal });
      if (done.status !== 'done') throw new GenError(`the ${view} view (${tool}) ${done.status}: ${done.error ?? done.detail}`);
      ctx.log(`${view} ${step}: ${done.tool} ${done.id}${done.reused ? ' (from the library)' : ''}`);
      return done;
    };
    /** Makes one view: the edit, then its cutout. Returns the cutout's file; remembers the edit so a retry doesn't get it back. */
    const make = async (view: (typeof MADE)[number], attempt: number) => {
      const edit = await submit('image.edit', view, attempt, 'edit', {
        params: { prompt: viewPrompt(view, subject), width: cell, height: cell, seed: base + attempt },
        inputs: { images: [front] },
        reuse: { exclude: rejected[view] },
      });
      const editAsset = edit.outputs?.[0]?.asset;
      const cut = await submit('image.remove-background', view, attempt, 'cutout', { inputs: { image: `asset:${editAsset}` }, reuse: true });
      const o = (cut.outputs ?? []).find((x: any) => String(x.title ?? '').toLowerCase() === 'cutout') ?? (cut.outputs ?? []).find((x: any) => x.kind === 'image' && x !== cut.outputs?.[0]);
      const a = o ? getAsset(o.asset) : null;
      if (!a?.path) throw new GenError(`the ${view} view has no cutout (image.remove-background made: ${(cut.outputs ?? []).map((x: any) => x.title).join(', ') || 'nothing'})`);
      rejected[view].push(editAsset);
      files[view] = a.path;
    };

    let pending: (typeof MADE)[number][] = MADE.filter((v) => !supplied[v]);
    for (let attempt = 0; ; attempt++) {
      if (pending.length) {
        ctx.step(`making the ${pending.join(', ')} view${pending.length > 1 ? 's' : ''}${attempt ? ` again (try ${attempt + 1})` : ''}`);
        await Promise.all(pending.map((v) => make(v, attempt)));
      }
      if (!ctx.params.check) break;
      ctx.step('Claude is checking the views are the same character');
      const look = ctx.params.look ? `The character: ${String(ctx.params.look).slice(0, 1500)}\n` : '';
      const r = await ask({
        system: 'You check turnaround views of one game character before they are turned into a 3D model. A wrong view wastes an expensive 3D run, so be strict about real mismatches and relaxed about small rendering differences.',
        prompt: `Image 1 is the FRONT view and the reference. Images 2, 3 and 4 are the BACK, the LEFT-side and the RIGHT-side views. ${look}` +
          `For each of the back, left and right views decide ok: true only when it is the SAME character as the front (same colors, props, outfit, proportions and the same number of limbs, nothing added, merged or lost) AND it really is that view (a back view shows the back of the head and body; left and right are true side profiles, not 3/4 views, and face opposite ways) AND the whole body is in frame on a plain background. ` +
          `When not ok, say in one short sentence what is wrong. ${creature ? 'This is a robot or creature: every limb must be separate and visible in every view.' : ''}`,
        images: VIEWS.map((v) => files[v]), schema: CHECK_SCHEMA, effort: 'low', maxTokens: 3000,
      }, ctx.signal);
      ctx.usage(usageOf(r, `${r.model} view check`));
      const verdict: ViewCheck = JSON.parse(r.text);
      const bad = badViews(verdict);
      attempts.push({ attempt: attempt + 1, bad, ...verdict });
      ctx.log(`view check ${attempt + 1}: ${bad.length ? `rejected ${bad.join(', ')}: ${verdict.views.filter((x) => !x.ok).map((x) => `${x.view}: ${x.problem}`).join('; ')}` : 'all views match'}`);
      if (!bad.length) break;
      const own = bad.filter((v) => supplied[v as View]);
      if (own.length) throw new GenError(`the ${own.join(', ')} view you supplied does not match the front: ${verdict.views.filter((x) => own.includes(x.view)).map((x) => x.problem).join('; ')}`);
      if (attempt >= retries) {
        throw new GenError(`the views still do not match after ${attempt + 1} tries, so no 3D was started: ${verdict.views.filter((x) => !x.ok).map((x) => `${x.view}: ${x.problem}`).join('; ') || verdict.summary}. Fix the front view or pass your own ${bad.join('/')} view, or raise retries.`);
      }
      pending = bad as (typeof MADE)[number][];
    }

    // The sheet: every view on a flat square cell of the same grey, front|back|left|right.
    ctx.step('laying the sheet');
    const flat: string[] = [];
    for (const v of VIEWS) {
      const f = ctx.tmp(`flat-${v}.png`);
      await ctx.python('prep.py', ['fit', files[v], f, String(cell), String(cell), bg]);
      flat.push(f);
    }
    const out = ctx.tmp('sheet.png');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...flat.flatMap((f) => ['-i', f]), '-filter_complex', planSheet(4, cell, bg), '-map', '[out]', '-frames:v', '1', out], { signal: ctx.signal });
    await ctx.emit({ data: fs.readFileSync(out), ext: '.png', title: 'sheet', meta: { views: [...VIEWS], width: cell * 4, height: cell, form: ctx.params.form } });
    for (const v of VIEWS) await ctx.emit({ data: fs.readFileSync(files[v]), ext: '.png', title: v, meta: { view: v } });
    ctx.result({ views: [...VIEWS], width: cell * 4, height: cell, checked: Boolean(ctx.params.check), attempts });
  },
};

/** A stable number from the front view's path, so the seed (and so a re-run's takes) follow the input. */
function pathHash(file: string) {
  let h = 0;
  for (const c of file) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(7, '0');
}
