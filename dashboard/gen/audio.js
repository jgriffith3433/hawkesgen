// The audio editor (scenes.js; src/scenekinds.ts "audio"): a multitrack. Tracks (volume, pan, mute, solo) hold clips
// (a library sound, an audio scene's mixdown, a video's sound, or something generated) placed in time, trimmed, with gain
// and fades. Drag a clip to move it (across tracks too), its edges to trim; S splits at the playhead. It plays in the
// browser (WebAudio) and mixes down the same way (an OfflineAudioContext) into a WAV: the scene's render, which video and
// other audio scenes play.

import { $, $$, h, api, toast, fileUrl, fmt, bus, icon, plainError, ApiError, peaks, mediaInfo } from './lib.js';
import { runJob, quote, credits } from './media.js';
import { libraryPicker } from './studio.js';
import { state } from './account.js';
import { registerEditor, setRender, openScene, refreshBar, readDrag } from './scenes.js';
import { popMenu, closeMenus } from './timeline.js';
import { sceneDoc } from './scenedoc.js';

const A = { sel: null, selTrack: null, pps: 40, playhead: 0, playing: false, ctx: null, nodes: [], t0: 0, from: 0, raf: 0, buffers: new Map(), voices: [] };
const D = sceneDoc({ onChange: () => { drawAll(); refreshBar(); } });
const tracks = () => D.doc?.tracks ?? [];
const allClips = () => tracks().flatMap((t) => t.clips.map((c) => ({ c, t })));
const clipLen = (c) => Math.max(0.02, c.out - c.in);
const docLen = () => Math.max(4, ...allClips().map(({ c }) => c.start + clipLen(c)));
const HEAD_W = 176;

registerEditor({
  kind: 'audio', label: 'Audio', icon: 'music', panel: null,
  async mount(scene) {
    A.sel = null; A.playhead = 0;
    mountSurface();
    D.take(scene);
    A.selTrack = tracks()[0]?.id ?? null;
    loadVoices();
  },
  async unmount() { stop(); await D.save(); D.stop(); $('#audWrap')?.remove(); removeEventListener('keydown', onKey, true); },
  undo: () => D.undo(), redo: () => D.redo(), canUndo: () => D.canUndo(), canRedo: () => D.canRedo(), save: () => D.save(),
  action: { label: 'Mixdown', icon: 'download', run: () => mixdown() },
  rename: (title) => D.change((d) => { d.title = title; }),
  accepts: (it) => (it.asset ? ['audio', 'video'].includes(it.assetKind) : ['audio', 'video', 'stage'].includes(it.kind)),
  drop: (it) => addFrom(it, A.selTrack ?? tracks()[0]?.id, A.playhead),
  uses: (s) => [{ label: 'Add on a track here', run: () => addFrom({ scene: s.id, kind: s.kind, title: s.title, render: s.render }, A.selTrack ?? tracks()[0]?.id, A.playhead) }],
  ai: { selection: () => ({ clip: A.sel, track: A.selTrack, playhead: Math.round(A.playhead * 100) / 100 }) },
  take: (scene) => D.take(scene),
});

async function loadVoices() { if (A.voices.length) return; try { A.voices = (await api('/v1/editor/voices')).voices ?? []; } catch { /* */ } }

// ------------------------------------------------------------------ the surface
function mountSurface() {
  $('#audWrap')?.remove();
  const wrap = h('div', { id: 'audWrap', class: 'aud-wrap' },
    h('div', { class: 'aud-bar', id: 'audBar' }),
    h('div', { class: 'aud-arrange', id: 'audArrange' },
      h('div', { class: 'aud-heads', id: 'audHeads' }),
      h('div', { class: 'aud-scroll', id: 'audScroll' }, h('div', { class: 'aud-canvas', id: 'audCanvas' }, h('div', { class: 'aud-ruler', id: 'audRuler' }), h('div', { class: 'aud-lanes', id: 'audLanes' }), h('div', { class: 'aud-playhead', id: 'audPlayhead' })))));
  $('#viewer').append(wrap);
  $('#audScroll').addEventListener('scroll', () => { $('#audHeads').scrollTop = $('#audScroll').scrollTop; });
  $('#audRuler').addEventListener('pointerdown', (e) => { const go = (ev) => seek(xToT(ev.clientX)); go(e); const up = () => { removeEventListener('pointermove', go); removeEventListener('pointerup', up); }; addEventListener('pointermove', go); addEventListener('pointerup', up); });
  $('#audScroll').addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2); }, { passive: false });
  $('#audLanes').addEventListener('dragover', (e) => { const t = [...e.dataTransfer.types]; if (t.includes('application/x-hg-asset') || t.includes('application/x-hg-scene')) { e.preventDefault(); e.stopPropagation(); } });
  $('#audLanes').addEventListener('drop', (e) => {
    // Read and claim the drop at once (the center's handler behind would take it too).
    const it = readDrag(e);
    if (!it) return;
    e.preventDefault(); e.stopPropagation();
    const lane = e.target.closest('.aud-lane');
    addFrom(it, lane?.dataset.track ?? A.selTrack ?? tracks()[0]?.id, Math.max(0, xToT(e.clientX)));
  });
  addEventListener('keydown', onKey, true);
}
const xToT = (x) => { const r = $('#audCanvas').getBoundingClientRect(); return Math.max(0, (x - r.left) / A.pps); };
function zoom(k) { A.pps = Math.min(400, Math.max(4, A.pps * k)); drawAll(); }

function drawAll() { if (!D.doc || !$('#audWrap')) return; drawBar(); drawHeads(); drawLanes(); movePlayhead(); }

function drawBar() {
  const bar = $('#audBar');
  const sel = selClip();
  bar.replaceChildren(
    h('button', { class: 'play', title: 'Play (Space)', onclick: () => (A.playing ? stop() : play()) }, icon(A.playing ? 'pause' : 'play')),
    h('button', { class: 'icon-btn', title: 'Back to the start (Home)', onclick: () => { stop(); seek(0); } }, icon('back')),
    h('span', { class: 'timecode', id: 'audTc' }, `${fmt(A.playhead, 2)} / ${fmt(docLen(), 1)}`),
    h('label', { class: 'small muted aud-bpm', title: 'Tempo: the ruler shows bars' }, 'BPM ', (() => { const i = h('input', { type: 'number', class: 'num', min: '30', max: '300', placeholder: '—', value: D.doc.bpm ?? '' }); i.addEventListener('change', () => D.change((d) => { d.bpm = i.value ? Number(i.value) : null; })); return i; })()),
    h('span', { class: 'tl-spacer' }),
    sel ? h('span', { class: 'muted small' }, sel.c.label || 'Clip') : '',
    sel ? h('button', { class: 'tb', title: 'Split at the playhead (S)', onclick: () => split() }, icon('split'), h('span', {}, 'Split')) : '',
    h('button', { class: 'tb', onclick: (e) => genMenu(e.currentTarget) }, icon('sparkle'), h('span', {}, 'Generate')),
    h('button', { class: 'tb', onclick: () => libraryPicker('audio', (a) => addFrom({ asset: a.id, assetKind: 'audio', title: a.title }, A.selTrack ?? tracks()[0]?.id, A.playhead)) }, icon('music'), h('span', {}, 'Add a sound')),
    h('button', { class: 'tb', onclick: () => D.change((d) => { d.tracks.push({ name: `Track ${d.tracks.length + 1}`, volume: 1, pan: 0, clips: [] }); }) }, icon('plus'), h('span', {}, 'Track')),
    h('button', { class: 'icon-btn', title: 'Zoom out', onclick: () => zoom(1 / 1.4) }, icon('zoomOut')), h('button', { class: 'icon-btn', title: 'Zoom in', onclick: () => zoom(1.4) }, icon('zoomIn')));
}

function drawHeads() {
  const box = $('#audHeads');
  const solo = tracks().some((t) => t.solo);
  box.replaceChildren(h('div', { class: 'aud-ruler-pad' }), ...tracks().map((t) => {
    const set = (fn, history = true) => D.change((d) => { const x = d.tracks.find((y) => y.id === t.id); if (x) fn(x); }, { history });
    const name = h('input', { class: 'aud-name', value: t.name, onchange: (e) => set((x) => { x.name = e.target.value.trim() || x.name; }) });
    const vol = h('input', { type: 'range', min: '0', max: '2', step: '0.01', value: String(t.volume), title: `Volume ${Math.round(t.volume * 100)}%` });
    let vf = true;
    vol.addEventListener('input', () => { set((x) => { x.volume = Number(vol.value); }, vf); vf = false; liveMix(); });
    vol.addEventListener('change', () => { vf = true; });
    const pan = h('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: String(t.pan), title: 'Pan' });
    let pf = true;
    pan.addEventListener('input', () => { set((x) => { x.pan = Number(pan.value); }, pf); pf = false; liveMix(); });
    pan.addEventListener('change', () => { pf = true; });
    return h('div', { class: `aud-head${t.id === A.selTrack ? ' on' : ''}${solo && !t.solo ? ' dim' : ''}`, style: { '--tc': t.color }, onclick: () => { A.selTrack = t.id; drawHeads(); } },
      h('div', { class: 'row' }, h('span', { class: 'aud-dot' }), name,
        h('button', { class: `aud-ms${t.mute ? ' on' : ''}`, title: 'Mute', onclick: (e) => { e.stopPropagation(); set((x) => { x.mute = !x.mute || undefined; }); liveMix(); } }, 'M'),
        h('button', { class: `aud-ms solo${t.solo ? ' on' : ''}`, title: 'Solo', onclick: (e) => { e.stopPropagation(); set((x) => { x.solo = !x.solo || undefined; }); liveMix(); } }, 'S'),
        h('button', { class: 'icon-btn small', title: 'Remove the track', onclick: (e) => { e.stopPropagation(); if (t.clips.length && !confirm(`Remove "${t.name}" and its ${t.clips.length} clip${t.clips.length === 1 ? '' : 's'}?`)) return; D.change((d) => { d.tracks = d.tracks.filter((y) => y.id !== t.id); }); } }, icon('close'))),
      h('div', { class: 'row aud-knobs' }, h('span', { class: 'muted small' }, 'Vol'), vol, h('span', { class: 'muted small' }, 'Pan'), pan));
  }));
}

function drawLanes() {
  const len = docLen() + 8;
  const w = len * A.pps;
  $('#audCanvas').style.width = `${w}px`;
  // The ruler: seconds, or bars when there's a tempo.
  const ruler = $('#audRuler');
  const ticks = [];
  if (D.doc.bpm) {
    const bar = (60 / D.doc.bpm) * 4;
    for (let b = 0, t = 0; t <= len; b++, t = b * bar) ticks.push(h('div', { class: 'aud-tick major', style: { left: `${t * A.pps}px` } }, h('span', {}, String(b + 1))));
  } else {
    const step = A.pps > 80 ? 1 : A.pps > 25 ? 2 : A.pps > 10 ? 5 : 10;
    for (let t = 0; t <= len; t += step) ticks.push(h('div', { class: 'aud-tick major', style: { left: `${t * A.pps}px` } }, h('span', {}, fmt(t, 0))));
  }
  ruler.replaceChildren(...ticks);
  $('#audLanes').replaceChildren(...tracks().map((t) => h('div', { class: `aud-lane${t.id === A.selTrack ? ' on' : ''}`, 'data-track': t.id, style: { '--tc': t.color }, onpointerdown: (e) => { if (e.target.classList.contains('aud-lane')) { A.sel = null; A.selTrack = t.id; seek(xToT(e.clientX)); drawAll(); } } }, ...t.clips.map((c) => clipEl(c, t)))));
}

function clipEl(c, t) {
  const el = h('div', { class: `aud-clip${c.id === A.sel ? ' on' : ''}${c.pending ? ' pending' : ''}${c.failed ? ' failed' : ''}`, style: { left: `${c.start * A.pps}px`, width: `${clipLen(c) * A.pps}px` }, title: c.failed ?? c.label ?? '' },
    h('canvas', { class: 'aud-wave', width: String(Math.max(1, Math.min(4000, Math.round(clipLen(c) * A.pps)))), height: '48' }),
    h('span', { class: 'aud-clip-t' }, c.pending ? 'Making…' : c.failed ? `Failed: ${c.failed}` : c.label || 'Clip'),
    c.fadeIn ? h('span', { class: 'aud-fade in', style: { width: `${c.fadeIn * A.pps}px` } }) : '',
    c.fadeOut ? h('span', { class: 'aud-fade out', style: { width: `${c.fadeOut * A.pps}px` } }) : '',
    h('span', { class: 'aud-edge l' }), h('span', { class: 'aud-edge r' }));
  if (c.asset) peaks(c.asset, 1200).then((p) => {
    if (!p) return;
    const cv = el.querySelector('canvas');
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = 'rgba(255,255,255,.55)';
    const n = p.values.length;
    for (let x = 0; x < cv.width; x++) {
      const tt = c.in + (x / cv.width) * clipLen(c);
      const v = p.values[Math.min(n - 1, Math.floor((tt / p.duration) * n))] ?? 0;
      const hh = Math.max(1, v * (c.gain ?? 1) * 22);
      g.fillRect(x, 24 - hh, 1, hh * 2);
    }
  });
  el.addEventListener('pointerdown', (e) => clipDrag(e, c, t));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); A.sel = c.id; drawAll(); clipMenu(c, e.clientX, e.clientY); });
  return el;
}

/** Dragging a clip: the body moves it (and across tracks), an edge trims it. One undo step per drag. */
function clipDrag(e, c, t) {
  e.stopPropagation();
  A.sel = c.id; A.selTrack = t.id;
  const edge = e.target.classList.contains('aud-edge') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
  const x0 = e.clientX, s0 = { start: c.start, in: c.in, out: c.out };
  const dur = c.duration ?? Infinity;
  let first = true;
  const move = (ev) => {
    const dt = (ev.clientX - x0) / A.pps;
    const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.aud-lane');
    D.change((d) => {
      let tr = d.tracks.find((y) => y.clips.some((k) => k.id === c.id));
      const k = tr.clips.find((y) => y.id === c.id);
      if (edge === 'l') { const nin = Math.min(s0.out - 0.05, Math.max(0, s0.in + dt)); k.start = Math.max(0, s0.start + (nin - s0.in)); k.in = nin; }
      else if (edge === 'r') k.out = Math.min(dur, Math.max(s0.in + 0.05, s0.out + dt));
      else {
        k.start = Math.max(0, Math.round((s0.start + dt) * 100) / 100);
        if (lane && lane.dataset.track !== tr.id) { tr.clips = tr.clips.filter((y) => y.id !== c.id); tr = d.tracks.find((y) => y.id === lane.dataset.track); tr.clips.push(k); A.selTrack = tr.id; }
      }
    }, { history: first });
    first = false;
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); drawAll(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  drawAll();
}

function clipMenu(c, x, y) {
  const set = (fn) => D.change((d) => { const k = d.tracks.flatMap((t) => t.clips).find((z) => z.id === c.id); if (k) fn(k); });
  const field = (label, v, fn, step = 0.1) => { const i = h('input', { type: 'number', class: 'num', step: String(step), value: String(v) }); i.addEventListener('change', () => fn(Number(i.value))); return h('label', { class: 'menu-row' }, h('span', { class: 'small' }, label), i); };
  popMenu(x, y, [h('div', { class: 'menu-title' }, c.label || 'Clip'),
    field('Gain ×', c.gain ?? 1, (v) => set((k) => { k.gain = Math.max(0, Math.min(4, v)); })),
    field('Fade in (s)', c.fadeIn ?? 0, (v) => set((k) => { k.fadeIn = Math.max(0, v); })),
    field('Fade out (s)', c.fadeOut ?? 0, (v) => set((k) => { k.fadeOut = Math.max(0, v); })),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); split(); } }, 'Split at the playhead'),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); D.change((d) => { const tr = d.tracks.find((t) => t.clips.some((k) => k.id === c.id)); const k = tr.clips.find((z) => z.id === c.id); tr.clips.push({ ...JSON.parse(JSON.stringify(k)), id: undefined, start: k.start + clipLen(k) }); }); } }, 'Duplicate after'),
    c.scene ? h('button', { class: 'menu-item', onclick: () => { closeMenus(); openScene(c.scene); } }, 'Open its scene') : '',
    h('button', { class: 'menu-item danger', onclick: () => { closeMenus(); removeClip(c.id); } }, 'Delete')]);
}

const selClip = () => allClips().find(({ c }) => c.id === A.sel) ?? null;
const removeClip = (id) => { D.change((d) => { for (const t of d.tracks) t.clips = t.clips.filter((k) => k.id !== id); }); if (A.sel === id) A.sel = null; };
function split() {
  const s = selClip();
  if (!s) return;
  const { c } = s;
  const at = A.playhead;
  if (at <= c.start + 0.05 || at >= c.start + clipLen(c) - 0.05) return toast('Put the playhead inside the clip.');
  D.change((d) => { const tr = d.tracks.find((t) => t.clips.some((k) => k.id === c.id)); const k = tr.clips.find((z) => z.id === c.id); const cut = k.in + (at - k.start); tr.clips.push({ ...JSON.parse(JSON.stringify(k)), id: undefined, start: at, in: cut, fadeIn: 0 }); k.out = cut; k.fadeOut = 0; });
}
function onKey(e) {
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); A.playing ? stop() : play(); }
  if (e.key === 'Home') { stop(); seek(0); }
  if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); split(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && A.sel) { e.preventDefault(); e.stopImmediatePropagation(); removeClip(A.sel); }
}

// ------------------------------------------------------------------ adding sounds
/** A dropped (or picked) sound or scene becomes a clip: a scene's render plays, kept linked. */
async function addFrom(it, trackId, start) {
  if (!trackId) { D.change((d) => { d.tracks.push({ name: 'Track 1', volume: 1, pan: 0, clips: [] }); }); trackId = tracks()[0].id; }
  let asset = it.asset, scene = null, version = null, kind = it.assetKind;
  if (!asset) {
    const r = it.render ?? (await api(`/v1/scenes/${it.scene}`)).doc.render;
    if (!r?.asset) { toast(`"${it.title}" has no render yet.`, { action: 'Open it', onAction: () => openScene(it.scene) }); return; }
    if (!['audio', 'video'].includes(r.kind)) { toast(`A ${r.kind} has no sound.`); return; }
    asset = r.asset; scene = it.scene; version = r.version; kind = r.kind;
  }
  const info = await mediaInfo(asset, kind === 'video' ? 'video' : 'audio');
  const dur = info.duration ?? 4;
  D.change((d) => { const tr = d.tracks.find((t) => t.id === trackId) ?? d.tracks[0]; tr.clips.push({ label: it.title ?? 'Sound', asset, ...(scene ? { scene, sceneVersion: version } : {}), start: Math.round(start * 100) / 100, in: 0, out: dur, duration: dur, gain: 1, fadeIn: 0, fadeOut: 0 }); });
}

/** Generate music, a voice line or a sound effect onto the selected track at the playhead. */
function genMenu(btn) {
  const r = btn.getBoundingClientRect();
  const kinds = [['music', 'Music', 'audio.music'], ['voice', 'A voice line', 'audio.voice'], ['sfx', 'A sound effect', 'audio.sfx']];
  popMenu(r.left, r.bottom + 6, [h('div', { class: 'menu-title' }, 'Generate'), ...kinds.map(([k, label, tool]) => h('button', { class: 'menu-item', onclick: () => { closeMenus(); genPop(k, label, tool); } }, label))]);
}
function genPop(kind, label, tool) {
  $('#audPop')?.remove();
  const text = h('textarea', { rows: '2', placeholder: kind === 'music' ? 'Moody synthwave, slow build, 90 BPM' : kind === 'voice' ? 'What they say' : 'Thunder rolling far away' });
  const voice = kind === 'voice' ? h('select', {}, ...A.voices.map((v) => h('option', { value: v.id }, `${v.name}${v.about ? ` · ${v.about.split(',').slice(0, 2).join(',')}` : ''}`))) : null;
  const secs = kind === 'voice' ? null : h('input', { type: 'number', class: 'num', min: kind === 'music' ? '10' : '0.5', max: kind === 'music' ? '240' : '30', step: kind === 'music' ? '5' : '0.5', value: kind === 'music' ? '30' : '3' });
  const q = h('span', { class: 'quote' });
  const params = () => (kind === 'music' ? { prompt: text.value.trim(), seconds: Number(secs.value) || 30 } : kind === 'voice' ? { text: text.value.trim(), voice: voice.value, provider: 'elevenlabs' } : { text: text.value.trim(), duration: Number(secs.value) || 3, provider: 'elevenlabs' });
  const price = () => quote(tool, params()).then((x) => { q.textContent = x ? credits(x) : ''; });
  price();
  const pop = h('div', { class: 'sheet-pop img-pop', id: 'audPop' }, h('div', { class: 'sheet-head' }, h('b', {}, label), h('button', { class: 'icon-btn', onclick: () => pop.remove() }, icon('close'))),
    text, voice ? h('label', { class: 'field' }, 'Voice', voice) : '', secs ? h('label', { class: 'field' }, 'Seconds', secs) : '',
    h('div', { class: 'sheet-foot' }, q, h('button', { class: 'primary', onclick: () => {
      if (!text.value.trim()) return toast('Say what to make.');
      const p = params();
      const trackId = A.selTrack ?? tracks()[0]?.id;
      const at = A.playhead;
      let id = null;
      runJob({ tool, params: p, label: text.value.trim().slice(0, 50), onStart: (job) => D.change((d) => {
        const tr = d.tracks.find((t) => t.id === trackId) ?? d.tracks[0];
        const len = p.seconds ?? p.duration ?? Math.max(1.5, text.value.split(/\s+/).length / 2.6);
        id = `k_${Math.random().toString(36).slice(2, 10)}`;
        tr.clips.push({ id, label: text.value.trim().slice(0, 60), pending: job, start: at, in: 0, out: len, gain: 1, fadeIn: 0, fadeOut: 0 });
      }) }).then(async (done) => {
        const out = done.outputs.find((o) => o.kind === 'audio');
        const info = out ? await mediaInfo(out.asset, 'audio') : {};
        D.change((d) => { const k = d.tracks.flatMap((t) => t.clips).find((z) => z.id === id); if (k && out) { k.asset = out.asset; delete k.pending; if (info.duration) { k.duration = info.duration; k.out = info.duration; } } }, { history: false });
      }).catch(() => D.change((d) => { const k = d.tracks.flatMap((t) => t.clips).find((z) => z.id === id); if (k) { delete k.pending; k.failed = 'It failed'; } }, { history: false }));
      pop.remove();
    } }, icon('sparkle'), 'Generate')));
  pop.addEventListener('input', () => { clearTimeout(pop._t); pop._t = setTimeout(price, 350); });
  $('#viewerWrap').append(pop);
  text.focus();
}

// ------------------------------------------------------------------ playing and mixing
async function buffer(ctx, asset) {
  if (!A.buffers.has(asset)) A.buffers.set(asset, fetch(fileUrl(asset)).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).catch(() => null));
  return A.buffers.get(asset);
}
/**
 * The mix as a graph on any context (live or offline): each audible clip from `from` seconds, with its gain and fades,
 * through its track's volume and pan. Returns the sources (to stop them).
 */
async function wire(ctx, from, when) {
  const solo = tracks().some((t) => t.solo);
  const out = [];
  for (const t of tracks()) {
    if (t.mute || (solo && !t.solo)) continue;
    const vol = ctx.createGain(); vol.gain.value = t.volume;
    const pan = ctx.createStereoPanner(); pan.pan.value = t.pan;
    vol.connect(pan).connect(ctx.destination);
    for (const c of t.clips) {
      if (!c.asset) continue;
      const end = c.start + clipLen(c);
      if (end <= from) continue;
      const buf = await buffer(ctx, c.asset);
      if (!buf) continue;
      const src = ctx.createBufferSource(); src.buffer = buf;
      const g = ctx.createGain();
      const startAt = when + Math.max(0, c.start - from);
      const skip = Math.max(0, from - c.start);
      const dur = clipLen(c) - skip;
      const gain = c.gain ?? 1;
      g.gain.setValueAtTime(gain, startAt);
      if (c.fadeIn && skip < c.fadeIn) { g.gain.setValueAtTime(gain * (skip / c.fadeIn), startAt); g.gain.linearRampToValueAtTime(gain, startAt + (c.fadeIn - skip)); }
      if (c.fadeOut) { const fs = Math.max(startAt, startAt + dur - c.fadeOut); g.gain.setValueAtTime(gain, fs); g.gain.linearRampToValueAtTime(0, startAt + dur); }
      src.connect(g).connect(vol);
      src.start(startAt, c.in + skip, dur);
      out.push(src);
    }
  }
  return out;
}
async function play() {
  A.ctx ??= new AudioContext();
  await A.ctx.resume();
  stop(false);
  A.playing = true;
  A.from = A.playhead;
  A.t0 = A.ctx.currentTime + 0.08;
  A.nodes = await wire(A.ctx, A.from, A.t0);
  drawBar();
  const tick = () => {
    if (!A.playing) return;
    A.playhead = A.from + (A.ctx.currentTime - A.t0);
    if (A.playhead >= docLen()) { stop(); A.playhead = docLen(); }
    movePlayhead();
    A.raf = requestAnimationFrame(tick);
  };
  tick();
}
function stop(redraw = true) {
  for (const n of A.nodes) { try { n.stop(); } catch { /* */ } }
  A.nodes = [];
  A.playing = false;
  cancelAnimationFrame(A.raf);
  if (redraw && $('#audBar')) drawBar();
}
/** A change to volume, pan, mute or solo while playing: the mix starts again from where it is. */
function liveMix() { if (A.playing) { const at = A.playhead; stop(false); A.playhead = at; play(); } }
function seek(t) { A.playhead = Math.max(0, t); if (A.playing) liveMix(); movePlayhead(); }
function movePlayhead() {
  const ph = $('#audPlayhead');
  if (ph) ph.style.left = `${A.playhead * A.pps}px`;
  const tc = $('#audTc');
  if (tc) tc.textContent = `${fmt(A.playhead, 2)} / ${fmt(docLen(), 1)}`;
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

/** The mixdown: the same graph rendered offline, a WAV uploaded, and recorded as the scene's render. */
async function mixdown() {
  if (!D.doc) return;
  if (allClips().some(({ c }) => c.pending)) return toast('Some clips are still being made.');
  if (!allClips().some(({ c }) => c.asset)) return toast('Add some sound first.');
  await D.save();
  toast('Mixing down…');
  try {
    const rate = 44100;
    const len = Math.max(...allClips().filter(({ c }) => c.asset).map(({ c }) => c.start + clipLen(c)));
    const off = new OfflineAudioContext(2, Math.ceil(len * rate), rate);
    await wire(off, 0, 0);
    const blob = wav(await off.startRendering());
    const name = `${D.doc.title}.wav`;
    const r = await fetch(`/v1/assets?project=${encodeURIComponent(state.user.project)}&title=${encodeURIComponent(name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav', 'X-Filename': name }, body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status);
    const s = await setRender(D.scene.id, j.id ?? j.asset?.id, 'audio');
    D.take(s, { keepHistory: true });
    bus.emit('jobDone');
    toast(`Mixed down (${fmt(len, 1)}). It's in Media, and videos and audio scenes that use this one can update to it.`);
  } catch (err) {
    toast(plainError(err.message));
  }
}
