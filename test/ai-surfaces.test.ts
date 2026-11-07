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
