// The center: the timeline drawn live at the playhead (J, 2026-10-29: "the center should always be the visualization of
// what you are scrubbed on"). One canvas at the scene's size: every visible track from the bottom up (a higher track
// draws over the ones below), each clip placed, sized, turned, faded and blended, transitions at the main track's
// joins, text drawn in. Sound goes through WebAudio: each clip's gain and fades, its track's volume and pan, mute and
// solo, into one analyser, which an audio scene's center shows (the waveforms around the playhead, the spectrum while it
// plays, and the words being said). The selected clip has handles on the canvas: drag to move, a corner to size, the top
// to turn. It also shows one library file on its own ("source") and paints masks for Repaint and Change; and it renders
// a frame (an image scene's export), the mix (an audio scene's), or the whole timeline in real time (a video export).

import { $, h, fileUrl, fmt, bus, icon, peaks } from './lib.js';
import { P, tracks, trackOf, clipEnd, clipLength, docLength, byId, isVisual, hasSound, audible, setClip, selectedClips, mainTrack, onTrack } from './project.js';

const S = { playing: false, t0: 0, p0: 0, source: null, raf: 0, loop: false, recording: null, dirty: true };
const M = new Map(); // clip id -> { el, asset, src (MediaElementSource), gain }
const IMGS = new Map(); // asset -> Image
const PEAKS = new Map(); // asset -> peaks or 'loading'
const AU = { ctx: null, master: null, analyser: null, dest: null, tracks: new Map() };
let stage, canvas, g, handles, painter, sizeTag;

export function initPlayer() {
  stage = $('#stage');
  canvas = h('canvas', { class: 'comp', id: 'compCanvas' });
  handles = h('div', { class: 'xf', id: 'xfBox', hidden: true }, ...['nw', 'ne', 'sw', 'se'].map((c) => h('span', { class: `xf-h ${c}`, 'data-h': c })), h('span', { class: 'xf-h rot', 'data-h': 'rot' }));
  sizeTag = h('div', { class: 'stage-size' });
  stage.append(canvas, handles, sizeTag);
  g = canvas.getContext('2d');
  $('#playBtn').addEventListener('click', toggle);
  $('#stepBack').addEventListener('click', () => seek(P.playhead - 1 / P.doc.fps));
  $('#stepFwd').addEventListener('click', () => seek(P.playhead + 1 / P.doc.fps));
  $('#loopBtn').addEventListener('click', () => { S.loop = !S.loop; $('#loopBtn').classList.toggle('on', S.loop); });
  bus.on('doc', () => { fitStage(); refresh(); });
  bus.on('selection', () => drawHandles());
  new ResizeObserver(fitStage).observe($('#viewer'));
  canvas.addEventListener('pointerdown', onCanvasDown);
  handles.addEventListener('pointerdown', onCanvasDown);
  fitStage();
  frameLoop();
}

/** The stage keeps the scene's shape inside the viewer; the canvas draws at the scene's own size. */
function fitStage() {
  const box = $('#viewer').getBoundingClientRect();
  const ar = S.source?.ratio ?? P.doc.width / P.doc.height;
  let w = box.width - 24, hh = w / ar;
  if (hh > box.height - 24) { hh = box.height - 24; w = hh * ar; }
  stage.style.width = `${Math.max(40, w)}px`;
  stage.style.height = `${Math.max(40, hh)}px`;
  if (canvas.width !== P.doc.width || canvas.height !== P.doc.height) { canvas.width = P.doc.width; canvas.height = P.doc.height; }
  sizeTag.textContent = S.source ? '' : `${P.doc.width} × ${P.doc.height}${P.kind === 'image' && !P.doc.background ? ' · transparent' : ''}`;
  if (painter) painter.fit();
  S.dirty = true;
  drawHandles();
}
/** Something changed: draw again on the next frame (and put paused media at the playhead). */
export function refresh() { S.dirty = true; if (!S.playing) syncMedia(P.playhead, false); }

// ------------------------------------------------------------------ the clock
export const isPlaying = () => S.playing;
export function toggle() { S.playing ? pause() : play(); }
export async function play() {
  if (S.source) return playSource();
  const len = docLength();
  if (!len) return;
  audio();
  if (AU.ctx.state !== 'running') await AU.ctx.resume().catch(() => {});
  const r = P.selection.range;
  if (P.playhead >= len - 0.05 || (S.loop && r && (P.playhead < r.start || P.playhead >= r.end))) P.playhead = S.loop && r ? r.start : 0;
  S.playing = true;
  S.t0 = performance.now();
  S.p0 = P.playhead;
  drawPlayBtn();
  syncMedia(P.playhead, true);
}
export function pause() {
  S.playing = false;
  for (const m of M.values()) m.el.pause();
  if (S.source?.el) S.source.el.pause();
  drawPlayBtn();
  S.dirty = true;
  bus.emit('time', P.playhead);
}
function drawPlayBtn() { $('#playBtn').replaceChildren(icon(S.playing ? 'pause' : 'play')); }
export function seek(t) {
  if (S.source) { if (S.source.el) S.source.el.currentTime = Math.max(0, t); return; }
  P.playhead = Math.max(0, Math.min(Math.max(docLength(), 0), t));
  if (S.playing) { S.p0 = P.playhead; S.t0 = performance.now(); }
  syncMedia(P.playhead, S.playing);
  S.dirty = true;
  bus.emit('time', P.playhead);
}

/** One loop for everything: the clock while playing, the media kept in step, and the canvas drawn when something changed. */
function frameLoop() {
  const tick = () => {
    if (S.playing && !S.source) {
      let t = S.p0 + (performance.now() - S.t0) / 1000;
      const end = S.loop && P.selection.range ? P.selection.range.end : docLength();
      if (t >= end) {
        if (S.loop && !S.recording) { t = P.selection.range?.start ?? 0; S.p0 = t; S.t0 = performance.now(); syncMedia(t, true); } else { P.playhead = end; pause(); S.recording?.done(); }
      }
      if (S.playing) { P.playhead = t; syncMedia(t, true); bus.emit('time', t); }
      S.dirty = true;
    }
    if (S.dirty && !S.source && canvas.isConnected) { S.dirty = false; draw(g, P.playhead, { live: true }); drawHandles(); }
    $('#timecode').textContent = S.source ? $('#timecode').textContent : `${fmt(P.playhead, 2)} / ${fmt(docLength(), 2)}`;
    S.raf = requestAnimationFrame(tick);
  };
  S.raf = requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ media and sound
function audio() {
  if (AU.ctx) return AU.ctx;
  AU.ctx = new AudioContext();
  AU.master = AU.ctx.createGain();
  AU.analyser = AU.ctx.createAnalyser();
  AU.analyser.fftSize = 2048;
  AU.analyser.smoothingTimeConstant = 0.78;
  AU.master.connect(AU.analyser).connect(AU.ctx.destination);
  for (const m of M.values()) route(m);
  return AU.ctx;
}
function trackNode(id) {
  let n = AU.tracks.get(id);
  if (!n) { const gain = AU.ctx.createGain(); const pan = AU.ctx.createStereoPanner(); gain.connect(pan).connect(AU.master); n = { gain, pan }; AU.tracks.set(id, n); }
  return n;
}
/** A media element's sound into the graph (once per element: its clip's gain, then its track). */
function route(m) {
  if (!AU.ctx || m.src) return;
  try { m.src = AU.ctx.createMediaElementSource(m.el); m.gain = AU.ctx.createGain(); m.src.connect(m.gain); } catch { /* not routable: plays on its own */ }
}
/** A clip's loudness at time t: its volume, its fades, mute. */
function clipGain(c, t) {
  if (c.muted) return 0;
  let v = c.volume ?? 1;
  const into = t - c.start, left = clipEnd(c) - t;
  if (c.fadeIn && into < c.fadeIn) v *= Math.max(0, into / c.fadeIn);
  if (c.fadeOut && left < c.fadeOut) v *= Math.max(0, left / c.fadeOut);
  return v;
}
const local = (c, t) => c.in + (Math.min(t, clipEnd(c) - 0.001) - c.start) * (c.speed || 1);

/** Keeps every media element in step with the timeline: those under the playhead play (or hold the frame), the next ones load. */
function syncMedia(t, playing) {
  const want = new Set();
  for (const c of P.doc.clips) {
    if (!c.asset || (c.kind !== 'video' && c.kind !== 'audio')) continue;
    const on = t >= c.start && t < clipEnd(c);
    const soon = !on && c.start > t && c.start - t < 2.5;
    if (!on && !soon) continue;
    want.add(c.id);
    let m = M.get(c.id);
    if (!m || m.asset !== c.asset) {
      if (m) dropMedia(c.id);
      const el = c.kind === 'video' ? h('video', { playsinline: true, preload: 'auto', crossorigin: 'use-credentials' }) : h('audio', { preload: 'auto', crossorigin: 'use-credentials' });
      el.src = fileUrl(c.asset);
      el.addEventListener('seeked', () => { S.dirty = true; });
      el.addEventListener('loadeddata', () => { S.dirty = true; if (!S.playing) el.currentTime = Math.max(0.001, local(c, P.playhead)); });
      m = { el, asset: c.asset };
      M.set(c.id, m);
      route(m);
    }
    const tr = trackOf(c.track);
    const sounding = hasSound(c) && audible(tr);
    if (m.gain && AU.ctx) {
      const tn = trackNode(c.track);
      if (!m.wired) { m.gain.connect(tn.gain); m.wired = true; }
      m.gain.gain.value = sounding ? clipGain(c, t) : 0;
      tn.gain.gain.value = tr?.volume ?? 1;
      tn.pan.pan.value = tr?.pan ?? 0;
    } else {
      m.el.muted = !sounding || Boolean(c.muted);
      m.el.volume = Math.min(1, clipGain(c, t) * (tr?.volume ?? 1));
    }
    m.el.playbackRate = c.speed || 1;
    if (!on) { if (!m.el.paused) m.el.pause(); if (Math.abs(m.el.currentTime - c.in) > 0.05 && m.el.readyState >= 1) m.el.currentTime = c.in; continue; }
    const at = local(c, t);
    if (playing) {
      if (Math.abs(m.el.currentTime - at) > 0.25) m.el.currentTime = at;
      if (m.el.paused) m.el.play().catch(() => {});
    } else {
      if (!m.el.paused) m.el.pause();
      if (Math.abs(m.el.currentTime - at) > 0.02 && m.el.readyState >= 1) m.el.currentTime = at;
    }
  }
  for (const id of [...M.keys()]) if (!want.has(id)) { const m = M.get(id); m.el.pause(); if (!byId(id) || M.size > 24) dropMedia(id); }
}
function dropMedia(id) {
  const m = M.get(id);
  if (!m) return;
  m.el.pause();
  try { m.src?.disconnect(); m.gain?.disconnect(); } catch { /* */ }
  m.el.removeAttribute('src');
  m.el.load();
  M.delete(id);
}
function imgOf(asset) {
  let im = IMGS.get(asset);
  if (!im) { im = new Image(); im.crossOrigin = 'use-credentials'; im.onload = () => { S.dirty = true; drawHandles(); }; im.src = fileUrl(asset); IMGS.set(asset, im); }
  return im;
}
function peaksOf(asset) {
  const p = PEAKS.get(asset);
  if (p === undefined) { PEAKS.set(asset, 'loading'); peaks(asset, 2400).then((x) => { PEAKS.set(asset, x ?? null); S.dirty = true; }); return null; }
  return p === 'loading' ? null : p;
}

// ------------------------------------------------------------------ drawing
const active = (c, t) => t >= c.start && t < clipEnd(c);
/** A clip's picture source and its natural size, if it has one ready. */
function sourceOf(c) {
  if (c.kind === 'image' && c.asset) { const im = imgOf(c.asset); return im.complete && im.naturalWidth ? { el: im, w: im.naturalWidth, h: im.naturalHeight } : null; }
  if (c.kind === 'video' && c.asset) { const m = M.get(c.id); return m && m.el.readyState >= 2 && m.el.videoWidth ? { el: m.el, w: m.el.videoWidth, h: m.el.videoHeight } : null; }
  return null;
}
/** A visual clip's box on the frame (center, size before turning), in the scene's pixels. */
export function boxOf(c, ctx = g) {
  const W = P.doc.width, H = P.doc.height;
  const cx = (c.x ?? 0.5) * W, cy = (c.y ?? 0.5) * H;
  if (c.kind === 'fill') return c.w == null ? { x: W / 2, y: H / 2, w: W, h: H } : { x: cx, y: cy, w: c.w * W, h: c.w * W * (H / W) };
  if (c.kind === 'text') {
    const st = textStyle(c);
    ctx.font = st.font;
    const lines = String(c.text ?? '').split('\n');
    const w = Math.max(st.px, ...lines.map((x) => ctx.measureText(x).width)) + st.pad * 2;
    return { x: st.x * W, y: st.y * H, w, h: lines.length * st.px * 1.18 + st.pad * 2 };
  }
  const src = sourceOf(c) ?? (c.kind === 'image' && c.asset && IMGS.get(c.asset)?.naturalWidth ? { w: IMGS.get(c.asset).naturalWidth, h: IMGS.get(c.asset).naturalHeight } : null);
  const nw = src?.w ?? W, nh = src?.h ?? H;
  if (c.w == null) {
    // Fit the frame: inside it (bars) or filling it (cropped), as the scene says.
    const k = P.doc.fit === 'crop' ? Math.max(W / nw, H / nh) : Math.min(W / nw, H / nh);
    return { x: cx, y: cy, w: nw * k, h: nh * k };
  }
  return { x: cx, y: cy, w: c.w * W, h: (c.w * W * nh) / nw };
}
/** Text without a size or a place is a caption: bottom center, on a soft box. */
function textStyle(c) {
  const H = P.doc.height;
  const caption = c.size == null && c.y == null;
  const px = Math.max(6, (c.size ?? 0.055) * H);
  return {
    px, font: `${c.weight ?? 700} ${px}px "${c.font ?? 'Inter'}", Inter, system-ui, sans-serif`, color: c.color ?? '#ffffff', align: c.align ?? 'center',
    x: c.x ?? 0.5, y: c.y ?? (caption ? 0.86 : 0.5), box: c.box !== undefined ? c.box : caption ? 'rgba(0,0,0,.38)' : null, pad: caption || c.box ? px * 0.35 : 0, shadow: caption,
  };
}

/** Draws the timeline at time t onto a context at the scene's size. `live`: placeholders for clips still being made. */
function draw(ctx, t, { live = false } = {}) {
  const W = P.doc.width, H = P.doc.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  const bg = P.doc.background ?? (P.kind === 'image' ? null : '#000000');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
  if (P.kind === 'audio') drawSound(ctx, t, live);
  const main = mainTrack()?.id;
  for (const tr of [...tracks()].reverse()) {
    if (tr.hidden) continue;
    const cs = P.doc.clips.filter((c) => c.track === tr.id && isVisual(c)).sort((a, b) => a.start - b.start);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (!active(c, t)) continue;
      // A transition at a join of the main track: the next clip comes in over the last part of this one.
      const n = tr.id === main && c.transition && cs[i + 1] && Math.abs(cs[i + 1].start - clipEnd(c)) < 0.02 ? cs[i + 1] : null;
      const T = c.transitionSeconds ?? 0.5;
      const k = n && clipEnd(c) - t < T ? 1 - (clipEnd(c) - t) / T : 0;
      if (k && /^fade/.test(c.transition)) {
        drawClip(ctx, c, t, live, 1);
        ctx.fillStyle = c.transition === 'fadewhite' ? '#fff' : '#000';
        ctx.globalAlpha = Math.min(1, k * 2);
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
        continue;
      }
      drawClip(ctx, c, t, live, 1);
      if (k) {
        ctx.save();
        if (/^(wipe|slide)/.test(c.transition)) { ctx.beginPath(); ctx.rect(W * (1 - k), 0, W * k, H); ctx.clip(); if (c.transition.startsWith('slide')) ctx.translate(W * (1 - k), 0); drawClip(ctx, n, n.start, live, 1); } else drawClip(ctx, n, n.start, live, k);
        ctx.restore();
      }
    }
  }
  // Coming in from black: the first part of a clip after a fade-through.
  const prev = onTrack(main).find((c) => /^fade/.test(c.transition ?? '') && Math.abs(clipEnd(c) - t) < (c.transitionSeconds ?? 0.5) && t >= clipEnd(c));
  if (prev) { ctx.fillStyle = prev.transition === 'fadewhite' ? '#fff' : '#000'; ctx.globalAlpha = Math.max(0, 1 - ((t - clipEnd(prev)) / ((prev.transitionSeconds ?? 0.5) / 2))); ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
  ctx.restore();
  emptyState();
}

/** An empty scene says how to start: drop something, pick from Media, or ask the AI. */
const EMPTY = {
  video: ['Start your video', 'Drop clips, pictures or sounds here or onto a track below. Or ask the AI to make it for you.'],
  image: ['Start your picture', 'Drop pictures here: each one is a layer you can move, size and turn. Or ask the AI to design it.'],
  audio: ['Start your sound', 'Drop music, voices and effects onto the tracks below. Or ask the AI to compose and voice it.'],
};
function emptyState() {
  const el = $('#stageEmpty');
  el.hidden = P.doc.clips.length > 0;
  if (el.hidden) return;
  const [t, s] = EMPTY[P.kind] ?? EMPTY.video;
  if ($('#stageEmptyT').textContent !== t) { $('#stageEmptyT').textContent = t; $('#stageEmptyS').textContent = s; }
}

function drawClip(ctx, c, t, live, alpha) {
  const W = P.doc.width, H = P.doc.height;
  ctx.save();
  ctx.globalAlpha = alpha * (c.opacity ?? 1);
  ctx.globalCompositeOperation = !c.blend || c.blend === 'normal' ? 'source-over' : c.blend;
  if (c.kind === 'fill') {
    const b = boxOf(c, ctx);
    ctx.translate(b.x, b.y); ctx.rotate(((c.rotation ?? 0) * Math.PI) / 180);
    ctx.fillStyle = c.color ?? '#000'; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
    ctx.restore();
    return;
  }
  if (c.kind === 'text') {
    const st = textStyle(c);
    const b = boxOf(c, ctx);
    ctx.translate(b.x, b.y); ctx.rotate(((c.rotation ?? 0) * Math.PI) / 180);
    if (st.box) { ctx.fillStyle = st.box; roundRect(ctx, -b.w / 2, -b.h / 2, b.w, b.h, st.px * 0.25); ctx.fill(); }
    ctx.font = st.font; ctx.fillStyle = st.color; ctx.textBaseline = 'middle'; ctx.textAlign = st.align;
    if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = st.px * 0.3; ctx.shadowOffsetY = st.px * 0.05; }
    const lines = String(c.text ?? '').split('\n');
    const ax = st.align === 'left' ? -b.w / 2 + st.pad : st.align === 'right' ? b.w / 2 - st.pad : 0;
    lines.forEach((x, i) => ctx.fillText(x, ax, (i - (lines.length - 1) / 2) * st.px * 1.18));
    ctx.restore();
    return;
  }
  const b = boxOf(c, ctx);
  ctx.translate(b.x, b.y);
  ctx.rotate(((c.rotation ?? 0) * Math.PI) / 180);
  const z = c.zoom;
  if (z) {
    const k = Math.min(1, Math.max(0, (t - c.start) / Math.max(0.01, clipLength(c))));
    const s = (z.from ?? 1) + ((z.to ?? 1) - (z.from ?? 1)) * k;
    const ox = ((z.x ?? 0.5) - 0.5) * b.w, oy = ((z.y ?? 0.5) - 0.5) * b.h;
    ctx.translate(ox, oy); ctx.scale(s, s); ctx.translate(-ox, -oy);
  }
  const src = sourceOf(c);
  if (src) ctx.drawImage(src.el, -b.w / 2, -b.h / 2, b.w, b.h);
  else if (live) {
    ctx.fillStyle = c.failed ? 'rgba(255,107,129,.18)' : 'rgba(139,123,255,.16)';
    ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
    ctx.fillStyle = c.failed ? '#ff9aa9' : '#c9c3ff';
    ctx.font = `600 ${Math.max(14, Math.min(W, H) / 22)}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(c.pending ? `Making… ${c.label ?? ''}`.slice(0, 48) : c.failed ? 'Couldn\'t make this' : c.scene && !c.asset ? 'Not rendered yet' : 'Loading…', 0, 0);
  }
  ctx.restore();
}
function roundRect(ctx, x, y, w, hh, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r); ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

/**
 * An audio scene's center: each sounding track as a lane of its waveform around the playhead (four seconds each side,
 * the playhead in the middle), the spectrum while it plays, and the words being said (text clips, and the voice lines'
 * labels) as captions.
 */
function drawSound(ctx, t, live) {
  const W = P.doc.width, H = P.doc.height;
  const span = 4;
  const ts = tracks().filter((x) => x.role === 'audio' || P.doc.clips.some((c) => c.track === x.id && c.kind === 'audio'));
  const top = H * 0.08, area = H * 0.56, laneH = area / Math.max(1, ts.length);
  ctx.save();
  ctx.fillStyle = '#0d0f14'; ctx.fillRect(0, 0, W, H);
  ts.forEach((tr, i) => {
    const y0 = top + i * laneH, mid = y0 + laneH / 2;
    const on = audible(tr);
    ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(0, y0 + 2, W, laneH - 4);
    ctx.font = `600 ${Math.round(H * 0.024)}px Inter, sans-serif`; ctx.fillStyle = on ? tr.color ?? '#1fb88a' : '#555b68'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.fillText(`${tr.name}${tr.mute ? ' · muted' : ''}${tr.solo ? ' · solo' : ''}`, W * 0.015, y0 + 6);
    for (const c of P.doc.clips) {
      if (c.track !== tr.id || !hasSound(c) || !c.asset) continue;
      if (clipEnd(c) < t - span || c.start > t + span) continue;
      const p = peaksOf(c.asset);
      const x0 = W / 2 + ((c.start - t) / span) * (W / 2), x1 = W / 2 + ((clipEnd(c) - t) / span) * (W / 2);
      ctx.fillStyle = `${tr.color ?? '#1fb88a'}${on ? '33' : '14'}`;
      ctx.fillRect(Math.max(0, x0), y0 + 4, Math.min(W, x1) - Math.max(0, x0), laneH - 8);
      if (!p) continue;
      ctx.fillStyle = on ? (tr.color ?? '#1fb88a') : '#444955';
      const n = p.values.length;
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, x1); x += 2) {
        const tt = t + ((x - W / 2) / (W / 2)) * span;
        const src = c.in + (tt - c.start) * (c.speed || 1);
        const v = (p.values[Math.min(n - 1, Math.max(0, Math.floor((src / p.duration) * n)))] ?? 0) * clipGain(c, tt);
        const hh = Math.max(1, v * (laneH * 0.42));
        ctx.fillRect(x, mid - hh, 1.5, hh * 2);
      }
    }
  });
  // The playhead.
  ctx.fillStyle = '#ff4d6d'; ctx.fillRect(W / 2 - 1, top - 6, 2, area + 12);
  // The spectrum while it plays.
  if (S.playing && AU.analyser) {
    const bins = new Uint8Array(AU.analyser.frequencyBinCount);
    AU.analyser.getByteFrequencyData(bins);
    const bars = 96, base = H * 0.86, maxH = H * 0.2, bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const lo = Math.floor(Math.pow(i / bars, 2) * bins.length * 0.7), hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / bars, 2) * bins.length * 0.7));
      let v = 0;
      for (let j = lo; j < hi; j++) v = Math.max(v, bins[j]);
      const hh = (v / 255) * maxH;
      ctx.fillStyle = `hsla(${250 - (i / bars) * 90}, 80%, 66%, .85)`;
      ctx.fillRect(i * bw + 1, base - hh, bw - 2, hh);
    }
  }
  // What's being said: voice lines (their labels) unless a text clip says it.
  const said = P.doc.clips.filter((c) => c.kind === 'audio' && active(c, t) && c.label && /voice|line/i.test(trackOf(c.track)?.name ?? '')).map((c) => c.label);
  if (said.length && !P.doc.clips.some((c) => c.kind === 'text' && active(c, t))) {
    ctx.font = `700 ${Math.round(H * 0.045)}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 8;
    ctx.fillText(said.join('  ·  ').slice(0, 90), W / 2, H * 0.94);
  }
  ctx.restore();
}

// ------------------------------------------------------------------ handles on the canvas
const scale = () => stage.getBoundingClientRect().width / P.doc.width;
/** The one selected visual clip under the playhead, if it can be moved there. */
function handled() {
  const cs = selectedClips();
  if (cs.length !== 1 || S.source || P.kind === 'audio') return null;
  const c = cs[0];
  const tr = trackOf(c.track);
  return isVisual(c) && active(c, P.playhead) && !tr?.hidden && !tr?.locked ? c : null;
}
function drawHandles() {
  if (!handles) return;
  const c = handled();
  if (!c) { handles.hidden = true; return; }
  const b = boxOf(c);
  const s = scale();
  handles.hidden = false;
  Object.assign(handles.style, { left: `${(b.x - b.w / 2) * s}px`, top: `${(b.y - b.h / 2) * s}px`, width: `${b.w * s}px`, height: `${b.h * s}px`, transform: `rotate(${c.rotation ?? 0}deg)` });
}
const toScene = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * P.doc.width, y: ((e.clientY - r.top) / r.height) * P.doc.height }; };
/** The topmost visible clip under a point at the playhead. */
function hit(p) {
  for (const tr of tracks()) {
    if (tr.hidden) continue;
    const cs = P.doc.clips.filter((c) => c.track === tr.id && isVisual(c) && active(c, P.playhead)).reverse();
    for (const c of cs) {
      const b = boxOf(c);
      const a = (-(c.rotation ?? 0) * Math.PI) / 180;
      const dx = p.x - b.x, dy = p.y - b.y;
      const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(x) <= b.w / 2 && Math.abs(y) <= b.h / 2) return c;
    }
  }
  return null;
}
function onCanvasDown(e) {
  if (S.source || painter || e.button > 0) return;
  const p0 = toScene(e);
  const hd = e.target.dataset?.h;
  let c = hd ? handled() : hit(p0);
  if (!hd) {
    if (!c) { if (P.selection.clips.size) { P.selection.clips.clear(); bus.emit('selection'); } return; }
    if (!P.selection.clips.has(c.id) || P.selection.clips.size !== 1) { P.selection.clips.clear(); P.selection.clips.add(c.id); P.selection.track = c.track; bus.emit('selection'); bus.emit('inspect'); }
    c = handled();
  }
  if (!c) return;
  e.preventDefault();
  if (S.playing) pause();
  const W = P.doc.width;
  const b0 = boxOf(c);
  const start = { x: c.x ?? 0.5, y: c.y ?? 0.5, w: b0.w / W, size: c.size ?? (c.kind === 'text' ? 0.055 : null), rot: c.rotation ?? 0, cx: b0.x, cy: b0.y };
  let first = true;
  const move = (ev) => {
    const p = toScene(ev);
    const patch = {};
    if (hd === 'rot') {
      let r = Math.round((Math.atan2(p.y - start.cy, p.x - start.cx) * 180) / Math.PI + 90);
      if (!ev.shiftKey) { const snap = Math.round(r / 15) * 15; if (Math.abs(snap - r) < 4) r = snap; }
      patch.rotation = ((r + 540) % 360) - 180 || null;
    } else if (hd) {
      const k = Math.max(0.02, Math.hypot(p.x - start.cx, p.y - start.cy) / Math.max(1, Math.hypot(p0.x - start.cx, p0.y - start.cy)));
      if (c.kind === 'text') patch.size = Math.round(Math.max(0.005, start.size * k) * 10000) / 10000; else patch.w = Math.round(Math.max(0.01, start.w * k) * 10000) / 10000;
    } else {
      let x = start.x + (p.x - p0.x) / W, y = start.y + (p.y - p0.y) / P.doc.height;
      // Snap the center to the middle of the frame.
      if (!ev.shiftKey) { if (Math.abs(x - 0.5) < 0.012) x = 0.5; if (Math.abs(y - 0.5) < 0.012) y = 0.5; }
      patch.x = Math.round(x * 10000) / 10000; patch.y = Math.round(y * 10000) / 10000;
      if (c.kind === 'text' && c.size == null) patch.size = start.size;
    }
    setClip(c.id, patch, { history: first });
    first = false;
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

// ------------------------------------------------------------------ renders
/** Waits until every media element under time t holds that frame. */
async function settle(t) {
  syncMedia(t, false);
  const waits = [];
  for (const c of P.doc.clips) {
    if (!active(c, t) || !c.asset) continue;
    if (c.kind === 'image') { const im = imgOf(c.asset); if (!im.complete) waits.push(new Promise((ok) => { im.addEventListener('load', ok, { once: true }); im.addEventListener('error', ok, { once: true }); })); }
    if (c.kind === 'video') {
      const m = M.get(c.id);
      if (!m) continue;
      waits.push(new Promise((ok) => {
        const done = () => ok();
        if (m.el.readyState >= 2 && Math.abs(m.el.currentTime - local(c, t)) < 0.03 && !m.el.seeking) return ok();
        m.el.addEventListener('seeked', done, { once: true });
        m.el.addEventListener('loadeddata', () => { m.el.currentTime = Math.max(0.001, local(c, t)); }, { once: true });
        if (m.el.readyState >= 1) m.el.currentTime = Math.max(0.001, local(c, t));
        setTimeout(done, 6000);
      }));
    }
  }
  await Promise.all(waits);
}
/** The frame at time t, drawn at the scene's size (an image scene's export). */
export async function frameAt(t = P.playhead) {
  pause();
  await settle(t);
  const out = h('canvas', { width: String(P.doc.width), height: String(P.doc.height) });
  draw(out.getContext('2d'), t, { live: false });
  S.dirty = true;
  return out;
}

/** Every sound on the timeline mixed offline (WebAudio): an audio scene's export, and the sound of a browser render. */
export async function mixdown(from = 0, to = docLength(), rate = 44100) {
  const len = Math.max(0.1, to - from);
  const off = new OfflineAudioContext(2, Math.ceil(len * rate), rate);
  const bufs = new Map();
  const buf = (asset) => { if (!bufs.has(asset)) bufs.set(asset, fetch(fileUrl(asset), { credentials: 'same-origin' }).then((r) => r.arrayBuffer()).then((b) => off.decodeAudioData(b)).catch(() => null)); return bufs.get(asset); };
  for (const tr of tracks()) {
    if (!audible(tr)) continue;
    const vol = off.createGain(); vol.gain.value = tr.volume ?? 1;
    const pan = off.createStereoPanner(); pan.pan.value = tr.pan ?? 0;
    vol.connect(pan).connect(off.destination);
    for (const c of P.doc.clips) {
      if (c.track !== tr.id || !hasSound(c) || !c.asset || c.muted) continue;
      const s = Math.max(c.start, from), e = Math.min(clipEnd(c), to);
      if (e <= s) continue;
      const b = await buf(c.asset);
      if (!b) continue;
      const src = off.createBufferSource(); src.buffer = b; src.playbackRate.value = c.speed || 1;
      const gn = off.createGain();
      const at = s - from, dur = e - s, gain = c.volume ?? 1;
      gn.gain.setValueAtTime(clipGain(c, s), at);
      if (c.fadeIn && s < c.start + c.fadeIn) gn.gain.linearRampToValueAtTime(gain, c.start + c.fadeIn - from);
      if (c.fadeOut) { const fs = Math.max(at, clipEnd(c) - c.fadeOut - from); gn.gain.setValueAtTime(clipGain(c, fs + from), fs); gn.gain.linearRampToValueAtTime(0, clipEnd(c) - from); }
      src.connect(gn).connect(vol);
      src.start(at, local(c, s), dur * (c.speed || 1));
    }
  }
  return off.startRendering();
}

/**
 * The whole timeline played once in real time and recorded from the canvas, with the mix (a video export when the
 * timeline has more than a main track: overlays, placements, blends). Resolves with a webm blob.
 */
export async function recordTimeline(onProgress) {
  pause();
  audio();
  await AU.ctx.resume().catch(() => {});
  AU.dest ??= AU.ctx.createMediaStreamDestination();
  AU.master.connect(AU.dest);
  const stream = new MediaStream([...canvas.captureStream(P.doc.fps).getVideoTracks(), ...AU.dest.stream.getAudioTracks()]);
  const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((x) => MediaRecorder.isTypeSupported(x));
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const end = docLength();
  P.selection.clips.clear();
  bus.emit('selection');
  await settle(0);
  P.playhead = 0;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => onProgress?.(Math.min(1, P.playhead / end)), 250);
    S.recording = {
      done() {
        clearInterval(timer);
        S.recording = null;
        rec.onstop = () => { try { AU.master.disconnect(AU.dest); } catch { /* */ } resolve(new Blob(parts, { type: 'video/webm' })); };
        setTimeout(() => rec.stop(), 120);
      },
    };
    rec.onerror = (e) => { clearInterval(timer); S.recording = null; reject(e.error ?? new Error('Recording failed')); };
    rec.start(500);
    play();
  });
}
export const isRecording = () => Boolean(S.recording);

// ------------------------------------------------------------------ one file on its own
/** Shows one library file in the viewer (not the timeline): a still, a clip with its own controls, or a sound. */
export async function showSource(asset) {
  pause();
  S.source = { ...asset, ratio: (asset.width && asset.height) ? asset.width / asset.height : P.doc.width / P.doc.height };
  canvas.hidden = true;
  handles.hidden = true;
  $('#stageEmpty').hidden = true;
  $('#stagePending').hidden = true;
  $('#sourceEl')?.remove();
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
  canvas.hidden = false;
  $('#viewerMode').hidden = true;
  fitStage();
  refresh();
  bus.emit('source', null);
}
export const currentSource = () => S.source;
function playSource() {
  const el = S.source?.el;
  if (!el) return;
  S.playing = true;
  drawPlayBtn();
  el.play().catch(() => {});
  el.onended = () => pause();
}

// ------------------------------------------------------------------ painting a mask
/**
 * Paints a mask over what the viewer shows: a black-and-white canvas at the media's own size (white = the area to
 * change). Returns a handle to close it.
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
  // The red overlay is drawn from a copy where black is transparent.
  const overlay = h('canvas', { width, height });
  const octx = overlay.getContext('2d');
  const redraw = () => {
    vctx.clearRect(0, 0, view.width, view.height);
    vctx.globalAlpha = 0.55;
    vctx.drawImage(overlay, 0, 0, view.width, view.height);
    vctx.globalCompositeOperation = 'source-in';
    vctx.fillStyle = '#ff4d6d'; vctx.fillRect(0, 0, view.width, view.height);
    vctx.globalCompositeOperation = 'source-over';
    vctx.globalAlpha = 1;
  };
  const fit = () => {
    const r = stage.getBoundingClientRect();
    view.width = Math.round(r.width); view.height = Math.round(r.height);
    redraw();
  };
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
    redraw();
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
