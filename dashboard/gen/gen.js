// Hawkes Gen, the app (gen.hawkesgen.ai /). Gen's own accounts (src/users.ts: Google sign-in, credits, Stripe), its own
// API (/v1). Create: a prompt (and a style) becomes an image (image.generate), or the person uploads one; an image can be
// edited with words (image.edit), cut out (image.cutout), upscaled (image.upscale) or made a clip (video.i2v). Library:
// everything made. Editor: a timeline of clips with trims, transitions, captions, music, voice-overs (audio.voice) and
// sound effects (audio.sfx), previewed here and rendered by video.compose. The admin dashboard is /admin.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const fileUrl = (id) => `/v1/assets/${encodeURIComponent(id)}/file`;

// ------------------------------------------------------------------ the API
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function api(path, { method, body } = {}) {
  const r = await fetch(path, {
    method: method ?? (body ? 'POST' : 'GET'), credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!r.ok) throw new ApiError(data?.error ?? `HTTP ${r.status}`, r.status);
  return data;
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

// ------------------------------------------------------------------ who's signed in
const state = { user: null, admin: false };

async function loadMe() {
  try {
    const me = await api('/v1/users/me');
    state.user = me.user;
  } catch {
    state.user = null;
  }
  try {
    const c = await api('/v1/me');
    state.admin = c.role === 'owner' || c.role === 'admin';
  } catch {
    state.admin = false;
  }
  showMe();
}
function showMe() {
  const u = state.user;
  $('#signInBtn').hidden = Boolean(u);
  $('#accountBtn').hidden = !u;
  $('#creditsPill').hidden = !u;
  $('#adminLink').hidden = !state.admin;
  if (u) {
    $('#accountBtn').textContent = u.name || u.email;
    $('#creditsCount').textContent = String(u.credits ?? 0);
  }
}
const refreshCredits = () => api('/v1/users/me').then((m) => { state.user = m.user; showMe(); }).catch(() => {});

// Sign in or create an account, then go on with what the person was doing.
let afterSignIn = null;
let authMode = 'login';
// Continue with Google (POST /v1/users/google): the way in. Email and password only where Google isn't set up (local).
const signin = { clientId: null, passwords: false, ready: null };
function loadGoogle() {
  signin.ready ??= api('/v1/users/google').then((g) => {
    signin.clientId = g.clientId;
    signin.passwords = Boolean(g.passwords);
    if (!g.clientId) return;
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => {
        google.accounts.id.initialize({ client_id: g.clientId, callback: (r) => googleDone(r.credential), ux_mode: 'popup' });
        resolve();
      };
      s.onerror = () => resolve();
      document.head.append(s);
    });
  }).catch(() => {});
  return signin.ready;
}
async function googleDone(credential) {
  try {
    const r = await api('/v1/users/google', { body: { credential } });
    $('#authDialog').close();
    await loadMe();
    updateQuote();
    showRecent();
    if (r.created) toast(`Welcome! You have ${state.user?.credits ?? 0} free credits.`);
    const then = afterSignIn;
    afterSignIn = null;
    if (then) then();
  } catch (err) {
    $('#authError').textContent = err.message;
    $('#authError').hidden = false;
  }
}
async function showSignIn() {
  await loadGoogle();
  const box = $('#googleBtn');
  box.replaceChildren();
  const google_ = signin.clientId && globalThis.google?.accounts?.id;
  if (google_) google.accounts.id.renderButton(box, { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'filled_black' : 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
  box.hidden = !google_;
  $('#passwordAuth').hidden = Boolean(google_) || !signin.passwords;
  $('#authSubmit').hidden = $('#passwordAuth').hidden;
  if (!google_ && !signin.passwords) { $('#authError').textContent = 'Sign-in is not set up on this Gen yet.'; $('#authError').hidden = false; }
}

function setAuthMode(mode) {
  authMode = mode;
  $$('#authDialog .tab').forEach((t) => t.classList.toggle('on', t.dataset.mode === mode));
  $('#nameField').hidden = mode !== 'signup';
  $('#authSubmit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  $('#authTitle').textContent = 'Sign in to Hawkes Gen';
  $('#authPassword').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
}
function needSignIn(then, mode = 'signup') {
  if (state.user) return then();
  afterSignIn = then;
  setAuthMode(mode);
  $('#authError').hidden = true;
  $('#authDialog').showModal();
  showSignIn();
}
$$('#authDialog .tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
$('#authCancel').addEventListener('click', () => { afterSignIn = null; $('#authDialog').close(); });
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { email: $('#authEmail').value, password: $('#authPassword').value, ...(authMode === 'signup' ? { name: $('#authName').value } : {}) };
  $('#authSubmit').disabled = true;
  try {
    await api(authMode === 'signup' ? '/v1/users/signup' : '/v1/users/login', { body });
    $('#authDialog').close();
    await loadMe();
    updateQuote();
    const then = afterSignIn;
    afterSignIn = null;
    if (then) then();
  } catch (err) {
    $('#authError').textContent = err.message;
    $('#authError').hidden = false;
  } finally {
    $('#authSubmit').disabled = false;
  }
});
$('#signInBtn').addEventListener('click', () => needSignIn(() => {}, 'login'));

// Account: credits and sign out.
async function openAccount() {
  $('#accountEmail').textContent = state.user?.email ?? '';
  $('#accountCredits').textContent = String(state.user?.credits ?? 0);
  $('#accountError').hidden = true;
  // Plans: the current one (cancel or resume at the month's end), else the ones to pick.
  const plansBox = $('#plans');
  plansBox.replaceChildren();
  try {
    const [{ plans = [], stripe = {} }, { subscription: sub }] = await Promise.all([api('/v1/subscriptions/plans'), api('/v1/subscriptions/me')]);
    const cur = sub && sub.status !== 'canceled' ? plans.find((p) => p.id === sub.planId) : null;
    if (cur) {
      const ends = new Date(sub.currentPeriodEnd).toLocaleDateString();
      plansBox.append(h('div', {},
        h('p', {}, h('b', {}, cur.name), ` · ${cur.creditsPerMonth.toLocaleString()} credits a month`,
          sub.status === 'past_due' ? h('span', { class: 'error' }, ' · payment failed: update your card') : '',
          sub.cancelAtPeriodEnd ? h('span', { class: 'muted' }, ` · ends ${ends}`) : h('span', { class: 'muted' }, ` · renews ${ends}`)),
        h('button', { class: 'ghost small', onclick: () => planAction(sub.cancelAtPeriodEnd ? 'resume' : 'cancel') }, sub.cancelAtPeriodEnd ? 'Keep my plan' : 'Cancel at the end of the month')));
    } else if (!stripe.configured) {
      plansBox.append(h('p', { class: 'muted' }, 'Plans open soon.'));
    } else {
      for (const p of plans) {
        plansBox.append(h('button', { class: 'ghost', onclick: () => subscribe(p.id) },
          h('b', {}, `${p.name} · $${(p.priceCents / 100).toFixed(0)}/month`), h('small', {}, `${p.creditsPerMonth.toLocaleString()} credits every month`)));
      }
    }
  } catch (err) {
    plansBox.append(h('p', { class: 'muted' }, err.message));
  }
  $('#billingPortalBtn').hidden = !state.user?.hasBilling;
  const box = $('#packs');
  box.replaceChildren();
  try {
    const p = await api('/v1/billing/packs');
    const packs = p.packs ?? [];
    if (!packs.length || p.stripe?.configured === false) box.append(h('p', { class: 'muted' }, 'Buying credits isn\'t open yet.'));
    for (const pack of packs) {
      box.append(h('button', { class: 'ghost', onclick: () => buy(pack.id) },
        h('b', {}, `${pack.credits.toLocaleString()} credits`), h('small', {}, pack.label ?? `$${(pack.priceCents ?? pack.amountCents ?? 0) / 100}`)));
    }
  } catch (err) {
    box.append(h('p', { class: 'muted' }, err.message));
  }
  $('#accountDialog').showModal();
}
async function subscribe(planId) {
  try {
    const r = await api('/v1/subscriptions/checkout', { body: { planId } });
    if (r.url) location.href = r.url;
  } catch (err) {
    $('#accountError').textContent = err.message;
    $('#accountError').hidden = false;
  }
}
async function planAction(what) {
  try {
    await api(`/v1/subscriptions/${what}`, { method: 'POST' });
    openAccount();
  } catch (err) {
    $('#accountError').textContent = err.message;
    $('#accountError').hidden = false;
  }
}
$('#billingPortalBtn').addEventListener('click', async () => {
  try {
    const r = await api('/v1/billing/portal', { method: 'POST' });
    if (r.url) location.href = r.url;
  } catch (err) {
    $('#accountError').textContent = err.message;
    $('#accountError').hidden = false;
  }
});
async function buy(packId) {
  try {
    const r = await api('/v1/billing/checkout', { body: { packId } });
    if (r.url) location.href = r.url;
  } catch (err) {
    $('#accountError').textContent = err.message;
    $('#accountError').hidden = false;
  }
}
$('#accountBtn').addEventListener('click', openAccount);
$('#creditsPill').addEventListener('click', openAccount);
$('#accountClose').addEventListener('click', () => $('#accountDialog').close());
$('#signOutBtn').addEventListener('click', async () => {
  await api('/v1/users/logout', { method: 'POST' }).catch(() => {});
  $('#accountDialog').close();
  state.user = null;
  await loadMe();
});

// ------------------------------------------------------------------ jobs
async function submit(spec) {
  // Always the account's own project (an admin's account can reach every project; its own work stays in its own).
  const r = await api('/v1/jobs', { body: { project: state.user?.project, ...spec } });
  return r.jobs[0];
}
/** Polls a job until it ends; onStep gets its progress line. Resolves with the finished job. */
async function waitJob(id, onStep) {
  for (;;) {
    const j = await api(`/v1/jobs/${id}`);
    if (j.status === 'done') return j;
    if (j.status === 'failed' || j.status === 'cancelled') throw new ApiError(j.error || `The job was ${j.status}`, 0);
    onStep?.(j.status === 'queued' ? (j.queue?.ahead ? `In line (${j.queue.ahead} ahead)` : 'In line') : j.detail || 'Working');
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function quote(tool, params) {
  if (!state.user) return null;
  try {
    return await api('/v1/billing/quote', { body: { tool, params, project: state.user.project } });
  } catch {
    return null;
  }
}
const credits = (q) => (q ? `${q.credits} credit${q.credits === 1 ? '' : 's'}` : '');

// ------------------------------------------------------------------ Create
let shape = { w: 1024, h: 1024 };
$$('#promptForm .chip').forEach((c) => c.addEventListener('click', () => {
  $$('#promptForm .chip').forEach((x) => x.classList.toggle('on', x === c));
  shape = { w: Number(c.dataset.w), h: Number(c.dataset.h) };
  updateQuote();
}));
let quoteTimer = 0;
function updateQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    const q = await quote('image.generate', { prompt: $('#prompt').value || 'x', width: shape.w, height: shape.h });
    $('#quote').textContent = q ? credits(q) : '';
  }, 300);
}
$('#prompt').addEventListener('input', updateQuote);
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#promptForm').requestSubmit(); }
});
// A style is words added to the prompt; the card keeps what the person typed.
const STYLES = [
  ['', 'Any style'],
  ['photograph, natural light, sharp focus, high detail', 'Photo'],
  ['cinematic film still, dramatic lighting, anamorphic, color graded', 'Cinematic'],
  ['digital illustration, clean lines, rich color', 'Illustration'],
  ['anime style, cel shading, vibrant', 'Anime'],
  ['3D render, soft studio lighting, octane, high detail', '3D render'],
  ['pixel art, 16-bit, crisp pixels, limited palette', 'Pixel art'],
  ['watercolor painting, soft washes, paper texture', 'Watercolor'],
];
let style = '';
$('#styles').append(...STYLES.map(([words, label]) => h('button', {
  type: 'button', class: `chip${words === style ? ' on' : ''}`, onclick: (e) => {
    style = words;
    $$('#styles .chip').forEach((x) => x.classList.toggle('on', x === e.currentTarget));
  },
}, label)));
const EXAMPLES = [
  'A cozy cabin in a snowy forest at night, warm windows glowing',
  'A tiny robot watering a flower on a windowsill',
  'A neon-lit street market in the rain, people with umbrellas',
  'A dragon made of autumn leaves flying over a lake',
];
$('#examples').append(...EXAMPLES.map((x) => h('button', { type: 'button', class: 'chip', onclick: () => { $('#prompt').value = x; updateQuote(); $('#prompt').focus(); } }, x)));
const styled = (prompt) => (style ? `${prompt}, ${style}` : prompt);

$('#promptForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const prompt = $('#prompt').value.trim();
  if (!prompt) return;
  needSignIn(() => generate(prompt, shape));
});

// Upload: the person's own image becomes an asset in their project, then the same card as a made one.
$('#uploadInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return toast('That image is over 20 MB.');
  needSignIn(() => upload(file), 'login');
});
async function upload(file) {
  const c = card({ title: file.name, ratio: '1 / 1' });
  c.step('Uploading');
  try {
    const r = await fetch(`/v1/assets?project=${encodeURIComponent(state.user.project)}&title=${encodeURIComponent(file.name)}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': file.name }, body: file,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status);
    const size = await imageSize(fileUrl(j.id));
    c.media.style.aspectRatio = `${size.w} / ${size.h}`;
    showImage(c, j.id, file.name.replace(/\.[a-z0-9]+$/i, ''), size);
  } catch (err) {
    c.fail(err.message);
  }
}
const imageSize = (src) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve({ w: img.naturalWidth || 1024, h: img.naturalHeight || 1024 });
  img.onerror = () => resolve({ w: 1024, h: 1024 });
  img.src = src;
});

/** An error as a person should read it: no terminal colors or stack traces, one short line. */
function plainError(msg) {
  const lines = String(msg ?? '').replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => /^Traceback|^\s*at |^File "/.test(l))) return 'Something went wrong on our side. Your credits were returned; please try again.';
  const line = lines[0] ?? 'Something went wrong.';
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
}

/** A card in the feed for one job: working, then the result with what to do next. */
function card({ title, ratio, append = false }) {
  const media = h('div', { class: 'media', style: `aspect-ratio:${ratio}` }, h('div', { class: 'working' }, 'Starting'));
  const actions = h('div', { class: 'actions' });
  const el = h('article', { class: 'card' }, media, h('div', { class: 'body' }, h('div', { class: 'prompt-text', title }, title), actions));
  if (append) $('#feed').append(el); else $('#feed').prepend(el);
  return {
    el, media, actions,
    step(text) { const w = $('.working', media); if (w) w.textContent = text; },
    fail(msg) { el.classList.add('failed'); media.replaceChildren(h('div', { title: String(msg ?? '') }, plainError(msg))); },
  };
}

async function generate(prompt, size, seed = Math.floor(Math.random() * 2 ** 31)) {
  const c = card({ title: prompt, ratio: `${size.w} / ${size.h}` });
  try {
    const job = await submit({ tool: 'image.generate', params: { prompt: styled(prompt), width: size.w, height: size.h, seed } });
    const done = await waitJob(job.id, c.step);
    refreshCredits();
    showImage(c, done.outputs[0].asset, prompt, size, () => needSignIn(() => generate(prompt, size)));
  } catch (err) {
    c.fail(err.message);
    if (err.status === 402) openAccount();
  }
}

/** A finished image in its card, with everything that can be done to it next. */
function showImage(c, asset, prompt, size, again = null) {
  c.media.replaceChildren(h('img', { src: fileUrl(asset), alt: prompt, loading: 'lazy' }));
  c.actions.replaceChildren(
    h('button', { class: 'primary', onclick: () => openAnimate({ asset, prompt, size }) }, 'Animate'),
    h('button', { onclick: () => openEdit({ asset, prompt, size }) }, 'Edit'),
    h('button', { title: 'Cut the subject out on a transparent background', onclick: () => needSignIn(() => imageStep({ asset, prompt, size }, 'cutout')) }, 'Remove background'),
    h('button', { title: 'A sharper, larger copy', onclick: () => needSignIn(() => imageStep({ asset, prompt, size }, 'upscale')) }, 'Upscale'),
    again ? h('button', { onclick: again }, 'Another') : null,
    h('a', { class: 'btn ghost', href: fileUrl(asset), download: '' }, 'Download'),
  );
}

// One step on an image: edit with words (image.edit), cut out (image.cutout, CPU), upscale (image.upscale).
const STEPS = {
  edit: (from, words) => ({ title: `Edit: ${words}`, spec: { tool: 'image.edit', params: { prompt: words }, inputs: { images: [`asset:${from.asset}`] } } }),
  cutout: (from) => ({ title: `Background removed: ${from.prompt}`, spec: { tool: 'image.cutout', params: { crop: false }, inputs: { image: `asset:${from.asset}` } } }),
  upscale: (from) => ({ title: `Upscaled: ${from.prompt}`, spec: { tool: 'image.upscale', params: {}, inputs: { image: `asset:${from.asset}` } }, scale: 2 }),
};
async function imageStep(from, kind, words) {
  const { title, spec, scale = 1 } = STEPS[kind](from, words);
  const c = card({ title, ratio: `${from.size.w} / ${from.size.h}` });
  if (kind === 'cutout') c.el.classList.add('checker');
  try {
    const job = await submit(spec);
    const done = await waitJob(job.id, c.step);
    refreshCredits();
    const out = done.outputs.find((o) => o.kind === 'image') ?? done.outputs[0];
    showImage(c, out.asset, kind === 'edit' ? words : from.prompt, { w: from.size.w * scale, h: from.size.h * scale });
  } catch (err) {
    c.fail(err.message);
    if (err.status === 402) openAccount();
  }
}

let editing = null;
const EDIT_IDEAS = ['Make it night time', 'Make it snow', 'Turn it into a painting', 'Add dramatic sunset light', 'Make it look like a toy'];
$('#editIdeas').append(...EDIT_IDEAS.map((x) => h('button', { type: 'button', class: 'chip', onclick: () => { $('#editPrompt').value = x; } }, x)));
async function openEdit(from) {
  editing = from;
  $('#editFrom').src = fileUrl(from.asset);
  $('#editPrompt').value = '';
  $('#editQuote').textContent = '';
  $('#editDialog').showModal();
  const q = await quote('image.edit', { prompt: 'x' });
  $('#editQuote').textContent = q ? `About ${credits(q)}` : '';
}
$('#editCancel').addEventListener('click', () => $('#editDialog').close());
$('#editForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const words = $('#editPrompt').value.trim();
  if (!words) return;
  $('#editDialog').close();
  const from = editing;
  location.hash = '#create';
  needSignIn(() => imageStep(from, 'edit', words));
});

// Create shows the account's recent work under the prompt, so a reload never looks like an empty page.
let recentShown = false;
async function showRecent() {
  if (recentShown || !state.user || $('#feed').children.length) return;
  recentShown = true;
  const items = (await myAssets('', 12).catch(() => [])).filter((a) => a.kind !== 'audio').slice(0, 8);
  $('#recentHead').hidden = !items.length;
  for (const a of items) {
    const size = { w: a.meta?.width ?? a.recipe?.params?.width ?? 1024, h: a.meta?.height ?? a.recipe?.params?.height ?? 1024 };
    const prompt = a.recipe?.params?.prompt ?? a.title ?? '';
    const c = card({ title: prompt || 'Untitled', ratio: `${size.w} / ${size.h}`, append: true });
    if (a.kind === 'image') showImage(c, a.id, prompt, size);
    else {
      c.media.replaceChildren(h('video', { src: fileUrl(a.id), muted: true, loop: true, playsinline: true, preload: 'metadata', onmouseenter: (e) => e.target.play().catch(() => {}), onmouseleave: (e) => e.target.pause() }));
      c.actions.append(
        h('button', { class: 'primary', onclick: () => { addClip(a.id); location.hash = '#editor'; } }, 'Add to edit'),
        h('a', { class: 'btn ghost', href: fileUrl(a.id), download: '' }, 'Download'));
    }
  }
}

// Animate: an image to a short clip (video.i2v, Wan 2.2). Its size follows the image's shape.
let animating = null;
function i2vParams(size, seconds, prompt) {
  const wide = size.w > size.h * 1.15, tall = size.h > size.w * 1.15;
  const [w, hh] = wide ? [832, 480] : tall ? [480, 832] : [640, 640];
  const fps = 16;
  const frames = Math.min(161, Math.round((seconds * fps) / 4) * 4 + 1);
  return { prompt, width: w, height: hh, frames, fps };
}
async function openAnimate(from) {
  animating = from;
  $('#animateFrom').src = fileUrl(from.asset);
  $('#animatePrompt').value = '';
  $('#animateQuote').textContent = '';
  $('#animateDialog').showModal();
  const q = await quote('video.i2v', i2vParams(from.size, Number($('#animateLength').value), 'x'));
  $('#animateQuote').textContent = q ? `About ${credits(q)}` : '';
}
$('#animateCancel').addEventListener('click', () => $('#animateDialog').close());
$('#animateForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#animateDialog').close();
  const from = animating;
  const motion = $('#animatePrompt').value.trim() || from.prompt;
  needSignIn(() => animate(from, motion, Number($('#animateLength').value)));
});
async function animate(from, prompt, seconds) {
  const params = i2vParams(from.size, seconds, prompt);
  const c = card({ title: `Animate: ${prompt}`, ratio: `${params.width} / ${params.height}` });
  try {
    const job = await submit({ tool: 'video.i2v', params, inputs: { start: `asset:${from.asset}` } });
    const done = await waitJob(job.id, c.step);
    refreshCredits();
    const out = done.outputs.find((o) => o.kind === 'video') ?? done.outputs[0];
    c.media.replaceChildren(h('video', { src: fileUrl(out.asset), autoplay: true, loop: true, muted: true, playsinline: true }), h('span', { class: 'badge' }, `${seconds} s`));
    c.actions.append(
      h('button', { class: 'primary', onclick: () => { addClip(out.asset); location.hash = '#editor'; } }, 'Add to edit'),
      h('a', { class: 'btn ghost', href: fileUrl(out.asset), download: '' }, 'Download'),
    );
  } catch (err) {
    c.fail(err.message);
    if (err.status === 402) openAccount();
  }
}

// ------------------------------------------------------------------ Library
let libKind = '';
$$('#libFilter .chip').forEach((c) => c.addEventListener('click', () => {
  $$('#libFilter .chip').forEach((x) => x.classList.toggle('on', x === c));
  libKind = c.dataset.kind;
  loadLibrary();
}));
async function myAssets(kind = '', limit = 80) {
  if (!state.user) return [];
  const r = await api(`/v1/assets?limit=${limit}${kind ? `&kind=${kind}` : ''}&project=${encodeURIComponent(state.user.project)}`);
  return (r.items ?? []).filter((a) => ['image', 'video', 'audio'].includes(a.kind));
}
function tile(a, { compact = false } = {}) {
  const media = a.kind === 'image' ? h('img', { src: fileUrl(a.id), alt: a.title ?? '', loading: 'lazy' })
    : a.kind === 'video' ? h('video', { src: fileUrl(a.id), muted: true, playsinline: true, preload: 'metadata', onmouseenter: (e) => e.target.play().catch(() => {}), onmouseleave: (e) => e.target.pause() })
    : h('div', { class: 'audio' }, `♪ ${a.title ?? 'Audio'}`);
  const acts = [];
  const prompt = a.recipe?.params?.prompt ?? a.title ?? '';
  const size = { w: a.meta?.width ?? a.recipe?.params?.width ?? 1024, h: a.meta?.height ?? a.recipe?.params?.height ?? 1024 };
  if (a.kind === 'image') {
    acts.push(h('button', { onclick: (e) => { e.stopPropagation(); openAnimate({ asset: a.id, prompt, size }); } }, 'Animate'));
    if (!compact) acts.push(h('button', { onclick: (e) => { e.stopPropagation(); openEdit({ asset: a.id, prompt, size }); } }, 'Edit'));
  }
  if (!compact && a.recipe?.params?.prompt && a.recipe?.tool === 'image.generate') {
    acts.push(h('button', { title: 'Start a new image from this prompt', onclick: (e) => { e.stopPropagation(); $('#prompt').value = a.recipe.params.prompt; location.hash = '#create'; updateQuote(); } }, 'Reuse prompt'));
  }
  if (a.kind === 'video') acts.push(h('button', { onclick: (e) => { e.stopPropagation(); addClip(a.id); toast('Added to the timeline'); } }, compact ? '+' : 'Add to edit'));
  if (a.kind === 'audio') acts.push(h('button', { onclick: (e) => { e.stopPropagation(); setMusic(a); toast('Set as the music'); } }, 'Use as music'));
  return h('div', { class: 'tile', tabindex: 0, title: prompt }, media, h('div', { class: 'tile-actions' }, acts));
}
async function loadLibrary() {
  const grid = $('#libGrid');
  if (!state.user) {
    grid.replaceChildren();
    $('#libEmpty').hidden = false;
    $('#libEmpty').innerHTML = '<a href="#" id="libSignIn">Sign in</a> to see what you\'ve made.';
    $('#libSignIn').addEventListener('click', (e) => { e.preventDefault(); needSignIn(loadLibrary, 'login'); });
    return;
  }
  const items = await myAssets(libKind).catch(() => []);
  grid.replaceChildren(...items.map((a) => tile(a)));
  $('#libEmpty').hidden = items.length > 0;
  $('#libEmpty').innerHTML = 'Nothing here yet. Make something on <a href="#create">Create</a>.';
}

// ------------------------------------------------------------------ Editor
const TL_KEY = 'hg.timeline.v1';
// tracks: voice-overs and sound effects, each at a time on the cut ({ asset, title, kind: voice|sfx, start }).
let tl = { clips: [], music: null, tracks: [] };
try { tl = { ...tl, ...JSON.parse(localStorage.getItem(TL_KEY) || '{}') }; } catch { /* a fresh timeline */ }
const saveTl = () => { try { localStorage.setItem(TL_KEY, JSON.stringify(tl)); } catch { /* private window */ } };

function addClip(asset) {
  tl.clips.push({ asset, in: 0, out: null, duration: null, transition: 'crossfade', caption: '' });
  saveTl();
  renderTimeline();
}
function setMusic(a) {
  tl.music = { asset: a.id, title: a.title ?? 'Music' };
  saveTl();
  renderMusic();
}
const clipLen = (c) => Math.max(0, (c.out ?? c.duration ?? 0) - (c.in ?? 0));
function renderTimeline() {
  const ol = $('#timeline');
  ol.replaceChildren(...tl.clips.map((c, i) => {
    const v = h('video', { src: fileUrl(c.asset), muted: true, playsinline: true, preload: 'metadata' });
    v.addEventListener('loadedmetadata', () => {
      if (c.duration == null) { c.duration = Math.round(v.duration * 100) / 100; saveTl(); renderLength(); }
      outIn.max = String(c.duration ?? v.duration);
      if (!outIn.value) outIn.placeholder = String(Math.round(v.duration * 10) / 10);
    });
    const num = (val, onset) => h('input', { type: 'number', step: '0.1', min: '0', value: val ?? '', oninput: (e) => { onset(e.target.value === '' ? null : Number(e.target.value)); saveTl(); renderLength(); } });
    const inIn = num(c.in, (x) => { c.in = x ?? 0; });
    const outIn = num(c.out, (x) => { c.out = x; });
    return h('li', { class: 'clip', 'data-i': i },
      v,
      h('div', { class: 'ctl' },
        h('label', {}, 'In (s)', inIn),
        h('label', {}, 'Out (s)', outIn),
        h('label', { class: 'wide' }, 'Into the next',
          h('select', { onchange: (e) => { c.transition = e.target.value; saveTl(); } },
            ...['crossfade', 'cut', 'fadeblack', 'dissolve', 'wipeleft'].map((t) => h('option', { value: t, selected: c.transition === t }, t === 'fadeblack' ? 'fade to black' : t === 'wipeleft' ? 'wipe' : t)))),
        h('label', { class: 'wide' }, 'Caption', h('input', { value: c.caption ?? '', maxlength: '200', placeholder: 'Words on screen', oninput: (e) => { c.caption = e.target.value; saveTl(); } })),
      ),
      h('div', { class: 'ops' },
        h('button', { title: 'Earlier', disabled: i === 0, onclick: () => { [tl.clips[i - 1], tl.clips[i]] = [tl.clips[i], tl.clips[i - 1]]; saveTl(); renderTimeline(); } }, '←'),
        h('button', { title: 'Later', disabled: i === tl.clips.length - 1, onclick: () => { [tl.clips[i + 1], tl.clips[i]] = [tl.clips[i], tl.clips[i + 1]]; saveTl(); renderTimeline(); } }, '→'),
        h('button', { title: 'Remove', onclick: () => { tl.clips.splice(i, 1); saveTl(); renderTimeline(); } }, '✕'),
      ));
  }));
  $('#monitorEmpty').hidden = tl.clips.length > 0;
  if (tl.clips.length && !$('#monitor').src) { $('#monitor').src = fileUrl(tl.clips[0].asset); }
  renderLength();
}
function renderLength() {
  const total = tl.clips.reduce((s, c) => s + clipLen(c), 0);
  $('#tlLength').textContent = tl.clips.length ? `${tl.clips.length} clip${tl.clips.length === 1 ? '' : 's'}, ${total.toFixed(1)} s` : '';
}
function renderMusic() {
  const slot = $('#musicSlot');
  slot.replaceChildren();
  if (!tl.music) { slot.textContent = 'No music. Pick audio in the Library, or make some.'; return; }
  slot.append(h('div', {}, `♪ ${tl.music.title}`), h('audio', { src: fileUrl(tl.music.asset), controls: true, preload: 'none' }),
    h('button', { class: 'ghost small', onclick: () => { tl.music = null; saveTl(); renderMusic(); } }, 'Remove'));
}
function renderTracks() {
  tl.tracks ??= [];
  $('#tracks').replaceChildren(...tl.tracks.map((t, i) => h('div', { class: 'track' },
    h('div', {}, `${t.kind === 'voice' ? '🗣' : '🔊'} ${t.title}`),
    h('audio', { src: fileUrl(t.asset), controls: true, preload: 'none' }),
    h('label', { class: 'inline' }, 'at', h('input', { type: 'number', step: '0.5', min: '0', value: String(t.start ?? 0), oninput: (e) => { t.start = Math.max(0, Number(e.target.value) || 0); saveTl(); } }), 's'),
    h('button', { class: 'ghost small', onclick: () => { tl.tracks.splice(i, 1); saveTl(); renderTracks(); } }, 'Remove'))));
}
/** Makes a voice-over (audio.voice: the open voice models, a voice described in words) or a sound effect (audio.sfx). */
function makeTrack(kind, text, start, describe) {
  needSignIn(async () => {
    const note = h('div', { class: 'muted' }, kind === 'voice' ? 'Recording the voice…' : 'Making the sound…');
    $('#tracks').prepend(note);
    try {
      const spec = kind === 'voice' ? { tool: 'audio.voice', params: { text, description: describe } } : { tool: 'audio.sfx', params: { text } };
      const job = await submit(spec);
      const done = await waitJob(job.id, (s) => { note.textContent = s; });
      refreshCredits();
      const out = done.outputs.find((o) => o.kind === 'audio') ?? done.outputs[0];
      tl.tracks ??= [];
      tl.tracks.push({ asset: out.asset, title: text.slice(0, 80), kind, start });
      saveTl();
      renderTracks();
    } catch (err) {
      note.textContent = err.message;
      note.className = 'error';
      if (err.status === 402) openAccount();
    }
  });
}
$('#voiceForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#voiceText').value.trim();
  if (!text) return;
  makeTrack('voice', text, Number($('#voiceAt').value) || 0, $('#voiceKind').value);
  $('#voiceText').value = '';
});
$('#sfxForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#sfxText').value.trim();
  if (!text) return;
  makeTrack('sfx', text, Number($('#sfxAt').value) || 0);
  $('#sfxText').value = '';
});

async function renderBin() {
  const bin = $('#bin');
  if (!state.user) { bin.replaceChildren(h('p', { class: 'muted' }, 'Sign in to see your clips.')); return; }
  const vids = await myAssets('video', 40).catch(() => []);
  bin.replaceChildren(...(vids.length ? vids.map((a) => tile(a, { compact: true })) : [h('p', { class: 'muted' }, 'No clips yet: animate an image on Create.')]));
}

// Preview: the clips in order, each from its in to its out, with its caption.
let playing = false;
async function play() {
  if (playing) { playing = false; $('#monitor').pause(); $('#playBtn').textContent = 'Play'; return; }
  if (!tl.clips.length) return;
  playing = true;
  $('#playBtn').textContent = 'Stop';
  const mon = $('#monitor');
  const music = tl.music ? new Audio(fileUrl(tl.music.asset)) : null;
  if (music) { music.volume = 0.4; music.play().catch(() => {}); }
  // Voice-overs and sound effects at their times (preview only: the export places them exactly).
  const extras = (tl.tracks ?? []).map((t) => { const a = new Audio(fileUrl(t.asset)); return { a, timer: setTimeout(() => { if (playing) a.play().catch(() => {}); }, (t.start ?? 0) * 1000) }; });
  for (let i = 0; i < tl.clips.length && playing; i++) {
    const c = tl.clips[i];
    $$('#timeline .clip').forEach((el) => el.classList.toggle('playing', Number(el.dataset.i) === i));
    mon.src = fileUrl(c.asset);
    await new Promise((r) => mon.addEventListener('loadedmetadata', r, { once: true }));
    mon.currentTime = c.in ?? 0;
    $('#monitorCaption').textContent = c.caption ?? '';
    $('#monitorCaption').hidden = !c.caption;
    await mon.play().catch(() => {});
    const end = c.out ?? mon.duration;
    await new Promise((r) => {
      const tick = () => { if (!playing || mon.currentTime >= end - 0.05 || mon.ended) { mon.removeEventListener('timeupdate', tick); r(); } };
      mon.addEventListener('timeupdate', tick);
      mon.addEventListener('ended', tick, { once: true });
    });
  }
  mon.pause();
  music?.pause();
  for (const x of extras) { clearTimeout(x.timer); x.a.pause(); }
  $('#monitorCaption').hidden = true;
  $$('#timeline .clip').forEach((el) => el.classList.remove('playing'));
  playing = false;
  $('#playBtn').textContent = 'Play';
}
$('#playBtn').addEventListener('click', play);
$('#clearBtn').addEventListener('click', () => { if (confirm('Clear the timeline?')) { tl = { clips: [], music: null, tracks: [] }; saveTl(); $('#monitor').removeAttribute('src'); renderTimeline(); renderMusic(); renderTracks(); } });

// Make music for the edit (audio.music, ACE-Step).
$('#musicForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const prompt = $('#musicPrompt').value.trim();
  if (!prompt) return;
  needSignIn(async () => {
    const total = Math.max(10, Math.ceil(tl.clips.reduce((s, c) => s + clipLen(c), 0)) + 2);
    $('#musicSlot').textContent = 'Making music…';
    try {
      const job = await submit({ tool: 'audio.music', params: { prompt, seconds: Math.min(240, total) } });
      const done = await waitJob(job.id, (s) => { $('#musicSlot').textContent = `Making music: ${s}`; });
      refreshCredits();
      const out = done.outputs.find((o) => o.kind === 'audio') ?? done.outputs[0];
      setMusic({ id: out.asset, title: prompt });
    } catch (err) {
      $('#musicSlot').textContent = err.message;
    }
  });
});

// Export: the timeline as video.compose's timeline (docs/blender.md), rendered on Gen.
$('#exportBtn').addEventListener('click', () => needSignIn(async () => {
  if (!tl.clips.length) return toast('Add some clips first.');
  const [w, hh] = $('#exportShape').value.split('x').map(Number);
  const clips = tl.clips.map((c, i) => ({
    clip: i, ...(c.in ? { in: c.in } : {}), ...(c.out != null ? { out: c.out } : {}),
    ...(i < tl.clips.length - 1 && c.transition !== 'cut' ? { transition: c.transition, seconds: 0.5 } : {}),
  }));
  const captions = tl.clips.flatMap((c, i) => (c.caption ? [{ clip: i, start: 0, end: Math.max(0.5, clipLen(c) - 0.2) || 2, text: c.caption }] : []));
  // Audio inputs: the music first (if any), then each voice-over and sound effect. Music dips under the voice.
  const tracks = tl.tracks ?? [];
  const audioIn = [...(tl.music ? [tl.music.asset] : []), ...tracks.map((t) => t.asset)];
  const base = tl.music ? 1 : 0;
  const hasVoice = tracks.some((t) => t.kind === 'voice');
  const timeline = {
    clips, captions, fadeIn: 0.3, fadeOut: 0.6,
    audio: [
      ...(tl.music ? [{ audio: 0, volume: 0.35, loop: true, fadeIn: 0.5, fadeOut: 1.5, ...(hasVoice ? { duck: true } : {}) }] : []),
      ...tracks.map((t, i) => ({ audio: base + i, start: t.start ?? 0, ...(t.kind === 'voice' ? { dialogue: true, volume: 1 } : { volume: 0.8 }) })),
    ],
  };
  const slot = h('div', { class: 'muted' }, 'Rendering…');
  $('#exports').prepend(slot);
  $('#exportBtn').disabled = true;
  try {
    const job = await submit({
      tool: 'video.compose',
      inputs: { clips: tl.clips.map((c) => `asset:${c.asset}`), ...(audioIn.length ? { audio: audioIn.map((a) => `asset:${a}`) } : {}) },
      params: { timeline, width: w, height: hh, captions: captions.length ? $('#exportCaptions').value : 'vtt', fit: 'crop' },
    });
    const done = await waitJob(job.id, (s) => { slot.textContent = `Rendering: ${s}`; });
    refreshCredits();
    const out = done.outputs.find((o) => o.kind === 'video') ?? done.outputs[0];
    slot.replaceWith(h('div', {}, h('video', { src: fileUrl(out.asset), controls: true, playsinline: true }),
      h('a', { href: fileUrl(out.asset), download: 'hawkes-gen-edit.mp4' }, 'Download')));
  } catch (err) {
    slot.textContent = `Couldn't render: ${err.message}`;
  } finally {
    $('#exportBtn').disabled = false;
  }
}));

// ------------------------------------------------------------------ views
function route() {
  const v = (location.hash.replace('#', '') || 'create').split('/')[0];
  const view = ['create', 'library', 'editor'].includes(v) ? v : 'create';
  $$('.view').forEach((s) => { s.hidden = s.id !== `view-${view}`; });
  $$('.views a').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
  if (view === 'library') loadLibrary();
  if (view === 'editor') { renderTimeline(); renderMusic(); renderTracks(); renderBin(); }
  if (view === 'create') { $('#prompt').focus({ preventScroll: true }); showRecent(); }
}
addEventListener('hashchange', route);

await loadMe();
route();
updateQuote();
// Back from Stripe: say so, and show the new balance.
const back = new URLSearchParams(location.search).get('checkout');
if (back === 'success') { toast('Thanks: your credits are on their way.'); refreshCredits(); }
