// Hawkes Gen, the app (hawkesgen.ai /): one page for everything Gen makes. Scenes of every kind open as tabs in the bar
// (scenes.js: video, image and audio are timelines (editor.js), stage the 3D director, character a sheet; each plugs into
// the others). Media, Create, Scenes and the Inspector on the left (media.js, studio.js, scenes.js, editor.js), the
// center showing what's at the playhead (player.js) with the tools for what's selected (tools.js), the AI on the right
// (ai.js), and the timeline below, always (timeline.js). The areas size like a desktop editor's: drag an edge, drag it
// small to fold it away, double-click it to bring it back (sizes kept per browser). On a phone the center and the
// timeline stay on screen with a sheet below for Media, Create, the Inspector or the AI, and tiles drag onto the
// timeline with a finger (dragdrop.js). Gen's own accounts (account.js). The admin dashboard is /admin.

import { $, $$, h, toast, bus, ICON, icon } from './lib.js';
import { P, doUndo, doRedo, splitAt, deleteSelected, duplicateSelected, startSignedOut, startSync, remember, changed, save, takeLocal, copySelected, cutSelected, paste, stopClip } from './project.js';
import { initPlayer, toggle, seek, closeSource, currentSource } from './player.js';
import { initTimeline, popMenu, closeMenus, addText, fit, hoverAt, dropAt, checkAt } from './timeline.js';
import { initMedia, uploadFiles, showPane, busyCount } from './media.js';
import { initTools, closeSheet, clipTools } from './tools.js';
import { initAi } from './ai.js';
import { initStudio } from './studio.js';
import { initDirector } from './director.js';
import { initScenes, startWorkspace, activeKind, activeEditor, newScene } from './scenes.js';
import { initEditor } from './editor.js';
import { initLanding, show as showLanding } from './landing.js';
import { initTour, startTour } from './tour.js';
import { initGuide, startGuide } from './guide.js';
import { openPalette } from './palette.js';
import './character.js';
import './world.js';
import './place.js';
import './prop.js';
import './story.js';
import { dropTarget } from './dragdrop.js';
import { initAccount, loadMe, state } from './account.js';
import './report.js';
import './playtest.js';

// Icons in the markup: <span class="ico-wrap" data-icon="name">.
for (const el of $$('.ico-wrap[data-icon]')) el.innerHTML = ICON[el.dataset.icon] ?? '';

initAccount();
initPlayer();
initTimeline();
initMedia();
initTools();
initStudio();
initScenes();
initDirector();
initEditor();
initAi();
initLanding();
initTour();
initGuide();

const onTimelineScene = () => ['video', 'image', 'audio'].includes(activeKind());

// ------------------------------------------------------------------ the bar
const saveWords = { saved: 'Saved', saving: 'Saving…', dirty: 'Saving…', local: 'Not saved: sign in to keep it', error: 'Couldn\'t save, retrying' };
bus.on('save', (s) => { $('#saveState').textContent = saveWords[s] ?? ''; $('#saveState').dataset.s = s; });
addEventListener('beforeunload', (e) => { if (['dirty', 'saving', 'error'].includes($('#saveState').dataset.s)) { activeEditor()?.save?.(); e.preventDefault(); } });
bus.on('undo', () => activeEditor()?.undo?.());
bus.on('doc', () => {
  $('#aspectSel').value = `${P.doc.width}x${P.doc.height}`;
  if (onTimelineScene() && P.id) bus.emit('sceneTitle', { id: P.id, title: P.doc.title });
});
$('#aspectSel').addEventListener('change', (e) => { const [w, hh] = e.target.value.split('x').map(Number); remember(); P.doc.width = w; P.doc.height = hh; changed(); });

// Clicking a clip brings its Inspector forward (on a desktop, unless a Create form is open there).
bus.on('inspect', () => {
  if (getComputedStyle($('#mobileTabs')).display !== 'none' || !$('#pane-kind') || $('#kindTab').hidden) return;
  if (!$('#pane-generate').hidden && !$('#createTool').hidden) return;
  showPane('kind');
});

// ------------------------------------------------------------------ help
const SHORTCUTS = [
  ['Space', 'Play or pause'], ['S', 'Split at the playhead'], ['Delete', 'Delete what\'s selected'], ['Ctrl+C / X / V', 'Copy, cut, paste clips'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo, redo'], ['Ctrl+D', 'Duplicate'], ['Ctrl+S', 'Save now'], ['Ctrl+O', 'Open a scene'], ['T', 'Words at the playhead'],
  ['I / O', 'Mark a stretch for the AI'], ['← →', 'Step a frame (Shift: a second)'], ['Ctrl+wheel, + / −', 'Zoom the timeline'], ['W / E / R', 'Move, turn, size (3D stage)'], ['Esc', 'Let go of the selection'], ['Click empty track', 'Clear the selection'], ['Snap button', 'Clips catch the playhead and each other'], ['?', 'Show or hide this list'],
];
function shortcuts() {
  $('#shortcutsPop')?.remove();
  const pop = h('div', { class: 'picker shortcuts', id: 'shortcutsPop', role: 'dialog' },
    h('div', { class: 'sheet-head' }, h('b', {}, 'Keyboard shortcuts'), h('button', { class: 'icon-btn', onclick: () => pop.remove() }, icon('close'))),
    h('dl', {}, ...SHORTCUTS.flatMap(([k, v]) => [h('dt', {}, ...k.split(' / ').flatMap((x, i) => [i ? ' / ' : '', h('kbd', {}, x)])), h('dd', {}, v)])));
  document.body.append(pop);
  const off = (e) => { if (e.key === 'Escape' || (e.type === 'pointerdown' && !pop.contains(e.target))) { pop.remove(); removeEventListener('keydown', off, true); removeEventListener('pointerdown', off, true); } };
  setTimeout(() => { addEventListener('keydown', off, true); addEventListener('pointerdown', off, true); }, 0);
}
$('#helpBtn').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  popMenu(r.right - 240, r.bottom + 6, [
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); startTour(); } }, h('span', { class: 'row' }, icon('sparkle'), 'Take the quick tour')),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); startGuide({ force: true }); } }, h('span', { class: 'row' }, icon('film'), 'Guided first project')),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); shortcuts(); } }, h('span', { class: 'row' }, icon('keyboard'), 'Keyboard shortcuts')),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); showLanding({ browsing: true }); } }, h('span', { class: 'row' }, icon('help'), 'What Hawkes Gen does')),
    h('div', { class: 'menu-sep' }),
    h('div', { class: 'menu-links' }, h('a', { href: '/legal#terms', target: '_blank' }, 'Terms'), h('a', { href: '/legal#privacy', target: '_blank' }, 'Privacy'), h('a', { href: 'mailto:support@hawkesgen.ai' }, 'Contact')),
  ]);
});
addEventListener('keydown', (e) => {
  if (e.key !== '?' || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  if ($('#shortcutsPop')) $('#shortcutsPop').remove(); else shortcuts();
});

// ------------------------------------------------------------------ search everything, and what's being made
$('#paletteBtn').addEventListener('click', () => openPalette());
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); } }, true);
/** The bar's "Making 2" pill: anything being made or uploaded (Media's list) and clips still waiting on a job. */
function drawBusy() {
  const n = busyCount();
  $('#busyPill').hidden = !n;
  $('#busyText').textContent = `Making ${n}`;
}
bus.on('busy', drawBusy);
bus.on('doc', drawBusy);
$('#busyPill').addEventListener('click', () => { showPane('media'); if (getComputedStyle($('#mobileTabs')).display !== 'none') $('#mobileTabs button[data-m="media"]').click(); });

// ------------------------------------------------------------------ an empty scene's first steps
// Ideas for the scene in front: one tap asks its AI to make it here.
bus.on('sceneActive', () => import('./starters.js').then((s) => { const box = $('#emptyIdeas'); const list = s.ideasHere(); box.replaceChildren(...(list.length ? [h('span', { class: 'muted small' }, 'Or start from an idea:'), ...list] : [])); }));
$('#emptyUpload').addEventListener('click', () => $('#uploadInput').click());
$('#emptyMedia').addEventListener('click', () => { showPane('media'); if (getComputedStyle($('#mobileTabs')).display !== 'none') $('#mobileTabs button[data-m="media"]').click(); });
$('#emptyAsk').addEventListener('click', () => import('./ai.js').then((a) => a.askAi('')));

// ------------------------------------------------------------------ timeline bar
$('#splitBtn').addEventListener('click', () => splitAt());
$('#deleteBtn').addEventListener('click', () => deleteSelected());
$('#textBtn').addEventListener('click', addText);
bus.on('clipMenu', ({ clip, x, y }) => popMenu(x, y, [
  ...clipToolsItems(clip),
  clip.pending ? h('button', { class: 'menu-item', onclick: () => { closeMenus(); stopClip(clip.id); } }, 'Stop making it') : '',
  h('button', { class: 'menu-item', onclick: () => { closeMenus(); splitAt(); } }, 'Split at playhead'),
  h('button', { class: 'menu-item', onclick: () => { closeMenus(); duplicateSelected(); } }, 'Duplicate'),
  h('button', { class: 'menu-item', onclick: () => { closeMenus(); copySelected(); toast('Copied.', { ms: 1200 }); } }, h('span', {}, 'Copy'), h('span', { class: 'muted small' }, 'Ctrl+C')),
  h('button', { class: 'menu-item', onclick: () => { closeMenus(); cutSelected(); } }, h('span', {}, 'Cut'), h('span', { class: 'muted small' }, 'Ctrl+X')),
  h('button', { class: 'menu-item', onclick: () => { closeMenus(); paste(); } }, h('span', {}, 'Paste at the playhead'), h('span', { class: 'muted small' }, 'Ctrl+V')),
  clip.asset ? h('button', { class: 'menu-item', onclick: () => { closeMenus(); bus.emit('openClip', clip); } }, 'Open in the viewer') : '',
  clip.scene ? h('button', { class: 'menu-item', onclick: () => { closeMenus(); import('./scenes.js').then((s) => s.openScene(clip.scene)); } }, 'Open the scene it plays') : '',
  h('button', { class: 'menu-item', onclick: () => { closeMenus(); showPane('kind'); } }, 'Inspector'),
  h('button', { class: 'menu-item danger', onclick: () => { closeMenus(); deleteSelected(); } }, 'Delete'),
]));

/** A clip's tools at the top of its menu (Remove background, Edit, Animate...). */
function clipToolsItems(clip) {
  const list = clipTools(clip);
  if (!list.length) return [];
  return [h('div', { class: 'menu-title' }, clip.kind === 'image' ? 'Picture tools' : 'Tools'),
    ...list.map((t) => h('button', { class: 'menu-item', onclick: () => { closeMenus(); t.run(); } }, h('span', { class: 'row' }, icon(t.icon), t.label))), h('div', { class: 'menu-sep' })];
}

// ------------------------------------------------------------------ keys
addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  const mod = e.ctrlKey || e.metaKey;
  const ed = activeEditor();
  if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); e.shiftKey ? ed?.redo?.() : ed?.undo?.(); return; }
  if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); ed?.redo?.(); return; }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    Promise.resolve(ed?.save?.()).then(() => toast($('#saveState').dataset.s === 'error' ? 'Couldn\'t save: it will try again.' : 'Saved.', { ms: 1500 })).catch(() => {});
    return;
  }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); import('./scenes.js').then((x) => x.openPicker()); return; }
  if (typing || !onTimelineScene()) return;
  if (mod && e.key.toLowerCase() === 'c') { const n = copySelected(); if (n) { e.preventDefault(); toast(`Copied ${n} clip${n === 1 ? '' : 's'}.`, { ms: 1400 }); } return; }
  if (mod && e.key.toLowerCase() === 'x') { const n = cutSelected(); if (n) { e.preventDefault(); toast(`Cut ${n} clip${n === 1 ? '' : 's'}.`, { ms: 1400 }); } return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); if (!paste()) toast('Nothing copied yet: select clips and press Ctrl+C.', { ms: 2000 }); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); P.doc.clips.forEach((c) => P.selection.clips.add(c.id)); bus.emit('selection'); return; }
  const sel = P.selection.clips.size === 1 ? P.doc.clips.find((c) => P.selection.clips.has(c.id)) : null;
  // Arrow keys nudge a selected picture or text on the frame (Shift: further); otherwise they move the playhead
  // (In an image scene always; elsewhere with Alt.)
  const nudge = sel && sel.kind !== 'audio' && (P.kind === 'image' || e.altKey) ? { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] : null;
  if (nudge) {
    e.preventDefault();
    const k = (e.shiftKey ? 10 : 1) / 1000;
    remember();
    sel.x = Math.round(((sel.x ?? 0.5) + nudge[0] * k) * 10000) / 10000;
    sel.y = Math.round(((sel.y ?? 0.5) + nudge[1] * k) * 10000) / 10000;
    changed();
    return;
  }
  switch (e.key) {
    case ' ': e.preventDefault(); toggle(); break;
    case 's': case 'S': if (!mod) { splitAt(); } break;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break;
    case 'ArrowLeft': e.preventDefault(); seek(P.playhead - (e.shiftKey ? 1 : 1 / P.doc.fps)); break;
    case 'ArrowRight': e.preventDefault(); seek(P.playhead + (e.shiftKey ? 1 : 1 / P.doc.fps)); break;
    case 'Home': seek(0); break;
    case 'End': seek(1e9); break;
    case 't': case 'T': addText(); break;
    case 'i': case 'I': P.selection.range = { start: P.playhead, end: Math.max(P.playhead + 0.1, P.selection.range?.end ?? P.playhead + 2) }; bus.emit('selection'); break;
    case 'o': case 'O': P.selection.range = { start: Math.min(P.selection.range?.start ?? 0, P.playhead - 0.1), end: P.playhead }; bus.emit('selection'); break;
    case 'Escape': closeMenus(); closeSheet(); if (currentSource()) closeSource(); else { P.selection.clips.clear(); P.selection.range = null; bus.emit('selection'); } break;
    default: break;
  }
});
// +/- zoom (zoomTo needs the current zoom; the buttons know it).
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey) return;
  if (e.key === '+' || e.key === '=') $('#zoomIn').click();
  if (e.key === '-' || e.key === '_') $('#zoomOut').click();
}, true);

// ------------------------------------------------------------------ files dropped anywhere
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('#dropzone').hidden = false; });
addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').hidden = true; });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  // Files dropped on the timeline or the center go straight into the scene in front (where it says it takes them);
  // anywhere else they go to Media, with "Add to the timeline" on the toast.
  const onCenter = Boolean(e.target.closest?.('#viewerWrap'));
  const onTimeline = onTimelineScene() && (Boolean(e.target.closest?.('#timelinePane')) || onCenter);
  const ed = activeEditor();
  const into = onCenter && !onTimelineScene() && ed?.drop ? (asset) => ed.drop({ asset: asset.id, assetKind: asset.kind, title: asset.title }, { clientX: e.clientX, clientY: e.clientY }) : null;
  uploadFiles([...e.dataTransfer.files], { toTimeline: onTimeline, then: into });
});

// Drop targets (dragdrop.js, mouse and finger alike): the timeline (onto a track at a time) and the center (the scene in
// front takes it). Each says what a drop would do, or why it can't.
dropTarget({
  check: (x, y, it) => checkAt(it, x, y),
  show: (x, y, it, ok) => hoverAt(x, y, ok),
  leave: () => hoverAt(null),
  drop: (x, y, it) => dropAt(it, x, y),
});
dropTarget({
  check(x, y, it) {
    const r = $('#viewerWrap').getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const ed = activeEditor();
    if (!ed) return { ok: false, text: 'Open a scene first (+ in the bar).' };
    return ed.explain?.(it) ?? (ed.accepts?.(it) ? { ok: true, text: 'Drop to add it' } : { ok: false, text: `This ${ed.label?.toLowerCase() ?? 'scene'} can't take that.` });
  },
  show: (x, y, it, ok) => { $('#viewerWrap').classList.toggle('drop-on', ok); $('#viewerWrap').classList.toggle('drop-no', !ok); },
  leave: () => $('#viewerWrap').classList.remove('drop-on', 'drop-no'),
  drop: (x, y, it) => activeEditor()?.drop?.(it, { clientX: x, clientY: y }),
});

// ------------------------------------------------------------------ sizing the areas
/**
 * The left pane, the AI pane and the timeline size by their edges. Drag an edge; drag it past half its smallest size
 * and the area folds away (its edge stays, to drag it back); double-click an edge to fold or bring it back. Sizes are
 * kept in this browser.
 */
const AREAS = [
  { prop: '--left', sel: '#leftPane', min: 220, max: 560, fold: 'no-left' },
  { prop: '--right', sel: '#rightPane', min: 260, max: 600, invert: true, fold: 'no-right' },
  { prop: '--tl', sel: '#timelinePane', min: 120, max: 720, invert: true, axis: 'y', fold: 'tl-small', foldTo: 40 },
  // Phones: the sheet and the timeline drag almost the whole screen (J, 2026-11-01); the CSS keeps a strip of the
  // picture and the timeline's bar, so the max here is only a ceiling.
  { prop: '--sheet', sel: '#sheetGrip', min: 90, max: 2000, invert: true, axis: 'y', phone: true },
  { prop: '--tlm', sel: '#timelinePane', min: 40, max: 2000, invert: true, axis: 'y', phone: true, grip: 'grip-tlm' },
];
/** What a phone area really shows (the CSS caps it), so a drag starts from what's on screen, not a stored number. */
const shownSize = (a) => {
  if (a.prop === '--tlm') return $('#timelinePane').getBoundingClientRect().height;
  return Math.max(...['#leftPane', '#rightPane'].map((s) => $(s).getBoundingClientRect().height));
};
const keep = (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } };
const kept = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
for (const a of AREAS) {
  const grip = a.sel === '#sheetGrip' ? $('#sheetGrip') : h('div', { class: `grip ${a.grip ?? `grip-${a.prop.slice(2)}`}`, title: 'Drag to size · double-click to fold or unfold' });
  if (a.sel !== '#sheetGrip') $(a.sel).append(grip);
  const app = $('#app');
  const v = Number(kept(`hg.${a.prop}`));
  if (v) app.style.setProperty(a.prop, `${v}px`);
  if (a.fold && kept(`hg.${a.fold}`) === '1') app.classList.add(a.fold);
  const fold = (on) => {
    app.classList.toggle(a.fold, on);
    keep(`hg.${a.fold}`, on ? '1' : '0');
    if (a.fold === 'tl-small') app.style.setProperty('--tl-now', on ? `${a.foldTo}px` : 'var(--tl)');
    setTimeout(fit, 60);
  };
  if (a.fold === 'tl-small' && app.classList.contains('tl-small')) app.style.setProperty('--tl-now', `${a.foldTo}px`);
  grip.addEventListener('dblclick', () => { if (a.fold) fold(!app.classList.contains(a.fold)); });
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture?.(e.pointerId);
    const start = a.axis === 'y' ? e.clientY : e.clientX;
    const folded = a.fold && app.classList.contains(a.fold);
    const v0 = folded ? (a.foldTo ?? 0) : a.phone ? shownSize(a) : parseFloat(getComputedStyle(app).getPropertyValue(a.prop)) || a.min;
    app.classList.add('sizing');
    app.style.setProperty('--sizing-cursor', a.axis === 'y' ? 'row-resize' : 'col-resize');
    const move = (ev) => {
      const d = (a.axis === 'y' ? ev.clientY : ev.clientX) - start;
      const raw = v0 + (a.invert ? -d : d);
      if (a.fold && raw < a.min * 0.55) { if (!app.classList.contains(a.fold)) fold(true); return; }
      if (a.fold && app.classList.contains(a.fold)) fold(false);
      const val = Math.min(a.max, Math.max(a.min, raw));
      app.style.setProperty(a.prop, `${val}px`);
      keep(`hg.${a.prop}`, String(val));
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); app.classList.remove('sizing');
      // Keep what the screen shows, so the next drag has no dead zone past the cap.
      if (a.phone) { const shown = Math.round(shownSize(a)); if (shown > 0) { app.style.setProperty(a.prop, `${shown}px`); keep(`hg.${a.prop}`, String(shown)); } }
      fit();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

// Phones: the page never zooms. That guard is the first script in index.html (it runs before the app loads) and the
// touch-action rules at the end of gen.css.

// ------------------------------------------------------------------ phone: the sheet under the timeline
$$('#mobileTabs button').forEach((b) => b.addEventListener('click', () => {
  const m = b.dataset.m;
  const again = $('#app').dataset.m === m && m !== 'edit';
  $$('#mobileTabs button').forEach((x) => x.classList.toggle('on', again ? x.dataset.m === 'edit' : x === b));
  $('#app').dataset.m = again ? 'edit' : m;
  if (!again && ['media', 'generate', 'scenes', 'kind'].includes(m)) showPane(m);
  // The conversation opens at its newest message (it can't scroll while hidden).
  if (!again && m === 'ai') requestAnimationFrame(() => { const l = $('#aiMessages'); l.scrollTop = l.scrollHeight; });
  setTimeout(fit, 60);
}));
$('#app').dataset.m = 'edit';
bus.on('sceneActive', () => { const k = $('#mobileTabs button[data-m="kind"]'); if (k) k.lastChild.textContent = activeEditor()?.panel === 'Inspector' ? 'Inspect' : activeEditor()?.panel ?? 'Inspect'; });
// A finger dragging a tile: the sheet steps aside a little so the timeline is easy to reach.
bus.on('touchDrag', (on) => $('#app').classList.toggle('touch-dragging', on));

// ------------------------------------------------------------------ start
await loadMe();
$('#app').dataset.kind = 'video';
async function start() {
  await startWorkspace();
  // What was built signed out comes along as a new video scene.
  const local = takeLocal();
  if (local) { await newScene('video', { title: local.title ?? 'Untitled', doc: local }); toast('Your timeline from before signing in is a scene now.'); }
}
if (state.user) { try { await start(); } catch (err) { toast(err.message); startSignedOut(); } } else startSignedOut();
bus.emit('ready', state.user);
document.getElementById('bootCover')?.remove();
bus.on('signedIn', () => start().catch((err) => toast(err.message)));
startSync();
setTimeout(fit, 50);
