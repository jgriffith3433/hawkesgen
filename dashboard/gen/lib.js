// Shared helpers for the Gen app: DOM, the API, toasts, time formatting, media info and thumbnails, icons.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    // CSS variables (--tc, --fill) need setProperty: assigning them to el.style drops them silently.
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) { if (x == null) continue; if (p.startsWith('--')) el.style.setProperty(p, String(x)); else el.style[p] = x; }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
/**
 * A library file's link. Given the file's hash (list rows carry `sha256`), the link names its bytes, so Gen serves it as
 * immutable and the browser never asks for it again (J, 2026-11-01: Media kept reloading its pictures and clips).
 */
export const fileUrl = (id, sha) => `/v1/assets/${encodeURIComponent(id)}/file${sha ? `?v=${String(sha).slice(0, 16)}` : ''}`;

/**
 * Redraws a list in place instead of rebuilding it (J, 2026-11-01: "I hope in general the app doesn't refresh constantly").
 * Each row is { key, sig, make, update? }: a row whose key and sig match what's on screen keeps its element (pictures
 * and clips don't reload, a hovered clip keeps playing, the scroll stays); a new or changed row is made with make();
 * update(el) runs on every row for the cheap bits (a class, a status line). Only rows out of place are moved, and
 * anything else in the box (an empty note) goes.
 */
const SIG = new WeakMap();
export function keyedRedraw(box, rows) {
  const old = new Map();
  for (const el of box.children) if (SIG.has(el)) old.set(el.dataset.key, el);
  const next = rows.map((r) => {
    const key = String(r.key);
    let el = old.get(key);
    if (el && SIG.get(el) === r.sig) old.delete(key);
    else { el = r.make(); el.dataset.key = key; SIG.set(el, r.sig); }
    r.update?.(el);
    return el;
  });
  next.forEach((el, i) => { if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null); });
  while (box.children.length > next.length) box.lastElementChild.remove();
}

export class ApiError extends Error {
  constructor(message, status, data, retryAfter) { super(message); this.status = status; this.data = data; this.retryAfter = retryAfter ?? data?.retryAfter ?? null; }
}
export async function api(path, { method, body } = {}) {
  let r;
  try {
    r = await fetch(path, {
      method: method ?? (body ? 'POST' : 'GET'), credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // No answer at all: offline, or Gen is unreachable. Status 0 says so (trouble.js words it).
    throw new ApiError('offline', 0, { offline: true });
  }
  const retryAfter = Number(r.headers?.get?.('Retry-After')) || null;
  const text = await r.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {
    // Not Gen's JSON: an error page from somewhere in between (Cloudflare, Google's front end) or an answer cut off when
    // Gen restarted mid-request. Its words are never shown (2026-11-02: the AI pane printed "<!DOCTYPE html>").
    throw new ApiError(unreadableAnswer(r.status), r.ok ? 502 : r.status, { error: unreadableAnswer(r.status), unreadable: true });
  }
  if (!r.ok) {
    const err = new ApiError(data?.error ?? `HTTP ${r.status}`, r.status, data, retryAfter);
    // A 401 anywhere but the session probe means the session ended mid-work: trouble.js offers to sign in again.
    if (r.status === 401 && !/^\/v1\/users\/(?:me|google|login|signup)\b/.test(path)) bus.emit('sessionEnded', path);
    throw err;
  }
  return data;
}
/** What to say when an answer came back that isn't Gen's (an HTML error page, or JSON cut off part way). */
export function unreadableAnswer(status) {
  if (status === 413) return 'That was too big to send.';
  if (status === 429) return 'That\'s a lot at once: give it a few seconds, then try again.';
  return 'Gen was interrupted before it could answer (it may have just restarted). Nothing was lost: please try again.';
}
/** Whether a message is markup (an error page), not words for a person. */
export const looksLikeMarkup = (t) => /<\s*(?:!doctype|html|head|body|title|div|meta|script)\b/i.test(String(t ?? ''));

/** Tells the making loop's learning what the person thought of a take (src/make/feedback.ts): pick, discard, redo,
 *  rating or complaint. Never in the way: it fails silently. */
export function sendFeedback(kind, asset, extra = {}) {
  if (!asset) return;
  api('/v1/make/feedback', { body: { kind, asset, source: 'app', ...extra } }).catch(() => {});
}

let toastTimer = 0;
export function toast(msg, { action, onAction, ms = 4500 } = {}) {
  const t = $('#toast');
  t.replaceChildren(h('span', {}, msg), action ? h('button', { class: 'link', onclick: () => { t.hidden = true; onAction?.(); } }, action) : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/** An error as a person should read it: no terminal colors or stack traces, one short line. */
/**
 * Words on screen never name what Gen is made of (J, 2026-10-30): providers, models, machines and tool ids become plain
 * words (the server does the same to customers' jobs: src/publictext.ts). Used by every error and status shown here.
 */
export function plainWords(text) {
  let t = String(text ?? '');
  t = t.replace(/^\s*(?:runpod|modal|cloudrun(?::[\w.-]+)?|cloud run|fleet|gen-[\w-]+)\s*:\s*/i, '').replace(/\[Errno \d+\]\s*/g, '');
  t = t.replace(/\b(?:runpod|modal|cloud ?run|aws|fleet|comfy ?ui)\s+(?=(?:gpus?|workers?|servers?|instances?|machines?|jobs?)\b)/gi, '');
  t = t.replace(/No space left on device/gi, 'the server ran out of room');
  t = t.replace(/\b(?:image|video|audio|mesh|asset|film|blender|motion|sprite|texture|llm|playtest|unity|splat|media|comfy|scene|character|lod)\.[a-z][\w-]*\b/g, 'a step');
  t = t.replace(/\b(?:qwen[\w.-]*|wan ?2(?:\.\d)?|ltx[\w.-]*|hunyuan[\w.-]*|trellis[\w.-]*|z-image[\w-]*|flux[\w.-]*|stable ?audio(?: ?\d)?|ace-step[\w.-]*|eleven ?labs|birefnet|rembg|moge|infinite ?talk|chatterbox|voxcpm\d*|moss-tts|kimodo|blender|ksampler|safetensors)\b/gi, 'the model');
  t = t.replace(/\b(?:runpod|cloud ?run|cloudrun(?::[\w.-]+)?|comfy ?ui|comfy|gen-gpu[\w-]*|gen-cpu[\w-]*)\b/gi, 'the server');
  return t.replace(/\b(the (?:server|model))(?:\s+\1)+\b/gi, '$1').replace(/\s{2,}/g, ' ').trim();
}
export function plainError(msg) {
  if (looksLikeMarkup(msg)) return unreadableAnswer(0);
  const lines = String(msg ?? '').replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => /^Traceback|^\s*at |^File "/.test(l))) return 'Something went wrong on our side. Your credits were returned; please try again.';
  const line = plainWords(lines[0] ?? 'Something went wrong.');
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
}

/**
 * An error as a person can act on it: what happened in plain words, and the one thing that fixes it when there is one
 * (`fix`: 'credits' opens Add credits, 'retry' is worth another go, 'connection' means check the network).
 */
export function friendly(err) {
  const raw = String(err?.message ?? err ?? '');
  const status = err?.status ?? 0;
  if (status === 402 || /not enough credits|insufficient credits|out of credits|top up/i.test(raw)) return { kind: 'credits', text: 'You\'re out of credits for that. Credits are 1 cent each, and packs start at $10.', fix: 'credits' };
  if (err?.data?.offline || (!status && (/failed to fetch|networkerror|load failed|network|^offline$/i.test(raw) || (typeof navigator !== 'undefined' && navigator.onLine === false)))) return { kind: 'offline', text: 'Can\'t reach Gen right now. Your work is kept here and saves as soon as you\'re back online.', fix: 'connection' };
  if (/AI isn.t available|no AI|connect your AI/i.test(raw)) return { kind: 'ai', text: 'The AI is not available right now. Try again in a little while.', fix: 'ai' };
  if (status === 413 || /too large|payload/i.test(raw)) return { kind: 'big', text: 'That file is too big (1.5 GB at most).' };
  // Gen's own plain words for a full line or a busy day (src/aigate.ts, src/jobs.ts admitJob): they say what to do already.
  if ((status === 429 || status === 503) && /^(The AI is busy right now|You already have \d+ AI requests|Too many jobs are waiting|Hawkes Gen is busy right now)/.test(raw)) return { kind: 'busy', text: plainError(raw), fix: 'retry' };
  if (status === 429 || /rate limit|too many/i.test(raw)) {
    const n = Math.max(1, Math.ceil(Number(err?.retryAfter) || 0));
    return { kind: 'slow', text: err?.retryAfter ? `Too many requests, try again in ${n} s.` : 'Too many requests, try again in a few seconds.', fix: 'retry', wait: err?.retryAfter ? n : null };
  }
  if (status === 503 || /offline|unavailable|no gpu|no server|busy/i.test(raw)) return { kind: 'busy', text: 'Those servers are busy or resting right now. It waits in line on its own, or try another tool.', fix: 'retry' };
  if (status === 401) return { kind: 'signedOut', text: 'You\'ve been signed out. Sign in again and your work is right where you left it.', fix: 'signin' };
  return { kind: 'other', text: plainError(raw) };
}

/**
 * How a job is going, in a few words: in line (and how many are ahead), waiting because no server can take it yet (the
 * queue's own reason, said plainly), or what it's doing now.
 */
export function jobStatusText(j) {
  if (!j) return 'Working';
  if (j.status === 'queued') {
    const why = String(j.detail ?? '');
    if (/no (stopped |free )?server|launching new ones is off|offline|no gpu|unavailable/i.test(why)) return 'Waiting for a free server';
    return j.queue?.ahead ?? j.ahead ? `In line (${j.queue?.ahead ?? j.ahead} ahead)` : 'In line';
  }
  const doing = j.detail && j.detail !== 'running' ? plainWords(j.detail) : 'Working';
  return j.estimateSeconds ? `${doing} · ${estimateText(j.estimateSeconds)}` : doing;
}
/** "about 40 s", "about 3 min": what the tool usually takes (the server's own run history), said once, never a ticking clock. */
export function estimateText(sec) {
  sec = Math.max(1, Math.round(sec));
  if (sec < 90) return `about ${sec < 10 ? sec : Math.round(sec / 5) * 5} s`;
  return `about ${Math.round(sec / 60)} min`;
}

/** 0:03.4, 1:02.0 */
export function fmt(t, frac = 1) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(frac).padStart(frac ? 3 + frac : 2, '0')}`;
}

// Media info (duration, size) and a thumbnail, per asset, loaded once.
const infoCache = new Map();
export function mediaInfo(id, kind) {
  const key = `${kind}:${id}`;
  if (!infoCache.has(key)) {
    infoCache.set(key, new Promise((resolve) => {
      if (kind === 'image') {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: null });
        img.onerror = () => resolve({ width: 1024, height: 1024, duration: null });
        img.src = fileUrl(id);
        return;
      }
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      el.preload = 'metadata';
      el.muted = true;
      el.onloadedmetadata = () => resolve({ width: el.videoWidth || null, height: el.videoHeight || null, duration: Number.isFinite(el.duration) ? el.duration : null });
      el.onerror = () => resolve({ width: null, height: null, duration: null });
      el.src = fileUrl(id);
    }));
  }
  return infoCache.get(key);
}

const thumbCache = new Map();
/** A small still of a video (or an image's own URL), as a URL for CSS backgrounds. */
export function thumb(id, kind) {
  if (kind === 'image') return Promise.resolve(fileUrl(id));
  if (!thumbCache.has(id)) {
    thumbCache.set(id, new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
      const done = (url) => { v.removeAttribute('src'); v.load(); resolve(url); };
      v.onloadeddata = () => { v.currentTime = Math.min(0.2, (v.duration || 1) / 3); };
      v.onseeked = () => {
        try {
          const c = document.createElement('canvas');
          c.height = 72; c.width = Math.max(1, Math.round(72 * (v.videoWidth / v.videoHeight || 16 / 9)));
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          done(c.toDataURL('image/jpeg', 0.7));
        } catch { done(''); }
      };
      v.onerror = () => done('');
      v.src = fileUrl(id);
    }));
  }
  return thumbCache.get(id);
}

const peaksCache = new Map();
/** Loudness peaks of an audio (or video's) track for a waveform: 0..1 values, `n` of them. */
export function peaks(id, n = 600) {
  if (!peaksCache.has(id)) {
    peaksCache.set(id, (async () => {
      try {
        const buf = await (await fetch(fileUrl(id))).arrayBuffer();
        if (buf.byteLength > 40 * 1024 * 1024) return null;
        const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / n));
        const out = [];
        let max = 0;
        for (let i = 0; i < n; i++) {
          let m = 0;
          for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 16) m = Math.max(m, Math.abs(data[j]));
          out.push(m); max = Math.max(max, m);
        }
        return { values: out.map((x) => (max ? x / max : 0)), duration: audio.duration };
      } catch { return null; }
    })());
  }
  return peaksCache.get(id);
}

/** Uploads a mask (or any canvas) as a blob Gen can use as an input. */
export async function uploadCanvas(canvas, name = 'mask.png') {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const r = await fetch('/v1/blobs', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/png', 'X-Filename': name }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status);
  return j.blob;
}

// Icons: small inline SVGs (stroke = currentColor).
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const ICON = {
  play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>'),
  back: svg('<path d="M15 6l-6 6 6 6"/>'),
  fwd: svg('<path d="M9 6l6 6-6 6"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>'),
  split: svg('<path d="M12 3v18"/><path d="M5 8l-2 4 2 4M19 8l2 4-2 4"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
  film: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
  music: svg('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>'),
  text: svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  brush: svg('<path d="M18 3l3 3-9 9-3-3z"/><path d="M9 12c-3 0-5 2-5 5 0 1-1 2-2 2 2 2 7 2 9-1 1-1.5 1-3 1-3"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  wand: svg('<path d="M15 4V2M15 10V8M11 6h2M17 6h2M4 20L14 10"/>'),
  cut: svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
  share: svg('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  send: svg('<path d="M4 12l16-8-6 16-2-7z"/>'),
  person: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>'),
  speed: svg('<path d="M12 13l4-4"/><path d="M3 13a9 9 0 0118 0"/>'),
  volume: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/>'),
  frame: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9 4v16"/>'),
  continue: svg('<path d="M5 12h12M13 6l6 6-6 6"/><path d="M3 5v14"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>'),
  move: svg('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
  turn: svg('<path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 4v5h-5"/>'),
  size: svg('<path d="M4 20l7-7M4 20v-5M4 20h5M20 4l-7 7M20 4v5M20 4h-5"/>'),
  logout: svg('<path d="M10 5H6a1 1 0 00-1 1v12a1 1 0 001 1h4"/><path d="M15 8l4 4-4 4M19 12H9"/>'),
  phone: svg('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 4"/><path d="M12 17h.01"/>'),
  keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  sliders: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  download: svg('<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>'),
  magnet: svg('<path d="M6 3v8a6 6 0 0012 0V3"/><path d="M6 7h4M14 7h4"/>'),
  zoomIn: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4M11 8v6M8 11h6"/>'),
  zoomOut: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4M8 11h6"/>'),
  smooth: svg('<path d="M3 17c3-8 6-8 9 0s6 8 9 0"/>'),
  swap: svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
  folder: svg('<path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
  cube: svg('<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 005.4-1.6"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>'),
  unlock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.5-2"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>'),
  fill: svg('<path d="M5 12l7-7 7 7-7 7z"/><path d="M20 15s2 2.5 2 4a2 2 0 01-4 0c0-1.5 2-4 2-4z"/>'),
  chevron: svg('<path d="M6 9l6 6 6-6"/>'),
  more: svg('<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>'),
};
export const icon = (name, cls = 'ico') => h('span', { class: cls, html: ICON[name] ?? '' });

/** A tiny event hub the modules talk through. */
const subs = new Map();
export const bus = {
  on(ev, fn) { if (!subs.has(ev)) subs.set(ev, new Set()); subs.get(ev).add(fn); return () => subs.get(ev).delete(fn); },
  emit(ev, data) { for (const fn of subs.get(ev) ?? []) { try { fn(data); } catch (e) { console.error(ev, e); } } },
};

/**
 * Redraws `box` with `draw()` and gives the person back the field they were typing in (by its data-field), with the
 * caret, the selection and the scroll (J, 2026-10-30: typing a character's look, the autosave redrew the sheet and the
 * cursor was gone).
 */
export function keepingFocus(box, draw) {
  const a = document.activeElement;
  const key = a && box.contains(a) ? a.dataset?.field : null;
  const sel = key && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd, a.selectionDirection] : null;
  const inner = key ? a.scrollTop : 0;
  const scroll = box.scrollTop;
  draw();
  box.scrollTop = scroll;
  if (!key) return;
  const n = box.querySelector(`[data-field="${CSS.escape(key)}"]`);
  if (!n) return;
  n.focus({ preventScroll: true });
  if (sel) { try { n.setSelectionRange(...sel); } catch { /* not a text field */ } }
  n.scrollTop = inner;
}
