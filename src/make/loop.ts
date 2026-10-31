// The making loop (docs/make.md): a plan for one request (the routed tool, its params with the world's look and the
// cast's references applied), then the loop itself, which knows nothing about jobs or Claude: it gets `MakeDeps` (render
// a child, assess a file, price a child, compare two takes) so the tool runs it on Gen's queue and the tests on fakes.
//
//   draft  one render, one check
//   final  1-3 cheap previews, each checked; the best passing one is rendered at full settings with the same seed and
//          inputs; the final is checked; a failed check becomes a targeted change and a retry (at most maxRetries)
//   hero   3-4 finals compared in pairs (keep the winner), the winner's prompt refined once, then the same retries
//
// Nothing is spent past the budget: every child is priced before it's queued, and a step that would pass the budget
// stops the loop with the best take so far.

import type { AssessInput, QualityReport, Thresholds } from '../quality/index.ts';
import type { MakeOutcome, MakeQuality, MakeRequest } from './index.ts';
import type { ToolRoute } from './routing.ts';

export type Kind = 'image' | 'video' | 'mesh' | 'audio';

/** One render's request, as the loop hands it to `render`. */
export type RenderStep = { name: string; tool: string; params: Record<string, any>; inputs: Record<string, any> };
export type Rendered = { asset: string; file: string; job?: string; reused?: boolean };

export type Take = {
  asset: string; file: string; job?: string; tool: string; seed: number; params: Record<string, any>;
  stage: 'preview' | 'final' | 'refined'; report: QualityReport; score: number;
};

export type MakeDeps = {
  /** Runs one child job and waits for it: its first output. Throw a `ProviderFailure` to move on to the next tool. */
  render(step: RenderStep): Promise<Rendered>;
  assess(a: AssessInput): Promise<QualityReport>;
  /** The most one child can cost, in credits. */
  quote(tool: string, params: Record<string, any>): number;
  /** Which of two takes better fits the brief (0 or 1), why, and the winner's prompt rewritten to fix what's left. */
  compare(a: Take, b: Take, brief: string): Promise<{ winner: 0 | 1; why: string; refine?: string }>;
  log(line: string): void;
  step(detail: string): void;
};

/** A provider error (the tool's servers failed, not the take): the loop falls back to the next tool. */
export class ProviderFailure extends Error {}
class BudgetStop extends Error {}

/** What one tool gets for this request. */
export type ToolPlan = { tool: string; entry: ToolRoute; kind: Kind; params: Record<string, any>; inputs: Record<string, any> };

export type MakePlan = {
  quality: MakeQuality;
  brief: string;
  why: string;
  first: ToolPlan;
  /** The plan for a fallback tool (the same request), in order. */
  fallbacks: string[];
  forTool: (tool: string) => ToolPlan | null;
  identityRefs: string[];
  /** The fixed descriptions of who must be on-model (pasted into prompts when identity drifts). */
  identityWords: string;
  style: { refs?: string[]; words?: string } | null;
  thresholds: Thresholds;
  previews: number;
  heroCandidates: number;
  maxRetries: number;
  budget: number | null;
  baseSeed: number;
  checkCredits: number;
  compareCredits: number;
};

/** A take's score: passing first, then the checklist, the style, no faults, the closest face. */
export function scoreOf(r: QualityReport): number {
  let s = (r.pass ? 10 : 0) + (r.checklist?.score ?? 1) + (r.style?.score ?? 1);
  if (r.faults && !r.faults.ok) s -= 1 + 0.25 * r.faults.faults.length;
  if (r.identity?.distance != null) s -= 2 * r.identity.distance;
  return Math.round(s * 1000) / 1000;
}

const best = (ts: Take[]) => ts.reduce<Take | null>((b, t) => (!b || t.score > b.score ? t : b), null);

/** The preview's params: the final's with the cheap overrides on top. */
export const previewParams = (tp: ToolPlan) => ({ ...tp.params, ...(tp.entry.preview ?? {}) });

/** What failed, in plain words for the person (no model or machine names). */
export function problems(r: QualityReport | null | undefined): string[] {
  if (!r) return [];
  const out: string[] = [];
  for (const a of r.checklist?.answers ?? []) if (!a.yes) out.push(a.q.replace(/\?$/, '') + (a.why ? ` (${a.why})` : ''));
  for (const f of r.faults?.faults ?? []) out.push(f);
  if (r.identity?.distance != null && r.identity.faces > 0 && !r.pass) out.push('a face drifts from their references');
  if (r.identity && r.identity.faces === 0 && r.identity.distance == null) out.push('no face was found');
  if (r.style && r.style.why && r.style.score < 0.7) out.push(`the look: ${r.style.why}`);
  if (r.fix && !out.length) out.push(r.fix);
  return out;
}

/**
 * A failed check turned into a targeted change: the failed questions and the checker's fix go into the prompt, faults
 * into the negative and more steps, a drifting face brings the fixed description in and a new seed, "stiff" lowers the
 * strength and "ignores the stage" raises it. Returns the new params and what changed, in words.
 */
export function applyFix(tp: ToolPlan, r: QualityReport, o: { identityWords?: string; styleWords?: string; seed: number; attempt: number }): { params: Record<string, any>; seed: number; changes: string[] } {
  const p = { ...tp.params };
  const e = tp.entry;
  const changes: string[] = [];
  const add: string[] = [];
  const failedQs = (r.checklist?.answers ?? []).filter((a) => !a.yes).map((a) => a.q);
  if (failedQs.length) add.push(`Make sure: ${failedQs.map((q) => q.replace(/\?$/, '')).join('; ')}.`);
  if (r.fix) add.push(r.fix.trim());
  const identityOff = r.identity?.distance != null && (r.identity.distance > 0 || r.identity.faces === 0) && !r.pass;
  if (identityOff && o.identityWords && e.prompt && !String(p[e.prompt] ?? '').includes(o.identityWords)) {
    p[e.prompt] = `${o.identityWords} ${p[e.prompt] ?? ''}`.trim();
    changes.push('put their fixed description at the front of the prompt');
  }
  if (r.style && r.style.score < 0.7 && o.styleWords && e.prompt && !String(p[e.prompt] ?? '').includes(o.styleWords)) add.push(o.styleWords);
  if (e.prompt && add.length) {
    const cur = String(p[e.prompt] ?? '');
    const fresh = add.filter((a) => !cur.includes(a));
    if (fresh.length) {
      p[e.prompt] = `${cur} ${fresh.join(' ')}`.trim().slice(0, 4000);
      changes.push(`added to the prompt: ${fresh.join(' ')}`);
    }
  }
  const faults = r.faults && !r.faults.ok ? r.faults.faults : [];
  if (faults.length && e.negative) {
    const neg = String(p[e.negative] ?? '');
    const more = faults.filter((f) => !neg.toLowerCase().includes(f.toLowerCase()));
    if (more.length) {
      p[e.negative] = [neg, ...more].filter(Boolean).join(', ');
      changes.push(`avoid: ${more.join(', ')}`);
    }
  }
  if (faults.length && e.steps && Number(p[e.steps]) > 0) {
    const n = Math.min(Math.round(Number(p[e.steps]) * 1.5), Number(p[e.steps]) + 20);
    if (n > Number(p[e.steps])) {
      changes.push(`more steps (${p[e.steps]} to ${n})`);
      p[e.steps] = n;
    }
  }
  const words = `${r.fix ?? ''} ${failedQs.join(' ')}`.toLowerCase();
  if (e.strength) {
    const cur = Number(p[e.strength] ?? 1) || 1;
    if (/stiff|puppet|wooden|too literal|frozen|robotic/.test(words) && cur > 0.55) {
      p[e.strength] = Math.round(Math.max(0.55, cur - 0.15) * 100) / 100;
      changes.push(`looser (strength ${cur} to ${p[e.strength]})`);
    } else if (/ignor|doesn'?t follow|not follow|off the (stage|layout|blocking)|wrong (place|position)/.test(words) && cur < 1) {
      p[e.strength] = Math.min(1, Math.round((cur + 0.15) * 100) / 100);
      changes.push(`stricter (strength ${cur} to ${p[e.strength]})`);
    }
  }
  // A new seed when the take itself was broken (faults, a drifting face) or nothing else could change.
  let seed = o.seed;
  if (faults.length || identityOff || !changes.length) {
    seed = o.seed + 7919 * (o.attempt + 1);
    changes.push('a new seed');
  }
  return { params: p, seed, changes };
}

/** The most the whole loop can cost (every preview, final, check, comparison and retry), capped by the budget. */
export function worstCase(plan: MakePlan, quote: (tool: string, params: Record<string, any>) => number): { credits: number; uncapped: number; lines: { label: string; credits: number }[] } {
  const tp = plan.first;
  const fin = quote(tp.tool, tp.params) + plan.checkCredits;
  const prev = tp.entry.preview ? quote(tp.tool, previewParams(tp)) + plan.checkCredits : 0;
  const n = tp.entry.preview ? plan.previews : 0;
  const tries = plan.maxRetries + 1;
  const lines: { label: string; credits: number }[] = [];
  if (plan.quality === 'draft') lines.push({ label: 'one take and its check', credits: fin });
  else if (plan.quality === 'final') {
    if (n) lines.push({ label: `${n} preview${n > 1 ? 's' : ''} per try, checked`, credits: n * prev * tries });
    lines.push({ label: `the final per try, checked (${tries} tries at most)`, credits: fin * tries });
  } else {
    const k = plan.heroCandidates;
    lines.push({ label: `${k} finals, checked`, credits: k * fin });
    lines.push({ label: 'comparisons and one refined take', credits: k * plan.compareCredits + fin });
    lines.push({ label: `retries (${plan.maxRetries} at most)`, credits: plan.maxRetries * fin });
  }
  const uncapped = lines.reduce((s, l) => s + l.credits, 0);
  return { credits: plan.budget != null ? Math.min(uncapped, plan.budget) : uncapped, uncapped, lines };
}

/** Runs the loop for a plan. */
export async function runLoop(plan: MakePlan, deps: MakeDeps): Promise<MakeOutcome & { report: QualityReport | null }> {
  let spent = 0;
  let tp = plan.first;
  const fallbacks = [...plan.fallbacks];
  const takes: Take[] = [];
  const changes: string[] = [];
  let tries = 0;
  let stopped: 'budget' | undefined;
  const afford = (c: number) => plan.budget == null || spent + c <= plan.budget;

  const render = async (stage: Take['stage'], params: Record<string, any>, seed: number, name: string): Promise<Take> => {
    for (;;) {
      const p = { ...params, seed };
      const cost = deps.quote(tp.tool, p);
      if (!afford(cost + plan.checkCredits)) throw new BudgetStop(`${name} would cost ${cost + plan.checkCredits} credits with ${plan.budget! - spent} left`);
      let r: Rendered;
      try {
        deps.step(`${name}: ${stage === 'preview' ? 'a quick preview' : stage === 'refined' ? 'the refined take' : 'the full take'}`);
        r = await deps.render({ name, tool: tp.tool, params: p, inputs: tp.inputs });
      } catch (e) {
        if (!(e instanceof ProviderFailure)) throw e;
        // The tool's servers failed: the next tool of the rule takes the same request (with its own params).
        let next: ToolPlan | null = null;
        while (!next && fallbacks.length) next = plan.forTool(fallbacks.shift()!);
        if (!next) throw e;
        deps.log(`${tp.tool} failed (${e.message}); trying ${next.tool}`);
        changes.push(`switched to another model after a server error`);
        const extra = Object.fromEntries(Object.entries(params).filter(([k]) => k in next!.params && !(k in tp.params)));
        tp = next;
        params = { ...(stage === 'preview' ? previewParams(tp) : tp.params), ...extra };
        continue;
      }
      if (!r.reused) spent += cost;
      deps.step(`${name}: checking it`);
      const report = await deps.assess({ brief: plan.brief, kind: tp.kind, file: r.file, identityRefs: plan.identityRefs.length ? plan.identityRefs : undefined, style: plan.style ?? undefined, thresholds: plan.thresholds });
      spent += plan.checkCredits;
      const t: Take = { asset: r.asset, file: r.file, job: r.job, tool: tp.tool, seed, params: p, stage, report, score: scoreOf(report) };
      takes.push(t);
      deps.log(`${name}: ${t.tool} seed ${seed} ${report.pass ? 'passed' : `failed (${problems(report).join('; ') || 'checks'})`}${r.reused ? ' (from the library)' : ''}`);
      return t;
    }
  };
  const fix = (t: Take, attempt: number) => {
    const f = applyFix({ ...tp, params: stripPreview(t.params, tp) }, t.report, { identityWords: plan.identityWords, styleWords: plan.style?.words, seed: t.seed, attempt });
    tp = { ...tp, params: withoutSeed(f.params) };
    changes.push(...f.changes);
    deps.log(`try ${attempt + 2}: ${f.changes.join('; ')}`);
    return f.seed;
  };

  let result: Take | null = null;
  try {
    let seed = plan.baseSeed;
    if (plan.quality === 'draft') {
      tries = 1;
      result = await render('final', tp.params, seed, 'take 1');
    } else if (plan.quality === 'final') {
      for (let attempt = 0; attempt <= plan.maxRetries; attempt++) {
        tries++;
        let finalSeed = seed;
        if (tp.entry.preview && plan.previews > 0) {
          const pv: Take[] = [];
          for (let i = 0; i < plan.previews; i++) pv.push(await render('preview', previewParams(tp), seed + i, `try ${attempt + 1} preview ${i + 1}`));
          const b = best(pv)!;
          if (!b.report.pass && attempt < plan.maxRetries) {
            seed = fix(b, attempt);
            continue;
          }
          finalSeed = b.seed;
        }
        const f = await render('final', tp.params, finalSeed, `try ${attempt + 1} final`);
        result = f;
        if (f.report.pass) break;
        if (attempt < plan.maxRetries) seed = fix(f, attempt);
      }
    } else {
      tries = 1;
      const cands: Take[] = [];
      for (let i = 0; i < plan.heroCandidates; i++) cands.push(await render('final', tp.params, seed + i, `candidate ${i + 1}`));
      // King of the hill: each candidate meets the winner so far; the last comparison's rewrite refines the winner.
      let winner = cands[0];
      let refine: string | undefined;
      for (const c of cands.slice(1)) {
        const r = await compareTakes(winner, c);
        if (r.winner === 1) winner = c;
        refine = r.refine;
      }
      result = winner;
      const pk = tp.entry.prompt;
      if (pk && refine && refine.trim() && refine.trim() !== String(winner.params[pk] ?? '').trim()) {
        const refined = await render('refined', { ...stripPreview(winner.params, tp), [pk]: refine.trim().slice(0, 4000) }, winner.seed, 'refined winner');
        const r = await compareTakes(winner, refined);
        if (r.winner === 1 || (refined.report.pass && !winner.report.pass)) {
          result = refined;
          tp = { ...tp, params: withoutSeed(refined.params) };
        }
        changes.push('refined the winner\'s prompt once');
      }
      for (let attempt = 0; attempt < plan.maxRetries && !result.report.pass; attempt++) {
        tries++;
        const s = fix(result, attempt);
        const again = await render('final', tp.params, s, `retry ${attempt + 1}`);
        if (again.score > result.score) result = again;
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetStop)) throw e;
    stopped = 'budget';
    deps.log(`stopped at the budget: ${e.message}`);
  }

  async function compareTakes(a: Take, b: Take) {
    if (!afford(plan.compareCredits)) throw new BudgetStop('a comparison would pass the budget');
    deps.step('comparing two takes');
    const r = await deps.compare(a, b, plan.brief);
    spent += plan.compareCredits;
    deps.log(`compared ${a.asset} with ${b.asset}: ${r.winner === 0 ? 'the first' : 'the second'} wins (${r.why})`);
    return r;
  }

  // The answer: the passing take, else the best final, else the best of anything made.
  const finals = takes.filter((t) => t.stage !== 'preview');
  if (!result || !result.report.pass) result = best(finals.filter((t) => t.report.pass)) ?? best(finals) ?? best(takes) ?? result;
  const pass = Boolean(result?.report.pass) && (result?.stage !== 'preview');
  const out: MakeOutcome = {
    asset: result?.asset ?? null,
    report: result?.report ?? null,
    tries: Math.max(1, tries),
    credits: spent,
    tool: result?.tool ?? tp.tool,
    why: plan.why,
    takes: takes.map((t) => ({ asset: t.asset, stage: t.stage, tool: t.tool, seed: t.seed, pass: t.report.pass, score: t.score, ...(t.job ? { job: t.job } : {}) })),
    changes,
    ...(stopped ? { stopped } : {}),
  };
  if (!pass) out.needsYou = needsYouText(result, takes.length, stopped ? plan.budget : null);
  return out;
}

/** "This one needs you", in plain words. */
export function needsYouText(t: Take | null, made: number, budget: number | null): string {
  const what = problems(t?.report);
  const tail = what.length ? ` What's still off: ${what.slice(0, 4).join('; ')}.` : '';
  if (!t) return budget != null ? `Nothing was made: the first take would cost more than the ${budget} credits allowed. Raise the budget or ask for a draft.` : 'Nothing was made.';
  if (budget != null) return `I stopped before going over the ${budget} credits allowed. Here's the best take so far${t.stage === 'preview' ? ' (a quick preview, not the full take)' : ''}.${tail} Raise the budget to keep going, or use this one.`;
  return `None of the ${made} takes passed every check, so this one needs you. Here's the closest.${tail} Say what's wrong in your own words, or keep it if it's close enough.`;
}

const withoutSeed = (p: Record<string, any>) => {
  const { seed: _s, ...rest } = p;
  return rest;
};
/** A take's params back at full settings (a preview's overrides replaced by the plan's own). */
function stripPreview(p: Record<string, any>, tp: ToolPlan) {
  const out = withoutSeed(p);
  for (const k of Object.keys(tp.entry.preview ?? {})) {
    if (k in tp.params) out[k] = tp.params[k];
    else delete out[k];
  }
  return out;
}

export type { MakeRequest };
