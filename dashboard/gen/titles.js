// Title presets: styled, animated words for the timeline (the Create pane's Titles section). A title is a text clip with
// `title` set to a preset id; the clip's own text, text2 (the second line: a role, a subtitle, a credit), color, accent,
// font, weight, size, box and animIn / animOut (seconds) are what the Inspector edits. Everything here is plain maths
// and canvas calls (no DOM), so the preview (player.js draw), the export (the browser records that same draw) and the
// tests (test/titles.test.ts, with a recording context) all run this one file. src/titles.ts lists the same ids for the
// server (the AI editor's `title` op); a test keeps the two in step.
//
// Rules every preset follows:
//  - Safe area: at rest the words and their plate sit inside titleSafe() (5% in from each side; a tall frame also keeps
//    the bottom 12% clear for a phone's own buttons). A frame position the person sets (x, y) only moves it inside.
//  - Auto-scale: sizes are shares of titleUnit() (the frame's height, but at most 3/4 of its width), so a 9:16 title is
//    sized for a phone and wrapped to the width; words that still don't fit shrink until they do.
//  - In and out: `pin` goes 0..1 over animIn, `pout` 0..1 over the last animOut seconds. Moves stay small and always
//    inside the frame, with a fade, so a clip never pops and never leaves the picture.

export const TITLE_PRESETS = [
  { id: 'big-title', label: 'Big title', about: 'A large centred title that scales in and fades out, with an optional subtitle.', length: 4, animIn: 0.7, animOut: 0.5, size: 0.13, weight: 800, sub: 'Subtitle (optional)', sample: { text: 'Your title', text2: '' } },
  { id: 'lower-third', label: 'Lower third', about: 'A name and a role on a plate in the bottom corner; the plate wipes in and out.', length: 4, animIn: 0.6, animOut: 0.45, size: 0.055, weight: 800, sub: 'Role', sample: { text: 'Alex Rivera', text2: 'Director of photography' } },
  { id: 'caption-bar', label: 'Caption bar', about: 'A bar across the bottom with one or two lines; it slides up and back down.', length: 3, animIn: 0.35, animOut: 0.3, size: 0.04, weight: 600, sub: null, sample: { text: 'Say what is happening in a line or two.', text2: '' } },
  { id: 'kinetic', label: 'Kinetic words', about: 'The words pop in one at a time, then fade away together.', length: 3.5, animIn: 0.38, animOut: 0.4, size: 0.1, weight: 900, sub: null, sample: { text: 'Make every word land', text2: '' } },
  { id: 'end-card', label: 'End card', about: 'Dims the picture and fades up a closing line with a credit under it.', length: 5, animIn: 0.8, animOut: 0.8, size: 0.09, weight: 800, sub: 'Credit line', sample: { text: 'Thanks for watching', text2: 'Made with Hawkes Gen' } },
  { id: 'corner-label', label: 'Corner label', about: 'A small, quiet label in the top corner: a place, a chapter, a date.', length: 4, animIn: 0.4, animOut: 0.35, size: 0.032, weight: 600, sub: null, sample: { text: 'Chapter 1 · The harbour', text2: '' } },
];
const BY_ID = new Map(TITLE_PRESETS.map((p) => [p.id, p]));
export const titlePreset = (id) => BY_ID.get(id) ?? null;

/** The tallest the words' unit goes: the frame's height, but at most 3/4 of its width (a tall frame is sized by its width). */
export const titleUnit = (W, H) => Math.min(H, W * 0.75);
/** The area words rest in, in the scene's pixels. */
export function titleSafe(W, H) {
  const x = W * 0.05, y = H * 0.05, bottom = H > W ? H * 0.12 : H * 0.05;
  return { x, y, w: W - x * 2, h: H - y - bottom };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);
const easeOut = (k) => 1 - (1 - k) ** 3;
const easeIn = (k) => k * k * k;
const easeBack = (k) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2; };

/** The clip's length in seconds (stills: out - in). */
const lengthOf = (c) => Math.max(0.04, (c.out ?? 3) - (c.in ?? 0));

/** In and out durations for this clip, never more than 40% of its length each. */
export function titleTiming(c) {
  const p = titlePreset(c.title);
  const len = lengthOf(c);
  const d = (v, def) => clamp(Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : def, 0, len * 0.4);
  return { len, inD: d(c.animIn, p?.animIn ?? 0.5), outD: d(c.animOut, p?.animOut ?? 0.4) };
}
/** Where the animation is at scene time t: eased in (pin) and out (pout), the clip's own time, its length, and linear in. */
export function titleProgress(c, t) {
  const { len, inD, outD } = titleTiming(c);
  const lt = clamp(t - c.start, 0, len);
  return {
    len, lt, inD, outD,
    lin: inD > 0 ? clamp01(lt / inD) : 1,
    pin: inD > 0 ? easeOut(clamp01(lt / inD)) : 1,
    pout: outD > 0 ? easeIn(clamp01((lt - (len - outD)) / outD)) : 0,
  };
}

const FACE = (c, p, px, weight) => `${weight ?? c.weight ?? p.weight} ${px}px "${c.font ?? 'Inter'}", Inter, system-ui, sans-serif`;

/** Words wrapped to a width, shrunk until they fit it and the height: { px, lines, w, h }. */
function fitText(ctx, text, fontAt, px0, maxW, maxH, lh = 1.16) {
  let px = Math.max(6, px0), lines = [], w = 0, h = 0;
  for (let i = 0; i < 60; i++) {
    ctx.font = fontAt(px);
    lines = [];
    for (const para of String(text ?? '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = word; } else line = next;
      }
      lines.push(line);
    }
    w = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
    h = lines.length * px * lh;
    if ((w <= maxW + 0.5 && h <= maxH + 0.5) || px <= 8) break;
    px *= 0.93;
  }
  return { px, lines, w, h, lh };
}
/** Where a w x h block goes: its default top-left, or around the clip's own x, y (their center); kept in the safe area. */
function place(E, c, w, h, defX, defY) {
  const { S, W, H } = E;
  const x = c.x != null ? c.x * W - w / 2 : defX, y = c.y != null ? c.y * H - h / 2 : defY;
  return { x: clamp(x, S.x, Math.max(S.x, S.x + S.w - w)), y: clamp(y, S.y, Math.max(S.y, S.y + S.h - h)) };
}
const rrect = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
const shadow = (ctx, px) => { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = px * 0.22; ctx.shadowOffsetY = px * 0.04; };
const noShadow = (ctx) => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; };
/** Lines of text at x (by align), the first line's center at y0. */
function lines(ctx, f, x, y0, color, align, a = 1) {
  if (a <= 0.002) return;
  ctx.save();
  ctx.globalAlpha *= a; ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = align;
  f.lines.forEach((l, i) => { ctx.font = f.font; ctx.fillText(l, x, y0 + (i + 0.5) * f.px * f.lh); });
  ctx.restore();
}
const withFont = (f, font) => ({ ...f, font });

// ------------------------------------------------------------------ the presets: layout (measured) and paint (animated)
const PRESETS = {
  'big-title': {
    layout(ctx, c, E) {
      const { p, u, S } = E, px = (c.size ?? p.size) * u, maxW = S.w * 0.94;
      const main = fitText(ctx, c.text, (n) => FACE(c, p, n), px, maxW, S.h * 0.62);
      const sub = c.text2 ? fitText(ctx, c.text2, (n) => FACE(c, p, n, 400), main.px * 0.34, maxW, S.h * 0.2) : null;
      const gap = sub ? main.px * 0.3 : 0, w = Math.max(main.w, sub?.w ?? 0), h = main.h + (sub ? gap + sub.h : 0);
      const at = place(E, c, w, h, S.x + (S.w - w) / 2, S.y + (S.h - h) / 2);
      return { main: withFont(main, FACE(c, p, main.px)), sub: sub && withFont(sub, FACE(c, p, sub.px, 400)), gap, box: { x: at.x, y: at.y, w, h } };
    },
    paint(ctx, c, L, A) {
      const b = L.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const a = A.pin * (1 - A.pout), s = 0.9 + 0.1 * A.pin + 0.05 * A.pout;
      ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy + (1 - A.pin) * L.main.px * 0.12);
      shadow(ctx, L.main.px);
      lines(ctx, L.main, cx, b.y, c.color ?? '#ffffff', 'center', a);
      if (L.sub) lines(ctx, L.sub, cx, b.y + L.main.h + L.gap, c.color ?? '#ffffff', 'center', a * 0.82);
      ctx.restore();
    },
  },

  'lower-third': {
    layout(ctx, c, E) {
      const { p, u, S, W } = E, px = (c.size ?? p.size) * u, padX = px * 0.6, padY = px * 0.4, bar = Math.max(3, px * 0.12);
      const maxW = Math.max(px, (H_IS_TALL(E) ? S.w : Math.min(S.w, W * 0.62)) - padX * 2 - bar);
      const name = fitText(ctx, c.text, (n) => FACE(c, p, n), px, maxW, px * 2.4);
      const role = c.text2 ? fitText(ctx, c.text2, (n) => FACE(c, p, n, 500), name.px * 0.58, maxW, name.px * 1.3) : null;
      const gap = role ? name.px * 0.18 : 0, inner = Math.max(name.w, role?.w ?? 0);
      const w = bar + padX + inner + padX, h = padY * 2 + name.h + gap + (role?.h ?? 0), right = c.align === 'right';
      const at = place(E, c, w, h, right ? S.x + S.w - w : S.x, S.y + S.h - h - (H_IS_TALL(E) ? 0 : S.h * 0.04));
      return { name: withFont(name, FACE(c, p, name.px)), role: role && withFont(role, FACE(c, p, role.px, 500)), gap, padX, padY, bar, right, box: { x: at.x, y: at.y, w, h } };
    },
    paint(ctx, c, L, A) {
      const b = L.box, k = L.right ? -1 : 1;
      // The plate wipes open from its anchored side, and wipes shut the same way on the way out.
      const x0 = L.right ? b.x + b.w - b.w * A.pin : b.x + b.w * A.pout, x1 = L.right ? b.x + b.w - b.w * A.pout : b.x + b.w * A.pin;
      if (x1 - x0 < 0.5) return;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, b.y - 2, x1 - x0, b.h + 4); ctx.clip();
      ctx.fillStyle = c.box ?? 'rgba(0,0,0,.62)'; rrect(ctx, b.x, b.y, b.w, b.h, L.name.px * 0.18); ctx.fill();
      ctx.fillStyle = c.accent ?? '#ffffff'; ctx.fillRect(L.right ? b.x + b.w - L.bar : b.x, b.y, L.bar, b.h);
      const ta = clamp01((A.pin - 0.35) / 0.65) * (1 - clamp01(A.pout * 2)), dx = (1 - clamp01((A.pin - 0.35) / 0.65)) * L.name.px * 0.7 * k;
      const tx = L.right ? b.x + b.w - L.bar - L.padX : b.x + L.bar + L.padX, al = L.right ? 'right' : 'left';
      lines(ctx, L.name, tx + dx, b.y + L.padY, c.color ?? '#ffffff', al, ta);
      if (L.role) lines(ctx, L.role, tx + dx, b.y + L.padY + L.name.h + L.gap, c.color ?? '#ffffff', al, ta * 0.85);
      ctx.restore();
    },
  },

  'caption-bar': {
    layout(ctx, c, E) {
      const { p, u, S } = E, px = (c.size ?? p.size) * u, padX = px * 0.8, padY = px * 0.45;
      const f = fitText(ctx, c.text, (n) => FACE(c, p, n), px, S.w - padX * 2, px * 2.5);
      const h = f.h + padY * 2, at = place(E, c, S.w, h, S.x, S.y + S.h - h);
      return { f: withFont(f, FACE(c, p, f.px)), padX, padY, shift: px, box: { x: S.x, y: at.y, w: S.w, h } };
    },
    paint(ctx, c, L, A) {
      const b = L.box, a = A.pin * (1 - A.pout), dy = (1 - A.pin + A.pout) * L.shift;
      ctx.save(); ctx.translate(0, dy);
      ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = c.box ?? 'rgba(0,0,0,.66)'; rrect(ctx, b.x, b.y, b.w, b.h, L.f.px * 0.3); ctx.fill(); ctx.restore();
      lines(ctx, L.f, b.x + b.w / 2, b.y + L.padY, c.color ?? '#ffffff', 'center', a);
      ctx.restore();
    },
  },

  kinetic: {
    layout(ctx, c, E) {
      const { p, u, S } = E, px = (c.size ?? p.size) * u;
      const f = fitText(ctx, c.text, (n) => FACE(c, p, n), px, S.w * 0.94, S.h * 0.7, 1.12);
      ctx.font = FACE(c, p, f.px);
      const space = ctx.measureText(' ').width, words = [];
      let n = 0;
      const at = place(E, c, f.w, f.h, S.x + (S.w - f.w) / 2, S.y + (S.h - f.h) / 2);
      f.lines.forEach((line, row) => {
        const parts = line.split(' ').filter(Boolean), ws = parts.map((s) => ctx.measureText(s).width);
        let x = at.x + (f.w - (ws.reduce((m, v) => m + v, 0) + space * Math.max(0, parts.length - 1))) / 2;
        parts.forEach((s, i) => { words.push({ s, x, y: at.y + (row + 0.5) * f.px * f.lh, w: ws[i], i: n++ }); x += ws[i] + space; });
      });
      return { f: withFont(f, FACE(c, p, f.px)), words, box: { x: at.x, y: at.y, w: f.w, h: f.h } };
    },
    paint(ctx, c, L, A) {
      const n = Math.max(1, L.words.length), step = clamp((A.len - A.outD - 0.45) / n, 0.07, 0.28), fade = 1 - A.pout;
      ctx.save(); ctx.font = L.f.font; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillStyle = c.color ?? '#ffffff'; shadow(ctx, L.f.px);
      for (const w of L.words) {
        const k = clamp01((A.lt - w.i * step) / 0.38);
        if (k <= 0 || fade <= 0) continue;
        const e = easeBack(k), s = 0.55 + 0.45 * e, cx = w.x + w.w / 2;
        ctx.save(); ctx.globalAlpha *= clamp01(k * 2) * fade; ctx.translate(cx, w.y + (1 - e) * L.f.px * 0.35); ctx.scale(s, s); ctx.fillText(w.s, 0, 0); ctx.restore();
      }
      ctx.restore();
    },
  },

  'end-card': {
    layout(ctx, c, E) {
      const { p, u, S } = E, px = (c.size ?? p.size) * u, maxW = S.w * 0.9;
      const main = fitText(ctx, c.text, (n) => FACE(c, p, n), px, maxW, S.h * 0.5);
      const sub = c.text2 ? fitText(ctx, c.text2, (n) => FACE(c, p, n, 400), main.px * 0.42, maxW, S.h * 0.2) : null;
      const rule = u * 0.14, gap = main.px * 0.3, w = Math.max(main.w, sub?.w ?? 0, sub ? rule : 0);
      const h = main.h + (sub ? gap * 2 + u * 0.004 + sub.h : 0);
      const at = place(E, c, w, h, S.x + (S.w - w) / 2, S.y + (S.h - h) / 2);
      return { main: withFont(main, FACE(c, p, main.px)), sub: sub && withFont(sub, FACE(c, p, sub.px, 400)), rule, gap, thick: Math.max(2, u * 0.004), box: { x: at.x, y: at.y, w, h } };
    },
    paint(ctx, c, L, A, E) {
      const b = L.box, cx = b.x + b.w / 2, fade = 1 - A.pout;
      ctx.save(); ctx.globalAlpha *= 0.76 * A.pin * fade; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, E.W, E.H); ctx.restore();
      shadow(ctx, L.main.px);
      lines(ctx, L.main, cx, b.y, c.color ?? '#ffffff', 'center', clamp01(A.lin * 1.6) * fade);
      if (L.sub) {
        noShadow(ctx);
        const ry = b.y + L.main.h + L.gap, grow = clamp01((A.lin - 0.3) / 0.4);
        ctx.save(); ctx.globalAlpha *= fade; ctx.fillStyle = c.accent ?? '#ffffff'; ctx.fillRect(cx - (L.rule * grow) / 2, ry, L.rule * grow, L.thick); ctx.restore();
        lines(ctx, L.sub, cx, ry + L.thick + L.gap, c.color ?? '#ffffff', 'center', clamp01((A.lin - 0.5) / 0.5) * fade * 0.85);
      }
    },
  },

  'corner-label': {
    layout(ctx, c, E) {
      const { p, u, S } = E, px = (c.size ?? p.size) * u, padX = px * 0.7, padY = px * 0.5, dot = px * 0.34, right = c.align === 'right';
      const f = fitText(ctx, c.text, (n) => FACE(c, p, n), px, (H_IS_TALL(E) ? S.w * 0.8 : S.w * 0.5) - padX * 2 - dot - px * 0.5, px * 2.4);
      const w = padX + dot + px * 0.5 + f.w + padX, h = f.h + padY * 2;
      const at = place(E, c, w, h, right ? S.x + S.w - w : S.x, S.y);
      return { f: withFont(f, FACE(c, p, f.px)), padX, padY, dot, right, shift: u * 0.03, box: { x: at.x, y: at.y, w, h } };
    },
    paint(ctx, c, L, A) {
      const b = L.box, a = A.pin * (1 - A.pout), dx = (L.right ? 1 : -1) * (1 - A.pin + A.pout) * L.shift;
      ctx.save(); ctx.translate(dx, 0);
      ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = c.box ?? 'rgba(0,0,0,.5)'; rrect(ctx, b.x, b.y, b.w, b.h, b.h / 2); ctx.fill();
      ctx.fillStyle = c.accent ?? '#ffffff'; ctx.beginPath(); ctx.arc(b.x + L.padX + L.dot / 2, b.y + b.h / 2, L.dot / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      lines(ctx, L.f, b.x + L.padX + L.dot + L.f.px * 0.5, b.y + L.padY, c.color ?? '#ffffff', 'left', a);
      ctx.restore();
    },
  },
};
function H_IS_TALL(E) { return E.H > E.W; }

// ------------------------------------------------------------------ drawing
const CACHE = new Map();
export const clearTitleCache = () => CACHE.clear();
const keyOf = (c, W, H) => [c.id, c.title, c.text, c.text2, c.size, c.weight, c.font, c.align, c.x, c.y, c.box, c.color, c.accent, W, H].join('|');
function env(c, W, H) { return { p: titlePreset(c.title), W, H, u: titleUnit(W, H), S: titleSafe(W, H) }; }
/** The measured layout of a title (cached by what decides it). Null when the clip names no preset. */
export function titleLayout(ctx, c, W, H) {
  const p = titlePreset(c?.title);
  if (!p) return null;
  const key = keyOf(c, W, H), hit = CACHE.get(c.id);
  if (hit?.key === key) return hit.L;
  const E = env(c, W, H), L = PRESETS[p.id].layout(ctx, c, E);
  if (CACHE.size > 200) CACHE.clear();
  CACHE.set(c.id, { key, L });
  return L;
}
/** A title's box on the frame (its center and size, at rest), for the canvas handles. */
export function titleBox(ctx, c, W, H) {
  const L = titleLayout(ctx, c, W, H);
  return L && { x: L.box.x + L.box.w / 2, y: L.box.y + L.box.h / 2, w: L.box.w, h: L.box.h };
}
/** Paints the title at scene time t onto ctx (scene pixels, no transform set). The caller sets alpha and blend. */
export function drawTitle(ctx, c, t, W, H) {
  const L = titleLayout(ctx, c, W, H);
  if (!L) return false;
  const A = titleProgress(c, t), E = env(c, W, H);
  ctx.save();
  PRESETS[c.title].paint(ctx, c, L, A, E);
  ctx.restore();
  return true;
}
if (typeof document !== 'undefined') document.fonts?.addEventListener?.('loadingdone', clearTitleCache);

/** Whether to show the preset's animated preview as a live loop: its time at wall-clock seconds `s`. */
export const previewTime = (p, s) => { const len = p.length; return (s % (len + 0.6)); };
