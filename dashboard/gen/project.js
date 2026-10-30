// The open project: its timeline document, the edits the person makes by hand (the same rules as src/editor.ts: V1 is
// magnetic, other tracks are free), undo and redo, saving to Gen (with a version, so edits from the AI or MCP elsewhere
// aren't lost), waiting clips filled in when their jobs end, and changes made elsewhere picked up.

import { api, bus, toast, plainError } from './lib.js';

export const TRACKS = [
  { id: 'V1', kind: 'video', name: 'Video' },
  { id: 'T1', kind: 'text', name: 'Text' },
  { id: 'A1', kind: 'audio', name: 'Music' },
  { id: 'A2', kind: 'audio', name: 'Voice' },
  { id: 'A3', kind: 'audio', name: 'Sound' },
];
const LOCAL_KEY = 'hg.editor.local.v2';

export const P = {
  /** active: a video tab is in front (video.js), so this project syncs and saves. */
  active: false,
  id: null, version: 0, doc: newDoc(), dirty: false, saving: false,
  selection: { clips: new Set(), range: null, mask: null },
  playhead: 0,
};
export function newDoc(title = 'Untitled') { return { v: 1, title, width: 1280, height: 720, fps: 30, tracks: TRACKS, clips: [] }; }

const r3 = (n) => Math.round(n * 1000) / 1000;
let seq = 0;
export const newId = () => `c_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export const clipLength = (c) => Math.max(0, (c.out - c.in) / (c.speed || 1));
export const clipEnd = (c) => c.start + clipLength(c);
export const docLength = (d = P.doc) => d.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
export const byId = (id) => P.doc.clips.find((c) => c.id === id) ?? null;
export const onTrack = (t) => P.doc.clips.filter((c) => c.track === t).sort((a, b) => a.start - b.start);
export const selectedClips = () => [...P.selection.clips].map(byId).filter(Boolean);

/** V1 sits back to back from 0 in its order; the rest keep their starts. */
export function layout(d = P.doc) {
  let t = 0;
  for (const c of d.clips.filter((x) => x.track === 'V1').sort((a, b) => a.start - b.start)) { c.start = r3(t); t += clipLength(c); }
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
export function doUndo() { if (!undo.length) return; redo.push(snap()); P.doc = JSON.parse(undo.pop()); changed({ history: false }); }
export function doRedo() { if (!redo.length) return; undo.push(snap()); P.doc = JSON.parse(redo.pop()); changed({ history: false }); }

/** After any change: lay V1 out, drop selections of clips that are gone, redraw, save soon. */
export function changed({ save = true } = {}) {
  layout();
  for (const id of [...P.selection.clips]) if (!byId(id)) P.selection.clips.delete(id);
  bus.emit('doc');
  bus.emit('history');
  if (save) scheduleSave();
}

// ------------------------------------------------------------------ edits by hand
export function addClip({ track = 'V1', asset, kind = 'video', duration = null, start, index, label, text }) {
  remember();
  const isText = track === 'T1';
  const len = kind === 'image' || isText ? 3 : duration ?? 5;
  const c = { id: newId(), track, kind: isText ? 'text' : track === 'V1' ? kind : 'audio', start: 0, in: 0, out: len, duration: kind === 'image' || isText ? null : duration, ...(asset ? { asset } : {}), ...(label ? { label } : {}), ...(isText ? { text: text ?? 'Text' } : {}) };
  if (track === 'V1') {
    const v = onTrack('V1');
    const i = index ?? (start != null ? v.findIndex((x) => x.start + clipLength(x) / 2 > start) : -1);
    c.start = i >= 0 && i < v.length ? v[i].start - 0.0005 : docLength() + 1;
  } else {
    c.start = Math.max(0, start ?? P.playhead);
  }
  P.doc.clips.push(c);
  changed();
  return c;
}

export function splitAt(t = P.playhead) {
  // The selected clips under the playhead, else every clip under it on V1.
  let targets = selectedClips().filter((c) => t > c.start + 0.05 && t < clipEnd(c) - 0.05);
  if (!targets.length) targets = onTrack('V1').filter((c) => t > c.start + 0.05 && t < clipEnd(c) - 0.05);
  if (!targets.length) return false;
  remember();
  for (const c of targets) {
    const cut = r3(c.in + (t - c.start) * (c.speed || 1));
    const right = { ...structuredClone(c), id: newId(), in: cut, start: t + 0.0001 };
    if (c.transition) { delete c.transition; delete c.transitionSeconds; } else delete right.transition;
    c.out = cut;
    P.doc.clips.push(right);
  }
  changed();
  return true;
}

export function deleteSelected() {
  const ids = [...P.selection.clips];
  if (!ids.length && !P.selection.range) return false;
  remember();
  if (ids.length) P.doc.clips = P.doc.clips.filter((c) => !P.selection.clips.has(c.id));
  else cutRange(P.selection.range.start, P.selection.range.end);
  P.selection.clips.clear();
  P.selection.range = null;
  changed();
  return true;
}

/** Cuts [a, b) out of every track: V1 closes up, others slide back; clips across the edges are trimmed. */
function cutRange(a, b) {
  const next = [];
  for (const c of P.doc.clips) {
    const s = c.start, e = clipEnd(c), sp = c.speed || 1;
    if (e <= a || s >= b) { if (s >= b && c.track !== 'V1') c.start = r3(s - (b - a)); next.push(c); continue; }
    if (s < a) next.push({ ...c, out: r3(c.in + (a - s) * sp) });
    if (e > b) next.push({ ...c, id: s < a ? newId() : c.id, start: c.track === 'V1' ? a + 0.0001 : r3(a), in: r3(c.in + (b - s) * sp) });
  }
  P.doc.clips = next;
}

export function duplicateSelected() {
  const cs = selectedClips();
  if (!cs.length) return;
  remember();
  P.selection.clips.clear();
  for (const c of cs) {
    const d = { ...structuredClone(c), id: newId(), start: c.track === 'V1' ? c.start + 0.0003 : clipEnd(c) };
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

// ------------------------------------------------------------------ saving and syncing
let saveTimer = 0;
export function scheduleSave() {
  P.dirty = true;
  bus.emit('save', 'dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}
export async function save() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ id: P.id, doc: P.doc })); } catch { /* private window */ }
  if (!P.id || P.saving) { if (!P.id) { P.dirty = false; bus.emit('save', 'local'); } return; }
  P.saving = true;
  bus.emit('save', 'saving');
  const sent = snap();
  try {
    const r = await api(`/v1/editor/projects/${P.id}`, { method: 'PUT', body: { doc: P.doc, version: P.version } });
    P.version = r.version;
    P.dirty = snap() !== sent;
    bus.emit('save', P.dirty ? 'dirty' : 'saved');
  } catch (err) {
    if (err.status === 409 && err.data?.project) {
      // Changed elsewhere (the AI, MCP, another tab): theirs wins; the person's last change can be undone back.
      remember();
      take(err.data.project);
      toast('This project changed somewhere else. You have the newest version (undo brings yours back).');
    } else {
      bus.emit('save', 'error');
    }
  } finally {
    P.saving = false;
    if (P.dirty) scheduleSave();
  }
}
/** Takes a project from the server as the current one. */
export function take(project) {
  P.id = project.id;
  P.version = project.version;
  P.doc = project.doc;
  P.dirty = false;
  changed({ save: false });
  bus.emit('project', project);
  bus.emit('save', 'saved');
  try { localStorage.setItem('hg.editor.last', project.id); } catch { /* */ }
}

export async function openProject(id) {
  const p = await api(`/v1/editor/projects/${id}`);
  undo.length = 0; redo.length = 0;
  P.selection.clips.clear(); P.selection.range = null; P.playhead = 0;
  take(p);
}
export async function createProject(doc) {
  const p = await api('/v1/editor/projects', { body: doc ? { doc } : { title: 'Untitled' } });
  undo.length = 0; redo.length = 0;
  P.selection.clips.clear(); P.selection.range = null; P.playhead = 0;
  take(p);
}
/** Signed in: the last project, else a new one (made from what was built signed out, if anything). */
export async function startSignedIn() {
  const local = readLocal();
  let last = null;
  try { last = localStorage.getItem('hg.editor.last'); } catch { /* */ }
  if (local && !local.id && local.doc?.clips?.length) return createProject(local.doc);
  if (last) { try { return await openProject(last); } catch { /* gone */ } }
  const { items } = await api('/v1/editor/projects');
  if (items.length) return openProject(items[0].id);
  return createProject();
}
export function startSignedOut() {
  const local = readLocal();
  P.id = null;
  P.doc = local?.doc && !local.id ? local.doc : newDoc();
  changed({ save: false });
  bus.emit('save', 'local');
}
function readLocal() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null'); } catch { return null; } }

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
          const want = c.track === 'V1' ? ['video', 'image'] : ['audio'];
          const out = j.outputs.find((o) => want.includes(o.kind)) ?? j.outputs[0];
          if (out) { c.asset = out.asset; if (c.track === 'V1') c.kind = out.kind === 'image' ? 'image' : 'video'; } else c.failed = 'The job made nothing';
        } else c.failed = plainError(j.error ?? j.status);
        delete c.pending;
      }
      changed();
      bus.emit('jobDone', j);
      return;
    }
    bus.emit('jobProgress', { job: jobId, status: j.status, detail: j.detail, ahead: j.queue?.ahead });
    await new Promise((r) => setTimeout(r, 2500));
  }
}

export function startSync() {
  setInterval(async () => {
    if (!P.id || !P.active || document.hidden || P.dirty || P.saving) return;
    try {
      const p = await api(`/v1/editor/projects/${P.id}`);
      if (p.version > P.version && !P.dirty) { take(p); toast('Updated with changes made elsewhere.'); }
    } catch { /* offline: try later */ }
  }, 8000);
  bus.on('doc', watchJobs);
}
