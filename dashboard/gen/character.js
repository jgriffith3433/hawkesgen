// The character editor (scenes.js; src/scenekinds.ts "character"): a person or creature to cast. Who they are (name,
// look, height, color, notes), how they sound (a voice), what they look like (pictures: front, portrait, view sheet,
// references) and their 3D model (with its animation clips). A stage's cast member who plays this character takes all of
// that from here, in every shot (src/director.ts castFromCharacters). "Make the 3D model" runs Gen's way from a front
// picture to a model (cutout, a checked 4-view sheet, mesh.views3d, optionally rigged); "Stage them" opens a new stage.
// Their look (docs/identity.md): "Make their look" makes the front picture, the sheet and the fixed description; "Lock
// their look" approves it once, and every shot they're in then uses that sheet and those words. A character who recurs
// is offered "Keep <name> consistent everywhere" (a LoRA, priced first).

import { $, h, api, toast, fileUrl, bus, icon, plainError, keepingFocus } from './lib.js';
import { runJob, quote, credits } from './media.js';
import { libraryPicker, hasTool, toolReady } from './studio.js';
import { registerEditor, newScene, setRender, refreshBar } from './scenes.js';
import { sceneDoc } from './scenedoc.js';

const C = { voices: [], preview: null, look: null, lookBusy: '' };
const D = sceneDoc({ onChange: () => { draw(); refreshBar(); } });
const ROLES = [['front', 'Front'], ['portrait', 'Portrait'], ['cutout', 'Cutout'], ['sheet', 'View sheet'], ['turnaround', 'Turnaround'], ['reference', 'Reference']];
const pic = (role) => D.doc?.pictures.find((p) => p.role === role && p.asset) ?? null;
const mainPic = () => pic('portrait') ?? pic('front') ?? D.doc?.pictures.find((p) => p.asset) ?? null;

registerEditor({
  kind: 'character', label: 'Character', icon: 'person', panel: null,
  async mount(scene) {
    $('#chrWrap')?.remove();
    $('#viewer').append(h('div', { id: 'chrWrap', class: 'chr-wrap' }));
    C.look = null;
    D.take(scene);
    loadVoices();
    loadLook();
  },
  async unmount() { await D.save(); D.stop(); C.preview?.pause(); $('#chrWrap')?.remove(); },
  undo: () => D.undo(), redo: () => D.redo(), canUndo: () => D.canUndo(), canRedo: () => D.canRedo(), save: () => D.save(),
  action: { label: 'Stage them', icon: 'cube', run: () => stageThem() },
  rename: (title) => D.change((d) => { d.title = title; }),
  accepts: (it) => (it.asset ? ['image', 'mesh'].includes(it.assetKind) : it.kind === 'image'),
  explain(it) {
    if (it.asset?.length && it.assetKind === 'image') return { ok: true, text: 'Add this as a picture of them' };
    if (it.asset && it.assetKind === 'mesh') return { ok: true, text: 'Make this their 3D model' };
    if (it.asset && it.assetKind === 'audio') return { ok: false, text: 'Pick their voice in the Voice section. Sounds go on a timeline.' };
    if (it.asset) return { ok: false, text: 'A character takes pictures of them and a 3D model.' };
    if (it.kind === 'image') return it.render?.asset ? { ok: true, text: 'Add its picture as a picture of them' } : { ok: false, text: `"${it.title}" has no picture yet. Open it and press Export picture first.` };
    if (it.kind === 'character') return { ok: false, text: 'Characters meet on a stage. Open a stage and drop them both there.' };
    return { ok: false, text: 'People go into scenes, not the other way round: drop this character into a stage instead.' };
  },
  drop: (it) => addFrom(it),
  uses: (s) => [{ label: 'Stage them', run: () => stageThem(s.id, s.title) }],
  ai: { selection: () => ({}) },
  take: (scene) => D.take(scene),
});

/** The identity pack and the LoRA offer, as Gen sees them (src/identityroutes.ts). */
async function loadLook() { if (!D.scene) return; try { C.look = await api(`/v1/scenes/${D.scene.id}/identity`); draw(); } catch { /* */ } }
async function loadVoices() { if (C.voices.length) return; try { C.voices = (await api('/v1/editor/voices')).voices ?? []; draw(); } catch { /* */ } }

/** A picture or model dropped in: a picture is a reference (or the front, when there's none); a GLB is their model. */
async function addFrom(it) {
  if (it.asset && it.assetKind === 'mesh') return D.change((d) => { d.model = { asset: it.asset }; });
  let asset = it.asset;
  if (!asset) { const r = it.render ?? (await api(`/v1/scenes/${it.scene}`)).doc.render; if (r?.kind !== 'image') return toast(`"${it.title}" has no picture yet.`); asset = r.asset; }
  D.change((d) => { d.pictures.push({ role: pic('front') ? 'reference' : 'front', asset }); });
  showFace();
}
/** Their main picture is the scene's render: it shows in Scenes and can be placed in an image. */
function showFace() { const p = mainPic(); if (p && D.scene && D.scene.doc?.render?.asset !== p.asset) setRender(D.scene.id, p.asset, 'image').then((s) => D.take(s, { keepHistory: true })).catch(() => {}); }

// ------------------------------------------------------------------ making things
/** A job whose result lands in a picture of this role (the picture waits on it, here or after a reload). */
function makePicture(role, tool, params, inputs = {}) {
  let id = null;
  return runJob({ tool, params, inputs, label: `${D.doc.title}: ${role}`, onStart: (job) => D.change((d) => {
    id = `p_${Math.random().toString(36).slice(2, 10)}`;
    d.pictures = d.pictures.filter((p) => !(p.role === role && !p.asset));
    d.pictures.push({ id, role, pending: job });
  }) }).then((done) => {
    const outs = done.outputs ?? [];
    const out = outs.find((o) => o.title === 'cutout') ?? outs.find((o) => o.kind === 'image' && !/mask/i.test(o.title ?? '')) ?? outs[0];
    D.change((d) => { const p = d.pictures.find((x) => x.id === id); if (p && out) { p.asset = out.asset; delete p.pending; } }, { history: false });
    showFace();
    return out?.asset ?? null;
  }).catch((err) => { D.change((d) => { const p = d.pictures.find((x) => x.id === id); if (p) { delete p.pending; p.failed = plainError(err.message); } }, { history: false }); return null; });
}
function makePictures() {
  const look = D.doc.description.trim();
  if (!look) return toast('Describe how they look first.');
  if (!pic('front')) makePicture('front', 'image.generate', { prompt: `${look}. Full body, front view, standing in an A-pose, arms slightly away from the body, plain light grey background, even studio light.`, width: 768, height: 1344, seed: Math.floor(Math.random() * 2 ** 31) });
  if (!pic('portrait')) makePicture('portrait', 'image.generate', { prompt: `${look}. Head and shoulders portrait, looking at the camera, soft studio light, plain background.`, width: 1024, height: 1024, seed: Math.floor(Math.random() * 2 ** 31) });
}
// ------------------------------------------------------------------ their look (the identity pack)
/** Their front picture (when there's none), the sheet over it, then the fixed description; the person locks it after. */
async function makeLook() {
  if (!D.doc.description.trim() && !pic('front')) return toast('Describe how they look first.');
  if (C.lookBusy) return;
  const busy = (t) => { C.lookBusy = t; draw(); };
  try {
    busy('Making their pictures…');
    await D.save();
    const { plan } = await api(`/v1/scenes/${D.scene.id}/identity`);
    for (const st of plan.steps) {
      const front = pic('front');
      const inputs = st.inputs?.images ? { images: [`asset:${front?.asset}`] } : {};
      busy(st.role === 'front' ? 'Making their front picture…' : 'Making their sheet…');
      const made = await makePicture(st.role, st.tool, { ...st.params, seed: Math.floor(Math.random() * 2 ** 31) }, inputs);
      if (!made) throw new Error(st.role === 'front' ? 'Their front picture failed' : 'Their sheet failed');
    }
    busy('Writing how they look…');
    await D.save();
    const r = await api(`/v1/scenes/${D.scene.id}/identity/describe`, { body: {} });
    D.take(r.scene, { keepHistory: true });
    C.look = { ...(C.look ?? {}), pack: r.pack, lora: r.lora };
    toast('Their look is ready: check it, then lock it.');
  } catch (err) { toast(plainError(err.message)); } finally { busy(''); }
}
async function lockLook(on) {
  try {
    await D.save();
    const r = await api(`/v1/scenes/${D.scene.id}/identity/${on ? 'lock' : 'unlock'}`, { body: {} });
    D.take(r.scene, { keepHistory: true });
    C.look = { ...(C.look ?? {}), pack: r.pack, lora: r.lora };
    if (on) toast(`${D.doc.title}'s look is locked: every shot they're in uses it.`);
  } catch (err) { toast(plainError(err.message)); }
}
/** "Keep <name> consistent everywhere": Gen learns their look (a LoRA), priced first. */
async function keepConsistent() {
  try {
    await D.save();
    const q = await api(`/v1/scenes/${D.scene.id}/identity/lora?quote=1`, { body: {} });
    if (!confirm(`Keep ${D.doc.title} consistent everywhere${q.quote ? ` for ${credits(q.quote)}` : ''}? Gen studies ${q.images} pictures of them and learns their look (about half an hour). Every shot they're in then draws them from it.`)) return;
    const r = await api(`/v1/scenes/${D.scene.id}/identity/lora`, { body: {} });
    D.take(r.scene, { keepHistory: true });
    C.look = { ...(C.look ?? {}), pack: r.pack, lora: r.lora };
  } catch (err) { toast(plainError(err.message)); }
}

/** The look section: the sheet, the fixed words, Make / Lock / Unlock, and the LoRA's state or offer. */
function lookSection(d) {
  const lock = d.lock ?? null;
  const locked = Boolean(lock?.at);
  const sheet = lock?.sheet ?? [...d.pictures].reverse().find((p) => p.role === 'sheet' && p.asset)?.asset ?? null;
  const offer = C.look?.lora ?? null;
  const lora = d.lora ?? null;
  const words = lock ? (() => {
    const el = h('textarea', { rows: '4', 'data-field': 'fixed', readonly: locked, placeholder: 'How they look in every shot' }, lock.description);
    el.addEventListener('input', () => D.change((x) => { x.lock.description = el.value; }, { history: false, redraw: false }));
    el.addEventListener('change', () => draw());
    return h('label', { class: 'field' }, locked ? 'How they look in every shot' : 'How they look in every shot (check it before locking)', el);
  })() : '';
  const learn = !locked ? '' : lora?.state === 'training' ? h('p', { class: 'chr-lora working small' }, 'Learning their look…')
    : lora?.state === 'ready' ? h('p', { class: 'chr-lora small' }, 'Locked in: every shot draws them from what Gen learned.')
      : lora?.state === 'failed' ? h('div', { class: 'row' }, h('span', { class: 'muted small' }, `Gen couldn't learn their look: ${plainError(lora.failed ?? '')}`), h('button', { class: 'ghost small', onclick: keepConsistent }, 'Try again'))
        : offer?.eligible ? h('button', { class: 'primary small', onclick: keepConsistent }, icon('sparkle'), `Keep ${d.title} consistent everywhere`) : '';
  return h('div', { class: `chr-look${locked ? ' locked' : ''}` },
    h('div', { class: 'row chr-look-head' }, h('b', {}, 'Their look'), h('span', { class: 'muted small' }, locked ? 'Locked: every shot uses it' : lock ? 'Ready to lock' : 'Not made yet')),
    sheet ? h('img', { class: 'chr-look-sheet', src: fileUrl(sheet), alt: `${d.title}'s sheet` }) : '',
    words,
    C.lookBusy ? h('p', { class: 'working small' }, C.lookBusy) : h('div', { class: 'row' },
      !lock ? h('button', { class: 'primary small', onclick: makeLook, disabled: !hasTool('image.edit') }, icon('sparkle'), 'Make their look') : '',
      lock && !locked ? h('button', { class: 'primary small', onclick: () => lockLook(true), disabled: !sheet }, 'Lock their look') : '',
      lock && !locked ? h('button', { class: 'ghost small', onclick: makeLook }, 'Redo') : '',
      locked ? h('button', { class: 'ghost small', onclick: () => lockLook(false) }, 'Unlock') : ''),
    learn);
}

/** Gen's way to 3D: the front picture cut out, a checked 4-view sheet, mesh.views3d; rigged too when asked. */
async function makeModel(rig) {
  const front = pic('cutout') ?? pic('front');
  if (!front) return toast('They need a front picture first (Make their pictures).');
  const steps = [
    ...(front.role === 'cutout' ? [] : [{ tool: 'image.remove-background', inputs: { image: '$input:0' } }]),
    { tool: 'image.viewsheet', params: { form: D.doc.description.slice(0, 300) || D.doc.title }, inputs: { image: front.role === 'cutout' ? '$input:0' : '$prev:cutout' } },
    { tool: 'mesh.views3d', inputs: { image: '$prev:sheet' } },
    ...(rig ? [{ tool: 'mesh.rig', params: { kind: 'auto' }, inputs: { mesh: '$prev' } }] : []),
  ];
  const q = await quote('asset.make', { steps });
  if (!confirm(`Make ${D.doc.title}'s 3D model${rig ? ' and rig it' : ''}${q ? ` for ${credits(q)}` : ''}? It takes a while.${rig && !toolReady('mesh.rig') ? '\n\nRigging runs on GPU servers that are offline right now: it waits until they\'re back.' : ''}`)) return;
  runJob({ tool: 'asset.make', params: { steps }, inputs: { files: [`asset:${front.asset}`] }, label: `${D.doc.title}: 3D model`, onStart: (job) => D.change((d) => { d.model = { pending: job }; }) })
    .then((done) => { const out = done.outputs.find((o) => o.kind === 'mesh'); D.change((d) => { d.model = out ? { asset: out.asset } : { failed: 'No model came out' }; }, { history: false }); })
    .catch((err) => D.change((d) => { d.model = { failed: plainError(err.message) }; }, { history: false }));
}
/** Rigs the model they have (mesh.rig: a Mixamo-named skeleton for a humanoid). */
async function rigModel() {
  const model = D.doc.model?.asset;
  if (!model) return toast('Give them a 3D model first.');
  const q = await quote('mesh.rig', { kind: 'auto', height: D.doc.height });
  if (!confirm(`Rig ${D.doc.title}'s model${q ? ` for ${credits(q)}` : ''}?${!toolReady('mesh.rig') ? '\n\nRigging runs on GPU servers that are offline right now: it waits until they\'re back.' : ''}`)) return;
  runJob({ tool: 'mesh.rig', params: { kind: 'auto', height: D.doc.height }, inputs: { mesh: `asset:${model}` }, label: `${D.doc.title}: rig`, onStart: (job) => D.change((d) => { d.model = { ...d.model, pending: job }; }) })
    .then((done) => { const out = done.outputs.find((o) => o.title === 'rigged') ?? done.outputs.find((o) => o.kind === 'mesh'); D.change((d) => { d.model = out ? { asset: out.asset } : { asset: model, failed: 'No rig came out' }; }, { history: false }); })
    .catch((err) => D.change((d) => { d.model = { asset: model, failed: plainError(err.message) }; }, { history: false }));
}

const clipName = (words) => (String(words).trim().split(/\s+/).slice(0, 3).join(' ').replace(/[^\w ]/g, '').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ /g, '') || 'Move').slice(0, 32);

/**
 * A new move on their model: from words (motion.from-text), the stock library (a Quaternius clip) or a video
 * (motion.from-video). Each ends by merging the clip into the model they have (blender.character: their clips kept,
 * the new one retargeted), so the model's clip list grows and every stage that casts them can use it.
 */
async function addMove(source) {
  const model = D.doc.model?.asset;
  if (!model) return toast('Give them a rigged 3D model first.');
  if (!D.doc.clips.length && !confirm(`${D.doc.title}'s model has no clips yet: is it rigged? (Rig it first if not.) Go on anyway?`)) return;
  const merge = (name, from) => ({ tool: 'blender.character', params: { ops: [{ op: 'import', file: 0 }, { op: 'retarget', file: 1, name, inPlace: false }, { op: 'export', format: 'glb', title: 'mesh' }] }, inputs: { files: ['$input:0', from] } });
  const go = async (steps, label, extraInputs = []) => {
    const q = await quote('asset.make', { steps });
    const offline = !toolReady('blender.character') ? '\n\nThis runs on GPU servers that are offline right now: it waits until they\'re back.' : '';
    if (!confirm(`${label}${q ? ` for ${credits(q)}` : ''}?${offline}`)) return;
    runJob({ tool: 'asset.make', params: { steps }, inputs: { files: [`asset:${model}`, ...extraInputs] }, label: `${D.doc.title}: ${label}`, onStart: (job) => D.change((d) => { d.model = { ...d.model, pending: job }; }) })
      .then((done) => { const out = done.outputs.find((o) => o.kind === 'mesh'); D.change((d) => { d.model = out ? { asset: out.asset } : { asset: model, failed: 'No clip came out' }; }, { history: false }); })
      .catch((err) => D.change((d) => { d.model = { asset: model, failed: plainError(err.message) }; }, { history: false }));
  };
  if (source === 'words') {
    const words = prompt(`Describe ${D.doc.title}'s move as it happens, one sentence (e.g. "A person throws a straight right punch and returns to guard"):`);
    if (!words?.trim()) return;
    const name = clipName(words);
    return go([
      { tool: 'motion.from-text', params: { prompt: words.trim(), seconds: 2, takes: 1 }, inputs: { character: '$input:0' } },
      merge(name, '$prev:glb'),
    ], `Add "${name}" from words`);
  }
  if (source === 'stock') {
    const want = prompt('Which stock move? A word like walk, run, idle, punch, kick, hit, death, jump:');
    if (!want?.trim()) return;
    let clips = [];
    try { clips = (await api(`/v1/assets?tool=motion.library&q=${encodeURIComponent(want.trim())}&limit=12`)).items ?? []; } catch { /* */ }
    if (!clips.length) return toast(`No stock move matches "${want}".`);
    const pick = clips.length === 1 ? clips[0] : clips[Number(prompt(`Pick one:\n${clips.map((c, i) => `${i + 1}. ${c.title}`).join('\n')}`, '1')) - 1];
    if (!pick) return;
    return go([merge(pick.title.replace(/[^\w-]/g, ''), '$input:1')], `Add the stock move "${pick.title}"`, [pick.id]);
  }
  if (source === 'video') {
    libraryPicker('video', (v) => {
      const name = clipName(v.title ?? 'Mocap');
      go([
        { tool: 'motion.from-video', params: { name, camera: 'auto' }, inputs: { video: '$input:1', character: '$input:0' } },
        merge(name, '$prev:glb'),
      ], `Add "${name}" from the video`, [`asset:${v.id}`]);
    });
  }
}

async function stageThem(id = D.scene?.id, title = D.doc?.title) {
  await D.save();
  await newScene('stage', { title: `${title}: shot`, doc: { title: `${title}: shot`, cast: [{ character: id, name: title, position: [0, 0], facing: 0 }], camera: { target: 0, distance: 4, height: 1.5, lens: 50 } } });
}

let mvLoading = null;
function modelViewer(asset) {
  if (!customElements.get('model-viewer') && !mvLoading) { mvLoading = h('script', { type: 'module', src: 'https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js' }); document.head.append(mvLoading); }
  const mv = h('model-viewer', { class: 'chr-model', src: fileUrl(asset), 'camera-controls': true, 'auto-rotate': true, loading: 'eager', 'shadow-intensity': '1', 'environment-image': 'neutral', alt: '3D model' });
  // The model's clips become the character's (a stage picks from them).
  mv.addEventListener('load', () => {
    const names = mv.availableAnimations ?? [];
    if (names.length && JSON.stringify(names) !== JSON.stringify(D.doc.clips.map((c) => c.name))) D.change((d) => { d.clips = names.map((name) => ({ name })); }, { history: false });
  });
  return mv;
}

// ------------------------------------------------------------------ the sheet
function draw() {
  const box = $('#chrWrap');
  if (!box || !D.doc) return;
  const d = D.doc;
  const set = (fn) => D.change(fn);
  const face = mainPic();
  const text = (label, v, fn, rows = 0, ph = '') => {
    const el = rows ? h('textarea', { rows: String(rows), placeholder: ph, 'data-field': label }, v) : h('input', { type: 'text', value: v, placeholder: ph, 'data-field': label });
    el.addEventListener('focus', () => D.change(() => {}, { redraw: false }));
    el.addEventListener('input', () => D.change(() => fn(el.value), { history: false, redraw: false }));
    el.addEventListener('change', () => draw());
    return h('label', { class: 'field' }, label, el);
  };
  const voice = h('select', { onchange: (e) => set((x) => { x.voice = e.target.value || null; }) }, h('option', { value: '' }, 'No voice yet'), ...C.voices.map((v) => h('option', { value: v.id, selected: v.id === d.voice }, `${v.name}${v.about ? ` · ${v.about.split(',').slice(0, 2).join(',')}` : ''}`)));
  const preview = C.voices.find((v) => v.id === d.voice)?.preview;
  const model = d.model?.asset ? modelViewer(d.model.asset) : h('div', { class: 'chr-model empty' }, d.model?.pending ? h('div', { class: 'working' }, 'Making the 3D model…') : h('p', { class: 'muted small' }, d.model?.failed ? `The model failed: ${d.model.failed}` : 'No 3D model yet.'));
  // Whatever redraws the sheet (a save Gen tidied, a picture or model finishing), the field being typed in stays.
  keepingFocus(box, () => box.replaceChildren(h('div', { class: 'chr-sheet' },
    h('div', { class: 'chr-left' },
      h('div', { class: 'chr-face' }, face ? h('img', { src: fileUrl(face.asset), alt: d.title }) : h('div', { class: 'chr-face-empty' }, icon('person', 'ico big'), h('p', { class: 'muted small' }, 'No picture yet'))),
      h('div', { class: 'chr-pics' }, ...d.pictures.map((p) => h('div', { class: `chr-pic${p.pending ? ' pending' : ''}`, title: p.failed ?? '' },
        p.asset ? h('img', { src: fileUrl(p.asset), alt: p.role }) : h('div', { class: 'working small' }, p.pending ? 'Making' : 'Failed'),
        h('select', { onchange: (e) => set((x) => { x.pictures.find((y) => y.id === p.id).role = e.target.value; }) }, ...ROLES.map(([v, l]) => h('option', { value: v, selected: v === p.role }, l))),
        h('button', { class: 'icon-btn small chr-x', title: 'Remove', onclick: () => set((x) => { x.pictures = x.pictures.filter((y) => y.id !== p.id); }) }, icon('close')))),
        h('button', { class: 'chr-add', title: 'A picture from Media', onclick: () => libraryPicker('image', (a) => { set((x) => { x.pictures.push({ role: pic('front') ? 'reference' : 'front', asset: a.id }); }); showFace(); }) }, icon('plus'))),
      h('div', { class: 'row' }, h('button', { class: 'ghost small', onclick: makePictures, disabled: !hasTool('image.generate') }, icon('sparkle'), 'Make their pictures')),
      lookSection(d)),
    h('div', { class: 'chr-right' },
      h('input', { class: 'chr-name', value: d.title, placeholder: 'Their name', 'data-field': 'name', onchange: (e) => { set((x) => { x.title = e.target.value.trim() || x.title; }); } }),
      text('How they look', d.description, (v) => { D.doc.description = v; }, 4, 'Face, build, hair, clothes, colors, era: every tool paints them from these words.'),
      h('div', { class: 'row chr-row' },
        h('label', { class: 'field' }, 'Height', h('span', { class: 'row' }, (() => { const i = h('input', { type: 'number', class: 'num', min: '0.1', max: '30', step: '0.05', value: String(d.height), 'data-field': 'height' }); i.addEventListener('change', () => set((x) => { x.height = Number(i.value) || x.height; })); return i; })(), h('span', { class: 'muted small' }, 'm'))),
        h('label', { class: 'field' }, 'Stand-in color', h('input', { type: 'color', value: d.color, onchange: (e) => set((x) => { x.color = e.target.value; }) })),
        h('label', { class: 'field chr-voice' }, 'Voice', h('span', { class: 'row' }, voice, preview ? h('button', { class: 'icon-btn', title: 'Hear it', onclick: () => { C.preview?.pause(); C.preview = new Audio(preview); C.preview.play().catch(() => {}); } }, icon('play')) : ''))),
      h('div', { class: 'field' }, h('span', {}, '3D model'), model,
        h('div', { class: 'row' },
          h('button', { class: 'ghost small', onclick: () => libraryPicker('mesh', (a) => set((x) => { x.model = { asset: a.id }; })) }, icon('cube'), d.model?.asset ? 'Change' : 'Pick a model'),
          hasTool('mesh.views3d') ? h('button', { class: 'ghost small', onclick: () => makeModel(false), disabled: Boolean(d.model?.pending) }, icon('sparkle'), 'Make the 3D model') : '',
          hasTool('mesh.rig') ? h('button', { class: 'ghost small', onclick: () => makeModel(true), disabled: Boolean(d.model?.pending) }, 'Make it, rigged') : '',
          d.model?.asset ? h('a', { class: 'icon-btn', href: fileUrl(d.model.asset), download: '', title: 'Download the GLB' }, icon('download')) : ''),
        d.model?.asset && !d.model?.pending ? h('div', { class: 'row' },
          hasTool('mesh.rig') && !d.clips.length ? h('button', { class: 'ghost small', onclick: rigModel, title: 'Add a skeleton so it can move' }, 'Rig it') : '',
          hasTool('motion.from-text') ? h('button', { class: 'ghost small', onclick: () => addMove('words'), title: 'A new move from a sentence' }, icon('sparkle'), 'Move from words') : '',
          hasTool('blender.character') ? h('button', { class: 'ghost small', onclick: () => addMove('stock'), title: 'A free stock move (walks, idles, attacks, hits)' }, 'Stock move') : '',
          hasTool('motion.from-video') ? h('button', { class: 'ghost small', onclick: () => addMove('video'), title: 'Their move copied from a video of someone doing it' }, 'Move from a video') : '')
          : d.model?.asset && d.model?.pending ? h('p', { class: 'working small' }, 'Working on their model (a rig or a new move)…') : '',
        d.model?.failed && d.model?.asset ? h('p', { class: 'warn small' }, d.model.failed) : '',
        d.clips.length ? h('p', { class: 'muted small' }, `Clips: ${d.clips.map((c) => c.name).join(', ')}`) : ''),
      text('Notes', d.notes, (v) => { D.doc.notes = v; }, 3, 'Anything to remember: backstory, how they move, what they never wear.'),
      h('div', { class: 'row' }, h('button', { class: 'primary small', onclick: () => stageThem() }, icon('cube'), 'Stage them'),
        h('span', { class: 'muted small' }, 'Or drag them from Scenes onto any stage: every shot they\'re in uses this sheet.'))))));
}
