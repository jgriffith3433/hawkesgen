// The left pane. Media: everything the account made or uploaded (search, filter, drag onto the timeline, click to look
// at it), uploads by button or drop (converted on Gen when a format needs it), and work in progress. Generate: images,
// video from words, music, voice-overs, sound effects, each with its price. Also the one way every tool runs (runJob).

import { $, $$, h, api, toast, fileUrl, fmt, bus, icon, mediaInfo, plainError, ApiError } from './lib.js';
import { P, addClip, newId, changed, remember, clipEnd } from './project.js';
import { showSource, seek } from './player.js';
import { state, needSignIn, openAccount, refreshCredits } from './account.js';

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
  initGenerate();
  bus.on('signedIn', loadMedia);
  bus.on('ready', loadMedia);
  bus.on('jobDone', () => loadMedia());
  bus.on('placeAsset', ({ asset, track, start }) => placeAsset(asset, { track, start }));
  loadMedia();
}

export function showPane(name) {
  $$('#paneTabs button').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
  $$('.pane-body').forEach((p) => { p.hidden = p.id !== `pane-${name}`; });
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
    M.items = (r.items ?? []).filter((a) => ['image', 'video', 'audio'].includes(a.kind));
  } catch { M.items = []; }
  drawMedia();
}

function drawMedia() {
  const grid = $('#mediaGrid');
  const busy = [...M.inflight.values()].map((j) => h('div', { class: 'tile busy' }, h('div', { class: 'working' }, j.step || 'Starting'), h('div', { class: 'tile-cap' }, j.label)));
  const tiles = M.items.map(tileFor);
  grid.replaceChildren(...busy, ...tiles);
  if (!busy.length && !tiles.length) grid.append(h('div', { class: 'empty-note' }, h('p', {}, M.q || M.kind ? 'Nothing matches.' : 'Nothing here yet.'), h('p', { class: 'muted' }, 'Upload files, or make something in Generate.')));
}

const durationOf = (a) => a.meta?.duration ?? null;
function tileFor(a) {
  const prompt = a.recipe?.params?.prompt ?? a.recipe?.params?.text ?? a.title ?? '';
  const media = a.kind === 'image' ? h('img', { src: fileUrl(a.id), alt: '', loading: 'lazy', draggable: 'false' })
    : a.kind === 'video' ? h('video', { src: `${fileUrl(a.id)}#t=0.1`, muted: true, playsinline: true, preload: 'metadata', onmouseenter: (e) => e.target.play().catch(() => {}), onmouseleave: (e) => { e.target.pause(); } })
    : h('div', { class: 'tile-audio' }, icon(a.tool === 'audio.music' ? 'music' : a.tool?.startsWith('audio.voice') ? 'mic' : 'volume', 'ico big'));
  const d = durationOf(a);
  const el = h('div', { class: `tile kind-${a.kind}`, draggable: 'true', tabindex: '0', title: prompt },
    media,
    d ? h('span', { class: 'badge' }, fmt(d, 0)) : '',
    h('div', { class: 'tile-cap' }, a.title || prompt || a.kind),
    h('button', { class: 'tile-add', title: 'Add to the timeline at the playhead', onclick: (e) => { e.stopPropagation(); placeAsset(assetLite(a)); } }, icon('plus')));
  el.addEventListener('click', () => openAsset(a));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openAsset(a); });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-hg-asset', JSON.stringify(assetLite(a)));
    e.dataTransfer.effectAllowed = 'copy';
  });
  return el;
}
const assetLite = (a) => ({ id: a.id, kind: a.kind, title: a.title ?? a.recipe?.params?.prompt ?? '', prompt: a.recipe?.params?.prompt ?? '', duration: durationOf(a), width: a.meta?.width ?? a.recipe?.params?.width ?? null, height: a.meta?.height ?? a.recipe?.params?.height ?? null, tool: a.tool });

export async function openAsset(a) {
  const lite = a.id && a.kind ? assetLite(a) : a;
  const info = await mediaInfo(lite.id, lite.kind);
  showSource({ ...lite, width: info.width ?? lite.width, height: info.height ?? lite.height, duration: info.duration ?? lite.duration });
}

/** Puts a library file on the timeline: images and clips on V1, sounds on an audio track. */
export async function placeAsset(a, { track, start } = {}) {
  const info = await mediaInfo(a.id, a.kind);
  const kind = a.kind === 'audio' ? 'audio' : a.kind;
  const t = track ?? (kind === 'audio' ? (a.tool?.startsWith('audio.voice') || a.tool === 'audio.revoice' ? 'A2' : a.tool?.startsWith('audio.sfx') ? 'A3' : 'A1') : 'V1');
  const c = addClip({ track: t, asset: a.id, kind, duration: info.duration ?? a.duration ?? null, start: start ?? P.playhead, label: a.title || a.prompt || undefined });
  P.selection.clips.clear();
  P.selection.clips.add(c.id);
  bus.emit('selection');
  // Like any editor: the playhead moves past what was just put on the video track, so the next one follows it.
  if (t === 'V1' && start == null) seek(clipEnd(c));
  return c;
}

// ------------------------------------------------------------------ running tools
/**
 * Runs one tool for the person. `place`: { replace: clipId } swaps that clip's file when done; { track, start } puts a
 * waiting clip on the timeline now; nothing: the result goes to Media. Returns the finished job (or throws).
 */
export function runJob({ tool, params = {}, inputs = {}, label, place } = {}) {
  return new Promise((resolve, reject) => needSignIn(async () => {
    try {
      const r = await api('/v1/jobs', { body: { project: state.user.project, tool, params, inputs, labels: { title: label ?? tool, ...(P.id ? { editor: P.id } : {}) } } });
      const job = r.jobs[0];
      if (place?.replace) {
        const c = P.doc.clips.find((x) => x.id === place.replace);
        if (c) { remember(); Object.assign(c, { job: job.id, pending: true, label: label ?? c.label }); delete c.failed; changed(); }
      } else if (place?.track) {
        remember();
        const c = { id: newId(), track: place.track, kind: place.track === 'V1' ? (tool.startsWith('image.') ? 'image' : 'video') : 'audio', start: place.start ?? P.playhead, in: 0, out: place.seconds ?? 5, duration: place.seconds ?? null, job: job.id, pending: true, label: label ?? tool };
        if (place.track === 'V1') c.start = place.start ?? Number.MAX_SAFE_INTEGER;
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
          if (c.track === 'V1') c.kind = out.kind === 'image' ? 'image' : 'video';
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

// ------------------------------------------------------------------ Generate
const STYLES = [
  ['', 'Any'], ['photograph, natural light, sharp focus, high detail', 'Photo'], ['cinematic film still, dramatic lighting, anamorphic, color graded', 'Cinematic'],
  ['digital illustration, clean lines, rich color', 'Illustration'], ['anime style, cel shading, vibrant', 'Anime'], ['3D render, soft studio lighting, high detail', '3D'],
  ['pixel art, 16-bit, crisp pixels, limited palette', 'Pixel'], ['watercolor painting, soft washes, paper texture', 'Watercolor'],
];
const VOICES = [
  ['A warm, calm male narrator, clear studio recording', 'Warm narrator (male)'], ['A warm, friendly female narrator, clear studio recording', 'Warm narrator (female)'],
  ['An energetic young trailer announcer, punchy and excited, studio recording', 'Trailer announcer'], ['A deep, slow, dramatic movie-trailer voice, studio recording', 'Epic trailer voice'],
  ['A cheerful young kid, playful, clear recording', 'Playful kid'], ['An old wise storyteller, gravelly and slow, close microphone', 'Old storyteller'],
];
/** Width and height for the project's shape (wide, tall, square), at a size each tool likes. */
function shapeFor(kind) {
  const ar = P.doc.width / P.doc.height;
  if (kind === 'image') return ar > 1.2 ? { width: 1344, height: 768 } : ar < 0.83 ? { width: 768, height: 1344 } : { width: 1024, height: 1024 };
  return ar > 1.2 ? { width: 832, height: 480 } : ar < 0.83 ? { width: 480, height: 832 } : { width: 640, height: 640 };
}

function initGenerate() {
  let style = '';
  $('#genStyles').append(...STYLES.map(([w, label]) => h('button', { type: 'button', class: `chip${w === style ? ' on' : ''}`, onclick: (e) => { style = w; $$('#genStyles .chip').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); } }, label)));
  $('#genVoice').append(...VOICES.map(([v, l]) => h('option', { value: v }, l)));
  const forms = {
    genImageForm: () => {
      const prompt = $('#genImagePrompt').value.trim();
      if (!prompt) return null;
      const s = shapeFor('image');
      return { tool: 'image.generate', params: { prompt: style ? `${prompt}, ${style}` : prompt, ...s, seed: Math.floor(Math.random() * 2 ** 31) }, label: prompt, place: $('#genImageToTl').checked ? { track: 'V1', start: undefined, seconds: 3 } : null };
    },
    genVideoForm: () => {
      const prompt = $('#genVideoPrompt').value.trim();
      if (!prompt) return null;
      const seconds = Number($('#genVideoSeconds').value);
      return { tool: 'video.t2v', params: { prompt, seconds, ...shapeFor('video') }, label: prompt, place: $('#genVideoToTl').checked ? { track: 'V1', seconds } : null };
    },
    genMusicForm: () => {
      const prompt = $('#genMusicPrompt').value.trim();
      if (!prompt) return null;
      const seconds = Math.min(240, Math.max(10, Math.ceil(Number($('#genMusicSeconds').value) || 30)));
      return { tool: 'audio.music', params: { prompt, seconds }, label: prompt, place: { track: 'A1', start: 0, seconds } };
    },
    genVoiceForm: () => {
      const text = $('#genVoiceText').value.trim();
      if (!text) return null;
      return { tool: 'audio.voice', params: { text, description: $('#genVoice').value }, label: text.slice(0, 60), place: { track: 'A2', start: P.playhead, seconds: Math.max(1.5, text.split(/\s+/).length / 2.6) } };
    },
    genSfxForm: () => {
      const text = $('#genSfxText').value.trim();
      if (!text) return null;
      const duration = Number($('#genSfxSeconds').value) || undefined;
      return { tool: 'audio.sfx', params: { text, ...(duration ? { duration } : {}) }, label: text, place: { track: 'A3', start: P.playhead, seconds: duration ?? 3 } };
    },
  };
  for (const [id, build] of Object.entries(forms)) {
    const form = $(`#${id}`);
    const q = form.querySelector('.quote');
    let t = 0;
    form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => { const spec = build(); const r = spec ? await quote(spec.tool, spec.params) : null; q.textContent = credits(r); }, 350); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const spec = build();
      if (!spec) return;
      runJob(spec).catch(() => {});
      if (!spec.place) showPane('media');
      form.querySelector('textarea, input[type=text]')?.select();
    });
  }
  $('#genMusicSeconds').placeholder = '30';
  bus.on('doc', () => { const len = Math.ceil(P.doc.clips.reduce((m, c) => Math.max(m, c.start + (c.out - c.in) / (c.speed || 1)), 0)); if (len) $('#genMusicSeconds').placeholder = String(Math.max(10, len)); });
}
