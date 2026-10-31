// The making loop (docs/worlds-roadmap.md, Phase 2): one way every AI action makes things. Plan, cheap preview(s),
// checks (src/quality), the final render of what passed, the same checks, then shown; failed checks get a targeted fix
// and at most two retries within the budget. Routing picks the tool for what's being made.
//
// This file is the contract. The making-loop work (Phase 2) adds the tool `make.checked` (submitted like any job,
// params = MakeRequest without `project`) and replaces the placeholder route() with data-driven rules. Until then
// route() names the tool the director films with today.

import type { QualityReport } from '../quality/index.ts';

/** What's being made: the router picks a tool for it. */
export type MakeIntent =
  | 'image' | 'character-sheet' | 'first-frame' | 'texture' | 'skybox' | 'prop-3d' | 'character-3d'
  | 'shot-action' | 'shot-dialogue' | 'shot-two-people' | 'shot-continue' | 'shot-recast'
  | 'voice' | 'sfx' | 'music';

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
};

export type Route = { tool: string; params: Record<string, any>; why: string; fallbacks: string[] };

/** The result `make.checked` reports (`ctx.result`). */
export type MakeOutcome = {
  asset: string | null;
  report: QualityReport | null;
  tries: number;
  credits: number;
  /** Set when every try failed its checks: the best take is still returned. */
  needsYou?: string;
};

/** The tool for an intent. */
export function route(req: Pick<MakeRequest, 'intent' | 'tool' | 'params'>): Route {
  if (req.tool) return { tool: req.tool, params: req.params ?? {}, why: 'pinned', fallbacks: [] };
  const map: Record<MakeIntent, string> = {
    image: 'image.generate', 'character-sheet': 'image.viewsheet', 'first-frame': 'image.control', texture: 'image.generate',
    skybox: 'image.panorama', 'prop-3d': 'mesh.views3d', 'character-3d': 'mesh.views3d',
    'shot-action': 'video.control', 'shot-dialogue': 'video.talk', 'shot-two-people': 'video.scene', 'shot-continue': 'video.extend',
    'shot-recast': 'video.replace', voice: 'audio.voice', sfx: 'audio.sfx', music: 'audio.music',
  };
  return { tool: map[req.intent], params: req.params ?? {}, why: 'default', fallbacks: [] };
}
