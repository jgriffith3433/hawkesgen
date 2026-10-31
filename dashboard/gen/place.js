// The place editor (scenes.js; src/worldkinds.ts "place"): a location in a world. What it is (words a picture can be
// painted from), its pack (a 360° panorama a stage uses as its sky, key views, an optional 3D set), how it looks at other
// times and in other weather, and its sound. "Make its pack" makes what's missing, priced first; "Use in a new shot"
// opens a stage with this place around it.

import { $, h, api, toast, icon, keepingFocus } from './lib.js';
import { libraryPicker } from './studio.js';
import { registerEditor, newScene, setRender, refreshBar } from './scenes.js';
import { sceneDoc } from './scenedoc.js';
import { fineTune, textField, elTile, makePack } from './worldbits.js';

const D = sceneDoc({ onChange: () => { draw(); refreshBar(); showFace(); } });
const face = () => D.doc?.views.find((v) => v.asset) ?? (D.doc?.panorama?.asset ? D.doc.panorama : null);

registerEditor({
  kind: 'place', label: 'Place', icon: 'sun', panel: null,
  async mount(scene) { $('#plcWrap')?.remove(); $('#viewer').append(h('div', { id: 'plcWrap', class: 'wld-wrap' })); D.take(scene); },
  async unmount() { await D.save(); D.stop(); $('#plcWrap')?.remove(); },
  undo: () => D.undo(), redo: () => D.redo(), canUndo: () => D.canUndo(), canRedo: () => D.canRedo(), save: () => D.save(),
  action: { label: 'Use in a new shot', icon: 'cube', run: () => newShot() },
  rename: (title) => D.change((d) => { d.title = title; }),
  accepts: (it) => (it.asset ? ['image', 'mesh', 'audio'].includes(it.assetKind) : it.kind === 'image'),
  explain(it) {
    if (it.asset && it.assetKind === 'image') return { ok: true, text: D.doc?.panorama?.asset ? 'Add it as a view of this place' : 'Add it as a view (a wide 2:1 picture becomes its panorama)' };
    if (it.asset && it.assetKind === 'mesh') return { ok: true, text: 'Make this its 3D set' };
    if (it.asset && it.assetKind === 'audio') return { ok: true, text: 'Make this its sound (the ambience under every shot here)' };
    if (it.asset) return { ok: false, text: 'A place takes pictures, a 3D set and a sound. Clips go on a timeline.' };
    if (it.kind === 'image') return it.render?.asset ? { ok: true, text: 'Add its picture as a view of this place' } : { ok: false, text: `"${it.title}" has no picture yet.` };
    if (it.kind === 'character') return { ok: false, text: 'People meet places on a stage: press "Use in a new shot", then drop them there.' };
    return { ok: false, text: 'A place is used by stages and stories: drag this place onto a stage or into a story\'s shot instead.' };
  },
  drop: (it) => addFrom(it),
  uses: (s) => [{ label: 'Use in a new shot', run: () => newShot(s.id, s.title) }],
  ai: { selection: () => ({}) },
  take: (scene) => D.take(scene),
});

async function addFrom(it) {
  if (it.asset && it.assetKind === 'mesh') return D.change((d) => { d.set = { asset: it.asset }; });
  if (it.asset && it.assetKind === 'audio') return D.change((d) => { d.ambience = { asset: it.asset }; });
  const asset = it.asset ?? it.render?.asset;
  if (!asset) return toast(`"${it.title}" has no picture yet.`);
  // A 2:1 picture is a panorama (what image.panorama makes); anything else is a view.
  const img = new Image();
  img.src = `/v1/assets/${asset}/file`;
  await img.decode().catch(() => {});
  const pano = img.naturalWidth && Math.abs(img.naturalWidth / img.naturalHeight - 2) < 0.05 && !D.doc.panorama?.asset;
  D.change((d) => { if (pano) d.panorama = { asset }; else d.views.push({ name: d.views.length ? 'view' : 'wide', asset }); });
}
function showFace() { const f = face(); if (f && D.scene && D.scene.doc?.render?.asset !== f.asset) setRender(D.scene.id, f.asset, 'image').then((s) => D.take(s, { keepHistory: true })).catch(() => {}); }

async function newShot(id = D.scene?.id, title = D.doc?.title) {
  await D.save();
  const d = id === D.scene?.id ? D.doc : (await api(`/v1/scenes/${id}`)).doc;
  await newScene('stage', { title: `${title}: shot`, doc: { title: `${title}: shot`, ...(d.world ? { world: d.world } : {}), look: `${title}: ${d.description ?? ''}`.slice(0, 2000), ...(d.panorama?.asset ? { set: { sky: d.panorama.asset } } : {}) } });
}
const pack = () => D.save().then(() => makePack(D.scene.id, { what: `${D.doc.title}'s pictures and sound`, then: () => api(`/v1/scenes/${D.scene.id}`).then((s) => D.take(s, { keepHistory: true })) }));

function draw() {
  const box = $('#plcWrap');
  if (!box || !D.doc) return;
  const d = D.doc;
  const set = (fn) => D.change(fn);
  const missing = !d.panorama?.asset && !d.panorama?.pending || !d.views.some((v) => v.asset || v.pending) || !d.ambience?.asset && !d.ambience?.pending;
  keepingFocus(box, () => box.replaceChildren(h('div', { class: 'wld-home' },
    h('header', { class: 'wld-head' }, h('input', { class: 'wld-title', value: d.title, placeholder: 'The place\'s name', 'data-field': 'title', onchange: (e) => set((x) => { x.title = e.target.value.trim() || x.title; }) })),
    h('div', { class: 'wld-hero' }, elTile(face(), 'image', { empty: 'No pictures yet. Describe it, then Make its pack.', cls: 'hero' })),
    textField(D, 'What it is', d.description, (v) => { D.doc.description = v; }, { rows: 3, ph: 'How it looks, as words a picture can be painted from: size, materials, light, what fills it.', redraw: draw }),
    h('div', { class: 'row' },
      missing ? h('button', { class: 'primary small', onclick: pack }, icon('sparkle'), 'Make its pack') : '',
      h('button', { class: 'ghost small', onclick: () => newShot() }, icon('cube'), 'Use in a new shot')),
    h('section', { class: 'wld-sec' }, h('div', { class: 'wld-sec-head' }, h('h3', {}, 'Panorama'), h('span', { class: 'muted small' }, 'All around: a stage uses it as its sky')),
      elTile(d.panorama, 'image', { empty: 'None yet', cls: 'wide' })),
    h('section', { class: 'wld-sec' }, h('div', { class: 'wld-sec-head' }, h('h3', {}, 'Views'), h('button', { class: 'ghost small', onclick: () => libraryPicker('image', (a) => set((x) => { x.views.push({ name: 'view', asset: a.id }); })) }, icon('plus'), 'From Media')),
      d.views.length ? h('div', { class: 'wld-grid' }, ...d.views.map((v) => h('figure', {}, elTile(v), h('figcaption', { class: 'muted small' }, v.name ?? 'view', h('button', { class: 'icon-btn small', title: 'Remove', onclick: () => set((x) => { x.views = x.views.filter((y) => y.id !== v.id); }) }, icon('close')))))) : h('p', { class: 'muted small wld-hint' }, 'Key views: the wide shot, the entrance, the corner where things happen.')),
    h('section', { class: 'wld-sec' }, h('div', { class: 'wld-sec-head' }, h('h3', {}, 'Times and weather')),
      d.variants.length ? h('div', { class: 'wld-grid' }, ...d.variants.map((v) => h('figure', {}, elTile(v), h('figcaption', { class: 'muted small' }, v.name)))) : h('p', { class: 'muted small wld-hint' }, 'Ask the AI: "show it at night" or "in a snowstorm".')),
    h('section', { class: 'wld-sec' }, h('div', { class: 'wld-sec-head' }, h('h3', {}, 'Its sound')), elTile(d.ambience, 'audio', { empty: 'No ambience yet' })),
    fineTune(
      h('div', { class: 'field' }, h('span', {}, '3D set'), elTile(d.set, 'mesh', { empty: 'No 3D set' }), h('button', { class: 'ghost small', onclick: () => libraryPicker('mesh', (a) => set((x) => { x.set = { asset: a.id }; })) }, icon('cube'), 'Pick a 3D set')),
      textField(D, 'Notes', d.notes, (v) => { D.doc.notes = v; }, { rows: 3 })),
  )));
}
