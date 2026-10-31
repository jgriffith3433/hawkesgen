// Gen Bench's runner (docs/bench.md): every brief through the app's real path, every output scored with src/quality
// assess(), stored in bench_runs / bench_results.
//
//   real   per brief, its own project (genbench-<run>-<brief>): a scene of the brief's kind made through /v1/scenes, the
//          brief sent to that scene's AI (the AI editor for video, image and audio; the character AI for characters) or,
//          for `make` briefs, the tool make.checked when this Gen has it (else the tool route() picks). Generation is
//          approved up front (the run's price was shown and accepted), the run waits for the project's jobs, then scores
//          each output of the brief's kind against the cast's references and the brief's look. Calls go to this Gen over
//          HTTP with its own token, exactly as the app's would. Owner only, priced first.
//   mock   the same plumbing with the maker and the checks swapped: stand-in files (src/bench/synth.ts) filed as real
//          assets in the project genbench-mock, scored by the mock checks (src/quality/mock.ts). Free, offline, no GPU.
//   baseline  outputs made outside Gen (uploaded per brief), scored the same way (scoreBaseline).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.ts';
import { getAsset, putAsset, type Asset } from '../library.ts';
import { assess, withQualityMock, type OutputKind, type QualityReport } from '../quality/index.ts';
import { GenError, sleep } from '../util.ts';
import * as store from './store.ts';
import { summarize } from './stats.ts';
import { glb, png, wav } from './synth.ts';

export type CastMember = { id: string; name: string; description: string };
export type Brief = {
  id: string; version: number; title: string; kind: OutputKind; via: 'image' | 'video' | 'audio' | 'character' | 'make';
  intent: string; brief: string; cast?: string[]; style?: string; questions?: string[];
  plan?: { tool: string; params?: Record<string, any>; count?: number }[];
};
export type Bench = { style: Record<string, string>; cast: CastMember[]; briefs: Brief[] };

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'briefs.json');
let cached: Bench | null = null;
export function loadBench(): Bench {
  if (!cached) {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cached = { style: j.style ?? {}, cast: j.cast ?? [], briefs: j.briefs ?? [] };
  }
  return cached;
}
export const briefById = (briefId: string) => loadBench().briefs.find((b) => b.id === briefId) ?? null;

export const MOCK_PROJECT = 'genbench-mock';
export const CAST_PROJECT = 'genbench-cast';
const projectFor = (runId: string, briefId: string) => `genbench-${runId.replace(/^br_/, '')}-${briefId}`;

/** The briefs a run covers: all, or the ids asked for (unknown ids refused). */
export function pickBriefs(ids?: unknown): Brief[] {
  const all = loadBench().briefs;
  if (!Array.isArray(ids) || !ids.length) return all;
  const out = ids.map((x) => { const b = briefById(String(x)); if (!b) throw new GenError(`No bench brief "${x}"`, { status: 400 }); return b; });
  return out;
}

/** The words sent to the AI: the brief, who is in it with their reference picture, and the look. */
export function briefMessage(b: Brief, refs: Record<string, string[]> = {}): string {
  const bench = loadBench();
  const cast = (b.cast ?? []).map((c) => bench.cast.find((m) => m.id === c)).filter(Boolean) as CastMember[];
  const lines = [b.brief];
  if (cast.length) {
    lines.push('', 'Characters (keep each exactly on-model):');
    for (const c of cast) lines.push(`- ${c.name}: ${c.description}${refs[c.id]?.length ? ` Reference picture: asset:${refs[c.id][0]}.` : ''}`);
  }
  if (b.style && bench.style[b.style]) lines.push('', `The look: ${bench.style[b.style]}`);
  lines.push('', 'Make it now without asking questions.');
  return lines.join('\n');
}

// -------------------------------------------------------------------- the price

/** Claude per brief (the assistant's turn) and per output scored (questions, answers, faults, look), in dollars. */
export const CLAUDE_PER_BRIEF = 0.08;
export const CLAUDE_PER_CHECK = 0.03;

/** What a real run of these briefs would cost: GPU from this Gen's own job history (src/estimate.ts), plus Claude. */
export async function estimateRun(briefs: Brief[]) {
  const { estimate } = await import('../estimate.ts');
  const { getTool } = await import('../tools/index.ts');
  const items: { tool: string; params: Record<string, any>; count: number; label: string }[] = [];
  const unknown: string[] = [];
  for (const b of briefs) for (const p of b.plan ?? []) {
    if (!getTool(p.tool)) { unknown.push(`${b.id}: ${p.tool}`); continue; }
    items.push({ tool: p.tool, params: p.params ?? {}, count: p.count ?? 1, label: `${b.id} · ${p.tool}` });
  }
  const castToMake = (await missingCast(briefs)).length;
  if (castToMake && getTool('image.generate')) items.push({ tool: 'image.generate', params: {}, count: castToMake, label: 'cast references' });
  let gpu: any = null;
  if (items.length) {
    try { gpu = estimate({ project: 'genbench', items }); } catch (e) { unknown.push(`estimate: ${e instanceof Error ? e.message : e}`); }
  }
  // About one output per brief, five for a multi-shot one.
  const outputs = briefs.reduce((s, b) => s + (b.kind === 'video' && /shots|trailer/i.test(b.title) ? 5 : 1), 0);
  const claude = Math.round((briefs.length * CLAUDE_PER_BRIEF + outputs * 2 * CLAUDE_PER_CHECK) * 100) / 100;
  const total = Math.round(((gpu?.cost?.total ?? 0) + claude) * 100) / 100;
  return { briefs: briefs.length, gpu, claude, total, castToMake, unknown, note: 'GPU from past jobs of each tool; Claude from typical turn sizes (an assistant turn per brief, two checks per output). An idle tail is extra.' };
}

// -------------------------------------------------------------------- running

const cancelled = new Set<string>();
export const cancelRun = (runId: string) => { cancelled.add(runId); store.updateRun(runId, { detail: 'stopping after this brief' }); };

/** The cast members a set of briefs needs who have no reference pictures yet. */
async function missingCast(briefs: Brief[]) {
  const have = store.castAssets();
  return [...new Set(briefs.flatMap((b) => b.cast ?? []))].filter((c) => !(have[c] ?? []).some((a) => getAsset(a)));
}

/** A path for an asset id (local files only: the bench runs where the library is). */
const pathOf = (assetId: string) => { const a = getAsset(assetId); return a && fs.existsSync(a.path) ? a.path : null; };

export type Made = { assets: Asset[]; credits: number; cost: number; seconds: number; error?: string };
type Maker = (b: Brief, runId: string, refs: Record<string, string[]>) => Promise<Made>;

/** Mock: a stand-in file of the brief's kind (two for a multi-shot video brief), filed like any job's output. */
const mockMaker: Maker = async (b, runId) => {
  const n = b.kind === 'video' && /shots|trailer/i.test(b.title) ? 2 : 1;
  const assets: Asset[] = [];
  for (let i = 0; i < n; i++) {
    const seed = `${runId}/${b.id}/${i}`;
    const data = b.kind === 'audio' ? wav(seed) : b.kind === 'mesh' ? await glb(seed) : png(seed);
    const ext = b.kind === 'audio' ? '.wav' : b.kind === 'mesh' ? '.glb' : '.png';
    assets.push(putAsset({
      data, ext, client: 'local', project: MOCK_PROJECT, tool: 'bench.mock', title: `${b.title}${n > 1 ? ` (${i + 1})` : ''} · mock`,
      recipe: { tool: 'bench.mock', version: 1, params: { brief: b.id, run: runId, i }, inputs: {} }, labels: { bench: runId, brief: b.id, mock: true },
    }));
  }
  return { assets, credits: 0, cost: 0, seconds: 0 };
};

/** Mock cast references: one stand-in picture per character, made once. */
async function mockCast(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const c of loadBench().cast) {
    const found = db.prepare("SELECT id FROM assets WHERE project = ? AND json_extract(labels, '$.cast') = ? LIMIT 1").get(MOCK_PROJECT, c.id) as any;
    out[c.id] = [found?.id ?? putAsset({ data: png(`cast/${c.id}`, 128, 128), ext: '.png', client: 'local', project: MOCK_PROJECT, tool: 'bench.mock', title: `${c.name} · mock reference`, recipe: { tool: 'bench.mock', version: 1, params: { cast: c.id }, inputs: {} }, labels: { cast: c.id, mock: true } }).id];
  }
  return out;
}

/** This Gen as the app calls it (its own token). */
async function self(project: string) {
  const { SELF_TOKEN, SELF_URL } = await import('../auth.ts');
  // @ts-ignore: plain JS client
  const { HawkesGen } = await import('../../clients/js/hawkesgen.mjs');
  return new HawkesGen({ url: SELF_URL(), key: SELF_TOKEN, project });
}

const OPEN = "status NOT IN ('done', 'failed', 'cancelled')";
async function waitForJobs(project: string, runId: string, timeoutMs = 60 * 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const open = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE project = ? AND ${OPEN}`).get(project) as any).n;
    if (!open) return;
    store.updateRun(runId, { detail: `${project}: ${open} job${open > 1 ? 's' : ''} running` });
    await sleep(10_000);
  }
  throw new GenError(`Still making after ${Math.round(timeoutMs / 60_000)} minutes`);
}

/** The real cast references: the ones set in the Bench tab, else a portrait made once per character (kept for later runs). */
async function realCast(briefs: Brief[]): Promise<Record<string, string[]>> {
  const missing = await missingCast(briefs);
  if (missing.length) {
    const gen = await self(CAST_PROJECT);
    for (const c of missing) {
      const m = loadBench().cast.find((x) => x.id === c)!;
      const job = await gen.submit('image.generate', { project: CAST_PROJECT, key: `bench-cast:${c}:v1`, reuse: true, params: { prompt: `Portrait reference photo of ${m.description} Head and shoulders, facing the camera, neutral expression, plain light grey background, soft even studio light.`, width: 1024, height: 1024 } });
      const done = await gen.wait(job.id);
      const asset = done?.outputs?.[0]?.asset ?? null;
      if (asset) store.setCast(c, [asset]);
    }
  }
  return store.castAssets();
}

const realMaker: Maker = async (b, runId, refs) => {
  const project = projectFor(runId, b.id);
  const gen = await self(project);
  const started = Date.now();
  const text = briefMessage(b, refs);
  const { getTool } = await import('../tools/index.ts');
  if (b.via === 'make') {
    const { route } = await import('../make/index.ts');
    const r = route({ intent: b.intent as any });
    const tool = getTool('make.checked') ? 'make.checked' : r.tool;
    const params = tool === 'make.checked' ? { intent: b.intent, brief: text, quality: 'final' } : { ...r.params, prompt: text };
    await gen.submit(tool, { project, params, labels: { bench: runId, brief: b.id } });
  } else {
    const kind = b.via === 'character' ? 'character' : b.via;
    const scene = await gen.request('/scenes', { method: 'POST', body: { kind, project, title: b.title } });
    const route = kind === 'character' ? `/scenes/${scene.id}/assistant` : `/editor/projects/${scene.id}/assistant`;
    const answer = await gen.request(route, { method: 'POST', body: { messages: [{ role: 'user', text }], autoCredits: 1_000_000 } });
    if (answer?.proposed) {
      // Over the automatic limit anyway: approve it, as the person would with one tap (the run's price was accepted).
      if (kind === 'character') await gen.request(`/scenes/${scene.id}/apply`, { method: 'POST', body: answer.proposed });
      else await gen.request(`/editor/projects/${scene.id}/apply`, { method: 'POST', body: { ops: answer.proposed.ops } });
    }
  }
  await waitForJobs(project, runId);
  const jobs = db.prepare('SELECT tool, params, cost FROM jobs WHERE project = ?').all(project) as any[];
  const { quoteJobCredits } = await import('../billing.ts');
  let credits = 0;
  for (const j of jobs) { try { credits += Number((quoteJobCredits({ project, tool: j.tool, params: JSON.parse(j.params) }) as any)?.credits ?? 0); } catch { /* a tool no longer priced */ } }
  const usage = (db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM usage WHERE project = ?").get(project) as any)?.c ?? 0;
  const cost = jobs.reduce((s, j) => s + Number(j.cost ?? 0), 0) + Number(usage);
  const assets = (db.prepare('SELECT id FROM assets WHERE project = ? AND kind = ? ORDER BY created').all(project, b.kind) as any[]).map((r) => getAsset(r.id)!).slice(-6);
  return { assets, credits, cost, seconds: (Date.now() - started) / 1000, ...(assets.length ? {} : { error: `No ${b.kind} came out (${jobs.length} job${jobs.length === 1 ? '' : 's'})` }) };
};

/** The checks' inputs for one output of a brief: the brief, the cast's reference files, the look in words. */
export function assessInput(b: Brief, file: string, refs: Record<string, string[]>) {
  const identityRefs = b.kind === 'image' || b.kind === 'video'
    ? (b.cast ?? []).flatMap((c) => (refs[c] ?? []).map(pathOf)).filter((p): p is string => Boolean(p)).slice(0, 8)
    : [];
  const words = b.style ? loadBench().style[b.style] : undefined;
  return { brief: b.brief, kind: b.kind, file, identityRefs, ...(words ? { style: { words } } : {}), ...(b.questions?.length ? { questions: b.questions } : {}) };
}

async function score(resultId: string, b: Brief, file: string, refs: Record<string, string[]>, mock: boolean): Promise<QualityReport | null> {
  try {
    const work = () => assess(assessInput(b, file, refs));
    const report = mock ? await withQualityMock(work) : await work();
    store.scoreResult(resultId, report);
    return report;
  } catch (e) {
    store.failResult(resultId, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Starts a run in the background and returns it at once. */
export function startRun(o: { mode: 'mock' | 'real'; briefs: Brief[]; label?: string; estimate?: unknown; by?: string; maker?: Maker }) {
  const run = store.createRun({ mode: o.mode, label: o.label ?? (o.mode === 'mock' ? 'Mock run' : 'Gen'), briefs: o.briefs.map((b) => b.id), estimate: o.estimate, by: o.by });
  const done = executeRun(run.id, o).catch((e) => store.updateRun(run.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), finished: Date.now() }));
  return { run: store.getRun(run.id)!, done };
}

async function executeRun(runId: string, o: { mode: 'mock' | 'real'; briefs: Brief[]; maker?: Maker }) {
  const mock = o.mode === 'mock';
  const maker = o.maker ?? (mock ? mockMaker : realMaker);
  store.updateRun(runId, { detail: 'the cast\'s references' });
  const refs = mock ? await mockCast() : await realCast(o.briefs);
  for (const [i, b] of o.briefs.entries()) {
    if (cancelled.has(runId)) { cancelled.delete(runId); return finish(runId, 'cancelled'); }
    store.updateRun(runId, { detail: `${i + 1} of ${o.briefs.length}: ${b.title}` });
    let made: Made;
    try {
      made = await maker(b, runId, refs);
    } catch (e) {
      made = { assets: [], credits: 0, cost: 0, seconds: 0, error: e instanceof Error ? e.message : String(e) };
    }
    if (!made.assets.length) {
      store.addResult({ run: runId, brief: b.id, briefVersion: b.version, source: 'gen', asset: null, kind: b.kind, ...made, error: made.error ?? 'Nothing was made' });
      continue;
    }
    // A brief's cost and time are spread over its outputs, so sums over a run stay right.
    const share = 1 / made.assets.length;
    for (const a of made.assets) {
      const r = store.addResult({ run: runId, brief: b.id, briefVersion: b.version, source: 'gen', asset: a.id, kind: b.kind, credits: made.credits * share, cost: made.cost * share, seconds: made.seconds * share });
      await score(r.id, b, a.path, refs, mock);
    }
  }
  finish(runId, 'done');
}

function finish(runId: string, status: 'done' | 'cancelled') {
  store.updateRun(runId, { status, detail: '', finished: Date.now(), summary: summarize(store.listResults({ run: runId })) });
}

/** A market-baseline output for a brief (a file uploaded to the library), scored like Gen's. */
export async function addBaseline(o: { brief: string; asset: string; label: string; by?: string; mock?: boolean }) {
  const b = briefById(o.brief);
  if (!b) throw new GenError(`No bench brief "${o.brief}"`, { status: 400 });
  const a = getAsset(o.asset);
  if (!a || !fs.existsSync(a.path)) throw new GenError('No such file in the library', { status: 404 });
  const run = store.baselineRun(o.label, o.by);
  const r = store.addResult({ run: run.id, brief: b.id, briefVersion: b.version, source: 'baseline', asset: a.id, kind: b.kind });
  const refs = o.mock ? await mockCast() : store.castAssets();
  const done = score(r.id, b, a.path, refs, Boolean(o.mock)).then(() => store.updateRun(run.id, { summary: summarize(store.listResults({ run: run.id })) }));
  return { result: store.getResult(r.id)!, run: store.getRun(run.id)!, done };
}
