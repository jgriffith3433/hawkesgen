// The image editor (scenes.js; src/scenekinds.ts "image"): a picture in layers, bottom first. Pictures (from the
// library, generated, or another scene's render: a stage photo, an image scene), text and color fills, each placed by its
// center and width, turned, faded and blended. Click a layer on the canvas to select it: drag to move, a corner to size,
// the top handle to turn. Gen's image tools work on the selected layer (the result replaces its file and keeps its size).
// Render flattens it into one picture: the scene's render, which video and other image scenes play.

import { $, $$, h, api, toast, fileUrl, bus, icon, plainError, ApiError } from './lib.js';
import { runJob, quote, credits } from './media.js';
import { libraryPicker, hasTool } from './studio.js';
import { state } from './account.js';
import { registerEditor, setRender, openScene, kindInfo, refreshBar } from './scenes.js';
import { sceneDoc } from './scenedoc.js';

const I = { sel: null, view: { scale: 1 }, imgs: new Map(), raf: 0 };
const D = sceneDoc({ onChange: () => { draw(); drawPanel(); refreshBar(); } });
const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'lighten', 'darken', 'soft-light', 'difference'];
const FONTS = ['Inter', 'Georgia', 'Impact', 'Courier New', 'Trebuchet MS', 'Palatino', 'Arial Black'];
const SIZES = [['1344x768', 'Wide 1344×768'], ['768x1344', 'Tall 768×1344'], ['1024x1024', 'Square 1024'], ['1920x1080', 'HD 1920×1080'], ['1080x1350', 'Portrait 1080×1350'], ['2048x2048', 'Large square 2048']];
const lay = () => D.doc?.layers ?? [];
const selected = () => lay().find((l) => l.id === I.sel) ?? null;

registerEditor({
  kind: 'image', label: 'Image', icon: 'image', panel: 'Layers',
  async mount(scene) {
    I.sel = null;
    mountSurface();
    D.take(scene);
    checkStale(scene.uses ?? []);
  },
  async unmount() { await D.save(); D.stop(); $('#imgWrap')?.remove(); $('#imgBar')?.remove(); $('#staleBar')?.remove(); removeEventListener('keydown', onKey, true); },
  undo: () => D.undo(), redo: () => D.redo(), canUndo: () => D.canUndo(), canRedo: () => D.canRedo(), save: () => D.save(),
  action: { label: 'Render', icon: 'image', run: () => renderImage() },
  rename: (title) => D.change((d) => { d.title = title; }),
  accepts: (it) => (it.asset ? it.assetKind === 'image' : ['image', 'stage'].includes(it.kind)),
  drop: (it, e) => addFrom(it, e),
  uses: (s) => [{ label: 'Add as a layer here', run: () => addFrom({ scene: s.id, kind: s.kind, title: s.title, render: s.render }) }],
  ai: { selection: () => ({ layer: I.sel }) },
  take: (scene) => D.take(scene),
});

// ------------------------------------------------------------------ the surface
function mountSurface() {
  $('#imgWrap')?.remove();
  const canvas = h('canvas', { id: 'imgCanvas', class: 'img-canvas' });
  const box = h('div', { id: 'imgSelBox', class: 'img-sel', hidden: true },
    ...['nw', 'ne', 'sw', 'se'].map((c) => h('span', { class: `img-h ${c}`, 'data-h': c })), h('span', { class: 'img-h rot', 'data-h': 'rot' }));
  const frame = h('div', { class: 'img-frame', id: 'imgFrame' }, canvas, box);
  $('#viewer').append(h('div', { id: 'imgWrap', class: 'img-wrap' }, frame));
  const bar = h('div', { id: 'imgBar', class: 'dir-bar img-bar' });
  $('#viewerWrap').insertBefore(bar, $('#toolbar'));
  new ResizeObserver(() => fitView()).observe($('#imgWrap'));
  canvas.addEventListener('pointerdown', onDown);
  box.addEventListener('pointerdown', onDown);
  addEventListener('keydown', onKey, true);
}

function fitView() {
  const wrap = $('#imgWrap');
  if (!wrap || !D.doc) return;
  const r = wrap.getBoundingClientRect();
  const s = Math.min((r.width - 32) / D.doc.width, (r.height - 32) / D.doc.height, 4);
  I.view.scale = Math.max(0.02, s);
  const c = $('#imgCanvas');
  c.style.width = `${D.doc.width * I.view.scale}px`;
  c.style.height = `${D.doc.height * I.view.scale}px`;
  drawSel();
}

function imgOf(asset) {
  if (!I.imgs.has(asset)) {
    const im = new Image();
    im.onload = () => draw();
    im.src = fileUrl(asset);
    I.imgs.set(asset, im);
  }
  return I.imgs.get(asset);
}

/** A layer's box on the canvas: center, width, height (before turning). */
function boxOf(l, ctx) {
  if (l.type === 'fill') return { x: D.doc.width / 2, y: D.doc.height / 2, w: D.doc.width, h: D.doc.height };
  if (l.type === 'text') {
    const lines = String(l.text ?? '').split('\n');
    ctx.font = `${l.weight ?? 700} ${l.size}px "${l.font}"`;
    const w = Math.max(10, ...lines.map((t) => ctx.measureText(t).width));
    return { x: l.x, y: l.y, w, h: lines.length * l.size * 1.15 };
  }
  const im = l.asset ? imgOf(l.asset) : null;
  const nw = im?.naturalWidth || 512, nh = im?.naturalHeight || 512;
  const w = l.w ?? nw;
  return { x: l.x, y: l.y, w, h: (w * nh) / nw };
}

/** Draws the layers onto a 2D context at the document's size (the view and the render use the same code). */
function paint(ctx, { forRender = false } = {}) {
  const d = D.doc;
  ctx.clearRect(0, 0, d.width, d.height);
  if (d.background) { ctx.fillStyle = d.background; ctx.fillRect(0, 0, d.width, d.height); }
  for (const l of d.layers) {
    if (l.hidden) continue;
    ctx.save();
    ctx.globalAlpha = l.opacity ?? 1;
    ctx.globalCompositeOperation = l.blend === 'normal' ? 'source-over' : l.blend;
    if (l.type === 'fill') { ctx.fillStyle = l.color; ctx.fillRect(0, 0, d.width, d.height); ctx.restore(); continue; }
    const b = boxOf(l, ctx);
    ctx.translate(b.x, b.y);
    ctx.rotate(((l.rotation ?? 0) * Math.PI) / 180);
    if (l.type === 'text') {
      ctx.font = `${l.weight ?? 700} ${l.size}px "${l.font}"`;
      ctx.fillStyle = l.color;
      ctx.textBaseline = 'middle';
      ctx.textAlign = l.align ?? 'center';
      const lines = String(l.text ?? '').split('\n');
      const ax = l.align === 'left' ? -b.w / 2 : l.align === 'right' ? b.w / 2 : 0;
      lines.forEach((t, i) => ctx.fillText(t, ax, (i - (lines.length - 1) / 2) * l.size * 1.15));
    } else {
      const im = l.asset ? imgOf(l.asset) : null;
      if (im?.complete && im.naturalWidth) ctx.drawImage(im, -b.w / 2, -b.h / 2, b.w, b.h);
      else if (!forRender) {
        ctx.fillStyle = 'rgba(139,123,255,.18)'; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        ctx.fillStyle = '#c9c3ff'; ctx.font = `600 ${Math.max(14, b.w / 18)}px Inter`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(l.pending ? 'Making…' : l.failed ? 'Failed' : l.scene ? 'Not rendered yet' : 'Empty', 0, 0);
      }
    }
    ctx.restore();
  }
}

function draw() {
  cancelAnimationFrame(I.raf);
  I.raf = requestAnimationFrame(() => {
    const c = $('#imgCanvas');
    if (!c || !D.doc) return;
    if (c.width !== D.doc.width || c.height !== D.doc.height) { c.width = D.doc.width; c.height = D.doc.height; fitView(); }
    c.classList.toggle('clear', !D.doc.background);
    paint(c.getContext('2d'));
    drawSel();
    drawBar();
  });
}

/** The selection box over the canvas (in screen pixels), turned with the layer. */
function drawSel() {
  const box = $('#imgSelBox');
  if (!box) return;
  const l = selected();
  if (!l || l.type === 'fill' || l.hidden) { box.hidden = true; return; }
  const b = boxOf(l, $('#imgCanvas').getContext('2d'));
  const s = I.view.scale;
  box.hidden = false;
  box.classList.toggle('locked', Boolean(l.locked));
  Object.assign(box.style, { left: `${(b.x - b.w / 2) * s}px`, top: `${(b.y - b.h / 2) * s}px`, width: `${b.w * s}px`, height: `${b.h * s}px`, transform: `rotate(${l.rotation ?? 0}deg)` });
}

// ------------------------------------------------------------------ the mouse
const toDoc = (e) => { const r = $('#imgCanvas').getBoundingClientRect(); return { x: (e.clientX - r.left) / I.view.scale, y: (e.clientY - r.top) / I.view.scale }; };
function hit(p) {
  const ctx = $('#imgCanvas').getContext('2d');
  for (const l of [...lay()].reverse()) {
    if (l.hidden || l.type === 'fill') continue;
    const b = boxOf(l, ctx);
    const a = (-(l.rotation ?? 0) * Math.PI) / 180;
    const dx = p.x - b.x, dy = p.y - b.y;
    const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(x) <= b.w / 2 && Math.abs(y) <= b.h / 2) return l;
  }
  return null;
}
function onDown(e) {
  if (!D.doc) return;
  const p0 = toDoc(e);
  const handle = e.target.dataset?.h;
  let l = handle ? selected() : hit(p0);
  if (!handle) { I.sel = l?.id ?? null; draw(); drawPanel(); }
  if (!l || l.locked) return;
  e.preventDefault();
  const start = { x: l.x, y: l.y, w: boxOf(l, $('#imgCanvas').getContext('2d')).w, size: l.size, rot: l.rotation ?? 0 };
  let first = true;
  const move = (ev) => {
    const p = toDoc(ev);
    D.change((d) => {
      const x = d.layers.find((y) => y.id === l.id);
      if (!x) return;
      if (handle === 'rot') x.rotation = Math.round((Math.atan2(p.y - start.y, p.x - start.x) * 180) / Math.PI + 90);
      else if (handle) {
        const k = Math.max(0.02, Math.hypot(p.x - start.x, p.y - start.y) / Math.max(1, Math.hypot(p0.x - start.x, p0.y - start.y)));
        if (x.type === 'text') x.size = Math.round(Math.max(4, start.size * k)); else x.w = Math.round(Math.max(4, start.w * k));
      } else { x.x = Math.round(start.x + p.x - p0.x); x.y = Math.round(start.y + p.y - p0.y); }
    }, { history: first, redraw: false });
    first = false;
    draw();
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); drawPanel(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
function onKey(e) {
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const l = selected();
  if (!l) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); removeLayer(l.id); }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); e.stopImmediatePropagation(); duplicate(l.id); }
  const n = e.shiftKey ? 10 : 1;
  const nudge = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] }[e.key];
  if (nudge && !l.locked) { e.preventDefault(); e.stopImmediatePropagation(); D.change((d) => { const x = d.layers.find((y) => y.id === l.id); x.x += nudge[0]; x.y += nudge[1]; }); }
}

// ------------------------------------------------------------------ layers
const newLayer = (props) => ({ id: `l_${Math.random().toString(36).slice(2, 10)}`, x: D.doc.width / 2, y: D.doc.height / 2, w: null, rotation: 0, opacity: 1, blend: 'normal', ...props });
function addLayer(props) {
  const l = newLayer(props);
  D.change((d) => { d.layers.push(l); });
  I.sel = l.id;
  draw();
  drawPanel();
  return l;
}
const removeLayer = (id) => { D.change((d) => { d.layers = d.layers.filter((l) => l.id !== id); }); if (I.sel === id) I.sel = null; };
const duplicate = (id) => { const l = lay().find((x) => x.id === id); if (!l) return; const c = { ...JSON.parse(JSON.stringify(l)), id: undefined, name: `${l.name} copy`, x: l.x + 24, y: l.y + 24 }; delete c.pending; addLayer(c); };
const moveLayer = (id, by) => D.change((d) => { const i = d.layers.findIndex((l) => l.id === id); const j = i + by; if (i < 0 || j < 0 || j >= d.layers.length) return; [d.layers[i], d.layers[j]] = [d.layers[j], d.layers[i]]; });

/** A dropped (or "Use in") file or scene becomes a layer: a scene's render, kept linked so it can update. */
async function addFrom(it, e) {
  const at = e?.clientX != null && $('#imgCanvas') ? toDoc(e) : null;
  const pos = at ? { x: Math.round(at.x), y: Math.round(at.y) } : {};
  if (it.asset) { addLayer({ name: it.title || 'Picture', type: 'image', asset: it.asset, ...pos, w: Math.round(D.doc.width * 0.6) }); return; }
  const r = it.render ?? (await api(`/v1/scenes/${it.scene}`)).doc.render;
  if (!r?.asset) { toast(`"${it.title}" has no render yet.`, { action: 'Open it', onAction: () => openScene(it.scene) }); return; }
  if (r.kind !== 'image') { toast(it.kind === 'stage' ? 'Take a Photo of the stage, then add the photo here.' : `A ${r.kind} can't be a layer.`); return; }
  addLayer({ name: it.title, type: 'image', asset: r.asset, scene: it.scene, sceneVersion: r.version, ...pos, w: Math.round(D.doc.width * (it.kind === 'image' ? 1 : 0.6)) });
}

function checkStale(uses) {
  $('#staleBar')?.remove();
  const stale = uses.filter((u) => u.render?.asset && lay().some((l) => l.scene === u.id && (l.sceneVersion ?? 0) < u.render.version));
  if (!stale.length) return;
  const bar = h('div', { class: 'stale-bar', id: 'staleBar' }, icon('sparkle'), h('span', {}, `${stale.map((u) => `"${u.title}"`).join(', ')} rendered again since it was placed.`),
    h('button', { class: 'primary small', onclick: () => { D.change((d) => { for (const u of stale) for (const l of d.layers) if (l.scene === u.id) { l.asset = u.render.asset; l.sceneVersion = u.render.version; } }); bar.remove(); } }, 'Update'),
    h('button', { class: 'icon-btn small', title: 'Not now', onclick: () => bar.remove() }, icon('close')));
  $('#viewerWrap').prepend(bar);
}

// ------------------------------------------------------------------ tools on a layer
const TOOLS = [
  { id: 'image.edit', label: 'Edit with words', icon: 'wand', prompt: 'What to change, e.g. make it night with a full moon', inputs: (a) => ({ images: [a] }) },
  { id: 'image.relight', label: 'Relight', icon: 'sun', prompt: 'The light, e.g. warm golden hour from the left', inputs: (a) => ({ image: a }) },
  { id: 'image.remove-background', label: 'Remove background', icon: 'layers', inputs: (a) => ({ image: a }), alt: 'image.cutout' },
  { id: 'image.upscale', label: 'Upscale', icon: 'zoomIn', inputs: (a) => ({ image: a }) },
  { id: 'image.restore', label: 'Restore', icon: 'sparkle', inputs: (a) => ({ image: a }) },
  { id: 'image.expand', label: 'Expand', icon: 'expand', choices: [['16:9', 'Wide'], ['9:16', 'Tall'], ['1:1', 'Square']], inputs: (a) => ({ image: a }) },
];
/** Runs a Gen tool on a layer: the layer waits on the job, and its new file keeps the layer's size on the canvas. */
function runOn(l, tool, params = {}) {
  const t = TOOLS.find((x) => x.id === tool);
  const id = hasTool(tool) ? tool : t?.alt;
  if (!id || !hasTool(id)) return toast(`${t?.label ?? tool} isn't on this Gen.`);
  const w = boxOf(l, $('#imgCanvas').getContext('2d')).w;
  runJob({ tool: id, params, inputs: t.inputs(`asset:${l.asset}`), label: `${t.label}: ${l.name}`, onStart: (job) => D.change((d) => { const x = d.layers.find((y) => y.id === l.id); if (x) { D.wait(x, job); x.w = Math.round(w); } }) })
    .then((done) => {
      const outs = done.outputs ?? [];
      const out = outs.find((o) => o.title === 'cutout') ?? outs.find((o) => o.kind === 'image' && !/mask/i.test(o.title ?? '')) ?? outs[0];
      D.change((d) => { const x = d.layers.find((y) => y.id === l.id); if (x && out) { x.asset = out.asset; delete x.pending; delete x.scene; } }, { history: false });
    })
    .catch(() => D.change((d) => { const x = d.layers.find((y) => y.id === l.id); if (x) { delete x.pending; x.failed = 'The tool failed'; } }, { history: false }));
}

function toolPop(l, t, anchor) {
  $('#imgPop')?.remove();
  const input = t.prompt ? h('textarea', { rows: '2', placeholder: t.prompt }) : null;
  let choice = t.choices?.[0]?.[0];
  const chips = t.choices ? h('div', { class: 'chips' }, ...t.choices.map(([v, label], i) => h('button', { type: 'button', class: `chip${i === 0 ? ' on' : ''}`, onclick: (e) => { choice = v; $$('.chip', chips).forEach((x) => x.classList.toggle('on', x === e.currentTarget)); } }, label))) : null;
  const q = h('span', { class: 'quote' });
  const params = () => ({ ...(input ? { prompt: input.value.trim() } : {}), ...(choice ? { aspect: choice } : {}) });
  quote(hasTool(t.id) ? t.id : t.alt, params()).then((r) => { q.textContent = r ? credits(r) : ''; });
  const pop = h('div', { class: 'sheet-pop img-pop', id: 'imgPop' }, h('div', { class: 'sheet-head' }, h('b', {}, `${t.label}: ${l.name}`), h('button', { class: 'icon-btn', onclick: () => pop.remove() }, icon('close'))),
    input ?? '', chips ?? '', h('div', { class: 'sheet-foot' }, q, h('button', { class: 'primary', onclick: () => { if (input && !input.value.trim()) return toast('Say what you want.'); runOn(l, t.id, params()); pop.remove(); } }, icon('sparkle'), t.label)));
  $('#viewerWrap').append(pop);
  input?.focus();
}

function drawBar() {
  const bar = $('#imgBar');
  if (!bar || !D.doc) return;
  const l = selected();
  const sizeSel = h('select', { class: 'aspect', title: 'Canvas size', onchange: (e) => { const [w, hh] = e.target.value.split('x').map(Number); D.change((d) => { const kx = w / d.width, ky = hh / d.height; for (const x of d.layers) { x.x = Math.round(x.x * kx); x.y = Math.round(x.y * ky); } d.width = w; d.height = hh; }); fitView(); } },
    ...SIZES.map(([v, label]) => h('option', { value: v, selected: v === `${D.doc.width}x${D.doc.height}` }, label)),
    SIZES.some(([v]) => v === `${D.doc.width}x${D.doc.height}`) ? '' : h('option', { value: `${D.doc.width}x${D.doc.height}`, selected: true }, `${D.doc.width}×${D.doc.height}`));
  const bg = h('input', { type: 'color', value: D.doc.background ?? '#000000', title: 'Background', onchange: (e) => D.change((d) => { d.background = e.target.value; }) });
  const clear = h('button', { class: `chip small${D.doc.background ? '' : ' on'}`, title: 'A transparent background', onclick: () => D.change((d) => { d.background = d.background ? null : '#1b1e26'; }) }, 'Transparent');
  const tools = l && l.type === 'image' && l.asset && !l.pending
    ? TOOLS.filter((t) => hasTool(t.id) || (t.alt && hasTool(t.alt))).map((t) => h('button', { class: 'tb', onclick: (e) => (t.prompt || t.choices ? toolPop(l, t, e.currentTarget) : runOn(l, t.id)) }, icon(t.icon), h('span', {}, t.label)))
    : [];
  bar.replaceChildren(
    h('span', { class: 'muted small' }, l ? `${l.name}${l.pending ? ' · making…' : l.failed ? ` · ${l.failed}` : ''}` : `${D.doc.width}×${D.doc.height}`),
    ...tools,
    l?.type === 'image' && l.asset ? h('button', { class: 'tb', title: 'Every tool that takes this picture', onclick: () => bus.emit('useIn', { tool: 'video.i2v', asset: { id: l.asset, kind: 'image', title: l.name } }) }, icon('film'), h('span', {}, 'Animate')) : '',
    h('span', { class: 'tl-spacer' }), sizeSel, bg, clear);
}

// ------------------------------------------------------------------ the Layers panel
function drawPanel() {
  const box = $('#kindPanel');
  if (!box || !D.doc) return;
  const l = selected();
  const row = (x) => h('div', { class: `img-layer${x.id === I.sel ? ' on' : ''}`, onclick: () => { I.sel = x.id; draw(); drawPanel(); } },
    h('button', { class: 'icon-btn small', title: x.hidden ? 'Show' : 'Hide', onclick: (e) => { e.stopPropagation(); D.change((d) => { const y = d.layers.find((z) => z.id === x.id); y.hidden = !y.hidden || undefined; }); } }, icon(x.hidden ? 'eyeOff' : 'eye')),
    h('span', { class: 'img-thumb' }, x.type === 'image' && x.asset ? h('img', { src: fileUrl(x.asset), alt: '' }) : x.type === 'fill' ? h('span', { class: 'img-swatch', style: { background: x.color } }) : icon(x.type === 'text' ? 'text' : 'image')),
    h('span', { class: 'img-layer-t' }, x.name, x.pending ? h('span', { class: 'muted small' }, ' · making…') : x.failed ? h('span', { class: 'error small' }, ` · ${x.failed}`) : x.scene ? h('span', { class: 'muted small' }, ' · linked') : ''),
    h('button', { class: 'icon-btn small', title: x.locked ? 'Unlock' : 'Lock', onclick: (e) => { e.stopPropagation(); D.change((d) => { const y = d.layers.find((z) => z.id === x.id); y.locked = !y.locked || undefined; }); } }, icon(x.locked ? 'lock' : 'unlock')));
  const set = (fn) => D.change((d) => { const y = d.layers.find((z) => z.id === l.id); if (y) fn(y); });
  const num = (label, v, fn, step = 1) => { const i = h('input', { type: 'number', class: 'num', step: String(step), value: String(v) }); i.addEventListener('change', () => fn(Number(i.value))); return h('label', { class: 'img-num' }, h('span', { class: 'muted small' }, label), i); };
  const props = l ? h('div', { class: 'img-props' },
    h('div', { class: 'row' }, (() => { const n = h('input', { type: 'text', value: l.name }); n.addEventListener('change', () => set((y) => { y.name = n.value.trim() || y.name; })); return n; })()),
    l.type === 'text' ? (() => { const t = h('textarea', { rows: '3' }, l.text); t.addEventListener('input', () => D.change((d) => { const y = d.layers.find((z) => z.id === l.id); y.text = t.value; }, { history: false })); t.addEventListener('focus', () => D.change(() => {}, { redraw: false })); return t; })() : '',
    l.type === 'text' ? h('div', { class: 'row img-text' },
      h('select', { onchange: (e) => set((y) => { y.font = e.target.value; }) }, ...FONTS.map((f) => h('option', { value: f, selected: f === l.font }, f))),
      h('select', { onchange: (e) => set((y) => { y.weight = Number(e.target.value); }) }, ...[300, 400, 600, 700, 900].map((w) => h('option', { value: String(w), selected: w === l.weight }, String(w)))),
      h('input', { type: 'color', value: l.color, onchange: (e) => set((y) => { y.color = e.target.value; }) }),
      ...['left', 'center', 'right'].map((a) => h('button', { class: `chip small${l.align === a ? ' on' : ''}`, onclick: () => set((y) => { y.align = a; }) }, a[0].toUpperCase() + a.slice(1)))) : '',
    l.type === 'fill' ? h('label', { class: 'field' }, 'Color', h('input', { type: 'color', value: l.color, onchange: (e) => set((y) => { y.color = e.target.value; }) })) : '',
    l.type !== 'fill' ? h('div', { class: 'img-nums' }, num('X', l.x, (v) => set((y) => { y.x = v; })), num('Y', l.y, (v) => set((y) => { y.y = v; })),
      l.type === 'text' ? num('Size', l.size, (v) => set((y) => { y.size = Math.max(4, v); })) : num('Width', Math.round(boxOf(l, $('#imgCanvas')?.getContext('2d') ?? document.createElement('canvas').getContext('2d')).w), (v) => set((y) => { y.w = Math.max(4, v); })),
      num('Turn', l.rotation ?? 0, (v) => set((y) => { y.rotation = v; }))) : '',
    h('label', { class: 'field dir-slider' }, h('span', { class: 'row' }, 'Opacity', h('span', { class: 'muted small' }, `${Math.round((l.opacity ?? 1) * 100)}%`)),
      (() => { const r = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(l.opacity ?? 1) }); let first = true; r.addEventListener('input', () => { D.change((d) => { d.layers.find((z) => z.id === l.id).opacity = Number(r.value); }, { history: first }); first = false; }); r.addEventListener('change', drawPanel); return r; })()),
    h('label', { class: 'field' }, 'Blend', h('select', { onchange: (e) => set((y) => { y.blend = e.target.value; }) }, ...BLENDS.map((b) => h('option', { value: b, selected: b === l.blend }, b[0].toUpperCase() + b.slice(1))))),
    l.scene ? h('button', { class: 'ghost small', onclick: () => openScene(l.scene) }, icon(kindInfo('image').icon), 'Open its scene') : '',
    h('div', { class: 'row img-acts' },
      h('button', { class: 'icon-btn', title: 'Up', onclick: () => moveLayer(l.id, 1) }, icon('up')), h('button', { class: 'icon-btn', title: 'Down', onclick: () => moveLayer(l.id, -1) }, icon('down')),
      h('button', { class: 'icon-btn', title: 'Duplicate (Ctrl+D)', onclick: () => duplicate(l.id) }, icon('copy')),
      l.type === 'image' && l.asset ? h('a', { class: 'icon-btn', title: 'Download', href: fileUrl(l.asset), download: '' }, icon('download')) : '',
      h('button', { class: 'icon-btn', title: 'Delete (Del)', onclick: () => removeLayer(l.id) }, icon('trash')))) : h('p', { class: 'muted small' }, 'Select a layer to change it.');
  box.replaceChildren(
    h('div', { class: 'row img-add' },
      h('button', { class: 'ghost small', onclick: () => libraryPicker('image', (a) => addLayer({ name: a.title || 'Picture', type: 'image', asset: a.id, w: Math.round(D.doc.width * 0.6) })) }, icon('image'), 'Picture'),
      h('button', { class: 'ghost small', onclick: () => addLayer({ name: 'Text', type: 'text', text: 'Your words', font: 'Inter', size: Math.round(D.doc.height / 9), weight: 700, color: '#ffffff', align: 'center' }) }, icon('text'), 'Text'),
      h('button', { class: 'ghost small', onclick: () => addLayer({ name: 'Fill', type: 'fill', color: '#000000', opacity: 0.4 }) }, icon('fill'), 'Fill'),
      h('button', { class: 'ghost small', onclick: () => generateLayer() }, icon('sparkle'), 'Generate')),
    h('div', { class: 'img-layers' }, ...[...lay()].reverse().map(row), lay().length ? '' : h('p', { class: 'muted small' }, 'No layers yet: add a picture, text or a fill, or ask the AI.')),
    h('h3', {}, 'Selected'), props);
}

/** A new picture layer made from words at the canvas's size (image.generate). */
function generateLayer() {
  $('#imgPop')?.remove();
  const input = h('textarea', { rows: '2', placeholder: 'A lighthouse on a cliff at dusk, storm clouds' });
  const q = h('span', { class: 'quote' });
  const size = () => { const ar = D.doc.width / D.doc.height; return ar > 1.2 ? { width: 1344, height: 768 } : ar < 0.83 ? { width: 768, height: 1344 } : { width: 1024, height: 1024 }; };
  quote('image.generate', { prompt: 'x', ...size() }).then((r) => { q.textContent = r ? credits(r) : ''; });
  const pop = h('div', { class: 'sheet-pop img-pop', id: 'imgPop' }, h('div', { class: 'sheet-head' }, h('b', {}, 'Generate a picture layer'), h('button', { class: 'icon-btn', onclick: () => pop.remove() }, icon('close'))), input,
    h('div', { class: 'sheet-foot' }, q, h('button', { class: 'primary', onclick: () => {
      const prompt = input.value.trim();
      if (!prompt) return toast('Say what to make.');
      const l = addLayer({ name: prompt.slice(0, 40), type: 'image', w: D.doc.width });
      runJob({ tool: 'image.generate', params: { prompt, ...size() }, label: prompt, onStart: (job) => D.change((d) => { const x = d.layers.find((y) => y.id === l.id); if (x) D.wait(x, job); }, { history: false }) })
        .then((done) => { const out = done.outputs.find((o) => o.kind === 'image'); D.change((d) => { const x = d.layers.find((y) => y.id === l.id); if (x && out) { x.asset = out.asset; delete x.pending; } }, { history: false }); })
        .catch(() => D.change((d) => { const x = d.layers.find((y) => y.id === l.id); if (x) { delete x.pending; x.failed = 'It failed'; } }, { history: false }));
      pop.remove();
    } }, icon('sparkle'), 'Generate')));
  $('#viewerWrap').append(pop);
  input.focus();
}

// ------------------------------------------------------------------ render
async function renderImage() {
  if (!D.doc) return;
  if (lay().some((l) => l.pending)) return toast('Some layers are still being made.');
  await D.save();
  // Every picture loaded first, so nothing renders as a placeholder.
  await Promise.all(lay().filter((l) => l.asset && !l.hidden).map((l) => new Promise((ok) => { const im = imgOf(l.asset); if (im.complete) ok(); else { im.addEventListener('load', ok, { once: true }); im.addEventListener('error', ok, { once: true }); } })));
  const c = h('canvas', { width: String(D.doc.width), height: String(D.doc.height) });
  paint(c.getContext('2d'), { forRender: true });
  try {
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    const r = await fetch(`/v1/assets?project=${encodeURIComponent(state.user.project)}&title=${encodeURIComponent(`${D.doc.title}.png`)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/png', 'X-Filename': `${D.doc.title}.png` }, body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status);
    const id = j.id ?? j.asset?.id;
    const s = await setRender(D.scene.id, id, 'image');
    D.take(s, { keepHistory: true });
    bus.emit('jobDone');
    toast('Rendered. It\'s in Media, and scenes that use this image can update to it.', { action: 'Animate it', onAction: () => bus.emit('useIn', { tool: 'video.i2v', asset: { id, kind: 'image', title: D.doc.title } }) });
  } catch (err) {
    toast(plainError(err.message));
  }
}
