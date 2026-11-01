// The showrunner's approval card in the AI pane (src/showrunner/, docs/showrunner.md): what a production will make,
// how long it takes and what it costs, the plan as words (closed), and Approve, Change, Not now. Approved, the card
// follows the production on the server (progress from /v1/events, so the page can close and come back) and ends with
// Open the cut and Review it.

import { h, api, toast, icon, plainError, friendly } from './lib.js';
import { refreshCredits } from './account.js';

const LIVE = new Map(); // production id -> its newest state
const CARDS = new Map(); // production id -> card elements on screen (redrawn on each update)
let stream = null;

const WORDS = { world: ['world', 'worlds'], characters: ['character', 'characters'], places: ['place', 'places'], shots: ['shot', 'shots'], pictures: ['picture', 'pictures'], clips: ['clip', 'clips'], 'voice lines': ['voice line', 'voice lines'], music: ['score', 'scores'], cut: ['cut', 'cuts'] };
const count = (k, n) => `${n} ${(WORDS[k] ?? [k, k])[n === 1 ? 0 : 1]}`;

/** The production as last seen (a card on screen keeps itself current through this). */
export const productionState = (p) => LIVE.get(p.id) ?? p;

/** Follows running productions on the event stream while any card is waiting on one. */
function follow() {
  const want = [...LIVE.values()].some((p) => p.status === 'running' || p.status === 'paused');
  if (!want) { stream?.close(); stream = null; return; }
  if (stream) return;
  stream = new EventSource('/v1/events');
  stream.addEventListener('production', async (e) => {
    let ev = null;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (!LIVE.has(ev.id)) return;
    const p = { ...LIVE.get(ev.id), status: ev.status, progress: ev.progress, out: { ...LIVE.get(ev.id).out, ...ev.out } };
    LIVE.set(ev.id, p);
    redraw(ev.id);
    if (ev.notice && !p.parent) {
      toast(ev.notice, ev.status === 'done' && p.out.cut ? { action: 'Open the cut', onAction: () => openCut(p), ms: 12000 } : {});
      if (ev.status === 'done' || ev.status === 'failed') refresh(ev.id);
    }
    if (ev.status !== 'running' && ev.status !== 'paused') follow();
  });
}
async function refresh(id) {
  try { LIVE.set(id, await api(`/v1/showrunner/productions/${id}`)); redraw(id); } catch { /* gone */ }
  follow();
}
/** Starts watching a production the conversation shows (after a reload too). */
export function watch(p) {
  if (!p?.id) return;
  if (!LIVE.has(p.id)) { LIVE.set(p.id, p); if (p.status === 'running' || p.status === 'paused' || p.status === 'proposed') refresh(p.id); }
  follow();
}
function redraw(id) {
  for (const el of CARDS.get(id) ?? []) if (el.isConnected) el.replaceWith(card(LIVE.get(id), el._opts)); else CARDS.get(id).delete(el);
}

async function act(p, what) {
  try {
    const r = await api(`/v1/showrunner/productions/${p.id}/${what}`, { body: {} });
    LIVE.set(p.id, r);
    redraw(p.id);
    follow();
    if (what === 'approve') refreshCredits();
    if (what === 'cancel' && r.uncharged) toast(`Stopped. ${r.uncharged} credits of work that hadn't started weren't charged.`);
  } catch (err) {
    const f = friendly(err);
    toast(f.text || plainError(err.message));
    if (f.fix === 'credits') import('./media.js').then((m) => m.showError(err));
  }
}
function openCut(p) { if (p.out?.cut) import('./scenes.js').then((s) => s.openScene(p.out.cut)); }

/**
 * The card for a production. `opts.onChange` puts the AI box into "change the plan" mode for this production.
 */
export function card(p0, opts = {}) {
  const p = productionState(p0);
  const c = p.card ?? { counts: {}, credits: 0, fixCredits: 0, minutes: 1, outline: {} };
  const o = c.outline ?? {};
  const el = h('div', { class: `production ${p.status}` },
    h('div', { class: 'production-head' }, icon('film'), h('b', {}, p.title || o.title || 'Production')),
    o.logline ? h('p', { class: 'production-logline' }, o.logline) : '',
    h('div', { class: 'production-counts' }, ...Object.entries(c.counts ?? {}).map(([k, n]) => h('span', { class: 'chip static' }, count(k, n)))),
    h('div', { class: 'production-price' }, h('b', {}, `${c.credits} credits`), c.fixCredits ? h('span', { class: 'muted' }, ` (up to ${c.fixCredits} more to re-take shots that fail their checks)`) : '', h('span', { class: 'muted' }, ` · about ${c.minutes} min`)),
    plan(o),
    c.issues?.length ? h('p', { class: 'muted small' }, `Worth a look: ${c.issues.slice(0, 3).join(' ')}`) : '',
    body(p, opts));
  el._opts = opts;
  if (!CARDS.has(p.id)) CARDS.set(p.id, new Set());
  CARDS.get(p.id).add(el);
  watch(p);
  return el;
}

function plan(o) {
  const list = (title, items) => (items?.length ? [h('h4', {}, title), h('ul', {}, ...items.map((x) => h('li', {}, x)))] : []);
  return h('details', { class: 'production-plan' }, h('summary', {}, 'The plan'),
    ...(o.world ? [h('h4', {}, o.world.isNew ? 'A new world' : 'The world'), h('p', {}, `${o.world.title}${o.world.tone ? `: ${o.world.tone}` : ''}`)] : []),
    ...list('Characters', (o.characters ?? []).map((x) => `${x.name}${x.role ? `, ${x.role}` : ''}${x.isNew ? '' : ' (yours)'}`)),
    ...list('Places', (o.places ?? []).map((x) => x.name)),
    ...list('The story', o.beats ?? []),
    ...list('Shots', (o.shots ?? []).map((s) => `${s.seconds} s · ${s.action || s.type}${s.lines ? ` · ${s.lines} line${s.lines === 1 ? '' : 's'}` : ''}`)));
}

function body(p, opts) {
  if (p.status === 'proposed') {
    return h('div', { class: 'row' },
      h('button', { class: 'primary small', onclick: () => act(p, 'approve') }, p.parent ? 'Make the new take' : 'Approve'),
      p.parent ? '' : h('button', { class: 'ghost small', onclick: () => opts.onChange?.(p) }, 'Change'),
      h('button', { class: 'ghost small', onclick: () => act(p, 'dismiss') }, 'Not now'));
  }
  if (p.status === 'running' || p.status === 'paused') {
    const pr = p.progress ?? { done: 0, total: 1 };
    return h('div', { class: 'production-live' },
      h('div', { class: 'sr-bar' }, h('i', { style: `width:${Math.round((pr.done / Math.max(1, pr.total)) * 100)}%` })),
      h('div', { class: 'muted small' }, p.status === 'paused' ? `Paused · ${pr.done} of ${pr.total} done` : `${pr.done} of ${pr.total} done${pr.step ? ` · ${plainError(pr.step)}` : ''}. You can close the page: it keeps going.`),
      h('div', { class: 'row' },
        p.status === 'paused' ? h('button', { class: 'ghost small', onclick: () => act(p, 'resume') }, 'Resume') : h('button', { class: 'ghost small', onclick: () => act(p, 'pause') }, 'Pause'),
        h('button', { class: 'ghost small', onclick: () => { if (confirm('Stop making this? What is already made stays in your library.')) act(p, 'cancel'); } }, 'Stop')));
  }
  if (p.status === 'done') {
    const failed = p.progress?.failed ?? [];
    return h('div', {},
      failed.length ? h('p', { class: 'muted small' }, `Left out: ${failed.slice(0, 3).map(plainError).join('; ')}`) : '',
      p.parent ? h('p', { class: 'muted small' }, 'The new take is ready in review.') : h('div', { class: 'row' },
        h('button', { class: 'primary small', onclick: () => openCut(p) }, 'Open the cut'),
        h('button', { class: 'ghost small', onclick: () => import('./review.js').then((r) => r.openReview(p.out.cut)) }, 'Review it')));
  }
  if (p.status === 'failed') return h('p', { class: 'muted small' }, `It couldn't be finished: ${plainError(p.error ?? 'something went wrong')}`);
  return h('p', { class: 'muted small' }, p.status === 'cancelled' ? 'Stopped.' : 'Not now.');
}
