// The timeline, always on screen (J, 2026-10-29: "Let's make the timeline always visible"). For video, image and audio
// scenes it is the document itself: tracks top first (a higher track draws over the ones below), each with a head (name,
// show/hide, lock, mute and solo, its menu), any clip on any track (pictures, clips, sounds, text, color), drag to move
// (between tracks too; a magnetic track reorders), edge handles to trim, snapping, a selected time range, transitions at
// the main track's joins, zoom, and drops from Media and Scenes (a dragged thing lands on the track it's dropped on, or on
// a new track below the others). Other kinds lend it lanes (`timeline` on their editor: a stage's people, camera keys
// and lines), drawn and dragged the same way.

import { $, $$, h, fmt, bus, icon, thumb, peaks, toast, jobStatusText } from './lib.js';
import { P, tracks, trackOf, isMagnetic, onTrack, clipLength, clipEnd, docLength, byId, remember, changed, addClip, setClip, isStill, mainTrack, addTrack, setTrack, removeTrack, moveTrack, hasSound, fitStart, neighbours, PROGRESS } from './project.js';
import { seek, isPlaying, pause } from './player.js';

const T = { z: 60, snap: true, scroll: null, canvas: null, lanes: null, raf: 0 };
/** The timeline's zoom and scroll, to put back when a scene opens again (editor.js). */
export const viewState = () => ({ z: T.z, left: T.scroll?.scrollLeft ?? 0 });
export function setView({ z, left } = {}) { if (z) { T.z = Math.min(MAX_Z, Math.max(MIN_Z, z)); render(); } if (left != null && T.scroll) T.scroll.scrollLeft = left; }
const MIN_Z = 4, MAX_Z = 480;
const xOf = (t) => t * T.z;
const tOf = (x) => x / T.z;
const ROW = { main: 62, video: 54, text: 34, audio: 46, any: 52 };
const rowH = (t) => ROW[t.role] ?? 50;
const ROLE_ICON = { main: 'film', video: 'film', text: 'text', audio: 'music', any: 'layers' };
const ROLE_WORDS = { any: 'Any clip', video: 'Video and pictures', text: 'Text', audio: 'Sound' };

/** The lanes another kind of scene lends the timeline (its editor's `timeline`), or null for a timeline scene. */
let lender = null;
export function lendTimeline(adapter) { lender = adapter; $('#app').classList.toggle('tl-lent', Boolean(adapter)); render(); fit(); }
const ph = () => (lender ? lender.playhead() : P.playhead);
const length = () => (lender ? lender.length() : docLength());

export function initTimeline() {
  T.scroll = $('#tlScroll');
  T.canvas = $('#tlCanvas');
  $('#zoomIn').addEventListener('click', () => zoomTo(T.z * 1.5));
  $('#zoomOut').addEventListener('click', () => zoomTo(T.z / 1.5));
  $('#zoomFit').addEventListener('click', fit);
  $('#snapBtn').addEventListener('click', () => { T.snap = !T.snap; $('#snapBtn').classList.toggle('on', T.snap); });
  $('#snapBtn').classList.toggle('on', T.snap);
  $('#addTrackBtn').addEventListener('click', (e) => newTrackMenu(e.currentTarget));
  T.scroll.addEventListener('scroll', () => { const l = $('#tlHeadsList'); if (l) l.style.transform = `translateY(${-T.scroll.scrollTop}px)`; placeEmpty(); });
  T.scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = T.scroll.getBoundingClientRect();
    const at = tOf(e.clientX - r.left + T.scroll.scrollLeft);
    zoomTo(T.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), at, e.clientX - r.left);
  }, { passive: false });
  // Ruler: click or drag to move the playhead; shift-drag selects a range.
  $('#tlRuler').addEventListener('pointerdown', (e) => {
    const r = T.canvas.getBoundingClientRect();
    const t0 = Math.max(0, tOf(e.clientX - r.left));
    if (e.shiftKey && !lender) return rangeDrag(e, t0);
    const go = (t) => (lender ? lender.seek(Math.min(lender.length(), t)) : seek(t));
    if (!lender && isPlaying()) pause();
    go(t0);
    // Past the visible part, the timeline pans along and the playhead follows (J, 2026-10-30).
    const pan = edgePan(go);
    const move = (ev) => { go(timeAt(ev.clientX)); pan.move(ev.clientX); };
    const up = () => { pan.stop(); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  // Empty track area: select that track, move the playhead; with a mouse, drag to select a time range.
  $('#tlTracks').addEventListener('pointerdown', (e) => {
    if (lender || e.target.closest('.clip, .tl-join, .lane-item')) return;
    const r = T.canvas.getBoundingClientRect();
    const t0 = Math.max(0, tOf(e.clientX - r.left));
    const row = e.target.closest('.tl-track');
    P.selection.clips.clear();
    P.selection.range = null;
    if (row?.dataset.track) P.selection.track = row.dataset.track;
    seek(t0);
    bus.emit('selection');
    if (e.pointerType === 'mouse') rangeDrag(e, t0);
  });
  // Drops from Media and Scenes come through dragdrop.js (mouse and finger alike): checkAt says what would happen.
  bus.on('doc', render);
  bus.on('selection', render);
  bus.on('time', movePlayhead);
  bus.on('lanes', () => { if (lender) render(); });
  // A clip being made says how it's going (in line, working, which step) right where it sits.
  bus.on('jobProgress', (p) => {
    const text = p.step ?? jobStatusText(p);
    PROGRESS.set(p.job, text);
    bus.emit('progressText');
    for (const c of P.doc.clips) if (c.job === p.job && c.pending) { const l = $(`#tlTracks .clip[data-id="${c.id}"] .clip-label`); if (l) l.textContent = `${text} · ${c.label ?? ''}`; }
  });
  // Two fingers pinch the timeline in and out (phones and trackpads that send touches).
  let pinch = null;
  T.scroll.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { const [a, b] = e.touches; pinch = { d: Math.abs(a.clientX - b.clientX), z: T.z, at: tOf((a.clientX + b.clientX) / 2 - T.scroll.getBoundingClientRect().left + T.scroll.scrollLeft) }; } }, { passive: true });
  T.scroll.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    const d = Math.max(10, Math.abs(a.clientX - b.clientX));
    zoomTo(pinch.z * (d / Math.max(10, pinch.d)), pinch.at, (a.clientX + b.clientX) / 2 - T.scroll.getBoundingClientRect().left);
  }, { passive: false });
  T.scroll.addEventListener('touchend', () => { pinch = null; });
  render();
}

// ------------------------------------------------------------------ where things land
function trackAt(y) { return $$('#tlTracks .tl-track').find((row) => { const r = row.getBoundingClientRect(); return y >= r.top && y < r.bottom; }) ?? null; }
/** Shows where a drag would land (the track, or a new one), or clears it; `ok` false shows it refused. */
export function hoverAt(x, y, ok = true) {
  const row = x == null ? null : trackAt(y);
  $$('#tlTracks .tl-track').forEach((r) => { r.classList.toggle('drop', r === row && ok); r.classList.toggle('drop-no', r === row && !ok); });
}

const ACTION_OF = { video: 'Export', image: 'Export picture', audio: 'Mixdown', stage: 'Film it' };
/**
 * Why a dragged thing can't go on a timeline scene, in plain words with what to do instead; null when it can. The
 * timeline and the center both say it.
 */
export function timelineRefusal(it) {
  if (it.asset) {
    if (it.assetKind === 'mesh') return '3D models go on a stage. Open one (+ > Stage) and drop it there.';
    if (!['image', 'video', 'audio'].includes(it.assetKind)) return 'Only pictures, clips and sounds go on a timeline.';
    return null;
  }
  if (it.scene) {
    if (it.kind === 'character') return 'A character goes on a stage, not a timeline. Open a stage (+ > Stage) and drop them there.';
    if (it.scene === P.id) return 'A scene can\'t play inside itself.';
    if (!it.render?.asset) return `"${it.title}" has nothing to show yet. Open it and press ${ACTION_OF[it.kind] ?? 'its export'}, then drop it here.`;
    return null;
  }
  return 'That can\'t go here.';
}
/** What a drag over a point of the timeline would do: null off the timeline, else { ok, text }. */
export function checkAt(it, x, y) {
  if (!overTimeline(x, y)) return null;
  if (lender) return { ok: false, text: lender.dropHint ?? 'These are the stage\'s timings. Drop it on the stage above to add it to the shot.' };
  const no = timelineRefusal(it);
  if (no) return { ok: false, text: no };
  const r = T.canvas.getBoundingClientRect();
  const t = Math.max(0, tOf(x - r.left));
  const row = trackAt(y);
  const tr = row?.dataset.track ? trackOf(row.dataset.track) : null;
  if (!tr) return { ok: true, text: `On a new track, at ${fmt(t, 1)}` };
  if (tr.locked) return { ok: false, text: `"${tr.name}" is locked. Unlock it (the lock by its name), or drop it on another track.` };
  return { ok: true, text: `Add to "${tr.name}" at ${fmt(t, 1)}` };
}
/** True when a point is over the timeline's tracks. */
export function overTimeline(x, y) { const r = $('#tlScroll')?.getBoundingClientRect(); return Boolean(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom); }
/**
 * Something dropped at a point: a library file or a scene, onto the track under it at that time (on the empty row
 * below the tracks: a new track for it). Any kind goes on any track.
 */
export async function dropAt(it, x, y) {
  if (lender || !overTimeline(x, y)) return false;
  const r = T.canvas.getBoundingClientRect();
  const t = Math.max(0, tOf(x - r.left));
  const row = trackAt(y);
  let track = row?.dataset.track ?? null;
  const kind = it.asset ? it.assetKind : it.render?.kind === 'audio' || it.kind === 'audio' ? 'audio' : it.render?.kind === 'image' ? 'image' : 'video';
  if (row?.dataset.new || !track) track = null;
  if (track && trackOf(track)?.locked) { toast('That track is locked.'); return true; }
  if (!track && row?.dataset.new) track = addTrack({ name: kind === 'audio' ? 'Sound' : kind === 'image' ? 'Pictures' : 'Video', role: kind === 'audio' ? 'audio' : 'any', at: kind === 'audio' ? tracks().length : undefined }).id;
  if (it.scene) {
    const { placeScene } = await import('./editor.js');
    await placeScene(it, { track, start: t });
  } else {
    const { placeAsset } = await import('./media.js');
    await placeAsset({ id: it.asset, kind: it.assetKind, title: it.title, duration: it.duration }, { track, start: t });
  }
  return true;
}

function rangeDrag(e, t0) {
  let moved = false;
  const to = (t1) => {
    if (!moved && Math.abs(t1 - t0) * T.z < 4) return;
    moved = true;
    P.selection.range = { start: Math.min(t0, t1), end: Math.max(t0, t1) };
    drawRange();
  };
  const pan = edgePan(to);
  const move = (ev) => { to(timeAt(ev.clientX)); pan.move(ev.clientX); };
  const up = () => {
    pan.stop();
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (moved) bus.emit('selection');
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/** The time under a screen x (measured now: the timeline may have scrolled since the drag began). */
const timeAt = (clientX) => Math.max(0, tOf(clientX - T.canvas.getBoundingClientRect().left));
/**
 * While a drag holds the pointer near or past the left or right edge of the visible timeline, it pans: a steady pace,
 * a little faster the further out (capped, so it never races off), and `onTime` gets the time under the pointer as it
 * goes. move(x) on every pointer move, stop() when the drag ends.
 */
function edgePan(onTime) {
  const EDGE = 32, MIN = 160, MAX = 700; // px from the edge where it starts; px a second at the edge and at most
  let x = null, raf = 0, last = 0;
  const step = (now) => {
    raf = 0;
    if (x == null || !T.scroll) return;
    const v = T.scroll.getBoundingClientRect();
    const out = x < v.left + EDGE ? x - (v.left + EDGE) : x > v.right - EDGE ? x - (v.right - EDGE) : 0;
    if (!out) { last = 0; return; }
    const dt = last ? Math.min(50, now - last) / 1000 : 1 / 60;
    last = now;
    const speed = Math.min(MAX, MIN + Math.abs(out) * 4);
    const before = T.scroll.scrollLeft;
    T.scroll.scrollLeft = Math.max(0, before + Math.sign(out) * speed * dt);
    if (T.scroll.scrollLeft !== before) { onTime(timeAt(x)); placeEmpty(); }
    raf = requestAnimationFrame(step);
  };
  return {
    move(cx) { x = cx; if (!raf) raf = requestAnimationFrame(step); },
    stop() { x = null; last = 0; if (raf) cancelAnimationFrame(raf); raf = 0; },
  };
}

export function zoomTo(z, at = ph(), px = null) {
  const old = T.z;
  T.z = Math.min(MAX_Z, Math.max(MIN_Z, z));
  if (T.z === old) return;
  render();
  const left = px ?? T.scroll.clientWidth / 3;
  T.scroll.scrollLeft = Math.max(0, xOf(at) - left);
}
export function fit() {
  if (!T.scroll) return;
  const len = Math.max(lender ? 1 : 5, length());
  T.z = Math.min(MAX_Z, Math.max(MIN_Z, (T.scroll.clientWidth - 40) / len));
  render();
  T.scroll.scrollLeft = 0;
}

/** The empty timeline's hint stays in the middle of what's in view, however far it's scrolled. */
function placeEmpty() { const el = $('#tlEmpty'); if (el && T.scroll) el.style.left = `${T.scroll.scrollLeft + T.scroll.clientWidth / 2}px`; }

function movePlayhead() {
  const el = $('#tlPlayhead');
  if (!el) return;
  el.style.transform = `translateX(${xOf(ph())}px)`;
  // Keep the playhead in view while playing.
  if (lender ? lender.playing?.() : isPlaying()) {
    const x = xOf(ph()) - T.scroll.scrollLeft;
    if (x > T.scroll.clientWidth - 40 || x < 0) T.scroll.scrollLeft = xOf(ph()) - 60;
  }
}

function drawRange() {
  const el = $('#tlRange');
  const r = lender ? lender.range?.() : P.selection.range;
  el.hidden = !r;
  if (r) {
    el.style.left = `${xOf(r.start)}px`;
    el.style.width = `${Math.max(2, xOf(r.end - r.start))}px`;
    el.dataset.label = `${fmt(r.end - r.start, 1)} selected`;
  }
}

/** Ruler ticks at a spacing that reads well at this zoom; bars when an audio scene has a tempo. */
function drawRuler(width) {
  const ruler = $('#tlRuler');
  const out = [];
  if (!lender && P.kind === 'audio' && P.doc.bpm) {
    const bar = (60 / P.doc.bpm) * 4;
    const every = Math.max(1, Math.ceil(60 / (bar * T.z)));
    for (let b = 0; b * bar * T.z <= width; b += 1) out.push(h('div', { class: `tick${b % every === 0 ? ' major' : ''}`, style: { left: `${xOf(b * bar)}px` } }, b % every === 0 ? String(b + 1) : ''));
    ruler.replaceChildren(...out);
    return;
  }
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const major = steps.find((s) => s * T.z >= 70) ?? 600;
  const minor = steps.slice().reverse().find((s) => s < major && s * T.z >= 10) ?? major;
  for (let t = 0; t * T.z <= width; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    out.push(h('div', { class: `tick${isMajor ? ' major' : ''}`, style: { left: `${xOf(t)}px` } }, isMajor ? fmt(t, major < 1 ? 1 : 0) : ''));
  }
  ruler.replaceChildren(...out);
}

// ------------------------------------------------------------------ drawing
export function render() {
  if (!T.scroll) return;
  if (lender) return renderLanes();
  cancelAnimationFrame(T.raf);
  const len = docLength();
  const width = Math.max(T.scroll.clientWidth, xOf(len + 10));
  T.canvas.style.width = `${width}px`;
  drawRuler(width);
  const main = mainTrack()?.id;
  const rows = tracks().map((t) => h('div', {
    class: `tl-track role-${t.role}${t.id === P.selection.track ? ' on' : ''}${t.hidden ? ' off' : ''}${t.locked ? ' locked' : ''}`,
    'data-track': t.id, style: { height: `${rowH(t)}px`, '--tc': t.color ?? 'var(--accent)' },
  }));
  for (const c of P.doc.clips) {
    const i = tracks().findIndex((t) => t.id === c.track);
    if (i >= 0) rows[i].append(clipEl(c));
  }
  // Transitions where the main track's clips meet.
  const mi = tracks().findIndex((t) => t.id === main);
  if (mi >= 0) {
    const v = onTrack(main);
    for (let i = 0; i < v.length - 1; i++) {
      const c = v[i];
      if (Math.abs(v[i + 1].start - clipEnd(c)) > 0.02) continue;
      rows[mi].append(h('button', {
        class: `tl-join${c.transition ? ' on' : ''}`, style: { left: `${xOf(clipEnd(c))}px` }, title: c.transition ? `${c.transition} (${c.transitionSeconds ?? 0.5} s)` : 'Add a transition',
        onclick: (e) => { e.stopPropagation(); transitionMenu({ clip: c, x: e.clientX, y: e.clientY }); },
      }, c.transition ? '⧓' : '+'));
    }
  }
  rows.push(h('div', { class: 'tl-track tl-new', 'data-new': '1' }, h('span', { class: 'muted small' }, 'Drop here for a new track')));
  $('#tlTracks').replaceChildren(...rows);
  drawHeads();
  drawRange();
  movePlayhead();
  $('#tlEmpty').hidden = P.doc.clips.length > 0;
  placeEmpty();
  $('#tlEmpty').textContent = P.kind === 'audio' ? 'Drag sounds here, or ask the AI for music, voices and effects' : P.kind === 'image' ? 'Drag pictures here: each track is a layer, the top one in front' : 'Drag clips, pictures and sounds onto any track';
}

function drawHeads() {
  const list = h('div', { class: 'tl-heads-list', id: 'tlHeadsList', style: { transform: `translateY(${-T.scroll.scrollTop}px)` } }, ...tracks().map((t, i) => {
    const sound = t.role === 'audio' || P.doc.clips.some((c) => c.track === t.id && hasSound(c));
    const visual = t.role !== 'audio' || P.doc.clips.some((c) => c.track === t.id && c.kind !== 'audio');
    const btn = (on, title, label, fn, cls = '') => h('button', { class: `tl-hb${on ? ' on' : ''} ${cls}`, title, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
    const el = h('div', { class: `tl-head${t.id === P.selection.track ? ' on' : ''}${t.hidden || t.mute ? ' dim' : ''}`, 'data-track': t.id, style: { height: `${rowH(t)}px`, '--tc': t.color ?? 'var(--accent)' }, title: `${t.name}${t.magnetic ? ' (magnetic: clips sit back to back)' : ''}` },
      h('span', { class: 'tl-dot' }), icon(t.magnetic ? 'magnet' : ROLE_ICON[t.role] ?? 'layers'),
      h('span', { class: 'tl-name' }, t.name),
      h('span', { class: 'tl-hbs' },
        visual ? btn(t.hidden, t.hidden ? 'Show' : 'Hide', icon(t.hidden ? 'eyeOff' : 'eye'), () => setTrack(t.id, { hidden: !t.hidden })) : '',
        sound ? btn(t.mute, 'Mute', 'M', () => setTrack(t.id, { mute: !t.mute }), 'ms') : '',
        sound ? btn(t.solo, 'Solo', 'S', () => setTrack(t.id, { solo: !t.solo }), 'ms solo') : '',
        btn(t.locked, t.locked ? 'Unlock' : 'Lock', icon(t.locked ? 'lock' : 'unlock'), () => setTrack(t.id, { locked: !t.locked })),
        btn(false, 'Track menu', icon('more'), () => trackMenu(t, i, el))));
    el.addEventListener('click', () => { P.selection.track = t.id; bus.emit('selection'); });
    el.addEventListener('dblclick', () => renameTrack(t, el));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(t, i, el, e); });
    return el;
  }));
  $('#tlHeads').replaceChildren(h('div', { class: 'tl-head-ruler' }, h('button', { class: 'icon-btn small', id: 'addTrackBtnHead', title: 'Add a track', onclick: (e) => newTrackMenu(e.currentTarget) }, icon('plus'), h('span', {}, 'Track'))), h('div', { class: 'tl-heads-clip' }, list));
}

function renameTrack(t, el) {
  const name = el.querySelector('.tl-name');
  const input = h('input', { class: 'tl-name-input', value: t.name, maxlength: '40' });
  name.replaceWith(input);
  input.focus(); input.select();
  const done = (keep) => { if (keep && input.value.trim() && input.value.trim() !== t.name) setTrack(t.id, { name: input.value.trim() }); else render(); };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function trackMenu(t, i, el, e) {
  const r = el.getBoundingClientRect();
  const slider = (label, v, min, max, step, fn, fmtV) => {
    const out = h('span', { class: 'muted small' }, fmtV(v));
    const s = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(v) });
    let first = true;
    s.addEventListener('input', () => { out.textContent = fmtV(Number(s.value)); fn(Number(s.value), first); first = false; });
    s.addEventListener('change', () => { first = true; });
    return h('label', { class: 'menu-row tl-slider' }, h('span', {}, label), s, out);
  };
  const sound = t.role === 'audio' || P.doc.clips.some((c) => c.track === t.id && hasSound(c));
  popMenu(e?.clientX ?? r.right, e?.clientY ?? r.top, [
    h('div', { class: 'menu-title' }, t.name),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); renameTrack(t, $(`#tlHeads .tl-head[data-track="${t.id}"]`) ?? el); } }, 'Rename'),
    sound ? slider('Volume', t.volume ?? 1, 0, 2, 0.01, (v, first) => setTrack(t.id, { volume: v === 1 ? null : v }, { history: first }), (v) => `${Math.round(v * 100)}%`) : '',
    sound ? slider('Pan', t.pan ?? 0, -1, 1, 0.05, (v, first) => setTrack(t.id, { pan: v || null }, { history: first }), (v) => (Math.abs(v) < 0.03 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)) : '',
    h('button', { class: `menu-item${t.magnetic ? ' on' : ''}`, onclick: () => { closeMenus(); setTrack(t.id, { magnetic: !t.magnetic }); } }, t.magnetic ? 'Magnetic: on (clips sit back to back)' : 'Make magnetic (clips back to back)'),
    h('div', { class: 'menu-sep' }),
    h('button', { class: 'menu-item', disabled: i === 0, onclick: () => { closeMenus(); moveTrack(t.id, -1); } }, 'Move up (draws over more)'),
    h('button', { class: 'menu-item', disabled: i === tracks().length - 1, onclick: () => { closeMenus(); moveTrack(t.id, 1); } }, 'Move down'),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); addTrack({ name: 'Track', role: t.role === 'main' ? 'video' : t.role, at: i }); } }, 'Add a track above'),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); addTrack({ name: 'Track', role: t.role === 'main' ? 'video' : t.role, at: i + 1 }); } }, 'Add a track below'),
    h('div', { class: 'menu-sep' }),
    h('button', { class: 'menu-item danger', onclick: () => {
      closeMenus();
      const n = P.doc.clips.filter((c) => c.track === t.id).length;
      if (n && !confirm(`Remove "${t.name}" and its ${n} clip${n === 1 ? '' : 's'}?`)) return;
      removeTrack(t.id);
    } }, 'Remove the track'),
  ]);
}
function newTrackMenu(btn) {
  const r = btn.getBoundingClientRect();
  popMenu(r.left, r.bottom + 4, [h('div', { class: 'menu-title' }, 'New track'),
    ...Object.entries(ROLE_WORDS).map(([role, label]) => h('button', { class: 'menu-item', onclick: () => {
      closeMenus();
      const sel = tracks().findIndex((t) => t.id === P.selection.track);
      addTrack({ name: { any: 'Layer', video: 'Video', text: 'Text', audio: 'Sound' }[role], role, ...(sel >= 0 && role !== 'audio' ? { at: sel } : {}) });
    } }, h('span', { class: 'row' }, icon(ROLE_ICON[role]), label)))]);
}

function clipEl(c) {
  const sel = P.selection.clips.has(c.id);
  const tr = trackOf(c.track);
  const el = h('div', {
    class: `clip kind-${c.kind}${sel ? ' selected' : ''}${c.pending ? ' pending' : ''}${c.failed ? ' failed' : ''}${c.scene ? ' linked' : ''}`, 'data-id': c.id,
    style: { left: `${xOf(c.start)}px`, width: `${Math.max(6, xOf(clipLength(c)))}px`, ...(c.kind === 'fill' ? { '--fill': c.color ?? '#000' } : {}) },
    title: c.failed ? `Couldn't make this: ${c.failed}` : c.label ?? c.text ?? '',
  });
  const label = c.kind === 'text' ? c.text : c.kind === 'fill' ? `Color ${c.color ?? ''}` : c.pending ? `${PROGRESS.get(c.job) ?? 'Making'} · ${c.label ?? ''}` : c.failed ? `Couldn't make it · ${c.label ?? ''}` : c.label ?? '';
  if (c.asset && (c.kind === 'video' || c.kind === 'image')) {
    const strip = h('div', { class: 'clip-thumbs' });
    thumb(c.asset, c.kind).then((u) => { if (u) strip.style.backgroundImage = `url("${u}")`; });
    el.append(strip);
  }
  if (c.asset && c.kind === 'audio') {
    const cv = h('canvas', { class: 'clip-wave' });
    el.append(cv);
    peaks(c.asset).then((p) => drawWave(cv, p, c));
  }
  if (c.fadeIn) el.append(h('span', { class: 'clip-fade in', style: { width: `${xOf(c.fadeIn)}px` } }));
  if (c.fadeOut) el.append(h('span', { class: 'clip-fade out', style: { width: `${xOf(c.fadeOut)}px` } }));
  el.append(h('div', { class: 'clip-label' }, c.scene ? '🔗 ' : '', (c.speed && c.speed !== 1) ? `${c.speed}× ` : '', c.muted ? '🔇 ' : '', label));
  if (!c.pending && !tr?.locked) el.append(h('div', { class: 'h-l', title: 'Drag to trim the start' }), h('div', { class: 'h-r', title: 'Drag to trim the end' }));
  // Sound fades by dragging a dot at the top corners (no seconds to type).
  if (hasSound(c) && c.asset && !c.pending && !tr?.locked) {
    for (const side of ['in', 'out']) {
      const key = side === 'in' ? 'fadeIn' : 'fadeOut';
      const dot = h('span', { class: `fade-h ${side}`, title: side === 'in' ? 'Drag to fade in' : 'Drag to fade out', style: { [side === 'in' ? 'left' : 'right']: `${Math.max(0, xOf(c[key] ?? 0) - 5)}px` } });
      dot.addEventListener('pointerdown', (e) => fadeDrag(e, c, side, dot));
      el.append(dot);
    }
  }
  el.addEventListener('pointerdown', (e) => clipPointer(e, c));
  el.addEventListener('dblclick', () => { if (c.kind === 'text') bus.emit('editText', c); else if (c.scene) import('./scenes.js').then((s) => s.openScene(c.scene)); else bus.emit('openClip', c); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); select(c, e); bus.emit('clipMenu', { clip: c, x: e.clientX, y: e.clientY }); });
  return el;
}

function drawWave(cv, p, c) {
  if (!p || !cv.isConnected) return;
  const w = cv.clientWidth, hh = cv.clientHeight;
  cv.width = w; cv.height = hh;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  const n = p.values.length;
  for (let x = 0; x < w; x++) {
    const src = c.in + (x / w) * (c.out - c.in);
    const v = p.values[Math.min(n - 1, Math.floor((src / p.duration) * n))] ?? 0;
    const bar = Math.max(1, v * (c.volume ?? 1) * hh * 0.9);
    ctx.fillRect(x, (hh - bar) / 2, 1, bar);
  }
}

function select(c, e) {
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    if (P.selection.clips.has(c.id)) P.selection.clips.delete(c.id); else P.selection.clips.add(c.id);
  } else if (!P.selection.clips.has(c.id)) {
    P.selection.clips.clear();
    P.selection.clips.add(c.id);
  }
  P.selection.track = c.track;
  bus.emit('selection');
  bus.emit('inspect');
}

/** Dragging a fade dot: the fade grows toward the middle of the clip (up to half of it). One undo step. */
function fadeDrag(e, c, side, dot) {
  e.stopPropagation();
  e.preventDefault();
  const key = side === 'in' ? 'fadeIn' : 'fadeOut';
  const x0 = e.clientX, v0 = c[key] ?? 0;
  const max = clipLength(c) / 2;
  let v = v0;
  const shade = dot.parentElement.querySelector(`.clip-fade.${side}`) ?? dot.parentElement.appendChild(h('span', { class: `clip-fade ${side}` }));
  const move = (ev) => {
    v = Math.round(Math.min(max, Math.max(0, v0 + ((side === 'in' ? 1 : -1) * (ev.clientX - x0)) / T.z)) * 10) / 10;
    dot.style[side === 'in' ? 'left' : 'right'] = `${Math.max(0, xOf(v) - 5)}px`;
    shade.style.width = `${xOf(v)}px`;
    dot.title = v ? `Fade ${side} ${fmt(v, 1)}` : side === 'in' ? 'Drag to fade in' : 'Drag to fade out';
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (v !== v0) setClip(c.id, { [key]: v || null }); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/** Snap a time to the playhead, 0, and other clips' edges within 8 px. */
function snapT(t, except) {
  if (!T.snap) return t;
  const pts = [0, P.playhead];
  for (const c of P.doc.clips) if (c.id !== except) pts.push(c.start, clipEnd(c));
  let best = t, d = 8 / T.z;
  for (const p of pts) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; }
  return best;
}

/** A clip under the pointer: the body moves it (to any unlocked track; a magnetic one reorders), an edge trims it. */
function clipPointer(e, c) {
  if (e.button > 0) return;
  e.stopPropagation();
  const handle = e.target.classList.contains('h-l') ? 'l' : e.target.classList.contains('h-r') ? 'r' : null;
  select(c, e);
  if (c.pending || trackOf(c.track)?.locked) return;
  // Selecting drew the timeline again: drag the clip's new element.
  const el = $(`#tlTracks .clip[data-id="${c.id}"]`) ?? e.currentTarget;
  const x0 = e.clientX, y0 = e.clientY;
  const orig = { start: c.start, in: c.in, out: c.out, track: c.track };
  let active = false;
  const maxOut = c.kind === 'video' || c.kind === 'audio' ? c.duration ?? Infinity : Infinity;
  const sp = c.speed || 1;
  let marker = null, targetIndex = null, targetTrack = c.track;
  const room = neighbours(c);
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (!active && Math.abs(dx) < 4 && Math.abs(ev.clientY - y0) < 6) return;
    active = true;
    const dt = dx / T.z;
    if (handle === 'r') {
      const end = Math.min(snapT(orig.start + (orig.out - orig.in) / sp + dt, c.id), isMagnetic(c.track) ? Infinity : room.after);
      c.out = Math.min(maxOut, Math.max(orig.in + 0.1, orig.in + (end - orig.start) * sp));
      el.style.width = `${xOf(clipLength(c))}px`;
      return;
    }
    if (handle === 'l') {
      const mag = isMagnetic(c.track);
      let inn = orig.in + (mag ? dt : Math.max(room.before, snapT(orig.start + dt, c.id)) - orig.start) * sp;
      inn = Math.max(isStill(c) ? -Infinity : 0, Math.min(orig.out - 0.1, inn));
      if (isStill(c)) { c.in = 0; c.out = Math.max(0.1, orig.out - (inn - orig.in)); } else c.in = inn;
      if (!mag) c.start = Math.max(0, orig.start + (inn - orig.in) / sp);
      el.style.left = `${xOf(c.start)}px`;
      el.style.width = `${xOf(clipLength(c))}px`;
      return;
    }
    // Moving: which track it's over (any unlocked one), then where on it.
    const row = trackAt(ev.clientY);
    if (row?.dataset.track && row.dataset.track !== targetTrack && !trackOf(row.dataset.track)?.locked) { targetTrack = row.dataset.track; row.append(el); marker?.remove(); marker = null; }
    if (isMagnetic(targetTrack)) {
      el.style.left = `${xOf(orig.start)}px`;
      el.style.transform = `translateX(${dx}px)`;
      el.classList.add('dragging');
      const t = orig.start + clipLength(c) / 2 + dt;
      const others = onTrack(targetTrack).filter((x) => x.id !== c.id);
      targetIndex = others.findIndex((x) => x.start + clipLength(x) / 2 > t);
      if (targetIndex < 0) targetIndex = others.length;
      const at = targetIndex < others.length ? others[targetIndex].start : others.length ? clipEnd(others[others.length - 1]) : 0;
      marker ??= h('div', { class: 'tl-insert' });
      marker.style.left = `${xOf(at)}px`;
      el.parentElement.append(marker);
    } else {
      el.style.transform = '';
      let s0 = Math.max(0, snapT(orig.start + dt, c.id));
      const snapEnd = snapT(s0 + clipLength(c), c.id) - clipLength(c);
      if (snapEnd !== s0 && T.snap && Math.abs(snapEnd - s0) < 8 / T.z) s0 = Math.max(0, snapEnd);
      // Never inside another clip: it stops against its neighbours, or jumps to the nearest gap it fits.
      c.start = fitStart(targetTrack, s0, clipLength(c), c.id);
      el.style.left = `${xOf(c.start)}px`;
    }
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    marker?.remove();
    if (!active) return;
    const now = { start: c.start, in: c.in, out: c.out };
    Object.assign(c, orig);
    remember();
    Object.assign(c, now);
    c.track = targetTrack;
    if (!handle && isMagnetic(targetTrack)) {
      const others = onTrack(targetTrack).filter((x) => x.id !== c.id);
      const i = targetIndex ?? others.length;
      c.start = i < others.length ? others[i].start - 0.0005 : (others.length ? clipEnd(others[others.length - 1]) + 1 : 0);
    }
    P.selection.track = targetTrack;
    changed();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

/** The transition menu at a join of the main track. */
export function transitionMenu({ clip, x, y }) {
  const opts = [['cut', 'Cut'], ['crossfade', 'Crossfade'], ['dissolve', 'Dissolve'], ['fadeblack', 'Fade through black'], ['fadewhite', 'Fade through white'], ['wipeleft', 'Wipe'], ['slideleft', 'Slide']];
  popMenu(x, y, [
    h('div', { class: 'menu-title' }, 'Into the next clip'),
    ...opts.map(([v, label]) => h('button', { class: `menu-item${(clip.transition ?? 'cut') === v ? ' on' : ''}`, onclick: () => { closeMenus(); setClip(clip.id, v === 'cut' ? { transition: null, transitionSeconds: null } : { transition: v, transitionSeconds: clip.transitionSeconds ?? 0.5 }); } }, label)),
    h('label', { class: 'menu-row' }, 'Length', h('input', { type: 'number', min: '0.1', max: '3', step: '0.1', value: String(clip.transitionSeconds ?? 0.5), onchange: (e) => setClip(clip.id, { transitionSeconds: Number(e.target.value) || 0.5 }) }), 's'),
  ]);
}

export function popMenu(x, y, items) {
  closeMenus();
  const m = h('div', { class: 'menu' }, ...items);
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, x))}px`;
  m.style.top = `${Math.max(8, Math.min(innerHeight - r.height - 8, y))}px`;
  setTimeout(() => addEventListener('pointerdown', outside), 0);
  function outside(e) { if (!m.contains(e.target)) closeMenus(); }
  m._outside = outside;
  return m;
}
export function closeMenus() { $$('.menu').forEach((m) => { removeEventListener('pointerdown', m._outside); m.remove(); }); }

/** Adds a text clip at the playhead (on the selected track, else a text track) and opens it for typing. */
export function addText() {
  const c = addClip({ kind: 'text', start: P.playhead, text: 'Your words' });
  P.selection.clips.clear();
  P.selection.clips.add(c.id);
  bus.emit('selection');
  bus.emit('editText', c);
}

// ------------------------------------------------------------------ lanes another kind lends (a stage)
/**
 * A lender: { length(), playhead(), seek(t), playing(), range(), lanes(): [{ id, name, icon, color, items: [{ id, start,
 * end?, label, kind }] }], move(laneId, itemId, { start, end }), select?(laneId, itemId), selected?() }. Items with an
 * end are bars (drag to move, the right edge to stretch); without one they're points (drag to move).
 */
function renderLanes() {
  const A = lender;
  const len = Math.max(1, A.length());
  const width = Math.max(T.scroll.clientWidth, xOf(len + 1));
  T.canvas.style.width = `${width}px`;
  drawRuler(width);
  const lanes = A.lanes();
  const sel = A.selected?.();
  $('#tlTracks').replaceChildren(...lanes.map((l) => h('div', { class: 'tl-track lane', 'data-lane': l.id, style: { height: '40px', '--tc': l.color ?? 'var(--accent)' } },
    h('div', { class: 'lane-end', style: { left: `${xOf(len)}px` } }),
    ...l.items.map((it) => {
      const bar = it.end != null;
      const el = h('div', { class: `lane-item ${bar ? 'bar' : 'point'} ${it.kind ?? ''}${sel === it.id ? ' selected' : ''}`, style: { left: `${xOf(it.start)}px`, ...(bar ? { width: `${Math.max(8, xOf(it.end - it.start))}px` } : {}) }, title: it.label },
        bar ? h('span', { class: 'lane-label' }, it.label) : '', bar ? h('div', { class: 'h-r' }) : '');
      el.addEventListener('pointerdown', (e) => laneDrag(e, l, it, el));
      return el;
    }))));
  $('#tlHeads').replaceChildren(h('div', { class: 'tl-head-ruler' }), h('div', { class: 'tl-heads-clip' }, h('div', { class: 'tl-heads-list', id: 'tlHeadsList', style: { transform: `translateY(${-T.scroll.scrollTop}px)` } },
    ...lanes.map((l) => h('div', { class: 'tl-head', style: { height: '40px', '--tc': l.color ?? 'var(--accent)' } }, h('span', { class: 'tl-dot' }), icon(l.icon ?? 'layers'), h('span', { class: 'tl-name' }, l.name))))));
  $('#tlEmpty').hidden = lanes.some((l) => l.items.length);
  $('#tlEmpty').textContent = A.empty ?? 'Nothing timed yet';
  drawRange();
  movePlayhead();
  // The lender's clock moves on its own (a stage plays in its own loop): follow it.
  cancelAnimationFrame(T.raf);
  const follow = () => { if (!lender) return; movePlayhead(); T.raf = requestAnimationFrame(follow); };
  T.raf = requestAnimationFrame(follow);
}
function laneDrag(e, lane, it, el) {
  e.stopPropagation();
  lender.select?.(lane.id, it.id);
  const stretch = e.target.classList.contains('h-r');
  const x0 = e.clientX, s0 = it.start, e0 = it.end;
  let moved = false;
  const move = (ev) => {
    const dt = (ev.clientX - x0) / T.z;
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    moved = true;
    const len = lender.length();
    if (stretch) { it.end = Math.min(len, Math.max(s0 + 0.1, e0 + dt)); el.style.width = `${xOf(it.end - it.start)}px`; }
    else {
      const span = e0 != null ? e0 - s0 : 0;
      it.start = Math.max(0, Math.min(len - span, Math.round((s0 + dt) * 10) / 10));
      if (e0 != null) it.end = it.start + span;
      el.style.left = `${xOf(it.start)}px`;
    }
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (moved) lender.move(lane.id, it.id, { start: Math.round(it.start * 10) / 10, ...(it.end != null ? { end: Math.round(it.end * 10) / 10 } : {}) });
    else lender.seek(it.start);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

export { byId };
