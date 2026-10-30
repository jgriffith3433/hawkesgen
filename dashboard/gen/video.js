// The video editor as a scene editor (scenes.js): the timeline document is project.js's, the viewer player.js's, the
// timeline timeline.js's, the tools tools.js's. This module mounts them for a video scene's tab, saves on the way out,
// and takes other scenes onto the timeline (plug and play): a filmed stage, a rendered image or another video on the
// Video track, an audio scene's mixdown on Music. A clip that plays a scene remembers which render it plays
// (`sceneVersion`); when the scene renders again, the bar offers to update every clip that plays it.

import { $, h, api, toast, bus, icon, mediaInfo } from './lib.js';
import { P, take, save, canUndo, canRedo, doUndo, doRedo, remember, changed, newId, clipEnd } from './project.js';
import { seek } from './player.js';
import { fit } from './timeline.js';
import { openExport } from './tools.js';
import { registerEditor, openScene, kindInfo, refreshBar } from './scenes.js';

let stale = [];

registerEditor({
  kind: 'video', label: 'Video', icon: 'film', panel: null,
  async mount(scene) {
    P.active = true;
    take(scene);
    try { localStorage.setItem('hg.editor.last', scene.id); } catch { /* */ }
    P.selection.clips.clear();
    P.selection.range = null;
    setTimeout(fit, 30);
    checkStale(scene.uses ?? []);
  },
  async unmount() { await save(); P.active = false; $('#staleBar')?.remove(); },
  undo: doUndo, redo: doRedo, canUndo, canRedo,
  action: { label: 'Export', icon: 'download', run: () => openExport() },
  rename(title) { remember(); P.doc.title = title; changed(); },
  accepts: (it) => Boolean(it.scene || ['video', 'image', 'audio'].includes(it.assetKind) || it.asset),
  async drop(it) {
    if (it.asset) return placeFile(it.asset, it.assetKind, it.title);
    await placeScene(it);
  },
  uses: (s) => [{ label: 'Add to this timeline', run: () => placeScene({ scene: s.id, kind: s.kind, title: s.title, render: s.render }) }],
});

async function placeFile(asset, kind, title) {
  const { placeAsset } = await import('./media.js');
  return placeAsset({ id: asset, kind, title });
}

/**
 * A scene on the timeline: its render plays (a stage's film or photo, an image, a video's export on Video; an audio
 * scene's mixdown on Music). A scene with no render yet opens so it can be rendered.
 */
export async function placeScene(it, { track, start } = {}) {
  const r = it.render ?? (await api(`/v1/scenes/${it.scene}`)).doc.render;
  if (!r?.asset) {
    toast(`"${it.title}" has no render yet: render it, then add it.`, { action: 'Open it', onAction: () => openScene(it.scene) });
    return null;
  }
  if (it.kind === 'character') { toast('A character goes on a stage, not a timeline.'); return null; }
  const kind = r.kind === 'audio' ? 'audio' : r.kind === 'image' ? 'image' : 'video';
  const info = await mediaInfo(r.asset, kind);
  const t = track ?? (kind === 'audio' ? 'A1' : 'V1');
  remember();
  const len = info.duration ?? (kind === 'image' ? 3 : 5);
  const c = { id: newId(), track: t, kind: t === 'V1' ? kind : 'audio', asset: r.asset, scene: it.scene, sceneVersion: r.version, start: start ?? (t === 'V1' ? Number.MAX_SAFE_INTEGER : P.playhead), in: 0, out: len, duration: kind === 'image' ? null : info.duration ?? null, label: it.title };
  P.doc.clips.push(c);
  changed();
  P.selection.clips.clear();
  P.selection.clips.add(c.id);
  bus.emit('selection');
  if (t === 'V1') seek(clipEnd(P.doc.clips.find((x) => x.id === c.id) ?? c));
  toast(`Added "${it.title}". It updates when you render that ${kindInfo(it.kind).label.toLowerCase()} again.`);
  return c;
}

/** Clips whose scene rendered again since they were placed: a bar offers to bring them up to date. */
function checkStale(uses) {
  $('#staleBar')?.remove();
  stale = [];
  for (const u of uses) {
    if (!u.render?.asset) continue;
    const clips = P.doc.clips.filter((c) => c.scene === u.id && (c.sceneVersion ?? 0) < u.render.version && c.asset !== u.render.asset);
    if (clips.length) stale.push({ u, clips });
  }
  if (!stale.length) return;
  const n = stale.reduce((a, s) => a + s.clips.length, 0);
  const bar = h('div', { class: 'stale-bar', id: 'staleBar' }, icon('sparkle'),
    h('span', {}, `${stale.map((s) => `"${s.u.title}"`).join(', ')} rendered again since ${n === 1 ? 'its clip was' : 'their clips were'} placed.`),
    h('button', { class: 'primary small', onclick: () => updateStale() }, 'Update'), h('button', { class: 'icon-btn small', title: 'Not now', onclick: () => bar.remove() }, icon('close')));
  $('#viewerWrap').prepend(bar);
}
async function updateStale() {
  remember();
  for (const { u, clips } of stale) {
    const info = await mediaInfo(u.render.asset, u.render.kind === 'audio' ? 'audio' : u.render.kind === 'image' ? 'image' : 'video');
    for (const c of clips) {
      c.asset = u.render.asset;
      c.sceneVersion = u.render.version;
      if (info.duration) { c.duration = info.duration; c.out = Math.min(c.out, info.duration); if (c.out <= c.in) { c.in = 0; c.out = info.duration; } }
    }
  }
  changed();
  $('#staleBar')?.remove();
  toast('Updated.');
  refreshBar();
}
