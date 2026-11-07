// The Create pane (left, beside Media): every tool this Gen has, in groups (images and textures, video, 3D and rigging,
// animation, voice and sound, chains). Each tool's form is drawn from Gen's own description of it
// (GET /v1/editor/catalog: params, inputs, whether it can run now), with a few friendlier controls below (a shape
// instead of width and height, seconds instead of frames, the voice list). A tool Gen adds shows up here by itself,
// under "More". Inputs come from the library (a picker, a dragged tile, what's open in the viewer) or an upload.
// Results go to Media and open in the viewer; pictures, clips and sounds can go straight onto the timeline.

import { $, $$, h, api, toast, fileUrl, bus, icon, plainError, ApiError } from './lib.js';
import { P, trackOf, isMagnetic } from './project.js';
import { currentSource, showSource } from './player.js';
import { runJob, quote, credits, showPane, assetKindLabel } from './media.js';
import { state, needSignIn } from './account.js';

const S = { tools: new Map(), loaded: false, open: null, q: '', group: '', voices: [] };

// ------------------------------------------------------------------ the groups
// Each entry is a tool id with a friendlier name, or a chain (several tools, one after the other, by asset.make).
const GROUPS = [
  { id: 'image', label: 'Images & textures', icon: 'image', tools: [
    ['image.generate', 'Generate an image', 'A new picture from words.'], ['image.edit', 'Edit with words', 'Change a picture by saying what to change.'], ['image.cutout', 'Remove the background', 'Cut the subject out onto a transparent background.'],
    ['image.expand', 'Expand the picture', 'Grow a picture to a new shape and fill in the new space.'], ['image.relight', 'Relight', 'New lighting or time of day.'], ['image.upscale', 'Upscale', 'A bigger, sharper copy.'], ['image.restore', 'Restore and upscale', 'Fix blur and noise while making it bigger.'],
    ['image.angles', 'Multi-angle turnaround', 'The same character from 8 angles.'], ['image.panorama', '360° skybox panorama', 'A seamless 360° environment for a skybox.'], ['image.tile', 'Make it seamless', 'Make a texture tile with no seams.'],
    ['texture.maps', 'PBR material maps', 'Normal, roughness, height and other material maps from a texture.'], ['image.normals', 'Normal map', 'A normal map from a photo or render.'], ['image.depth', 'Depth map', 'A depth map: near is bright, far is dark.'], ['image.albedo', 'Albedo (lighting removed)', 'The base color with the lighting taken out.'],
    ['image.segment', 'Find and mask by words', 'Name something and get a mask of it.'], ['image.layers', 'Split into layers', 'Split a picture into separate layers.'], ['image.paint', 'Paint with references', 'Paint from words, guided by reference pictures.'], ['image.control', 'Paint over a render', 'Paint a finished look over a render, keeping its shapes.'],
    ['image.pose', 'Pose map', 'A stick-figure pose map from a picture.'],
  ] },
  { id: 'video', label: 'Video', icon: 'film', tools: [
    ['video.t2v', 'Text to video', 'A clip from words.'], ['video.i2v', 'Image to video', 'Bring a picture to life: describe the motion.'], ['video.extend', 'Carry a shot on', 'Keep a shot going from its last frame.'], ['video.keyframes', 'Scene through keyframes', 'A scene that passes through the frames you give it.'],
    ['video.animate', 'Character motion transfer', 'A character picture moves like a driving video.'], ['video.motion', 'Motion transfer (Wan Animate)', 'A still character performs the motion of a clip.'], ['video.replace', 'Swap a person', 'Put your character in place of the person in a clip.'],
    ['video.talk', 'Portrait lip-sync', 'A portrait talks along to a voice line.'], ['video.lipsync', 'Lip-sync with motion', 'A character says a line, with head and body motion.'], ['video.perform', 'Character performs a line', 'A character performs a line in their own voice.'],
    ['video.control', 'Depth / pose controlled video', 'A new video that follows a depth or pose video, in the look of a styled first frame.'], ['video.control-wan', 'Controlled video (Wan)', 'The same, with Wan Fun Control.'], ['video.scene', 'Scene from references', 'A scene built from character and set references.'],
    ['video.seedance', 'Scene from references (Seedance)', 'A scene from references on Seedance (paid model).'], ['video.kling', 'Character video (Kling)', 'A character video from references on Kling (paid model).'], ['video.change', 'Change something', 'Change one thing in a clip; the change follows the motion.'],
    ['video.upscale', 'Upscale', 'A sharper, 4× bigger clip.'], ['video.interpolate', 'Smooth motion', 'Add in-between frames for smoother motion.'], ['video.frame', 'Grab a frame', 'Save one frame of a clip as a picture.'], ['video.pose', 'Pose maps from a video', 'Pose maps from every frame of a clip.'],
    ['video.matte', 'Cut to a matte', 'Cut a clip out using a matte video.'], ['video.composite', 'Layered VFX composite', 'Layer effects over a clip with a matte.'], ['video.review', 'Review a video', 'The AI watches and listens, then gives notes.'],
  ] },
  { id: 'mesh', label: '3D & rigging', icon: 'cube', tools: [
    ['image.viewsheet', '4-view sheet for 3D', 'Front, back, left and right views of a character, checked for consistency. The first step to 3D.'], ['mesh.views3d', '4-view sheet → 3D model', 'A textured 3D model (GLB) from a 4-view sheet.'], ['mesh.textured', 'Image → textured 3D model', 'A textured 3D model from one picture of a prop.'],
    ['mesh.from-image', 'Image → 3D shape', 'An untextured 3D shape from one picture.'], ['mesh.from-views', 'Views → 3D model', 'A 3D model from several views.'], ['mesh.rig', 'Auto-rig a 3D model', 'Add a skeleton and skinning to a 3D model so it can move.'],
    ['blender.render', '3D shot render', 'Render a 3D shot, with its depth, pose and edge videos for filming.'], ['blender.character', '3D character pipeline', 'Clean up, retarget, bake and export a 3D character.'], ['image.geometry', 'Depth and normals', 'Depth and normals from one picture.'], ['splat.build', 'Gaussian splat', 'A Gaussian splat scene from a picture.'],
  ] },
  { id: 'motion', label: 'Animation', icon: 'person', tools: [
    ['motion.from-text', 'Text to 3D skeletal motion', 'A humanoid animation from words, on your rigged character.'], ['sprite.sheet', 'Sprite sheet from a clip', 'A clip or frames as a game sprite sheet.'], ['image.pose-detect', 'Detect a pose', 'Find the body pose in a picture.'],
  ] },
  { id: 'audio', label: 'Voice, sound & music', icon: 'music', tools: [
    ['audio.music', 'Music', 'A song or score from a description, with or without lyrics.'], ['audio.voice', 'Character voice', 'Speak a line in a character voice.'], ['audio.voice-design', 'Design a voice', 'Describe a voice and hear candidates.'], ['audio.sfx', 'Sound effect', 'A sound effect from words.'],
    ['audio.dialogue', 'Table read', 'A whole scene of lines, read by a cast.'], ['audio.voice-change', 'Voice changer', 'The same performance in another voice.'], ['audio.revoice', 'Give it a new voice', 'The same words said by a different voice.'], ['audio.voice-clone', 'Clone a voice', 'A voice of your own from a sample.'],
    ['audio.transcribe', 'Write down what is said', 'What is said, written down.'], ['audio.music-loop', 'Seamless music loop', 'A seamless loop, or an intro and a loop.'], ['audio.process', 'Loudness, trim, convert', 'Loudness, trimming, fades and file format.'], ['audio.analyze', 'Check audio', 'Loudness, clipping, silence and loop checks.'],
  ] },
  { id: 'chains', label: 'Chains', icon: 'continue', chains: [
    { id: 'chain.char3d', label: 'Prompt → concept → 4-view → 3D → rigged GLB', about: 'A whole 3D character from words: concept art, a clean cutout, a checked 4-view sheet, a textured model and a humanoid rig.', placeholder: 'A stylized cyber-samurai in an A-pose, clean silhouette',
      steps: (p) => [
        { tool: 'image.generate', params: { prompt: `${p}, full body, front view, A-pose, plain light background` } },
        { tool: 'image.remove-background', inputs: { image: '$prev' } },
        { tool: 'image.viewsheet', params: { form: p }, inputs: { image: '$prev:cutout' } },
        { tool: 'mesh.views3d', inputs: { image: '$prev:sheet' } },
        { tool: 'mesh.rig', params: { kind: 'auto' }, inputs: { mesh: '$prev' } },
      ] },
    { id: 'chain.pbr', label: 'Prompt → seamless texture → PBR maps', about: 'A tileable texture from words, then its material maps (normal, roughness, height and more).', placeholder: 'Worn steel grating with a little rust, top-down',
      steps: (p) => [{ tool: 'image.generate', params: { prompt: p, seamless: true } }, { tool: 'texture.maps', inputs: { image: '$prev' } }] },
    { id: 'chain.sprite', label: 'Prompt → character → clean cutout', about: 'A game character or prop from words, cut out onto a transparent background.', placeholder: 'A hellhound boss, side view facing right, crisp silhouette',
      steps: (p) => [{ tool: 'image.generate', params: { prompt: p } }, { tool: 'image.remove-background', inputs: { image: '$prev' } }] },
  ] },
];
const CURATED = new Map(GROUPS.flatMap((g) => (g.tools ?? []).map(([id, label, about]) => [id, { label, about, group: g.id }])));
// The open models' twins and the GPU background remover are reached through their main tools.
// image.repaint takes a painted mask (the viewer's Repaint area); asset.make is what the chains run.
const HIDDEN = /(-open$|^image\.remove-background$|^image\.repaint$|^asset\.make$|^image\.character$|^image\.transform$|^image\.sheet$|^audio\.voice-design-open$)/;

// Params every form keeps under "More settings", and ones it never shows (the app sets them).
const ADVANCED = new Set(['seed', 'count', 'denoise', 'fps', 'frames', 'width', 'height', 'openModel', 'direction', 'verify', 'normalize', 'trim', 'variants', 'feather', 'threshold', 'influence', 'strength', 'texture_resolution', 'enable_lightning_lora', 'lightning_lora', 'enable_distill_lora', 'full', 'replacement_mode', 'longer_size', 'cell', 'retries', 'straighten', 'method', 'detail', 'faces', 'texture', 'size', 'names', 'facing', 'keepTextures', 'isolate']);
const NEVER = new Set(['provider', 'nodes']);
// Voices, voice design and sound effects run on Gen's own models; changing a voice is ElevenLabs only (see AGENTS.md).
const FIXED = { 'audio.voice-change': { provider: 'elevenlabs' } };
const WORDS = { prompt: 'Prompt', text: 'Text', lyrics: 'Lyrics (blank for instrumental)', seconds: 'Seconds', duration: 'Seconds', description: 'Description', form: 'What it is', look: 'What it looks like', aspect: 'Shape', at: 'At (seconds, "first" or "last")', kind: 'Kind', multiplier: 'Frames between frames', loop: 'Loop', allowSingleView: 'Allow one view (props and blockouts)', voice: 'Voice', bpm: 'Beats per minute', resize: 'Scale', mode: 'Mode', format: 'Format', name: 'Name', brief: 'What to check', focus: 'Focus', language: 'Language' };
const words = (name) => WORDS[name] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
const KIND_LABEL = { image: 'Image', video: 'Video', audio: 'Audio', file: 'File' };
// What a library asset kind can fill: a "file" input takes a 3D model or anything else.
const fits = (inputKind, assetKind) => inputKind === 'file' || inputKind === assetKind;

/** The shape chips: sizes each tool family likes, for the project's shape by default. */
const SHAPES = { image: { wide: [1344, 768], tall: [768, 1344], square: [1024, 1024] }, video: { wide: [832, 480], tall: [480, 832], square: [640, 640] } };
const projectShape = () => { const ar = P.doc.width / P.doc.height; return ar > 1.2 ? 'wide' : ar < 0.83 ? 'tall' : 'square'; };
const STYLES = [
  ['', 'Any'], ['photograph, natural light, sharp focus, high detail', 'Photo'], ['cinematic film still, dramatic lighting, anamorphic, color graded', 'Cinematic'],
  ['digital illustration, clean lines, rich color', 'Illustration'], ['anime style, cel shading, vibrant', 'Anime'], ['3D render, soft studio lighting, high detail', '3D'],
  ['pixel art, 16-bit, crisp pixels, limited palette', 'Pixel'], ['watercolor painting, soft washes, paper texture', 'Watercolor'],
];
// Results that land on the timeline when asked: which track, and from where.
const TIMELINE = {
  'image.generate': { track: 'V1', seconds: 3 }, 'video.t2v': { track: 'V1', on: true }, 'video.i2v': { track: 'V1' }, 'video.extend': { track: 'V1' },
  'audio.music': { track: 'A1', start: 0, on: true }, 'audio.voice': { track: 'A2', on: true }, 'audio.sfx': { track: 'A3', on: true },
};

export function initStudio() {
  $('#createSearch').addEventListener('input', (e) => { S.q = e.target.value.trim().toLowerCase(); drawList(); });
  $('#createBack').addEventListener('click', () => closeTool());
  bus.on('ready', loadCatalog);
  bus.on('signedIn', loadCatalog);
  bus.on('useIn', ({ tool, asset }) => { showPane('generate'); openTool(tool, { prefill: asset }); });
  loadCatalog();
}

async function loadCatalog() {
  // No session, no catalog (it answers 401): the list shows its sign-in note without asking.
  if (!state.user) { S.loaded = 'signedOut'; drawGroups(); drawList(); return; }
  try {
    const { tools } = await api('/v1/editor/catalog');
    S.tools = new Map(tools.map((t) => [t.id, t]));
    S.loaded = true;
  } catch (err) {
    S.loaded = err.status === 401 ? 'signedOut' : 'error';
  }
  try { if (state.user && !S.voices.length) S.voices = (await api('/v1/editor/voices')).voices ?? []; } catch { /* */ }
  drawGroups();
  drawList();
}

/** Every tool that takes this kind of file, for the viewer's "Use in…" menu. */
export function toolsTaking(kind) {
  const out = [];
  // A tool takes it when it fits a required input or the tool's first one (not, say, an optional mask); a "file" input
  // takes 3D models and other files, never pictures, clips or sounds.
  const takes = (i) => (i.kind === 'file' ? !['image', 'video', 'audio'].includes(kind) : i.kind === kind);
  const order = [...CURATED.keys()];
  for (const [id, t] of S.tools) {
    if (HIDDEN.test(id)) continue;
    const ins = Object.values(t.inputs ?? {});
    if (ins.some((i, n) => (i.required || n === 0) && takes(i))) out.push({ id, label: CURATED.get(id)?.label ?? t.title ?? id });
  }
  const rank = (id) => { const n = order.indexOf(id); return n < 0 ? 1e6 : n; };
  return out.sort((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label));
}

// ------------------------------------------------------------------ the list
function drawGroups() {
  const box = $('#createGroups');
  const chip = (id, label) => h('button', { type: 'button', class: `chip${S.group === id ? ' on' : ''}`, onclick: () => { S.group = id; drawGroups(); drawList(); } }, label);
  box.replaceChildren(chip('', 'All'), ...GROUPS.map((g) => chip(g.id, g.label.split(' ')[0].replace(',', ''))), more().length ? chip('more', 'More') : '');
}
/** Tools Gen has that no group names: new ones show up here without a change to the app. */
const more = () => [...S.tools.values()].filter((t) => !CURATED.has(t.id) && !HIDDEN.test(t.id));

function drawList() {
  const list = $('#createList');
  if (S.open) return;
  if (S.loaded === 'signedOut' || !state.user) {
    list.replaceChildren(h('div', { class: 'empty-note' }, h('p', {}, 'Images, video, 3D models, rigs, voices, sound and music: every tool, here.'), h('button', { class: 'primary small', onclick: () => needSignIn(loadCatalog, 'login') }, 'Sign in')));
    return;
  }
  if (S.loaded === 'error') { list.replaceChildren(h('div', { class: 'empty-note' }, h('p', {}, 'Couldn\'t load the tools.'), h('button', { class: 'ghost small', onclick: loadCatalog }, 'Try again'))); return; }
  if (!S.loaded) { list.replaceChildren(h('div', { class: 'working' }, 'Loading tools')); return; }
  const match = (label, t) => !S.q || `${label} ${t?.id ?? ''} ${t?.description ?? ''}`.toLowerCase().includes(S.q);
  const sections = [];
  // The director first: the way in on a phone (the bar's button is hidden there), and the most powerful thing here.
  if (!S.group && (!S.q || 'director direct shot scene 3d camera film dialogue'.includes(S.q))) sections.push(h('button', { type: 'button', class: 'cat-row director-row', onclick: () => import('./director.js').then((d) => d.openDirector()) },
    icon('film'), h('span', { class: 'cat-txt' }, h('b', {}, 'Direct a shot or a scene'), h('span', { class: 'muted' }, 'Stage it in 3D with the AI director: cast, camera, dialogue. Then film it.'))));
  for (const g of GROUPS) {
    if (S.group && S.group !== g.id) continue;
    const rows = g.chains
      ? g.chains.filter((c) => match(`${c.label} ${c.about}`)).map((c) => row(c.id, c.label, c.about, 'continue', true))
      : g.tools.filter(([id, label, about]) => S.tools.has(id) && match(`${label} ${about}`, S.tools.get(id))).map(([id, label, about]) => row(id, label, about ?? S.tools.get(id).description, g.icon, S.tools.get(id).ready));
    if (rows.length) sections.push(h('div', { class: 'cat' }, h('h3', {}, g.label), ...rows));
  }
  if (!S.group || S.group === 'more') {
    const rows = more().filter((t) => match(t.title ?? t.id, t)).map((t) => row(t.id, t.title ?? t.id, t.description, 'sparkle', t.ready));
    if (rows.length) sections.push(h('div', { class: 'cat' }, h('h3', {}, 'More'), ...rows));
  }
  list.replaceChildren(...(sections.length ? sections : [h('div', { class: 'empty-note' }, h('p', {}, 'No tool matches.'))]));
}
function row(id, label, about, ic, ready) {
  return h('button', { type: 'button', class: `cat-row${ready ? '' : ' off'}`, title: about ?? '', onclick: () => openTool(id) },
    icon(ic), h('span', { class: 'cat-txt' }, h('b', {}, label), h('span', { class: 'muted' }, firstSentence(about))), ready ? '' : h('span', { class: 'badge-off' }, 'Offline'));
}
const firstSentence = (s) => { const t = String(s ?? '').split(/(?<=[.!?])\s/)[0]; return t.length > 90 ? `${t.slice(0, 88)}…` : t; };

// ------------------------------------------------------------------ one tool
function closeTool() {
  S.open = null;
  $('#createTool').hidden = true;
  $('#createHome').hidden = false;
  drawList();
}

/** Opens a tool's form. `prefill`: a library file to put in the first input that takes it. */
export function openTool(id, { prefill, nodes } = {}) {
  if (!state.user) return needSignIn(() => openTool(id, { prefill }), 'login');
  const chain = GROUPS.flatMap((g) => g.chains ?? []).find((c) => c.id === id);
  const t = chain ? null : S.tools.get(id);
  if (!chain && !t) { toast('That tool isn\'t on this Gen.'); return; }
  S.open = id;
  $('#createHome').hidden = true;
  $('#createTool').hidden = false;
  const form = chain ? chainForm(chain) : toolForm(t, prefill ?? sourceAsset(), nodes);
  $('#createBody').replaceChildren(form);
  form.querySelector('textarea, input[type=text]')?.focus();
}
const sourceAsset = () => { const s = currentSource(); return s ? { id: s.id, kind: s.kind, title: s.title } : null; };

function head(label, about, ready = true) {
  return [h('div', { class: 'gen-head' }, h('b', {}, label)), about ? h('p', { class: 'muted small tool-about' }, about) : '',
    ready ? '' : h('p', { class: 'warn small' }, 'This tool runs on GPU servers that are offline right now. You can still queue it; it starts when they\'re back.')];
}

function chainForm(c) {
  const p = h('textarea', { rows: '3', maxlength: '1500', placeholder: c.placeholder });
  const q = h('span', { class: 'quote' });
  const run = h('button', { class: 'primary small' }, icon('sparkle'), 'Make it');
  const form = h('form', { class: 'gen-card tool-form' }, ...head(c.label, c.about), h('label', { class: 'field' }, 'Prompt', p),
    h('ol', { class: 'chain-steps muted small' }, ...c.steps('…').map((s) => h('li', {}, CURATED.get(s.tool)?.label ?? S.tools.get(s.tool)?.title ?? s.tool))),
    h('div', { class: 'gen-foot' }, q, run));
  const spec = () => ({ tool: 'asset.make', params: { steps: c.steps(p.value.trim() || 'x') } });
  priced(form, q, spec);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!p.value.trim()) return toast('Say what to make.');
    go({ ...spec(), label: `${c.label.split(' → ').pop()}: ${p.value.trim().slice(0, 60)}` }, form);
  });
  return form;
}

function toolForm(t, prefill, prefillNodes) {
  const params = Object.entries(t.params ?? {}).filter(([k]) => !NEVER.has(k) && !(FIXED[t.id] && k in FIXED[t.id]));
  const hasShape = params.some(([k]) => k === 'width') && params.some(([k]) => k === 'height') && !Object.keys(t.inputs ?? {}).length;
  const hasFrames = params.some(([k]) => k === 'frames');
  const main = [], adv = [], get = {};
  // Inputs first: what the tool works on.
  // The file open in the viewer (or the one "Use in…" named) fills the first input that takes it.
  let unused = prefill;
  const slots = Object.entries(t.inputs ?? {}).map(([name, spec]) => {
    const fill = unused && fits(spec.kind, unused.kind) ? unused : null;
    if (fill) unused = null;
    return inputSlot(name, spec, fill);
  });
  for (const [k, spec] of params) {
    if (hasShape && (k === 'width' || k === 'height')) continue;
    if (hasFrames && k === 'frames') continue;
    const ctl = control(t.id, k, spec);
    if (!ctl) continue;
    get[k] = ctl.get;
    (spec.advanced || ADVANCED.has(k) || (k === 'description' && t.id === 'audio.voice') || (!spec.required && k !== 'prompt' && k !== 'text' && params.length > 6 && !['seconds', 'duration', 'aspect', 'lyrics', 'voice', 'kind', 'look', 'form', 'description', 'allowSingleView', 'at'].includes(k)) ? adv : main).push(ctl.el);
  }
  let shape = projectShape();
  let style = '';
  const extras = [];
  if (hasShape) {
    const fam = t.id.startsWith('video.') ? 'video' : 'image';
    extras.push(h('div', { class: 'field' }, 'Shape', h('div', { class: 'chips' }, ...['wide', 'tall', 'square'].map((s) => h('button', { type: 'button', class: `chip${s === shape ? ' on' : ''}`, onclick: (e) => { shape = s; $$('.chip', e.currentTarget.parentNode).forEach((x) => x.classList.toggle('on', x === e.currentTarget)); e.currentTarget.dispatchEvent(new Event('input', { bubbles: true })); } }, s === 'wide' ? 'Wide' : s === 'tall' ? 'Tall' : 'Square')))));
    get.width = () => SHAPES[fam][shape][0];
    get.height = () => SHAPES[fam][shape][1];
  }
  if (t.id === 'image.generate') {
    extras.push(h('div', { class: 'field' }, 'Style', h('div', { class: 'chips' }, ...STYLES.map(([w, label]) => h('button', { type: 'button', class: `chip${w === style ? ' on' : ''}`, onclick: (e) => { style = w; $$('.chip', e.currentTarget.parentNode).forEach((x) => x.classList.toggle('on', x === e.currentTarget)); } }, label)))));
  }
  let secondsSel = null;
  if (hasFrames) {
    secondsSel = h('select', {}, ...[2, 3, 5, 8].map((s) => h('option', { value: String(s), selected: s === 3 }, `${s} seconds`)));
    main.push(h('label', { class: 'field' }, 'Length', secondsSel));
  }
  const craft = craftDrawer(t.id, prefillNodes);
  const tl = TIMELINE[t.id];
  const toTl = tl ? h('input', { type: 'checkbox', checked: Boolean(tl.on) }) : null;
  const q = h('span', { class: 'quote' });
  // A job made in a world takes the world's look (src/worlds.ts); this leaves it out for this one job.
  const worldLook = h('input', { type: 'checkbox', checked: true });
  const run = h('button', { class: 'primary small' }, icon('sparkle'), 'Run');
  const result = h('div', { class: 'tool-result' });
  const form = h('form', { class: 'gen-card tool-form' }, ...head(CURATED.get(t.id)?.label ?? t.title ?? t.id, CURATED.get(t.id)?.about ?? t.description, t.ready),
    ...slots.map((s) => s.el), ...main, ...extras,
    h('details', { class: 'more' }, h('summary', {}, 'More settings'), ...adv, h('label', { class: 'check', title: 'When the scene in front belongs to a world, its style line, palette and style board are added' }, worldLook, "Use the world's look")),
    craft.el,
    h('div', { class: 'gen-foot' }, toTl ? h('label', { class: 'check' }, toTl, 'Add to timeline') : '', q, run), result);

  const build = (forQuote = false) => {
    const nodes = craft.nodes();
    const p = { ...(FIXED[t.id] ?? {}) };
    for (const [k, fn] of Object.entries(get)) { const v = fn(); if (v !== undefined && v !== '') p[k] = v; }
    if (nodes) p.nodes = nodes;
    if (style && p.prompt) p.prompt = `${p.prompt}, ${style}`;
    if (t.id === 'image.generate' && p.seed == null) p.seed = Math.floor(Math.random() * 2 ** 31);
    if (hasFrames) {
      const fps = Number(p.fps ?? t.params.fps?.default ?? 16);
      p.frames = Math.min(Number(t.params.frames?.max ?? 161), Math.round((Number(secondsSel.value) * fps) / 4) * 4 + 1);
      if (t.params.fps && p.fps == null) p.fps = fps;
    }
    const inputs = {};
    for (const s of slots) { const v = s.value(); if (v) inputs[s.name] = v; else if (s.required && !forQuote) throw new Error(`Pick ${s.label.toLowerCase()} first.`); }
    for (const [k, spec] of params) if (spec.required && (p[k] == null || p[k] === '') && !forQuote) throw new Error(`Fill in ${words(k).toLowerCase()} first.`);
    return { tool: t.id, params: p, inputs };
  };
  priced(form, q, () => { try { return build(true); } catch { return null; } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let spec;
    try { spec = build(); } catch (err) { return toast(err.message); }
    const label = String(spec.params.prompt ?? spec.params.text ?? spec.params.description ?? CURATED.get(t.id)?.label ?? t.title).slice(0, 80);
    const into = trackOf(P.selection.track) && !trackOf(P.selection.track).locked ? P.selection.track : tl.track;
    const place = toTl?.checked ? { track: into, start: tl.start ?? (isMagnetic(into) ? undefined : P.playhead), seconds: tl.seconds ?? spec.params.seconds ?? spec.params.duration ?? (hasFrames ? Number(secondsSel.value) : 5) } : null;
    go({ ...spec, label, place, ...(worldLook.checked ? {} : { labels: { world: 'off' } }) }, form, result);
  });
  return form;
}

/**
 * Prices the form as it changes: a price is on screen the moment the form opens ("Pricing…", then the credits, or
 * "Free"), and again after each change to an option (the latest answer wins). If the quote can't be had it says the
 * price is shown before anything is charged, never a blank.
 */
function priced(form, q, specOf) {
  let timer = 0, seq = 0;
  q.classList.add('quote');
  q.setAttribute('aria-live', 'polite');
  const show = (text, price = null) => { q.textContent = text; q.dataset.credits = price == null ? '' : String(price); };
  const refresh = async () => {
    const s = specOf();
    if (!s) return show('Price shown once the form is filled in');
    const mine = ++seq;
    if (!q.dataset.credits) show('Pricing…');
    const r = await quote(s.tool, s.params);
    if (mine !== seq) return;
    if (!r) return show('Price shown before it runs');
    show(r.credits === 0 ? 'Free' : credits(r), r.credits);
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 350); };
  form.addEventListener('input', later);
  form.addEventListener('change', later);
  refresh();
}

/** Runs it; the finished file opens in the viewer, and text answers show under the form. */
function go(spec, form, result) {
  const btn = form.querySelector('.gen-foot .primary');
  btn.disabled = true;
  setTimeout(() => { btn.disabled = false; }, 1200);
  toast('Started. It shows in Media while it works.');
  runJob(spec).then((done) => {
    // The file to show: a cutout over its mask, anything over a mask (image.remove-background returns [mask, cutout]).
    const outs = done.outputs ?? [];
    const out = outs.find((o) => o.title === 'cutout') ?? outs.find((o) => !/mask/i.test(o.title ?? '')) ?? outs[0];
    if (result && done.result != null && !out) {
      const text = typeof done.result === 'string' ? done.result : JSON.stringify(done.result, null, 2);
      result.replaceChildren(h('pre', {}, text.slice(0, 6000)));
    }
    if (out && !spec.place) {
      showSource({ id: out.asset, kind: out.kind, title: spec.label });
      // On a phone the viewer is its own tab: go there to show it.
      if (getComputedStyle($('#mobileTabs')).display !== 'none') $('#mobileTabs button[data-m=edit]')?.click();
    }
    toast(`Done: ${spec.label}`);
  }).catch(() => {});
}

// ------------------------------------------------------------------ how it works (src/knowledge.ts)
/**
 * The drawer under a tool's form, closed until asked: what the tool is for, what to change when a result is wrong, the
 * models it loads, what it pairs with, and every setting on its ComfyUI nodes (changed ones go to the job as `nodes`).
 * `prefill`: node settings to start from (Make another with tweaks).
 */
export function craftDrawer(id, prefill = null) {
  const changed = { ...(prefill ?? {}) };
  const body = h('div', { class: 'craft' }, h('div', { class: 'working' }, 'Loading'));
  const el = h('details', { class: 'more craft-drawer' }, h('summary', {}, state.admin ? 'How it works · every setting' : 'How it works', Object.keys(changed).length ? h('span', { class: 'badge-on' }, `${Object.keys(changed).length} changed`) : ''), body);
  let loaded = false;
  el.addEventListener('toggle', async () => {
    if (!el.open || loaded) return;
    loaded = true;
    try { drawCraft(body, await api(`/v1/knowledge/tools/${id}`), changed, el); } catch (err) { body.replaceChildren(h('p', { class: 'muted small' }, plainError(err.message))); }
  });
  if (Object.keys(changed).length) el.open = true, el.dispatchEvent(new Event('toggle'));
  return { el, nodes: () => (Object.keys(changed).length ? { ...changed } : null) };
}

function drawCraft(body, c, changed, drawer) {
  const sec = (title, ...kids) => h('div', { class: 'craft-sec' }, h('b', {}, title), ...kids);
  const notes = Object.entries(c.params ?? {}).filter(([, p]) => p.note).map(([k, p]) => h('li', {}, h('code', {}, k), ' ', p.note));
  const inNotes = Object.entries(c.inputs ?? {}).filter(([, i]) => i.note).map(([k, i]) => h('li', {}, h('code', {}, k), ' ', i.note));
  const mark = () => { const n = Object.keys(changed).length; const sum = drawer.querySelector('summary'); sum.querySelector('.badge-on')?.remove(); if (n) sum.append(h('span', { class: 'badge-on' }, `${n} changed`)); drawer.dispatchEvent(new Event('input', { bubbles: true })); };
  const nodeRows = (c.nodes ?? []).filter((nd) => nd.settings.some((x) => x.editable || x.drivenBy)).map((nd) => {
    const rows = nd.settings.map((st) => {
      if (!st.editable) return h('div', { class: 'craft-set off', title: st.drivenBy ? `Set by ${st.drivenBy.replace(/^input:/, 'the input ')} above` : 'Locked' }, h('span', {}, st.input), h('span', { class: 'muted small' }, st.drivenBy ? `↳ ${st.drivenBy.replace(/^input:/, '')}` : String(st.value)));
      const cur = changed[st.key] ?? st.value;
      const set = (v) => { if (v === st.value || v === '' || v == null || (typeof v === 'number' && !Number.isFinite(v))) delete changed[st.key]; else changed[st.key] = v; ctl.classList.toggle('changed', st.key in changed); mark(); };
      const ctl = st.type === 'boolean' ? h('input', { type: 'checkbox', checked: Boolean(cur) }) : h('input', { type: st.type === 'number' ? 'number' : 'text', step: 'any', value: String(cur), class: st.type === 'number' ? 'num' : '' });
      ctl.classList.toggle('changed', st.key in changed);
      ctl.addEventListener('change', () => set(st.type === 'boolean' ? ctl.checked : st.type === 'number' ? Number(ctl.value) : ctl.value.trim()));
      return h('label', { class: 'craft-set', title: st.note ?? '' }, h('span', {}, st.input, st.note ? h('span', { class: 'req' }, ' •') : ''), ctl);
    });
    return h('details', { class: 'craft-node' }, h('summary', {}, h('span', {}, nd.title), h('span', { class: 'muted small' }, nd.class)), ...rows);
  });
  body.replaceChildren(
    c.role ? h('p', { class: 'small' }, c.role) : '',
    c.measured === false ? h('p', { class: 'muted small' }, 'These notes are starting points: not measured on the GPU yet.') : '',
    inNotes.length ? sec('What goes in', h('ul', {}, ...inNotes)) : '',
    notes.length ? sec('The settings that matter', h('ul', {}, ...notes)) : '',
    c.iterate?.length ? sec('When it\'s not right', h('ul', {}, ...c.iterate.map((x) => h('li', {}, x)))) : '',
    c.pairsWith?.length ? sec('Goes well with', h('div', { class: 'chips' }, ...c.pairsWith.map((x) => h('button', { type: 'button', class: 'chip small', onclick: () => openTool(x) }, CURATED.get(x)?.label ?? x)))) : '',
    state.admin && c.models?.length ? sec('Models', h('ul', { class: 'mono small' }, ...c.models.map((m) => h('li', {}, `${m.dir}/${m.file}`)))) : '',
    state.admin && nodeRows.length ? sec(`Every node (${c.editable} settings you can change)`, h('p', { class: 'muted small' }, 'The graph this tool runs. Changed settings go with this job only.'), ...nodeRows,
      h('button', { type: 'button', class: 'link small', onclick: () => { for (const k of Object.keys(changed)) delete changed[k]; drawCraft(body, c, changed, drawer); mark(); } }, 'Reset every node setting')) : '',
    state.admin && c.source ? h('p', { class: 'muted small' }, `From: ${typeof c.source === 'string' ? c.source : c.source.template ?? c.source.name ?? 'an imported workflow'}`) : '',
  );
}

// ------------------------------------------------------------------ controls
function control(tool, k, spec) {
  const label = words(k);
  const tip = spec.description ?? '';
  const wrap = (el) => h('label', { class: 'field', title: tip }, spec.required ? h('span', {}, label, h('span', { class: 'req' }, ' *')) : label, el);
  if (tool.startsWith('audio.voice') && k === 'voice' && S.voices.length) {
    const sel = h('select', {}, ...S.voices.map((v) => h('option', { value: v.id, title: v.about }, `${v.name}${v.about ? ` · ${v.about.split(',').slice(0, 2).join(',')}` : ''}`)));
    return { el: wrap(sel), get: () => sel.value };
  }
  if (spec.type === 'boolean') {
    const cb = h('input', { type: 'checkbox', checked: Boolean(spec.default) });
    return { el: h('label', { class: 'check field-check', title: tip }, cb, label), get: () => (cb.checked === Boolean(spec.default) && spec.default === undefined ? undefined : cb.checked) };
  }
  if (spec.type === 'enum') {
    const sel = h('select', {}, spec.required ? '' : h('option', { value: '' }, spec.default != null ? `Default (${spec.default})` : 'Default'), ...(spec.values ?? []).map((v) => h('option', { value: v }, v)));
    if (spec.required && spec.default != null) sel.value = String(spec.default);
    return { el: wrap(sel), get: () => sel.value || undefined };
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    const inp = h('input', { type: 'number', class: 'num', step: spec.type === 'integer' ? '1' : 'any', ...(spec.min != null ? { min: String(spec.min) } : {}), ...(spec.max != null ? { max: String(spec.max) } : {}), placeholder: spec.default != null ? String(spec.default) : 'auto' });
    return { el: wrap(inp), get: () => (inp.value === '' ? undefined : Number(inp.value)) };
  }
  if (spec.type === 'json') {
    const ta = h('textarea', { rows: '4', class: 'mono', placeholder: spec.example != null ? JSON.stringify(spec.example) : 'JSON' });
    return { el: wrap(ta), get: () => { const s = ta.value.trim(); if (!s) return undefined; try { return JSON.parse(s); } catch { if (spec.orString) return s; throw new Error(`${label} isn't valid JSON.`); } } };
  }
  const long = spec.type === 'text';
  const el = long ? h('textarea', { rows: k === 'lyrics' ? '4' : '3', maxlength: '4000', placeholder: spec.example != null ? String(spec.example) : '' }) : h('input', { type: 'text', maxlength: '500', placeholder: spec.example != null ? String(spec.example) : spec.default != null ? String(spec.default) : '' });
  return { el: wrap(el), get: () => el.value.trim() || undefined };
}

/** One input: library files of the right kind, dropped tiles or an upload; several when the tool takes a list. */
function inputSlot(name, spec, prefill) {
  const picked = prefill ? [prefill] : [];
  const label = words(name === 'start' ? 'start frame' : name);
  const box = h('div', { class: 'slot-files' });
  const draw = () => {
    box.replaceChildren(...picked.map((a, i) => h('div', { class: 'slot-file', title: a.title ?? '' }, thumbOf(a),
      h('button', { type: 'button', class: 'slot-x', title: 'Remove', onclick: () => { picked.splice(i, 1); draw(); el.dispatchEvent(new Event('input', { bubbles: true })); } }, icon('close')))),
    (spec.multiple || !picked.length) ? h('button', { type: 'button', class: 'slot-add', onclick: () => pick() }, icon('plus'), h('span', {}, picked.length ? 'Add' : `Pick ${KIND_LABEL[spec.kind]?.toLowerCase() ?? 'a file'}`)) : '');
  };
  const add = (a) => { if (!fits(spec.kind, a.kind)) return toast(`${label} takes ${KIND_LABEL[spec.kind]?.toLowerCase() ?? 'a file'}.`); if (!spec.multiple) picked.length = 0; picked.push(a); draw(); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const pick = () => libraryPicker(spec.kind, add);
  const el = h('div', { class: 'field slot' }, h('span', {}, label, spec.required ? h('span', { class: 'req' }, ' *') : '', h('span', { class: 'muted small' }, ` · ${KIND_LABEL[spec.kind] ?? 'File'}${spec.multiple ? 's' : ''}`)), box);
  el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('application/x-hg-asset')) { e.preventDefault(); el.classList.add('over'); } });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { const raw = e.dataTransfer.getData('application/x-hg-asset'); if (!raw) return; e.preventDefault(); e.stopPropagation(); el.classList.remove('over'); add(JSON.parse(raw)); });
  draw();
  return { el, name, label, required: Boolean(spec.required), value: () => (picked.length ? (spec.multiple ? picked.map((a) => `asset:${a.id}`) : `asset:${picked[0].id}`) : null) };
}
const thumbOf = (a) => (a.kind === 'image' ? h('img', { src: fileUrl(a.id), alt: '' }) : a.kind === 'video' ? h('video', { src: `${fileUrl(a.id)}#t=0.1`, muted: true, preload: 'metadata' }) : h('span', { class: 'slot-ico' }, icon(a.kind === 'audio' ? 'music' : a.kind === 'mesh' ? 'cube' : 'folder'), h('span', {}, (a.title ?? assetKindLabel(a.kind)).slice(0, 18))));

/** A pop-over of the library's files of one kind, plus Upload. */
export function libraryPicker(kind, onPick) {
  const grid = h('div', { class: 'pick-grid' }, h('p', { class: 'muted small' }, 'Loading…'));
  const up = h('input', { type: 'file', hidden: true, accept: kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : kind === 'audio' ? 'audio/*' : '' });
  const pop = h('div', { class: 'picker' }, h('div', { class: 'sheet-head' }, h('b', {}, `Pick ${KIND_LABEL[kind]?.toLowerCase() ?? 'a file'}`), h('button', { type: 'button', class: 'icon-btn', onclick: () => pop.remove() }, icon('close'))), grid,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost small', onclick: () => up.click() }, icon('upload'), 'Upload'), up));
  document.body.append(pop);
  up.addEventListener('change', async () => {
    const f = up.files?.[0];
    if (!f) return;
    grid.replaceChildren(h('div', { class: 'working' }, 'Uploading'));
    try {
      const r = await fetch(`/v1/assets?project=${encodeURIComponent(state.user.project)}&title=${encodeURIComponent(f.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': f.name }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status);
      onPick({ id: j.id ?? j.asset?.id, kind: j.kind ?? kind, title: f.name });
      bus.emit('jobDone');
      pop.remove();
    } catch (err) { toast(plainError(err.message)); pop.remove(); }
  });
  const q = new URLSearchParams({ limit: '80', project: state.user.project });
  if (kind && kind !== 'file') q.set('kind', kind);
  api(`/v1/assets?${q}`).then((r) => {
    const items = (r.items ?? []).filter((a) => (kind ? kind !== 'file' || !['image', 'video', 'audio'].includes(a.kind) : ['image', 'video', 'audio'].includes(a.kind)));
    grid.replaceChildren(...items.map((a) => h('button', { type: 'button', class: 'pick', title: a.title ?? a.recipe?.params?.prompt ?? '', onclick: () => { onPick({ id: a.id, kind: a.kind, title: a.title ?? a.recipe?.params?.prompt ?? '' }); pop.remove(); } }, thumbOf({ id: a.id, kind: a.kind, title: a.title }))));
    if (!items.length) grid.replaceChildren(h('p', { class: 'muted small' }, 'Nothing of that kind yet. Upload one or make one.'));
  }).catch(() => grid.replaceChildren(h('p', { class: 'muted small' }, 'Couldn\'t load your library.')));
}

/** Every tool Create offers, as people see them (the command palette lists them). */
export const createTools = () => [...S.tools.values()].filter((t) => CURATED.has(t.id) || !HIDDEN.test(t.id)).map((t) => ({ id: t.id, label: CURATED.get(t.id)?.label ?? t.title ?? t.id, about: CURATED.get(t.id)?.about ?? '' }));

/** Whether this Gen has a tool and can run it now (false while its GPU servers are offline). */
export const toolReady = (id) => Boolean(S.tools.get(id)?.ready);
export const hasTool = (id) => S.tools.has(id);
