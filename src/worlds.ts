// Worlds: the layer above scenes (docs/worlds.md, docs/worlds-roadmap.md Phase 3). A world scene holds the bible (tone,
// rules, canon), the look every output inherits, and its characters, places, props and stories. Any scene may name its
// world with `doc.world` (a scene id). The kinds are src/worldkinds.ts (their documents src/worlddocs.ts).
//
// This file is the contract other work reads through:
//   worldOf(doc)                    the world a scene belongs to
//   worldContext(project, worldId)  everything a job made inside that world inherits: the look, the canon, and each
//                                   character's, place's and prop's description and references
//   withWorld(...)                  a job's params and inputs with the world's look added (the style line on prompts, the
//                                   negative on negatives, the board as references where the tool takes them)
//   continuityAt(story, i)          the state of things at a story's shot (src/worldkinds.ts)
//   canonCheck(world, text)         the world's rules a script or a description breaks (Claude)
//
// Inheritance runs on every job (an asset.make chain's steps each): a job whose labels name the scene it came from (`scene`, `editor`, `director`) and whose
// scene has a world gets the look, unless its labels say `world: "off"` (the person turned it off under Fine-tune).

import { db } from './db.ts';
import { onSubmit, type JobSpec } from './jobs.ts';
import { getTool } from './tools/index.ts';
import { identityPack } from './identity.ts';
import { normalizeWorld, normalizePlace, normalizeProp, continuityAt, type WorldDoc } from './worlddocs.ts';
import { ask, callScope } from './providers/anthropic.ts';
import { orgOfProject, isHouseProject } from './orgsecrets.ts';

export { continuityAt };

export type WorldLook = {
  /** The style line every prompt in the world carries. */
  style: string;
  negative: string;
  palette: string[];
  /** Asset ids of the style board. */
  board: string[];
  /** One grade for every shot: a LUT asset, or simple params (contrast, saturation, warmth...). */
  grade: { lut?: string; params?: Record<string, number> } | null;
};

/** A character, place or prop as the world hands it to whatever draws it. */
export type WorldMember = { id: string; title: string; description: string; refs: string[] };

export type WorldContext = {
  worldId: string;
  title: string;
  look: WorldLook;
  /** Rules outputs and scripts must not break. */
  canon: string[];
  characters: WorldMember[];
  places: WorldMember[];
  props: WorldMember[];
};

/** The world a scene belongs to, from its document. */
export function worldOf(doc: unknown): string | null {
  const w = (doc as any)?.world;
  return typeof w === 'string' && /^[a-z]{2,4}_[\w-]{4,40}$/.test(w) ? w : null;
}

type Row = { id: string; project: string; kind: string; title: string; doc: string };
const row = (id: string) => db.prepare('SELECT id, project, kind, title, doc FROM scenes WHERE id = ?').get(id) as Row | undefined;
const parse = (r: Row) => { try { return JSON.parse(r.doc); } catch { return {}; } };
const files = (...xs: any[]) => [...new Set(xs.flat().map((e) => e?.asset).filter((a): a is string => typeof a === 'string'))];

/** A member as the world hands it on: its words and its references, best first. */
export function memberOf(kind: string, id: string, title: string, doc: any): WorldMember | null {
  if (kind === 'character') { const p = identityPack(doc); return { id, title, description: p.description, refs: p.refs }; }
  if (kind === 'place') { const d = normalizePlace(doc); return { id, title, description: d.description, refs: files(d.panorama, d.views, d.variants) }; }
  if (kind === 'prop') { const d = normalizeProp(doc); return { id, title, description: d.description, refs: files(d.sheet, d.views) }; }
  return null;
}

/** A world's members, by kind: the ones it lists, and every scene of the project that names it. */
export function worldMembers(project: string, worldId: string, listed: string[] = []) {
  const named = db.prepare(`SELECT id, project, kind, title, doc FROM scenes WHERE project = ? AND json_extract(doc, '$.world') = ? LIMIT 400`).all(project, worldId) as Row[];
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const r of [...listed.map(row), ...named]) if (r && r.project === project && r.id !== worldId && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
  return out;
}

/** Everything a job made inside a world inherits. Null when there's no world (or it isn't this project's). */
export function worldContext(project: string, worldId: string | null): WorldContext | null {
  if (!worldId) return null;
  const r = row(worldId);
  if (!r || r.project !== project || r.kind !== 'world') return null;
  const w = normalizeWorld(parse(r));
  const ctx: WorldContext = { worldId, title: w.title, look: w.look, canon: w.rules, characters: [], places: [], props: [] };
  for (const m of worldMembers(project, worldId, w.members)) {
    const mem = memberOf(m.kind, m.id, m.title, parse(m));
    if (mem) ({ character: ctx.characters, place: ctx.places, prop: ctx.props } as Record<string, WorldMember[]>)[m.kind]?.push(mem);
  }
  return ctx;
}

/** The world of a scene by id (the scene's own, or the scene itself when it's a world). */
export function worldOfScene(project: string, sceneId: unknown): string | null {
  if (typeof sceneId !== 'string') return null;
  const r = row(sceneId);
  if (!r || r.project !== project) return null;
  return r.kind === 'world' ? r.id : worldOf(parse(r));
}

/** Which tools draw pictures from words (the look applies to them; sound, 3D and plain edits are left alone). */
const LOOKS = /^(image|video)\./;

/**
 * A job's params and inputs with the world's look: the style line after the prompt, the negative after the negative,
 * the style board as references where the tool takes references and none were given. `labels.world` records it.
 * Unchanged (and no label) when the scene has no world or the tool draws nothing.
 */
export function withWorld(project: string, sceneDoc: unknown, tool: string, params: Record<string, any> = {}, inputs: Record<string, any> = {}) {
  return applyLook(project, worldOf(sceneDoc), tool, params, inputs);
}

/** withWorld for a world id. */
export function applyLook(project: string, worldId: string | null, tool: string, params: Record<string, any> = {}, inputs: Record<string, any> = {}) {
  const same = { params, inputs, labels: {} as Record<string, unknown> };
  const t = getTool(tool);
  if (!worldId || !t || !LOOKS.test(t.id)) return same;
  const r = row(worldId);
  if (!r || r.project !== project || r.kind !== 'world') return same;
  const look = normalizeWorld(parse(r)).look;
  const p = { ...params };
  const i = { ...inputs };
  const add = (v: unknown, extra: string) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return !extra || s.toLowerCase().includes(extra.toLowerCase()) ? s : s ? `${s.replace(/[.\s]+$/, '')}. ${extra}` : extra;
  };
  let changed = false;
  if ('prompt' in t.params && look.style && typeof p.prompt === 'string' && p.prompt.trim()) { p.prompt = add(p.prompt, look.style); changed = true; }
  if ('negative' in t.params && look.negative) { p.negative = add(p.negative, look.negative); changed = true; }
  const ref = t.inputs.references;
  if (ref?.multiple && look.board.length && (i.references == null || (Array.isArray(i.references) && !i.references.length))) {
    i.references = look.board.slice(0, ref.max ?? 2).map((a) => `asset:${a}`);
    changed = true;
  }
  return changed ? { params: p, inputs: i, labels: { world: worldId } as Record<string, unknown> } : same;
}

/** A job spec gets its scene's world's look (in place): the hook every submit runs (src/jobs.ts onSubmit). */
export function inheritWorld(project: string, spec: JobSpec) {
  const L = spec.labels ?? {};
  if (L.world === 'off' || !spec.tool) return;
  const worldId = typeof L.world === 'string' && L.world !== 'off' ? worldOfScene(project, L.world) : worldOfScene(project, L.scene ?? L.editor ?? L.director);
  if (!worldId) return;
  // A chain (asset.make): each step that draws gets the look on its own params and inputs. Its steps run as jobs
  // labelled only with their parent, so they aren't given it twice.
  const steps = (spec.params as any)?.steps;
  if (spec.tool === 'asset.make' && Array.isArray(steps)) {
    let any = false;
    const next = steps.map((st: any) => {
      if (!st || typeof st.tool !== 'string') return st;
      const r = applyLook(project, worldId, st.tool, st.params ?? {}, st.inputs ?? {});
      if (!r.labels.world) return st;
      any = true;
      return { ...st, params: r.params, ...(Object.keys(r.inputs).length ? { inputs: r.inputs } : {}) };
    });
    if (any) { spec.params = { ...spec.params, steps: next }; spec.labels = { ...L, world: worldId }; }
    return;
  }
  const r = applyLook(project, worldId, spec.tool, (spec.params ?? {}) as Record<string, any>, (spec.inputs ?? {}) as Record<string, any>);
  if (!r.labels.world) return;
  spec.params = r.params;
  spec.inputs = r.inputs;
  spec.labels = { ...L, world: worldId };
}
onSubmit(inheritWorld);

// ------------------------------------------------------------------ canon
export type CanonBreak = { rule: string; quote: string; why: string; fix: string };
type Ask = (p: { system: string; prompt: string; schema?: unknown; maxTokens?: number; effort?: string }) => Promise<{ text: string; cost?: number }>;

const CANON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['breaks'],
  properties: { breaks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['rule', 'quote', 'why', 'fix'], properties: { rule: { type: 'string' }, quote: { type: 'string' }, why: { type: 'string' }, fix: { type: 'string' } } } } },
};

/** Reads a canon answer (JSON, maybe fenced); only breaks of rules the world has are kept. */
export function parseCanon(text: string, rules: string[]): CanonBreak[] {
  let t = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  try {
    const j = JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t);
    const lower = rules.map((r) => r.toLowerCase());
    return (Array.isArray(j.breaks) ? j.breaks : []).filter((x: any) => x && typeof x.rule === 'string').map((x: any) => {
      const i = lower.findIndex((r) => r === x.rule.toLowerCase() || r.includes(x.rule.toLowerCase()) || x.rule.toLowerCase().includes(r));
      return i < 0 ? null : { rule: rules[i], quote: String(x.quote ?? '').slice(0, 400), why: String(x.why ?? '').slice(0, 400), fix: String(x.fix ?? '').slice(0, 400) };
    }).filter(Boolean).slice(0, 20) as CanonBreak[];
  } catch { return []; }
}

/**
 * The world's rules a script or a description breaks (Claude). `world` is a world document, a WorldContext, or
 * { rules } / { canon }. With no rules or no text there's nothing to check. `project` puts the call on that project's
 * own AI (as every customer call is); `ask` swaps the model call (tests).
 */
export async function canonCheck(world: Partial<WorldDoc> | Partial<WorldContext> | { rules?: string[]; canon?: string[] }, text: string, opts: { project?: string; ask?: Ask } = {}): Promise<{ ok: boolean; breaks: CanonBreak[]; cost: number }> {
  const rules = ((world as any)?.rules ?? (world as any)?.canon ?? []).filter((r: unknown) => typeof r === 'string' && r.trim());
  const body = String(text ?? '').trim();
  if (!rules.length || !body) return { ok: true, breaks: [], cost: 0 };
  const p = {
    system: 'You check writing against a fictional world\'s rules. List only clear breaks of the rules given: quote the words that break it, say why in one sentence, and give the smallest fix. Nothing that merely could be read as a break. Answer with JSON only: {"breaks": [{"rule": the rule exactly as given, "quote": "...", "why": "...", "fix": "..."}]}.',
    prompt: `The world's rules:\n${rules.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n')}\n\nThe writing to check:\n${body.slice(0, 30000)}`,
    schema: CANON_SCHEMA, maxTokens: 2000, effort: 'low',
  };
  const call = opts.ask ?? ((q: any) => (opts.project
    ? callScope.run({ customer: true, org: orgOfProject(opts.project), house: isHouseProject(opts.project) }, () => ask(q))
    : ask(q)));
  const r = await call(p);
  const breaks = parseCanon(r.text, rules);
  return { ok: !breaks.length, breaks, cost: Number(r.cost ?? 0) };
}
