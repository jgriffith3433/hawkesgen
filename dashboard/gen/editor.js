// The timeline editor (scenes.js): one editor for video, image and audio scenes, which are all a timeline
// (src/timeline.ts). The document is project.js's, the center player.js's (the frame at the playhead, or for audio the
// sound), the timeline timeline.js's, the tools on the selection tools.js's. The kind decides the defaults and what
// export means: a video (video.compose for a plain cut, a real-time render in the browser when tracks are layered), the
// picture at the playhead (an image scene), or the mixdown (an audio scene). Each becomes the scene's render, which other
// scenes play (plug and play): a clip that plays a scene remembers which render (`sceneVersion`), and when that scene
// renders again a bar offers to update it. The Inspector (the left pane's tab) edits what's selected: a clip (place,
// size, turn, opacity, blend, text, color, sound, fades, speed), a track, or the scene itself.

import { $, $$, h, api, toast, bus, icon, mediaInfo, fmt, fileUrl, plainError, ApiError } from './lib.js';
import { trouble } from './trouble.js';
import { P, take, save, canUndo, canRedo, doUndo, doRedo, undoLabel, redoLabel, remember, changed, clearHistory, newId, clipEnd, clipLength, selectedClips, setClip, trackOf, tracks, setTrack, isVisual, hasSound, isStill, isMagnetic, docLength, defaultTrack, startFor, PROGRESS, stopClip, retryClip, splitAt, deleteSelected, duplicateSelected, addClip, onTrack, mainTrack } from './project.js';
import { seek, pause, frameAt, mixdown, recordTimeline, refresh } from './player.js';
import { fit, timelineRefusal, viewState, setView } from './timeline.js';
import { openExport, clipTools } from './tools.js';
import { libraryPicker } from './studio.js';
import { state } from './account.js';
import { registerEditor, openScene, kindInfo, refreshBar, setRender, uniqueTitle } from './scenes.js';

const ACTION = {
  video: { label: 'Export', icon: 'download', run: () => openExport() },
  image: { label: 'Export picture', icon: 'image', run: () => exportPicture() },
  audio: { label: 'Mixdown', icon: 'download', run: () => exportMix() },
};

for (const kind of ['video', 'image', 'audio']) {
  registerEditor({
    kind, label: kindInfo(kind).label, icon: kindInfo(kind).icon, panel: 'Inspector', timelineKind: true,
    async mount(scene) {
      P.active = true;
      P.selection.clips.clear();
      P.selection.range = null;
      P.selection.track = null;
      P.playhead = 0;
      take(scene);
      clearHistory();
      try { localStorage.setItem('hg.editor.last', scene.id); } catch { /* */ }
      // Back where they left off: the playhead, the zoom and the scroll of this scene.
      const view = readView(scene.id);
      setTimeout(() => { fit(); if (view) { setView(view); seek(view.t ?? 0); } }, 30);
      checkStale(scene.uses ?? []);
      drawInspector();
      refresh();
    },
    async unmount() { keepView(); pause(); await save(); P.active = false; $('#staleBar')?.remove(); },
    undo: doUndo, redo: doRedo, canUndo, canRedo, undoLabel, redoLabel, save,
    action: ACTION[kind],
    rename(title) { remember(); P.doc.title = title; changed(); },
    accepts: (it) => !timelineRefusal(it),
    explain(it) {
      const no = timelineRefusal(it);
      if (no) return { ok: false, text: no };
      if (P.kind === 'image') return { ok: true, text: it.assetKind === 'audio' || it.kind === 'audio' ? 'Sound plays under the picture (a picture keeps only what you see)' : 'Add it as a new layer, right where you drop it' };
      return { ok: true, text: `Add it at the playhead (${fmt(P.playhead, 1)}) on ${trackOf(P.selection.track)?.name ? `"${trackOf(P.selection.track).name}"` : 'the track that fits'}` };
    },
    async drop(it, e) {
      // Dropped on the center: at the playhead, on the selected track (or one that fits); in an image scene, where it was dropped.
      const at = e?.clientX != null ? pointOnFrame(e.clientX, e.clientY) : null;
      const place = at && P.kind === 'image' ? { x: at.x, y: at.y, w: 0.6 } : undefined;
      if (it.asset) { const { placeAsset } = await import('./media.js'); return placeAsset({ id: it.asset, kind: it.assetKind, title: it.title, duration: it.duration }, { place }); }
      return placeScene(it, { place });
    },
    uses: (s) => [{ label: 'Add to this timeline', run: () => placeScene({ scene: s.id, kind: s.kind, title: s.title, render: s.render }) }],
  });
}
const viewKey = (id) => `hg.view.${id}`;
function readView(id) { try { return JSON.parse(localStorage.getItem(viewKey(id)) || 'null'); } catch { return null; } }
function keepView() { if (!P.id) return; try { localStorage.setItem(viewKey(P.id), JSON.stringify({ t: Math.round(P.playhead * 100) / 100, ...viewState() })); } catch { /* */ } }
addEventListener('beforeunload', keepView);
let viewT = 0;
bus.on('time', () => { clearTimeout(viewT); viewT = setTimeout(keepView, 800); });

/**
 * A scene still called "Untitled" takes the name of the first thing put in it ("Sunset", "Night shift"), so the tabs and
 * the Scenes list read like what's in them. Renaming it (double-click its tab) keeps the person's name.
 */
bus.on('doc', () => {
  if (!P.active || !P.id || !/^Untitled( video| image| audio)?$/.test(P.doc.title)) return;
  const first = [...P.doc.clips].sort((a, b) => a.start - b.start).find((c) => (c.label || c.text) && !c.pending);
  if (!first) return;
  const name = String(first.label || first.text).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 48);
  if (!name) return;
  P.doc.title = uniqueTitle(name.charAt(0).toUpperCase() + name.slice(1));
  bus.emit('sceneTitle', { id: P.id, title: P.doc.title });
});

/** A point on the screen as a share of the frame, if it's over the frame. */
function pointOnFrame(x, y) {
  const r = $('#compCanvas')?.getBoundingClientRect();
  if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  return { x: Math.round(((x - r.left) / r.width) * 1000) / 1000, y: Math.round(((y - r.top) / r.height) * 1000) / 1000 };
}

/**
 * A scene on the timeline: its render plays (a stage's film or photo, an image, a video's export, an audio scene's
 * mixdown), on the track asked for (else the selected one, else one that fits). A scene with no render yet opens so it
 * can be rendered.
 */
export async function placeScene(it, { track, start, place } = {}) {
  const r = it.render ?? (await api(`/v1/scenes/${it.scene}`)).doc.render;
  if (it.kind === 'character') { toast('A character goes on a stage, not a timeline.'); return null; }
  if (!r?.asset) {
    toast(`"${it.title}" has no render yet: render it, then add it.`, { action: 'Open it', onAction: () => openScene(it.scene) });
    return null;
  }
  const kind = r.kind === 'audio' ? 'audio' : r.kind === 'image' ? 'image' : 'video';
  const info = await mediaInfo(r.asset, kind);
  const into = track ?? defaultTrack(kind);
  const c = addClip({ track: into, kind, asset: r.asset, scene: it.scene, sceneVersion: r.version, duration: kind === 'image' ? null : info.duration ?? null, start: start ?? startFor(into, kind), label: it.title, place });
  P.selection.clips.clear();
  P.selection.clips.add(c.id);
  P.selection.track = c.track;
  bus.emit('selection');
  if (start == null && kind !== 'audio') seek(c.start + 0.001);
  toast(`Added "${it.title}". It updates when you render that ${kindInfo(it.kind).label.toLowerCase()} again.`);
  return c;
}

/** Clips whose scene rendered again since they were placed: a bar offers to bring them up to date. */
let stale = [];
function checkStale(uses) {
  $('#staleBar')?.remove();
  stale = [];
  for (const u of uses) {
    if (!u.render?.asset) continue;
    const clips = P.doc.clips.filter((c) => c.scene === u.id && (c.sceneVersion ?? 0) < u.render.version && c.asset !== u.render.asset);
    if (clips.length) stale.push({ u, clips });
  }
  if (!stale.length) return;
  const n = stale.reduce((a, s) => a + s.clips.length, 0);
  const bar = h('div', { class: 'stale-bar', id: 'staleBar' }, icon('sparkle'),
    h('span', {}, `${stale.map((s) => `"${s.u.title}"`).join(', ')} rendered again since ${n === 1 ? 'its clip was' : 'their clips were'} placed.`),
    h('button', { class: 'primary small', onclick: () => updateStale() }, 'Update'), h('button', { class: 'icon-btn small', title: 'Not now', onclick: () => bar.remove() }, icon('close')));
  $('#viewerWrap').prepend(bar);
}
async function updateStale() {
  remember();
  for (const { u, clips } of stale) {
    const info = await mediaInfo(u.render.asset, u.render.kind === 'audio' ? 'audio' : u.render.kind === 'image' ? 'image' : 'video');
    for (const c of clips) {
      const live = P.doc.clips.find((x) => x.id === c.id);
      if (!live) continue;
      live.asset = u.render.asset;
      live.sceneVersion = u.render.version;
      if (info.duration && !isStill(live)) { live.duration = info.duration; live.out = Math.min(live.out, info.duration); if (live.out <= live.in) { live.in = 0; live.out = info.duration; } }
    }
  }
  changed();
  $('#staleBar')?.remove();
  toast('Updated.');
  refreshBar();
}

// ------------------------------------------------------------------ exports
/** Uploads a blob into the account's library; returns its asset id. */
async function upload(blob, name, type) {
  const r = await fetch(`/v1/assets?project=${encodeURIComponent(state.user.project)}&title=${encodeURIComponent(name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': type, 'X-Filename': name }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status);
  return j;
}
const waiting = () => P.doc.clips.some((c) => c.pending);

/** An image scene's export: the frame at the playhead as a PNG, which becomes the scene's render. */
export async function exportPicture() {
  if (!state.user) return;
  if (waiting()) return toast('Some clips are still being made.');
  await save();
  try {
    const c = await frameAt(P.playhead);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    const j = await upload(blob, `${P.doc.title}.png`, 'image/png');
    const id = j.id ?? j.asset?.id;
    const s = await setRender(P.id, id, 'image');
    P.version = s.version;
    P.doc.render = s.doc.render;
    bus.emit('jobDone');
    toast(`The frame at ${fmt(P.playhead, 1)} is the picture now. It's in Media, and scenes that use this one can update to it.`, { action: 'Animate it', onAction: () => bus.emit('useIn', { tool: 'video.i2v', asset: { id, kind: 'image', title: P.doc.title } }) });
  } catch (err) { trouble(err); }
}

/** WAV (16-bit PCM) from an AudioBuffer. */
function wav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, rate = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([out], { type: 'audio/wav' });
}
/** An audio scene's export: every sound mixed (track volume, pan, mute, solo; clip volume and fades) into a WAV. */
export async function exportMix() {
  if (!state.user) return;
  if (waiting()) return toast('Some clips are still being made.');
  if (!P.doc.clips.some((c) => hasSound(c) && c.asset)) return toast('Add some sound first.');
  await save();
  toast('Mixing down…');
  try {
    const end = Math.max(...P.doc.clips.filter((c) => hasSound(c) && c.asset).map(clipEnd));
    const j = await upload(wav(await mixdown(0, end)), `${P.doc.title}.wav`, 'audio/wav');
    const s = await setRender(P.id, j.id ?? j.asset?.id, 'audio');
    P.version = s.version;
    P.doc.render = s.doc.render;
    bus.emit('jobDone');
    toast(`Mixed down (${fmt(end, 1)}). It's in Media, and scenes that use this one can update to it.`);
  } catch (err) { trouble(err); }
}

/**
 * Whether video.compose can make this cut: pictures and clips only on the main track, fitting the frame, no blends or
 * fades on them; text as captions; sound anywhere. Anything layered renders in the browser instead.
 */
export function composable() {
  const main = mainTrack()?.id;
  for (const c of P.doc.clips) {
    if (trackOf(c.track)?.hidden) continue;
    if (c.kind === 'audio') continue;
    if (c.kind === 'text') { if (c.x != null || c.y != null || c.size != null || c.rotation) return false; continue; }
    if (c.kind === 'fill') return false;
    if (c.track !== main) return false;
    if (c.w != null || c.x != null || c.y != null || c.rotation || (c.opacity ?? 1) !== 1 || (c.blend && c.blend !== 'normal')) return false;
  }
  // The main track plays as one cut from 0: no gaps.
  let at = 0;
  for (const c of onTrack(main)) { if (Math.abs(c.start - at) > 0.02) return false; at = clipEnd(c); }
  return !tracks().some((t) => t.solo || (t.volume ?? 1) !== 1 || t.pan) && !P.doc.clips.some((c) => c.fadeIn || c.fadeOut);
}

/** The timeline played once in the browser and recorded (layered timelines): uploaded, converted by Gen, the scene's render. */
export async function renderInBrowser(onStep) {
  onStep?.('Playing it through (real time)');
  const blob = await recordTimeline((k) => onStep?.(`Recording ${Math.round(k * 100)}%`));
  onStep?.('Uploading');
  const j = await upload(blob, `${P.doc.title}.webm`, 'video/webm');
  let id = j.id ?? j.asset?.id;
  const norm = j.normalize?.job ?? j.normalizeJob ?? null;
  if (norm) {
    onStep?.('Converting to MP4');
    const { waitJob } = await import('./media.js');
    const done = await waitJob(typeof norm === 'string' ? norm : norm.id, (s) => onStep?.(`Converting: ${s}`));
    id = (done.outputs.find((o) => o.kind === 'video') ?? done.outputs[0]).asset;
  }
  return id;
}

// ------------------------------------------------------------------ the Inspector (left pane)
// Simple first (J, 2026-10-30: "The point of the AI is that it's supposed to help with these finer tuning and we want to
// hide away most advanced knobs and stay away from input fields if possible"): what's selected, the AI's suggestions for
// it (one tap asks the AI), Gen's tools for it, a few sliders, chips and swatches; every number and menu waits under
// "Fine-tune", closed.
const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'lighten', 'darken', 'soft-light', 'difference'];
const FONTS = ['Inter', 'Georgia', 'Impact', 'Courier New', 'Trebuchet MS', 'Palatino', 'Arial Black'];
const SHAPES = {
  video: [['1280x720', '16:9', 'Wide'], ['720x1280', '9:16', 'Tall'], ['1080x1080', '1:1', 'Square'], ['1080x1350', '4:5', 'Portrait']],
  image: [['1344x768', '16:9', 'Wide'], ['768x1344', '9:16', 'Tall'], ['1024x1024', '1:1', 'Square'], ['1080x1350', '4:5', 'Portrait']],
  audio: [],
};
const SWATCHES = ['#ffffff', '#111318', '#ffd166', '#ff6b81', '#4fe0c0', '#8b7bff', '#1b2a6b'];
/** What the AI is good at for each kind of selection: one tap asks it (with the clip selected). */
const ASK = {
  image: ['Remove the background', 'Make it night time', 'Make it move', 'Make it fit the style of the rest'],
  video: ['Make this slow motion', 'Cut it to the best moment', 'Give it a film look', 'Continue the shot'],
  audio: ['Fade it in and out', 'Duck it under the voices', 'Trim it to the picture', 'Make a better version'],
  text: ['Make the words punchier', 'Style it like a movie title', 'Place it where it reads best'],
  fill: ['Make it a warm color grade', 'Make it a dark vignette', 'Fade it in over a second'],
};
const ASK_SCENE = {
  video: ['Make a 15-second trailer from my media', 'Add music that fits', 'Add captions for the voices', 'Tighten the cuts'],
  image: ['Make a movie poster of this', 'Add a bold title at the top', 'Relight it for golden hour', 'Make a background for it'],
  audio: ['Make a calm music bed', 'Add rain ambience on its own track', 'Write and voice a 10-second intro', 'Balance the mix'],
};
let typing = false;

export function initEditor() {
  bus.on('selection', drawInspector);
  bus.on('doc', () => { if (!typing) drawInspector(); });
  bus.on('time', () => { if (!typing && P.selection.clips.size === 1) drawInspectorSoon(); });
}
let soon = 0;
function drawInspectorSoon() { clearTimeout(soon); soon = setTimeout(drawInspector, 120); }

const pct = (v) => Math.round(v * 1000) / 10;
/** A labeled number field (only under Fine-tune); `fn` gets the value when it changes. */
function num(label, v, fn, { step = 1, min, max, unit = '' } = {}) {
  const i = h('input', { type: 'number', class: 'num', step: String(step), value: String(v), ...(min != null ? { min: String(min) } : {}), ...(max != null ? { max: String(max) } : {}) });
  i.addEventListener('change', () => fn(Number(i.value)));
  return h('label', { class: 'ins-num' }, h('span', { class: 'muted small' }, label), h('span', { class: 'row' }, i, unit ? h('span', { class: 'muted small' }, unit) : ''));
}
/** A slider that is one undo step per drag. */
function slider(label, v, { min = 0, max = 1, step = 0.01, show = (x) => `${Math.round(x * 100)}%` }, fn) {
  const out = h('span', { class: 'muted small' }, show(v));
  const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(v) });
  let first = true;
  r.addEventListener('pointerdown', () => { typing = true; });
  r.addEventListener('input', () => { out.textContent = show(Number(r.value)); fn(Number(r.value), first); first = false; });
  r.addEventListener('change', () => { first = true; typing = false; drawInspector(); });
  return h('label', { class: 'field ins-slider' }, h('span', { class: 'row' }, label, out), r);
}
const section = (title, ...kids) => h('div', { class: 'ins-sec' }, title ? h('h3', {}, title) : '', ...kids);
const chip = (label, on, fn, title) => h('button', { class: `chip small${on ? ' on' : ''}`, ...(title ? { title } : {}), onclick: fn }, label);
/** Color swatches (and one for any color). */
function swatches(value, fn, { allowNone = false } = {}) {
  const any = h('input', { type: 'color', value: value && value.startsWith('#') ? value : '#ffffff', title: 'Any color' });
  any.addEventListener('change', () => fn(any.value));
  return h('div', { class: 'swatches' },
    allowNone ? h('button', { class: `swatch none${!value ? ' on' : ''}`, title: 'None (see-through)', onclick: () => fn(null) }) : '',
    ...SWATCHES.map((c) => h('button', { class: `swatch${value === c ? ' on' : ''}`, style: { background: c }, title: c, onclick: () => fn(c) })), any);
}
/** Ask the AI about what's selected: one tap sends it (the AI pane shows the conversation). */
function askRow(list) {
  return h('div', { class: 'ins-ask' }, h('div', { class: 'ins-ask-head' }, icon('sparkle'), h('span', {}, 'Ask the AI')),
    h('div', { class: 'chips' }, ...list.map((x) => h('button', { class: 'chip small ask', onclick: () => import('./ai.js').then((a) => a.askAi(x)) }, x)),
      h('button', { class: 'chip small ask more', title: 'Say it in your own words', onclick: () => import('./ai.js').then((a) => a.askAi('')) }, 'Something else…')));
}
/** Every number and menu, closed until wanted. */
const fineTune = (...kids) => h('details', { class: 'ins-more' }, h('summary', {}, 'Fine-tune'), h('div', { class: 'ins-more-body' }, ...kids));

export function drawInspector() {
  const box = $('#kindPanel');
  if (!box || !P.active || !['video', 'image', 'audio'].includes(P.kind) || !$('#pane-kind') || $('#app').dataset.kind !== P.kind) return;
  const open = box.querySelector('details.ins-more')?.open;
  const cs = selectedClips();
  if (cs.length === 1) box.replaceChildren(clipPanel(cs[0]));
  else if (cs.length > 1) {
    box.replaceChildren(h('div', { class: 'ins' }, h('div', { class: 'ins-head' }, icon('layers'), h('b', {}, `${cs.length} clips selected`)),
      h('div', { class: 'row ins-acts' }, h('button', { class: 'ghost small', onclick: () => duplicateSelected() }, icon('copy'), 'Duplicate'), h('button', { class: 'ghost small', onclick: () => deleteSelected() }, icon('trash'), 'Delete'))));
  } else {
    const t = trackOf(P.selection.track);
    box.replaceChildren(h('div', { class: 'ins' }, addRow(), askRow(ASK_SCENE[P.kind] ?? []), t ? trackPanel(t) : '', scenePanel()));
  }
  // A Fine-tune that was open stays open while things change.
  if (open) { const d = box.querySelector('details.ins-more'); if (d) d.open = true; }
}

/** Add to the selected track (or one that fits) at the playhead: from Media, words, a color, something new. */
function addRow() {
  const t = trackOf(P.selection.track);
  return section(t ? `Add to "${t.name}"` : 'Add',
    h('div', { class: 'ins-adds' },
      h('button', { class: 'ins-add-btn', onclick: () => libraryPicker(P.kind === 'audio' ? 'audio' : null, async (a) => { const { placeAsset } = await import('./media.js'); placeAsset({ id: a.id, kind: a.kind, title: a.title, duration: a.meta?.duration }); }) }, icon('image'), h('span', {}, 'From Media')),
      P.kind !== 'audio' ? h('button', { class: 'ins-add-btn', onclick: () => { const c = addClip({ kind: 'text', text: 'Your words', ...(P.kind === 'image' ? { place: { size: 0.1, y: 0.2 } } : {}) }); P.selection.clips = new Set([c.id]); bus.emit('selection'); } }, icon('text'), h('span', {}, 'Words')) : '',
      P.kind !== 'audio' ? h('button', { class: 'ins-add-btn', onclick: () => { const c = addClip({ kind: 'fill', color: '#000000', place: { opacity: 0.4 } }); P.selection.clips = new Set([c.id]); bus.emit('selection'); } }, icon('fill'), h('span', {}, 'Color')) : '',
      h('button', { class: 'ins-add-btn', onclick: () => import('./media.js').then((m) => m.showPane('generate')) }, icon('sparkle'), h('span', {}, 'Make new'))),
    h('p', { class: 'muted small' }, 'Or drag anything from Media or Scenes onto a track: it says where it will go before you let go.'));
}

function scenePanel() {
  const d = P.doc;
  const set = (patch) => { remember(); Object.assign(P.doc, patch); for (const k of Object.keys(patch)) if (patch[k] == null) delete P.doc[k]; changed(); };
  const cur = `${d.width}x${d.height}`;
  const shapes = SHAPES[P.kind];
  return section(`This ${kindInfo(P.kind).label.toLowerCase()}`,
    shapes.length ? h('div', { class: 'shapes' }, ...shapes.map(([v, ar, l]) => {
      const [w, hh] = ar.split(':').map(Number);
      return h('button', { class: `shape${v === cur ? ' on' : ''}`, title: `${l} ${ar}`, onclick: () => { const [W, H] = v.split('x').map(Number); set({ width: W, height: H }); } },
        h('span', { class: 'shape-box', style: { aspectRatio: `${w} / ${hh}` } }), h('span', {}, l));
    })) : '',
    P.kind !== 'audio' ? h('div', { class: 'field' }, h('span', { class: 'muted small' }, 'Background'), swatches(d.background ?? (P.kind === 'image' ? null : '#000000'), (c) => set({ background: c }), { allowNone: P.kind === 'image' })) : '',
    h('p', { class: 'muted small' }, `${fmt(docLength(), 1)} long · ${P.doc.clips.length} clip${P.doc.clips.length === 1 ? '' : 's'}${d.render ? ' · rendered' : ''}${P.kind === 'image' ? ' · export takes the frame at the playhead' : ''}`),
    fineTune(
      P.kind !== 'audio' ? h('div', { class: 'chips' }, chip('Fit clips inside', d.fit !== 'crop', () => set({ fit: null }), 'Clips of another shape fit inside, with bars'), chip('Fill the frame', d.fit === 'crop', () => set({ fit: 'crop' }), 'Clips of another shape fill it, cropped')) : '',
      P.kind === 'image' ? num('Length (for layers that move)', d.length ?? 5, (v) => set({ length: Math.max(0.1, v) }), { step: 0.5, min: 0.1, unit: 's' }) : '',
      P.kind === 'audio' ? num('Tempo (the ruler shows bars)', d.bpm ?? '', (v) => set({ bpm: v ? Math.round(v) : null }), { min: 30, max: 300, unit: 'BPM' }) : '',
      P.kind === 'video' ? num('Frames per second', d.fps, (v) => set({ fps: Math.min(60, Math.max(8, v)) }), { min: 8, max: 60 }) : '',
      P.kind !== 'audio' ? h('p', { class: 'muted small' }, `${d.width} × ${d.height} pixels`) : ''));
}

function trackPanel(t) {
  const sound = t.role === 'audio' || P.doc.clips.some((c) => c.track === t.id && hasSound(c));
  return section(`Track: ${t.name}`,
    h('div', { class: 'chips' },
      chip(t.hidden ? 'Hidden' : 'Hide', t.hidden, () => setTrack(t.id, { hidden: !t.hidden })),
      chip(t.locked ? 'Locked' : 'Lock', t.locked, () => setTrack(t.id, { locked: !t.locked })),
      sound ? chip('Mute', t.mute, () => setTrack(t.id, { mute: !t.mute })) : '',
      sound ? chip('Solo', t.solo, () => setTrack(t.id, { solo: !t.solo })) : ''),
    sound ? slider('Volume', t.volume ?? 1, { max: 2 }, (v, first) => setTrack(t.id, { volume: v === 1 ? null : v }, { history: first })) : '',
    fineTune(
      sound ? slider('Pan', t.pan ?? 0, { min: -1, max: 1, step: 0.05, show: (v) => (Math.abs(v) < 0.03 ? 'Center' : v < 0 ? `Left ${Math.round(-v * 100)}` : `Right ${Math.round(v * 100)}`) }, (v, first) => setTrack(t.id, { pan: v || null }, { history: first })) : '',
      chip(t.magnetic ? 'Magnetic: clips back to back' : 'Make magnetic (clips back to back)', t.magnetic, () => setTrack(t.id, { magnetic: !t.magnetic })),
      h('div', { class: 'field' }, h('span', { class: 'muted small' }, 'Its color'), swatches(t.color, (c) => setTrack(t.id, { color: c ?? t.color }))),
      h('p', { class: 'muted small' }, 'Rename it by double-clicking its name on the timeline.')));
}

const ZOOMS = { none: null, slow: { from: 1, to: 1.15, x: 0.5, y: 0.45 }, punch: { from: 1.3, to: 1.3, x: 0.5, y: 0.4 }, out: { from: 1.2, to: 1, x: 0.5, y: 0.5 } };
const zoomOf = (z) => (!z ? 'none' : z.from === 1 ? 'slow' : z.to === 1 ? 'out' : 'punch');

function clipPanel(c) {
  const set = (patch, history = true) => setClip(c.id, patch, { history });
  const tr = trackOf(c.track);
  const visual = isVisual(c);
  const name = c.kind === 'text' ? 'Words' : c.label || { video: 'Clip', image: 'Picture', audio: 'Sound', fill: 'Color' }[c.kind];
  const parts = [h('div', { class: 'ins-head' }, icon({ video: 'film', image: 'image', audio: 'music', text: 'text', fill: 'fill' }[c.kind]),
    h('b', { class: 'ins-name', title: name }, name), h('span', { class: 'muted small' }, `${tr?.name ?? ''} · ${fmt(clipLength(c), 1)}`))];
  if (c.pending) parts.push(h('div', { class: 'ins-wait' }, h('span', { class: 'busy-dot' }), h('span', {}, PROGRESS.get(c.job) ?? 'Being made'), h('span', { class: 'muted small' }, 'It fills in when it\'s ready.'),
    h('button', { class: 'ghost small', onclick: () => stopClip(c.id) }, 'Stop')));
  if (c.failed) parts.push(h('div', { class: 'ins-wait failed' }, h('p', { class: 'error small' }, plainError(c.failed)),
    c.job ? h('button', { class: 'ghost small', onclick: () => retryClip(c.id) }, 'Retry') : ''));
  if (c.scene) parts.push(h('button', { class: 'ghost small', onclick: () => openScene(c.scene) }, icon('layers'), 'Open the scene it plays'));
  if (tr?.locked) parts.push(h('p', { class: 'muted small' }, `"${tr.name}" is locked: unlock it to change this.`));
  parts.push(askRow(ASK[c.kind] ?? []));
  const tools = clipTools(c);
  if (tools.length) parts.push(section(c.kind === 'image' ? 'Picture tools' : c.kind === 'video' ? 'Clip tools' : 'Tools', h('div', { class: 'ins-tools' }, ...tools.map((x) => h('button', { class: 'tb', onclick: x.run }, icon(x.icon), h('span', {}, x.label))))));

  // The few things people change by hand: words, color, how see-through, how loud.
  const quick = [];
  if (c.kind === 'text') {
    const ta = h('textarea', { rows: '2', placeholder: 'Your words' }, c.text ?? '');
    let first = true;
    ta.addEventListener('focus', () => { typing = true; first = true; });
    ta.addEventListener('input', () => { set({ text: ta.value }, first); first = false; });
    ta.addEventListener('blur', () => { typing = false; drawInspector(); });
    quick.push(ta, swatches(c.color ?? '#ffffff', (v) => set({ color: v })),
      slider('Size', c.size ?? 0.055, { min: 0.01, max: 0.4, step: 0.005, show: (v) => `${Math.round(v * P.doc.height)} px` }, (v, f) => set({ size: v }, f)),
      h('div', { class: 'chips' }, chip('Caption', c.size == null && c.y == null, () => set({ size: null, y: null, x: null, box: null }), 'Bottom center, on a soft box'), chip('Box behind', Boolean(c.box), () => set({ box: c.box ? null : 'rgba(0,0,0,.45)' }))));
  }
  if (c.kind === 'fill') quick.push(swatches(c.color ?? '#000000', (v) => set({ color: v ?? '#000000' })));
  if (visual) {
    quick.push(slider('Opacity', c.opacity ?? 1, {}, (v, f) => set({ opacity: v === 1 ? null : v }, f)));
    if (c.kind === 'image' || c.kind === 'video') quick.push(h('div', { class: 'chips' }, chip('Fit the frame', c.w == null && c.x == null && c.y == null && !c.rotation, () => set({ w: null, x: null, y: null, rotation: null })),
      chip('Push in', zoomOf(c.zoom) === 'slow', () => set({ zoom: zoomOf(c.zoom) === 'slow' ? null : ZOOMS.slow }), 'A slow push in over the clip')));
  }
  if (hasSound(c)) {
    quick.push(slider('Volume', c.volume ?? 1, { max: 2 }, (v, f) => set({ volume: v === 1 ? null : v }, f)),
      h('div', { class: 'chips' }, chip('Fade in', Boolean(c.fadeIn), () => set({ fadeIn: c.fadeIn ? null : Math.min(1, clipLength(c) / 3) }), 'Or drag the dot at its top-left corner on the timeline'),
        chip('Fade out', Boolean(c.fadeOut), () => set({ fadeOut: c.fadeOut ? null : Math.min(1, clipLength(c) / 3) }), 'Or drag the dot at its top-right corner'),
        chip(c.muted ? 'Muted' : 'Mute', c.muted, () => set({ muted: c.muted ? null : true }))));
  }
  if (!isStill(c)) quick.push(h('div', { class: 'chips' }, h('span', { class: 'muted small' }, 'Speed'), ...[0.5, 1, 2].map((s) => chip(s === 1 ? 'Normal' : `${s}×`, (c.speed ?? 1) === s, () => set({ speed: s === 1 ? null : s })))));
  if (quick.length) parts.push(section('', ...quick));

  // Everything else, closed.
  const trackSel = h('select', { onchange: (e) => { remember(); const x = P.doc.clips.find((y) => y.id === c.id); x.track = e.target.value; if (isMagnetic(x.track)) x.start = 1e6; P.selection.track = x.track; changed(); } },
    ...tracks().map((t) => h('option', { value: t.id, selected: t.id === c.track, disabled: t.locked && t.id !== c.track }, t.name)));
  parts.push(fineTune(
    h('label', { class: 'field' }, 'Track (or drag it on the timeline)', trackSel),
    h('div', { class: 'ins-grid' },
      isMagnetic(c.track) ? h('span', { class: 'muted small' }, `Starts at ${fmt(c.start, 2)} (magnetic)`) : num('Start', Math.round(c.start * 100) / 100, (v) => set({ start: Math.max(0, v) }), { step: 0.1, min: 0, unit: 's' }),
      num('Length', Math.round(clipLength(c) * 100) / 100, (v) => set(isStill(c) ? { in: 0, out: Math.max(0.1, v) } : { out: Math.min(c.duration ?? Infinity, c.in + Math.max(0.1, v) * (c.speed || 1)) }), { step: 0.1, min: 0.1, unit: 's' })),
    visual ? h('div', { class: 'ins-grid' },
      num('Across', pct(c.x ?? 0.5), (v) => set({ x: v / 100 === 0.5 ? null : v / 100 }), { step: 1, unit: '%' }),
      num('Down', pct(c.y ?? (c.kind === 'text' && c.size == null ? 0.86 : 0.5)), (v) => set({ y: v / 100 }), { step: 1, unit: '%' }),
      c.kind !== 'text' ? num('Width', c.w == null ? 100 : pct(c.w), (v) => set({ w: Math.max(0.5, v) / 100 }), { step: 1, min: 0.5, unit: '%' }) : '',
      num('Turn', Math.round(c.rotation ?? 0), (v) => set({ rotation: v || null }), { step: 1, unit: '°' })) : '',
    visual ? h('label', { class: 'field' }, 'Blend', h('select', { onchange: (e) => set({ blend: e.target.value === 'normal' ? null : e.target.value }) }, ...BLENDS.map((b) => h('option', { value: b, selected: b === (c.blend ?? 'normal') }, b[0].toUpperCase() + b.slice(1))))) : '',
    c.kind === 'image' || c.kind === 'video' ? h('label', { class: 'field' }, 'Camera move', h('select', { onchange: (e) => set({ zoom: ZOOMS[e.target.value] }) },
      ...[['none', 'None'], ['slow', 'Slow push in'], ['punch', 'Punch in'], ['out', 'Pull out']].map(([v, l]) => h('option', { value: v, selected: v === zoomOf(c.zoom) }, l)))) : '',
    c.kind === 'text' ? h('div', { class: 'row ins-row' },
      h('select', { title: 'Font', onchange: (e) => set({ font: e.target.value === 'Inter' ? null : e.target.value }) }, ...FONTS.map((f) => h('option', { value: f, selected: f === (c.font ?? 'Inter') }, f))),
      h('select', { title: 'Weight', onchange: (e) => set({ weight: Number(e.target.value) === 700 ? null : Number(e.target.value) }) }, ...[300, 400, 600, 700, 900].map((w) => h('option', { value: String(w), selected: w === (c.weight ?? 700) }, String(w))))) : '',
    c.kind === 'text' ? h('div', { class: 'chips' }, ...['left', 'center', 'right'].map((a) => chip(a[0].toUpperCase() + a.slice(1), (c.align ?? 'center') === a, () => set({ align: a === 'center' ? null : a })))) : '',
    hasSound(c) ? h('div', { class: 'ins-grid' },
      num('Fade in', c.fadeIn ?? 0, (v) => set({ fadeIn: v > 0 ? v : null }), { step: 0.1, min: 0, unit: 's' }),
      num('Fade out', c.fadeOut ?? 0, (v) => set({ fadeOut: v > 0 ? v : null }), { step: 0.1, min: 0, unit: 's' })) : '',
    !isStill(c) ? h('div', { class: 'chips' }, h('span', { class: 'muted small' }, 'Any speed'), ...[0.25, 0.75, 1.5, 4].map((s) => chip(`${s}×`, (c.speed ?? 1) === s, () => set({ speed: s })))) : ''));

  parts.push(h('div', { class: 'row ins-acts' },
    h('button', { class: 'icon-btn', title: 'Split at the playhead (S)', onclick: () => splitAt() }, icon('split')),
    h('button', { class: 'icon-btn', title: 'Duplicate (Ctrl+D)', onclick: () => duplicateSelected() }, icon('copy')),
    c.asset ? h('a', { class: 'icon-btn', title: 'Download', href: fileUrl(c.asset), download: '' }, icon('download')) : '',
    h('button', { class: 'icon-btn', title: 'Delete (Del)', onclick: () => deleteSelected() }, icon('trash'))));
  return h('div', { class: 'ins' }, ...parts);
}

export { defaultTrack, onTrack };
