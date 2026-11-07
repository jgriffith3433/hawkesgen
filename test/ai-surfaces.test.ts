// The other AI surfaces, end to end with the AI mock (HAWKESGEN_AI_MOCK, src/aimock.ts), like test/ai-assistants.test.ts does
// for the AI editor's route: POST /v1/director/shots/:id/assistant, POST /v1/scenes/:id/assistant and /apply,
// POST /v1/showrunner/turn (and the production buttons), and the MCP tools hawkesgen_editor_ask / hawkesgen_editor_apply.
// The same matrix on each: the charge (one ai_turn row, the exact debit), 402 with too few credits, 503 with the house AI
// off or failing, 404 for another user's id, and a garbage answer. Then what a `generate` op that names comfy.graph,
// unity.build or playtest.run does today, and the legacy POST /v1/assistant/chat as a customer key.
// Only the model call is canned; no GPU is touched (the queue refuses jobs here, and the showrunner's queue calls are swapped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-aisurf-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 6).toString('base64');
process.env.HAWKESGEN_AI_MOCK = '1';
process.env.HAWKESGEN_SHOWRUNNER_RUNNER = '0';
delete process.env.ANTHROPIC_API_KEY;

const { handle } = await import('../src/api.ts');
const { googleSignin, getUserById } = await import('../src/users.ts');
const { db } = await import('../src/db.ts');
const AM = await import('../src/aimock.ts');
const house = await import('../src/houseai.ts');
const { setDeps } = await import('../src/showrunner/deps.ts');
const { genMcp } = await import('../src/mcp-tools.ts');
const { rpc } = await import('../src/mcp-core.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => { server.close(); setDeps(null); delete process.env.HAWKESGEN_AI_MOCK; delete process.env.ANTHROPIC_BASE_URL; });

const account = (n: string) => googleSignin({ sub: `playtest:surf-${n}`, email: `playtest+surf-${n}@playtest.hawkesgen.ai`, name: `Playtest ${n}` });
const api = (who: { sessionToken: string }) => (route: string, method = 'GET', body?: unknown) => fetch(base + route, {
  method, headers: { cookie: `hg_session=${who.sessionToken}`, Origin: 'https://hawkesgen.ai', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const setCredits = (id: string, n: number) => db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(n, id);
const credits = (id: string) => getUserById(id)!.credits;
const ledger = (id: string, kind = 'ai_turn') => db.prepare('SELECT delta, balance_after, detail FROM credit_ledger WHERE user_id = ? AND kind = ? ORDER BY created, rowid').all(id, kind) as { delta: number; balance_after: number; detail: string }[];
const jobCount = () => (db.prepare('SELECT COUNT(*) n FROM jobs').get() as { n: number }).n;

const A = account('a');
const B = account('b');
const a = api(A), b = api(B);
setCredits(A.user.id, 5000);
setCredits(B.user.id, 5000);
const queue = (who: typeof A, answers: AM.CannedAnswer[]) => { AM.clearAnswers(who.user.id); AM.queueAnswers(who.user.id, answers); };

let keyN = 0;
/** Runs `fn` with the house AI off, then with no key, then with a key the API rejects; each must be a 503. */
async function houseDown(fn: () => Promise<Response>) {
  const seen: { status: number; error: string }[] = [];
  const keep = async () => { const r = await fn(); seen.push({ status: r.status, error: String((await r.json() as any).error ?? '') }); };
  AM.clearAnswers(A.user.id);
  try {
    house.saveHouseSettings({ source: 'off' });
    await keep();
    house.saveHouseSettings({ source: 'api' });
    await keep();
    const fake = http.createServer((q, res) => {
      // Read the whole request first: a big prompt answered before it is read ends as a reset connection, not a 401.
      q.resume();
      q.on('end', () => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); });
    });
    await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', () => ok()));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
    // A new key each time: the SDK client is cached by key, with the base URL it first saw.
    house.setHouseKey(`sk-ant-api03-${String(++keyN).padStart(30, 'x')}`, 'test');
    const log = console.error; console.error = () => {};
    try { await keep(); } finally { console.error = log; fake.close(); delete process.env.ANTHROPIC_BASE_URL; }
  } finally { house.clearHouseKey(); house.saveHouseSettings({ source: 'auto' }); }
  assert.deepEqual(seen.map((s) => s.status), [503, 503, 503], JSON.stringify(seen));
  assert.match(seen[0].error, /turned off/);
  assert.match(seen[2].error, /isn't available/);
}

// ================================================================== the AI director
const shotAnswer = (text: string, shot: Record<string, unknown>, cost = 0) => ({ match: text, cost, json: { say: `Done: ${text}`, shot } });
async function newShot(who = a) {
  const r = await (await who('/v1/director/shots', 'POST', { title: 'Opening' })).json() as any;
  return r as { id: string; version: number; doc: any };
}
const askDirector = (id: string, text: string, extra: Record<string, unknown> = {}) => a(`/v1/director/shots/${id}/assistant`, 'POST', { messages: [{ role: 'user', text }], ...extra });

test('director: a turn changes and saves the shot, and writes one ai_turn row with the exact debit', async () => {
  const s = await newShot();
  setCredits(A.user.id, 500);
  const rows = ledger(A.user.id).length;
  queue(A, [shotAnswer('call it The Quay', { ...s.doc, title: 'The Quay' }, 0.2)]);
  const r = await askDirector(s.id, 'call it The Quay');
  const body = await r.json() as any;
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.say, 'Done: call it The Quay');
  assert.equal(body.shot.doc.title, 'The Quay');
  assert.ok(body.shot.version > s.version);
  assert.equal(body.aiCredits, house.turnCredits(0.2));
  assert.equal(body.aiCredits, 30);
  assert.equal(credits(A.user.id), 470);
  const rowsNow = ledger(A.user.id);
  assert.equal(rowsNow.length, rows + 1);
  assert.deepEqual([rowsNow.at(-1)!.delta, rowsNow.at(-1)!.balance_after], [-30, 470]);
  assert.match(rowsNow.at(-1)!.detail, /^Director: call it The Quay/);
  assert.equal((await (await a(`/v1/director/shots/${s.id}`)).json() as any).doc.title, 'The Quay', 'what was answered is what is stored');
  setCredits(A.user.id, 5000);
});

test('director: 402 with too few credits (the model is never called, nothing changes)', async () => {
  const s = await newShot();
  setCredits(A.user.id, 0);
  queue(A, [shotAnswer('broke', { ...s.doc, title: 'Nope' })]);
  const rows = ledger(A.user.id).length;
  const r = await askDirector(s.id, 'broke');
  assert.equal(r.status, 402);
  assert.match((await r.json() as any).error, /credit/i);
  assert.equal(AM.mockStatus(A.user.id).queued, 1);
  assert.equal(ledger(A.user.id).length, rows);
  assert.equal((await (await a(`/v1/director/shots/${s.id}`)).json() as any).version, s.version);
  AM.clearAnswers(A.user.id);
  setCredits(A.user.id, 5000);
});

test('director: 503 when the house AI is off, has no key or has a rejected one; nothing is charged or changed', async () => {
  const s = await newShot();
  const rows = ledger(A.user.id).length, bal = credits(A.user.id);
  await houseDown(() => askDirector(s.id, 'anything'));
  assert.deepEqual([ledger(A.user.id).length, credits(A.user.id)], [rows, bal]);
  assert.equal((await (await a(`/v1/director/shots/${s.id}`)).json() as any).version, s.version);
});

test('director: another user\'s shot is a 404 on get, assistant, put, next and delete; the model is not called and nothing changes', async () => {
  const s = await newShot();
  queue(B, [shotAnswer('steal', { ...s.doc, title: 'Mine now' })]);
  const mine = JSON.stringify(await (await a(`/v1/director/shots/${s.id}`)).json());
  const rowsB = ledger(B.user.id).length, balB = credits(B.user.id);
  const asB = async (route: string, method: string, body?: unknown) => (await b(`/v1/director/shots/${s.id}${route}`, method, body)).status;
  assert.equal(await asB('', 'GET'), 404);
  assert.equal(await asB('/assistant', 'POST', { messages: [{ role: 'user', text: 'steal' }] }), 404);
  assert.equal(await asB('/assistant', 'POST', { messages: [{ role: 'user', text: 'steal' }], doc: { ...s.doc, title: 'Mine now' } }), 404, 'a doc sent along is not saved either');
  assert.equal(await asB('', 'PUT', { doc: { ...s.doc, title: 'Mine now' }, version: s.version }), 404);
  assert.equal(await asB('/next', 'POST'), 404);
  assert.equal(await asB('/blender', 'POST'), 404);
  assert.equal(await asB('', 'DELETE'), 404);
  assert.equal(JSON.stringify(await (await a(`/v1/director/shots/${s.id}`)).json()), mine);
  assert.equal(AM.mockStatus(B.user.id).queued, 1);
  assert.deepEqual([ledger(B.user.id).length, credits(B.user.id)], [rowsB, balB]);
  AM.clearAnswers(B.user.id);
});

test('director: a garbage answer changes nothing but the person still pays for the turn; no messages is a 400', async () => {
  const s = await newShot();
  setCredits(A.user.id, 1000);
  queue(A, [{ match: 'garble', text: 'Sure! ```{ "shot": {{{ not json', cost: 0.1 }]);
  const r = await askDirector(s.id, 'garble');
  const body = await r.json() as any;
  assert.equal(r.status, 200);
  assert.match(body.say, /not json/);
  assert.equal(body.shot.doc.title, s.doc.title);
  assert.equal(credits(A.user.id), 1000 - house.turnCredits(0.1));
  // JSON with no shot in it keeps the shot too.
  queue(A, [{ match: 'nothing', json: { say: 'No changes.' } }]);
  const r2 = await (await askDirector(s.id, 'nothing')).json() as any;
  assert.equal(r2.say, 'No changes.');
  assert.equal(r2.shot.doc.title, s.doc.title);
  const empty = await a(`/v1/director/shots/${s.id}/assistant`, 'POST', { messages: [{ role: 'user', text: 5 }, null] });
  assert.equal(empty.status, 400);
  setCredits(A.user.id, 5000);
});

// ================================================================== the scene AI (character scenes) and /apply
const newCharacter = async (who = a) => (await (await who('/v1/scenes', 'POST', { kind: 'character', title: 'Mara' })).json()) as { id: string; version: number; doc: any; kind: string };
const sceneAnswer = (text: string, doc: Record<string, unknown>, jobs: unknown[] = [], cost = 0) => ({ match: text, cost, json: { say: `Done: ${text}`, doc, jobs } });
const askScene = (id: string, text: string, extra: Record<string, unknown> = {}, who = a) => who(`/v1/scenes/${id}/assistant`, 'POST', { messages: [{ role: 'user', text }], ...extra });
const front = (gen: number) => ({ id: 'pic_front', role: 'front', gen });
const draw = (gen: number, prompt = 'Mara, full body, front view') => ({ gen, tool: 'image.generate', params: { prompt, width: 512, height: 512 }, label: 'Front' });

test('scene AI: a turn changes and saves the scene, writes one ai_turn row, and says aiCredits', async () => {
  const s = await newCharacter();
  assert.equal(s.kind, 'character');
  setCredits(A.user.id, 500);
  const rows = ledger(A.user.id).length;
  queue(A, [sceneAnswer('make her older', { ...s.doc, title: 'Mara', description: 'A weathered woman in her sixties' }, [], 0.2)]);
  const r = await askScene(s.id, 'make her older');
  const body = await r.json() as any;
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.say, 'Done: make her older');
  assert.equal(body.scene.doc.description, 'A weathered woman in her sixties');
  assert.ok(body.scene.version > s.version);
  assert.equal(body.aiCredits, 30);
  assert.equal(credits(A.user.id), 470);
  const rowsNow = ledger(A.user.id);
  assert.equal(rowsNow.length, rows + 1);
  assert.deepEqual([rowsNow.at(-1)!.delta, rowsNow.at(-1)!.balance_after], [-30, 470]);
  assert.match(rowsNow.at(-1)!.detail, /^AI \(character\): make her older/);
  assert.equal((await (await a(`/v1/scenes/${s.id}`)).json() as any).doc.description, 'A weathered woman in her sixties');
  setCredits(A.user.id, 5000);
});

test('scene AI: autoCredits 0 proposes the jobs (nothing started, nothing saved) and /apply runs them for free of the AI charge', async () => {
  const s = await newCharacter();
  const doc = { ...s.doc, pictures: [front(0)] };
  queue(A, [sceneAnswer('draw her', doc, [draw(0)])]);
  const jobsBefore = jobCount();
  const r = await (await askScene(s.id, 'draw her', { autoCredits: 0 })).json() as any;
  assert.equal(r.started.length, 0);
  assert.equal(r.proposed.jobs.length, 1);
  assert.equal(r.proposed.credits, r.proposed.jobs.reduce((n: number, j: any) => n + j.credits, 0));
  assert.equal(jobCount(), jobsBefore, 'no job was queued');
  assert.equal(r.scene.doc.pictures.length, 0, 'the scene is as it was');
  // The one tap: /apply with the proposal. It is the person confirming, so it is not asked again and the AI is not called.
  const bal = credits(A.user.id), rows = ledger(A.user.id).length;
  const ap = await a(`/v1/scenes/${s.id}/apply`, 'POST', { doc: r.proposed.doc, jobs: r.proposed.jobs });
  const applied = await ap.json() as any;
  assert.equal(ap.status, 200, JSON.stringify(applied));
  assert.equal(applied.started.length, 1);
  assert.equal(applied.started[0].tool, 'image.generate');
  assert.equal(jobCount(), jobsBefore + 1);
  assert.match(applied.scene.doc.pictures[0].pending ?? '', /^j_/, 'the picture waits on the job');
  assert.equal(ledger(A.user.id).length, rows, 'no ai_turn for an apply');
  assert.ok(credits(A.user.id) <= bal, 'a job may charge its own credits, never the AI');
  // A big autoCredits runs it in the turn itself.
  const s2 = await newCharacter();
  queue(A, [sceneAnswer('draw him', { ...s2.doc, pictures: [front(0)] }, [draw(0, 'a man')])]);
  const now = await (await askScene(s2.id, 'draw him', { autoCredits: 1_000_000 })).json() as any;
  assert.equal(now.proposed, undefined);
  assert.equal(now.started.length, 1);
  setCredits(A.user.id, 5000);
});

test('scene AI: 402 with too few credits (model not called), 503 with the house AI down; nothing charged or changed', async () => {
  const s = await newCharacter();
  const rows = ledger(A.user.id).length;
  setCredits(A.user.id, 0);
  queue(A, [sceneAnswer('broke', { ...s.doc, title: 'Nope' })]);
  const r = await askScene(s.id, 'broke');
  assert.equal(r.status, 402);
  assert.match((await r.json() as any).error, /credit/i);
  assert.equal(AM.mockStatus(A.user.id).queued, 1);
  AM.clearAnswers(A.user.id);
  setCredits(A.user.id, 5000);
  await houseDown(() => askScene(s.id, 'anything'));
  assert.equal(ledger(A.user.id).length, rows);
  assert.equal(credits(A.user.id), 5000);
  assert.equal((await (await a(`/v1/scenes/${s.id}`)).json() as any).version, s.version);
});

test('scene AI: another user\'s scene is a 404 on get, assistant, apply, put, render, duplicate and delete', async () => {
  const s = await newCharacter();
  queue(B, [sceneAnswer('steal', { ...s.doc, title: 'Mine now' }, [draw(0)])]);
  const mine = JSON.stringify(await (await a(`/v1/scenes/${s.id}`)).json());
  const rowsB = ledger(B.user.id).length, balB = credits(B.user.id), jobs = jobCount();
  const asB = async (route: string, method: string, body?: unknown) => (await b(`/v1/scenes/${s.id}${route}`, method, body)).status;
  assert.equal(await asB('', 'GET'), 404);
  assert.equal(await asB('/assistant', 'POST', { messages: [{ role: 'user', text: 'steal' }] }), 404);
  assert.equal(await asB('/assistant', 'POST', { messages: [{ role: 'user', text: 'steal' }], doc: { ...s.doc, title: 'Mine now' } }), 404);
  assert.equal(await asB('/apply', 'POST', { doc: { ...s.doc, title: 'Mine now' }, jobs: [draw(0)] }), 404);
  assert.equal(await asB('', 'PUT', { doc: { ...s.doc, title: 'Mine now' }, version: s.version }), 404);
  assert.equal(await asB('/duplicate', 'POST'), 404);
  assert.equal(await asB('/render', 'PUT', { asset: 'a_000000' }), 404);
  assert.equal(await asB('', 'DELETE'), 404);
  assert.equal(JSON.stringify(await (await a(`/v1/scenes/${s.id}`)).json()), mine);
  assert.equal(AM.mockStatus(B.user.id).queued, 1, 'the model was not called');
  assert.deepEqual([ledger(B.user.id).length, credits(B.user.id), jobCount()], [rowsB, balB, jobs]);
  AM.clearAnswers(B.user.id);
});

test('scene AI: a garbage answer changes nothing and is still charged; /apply with garbage jobs reports and runs nothing', async () => {
  const s = await newCharacter();
  setCredits(A.user.id, 1000);
  queue(A, [{ match: 'garble', text: 'Sorry {{{ ```', cost: 0.1 }]);
  const r = await askScene(s.id, 'garble');
  const body = await r.json() as any;
  assert.equal(r.status, 200);
  assert.match(body.say, /Sorry/);
  assert.deepEqual(body.started, []);
  assert.equal(body.scene.doc.title, s.doc.title);
  assert.equal(credits(A.user.id), 1000 - house.turnCredits(0.1));
  // Jobs with no integer `gen`, no tool or a tool Gen doesn't have are dropped or reported, never run.
  const before = jobCount();
  queue(A, [{ match: 'junk', json: { say: 'ok', doc: s.doc, jobs: [{ tool: 'image.generate' }, { gen: 'x', tool: 'image.generate' }, null, { gen: 0, tool: 'no.such.tool', params: {} }] } }]);
  const j = await (await askScene(s.id, 'junk', { autoCredits: 1_000_000 })).json() as any;
  assert.deepEqual(j.started, []);
  assert.deepEqual(j.errors, ['no tool no.such.tool']);
  const ap = await (await a(`/v1/scenes/${s.id}/apply`, 'POST', { jobs: [{ gen: 0, tool: 'no.such.tool' }, 'x', 5] })).json() as any;
  assert.deepEqual(ap.started, []);
  assert.equal(jobCount(), before);
  const none = await a(`/v1/scenes/${s.id}/assistant`, 'POST', { messages: [] });
  assert.equal(none.status, 400);
  setCredits(A.user.id, 5000);
});

// ================================================================== the showrunner (POST /v1/showrunner/turn and the production buttons)
// The planner's own Claude calls go through the mock like every other; the queue's calls (submit, job, cancel) and prices are
// swapped, so an approved production starts "jobs" that cost nothing and the tests can see which steps ran.
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


const MAKE = 'a 60-second teaser about a lighthouse keeper and a sea creature';
type SJob = { id: string; tool: string; status: 'queued' | 'cancelled' | 'done'; labels: any; outputs: { asset: string; kind: string }[]; error: null };
const submitted = new Map<string, SJob>();
setDeps({
  submit: (_c, spec) => { const id = `j_${(submitted.size + 1).toString(16).padStart(8, '0')}`; submitted.set(id, { id, tool: spec.tool, status: 'queued', labels: spec.labels, outputs: [], error: null }); return { id }; },
  job: (id) => (submitted.get(id) as any) ?? null,
  cancel: (id) => { const j = submitted.get(id); if (j && j.status === 'queued') j.status = 'cancelled'; },
  quote: (_p, tool) => ({ 'image.generate': 4, 'image.edit': 5, 'video.i2v': 30, 'video.talk': 25, 'video.scene': 60, 'audio.voice': 2, 'audio.music': 8 } as Record<string, number>)[tool] ?? 3,
  hasTool: (id) => id !== 'make.checked',
});
/** Queues the planner's answer and its critique; `cost` (dollars) is what the planner call reports. */
const queuePlan = (who: typeof A, cost = 0.1) => queue(who, [
  { match: 'script supervisor', json: { ok: true, issues: [], plan: PLAN(false) }, cost: 0.05 },
  { match: 'showrunner of Hawkes Gen', json: { say: 'Here is a teaser in six shots.', plan: PLAN(false) }, cost },
]);
const turn = (text: string, extra: Record<string, unknown> = {}, who = a) => who('/v1/showrunner/turn', 'POST', { messages: [{ role: 'user', text }], ...extra });
const buttons = (id: string, what: string, who = a) => who(`/v1/showrunner/productions/${id}/${what}`, 'POST', {});
const ranSteps = (prodId: string) => [...submitted.values()].filter((j) => j.labels?.production === prodId);

test('showrunner: a production request comes back as a card with a price, a proposed production, and nothing started or spent on it', async () => {
  setCredits(A.user.id, 5000);
  const jobs = submitted.size, rows = ledger(A.user.id).length;
  queuePlan(A);
  const r = await turn(MAKE, { autoCredits: 0 });
  const body = await r.json() as any;
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.route, 'production');
  assert.equal(body.started, false);
  assert.equal(body.production.status, 'proposed');
  assert.ok(body.production.card.credits > 0, 'the card has a price');
  assert.equal(body.production.card.credits, body.production.steps.reduce((n: number, s: any) => n + s.credits, 0));
  assert.equal(submitted.size, jobs, 'no job was started');
  assert.ok(body.production.steps.every((s: any) => s.status === 'waiting'));
  // The planner and its critique were charged as AI turns (they are the person's words to the AI), the production not at all.
  const turns = ledger(A.user.id).slice(rows);
  assert.ok(turns.length >= 1 && turns.length <= 2, JSON.stringify(turns));
  assert.equal(credits(A.user.id), 5000 + turns.reduce((n, t) => n + t.delta, 0));
  assert.equal(body.aiCredits, turns.reduce((n, t) => n - t.delta, 0));
  // It is on the person's list, as proposed.
  const list = await (await a('/v1/showrunner/productions')).json() as any;
  assert.equal(list.items.find((p: any) => p.id === body.production.id).status, 'proposed');
});

test('showrunner: approve starts the first steps (nothing before); too few credits for the card is a 402 and starts nothing', async () => {
  queuePlan(A);
  const card = (await (await turn(MAKE, { autoCredits: 0 })).json() as any).production;
  const id = card.id as string;
  const mine = credits(A.user.id);
  setCredits(A.user.id, card.card.credits - 1);
  const poor = await buttons(id, 'approve');
  assert.equal(poor.status, 402);
  assert.match((await poor.json() as any).error, /credits/i);
  assert.equal(ranSteps(id).length, 0);
  assert.equal(((await (await a(`/v1/showrunner/productions/${id}`)).json()) as any).status, 'proposed');
  setCredits(A.user.id, mine);
  const ok = await buttons(id, 'approve');
  const started = await ok.json() as any;
  assert.equal(ok.status, 200, JSON.stringify(started));
  assert.equal(started.status, 'running');
  assert.ok(ranSteps(id).length > 0, 'approving started the first steps');
  // A second approve is refused (409), not run twice.
  assert.equal((await buttons(id, 'approve')).status, 409);
  await buttons(id, 'cancel');
  setCredits(A.user.id, 5000);
});

test('showrunner: autoCredits from the body decides whether the card runs by itself (routes.ts forwards it, default 40)', async () => {
  const run = async (extra: Record<string, unknown>) => { queuePlan(A); return await (await turn(MAKE, extra)).json() as any; };
  const none = await run({ autoCredits: 0 });
  assert.equal(none.started, false);
  assert.equal(none.production.status, 'proposed');
  const price = none.production.card.credits as number;
  assert.ok(price > 40, `the test plan costs more than the default limit (${price})`);
  const dflt = await run({});
  assert.equal(dflt.production.status, 'proposed', 'default 40 is under the price');
  const negative = await run({ autoCredits: -5 });
  assert.equal(negative.production.status, 'proposed', 'a negative limit is 0');
  const junk = await run({ autoCredits: 'lots' });
  assert.equal(junk.production.status, 'proposed', 'a limit that is not a number never runs by itself');
  const just = await run({ autoCredits: price - 1 });
  assert.equal(just.production.status, 'proposed', 'one under the price');
  // The limit covers the price and the fix budget on top of it (card.fixCredits).
  const enough = await run({ autoCredits: price + none.production.card.fixCredits });
  assert.equal(enough.started, true);
  assert.equal(enough.production.status, 'running');
  assert.ok(ranSteps(enough.production.id).length > 0);
  for (const p of [none, dflt, negative, junk, just, enough]) await buttons(p.production.id, 'cancel');
});

test('showrunner: pause starts nothing more; cancel stops running jobs and never charges the steps that had not started', async () => {
  queuePlan(A);
  const card = (await (await turn(MAKE, { autoCredits: 0 })).json() as any).production;
  const id = card.id as string;
  await buttons(id, 'approve');
  const first = ranSteps(id).length;
  assert.ok(first > 0 && first < card.steps.length, 'only the steps with nothing before them started');
  const paused = await (await buttons(id, 'pause')).json() as any;
  assert.equal(paused.status, 'paused');
  // Finish what is running: while paused no step after it starts.
  for (const j of ranSteps(id)) { j.status = 'done'; j.outputs = [{ asset: `a_${j.id.slice(2)}`, kind: 'image' }]; }
  const prod = await import('../src/showrunner/production.ts');
  await prod.advance(id);
  assert.equal(ranSteps(id).length, first, 'paused: nothing new started');
  const resumed = await (await buttons(id, 'resume')).json() as any;
  assert.equal(resumed.status, 'running');
  assert.ok(ranSteps(id).length >= first);
  // Cancel: the steps that had not started are skipped and counted as uncharged; the running ones are cancelled.
  await (await buttons(id, 'pause')).json();
  const before = ranSteps(id).length;
  const cur = await (await a(`/v1/showrunner/productions/${id}`)).json() as any;
  const waiting = cur.steps.filter((s: any) => s.status === 'waiting');
  const running = cur.steps.filter((s: any) => s.status === 'running');
  assert.ok(waiting.length > 0);
  const live = ranSteps(id).filter((j) => j.status === 'queued');
  const c = await (await buttons(id, 'cancel')).json() as any;
  assert.equal(c.status, 'cancelled');
  assert.equal(c.uncharged, waiting.reduce((n: number, s: any) => n + s.credits, 0));
  assert.ok(c.uncharged > 0);
  assert.equal(c.steps.filter((s: any) => s.status === 'waiting' || s.status === 'running').length, 0);
  assert.equal(ranSteps(id).length, before, 'cancelling started nothing');
  assert.equal(live.length, running.length);
  for (const j of live) assert.equal(j.status, 'cancelled', 'a running step\'s job was cancelled');
  // Cancel again, or approve after: nothing more happens.
  assert.equal(((await (await buttons(id, 'cancel')).json()) as any).uncharged, 0);
  assert.equal((await buttons(id, 'approve')).status, 409);
  assert.equal(ranSteps(id).length, before);
  // A proposed card can also be dismissed: nothing was ever started.
  queuePlan(A);
  const p2 = (await (await turn(MAKE, { autoCredits: 0 })).json() as any).production;
  assert.equal(((await (await buttons(p2.id, 'dismiss')).json()) as any).status, 'dismissed');
  assert.equal(ranSteps(p2.id).length, 0);
});
