// The Bench tab (docs/bench.md): Gen Bench's scores over runs, each run's outputs beside the market baseline's, the
// per-question answers, J's ratings and how each score agrees with them, the cast's references, and starting a run
// (mock: free; real: the owner, after seeing its price). app.js hands in its helpers.

const SCORES = [
  { key: 'pass', label: 'Passed', fmt: (v) => pct(v), better: 'up' },
  { key: 'checklist', label: 'Follows the brief', fmt: (v) => pct(v), better: 'up' },
  { key: 'identity', label: 'Face distance', fmt: (v) => v.toFixed(3), better: 'down', target: 0.15 },
  { key: 'style', label: 'On the look', fmt: (v) => pct(v), better: 'up' },
  { key: 'faultFree', label: 'Fault-free', fmt: (v) => pct(v), better: 'up' },
  { key: 'cost', label: 'Cost', fmt: (v) => `$${v.toFixed(2)}`, better: 'down' },
];
const pct = (v) => `${Math.round(v * 100)}%`;

function styles() {
  if (document.getElementById('benchCss')) return;
  const s = document.createElement('style');
  s.id = 'benchCss';
  s.textContent = `
    .bench-trend { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .bench-trend svg { width: 100%; height: 70px; display: block; }
    .bench-trend .now { font-size: var(--text-xl); font-weight: var(--weight-bold); }
    .bench-brief { border-top: 1px solid var(--line); padding: var(--space-4) 0; }
    .bench-row { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); margin-top: var(--space-2); }
    .bench-out { border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; background: var(--panel); display: flex; flex-direction: column; }
    .bench-out.base { border-style: dashed; }
    .bench-out .media { aspect-ratio: 16 / 10; background: var(--panel-2); display: grid; place-items: center; }
    .bench-out .media img, .bench-out .media video { max-width: 100%; max-height: 100%; object-fit: contain; }
    .bench-out .media model-viewer { width: 100%; height: 100%; }
    .bench-out .body { padding: var(--space-2) var(--space-3); font-size: var(--text-sm); display: grid; gap: var(--space-2); }
    .bench-out .chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
    .bench-out ul { margin: 0; padding-left: var(--space-4); }
    .bench-out li { margin: 2px 0; }
    .bench-out .rate { display: flex; gap: var(--space-1); }
    .bench-out .rate button { min-width: 30px; padding: var(--space-1) var(--space-2); }
    .bench-out .rate button.on { background: var(--accent); color: var(--on-primary); border-color: var(--accent); }
  `;
  document.head.append(s);
}

/** A small line over the runs (oldest left), the target as a dashed line. */
function spark(values, target) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (!pts.length) return '<svg viewBox="0 0 100 40"><text x="0" y="24" fill="currentColor" opacity=".5" font-size="9">no runs yet</text></svg>';
  const all = pts.map(([, v]) => v).concat(target != null ? [target] : []);
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = hi - lo || 1;
  const n = Math.max(1, values.length - 1);
  const x = (i) => 4 + (i / n) * 92;
  const y = (v) => 36 - ((v - lo) / span) * 32;
  const line = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 100 40" preserveAspectRatio="none">
    ${target != null ? `<line x1="0" x2="100" y1="${y(target)}" y2="${y(target)}" stroke="currentColor" opacity=".35" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>` : ''}
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${pts.map(([i, v]) => `<circle cx="${x(i)}" cy="${y(v)}" r="1.6" fill="var(--accent)"/>`).join('')}</svg>`;
}

export function benchTab(h) {
  const { $, esc, ago, api, post, toast, fail, modal, mediaTag, me } = h;
  styles();
  let open = null;

  async function render() {
    const o = await api('/bench');
    const user = await me();
    const runs = o.runs.filter((r) => r.mode !== 'baseline');
    const real = runs.filter((r) => r.mode === 'real').reverse();
    const shown = real.length ? real : runs.filter((r) => r.mode === 'mock').reverse();
    const baselines = o.runs.filter((r) => r.mode === 'baseline');
    const el = $('#bench');
    el.innerHTML = `<h2>Bench</h2>
      <p class="muted small">${o.briefs.length} fixed briefs through the app's real path, every output scored: faces against the cast's references, the brief as yes/no questions, faults, the look. ${real.length ? 'The trend shows real runs.' : 'No real run yet: the trend shows mock runs (stand-in files, made-up scores) until there is one.'}</p>
      <div class="row" style="margin:10px 0 16px"><button class="primary" id="bmock">Mock run</button>${user.role === 'owner' ? '<button id="breal">Real run…</button>' : ''}<button id="bbase">Add a baseline output…</button></div>
      <div class="card"><h3>Over time</h3><div class="bench-trend">${SCORES.map((s) => {
        const vals = shown.map((r) => r.summary?.[s.key] ?? null);
        const last = vals.filter((v) => v != null).pop();
        return `<div><div class="muted small">${s.label}${s.better === 'down' ? ' (lower is better)' : ''}</div><div class="now">${last == null ? '—' : s.fmt(last)}</div>${spark(vals, s.target)}</div>`;
      }).join('')}</div></div>
      <div class="card"><h3>Runs</h3>${o.runs.length ? `<table><thead><tr><th>When</th><th>Run</th><th>Status</th><th class="num">Outputs</th><th class="num">Passed</th><th class="num">Brief</th><th class="num">Face</th><th class="num">Look</th><th class="num">Fault-free</th><th class="num">Cost</th></tr></thead><tbody>${o.runs.map((r) => {
        const s = r.summary ?? {};
        const f = (v, fm) => (v == null ? '—' : fm(v));
        return `<tr data-run="${r.id}" style="cursor:pointer"><td>${esc(ago(r.created))}</td><td><b>${esc(r.label || r.mode)}</b> <span class="pill ${r.mode === 'real' ? 'ok' : r.mode === 'baseline' ? 'warn' : ''}">${esc(r.mode)}</span></td>
          <td class="s-${esc(r.status)}">${esc(r.status)}${r.detail ? ` <span class="muted small">${esc(r.detail)}</span>` : ''}${r.error ? ` <span class="small" style="color:var(--bad)">${esc(r.error)}</span>` : ''}</td>
          <td class="num">${s.outputs ?? 0}</td><td class="num">${f(s.pass, pct)}</td><td class="num">${f(s.checklist, pct)}</td><td class="num">${f(s.identity, (v) => v.toFixed(3))}</td><td class="num">${f(s.style, pct)}</td><td class="num">${f(s.faultFree, pct)}</td><td class="num">${f(s.cost, (v) => `$${v.toFixed(2)}`)}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">No runs yet. Start with a mock run: it is free and shows the whole loop.</div>'}</div>
      <div id="brun"></div>
      <div class="grid">
        <div class="card"><h3>Do the scores agree with you?</h3><p class="muted small">${o.rated} output${o.rated === 1 ? '' : 's'} rated. Rate outputs 1 to 5 in a run below; a score is trusted once it ranks outputs like you do (correlation 0.5 or more over 10 or more ratings).</p>
          <table><thead><tr><th>Score</th><th class="num">Rated</th><th class="num">Agreement</th><th></th></tr></thead><tbody>${o.agreement.map((a) => `<tr><td>${esc(a.score)}</td><td class="num">${a.n}</td><td class="num">${a.spearman == null ? '—' : a.spearman.toFixed(2)}${a.passAgree != null ? ` <span class="muted small">(${pct(a.passAgree)} same call)</span>` : ''}</td><td>${a.trusted == null ? '<span class="muted small">needs ratings</span>' : a.trusted ? '<span class="pill ok">trusted</span>' : '<span class="pill bad">disagrees</span>'}</td></tr>`).join('')}</tbody></table></div>
        <div class="card"><h3>The cast</h3><p class="muted small">Whose faces identity is scored against. A real run makes a portrait for anyone without references; drop in better ones by asset id.</p>
          ${o.cast.map((c) => `<div class="row" style="align-items:center;margin:6px 0">${c.assets.slice(0, 2).map((a) => `<img src="/v1/files/${esc(a)}" alt="" style="width:42px;height:42px;object-fit:cover;border-radius:6px">`).join('') || '<span class="pill">no refs</span>'}<div style="flex:1"><b>${esc(c.name)}</b><div class="muted small">${esc(c.description.slice(0, 90))}…</div></div><button data-cast="${esc(c.id)}">Set refs</button></div>`).join('')}
        </div>
        <div class="card"><h3>Market baselines</h3>${baselines.length ? baselines.map((b) => `<div class="row" data-run="${b.id}" style="cursor:pointer;margin:4px 0"><b>${esc(b.label)}</b><span class="muted small">${b.summary?.outputs ?? 0} outputs · ${b.summary?.pass == null ? '—' : pct(b.summary.pass)} passed</span></div>`).join('') : '<p class="muted small">None yet. Make a brief the way a skilled creator would elsewhere, then add the file here: it is scored exactly like Gen\'s.</p>'}</div>
      </div>`;
    $('#bmock').onclick = () => post('/bench/runs', { mode: 'mock' }).then((r) => { toast('Mock run started'); open = r.run.id; follow(); }).catch(fail);
    $('#breal')?.addEventListener('click', () => realRun().catch(fail));
    $('#bbase').onclick = () => baseline(o).catch(fail);
    for (const tr of el.querySelectorAll('[data-run]')) tr.onclick = () => { open = tr.dataset.run; showRun().catch(fail); };
    for (const b of el.querySelectorAll('[data-cast]')) b.onclick = () => {
      const v = prompt('Reference asset ids (a_…), comma separated');
      if (v != null) api(`/bench/cast/${b.dataset.cast}`, { method: 'PUT', body: JSON.stringify({ assets: v.split(',').map((s) => s.trim()).filter(Boolean) }) }).then(() => render()).catch(fail);
    };
    if (open) await showRun();
  }

  /** Redraws while the open run is going. */
  function follow() { render().catch(fail); }
  // The server says when a run moved on (app.js hears `bench` on GET /v1/events): redraw only while the tab is showing.
  document.addEventListener('gen:bench', () => { if (document.querySelector('#bench.on')) follow(); });

  async function realRun() {
    const est = await post('/bench/estimate', {});
    const b = modal(`<h2>Real bench run</h2>
      <p>${est.briefs} briefs through the app, on real servers. About <b>$${est.total.toFixed(2)}</b>: GPU $${(est.gpu?.cost?.total ?? 0).toFixed(2)}${est.gpu ? ` (${est.gpu.gpu.hours} GPU hours)` : ''}, Claude $${est.claude.toFixed(2)}.${est.castToMake ? ` Includes a portrait for ${est.castToMake} cast member${est.castToMake > 1 ? 's' : ''} without references.` : ''}</p>
      ${est.unknown.length ? `<p class="muted small">Not priced (this Gen lacks them): ${esc(est.unknown.join(', '))}</p>` : ''}
      <p class="muted small">${esc(est.note)}</p>
      <div class="row"><input id="brlabel" placeholder="A name for this run (optional)" style="flex:1"><button class="primary" id="brgo">Run it for about $${est.total.toFixed(2)}</button><button id="brno">Cancel</button></div>`);
    $('#brno', b).onclick = () => $('#modal').close();
    $('#brgo', b).onclick = () => post('/bench/runs', { mode: 'real', confirmCost: est.total, label: $('#brlabel', b).value || undefined })
      .then((r) => { $('#modal').close(); toast('Real run started'); open = r.run.id; follow(); }).catch(fail);
  }

  async function baseline(o) {
    const b = modal(`<h2>Add a baseline output</h2>
      <p class="muted small">An output for one brief made outside Gen (another product, by hand). It is scored exactly like Gen's and shown beside Gen's in each run.</p>
      <div class="form">
        <label><span>Brief</span><select id="bbrief">${o.briefs.map((x) => `<option value="${esc(x.id)}">${esc(x.title)} (${esc(x.kind)})</option>`).join('')}</select></label>
        <label><span>Made with</span><input id="blabel" placeholder="e.g. Kling 3 + Nano Banana"></label>
        <label><span>File</span><input id="bfile" type="file" accept="image/*,video/*,audio/*,.glb"></label>
      </div><p class="muted small" id="bbrieftext"></p>
      <div class="row"><button class="primary" id="bgo">Add and score</button><button id="bno">Cancel</button></div>`);
    const showBrief = () => { $('#bbrieftext', b).textContent = o.briefs.find((x) => x.id === $('#bbrief', b).value)?.brief ?? ''; };
    $('#bbrief', b).onchange = showBrief;
    showBrief();
    $('#bno', b).onclick = () => $('#modal').close();
    $('#bgo', b).onclick = async () => {
      const f = $('#bfile', b).files[0];
      if (!f) return toast('Pick the file');
      $('#bgo', b).disabled = true;
      try {
        const up = await api(`/assets?project=genbench-baseline&title=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, headers: { 'X-Filename': f.name, 'Content-Type': f.type || 'application/octet-stream' } });
        const asset = up.asset?.id ?? up.id;
        const r = await post('/bench/baseline', { brief: $('#bbrief', b).value, asset, label: $('#blabel', b).value || 'Market baseline' });
        $('#modal').close();
        toast('Added: scoring it now');
        open = r.run.id;
        render().catch(fail);
      } catch (e) { $('#bgo', b).disabled = false; fail(e); }
    };
  }

  function outCard(r, briefs) {
    const rep = r.report ?? {};
    const chips = [];
    if (r.status === 'scoring') chips.push('<span class="pill warn">scoring…</span>');
    if (r.status === 'failed') chips.push(`<span class="pill bad">${esc(r.error ?? 'failed')}</span>`);
    if (r.status === 'scored') chips.push(r.pass ? '<span class="pill ok">passed</span>' : '<span class="pill bad">failed</span>');
    if (r.checklist != null) chips.push(`<span class="pill">brief ${pct(r.checklist)}</span>`);
    if (r.identity != null) chips.push(`<span class="pill ${r.identity <= 0.15 ? 'ok' : 'bad'}">face ${r.identity.toFixed(3)}${r.spread ? ` ±${r.spread.toFixed(2)}` : ''}</span>`);
    else if (rep.identity && rep.identity.distance == null) chips.push('<span class="pill">no face found</span>');
    if (r.style != null) chips.push(`<span class="pill">look ${pct(r.style)}</span>`);
    if (r.cost) chips.push(`<span class="pill">$${r.cost.toFixed(2)}</span>`);
    const answers = rep.checklist?.answers ?? [];
    return `<div class="bench-out ${r.source === 'baseline' ? 'base' : ''}">
      <div class="media">${r.asset ? mediaTag({ asset: r.asset, kind: r.assetKind ?? r.kind }, (r.assetKind ?? r.kind) === 'audio' || (r.assetKind ?? r.kind) === 'video') : '<div class="glyph">∅</div>'}</div>
      <div class="body"><div class="small"><b>${r.source === 'baseline' ? esc(briefs.get(r.run) ?? 'Baseline') : 'Gen'}</b></div>
        <div class="chips">${chips.join('')}</div>
        ${answers.length ? `<ul>${answers.map((a) => `<li>${a.yes ? '✓' : '✗'} ${esc(a.q)} <span class="muted">${esc(a.why)}</span></li>`).join('')}</ul>` : rep.checklist?.skipped ? `<div class="muted small">${esc(rep.checklist.skipped)}</div>` : ''}
        ${rep.faults?.faults?.length ? `<div class="small" style="color:var(--bad)">Faults: ${esc(rep.faults.faults.join('; '))}</div>` : ''}
        ${rep.style?.why ? `<div class="muted small">Look: ${esc(rep.style.why)}</div>` : ''}
        ${rep.fix ? `<div class="small"><b>Next try:</b> ${esc(rep.fix)}</div>` : ''}
        ${rep.errors?.length ? `<div class="muted small">Not checked: ${esc(rep.errors.join('; '))}</div>` : ''}
        ${r.status === 'scored' ? `<div class="rate" data-result="${r.id}"><span class="muted small" style="align-self:center">Your rating</span>${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}" class="${r.rating === n ? 'on' : ''}">${n}</button>`).join('')}</div>` : ''}
      </div></div>`;
  }

  async function showRun() {
    const box = $('#brun');
    if (!box || !open) return;
    const d = await api(`/bench/runs/${open}`);
    const o = await api('/bench');
    const briefs = new Map(o.briefs.map((b) => [b.id, b]));
    const labels = new Map(o.runs.filter((r) => r.mode === 'baseline').map((r) => [r.id, r.label]));
    const ids = [...new Set(d.results.map((r) => r.brief))];
    const vs = new Map(d.versus.map((v) => [v.brief, v]));
    box.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h3>${esc(d.run.label || d.run.mode)} <span class="muted small">${esc(new Date(d.run.created).toLocaleString())}</span></h3>
        <div class="row">${d.run.status === 'running' ? '<button id="bstop">Stop</button>' : ''}<button id="bclose">Close</button></div></div>
      ${d.run.mode === 'mock' ? '<p class="muted small">Mock run: stand-in files and made-up scores, to check the loop end to end. Nothing here says anything about quality.</p>' : ''}
      ${ids.length ? ids.map((id) => {
        const b = briefs.get(id);
        const gen = d.results.filter((r) => r.brief === id);
        const base = d.run.mode === 'baseline' ? [] : d.baseline.filter((r) => r.brief === id);
        const w = vs.get(id)?.wins;
        const wins = w && base.length ? Object.entries(w).filter(([, v]) => v && v !== 'tie').map(([k, v]) => `<span class="pill ${v === 'gen' ? 'ok' : 'bad'}">${esc(k)}: ${v === 'gen' ? 'Gen' : 'baseline'}</span>`).join(' ') : '';
        return `<div class="bench-brief"><div><b>${esc(b?.title ?? id)}</b> <span class="muted small">${esc(b?.kind ?? '')}</span> ${wins}</div><div class="muted small">${esc(b?.brief ?? '')}</div>
          <div class="bench-row">${[...gen, ...base].map((r) => outCard(r, labels)).join('')}</div></div>`;
      }).join('') : `<p class="muted">${d.run.status === 'running' ? `Working: ${esc(d.run.detail || 'starting')}` : 'No outputs.'}</p>`}</div>`;
    $('#bclose').onclick = () => { open = null; box.innerHTML = ''; };
    $('#bstop')?.addEventListener('click', () => post(`/bench/runs/${open}/cancel`).then(() => toast('Stopping after this brief')).catch(fail));
    for (const rt of box.querySelectorAll('.rate')) for (const btn of rt.querySelectorAll('button')) btn.onclick = () => {
      const n = Number(btn.dataset.n);
      post(`/bench/results/${rt.dataset.result}/rate`, { rating: btn.classList.contains('on') ? null : n })
        .then(() => { for (const x of rt.querySelectorAll('button')) x.classList.toggle('on', !btn.classList.contains('on') && x === btn); })
        .catch(fail);
    };
    box.scrollIntoView({ block: 'nearest' });
  }

  return render;
}
