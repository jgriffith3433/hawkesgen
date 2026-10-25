#!/usr/bin/env node
// The audio audition (docs/audio.md "Audition"): the same real lines through every open model and ElevenLabs, side by
// side on one page, with loudness, clipping, silence, loop and intelligibility checks.
//
//   node tools/audition.mjs plan [--models qwen3-tts,voxcpm2]      what would run and what it costs (spends nothing)
//   node tools/audition.mjs run --yes [--models ...] [--no-elevenlabs] [--url http://127.0.0.1:8791]
//   node tools/audition.mjs report <dir>                           rebuild report.html from a finished run's report.json
//
// `run` submits jobs, so it needs J's OK for the GPU hours `plan` prints (and ElevenLabs credits if left on).
// Chatterbox cannot design a voice, so it clones the ElevenLabs take of the same line (that also tests cloning).
// Against a Gen started with HAWKESGEN_AUDIO_MOCK=1 the whole thing runs with no GPU (tones, not speech).
// Output: <dir>/report.html + report.json + the audio files (default .data/auditions/<stamp>/).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HawkesGen } from '../clients/js/hawkesgen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'plan';
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const set = JSON.parse(fs.readFileSync(path.join(here, '..', 'audio', 'audition-set.json'), 'utf8'));
const MODELS = (opt('models', 'moss-tts,qwen3-tts,voxcpm2,chatterbox')).split(',').filter(Boolean);
const SFX_MODELS = (opt('sfx-models', 'moss-soundeffect')).split(',').filter(Boolean);
const eleven = !flag('no-elevenlabs');
const gen = new HawkesGen({ url: opt('url'), project: opt('project', 'hawkesgen-audition') });

/** The job list. `needs` names an earlier job whose output is this one's reference. */
export function buildJobs() {
  const jobs = [];
  for (const v of set.voices) {
    if (eleven) jobs.push({ key: `${v.id}/elevenlabs`, line: v.id, engine: 'elevenlabs', tool: 'audio.voice', params: { text: v.text, voice: v.elevenlabs.voice, model: v.elevenlabs.model, provider: 'elevenlabs' } });
    for (const m of MODELS) {
      const params = { text: v.text, provider: 'open', openModel: m, verify: true, ...(v.direction ? { direction: v.direction } : {}), description: v.description, format: 'wav' };
      const needsRef = m === 'chatterbox';
      jobs.push({ key: `${v.id}/${m}`, line: v.id, engine: m, tool: 'audio.voice', params: needsRef ? { ...params, referenceText: v.text } : params, needs: needsRef && eleven ? `${v.id}/elevenlabs` : null, skip: needsRef && !eleven ? 'needs an ElevenLabs take to clone' : null });
    }
  }
  for (const s of set.sfx) {
    if (eleven) jobs.push({ key: `${s.id}/elevenlabs`, line: s.id, engine: 'elevenlabs', tool: 'audio.sfx', params: { text: s.text, ...(s.duration ? { duration: s.duration } : {}), loop: s.loop, provider: 'elevenlabs' } });
    for (const m of SFX_MODELS) jobs.push({ key: `${s.id}/${m}`, line: s.id, engine: m, tool: 'audio.sfx', params: { text: s.text, ...(s.duration ? { duration: s.duration } : {}), loop: s.loop, provider: 'open', openModel: m, format: 'wav', ...(s.variants ? { variants: s.variants } : {}) } });
  }
  return jobs.filter((j) => !j.skip);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function renderReport(rows, meta) {
  const lines = [...new Set(rows.map((r) => r.line))];
  const engines = [...new Set(rows.map((r) => r.engine))];
  const cell = (r) => {
    if (!r) return '<td class="none">not run</td>';
    if (r.error) return `<td class="bad">failed: ${esc(r.error)}</td>`;
    const a = r.analysis ?? {};
    const problems = [...(r.problems ?? [])];
    const ok = r.ok !== false && !problems.length;
    return `<td class="${ok ? 'ok' : 'bad'}">${(r.files ?? []).map((f) => `<audio controls preload="none" src="${esc(f)}"></audio>`).join('')}
      <div class="m">${a.lufs != null ? `${a.lufs.toFixed(1)} LUFS` : ''} ${a.truePeak != null ? `· TP ${a.truePeak.toFixed(1)}` : ''} ${a.seconds ? `· ${a.seconds.toFixed(1)} s` : ''}
      ${r.wer != null ? `· WER ${(r.wer * 100).toFixed(0)}%` : ''}${r.transcript ? `<br><i>"${esc(r.transcript)}"</i>` : ''}${problems.length ? `<br><b>${esc(problems.join('; '))}</b>` : ''}</div></td>`;
  };
  return `<!doctype html><meta charset="utf-8"><title>Gen audio audition ${esc(meta.stamp)}</title>
<style>body{font:14px system-ui;margin:20px;background:#111;color:#ddd}table{border-collapse:collapse}td,th{border:1px solid #333;padding:8px;vertical-align:top;max-width:300px}
th{background:#1c1c1c}.ok{background:#16231a}.bad{background:#2a1717}.none{color:#666}.m{font-size:12px;color:#aaa;margin-top:4px}audio{width:260px;height:32px}.line{max-width:260px;color:#bbb}</style>
<h1>Gen audio audition</h1><p>${esc(meta.stamp)} · ${rows.length} takes · green = passes the automatic checks (loudness near target, no clipping, no long silence, transcript matches), red = needs a look. Listen to all of them: the checks only filter.</p>
<table><tr><th>line</th>${engines.map((e) => `<th>${esc(e)}</th>`).join('')}</tr>
${lines.map((l) => { const any = rows.find((r) => r.line === l); return `<tr><td class="line"><b>${esc(l)}</b><br>${esc(any?.text ?? '').slice(0, 160)}</td>${engines.map((e) => cell(rows.find((r) => r.line === l && r.engine === e))).join('')}</tr>`; }).join('\n')}</table>`;
}

async function plan() {
  const jobs = buildJobs();
  const items = jobs.map((j) => ({ tool: j.tool, params: j.params, count: 1, label: j.key }));
  let est = null;
  try { est = await gen.estimate(items); } catch (e) { console.error(`(no estimate: ${e.message}; is Gen running at ${gen.url}?)`); }
  console.log(`${jobs.length} jobs: ${set.voices.length} voice lines x ${MODELS.length}${eleven ? ' + ElevenLabs' : ''}, ${set.sfx.length} sounds x ${SFX_MODELS.length}${eleven ? ' + ElevenLabs' : ''}`);
  for (const j of jobs) console.log(`  ${j.key}${j.needs ? ` (clones ${j.needs})` : ''}`);
  if (est) console.log(JSON.stringify({ gpu: est.gpu, cost: est.cost, note: est.note }, null, 1));
  console.log('Spends nothing. `run --yes` submits these.');
}

async function run() {
  if (!flag('yes')) throw new Error('run spends GPU hours (see `plan`). Pass --yes once J has approved the cost.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(opt('out', path.join(here, '..', '.data', 'auditions', stamp)));
  fs.mkdirSync(dir, { recursive: true });
  const jobs = buildJobs();
  const done = new Map();
  const rows = [];
  const text = (id) => (set.voices.find((v) => v.id === id) ?? set.sfx.find((s) => s.id === id))?.text ?? '';
  // ElevenLabs first (the clone sources), then the open models, each model's lines together so a server loads it once.
  const order = [...jobs.filter((j) => j.engine === 'elevenlabs'), ...jobs.filter((j) => j.engine !== 'elevenlabs')];
  await Promise.all(order.map(async (j) => {
    const row = { key: j.key, line: j.line, engine: j.engine, text: text(j.line), files: [] };
    rows.push(row);
    try {
      const params = { ...j.params };
      const inputs = {};
      if (j.needs) {
        const src = await done.get(j.needs);
        if (!src?.outputs?.[0]) throw new Error(`no ${j.needs} take to clone`);
        inputs.reference = `asset:${src.outputs[0].asset}`;
      }
      const p = gen.run(j.tool, { params, inputs, key: `audition:${stamp}:${j.key}` });
      done.set(j.key, p);
      const job = await p;
      const takes = job.result?.takes ?? [];
      for (const [i, o] of (job.outputs ?? []).entries()) {
        const f = `${j.key.replace('/', '--')}-${i}${path.extname(o.file ?? '') || '.wav'}`;
        await gen.download(o.asset, path.join(dir, f));
        row.files.push(f);
      }
      const t = takes[0] ?? {};
      row.analysis = { lufs: t.lufs ?? null, seconds: t.seconds ?? null };
      row.wer = t.wer ?? null;
      row.transcript = t.transcript ?? null;
      row.problems = t.problems ?? [];
      row.ok = t.ok;
      row.model = job.result?.model ?? j.engine;
      if (j.engine === 'elevenlabs' && job.outputs?.[0]) {
        // ElevenLabs has no built-in check: the same free analysis the open takes get.
        const a = await gen.run('audio.analyze', { params: { loop: Boolean(j.params.loop) }, inputs: { audio: `asset:${job.outputs[0].asset}` } });
        const r = a.result ?? {};
        row.analysis = { lufs: r.lufs, truePeak: r.truePeak, seconds: r.seconds };
        row.problems = r.problems ?? [];
        row.ok = r.ok;
      }
    } catch (e) {
      row.error = String(e.message ?? e).slice(0, 300);
      if (!done.has(j.key)) done.set(j.key, Promise.resolve(null));
    }
  }));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ stamp, rows }, null, 1));
  fs.writeFileSync(path.join(dir, 'report.html'), renderReport(rows, { stamp }));
  console.log(`Wrote ${path.join(dir, 'report.html')}`);
}

function report() {
  const dir = path.resolve(argv[1] ?? '');
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'report.html'), renderReport(r.rows, { stamp: r.stamp }));
  console.log('rebuilt');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ({ plan, run, report }[cmd] ?? (() => { throw new Error('plan | run --yes | report <dir>'); }))().catch((e) => { console.error(e.message); process.exit(1); });
}
