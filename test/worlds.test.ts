// Worlds (src/worldkinds.ts, src/worlds.ts, src/worldai.ts, src/worldroutes.ts): the world, place, prop and story kinds
// kept in range, worldContext from a world and its members, the world's look inherited by a job made inside it,
// continuity at a shot, the canon check (Claude mocked), the AIs' answers applied (mocked), starting a world from a
// sentence, "Make this shot", and the routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-worlds-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

const sc = await import('../src/scenes.ts');
await import('../src/editor.ts');
const dr = await import('../src/director.ts');
const wk = await import('../src/worldkinds.ts');
const W = await import('../src/worlds.ts');
const wai = await import('../src/worldai.ts');
const { getTool } = await import('../src/tools/index.ts');

const P = 'u_0000cccc0000';
const A1 = 'a_1111aaaa1111', A2 = 'a_2222bbbb2222', A3 = 'a_3333cccc3333';

test('each world kind is kept in range', () => {
  const w = wk.normalizeWorld({ title: 'Frostmoon', rules: ['The moon is always red', '', 7], look: { style: 'grainy 16mm', palette: ['#AA0000', 'red'], board: [A1], grade: { params: { contrast: 3, nope: 1 } } }, members: ['sn_aaaaaaaaaaaa', 'bad', 'sn_aaaaaaaaaaaa'] });
  assert.deepEqual(w.rules, ['The moon is always red']);
  assert.deepEqual(w.look.palette, ['#aa0000']);
  assert.deepEqual(w.look.board, [A1], 'a board asset becomes an element and comes back in look.board');
  assert.equal(w.board.length, 1);
  assert.deepEqual(w.look.grade, { params: { contrast: 1 } });
  assert.deepEqual(w.members, ['sn_aaaaaaaaaaaa']);
  const pl = wk.normalizePlace({ name: 'Dock', panorama: { asset: A1 }, views: [{ name: 'wide', asset: A2 }, {}], variants: [{ kind: 'weather', name: 'snow', gen: 1 }, { kind: 'x', asset: A3 }], ambience: { pending: 'j_12345678' } });
  assert.equal(pl.title, 'Dock');
  assert.equal(pl.views.length, 1);
  assert.equal(pl.variants.length, 1, 'a variant needs a name');
  assert.equal(pl.variants[0].kind, 'weather');
  assert.equal(pl.ambience!.pending, 'j_12345678');
  const pr = wk.normalizeProp({ title: 'Lantern', sheet: A2, owner: 'sn_bbbbbbbbbbbb', model: { failed: 'no' } });
  assert.equal(pr.sheet!.asset, A2);
  assert.equal(pr.owner, 'sn_bbbbbbbbbbbb');
  const st = wk.normalizeStory({ level: 'episode', number: 2, parent: 'sn_cccccccccccc', beats: ['Arrive', { text: 'Fight' }, ''], script: [{ id: 'sc_one1', heading: 'EXT. DOCK - NIGHT', lines: [{ who: 'sn_dddddddddddd', text: 'Hi' }, { text: '' }] }], shots: [{ id: 'st_one1', scene: 'sc_one1' }, { scene: 'sc_none' }], continuity: [{ at: 'st_one1', key: 'time', value: 'dusk' }, { at: 'st_gone', key: 'time', value: 'noon' }, { at: 'st_one1', key: 'nope' }] });
  assert.equal(st.level, 'episode');
  assert.equal(st.number, 2);
  assert.equal(st.beats.length, 2);
  assert.equal(st.script[0].lines.length, 1);
  assert.equal(st.shots[1].scene, null);
  assert.equal(st.continuity.length, 1, 'events must be at a shot, with a known key');
  assert.equal(st.shots[0].state!.time, 'dusk', 'every shot carries its state');
  assert.equal(wk.normalizeStory({ level: 'series', parent: 'sn_cccccccccccc' }).parent, null, 'a series has no parent');
});

test('any scene keeps the world it names', () => {
  const w = sc.createScene(P, 'world', { title: 'Keep' });
  const ch = sc.createScene(P, 'character', { title: 'Ana', world: w.id });
  assert.equal(ch.doc.world, w.id);
  const shot = dr.createShot(P, { title: 'S', world: w.id });
  assert.equal((shot.doc as any).world, w.id);
  const saved = sc.saveScene(ch, { ...ch.doc, world: 'not an id' });
  assert.equal(saved.doc.world, undefined);
});

test('continuity: the state of things at each shot', () => {
  const ana = 'sn_aaaa00000001', bo = 'sn_bbbb00000002', lamp = 'sn_cccc00000003';
  const st = wk.normalizeStory({
    script: [{ id: 'sc_aaa', time: 'night' }],
    shots: [{ id: 'st_111', scene: 'sc_aaa' }, { id: 'st_222' }, { id: 'st_333' }, { id: 'st_444' }],
    continuity: [
      { at: 'st_111', who: ana, key: 'wears', value: 'red parka' }, { at: 'st_111', who: ana, key: 'holds', value: lamp },
      { at: 'st_222', who: ana, key: 'injury', value: 'cut on the left cheek' }, { at: 'st_222', who: bo, key: 'holds', value: lamp },
      { at: 'st_333', who: ana, key: 'wears', value: 'borrowed coat' }, { at: 'st_333', key: 'time', value: 'dawn' }, { at: 'st_333', who: bo, key: 'at', value: 'the dock' },
      { at: 'st_444', who: ana, key: 'heal', value: 'cut on the left cheek' }, { at: 'st_444', who: bo, key: 'drops', value: lamp },
    ],
  });
  const s1 = W.continuityAt(st, 0);
  assert.equal(s1.time, 'night', 'from the script scene when no event set it');
  assert.deepEqual(s1.people[ana], { wears: 'red parka', injuries: [], holds: [lamp], at: null });
  const s2 = W.continuityAt(st, 1);
  assert.deepEqual(s2.people[ana].holds, [], 'a prop is in one hand at a time');
  assert.equal(s2.props[lamp], bo);
  assert.deepEqual(s2.people[ana].injuries, ['cut on the left cheek']);
  const s3 = W.continuityAt(st, 2);
  assert.equal(s3.time, 'dawn');
  assert.equal(s3.people[ana].wears, 'borrowed coat');
  assert.equal(s3.people[bo].at, 'the dock');
  const s4 = st.shots[3].state!;
  assert.deepEqual(s4.people[ana].injuries, []);
  assert.equal(s4.props[lamp], null);
});

test('worldContext: the look, the canon, and each member\'s words and references', () => {
  const w = sc.createScene(P, 'world', { title: 'Frostmoon', rules: ['The moon is always red'], look: { style: 'grainy 16mm film, cold blue light', negative: 'neon', board: [A1] } });
  const ana = sc.createScene(P, 'character', { title: 'Ana', description: 'red parka, short black hair', pictures: [{ role: 'front', asset: A2 }, { role: 'sheet', asset: A3 }] });
  const dock = sc.createScene(P, 'place', { title: 'Dock', description: 'iced pier', world: w.id, panorama: { asset: A1 }, views: [{ name: 'wide', asset: A2 }] });
  const lamp = sc.createScene(P, 'prop', { title: 'Lantern', description: 'brass', world: w.id, sheet: { asset: A3 } });
  sc.createScene('u_0000dddd0000', 'place', { title: 'Elsewhere', world: w.id });
  sc.saveScene(w, { ...w.doc, members: [ana.id] });
  const ctx = W.worldContext(P, w.id)!;
  assert.equal(ctx.title, 'Frostmoon');
  assert.deepEqual(ctx.canon, ['The moon is always red']);
  assert.equal(ctx.look.style, 'grainy 16mm film, cold blue light');
  assert.deepEqual(ctx.look.board, [A1]);
  assert.deepEqual(ctx.characters, [{ id: ana.id, title: 'Ana', description: 'red parka, short black hair', refs: [A3, A2] }], 'a listed member, refs from its identity pack (the sheet first)');
  assert.deepEqual(ctx.places, [{ id: dock.id, title: 'Dock', description: 'iced pier', refs: [A1, A2] }], 'a scene naming the world joins it; another project\'s never does');
  assert.deepEqual(ctx.props.map((p) => p.refs), [[A3]]);
  assert.equal(W.worldContext('u_0000dddd0000', w.id), null, 'another project\'s world is nobody\'s');
  assert.equal(W.worldContext(P, null), null);
});

test('inheritance: a job made inside a world carries the world\'s look, unless it was turned off', () => {
  const w = sc.createScene(P, 'world', { title: 'Look', look: { style: 'grainy 16mm film', negative: 'neon signs', board: [A1, A2, A3] } });
  const stage = dr.createShot(P, { title: 'In the world', world: w.id });
  const gen = getTool('image.generate')!;
  assert.ok('prompt' in gen.params);
  const spec: any = { project: P, tool: 'image.generate', params: { prompt: 'A pier at night.' }, labels: { director: stage.id } };
  W.inheritWorld(P, spec);
  assert.equal(spec.params.prompt, 'A pier at night. grainy 16mm film');
  assert.equal(spec.labels.world, w.id);
  if ('negative' in gen.params) assert.match(spec.params.negative, /neon signs/);
  // The person turned it off under Fine-tune.
  const off: any = { project: P, tool: 'image.generate', params: { prompt: 'A pier.' }, labels: { director: stage.id, world: 'off' } };
  W.inheritWorld(P, off);
  assert.equal(off.params.prompt, 'A pier.');
  // Sound is left alone; a scene in no world changes nothing; another project's scene never lends its world.
  const voice: any = { project: P, tool: 'audio.voice', params: { text: 'Hello' }, labels: { scene: stage.id } };
  W.inheritWorld(P, voice);
  assert.equal(voice.params.text, 'Hello');
  assert.equal(voice.labels.world, undefined);
  const loose = dr.createShot(P, { title: 'Nowhere' });
  const plain: any = { project: P, tool: 'image.generate', params: { prompt: 'x' }, labels: { scene: loose.id } };
  W.inheritWorld(P, plain);
  assert.equal(plain.params.prompt, 'x');
  const theirs: any = { project: 'u_0000eeee0000', tool: 'image.generate', params: { prompt: 'x' }, labels: { scene: stage.id } };
  W.inheritWorld('u_0000eeee0000', theirs);
  assert.equal(theirs.params.prompt, 'x');
  // The board goes in as references where the tool takes them (and only as many as it takes).
  const withRefs = [...['image.generate', 'image.control', 'image.edit']].map((id) => getTool(id)).find((t) => t?.inputs.references?.multiple);
  if (withRefs) {
    const r = W.withWorld(P, stage.doc, withRefs.id, { prompt: 'x' }, {});
    assert.deepEqual(r.inputs.references, [A1, A2, A3].slice(0, withRefs.inputs.references.max ?? 2).map((a) => `asset:${a}`));
  }
  // The style line isn't doubled when the prompt has it.
  assert.equal(W.withWorld(P, stage.doc, 'image.generate', { prompt: 'A pier, grainy 16mm film' }).params.prompt, 'A pier, grainy 16mm film');
});

test('canon check: the rules a script breaks (Claude mocked)', async () => {
  const world = { rules: ['The moon is always red', 'No one says the founder\'s name'] };
  let asked: any = null;
  const r = await W.canonCheck(world, 'The pale white moon rose.', { ask: async (p) => { asked = p; return { text: '```json\n{"breaks":[{"rule":"The moon is always red","quote":"pale white moon","why":"The moon is red here.","fix":"the red moon"},{"rule":"Made up","quote":"x","why":"x","fix":"x"}]}\n```' }; } });
  assert.match(asked.prompt, /The moon is always red/);
  assert.equal(r.ok, false);
  assert.deepEqual(r.breaks, [{ rule: 'The moon is always red', quote: 'pale white moon', why: 'The moon is red here.', fix: 'the red moon' }], 'only the world\'s own rules');
  assert.deepEqual(await W.canonCheck({ rules: [] }, 'anything', { ask: async () => { throw new Error('not called'); } }), { ok: true, breaks: [], cost: 0 });
  assert.equal((await W.canonCheck(world, 'Fine.', { ask: async () => ({ text: '{"breaks":[]}' }) })).ok, true);
});

const deps = (auto = 40, confirm = false) => {
  const submitted: any[] = [];
  return { submitted, submit: (spec: any) => { submitted.push(spec); return { id: `j_${String(submitted.length).padStart(8, '0')}` }; }, quote: () => 10, autoCredits: auto, confirm };
};

test('the world AI: the bible and look applied, its board made, its first members made in the world (mocked)', async () => {
  const w = sc.createScene(P, 'world', { title: 'New' });
  wai.useAsk(async (p) => {
    assert.match(p.system, /world scene/);
    return { text: JSON.stringify({ say: 'Built it.', doc: { ...w.doc, logline: 'Smugglers on a frozen moon', rules: ['The moon is always red'], look: { style: 'grainy 16mm film', palette: ['#102030'] }, board: [{ gen: 0 }] }, jobs: [{ gen: 0, tool: 'image.generate', params: { prompt: 'an ice field' } }], create: [{ kind: 'character', doc: { title: 'Ana' } }, { kind: 'place', doc: { title: 'Dock' } }, { kind: 'spreadsheet', doc: {} }] }), model: 'mock', cost: 0.01, billing: 'house' };
  });
  try {
    const turn = await wai.worldTurn({ scene: w, messages: [{ role: 'user', text: 'smugglers on a frozen moon' }], library: [], scenes: [], voices: [] });
    assert.equal(turn.answer.create.length, 2, 'only kinds a world holds');
    const d = deps();
    const r = wai.applyWorldAnswer(w, turn.answer, d);
    assert.equal(r.started.length, 1);
    assert.equal(r.doc.board[0].pending, 'j_00000001', 'the board picture waits on its job');
    assert.equal(r.created.length, 2);
    assert.ok(r.created.every((c) => c.doc.world === w.id), 'new members name the world');
    assert.deepEqual(r.doc.members, r.created.map((c) => c.id));
    // Over the auto limit: nothing made, the proposal keeps what it would create.
    const big = wai.applyWorldAnswer(w, turn.answer, deps(5));
    assert.equal(big.created.length, 0);
    assert.equal(big.proposed!.create.length, 2);
  } finally { wai.useAsk(null); }
});

test('the story AI writes top down with continuity; the place and prop packs are planned', async () => {
  const w = sc.createScene(P, 'world', { title: 'Story world', rules: ['No guns'] });
  const ana = sc.createScene(P, 'character', { title: 'Ana', description: 'red parka', world: w.id });
  const story = sc.createScene(P, 'story', { title: 'Pilot', world: w.id, logline: 'They steal the moon.' });
  wai.useAsk(async (p) => {
    assert.match(p.prompt, /No guns/, 'the story AI sees the world\'s rules');
    assert.ok(p.prompt.includes(ana.id), 'and its characters by id');
    assert.equal(p.effort, 'high');
    return { text: JSON.stringify({ say: 'Beats and script.', doc: { ...story.doc, beats: [{ text: 'Ana arrives' }], script: [{ id: 'sc_xxx', heading: 'EXT. DOCK', time: 'night', lines: [{ who: ana.id, text: 'Cold.' }] }], shots: [{ id: 'st_xxx', scene: 'sc_xxx', title: 'Arrival', cast: [ana.id] }], continuity: [{ at: 'st_xxx', who: ana.id, key: 'wears', value: 'red parka' }] }, jobs: [] }) };
  });
  try {
    const turn = await wai.worldTurn({ scene: story, messages: [{ role: 'user', text: 'write it' }], library: [], scenes: [], voices: [] });
    const r = wai.applyWorldAnswer(story, turn.answer, deps());
    assert.equal(r.doc.logline, 'They steal the moon.', 'the layer above is kept');
    assert.equal(r.doc.shots[0].state.people[ana.id].wears, 'red parka');
    assert.equal(r.doc.shots[0].state.time, 'night');
  } finally { wai.useAsk(null); }
  const place = wai.placePackPlan({ title: 'Dock', description: 'iced pier' });
  assert.deepEqual(place.jobs.map((j) => j.tool), ['image.panorama', 'image.generate', 'audio.sfx']);
  assert.equal(place.doc.panorama.gen, 0);
  assert.equal(wai.placePackPlan({ ...place.doc, panorama: { asset: A1 }, views: [{ name: 'wide', asset: A2 }], ambience: { asset: A3 } }).jobs.length, 0, 'nothing remade');
  assert.deepEqual(wai.propPackPlan({ title: 'Lamp' }).jobs.map((j) => j.tool), ['image.generate']);
});

test('start a world from a sentence: a proposal, then the kept parts as scenes in it (mocked)', async () => {
  wai.useAsk(async (p) => {
    assert.match(p.prompt, /frozen moon/);
    return { text: JSON.stringify({ say: 'Here is a world.', world: { title: 'Frostmoon', logline: 'Smugglers on a frozen moon', rules: ['The moon is always red'], look: { style: 'grainy 16mm film, cold light', negative: 'neon', palette: ['#0a1a2a', '#aa2222'] } }, characters: [{ title: 'Ana', description: 'red parka' }, { title: 'Bo', description: 'tall' }, { title: 'Cy', description: 'old' }], places: [{ title: 'Dock', description: 'iced pier' }, { title: 'Bar', description: 'smoky' }], props: [{ title: 'Lantern', description: 'brass' }], story: { title: 'Pilot', logline: 'They steal the moon', beats: [{ text: 'Arrive' }] } }) };
  });
  try {
    const { proposal } = await wai.startWorld(P, 'smugglers on a frozen moon');
    assert.equal(proposal.world.title, 'Frostmoon');
    assert.equal(proposal.characters.length, 3);
    assert.equal(proposal.places.length, 2);
    assert.equal(proposal.story!.level, 'story');
    const kept = wai.keepWorld(P, proposal, { characters: [0, 2], props: [] });
    assert.equal(kept.members.length, 2 + 2 + 0 + 1);
    assert.deepEqual(kept.members.filter((m) => m.kind === 'character').map((m) => m.title), ['Ana', 'Cy']);
    assert.ok(kept.members.every((m) => m.doc.world === kept.world.id));
    const ctx = W.worldContext(P, kept.world.id)!;
    assert.equal(ctx.characters.length, 2);
    assert.equal(ctx.look.style, 'grainy 16mm film, cold light');
    // The packs: priced first, then made with confirm, each element waiting on its job.
    const d = deps(0);
    const priced = wai.makeWorldPacks(P, kept.world.id, () => true, d);
    assert.equal(priced.proposed, true);
    assert.equal(d.submitted.length, 0);
    const ran = wai.makeWorldPacks(P, kept.world.id, () => true, { ...d, confirm: true });
    // world board 2 + characters 2 x 2 + places 2 x 3 = 12
    assert.equal(ran.started.length, 12);
    assert.ok(d.submitted.every((s) => s.scene), 'each job names its scene (so it inherits the world)');
    // (read as stored: the mocked jobs don't exist, so reading the scene would mark them gone)
    const { db } = await import('../src/db.ts');
    const dock = JSON.parse((db.prepare('SELECT doc FROM scenes WHERE id = ?').get(kept.members.find((m) => m.title === 'Dock')!.id) as any).doc);
    assert.match(dock.panorama.pending, /^j_/);
  } finally { wai.useAsk(null); }
});

test('"Make this shot": a stage from a story\'s shot, linked back, with its place, cast, lines and state', () => {
  const w = sc.createScene(P, 'world', { title: 'Shots' });
  const ana = sc.createScene(P, 'character', { title: 'Ana', world: w.id });
  const dock = sc.createScene(P, 'place', { title: 'Dock', description: 'iced pier', world: w.id, panorama: { asset: A1 } });
  const story = sc.createScene(P, 'story', { title: 'Pilot', world: w.id, script: [{ id: 'sc_aaa', time: 'night', lines: [{ who: ana.id, text: 'Cold out here.' }] }], shots: [{ id: 'st_aaa', scene: 'sc_aaa', title: 'Arrival', what: 'Ana steps off the boat', framing: 'close-up', place: dock.id, cast: [ana.id] }], continuity: [{ at: 'st_aaa', who: ana.id, key: 'wears', value: 'red parka' }] });
  const routes = import('../src/worldroutes.ts');
  return routes.then(({ shotToStage }) => {
    const r = shotToStage(story, 'st_aaa', () => true, dr.createShot);
    const st = sc.getScene(r.stage.id, () => true);
    assert.equal(st.kind, 'stage');
    assert.equal(st.doc.world, w.id);
    assert.equal(st.doc.cast[0].character, ana.id);
    assert.equal(st.doc.set.sky, A1);
    assert.equal(st.doc.lines[0].text, 'Cold out here.');
    assert.match(st.doc.look, /red parka/);
    assert.match(st.doc.look, /night/);
    assert.equal(r.story.doc.shots[0].stage, st.id, 'linked back');
    assert.equal(shotToStage(r.story, 'st_aaa', () => true, dr.createShot).stage.id, st.id, 'made once');
  });
});

test('routes: start and keep a world, its home, its context, the story shot; another account sees none of it', async () => {
  const { handle } = await import('../src/api.ts');
  const { signupUser } = await import('../src/users.ts');
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  wai.useAsk(async () => ({ text: JSON.stringify({ say: 'A world.', world: { title: 'Routeland', rules: ['Always raining'], look: { style: 'wet streets' } }, characters: [{ title: 'Ana', description: 'red coat' }], places: [{ title: 'Alley', description: 'wet alley' }], story: { title: 'Rain', logline: 'It rains' } }), model: 'mock', cost: 0, billing: 'byok' }));
  try {
    const a = signupUser({ email: 'w-a@example.com', password: 'secret-123', name: 'A' });
    const b = signupUser({ email: 'w-b@example.com', password: 'secret-123', name: 'B' });
    const as = (who: typeof a) => (route: string, method = 'GET', body?: unknown) => fetch(base + route, {
      method, headers: { cookie: `hg_session=${who.sessionToken}`, Origin: 'https://hawkesgen.ai', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const A = as(a), B = as(b);
    for (const kind of ['world', 'place', 'prop', 'story']) assert.equal((await A('/v1/scenes', 'POST', { kind })).status, 200, kind);
    const start = await A('/v1/worlds/start', 'POST', { idea: 'a city where it always rains' });
    assert.equal(start.status, 200);
    const { proposal } = await start.json();
    assert.equal(proposal.world.title, 'Routeland');
    const keptR = await A('/v1/worlds/keep', 'POST', { proposal });
    const kept = await keptR.json();
    assert.equal(keptR.status, 200, JSON.stringify(kept));
    assert.equal(kept.world.kind, 'world');
    assert.equal(kept.characters.length, 1);
    assert.equal(kept.places.length, 1);
    assert.equal(kept.stories.length, 1);
    const id = kept.world.id;
    assert.equal((await (await A(`/v1/worlds/${id}`)).json()).characters[0].title, 'Ana');
    assert.equal((await (await A(`/v1/worlds/${id}/context`)).json()).look.style, 'wet streets');
    assert.equal((await B(`/v1/worlds/${id}`)).status, 404);
    assert.equal((await B(`/v1/worlds/${id}/context`)).status, 404);
    // A story's shot to a stage, through the route.
    const storyId = kept.stories[0].id;
    const story = await (await A(`/v1/scenes/${storyId}`)).json();
    await A(`/v1/scenes/${storyId}`, 'PUT', { doc: { ...story.doc, shots: [{ id: 'st_route', title: 'One', cast: [kept.characters[0].id] }] } });
    const made = await (await A(`/v1/stories/${storyId}/shots/st_route/stage`, 'POST', {})).json();
    assert.equal(made.stage.kind, 'stage');
    assert.equal(made.story.doc.shots[0].stage, made.stage.id);
    assert.equal((await B(`/v1/stories/${storyId}/shots/st_route/stage`, 'POST', {})).status, 404);
    // The world kinds' AI turn goes through the world AI.
    const turn = await A(`/v1/scenes/${id}/assistant`, 'POST', { messages: [{ role: 'user', text: 'darker' }] });
    assert.equal(turn.status, 200);
  } finally {
    wai.useAsk(null);
    server.close();
  }
});
