// Learning from people (docs/make.md): every pick, discard, redo, rating and complaint is recorded against the recipe
// that made the thing (tool, params, intent, the checks' scores). A summarizer (daily, or on demand) groups what
// repeats and proposes craft notes for knowledge/tools.json (marked measured, with the evidence) and routing changes for
// knowledge/routing.json. Proposals wait in an owner-only list; nothing is applied until the owner approves it.
// Approved ones apply at once as an overlay (routing() and the craft notes read them), and `write` also puts them into
// the repo's files for a commit (local runs: a deployed copy's files are replaced on the next deploy).

import fs from 'node:fs';
import { db } from '../db.ts';
import { id as newId, GenError } from '../util.ts';
import { events } from '../bus.ts';
import { routingFile, type RoutingData } from './routing.ts';
import { ROOT } from '../config.ts';
import path from 'node:path';

db.exec(`CREATE TABLE IF NOT EXISTS make_feedback (
  id TEXT PRIMARY KEY, created INTEGER NOT NULL, project TEXT NOT NULL, client TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'api', asset TEXT, job TEXT,
  tool TEXT NOT NULL DEFAULT '', intent TEXT, params TEXT NOT NULL DEFAULT '{}', scores TEXT, rating INTEGER, note TEXT NOT NULL DEFAULT ''
)`);
db.exec('CREATE INDEX IF NOT EXISTS make_feedback_tool ON make_feedback (tool, created)');
db.exec(`CREATE TABLE IF NOT EXISTS make_proposals (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, kind TEXT NOT NULL, tool TEXT, intent TEXT,
  title TEXT NOT NULL, change TEXT NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', decided INTEGER, by TEXT
)`);
db.exec('CREATE TABLE IF NOT EXISTS make_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)');

export const FEEDBACK_KINDS = ['pick', 'discard', 'redo', 'rating', 'complaint'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type Feedback = {
  id: string; created: number; project: string; client: string; kind: FeedbackKind; source: string; asset: string | null; job: string | null;
  tool: string; intent: string | null; params: Record<string, any>; scores: Record<string, any> | null; rating: number | null; note: string;
};

const parse = (s: unknown, d: any = null) => {
  try { return s == null ? d : JSON.parse(String(s)); } catch { return d; }
};

/** The recipe behind an asset or a job: the tool and params that made it, the making loop's intent and scores. */
export function recipeOf(o: { asset?: string | null; job?: string | null }): { tool: string; params: Record<string, any>; intent: string | null; scores: Record<string, any> | null; job: string | null; project: string | null } | null {
  let a = o.asset ? db.prepare('SELECT id, job, tool, project, recipe, meta FROM assets WHERE id = ?').get(o.asset) as any : null;
  // make.checked's result is a copy: the take it came from has the real recipe.
  if (a?.tool === 'make.checked') {
    const from = parse(a.meta, {})?.from;
    const child = from ? db.prepare('SELECT id, job, tool, project, recipe, meta FROM assets WHERE id = ?').get(from) as any : null;
    if (child) a = child;
  }
  const jobId = a?.job ?? o.job ?? null;
  const j = jobId ? db.prepare('SELECT id, tool, project, params, labels FROM jobs WHERE id = ?').get(jobId) as any : null;
  if (!a && !j) return null;
  const recipe = parse(a?.recipe, null);
  const tool = String(recipe?.tool ?? a?.tool ?? j?.tool ?? '');
  const params = (recipe?.params ?? parse(j?.params, {})) as Record<string, any>;
  // A take of the making loop: the parent job says what was being made and how its take scored.
  const parentId = parse(j?.labels, {})?.parent;
  const parent = parentId ? db.prepare('SELECT tool, params, result FROM jobs WHERE id = ?').get(String(parentId)) as any : null;
  let intent: string | null = null;
  let scores: Record<string, any> | null = null;
  if (parent?.tool === 'make.checked') {
    intent = parse(parent.params, {})?.intent ?? null;
    const res = parse(parent.result, null);
    const take = (res?.takes ?? []).find((t: any) => t.asset === a?.id);
    if (take) scores = { score: take.score, pass: take.pass, stage: take.stage };
    if (res?.asset === a?.id && res?.report) scores = { ...(scores ?? {}), report: res.report };
  }
  return { tool, params, intent, scores, job: j?.id ?? null, project: a?.project ?? j?.project ?? null };
}

/** Files people brought (uploads, conversions): nothing was made, so nothing to learn. */
const UPLOAD_TOOLS = /^(file\.import|media\.)/;

/** Records one piece of feedback. `asset` or `job` says what it's about (its recipe is looked up), or give `tool`.
 *  Null for an upload (nothing was made). */
export function recordFeedback(f: { project?: string; client?: string; kind: string; source?: string; asset?: string | null; job?: string | null; tool?: string; intent?: string; params?: Record<string, any>; rating?: number; note?: string }): Feedback | null {
  if (!FEEDBACK_KINDS.includes(f.kind as FeedbackKind)) throw new GenError(`kind is one of ${FEEDBACK_KINDS.join(', ')}`);
  const asset = f.asset ? String(f.asset).replace(/^asset:/, '') : null;
  const rec = recipeOf({ asset, job: f.job ?? null });
  const tool = String(rec?.tool || f.tool || '');
  if (!tool) throw new GenError('Say what it is about: asset, job or tool');
  if (UPLOAD_TOOLS.test(tool)) return null;
  const rating = f.kind === 'rating' ? Math.max(1, Math.min(5, Math.round(Number(f.rating)))) : null;
  if (f.kind === 'rating' && !Number.isFinite(rating)) throw new GenError('rating is 1 to 5');
  const row: Feedback = {
    id: newId('fb', 6), created: Date.now(), project: String(f.project ?? rec?.project ?? ''), client: String(f.client ?? ''),
    kind: f.kind as FeedbackKind, source: String(f.source ?? 'api').slice(0, 40), asset, job: rec?.job ?? f.job ?? null,
    tool, intent: rec?.intent ?? f.intent ?? null, params: rec?.params ?? f.params ?? {}, scores: rec?.scores ?? null, rating, note: String(f.note ?? '').slice(0, 1000),
  };
  db.prepare(`INSERT INTO make_feedback (id, created, project, client, kind, source, asset, job, tool, intent, params, scores, rating, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.created, row.project, row.client, row.kind, row.source, row.asset, row.job, row.tool, row.intent, JSON.stringify(row.params), row.scores ? JSON.stringify(row.scores) : null, row.rating, row.note);
  return row;
}

const rowOf = (r: any): Feedback => ({ ...r, params: parse(r.params, {}), scores: parse(r.scores, null) });

export function listFeedback(o: { tool?: string; project?: string; since?: number; limit?: number } = {}): Feedback[] {
  const where: string[] = ['created >= ?'];
  const args: any[] = [o.since ?? 0];
  if (o.tool) { where.push('tool = ?'); args.push(o.tool); }
  if (o.project) { where.push('project = ?'); args.push(o.project); }
  return (db.prepare(`SELECT * FROM make_feedback WHERE ${where.join(' AND ')} ORDER BY created DESC LIMIT ?`).all(...args, Math.min(5000, o.limit ?? 500)) as any[]).map(rowOf);
}

// ------------------------------------------------------------------------------------------------ the summarizer

/** Feedback that says "not this": a discard, a redo, a complaint, a rating of 1 or 2. */
export const isNegative = (f: Pick<Feedback, 'kind' | 'rating'>) => f.kind === 'discard' || f.kind === 'redo' || f.kind === 'complaint' || (f.kind === 'rating' && (f.rating ?? 3) <= 2);
/** Feedback that says "yes, this": a pick, a rating of 4 or 5. */
export const isPositive = (f: Pick<Feedback, 'kind' | 'rating'>) => f.kind === 'pick' || (f.kind === 'rating' && (f.rating ?? 3) >= 4);
const counted = (f: Feedback) => isNegative(f) || isPositive(f);

export type Proposal = {
  id: string; key: string; created: number; kind: 'note' | 'routing'; tool: string | null; intent: string | null; title: string;
  change: any; evidence: any; status: 'open' | 'approved' | 'rejected'; decided: number | null; by: string | null;
};
type Draft = Omit<Proposal, 'id' | 'created' | 'status' | 'decided' | 'by'>;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const verb = (fs: Feedback[]) => {
  const k = new Set(fs.filter(isNegative).map((f) => f.kind));
  return k.size === 1 ? ({ discard: 'thrown away', redo: 'redone', complaint: 'complained about', rating: 'rated low' } as Record<string, string>)[[...k][0]] : 'redone or thrown away';
};

export const MIN_GROUP = 5;

/**
 * What repeats, as proposals (pure: the feedback in, the drafts out).
 *  - a numeric setting whose high (or low) values are rejected far more often than the rest: a craft note
 *  - the same complaint, said again and again after one tool: a craft note
 *  - two tools for one intent where the first choice is rejected far more often: a routing change
 */
export function summarize(rows: Feedback[], data?: RoutingData): Draft[] {
  const out: Draft[] = [];
  const byTool = new Map<string, Feedback[]>();
  for (const f of rows) if (counted(f)) byTool.set(f.tool, [...(byTool.get(f.tool) ?? []), f]);

  for (const [tool, fs] of byTool) {
    if (fs.length < MIN_GROUP) continue;
    // Numeric settings: try each value as a cut; keep the strongest split per param.
    const keys = new Set(fs.flatMap((f) => Object.entries(f.params).filter(([k, v]) => typeof v === 'number' && k !== 'seed' && k !== 'count').map(([k]) => k)));
    for (const k of keys) {
      const have = fs.filter((f) => typeof f.params[k] === 'number');
      const values = [...new Set(have.map((f) => f.params[k] as number))].sort((a, b) => a - b);
      let bestSplit: { dir: 'over' | 'under'; cut: number; rate: number; rest: number; n: number; bad: number; restN: number } | null = null;
      for (const cut of values) {
        for (const dir of ['over', 'under'] as const) {
          const side = have.filter((f) => (dir === 'over' ? (f.params[k] as number) > cut : (f.params[k] as number) < cut));
          const rest = have.filter((f) => !side.includes(f));
          if (side.length < MIN_GROUP || rest.length < 2) continue;
          const bad = side.filter(isNegative).length;
          const rate = bad / side.length;
          const restRate = rest.filter(isNegative).length / rest.length;
          if (rate >= 0.6 && rate - restRate >= 0.25 && (!bestSplit || rate - restRate > bestSplit.rate - bestSplit.rest)) bestSplit = { dir, cut, rate, rest: restRate, n: side.length, bad, restN: rest.length };
        }
      }
      if (!bestSplit) continue;
      const b = bestSplit;
      const side = have.filter((f) => (b.dir === 'over' ? (f.params[k] as number) > b.cut : (f.params[k] as number) < b.cut));
      const line = `${tool} with ${k} ${b.dir} ${b.cut} got ${verb(side)} ${pct(b.rate)} of the time (${b.bad} of ${b.n}), against ${pct(b.rest)} otherwise (${b.restN} takes).`;
      out.push({
        key: `note:${tool}:${k}:${b.dir}:${b.cut}`, kind: 'note', tool, intent: null, title: line,
        change: { tool, settings: { [k]: `Measured: keep ${k} ${b.dir === 'over' ? 'at or under' : 'at or over'} ${b.cut}. ${line}` }, iterate: [`Measured: ${line}`] },
        evidence: { param: k, dir: b.dir, cut: b.cut, rejected: b.bad, of: b.n, rate: b.rate, otherwise: b.rest, otherwiseN: b.restN, feedback: side.slice(0, 50).map((f) => f.id) },
      });
    }
    // The same complaint again and again.
    const said = new Map<string, Feedback[]>();
    for (const f of fs) {
      if (f.kind !== 'complaint' || !f.note.trim()) continue;
      const phrase = f.note.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
      if (phrase) said.set(phrase, [...(said.get(phrase) ?? []), f]);
    }
    for (const [phrase, list] of said) {
      if (list.length < 3) continue;
      const line = `People said "${phrase}" ${list.length} times after ${tool} (${pct(list.length / fs.length)} of its feedback).`;
      out.push({
        key: `note:${tool}:said:${phrase}`, kind: 'note', tool, intent: null, title: line,
        change: { tool, iterate: [`Measured: ${line}`] },
        evidence: { phrase, times: list.length, of: fs.length, feedback: list.slice(0, 50).map((f) => f.id), intents: [...new Set(list.map((f) => f.intent).filter(Boolean))] },
      });
    }
  }

  // Routing: per intent, a later tool that does clearly better than the one ahead of it.
  const byIntent = new Map<string, Feedback[]>();
  for (const f of rows) if (f.intent && counted(f)) byIntent.set(f.intent, [...(byIntent.get(f.intent) ?? []), f]);
  for (const [intent, fs] of byIntent) {
    const rules = data?.intents[intent] ?? [];
    for (const [ri, rule] of rules.entries()) {
      for (let i = 0; i + 1 < rule.tools.length; i++) {
        const a = rule.tools[i];
        for (const b of rule.tools.slice(i + 1)) {
          const fa = fs.filter((f) => f.tool === a);
          const fb = fs.filter((f) => f.tool === b);
          if (fa.length < MIN_GROUP || fb.length < MIN_GROUP) continue;
          const ra = fa.filter(isNegative).length / fa.length;
          const rb = fb.filter(isNegative).length / fb.length;
          if (ra - rb < 0.25) continue;
          const tools = [b, ...rule.tools.filter((t) => t !== b)];
          const line = `For ${intent}, ${a} got rejected ${pct(ra)} of the time (${fa.length} takes) and ${b} ${pct(rb)} (${fb.length}): try ${b} first.`;
          out.push({
            key: `routing:${intent}:${ri}:${tools.join(',')}`, kind: 'routing', tool: b, intent, title: line,
            change: { intent, rule: ri, tools, before: rule.tools },
            evidence: { [a]: { rejected: fa.filter(isNegative).length, of: fa.length, rate: ra }, [b]: { rejected: fb.filter(isNegative).length, of: fb.length, rate: rb } },
          });
        }
      }
    }
  }
  return out;
}

const proposalOf = (r: any): Proposal => ({ ...r, change: parse(r.change, {}), evidence: parse(r.evidence, {}) });

/** Runs the summarizer over the last `days` of feedback and files new proposals (one per key, ever: a rejected one isn't proposed again). */
export function runSummary(o: { days?: number; data?: RoutingData } = {}): { proposed: Proposal[]; looked: number } {
  const rows = listFeedback({ since: Date.now() - (o.days ?? 60) * 86400_000, limit: 5000 });
  const drafts = summarize(rows, o.data ?? rawRouting());
  const proposed: Proposal[] = [];
  for (const d of drafts) {
    const exists = db.prepare('SELECT id FROM make_proposals WHERE key = ?').get(d.key);
    if (exists) continue;
    const p: Proposal = { ...d, id: newId('mp', 6), created: Date.now(), status: 'open', decided: null, by: null };
    db.prepare('INSERT INTO make_proposals (id, key, created, kind, tool, intent, title, change, evidence, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, p.key, p.created, p.kind, p.tool, p.intent, p.title, JSON.stringify(p.change), JSON.stringify(p.evidence), 'open');
    proposed.push(p);
  }
  db.prepare('INSERT INTO make_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('lastSummary', String(Date.now()));
  return { proposed, looked: rows.length };
}

export function listProposals(status?: string): Proposal[] {
  const rows = status
    ? db.prepare('SELECT * FROM make_proposals WHERE status = ? ORDER BY created DESC LIMIT 200').all(status)
    : db.prepare('SELECT * FROM make_proposals ORDER BY created DESC LIMIT 200').all();
  return (rows as any[]).map(proposalOf);
}

/** The owner's decision. Approving applies it (as an overlay; `write` also edits the repo's knowledge files). */
export function decideProposal(id: string, o: { approve: boolean; by?: string; write?: boolean }): Proposal {
  const r = db.prepare('SELECT * FROM make_proposals WHERE id = ?').get(id);
  if (!r) throw new GenError('No such proposal', { status: 404 });
  const p = proposalOf(r);
  if (p.status !== 'open') throw new GenError(`That proposal is already ${p.status}`, { status: 409 });
  db.prepare('UPDATE make_proposals SET status = ?, decided = ?, by = ? WHERE id = ?').run(o.approve ? 'approved' : 'rejected', Date.now(), o.by ?? null, id);
  overlayCache = null;
  if (o.approve && o.write) writeToRepo(p);
  return proposalOf(db.prepare('SELECT * FROM make_proposals WHERE id = ?').get(id));
}

// ------------------------------------------------------------------------------------------------ approved changes

let overlayCache: { notes: Record<string, any>; routing: { intent: string; rule: number; tools: string[] }[] } | null = null;
function overlay() {
  if (!overlayCache) {
    const approved = listProposals('approved').reverse(); // oldest first, so a later approval wins
    const notes: Record<string, any> = {};
    const routing: { intent: string; rule: number; tools: string[] }[] = [];
    for (const p of approved) {
      if (p.kind === 'note' && p.tool) {
        const n = (notes[p.tool] ??= { settings: {}, iterate: [] });
        Object.assign(n.settings, p.change.settings ?? {});
        n.iterate.push(...(p.change.iterate ?? []));
      } else if (p.kind === 'routing') routing.push({ intent: p.change.intent, rule: Number(p.change.rule), tools: p.change.tools });
    }
    overlayCache = { notes, routing };
  }
  return overlayCache;
}

/** Craft notes with the approved measured ones merged in (src/knowledge.ts notes()). */
export function withMeasured<T extends Record<string, any>>(base: Record<string, T>): Record<string, T> {
  let o: ReturnType<typeof overlay>;
  try { o = overlay(); } catch { return base; }
  if (!Object.keys(o.notes).length) return base;
  const out: Record<string, any> = { ...base };
  for (const [tool, n] of Object.entries(o.notes)) {
    const cur = out[tool] ?? {};
    out[tool] = { ...cur, settings: { ...(cur.settings ?? {}), ...n.settings }, iterate: [...new Set([...(cur.iterate ?? []), ...n.iterate])], measured: true };
  }
  return out;
}

/** Routing data with the approved routing changes applied (src/make/routing.ts routing()). */
export function withApprovedRouting(d: RoutingData): RoutingData {
  let o: ReturnType<typeof overlay>;
  try { o = overlay(); } catch { return d; }
  if (!o.routing.length) return d;
  const intents = { ...d.intents };
  for (const c of o.routing) {
    const rules = intents[c.intent];
    if (!rules?.[c.rule] || !c.tools.every((t) => d.tools[t])) continue;
    intents[c.intent] = rules.map((r, i) => (i === c.rule ? { ...r, tools: c.tools, why: `${r.why ?? ''} (measured order)`.trim() } : r));
  }
  return { ...d, intents };
}

function rawRouting(): RoutingData {
  const raw = JSON.parse(fs.readFileSync(routingFile(), 'utf8'));
  delete raw._about;
  return raw;
}

/** Replaces one top-level entry of a JSON file's text, keeping the rest of the file exactly as it is. */
export function replaceEntry(text: string, key: string, value: unknown, indent = '  '): string {
  const at = text.indexOf(`${JSON.stringify(key)}:`);
  const body = JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
  if (at < 0) {
    const end = text.lastIndexOf('}');
    return `${text.slice(0, end).replace(/\s*$/, '')},\n${indent}${JSON.stringify(key)}: ${body}\n${text.slice(end)}`;
  }
  let i = text.indexOf('{', at);
  const open = text.indexOf('[', at);
  if (open >= 0 && (i < 0 || open < i)) i = open;
  let depth = 0;
  let inStr = false;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (ch === '\\') k++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (!depth) return `${text.slice(0, at)}${JSON.stringify(key)}: ${body}${text.slice(k + 1)}`;
    }
  }
  throw new Error(`could not find the end of ${key}`);
}

function writeToRepo(p: Proposal) {
  if (p.kind === 'note' && p.tool) {
    const file = path.join(ROOT, 'knowledge', 'tools.json');
    const text = fs.readFileSync(file, 'utf8');
    const cur = JSON.parse(text)[p.tool] ?? {};
    const next = { ...cur, settings: { ...(cur.settings ?? {}), ...(p.change.settings ?? {}) }, iterate: [...new Set([...(cur.iterate ?? []), ...(p.change.iterate ?? [])])], measured: true };
    fs.writeFileSync(file, replaceEntry(text, p.tool, next));
  } else if (p.kind === 'routing') {
    const file = routingFile();
    const text = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    const rules = data.intents?.[p.change.intent];
    if (!rules?.[p.change.rule]) return;
    rules[p.change.rule] = { ...rules[p.change.rule], tools: p.change.tools };
    // The intents block is nested: rewrite that one intent's rules in place.
    const start = text.indexOf('"intents"');
    const head = text.slice(0, start);
    const tail = replaceEntry(text.slice(start).replace(/^"intents":\s*\{/, '{'), p.change.intent, rules, '    ');
    fs.writeFileSync(file, `${head}"intents": ${tail}`);
  }
}

// ------------------------------------------------------------------------------------------------ the daily run, library picks

let started = false;
/** Daily summary and the library's picks and discards as feedback (src/server.ts starts it). */
export function startMakeLearning() {
  if (started) return;
  started = true;
  events.on('library', (e: any) => {
    if (e?.type !== 'version' || !e.version || !['current', 'discarded'].includes(e.status)) return;
    try {
      const v = db.prepare('SELECT asset, job FROM versions WHERE id = ?').get(e.version) as { asset: string; job: string | null } | undefined;
      if (v) recordFeedback({ kind: e.status === 'current' ? 'pick' : 'discard', asset: v.asset, job: v.job, source: 'library', note: `${e.entity} ${e.slot ?? ''}`.trim() });
    } catch { /* an upload with no recipe: nothing to learn */ }
  });
  const tick = () => {
    try {
      const last = Number((db.prepare("SELECT v FROM make_state WHERE k = 'lastSummary'").get() as any)?.v ?? 0);
      if (Date.now() - last > 86400_000) runSummary();
    } catch (err: any) {
      console.warn(`[make] summary: ${err.message}`);
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 3 * 3600_000).unref();
}
