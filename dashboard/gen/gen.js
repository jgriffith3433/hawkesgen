// Hawkes Gen, the app (hawkesgen.ai /): one page for everything Gen makes. Scenes of every kind open as tabs in the bar
// (scenes.js: video, stage, image, audio, character, each with its own editor that plugs into the others). Media (the library) and Create (every tool:
// images, video, 3D and rigging, animation, voice and music, chains) on the left (media.js, studio.js), the viewer and the tools for what's selected in the middle (player.js, tools.js), the AI editor on the
// right (ai.js), the timeline below (timeline.js), one project document saved to Gen (project.js, src/editor.ts).
// Gen's own accounts (account.js: Google sign-in, credits, Stripe, the account's own AI). The admin dashboard is /admin.

import { $, $$, h, api, toast, bus, ICON, fmt } from './lib.js';
import { P, doUndo, doRedo, canUndo, canRedo, splitAt, deleteSelected, duplicateSelected, startSignedIn, startSignedOut, startSync, openProject, createProject, remember, changed, save } from './project.js';
import { initPlayer, toggle, seek, closeSource, currentSource } from './player.js';
import { initTimeline, transitionMenu, popMenu, closeMenus, addText, fit } from './timeline.js';
import { initMedia, uploadFiles, showPane } from './media.js';
import { initTools, closeSheet } from './tools.js';
import { initAi } from './ai.js';
import { initStudio } from './studio.js';
import { initDirector } from './director.js';
import { initScenes, startWorkspace, activeKind, activeEditor } from './scenes.js';
import './video.js';
import './image.js';
import './audio.js';
import './character.js';
import { initAccount, loadMe, state } from './account.js';

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
initAi();

// ------------------------------------------------------------------ the bar
const saveWords = { saved: 'Saved', saving: 'Saving…', dirty: 'Saving…', local: 'Not saved: sign in to keep it', error: 'Couldn\'t save, retrying' };
bus.on('save', (s) => { $('#saveState').textContent = saveWords[s] ?? ''; $('#saveState').dataset.s = s; });
bus.on('undo', () => activeEditor()?.undo?.());
bus.on('doc', () => {
  $('#aspectSel').value = `${P.doc.width}x${P.doc.height}`;
  if (activeKind() === 'video' && P.id) bus.emit('sceneTitle', { id: P.id, title: P.doc.title });
});
$('#aspectSel').addEventListener('change', (e) => { const [w, hh] = e.target.value.split('x').map(Number); remember(); P.doc.width = w; P.doc.height = hh; changed(); });

// ------------------------------------------------------------------ timeline bar
$('#splitBtn').addEventListener('click', () => splitAt());
$('#deleteBtn').addEventListener('click', () => deleteSelected());
$('#textBtn').addEventListener('click', addText);
bus.on('transitionMenu', transitionMenu);
bus.on('clipMenu', ({ clip, x, y }) => popMenu(x, y, [
  h('button', { class: 'menu-item', onclick: () => { closeMenus(); splitAt(); } }, 'Split at playhead'),
  h('button', { class: 'menu-item', onclick: () => { closeMenus(); duplicateSelected(); } }, 'Duplicate'),
  h('button', { class: 'menu-item', onclick: () => { closeMenus(); bus.emit('openClip', clip); } }, 'Open in viewer'),
  h('button', { class: 'menu-item danger', onclick: () => { closeMenus(); deleteSelected(); } }, 'Delete'),
]));

// ------------------------------------------------------------------ keys
addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  const mod = e.ctrlKey || e.metaKey;
  const ed = activeEditor();
  if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); e.shiftKey ? ed?.redo?.() : ed?.undo?.(); return; }
  if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); ed?.redo?.(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (activeKind() === 'video') save(); else ed?.save?.(); return; }
  if (typing || activeKind() !== 'video') return;
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); P.doc.clips.forEach((c) => P.selection.clips.add(c.id)); bus.emit('selection'); return; }
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
  if (e.target.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey || activeKind() !== 'video') return;
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
  const onTimeline = activeKind() === 'video' && Boolean(e.target.closest?.('#timelinePane'));
  uploadFiles([...e.dataTransfer.files], { toTimeline: onTimeline });
});

// ------------------------------------------------------------------ resizing the panes (desktop)
function resizer(el, prop, { min, max, invert = false, axis = 'x' }) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const app = $('#app');
    const v0 = parseFloat(getComputedStyle(app).getPropertyValue(prop)) || 0;
    const move = (ev) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      const v = Math.min(max, Math.max(min, v0 + (invert ? -d : d)));
      app.style.setProperty(prop, `${v}px`);
      try { localStorage.setItem(`hg.${prop}`, String(v)); } catch { /* */ }
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}
for (const [prop, sel, opt] of [['--left', '#leftPane', { min: 220, max: 520 }], ['--right', '#rightPane', { min: 280, max: 560, invert: true }], ['--tl', '#timelinePane', { min: 150, max: 560, invert: true, axis: 'y' }]]) {
  const grip = h('div', { class: `grip grip-${prop.slice(2)}` });
  $(sel).append(grip);
  resizer(grip, prop, opt);
  try { const v = localStorage.getItem(`hg.${prop}`); if (v) $('#app').style.setProperty(prop, `${v}px`); } catch { /* */ }
}

// ------------------------------------------------------------------ phone tabs
$$('#mobileTabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#mobileTabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#app').dataset.m = b.dataset.m;
  if (b.dataset.m === 'media') showPane('media');
  if (b.dataset.m === 'generate') showPane(activeEditor()?.panel ? 'kind' : 'generate');
}));
$('#app').dataset.m = 'edit';

// ------------------------------------------------------------------ start
await loadMe();
$('#app').dataset.kind = 'video';
if (state.user) { try { await startWorkspace(); } catch (err) { toast(err.message); startSignedOut(); } } else startSignedOut();
bus.emit('ready', state.user);
bus.on('signedIn', () => startWorkspace().catch((err) => toast(err.message)));
startSync();
setTimeout(fit, 50);
