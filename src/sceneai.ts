// The AI for character scenes (video, image and audio are timelines with the AI editor, src/editor.ts; stage has the AI
// director, src/director.ts). It sees the scene and the person's selection, knows every tool (src/knowledge.ts toolMap, chains,
// node settings) and the craft of the ones a request needs, and answers with the whole scene changed plus the jobs to run.
// An element to make is marked `gen: n` (jobs[n] makes its file); a job's input "el:<id>" is that element's current file,
// so "a new portrait" is the picture marked and a job on el:<the front picture's id>. Jobs are submitted here and the marked elements
// wait on them (`pending`, filled when they end: src/scenekinds.ts). Generation over `autoCredits` comes back as a
// proposal for one tap (applyScene with confirm).

import { ask, callScope } from './providers/anthropic.ts';
import { orgOfProject, isHouseProject } from './orgsecrets.ts';
import { toolMap, toolCraft } from './knowledge.ts';
import { aiCanUse, relevantTools, CRAFT_DOC } from './editor.ts';
import { kindOf, type Scene } from './scenes.ts';
import { fileElements } from './scenekinds.ts';
import { getTool } from './tools/index.ts';
import { GenError } from './util.ts';

const DOCS: Record<string, string> = {
  character: `A character scene (JSON): {"title": their name, "description": how they look (face, build, hair, clothes, colors, era): every tool paints them from these words, "height": meters, "color": "#rrggbb" (their stand-in on a stage), "voice": a voice id from the voices list or null,
 "model": {"asset": "a_..." a GLB} | {"gen": n} | null,
 "pictures": [{"id": keep it, "role": "portrait" | "front" | "cutout" | "sheet" | "turnaround" | "reference", "asset": "a_..." | "gen": n, "from": "the saved step's name to take when job n is an asset.make chain that saves several"}],
 "clips": [{"name": an animation clip in their model}], "notes": anything to remember,
 "lock": {"sheet": "a_..." their character sheet, "description": their FIXED description, "at": null (a draft) | a time (locked)} (their identity pack: every shot they're in pastes the fixed description unchanged and uses the sheet as its reference, so they look the same everywhere),
 "lora": read only (Gen learns their look when the person asks: keep it as it is)}
Making a character: a "front" picture (image.generate: full body, front view, A-pose, plain light background, their description), a "portrait" (a head-and-shoulders picture of the same person), then for 3D one asset.make chain (front → image.remove-background → image.viewsheet on "$prev:cutout" → mesh.views3d on "$prev:sheet", and mesh.rig to make them move) whose result is the model {"gen": n}. Pick a voice that fits. Take what's there into account: a model needs a front picture first.
Their look (the identity pack; do it whenever you make a new character, or when they ask to make, redo or lock their look): 1) the front picture: full body, front view, relaxed A-pose, EMPTY HANDS (props drift between angles), plain light grey background, even studio light; 2) their sheet: image.edit on the front picture ({"images": ["el:<front id>"]} when it exists, else in the same asset.make chain as the front: steps [{"tool": "image.generate", ..., "save": "front"}, {"tool": "image.edit", "inputs": {"images": ["$prev"]}, "params": {"prompt": "Turn this into a character model sheet of exactly this person on one plain light grey background: the same full-body front view, a full-body three-quarter view, and four head-and-shoulders close-ups with different expressions (neutral, smiling, angry, surprised); the same face, hair, outfit and colors in every view; empty hands; no text", "width": 2048, "height": 1152}, "save": "sheet"}] with both pictures {"gen": n} and "from": "front" / "sheet"); 3) the fixed description in lock.description: 50 to 80 words of only what stays the same in every shot (apparent age, build, skin, face, hair, the outfit piece by piece with colors and materials, worn accessories), one plain paragraph, no story, mood, pose or camera words. Leave lock.at null: the person approves it with "Lock their look", unless they tell you to lock it (then set "at": true, only with a sheet and the description). Once locked, keep lock as it is unless they ask to change their look (then set at back to null).`,
};

function system(kind: string) {
  return `You are the AI in Hawkes Gen's ${kind} editor. The person works on one ${kind} scene and talks to you; you change it by answering with the whole scene, and you make what it needs with Gen's tools. Be decisive; do what they ask in as few jobs as it takes; generating costs them credits (1 credit = 1 cent), so don't remake what's there. Keep everything they didn't ask to change, and keep ids.

${DOCS[kind]}

Every tool on this Gen ("+N node settings": its ComfyUI graph has N more settings for params.nodes):
${toolMap(aiCanUse)}

${CRAFT_DOC}

Jobs: [{"gen": n (the index the elements name), "tool": "...", "params": {...}, "inputs": {"image": "el:<element id>" | "a_..." | ["a_...", ...]}, "label": "a short name"}]. Inputs take the element's file now (before this answer's changes).

Answer with JSON only: {"say": "one or two short sentences to the person", "doc": { the whole scene }, "jobs": [ ... ]}.`;
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['say', 'doc', 'jobs'],
  properties: { say: { type: 'string' }, doc: { type: 'object' }, jobs: { type: 'array', items: { type: 'object' } } },
};

export type SceneJob = { gen: number; tool: string; params: Record<string, any>; inputs: Record<string, any>; label?: string };
export type SceneAnswer = { say: string; doc: any; jobs: SceneJob[] };

export type SceneTurnInput = {
  scene: Scene; messages: { role: 'user' | 'assistant'; text: string }[]; selection?: unknown;
  library: { id: string; kind: string; title?: string | null; prompt?: string | null }[];
  scenes: { id: string; kind: string; title: string }[]; voices: { id: string; name: string; about: string }[];
};

export function parseScene(text: string, was: any): SceneAnswer {
  let t = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try {
    const j = JSON.parse(t);
    const jobs = (Array.isArray(j.jobs) ? j.jobs : []).slice(0, 12).filter((x: any) => x && typeof x.tool === 'string' && Number.isInteger(x.gen))
      .map((x: any) => ({ gen: x.gen, tool: x.tool, params: x.params && typeof x.params === 'object' ? x.params : {}, inputs: x.inputs && typeof x.inputs === 'object' ? x.inputs : {}, ...(x.label ? { label: String(x.label).slice(0, 80) } : {}) }));
    return { say: String(j.say ?? '').slice(0, 2000), doc: j.doc && typeof j.doc === 'object' ? j.doc : was, jobs };
  } catch {
    return { say: String(text ?? '').slice(0, 2000), doc: was, jobs: [] };
  }
}

export function scenePrompt(a: SceneTurnInput) {
  const convo = a.messages.slice(-16).map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${String(m.text).slice(0, 4000)}`).join('\n\n');
  const last = String(a.messages[a.messages.length - 1]?.text ?? '');
  const craft = toolCraft(relevantTools(last));
  return {
    system: system(a.scene.kind),
    prompt: `The ${a.scene.kind} scene now:\n${JSON.stringify(a.scene.doc)}\n\nThe person's selection (files they picked in Media come as selection.media, with id, kind and title: "this", "it" and "use this" can mean them; use them by id): ${JSON.stringify(a.selection ?? {})}\n\nTheir other scenes (a scene id can be placed where the scene says):\n${JSON.stringify(a.scenes.slice(0, 40))}\n\nRecent files in their library:\n${JSON.stringify(a.library.slice(0, 40))}\n\nVoices:\n${JSON.stringify(a.voices.slice(0, 30).map((v) => ({ id: v.id, name: v.name, about: v.about })))}\n\n${craft ? `How the tools this likely needs work:\n${craft}\n\n` : ''}The conversation (the last line is what to do now):\n${convo}`,
    schema: SCHEMA, maxTokens: 8000, effort: 'medium',
  };
}

export async function sceneTurn(a: SceneTurnInput) {
  if (!DOCS[a.scene.kind]) throw new GenError(`No AI for ${a.scene.kind} scenes here`, { status: 400 });
  const r = await callScope.run({ customer: true, org: orgOfProject(a.scene.project), house: isHouseProject(a.scene.project), who: a.scene.project }, () => ask(scenePrompt(a)));
  return { answer: parseScene(r.text, a.scene.doc), model: r.model, house: !['byok', 'subscription'].includes(r.billing), cost: r.cost ?? 0 };
}

/**
 * Applies an answer (or a proposal the person confirmed): the scene normalized, every job's "el:" inputs read from the
 * scene as it was, the jobs priced; over `autoCredits` without `confirm` nothing runs and the proposal comes back.
 * Otherwise the jobs are submitted and the elements they make wait on them.
 */
export function applyScene(s: Scene, ans: { doc: any; jobs: SceneJob[] }, deps: {
  submit: (spec: { tool: string; params: Record<string, any>; inputs: Record<string, any>; label?: string }) => { id: string };
  quote: (tool: string, params: Record<string, any>) => number;
  autoCredits: number; confirm?: boolean;
}): { doc: any; started: { gen: number; job: string; tool: string }[]; proposed?: { doc: any; jobs: (SceneJob & { credits: number })[]; credits: number }; errors: string[] } {
  const k = kindOf(s.kind);
  const doc = k.normalize(ans.doc);
  const before = new Map(fileElements(s.kind, s.doc).filter((e) => e.id).map((e) => [e.id, e]));
  const now = new Map(fileElements(s.kind, doc).filter((e) => e.id).map((e) => [e.id, e]));
  const errors: string[] = [];
  const read = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(read);
    const t = String(v ?? '');
    if (t.startsWith('el:')) {
      const e = before.get(t.slice(3)) ?? now.get(t.slice(3));
      if (!e?.asset) throw new GenError(`${t} has no file yet`, { status: 400 });
      return `asset:${e.asset}`;
    }
    if (/^(asset|blob):/.test(t)) return t;
    if (/^a_[0-9a-f]{6,40}$/.test(t)) return `asset:${t}`;
    return t;
  };
  const jobs: (SceneJob & { credits: number })[] = [];
  for (const j of ans.jobs) {
    if (!getTool(j.tool) || !aiCanUse(j.tool)) { errors.push(`no tool ${j.tool}`); continue; }
    try {
      const inputs = Object.fromEntries(Object.entries(j.inputs ?? {}).map(([n, v]) => [n, read(v)]));
      jobs.push({ ...j, inputs, credits: deps.quote(j.tool, j.params ?? {}) });
    } catch (e: any) { errors.push(`${j.label ?? j.tool}: ${e.message}`); }
  }
  const credits = jobs.reduce((n, j) => n + j.credits, 0);
  if (jobs.length && credits > deps.autoCredits && !deps.confirm) return { doc: s.doc, started: [], proposed: { doc: ans.doc, jobs, credits }, errors };
  const started: { gen: number; job: string; tool: string }[] = [];
  const byGen = new Map<number, string>();
  for (const j of jobs) {
    try {
      const r = deps.submit({ tool: j.tool, params: j.params ?? {}, inputs: j.inputs, label: j.label });
      byGen.set(j.gen, r.id);
      started.push({ gen: j.gen, job: r.id, tool: j.tool });
    } catch (e: any) { errors.push(`${j.label ?? j.tool}: ${e.message}`); }
  }
  for (const e of fileElements(s.kind, doc)) {
    if (e.gen == null) continue;
    const id = byGen.get(e.gen);
    if (id) { e.pending = id; delete e.failed; } else if (!e.asset) e.failed = 'Nothing was made for this';
    delete e.gen;
  }
  return { doc, started, errors };
}
