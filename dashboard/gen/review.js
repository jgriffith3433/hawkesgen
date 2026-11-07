// Review mode (docs/showrunner.md): watch a cut the showrunner made, stop on a moment, mark the spot on the frame if it
// helps, and say what's wrong. The showrunner sees that frame and the shot behind it and makes a new take of the shot on
// the server; when it's there, before and after play side by side with Keep and Undo. The cut plays in the center as
// usual (Space, the timeline); review mode is a panel over it and a layer for marking a box on the frame.

import { h, api, toast, icon, plainError, friendly, fileUrl, fmt } from './lib.js';
import { P, take } from './project.js';
import { refreshCredits } from './account.js';

const R = { scene: null, panel: null, layer: null, box: null, t: null, fix: null, timer: 0 };

/** Opens a cut in review mode. */
export async function openReview(sceneId) {
  if (!sceneId) return;
  const s = await import('./scenes.js');
  await s.openScene(sceneId);
  close();
  R.scene = sceneId;
  mount();
}

export function close() {
  R.unlisten?.(); R.unlisten = null;
  R.panel?.remove();
  R.layer?.remove();
  Object.assign(R, { scene: null, panel: null, layer: null, box: null, t: null, fix: null, timer: 0 });
}

function mount() {
  const wrap = document.getElementById('viewerWrap');
  const viewer = document.getElementById('viewer');
  if (!wrap || !viewer) return;
  // The marking layer: drag on the frame for a box (shares of the frame), or leave it for the whole moment.
  R.layer = h('div', { class: 'review-layer', hidden: true });
  let from = null;
  const at = (e) => { const r = R.layer.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
  R.layer.addEventListener('pointerdown', (e) => { from = at(e); R.layer.setPointerCapture(e.pointerId); });
  R.layer.addEventListener('pointermove', (e) => { if (!from) return; const [x, y] = at(e); R.box = { x: Math.min(from[0], x), y: Math.min(from[1], y), w: Math.abs(x - from[0]), h: Math.abs(y - from[1]) }; drawBox(); });
  R.layer.addEventListener('pointerup', () => { from = null; if (R.box && (R.box.w < 0.02 || R.box.h < 0.02)) { R.box = null; drawBox(); } });
  viewer.append(R.layer);
  R.panel = h('div', { class: 'review-panel' });
  wrap.append(R.panel);
  draw();
}

function drawBox() {
  R.layer.replaceChildren(R.box ? h('i', { class: 'review-box', style: `left:${R.box.x * 100}%;top:${R.box.y * 100}%;width:${R.box.w * 100}%;height:${R.box.h * 100}%` }) : '');
}

function draw() {
  if (!R.panel) return;
  const head = h('div', { class: 'review-head' }, icon('frame'), h('b', {}, 'Review'), h('span', { class: 'muted small' }, ' · play the cut, stop where something is wrong'), h('button', { class: 'icon-btn small', title: 'Leave review', onclick: close }, icon('close')));
  if (R.fix) return R.panel.replaceChildren(head, fixView());
  if (R.t == null) {
    R.layer.hidden = true;
    return R.panel.replaceChildren(head, h('div', { class: 'row' }, h('button', { class: 'primary small', onclick: () => { R.t = P.playhead; R.box = null; draw(); } }, `Mark this moment (${fmt(P.playhead)})`)));
  }
  R.layer.hidden = false;
  drawBox();
  const words = h('textarea', { rows: 2, placeholder: 'What\'s wrong here? "Her face changed", "he should be holding the lantern", "too dark"' });
  const send = async () => {
    const text = words.value.trim();
    if (!text) return words.focus();
    R.panel.replaceChildren(head, h('p', { class: 'muted' }, 'Looking at that moment…'));
    try {
      const r = await api('/v1/showrunner/review', { body: { scene: R.scene, t: R.t, box: R.box, text } });
      R.fix = r.fix;
      if (r.aiCredits) refreshCredits();
      toast(r.say);
      follow();
    } catch (err) {
      const f = friendly(err);
      toast(f.text || plainError(err.message));
      if (f.fix === 'credits') import('./media.js').then((m) => m.showError(err));
    }
    draw();
  };
  R.panel.replaceChildren(head,
    h('p', { class: 'muted small' }, `At ${fmt(R.t)}. ${R.box ? 'The marked spot goes with it.' : 'Drag on the frame to mark a spot (optional).'}`),
    words,
    h('div', { class: 'row' }, h('button', { class: 'primary small', onclick: send }, 'Fix it'), h('button', { class: 'ghost small', onclick: () => { R.t = null; R.box = null; draw(); } }, 'Back')));
  words.focus();
}

/** One read of the fix's production, and it is drawn only when something changed. */
async function readFix() {
  if (!R.fix) return;
  let next;
  try { next = await api(`/v1/showrunner/productions/${R.fix.id}`); } catch { return; }
  if (!R.fix || next.id !== R.fix.id) return;
  // Drawn only when something changed: a redraw restarts the before and after takes (J, 2026-11-01: no constant refreshes).
  const same = JSON.stringify(next) === JSON.stringify(R.fix);
  R.fix = next;
  if (!['running', 'proposed', 'paused'].includes(next.status)) stopFollowing();
  if (!same) draw();
}
function stopFollowing() { R.unlisten?.(); R.unlisten = null; }

/**
 * Follows the fix's production on the page's live stream (GET /v1/events, `production` events from the server): each
 * event for it reads the production once. Nothing asks on a timer; a stream that comes back from a drop reads it once.
 */
function follow() {
  stopFollowing();
  if (!R.fix) return;
  const id = R.fix.id;
  const asked = import('./jobwatch.js').then(({ jobWatch }) => jobWatch()).then((w) => w.on('production', (ev) => {
    if (ev?.id === id) void readFix();
  }, () => void readFix()));
  R.unlisten = () => { void asked.then((stop) => stop()); };
  // One read once the stream is listening, so a change that came in between is not missed.
  void asked.then(() => readFix());
}

function fixView() {
  const f = R.fix;
  const fx = f.out?.fix ?? {};
  if (f.status === 'proposed') {
    return h('div', {}, h('p', {}, `A new take of this shot costs ${f.card?.credits ?? 0} credits.`),
      h('div', { class: 'row' }, h('button', { class: 'primary small', onclick: () => act('approve') }, 'Make it'), h('button', { class: 'ghost small', onclick: () => act('dismiss') }, 'Not now')));
  }
  if (f.status === 'running' || f.status === 'paused') {
    const pr = f.progress ?? { done: 0, total: 1 };
    return h('div', {}, h('p', {}, 'Making a new take of this shot…'), h('div', { class: 'sr-bar' }, h('i', { style: `width:${Math.round((pr.done / Math.max(1, pr.total)) * 100)}%` })), h('p', { class: 'muted small' }, 'You can keep watching or close this; it carries on.'));
  }
  if (f.status !== 'done' || !fx.after) return h('div', {}, h('p', { class: 'muted' }, f.status === 'failed' ? `The new take didn't work out: ${plainError(f.error ?? '')}` : 'Stopped.'), h('button', { class: 'ghost small', onclick: () => { R.fix = null; R.t = null; draw(); } }, 'Back'));
  const vid = (asset, label) => h('figure', { class: 'review-take' }, h('video', { src: fileUrl(asset), muted: true, loop: true, autoplay: true, playsinline: true }), h('figcaption', { class: 'muted small' }, label));
  return h('div', {},
    h('div', { class: 'review-compare' }, fx.before ? vid(fx.before, 'Before') : '', vid(fx.after, 'After')),
    fx.kept == null
      ? h('div', { class: 'row' }, h('button', { class: 'primary small', onclick: () => act('keep') }, 'Keep'), h('button', { class: 'ghost small', onclick: () => act('undo') }, 'Undo'))
      : h('div', { class: 'row' }, h('span', { class: 'muted small' }, fx.kept ? 'Kept in the cut.' : 'Left as it was.'), h('button', { class: 'ghost small', onclick: () => { R.fix = null; R.t = null; draw(); } }, 'Fix another moment')));
}

async function act(what) {
  try {
    R.fix = await api(`/v1/showrunner/productions/${R.fix.id}/${what}`, { body: {} });
    if (what === 'approve') { refreshCredits(); follow(); }
    if (what === 'dismiss') { R.fix = null; R.t = null; }
    // Keep and Undo change the cut on Gen: the open cut takes the new version.
    if ((what === 'keep' || what === 'undo') && P.id === R.scene) take(await api(`/v1/editor/projects/${R.scene}`));
  } catch (err) { toast(plainError(err.message)); }
  draw();
}
