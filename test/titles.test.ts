// Title presets: the shared maths (dashboard/gen/titles.js) drawn on a recording context at 16:9, 9:16 and 1:1, the
// ops that add and change them (applyOps) and the server's list staying in step with the browser's.
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain browser module
import { TITLE_PRESETS as BROWSER, titleSafe, titleUnit, titleProgress, titleTiming, drawTitle, titleLayout, clearTitleCache } from '../dashboard/gen/titles.js';
import { TITLE_PRESETS as SERVER, isTitlePreset, titleDoc } from '../src/titles.ts';
import { applyOps, newDoc, normalize } from '../src/timeline.ts';

/** A canvas context that records where ink goes: every fillText and fillRect, through translate, scale and clip-free. */
function recorder() {
  let font = '16px x', m = [1, 0, 0, 1, 0, 0], stack: any[] = [], alpha = 1, clipR: number[] | null = null, pend: number[] | null = null;
  const rects: { x0: number; y0: number; x1: number; y1: number; a: number }[] = [];
  const px = () => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
  const pt = (x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const add = (xa: number, ya: number, xb: number, yb: number) => {
    const p = pt(xa, ya), q = pt(xb, yb);
    let r = { x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]), a: alpha };
    if (clipR) { r = { ...r, x0: Math.max(r.x0, clipR[0]), y0: Math.max(r.y0, clipR[1]), x1: Math.min(r.x1, clipR[2]), y1: Math.min(r.y1, clipR[3]) }; if (r.x1 <= r.x0 || r.y1 <= r.y0) return; }
    rects.push(r);
  };
  const g: any = {
    rects, textAlign: 'left', textBaseline: 'middle', fillStyle: '', shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    get font() { return font; }, set font(v) { font = v; },
    get globalAlpha() { return alpha; }, set globalAlpha(v) { alpha = v; },
    measureText: (s: string) => ({ width: s.length * px() * 0.55 }),
    save() { stack.push([m.slice(), alpha, clipR]); }, restore() { [m, alpha, clipR] = stack.pop(); },
    translate(x: number, y: number) { m = [m[0], m[1], m[2], m[3], m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; },
    scale(a: number, d: number) { m = [m[0] * a, m[1] * a, m[2] * d, m[3] * d, m[4], m[5]]; },
    fillText(s: string, x: number, y: number) { const w = s.length * px() * 0.55 * Math.abs(m[0]), l = g.textAlign === 'center' ? x - w / 2 / Math.abs(m[0]) : g.textAlign === 'right' ? x - w / Math.abs(m[0]) : x; const hh = px(); add(l, y - hh / 2, l + (w / Math.abs(m[0])), y + hh / 2); },
    fillRect(x: number, y: number, w: number, h: number) { add(x, y, x + w, y + h); },
    closePath() {},
    rect(x: number, y: number, w: number, h: number) { const a = pt(x, y), b = pt(x + w, y + h); pend = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; },
    clip() { if (pend) clipR = clipR ? [Math.max(clipR[0], pend[0]), Math.max(clipR[1], pend[1]), Math.min(clipR[2], pend[2]), Math.min(clipR[3], pend[3])] : pend; },
    fill() { /* rounded plates are drawn by path: the plate is recorded through its box below */ },
  };
  // A path fill (the plates): take the path's extent from moveTo/arcTo points.
  const pts: number[][] = [];
  g.beginPath = () => { pts.length = 0; };
  g.moveTo = (x: number, y: number) => pts.push([x, y]);
  g.arcTo = (x: number, y: number) => pts.push([x, y]);
  g.arc = (x: number, y: number, r: number) => pts.push([x - r, y - r], [x + r, y + r]);
  g.fill = () => { if (pts.length) add(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))); };
  return g;
}
const extent = (rects: any[], minAlpha = 0.02) => {
  const r = rects.filter((x) => x.a > minAlpha);
  return r.length ? { x0: Math.min(...r.map((x) => x.x0)), y0: Math.min(...r.map((x) => x.y0)), x1: Math.max(...r.map((x) => x.x1)), y1: Math.max(...r.map((x) => x.y1)) } : null;
};
const SIZES = [[1920, 1080], [1080, 1920], [1080, 1080], [720, 1280]] as const;
const LONG = 'Doctor Alexandra Rivera-Montgomery of the Northern Harbour Authority';
let n = 0;
const clipFor = (p: any, text: string, text2: string) => ({ id: `t${n++}`, kind: 'text', title: p.id, text, text2, start: 0, in: 0, out: p.length });

test('the server lists the same presets as the browser, at least six', () => {
  assert.ok(BROWSER.length >= 6);
  assert.deepEqual(SERVER.map((p) => p.id), BROWSER.map((p: any) => p.id));
  for (const p of BROWSER) {
    const s = SERVER.find((x) => x.id === p.id)!;
    assert.equal(s.length, p.length); assert.equal(s.animIn, p.animIn); assert.equal(s.animOut, p.animOut);
    assert.equal(s.sample, p.sample.text); assert.equal(s.sample2, p.sample.text2);
  }
  assert.ok(isTitlePreset('lower-third') && !isTitlePreset('nope'));
  assert.ok(titleDoc().includes('kinetic'));
});

test('every preset rests inside the safe area and never touches the frame while animating, at every shape', () => {
  for (const [W, H] of SIZES) for (const p of BROWSER) for (const [text, text2] of [[p.sample.text, p.sample.text2], [LONG, 'A second line that is also much too long to fit on one line of a phone']]) {
    clearTitleCache();
    const c = clipFor(p, text, text2), S = titleSafe(W, H);
    const ctx = recorder();
    // At rest: the middle of the clip.
    drawTitle(ctx, c, c.out / 2, W, H);
    const rest = extent(ctx.rects)!;
    assert.ok(rest, `${p.id} drew nothing at rest`);
    // The end card's dimmer covers the frame on purpose; its words are what the safe area is for.
    const words = extent(ctx.rects.filter((r: any) => !(r.x0 <= 0 && r.y0 <= 0 && r.x1 >= W && r.y1 >= H)))!;
    const tol = 1.5;
    assert.ok(words.x0 >= S.x - tol && words.x1 <= S.x + S.w + tol && words.y0 >= S.y - tol && words.y1 <= S.y + S.h + tol, `${p.id} ${W}x${H} leaves the safe area: ${JSON.stringify(words)} vs ${JSON.stringify(S)}`);
    for (let i = 0; i <= 40; i++) {
      const g = recorder();
      drawTitle(g, c, (c.out * i) / 40, W, H);
      const e = extent(g.rects.filter((r: any) => !(r.x0 <= 0 && r.y0 <= 0 && r.x1 >= W && r.y1 >= H)));
      if (e) assert.ok(e.x0 >= 0 && e.y0 >= 0 && e.x1 <= W && e.y1 <= H, `${p.id} ${W}x${H} t=${i}/40 leaves the frame: ${JSON.stringify(e)}`);
    }
  }
});

test('titles are readable on a vertical frame: sized from the width, not the tall height', () => {
  assert.equal(titleUnit(1920, 1080), 1080);
  assert.equal(titleUnit(1080, 1920), 810);
  const p = BROWSER.find((x: any) => x.id === 'big-title');
  const wide = titleLayout(recorder(), clipFor(p, 'Title', ''), 1920, 1080), tall = titleLayout(recorder(), clipFor(p, 'Title', ''), 1080, 1920);
  assert.ok(tall.main.px / 1080 > wide.main.px / 1920, 'a tall title is a larger share of the width');
  assert.ok(titleSafe(1080, 1920).y + titleSafe(1080, 1920).h <= 1920 * 0.9, 'a tall frame keeps its bottom clear');
});

test('in and out: the title is hidden before it starts, full at rest, and gone at the end', () => {
  const p = BROWSER.find((x: any) => x.id === 'lower-third');
  const c = clipFor(p, 'Alex', 'Role');
  const at = (t: number) => { const g = recorder(); drawTitle(g, c, t, 1920, 1080); const e = extent(g.rects, 0.01); return e ? (e.x1 - e.x0) * (e.y1 - e.y0) : 0; };
  assert.equal(at(0), 0);
  assert.ok(at(0.15) > 0 && at(0.15) < at(c.out / 2));
  assert.ok(at(c.out - 0.15) < at(c.out / 2));
  const pr = titleProgress(c, c.out / 2);
  assert.equal(pr.pin, 1); assert.equal(pr.pout, 0);
  assert.equal(titleProgress(c, c.out).pout, 1);
});

test('animIn and animOut are editable and capped at 40% of the clip', () => {
  const p = BROWSER[0];
  const c: any = { ...clipFor(p, 'x', ''), animIn: 9, animOut: 0 };
  const t = titleTiming(c);
  assert.ok(Math.abs(t.inD - c.out * 0.4) < 1e-9);
  assert.equal(t.outD, 0);
  assert.equal(titleProgress(c, c.out - 0.01).pout, 0);
});

test('the title op adds a preset clip on the text track with its defaults; set changes or clears it', () => {
  const d = newDoc('t', 'video');
  const r = applyOps(d, [{ op: 'title', preset: 'lower-third', text: 'Ana Ruiz', text2: 'Producer', start: 2 }, { op: 'title', preset: 'end-card', start: 9 }, { op: 'title', preset: 'bogus' }]);
  assert.equal(r.results[0].ok, true); assert.equal(r.results[1].ok, true); assert.equal(r.results[2].ok, false);
  const a = r.doc.clips.find((c) => c.id === r.results[0].id)!, b = r.doc.clips.find((c) => c.id === r.results[1].id)!;
  assert.equal(a.kind, 'text'); assert.equal(a.title, 'lower-third'); assert.equal(a.text, 'Ana Ruiz'); assert.equal(a.text2, 'Producer'); assert.equal(a.start, 2); assert.equal(a.out - a.in, 4);
  assert.equal(r.doc.tracks.find((t) => t.id === a.track)?.role, 'text');
  assert.equal(b.text, 'Thanks for watching'); assert.equal(b.text2, 'Made with Hawkes Gen'); assert.equal(b.out - b.in, 5);
  const s = applyOps(r.doc, [{ op: 'set', id: a.id, title: 'corner-label', text2: null, color: '#ffcc00', accent: '#ff0000', animIn: 0.8 }, { op: 'set', id: b.id, title: null }]);
  const a2 = s.doc.clips.find((c) => c.id === a.id)!, b2 = s.doc.clips.find((c) => c.id === b.id)!;
  assert.equal(a2.title, 'corner-label'); assert.equal(a2.text2, undefined); assert.equal(a2.color, '#ffcc00'); assert.equal(a2.accent, '#ff0000'); assert.equal(a2.animIn, 0.8);
  assert.equal(b2.title, undefined);
  assert.equal(applyOps(r.doc, [{ op: 'set', id: a.id, title: 'nope' }]).results[0].ok, false);
});

test('a title survives normalize; an unknown preset is dropped to plain words', () => {
  const d = applyOps(newDoc('t', 'video'), [{ op: 'title', preset: 'kinetic', text: 'Go go go' }]).doc;
  const again = normalize(JSON.parse(JSON.stringify(d)), 'video');
  assert.equal(again.clips[0].title, 'kinetic');
  const bad = JSON.parse(JSON.stringify(d)); bad.clips[0].title = 'nope';
  assert.equal(normalize(bad, 'video').clips[0].title, undefined);
});
