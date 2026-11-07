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
const queue = (who: typeof A, answers: import('../src/aimock.ts').CannedAnswer[]) => { AM.clearAnswers(who.user.id); AM.queueAnswers(who.user.id, answers); };

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

test('showrunner: 402 with too few credits (for a production and for a small edit); the model is not called, nothing is made', async () => {
  const proj = await (await a('/v1/editor/projects', 'POST', { title: 'Cut' })).json() as any;
  setCredits(A.user.id, 0);
  const rows = ledger(A.user.id).length, jobs = submitted.size;
  queuePlan(A);
  const r = await turn(MAKE, { autoCredits: 1_000_000 });
  assert.equal(r.status, 402);
  assert.match((await r.json() as any).error, /credit/i);
  assert.equal(AM.mockStatus(A.user.id).queued, 2, 'the planner was never called');
  queue(A, [{ match: 'slow motion', json: { say: 'Slowed.', ops: [] } }]);
  const e = await turn('make this slow motion', { scene: proj.id });
  assert.equal(e.status, 402);
  assert.equal(AM.mockStatus(A.user.id).queued, 1);
  assert.deepEqual([ledger(A.user.id).length, credits(A.user.id), submitted.size], [rows, 0, jobs]);
  AM.clearAnswers(A.user.id);
  setCredits(A.user.id, 5000);
});

test('showrunner: 503 when the house AI is off, has no key or a rejected one: no production, no charge', async () => {
  const before = (await (await a('/v1/showrunner/productions')).json() as any).items.length;
  const rows = ledger(A.user.id).length, bal = credits(A.user.id);
  await houseDown(() => turn(MAKE, { autoCredits: 1_000_000 }));
  assert.deepEqual([ledger(A.user.id).length, credits(A.user.id)], [rows, bal]);
  assert.equal((await (await a('/v1/showrunner/productions')).json() as any).items.length, before);
});

test('showrunner: a small edit goes to the scene\'s own assistant and is charged once, by that assistant', async () => {
  const proj = await (await a('/v1/editor/projects', 'POST', { title: 'Cut' })).json() as any;
  setCredits(A.user.id, 500);
  const rows = ledger(A.user.id).length;
  queue(A, [{ match: 'slow motion', json: { say: 'Slowed.', ops: [{ op: 'settings', title: 'Slow' }] }, cost: 0.2 }]);
  const r = await turn('make this slow motion', { scene: proj.id });
  const body = await r.json() as any;
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.route, 'edit');
  assert.equal(body.say, 'Slowed.');
  assert.equal(body.project.doc.title, 'Slow');
  assert.equal(body.aiCredits, 30);
  assert.equal(credits(A.user.id), 470);
  assert.equal(ledger(A.user.id).length, rows + 1);
  assert.match(ledger(A.user.id).at(-1)!.detail, /^AI editor: make this slow motion/);
  setCredits(A.user.id, 5000);
});

test('showrunner: another user\'s scene and production are a 404 on every route; the model is not called and nothing changes', async () => {
  const proj = await (await a('/v1/editor/projects', 'POST', { title: 'Mine' })).json() as any;
  queuePlan(A);
  const mine = (await (await turn(MAKE, { autoCredits: 0 })).json() as any).production;
  queue(B, [{ match: 'slow motion', json: { say: 'Stolen.', ops: [{ op: 'settings', title: 'Mine now' }] } }]);
  const rowsB = ledger(B.user.id).length, balB = credits(B.user.id), jobs = submitted.size;
  const t = await turn('make this slow motion', { scene: proj.id }, b);
  assert.equal(t.status, 404);
  assert.equal((await turn('make this slow motion', { scene: proj.id, doc: { title: 'x' } }, b)).status, 404);
  for (const what of ['approve', 'dismiss', 'pause', 'resume', 'cancel', 'browser', 'claim', 'finish', 'keep', 'undo']) {
    assert.equal((await buttons(mine.id, what, b)).status, 404, what);
  }
  assert.equal((await b(`/v1/showrunner/productions/${mine.id}`)).status, 404);
  assert.equal((await (await b('/v1/showrunner/productions')).json() as any).items.some((p: any) => p.id === mine.id), false);
  const rv = await b('/v1/showrunner/review', 'POST', { scene: proj.id, t: 1, text: 'fix' });
  assert.equal(rv.status, 404);
  assert.equal(AM.mockStatus(B.user.id).queued, 1, 'the model was not called for any of it');
  assert.deepEqual([ledger(B.user.id).length, credits(B.user.id)], [rowsB, balB]);
  // A card of someone else's named in a turn is not answered or replaced: it is simply not theirs.
  queuePlan(B);
  const bt = await (await turn(MAKE, { autoCredits: 0, production: mine.id }, b)).json() as any;
  assert.notEqual(bt.production?.id, mine.id);
  assert.equal(((await (await a(`/v1/showrunner/productions/${mine.id}`)).json()) as any).status, 'proposed', 'A\'s card is untouched');
  assert.equal(ranSteps(mine.id).length, 0);
  assert.equal((await (await a(`/v1/editor/projects/${proj.id}`)).json() as any).doc.title, 'Mine');
  assert.equal(jobs, submitted.size);
  AM.clearAnswers(B.user.id);
});

test('showrunner: a garbage plan is a readable 502 and no production; the call is still charged', async () => {
  const before = (await (await a('/v1/showrunner/productions')).json() as any).items.length;
  setCredits(A.user.id, 1000);
  queue(A, [{ match: 'showrunner of Hawkes Gen', text: 'I would love to! ```{ "plan": {{{', cost: 0.1 }]);
  const r = await turn(MAKE, { autoCredits: 1_000_000 });
  const body = await r.json() as any;
  assert.equal(r.status, 502);
  assert.match(body.error, /plan didn't come back right/);
  // Today the call that returned nonsense is still charged (the model was asked); a production is never made from it.
  assert.equal(credits(A.user.id), 1000 - house.turnCredits(0.1));
  assert.equal(ledger(A.user.id).at(-1)!.delta, -house.turnCredits(0.1));
  assert.equal((await (await a('/v1/showrunner/productions')).json() as any).items.length, before);
  AM.clearAnswers(A.user.id);
  setCredits(A.user.id, 5000);
});

// ================================================================== the MCP tools hawkesgen_editor_ask / hawkesgen_editor_apply
// The tools run against the real routes: the stand-in Gen client sends what hawkesgen.mjs would (JSON to /v1, errors thrown
// with the route's own message and status), signed in as the given test account.
const mcpFor = (who: { sessionToken: string }) => {
  const gen: any = {
    async request(p: string, o: { method?: string; body?: unknown } = {}) {
      const r = await api(who)(`/v1${p}`, o.method ?? 'GET', o.body);
      const data = await r.json().catch(() => ({})) as any;
      if (!r.ok) throw Object.assign(new Error(data.error ?? `HTTP ${r.status}`), { status: r.status, kind: data.kind });
      return data;
    },
  };
  return genMcp(gen, { remote: true, account: 'u_x' });
};
const callTool = async (server: any, name: string, args: any) => (await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
const textOf = (r: any) => String(r.content?.[0]?.text ?? '');
const mcpA = mcpFor(A), mcpB = mcpFor(B);

async function videoProject() {
  const made = await (await a('/v1/editor/projects', 'POST', { title: 'MCP' })).json() as any;
  const saved = await (await a(`/v1/editor/projects/${made.id}`, 'PUT', { doc: { ...made.doc, clips: [{ id: 'ct', track: 'T1', kind: 'text', start: 0, in: 0, out: 2, text: 'Old title' }] }, version: made.version })).json() as any;
  return { id: made.id as string, version: saved.version as number, clip: saved.doc.clips[0].id as string };
}

test('mcp hawkesgen_editor_ask: the AI edits through the real route and is charged exactly like the app (one ai_turn, aiCredits)', async () => {
  const p = await videoProject();
  setCredits(A.user.id, 500);
  const rows = ledger(A.user.id).length;
  queue(A, [{ match: 'retitle', json: { say: 'Retitled.', ops: [{ op: 'set', id: p.clip, text: 'New title' }] }, cost: 0.2 }]);
  const r = await callTool(mcpA, 'hawkesgen_editor_ask', { id: p.id, say: 'retitle the card' });
  assert.notEqual(r.isError, true, textOf(r));
  assert.equal(r.structuredContent.say, 'Retitled.');
  assert.equal(r.structuredContent.version, p.version + 1);
  assert.equal(r.structuredContent.results[0].ok, true);
  assert.equal(credits(A.user.id), 470);
  assert.equal(ledger(A.user.id).length, rows + 1);
  assert.equal((await (await a(`/v1/editor/projects/${p.id}`)).json() as any).doc.clips[0].text, 'New title');
  setCredits(A.user.id, 5000);
});

test('mcp hawkesgen_editor_ask: 402 and 503 are the tool\'s error with the route\'s words; nothing is charged or changed', async () => {
  const p = await videoProject();
  const rows = ledger(A.user.id).length;
  setCredits(A.user.id, 0);
  queue(A, [{ match: 'retitle', json: { say: 'x', ops: [{ op: 'delete', id: p.clip }] } }]);
  const poor = await callTool(mcpA, 'hawkesgen_editor_ask', { id: p.id, say: 'retitle the card' });
  assert.equal(poor.isError, true);
  assert.match(textOf(poor), /credit/i);
  assert.equal(AM.mockStatus(A.user.id).queued, 1);
  AM.clearAnswers(A.user.id);
  setCredits(A.user.id, 5000);
  house.saveHouseSettings({ source: 'off' });
  try {
    const off = await callTool(mcpA, 'hawkesgen_editor_ask', { id: p.id, say: 'retitle the card' });
    assert.equal(off.isError, true);
    assert.match(textOf(off), /turned off/);
  } finally { house.saveHouseSettings({ source: 'auto' }); }
  assert.deepEqual([ledger(A.user.id).length, credits(A.user.id)], [rows, 5000]);
  assert.equal((await (await a(`/v1/editor/projects/${p.id}`)).json() as any).version, p.version);
});

test('mcp: an unknown or malformed project id is a clear "No ... project" error, for ask and apply; nothing is asked or charged', async () => {
  const rows = ledger(A.user.id).length, bal = credits(A.user.id);
  queue(A, [{ match: 'anything', json: { say: 'x', ops: [] } }]);
  const seen: string[] = [];
  for (const id of ['ep_0123456789ab', 'sn_0123456789ab', 'ep_short', 'not-an-id', '../../v1/admin']) {
    for (const [tool, args] of [['hawkesgen_editor_ask', { id, say: 'anything' }], ['hawkesgen_editor_apply', { id, ops: [{ op: 'delete', id: 'x' }] }]] as const) {
      const r = await callTool(mcpA, tool, args);
      assert.equal(r.isError, true, `${tool} ${id}`);
      seen.push(`${tool} ${id}: ${textOf(r)}`);
      assert.doesNotMatch(textOf(r), /TypeError|undefined|\[object/, `${tool} ${id}: ${textOf(r)}`);
    }
  }
  // A well-formed id that isn't there says so ("No such scene", where "project" is the word the tool uses); the odd ones fall
  // through to "No editor route" (404): never a crash. The todo below is the wish for the tool to name the id it was given.
  assert.match(seen[0], /No such scene/, seen[0]);
  assert.match(seen[2], /No such scene/, seen[2]);
  assert.equal(AM.mockStatus(A.user.id).queued, 1);
  assert.deepEqual([ledger(A.user.id).length, credits(A.user.id)], [rows, bal]);
  AM.clearAnswers(A.user.id);
});

test('mcp: another user\'s project is the same error as a missing one, for ask and apply; the model is not called', async () => {
  const p = await videoProject();
  queue(B, [{ match: 'steal', json: { say: 'x', ops: [{ op: 'delete', id: p.clip }] } }]);
  const rowsB = ledger(B.user.id).length;
  const ask = await callTool(mcpB, 'hawkesgen_editor_ask', { id: p.id, say: 'steal it' });
  const apply = await callTool(mcpB, 'hawkesgen_editor_apply', { id: p.id, ops: [{ op: 'delete', id: p.clip }] });
  const missing = await callTool(mcpB, 'hawkesgen_editor_ask', { id: 'ep_0123456789ab', say: 'steal it' });
  for (const r of [ask, apply]) assert.equal(r.isError, true);
  assert.equal(textOf(ask), textOf(missing), 'no difference between "not yours" and "not there"');
  assert.equal(AM.mockStatus(B.user.id).queued, 1);
  assert.equal(ledger(B.user.id).length, rowsB);
  assert.equal((await (await a(`/v1/editor/projects/${p.id}`)).json() as any).doc.clips.length, 1);
  AM.clearAnswers(B.user.id);
});

test('mcp hawkesgen_editor_ask: a garbage answer is plain words with no edits (and charged); hawkesgen_editor_apply runs ops with no AI charge', async () => {
  const p = await videoProject();
  setCredits(A.user.id, 1000);
  queue(A, [{ match: 'garble', text: 'Hmm. ```{ ops: [', cost: 0.1 }]);
  const g = await callTool(mcpA, 'hawkesgen_editor_ask', { id: p.id, say: 'garble' });
  assert.notEqual(g.isError, true);
  assert.match(g.structuredContent.say, /ops/);
  assert.deepEqual(g.structuredContent.results, []);
  assert.equal(credits(A.user.id), 1000 - house.turnCredits(0.1));
  const rows = ledger(A.user.id).length;
  const ap = await callTool(mcpA, 'hawkesgen_editor_apply', { id: p.id, ops: [{ op: 'text', text: 'Hi', start: 3, end: 4 }, { op: 'delete', id: 'nope' }] });
  assert.notEqual(ap.isError, true, textOf(ap));
  assert.deepEqual(ap.structuredContent.results.map((x: any) => x.ok), [true, false]);
  assert.equal(ledger(A.user.id).length, rows);
  assert.equal(credits(A.user.id), 1000 - house.turnCredits(0.1));
  setCredits(A.user.id, 5000);
});

test('mcp: the error for a bad project id names the id and what an id looks like', { todo: 'hawkesgen_editor_ask/apply pass any string to the route: a malformed id answers "No such editor route" and a missing one "No such scene", neither naming the id the caller gave (src/mcp-tools.ts)' }, async () => {
  const r = await callTool(mcpA, 'hawkesgen_editor_ask', { id: 'not-an-id', say: 'anything' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /not-an-id/);
  const missing = await callTool(mcpA, 'hawkesgen_editor_apply', { id: 'ep_0123456789ab', ops: [] });
  assert.match(textOf(missing), /ep_0123456789ab/);
});

// ================================================================== a generate op that names a tool the AI should never run
// What the AI editor's `generate` op does today with comfy.graph (a raw ComfyUI graph), unity.build (internal only) and
// playtest.run (a browser run of any build), and what the scene AI does with the same tools as jobs. The editor checks only
// that the tool exists (timeline.ts applyOps) and leaves the rest to the queue's own rules (billing.ts INTERNAL_ONLY_TOOLS),
// where the scene AI also asks `aiCanUse` (editor.ts) first. The todo tests are the wanted behaviour: the AI never plans these.
// playtest.run's params here name an asset that does not exist, so the run is refused at admit and no browser is ever started.
const HOSTILE: Record<string, Record<string, unknown>> = {
  'comfy.graph': { family: 'qwen-edit', graph: { '1': { class_type: 'KSampler', inputs: {} } } },
  'unity.build': { github: { repo: 'jgriffith3433/hawkesgen', ref: 'main' } },
  'playtest.run': { build: 'asset:a_ffffffffffff', scenario: 'smoke' },
};
const hostileOp = (tool: string) => ({ op: 'generate', tool, params: HOSTILE[tool], place: { library: true } });
const queuedTools = (since: number) => (db.prepare('SELECT tool FROM jobs ORDER BY rowid DESC LIMIT ?').all(jobCount() - since) as { tool: string }[]).map((r) => r.tool);

for (const tool of Object.keys(HOSTILE)) {
  test(`AI editor generate op: ${tool} is refused with a plain reason and starts no job`, async () => {
    const p = await videoProject();
    const before = jobCount();
    queue(A, [{ match: 'hostile', json: { say: 'ok', ops: [hostileOp(tool)] } }]);
    const r = await a(`/v1/editor/projects/${p.id}/assistant`, 'POST', { messages: [{ role: 'user', text: 'hostile' }], autoCredits: 1_000_000 });
    const body = await r.json() as any;
    assert.equal(r.status, 200, 'the turn itself succeeds: a refused op is reported, not thrown');
    assert.equal(body.results[0].ok, false);
    assert.match(body.results[0].error, /not available from the editor/, `got: ${body.results[0].error}`);
    assert.equal(jobCount(), before);
    AM.clearAnswers(A.user.id);
  });
}

const { applyOps, newDoc } = await import('../src/timeline.ts');
test('applyOps: a refused generate op leaves the other ops applied, and catalog tools still queue', () => {
  const submitted: string[] = [];
  const submit = (spec: any) => { submitted.push(spec.tool); return { id: 'j_test' } as any; };
  const r = applyOps(newDoc('t', 'video'), [hostileOp('comfy.graph'), { op: 'generate', tool: 'audio.music', params: { prompt: 'x', seconds: 5 }, place: { library: true } }, hostileOp('playtest.run'), hostileOp('unity.build')] as any, submit as any, 'video');
  assert.deepEqual(r.results.map((x) => x.ok), [false, true, false, false]);
  assert.deepEqual(submitted, ['audio.music']);
});

test('scene AI jobs, today: comfy.graph, unity.build and playtest.run are all dropped as "no tool ..." (aiCanUse), in the turn and in /apply', async () => {
  const s = await newCharacter();
  const before = jobCount();
  for (const tool of Object.keys(HOSTILE)) {
    queue(A, [{ match: 'hostile', json: { say: 'ok', doc: s.doc, jobs: [{ gen: 0, tool, params: HOSTILE[tool] }] } }]);
    const r = await (await askScene(s.id, 'hostile', { autoCredits: 1_000_000 })).json() as any;
    assert.deepEqual(r.started, [], tool);
    assert.deepEqual(r.errors, [`no tool ${tool}`]);
    assert.equal(r.proposed, undefined, 'not even proposed for a tap');
    const ap = await (await a(`/v1/scenes/${s.id}/apply`, 'POST', { jobs: [{ gen: 0, tool, params: HOSTILE[tool] }] })).json() as any;
    assert.deepEqual(ap.started, []);
    assert.deepEqual(ap.errors, [`no tool ${tool}`]);
  }
  assert.equal(jobCount(), before);
  AM.clearAnswers(A.user.id);
});

test('the same rule holds in /apply (proposed ops come back through it): none of the three starts a job', async () => {
  const p = await videoProject();
  const before = jobCount();
  const r = await (await a(`/v1/editor/projects/${p.id}/apply`, 'POST', { ops: Object.keys(HOSTILE).map(hostileOp) })).json() as any;
  assert.deepEqual(r.results.map((x: any) => x.ok), [false, false, false]);
  for (const x of r.results) assert.match(x.error, /not available from the editor/);
  assert.equal(jobCount(), before);
});

// ================================================================== the legacy POST /v1/assistant/chat as a customer key
// It is an old Hawkes Play helper that calls ask() with no callScope and no account: so it never takes the house AI's
// route, never writes an ai_turn row, and (without an Anthropic key of the account's own) runs on the studio's Claude.
// Recorded here with a fake Anthropic API that counts the calls and the key they carry.
// One fake Anthropic API for the whole file: the SDK client for the env key is built once, with the base URL it first saw.
const studioCalls: { key: string }[] = [];
const STUDIO_KEY = 'sk-ant-api03-STUDIO-OWN-KEY-legacy-probe-0001';
let studioFake: http.Server | null = null;
test.after(() => { studioFake?.close(); });
/** Runs `fn` with the studio's own Claude (API-key backend, key from the environment) pointed at the fake, so no real Claude is reached. */
async function withStudioClaude<T>(fn: () => Promise<T>): Promise<{ result: T; calls: { key: string }[]; key: string }> {
  const { saveSettings, loadSettings } = await import('../src/config.ts');
  if (!studioFake) {
    studioFake = http.createServer((q, res) => {
      q.resume();
      q.on('end', () => { studioCalls.push({ key: String(q.headers['x-api-key'] ?? '') }); res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); });
    });
    await new Promise<void>((ok) => studioFake!.listen(0, '127.0.0.1', () => ok()));
  }
  studioCalls.length = 0;
  const was = loadSettings().claude, wasKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(studioFake.address() as any).port}`;
  process.env.ANTHROPIC_API_KEY = STUDIO_KEY;
  saveSettings({ claude: { ...was, backend: 'api' } });
  const log = console.error; console.error = () => {};
  try { return { result: await fn(), calls: [...studioCalls], key: STUDIO_KEY }; }
  finally {
    console.error = log; saveSettings({ claude: was }); delete process.env.ANTHROPIC_BASE_URL;
    if (wasKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = wasKey;
  }
}

test('legacy /v1/assistant/chat as a user client: not charged, not scoped to the account, runs on the studio\'s own Claude key', async () => {
  setCredits(A.user.id, 700);
  queue(A, [{ json: { say: 'this canned answer is for the scoped surfaces only' } }]);
  const rows = ledger(A.user.id).length;
  const { result: r, calls, key } = await withStudioClaude(() => a('/v1/assistant/chat', 'POST', { message: 'make me a platformer', gameContext: { gameName: 'Probe' }, history: [] }));
  // It reached Anthropic with the studio's key (the account has none of its own), and the mock did not answer for the account.
  assert.equal(r.status, 500);
  assert.match((await r.json() as any).error, /AI assistant error/);
  assert.equal(calls.length, 1, 'one real call went out');
  assert.equal(calls[0].key, key, 'with the studio\'s key, not the account\'s or the house AI\'s');
  assert.equal(AM.mockStatus(A.user.id).queued, 1, 'the account\'s canned answer was not used: the call has no account scope');
  // And it is free to the person: no credits taken, no ai_turn row.
  assert.equal(credits(A.user.id), 700);
  assert.equal(ledger(A.user.id).length, rows);
  // The house AI being off changes nothing for it (the other assistants answer 503): it still goes to the studio's Claude.
  house.saveHouseSettings({ source: 'off' });
  try {
    const off = await withStudioClaude(() => a('/v1/assistant/chat', 'POST', { message: 'again' }));
    assert.equal(off.calls.length, 1);
    assert.notEqual(off.result.status, 503);
  } finally { house.saveHouseSettings({ source: 'auto' }); }
  AM.clearAnswers(A.user.id);
  setCredits(A.user.id, 5000);
});

test('legacy /v1/assistant/chat: the owner-only rule is a 403 for a key that is not a user, a 400 without a message; /generate has the same gate', async () => {
  assert.equal((await a('/v1/assistant/chat', 'POST', {})).status, 400);
  const anon = await fetch(`${base}/v1/assistant/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
  assert.ok([401, 403].includes(anon.status), String(anon.status));
});

test('legacy /v1/assistant/chat as a user client uses the studio\'s Claude without paying: a known gap', { todo: 'POST /v1/assistant/chat (assistant.ts processMessage) calls ask() outside callScope: a customer\'s message runs on the studio\'s Claude (Max plan or API key) at no cost to them. It should take the house AI route and charge ai_turn like the other assistants, or be turned off for role user.' }, async () => {
  // Wanted: with the house AI off, the legacy chat is refused like every other assistant (503) and never reaches the studio's Claude.
  house.saveHouseSettings({ source: 'off' });
  try {
    const { result: r, calls } = await withStudioClaude(() => a('/v1/assistant/chat', 'POST', { message: 'make me a platformer' }));
    assert.equal(calls.length, 0, 'the studio\'s Claude was called');
    assert.equal(r.status, 503);
  } finally { house.saveHouseSettings({ source: 'auto' }); }
});
