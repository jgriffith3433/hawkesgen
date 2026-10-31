// The world's home (scenes.js; src/worldkinds.ts "world"): the look as a board, then its characters, places, props and
// stories as cards, each a tap from opening, a drag from a stage or a timeline, or "Use in a new shot". Every job made
// inside the world gets its look (src/worlds.ts); the knobs (the style line, the negative, the palette, the grade, the
// rules) wait under Fine-tune.
//
// "Start a world" (startWorld below): a sentence or a dropped mood board, then the world AI proposes the world as cards
// (the look, three characters, two places, a story idea) to keep, change or throw away; what's kept becomes the world.
// From "+" in the bar, the empty center, the palette, and once for a new account after the tour.

import { $, h, api, toast, fileUrl, bus, icon, plainError, keepingFocus } from './lib.js';
import { state, needSignIn, refreshCredits } from './account.js';
import { uploadFiles } from './media.js';
import { libraryPicker } from './studio.js';
import { registerEditor, newScene, openScene, refreshBar, sceneList, loadList, readDrag } from './scenes.js';
import { popMenu, closeMenus } from './timeline.js';
import { sceneDoc } from './scenedoc.js';
import { dragging } from './dragdrop.js';
import { fineTune, textField, memberCard, makePack } from './worldbits.js';

const D = sceneDoc({ onChange: () => { draw(); refreshBar(); } });
const Wd = { home: null, loading: false };

registerEditor({
  kind: 'world', label: 'World', icon: 'layers', panel: null,
  async mount(scene) {
    $('#wldWrap')?.remove();
    $('#viewer').append(h('div', { id: 'wldWrap', class: 'wld-wrap' }));
    Wd.home = null;
    D.take(scene);
    loadHome();
  },
  async unmount() { await D.save(); D.stop(); $('#wldWrap')?.remove(); },
  undo: () => D.undo(), redo: () => D.redo(), canUndo: () => D.canUndo(), canRedo: () => D.canRedo(), save: () => D.save(),
  action: { label: 'Make the pictures', icon: 'sparkle', run: () => makeAll() },
  rename: (title) => D.change((d) => { d.title = title; }),
  accepts: (it) => (it.asset ? it.assetKind === 'image' : ['character', 'place', 'prop', 'story', 'image'].includes(it.kind)),
  explain(it) {
    if (it.asset && it.assetKind === 'image') return { ok: true, text: 'Add it to the look: everything made in this world takes after it' };
    if (it.asset) return { ok: false, text: 'The look takes pictures. Sounds and clips go on a timeline; a 3D model can be a prop: make a prop and drop it there.' };
    if (it.kind === 'image') return it.render?.asset ? { ok: true, text: 'Add its picture to the look' } : { ok: false, text: `"${it.title}" has no picture yet. Open it and export a picture first.` };
    if (['character', 'place', 'prop', 'story'].includes(it.kind)) return D.doc?.members.includes(it.scene) ? { ok: false, text: `"${it.title}" is in this world already.` } : { ok: true, text: `Bring "${it.title}" into this world: it takes the world's look` };
    if (it.kind === 'world') return { ok: false, text: 'A world can\'t hold another world. Open that world to work on it.' };
    return { ok: false, text: 'A world holds characters, places, props and stories. Videos and stages use them: drag a character from here onto a stage.' };
  },
  drop: (it) => dropIn(it),
  uses: (s) => [{ label: 'Open its home', run: () => openScene(s.id) }],
  ai: { selection: () => ({}) },
  take: (scene) => { D.take(scene); loadHome(); },
});

async function loadHome() {
  if (!D.scene || Wd.loading) return;
  Wd.loading = true;
  try { Wd.home = await api(`/v1/worlds/${D.scene.id}`); } catch { /* the scene still shows */ } finally { Wd.loading = false; }
  draw();
  // While members' pictures are being made, look again now and then.
  clearTimeout(Wd.poll);
  const waiting = Wd.home && [...Wd.home.characters, ...Wd.home.places, ...Wd.home.props].some((m) => m.waiting);
  if (waiting) Wd.poll = setTimeout(() => { if ($('#wldWrap')) loadHome(); }, 5000);
}
bus.on('jobDone', () => { if ($('#wldWrap')) loadHome(); });

async function dropIn(it) {
  if (it.asset || it.kind === 'image') {
    const asset = it.asset ?? it.render?.asset;
    if (!asset) return toast(`"${it.title}" has no picture yet.`);
    D.change((d) => { d.board.push({ asset }); });
    return;
  }
  await joinWorld(it.scene, it.title);
}
/** A scene joins this world: it names the world, and the world lists it. */
async function joinWorld(id, title) {
  try {
    const s = await api(`/v1/scenes/${id}`);
    await api(`/v1/scenes/${id}`, { method: 'PUT', body: { doc: { ...s.doc, world: D.scene.id }, version: s.version } });
    D.change((d) => { if (!d.members.includes(id)) d.members.push(id); });
    await D.save();
    toast(`"${title}" is in this world now.`);
    loadHome();
  } catch (err) { toast(plainError(err.message)); }
}
async function addMember(kind) {
  await D.save();
  const label = { character: 'New character', place: 'New place', prop: 'New prop', story: 'New story' }[kind];
  const s = await newScene(kind, { title: label, doc: { title: label, world: D.scene.id }, open: false });
  D.change((d) => { d.members.push(s.id); });
  await D.save();
  await openScene(s.id);
}
async function makeAll() { await D.save(); await makePack(`/v1/worlds/${D.scene.id}/packs`, { what: 'the pictures this world is missing (its look, its characters, its places)', then: () => api(`/v1/scenes/${D.scene.id}`).then((s) => D.take(s, { keepHistory: true })).then(loadHome) }); }

/** A new stage shot with this member in it: a character in the cast, a place as the sky. */
async function newShot(m) {
  const doc = { title: `${m.title}: shot`, world: D.scene.id };
  if (m.kind === 'character') Object.assign(doc, { cast: [{ character: m.id, name: m.title, position: [0, 0], facing: 0 }], camera: { target: 0, distance: 4, height: 1.5, lens: 50 } });
  if (m.kind === 'place') { const p = await api(`/v1/scenes/${m.id}`); Object.assign(doc, { look: `${m.title}: ${p.doc.description ?? ''}`.slice(0, 2000), ...(p.doc.panorama?.asset ? { set: { sky: p.doc.panorama.asset } } : {}) }); }
  await newScene('stage', { title: doc.title, doc });
}
function cardMenu(m, btn) {
  const r = btn.getBoundingClientRect();
  popMenu(r.left - 160, r.bottom + 6, [
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); openScene(m.id); } }, 'Open'),
    ['character', 'place'].includes(m.kind) ? h('button', { class: 'menu-item', onclick: () => { closeMenus(); newShot(m).catch((e) => toast(plainError(e.message))); } }, 'Use in a new shot') : '',
    ['character', 'place', 'prop'].includes(m.kind) ? h('button', { class: 'menu-item', onclick: () => { closeMenus(); makePack(m.id, { then: loadHome }); } }, 'Make its pictures') : '',
    h('div', { class: 'menu-sep' }),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); D.change((d) => { d.members = d.members.filter((x) => x !== m.id); }); api(`/v1/scenes/${m.id}`).then((s) => api(`/v1/scenes/${m.id}`, { method: 'PUT', body: { doc: { ...s.doc, world: null } } })).then(loadHome).catch(() => {}); } }, 'Take it out of this world'),
  ]);
}

// ------------------------------------------------------------------ the home
const GRADES = [['contrast', 'Contrast'], ['saturation', 'Color'], ['warmth', 'Warmth'], ['exposure', 'Brightness'], ['grain', 'Grain'], ['vignette', 'Vignette']];
function draw() {
  const box = $('#wldWrap');
  if (!box || !D.doc) return;
  const d = D.doc;
  const H = Wd.home ?? { characters: [], places: [], props: [], stories: [] };
  const set = (fn) => D.change(fn);
  const section = (kind, title, items, hint) => h('section', { class: 'wld-sec' },
    h('div', { class: 'wld-sec-head' }, h('h3', {}, title, h('span', { class: 'muted small' }, ` ${items.length || ''}`)), h('button', { class: 'ghost small', onclick: () => addMember(kind).catch((e) => toast(plainError(e.message))) }, icon('plus'), 'Add')),
    items.length ? h('div', { class: 'wld-cards' }, ...items.map((m) => memberCard(m, { menu: cardMenu }))) : h('p', { class: 'muted small wld-hint' }, hint));
  const board = d.board.length ? h('div', { class: 'wld-board' }, ...d.board.map((b) => h('div', { class: `wld-board-pic${b.pending ? ' wait' : ''}` },
    b.asset ? h('img', { src: fileUrl(b.asset), alt: '' }) : h('div', { class: 'working small' }, b.pending ? 'Making…' : 'Didn\'t work'),
    h('button', { class: 'icon-btn small wld-x', title: 'Take it off the board', onclick: () => set((x) => { x.board = x.board.filter((y) => y.id !== b.id); }) }, icon('close')))))
    : h('div', { class: 'wld-board empty' }, h('p', { class: 'muted small' }, 'No look yet. Drop pictures here (a mood board), or ask the AI: "give this world a look".'));
  keepingFocus(box, () => box.replaceChildren(h('div', { class: 'wld-home' },
    h('header', { class: 'wld-head' },
      h('input', { class: 'wld-title', value: d.title, placeholder: 'The world\'s name', 'data-field': 'title', onchange: (e) => set((x) => { x.title = e.target.value.trim() || x.title; }) }),
      textField(D, '', d.logline, (v) => { D.doc.logline = v; }, { ph: 'One sentence: what is this world?', redraw: draw }),
      d.tone ? h('p', { class: 'muted small' }, d.tone) : ''),
    h('section', { class: 'wld-sec wld-look' },
      h('div', { class: 'wld-sec-head' }, h('h3', {}, 'The look'), h('div', { class: 'row' },
        h('button', { class: 'ghost small', title: 'A picture from Media', onclick: () => libraryPicker('image', (a) => set((x) => { x.board.push({ asset: a.id }); })) }, icon('image'), 'Add a picture'))),
      board,
      d.look.palette.length ? h('div', { class: 'wld-palette' }, ...d.look.palette.map((c) => h('span', { class: 'wld-swatch', style: { background: c }, title: c }))) : '',
      d.look.style ? h('p', { class: 'wld-style' }, d.look.style) : '',
      h('p', { class: 'muted small' }, 'Everything made in this world takes this look. A job can leave it out under its own Fine-tune.'),
      fineTune(
        textField(D, 'Style line (added to every prompt in this world)', d.look.style, (v) => { D.doc.look.style = v; }, { rows: 2, redraw: draw }),
        textField(D, 'Never show', d.look.negative, (v) => { D.doc.look.negative = v; }, { rows: 2 }),
        h('div', { class: 'field' }, h('span', {}, 'Palette'), h('div', { class: 'row wld-palette' },
          ...d.look.palette.map((c, i) => h('input', { type: 'color', value: c, onchange: (e) => set((x) => { x.look.palette[i] = e.target.value; }) })),
          d.look.palette.length < 8 ? h('button', { class: 'icon-btn small', title: 'Add a color', onclick: () => set((x) => { x.look.palette.push('#888888'); }) }, icon('plus')) : '',
          d.look.palette.length ? h('button', { class: 'icon-btn small', title: 'Remove the last color', onclick: () => set((x) => { x.look.palette.pop(); }) }, icon('close')) : '')),
        h('div', { class: 'field' }, h('span', {}, 'Grade (every finished shot)'), ...GRADES.map(([k, l]) => h('label', { class: 'row wld-grade' }, h('span', { class: 'small' }, l),
          h('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: String(d.look.grade?.params?.[k] ?? 0), onchange: (e) => set((x) => { x.look.grade = { ...(x.look.grade ?? {}), params: { ...(x.look.grade?.params ?? {}), [k]: Number(e.target.value) } }; }) })))),
      )),
    h('section', { class: 'wld-sec' },
      h('div', { class: 'wld-sec-head' }, h('h3', {}, 'Its rules'), h('button', { class: 'ghost small', onclick: () => checkCanon() }, icon('eye'), 'Check some writing')),
      d.rules.length ? h('ul', { class: 'wld-rules' }, ...d.rules.map((r, i) => h('li', {}, r, h('button', { class: 'icon-btn small', title: 'Remove the rule', onclick: () => set((x) => { x.rules.splice(i, 1); }) }, icon('close'))))) : h('p', { class: 'muted small wld-hint' }, 'Rules every script and picture must keep ("the moon is always red"). The AI checks scripts against them.'),
      fineTune(h('div', { class: 'row' }, (() => { const i = h('input', { type: 'text', placeholder: 'Add a rule and press Enter' }); i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && i.value.trim()) { const v = i.value.trim(); set((x) => { x.rules.push(v); }); } }); return i; })()),
        textField(D, 'History', d.history, (v) => { D.doc.history = v; }, { rows: 4 }))),
    section('character', 'Characters', H.characters, 'No one lives here yet. Add a character, or drag one in from Scenes.'),
    section('place', 'Places', H.places, 'No places yet. Add one, or ask the AI for "two places".'),
    section('prop', 'Props', H.props, 'Objects that matter: a lantern, a ship, a key. Each keeps one look everywhere.'),
    section('story', 'Stories', H.stories, 'Stories, series and episodes set here. Add one and its AI writes it top down.'),
  )));
}

async function checkCanon() {
  const text = prompt('Paste a script or a description to check against this world\'s rules:');
  if (!text?.trim()) return;
  try {
    await D.save();
    const r = await api(`/v1/worlds/${D.scene.id}/canon`, { body: { text } });
    if (r.aiCredits) refreshCredits();
    toast(r.ok ? 'It keeps every rule.' : r.breaks.map((b) => `"${b.quote}" breaks "${b.rule}": ${b.fix}`).join('\n'), { ms: 12000 });
  } catch (err) { toast(plainError(err.message)); }
}

// ------------------------------------------------------------------ start a world
/** The Start a world sheet: a sentence or a mood board, then the proposal as cards to keep, change or throw away. */
export function startWorld(idea = '') {
  if (!state.user) return needSignIn(() => startWorld(idea), 'signup');
  $('#worldStart')?.remove();
  const S = { board: [], proposal: null, keep: null, busy: false };
  const ta = h('textarea', { rows: '3', placeholder: 'A sentence is enough: "smugglers on a frozen moon where the sky is always red"' }, idea);
  const boardBox = h('div', { class: 'ws-board' });
  const body = h('div', { class: 'ws-body' });
  const sheet = h('div', { class: 'ws-sheet', id: 'worldStart', role: 'dialog', 'aria-label': 'Start a world' },
    h('div', { class: 'sheet-head' }, h('b', {}, 'Start a world'), h('button', { class: 'icon-btn', title: 'Close', onclick: () => sheet.remove() }, icon('close'))), body);
  document.body.append(sheet);
  const drawBoard = () => boardBox.replaceChildren(...S.board.map((a) => h('div', { class: 'ws-board-pic' }, h('img', { src: fileUrl(a), alt: '' }), h('button', { class: 'icon-btn small wld-x', title: 'Remove', onclick: () => { S.board = S.board.filter((x) => x !== a); drawBoard(); } }, icon('close')))),
    h('div', { class: 'ws-drop' }, icon('image'), h('span', { class: 'muted small' }, S.board.length ? 'Drop more' : 'Or drop a mood board: pictures from Media or your computer')));
  // A mood board: Media tiles or files, dropped here (each drop says what it does).
  sheet.addEventListener('dragover', (e) => { if (S.proposal) return; e.preventDefault(); sheet.classList.add('drop-on'); });
  sheet.addEventListener('dragleave', () => sheet.classList.remove('drop-on'));
  sheet.addEventListener('drop', (e) => {
    if (S.proposal) return;
    e.preventDefault(); e.stopPropagation();
    sheet.classList.remove('drop-on');
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) return uploadFiles(files, { then: (a) => { if (S.board.length < 4) { S.board.push(a.id); drawBoard(); } } });
    const it = readDrag(e) ?? dragging();
    const asset = it?.assetKind === 'image' ? it.asset : it?.render?.kind === 'image' ? it.render.asset : null;
    if (!asset) return toast('A mood board takes pictures.');
    if (S.board.length >= 4) return toast('Four pictures are plenty for a mood board.');
    S.board.push(asset);
    drawBoard();
  });
  const ask = async () => {
    if (S.busy) return;
    if (!ta.value.trim() && !S.board.length) return toast('Say what the world is, or drop a picture.');
    S.busy = true;
    body.replaceChildren(h('div', { class: 'ws-working' }, h('div', { class: 'working' }, 'Dreaming up your world…'), h('p', { class: 'muted small' }, 'Its look, the people in it, its places and a first story.')));
    try {
      const r = await api('/v1/worlds/start', { body: { project: state.user.project, idea: ta.value.trim(), board: S.board } });
      if (r.aiCredits) refreshCredits();
      S.proposal = r.proposal;
      S.keep = { characters: r.proposal.characters.map(() => true), places: r.proposal.places.map(() => true), props: r.proposal.props.map(() => true), story: Boolean(r.proposal.story) };
      drawProposal();
    } catch (err) { toast(plainError(err.message)); drawIdea(); } finally { S.busy = false; }
  };
  function drawIdea() {
    drawBoard();
    body.replaceChildren(h('p', { class: 'muted' }, 'Describe a world and the AI builds it: its look, the people in it, its places and a first story. You keep what you like.'), ta, boardBox,
      h('div', { class: 'row ws-acts' }, h('button', { class: 'primary', onclick: ask }, icon('sparkle'), 'Build my world')));
    ta.focus();
  }
  /** One proposed character, place or prop: its words can be changed in place; tap Keep to throw it away or back. */
  const card = (group, i, x, pic) => {
    const on = S.keep[group][i];
    const name = h('input', { class: 'ws-card-name', value: x.title, onchange: (e) => { x.title = e.target.value.trim() || x.title; } });
    const about = h('textarea', { rows: '3', class: 'ws-card-about', onchange: (e) => { x.description = e.target.value; } }, x.description ?? '');
    return h('div', { class: `ws-card${on ? '' : ' off'}` }, h('div', { class: 'ws-card-ico' }, icon(pic)), name, about,
      h('button', { class: `chip small${on ? ' on' : ''}`, onclick: () => { S.keep[group][i] = !on; drawProposal(); } }, on ? 'Keep' : 'Thrown away'));
  };
  function drawProposal() {
    const p = S.proposal;
    const w = p.world;
    body.replaceChildren(
      h('div', { class: 'ws-world' },
        h('input', { class: 'ws-world-title', value: w.title, onchange: (e) => { w.title = e.target.value.trim() || w.title; } }),
        h('p', {}, w.logline), w.tone ? h('p', { class: 'muted small' }, w.tone) : ''),
      h('div', { class: 'ws-look' }, h('h4', {}, 'The look'),
        S.board.length ? h('div', { class: 'ws-board' }, ...S.board.map((a) => h('div', { class: 'ws-board-pic' }, h('img', { src: fileUrl(a), alt: '' })))) : '',
        w.look.palette.length ? h('div', { class: 'wld-palette' }, ...w.look.palette.map((c) => h('span', { class: 'wld-swatch', style: { background: c } }))) : '',
        h('textarea', { rows: '2', class: 'ws-style', onchange: (e) => { w.look.style = e.target.value; } }, w.look.style),
        w.rules.length ? h('ul', { class: 'wld-rules' }, ...w.rules.map((r) => h('li', {}, r))) : ''),
      h('h4', {}, 'Characters'), h('div', { class: 'ws-cards' }, ...p.characters.map((c, i) => card('characters', i, c, 'person'))),
      h('h4', {}, 'Places'), h('div', { class: 'ws-cards' }, ...p.places.map((c, i) => card('places', i, c, 'sun'))),
      p.props.length ? h('h4', {}, 'Props') : '', p.props.length ? h('div', { class: 'ws-cards' }, ...p.props.map((c, i) => card('props', i, c, 'cube'))) : '',
      p.story ? h('div', { class: `ws-card ws-story${S.keep.story ? '' : ' off'}` }, h('div', { class: 'ws-card-ico' }, icon('text')), h('b', {}, p.story.title), h('p', { class: 'small' }, p.story.logline),
        h('button', { class: `chip small${S.keep.story ? ' on' : ''}`, onclick: () => { S.keep.story = !S.keep.story; drawProposal(); } }, S.keep.story ? 'Keep' : 'Thrown away')) : '',
      h('div', { class: 'row ws-acts' },
        h('button', { class: 'ghost', onclick: () => { S.proposal = null; drawIdea(); } }, 'Try another'),
        h('button', { class: 'primary', onclick: () => keep() }, icon('sparkle'), 'Make this world')));
  }
  const idx = (xs) => xs.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
  async function keep() {
    if (S.busy) return;
    S.busy = true;
    try {
      const body0 = { project: state.user.project, proposal: S.proposal, keep: { characters: idx(S.keep.characters), places: idx(S.keep.places), props: idx(S.keep.props), story: S.keep.story }, make: true };
      const r = await api('/v1/worlds/keep', { body: body0 });
      sheet.remove();
      await loadList();
      await openScene(r.world.id);
      // The pictures cost credits: priced, then asked once.
      if (r.packs?.proposed && r.packs.jobs) {
        if (confirm(`Your world is made. Make its pictures now (its look, ${S.keep.characters.filter(Boolean).length} characters, ${S.keep.places.filter(Boolean).length} places)? ${r.packs.jobs} pictures and sounds for ${r.packs.credits} credits.`)) {
          await makePack(`/v1/worlds/${r.world.id}/packs`, { then: () => api(`/v1/scenes/${r.world.id}`).then((s) => { if (D.scene?.id === s.id) D.take(s, { keepHistory: true }); loadHome(); }) });
        }
      }
    } catch (err) { toast(plainError(err.message)); } finally { S.busy = false; }
  }
  drawIdea();
}

/** A new account, after the tour: a world is the first thing offered (once, and only when they have none). */
bus.on('tourDone', () => {
  try { if (localStorage.getItem(`hg.worldOffer.${state.user?.id ?? 'local'}`)) return; localStorage.setItem(`hg.worldOffer.${state.user?.id ?? 'local'}`, '1'); } catch { /* */ }
  if (!state.user || sceneList().some((s) => s.kind === 'world')) return;
  setTimeout(() => startWorld(), 300);
});
