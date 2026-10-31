// Scenes in the app (src/scenes.ts): every kind of document a person makes, open side by side as tabs in the bar. A
// tab's kind decides its editor: video, image and audio are timelines (editor.js over project.js, player.js,
// timeline.js, tools.js), stage the 3D director (director.js), character a sheet (character.js). Each editor is a module
// with the same shape (EDITOR below): it mounts into the shared panes (the center, the left pane's context tab, the bar's
// main action), unmounts saving its work, and says what it takes when something is dropped on it. The timeline stays
// on screen for every kind: a stage lends it its lanes (people's moves, camera keys, lines). The Scenes tab on the left lists every scene: open one, or drag it into another
// (a character onto a stage, a stage or image into a video, an audio scene into a track): that's plug and play.

import { $, $$, h, api, toast, bus, icon, fileUrl, plainError } from './lib.js';
import { state, needSignIn } from './account.js';
import { showPane } from './media.js';
import { popMenu, closeMenus, lendTimeline } from './timeline.js';
import { touchDrag, setDrag } from './dragdrop.js';

/**
 * An editor:
 *   kind, label, icon, about           what it is
 *   mount(scene) / unmount()           take over the panes for this scene / save and let go
 *   panel, panelFirst                  the left pane's context tab name ("Shot", "Inspector"); panelFirst: show it on opening
 *   timelineKind                       a timeline scene (the timeline is its document); else
 *   timeline                           the lanes it lends the timeline (timeline.js lendTimeline), or none
 *   undo(), redo(), canUndo(), canRedo()
 *   action                             the bar's main action: { label, icon, run } ("Export", "Render", "Mixdown"...)
 *   accepts(item) / drop(item, at)     plug and play: a dragged scene or file ({ scene } or { asset }) it can take
 *   explain(item)                      { ok, text }: what dropping it here does, or why it can't (said while dragging)
 *   rename(title)                      the tab was renamed
 */
export const EDITORS = {};
export const KINDS = [
  { kind: 'video', label: 'Video', icon: 'film', about: 'A timeline: clips, text, music, voice' },
  { kind: 'stage', label: 'Stage', icon: 'cube', about: 'A 3D shot: cast, camera, dialogue, filmed by Gen' },
  { kind: 'image', label: 'Image', icon: 'image', about: 'A picture in layers: the frame at the playhead' },
  { kind: 'audio', label: 'Audio', icon: 'music', about: 'Tracks of music, voices and sound, mixed down' },
  { kind: 'character', label: 'Character', icon: 'person', about: 'A person or creature to cast: look, voice, 3D model' },
];
export const kindInfo = (k) => KINDS.find((x) => x.kind === k) ?? KINDS[0];
export function registerEditor(ed) { EDITORS[ed.kind] = ed; }

const W = { tabs: [], active: null, editor: null, list: [], switching: null };
const tabsKey = () => `hg.tabs.${state.user?.project ?? 'local'}`;
export const activeScene = () => W.tabs.find((t) => t.id === W.active) ?? null;
export const activeKind = () => activeScene()?.kind ?? 'video';
export const activeEditor = () => W.editor;
export const sceneList = () => W.list;

// ------------------------------------------------------------------ start
export function initScenes() {
  $('#newSceneBtn').addEventListener('click', (e) => newSceneMenu(e.currentTarget));
  // Too many tabs to show: a menu of every open scene, the ones out of view marked; the strip scrolls with the wheel too.
  $('#tabsMore').addEventListener('click', (e) => tabsMenu(e.currentTarget));
  const strip = $('#sceneTabs');
  strip.addEventListener('scroll', () => drawMore());
  strip.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && strip.scrollWidth > strip.clientWidth) { e.preventDefault(); strip.scrollLeft += e.deltaY; } }, { passive: false });
  new ResizeObserver(() => drawMore()).observe(strip);
  $('#scenesSearch').addEventListener('input', drawList);
  $$('#scenesFilter .chip').forEach((c) => c.addEventListener('click', () => { $$('#scenesFilter .chip').forEach((x) => x.classList.toggle('on', x === c)); W.filter = c.dataset.kind; drawList(); }));
  $('#sceneAction').addEventListener('click', () => W.editor?.action?.run());
  $('#undoBtn').addEventListener('click', () => W.editor?.undo?.());
  $('#redoBtn').addEventListener('click', () => W.editor?.redo?.());
  bus.on('history', drawUndo);
  bus.on('save', (s) => { const was = W.unsaved; W.unsaved = ['dirty', 'saving', 'error'].includes(s) ? W.active : null; if (was !== W.unsaved) drawTabs(); });
  bus.on('sceneTitle', ({ id, title }) => { const t = W.tabs.find((x) => x.id === id); if (t && t.title !== title) { t.title = title; keepTabs(); drawTabs(); } const l = W.list.find((x) => x.id === id); if (l) { l.title = title; drawList(); } });
  bus.on('sceneRendered', () => loadList());
  bus.on('jobDone', () => { if (W.list.length) loadList(); });
  // Dropping a scene or a file on the center hands it to the editor in front (plug and play): gen.js registers the
  // center with dragdrop.js, which asks the editor (explain) and says why when it can't.
}

/** Signed in: the tabs left open last time (those that still exist), else the newest video, else a new one. */
export async function startWorkspace() {
  await loadList();
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(tabsKey()) || '{}').tabs ?? []; } catch { /* */ }
  W.tabs = saved.filter((t) => W.list.some((x) => x.id === t.id)).map((t) => ({ ...t, title: W.list.find((x) => x.id === t.id).title }));
  let want = null;
  try { want = JSON.parse(localStorage.getItem(tabsKey()) || '{}').active ?? null; } catch { /* */ }
  if (!W.tabs.length) {
    let last = null;
    try { last = localStorage.getItem('hg.editor.last'); } catch { /* */ }
    const v = W.list.find((x) => x.id === last) ?? W.list.find((x) => x.kind === 'video');
    if (v) W.tabs = [{ id: v.id, kind: v.kind, title: v.title }];
    else { const made = await api('/v1/scenes', { body: { kind: 'video', title: 'Untitled' } }); W.list.unshift(made); W.tabs = [{ id: made.id, kind: 'video', title: made.title }]; }
  }
  await activate(W.tabs.some((t) => t.id === want) ? want : W.tabs[0].id);
}

export async function loadList() {
  if (!state.user) { W.list = []; drawList(); return; }
  try { W.list = (await api(`/v1/scenes?project=${encodeURIComponent(state.user.project)}`)).items ?? []; } catch { /* offline */ }
  drawList();
}

// ------------------------------------------------------------------ tabs
function keepTabs() { try { localStorage.setItem(tabsKey(), JSON.stringify({ tabs: W.tabs.map(({ id, kind, title }) => ({ id, kind, title })), active: W.active })); } catch { /* */ } }

export async function openScene(id) {
  if (!state.user) return needSignIn(() => openScene(id), 'login');
  let t = W.tabs.find((x) => x.id === id);
  if (!t) {
    const s = W.list.find((x) => x.id === id) ?? await api(`/v1/scenes/${id}`);
    t = { id, kind: s.kind, title: s.title };
    const at = W.tabs.findIndex((x) => x.id === W.active);
    W.tabs.splice(at + 1, 0, t);
  }
  await activate(id);
}

export function uniqueTitle(title) {
  const taken = new Set(W.list.map((x) => x.title));
  if (!taken.has(title)) return title;
  let n = 2;
  while (taken.has(`${title} ${n}`)) n++;
  return `${title} ${n}`;
}
export async function newScene(kind, { title, doc, open = true } = {}) {
  if (!state.user) return needSignIn(() => newScene(kind, { title, doc, open }), 'login');
  // A name that's taken gets a number ("Poster 2"), so the tabs and the Scenes list tell them apart.
  if (title) title = uniqueTitle(title);
  if (doc?.title) doc = { ...doc, title: uniqueTitle(doc.title) };
  const s = await api('/v1/scenes', { body: { kind, project: state.user.project, ...(title ? { title } : {}), ...(doc ? { doc } : {}) } });
  W.list.unshift(s);
  drawList();
  if (open) await openScene(s.id);
  return s;
}

/** Brings a tab to the front: the editor in front saves and lets go, the tab's editor takes the panes. */
async function activate(id) {
  if (W.switching) await W.switching;
  W.switching = (async () => {
    const t = W.tabs.find((x) => x.id === id);
    if (!t) return;
    if (W.editor && W.active !== id) { try { await W.editor.unmount(); } catch (err) { console.error(err); } W.editor = null; }
    W.active = id;
    keepTabs();
    drawTabs();
    const ed = EDITORS[t.kind];
    $('#app').dataset.kind = t.kind;
    lendTimeline(ed?.timelineKind ? null : ed?.timeline ?? NO_LANES);
    $('#kindTab').hidden = !ed?.panel;
    $('#kindTab').textContent = ed?.panel ?? '';
    if (!ed) { toast(`No editor for ${t.kind} scenes yet.`); return; }
    if (W.editor === ed) return;
    try {
      const scene = await api(`/v1/scenes/${id}`);
      t.title = scene.title;
      W.editor = ed;
      await ed.mount(scene);
      if (ed.panel && ed.panelFirst) showPane('kind');
      else if (!ed.panel && !$('#pane-kind').hidden) showPane('media');
      if (ed.timeline) lendTimeline(ed.timeline);
    } catch (err) {
      toast(plainError(err.message));
      if (err.status === 404) closeTab(id, { quiet: true });
    }
    drawAction();
    drawUndo();
    drawTabs();
    bus.emit('sceneActive', t);
  })();
  try { await W.switching; } finally { W.switching = null; }
}

/** A kind with nothing timed (a character) still keeps the timeline on screen, saying so. */
const NO_LANES = { length: () => 10, playhead: () => 0, seek() {}, lanes: () => [], move() {}, empty: 'A character has no timeline of their own: drag them onto a stage, where their moves and lines are timed.' };

async function closeTab(id, { quiet = false } = {}) {
  const i = W.tabs.findIndex((x) => x.id === id);
  if (i < 0) return;
  if (W.tabs.length === 1 && !quiet) { toast('One tab stays open.'); return; }
  if (W.active === id && W.editor) { try { await W.editor.unmount(); } catch { /* */ } W.editor = null; W.active = null; }
  W.tabs.splice(i, 1);
  keepTabs();
  drawTabs();
  if (!W.active && W.tabs.length) await activate(W.tabs[Math.min(i, W.tabs.length - 1)].id);
}

function drawTabs() {
  const box = $('#sceneTabs');
  box.replaceChildren(...W.tabs.map((t) => {
    const el = h('div', { class: `scene-tab${t.id === W.active ? ' on' : ''}`, 'data-id': t.id, title: `${kindInfo(t.kind).label}: ${t.title}`, draggable: 'true' },
      icon(kindInfo(t.kind).icon), h('span', { class: 'scene-tab-t' }, t.title, t.id === W.unsaved ? h('span', { class: 'unsaved', title: 'Not saved yet: it saves on its own in a moment, or press Ctrl+S' }, ' *') : ''),
      h('button', { class: 'scene-tab-x', title: 'Close the tab', onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, icon('close')));
    el.addEventListener('click', () => { if (t.id !== W.active) activate(t.id); });
    el.addEventListener('dblclick', () => renameTab(t, el));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t.id); });
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-hg-scene', JSON.stringify(sceneItem(t))); e.dataTransfer.setData('application/x-hg-tab', t.id); setDrag(sceneItem(t)); });
    el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('application/x-hg-tab')) e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      const from = e.dataTransfer.getData('application/x-hg-tab');
      if (!from || from === t.id) return;
      e.preventDefault();
      const a = W.tabs.findIndex((x) => x.id === from);
      const [m] = W.tabs.splice(a, 1);
      W.tabs.splice(W.tabs.findIndex((x) => x.id === t.id), 0, m);
      keepTabs();
      drawTabs();
    });
    return el;
  }));
  box.querySelector('.scene-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  drawMore();
}

/** The tabs scrolled out of view (wholly or partly), by id. */
function hiddenTabs() {
  const strip = $('#sceneTabs');
  const r = strip.getBoundingClientRect();
  return new Set([...strip.querySelectorAll('.scene-tab')].filter((el) => { const b = el.getBoundingClientRect(); return b.left < r.left - 1 || b.right > r.right + 1; }).map((el) => el.dataset.id));
}
/** The dropdown button shows only while some tabs don't fit, with how many are out of view. */
function drawMore() {
  const strip = $('#sceneTabs');
  const btn = $('#tabsMore');
  if (!strip || !btn) return;
  const over = strip.scrollWidth > strip.clientWidth + 1;
  btn.hidden = !over;
  const n = over ? hiddenTabs().size : 0;
  $('#tabsMoreN').textContent = n ? String(n) : '';
  btn.title = n ? `${n} more open scene${n === 1 ? '' : 's'}` : 'Every open scene';
}
function tabsMenu(btn) {
  const r = btn.getBoundingClientRect();
  const hidden = hiddenTabs();
  popMenu(Math.max(8, r.right - 260), r.bottom + 6, [h('div', { class: 'menu-title' }, `Open scenes (${W.tabs.length})`),
    h('div', { class: 'menu-scroll' }, ...W.tabs.map((t) => h('button', { class: `menu-item tabs-item${t.id === W.active ? ' on' : ''}${hidden.has(t.id) ? ' out' : ''}`, onclick: () => { closeMenus(); activate(t.id).then(() => $(`#sceneTabs .scene-tab[data-id="${t.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })); } },
      h('span', { class: 'row' }, icon(kindInfo(t.kind).icon), h('span', { class: 'tabs-item-t' }, t.title)),
      h('span', { class: 'row' }, hidden.has(t.id) ? h('span', { class: 'muted small' }, 'out of view') : '',
        h('span', { class: 'icon-btn small', title: 'Close the tab', role: 'button', onclick: (e) => { e.stopPropagation(); closeMenus(); closeTab(t.id); } }, icon('close'))))))]);
}

function renameTab(t, el) {
  const input = h('input', { class: 'scene-tab-input', value: t.title, maxlength: '120' });
  el.querySelector('.scene-tab-t').replaceWith(input);
  input.focus();
  input.select();
  const done = (keep) => {
    const title = input.value.trim() || t.title;
    if (keep && title !== t.title) { t.title = title; if (t.id === W.active) W.editor?.rename?.(title); else api(`/v1/scenes/${t.id}`).then((s) => api(`/v1/scenes/${t.id}`, { method: 'PUT', body: { doc: { ...s.doc, title, ...(s.kind === 'character' ? { title } : {}) } } })).catch(() => {}); keepTabs(); loadList(); }
    drawTabs();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
  input.addEventListener('blur', () => done(true));
}

async function newSceneMenu(btn) {
  const r = btn.getBoundingClientRect();
  const { starterItems } = await import('./starters.js');
  popMenu(r.left, r.bottom + 6, [h('div', { class: 'menu-title' }, 'Start from an idea'), h('div', { class: 'menu-scroll menu-starters' }, ...starterItems(closeMenus)), h('div', { class: 'menu-sep' }), h('div', { class: 'menu-title' }, 'Blank'),
    ...KINDS.map((k) => h('button', { class: 'menu-item', onclick: () => { closeMenus(); newScene(k.kind).catch((err) => toast(err.message)); } },
      h('span', { class: 'row' }, icon(k.icon), h('span', {}, h('b', {}, k.label), h('div', { class: 'muted small' }, k.about))))),
    h('div', { class: 'menu-sep' }),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); openPicker(); } }, h('span', {}, 'Open a scene…'), h('span', { class: 'muted small' }, 'Ctrl+O'))]);
}

/** Every scene of the account, fresh from Gen, newest first: search, filter by kind, open one (Ctrl+O). */
export async function openPicker() {
  if (!state.user) return needSignIn(openPicker, 'login');
  closeMenus();
  $('#scenePicker')?.remove();
  let kind = '';
  const q = h('input', { type: 'search', placeholder: 'Search your scenes' });
  const list = h('div', { class: 'scenes-list picker-list' }, h('div', { class: 'working' }, 'Loading'));
  const chips = h('div', { class: 'chips' }, ...[['', 'All'], ...KINDS.map((k) => [k.kind, k.label])].map(([k, l]) => h('button', { type: 'button', class: `chip${k === kind ? ' on' : ''}`, onclick: (e) => { kind = k; chips.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); draw(); } }, l)));
  const pop = h('div', { class: 'picker scene-picker', id: 'scenePicker' },
    h('div', { class: 'sheet-head' }, h('b', {}, 'Open a scene'), h('button', { type: 'button', class: 'icon-btn', onclick: () => pop.remove() }, icon('close'))), q, chips, list);
  document.body.append(pop);
  q.focus();
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(); };
  function draw() {
    const words = q.value.trim().toLowerCase();
    const items = W.list.filter((x) => (!kind || x.kind === kind) && (!words || x.title.toLowerCase().includes(words)));
    list.replaceChildren(...(items.length ? items.map((x) => h('button', { type: 'button', class: `scene-row${W.tabs.some((t) => t.id === x.id) ? ' on' : ''}`, onclick: () => { pop.remove(); openScene(x.id); } },
      h('div', { class: 'scene-thumb' }, x.render?.asset && x.render.kind === 'image' ? h('img', { src: fileUrl(x.render.asset), alt: '', loading: 'lazy' }) : h('span', { class: 'scene-ico' }, icon(kindInfo(x.kind).icon, 'ico'))),
      h('div', { class: 'scene-txt' }, h('b', {}, x.title), h('span', { class: 'muted small' }, `${kindInfo(x.kind).label} · ${ago(x.updated)}${W.tabs.some((t) => t.id === x.id) ? ' · open' : ''}`)))) : [h('p', { class: 'muted small' }, words || kind ? 'Nothing matches.' : 'No scenes yet.')]));
  }
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.remove(); if (e.key === 'Enter') list.querySelector('.scene-row')?.click(); });
  await loadList();
  draw();
}

function drawAction() {
  const a = W.editor?.action;
  const b = $('#sceneAction');
  b.hidden = !a;
  if (a) { b.replaceChildren(icon(a.icon ?? 'download'), h('span', { class: 'btn-label' }, a.label)); b.title = a.label; }
}
function drawUndo() {
  $('#undoBtn').disabled = !W.editor?.canUndo?.();
  $('#redoBtn').disabled = !W.editor?.canRedo?.();
}
export const refreshBar = () => { drawAction(); drawUndo(); };

// ------------------------------------------------------------------ the Scenes list (left pane)
/** What a dragged scene carries: enough for any editor to place it (its render is what plays). */
export const sceneItem = (s) => ({ scene: s.id, kind: s.kind, title: s.title, render: (W.list.find((x) => x.id === s.id) ?? s).render ?? null });
/** A drag's scene or file, if it carries one (types only: data can't be read until the drop). */
export function dragItem(e) {
  const t = [...(e.dataTransfer?.types ?? [])];
  if (t.includes('application/x-hg-scene')) return { scene: true };
  if (t.includes('application/x-hg-asset')) return { asset: true };
  return null;
}
export function readDrag(e) {
  try {
    const s = e.dataTransfer.getData('application/x-hg-scene');
    if (s) return JSON.parse(s);
    const a = e.dataTransfer.getData('application/x-hg-asset');
    if (a) { const x = JSON.parse(a); return { asset: x.id, assetKind: x.kind, title: x.title, duration: x.duration }; }
  } catch { /* */ }
  return null;
}

function drawList() {
  const box = $('#scenesList');
  if (!box) return;
  if (!state.user) { box.replaceChildren(h('div', { class: 'empty-note' }, h('p', {}, 'Your scenes live here: videos, 3D stages, images, audio and characters.'), h('button', { class: 'primary small', onclick: () => needSignIn(loadList, 'login') }, 'Sign in'))); return; }
  const q = $('#scenesSearch').value.trim().toLowerCase();
  const items = W.list.filter((s) => (!W.filter || s.kind === W.filter) && (!q || s.title.toLowerCase().includes(q)));
  if (!items.length) { box.replaceChildren(h('div', { class: 'empty-note' }, h('p', {}, q || W.filter ? 'Nothing matches.' : 'No scenes yet.'), h('button', { class: 'ghost small', onclick: (e) => newSceneMenu(e.currentTarget) }, icon('plus'), 'New scene'))); return; }
  box.replaceChildren(...items.map((s) => {
    const open = W.tabs.some((t) => t.id === s.id);
    const thumb = s.render?.asset && s.render.kind === 'image' ? h('img', { src: fileUrl(s.render.asset), alt: '', loading: 'lazy' })
      : s.render?.asset && s.render.kind === 'video' ? h('video', { src: `${fileUrl(s.render.asset)}#t=0.1`, muted: true, preload: 'metadata' })
        : h('span', { class: 'scene-ico' }, icon(kindInfo(s.kind).icon, 'ico'));
    const el = h('div', { class: `scene-row${s.id === W.active ? ' on' : ''}`, draggable: 'true', tabindex: '0', title: 'Open it, or drag it into another scene' },
      h('div', { class: 'scene-thumb' }, thumb),
      h('div', { class: 'scene-txt' }, h('b', {}, s.title), h('span', { class: 'muted small' }, `${kindInfo(s.kind).label}${s.render ? ' · rendered' : ''}${open ? ' · open' : ''}`)),
      h('button', { class: 'icon-btn small', title: 'More', onclick: (e) => { e.stopPropagation(); sceneMenu(s, e.currentTarget); } }, icon('more')));
    el.addEventListener('click', () => openScene(s.id));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openScene(s.id); });
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-hg-scene', JSON.stringify(sceneItem(s))); e.dataTransfer.effectAllowed = 'copy'; });
    touchDrag(el, () => sceneItem(s));
    return el;
  }));
}

function sceneMenu(s, btn) {
  const r = btn.getBoundingClientRect();
  const here = activeScene();
  const canUse = here && here.id !== s.id && W.editor?.accepts?.(sceneItem(s));
  popMenu(r.left - 160, r.bottom + 6, [
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); openScene(s.id); } }, 'Open'),
    canUse ? h('button', { class: 'menu-item', onclick: () => { closeMenus(); W.editor.drop(sceneItem(s)); } }, `Use in "${here.title}"`) : '',
    ...(EDITORS[s.kind]?.uses?.(s) ?? []).map((u) => h('button', { class: 'menu-item', onclick: () => { closeMenus(); u.run(); } }, u.label)),
    h('button', { class: 'menu-item', onclick: async () => { closeMenus(); const c = await api(`/v1/scenes/${s.id}/duplicate`, { method: 'POST' }); W.list.unshift(c); drawList(); toast(`Made "${c.title}".`); } }, 'Duplicate'),
    h('div', { class: 'menu-sep' }),
    h('button', { class: 'menu-item danger', onclick: async () => {
      closeMenus();
      if (!confirm(`Delete "${s.title}"? Files it made stay in Media.`)) return;
      if (W.tabs.some((t) => t.id === s.id)) await closeTab(s.id, { quiet: true });
      await api(`/v1/scenes/${s.id}`, { method: 'DELETE' });
      W.list = W.list.filter((x) => x.id !== s.id);
      drawList();
    } }, 'Delete'),
  ]);
}

/** Records a scene's latest output, so the scenes that use it can play it. */
export async function setRender(id, asset, kind) {
  const s = await api(`/v1/scenes/${id}/render`, { method: 'PUT', body: { asset, kind } });
  const l = W.list.find((x) => x.id === id);
  if (l) l.render = s.doc.render; else W.list.unshift({ id, kind: s.kind, title: s.title, render: s.doc.render });
  drawList();
  bus.emit('sceneRendered', { id, render: s.doc.render });
  return s;
}

/** A scene's render, fetched fresh (for placing it, or for "update"). */
export async function renderOf(id) { return (await api(`/v1/scenes/${id}`)).doc.render ?? null; }

/** The open tabs (the 🐞 report's context, report.js). */
export const openTabs = () => W.tabs.map(({ id, kind, title }) => ({ id, kind, title }));
