// Every drag in the app, with a mouse or a finger, says what will happen before you let go (J, 2026-10-30: "if I am
// dragging something that's not supported then it should tell me why it's not supported. Really help the user"). A
// note follows the pointer: "Add to Music at 0:03" when the spot takes it, or why not ("A character goes on a stage:
// open a stage tab and drop them there") in red. Letting go where it isn't taken shows the reason again.
//
// Drop targets register here: the timeline (onto a track at a time) and the center (the scene in front takes it). Each
// says, for a point and a dragged thing, whether it's over it (null: not) and if so { ok, text }; it may light up where
// it would land (show) and takes the drop. What's being dragged is told here when the drag starts (setDrag), since the
// browser only reveals a drag's data at the drop.
//
// Phones don't do HTML drag and drop, so a tile becomes draggable by holding it: after a short hold (no scrolling) it
// lifts, a small copy follows the finger with the same note, and letting go drops it. Moving before the hold ends is a
// scroll, as usual.

import { h, bus, toast } from './lib.js';

const TARGETS = [];
/** A place things can be dropped: { check(x, y, item) -> null | { ok, text }, show?(x, y, item, ok), leave?(), drop(x, y, item) }. */
export function dropTarget(t) { TARGETS.push(t); }

let current = null;
/** What a mouse drag carries (set on dragstart; the browser hides it until the drop). */
export function setDrag(item) { current = item; }
export const dragging = () => current;

let tip = null;
function showTip(x, y, r) {
  tip ??= document.body.appendChild(h('div', { class: 'drag-tip', role: 'status' }));
  tip.textContent = r.text;
  tip.classList.toggle('no', !r.ok);
  tip.hidden = false;
  const w = tip.offsetWidth;
  tip.style.transform = `translate(${Math.max(8, Math.min(innerWidth - w - 8, x + 16))}px, ${Math.max(8, y - 44)}px)`;
}
function hideTip() { if (tip) tip.hidden = true; }

/** The first target the point is over, and what it says. */
function where(x, y, item) {
  for (const t of TARGETS) {
    const r = t.check(x, y, item);
    if (r) return { t, r };
  }
  return null;
}
function leaveAll(except) { for (const t of TARGETS) if (t !== except) t.leave?.(); }

// Mouse drags: one handler for every target.
addEventListener('dragover', (e) => {
  if (!current) return;
  const w = where(e.clientX, e.clientY, current);
  leaveAll(w?.t);
  if (!w) { hideTip(); return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = w.r.ok ? 'copy' : 'none';
  w.t.show?.(e.clientX, e.clientY, current, w.r.ok);
  showTip(e.clientX, e.clientY, w.r);
}, true);
addEventListener('drop', (e) => {
  if (!current) return;
  const item = current;
  const w = where(e.clientX, e.clientY, item);
  current = null;
  hideTip();
  leaveAll();
  if (!w) return;
  e.preventDefault();
  e.stopPropagation();
  if (w.r.ok) w.t.drop(e.clientX, e.clientY, item);
  else toast(w.r.text);
}, true);
addEventListener('dragend', () => { current = null; hideTip(); leaveAll(); }, true);

const HOLD_MS = 280;

/** Makes an element draggable by mouse and by touch. `item()` says what it carries ({ asset, assetKind, title } or a scene item). */
export function touchDrag(el, item) {
  el.addEventListener('dragstart', () => setDrag(item()));
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t0 = e.touches[0];
    const start = { x: t0.clientX, y: t0.clientY };
    let lifted = false, ghost = null, cur = null, over = null;
    const hold = setTimeout(() => {
      lifted = true;
      cur = item();
      navigator.vibrate?.(12);
      el.classList.add('lifted');
      ghost = h('div', { class: 'drag-ghost' });
      const media = el.querySelector('img, video');
      if (media?.tagName === 'IMG') ghost.append(h('img', { src: media.src, alt: '' }));
      else ghost.append(h('span', {}, cur.title || 'Drop on a track'));
      document.body.append(ghost);
      place(start.x, start.y);
      bus.emit('touchDrag', true);
    }, HOLD_MS);
    const place = (x, y) => {
      ghost.style.transform = `translate(${x - 34}px, ${y - 60}px)`;
      over = where(x, y, cur);
      leaveAll(over?.t);
      over?.t.show?.(x, y, cur, over.r.ok);
      ghost.classList.toggle('ok', Boolean(over?.r.ok));
      ghost.classList.toggle('no', Boolean(over && !over.r.ok));
      if (over) showTip(x, y - 50, over.r); else showTip(x, y - 50, { ok: true, text: 'Drag onto a track, or onto the picture above' });
    };
    const move = (ev) => {
      const p = ev.touches[0];
      if (!lifted) { if (Math.hypot(p.clientX - start.x, p.clientY - start.y) > 10) end(); return; }
      ev.preventDefault();
      place(p.clientX, p.clientY);
    };
    const finish = (ev) => {
      if (lifted && over) {
        const p = ev.changedTouches[0];
        if (over.r.ok) over.t.drop(p.clientX, p.clientY, cur); else toast(over.r.text);
        ev.preventDefault();
      }
      end();
    };
    function end() {
      clearTimeout(hold);
      removeEventListener('touchmove', move);
      removeEventListener('touchend', finish);
      removeEventListener('touchcancel', end);
      el.classList.remove('lifted');
      ghost?.remove();
      hideTip();
      leaveAll();
      if (lifted) bus.emit('touchDrag', false);
    }
    addEventListener('touchmove', move, { passive: false });
    addEventListener('touchend', finish);
    addEventListener('touchcancel', end);
  }, { passive: true });
  // A long press opens the browser's menu on images; the hold is ours.
  el.addEventListener('contextmenu', (e) => { if (matchMedia('(pointer: coarse)').matches) e.preventDefault(); });
}
