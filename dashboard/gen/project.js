// The open timeline scene (video, image or audio: src/timeline.ts): its document, the edits the person makes by hand
// (the same rules as the server: tracks top first, any clip on any track, magnetic tracks lay their clips back to
// back), undo and redo, saving to Gen (with a version, so edits from the AI or MCP elsewhere aren't lost), waiting clips
// filled in when their jobs end, and changes made elsewhere picked up.

import { api, bus, toast, plainError, jobStatusText, sendFeedback } from './lib.js';

/** After something that's easy to regret, a toast with Undo (Ctrl+Z works too, but few people know). */
const undoable = (msg) => toast(msg, { action: 'Undo', onAction: () => doUndo(), ms: 6000 });

/** The tracks a new scene of each kind starts with, top first. */
export function blankTracks(kind = 'video') {
  if (kind === 'image') return [{ id: 'L3', name: 'Top', role: 'any' }, { id: 'L2', name: 'Middle', role: 'any' }, { id: 'L1', name: 'Background', role: 'any' }];
  if (kind === 'audio') return [{ id: 'A1', name: 'Music', role: 'audio' }, { id: 'A2', name: 'Voice', role: 'audio' }, { id: 'A3', name: 'Sound', role: 'audio' }];
  return [{ id: 'T1', name: 'Text', role: 'text' }, { id: 'V1', name: 'Video', role: 'main' }, { id: 'A1', name: 'Music', role: 'audio' }, { id: 'A2', name: 'Voice', role: 'audio' }, { id: 'A3', name: 'Sound', role: 'audio' }];
}
const COLORS = ['#5b6cff', '#a15bff', '#1fa3b8', '#1fb88a', '#e0a83a', '#ff6b81'];
const LOCAL_KEY = 'hg.editor.local.v3';

export const P = {
  /** active: a timeline scene is in front (editor.js), so this document syncs and saves. */
  active: false,
  kind: 'video', id: null, version: 0, doc: newDoc(), dirty: false, saving: false,
  selection: { clips: new Set(), range: null, mask: null, track: null },
  playhead: 0,
};
export function newDoc(title = 'Untitled', kind = 'video') {
  return {
    v: 2, title, width: kind === 'image' ? 1344 : 1280, height: kind === 'image' ? 768 : 720, fps: 30,
    ...(kind === 'image' ? { background: '#1b1e26', length: 5 } : {}),
    tracks: blankTracks(kind).map((t, i) => ({ ...t, color: COLORS[i % COLORS.length] })), clips: [],
  };
}

const r3 = (n) => Math.round(n * 1000) / 1000;
let seq = 0;
export const newId = () => `c_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const trackId = () => `tr_${Math.random().toString(16).slice(2, 8)}`;
export const clipLength = (c) => Math.max(0, (c.out - c.in) / (c.speed || 1));
export const clipEnd = (c) => c.start + clipLength(c);
export const docLength = (d = P.doc) => Math.max(d.length ?? 0, d.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0));
export const byId = (id) => P.doc.clips.find((c) => c.id === id) ?? null;
export const tracks = () => P.doc.tracks ?? [];
export const trackOf = (id) => tracks().find((t) => t.id === id) ?? null;
export const isMagnetic = (id) => Boolean(trackOf(id)?.magnetic);
export const onTrack = (t) => P.doc.clips.filter((c) => c.track === t).sort((a, b) => a.start - b.start);
export const selectedClips = () => [...P.selection.clips].map(byId).filter(Boolean);
export const isStill = (c) => c.kind === 'image' || c.kind === 'text' || c.kind === 'fill';
export const isVisual = (c) => c.kind !== 'audio';
export const hasSound = (c) => c.kind === 'video' || c.kind === 'audio';
/** The track that plays the picture: the magnetic one, else the first that isn't for sound. */
export const mainTrack = () => tracks().find((t) => t.magnetic) ?? tracks().find((t) => t.role === 'main' || t.role === 'video') ?? tracks().find((t) => t.role !== 'audio') ?? tracks()[0];

/**
 * When something is added without a time: in an image scene a picture spans it from 0; on the main track it goes at the
 * playhead if that spot is free, else after the last clip there (so adding one thing after another builds the cut);
 * elsewhere at the playhead.
 */
export function startFor(trackId, kind) {
  if (P.kind === 'image' && kind !== 'audio') return 0;
  if (trackId !== mainTrack()?.id) return P.playhead;
  const on = onTrack(trackId);
  return on.some((c) => P.playhead >= c.start - 0.01 && P.playhead < clipEnd(c)) ? on.reduce((m, c) => Math.max(m, clipEnd(c)), 0) : P.playhead;
}

/** Where a clip of this kind goes when the person didn't pick a track: the selected track, else the first that fits. */
export function defaultTrack(kind) {
  const sel = trackOf(P.selection.track);
  if (sel && !sel.locked) return sel.id;
  const by = (f) => tracks().find((t) => !t.locked && f(t))?.id;
  if (kind === 'audio') return by((t) => t.role === 'audio') ?? by((t) => t.role === 'any') ?? addTrackRaw({ name: 'Audio', role: 'audio' }).id;
  if (kind === 'text') return by((t) => t.role === 'text') ?? by((t) => t.role === 'any') ?? addTrackRaw({ name: 'Text', role: 'text', at: 0 }).id;
  return by((t) => t.magnetic) ?? by((t) => t.role === 'video' || t.role === 'main') ?? by((t) => t.role === 'any') ?? addTrackRaw({ name: 'Video', role: 'video', at: 0 }).id;
}

/**
 * Where a clip of this length can start on a track near `start` without going inside another clip: `start` itself when
 * it's free, else the nearest gap it fits (the end of the track always does).
 */
export function fitStart(trackId, start, len, except = null) {
  const others = P.doc.clips.filter((x) => x.track === trackId && x.id !== except).sort((a, b) => a.start - b.start);
  const free = (s) => others.every((x) => s + len <= x.start + 0.001 || s >= clipEnd(x) - 0.001);
  if (start >= 0 && free(start)) return start;
  const spots = [0, ...others.map(clipEnd), ...others.map((x) => x.start - len)].filter((s) => s >= 0 && free(s));
  return spots.sort((a, b) => Math.abs(a - start) - Math.abs(b - start))[0] ?? (others.length ? clipEnd(others[others.length - 1]) : 0);
}
/** The clips on a track just before and after one (for trimming up to them). */
export function neighbours(c) {
  const others = P.doc.clips.filter((x) => x.track === c.track && x.id !== c.id);
  return { before: others.filter((x) => clipEnd(x) <= c.start + 0.001).reduce((m, x) => Math.max(m, clipEnd(x)), 0), after: others.filter((x) => x.start >= clipEnd(c) - 0.001).reduce((m, x) => Math.min(m, x.start), Infinity) };
}

/**
 * Magnetic tracks sit back to back from 0 in their order; the rest keep their starts, but never overlap: a clip that
 * would start inside the one before slides to just after it (the same rule as the server's layout).
 */
export function layout(d = P.doc) {
  for (const t of d.tracks ?? []) {
    let at = 0;
    for (const c of d.clips.filter((x) => x.track === t.id).sort((a, b) => a.start - b.start)) {
      if (t.magnetic) c.start = r3(at);
      else if (c.start < at - 0.001) c.start = r3(at);
      at = c.start + clipLength(c);
    }
  }
}

// ------------------------------------------------------------------ undo
const undo = [];
const redo = [];
const snap = () => JSON.stringify(P.doc);
/** Call before changing the document: the change becomes one undo step. */
export function remember() {
  undo.push(snap());
  if (undo.length > 120) undo.shift();
  redo.length = 0;
  bus.emit('history');
}
export const canUndo = () => undo.length > 0;
export const canRedo = () => redo.length > 0;
export function doUndo() { if (!undo.length) return; redo.push(snap()); P.doc = JSON.parse(undo.pop()); changed(); }
export function doRedo() { if (!redo.length) return; undo.push(snap()); P.doc = JSON.parse(redo.pop()); changed(); }
export function clearHistory() { undo.length = 0; redo.length = 0; bus.emit('history'); }

/** After any change: lay magnetic tracks out, drop selections of what's gone, redraw, save soon. */
export function changed({ save = true } = {}) {
  layout();
  for (const id of [...P.selection.clips]) if (!byId(id)) P.selection.clips.delete(id);
  if (P.selection.track && !trackOf(P.selection.track)) P.selection.track = null;
  bus.emit('doc');
  bus.emit('history');
  if (save) scheduleSave();
}

// ------------------------------------------------------------------ edits by hand
/** How long a still (picture, text, color) lasts when added: an image scene's whole length, else 3 seconds. */
const stillSeconds = () => (P.kind === 'image' ? Math.max(1, docLength() || P.doc.length || 5) : 3);

/**
 * Puts something on the timeline. `track` defaults to the selected track (else one that fits the kind); a magnetic
 * track takes it at `index` or where `start` falls, others at `start` (default: the playhead; in an image scene, 0).
 */
export function addClip({ track, asset, kind = 'video', duration = null, start, index, label, text, color, scene, sceneVersion, seconds, place = {}, history = true }) {
  if (history) remember();
  const asked = Boolean(track && trackOf(track));
  let t = asked ? track : defaultTrack(kind);
  const still = kind === 'image' || kind === 'text' || kind === 'fill';
  const len = still ? seconds ?? stillSeconds() : duration ?? seconds ?? 5;
  const c = {
    id: newId(), track: t, kind, start: 0, in: 0, out: len, duration: still ? null : duration,
    ...(asset ? { asset } : {}), ...(label ? { label } : {}), ...(scene ? { scene, sceneVersion } : {}),
    ...(kind === 'text' ? { text: text ?? 'Text' } : {}), ...(kind === 'fill' ? { color: color ?? '#000000' } : {}), ...place,
  };
  if (isMagnetic(t)) {
    const v = onTrack(t);
    const i = index ?? (start != null ? v.findIndex((x) => x.start + clipLength(x) / 2 > start) : -1);
    c.start = i >= 0 && i < v.length ? v[i].start - 0.0005 : docLength() + 1;
  } else {
    c.start = Math.max(0, start ?? (P.kind === 'image' ? 0 : P.playhead));
    // Something's already there: it becomes a layer of its own, a new track over that one (for sound, under it). When
    // no track was asked for, the nearest free track of the same sort takes it first.
    const busy = (id) => P.doc.clips.some((x) => x.track === id && x.start < c.start + len - 0.01 && clipEnd(x) > c.start + 0.01);
    if (busy(t) && !asked) {
      const i = tracks().findIndex((x) => x.id === t);
      const fits = (x) => !x.locked && !x.magnetic && (kind === 'audio' ? x.role === 'audio' : kind === 'text' ? x.role === 'text' || x.role === 'any' : x.role === 'any' || x.role === 'video');
      const free = tracks().map((x, j) => ({ x, d: Math.abs(j - i) })).filter(({ x }) => x.id !== t && fits(x) && !busy(x.id)).sort((p, q) => p.d - q.d)[0]?.x;
      if (free) { t = free.id; c.track = t; }
    }
    if (busy(t)) {
      const i = tracks().findIndex((x) => x.id === t);
      const name = { image: 'Picture', video: 'Video', audio: 'Sound', text: 'Text', fill: 'Color' }[kind];
      t = addTrackRaw({ name, role: kind === 'audio' ? 'audio' : kind === 'text' ? 'text' : 'any', at: kind === 'audio' ? i + 1 : i }).id;
      c.track = t;
    }
  }
  P.doc.clips.push(c);
  changed();
  return byId(c.id) ?? c;
}

export function splitAt(t = P.playhead) {
  // The selected clips under the playhead, else every clip under it on the main track.
  const inside = (c) => t > c.start + 0.05 && t < clipEnd(c) - 0.05;
  let targets = selectedClips().filter(inside);
  if (!targets.length) targets = onTrack(mainTrack()?.id).filter(inside);
  if (!targets.length) return false;
  remember();
  for (const c of targets) {
    const right = { ...structuredClone(c), id: newId(), start: t + 0.0001 };
    if (isStill(c)) { right.in = 0; right.out = r3(clipEnd(c) - t); c.out = r3(t - c.start); } else {
      const cut = r3(c.in + (t - c.start) * (c.speed || 1));
      right.in = cut;
      c.out = cut;
    }
    if (c.fadeOut) { right.fadeOut = c.fadeOut; delete c.fadeOut; }
    delete right.fadeIn;
    if (c.transition) { delete c.transition; delete c.transitionSeconds; } else delete right.transition;
    P.doc.clips.push(right);
  }
  changed();
  return true;
}

export function deleteSelected() {
  const ids = [...P.selection.clips];
  if (!ids.length && !P.selection.range) return false;
  remember();
  // A made take taken off the timeline tells the making loop it wasn't wanted (uploads are ignored there).
  if (ids.length) for (const c of P.doc.clips) if (P.selection.clips.has(c.id) && !trackOf(c.track)?.locked && c.asset) sendFeedback('discard', c.asset);
  if (ids.length) P.doc.clips = P.doc.clips.filter((c) => !P.selection.clips.has(c.id) || trackOf(c.track)?.locked);
  else cutRange(P.selection.range.start, P.selection.range.end);
  const what = ids.length ? `Deleted ${ids.length} clip${ids.length === 1 ? '' : 's'}.` : 'Cut that stretch out.';
  P.selection.clips.clear();
  P.selection.range = null;
  changed();
  undoable(what);
  return true;
}

/** Cuts [a, b) out of every unlocked track: magnetic tracks close up, others slide back; clips across the edges are trimmed. */
function cutRange(a, b) {
  const next = [];
  for (const c of P.doc.clips) {
    if (trackOf(c.track)?.locked) { next.push(c); continue; }
    const s = c.start, e = clipEnd(c), sp = c.speed || 1, mag = isMagnetic(c.track);
    if (e <= a || s >= b) { if (s >= b && !mag) c.start = r3(s - (b - a)); next.push(c); continue; }
    if (s < a) next.push({ ...c, out: isStill(c) ? r3(a - s) : r3(c.in + (a - s) * sp) });
    if (e > b) next.push({ ...c, id: s < a ? newId() : c.id, start: mag ? a + 0.0001 : r3(a), ...(isStill(c) ? { in: 0, out: r3(e - b) } : { in: r3(c.in + (b - s) * sp) }) });
  }
  P.doc.clips = next;
}

export function duplicateSelected() {
  const cs = selectedClips();
  if (!cs.length) return;
  remember();
  P.selection.clips.clear();
  for (const c of cs) {
    const d = { ...structuredClone(c), id: newId(), start: isMagnetic(c.track) ? c.start + 0.0003 : clipEnd(c) };
    P.doc.clips.push(d);
    P.selection.clips.add(d.id);
  }
  changed();
}

export function setClip(id, patch, { history = true } = {}) {
  const c = byId(id);
  if (!c) return;
  if (history) remember();
  Object.assign(c, patch);
  for (const k of Object.keys(patch)) if (patch[k] === undefined || patch[k] === null) delete c[k];
  changed();
}

// ------------------------------------------------------------------ copy and paste
const CLIP_KEY = 'hg.clipboard';
/** Copies the selected clips (with where they sat relative to each other). */
export function copySelected() {
  const cs = selectedClips();
  if (!cs.length) return 0;
  const from = Math.min(...cs.map((c) => c.start));
  const data = { from: P.id, clips: cs.map((c) => ({ ...structuredClone(c), at: c.start - from, trackName: trackOf(c.track)?.name })) };
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(data)); } catch { /* private window */ }
  return cs.length;
}
export function cutSelected() { const n = copySelected(); if (n) deleteSelected(); return n; }
/**
 * Pastes at the playhead: each clip on its own track when this scene has it (else the selected track, else one that
 * fits), keeping their spacing, never inside another clip (a clip that doesn't fit gets a layer of its own).
 */
export function paste() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch { /* */ }
  if (!data?.clips?.length) return 0;
  remember();
  P.selection.clips.clear();
  for (const c0 of data.clips) {
    const { at, trackName, ...c } = c0;
    c.id = newId();
    const same = data.from === P.id ? trackOf(c.track) : tracks().find((t) => t.name === trackName);
    let t = same && !same.locked ? same.id : defaultTrack(c.kind);
    let s = P.playhead + at;
    const len = clipLength(c);
    const clash = P.doc.clips.some((x) => x.track === t && x.start < s + len - 0.01 && clipEnd(x) > s + 0.01);
    if (clash && !isMagnetic(t)) {
      const i = tracks().findIndex((x) => x.id === t);
      t = addTrackRaw({ name: trackOf(t).name, role: trackOf(t).role === 'main' ? 'any' : trackOf(t).role, at: c.kind === 'audio' ? i + 1 : i }).id;
    }
    c.track = t;
    c.start = isMagnetic(t) ? s - 0.0005 : s;
    P.doc.clips.push(c);
    P.selection.clips.add(c.id);
  }
  changed();
  bus.emit('selection');
  return data.clips.length;
}

// ------------------------------------------------------------------ tracks
function addTrackRaw({ name = 'Track', role = 'any', at } = {}) {
  const used = new Set(tracks().map((t) => t.color));
  const t = { id: trackId(), name, role, color: COLORS.find((c) => !used.has(c)) ?? COLORS[tracks().length % COLORS.length] };
  const i = at ?? (role === 'audio' ? tracks().length : Math.max(0, tracks().findIndex((x) => x.role === 'audio')));
  P.doc.tracks.splice(i < 0 ? tracks().length : i, 0, t);
  return t;
}
export function addTrack(opts) { remember(); const t = addTrackRaw(opts); P.selection.track = t.id; changed(); return t; }
export function setTrack(id, patch, { history = true } = {}) {
  const t = trackOf(id);
  if (!t) return;
  if (history) remember();
  Object.assign(t, patch);
  for (const k of Object.keys(patch)) if (patch[k] === undefined || patch[k] === null || patch[k] === false) delete t[k];
  changed();
}
export function removeTrack(id) {
  if (tracks().length < 2) return toast('One track stays.');
  remember();
  const name = trackOf(id)?.name ?? 'the track';
  P.doc.tracks = tracks().filter((t) => t.id !== id);
  P.doc.clips = P.doc.clips.filter((c) => c.track !== id);
  changed();
  undoable(`Removed "${name}".`);
}
export function moveTrack(id, by) {
  const i = tracks().findIndex((t) => t.id === id), j = i + by;
  if (i < 0 || j < 0 || j >= tracks().length) return;
  remember();
  [P.doc.tracks[i], P.doc.tracks[j]] = [P.doc.tracks[j], P.doc.tracks[i]];
  changed();
}
/** What plays: a muted track is silent; when any track is soloed only soloed tracks sound. */
export function audible(trackIdOrTrack) {
  const t = typeof trackIdOrTrack === 'string' ? trackOf(trackIdOrTrack) : trackIdOrTrack;
  if (!t || t.mute) return false;
  return !tracks().some((x) => x.solo) || Boolean(t.solo);
}

// ------------------------------------------------------------------ saving and syncing
// Two tabs on one scene (J, 2026-10-30: the AI changed it in one tab, the other saved its older copy over it and got
// "changed somewhere else"): every save and every newer copy taken is told to this browser's other tabs at once, and a
// tab with nothing unsaved takes the newer copy quietly before it can save over it.
const tabsChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('hawkes-gen-scenes') : null;
const announce = () => { if (P.id) { try { tabsChannel?.postMessage({ id: P.id, version: P.version }); } catch { /* closed */ } } };
tabsChannel?.addEventListener('message', async ({ data }) => {
  if (!data || data.id !== P.id || !(data.version > P.version) || P.dirty || P.saving) return;
  try {
    const p = await api(`/v1/editor/projects/${P.id}`);
    if (p.id === P.id && p.version > P.version && !P.dirty && !P.saving) take(p);
  } catch { /* the 8 s sync tries again */ }
});
let saveTimer = 0;
export function scheduleSave() {
  P.dirty = true;
  bus.emit('save', 'dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}
export async function save() {
  clearTimeout(saveTimer);
  if (!P.id) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ id: null, doc: P.doc })); } catch { /* private window */ } P.dirty = false; bus.emit('save', 'local'); return; }
  if (P.saving) return;
  P.saving = true;
  bus.emit('save', 'saving');
  const sent = snap();
  try {
    const r = await api(`/v1/editor/projects/${P.id}`, { method: 'PUT', body: { doc: P.doc, version: P.version } });
    P.version = r.version;
    P.dirty = snap() !== sent;
    bus.emit('save', P.dirty ? 'dirty' : 'saved');
    announce();
  } catch (err) {
    if (err.status === 409 && err.data?.project) {
      // Changed elsewhere (the AI, MCP, another tab): theirs wins; the person's last change can be undone back.
      remember();
      take(err.data.project);
      toast('This scene was changed in another tab or by the AI, so you have the newest version now. Undo brings back what you just did.');
    } else {
      bus.emit('save', 'error');
    }
  } finally {
    P.saving = false;
    if (P.dirty) scheduleSave();
  }
}
/** Takes a scene from the server as the current one. */
export function take(project) {
  P.id = project.id;
  P.kind = project.kind ?? 'video';
  P.version = project.version;
  P.doc = project.doc;
  P.dirty = false;
  changed({ save: false });
  bus.emit('project', project);
  bus.emit('save', 'saved');
  announce();
}

/** Signed out: what was built here last time (kept in this browser), else a new video. */
export function startSignedOut() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null'); } catch { /* */ }
  P.id = null;
  P.kind = 'video';
  P.doc = local?.doc?.v === 2 ? local.doc : newDoc();
  P.active = true;
  changed({ save: false });
  bus.emit('save', 'local');
}
/** What was built signed out, to bring into the account on sign-in (then forgotten). */
export function takeLocal() {
  try {
    const local = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
    localStorage.removeItem(LOCAL_KEY);
    return local?.doc?.v === 2 && local.doc.clips?.length ? local.doc : null;
  } catch { return null; }
}

/** What each job being made is doing now (by job id): "In line (2 ahead)", "Waiting for a free server", a step. */
export const PROGRESS = new Map();
/** Stops making a waiting clip: the job is cancelled and the clip leaves the timeline (Undo puts it back, still stopped). */
export async function stopClip(id) {
  const c = byId(id);
  if (!c?.job) return;
  try { await api(`/v1/jobs/${c.job}/cancel`, { method: 'POST' }); } catch { /* already ended */ }
  remember();
  P.doc.clips = P.doc.clips.filter((x) => x.id !== id);
  changed();
  undoable(`Stopped making "${c.label ?? 'it'}".`);
}

// Waiting clips: follow their jobs and fill them in. Edits made elsewhere: picked up while the page is visible.
const watching = new Map();
export function watchJobs() {
  for (const c of P.doc.clips) {
    if (!c.pending || !c.job || watching.has(c.job)) continue;
    watching.set(c.job, true);
    followJob(c.job).catch(() => {}).finally(() => watching.delete(c.job));
  }
}
async function followJob(jobId) {
  for (;;) {
    let j;
    try { j = await api(`/v1/jobs/${jobId}`); } catch { await new Promise((r) => setTimeout(r, 4000)); continue; }
    const mine = P.doc.clips.filter((c) => c.job === jobId && c.pending);
    if (!mine.length) return;
    if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') {
      for (const c of mine) {
        if (j.status === 'done') {
          const want = c.kind === 'audio' ? ['audio'] : c.kind === 'image' ? ['image', 'video'] : ['video', 'image'];
          const out = j.outputs.find((o) => want.includes(o.kind) && !/mask/i.test(o.title ?? '')) ?? j.outputs.find((o) => want.includes(o.kind)) ?? j.outputs[0];
          if (out) { c.asset = out.asset; if (isVisual(c) && (out.kind === 'image' || out.kind === 'video')) c.kind = out.kind; } else c.failed = 'The job made nothing';
        } else c.failed = plainError(j.error ?? j.status);
        delete c.pending;
      }
      changed();
      bus.emit('jobDone', j);
      return;
    }
    PROGRESS.set(jobId, jobStatusText(j));
    bus.emit('jobProgress', { job: jobId, status: j.status, detail: j.detail, ahead: j.queue?.ahead, step: PROGRESS.get(jobId) });
    await new Promise((r) => setTimeout(r, 2500));
  }
}

export function startSync() {
  setInterval(async () => {
    if (!P.id || !P.active || document.hidden || P.dirty || P.saving) return;
    try {
      const p = await api(`/v1/editor/projects/${P.id}`);
      if (p.id === P.id && p.version > P.version && !P.dirty) { take(p); toast('Updated with changes made elsewhere.'); }
    } catch { /* offline: try later */ }
  }, 8000);
  bus.on('doc', watchJobs);
  // Clips that were already waiting when the page opened are followed now, not at the next change.
  watchJobs();
}
