// The cut (docs/finishing.md): edit.pace proposes trims and order from the script's beats and the dialogue timings,
// with J-cuts and L-cuts at dialogue cuts (the sound leads or trails the picture by a few frames), as timeline ops
// (src/timeline.ts applyOps, the same ops the AI editor answers with), so applying them is one undo step. Pure.

import { normalize, clipLength, type Doc, type Clip, type Op } from '../timeline.ts';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export type PaceBeat = { at?: number; clip?: string; label?: string };
export type Line = { start: number; end: number; clip?: string };

export type PaceOptions = {
  /** Story beats in story order; a beat naming a clip puts that clip in this order. */
  beats?: PaceBeat[];
  /** Dialogue spans (default: the clips on the Voice track). */
  dialogue?: Line[];
  /** How far sound leads (J) or trails (L) the picture at a dialogue cut, in frames (default 6). */
  leadFrames?: number;
  /** Most air kept before the first line and after the last in a shot (seconds). */
  head?: number;
  tail?: number;
  /** A shot with no line is held at most this long (seconds; 0 leaves them). */
  maxSilent?: number;
};

export type PaceChange = { clip: string; kind: 'order' | 'trim-head' | 'trim-tail' | 'j-cut' | 'l-cut' | 'shift'; seconds: number; why: string };

export type PacePlan = { ops: Op[]; changes: PaceChange[]; before: number; after: number; notes: string[] };

/** The picture track: the main (magnetic) one, else the first video track. */
export function pictureTrack(doc: Doc) {
  return doc.tracks.find((t) => t.role === 'main') ?? doc.tracks.find((t) => t.magnetic) ?? doc.tracks.find((t) => t.role === 'video') ?? null;
}

/** The dialogue track(s): named Voice or Dialogue. */
export const dialogueTracks = (doc: Doc) => doc.tracks.filter((t) => /voice|dialog/i.test(t.name)).map((t) => t.id);

export function planPace(doc0: Doc, o: PaceOptions = {}): PacePlan {
  const doc = normalize(JSON.parse(JSON.stringify(doc0)));
  const notes: string[] = [];
  const changes: PaceChange[] = [];
  const ops: Op[] = [];
  const pic = pictureTrack(doc);
  if (!pic) return { ops, changes, before: 0, after: 0, notes: ['no picture track'] };
  let shots = doc.clips.filter((c) => c.track === pic.id && (c.kind === 'video' || c.kind === 'image')).sort((a, b) => a.start - b.start);
  if (shots.length < 1) return { ops, changes, before: 0, after: 0, notes: ['no shots on the picture track'] };
  const fps = doc.fps || 30;
  const lead = r3(Math.max(0, Math.min(24, o.leadFrames ?? 6)) / fps);
  const head = o.head ?? 0.35;
  const tail = o.tail ?? 0.5;
  const maxSilent = o.maxSilent ?? 0;
  const dTracks = new Set(dialogueTracks(doc));
  const voiceClips = doc.clips.filter((c) => dTracks.has(c.track) && c.kind === 'audio');
  const lines: (Line & { id?: string })[] = o.dialogue?.length
    ? o.dialogue.map((l) => ({ start: l.start, end: l.end, clip: l.clip }))
    : voiceClips.map((c) => ({ start: c.start, end: c.start + clipLength(c), id: c.id }));
  const before = r3(shots.reduce((m, c) => Math.max(m, c.start + clipLength(c)), 0));

  // 1. Order from the beats: clips the beats name, in beat order, then the rest as they were.
  const named = (o.beats ?? []).map((b) => b.clip).filter((id): id is string => !!id && shots.some((s) => s.id === id));
  if (named.length >= 2 && pic.magnetic) {
    const want = [...new Set(named)];
    const rest = shots.filter((s) => !want.includes(s.id));
    const next = [...want.map((id) => shots.find((s) => s.id === id)!), ...rest];
    if (next.some((s, i) => s !== shots[i])) {
      next.forEach((s, i) => ops.push({ op: 'move', id: s.id, index: i }));
      changes.push({ clip: next[0].id, kind: 'order', seconds: 0, why: 'shots put in the order of the story\'s beats' });
      notes.push('the order changed: lines follow their shots');
    }
    shots = next;
  }

  // Which shot each line belongs to (the one it overlaps most, on the original timeline).
  const owner = (l: Line) => {
    let best: Clip | null = null, most = 0;
    for (const s of doc.clips.filter((c) => c.track === pic.id)) {
      const ov = Math.min(l.end, s.start + clipLength(s)) - Math.max(l.start, s.start);
      if (ov > most) { most = ov; best = s; }
    }
    return best;
  };
  const linesOf = new Map<string, (Line & { id?: string })[]>();
  for (const l of lines) {
    const s = l.clip ? shots.find((x) => x.id === l.clip) : owner(l);
    if (!s) continue;
    if (!linesOf.has(s.id)) linesOf.set(s.id, []);
    linesOf.get(s.id)!.push(l);
  }

  // 2. Trims: air before the first line and after the last, silent shots held too long; an L-cut where a line ends at
  // the shot's end (the picture cuts away while the line finishes over the next shot).
  type T = { clip: Clip; headCut: number; tailCut: number; len: number; lCut: boolean };
  const trims: T[] = shots.map((s, k) => {
    const len = clipLength(s);
    const own = (linesOf.get(s.id) ?? []).map((l) => ({ start: l.start - s.start, end: l.end - s.start }));
    let headCut = 0, tailCut = 0, lCut = false;
    if (own.length) {
      const first = Math.min(...own.map((l) => l.start));
      const last = Math.max(...own.map((l) => l.end));
      if (first > head + 0.15) headCut = r3(first - head);
      if (len - last > tail + 0.15) tailCut = r3(len - last - tail);
      // The line runs to (or past) the shot's end and another shot follows: an L-cut.
      else if (k < shots.length - 1 && len - last < 0.35 && len - tailCut - headCut > lead + 0.8) { tailCut = r3(tailCut + lead); lCut = true; }
    } else if (maxSilent > 0 && s.kind === 'video' && len > maxSilent + 0.25) {
      tailCut = r3(len - maxSilent);
    }
    // Never trim a shot under a second.
    const room = len - 1;
    if (headCut + tailCut > room) { const k2 = room / (headCut + tailCut); headCut = r3(Math.max(0, headCut * k2)); tailCut = r3(Math.max(0, tailCut * k2)); }
    return { clip: s, headCut, tailCut, len, lCut };
  });
  for (const t of trims) {
    const sp = t.clip.speed || 1;
    if (t.headCut > 0.01 || t.tailCut > 0.01) {
      ops.push({ op: 'trim', id: t.clip.id, ...(t.headCut > 0.01 ? { in: r3(t.clip.in + t.headCut * sp) } : {}), ...(t.tailCut > 0.01 ? { out: r3(t.clip.out - t.tailCut * sp) } : {}) });
    }
    if (t.headCut > 0.01) changes.push({ clip: t.clip.id, kind: 'trim-head', seconds: t.headCut, why: 'air before the first line' });
    if (t.lCut) changes.push({ clip: t.clip.id, kind: 'l-cut', seconds: lead, why: 'the line trails over the next shot' });
    const plainTail = r3(t.tailCut - (t.lCut ? lead : 0));
    if (plainTail > 0.01) changes.push({ clip: t.clip.id, kind: 'trim-tail', seconds: plainTail, why: (linesOf.get(t.clip.id) ?? []).length ? 'air after the last line' : `held ${maxSilent} s without a line` });
  }

  // 3. Where each shot now starts (magnetic: back to back), and its lines moved with it.
  const newStart = new Map<string, number>();
  let at = pic.magnetic ? 0 : NaN;
  for (const t of trims) {
    const s = pic.magnetic ? at : t.clip.start;
    newStart.set(t.clip.id, r3(s));
    at = s + t.len - t.headCut - t.tailCut;
  }
  const after = r3(pic.magnetic ? at : before);
  const moved = new Map<string, number>();
  for (const t of trims) {
    for (const l of linesOf.get(t.clip.id) ?? []) {
      if (!l.id) continue;
      const to = r3(newStart.get(t.clip.id)! + (l.start - t.clip.start) - t.headCut);
      moved.set(l.id, Math.max(0, to));
    }
  }

  // 4. J-cuts: a line that opens the next shot starts a few frames before the picture cuts to it.
  for (let k = 1; k < trims.length; k++) {
    const cutAt = newStart.get(trims[k].clip.id)!;
    if (trims[k - 1].lCut) continue; // one overlap per join
    const opening = (linesOf.get(trims[k].clip.id) ?? []).filter((l) => l.id).map((l) => ({ id: l.id!, at: moved.get(l.id!) ?? l.start })).find((l) => l.at - cutAt < 0.35 && l.at >= cutAt - 0.01);
    if (!opening) continue;
    // Not into the line before it.
    const prevEnd = Math.max(0, ...[...moved.entries()].filter(([id]) => id !== opening.id).map(([id, s]) => {
      const c = voiceClips.find((v) => v.id === id)!;
      return s + clipLength(c) <= opening.at + 0.01 ? s + clipLength(c) : 0;
    }));
    const to = r3(Math.max(prevEnd + 0.05, cutAt - lead));
    if (to < opening.at - 0.01) {
      moved.set(opening.id, to);
      changes.push({ clip: opening.id, kind: 'j-cut', seconds: r3(opening.at - to), why: 'the line leads into the next shot' });
    }
  }
  for (const [id, to] of moved) {
    const c = voiceClips.find((v) => v.id === id)!;
    if (Math.abs(c.start - to) < 0.005) continue;
    ops.push({ op: 'set', id, start: to });
    if (!changes.some((x) => x.clip === id)) changes.push({ clip: id, kind: 'shift', seconds: r3(to - c.start), why: 'kept with its shot' });
  }
  if (!pic.magnetic) notes.push('the picture track is not magnetic: trims leave gaps where they cut');
  if (!lines.length) notes.push('no dialogue found (a Voice track, or give dialogue): only silent shots were paced');
  return { ops, changes, before, after, notes };
}
