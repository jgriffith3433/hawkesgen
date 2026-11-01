// The prop editor (scenes.js; src/worldkinds.ts "prop"): an object that matters in a world (a lantern, a ship, a key),
// drawn the same everywhere. Its words, its sheet (the object alone), more views, its 3D model and who owns it.
// "Make its sheet" makes what's missing, priced first.

import { $, h, api, toast, icon, keepingFocus } from './lib.js';
import { libraryPicker, hasTool } from './studio.js';
import { runJob, quote, credits } from './media.js';
import { registerEditor, setRender, refreshBar } from './scenes.js';
import { sceneDoc } from './scenedoc.js';
import { fineTune, textField, elTile, makePack, worldHome } from './worldbits.js';

const D = sceneDoc({ onChange: () => { draw(); refreshBar(); showFace(); } });
const Pr = { people: [] };

registerEditor({
  kind: 'prop', label: 'Prop', icon: 'cube', panel: null,
  async mount(scene) { $('#prpWrap')?.remove(); $('#viewer').append(h('div', { id: 'prpWrap', class: 'wld-wrap' })); D.take(scene); loadPeople(); },
  async unmount() { await D.save(); D.stop(); $('#prpWrap')?.remove(); },
  undo: () => D.undo(), redo: () => D.redo(), canUndo: () => D.canUndo(), canRedo: () => D.canRedo(), save: () => D.save(),
  action: { label: 'Make its sheet', icon: 'sparkle', run: () => pack() },
  rename: (title) => D.change((d) => { d.title = title; }),
  accepts: (it) => (it.asset ? ['image', 'mesh'].includes(it.assetKind) : ['image', 'character'].includes(it.kind)),
  explain(it) {
    if (it.asset && it.assetKind === 'image') return { ok: true, text: D.doc?.sheet?.asset ? 'Add it as another view of this prop' : 'Make this its sheet' };
    if (it.asset && it.assetKind === 'mesh') return { ok: true, text: 'Make this its 3D model' };
    if (it.asset) return { ok: false, text: 'A prop takes pictures of it and a 3D model.' };
    if (it.kind === 'character') return { ok: true, text: `Make "${it.title}" its owner` };
    if (it.kind === 'image') return it.render?.asset ? { ok: true, text: 'Use its picture for this prop' } : { ok: false, text: `"${it.title}" has no picture yet.` };
    return { ok: false, text: 'Props go into shots: drag this prop onto a stage or into a story\'s shot instead.' };
  },
  drop: (it) => addFrom(it),
  ai: { selection: () => ({}) },
  take: (scene) => D.take(scene),
});

async function loadPeople() { const home = await worldHome(D.doc?.world); Pr.people = home?.characters ?? []; draw(); }
function addFrom(it) {
  if (it.kind === 'character') return D.change((d) => { d.owner = it.scene; });
  if (it.asset && it.assetKind === 'mesh') return D.change((d) => { d.model = { asset: it.asset }; });
  const asset = it.asset ?? it.render?.asset;
  if (!asset) return toast(`"${it.title}" has no picture yet.`);
  D.change((d) => { if (!d.sheet?.asset) d.sheet = { asset }; else d.views.push({ name: 'view', asset }); });
}
function showFace() { const f = D.doc?.sheet; if (f?.asset && D.scene && D.scene.doc?.render?.asset !== f.asset) setRender(D.scene.id, f.asset, 'image').then((s) => D.take(s, { keepHistory: true })).catch(() => {}); }
const pack = () => D.save().then(() => makePack(D.scene.id, { what: `${D.doc.title}'s sheet`, then: () => api(`/v1/scenes/${D.scene.id}`).then((s) => D.take(s, { keepHistory: true })) }));

/** Gen's way to 3D, as a character's: the sheet cut out, a checked 4-view sheet, mesh.views3d. */
async function makeModel() {
  const sheet = D.doc.sheet;
  if (!sheet?.asset) return toast('It needs a sheet first (Make its sheet).');
  const steps = [{ tool: 'image.remove-background', inputs: { image: '$input:0' } }, { tool: 'image.viewsheet', params: { form: D.doc.description.slice(0, 300) || D.doc.title }, inputs: { image: '$prev:cutout' } }, { tool: 'mesh.views3d', inputs: { image: '$prev:sheet' } }];
  const q = await quote('asset.make', { steps });
  if (!confirm(`Make ${D.doc.title}'s 3D model${q ? ` for ${credits(q)}` : ''}? It takes a while.`)) return;
  runJob({ tool: 'asset.make', params: { steps }, inputs: { files: [`asset:${sheet.asset}`] }, label: `${D.doc.title}: 3D model`, onStart: (job) => D.change((d) => { d.model = { pending: job }; }) })
    .then((done) => { const out = done.outputs.find((o) => o.kind === 'mesh'); D.change((d) => { d.model = out ? { asset: out.asset } : { failed: 'No model came out' }; }, { history: false }); })
    .catch((err) => D.change((d) => { d.model = { failed: err.message }; }, { history: false }));
}

function draw() {
  const box = $('#prpWrap');
  if (!box || !D.doc) return;
  const d = D.doc;
  const set = (fn) => D.change(fn);
  const owner = Pr.people.find((p) => p.id === d.owner);
  keepingFocus(box, () => box.replaceChildren(h('div', { class: 'wld-home' },
    h('header', { class: 'wld-head' }, h('input', { class: 'wld-title', value: d.title, placeholder: 'What it\'s called', 'data-field': 'title', onchange: (e) => set((x) => { x.title = e.target.value.trim() || x.title; }) }),
      owner ? h('p', { class: 'muted small' }, `${owner.title}'s`) : ''),
    h('div', { class: 'wld-hero' }, elTile(d.sheet, 'image', { empty: 'No sheet yet. Describe it, then Make its sheet.', cls: 'hero square' })),
    textField(D, 'What it is', d.description, (v) => { D.doc.description = v; }, { rows: 3, ph: 'Size, materials, colors, wear: the same words draw it in every shot.', redraw: draw }),
    h('div', { class: 'row' },
      !d.sheet?.asset && !d.sheet?.pending ? h('button', { class: 'primary small', onclick: pack }, icon('sparkle'), 'Make its sheet') : '',
      hasTool('mesh.views3d') && d.sheet?.asset ? h('button', { class: 'ghost small', onclick: makeModel, disabled: Boolean(d.model?.pending) }, icon('cube'), d.model?.asset ? 'Make the 3D model again' : 'Make the 3D model') : ''),
    d.views.length ? h('section', { class: 'wld-sec' }, h('h3', {}, 'More views'), h('div', { class: 'wld-grid' }, ...d.views.map((v) => elTile(v)))) : '',
    h('section', { class: 'wld-sec' }, h('h3', {}, '3D model'), elTile(d.model, 'mesh', { empty: 'No 3D model yet' })),
    fineTune(
      h('label', { class: 'field' }, 'Owner', h('select', { onchange: (e) => set((x) => { x.owner = e.target.value || null; }) }, h('option', { value: '' }, 'No one'), ...Pr.people.map((p) => h('option', { value: p.id, selected: p.id === d.owner }, p.title)))),
      h('div', { class: 'row' }, h('button', { class: 'ghost small', onclick: () => libraryPicker('image', (a) => set((x) => { x.views.push({ name: 'view', asset: a.id }); })) }, icon('image'), 'Add a view from Media'),
        h('button', { class: 'ghost small', onclick: () => libraryPicker('mesh', (a) => set((x) => { x.model = { asset: a.id }; })) }, icon('cube'), 'Pick a 3D model')),
      textField(D, 'Notes', d.notes, (v) => { D.doc.notes = v; }, { rows: 3 })),
  )));
}
