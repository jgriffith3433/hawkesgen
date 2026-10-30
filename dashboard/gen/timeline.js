// The timeline: a ruler and playhead, the tracks (V1 main video, magnetic; T1 text; A1-A3 audio), clips with
// thumbnails or waveforms, drag to move (V1 reorders), edge handles to trim, snapping, a selected time range (the AI
// editor sees it), transitions at V1's joins, zoom, and drops from the media pane.

import { $, $$, h, fmt, bus, icon, thumb, peaks } from './lib.js';
import { P, TRACKS, onTrack, clipLength, clipEnd, docLength, byId, remember, changed, addClip, setClip } from './project.js';
import { seek, isPlaying, pause } from './player.js';

const T = { z: 60, snap: true, heads: null, scroll: null, canvas: null };
const MIN_Z = 6, MAX_Z = 480;
const xOf = (t) => t * T.z;
const tOf = (x) => x / T.z;

export function initTimeline() {
  T.scroll = $('#tlScroll');
  T.canvas = $('#tlCanvas');
  $('#tlHeads').replaceChildren(h('div', { class: 'tl-head-ruler' }), ...TRACKS.map((t) => h('div', { class: `tl-head track-${t.kind}`, 'data-track': t.id },
    icon(t.kind === 'video' ? 'film' : t.kind === 'text' ? 'text' : t.id === 'A1' ? 'music' : t.id === 'A2' ? 'mic' : 'volume'), h('span', {}, t.name))));
  $('#zoomIn').addEventListener('click', () => zoomTo(T.z * 1.5));
  $('#zoomOut').addEventListener('click', () => zoomTo(T.z / 1.5));
  $('#zoomFit').addEventListener('click', fit);
  $('#snapBtn').addEventListener('click', () => { T.snap = !T.snap; $('#snapBtn').classList.toggle('on', T.snap); });
  $('#snapBtn').classList.toggle('on', T.snap);
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
    if (e.shiftKey) return rangeDrag(e, t0);
    if (isPlaying()) pause();
    seek(t0);
    const move = (ev) => seek(Math.max(0, tOf(ev.clientX - r.left)));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  // Empty track area: clear the selection; drag to select a time range.
  $('#tlTracks').addEventListener('pointerdown', (e) => {
    if (e.target.closest('.clip, .tl-join')) return;
    const r = T.canvas.getBoundingClientRect();
    const t0 = Math.max(0, tOf(e.clientX - r.left));
    P.selection.clips.clear();
    P.selection.range = null;
    seek(t0);
    bus.emit('selection');
    rangeDrag(e, t0);
  });
  // Drops from the media pane (and files from the desktop: gen.js handles those).
  $('#tlTracks').addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('application/x-hg-asset')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const row = trackAt(e.clientY);
    $$('.tl-track').forEach((x) => x.classList.toggle('drop', x === row));
  });
  $('#tlTracks').addEventListener('dragleave', () => $$('.tl-track').forEach((x) => x.classList.remove('drop')));
  $('#tlTracks').addEventListener('drop', (e) => {
    const raw = e.dataTransfer.getData('application/x-hg-asset');
    $$('.tl-track').forEach((x) => x.classList.remove('drop'));
    if (!raw) return;
    e.preventDefault();
    const a = JSON.parse(raw);
    const r = T.canvas.getBoundingClientRect();
    const t = Math.max(0, tOf(e.clientX - r.left));
    let track = trackAt(e.clientY)?.dataset.track ?? 'V1';
    if (a.kind === 'audio' && !track.startsWith('A')) track = 'A1';
    if (a.kind !== 'audio') track = 'V1';
    bus.emit('placeAsset', { asset: a, track, start: t });
  });
  bus.on('doc', render);
  bus.on('selection', render);
  bus.on('time', movePlayhead);
  render();
}

function trackAt(y) { return $$('.tl-track').find((row) => { const r = row.getBoundingClientRect(); return y >= r.top && y < r.bottom; }) ?? null; }

function rangeDrag(e, t0) {
  const r = T.canvas.getBoundingClientRect();
  let moved = false;
  const move = (ev) => {
    const t1 = Math.max(0, tOf(ev.clientX - r.left));
    if (!moved && Math.abs(t1 - t0) * T.z < 4) return;
    moved = true;
    P.selection.range = { start: Math.min(t0, t1), end: Math.max(t0, t1) };
    drawRange();
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (moved) bus.emit('selection');
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

export function zoomTo(z, at = P.playhead, px = null) {
  const old = T.z;
  T.z = Math.min(MAX_Z, Math.max(MIN_Z, z));
  if (T.z === old) return;
  render();
  const left = px ?? T.scroll.clientWidth / 3;
  T.scroll.scrollLeft = Math.max(0, xOf(at) - left);
}
export function fit() {
  const len = Math.max(5, docLength());
  T.z = Math.min(MAX_Z, Math.max(MIN_Z, (T.scroll.clientWidth - 40) / len));
  render();
  T.scroll.scrollLeft = 0;
}

function movePlayhead() {
  $('#tlPlayhead').style.transform = `translateX(${xOf(P.playhead)}px)`;
  // Keep the playhead in view while playing.
  if (isPlaying()) {
    const x = xOf(P.playhead) - T.scroll.scrollLeft;
    if (x > T.scroll.clientWidth - 40 || x < 0) T.scroll.scrollLeft = xOf(P.playhead) - 60;
  }
}

function drawRange() {
  const el = $('#tlRange');
  const r = P.selection.range;
  el.hidden = !r;
  if (r) {
    el.style.left = `${xOf(r.start)}px`;
    el.style.width = `${Math.max(2, xOf(r.end - r.start))}px`;
    el.dataset.label = `${fmt(r.end - r.start, 1)} selected`;
  }
}

/** Ruler ticks at a spacing that reads well at this zoom. */
function drawRuler(width) {
  const ruler = $('#tlRuler');
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const major = steps.find((s) => s * T.z >= 70) ?? 600;
  const minor = steps.slice().reverse().find((s) => s < major && s * T.z >= 10) ?? major;
  const out = [];
  for (let t = 0; t * T.z <= width; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    out.push(h('div', { class: `tick${isMajor ? ' major' : ''}`, style: { left: `${xOf(t)}px` } }, isMajor ? fmt(t, major < 1 ? 1 : 0) : ''));
  }
  ruler.replaceChildren(...out);
}

export function render() {
  const len = docLength();
  const width = Math.max(T.scroll.clientWidth, xOf(len + 10));
  T.canvas.style.width = `${width}px`;
  drawRuler(width);
  const rows = TRACKS.map((t) => h('div', { class: `tl-track track-${t.kind}`, 'data-track': t.id }));
  for (const c of P.doc.clips) {
    const row = rows.find((r) => r.dataset.track === c.track);
    if (row) row.append(clipEl(c));
  }
  // Transitions between V1 clips.
  const v1 = onTrack('V1');
  for (let i = 0; i < v1.length - 1; i++) {
    const c = v1[i];
    rows[0].append(h('button', {
      class: `tl-join${c.transition ? ' on' : ''}`, style: { left: `${xOf(clipEnd(c))}px` }, title: c.transition ? `${c.transition} (${c.transitionSeconds ?? 0.5} s)` : 'Add a transition',
      onclick: (e) => { e.stopPropagation(); bus.emit('transitionMenu', { clip: c, x: e.clientX, y: e.clientY }); },
    }, c.transition ? '⧓' : '+'));
  }
  $('#tlTracks').replaceChildren(...rows);
  drawRange();
  movePlayhead();
  $('#tlEmpty').hidden = P.doc.clips.length > 0;
}

function clipEl(c) {
  const sel = P.selection.clips.has(c.id);
  const el = h('div', {
    class: `clip kind-${c.kind}${sel ? ' selected' : ''}${c.pending ? ' pending' : ''}${c.failed ? ' failed' : ''}`, 'data-id': c.id,
    style: { left: `${xOf(c.start)}px`, width: `${Math.max(6, xOf(clipLength(c)))}px` },
    title: c.failed ? `Couldn't make this: ${c.failed}` : c.label ?? c.text ?? '',
  });
  const label = c.kind === 'text' ? c.text : c.pending ? `Generating… ${c.label ?? ''}` : c.failed ? `Failed: ${c.label ?? ''}` : c.label ?? '';
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
  el.append(h('div', { class: 'clip-label' }, (c.speed && c.speed !== 1) ? `${c.speed}× ` : '', c.muted ? '🔇 ' : '', label));
  if (!c.pending) el.append(h('div', { class: 'h-l' }), h('div', { class: 'h-r' }));
  el.addEventListener('pointerdown', (e) => clipPointer(e, c));
  el.addEventListener('dblclick', () => { if (c.kind === 'text') bus.emit('editText', c); else bus.emit('openClip', c); });
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
    const bar = Math.max(1, v * hh * 0.9);
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
  bus.emit('selection');
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

function clipPointer(e, c) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const handle = e.target.classList.contains('h-l') ? 'l' : e.target.classList.contains('h-r') ? 'r' : null;
  select(c, e);
  if (c.pending) return;
  const el = e.currentTarget;
  const x0 = e.clientX;
  const orig = { start: c.start, in: c.in, out: c.out };
  let active = false;
  const maxOut = c.kind === 'video' || c.kind === 'audio' ? c.duration ?? Infinity : Infinity;
  const sp = c.speed || 1;
  let marker = null, targetIndex = null, targetTrack = c.track;
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (!active && Math.abs(dx) < 4) return;
    active = true;
    const dt = dx / T.z;
    if (handle === 'r') {
      let end = snapT(orig.start + (orig.out - orig.in) / sp + dt, c.id);
      let out = orig.in + (end - orig.start) * sp;
      out = Math.min(maxOut, Math.max(orig.in + 0.1, out));
      c.out = out;
      el.style.width = `${xOf(clipLength(c))}px`;
    } else if (handle === 'l') {
      let inn = orig.in + (c.track === 'V1' ? dt : snapT(orig.start + dt, c.id) - orig.start) * sp;
      inn = Math.max(c.kind === 'image' || c.kind === 'text' ? -Infinity : 0, Math.min(orig.out - 0.1, inn));
      if (c.kind === 'image' || c.kind === 'text') { c.in = 0; c.out = Math.max(0.1, orig.out - (inn - orig.in)); } else c.in = inn;
      if (c.track !== 'V1') c.start = Math.max(0, orig.start + (inn - orig.in) / sp);
      el.style.left = `${xOf(c.start)}px`;
      el.style.width = `${xOf(clipLength(c))}px`;
    } else if (c.track === 'V1') {
      // Reorder: show where it would go.
      el.style.transform = `translateX(${dx}px)`;
      el.classList.add('dragging');
      const t = orig.start + clipLength(c) / 2 + dt;
      const others = onTrack('V1').filter((x) => x.id !== c.id);
      targetIndex = others.findIndex((x) => x.start + clipLength(x) / 2 > t);
      if (targetIndex < 0) targetIndex = others.length;
      const at = targetIndex < others.length ? others[targetIndex].start : others.length ? clipEnd(others[others.length - 1]) : 0;
      marker ??= h('div', { class: 'tl-insert' });
      marker.style.left = `${xOf(at)}px`;
      el.parentElement.append(marker);
    } else {
      c.start = Math.max(0, snapT(orig.start + dt, c.id));
      const snapEnd = snapT(c.start + clipLength(c), c.id) - clipLength(c);
      if (snapEnd !== c.start && T.snap && Math.abs(snapEnd - c.start) < 8 / T.z) c.start = Math.max(0, snapEnd);
      el.style.left = `${xOf(c.start)}px`;
      // Audio can change between audio tracks; text stays on T1.
      if (c.kind === 'audio') {
        const row = trackAt(ev.clientY);
        if (row && row.dataset.track.startsWith('A') && row.dataset.track !== targetTrack) { targetTrack = row.dataset.track; row.append(el); }
      }
    }
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    marker?.remove();
    if (!active) return;
    const now = { start: c.start, in: c.in, out: c.out };
    Object.assign(c, orig);
    remember();
    Object.assign(c, now);
    if (c.track === 'V1' && !handle && targetIndex != null) {
      const others = onTrack('V1').filter((x) => x.id !== c.id);
      c.start = targetIndex < others.length ? others[targetIndex].start - 0.0005 : (others.length ? clipEnd(others[others.length - 1]) + 1 : 0);
    }
    if (targetTrack !== c.track) c.track = targetTrack;
    changed();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/** The transition menu at a V1 join. */
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
  m.style.left = `${Math.min(innerWidth - r.width - 8, x)}px`;
  m.style.top = `${Math.min(innerHeight - r.height - 8, y)}px`;
  setTimeout(() => addEventListener('pointerdown', outside), 0);
  function outside(e) { if (!m.contains(e.target)) closeMenus(); }
  m._outside = outside;
  return m;
}
export function closeMenus() { $$('.menu').forEach((m) => { removeEventListener('pointerdown', m._outside); m.remove(); }); }

/** Adds a text clip at the playhead and opens it for typing. */
export function addText() {
  const c = addClip({ track: 'T1', start: P.playhead, text: 'Your words' });
  P.selection.clips.clear();
  P.selection.clips.add(c.id);
  bus.emit('selection');
  bus.emit('editText', c);
}

export { byId };
