// The AIs for the world kinds (src/worldkinds.ts), on the pattern of src/sceneai.ts: each sees its scene, its world and
// the tools, and answers with the whole scene changed plus the jobs to run (an element to make is marked `gen: n`). The
// world and story AIs may also propose new scenes (`create`): a world's first characters, places, props and stories, a
// story's new characters or places. They join the world.
//
//   world  builds the bible and the look; proposes members as new scenes
//   place  writes it and makes its pack (placePackPlan)
//   prop   writes it and makes its pack (propPackPlan)
//   story  writes top down: logline, then beats, then the script, then the shot list, each layer kept until changed;
//          keeps the continuity timeline
//
// "Start a world" (startWorld, keepWorld): a sentence or a mood board in, a proposal out (the world with its look, three
// characters, two places, a story idea) to keep, change or throw away; what's kept becomes scenes in that world.
//
// placePackPlan / propPackPlan turn src/identity.ts's pack plans (asset.make chains) into the jobs that fill a place's and
// a prop's elements, with the world's style line.

import crypto from 'node:crypto';
import { ask as askClaude, callScope } from './providers/anthropic.ts';
import { orgOfProject, isGenAccountProject } from './orgsecrets.ts';
import { toolMap, toolCraft } from './knowledge.ts';
import { aiCanUse, relevantTools, CRAFT_DOC } from './editor.ts';
import { createScene, getScene, saveScene, kindOf, type Scene, type Kind } from './scenes.ts';
import { applyScene, parseScene, type SceneJob } from './sceneai.ts';
import { worldContext, worldOf, type WorldContext } from './worlds.ts';
import { normalizePlace, normalizeProp, normalizeWorld, normalizeStory, isWorldKind, type PlaceDoc, type PropDoc, type WorldDoc } from './worldkinds.ts';
import { normalizeCharacter } from './scenekinds.ts';
import { GenError } from './util.ts';
import { placePackPlan as identityPlacePlan, propPackPlan as identityPropPlan } from './identity.ts';

type AskFn = (p: any) => Promise<{ text: string; model?: string; cost?: number; billing?: string }>;
let askFn: AskFn = askClaude as AskFn;
/** Swaps the model call (tests; a mock). */
export function useAsk(fn: AskFn | null) { askFn = fn ?? (askClaude as AskFn); }
const seed = () => crypto.randomInt(0, 2 ** 31);

const ELEMENT = '{"asset": "a_..."} | {"gen": n} | null';
export const DOCS: Record<string, string> = {
  world: `A world scene (JSON): {"title", "logline": one sentence, "tone": a few words, "rules": ["the world's canon: short, checkable rules every script and picture must keep", ...], "history": a few paragraphs, "factions": [{"name", "about"}],
 "look": {"style": ONE style line of 15 to 40 words pasted after every prompt made in this world (medium, era, lens and light habits, texture; no characters), "negative": what never appears, "palette": ["#rrggbb", 3 to 6], "grade": {"params": {"contrast", "saturation", "warmth", "tint", "exposure", "grain", "vignette", "fade": each -1..1}} | null},
 "board": [{"id": keep it, "asset": "a_..." | "gen": n}]: the style board, 2 to 4 pictures of the look itself (places and moods, never the characters),
 "members": [scene ids], "notes"}
New scenes for the world go in "create": [{"kind": "character" | "place" | "prop" | "story", "doc": that kind's document}] (they join the world). Propose 3 characters, 2 places and a story idea when the world is new; never re-create one that's in the world already.`,
  place: `A place scene (JSON): {"title", "description": what it is and how it looks, as words a picture can be painted from,
 "panorama": ${ELEMENT} (a 360° equirectangular panorama: image.panorama), "views": [{"id", "name": "wide" | "entrance" | ..., "asset" | "gen"}] (key views: image.generate, 16:9),
 "set": ${ELEMENT} (an optional 3D set model), "variants": [{"id", "kind": "time" | "weather", "name": "night" | "rain" | ..., "asset" | "gen"}] (the panorama or a key view at that time or weather: image.edit on el:<the view>),
 "ambience": ${ELEMENT} (its sound: audio.sfx, a 20-30 second loop of the room tone), "notes"}`,
  prop: `A prop scene (JSON): {"title", "description": what it is, its size, materials, colors, wear, as words a picture can be painted from,
 "sheet": ${ELEMENT} (a clean product-style sheet of the object alone on a plain light background: image.generate), "views": [{"id", "name", "asset" | "gen"}],
 "model": ${ELEMENT} (its 3D model: one asset.make chain sheet → image.remove-background → image.viewsheet on "$prev:cutout" → mesh.views3d on "$prev:sheet"),
 "owner": a character scene id | null, "notes"}`,
  story: `A story scene (JSON): {"title", "level": "story" | "series" | "episode", "parent": the series' scene id (an episode) | null, "number": the episode's number | null,
 "logline": one sentence, "beats": [{"id", "text"}] (8 to 15 beats),
 "script": [{"id", "heading": "INT. PLACE - NIGHT", "place": a place scene id | null, "time": "night" | ..., "action": what we see, "lines": [{"who": a character scene id | null, "name": who speaks, "text", "how": how it's said}]}],
 "shots": [{"id", "scene": a script scene's id, "title", "what": what happens in the shot, "framing": "wide" | "close-up" | ..., "place": a place id, "cast": [character ids], "props": [prop ids], "stage": the stage shot made from it (keep it)}],
 "continuity": [{"id", "at": a shot id, "who": a character id | null, "key": "wears" | "injury" | "heal" | "holds" | "drops" | "at" | "time", "value": the outfit, the injury, a prop id, a place id or name, or the time of day}]: the changes as they happen (each shot then carries "state", read-only), "notes"}
Write top down: logline, then beats, then the script, then the shot list. Do the layer asked for (or the next one missing) and keep every layer above it exactly as it is unless the person asks to change it. Use the world's characters, places and props by id; new ones go in "create" (they join the world). Keep continuity: record every change of clothes, injury, prop changing hands, move and time of day at the shot where it happens. Break none of the world's rules.`,
};

function system(kind: string) {
  return `You are the AI in Hawkes Gen's ${kind} editor, part of a world the person is building. The person works on one ${kind} scene and talks to you; you change it by answering with the whole scene, and you make what it needs with Gen's tools. Be decisive; do what they ask in as few jobs as it takes; generating costs them credits (1 credit = 1 cent), so don't remake what's there. Keep everything they didn't ask to change, and keep ids. Jobs made in a world get its look added on their own: don't repeat the style line in prompts.

${DOCS[kind]}

Every tool on this Gen ("+N node settings": its ComfyUI graph has N more settings for params.nodes):
${toolMap(aiCanUse)}

${CRAFT_DOC}

Jobs: [{"gen": n (the index the elements name), "tool": "...", "params": {...}, "inputs": {"image": "el:<element id>" | "a_..."}, "label": "a short name"}]. Inputs take the element's file now (before this answer's changes).

Answer with JSON only: {"say": "one or two short sentences to the person", "doc": { the whole scene }, "jobs": [ ... ], "create": [ ... ]}.`;
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['say', 'doc', 'jobs'],
  properties: { say: { type: 'string' }, doc: { type: 'object' }, jobs: { type: 'array', items: { type: 'object' } }, create: { type: 'array', items: { type: 'object' } } },
};

export type NewScene = { kind: 'character' | 'place' | 'prop' | 'story'; doc: any };
export type WorldAnswer = { say: string; doc: any; jobs: SceneJob[]; create: NewScene[] };
const CREATABLE = ['character', 'place', 'prop', 'story'];

export function parseWorldAnswer(text: string, was: any): WorldAnswer {
  const base = parseScene(text, was);
  let create: NewScene[] = [];
  try {
    let t = String(text ?? '').trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
    if (fence) t = fence[1].trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    const j = JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t);
    create = (Array.isArray(j.create) ? j.create : []).filter((c: any) => c && CREATABLE.includes(c.kind) && c.doc && typeof c.doc === 'object').slice(0, 12);
  } catch { /* no create */ }
  return { ...base, create };
}

export type WorldTurnInput = {
  scene: Scene; messages: { role: 'user' | 'assistant'; text: string }[]; selection?: unknown;
  library: { id: string; kind: string; title?: string | null; prompt?: string | null }[];
  scenes: { id: string; kind: string; title: string }[]; voices: { id: string; name: string; about: string }[];
};

/** What the AI is told about the scene's world (the scene's own, or the world itself). */
function worldBrief(s: Scene): WorldContext | null {
  return worldContext(s.project, s.kind === 'world' ? s.id : worldOf(s.doc));
}

export function worldPrompt(a: WorldTurnInput) {
  const convo = a.messages.slice(-16).map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${String(m.text).slice(0, 4000)}`).join('\n\n');
  const last = String(a.messages[a.messages.length - 1]?.text ?? '');
  const craft = a.scene.kind === 'story' ? '' : toolCraft(relevantTools(last));
  const w = worldBrief(a.scene);
  return {
    system: system(a.scene.kind),
    prompt: `The ${a.scene.kind} scene now:\n${JSON.stringify(a.scene.doc)}\n\n${w && a.scene.kind !== 'world' ? `Its world, "${w.title}" (rules, look, and who and what is in it, by scene id):\n${JSON.stringify({ rules: w.canon, look: { style: w.look.style, negative: w.look.negative }, characters: w.characters.map((c) => ({ id: c.id, name: c.title, description: c.description.slice(0, 400) })), places: w.places.map((p) => ({ id: p.id, name: p.title, description: p.description.slice(0, 300) })), props: w.props.map((p) => ({ id: p.id, name: p.title, description: p.description.slice(0, 200) })) })}\n\n` : ''}${w && a.scene.kind === 'world' ? `In the world now: ${JSON.stringify({ characters: w.characters.map((c) => c.title), places: w.places.map((p) => p.title), props: w.props.map((p) => p.title) })}\n\n` : ''}The person's selection: ${JSON.stringify(a.selection ?? {})}\n\nTheir other scenes:\n${JSON.stringify(a.scenes.slice(0, 40))}\n\nRecent files in their library:\n${JSON.stringify(a.library.slice(0, 30))}\n\n${a.scene.kind === 'story' ? `Voices:\n${JSON.stringify(a.voices.slice(0, 30).map((v) => ({ id: v.id, name: v.name })))}\n\n` : ''}${craft ? `How the tools this likely needs work:\n${craft}\n\n` : ''}The conversation (the last line is what to do now):\n${convo}`,
    // A story is planned: thought through (the beats, the 180° rule, continuity), not a quick edit.
    schema: SCHEMA, maxTokens: a.scene.kind === 'story' ? 16000 : 8000, effort: a.scene.kind === 'story' || a.scene.kind === 'world' ? 'high' : 'medium',
  };
}

const scoped = <T>(project: string, fn: () => Promise<T>) => callScope.run({ customer: true, org: orgOfProject(project), house: isGenAccountProject(project) }, fn);

export async function worldTurn(a: WorldTurnInput) {
  if (!DOCS[a.scene.kind]) throw new GenError(`No AI for ${a.scene.kind} scenes here`, { status: 400 });
  const r = await scoped(a.scene.project, () => askFn(worldPrompt(a)));
  return { answer: parseWorldAnswer(r.text, a.scene.doc), model: r.model ?? '', house: !['byok', 'subscription'].includes(String(r.billing ?? '')), cost: Number(r.cost ?? 0) };
}

type Deps = Parameters<typeof applyScene>[2];

/**
 * Applies a world-kind answer: the scene and its jobs through applyScene (the same marks, el: inputs and proposals),
 * then its new scenes made in the world (a world lists them as members). Over the auto limit nothing is made.
 */
export function applyWorldAnswer(s: Scene, ans: { doc: any; jobs: SceneJob[]; create?: NewScene[] }, deps: Deps) {
  const r = applyScene(s, ans, deps);
  const proposed = r.proposed ? { ...r.proposed, create: ans.create ?? [] } : undefined;
  if (proposed) return { ...r, proposed, created: [] as Scene[] };
  const world = s.kind === 'world' ? s.id : worldOf(s.doc);
  const created: Scene[] = [];
  for (const c of ans.create ?? []) {
    try { created.push(createScene(s.project, c.kind as Kind, { ...c.doc, ...(world ? { world } : {}) })); } catch (e: any) { r.errors.push(`${c.kind}: ${e.message}`); }
  }
  let doc = r.doc;
  if (s.kind === 'world' && created.length) doc = kindOf('world').normalize({ ...doc, members: [...doc.members, ...created.map((x) => x.id)] });
  return { ...r, proposed, doc, created };
}

// ------------------------------------------------------------------ packs
export type PackPlan = { doc: any; jobs: SceneJob[] };
const want = (e: any) => !e || (!e.asset && !e.pending);

/** The world's style line for a scene (its own world, or itself when it's a world): fed to the pack plans as `style`. */
function styleOf(s: { kind?: string; id?: string; project?: string; doc: any }) {
  const id = s.kind === 'world' ? s.id : worldOf(s.doc);
  return s.project && id ? worldContext(s.project, id)?.look.style ?? '' : '';
}

/**
 * The jobs that make a place's pack, for what's missing: one asset.make chain from src/identity.ts placePackPlan (a
 * panorama, then three key views painted from it; or only the views, from the panorama it has), each element taking its
 * saved output (`from`), and its ambience.
 */
export function placePackPlan(doc: PlaceDoc | any, o: { style?: string } = {}): PackPlan {
  const d = normalizePlace(doc);
  const jobs: SceneJob[] = [];
  const out: any = structuredClone(d);
  const steps: any[] = identityPlacePlan(d.description.trim() || d.title, { style: o.style }).steps;
  const needViews = !d.views.some((v) => v.asset || v.pending);
  if (want(d.panorama) || (needViews && d.panorama?.asset)) {
    const fromPano = !want(d.panorama);
    // With a panorama already made, the views are painted from it (the chain's first step becomes the job's input).
    const chain = fromPano ? steps.slice(1).map((st) => ({ ...st, inputs: { images: ['$input:0'] } })) : needViews ? steps : steps.slice(0, 1);
    jobs.push({ gen: 0, tool: 'asset.make', params: { steps: chain, seed: seed() }, inputs: fromPano ? { files: [`el:${d.panorama!.id}`] } : {}, label: `${d.title}: ${fromPano ? 'views' : 'panorama and views'}` });
    if (!fromPano) out.panorama = { gen: 0, from: 'panorama' };
    if (needViews) out.views = [...out.views, ...[['wide', 'view-wide'], ['eye level', 'view-eye'], ['reverse', 'view-reverse']].map(([name, from]) => ({ name, gen: 0, from }))];
  }
  if (want(d.ambience)) { jobs.push({ gen: jobs.length, tool: 'audio.sfx', params: { text: `Ambience, room tone of ${(d.description.trim() || d.title).slice(0, 200)}, a seamless loop`, seconds: 20 }, inputs: {}, label: `${d.title}: ambience` }); out.ambience = { gen: jobs.length - 1 }; }
  return { doc: out, jobs };
}

/**
 * The jobs that make a prop's pack: one asset.make chain from src/identity.ts propPackPlan (the prop alone, cut out,
 * then a checked view sheet); the sheet is its `sheet`, the front picture a view.
 */
export function propPackPlan(doc: PropDoc | any, o: { style?: string } = {}): PackPlan {
  const d = normalizeProp(doc);
  const jobs: SceneJob[] = [];
  const out: any = structuredClone(d);
  if (want(d.sheet)) {
    jobs.push({ gen: 0, tool: 'asset.make', params: { steps: identityPropPlan(d.description.trim() || d.title, { style: o.style }).steps, seed: seed() }, inputs: {}, label: `${d.title}: sheet` });
    out.sheet = { gen: 0, from: 'sheet' };
    if (!d.views.some((v) => v.asset || v.pending)) out.views = [...out.views, { name: 'front', gen: 0, from: 'front' }];
  }
  return { doc: out, jobs };
}

/** A world's style board: two pictures of the look itself, when it has none. */
export function worldPackPlan(doc: WorldDoc | any): PackPlan {
  const d = normalizeWorld(doc);
  const out: any = structuredClone(d);
  const jobs: SceneJob[] = [];
  if (!d.board.some((b) => b.asset || b.pending)) {
    const about = [d.logline, d.tone].filter(Boolean).join('. ') || d.title;
    for (const [i, what] of ['A wide landscape of this world, no people', 'An interior of this world, close and detailed, no people'].entries()) {
      jobs.push({ gen: i, tool: 'image.generate', params: { prompt: `${what}: ${about}.`, width: 1344, height: 768, seed: seed() }, inputs: {}, label: `${d.title}: style board` });
      out.board.push({ gen: i });
    }
  }
  return { doc: out, jobs };
}

/** A character's first pictures (front and portrait), when they have none. Their full identity pack is src/identity.ts's. */
export function characterPackPlan(doc: any): PackPlan {
  const d = normalizeCharacter(doc);
  const out: any = structuredClone(d);
  const jobs: SceneJob[] = [];
  const look = d.description.trim() || d.title;
  const has = (role: string) => d.pictures.some((p) => p.role === role && (p.asset || p.pending));
  if (!has('front')) { jobs.push({ gen: jobs.length, tool: 'image.generate', params: { prompt: `${look}. Full body, front view, standing in an A-pose, nothing in their hands, plain light grey background, even studio light.`, width: 768, height: 1344, seed: seed() }, inputs: {}, label: `${d.title}: front` }); out.pictures.push({ role: 'front', gen: jobs.length - 1 }); }
  if (!has('portrait')) { jobs.push({ gen: jobs.length, tool: 'image.generate', params: { prompt: `${look}. Head and shoulders portrait, looking at the camera, soft studio light, plain background.`, width: 1024, height: 1024, seed: seed() }, inputs: {}, label: `${d.title}: portrait` }); out.pictures.push({ role: 'portrait', gen: jobs.length - 1 }); }
  return { doc: out, jobs };
}

export function packPlan(kind: string, doc: any, o: { style?: string } = {}): PackPlan | null {
  if (kind === 'world') return worldPackPlan(doc);
  if (kind === 'place') return placePackPlan(doc, o);
  if (kind === 'prop') return propPackPlan(doc, o);
  if (kind === 'character') return characterPackPlan(doc);
  return null;
}

// ------------------------------------------------------------------ start a world
export type WorldProposal = {
  say: string;
  world: WorldDoc;
  characters: any[];
  places: any[];
  props: any[];
  story: any | null;
};

const START_SYSTEM = `You start worlds in Hawkes Gen. From one sentence (and maybe a mood board), propose a world a person can build films, shows and games in: specific, vivid, with a strong look. Answer with JSON only:
{"say": one short sentence to the person,
 "world": ${DOCS.world.split('\n')[0].replace('A world scene (JSON): ', '')} (no board, no members),
 "characters": [3 characters: {"title": their name, "description": 50 to 80 words of how they look (face, build, hair, clothes, colors), the same words every picture of them will use, "notes": who they are in one or two sentences}],
 "places": [2 places: {"title", "description": how it looks, as words a picture can be painted from}],
 "props": [0 to 2 props that matter to the story: {"title", "description"}],
 "story": {"title", "logline", "beats": [{"text"}: 6 to 10 beats]}}
The world's rules are its canon: short and checkable ("the moon is always red", "no one says the founder's name"). The style line describes the look, never the people.`;

const START_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['say', 'world', 'characters', 'places', 'story'],
  properties: { say: { type: 'string' }, world: { type: 'object' }, characters: { type: 'array', items: { type: 'object' } }, places: { type: 'array', items: { type: 'object' } }, props: { type: 'array', items: { type: 'object' } }, story: { type: 'object' } },
};

/** Reads a proposal, every part normalized as the scene it will become. */
export function parseProposal(text: string): WorldProposal {
  let t = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  let j: any;
  try { j = JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t); } catch { throw new GenError('The AI\'s answer was not a world. Try again.', { status: 502 }); }
  const arr = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []).filter((x) => x && typeof x === 'object');
  return {
    say: String(j.say ?? '').slice(0, 600),
    world: normalizeWorld({ ...j.world, board: [], members: [] }),
    characters: arr(j.characters, 6).map((c) => normalizeCharacter(c)),
    places: arr(j.places, 6).map((p) => normalizePlace(p)),
    props: arr(j.props, 4).map((p) => normalizeProp(p)),
    story: j.story && typeof j.story === 'object' ? normalizeStory({ ...j.story, level: 'story' }) : null,
  };
}

/** A world proposed from a sentence (and the mood board's pictures, when given: local paths of the assets). */
export async function startWorld(project: string, idea: string, board: { id: string; path?: string }[] = []) {
  const words = String(idea ?? '').trim();
  if (!words && !board.length) throw new GenError('Say what the world is, or drop a mood board', { status: 400 });
  const images = board.map((b) => b.path).filter((p): p is string => Boolean(p)).slice(0, 4);
  const r = await scoped(project, () => askFn({
    system: START_SYSTEM,
    prompt: `${words ? `The idea: ${words.slice(0, 2000)}` : 'No words: the world comes from the mood board.'}${images.length ? `\n\nThe mood board is attached (${images.length} picture${images.length === 1 ? '' : 's'}): take the look from it.` : ''}`,
    ...(images.length ? { images } : {}), schema: START_SCHEMA, maxTokens: 8000, effort: 'high',
  }));
  const proposal = parseProposal(r.text);
  // The mood board the person dropped is the world's style board.
  if (board.length) proposal.world = normalizeWorld({ ...proposal.world, look: { ...proposal.world.look, board: board.map((b) => b.id) } });
  return { proposal, model: r.model ?? '', house: !['byok', 'subscription'].includes(String(r.billing ?? '')), cost: Number(r.cost ?? 0) };
}

/**
 * Makes the kept parts of a proposal into scenes: the world, then each kept character, place, prop and the story, all
 * naming the world and listed as its members. `keep` says which by index (missing: all kept); `story: false` drops it.
 */
export function keepWorld(project: string, p: Partial<WorldProposal>, keep: { characters?: number[]; places?: number[]; props?: number[]; story?: boolean } = {}) {
  const pick = <T>(xs: T[] | undefined, idx?: number[]) => (xs ?? []).filter((_, i) => !idx || idx.includes(i));
  const world = createScene(project, 'world', normalizeWorld({ ...p.world, members: [] }));
  const members: Scene[] = [];
  const make = (kind: Kind, doc: any) => members.push(createScene(project, kind, { ...doc, world: world.id }));
  for (const c of pick(p.characters, keep.characters)) make('character', c);
  for (const pl of pick(p.places, keep.places)) make('place', pl);
  for (const pr of pick(p.props, keep.props)) make('prop', pr);
  if (p.story && keep.story !== false) make('story', { ...p.story, level: 'story' });
  const saved = saveScene(world, { ...world.doc, members: members.map((m) => m.id) });
  return { world: saved, members };
}

/** The pack jobs for a world and every member missing its pictures, each applied to its scene (priced, or run). */
export function makeWorldPacks(project: string, worldId: string, canSee: (p: string) => boolean, deps: Omit<Deps, 'autoCredits'> & { confirm?: boolean; autoCredits?: number }) {
  const world = getScene(worldId, canSee, 'world');
  const scenes = [world, ...(world.doc.members as string[]).map((id) => { try { return getScene(id, canSee); } catch { return null; } }).filter((x): x is Scene => Boolean(x) && x!.project === project)];
  return packScenes(scenes, deps);
}

/** The pack jobs for these scenes (what each is missing), priced; run when confirmed or under the auto limit. */
export function packScenes(scenes: Scene[], deps: Omit<Deps, 'autoCredits'> & { confirm?: boolean; autoCredits?: number }) {
  const plans = scenes.map((s) => ({ s, plan: packPlan(s.kind, s.doc, { style: styleOf(s) }) })).filter((x) => x.plan && x.plan.jobs.length) as { s: Scene; plan: PackPlan }[];
  const credits = plans.reduce((n, x) => n + x.plan.jobs.reduce((m, j) => m + deps.quote(j.tool, j.params), 0), 0);
  if (!deps.confirm && credits > (deps.autoCredits ?? 0)) return { credits, jobs: plans.reduce((n, x) => n + x.plan.jobs.length, 0), started: [], errors: [] as string[], proposed: true };
  const started: { scene: string; job: string; tool: string }[] = [];
  const errors: string[] = [];
  for (const { s, plan } of plans) {
    const r = applyScene(s, plan, { ...deps, autoCredits: Infinity, confirm: true, submit: (spec) => deps.submit({ ...spec, scene: s.id } as any) });
    saveScene(s, r.doc);
    started.push(...r.started.map((x) => ({ scene: s.id, job: x.job, tool: x.tool })));
    errors.push(...r.errors);
  }
  return { credits, jobs: started.length, started, errors, proposed: false };
}

export { isWorldKind };
