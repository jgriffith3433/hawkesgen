// One AI that runs the show (docs/showrunner.md, docs/worlds-roadmap.md Phase 4). Every message from the AI pane comes
// here. Small edits go to the assistant of the scene in front, unchanged (the AI editor, the AI director, the character
// AI: same answers, same costs), with what the showrunner saw added when the words point at results. Productions go to
// the planner: a plan written top down at high effort, critiqued, compiled into steps, priced, and shown as one approval
// card. Approved, it runs on the server (production.ts).

import type { Client } from '../auth.ts';
import { worldContext, worldOf, type WorldContext } from '../worlds.ts';
import { identityPack } from '../identity.ts';
import { listScenes, getScene } from '../scenes.ts';
import { editorVoices } from '../editor.ts';
import { GenError } from '../util.ts';
import { deps } from './deps.ts';
import { classify, refersToResults, type Classified } from './classify.ts';
import { normalizePlan, lintPlan, plannerPrompt, critiquePrompt, planOutline, jsonOf, type Plan, type PlanContext } from './plan.ts';
import { compileSteps, cardFor, toolFor, type Refs } from './steps.ts';
import { createProduction, getProduction, approve, dismiss, publicProduction, createFix, productionForCut, advance, type Production } from './production.ts';
import { learn, memorySummary } from './memory.ts';
import { picturesFor, lookNote, shotClips } from './vision.ts';

export type Message = { role: 'user' | 'assistant'; text: string };
export type Delegate = (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: any }>;

/** Which existing assistant answers small edits for a kind of scene. */
export function assistantPath(kind: string, id: string): string {
  if (kind === 'video' || kind === 'image' || kind === 'audio') return `/v1/editor/projects/${id}/assistant`;
  if (kind === 'stage') return `/v1/director/shots/${id}/assistant`;
  return `/v1/scenes/${id}/assistant`;
}

// ------------------------------------------------------------------ planning
export type Planned = { plan: Plan; say: string; issues: string[]; aiCredits: number; rounds: number };

/** A plan: written at high effort, checked by lintPlan and a critique, fixed, checked again (at most twice). */
export async function makePlan(project: string, payer: string | null, ctx: PlanContext): Promise<Planned> {
  const d = deps();
  let aiCredits = 0;
  const call = async (p: ReturnType<typeof plannerPrompt>, what: string) => {
    const r = await d.ask(project, p);
    if (r.house) aiCredits += d.chargeAi(payer, r.cost, what);
    return jsonOf(r.text);
  };
  const first = await call(plannerPrompt(ctx), `Showrunner plan: ${ctx.request.slice(0, 60)}`);
  if (!first) throw new GenError("The plan didn't come back right. Try saying it again.", { status: 502 });
  let plan = normalizePlan(first.plan ?? first, { kind: ctx.kind, seconds: ctx.seconds ?? undefined });
  const say = String(first.say ?? '').slice(0, 1200);
  let critiqueIssues: string[] = [];
  let rounds = 0;
  for (; rounds < 2; rounds++) {
    const found = lintPlan(plan);
    if (rounds > 0 && !found.length) break;
    const c = await call(critiquePrompt(plan, found, ctx.world), `Showrunner check: ${plan.title.slice(0, 60)}`);
    if (c?.plan) plan = normalizePlan({ ...c.plan, kind: c.plan.kind ?? plan.kind }, { kind: plan.kind, seconds: plan.seconds, title: plan.title });
    critiqueIssues = c && !c.ok && Array.isArray(c.issues) ? c.issues.map(String).slice(0, 10) : [];
    if (c?.ok && !lintPlan(plan).length) { rounds++; break; }
  }
  if (ctx.world) plan.world = null;
  const left = lintPlan(plan).map((x) => x.text);
  return { plan, say, issues: [...new Set([...left, ...(left.length ? critiqueIssues : [])])], aiCredits, rounds };
}

/** What the planner knows: the world, the person's characters, the voices and their taste. */
export async function planContext(project: string, c: Classified, messages: Message[], world: string | null, previous: Plan | null): Promise<PlanContext> {
  const w = world ? worldContext(project, world) : null;
  const characters = listScenes(project, 'character', 20).map((x) => {
    let description = '';
    try { description = identityPack(getScene(x.id, (p) => p === project).doc).description; } catch { /* gone */ }
    return { id: x.id, name: x.title, description: description.slice(0, 400) };
  });
  return {
    request: String(messages[messages.length - 1]?.text ?? ''), kind: c.kind ?? previous?.kind ?? 'short', seconds: c.seconds ?? previous?.seconds ?? null,
    world: w, memory: memorySummary(project), characters, voices: await editorVoices().catch(() => []), previous, conversation: messages,
  };
}

/** The steps priced: make.checked's up-front worst case when this Gen has it, else the routed tool's price. */
export function priceSteps(project: string, steps: ReturnType<typeof compileSteps>) {
  const d = deps();
  for (const s of steps) {
    if (!s.make) continue;
    const t = toolFor(s, d.hasTool);
    s.credits = d.quote(project, t.tool, t.params);
  }
  return steps;
}

/** The reference pictures the plan's existing characters and the world's places already have. */
function refsFor(project: string, plan: Plan, w: WorldContext | null): Refs {
  const refs: Refs = { characters: {}, places: {} };
  for (const c of plan.characters) {
    if (!c.id) continue;
    try { refs.characters[c.key] = identityPack(getScene(c.id, (p) => p === project).doc).refs.slice(0, 3); } catch { /* gone: made anew */ }
    if (!refs.characters[c.key]?.length) refs.characters[c.key] = w?.characters.find((m) => m.id === c.id)?.refs ?? [];
  }
  for (const p of plan.places) if (p.id) refs.places[p.key] = w?.places.find((m) => m.id === p.id)?.refs ?? [];
  return refs;
}

/** A production for a plan: compiled, priced, carded, kept as proposed (or approved at once when it's under the auto limit). */
export function proposeProduction(a: { project: string; client: Client; payer: string | null; plan: Plan; issues: string[]; world: string | null; browser?: boolean; autoCredits: number; replace?: Production | null }): Production {
  const w = a.world ? worldContext(a.project, a.world) : null;
  const steps = priceSteps(a.project, compileSteps(a.plan, { style: w?.look.style ?? a.plan.world?.style, negative: w?.look.negative ?? a.plan.world?.negative, refs: refsFor(a.project, a.plan, w), world: a.world, browser: a.browser }));
  const card = cardFor(a.plan, steps, planOutline(a.plan), a.issues);
  const p = createProduction({ project: a.project, client: a.client, payer: a.payer, plan: a.plan, steps, card, out: { world: a.world ?? null } });
  if (a.replace) dismiss(a.replace);
  if (card.credits <= a.autoCredits && card.credits + card.fixCredits <= a.autoCredits) { approve(p); void advance(p.id); }
  return getProduction(p.id)!;
}

// ------------------------------------------------------------------ the turn
export type TurnInput = {
  client: Client; project: string; payer: string | null; messages: Message[];
  scene: { id: string; kind: string; doc: any } | null; selection?: any; world?: string | null; autoCredits: number; browser?: boolean;
  /** The production on the card, when the person is answering it. */
  production?: Production | null;
  /** The rest of the body, passed through to the assistant of the scene in front. */
  forward?: Record<string, unknown>;
  delegate: Delegate;
};

export async function showrunnerTurn(a: TurnInput): Promise<{ status: number; body: any }> {
  const last = String(a.messages[a.messages.length - 1]?.text ?? '').trim();
  if (!last) throw new GenError('Say something to the AI', { status: 400 });
  learn(a.project, { kind: 'turn', text: last });
  const planning = a.production?.status === 'proposed';
  const c = classify(last, a.scene?.kind ?? null, { planning });
  const world = a.world ?? worldOf(a.scene?.doc) ?? (planning ? a.production!.out.world ?? a.production!.plan.world?.id ?? null : null);

  if (c.route === 'edit') {
    if (!a.scene) return { status: 200, body: { role: 'showrunner', route: 'edit', say: 'Open a scene to change it, or tell me what to make: "a 60-second teaser about a lighthouse keeper and a sea creature".' } };
    let messages = a.messages;
    let aiCredits = 0;
    let looked: string | null = null;
    const r = refersToResults(last);
    if (r.look && Array.isArray(a.scene.doc?.clips) && shotClips(a.scene.doc).length) {
      const pics = await picturesFor(a.scene.doc, { nth: r.nth, selected: a.selection?.clips }).catch(() => null);
      if (pics) {
        const seen = await lookNote(a.project, last, pics, a.payer);
        aiCredits += seen.aiCredits;
        looked = pics.about;
        messages = [...a.messages.slice(0, -1), { role: 'user', text: `${last}\n\n(What the showrunner saw in ${pics.about}: ${seen.note})` }];
      }
    }
    const out = await a.delegate(assistantPath(a.scene.kind, a.scene.id), { ...(a.forward ?? {}), messages, ...(a.selection ? { selection: a.selection } : {}) });
    const body = out.body && typeof out.body === 'object' ? out.body : {};
    return { status: out.status, body: { ...body, role: c.role, route: 'edit', ...(looked ? { looked } : {}), ...(aiCredits ? { aiCredits: (Number(body.aiCredits) || 0) + aiCredits } : {}) } };
  }

  const ctx = await planContext(a.project, c, a.messages, world, planning ? a.production!.plan : null);
  const planned = await makePlan(a.project, a.payer, ctx);
  const p = proposeProduction({ project: a.project, client: a.client, payer: a.payer, plan: planned.plan, issues: planned.issues, world, browser: a.browser, autoCredits: a.autoCredits, replace: planning ? a.production : null });
  const started = p.status === 'running';
  const say = planned.say || (started ? `Making "${p.title}".` : `Here's the plan for "${p.title}".`);
  return { status: 200, body: { role: 'showrunner', route: 'production', say, production: publicProduction(p), started, ...(planned.aiCredits ? { aiCredits: planned.aiCredits } : {}) } };
}

// ------------------------------------------------------------------ review mode
/**
 * Fixes one moment of a cut: `t` seconds into the cut scene, an optional box on the frame (shares of its size), and what's
 * wrong. The showrunner sees the frame and the shot behind it, rewrites that shot's brief, and starts a new take through
 * the production machinery (a fix production: over the auto limit it waits for approval like any card).
 */
export async function reviewFix(a: { client: Client; project: string; payer: string | null; scene: { id: string; doc: any }; t: number; box?: { x: number; y: number; w: number; h: number } | null; text: string; autoCredits: number }) {
  const d = deps();
  const clips = shotClips(a.scene.doc);
  const len = (c: any) => (Number(c.out) - Number(c.in || 0)) / (Number(c.speed) || 1);
  const clip = clips.find((c: any) => a.t >= c.start && a.t < c.start + len(c)) ?? clips.filter((c: any) => c.start <= a.t).pop();
  if (!clip) throw new GenError('There is no shot at that moment', { status: 400 });
  const parent = productionForCut(a.scene.id);
  if (!parent || parent.project !== a.project) throw new GenError("This cut wasn't made by the showrunner, so it can't re-take a shot here. Ask the AI to change the clip instead.", { status: 400 });
  const shotKey = parent.out.clips[clip.id];
  const shot = parent.plan.shots.find((x) => x.key === shotKey);
  if (!shot) throw new GenError("That clip isn't one of the production's shots", { status: 400 });
  const file = clip.asset ? d.assetPath(clip.asset) : null;
  const frame = file ? await d.frameAt(file, Math.max(0, a.t - clip.start + Number((clip as any).in || 0))).catch(() => null) : null;
  const where = a.box ? ` They marked the area from ${Math.round(a.box.x * 100)}% across and ${Math.round(a.box.y * 100)}% down, ${Math.round(a.box.w * 100)}% wide and ${Math.round(a.box.h * 100)}% tall.` : '';
  const r = await d.ask(a.project, {
    system: 'You are the showrunner fixing one shot of a cut. You get the frame the person stopped on, the shot as planned and what they said. Answer with JSON only: {"brief": "one or two sentences added to the shot\'s description that fix it (visual, concrete, as a description of the picture, not an instruction)", "redoFrame": true when the problem is in the picture itself (a face, a costume, the place, the framing), false when it is only the motion, "say": "one short sentence to the person"}.',
    prompt: `The shot as planned: ${JSON.stringify({ action: shot.action, framing: shot.framing, move: shot.move, cast: shot.cast.map((k) => parent.plan.characters.find((c) => c.key === k)?.name), lines: shot.lines })}\nThe person said: "${a.text.slice(0, 800)}".${where}`,
    ...(frame ? { images: [frame] } : {}), maxTokens: 1200, effort: 'medium',
  });
  const aiCredits = r.house ? d.chargeAi(a.payer, r.cost, `Showrunner fix: ${a.text.slice(0, 60)}`) : 0;
  const j = jsonOf(r.text) ?? {};
  const brief = String(j.brief ?? a.text).slice(0, 800);
  const fix = createFix(parent, { shot: shot.key, clip: clip.id, scene: a.scene.id, brief, redoFrame: j.redoFrame !== false, client: a.client });
  if (fix.card.credits <= a.autoCredits) { approve(fix); void advance(fix.id); }
  return { say: String(j.say ?? 'Making a new take of that shot.').slice(0, 400), fix: publicProduction(getProduction(fix.id)!), shot: shot.key, clip: clip.id, aiCredits };
}
