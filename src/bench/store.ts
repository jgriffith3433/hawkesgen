// Gen Bench's tables (docs/bench.md): runs, each output's scores, the market baseline's outputs (results with source
// "baseline"), J's ratings, and the cast's reference pictures.

import { db } from '../db.ts';
import { id } from '../util.ts';
import type { QualityReport } from '../quality/index.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS bench_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,              -- mock | real | baseline
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,            -- running | done | failed | cancelled
  briefs TEXT NOT NULL DEFAULT '[]',
  detail TEXT NOT NULL DEFAULT '',
  estimate TEXT,
  summary TEXT,
  error TEXT,
  by TEXT,
  created INTEGER NOT NULL,
  finished INTEGER
);
CREATE TABLE IF NOT EXISTS bench_results (
  id TEXT PRIMARY KEY,
  run TEXT NOT NULL,
  brief TEXT NOT NULL,
  brief_version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,            -- gen | baseline
  asset TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,            -- scoring | scored | failed
  report TEXT,
  pass INTEGER,
  identity REAL,
  spread REAL,
  checklist REAL,
  style REAL,
  faults INTEGER,
  credits REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  seconds REAL NOT NULL DEFAULT 0,
  error TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bench_results_run ON bench_results (run, brief);
CREATE INDEX IF NOT EXISTS bench_results_brief ON bench_results (brief, source);
CREATE TABLE IF NOT EXISTS bench_ratings (
  result TEXT PRIMARY KEY,
  rating INTEGER NOT NULL,
  note TEXT,
  by TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bench_cast (
  id TEXT PRIMARY KEY,
  assets TEXT NOT NULL DEFAULT '[]',
  updated INTEGER NOT NULL
);
`);
// A run that was going when Gen stopped never finishes: say so instead of leaving it "running" for ever.
db.prepare("UPDATE bench_runs SET status = 'failed', error = 'Gen restarted while it ran', finished = ? WHERE status = 'running'").run(Date.now());
db.prepare("UPDATE bench_results SET status = 'failed', error = 'Gen restarted while it was scored' WHERE status = 'scoring'").run();

export type RunMode = 'mock' | 'real' | 'baseline';
export type RunRow = {
  id: string; mode: RunMode; label: string; status: string; briefs: string[]; detail: string; estimate: any; summary: any;
  error: string | null; by: string | null; created: number; finished: number | null;
};
export type ResultRow = {
  id: string; run: string; brief: string; brief_version: number; source: 'gen' | 'baseline'; asset: string | null; kind: string; status: string;
  report: QualityReport | null; pass: number | null; identity: number | null; spread: number | null; checklist: number | null; style: number | null;
  faults: number | null; credits: number; cost: number; seconds: number; error: string | null; created: number;
  rating?: number | null; ratingNote?: string | null;
};

const parse = <T>(row: any, cols: string[]): T => {
  if (!row) return row;
  const out = { ...row };
  for (const c of cols) if (typeof out[c] === 'string') { try { out[c] = JSON.parse(out[c]); } catch { /* left as text */ } }
  return out as T;
};

export function createRun(r: { mode: RunMode; label?: string; briefs: string[]; estimate?: unknown; by?: string; id?: string }): RunRow {
  const runId = r.id ?? id('br', 6);
  db.prepare('INSERT INTO bench_runs (id, mode, label, status, briefs, estimate, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(runId, r.mode, r.label ?? '', 'running', JSON.stringify(r.briefs), r.estimate ? JSON.stringify(r.estimate) : null, r.by ?? null, Date.now());
  return getRun(runId)!;
}

export const getRun = (runId: string) => parse<RunRow | null>(db.prepare('SELECT * FROM bench_runs WHERE id = ?').get(runId) ?? null, ['briefs', 'estimate', 'summary']);

export function listRuns(limit = 100): RunRow[] {
  return (db.prepare('SELECT * FROM bench_runs ORDER BY created DESC LIMIT ?').all(limit) as any[]).map((r) => parse<RunRow>(r, ['briefs', 'estimate', 'summary']));
}

export function updateRun(runId: string, patch: Partial<Pick<RunRow, 'status' | 'detail' | 'summary' | 'error' | 'finished' | 'label'>>) {
  const sets = Object.keys(patch).map((k) => `${k} = :${k}`);
  if (!sets.length) return;
  const row: Record<string, any> = { id: runId };
  for (const [k, v] of Object.entries(patch)) row[k] = k === 'summary' ? JSON.stringify(v) : v ?? null;
  db.prepare(`UPDATE bench_runs SET ${sets.join(', ')} WHERE id = :id`).run(row);
}

/** The baseline's run for a label ("Kling 3 + Nano Banana"): one per label, made on first upload. */
export function baselineRun(label: string, by?: string): RunRow {
  const clean = label.trim().slice(0, 80) || 'Market baseline';
  const found = db.prepare("SELECT id FROM bench_runs WHERE mode = 'baseline' AND label = ?").get(clean) as any;
  if (found) return getRun(found.id)!;
  const r = createRun({ mode: 'baseline', label: clean, briefs: [], by });
  updateRun(r.id, { status: 'done', finished: Date.now() });
  return getRun(r.id)!;
}

export function addResult(r: { run: string; brief: string; briefVersion?: number; source: 'gen' | 'baseline'; asset: string | null; kind: string; credits?: number; cost?: number; seconds?: number; error?: string | null }): ResultRow {
  const resultId = id('bx', 6);
  db.prepare('INSERT INTO bench_results (id, run, brief, brief_version, source, asset, kind, status, credits, cost, seconds, error, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(resultId, r.run, r.brief, r.briefVersion ?? 1, r.source, r.asset, r.kind, r.error ? 'failed' : 'scoring', r.credits ?? 0, r.cost ?? 0, r.seconds ?? 0, r.error ?? null, Date.now());
  return getResult(resultId)!;
}

export function getResult(resultId: string): ResultRow | null {
  const row = db.prepare('SELECT r.*, g.rating AS rating, g.note AS ratingNote FROM bench_results r LEFT JOIN bench_ratings g ON g.result = r.id WHERE r.id = ?').get(resultId);
  return row ? parse<ResultRow>(row, ['report']) : null;
}

/** A finished score, flattened into the columns the trend and agreement read. */
export function scoreResult(resultId: string, report: QualityReport) {
  db.prepare(`UPDATE bench_results SET status = 'scored', report = ?, pass = ?, identity = ?, spread = ?, checklist = ?, style = ?, faults = ?, error = NULL WHERE id = ?`).run(
    JSON.stringify(report), report.pass ? 1 : 0,
    report.identity?.distance ?? null, report.identity?.distance == null ? null : report.identity.spread,
    report.checklist && !report.checklist.skipped ? report.checklist.score : null,
    report.style?.score ?? null, report.faults ? report.faults.faults.length : null, resultId,
  );
}

export function failResult(resultId: string, error: string) {
  db.prepare("UPDATE bench_results SET status = 'failed', error = ? WHERE id = ?").run(error.slice(0, 500), resultId);
}

export function listResults(q: { run?: string; brief?: string; source?: 'gen' | 'baseline'; rated?: boolean } = {}): ResultRow[] {
  const where: string[] = [];
  const args: any[] = [];
  if (q.run) { where.push('r.run = ?'); args.push(q.run); }
  if (q.brief) { where.push('r.brief = ?'); args.push(q.brief); }
  if (q.source) { where.push('r.source = ?'); args.push(q.source); }
  if (q.rated) where.push('g.rating IS NOT NULL');
  const sql = `SELECT r.*, g.rating AS rating, g.note AS ratingNote FROM bench_results r LEFT JOIN bench_ratings g ON g.result = r.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created`;
  return (db.prepare(sql).all(...args) as any[]).map((r) => parse<ResultRow>(r, ['report']));
}

export function rate(resultId: string, rating: number, note: string | null, by: string | null) {
  db.prepare('INSERT INTO bench_ratings (result, rating, note, by, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(result) DO UPDATE SET rating = excluded.rating, note = excluded.note, by = excluded.by, at = excluded.at')
    .run(resultId, rating, note, by, Date.now());
}
export const unrate = (resultId: string) => db.prepare('DELETE FROM bench_ratings WHERE result = ?').run(resultId);

export function castAssets(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of db.prepare('SELECT id, assets FROM bench_cast').all() as any[]) out[r.id] = JSON.parse(r.assets);
  return out;
}
export function setCast(castId: string, assets: string[]) {
  db.prepare('INSERT INTO bench_cast (id, assets, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET assets = excluded.assets, updated = excluded.updated')
    .run(castId, JSON.stringify(assets), Date.now());
}
