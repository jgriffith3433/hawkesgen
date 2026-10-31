// Gen Bench's routes and the quality check door (docs/bench.md). Admins only (src/api.ts OPS_ROUTES keeps customers
// out first); a real run is the owner's and needs the price it was shown.
//   GET  /v1/bench                       briefs, cast, runs with their summaries, the agreement with J's ratings
//   GET  /v1/bench/runs/:id              one run's results, each with its brief and the baseline's results beside it
//   POST /v1/bench/estimate {briefs?}    what a real run would cost
//   POST /v1/bench/runs {mode, briefs?, label?, confirmCost?}   mock runs free; real: owner, confirmCost = estimate total
//   POST /v1/bench/runs/:id/cancel
//   POST /v1/bench/baseline {brief, asset, label}               a market-baseline output, scored like Gen's
//   POST /v1/bench/results/:id/rate {rating 1-5 | null, note?}
//   PUT  /v1/bench/cast/:id {assets: [ids]}                     a character's reference pictures
//   POST /v1/quality/assess {brief, asset, kind?, identityRefs?, style?: {refs?, words?}, questions?, thresholds?}

import type { ServerResponse } from 'node:http';
import { requireRole, type Client } from '../auth.ts';
import { getAsset } from '../library.ts';
import { assess, meter } from '../quality/index.ts';
import { kindOfFile } from '../tools/quality-identity.ts';
import { GenError } from '../util.ts';
import * as store from './store.ts';
import { agreement, summarize, versus } from './stats.ts';
import { addBaseline, cancelRun, estimateRun, loadBench, pickBriefs, startRun } from './runner.ts';

type Send = (res: ServerResponse, status: number, body: unknown) => void;

function fileOf(assetId: unknown, label = 'asset'): string {
  const a = getAsset(String(assetId ?? ''));
  if (!a) throw new GenError(`${label}: no such file in the library`, { status: 404 });
  return a.path;
}

/** The overview the Bench tab draws. */
export function overview() {
  const bench = loadBench();
  const runs = store.listRuns(200).map((r) => ({ ...r, summary: r.summary ?? summarize(store.listResults({ run: r.id })) }));
  const all = store.listResults();
  const cast = store.castAssets();
  return {
    briefs: bench.briefs.map((b) => ({ id: b.id, version: b.version, title: b.title, kind: b.kind, via: b.via, brief: b.brief, cast: b.cast ?? [], style: b.style ?? null })),
    cast: bench.cast.map((c) => ({ ...c, assets: cast[c.id] ?? [] })),
    style: bench.style,
    runs,
    agreement: agreement(all.filter((r) => r.status === 'scored')),
    rated: all.filter((r) => r.rating != null).length,
  };
}

export function runDetail(runId: string) {
  const run = store.getRun(runId);
  if (!run) throw new GenError('No such bench run', { status: 404 });
  // What each file really is (a mock run's "video" is a poster frame), for the tab to show it right.
  const withKind = <T extends { asset: string | null }>(r: T) => ({ ...r, assetKind: r.asset ? getAsset(r.asset)?.kind ?? null : null });
  const results = store.listResults({ run: runId }).map(withKind);
  const briefs = [...new Set(results.map((r) => r.brief))];
  const baseline = briefs.flatMap((b) => store.listResults({ brief: b, source: 'baseline' })).map(withKind);
  const gen = run.mode === 'baseline' ? [] : results;
  return { run: { ...run, summary: run.summary ?? summarize(results) }, results, baseline, versus: versus(gen.filter((r) => r.status === 'scored'), baseline.filter((r) => r.status === 'scored')) };
}

/** Answers a /v1/bench or /v1/quality route; false when the route isn't one. */
export async function handleBench(client: Client, route: string, method: string, readBody: () => Promise<any>, res: ServerResponse, send: Send): Promise<boolean> {
  if (!route.startsWith('/v1/bench') && !route.startsWith('/v1/quality/')) return false;
  requireRole(client, 'admin');
  let read: Promise<any> | null = null;
  const body = () => (read ??= readBody().then((b) => b ?? {}));
  const ok = (b: unknown) => { send(res, 200, b); return true; };

  if (route === '/v1/quality/assess' && method === 'POST') {
    const b = await body();
    if (typeof b.brief !== 'string' || !b.brief.trim()) throw new GenError('brief: what the output should be', { status: 400 });
    const file = fileOf(b.asset);
    const style = b.style && typeof b.style === 'object' ? { refs: (Array.isArray(b.style.refs) ? b.style.refs : []).map((x: unknown) => fileOf(x, 'style.refs')), words: typeof b.style.words === 'string' ? b.style.words : undefined } : undefined;
    const { value, calls } = await meter(() => assess({
      brief: b.brief, kind: kindOfFile(file, b.kind), file,
      identityRefs: (Array.isArray(b.identityRefs) ? b.identityRefs : []).map((x: unknown) => fileOf(x, 'identityRefs')),
      ...(style ? { style } : {}),
      questions: Array.isArray(b.questions) ? b.questions.map(String) : undefined,
      thresholds: b.thresholds && typeof b.thresholds === 'object' ? b.thresholds : undefined,
    }));
    return ok({ ...value, cost: Math.round(calls.reduce((s, c) => s + c.cost, 0) * 10000) / 10000 });
  }
  if (!route.startsWith('/v1/bench')) return false;

  if (route === '/v1/bench' && method === 'GET') return ok(overview());
  if (route === '/v1/bench/estimate' && method === 'POST') return ok(await estimateRun(pickBriefs((await body()).briefs)));
  if (route === '/v1/bench/runs' && method === 'GET') return ok({ runs: store.listRuns(200) });
  if (route === '/v1/bench/runs' && method === 'POST') {
    const b = await body();
    const briefs = pickBriefs(b.briefs);
    const label = typeof b.label === 'string' ? b.label.slice(0, 80) : undefined;
    if (b.mode === 'real') {
      // Real runs spend GPU and Claude: the owner's, and only at the price they were shown (it changes as history does).
      requireRole(client, 'owner');
      const est = await estimateRun(briefs);
      if (Number(b.confirmCost) !== est.total) return send(res, 409, { error: `A real run costs about $${est.total.toFixed(2)}: confirm that price`, estimate: est }), true;
      return ok({ run: startRun({ mode: 'real', briefs, label, estimate: est, by: client.name }).run });
    }
    return ok({ run: startRun({ mode: 'mock', briefs, label, by: client.name }).run });
  }
  const rm = /^\/v1\/bench\/runs\/(br_[0-9a-f]+)(?:\/(cancel))?$/.exec(route);
  if (rm && !rm[2] && method === 'GET') return ok(runDetail(rm[1]));
  if (rm && rm[2] === 'cancel' && method === 'POST') {
    const run = store.getRun(rm[1]);
    if (!run) throw new GenError('No such bench run', { status: 404 });
    if (run.status === 'running') cancelRun(run.id);
    return ok({ run: store.getRun(run.id) });
  }
  if (route === '/v1/bench/baseline' && method === 'POST') {
    const b = await body();
    const r = await addBaseline({ brief: String(b.brief ?? ''), asset: String(b.asset ?? ''), label: String(b.label ?? 'Market baseline'), by: client.name, mock: b.mock === true });
    return ok({ result: r.result, run: r.run });
  }
  const rt = /^\/v1\/bench\/results\/(bx_[0-9a-f]+)\/rate$/.exec(route);
  if (rt && method === 'POST') {
    const b = await body();
    if (!store.getResult(rt[1])) throw new GenError('No such bench result', { status: 404 });
    if (b.rating == null) store.unrate(rt[1]);
    else {
      const n = Number(b.rating);
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new GenError('rating: 1 to 5', { status: 400 });
      store.rate(rt[1], n, typeof b.note === 'string' ? b.note.slice(0, 500) : null, client.name);
    }
    return ok({ result: store.getResult(rt[1]) });
  }
  const cm = /^\/v1\/bench\/cast\/([a-z0-9-]+)$/.exec(route);
  if (cm && method === 'PUT') {
    if (!loadBench().cast.some((c) => c.id === cm[1])) throw new GenError('No such cast member', { status: 404 });
    const b = await body();
    const assets = (Array.isArray(b.assets) ? b.assets : []).map(String);
    for (const a of assets) fileOf(a);
    store.setCast(cm[1], assets);
    return ok({ cast: store.castAssets() });
  }
  throw new GenError(`No bench route ${method} ${route}`, { status: 404 });
}
