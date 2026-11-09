// HAWKESGEN_AI_MOCK (src/aimock.ts): canned answers for ask(), only for a test sign-in account and only with the flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-aimock-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');
delete process.env.HAWKESGEN_AI_MOCK;

const { ask, callScope } = await import('../src/providers/anthropic.ts');
const { googleSignin } = await import('../src/users.ts');
const { orgOfProject } = await import('../src/orgsecrets.ts');
const AM = await import('../src/aimock.ts');
const { handle } = await import('../src/api.ts');
const ed = await import('../src/editor.ts');

const testUser = googleSignin({ sub: 'playtest:hawkesgen-app', email: 'playtest+hawkesgen-app@playtest.hawkesgen.ai', name: 'Playtest' }).user;
const realUser = googleSignin({ sub: '1029384756', email: 'person@example.com', name: 'Person' }).user;
const as = (u: { project: string }, f: () => Promise<any>) => callScope.run({ customer: true, org: orgOfProject(u.project), house: true }, f);

test('a queued answer comes back from ask() with its settable cost, by substring or by order', async () => {
  process.env.HAWKESGEN_AI_MOCK = '1';
  try {
    AM.queueAnswers(testUser.id, [
      { match: 'zebra', text: 'stripes', cost: 0.25 },
      { json: { say: 'ordered' }, model: 'm1' },
    ]);
    const texts: string[] = [];
    const a = await as(testUser, () => ask({ prompt: 'tell me about a zebra', onText: (t) => texts.push(t) }));
    assert.deepEqual([a.text, a.cost, a.model, texts], ['stripes', 0.25, 'mock', ['stripes']]);
    const b = await as(testUser, () => ask({ prompt: 'anything at all' }));
    assert.deepEqual([JSON.parse(b.text), b.cost, b.model], [{ say: 'ordered' }, 0, 'm1']);
    assert.equal(AM.mockStatus(testUser.id).queued, 0, 'each answer is used once by default');
  } finally { delete process.env.HAWKESGEN_AI_MOCK; }
});

test('the editor assistant route returns the ops from the canned answer, and the house AI charge follows its cost', async () => {
  process.env.HAWKESGEN_AI_MOCK = '1';
  process.env.HAWKESGEN_TEST_SIGNIN = '1';
  try {
    AM.queueAnswers(testUser.id, [{ match: 'add a title that says', cost: 0.5, json: { say: 'Added a title.', ops: [{ op: 'add', track: 'T1', text: 'Hello', start: 0, duration: 2 }] } }]);
    const turn = await ed.assistantTurn({ project: testUser.project, doc: ed.newDoc(), selection: {}, messages: [{ role: 'user', text: 'add a title that says Hello' }], library: [], voices: [], kind: 'video' });
    assert.equal(turn.say, 'Added a title.');
    assert.equal(turn.ops.length, 1);
    assert.equal(turn.ops[0].op, 'add');
    assert.equal(turn.cost, 0.5);
    assert.equal(turn.house, true);
  } finally { delete process.env.HAWKESGEN_AI_MOCK; delete process.env.HAWKESGEN_TEST_SIGNIN; }
});

test('with the flag unset nothing is queued and ask() takes its usual path', async () => {
  assert.throws(() => AM.queueAnswers(testUser.id, [{ text: 'x' }]), /off here/);
  process.env.HAWKESGEN_AI_MOCK = '1';
  AM.queueAnswers(testUser.id, [{ text: 'canned' }]);
  delete process.env.HAWKESGEN_AI_MOCK;
  // Flag off again: the queue is ignored, so the call goes on to the real path (no house AI is set up here, so it refuses).
  await assert.rejects(as(testUser, () => ask({ prompt: 'hi' })), (e: any) => e.message !== 'canned');
  process.env.HAWKESGEN_AI_MOCK = '1';
  AM.clearAnswers(testUser.id);
  delete process.env.HAWKESGEN_AI_MOCK;
});

test('a session that did not come from the test sign-in cannot use the mock, flag or not', async () => {
  process.env.HAWKESGEN_AI_MOCK = '1';
  try {
    assert.throws(() => AM.queueAnswers(realUser.id, [{ text: 'x' }]), /test sign-in/);
    // Even an answer queued for the test account is never given to the real user's calls.
    AM.queueAnswers(testUser.id, [{ text: 'canned' }]);
    await assert.rejects(as(realUser, () => ask({ prompt: 'hi' })), (e: any) => e.message !== 'canned');
    assert.equal(AM.mockStatus(testUser.id).queued, 1, 'the test account\'s answer is still waiting');
    assert.equal(AM.takeAnswer(null, { prompt: 'hi' }), null, 'a call with no account (Gen\'s own) gets none');
    AM.clearAnswers(testUser.id);
    // The route: 404 for anyone who is not the test account (no session at all included).
    const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/test/ai-mock`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer hg_bogus' }, body: '{"text":"x"}' });
      assert.ok([401, 403, 404].includes(r.status), `status ${r.status}`);
    } finally { server.close(); }
  } finally { delete process.env.HAWKESGEN_AI_MOCK; }
});
