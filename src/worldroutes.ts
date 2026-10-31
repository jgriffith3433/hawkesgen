// The world routes (docs/worlds.md). The scenes themselves are /v1/scenes (any kind); these are what's above them:
//   POST /v1/worlds/start {idea, board?: [asset ids], project?}      a proposed world (the look, characters, places, a
//                                                                     story idea) as cards, nothing saved
//   POST /v1/worlds/keep {proposal, keep?: {characters, places, props: [i], story}, make?}   the kept parts as scenes in
//                                                                     the world; make: also price (or, with confirm, run) their packs
//   GET  /v1/worlds/:id                                               the world's home: its scene and members by kind
//   GET  /v1/worlds/:id/context                                       src/worlds.ts worldContext
//   POST /v1/worlds/:id/canon {text}                                  the rules the text breaks
//   POST /v1/worlds/:id/packs {confirm?}                              pictures for the world and every member missing them
//   POST /v1/stories/:id/shots/:shot/stage                            "Make this shot": a stage shot made from a story's
//                                                                     shot, linked back
//   POST /v1/scenes/:id/assistant|apply  for world, place, prop and story scenes (the others: src/api.ts)
// handleWorlds answers false for a route that isn't its own.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { canProject, fixedProject, type Client } from './auth.ts';
import { GenError } from './util.ts';
import { submit, type JobSpec } from './jobs.ts';
import { getAsset, listAssets } from './library.ts';
import { getUserForClient, getUserById } from './users.ts';
import { quoteJobCredits, chargeCredits } from './billing.ts';
import * as house from './houseai.ts';
import { getScene, saveScene, listScenes, usedBy, SCENE_ID, type Scene } from './scenes.ts';
import { isWorldKind } from './worldkinds.ts';
import { worldContext, worldMembers, canonCheck, worldOf } from './worlds.ts';
import * as wai from './worldai.ts';

type Ctx = { req: IncomingMessage; res: ServerResponse; route: string; method: string; client: Client; send: (res: ServerResponse, status: number, body: unknown) => void; readJson: (req: IncomingMessage) => Promise<any> };

const SID = SCENE_ID.source.slice(1, -1).replace('(', '(?:');
const SCENE_AI = new RegExp(`^/v1/scenes/(${SID})/(assistant|apply)$`);

export async function handleWorlds(c: Ctx): Promise<boolean> {
  const { req, res, route, method, client, send, readJson } = c;
  const ai = SCENE_AI.exec(route);
  if (!route.startsWith('/v1/worlds') && !route.startsWith('/v1/stories/') && !ai) return false;
  // Imported here so the kinds are registered before any scene is read.
  await import('./editor.ts');
  await import('./director.ts');
  const canSee = (p: string) => canProject(client, p);
  const user = getUserForClient(client);
  const projectOf = (asked?: unknown) => {
    const p = fixedProject(client) ?? (typeof asked === 'string' && asked ? asked : user?.project ?? '');
    if (!p || !canProject(client, p)) throw new GenError('Name a project you can use', { status: 403 });
    return p;
  };
  const quoteIn = (project: string) => (tool: string, params: Record<string, any>) => { try { return Number((quoteJobCredits({ project, tool, params } as any) as any)?.credits ?? 0); } catch { return 0; } };
  const submitIn = (project: string, scene: string) => (spec: { tool: string; params: Record<string, any>; inputs: Record<string, any>; label?: string; scene?: string }) =>
    submit(client, { project, tool: spec.tool, params: spec.params, inputs: spec.inputs, labels: { by: client.name, scene: spec.scene ?? scene, ...(spec.label ? { title: spec.label } : {}) } } as JobSpec);
  // A Gen account without its own Claude runs on the house AI and pays for each turn in credits (as src/api.ts does).
  const payerFor = async (project: string) => {
    const { isGenAccountProject, orgOfProject, orgSecretInfo } = await import('./orgsecrets.ts');
    const org = orgOfProject(project);
    const ownAi = Boolean(org && (orgSecretInfo(org, 'anthropic').set || orgSecretInfo(org, 'claude-subscription').set));
    const payer = user && isGenAccountProject(project) && !ownAi ? user : null;
    if (payer) house.checkCanPay(getUserById(payer.id)?.credits ?? 0);
    return payer;
  };
  const charge = (payer: any, turn: { house: boolean; cost: number }, what: string) => (payer && turn.house ? chargeCredits(payer.id, house.turnCredits(turn.cost), 'ai_turn', what.slice(0, 120)) : null);

  // ---------------------------------------------------------------- the world kinds' AI
  if (ai && method === 'POST') {
    let cur: Scene;
    try { cur = getScene(ai[1], canSee); } catch { return false; }
    if (!isWorldKind(cur.kind)) return false;
    const b = await readJson(req);
    const deps = { submit: submitIn(cur.project, cur.id), quote: quoteIn(cur.project) };
    if (ai[2] === 'apply') {
      const r = wai.applyWorldAnswer(cur, { doc: b.doc ?? cur.doc, jobs: Array.isArray(b.jobs) ? b.jobs : [], create: Array.isArray(b.create) ? b.create : [] }, { ...deps, autoCredits: 0, confirm: true });
      send(res, 200, { scene: full(saveScene(cur, r.doc), canSee), started: r.started, created: r.created.map(brief), errors: r.errors });
      return true;
    }
    if (b.doc) cur = saveScene(cur, b.doc);
    const messages = (Array.isArray(b.messages) ? b.messages : []).filter((m: any) => m && typeof m.text === 'string').map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, text: m.text }));
    if (!messages.length) throw new GenError('Say something to the AI', { status: 400 });
    const payer = await payerFor(cur.project);
    const ed = await import('./editor.ts');
    const library = listAssets({ project: cur.project, limit: 30, playtest: false, projects: client.projects } as any).items
      .filter((a: any) => ['image', 'video', 'audio', 'mesh'].includes(a.kind))
      .map((a: any) => ({ id: a.id, kind: a.kind, title: a.title ?? null, prompt: a.recipe?.params?.prompt ?? null }));
    const scenes = listScenes(cur.project, null, 60).filter((x) => x.id !== cur.id).map((x) => ({ id: x.id, kind: x.kind, title: x.title }));
    const turn = await wai.worldTurn({ scene: cur, messages, selection: b.selection, library, scenes, voices: cur.kind === 'story' ? await ed.editorVoices() : [] });
    const aiCharge = charge(payer, turn, `AI (${cur.kind}): ${messages[messages.length - 1].text}`);
    const r = wai.applyWorldAnswer(cur, turn.answer, { ...deps, autoCredits: Math.max(0, Number(b.autoCredits ?? 40)) });
    const saved = r.proposed ? cur : saveScene(cur, r.doc);
    send(res, 200, { say: turn.answer.say, scene: full(saved, canSee), started: r.started, created: r.created.map(brief), errors: r.errors, ...(r.proposed ? { proposed: r.proposed } : {}), model: turn.model, ...(aiCharge ? { aiCredits: aiCharge.charged } : {}) });
    return true;
  }

  // ---------------------------------------------------------------- start a world
  if (route === '/v1/worlds/start' && method === 'POST') {
    const b = await readJson(req);
    const project = projectOf(b.project);
    const board = (Array.isArray(b.board) ? b.board : []).slice(0, 4).map((id: unknown) => getAsset(String(id ?? '').replace(/^asset:/, '')))
      .filter((a: any) => a && canSee(a.project) && a.kind === 'image').map((a: any) => ({ id: a.id, path: a.path }));
    const payer = await payerFor(project);
    const r = await wai.startWorld(project, String(b.idea ?? ''), board);
    const aiCharge = charge(payer, r, `Start a world: ${String(b.idea ?? '')}`);
    send(res, 200, { proposal: r.proposal, model: r.model, ...(aiCharge ? { aiCredits: aiCharge.charged } : {}) });
    return true;
  }
  if (route === '/v1/worlds/keep' && method === 'POST') {
    const b = await readJson(req);
    const project = projectOf(b.project);
    if (!b.proposal || typeof b.proposal !== 'object' || !b.proposal.world) throw new GenError('proposal: the world to keep', { status: 400 });
    const kept = wai.keepWorld(project, b.proposal, b.keep && typeof b.keep === 'object' ? b.keep : {});
    const packs = b.make ? wai.makeWorldPacks(project, kept.world.id, canSee, { submit: submitIn(project, kept.world.id), quote: quoteIn(project), confirm: Boolean(b.confirm), autoCredits: Math.max(0, Number(b.autoCredits ?? 0)) }) : null;
    send(res, 200, { ...home(kept.world.id, project, canSee), ...(packs ? { packs } : {}) });
    return true;
  }

  // ---------------------------------------------------------------- one world
  const wm = new RegExp(`^/v1/worlds/(${SID})(?:/(context|canon|packs))?$`).exec(route);
  if (wm) {
    const w = getScene(wm[1], canSee, 'world');
    if (!wm[2] && method === 'GET') { send(res, 200, home(w.id, w.project, canSee)); return true; }
    if (wm[2] === 'context' && method === 'GET') { send(res, 200, worldContext(w.project, w.id)); return true; }
    if (wm[2] === 'canon' && method === 'POST') {
      const b = await readJson(req);
      const payer = await payerFor(w.project);
      const r = await canonCheck(w.doc, String(b.text ?? ''), { project: w.project });
      const aiCharge = r.cost ? charge(payer, { house: true, cost: r.cost }, `Canon check: ${w.title}`) : null;
      send(res, 200, { ok: r.ok, breaks: r.breaks, ...(aiCharge ? { aiCredits: aiCharge.charged } : {}) });
      return true;
    }
    if (wm[2] === 'packs' && method === 'POST') {
      const b = await readJson(req);
      send(res, 200, wai.makeWorldPacks(w.project, w.id, canSee, { submit: submitIn(w.project, w.id), quote: quoteIn(w.project), confirm: Boolean(b.confirm), autoCredits: Math.max(0, Number(b.autoCredits ?? 0)) }));
      return true;
    }
  }

  // ---------------------------------------------------------------- a story's shot to a stage
  const sm = new RegExp(`^/v1/stories/(${SID})/shots/(st_[\\w-]{3,24})/stage$`).exec(route);
  if (sm && method === 'POST') {
    const story = getScene(sm[1], canSee, 'story');
    const dr = await import('./director.ts');
    const r = shotToStage(story, sm[2], canSee, dr.createShot);
    send(res, 200, { stage: { id: r.stage.id, kind: 'stage', title: r.stage.title }, story: full(r.story, canSee) });
    return true;
  }
  throw new GenError(`No world route ${method} ${route}`, { status: 404 });
}

const brief = (s: Scene) => ({ id: s.id, kind: s.kind, title: s.title });
const full = (s: Scene, canSee: (p: string) => boolean) => ({ ...s, uses: usedBy(s, canSee) });

/** A world's home: its scene, and its members by kind with each one's picture. */
export function home(worldId: string, project: string, canSee: (p: string) => boolean) {
  const w = getScene(worldId, canSee, 'world');
  const out: Record<string, any[]> = { character: [], place: [], prop: [], story: [], other: [] };
  for (const r of worldMembers(project, w.id, w.doc.members)) {
    let doc: any = {};
    try { doc = getScene(r.id, canSee).doc; } catch { continue; }
    (out[r.kind] ?? out.other).push({ id: r.id, kind: r.kind, title: r.title, render: doc.render ?? null, picture: pictureOf(r.kind, doc), about: aboutOf(r.kind, doc), waiting: JSON.stringify(doc).includes('"pending"') });
  }
  return { world: full(w, canSee), characters: out.character, places: out.place, props: out.prop, stories: out.story, others: out.other };
}

/** The picture a member's card shows. */
export function pictureOf(kind: string, d: any): string | null {
  const a = (e: any) => (typeof e?.asset === 'string' ? e.asset : null);
  if (kind === 'character') { const ps = d.pictures ?? []; return a(ps.find((p: any) => p.role === 'portrait' && p.asset)) ?? a(ps.find((p: any) => p.role === 'front' && p.asset)) ?? a(ps.find((p: any) => p.asset)) ?? a(d.render); }
  if (kind === 'place') return a((d.views ?? []).find((v: any) => v.asset)) ?? a(d.panorama) ?? a(d.render);
  if (kind === 'prop') return a(d.sheet) ?? a((d.views ?? []).find((v: any) => v.asset)) ?? a(d.render);
  return d.render?.kind === 'image' ? a(d.render) : null;
}
const aboutOf = (kind: string, d: any) => String((kind === 'story' ? d.logline : kind === 'character' ? d.notes || d.description : d.description) ?? '').slice(0, 200);

/**
 * "Make this shot": a stage shot from a story's shot (its place's panorama as the sky, its cast spaced on the ground,
 * the script scene's lines by those characters, what happens as the action), in the story's world, linked back as
 * the shot's `stage`. A shot that already has a stage gets that one back.
 */
export function shotToStage(story: Scene, shotId: string, canSee: (p: string) => boolean, createShot: (project: string, doc?: unknown) => Scene) {
  const i = story.doc.shots.findIndex((s: any) => s.id === shotId);
  if (i < 0) throw new GenError('No such shot in this story', { status: 404 });
  const shot = story.doc.shots[i];
  if (shot.stage) { try { const st = getScene(shot.stage, canSee); return { stage: st, story }; } catch { /* gone: make a new one */ } }
  const world = worldOf(story.doc);
  const place = shot.place ? (() => { try { return getScene(shot.place, canSee); } catch { return null; } })() : null;
  const cast = shot.cast.map((id: string) => { try { return getScene(id, canSee, 'character'); } catch { return null; } }).filter(Boolean) as Scene[];
  const sc = story.doc.script.find((s: any) => s.id === shot.scene);
  const state = shot.state ?? { time: null, people: {} };
  const wearing = cast.map((c) => { const p = state.people?.[c.id]; return p ? [p.wears && `${c.title} wears ${p.wears}`, p.injuries?.length && `${c.title}: ${p.injuries.join(', ')}`].filter(Boolean).join('; ') : ''; }).filter(Boolean).join('. ');
  const lines = (sc?.lines ?? []).map((l: any) => ({ who: cast.findIndex((c) => c.id === l.who), text: l.text })).filter((l: any) => l.who >= 0).slice(0, 8);
  let at = 0.5;
  const doc = {
    title: `${story.title}: ${shot.title || `shot ${i + 1}`}`.slice(0, 120),
    ...(world ? { world } : {}),
    look: [place ? `${place.title}: ${place.doc.description}` : '', state.time ? `Time of day: ${state.time}.` : '', wearing].filter(Boolean).join(' ').slice(0, 2000),
    action: shot.what,
    cast: cast.map((c, n) => ({ character: c.id, name: c.title, position: [(n - (cast.length - 1) / 2) * 1.4, 0], facing: 0 })),
    lines: lines.map((l: any) => { const x = { ...l, at }; at += Math.max(1.5, l.text.split(/\s+/).length / 2.6); return x; }),
    seconds: Math.min(20, Math.max(5, Math.ceil(at))),
    ...(place?.doc.panorama?.asset ? { set: { sky: place.doc.panorama.asset } } : {}),
    camera: { target: 0, distance: shot.framing && /close/i.test(shot.framing) ? 1.6 : 4, height: 1.5, lens: shot.framing && /close/i.test(shot.framing) ? 85 : 35 },
  };
  const stage = createShot(story.project, doc);
  const shots = story.doc.shots.map((s: any) => (s.id === shotId ? { ...s, stage: stage.id } : s));
  return { stage, story: saveScene(story, { ...story.doc, shots }) };
}
