// A very quick tour for a new account (J, 2026-10-30: "just show them 3 sections media, timeline and AI chat. Make it
// modern and not annoying"): three cards, each lighting up its part of the page (the rest dims), with Next, Back and
// Skip. Esc or a click outside ends it. It runs once per account (kept in this browser) and the help menu runs it again.
// On a phone it points at the bottom tabs for Media and the AI, and at the timeline itself.

import { $, h, bus } from './lib.js';
import { state } from './account.js';

const phone = () => getComputedStyle($('#mobileTabs')).display !== 'none';
const STEPS = [
  { at: () => (phone() ? $('#mobileTabs button[data-m="media"]') : $('#leftPane')), title: 'Your media',
    text: 'Everything you upload or make lands here. Drag it onto the timeline, or make something new in Create.' },
  { at: () => $('#timelinePane'), title: 'The timeline',
    text: 'Pictures, clips, sounds and words sit on tracks, and the top track shows in front. Drag to move, pull an edge to trim. Whatever is under the playhead shows above.' },
  { at: () => (phone() ? $('#mobileTabs button[data-m="ai"]') : $('#rightPane')), title: 'Your AI',
    text: 'Tell it what you want: "make a 15-second trailer", "remove the background", "add music that fits". It edits and makes things for you, and you can undo anything.' },
];
const doneKey = () => `hg.tour.${state.user?.id ?? 'local'}`;
export const tourDone = () => { try { return localStorage.getItem(doneKey()) === '1'; } catch { return true; } };

let T = null;
/** Runs the tour from the first step. */
export function startTour() {
  endTour(false);
  const spot = h('div', { class: 'tour-spot' });
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-live': 'polite' });
  const veil = h('div', { class: 'tour-veil', onclick: () => endTour() });
  document.body.append(veil, spot, card);
  T = { i: 0, spot, card, veil };
  addEventListener('resize', place);
  addEventListener('keydown', onKey, true);
  draw();
  document.body.classList.add('touring');
}
export function endTour(remember = true) {
  if (!T) return;
  removeEventListener('resize', place);
  removeEventListener('keydown', onKey, true);
  T.spot.remove(); T.card.remove(); T.veil.remove();
  document.body.classList.remove('touring');
  T = null;
  if (remember) { try { localStorage.setItem(doneKey(), '1'); } catch { /* */ } }
}
function onKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); endTour(); }
  if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); next(1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); next(-1); }
}
function next(by) {
  const i = T.i + by;
  if (i >= STEPS.length) return endTour();
  if (i < 0) return;
  T.i = i;
  draw();
}
function draw() {
  const s = STEPS[T.i];
  T.card.replaceChildren(
    h('div', { class: 'tour-step' }, `${T.i + 1} of ${STEPS.length}`),
    h('h3', {}, s.title), h('p', {}, s.text),
    h('div', { class: 'tour-foot' },
      h('div', { class: 'tour-dots' }, ...STEPS.map((_, j) => h('span', { class: j === T.i ? 'on' : '' }))),
      h('button', { class: 'link small', onclick: () => endTour() }, 'Skip'),
      T.i ? h('button', { class: 'ghost small', onclick: () => next(-1) }, 'Back') : '',
      h('button', { class: 'primary small', onclick: () => next(1) }, T.i === STEPS.length - 1 ? 'Start making' : 'Next')));
  place();
  T.card.querySelector('.primary')?.focus();
}
/** The light goes around the step's part of the page; the card sits beside it, inside the screen. */
function place() {
  if (!T) return;
  const el = STEPS[T.i].at();
  const r = el?.getBoundingClientRect() ?? { left: innerWidth / 2 - 100, top: innerHeight / 2 - 60, width: 200, height: 120 };
  const pad = 6;
  Object.assign(T.spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  const cw = Math.min(320, innerWidth - 24), ch = T.card.offsetHeight || 180;
  let x, y;
  if (r.width > innerWidth * 0.6) { x = (innerWidth - cw) / 2; y = r.top - ch - 16 > 8 ? r.top - ch - 16 : Math.min(innerHeight - ch - 8, r.bottom + 16); }
  else if (r.left + r.width + cw + 24 < innerWidth) { x = r.right + 16; y = r.top + 20; }
  else if (r.left - cw - 16 > 0) { x = r.left - cw - 16; y = r.top + 20; }
  else { x = (innerWidth - cw) / 2; y = r.top - ch - 16 > 8 ? r.top - ch - 16 : r.bottom + 16; }
  Object.assign(T.card.style, { left: `${Math.max(12, Math.min(innerWidth - cw - 12, x))}px`, top: `${Math.max(12, Math.min(innerHeight - ch - 12, y))}px`, width: `${cw}px` });
}

/** A new account gets the tour once, a moment after the studio opens. */
export function initTour() {
  const maybe = (fresh) => {
    if (!state.user || tourDone()) return;
    const isNew = fresh || Date.now() - (state.user.created ?? 0) < 30 * 60 * 1000;
    // Only before the person has started: never over an edit already under way (a clip on a track, a tool sheet open).
    const started = () => !!$('#toolSheet') || !!document.querySelector('#tlTracks .clip');
    if (isNew) setTimeout(() => { if (!T && !started() && !$('#landing:not([hidden])') && !document.querySelector('dialog[open]')) startTour(); }, 900);
  };
  bus.on('welcome', () => maybe(true));
  bus.on('ready', () => maybe(false));
}
