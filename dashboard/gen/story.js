// The story editor (scenes.js; src/worldkinds.ts "story"): a story, a series or an episode, written top down by its AI
// (logline, then beats, then the script, then the shot list), each layer kept until it's changed. Every shot names its
// place, cast and props and carries the state of things at its moment (continuity: who wears what, injuries, who holds
// which prop, the time of day). "Make this shot" opens a stage made from the shot, linked back. Characters, places and
// props dropped on a shot join it.

import { $, h, api, toast, icon, plainError, keepingFocus } from './lib.js';
import { registerEditor, openScene, refreshBar, loadList } from './scenes.js';
import { sceneDoc } from './scenedoc.js';
import { fineTune, textField, worldHome } from './worldbits.js';

const D = sceneDoc({ onChange: () => { draw(); refreshBar(); } });
const St = { names: new Map(), tab: 'beats' };
const LEVELS = [['story', 'Story'], ['series', 'Series'], ['episode', 'Episode']];
const askAi = (text) => import('./ai.js').then((a) => a.askAi(text));

registerEditor({
  kind: 'story', label: 'Story', icon: 'text', panel: null,
  async mount(scene) { $('#styWrap')?.remove(); $('#viewer').append(h('div', { id: 'styWrap', class: 'wld-wrap' })); D.take(scene); loadNames(); },
  async unmount() { await D.save(); D.stop(); $('#styWrap')?.remove(); },
  undo: () => D.undo(), redo: () => D.redo(), canUndo: () => D.canUndo(), canRedo: () => D.canRedo(), save: () => D.save(),
  action: { label: 'Write the next part', icon: 'sparkle', run: () => nextLayer() },
  rename: (title) => D.change((d) => { d.title = title; }),
  accepts: (it) => !it.asset && ['character', 'place', 'prop'].includes(it.kind),
  explain(it, at) {
    if (it.asset) return { ok: false, text: 'A story is words: pictures and sounds go on a timeline, or onto a character, place or prop.' };
    if (!['character', 'place', 'prop'].includes(it.kind)) return { ok: false, text: 'A story takes characters, places and props: drop one on a shot.' };
    const shot = shotAt(at);
    if (!shot) return { ok: true, text: `Drop "${it.title}" on a shot in the shot list (or ask the AI to write them in)` };
    return { ok: true, text: it.kind === 'place' ? `Set shot "${shot.title || 'untitled'}" in ${it.title}` : `Put ${it.title} in shot "${shot.title || 'untitled'}"` };
  },
  drop: (it, at) => dropOn(it, at),
  ai: { selection: () => ({ tab: St.tab }) },
  take: (scene) => { D.take(scene); loadNames(); },
});

/** The shot card under the pointer (a drop's place), if any. */
function shotAt(at) {
  const x = at?.clientX ?? at?.x, y = at?.clientY ?? at?.y;
  if (x == null) return null;
  const el = document.elementFromPoint(x, y)?.closest?.('.sty-shot');
  return el ? D.doc.shots.find((s) => s.id === el.dataset.id) ?? null : null;
}
function dropOn(it, at) {
  const shot = shotAt(at);
  St.names.set(it.scene, it.title);
  if (!shot) { St.tab = 'shots'; draw(); return toast('Drop it on one of the shots.'); }
  D.change((d) => {
    const s = d.shots.find((x) => x.id === shot.id);
    if (it.kind === 'place') s.place = it.scene;
    else if (it.kind === 'character' && !s.cast.includes(it.scene)) s.cast.push(it.scene);
    else if (it.kind === 'prop' && !s.props.includes(it.scene)) s.props.push(it.scene);
  });
}

async function loadNames() {
  const home = await worldHome(D.doc?.world);
  for (const m of [...(home?.characters ?? []), ...(home?.places ?? []), ...(home?.props ?? [])]) St.names.set(m.id, m.title);
  draw();
}
const nameOf = (id) => St.names.get(id) ?? 'someone';

/** The next layer down that's missing, asked of the story AI. */
function nextLayer() {
  const d = D.doc;
  const ask = !d.logline.trim() ? 'Write the logline.' : !d.beats.length ? 'Write the beats from the logline.' : !d.script.length ? 'Write the script from the beats.' : !d.shots.length ? 'Write the shot list from the script, with continuity.' : 'Read it through and tighten it: fix continuity and anything that breaks the world\'s rules.';
  St.tab = !d.beats.length ? 'beats' : !d.script.length ? 'script' : 'shots';
  draw();
  askAi(ask);
}

async function makeShot(s) {
  try {
    await D.save();
    if (s.stage) return openScene(s.stage);
    const r = await api(`/v1/stories/${D.scene.id}/shots/${s.id}/stage`, { body: {} });
    D.take(r.story, { keepHistory: true });
    await loadList();
    await openScene(r.stage.id);
  } catch (err) { toast(plainError(err.message)); }
}

/** The state of things at a shot, in a line or two. */
function stateLine(st) {
  if (!st) return '';
  const bits = [];
  if (st.time) bits.push(st.time);
  for (const [id, p] of Object.entries(st.people ?? {})) {
    const xs = [p.wears && `wears ${p.wears}`, p.injuries?.length && p.injuries.join(', '), p.holds?.length && `holds ${p.holds.map(nameOf).join(', ')}`, p.at && `at ${St.names.get(p.at) ?? p.at}`].filter(Boolean);
    if (xs.length) bits.push(`${nameOf(id)}: ${xs.join('; ')}`);
  }
  return bits.join(' · ');
}

function draw() {
  const box = $('#styWrap');
  if (!box || !D.doc) return;
  const d = D.doc;
  const set = (fn) => D.change(fn);
  const tabs = [['beats', `Beats (${d.beats.length})`], ['script', `Script (${d.script.length})`], ['shots', `Shots (${d.shots.length})`]];
  const empty = (what, ask) => h('div', { class: 'sty-empty' }, h('p', { class: 'muted small' }, what), h('button', { class: 'primary small', onclick: () => askAi(ask) }, icon('sparkle'), 'Ask the AI'));
  const body = {
    beats: () => (d.beats.length ? h('ol', { class: 'sty-beats' }, ...d.beats.map((b) => h('li', {}, (() => { const i = h('textarea', { rows: '2', 'data-field': b.id }, b.text); i.addEventListener('focus', () => D.change(() => {}, { redraw: false })); i.addEventListener('input', () => D.change((x) => { x.beats.find((y) => y.id === b.id).text = i.value; }, { history: false, redraw: false })); return i; })(),
      h('button', { class: 'icon-btn small', title: 'Remove the beat', onclick: () => set((x) => { x.beats = x.beats.filter((y) => y.id !== b.id); }) }, icon('close')))))
      : empty('No beats yet: the turns of the story, one line each.', 'Write the beats from the logline.')),
    script: () => (d.script.length ? h('div', { class: 'sty-script' }, ...d.script.map((s) => h('div', { class: 'sty-scene' },
      h('b', { class: 'sty-heading' }, s.heading || 'A scene'), s.action ? h('p', { class: 'sty-action' }, s.action) : '',
      ...s.lines.map((l) => h('p', { class: 'sty-line' }, h('span', { class: 'sty-who' }, l.who ? nameOf(l.who) : l.name || 'someone'), l.how ? h('span', { class: 'muted small' }, ` (${l.how})`) : '', h('span', {}, l.text))))))
      : empty('No script yet: scenes, what we see, and every line.', 'Write the script from the beats.')),
    shots: () => (d.shots.length ? h('div', { class: 'sty-shots' }, ...d.shots.map((s, i) => h('div', { class: `sty-shot${s.stage ? ' made' : ''}`, 'data-id': s.id },
      h('div', { class: 'sty-shot-head' }, h('span', { class: 'sty-n' }, String(i + 1)), h('b', {}, s.title || `Shot ${i + 1}`), s.framing ? h('span', { class: 'chip small' }, s.framing) : ''),
      s.what ? h('p', { class: 'small' }, s.what) : '',
      h('div', { class: 'sty-chips' }, s.place ? h('span', { class: 'chip small', title: 'Where' }, icon('sun'), nameOf(s.place)) : '', ...s.cast.map((c) => h('span', { class: 'chip small', title: 'Who' }, icon('person'), nameOf(c))), ...s.props.map((p) => h('span', { class: 'chip small', title: 'Props' }, icon('cube'), nameOf(p)))),
      stateLine(s.state) ? h('p', { class: 'muted small sty-state', title: 'The state of things at this moment' }, stateLine(s.state)) : '',
      h('div', { class: 'row' }, h('button', { class: s.stage ? 'ghost small' : 'primary small', onclick: () => makeShot(s) }, icon('cube'), s.stage ? 'Open the shot' : 'Make this shot')))))
      : empty('No shots yet: the shot list comes from the script, each shot with its place, who\'s in it and what they hold.', 'Write the shot list from the script, with continuity.')),
  }[St.tab];
  keepingFocus(box, () => box.replaceChildren(h('div', { class: 'wld-home sty' },
    h('header', { class: 'wld-head' },
      h('input', { class: 'wld-title', value: d.title, placeholder: 'Its title', 'data-field': 'title', onchange: (e) => set((x) => { x.title = e.target.value.trim() || x.title; }) }),
      textField(D, '', d.logline, (v) => { D.doc.logline = v; }, { ph: 'The logline: one sentence that sells it', redraw: draw })),
    h('div', { class: 'row' }, h('button', { class: 'primary small', onclick: nextLayer }, icon('sparkle'), 'Write the next part')),
    h('div', { class: 'seg sty-tabs' }, ...tabs.map(([k, l]) => h('button', { class: St.tab === k ? 'on' : '', onclick: () => { St.tab = k; draw(); } }, l))),
    body(),
    fineTune(
      h('label', { class: 'field' }, 'Kind', h('select', { onchange: (e) => set((x) => { x.level = e.target.value; }) }, ...LEVELS.map(([v, l]) => h('option', { value: v, selected: v === d.level }, l)))),
      d.level === 'episode' ? h('label', { class: 'field' }, 'Episode number', h('input', { type: 'number', min: '1', value: String(d.number ?? ''), onchange: (e) => set((x) => { x.number = Number(e.target.value) || null; }) })) : '',
      textField(D, 'Notes', d.notes, (v) => { D.doc.notes = v; }, { rows: 3 })),
  )));
}
