// Delivery (docs/finishing.md): titles and end credits, captions (.vtt and .srt, soft or burned), the aspect ratios each
// platform wants (reframed so the subject stays in frame), thumbnails, trailers and the delivery sheet. Pure planning
// here; the tools in src/tools/finishing.ts run ffmpeg and Claude.

import { GenError } from '../util.ts';
import type { Caption } from '../tools/compose.ts';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------------------------------------ aspect ratios

/** The deliverables people pick: name -> ratio and the size it's delivered at. */
export const ASPECTS: Record<string, { w: number; h: number; width: number; height: number; for: string }> = {
  '16:9': { w: 16, h: 9, width: 1920, height: 1080, for: 'YouTube, the web, TVs' },
  '9:16': { w: 9, h: 16, width: 1080, height: 1920, for: 'Shorts, Reels, TikTok, Stories' },
  '1:1': { w: 1, h: 1, width: 1080, height: 1080, for: 'square feeds' },
  '4:5': { w: 4, h: 5, width: 1080, height: 1350, for: 'Instagram and Facebook feeds' },
};

/** Where the subject is: a point (0 to 1 of the frame) at a time. One point holds for the whole clip. */
export type SubjectKey = { t: number; x: number; y?: number };

export type Reframe = {
  aspect: string;
  /** The crop in source pixels (x may be an ffmpeg expression of t when the subject moves). */
  crop: { w: number; h: number; x: string; y: string };
  /** The delivered size (never larger than the crop scaled to the platform's size). */
  out: { width: number; height: number };
  filter: string;
  /** How the subject was found: positions given, faces found, or the centre. */
  source: 'subject' | 'faces' | 'center';
};

/**
 * The largest crop of `aspect` inside a srcW x srcH frame, panned to keep the subject in it. Subject keys are smoothed
 * (a pan never moves faster than `maxPan` of the frame per second) and become a piecewise-linear crop x(t).
 */
export function planReframe(srcW: number, srcH: number, aspect: string, keys: SubjectKey[] = [], o: { maxPan?: number; source?: Reframe['source']; maxOut?: number } = {}): Reframe {
  const a = ASPECTS[aspect];
  if (!a) throw new GenError(`aspect is one of ${Object.keys(ASPECTS).join(', ')}`);
  if (!(srcW > 0 && srcH > 0)) throw new GenError('The video has no picture size');
  const ratio = a.w / a.h;
  let w = srcW, h = srcH;
  if (srcW / srcH > ratio) w = even(Math.min(srcW, srcH * ratio));
  else h = even(Math.min(srcH, srcW / ratio));
  w = Math.min(w, srcW - (srcW % 2)); h = Math.min(h, srcH - (srcH % 2));
  const pts = keys.filter((k) => Number.isFinite(k.t) && Number.isFinite(k.x)).sort((p, q) => p.t - q.t);
  const xFor = (cx: number) => clamp(Math.round(cx * srcW - w / 2), 0, srcW - w);
  const yFor = (cy: number) => clamp(Math.round(cy * srcH - h / 2), 0, srcH - h);
  let x: string, y: string;
  if (pts.length <= 1) {
    x = String(pts.length ? xFor(pts[0].x) : Math.round((srcW - w) / 2));
    y = String(pts.length && pts[0].y != null ? yFor(pts[0].y!) : Math.round((srcH - h) / 2));
  } else {
    // Smooth: each step moves at most maxPan * frame width per second from the last.
    const maxPan = (o.maxPan ?? 0.25) * srcW;
    const xs: { t: number; x: number }[] = [];
    for (const p of pts) {
      const want = xFor(p.x);
      const prev = xs[xs.length - 1];
      if (!prev) { xs.push({ t: p.t, x: want }); continue; }
      const limit = maxPan * Math.max(0, p.t - prev.t);
      xs.push({ t: p.t, x: Math.round(clamp(want, prev.x - limit, prev.x + limit)) });
    }
    x = piecewise(xs);
    const ys = pts.filter((p) => p.y != null);
    y = String(ys.length ? yFor(ys.reduce((s, p) => s + p.y!, 0) / ys.length) : Math.round((srcH - h) / 2));
  }
  // Deliver at the platform's size (a 1080p source's 9:16 crop is scaled up 1.8x to 1080x1920, as platforms expect), but
  // never blown up past 2x: a small source gets a smaller file instead.
  const scale = Math.min(1, (w * 2) / a.width);
  const out = { width: even(a.width * scale), height: even(a.height * scale) };
  const filter = `crop=${w}:${h}:'${x}':'${y}',scale=${out.width}:${out.height}:flags=lanczos,setsar=1`;
  return { aspect, crop: { w, h, x, y }, out, filter, source: o.source ?? (pts.length ? 'subject' : 'center') };
}

/** An ffmpeg expression of t through the keys (held before the first and after the last). */
export function piecewise(keys: { t: number; x: number }[]): string {
  if (keys.length === 1) return String(keys[0].x);
  let expr = String(keys[keys.length - 1].x);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1];
    const dt = Math.max(0.001, b.t - a.t);
    const seg = a.x === b.x ? String(a.x) : `${a.x}+(${b.x - a.x})*(t-${r3(a.t)})/${r3(dt)}`;
    expr = `if(lt(t,${r3(b.t)}),${seg},${expr})`;
  }
  return `if(lt(t,${r3(keys[0].t)}),${keys[0].x},${expr})`;
}

/**
 * Subject keys from a stage shot: the cast's positions at times, projected to the frame by the caller as x in 0..1. The
 * centre of everyone on screen, so a two-shot keeps both people.
 */
export function subjectFromCast(frames: { t: number; xs: number[] }[]): SubjectKey[] {
  return frames.filter((f) => f.xs.length).map((f) => ({ t: f.t, x: (Math.min(...f.xs) + Math.max(...f.xs)) / 2 }));
}

// ------------------------------------------------------------------------------------------------ captions

/** Reads a .srt or .vtt file into captions. */
export function parseCaptions(text: string): Caption[] {
  const out: Caption[] = [];
  const time = (s: string) => {
    const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s.trim());
    if (!m) return NaN;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
  };
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim() && !/^WEBVTT/.test(l));
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = time(a), end = time(b.split(/\s+/).filter(Boolean)[0] ?? '');
    const words = lines.slice(i + 1).join('\n').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && words) out.push({ start: r3(start), end: r3(end), text: words });
  }
  return out;
}

/** Captions moved by `offset` seconds (a title card before the cut pushes them later), kept inside [0, length]. */
export function shiftCaptions(cs: Caption[], offset: number, length = Infinity): Caption[] {
  return cs.map((c) => ({ ...c, start: r3(c.start + offset), end: r3(Math.min(length, c.end + offset)) })).filter((c) => c.end - c.start >= 0.05 && c.start >= 0);
}

// ------------------------------------------------------------------------------------------------ titles and credits

export type CastLine = { character: string; voice?: string | null };

export type Credits = {
  title: string;
  subtitle?: string;
  /** Lines shown on the end card(s), in order. */
  lines: string[];
  madeWith: string;
};

export const MADE_WITH = 'Made with Hawkes Gen';

/** The title and end credits from the world and the story: the cast by character name, then the made-with line. */
export function planCredits(o: { title?: string; world?: string | null; story?: string | null; episode?: string | null; cast?: CastLine[]; by?: string | null; extra?: string[] }): Credits {
  const title = String(o.title ?? o.episode ?? o.story ?? o.world ?? 'Untitled').trim().slice(0, 80) || 'Untitled';
  const sub = [o.story && o.story !== title ? o.story : null, o.world && o.world !== title ? `A story of ${o.world}` : null].filter(Boolean).join(' · ');
  const lines: string[] = [];
  const cast = (o.cast ?? []).filter((c) => c.character?.trim());
  if (cast.length) {
    lines.push('Starring');
    for (const c of cast.slice(0, 30)) lines.push(c.character.trim().slice(0, 60));
    lines.push('');
  }
  if (o.by) lines.push(`Created by ${String(o.by).trim().slice(0, 60)}`, '');
  for (const e of (o.extra ?? []).slice(0, 20)) lines.push(String(e).slice(0, 80));
  return { title, ...(sub ? { subtitle: sub } : {}), lines: lines.filter((l, i, a) => l || (i > 0 && a[i - 1])), madeWith: MADE_WITH };
}

/** ASS escaping: braces start override blocks, backslashes escape; newlines become \N. */
export const assText = (s: string) => s.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/** An ASS script with one or more events on a width x height canvas (the title card, the credits, a thumbnail title). */
export function assScript(width: number, height: number, events: { start: number; end: number; text: string; style?: 'Title' | 'Sub' | 'Credit' | 'Thumb'; fade?: number }[], o: { font?: string; accent?: string } = {}): string {
  const font = o.font ?? 'Arial';
  const size = (k: number) => Math.round(height * k);
  const col = (hex: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex); const v = m ? m[1] : 'ffffff'; return `&H00${v.slice(4, 6)}${v.slice(2, 4)}${v.slice(0, 2)}`.toUpperCase(); };
  const accent = col(o.accent ?? '#ffffff');
  const styles = [
    `Style: Title,${font},${size(0.085)},${accent},&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,2,0,1,0,2,5,40,40,40,1`,
    `Style: Sub,${font},${size(0.035)},&H00D8D8D8,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,0,1,5,40,40,40,1`,
    `Style: Credit,${font},${size(0.042)},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,0,1,5,40,40,40,1`,
    `Style: Thumb,${font},${size(0.11)},${accent},&H000000FF,&H00000000,&HA0000000,-1,0,0,0,100,100,1,0,1,${Math.max(2, Math.round(height / 180))},${Math.max(1, Math.round(height / 360))},2,${Math.round(width * 0.05)},${Math.round(width * 0.05)},${Math.round(height * 0.07)},1`,
  ];
  const lines = events.map((e) => {
    const fade = e.fade ? `{\\fad(${Math.round(e.fade * 1000)},${Math.round(e.fade * 1000)})}` : '';
    return `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style ?? 'Title'},,0,0,0,,${fade}${assText(e.text)}`;
  });
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles, '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...lines, '',
  ].join('\n');
}

/** The title card's events: the title, then the subtitle a beat later. */
export function titleEvents(c: Credits, seconds: number) {
  const ev: Parameters<typeof assScript>[2] = [{ start: 0.2, end: seconds - 0.1, text: c.title, style: 'Title', fade: 0.6 }];
  if (c.subtitle) ev.push({ start: 0.8, end: seconds - 0.1, text: `\n\n\n${c.subtitle}`, style: 'Sub', fade: 0.5 });
  return ev;
}

/** The end credits' events: the lines in cards of up to 8, each shown for an equal share; the made-with line last. */
export function creditEvents(c: Credits, seconds: number) {
  const cards: string[][] = [];
  let cur: string[] = [];
  for (const l of c.lines) {
    if (!l) { if (cur.length) { cards.push(cur); cur = []; } continue; }
    cur.push(l);
    if (cur.length >= 8) { cards.push(cur); cur = []; }
  }
  if (cur.length) cards.push(cur);
  cards.push([c.madeWith]);
  const each = seconds / cards.length;
  return cards.map((card, i) => ({ start: r3(i * each + 0.1), end: r3((i + 1) * each - 0.1), text: card.join('\n'), style: 'Credit' as const, fade: 0.4 }));
}

/** Credits long enough to read: 2.5 s a card plus the made-with card, between 4 and 20 s. */
export function creditSeconds(c: Credits) {
  const cards = Math.ceil(c.lines.filter(Boolean).length / 8) + 1;
  return clamp(cards * 2.5, 4, 20);
}

// ------------------------------------------------------------------------------------------------ thumbnails

/** Times to take candidate frames at: the middle of each shot when the spans are known, else evenly (never the ends). */
export function candidateTimes(length: number, o: { spans?: { start: number; end: number }[]; count?: number } = {}): number[] {
  const n = Math.max(3, Math.min(16, o.count ?? 9));
  const spans = (o.spans ?? []).filter((s) => s.end - s.start > 0.2);
  if (spans.length >= 3) {
    const step = Math.max(1, Math.floor(spans.length / n));
    return spans.filter((_, i) => i % step === 0).slice(0, n).map((s) => r3(s.start + (s.end - s.start) * 0.5));
  }
  return Array.from({ length: n }, (_, i) => r3(length * (i + 0.5) / n));
}

/** Claude's pick checked: three distinct frame indexes in range (padded from the best spread when it gave fewer). */
export function settlePicks(answer: any, count: number, want = 3): { index: number; why: string; title?: string }[] {
  const raw: any[] = Array.isArray(answer?.picks) ? answer.picks : [];
  const seen = new Set<number>();
  const out: { index: number; why: string; title?: string }[] = [];
  for (const p of raw) {
    const i = Math.round(Number(p?.index));
    if (!Number.isInteger(i) || i < 0 || i >= count || seen.has(i)) continue;
    seen.add(i);
    out.push({ index: i, why: String(p.why ?? '').slice(0, 200), ...(p.title ? { title: String(p.title).slice(0, 60) } : {}) });
    if (out.length === want) break;
  }
  for (const i of [Math.floor(count / 2), Math.floor(count / 5), Math.floor((count * 4) / 5), 0, count - 1]) {
    if (out.length >= Math.min(want, count)) break;
    if (!seen.has(i)) { seen.add(i); out.push({ index: i, why: 'spread across the cut' }); }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ trailers

export type TrailerShot = { index: number; start: number; end: number; description?: string; lines?: string[] };
export type TrailerMoment = { start: number; end: number; why?: string; role?: 'hook' | 'build' | 'climax' | 'button' };
export type TrailerPlan = { moments: TrailerMoment[]; title: string; tagline?: string; cards: { after: number; text: string }[]; seconds: number };

/**
 * Claude's trailer answer checked against the episode: moments inside it, at least 0.8 s each, not overlapping, in the
 * order given, trimmed so the whole trailer (plus title and end cards) fits `seconds`; cards only between moments.
 */
export function settleTrailer(answer: any, length: number, o: { seconds: number; title: string; cardSeconds?: number }): TrailerPlan {
  const want = clamp(o.seconds, 15, 90);
  const card = o.cardSeconds ?? 2;
  const raw: any[] = Array.isArray(answer?.moments) ? answer.moments : [];
  const moments: TrailerMoment[] = [];
  for (const m of raw) {
    let s = Number(m?.start), e = Number(m?.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    s = clamp(s, 0, length); e = clamp(e, 0, length);
    if (e - s < 0.8) continue;
    if (moments.some((x) => s < x.end && e > x.start)) continue;
    moments.push({ start: r3(s), end: r3(e), ...(m.why ? { why: String(m.why).slice(0, 200) } : {}), ...(['hook', 'build', 'climax', 'button'].includes(m.role) ? { role: m.role } : {}) });
    if (moments.length >= 24) break;
  }
  if (!moments.length) throw new GenError('The trailer plan picked no usable moments from the episode');
  const cards = (Array.isArray(answer?.cards) ? answer.cards : [])
    .map((c: any) => ({ after: Math.round(Number(c?.after)), text: String(c?.text ?? '').trim().slice(0, 80) }))
    .filter((c: any) => c.text && Number.isInteger(c.after) && c.after >= 0 && c.after < moments.length - 1)
    .slice(0, 4);
  // Fit: the title card at the end, the cards, then the moments share what's left (each trimmed from its end).
  const budget = want - card * (1 + cards.length);
  let total = moments.reduce((s, m) => s + (m.end - m.start), 0);
  while (total > budget && moments.length > 1) {
    const longest = moments.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    const cut = Math.min(longest.end - longest.start - 0.8, total - budget);
    if (cut <= 0.01) { const dropped = moments.pop()!; total -= dropped.end - dropped.start; continue; }
    longest.end = r3(longest.end - cut);
    total -= cut;
  }
  return { moments, title: String(answer?.title ?? o.title).slice(0, 80) || o.title, ...(answer?.tagline ? { tagline: String(answer.tagline).slice(0, 100) } : {}), cards: cards.filter((c: any) => c.after < moments.length - 1), seconds: r3(total + card * (1 + cards.length)) };
}

/** What Claude is asked for a trailer. */
export function trailerPrompt(o: { script?: string; shots: TrailerShot[]; length: number; seconds: number; title: string }) {
  const shots = o.shots.map((s) => `#${s.index} ${s.start.toFixed(1)}-${s.end.toFixed(1)} s: ${s.description ?? ''}${s.lines?.length ? ` | lines: ${s.lines.join(' / ')}` : ''}`).join('\n');
  return [
    `Cut a ${o.seconds}-second trailer for "${o.title}" from its episode (${o.length.toFixed(1)} s long).`,
    'Pick 6 to 14 moments (start and end in seconds of the episode) in trailer order: a hook, then a build that raises the stakes, the climax, then a button (a last beat after the title). Moments may be out of story order. Prefer strong images, a line that sets up the conflict, and action. Never give away the ending.',
    'Add up to 3 short text cards between moments ("after": the moment index the card follows), a title and a tagline.',
    `Shots:\n${shots || '(no shot list: pick from the script and timing)'}`,
    o.script ? `Script:\n${o.script.slice(0, 12000)}` : '',
  ].filter(Boolean).join('\n\n');
}

export const TRAILER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['moments', 'title'],
  properties: {
    moments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'number' }, end: { type: 'number' }, role: { type: 'string', enum: ['hook', 'build', 'climax', 'button'] }, why: { type: 'string' } } } },
    cards: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['after', 'text'], properties: { after: { type: 'integer' }, text: { type: 'string' } } } },
    title: { type: 'string' }, tagline: { type: 'string' },
  },
};

export const PICKS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['picks'],
  properties: { picks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['index', 'why'], properties: { index: { type: 'integer' }, why: { type: 'string' }, title: { type: 'string' } } } } },
};

// ------------------------------------------------------------------------------------------------ the delivery sheet

export type SheetEntry = { kind: string; title: string; asset: string | null; job?: string | null; format?: string; width?: number; height?: number; seconds?: number; bytes?: number; for?: string };

/** The sheet that lists every file a delivery made, grouped, with what each is for. */
export function deliverySheet(o: { title: string; entries: SheetEntry[]; world?: string | null; notes?: string[] }) {
  const order = ['master', 'aspect', 'captions', 'trailer', 'thumbnail', 'poster', 'music', 'mix', 'other'];
  const entries = [...o.entries].sort((a, b) => (order.indexOf(a.kind) + 99) % 99 - (order.indexOf(b.kind) + 99) % 99);
  return { title: o.title, world: o.world ?? null, made: new Date().toISOString(), count: entries.length, files: entries, notes: o.notes ?? [] };
}
