// The timeline editor (scenes.js): one editor for video, image and audio scenes, which are all a timeline
// (src/timeline.ts). The document is project.js's, the center player.js's (the frame at the playhead, or for audio the
// sound), the timeline timeline.js's, the tools on the selection tools.js's. The kind decides the defaults and what
// export means: a video (video.compose for a plain cut, a real-time render in the browser when tracks are layered), the
// picture at the playhead (an image scene), or the mixdown (an audio scene). Each becomes the scene's render, which other
// scenes play (plug and play): a clip that plays a scene remembers which render (`sceneVersion`), and when that scene
// renders again a bar offers to update it. The Inspector (the left pane's tab) edits what's selected: a clip (place,
// size, turn, opacity, blend, text, color, sound, fades, speed), a track, or the scene itself.

import { $, $$, h, api, toast, bus, icon, mediaInfo, fmt, fileUrl, plainError, ApiError } from './lib.js';
import { P, take, save, canUndo, canRedo, doUndo, doRedo, remember, changed, clearHistory, newId, clipEnd, clipLength, selectedClips, setClip, trackOf, tracks, setTrack, isVisual, hasSound, isStill, isMagnetic, docLength, defaultTrack, splitAt, deleteSelected, duplicateSelected, addClip, onTrack, mainTrack } from './project.js';
import { seek, pause, frameAt, mixdown, recordTimeline, refresh } from './player.js';
import { fit } from './timeline.js';
import { openExport, clipTools } from './tools.js';
import { libraryPicker } from './studio.js';
import { state } from './account.js';
import { registerEditor, openScene, kindInfo, refreshBar, setRender } from './scenes.js';

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
      setTimeout(fit, 30);
      checkStale(scene.uses ?? []);
      drawInspector();
      refresh();
    },
    async unmount() { pause(); await save(); P.active = false; $('#staleBar')?.remove(); },
    undo: doUndo, redo: doRedo, canUndo, canRedo, save,
    action: ACTION[kind],
    rename(title) { remember(); P.doc.title = title; changed(); },
    accepts: (it) => (it.asset ? ['video', 'image', 'audio'].includes(it.assetKind) : Boolean(it.scene) && it.kind !== 'character'),
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
  const c = addClip({ track: track ?? undefined, kind, asset: r.asset, scene: it.scene, sceneVersion: r.version, duration: kind === 'image' ? null : info.duration ?? null, start: start ?? (P.kind === 'image' ? 0 : P.playhead), label: it.title, place });
  P.selection.clips.clear();
  P.selection.clips.add(c.id);
  P.selection.track = c.track;
  bus.emit('selection');
  if ((isMagnetic(c.track) || c.track === mainTrack()?.id) && start == null) seek(clipEnd(c));
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
  } catch (err) { toast(plainError(err.message)); }
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
  } catch (err) { toast(plainError(err.message)); }
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
const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'lighten', 'darken', 'soft-light', 'difference'];
const FONTS = ['Inter', 'Georgia', 'Impact', 'Courier New', 'Trebuchet MS', 'Palatino', 'Arial Black'];
const SIZES = {
  video: [['1280x720', 'Landscape 16:9'], ['720x1280', 'Vertical 9:16'], ['1080x1080', 'Square'], ['1080x1350', 'Portrait 4:5'], ['1920x1080', 'HD 1920×1080']],
  image: [['1344x768', 'Wide 1344×768'], ['768x1344', 'Tall 768×1344'], ['1024x1024', 'Square 1024'], ['1920x1080', 'HD 1920×1080'], ['1080x1350', 'Portrait 1080×1350'], ['2048x2048', 'Large square']],
  audio: [['1280x720', 'Landscape'], ['720x1280', 'Vertical']],
};
let typing = false;

export function initEditor() {
  bus.on('selection', drawInspector);
  bus.on('doc', () => { if (!typing) drawInspector(); });
  bus.on('time', () => { if (!typing && P.selection.clips.size === 1) drawInspectorSoon(); });
  // The center takes drops from a finger too (dragdrop.js).
}
let soon = 0;
function drawInspectorSoon() { clearTimeout(soon); soon = setTimeout(drawInspector, 120); }

const pct = (v) => Math.round(v * 1000) / 10;
/** A labeled number field; `fn` gets the value when it changes (Enter or leaving the field). */
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
const section = (title, ...kids) => h('div', { class: 'ins-sec' }, h('h3', {}, title), ...kids);

export function drawInspector() {
  const box = $('#kindPanel');
  if (!box || !P.active || !['video', 'image', 'audio'].includes(P.kind) || !$('#pane-kind') || $('#app').dataset.kind !== P.kind) return;
  const cs = selectedClips();
  if (cs.length === 1) return box.replaceChildren(clipPanel(cs[0]));
  if (cs.length > 1) {
    return box.replaceChildren(h('div', { class: 'ins' }, h('p', {}, h('b', {}, `${cs.length} clips selected`)),
      h('div', { class: 'row ins-acts' }, h('button', { class: 'ghost small', onclick: () => duplicateSelected() }, icon('copy'), 'Duplicate'), h('button', { class: 'ghost small', onclick: () => deleteSelected() }, icon('trash'), 'Delete'))));
  }
  const t = trackOf(P.selection.track);
  box.replaceChildren(h('div', { class: 'ins' }, addRow(), t ? trackPanel(t) : '', scenePanel()));
}

/** Add to the selected track (or one that fits) at the playhead: a file, text, a color, something new. */
function addRow() {
  const t = trackOf(P.selection.track);
  return section(t ? `Add to "${t.name}" at ${fmt(P.playhead, 1)}` : `Add at ${fmt(P.playhead, 1)}`,
    h('div', { class: 'row ins-add' },
      h('button', { class: 'ghost small', onclick: () => libraryPicker(P.kind === 'audio' ? 'audio' : P.kind === 'image' ? 'image' : null, async (a) => { const { placeAsset } = await import('./media.js'); placeAsset({ id: a.id, kind: a.kind, title: a.title, duration: a.meta?.duration }); }) }, icon('image'), 'From Media'),
      h('button', { class: 'ghost small', onclick: () => { const c = addClip({ kind: 'text', text: 'Your words', ...(P.kind === 'image' ? { place: { size: 0.1, y: 0.2 } } : {}) }); P.selection.clips = new Set([c.id]); bus.emit('selection'); } }, icon('text'), 'Text'),
      P.kind !== 'audio' ? h('button', { class: 'ghost small', onclick: () => { const c = addClip({ kind: 'fill', color: '#000000', place: { opacity: 0.4 } }); P.selection.clips = new Set([c.id]); bus.emit('selection'); } }, icon('fill'), 'Color') : '',
      h('button', { class: 'ghost small', onclick: () => import('./media.js').then((m) => m.showPane('generate')) }, icon('sparkle'), 'Generate')),
    h('p', { class: 'muted small' }, 'Or drag anything from Media or Scenes onto a track. Any track takes any clip; the top track draws in front.'));
}

function scenePanel() {
  const d = P.doc;
  const set = (patch) => { remember(); Object.assign(P.doc, patch); for (const k of Object.keys(patch)) if (patch[k] == null) delete P.doc[k]; changed(); };
  const sizes = SIZES[P.kind];
  const cur = `${d.width}x${d.height}`;
  const sizeSel = h('select', { onchange: (e) => { const [w, hh] = e.target.value.split('x').map(Number); set({ width: w, height: hh }); } },
    ...sizes.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)), sizes.some(([v]) => v === cur) ? '' : h('option', { value: cur, selected: true }, `${d.width}×${d.height}`));
  return section(`${kindInfo(P.kind).label} scene`,
    P.kind !== 'audio' ? h('label', { class: 'field' }, 'Shape', sizeSel) : '',
    P.kind !== 'audio' ? h('label', { class: 'field' }, 'Clips of another shape', h('select', { onchange: (e) => set({ fit: e.target.value === 'crop' ? 'crop' : null }) }, h('option', { value: 'pad', selected: d.fit !== 'crop' }, 'Fit inside (bars)'), h('option', { value: 'crop', selected: d.fit === 'crop' }, 'Fill (crop the edges)'))) : '',
    P.kind !== 'audio' ? h('div', { class: 'row ins-row' }, h('label', { class: 'ins-color' }, h('span', { class: 'muted small' }, 'Background'), h('input', { type: 'color', value: d.background ?? '#000000', onchange: (e) => set({ background: e.target.value }) })),
      P.kind === 'image' ? h('button', { class: `chip small${d.background ? '' : ' on'}`, onclick: () => set({ background: d.background ? null : '#1b1e26' }) }, 'Transparent') : '') : '',
    P.kind === 'image' ? num('Length (for animating layers)', d.length ?? 5, (v) => set({ length: Math.max(0.1, v) }), { step: 0.5, min: 0.1, unit: 's' }) : '',
    P.kind === 'audio' ? num('Tempo (the ruler shows bars)', d.bpm ?? '', (v) => set({ bpm: v ? Math.round(v) : null }), { min: 30, max: 300, unit: 'BPM' }) : '',
    P.kind === 'video' ? num('Frames per second', d.fps, (v) => set({ fps: Math.min(60, Math.max(8, v)) }), { min: 8, max: 60 }) : '',
    h('p', { class: 'muted small' }, `${fmt(docLength(), 1)} long · ${tracks().length} tracks · ${P.doc.clips.length} clips${d.render ? ' · rendered' : ''}`),
    P.kind === 'image' ? h('p', { class: 'muted small' }, 'Export takes the frame at the playhead as the picture.') : '');
}

function trackPanel(t) {
  const sound = t.role === 'audio' || P.doc.clips.some((c) => c.track === t.id && hasSound(c));
  const name = h('input', { type: 'text', value: t.name, maxlength: '40' });
  name.addEventListener('change', () => setTrack(t.id, { name: name.value.trim() || t.name }));
  return section('Track',
    h('div', { class: 'row ins-row' }, h('span', { class: 'tl-dot', style: { '--tc': t.color } }), name, h('input', { type: 'color', value: t.color ?? '#5b6cff', title: 'Its color', onchange: (e) => setTrack(t.id, { color: e.target.value }) })),
    h('div', { class: 'chips' },
      h('button', { class: `chip small${t.hidden ? ' on' : ''}`, onclick: () => setTrack(t.id, { hidden: !t.hidden }) }, t.hidden ? 'Hidden' : 'Hide'),
      h('button', { class: `chip small${t.locked ? ' on' : ''}`, onclick: () => setTrack(t.id, { locked: !t.locked }) }, t.locked ? 'Locked' : 'Lock'),
      h('button', { class: `chip small${t.magnetic ? ' on' : ''}`, title: 'Clips sit back to back in order', onclick: () => setTrack(t.id, { magnetic: !t.magnetic }) }, 'Magnetic'),
      sound ? h('button', { class: `chip small${t.mute ? ' on' : ''}`, onclick: () => setTrack(t.id, { mute: !t.mute }) }, 'Mute') : '',
      sound ? h('button', { class: `chip small${t.solo ? ' on' : ''}`, onclick: () => setTrack(t.id, { solo: !t.solo }) }, 'Solo') : ''),
    sound ? slider('Volume', t.volume ?? 1, { max: 2 }, (v, first) => setTrack(t.id, { volume: v === 1 ? null : v }, { history: first })) : '',
    sound ? slider('Pan', t.pan ?? 0, { min: -1, max: 1, step: 0.05, show: (v) => (Math.abs(v) < 0.03 ? 'Center' : v < 0 ? `Left ${Math.round(-v * 100)}` : `Right ${Math.round(v * 100)}`) }, (v, first) => setTrack(t.id, { pan: v || null }, { history: first })) : '');
}

function clipPanel(c) {
  const set = (patch, history = true) => setClip(c.id, patch, { history });
  const tr = trackOf(c.track);
  const visual = isVisual(c);
  const parts = [];
  const label = h('input', { type: 'text', value: c.label ?? '', placeholder: { video: 'Clip', image: 'Picture', audio: 'Sound', text: 'Text', fill: 'Color' }[c.kind] });
  label.addEventListener('change', () => set({ label: label.value.trim() || null }));
  const trackSel = h('select', { onchange: (e) => { remember(); const x = P.doc.clips.find((y) => y.id === c.id); x.track = e.target.value; if (isMagnetic(x.track)) x.start = 1e6; P.selection.track = x.track; changed(); } },
    ...tracks().map((t) => h('option', { value: t.id, selected: t.id === c.track, disabled: t.locked && t.id !== c.track }, t.name)));
  parts.push(h('div', { class: 'ins-head' }, icon({ video: 'film', image: 'image', audio: 'music', text: 'text', fill: 'fill' }[c.kind]), label),
    h('label', { class: 'field' }, 'Track', trackSel),
    c.pending ? h('p', { class: 'muted small' }, 'Being made…') : '', c.failed ? h('p', { class: 'error small' }, plainError(c.failed)) : '',
    c.scene ? h('button', { class: 'ghost small', onclick: () => openScene(c.scene) }, icon('layers'), 'Open the scene it plays') : '');
  const tools = clipTools(c);
  if (tools.length) parts.push(section(c.kind === 'image' ? 'Picture tools' : c.kind === 'video' ? 'Clip tools' : 'Tools', h('div', { class: 'ins-tools' }, ...tools.map((x) => h('button', { class: 'tb', onclick: x.run }, icon(x.icon), h('span', {}, x.label))))));
  // Time.
  parts.push(section('Time',
    h('div', { class: 'ins-grid' },
      isMagnetic(c.track) ? h('span', { class: 'muted small' }, `Starts at ${fmt(c.start, 2)} (magnetic)`) : num('Start', Math.round(c.start * 100) / 100, (v) => set({ start: Math.max(0, v) }), { step: 0.1, min: 0, unit: 's' }),
      num('Length', Math.round(clipLength(c) * 100) / 100, (v) => set(isStill(c) ? { in: 0, out: Math.max(0.1, v) } : { out: Math.min(c.duration ?? Infinity, c.in + Math.max(0.1, v) * (c.speed || 1)) }), { step: 0.1, min: 0.1, unit: 's' })),
    !isStill(c) ? h('div', { class: 'chips' }, ...[0.25, 0.5, 1, 1.5, 2, 4].map((s) => h('button', { class: `chip small${(c.speed ?? 1) === s ? ' on' : ''}`, onclick: () => set({ speed: s === 1 ? null : s }) }, s === 1 ? '1×' : `${s}×`))) : ''));
  if (c.kind === 'text') {
    const ta = h('textarea', { rows: '3' }, c.text ?? '');
    let first = true;
    ta.addEventListener('focus', () => { typing = true; first = true; });
    ta.addEventListener('input', () => { set({ text: ta.value }, first); first = false; });
    ta.addEventListener('blur', () => { typing = false; drawInspector(); });
    parts.push(section('Words', ta,
      h('div', { class: 'row ins-row' },
        h('select', { onchange: (e) => set({ font: e.target.value === 'Inter' ? null : e.target.value }) }, ...FONTS.map((f) => h('option', { value: f, selected: f === (c.font ?? 'Inter') }, f))),
        h('select', { onchange: (e) => set({ weight: Number(e.target.value) === 700 ? null : Number(e.target.value) }) }, ...[300, 400, 600, 700, 900].map((w) => h('option', { value: String(w), selected: w === (c.weight ?? 700) }, String(w)))),
        h('input', { type: 'color', value: c.color ?? '#ffffff', title: 'Color', onchange: (e) => set({ color: e.target.value }) })),
      h('div', { class: 'chips' }, ...['left', 'center', 'right'].map((a) => h('button', { class: `chip small${(c.align ?? 'center') === a ? ' on' : ''}`, onclick: () => set({ align: a === 'center' ? null : a }) }, a[0].toUpperCase() + a.slice(1))),
        h('button', { class: `chip small${c.box ? ' on' : ''}`, onclick: () => set({ box: c.box ? null : 'rgba(0,0,0,.45)' }) }, 'Box')),
      slider('Size', c.size ?? 0.055, { min: 0.01, max: 0.4, step: 0.005, show: (v) => `${Math.round(v * P.doc.height)} px` }, (v, first2) => set({ size: v }, first2)),
      c.size == null && c.y == null ? h('p', { class: 'muted small' }, 'A caption: bottom center. Drag it on the frame to place it.') : ''));
  }
  if (c.kind === 'fill') parts.push(section('Color', h('input', { type: 'color', value: c.color ?? '#000000', onchange: (e) => set({ color: e.target.value }) })));
  if (visual) {
    const fitted = c.w == null;
    parts.push(section('Place',
      h('div', { class: 'ins-grid' },
        num('X', pct(c.x ?? 0.5), (v) => set({ x: v / 100 === 0.5 ? null : v / 100 }), { step: 1, unit: '%' }),
        num('Y', pct(c.y ?? (c.kind === 'text' && c.size == null ? 0.86 : 0.5)), (v) => set({ y: v / 100 }), { step: 1, unit: '%' }),
        c.kind !== 'text' ? num('Width', fitted ? 100 : pct(c.w), (v) => set({ w: Math.max(0.5, v) / 100 }), { step: 1, min: 0.5, unit: '%' }) : '',
        num('Turn', Math.round(c.rotation ?? 0), (v) => set({ rotation: v || null }), { step: 1, unit: '°' })),
      h('div', { class: 'chips' },
        c.kind !== 'text' ? h('button', { class: `chip small${fitted ? ' on' : ''}`, onclick: () => set({ w: null, x: null, y: null, rotation: null }) }, 'Fit the frame') : '',
        h('button', { class: 'chip small', onclick: () => set({ x: null, y: c.kind === 'text' ? 0.5 : null }) }, 'Center')),
      slider('Opacity', c.opacity ?? 1, {}, (v, first) => set({ opacity: v === 1 ? null : v }, first)),
      h('label', { class: 'field' }, 'Blend', h('select', { onchange: (e) => set({ blend: e.target.value === 'normal' ? null : e.target.value }) }, ...BLENDS.map((b) => h('option', { value: b, selected: b === (c.blend ?? 'normal') }, b[0].toUpperCase() + b.slice(1))))),
      c.kind === 'image' || c.kind === 'video' ? h('label', { class: 'field' }, 'Push in', h('select', { onchange: (e) => set({ zoom: { none: null, slow: { from: 1, to: 1.15, x: 0.5, y: 0.45 }, punch: { from: 1.3, to: 1.3, x: 0.5, y: 0.4 }, out: { from: 1.2, to: 1, x: 0.5, y: 0.5 } }[e.target.value] }) },
        ...[['none', 'None'], ['slow', 'Slow push in'], ['punch', 'Punch in'], ['out', 'Pull out']].map(([v, l]) => h('option', { value: v, selected: v === (!c.zoom ? 'none' : c.zoom.from === 1 ? 'slow' : c.zoom.to === 1 ? 'out' : 'punch') }, l)))) : '',
      tr?.hidden ? h('p', { class: 'muted small' }, `Its track "${tr.name}" is hidden.`) : ''));
  }
  if (hasSound(c)) {
    parts.push(section('Sound',
      slider('Volume', c.volume ?? 1, { max: 2 }, (v, first) => set({ volume: v === 1 ? null : v }, first)),
      h('div', { class: 'ins-grid' },
        num('Fade in', c.fadeIn ?? 0, (v) => set({ fadeIn: v > 0 ? v : null }), { step: 0.1, min: 0, unit: 's' }),
        num('Fade out', c.fadeOut ?? 0, (v) => set({ fadeOut: v > 0 ? v : null }), { step: 0.1, min: 0, unit: 's' })),
      h('button', { class: `chip small${c.muted ? ' on' : ''}`, onclick: () => set({ muted: c.muted ? null : true }) }, c.muted ? 'Muted' : 'Mute')));
  }
  parts.push(h('div', { class: 'row ins-acts' },
    h('button', { class: 'icon-btn', title: 'Split at the playhead (S)', onclick: () => splitAt() }, icon('split')),
    h('button', { class: 'icon-btn', title: 'Duplicate (Ctrl+D)', onclick: () => duplicateSelected() }, icon('copy')),
    c.asset ? h('a', { class: 'icon-btn', title: 'Download', href: fileUrl(c.asset), download: '' }, icon('download')) : '',
    h('button', { class: 'icon-btn', title: 'Delete (Del)', onclick: () => deleteSelected() }, icon('trash'))));
  return h('div', { class: 'ins' }, ...parts);
}

export { defaultTrack, onTrack };
