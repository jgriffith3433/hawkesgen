// Identity packs (src/identity.ts, src/identity-film.ts, src/identityroutes.ts; docs/identity.md): the character
// document's lock and LoRA, the pack, "Make their look", the fixed description, LoRA eligibility and training, the
// prompts carrying the fixed description unchanged, references reaching every first-frame job (with the camera render),
// the Blender path, the identity check's retry, place and prop packs, and the routes. Nothing here runs a GPU or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-identity-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

const idn = await import('../src/identity.ts');
const film = await import('../src/identity-film.ts');
const kinds = await import('../src/scenekinds.ts');
const dr = await import('../src/director.ts');
const sc = await import('../src/scenes.ts');
const routes = await import('../src/identityroutes.ts');
const { putAsset } = await import('../src/library.ts');

const FIXED = 'A woman in her early thirties, tall and lean, warm brown skin, an oval face with high cheekbones, dark almond eyes and a small scar through her left eyebrow. Black hair in a short undercut, swept right. A rust-orange canvas field jacket over a grey hoodie, dark green cargo trousers, scuffed tan boots, a brass compass worn on a cord around her neck.';
const SHEET = 'a_5ee75ee75ee75ee7', FRONT = 'a_f0f0f0f0f0f0f0f0', PORTRAIT = 'a_9090909090909090', MODEL = 'a_3d3d3d3d3d3d3d3d';

const maya = (over: Record<string, unknown> = {}) => kinds.normalizeCharacter({
  title: 'Maya', description: 'A tall woman in an orange jacket',
  pictures: [{ role: 'front', asset: FRONT }, { role: 'portrait', asset: PORTRAIT }, { role: 'sheet', asset: SHEET }],
  model: { asset: MODEL }, lock: { sheet: SHEET, description: FIXED, at: 1761900000000 }, ...over,
});

test('the character document keeps the lock and the LoRA; old documents still load', () => {
  const old = kinds.normalizeCharacter({ title: 'Ana', pictures: [{ role: 'front', asset: FRONT }] });
  assert.equal(old.lock, undefined);
  assert.equal(old.lora, undefined);
  const m = maya();
  assert.deepEqual(m.lock, { sheet: SHEET, description: FIXED, at: 1761900000000 });
  // Only a whole pack locks: no sheet, no lock.
  assert.equal(kinds.normalizeCharacter({ lock: { description: FIXED, at: 5 } }).lock!.at, null);
  // The AI locking on the person's word ("at": true) becomes a time.
  assert.ok(Number(kinds.normalizeCharacter({ ...m, lock: { sheet: SHEET, description: FIXED, at: true } }).lock!.at) > 1e12);
  // A LoRA: training (with its job), ready (with its file), failed; junk is dropped.
  assert.deepEqual(kinds.normalizeCharacter({ lora: { pending: 'j_0123456789', trigger: 'hwk_maya' } }).lora, { trigger: 'hwk_maya', state: 'training', pending: 'j_0123456789' });
  assert.equal(kinds.normalizeCharacter({ lora: { asset: 'a_1234567890', trigger: 'hwk_maya', state: 'ready' } }).lora!.state, 'ready');
  assert.equal(kinds.normalizeCharacter({ lora: { state: 'nonsense' } }).lora, undefined);
  // A picture made by a chain names the saved step it takes.
  const p = kinds.normalizeCharacter({ pictures: [{ role: 'sheet', gen: 0, from: 'sheet' }, { role: 'front', asset: FRONT, from: 'x' }] }).pictures;
  assert.equal(p[0].from, 'sheet');
  assert.equal(p[1].from, undefined, 'a picture that has its file needs no from');
});

test('the pack: the locked sheet first, the fixed description, locked, the LoRA only once it is ready', () => {
  const pack = idn.identityPack(maya());
  assert.equal(pack.sheet, SHEET);
  assert.deepEqual(pack.refs, [SHEET, FRONT, PORTRAIT]);
  assert.equal(pack.description, FIXED);
  assert.equal(pack.locked, true);
  assert.equal(pack.model, MODEL);
  assert.equal(pack.lora, null);
  assert.equal(idn.identityPack(maya({ lora: { pending: 'j_0123456789', trigger: 't' } })).lora, null);
  assert.deepEqual(idn.identityPack(maya({ lora: { asset: 'a_1a1a1a1a1a', trigger: 'hwk_maya', state: 'ready' } })).lora, { asset: 'a_1a1a1a1a1a', trigger: 'hwk_maya' });
  // Without a lock: the loose words and the pictures, not locked.
  const loose = idn.identityPack(maya({ lock: null }));
  assert.equal(loose.description, 'A tall woman in an orange jacket');
  assert.equal(loose.locked, false);
});

test('"Make their look": the front (empty hands, plain, A-pose) only when missing, then the sheet over it', () => {
  const none = idn.lookPlan(kinds.normalizeCharacter({ title: 'Maya', description: 'A tall woman' }));
  assert.deepEqual(none.steps.map((s) => s.role), ['front', 'sheet']);
  assert.match(none.steps[0].params.prompt, /empty hands.*plain light grey background/);
  assert.match(none.steps[0].params.prompt, /A-pose/);
  assert.equal(none.steps[1].tool, 'image.edit');
  assert.deepEqual(none.steps[1].inputs, { images: ['$front'] });
  assert.match(none.steps[1].params.prompt, /three-quarter view.*four head-and-shoulders close-ups with different expressions/);
  const has = idn.lookPlan(maya());
  assert.deepEqual(has.steps.map((s) => s.role), ['sheet']);
  assert.equal(has.front, FRONT);
});

test('the fixed description is 50 to 80 words, read from JSON or plain text', () => {
  assert.equal(idn.wordCount(FIXED), 63);
  const long = Array.from({ length: 30 }, (_, i) => `Sentence ${i} has four.`).join(' ');
  const fit = idn.fitDescription(long);
  assert.ok(idn.wordCount(fit) <= 80 && fit.endsWith('.'));
  assert.equal(idn.parseDescription(JSON.stringify({ description: FIXED })), FIXED);
  assert.equal(idn.parseDescription(`"${FIXED}"`), FIXED);
  const req = idn.describeRequest(maya(), ['/f.png', '/s.png']);
  assert.match(req.system, /50 to 80 words/);
  assert.match(req.prompt, /front view, then their character sheet/);
});

test('LoRA eligibility: locked, and cast in 3 shots or 8 approved pictures; training and ready are states, not offers', () => {
  assert.equal(idn.loraOffer(maya({ lock: { sheet: SHEET, description: FIXED, at: null } }), 5).eligible, false, 'a draft is not locked');
  assert.equal(idn.loraOffer(maya(), 2).eligible, false);
  assert.equal(idn.loraOffer(maya(), 3).eligible, true);
  const eight = maya({ pictures: Array.from({ length: 8 }, (_, i) => ({ role: i ? 'reference' : 'sheet', asset: `a_${String(i).repeat(10)}` })) });
  assert.equal(idn.loraOffer(eight, 0).eligible, true);
  // Cut-outs repeat the front: they don't count.
  const cutouts = maya({ pictures: Array.from({ length: 8 }, (_, i) => ({ role: 'cutout', asset: `a_${String(i).repeat(10)}` })) });
  assert.equal(idn.loraOffer(cutouts, 0).eligible, false);
  assert.equal(idn.loraOffer(maya({ lora: { pending: 'j_0123456789', trigger: 't' } }), 9).why, 'Learning their look');
  assert.equal(idn.loraOffer(maya({ lora: { asset: 'a_1a1a1a1a1a', trigger: 't', state: 'ready' } }), 9).why, 'Locked in');
});

test('the LoRA plan: their pictures topped up to six with new angles, then lora.train with captions', () => {
  const plan = idn.loraPlan(maya());
  assert.equal(plan.tool, 'asset.make');
  assert.deepEqual(plan.inputs.files, [`asset:${FRONT}`, `asset:${PORTRAIT}`, `asset:${SHEET}`]);
  const steps = plan.params.steps;
  assert.equal(steps.length, 4);
  assert.ok(steps.slice(0, 3).every((s: any) => s.tool === 'image.edit' && s.params.angles > 0 && s.inputs.images[0] === '$input:0'));
  const train = steps[3];
  assert.equal(train.tool, 'lora.train');
  assert.deepEqual(train.inputs.images, ['$input:0', '$input:1', '$input:2', '$step1', '$step2', '$step3']);
  assert.equal(train.params.caption, FIXED);
  assert.equal(train.params.autoCaption, true);
  assert.equal(plan.trigger, 'hwk_maya');
  assert.equal(plan.images, 6);
});

test('a finished training job fills in the LoRA from the lora.train step (mock jobs)', () => {
  const doc = maya({ lora: { pending: 'j_aaaaaaaaaa', trigger: 'hwk_maya' } });
  const jobs: Record<string, any> = {
    j_aaaaaaaaaa: { status: 'done', tool: 'asset.make', outputs: [{ kind: 'file', asset: 'a_c0c0c0c0c0c0' }], result: { chain: [{ step: 1, tool: 'lora.train', job: 'j_bbbbbbbbbb' }] } },
    j_bbbbbbbbbb: { status: 'done', tool: 'lora.train', outputs: [{ kind: 'file', asset: 'a_7a7a7a7a7a7a' }], result: { trigger: 'hwk_maya' } },
  };
  assert.equal(kinds.resolveLora(doc, ((id: string) => jobs[id]) as any), true);
  assert.deepEqual(doc.lora, { asset: 'a_7a7a7a7a7a7a', trigger: 'hwk_maya', state: 'ready' }, 'the file image.character can read');
  const failed = maya({ lora: { pending: 'j_cccccccccc', trigger: 'hwk_maya' } });
  kinds.resolveLora(failed, (() => ({ status: 'failed', error: 'GPU ran away\nstack' })) as any);
  assert.deepEqual(failed.lora, { trigger: 'hwk_maya', state: 'failed', failed: 'GPU ran away' });
});

test('a chain picture takes its own saved output (from)', () => {
  const els = [{ role: 'front', pending: 'j_dddddddddd', from: 'front' }, { role: 'sheet', pending: 'j_dddddddddd', from: 'sheet' }];
  const job = { status: 'done', outputs: [{ kind: 'image', title: 'front', asset: 'a_1111111111' }, { kind: 'image', title: 'sheet', asset: 'a_2222222222' }] };
  kinds.resolveElements(els, ['image'], (() => job) as any);
  assert.deepEqual(els.map((e: any) => e.asset), ['a_1111111111', 'a_2222222222']);
});

// ------------------------------------------------------------------ shots
const shotWith = (over: Record<string, unknown> = {}) => dr.normalizeShot({
  title: 'Rooftop', look: 'Night rooftop, neon rain, live-action film still', action: 'Maya turns and walks to the edge.',
  cast: [{ name: 'Maya', description: FIXED, character: 'sn_aaaaaaaa', asset: MODEL, position: [0, 0], facing: 30 }, { name: 'Guard', description: 'a bulky guard', position: [2, 1] }],
  lines: [{ who: 0, text: 'Not tonight.', at: 1 }], camera: { angle: 30 }, ...over,
});
type CastPack = import('../src/identity-film.ts').CastPack;
const packOf = (over: Partial<CastPack> = {}): CastPack => ({ ...idn.identityPack(maya()), cast: 0, name: 'Maya', ...over });

test('the prompts carry the fixed description unchanged: the look, the video and the talk', () => {
  const s = shotWith({ look: 'x'.repeat(2000) });
  const p = dr.filmPrompts(s, [packOf()]);
  for (const k of ['look', 'action', 'talk'] as const) assert.ok(p[k].includes(`Maya: ${FIXED}`) || p[k].includes(`Maya, ${FIXED},`), `${k} carries it whole`);
  assert.match(p.look, /Keep the layout/, 'a long look gives way, not the description or the layout');
  // No packs: the prompts are as they were.
  const plain = dr.filmPrompts(shotWith({ cast: [{ name: 'Guard', description: 'a bulky guard' }] }));
  assert.ok(!plain.action.includes('Characters:'));
});

test('references reach the first frame: painted, then put back on-model with the sheet and the camera render', () => {
  const s = shotWith();
  const plan = dr.firstFrameFor(s, [packOf()], { screen: { 0: 'left' } });
  assert.equal(plan.tool, 'asset.make');
  assert.deepEqual(plan.inputs.files, ['$stage', '$camera', `asset:${SHEET}`]);
  const [paint, onModel] = plan.params.steps;
  assert.equal(paint.tool, 'image.control');
  assert.equal(paint.inputs.image, '$input:0');
  assert.ok(paint.params.prompt.includes(FIXED), 'the paint prompt carries the fixed description');
  assert.equal(onModel.tool, 'image.edit');
  assert.deepEqual(onModel.inputs.images, ['$step1', '$input:2', '$input:1'], 'the frame, the sheet, the camera render');
  assert.ok(onModel.params.prompt.includes(FIXED));
  assert.match(onModel.params.prompt, /on the left of the frame/);
  assert.match(onModel.params.prompt, /Image 3 is them in this exact pose and angle/);
  assert.deepEqual([onModel.params.width, onModel.params.height], [1280, 704]);
  assert.equal(onModel.save, 'keyframe');
  assert.deepEqual(plan.checks, [{ cast: 0, name: 'Maya', refs: [SHEET, FRONT, PORTRAIT] }]);
  // The app fills the uploaded files in.
  const filled = film.fillPlan(plan, { stage: 'a_57a957a957a9', camera: 'a_cacacacacaca' });
  assert.deepEqual(filled.inputs.files.slice(0, 2), ['asset:a_57a957a957a9', 'asset:a_cacacacacaca']);
  // No camera render: a second picture of them instead.
  const noCam = dr.firstFrameFor(s, [packOf()], { camera: false });
  assert.deepEqual(noCam.params.steps[1].inputs.images, ['$step1', '$input:1', '$input:2']);
  assert.deepEqual(noCam.inputs.files, ['$stage', `asset:${SHEET}`, `asset:${FRONT}`]);
  // No one known: the paint job alone, as before.
  const none = dr.firstFrameFor(s, []);
  assert.deepEqual(none, { tool: 'image.control', params: { prompt: dr.filmPrompts(s).look }, inputs: { image: '$stage' }, checks: [] });
});

test('several characters each get a pass (locked first, at most three); the retry is firmer and best of two', () => {
  const b = packOf({ cast: 1, name: 'Guard', sheet: 'a_b0b0b0b0b0b0', refs: ['a_b0b0b0b0b0b0'], locked: false, description: 'a bulky guard' });
  const plan = film.firstFramePlan([b, packOf()], { look: 'L', keyframe: 'image.edit', width: 960, height: 960, camera: true });
  const steps = plan.params.steps;
  assert.equal(steps[0].tool, 'image.edit');
  assert.deepEqual(steps[0].inputs.images, ['$input:0']);
  assert.match(steps[1].params.prompt, /Repaint only Maya/, 'the locked one first');
  assert.match(steps[2].params.prompt, /Repaint only Guard/);
  assert.deepEqual(steps[2].inputs.images[0], '$step2', 'each pass starts from the one before');
  const strong = film.firstFramePlan([packOf()], { look: 'L', keyframe: 'image.control', width: 1280, height: 704, camera: true, strong: true });
  assert.equal(strong.params.candidates, 2);
  assert.equal(strong.params.pickAt, 2);
  assert.deepEqual(strong.params.steps[1].inputs.images, ['$step1', '$input:2', '$input:3'], 'two pictures of them, not the render');
  assert.deepEqual(strong.params.refs, [2, 3]);
  assert.match(strong.params.steps[1].params.prompt, /unmistakably/);
});

test('a character with a LoRA is drawn with image.character at the shot\'s angle when it can run', () => {
  const p = packOf({ lora: { asset: 'a_10ra10ra10ra'.replace(/r/g, 'e'), trigger: 'hwk_maya' } });
  const s = shotWith();
  const plan = dr.firstFrameFor(s, [p], { loraReady: true });
  const [, draw, onModel] = plan.params.steps;
  assert.equal(draw.tool, 'image.character');
  assert.equal(draw.params.lora, p.lora!.asset);
  assert.match(draw.params.prompt, /front view/, 'camera at 30° on someone facing 30°: they face it');
  assert.deepEqual(onModel.inputs.images, ['$step1', '$step2', '$input:2']);
  assert.equal(dr.firstFrameFor(s, [p], { loraReady: false }).params.steps[1].tool, 'image.edit', 'offline: no LoRA pass');
  assert.equal(film.viewOf(90, 0), 'side view');
  assert.equal(film.viewOf(180, 0), 'back view');
  assert.equal(film.viewOf(-45, 0), 'three-quarter view');
});

test('the identity check: a failed face is reported with the worst distance (mock assess)', async () => {
  const a = putAsset({ data: Buffer.from('png'), ext: '.png', client: 'test', project: 'u_1d1d1d1d1d1d', tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any });
  const seen: any[] = [];
  const fake = async (x: any) => { seen.push(x); return { pass: false, identity: { distance: 0.31, perFrame: [0.31], spread: 0, faces: 1 } } as any; };
  const r = await routes.identityCheck('/frame.png', [{ cast: 0, name: 'Maya', refs: [a.id] }, { cast: 1, name: 'Nobody', refs: ['a_0000000000'] }], 'Night rooftop', fake);
  assert.equal(r.pass, false);
  assert.equal(r.distance, 0.31);
  assert.equal(r.checked, 1, 'refs that are not files are skipped');
  assert.deepEqual(seen[0].identityRefs, [a.path]);
  assert.equal(seen[0].kind, 'image');
  // The placeholder checks (until the bench lands) pass.
  const real = await routes.identityCheck(a.path, [{ cast: 0, name: 'Maya', refs: [a.id] }], 'x');
  assert.equal(real.pass, true);
});

test('places and props get packs: a panorama and three key views; a prop alone, then its 4-view sheet', () => {
  const place = idn.placePackPlan('A frozen moon harbour with ice cranes', { style: 'painted concept art' });
  assert.deepEqual(place.steps.map((s: any) => s.save), ['panorama', 'view-wide', 'view-eye', 'view-reverse']);
  assert.equal(place.steps[0].tool, 'image.panorama');
  assert.ok(place.steps.slice(1).every((s: any) => s.tool === 'image.edit' && s.inputs.images[0] === '$step1'));
  const prop = idn.propPackPlan('A brass compass with a cracked lid');
  assert.deepEqual(prop.steps.map((s: any) => s.tool), ['image.generate', 'image.remove-background', 'image.viewsheet']);
  const ps = prop.steps as any[];
  assert.match(ps[0].params.prompt, /nothing else in frame/);
  assert.equal(ps[2].params.form, 'prop');
  assert.equal(ps[2].inputs.image, '$prev:cutout');
});

// ------------------------------------------------------------------ in the store and over HTTP
test('a stage with a locked character: packs read from the store, the fixed description cast, Blender gets the sheet', () => {
  const project = 'u_5a5a5a5a5a5a';
  const ch = sc.createScene(project, 'character', maya(), 'sn');
  const shot = dr.createShot(project, { title: 'Roof', cast: [{ character: ch.id, name: 'x', position: [0, 0] }] });
  assert.equal(shot.doc.cast[0].description, FIXED, 'the cast member is described by the fixed words');
  assert.equal(shot.doc.cast[0].asset, MODEL);
  const packs = dr.shotPacks(shot.doc, project);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].sheet, SHEET);
  assert.equal(packs[0].name, 'Maya');
  const { recipe, files } = dr.blenderRecipe(shot.doc, packs);
  assert.deepEqual(files, [`asset:${MODEL}`, `asset:${SHEET}`]);
  assert.deepEqual(recipe.refs, [1]);
  assert.match(String(recipe.canon), /^Maya: A woman in her early thirties/);
  const edit = recipe.steps.find((x: any) => x.tool === 'image.edit')!;
  assert.deepEqual((edit.inputs as any).images.slice(1), ['$input:1']);
  assert.ok(String((edit.params as any).prompt).includes(FIXED));
  assert.equal(routes.shotsWith(ch.id, project), 1);
});

test('routes: the pack, lock and unlock, the LoRA priced then trained, the prompts with the first frame (mock run)', async () => {
  const { handle } = await import('../src/api.ts');
  const { signupUser } = await import('../src/users.ts');
  const jobs = await import('../src/jobs.ts');
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const a = signupUser({ email: 'id-a@example.com', password: 'secret-123', name: 'A' });
    const b = signupUser({ email: 'id-b@example.com', password: 'secret-123', name: 'B' });
    const as = (who: typeof a) => async (route: string, method = 'GET', body?: unknown) => {
      const r = await fetch(base + route, { method, headers: { cookie: `hg_session=${who.sessionToken}`, Origin: 'https://hawkesgen.ai', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const A = as(a), B = as(b);
    const made = (await A('/v1/scenes', 'POST', { kind: 'character', title: 'Maya' })).body;
    // Her pictures are real files in her account (training is submitted with them).
    const file = (tag: string) => putAsset({ data: Buffer.from(tag), ext: '.png', client: 'test', project: made.project, tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any }).id;
    const [front, portrait, sheet] = [file('front'), file('portrait'), file('sheet')];
    const draft = { ...maya({ pictures: [{ role: 'front', asset: front }, { role: 'portrait', asset: portrait }, { role: 'sheet', asset: sheet }], lock: { sheet, description: FIXED, at: null } }), title: 'Maya' };
    await A(`/v1/scenes/${made.id}`, 'PUT', { doc: draft });
    const info = await A(`/v1/scenes/${made.id}/identity`);
    assert.equal(info.status, 200);
    assert.equal(info.body.pack.locked, false);
    assert.deepEqual(info.body.plan.steps.map((s: any) => s.role), ['sheet']);
    assert.equal((await B(`/v1/scenes/${made.id}/identity`)).status, 404, 'another account never sees it');
    assert.equal((await A(`/v1/scenes/${made.id}/identity/lora?quote=1`, 'POST', {})).status, 400, 'not before it is locked');
    const locked = await A(`/v1/scenes/${made.id}/identity/lock`, 'POST', {});
    assert.equal(locked.status, 200);
    assert.ok(locked.body.scene.doc.lock.at > 0);
    assert.equal(locked.body.pack.locked, true);
    assert.equal((await A(`/v1/scenes/${made.id}/identity/unlock`, 'POST', {})).body.pack.locked, false);
    await A(`/v1/scenes/${made.id}/identity/lock`, 'POST', {});
    // Three shots cast her: the LoRA is offered.
    const shots: any[] = [];
    for (let i = 0; i < 3; i++) shots.push((await A('/v1/scenes', 'POST', { kind: 'stage', doc: { title: `Shot ${i}`, look: 'Rain', cast: [{ character: made.id, name: 'Maya', position: [0, 0] }, { name: 'Guard', position: [2, 0] }] } })).body);
    assert.equal((await A(`/v1/scenes/${made.id}/identity`)).body.lora.eligible, true);
    const q = await A(`/v1/scenes/${made.id}/identity/lora?quote=1`, 'POST', {});
    assert.equal(q.status, 200);
    assert.equal(q.body.images, 6);
    assert.equal(q.body.trigger, 'hwk_maya');
    // Training is mocked: the job is queued here, never run (no GPU server exists in tests). It costs credits.
    (await import('../src/accounts.ts')).giftCredits(a.user.id, 100000, 'test');
    const t = await A(`/v1/scenes/${made.id}/identity/lora`, 'POST', {});
    assert.equal(t.status, 200);
    assert.equal(t.body.scene.doc.lora.state, 'training');
    const job = jobs.getJob(t.body.job)!;
    assert.equal(job.tool, 'asset.make');
    assert.equal((job.params as any).steps.at(-1).tool, 'lora.train');
    jobs.cancel(job.id);

    // Film it (mock run): the prompts and the first-frame job carry her pack.
    const p = await A('/v1/director/prompts', 'POST', { doc: shots[0].doc, shot: shots[0].id, camera: true, screen: { 0: 'center' } });
    assert.equal(p.status, 200);
    assert.ok(p.body.look.includes(FIXED) && p.body.action.includes(FIXED) && p.body.talk.includes(FIXED));
    assert.deepEqual(p.body.packs, [{ cast: 0, name: 'Maya', locked: true, refs: 3, lora: false, described: true }]);
    const ff = p.body.firstFrame;
    assert.equal(ff.tool, 'asset.make');
    assert.ok(ff.inputs.files.includes(`asset:${sheet}`) && ff.inputs.files.includes('$camera'));
    assert.match(ff.params.steps[1].params.prompt, /in the center of the frame/);
    // Another account can't read her pack through a shot it can't see.
    assert.equal((await B('/v1/director/prompts', 'POST', { doc: shots[0].doc, shot: shots[0].id })).status, 404);
    // The check runs on a file the caller can see.
    const frame = putAsset({ data: Buffer.from('png'), ext: '.png', client: 'test', project: shots[0].project, tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} } as any });
    const chk = await A('/v1/director/identity-check', 'POST', { asset: frame.id, shot: shots[0].id });
    assert.equal(chk.status, 200);
    assert.equal(chk.body.pass, true);
    assert.equal((await B('/v1/director/identity-check', 'POST', { asset: frame.id })).status, 404);
  } finally {
    server.close();
  }
});
