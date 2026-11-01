// What the AI remembers about this account (Account > Your AI; src/showrunner/memory.ts): the looks they kept, the
// pacing of their cuts, what they often ask for, their recurring characters, and their own notes. Each can be removed;
// learning can be turned off; everything can be forgotten. It is theirs alone.

import { h, api, toast } from './lib.js';

export async function drawMemory(box) {
  if (!box) return;
  let r;
  try { r = await api('/v1/showrunner/memory'); } catch (err) { box.replaceChildren(h('p', { class: 'muted small' }, err.message)); return; }
  const m = r.memory;
  const save = async (patch) => { try { await api('/v1/showrunner/memory', { method: 'PUT', body: patch }); drawMemory(box); } catch (err) { toast(err.message); } };
  const item = (text, remove) => h('li', {}, text, h('button', { class: 'link small', title: 'Forget this', onclick: remove }, '×'));
  const often = Object.entries(m.changes ?? {}).sort((a, b) => b[1] - a[1]);
  const chars = Object.entries(m.characters ?? {});
  const notes = h('textarea', { rows: 2, placeholder: 'Anything the AI should always know: "I like long takes", "my worlds are always set at night"…' });
  notes.value = m.notes ?? '';
  notes.addEventListener('change', () => save({ notes: notes.value }));
  const learnBox = h('input', { type: 'checkbox' });
  learnBox.checked = !m.off;
  learnBox.addEventListener('change', () => save({ off: !learnBox.checked }));
  box.replaceChildren(
    h('p', { class: 'muted small' }, 'The AI learns your taste from what you keep, change and cut, and plans with it. Only you and your AI see it.'),
    notes,
    ...(m.looks?.length ? [h('h4', {}, 'Looks you kept'), h('ul', { class: 'memory-list' }, ...m.looks.map((x) => item(x, () => save({ looks: m.looks.filter((y) => y !== x) }))))] : []),
    ...(m.pacing?.shotSeconds ? [h('h4', {}, 'Your pacing'), h('ul', { class: 'memory-list' }, item(`About ${m.pacing.shotSeconds} s a shot`, () => save({ pacing: null })))] : []),
    ...(often.length ? [h('h4', {}, 'You often ask for'), h('ul', { class: 'memory-list' }, ...often.map(([k, n]) => item(`${k} (${n}×)`, () => save({ changes: Object.fromEntries(often.filter(([x]) => x !== k)) }))))] : []),
    ...(chars.length ? [h('h4', {}, 'Your characters'), h('ul', { class: 'memory-list' }, ...chars.map(([k]) => item(k, () => save({ characters: Object.fromEntries(chars.filter(([x]) => x !== k)) }))))] : []),
    h('label', { class: 'row small' }, learnBox, ' Learn from what I do'),
    h('button', { class: 'link small', onclick: async () => { if (!confirm('Forget everything the AI learned about you?')) return; await api('/v1/showrunner/memory', { method: 'DELETE' }); drawMemory(box); } }, 'Forget everything'));
}
