// One scene's document for the image, audio and character editors: loaded from Gen, changed here (each change an undo
// step), saved a moment later with its version (a save that crosses one made elsewhere takes the newer document, and
// undo brings the person's back), and kept up to date while elements wait on jobs (Gen fills them in when the jobs
// end: src/scenekinds.ts). The video and stage editors have their own (project.js, director.js).

import { api, bus, toast } from './lib.js';

/** New elements get their ids at once (the server keeps them), so they can be found before the next save. */
const PREFIX = { layers: 'l', tracks: 't', clips: 'k', pictures: 'p' };
function giveIds(o) {
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (!Array.isArray(v)) { if (v && typeof v === 'object') giveIds(v); continue; }
    for (const x of v) {
      if (PREFIX[k] && x && typeof x === 'object' && !x.id) x.id = `${PREFIX[k]}_${Math.random().toString(36).slice(2, 10)}`;
      giveIds(x);
    }
  }
}

export function sceneDoc({ onChange }) {
  const S = { scene: null, doc: null, version: 0, back: [], fwd: [], dirty: false, saving: false, timer: 0, poll: 0 };
  const snap = () => JSON.stringify(S.doc);

  function take(scene, { keepHistory = false } = {}) {
    S.scene = scene;
    S.doc = scene.doc;
    S.version = scene.version;
    S.dirty = false;
    if (!keepHistory) { S.back.length = 0; S.fwd.length = 0; }
    bus.emit('history');
    bus.emit('save', 'saved');
    bus.emit('sceneTitle', { id: scene.id, title: scene.title });
    onChange?.();
    follow();
  }

  /** A change: `fn` changes the document; it's one undo step (unless history: false) and is saved soon. */
  function change(fn, { history = true, redraw = true } = {}) {
    if (!S.doc) return;
    if (history) { S.back.push(snap()); if (S.back.length > 100) S.back.shift(); S.fwd.length = 0; }
    fn(S.doc);
    giveIds(S.doc);
    S.dirty = true;
    bus.emit('history');
    bus.emit('save', 'dirty');
    if (redraw) onChange?.();
    clearTimeout(S.timer);
    S.timer = setTimeout(save, 700);
  }
  function undo() { if (!S.back.length) return; S.fwd.push(snap()); S.doc = JSON.parse(S.back.pop()); S.dirty = true; bus.emit('history'); onChange?.(); clearTimeout(S.timer); S.timer = setTimeout(save, 500); }
  function redo() { if (!S.fwd.length) return; S.back.push(snap()); S.doc = JSON.parse(S.fwd.pop()); S.dirty = true; bus.emit('history'); onChange?.(); clearTimeout(S.timer); S.timer = setTimeout(save, 500); }

  async function save() {
    clearTimeout(S.timer);
    if (!S.scene || S.saving || !S.dirty) return;
    S.saving = true;
    bus.emit('save', 'saving');
    const sent = snap();
    try {
      const r = await api(`/v1/scenes/${S.scene.id}`, { method: 'PUT', body: { doc: S.doc, version: S.version } });
      S.version = r.version;
      S.scene = { ...S.scene, version: r.version, title: r.title, uses: r.uses };
      // The server's ids for new elements (and its tidying) without losing edits made while saving.
      if (snap() === sent) { S.doc = r.doc; onChange?.(); }
      S.dirty = snap() !== JSON.stringify(r.doc);
      bus.emit('save', S.dirty ? 'dirty' : 'saved');
      bus.emit('sceneTitle', { id: S.scene.id, title: r.title });
    } catch (err) {
      if (err.status === 409 && err.data?.scene) {
        S.back.push(snap());
        take(err.data.scene, { keepHistory: true });
        toast('This scene changed somewhere else: you have the newest (undo brings yours back).');
      } else bus.emit('save', 'error');
    } finally {
      S.saving = false;
      if (S.dirty) S.timer = setTimeout(save, 1500);
      follow();
    }
  }

  /** While anything waits on a job, Gen is asked again every few seconds (it fills them in when the jobs end). */
  function follow() {
    clearTimeout(S.poll);
    if (!S.scene || !JSON.stringify(S.doc).includes('"pending"')) return;
    S.poll = setTimeout(async () => {
      if (!S.scene || S.dirty || S.saving) return follow();
      try {
        const r = await api(`/v1/scenes/${S.scene.id}`);
        if (r.version > S.version && !S.dirty) { take(r, { keepHistory: true }); bus.emit('jobDone'); }
        else follow();
      } catch { follow(); }
    }, 3000);
  }

  function stop() { clearTimeout(S.timer); clearTimeout(S.poll); }

  return {
    get scene() { return S.scene; }, get doc() { return S.doc; },
    take, change, undo, redo, save, stop,
    canUndo: () => S.back.length > 0, canRedo: () => S.fwd.length > 0,
    /** Marks an element as waiting on a job (it fills in when the job ends, here or after a reload). */
    wait(el, jobId) { el.pending = jobId; delete el.failed; },
  };
}
