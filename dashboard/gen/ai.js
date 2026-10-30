// The AI editor (right pane): a conversation about the open project. It sees the timeline, the selection (clips, a
// time range, the playhead, a painted area) and recent media, and answers with edits Gen applies to the project
// (src/editor.ts). Every AI edit is one undo step. Generation over the auto limit waits for a tap. It runs on the
// account's own Claude (Your AI); without one, the pane says how to connect it.

import { $, h, api, toast, fmt, bus, icon, plainError } from './lib.js';
import { P, selectedClips, remember, take, save, docLength, clipLength } from './project.js';
import { state, needSignIn, hasAi, drawAiKeys, loadAi, refreshCredits } from './account.js';

const A = { messages: [], busy: false };
const KEY = (id) => `hg.ai.${id}`;

export function initAi() {
  $('#aiForm').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('#aiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  $('#aiInput').addEventListener('input', () => { const t = $('#aiInput'); t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; });
  bus.on('selection', drawContext);
  bus.on('doc', drawContext);
  bus.on('time', () => { if (!P.selection.clips.size && !P.selection.range) drawContext(); });
  bus.on('project', (p) => { A.messages = load(p.id); drawMessages(); });
  bus.on('ai', drawGate);
  bus.on('signedIn', drawGate);
  bus.on('ready', drawGate);
  drawGate();
  drawContext();
  drawMessages();
}

function load(id) { try { return JSON.parse(localStorage.getItem(KEY(id)) || '[]'); } catch { return []; } }
function keep() { if (!P.id) return; try { localStorage.setItem(KEY(P.id), JSON.stringify(A.messages.slice(-40))); } catch { /* */ } }

/** The selection as the AI gets it, and as the chip shows it. */
export function selectionForAi() {
  const sel = { playhead: Math.round(P.playhead * 100) / 100 };
  const clips = selectedClips();
  if (clips.length) sel.clips = clips.map((c) => c.id);
  if (P.selection.range) sel.range = { start: Math.round(P.selection.range.start * 100) / 100, end: Math.round(P.selection.range.end * 100) / 100 };
  if (P.selection.mask) sel.mask = P.selection.mask;
  return sel;
}
function drawContext() {
  const box = $('#aiContext');
  const clips = selectedClips();
  const parts = [];
  if (clips.length === 1) parts.push(`${clips[0].kind === 'text' ? 'Text' : clips[0].kind === 'audio' ? 'Sound' : clips[0].kind === 'image' ? 'Picture' : 'Clip'}: ${clips[0].label ?? clips[0].text ?? ''}`.slice(0, 48));
  else if (clips.length) parts.push(`${clips.length} clips`);
  if (P.selection.range) parts.push(`${fmt(P.selection.range.start)}–${fmt(P.selection.range.end)}`);
  if (!parts.length) parts.push(`Playhead ${fmt(P.playhead)}`);
  box.replaceChildren(h('span', { class: 'ctx-chip' }, icon('frame'), parts.join(' · ')),
    (clips.length || P.selection.range) ? h('button', { class: 'icon-btn small', title: 'Clear the selection', onclick: () => { P.selection.clips.clear(); P.selection.range = null; bus.emit('selection'); } }, icon('close')) : '');
  drawSuggestions(clips);
}
function drawSuggestions(clips) {
  const s = $('#aiSuggest');
  const one = clips.length === 1 ? clips[0] : null;
  let list;
  if (!P.doc.clips.length) list = ['Make a 15-second trailer about a lighthouse in a storm', 'Make a cozy morning coffee video for social', 'Turn my latest pictures into a slideshow with music'];
  else if (one?.kind === 'video') list = ['Make this slow motion', 'Cut this to the best 2 seconds', 'Continue this shot', 'Make it look like an anime'];
  else if (one?.kind === 'image') list = ['Animate this', 'Make it night time', 'Widen it to 16:9'];
  else if (one?.kind === 'audio') list = ['Lower this under the voice', 'Trim it to the video'];
  else if (P.selection.range) list = ['Delete this part', 'Add a caption here', 'Put a sound effect here'];
  else list = ['Add music that fits', 'Add a voice-over intro', 'Make it vertical for TikTok', 'Tighten the cuts'];
  s.replaceChildren(...list.map((x) => h('button', { type: 'button', class: 'chip', onclick: () => { $('#aiInput').value = x; send(); } }, x)));
}

function drawGate() {
  const gate = $('#aiGate');
  const on = Boolean(state.user) && hasAi();
  gate.hidden = on;
  $('#aiForm').classList.toggle('locked', !on);
  if (on) return;
  if (!state.user) {
    gate.replaceChildren(h('p', {}, 'The AI editor cuts, arranges and generates for you. Tell it what you want.'), h('button', { class: 'primary small', onclick: () => needSignIn(() => {}, 'login') }, 'Sign in'));
    return;
  }
  const keys = h('div', {});
  drawAiKeys(keys);
  gate.replaceChildren(h('p', {}, h('b', {}, 'Connect your AI'), ' to use the AI editor. It runs on your own Claude, so you choose what it costs.'), keys);
}

function drawMessages() {
  const list = $('#aiMessages');
  if (!A.messages.length) {
    list.replaceChildren(h('div', { class: 'ai-hello' }, icon('sparkle', 'ico big'), h('h3', {}, 'What are we making?'),
      h('p', { class: 'muted' }, 'Select clips or drag across the timeline, then ask. "Make this slow motion", "replace the sky with a sunset", "add a punchy voice-over"…')));
    return;
  }
  list.replaceChildren(...A.messages.map(msgEl));
  list.scrollTop = list.scrollHeight;
}
function msgEl(m) {
  if (m.role === 'user') return h('div', { class: 'msg user' }, m.text, m.context ? h('div', { class: 'msg-ctx' }, m.context) : '');
  const el = h('div', { class: `msg ai${m.error ? ' err' : ''}` }, m.text);
  if (m.results?.length) el.append(h('ul', { class: 'msg-ops' }, ...m.results.map((r) => h('li', { class: r.ok ? 'ok' : 'bad' }, r.ok ? '✓ ' : '✗ ', describe(r), r.error ? ` (${r.error})` : ''))));
  if (m.proposed && !m.proposedDone) {
    el.append(h('div', { class: 'proposal' },
      h('div', {}, h('b', {}, `${m.proposed.credits} credits`), ` to make ${m.proposed.ops.length} thing${m.proposed.ops.length === 1 ? '' : 's'}:`),
      h('ul', {}, ...m.proposed.ops.map((o) => h('li', {}, o.label ?? o.params?.prompt ?? o.params?.text ?? o.tool))),
      h('div', { class: 'row' }, h('button', { class: 'primary small', onclick: () => runProposed(m) }, 'Make it'), h('button', { class: 'ghost small', onclick: () => { m.proposedDone = 'skipped'; keep(); drawMessages(); } }, 'Skip'))));
  } else if (m.proposedDone === 'ran') el.append(h('div', { class: 'muted small' }, 'Started.'));
  if (m.undoable) el.append(h('button', { class: 'link small', onclick: () => { bus.emit('undo'); m.undoable = false; keep(); drawMessages(); } }, 'Undo this'));
  return el;
}
const OP_WORDS = { add: 'Added a clip', generate: 'Making', trim: 'Trimmed', split: 'Split', move: 'Moved', delete: 'Deleted a clip', deleteRange: 'Cut a stretch out', set: 'Changed a clip', text: 'Added text', settings: 'Changed the project' };
const describe = (r) => (r.op === 'generate' && r.label ? `Making ${r.label}` : OP_WORDS[r.op] ?? r.op);

async function send() {
  const text = $('#aiInput').value.trim();
  if (!text || A.busy) return;
  if (!state.user) return needSignIn(send, 'login');
  if (!hasAi()) { await loadAi(); if (!hasAi()) return drawGate(); }
  if (!P.id) return toast('Your project is still opening.');
  const ctx = $('#aiContext .ctx-chip')?.textContent ?? '';
  A.messages.push({ role: 'user', text, context: ctx });
  $('#aiInput').value = '';
  $('#aiInput').style.height = 'auto';
  const thinking = { role: 'assistant', text: 'Thinking…', pending: true };
  A.messages.push(thinking);
  drawMessages();
  A.busy = true;
  $('#aiSend').disabled = true;
  try {
    await save();
    const r = await api(`/v1/editor/projects/${P.id}/assistant`, {
      body: { messages: A.messages.filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, text: m.text })), selection: selectionForAi(), doc: P.doc, version: P.version },
    });
    A.messages.pop();
    const changedDoc = r.project.version !== P.version;
    if (changedDoc) { remember(); take(r.project); }
    const results = (r.results ?? []).map((x, i) => ({ ...x, label: labelOf(r, i) }));
    A.messages.push({ role: 'assistant', text: r.say || (results.length ? 'Done.' : 'Okay.'), results, proposed: r.proposed ?? null, undoable: changedDoc });
    if (results.some((x) => x.op === 'generate' && x.ok)) refreshCredits();
  } catch (err) {
    A.messages.pop();
    if (err.status === 402) { await loadAi(); drawGate(); }
    A.messages.push({ role: 'assistant', text: err.status === 402 ? `${plainError(err.message)}` : `I couldn't do that: ${plainError(err.message)}`, error: true });
  } finally {
    A.busy = false;
    $('#aiSend').disabled = false;
    keep();
    drawMessages();
  }
}
function labelOf(r, i) {
  // The answer's ops aren't returned one by one; the generate results line up with the project's new waiting clips.
  const res = r.results?.[i];
  if (res?.op !== 'generate') return null;
  const c = r.project?.doc?.clips?.find((x) => x.id === res.id);
  return c?.label ?? null;
}

async function runProposed(m) {
  try {
    await save();
    const r = await api(`/v1/editor/projects/${P.id}/apply`, { body: { ops: m.proposed.ops.map(({ credits, ...o }) => o) } });
    remember();
    take(r.project);
    m.proposedDone = 'ran';
    m.results = [...(m.results ?? []), ...r.results.map((x) => ({ ...x, label: r.project.doc.clips.find((c) => c.id === x.id)?.label ?? null }))];
    refreshCredits();
  } catch (err) {
    toast(plainError(err.message));
  }
  keep();
  drawMessages();
}

export { docLength, clipLength };
