// The left pane. Media: the library, everything the account made or uploaded (pictures, clips, sounds, 3D models) (search, filter, drag onto the timeline, click to look
// at it), uploads by button or drop (converted on Gen when a format needs it), and work in progress. Create (every tool) is studio.js.
// Also the one way every tool runs (runJob).

import { needsGlb, prepareModels, MODEL_FILE } from './model3d.js';
import { trouble, troubleNote, explain } from './trouble.js';
import { $, $$, h, api, toast, fileUrl, thumbUrl, keyedRedraw, fmt, bus, icon, mediaInfo, plainError, ApiError, friendly, jobStatusText } from './lib.js';
import { P, addClip, newId, changed, remember, clipEnd, isMagnetic, defaultTrack, isVisual, trackOf, mainTrack, startFor, PROGRESS, stopClip } from './project.js';
import { showSource, seek } from './player.js';
import { state, needSignIn, openAccount, refreshCredits } from './account.js';
import { touchDrag } from './dragdrop.js';
import { jobWatch } from './jobwatch.js';

// picked: the tiles the person picked, by asset id with what the AI is told about each (J, 2026-10-30: they were
// dropped whenever Media refreshed, and the AI didn't know about them).
const M = { kind: '', q: '', items: [], inflight: new Map(), picked: new Map() };
/** What's picked in Media, for the AI's selection (id, kind, title), oldest pick first. */
export const pickedMedia = () => [...M.picked.values()];
/** Drops the picks (the chip's ×, Escape in Media). */
export function clearPicked() { if (!M.picked.size) return; M.picked.clear(); $('#mediaGrid .tile.sel').forEach((x) => x.classList.remove('sel')); bus.emit('mediaPick'); }
function pickTile(a, el, add) {
  const lite = { id: a.id, kind: a.kind, title: String(a.title || a.recipe?.params?.prompt || a.kind).slice(0, 120) };
  if (add) { if (M.picked.has(a.id)) M.picked.delete(a.id); else M.picked.set(a.id, lite); }
  else { M.picked.clear(); M.picked.set(a.id, lite); }
  $('#mediaGrid .tile').forEach((x) => x.classList.toggle('sel', M.picked.has(x.dataset.asset)));
  bus.emit('mediaPick');
}

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
  bus.on('jobDone', () => loadMediaSoon());
  // New files from anywhere (the AI in another tab, a chain, another device): Gen's own job stream says when one of
  // this account's jobs finishes (J, 2026-10-30: Media sometimes needed a reload to show new things).
  bus.on('signedIn', followJobs);
  bus.on('ready', followJobs);
  document.addEventListener('visibilitychange', () => { followJobs(); if (!document.hidden) loadMediaSoon(); });
  followJobs();
  // Tiles say which files the scene in front uses (redrawn when it changes, at most every second).
  bus.on('progressText', () => { clearTimeout(M.pt); M.pt = setTimeout(drawMedia, 300); });
  let usedT = 0;
  bus.on('doc', () => { clearTimeout(usedT); usedT = setTimeout(drawMedia, 1000); });
  bus.on('placeAsset', ({ asset, track, start }) => placeAsset(asset, { track, start }));
  loadMedia();
}

export function showPane(name) {
  $$('#paneTabs button').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
  $$('.pane-body').forEach((p) => { p.hidden = p.id !== `pane-${name}`; });
  $('#app').dataset.pane = name;
  if (name === 'scenes') import('./scenes.js').then((s) => s.loadList()).catch(() => {});
}

/**
 * Gen's job stream (GET /v1/events, this account's jobs only) while the page is on screen: a job that finishes
 * reloads Media. Closed while the page is hidden, so an open tab in the background never keeps Gen awake.
 */
let stopJobs = null;
function followJobs() {
  const want = Boolean(state.user) && !document.hidden;
  if (!want) { stopJobs?.(); stopJobs = null; return; }
  if (stopJobs) return;
  // The page's one stream (jobwatch.js), reopened after a restart or a deploy; what finished meanwhile shows on the reload.
  const asked = jobWatch().then((w) => w.listen((j) => { if (j?.status === 'done') loadMediaSoon(); }, loadMediaSoon));
  stopJobs = () => { void asked.then((stop) => stop()); };
}
let soonT = 0;
const loadMediaSoon = () => { clearTimeout(soonT); soonT = setTimeout(loadMedia, 700); };

/** The newest request wins: an older answer that arrives late never replaces a newer list. */
let loadSeq = 0;
export async function loadMedia() {
  const grid = $('#mediaGrid');
  const seq = ++loadSeq;
  if (!state.user) {
    grid.replaceChildren(h('div', { class: 'empty-note' }, h('p', {}, 'Your images, clips and sounds live here.'), h('button', { class: 'primary small', onclick: () => needSignIn(loadMedia, 'login') }, 'Sign in')));
    return;
  }
  try {
    const q = new URLSearchParams({ limit: '120', project: state.user.project });
    if (M.kind) q.set('kind', M.kind);
    if (M.q) q.set('q', M.q);
    const r = await api(`/v1/assets?${q}`);
    if (seq !== loadSeq) return;
    M.items = (r.items ?? []).filter((a) => ['image', 'video', 'audio', 'mesh', 'file'].includes(a.kind));
    M.loadError = null;
  } catch (err) {
    if (seq !== loadSeq) return;
    // A failed reload keeps what's shown; with nothing shown, the grid says why and offers the next step.
    M.loadError = err;
  }
  drawMedia();
}

/** How many things are being made or uploaded now (the bar's "Making" pill shows it). */
export const busyCount = () => M.inflight.size + (P.active ? P.doc.clips.filter((c) => c.pending && c.job && !M.inflight.has(c.job)).length : 0);
/**
 * Draws Media in place (keyedRedraw): a tile already on screen keeps its picture or clip, so a reload, a job's progress
 * or an edit to the scene never makes the grid flash or the clips reload (J, 2026-11-01: "it refreshes a lot").
 */
function drawMedia() {
  bus.emit('busy', M.inflight.size);
  // Signed out, loadMedia's "Sign in" note stays (a scene edit used to swap it for "Nothing here yet").
  if (!state.user) return;
  const grid = $('#mediaGrid');
  const rows = [];
  for (const [k, j] of M.inflight) {
    rows.push({ key: `busy:${k}`, sig: 'busy', make: () => busyTile(k.startsWith('j_') ? () => api(`/v1/jobs/${k}/cancel`, { method: 'POST' }).catch(() => {}) : null),
      update: (el) => setBusy(el, j.step || 'Starting', j.label) });
  }
  // The scene's clips still being made (by the AI, or before a reload) show here too, with the same status.
  for (const c of P.active ? P.doc.clips.filter((x) => x.pending && x.job && !M.inflight.has(x.job)) : []) {
    rows.push({ key: `clip:${c.id}`, sig: 'busy', make: () => busyTile(() => stopClip(c.id), 'On the timeline; it fills in when it\'s made'),
      update: (el) => setBusy(el, PROGRESS.get(c.job) ?? 'Making', c.label ?? 'Being made') });
  }
  for (const a of M.items) rows.push({ key: a.id, sig: tileSig(a), make: () => tileFor(a), update: (el) => decorate(el, a) });
  // A failed load says why above the tiles (or instead of them), with the next step.
  grid.parentElement.querySelector('#mediaTrouble')?.remove();
  if (M.loadError) { const n = troubleNote(M.loadError, loadMedia); n.id = 'mediaTrouble'; if (rows.length) grid.before(n); else { grid.replaceChildren(n); return; } }
  if (!rows.length) {
    grid.replaceChildren(h('div', { class: 'empty-note' }, h('p', {}, M.q || M.kind ? 'Nothing matches.' : 'Nothing here yet.'),
      M.q || M.kind ? '' : h('div', { class: 'row' }, h('button', { class: 'ghost small', onclick: () => $('#uploadInput').click() }, icon('upload'), 'Upload'), h('button', { class: 'primary small', onclick: () => showPane('generate') }, icon('sparkle'), 'Make something'))));
    return;
  }
  keyedRedraw(grid, rows);
}
function busyTile(onStop, title) {
  return h('div', { class: 'tile busy', title }, h('div', { class: 'working' }), h('div', { class: 'tile-cap' }),
    onStop ? h('button', { class: 'tile-stop', title: 'Stop making it', onclick: (e) => { e.stopPropagation(); onStop(); } }, icon('close')) : '');
}
function setBusy(el, step, label) {
  const w = el.querySelector('.working');
  const cap = el.querySelector('.tile-cap');
  if (w.textContent !== step) w.textContent = step;
  if (cap.textContent !== label) cap.textContent = label;
}
/** What a tile shows; when it changes, the tile is made again (the picks and "In use" change in place: decorate). */
const tileSig = (a) => JSON.stringify([a.kind, a.sha256, a.title, a.tool, a.recipe?.params?.prompt, a.recipe?.params?.text, durationOf(a)]);
/** Picked and "In use": changed on the tile itself, so its picture or clip stays as it is. */
function decorate(el, a) {
  const used = Boolean(P.active && P.doc.clips.some((c) => c.asset === a.id));
  el.classList.toggle('sel', M.picked.has(a.id));
  if (el.classList.contains('used') === used) return;
  el.classList.toggle('used', used);
  if (used) el.querySelector('.tile-cap')?.before(h('span', { class: 'badge used', title: 'It\'s in the scene in front' }, 'In use'));
  else el.querySelector('.badge.used')?.remove();
}

/**
 * A clip tile's link, given to the element only when it scrolls near the screen: a library of forty clips otherwise opens
 * forty connections for their first frames while the editor is still starting (the phone, 4x slower, felt it most).
 */
const SEEN = typeof IntersectionObserver === 'function' ? new IntersectionObserver((list) => {
  for (const e of list) if (e.isIntersecting) { e.target.src = e.target.dataset.src; SEEN.unobserve(e.target); }
}, { rootMargin: '200px' }) : null;
function lazySrc(src) {
  if (!SEEN) return { src };
  return { 'data-src': src };
}
const durationOf = (a) => a.meta?.duration ?? null;
function tileFor(a) {
  // The tile stays while Media is read again: what it does uses the newest copy of the file's row.
  const now = () => M.items.find((x) => x.id === a.id) ?? a;
  const prompt = a.recipe?.params?.prompt ?? a.recipe?.params?.text ?? a.title ?? '';
  const media = a.kind === 'image' ? h('img', { src: thumbUrl(a.id, a.sha256), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' })
    : a.kind === 'video' ? h('video', { ...lazySrc(`${fileUrl(a.id, a.sha256)}#t=0.1`), muted: true, playsinline: true, preload: 'metadata', onmouseenter: (e) => e.target.play().catch(() => {}), onmouseleave: (e) => { e.target.pause(); } })
    : a.kind === 'audio' ? h('div', { class: 'tile-audio' }, icon(a.tool === 'audio.music' ? 'music' : a.tool?.startsWith('audio.voice') ? 'mic' : 'volume', 'ico big'))
    : h('div', { class: 'tile-audio tile-mesh' }, icon(a.kind === 'mesh' ? 'cube' : 'folder', 'ico big'));
  if (a.kind === 'video') SEEN?.observe(media);
  const d = durationOf(a);
  const el = h('div', { class: `tile kind-${a.kind}`, 'data-asset': a.id, draggable: 'true', tabindex: '0', title: `${prompt ? `${prompt}
` : ''}Double-click to look at it; drag it onto a track` },
    media,
    h('button', { class: 'tile-info', title: 'Details', 'aria-label': 'Details', onclick: (e) => { e.stopPropagation(); openDrawer(now()); } }, icon('info')),
    d ? h('span', { class: 'badge' }, fmt(d, 0)) : '',
    h('div', { class: 'tile-cap' }, a.title || prompt || a.kind),
    onTimeline(a.kind) ? h('button', { class: 'tile-add', title: 'Add to the timeline at the playhead', onclick: (e) => { e.stopPropagation(); placeAsset(assetLite(now())); } }, icon('plus')) : h('span', { class: 'badge kind' }, assetKindLabel(a.kind)));
  // One click picks a tile (Ctrl or Cmd adds to the picks; the "+" adds it to the timeline); a double-click looks at it in
  // the center (J, 2026-10-30). Picks are kept by id, so a refresh keeps them, and the AI is told about them.
  el.addEventListener('click', (e) => pickTile(now(), el, e.ctrlKey || e.metaKey));
  el.addEventListener('dblclick', () => openDrawer(now()));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDrawer(now()); if (e.key === 'Escape') clearPicked(); });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-hg-asset', JSON.stringify(assetLite(now())));
    e.dataTransfer.effectAllowed = 'copy';
  });
  // Any tile drags (mouse or finger); where it's dropped says whether it fits there and why not.
  touchDrag(el, () => { const x = assetLite(now()); return { asset: x.id, assetKind: x.kind, title: x.title, duration: x.duration }; });
  return el;
}
const onTimeline = (kind) => ['image', 'video', 'audio'].includes(kind);
const assetLite = (a) => ({ id: a.id, kind: a.kind, title: a.title ?? a.recipe?.params?.prompt ?? '', prompt: a.recipe?.params?.prompt ?? '', duration: durationOf(a), width: a.meta?.width ?? a.recipe?.params?.width ?? null, height: a.meta?.height ?? a.recipe?.params?.height ?? null, tool: a.tool });

/**
 * The detail drawer: a bigger look at one library file with the words that made it, what made it and when, and
 * Use in timeline (Esc or the backdrop closes it).
 */
export function openDrawer(a) {
  closeDrawer();
  const prompt = a.recipe?.params?.prompt ?? a.recipe?.params?.text ?? '';
  const url = fileUrl(a.id, a.sha256);
  const big = a.kind === 'image' ? h('img', { src: url, alt: a.title || prompt || 'Image' })
    : a.kind === 'video' ? h('video', { src: url, controls: true, playsinline: true, preload: 'metadata' })
    : a.kind === 'audio' ? h('audio', { src: url, controls: true, preload: 'metadata' })
    : h('div', { class: 'tile-audio tile-mesh' }, icon(a.kind === 'mesh' ? 'cube' : 'folder', 'ico big'));
  const row = (k, v) => (v ? h('div', { class: 'dr-row' }, h('span', { class: 'muted' }, k), h('span', {}, String(v))) : '');
  const d = durationOf(a);
  const made = a.created ?? a.createdAt ?? a.created_at;
  const drawer = h('aside', { class: 'media-drawer', role: 'dialog', 'aria-label': 'Asset details', 'data-asset': a.id },
    h('div', { class: 'dr-head' }, h('strong', {}, a.title || assetKindLabel(a.kind)), h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onclick: closeDrawer }, icon('close'))),
    h('div', { class: 'dr-media' }, big),
    h('div', { class: 'dr-label muted small' }, 'Prompt'),
    h('div', { class: 'dr-prompt' }, prompt || 'No prompt: it was uploaded or made without words.'),
    row('Type', assetKindLabel(a.kind)), row('Made with', a.tool), row('Length', d ? fmt(d, 0) : ''),
    row('Size', a.meta?.width && a.meta?.height ? `${a.meta.width} × ${a.meta.height}` : ''), row('Made', made ? new Date(made).toLocaleString() : ''),
    h('div', { class: 'row dr-actions' },
      onTimeline(a.kind) ? h('button', { class: 'primary small', id: 'drawerUse', onclick: async () => { const c = await placeAsset(assetLite(a)); if (c) { closeDrawer(); toast('Added to the timeline.'); } } }, icon('plus'), 'Use in timeline') : h('button', { class: 'primary small', id: 'drawerUse', disabled: true, title: 'A 3D model can\'t go on a timeline. Put it on a stage in the Director.' }, icon('plus'), 'Use in timeline'),
      h('button', { class: 'ghost small', onclick: () => { closeDrawer(); openAsset(a); } }, 'Show in center'),
      h('a', { class: 'ghost small btn', href: url, download: a.title || a.id }, 'Download')));
  const back = h('div', { class: 'media-drawer-back', onclick: closeDrawer });
  const wrap = h('div', { class: 'media-drawer-wrap', id: 'mediaDrawer' }, back, drawer);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeDrawer(); } });
  document.body.append(wrap);
  drawer.tabIndex = -1;
  drawer.focus();
}
export function closeDrawer() { document.getElementById('mediaDrawer')?.remove(); }

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
  const c = addClip({ track: t, asset: a.id, kind, duration: info.duration ?? a.duration ?? null, start: start ?? startFor(t, kind), label: a.title || a.prompt || undefined, place });
  P.selection.clips.clear();
  P.selection.clips.add(c.id);
  P.selection.track = c.track;
  bus.emit('selection');
  // Like any editor: the playhead moves past what was just put on a magnetic track, so the next one follows it.
  // The playhead goes to what was just added, so the center shows it.
  if (start == null && kind !== 'audio') seek(c.start + 0.001);
  return c;
}

// ------------------------------------------------------------------ running tools
/**
 * Runs one tool for the person. `place`: { replace: clipId } swaps that clip's file when done; { track, start } puts a
 * waiting clip on the timeline now; nothing: the result goes to Media. Returns the finished job (or throws).
 */
/** The scene in front (scenes.js): a job made from it inherits its world's look (src/worlds.ts) unless labels.world is "off". */
let frontScene = null;
bus.on('sceneActive', (t) => { frontScene = t?.id ?? null; });
export function runJob({ tool, params = {}, inputs = {}, label, place, onStart, labels = {} } = {}) {
  return new Promise((resolve, reject) => needSignIn(async () => {
    try {
      const r = await api('/v1/jobs', { body: { project: state.user.project, tool, params, inputs, labels: { title: label ?? tool, ...(P.id ? { editor: P.id } : {}), ...(frontScene ? { scene: frontScene } : {}), ...labels } } });
      const job = r.jobs[0];
      refreshCredits(); // the pill follows the charge
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
      if (!place) toast(`${label ?? 'It'} is ready: it's in Media.`, { action: 'Look', onAction: () => { const a = done.outputs.find((o) => !/mask/i.test(o.title ?? '')) ?? done.outputs[0]; if (a) openAsset({ id: a.asset, kind: a.kind, title: label }); } });
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
      for (const c of P.doc.clips.filter((x) => x.pending && !x.asset && x.label === (label ?? tool))) { c.failed = explain(err).text; delete c.pending; }
      changed();
      showError(err);
      reject(err);
    }
  }, 'login'));
}
/** Waits for a job through the page's live stream (jobwatch.js): no asking on a timer. */
export async function waitJob(id, onStep) {
  const j = await (await jobWatch()).follow(id, onStep ? (x) => onStep(jobStatusText(x)) : undefined);
  if (j.status === 'done') return j;
  throw new ApiError(j.error || `The job was ${j.status}`, 0);
}
export async function quote(tool, params) {
  if (!state.user) return null;
  try { return await api('/v1/billing/quote', { body: { tool, params, project: state.user.project } }); } catch { return null; }
}
export const credits = (q) => (q ? `${q.credits} credit${q.credits === 1 ? '' : 's'}` : '');

// ------------------------------------------------------------------ uploads
/** One file up with progress. Resolves { status, j } for any answer; status 0 (offline) rejects like fetch does. */
function sendFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.withCredentials = true;
    x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    x.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onerror = () => reject(new ApiError('Offline', 0));
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch { /* not JSON */ } resolve({ status: x.status, j }); };
    x.send(file);
  });
}
const OK_VIDEO = /^video\/(mp4|webm)$/;
export async function uploadFiles(files, { toTimeline = false, then = null } = {}) {
  if (!files.length) return;
  needSignIn(async () => {
    if (!toTimeline && !then) showPane('media');
    // FBX and OBJ become GLB here first (model3d.js): everything in Gen reads GLB. Pictures dropped with one are its textures.
    if (files.some(needsGlb)) {
      const key = `cv_${newId()}`;
      const mine = { label: 'Converting 3D', step: 'Converting to GLB' };
      M.inflight.set(key, mine);
      drawMedia();
      try {
        const r = await prepareModels(files, (s) => { mine.step = s; drawMedia(); });
        files = r.files;
        r.notes.forEach((n) => toast(n));
      } finally { M.inflight.delete(key); drawMedia(); }
    }
    for (const file of files) {
      if (file.size > 1024 * 1024 * 1024) { toast(`${file.name} is over 1 GB.`); continue; }
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') || /\.(mov|mkv|avi|m4v|webm|mp4)$/i.test(file.name) ? 'video' : file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name) ? 'audio' : MODEL_FILE.test(file.name) ? 'mesh' : null;
      if (!kind) { toast(`${file.name}: images, videos, sounds and 3D models (GLB, FBX, OBJ) only.`); continue; }
      const key = `up_${newId()}`;
      const mine = { label: file.name, step: 'Uploading' };
      M.inflight.set(key, mine);
      drawMedia();
      try {
        // XHR, not fetch: it reports how much has gone up. A refusal (429 too many at once, 413 too big) is worded by the server.
        const { status, j } = await sendFile(`/v1/assets?project=${encodeURIComponent(state.user.project)}&title=${encodeURIComponent(file.name)}`, file, (frac) => {
          mine.step = frac < 1 ? `Uploading ${Math.round(frac * 100)}%` : 'Saving';
          drawMedia();
        });
        if (status < 200 || status >= 300) throw new ApiError(j.error ?? `HTTP ${status}`, status, j);
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
        if (then) await then(asset);
        else if (toTimeline) await placeAsset(asset);
        else if (asset.kind === 'mesh') toast(`${asset.title} is in Media: drop it on a stage, or use it as a character's model.`);
        else if (P.active) toast(`${file.name} is in Media.`, { action: 'Add to the timeline', onAction: () => placeAsset(asset) });
      } catch (err) {
        M.inflight.delete(key);
        // The server's own words for too many uploads or a file that is too big; everything else is explained as usual.
        toast(err.status === 429 || err.status === 413 ? `${file.name}: ${err.message}` : `${file.name}: ${explain(err).text}`);
      }
      drawMedia();
    }
    loadMedia();
  }, 'login');
}

/** Shows an error with the thing that fixes it (Add credits, Try again). */
export function showError(err, retry) { trouble(err, retry); }

/** A share link anyone can open for a week (the file plays in their browser): copied, or the phone's share sheet. */
export async function shareAsset(id, name) {
  try {
    const r = await api(`/v1/assets/${id}?share=1&name=${encodeURIComponent(name ?? '')}`, { method: 'POST' });
    const url = `${location.origin}${r.url}`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ title: name ?? 'Made with Hawkes Gen', url }).catch(() => {}); return url; }
    await navigator.clipboard.writeText(url).catch(() => {});
    toast('Link copied. Anyone with it can watch for 7 days.', { action: 'Open it', onAction: () => open(url, '_blank') });
    return url;
  } catch (err) { showError(err); return null; }
}

/** A library kind as a person says it. */
export const assetKindLabel = (k) => ({ image: 'Image', video: 'Clip', audio: 'Sound', mesh: '3D model', text: 'Text', file: 'File' }[k] ?? 'File');
