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
// A shot is a scene of kind "stage" (src/scenes.ts). A cast member can be a character scene (`character`): their name,
// look, voice, height, color and model come from it (castFromCharacters, on every save and read), so one character plays
// in any number of shots.
//
// Sequences and dialogue: a sequence is an ordered list of shots (table stage_sequences; each shot's doc names its
// sequence and order). The shots share the set, the look, the shape and how they're filmed, and each cast member is the
// same person in every shot (name, look, model, voice): a save carries those to the other shots (shareAcross). Each shot keeps its
// own camera, blocking, action and lines. A shot's lines are who says what and when; a "talk" shot is a dialogue close-up,
// filmed from its first frame and the speaker's line with video.talk instead of from the stage's depth.
//
// Coordinates are blender.render's: x right, y away from the default camera, meters on the ground; facing in degrees,
// 0 faces the default camera. So a shot exports to blender.render as it is (docs/blender.md, "The shot").

import crypto from 'node:crypto';
import { db } from './db.ts';
import { registerKind, listScenes, createScene, getScene, saveScene, deleteScene, sceneRef, kindOf, type Scene } from './scenes.ts';
import { GenError } from './util.ts';
import { ask, callScope } from './providers/anthropic.ts';
import { orgOfProject, isHouseProject } from './orgsecrets.ts';
import { cinemaPass } from './film/recipes.ts';
import { toolCraft } from './knowledge.ts';
import './scenekinds.ts';
import { keptRender } from './editor.ts';
import type { Render } from './scenes.ts';
import { identityPack } from './identity.ts';
import { firstFramePlan, viewOf, type CastPack, type FirstFrameOptions } from './identity-film.ts';


export const MOVES = ['static', 'push-in', 'pull-out', 'orbit', 'turntable', 'pan', 'truck', 'crane-up', 'crane-down', 'follow'] as const;
export const LIGHTS = ['studio', 'sun', 'night'] as const;
export const ASPECTS = { '16:9': [1280, 704], '9:16': [704, 1280], '1:1': [960, 960] } as const;

type XY = [number, number];
export type Beat = { to?: XY; seconds?: number; animation?: string; lookAt?: number | XY; facing?: number };
export type Member = { id: string; character?: string | null; name: string; description: string; asset?: string | null; animation?: string | null; voice?: string | null; height: number; position: XY; facing: number; color: string; beats: Beat[] };
/** A spoken line: who says it (a cast index), what, and when in the shot (seconds). */
export type Line = { who: number; text: string; at: number };
/**
 * A thing on the set: a library 3D model (`asset`), a shape, or a `screen` (a standing picture or video: `media` is the
 * file, `scene` the scene whose render it shows, kept up to date like a timeline clip's; `size` is its width).
 */
export type Prop = { id: string; name: string; description: string; asset?: string | null; shape: 'box' | 'cylinder' | 'sphere' | 'screen'; media?: string | null; scene?: string | null; sceneVersion?: number; position: XY; facing: number; size: number; color: string };
export type CameraKey = { t: number; angle: number; distance: number; height: number; lens: number; aimHeight?: number };
export type Camera = { move: typeof MOVES[number]; target: number | [number, number, number]; angle: number; distance: number; height: number; lens: number; amount?: number; aimHeight: number; handheld: number; keys?: CameraKey[] };
/** How the shot is filmed (the Shot tab's Filming section; the AI sets it too). nodes: the video workflow's node settings. */
export type Film = { engine: 'ltx' | 'wan'; keyframe: 'image.control' | 'image.edit'; strength: number; imageStrength: number; nodes: Record<string, string | number | boolean>; keyframeNodes: Record<string, string | number | boolean> };
export type ShotDoc = {
  v: 1; title: string; seconds: number; aspect: keyof typeof ASPECTS; look: string; action: string;
  sequence: string | null; order: number; kind: 'action' | 'talk'; lines: Line[];
  cast: Member[]; props: Prop[];
  set: { ground: string; sky: string | null; skyColor: string; lights: typeof LIGHTS[number] };
  camera: Camera;
  film: Film;
  render?: Render | null;
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
  v: 1, title, seconds: 5, aspect: '16:9', look: '', action: '', sequence: null, order: 0, kind: 'action', lines: [], cast: [], props: [],
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
    character: sceneRef(c?.character),
    animation: str(c?.animation, 60) || null,
    voice: typeof c?.voice === 'string' && /^[\w-]{4,64}$/.test(c.voice) ? c.voice : null,
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
    shape: ['box', 'cylinder', 'sphere', 'screen'].includes(p?.shape) ? p.shape : 'box',
    ...(p?.shape === 'screen' && assetId(p?.media) ? { media: assetId(p.media) } : {}),
    ...(sceneRef(p?.scene) ? { scene: sceneRef(p.scene), ...(Number.isFinite(Number(p?.sceneVersion)) ? { sceneVersion: Number(p.sceneVersion) } : {}) } : {}),
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
    sequence: (() => { const q = s.sequence ?? s.scene; return typeof q === 'string' && /^(sq|sc)_[0-9a-f]{8}$/.test(q) ? q : null; })(),
    ...(keptRender(s.render) ? { render: keptRender(s.render) } : {}),
    order: Math.max(0, Math.round(num(s.order, 0))),
    kind: s.kind === 'talk' ? 'talk' : 'action',
    lines: (Array.isArray(s.lines) ? s.lines : []).slice(0, 12).map((l: any) => ({
      who: Math.max(0, Math.min(Math.max(0, cast.length - 1), Math.round(num(l?.who, 0)))), text: str(l?.text, 600).trim(), at: r2(clamp(num(l?.at, 0), 0, 10)),
    })).filter((l: Line) => l.text && cast.length),
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

// ------------------------------------------------------------------ storage: stage scenes (src/scenes.ts)
export type ShotRow = Scene<ShotDoc>;

/**
 * Cast members who are character scenes take who they are from them: name, look, voice, height, color, model, clip.
 * Where they stand and what they do stay the shot's. True when anything changed.
 */
export function castFromCharacters(doc: ShotDoc, project: string): boolean {
  let changed = false;
  for (const c of doc.cast) {
    if (!c.character) continue;
    const r = db.prepare(`SELECT doc FROM scenes WHERE id = ? AND project = ? AND kind = 'character'`).get(c.character, project) as { doc: string } | undefined;
    if (!r) continue;
    const ch = kindOf('character').normalize(JSON.parse(r.doc));
    // A locked character's fixed description (src/identity.ts) is who they are in every shot.
    const next = { name: ch.title, description: identityPack(ch).description, voice: ch.voice, height: ch.height, color: ch.color, asset: ch.model?.asset ?? c.asset ?? null, animation: c.animation ?? ch.clips?.[0]?.name ?? null };
    for (const [k, v] of Object.entries(next)) if ((c as any)[k] !== v) { (c as any)[k] = v; changed = true; }
  }
  return changed;
}

registerKind('stage', {
  normalize: normalizeShot,
  blank: (title) => newShot(title),
  uses: (doc: ShotDoc) => [...doc.cast.map((c) => c.character).filter(Boolean) as string[], ...doc.props.map((p) => p.scene).filter(Boolean) as string[]],
});

export const listShots = (project: string, limit = 60) => listScenes(project, 'stage', limit);

export function createShot(project: string, doc?: unknown): ShotRow {
  const d = normalizeShot(doc ?? newShot());
  castFromCharacters(d, project);
  return createScene(project, 'stage', { ...d, world: (doc as any)?.world }, 'sh');
}

export function getShot(id: string, canSee: (project: string) => boolean): ShotRow {
  const s = getScene(id, canSee, 'stage') as ShotRow;
  if (castFromCharacters(s.doc, s.project)) return saveScene(s, s.doc) as ShotRow;
  return s;
}

/** Saves a shot. With `version`, a save that crosses a newer one is refused (409) with that one. */
export function saveShot(s: ShotRow, doc: unknown, version?: number): ShotRow {
  const d = normalizeShot(doc);
  castFromCharacters(d, s.project);
  try {
    return saveScene(s, { ...d, world: (doc as any)?.world }, version) as ShotRow;
  } catch (e: any) {
    if (e.status === 409) e.shot = e.scene;
    throw e;
  }
}

export const deleteShot = (id: string, canSee: (project: string) => boolean) => deleteScene(id, canSee, 'stage');

// ------------------------------------------------------------------ sequences
db.exec(`CREATE TABLE IF NOT EXISTS stage_sequences (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
// The few made before sequences had their name (dev only, 2026-10-29) come across once.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'director_scenes'").get()) {
  db.exec(`INSERT OR IGNORE INTO stage_sequences (id, project, title, created, updated) SELECT id, project, title, created, updated FROM director_scenes`);
}

export type SequenceSummary = { id: string; title: string; shots: { id: string; title: string; order: number; kind: string; seconds: number; lines: number }[] };

/** The shots of a sequence, in order. */
export function sequenceShots(seq: string, project: string): ShotRow[] {
  const ids = db.prepare(`SELECT id FROM scenes WHERE project = ? AND kind = 'stage' AND (json_extract(doc, '$.sequence') = ? OR json_extract(doc, '$.scene') = ?)`).all(project, seq, seq) as { id: string }[];
  return ids.map((r) => getScene(r.id, () => true, 'stage') as ShotRow).sort((a, b) => a.doc.order - b.doc.order || a.created - b.created);
}

export function sequenceSummary(seq: string | null, project: string): SequenceSummary | null {
  if (!seq) return null;
  const r = db.prepare('SELECT id, title FROM stage_sequences WHERE id = ? AND project = ?').get(seq, project) as { id: string; title: string } | undefined;
  if (!r) return null;
  return { ...r, shots: sequenceShots(seq, project).map((x) => ({ id: x.id, title: x.doc.title, order: x.doc.order, kind: x.doc.kind, seconds: x.doc.seconds, lines: x.doc.lines.length })) };
}

export function createSequence(project: string, title: string) {
  const id = `sq_${crypto.randomBytes(4).toString('hex')}`;
  const now = Date.now();
  db.prepare('INSERT INTO stage_sequences (id, project, title, created, updated) VALUES (?, ?, ?, ?, ?)').run(id, project, String(title || 'Untitled sequence').slice(0, 120), now, now);
  return id;
}

export function renameSequence(seq: string, project: string, title: string) {
  db.prepare('UPDATE stage_sequences SET title = ?, updated = ? WHERE id = ? AND project = ?').run(String(title || 'Untitled sequence').slice(0, 120), Date.now(), seq, project);
}

/** Puts the sequence's shots in this order (ids not in it are ignored; ones left out keep their place after). */
export function reorderSequence(seq: string, project: string, ids: string[]) {
  const shots = sequenceShots(seq, project);
  const ordered = [...ids.map((id) => shots.find((x) => x.id === id)).filter(Boolean) as ShotRow[], ...shots.filter((x) => !ids.includes(x.id))];
  ordered.forEach((x, i) => { if (x.doc.order !== i) writeDoc(x, { ...x.doc, order: i }); });
}

/** A shot's doc written as it is (no version check), for sequence bookkeeping. */
function writeDoc(x: ShotRow, doc: ShotDoc) {
  saveScene(x, doc);
}
const writeDocBack = (x: ShotRow, doc: ShotDoc) => saveScene(x, doc) as ShotRow;

/**
 * Carries what a sequence shares from one shot to the others: the shape, the look, the set and how it's filmed, and each
 * cast member's identity (name, look, model, clip, height, color, voice) by id. Blocking, camera, action and lines stay.
 */
export function shareAcross(saved: ShotRow) {
  const d = saved.doc;
  if (!d.sequence) return;
  const who = new Map(d.cast.map((c) => [c.id, c]));
  for (const x of sequenceShots(d.sequence, saved.project)) {
    if (x.id === saved.id) continue;
    const cast = x.doc.cast.map((c) => { const m = who.get(c.id); return m ? { ...c, character: m.character, name: m.name, description: m.description, asset: m.asset, animation: m.animation, voice: m.voice, height: m.height, color: m.color } : c; });
    const next = { ...x.doc, aspect: d.aspect, look: d.look, set: d.set, film: d.film, cast };
    if (JSON.stringify(next) !== JSON.stringify(x.doc)) writeDoc(x, normalizeShot(next));
  }
}

/** A new shot after this one in its sequence (making the sequence first): the same cast where they stand, a fresh camera. */
export function addShotAfter(s: ShotRow): ShotRow {
  let sequence = s.doc.sequence;
  if (!sequence) { sequence = createSequence(s.project, `${s.doc.title} (sequence)`); s = writeDocBack(s, { ...s.doc, sequence, order: 0 }); }
  const after = sequenceShots(sequence, s.project);
  const at = after.findIndex((x) => x.id === s.id) + 1;
  after.slice(at).forEach((x) => writeDoc(x, { ...x.doc, order: x.doc.order + 1 }));
  const doc = { ...s.doc, title: `Shot ${after.length + 1}`, order: s.doc.order + 1, action: '', lines: [], kind: 'action' as const, cast: s.doc.cast.map((c) => ({ ...c, beats: [] })), camera: { ...s.doc.camera, keys: undefined, move: 'static' as const } };
  return createShot(s.project, doc);
}

// ------------------------------------------------------------------ the AI director
const SHOT_DOC = `The shot (JSON). Coordinates in meters on the ground: x to the right, y away from the default camera; z is up. facing is degrees, 0 faces the default camera (looks toward -y), 90 faces +x (screen right), 180 faces away, -90 faces screen left.
{
 "shotId": keep it (a new shot has none), "title": "...", "seconds": 1-10, "aspect": "16:9"|"9:16"|"1:1",
 "kind": "action" (filmed from the stage: the camera, blocking and action) | "talk" (a dialogue close-up: the first frame of the stage, then the speaker's line drives lips, head and body with video.talk; one speaker, frame them close, lines[0] is theirs),
 "lines": [{"who": cast index, "text": "what they say", "at": seconds into the shot}],
 "look": "what the finished frame looks like: the place, the era, the style (live-action film still, anime, claymation...), the light and weather, and every character's appearance. This paints the first frame.",
 "action": "what happens over the shot, in order, and what it sounds like (dialogue in quotes). This drives the video.",
 "cast": [{"id": keep it, "character": "a character scene's id, or null" (when set, name, look, voice, height and model come from it: keep them as they are), "name": "...", "description": "how they look", "voice": "a voice id from the voices list, or null", "asset": "a_... a 3D model (kind mesh) from the library, or null for a stand-in", "animation": "a clip name in the model, or null", "height": meters, "position": [x, y], "facing": degrees, "beats": [{"to": [x, y], "seconds": s} | {"lookAt": cast index, "seconds": s} | {"facing": degrees, "seconds": s}]}],
 "props": [{"id": keep it, "name": "...", "description": "...", "asset": "a_... or null", "shape": "box"|"cylinder"|"sphere"|"screen" (a standing picture or video: "media" the file, "scene" the scene it shows; keep both), "position": [x, y], "facing": degrees, "size": meters (its largest side; a screen's width), "color": "#rrggbb"}],
 "set": {"ground": "#rrggbb", "sky": "a_... a 360° panorama image from the library, or null", "skyColor": "#rrggbb", "lights": "studio"|"sun"|"night"},
 "film": {"engine": "ltx" (LTX-2.3 video.control: 24 fps, sound) | "wan" (video.control-wan: 16 fps, no sound, steadier faces), "keyframe": "image.control" (paints the stage frame, keeps the layout) | "image.edit" (Qwen edit: closer to references), "strength": 0-1 how strictly the video follows the stage (lower for life, 1 for exact camera moves), "imageStrength": 0-1 how strictly frame 1 matches the keyframe, "nodes": {"<node>.<input>": value} the video workflow's node settings, "keyframeNodes": the same for the keyframe tool},
 "camera": {"keys": [{"t": seconds, "angle", "distance", "height", "lens", "aimHeight"?}] optional: the camera at those times, eased between them (when there are keys they replace the move; target, follow and handheld still apply), "${MOVES.join('"|"')}", "target": cast index or [x, y, z], "angle": degrees around the target (0 in front of it, 90 from its right side), "distance": meters, "height": meters (camera height above the ground), "lens": mm (18 wide, 35 normal, 85 close), "amount": how far the move goes (a share of the distance for push/pull, degrees for orbit, meters for pan/truck/crane), "aimHeight": share of the target's height to aim at (0.55), "handheld": 0-2}
}`;

function directorSystem() {
  return `You are the director inside Hawkes Gen. The person designs shots and sequences with you. A shot is a small 3D scene (cast, props, set, camera) that Gen films into a short video clip; a sequence is shots in order, cut together. You turn what they say into shots: block the action (where everyone stands, where they move, who faces whom), pick the lens and the camera move for the feeling they want, and write the look and the action so the result is cinematic. Think like a cinematographer: clear staging, the subject framed well, the camera moving with purpose, nobody hiding the face that matters. Characters are about 1.7 m tall unless they're not; keep them 1 to 4 m apart, in front of the camera.

Files the person picked in Media come as selection.media (id, kind, title): "this", "it", "these" and "use this" can mean them; use them by id as inputs or add them. When the person selected a stretch of the shot (selection.range, seconds), "here" and "this part" mean that stretch: change the camera there with keys at its start and end (and keep the camera as it was outside it: add keys just before and after when needed), or the beats that happen in it.

You also choose how it's filmed (film): the notes below say how the filming tools' settings pull on each other and what to change when a take is wrong. When the person says what was wrong with a take ("too stiff", "the faces melt", "it ignores the camera"), change film, not just the staging.

Sequences: when they ask for a scene, a sequence or coverage ("they argue, then she leaves"), plan it as shots like an editor would cut it: an establishing wide, then the coverage (over-the-shoulder, reverse, close-ups on who speaks, inserts), each 2 to 6 seconds, each with its own camera and blocking that continue from the shot before (people where the last shot left them, the 180° rule: keep the camera on one side of the line between two people), the same cast (same ids, names, looks, voices), set, look and film. Put each line of dialogue in the shot where it's said; a close-up of one person speaking is kind "talk". Give every speaking character a voice that fits (pick from the voices list by name and description).

Answer with every shot of the sequence (or just the one shot when there's no sequence and they asked for one), in order, each WHOLE and changed as asked (keep everything they didn't ask to change, and keep ids and shotIds). Leave a shot out only to cut it from the scene. Without a 3D model a character is a stand-in of its height: that's fine, the look describes them and the video paints them. Use library models (kind mesh) when one fits what they ask for. When they ask for something that needs a model the library doesn't have, use a stand-in and say they can make one in Create (3D).

${SHOT_DOC}

Answer with JSON only: {"say": "one or two short sentences: what you did, and a tip if it helps", "sequenceTitle": "a name for the sequence when there's more than one shot", "shots": [ every shot, whole, in order ], "current": the index in shots of the shot to show}.`;
}

/** The filming tools' craft (src/knowledge.ts), for the AI director. */
const FILM_CRAFT = () => toolCraft(['video.control', 'image.control', 'video.control-wan', 'image.edit']);

const DIRECTOR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['say', 'shots', 'current'],
  properties: { say: { type: 'string' }, sequenceTitle: { type: 'string' }, shots: { type: 'array', items: { type: 'object' } }, current: { type: 'integer' } },
};

export type DirectorTurn = { project: string; shot: ShotDoc; shotId?: string; sequence?: { title: string; shots: (ShotDoc & { shotId: string })[] } | null; characters?: { id: string; name: string; description: string }[]; voices?: { id: string; name: string; about: string }[]; messages: { role: 'user' | 'assistant'; text: string }[]; library: { id: string; kind: string; title?: string | null; prompt?: string | null }[]; selection?: { range?: [number, number] | null; t?: number; selected?: { type: string; i: number } | null; media?: { id: string; kind: string; title?: string | null }[] } };

export function directorPrompt(a: DirectorTurn) {
  const convo = a.messages.slice(-14).map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${String(m.text).slice(0, 4000)}`).join('\n\n');
  const lib = a.library.slice(0, 40).map((x) => ({ id: x.id, kind: x.kind, title: x.title ?? x.prompt ?? null }));
  return {
    system: directorSystem(),
    prompt: `${a.sequence ? `The sequence "${a.sequence.title}" now (every shot in order):\n${JSON.stringify(a.sequence.shots)}\n\nThe person is on the shot with shotId ${a.shotId}.` : `The shot now:\n${JSON.stringify({ ...a.shot, shotId: a.shotId })}`}\n\nThe person's characters (character scenes: a cast member with "character": their id plays them, with their look, voice and model):\n${JSON.stringify(a.characters ?? [])}\n\nThe voices (for cast voice):\n${JSON.stringify((a.voices ?? []).slice(0, 30).map((v) => ({ id: v.id, name: v.name, about: v.about })))}\n\nThe person's selection:  ${JSON.stringify(a.selection ?? {})}\n\nHow the filming tools work:\n${FILM_CRAFT()}\n\nThe library (3D models are kind "mesh"; 360° skies are images made by image.panorama):\n${JSON.stringify(lib)}\n\nThe conversation (the last line is what to do now):\n${convo}`,
    schema: DIRECTOR_SCHEMA, maxTokens: a.sequence ? 16000 : 8000, effort: 'medium',
  };
}

export type DirectorAnswer = { say: string; sequenceTitle: string | null; shots: (ShotDoc & { shotId: string | null })[]; current: number };

/** The answer: the shots in order (each normalized, with its shotId when it was one already), and which to show. */
export function parseDirector(text: string, was: ShotDoc, wasId: string | null = null): DirectorAnswer {
  let t = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  const keep = { say: String(text ?? '').slice(0, 2000), sequenceTitle: null, shots: [{ ...was, shotId: wasId }], current: 0 };
  try {
    const j = JSON.parse(t);
    const list = Array.isArray(j.shots) ? j.shots : j.shot ? [j.shot] : [];
    const shots = list.filter((x: any) => x && typeof x === 'object').slice(0, 12).map((x: any) => ({ ...normalizeShot(x), shotId: typeof x.shotId === 'string' && /^sh_[0-9a-f]+$/.test(x.shotId) ? x.shotId : null }));
    if (!shots.length) return { ...keep, say: String(j.say ?? '').slice(0, 2000) };
    return { say: String(j.say ?? '').slice(0, 2000), sequenceTitle: (() => { const t = j.sequenceTitle ?? j.sceneTitle; return typeof t === 'string' && t.trim() ? t.trim().slice(0, 120) : null; })(), shots, current: Math.max(0, Math.min(shots.length - 1, Math.round(num(j.current, 0)))) };
  } catch {
    return keep;
  }
}

/**
 * Applies the AI's answer: shots it kept are saved, new ones made, ones it left out of the sequence leave it (never
 * deleted), and two or more shots make a sequence when there wasn't one. Returns the shot to show.
 */
export function applyDirector(project: string, from: ShotRow, ans: DirectorAnswer): ShotRow {
  let sequence = from.doc.sequence;
  const before = sequence ? sequenceShots(sequence, project) : [from];
  if (!sequence && ans.shots.length > 1) sequence = createSequence(project, ans.sequenceTitle ?? `${from.doc.title} (sequence)`);
  else if (sequence && ans.sequenceTitle) renameSequence(sequence, project, ans.sequenceTitle);
  const saved: ShotRow[] = [];
  ans.shots.forEach((x, i) => {
    const { shotId, ...doc } = x;
    const mine = before.find((b) => b.id === (shotId ?? (ans.shots.length === 1 ? from.id : '')));
    const next = { ...doc, sequence: sequence ?? null, order: i };
    saved.push(mine ? saveShot(mine, next) : createShot(project, next));
  });
  for (const b of before) if (sequence && !saved.some((x) => x.id === b.id)) writeDoc(b, { ...b.doc, sequence: null, order: 0 });
  return saved[ans.current] ?? saved[0];
}

/** One director turn, on the account's own Claude or the house AI (like the AI editor: src/houseai.ts). */
export async function directorTurn(a: DirectorTurn) {
  const r = await callScope.run({ customer: true, org: orgOfProject(a.project), house: isHouseProject(a.project) }, () => ask(directorPrompt(a)));
  return { answer: parseDirector(r.text, a.shot, a.shotId ?? null), model: r.model, house: !['byok', 'subscription'].includes(r.billing), cost: r.cost ?? 0 };
}

// ------------------------------------------------------------------ filming
/**
 * The identity pack of every cast member who plays a character scene (src/identity.ts), with their cast index. What
 * the first frame, the video and the Blender pipeline read so every shot shows the same person.
 */
export function shotPacks(doc: ShotDoc, project: string): CastPack[] {
  const out: CastPack[] = [];
  doc.cast.forEach((c, i) => {
    if (!c.character) return;
    const r = db.prepare(`SELECT doc FROM scenes WHERE id = ? AND project = ? AND kind = 'character'`).get(c.character, project) as { doc: string } | undefined;
    if (!r) return;
    const pack = identityPack(kindOf('character').normalize(JSON.parse(r.doc)));
    if (pack.refs.length || pack.description) out.push({ ...pack, cast: i, name: c.name });
  });
  return out;
}

/**
 * The prompts the "film it now" path uses: the first frame's paint, and the video's. A cast member with an identity
 * pack is described by its fixed description, unchanged, in every one of them.
 */
export function filmPrompts(s: ShotDoc, packs: CastPack[] = []) {
  const descOf = (i: number) => packs.find((p) => p.cast === i)?.description || s.cast[i]?.description || '';
  const who = s.cast.map((c, i) => `${c.name}${descOf(i) ? `: ${descOf(i)}` : ''}`).join('; ');
  const things = s.props.map((p) => `${p.name}${p.description ? ` (${p.description})` : ''}`).join(', ');
  // Fixed descriptions must reach the model whole: the look gives way first.
  const lookText = packs.length ? (s.look || '').slice(0, 1400) : s.look;
  const look = [lookText || 'A cinematic live-action film still', who && `Characters: ${who}.`, things && `Also in the scene: ${things}.`, 'Keep the layout, the camera and every figure\'s position and pose exactly as in the control image.'].filter(Boolean).join(' ');
  // Spoken lines are made with audio.voice and laid on the timeline: the video's own sound is the room, not the words.
  const known = packs.length ? s.cast.map((c, i) => (packs.some((p) => p.cast === i) ? `${c.name}: ${descOf(i)}` : '')).filter(Boolean).join('; ') : '';
  const action = [(packs.length ? (s.action || '').slice(0, 1400) : s.action) || 'The scene plays out with natural, continuous motion', known && `Characters: ${known}.`, s.lines.length ? 'People talk quietly; room tone and natural sound, no music.' : 'Cinematic camera, natural sound.'].filter(Boolean).join(' ');
  const si = s.lines[0]?.who ?? 0;
  const speaker = s.cast[si];
  const talk = `${speaker ? `${speaker.name}${descOf(si) ? `, ${descOf(si)},` : ''}` : 'The character'} speaks to someone just off camera, natural head and hand motion, subtle expressions, steady close-up. ${(packs.length ? (s.action || '').slice(0, 800) : s.action)}`.trim();
  return { look: look.slice(0, 3000), action: action.slice(0, 3000), talk: talk.slice(0, 2000), size: ASPECTS[s.aspect] };
}

/**
 * The first-frame job for a shot (src/identity-film.ts): the stage painted in the look, then each known character put
 * back on-model from their pack and the camera render. "$stage" and "$camera" are filled by the app after uploading.
 */
export function firstFrameFor(s: ShotDoc, packs: CastPack[], o: Partial<FirstFrameOptions> = {}) {
  const [width, height] = ASPECTS[s.aspect];
  const views = Object.fromEntries(s.cast.map((c, i) => [String(i), viewOf(s.camera.angle, c.facing)]));
  return firstFramePlan(packs, {
    look: o.look ?? filmPrompts(s, packs).look, keyframe: s.film.keyframe, keyframeNodes: s.film.keyframeNodes, width, height,
    camera: o.camera ?? s.cast.some((c) => c.asset), views, ...o,
  });
}

/**
 * The shot as Gen's Blender film pipeline (cinemaPass): blender.render's shot, its files (the cast's and props' models,
 * the sky) and the asset.make recipe. Every cast member needs a 3D model.
 */
export function blenderRecipe(s: ShotDoc, packs: CastPack[] = []) {
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
  const p = filmPrompts(s, packs);
  delete shot.camera.keys;
  // Their sheets go after the shot's own files: the best-of-3 keyframe is painted with them and picked against them.
  const sheets = [...packs].sort((a, b) => Number(Boolean(b.locked)) - Number(Boolean(a.locked))).map((x) => x.sheet ?? x.refs[0]).filter(Boolean).slice(0, 2) as string[];
  const refs = sheets.map((a) => { files.push(`asset:${a}`); return files.length - 1; });
  const canon = packs.filter((x) => x.description).map((x) => `${x.name}: ${x.description}`).join('\n') || undefined;
  const recipe = cinemaPass({ shot, look: p.look, motion: p.action, seconds: s.seconds, width, height, engine: s.film.engine, refs, canon });
  if (s.camera.keys?.length) recipe.notes.unshift('Blender films the camera move, not the camera keys: the keys are for "Film it".');
  return { recipe, files };
}
