// The world kinds' documents (docs/worlds.md): normalizing a world, place, prop and story, and continuity. Pure: no
// scene store, no jobs, so anything (src/worlds.ts, the making loop, finishing) can read world documents without loading
// the scene kinds. The kinds are registered in src/worldkinds.ts.

import crypto from 'node:crypto';
// A scene id as documents name it (src/scenes.ts SCENE_ID; kept here so this file imports no scene store).
const sceneRef = (v: unknown) => (typeof v === 'string' && /^(sn|ep|sh)_[0-9a-f]{6,24}$/.test(v) ? v : null);

const str = (v: unknown, max: number, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);
const asset = (v: unknown) => (typeof v === 'string' && /^a_[0-9a-f]{6,40}$/.test(v) ? v : null);
const job = (v: unknown) => (typeof v === 'string' && /^j_[0-9a-f]{6,40}$/.test(v) ? v : null);
const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []);
const words = (v: unknown, max: number, each: number) => list(v, max).map((x) => str(x, each).trim()).filter(Boolean);
const refs = (v: unknown, max: number) => [...new Set(list(v, max * 2).map(sceneRef).filter((x): x is string => Boolean(x)))].slice(0, max);
const idOf = (v: unknown, prefix: string, seen: Set<string>) => {
  const id = typeof v === 'string' && new RegExp(`^${prefix}_[\\w-]{3,24}$`).test(v) && !seen.has(v) ? v : `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
  seen.add(id);
  return id;
};
const keptRender = (r: any) => (r && asset(r.asset) && ['video', 'image', 'audio', 'mesh'].includes(r.kind)
  ? { asset: r.asset, kind: r.kind, version: Number(r.version) || 0, at: Number(r.at) || 0 } : null);

/** `from`: the output to take when its job makes several (an asset.make chain's saved step: src/scenekinds.ts resolveElements). */
export type El = { id: string; name?: string; asset?: string; pending?: string; failed?: string; gen?: number; from?: string };
/** An element that holds a file, or null when it holds nothing (no file, no job, no mark, no failure). */
function el(e: any, prefix: string, seen: Set<string>, named = false): El | null {
  if (!e || typeof e !== 'object') return typeof e === 'string' && asset(e) ? { id: idOf(null, prefix, seen), asset: e } : null;
  const out: El = { id: idOf(e.id, prefix, seen) };
  if (named || e.name) out.name = str(e.name, 60).trim() || undefined;
  if (asset(e.asset)) out.asset = asset(e.asset)!;
  if (job(e.pending)) out.pending = job(e.pending)!;
  if (e.failed) out.failed = String(e.failed).slice(0, 300);
  if (Number.isInteger(e.gen) && e.gen >= 0 && e.gen < 20) out.gen = e.gen;
  if ((out.pending || out.gen != null) && typeof e.from === 'string' && /^[\w.-]{1,40}$/.test(e.from)) out.from = e.from;
  if (!out.name) delete out.name;
  return out.asset || out.pending || out.failed || out.gen != null ? out : null;
}
const els = (v: unknown, prefix: string, seen: Set<string>, max: number, named = false) => list(v, max).map((e) => el(e, prefix, seen, named)).filter((e): e is El => Boolean(e));
const common = (d: any) => ({
  ...(sceneRef(d.world) ? { world: sceneRef(d.world)! } : {}),
  ...(keptRender(d.render) ? { render: keptRender(d.render) } : {}),
});

// ------------------------------------------------------------------ world
export type WorldDoc = {
  v: 1; title: string; logline: string; tone: string; rules: string[]; history: string;
  factions: { name: string; about: string }[];
  look: { style: string; negative: string; palette: string[]; board: string[]; grade: { lut?: string; params?: Record<string, number> } | null };
  /** The style board's pictures as elements (so the AI can make them); look.board is their files. */
  board: El[];
  members: string[]; notes: string; render?: any;
};
const GRADE_KEYS = ['contrast', 'saturation', 'warmth', 'tint', 'exposure', 'grain', 'vignette', 'fade'];

export function normalizeWorld(input: any): WorldDoc {
  const d = input && typeof input === 'object' ? input : {};
  const seen = new Set<string>();
  const L = d.look && typeof d.look === 'object' ? d.look : {};
  const board = els(d.board, 'b', seen, 12);
  // Asset ids in look.board that no element holds yet become elements (an API caller can set either).
  for (const a of list(L.board, 12).map(asset)) if (a && !board.some((b) => b.asset === a) && board.length < 12) board.push({ id: idOf(null, 'b', seen), asset: a });
  const g = L.grade && typeof L.grade === 'object' ? L.grade : null;
  const params = g?.params && typeof g.params === 'object'
    ? Object.fromEntries(GRADE_KEYS.filter((k) => Number.isFinite(Number(g.params[k]))).map((k) => [k, Math.max(-1, Math.min(1, Number(g.params[k])))])) : null;
  const grade = g && (asset(g.lut) || (params && Object.keys(params).length)) ? { ...(asset(g.lut) ? { lut: asset(g.lut)! } : {}), ...(params && Object.keys(params).length ? { params } : {}) } : null;
  return {
    v: 1, title: str(d.title, 80, 'Untitled world').trim() || 'Untitled world',
    logline: str(d.logline, 400), tone: str(d.tone, 300), rules: words(d.rules ?? d.canon, 40, 300), history: str(d.history, 6000),
    factions: list(d.factions, 20).filter((f: any) => f && typeof f.name === 'string' && f.name.trim()).map((f: any) => ({ name: f.name.trim().slice(0, 80), about: str(f.about, 600) })),
    look: {
      style: str(L.style, 400).trim(), negative: str(L.negative, 400).trim(),
      palette: list(L.palette, 8).filter((c: any) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).map((c: string) => c.toLowerCase()),
      board: board.filter((b) => b.asset).map((b) => b.asset!), grade,
    },
    board, members: refs(d.members, 200), notes: str(d.notes, 4000), ...common(d),
  };
}

// ------------------------------------------------------------------ place
export const PLACE_VARIANTS = ['time', 'weather'] as const;
export type PlaceDoc = {
  v: 1; title: string; description: string; panorama: El | null; views: El[]; set: El | null;
  variants: (El & { kind: typeof PLACE_VARIANTS[number] })[]; ambience: El | null; notes: string; world?: string; render?: any;
};
export function normalizePlace(input: any): PlaceDoc {
  const d = input && typeof input === 'object' ? input : {};
  const seen = new Set<string>();
  return {
    v: 1, title: str(d.title ?? d.name, 80, 'Unnamed place').trim() || 'Unnamed place', description: str(d.description, 1500),
    panorama: el(d.panorama, 'e', seen), views: els(d.views, 'e', seen, 12, true), set: el(d.set, 'e', seen),
    variants: list(d.variants, 16).map((v: any) => {
      const e = el(v, 'e', seen, true);
      return e && e.name ? { ...e, kind: (PLACE_VARIANTS as readonly string[]).includes(v.kind) ? v.kind : 'time' } : null;
    }).filter(Boolean) as PlaceDoc['variants'],
    ambience: el(d.ambience, 'e', seen), notes: str(d.notes, 4000), ...common(d),
  };
}

// ------------------------------------------------------------------ prop
export type PropDoc = { v: 1; title: string; description: string; sheet: El | null; views: El[]; model: El | null; owner: string | null; notes: string; world?: string; render?: any };
export function normalizeProp(input: any): PropDoc {
  const d = input && typeof input === 'object' ? input : {};
  const seen = new Set<string>();
  return {
    v: 1, title: str(d.title ?? d.name, 80, 'Unnamed prop').trim() || 'Unnamed prop', description: str(d.description, 1500),
    sheet: el(d.sheet, 'e', seen), views: els(d.views, 'e', seen, 8, true), model: el(d.model, 'e', seen),
    owner: sceneRef(d.owner), notes: str(d.notes, 4000), ...common(d),
  };
}

// ------------------------------------------------------------------ story, series, episode
export const STORY_LEVELS = ['story', 'series', 'episode'] as const;
/** What a continuity event changes: wears (replaces), injury / heal, holds / drops (a prop), at (a place), time (of day). */
export const CONTINUITY_KEYS = ['wears', 'injury', 'heal', 'holds', 'drops', 'at', 'time'] as const;
export type Line = { who: string | null; name: string; text: string; how?: string };
export type ScriptScene = { id: string; heading: string; place: string | null; time: string; action: string; lines: Line[] };
export type Shot = { id: string; scene: string | null; title: string; what: string; framing: string; place: string | null; cast: string[]; props: string[]; stage: string | null; state?: ContinuityState };
export type ContinuityEvent = { id: string; at: string; who: string | null; key: typeof CONTINUITY_KEYS[number]; value: string };
export type StoryDoc = {
  v: 1; title: string; level: typeof STORY_LEVELS[number]; parent: string | null; number: number | null;
  logline: string; beats: { id: string; text: string }[]; script: ScriptScene[]; shots: Shot[]; continuity: ContinuityEvent[];
  notes: string; world?: string; render?: any;
};

export function normalizeStory(input: any): StoryDoc {
  const d = input && typeof input === 'object' ? input : {};
  const seen = new Set<string>();
  const level = (STORY_LEVELS as readonly string[]).includes(d.level) ? d.level : 'story';
  const script: ScriptScene[] = list(d.script, 80).filter((s: any) => s && typeof s === 'object').map((s: any) => ({
    id: idOf(s.id, 'sc', seen), heading: str(s.heading, 160).trim(), place: sceneRef(s.place), time: str(s.time, 40).trim(), action: str(s.action, 3000),
    lines: list(s.lines, 120).filter((l: any) => l && typeof l.text === 'string' && l.text.trim()).map((l: any) => ({
      who: sceneRef(l.who), name: str(l.name, 60).trim(), text: l.text.trim().slice(0, 1000), ...(l.how ? { how: str(l.how, 120) } : {}),
    })),
  }));
  const sceneIds = new Set(script.map((s) => s.id));
  const shots: Shot[] = list(d.shots, 200).filter((s: any) => s && typeof s === 'object').map((s: any) => ({
    id: idOf(s.id, 'st', seen), scene: typeof s.scene === 'string' && sceneIds.has(s.scene) ? s.scene : null,
    title: str(s.title, 120).trim(), what: str(s.what, 1500), framing: str(s.framing, 120).trim(),
    place: sceneRef(s.place), cast: refs(s.cast, 12), props: refs(s.props, 12), stage: sceneRef(s.stage),
  }));
  const shotIds = new Set(shots.map((s) => s.id));
  const continuity: ContinuityEvent[] = list(d.continuity, 400).filter((e: any) => e && (CONTINUITY_KEYS as readonly string[]).includes(e.key) && shotIds.has(e.at)).map((e: any) => ({
    id: idOf(e.id, 'ce', seen), at: e.at, who: sceneRef(e.who), key: e.key, value: str(e.value, 200).trim(),
  }));
  const doc: StoryDoc = {
    v: 1, title: str(d.title, 120, 'Untitled story').trim() || 'Untitled story', level,
    parent: level === 'series' ? null : sceneRef(d.parent), number: level === 'episode' && Number.isInteger(Number(d.number)) && Number(d.number) > 0 ? Number(d.number) : null,
    logline: str(d.logline, 600), beats: list(d.beats, 60).map((b: any) => (typeof b === 'string' ? { text: b } : b)).filter((b: any) => b && typeof b.text === 'string' && b.text.trim()).map((b: any) => ({ id: idOf(b.id, 'bt', seen), text: b.text.trim().slice(0, 600) })),
    script, shots, continuity, notes: str(d.notes, 4000), ...common(d),
  };
  // Every shot carries the state of things at its moment (src/worlds.ts continuityAt), for whatever films or checks it.
  doc.shots.forEach((s, i) => { s.state = continuityAt(doc, i); });
  return doc;
}

export type ContinuityState = {
  /** Time of day, from the latest `time` event (else the script scene's time). */
  time: string | null;
  /** Per character id: what they wear, their injuries, the props they hold, where they are. */
  people: Record<string, { wears: string | null; injuries: string[]; holds: string[]; at: string | null }>;
  /** Per prop id: who holds it (a character id), or null when no one does. */
  props: Record<string, string | null>;
};

/** The state of things at a shot (by index), folded from every continuity event at or before it. */
export function continuityAt(story: Pick<StoryDoc, 'shots' | 'continuity' | 'script'>, shotIndex: number): ContinuityState {
  const order = new Map(story.shots.map((s, i) => [s.id, i]));
  const st: ContinuityState = { time: null, people: {}, props: {} };
  const person = (id: string) => (st.people[id] ??= { wears: null, injuries: [], holds: [], at: null });
  const events = story.continuity.filter((e) => (order.get(e.at) ?? Infinity) <= shotIndex)
    .sort((a, b) => order.get(a.at)! - order.get(b.at)!);
  for (const e of events) {
    if (e.key === 'time') { st.time = e.value || null; continue; }
    if (!e.who) continue;
    const p = person(e.who);
    if (e.key === 'wears') p.wears = e.value || null;
    else if (e.key === 'injury' && e.value && !p.injuries.includes(e.value)) p.injuries.push(e.value);
    else if (e.key === 'heal') p.injuries = p.injuries.filter((x) => x !== e.value);
    else if (e.key === 'at') p.at = e.value || null;
    else if (e.key === 'holds' && e.value) {
      // A prop is in one hand at a time: whoever held it lets go.
      for (const o of Object.values(st.people)) o.holds = o.holds.filter((x) => x !== e.value);
      p.holds.push(e.value);
      st.props[e.value] = e.who;
    } else if (e.key === 'drops') { p.holds = p.holds.filter((x) => x !== e.value); if (st.props[e.value] === e.who) st.props[e.value] = null; }
  }
  const shot = story.shots[shotIndex];
  if (!st.time && shot?.scene) st.time = story.script.find((s) => s.id === shot.scene)?.time || null;
  return st;
}

