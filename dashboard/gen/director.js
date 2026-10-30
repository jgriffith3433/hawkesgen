// The director (src/director.ts): design one shot as a small 3D scene and film it. The stage (three.js, loaded the
// first time) plays the shot in the viewer: the cast (3D models from the library, or stand-ins of the right height),
// props, the set, and the camera with its move. Drag people and props on the ground; look through the shot's camera or
// fly around it. The Shot tab on the left edits everything; the AI on the right (in director mode) writes and changes
// the shot. "Film it" records the shot's depth video and first frame here, then Gen paints the first frame in the look
// (image.control) and films the depth video from it (video.control). "Blender" sends the same shot to Gen's Blender
// film pipeline when its servers are up.

import { $, $$, h, api, toast, fileUrl, fmt, bus, icon, plainError, ApiError } from './lib.js';
import { runJob, waitJob, quote, credits, showPane, placeAsset } from './media.js';
import { libraryPicker, toolReady, hasTool, craftDrawer } from './studio.js';
import { state, needSignIn, refreshCredits } from './account.js';
import { poseAt, cameraAt, keyedAt, rad, DEFAULT_AMOUNT } from './stage-math.js';

const D = { open: false, shot: null, version: 0, list: [], t: 0, playing: false, view: 'camera', pass: 'look', range: null, key: null, sel: null, messages: [], three: null, saving: 0, filming: false, secs: {} };
/** The video model's frame rate and frame count: LTX takes 8n + 1 frames at 24 fps, Wan 4n + 1 at 16. */
const filmClock = (doc) => { const fps = doc.film?.engine === 'wan' ? 16 : 24; const n = fps === 24 ? 8 : 4; return { fps, frames: Math.ceil((doc.seconds * fps) / n) * n + 1 }; };
const ASPECTS = { '16:9': [1280, 704], '9:16': [704, 1280], '1:1': [960, 960] };
const MOVES = ['static', 'push-in', 'pull-out', 'orbit', 'turntable', 'pan', 'truck', 'crane-up', 'crane-down', 'follow'];
const MOVE_WORDS = { static: 'Still', 'push-in': 'Push in', 'pull-out': 'Pull out', orbit: 'Orbit', turntable: 'Turntable', pan: 'Pan', truck: 'Truck (slide sideways)', 'crane-up': 'Crane up', 'crane-down': 'Crane down', follow: 'Follow' };

export const directorOpen = () => D.open;
export const currentShot = () => D.shot;

export function initDirector() {
  $('#directorBtn').addEventListener('click', () => (D.open ? closeDirector() : openDirector()));
  bus.on('signedIn', () => { if (D.open) loadShots(); });
}

// ------------------------------------------------------------------ open and close
export async function openDirector(id) {
  if (!state.user) return needSignIn(() => openDirector(id), 'login');
  D.open = true;
  $('#app').classList.add('directing');
  $('#directorBtn').classList.add('on');
  $('#shotTab').hidden = false;
  showPane('shot');
  if (getComputedStyle($('#mobileTabs')).display !== 'none') $('#mobileTabs button[data-m=edit]')?.click();
  bus.emit('director', true);
  try {
    await loadShots();
    const want = id ?? (() => { try { return localStorage.getItem('hg.director.last'); } catch { return null; } })();
    const pick = D.list.find((s) => s.id === want) ?? D.list[0];
    if (pick) await openShot(pick.id); else await newShot();
    await stage();
  } catch (err) { toast(plainError(err.message)); }
}

export function closeDirector() {
  if (!D.open) return;
  flushSave();
  D.open = false;
  D.playing = false;
  $('#app').classList.remove('directing');
  $('#directorBtn').classList.remove('on');
  $('#shotTab').hidden = true;
  showPane('media');
  $('#dirStage')?.remove();
  $('#dirBar')?.remove();
  if (D.three) { D.three.stop(); D.three = null; }
  bus.emit('director', false);
}

async function loadShots() { D.list = (await api(`/v1/director/shots?project=${encodeURIComponent(state.user.project)}`)).items ?? []; }
async function openShot(id) {
  const s = await api(`/v1/director/shots/${id}`);
  take(s);
  try { D.messages = JSON.parse(localStorage.getItem(`hg.director.ai.${id}`) || '[]'); } catch { D.messages = []; }
  bus.emit('directorShot', D.shot);
}
async function newShot() {
  const s = await api('/v1/director/shots', { body: { project: state.user.project, title: 'Untitled shot' } });
  D.list.unshift(s);
  take(s);
  D.messages = [];
  bus.emit('directorShot', D.shot);
}
function take(s) {
  D.shot = s;
  D.version = s.version;
  D.t = 0;
  D.sel = null;
  try { localStorage.setItem('hg.director.last', s.id); } catch { /* */ }
  drawPanel();
  D.three?.rebuild();
}

// ------------------------------------------------------------------ saving
let saveTimer = 0;
/** The shot changed here: redraw the stage now, save in a moment. */
function changed({ panel = false } = {}) {
  if (panel) drawPanel();
  D.three?.rebuild();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
  $('#dirSave').textContent = 'Saving…';
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!D.shot) return;
  try {
    const s = await api(`/v1/director/shots/${D.shot.id}`, { method: 'PUT', body: { doc: D.shot.doc, version: D.version } });
    D.version = s.version;
    D.shot.version = s.version;
    // People and props added here get their ids from Gen: keep them, so the next save doesn't make new ones.
    for (const k of ['cast', 'props']) D.shot.doc[k].forEach((x, i) => { if (!x.id && s.doc[k][i]) x.id = s.doc[k][i].id; });
    const i = D.list.findIndex((x) => x.id === s.id);
    if (i >= 0) D.list[i] = { ...D.list[i], title: s.title, updated: s.updated };
    if ($('#dirSave')) $('#dirSave').textContent = 'Saved';
  } catch (err) {
    if (err.status === 409 && err.data?.shot) { take(err.data.shot); toast('This shot changed somewhere else: here is the newest.'); return; }
    if ($('#dirSave')) $('#dirSave').textContent = 'Couldn\'t save';
  }
}

// ------------------------------------------------------------------ the AI director (ai.js sends here while open)
export async function askDirector(messages) {
  await flushSave();
  const selection = { t: Math.round(D.t * 100) / 100, range: D.range, selected: D.sel };
  const r = await api(`/v1/director/shots/${D.shot.id}/assistant`, { body: { messages, doc: D.shot.doc, selection } });
  take(r.shot);
  if (r.aiCredits) refreshCredits();
  return r;
}
export const directorMessages = () => D.messages;
export function keepDirectorMessages() { try { localStorage.setItem(`hg.director.ai.${D.shot.id}`, JSON.stringify(D.messages.slice(-40))); } catch { /* */ } }
export function directorSuggestions() {
  const s = D.shot?.doc;
  if (!s?.cast.length) return ['Two knights face off in the rain, low angle, slow push-in', 'A lone astronaut walks toward a crashed ship at dusk', 'A chef plates a dish, close and warm, the camera orbits'];
  if (D.range) return [`Pull the camera back from ${D.range[0]} to ${D.range[1]} s`, 'Push in slowly on this part', 'Have them turn to each other here'];
  return ['Make it more dramatic', 'Move the camera behind the first one\'s shoulder', 'Have them walk toward each other', 'Make it night, lit by neon'];
}

// ------------------------------------------------------------------ the Shot panel (left)
const sliderRow = (label, value, { min, max, step = 0.1, unit = '' }, on) => {
  const out = h('span', { class: 'muted small' }, `${value}${unit}`);
  const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  r.addEventListener('input', () => { out.textContent = `${r.value}${unit}`; on(Number(r.value)); });
  return h('label', { class: 'field dir-slider' }, h('span', { class: 'row' }, label, out), r);
};
const numPair = (label, v, on) => {
  const a = h('input', { type: 'number', step: '0.1', class: 'num', value: String(v[0]) });
  const b = h('input', { type: 'number', step: '0.1', class: 'num', value: String(v[1]) });
  const go = () => on([Number(a.value) || 0, Number(b.value) || 0]);
  a.addEventListener('change', go); b.addEventListener('change', go);
  return h('label', { class: 'field' }, label, h('span', { class: 'row' }, 'x', a, 'y', b));
};
const textField = (label, value, on, { rows = 0, ph = '' } = {}) => {
  const el = rows ? h('textarea', { rows: String(rows), placeholder: ph }, value ?? '') : h('input', { type: 'text', value: value ?? '', placeholder: ph });
  el.addEventListener('input', () => on(el.value));
  return h('label', { class: 'field' }, label, el);
};
const colorField = (label, value, on) => { const el = h('input', { type: 'color', value }); el.addEventListener('input', () => on(el.value)); return h('label', { class: 'field dir-color' }, label, el); };
const select = (label, value, options, on) => {
  const el = h('select', {}, ...options.map(([v, l]) => h('option', { value: String(v), selected: String(v) === String(value) }, l)));
  el.addEventListener('change', () => on(el.value));
  return h('label', { class: 'field' }, label, el);
};

function drawPanel() {
  const box = $('#shotPanel');
  if (!box || !D.shot) return;
  const s = D.shot.doc;
  const set = (fn, opts) => { fn(s); changed(opts); };
  const shots = h('div', { class: 'row dir-shots' },
    h('select', { class: 'dir-shot-sel', onchange: (e) => { flushSave(); openShot(e.target.value).catch((err) => toast(err.message)); } },
      ...D.list.map((x) => h('option', { value: x.id, selected: x.id === D.shot.id }, x.title))),
    h('button', { type: 'button', class: 'icon-btn', title: 'New shot', onclick: () => { flushSave(); newShot().catch((err) => toast(err.message)); } }, icon('plus')),
    h('button', { type: 'button', class: 'icon-btn', title: 'Delete this shot', onclick: async () => {
      if (!confirm(`Delete "${s.title}"? Films made from it stay in your library.`)) return;
      await api(`/v1/director/shots/${D.shot.id}`, { method: 'DELETE' });
      D.list = D.list.filter((x) => x.id !== D.shot.id);
      if (D.list[0]) await openShot(D.list[0].id); else await newShot();
    } }, icon('trash')));
  const head = [
    textField('Title', s.title, (v) => set((d) => { d.title = v || 'Untitled shot'; })),
    h('div', { class: 'field' }, 'Shape', h('div', { class: 'chips' }, ...Object.keys(ASPECTS).map((a) => h('button', { type: 'button', class: `chip${s.aspect === a ? ' on' : ''}`, onclick: () => set((d) => { d.aspect = a; }, { panel: true }) }, a)))),
    sliderRow('Length', s.seconds, { min: 1, max: 10, step: 0.5, unit: ' s' }, (v) => set((d) => { d.seconds = v; })),
    textField('The look', s.look, (v) => set((d) => { d.look = v; }), { rows: 3, ph: 'A rain-soaked neon alley at night, gritty live-action film still' }),
    textField('What happens', s.action, (v) => set((d) => { d.action = v; }), { rows: 3, ph: 'He walks up to her through the rain; footsteps splash; distant traffic' }),
  ];
  const cast = h('div', { class: 'dir-list' }, ...s.cast.map((c, i) => memberCard(c, i)),
    h('button', { type: 'button', class: 'ghost small', onclick: () => addMember() }, icon('person'), 'Add someone'));
  const props = h('div', { class: 'dir-list' }, ...s.props.map((p, i) => propCard(p, i)),
    h('button', { type: 'button', class: 'ghost small', onclick: () => addProp() }, icon('cube'), 'Add a prop'));
  const setBox = [
    h('div', { class: 'row dir-colors' }, colorField('Ground', s.set.ground, (v) => set((d) => { d.set.ground = v; })), colorField('Sky', s.set.skyColor, (v) => set((d) => { d.set.skyColor = v; }))),
    select('Light', s.set.lights, [['studio', 'Studio'], ['sun', 'Daylight'], ['night', 'Night']], (v) => set((d) => { d.set.lights = v; })),
    h('div', { class: 'field' }, '360° sky', h('div', { class: 'row' },
      s.set.sky ? h('img', { class: 'dir-sky', src: fileUrl(s.set.sky), alt: '' }) : h('span', { class: 'muted small' }, 'None'),
      h('button', { type: 'button', class: 'ghost small', onclick: () => libraryPicker('image', (a) => set((d) => { d.set.sky = a.id; }, { panel: true })) }, s.set.sky ? 'Change' : 'Pick a panorama'),
      s.set.sky ? h('button', { type: 'button', class: 'link small', onclick: () => set((d) => { d.set.sky = null; }, { panel: true }) }, 'Remove') : '')),
  ];
  const cam = s.camera;
  const camBox = [
    select('Move', cam.move, MOVES.map((m) => [m, MOVE_WORDS[m]]), (v) => set((d) => { d.camera.move = v; delete d.camera.amount; }, { panel: true })),
    select('Aim at', typeof cam.target === 'number' ? cam.target : 'point', [...s.cast.map((c, i) => [i, c.name]), ['point', 'The middle of the set']], (v) => set((d) => { d.camera.target = v === 'point' ? [0, 0, 1] : Number(v); })),
    sliderRow('Angle around', cam.angle, { min: -180, max: 180, step: 1, unit: '°' }, (v) => set((d) => { d.camera.angle = v; })),
    sliderRow('Distance', cam.distance, { min: 0.5, max: 30, step: 0.1, unit: ' m' }, (v) => set((d) => { d.camera.distance = v; })),
    sliderRow('Height', cam.height, { min: 0.1, max: 15, step: 0.05, unit: ' m' }, (v) => set((d) => { d.camera.height = v; })),
    sliderRow('Lens', cam.lens, { min: 12, max: 135, step: 1, unit: ' mm' }, (v) => set((d) => { d.camera.lens = v; })),
    DEFAULT_AMOUNT[cam.move] != null ? sliderRow('How far it moves', cam.amount ?? DEFAULT_AMOUNT[cam.move], cam.move === 'orbit' ? { min: -180, max: 180, step: 1, unit: '°' } : cam.move.endsWith('-in') || cam.move.endsWith('-out') ? { min: 0, max: 0.9, step: 0.05 } : { min: -10, max: 10, step: 0.1, unit: ' m' }, (v) => set((d) => { d.camera.amount = v; })) : '',
    sliderRow('Handheld', cam.handheld, { min: 0, max: 2, step: 0.1 }, (v) => set((d) => { d.camera.handheld = v; })),
    keysBox(s),
  ];
  const film = s.film ?? (s.film = { engine: 'ltx', keyframe: 'image.control', strength: 1, imageStrength: 1, nodes: {}, keyframeNodes: {} });
  const videoTool = film.engine === 'wan' ? 'video.control-wan' : 'video.control';
  const videoNodes = craftDrawer(videoTool, film.nodes);
  videoNodes.el.addEventListener('input', () => { film.nodes = videoNodes.nodes() ?? {}; changed(); });
  const keyNodes = craftDrawer(film.keyframe, film.keyframeNodes);
  keyNodes.el.addEventListener('input', () => { film.keyframeNodes = keyNodes.nodes() ?? {}; changed(); });
  const filmBox = [
    h('p', { class: 'muted small' }, 'How Gen films the stage. The defaults suit most shots; the AI director changes these when you say what was wrong with a take.'),
    select('Video model', film.engine, [['ltx', 'LTX-2.3: 24 fps, with sound'], ['wan', 'Wan 2.2 Fun Control: 16 fps, no sound']], (v) => set((d) => { d.film.engine = v; d.film.nodes = {}; }, { panel: true })),
    select('First frame', film.keyframe, [['image.control', 'Paint over the stage (keeps the layout)'], ['image.edit', 'Edit the stage frame (Qwen)']], (v) => set((d) => { d.film.keyframe = v; d.film.keyframeNodes = {}; }, { panel: true })),
    film.engine === 'ltx' ? sliderRow('Follows the stage', film.strength, { min: 0, max: 1, step: 0.05 }, (v) => set((d) => { d.film.strength = v; })) : '',
    film.engine === 'ltx' ? sliderRow('Keeps the first frame', film.imageStrength, { min: 0, max: 1, step: 0.05 }, (v) => set((d) => { d.film.imageStrength = v; })) : '',
    h('div', { class: 'field' }, h('span', { class: 'muted small' }, 'The video workflow'), videoNodes.el),
    h('div', { class: 'field' }, h('span', { class: 'muted small' }, 'The first-frame workflow'), keyNodes.el),
  ];
  // Sections remember being opened or closed across redraws (Filming starts closed: it's the advanced one).
  const section = (title, kids, open = true) => {
    const id = title.replace(/ \(\d+\)$/, '');
    const el = h('details', { class: 'dir-sec', open: D.secs[id] ?? open }, h('summary', {}, title), ...kids);
    el.addEventListener('toggle', () => { D.secs[id] = el.open; });
    return el;
  };
  box.replaceChildren(shots, section('Shot', head), section(`Cast (${s.cast.length})`, [cast]), section(`Props (${s.props.length})`, [props]), section('Set', setBox), section('Camera', camBox), section('Filming', filmBox, false));
  drawMarks();
}

/** Camera keys: the camera at given times, eased between (they replace the move). One open key shows its sliders. */
function keysBox(s) {
  const cam = s.camera;
  const keys = cam.keys ?? [];
  const set = (fn, opts) => { fn(s); changed(opts); };
  const addKey = () => set((d) => {
    const now = keyedAt(d.camera.keys, D.t) ?? d.camera;
    const k = { t: Math.round(D.t * 10) / 10, angle: now.angle, distance: now.distance, height: now.height, lens: now.lens };
    d.camera.keys = [...(d.camera.keys ?? []).filter((x) => Math.abs(x.t - k.t) > 0.05), k].sort((a, b) => a.t - b.t);
    D.key = d.camera.keys.indexOf(k);
  }, { panel: true });
  const rows = keys.map((k, j) => {
    const open = D.key === j;
    const ks = (fn) => set((d) => { fn(d.camera.keys[j]); });
    return h('div', { class: `dir-card${open ? ' on' : ''}` },
      h('button', { type: 'button', class: 'dir-card-head', onclick: () => { D.key = open ? null : j; D.t = k.t; D.playing = false; drawPlay(); drawPanel(); } },
        icon('frame'), h('b', {}, `${k.t} s`), h('span', { class: 'muted small' }, `${Math.round(k.distance * 10) / 10} m · ${Math.round(k.lens)} mm`)),
      open ? h('div', { class: 'dir-card-body' },
        sliderRow('At', k.t, { min: 0, max: s.seconds, step: 0.1, unit: ' s' }, (v) => ks((x) => { x.t = v; })),
        sliderRow('Angle around', k.angle, { min: -180, max: 180, step: 1, unit: '°' }, (v) => ks((x) => { x.angle = v; })),
        sliderRow('Distance', k.distance, { min: 0.5, max: 30, step: 0.1, unit: ' m' }, (v) => ks((x) => { x.distance = v; })),
        sliderRow('Height', k.height, { min: 0.1, max: 15, step: 0.05, unit: ' m' }, (v) => ks((x) => { x.height = v; })),
        sliderRow('Lens', k.lens, { min: 12, max: 135, step: 1, unit: ' mm' }, (v) => ks((x) => { x.lens = v; })),
        h('button', { type: 'button', class: 'link small danger', onclick: () => set((d) => { d.camera.keys.splice(j, 1); if (!d.camera.keys.length) delete d.camera.keys; D.key = null; }, { panel: true }) }, 'Remove this key')) : '');
  });
  return h('div', { class: 'field' }, h('span', {}, `Camera keys${keys.length ? ' (they replace the move)' : ''}`),
    h('div', { class: 'dir-list' }, ...rows, h('button', { type: 'button', class: 'ghost small', onclick: addKey }, icon('plus'), `Key the camera at ${fmt(D.t, 1)}`)),
    keys.length ? '' : h('p', { class: 'muted small' }, 'Scrub to a moment and key the camera there; key another moment and the camera moves between them. Or select a stretch and ask the AI.'));
}

function memberCard(c, i) {
  const s = D.shot.doc;
  const set = (fn, opts) => { fn(s.cast[i]); changed(opts); };
  const open = D.sel?.type === 'cast' && D.sel.i === i;
  const clips = D.three?.clipsOf(c.asset) ?? [];
  return h('div', { class: `dir-card${open ? ' on' : ''}` },
    h('button', { type: 'button', class: 'dir-card-head', onclick: () => { D.sel = open ? null : { type: 'cast', i }; drawPanel(); D.three?.select(); } },
      h('span', { class: 'dir-dot', style: { background: c.color } }), h('b', {}, c.name), h('span', { class: 'muted small' }, c.asset ? '3D model' : 'Stand-in')),
    open ? h('div', { class: 'dir-card-body' },
      textField('Name', c.name, (v) => set((m) => { m.name = v; })),
      textField('How they look', c.description, (v) => set((m) => { m.description = v; }), { rows: 2, ph: 'A tall knight in battered silver armor, red cloak' }),
      h('div', { class: 'field' }, '3D model', h('div', { class: 'row' }, h('span', { class: 'muted small' }, c.asset ? 'From your library' : 'A stand-in for now'),
        h('button', { type: 'button', class: 'ghost small', onclick: () => libraryPicker('mesh', (a) => set((m) => { m.asset = a.id; }, { panel: true })) }, c.asset ? 'Change' : 'Pick a model'),
        c.asset ? h('button', { type: 'button', class: 'link small', onclick: () => set((m) => { m.asset = null; m.animation = null; }, { panel: true }) }, 'Use a stand-in') : '')),
      clips.length ? select('Animation', c.animation ?? '', [['', 'None'], ...clips.map((n) => [n, n])], (v) => set((m) => { m.animation = v || null; })) : '',
      sliderRow('Height', c.height, { min: 0.3, max: 6, step: 0.05, unit: ' m' }, (v) => set((m) => { m.height = v; })),
      sliderRow('Facing', c.facing, { min: -180, max: 180, step: 1, unit: '°' }, (v) => set((m) => { m.facing = v; })),
      numPair('Stands at', c.position, (v) => set((m) => { m.position = v; })),
      h('div', { class: 'field' }, `Moves (${c.beats.length})`, ...c.beats.map((b, j) => h('div', { class: 'row dir-beat' },
        h('span', { class: 'small' }, b.to ? `Walk to ${b.to[0]}, ${b.to[1]}` : b.lookAt != null ? `Look at ${typeof b.lookAt === 'number' ? s.cast[b.lookAt]?.name ?? '?' : b.lookAt.join(', ')}` : b.facing != null ? `Turn to ${b.facing}°` : 'Wait', b.seconds ? ` · ${b.seconds} s` : ''),
        h('button', { type: 'button', class: 'icon-btn small', title: 'Remove', onclick: () => set((m) => { m.beats.splice(j, 1); }, { panel: true }) }, icon('close')))),
        h('button', { type: 'button', class: 'link small', onclick: () => set((m) => { const from = m.beats.filter((b) => b.to).pop()?.to ?? m.position; m.beats.push({ to: [Math.round((from[0] + 2) * 10) / 10, from[1]], seconds: 2 }); }, { panel: true }) }, '+ Walk somewhere (drag the marker)')),
      h('button', { type: 'button', class: 'link small danger', onclick: () => { s.cast.splice(i, 1); D.sel = null; changed({ panel: true }); } }, 'Remove from the shot')) : '');
}
function propCard(p, i) {
  const s = D.shot.doc;
  const set = (fn, opts) => { fn(s.props[i]); changed(opts); };
  const open = D.sel?.type === 'prop' && D.sel.i === i;
  return h('div', { class: `dir-card${open ? ' on' : ''}` },
    h('button', { type: 'button', class: 'dir-card-head', onclick: () => { D.sel = open ? null : { type: 'prop', i }; drawPanel(); D.three?.select(); } },
      h('span', { class: 'dir-dot sq', style: { background: p.color } }), h('b', {}, p.name), h('span', { class: 'muted small' }, p.asset ? '3D model' : p.shape)),
    open ? h('div', { class: 'dir-card-body' },
      textField('Name', p.name, (v) => set((m) => { m.name = v; })),
      textField('What it is', p.description, (v) => set((m) => { m.description = v; }), { rows: 2 }),
      h('div', { class: 'field' }, '3D model', h('div', { class: 'row' },
        h('button', { type: 'button', class: 'ghost small', onclick: () => libraryPicker('mesh', (a) => set((m) => { m.asset = a.id; }, { panel: true })) }, p.asset ? 'Change' : 'Pick a model'),
        p.asset ? h('button', { type: 'button', class: 'link small', onclick: () => set((m) => { m.asset = null; }, { panel: true }) }, 'Use a shape') : '')),
      p.asset ? '' : select('Shape', p.shape, [['box', 'Box'], ['cylinder', 'Cylinder'], ['sphere', 'Sphere']], (v) => set((m) => { m.shape = v; })),
      p.asset ? '' : colorField('Color', p.color, (v) => set((m) => { m.color = v; })),
      sliderRow('Size', p.size, { min: 0.1, max: 20, step: 0.05, unit: ' m' }, (v) => set((m) => { m.size = v; })),
      sliderRow('Facing', p.facing, { min: -180, max: 180, step: 1, unit: '°' }, (v) => set((m) => { m.facing = v; })),
      numPair('Stands at', p.position, (v) => set((m) => { m.position = v; })),
      h('button', { type: 'button', class: 'link small danger', onclick: () => { s.props.splice(i, 1); D.sel = null; changed({ panel: true }); } }, 'Remove')) : '');
}
function addMember() {
  const s = D.shot.doc;
  const n = s.cast.length;
  s.cast.push({ name: `Character ${n + 1}`, description: '', asset: null, animation: null, height: 1.75, position: [n % 2 ? 1.2 : -1.2, Math.floor(n / 2) * 1.5], facing: n % 2 ? -60 : 60, color: ['#c8a27a', '#7aa2c8', '#a27ac8', '#7ac8a2', '#c87a8a', '#c8c27a'][n % 6], beats: [] });
  if (typeof s.camera.target !== 'number') s.camera.target = 0;
  D.sel = { type: 'cast', i: n };
  changed({ panel: true });
}
function addProp() {
  const s = D.shot.doc;
  s.props.push({ name: `Prop ${s.props.length + 1}`, description: '', asset: null, shape: 'box', position: [0, 2 + s.props.length * 0.5], facing: 0, size: 1, color: '#8a8f99' });
  D.sel = { type: 'prop', i: s.props.length - 1 };
  changed({ panel: true });
}

// ------------------------------------------------------------------ the stage (three.js)
async function stage() {
  if (D.three) { D.three.rebuild(); return; }
  const wrap = h('div', { id: 'dirStage', class: 'dir-stage' }, h('div', { class: 'working' }, 'Setting the stage'));
  $('#viewer').append(wrap);
  const bar = h('div', { id: 'dirBar', class: 'dir-bar' },
    h('button', { class: 'play', id: 'dirPlay', title: 'Play the shot (Space)' }, icon('play')),
    h('div', { class: 'dir-timewrap' }, h('div', { class: 'dir-marks', id: 'dirMarks' }), h('input', { type: 'range', id: 'dirTime', min: '0', max: '1', step: '0.001', value: '0', class: 'dir-time' })),
    h('span', { class: 'timecode', id: 'dirTc' }, '0:00.0'),
    h('div', { class: 'row dir-range' }, h('button', { class: 'ghost small', id: 'dirIn', title: 'Start a selection here (I)' }, 'In'), h('button', { class: 'ghost small', id: 'dirOut', title: 'End the selection here (O)' }, 'Out'), h('span', { class: 'muted small', id: 'dirRangeTxt' }, '')),
    h('div', { class: 'seg dir-view' }, h('button', { 'data-v': 'camera', class: 'on' }, 'Camera'), h('button', { 'data-v': 'free' }, 'Free look')),
    h('div', { class: 'seg dir-view dir-pass', title: 'What the video model is given' }, h('button', { 'data-p': 'look', class: 'on' }, 'Look'), h('button', { 'data-p': 'depth' }, 'Depth')),
    h('span', { class: 'muted small', id: 'dirSave' }, ''),
    h('span', { class: 'tl-spacer' }),
    h('button', { class: 'ghost small', id: 'dirBlender', title: 'Film it with Gen\'s Blender pipeline (every character needs a 3D model)' }, icon('layers'), 'Blender'),
    h('button', { class: 'primary small', id: 'dirFilm' }, icon('film'), 'Film it'));
  $('#viewerWrap').insertBefore(bar, $('#toolbar'));
  try {
    D.three = await makeStage(wrap);
  } catch (err) {
    wrap.replaceChildren(h('div', { class: 'empty-note' }, h('p', {}, 'The 3D stage couldn\'t start in this browser.'), h('p', { class: 'muted small' }, plainError(err.message))));
    return;
  }
  $('#dirPlay').addEventListener('click', () => { D.playing = !D.playing; if (D.playing && D.t >= D.shot.doc.seconds - 0.01) D.t = 0; drawPlay(); });
  $('#dirTime').addEventListener('input', (e) => { D.playing = false; D.t = Number(e.target.value) * D.shot.doc.seconds; drawPlay(); });
  $$('#dirBar .dir-view button').forEach((b) => b.addEventListener('click', () => { D.view = b.dataset.v; $$('#dirBar .dir-view button').forEach((x) => x.classList.toggle('on', x === b)); D.three.layout(); }));
  $$('#dirBar .dir-pass button').forEach((b) => b.addEventListener('click', () => { D.pass = b.dataset.p; $$('#dirBar .dir-pass button').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#dirIn').addEventListener('click', () => markRange('in'));
  $('#dirOut').addEventListener('click', () => markRange('out'));
  $('#dirFilm').addEventListener('click', () => openFilm());
  $('#dirBlender').addEventListener('click', () => openBlender());
  drawPlay();
}
/** Selecting a stretch of the shot: In and Out (or I and O), for the AI ("pull back here"). Twice on the same spot clears it. */
function markRange(which) {
  const t = Math.round(D.t * 10) / 10;
  const [a, b] = D.range ?? [0, D.shot.doc.seconds];
  if (D.range && (which === 'in' ? a : b) === t) D.range = null;
  else D.range = which === 'in' ? [t, Math.max(t + 0.1, b)] : [Math.min(a, t - 0.1), t];
  if (D.range) D.range = [Math.max(0, Math.round(D.range[0] * 10) / 10), Math.min(D.shot.doc.seconds, Math.round(D.range[1] * 10) / 10)];
  drawMarks();
  bus.emit('directorShot', D.shot);
}
/** The selected stretch and the camera keys, drawn on the time bar. */
function drawMarks() {
  const box = $('#dirMarks');
  if (!box || !D.shot) return;
  const len = D.shot.doc.seconds || 1;
  const pct = (t) => `${(t / len) * 100}%`;
  box.replaceChildren(
    ...(D.range ? [h('div', { class: 'dir-sel', style: { left: pct(D.range[0]), width: pct(D.range[1] - D.range[0]) } })] : []),
    ...(D.shot.doc.camera.keys ?? []).map((k) => h('div', { class: 'dir-key', style: { left: pct(k.t) }, title: `Camera key at ${k.t} s` })));
  const txt = $('#dirRangeTxt');
  if (txt) txt.textContent = D.range ? `${fmt(D.range[0], 1)}–${fmt(D.range[1], 1)}` : '';
}
addEventListener('keydown', (e) => {
  if (!D.open || e.ctrlKey || e.metaKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'i' || e.key === 'I') { e.preventDefault(); e.stopImmediatePropagation(); markRange('in'); }
  if (e.key === 'o' || e.key === 'O') { e.preventDefault(); e.stopImmediatePropagation(); markRange('out'); }
}, true);

function drawPlay() {
  const p = $('#dirPlay');
  if (!p) return;
  p.replaceChildren(icon(D.playing ? 'pause' : 'play'));
  $('#dirTime').value = String(D.shot.doc.seconds ? D.t / D.shot.doc.seconds : 0);
  $('#dirTc').textContent = `${fmt(D.t, 1)} / ${fmt(D.shot.doc.seconds, 1)}`;
}
addEventListener('keydown', (e) => {
  if (!D.open || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); $('#dirPlay')?.click(); }
}, true);

// Blender's coordinates (x right, y away, z up) to three.js's (x right, y up, z toward the camera).
const V = (THREE, x, y, z = 0) => new THREE.Vector3(x, z, -y);

async function makeStage(wrap) {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
  const SkeletonUtils = await import('three/addons/utils/SkeletonUtils.js');
  wrap.replaceChildren();
  const canvas = h('canvas', { class: 'dir-canvas' });
  const frame = h('div', { class: 'dir-frame' }, canvas);
  const hint = h('div', { class: 'dir-hint muted small' }, 'Drag people and props to place them.');
  wrap.append(frame, hint);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 400);
  const freeCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 400);
  freeCam.position.set(7, 6, 9);
  const orbit = new OrbitControls(freeCam, canvas);
  orbit.target.set(0, 0.8, 0);
  orbit.enableDamping = true;
  const helpers = new THREE.Group();
  const camHelper = new THREE.CameraHelper(shotCam);
  const grid = new THREE.GridHelper(40, 40, 0x555a66, 0x2a2e38);
  grid.position.y = 0.002;
  helpers.add(camHelper, grid);
  scene.add(helpers);
  const world = new THREE.Group();
  scene.add(world);
  const loader = new GLTFLoader();
  const gltfCache = new Map();
  const loadGltf = (id) => { if (!gltfCache.has(id)) gltfCache.set(id, new Promise((ok) => loader.load(fileUrl(id), ok, undefined, () => ok(null)))); return gltfCache.get(id); };
  const clipsKnown = new Map();
  const texCache = new Map();
  let actors = [], propsObj = [], markers = [], build = 0;

  function mannequin(c) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.95, 6, 14), mat);
    body.position.y = 0.2 + 0.475 + 0.1;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 18, 14), mat);
    head.position.y = 1.6;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 10), new THREE.MeshStandardMaterial({ color: 0x20232b }));
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 1.6, 0.17);
    for (const m of [body, head, nose]) { m.castShadow = true; g.add(m); }
    g.scale.setScalar(c.height / 1.75);
    return g;
  }
  async function modelOf(asset, height) {
    const gltf = await loadGltf(asset);
    if (!gltf) return null;
    clipsKnown.set(asset, gltf.animations.map((a) => a.name));
    const obj = SkeletonUtils.clone(gltf.scene);
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const s = height / Math.max(0.01, size.y);
    obj.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(obj);
    obj.position.y -= box2.min.y;
    const center = box2.getCenter(new THREE.Vector3());
    obj.position.x -= center.x; obj.position.z -= center.z;
    const g = new THREE.Group();
    g.add(obj);
    const mixer = gltf.animations.length ? new THREE.AnimationMixer(obj) : null;
    return { group: g, mixer, clips: gltf.animations };
  }
  function lights(kind) {
    const L = new THREE.Group();
    if (kind === 'night') {
      L.add(new THREE.HemisphereLight(0x3a4a7a, 0x0a0a12, 0.5));
      const moon = new THREE.DirectionalLight(0x9fb4ff, 1.1); moon.position.set(-6, 10, 4); moon.castShadow = true; L.add(moon);
    } else if (kind === 'sun') {
      L.add(new THREE.HemisphereLight(0xbfd8ff, 0x5a4a3a, 0.9));
      const sun = new THREE.DirectionalLight(0xfff1d6, 2.6); sun.position.set(8, 14, 6); sun.castShadow = true; L.add(sun);
    } else {
      L.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.7));
      const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(5, 8, 6); key.castShadow = true; L.add(key);
      const rim = new THREE.DirectionalLight(0x9fc0ff, 1.0); rim.position.set(-6, 5, -6); L.add(rim);
    }
    for (const l of L.children) if (l.isDirectionalLight) { l.shadow.mapSize.set(2048, 2048); Object.assign(l.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15 }); }
    return L;
  }

  async function rebuild() {
    const my = ++build;
    const s = D.shot.doc;
    const next = new THREE.Group();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: s.set.ground, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    next.add(ground, lights(s.set.lights));
    if (s.set.sky) {
      if (!texCache.has(s.set.sky)) texCache.set(s.set.sky, new Promise((ok) => new THREE.TextureLoader().load(fileUrl(s.set.sky), (t) => { t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace; ok(t); }, undefined, () => ok(null))));
      scene.background = (await texCache.get(s.set.sky)) ?? new THREE.Color(s.set.skyColor);
    } else scene.background = new THREE.Color(s.set.skyColor);
    const nextActors = [];
    for (const [i, c] of s.cast.entries()) {
      const m = c.asset ? await modelOf(c.asset, c.height) : null;
      const group = m?.group ?? mannequin(c);
      group.userData = { type: 'cast', i };
      next.add(group);
      nextActors.push({ group, mixer: m?.mixer ?? null, clips: m?.clips ?? [], c });
    }
    const nextProps = [];
    for (const [i, p] of s.props.entries()) {
      let obj = null;
      if (p.asset) { const m = await modelOf(p.asset, 1); if (m) { obj = m.group; const b = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3()); obj.scale.setScalar(p.size / Math.max(0.01, b.x, b.y, b.z)); } }
      if (!obj) {
        const mat = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.7 });
        const geo = p.shape === 'sphere' ? new THREE.SphereGeometry(p.size / 2, 24, 18) : p.shape === 'cylinder' ? new THREE.CylinderGeometry(p.size / 3, p.size / 3, p.size, 24) : new THREE.BoxGeometry(p.size, p.size, p.size);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = p.size / 2;
        mesh.castShadow = true; mesh.receiveShadow = true;
        obj = new THREE.Group(); obj.add(mesh);
      }
      obj.position.copy(V(THREE, p.position[0], p.position[1]));
      obj.rotation.y = rad(p.facing);
      obj.userData = { type: 'prop', i };
      next.add(obj);
      nextProps.push(obj);
    }
    // Where each walk ends: a marker to drag (free look and camera view both).
    const nextMarkers = [];
    for (const [i, c] of s.cast.entries()) for (const [j, b] of c.beats.entries()) {
      if (!b.to) continue;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.26, 28), new THREE.MeshBasicMaterial({ color: c.color, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(V(THREE, b.to[0], b.to[1], 0.01));
      ring.userData = { type: 'beat', i, j };
      helpers.add(ring);
      nextMarkers.push(ring);
    }
    if (my !== build) { nextMarkers.forEach((m) => helpers.remove(m)); return; }
    markers.forEach((m) => helpers.remove(m));
    world.clear();
    world.add(next);
    actors = nextActors; propsObj = nextProps; markers = nextMarkers;
    live = null;
    select();
    if (D.sel?.type === 'cast' && clipsKnown.size) drawPanel();
  }

  /** Puts everything where it is at time t. */
  function pose(t) {
    const s = D.shot.doc;
    for (const [i, a] of actors.entries()) {
      const p = poseAt(s.cast, i, t);
      a.group.position.copy(V(THREE, p.pos[0], p.pos[1]));
      a.group.rotation.y = rad(p.face);
      if (a.mixer && a.clips.length) {
        const byName = (re) => a.clips.find((c) => re.test(c.name));
        const chosen = a.c.animation ? a.clips.find((c) => c.name === a.c.animation) : null;
        const clip = p.walking ? (byName(/walk/i) ?? chosen ?? a.clips[0]) : (chosen ?? byName(/idle/i) ?? a.clips[0]);
        a.mixer.stopAllAction();
        const act = a.mixer.clipAction(clip);
        act.play();
        a.mixer.setTime(t % Math.max(0.01, clip.duration));
      } else if (!a.mixer) {
        a.group.position.y = p.walking ? Math.abs(Math.sin(t * 9)) * 0.04 : 0;
      }
    }
  }
  function placeCamera(cam, t, aspect) {
    const c = cameraAt(D.shot.doc, t, aspect);
    cam.position.copy(V(THREE, c.pos.x, c.pos.y, c.pos.z));
    cam.up.set(0, 1, 0);
    cam.lookAt(V(THREE, c.look.x, c.look.y, c.look.z));
    cam.fov = c.vfov;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
  }
  const shotAspect = () => { const [w, hh] = ASPECTS[D.shot.doc.aspect]; return w / hh; };
  function layout() {
    const box = wrap.getBoundingClientRect();
    const ar = D.view === 'camera' ? shotAspect() : box.width / Math.max(1, box.height);
    let w = box.width - 16, hh = w / ar;
    if (hh > box.height - 16) { hh = box.height - 16; w = hh * ar; }
    renderer.setSize(Math.max(40, Math.floor(w)), Math.max(40, Math.floor(hh)));
    helpers.visible = D.view === 'free';
    orbit.enabled = D.view === 'free';
  }
  new ResizeObserver(() => layout()).observe(wrap);
  layout();

  // Dragging people, props and walk markers on the ground.
  const ray = new THREE.Raycaster();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let drag = null;
  const ndc = (e) => { const r = canvas.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  const viewCam = () => (D.view === 'camera' ? shotCam : freeCam);
  canvas.addEventListener('pointerdown', (e) => {
    ray.setFromCamera(ndc(e), viewCam());
    const hit = ray.intersectObjects([...markers, ...actors.map((a) => a.group), ...propsObj], true)[0];
    if (!hit) return;
    let o = hit.object;
    while (o && !o.userData?.type) o = o.parent;
    if (!o) return;
    drag = o.userData;
    orbit.enabled = false;
    canvas.setPointerCapture(e.pointerId);
    if (drag.type !== 'beat') { D.sel = { type: drag.type, i: drag.i }; drawPanel(); }
    D.playing = false;
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    ray.setFromCamera(ndc(e), viewCam());
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(floor, p)) return;
    // Near the horizon a small move is a huge distance: keep things on the set (25 m around its middle).
    if (Math.hypot(p.x, p.z) > 25) return;
    const xy = [Math.round(p.x * 20) / 20, Math.round(-p.z * 20) / 20];
    const s = D.shot.doc;
    if (drag.type === 'cast') s.cast[drag.i].position = xy;
    else if (drag.type === 'prop') s.props[drag.i].position = xy;
    else s.cast[drag.i].beats[drag.j].to = xy;
    D.t = drag.type === 'beat' ? D.t : 0;
    if (drag.type === 'beat') markers.find((m) => m.userData.i === drag.i && m.userData.j === drag.j)?.position.copy(V(THREE, xy[0], xy[1], 0.01));
    else if (drag.type === 'prop') propsObj[drag.i]?.position.copy(V(THREE, xy[0], xy[1]));
  });
  canvas.addEventListener('pointerup', () => { if (!drag) return; drag = null; live = null; orbit.enabled = D.view === 'free'; changed({ panel: true }); });

  let selBox = null;
  function select() {
    if (selBox) { scene.remove(selBox); selBox = null; }
    const o = D.sel?.type === 'cast' ? actors[D.sel.i]?.group : D.sel?.type === 'prop' ? propsObj[D.sel.i] : null;
    if (o) { selBox = new THREE.BoxHelper(o, 0x8b7bff); scene.add(selBox); }
  }

  /** Depth as the video model gets it: white near, black far, between near and far meters from the camera. */
  function depthMaterial(near, far) {
    return new THREE.ShaderMaterial({
      uniforms: { uNear: { value: near }, uFar: { value: far } },
      vertexShader: `#include <common>
        #include <skinning_pars_vertex>
        varying float vDepth;
        void main() {
          #include <skinbase_vertex>
          #include <begin_vertex>
          #include <skinning_vertex>
          #include <project_vertex>
          vDepth = -mvPosition.z;
        }`,
      fragmentShader: `uniform float uNear; uniform float uFar; varying float vDepth;
        void main() { float d = clamp((vDepth - uNear) / (uFar - uNear), 0.0, 1.0); gl_FragColor = vec4(vec3(1.0 - d), 1.0); }`,
    });
  }
  /** One depth range for the whole shot, measured over it, so depth doesn't flicker. Restores the pose at D.t after. */
  function depthRange(cam, aspect, fps) {
    const s = D.shot.doc;
    let near = Infinity, far = 0;
    const sphere = new THREE.Sphere();
    const frames = Math.round(s.seconds * fps);
    for (let f = 0; f <= frames; f += 6) {
      const t = f / fps;
      pose(t); placeCamera(cam, t, aspect);
      for (const o of [...actors.map((a) => a.group), ...propsObj]) {
        new THREE.Box3().setFromObject(o).getBoundingSphere(sphere);
        const d = sphere.center.distanceTo(cam.position);
        near = Math.min(near, d - sphere.radius); far = Math.max(far, d + sphere.radius);
      }
    }
    if (!Number.isFinite(near)) { near = 0.5; far = 20; }
    near = Math.max(0.05, near * 0.8);
    return { near, far: Math.max(near + 2, far * 1.6 + 2) };
  }
  let live = null;
  const liveDepth = () => {
    if (!live) { const probe = new THREE.PerspectiveCamera(); const r = depthRange(probe, shotAspect(), 24); live = depthMaterial(r.near, r.far); }
    return live;
  };

  let raf = 0, last = performance.now();
  function frameLoop(now) {
    raf = requestAnimationFrame(frameLoop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (D.playing && !D.filming) {
      D.t += dt;
      if (D.t >= D.shot.doc.seconds) { D.t = D.shot.doc.seconds; D.playing = false; }
      drawPlay();
    }
    if (D.filming) return;
    pose(D.t);
    placeCamera(shotCam, D.t, shotAspect());
    camHelper.update();
    selBox?.update();
    orbit.update();
    if (D.pass === 'depth') {
      const bg = scene.background;
      helpers.visible = false;
      if (selBox) selBox.visible = false;
      scene.overrideMaterial = liveDepth();
      scene.background = new THREE.Color(0x000000);
      pose(D.t);
      renderer.render(scene, D.view === 'camera' ? shotCam : freeCam);
      scene.overrideMaterial = null;
      scene.background = bg;
      helpers.visible = D.view === 'free';
      if (selBox) selBox.visible = true;
      return;
    }
    renderer.render(scene, D.view === 'camera' ? shotCam : freeCam);
  }
  raf = requestAnimationFrame(frameLoop);

  /** Records the shot: its first frame as a picture and its depth as a video, at the film's size and the video model's clock. */
  async function record(onStep) {
    const s = D.shot.doc;
    const [w, hh] = ASPECTS[s.aspect];
    const { fps: FPS, frames } = filmClock(s);
    const out = h('canvas', { width: String(w), height: String(hh) });
    const r2 = new THREE.WebGLRenderer({ canvas: out, antialias: true, preserveDrawingBuffer: true });
    r2.setPixelRatio(1);
    r2.setSize(w, hh, false);
    r2.shadowMap.enabled = true;
    r2.outputColorSpace = THREE.SRGBColorSpace;
    const cam = new THREE.PerspectiveCamera(40, w / hh, 0.05, 400);
    helpers.visible = false;
    selBox && (selBox.visible = false);
    try {
      // The first frame, as it looks.
      pose(0);
      placeCamera(cam, 0, w / hh);
      r2.render(scene, cam);
      const first = await new Promise((ok) => out.toBlob(ok, 'image/png'));
      const { near, far } = depthRange(cam, w / hh, FPS);
      const depth = depthMaterial(near, far);
      const bg = scene.background;
      scene.overrideMaterial = depth;
      scene.background = new THREE.Color(0x000000);
      const stream = out.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise((ok) => { rec.onstop = ok; });
      rec.start();
      const t0 = performance.now();
      for (let f = 0; f < frames; f++) {
        const t = f / FPS;
        pose(t); placeCamera(cam, t, w / hh);
        r2.render(scene, cam);
        track.requestFrame?.();
        onStep?.(`Recording the shot: ${Math.round((f / frames) * 100)}%`);
        const wait = t0 + ((f + 1) * 1000) / FPS - performance.now();
        await new Promise((ok) => setTimeout(ok, Math.max(0, wait)));
      }
      await new Promise((ok) => setTimeout(ok, 120));
      rec.stop();
      await stopped;
      scene.overrideMaterial = null;
      scene.background = bg;
      return { first, depth: new Blob(chunks, { type: 'video/webm' }), frames, fps: FPS, width: w, height: hh };
    } finally {
      scene.overrideMaterial = null;
      helpers.visible = D.view === 'free';
      if (selBox) selBox.visible = true;
      r2.dispose();
    }
  }

  await rebuild();
  return {
    rebuild: () => rebuild().catch((err) => console.error('stage', err)),
    select, layout, record,
    clipsOf: (asset) => (asset ? clipsKnown.get(asset) ?? [] : []),
    stop: () => { cancelAnimationFrame(raf); renderer.dispose(); },
  };
}

// ------------------------------------------------------------------ filming
/** Records the open shot (its first frame and depth video) without filming it: what "Film it" sends to Gen. */
export async function recordShot(onStep) {
  if (!D.three) throw new Error('Open the director first');
  D.filming = true;
  D.playing = false;
  try { return await D.three.record(onStep); } finally { D.filming = false; }
}
async function uploadBlob(blob, name, type) {
  const r = await fetch(`/v1/assets?project=${encodeURIComponent(state.user.project)}&title=${encodeURIComponent(name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': type, 'X-Filename': name }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status);
  let id = j.id ?? j.asset?.id;
  const norm = j.normalize?.job ?? j.normalizeJob ?? null;
  if (norm) {
    const done = await waitJob(typeof norm === 'string' ? norm : norm.id);
    id = (done.outputs.find((o) => o.kind === 'video') ?? done.outputs[0]).asset;
  }
  return id;
}

function sheetIn(title, body, foot) {
  $('#dirSheet')?.remove();
  const el = h('div', { class: 'sheet-pop wide', id: 'dirSheet' }, h('div', { class: 'sheet-head' }, h('b', {}, title), h('button', { class: 'icon-btn', title: 'Close', onclick: () => { if (!D.filming) el.remove(); } }, icon('close'))), ...body, foot);
  $('#viewerWrap').append(el);
  return el;
}

/** The video job for a shot's film settings: LTX (video.control) or Wan (video.control-wan), with its node settings. */
function videoJob(s, { prompt, width, height, fps, frames }) {
  const f = s.film;
  const nodes = Object.keys(f.nodes ?? {}).length ? { nodes: f.nodes } : {};
  // Wan's own sizes for each shape (multiples of 16); the control video is scaled to them.
  const wan = { '16:9': [832, 480], '9:16': [480, 832], '1:1': [640, 640] }[s.aspect] ?? [width, height];
  if (f.engine === 'wan') return { tool: 'video.control-wan', params: { prompt, width: wan[0], height: wan[1], frames, fps, ...nodes } };
  return { tool: 'video.control', params: { prompt, width, height, fps, seconds: s.seconds, strength: f.strength, imageStrength: f.imageStrength, ...nodes } };
}

async function openFilm() {
  if (!D.shot) return;
  await flushSave();
  const s = D.shot.doc;
  const vt = s.film?.engine === 'wan' ? 'video.control-wan' : 'video.control';
  if (!hasTool(vt) || !hasTool(s.film?.keyframe ?? 'image.control')) return toast(`Filming needs ${vt} and ${s.film?.keyframe ?? 'image.control'}, which this Gen doesn't have.`);
  const p = await api('/v1/director/prompts', { body: { doc: s } });
  const look = h('textarea', { rows: '3' }, p.look);
  const action = h('textarea', { rows: '3' }, p.action);
  const toTl = h('input', { type: 'checkbox', checked: true });
  const q = h('span', { class: 'quote' });
  const status = h('div', { class: 'muted small dir-status' });
  const go = h('button', { class: 'primary' }, icon('film'), 'Film it');
  const [w, hh] = ASPECTS[s.aspect];
  const price = async () => {
    const v = videoJob(s, { prompt: action.value, width: w, height: hh, fps: filmClock(s).fps, frames: filmClock(s).frames });
    const [a, b] = await Promise.all([quote(s.film.keyframe, { prompt: look.value }), quote(v.tool, v.params)]);
    q.textContent = a && b ? credits({ credits: a.credits + b.credits }) : '';
  };
  price();
  const offline = !toolReady(vt) || !toolReady(s.film.keyframe);
  const el = sheetIn('Film the shot', [
    h('p', { class: 'muted small' }, `Gen records this shot's depth and first frame here, paints the first frame in your look (${s.film.keyframe}), then films the shot from it (${vt}): ${s.seconds} s at ${videoJob(s, { width: w, height: hh }).params.width}×${videoJob(s, { width: w, height: hh }).params.height}. ${s.cast.some((c) => !c.asset) ? 'Stand-ins become the characters you describe.' : ''} Change how it's filmed in the Shot tab's Filming section, or tell the AI director what was wrong with a take.`),
    offline ? h('p', { class: 'warn small' }, 'The filming GPUs are offline right now. It will queue and start when they\'re back.') : '',
    h('label', { class: 'field' }, 'The first frame', look),
    h('label', { class: 'field' }, 'What happens (and sounds like)', action),
    h('label', { class: 'check' }, toTl, 'Add it to the timeline'),
    status,
  ], h('div', { class: 'sheet-foot' }, q, go));
  el.addEventListener('input', () => { clearTimeout(el._t); el._t = setTimeout(price, 400); });
  go.addEventListener('click', () => film({ look: look.value.trim(), action: action.value.trim(), toTl: toTl.checked, status, go }).catch(() => {}));
}

async function film({ look, action, toTl, status, go }) {
  const s = D.shot.doc;
  const say = (t) => { status.textContent = t; };
  go.disabled = true;
  D.filming = true;
  D.playing = false;
  try {
    const rec = await recordShot(say);
    D.filming = false;
    say('Uploading the depth and first frame');
    const [first, depth] = await Promise.all([
      uploadBlob(rec.first, `${s.title}: first frame (stage).png`, 'image/png'),
      uploadBlob(rec.depth, `${s.title}: depth.webm`, 'video/webm'),
    ]);
    say('Painting the first frame in your look');
    const f = s.film;
    const kn = Object.keys(f.keyframeNodes ?? {}).length ? { nodes: f.keyframeNodes } : {};
    const key = await runJob(f.keyframe === 'image.edit'
      ? { tool: 'image.edit', params: { prompt: `${look} Keep the composition, camera and every figure's position exactly.`, width: rec.width, height: rec.height, ...kn }, inputs: { images: [`asset:${first}`] }, label: `${s.title}: first frame` }
      : { tool: 'image.control', params: { prompt: look, ...kn }, inputs: { image: `asset:${first}` }, label: `${s.title}: first frame` });
    const keyAsset = (key.outputs.find((o) => o.kind === 'image') ?? key.outputs[0]).asset;
    say('Filming the shot (a few minutes)');
    const vj = videoJob(s, { prompt: action, width: rec.width, height: rec.height, fps: rec.fps, frames: rec.frames });
    const shot = await runJob({ ...vj, inputs: { control: `asset:${depth}`, image: `asset:${keyAsset}` }, label: `Shot: ${s.title}` });
    const out = shot.outputs.find((o) => o.kind === 'video') ?? shot.outputs[0];
    say('');
    $('#dirSheet')?.remove();
    const v = h('video', { src: fileUrl(out.asset), controls: true, autoplay: true, playsinline: true, class: 'dir-result' });
    sheetIn(`Your shot: ${s.title}`, [v], h('div', { class: 'sheet-foot' },
      h('span', { class: 'muted small' }, toTl ? 'Added to the timeline. Also in Media.' : 'Saved to Media.'),
      h('button', { class: 'ghost', onclick: () => { $('#dirSheet')?.remove(); openFilm(); } }, 'Film another take'),
      h('button', { class: 'primary', onclick: () => { closeDirector(); } }, 'Back to the editor')));
    if (toTl) await placeAsset({ id: out.asset, kind: 'video', title: s.title });
  } catch (err) {
    say(`Stopped: ${plainError(err.message)}`);
  } finally {
    D.filming = false;
    go.disabled = false;
  }
}

async function openBlender() {
  await flushSave();
  if (!hasTool('blender.render')) return toast('This Gen has no Blender.');
  let qd;
  try { qd = await api(`/v1/director/shots/${D.shot.id}/blender?quote=1`, { method: 'POST' }); } catch (err) { return toast(plainError(err.message)); }
  const status = h('div', { class: 'muted small dir-status' });
  const go = h('button', { class: 'primary' }, icon('layers'), 'Film in Blender');
  sheetIn('Film it in Blender', [
    h('p', { class: 'muted small' }, 'The full pipeline: a director checks the staging first, Blender renders depth, pose and edges, the best of three keyframes is picked, then the shot is filmed and upscaled.'),
    toolReady('blender.render') ? '' : h('p', { class: 'warn small' }, 'Gen\'s Blender servers are offline right now. It will wait in line until they\'re back. "Film it" works now.'),
    ...(qd.notes ?? []).map((n) => h('p', { class: 'muted small' }, n)),
    status,
  ], h('div', { class: 'sheet-foot' }, h('span', { class: 'quote' }, qd.quote ? credits(qd.quote) : ''), go));
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await api(`/v1/director/shots/${D.shot.id}/blender`, { method: 'POST' });
      status.textContent = 'In line. It shows in Media when it\'s done.';
      waitJob(r.job.id, (st) => { status.textContent = st; }).then(() => { bus.emit('jobDone'); refreshCredits(); toast(`Filmed: ${D.shot?.doc.title ?? 'your shot'}`); }).catch((err) => { status.textContent = `Stopped: ${plainError(err.message)}`; });
      refreshCredits();
    } catch (err) { status.textContent = plainError(err.message); go.disabled = false; }
  });
}
