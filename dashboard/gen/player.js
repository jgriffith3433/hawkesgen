// The viewer: plays the timeline in the page (V1 through two video elements swapped at cuts, so the next clip is
// already loaded; images as stills; audio clips as their own elements kept in step; text on top), shows one library
// file on its own ("source"), and paints masks for Repaint and Change.

import { $, h, fileUrl, fmt, bus, icon } from './lib.js';
import { P, onTrack, clipEnd, docLength } from './project.js';

const S = { playing: false, t0: 0, p0: 0, source: null, raf: 0, loop: false };
let stage, vids, img, textLayer, audios, painter;

export function initPlayer() {
  stage = $('#stage');
  vids = [h('video', { playsinline: true, preload: 'auto' }), h('video', { playsinline: true, preload: 'auto' })];
  img = h('img', { alt: '', hidden: true });
  textLayer = h('div', { class: 'text-layer' });
  stage.append(...vids, img, textLayer);
  vids.forEach((v) => { v.hidden = true; });
  audios = new Map();
  $('#playBtn').addEventListener('click', toggle);
  $('#stepBack').addEventListener('click', () => seek(P.playhead - 1 / P.doc.fps));
  $('#stepFwd').addEventListener('click', () => seek(P.playhead + 1 / P.doc.fps));
  $('#loopBtn').addEventListener('click', () => { S.loop = !S.loop; $('#loopBtn').classList.toggle('on', S.loop); });
  bus.on('doc', () => { fitStage(); if (!S.playing && !S.source) render(P.playhead, false); });
  new ResizeObserver(fitStage).observe($('#viewer'));
  fitStage();
}

/** The stage keeps the project's shape inside the viewer. */
function fitStage() {
  const box = $('#viewer').getBoundingClientRect();
  const ar = S.source?.ratio ?? P.doc.width / P.doc.height;
  let w = box.width - 24, hh = w / ar;
  if (hh > box.height - 24) { hh = box.height - 24; w = hh * ar; }
  stage.style.width = `${Math.max(40, w)}px`;
  stage.style.height = `${Math.max(40, hh)}px`;
  if (painter) painter.fit();
}

export const isPlaying = () => S.playing;
export function toggle() { S.playing ? pause() : play(); }
export function play() {
  if (S.source) return playSource();
  const len = docLength();
  if (!len) return;
  const r = P.selection.range;
  if (P.playhead >= len - 0.05 || (S.loop && r && (P.playhead < r.start || P.playhead >= r.end))) P.playhead = S.loop && r ? r.start : 0;
  S.playing = true;
  S.t0 = performance.now();
  S.p0 = P.playhead;
  $('#playBtn').innerHTML = '';
  $('#playBtn').append(icon('pause'));
  render(P.playhead, true);
  const tick = () => {
    if (!S.playing) return;
    let t = S.p0 + (performance.now() - S.t0) / 1000;
    const end = S.loop && P.selection.range ? P.selection.range.end : docLength();
    if (t >= end) {
      if (S.loop) { t = P.selection.range?.start ?? 0; S.p0 = t; S.t0 = performance.now(); } else { P.playhead = end; pause(); bus.emit('time', end); return; }
    }
    P.playhead = t;
    render(t, true);
    bus.emit('time', t);
    S.raf = requestAnimationFrame(tick);
  };
  S.raf = requestAnimationFrame(tick);
}
export function pause() {
  S.playing = false;
  cancelAnimationFrame(S.raf);
  vids.forEach((v) => v.pause());
  for (const a of audios.values()) a.pause();
  if (S.source?.el) S.source.el.pause();
  $('#playBtn').innerHTML = '';
  $('#playBtn').append(icon('play'));
}
export function seek(t) {
  if (S.source) { if (S.source.el) S.source.el.currentTime = Math.max(0, t); return; }
  P.playhead = Math.max(0, Math.min(docLength(), t));
  if (S.playing) { S.p0 = P.playhead; S.t0 = performance.now(); }
  render(P.playhead, S.playing);
  bus.emit('time', P.playhead);
}

let front = 0;
/** Shows the timeline at time t. While playing, elements play; while paused, they seek and hold. */
function render(t, playing) {
  if (S.source) return;
  $('#timecode').textContent = `${fmt(t, 2)} / ${fmt(docLength(), 2)}`;
  const v1 = onTrack('V1');
  const cur = v1.find((c) => t >= c.start && t < clipEnd(c)) ?? (t >= docLength() - 0.001 ? v1[v1.length - 1] : null);
  const next = cur ? v1[v1.indexOf(cur) + 1] : null;
  $('#stageEmpty').hidden = v1.length > 0;
  if (!cur || !cur.asset) {
    vids.forEach((v) => { v.hidden = true; v.pause(); });
    img.hidden = true;
    $('#stagePending').hidden = !cur?.pending;
  } else {
    $('#stagePending').hidden = true;
    const local = cur.in + (Math.min(t, clipEnd(cur) - 0.001) - cur.start) * (cur.speed || 1);
    if (cur.kind === 'image') {
      vids.forEach((v) => { v.hidden = true; v.pause(); });
      if (img.dataset.asset !== cur.asset) { img.src = fileUrl(cur.asset); img.dataset.asset = cur.asset; }
      img.hidden = false;
      applyZoom(img, cur, t);
    } else {
      img.hidden = true;
      let v = vids[front];
      if (v.dataset.asset !== cur.asset) {
        const other = vids[1 - front];
        if (other.dataset.asset === cur.asset) { front = 1 - front; v = other; } else {
          v.src = fileUrl(cur.asset);
          v.dataset.asset = cur.asset;
          // A paused, fresh video shows nothing until it seeks once its data is in.
          v.addEventListener('loadeddata', () => { if (!S.playing && !S.source) { v.currentTime = Math.max(0.001, local); } }, { once: true });
        }
      }
      vids[1 - front].hidden = true;
      vids[1 - front].pause();
      v.hidden = false;
      v.muted = Boolean(cur.muted);
      v.volume = Math.min(1, cur.volume ?? 1);
      v.playbackRate = cur.speed || 1;
      if (playing) {
        if (Math.abs(v.currentTime - local) > 0.25) v.currentTime = local;
        if (v.paused) v.play().catch(() => {});
      } else {
        v.pause();
        if (Math.abs(v.currentTime - local) > 0.02) v.currentTime = local;
      }
      applyZoom(v, cur, t);
      // Load the next clip in the hidden element so the cut is instant.
      const back = vids[1 - front];
      if (next?.asset && next.kind !== 'image' && back.dataset.asset !== next.asset) { back.src = fileUrl(next.asset); back.dataset.asset = next.asset; back.currentTime = next.in; }
    }
  }
  // Audio clips on A1..A3.
  const live = new Set();
  for (const c of P.doc.clips) {
    if (!['A1', 'A2', 'A3'].includes(c.track) || !c.asset) continue;
    const inside = t >= c.start && t < clipEnd(c);
    if (!inside) continue;
    live.add(c.id);
    let a = audios.get(c.id);
    if (!a || a.dataset.asset !== c.asset) { a = new Audio(fileUrl(c.asset)); a.dataset.asset = c.asset; audios.set(c.id, a); }
    a.muted = Boolean(c.muted);
    a.volume = Math.min(1, c.volume ?? 1);
    const local = c.in + (t - c.start) * (c.speed || 1);
    if (playing) { if (Math.abs(a.currentTime - local) > 0.3) a.currentTime = local; if (a.paused) a.play().catch(() => {}); } else a.pause();
  }
  for (const [id, a] of audios) if (!live.has(id)) a.pause();
  // Text on screen.
  const texts = P.doc.clips.filter((c) => c.track === 'T1' && t >= c.start && t < clipEnd(c));
  textLayer.replaceChildren(...texts.map((c) => h('div', { class: 'caption' }, c.text ?? '')));
}
function applyZoom(el, c, t) {
  const z = c.zoom;
  if (!z) { el.style.transform = ''; return; }
  const k = Math.min(1, Math.max(0, (t - c.start) / Math.max(0.01, clipEnd(c) - c.start)));
  const s = (z.from ?? 1) + ((z.to ?? 1) - (z.from ?? 1)) * k;
  el.style.transformOrigin = `${(z.x ?? 0.5) * 100}% ${(z.y ?? 0.5) * 100}%`;
  el.style.transform = `scale(${s})`;
}

// ------------------------------------------------------------------ one file on its own
/** Shows one library file in the viewer (not the timeline): a still, a clip with its own controls, or a sound. */
export async function showSource(asset) {
  pause();
  S.source = { ...asset, ratio: (asset.width && asset.height) ? asset.width / asset.height : P.doc.width / P.doc.height };
  vids.forEach((v) => { v.hidden = true; });
  img.hidden = true;
  textLayer.replaceChildren();
  $('#stageEmpty').hidden = true;
  $('#stagePending').hidden = true;
  const old = $('#sourceEl');
  old?.remove();
  let el;
  if (asset.kind === 'image') el = h('img', { id: 'sourceEl', src: fileUrl(asset.id), alt: '' });
  else if (asset.kind === 'video') el = h('video', { id: 'sourceEl', src: fileUrl(asset.id), playsinline: true, preload: 'auto' });
  else if (asset.kind === 'audio') el = h('div', { id: 'sourceEl', class: 'source-audio' }, icon('music', 'ico big'), h('audio', { src: fileUrl(asset.id), controls: true }));
  else if (asset.kind === 'mesh') {
    // 3D models (GLB) turn in Google's <model-viewer>, loaded the first time one is opened.
    loadModelViewer();
    S.source.ratio = 4 / 3;
    el = h('model-viewer', { id: 'sourceEl', class: 'source-mesh', src: fileUrl(asset.id), 'camera-controls': true, 'auto-rotate': true, loading: 'eager', 'shadow-intensity': '1', exposure: '1', 'environment-image': 'neutral', alt: asset.title || '3D model' });
  } else el = h('div', { id: 'sourceEl', class: 'source-audio source-file' }, icon('folder', 'ico big'), h('a', { class: 'btn primary', href: fileUrl(asset.id), download: '' }, 'Download'));
  stage.append(el);
  S.source.el = el.tagName === 'VIDEO' ? el : el.querySelector?.('audio') ?? null;
  if (el.tagName === 'VIDEO') {
    el.addEventListener('loadedmetadata', () => { S.source.ratio = el.videoWidth / el.videoHeight; fitStage(); });
    el.addEventListener('timeupdate', () => { $('#timecode').textContent = `${fmt(el.currentTime, 2)} / ${fmt(el.duration, 2)}`; });
  }
  if (el.tagName === 'IMG') el.addEventListener('load', () => { S.source.ratio = el.naturalWidth / el.naturalHeight; fitStage(); });
  $('#viewerMode').hidden = false;
  $('#viewerModeLabel').textContent = asset.title || ({ image: 'Image', video: 'Clip', audio: 'Sound', mesh: '3D model' }[asset.kind] ?? 'File');
  fitStage();
  bus.emit('source', S.source);
}
let mvLoading = null;
function loadModelViewer() {
  if (customElements.get('model-viewer') || mvLoading) return;
  mvLoading = h('script', { type: 'module', src: 'https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js' });
  document.head.append(mvLoading);
}
export function closeSource() {
  if (!S.source) return;
  pause();
  $('#sourceEl')?.remove();
  S.source = null;
  $('#viewerMode').hidden = true;
  fitStage();
  render(P.playhead, false);
  bus.emit('source', null);
}
export const currentSource = () => S.source;
function playSource() {
  const el = S.source?.el;
  if (!el) return;
  S.playing = true;
  $('#playBtn').innerHTML = '';
  $('#playBtn').append(icon('pause'));
  el.play().catch(() => {});
  el.onended = () => pause();
}

// ------------------------------------------------------------------ painting a mask
/**
 * Paints a mask over what the viewer shows. `onDone(canvas)` gets a black-and-white mask at the media's own size
 * (white = the area to change). Returns a handle to close it.
 */
export function startPainter({ width, height, onChange }) {
  stopPainter();
  pause();
  const view = h('canvas', { class: 'paint-view' });
  const mask = h('canvas', { width, height });
  const mctx = mask.getContext('2d');
  mctx.fillStyle = '#000'; mctx.fillRect(0, 0, width, height);
  const vctx = view.getContext('2d');
  let size = 0.06, erase = false, drawing = false, last = null, empty = true;
  stage.append(view);
  stage.classList.add('painting');
  const fit = () => {
    const r = stage.getBoundingClientRect();
    view.width = Math.round(r.width); view.height = Math.round(r.height);
    redraw();
  };
  function redraw() {
    vctx.clearRect(0, 0, view.width, view.height);
    vctx.globalAlpha = 0.55;
    vctx.drawImage(overlay, 0, 0, view.width, view.height);
    vctx.globalCompositeOperation = 'source-in';
    vctx.fillStyle = '#ff4d6d'; vctx.fillRect(0, 0, view.width, view.height);
    vctx.globalCompositeOperation = 'source-over';
    vctx.globalAlpha = 1;
  }
  // The red overlay is drawn from a copy where black is transparent.
  const overlay = h('canvas', { width, height });
  const octx = overlay.getContext('2d');
  function stroke(a, b) {
    const r = size * Math.min(width, height) / 2;
    for (const ctx of [mctx, octx]) {
      ctx.globalCompositeOperation = ctx === octx && erase ? 'destination-out' : 'source-over';
      ctx.strokeStyle = ctx === mctx ? (erase ? '#000' : '#fff') : '#fff';
      ctx.lineWidth = r * 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    if (!erase) empty = false;
    vctx.clearRect(0, 0, view.width, view.height);
    vctx.globalAlpha = 0.55;
    vctx.drawImage(overlay, 0, 0, view.width, view.height);
    vctx.globalCompositeOperation = 'source-in';
    vctx.fillStyle = '#ff4d6d'; vctx.fillRect(0, 0, view.width, view.height);
    vctx.globalCompositeOperation = 'source-over';
    vctx.globalAlpha = 1;
    onChange?.(!empty);
  }
  const at = (e) => { const r = view.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height }; };
  view.addEventListener('pointerdown', (e) => { drawing = true; view.setPointerCapture(e.pointerId); last = at(e); stroke(last, last); });
  view.addEventListener('pointermove', (e) => { if (!drawing) return; const p = at(e); stroke(last, p); last = p; });
  view.addEventListener('pointerup', () => { drawing = false; });
  fit();
  painter = {
    fit,
    setSize(v) { size = v; },
    setErase(v) { erase = v; },
    clear() { mctx.fillStyle = '#000'; mctx.fillRect(0, 0, width, height); octx.clearRect(0, 0, width, height); empty = true; vctx.clearRect(0, 0, view.width, view.height); onChange?.(false); },
    isEmpty: () => empty,
    canvas: mask,
    close() { view.remove(); stage.classList.remove('painting'); painter = null; },
  };
  return painter;
}
export function stopPainter() { painter?.close(); }
