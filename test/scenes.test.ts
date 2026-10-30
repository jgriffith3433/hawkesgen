// Scenes (src/scenes.ts): one store for every kind, the editor's projects brought in with their ids, the image, audio and
// character kinds (src/scenekinds.ts), elements filled in when their jobs end, scenes that use each other, the AI's
// answers applied (src/sceneai.ts: gen marks, el: inputs, proposals over the auto limit), and the routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-scenes-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');

// An editor project made before scenes existed (the live table), to be brought in.
const { db } = await import('../src/db.ts');
db.exec(`CREATE TABLE IF NOT EXISTS editor_projects (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, doc TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
db.prepare('INSERT INTO editor_projects VALUES (?, ?, ?, ?, 3, 1, 2)').run('ep_0123456789ab', 'u_0000aaaa0000', 'Old cut', JSON.stringify({ title: 'Old cut', clips: [{ track: 'T1', text: 'Hi', start: 0, in: 0, out: 2 }] }));

const sc = await import('../src/scenes.ts');
const ed = await import('../src/editor.ts');
const dr = await import('../src/director.ts');
const kinds = await import('../src/scenekinds.ts');
const ai = await import('../src/sceneai.ts');

test('the editor\'s old projects come into the store as video scenes, ids and versions kept', () => {
  const p = ed.getProject('ep_0123456789ab', () => true);
  assert.equal(p.kind, 'video');
  assert.equal(p.version, 3);
  assert.equal(p.doc.clips[0].text, 'Hi');
  assert.deepEqual(sc.listScenes('u_0000aaaa0000').map((x) => x.id), ['ep_0123456789ab']);
});

test('image, audio and character documents are kept in range', () => {
  const im = kinds.normalizeImage({ width: 99999, layers: [{ type: 'text', text: 'Title', size: 5000 }, { asset: 'a_1234abcd', blend: 'nope', opacity: 7 }, { type: 'image' }, { type: 'fill', color: '#FF0000' }] });
  assert.equal(im.width, 4096);
  assert.equal(im.layers.length, 4);
  assert.equal(im.layers[0].size, 1000);
  assert.equal(im.layers[1].blend, 'normal');
  assert.equal(im.layers[1].opacity, 1);
  assert.equal(im.layers[3].color, '#ff0000');
  const au = kinds.normalizeAudio({ tracks: [{ name: 'Music', clips: [{ asset: 'a_1234abcd', in: 2, out: 1, gain: 9 }, { label: 'nothing' }] }] });
  assert.equal(au.tracks[0].clips.length, 1, 'a clip with no file is dropped');
  assert.ok(au.tracks[0].clips[0].out > au.tracks[0].clips[0].in);
  assert.equal(au.tracks[0].clips[0].gain, 4);
  const ch = kinds.normalizeCharacter({ name: 'Ana', model: { asset: 'a_1234abcd' }, pictures: [{ role: 'front', asset: 'a_1234abcd' }, { role: 'x' }], clips: [{ name: ' Walk ' }, {}] });
  assert.equal(ch.title, 'Ana');
  assert.equal(ch.model!.asset, 'a_1234abcd');
  assert.equal(ch.pictures.length, 1);
  assert.deepEqual(ch.clips, [{ name: 'Walk' }]);
});

test('elements waiting on jobs are filled in, or say why not', () => {
  const els: any[] = [{ pending: 'j_aaaaaaaa' }, { pending: 'j_bbbbbbbb' }, { pending: 'j_cccccccc' }];
  const jobs: Record<string, any> = {
    j_aaaaaaaa: { status: 'done', outputs: [{ kind: 'image', title: 'mask', asset: 'a_mask0000' }, { kind: 'image', title: 'cutout', asset: 'a_cut00000' }] },
    j_bbbbbbbb: { status: 'failed', error: 'GPU on fire\nstack' },
    j_cccccccc: { status: 'running', outputs: [] },
  };
  assert.equal(kinds.resolveElements(els, ['image'], (id: string) => jobs[id]), true);
  assert.equal(els[0].asset, 'a_cut00000', 'the cutout, not the mask');
  assert.equal(els[1].failed, 'GPU on fire');
  assert.equal(els[2].pending, 'j_cccccccc');
});

test('a stage cast member who is a character scene takes who they are from it', () => {
  const P = 'u_0000bbbb0000';
  const ana = sc.createScene(P, 'character', { title: 'Ana', description: 'red coat, short black hair', height: 1.6, voice: 'voice_ana_01', model: { asset: 'a_1234abcd' } });
  const shot = dr.createShot(P, { cast: [{ character: ana.id, name: 'whoever', position: [1, 2] }] });
  assert.equal(shot.doc.cast[0].name, 'Ana');
  assert.equal(shot.doc.cast[0].voice, 'voice_ana_01');
  assert.equal(shot.doc.cast[0].asset, 'a_1234abcd');
  assert.deepEqual(shot.doc.cast[0].position, [1, 2], 'where they stand is the shot\'s');
  sc.saveScene(ana, { ...ana.doc, description: 'blue coat' });
  assert.equal(dr.getShot(shot.id, () => true).doc.cast[0].description, 'blue coat', 'a change to the character reaches the shot');
  assert.deepEqual(sc.usedBy(dr.getShot(shot.id, () => true), () => true).map((x) => x.id), [ana.id]);
});

test('the AI\'s answer: gen marks wait on their jobs, el: inputs read the element, big spends wait for a tap', () => {
  const P = 'u_0000cccc0000';
  const s = sc.createScene(P, 'image', { title: 'Poster', layers: [{ id: 'l_bg01', asset: 'a_1234abcd' }] });
  const submitted: any[] = [];
  const deps = (auto: number, confirm = false) => ({ submit: (spec: any) => { submitted.push(spec); return { id: `j_${String(submitted.length).padStart(8, '0')}` }; }, quote: () => 30, autoCredits: auto, confirm });
  const ans = ai.parseScene(JSON.stringify({ say: 'Relit it and added a title.', doc: { ...s.doc, layers: [{ ...s.doc.layers[0], gen: 0 }, { type: 'text', text: 'NIGHT' }] }, jobs: [{ gen: 0, tool: 'image.relight', params: { prompt: 'moonlight' }, inputs: { image: 'el:l_bg01' } }] }), s.doc);
  const r = ai.applyScene(s, ans, deps(40));
  assert.deepEqual(r.errors, []);
  assert.equal(submitted[0].inputs.image, 'asset:a_1234abcd');
  assert.equal(r.doc.layers[0].pending, 'j_00000001');
  assert.equal(r.doc.layers[0].gen, undefined);
  assert.equal(r.doc.layers[1].text, 'NIGHT');
  // Over the auto limit: nothing runs, the proposal comes back; confirmed, it runs.
  const big = ai.applyScene(s, { ...ans, jobs: [ans.jobs[0], { ...ans.jobs[0], gen: 1 }] }, deps(40));
  assert.equal(big.proposed!.credits, 60);
  assert.equal(submitted.length, 1);
  const ok = ai.applyScene(s, { doc: big.proposed!.doc, jobs: big.proposed!.jobs }, deps(0, true));
  assert.equal(ok.started.length, 2);
  // A tool that isn't there, or an element with no file, is reported, not run.
  const bad = ai.applyScene(s, { doc: s.doc, jobs: [{ gen: 0, tool: 'no.tool', params: {}, inputs: {} }, { gen: 1, tool: 'image.relight', params: {}, inputs: { image: 'el:l_none' } }] }, deps(40));
  assert.equal(bad.errors.length, 2);
});

test('routes: every kind is made, listed, opened, saved with a version, rendered, duplicated; one account never sees another\'s', async () => {
  const { handle } = await import('../src/api.ts');
  const { signupUser } = await import('../src/users.ts');
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const a = signupUser({ email: 'sc-a@example.com', password: 'secret-123', name: 'A' });
    const b = signupUser({ email: 'sc-b@example.com', password: 'secret-123', name: 'B' });
    const as = (who: typeof a) => (route: string, method = 'GET', body?: unknown) => fetch(base + route, {
      method, headers: { cookie: `hg_session=${who.sessionToken}`, Origin: 'https://hawkesgen.ai', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const A = as(a), B = as(b);
    const made: Record<string, any> = {};
    for (const kind of ['video', 'stage', 'image', 'audio', 'character']) {
      const r = await A('/v1/scenes', 'POST', { kind, title: `My ${kind}` });
      assert.equal(r.status, 200, kind);
      made[kind] = await r.json();
      assert.equal(made[kind].kind, kind);
    }
    assert.equal(made.audio.doc.tracks.length, 3, 'an audio scene starts with three tracks');
    assert.equal((await A('/v1/scenes', 'POST', { kind: 'spreadsheet' })).status, 400);
    assert.equal((await (await A('/v1/scenes')).json()).items.length, 5);
    assert.deepEqual((await (await A('/v1/scenes?kind=image')).json()).items.map((x: any) => x.id), [made.image.id]);
    assert.equal((await B(`/v1/scenes/${made.image.id}`)).status, 404);
    assert.equal((await (await B('/v1/scenes')).json()).items.length, 0);
    // The editor's and the director's own routes see the same scenes.
    assert.equal((await A(`/v1/editor/projects/${made.video.id}`)).status, 200);
    assert.equal((await A(`/v1/director/shots/${made.stage.id}`)).status, 200);
    // Save with a version; a crossing save is refused with the newer scene.
    const im = made.image;
    const saved = await (await A(`/v1/scenes/${im.id}`, 'PUT', { doc: { ...im.doc, layers: [{ type: 'text', text: 'Hello' }] }, version: im.version })).json();
    assert.equal(saved.doc.layers[0].text, 'Hello');
    const crossed = await A(`/v1/scenes/${im.id}`, 'PUT', { doc: im.doc, version: im.version });
    assert.equal(crossed.status, 409);
    assert.equal((await crossed.json()).scene.version, saved.version);
    // A video scene that plays the image scene lists it in `uses`.
    const vid = await (await A(`/v1/scenes/${made.video.id}`, 'PUT', { doc: { ...made.video.doc, clips: [{ track: 'V1', kind: 'image', scene: im.id, start: 0, in: 0, out: 3 }] } })).json();
    assert.deepEqual(vid.uses.map((x: any) => x.id), [im.id]);
    // Render: only a file the caller can see.
    assert.equal((await A(`/v1/scenes/${im.id}/render`, 'PUT', { asset: 'a_ffffffffffff' })).status, 404);
    // Duplicate: a copy without the render.
    const copy = await (await A(`/v1/scenes/${made.character.id}/duplicate`, 'POST')).json();
    assert.equal(copy.title, 'My character copy');
    assert.notEqual(copy.id, made.character.id);
    // The scene AI needs the AI set up (off in tests): it says so plainly.
    assert.equal((await A(`/v1/scenes/${im.id}/assistant`, 'POST', { messages: [{ role: 'user', text: 'make it night' }] })).status, 503);
    assert.equal((await A(`/v1/scenes/${made.video.id}`, 'DELETE')).status, 200);
    assert.equal((await A(`/v1/scenes/${made.video.id}`)).status, 404);
  } finally {
    server.close();
  }
});
