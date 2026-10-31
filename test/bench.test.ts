// Gen Bench (src/bench, docs/bench.md): the agreement math, a mock run end to end over HTTP (every brief, stand-in files,
// mock checks), J's ratings, a market-baseline output scored like Gen's, and who may do what. A scratch data folder and a
// random port; no GPU, no Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-bench-'));
const { handle } = await import('../src/api.ts');
const { createClient } = await import('../src/auth.ts');
const stats = await import('../src/bench/stats.ts');
const runner = await import('../src/bench/runner.ts');
const synth = await import('../src/bench/synth.ts');
const { getTool } = await import('../src/tools/index.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

const owner = createClient('owner (test)', 'owner', ['*']).key;
const admin = createClient('admin (test)', 'admin', ['*']).key;
const customer = createClient('a customer (test)', 'user', ['usr_cccc']).key;

const call = async (key: string, route: string, body?: any, method?: string) => {
  const r = await fetch(base + route, { method: method ?? (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

test('ranks, Spearman and agreement with J\'s ratings', () => {
  assert.deepEqual(stats.ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
  assert.equal(stats.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(stats.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(stats.spearman([1, 2], [1, 2]), null, 'too few');
  assert.equal(stats.spearman([1, 1, 1], [1, 2, 3]), null, 'no variation');
  const rows = Array.from({ length: 12 }, (_, i) => ({ brief: 'b', pass: i >= 9 ? 1 : 0, identity: 0.3 - i * 0.02, checklist: i / 11, style: 0.5, faults: 0, rating: 1 + Math.floor(i / 3) }));
  const a = Object.fromEntries(stats.agreement(rows).map((x) => [x.score, x]));
  assert.equal(a.checklist.n, 12);
  assert.ok(a.checklist.spearman! > 0.9);
  assert.equal(a.checklist.trusted, true);
  assert.ok(a.identity.spearman! > 0.9, 'a smaller distance is better');
  assert.equal(a.style.spearman, null, 'a score that never varies says nothing');
  assert.equal(a.pass.passAgree, 1, 'passed exactly where J gave 4 or 5');
  assert.equal(stats.agreement(rows.slice(0, 5)).find((x) => x.score === 'checklist')!.trusted, null, 'under 10 ratings: not decided');
});

test('summaries and Gen against the baseline', () => {
  const s = stats.summarize([
    { brief: 'a', status: 'scored', pass: 1, identity: 0.1, checklist: 1, style: 0.8, faults: 0, cost: 0.5, seconds: 10 },
    { brief: 'a', status: 'scored', pass: 0, identity: 0.3, checklist: 0.5, style: null, faults: 2, cost: 0.5, seconds: 10 },
    { brief: 'b', status: 'failed', pass: null, identity: null, checklist: null, style: null, faults: null },
  ]);
  assert.equal(s.outputs, 3);
  assert.equal(s.scored, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.pass, 0.5);
  assert.equal(s.identity, 0.2);
  assert.equal(s.faultFree, 0.5);
  assert.equal(s.cost, 1);
  const v = stats.versus([{ brief: 'a', pass: 1, identity: 0.1, checklist: 0.9, style: 0.8, faults: 0 }], [{ brief: 'a', pass: 0, identity: 0.2, checklist: 0.9, style: 0.9, faults: 1 }]);
  assert.deepEqual(v[0].wins, { identity: 'gen', checklist: 'tie', style: 'baseline', faultFree: 'gen', pass: 'gen' });
});

test('the briefs: about 30, every kind, the roadmap\'s list, a cast for identity', () => {
  const b = runner.loadBench();
  assert.ok(b.briefs.length >= 28 && b.briefs.length <= 34, `${b.briefs.length} briefs`);
  assert.equal(new Set(b.briefs.map((x) => x.id)).size, b.briefs.length, 'unique ids');
  for (const k of ['image', 'video', 'mesh', 'audio']) assert.ok(b.briefs.some((x) => x.kind === k), k);
  for (const id of ['char-sheet-maya', 'talking-closeup', 'argument-5-shots', 'poster', 'skybox', 'prop-lantern', 'rigged-character', 'trailer-30s', 'recurring-prop-3-shots']) assert.ok(runner.briefById(id), id);
  for (const x of b.briefs) {
    for (const c of x.cast ?? []) assert.ok(b.cast.some((m) => m.id === c), `${x.id}: cast ${c}`);
    if (x.style) assert.ok(b.style[x.style], `${x.id}: style ${x.style}`);
    assert.ok(['image', 'video', 'audio', 'character', 'make'].includes(x.via), `${x.id}: via`);
    for (const p of x.plan ?? []) assert.ok(getTool(p.tool) || ['video.talk', 'audio.voice', 'audio.sfx', 'mesh.views3d'].includes(p.tool), `${x.id}: plan tool ${p.tool}`);
  }
  // The AI is told who is in it and gets the reference picture.
  const m = runner.briefMessage(runner.briefById('talking-closeup')!, { maya: ['a_123'] });
  assert.match(m, /Maya Okafor: .*Reference picture: asset:a_123\./);
  assert.match(m, /The look: Cold blue-white/);
});

test('the stand-in files are real files', async () => {
  const p = synth.png('x', 8, 4);
  assert.deepEqual([...p.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
  const w = synth.wav('x', 0.1);
  assert.equal(w.subarray(0, 4).toString(), 'RIFF');
  assert.equal(w.length, 44 + Math.round(0.1 * 22050) * 2);
  assert.equal(Buffer.from(await synth.glb('x')).subarray(0, 4).toString(), 'glTF');
});

test('customers never reach the bench or the quality door', async () => {
  for (const [route, body] of [['/v1/bench', undefined], ['/v1/bench/runs', { mode: 'mock' }], ['/v1/quality/assess', { brief: 'x', asset: 'a_1' }]] as const) {
    assert.equal((await call(customer, route, body)).status, 403, route);
  }
});

test('a mock run end to end: every brief made, scored, summarised; then ratings and agreement', async () => {
  const start = await call(admin, '/v1/bench/runs', { mode: 'mock' });
  assert.equal(start.status, 200);
  const runId = start.body.run.id;
  let d: any;
  for (let i = 0; i < 200; i++) {
    d = (await call(admin, `/v1/bench/runs/${runId}`)).body;
    if (d.run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(d.run.status, 'done', d.run.error ?? d.run.detail);
  const n = runner.loadBench().briefs.length;
  assert.equal(new Set(d.results.map((r: any) => r.brief)).size, n, 'every brief has a result');
  assert.ok(d.results.every((r: any) => r.status === 'scored' && r.asset && r.report), 'every output scored');
  assert.ok(d.results.some((r: any) => r.identity != null), 'identity scored where there is a cast');
  assert.ok(d.results.filter((r: any) => r.kind === 'mesh' || r.kind === 'audio').every((r: any) => r.identity == null), 'no faces in a model or a sound');
  assert.equal(d.run.summary.outputs, d.results.length);
  assert.ok(d.results.find((r: any) => r.kind === 'mesh').assetKind === 'mesh');
  // Rate a dozen: the agreement table fills in.
  for (const [i, r] of d.results.slice(0, 12).entries()) assert.equal((await call(admin, `/v1/bench/results/${r.id}/rate`, { rating: 1 + (i % 5) })).status, 200);
  assert.equal((await call(admin, `/v1/bench/results/${d.results[0].id}/rate`, { rating: 9 })).status, 400);
  const o = (await call(admin, '/v1/bench')).body;
  assert.equal(o.rated, 12);
  assert.ok(o.agreement.find((a: any) => a.score === 'checklist').n > 0);
  assert.ok(o.runs.some((r: any) => r.id === runId && r.summary.outputs > 0));
  // Unrate.
  await call(admin, `/v1/bench/results/${d.results[0].id}/rate`, { rating: null });
  assert.equal((await call(admin, '/v1/bench')).body.rated, 11);

  // A baseline output for one brief, scored the same way, shows beside Gen's in the run.
  const asset = d.results.find((r: any) => r.brief === 'poster').asset;
  const bl = await call(admin, '/v1/bench/baseline', { brief: 'poster', asset, label: 'Elsewhere', mock: true });
  assert.equal(bl.status, 200);
  for (let i = 0; i < 50 && (await call(admin, `/v1/bench/runs/${bl.body.run.id}`)).body.results[0].status === 'scoring'; i++) await new Promise((r) => setTimeout(r, 50));
  const d2 = (await call(admin, `/v1/bench/runs/${runId}`)).body;
  assert.equal(d2.baseline.length, 1);
  assert.equal(d2.baseline[0].status, 'scored');
  assert.deepEqual(d2.baseline[0].report, d2.results.find((r: any) => r.brief === 'poster').report, 'the same file scores the same, whoever made it');
  assert.ok(d2.versus.find((v: any) => v.brief === 'poster').wins);
  assert.equal((await call(admin, '/v1/bench/baseline', { brief: 'nope', asset })).status, 400);
});

test('a real run is the owner\'s and needs the price it was shown', async () => {
  assert.equal((await call(admin, '/v1/bench/runs', { mode: 'real', briefs: ['poster'] })).status, 403);
  const est = await call(owner, '/v1/bench/estimate', { briefs: ['poster', 'sfx-door'] });
  assert.equal(est.status, 200);
  assert.equal(est.body.briefs, 2);
  assert.ok(est.body.total >= est.body.claude);
  const wrong = await call(owner, '/v1/bench/runs', { mode: 'real', briefs: ['poster'], confirmCost: -1 });
  assert.equal(wrong.status, 409);
  assert.ok(wrong.body.estimate);
  assert.equal((await call(owner, '/v1/bench/runs', { mode: 'mock', briefs: ['nope'] })).status, 400);
});

test('the cast\'s references are set by asset id', async () => {
  const d = (await call(admin, '/v1/bench')).body;
  const ref = (await call(admin, `/v1/bench/runs/${d.runs.find((r: any) => r.mode === 'mock').id}`)).body.results[0].asset;
  assert.equal((await call(admin, '/v1/bench/cast/maya', { assets: [ref] }, 'PUT')).status, 200);
  assert.deepEqual((await call(admin, '/v1/bench')).body.cast.find((c: any) => c.id === 'maya').assets, [ref]);
  assert.equal((await call(admin, '/v1/bench/cast/maya', { assets: ['a_nothere'] }, 'PUT')).status, 404);
  assert.equal((await call(admin, '/v1/bench/cast/nobody', { assets: [] }, 'PUT')).status, 404);
});

test('the quality tools are registered with their inputs', () => {
  for (const id of ['quality.identity', 'quality.checklist', 'quality.assess']) assert.ok(getTool(id), id);
  assert.equal(getTool('quality.assess')!.params.brief.required, true);
  assert.equal(getTool('quality.identity')!.inputs.refs.multiple, true);
});
