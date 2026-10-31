// The AI (right pane), for the scene in front (scenes.js): for a video it's the AI editor, a conversation about the
// timeline. It sees the timeline, the selection (clips, a
// time range, the playhead, a painted area) and recent media, and answers with edits Gen applies to the project
// (src/editor.ts). Every AI edit is one undo step. Generation over the auto limit waits for a tap. It runs on Gen's
// house AI (a credit or so a message), or the account's own Claude when it connected one. While the director is open
// (director.js) the same pane is the AI director: it talks about the shot and changes it. Image and audio scenes are
// timelines too, so their AI is the AI editor told which kind it's in. For a character it's the character AI
// (src/sceneai.ts): it changes the sheet and makes what it needs, and asks before spending more than the auto limit.

import { $, h, api, toast, fmt, bus, icon, plainError, friendly } from './lib.js';
import { P, selectedClips, remember, take, save, docLength, clipLength, changed } from './project.js';
import { state, needSignIn, hasAi, drawAiKeys, loadAi, refreshCredits } from './account.js';
import { directorOpen, currentShot, askDirector, directorMessages, keepDirectorMessages, directorSuggestions, directorShotId } from './director.js';
import { activeKind, activeScene, activeEditor } from './scenes.js';
import { pickedMedia, clearPicked } from './media.js';

/** What's picked in Media, added to any AI's selection (J, 2026-10-30: "use this" with a Media tile picked). */
const withMedia = (sel = {}) => { const m = pickedMedia(); return m.length ? { ...sel, media: m } : sel; };
/** The chip that says what's picked in Media, with its ×. */
function mediaChip() {
  const m = pickedMedia();
  if (!m.length) return '';
  const words = m.length === 1 ? `Media: ${m[0].title}`.slice(0, 40) : `${m.length} from Media`;
  return h('span', { class: 'ctx-chip' }, icon('image'), words, h('button', { class: 'icon-btn small', title: 'Unpick them', onclick: () => clearPicked() }, icon('close')));
}

const A = { id: null, messages: [], busy: false, queue: [] };
const KEY = (id) => `hg.ai.${id}`;

export function initAi() {
  $('#aiForm').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('#aiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  $('#aiInput').addEventListener('input', () => { const t = $('#aiInput'); t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; });
  bus.on('selection', drawContext);
  bus.on('mediaPick', drawContext);
  bus.on('doc', drawContext);
  bus.on('time', () => { if (!P.selection.clips.size && !P.selection.range) drawContext(); });
  // A new scene in front brings its own conversation; the same scene taken again (a save, a sync, the AI's own edit)
  // keeps the one on screen, a message in flight included.
  bus.on('project', (p) => { if (A.id === p.id) return; A.id = p.id; A.messages = load(p.id); drawMessages(); });
  bus.on('ai', drawGate);
  bus.on('signedIn', drawGate);
  bus.on('ready', drawGate);
  bus.on('director', () => { drawHead(); drawMessages(); drawContext(); });
  bus.on('directorShot', () => { drawMessages(); drawContext(); });
  bus.on('sceneActive', () => { loadSceneMessages(); drawHead(); drawMessages(); drawContext(); });
  bus.on('sceneTitle', () => { if (other()) drawContext(); });
  drawGate();
  drawContext();
  drawMessages();
}

function load(id) { try { return JSON.parse(localStorage.getItem(KEY(id)) || '[]'); } catch { return []; } }
// The image, audio and character scenes' conversations, one per scene.
const OTHER = new Set(['character']);
const other = () => OTHER.has(activeKind());
const SC = { id: null, messages: [] };
function loadSceneMessages() {
  const t = activeScene();
  if (!t || !OTHER.has(t.kind) || SC.id === t.id) return;
  SC.id = t.id;
  try { SC.messages = JSON.parse(localStorage.getItem(`hg.ai.scene.${t.id}`) || '[]'); } catch { SC.messages = []; }
}
/** The conversation on show: the project's, the open shot's while directing, or the image, audio or character scene's. */
const msgs = () => (directorOpen() ? directorMessages() : other() ? SC.messages : A.messages);
const HEADS = { video: 'AI editor', stage: 'AI director', image: 'Image AI', audio: 'Audio AI', character: 'Character AI' };
function drawHead() { $('.ai-head b').textContent = directorOpen() ? 'AI director' : HEADS[activeKind()] ?? 'AI'; }
function keep() {
  if (directorOpen()) return keepDirectorMessages();
  if (other()) { try { localStorage.setItem(`hg.ai.scene.${SC.id}`, JSON.stringify(SC.messages.slice(-40))); } catch { /* */ } return; }
  if (!P.id) return;
  try { localStorage.setItem(KEY(P.id), JSON.stringify(A.messages.slice(-40))); } catch { /* */ } }

/** The selection as the AI gets it, and as the chip shows it. */
export function selectionForAi() {
  const sel = { playhead: Math.round(P.playhead * 100) / 100 };
  const clips = selectedClips();
  if (clips.length) sel.clips = clips.map((c) => c.id);
  if (P.selection.range) sel.range = { start: Math.round(P.selection.range.start * 100) / 100, end: Math.round(P.selection.range.end * 100) / 100 };
  if (P.selection.mask) sel.mask = P.selection.mask;
  if (P.selection.track) sel.track = P.selection.track;
  return withMedia(sel);
}
const SCENE_TIPS = {
  image: ['Make a moody movie poster of this', 'Relight everything for golden hour', 'Add a bold title at the top', 'Remove the background of this layer'],
  audio: ['Make a calm lo-fi bed under everything', 'Add rain ambience on its own track', 'Duck the music under the voice', 'Write and voice a 10-second intro'],
  character: ['Make them a battle-worn space pilot', 'Make their pictures', 'Give them a voice that fits', 'Make their 3D model'],
};
function drawContext() {
  drawTips();
  const box = $('#aiContext');
  if (other()) {
    const t = activeScene();
    box.replaceChildren(h('span', { class: 'ctx-chip' }, icon(activeEditor()?.icon ?? 'sparkle'), `${t?.title ?? ''}`.slice(0, 48)), mediaChip());
    $('#aiSuggest').replaceChildren(...(SCENE_TIPS[activeKind()] ?? []).map((x) => h('button', { type: 'button', class: 'chip', onclick: () => { $('#aiInput').value = x; send(); } }, x)));
    return;
  }
  if (directorOpen()) {
    const sh = currentShot();
    box.replaceChildren(h('span', { class: 'ctx-chip' }, icon('film'), `Shot: ${sh?.doc.title ?? ''}`.slice(0, 48)), mediaChip());
    $('#aiSuggest').replaceChildren(...directorSuggestions().map((x) => h('button', { type: 'button', class: 'chip', onclick: () => { $('#aiInput').value = x; send(); } }, x)));
    return;
  }
  const clips = selectedClips();
  const parts = [];
  if (clips.length === 1) parts.push(`${clips[0].kind === 'text' ? 'Text' : clips[0].kind === 'audio' ? 'Sound' : clips[0].kind === 'image' ? 'Picture' : 'Clip'}: ${clips[0].label ?? clips[0].text ?? ''}`.slice(0, 48));
  else if (clips.length) parts.push(`${clips.length} clips`);
  if (P.selection.range) parts.push(`${fmt(P.selection.range.start)}–${fmt(P.selection.range.end)}`);
  if (!parts.length) parts.push(`Playhead ${fmt(P.playhead)}`);
  box.replaceChildren(h('span', { class: 'ctx-chip' }, icon('frame'), parts.join(' · ')),
    (clips.length || P.selection.range) ? h('button', { class: 'icon-btn small', title: 'Clear the selection', onclick: () => { P.selection.clips.clear(); P.selection.range = null; bus.emit('selection'); } }, icon('close')) : '',
    mediaChip());
  drawSuggestions(clips);
}
function drawSuggestions(clips) {
  const s = $('#aiSuggest');
  const one = clips.length === 1 ? clips[0] : null;
  let list;
  if (P.kind !== 'video' && !one && !P.selection.range) list = SCENE_TIPS[P.kind];
  else if (!P.doc.clips.length) list = ['Make a 15-second trailer about a lighthouse in a storm', 'Make a 3D model of a treasure chest', 'Make a mossy stone texture with material maps', 'Turn my latest pictures into a slideshow with music'];
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

/** Suggestions are for starting: once a conversation has begun they go away (J, 2026-10-30). */
function drawTips() { $('#aiSuggest').hidden = msgs().some((m) => m.role === 'user'); }

function drawMessages() {
  drawTips();
  const list = $('#aiMessages');
  if (!msgs().length && directorOpen()) {
    list.replaceChildren(h('div', { class: 'ai-hello' }, icon('film', 'ico big'), h('h3', {}, 'What\'s the shot?'),
      h('p', { class: 'muted' }, 'Describe it like a director: who\'s in it, where they are, what happens, how the camera moves. "Two knights face off in the rain, low angle, slow push-in."')));
    return;
  }
  if (!msgs().length && other()) {
    const words = { image: ['What should it look like?', 'Layers, text, light, mood: say it and the AI builds it, using every image tool Gen has.'], audio: ['What should it sound like?', 'Music, voices, effects, the mix: say it and the AI lays it out on the tracks.'], character: ['Who are they?', 'Describe them: the AI writes their look, picks a voice, and makes their pictures and 3D model.'] }[activeKind()];
    list.replaceChildren(h('div', { class: 'ai-hello' }, icon(activeEditor()?.icon ?? 'sparkle', 'ico big'), h('h3', {}, words[0]), h('p', { class: 'muted' }, words[1])));
    return;
  }
  if (!A.messages.length && !directorOpen()) {
    const words = {
      image: ['What should it look like?', 'Layers, text, light, mood: say it and the AI builds it on the tracks, using every image tool Gen has. The frame at the playhead is the picture.'],
      audio: ['What should it sound like?', 'Music, voices, effects, the mix: say it and the AI lays it out on the tracks.'],
    }[P.kind] ?? ['What are we making?', 'Select clips or drag across the timeline, then ask. "Make this slow motion", "replace the sky with a sunset", "add a punchy voice-over"…'];
    list.replaceChildren(h('div', { class: 'ai-hello' }, icon(P.kind === 'audio' ? 'music' : P.kind === 'image' ? 'image' : 'sparkle', 'ico big'), h('h3', {}, words[0]), h('p', { class: 'muted' }, words[1])));
    return;
  }
  list.replaceChildren(...msgs().map(msgEl), ...A.queue.map((t, i) => h('div', { class: 'msg user queued' }, t,
    h('div', { class: 'msg-ctx' }, 'Next, when the AI is free · ', h('button', { class: 'link small', onclick: () => { A.queue.splice(i, 1); drawMessages(); } }, 'Remove')))));
  list.scrollTop = list.scrollHeight;
}
function msgEl(m) {
  if (m.role === 'user') return h('div', { class: 'msg user' }, m.text, m.context ? h('div', { class: 'msg-ctx' }, m.context) : '');
  const el = h('div', { class: `msg ai${m.error ? ' err' : ''}${m.pending ? ' pending' : ''}` }, m.text);
  if (m.results?.length) el.append(h('ul', { class: 'msg-ops' }, ...m.results.map((r) => h('li', { class: r.ok ? 'ok' : 'bad' }, r.ok ? '✓ ' : '✗ ', describe(r), r.error ? ` (${r.error})` : ''))));
  if (m.proposed && !m.proposedDone) {
    const list = m.proposed.ops ?? m.proposed.jobs ?? [];
    el.append(h('div', { class: 'proposal' },
      h('div', {}, h('b', {}, `${m.proposed.credits} credits`), ` to make ${list.length} thing${list.length === 1 ? '' : 's'}:`),
      h('ul', {}, ...list.map((o) => h('li', {}, o.label ?? o.params?.prompt ?? o.params?.text ?? o.tool))),
      h('div', { class: 'row' }, h('button', { class: 'primary small', onclick: () => runProposed(m) }, 'Make it'), h('button', { class: 'ghost small', onclick: () => { m.proposedDone = 'skipped'; keep(); drawMessages(); } }, 'Skip'))));
  } else if (m.proposedDone === 'ran') el.append(h('div', { class: 'muted small' }, 'Started.'));
  if (m.undoable && m.undo) el.append(h('button', { class: 'link small', onclick: () => undoAi(m) }, 'Undo this'));
  return el;
}
const OP_WORDS = { add: 'Added a clip', generate: 'Making', trim: 'Trimmed', split: 'Split', move: 'Moved', delete: 'Deleted a clip', deleteRange: 'Cut a stretch out', set: 'Changed a clip', text: 'Added text', track: 'Changed the tracks', settings: 'Changed the scene' };
const describe = (r) => (r.op === 'generate' && r.label ? `Making ${r.label}` : OP_WORDS[r.op] ?? r.op);

/**
 * Asks the AI from anywhere (the Inspector's suggestions): the words go in and are sent, with the selection as it is;
 * with no words, the box is just focused for the person's own. On a phone the AI sheet comes up to show the answer.
 */
export function askAi(text) {
  const tabs = $('#mobileTabs');
  if (tabs && getComputedStyle(tabs).display !== 'none') $('#mobileTabs button[data-m="ai"]')?.click();
  if ($('#app').classList.contains('no-right')) $('.grip-right')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const box = $('#aiInput');
  box.value = text;
  box.focus();
  if (text) send();
}

/**
 * While the AI is still answering, what the person sends waits its turn (shown in the conversation, the box cleared) and
 * goes as soon as the AI is free: Enter never silently does nothing.
 */
function queueUp(text) {
  A.queue.push(text);
  $('#aiInput').value = '';
  $('#aiInput').style.height = 'auto';
  drawMessages();
}
function next() {
  drawBusy();
  if (A.busy || !A.queue.length) return;
  $('#aiInput').value = A.queue.shift();
  setTimeout(send, 30);
}
/** The send button shows the AI is working (it still takes messages: they queue). */
function drawBusy() {
  const b = $('#aiSend');
  b.classList.toggle('busy', A.busy);
  b.title = A.busy ? 'The AI is answering: what you send now goes next' : 'Send (Enter)';
}

async function send() {
  const text = $('#aiInput').value.trim();
  if (!text) return;
  if (A.busy) return queueUp(text);
  if (!state.user) return needSignIn(send, 'login');
  if (!hasAi()) { await loadAi(); if (!hasAi()) return drawGate(); }
  if (directorOpen()) return sendDirector(text);
  if (other()) return sendScene(text);
  if (!P.id) return toast('Your project is still opening.');
  // The answer belongs to the scene it was asked in (J, 2026-10-30: an answer in another tab took over the preview of
  // the one he was watching). Its conversation and id are held here; if he has moved on by the time it comes back, the
  // change stays in that scene (saved on Gen: its tab shows it when opened) and nothing here is touched.
  const id = P.id;
  const asked = activeScene();
  const list = A.messages;
  const here = () => P.id === id && activeScene()?.id === asked?.id;
  const ctx = $('#aiContext .ctx-chip')?.textContent ?? '';
  list.push({ role: 'user', text, context: ctx });
  $('#aiInput').value = '';
  $('#aiInput').style.height = 'auto';
  const thinking = { role: 'assistant', text: 'Working on it…', pending: true };
  list.push(thinking);
  drawMessages();
  A.busy = true;
  drawBusy();
  try {
    await save();
    // The scene as it was before this turn: "Undo this" puts exactly it back (the editor's own undo stack is cleared when
    // a tab opens again, and steps back one edit at a time; J, 2026-10-30: the chat's Undo didn't undo the AI's changes).
    const before = JSON.stringify(P.doc);
    const r = await api(`/v1/editor/projects/${id}/assistant`, {
      body: { messages: list.filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, text: m.text })), selection: selectionForAi(), doc: P.doc, version: P.version },
    });
    list.splice(list.indexOf(thinking), 1);
    const changedDoc = here() && r.project.version !== P.version;
    if (changedDoc) { remember(); take(r.project); }
    const results = (r.results ?? []).map((x, i) => ({ ...x, label: labelOf(r, i) }));
    // Whether the AI changed the scene (in front or not): then it can be undone from here.
    const changedThere = Boolean(r.project?.doc) && JSON.stringify(r.project.doc) !== before;
    list.push({ role: 'assistant', text: r.say || (results.length ? 'Done.' : 'Okay.'), results, proposed: r.proposed ?? null, ...(changedThere ? { undoable: true, undo: { before, version: r.project.version } } : {}) });
    keepUndos(list);
    if (r.aiCredits || results.some((x) => x.op === 'generate' && x.ok)) refreshCredits();
    if (!here()) answeredElsewhere(asked);
  } catch (err) {
    list.splice(list.indexOf(thinking), 1);
    if (err.status === 402) { await loadAi(); drawGate(); }
    const f = friendly(err);
    list.push({ role: 'assistant', text: f.fix ? f.text : `I couldn't do that: ${f.text}`, error: true });
    if (f.fix === 'credits') import('./media.js').then((m) => m.showError(err));
    // An admin can fix an unavailable AI: Admin > AI takes a key or a Claude login.
    if (f.fix === 'ai' && state.admin) toast('The house AI has no working key or login.', { action: 'Open Admin > AI', onAction: () => open('/admin#ai', '_blank'), ms: 9000 });
    if (!here()) answeredElsewhere(asked);
  } finally {
    A.busy = false;
    setTimeout(next, 0);
    // Kept with the scene it belongs to, wherever the person is now.
    try { localStorage.setItem(KEY(id), JSON.stringify(list.slice(-40))); } catch { /* */ }
    if (here()) keep();
    drawMessages();
  }
}
/** The newest AI changes keep what to go back to (a scene each, so only a few: the browser's storage is small). */
const UNDOS = 3;
function keepUndos(list) {
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m.undo) continue;
    if (++n > UNDOS) { delete m.undo; m.undoable = false; }
  }
}
/** "Undo this": the scene goes back to how it was before that AI turn (one undo step itself, so Ctrl+Z brings it back). */
function undoAi(m) {
  if (!m.undo || !P.id) return;
  // Edited since (by hand, the AI again, or another tab): going back undoes those too, so ask.
  if (P.version !== m.undo.version && !confirm('Undo what the AI did here? Changes made after it will be undone too.')) return;
  remember();
  P.doc = JSON.parse(m.undo.before);
  changed();
  delete m.undo;
  m.undoable = false;
  keep();
  drawMessages();
  toast('Undone. Ctrl+Z brings it back.');
}
/** An answer came back for a scene that isn't in front any more: say so, with a way there (nothing here changes). */
function answeredElsewhere(scene) {
  toast(`The AI answered in "${scene?.title ?? 'another scene'}".`, { action: 'Open it', onAction: () => import('./scenes.js').then((s) => s.openScene(scene.id)), ms: 8000 });
}
/** A turn with the AI director: the conversation about the open shot; the answer is the changed shot. */
async function sendDirector(text) {
  // Held with its shot: the answer goes to this shot's conversation even if another tab is in front by then.
  const list = directorMessages();
  const id = directorShotId();
  const asked = activeScene();
  list.push({ role: 'user', text });
  $('#aiInput').value = '';
  $('#aiInput').style.height = 'auto';
  const thinking = { role: 'assistant', text: 'Blocking the shot…', pending: true };
  list.push(thinking);
  drawMessages();
  A.busy = true;
  drawBusy();
  try {
    const r = await askDirector(list.filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, text: m.text })), withMedia());
    list.splice(list.indexOf(thinking), 1);
    list.push({ role: 'assistant', text: r.say || 'Done.' });
    if (!r.here) answeredElsewhere(asked);
  } catch (err) {
    list.splice(list.indexOf(thinking), 1);
    list.push({ role: 'assistant', text: `I couldn't do that: ${plainError(err.message)}`, error: true });
    if (directorShotId() !== id) answeredElsewhere(asked);
  } finally {
    A.busy = false;
    setTimeout(next, 0);
    keepDirectorMessages(id, list);
    drawMessages();
  }
}
/** A turn with an image, audio or character scene's AI: the answer is the changed scene, and jobs started (or proposed). */
async function sendScene(text) {
  const t = activeScene();
  const ed = activeEditor();
  if (!t || !ed) return;
  // Held with its scene: the answer is applied only while that scene is in front (else it stays saved on Gen).
  const list = SC.messages;
  const here = () => activeScene()?.id === t.id;
  list.push({ role: 'user', text });
  $('#aiInput').value = '';
  $('#aiInput').style.height = 'auto';
  const thinking = { role: 'assistant', text: 'Thinking…', pending: true };
  list.push(thinking);
  drawMessages();
  A.busy = true;
  drawBusy();
  try {
    await ed.save?.();
    const r = await api(`/v1/scenes/${t.id}/assistant`, { body: { messages: list.filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, text: m.text })), selection: withMedia(ed.ai?.selection?.() ?? {}) } });
    list.splice(list.indexOf(thinking), 1);
    if (here()) ed.take?.(r.scene);
    const results = [...(r.started ?? []).map((x) => ({ op: 'generate', ok: true, label: x.tool })), ...(r.errors ?? []).map((e) => ({ op: 'generate', ok: false, error: e }))];
    list.push({ role: 'assistant', text: r.say || 'Done.', results, proposed: r.proposed ?? null, scene: t.id });
    if (r.aiCredits || r.started?.length) refreshCredits();
    if (!here()) answeredElsewhere(t);
  } catch (err) {
    list.splice(list.indexOf(thinking), 1);
    list.push({ role: 'assistant', text: `I couldn't do that: ${plainError(err.message)}`, error: true });
    if (!here()) answeredElsewhere(t);
  } finally {
    A.busy = false;
    setTimeout(next, 0);
    try { localStorage.setItem(`hg.ai.scene.${t.id}`, JSON.stringify(list.slice(-40))); } catch { /* */ }
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
  if (m.proposed?.jobs) {
    // An image, audio or character scene's proposal: the scene as the AI left it, and its jobs, now confirmed.
    try {
      const r = await api(`/v1/scenes/${m.scene}/apply`, { body: { doc: m.proposed.doc, jobs: m.proposed.jobs } });
      if (activeScene()?.id === m.scene) activeEditor()?.take?.(r.scene);
      m.proposedDone = 'ran';
      refreshCredits();
    } catch (err) { toast(plainError(err.message)); }
    keep();
    drawMessages();
    return;
  }
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
