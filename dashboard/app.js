// Hawkes Gen dashboard: plain JS over the /v1 API. Live job updates come from
// /v1/events (server-sent events).

import { benchTab } from './bench.js';
import { openStream } from '/gen/stream.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '—' : n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${Number(n).toFixed(2)}`);
const ago = (t) => {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(t).toLocaleDateString();
};
const dur = (a, b) => (a ? `${Math.round(((b ?? Date.now()) - a) / 1000)}s` : '');

async function api(path, opts = {}) {
  const r = await fetch(`/v1${path}`, { ...opts, headers: { ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/dashboard/')) signIn();
  if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), body);
  return body;
}

// Where Gen isn't on J's PC (Cloud Run), the dashboard signs in with an owner or admin key once: the server keeps it in
// an HttpOnly cookie (auth.ts KEY_COOKIE), so links, images and the event stream work too.
function signIn() {
  if (signIn.open) return;
  signIn.open = true;
  const b = modal(`<h2>Sign in to Hawkes Gen</h2><div id="sigoogle" style="margin:6px 0 14px"></div>
    <details id="sikeys"><summary>Sign in with a key instead</summary>
    <p>Paste an owner or admin key (<code>hg_…</code>). On your PC it's <code>genKey</code> in <code>~/.hawkes/client.json</code>. This browser keeps you signed in for 30 days.</p>
    <div class="row"><input id="sik" type="password" autocomplete="off" style="flex:1" placeholder="hg_…"><button class="primary" id="sigo">Sign in</button></div></details><p class="small muted" id="sierr"></p>`);
  // "Continue with Google" when this Gen has it set up (settings.dashboard): Google's own button, then Gen checks the
  // token with Google and lets in only the listed accounts (src/dashauth.ts).
  fetch('/v1/dashboard/google').then((r) => r.json()).then(({ clientId }) => {
    if (!clientId) { $('#sikeys', b).open = true; return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => {
      google.accounts.id.initialize({
        client_id: clientId,
        callback: ({ credential }) => fetch('/v1/dashboard/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) })
          .then(async (r) => { if (r.ok) location.reload(); else $('#sierr', b).textContent = (await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`; }),
      });
      google.accounts.id.renderButton($('#sigoogle', b), { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill' });
    };
    s.onerror = () => { $('#sikeys', b).open = true; $('#sierr', b).textContent = 'Google sign-in could not load: use a key.'; };
    document.head.append(s);
  }).catch(() => { $('#sikeys', b).open = true; });
  const go = () => fetch('/v1/dashboard/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: $('#sik', b).value }) })
    .then(async (r) => { if (r.ok) location.reload(); else $('#sierr', b).textContent = (await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`; });
  $('#sigo', b).onclick = go;
  $('#sik', b).onkeydown = (e) => { if (e.key === 'Enter') go(); };
  $('#modal').addEventListener('close', () => { signIn.open = false; }, { once: true });
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), 3500);
}
const fail = (e) => toast(e.message ?? String(e));

function modal(html) {
  $('#modalBody').innerHTML = html;
  const d = $('#modal');
  if (!d.open) d.showModal();
  return $('#modalBody');
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') e.target.close(); });

// On a phone, table rows stack into cards (style.css): each cell gets its column's
// header as a label, from whatever table a render just wrote.
function labelCells() {
  for (const table of document.querySelectorAll('table:not([data-labelled])')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (heads.length) for (const tr of table.querySelectorAll('tbody tr')) [...tr.children].forEach((td, i) => { if (heads[i]) td.dataset.label = heads[i]; });
    table.dataset.labelled = '';
  }
}
new MutationObserver(labelCells).observe(document.body, { childList: true, subtree: true });

// ---------------------------------------------------------------- tabs
let current = location.hash.slice(1) || 'overview';
function show(tab) {
  current = tab;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  // On a phone the tabs are a strip that scrolls sideways: keep the open one in view.
  $(`#tabs button[data-tab="${tab}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('on', s.id === tab);
  history.replaceState(null, '', `#${tab}`);
  render[tab]?.().catch(fail);
}
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => show(b.dataset.tab);
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (t && t !== current && render[t]) show(t); });

const state = { jobs: new Map(), tools: [], projects: new Set() };

// ---------------------------------------------------------------- live
// Reopened with a growing wait after a restart or a deploy (/gen/stream.js); the open tab redraws once it's back.
function connect() {
  const pill = (s) => { $('#live').textContent = s === 'live' ? 'live' : 'reconnecting…'; $('#live').className = s === 'live' ? 'pill ok' : 'pill warn'; };
  openStream({ job: (j) => {
    if (!j?.id) return;
    state.jobs.set(j.id, j);
    state.projects.add(j.project);
    if (current === 'jobs' || current === 'overview' || (current === 'playtests' && j.tool === 'playtest.run')) scheduleRender();
    const open = $('#modalBody [data-job]');
    if (open?.dataset.job === j.id && $('#modal').open) showJob(j.id, true);
  },
  // The Fleet and Machines tabs redraw when the server took a reading (about every minute while machines run); the Bench
  // tab when a run moved on. Nothing asks on a timer (J, 2026-11-02: no polling).
  machines: () => { if (['fleet', 'machines'].includes(current) && !$('#modal').open) redrawMachines(); },
  bench: () => document.dispatchEvent(new CustomEvent('gen:bench')),
  }, { onState: pill, onReconnect: () => { scheduleRender(); redrawMachines(); document.dispatchEvent(new CustomEvent('gen:bench')); } });
}
/** The open Fleet or Machines tab, from the reading the server just took (no new measuring over SSH). */
let lastMachines = 0;
function redrawMachines() {
  if (!['fleet', 'machines'].includes(current) || $('#modal').open || Date.now() - lastMachines < 2000) return;
  lastMachines = Date.now();
  render[current](false).catch(() => {});
}
let pending = null;
function scheduleRender() {
  if (pending) return;
  pending = setTimeout(() => { pending = null; render[current]?.().catch(fail); }, 400);
}

// ---------------------------------------------------------------- jobs
const statusCell = (j) => `<span class="status s-${j.status}">${j.status}</span>`;
function jobRow(j) {
  const tool = state.tools.find((t) => t.id === j.tool);
  return `<tr class="click" data-open="${j.id}">
    <td>${statusCell(j)}<div class="small muted">${esc(ago(j.created))}</div></td>
    <td><b>${esc(tool?.title ?? j.tool)}</b><div class="small muted">${esc(j.tool)}</div></td>
    <td>${esc(j.project)}${Object.keys(j.labels ?? {}).length ? `<div class="chips">${Object.entries(j.labels).map(([k, v]) => `<span class="chip">${esc(k)}: ${esc(v)}</span>`).join('')}</div>` : ''}</td>
    <td class="small">${esc(j.detail)}</td>
    <td class="num">${j.outputs?.length ?? 0}</td>
    <td class="num small">${j.gpu_seconds ? `${Math.round(j.gpu_seconds)}s GPU<br>` : ''}${j.cost ? money(j.cost) : ''}</td>
  </tr>`;
}
function bindRows(root) {
  for (const tr of root.querySelectorAll('[data-open]')) tr.onclick = () => showJob(tr.dataset.open);
}

async function loadJobs(params = '') {
  const { jobs } = await api(`/jobs?limit=200${params}`);
  for (const j of jobs) { state.jobs.set(j.id, j); state.projects.add(j.project); }
  return jobs;
}

function mediaTag(a, controls = false) {
  const src = `/v1/files/${a.asset ?? a.id}`;
  if (a.kind === 'image') return `<img src="${src}" loading="lazy" alt="">`;
  if (a.kind === 'video') return `<video src="${src}" ${controls ? 'controls' : 'muted loop'} preload="metadata"${controls ? '' : ' onmouseenter="this.play()" onmouseleave="this.pause()"'}></video>`;
  if (a.kind === 'audio') return controls ? `<audio src="${src}" controls></audio>` : '<div class="glyph">♪</div>';
  if (a.kind === 'mesh') return `<model-viewer src="${src}" ${controls ? 'camera-controls auto-rotate style="width:100%;height:60vh"' : 'auto-rotate style="width:100%;height:100%"'} shadow-intensity="1" exposure="1.1"></model-viewer>`;
  return '<div class="glyph">▣</div>';
}

async function showJob(id, refresh = false) {
  const j = await api(`/jobs/${id}`);
  const tool = state.tools.find((t) => t.id === j.tool);
  const body = modal(`<div data-job="${j.id}">
    <div class="row spread"><h2>${esc(tool?.title ?? j.tool)} ${statusCell(j)}</h2>
      <div class="row">${['queued', 'running'].includes(j.status) ? '<button class="danger" data-act="cancel">Cancel</button>' : ''}
      <button data-act="rerun">Run again</button><button data-act="rerun-same">Same seed</button><button data-act="close">Close</button></div></div>
    <p class="muted">${esc(j.detail)}${j.error ? `<br><b style="color:var(--bad)">${esc(j.error)}</b>` : ''}</p>
    <div class="row small muted">${esc(j.id)} · ${esc(j.project)} · ${esc(j.client)} · created ${esc(ago(j.created))}${j.started ? ` · ran ${dur(j.started, j.finished)}` : ''}${j.server ? ` · ${esc(j.server)}` : ''}${j.gpu_seconds ? ` · ${Math.round(j.gpu_seconds)}s GPU` : ''}${j.cost ? ` · ${money(j.cost)}` : ''}</div>
    ${j.outputs?.length ? `<h3 style="margin-top:14px">Outputs</h3><div class="lib">${j.outputs.map((o) => `<div class="asset"><div class="media" data-asset="${o.asset}">${mediaTag(o)}</div><div class="meta"><span>${esc(o.title ?? o.kind)}${o.seed ? ` · seed ${o.seed}` : ''}</span><a href="/v1/files/${o.asset}?download=1">download</a></div></div>`).join('')}</div>` : ''}
    ${j.result ? `<h3 style="margin-top:14px">Result</h3><pre>${esc(typeof j.result === 'string' ? j.result : JSON.stringify(j.result, null, 2))}</pre>` : ''}
    <details><summary>Params</summary><pre>${esc(JSON.stringify(j.params, null, 2))}</pre></details>
    <details><summary>Inputs</summary><pre>${esc(JSON.stringify(j.inputs, null, 2))}</pre></details>
    ${j.graphs?.length ? `<details><summary>ComfyUI graphs (${j.graphs.length})</summary>${j.graphs.map((g) => `<div><a href="/v1/jobs/${j.id}/graphs/${g}">${esc(g)}</a></div>`).join('')}<p class="small muted">Drag one into ComfyUI to load it.</p></details>` : ''}
    <details ${refresh ? 'open' : ''}><summary>Log (${j.log?.length ?? 0})</summary><pre>${esc((j.log ?? []).join('\n'))}</pre></details>
  </div>`);
  body.querySelector('[data-act="close"]').onclick = () => $('#modal').close();
  body.querySelector('[data-act="cancel"]')?.addEventListener('click', () => post(`/jobs/${j.id}/cancel`).then(() => showJob(j.id)).catch(fail));
  body.querySelector('[data-act="rerun"]').onclick = () => post(`/jobs/${j.id}/rerun`).then((n) => showJob(n.id)).catch(fail);
  body.querySelector('[data-act="rerun-same"]').onclick = () => post(`/jobs/${j.id}/rerun`, { sameSeed: true }).then((n) => showJob(n.id)).catch(fail);
  for (const m of body.querySelectorAll('[data-asset]')) m.onclick = () => showAsset(m.dataset.asset);
}

const render = {};

// The beta lane (beta.hawkesgen.ai) says so on every page, so it's never taken for live.
fetch('/v1/health').then((r) => r.json()).then((h) => {
  if (h.lane !== 'beta') return;
  document.title = `BETA · ${document.title}`;
  document.querySelector('.brand b')?.insertAdjacentHTML('afterend', ' <span class="lane-badge">BETA</span>');
}).catch(() => {});

render.overview = async () => {
  const [health, jobs, usage] = await Promise.all([api('/health'), loadJobs(), api(`/usage?since=${Date.now() - 30 * 86400000}`)]);
  let fleet = null;
  try { fleet = await api('/fleet'); } catch { /* AWS not set up */ }
  let st = null;
  try { st = await api('/storage'); } catch { /* storage status unavailable */ }
  const running = jobs.filter((j) => j.status === 'running').length;
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const ready = fleet?.servers?.filter((s) => s.state === 'running' && s.boot?.stage === 'ready').length ?? 0;
  const prov = Object.entries(health.providers).map(([k, v]) => `<span class="pill ${v ? 'ok' : 'bad'}">${k} ${v ? '✓' : 'not set up'}</span>`).join(' ');
  $('#overview').innerHTML = `
    <div class="grid">
      <div class="card stat"><b>${running}</b><span>jobs running</span></div>
      <div class="card stat"><b>${queued}</b><span>jobs waiting</span></div>
      <div class="card stat"><b>${ready} / ${fleet?.servers?.length ?? 0}</b><span>GPU servers ready</span></div>
      <div class="card stat"><b>${money(usage.total)}</b><span>spent in the last 30 days</span></div>
    </div>
    <div class="card"><div class="row spread"><h3>Providers</h3><span class="small muted">v${esc(health.version)}</span></div><div class="row">${prov}</div>
      ${health.elevenlabsBilling?.blocked ? `<p class="small" style="color:var(--bad)">ElevenLabs billing blocked since ${new Date(health.elevenlabsBilling.since).toLocaleTimeString()}: ${esc(health.elevenlabsBilling.message)} The next job probes again at ${new Date(health.elevenlabsBilling.until).toLocaleTimeString()}.</p>` : ''}
      ${fleet?.error ? `<p class="small" style="color:var(--bad)">${esc(fleet.error)}</p>` : ''}</div>
    ${st?.bucket ? `<div class="card"><div class="row spread"><h3>Library in S3</h3><span class="small muted">${esc(st.bucket)}</span></div>
      <p class="small">${st.backedUp} of ${st.files} files backed up. ${st.queued ? `<b>${st.queued}</b> waiting to upload (${st.queueLength} in line, ${st.uploading} uploading).` : 'Nothing waiting to upload.'}${st.failures ? ` <span style="color:var(--bad)">${st.failures} failed: ${esc(st.lastError)}</span>` : ''}</p></div>` : ''}
    <div class="card"><div class="row spread"><h3>Recent jobs</h3><button data-go="jobs">All jobs</button></div>
      ${jobs.length ? `<table><thead><tr><th>Status</th><th>Tool</th><th>Project</th><th>Detail</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody>${jobs.slice(0, 12).map(jobRow).join('')}</tbody></table>` : '<div class="empty">No jobs yet. Try a tool in the Tools tab, or call the API from a game.</div>'}</div>`;
  bindRows($('#overview'));
  $('#overview [data-go]').onclick = () => show('jobs');
};

render.jobs = async () => {
  const f = render.jobs.filter ?? { project: '', status: '' };
  const jobs = await loadJobs(`${f.project ? `&project=${encodeURIComponent(f.project)}` : ''}${f.status ? `&status=${f.status}` : ''}`);
  $('#jobs').innerHTML = `
    <div class="row spread"><h2>Jobs</h2><div class="row">
      <select id="jp"><option value="">All projects</option>${[...state.projects].sort().map((p) => `<option ${p === f.project ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <select id="js"><option value="">Any status</option>${['queued', 'running', 'done', 'failed', 'cancelled'].map((s) => `<option ${s === f.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <button id="jclear">Clear finished</button></div></div>
    <div class="card">${jobs.length ? `<table><thead><tr><th>Status</th><th>Tool</th><th>Project</th><th>Detail</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody>${jobs.map(jobRow).join('')}</tbody></table>` : '<div class="empty">No jobs.</div>'}</div>`;
  $('#jp').onchange = (e) => { render.jobs.filter = { ...f, project: e.target.value }; render.jobs(); };
  $('#js').onchange = (e) => { render.jobs.filter = { ...f, status: e.target.value }; render.jobs(); };
  $('#jclear').onclick = () => confirm('Remove finished, failed and cancelled jobs from the list? Their files stay in the library.') && post('/jobs/clear', { project: f.project || undefined }).then(() => render.jobs()).catch(fail);
  bindRows($('#jobs'));
};

// ---------------------------------------------------------------- library
async function showAsset(id) {
  const a = await api(`/assets/${encodeURI(id)}`);
  if (String(a.id).startsWith('motion:')) {
    const body = modal(`<div class="row spread"><h2>${esc(a.title)}</h2><div class="row"><button data-act="copy">Copy id</button><button data-act="close">Close</button></div></div>
      <p>${esc((a.tags ?? []).join(' · '))} · ${a.meta?.duration}s · ${a.meta?.loop ? 'loops' : 'plays once'}</p>
      <p class="small muted">${esc(a.labels?.pack ?? '')} · ${esc(a.labels?.license ?? 'CC0-1.0')}</p>
      <p>Use it in a job as <code>${esc(a.id)}</code>, or put several on a character with preset <code>shared/motions</code>.</p>`);
    body.querySelector('[data-act="close"]').onclick = () => $('#modal').close();
    body.querySelector('[data-act="copy"]').onclick = () => navigator.clipboard.writeText(a.id).then(() => toast('Copied'));
    return;
  }
  const body = modal(`<div class="row spread"><h2>${esc(a.title ?? `${a.tool} · ${a.kind}`)}</h2><div class="row">
      <button class="star ${a.starred ? 'on' : ''}" data-act="star">★</button><a href="/v1/files/${a.id}?download=1"><button>Download</button></a><button data-act="copy">Copy id</button><button class="danger" data-act="delete">Delete</button><button data-act="close">Close</button></div></div>
    <div class="preview">${mediaTag(a, true)}</div>
    <div class="form" style="margin-top:12px">
      <label><span>Title</span><input id="at" value="${esc(a.title ?? '')}"></label>
      <label><span>Tags (comma separated)</span><input id="ag" value="${esc((a.tags ?? []).join(', '))}"></label>
    </div>
    <div class="row" style="margin-top:8px"><button class="primary" data-act="save">Save</button><span class="small muted">${esc(a.id)} · ${esc(a.project)} · ${esc(a.mime)} · ${(a.bytes / 1024).toFixed(0)} KB · ${esc(ago(a.created))}${a.seed ? ` · seed ${a.seed}` : ''}${a.job ? ` · job <a href="#" data-job-link="${a.job}">${esc(a.job)}</a>` : ''}</span></div>
    ${Object.keys(a.labels ?? {}).length ? `<div class="chips" style="margin-top:8px">${Object.entries(a.labels).map(([k, v]) => `<span class="chip">${esc(k)}: ${esc(v)}</span>`).join('')}</div>` : ''}
    <details><summary>Recipe (what made it)</summary><pre>${esc(JSON.stringify(a.recipe, null, 2))}</pre></details>
    <p class="small muted">Use it in another job as <code>asset:${esc(a.id)}</code>.</p>`);
  body.querySelector('[data-act="close"]').onclick = () => $('#modal').close();
  body.querySelector('[data-act="copy"]').onclick = () => navigator.clipboard.writeText(`asset:${a.id}`).then(() => toast('Copied'));
  body.querySelector('[data-act="star"]').onclick = () => api(`/assets/${a.id}`, { method: 'PATCH', body: JSON.stringify({ starred: !a.starred }) }).then(() => { showAsset(a.id); if (current === 'library' || current === 'playtests') render[current](); }).catch(fail);
  body.querySelector('[data-act="save"]').onclick = () => api(`/assets/${a.id}`, { method: 'PATCH', body: JSON.stringify({ title: $('#at').value || null, tags: $('#ag').value.split(',').map((s) => s.trim()).filter(Boolean) }) }).then(() => { toast('Saved'); if (current === 'library' || current === 'playtests') render[current](); }).catch(fail);
  body.querySelector('[data-act="delete"]').onclick = () => confirm('Delete this file from the library for good?') && api(`/assets/${a.id}`, { method: 'DELETE' }).then(() => { $('#modal').close(); if (current === 'library' || current === 'playtests') render[current](); }).catch(fail);
  body.querySelector('[data-job-link]')?.addEventListener('click', (e) => { e.preventDefault(); showJob(a.job); });
}

render.library = async () => {
  const f = render.library.filter ?? { project: '', kind: '', q: '', starred: false, offset: 0 };
  const qs = new URLSearchParams({ limit: '60', offset: String(f.offset) });
  if (f.project) qs.set('project', f.project);
  if (f.kind) qs.set('kind', f.kind);
  if (f.q) qs.set('q', f.q);
  if (f.starred) qs.set('starred', '1');
  const { items, total } = await api(`/assets?${qs}`);
  for (const a of items) state.projects.add(a.project);
  $('#library').innerHTML = `
    <div class="row spread"><h2>Library <span class="muted small">${total} files</span></h2><div class="row">
      <input id="lq" placeholder="Search titles, labels, prompts" value="${esc(f.q)}">
      <select id="lp"><option value="">All projects</option>${[...state.projects].sort().map((p) => `<option ${p === f.project ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <select id="lk"><option value="">All kinds</option>${['image', 'video', 'audio', 'mesh', 'text', 'file'].map((k) => `<option ${k === f.kind ? 'selected' : ''}>${k}</option>`).join('')}</select>
      <label class="row small"><input type="checkbox" id="ls" ${f.starred ? 'checked' : ''}> starred</label></div></div>
    ${items.length ? `<div class="lib">${items.map((a) => `<div class="asset"><div class="media" data-asset="${esc(a.id)}">${String(a.id).startsWith('motion:') ? '<div class="glyph">▶</div>' : mediaTag(a)}</div><div class="meta">
      <div class="row spread"><span class="t">${esc(a.title ?? Object.values(a.labels ?? {}).join(' · ') ?? a.tool) || esc(a.tool)}</span>${String(a.id).startsWith('motion:') ? '' : `<button class="star ${a.starred ? 'on' : ''}" data-star="${a.id}" data-on="${a.starred}">★</button>`}</div>
      <span class="muted">${String(a.id).startsWith('motion:') ? `${esc((a.tags ?? []).join(' · '))} · ${a.meta?.duration}s · ${a.meta?.loop ? 'loops' : 'once'}` : `${esc(a.project)} · ${esc(a.tool)} · ${esc(ago(a.created))}`}</span></div></div>`).join('')}</div>` : '<div class="card empty">Nothing here yet.</div>'}
    <div class="row" style="margin-top:12px">${f.offset ? '<button id="lprev">Newer</button>' : ''}${f.offset + items.length < total ? '<button id="lnext">Older</button>' : ''}</div>`;
  const set = (patch) => { render.library.filter = { ...f, offset: 0, ...patch }; render.library().catch(fail); };
  $('#lq').onchange = (e) => set({ q: e.target.value });
  $('#lp').onchange = (e) => set({ project: e.target.value });
  $('#lk').onchange = (e) => set({ kind: e.target.value });
  $('#ls').onchange = (e) => set({ starred: e.target.checked });
  $('#lprev')?.addEventListener('click', () => set({ offset: Math.max(0, f.offset - 60) }));
  $('#lnext')?.addEventListener('click', () => set({ offset: f.offset + 60 }));
  for (const m of document.querySelectorAll('#library [data-asset]')) m.onclick = () => showAsset(m.dataset.asset);
  for (const s of document.querySelectorAll('#library [data-star]')) s.onclick = () => api(`/assets/${s.dataset.star}`, { method: 'PATCH', body: JSON.stringify({ starred: s.dataset.on !== '1' }) }).then(() => render.library()).catch(fail);
};

// ---------------------------------------------------------------- playtests
render.playtests = async () => {
  const f = render.playtests.filter ?? { project: '', kind: 'video', q: '', starred: false, offset: 0 };
  const qs = new URLSearchParams({ playtest: '1', limit: '60', offset: String(f.offset) });
  if (f.project) qs.set('project', f.project);
  if (f.kind) qs.set('kind', f.kind);
  if (f.q) qs.set('q', f.q);
  if (f.starred) qs.set('starred', '1');
  const { items, total } = await api(`/assets?${qs}`);
  for (const a of items) state.projects.add(a.project);
  const kinds = [['video', 'Playtest videos'], ['image', 'Screenshots'], ['text', 'Reports'], ['', 'All playtest files']];
  $('#playtests').innerHTML = `
    <div class="row spread"><h2>Playtests <span class="muted small">${total} files</span></h2><div class="row">
      <input id="pq" placeholder="Search titles, scenarios, labels" value="${esc(f.q)}">
      <select id="pp"><option value="">All projects</option>${[...state.projects].sort().map((p) => `<option ${p === f.project ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <select id="pk">${kinds.map(([v, label]) => `<option value="${v}" ${v === f.kind ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <label class="row small"><input type="checkbox" id="ps" ${f.starred ? 'checked' : ''}> starred</label></div></div>
    ${items.length ? `<div class="lib">${items.map((a) => `<div class="asset"><div class="media" data-asset="${esc(a.id)}">${mediaTag(a)}</div><div class="meta">
      <div class="row spread"><span class="t">${esc(a.title ?? Object.values(a.labels ?? {}).join(' · ') ?? a.tool) || esc(a.tool)}</span><button class="star ${a.starred ? 'on' : ''}" data-star="${a.id}" data-on="${a.starred}">★</button></div>
      <span class="muted">${esc(a.project)}${a.recipe?.params?.scenario ? ` · ${esc(a.recipe.params.scenario)}` : ''} · ${esc(ago(a.created))}${a.job ? ` · <a href="#" data-job-link="${esc(a.job)}">${esc(a.job)}</a>` : ''}</span></div></div>`).join('')}</div>` : '<div class="card empty">No playtest recordings here yet.</div>'}
    <div class="row" style="margin-top:12px">${f.offset ? '<button id="pprev">Newer</button>' : ''}${f.offset + items.length < total ? '<button id="pnext">Older</button>' : ''}</div>`;
  const set = (patch) => { render.playtests.filter = { ...f, offset: 0, ...patch }; render.playtests().catch(fail); };
  $('#pq').onchange = (e) => set({ q: e.target.value });
  $('#pp').onchange = (e) => set({ project: e.target.value });
  $('#pk').onchange = (e) => set({ kind: e.target.value });
  $('#ps').onchange = (e) => set({ starred: e.target.checked });
  $('#pprev')?.addEventListener('click', () => set({ offset: Math.max(0, f.offset - 60) }));
  $('#pnext')?.addEventListener('click', () => set({ offset: f.offset + 60 }));
  for (const m of document.querySelectorAll('#playtests [data-asset]')) m.onclick = () => showAsset(m.dataset.asset);
  for (const s of document.querySelectorAll('#playtests [data-star]')) s.onclick = () => api(`/assets/${s.dataset.star}`, { method: 'PATCH', body: JSON.stringify({ starred: s.dataset.on !== '1' }) }).then(() => render.playtests()).catch(fail);
  for (const l of document.querySelectorAll('#playtests [data-job-link]')) l.onclick = (e) => { e.preventDefault(); showJob(l.dataset.jobLink); };
};

/** Remote Desktop for the build server: downloads the .rdp for its current address (letting this browser's IP in), or offers Start. */
async function remoteDesktop(refresh) {
  const r = await fetch('/v1/builder/rdp-file');
  if (r.ok) {
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: 'hawkes-builder.rdp' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Remote Desktop file downloaded. Open it, then use Show password.');
    return;
  }
  const body = await r.json().catch(() => ({}));
  if (body.ready === false) {
    if (confirm(`The build server is ${body.state}. Start it? About $0.77/hr while it runs (your IP is let in on Remote Desktop either way).`)) {
      await post('/builder/start', { confirm: true }).then(() => toast('Starting. Click Remote Desktop again in a few minutes.')).catch(fail);
      refresh?.();
    }
    return;
  }
  throw new Error(body.error ?? `HTTP ${r.status}`);
}
/** Shows the build server's Administrator password on demand, with a copy button. */
async function showBuilderPassword() {
  const r = await post('/builder/password');
  const body = modal(`<h2>Build server password</h2><p class="small muted">User <b>${esc(r.user)}</b>. Shown only now; it isn't logged.</p><input id="pw" readonly value="${esc(r.password)}" style="width:100%"><div class="row" style="margin-top:12px"><button class="primary" id="pwc">Copy</button><button id="pwx">Close</button></div>`);
  body.querySelector('#pwc').onclick = () => navigator.clipboard.writeText(r.password).then(() => toast('Password copied'), () => { body.querySelector('#pw').select(); });
  body.querySelector('#pwx').onclick = () => $('#modal').close();
}
/** The ssh command for a GPU server (they're Linux: no Remote Desktop), copied to the clipboard. */
async function copySsh(id) {
  const r = await api(`/fleet/connect?id=${encodeURIComponent(id)}`);
  if (!r.ready) return toast(`The server is ${r.state}: start it first (GPU fleet tab).`);
  await navigator.clipboard.writeText(r.command).catch(() => {});
  toast(`${r.command}${r.keyFile ? ` (key file ${r.keyFile} is in the control server's fleet folder)` : ''} copied`);
}

// ---------------------------------------------------------------- fleet
/** The Unity build server card (builds Unity games for WebGL; see src/providers/builder). */
async function renderBuilder() {
  const el = $('#fl-builder');
  if (!el) return;
  let b;
  try { b = await api('/builder'); } catch (e) { el.innerHTML = `<h3>Unity build server</h3><p class="small">${esc(e.message)}</p>`; return; }
  const bact = (a, body = {}) => post(`/builder/${a}`, body).then((r) => { toast(`build server: ${a}`); renderBuilder(); return r; }).catch((e) => { fail(e); renderBuilder(); });
  if (!b.exists) {
    el.innerHTML = `<h3>Unity build server</h3><p class="small muted">Builds Unity games for WebGL on a Windows machine that keeps each project's Library, so builds are incremental. About ${money(b.types['m7i.2xlarge'].price)}/hr while it runs (it stops itself when idle) plus ${money(b.diskPerMonth)}/month for its ${b.diskGb} GB disk.</p><button class="primary" id="bl-launch">Launch build server…</button>`;
    $('#bl-launch').onclick = () => confirm('Launch the Unity build server? It costs money while it runs.') && bact('launch', { confirm: true });
    return;
  }
  el.innerHTML = `<div class="row spread"><h3>Unity build server</h3><div class="row">
      ${b.state === 'stopped' ? '<button data-b="start">Start</button>' : ''}${['running', 'pending'].includes(b.state) ? '<button data-b="stop">Stop</button>' : ''}
      <button data-b="remote">Remote Desktop</button><button data-b="password">Show password</button><button data-b="access">Refresh access</button><button class="danger" data-b="terminate">Terminate</button></div></div>
    <table><tbody>
      <tr><td>Server</td><td><b>${esc(b.id)}</b> · ${esc(b.type)} · ${esc(b.region)} · ${money(b.pricePerHour)}/hr${b.idleMinutes ? ` · stops after ${b.idleMinutes} idle min` : ''}</td></tr>
      <tr><td>State</td><td>${esc(b.state)}${b.stage ? ` · <b>${esc(b.stage.stage)}</b>: ${esc(b.stage.detail ?? '')}` : ''}</td></tr>
      ${b.stage?.stage === 'license' ? `<tr><td>To do</td><td style="color:var(--warn)">Click Remote Desktop, open the file, sign in as Administrator (click Show password), open Unity Hub and sign in once. Then builds can run.</td></tr>` : ''}
      ${b.rdpFile ? `<tr><td>Remote Desktop</td><td class="small">${esc(b.rdpFile)}</td></tr>` : ''}
    </tbody></table>`;
  for (const btn of el.querySelectorAll('[data-b]')) {
    btn.onclick = () => {
      const a = btn.dataset.b;
      if (a === 'remote') return remoteDesktop(renderBuilder).catch(fail);
      if (a === 'password') return showBuilderPassword().catch(fail);
      if (a === 'terminate' && !confirm('Delete the build server and its disk? Every project Library goes with it (the next builds are clean ones).')) return;
      if (a === 'start' && !confirm('Start the build server? About $0.77/hr while it runs.')) return;
      bact(a, ['start', 'terminate'].includes(a) ? { confirm: true } : {}).then((r) => { if (a === 'rdp' && r) toast(`Saved ${r.rdpFile}`); });
    };
  }
}

function bootCell(s) {
  const unfinished = s.unfinished ? `<div class="small" style="color:var(--warn)">install unfinished (at: ${esc(s.unfinished.detail)})${s.unfinished.resumable ? '; starting it resumes the install' : '; launched before installs resumed, so starting it is refused'}</div>` : '';
  if (s.state !== 'running') return `<span class="status s-${s.state}">${esc(s.state)}</span>${s.reason ? `<div class="small muted">${esc(s.reason)}</div>` : ''}${unfinished}`;
  const stage = s.boot?.stage ?? 'booting';
  if (stage === 'image source') return `<span class="status s-stopped">image source</span><div class="small muted">${esc(s.boot.detail)}</div>`;
  const run = s.boot?.run > 1 ? ` (resumed, run ${s.boot.run})` : '';
  const stuck = s.stuck ? `<div class="small" style="color:var(--bad)"><b>stuck</b>: no progress for ${s.stuck.minutes} min. It powers itself off after 20 min without progress; check its Log.</div>` : '';
  const lastFailure = s.boot?.lastFailure && stage !== 'ready' && stage !== 'failed' ? `<div class="small muted">last run: ${esc(s.boot.lastFailure)}</div>` : '';
  const warm = s.boot?.warm && stage === 'ready' && !/^(\d+) of \1$/.test(s.boot.warm) ? `<div class="small muted">warming the disk: ${esc(s.boot.warm)} models read</div>` : '';
  return `<span class="status s-${stage === 'ready' ? 'ready' : stage === 'failed' || stage === 'locked out' || s.stuck ? 'failed' : 'booting'}">${esc(s.stuck ? 'stuck' : stage)}</span><div class="small muted">${esc(s.boot?.detail ?? '')}${esc(run)}</div>${stuck}${lastFailure}${stage === 'booting' ? unfinished : ''}${warm}`;
}

/** The machine image card: which image each region launches from, the build, and its buttons. */
async function renderImage() {
  const el = $('#fl-image');
  if (!el) return;
  let im;
  try {
    im = await api('/fleet/image');
  } catch (e) {
    el.innerHTML = `<h3>Machine image</h3><div class="small muted">${esc(e.message)}</div>`;
    return;
  }
  const b = im.build;
  const rows = im.regions.map((r) => `<tr><td>${esc(r.region)}</td><td>${r.current ? `<b>${esc(r.current.id)}</b> <span class="small muted">${esc(r.current.created.slice(0, 10))}${r.current.usedGb ? ` · ${r.current.usedGb} GB` : ''}</span>` : r.error ? `<span class="small" style="color:var(--bad)">${esc(r.error)}</span>` : '<span class="muted">none: servers here install from bootstrap.sh (30-45 min)</span>'}</td><td class="small muted">${r.others.map((o) => `${esc(o.id)} (${esc(o.state)}${o.key !== im.key ? ', out of date' : ''})`).join(', ') || '—'}</td></tr>`).join('');
  el.innerHTML = `<div class="row spread"><h3>Machine image</h3><div class="row">
      ${b?.active ? '<button id="im-cancel">Cancel build</button>' : '<button id="im-build">Build new image…</button>'}<button id="im-prune">Delete old images…</button></div></div>
    <p class="small muted">New servers launch from the image matching server/models.json (ComfyUI ${esc(im.comfy)}, ${im.models} core models, key ${esc(im.key)}) and are ready in minutes${im.disposable ? '; idle, they are terminated (no disk left paying)' : ''}. ${im.stale ? '<b style="color:var(--warn)">The images are out of date (models.json or ComfyUI changed): build a new one.</b> ' : ''}Snapshots cost about ${money(im.costPerMonth)} a month.</p>
    <table><thead><tr><th>Region</th><th>Launches from</th><th>Other images</th></tr></thead><tbody>${rows}</tbody></table>
    ${b ? `<div class="small" style="margin-top:8px"><b>Build ${esc(b.id)}</b>: ${esc(b.phase)}${b.active ? ' (running)' : ''}${b.from ? ` · server ${esc(b.from)}` : ''}${b.error ? ` · <span style="color:var(--bad)">${esc(b.error)}</span>` : ''}<div class="muted">${b.log.slice(-4).map((l) => `${esc(new Date(l.at).toLocaleTimeString())} ${esc(l.msg)}`).join('<br>')}</div></div>` : ''}`;
  $('#im-cancel')?.addEventListener('click', () => post('/fleet/image/cancel', {}).then(() => renderImage()).catch(fail));
  $('#im-build')?.addEventListener('click', () => {
    const from = prompt('Build the image from a ready server (its id), or leave blank to launch a fresh install (30-45 min at ~$1.86/hr, terminated afterwards). A server you name is cleaned (its password and keys stripped: it can\'t take jobs afterwards) and left stopped. Each region\'s copy costs about $8-9 a month.', '');
    if (from === null) return;
    post('/fleet/image/build', { confirm: true, ...(from.trim() ? { from: from.trim() } : {}) }).then(() => { toast('Image build started'); renderImage(); }).catch(fail);
  });
  $('#im-prune')?.addEventListener('click', async () => {
    const dry = await post('/fleet/image/prune', { dryRun: true }).catch(fail);
    if (!dry) return;
    if (!dry.removed.length) return toast('Nothing to delete: every image left is the one its region launches from');
    if (confirm(`Delete ${dry.removed.length} image(s) and their snapshots?\n${dry.removed.map((i) => `${i.region} ${i.id}`).join('\n')}`)) post('/fleet/image/prune', { confirm: true }).then((r) => { toast(`Deleted ${r.removed.length}`); renderImage(); }).catch(fail);
  });
}

render.fleet = async () => {
  let f;
  try {
    f = await api('/fleet');
  } catch (e) {
    $('#fleet').innerHTML = `<div class="card"><h3>GPU fleet</h3><p>${esc(e.message)}</p><p class="muted">Put AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_DEFAULT_REGION in hawkesgen/.env.</p></div>`;
    return;
  }
  const s = f.settings;
  $('#fleet').innerHTML = `
    <div class="row spread"><h2>GPU fleet</h2><div class="row">
      <button id="fl-access">Refresh access</button><button id="fl-scale">Start servers…</button><button id="fl-launch">Launch new…</button><button class="danger" id="fl-stopall">Stop all</button></div></div>
    ${f.error ? `<div class="card" style="color:var(--bad)">${esc(f.error)}</div>` : ''}
    ${f.servers.filter((sv) => sv.state === 'running' && f.disks?.[sv.id]?.pct >= 90).map((sv) => `<div class="card"><b style="color:var(--${f.disks[sv.id].pct >= 95 ? 'bad' : 'warn'})">${esc(sv.id)}'s disk is ${f.disks[sv.id].pct}% full</b> (${f.disks[sv.id].free == null ? '?' : Math.round(f.disks[sv.id].free / 1e9)} GB free). Models install on first use and the least recently used are removed when space runs short: check its Models, or the Machines tab.</div>`).join('')}
    ${f.lastFailure ? `<div class="card"><b style="color:var(--warn)">Last start/launch failed (${esc(f.lastFailure.kind)}):</b> ${esc(f.lastFailure.message)}</div>` : ''}
    ${f.retry?.active ? `<div class="card"><div class="row spread"><span>Keep trying to <b>${esc(f.retry.action)}</b>: try ${f.retry.tries}, next ${f.retry.next ? new Date(f.retry.next).toLocaleTimeString() : '—'}, until ${new Date(f.retry.until).toLocaleTimeString()}</span><button id="fl-rstop">Stop trying</button></div><div class="small muted">${esc(f.retry.log?.at(-1)?.message ?? '')}</div></div>` : ''}
    <div class="card">${f.servers.length ? `<table><thead><tr><th>Server</th><th>State</th><th>Loaded / busy</th><th class="num">$/hr</th><th></th></tr></thead><tbody>${f.servers.map((sv) => `<tr>
      <td><b>${esc(sv.id)}</b><div class="small muted">${esc(sv.type)} · ${esc(sv.zone ?? sv.region)} · ${esc(sv.flavor)}${sv.image ? ` · from ${esc(sv.image)}` : ''}${sv.purpose ? ` · ${esc(sv.purpose)}` : ''}${sv.idleMinutes ? ` · ${sv.disposable ? 'terminated' : 'stops'} after ${sv.idleMinutes} idle min` : ''}</div></td>
      <td>${bootCell(sv)}</td>
      <td class="small">${esc(f.families[sv.id] ?? '—')}${f.busy[sv.id] ? `<br><a href="#" data-job-link="${f.busy[sv.id]}">${esc(f.busy[sv.id])}</a>` : ''}</td>
      <td class="num">${money(sv.pricePerHour)}</td>
      <td><div class="row">${sv.state === 'stopped' ? `<button data-sv="start" data-id="${sv.id}">Start</button>` : ''}${['running', 'pending'].includes(sv.state) ? `<button data-sv="stop" data-id="${sv.id}">${sv.disposable ? 'Stop (discard)' : 'Stop'}</button>` : ''}${sv.state === 'running' ? `<button data-sv="health" data-id="${sv.id}">Health</button><button data-sv="log" data-id="${sv.id}">Log</button><button data-sv="models" data-id="${sv.id}">Models</button><button data-sv="sync" data-id="${sv.id}">Sync core models</button>` : ''}<button class="danger" data-sv="terminate" data-id="${sv.id}">Terminate</button></div></td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty">No GPU servers. Launch one, or adopt existing ones (Settings).</div>'}</div>
    <div class="card" id="fl-image"><h3>Machine image</h3><div class="small muted">Loading…</div></div>
    <div class="card"><h3>Scaling</h3><div class="form">
      <label><span><b>Servers</b>: most servers, and GPU jobs at once</span><input type="number" id="fs-servers" min="1" max="${s.max}" value="${s.servers}"></label>
      <label><span><b>Idle stop</b>: minutes before an idle server powers off</span><input type="number" id="fs-idle" min="10" max="240" value="${s.idleMinutes}"></label>
      <label><span><b>Start servers by themselves</b> when GPU jobs wait: stopped servers in US regions (costs money)</span><select id="fs-auto"><option value="false" ${!s.auto ? 'selected' : ''}>Off</option><option value="true" ${s.auto ? 'selected' : ''}>On</option></select></label>
      <label><span><b>Launch new servers by themselves</b> from the image when no stopped one is left (needs the above on)</span><select id="fs-autolaunch"><option value="false" ${!s.autoLaunch ? 'selected' : ''}>Off</option><option value="true" ${s.autoLaunch ? 'selected' : ''}>On</option></select></label>
      ${f.autoStart?.last ? `<div class="small muted">Last auto start (${esc(new Date(f.autoStart.last.at).toLocaleTimeString())}): ${esc(f.autoStart.last.note || 'nothing to do')}</div>` : ''}
      ${f.autoStart?.backoff?.length ? `<div class="small muted">Left alone for now: ${f.autoStart.backoff.map((b) => `${esc(b.id)} until ${esc(new Date(b.until).toLocaleTimeString())} (${esc(b.reason)})`).join(', ')}</div>` : ''}
      <label><span><b>Disposable servers</b>: servers launched from the image are terminated when idle, not stopped</span><select id="fs-disposable"><option value="true" ${s.disposable ? 'selected' : ''}>On</option><option value="false" ${!s.disposable ? 'selected' : ''}>Off</option></select></label>
    </div><div class="row" style="margin-top:10px"><button class="primary" id="fs-save">Save</button><span class="small muted">Each server's disk costs about ${money(f.diskPerMonth)} a month until it's terminated.</span></div></div>
    <div class="card" id="fl-builder"><h3>Unity build server</h3><div class="small muted">Loading…</div></div>
    <details class="card"><summary>Regions and GPU quota</summary><div id="fl-regions" class="small muted">Loading…</div></details>
    ${f.account ? `<p class="small muted">AWS account ${esc(f.account.account ?? '?')} · home region ${esc(f.account.region ?? '?')} · on-demand GPU quota ${esc(f.account.gpuQuota ?? '?')} vCPUs</p>` : ''}`;

  const act = (a, body = {}) => post(`/fleet/${a}`, body).then((r) => { toast(`${a}: ok`); render.fleet(); return r; }).catch((e) => { fail(e); render.fleet(); });
  renderBuilder().catch(() => {});
  renderImage().catch(() => {});
  $('#fl-access').onclick = () => act('access');
  $('#fl-stopall').onclick = () => confirm('Stop every running GPU server? Running jobs fail.') && act('stop-all');
  $('#fl-rstop')?.addEventListener('click', () => act('retry-stop'));
  $('#fl-scale').onclick = () => {
    const n = prompt(`Start stopped servers until this many run (up to ${s.servers}). Each costs about $1.86–$4 an hour while running.`, String(s.servers));
    if (n) act('scale', { confirm: true, count: Number(n) });
  };
  $('#fl-launch').onclick = () => launchDialog(f);
  $('#fs-save').onclick = () => post('/fleet/settings', { servers: Number($('#fs-servers').value), idleMinutes: Number($('#fs-idle').value), auto: $('#fs-auto').value === 'true', autoLaunch: $('#fs-autolaunch').value === 'true', disposable: $('#fs-disposable').value === 'true' }).then(() => { toast('Saved'); render.fleet(); }).catch(fail);
  for (const b of document.querySelectorAll('#fleet [data-sv]')) {
    b.onclick = async () => {
      const id = b.dataset.id;
      const a = b.dataset.sv;
      if (a === 'start') {
        const sv = f.servers.find((x) => x.id === id);
        const resume = sv?.unfinished?.resumable ? ` Its install never finished: it carries on from where it stopped (${sv.unfinished.detail}).` : '';
        return confirm(`Start ${id}? It costs money while it runs.${resume}`) && act('start', { id, confirm: true }).then((r) => r?.note && toast(`${id}: ${r.note}`));
      }
      if (a === 'stop') {
        const sv = f.servers.find((x) => x.id === id);
        if (sv?.disposable && !confirm(`${id} was launched from the image: stopping it terminates it (a new one comes up from the image in minutes). Go on?`)) return;
        return act('stop', { id });
      }
      if (a === 'terminate') return confirm(`Terminate ${id}? This deletes the server and its disk (about 90 GB of models). Launching again re-downloads everything.`) && act('terminate', { id, confirm: true });
      if (a === 'sync') return confirm(`Download any models and nodes ${id} is missing (from server/models.json)? This can take a while.`) && act('sync', { id, confirm: true }).then((r) => r && toast(`Synced: ${r.models.length} models, ${r.nodes.length} nodes`));
      if (a === 'health') return api(`/fleet/health?id=${id}`).then((h) => modal(`<h2>Health: ${esc(id)}</h2><pre>${esc(JSON.stringify(h, null, 2))}</pre>${h.ok ? '' : `<button class="primary" id="fixit">Put ComfyUI on the flags that work</button>`}`)).then((m) => m.querySelector('#fixit')?.addEventListener('click', () => act('fix', { id, confirm: true }))).catch(fail);
      if (a === 'log') return api(`/fleet/log?id=${id}&lines=80`).then((l) => modal(`<h2>Log: ${esc(id)}</h2><pre>${esc(l.log)}</pre>`)).catch(fail);
      if (a === 'models') return showModels(id);
    };
  }
  for (const l of document.querySelectorAll('#fleet [data-job-link]')) l.onclick = (e) => { e.preventDefault(); showJob(l.dataset.jobLink); };
  $('#fleet details').addEventListener('toggle', async (e) => {
    if (!e.target.open) return;
    try {
      const [{ regions }, me] = await Promise.all([api(`/fleet/regions${e.refresh ? '?refresh=1' : ''}`), api('/me').catch(() => ({}))]);
      const owner = me.role === 'owner';
      $('#fl-regions').innerHTML = `<table><thead><tr><th>Region</th><th class="num">GPU quota (vCPUs)</th><th>Requests</th><th>Zones offering</th>${owner ? '<th></th>' : ''}</tr></thead><tbody>${regions.map((r) => `<tr><td>${esc(r.region)}</td><td class="num">${esc(r.quota ?? '?')}</td><td>${esc(r.requests.map((q) => `${q.value} ${q.status}`).join('; ') || '—')}</td><td>${esc(Object.entries(r.zones).map(([t, z]) => `${t}: ${z.length}`).join(', ') || '—')}${r.error ? ` (${esc(r.error)})` : ''}</td>${owner ? `<td><button data-quota="${esc(r.region)}" data-now="${esc(r.quota ?? 0)}">Request more</button></td>` : ''}</tr>`).join('')}</tbody></table>
        <p class="small muted">Quota is "Running On-Demand G and VT instances" in vCPUs (a g6e.xlarge takes 4, a g6e.2xlarge 8). Requesting more is free and launches nothing; AWS reviews it, usually within a day.</p>`;
      for (const b of document.querySelectorAll('#fl-regions [data-quota]')) b.onclick = () => {
        const region = b.dataset.quota;
        const n = prompt(`Ask AWS to raise ${region}'s GPU quota from ${b.dataset.now} to how many vCPUs? Free; it launches nothing.`, String(Math.max(16, Number(b.dataset.now) + 8)));
        if (!n) return;
        post('/fleet/quota', { region, value: Number(n) }).then((r) => {
          toast(`Asked AWS for ${r.value} vCPUs in ${region} (${r.status ?? 'sent'})`);
          $('#fleet details').dispatchEvent(Object.assign(new Event('toggle'), { refresh: true }));
        }).catch(fail);
      };
    } catch (err) {
      $('#fl-regions').textContent = err.message;
    }
  });
};

async function showModels(id) {
  const m = await api(`/fleet/models?id=${id}&refresh=1`).catch(fail);
  if (!m) return;
  const gb = (b) => `${(b / 1e9).toFixed(1)} GB`;
  const body = modal(`<h2>Models on ${esc(id)}</h2><p class="muted">${gb(m.free)} free. Workflow tools install their models the first time a job needs them; when space runs short, the least recently used ones are removed automatically (core models never are).</p>
    <table><thead><tr><th></th><th>File</th><th class="num">Size</th><th>Used by</th></tr></thead><tbody>${m.models.map((x) => `<tr><td>${x.core ? '<span class="chip">core</span>' : `<input type="checkbox" data-f="${esc(x.file)}">`}</td><td class="small">${esc(x.file)}</td><td class="num">${gb(x.bytes)}</td><td class="small">${esc(x.usedBy.join(', ') || (x.core ? 'built-in tools' : '—'))}</td></tr>`).join('')}</tbody></table>
    <div class="row" style="margin-top:10px"><button class="danger" id="mprune">Remove selected</button><button id="mclose">Close</button></div>`);
  body.querySelector('#mclose').onclick = () => $('#modal').close();
  body.querySelector('#mprune').onclick = () => {
    const files = [...body.querySelectorAll('[data-f]:checked')].map((c) => c.dataset.f);
    if (!files.length || !confirm(`Remove ${files.length} model file(s) from ${id}? They download again when a job needs them.`)) return;
    post('/fleet/models/prune', { id, files, confirm: true }).then((r) => { toast(`Removed ${r.removed.length}`); showModels(id); }).catch(fail);
  };
}

function launchDialog(f) {
  const types = Object.entries(f.types);
  const body = modal(`<h2>Launch a new GPU server</h2>
    <p class="muted">A new server sets itself up (about 12 minutes, ~92 GB of models) and then costs money while it runs, plus about ${money(f.diskPerMonth)} a month for its disk until terminated. Starting a stopped server is cheaper and faster.</p>
    <div class="form">
      <label><span>Type</span><select id="lt"><option value="auto">Any 48 GB+ machine (cheapest first)</option>${types.map(([k, t]) => `<option value="${k}" ${k === f.defaultType ? 'selected' : ''}>${k}: ${esc(t.gpu)}, ${money(t.price)}/hr</option>`).join('')}</select></label>
      <label><span>Region</span><select id="lr"><option value="auto">Any with quota and capacity</option>${f.regions.map((r) => `<option>${r}</option>`).join('')}</select></label>
      <label><span>Keep trying for (minutes, 0 = once)</span><input type="number" id="lk" value="0" min="0" max="720"></label>
    </div>
    <div class="row" style="margin-top:12px"><button class="primary" id="lgo">Launch</button><button id="lno">Cancel</button></div>`);
  body.querySelector('#lno').onclick = () => $('#modal').close();
  body.querySelector('#lgo').onclick = () => {
    const minutes = Number($('#lk').value);
    post('/fleet/launch', { confirm: true, type: $('#lt').value, region: $('#lr').value, ...(minutes ? { keepTrying: { minutes } } : {}) })
      .then(() => { $('#modal').close(); toast('Launching'); render.fleet(); })
      .catch(fail);
  };
}

// ---------------------------------------------------------------- machines
// The machines Gen runs (src/machines.ts): what needs action, then a card per machine with the last hour and 24 h.
const pctOf = (a, b) => (a != null && b ? (100 * a) / b : null);
const bytes = (b) => (b == null ? '—' : b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(0)} KB` : `${Math.round(b)} B`);
const span = (s) => (s == null ? '—' : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);

/** A small line of the points' values (percent metrics on 0-100, others on their own peak). */
function sparkline(points, key, percent) {
  const vals = (points ?? []).filter((p) => p[key] != null);
  if (vals.length < 2) return '<span class="small muted">—</span>';
  const t0 = vals[0].at;
  const t1 = vals.at(-1).at;
  const top = percent ? 100 : Math.max(...vals.map((p) => p[key])) || 1;
  const xy = vals.map((p) => `${(((p.at - t0) / (t1 - t0 || 1)) * 120).toFixed(1)},${(26 - (p[key] / top) * 24).toFixed(1)}`).join(' ');
  const peak = Math.max(...vals.map((p) => p[key]));
  return `<svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none" role="img" aria-label="peak ${esc(percent ? `${Math.round(peak)}%` : bytes(peak))}"><polyline points="${xy}"/></svg><span class="small muted"> peak ${esc(percent ? `${Math.round(peak)}%` : `${bytes(peak)}/s`)}</span>`;
}

function machineCard(m, h1, h24) {
  const x = m.metrics;
  const running = m.state === 'running';
  const head = `<div class="row spread"><h3>${esc(m.name)} <span class="status s-${running ? 'ready' : m.state === 'none' ? 'stopped' : ['pending', 'stopping'].includes(m.state) ? 'booting' : 'stopped'}">${esc(m.state === 'pending' ? 'starting' : m.state === 'none' ? 'not launched' : m.state)}</span></h3>
    <span class="small muted">${m.type ? `${esc(m.type)} · ${esc(m.region)} · ${money(m.pricePerHour)}/hr` : ''}</span></div>`;
  if (m.state === 'unknown') return `<div class="card">${head}<p class="small" style="color:var(--bad)">${esc(m.error)}</p></div>`;
  if (m.state === 'none') return `<div class="card">${head}<p class="small muted">No ${esc(m.name.toLowerCase())} yet (the GPU fleet tab launches one).</p></div>`;
  const facts = [];
  if (running) facts.push(`up ${span(x?.uptime ?? (m.launched ? (Date.now() - Date.parse(m.launched)) / 1000 : null))}`);
  if (m.idle) facts.push(m.idle.busy ? 'busy now' : `idle ${m.idle.minutes} min${m.idle.stopsAt ? ` · ${m.idle.action} ${m.idle.stopsAt > Date.now() ? `at about ${new Date(m.idle.stopsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'at its next idle check'}` : ''}`);
  if (m.purpose) facts.push(esc(m.purpose));
  if (x?.stage && x.stage !== 'ready') facts.push(`install: ${esc(x.stage)}`);
  if (x?.service === 'down') facts.push(`<b style="color:var(--bad)">${m.kind === 'playtester' ? 'browser server down' : 'ComfyUI not answering'}</b>`);
  const jobs = m.jobs.length ? `<div class="small">Running ${m.jobs.map((j) => `<a href="#" data-job-link="${esc(j.id)}">${esc(j.tool)}</a> <span class="muted">${esc(j.project)}</span>`).join(', ')}</div>` : running ? '<div class="small muted">No job running.</div>' : '';
  const err = m.error ? `<p class="small" style="color:var(--bad)">${esc(m.error)}</p>` : '';
  const rows = [
    ['CPU', x?.cpu != null ? `${Math.round(x.cpu)}%` : '—', 'cpu', true],
    ['Memory', x?.memTotal ? `${bytes(x.memUsed)} of ${bytes(x.memTotal)} (${Math.round(pctOf(x.memUsed, x.memTotal))}%)` : '—', 'mem', true],
    ...(m.kind !== 'builder' ? [
      ['GPU', x?.gpu != null ? `${Math.round(x.gpu)}%` : '—', 'gpu', true],
      ['VRAM', x?.vramTotal ? `${bytes(x.vramUsed)} of ${bytes(x.vramTotal)}` : '—', 'vram', true],
      ['GPU temp', x?.temp != null ? `${x.temp}°C` : '—', 'temp', false],
    ] : []),
    ['Disk', x?.diskSize ? `${bytes(x.diskUsed)} of ${bytes(x.diskSize)} (${Math.round(pctOf(x.diskUsed, x.diskSize))}%, ${bytes(x.diskFree)} free)` : '—', 'disk', true],
    ['Network in', x?.netIn != null ? `${bytes(x.netIn)}/s` : '—', 'netIn', false],
    ['Network out', x?.netOut != null ? `${bytes(x.netOut)}/s` : '—', 'netOut', false],
  ];
  const diskPct = pctOf(x?.diskUsed, x?.diskSize);
  const table = running || h24?.length ? `<table><thead><tr><th>Measure</th><th>Now</th><th>Last hour</th><th>Last 24 h</th></tr></thead><tbody>${rows.map(([label, now, key, pct]) => `<tr><td><b>${label}</b></td><td class="small"${key === 'disk' && diskPct >= 90 ? ' style="color:var(--warn)"' : ''}>${running ? now : '—'}</td><td>${sparkline(h1, key, pct)}</td><td>${sparkline(h24, key, pct)}</td></tr>`).join('')}</tbody></table>` : '';
  const connect = m.kind === 'builder' ? `<div class="row"><button data-m-rdp>Remote Desktop</button><button data-m-pw>Show password</button></div>` : m.kind === 'gpu' ? `<div class="row"><button data-m-ssh="${esc(m.id)}">Copy ssh command</button></div>` : '';
  return `<div class="card">${head}<div class="small muted">${esc(m.id)}${facts.length ? ` · ${facts.join(' · ')}` : ''}</div>${connect}${jobs}${err}${table}</div>`;
}

render.machines = async (live = true) => {
  lastMachines = Date.now();
  const [r, h1, h24] = await Promise.all([api(live ? '/machines?live=1' : '/machines'), api('/machines/history?hours=1&points=60'), api('/machines/history?hours=24&points=96')]);
  const order = { gpu: 0, builder: 1, playtester: 2 };
  const list = [...r.machines].sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || order[a.kind] - order[b.kind]);
  const running = list.filter((m) => m.state === 'running');
  const perHour = running.reduce((n, m) => n + m.pricePerHour, 0);
  $('#machines').innerHTML = `<div class="row spread"><h2>Machines <span class="small muted">${running.length} running · ${money(perHour)}/hr</span></h2><span class="small muted">measured ${esc(new Date(r.at).toLocaleTimeString())} · updates as the server measures</span></div>
    <div class="card"><h3>Needs action</h3>${r.alerts.length ? `<table><thead><tr><th>What</th></tr></thead><tbody>${r.alerts.map((a) => `<tr><td><b style="color:var(--${a.level})">${esc(a.text)}</b></td></tr>`).join('')}</tbody></table>` : '<p class="small muted">Nothing: every running machine answers, no disk over 90%, nothing idle for 30 minutes.</p>'}</div>
    ${list.map((m) => machineCard(m, h1.machines[m.id], h24.machines[m.id])).join('')}
    <p class="small muted">Running machines are measured over SSH every minute (kept 7 days); this page redraws when the server takes a reading. Stopped machines are never started to measure them. The control server itself is on Studio's Resources page.</p>`;
  for (const b of document.querySelectorAll('#machines [data-m-rdp]')) b.onclick = () => remoteDesktop(() => render.machines()).catch(fail);
  for (const b of document.querySelectorAll('#machines [data-m-pw]')) b.onclick = () => showBuilderPassword().catch(fail);
  for (const b of document.querySelectorAll('#machines [data-m-ssh]')) b.onclick = () => copySsh(b.dataset.mSsh).catch(fail);
  for (const l of document.querySelectorAll('#machines [data-job-link]')) l.onclick = (e) => { e.preventDefault(); showJob(l.dataset.jobLink); };
};

// ---------------------------------------------------------------- tools
function field(name, spec) {
  const label = `<span><b>${esc(name)}</b>${spec.required ? ' *' : ''}${spec.description ? ` · ${esc(spec.description)}` : ''}</span>`;
  const def = spec.default ?? '';
  if (spec.type === 'text' || spec.type === 'json') return `<label class="wide">${label}<textarea data-p="${name}" data-type="${spec.type}">${esc(spec.type === 'json' && def !== '' ? JSON.stringify(def, null, 2) : def)}</textarea></label>`;
  if (spec.type === 'enum') return `<label>${label}<select data-p="${name}">${spec.values.map((v) => `<option ${v === def ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
  if (spec.type === 'boolean') return `<label>${label}<select data-p="${name}" data-type="boolean"><option value="false" ${def === true ? '' : 'selected'}>no</option><option value="true" ${def === true ? 'selected' : ''}>yes</option></select></label>`;
  return `<label>${label}<input data-p="${name}" data-type="${spec.type}" value="${esc(def)}" ${spec.min != null ? `min="${spec.min}"` : ''} ${spec.max != null ? `max="${spec.max}"` : ''} ${['number', 'integer'].includes(spec.type) ? 'type="number" step="any"' : ''}></label>`;
}

function tryTool(t, opts = {}) {
  const basic = Object.entries(t.params).filter(([, s]) => !s.advanced);
  const adv = Object.entries(t.params).filter(([, s]) => s.advanced);
  const project0 = opts.project ?? localStorage.getItem('hg-project') ?? 'sandbox';
  const body = modal(`<h2>${esc(t.title)} <span class="small muted">${esc(t.id)} v${t.version}</span></h2><p class="muted">${esc(t.description)}</p>
    <div class="form">
      <label><span><b>project</b> *</span><input id="tp" value="${esc(project0)}"></label>
      <label><span><b>preset</b> · the project's art direction</span><select id="tpre"><option value="">(none)</option></select></label>
      ${Object.entries(t.inputs).map(([n, s]) => `<label class="wide"><span><b>${esc(n)}</b>${s.required ? ' *' : ''} · ${esc(s.kind)}${s.multiple ? ` (up to ${s.max ?? 'many'})` : ''}${s.description ? ` · ${esc(s.description)}` : ''}</span><input type="file" data-in="${n}" ${s.multiple ? 'multiple' : ''}><input data-in-ref="${n}" placeholder="…or asset:<id> / blob:<sha> (comma separated)"></label>`).join('')}
      ${basic.map(([n, s]) => field(n, s)).join('')}
    </div>
    ${adv.length ? `<details><summary>More settings</summary><div class="form">${adv.map(([n, s]) => field(n, s)).join('')}</div></details>` : ''}
    <div class="row" style="margin-top:12px"><button class="primary" id="trun">Run</button><button id="tno">Close</button><span id="tmsg" class="small muted"></span></div>`);
  body.querySelector('#tno').onclick = () => $('#modal').close();
  const loadPresets = async () => {
    const sel = body.querySelector('#tpre');
    sel.innerHTML = '<option value="">(none)</option>';
    try {
      const pp = await api(`/presets/${encodeURIComponent($('#tp').value.trim())}`);
      for (const [name, p] of Object.entries(pp.presets ?? {})) {
        if (p.tool && p.tool !== t.id) continue;
        sel.insertAdjacentHTML('beforeend', `<option value="${esc(name)}" ${name === opts.preset ? 'selected' : ''}>${esc(name)}: ${esc(p.description ?? '')}</option>`);
      }
    } catch {
      // no presets for this project
    }
  };
  void loadPresets();
  body.querySelector('#tp').onchange = loadPresets;
  body.querySelector('#trun').onclick = async () => {
    try {
      $('#tmsg').textContent = 'uploading…';
      const inputs = {};
      for (const [n, s] of Object.entries(t.inputs)) {
        const refs = body.querySelector(`[data-in-ref="${n}"]`).value.split(',').map((x) => x.trim()).filter(Boolean);
        for (const file of body.querySelector(`[data-in="${n}"]`).files) {
          const r = await api('/blobs', { method: 'POST', body: file, headers: { 'X-Filename': file.name } });
          refs.push(r.blob);
        }
        if (refs.length) inputs[n] = s.multiple ? refs : refs[0];
      }
      const params = {};
      for (const el of body.querySelectorAll('[data-p]')) {
        const v = el.value;
        if (v === '') continue;
        const type = el.dataset.type;
        params[el.dataset.p] = type === 'boolean' ? v === 'true' : type === 'number' || type === 'integer' ? Number(v) : type === 'json' ? JSON.parse(v) : v;
      }
      // Leave defaults out so the tool's own defaults apply.
      for (const [n, s] of Object.entries(t.params)) if (s.default !== undefined && JSON.stringify(params[n]) === JSON.stringify(s.default)) delete params[n];
      const project = $('#tp').value.trim();
      localStorage.setItem('hg-project', project);
      const preset = body.querySelector('#tpre').value || undefined;
      const { jobs } = await post('/jobs', { tool: t.id, project, params, inputs, preset });
      showJob(jobs[0].id);
    } catch (e) {
      $('#tmsg').textContent = e.message;
    }
  };
}

render.tools = async () => {
  const { tools } = await api('/tools');
  state.tools = tools;
  const groups = { comfy: 'GPU (ComfyUI on the AWS fleet)', pipeline: 'Recipes (chains of tools, sheets, best of N)', elevenlabs: 'Voice and sound (ElevenLabs)', anthropic: 'Writing and judgment (Claude)', local: 'On this PC' };
  $('#tools').innerHTML = `<h2>Tools</h2><p class="muted">Every tool is one API call: <code>POST /v1/jobs {"tool": "…", "project": "…", "params": {…}, "inputs": {…}}</code>. Try one here.</p>
    ${Object.entries(groups).map(([p, label]) => `<div class="card"><h3>${label}</h3><table><tbody>${tools.filter((t) => t.provider === p).map((t) => `<tr><td style="width:28%"><b>${esc(t.title)}</b><div class="small muted">${esc(t.id)} → ${esc(t.output)}</div></td><td class="small">${esc(t.description)}</td><td><button data-try="${t.id}">Try</button></td></tr>`).join('')}</tbody></table></div>`).join('')}`;
  for (const b of document.querySelectorAll('[data-try]')) b.onclick = () => tryTool(tools.find((t) => t.id === b.dataset.try));
};

// ---------------------------------------------------------------- presets
// ---------------------------------------------------------------- entities (the library's structure: docs/library.md)
// The same web components every product's tools embed (clients/js/hawkesgen-ui.mjs, served at /client/).
render.entities = async () => {
  const el = $('#entities');
  if (!render.entities.ready) {
    const ui = await import('/client/hawkesgen-ui.mjs');
    ui.configure({ url: location.origin, key: '' });
    render.entities.ready = true;
  }
  const projects = (await api('/presets')).projects.map((p) => p.project).sort();
  const pick = render.entities.project ?? localStorage.getItem('hg-entities-project') ?? projects[0];
  if (el.querySelector('hg-library')?.getAttribute('project') === pick) return;
  el.innerHTML = '';
  const sel = document.createElement('select');
  for (const p of projects) sel.append(new Option(p, p, false, p === pick));
  sel.onchange = () => { render.entities.project = sel.value; try { localStorage.setItem('hg-entities-project', sel.value); } catch {} render.entities().catch(fail); };
  const bar = document.createElement('div');
  bar.className = 'row';
  bar.append('Project ', sel);
  const lib = document.createElement('hg-library');
  lib.setAttribute('project', pick);
  lib.setAttribute('open-inline', '');
  lib.style.marginTop = '12px';
  el.append(bar, lib);
};

render.presets = async () => {
  const [{ projects }, { tools }] = await Promise.all([api('/presets'), api('/tools')]);
  state.tools = tools;
  $('#presets').innerHTML = `<h2>Presets</h2><p class="muted">Each project's art direction: a style line and named presets (a tool, a prompt template with {prompt} and {style}, and params). Jobs name one with <code>"preset": "name"</code>; games, agents (MCP) and the CLI all use them. Files live in <code>hawkesgen/presets/</code>.</p>
    ${projects.map((pp) => `<div class="card"><div class="row spread"><h3>${esc(pp.title ?? pp.project)} <span class="small muted">${esc(pp.project)}</span></h3><button data-edit="${esc(pp.project)}">Edit</button></div>
      ${pp.style ? `<p><b>Style:</b> ${esc(pp.style)}</p>` : '<p class="muted">No style line yet.</p>'}
      ${pp.notes ? `<p class="small muted">${esc(pp.notes)}</p>` : ''}
      <table><tbody>${Object.entries(pp.presets ?? {}).map(([name, p]) => `<tr><td style="width:22%"><b>${esc(name)}</b><div class="small muted">${esc(p.tool ?? '')}</div></td><td class="small">${esc(p.description ?? '')}${p.prompt ? `<div class="muted">${esc(p.prompt)}</div>` : ''}</td><td><button data-use="${esc(pp.project)}|${esc(name)}|${esc(p.tool ?? '')}">Use</button></td></tr>`).join('')}</tbody></table></div>`).join('')}`;
  for (const b of document.querySelectorAll('#presets [data-use]')) {
    b.onclick = () => {
      const [project, name, toolId] = b.dataset.use.split('|');
      const t = tools.find((x) => x.id === toolId);
      if (t) tryTool(t, { project, preset: name });
    };
  }
  for (const b of document.querySelectorAll('#presets [data-edit]')) {
    b.onclick = async () => {
      const pp = await api(`/presets/${b.dataset.edit}`);
      const body = modal(`<h2>Presets: ${esc(pp.project)}</h2><textarea id="pj" style="min-height:60vh;font-family:ui-monospace,monospace;font-size:12px">${esc(JSON.stringify(pp, null, 2))}</textarea>
        <div class="row" style="margin-top:10px"><button class="primary" id="psave">Save</button><button id="pno">Close</button><span id="pmsg" class="small muted"></span></div>`);
      body.querySelector('#pno').onclick = () => $('#modal').close();
      body.querySelector('#psave').onclick = async () => {
        try {
          await api(`/presets/${pp.project}`, { method: 'PUT', body: $('#pj').value });
          $('#modal').close();
          toast('Saved');
          render.presets();
        } catch (e) {
          $('#pmsg').textContent = e.message;
        }
      };
    };
  }
};

// ---------------------------------------------------------------- workflows
render.workflows = async () => {
  const q = render.workflows.q ?? '';
  const [{ workflows }, { templates }] = await Promise.all([api('/workflows'), api(`/comfy/templates${q ? `?q=${encodeURIComponent(q)}` : ''}`)]);
  const gb = (b) => (b ? `${(b / 1e9).toFixed(1)} GB` : '');
  $('#workflows').innerHTML = `<div class="row spread"><h2>Workflows</h2><div class="row"><button id="wfup">Import my ComfyUI workflow…</button><button id="wfref">Refresh catalog from a server</button></div></div>
    <p class="muted">Any ComfyUI workflow can become a Hawkes Gen tool: its inputs, prompts, seeds, sizes and outputs are found automatically, and its models install on a GPU server the first time a job needs them. Folders live in <code>hawkesgen/workflows/</code>.</p>
    <div class="card"><h3>Installed (${workflows.length})</h3><table><tbody>${workflows.map((w) => `<tr><td style="width:24%"><b>${esc(w.title)}</b><div class="small muted">${esc(w.id)} · v${w.version} · ${esc(w.family)}</div></td><td class="small">${esc(w.description)}<div class="muted">${w.models.length} model file(s)${w.source?.template ? ` · from template ${esc(w.source.template)}` : ''}</div></td><td><div class="row"><button data-wtry="${esc(w.id)}">Try</button><button data-wedit="${esc(w.id)}">Edit</button></div></td></tr>`).join('')}</tbody></table></div>
    <div class="card"><div class="row spread"><h3>ComfyUI template library (${templates.length})</h3><input id="wq" placeholder="Search: upscale, 3d, music, panorama…" value="${esc(q)}"></div>
      <div class="lib">${templates.slice(0, 120).map((t) => `<div class="asset"><div class="media" data-wprev="${esc(t.name)}"><img src="/v1/comfy/templates/${encodeURIComponent(t.name)}/thumb" loading="lazy" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'glyph',textContent:'◇'}))"></div>
        <div class="meta"><span class="t">${esc(t.title)}</span><span class="muted">${esc(t.tags.slice(0, 3).join(' · '))}${t.size ? ` · ${gb(t.size)}` : ''}</span>${t.installed ? `<span class="chip">installed as ${esc(t.installed)}</span>` : ''}</div></div>`).join('')}</div></div>`;
  $('#wq').onchange = (e) => { render.workflows.q = e.target.value; render.workflows().catch(fail); };
  $('#wfref').onclick = () => post('/comfy/refresh').then((r) => { toast(`Catalog: ${r.templates} templates, ${r.nodes} nodes`); render.workflows(); }).catch(fail);
  $('#wfup').onclick = () => importDialog({});
  for (const b of document.querySelectorAll('[data-wtry]')) b.onclick = async () => tryTool(await api(`/tools/${b.dataset.wtry}`));
  for (const b of document.querySelectorAll('[data-wedit]')) b.onclick = () => editWorkflow(b.dataset.wedit);
  for (const m of document.querySelectorAll('[data-wprev]')) m.onclick = () => previewTemplate(m.dataset.wprev);
};

async function previewTemplate(name) {
  const body = modal(`<h2>${esc(name)}</h2><p class="muted">Converting…</p>`);
  try {
    const r = await api(`/comfy/templates/${encodeURIComponent(name)}`);
    const d = r.draft;
    body.innerHTML = `<h2>${esc(r.template?.title ?? name)}</h2><p class="muted">${esc(r.template?.description ?? '')}</p>
      ${r.problems.length ? `<div class="card" style="color:var(--bad)">${r.problems.map(esc).join('<br>')}</div>` : '<p class="small" style="color:var(--ok)">Converts cleanly for the servers.</p>'}
      <div class="grid"><div><h3>Inputs</h3>${Object.entries(d.inputs).map(([k, v]) => `<div class="small"><b>${esc(k)}</b> · ${esc(v.kind)}</div>`).join('') || '<div class="small muted">none</div>'}</div>
      <div><h3>Params</h3>${Object.entries(d.params).map(([k, v]) => `<div class="small"><b>${esc(k)}</b> · ${esc(v.type)}${v.default !== undefined ? ` = ${esc(String(v.default).slice(0, 40))}` : ''}</div>`).join('') || '<div class="small muted">none</div>'}</div>
      <div><h3>Models</h3>${r.models.map((m) => `<div class="small">${esc(m.dir)}/${esc(m.file)}</div>`).join('') || '<div class="small muted">none found</div>'}</div></div>
      <div id="impform"></div>`;
    importDialog({ template: name, title: r.template?.title, description: r.template?.description, mount: body.querySelector('#impform'), disabled: r.problems.length > 0 });
  } catch (e) {
    body.innerHTML = `<h2>${esc(name)}</h2><p style="color:var(--bad)">${esc(e.message)}</p>`;
  }
}

function importDialog({ template, title, description, mount, disabled }) {
  const html = `<h3>Import as a tool</h3><div class="form">
      <label><span><b>tool id</b> (area.name, e.g. image.relight)</span><input id="iid" placeholder="image.something"></label>
      <label><span><b>title</b></span><input id="ititle" value="${esc(title ?? '')}"></label>
      <label class="wide"><span><b>description</b></span><textarea id="idesc">${esc(description ?? '')}</textarea></label>
      ${template ? '' : '<label class="wide"><span><b>workflow</b> (.json saved or exported from ComfyUI, UI or API format)</span><input type="file" id="ifile" accept=".json"></label>'}
    </div><div class="row" style="margin-top:10px"><button class="primary" id="igo" ${disabled ? 'disabled' : ''}>Import</button><span id="imsg" class="small muted"></span></div>`;
  const root = mount ?? modal(`<h2>Import a ComfyUI workflow</h2>${html}`);
  if (mount) mount.innerHTML = html;
  root.querySelector('#igo').onclick = async () => {
    try {
      const body = { id: root.querySelector('#iid').value.trim(), title: root.querySelector('#ititle').value.trim() || undefined, description: root.querySelector('#idesc').value.trim() || undefined };
      if (template) body.template = template;
      else body.workflow = JSON.parse(await root.querySelector('#ifile').files[0].text());
      const r = await post('/workflows/import', body);
      $('#modal').close();
      toast(r.note ?? `Imported ${r.manifest.id}`);
      render.workflows();
    } catch (e) {
      root.querySelector('#imsg').textContent = e.message;
    }
  };
}

async function editWorkflow(toolId) {
  const w = await api(`/workflows/${toolId}`);
  const body = modal(`<h2>${esc(w.manifest.title)} <span class="small muted">${esc(toolId)}</span></h2>
    <p class="muted small">The manifest: which graph fields each input and param sets (targets), defaults, limits, models with their download links, and the outputs. Bump version when results change. ${w.check?.problems?.length ? `<b style="color:var(--bad)">Graph problems: ${esc(w.check.problems.join('; '))}</b>` : ''}</p>
    <textarea id="wj" style="min-height:55vh;font-family:ui-monospace,monospace;font-size:12px">${esc(JSON.stringify(w.manifest, null, 2))}</textarea>
    <details><summary>Graph (${Object.keys(w.graph).length} nodes)</summary><pre>${esc(Object.entries(w.graph).map(([k, n]) => `${k}  ${n.class_type}  ${n._meta?.title ?? ''}`).join('\n'))}</pre></details>
    <div class="row" style="margin-top:10px"><button class="primary" id="wsave">Save</button><button class="danger" id="wdel">Delete tool</button><button id="wno">Close</button><span id="wmsg" class="small muted"></span></div>`);
  body.querySelector('#wno').onclick = () => $('#modal').close();
  body.querySelector('#wsave').onclick = async () => {
    try {
      await api(`/workflows/${toolId}`, { method: 'PUT', body: JSON.stringify({ manifest: JSON.parse($('#wj').value) }) });
      toast('Saved');
      $('#modal').close();
      render.workflows();
    } catch (e) {
      $('#wmsg').textContent = e.message;
    }
  };
  body.querySelector('#wdel').onclick = async () => {
    if (!confirm(`Delete the ${toolId} tool (its workflows/ folder)?`)) return;
    await api(`/workflows/${toolId}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }).then(() => { $('#modal').close(); render.workflows(); }).catch(fail);
  };
}

// ---------------------------------------------------------------- usage
render.usage = async () => {
  const days = render.usage.days ?? 30;
  const by = render.usage.by ?? 'project';
  const u = await api(`/usage?since=${Date.now() - days * 86400000}&by=${by}`);
  $('#usage').innerHTML = `<div class="row spread"><h2>Usage <span class="muted small">${money(u.total)} in ${days} days</span></h2><div class="row">
      <select id="ud">${[1, 7, 30, 90, 365].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>last ${d} day${d > 1 ? 's' : ''}</option>`).join('')}</select>
      <select id="ub">${['project', 'client', 'provider', 'day'].map((b) => `<option ${b === by ? 'selected' : ''}>${b}</option>`).join('')}</select></div></div>
    <div class="card">${u.rows.length ? `<table><thead><tr><th>${esc(by)}</th><th>Provider</th><th class="num">Amount</th><th class="num">Jobs</th><th class="num">Cost</th></tr></thead><tbody>${u.rows.map((r) => `<tr><td>${esc(r.grp)}</td><td>${esc(r.provider)}</td><td class="num">${Math.round(r.amount).toLocaleString()} ${esc(r.unit.replace('_', ' '))}</td><td class="num">${r.jobs}</td><td class="num">${money(r.cost)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No usage yet.</div>'}</div>
    <p class="small muted">GPU cost is server time while a job runs, at list price. Idle time between jobs and disks aren't counted here; your AWS bill is the authority.</p>`;
  $('#ud').onchange = (e) => { render.usage.days = Number(e.target.value); render.usage(); };
  $('#ub').onchange = (e) => { render.usage.by = e.target.value; render.usage(); };
};

// ---------------------------------------------------------------- settings
render.settings = async () => {
  const [s, me] = await Promise.all([api('/settings'), api('/me')]);
  let clients = [];
  if (me.role === 'owner') clients = (await api('/clients')).clients;
  $('#settings').innerHTML = `<h2>Settings</h2>
    <div class="card"><h3>API keys</h3><p class="muted small">Each game, site or customer gets its own key, so its jobs and costs are tracked separately. Send it as <code>Authorization: Bearer hg_…</code>. You are <b>${esc(me.name)}</b> (${esc(me.role)}).</p>
      ${clients.length ? `<table><thead><tr><th>Name</th><th>Key</th><th>Role</th><th>Projects</th><th>Last used</th><th></th></tr></thead><tbody>${clients.map((c) => `<tr><td>${esc(c.name)}</td><td><code>${esc(c.prefix)}…</code></td><td>${esc(c.role)}</td><td>${esc(c.projects.join(', '))}</td><td>${esc(ago(c.last_used))}</td><td><button data-cl="${c.id}" data-dis="${c.disabled}">${c.disabled ? 'Enable' : 'Disable'}</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No keys yet. Local requests from this PC act as the owner.</p>'}
      <div class="form" style="margin-top:10px"><label><span>Name</span><input id="cn" placeholder="doseofdestruction"></label><label><span>Role</span><select id="cr"><option>user</option><option>admin</option><option>owner</option></select></label><label><span>Projects (comma separated, * for all)</span><input id="cp" value="*"></label></div>
      <div class="row" style="margin-top:8px"><button id="cadd">Create key</button></div></div>
    <div class="card"><h3>Service</h3><div class="form">
      <label><span><b>Local requests act as the owner</b> (turn off before exposing the service beyond this PC)</span><select id="slo"><option value="true" ${s.localOpen ? 'selected' : ''}>On</option><option value="false" ${!s.localOpen ? 'selected' : ''}>Off</option></select></label>
      <label><span>ElevenLabs jobs at once</span><input type="number" id="sce" value="${s.concurrency.elevenlabs}" min="1" max="16"></label>
      <label><span>Claude jobs at once</span><input type="number" id="sca" value="${s.concurrency.anthropic}" min="1" max="16"></label>
      <label><span>Local jobs at once</span><input type="number" id="scl" value="${s.concurrency.local}" min="1" max="8"></label>
      <label><span><b>Harness</b> (who answers writing, reviews and the agents: Claude Code, Cursor or GitHub Copilot on your plan)</span><select id="sbrain"><option value="claude" ${s.brain === 'claude' ? 'selected' : ''}>Claude Code</option><option value="cursor" ${s.brain === 'cursor' ? 'selected' : ''}>Cursor</option><option value="copilot" ${s.brain === 'copilot' ? 'selected' : ''}>GitHub Copilot</option></select></label>
      <label><span><b>Claude runs on</b> (only when the brain is Claude. Max plan: Claude Code on this server, $0 per call; API: the API key, billed per token; Bedrock: AWS Bedrock, billed per token to AWS)</span><select id="scb"><option value="max-plan" ${s.claude.backend === 'max-plan' ? 'selected' : ''}>Max plan</option><option value="api" ${s.claude.backend === 'api' ? 'selected' : ''}>API key</option><option value="bedrock" ${s.claude.backend === 'bedrock' ? 'selected' : ''}>AWS Bedrock</option></select></label>
      <label><span>Claude calls at once (Max plan)</span><input type="number" id="scc" value="${s.claude.concurrency}" min="1" max="16"></label>
      <label><span>Claude call time limit, minutes (Max plan)</span><input type="number" id="sct" value="${s.claude.timeoutMinutes}" min="1" max="60"></label>
      <label><span>ElevenLabs $ per 1,000 characters (for usage reports)</span><input type="number" step="any" id="sre" value="${s.rates.elevenlabsPer1kChars}"></label>
    </div><div class="row" style="margin-top:10px"><button class="primary" id="ssave">Save</button></div></div>
    <div class="card" id="gpuProviders"><h3>GPU providers</h3><p class="muted small">Loading…</p></div>
    ${me.role === 'owner' ? '<div class="card" id="payments"><h3>Payments (Stripe)</h3><p class="muted small">Loading…</p></div>' : ''}
    ${me.role === 'owner' ? '<div class="card"><h3>🔑 Claude accounts</h3><p class="muted small">Gen’s Claude sign-ins and the AI every account uses are in the <a href="#ai">AI</a> tab.</p></div>' : ''}
    ${me.role === 'owner' ? `<div class="card"><h3>Google sign-in</h3><p class="muted small">"Continue with Google" on this dashboard lets these Google accounts in as the owner. The client is a Google OAuth web client whose Authorized JavaScript origins list this address (${esc(location.origin)}).</p>
      <div class="form"><label><span>Google client id</span><input id="dgc" value="${esc(s.dashboard?.googleClientId ?? '')}" placeholder="1234…apps.googleusercontent.com"></label>
      <label><span>Google accounts let in (comma separated)</span><input id="dge" value="${esc((s.dashboard?.googleEmails ?? []).join(', '))}"></label></div>
      <div class="row" style="margin-top:8px"><button id="dgsave">Save</button></div></div>` : ''}
    <div class="card"><h3>Signed in</h3><p class="muted small">As <b>${esc(me.name)}</b> (${esc(me.role)}).</p><div class="row"><button id="sout">Sign out</button></div></div>
    <div class="card"><h3>Adopt GPU servers</h3><p class="muted small">Take over servers another project launched (their tokens and SSH keys), e.g. Dose Of Destruction's <code>.cache/gpu</code>.</p>
      <div class="row"><input id="adf" style="flex:1" value="C:\\Projects\\doseofdestructionwebsite\\.cache\\gpu"><button id="adgo">Adopt</button></div></div>`;
  $('#cadd').onclick = () => post('/clients', { name: $('#cn').value, role: $('#cr').value, projects: $('#cp').value.split(',').map((x) => x.trim()).filter(Boolean) })
    .then((r) => { modal(`<h2>Key for ${esc(r.client.name)}</h2><p>Copy it now. It isn't shown again.</p><pre>${esc(r.key)}</pre>`); render.settings(); }).catch(fail);
  for (const b of document.querySelectorAll('[data-cl]')) b.onclick = () => post(`/clients/${b.dataset.cl}/${b.dataset.dis === '1' ? 'enable' : 'disable'}`).then(() => render.settings()).catch(fail);
  $('#ssave').onclick = () => post('/settings', { localOpen: $('#slo').value === 'true', brain: $('#sbrain').value, concurrency: { elevenlabs: Number($('#sce').value), anthropic: Number($('#sca').value), local: Number($('#scl').value) }, claude: { backend: $('#scb').value, concurrency: Number($('#scc').value), timeoutMinutes: Number($('#sct').value) }, rates: { elevenlabsPer1kChars: Number($('#sre').value) } }).then(() => toast('Saved')).catch(fail);
  $('#adgo').onclick = () => confirm('Copy that folder\'s server tokens and SSH keys into Hawkes Gen?') && post('/fleet/adopt', { confirm: true, from: $('#adf').value }).then((r) => toast(`Adopted ${r.servers.length} servers, ${r.keys.length} keys`)).catch(fail);
  $('#sout').onclick = () => post('/dashboard/signout').then(() => location.reload()).catch(fail);
  $('#dgsave')?.addEventListener('click', () => post('/settings', { dashboard: { googleClientId: $('#dgc').value.trim() || null, googleEmails: $('#dge').value.split(',').map((x) => x.trim()).filter(Boolean) } }).then(() => { toast('Saved'); render.settings(); }).catch(fail));
  gpuProviders(s).catch((e) => { $('#gpuProviders').innerHTML = `<h3>GPU providers</h3><p class="muted small">${esc(e.message)}</p>`; });
  if (me.role === 'owner') payments().catch((e) => { $('#payments').innerHTML = `<h3>Payments (Stripe)</h3><p class="muted small">${esc(e.message)}</p>`; });
};

// Payments (billing.ts): this lane's Stripe keys and webhook. Keys go in once and are never shown again (only whether each is
// set, and the mode they're in); "Set up the webhook" points this address's Stripe endpoint at Gen and keeps its secret.
async function payments() {
  const st = await api('/billing/config');
  const mode = st.mode === 'live' ? '<b style="color:var(--bad, #c33)">live: real cards are charged</b>' : st.mode === 'test' ? '<b>test: no money moves</b>' : '<span class="muted">not set</span>';
  const yes = (v) => (v ? '✓ set' : '<span class="muted">not set</span>');
  $('#payments').innerHTML = `<h3>Payments (Stripe)</h3>
    <p class="muted small">People buy credit packs and monthly plans through Stripe Checkout; Stripe's webhook adds the credits, once per payment. Beta uses Stripe's test keys (sk_test_…, card 4242 4242 4242 4242); live uses the live ones.</p>
    <table><tbody><tr><td>Mode</td><td>${mode}</td></tr><tr><td>Secret key</td><td>${yes(st.hasSecretKey)}</td></tr><tr><td>Publishable key</td><td>${yes(st.hasPublishableKey)}</td></tr><tr><td>Webhook signing secret</td><td>${yes(st.hasWebhookSecret)}</td></tr></tbody></table>
    <div class="form" style="margin-top:10px">
      <label><span>Secret key (sk_test_… or sk_live_…; a restricted rk_ key works too)</span><input id="pysk" type="password" autocomplete="off" placeholder="${st.hasSecretKey ? 'set: paste to replace' : 'sk_test_…'}"></label>
      <label><span>Publishable key (optional)</span><input id="pypk" autocomplete="off" placeholder="${st.hasPublishableKey ? 'set: paste to replace' : 'pk_test_…'}"></label>
      <label><span>Webhook signing secret (only if the endpoint already exists in Stripe; else use Set up the webhook)</span><input id="pywh" type="password" autocomplete="off" placeholder="${st.hasWebhookSecret ? 'set: paste to replace' : 'whsec_…'}"></label>
    </div>
    <div class="row" style="margin-top:10px"><button class="primary" id="pysave">Save keys</button><button id="pyhook" ${st.hasSecretKey ? '' : 'disabled'}>Set up the webhook for ${esc(location.origin)}</button><span id="pymsg" class="small muted"></span></div>`;
  $('#pysave').onclick = () => {
    const body = {};
    for (const [id, k] of [['pysk', 'secretKey'], ['pypk', 'publishableKey'], ['pywh', 'webhookSecret']]) { const v = $(`#${id}`).value.trim(); if (v) body[k] = v; }
    if (!Object.keys(body).length) return toast('Paste a key first');
    if (body.secretKey?.includes('_live_') && !confirm('This is a LIVE key: real cards will be charged on this Gen. Save it?')) return;
    post('/billing/config', body).then(() => { toast('Saved'); payments(); }).catch(fail);
  };
  $('#pyhook').onclick = async () => {
    $('#pymsg').textContent = 'Asking Stripe…';
    const run = (replace) => post('/billing/webhook/setup', { replace });
    try {
      let r;
      try { r = await run(false); } catch (e) {
        if (!/replace the endpoint/.test(e.message)) throw e;
        if (!confirm(`${e.message}\n\nReplace it? Stripe makes a new endpoint for this address with a new secret; nothing else changes.`)) { $('#pymsg').textContent = ''; return; }
        r = await run(true);
      }
      toast(`Webhook ${r.action}: ${r.url}`);
      payments();
    } catch (e) { $('#pymsg').textContent = ''; fail(e); }
  };
}

// Where GPU jobs run (docs/gpu-providers.md, GET /v1/gpu/providers): the providers in the order jobs try them, whether each
// is set up, cooling down after refusing us (and why), its last error and price. The order and on/off save to settings.gpu.
async function gpuProviders(s) {
  const r = await api('/gpu/providers');
  const fmt = (t) => (t ? new Date(t).toLocaleTimeString() : '');
  const state = (p) => (!p.ready ? `<span class="muted">${esc(p.problem)}</span>` : p.health.down ? `cooling down until ${fmt(p.health.until)}: ${esc(p.health.reason)}` : 'ready');
  const pos = (id) => { const i = r.order.indexOf(id); return i < 0 ? '' : String(i + 1); };
  const intro = r.legacy
    ? 'No order set: each family runs where its backend setting says (the AWS fleet by default), as before.'
    : `Jobs try them in this order: <b>${esc(r.order.join(' → '))}</b>${Object.keys(r.familyOrder).length ? ` (own orders for ${esc(Object.keys(r.familyOrder).join(', '))})` : ''}. One that refuses (no GPU free, a bad key, unreachable) is skipped for a while and the job goes to the next.`;
  const rc = r.runpodCredit;
  const credit = !rc || rc.balance == null ? '' : `<p class="small"${rc.low ? ' style="color:var(--bad, #c33)"' : ''}>RunPod balance: <b>$${rc.balance.toFixed(2)}</b>${rc.empty ? ': out of credit, so RunPod is skipped (GPU jobs and playtests go to the next provider). Add funds at runpod.io (Billing).' : rc.low ? ': low. Add funds soon at runpod.io (Billing); at $0 RunPod starts nothing.' : ''} <span class="muted">checked ${esc(fmt(rc.at))}</span></p>`;
  $('#gpuProviders').innerHTML = `<h3>GPU providers</h3><p class="muted small">${intro}</p>${credit}
    <table><thead><tr><th>#</th><th>Provider</th><th>Kind</th><th>Where</th><th>GPU</th><th>$/hour</th><th>Families</th><th>Status</th><th>Last error</th><th></th></tr></thead><tbody>
    ${r.providers.map((p) => `<tr><td>${pos(p.id)}</td><td><b>${esc(p.id)}</b></td><td>${esc(p.provider)}</td><td>${esc(p.url ?? '')}</td><td>${esc(p.gpu)}</td><td>${p.pricePerHour != null ? p.pricePerHour.toFixed(2) : ''}</td><td>${esc(p.families.join(', '))}</td><td>${state(p)}</td>
      <td class="small">${p.health.lastError ? `${fmt(p.health.lastError.at)} ${esc(p.health.lastError.reason)}` : ''}</td>
      <td>${['runpod', 'modal', 'http'].includes(p.provider) ? `<button data-gp="${esc(p.id)}" data-on="${p.enabled ? 1 : 0}">${p.enabled ? 'Turn off' : 'Turn on'}</button>` : ''}</td></tr>`).join('')}</tbody></table>
    <div class="form" style="margin-top:10px"><label><span>Order (ids, comma separated; empty: the old rule)</span><input id="gpo" value="${esc(r.order.join(', '))}" placeholder="cloudrun, runpod-a, fleet"></label></div>
    <div class="row" style="margin-top:8px"><button id="gpsave">Save order</button></div>`;
  $('#gpsave').onclick = () => post('/settings', { gpu: { order: $('#gpo').value.split(',').map((x) => x.trim()).filter(Boolean) } }).then(() => { toast('Saved'); gpuProviders(s); }).catch(fail);
  for (const b of document.querySelectorAll('[data-gp]')) {
    b.onclick = () => post('/settings', { gpu: { providers: s.gpu.providers.map((p) => (p.id === b.dataset.gp ? { ...p, enabled: b.dataset.on !== '1' } : p)) } })
      .then(() => render.settings()).catch(fail);
  }
}

// The Claude logins Gen's Claude calls run with on the Max plan (src/claude-accounts.ts): sign in like Hawkes Studio's
// Settings (open Claude's link, sign in, paste the code back), keep several, switch, check one still answers.
async function claudeAccounts(list) {
  const box = $('#claudeAccounts');
  if (!box) return;
  // Starting a sign-in answers with the sign-in alone, not the list: read the list then.
  const l = list?.accounts ? list : await api('/claude/accounts');
  const day = (t) => (t ? new Date(t).toLocaleDateString() : '—');
  const si = l.signin;
  box.innerHTML = `<h3>🔑 Claude accounts</h3>
    <p class="muted small">Gen's writing, reviews and assistant run Claude Code on these Max-plan logins ($0 a call). The one in use is what every call gets; switching takes effect at once. Tokens never leave Gen: you see a name and the last 4 characters.</p>
    ${l.accounts.length ? `<table><thead><tr><th>Name</th><th>Token</th><th>Added</th><th>Expires</th><th>Last check</th><th></th></tr></thead><tbody>${l.accounts.map((a) => `<tr>
      <td>${a.active ? '<b>● </b>' : ''}${esc(a.label)}</td><td><code>…${esc(a.tail)}</code></td><td>${esc(day(a.added))}</td><td>${esc(day(a.expires))}</td>
      <td class="small">${a.check ? `${a.check.ok ? '✓' : '✗'} ${esc(a.check.note)} <span class="muted">${esc(ago(a.check.at))}</span>` : '<span class="muted">not checked</span>'}</td>
      <td class="row">${a.active ? '<span class="muted small">in use</span>' : `<button data-ca-use="${a.id}">Use</button>`}<button data-ca-check="${a.id}">Check</button><button data-ca-rename="${a.id}">Rename</button>${a.active ? '' : `<button class="danger" data-ca-del="${a.id}">Remove</button>`}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No Claude account yet: sign in below.</p>'}
    ${si && ['waiting', 'finishing'].includes(si.state) ? `<div style="margin-top:12px">
        <p><b>1.</b> <a href="${esc(si.url)}" target="_blank" rel="noopener">Open Claude's sign-in page</a> and sign in to the account${si.label ? ` (“${esc(si.label)}”)` : ''}.</p>
        <p><b>2.</b> Claude shows a code (it has a # in the middle). Paste it here:</p>
        <div class="row"><input id="cacode" autocomplete="off" style="flex:1" placeholder="code#…"><button class="primary" id="cafinish">Finish</button><button id="cacancel">Cancel</button></div></div>`
      : `<div class="row" style="margin-top:12px"><input id="calabel" style="flex:1" placeholder="A name for it (e.g. jgriffith personal)"><button class="primary" id="castart">Sign in to a Claude account</button></div>
         <details style="margin-top:10px"><summary class="small">Or paste a token (any computer, Windows too)</summary>
           <p class="muted small">In a terminal where Claude Code is installed, run <code>claude setup-token</code>, sign in, and paste the line it prints (sk-ant-oat01-…). It lasts a year.</p>
           <div class="row"><input id="catoken" type="password" autocomplete="off" style="flex:1" placeholder="sk-ant-oat01-…"><button class="primary" id="casave">Save token</button></div></details>
         ${si?.state === 'failed' && si.error ? `<p class="small" style="color:var(--bad, #c33)">${esc(si.error)}</p>` : ''}`}`;
  // A failure redraws the card too: its buttons come back and a failed sign-in shows why in place.
  const again = (p) => p.then((r) => claudeAccounts(r)).catch((e) => { fail(e); claudeAccounts().catch(() => {}); });
  $('#castart', box)?.addEventListener('click', (e) => { e.target.disabled = true; e.target.textContent = 'Starting Claude Code…'; again(post('/claude/signin', { label: $('#calabel', box).value })); });
  $('#cafinish', box)?.addEventListener('click', (e) => { e.target.disabled = true; e.target.textContent = 'Signing in…'; again(post('/claude/signin/code', { code: $('#cacode', box).value }).then((r) => { toast(`Signed in: ${r.account.label}`); return r; })); });
  $('#cacancel', box)?.addEventListener('click', () => again(post('/claude/signin/cancel')));
  $('#casave', box)?.addEventListener('click', (e) => { e.target.disabled = true; again(post('/claude/token', { token: $('#catoken', box).value.trim(), label: $('#calabel', box).value }).then((r) => { toast(`Saved: ${r.account.label}`); return r; })); });
  for (const b of box.querySelectorAll('[data-ca-use]')) b.onclick = () => again(post(`/claude/accounts/${b.dataset.caUse}/use`));
  for (const b of box.querySelectorAll('[data-ca-check]')) b.onclick = () => { b.disabled = true; b.textContent = 'Checking…'; again(post(`/claude/accounts/${b.dataset.caCheck}/check`)); };
  for (const b of box.querySelectorAll('[data-ca-rename]')) b.onclick = () => { const n = prompt('A new name'); if (n) again(post(`/claude/accounts/${b.dataset.caRename}/rename`, { label: n })); };
  for (const b of box.querySelectorAll('[data-ca-del]')) b.onclick = () => confirm('Remove this Claude account from Gen?') && again(api(`/claude/accounts/${b.dataset.caDel}`, { method: 'DELETE' }));
}

// ---------------------------------------------------------------- AI: the house AI every Gen account uses
// (src/houseai.ts): J's Anthropic API key and/or Gen's Claude sign-ins, which one serves accounts, and the price.
render.ai = async () => {
  const s = await api('/admin/ai');
  const now = s.now === 'api' ? 'the Anthropic API key' : s.now === 'claude' ? 'Gen’s Claude sign-in' : 'nothing';
  $('#ai').innerHTML = `<h2>AI</h2>
    <div class="card"><h3>What accounts get</h3>
      <p>Every Gen account's AI (the AI editor, the director, and tools that ask Claude) runs on <b>${esc(now)}</b>${s.why ? `: <span style="color:var(--bad)">${esc(s.why)}</span>` : ''}. Nobody connects anything. An account that connected its own key or subscription uses that instead, for free.</p>
      <div class="form">
        <label><span>Use</span><select id="hsrc">${[['auto', 'The API key, else a Claude sign-in'], ['api', 'The API key only'], ['claude', 'Claude sign-ins only'], ['off', 'Off (accounts need their own)']].map(([v, l]) => `<option value="${v}" ${s.source === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label><span>Price: the call's cost × this (1 credit = 1¢)</span><input id="hmk" type="number" min="1" max="10" step="0.1" value="${s.markup}"></label>
        <label><span>At least (credits a message)</span><input id="hmin" type="number" min="0" max="100" step="1" value="${s.minCredits}"></label>
      </div>
      <div class="row" style="margin-top:10px"><button class="primary" id="hsave">Save</button></div>
      <p class="muted small">Anthropic's Pro and Max plans are for one person's own use: serving your customers on a sign-in can break Anthropic's terms. "The API key, else a Claude sign-in" keeps the key first. A sign-in's calls cost you $0, so accounts pay the minimum.</p></div>
    <div class="card"><h3>Anthropic API key</h3>
      ${s.key.set ? `<p>Set: <code>…${esc(s.key.last4)}</code> <span class="muted small">by ${esc(s.key.by ?? '')} ${esc(ago(s.key.updated))}</span></p><div class="row"><button class="danger" id="hkdel">Remove</button></div>`
        : `<p class="muted small">${s.envKey ? 'None stored: the service’s own ANTHROPIC_API_KEY is used.' : 'None yet.'} Make one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>. It's stored encrypted and never shown again.</p>`}
      <div class="row" style="margin-top:8px"><input id="hkey" type="password" autocomplete="off" style="flex:1" placeholder="sk-ant-api03-…"><button id="hkset">${s.key.set ? 'Replace' : 'Save key'}</button></div></div>
    <div class="card" id="claudeAccounts"><h3>🔑 Claude accounts</h3><p class="muted small">Loading…</p></div>`;
  $('#hsave').onclick = () => api('/admin/ai', { method: 'PUT', body: JSON.stringify({ source: $('#hsrc').value, markup: Number($('#hmk').value), minCredits: Number($('#hmin').value) }) }).then(() => { toast('Saved'); render.ai(); }).catch(fail);
  $('#hkset').onclick = () => api('/admin/ai/key', { method: 'PUT', body: JSON.stringify({ key: $('#hkey').value.trim() }) }).then(() => { toast('Key saved'); render.ai(); }).catch(fail);
  $('#hkdel')?.addEventListener('click', () => confirm('Remove the stored API key?') && api('/admin/ai/key', { method: 'DELETE' }).then(() => render.ai()).catch(fail));
  claudeAccounts().catch(fail);
};

// ---------------------------------------------------------------- accounts: Gen app accounts (src/accounts.ts)
render.accounts = async () => {
  const q = render.accounts.q ?? '';
  const r = await api(`/admin/accounts?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const o = r.overview;
  const n = (x) => Number(x ?? 0).toLocaleString();
  $('#accounts').innerHTML = `<h2>Accounts</h2>
    <div class="grid">${[['Accounts', o.accounts], ['New this week', o.new7d], ['Signed in this week', o.active7d], ['Credits held', o.creditsHeld], ['Credits spent (30 days)', o.spent30d], ['Credits bought (30 days)', o.bought30d]].map(([l, v]) => `<div class="card stat"><b>${n(v)}</b><span>${l}</span></div>`).join('')}</div>
    <div class="card"><div class="row" style="margin-bottom:10px"><input id="acq" style="flex:1" placeholder="Search email, name or id" value="${esc(q)}"><span class="muted small">${n(r.total)} account${r.total === 1 ? '' : 's'}</span></div>
      ${r.items.length ? `<table><thead><tr><th>Account</th><th class="num">Credits</th><th class="num">Spent</th><th>Joined</th><th>Last sign-in</th><th></th></tr></thead><tbody>${r.items.map((a) => `<tr data-acc="${a.id}" style="cursor:pointer">
        <td><b>${esc(a.name || a.email)}</b>${a.admin ? ' <span class="pill">admin</span>' : ''}${a.disabled ? ' <span class="pill bad">disabled</span>' : ''}<div class="muted small">${esc(a.email)}</div></td>
        <td class="num">${n(a.credits)}</td><td class="num">${n(a.spent)}</td><td>${esc(new Date(a.created).toLocaleDateString())}</td><td>${esc(ago(a.last_login))}</td><td><button data-acc="${a.id}">Open</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No accounts match.</div>'}</div>`;
  let t = 0;
  $('#acq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { render.accounts.q = e.target.value.trim(); render.accounts().then(() => { const i = $('#acq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }).catch(fail); }, 300); };
  for (const el of document.querySelectorAll('#accounts [data-acc]')) el.onclick = (e) => { e.stopPropagation(); showAccount(el.dataset.acc).catch(fail); };
  labelCells();
};

/** A ledger or job note as one short line: no terminal colors, no traceback. */
const oneLine = (t) => { const s = String(t ?? '').replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim(); const tb = /Traceback|File "/.test(s) ? (s.match(/(\w+Error: [^(]*)/)?.[1] ?? 'failed on Gen') : s; return tb.length > 140 ? `${tb.slice(0, 137)}…` : tb; };
async function showAccount(id) {
  const d = await api(`/admin/accounts/${id}`);
  const a = d.account;
  const kinds = { signup_bonus: 'Welcome credits', stripe_purchase: 'Bought', subscription_credits: 'Plan', job_reserve: 'Job', job_refund: 'Refund', admin_grant: 'Added', admin_gift: 'Gift', admin_remove: 'Removed', ai_turn: 'AI' };
  const b = modal(`<h2>${esc(a.name || a.email)}</h2>
    <p class="muted small">${esc(a.email)} · <code>${esc(a.id)}</code> · joined ${esc(new Date(a.created).toLocaleDateString())} · last sign-in ${esc(ago(a.last_login))}${a.disabled ? ' · <b style="color:var(--bad)">disabled</b>' : ''}</p>
    <div class="grid"><div class="card stat"><b>${Number(a.credits).toLocaleString()}</b><span>credits</span></div><div class="card stat"><b>${Number(a.spent).toLocaleString()}</b><span>spent</span></div>
      <div class="card stat"><b>${esc(d.subscription && d.subscription.status !== 'canceled' ? d.subscription.planId : 'None')}</b><span>plan</span></div></div>
    <div class="card"><h3>🎁 Gift credits</h3><div class="row"><input id="gc" type="number" min="1" step="1" placeholder="Credits" style="width:110px"><input id="gn" style="flex:1" placeholder="A note they'll see (optional)"><button class="primary" id="ggo">Gift</button></div></div>
    <div class="card"><h3>Add or remove credits</h3><div class="row"><input id="cd" type="number" step="1" placeholder="+100 or -50" style="width:110px"><input id="cnote" style="flex:1" placeholder="Why"><button id="cgo">Apply</button></div></div>
    <div class="card"><h3>Ledger</h3>${d.ledger.length ? `<table><thead><tr><th>When</th><th>What</th><th class="num">Change</th><th class="num">Balance</th></tr></thead><tbody>${d.ledger.map((l) => `<tr><td>${esc(ago(l.created))}</td><td>${esc(kinds[l.kind] ?? l.kind)} <span class="muted small">${esc(oneLine(l.detail))}</span></td><td class="num" style="color:${l.delta < 0 ? 'var(--bad)' : 'var(--ok)'}">${l.delta > 0 ? '+' : ''}${l.delta}</td><td class="num">${l.balance_after}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing yet.</div>'}</div>
    <div class="card"><h3>Recent jobs</h3>${d.jobs.length ? `<table><thead><tr><th>When</th><th>Tool</th><th>Status</th></tr></thead><tbody>${d.jobs.map((j) => `<tr><td>${esc(ago(j.created))}</td><td>${esc(j.tool)}</td><td>${statusCell(j)}${j.error ? `<div class="muted small">${esc(oneLine(j.error))}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No jobs yet.</div>'}</div>
    <div class="row spread">${a.admin ? '<span class="muted small">Admin account</span>' : `<span class="row"><button class="${a.disabled ? '' : 'danger'}" id="dis">${a.disabled ? 'Enable this account' : 'Disable this account'}</button><button class="danger" id="del">Delete this account</button></span>`}<button id="aclose">Close</button></div>`);
  const after = () => { showAccount(id).catch(fail); if (current === 'accounts') render.accounts().catch(() => {}); };
  $('#ggo', b).onclick = () => post(`/admin/accounts/${id}/gift`, { credits: Number($('#gc', b).value), note: $('#gn', b).value }).then(() => { toast('Gift sent'); after(); }).catch(fail);
  $('#cgo', b).onclick = () => post(`/admin/accounts/${id}/credits`, { delta: Number($('#cd', b).value), note: $('#cnote', b).value }).then(() => { toast('Credits changed'); after(); }).catch(fail);
  $('#dis', b)?.addEventListener('click', () => { const off = !a.disabled; if (off && !confirm(`Disable ${a.email}? They're signed out and can't sign in until you enable them.`)) return; post(`/admin/accounts/${id}/${off ? 'disable' : 'enable'}`, {}).then(after).catch(fail); });
  // Deleting for good (accounts.ts deleteAccount): its plan is ended in Stripe first; typing the email confirms.
  $('#del', b)?.addEventListener('click', async () => {
    const typed = prompt(`Delete ${a.email} for good? Their plan is ended in Stripe, their running jobs are stopped, and everything they made is removed. This can't be undone.\n\nType their email to confirm:`);
    if (typed == null) return;
    try {
      const r = await api(`/admin/accounts/${id}`, { method: 'DELETE', body: JSON.stringify({ confirm: typed }) });
      $('#modal').close();
      toast(`Deleted ${r.email}${r.planEnded ? ' (their plan was ended)' : ''}`);
      if (current === 'accounts') render.accounts().catch(() => {});
    } catch (err) { fail(err); }
  });
  $('#aclose', b).onclick = () => $('#modal').close();
  labelCells();
}

// ---------------------------------------------------------------- making (src/make/, docs/make.md)
// The making loop's knobs and what its learning proposes: nothing applies until the owner approves it here.
render.making = async () => {
  const [st, open, done] = await Promise.all([api('/make/settings'), api('/make/proposals?status=open'), api('/make/proposals')]);
  const decided = done.items.filter((p) => p.status !== 'open').slice(0, 20);
  const row = (p) => `<tr><td><span class="pill">${esc(p.kind)}</span></td><td>${esc(p.title)}<div class="small muted">${esc(JSON.stringify(p.evidence).slice(0, 220))}</div></td>
    <td class="num">${p.status === 'open' ? `<button data-ok="${esc(p.id)}">Approve</button> <button class="ghost" data-no="${esc(p.id)}">Reject</button>` : `<span class="small muted">${esc(p.status)} ${esc(ago(p.decided))}</span>`}</td></tr>`;
  $('#making').innerHTML = `
    <div class="card"><h3>Making settings</h3>
      <p class="small muted">Every AI action makes things through the making loop: cheap previews, checks, the final, at most two fixes, never past the budget.</p>
      <div class="row">
        <label>Default budget (credits) <input id="mkBudget" type="number" min="1" value="${esc(st.defaultBudget ?? '')}"></label>
        <label>Most retries <input id="mkRetries" type="number" min="0" max="2" value="${esc(st.maxRetries)}"></label>
        <label>Checklist pass <input id="mkCheck" type="number" step="0.05" min="0" max="1" placeholder="0.85" value="${esc(st.thresholds.checklist ?? '')}"></label>
        <label>Face distance <input id="mkFace" type="number" step="0.01" min="0" max="1" placeholder="0.15" value="${esc(st.thresholds.identity ?? '')}"></label>
        <label>Style pass <input id="mkStyle" type="number" step="0.05" min="0" max="1" placeholder="0.7" value="${esc(st.thresholds.style ?? '')}"></label>
        <label><input id="mkPaid" type="checkbox" ${st.allowPaid ? 'checked' : ''}> Paid partner models may be used</label>
        <button id="mkSave">Save</button>
      </div></div>
    <div class="card"><div class="row spread"><h3>Proposed from feedback</h3><button id="mkRun">Look at the feedback now</button></div>
      ${open.items.length ? `<table><tbody>${open.items.map(row).join('')}</tbody></table>` : '<div class="empty">Nothing proposed yet. Picks, discards, redos and complaints are grouped every day.</div>'}</div>
    ${decided.length ? `<div class="card"><h3>Decided</h3><table><tbody>${decided.map(row).join('')}</tbody></table></div>` : ''}`;
  const num = (id) => ($(id).value === '' ? undefined : Number($(id).value));
  $('#mkSave').onclick = () => api('/make/settings', { method: 'PUT', body: JSON.stringify({
    defaultBudget: num('#mkBudget') ?? null, maxRetries: num('#mkRetries'), allowPaid: $('#mkPaid').checked,
    thresholds: Object.fromEntries([['checklist', num('#mkCheck')], ['identity', num('#mkFace')], ['style', num('#mkStyle')]].filter(([, v]) => v !== undefined)),
  }) }).then(() => { toast('Saved'); render.making(); }).catch(fail);
  $('#mkRun').onclick = () => api('/make/proposals/summarize', { method: 'POST', body: '{}' }).then((r) => { toast(`${r.proposed.length} new from ${r.looked} pieces of feedback`); render.making(); }).catch(fail);
  const decide = (id, approve) => api(`/make/proposals/${id}`, { method: 'POST', body: JSON.stringify({ approve }) }).then(() => render.making()).catch(fail);
  for (const b of $('#making').querySelectorAll('[data-ok]')) b.onclick = () => decide(b.dataset.ok, true);
  for (const b of $('#making').querySelectorAll('[data-no]')) b.onclick = () => decide(b.dataset.no, false);
};

// ---------------------------------------------------------------- start
api('/tools').then((r) => { state.tools = r.tools; }).catch(() => {}).finally(() => { connect(); show(current); });
// ---------------------------------------------------------------- bench: Gen Bench (dashboard/bench.js, docs/bench.md)
render.bench = benchTab({ $, esc, ago, api, post, toast, fail, modal, mediaTag, me: () => api('/me') });

