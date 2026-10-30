// The Gen app's editor (src/editor.ts): the document and its edits (V1 back to back, split, trim, range delete,
// generate placing a waiting clip that fills in when its job ends), the AI's answer parsing, and the routes: projects
// per account, saving with a version, edits applied server-side, and one account never opening another's project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-editor-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

const ed = await import('../src/editor.ts');
const { orgOfProject, genAccountOrg } = await import('../src/orgsecrets.ts');

const vid = (asset: string, len: number) => ({ op: 'add', track: 'V1', asset, out: len, duration: len });

test('V1 is magnetic: clips sit back to back in order, and add/move place by index or after a clip', () => {
  let { doc } = ed.applyOps(ed.newDoc(), [vid('a_1', 4), vid('a_2', 2), vid('a_3', 3)]);
  assert.deepEqual(doc.clips.map((c) => [c.asset, c.start]), [['a_1', 0], ['a_2', 4], ['a_3', 6]]);
  const [c1, , c3] = doc.clips;
  ({ doc } = ed.applyOps(doc, [{ op: 'move', id: c3.id, index: 0 }]));
  assert.deepEqual(doc.clips.map((c) => [c.asset, c.start]), [['a_3', 0], ['a_1', 3], ['a_2', 7]]);
  ({ doc } = ed.applyOps(doc, [{ ...vid('a_4', 1), after: c1.id }]));
  assert.deepEqual(doc.clips.map((c) => c.asset), ['a_3', 'a_1', 'a_4', 'a_2']);
  assert.equal(ed.docLength(doc), 10);
});

test('split cuts a clip in two at a timeline time; trim and speed change its length; a bad op reports and the rest still apply', () => {
  let { doc } = ed.applyOps(ed.newDoc(), [vid('a_1', 6), vid('a_2', 2)]);
  const id = doc.clips[0].id;
  const r = ed.applyOps(doc, [{ op: 'split', id, at: 2.5 }, { op: 'split', id: 'c_nope', at: 1 }, { op: 'set', id, speed: 2 }]);
  doc = r.doc;
  assert.equal(r.results[1].ok, false);
  assert.equal(r.results[2].ok, true);
  const [left, right, b] = doc.clips;
  assert.deepEqual([left.in, left.out, right.in, right.out], [0, 2.5, 2.5, 6]);
  assert.equal(ed.clipLength(left), 1.25); // twice as fast
  assert.equal(right.start, 1.25);
  assert.equal(b.start, 1.25 + 3.5);
  ({ doc } = ed.applyOps(doc, [{ op: 'trim', id: right.id, length: 1 }]));
  assert.equal(doc.clips.find((c) => c.id === right.id)!.out, 3.5);
  assert.equal(ed.applyOps(doc, [{ op: 'trim', id: right.id, in: 5, out: 5 }]).results[0].ok, false);
});

test('deleteRange cuts a stretch out of every track: V1 closes up, audio and text slide back, clips across the edges are trimmed', () => {
  let { doc } = ed.applyOps(ed.newDoc(), [vid('a_1', 4), vid('a_2', 4), { op: 'add', track: 'A1', asset: 'a_m', start: 0, out: 8, duration: 8 }, { op: 'text', text: 'late', start: 6, end: 7 }]);
  ({ doc } = ed.applyOps(doc, [{ op: 'deleteRange', start: 3, end: 5 }]));
  const v = doc.clips.filter((c) => c.track === 'V1');
  assert.deepEqual(v.map((c) => [c.asset, c.start, c.in, c.out]), [['a_1', 0, 0, 3], ['a_2', 3, 1, 4]]);
  const music = doc.clips.filter((c) => c.track === 'A1');
  assert.deepEqual(music.map((c) => [c.start, c.in, c.out]), [[0, 0, 3], [3, 5, 8]]);
  assert.equal(doc.clips.find((c) => c.track === 'T1')!.start, 4);
  assert.equal(ed.docLength(doc), 6);
});

test('generate submits the job with clip: inputs resolved, shows a waiting clip, and resolvePending fills it in (or says why it failed)', () => {
  let { doc } = ed.applyOps(ed.newDoc(), [vid('a_1', 4)]);
  const first = doc.clips[0].id;
  const asked: any[] = [];
  const submit = (s: any) => { asked.push(s); return { id: `j_${asked.length}` }; };
  const r = ed.applyOps(doc, [
    { op: 'generate', tool: 'video.upscale', inputs: { video: `clip:${first}` }, place: { replace: first } },
    { op: 'generate', tool: 'audio.sfx', params: { text: 'boom', duration: 2 }, place: { track: 'A3', start: 1 } },
    { op: 'generate', tool: 'no.such', params: {} },
  ], submit);
  doc = r.doc;
  assert.equal(asked[0].inputs.video, 'asset:a_1');
  assert.equal(r.results[2].ok, false);
  const up = doc.clips.find((c) => c.id === first)!;
  assert.equal(up.pending, true);
  assert.equal(up.job, 'j_1');
  const boom = doc.clips.find((c) => c.track === 'A3')!;
  assert.deepEqual([boom.start, boom.out, boom.pending], [1, 2, true]);
  const jobs: Record<string, any> = {
    j_1: { status: 'done', outputs: [{ asset: 'a_up', kind: 'video' }] },
    j_2: { status: 'failed', error: 'GPU busy\nstack', outputs: [] },
  };
  assert.equal(ed.resolvePending(doc, (id) => jobs[id]), true);
  assert.deepEqual([up.asset, up.pending], ['a_up', false]);
  assert.equal(boom.failed, 'GPU busy');
});

test('the AI\'s answer is read even when wrapped, and garbage gives words with no edits', () => {
  assert.deepEqual(ed.parseAnswer('Sure!\n```json\n{"say":"Done.","ops":[{"op":"delete","id":"c_abc"}, 5]}\n```').ops, [{ op: 'delete', id: 'c_abc' }]);
  assert.deepEqual(ed.parseAnswer('no json here'), { say: 'no json here', ops: [] });
});

test('a Gen account has its own org for its AI keys, never one of hawkesgen.ai\'s', () => {
  const o = orgOfProject('u_eef79b059739')!;
  assert.match(o, /^org_[0-9a-f]{24}$/);
  assert.equal(o, genAccountOrg('u_eef79b059739'));
  assert.notEqual(o, 'org_eef79b059739');
  assert.equal(orgOfProject('usr_eef79b059739'), 'org_eef79b059739');
});

test('routes: projects are per account, saves check the version, edits apply server-side, the AI key is the account\'s own', async () => {
  const { handle } = await import('../src/api.ts');
  const { signupUser } = await import('../src/users.ts');
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const a = signupUser({ email: 'ed-a@example.com', password: 'secret-123', name: 'A' });
    const b = signupUser({ email: 'ed-b@example.com', password: 'secret-123', name: 'B' });
    const as = (who: typeof a) => (route: string, method = 'GET', body?: unknown) => fetch(base + route, {
      method, headers: { cookie: `hg_session=${who.sessionToken}`, Origin: 'https://gen.hawkesgen.ai', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const A = as(a), B = as(b);
    const made = await (await A('/v1/editor/projects', 'POST', { title: 'Trip' })).json();
    assert.match(made.id, /^ep_/);
    assert.equal(made.doc.title, 'Trip');
    assert.equal((await B(`/v1/editor/projects/${made.id}`)).status, 404);
    assert.equal((await (await B('/v1/editor/projects')).json()).items.length, 0);

    const doc = { ...made.doc, clips: [{ track: 'V1', asset: 'a_1', in: 0, out: 3, duration: 3 }] };
    const saved = await (await A(`/v1/editor/projects/${made.id}`, 'PUT', { doc, version: made.version })).json();
    assert.equal(saved.version, 2);
    assert.equal((await A(`/v1/editor/projects/${made.id}`, 'PUT', { doc, version: made.version })).status, 409);
    const applied = await (await A(`/v1/editor/projects/${made.id}/apply`, 'POST', { ops: [{ op: 'text', text: 'Hi', start: 0, end: 2 }] })).json();
    assert.equal(applied.results[0].ok, true);
    assert.equal(applied.project.doc.clips.length, 2);

    assert.equal((await (await A('/v1/users/me/ai')).json()).anthropic.set, false);
    assert.equal((await A('/v1/users/me/ai/anthropic', 'PUT', { key: 'not-a-key' })).status, 400);
    const set = await (await A('/v1/users/me/ai/anthropic', 'PUT', { key: `sk-ant-api03-${'x'.repeat(30)}` })).json();
    assert.deepEqual([set.set, set.last4], [true, 'xxxx']);
    assert.equal((await (await B('/v1/users/me/ai')).json()).anthropic.set, false);
    assert.equal((await A(`/v1/editor/projects/${made.id}`, 'DELETE')).status, 200);
    assert.equal((await A(`/v1/editor/projects/${made.id}`)).status, 404);
  } finally {
    server.close();
  }
});
