// library.judge: Claude picks the best version of a library slot (docs/library.md), the way asset.make picks among its
// own candidates, but for any slot and any time: the takes against the current pick, with the entity's on-model
// references, its look and canon, and the project's art direction. A person can always pick again in any Library view;
// the pick's note says why Claude chose it.
//
// Candidates: the slot's current version and its takes (newest first, at most `max`), or the versions named. Images are
// shown as they are, videos as three frames (start, middle, end). References: the current versions of `refs` slots of
// the same entity (default: the kind's reference-like slots that exist: reference, side, concept, pose/stand).

import fs from 'node:fs';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import { getAsset } from '../library.ts';
import { ensureLocal } from '../storage.ts';
import { ask } from '../providers/anthropic.ts';
import { videoFrames } from './pipeline.ts';
// @ts-ignore: plain JS client
import { HawkesGen } from '../../clients/js/hawkesgen.mjs';

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['best', 'reason', 'ranking'],
  properties: {
    best: { type: 'integer', description: 'Index of the best candidate' },
    reason: { type: 'string', description: 'One or two sentences: why it wins, and what is wrong with the others' },
    ranking: { type: 'array', items: { type: 'integer' }, description: 'All candidate indexes, best first' },
  },
};

const DEFAULT_REFS = ['reference', 'side', 'concept', 'pose/stand'];

export const libraryJudgeTool: Tool = {
  id: 'library.judge',
  version: 1,
  title: 'Pick the best version of a slot (Claude)',
  description:
    "Claude looks at a library slot's current version and its takes (images, or three frames of each video) next to the " +
    "entity's on-model references, look and canon, and picks the best. apply (default) makes the winner current with " +
    'the reason as its note; retire moves the takes that lost to old so the slot stops waiting. Anyone can pick again.',
  provider: 'anthropic',
  output: 'json',
  inputs: {},
  params: {
    entity: { type: 'text', required: true, description: 'The entity: project/slug' },
    slot: { type: 'text', required: true, description: 'The slot, e.g. side, pose/air, clip/jab, model' },
    versions: { type: 'json', description: 'Version ids to choose between (default: the current one and its takes)', advanced: true },
    max: { type: 'integer', default: 6, min: 2, max: 10, description: 'At most this many candidates (the current one and the newest takes)' },
    refs: { type: 'json', description: 'Slots of the same entity shown as on-model references (default: reference, side, concept, pose/stand)', advanced: true },
    criteria: { type: 'text', description: "What makes a version the best (default: the slot's brief and the kind's description)" },
    apply: { type: 'boolean', default: true, description: 'Make the winner current' },
    retire: { type: 'boolean', default: false, description: 'Move the takes that lost to old' },
  },
  async run(ctx) {
    const gen = new HawkesGen({ url: `http://127.0.0.1:${process.env.HAWKESGEN_PORT || 8790}`, project: ctx.job.project });
    const entityId = String(ctx.params.entity);
    const slot = String(ctx.params.slot);
    const e = await gen.entity(entityId);
    if (e.project !== ctx.job.project) throw new GenError(`${entityId} is not in project ${ctx.job.project}`);
    const all: any[] = (await gen.slot(entityId, slot)).versions.filter((v: any) => v.status !== 'discarded');
    const wanted: string[] | null = Array.isArray(ctx.params.versions) ? ctx.params.versions.map(String) : null;
    const current = all.find((v) => v.status === 'current');
    const max = Math.max(2, Number(ctx.params.max) || 6);
    const cands = wanted
      ? all.filter((v) => wanted.includes(v.id))
      : [...(current ? [current] : []), ...all.filter((v) => v.status === 'take').sort((a, b) => b.n - a.n)].slice(0, max);
    if (cands.length < 2) {
      ctx.result({ entity: entityId, slot, skipped: 'nothing to choose between', candidates: cands.length });
      return;
    }

    // Each candidate as images: the image, or three frames of the video.
    const views: string[][] = [];
    for (const [k, v] of cands.entries()) {
      const a = getAsset(v.asset);
      if (!a || !(await ensureLocal(a))) throw new GenError(`v${v.n}'s file is missing`);
      if (a.kind === 'image') views.push([a.path]);
      else if (a.kind === 'video') views.push(await videoFrames(a.path, ctx.tmp(`v${k}`), ctx.signal));
      else throw new GenError(`library.judge needs images or videos (v${v.n} is ${a.kind})`);
    }
    const per = views[0].length;
    if (!views.every((x) => x.length === per)) throw new GenError('the candidates mix images and videos');

    // On-model references: other slots' current images.
    const refSlots: string[] = Array.isArray(ctx.params.refs) ? ctx.params.refs.map(String) : DEFAULT_REFS;
    const refs: string[] = [];
    for (const s of refSlots.filter((x) => x !== slot)) {
      const cur = e.slots?.[s]?.current;
      const a = cur && getAsset(cur.asset);
      if (a && a.kind === 'image' && (await ensureLocal(a))) refs.push(a.path);
      if (refs.length >= 2) break;
    }

    const presets = await gen.presets(e.project).catch(() => null);
    const kind = presets?.kinds?.[e.kind];
    const slotSpec = kind?.slots?.[slot] ?? kind?.slots?.[`${slot.split('/')[0]}/*`];
    const brief = e.data?.slots?.[slot]?.brief ?? e.data?.slots?.[slot]?.action ?? '';
    const criteria = ctx.params.criteria ?? ([slotSpec?.description, brief].filter(Boolean).join(' ') || `the best ${slot} for ${e.name}`);
    const layout = (refs.length ? `The first ${refs.length} image(s) are on-model references (what ${e.name} looks like), not candidates. Then ` : 'The images are ') +
      (per > 1 ? `the candidates, ${per} frames each (start, middle, end of its video), candidates 0 to ${cands.length - 1} in order.` : `the candidates 0 to ${cands.length - 1}, in order.`);

    ctx.step(`Claude is choosing between ${cands.length} versions of ${slot}`);
    const r = await ask({
      system: 'You are the art director for a small game studio. Choose the version that best fits the slot, the art direction and the canon. Prefer clean, usable game assets: correct subject, on-model with the references, readable silhouette, consistent framing, no artifacts, no text unless asked. A version that breaks canon or goes off-model loses even if it looks better. When two are equally good, prefer the one already in use (candidate 0 when it is the current version).',
      prompt: `Entity: ${e.name} (${e.kind} in ${e.project})
Slot: ${slot}
What the slot needs: ${String(criteria).slice(0, 1500)}
Look: ${String(e.data?.look ?? '').slice(0, 1500) || 'not written'}
Canon: ${String(e.data?.canon ?? '').slice(0, 2000) || 'none written'}
Art direction: ${presets?.style || 'none given'}
${current ? 'Candidate 0 is the version in use now.' : 'No version is in use yet.'}

${layout}`,
      images: [...refs, ...views.flat()], schema: SCHEMA, effort: 'medium', maxTokens: 4000,
    }, ctx.signal);
    ctx.usage({ provider: 'anthropic', unit: 'tokens', amount: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), cost: r.cost, detail: `${r.model} judge` });
    const pick = JSON.parse(r.text);
    const best = cands[pick.best];
    if (!best) throw new GenError(`Claude answered candidate ${pick.best}, which doesn't exist`);

    let applied = false;
    if (ctx.params.apply !== false && best.status !== 'current') {
      await gen.pick(best.id, `Picked by Claude (library.judge ${ctx.job.id}): ${pick.reason}`);
      applied = true;
    }
    const retired: number[] = [];
    if (ctx.params.retire) {
      for (const v of cands) {
        if (v.id === best.id || v.status !== 'take') continue;
        await gen.request(`/versions/${v.id}`, { method: 'PATCH', body: { status: 'old', note: `Not picked (library.judge ${ctx.job.id})` } });
        retired.push(v.n);
      }
    }
    for (const f of views.flat()) if (f.startsWith(ctx.tmp(''))) fs.rmSync(f, { force: true });
    ctx.result({
      entity: entityId, slot, best: { n: best.n, id: best.id, wasCurrent: best.status === 'current' }, applied, retired,
      reason: pick.reason, ranking: pick.ranking.map((i: number) => cands[i]?.n), candidates: cands.map((v) => ({ n: v.n, status: v.status })), refs: refs.length,
    });
  },
};
