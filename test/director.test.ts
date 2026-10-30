// The house AI (src/houseai.ts), /admin's accounts (src/accounts.ts) and the director (src/director.ts): a shot is
// kept in range and exports to Gen's Blender film pipeline; the stage's maths (poseAt, cameraAt) puts people and the
// camera where blender.render would; accounts get gifts, adjustments and can be disabled; only the owner reaches /admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-director-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');
delete process.env.ANTHROPIC_API_KEY;

const dr = await import('../src/director.ts');
const house = await import('../src/houseai.ts');
const { poseAt, cameraAt, keyedAt } = await import('../dashboard/gen/stage-math.js') as any;

test('a shot is kept in range, ids are kept, and junk is dropped', () => {
  const s = dr.normalizeShot({ title: 'Duel', seconds: 99, aspect: '4:3', cast: [{ name: 'A', height: 50, position: [500, 'x'], beats: [{ to: [1, 2], seconds: 2 }, { lookAt: 1 }] }, { id: 'm_abcd1234', name: 'B' }], camera: { move: 'zoom', lens: 1, target: 7 } });
  assert.equal(s.seconds, 10);
  assert.equal(s.aspect, '16:9');
  assert.equal(s.cast[0].height, 12);
  assert.deepEqual(s.cast[0].position, [60, 0]);
  assert.equal(s.cast[1].id, 'm_abcd1234');
  assert.match(s.cast[0].id, /^m_/);
  assert.equal(s.camera.move, 'static');
  assert.equal(s.camera.lens, 10);
  assert.equal(s.camera.target, 0);
  assert.deepEqual(s.cast[0].beats[1], { lookAt: 1 });
});

test('the Blender export needs a model for everyone, and builds the cinema recipe with the files in order', () => {
  const stand = dr.normalizeShot({ cast: [{ name: 'Hero' }] });
  assert.throws(() => dr.blenderRecipe(stand), /3D model for everyone: Hero/);
  const s = dr.normalizeShot({ look: 'neon alley', action: 'he walks', cast: [{ name: 'Hero', asset: 'a_1111aaaa', animation: 'Walk' }, { name: 'Twin', asset: 'a_1111aaaa' }], props: [{ asset: 'a_2222bbbb' }, { name: 'box' }], set: { sky: 'a_3333cccc' } });
  const { recipe, files } = dr.blenderRecipe(s);
  assert.deepEqual(files, ['asset:a_1111aaaa', 'asset:a_2222bbbb', 'asset:a_3333cccc']);
  assert.deepEqual(recipe.steps.map((x) => x.tool).slice(0, 2), ['film.gate', 'blender.render']);
  assert.ok(recipe.steps.some((x) => x.tool === 'video.control'));
  const shot: any = recipe.steps[0].params!.shot;
  assert.equal(shot.characters[1].file, 0);
  assert.equal(shot.props.length, 1);
  assert.equal(shot.background.file, 2);
  assert.match(String(recipe.steps.find((x) => x.tool === 'image.edit')!.params!.prompt), /neon alley/);
});

test('the stage puts a walker and the camera where the shot says', () => {
  const cast = [{ position: [0, 0], facing: 0, height: 1.75, beats: [{ to: [4, 0], seconds: 2 }] }];
  const mid = poseAt(cast, 0, 1);
  assert.deepEqual(mid.pos.map((v: number) => Math.round(v * 100) / 100), [2, 0]);
  assert.equal(Math.round(mid.face), 90);
  assert.equal(mid.walking, true);
  assert.equal(poseAt(cast, 0, 5).walking, false);
  // Angle 0 is in front of the character: facing 0 looks toward -y, so the camera stands at -y.
  const shot = { seconds: 4, cast: [{ position: [0, 0], facing: 0, height: 1.8, beats: [] }], camera: { move: 'push-in', target: 0, angle: 0, distance: 5, height: 1.6, lens: 35, aimHeight: 0.5, amount: 0.4 } };
  const a = cameraAt(shot, 0, 16 / 9), b = cameraAt(shot, 4, 16 / 9);
  assert.ok(Math.abs(a.pos.y + 5) < 1e-6 && Math.abs(a.pos.x) < 1e-6);
  assert.ok(Math.abs(b.pos.y + 3) < 1e-6, 'pushed in by 40%');
  assert.ok(Math.abs(a.look.z - 0.9) < 1e-6);
});

test('camera keys replace the move and ease between; film settings are kept in range', () => {
  const s = dr.normalizeShot({ seconds: 6, cast: [{ name: 'A' }], camera: { move: 'orbit', distance: 4, keys: [{ t: 4, distance: 10 }, { t: 2, distance: 4, lens: 999 }] }, film: { engine: 'wan', strength: 3, nodes: { 'a.b': 1, 'bad key!': 2, 'c.d': { x: 1 } } } });
  assert.deepEqual(s.camera.keys!.map((k) => k.t), [2, 4]);
  assert.equal(s.camera.keys![0].lens, 200);
  assert.equal(s.film.engine, 'wan');
  assert.equal(s.film.strength, 1);
  assert.deepEqual(s.film.nodes, { 'a.b': 1 });
  assert.equal(keyedAt(s.camera.keys, 0).distance, 4);
  assert.equal(keyedAt(s.camera.keys, 3).distance, 7);
  assert.equal(keyedAt(s.camera.keys, 9).distance, 10);
  const shot = { ...s, cast: [{ position: [0, 0], facing: 0, height: 1.8, beats: [] }] };
  const a = cameraAt(shot, 0, 16 / 9), b = cameraAt(shot, 6, 16 / 9);
  assert.ok(Math.abs(Math.hypot(a.pos.x, a.pos.y) - 4) < 1e-6, 'the orbit is replaced: in front, 4 m');
  assert.ok(Math.abs(Math.hypot(b.pos.x, b.pos.y) - 10) < 1e-6);
  assert.ok(Math.abs(a.pos.x) < 1e-6, 'no orbit');
  // Blender films the move, not the keys, and says so.
  const withModel = dr.normalizeShot({ ...s, cast: [{ name: 'A', asset: 'a_1111aaaa' }] });
  const { recipe } = dr.blenderRecipe(withModel);
  assert.match(recipe.notes[0], /not the camera keys/);
  assert.ok(!(recipe.steps[0].params!.shot as any).camera.keys);
});

test('sequences: the AI plans shots in order, a sequence shares its set, look and cast, shots are added and reordered', () => {
  const P = 'u_5ce4e0000001';
  const first = dr.createShot(P, { title: 'Argument', cast: [{ name: 'Ana', voice: 'voice_ana1' }, { name: 'Ben' }], lines: [{ who: 1, text: 'You knew.', at: 9 }, { who: 4, text: 'x' }, { who: 0, text: '' }] });
  assert.equal(first.doc.lines.length, 2, 'empty lines go');
  assert.equal(first.doc.lines[1].who, 1, 'who stays in the cast');
  assert.equal(first.doc.cast[0].voice, 'voice_ana1');
  // The AI answers with three shots: the first kept (by shotId), two new; it becomes a scene.
  const ids = first.doc.cast.map((c) => c.id);
  const ans = dr.parseDirector(JSON.stringify({ say: 'Covered.', sequenceTitle: 'The kitchen', current: 2, shots: [
    { ...first.doc, shotId: first.id, title: 'Wide' },
    { ...first.doc, title: 'Over her shoulder', kind: 'talk', lines: [{ who: 1, text: 'You knew.', at: 0 }] },
    { ...first.doc, title: 'Her close-up', kind: 'talk', lines: [{ who: 0, text: 'I did.', at: 0 }] },
  ] }), first.doc, first.id);
  const shown = dr.applyDirector(P, first, ans);
  assert.equal(shown.doc.title, 'Her close-up');
  const sc = dr.sequenceSummary(shown.doc.sequence, P)!;
  assert.equal(sc.title, 'The kitchen');
  assert.deepEqual(sc.shots.map((x) => x.title), ['Wide', 'Over her shoulder', 'Her close-up']);
  assert.equal(sc.shots[0].id, first.id);
  // A save shares the set, the look and who people are, not the blocking.
  const wide = dr.getShot(first.id, () => true);
  const moved = dr.saveShot(wide, { ...wide.doc, look: 'A cramped kitchen at 2 am', set: { ...wide.doc.set, lights: 'night' }, cast: wide.doc.cast.map((c, i) => ({ ...c, description: i === 0 ? 'red coat' : c.description, position: [i * 5, 1] })) });
  dr.shareAcross(moved);
  const other = dr.sequenceShots(moved.doc.sequence!, P)[2];
  assert.equal(other.doc.look, 'A cramped kitchen at 2 am');
  assert.equal(other.doc.set.lights, 'night');
  assert.equal(other.doc.cast.find((c) => c.id === ids[0])!.description, 'red coat');
  assert.notDeepEqual(other.doc.cast.find((c) => c.id === ids[1])!.position, [5, 1], 'blocking stays per shot');
  // Next shot goes right after, the rest move down; reorder puts them in the given order.
  const added = dr.addShotAfter(dr.getShot(first.id, () => true));
  assert.deepEqual(dr.sequenceSummary(added.doc.sequence, P)!.shots.map((x) => x.id)[1], added.id);
  const all = dr.sequenceSummary(added.doc.sequence, P)!.shots.map((x) => x.id);
  dr.reorderSequence(added.doc.sequence!, P, [...all].reverse());
  assert.deepEqual(dr.sequenceSummary(added.doc.sequence, P)!.shots.map((x) => x.id), [...all].reverse());
  // A shot the AI leaves out leaves the scene (never deleted).
  const keep = dr.sequenceShots(added.doc.sequence!, P);
  dr.applyDirector(P, keep[0], { say: '', sequenceTitle: null, current: 0, shots: keep.slice(0, 2).map((x) => ({ ...x.doc, shotId: x.id })) });
  assert.equal(dr.sequenceShots(added.doc.sequence!, P).length, 2);
  assert.equal(dr.getShot(keep[3].id, () => true).doc.sequence, null);
  // The talk prompt is about the speaker; spoken lines keep words out of the video's own sound.
  const pr = dr.filmPrompts(dr.getShot(keep[0].id, () => true).doc);
  assert.ok(typeof pr.talk === 'string' && pr.talk.length > 10);
});

test('the house AI: what accounts get, the price, and the key never comes back', () => {
  house.saveHouseSettings({ source: 'off' });
  assert.equal(house.houseRoute().via, null);
  house.saveHouseSettings({ source: 'api', markup: 2, minCredits: 3 });
  assert.equal(house.turnCredits(0), 3);
  assert.equal(house.turnCredits(0.05), 10);
  assert.throws(() => house.checkCanPay(2), /at least 3 credits/);
  const st = house.setHouseKey(`sk-ant-api03-${'k'.repeat(30)}`, 'test');
  assert.equal(st.now, 'api');
  assert.equal(st.key.last4, 'kkkk');
  assert.ok(!JSON.stringify(st).includes('k'.repeat(30)));
  house.saveHouseSettings({ source: 'off' });
  assert.equal(house.houseRoute().via, null);
  house.clearHouseKey();
});

test('routes: /admin is the owner\'s; accounts get gifts, adjustments and can be disabled; shots are per account', async () => {
  const { handle } = await import('../src/api.ts');
  const { signupUser } = await import('../src/users.ts');
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const a = signupUser({ email: 'dir-a@example.com', password: 'secret-123', name: 'A' });
    const b = signupUser({ email: 'dir-b@example.com', password: 'secret-123', name: 'B' });
    const as = (token: string | null) => (route: string, method = 'GET', body?: unknown) => fetch(base + route, {
      method, headers: { ...(token ? { cookie: `hg_session=${token}` } : {}), Origin: 'https://hawkesgen.ai', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const A = as(a.sessionToken), B = as(b.sessionToken), OWNER = as(null);
    assert.equal((await A('/v1/admin/accounts')).status, 403);
    assert.equal((await A('/v1/admin/ai')).status, 403);
    const list = await (await OWNER('/v1/admin/accounts?q=dir-a')).json();
    assert.equal(list.items.length, 1);
    const id = list.items[0].id;
    const start = list.items[0].credits;
    const gifted = await (await OWNER(`/v1/admin/accounts/${id}/gift`, 'POST', { credits: 25, note: 'Thanks for testing' })).json();
    assert.equal(gifted.account.credits, start + 25);
    assert.match(gifted.ledger[0].detail, /Thanks for testing/);
    const less = await (await OWNER(`/v1/admin/accounts/${id}/credits`, 'POST', { delta: -10, note: 'oops' })).json();
    assert.equal(less.account.credits, start + 15);
    assert.equal((await OWNER(`/v1/admin/accounts/${id}/credits`, 'POST', { delta: 0 })).status, 400);
    // Shots are the account's own.
    const shot = await (await A('/v1/director/shots', 'POST', { title: 'Duel' })).json();
    assert.match(shot.id, /^sh_/);
    assert.equal((await B(`/v1/director/shots/${shot.id}`)).status, 404);
    const saved = await (await A(`/v1/director/shots/${shot.id}`, 'PUT', { doc: { ...shot.doc, cast: [{ name: 'Hero' }] }, version: shot.version })).json();
    assert.equal(saved.doc.cast[0].name, 'Hero');
    assert.equal((await A(`/v1/director/shots/${shot.id}`, 'PUT', { doc: shot.doc, version: shot.version })).status, 409);
    assert.equal((await A(`/v1/director/shots/${shot.id}/blender?quote=1`, 'POST')).status, 400);
    // The house AI off: the director says so instead of asking the person for a key.
    const turn = await A(`/v1/director/shots/${shot.id}/assistant`, 'POST', { messages: [{ role: 'user', text: 'a duel' }] });
    assert.equal(turn.status, 503);
    assert.equal((await (await A('/v1/users/me/ai')).json()).house.ready, false);
    // Disabled: signed out, and the session no longer works.
    await OWNER(`/v1/admin/accounts/${id}/disable`, 'POST', {});
    assert.ok([401, 403].includes((await A('/v1/director/shots')).status), 'a disabled account is refused');
    await OWNER(`/v1/admin/accounts/${id}/enable`, 'POST', {});
  } finally {
    server.close();
  }
});
