// Scrub frames (J, 2026-11-01: "When scrubbing in the timeline I want it to be faster to show the preview. I almost never
// want to see "Loading.." I want scrubbing to be really responsive. Make sure this also works on mobile.").
//
// A video seek has to decode from the last keyframe, and the clips Gen makes often have one keyframe for the whole clip,
// so every seek while scrubbing can take a long while and the canvas was left on an old frame or "Loading…". This keeps a
// strip of small frames for each video in the scene: made in the background by playing a hidden, muted copy fast and
// copying frames off it as they go past (one pass, no seeks), then filling any gaps with seeks; and topped up with every
// real frame the player lands on. While scrubbing, the center draws the strip's frame nearest the playhead at once, and
// the real frame replaces it as soon as the player's seek lands.

import { fileUrl } from './lib.js';

const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const WIDTH = coarse ? 288 : 384; // px wide each frame is kept at
const BUDGET = coarse ? 240 : 480; // frames kept across every video (at most about 45 MB on a phone, 140 MB on a computer)
const WORKERS = coarse ? 1 : 2; // videos made into strips at once
const STALL = 8000; // ms a strip's pass may go without a new frame before it's left as it is

const STRIPS = new Map(); // asset -> { step, dur, w, h, frames: Map<i, canvas>, used, state: 'new'|'queued'|'making'|'done', prio }
let kept = 0;
let making = 0;
let onFrame = () => {};
let busy = false; // the timeline is playing: strips wait, so they never take decoding away from playback
const MAKERS = new Set(); // { hold(), go() } of each strip being made

/** What to call when a new frame is kept (the center redraws). */
export function onFrames(fn) { onFrame = fn; }

/** Seconds between kept frames for a file this long: about 48 a clip, between 8 a second and 1 a second. */
export const stepFor = (dur) => Math.min(1, Math.max(1 / 8, (Number.isFinite(dur) && dur > 0 ? dur : 6) / 48));

function stripOf(asset) {
  let s = STRIPS.get(asset);
  if (!s) { s = { step: 0, dur: 0, w: 0, h: 0, frames: new Map(), used: 0, state: 'new', prio: Infinity }; STRIPS.set(asset, s); }
  return s;
}
function sized(s, el) {
  if (!s.step && Number.isFinite(el.duration) && el.duration > 0) { s.dur = el.duration; s.step = stepFor(el.duration); }
  if (!s.w && el.videoWidth) { s.w = el.videoWidth; s.h = el.videoHeight; }
  return Boolean(s.step && s.w);
}

/** Copies the frame a video element shows now (at its currentTime) into its asset's strip, if that slot is empty. */
export function keep(asset, el, at = el.currentTime) {
  if (!asset || !el || el.readyState < 2 || el.seeking || !el.videoWidth) return false;
  const s = stripOf(asset);
  if (!sized(s, el)) return false;
  const i = Math.round(at / s.step);
  if (s.frames.has(i)) return false;
  try {
    const k = Math.min(1, WIDTH / s.w);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(s.w * k)); cv.height = Math.max(1, Math.round(s.h * k));
    cv.getContext('2d').drawImage(el, 0, 0, cv.width, cv.height);
    s.frames.set(i, cv);
    kept++;
  } catch { return false; }
  s.used = performance.now();
  if (kept > BUDGET) trim(asset);
  onFrame();
  return true;
}

/** Over budget: let go of whole strips, the longest-unused first, never the one just added to. */
function trim(keepAsset) {
  const order = [...STRIPS.entries()].filter(([a, s]) => a !== keepAsset && s.frames.size).sort((a, b) => a[1].used - b[1].used);
  for (const [, s] of order) {
    if (kept <= BUDGET * 0.85) break;
    kept -= s.frames.size;
    s.frames.clear();
    if (s.state === 'done') s.state = 'new'; // made again if it's wanted again
  }
}

/** The kept frame nearest `at` seconds into the file: { el, w, h, at } (w, h: the video's own size), or null. */
export function nearest(asset, at) {
  const s = STRIPS.get(asset);
  if (!s || !s.frames.size || !s.step) return null;
  const want = Math.round(Math.max(0, at) / s.step);
  const last = Math.ceil(s.dur / s.step) + 1;
  for (let d = 0; d <= last; d++) {
    const f = s.frames.get(want - d) ?? s.frames.get(want + d);
    if (f) { s.used = performance.now(); return { el: f, w: s.w, h: s.h, at: (s.frames.has(want - d) ? want - d : want + d) * s.step }; }
  }
  return null;
}

/** While the timeline plays, strips being made wait (pausing their hidden copies), and none start; then carry on. */
export function setBusy(on) {
  if (busy === Boolean(on)) return;
  busy = Boolean(on);
  for (const m of MAKERS) busy ? m.hold() : m.go();
  if (!busy) pump();
}

/** The videos the scene uses, nearest the playhead first: each gets a strip in the background, a few at a time. */
export function warm(list) {
  for (const s of STRIPS.values()) s.prio = Infinity;
  for (const { asset, dist } of list) { const s = stripOf(asset); s.prio = Math.min(s.prio, dist); if (s.state === 'new') s.state = 'queued'; }
  pump();
}
function pump() {
  while (!busy && making < WORKERS) {
    const next = [...STRIPS.entries()].filter(([, s]) => s.state === 'queued' && s.prio < Infinity).sort((a, b) => a[1].prio - b[1].prio)[0];
    if (!next) return;
    next[1].state = 'making';
    making++;
    make(next[0], next[1]).catch(() => {}).finally(() => { next[1].state = 'done'; making--; setTimeout(pump, 0); });
  }
}

/** One video into its strip: a fast muted pass that copies frames as they show, then seeks for any slots it skipped. */
function make(asset, s) {
  return new Promise((resolve) => {
    const el = document.createElement('video');
    el.muted = true; el.defaultMuted = true; el.playsInline = true; el.preload = 'auto';
    el.setAttribute('muted', ''); el.setAttribute('playsinline', ''); el.crossOrigin = 'use-credentials';
    let last = performance.now(), timer = 0, over = false, gaps = null, waiting = false, passing = false;
    const ctl = {
      hold() { if (passing && !el.paused) el.pause(); },
      go() { last = performance.now(); if (passing && !gaps) el.play().catch(() => fill()); if (waiting) { waiting = false; fill(); } },
    };
    MAKERS.add(ctl);
    const finish = () => {
      if (over) return;
      over = true;
      MAKERS.delete(ctl);
      clearInterval(timer);
      el.pause();
      el.removeAttribute('src');
      try { el.load(); } catch { /* */ }
      resolve();
    };
    const grab = (at) => { if (keep(asset, el, at)) last = performance.now(); };
    // Slots the pass skipped: seek to each, in order.
    const fill = () => {
      if (over) return;
      if (busy) { waiting = true; return; }
      passing = false;
      if (!gaps) {
        gaps = [];
        const n = Math.ceil(s.dur / s.step);
        for (let i = 0; i <= n; i++) if (!s.frames.has(i)) gaps.push(i);
      }
      const i = gaps.shift();
      if (i == null || STRIPS.get(asset) !== s || (!s.frames.size && i > 0)) return finish();
      el.currentTime = Math.min(Math.max(0, s.dur - 0.05), i * s.step + 0.001);
    };
    el.addEventListener('seeked', () => { grab(); if (gaps) fill(); });
    el.addEventListener('error', finish);
    el.addEventListener('ended', () => { grab(); fill(); });
    el.addEventListener('loadeddata', () => {
      if (!sized(s, el)) return finish();
      grab();
      // The pass: fast enough that a frame shows about every slot, never faster than browsers allow.
      el.playbackRate = Math.min(16, Math.max(2, s.step * 60 * 0.8));
      const rvfc = typeof el.requestVideoFrameCallback === 'function';
      if (rvfc) {
        const each = (_, md) => { if (over || gaps) return; grab(md?.mediaTime); el.requestVideoFrameCallback(each); };
        el.requestVideoFrameCallback(each);
      }
      // No frame callbacks, or playing isn't allowed (a phone saving power): seek slot by slot instead.
      if (!rvfc) return fill();
      passing = true;
      if (!busy) el.play().catch(() => fill());
    });
    timer = setInterval(() => {
      if (over) return;
      if (busy) { last = performance.now(); return; }
      if (performance.now() - last > STALL) { if (!gaps && s.step) { el.pause(); fill(); last = performance.now(); } else finish(); }
    }, 250);
    el.src = fileUrl(asset);
    try { el.load(); } catch { /* */ }
  });
}
