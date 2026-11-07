// The guided first project (J: "New accounts get a guided first run: pick an idea, generate an image, add it to the
// timeline, play it. Additive only"). Four steps in a small card that never covers the studio, so the person works in
// the real panes: 1 pick an idea, 2 make its picture (or use one already in Media: no credits), 3 put it on the timeline,
// 4 play it. Each step ticks itself when the thing happens, whoever did it (the card's button, a drag, a key).
// Only a brand-new account is offered it (made under 30 minutes ago, after the quick tour); it is dismissed with X and
// then never returns on its own; "Guided first project" in the ? menu runs it again. Kept per account in this browser.

import { h, icon, bus, api, toast, plainError } from './lib.js';
import { state } from './account.js';
import { P } from './project.js';
import { isPlaying, play } from './player.js';
import { activeKind, newScene } from './scenes.js';
import { runJob, placeAsset, quote, credits, showPane } from './media.js';
import { hasTool } from './studio.js';

const IDEAS = [
  { title: 'A lighthouse at dusk', prompt: 'A lone lighthouse on black rocks at dusk, waves breaking, warm lamp light, cinematic film still' },
  { title: 'A tiny robot in a garden', prompt: 'A small friendly robot watering flowers in a sunlit garden, soft light, digital illustration' },
  { title: 'A neon street in the rain', prompt: 'An empty neon-lit city street in the rain at night, reflections on wet pavement, cinematic' },
];
const STEPS = ['Pick an idea', 'Make the picture', 'Put it on the timeline', 'Play it'];
const key = () => `hg.guide.${state.user?.id ?? 'local'}`;
const mark = (v) => { try { localStorage.setItem(key(), v); } catch { /* */ } };
const marked = () => { try { return localStorage.getItem(key()); } catch { return 'unavailable'; } };
/** A fresh account that hasn't finished or dismissed it. */
export const guidePending = () => Boolean(state.user) && !marked() && Date.now() - (state.user.created ?? 0) < 30 * 60 * 1000;
export const guideOpen = () => Boolean(G);

let G = null; // { step, idea, asset, busy, card, offs }

/** Opens the guide from the first step (`force`: the menu; otherwise only a new account's). */
export function startGuide({ force = false } = {}) {
  if (!state.user || G) return;
  if (!force && !guidePending()) return;
  const card = h('aside', { id: 'guide', class: 'guide-card', role: 'dialog', 'aria-label': 'Your first project' });
  document.body.append(card);
  G = { step: 0, idea: null, asset: null, busy: false, card, offs: [] };
  const check = () => advance();
  G.offs.push(bus.on('doc', check), bus.on('time', check), bus.on('selection', check));
  draw();
  bus.emit('guide', { step: 0 });
}
export function endGuide(why = 'dismissed') {
  if (!G) return;
  G.offs.forEach((f) => f());
  G.card.remove();
  G = null;
  mark(why);
  bus.emit('guide', { step: -1, why });
}

/** Moves forward when the world shows a later step is already true (the person may have done it their own way). */
function advance() {
  if (!G || G.step < 2) return;
  if (G.step === 2 && G.asset && P.active && P.doc.clips.some((c) => c.asset === G.asset.id)) return go(3);
  if (G.step === 3 && isPlaying() && P.playhead > 0.3) return go(4);
}
function go(n) { if (!G) return; G.step = n; draw(); bus.emit('guide', { step: n }); if (n === 4) mark('done'); }

async function pickExisting() {
  try {
    const r = await api(`/v1/assets?${new URLSearchParams({ limit: '1', kind: 'image', project: state.user.project })}`);
    const a = r.items?.[0];
    if (!a) return toast('You have no pictures in Media yet. Make one here, it takes a minute.');
    G.asset = { id: a.id, kind: 'image', title: a.title || G.idea?.title || 'My picture' };
    go(2);
  } catch (err) { toast(plainError(err.message)); }
}
async function makePicture() {
  if (G.busy) return;
  G.busy = true; draw();
  try {
    const done = await runJob({ tool: 'image.generate', params: { prompt: G.idea.prompt, width: 1344, height: 768, seed: Math.floor(Math.random() * 2 ** 31) }, label: G.idea.title });
    const o = done.outputs.find((x) => x.kind === 'image') ?? done.outputs[0];
    if (G) { G.busy = false; G.asset = { id: o.asset, kind: 'image', title: G.idea.title }; go(2); }
  } catch { if (G) { G.busy = false; draw(); } }
}
async function putOnTimeline() {
  if (G.busy || !G.asset) return;
  G.busy = true; draw();
  try {
    // A video scene to put it in, unless a timeline is already in front.
    if (!P.active || !['video', 'image'].includes(activeKind())) {
      await newScene('video', { title: G.idea?.title ?? 'My first project' });
      await new Promise((r) => { const t0 = performance.now(); const tick = () => (P.active || performance.now() - t0 > 8000 ? r() : setTimeout(tick, 100)); tick(); });
    }
    if (!P.doc.clips.some((c) => c.asset === G.asset.id)) await placeAsset({ id: G.asset.id, kind: 'image', title: G.asset.title });
  } catch (err) { toast(plainError(err.message)); }
  if (G) { G.busy = false; if (G.step === 2 && P.active && P.doc.clips.some((c) => c.asset === G.asset.id)) go(3); else draw(); }
}

function draw() {
  if (!G) return;
  const { step } = G;
  const body = [];
  if (step === 0) {
    body.push(h('p', {}, 'Choose something to make, or write your own.'),
      h('div', { class: 'chips' }, ...IDEAS.map((i) => h('button', { type: 'button', class: `chip${G.idea?.title === i.title ? ' on' : ''}`, 'data-idea': i.title, onclick: () => { G.idea = i; draw(); } }, i.title))),
      h('form', { class: 'guide-own', onsubmit: (e) => { e.preventDefault(); const v = e.currentTarget.elements.own.value.trim(); if (v) { G.idea = { title: v.slice(0, 40), prompt: v }; draw(); } } },
        h('input', { name: 'own', placeholder: 'or describe your own idea', 'aria-label': 'Your own idea', maxlength: '200' }), h('button', { class: 'ghost small' }, 'Use it')));
    if (G.idea) body.push(h('div', { class: 'guide-foot' }, h('button', { class: 'primary small', 'data-next': '1', onclick: () => go(1) }, 'Next')));
  } else if (step === 1) {
    const can = hasTool('image.generate');
    const price = h('span', { class: 'quote' });
    quote('image.generate', { prompt: G.idea.prompt, width: 1344, height: 768 }).then((q) => { price.textContent = credits(q); });
    body.push(h('p', {}, h('b', {}, G.idea.title), ': Gen paints it from your words. You can also use a picture you already have.'),
      h('div', { class: 'guide-foot' }, price,
        h('button', { class: 'ghost small', 'data-media': '1', disabled: G.busy, onclick: pickExisting }, 'Use one from Media'),
        h('button', { class: 'primary small', 'data-make': '1', disabled: G.busy || !can, onclick: makePicture }, icon('sparkle'), G.busy ? 'Making it…' : 'Make the picture')));
  } else if (step === 2) {
    body.push(h('p', {}, 'Your picture is in Media. Drag it onto the timeline, or let me put it there.'),
      h('div', { class: 'guide-foot' }, h('button', { class: 'ghost small', onclick: () => showPane('media') }, 'Show Media'),
        h('button', { class: 'primary small', 'data-add': '1', disabled: G.busy, onclick: putOnTimeline }, 'Add to the timeline')));
  } else if (step === 3) {
    body.push(h('p', {}, 'It\'s on the track. Press play, or tap Space.'),
      h('div', { class: 'guide-foot' }, h('button', { class: 'primary small', 'data-play': '1', onclick: () => { P.playhead = 0; play(); } }, icon('play'), 'Play it')));
  } else {
    body.push(h('p', {}, 'That\'s a first project: an idea, a picture and a timeline. Ask the AI on the right for music, a title or a few more shots.'),
      h('div', { class: 'guide-foot' }, h('button', { class: 'primary small', 'data-done': '1', onclick: () => endGuide('done') }, 'Keep going')));
  }
  G.card.dataset.step = String(step);
  G.card.replaceChildren(
    h('div', { class: 'guide-head' }, h('span', { class: 'tour-step' }, step < 4 ? `Step ${step + 1} of 4` : 'Done'),
      h('button', { class: 'link small guide-x', title: 'Dismiss the guide', 'aria-label': 'Dismiss the guide', onclick: () => endGuide('dismissed') }, icon('close'))),
    h('h3', {}, step < 4 ? STEPS[step] : 'You made something'),
    h('div', { class: 'tour-dots' }, ...STEPS.map((_, j) => h('span', { class: j <= step ? 'on' : '' }))),
    ...body);
}

/** Opens after the quick tour for a new account (or on load, when they skipped it earlier and are still new). */
export function initGuide() {
  const soon = () => setTimeout(() => { if (!G && guidePending() && !document.querySelector('#landing:not([hidden])')) startGuide(); }, 500);
  bus.on('tourDone', soon);
  bus.on('ready', () => { if (state.user) { try { if (localStorage.getItem(`hg.tour.${state.user.id}`) === '1') soon(); } catch { /* */ } } });
}
