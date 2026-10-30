// What you can do to the thing you're looking at: the toolbar under the viewer for the selected clip (or the library
// file open in the viewer), each tool's sheet (prompt, options, price, run), painting masks, clip settings (speed,
// volume, mute, text), and a video scene's Export (video.compose for a plain cut; a layered timeline renders in the
// browser: editor.js renderInBrowser).

import { $, $$, h, api, toast, fmt, bus, icon, mediaInfo, uploadCanvas, plainError } from './lib.js';
import { P, byId, selectedClips, clipLength, clipEnd, onTrack, setClip, remember, changed, docLength, splitAt, deleteSelected, duplicateSelected, mainTrack, trackOf, audible, isVisual } from './project.js';
import { currentSource, showSource, closeSource, startPainter, stopPainter, pause } from './player.js';
import { runJob, quote, credits, waitJob, placeAsset, showPane, assetKindLabel } from './media.js';
import { popMenu, closeMenus } from './timeline.js';
import { state, needSignIn } from './account.js';
import { toolsTaking } from './studio.js';

let available = new Set();
export async function loadAvailable() {
  try { available = new Set((await api('/v1/editor/tools')).tools.map((t) => t.tool)); } catch { available = new Set(['image.generate', 'image.edit', 'image.cutout', 'image.upscale', 'video.i2v', 'audio.music', 'audio.voice', 'audio.sfx', 'video.compose']); }
  drawToolbar();
}
const has = (t) => available.has(t);

// ------------------------------------------------------------------ prompts that move
/**
 * Wan follows a description of motion, not an instruction: "Make it fly" alone left a bird still, while the same words
 * with this wrapping made it take off (A/B on gen-beta, 2026-10-29). The AI editor writes full descriptions itself.
 */
export function motionPrompt(motion, subject) {
  const m = String(motion ?? '').trim().replace(/[.\s]+$/, '');
  return `${m}. The subject does this right away and fully within the clip, with big, clear, continuous motion and a natural, steady camera.${subject ? ` ${String(subject).trim()}` : ''}`;
}
function i2vSize(w, hh) {
  const ar = (w || 1) / (hh || 1);
  return ar > 1.15 ? { width: 832, height: 480 } : ar < 0.87 ? { width: 480, height: 832 } : { width: 640, height: 640 };
}
const framesFor = (seconds, fps = 16) => Math.min(161, Math.round((seconds * fps) / 4) * 4 + 1);

// ------------------------------------------------------------------ the target: a timeline clip or a library file
/** What the tools act on: the one selected clip with a file, else the file open in the viewer. */
function target() {
  const src = currentSource();
  if (src) return { from: 'source', asset: src.id, kind: src.kind, title: src.title, prompt: src.prompt, width: src.width, height: src.height, duration: src.duration, tool: src.tool, recipe: src.recipe };
  const cs = selectedClips();
  if (cs.length === 1) {
    const c = cs[0];
    return { from: 'clip', clip: c, asset: c.asset, kind: c.kind, title: c.label, prompt: c.label };
  }
  return cs.length > 1 ? { from: 'many', clips: cs } : null;
}

const TOOLS = {
  image: [
    { id: 'animate', icon: 'film', label: 'Animate', tool: 'video.i2v' },
    { id: 'edit', icon: 'wand', label: 'Edit', tool: 'image.edit' },
    { id: 'repaint', icon: 'brush', label: 'Repaint area', tool: 'image.repaint' },
    { id: 'expand', icon: 'expand', label: 'Expand', tool: 'image.expand' },
    { id: 'relight', icon: 'sun', label: 'Relight', tool: 'image.relight' },
    { id: 'cutout', icon: 'layers', label: 'Remove background', tool: 'image.cutout' },
    { id: 'upscale', icon: 'zoomIn', label: 'Upscale', tool: 'image.upscale' },
  ],
  video: [
    { id: 'change', icon: 'brush', label: 'Change something', tool: 'video.change' },
    { id: 'restyle', icon: 'wand', label: 'Restyle', tool: 'video.change' },
    { id: 'swap', icon: 'swap', label: 'Swap a person', tool: 'video.replace' },
    { id: 'continue', icon: 'continue', label: 'Continue the shot', tool: 'video.frame' },
    { id: 'frame', icon: 'frame', label: 'Grab this frame', tool: 'video.frame' },
    { id: 'revoice', icon: 'mic', label: 'New voice', tool: 'audio.revoice' },
    { id: 'vupscale', icon: 'zoomIn', label: 'Upscale', tool: 'video.upscale' },
    { id: 'smooth', icon: 'smooth', label: 'Smooth motion', tool: 'video.interpolate' },
  ],
  audio: [
    { id: 'revoice', icon: 'mic', label: 'New voice', tool: 'audio.revoice' },
  ],
};

export function drawToolbar() {
  const bar = $('#toolbar');
  const t = target();
  bar.replaceChildren();
  if (!t) {
    bar.append(h('span', { class: 'muted hint' }, P.doc.clips.length ? 'Select a clip to edit it (on the timeline or right here), or drag on the timeline to select a stretch.' : 'Drag media onto any track, or ask the AI to make something.'));
    return;
  }
  if (t.from === 'many') {
    bar.append(h('span', { class: 'muted hint' }, `${t.clips.length} clips selected`), tbtn('trash', 'Delete', () => deleteSelected()), tbtn('plus', 'Duplicate', () => duplicateSelected()));
    return;
  }
  if (t.from === 'source' && ['image', 'video', 'audio'].includes(t.kind)) bar.append(h('button', { class: 'tb primary', onclick: () => { placeAsset({ id: t.asset, kind: t.kind, title: t.title, prompt: t.prompt, duration: t.duration }); closeSource(); } }, icon('plus'), 'Add to timeline'));
  if (t.clip?.pending) { bar.append(h('span', { class: 'muted hint' }, 'Generating…')); return; }
  if (t.clip?.failed) {
    bar.append(h('span', { class: 'error hint' }, plainError(t.clip.failed)), tbtn('trash', 'Remove', () => deleteSelected()));
    return;
  }
  for (const tool of TOOLS[t.kind] ?? []) {
    if (!has(tool.tool) && !(tool.id === 'cutout' && has('image.remove-background'))) continue;
    bar.append(tbtn(tool.icon, tool.label, () => openTool(tool.id, t)));
  }
  // Any library file: every tool that takes it, its file, and the recipe that made it.
  if (t.asset && t.kind !== 'text' && t.kind !== 'fill') {
    bar.append(h('span', { class: 'tb-sep' }), tbtn('more', 'Use in…', (e) => useInMenu(t, e)));
    if (t.from === 'source') bar.append(tbtn('download', 'Download', () => { const a = h('a', { href: `/v1/assets/${t.asset}/file`, download: '' }); document.body.append(a); a.click(); a.remove(); }), tbtn('info', 'Details', () => details(t)));
  }
  if (t.from === 'clip') {
    bar.append(h('span', { class: 'tb-sep' }));
    if (t.kind === 'text') bar.append(tbtn('text', 'Edit text', () => editText(t.clip)));
    if (t.kind !== 'text' && t.kind !== 'fill' && t.kind !== 'image') bar.append(tbtn('speed', 'Speed', (e) => speedMenu(t.clip, e)));
    if (t.kind === 'video' || t.kind === 'audio') bar.append(tbtn('volume', 'Volume', (e) => volumeMenu(t.clip, e)));
    if (t.kind === 'image' || t.kind === 'video') bar.append(tbtn('zoomIn', 'Push in', (e) => zoomMenu(t.clip, e)));
    bar.append(tbtn('split', 'Split', () => splitAt()), tbtn('trash', 'Delete', () => deleteSelected()));
  }
}
/**
 * Gen's tools for a clip, ready to run on it (the Inspector and the clip's menu list them): for a picture, Remove
 * background, Edit, Repaint, Expand, Relight, Upscale, Animate; for a clip, Change, Restyle, Swap, Continue, Grab a
 * frame, Upscale, Smooth. The result replaces the clip's file in its spot.
 */
export function clipTools(c) {
  if (!c?.asset || c.pending) return [];
  const t = { from: 'clip', clip: c, asset: c.asset, kind: c.kind, title: c.label, prompt: c.label };
  const order = { cutout: 0, edit: 1, repaint: 2, expand: 3, relight: 4, upscale: 5, animate: 6 };
  return (TOOLS[c.kind] ?? []).filter((x) => has(x.tool) || (x.id === 'cutout' && has('image.remove-background')))
    .sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9))
    .map((x) => ({ ...x, run: () => { P.selection.clips = new Set([c.id]); bus.emit('selection'); openTool(x.id, t); } }));
}

const tbtn = (ic, label, fn) => h('button', { class: 'tb', title: label, onclick: fn }, icon(ic), h('span', {}, label));

function useInMenu(t, e) {
  const r = e.currentTarget.getBoundingClientRect();
  const list = toolsTaking(t.kind);
  popMenu(r.left, Math.max(8, r.top - Math.min(420, 34 + list.length * 33)), [h('div', { class: 'menu-title' }, 'Use in'),
    h('div', { class: 'menu-scroll' }, ...(list.length ? list.map((x) => h('button', { class: 'menu-item', onclick: () => { closeMenus(); bus.emit('useIn', { tool: x.id, asset: { id: t.asset, kind: t.kind, title: t.title } }); } }, x.label)) : [h('div', { class: 'muted small menu-title' }, 'No tool takes this yet.')]))]);
}
/** A recipe's inputs are the files' hashes; Gen takes them back as blob: refs. */
const recipeInputs = (ins = {}) => Object.fromEntries(Object.entries(ins).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => `blob:${x}`) : `blob:${v}`]));
/** What made this file: the tool and its settings (the recipe Gen keeps with every output). */
async function details(t) {
  let a = null;
  try { a = await api(`/v1/assets/${t.asset}`); } catch { /* */ }
  const tool = a?.tool ?? t.tool;
  // Uploads are filed by file.import (and converted by media.normalize): nothing to make again.
  const uploaded = !tool || /^(file\.import|media\.)/.test(tool);
  const rec = uploaded ? null : a?.recipe ?? t.recipe;
  const params = rec?.params ? Object.entries(rec.params).filter(([k]) => !['seed', 'count'].includes(k) || rec.params[k] != null) : [];
  const body = [
    h('p', { class: 'muted small' }, `${assetKindLabel(a?.kind ?? t.kind)}${uploaded ? ' · uploaded' : ` · made by ${tool}`}${a?.created ? ` · ${new Date(a.created).toLocaleString()}` : ''}`),
    params.length ? h('dl', { class: 'recipe' }, ...params.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, typeof v === 'string' ? v : JSON.stringify(v))])) : h('p', { class: 'muted small' }, 'No recipe: this file was uploaded.'),
  ];
  sheet(t.title || 'Details', body, rec?.params && tool ? {
    runLabel: 'Make another',
    quoteOf: () => ({ tool, params: { ...rec.params, seed: undefined } }),
    run: () => { runJob({ tool, params: { ...rec.params, ...(rec.params.seed != null ? { seed: Math.floor(Math.random() * 2 ** 31) } : {}) }, inputs: recipeInputs(rec.inputs), label: `Again: ${t.title ?? tool}` }); toast('Making another. It shows in Media.'); },
  } : { runLabel: 'Close', run: () => {} });
}

// ------------------------------------------------------------------ tool sheets
/** Where a tool's result goes: back into the clip (keeping its spot), or into Media. */
const placeFor = (t) => (t.from === 'clip' ? { replace: t.clip.id } : null);
const sizeOf = async (t) => {
  if (t.width && t.height) return { w: t.width, h: t.height };
  const i = await mediaInfo(t.asset, t.kind);
  return { w: i.width ?? 1024, h: i.height ?? 1024 };
};

function sheet(title, body, { run, runLabel = 'Run', quoteOf, wide = false, onClose } = {}) {
  closeSheet();
  const q = h('span', { class: 'quote' });
  const runBtn = h('button', { class: 'primary' }, icon('sparkle'), runLabel);
  const el = h('div', { class: `sheet-pop${wide ? ' wide' : ''}`, id: 'toolSheet' },
    h('div', { class: 'sheet-head' }, h('b', {}, title), h('button', { class: 'icon-btn', title: 'Close', onclick: () => closeSheet() }, icon('close'))),
    body,
    h('div', { class: 'sheet-foot' }, q, runBtn));
  el._onClose = onClose;
  $('#viewerWrap').append(el);
  const refresh = async () => { if (!quoteOf) return; const spec = quoteOf(); q.textContent = spec ? credits(await quote(spec.tool, spec.params)) : ''; };
  el.addEventListener('input', () => { clearTimeout(el._qt); el._qt = setTimeout(refresh, 300); });
  refresh();
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    try { if ((await run()) !== false) closeSheet(); } catch (err) { toast(plainError(err.message)); } finally { runBtn.disabled = false; }
  });
  el.querySelector('textarea, input')?.focus();
  return el;
}
export function closeSheet() {
  const el = $('#toolSheet');
  if (!el) return;
  el._onClose?.();
  el.remove();
}

const ta = (placeholder, value = '') => h('textarea', { rows: '2', placeholder, maxlength: '1500' }, value);
const ideas = (list, into) => h('div', { class: 'chips ideas' }, ...list.map((x) => h('button', { type: 'button', class: 'chip', onclick: () => { into.value = x; into.dispatchEvent(new Event('input', { bubbles: true })); into.focus(); } }, x)));

async function openTool(id, t) {
  if (!state.user) return needSignIn(() => openTool(id, t), 'login');
  pause();
  const sz = (t.kind === 'image' || t.kind === 'video') ? await sizeOf(t) : null;
  const place = placeFor(t);
  const input = (name = 'image') => ({ [name]: `asset:${t.asset}` });

  if (id === 'animate') {
    const p = ta('What happens? e.g. the bird spreads its wings and flies away');
    const len = h('select', {}, h('option', { value: '2' }, '2 seconds'), h('option', { value: '3', selected: true }, '3 seconds'), h('option', { value: '5' }, '5 seconds'));
    const spec = () => { const s = i2vSize(sz.w, sz.h); return { tool: 'video.i2v', params: { prompt: motionPrompt(p.value || 'gentle natural motion', t.prompt), ...s, frames: framesFor(Number(len.value)), fps: 16 } }; };
    return sheet('Animate', [p, ideas(['It flies away', 'The camera slowly pushes in', 'Wind blows through everything', 'They turn and smile at the camera', 'It explodes into pieces'], p), h('label', { class: 'field' }, 'Length', len),
      h('p', { class: 'muted small' }, 'Describe the motion: who moves, how, and where to. Bigger, clearer actions work best.')],
    { runLabel: 'Animate', quoteOf: spec, run: () => { if (!p.value.trim()) return toast('Say what should happen.'), false; runJob({ ...spec(), inputs: { start: `asset:${t.asset}` }, label: `Animate: ${p.value}`, place: t.from === 'clip' ? { replace: t.clip.id } : null }); } });
  }
  if (id === 'edit' || id === 'relight') {
    const tool = id === 'edit' ? 'image.edit' : 'image.relight';
    const p = ta(id === 'edit' ? 'What to change, e.g. make it night with a full moon' : 'The light, e.g. warm golden hour from the left');
    const spec = () => ({ tool, params: { prompt: p.value || 'x' } });
    return sheet(id === 'edit' ? 'Edit with words' : 'Relight', [p, ideas(id === 'edit' ? ['Make it night time', 'Make it snow', 'Turn it into a painting', 'Make it look like a toy', 'Remove the people'] : ['Golden hour', 'Neon night', 'Overcast and moody', 'Dramatic rim light'], p)],
      { runLabel: id === 'edit' ? 'Edit' : 'Relight', quoteOf: spec, run: () => { if (!p.value.trim()) return false; runJob({ tool, params: { prompt: p.value }, inputs: id === 'edit' ? { images: [`asset:${t.asset}`] } : input(), label: `${id === 'edit' ? 'Edit' : 'Relight'}: ${p.value}`, place }); } });
  }
  if (id === 'repaint' || id === 'change' || id === 'restyle') {
    const isVideo = t.kind === 'video';
    const tool = isVideo ? 'video.change' : 'image.repaint';
    const p = ta(id === 'restyle' ? 'The new look, e.g. hand-drawn anime, claymation, film noir' : 'What should be there instead, e.g. a red sports car');
    const painting = id !== 'restyle';
    let pt = null, back = null;
    if (painting) {
      // Paint on the image, or on the clip's first frame (the change carries through the clip).
      if (t.from === 'clip') { back = () => closeSource(); await showSource({ id: t.asset, kind: t.kind, title: t.title, width: sz.w, height: sz.h }); }
      if (isVideo) { const v = $('#sourceEl'); if (v?.tagName === 'VIDEO') { v.pause(); v.currentTime = 0; } }
    }
    const brush = h('input', { type: 'range', min: '0.01', max: '0.25', step: '0.005', value: '0.06' });
    const eraser = h('button', { type: 'button', class: 'chip' }, 'Eraser');
    const spec = () => ({ tool, params: { prompt: p.value || 'x' } });
    const body = [
      painting ? h('p', { class: 'muted small' }, isVideo ? 'Paint over what to change on the first frame. The change follows through the clip.' : 'Paint over the area to change.') : h('p', { class: 'muted small' }, 'The whole clip gets the new look, following its motion.'),
      painting ? h('div', { class: 'paint-tools' }, h('label', {}, 'Brush', brush), eraser, h('button', { type: 'button', class: 'chip', onclick: () => pt?.clear() }, 'Clear')) : '',
      p,
      id === 'restyle' ? ideas(['Hand-drawn anime', 'Claymation', 'Black and white film noir', 'Pixar-style 3D', 'Oil painting'], p) : '',
    ];
    const el = sheet(id === 'restyle' ? 'Restyle the clip' : id === 'change' ? 'Change something' : 'Repaint an area', body, {
      runLabel: id === 'restyle' ? 'Restyle' : 'Repaint', quoteOf: spec, onClose: () => { stopPainter(); back?.(); },
      run: async () => {
        if (!p.value.trim()) return toast('Say what it should become.'), false;
        let mask = null;
        if (painting) {
          if (!pt || pt.isEmpty()) { if (!isVideo) return toast('Paint the area to change first.'), false; } else mask = await uploadCanvas(pt.canvas);
        }
        const inputs = isVideo ? { video: `asset:${t.asset}`, ...(mask ? { mask } : {}) } : { image: `asset:${t.asset}`, mask };
        runJob({ tool, params: { prompt: id === 'restyle' ? `${p.value}, the whole frame in this style` : p.value }, inputs, label: `${id === 'restyle' ? 'Restyle' : 'Change'}: ${p.value}`, place });
      },
    });
    if (painting) {
      pt = startPainter({ width: sz.w, height: sz.h });
      brush.addEventListener('input', () => pt.setSize(Number(brush.value)));
      eraser.addEventListener('click', () => { const on = !eraser.classList.contains('on'); eraser.classList.toggle('on', on); pt.setErase(on); });
    }
    return el;
  }
  if (id === 'expand') {
    const aspect = h('div', { class: 'chips' }, ...[['16:9', 'Wide 16:9'], ['9:16', 'Tall 9:16'], ['1:1', 'Square'], ['4:3', '4:3'], ['21:9', 'Cinema 21:9']].map(([v, l], i) => h('button', { type: 'button', class: `chip${i === 0 ? ' on' : ''}`, 'data-v': v, onclick: (e) => { $$('.chip', aspect).forEach((x) => x.classList.toggle('on', x === e.currentTarget)); } }, l)));
    const p = ta('Optional: what\'s in the new area');
    const spec = () => ({ tool: 'image.expand', params: { aspect: $('.chip.on', aspect)?.dataset.v ?? '16:9', ...(p.value.trim() ? { prompt: p.value } : {}) } });
    return sheet('Expand the picture', [h('p', { class: 'muted small' }, 'Grows the picture to a new shape and fills the new space to match.'), aspect, p],
      { runLabel: 'Expand', quoteOf: spec, run: () => { runJob({ ...spec(), inputs: input(), label: `Expand to ${spec().params.aspect}`, place }); } });
  }
  if (id === 'cutout' || id === 'upscale' || id === 'vupscale' || id === 'smooth') {
    const map = { cutout: [has('image.cutout') ? 'image.cutout' : 'image.remove-background', has('image.cutout') ? { crop: false } : {}, 'Remove background'], upscale: ['image.upscale', {}, 'Upscale'], vupscale: ['video.upscale', {}, 'Upscale'], smooth: ['video.interpolate', { multiplier: 2 }, 'Smooth motion'] };
    const [tool, params, label] = map[id];
    const spec = () => ({ tool, params });
    return sheet(label, [h('p', { class: 'muted small' }, {
      cutout: 'Cuts the subject out onto a transparent background.', upscale: 'A sharper, bigger copy.', vupscale: 'A sharper, 4× bigger clip (slow for long clips).', smooth: 'Adds in-between frames so motion plays smoothly.',
    }[id])], { runLabel: label, quoteOf: spec, run: () => { runJob({ tool, params, inputs: input(tool.startsWith('video') ? 'video' : 'image'), label: `${label}: ${t.title ?? ''}`, place }); } });
  }
  if (id === 'swap') {
    const pick = h('div', { class: 'pick-grid' }, h('p', { class: 'muted small' }, 'Loading your images…'));
    let chosen = null;
    const p = ta('Optional: describe them');
    const s = sheet('Swap a person', [h('p', { class: 'muted small' }, 'Pick who takes over the person in this clip (a clear, full-body picture works best).'), pick, p], {
      runLabel: 'Swap', wide: true, quoteOf: () => ({ tool: 'video.replace', params: { prompt: p.value || 'x' } }),
      run: () => { if (!chosen) return toast('Pick a picture first.'), false; runJob({ tool: 'video.replace', params: { prompt: p.value || 'the character from the image' }, inputs: { image: `asset:${chosen}`, video: `asset:${t.asset}` }, label: 'Swap a person', place }); },
    });
    api(`/v1/assets?kind=image&limit=40&project=${encodeURIComponent(state.user.project)}`).then((r) => {
      pick.replaceChildren(...(r.items ?? []).map((a) => h('button', { type: 'button', class: 'pick', onclick: (e) => { chosen = a.id; $$('.pick', pick).forEach((x) => x.classList.toggle('on', x === e.currentTarget)); } }, h('img', { src: `/v1/assets/${a.id}/file`, alt: '' }))));
      if (!r.items?.length) pick.replaceChildren(h('p', { class: 'muted small' }, 'Make or upload a picture of them first.'));
    });
    return s;
  }
  if (id === 'frame') {
    const at = t.from === 'clip' ? t.clip.in + (Math.min(Math.max(P.playhead, t.clip.start), clipEnd(t.clip) - 0.01) - t.clip.start) * (t.clip.speed || 1) : ($('#sourceEl')?.currentTime ?? 0);
    return sheet('Grab this frame', [h('p', { class: 'muted small' }, `A still from ${fmt(at, 2)} into the clip, saved to Media.`)], { runLabel: 'Grab', run: () => { runJob({ tool: 'video.frame', params: { at }, inputs: input('video'), label: `Frame at ${fmt(at, 1)}` }); } });
  }
  if (id === 'continue') {
    const p = ta('What happens next? e.g. the car speeds off down the road');
    const len = h('select', {}, h('option', { value: '3', selected: true }, '3 seconds'), h('option', { value: '5' }, '5 seconds'));
    return sheet('Continue the shot', [h('p', { class: 'muted small' }, 'Picks up from the last frame and keeps going. The new clip goes right after this one.'), p, h('label', { class: 'field' }, 'Length', len)], {
      runLabel: 'Continue',
      run: async () => {
        if (!p.value.trim()) return toast('Say what happens next.'), false;
        const last = await runJob({ tool: 'video.frame', params: { at: t.from === 'clip' ? Math.max(0, t.clip.out - 0.05) : 'last' }, inputs: input('video'), label: 'Last frame' });
        const frame = last.outputs.find((o) => o.kind === 'image') ?? last.outputs[0];
        const s = i2vSize(sz.w, sz.h);
        const after = t.from === 'clip' ? t.clip : null;
        const job = runJob({ tool: 'video.i2v', params: { prompt: motionPrompt(p.value, t.prompt), ...s, frames: framesFor(Number(len.value)), fps: 16 }, inputs: { start: `asset:${frame.asset}` }, label: `Then: ${p.value}`, place: after ? { track: after.track, start: clipEnd(after) - 0.0002, seconds: Number(len.value) } : null });
        job.catch(() => {});
      },
    });
  }
  if (id === 'revoice') {
    const v = h('select', {}, ...[['A warm, calm male narrator, clear studio recording', 'Warm (male)'], ['A warm, friendly female voice, clear studio recording', 'Warm (female)'], ['A gruff, deep villain voice', 'Gruff villain'], ['A cheerful young kid, playful', 'Playful kid'], ['A robot voice, metallic and flat', 'Robot']].map(([x, l]) => h('option', { value: x }, l)));
    const d = h('input', { type: 'text', placeholder: 'Or describe the voice' });
    const spec = () => ({ tool: 'audio.revoice', params: { description: d.value.trim() || v.value } });
    return sheet('Give it a new voice', [h('p', { class: 'muted small' }, 'The same words, said by a different voice.'), h('label', { class: 'field' }, 'Voice', v), d],
      { runLabel: 'Re-voice', quoteOf: spec, run: () => { runJob({ ...spec(), inputs: t.kind === 'video' ? { video: `asset:${t.asset}` } : { audio: `asset:${t.asset}` }, label: 'New voice', place }); } });
  }
}

// ------------------------------------------------------------------ clip settings
function speedMenu(c, e) {
  const r = e.currentTarget.getBoundingClientRect();
  popMenu(r.left, r.bottom + 6, [h('div', { class: 'menu-title' }, 'Speed'),
    ...[0.25, 0.5, 0.75, 1, 1.5, 2, 4].map((s) => h('button', { class: `menu-item${(c.speed ?? 1) === s ? ' on' : ''}`, onclick: () => { closeMenus(); setClip(c.id, { speed: s === 1 ? null : s }); } }, s === 1 ? 'Normal' : `${s}×${s < 1 ? ' (slow motion)' : ''}`))]);
}
function volumeMenu(c, e) {
  const r = e.currentTarget.getBoundingClientRect();
  const range = h('input', { type: 'range', min: '0', max: '2', step: '0.05', value: String(c.volume ?? 1) });
  const val = h('span', {}, `${Math.round((c.volume ?? 1) * 100)}%`);
  let first = true;
  range.addEventListener('input', () => { val.textContent = `${Math.round(Number(range.value) * 100)}%`; setClip(c.id, { volume: Number(range.value) === 1 ? null : Number(range.value) }, { history: first }); first = false; });
  popMenu(r.left, r.bottom + 6, [h('div', { class: 'menu-title' }, 'Volume'), h('div', { class: 'menu-row' }, range, val),
    h('button', { class: `menu-item${c.muted ? ' on' : ''}`, onclick: () => { closeMenus(); setClip(c.id, { muted: c.muted ? null : true }); } }, c.muted ? 'Unmute' : 'Mute')]);
}
function zoomMenu(c, e) {
  const r = e.currentTarget.getBoundingClientRect();
  const opts = [['None', null], ['Slow push in', { from: 1, to: 1.15, x: 0.5, y: 0.45 }], ['Punch in', { from: 1.3, to: 1.3, x: 0.5, y: 0.4 }], ['Pull out', { from: 1.2, to: 1, x: 0.5, y: 0.5 }]];
  popMenu(r.left, r.bottom + 6, [h('div', { class: 'menu-title' }, 'Push in'), ...opts.map(([l, z]) => h('button', { class: 'menu-item', onclick: () => { closeMenus(); setClip(c.id, { zoom: z }); } }, l))]);
}
export function editText(c) {
  const box = h('textarea', { rows: '3' }, c.text ?? '');
  const len = h('input', { type: 'number', min: '0.2', step: '0.1', value: String(Math.round(clipLength(c) * 10) / 10) });
  sheet('Text on screen', [box, h('label', { class: 'field' }, 'Seconds on screen', len)], {
    runLabel: 'Done',
    run: () => { setClip(c.id, { text: box.value, out: c.in + Math.max(0.2, Number(len.value) || 3) }); },
  });
  $('#toolSheet .sheet-foot .primary').innerHTML = 'Done';
}

// ------------------------------------------------------------------ export
export function openExport() {
  needSignIn(async () => {
    const d = $('#exportDialog');
    const v1 = P.doc.clips.filter((c) => isVisual(c) && !trackOf(c.track)?.hidden);
    $('#exportError').hidden = true;
    $('#exportResult').replaceChildren();
    const waiting = P.doc.clips.filter((c) => c.pending).length;
    const broken = P.doc.clips.filter((c) => c.failed).length;
    const { composable } = await import('./editor.js');
    const layered = !composable();
    $('#exportNote').textContent = !v1.length ? 'Put some pictures or clips on the timeline first.'
      : waiting ? `${waiting} clip${waiting === 1 ? ' is' : 's are'} still being made. Export when they're done.`
      : broken ? `${broken} clip${broken === 1 ? '' : 's'} failed to make. Remove ${broken === 1 ? 'it' : 'them'} first.`
      : `${v1.length} clip${v1.length === 1 ? '' : 's'}, ${fmt(docLength(), 1)} long.${layered ? ' Its tracks are layered, so it renders here in your browser as it plays (keep this tab open), at the scene\'s own size.' : ''}`;
    $('#exportSize').disabled = layered;
    $('#exportFit').disabled = layered;
    d.dataset.layered = layered ? '1' : '';
    $('#exportGo').disabled = !v1.length || waiting > 0 || broken > 0;
    const shape = `${P.doc.width}x${P.doc.height}`;
    if ([...$('#exportSize').options].some((o) => o.value === shape)) $('#exportSize').value = shape;
    $('#exportFit').value = P.doc.fit === 'crop' ? 'crop' : 'pad';
    d.showModal();
  }, 'login');
}

/** The timeline as video.compose's timeline: stills become clips first (video.still), then one render. */
export async function runExport() {
  const [w, hh] = $('#exportSize').value.split('x').map(Number);
  const fit = $('#exportFit').value;
  if ((P.doc.fit ?? 'pad') !== fit) { remember(); P.doc.fit = fit; changed(); }
  const out = $('#exportResult');
  const status = h('div', { class: 'export-status' }, h('div', { class: 'working small' }, 'Preparing'));
  out.replaceChildren(status);
  $('#exportGo').disabled = true;
  try {
    if ($('#exportDialog').dataset.layered) {
      const { renderInBrowser } = await import('./editor.js');
      $('#exportDialog').close();
      toast('Rendering: the timeline plays once while it records.');
      const id = await renderInBrowser((s) => { status.firstChild.textContent = s; $('#saveState').textContent = s; });
      $('#exportDialog').showModal();
      return finish(out, id);
    }
    const main = mainTrack()?.id;
    const v1 = onTrack(main).filter(() => !trackOf(main)?.hidden);
    const stills = v1.filter((c) => c.kind === 'image');
    const stillOf = new Map();
    if (stills.length) {
      if (!has('video.still')) throw new Error('Pictures on the timeline need the still-clip tool, which isn\'t on this Gen yet. Animate them or remove them.');
      status.firstChild.textContent = `Turning ${stills.length} picture${stills.length === 1 ? '' : 's'} into clips`;
      await Promise.all(stills.map(async (c) => {
        const r = await api('/v1/jobs', { body: { project: state.user.project, tool: 'video.still', params: { seconds: Math.max(0.5, clipLength(c) * (c.speed || 1)) + 0.1, width: w, height: hh, ...(c.zoom ? { zoom: c.zoom } : {}) }, inputs: { image: `asset:${c.asset}` } } });
        const done = await waitJob(r.jobs[0].id);
        stillOf.set(c.id, (done.outputs.find((o) => o.kind === 'video') ?? done.outputs[0]).asset);
      }));
    }
    const clipsIn = v1.map((c) => `asset:${stillOf.get(c.id) ?? c.asset}`);
    const audio = P.doc.clips.filter((c) => c.kind === 'audio' && c.asset && audible(c.track));
    const texts = P.doc.clips.filter((c) => c.kind === 'text' && c.text?.trim() && !trackOf(c.track)?.hidden);
    const voice = (c) => /voice|dialog|line/i.test(trackOf(c.track)?.name ?? '');
    const music = (c) => /music|score|song/i.test(trackOf(c.track)?.name ?? '');
    const timeline = {
      clips: v1.map((c, i) => ({
        clip: i, in: stillOf.has(c.id) ? 0 : c.in, out: stillOf.has(c.id) ? clipLength(c) * (c.speed || 1) : c.out,
        ...(c.speed && c.speed !== 1 ? { speed: c.speed } : {}), ...(c.volume != null ? { volume: c.volume } : {}), ...(c.muted || !audible(main) ? { sound: false } : {}),
        ...(c.zoom && !stillOf.has(c.id) ? { zoom: c.zoom } : {}),
        ...(i < v1.length - 1 && c.transition ? { transition: c.transition, seconds: c.transitionSeconds ?? 0.5 } : {}),
      })),
      audio: audio.map((c, j) => ({ audio: j, start: c.start, in: c.in, seconds: clipLength(c), ...(c.volume != null ? { volume: c.volume } : {}), ...(c.muted ? { volume: 0 } : {}), ...(voice(c) ? { dialogue: true } : {}), ...(music(c) && audio.some(voice) ? { duck: true } : {}) })),
      captions: texts.map((c) => ({ text: c.text, start: c.start, end: clipEnd(c) })),
    };
    status.firstChild.textContent = 'Rendering';
    const r = await api('/v1/jobs', { body: { project: state.user.project, tool: 'video.compose', params: { timeline, width: w, height: hh, fps: P.doc.fps, fit, captions: texts.length ? 'burn' : 'vtt' }, inputs: { clips: clipsIn, ...(audio.length ? { audio: audio.map((c) => `asset:${c.asset}`) } : {}) }, labels: { title: `Export: ${P.doc.title}`, editor: P.id } } });
    const done = await waitJob(r.jobs[0].id, (s) => { status.firstChild.textContent = `Rendering: ${s}`; });
    const v = done.outputs.find((o) => o.kind === 'video') ?? done.outputs[0];
    finish(out, v.asset);
  } catch (err) {
    out.replaceChildren();
    $('#exportError').textContent = plainError(err.message);
    $('#exportError').hidden = false;
  } finally {
    $('#exportGo').disabled = false;
  }
}

/** The export is shown, saved to Media, and becomes this video scene's render (scenes that play it can update to it). */
function finish(out, asset) {
  out.replaceChildren(h('video', { src: `/v1/assets/${asset}/file`, controls: true, playsinline: true }),
    h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `/v1/assets/${asset}/file`, download: `${P.doc.title || 'hawkes-gen'}.mp4` }, icon('download'), 'Download'), h('span', { class: 'muted small' }, 'Also saved to Media.')));
  bus.emit('jobDone');
  if (P.id) import('./scenes.js').then((sc) => sc.setRender(P.id, asset, 'video')).then((s) => { if (s && s.id === P.id) { P.version = s.version; P.doc.render = s.doc.render; } }).catch(() => {});
}

export function initTools() {
  bus.on('selection', drawToolbar);
  bus.on('doc', drawToolbar);
  bus.on('source', () => { closeSheet(); drawToolbar(); });
  bus.on('editText', editText);
  bus.on('openClip', (c) => { if (c.asset) showSource({ id: c.asset, kind: c.kind, title: c.label }); });
  $('#exportGo').addEventListener('click', runExport);
  $('#exportClose').addEventListener('click', () => $('#exportDialog').close());
  $('#viewerBack').addEventListener('click', closeSource);
  loadAvailable();
  bus.on('signedIn', loadAvailable);
  bus.on('ready', loadAvailable);
}
