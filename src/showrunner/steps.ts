// A plan compiled into steps (docs/showrunner.md): what a production does, in order, each step a job or a scene write.
// Steps name what they wait for (`after`) and take earlier steps' files as inputs ("$step:<id>"), so the runner
// (production.ts) can start whatever is ready and resume after a restart. Every generating step is a MakeRequest: it
// goes through `make.checked` when this Gen has it (gen-make's checked making loop), else straight to the routed tool.
//
// Filming here needs no browser: a shot's first frame is painted from the references (the place's view first, then the
// cast's pictures) with image.edit, and the shot is made from it by what the shot is (MakeIntent): dialogue talks to its
// line, two people share a scene, everything else moves from its first frame. When the page is open, the director can
// claim a shot and film it on the stage instead (production.ts claimShot).

import { route, type MakeIntent, type MakeRequest } from '../make/index.ts';
import type { Plan, PlanShot } from './plan.ts';

export const MAKE_TOOL = 'make.checked';

export type StepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
export type Write = 'world' | 'character' | 'place' | 'story' | 'shots' | 'cut' | 'review';
export type Step = {
  id: string; label: string; after: string[]; status: StepStatus;
  /** A scene write (done here, free), or a make (a job). */
  write?: Write; key?: string;
  make?: Omit<MakeRequest, 'project'>;
  /** What kind of thing it makes, for the card's counts. */
  makes?: 'picture' | 'clip' | 'voice' | 'music';
  /** Credits quoted when the plan was priced (make.checked: its worst case). */
  credits: number;
  /** The filming step's shot, and whether the page may film it on the stage. */
  shot?: string; browser?: boolean;
  job?: string | null; tool?: string | null; asset?: string | null; scene?: string | null; error?: string | null; tries: number;
  claimed?: number | null;
};

export type Refs = { characters: Record<string, string[]>; places: Record<string, string[]> };

/** Frame sizes for the shapes, as the video tools take them (multiples of 16). */
export const SIZES: Record<Plan['aspect'], [number, number]> = { '16:9': [832, 480], '9:16': [480, 832], '1:1': [640, 640] };
const framesFor = (seconds: number, fps = 16) => Math.min(161, Math.max(5, Math.round((seconds * fps - 1) / 4) * 4 + 1));

const S = (id: string, label: string, after: string[], x: Partial<Step>): Step => ({ id, label, after, status: 'waiting', credits: 0, tries: 0, job: null, asset: null, ...x });

function brief(plan: Plan, style: string, s: PlanShot) {
  const who = s.cast.map((k) => plan.characters.find((c) => c.key === k)).filter(Boolean).map((c) => `${c!.name}: ${c!.description}`).join(' ');
  const where = plan.places.find((p) => p.key === s.place);
  return [style, `${s.framing} shot${s.move && s.move !== 'static' ? `, camera ${s.move}` : ''}.`, where ? `${where.name}: ${where.description}.` : '', who, s.action].filter(Boolean).join(' ').slice(0, 2400);
}

/**
 * The steps for a plan. `refs` are the existing characters' and places' reference pictures (identity packs, world
 * members); new ones get a picture step first. `style` is the world's style line. `browser`: the page is open, so the
 * filming steps may be claimed by its stage.
 */
export function compileSteps(plan: Plan, o: { style?: string; negative?: string; refs?: Refs; world?: string | null; budgetPerStep?: number; browser?: boolean } = {}): Step[] {
  const style = o.style ?? plan.world?.style ?? '';
  const refs: Refs = { characters: { ...(o.refs?.characters ?? {}) }, places: { ...(o.refs?.places ?? {}) } };
  const [width, height] = SIZES[plan.aspect];
  const req = (intent: MakeIntent, b: string, x: Partial<Omit<MakeRequest, 'project'>> = {}): Omit<MakeRequest, 'project'> => ({
    intent, brief: b.slice(0, 2400), quality: 'final', world: o.world ?? null, ...(o.budgetPerStep ? { budgetCredits: o.budgetPerStep } : {}), ...x,
  });
  const steps: Step[] = [];
  const add = (s: Step) => { steps.push(s); return s.id; };
  const refOf = (ids: string[]) => ids.map((r) => (r.startsWith('$step:') ? r : `asset:${r}`));

  if (plan.world && !plan.world.id) add(S('world', `World: ${plan.world.title}`, [], { write: 'world' }));
  const worldDep = steps.some((s) => s.id === 'world') ? ['world'] : [];

  // Characters: the scene, then (when they have no pictures) a front picture every shot reads from.
  for (const c of plan.characters) {
    if (c.id && refs.characters[c.key]?.length) continue;
    const scene = add(S(`char:${c.key}`, `Character: ${c.name}`, worldDep, { write: 'character', key: c.key }));
    const pic = add(S(`look:${c.key}`, `${c.name}'s picture`, [scene], {
      makes: 'picture', key: c.key,
      make: req('character-sheet', `${style} ${c.name}, full body, front view, standing relaxed, plain light grey background, nothing in their hands. ${c.description}`, {
        tool: 'image.generate', params: { prompt: `${style} ${c.name}, full body, front view, standing relaxed, plain light grey background, nothing in their hands. ${c.description}`.trim(), width: 768, height: 1152, ...(o.negative ? { negative: o.negative } : {}) },
      }),
    }));
    refs.characters[c.key] = [`$step:${pic}`];
  }
  // Places: the scene (when the kind exists) and a wide view shots are set in.
  for (const p of plan.places) {
    if (p.id && refs.places[p.key]?.length) continue;
    const scene = add(S(`place:${p.key}`, `Place: ${p.name}`, worldDep, { write: 'place', key: p.key }));
    const view = add(S(`view:${p.key}`, `${p.name}, a wide view`, [scene], {
      makes: 'picture', key: p.key,
      make: req('image', `${style} ${p.name}, wide establishing view, no people. ${p.description}`, { tool: 'image.generate', params: { prompt: `${style} ${p.name}, wide establishing view, no people. ${p.description}`.trim(), width: width * 2, height: height * 2, ...(o.negative ? { negative: o.negative } : {}) } }),
    }));
    refs.places[p.key] = [`$step:${view}`];
  }
  if (plan.kind === 'character' || plan.kind === 'world' || !plan.shots.length) return steps;

  const shots = add(S('shots', `${plan.shots.length} shots on the stage`, [...worldDep, ...steps.filter((s) => s.write === 'character' || s.write === 'place').map((s) => s.id)], { write: 'shots' }));
  // The story is filed after the stage shots, so its shot list can name them.
  const story = add(S('story', `Story: ${plan.title}`, [shots], { write: 'story' }));

  const filmed: string[] = [];
  const voiced: string[] = [];
  for (const s of plan.shots) {
    const lines = s.lines.map((l, i) => {
      const c = plan.characters.find((x) => x.key === l.who);
      return add(S(`line:${s.key}:${i}`, `${c?.name ?? 'Line'}: "${l.text.slice(0, 50)}"`, [shots], {
        makes: 'voice', shot: s.key,
        make: req('voice', l.text, { params: { text: l.text, ...(c?.voice ? { voice: c.voice } : {}), ...(l.direction ? { direction: l.direction } : {}) } }),
      }));
    });
    voiced.push(...lines);
    const castRefs = s.cast.flatMap((k) => refs.characters[k]?.slice(0, 1) ?? []);
    const placeRef = s.place ? refs.places[s.place]?.[0] : undefined;
    const images = [...(placeRef ? [placeRef] : []), ...castRefs].slice(0, 3);
    const deps = [shots, ...images.filter((r) => r.startsWith('$step:')).map((r) => r.slice(6))];
    const words = brief(plan, style, s);
    const frame = add(S(`frame:${s.key}`, `Shot ${s.key}: first frame`, [...new Set(deps)], {
      makes: 'picture', shot: s.key,
      make: images.length
        ? req('first-frame', words, { tool: 'image.edit', inputs: { images: refOf(images) }, params: { prompt: `A film still. ${placeRef && castRefs.length ? 'Put the people from the other pictures into this place, on-model.' : ''} ${words}`.trim(), width, height }, refs: { identity: castRefs.filter((r) => !r.startsWith('$step:')) } })
        : req('first-frame', words, { tool: 'image.generate', params: { prompt: words, width, height } }),
    }));
    const secs = Math.max(2, s.seconds);
    let shot: Omit<MakeRequest, 'project'>;
    if (s.type === 'dialogue' && lines.length) {
      shot = req('shot-dialogue', words, { inputs: { image: `$step:${frame}`, audio: `$step:${lines[0]}` }, params: { prompt: `${s.lines[0]?.direction ?? ''} ${s.action}`.trim() || 'speaks naturally', width, height, frames: framesFor(secs, 25), fps: 25 } });
    } else if (s.type === 'two-people' && castRefs.length >= 2) {
      shot = req('shot-two-people', words, { inputs: { image: castRefs[0], image2: castRefs[1], set: `$step:${frame}` }, params: { prompt: words, seconds: Math.round(secs) } });
    } else {
      // Action staged on the stage films with video.control in the browser; here there's no stage render, so the shot
      // moves from its painted first frame.
      shot = req('shot-action', words, { tool: 'video.i2v', inputs: { start: `$step:${frame}` }, params: { prompt: s.action || words, width, height, frames: framesFor(secs), fps: 16 } });
    }
    const after = [frame, ...(shot.intent === 'shot-dialogue' ? [lines[0]] : []), ...Object.values(shot.inputs ?? {}).filter((v) => typeof v === 'string' && v.startsWith('$step:')).map((v) => String(v).slice(6))];
    filmed.push(add(S(`shot:${s.key}`, `Shot ${s.key}: ${s.action.slice(0, 60) || s.type}`, [...new Set(after)], { makes: 'clip', shot: s.key, make: shot, browser: Boolean(o.browser) && shot.intent === 'shot-action' })));
  }
  const music = plan.music ? add(S('music', 'Score', [story], { makes: 'music', make: req('music', plan.music.brief, { params: { prompt: plan.music.brief, seconds: Math.min(190, Math.max(10, plan.seconds)) } }) })) : null;
  const cut = add(S('cut', 'The cut', [...filmed, ...voiced, ...(music ? [music] : [])], { write: 'cut' }));
  add(S('review', 'Checking every shot', [cut], { write: 'review' }));
  return steps;
}

/** The tool a step's make runs as: make.checked when this Gen has it, else the routed tool (fallback). */
export function toolFor(step: Step, hasTool: (id: string) => boolean): { tool: string; params: Record<string, any>; inputs: Record<string, any>; checked: boolean } {
  const m = step.make!;
  if (hasTool(MAKE_TOOL)) return { tool: MAKE_TOOL, params: { ...m }, inputs: {}, checked: true };
  const r = route({ intent: m.intent, tool: m.tool, params: m.params });
  return { tool: r.tool, params: r.params, inputs: m.inputs ?? {}, checked: false };
}

// ------------------------------------------------------------------ the approval card
export type Card = {
  counts: Record<string, number>; credits: number; minutes: number;
  /** Most the review may spend on new takes of shots that fail their checks (shown on the card, part of what's approved). */
  fixCredits: number;
  /** The plan as words, top down. */
  outline: ReturnType<typeof import('./plan.ts').planOutline>;
  issues: string[];
  steps: { id: string; label: string; credits: number }[];
};
/** Minutes of machine time per thing made, for "how long" (several run at once: about three). */
/** The share of the shots' price kept for re-taking the ones that fail their checks. */
export const FIX_SHARE = 0.25;
const MINUTES: Record<NonNullable<Step['makes']>, number> = { picture: 1, clip: 5, voice: 0.5, music: 2 };

export function cardFor(plan: Plan, steps: Step[], outline: Card['outline'], issues: string[] = []): Card {
  const counts: Record<string, number> = {};
  const inc = (k: string, n = 1) => { if (n) counts[k] = (counts[k] ?? 0) + n; };
  inc('world', plan.world && !plan.world.id ? 1 : 0);
  inc('characters', plan.characters.filter((c) => !c.id).length);
  inc('places', plan.places.filter((p) => !p.id).length);
  inc('shots', plan.shots.length);
  for (const s of steps) if (s.makes) inc({ picture: 'pictures', clip: 'clips', voice: 'voice lines', music: 'music' }[s.makes]);
  if (steps.some((s) => s.write === 'cut')) inc('cut');
  const work = steps.reduce((n, s) => n + (s.makes ? MINUTES[s.makes] : 0), 0);
  return {
    counts, credits: steps.reduce((n, s) => n + (s.credits || 0), 0), minutes: Math.max(1, Math.ceil(work / 3)),
    fixCredits: Math.ceil(steps.filter((s) => s.makes === 'clip').reduce((n, s) => n + (s.credits || 0), 0) * FIX_SHARE),
    outline, issues, steps: steps.filter((s) => s.make).map((s) => ({ id: s.id, label: s.label, credits: s.credits })),
  };
}
