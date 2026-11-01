// The showrunner (src/showrunner/, docs/showrunner.md): one entry for the AI pane, the planner and its critique, the
// approval card's price, productions on the server (with a restart in the middle), the fallback when make.checked isn't
// on this Gen, the review pass, review mode's new takes, and the per-account memory. Claude, the queue and every tool
// are mocked: nothing here spends money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-showrunner-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.HAWKESGEN_SHOWRUNNER_RUNNER = '0';
delete process.env.ANTHROPIC_API_KEY;

const { setDeps } = await import('../src/showrunner/deps.ts');
const { classify, refersToResults, secondsIn } = await import('../src/showrunner/classify.ts');
const { normalizePlan, lintPlan } = await import('../src/showrunner/plan.ts');
const { compileSteps, cardFor, toolFor } = await import('../src/showrunner/steps.ts');
const sr = await import('../src/showrunner/index.ts');
const prod = await import('../src/showrunner/production.ts');
const mem = await import('../src/showrunner/memory.ts');
const scenes = await import('../src/scenes.ts');

const PROJECT = 'u_5h0wrunner01';
const CLIENT = { id: 'u_test', name: 'tester', role: 'owner' as const, projects: ['*'] };
const PRICES: Record<string, number> = { 'image.generate': 4, 'image.edit': 5, 'video.i2v': 30, 'video.talk': 25, 'video.scene': 60, 'audio.voice': 2, 'audio.music': 8, 'make.checked': 50 };

// ------------------------------------------------------------------ the mocks
const PLAN = (axisBroken: boolean) => ({
  title: 'The Keeper', kind: 'trailer', logline: 'A lonely lighthouse keeper befriends the sea creature everyone fears.', seconds: 60, aspect: '16:9',
  world: { id: null, title: 'Gray Coast', tone: 'quiet, mythic', style: 'cinematic 35mm, overcast teal and amber', negative: 'cartoon', palette: ['#30454f', '#d09a4a'], canon: ['No one says "the Drowned One"'] },
  characters: [
    { key: 'c1', name: 'Mara', description: 'A weathered woman in her sixties, gray braid, yellow oilskin coat, rubber boots, deep-set blue eyes, a scar across her left hand.', voice: 'hv_ash', role: 'the keeper' },
    { key: 'c2', name: 'Tide', description: 'A huge eel-like sea creature, slate skin with bioluminescent blue spots, large gentle black eyes, a fringe of fins.', voice: null, role: 'the creature' },
  ],
  places: [{ key: 'p1', name: 'The lighthouse', description: 'A white stone lighthouse on black rocks, storm sky, crashing surf, a lamp sweeping the dusk.' }],
  beats: [{ key: 'b1', text: 'The keeper alone' }, { key: 'b2', text: 'Something in the water' }, { key: 'b3', text: 'They meet' }],
  script: [{ beat: 'b1', text: 'MARA climbs the stairs.' }],
  shots: [
    { key: 's1', beat: 'b1', place: 'p1', cast: [], type: 'establishing', seconds: 10, angle: 0, framing: 'wide', move: 'push-in', action: 'Waves crash below the lighthouse as its lamp sweeps the dusk.' },
    { key: 's2', beat: 'b1', place: 'p1', cast: ['c1'], type: 'action', seconds: 10, angle: 20, framing: 'medium', move: 'follow', action: 'Mara climbs the spiral stairs with a lantern.' },
    { key: 's3', beat: 'b2', place: 'p1', cast: ['c1'], type: 'dialogue', seconds: 10, angle: 10, framing: 'close', move: 'static', action: 'Mara peers at the dark water.', lines: [{ who: 'c1', text: 'I know you are out there.', direction: 'quiet, certain' }] },
    { key: 's4', beat: 'b3', place: 'p1', cast: ['c1', 'c2'], type: 'two-people', seconds: 10, angle: 30, framing: 'wide', move: 'static', action: 'Tide rises from the surf in front of Mara.' },
    { key: 's5', beat: 'b3', place: 'p1', cast: ['c1', 'c2'], type: 'action', seconds: 10, angle: axisBroken ? 160 : 40, framing: 'medium', move: 'orbit', action: 'Mara reaches out a scarred hand toward Tide.' },
    { key: 's6', beat: 'b3', place: 'p1', cast: ['c2'], type: 'action', seconds: 10, angle: 30, framing: 'close', move: 'push-in', action: 'Tide closes its eyes as her hand touches its skin.' },
  ],
  music: { brief: 'sparse piano and low strings, swelling at the meeting' },
});

type MockJob = { id: string; tool: string; params: any; inputs: any; labels: any; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; outputs: any[]; error: string | null; result?: any };
function mocks(o: { checked?: boolean; failAssess?: string[]; jobs?: Map<string, MockJob> } = {}) {
  const jobs = o.jobs ?? new Map<string, MockJob>();
  const asks: any[] = [];
  const charged: number[] = [];
  let n = jobs.size;
  const hex = (i: number) => i.toString(16).padStart(8, '0');
  setDeps({
    async ask(_project, p) {
      asks.push(p);
      const sys = String(p.system ?? '');
      let answer: any;
      if (sys.includes('script supervisor')) answer = { ok: true, issues: [], plan: PLAN(false) };
      else if (sys.includes('showrunner of Hawkes Gen')) answer = { say: 'Here is a teaser in six shots.', plan: PLAN(true) };
      else if (sys.includes('fixing one shot')) answer = { brief: 'Her braid is gray and her coat is yellow oilskin.', redoFrame: true, say: 'New take of that shot.' };
      else if (sys.includes('look at frames')) return { text: 'In shot 2 her coat turns red; it should be yellow.', cost: 0.01, house: true, model: 'm' };
      else answer = {};
      return { text: JSON.stringify(answer), cost: 0.02, house: true, model: 'mock' };
    },
    submit(_client, spec) {
      const id = `j_${hex(++n)}`;
      jobs.set(id, { id, tool: spec.tool, params: spec.params, inputs: spec.inputs, labels: spec.labels, status: 'queued', outputs: [], error: null });
      return { id };
    },
    job: (id) => (jobs.get(id) as any) ?? null,
    cancel: (id) => { const j = jobs.get(id); if (j && (j.status === 'queued' || j.status === 'running')) j.status = 'cancelled'; },
    quote: (_p, tool) => PRICES[tool] ?? 3,
    hasTool: (id) => id !== 'make.checked' || Boolean(o.checked),
    assetPath: (id) => (/^a_[0-9a-f]{8}$/.test(id) ? path.join(os.tmpdir(), `${id}.bin`) : null),
    assetKind: () => 'video',
    frames: async () => ['f0.png', 'f1.png', 'f2.png'],
    frameAt: async () => 'frame.png',
    sheet: async (files) => (files.length ? 'sheet.png' : null),
    assess: async (a) => ({ pass: !(o.failAssess ?? []).some((k) => a.brief.includes(k)), fix: 'Keep her coat yellow.' }),
    chargeAi: (_payer, cost) => { charged.push(cost); return 1; },
  });
  /** Every queued job finishes (or the ones `pick` chooses), each with one output of its kind. */
  const finish = (pick: (j: MockJob) => boolean = () => true) => {
    for (const j of jobs.values()) {
      if (j.status !== 'queued' || !pick(j)) continue;
      const kind = /^video|shot/.test(j.tool) || j.params?.intent?.startsWith('shot') ? 'video' : /^audio|voice|music/.test(j.tool) || ['voice', 'music', 'sfx'].includes(j.params?.intent) ? 'audio' : 'image';
      j.status = 'done';
      j.outputs = [{ asset: `a_${hex(Number.parseInt(j.id.slice(2), 16) + 0x1000)}`, kind }];
    }
  };
  return { jobs, asks, charged, finish };
}
async function runToEnd(id: string, m: ReturnType<typeof mocks>, max = 30) {
  for (let i = 0; i < max; i++) {
    const p = await prod.advance(id);
    if (!p || p.status !== 'running') return p;
    m.finish();
  }
  return prod.getProduction(id);
}

// ------------------------------------------------------------------ classifying
test('a request is classified: small edits stay with the scene in front, productions go to the planner', () => {
  assert.equal(classify('a 60-second teaser about a lighthouse keeper and a sea creature', null).route, 'production');
  assert.equal(classify('a 60-second teaser about a lighthouse keeper and a sea creature', null).kind, 'trailer');
  assert.equal(classify('a 60-second teaser about a lighthouse keeper and a sea creature', null).seconds, 60);
  const pilot = classify('A 5-minute pilot about smugglers on a frozen moon', 'video');
  assert.equal(pilot.route, 'production');
  assert.equal(pilot.kind, 'show');
  assert.equal(pilot.seconds, 300);
  assert.equal(classify('Make a trailer for my world', 'video').route, 'production');
  assert.equal(classify('a new character for this story', 'video').kind, 'character');
  assert.equal(classify('make this slow motion', 'video').route, 'edit');
  assert.equal(classify('make this slow motion', 'video').role, 'editor');
  assert.equal(classify('tighten the cuts of the trailer here', 'video').route, 'edit');
  assert.equal(classify('move the camera behind her shoulder', 'stage').role, 'director');
  assert.equal(classify('make it night', 'image').role, 'art director');
  assert.equal(classify('make it 90 seconds instead', 'video', { planning: true }).route, 'production');
  assert.equal(secondsIn('a 2 min short'), 120);
  assert.deepEqual(refersToResults('fix the second shot'), { look: true, nth: 2 });
  assert.equal(refersToResults('her face changed').look, true);
  assert.equal(refersToResults('add music').look, false);
});

// ------------------------------------------------------------------ planning
test('lintPlan finds the 180° rule, continuity, pacing and canon breaks', () => {
  const p = normalizePlan(PLAN(true));
  assert.ok(lintPlan(p).some((x) => x.rule === 'axis' && x.shot === 's5'));
  assert.equal(lintPlan(normalizePlan(PLAN(false))).length, 0);
  const bad = normalizePlan({ ...PLAN(false), shots: [{ ...PLAN(false).shots[2], seconds: 1, lines: [{ who: 'c2', text: 'the Drowned One comes for us all tonight my friend' }] }] });
  const rules = lintPlan(bad).map((x) => x.rule);
  assert.ok(rules.includes('continuity'), 'a line by someone not in the shot');
  assert.ok(rules.includes('pacing'), 'lines longer than the shot, and the total off');
  assert.ok(rules.includes('canon'), 'a name nobody says');
});

test('a plan is written at high effort, critiqued, and comes back fixed with nothing left to flag', async () => {
  const m = mocks();
  const c = classify('a 60-second teaser about a lighthouse keeper and a sea creature', null);
  const ctx = await sr.planContext(PROJECT, c, [{ role: 'user', text: 'a 60-second teaser about a lighthouse keeper and a sea creature' }], null, null);
  const planned = await sr.makePlan(PROJECT, 'payer', ctx);
  assert.equal(m.asks[0].effort, 'high');
  assert.ok(m.asks.some((a) => String(a.system).includes('script supervisor')), 'a critique pass ran');
  assert.equal(planned.plan.shots.find((s) => s.key === 's5')!.angle, 40, 'the critique fixed the crossing');
  assert.deepEqual(planned.issues, []);
  assert.equal(planned.aiCredits, m.charged.length, 'house turns are charged');
});

// ------------------------------------------------------------------ the card
test("the approval card counts what will be made and sums the quotes; make.checked is priced at its worst case", () => {
  mocks();
  const plan = normalizePlan(PLAN(false));
  const steps = sr.priceSteps(PROJECT, compileSteps(plan, {}));
  const card = cardFor(plan, steps, { title: '', logline: '', seconds: 0, world: null, characters: [], places: [], beats: [], shots: [] });
  assert.equal(card.counts.shots, 6);
  assert.equal(card.counts.characters, 2);
  assert.equal(card.counts.places, 1);
  assert.equal(card.counts['voice lines'], 1);
  assert.equal(card.counts.clips, 6);
  assert.equal(card.counts.pictures, 3 + 6, 'two characters and a place, then a first frame per shot');
  const want = 2 * 4 + 4 + 6 * 5 + 2 + 25 + 60 + 4 * 30 + 8;
  assert.equal(card.credits, want);
  assert.equal(card.fixCredits, Math.ceil((25 + 60 + 4 * 30) * 0.25));
  assert.ok(card.minutes >= 1);
  mocks({ checked: true });
  const checked = sr.priceSteps(PROJECT, compileSteps(plan, {}));
  assert.ok(checked.filter((s) => s.make).every((s) => s.credits === 50));
});

// ------------------------------------------------------------------ the whole thing
test('a sentence becomes a plan, a card with a price, and a production that runs on the server to a cut, through a restart', async () => {
  let m = mocks();
  const turn = await sr.showrunnerTurn({
    client: CLIENT, project: PROJECT, payer: 'payer', messages: [{ role: 'user', text: 'a 60-second teaser about a lighthouse keeper and a sea creature' }],
    scene: null, autoCredits: 40, delegate: async () => { throw new Error('no delegate for productions'); },
  });
  assert.equal(turn.body.role, 'showrunner');
  assert.equal(turn.body.route, 'production');
  const card = turn.body.production.card;
  assert.ok(card.credits > 40, 'priced over the auto limit');
  assert.equal(turn.body.production.status, 'proposed', 'waits for Approve');
  assert.equal(m.jobs.size, 0, 'nothing costs anything before approval');
  const id = turn.body.production.id;
  assert.throws(() => prod.approve(prod.getProduction(id)!, { credits: 10 }), /needs/);
  prod.approve(prod.getProduction(id)!, { credits: 10_000 });
  // A few passes, then the server "restarts": a fresh set of dependencies over the same queue and database.
  for (let i = 0; i < 3; i++) { await prod.advance(id); m.finish(); }
  const mid = prod.getProduction(id)!;
  assert.equal(mid.status, 'running');
  assert.ok(mid.steps.some((s) => s.status === 'done') && mid.steps.some((s) => s.status === 'waiting'));
  m = mocks({ jobs: m.jobs });
  await prod.advanceAll();
  const p = (await runToEnd(id, m))!;
  assert.equal(p.status, 'done', p.error ?? '');
  // What it made: the characters (with their front pictures), the stage shots in a sequence, the cut.
  const can = (x: string) => x === PROJECT;
  const mara = scenes.getScene(p.out.characters.c1, can);
  assert.equal(mara.kind, 'character');
  assert.equal(mara.doc.pictures[0].role, 'front');
  assert.equal(Object.keys(p.out.shots).length, 6);
  assert.ok(p.out.sequence);
  const cut = scenes.getScene(p.out.cut!, can);
  assert.equal(cut.kind, 'video');
  const vids = cut.doc.clips.filter((c: any) => c.kind === 'video');
  assert.equal(vids.length, 6);
  assert.deepEqual(vids.map((c: any) => c.start), [0, 10, 20, 30, 40, 50]);
  assert.equal(cut.doc.clips.filter((c: any) => c.kind === 'audio').length, 2, 'the line and the score');
  assert.equal(Object.keys(p.out.clips).length, 6);
  assert.ok(p.out.storyDoc?.beats?.length || p.out.story, 'the story is kept (as a story scene when that kind exists)');
  // Shots render onto their stage shots; the dialogue shot talked to its line.
  assert.equal(scenes.getScene(p.out.shots.s2, can).doc.render.kind, 'video');
  assert.ok([...m.jobs.values()].some((j) => j.tool === 'video.talk' && String(j.inputs.audio).startsWith('asset:a_')));
  assert.equal(new Set([...m.jobs.values()].map((j) => j.labels.production)).size, 1);
  // The memory learned the look and the pacing.
  const memory = mem.getMemory(PROJECT);
  assert.equal(memory.looks[0], 'cinematic 35mm, overcast teal and amber');
  assert.equal(memory.pacing.shotSeconds, 10);
  (globalThis as any).__cut = { id: p.out.cut, production: id };
});

test('without make.checked every step goes to its routed tool; with it, every step goes through make.checked', () => {
  const plan = normalizePlan(PLAN(false));
  const steps = compileSteps(plan, {});
  const shot = steps.find((s) => s.id === 'shot:s2')!;
  const without = toolFor(shot, () => false);
  assert.equal(without.checked, false);
  assert.equal(without.tool, 'video.i2v');
  assert.equal(without.inputs.start, '$step:frame:s2');
  assert.equal(toolFor(steps.find((s) => s.id === 'line:s3:0')!, () => false).tool, 'audio.voice');
  assert.equal(toolFor(steps.find((s) => s.id === 'shot:s3')!, () => false).tool, 'video.talk');
  assert.equal(toolFor(steps.find((s) => s.id === 'shot:s4')!, () => false).tool, 'video.scene');
  const withIt = toolFor(shot, (id) => id === 'make.checked');
  assert.equal(withIt.tool, 'make.checked');
  assert.equal(withIt.params.intent, 'shot-action');
  assert.equal(withIt.params.brief.length > 10, true);
  assert.equal(withIt.params.project, undefined, 'params are a MakeRequest without project');
});

test('a production through make.checked submits only make.checked jobs, and files their best take', async () => {
  const m = mocks({ checked: true });
  const p0 = sr.proposeProduction({ project: PROJECT, client: CLIENT, payer: null, plan: normalizePlan(PLAN(false)), issues: [], world: null, autoCredits: 0 });
  prod.approve(p0);
  const p = (await runToEnd(p0.id, m))!;
  assert.equal(p.status, 'done');
  assert.ok([...m.jobs.values()].filter((j) => j.labels.production === p0.id).every((j) => j.tool === 'make.checked'));
  const shot = [...m.jobs.values()].find((j) => j.labels.step === 'shot:s2')!;
  assert.match(shot.params.inputs.start, /^asset:a_/, "earlier steps' files are passed as assets");
});

test('the review pass re-takes a shot that fails its checks, within the fix allowance, and cuts it in', async () => {
  const m = mocks({ failAssess: ['Mara climbs'] });
  const p0 = sr.proposeProduction({ project: PROJECT, client: CLIENT, payer: null, plan: normalizePlan(PLAN(false)), issues: [], world: null, autoCredits: 0 });
  prod.approve(p0);
  const p = (await runToEnd(p0.id, m))!;
  assert.equal(p.status, 'done');
  assert.equal(p.out.reviewed!.s2.pass, false);
  assert.equal(p.out.reviewed!.s2.retaken, true);
  const retake = p.steps.find((s) => s.id === 'retake:s2')!;
  assert.equal(retake.status, 'done');
  assert.match(retake.make!.params!.prompt, /Keep her coat yellow/);
  const cut = scenes.getScene(p.out.cut!, (x) => x === PROJECT);
  const clip = Object.entries(p.out.clips).find(([, k]) => k === 's2')![0];
  assert.equal(cut.doc.clips.find((c: any) => c.id === clip).asset, retake.asset, 'the new take is in the cut');
});

test('pause stops new work, cancel stops running jobs and never charges the rest', async () => {
  const m = mocks();
  const p0 = sr.proposeProduction({ project: PROJECT, client: CLIENT, payer: null, plan: normalizePlan(PLAN(false)), issues: [], world: null, autoCredits: 0 });
  prod.approve(p0);
  await prod.advance(p0.id);
  prod.pause(prod.getProduction(p0.id)!);
  const before = m.jobs.size;
  m.finish();
  await prod.advance(p0.id);
  assert.equal(m.jobs.size, before, 'nothing new starts while paused');
  prod.resume(prod.getProduction(p0.id)!);
  await prod.advance(p0.id);
  const running = [...m.jobs.values()].filter((j) => j.status === 'queued');
  assert.ok(running.length > 0);
  const r = prod.cancelProduction(prod.getProduction(p0.id)!);
  assert.equal(r.production.status, 'cancelled');
  assert.ok(running.every((j) => m.jobs.get(j.id)!.status === 'cancelled'));
  assert.ok(r.uncharged > 0);
});

test('review mode: a moment of the cut gets a new take of its shot, shown before and after, kept or undone', async () => {
  const m = mocks();
  const { id: cutId } = (globalThis as any).__cut;
  const cut = scenes.getScene(cutId, (x) => x === PROJECT);
  const r = await sr.reviewFix({ client: CLIENT, project: PROJECT, payer: 'payer', scene: { id: cut.id, doc: cut.doc }, t: 12.5, box: { x: 0.4, y: 0.2, w: 0.2, h: 0.3 }, text: 'her coat turned red', autoCredits: 40 });
  assert.equal(r.shot, 's2');
  const ask = m.asks.find((a) => String(a.system).includes('fixing one shot'));
  assert.deepEqual(ask.images, ['frame.png'], 'the showrunner sees the frame');
  assert.match(ask.prompt, /40% across/);
  assert.equal(r.fix.status, 'running', 'under the auto limit it just happens');
  const fix = (await runToEnd(r.fix.id, m))!;
  assert.equal(fix.status, 'done');
  const res = prod.fixResult(fix)!;
  const old = cut.doc.clips.find((c: any) => c.id === r.clip).asset;
  assert.equal(res.before, old);
  assert.ok(res.after && res.after !== old);
  assert.match(fix.steps.find((s) => s.id === 'frame:s2')!.make!.params!.prompt, /yellow oilskin/);
  prod.keepFix(fix);
  assert.equal(scenes.getScene(cutId, (x) => x === PROJECT).doc.clips.find((c: any) => c.id === r.clip).asset, res.after);
  prod.undoFix(prod.getProduction(fix.id)!);
  assert.equal(scenes.getScene(cutId, (x) => x === PROJECT).doc.clips.find((c: any) => c.id === r.clip).asset, old);
});

test('small edits go to the assistant of the scene in front; turns about results look first', async () => {
  const m = mocks();
  const { id: cutId } = (globalThis as any).__cut;
  const cut = scenes.getScene(cutId, (x) => x === PROJECT);
  const calls: any[] = [];
  const delegate = async (p: string, body: any) => { calls.push({ p, body }); return { status: 200, body: { say: 'Done.', project: { id: cutId } } }; };
  const plain = await sr.showrunnerTurn({ client: CLIENT, project: PROJECT, payer: null, messages: [{ role: 'user', text: 'make this slow motion' }], scene: { id: cut.id, kind: 'video', doc: cut.doc }, autoCredits: 40, forward: { version: 3 }, delegate });
  assert.equal(calls[0].p, `/v1/editor/projects/${cut.id}/assistant`);
  assert.equal(calls[0].body.version, 3);
  assert.equal(plain.body.role, 'editor');
  assert.equal(plain.body.say, 'Done.');
  assert.equal(m.asks.length, 0, 'no extra AI call for a small edit');
  const looked = await sr.showrunnerTurn({ client: CLIENT, project: PROJECT, payer: 'payer', messages: [{ role: 'user', text: 'fix the second shot, her coat changed' }], scene: { id: cut.id, kind: 'video', doc: cut.doc }, autoCredits: 40, delegate });
  assert.deepEqual(m.asks[0].images, ['f0.png', 'f1.png', 'f2.png']);
  assert.match(calls[1].body.messages.at(-1).text, /coat turns red/);
  assert.match(looked.body.looked, /shot 2/);
  assert.equal(sr.assistantPath('stage', 'sh_12345678'), '/v1/director/shots/sh_12345678/assistant');
  assert.equal(sr.assistantPath('character', 'sn_123456789abc'), '/v1/scenes/sn_123456789abc/assistant');
});

test('memory is per account: learned from what they do, summarised, edited, never shared', () => {
  const a = 'u_aaaaaaaaaaaa', b = 'u_bbbbbbbbbbbb';
  mem.learn(a, { kind: 'turn', text: 'make it darker' });
  assert.doesNotMatch(mem.memorySummary(a), /darker/, 'once is not a habit');
  mem.learn(a, { kind: 'turn', text: 'darker again please' });
  assert.match(mem.memorySummary(a), /darker/);
  mem.learn(a, { kind: 'approved', style: 'neon noir', characters: [{ name: 'Kai', id: null }] });
  mem.learn(a, { kind: 'approved', style: 'neon noir', characters: [{ name: 'Kai', id: 'sn_aaaaaaaaaaaa' }] });
  assert.match(mem.memorySummary(a), /Kai \(sn_aaaaaaaaaaaa\)/);
  assert.match(mem.memorySummary(a), /neon noir/);
  assert.equal(mem.memorySummary(b), '', 'another account sees nothing');
  mem.editMemory(a, { notes: 'Always end on a wide shot.' });
  assert.match(mem.memorySummary(a), /end on a wide shot/);
  mem.editMemory(a, { off: true });
  assert.equal(mem.memorySummary(a), '');
  assert.equal(mem.forgetMemory(a).notes, '');
});

test('routes: one entry for every kind (small edits reach the scene\'s own assistant), productions are the account\'s own', async () => {
  const http = await import('node:http');
  const { handle } = await import('../src/api.ts');
  const { signupUser } = await import('../src/users.ts');
  const m = mocks();
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const a = signupUser({ email: 'sr-a@example.com', password: 'secret-123', name: 'A' });
    const b = signupUser({ email: 'sr-b@example.com', password: 'secret-123', name: 'B' });
    const as = (who: typeof a) => async (route: string, method = 'GET', body?: unknown) => {
      const r = await fetch(base + route, { method, headers: { cookie: `hg_session=${who.sessionToken}`, Origin: 'https://hawkesgen.ai', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const A = as(a), B = as(b);
    const video = (await A('/v1/scenes', 'POST', { kind: 'video', title: 'Cut' })).body;
    // A small edit goes through the editor's own route (the house AI is off here, so its own refusal comes back).
    const edit = await A('/v1/showrunner/turn', 'POST', { scene: video.id, messages: [{ role: 'user', text: 'make this slow motion' }], selection: {}, doc: video.doc, version: video.version });
    assert.equal(edit.status, 503);
    assert.match(edit.body.error, /AI/);
    assert.equal(m.asks.length, 0);
    assert.equal((await B('/v1/showrunner/turn', 'POST', { scene: video.id, messages: [{ role: 'user', text: 'hi' }] })).status, 404, "another account's scene");
    // A production: the plan and its card, the account's own.
    const turn = await A('/v1/showrunner/turn', 'POST', { messages: [{ role: 'user', text: 'a 60-second teaser about a lighthouse keeper and a sea creature' }] });
    assert.equal(turn.status, 200, JSON.stringify(turn.body));
    assert.equal(turn.body.role, 'showrunner');
    assert.equal(turn.body.production.status, 'proposed');
    const id = turn.body.production.id;
    assert.equal((await B(`/v1/showrunner/productions/${id}`)).status, 404);
    assert.equal((await A('/v1/showrunner/productions')).body.items[0].id, id);
    const no = await A(`/v1/showrunner/productions/${id}/approve`, 'POST', {});
    assert.equal(no.status, 402, 'the starter credits do not cover it');
    assert.equal((await A(`/v1/showrunner/productions/${id}/dismiss`, 'POST', {})).body.status, 'dismissed');
    // Memory: always the caller's own.
    await A('/v1/showrunner/memory', 'PUT', { notes: 'Cold colors.' });
    assert.match((await A('/v1/showrunner/memory')).body.summary, /Cold colors/);
    assert.equal((await B('/v1/showrunner/memory')).body.summary, '');
  } finally {
    server.close();
    setDeps(null);
  }
});
