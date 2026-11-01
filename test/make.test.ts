// The making loop (src/make/, docs/make.md): routing as data, previews then a final, a failed check turned into a
// targeted retry, the budget stop, "this one needs you", the hero tournament, provider fallbacks, the worst-case quote,
// the tenancy checks and learning from feedback. Every child job, every check and every comparison is a fake: no GPU,
// no Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-make-'));
// tools/index first: it imports src/make/tool.ts.
const { getTool } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const { putAsset } = await import('../src/library.ts');
const { quoteJobCredits, childCredits } = await import('../src/billing.ts');
const { events } = await import('../src/bus.ts');
const { db } = await import('../src/db.ts');
const { route } = await import('../src/make/index.ts');
const { routing, routingRaw, checkRouting, pickTools } = await import('../src/make/routing.ts');
const { buildPlan } = await import('../src/make/plan.ts');
const { runLoop, applyFix, worstCase, ProviderFailure } = await import('../src/make/loop.ts');
const { MAKE_DEFAULTS, saveMakeSettings, makeSettings } = await import('../src/make/settings.ts');
const mk = await import('../src/make/tool.ts');
const fb = await import('../src/make/feedback.ts');
const { notes } = await import('../src/knowledge.ts');

const info = (id: string) => {
  const t = getTool(id);
  return t ? { output: t.output, params: t.params, inputs: t.inputs } : null;
};
const ctxAll = { has: (id: string) => Boolean(getTool(id)), inputsOf: (id: string) => getTool(id)?.inputs ?? null };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d40000000049454e44ae426082', 'hex');

// ------------------------------------------------------------------------------------------------ routing

test('routing data names only real tools, params and inputs', () => {
  assert.deepEqual(checkRouting(routingRaw(), info), []);
  for (const intent of mk.MAKE_INTENTS) assert.ok(routingRaw().intents[intent]?.length, `${intent} has rules`);
});

test('routing per intent: the first matching rule, tools this Gen can run, fallbacks in order', () => {
  const r = (req: any, ctx: any = {}) => route(req, { ...ctxAll, ...ctx });
  assert.equal(r({ intent: 'image' }).tool, 'image.generate');
  assert.equal(r({ intent: 'image', refs: { identity: ['a_0123456789'] } }).tool, 'image.edit');
  assert.equal(r({ intent: 'image', params: { lora: 'a_0123456789' } }).tool, 'image.character');
  // The SSH fleet is down: the LoRA tool is skipped, the edit takes over.
  assert.equal(r({ intent: 'image', params: { lora: 'a_0123456789' }, refs: { identity: ['a_0123456789'] } }, { ready: (id: string) => id !== 'image.character' }).tool, 'image.edit');

  const talk = r({ intent: 'shot-dialogue', inputs: { image: 'asset:a_1', audio: 'asset:a_2' } });
  assert.deepEqual([talk.tool, ...talk.fallbacks], ['video.perform', 'video.lipsync', 'video.talk']);
  const two = r({ intent: 'shot-dialogue', inputs: { image: 'asset:a_1', audio: 'asset:a_2', audio2: 'asset:a_3' }, params: { people: 2 } });
  assert.equal(two.tool, 'video.talk');

  const act = r({ intent: 'shot-action', inputs: { control: 'asset:a_1', image: 'asset:a_2' } });
  assert.deepEqual([act.tool, ...act.fallbacks], ['video.control', 'video.control-wan']);
  assert.equal(r({ intent: 'shot-action', inputs: { image: 'asset:a_2' } }).tool, 'video.i2v');

  const pair = { intent: 'shot-two-people', refs: { identity: ['a_0123456789', 'a_9876543210'] }, inputs: { set: 'asset:a_3' } };
  assert.deepEqual([r(pair).tool, ...r(pair).fallbacks], ['video.scene'], 'paid partner models only when allowed');
  assert.ok(r(pair).skipped!.some((s) => s.tool === 'video.seedance' && /paid/.test(s.why)));
  // Its partner model also takes the scene's sound.
  assert.deepEqual(r({ ...pair, inputs: { ...pair.inputs, audio: 'asset:a_4' } }, { allowPaid: true }).fallbacks, ['video.seedance']);

  assert.equal(r({ intent: 'shot-continue', inputs: { image: 'asset:a_1' } }).tool, 'video.extend');
  assert.equal(r({ intent: 'shot-recast', inputs: { image: 'asset:a_1', video: 'asset:a_2' } }).tool, 'video.replace');
  assert.throws(() => r({ intent: 'shot-recast', inputs: { image: 'asset:a_1' } }), /needs video/);
  assert.equal(r({ intent: 'voice' }).tool, 'audio.voice');
  assert.equal(r({ intent: 'image', tool: 'image.panorama' }).why, 'pinned');
  assert.throws(() => pickTools({ intent: 'image' } as any, { ...ctxAll, has: () => false }), /Nothing can make this/);
});

// ------------------------------------------------------------------------------------------------ the plan

test('the plan applies the world (style, negative, canon, board) and the cast (description, references)', () => {
  const world: any = { worldId: 'wld_frozen', title: 'Frozen moon', look: { style: 'cold blue film still, anamorphic', negative: 'neon', palette: [], board: [], grade: null }, canon: ['the moon is always red'], characters: [], places: [], props: [] };
  const identity = { refs: ['a_aaaaaaaaaa', 'a_bbbbbbbbbb'], files: ['/x/a.png'], words: 'Mira, a tall smuggler with a scar over her left eye.', lora: null };
  const plan = buildPlan({ intent: 'image', brief: 'Mira holds a lantern in a cave', refs: { identity: identity.refs } }, { data: routingRaw(), settings: MAKE_DEFAULTS, world, identity, boardFiles: ['/x/board.png'], toolInfo: info, routeCtx: ctxAll });
  assert.equal(plan.first.tool, 'image.edit');
  assert.equal(plan.first.params.prompt, 'Mira, a tall smuggler with a scar over her left eye. Mira holds a lantern in a cave cold blue film still, anamorphic');
  assert.equal(plan.first.params.negative, 'neon');
  assert.deepEqual(plan.first.inputs.images, ['asset:a_aaaaaaaaaa', 'asset:a_bbbbbbbbbb']);
  assert.match(plan.brief, /the moon is always red/);
  assert.deepEqual(plan.style, { refs: ['/x/board.png'], words: 'cold blue film still, anamorphic' });
  assert.deepEqual(plan.identityRefs, ['/x/a.png']);
  assert.equal(plan.budget, MAKE_DEFAULTS.defaultBudget);
  // A request's own params win; a param the tool doesn't take is dropped.
  const p2 = buildPlan({ intent: 'image', brief: 'a door', params: { width: 768, bogus: 1 } }, { data: routingRaw(), settings: MAKE_DEFAULTS, world: null, identity: { refs: [], files: [], words: '', lora: null }, toolInfo: info, routeCtx: ctxAll });
  assert.equal(p2.first.params.width, 768);
  assert.equal('bogus' in p2.first.params, false);
});

test('a failed check becomes a targeted change', () => {
  const tp: any = { tool: 'video.control', kind: 'video', entry: routingRaw().tools['video.control'], params: { prompt: 'she walks to the door', strength: 1, negative: '' }, inputs: {} };
  const f = applyFix(tp, { pass: false, checklist: { score: 0.5, answers: [{ q: 'Is she holding the lantern?', yes: false, why: 'empty hands' }] }, faults: { ok: false, faults: ['melted face'] }, fix: 'too stiff, like a puppet' }, { seed: 100, attempt: 0 });
  assert.match(f.params.prompt, /Make sure: Is she holding the lantern\./);
  assert.match(f.params.prompt, /too stiff/);
  assert.equal(f.params.negative, 'melted face');
  assert.equal(f.params.strength, 0.85);
  assert.notEqual(f.seed, 100, 'a broken take gets a new seed');
  const g = applyFix({ ...tp, params: { prompt: 'x', strength: 0.7 } }, { pass: false, fix: 'it ignores the stage blocking' }, { seed: 5, attempt: 1 });
  assert.equal(g.params.strength, 0.85);
});

// ------------------------------------------------------------------------------------------------ the loop on fakes

const failReport = (q = 'Is she holding the lantern?', fix = 'show the lantern in her right hand') => ({ pass: false, checklist: { score: 0.4, answers: [{ q, yes: false, why: 'not there' }] }, faults: { ok: true, faults: [] }, fix });
const passReport = (score = 1) => ({ pass: true, checklist: { score, answers: [] }, faults: { ok: true, faults: [] } });

/** A fake Gen: each child is done at once, its output a real library file. `fail(tool)` makes a child fail. */
function fakeGen(o: { fail?: (tool: string) => boolean } = {}) {
  const calls: { tool: string; spec: any }[] = [];
  mk._setMakeClient(() => ({
    submit: async (tool: string, spec: any) => {
      calls.push({ tool, spec });
      if (o.fail?.(tool)) return { id: `j_${calls.length}`, tool, status: 'failed', error: 'the server went away', outputs: [] };
      const out = getTool(tool)!.output;
      const a = putAsset({ data: out === 'video' ? Buffer.from(`video ${calls.length}`) : PNG, ext: out === 'video' ? '.mp4' : '.png', client: 'gen', project: 'usr_make', tool, seed: spec.params.seed ?? null, recipe: { tool, version: 1, params: spec.params, inputs: spec.inputs } as any });
      return { id: `j_${calls.length}`, tool, status: 'done', outputs: [{ asset: a.id, kind: a.kind }] };
    },
    wait: async () => { throw new Error('children finish at once here'); },
  }));
  return calls;
}

async function runMake(params: Record<string, unknown>, deps: any = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'make-run-'));
  const tool = getTool('make.checked')!;
  const emitted: any[] = [];
  const log: string[] = [];
  let result: any = null;
  mk._setMakeDeps({ quote: () => 10, ...deps });
  try {
    await tool.run({
      job: { id: 'j_parent', client: 't', project: 'usr_make', tool: 'make.checked', labels: {} }, params: validateParams(tool, params), inputs: {},
      done: 0, outputs: [], signal: new AbortController().signal, step: () => {}, log: (l: string) => log.push(l), tmp: (n: string) => path.join(work, n),
      emit: async (o: any) => { emitted.push(o); }, result: (v: any) => { result = v; }, seed: () => 1, usage: () => {}, python: async () => '',
    } as any);
  } finally {
    mk._setMakeDeps(null);
    mk._setMakeClient(null);
  }
  return { result, emitted, log };
}

test('an image: two cheap previews, then the best one at full settings with the same seed', async () => {
  const calls = fakeGen();
  let n = 0;
  // The second preview scores higher than the first.
  const assess = async () => (++n === 1 ? passReport(0.9) : passReport(1));
  const { result, emitted } = await runMake({ intent: 'image', brief: 'a brass lantern on a stone floor' }, { assess });
  assert.deepEqual(calls.map((c) => c.tool), ['image.generate', 'image.generate', 'image.generate']);
  assert.equal(calls[0].spec.params.width, 512);
  assert.equal(calls[1].spec.params.width, 512);
  assert.equal(calls[2].spec.params.width, 1024, 'the final at full size');
  assert.equal(calls[2].spec.params.seed, calls[1].spec.params.seed, 'the same seed as the best preview');
  assert.equal(calls[2].spec.labels.parent, 'j_parent');
  assert.equal(calls[2].spec.reuse, true);
  assert.equal(result.report.pass, true);
  assert.equal(result.tries, 1);
  assert.equal(result.credits, 3 * 10 + 3 * MAKE_DEFAULTS.checkCredits);
  assert.equal(result.needsYou, undefined);
  assert.deepEqual(result.takes.map((t: any) => t.stage), ['preview', 'preview', 'final']);
  assert.equal(emitted[0].title, 'result');
});

test('a failed final check is fixed and retried, and the retry passes', async () => {
  const calls = fakeGen();
  const assess = async (a: any) => {
    const take = calls.at(-1)!;
    if (take.spec.params.width === 512) return passReport();
    return String(take.spec.params.prompt).includes('lantern in her right hand') ? passReport() : failReport();
  };
  const { result } = await runMake({ intent: 'image', brief: 'Mira holds a lantern' }, { assess });
  assert.equal(result.tries, 2);
  assert.equal(result.report.pass, true);
  assert.ok(result.changes.some((c: string) => /added to the prompt: Make sure: Is she holding the lantern/.test(c)));
  const finals = calls.filter((c) => c.spec.params.width === 1024);
  assert.equal(finals.length, 2);
  assert.match(finals[1].spec.params.prompt, /show the lantern in her right hand/);
});

test('the budget stops the loop before it overspends, with the best take so far', async () => {
  const calls = fakeGen();
  const { result } = await runMake({ intent: 'image', brief: 'a lantern', budgetCredits: 25 }, { assess: async () => passReport() });
  // Two previews (10 + 2 each) fit in 25; the final (12 more) doesn't.
  assert.equal(calls.length, 2);
  assert.equal(result.stopped, 'budget');
  assert.ok(result.credits <= 25);
  assert.match(result.needsYou, /25 credits/);
  assert.match(result.needsYou, /quick preview/);
  assert.ok(result.asset);
});

test('every try fails: the best take comes back with "this one needs you", in plain words', async () => {
  const calls = fakeGen();
  const { result } = await runMake({ intent: 'image', brief: 'a lantern' }, { assess: async () => failReport() });
  assert.equal(result.tries, 3, 'two retries at most');
  assert.equal(result.report.pass, false);
  assert.match(result.needsYou, /None of the \d+ takes passed every check/);
  assert.match(result.needsYou, /holding the lantern/);
  assert.doesNotMatch(result.needsYou, /z-image|comfy|gpu|runpod|claude/i);
  assert.equal(calls.filter((c) => c.spec.params.width === 1024).length, 1, 'failing previews never paid for a final until the last try');
  assert.ok(result.asset);
});

test('a draft is one take and one check', async () => {
  const calls = fakeGen();
  const { result } = await runMake({ intent: 'image', brief: 'a lantern', quality: 'draft' }, { assess: async () => failReport() });
  assert.equal(calls.length, 1);
  assert.equal(result.tries, 1);
  assert.ok(result.needsYou);
});

test('an action shot on the stage, hero quality: three finals compared in pairs, the winner refined once', async () => {
  const calls = fakeGen();
  const compared: string[] = [];
  const compare = async (a: any, b: any) => {
    compared.push(`${a.stage}:${a.seed} vs ${b.stage}:${b.seed}`);
    // The later take wins each time; the rewrite asks for a slower walk.
    return { winner: 1 as const, why: 'steadier', refine: 'She walks slowly to the door, lantern raised, snow drifting.' };
  };
  const { result } = await runMake({ intent: 'shot-action', brief: 'she walks to the door with a lantern', quality: 'hero', inputs: { control: 'asset:a_00000001', image: 'asset:a_00000002' } }, { assess: async () => passReport(), compare });
  assert.deepEqual(calls.map((c) => c.tool), ['video.control', 'video.control', 'video.control', 'video.control']);
  assert.equal(compared.length, 3, 'two rounds, then the refined take against the winner');
  assert.equal(calls[3].spec.params.prompt, 'She walks slowly to the door, lantern raised, snow drifting.');
  assert.equal(calls[3].spec.params.seed, calls[2].spec.params.seed, 'refined on the winner\'s seed');
  assert.equal(calls[0].spec.inputs.control, 'asset:a_00000001');
  assert.equal(result.takes.at(-1).stage, 'refined');
  assert.equal(result.asset, result.takes.at(-1).asset);
  assert.equal(result.tool, 'video.control');
});

test('a dialogue close-up falls back to the next tool when a child fails on its servers', async () => {
  const calls = fakeGen({ fail: (t) => t === 'video.perform' });
  const { result, log } = await runMake({ intent: 'shot-dialogue', brief: 'Mira says "We leave at dawn."', inputs: { image: 'asset:a_00000003', audio: 'asset:a_00000004' } }, { assess: async () => passReport() });
  assert.equal(calls[0].tool, 'video.perform');
  assert.ok(calls.slice(1).every((c) => c.tool === 'video.lipsync'));
  assert.equal(result.tool, 'video.lipsync');
  assert.equal(result.report.pass, true);
  assert.ok(result.changes.some((c: string) => /switched/.test(c)));
  assert.ok(log.some((l) => /video\.perform failed/.test(l)));
  assert.equal(calls[1].spec.params.width, 640, 'the fallback makes its own preview');
});

test('runLoop throws a provider failure on when no fallback is left', async () => {
  const plan = buildPlan({ intent: 'voice', brief: 'hello' }, { data: routingRaw(), settings: MAKE_DEFAULTS, world: null, identity: { refs: [], files: [], words: '', lora: null }, toolInfo: info, routeCtx: ctxAll });
  await assert.rejects(runLoop(plan, { render: async () => { throw new ProviderFailure('down'); }, assess: async () => passReport() as any, quote: () => 1, compare: async () => ({ winner: 0, why: '' }), log: () => {}, step: () => {} }), /down/);
});

// ------------------------------------------------------------------------------------------------ the quote

test('the quote is the loop\'s worst case, capped by the budget', () => {
  const q = quoteJobCredits('make.checked', { intent: 'image', brief: 'a lantern' }, 'usr_make');
  const one = childCredits('image.generate', { prompt: 'a lantern', width: 1024, height: 1024 }, 'usr_make');
  const prev = childCredits('image.generate', { prompt: 'a lantern', width: 512, height: 512 }, 'usr_make');
  const c = MAKE_DEFAULTS.checkCredits;
  assert.equal(q.credits, Math.min(MAKE_DEFAULTS.defaultBudget!, 3 * (2 * (prev + c) + one + c)));
  assert.ok(q.breakdown.length >= 2);
  assert.equal(quoteJobCredits('make.checked', { intent: 'image', brief: 'a lantern', budgetCredits: 12 }, 'usr_make').credits, 12);

  const draft = quoteJobCredits('make.checked', { intent: 'image', brief: 'a lantern', quality: 'draft' }, 'usr_make').credits;
  assert.equal(draft, Math.max(one + c, 5), 'a draft keeps the tool floor');
  const plan = buildPlan({ intent: 'image', brief: 'x', quality: 'hero' }, { data: routingRaw(), settings: MAKE_DEFAULTS, world: null, identity: { refs: [], files: [], words: '', lora: null }, toolInfo: info, routeCtx: ctxAll });
  const w = worstCase({ ...plan, budget: null }, () => 10);
  assert.equal(w.credits, 3 * 12 + (3 * 2 + 12) + 2 * 12);
});

// ------------------------------------------------------------------------------------------------ tenancy

test('admit: a customer names only its own files; pins only generative tools', () => {
  const t = getTool('make.checked')!;
  const mine = putAsset({ data: PNG, ext: '.png', client: 'c1', project: 'usr_aaaa', tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any });
  const theirs = putAsset({ data: PNG, ext: '.png', client: 'c2', project: 'usr_bbbb', tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any });
  const client = { id: 'c1', name: 'c1', role: 'user', projects: ['usr_aaaa'] };
  const call = (p: any) => t.admit!({ params: validateParams(t, { intent: 'image', brief: 'x', ...p }), client, project: 'usr_aaaa', customer: true });
  call({ inputs: { image: `asset:${mine.id}` }, refs: { identity: [mine.id] } });
  assert.throws(() => call({ inputs: { image: `asset:${theirs.id}` } }), /No access/);
  assert.throws(() => call({ refs: { identity: [theirs.id] } }), /No access/);
  assert.throws(() => call({ refs: { style: [`asset:${theirs.id}`] } }), /No access/);
  assert.throws(() => call({ params: { lora: theirs.id } }), /No access/);
  assert.throws(() => call({ inputs: { image: 'C:/secret.png' } }), /asset:<id> or blob/);
  assert.throws(() => call({ inputs: { image: 'blob:' + 'f'.repeat(64) } }), /No blob/);
  assert.throws(() => call({ tool: 'unity.build' }), /can't pin/);
  call({ tool: 'image.panorama' });
});

// ------------------------------------------------------------------------------------------------ settings

test('owner settings are checked and kept', () => {
  const s = saveMakeSettings({ maxRetries: 9, defaultBudget: 120, allowPaid: true, thresholds: { checklist: 0.9, bogus: 3 } as any });
  assert.equal(s.maxRetries, 2);
  assert.equal(s.defaultBudget, 120);
  assert.deepEqual(s.thresholds, { checklist: 0.9 });
  assert.equal(makeSettings().allowPaid, true);
  saveMakeSettings({ ...MAKE_DEFAULTS });
  assert.deepEqual(makeSettings(), MAKE_DEFAULTS);
});

// ------------------------------------------------------------------------------------------------ learning

test('feedback aggregates into proposals: a setting that keeps getting redone, a repeated complaint, a routing change', () => {
  const add = (n: number, f: any) => { for (let i = 0; i < n; i++) fb.recordFeedback({ project: 'usr_make', source: 'test', ...f }); };
  add(7, { kind: 'redo', tool: 'video.perform', intent: 'shot-dialogue', params: { strength: 0.9 } });
  add(3, { kind: 'pick', tool: 'video.perform', intent: 'shot-dialogue', params: { strength: 0.9 } });
  add(1, { kind: 'redo', tool: 'video.perform', intent: 'shot-dialogue', params: { strength: 0.6 } });
  add(5, { kind: 'pick', tool: 'video.perform', intent: 'shot-dialogue', params: { strength: 0.6 } });
  add(3, { kind: 'complaint', tool: 'video.perform', intent: 'shot-dialogue', params: {}, note: 'Too stiff!' });
  add(1, { kind: 'discard', tool: 'video.lipsync', intent: 'shot-dialogue', params: {} });
  add(6, { kind: 'rating', rating: 5, tool: 'video.lipsync', intent: 'shot-dialogue', params: {} });
  assert.throws(() => fb.recordFeedback({ kind: 'meh', tool: 'x' }), /kind is one of/);

  const drafts = fb.summarize(fb.listFeedback({ limit: 1000 }), routingRaw());
  const strength = drafts.find((d) => d.key.startsWith('note:video.perform:strength'))!;
  assert.ok(strength, JSON.stringify(drafts.map((d) => d.title)));
  assert.match(strength.title, /video\.perform with strength over 0\.6 got redone 70% of the time \(7 of 10\)/);
  assert.equal(strength.evidence.rejected, 7);
  const said = drafts.find((d) => d.key === 'note:video.perform:said:too stiff')!;
  assert.match(said.title, /People said "too stiff" 3 times/);
  const r = drafts.find((d) => d.kind === 'routing')!;
  assert.deepEqual(r.change.tools.slice(0, 2), ['video.lipsync', 'video.perform']);

  // Filed once; nothing applies until the owner approves.
  const run = fb.runSummary({});
  assert.ok(run.proposed.length >= 3);
  assert.equal(fb.runSummary({}).proposed.length, 0, 'never proposed twice');
  assert.equal(routing().intents['shot-dialogue'][0].tools[0], 'video.perform');
  assert.equal(notes()['video.perform']?.measured ?? false, false);

  const routingP = fb.listProposals('open').find((p) => p.kind === 'routing' && p.change.rule === 0)!;
  fb.decideProposal(routingP.id, { approve: true, by: 'J' });
  assert.equal(routing().intents['shot-dialogue'][0].tools[0], 'video.lipsync', 'approved: the overlay applies');
  assert.equal(routingRaw().intents['shot-dialogue'][0].tools[0], 'video.perform', 'the file is untouched without write');
  const noteP = fb.listProposals('open').find((p) => p.key.startsWith('note:video.perform:strength'))!;
  fb.decideProposal(noteP.id, { approve: true });
  const n = notes()['video.perform'];
  assert.equal(n.measured, true);
  assert.ok(n.iterate!.some((l) => /Measured: video\.perform with strength over 0\.6/.test(l)));
  assert.match(n.settings!.strength, /keep strength at or under 0\.6/);
  const said2 = fb.listProposals('open').find((p) => p.key.includes(':said:'))!;
  fb.decideProposal(said2.id, { approve: false });
  assert.throws(() => fb.decideProposal(said2.id, { approve: true }), /already rejected/);
  // Clean up the overlay for the other tests.
  db.exec("DELETE FROM make_proposals");
});

test('feedback on an asset finds its recipe, and library picks are recorded', () => {
  const a = putAsset({ data: PNG, ext: '.png', client: 'gen', project: 'usr_make', tool: 'image.generate', recipe: { tool: 'image.generate', version: 1, params: { prompt: 'a lantern', width: 1024 }, inputs: {} } as any });
  const f = fb.recordFeedback({ kind: 'rating', rating: 2, asset: a.id, source: 'test' })!;
  assert.equal(f.tool, 'image.generate');
  assert.equal(f.params.width, 1024);
  assert.equal(fb.isNegative(f), true);
  // make.checked's result copy points back at its take.
  const copy = putAsset({ data: PNG, ext: '.png', client: 'gen', project: 'usr_make', tool: 'make.checked', recipe: { tool: 'make.checked', version: 1, params: {}, inputs: {} } as any, meta: { from: a.id } });
  assert.equal(fb.recordFeedback({ kind: 'redo', asset: copy.id })!.tool, 'image.generate');
  const up = putAsset({ data: PNG, ext: '.png', client: 'c', project: 'usr_make', tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any });
  assert.equal(fb.recordFeedback({ kind: 'discard', asset: up.id }), null, 'uploads teach nothing');

  fb.startMakeLearning();
  db.prepare("INSERT OR IGNORE INTO entities (id, project, slug, kind, name, data, tags, created, updated) VALUES ('usr_make/hero', 'usr_make', 'hero', 'character', 'Hero', '{}', '[]', 0, 0)").run();
  db.prepare("INSERT INTO versions (id, entity, slot, n, asset, status, created, updated) VALUES ('v_0001', 'usr_make/hero', 'portrait', 1, ?, 'current', 0, 0)").run(a.id);
  const before = fb.listFeedback({ tool: 'image.generate' }).length;
  events.emit('library', { type: 'version', entity: 'usr_make/hero', slot: 'portrait', version: 'v_0001', status: 'current' });
  const after = fb.listFeedback({ tool: 'image.generate' });
  assert.equal(after.length, before + 1);
  assert.equal(after[0].kind, 'pick');
  assert.equal(after[0].source, 'library');
});

test('replaceEntry rewrites one entry of a JSON file and keeps the rest exactly', () => {
  const text = '{\n  "_about": "x",\n\n  "a": { "role": "keep {braces} \\" here" },\n  "b": {"x": [1, 2]}\n}\n';
  const out = fb.replaceEntry(text, 'b', { x: [3] });
  assert.ok(out.startsWith('{\n  "_about": "x",\n\n  "a": { "role": "keep {braces} \\" here" },\n  "b": {'));
  assert.deepEqual(JSON.parse(out).b, { x: [3] });
  assert.deepEqual(JSON.parse(fb.replaceEntry(text, 'c', { y: 1 })).c, { y: 1 });
});
