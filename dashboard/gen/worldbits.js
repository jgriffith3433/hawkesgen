// What the world editors share (world.js, place.js, prop.js, story.js; src/worldkinds.ts): member cards that open with a
// tap and drag onto a stage or a timeline, file tiles that show a job's progress, the closed "Fine-tune", and making a
// scene's pack (its pictures and sound) priced first.

import { h, api, toast, fileUrl, icon, plainError } from './lib.js';
import { refreshCredits } from './account.js';
import { touchDrag, setDrag } from './dragdrop.js';
import { openScene, sceneItem, loadList } from './scenes.js';

export const fineTune = (...kids) => h('details', { class: 'ins-more wld-fine' }, h('summary', {}, 'Fine-tune'), h('div', { class: 'ins-more-body' }, ...kids));

/** A text field that changes the document as it's typed in (one undo step per focus) and redraws when left. */
export function textField(D, label, value, set, { rows = 0, ph = '', redraw } = {}) {
  const el = rows ? h('textarea', { rows: String(rows), placeholder: ph, 'data-field': label }, value ?? '') : h('input', { type: 'text', value: value ?? '', placeholder: ph, 'data-field': label });
  el.addEventListener('focus', () => D.change(() => {}, { redraw: false }));
  el.addEventListener('input', () => D.change(() => set(el.value), { history: false, redraw: false }));
  el.addEventListener('change', () => redraw?.());
  return label ? h('label', { class: 'field' }, label, el) : el;
}

/** A file an element holds, or where it is: making, failed, or empty (with what to do). */
export function elTile(e, kind = 'image', { empty = 'Nothing yet', cls = '' } = {}) {
  if (e?.asset) {
    if (kind === 'audio') return h('div', { class: `wld-tile audio ${cls}` }, icon('volume'), h('audio', { src: fileUrl(e.asset), controls: true, preload: 'none' }));
    if (kind === 'mesh') return h('div', { class: `wld-tile mesh ${cls}` }, icon('cube', 'ico big'), h('a', { href: fileUrl(e.asset), download: '', class: 'muted small' }, 'Download the 3D model'));
    return h('div', { class: `wld-tile ${cls}` }, h('img', { src: fileUrl(e.asset), alt: e.name ?? '', loading: 'lazy' }));
  }
  if (e?.pending) return h('div', { class: `wld-tile wait ${cls}` }, h('div', { class: 'working small' }, 'Making…'));
  if (e?.failed) return h('div', { class: `wld-tile fail ${cls}`, title: e.failed }, h('p', { class: 'muted small' }, `Didn't work: ${plainError(e.failed)}`));
  return h('div', { class: `wld-tile none ${cls}` }, h('p', { class: 'muted small' }, empty));
}

const KIND_ICON = { character: 'person', place: 'sun', prop: 'cube', story: 'text', world: 'layers' };

/** A member of a world as a card: tap to open, drag onto a stage or a timeline, a menu of what it can do. */
export function memberCard(m, { menu } = {}) {
  const item = () => sceneItem({ id: m.id, kind: m.kind, title: m.title, render: m.render });
  const el = h('div', { class: `wld-card${m.waiting ? ' waiting' : ''}`, draggable: 'true', tabindex: '0', title: `Open ${m.title}, or drag it onto a stage or the timeline` },
    h('div', { class: 'wld-card-pic' }, m.picture ? h('img', { src: fileUrl(m.picture), alt: '', loading: 'lazy' }) : icon(KIND_ICON[m.kind] ?? 'layers', 'ico big'), m.waiting ? h('span', { class: 'wld-card-wait' }, 'Making…') : ''),
    h('div', { class: 'wld-card-txt' }, h('b', {}, m.title), m.about ? h('span', { class: 'muted small' }, m.about) : ''),
    menu ? h('button', { class: 'icon-btn small wld-card-more', title: 'More', onclick: (e) => { e.stopPropagation(); menu(m, e.currentTarget); } }, icon('more')) : '');
  el.addEventListener('click', () => openScene(m.id));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openScene(m.id); });
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-hg-scene', JSON.stringify(item())); e.dataTransfer.effectAllowed = 'copy'; setDrag(item()); });
  touchDrag(el, item);
  return el;
}

/**
 * Makes what a scene is missing (its pack): priced first; over nothing it asks, with the price. `then` gets the scene
 * as Gen has it after the jobs started (its elements waiting on them).
 */
export async function makePack(sceneId, { then, what = 'its pictures' } = {}) {
  const url = /^\/v1\//.test(sceneId) ? sceneId : `/v1/worlds/pack/${sceneId}`;
  try {
    const q = await api(url, { body: {} });
    if (!q.jobs && !q.started?.length) { toast('Everything is made already.'); return; }
    let r = q;
    if (q.proposed) {
      if (!confirm(`Make ${what}? ${q.jobs} thing${q.jobs === 1 ? '' : 's'} for ${q.credits} credit${q.credits === 1 ? '' : 's'}.`)) return;
      r = await api(url, { body: { confirm: true } });
    }
    if (r.errors?.length) toast(plainError(r.errors[0]));
    else toast(`Making ${r.started.length} thing${r.started.length === 1 ? '' : 's'}: they fill in as they finish.`);
    refreshCredits();
    loadList();
    await then?.();
  } catch (err) { toast(plainError(err.message)); }
}

/** The world a scene names, and the world's other members (for pickers: a prop's owner, a shot's cast). */
export async function worldHome(worldId) {
  if (!worldId) return null;
  try { return await api(`/v1/worlds/${worldId}`); } catch { return null; }
}
