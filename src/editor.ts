// The Gen app's editor (dashboard/gen/): projects (a timeline document per account), the edits on them, and the AI
// editor. One implementation of every edit (`applyOps`) serves the app's AI pane, the API and the MCP tools
// (editor_*), so whatever edits a project (the person, the AI, Claude over MCP) edits the same document.
//
// The document is the timeline (src/timeline.ts): tracks top first, any clip on any track, a higher track drawn over
// the ones below; video, image and audio scenes all have one. A clip waiting on a job has `job` and `pending` until the
// job ends (resolvePending fills the asset in). Nothing is added that the person didn't ask for: no fades or
// transitions unless set on a clip.

import crypto from 'node:crypto';
import { registerKind, listScenes, createScene, getScene, saveScene, deleteScene, sceneRef, type Scene, type Render } from './scenes.ts';
import { GenError } from './util.ts';
import { getJob } from './jobs.ts';
import { getTool, TOOLS } from './tools/index.ts';
import { toolMap, toolCraft, notes } from './knowledge.ts';
import { isInternalOnlyTool } from './billing.ts';

const TOOL_IDS = () => TOOLS.map((t) => t.id);
import { ask, callScope } from './providers/anthropic.ts';
import { orgOfProject, isHouseProject } from './orgsecrets.ts';
import { toolReady } from './providers/gpu/route.ts';
import type { Settings } from './config.ts';


// The timeline document and its edits live in src/timeline.ts (one model under video, image and audio scenes).
import { normalize, layout, newDoc, applyOps, resolvePending, keptRender, clipLength, docLength, expectedSeconds, TRACKS, type Doc, type Clip, type Op, type Submit, type Kind } from './timeline.ts';
const r3 = (n: number) => Math.round(n * 1000) / 1000;
export { normalize, layout, newDoc, applyOps, resolvePending, keptRender, clipLength, docLength, expectedSeconds, TRACKS, type Doc, type Clip, type Op, type Submit };

// ------------------------------------------------------------------ projects: the timeline scenes (src/scenes.ts)
export type Project = Scene<Doc>;
/** The kinds of scene that are a timeline: one editor, one AI, one set of edits. */
export const TIMELINE_KINDS: Kind[] = ['video', 'image', 'audio'];
const BLANK_TITLE: Record<Kind, string> = { video: 'Untitled', image: 'Untitled image', audio: 'Untitled audio' };
export const timelineKind = (kind: string): Kind => (TIMELINE_KINDS.includes(kind as Kind) ? kind as Kind : 'video');

for (const kind of TIMELINE_KINDS) {
  registerKind(kind, {
    normalize: (d) => normalize(d, kind),
    blank: (title) => newDoc(title === 'Untitled' ? BLANK_TITLE[kind] : title, kind),
    resolve: (doc, jobOf) => resolvePending(doc, jobOf),
    uses: (doc: Doc) => doc.clips.map((c) => c.scene).filter(Boolean) as string[],
  });
}

export const listProjects = (project: string, limit = 50) => listScenes(project, 'video', limit);
export const createProject = (project: string, doc?: unknown): Project => createScene(project, 'video', doc ?? newDoc(), 'ep');
/** One project, with any finished jobs filled in (saved, so every reader sees the same). `canSee` checks the caller. */
export function getProject(id: string, canSee: (project: string) => boolean): Project {
  const s = getScene(id, canSee);
  if (!TIMELINE_KINDS.includes(s.kind as Kind)) throw new GenError('No such scene', { status: 404 });
  return s as Project;
}
/** Saves a document. With `version`, refuses when someone else saved in between (409 with the newer project). */
export function saveDoc(p: Project, doc: unknown, version?: number): Project {
  try {
    return saveScene(p, doc, version);
  } catch (e: any) {
    if (e.status === 409) e.project = e.scene;
    throw e;
  }
}
export const deleteProject = (id: string, canSee: (project: string) => boolean) => { getProject(id, canSee); deleteScene(id, canSee); };

// ------------------------------------------------------------------ the AI editor
/** What the AI editor may run, with what it's for. Only tools this Gen has are offered. */
export const EDITOR_TOOLS: { tool: string; use: string }[] = [
  { tool: 'image.generate', use: 'a new image from words. params prompt, width, height' },
  { tool: 'image.edit', use: 'change a whole image with words. inputs images: [clip or asset]; params prompt' },
  { tool: 'image.repaint', use: 'change only a painted area of an image. inputs image, mask (the person\'s painted mask, given as selection.mask); params prompt' },
  { tool: 'image.expand', use: 'widen or reframe an image, filling the new area. inputs image; params aspect ("16:9", "9:16", "1:1") or left/right/top/bottom px, prompt' },
  { tool: 'image.cutout', use: 'remove the background. inputs image' },
  { tool: 'image.upscale', use: 'a sharper, bigger image. inputs image' },
  { tool: 'image.relight', use: 'new lighting or time of day. inputs image; params prompt' },
  { tool: 'video.i2v', use: 'animate an image into a clip. inputs start (image), optional end (image); params prompt (describe the motion fully: who moves, how, where to; big clear motion), width, height (multiples of 16, about 832x480 wide, 480x832 tall, 640x640 square), frames (4n+1, 16 fps: 49 = 3 s, 81 = 5 s), fps 16' },
  { tool: 'video.t2v', use: 'a clip from words. params prompt, seconds' },
  { tool: 'video.change', use: 'change something in a video clip, following its motion. inputs video, optional mask (first frame); params prompt' },
  { tool: 'video.control', use: 'restyle a whole clip in a new look from a restyled first frame. inputs control (video), image (the styled frame); params prompt' },
  { tool: 'video.replace', use: 'swap the person in a clip for the character in an image. inputs image, video; params prompt' },
  { tool: 'video.motion', use: 'a still character performs the motion of a clip. inputs image, video; params prompt' },
  { tool: 'video.extend', use: 'continue a shot from a frame (use video.frame at "last" first). inputs image; params prompt, seconds' },
  { tool: 'video.frame', use: 'grab a frame of a clip as an image. inputs video; params at (seconds, "first" or "last")' },
  { tool: 'video.still', use: 'an image as a clip. inputs image; params seconds, zoom' },
  { tool: 'video.upscale', use: 'a sharper, 4x bigger clip. inputs video' },
  { tool: 'video.interpolate', use: 'smoother motion (more frames). inputs video; params multiplier' },
  { tool: 'video.lipsync', use: 'a character from an image says an audio line. inputs image, audio; params prompt' },
  { tool: 'audio.music', use: 'music. params prompt, seconds' },
  { tool: 'audio.voice', use: 'a spoken line on Gen\'s own voice model. params text, voice (an id from "voices" in the project data: pick by name and about), direction (how to say it: "tired, almost whispering")' },
  { tool: 'audio.sfx', use: 'a sound effect, ambience or one-shot on Gen\'s own model. params text (the source, the material, the space), duration (seconds, 5 if unsure), loop (true for a seamless bed)' },
  // audio.revoice changes a voice with audio.voice-change, which only ElevenLabs does: left out.
  // The studio's tools: game art, 3D and sound. Their results go to the library (place {"library":true}), never the timeline.
  { tool: 'image.panorama', use: 'a 360° equirectangular skybox. params prompt. Library only' },
  { tool: 'texture.maps', use: 'PBR material maps (normal, roughness, height...) from a seamless texture. inputs image. Library only' },
  { tool: 'image.angles', use: 'a character turnaround from 8 angles. inputs image. Library only' },
  { tool: 'image.viewsheet', use: 'a 4-view sheet (front, back, left, right) of a character for 3D. inputs image (front view, clean background); params form (what it is). Library only' },
  { tool: 'mesh.views3d', use: 'a textured 3D model (GLB) from a 4-view sheet. inputs image (the sheet from image.viewsheet). Library only' },
  { tool: 'mesh.textured', use: 'a textured 3D model (GLB) from one image of a prop; params allowSingleView true. inputs image. Library only' },
  { tool: 'mesh.rig', use: 'a skeleton for a 3D model so it can move (humanoids get Mixamo bones). inputs mesh (GLB); params kind "auto", height (meters). Library only' },
  { tool: 'motion.from-text', use: 'a humanoid animation from one sentence on a rigged model (GLB, FBX, BVH and a preview video). inputs character (rigged GLB); params prompt (name the limbs and how it ends), seconds, loop, inPlace, takes 2. Library only' },
  { tool: 'motion.from-video', use: 'motion capture: a person\'s move in a clip onto a rigged model. inputs video (one person, whole body in frame, still camera), character (rigged GLB); params camera "still"|"auto". Library only' },
  { tool: 'video.talk', use:'a portrait talks along to an audio line. inputs image, audio; params prompt' },
  { tool: 'video.animate', use: 'a character image moves like a driving video. inputs reference (image), motion (video); params prompt' },
];

/** Tools the AI may plan with: what Create lists, plus asset.make (chains). */
export const aiCanUse = (id: string) => !NOT_IN_CATALOG.test(id) && !isInternalOnlyTool(id) && !/-open$/.test(id);

/** How to chain tools and reach every node setting, for the AI editor and the director. */
export const CRAFT_DOC = `Chains: one generate op with tool "asset.make" runs several tools in order in one job: params {"steps": [{"tool": "...", "params": {...}, "inputs": {"image": "$prev"}}, ...], "candidates": n (best-of-n at "pickAt": step number, judged by "pick": what makes a good one)}. In steps, "$prev" is the previous step's first output, "$prev:<title>" or "$stepN:<title>" a named one (image.remove-background returns [mask, cutout]: always "$prev:cutout"; blender.render: "depth", "pose", "first frame"...), "$stepN.result.<path>" a step's returned value, "$input:N" the job's files[N]. Use a chain whenever a step needs another's output.
Node settings: a ComfyUI workflow tool takes params.nodes {"<node>.<input>": value} for any of its node settings (sampler, scheduler, steps on a sampler that has no param, a LoRA's strength_model, a guide's frame, a decode's tile size...). Prefer the tool's own params; reach for node settings when the notes say they fix what's wrong. Files, models and prompts can't be set there.`;

/** The tools a request most likely needs: those it names, else the best matches of its words against what each tool is for. */
export function relevantTools(text: string, max = 4): string[] {
  const t = text.toLowerCase();
  const named = TOOL_IDS().filter((id) => t.includes(id));
  const words = new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const all = notes();
  const scored = TOOL_IDS().filter(aiCanUse).map((id) => {
    const hay = `${id} ${all[id]?.role ?? ''} ${getTool(id)?.title ?? ''}`.toLowerCase();
    let n = 0;
    for (const w of words) if (hay.includes(w)) n++;
    return { id, n };
  }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, max).map((x) => x.id);
  return [...new Set([...named, ...scored])].slice(0, max + 2);
}

/** Tools the app never lists in Create: the studio's machinery, plumbing the editor runs itself, and admin work. */
const NOT_IN_CATALOG = /^(comfy\.graph|unity\.|playtest\.|asset\.lod|media\.|file\.import|library\.|lora\.train|audio\.voice-(list|delete|save)|film\.|video\.compose|video\.still|image\.frame|video\.fit|llm\.|audio\.sfx-sa3$)/;

/**
 * Every tool the app's Create pane offers: Gen's own description of it (params, inputs, outputs), and whether it can
 * run now. Tools that work over SSH need the GPU fleet (AWS, suspended since 2026-10-28); the 3D tools (rigging,
 * animation, Blender) need the fleet or a GPU endpoint with the 3D worker image; either says so with ready: false.
 */
export async function catalog(describe: (t: any) => any, all: any[], fleetDown: boolean, settings: Pick<Settings, 'gpu'> | null = null) {
  return all.filter((t) => !NOT_IN_CATALOG.test(t.id)).map((t) => ({ ...describe(t), ready: toolReady(t, { fleetDown, settings }) }));
}

// ------------------------------------------------------------------ voices
export type EditorVoice = { id: string; name: string; about: string; preview: string };
/**
 * The voices the app and the AI editor offer: Gen's house voices (src/audio/house.ts), spoken by Gen's own voice model
 * (never ElevenLabs, never the account's or the studio's characters). A preview is the house voice's saved reference.
 */
export async function editorVoices(): Promise<EditorVoice[]> {
  const { HOUSE_VOICES, houseReference } = await import('./audio/house.ts');
  return HOUSE_VOICES.map((v) => {
    const ref = houseReference(v.id);
    return { id: v.id, name: v.name, about: v.about, preview: ref ? `/v1/audio/house/${v.id}/preview` : '' };
  });
}
export const availableEditorTools = () => EDITOR_TOOLS.filter((t) => getTool(t.tool));

export type AssistantMessage = { role: 'user' | 'assistant'; text: string };
export type Selection = { clips?: string[]; range?: { start: number; end: number } | null; playhead?: number; mask?: string | null; frame?: string | null; media?: { id: string; kind: string; title?: string | null }[] };

const OPS_DOC = `Edits (each an object in "ops"). Tracks are named by id (see "tracks"); any clip can go on any track:
- {"op":"add","track":"<id>","asset":"a_...","kind":"video"|"image"|"audio","in":s,"out":s,"start":s,"index":n,"after":"c_...","x":0-1,"y":0-1,"w":share,"opacity":0-1} put a library file on the timeline (a magnetic track takes index/after; others take start). x, y: the center as shares of the frame; w: width as a share of the frame's width (leave out to fit the frame)
- {"op":"add","kind":"fill","color":"#rrggbb","track":"<id>","start":s,"seconds":s} a color over the frame
- {"op":"generate","tool":"...","params":{...},"inputs":{"name":"clip:c_..."|"a_..."|"blob:..."},"place":{"track":"<id>","start":s}|{"track":"<id>","after":"c_..."}|{"replace":"c_..."}|{"library":true},"label":"short name"} run a tool; its result lands where "place" says (a waiting clip shows until it's done)
- {"op":"trim","id":"c_...","in":s,"out":s} or {"op":"trim","id":"c_...","length":s}  (in/out are seconds of the clip's source; for pictures, text and fills use length)
- {"op":"split","id":"c_...","at":s}  (timeline seconds)
- {"op":"move","id":"c_...","track":"<id>","index":n|"after":"c_..."|"start":s}
- {"op":"delete","id":"c_..."}   {"op":"deleteRange","start":s,"end":s,"tracks":["<id>",...]}
- {"op":"set","id":"c_...","volume":0-4,"speed":0.25-4,"muted":bool,"fadeIn":s,"fadeOut":s,"transition":"cut"|"crossfade"|"fadeblack"|"dissolve"|"wipeleft","transitionSeconds":s,"zoom":{"from":1,"to":1.3,"x":0.5,"y":0.4},"text":"...","x":..,"y":..,"w":..,"rotation":deg,"opacity":0-1,"blend":"normal"|"multiply"|"screen"|"overlay"|"lighten"|"darken"|"soft-light"|"difference","color":"#rrggbb","size":share of frame height,"weight":100-900,"font":"..."}
- {"op":"text","text":"...","start":s,"end":s,"track":"<id>","x":..,"y":..,"size":..,"color":"..","align":"left"|"center"|"right"}  words on screen. Their x is their center, or their left edge when align is "left" (right edge when "right"); keep them inside the frame (a size of about 0.06 to 0.14 of its height for titles)
- {"op":"track","add":{"name":"...","role":"any"|"video"|"audio"|"text","at":index}} | {"op":"track","id":"<id>","set":{"name":..,"hidden":bool,"locked":bool,"mute":bool,"solo":bool,"volume":0-2,"pan":-1..1}} | {"op":"track","remove":"<id>"}
- {"op":"settings","width":w,"height":h,"fps":n,"title":"...","fit":"crop"|"pad","background":"#rrggbb","length":s,"bpm":n}  (fit: clips of another shape fill the frame, cropped, or fit inside it with bars)`;

const KIND_DOC: Record<Kind, string> = {
  video: 'This is a video scene: what plays is the timeline; export makes a video.',
  image: 'This is an image scene: a picture made of layers. Each track is a layer (the top track draws over the rest); clips usually span the whole length. Export takes the frame at the playhead as the picture, so "the picture" means the frame at the playhead. Place and size things with x, y, w, rotation, opacity and blend. Everything starts at 0 and lasts the whole length of the scene (its "length") unless the person asks for movement over time.',
  audio: 'This is an audio scene: a multitrack of sound. Export is the mixdown. Track volume, pan, mute and solo are the mix; clips have volume and fades.',
};

function systemPrompt(kind: Kind = 'video') {
  return `You are the AI inside Hawkes Gen, a creative studio on a generative AI platform: a video editor, plus tools for images and textures, 3D models, voices, sound and music, and a library of everything the person makes. The person edits a timeline and talks to you; you change their project by returning edits, and you make things for their library (game art, skyboxes, materials, 3D models) with generate ops placed {"library":true}. A 3D model (kind "mesh") never goes on the timeline. Be decisive and do what they ask in as few edits as it takes. When something is ambiguous, make the sensible choice and say what you did; ask a question only when you truly can't proceed.

The timeline: tracks top first (in "tracks"), and a higher track draws over the ones below, like layers. Any clip (video, image, audio, text, a color fill) can go on any track. Clips start at any time; clips on one track never overlap (put one over another on a higher track). A track marked magnetic plays its clips back to back in order. Without a start, an added clip goes after the last one on its track. The main track (role "main") is the cut; where two of its clips meet, a transition can join them. Times are seconds. The person's selection tells you what "this", "these", "here" mean: selected clips, a selected time range, the playhead, and possibly a painted mask (selection.mask, a blob to pass as the mask input) on a frame. Files the person picked in Media come as selection.media (id, kind, title): "this", "it", "these" and "use this" can mean them; use them by id as inputs or add them.

Generating costs the person credits (1 credit = 1 cent); prefer one good take over many, and don't regenerate what exists. Never add fades, transitions or music they didn't ask for. To change what's IN a clip use tools (a generate op with place.replace keeps its spot); to change timing use trim/split/move/delete. To work on one frame of a video (edit it, continue from it) grab it first with video.frame, in the same answer: a later op can't use an earlier op's output, so when a step needs another's result, do the first step now and say you'll continue once it's ready.

The usual tools, and how the editor uses them:
${availableEditorTools().map((t) => `- ${t.tool}: ${t.use}`).join('\n')}

Every tool on this Gen (in: its inputs, ? optional; params: * required; "+N node settings" means its ComfyUI graph has N more settings you can set with params.nodes):
${toolMap(aiCanUse)}

${CRAFT_DOC}

${OPS_DOC}

${KIND_DOC[kind]}

Answer with JSON only: {"say": "one or two short sentences to the person", "ops": [ ... ]}.`;
}

const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['say', 'ops'],
  properties: { say: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } },
};

/** What the AI sees of the project: the clips (no internals), lengths, the selection, and recent library files. */
export function contextFor(doc: Doc, selection: Selection, library: { id: string; kind: string; title?: string | null; prompt?: string | null; duration?: number | null }[], voices: EditorVoice[] = [], kind: Kind = 'video') {
  const tracks = doc.tracks.map((t) => ({ id: t.id, name: t.name, role: t.role, ...(t.magnetic ? { magnetic: true } : {}), ...(t.hidden ? { hidden: true } : {}), ...(t.locked ? { locked: true } : {}), ...(t.mute ? { mute: true } : {}), ...(t.solo ? { solo: true } : {}), ...(t.volume != null ? { volume: t.volume } : {}), ...(t.pan ? { pan: t.pan } : {}) }));
  const clips = doc.clips.map((c) => ({
    id: c.id, track: c.track, kind: c.kind, start: r3(c.start), length: r3(clipLength(c)), in: c.in, out: c.out,
    ...(c.duration ? { sourceLength: c.duration } : {}), ...(c.asset ? { asset: c.asset } : {}), ...(c.pending ? { pending: true } : {}),
    ...(c.failed ? { failed: c.failed } : {}), ...(c.label ? { label: c.label } : {}), ...(c.text ? { text: c.text } : {}),
    ...(c.speed ? { speed: c.speed } : {}), ...(c.volume != null ? { volume: c.volume } : {}), ...(c.muted ? { muted: true } : {}),
    ...(c.transition ? { transition: c.transition } : {}), ...(c.scene ? { scene: c.scene } : {}),
    ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}), ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}), ...(c.color ? { color: c.color } : {}),
    ...(c.x != null ? { x: c.x } : {}), ...(c.y != null ? { y: c.y } : {}), ...(c.w != null ? { w: c.w } : {}),
    ...(c.rotation ? { rotation: c.rotation } : {}), ...(c.opacity != null ? { opacity: c.opacity } : {}), ...(c.blend ? { blend: c.blend } : {}),
  }));
  return { project: { kind, title: doc.title, width: doc.width, height: doc.height, fps: doc.fps, fit: doc.fit ?? 'pad', length: r3(docLength(doc)), ...(doc.background ? { background: doc.background } : {}), ...(doc.bpm ? { bpm: doc.bpm } : {}) }, tracks, clips, selection, library: library.slice(0, 40), ...(voices.length ? { voices: voices.map((v) => ({ id: v.id, name: v.name, about: v.about })) } : {}) };
}

/** Pulls the answer's JSON out (models sometimes wrap it in a fence or a sentence). */
export function parseAnswer(text: string): { say: string; ops: Op[] } {
  let t = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try {
    const j = JSON.parse(t);
    return { say: String(j.say ?? '').slice(0, 2000), ops: Array.isArray(j.ops) ? j.ops.filter((o: any) => o && typeof o.op === 'string') : [] };
  } catch {
    return { say: String(text ?? '').slice(0, 2000), ops: [] };
  }
}

type TurnInput = { project: string; doc: Doc; selection: Selection; messages: AssistantMessage[]; library: Parameters<typeof contextFor>[2]; voices?: EditorVoice[]; kind?: Kind };

/** The AI editor's request: its instructions, and the project, selection and conversation. */
export function assistantPrompt(a: TurnInput) {
  const convo = a.messages.slice(-16).map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${String(m.text).slice(0, 4000)}`).join('\n\n');
  const last = String(a.messages[a.messages.length - 1]?.text ?? '');
  const craft = toolCraft(relevantTools(last));
  const prompt = `The project now:\n${JSON.stringify(contextFor(a.doc, a.selection, a.library, a.voices ?? [], a.kind ?? 'video'))}\n\n${craft ? `How the tools this likely needs work (their settings, node settings and what to change when a result is wrong):\n${craft}\n\n` : ''}The conversation (the last line is what to do now):\n${convo}`;
  return { system: systemPrompt(a.kind ?? 'video'), prompt, schema: ANSWER_SCHEMA, maxTokens: 4000, effort: 'medium' };
}

/**
 * One AI editor turn: the conversation, the project and selection in; the answer's words and edits out. Runs on the
 * account's own Claude when it has one (callScope with its org: its API key or subscription), else, for a Gen app
 * account, on the house AI (src/houseai.ts): `house` says so, and `cost` is what the call cost, to charge in credits.
 */
export async function assistantTurn(a: TurnInput): Promise<{ say: string; ops: Op[]; model: string; house: boolean; cost: number }> {
  const org = orgOfProject(a.project);
  const r = await callScope.run({ customer: true, org, house: isHouseProject(a.project), who: a.project }, () => ask(assistantPrompt(a)));
  return { ...parseAnswer(r.text), model: r.model, house: !['byok', 'subscription'].includes(r.billing), cost: r.cost ?? 0 };
}
