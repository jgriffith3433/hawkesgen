// The director (J, 2026-10-29: "allow the users to design scenes for creating 'the perfect shot' ... They will make use
// of the AI to design 3d scenes. Then we render this out using gen"). A shot is a small 3D scene: a cast (each a 3D model
// from the library, or a stand-in of the right height until there is one), props, a set (ground, sky, light) and a camera
// move, plus the look (what the finished frame is) and the action (what happens and what it sounds like). The app plays
// it on a 3D stage (dashboard/gen/director.js); the AI director writes and changes it (directorTurn).
//
// Two ways to film it:
//  - Now (the app): the stage records the shot's depth video and first frame in the browser; image.control paints the
//    first frame in the look; video.control (LTX-2.3 IC-LoRA) films the depth video from that frame. GPU providers only:
//    no Blender, so it works while the SSH fleet is down, with stand-ins too.
//  - Blender (blenderRecipe): the same shot in Gen's film pipeline (docs/film-pipeline.md, film/recipes.ts cinemaPass):
//    the director gate, blender.render's depth/pose/edges, the best-of-3 keyframe, video.control. It needs every cast
//    member to have a model, and the SSH GPU fleet.
//
// Coordinates are blender.render's: x right, y away from the default camera, meters on the ground; facing in degrees,
// 0 faces the default camera. So a shot exports to blender.render as it is (docs/blender.md, "The shot").

import crypto from 'node:crypto';
import { db } from './db.ts';
import { GenError } from './util.ts';
import { ask, callScope } from './providers/anthropic.ts';
import { orgOfProject, isGenAccountProject } from './orgsecrets.ts';
import { cinemaPass } from './film/recipes.ts';
import { toolCraft } from './knowledge.ts';

db.exec(`CREATE TABLE IF NOT EXISTS director_shots (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, doc TEXT NOT NULL, version INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS director_shots_project ON director_shots (project, updated DESC);`);

export const MOVES = ['static', 'push-in', 'pull-out', 'orbit', 'turntable', 'pan', 'truck', 'crane-up', 'crane-down', 'follow'] as const;
export const LIGHTS = ['studio', 'sun', 'night'] as const;
export const ASPECTS = { '16:9': [1280, 704], '9:16': [704, 1280], '1:1': [960, 960] } as const;

type XY = [number, number];
export type Beat = { to?: XY; seconds?: number; animation?: string; lookAt?: number | XY; facing?: number };
export type Member = { id: string; name: string; description: string; asset?: string | null; animation?: string | null; height: number; position: XY; facing: number; color: string; beats: Beat[] };
export type Prop = { id: string; name: string; description: string; asset?: string | null; shape: 'box' | 'cylinder' | 'sphere'; position: XY; facing: number; size: number; color: string };
export type CameraKey = { t: number; angle: number; distance: number; height: number; lens: number; aimHeight?: number };
export type Camera = { move: typeof MOVES[number]; target: number | [number, number, number]; angle: number; distance: number; height: number; lens: number; amount?: number; aimHeight: number; handheld: number; keys?: CameraKey[] };
/** How the shot is filmed (the Shot tab's Filming section; the AI sets it too). nodes: the video workflow's node settings. */
export type Film = { engine: 'ltx' | 'wan'; keyframe: 'image.control' | 'image.edit'; strength: number; imageStrength: number; nodes: Record<string, string | number | boolean>; keyframeNodes: Record<string, string | number | boolean> };
export type ShotDoc = {
  v: 1; title: string; seconds: number; aspect: keyof typeof ASPECTS; look: string; action: string;
  cast: Member[]; props: Prop[];
  set: { ground: string; sky: string | null; skyColor: string; lights: typeof LIGHTS[number] };
  camera: Camera;
  film: Film;
};

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (n: number) => Math.round(n * 100) / 100;
const xy = (v: unknown, d: XY = [0, 0]): XY => (Array.isArray(v) && v.length >= 2 ? [r2(clamp(num(v[0], d[0]), -60, 60)), r2(clamp(num(v[1], d[1]), -60, 60))] : d);
const str = (v: unknown, max: number, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);
const color = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
const assetId = (v: unknown) => (typeof v === 'string' && /^a_[0-9a-f]{6,40}$/.test(v) ? v : null);
const sid = (p: string) => `${p}_${crypto.randomBytes(4).toString('hex')}`;
const PALETTE = ['#c8a27a', '#7aa2c8', '#a27ac8', '#7ac8a2', '#c87a8a', '#c8c27a'];

export const newShot = (title = 'Untitled shot'): ShotDoc => ({
  v: 1, title, seconds: 5, aspect: '16:9', look: '', action: '', cast: [], props: [],
  set: { ground: '#3a3d44', sky: null, skyColor: '#1b1e26', lights: 'studio' },
  camera: { move: 'static', target: [0, 0, 1], angle: 0, distance: 6, height: 1.6, lens: 35, aimHeight: 0.55, handheld: 0 },
  film: { engine: 'ltx', keyframe: 'image.control', strength: 1, imageStrength: 1, nodes: {}, keyframeNodes: {} },
});

/** Node settings as stored: at most 40 short scalar values (the workflow checks them again when it runs). */
const nodeMap = (v: unknown): Record<string, string | number | boolean> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
    if (!/^[\w:.-]{1,60}$/.test(k)) continue;
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (typeof x === 'boolean') out[k] = x;
    else if (typeof x === 'string' && x.length <= 80) out[k] = x;
  }
  return out;
};

/** A shot as stored: every field checked and kept in range, ids kept or made. */
export function normalizeShot(input: any): ShotDoc {
  const d = newShot();
  const s = input && typeof input === 'object' ? input : {};
  const cast: Member[] = (Array.isArray(s.cast) ? s.cast : []).slice(0, 8).map((c: any, i: number) => ({
    id: typeof c?.id === 'string' && /^m_\w{4,16}$/.test(c.id) ? c.id : sid('m'),
    name: str(c?.name, 60, `Character ${i + 1}`) || `Character ${i + 1}`,
    description: str(c?.description, 600),
    asset: assetId(c?.asset),
    animation: str(c?.animation, 60) || null,
    height: r2(clamp(num(c?.height, 1.75), 0.2, 12)),
    position: xy(c?.position, [i * 1.5 - 1, 0]),
    facing: r2(num(c?.facing, 0) % 360),
    color: color(c?.color, PALETTE[i % PALETTE.length]),
    beats: (Array.isArray(c?.beats) ? c.beats : []).slice(0, 12).map((b: any) => ({
      ...(b?.to ? { to: xy(b.to) } : {}),
      ...(b?.seconds != null ? { seconds: r2(clamp(num(b.seconds, 1), 0.1, 20)) } : {}),
      ...(b?.animation ? { animation: str(b.animation, 60) } : {}),
      ...(b?.lookAt != null ? { lookAt: typeof b.lookAt === 'number' ? Math.max(0, Math.round(b.lookAt)) : xy(b.lookAt) } : {}),
      ...(b?.facing != null ? { facing: r2(num(b.facing, 0)) } : {}),
    })),
  }));
  const props: Prop[] = (Array.isArray(s.props) ? s.props : []).slice(0, 16).map((p: any, i: number) => ({
    id: typeof p?.id === 'string' && /^p_\w{4,16}$/.test(p.id) ? p.id : sid('p'),
    name: str(p?.name, 60, `Prop ${i + 1}`) || `Prop ${i + 1}`,
    description: str(p?.description, 400),
    asset: assetId(p?.asset),
    shape: ['box', 'cylinder', 'sphere'].includes(p?.shape) ? p.shape : 'box',
    position: xy(p?.position, [i, 2]),
    facing: r2(num(p?.facing, 0) % 360),
    size: r2(clamp(num(p?.size, 1), 0.05, 30)),
    color: color(p?.color, '#8a8f99'),
  }));
  const c = s.camera ?? {};
  const target = typeof c.target === 'number' && c.target >= 0 && c.target < cast.length ? Math.round(c.target)
    : Array.isArray(c.target) && c.target.length >= 3 ? [r2(num(c.target[0], 0)), r2(num(c.target[1], 0)), r2(num(c.target[2], 1))] as [number, number, number]
      : cast.length ? 0 : d.camera.target;
  const set = s.set ?? {};
  return {
    v: 1,
    title: str(s.title, 120, d.title) || d.title,
    seconds: r2(clamp(num(s.seconds, d.seconds), 1, 10)),
    aspect: (Object.keys(ASPECTS) as (keyof typeof ASPECTS)[]).includes(s.aspect) ? s.aspect : d.aspect,
    look: str(s.look, 2000), action: str(s.action, 2000),
    cast, props,
    set: { ground: color(set.ground, d.set.ground), sky: assetId(set.sky), skyColor: color(set.skyColor, d.set.skyColor), lights: (LIGHTS as readonly string[]).includes(set.lights) ? set.lights : d.set.lights },
    camera: {
      move: (MOVES as readonly string[]).includes(c.move) ? c.move : d.camera.move,
      target,
      angle: r2(num(c.angle, 0)), distance: r2(clamp(num(c.distance, 6), 0.3, 80)), height: r2(clamp(num(c.height, 1.6), -5, 60)),
      lens: r2(clamp(num(c.lens, 35), 10, 200)), ...(c.amount != null ? { amount: r2(num(c.amount, 0)) } : {}),
      aimHeight: r2(clamp(num(c.aimHeight, 0.55), 0, 1.2)), handheld: r2(clamp(num(c.handheld, 0), 0, 2)),
      ...(Array.isArray(c.keys) && c.keys.length ? {
        keys: c.keys.slice(0, 16).map((k: any) => ({
          t: r2(clamp(num(k?.t, 0), 0, 10)), angle: r2(num(k?.angle, num(c.angle, 0))), distance: r2(clamp(num(k?.distance, num(c.distance, 6)), 0.3, 80)),
          height: r2(clamp(num(k?.height, num(c.height, 1.6)), -5, 60)), lens: r2(clamp(num(k?.lens, num(c.lens, 35)), 10, 200)),
          ...(k?.aimHeight != null ? { aimHeight: r2(clamp(num(k.aimHeight, 0.55), 0, 1.2)) } : {}),
        })).sort((a: CameraKey, b: CameraKey) => a.t - b.t),
      } : {}),
    },
    film: (() => {
      const f = s.film ?? {};
      return {
        engine: f.engine === 'wan' ? 'wan' : 'ltx', keyframe: f.keyframe === 'image.edit' ? 'image.edit' : 'image.control',
        strength: r2(clamp(num(f.strength, 1), 0, 1)), imageStrength: r2(clamp(num(f.imageStrength, 1), 0, 1)),
        nodes: nodeMap(f.nodes), keyframeNodes: nodeMap(f.keyframeNodes),
      } as Film;
    })(),
  };
}

// ------------------------------------------------------------------ storage
type Row = { id: string; project: string; title: string; doc: string; version: number; created: number; updated: number };
export type ShotRow = Omit<Row, 'doc'> & { doc: ShotDoc };
const fromRow = (r: Row): ShotRow => ({ ...r, doc: normalizeShot(JSON.parse(r.doc)) });

export const listShots = (project: string, limit = 60) =>
  (db.prepare('SELECT id, project, title, version, created, updated FROM director_shots WHERE project = ? ORDER BY updated DESC LIMIT ?').all(project, limit) as Omit<Row, 'doc'>[]);

export function createShot(project: string, doc?: unknown): ShotRow {
  const d = normalizeShot(doc ?? newShot());
  const id = sid('sh');
  const now = Date.now();
  db.prepare('INSERT INTO director_shots (id, project, title, doc, version, created, updated) VALUES (?, ?, ?, ?, 1, ?, ?)').run(id, project, d.title, JSON.stringify(d), now, now);
  return getShot(id, (p) => p === project);
}

export function getShot(id: string, canSee: (project: string) => boolean): ShotRow {
  const r = db.prepare('SELECT * FROM director_shots WHERE id = ?').get(id) as Row | undefined;
  if (!r || !canSee(r.project)) throw new GenError('No such shot', { status: 404 });
  return fromRow(r);
}

/** Saves a shot. With `version`, a save that crosses a newer one is refused (409) with that one. */
export function saveShot(s: ShotRow, doc: unknown, version?: number): ShotRow {
  if (version != null && version !== s.version) throw Object.assign(new GenError('This shot changed somewhere else', { status: 409 }), { shot: s });
  const d = normalizeShot(doc);
  const now = Date.now();
  db.prepare('UPDATE director_shots SET title = ?, doc = ?, version = version + 1, updated = ? WHERE id = ?').run(d.title, JSON.stringify(d), now, s.id);
  return { ...s, title: d.title, doc: d, version: s.version + 1, updated: now };
}

export function deleteShot(id: string, canSee: (project: string) => boolean) {
  getShot(id, canSee);
  db.prepare('DELETE FROM director_shots WHERE id = ?').run(id);
}

// ------------------------------------------------------------------ the AI director
const SHOT_DOC = `The shot (JSON). Coordinates in meters on the ground: x to the right, y away from the default camera; z is up. facing is degrees, 0 faces the default camera (looks toward -y), 90 faces +x (screen right), 180 faces away, -90 faces screen left.
{
 "title": "...", "seconds": 1-10, "aspect": "16:9"|"9:16"|"1:1",
 "look": "what the finished frame looks like: the place, the era, the style (live-action film still, anime, claymation...), the light and weather, and every character's appearance. This paints the first frame.",
 "action": "what happens over the shot, in order, and what it sounds like (dialogue in quotes). This drives the video.",
 "cast": [{"id": keep it, "name": "...", "description": "how they look", "asset": "a_... a 3D model (kind mesh) from the library, or null for a stand-in", "animation": "a clip name in the model, or null", "height": meters, "position": [x, y], "facing": degrees, "beats": [{"to": [x, y], "seconds": s} | {"lookAt": cast index, "seconds": s} | {"facing": degrees, "seconds": s}]}],
 "props": [{"id": keep it, "name": "...", "description": "...", "asset": "a_... or null", "shape": "box"|"cylinder"|"sphere", "position": [x, y], "facing": degrees, "size": meters (its largest side), "color": "#rrggbb"}],
 "set": {"ground": "#rrggbb", "sky": "a_... a 360° panorama image from the library, or null", "skyColor": "#rrggbb", "lights": "studio"|"sun"|"night"},
 "film": {"engine": "ltx" (LTX-2.3 video.control: 24 fps, sound) | "wan" (video.control-wan: 16 fps, no sound, steadier faces), "keyframe": "image.control" (paints the stage frame, keeps the layout) | "image.edit" (Qwen edit: closer to references), "strength": 0-1 how strictly the video follows the stage (lower for life, 1 for exact camera moves), "imageStrength": 0-1 how strictly frame 1 matches the keyframe, "nodes": {"<node>.<input>": value} the video workflow's node settings, "keyframeNodes": the same for the keyframe tool},
 "camera": {"keys": [{"t": seconds, "angle", "distance", "height", "lens", "aimHeight"?}] optional: the camera at those times, eased between them (when there are keys they replace the move; target, follow and handheld still apply), "${MOVES.join('"|"')}", "target": cast index or [x, y, z], "angle": degrees around the target (0 in front of it, 90 from its right side), "distance": meters, "height": meters (camera height above the ground), "lens": mm (18 wide, 35 normal, 85 close), "amount": how far the move goes (a share of the distance for push/pull, degrees for orbit, meters for pan/truck/crane), "aimHeight": share of the target's height to aim at (0.55), "handheld": 0-2}
}`;

function directorSystem() {
  return `You are the director inside Hawkes Gen. The person designs one shot with you: a small 3D scene (cast, props, set, camera) that Gen films into a short video clip. You turn what they say into the shot: block the action (where everyone stands, where they move, who faces whom), pick the lens and the camera move for the feeling they want, and write the look and the action so the result is cinematic. Think like a cinematographer: clear staging, the subject framed well, the camera moving with purpose, nobody hiding the face that matters. Characters are about 1.7 m tall unless they're not; keep them 1 to 4 m apart, in front of the camera.

When the person selected a stretch of the shot (selection.range, seconds), "here" and "this part" mean that stretch: change the camera there with keys at its start and end (and keep the camera as it was outside it: add keys just before and after when needed), or the beats that happen in it.

You also choose how it's filmed (film): the notes below say how the filming tools' settings pull on each other and what to change when a take is wrong. When the person says what was wrong with a take ("too stiff", "the faces melt", "it ignores the camera"), change film, not just the staging.

Answer with the WHOLE shot, changed as asked (keep everything they didn't ask to change, and keep ids). Without a 3D model a character is a stand-in of its height: that's fine, the look describes them and the video paints them. Use library models (kind mesh) when one fits what they ask for. When they ask for something that needs a model the library doesn't have, use a stand-in and say they can make one in Create (3D).

${SHOT_DOC}

Answer with JSON only: {"say": "one or two short sentences: what you did, and a tip if it helps", "shot": { the whole shot }}.`;
}

/** The filming tools' craft (src/knowledge.ts), for the AI director. */
const FILM_CRAFT = () => toolCraft(['video.control', 'image.control', 'video.control-wan', 'image.edit']);

const DIRECTOR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['say', 'shot'],
  properties: { say: { type: 'string' }, shot: { type: 'object' } },
};

export type DirectorTurn = { project: string; shot: ShotDoc; messages: { role: 'user' | 'assistant'; text: string }[]; library: { id: string; kind: string; title?: string | null; prompt?: string | null }[]; selection?: { range?: [number, number] | null; t?: number; selected?: { type: string; i: number } | null } };

export function directorPrompt(a: DirectorTurn) {
  const convo = a.messages.slice(-14).map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${String(m.text).slice(0, 4000)}`).join('\n\n');
  const lib = a.library.slice(0, 40).map((x) => ({ id: x.id, kind: x.kind, title: x.title ?? x.prompt ?? null }));
  return {
    system: directorSystem(),
    prompt: `The shot now:\n${JSON.stringify(a.shot)}\n\nThe person's selection: ${JSON.stringify(a.selection ?? {})}\n\nHow the filming tools work:\n${FILM_CRAFT()}\n\nThe library (3D models are kind "mesh"; 360° skies are images made by image.panorama):\n${JSON.stringify(lib)}\n\nThe conversation (the last line is what to do now):\n${convo}`,
    schema: DIRECTOR_SCHEMA, maxTokens: 6000, effort: 'medium',
  };
}

export function parseDirector(text: string, was: ShotDoc): { say: string; shot: ShotDoc } {
  let t = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try {
    const j = JSON.parse(t);
    return { say: String(j.say ?? '').slice(0, 2000), shot: j.shot && typeof j.shot === 'object' ? normalizeShot(j.shot) : was };
  } catch {
    return { say: String(text ?? '').slice(0, 2000), shot: was };
  }
}

/** One director turn, on the account's own Claude or the house AI (like the AI editor: src/houseai.ts). */
export async function directorTurn(a: DirectorTurn) {
  const r = await callScope.run({ customer: true, org: orgOfProject(a.project), house: isGenAccountProject(a.project) }, () => ask(directorPrompt(a)));
  return { ...parseDirector(r.text, a.shot), model: r.model, house: !['byok', 'subscription'].includes(r.billing), cost: r.cost ?? 0 };
}

// ------------------------------------------------------------------ filming
/** The prompts the "film it now" path uses: the first frame's paint, and the video's. */
export function filmPrompts(s: ShotDoc) {
  const who = s.cast.map((c) => `${c.name}${c.description ? `: ${c.description}` : ''}`).join('; ');
  const things = s.props.map((p) => `${p.name}${p.description ? ` (${p.description})` : ''}`).join(', ');
  const look = [s.look || 'A cinematic live-action film still', who && `Characters: ${who}.`, things && `Also in the scene: ${things}.`, 'Keep the layout, the camera and every figure\'s position and pose exactly as in the control image.'].filter(Boolean).join(' ');
  const action = [s.action || 'The scene plays out with natural, continuous motion', 'Cinematic camera, natural sound.'].join(' ');
  return { look: look.slice(0, 3000), action: action.slice(0, 3000), size: ASPECTS[s.aspect] };
}

/**
 * The shot as Gen's Blender film pipeline (cinemaPass): blender.render's shot, its files (the cast's and props' models,
 * the sky) and the asset.make recipe. Every cast member needs a 3D model.
 */
export function blenderRecipe(s: ShotDoc) {
  const missing = s.cast.filter((c) => !c.asset).map((c) => c.name);
  if (!s.cast.length) throw new GenError('Add someone to the shot first', { status: 400 });
  if (missing.length) throw new GenError(`Blender needs a 3D model for everyone: ${missing.join(', ')} ${missing.length === 1 ? 'is a stand-in' : 'are stand-ins'}. Make one in Create (3D), or film it now instead.`, { status: 400 });
  const files: string[] = [];
  const fileOf = (asset: string) => { const i = files.indexOf(`asset:${asset}`); if (i >= 0) return i; files.push(`asset:${asset}`); return files.length - 1; };
  const characters = s.cast.map((c) => ({
    file: fileOf(c.asset!), height: c.height, position: c.position, facing: c.facing,
    ...(c.animation ? { animation: c.animation } : {}),
    ...(c.beats.length ? { beats: c.beats.map((b) => ({ ...b, ...(c.animation && !b.animation ? { animation: c.animation } : {}) })) } : {}),
  }));
  const props = s.props.filter((p) => p.asset).map((p) => ({ file: fileOf(p.asset!), position: p.position, facing: p.facing, size: p.size }));
  const shot: any = {
    characters, props,
    ground: { size: 60, color: s.set.ground },
    ...(s.set.sky ? { background: { file: fileOf(s.set.sky), strength: 1 } } : { background: { color: s.set.skyColor } }),
    lights: s.set.lights,
    camera: { ...s.camera, dof: true },
  };
  const [width, height] = ASPECTS[s.aspect];
  const p = filmPrompts(s);
  delete shot.camera.keys;
  const recipe = cinemaPass({ shot, look: p.look, motion: p.action, seconds: s.seconds, width, height, engine: s.film.engine });
  if (s.camera.keys?.length) recipe.notes.unshift('Blender films the camera move, not the camera keys: the keys are for "Film it".');
  return { recipe, files };
}
