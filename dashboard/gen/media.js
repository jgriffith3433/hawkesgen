// The left pane. Media: the library, everything the account made or uploaded (pictures, clips, sounds, 3D models) (search, filter, drag onto the timeline, click to look
// at it), uploads by button or drop (converted on Gen when a format needs it), and work in progress. Create (every tool) is studio.js.
// Also the one way every tool runs (runJob).

import { $, $$, h, api, toast, fileUrl, fmt, bus, icon, mediaInfo, plainError, ApiError } from './lib.js';
import { P, addClip, newId, changed, remember, clipEnd, isMagnetic, defaultTrack, isVisual, trackOf, mainTrack } from './project.js';
import { showSource, seek } from './player.js';
import { state, needSignIn, openAccount, refreshCredits } from './account.js';
import { touchDrag } from './dragdrop.js';

const M = { kind: '', q: '', items: [], inflight: new Map() };

export function initMedia() {
  $$('#paneTabs button').forEach((b) => b.addEventListener('click', () => showPane(b.dataset.pane)));
  $$('#mediaFilter .chip').forEach((c) => c.addEventListener('click', () => {
    $$('#mediaFilter .chip').forEach((x) => x.classList.toggle('on', x === c));
    M.kind = c.dataset.kind;
    loadMedia();
  }));
  let qt = 0;
  $('#mediaSearch').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { M.q = e.target.value.trim(); loadMedia(); }, 250); });
  $('#uploadBtn').addEventListener('click', () => $('#uploadInput').click());
  $('#uploadInput').addEventListener('change', (e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; uploadFiles(files); });
  bus.on('signedIn', loadMedia);
  bus.on('ready', loadMedia);
  bus.on('jobDone', () => loadMedia());
  bus.on('placeAsset', ({ asset, track, start }) => placeAsset(asset, { track, start }));
  loadMedia();
}

export function showPane(name) {
  $$('#paneTabs button').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
  $$('.pane-body').forEach((p) => { p.hidden = p.id !== `pane-${name}`; });
  if (name === 'scenes') import('./scenes.js').then((s) => s.loadList()).catch(() => {});
}

export async function loadMedia() {
  const grid = $('#mediaGrid');
  if (!state.user) {
    grid.replaceChildren(h('div', { class: 'empty-note' }, h('p', {}, 'Your images, clips and sounds live here.'), h('button', { class: 'primary small', onclick: () => needSignIn(loadMedia, 'login') }, 'Sign in')));
    return;
  }
  try {
    const q = new URLSearchParams({ limit: '120', project: state.user.project });
    if (M.kind) q.set('kind', M.kind);
    if (M.q) q.set('q', M.q);
    const r = await api(`/v1/assets?${q}`);
    M.items = (r.items ?? []).filter((a) => ['image', 'video', 'audio', 'mesh', 'file'].includes(a.kind));
  } catch { M.items = []; }
  drawMedia();
}

function drawMedia() {
  const grid = $('#mediaGrid');
  const busy = [...M.inflight.values()].map((j) => h('div', { class: 'tile busy' }, h('div', { class: 'working' }, j.step || 'Starting'), h('div', { class: 'tile-cap' }, j.label)));
  const tiles = M.items.map(tileFor);
  grid.replaceChildren(...busy, ...tiles);
  if (!busy.length && !tiles.length) grid.append(h('div', { class: 'empty-note' }, h('p', {}, M.q || M.kind ? 'Nothing matches.' : 'Nothing here yet.'), h('p', { class: 'muted' }, 'Upload files, or make something in Create.')));
}

const durationOf = (a) => a.meta?.duration ?? null;
function tileFor(a) {
  const prompt = a.recipe?.params?.prompt ?? a.recipe?.params?.text ?? a.title ?? '';
  const media = a.kind === 'image' ? h('img', { src: fileUrl(a.id), alt: '', loading: 'lazy', draggable: 'false' })
    : a.kind === 'video' ? h('video', { src: `${fileUrl(a.id)}#t=0.1`, muted: true, playsinline: true, preload: 'metadata', onmouseenter: (e) => e.target.play().catch(() => {}), onmouseleave: (e) => { e.target.pause(); } })
    : a.kind === 'audio' ? h('div', { class: 'tile-audio' }, icon(a.tool === 'audio.music' ? 'music' : a.tool?.startsWith('audio.voice') ? 'mic' : 'volume', 'ico big'))
    : h('div', { class: 'tile-audio tile-mesh' }, icon(a.kind === 'mesh' ? 'cube' : 'folder', 'ico big'));
  const d = durationOf(a);
  const el = h('div', { class: `tile kind-${a.kind}`, draggable: 'true', tabindex: '0', title: `${prompt ? `${prompt}
` : ''}Double-click to look at it; drag it onto a track` },
    media,
    d ? h('span', { class: 'badge' }, fmt(d, 0)) : '',
    h('div', { class: 'tile-cap' }, a.title || prompt || a.kind),
    onTimeline(a.kind) ? h('button', { class: 'tile-add', title: 'Add to the timeline at the playhead', onclick: (e) => { e.stopPropagation(); placeAsset(assetLite(a)); } }, icon('plus')) : h('span', { class: 'badge kind' }, assetKindLabel(a.kind)));
  // One click picks a tile (the "+" adds it); a double-click looks at it in the center (J, 2026-10-30).
  el.addEventListener('click', () => { $$('#mediaGrid .tile.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); });
  el.addEventListener('dblclick', () => openAsset(a));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openAsset(a); });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-hg-asset', JSON.stringify(assetLite(a)));
    e.dataTransfer.effectAllowed = 'copy';
  });
  // Phones: hold a tile, then drag it onto a track (dragdrop.js).
  if (onTimeline(a.kind)) touchDrag(el, () => { const x = assetLite(a); return { asset: x.id, assetKind: x.kind, title: x.title, duration: x.duration }; });
  return el;
}
const onTimeline = (kind) => ['image', 'video', 'audio'].includes(kind);
const assetLite = (a) => ({ id: a.id, kind: a.kind, title: a.title ?? a.recipe?.params?.prompt ?? '', prompt: a.recipe?.params?.prompt ?? '', duration: durationOf(a), width: a.meta?.width ?? a.recipe?.params?.width ?? null, height: a.meta?.height ?? a.recipe?.params?.height ?? null, tool: a.tool });

export async function openAsset(a) {
  const lite = a.id && a.kind ? { ...assetLite(a), tool: a.tool, recipe: a.recipe ?? null } : a;
  const info = onTimeline(lite.kind) ? await mediaInfo(lite.id, lite.kind) : {};
  showSource({ ...lite, width: info.width ?? lite.width, height: info.height ?? lite.height, duration: info.duration ?? lite.duration });
}

/** A sound's usual track by what made it: voices on a voice track, effects on a sound track, the rest on music. */
function soundTrack(a) {
  const want = a.tool?.startsWith('audio.voice') || a.tool === 'audio.revoice' ? /voice|dialog|line/i : a.tool?.startsWith('audio.sfx') ? /sound|sfx|effect/i : /music|score|song/i;
  return P.doc.tracks.find((t) => t.role === 'audio' && !t.locked && want.test(t.name))?.id ?? null;
}
/**
 * Puts a library file on the timeline at the playhead: on the track picked (the selected one), whatever its kind; with
 * none picked, on the track that fits (a sound by what made it).
 */
export async function placeAsset(a, { track, start, place } = {}) {
  if (!onTimeline(a.kind)) { toast(`A ${assetKindLabel(a.kind).toLowerCase()} can't go on the timeline.`); return null; }
  const info = await mediaInfo(a.id, a.kind);
  const kind = a.kind;
  const picked = track ?? (trackOf(P.selection.track) && !trackOf(P.selection.track).locked ? P.selection.track : null);
  const t = picked ?? (kind === 'audio' ? soundTrack(a) : null) ?? defaultTrack(kind);
  const c = addClip({ track: t, asset: a.id, kind, duration: info.duration ?? a.duration ?? null, start: start ?? (P.kind === 'image' && kind === 'image' ? 0 : P.playhead), label: a.title || a.prompt || undefined, place });
  P.selection.clips.clear();
  P.selection.clips.add(c.id);
  P.selection.track = c.track;
  bus.emit('selection');
  // Like any editor: the playhead moves past what was just put on a magnetic track, so the next one follows it.
  if ((isMagnetic(c.track) || c.track === mainTrack()?.id) && start == null) seek(clipEnd(c));
  return c;
}

// ------------------------------------------------------------------ running tools
/**
 * Runs one tool for the person. `place`: { replace: clipId } swaps that clip's file when done; { track, start } puts a
 * waiting clip on the timeline now; nothing: the result goes to Media. Returns the finished job (or throws).
 */
export function runJob({ tool, params = {}, inputs = {}, label, place, onStart } = {}) {
  return new Promise((resolve, reject) => needSignIn(async () => {
    try {
      const r = await api('/v1/jobs', { body: { project: state.user.project, tool, params, inputs, labels: { title: label ?? tool, ...(P.id ? { editor: P.id } : {}) } } });
      const job = r.jobs[0];
      onStart?.(job.id);
      if (place?.replace) {
        const c = P.doc.clips.find((x) => x.id === place.replace);
        if (c) { remember(); Object.assign(c, { job: job.id, pending: true, label: label ?? c.label }); delete c.failed; changed(); }
      } else if (place?.track) {
        remember();
        const kind = tool.startsWith('audio.') ? 'audio' : tool.startsWith('image.') ? 'image' : 'video';
        const track = trackOf(place.track) ? place.track : kind === 'audio' ? soundTrack({ tool }) ?? defaultTrack('audio') : defaultTrack(kind);
        const c = { id: newId(), track, kind, start: place.start ?? P.playhead, in: 0, out: place.seconds ?? 5, duration: kind === 'image' ? null : place.seconds ?? null, job: job.id, pending: true, label: label ?? tool };
        if (isMagnetic(track)) c.start = place.start ?? Number.MAX_SAFE_INTEGER;
        P.doc.clips.push(c);
        changed();
      }
      const mine = { label: label ?? tool, step: 'In line' };
      M.inflight.set(job.id, mine);
      drawMedia();
      const done = await waitJob(job.id, (s) => { mine.step = s; drawMedia(); bus.emit('jobProgress', { job: job.id, step: s }); });
      M.inflight.delete(job.id);
      refreshCredits();
      loadMedia();
      // A replaced clip keeps its spot; when the new file is longer or shorter, its length follows.
      if (place?.replace || place?.track) {
        const out = done.outputs[0];
        for (const c of P.doc.clips.filter((x) => x.job === job.id)) {
          if (!out) continue;
          const info = await mediaInfo(out.asset, out.kind);
          c.asset = out.asset;
          if (isVisual(c) && (out.kind === 'image' || out.kind === 'video')) c.kind = out.kind;
          if (c.kind === 'image') { c.duration = null; delete c.pending; continue; }
          if (info.duration) { c.duration = info.duration; if (place.track || c.out > info.duration) { c.in = Math.min(c.in, Math.max(0, info.duration - 0.1)); c.out = place.track ? info.duration : Math.min(c.out, info.duration); } }
          delete c.pending;
        }
        changed();
      }
      resolve(done);
    } catch (err) {
      M.inflight.forEach((v, k) => { if (v.label === (label ?? tool)) M.inflight.delete(k); });
      drawMedia();
      for (const c of P.doc.clips.filter((x) => x.pending && !x.asset && x.label === (label ?? tool))) { c.failed = plainError(err.message); delete c.pending; }
      changed();
      toast(plainError(err.message));
      if (err.status === 402) openAccount();
      reject(err);
    }
  }, 'login'));
}
export async function waitJob(id, onStep) {
  for (;;) {
    const j = await api(`/v1/jobs/${id}`);
    if (j.status === 'done') return j;
    if (j.status === 'failed' || j.status === 'cancelled') throw new ApiError(j.error || `The job was ${j.status}`, 0);
    onStep?.(j.status === 'queued' ? (j.queue?.ahead ? `In line (${j.queue.ahead} ahead)` : 'In line') : j.detail || 'Working');
    await new Promise((r) => setTimeout(r, 1500));
  }
}
export async function quote(tool, params) {
  if (!state.user) return null;
  try { return await api('/v1/billing/quote', { body: { tool, params, project: state.user.project } }); } catch { return null; }
}
export const credits = (q) => (q ? `${q.credits} credit${q.credits === 1 ? '' : 's'}` : '');

// ------------------------------------------------------------------ uploads
const OK_VIDEO = /^video\/(mp4|webm)$/;
export async function uploadFiles(files, { toTimeline = false } = {}) {
  if (!files.length) return;
  needSignIn(async () => {
    showPane('media');
    for (const file of files) {
      if (file.size > 1.5 * 1024 * 1024 * 1024) { toast(`${file.name} is over 1.5 GB.`); continue; }
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') || /\.(mov|mkv|avi|m4v|webm|mp4)$/i.test(file.name) ? 'video' : file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name) ? 'audio' : null;
      if (!kind) { toast(`${file.name}: images, videos and sounds only.`); continue; }
      const key = `up_${newId()}`;
      const mine = { label: file.name, step: 'Uploading' };
      M.inflight.set(key, mine);
      drawMedia();
      try {
        const r = await fetch(`/v1/assets?project=${encodeURIComponent(state.user.project)}&title=${encodeURIComponent(file.name)}`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': file.name }, body: file,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status);
        let asset = { id: j.id ?? j.asset?.id, kind: j.kind ?? kind, title: file.name };
        // Gen converts what browsers or the tools can't use (mov, mkv, HEVC, webp...) and says which job does it.
        const norm = j.normalize?.job ?? j.normalizeJob ?? null;
        if (norm) {
          mine.step = 'Converting';
          drawMedia();
          const done = await waitJob(typeof norm === 'string' ? norm : norm.id, (s) => { mine.step = `Converting: ${s}`; drawMedia(); });
          const out = done.outputs.find((o) => o.kind === kind) ?? done.outputs[0];
          asset = { id: out.asset, kind: out.kind, title: file.name };
        } else if (kind === 'video' && !OK_VIDEO.test(file.type)) {
          toast(`${file.name} may not play in your browser; it still works in Gen's tools.`);
        }
        M.inflight.delete(key);
        if (toTimeline) await placeAsset(asset);
      } catch (err) {
        M.inflight.delete(key);
        toast(`${file.name}: ${plainError(err.message)}`);
      }
      drawMedia();
    }
    loadMedia();
  }, 'login');
}

/** A library kind as a person says it. */
export const assetKindLabel = (k) => ({ image: 'Image', video: 'Clip', audio: 'Sound', mesh: '3D model', text: 'Text', file: 'File' }[k] ?? 'File');
