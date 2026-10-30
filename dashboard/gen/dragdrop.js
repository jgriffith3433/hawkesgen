// Dragging things onto the timeline with a finger (J, 2026-10-29: "on mobile I can drag and drop things onto the
// timeline"). Browsers don't do HTML drag and drop on touch screens, so a tile becomes draggable by holding it: after a
// short hold (no scrolling) it lifts, a small copy follows the finger, the track under it lights up, and letting go drops
// it there (dropAt, the same path as a mouse drop). Moving before the hold ends is a scroll, as usual. Drop targets
// register here: the timeline (onto a track at a time) and the center (the scene in front takes it).

import { h, bus } from './lib.js';

const TARGETS = [];
/** A place things can be dropped: hover(x, y, item) shows where (false: not here), drop(x, y, item) takes it. */
export function dropTarget(t) { TARGETS.push(t); }

const HOLD_MS = 280;

/** Makes an element draggable by touch. `item()` says what it carries ({ asset, assetKind, title } or a scene item). */
export function touchDrag(el, item) {
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
      over = null;
      for (const t of TARGETS) { const ok = t.hover(x, y, cur); if (ok && !over) over = t; else if (!ok) t.leave?.(); }
      ghost.classList.toggle('ok', Boolean(over));
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
        over.drop(p.clientX, p.clientY, cur);
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
      for (const t of TARGETS) t.leave?.();
      if (lifted) bus.emit('touchDrag', false);
    }
    addEventListener('touchmove', move, { passive: false });
    addEventListener('touchend', finish);
    addEventListener('touchcancel', end);
  }, { passive: true });
  // A long press opens the browser's menu on images; the hold is ours.
  el.addEventListener('contextmenu', (e) => { if (matchMedia('(pointer: coarse)').matches) e.preventDefault(); });
}
