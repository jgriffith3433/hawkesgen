// Productions on the server (docs/showrunner.md): an approved plan runs as a state machine of steps, each a job or a
// scene write, kept in the `productions` table after every change. Nothing lives only in memory, so a restart picks up
// where it was (the jobs themselves resume in src/jobs.ts), and the page can close: progress goes out on /v1/events
// (event "production") and the last one says it's done.
//
//   proposed  the card is waiting (Approve, Change, Not now)
//   running   steps start as soon as what they wait for is done; a failed job is tried once more
//   paused    nothing new starts (running jobs finish)
//   done      the cut is made and checked (shots that failed are left out and named)
//   failed    nothing could be filmed
//   cancelled running jobs cancelled (src/jobs.ts refunds them by its rules); steps not started are never charged
//   dismissed "Not now" on the card
//
// After the cut, the review step looks at each shot with `assess` (src/quality) and re-takes the ones that fail, within
// the fix allowance the card showed, then cuts them in.

import crypto from 'node:crypto';
import { db } from '../db.ts';
import { events } from '../bus.ts';
import { GenError } from '../util.ts';
import type { Client } from '../auth.ts';
import { createScene, getScene, saveScene, setRender, kindOf } from '../scenes.ts';
import { newDoc, applyOps } from '../editor.ts';
import '../scenekinds.ts';
import { createShot, createSequence, normalizeShot } from '../director.ts';
import { deps, type JobLike } from './deps.ts';
import { compileSteps, toolFor, MAKE_TOOL, type Step } from './steps.ts';
import { lineSeconds, type Plan } from './plan.ts';
import { learn } from './memory.ts';
import type { Card } from './steps.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS productions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  client TEXT NOT NULL,
  payer TEXT,
  parent TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  plan TEXT NOT NULL,
  steps TEXT NOT NULL,
  card TEXT NOT NULL,
  out TEXT NOT NULL,
  budget INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS productions_project ON productions (project, updated DESC);
CREATE INDEX IF NOT EXISTS productions_status ON productions (status);
`);

export type Status = 'proposed' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'dismissed';
/** What the production made: scene ids by plan key, the cut, and which cut clip plays which shot. */
export type Out = {
  world: string | null; characters: Record<string, string>; places: Record<string, string>; story: string | null; storyDoc?: any;
  sequence: string | null; shots: Record<string, string>; cut: string | null; clips: Record<string, string>;
  /** Review mode's fix: the clip it replaces, the take before and the new one. */
  fix?: { scene: string; clip: string; before: string | null; after: string | null; shot: string; kept?: boolean | null };
  /** What the review step found per shot. */
  reviewed?: Record<string, { pass: boolean; fix?: string; retaken?: boolean }>;
  /** The page is open and may film action shots on its stage until this time. */
  browserUntil?: number;
  notes: string[];
};
export type Production = {
  id: string; project: string; client: Client; payer: string | null; parent: string | null; kind: string; title: string; status: Status;
  plan: Plan; steps: Step[]; card: Card; out: Out; budget: number; note: string | null; error: string | null; created: number; updated: number;
};

const J = (v: unknown) => JSON.stringify(v);
const fromRow = (r: any): Production => ({ ...r, client: JSON.parse(r.client), plan: JSON.parse(r.plan), steps: JSON.parse(r.steps), card: JSON.parse(r.card), out: JSON.parse(r.out) });
const blankOut = (): Out => ({ world: null, characters: {}, places: {}, story: null, sequence: null, shots: {}, cut: null, clips: {}, notes: [] });
export const hasKind = (kind: string) => { try { kindOf(kind); return true; } catch { return false; } };

export function createProduction(a: { project: string; client: Client; payer: string | null; plan: Plan; steps: Step[]; card: Card; kind?: string; parent?: string | null; out?: Partial<Out>; note?: string | null }): Production {
  const id = `pr_${crypto.randomBytes(6).toString('hex')}`;
  const now = deps().now();
  const client: Client = { id: a.client.id, name: a.client.name, role: a.client.role, projects: a.client.projects, ...((a.client as any).userId ? { userId: (a.client as any).userId } : {}) } as Client;
  db.prepare(`INSERT INTO productions (id, project, client, payer, parent, kind, title, status, plan, steps, card, out, budget, note, error, created, updated)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
    .run(id, a.project, J(client), a.payer, a.parent ?? null, a.kind ?? a.plan.kind, a.plan.title, J(a.plan), J(a.steps), J(a.card), J({ ...blankOut(), ...a.out }), Math.ceil(a.card.credits + (a.card.fixCredits ?? 0)), a.note ?? null, now, now);
  return getProduction(id)!;
}

export function getProduction(id: string, project?: string | ((p: string) => boolean)): Production | null {
  const r = db.prepare('SELECT * FROM productions WHERE id = ?').get(id);
  if (!r) return null;
  const p = fromRow(r);
  if (typeof project === 'string' && p.project !== project) return null;
  if (typeof project === 'function' && !project(p.project)) return null;
  return p;
}
export const listProductions = (project: string, limit = 30): Production[] =>
  (db.prepare("SELECT * FROM productions WHERE project = ? AND status != 'dismissed' ORDER BY updated DESC LIMIT ?").all(project, limit) as any[]).map(fromRow);
/** The production that made a cut scene (review mode finds the shot behind a moment through it). */
export const productionForCut = (scene: string): Production | null => {
  const r = db.prepare("SELECT * FROM productions WHERE json_extract(out, '$.cut') = ? AND parent IS NULL ORDER BY updated DESC LIMIT 1").get(scene);
  return r ? fromRow(r) : null;
};

function save(p: Production, fields: (keyof Production)[] = ['status', 'steps', 'out', 'error', 'note']) {
  p.updated = deps().now();
  const cols = [...new Set([...fields, 'updated' as const])];
  db.prepare(`UPDATE productions SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`)
    .run({ id: p.id, ...Object.fromEntries(cols.map((c) => [c, ['plan', 'steps', 'card', 'out', 'client'].includes(c) ? J((p as any)[c]) : (p as any)[c]])) });
  return p;
}

/** Progress as the app shows it. */
export function progress(p: Production) {
  const counted = p.steps.filter((s) => s.make || s.write === 'cut');
  const done = counted.filter((s) => s.status === 'done' || s.status === 'skipped' || s.status === 'failed').length;
  const now = p.steps.find((s) => s.status === 'running');
  return { done, total: counted.length, step: now?.label ?? null, failed: p.steps.filter((s) => s.status === 'failed').map((s) => s.label) };
}
/** A production as the app gets it: no client, the card, progress. */
export const publicProduction = (p: Production) => ({
  id: p.id, kind: p.kind, title: p.title, status: p.status, parent: p.parent, card: p.card, out: p.out, progress: progress(p), note: p.note, error: p.error,
  plan: p.plan, steps: p.steps.map((s) => ({ id: s.id, label: s.label, status: s.status, credits: s.credits, asset: s.asset ?? null, error: s.error ?? null, shot: s.shot ?? null })),
  created: p.created, updated: p.updated,
});
function emit(p: Production, notice?: string) {
  events.emit('production', { id: p.id, project: p.project, title: p.title, status: p.status, parent: p.parent, progress: progress(p), out: { cut: p.out.cut, fix: p.out.fix ?? null }, ...(notice ? { notice } : {}) });
}

// ------------------------------------------------------------------ the person's buttons
export function approve(p: Production, o: { credits?: number | null } = {}): Production {
  if (p.status !== 'proposed') throw new GenError(`This production is ${p.status}`, { status: 409 });
  if (o.credits != null && o.credits < p.card.credits) throw new GenError(`This needs ${p.card.credits} credits and you have ${o.credits}. Add credits to make it.`, { status: 402, kind: 'credits' });
  p.status = 'running';
  save(p);
  learn(p.project, { kind: 'approved', style: p.plan.world?.style ?? null, characters: p.plan.characters.map((c) => ({ name: c.name, id: c.id ?? p.out.characters[c.key] ?? null })) });
  emit(p);
  return p;
}
export function dismiss(p: Production) { if (p.status === 'proposed') { p.status = 'dismissed'; save(p); emit(p); } return p; }
export function pause(p: Production) { if (p.status === 'running') { p.status = 'paused'; save(p); emit(p); } return p; }
export function resume(p: Production) { if (p.status === 'paused') { p.status = 'running'; save(p); emit(p); } return p; }
/** Cancels: running jobs are cancelled (refunded by src/jobs.ts), steps not started are never charged. */
export function cancelProduction(p: Production): { production: Production; uncharged: number } {
  if (!['running', 'paused', 'proposed'].includes(p.status)) return { production: p, uncharged: 0 };
  let uncharged = 0;
  for (const s of p.steps) {
    if (s.status === 'running' && s.job) deps().cancel(s.job);
    if (s.status === 'waiting') uncharged += s.credits;
    if (s.status === 'waiting' || s.status === 'running') s.status = 'skipped';
  }
  p.status = 'cancelled';
  save(p);
  emit(p, 'Stopped.');
  return { production: p, uncharged };
}
/** The page is open with a stage: it may film the production's action shots there for a while (else the server does). */
export function seenBrowser(p: Production, seconds = 120) { p.out.browserUntil = deps().now() + seconds * 1000; save(p, ['out']); return p; }
/** The page takes a shot to film on its stage. */
export function claimShot(p: Production, stepId: string) {
  const s = p.steps.find((x) => x.id === stepId);
  if (!s?.browser || s.status !== 'waiting' || s.claimed) throw new GenError('That shot is not waiting for the stage', { status: 409 });
  s.claimed = deps().now();
  s.status = 'running';
  save(p, ['steps']);
  return s;
}
/** The page filmed it: its file is the shot. */
export function finishClaim(p: Production, stepId: string, asset: string) {
  const s = p.steps.find((x) => x.id === stepId);
  if (!s?.claimed || s.status !== 'running') throw new GenError('That shot was not taken by the stage', { status: 409 });
  if (!/^a_[0-9a-f]{6,40}$/.test(asset) || !deps().assetPath(asset)) throw new GenError('No such file', { status: 404 });
  s.asset = asset;
  s.status = 'done';
  onMade(p, s);
  save(p);
  return s;
}

// ------------------------------------------------------------------ the state machine
const busy = new Set<string>();
const CLAIM_MS = 15 * 60_000;

const refOf = (p: Production, v: unknown): unknown => {
  if (Array.isArray(v)) return v.map((x) => refOf(p, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, refOf(p, x)]));
  if (typeof v === 'string' && v.startsWith('$step:')) {
    const s = p.steps.find((x) => x.id === v.slice(6));
    if (!s?.asset) throw new GenError(`${v} has no file`);
    return `asset:${s.asset}`;
  }
  return v;
};
/** A finished job's file: make.checked reports its best take; other tools, the first output of the right kind. */
function fileOf(step: Step, j: JobLike): string | null {
  const want = step.makes === 'clip' ? 'video' : step.makes === 'voice' || step.makes === 'music' ? 'audio' : 'image';
  const r = (j as any).result;
  if (r && typeof r.asset === 'string') return r.asset;
  return (j.outputs.find((o) => o.kind === want) ?? j.outputs[0])?.asset ?? null;
}

function submitStep(p: Production, s: Step) {
  const make = { ...s.make!, inputs: refOf(p, s.make!.inputs ?? {}) as Record<string, any>, ...(s.make!.refs ? { refs: { identity: (s.make!.refs.identity ?? []).map((r) => String(refOf(p, r)).replace(/^asset:/, '')) } } : {}) };
  const t = toolFor({ ...s, make }, deps().hasTool);
  const job = deps().submit(p.client, { project: p.project, tool: t.tool, params: t.params, inputs: t.inputs, labels: { by: 'showrunner', production: p.id, step: s.id, title: s.label } });
  s.job = job.id;
  s.tool = t.tool;
  s.status = 'running';
  s.tries++;
}

/** One pass: finished jobs collected, ready steps started, the production finished when nothing is left. */
export async function advance(id: string): Promise<Production | null> {
  if (busy.has(id)) return getProduction(id);
  busy.add(id);
  try {
    const p = getProduction(id);
    if (!p || (p.status !== 'running' && p.status !== 'paused')) return p;
    let changed = false;
    const d = deps();
    for (const s of p.steps) {
      if (s.status !== 'running') continue;
      if (s.claimed && !s.job) {
        // The stage took it and never brought it back: the server films it.
        if (d.now() - s.claimed > CLAIM_MS) { s.claimed = null; s.browser = false; s.status = 'waiting'; changed = true; }
        continue;
      }
      const j = s.job ? d.job(s.job) : null;
      if (!j || j.status === 'queued' || j.status === 'running') continue;
      changed = true;
      if (j.status === 'done' && fileOf(s, j)) {
        s.asset = fileOf(s, j);
        s.status = 'done';
        s.error = null;
        onMade(p, s);
      } else if (s.tries < 2 && p.status === 'running') {
        s.error = j.error ?? j.status;
        submitStep(p, s);
      } else {
        s.status = 'failed';
        s.error = j.error ?? (j.status === 'done' ? 'Nothing was made' : j.status);
        p.out.notes.push(`${s.label}: ${s.error}`);
      }
    }
    if (p.status === 'running') {
      for (const s of p.steps) {
        if (s.status !== 'waiting') continue;
        const before = s.after.map((a) => p.steps.find((x) => x.id === a));
        if (before.some((b) => b && (b.status === 'waiting' || b.status === 'running'))) continue;
        const aggregate = s.write === 'cut' || s.write === 'review';
        if (!aggregate && before.some((b) => b && (b.status === 'failed' || b.status === 'skipped'))) { s.status = 'skipped'; changed = true; continue; }
        if (s.browser && !s.claimed && (p.out.browserUntil ?? 0) > d.now()) continue;
        changed = true;
        try {
          if (s.write) { await write(p, s); s.status = 'done'; } else submitStep(p, s);
        } catch (e: any) {
          s.status = 'failed';
          s.error = String(e?.message ?? e).slice(0, 300);
          p.out.notes.push(`${s.label}: ${s.error}`);
        }
      }
      if (p.steps.every((s) => s.status !== 'waiting' && s.status !== 'running')) {
        const cut = p.steps.find((s) => s.write === 'cut');
        const made = p.steps.some((s) => s.status === 'done' && (s.make || s.write));
        p.status = (cut ? cut.status === 'done' && p.out.cut : made) ? 'done' : 'failed';
        if (p.status === 'failed') p.error = p.out.notes[0] ?? 'Nothing could be made';
        save(p);
        emit(p, p.status === 'done' ? (p.parent ? 'The new take is ready.' : `"${p.title}" is ready.`) : `"${p.title}" couldn't be finished.`);
        return p;
      }
    }
    if (changed) { save(p); emit(p); }
    return p;
  } finally {
    busy.delete(id);
  }
}

/** Advances every running production (after a restart, on a job event, and on the timer). */
export async function advanceAll() {
  const ids = (db.prepare("SELECT id FROM productions WHERE status IN ('running', 'paused')").all() as { id: string }[]).map((r) => r.id);
  for (const id of ids) { try { await advance(id); } catch (e: any) { console.warn(`[showrunner] ${id}: ${e?.message ?? e}`); } }
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Starts following: job events move productions on at once; a slow timer catches anything missed. */
export function startRunner() {
  if (timer) return;
  events.on('job', (j: any) => { const pid = j?.labels?.production; if (pid && (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')) void advance(String(pid)).catch(() => {}); });
  timer = setInterval(() => void advanceAll(), 15_000);
  timer.unref?.();
  setTimeout(() => void advanceAll(), 2000).unref?.();
}

// ------------------------------------------------------------------ what a finished step does
function onMade(p: Production, s: Step) {
  const can = (x: string) => x === p.project;
  try {
    if (s.id.startsWith('look:') && s.key && p.out.characters[s.key]) {
      const c = getScene(p.out.characters[s.key], can);
      saveScene(c, { ...c.doc, pictures: [...(c.doc.pictures ?? []), { role: 'front', asset: s.asset }] });
    }
    if (s.id.startsWith('view:') && s.key && p.out.places[s.key]) {
      const pl = getScene(p.out.places[s.key], can);
      saveScene(pl, { ...pl.doc, pictures: [...(Array.isArray(pl.doc.pictures) ? pl.doc.pictures : []), { role: 'view', asset: s.asset }], views: [...(Array.isArray(pl.doc.views) ? pl.doc.views : []), { asset: s.asset }] });
    }
    if (!p.parent && (s.id.startsWith('shot:') || s.id.startsWith('retake:')) && s.shot && p.out.shots[s.shot] && s.asset) setRender(getScene(p.out.shots[s.shot], can), { asset: s.asset, kind: 'video' });
  } catch (e: any) {
    p.out.notes.push(`${s.label}: filed, but ${e?.message ?? e}`);
  }
}

async function write(p: Production, s: Step) {
  const plan = p.plan;
  const style = plan.world?.style ?? '';
  const worldId = p.out.world ?? plan.world?.id ?? null;
  switch (s.write) {
    case 'world': {
      const w = plan.world!;
      const doc = { title: w.title, tone: w.tone, look: { style: w.style, negative: w.negative, palette: w.palette, board: [], grade: null }, canon: w.canon, rules: w.canon };
      // The world kind is gen-worlds' (src/worldkinds.ts); without it the world stays in this record.
      p.out.world = hasKind('world') ? createScene(p.project, 'world' as any, doc).id : null;
      if (!p.out.world) p.out.notes.push('Worlds are not on this Gen yet: the world is kept with the production.');
      return;
    }
    case 'character': {
      const c = plan.characters.find((x) => x.key === s.key)!;
      p.out.characters[c.key] = createScene(p.project, 'character', { title: c.name, description: c.description, voice: c.voice, notes: c.role, ...(worldId ? { world: worldId } : {}) }).id;
      return;
    }
    case 'place': {
      const x = plan.places.find((y) => y.key === s.key)!;
      if (hasKind('place')) p.out.places[x.key] = createScene(p.project, 'place' as any, { title: x.name, description: x.description, ...(worldId ? { world: worldId } : {}) }).id;
      return;
    }
    case 'story': {
      const doc = { title: plan.title, level: plan.kind === 'show' ? 'episode' : plan.kind === 'trailer' ? 'trailer' : 'short', logline: plan.logline, beats: plan.beats, script: plan.script, shots: plan.shots, ...(worldId ? { world: worldId } : {}) };
      // The story kind is gen-worlds'; without it the story (its doc shape) is kept here and filed once the kind lands.
      if (hasKind('story')) p.out.story = createScene(p.project, 'story' as any, doc).id;
      else p.out.storyDoc = doc;
      return;
    }
    case 'shots': {
      p.out.sequence = createSequence(p.project, plan.title);
      plan.shots.forEach((x, i) => {
        const cast = x.cast.map((k) => plan.characters.find((c) => c.key === k)!).filter(Boolean);
        let at = 0.3;
        const lines = x.lines.map((l) => { const line = { who: Math.max(0, x.cast.indexOf(l.who)), text: l.text, at: Math.round(at * 10) / 10 }; at += lineSeconds(l.text); return line; });
        const doc = normalizeShot({
          title: `${plan.title}: ${x.key}`, seconds: x.seconds, aspect: plan.aspect, look: style, action: x.action, kind: x.type === 'dialogue' ? 'talk' : 'action', lines,
          sequence: p.out.sequence, order: i,
          cast: cast.map((c, j) => ({ name: c.name, description: c.description, character: c.id ?? p.out.characters[c.key] ?? null, voice: c.voice, position: [j * 1.2 - (cast.length - 1) * 0.6, 0], facing: 0 })),
          camera: { move: x.move, angle: x.angle, distance: x.framing === 'wide' ? 9 : x.framing === 'close' ? 2.5 : 5 },
          ...(worldId ? { world: worldId } : {}),
        });
        p.out.shots[x.key] = createShot(p.project, doc).id;
      });
      return;
    }
    case 'cut': return cut(p, s);
    case 'review': return review(p);
  }
}

const FRAME: Record<Plan['aspect'], [number, number]> = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [1080, 1080] };

/** The cut: a video scene with the shots in order, each line on Voice at its moment, the score on Music. A recut swaps retaken shots in. */
function cut(p: Production, s: Step) {
  const plan = p.plan;
  const take = (key: string) => {
    const retake = p.steps.filter((x) => x.id.startsWith(`retake:${key}`) && x.status === 'done').pop();
    return retake?.asset ?? p.steps.find((x) => x.id === `shot:${key}`)?.asset ?? null;
  };
  if (s.key === 'recut' && p.out.cut) {
    const sc = getScene(p.out.cut, (x) => x === p.project);
    const doc = sc.doc;
    for (const [clip, key] of Object.entries(p.out.clips)) {
      const c = doc.clips.find((x: any) => x.id === clip);
      const a = take(key);
      if (c && a) c.asset = a;
    }
    saveScene(sc, doc);
    return;
  }
  const [width, height] = FRAME[plan.aspect];
  const ops: any[] = [{ op: 'settings', width, height, title: plan.title }];
  const keys: (string | null)[] = [null];
  let t = 0;
  const lens: number[] = [];
  for (const x of plan.shots) {
    const a = take(x.key);
    if (!a) continue;
    ops.push({ op: 'add', track: 'V1', asset: a, kind: 'video', in: 0, out: x.seconds, duration: x.seconds, start: t, label: `${x.key}: ${x.action}`.slice(0, 80) });
    keys.push(x.key);
    let at = t + 0.3;
    x.lines.forEach((l, i) => {
      const v = p.steps.find((y) => y.id === `line:${x.key}:${i}`);
      if (v?.asset) { ops.push({ op: 'add', track: 'A2', asset: v.asset, kind: 'audio', in: 0, out: lineSeconds(l.text), start: Math.round(at * 100) / 100, label: l.text.slice(0, 60) }); keys.push(null); }
      at += lineSeconds(l.text);
    });
    t += x.seconds;
    lens.push(x.seconds);
  }
  if (!lens.length) throw new GenError('No shot was filmed');
  const music = p.steps.find((y) => y.id === 'music');
  if (music?.asset) { ops.push({ op: 'add', track: 'A1', asset: music.asset, kind: 'audio', in: 0, out: t, start: 0, volume: 0.6, label: 'Score' }); keys.push(null); }
  const r = applyOps(newDoc(plan.title, 'video'), ops, undefined, 'video');
  r.results.forEach((x: any, i: number) => { if (x.ok && x.id && keys[i]) p.out.clips[x.id] = keys[i]!; });
  p.out.cut = createScene(p.project, 'video', { ...r.doc, ...(p.out.world ?? plan.world?.id ? { world: p.out.world ?? plan.world?.id } : {}) }, 'ep').id;
  learn(p.project, { kind: 'cut', shotSeconds: lens });
}

/** The review: every shot checked; failures re-taken with the check's fix, within what's left of the budget, then recut. */
async function review(p: Production) {
  const d = deps();
  const spent = () => p.steps.filter((x) => x.job || x.claimed).reduce((n, x) => n + x.credits * Math.max(1, x.tries), 0);
  p.out.reviewed = {};
  const retakes: Step[] = [];
  for (const x of p.plan.shots) {
    const s = p.steps.find((y) => y.id === `shot:${x.key}`);
    if (!s?.asset) continue;
    const file = d.assetPath(s.asset);
    if (!file) continue;
    const ids = x.cast.flatMap((k) => {
      const look = p.steps.find((y) => y.id === `look:${k}`)?.asset;
      return look ? [look] : [];
    }).map((a) => d.assetPath(a)).filter(Boolean) as string[];
    let rep;
    try { rep = await d.assess({ brief: s.make?.brief ?? x.action, kind: 'video', file, ...(ids.length ? { identityRefs: ids } : {}), ...(p.plan.world?.style ? { style: { words: p.plan.world.style } } : {}) }); } catch { continue; }
    p.out.reviewed[x.key] = { pass: rep.pass, ...(rep.fix ? { fix: rep.fix } : {}) };
    if (rep.pass) continue;
    if (spent() + retakes.reduce((n, r) => n + r.credits, 0) + s.credits > p.budget) { p.out.notes.push(`Shot ${x.key} didn't pass its checks and the budget for fixes is used up.`); continue; }
    const fix = rep.fix ?? 'Fix what failed the checks.';
    retakes.push({ ...s, id: `retake:${x.key}`, label: `Shot ${x.key}: a new take`, status: 'waiting', after: [], job: null, asset: null, tries: 0, error: null, browser: false, claimed: null,
      make: { ...s.make!, brief: `${s.make!.brief} Fix: ${fix}`.slice(0, 2600), params: { ...(s.make!.params ?? {}), ...(s.make!.params?.prompt ? { prompt: `${s.make!.params.prompt} ${fix}`.slice(0, 2600) } : {}) } } });
    p.out.reviewed[x.key].retaken = true;
  }
  if (retakes.length) p.steps.push(...retakes, { id: 'recut', label: 'Cutting the new takes in', after: retakes.map((r) => r.id), status: 'waiting', write: 'cut', key: 'recut', credits: 0, tries: 0 });
}

// ------------------------------------------------------------------ review mode's fixes
/**
 * A new take of one shot (review mode): a child production with that shot's steps again, its brief changed by what the
 * person said and what the showrunner saw. When it's done, `out.fix` has the take before and after; keepFix swaps it into
 * the cut, undoFix leaves the cut as it was.
 */
export function createFix(parent: Production, a: { shot: string; clip: string; scene: string; brief: string; redoFrame: boolean; client: Client }): Production {
  const shot = parent.plan.shots.find((x) => x.key === a.shot);
  if (!shot) throw new GenError('That shot is not in this production', { status: 404 });
  const old = parent.steps.find((x) => x.id === `shot:${a.shot}`);
  const frame = parent.steps.find((x) => x.id === `frame:${a.shot}`);
  if (!old?.make) throw new GenError('That shot was not made here', { status: 400 });
  const known = parent.steps.filter((x) => x.asset).map((x) => ({ ...x, status: 'done' as const }));
  const steps: Step[] = [];
  const fixed = (s: Step, id: string, label: string): Step => ({
    ...s, id, label, status: 'waiting', job: null, asset: null, tries: 0, error: null, claimed: null, browser: false,
    make: { ...s.make!, brief: `${s.make!.brief} Change: ${a.brief}`.slice(0, 2600), params: { ...(s.make!.params ?? {}), ...(s.make!.params?.prompt ? { prompt: `${s.make!.params.prompt} ${a.brief}`.slice(0, 2600) } : {}) } },
  });
  if (a.redoFrame && frame?.make) steps.push({ ...fixed(frame, `frame:${a.shot}`, `Shot ${a.shot}: a new first frame`), after: [] });
  const take = fixed(old, `shot:${a.shot}`, `Shot ${a.shot}: a new take`);
  take.after = a.redoFrame && frame?.make ? [`frame:${a.shot}`] : [];
  steps.push(take);
  // What the new steps read from the parent (its pictures and lines) comes in as done steps with their files.
  const all = [...known.filter((k) => !steps.some((s) => s.id === k.id)), ...steps];
  const d = deps();
  for (const s of steps) s.credits = d.quote(parent.project, toolFor(s, d.hasTool).tool, toolFor(s, d.hasTool).params);
  const card: Card = { counts: { clips: 1, ...(a.redoFrame ? { pictures: 1 } : {}) }, credits: steps.reduce((n, s) => n + s.credits, 0), fixCredits: 0, minutes: 2, outline: { title: parent.title, logline: '', seconds: shot.seconds, world: null, characters: [], places: [], beats: [], shots: [{ key: shot.key, seconds: shot.seconds, type: shot.type, action: a.brief, lines: shot.lines.length }] }, issues: [], steps: steps.map((s) => ({ id: s.id, label: s.label, credits: s.credits })) };
  return createProduction({
    project: parent.project, client: a.client, payer: parent.payer, plan: parent.plan, steps: all, card, kind: 'fix', parent: parent.id, note: a.brief,
    out: { ...blankOut(), shots: parent.out.shots, cut: parent.out.cut, fix: { scene: a.scene, clip: a.clip, before: (parent.steps.filter((x) => x.id.startsWith(`retake:${a.shot}`) && x.asset).pop() ?? old).asset ?? null, after: null, shot: a.shot, kept: null } },
  });
}

/** The fix's new take, once it's there. */
export function fixResult(f: Production) {
  const s = f.steps.find((x) => x.id === `shot:${f.out.fix?.shot}` && x.status === 'done' && x.job);
  if (s?.asset && f.out.fix && f.out.fix.after !== s.asset) { f.out.fix.after = s.asset; save(f, ['out']); }
  return f.out.fix ?? null;
}

export function keepFix(f: Production): Production {
  const fx = fixResult(f);
  if (!fx?.after) throw new GenError('The new take is not ready yet', { status: 409 });
  const sc = getScene(fx.scene, (x) => x === f.project);
  const c = sc.doc.clips.find((x: any) => x.id === fx.clip);
  if (!c) throw new GenError('That clip is no longer in the cut', { status: 409 });
  c.asset = fx.after;
  saveScene(sc, sc.doc);
  fx.kept = true;
  save(f, ['out']);
  learn(f.project, { kind: 'review', note: f.note ?? '', kept: true });
  return f;
}
export function undoFix(f: Production): Production {
  const fx = f.out.fix;
  if (!fx) throw new GenError('Not a fix', { status: 400 });
  if (fx.kept) {
    const sc = getScene(fx.scene, (x) => x === f.project);
    const c = sc.doc.clips.find((x: any) => x.id === fx.clip);
    if (c && fx.before) { c.asset = fx.before; saveScene(sc, sc.doc); }
  }
  fx.kept = false;
  save(f, ['out']);
  learn(f.project, { kind: 'review', note: f.note ?? '', kept: false });
  return f;
}

export { compileSteps, MAKE_TOOL };
