// The making loop (docs/worlds-roadmap.md, Phase 2): one way every AI action makes things. Plan, cheap preview(s),
// checks (src/quality), the final render of what passed, the same checks, then shown; failed checks get a targeted fix
// and at most two retries within the budget. Routing picks the tool for what's being made.
//
// This file is the contract. The tool `make.checked` (src/make/tool.ts, submitted like any job, params = MakeRequest
// without `project`) runs the loop (src/make/loop.ts); route() reads knowledge/routing.json (src/make/routing.ts).
// docs/make.md.

import type { QualityReport } from '../quality/index.ts';
import { pickTools, type RouteContext } from './routing.ts';

/** What's being made: the router picks a tool for it. */
export type MakeIntent =
  | 'image' | 'character-sheet' | 'first-frame' | 'texture' | 'skybox' | 'prop-3d' | 'character-3d'
  | 'shot-action' | 'shot-dialogue' | 'shot-two-people' | 'shot-continue' | 'shot-recast'
  | 'voice' | 'sfx' | 'music' | 'animation';

export type MakeQuality = 'draft' | 'final' | 'hero';

export type MakeRequest = {
  project: string;
  intent: MakeIntent;
  /** What it should be, in words: the brief the checks judge against. */
  brief: string;
  /** Pin a tool instead of routing. */
  tool?: string;
  params?: Record<string, any>;
  inputs?: Record<string, any>;
  /** Asset ids: who must be on-model, and the look. */
  refs?: { identity?: string[]; style?: string[] };
  world?: string | null;
  /** Most credits this request may spend, retries included. */
  budgetCredits?: number;
  /** draft: no previews, one check; final: previews then a final; hero: a tournament of several. */
  quality?: MakeQuality;
  /** Paid partner models may be routed to (the owner's setting must allow them too). */
  allowPaid?: boolean;
};

export type Route = { tool: string; params: Record<string, any>; why: string; fallbacks: string[]; skipped?: { tool: string; why: string }[] };

/** The result `make.checked` reports (`ctx.result`). */
export type MakeOutcome = {
  asset: string | null;
  report: QualityReport | null;
  tries: number;
  credits: number;
  /** Set when every try failed its checks: the best take is still returned. */
  needsYou?: string;
  /** The tool that made it, and why it was picked. */
  tool?: string;
  why?: string;
  /** Every take made, in order (previews, finals, the tournament's), with its check. */
  takes?: { asset: string; stage: 'preview' | 'final' | 'refined'; tool: string; seed: number; pass: boolean; score: number; job?: string }[];
  /** The targeted changes made after failed checks, in words. */
  changes?: string[];
  /** Set when the loop stopped short: 'budget' (the next step would pass budgetCredits). */
  stopped?: 'budget';
};

/** The tool for an intent: the first matching rule in knowledge/routing.json whose tools this Gen can run, with the rest
 *  of that rule's tools as fallbacks (src/make/routing.ts). `ctx` says what the request can't (a depth video, people,
 *  paid models allowed) and what this Gen has; without it every tool counts as present. */
export function route(req: Pick<MakeRequest, 'intent' | 'tool' | 'params'> & Partial<Pick<MakeRequest, 'inputs' | 'refs'>>, ctx?: RouteContext): Route {
  if (req.tool) return { tool: req.tool, params: req.params ?? {}, why: 'pinned', fallbacks: [] };
  const r = pickTools(req, ctx);
  return { tool: r.tool, params: req.params ?? {}, why: r.why, fallbacks: r.fallbacks, skipped: r.skipped };
}
