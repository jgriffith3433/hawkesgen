// The command palette (Ctrl+K, or the search button in the bar): one box to reach everything. Type a few letters and
// pick: open a scene, start a new one (or from an idea), run an action on what's in front (export, add words, split,
// undo...), open any of Gen's tools, jump to a pane. Whatever doesn't match is one Enter away from asking the AI.

import { $, h, icon } from './lib.js';

let el = null, items = [], shown = [], at = 0;

/** Everything the palette can do right now (built fresh each time it opens). */
async function commands() {
  const [{ sceneList, openScene, newScene, KINDS, activeEditor, openPicker }, { STARTERS, startFrom }, studio, media, tour] = await Promise.all([
    import('./scenes.js'), import('./starters.js'), import('./studio.js'), import('./media.js'), import('./tour.js')]);
  const project = await import('./project.js');
  const timeline = await import('./timeline.js');
  const ed = activeEditor();
  const onTimeline = Boolean(ed?.timelineKind);
  const pane = (name, m) => () => { media.showPane(name); const tabs = $('#mobileTabs'); if (tabs && getComputedStyle(tabs).display !== 'none') $(`#mobileTabs button[data-m="${m ?? name}"]`)?.click(); };
  const out = [];
  if (ed?.action) out.push({ group: 'This scene', icon: ed.action.icon ?? 'download', label: ed.action.label, run: () => ed.action.run() });
  if (onTimeline) {
    out.push(
      { group: 'This scene', icon: 'text', label: 'Add words at the playhead', keys: 'T', run: () => timeline.addText() },
      { group: 'This scene', icon: 'split', label: 'Split at the playhead', keys: 'S', run: () => project.splitAt() },
      { group: 'This scene', icon: 'layers', label: 'Add a track', run: () => project.addTrack({ name: 'Layer', role: 'any' }) },
      { group: 'This scene', icon: 'zoomIn', label: 'Fit the timeline', run: () => timeline.fit() },
    );
  }
  out.push(
    { group: 'This scene', icon: 'undo', label: 'Undo', keys: 'Ctrl+Z', run: () => ed?.undo?.() },
    { group: 'This scene', icon: 'redo', label: 'Redo', keys: 'Ctrl+Shift+Z', run: () => ed?.redo?.() },
    { group: 'This scene', icon: 'download', label: 'Save now', keys: 'Ctrl+S', run: () => ed?.save?.() },
    { group: 'Go to', icon: 'image', label: 'Media', run: pane('media') },
    { group: 'Go to', icon: 'plus', label: 'Create', run: pane('generate') },
    { group: 'Go to', icon: 'layers', label: 'Scenes', run: pane('scenes') },
    { group: 'Go to', icon: 'sliders', label: ed?.panel ?? 'Inspector', run: pane('kind') },
    { group: 'Go to', icon: 'upload', label: 'Upload files', run: () => $('#uploadInput').click() },
    { group: 'Go to', icon: 'layers', label: 'Open a scene…', keys: 'Ctrl+O', run: () => openPicker() },
    { group: 'Help', icon: 'sparkle', label: 'Take the quick tour', run: () => tour.startTour() },
  );
  for (const k of KINDS) out.push({ group: 'New', icon: k.icon, label: `New ${k.label.toLowerCase()} scene`, hint: k.about, run: () => newScene(k.kind) });
  for (const s of STARTERS) out.push({ group: 'Start from an idea', icon: s.icon, label: s.title, hint: s.about, run: () => startFrom(s) });
  for (const s of sceneList()) out.push({ group: 'Your scenes', icon: KINDS.find((k) => k.kind === s.kind)?.icon ?? 'layers', label: s.title, hint: KINDS.find((k) => k.kind === s.kind)?.label, run: () => openScene(s.id) });
  for (const t of studio.createTools()) out.push({ group: 'Tools', icon: 'sparkle', label: t.label, hint: t.about, run: () => { pane('generate')(); studio.openTool(t.id); } });
  return out;
}

/** How well the words match: every letter in order (a subsequence), better when they start words or sit together. */
function score(text, q) {
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q) + (t.startsWith(q) ? 50 : 0);
  let i = 0, s = 0, run = 0;
  for (const ch of t) {
    if (ch === q[i]) { i++; run++; s += run; if (i === q.length) return s; } else run = 0;
  }
  return 0;
}

export async function openPalette() {
  closePalette();
  items = await commands();
  const input = h('input', { type: 'search', placeholder: 'Search scenes, actions and tools, or ask the AI…', 'aria-label': 'Search everything' });
  const list = h('div', { class: 'pal-list', role: 'listbox' });
  el = h('div', { class: 'pal-wrap', onclick: (e) => { if (e.target === el) closePalette(); } }, h('div', { class: 'pal', role: 'dialog', 'aria-label': 'Search everything' }, h('div', { class: 'pal-top' }, icon('search'), input, h('kbd', {}, 'Esc')), list));
  document.body.append(el);
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.map((c) => ({ c, s: Math.max(score(c.label, q), score(`${c.group} ${c.hint ?? ''}`, q) * 0.4) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.c);
    if (!q) shown = items.filter((c) => c.group !== 'Tools').slice(0, 24);
    // One heading per group, the group with the best match first.
    const order = [...new Set(shown.map((c) => c.group))];
    shown = order.flatMap((g) => shown.filter((c) => c.group === g));
    if (q) shown.push({ group: 'Ask the AI', icon: 'sparkle', label: `Ask the AI: "${input.value.trim()}"`, run: () => import('./ai.js').then((a) => a.askAi(input.value.trim())) });
    at = Math.min(at, shown.length - 1);
    let last = '';
    list.replaceChildren(...shown.flatMap((c, i) => {
      const head = c.group !== last ? [h('div', { class: 'pal-group' }, c.group)] : [];
      last = c.group;
      return [...head, h('button', { class: `pal-item${i === at ? ' on' : ''}`, role: 'option', onmousemove: () => { if (at !== i) { at = i; draw(); } }, onclick: () => run(i) },
        icon(c.icon), h('span', { class: 'pal-label' }, c.label, c.hint ? h('span', { class: 'muted small' }, ` · ${c.hint}`) : ''), c.keys ? h('kbd', {}, c.keys) : '')];
    }));
    list.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (i) => { const c = shown[i]; closePalette(); c?.run(); };
  input.addEventListener('input', () => { at = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(shown.length - 1, at + 1); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); draw(); }
    if (e.key === 'Enter') { e.preventDefault(); run(at); }
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    e.stopPropagation();
  });
  at = 0;
  draw();
  input.focus();
}
export function closePalette() { el?.remove(); el = null; }
