// Hawkes Studio's playtest bot for the app (J, 2026-10-30: Studio plays Gen's app as a project; spec:
// hawkesstudio/docs/playtest.md). It plays through real input (keys and clicks, like a person) and spends no GPU: on
// Studio's beta playtests it's signed in as the project's test account (src/testsignin.ts).
//   smoke    the page opens; signed in, a new video scene, text added with T, played with Space, then removed
//   media    the Media pane lists the library and a tile can be picked (the AI's chip shows it)
//   signedout what someone who isn't signed in sees: the welcome, Sign in with Google, no /v1 probe without hg.in
//   playback two or three of the library's clips cut together, played through the cuts and scrubbed back over them:
//            how often and how long the clock waited for data, seeks while playing, frames with no picture
//   create   one form from each Create group (images, video, 3D, animation, audio, chains): fields, price and Make button; Make is never pressed
//   account  credits pill, account sheet with packs and plans, Help menu, shortcuts overlay, Terms and Privacy
//   export   a short plain cut from the library's clips, exported: the file loads and plays
//            (create, account, export: option {"broken":true} sabotages what they look at, and each must then report a problem)
//   panels   AI and Media panes at desktop sizes: the prompt box is fully visible, signed-out Sign in never overlaps the
//            suggestion chips, and long media / chip lists scroll inside their panels instead of being cut off
//   ai-edit, ai-undo, ai-proposal, ai-nocredits, ai-signedout, ai-outage: the AI pane (docs/ai-mock.md). The test account's canned
//            answers (POST /v1/test/ai-mock, a named setup shortcut) stand in for Claude, so no house AI is spent; the message is typed
//            with key events into #aiInput, and nothing here ever presses Make it on a proposal (that would be GPU money)
//   stage    the Director: a stage scene, a character cast, a prop added, camera keyed at two moments, scrubbed and played; the 3D view draws and the console stays clean
//   character a character sheet: look, voice, pictures by role and 3D model sections draw; nothing is generated
//   world    Start a world (canned AI answer): the sheet opens, the first proposal cards show, the pictures' price is known; Make this world is never pressed
//   scenes   a new scene of each kind from the + menu, renamed, reordered, duplicated and deleted
//   media-upload a small picture is uploaded by the Media pane's file input and shows as a tile and in its details (Media has no delete)
//            (stage, character, world, scenes, media-upload: free, no paid job; every one watches the jobs it could start)
//   phoneperf phone size (390x844, touch; Studio slows the CPU 4x): how long a project takes to become usable, a 3-clip
//            timeline played 20 s (fps, p5), and how long a scrub takes to show the new frame (metrics openMs, p5fps, scrubMs)
//   playback4 a 4-track timeline (video, picture or color, words, sound) played for 30 s, then seeked while playing:
//            fps and its 5th percentile (p5), the slowest frame, and how long each seek took to get the playhead moving
//   transitions adjacent clips on the main track: add a crossfade from the join, resize by dragging its edge, change
//            type from the menu (touch-sized targets), scrub the blend in the preview, and export so the cut is shorter
//            by the transition length (same moment as the preview)
//   audio-mix music + voice on the timeline: waveforms drawn, fade handle dragged, auto-duck ~10 dB under the line
//            (preview maths + offline mixdown loudness); no GPU
import { installPlaytest } from './playtest/hawkes-playtest.js';
import { state, loadMe } from './account.js';
import { P, addClip, setClip, mainTrack, docLength, addTrack, tracks, trackOf, clipEnd, clipLength } from './project.js';
import { snapStats } from './timeline.js';
import { isPlaying, seek, playbackStats, resetPlaybackStats, pacingStats, transitionAt, mixdown, clipGain, duckAt } from './player.js';
import { activeScene, newScene, sceneList, loadList } from './scenes.js';
import { currentShot } from './director.js';
import { startGuide, guideOpen } from './guide.js';
import { api, bus, peaks } from './lib.js';
import { openStream } from './stream.js';
import { runJob, uploadFiles } from './media.js';
import { streamState } from './trouble.js';
import { show as showLanding, hide as hideLanding } from './landing.js';
import { DUCK_TO, dialogueSpans, composeAudioPlan } from './audio-mix.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A key press on the page, as the keyboard sends it (the app's shortcuts listen on window). */
function press(key, { shiftKey = false, ctrlKey = false } = {}) {
  const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key;
  for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { key, code, shiftKey, ctrlKey, bubbles: true, cancelable: true }));
}
/** A key press on one element (a focused tile or the drawer hear their own keys; it bubbles up to window like a real one). */
function pressOn(el, key) {
  for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
}
/** Waits for a condition, up to `ms`. */
async function until(fn, ms = 15000, step = 200) {
  const end = performance.now() + ms;
  while (performance.now() < end) { try { if (fn()) return true; } catch { /* not yet */ } await sleep(step); }
  return false;
}
const click = (sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; };


/** Every job a scenario submits (POST /v1/jobs, /v1/run), so a scenario can say none started, or only the CPU render of an export. */
function watchJobs() {
  const sent = [];
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = (init?.method ?? (typeof input === 'object' ? input.method : 'GET') ?? 'GET').toUpperCase();
      if (method === 'POST' && /^\/v1\/(jobs|run)\b/.test(url.pathname)) {
        let tool = '';
        try { tool = JSON.parse(init?.body ?? '{}').tool ?? ''; } catch { /* not JSON */ }
        sent.push(tool || url.pathname);
      }
    } catch { /* never block a call */ }
    return real(input, init);
  };
  return { sent, stop: () => { window.fetch = real; } };
}
const visibleEl = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]'); };
/** What a Create form must show: fields to fill, a price and a Make button. Returns what's missing. */
function formFaults(form) {
  const out = [];
  if (!form?.querySelector) return ['no form'];
  if (!form.querySelector('textarea, input:not([type=checkbox]):not([type=hidden]), select, .slot, [data-slot], .pick')) out.push('no fields');
  const q = form.querySelector('.gen-foot .quote');
  if (!q || !/credit|free/i.test(q.textContent)) out.push(`no price (${q ? `"${q.textContent.trim()}"` : 'none'})`);
  const go = form.querySelector('.gen-foot .primary');
  if (!go || !go.textContent.trim()) out.push('no Make button');
  return out;
}


/** Types into #aiInput one key at a time (keydown, input, keyup), then Enter: the way a person sends a message. */
async function typeAi(text) {
  const box = document.querySelector('#aiInput');
  box.focus();
  box.value = '';
  for (const ch of text) {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    box.value += ch;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    await sleep(8);
  }
  pressOn(box, 'Enter');
}
/** Setup shortcut (named): the test account's canned AI answers, replacing any left over. Null when the mock is off here. */
async function mockAi(answers) {
  await api('/v1/test/ai-mock', { method: 'DELETE' }).catch(() => {});
  const q = await api('/v1/test/ai-mock', { method: 'POST', body: { answers } }).catch(() => null);
  return q?.queued ? q : null;
}
/** Setup shortcut (named): a fresh video scene for the AI to work in. */
async function aiScene(title) {
  await until(() => activeScene(), 10000);
  made = await newScene('video', { title: `${title} ${new Date().toISOString().slice(0, 16)}` });
  return until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000);
}
/** Setup shortcut (named): the AI turn's call (POST /v1/showrunner/turn) answers the way Gen does in a bad moment; everything else is real. */
function forceTurn(answer) {
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname === '/v1/showrunner/turn') return Promise.resolve(answer());
    return real(input, init);
  };
  return () => { window.fetch = real; };
}
const lastAi = () => [...document.querySelectorAll('#aiMessages .msg.ai:not(.pending)')].pop();
const aiIdle = () => !document.querySelector('#aiSend')?.classList.contains('busy') && !document.querySelector('#aiMessages .msg.pending');
/** What nothing on screen may show: JSON, a trace, a key, a stray "undefined". */
const RAW_AI = /[{}<>]|"error"|Traceback|File "|\bat \S+:\d+|hg_[0-9a-f]{6}|sk-ant|hgm_|undefined|\[object/;
const TITLE_OP = (text) => ({ op: 'add', track: 'T1', kind: 'text', text, start: 0, duration: 3 });


/** Everything the console and the window say went wrong while a scenario plays (console.error, uncaught errors, rejected promises). */
function watchConsole() {
  const errors = [];
  const real = console.error;
  const text = (a) => a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ').slice(0, 220);
  console.error = (...a) => { errors.push(text(a)); real.apply(console, a); };
  const onErr = (e) => errors.push(e.message || 'error');
  const onRej = (e) => errors.push(`unhandled: ${e.reason?.message ?? e.reason}`);
  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onRej);
  return { errors, stop: () => { console.error = real; window.removeEventListener('error', onErr); window.removeEventListener('unhandledrejection', onRej); } };
}
/** Types into any field one key at a time (keydown, input, keyup): the way a person fills it in. */
async function typeInto(box, text) {
  box.focus();
  box.value = '';
  for (const ch of text) {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    box.value += ch;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    await sleep(6);
  }
}
/** The first element under `root` that matches `sel` and whose words match `re`. */
const withText = (root, sel, re) => [...(root ?? document).querySelectorAll(sel)].find((el) => re.test(el.textContent));
/** The "+" menu's blank-scene row for a kind (the starters above it are skipped). */
const blankRow = (label) => [...document.querySelectorAll('.menu .menu-item')].find((b) => !b.closest('.menu-starters') && b.querySelector('b')?.textContent === label);
/** Scenes this run made (all but the ones the bot opens through `made`), taken away again when it stops. */
const extra = [];
/** Setup shortcut (named): a confirm() that says yes, for Delete (a person would press OK). Returns the way back. */
function confirmYes(log) {
  const real = window.confirm;
  window.confirm = (msg) => { log?.push(String(msg)); return true; };
  return () => { window.confirm = real; };
}

let made = null;
installPlaytest({
  product: 'hawkesgen-app',
  scenarios: [
    { id: 'smoke', title: 'Open the app, make a scene, add text, play it', seconds: 60, tags: ['smoke'] },
    { id: 'media', title: 'The Media pane lists the library and picks a tile for the AI', seconds: 40 },
    { id: 'signedout', title: 'Someone not signed in sees what Gen does, a Sign in with Google button and examples, with no /v1 call (the session probe is skipped when hg.in is unset)', seconds: 30 },
    { id: 'first-paint', title: 'First paint, signed out (desktop and 390x844): at 0.5, 1, 2 and 3 s after navigation no media panel, timeline or AI panel is visible, only the landing page; no console error or failed request; the hero buttons\' labels are centred', seconds: 20, tags: ['mobile'] },
    { id: 'createprice', title: 'Every Create form shows its credit price when opened, and it changes when an option that changes the cost changes', seconds: 120 },
    { id: 'guide', title: 'The guided first project: pick an idea, a picture, the timeline, play, and dismiss it', seconds: 90 },
    { id: 'playback4', title: 'A 4-track timeline plays 30 s smoothly (p5 fps) and playback resumes fast after a seek', seconds: 120 },
    { id: 'phoneperf', title: 'Phone speed (390x844, touch, CPU slowed 4x): the editor is usable within 5 s of opening a project, a 3-clip timeline plays 20 s with p5 fps above 30, and a scrub shows the new frame within 200 ms', seconds: 120, tags: ['mobile'] },
    { id: 'progress', title: 'A job that fails shows its plain cause and Retry; Retry shows the estimate and Stop while it runs', seconds: 90 },
    { id: 'savebadge', title: 'The save badge says Saving, then Saved with the time; with the network off an edit shows Offline - changes kept, and after going online and reloading the edit is still there', seconds: 90 },
    { id: 'editing', title: 'Timeline editing: clips snap to neighbours and the playhead, ? shows the shortcuts, undo and redo move, trim and delete', seconds: 90 },
    { id: 'audio-mix', title: 'Audio mix: waveforms on clips, fade-in handle, auto-duck ~10 dB under a voice line in preview and mixdown', seconds: 150 },
    { id: 'transitions', title: 'Clip transitions: add a crossfade at a join, resize and change type by touch, see the blend in the preview, export matches the join', seconds: 150, tags: ['mobile'] },
    { id: 'library', title: 'Library: thumbnails, video plays on hover, filter by image, video, audio and 3D, open an asset to see its prompt and Use in timeline', seconds: 90 },
    { id: 'trouble', title: 'Offline, a dropped stream, 401, 402, 429 and 503 each say one plain sentence and a next step on Create, the library, the timeline and the AI pane, with no raw JSON, trace or key', seconds: 150 },
    { id: 'aimock', title: 'The AI editor answers from a canned answer (test account only): a title appears from a typed message, with no Claude call', seconds: 60 },
    { id: 'aibusy', title: 'An AI turn that has to wait for a free slot shows its place in line, and gives up after the bound with one plain sentence (test account, AI mock)', seconds: 120 },
    { id: 'signupcap', title: 'Starter credits are capped: health counts signups and refused grants, and the limits are shown; this account sees its balance', seconds: 30 },
    { id: 'mockproviders', title: 'Mock providers: health says whether providers are stand-ins and shows $0 real cost; a mock job finishes at once (beta/local only)', seconds: 60 },
    { id: 'phone', title: 'Phone (390x844, touch): the five bottom tabs and the timeline stay on screen, no page zoom; every screen has no horizontal scroll, primary buttons fully on screen, controls at least 44 px; a deliberately overflowing element is reported', seconds: 120, tags: ['mobile'] },
    { id: 'eventstreams', title: 'Live streams: four tabs open on one account, the oldest is closed with a bye and opens again by itself, and all jobs still reach the page', seconds: 90 },
    { id: 'create', title: 'Create: one tool form from each group (images, video, 3D, animation, audio, chains) shows its fields, its price and a Make button; Make is never pressed and no job starts', seconds: 90 },
    { id: 'checkout', title: 'Buying credits: the packs (and the test-mode card note on beta), one tap opens checkout while the others wait, a failed start says one plain line and frees the packs, and coming back paid, processing, declined or cancelled each says so (paid: the new balance on the pill and a Receipt); on a phone each pack is one row at least 44 px tall with no sideways scroll. Stripe is never called', seconds: 60, tags: ['mobile'] },
    { id: 'account', title: 'Account: the credits pill opens the sheet with packs and plans, the Help menu and the shortcuts overlay open, Terms and Privacy are there; no job starts', seconds: 60 },
    { id: 'export', title: 'Export: a short plain cut of the library\'s clips is exported and the file loads and plays; only the cut\'s own CPU render runs', seconds: 150 },
    { id: 'timeline-resize', title: 'Drag the timeline\'s top edge to resize it (kept in this browser, 120px to 70% of the window); under 1100px wide the side panels are Media and AI buttons', seconds: 45 },
    { id: 'panels', title: 'Side panels at 1280x720-class desktop: AI prompt fully visible, Sign in and chips never overlap, Media and chip lists scroll inside their panes', seconds: 60 },
    { id: 'ai-edit', title: 'AI pane: "add a title that says Hello" adds a text clip, the reply lists it, and credits drop by at least 1 (canned answer, no Claude)', seconds: 60 },
    { id: 'ai-undo', title: 'AI pane: after a multi-op edit a toast offers Undo, Ctrl+Z (or Undo) puts the timeline back, Redo brings the AI change back, and the Undo button is labelled', seconds: 90 },
    { id: 'ai-proposal', title: 'AI pane: an answer over 40 credits shows a proposal card with its price, and nothing starts (Make it is never pressed)', seconds: 60 },
    { id: 'ai-nocredits', title: 'AI pane: with no credits left the answer is a plain 402 line with Add credits, and the timeline is unchanged', seconds: 60 },
    { id: 'ai-signedout', title: 'AI pane signed out: the sign-in gate shows, a typed message opens Sign in and nothing is sent', seconds: 40 },
    { id: 'ai-outage', title: 'AI pane in an outage: 503, 429, an unreadable page and a garbled answer each show one plain line (no JSON, trace or key) and the pane unlocks', seconds: 90 },
    { id: 'stage', title: 'Stage: open the Director, cast a character, add a prop, key the camera at two moments and scrub; the 3D view draws, the console has no errors and no job starts', seconds: 90 },
    { id: 'character', title: 'Character: the sheet shows their look, voice, pictures by role and 3D model sections; nothing is generated and no job starts', seconds: 60 },
    { id: 'world', title: 'World: Start a world (canned AI answer) opens its sheet and reaches the first proposal cards with the pictures\' price known; Make this world is never pressed and no job starts', seconds: 60 },
    { id: 'scenes', title: 'Scenes: a new scene of each kind from the + menu is renamed, reordered, duplicated and deleted; no job starts', seconds: 150 },
    { id: 'media-upload', title: 'Media: a small picture is uploaded with the file button and shows as a tile and in its details; no job starts but the CPU conversion, if any', seconds: 60 },
    { id: 'uploads', title: 'Uploads: three big files go up together with a percentage each and the server stays up; a fourth at once is refused with a plain "uploads at once" message; options {"mb":500}', seconds: 240 },
    { id: 'playback', title: 'Clips cut together play through the cuts and scrub back without hitching', seconds: 90 },
  ],
  // Ready once the account is known (signed in or not) and the app has drawn.
  isReady: () => Boolean(document.querySelector('#app')) && performance.now() > 1500,
  async start(id, options, t) {
    // The account is known once it's there, or the welcome for someone not signed in is.
    await until(() => state.user || document.querySelector('#landing:not([hidden])'), 10000);
    t.metric('signedIn', state.user ? 1 : 0);
    if (id === 'first-paint') {
      t.scene('First paint');
      const errors = watchConsole();
      // Setup shortcut (named): a signed-in test tab looks signed out (the session itself is untouched).
      try { localStorage.removeItem('hg.in'); } catch { /* */ }
      const was = state.user;
      if (was) { state.user = null; showLanding(); }
      const seen = (el) => Boolean(el) && el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false && (() => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })();
      const CHROME = { media: '#leftPane', mediaGrid: '#mediaGrid', timeline: '#timelinePane', ai: '#rightPane' };
      let leaked = 0;
      for (const at of [0.5, 1, 2, 3]) {
        const wait = at * 1000 - performance.now();
        if (wait > 0) await sleep(wait);
        const now = performance.now() / 1000;
        const rows = Object.entries(CHROME).map(([k, sel]) => { const el = document.querySelector(sel); return { k, inDom: Boolean(el), visible: seen(el) }; });
        const shown = rows.filter((r) => r.visible).map((r) => r.k);
        const L = document.querySelector('#landing');
        const landing = Boolean(L) && !L.hidden && seen(L);
        leaked += shown.length;
        t.metric(`editorVisible_${at}s`, shown.length);
        t.metric(`landingVisible_${at}s`, landing ? 1 : 0);
        t.log(`${at}s (read at ${now.toFixed(2)}s): ${rows.map((r) => `${r.k} ${r.inDom ? (r.visible ? 'VISIBLE' : 'hidden') : 'absent'}`).join(', ')}; landing ${landing ? 'shown' : 'NOT shown'}`);
        t.event(`first-paint-${at}s`, shown.length ? `editor visible: ${shown.join(', ')}` : 'landing only');
        if (shown.length) t.problem('bug', `at ${at}s a signed-out visitor sees the editor (${shown.join(', ')})`);
        if (!landing) t.problem('bug', `at ${at}s the landing page is not showing`);
      }
      const failed = performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400).map((e) => `${e.responseStatus} ${new URL(e.name, location.href).pathname}`);
      t.metric('failedRequests', failed.length);
      for (const f of failed) t.problem('bug', `failed request: ${f}`);
      // Each hero button's label (the text's box) against the button's box.
      const worst = [];
      for (const b of document.querySelectorAll('#landing .ld-hero button')) {
        const r = b.getBoundingClientRect();
        if (!r.width || !seen(b)) continue;
        const range = document.createRange();
        range.selectNodeContents(b);
        const q = range.getBoundingClientRect();
        const off = Math.abs((q.left + q.width / 2) - (r.left + r.width / 2));
        worst.push(off);
        t.log(`hero button "${b.textContent.trim().slice(0, 30)}": label off centre by ${off.toFixed(1)} px`);
        if (off > 2 && !b.classList.contains('link')) t.problem('bug', `hero button "${b.textContent.trim()}" label is ${off.toFixed(1)} px off centre`);
      }
      t.metric('heroButtons', worst.length);
      t.metric('labelOffCentrePx', worst.length ? Math.round(Math.max(...worst) * 10) / 10 : 0);
      errors.stop();
      t.metric('consoleErrors', errors.errors.length);
      for (const e of errors.errors) t.problem('bug', `console error: ${e}`);
      if (was) { state.user = was; hideLanding(); }
      t.finish(leaked || errors.errors.length || failed.length ? 'lost' : 'done');
      return;
    }
    if (id === 'signedout') {
      t.scene('Welcome');
      // Setup shortcut (named): clear the session hint and show the welcome so a test-account tab still plays the
      // anonymous landing path (the real cookie is untouched; Sign in from the landing still works afterwards).
      try { localStorage.removeItem('hg.in'); } catch { /* */ }
      const was = state.user;
      if (was) state.user = null;
      showLanding();
      const welcome = await until(() => document.querySelector('#landing:not([hidden]), .landing:not([hidden])'), 8000);
      t.metric('welcome', welcome ? 1 : 0);
      if (welcome) {
        const L = document.querySelector('#landing');
        t.metric('signInWithGoogle', /Sign in with Google/.test(L.textContent) ? 1 : 0);
        t.metric('examples', L.querySelectorAll('.ld-ex').length);
        // A first visit (no test session) must not have probed /v1/users/me at boot.
        if (!was) {
          const me = window.__hgMe ? await window.__hgMe : null;
          t.metric('meProbedAtBoot', me ? 1 : 0);
          if (me) t.problem('bug', 'signed-out first visit probed /v1/users/me (expected skip when hg.in is unset)');
          if (me && me.status === 401) t.problem('bug', 'signed-out load: /v1/users/me answered 401 (a console error)');
          const v1 = performance.getEntriesByType('resource').map((e) => new URL(e.name, location.href).pathname).filter((p) => p.startsWith('/v1/'));
          t.metric('v1CallsSignedOut', v1.length);
          for (const p of v1) t.problem('bug', `signed-out load called ${p}`);
        }
        // Prove the skip on this tab too: with hg.in cleared, loadMe must not fetch any /v1 route.
        const probed = [];
        const real = window.fetch.bind(window);
        window.fetch = (input, init) => {
          try {
            const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
            if (path.startsWith('/v1/')) probed.push(path);
          } catch { /* */ }
          return real(input, init);
        };
        window.__hgMe = null;
        await loadMe();
        window.fetch = real;
        t.metric('meProbed', probed.includes('/v1/users/me') ? 1 : 0);
        t.metric('v1DuringSkipLoad', probed.length);
        if (probed.length) for (const p of probed) t.problem('bug', `signed-out loadMe called ${p}`);
        else t.event('session-probe-skipped');
        // Labels centred in their buttons, and the "Look around first" link on the text's left margin.
        const btns = [...L.querySelectorAll('.ld-hero .ld-cta button, .ld-nav .ld-signin')].filter((x) => x.offsetWidth);
        const off = btns.map((x) => { const r = document.createRange(); r.selectNodeContents(x); const a = r.getBoundingClientRect(), c = x.getBoundingClientRect(); return Math.abs((a.left + a.right) / 2 - (c.left + c.right) / 2); });
        t.metric('buttonLabelOffCentrePx', Math.round(Math.max(0, ...off)));
        const look = L.querySelector('.ld-look'), sub = L.querySelector('.ld-sub');
        if (look && sub) t.metric('lookLinkOffsetPx', Math.round(Math.abs(look.getBoundingClientRect().left - sub.getBoundingClientRect().left)));
        // Sign in from the landing opens the sheet (Google completes the rest; playtests can't finish OAuth).
        const signIn = L.querySelector('.ld-hero .ld-google, .ld-nav .ld-signin, button.ld-google');
        t.metric('signInReady', signIn ? 1 : 0);
        if (!signIn) t.problem('bug', 'landing has no Sign in with Google control');
        else {
          signIn.click();
          const dlg = await until(() => document.querySelector('#authDialog')?.open, 4000, 100);
          t.metric('signInSheet', dlg ? 1 : 0);
          t.event(dlg ? 'sign-in-opened' : 'sign-in-missing');
          if (!dlg) t.problem('bug', 'Sign in from the landing did not open the sign-in sheet');
          else document.querySelector('#authDialog')?.close?.();
        }
        t.event('welcome-checked');
      }
      if (was) { state.user = was; hideLanding(); }
      t.finish(welcome ? 'done' : 'stuck');
      return;
    }
    if (id === 'timeline-resize') {
      t.scene('Timeline size');
      hideLanding();
      // Setup shortcut (named): forget a saved size so the default applies.
      try { localStorage.removeItem('hg.--tl'); } catch { /* */ }
      const app = document.querySelector('#app');
      app.style.removeProperty('--tl');
      await sleep(80);
      const pane = document.querySelector('#timelinePane');
      const grip = pane?.querySelector('.grip-tl');
      const H = () => Math.round(pane.getBoundingClientRect().height);
      const drag = async (dy) => {
        const r = grip.getBoundingClientRect();
        const x = r.left + r.width / 2, y0 = r.top + r.height / 2;
        const ev = (type, y) => (type === 'pointerdown' ? grip : window).dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 7, pointerType: 'touch', bubbles: true, cancelable: true }));
        ev('pointerdown', y0);
        for (let i = 1; i <= 12; i++) { ev('pointermove', y0 + (dy * i) / 12); await sleep(30); }
        ev('pointerup', y0 + dy);
        await sleep(80);
      };
      if (!grip) { t.problem('bug', 'the timeline has no drag handle on its top edge'); t.finish('stuck'); return; }
      t.metric('viewportH', window.innerHeight); t.metric('defaultTimelinePx', H()); t.metric('areaAbovePx', window.innerHeight - H());
      if (window.innerHeight >= 700 && window.innerHeight - H() < 440) t.problem('bug', 'the default timeline leaves under ~450px above it');
      const h0 = H();
      await drag(-120);
      const h1 = H();
      t.metric('afterDragUpPx', h1); t.event(h1 > h0 + 60 ? 'timeline-taller' : 'timeline-did-not-grow');
      if (h1 <= h0 + 60) t.problem('bug', 'dragging the timeline edge up did not make it taller');
      await drag(2000 * -1);
      const hMax = H();
      t.metric('maxTimelinePx', hMax);
      if (hMax > window.innerHeight * 0.7 + 2) t.problem('bug', 'the timeline grew past 70% of the window');
      await drag(3000);
      const hMin = H();
      t.metric('minTimelinePx', hMin);
      await drag(-150);
      let saved = null; try { saved = localStorage.getItem('hg.--tl'); } catch { /* */ }
      t.metric('savedPx', Number(saved) || 0);
      if (!saved) t.problem('bug', 'the timeline size is not kept in this browser');
      else t.event('timeline-size-kept');
      const wide = matchMedia('(min-width: 901px) and (max-width: 1100px)').matches;
      t.metric('drawerWidth', wide ? 1 : 0);
      const tog = document.querySelector('#drawerLeft');
      if (wide) {
        const shown = getComputedStyle(tog).display !== 'none';
        const panesHidden = getComputedStyle(document.querySelector('#leftPane')).display === 'none';
        if (!shown || !panesHidden) t.problem('bug', 'under 1100px the side panels should fold behind the Media and AI buttons');
        click('#drawerLeft'); await sleep(150);
        const open = getComputedStyle(document.querySelector('#leftPane')).display !== 'none';
        t.event(open ? 'drawer-opened' : 'drawer-did-not-open');
        if (!open) t.problem('bug', 'the Media button did not open the side panel');
        click('#drawerLeft'); await sleep(100);
      } else t.note('Window is not 901-1100px wide: the drawer check was skipped');
      t.finish('done');
      return;
    }
    if (id === 'panels') {
      t.scene('Side panels');
      hideLanding();
      // Setup shortcut (named): clear a saved tall timeline so the default (≤216px / 30dvh) applies, leaving ~450px for the panes.
      try {
        localStorage.removeItem('hg.--tl');
        localStorage.removeItem('hg.tl-small');
      } catch { /* */ }
      const app = document.querySelector('#app');
      app?.classList.remove('tl-small', 'no-left', 'no-right');
      app?.style.removeProperty('--tl');
      app?.style.removeProperty('--tl-now');
      await sleep(80);
      if (!activeScene()) {
        made = await newScene('video', { title: `Playtest panels ${new Date().toISOString().slice(0, 16)}` });
        if (!await until(() => activeScene()?.id === made?.id, 15000)) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      }
      click('#paneTabs [data-pane="media"]');
      await sleep(200);
      const H = () => window.innerHeight;
      const W = () => window.innerWidth;
      t.metric('viewportW', W());
      t.metric('viewportH', H());
      const fullyIn = (el, within) => {
        if (!el || el.hidden || el.closest('[hidden]')) return false;
        const r = el.getBoundingClientRect();
        const b = (within || document.documentElement).getBoundingClientRect?.() ?? { top: 0, left: 0, right: W(), bottom: H() };
        const box = within ? b : { top: 0, left: 0, right: W(), bottom: H() };
        return r.width > 1 && r.height > 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1;
      };
      const overlap = (a, b) => {
        const r = a.getBoundingClientRect(), q = b.getBoundingClientRect();
        return r.left < q.right - 1 && r.right > q.left + 1 && r.top < q.bottom - 1 && r.bottom > q.top + 1;
      };
      const right = document.querySelector('#rightPane');
      const input = document.querySelector('#aiInput');
      const form = document.querySelector('#aiForm');
      const promptOk = fullyIn(input, right) && fullyIn(form, right);
      t.metric('promptFullyVisible', promptOk ? 1 : 0);
      t.metric('paneAbovePx', Math.round(right?.getBoundingClientRect().height ?? 0));
      t.metric('timelinePx', Math.round(document.querySelector('#timelinePane')?.getBoundingClientRect().height ?? 0));
      if (!promptOk) t.problem('bug', 'AI prompt box is not fully visible in the AI panel');
      else t.event('prompt-visible');
      // Signed-out: Sign in above chips, no overlap, both fully on screen in the pane.
      const me = state.user;
      state.user = null;
      // Setup shortcut (named): mark "looked around" so ready does not cover the editor with the landing.
      try { sessionStorage.setItem('hg.landing.looked', '1'); } catch { /* */ }
      hideLanding();
      bus.emit('ready');
      await sleep(150);
      const gate = document.querySelector('#aiGate');
      const suggest = document.querySelector('#aiSuggest');
      const signBtn = gate?.querySelector('button');
      const chips = [...(suggest?.querySelectorAll('.chip') ?? [])];
      const gateShown = gate && !gate.hidden && signBtn;
      t.metric('gateShown', gateShown ? 1 : 0);
      const signOk = gateShown && fullyIn(signBtn, right);
      t.metric('signInFullyVisible', signOk ? 1 : 0);
      if (!signOk) t.problem('bug', 'Sign in button is not fully visible in the AI panel');
      let hit = 0;
      for (const c of chips) if (signBtn && overlap(signBtn, c)) hit++;
      t.metric('signInChipOverlap', hit);
      if (hit) t.problem('bug', `Sign in overlaps ${hit} suggestion chip(s)`);
      else t.event('sign-in-above-chips');
      const chipCut = chips.filter((c) => {
        const r = c.getBoundingClientRect();
        const b = suggest.getBoundingClientRect();
        return r.height > 1 && (r.top < b.top - 1 || r.bottom > b.bottom + 1);
      }).length;
      const chipScroll = suggest && suggest.scrollHeight > suggest.clientHeight + 1;
      t.metric('chipsCutWithoutScroll', chipCut && !chipScroll ? chipCut : 0);
      t.metric('chipListScrolls', chipScroll ? 1 : 0);
      if (chipCut && !chipScroll) t.problem('bug', `${chipCut} suggestion chip(s) are cut off and the chip list does not scroll`);
      else t.event('chips-wrap-or-scroll');
      const promptOut = fullyIn(input, right);
      t.metric('promptFullyVisibleSignedOut', promptOut ? 1 : 0);
      if (!promptOut) t.problem('bug', 'AI prompt box is not fully visible when signed out');
      state.user = me;
      bus.emit('ready');
      await sleep(100);
      // Media: the grid scrolls inside the pane; the drop hint stays fully visible (pinned under the grid).
      const media = document.querySelector('#pane-media');
      const grid = document.querySelector('#mediaGrid');
      const hint = media?.querySelector('.drop-hint');
      const mediaScroll = grid && (getComputedStyle(grid).overflowY === 'auto' || getComputedStyle(grid).overflowY === 'scroll');
      t.metric('mediaGridScrollY', mediaScroll ? 1 : 0);
      // Force a tall list so scroll is observable even on an empty library.
      const filler = [];
      if (grid) {
        for (let i = 0; i < 24; i++) {
          const d = document.createElement('div');
          d.className = 'tile';
          d.dataset.playtestFiller = '1';
          d.style.minHeight = '72px';
          grid.appendChild(d);
          filler.push(d);
        }
      }
      await sleep(50);
      const canScroll = grid && grid.scrollHeight > grid.clientHeight + 2;
      t.metric('mediaListScrolls', canScroll ? 1 : 0);
      if (canScroll) {
        grid.scrollTop = grid.scrollHeight;
        await sleep(40);
        t.metric('mediaScrolledPx', Math.round(grid.scrollTop));
        grid.scrollTop = 0;
        t.event('media-scrolls');
      } else t.problem('bug', 'Media tile list does not scroll inside its panel');
      const hintOk = hint && fullyIn(hint, media);
      t.metric('mediaHintFullyVisible', hintOk ? 1 : 0);
      if (!hintOk) t.problem('bug', 'Media drop hint is cut off');
      for (const d of filler) d.remove();
      const ok = promptOk && signOk && !hit && promptOut && canScroll && hintOk && !(chipCut && !chipScroll);
      t.finish(ok ? 'done' : 'stuck');
      return;
    }
    if (id.startsWith('ai-')) {
      if (id === 'ai-signedout') {
        t.scene('Signed out');
        await until(() => activeScene() || document.querySelector('#landing:not([hidden])'), 10000);
        const me = state.user;
        // Setup shortcut (named): a signed-in test account looks signed out for a moment (the session itself is untouched).
        state.user = null;
        bus.emit('ready');
        const gate = document.querySelector('#aiGate');
        t.metric('gateShown', gate && !gate.hidden && /Sign in/.test(gate.textContent) ? 1 : 0);
        t.event('gate-shown');
        const jobs = watchJobs();
        const calls = [];
        const real = window.fetch.bind(window);
        window.fetch = (input, init) => { calls.push(new URL(typeof input === 'string' ? input : input.url, location.href).pathname); return real(input, init); };
        const msgs0 = document.querySelectorAll('#aiMessages .msg').length;
        await typeAi('add a title that says Hello');
        const dlg = await until(() => document.querySelector('#authDialog')?.open, 4000, 100);
        t.metric('signInOpened', dlg ? 1 : 0);
        t.event(dlg ? 'sign-in-opened' : 'no-sign-in');
        const sent = calls.filter((p) => p.startsWith('/v1/') && !/^\/v1\/users\//.test(p));
        t.metric('sentToAi', sent.length + document.querySelectorAll('#aiMessages .msg').length - msgs0);
        if (sent.length) t.problem('bug', `signed out, the AI pane called ${sent.join(', ')}`);
        click('#authCancel');
        window.fetch = real; jobs.stop();
        state.user = me;
        bus.emit('ready');
        t.finish(dlg && !sent.length ? 'done' : 'stuck');
        return;
      }
      if (!state.user) { t.note('Not signed in: the bot needs the test sign-in (Studio\'s beta playtests give it)'); t.finish('stuck'); return; }
      t.scene('AI pane');
      const credits = () => Number(state.user?.credits ?? 0);
      const clips = () => P.doc?.clips?.length ?? 0;
      const titles = () => (P.doc?.clips ?? []).filter((c) => c.kind === 'text').length;
      const mockOff = () => { t.note('The AI mock is off on this Gen (HAWKESGEN_AI_MOCK) or this is not a test sign-in session: nothing to play'); t.event('mock-off'); t.finish('done'); };
      const HELLO = { match: 'says Hello', cost: 0.01, json: { say: 'Added a title that says Hello.', ops: [TITLE_OP('Hello')] } };
      // Three text adds in one turn: the undo label is "AI added 3 clips" and one Ctrl+Z reverses all three.
      const THREE = {
        match: 'three titles',
        cost: 0.01,
        json: { say: 'Added three titles.', ops: [TITLE_OP('One'), TITLE_OP('Two'), TITLE_OP('Three')] },
      };
      if (id === 'ai-edit' || id === 'ai-undo') {
        if (id === 'ai-edit') {
          if (!await mockAi([HELLO])) return mockOff();
          if (!await aiScene('Playtest AI')) { t.note('the new scene did not open'); t.finish('stuck'); return; }
          const before = { clips: clips(), titles: titles(), credits: credits() };
          await typeAi('add a title that says Hello');
          t.event('asked');
          const reply = await until(() => /Added a title that says Hello/.test(document.querySelector('#aiMessages')?.textContent ?? ''), 20000, 100);
          const added = await until(() => titles() > before.titles, 5000, 100);
          t.metric('clipsAdded', clips() - before.clips);
          t.event(added ? 'title-added' : 'no-title');
          const ops = document.querySelector('#aiMessages .msg-ops')?.textContent ?? '';
          t.metric('replyListsIt', reply && /✓/.test(ops) && /text|title|Hello/i.test(ops) ? 1 : 0);
          if (reply && !/✓/.test(ops)) t.problem('bug', `the reply lists no change: "${ops}"`);
          const paid = await until(() => credits() < before.credits, 8000, 150);
          t.metric('creditsDelta', before.credits - credits());
          t.event(paid ? 'credits-dropped' : 'credits-unchanged');
          if (!paid) t.problem('bug', 'the AI turn did not change the credits shown');
          t.finish(reply && added && paid ? 'done' : 'stuck');
          return;
        }
        if (!await mockAi([THREE])) return mockOff();
        if (!await aiScene('Playtest AI undo')) { t.note('the new scene did not open'); t.finish('stuck'); return; }
        const before = { clips: clips(), titles: titles() };
        await typeAi('add three titles please');
        t.event('asked');
        const added = await until(() => titles() >= before.titles + 3, 20000, 100);
        t.metric('clipsAdded', clips() - before.clips);
        t.event(added ? 'three-added' : 'no-titles');
        if (!added) { t.finish('stuck'); return; }
        // Toast after the AI edit offers Undo in one tap (criteria 3).
        const toastEl = () => { const el = document.querySelector('#toast'); return el && !el.hidden ? el : null; };
        const toastOk = await until(() => {
          const el = toastEl();
          if (!el) return false;
          const words = el.textContent ?? '';
          const btn = [...el.querySelectorAll('button')].find((b) => /^Undo$/i.test(b.textContent.trim()));
          return /AI added 3 clips/i.test(words) && btn ? btn : false;
        }, 5000, 100);
        t.metric('toastUndo', toastOk ? 1 : 0);
        t.event(toastOk ? 'toast-undo' : 'no-toast-undo');
        if (!toastOk) t.problem('bug', `no Undo toast after the AI edit: "${toastEl()?.textContent ?? ''}"`);
        const tip = document.querySelector('#undoBtn')?.title ?? '';
        t.metric('undoLabelled', /Undo:\s*AI added 3 clips/i.test(tip) ? 1 : 0);
        t.event(/Undo:\s*AI added 3 clips/i.test(tip) ? 'undo-labelled' : 'undo-unlabelled');
        // One Ctrl+Z puts the timeline back exactly (criteria 1); the bar's Undo is the same path.
        press('z', { ctrlKey: true });
        const gone = await until(() => titles() === before.titles && clips() === before.clips, 5000, 100);
        t.metric('undoRemoved', gone ? 1 : 0);
        t.event(gone ? 'ctrl-z-undone' : 'ctrl-z-failed');
        if (!gone) { t.finish('stuck'); return; }
        // Redo brings the AI change back (criteria 2).
        press('z', { ctrlKey: true, shiftKey: true });
        const back = await until(() => titles() >= before.titles + 3, 5000, 100);
        t.metric('redoRestored', back ? 1 : 0);
        t.event(back ? 'redo-restored' : 'redo-failed');
        t.finish(toastOk && gone && back ? 'done' : 'stuck');
        return;
      }
      if (id === 'ai-proposal') {
        // Setup shortcut (named): price a generate op, and ask for enough of them to pass the 40-credit limit.
        const quote = await api('/v1/billing/quote', { body: { tool: 'video.t2v', params: { prompt: 'a sunrise' } } }).catch(() => null);
        const each = Math.max(1, Number(quote?.credits ?? 0));
        const n = Math.min(8, Math.ceil(45 / each));
        t.metric('opPrice', each);
        const gen = Array.from({ length: n }, (_, i) => ({ op: 'generate', tool: 'video.t2v', params: { prompt: `a sunrise over the sea, take ${i + 1}` }, place: { track: 'V1' } }));
        if (!await mockAi([{ match: 'sunrise clips', cost: 0.01, json: { say: 'Here are the sunrise clips. They cost enough that I want your OK first.', ops: gen } }])) return mockOff();
        if (!await aiScene('Playtest AI proposal')) { t.note('the new scene did not open'); t.finish('stuck'); return; }
        const jobs = watchJobs();
        const before = clips();
        await typeAi('put in some sunrise clips');
        t.event('asked');
        const card = await until(() => document.querySelector('#aiMessages .proposal'), 20000, 100);
        const price = Number(/(\d+) credits/.exec(card?.textContent ?? '')?.[1] ?? 0);
        t.metric('proposalShown', card ? 1 : 0);
        t.metric('proposalCredits', price);
        t.event(card ? 'proposal-shown' : 'no-proposal');
        const hasMake = [...(card?.querySelectorAll('button') ?? [])].some((b) => /Make it/.test(b.textContent));
        t.metric('makeItOffered', hasMake ? 1 : 0);
        await sleep(2500);
        // Nothing started before Make it: no job sent and no waiting clip. Make it itself is left alone (it is GPU money); Skip closes the card.
        t.metric('jobsStarted', jobs.sent.length);
        t.metric('clipsAdded', clips() - before);
        t.event(!jobs.sent.length && clips() === before ? 'nothing-started' : 'something-started');
        if (jobs.sent.length) t.problem('bug', `a proposal started ${jobs.sent.join(', ')} before Make it`);
        if (price <= 40) t.problem('bug', `the proposal shows ${price} credits: not over the 40-credit limit`);
        [...(card?.querySelectorAll('button') ?? [])].find((b) => /Skip/.test(b.textContent))?.click();
        jobs.stop();
        t.finish(card && hasMake && price > 40 && !jobs.sent.length && clips() === before ? 'done' : 'stuck');
        return;
      }
      if (id === 'ai-nocredits') {
        if (!await aiScene('Playtest AI no credits')) { t.note('the new scene did not open'); t.finish('stuck'); return; }
        const before = { clips: clips(), credits: credits() };
        // Setup shortcut (named): the AI turn answers 402, the way Gen does at zero credits (the account's real balance is kept).
        const restore = forceTurn(() => new Response(JSON.stringify({ error: 'Not enough credits: this needs 1 and you have 0 Traceback hg_0123456789abcdef' }), { status: 402, headers: { 'Content-Type': 'application/json' } }));
        await typeAi('add a title that says Hello');
        t.event('asked');
        await until(() => document.querySelector('#aiMessages .msg.err'), 10000, 100);
        restore();
        const msg = [...document.querySelectorAll('#aiMessages .msg.err')].pop();
        const text = msg?.textContent ?? '';
        const button = msg?.querySelector('button')?.textContent ?? '';
        const ok = /out of credits/i.test(text) && !RAW_AI.test(text) && /Add credits/.test(button);
        t.metric('plainLine', ok ? 1 : 0);
        t.metric('timelineChanged', clips() - before.clips);
        t.metric('creditsDelta', before.credits - credits());
        t.event(ok ? '402-plain' : '402-bad');
        if (!ok) t.problem('bug', `the 402 line is "${text.slice(0, 160)}" / button "${button}"`);
        if (clips() !== before.clips) t.problem('bug', 'the timeline changed on a refused turn');
        t.finish(ok && clips() === before.clips ? 'done' : 'stuck');
        return;
      }
      // ai-outage
      if (!await mockAi([{ match: 'garbled one', json: undefined, text: 'zxq ```{{ ~~ ### 0xDEAD', cost: 0.01 }])) return mockOff();
      if (!await aiScene('Playtest AI outage')) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      const start = clips();
      const cases = [
        { key: '503', ask: 'add a title during the 503', answer: () => new Response(JSON.stringify({ error: 'The AI is not available Traceback sk-ant-oat01-abcdefghijkl' }), { status: 503, headers: { 'Content-Type': 'application/json' } }), words: /busy or resting|isn.t available|not available/i, strict: true },
        { key: '429', ask: 'add a title during the 429', answer: () => new Response(JSON.stringify({ error: 'slow down', retryAfter: 7 }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' } }), words: /Too many requests, try again in 7 s/, strict: true },
        { key: 'page', ask: 'add a title on a broken page', answer: () => new Response('<!DOCTYPE html><html><body>502 Bad Gateway Traceback hg_0123456789abcdef</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), words: /interrupted|try again/i, strict: true },
        { key: 'garbled', ask: 'add a title, garbled one', answer: null, words: /./, strict: false },
      ];
      let plain = 0, unlocked = 0;
      for (const c of cases) {
        t.scene(`Outage: ${c.key}`);
        const restore = c.answer ? forceTurn(c.answer) : () => {};
        const seen = document.querySelectorAll('#aiMessages .msg').length;
        await typeAi(c.ask);
        await until(() => document.querySelectorAll('#aiMessages .msg').length >= seen + 2 && aiIdle(), 15000, 100);
        restore();
        const m = c.key === 'garbled' ? lastAi() : [...document.querySelectorAll('#aiMessages .msg.err')].pop();
        const text = m?.textContent ?? '';
        // A garbled model answer is shown as the words it was; a trace or a key in it never is.
        const clean = c.strict ? !RAW_AI.test(text) : !/Traceback|File "|\bat \S+:\d+|hg_[0-9a-f]{6}|sk-ant|hgm_/.test(text);
        const ok = Boolean(text) && c.words.test(text) && clean;
        const free = aiIdle() && !document.querySelector('#aiInput').disabled && !document.querySelector('#aiForm')?.classList.contains('locked');
        if (ok) plain++;
        if (free) unlocked++;
        t.metric(`plain-${c.key}`, ok ? 1 : 0);
        t.metric(`unlocked-${c.key}`, free ? 1 : 0);
        t.event(`${c.key}-${ok && free ? 'ok' : 'bad'}`);
        if (!ok) t.problem('bug', `AI outage "${c.key}" shows "${text.slice(0, 160)}"`);
        if (!free) t.problem('bug', `the AI pane stayed locked after "${c.key}"`);
      }
      t.metric('clipsAddedByOutages', clips() - start);
      t.finish(plain === cases.length && unlocked === cases.length ? 'done' : 'stuck');
      return;
    }
    if (!state.user) { t.note('Not signed in: the bot needs the test sign-in (Studio\'s beta playtests give it)'); t.finish('stuck'); return; }
    if (id === 'stage') {
      t.scene('Stage');
      const jobs = watchJobs(), con = watchConsole();
      const stamp = new Date().toISOString().slice(0, 16);
      const finish = (ok) => { const started = jobs.sent.length; jobs.stop(); con.stop(); t.metric('jobsStarted', started); t.metric('consoleErrors', con.errors.length); if (started) t.problem('blocker', `the stage started ${started} job(s): ${jobs.sent.join(', ')}`); for (const e of con.errors.slice(0, 5)) t.problem('bug', `console error on the stage: ${e}`); t.finish(ok && !started && !con.errors.length ? 'done' : 'stuck'); };
      await until(() => activeScene(), 10000);
      // Setup shortcuts (named): a character to cast (no pictures, no model) and a new stage scene. Everything after is clicks and the time bar.
      const chr = await newScene('character', { title: `Playtest Mara ${stamp}`, open: false });
      extra.push(chr.id);
      made = await newScene('stage', { title: `Playtest stage ${stamp}` });
      if (!await until(() => activeScene()?.id === made?.id && currentShot()?.id === made.id, 20000)) { t.note('the stage did not open'); finish(false); return; }
      t.event('stage-opened');
      // The 3D view: the canvas is on the page with a size, and the "couldn't start" note is not.
      const canvas = await until(() => { const c = document.querySelector('#dirStage canvas.dir-canvas'); return c && c.clientWidth > 50 && c.clientHeight > 50; }, 20000, 150);
      const failedNote = /couldn.t start/i.test(document.querySelector('#dirStage')?.textContent ?? '');
      t.metric('canvasDrawn', canvas && !failedNote ? 1 : 0);
      t.metric('canvasWidth', document.querySelector('#dirStage canvas.dir-canvas')?.clientWidth ?? 0);
      t.event(canvas && !failedNote ? 'stage-drawn' : 'stage-not-drawn');
      if (!canvas || failedNote) { t.problem('bug', failedNote ? 'the 3D stage says it could not start' : 'the 3D stage has no canvas'); finish(false); return; }
      await until(() => document.querySelector('#dirTime') && document.querySelector('#kindPanel .dir-sec'), 8000, 100);
      // Cast a character: Add a character, then them in the menu.
      withText(document.querySelector('#kindPanel'), 'button', /Add a character/)?.click();
      const row = await until(() => withText(document.querySelector('.menu'), '.menu-item', new RegExp(chr.title.replace(/[^\w ]/g, '.'))), 5000, 100) ? withText(document.querySelector('.menu'), '.menu-item', new RegExp(chr.title.replace(/[^\w ]/g, '.'))) : null;
      if (!row) { t.problem('bug', 'Add a character did not list the new character'); finish(false); return; }
      row.click();
      let saw = false;
      const cast = await until(() => currentShot()?.doc.cast.some((c) => c.character === chr.id), 5000, 100);
      t.metric('cast', currentShot()?.doc.cast.length ?? 0);
      t.event(cast ? 'character-cast' : 'character-not-cast');
      // Add a prop: after the cast member has been saved and the shot read back (a read-back lands over an edit made before it).
      await until(() => { api(`/v1/scenes/${made.id}`).then((x) => { if (x.doc?.cast?.length === 1) saw = true; }).catch(() => {}); return saw; }, 8000, 400);
      await sleep(900);
      withText(document.querySelector('#kindPanel'), 'button', /Add a prop/)?.click();
      const prop = await until(() => currentShot()?.doc.props.length === 1, 5000, 100);
      t.metric('props', currentShot()?.doc.props.length ?? 0);
      t.event(prop ? 'prop-added' : 'prop-not-added');
      // Camera keys at two moments, with the time bar (the range input a person drags) and the key button.
      const bar = document.querySelector('#dirTime');
      const scrub = async (frac) => { bar.value = String(frac); bar.dispatchEvent(new Event('input', { bubbles: true })); await sleep(250); return document.querySelector('#dirTc')?.textContent ?? ''; };
      const stamps = new Set();
      stamps.add(await scrub(0.25));
      withText(document.querySelector('#kindPanel'), 'button', /Key the camera at/)?.click();
      await until(() => (currentShot()?.doc.camera.keys?.length ?? 0) === 1, 4000, 100);
      stamps.add(await scrub(0.75));
      withText(document.querySelector('#kindPanel'), 'button', /Key the camera at/)?.click();
      const keyed = await until(() => (currentShot()?.doc.camera.keys?.length ?? 0) === 2, 4000, 100);
      const marks = await until(() => document.querySelectorAll('#dirMarks .dir-key').length === 2, 3000, 100);
      t.metric('cameraKeys', currentShot()?.doc.camera.keys?.length ?? 0);
      t.metric('keyMarks', document.querySelectorAll('#dirMarks .dir-key').length);
      t.event(keyed ? 'camera-keyed-twice' : 'camera-not-keyed');
      if (keyed && !marks) t.problem('bug', 'the time bar does not show the two camera keys');
      // Scrub across the shot and play it a moment: the clock must move and the stage keep drawing.
      for (const f of [0, 0.5, 1, 0.1]) stamps.add(await scrub(f));
      t.metric('distinctTimecodes', stamps.size);
      t.event('scrubbed');
      const t0 = document.querySelector('#dirTc')?.textContent;
      click('#dirPlay');
      await sleep(1200);
      const t1 = document.querySelector('#dirTc')?.textContent;
      click('#dirPlay');
      t.metric('playMoved', t0 !== t1 ? 1 : 0);
      t.event(t0 !== t1 ? 'played' : 'play-did-not-move');
      const still = document.querySelector('#dirStage canvas.dir-canvas')?.clientWidth > 50 && !document.querySelector('#dirStage .empty-note');
      t.metric('stillDrawn', still ? 1 : 0);
      // Saved with its cast, prop and keys (Ctrl+S saves now).
      press('s', { ctrlKey: true });
      let saved = null;
      await until(() => { api(`/v1/scenes/${made.id}`).then((s) => { saved = s; }).catch(() => {}); return saved?.doc?.cast?.length === 1 && saved.doc.props?.length === 1 && saved.doc.camera?.keys?.length === 2; }, 8000, 500);
      const savedOk = saved?.doc?.cast?.length === 1 && saved.doc.props?.length === 1 && saved.doc.camera?.keys?.length === 2;
      t.metric('saved', savedOk ? 1 : 0);
      t.event(savedOk ? 'stage-saved' : 'stage-not-saved');
      if (!savedOk) t.problem('bug', 'the stage did not save its cast, prop and camera keys');
      finish(Boolean(cast && prop && keyed && stamps.size >= 3 && t0 !== t1 && still && savedOk));
      return;
    }
    if (id === 'character') {
      t.scene('Character sheet');
      const jobs = watchJobs();
      const stamp = new Date().toISOString().slice(0, 16);
      await until(() => activeScene(), 10000);
      // Setup shortcut (named): a character scene, with the library's newest picture as their front when it has one.
      const pics = ((await api(`/v1/assets?${new URLSearchParams({ limit: '5', project: state.user.project, kind: 'image' })}`).catch(() => null))?.items ?? []);
      t.metric('libraryPictures', pics.length);
      const doc = { title: `Playtest Iris ${stamp}`, description: 'A tall ranger in a green coat, grey eyes, a scar over the left brow.', ...(pics.length ? { pictures: [{ role: 'front', asset: pics[0].id }] } : {}) };
      made = await newScene('character', { title: doc.title, doc });
      if (!await until(() => activeScene()?.id === made?.id && document.querySelector('#chrWrap .chr-sheet'), 15000, 150)) { jobs.stop(); t.note('the character sheet did not open'); t.finish('stuck'); return; }
      t.event('sheet-open');
      const sheet = document.querySelector('#chrWrap');
      // Each section the sheet promises. Every one is looked at, none is pressed.
      const name = sheet.querySelector('.chr-name');
      const look = sheet.querySelector('.chr-look');
      const voiceReady = await until(() => (sheet.querySelectorAll('.chr-voice select option').length ?? 0) > 1, 8000, 200);
      const voice = sheet.querySelector('.chr-voice select');
      const rolePick = sheet.querySelector('.chr-pic select');
      const model = sheet.querySelector('.chr-model');
      const checks = {
        name: Boolean(name) && name.value === doc.title,
        description: /ranger/.test(sheet.querySelector('textarea')?.value ?? ''),
        look: Boolean(look) && /Their look/.test(look.textContent),
        voice: Boolean(voice) && voiceReady,
        pictures: Boolean(sheet.querySelector('.chr-pics .chr-add')) && (!pics.length || (Boolean(rolePick) && rolePick.options.length === 6 && rolePick.value === 'front')),
        model: Boolean(model) && /No 3D model yet|Making the 3D model/.test(model.textContent) || model?.tagName === 'MODEL-VIEWER',
      };
      for (const [k, v] of Object.entries(checks)) { t.metric(`section_${k}`, v ? 1 : 0); if (!v) t.problem('bug', `the character sheet's ${k} section is missing or wrong`); }
      t.metric('voices', Math.max(0, (voice?.options.length ?? 1) - 1));
      t.metric('roleChoices', rolePick?.options.length ?? 0);
      t.event(`sections: ${Object.entries(checks).map(([k, v]) => `${k} ${v ? 'ok' : 'MISSING'}`).join(', ')}`);
      // The buttons that would cost something are there to see, and are left alone.
      const makers = ['Make their pictures', 'Make their look', 'Make the 3D model'].filter((x) => withText(sheet, 'button', new RegExp(x)));
      t.metric('makeButtonsSeen', makers.length);
      t.note(`Seen, not pressed: ${makers.join(', ') || 'none'}`);
      if (!withText(sheet, 'button', /Stage them/)) t.problem('bug', 'the sheet has no Stage them button');
      await sleep(800);
      const started = jobs.sent.length;
      jobs.stop();
      t.metric('jobsStarted', started);
      if (started) t.problem('blocker', `opening a character sheet started ${started} job(s): ${jobs.sent.join(', ')}`);
      t.finish(Object.values(checks).every(Boolean) && !started ? 'done' : 'stuck');
      return;
    }
    if (id === 'world') {
      t.scene('Start a world');
      const jobs = watchJobs();
      await until(() => activeScene(), 10000);
      const worlds0 = sceneList().filter((s) => s.kind === 'world').length;
      const credits0 = Number(state.user?.credits ?? 0);
      // Setup shortcut (named): the world AI's canned answer (the test account's mock) stands in for Claude.
      const proposal = { say: 'A frozen moon of smugglers.', world: { title: 'Red Sky Run', logline: 'Smugglers work a frozen moon whose sky is always red.', tone: 'Dry, tense, a little tender.', look: { style: 'Cold blues against a red sky, grainy film', palette: ['#8c1d18', '#1f3a5f', '#d9e2ec'] }, rules: ['The sky is always red.'] },
        characters: [{ title: 'Captain Oda', description: 'A weathered smuggler in a patched orange parka.' }, { title: 'Pip', description: 'A cargo-bot with one working lamp.' }],
        places: [{ title: 'The Ice Dock', description: 'A frozen harbor of rusted cranes under the red sky.' }], props: [], story: { title: 'The Last Crate', logline: 'One crate must cross the ice before the sky goes dark.' } };
      const mocked = await mockAi([{ match: 'frozen moon', cost: 0.01, json: proposal }]);
      // The way in: "+" in the bar, then the Start a world idea.
      click('#newSceneBtn');
      const starter = await until(() => withText(document.querySelector('.menu .menu-starters'), '.menu-item', /Start a world/), 6000, 100) ? withText(document.querySelector('.menu .menu-starters'), '.menu-item', /Start a world/) : null;
      if (!starter) { jobs.stop(); t.problem('bug', 'the + menu has no Start a world idea'); t.finish('stuck'); return; }
      starter.click();
      const sheet = await until(() => document.querySelector('#worldStart textarea'), 6000, 100) ? document.querySelector('#worldStart') : null;
      t.metric('sheetOpened', sheet ? 1 : 0);
      t.event(sheet ? 'start-sheet-open' : 'no-start-sheet');
      if (!sheet) { jobs.stop(); t.finish('stuck'); return; }
      const build = withText(sheet, 'button', /Build my world/);
      t.metric('buildButton', build ? 1 : 0);
      if (!mocked) {
        t.note('The AI mock is off on this Gen (HAWKESGEN_AI_MOCK) or this is not a test sign-in session: the first card is not played');
        t.event('mock-off');
        sheet.querySelector('.sheet-head .icon-btn')?.click();
        const started0 = jobs.sent.length; jobs.stop(); t.metric('jobsStarted', started0);
        t.finish(build && !started0 ? 'done' : 'stuck');
        return;
      }
      await typeInto(sheet.querySelector('textarea'), 'smugglers on a frozen moon where the sky is always red');
      build?.click();
      t.event('build-pressed');
      const card = await until(() => sheet.querySelector('.ws-cards .ws-card'), 30000, 150);
      t.metric('cardsShown', sheet.querySelectorAll('.ws-card').length);
      t.event(card ? 'first-card-shown' : 'no-card');
      if (!card) { jobs.stop(); t.problem('bug', 'Start a world did not reach its first card'); sheet.querySelector('.sheet-head .icon-btn')?.click(); t.finish('stuck'); return; }
      const titleOk = sheet.querySelector('.ws-world-title')?.value === 'Red Sky Run';
      const charCards = sheet.querySelectorAll('.ws-cards .ws-card .ws-card-name').length;
      const story = sheet.querySelector('.ws-story');
      t.metric('worldTitleOk', titleOk ? 1 : 0);
      t.metric('characterCards', charCards);
      t.metric('storyCard', story ? 1 : 0);
      if (!titleOk) t.problem('bug', 'the proposal sheet does not show the world\'s name');
      // Keep / Thrown away on a card, as a person taps it, and back.
      const keepBtn = withText(card, 'button', /Keep/);
      keepBtn?.click();
      const thrown = await until(() => sheet.querySelector('.ws-card.off'), 2000, 100);
      withText(sheet.querySelector('.ws-card.off'), 'button', /Thrown away/)?.click();
      const back = await until(() => !sheet.querySelector('.ws-card.off'), 2000, 100);
      t.metric('keepToggles', thrown && back ? 1 : 0);
      t.event(thrown && back ? 'card-toggled' : 'card-toggle-failed');
      // The price: the AI's own cost shows in the credits, and the pictures' price is known before anything is made.
      await until(() => Number(state.user?.credits ?? 0) < credits0, 6000, 150);
      t.metric('aiCreditsSpent', Math.round((credits0 - Number(state.user?.credits ?? 0)) * 100) / 100);
      const quote = await api('/v1/billing/quote', { body: { tool: 'image.generate', params: { prompt: 'a frozen harbor under a red sky' }, project: state.user.project } }).catch(() => null);
      const price = Number(quote?.credits ?? NaN);
      t.metric('picturePrice', Number.isFinite(price) ? price : -1);
      t.event(Number.isFinite(price) ? `price-known: ${price} credits a picture` : 'no-price');
      if (!Number.isFinite(price)) t.problem('bug', 'the price of a picture could not be read');
      const make = withText(sheet, 'button', /Make this world/);
      t.metric('makeThisWorldOffered', make ? 1 : 0);
      if (!make) t.problem('bug', 'the proposal has no Make this world button');
      await sleep(1500);
      // Make this world is never pressed: it would save scenes and offer pictures for credits. Close the sheet instead.
      sheet.querySelector('.sheet-head .icon-btn')?.click();
      const started = jobs.sent.length;
      jobs.stop();
      const worlds1 = sceneList().filter((s) => s.kind === 'world').length;
      t.metric('jobsStarted', started);
      t.metric('worldsMade', worlds1 - worlds0);
      t.event(!started && worlds1 === worlds0 ? 'nothing-started' : 'something-started');
      if (started) t.problem('blocker', `Start a world started ${started} job(s): ${jobs.sent.join(', ')}`);
      if (worlds1 !== worlds0) t.problem('bug', 'a world was saved before Make this world was pressed');
      t.finish(card && titleOk && make && Number.isFinite(price) && !started && worlds1 === worlds0 ? 'done' : 'stuck');
      return;
    }
    if (id === 'scenes') {
      t.scene('Scenes');
      const jobs = watchJobs();
      const stamp = new Date().toISOString().slice(11, 16).replace(':', '');
      const yes = confirmYes();
      const done = (ok) => { yes(); const started = jobs.sent.length; jobs.stop(); t.metric('jobsStarted', started); if (started) t.problem('blocker', `the scenes screens started ${started} job(s): ${jobs.sent.join(', ')}`); t.finish(ok && !started ? 'done' : 'stuck'); };
      await until(() => activeScene(), 10000);
      const KINDS = [['video', 'Video'], ['stage', 'Stage'], ['image', 'Image'], ['audio', 'Audio'], ['character', 'Character'], ['world', 'World'], ['place', 'Place'], ['prop', 'Prop'], ['story', 'Story']];
      const mine = [];           // { id, kind, title }
      const serverTitle = async (sid) => (await api(`/v1/scenes/${sid}`).catch(() => null))?.title ?? null;
      // 1 One new scene of each kind from the "+" menu, each renamed by double-clicking its tab.
      let renamed = 0;
      for (const [kind, label] of KINDS) {
        const prev = activeScene()?.id;
        click('#newSceneBtn');
        const rowEl = await until(() => blankRow(label), 6000, 100) ? blankRow(label) : null;
        if (!rowEl) { t.problem('bug', `the + menu has no blank ${label}`); continue; }
        rowEl.click();
        if (!await until(() => activeScene()?.kind === kind && activeScene()?.id !== prev, 15000, 100)) { t.problem('bug', `a new ${label} scene did not open`); continue; }
        const sid = activeScene().id;
        extra.push(sid);
        const title = `PT ${label} ${stamp}`;
        mine.push({ id: sid, kind, title });
        t.event(`made-${kind}`);
        // Rename: double-click the tab, type, Enter.
        const tab = document.querySelector(`#sceneTabs .scene-tab[data-id="${sid}"]`);
        tab?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = await until(() => document.querySelector('.scene-tab-input'), 2000, 50) ? document.querySelector('.scene-tab-input') : null;
        if (!input) { t.problem('bug', `the ${label} tab did not open its rename box`); continue; }
        await typeInto(input, title);
        pressOn(input, 'Enter');
        let ok = false;
        for (let i = 0; i < 16 && !ok; i++) { await sleep(500); ok = (await serverTitle(sid)) === title; }
        if (ok) renamed++; else t.problem('bug', `renaming the ${label} scene did not reach Gen`);
        await sleep(100);
      }
      t.metric('kindsMade', mine.length);
      t.metric('renamed', renamed);
      t.event(`kinds-made: ${mine.map((m) => m.kind).join(',')}`);
      t.event(renamed === mine.length ? 'all-renamed' : `renamed ${renamed} of ${mine.length}`);
      if (mine.length !== KINDS.length) { done(false); return; }
      const tabIds = () => [...document.querySelectorAll('#sceneTabs .scene-tab')].map((e) => e.dataset.id);
      const tabTitle = (sid) => document.querySelector(`#sceneTabs .scene-tab[data-id="${sid}"] .scene-tab-t`)?.textContent.replace(/\s*\*$/, '').trim();
      const tabOk = mine.every((m) => tabTitle(m.id) === m.title);
      t.metric('tabsShowNewNames', tabOk ? 1 : 0);
      if (!tabOk) t.problem('bug', 'a renamed scene\'s tab does not show its new name');
      // 2 Reorder: drag the last tab onto the first (real drag events with one DataTransfer).
      const before = tabIds();
      const from = before[before.length - 1], to = before[0];
      const dt = new DataTransfer();
      const fire = (type, el) => el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      const tabEl = (sid) => document.querySelector(`#sceneTabs .scene-tab[data-id="${sid}"]`);
      fire('dragstart', tabEl(from)); fire('dragover', tabEl(to)); fire('drop', tabEl(to)); fire('dragend', tabEl(from));
      await sleep(300);
      const after = tabIds();
      const moved = after.indexOf(from) < after.indexOf(to) && after.length === before.length;
      t.metric('reordered', moved ? 1 : 0);
      t.event(moved ? 'tab-reordered' : 'tab-not-reordered');
      if (!moved) t.problem('bug', 'dragging a tab before another did not reorder the tabs');
      // 3 Duplicate and 4 Delete, from the Scenes pane's row menu.
      const target = mine[0];
      click('#paneTabs button[data-pane="scenes"]');
      const search = document.querySelector('#scenesSearch');
      const rowFor = (title) => [...document.querySelectorAll('#scenesList .scene-row')].find((r) => r.querySelector('b')?.textContent === title);
      const findRow = async (title) => { await typeInto(search, title); search.dispatchEvent(new Event('input', { bubbles: true })); return await until(() => rowFor(title), 6000, 100) ? rowFor(title) : null; };
      const listCount = async () => ((await api(`/v1/scenes?project=${encodeURIComponent(state.user.project)}`).catch(() => null))?.items ?? []);
      const before1 = await listCount();
      const row = await findRow(target.title);
      if (!row) { t.problem('bug', 'the Scenes list does not show a scene that was just made'); done(false); return; }
      row.querySelector('.icon-btn[title="More"]')?.click();
      const dup = await until(() => withText(document.querySelector('.menu'), '.menu-item', /^Duplicate$/), 4000, 100) ? withText(document.querySelector('.menu'), '.menu-item', /^Duplicate$/) : null;
      if (!dup) { t.problem('bug', 'the scene menu has no Duplicate'); done(false); return; }
      dup.click();
      let copy = null;
      await until(() => { listCount().then((l) => { copy = l.find((x) => !before1.some((b) => b.id === x.id)) ?? copy; }); return copy; }, 8000, 400);
      t.metric('duplicated', copy ? 1 : 0);
      t.event(copy ? `duplicated: "${copy.title}"` : 'not-duplicated');
      if (!copy) { done(false); return; }
      extra.push(copy.id);
      if (copy.title === target.title) t.problem('bug', 'the duplicate has the same name as the original');
      await loadList();
      const copyRow = await findRow(copy.title);
      t.metric('duplicateListed', copyRow ? 1 : 0);
      if (!copyRow) t.problem('bug', 'the duplicate is not in the Scenes list');
      // Delete the duplicate (confirm answered yes, as a person presses OK): the row, the tab and the scene go.
      copyRow?.querySelector('.icon-btn[title="More"]')?.click();
      const del = await until(() => withText(document.querySelector('.menu'), '.menu-item', /^Delete$/), 4000, 100) ? withText(document.querySelector('.menu'), '.menu-item', /^Delete$/) : null;
      if (!del) { t.problem('bug', 'the scene menu has no Delete'); done(false); return; }
      del.click();
      const rowGone = await until(() => !rowFor(copy.title), 6000, 100);
      let gone = false;
      for (let i = 0; i < 10 && !gone; i++) { gone = !(await api(`/v1/scenes/${copy.id}`).then(() => true).catch(() => false)); if (!gone) await sleep(400); }
      t.metric('deleted', rowGone && gone ? 1 : 0);
      t.event(rowGone && gone ? 'duplicate-deleted' : 'delete-failed');
      if (!rowGone) t.problem('bug', 'the deleted scene is still in the Scenes list');
      if (!gone) t.problem('bug', 'the deleted scene still exists in Gen');
      // The original is untouched by all of that.
      const intact = (await serverTitle(target.id)) === target.title;
      t.metric('originalIntact', intact ? 1 : 0);
      if (!intact) t.problem('bug', 'duplicating and deleting the copy changed the original');
      await typeInto(search, ''); search.dispatchEvent(new Event('input', { bubbles: true }));
      done(moved && Boolean(copy) && Boolean(copyRow) && rowGone && gone && intact && renamed > 0);
      return;
    }
    if (id === 'media-upload') {
      t.scene('Media upload');
      const jobs = watchJobs();
      click('#paneTabs button[data-pane="media"]');
      await until(() => document.querySelectorAll('#mediaGrid .tile').length > 0 || document.querySelector('#mediaGrid .empty-note'), 15000);
      // Setup shortcut (named): a 64x64 picture made in the page, different every run (Gen stores files by content).
      const stamp = Date.now();
      const name = `playtest-upload-${stamp}.png`;
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d');
      g.fillStyle = `hsl(${stamp % 360} 60% 45%)`; g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#fff'; g.fillRect(8 + (stamp % 24), 8, 24, 24);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      const file = new File([blob], name, { type: 'image/png' });
      t.metric('fileBytes', file.size);
      // The action: the file input gets the file, as the browser's file picker leaves it, and says it changed.
      const input = document.querySelector('#uploadInput');
      const dt = new DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      t.event('file-chosen');
      const tileFor = () => [...document.querySelectorAll('#mediaGrid .tile:not(.busy)')].find((x) => x.querySelector('.tile-cap')?.textContent === name);
      const working = await until(() => [...document.querySelectorAll('#mediaGrid .tile.busy')].length > 0 || tileFor(), 4000, 50);
      t.metric('showedProgress', working ? 1 : 0);
      const tile = await until(() => tileFor(), 30000, 200) ? tileFor() : null;
      t.metric('tileShown', tile ? 1 : 0);
      t.event(tile ? 'upload-in-media' : 'upload-missing');
      if (!tile) { jobs.stop(); t.problem('bug', 'the uploaded picture never showed in Media'); t.finish('stuck'); return; }
      t.metric('tileIsImage', tile.classList.contains('kind-image') ? 1 : 0);
      t.metric('tileHasPicture', tile.querySelector('img') ? 1 : 0);
      if (!tile.querySelector('img')) t.problem('bug', 'the uploaded picture\'s tile shows no thumbnail');
      // Its details: the drawer says what it is and how big.
      tile.querySelector('.tile-info')?.click();
      const drawer = await until(() => document.querySelector('#mediaDrawer .media-drawer'), 4000, 100) ? document.querySelector('#mediaDrawer') : null;
      const text = drawer?.textContent ?? '';
      t.metric('drawerOpened', drawer ? 1 : 0);
      t.metric('drawerSize', /64\s*×\s*64/.test(text) ? 1 : 0);
      t.event(drawer ? `drawer: ${/Image/.test(text) ? 'Image' : '?'}, ${/64\s*×\s*64/.test(text) ? '64 × 64' : 'size missing'}` : 'no-drawer');
      if (drawer && !/64\s*×\s*64/.test(text)) t.problem('bug', 'the details do not say the picture is 64 × 64');
      if (drawer) { pressOn(drawer, 'Escape'); await until(() => !document.querySelector('#mediaDrawer'), 3000, 100); }
      // Media has no Delete (no button, no menu, no route): said here, so a missing delete is a known gap, not a hidden one.
      t.note('Media has no Delete for files: the 64×64 test picture stays in the test account\'s library');
      // Only a CPU conversion may have run (a picture that needs converting): never a GPU tool.
      const gpu = jobs.sent.filter((x) => !/^(media\.normalize)$/.test(x));
      jobs.stop();
      t.metric('jobsStarted', jobs.sent.length);
      if (gpu.length) t.problem('blocker', `uploading started a job that isn't the conversion: ${gpu.join(', ')}`);
      t.finish(tile && drawer && !gpu.length ? 'done' : 'stuck');
      return;
    }
    if (id === 'createprice') {
      t.scene('Create prices');
      click('#paneTabs button[data-pane="generate"]');
      const rows0 = await until(() => document.querySelectorAll('#createList .cat .cat-row').length > 0, 15000);
      if (!rows0) { t.note('the Create list did not load'); t.finish('stuck'); return; }
      const n = document.querySelectorAll('#createList .cat .cat-row').length;
      let priced = 0, changedCost = 0;
      const priceOf = () => document.querySelector('#createBody .gen-foot .quote')?.textContent.trim() ?? '';
      const isPrice = (x) => /credit|free/i.test(x);
      for (let i = 0; i < n; i++) {
        const row = document.querySelectorAll('#createList .cat .cat-row')[i];
        if (!row || row.classList.contains('director-row')) continue;
        row.click();
        await sleep(200);
        if (!document.querySelector('#createBody .gen-foot')) { click('#createBack'); continue; }
        const ok = await until(() => isPrice(priceOf()), 5000, 150);
        if (ok) priced++; else t.problem('bug', `Create form shows no price: "${priceOf()}"`);
        t.event(`price-${i}`);
        // Change an option (the first menu with another choice) and watch the price.
        const sel = [...document.querySelectorAll('#createBody select')].find((x) => x.options.length > 1);
        if (ok && sel) {
          const before = priceOf();
          sel.selectedIndex = sel.options.length - 1;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(1200);
          if (priceOf() !== before) { changedCost++; t.event('price-changed'); }
        }
        click('#createBack');
        await sleep(100);
      }
      t.metric('forms', n); t.metric('formsPriced', priced); t.metric('priceChangedWithOption', changedCost);
      t.finish(priced > 0 ? 'done' : 'stuck');
      return;
    }
    if (id === 'create') {
      t.scene('Create forms');
      const jobs = watchJobs();
      click('#paneTabs button[data-pane="generate"]');
      if (!await until(() => document.querySelectorAll('#createList .cat .cat-row').length > 0, 15000)) { jobs.stop(); t.note('the Create list did not load'); t.finish('stuck'); return; }
      // One group at a time, by its heading: open its first tool that's on this Gen, look at the form, go back. Make is never pressed.
      const groups = ['Images', 'Video', '3D', 'Animation', 'Voice', 'Chains'];
      let opened = 0, ok = 0, priceFree = 0;
      let sample = null;
      for (const name of groups) {
        const cat = [...document.querySelectorAll('#createList .cat')].find((c) => c.querySelector('h3')?.textContent.startsWith(name));
        const row = cat?.querySelector('.cat-row');
        if (!row) { t.problem('bug', `Create has no "${name}" group, or nothing in it on this Gen`); continue; }
        row.click();
        const shown = await until(() => document.querySelector('#createBody .gen-foot'), 5000, 100);
        if (!shown) { t.problem('bug', `${name}: the form did not open`); click('#createBack'); continue; }
        opened++;
        // The price loads on open ("Pricing…", then credits): give it its moment.
        await until(() => /credit|free/i.test(document.querySelector('#createBody .gen-foot .quote')?.textContent ?? ''), 6000, 150);
        const form = document.querySelector('#createBody form') ?? document.querySelector('#createBody');
        // A deliberately broken form (option broken): its price and Make button are taken away, so the scenario must say so.
        if (options?.broken && name.startsWith('3D')) { form.querySelector('.gen-foot .quote')?.remove(); form.querySelector('.gen-foot .primary')?.remove(); }
        const faults = formFaults(form);
        const title = form.querySelector('.gen-head b')?.textContent ?? name;
        const price = form.querySelector('.gen-foot .quote')?.textContent.trim() ?? '';
        t.metric(`form_${name.toLowerCase()}_fields`, form.querySelectorAll('textarea, input:not([type=hidden]), select').length);
        t.event(`form-${name.toLowerCase()}: ${title} · ${price || 'no price'}`);
        if (faults.length) for (const f of faults) t.problem('bug', `${name} · ${title}: ${f}`); else ok++;
        if (/^free$/i.test(price)) priceFree++;
        if (!sample) sample = form;
        click('#createBack');
        await until(() => !document.querySelector('#createHome')?.hidden, 3000, 100);
      }
      t.metric('groupsOpened', opened); t.metric('formsComplete', ok); t.metric('freeForms', priceFree);
      // The check must catch a form that lost its price and Make button, so a quiet pass means something.
      const bad = document.createElement('form');
      bad.innerHTML = '<div class="gen-foot"><span class="quote">…</span></div>';
      const caught = formFaults(bad).length >= 2;
      t.metric('brokenFormCaught', caught ? 1 : 0);
      t.event(caught ? 'broken-form-reported' : 'broken-form-missed');
      const started = jobs.sent.length;
      jobs.stop();
      t.metric('jobsStarted', started);
      if (started) t.problem('blocker', `Create started ${started} job(s): ${jobs.sent.join(', ')}`);
      t.finish(opened === groups.length && caught && !started ? 'done' : 'stuck');
      return;
    }
    if (id === 'checkout') {
      t.scene('Buying credits');
      if (!state.user) { t.note('Not signed in: the bot needs the test sign-in (Studio\'s beta playtests give it)'); t.finish('stuck'); return; }
      const jobs = watchJobs();
      // Setup shortcut (named): the checkout routes answer from here, so Stripe is never called and no money moves. Starting
      // a checkout fails like Stripe being down (502), and each return reads one of four made-up sessions.
      const realFetch = window.fetch.bind(window);
      const start = state.user.credits ?? 0;
      const sessions = {
        cs_test_ptpaid: { status: 'paid', mode: 'payment', credits: 1000, name: 'Starter Pack', amountTotal: 1000, currency: 'usd', receiptUrl: 'https://pay.stripe.com/receipts/playtest', declined: null, balance: start + 1000 },
        cs_test_ptproc: { status: 'processing', mode: 'payment', credits: 1000, name: 'Starter Pack', amountTotal: 1000, currency: 'usd', receiptUrl: null, declined: null, balance: start },
        cs_test_ptdecl: { status: 'declined', mode: 'payment', credits: 1000, name: 'Starter Pack', amountTotal: 1000, currency: 'usd', receiptUrl: null, declined: 'Your card was declined.', balance: start },
        cs_test_ptopen: { status: 'open', mode: 'payment', credits: 1000, name: 'Starter Pack', amountTotal: 1000, currency: 'usd', receiptUrl: null, declined: null, balance: start },
      };
      let starts = 0;
      window.fetch = async (input, init) => {
        const u = String(input?.url ?? input);
        const sid = u.match(/\/v1\/billing\/checkout\/(cs_test_pt\w+)/)?.[1];
        if (sid) return new Response(JSON.stringify(sessions[sid]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (/\/v1\/(billing|subscriptions)\/checkout$/.test(u.split('?')[0]) && (init?.method ?? 'GET') === 'POST') { starts++; return new Response(JSON.stringify({ error: 'Stripe error {"type":"api_error"} sk_test_abcdefghijklmnop' }), { status: 502, headers: { 'Content-Type': 'application/json' } }); }
        if (/\/v1\/users\/me$/.test(u.split('?')[0])) { const r = await realFetch(input, init); const j = await r.json(); if (j.user && sessions.__paid) j.user.credits = sessions.cs_test_ptpaid.balance; return new Response(JSON.stringify(j), { status: r.status, headers: { 'Content-Type': 'application/json' } }); }
        return realFetch(input, init);
      };
      const toastText = () => { const el = document.querySelector('#toast'); return el && !el.hidden ? el.textContent.trim() : ''; };
      const raw = (s) => /[{}]|sk_test_|sk_live_|Traceback|api_error/.test(s);
      try {
        document.querySelector('#creditsPill')?.click();
        const open = await until(() => document.querySelector('#accountDialog[open]'), 5000, 100);
        if (!open) { t.problem('bug', 'the credits pill did not open the account sheet'); t.finish('stuck'); return; }
        await until(() => document.querySelector('#packs .acct-pack, #packs .acct-note'), 6000, 150);
        const packs = [...document.querySelectorAll('#packs .acct-pack')];
        t.metric('packs', packs.length);
        const packs0 = await realFetch('/v1/billing/packs').then((r) => r.json()).catch(() => ({}));
        t.metric('stripeTestMode', packs0?.stripe?.mode === 'test' ? 1 : 0);
        if (packs0?.stripe?.mode === 'test' && !document.querySelector('#packs .acct-test')) t.problem('bug', 'Stripe is in test mode here but the sheet does not say so (the test card note)');
        if (packs0?.stripe?.mode === 'live' && document.querySelector('#packs .acct-test')) t.problem('bug', 'the test card note shows on a live Gen');
        if (!packs.length) t.note('Buying credits is not open on this Gen (no Stripe key): the pack taps were not played');
        // On a phone: the sheet fits, every pack is one row at least 44 px tall and fully on screen once scrolled to.
        if (window.innerWidth <= 600 && packs.length) {
          const sheet = document.querySelector('#accountDialog');
          t.metric('sheetOverflowX', sheet.scrollWidth > sheet.clientWidth + 1 ? 1 : 0);
          if (sheet.scrollWidth > sheet.clientWidth + 1) t.problem('bug', 'the account sheet scrolls sideways on a phone');
          for (const p of packs) {
            p.scrollIntoView({ block: 'center' });
            await sleep(50);
            const r = p.getBoundingClientRect();
            if (r.height < 44) t.problem('bug', `a pack is under 44 px tall on a phone (${Math.round(r.height)})`);
            if (r.left < -1 || r.right > window.innerWidth + 1) t.problem('bug', 'a pack is cut off at the side on a phone');
          }
          const price = packs[0].querySelector('.acct-pack-price')?.getBoundingClientRect();
          t.metric('phonePackRow', price && price.top < packs[0].getBoundingClientRect().top + packs[0].getBoundingClientRect().height / 2 + 4 ? 1 : 0);
        }
        // One tap: the others wait while checkout opens; Stripe down: one plain line and every pack free again.
        if (packs.length) {
          packs[0].click();
          const waited = packs.slice(1).every((b) => b.disabled);
          t.metric('othersWaitWhileOpening', waited ? 1 : 0);
          if (!waited) t.problem('bug', 'the other packs can be tapped while a checkout opens');
          await until(() => !document.querySelector('#accountError')?.hidden, 5000, 100);
          const err = document.querySelector('#accountError')?.textContent.trim() ?? '';
          t.event(`checkout failed to start: ${err}`);
          if (!err) t.problem('bug', 'a checkout that failed to start says nothing');
          if (raw(err)) t.problem('bug', `a checkout that failed to start shows raw text: ${err.slice(0, 80)}`);
          if (packs.some((b) => b.disabled)) t.problem('bug', 'the packs stay locked after a checkout failed to start');
          if (starts !== 1) t.problem('bug', `one tap started ${starts} checkouts`);
        }
        document.querySelector('#accountClose')?.click();
        await until(() => !document.querySelector('#accountDialog[open]'), 3000, 100);
        // Coming back from Stripe: each outcome in words, never raw, the paid one with the new balance and a Receipt.
        const { checkoutReturned } = await import('./account.js');
        const want = { cs_test_ptpaid: /credits added/i, cs_test_ptproc: /processing/i, cs_test_ptdecl: /declined.*nothing was charged/i, cs_test_ptopen: /cancelled.*nothing was charged/i };
        for (const [sid, re] of Object.entries(want)) {
          if (sid === 'cs_test_ptpaid') sessions.__paid = true;
          await checkoutReturned(sid);
          await sleep(150);
          const said = toastText();
          t.event(`${sid.slice(11)}: ${said}`);
          if (!re.test(said)) t.problem('bug', `coming back ${sessions[sid].status} said "${said.slice(0, 80)}"`);
          if (raw(said)) t.problem('bug', `coming back ${sessions[sid].status} shows raw text`);
          if (sid === 'cs_test_ptpaid') {
            const pill = Number(document.querySelector('#creditsCount')?.textContent.replace(/[^\d]/g, '')) || 0;
            t.metric('pillAfterPaid', pill);
            if (pill !== sessions.cs_test_ptpaid.balance) t.problem('bug', `the credits pill shows ${pill} after a paid return, not ${sessions.cs_test_ptpaid.balance}`);
            if (![...document.querySelectorAll('#toast button')].some((b) => /receipt/i.test(b.textContent))) t.problem('bug', 'a paid return offers no Receipt');
          }
        }
        if (jobs.sent.length) t.problem('bug', `buying credits started ${jobs.sent.length} job(s)`);
        t.finish('done');
      } finally {
        window.fetch = realFetch;
        jobs.stop();
        // Back to the real balance (the made-up paid return showed a made-up one).
        (await import('./account.js')).refreshCredits();
      }
      return;
    }
    if (id === 'account') {
      t.scene('Account');
      const jobs = watchJobs();
      const pill = document.querySelector('#creditsPill');
      const shown = pill && !pill.hidden;
      t.metric('creditsShown', shown ? 1 : 0);
      t.metric('credits', Number(document.querySelector('#creditsCount')?.textContent.replace(/[^\d]/g, '')) || 0);
      if (!shown) t.problem('bug', 'the credits pill is not on the bar');
      // The credits pill opens the sheet.
      pill?.click();
      const open = await until(() => document.querySelector('#accountDialog[open]'), 5000, 100);
      if (!open) t.problem('bug', 'the credits pill did not open the account sheet');
      let packs = 0, plans = 0;
      if (open) {
        await until(() => document.querySelector('#packs .acct-pack, #packs .acct-note'), 6000, 150);
        await until(() => document.querySelector('#plans .acct-pack, #plans .acct-note, #plans .plan-current'), 6000, 150);
        packs = document.querySelectorAll('#packs .acct-pack').length;
        plans = document.querySelectorAll('#plans .acct-pack, #plans .plan-current').length;
        const sheetText = document.querySelector('#accountDialog').textContent;
        t.metric('packs', packs); t.metric('plans', plans);
        t.metric('sheetShowsBalance', document.querySelector('#accountCredits')?.textContent.trim() ? 1 : 0);
        t.metric('sheetShowsWho', document.querySelector('#accountName')?.textContent.trim() ? 1 : 0);
        t.event(`account-sheet: ${packs} packs, ${plans} plans`);
        if (options?.broken) { document.querySelector('#packs')?.replaceChildren(); document.querySelector('#plans')?.replaceChildren(); packs = document.querySelectorAll('#packs .acct-pack').length; plans = 0; }
        // Packs and plans come from Stripe's set-up: where it isn't open here the sheet says so in words (a note), never nothing.
        if (!packs && !document.querySelector('#packs .acct-note')) t.problem('bug', 'the account sheet shows no credit packs and no note about them');
        if (!plans && !document.querySelector('#plans .acct-note')) t.problem('bug', 'the account sheet shows no monthly plans and no note about them');
        if (!/credit/i.test(sheetText)) t.problem('bug', 'the account sheet does not mention credits');
        pressOn(document.querySelector('#accountDialog'), 'Escape');
        document.querySelector('#accountClose')?.click();
        t.metric('sheetCloses', await until(() => !document.querySelector('#accountDialog[open]'), 3000, 100) ? 1 : 0);
      }
      // The Help menu: its rows, the shortcuts overlay, and Terms and Privacy (the links, and that the pages say so).
      click('#helpBtn');
      const menu = await until(() => document.querySelector('.menu .menu-item'), 3000, 100);
      const rows = [...document.querySelectorAll('.menu .menu-item')].map((b) => b.textContent.trim());
      t.metric('helpRows', rows.length);
      t.event(`help-menu: ${rows.join(' | ')}`);
      if (!menu) t.problem('bug', 'the Help menu did not open');
      const links = [...document.querySelectorAll('.menu-links a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') }));
      const terms = links.find((l) => /terms/i.test(l.text)), privacy = links.find((l) => /privacy/i.test(l.text));
      t.metric('termsLink', terms ? 1 : 0); t.metric('privacyLink', privacy ? 1 : 0);
      if (!terms) t.problem('bug', 'the Help menu has no Terms link');
      if (!privacy) t.problem('bug', 'the Help menu has no Privacy link');
      for (const [name, l] of [['terms', terms], ['privacy', privacy]]) {
        if (!l) continue;
        const page = await fetch(l.href.split('#')[0]).then((r) => r.ok ? r.text() : '').catch(() => '');
        const there = page.includes(`id="${name}"`);
        t.metric(`${name}Page`, there ? 1 : 0);
        t.event(there ? `${name}-page-has-its-section` : `${name}-page-missing`);
        if (!there) t.problem('bug', `${l.href} does not have a ${name} section`);
      }
      const sc = [...document.querySelectorAll('.menu .menu-item')].find((b) => /shortcuts/i.test(b.textContent));
      if (sc) {
        sc.click();
        const pop = await until(() => document.querySelector('#shortcutsPop kbd'), 3000, 100);
        t.metric('shortcutKeys', document.querySelectorAll('#shortcutsPop kbd').length);
        t.event(pop ? 'shortcuts-overlay-open' : 'no-shortcuts-overlay');
        if (!pop) t.problem('bug', 'the shortcuts overlay did not open');
        await sleep(600);
        pressOn(document.body, 'Escape');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        t.metric('shortcutsClose', await until(() => !document.querySelector('#shortcutsPop'), 3000, 100) ? 1 : 0);
      } else t.problem('bug', 'the Help menu has no Keyboard shortcuts row');
      click('#helpBtn'); // closes the menu if still open
      const started = jobs.sent.length;
      jobs.stop();
      t.metric('jobsStarted', started);
      if (started) t.problem('blocker', `the account screens started ${started} job(s)`);
      t.finish(open && menu && !started ? 'done' : 'stuck');
      return;
    }
    if (id === 'export') {
      t.scene('Export');
      const jobs = watchJobs();
      const r = await api(`/v1/assets?${new URLSearchParams({ limit: '40', project: state.user.project, kind: 'video' })}`).catch(() => null);
      const vids = (r?.items ?? []).filter((a) => a.kind === 'video' && a.meta?.duration > 1).slice(0, 2);
      t.metric('videos', vids.length);
      if (!vids.length) { jobs.stop(); t.note('The test account has no clips in its library: nothing to cut'); t.finish('done'); return; }
      await until(() => activeScene(), 10000);
      // Setup shortcut (named): a fresh video scene with the clips back to back on its main track, 2 s each: a plain cut.
      made = await newScene('video', { title: `Playtest export ${new Date().toISOString().slice(0, 16)}` });
      if (!await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000)) { jobs.stop(); t.note('the new scene did not open'); t.finish('stuck'); return; }
      const track = mainTrack()?.id;
      for (const a of vids) {
        const c = addClip({ track, asset: a.id, kind: 'video', duration: a.meta.duration, label: a.title || 'clip' });
        setClip(c.id, { out: Math.min(a.meta.duration, 2) }, { history: false });
      }
      const len = docLength();
      t.metric('cutSeconds', Math.round(len * 10) / 10);
      t.event('cut-built');
      // The action: the bar's Export button, then Export video, as a person presses them.
      const action = await until(() => { const b = document.querySelector('#sceneAction'); return b && !b.hidden; }, 5000, 100);
      if (!action) { jobs.stop(); t.problem('bug', 'the bar has no Export button for a video scene'); t.finish('stuck'); return; }
      click('#sceneAction');
      if (!await until(() => document.querySelector('#exportDialog[open]'), 5000, 100)) { jobs.stop(); t.problem('bug', 'the Export sheet did not open'); t.finish('stuck'); return; }
      t.metric('exportNote', document.querySelector('#exportNote')?.textContent.trim() ? 1 : 0);
      t.event(`export-sheet: ${document.querySelector('#exportNote')?.textContent.trim()}`);
      if (options?.broken) document.querySelector('#exportGo').disabled = true;  // a sheet whose button never wakes
      const go = document.querySelector('#exportGo');
      if (go.disabled) { jobs.stop(); t.problem('bug', 'Export video is disabled for a plain cut of existing clips'); click('#exportClose'); t.finish('stuck'); return; }
      const t0 = performance.now();
      go.click();
      t.event('export-pressed');
      const video = await until(() => document.querySelector('#exportResult video'), 120000, 300) ? document.querySelector('#exportResult video') : null;
      const failed = document.querySelector('#exportError:not([hidden])')?.textContent;
      t.metric('exportSeconds', Math.round((performance.now() - t0) / 100) / 10);
      if (!video) { jobs.stop(); t.problem('bug', `the export gave no file${failed ? `: ${failed}` : ''}`); click('#exportClose'); t.finish('stuck'); return; }
      t.event('export-finished');
      // The file plays: its metadata loads, it has a picture and a length, and the clock moves when it's played.
      const meta = await until(() => video.readyState >= 1 && video.duration > 0, 20000, 150);
      t.metric('fileSeconds', Math.round((video.duration || 0) * 10) / 10);
      t.metric('fileWidth', video.videoWidth || 0); t.metric('fileHeight', video.videoHeight || 0);
      video.muted = true;
      let played = false;
      try { await video.play(); played = await until(() => video.currentTime > 0.3, 8000, 100); } catch (e) { t.note(`play() refused: ${e.message}`); }
      t.metric('filePlays', played ? 1 : 0);
      t.event(played ? 'file-plays' : 'file-does-not-play');
      if (!meta || !video.videoWidth) t.problem('bug', 'the exported file has no picture');
      else if (!played) t.problem('bug', 'the exported file does not play');
      if (meta && Math.abs(video.duration - len) > 1.5) t.problem('bug', `the file is ${video.duration.toFixed(1)} s but the cut is ${len.toFixed(1)} s`);
      video.pause();
      // Only the cut's own CPU render may have run (video.compose, and video.still for pictures): nothing on a GPU.
      const gpu = jobs.sent.filter((x) => !/^(video\.compose|video\.still|media\.normalize)$/.test(x));
      jobs.stop();
      t.metric('jobsStarted', jobs.sent.length); t.metric('gpuJobsStarted', gpu.length);
      t.note(`Jobs: ${jobs.sent.join(', ') || 'none'}`);
      if (gpu.length) t.problem('blocker', `Export started a job that isn't the CPU render: ${gpu.join(', ')}`);
      click('#exportClose');
      t.finish(meta && played && !gpu.length ? 'done' : 'stuck');
      return;
    }
    if (id === 'media') {
      t.scene('Media');
      click('#paneTabs button[data-pane="media"]');
      const tiles = await until(() => document.querySelectorAll('#mediaGrid .tile').length > 0 || document.querySelector('#mediaGrid .empty-note'), 15000);
      const n = document.querySelectorAll('#mediaGrid .tile:not(.busy)').length;
      t.metric('tiles', n);
      if (n) {
        document.querySelector('#mediaGrid .tile:not(.busy)').click();
        const chip = await until(() => [...document.querySelectorAll('#aiContext .ctx-chip')].some((c) => /Media/.test(c.textContent)), 5000);
        t.metric('aiKnowsPick', chip ? 1 : 0);
        t.event('picked');
      }
      t.finish(tiles ? 'done' : 'stuck');
      return;
    }
    if (id === 'guide') {
      t.scene('Guided first project');
      // Setup shortcut (named): the guide opens as it does for a brand-new account (the test account is old).
      await until(() => activeScene(), 10000);
      made = await newScene('video', { title: `Playtest guide ${new Date().toISOString().slice(0, 16)}` });
      if (!await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000)) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      startGuide({ force: true });
      const at = (n) => until(() => document.querySelector(`#guide[data-step="${n}"]`), 8000, 100);
      if (!await at(0)) { t.note('the guide did not open'); t.finish('stuck'); return; }
      t.event('guide-open');
      click('#guide [data-idea]');                    // 1 pick an idea
      await until(() => document.querySelector('#guide [data-next]'), 3000, 100);
      click('#guide [data-next]');
      t.event('guide-step-1-idea');
      if (!await at(1)) { t.finish('stuck'); return; }
      // 2 the picture: no GPU is spent in a playtest, so the library's own newest picture stands in (named shortcut)
      click('#guide [data-media]');
      if (!await at(2)) { t.note('The test account has no picture in its library: nothing to put on the timeline'); t.finish('done'); return; }
      t.event('guide-step-2-picture');
      click('#guide [data-add]');                     // 3 onto the timeline
      if (!await at(3)) { t.finish('stuck'); return; }
      t.metric('clips', P.doc.clips.length);
      t.event('guide-step-3-timeline');
      press('Home');
      press(' ');                                     // 4 play, with the key a person would press
      const finished = await at(4);
      if (isPlaying()) press(' ');
      t.event(finished ? 'guide-step-4-played' : 'guide-play-stalled');
      click('#guide [data-done]');
      t.metric('guideDismissed', guideOpen() ? 0 : 1);
      t.finish(finished && !guideOpen() ? 'done' : 'stuck');
      return;
    }
    if (id === 'progress') {
      t.scene('Progress and failure');
      // Setup shortcut (named): a CPU-only transform with a step that does not exist, so it fails by itself. No GPU is used.
      const pics = ((await api(`/v1/assets?${new URLSearchParams({ limit: '5', project: state.user.project, kind: 'image' })}`).catch(() => null))?.items ?? []);
      if (!pics.length) { t.note('The test account has no picture in its library'); t.finish('done'); return; }
      await until(() => activeScene(), 10000);
      made = await newScene('video', { title: `Playtest progress ${new Date().toISOString().slice(0, 16)}` });
      if (!await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000)) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      runJob({ tool: 'image.transform', inputs: { image: `asset:${pics[0].id}` }, params: { ops: [{ op: 'nonsense' }] }, label: 'Playtest fix', place: { track: mainTrack().id, start: 0, seconds: 3 } }).catch(() => {});
      const clip = () => P.doc.clips.find((c) => c.label === 'Playtest fix');
      t.event('job-started');
      const label = () => document.querySelector('#tlTracks .clip .clip-label')?.textContent ?? '';
      if (await until(() => clip()?.pending && document.querySelector('#tlTracks .clip-act.stop'), 8000, 50)) { t.event('running-shows-stop'); t.note(`running: ${label()}`); }
      const failed = await until(() => clip()?.failed && document.querySelector('#tlTracks .clip-act.retry'), 60000);
      t.metric('failedShown', failed ? 1 : 0);
      if (failed) { t.event('failed-shows-cause-and-retry'); t.note(`failed: ${clip().failed}`); }
      if (failed) {
        click('#tlTracks .clip-act.retry');
        const again = await until(() => clip()?.pending, 8000, 50);
        t.metric('retryStarted', again ? 1 : 0);
        if (again) t.event('retry-started');
        await until(() => clip()?.failed, 60000);
      }
      t.finish(failed ? 'done' : 'stuck');
      return;
    }
    if (id === 'savebadge') {
      t.scene('Save badge');
      await until(() => activeScene(), 10000);
      made = await newScene('video', { title: `Playtest save ${new Date().toISOString().slice(0, 16)}` });
      if (!await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000)) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      const badge = () => document.querySelector('#saveState');
      const track = addTrack({ name: 'Save', role: 'any' }).id;
      addClip({ track, kind: 'fill', color: '#203a5c', start: 0, seconds: 2, history: false });
      const sawSaving = await until(() => /Saving/.test(badge().textContent), 3000, 20);
      t.metric('showsSaving', sawSaving ? 1 : 0);
      const saved = await until(() => /^Saved \d/.test(badge().textContent), 15000, 50);
      t.metric('showsSaved', saved ? 1 : 0); t.event(saved ? 'badge-saved' : 'badge-not-saved');
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      window.dispatchEvent(new Event('offline'));
      addClip({ track, kind: 'fill', color: '#5c2040', start: 3, seconds: 2, history: false });
      const off = await until(() => /Offline/.test(badge().textContent), 5000, 50);
      t.metric('showsOffline', off ? 1 : 0); t.event(off ? 'badge-offline' : 'badge-not-offline');
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
      window.dispatchEvent(new Event('online'));
      const back = await until(() => /^Saved \d/.test(badge().textContent) && !P.dirty, 15000, 50);
      t.metric('savedAfterReconnect', back ? 1 : 0); t.event(back ? 'badge-saved-after-reconnect' : 'badge-not-saved-after-reconnect');
      const n = P.doc.clips.length;
      t.note(`clips before reload: ${n}`);
      t.finish(sawSaving && saved && off && back ? 'done' : 'stuck');
      return;
    }
    if (id === 'audio-mix') {
      t.scene('Audio mix');
      const jobs = watchJobs();
      await until(() => activeScene(), 10000);
      // Setup shortcut (named): two short tones uploaded as WAV (music 20 s, voice 4 s), then a video scene with Music + Voice.
      const stamp = Date.now();
      const tone = (seconds, freq) => {
        const rate = 22050, n = Math.floor(seconds * rate);
        const pcm = new Int16Array(n);
        for (let i = 0; i < n; i++) pcm[i] = Math.sin(2 * Math.PI * freq * i / rate) * 0.45 * 0x7fff;
        const bytes = pcm.byteLength, out = new DataView(new ArrayBuffer(44 + bytes));
        const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
        w(0, 'RIFF'); out.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt ');
        out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, rate, true);
        out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, bytes, true);
        new Uint8Array(out.buffer, 44).set(new Uint8Array(pcm.buffer));
        return new Blob([out.buffer], { type: 'audio/wav' });
      };
      const up = async (blob, name) => {
        const r = await fetch(`/v1/assets?project=${encodeURIComponent(state.user.project)}&title=${encodeURIComponent(name)}`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav', 'X-Filename': encodeURIComponent(name) }, body: blob,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `upload ${r.status}`);
        return { id: j.id ?? j.asset?.id, duration: j.meta?.duration ?? j.asset?.meta?.duration };
      };
      let musicAsset, voiceAsset;
      try {
        musicAsset = await up(tone(20, 220), `playtest-music-${stamp}.wav`);
        voiceAsset = await up(tone(4, 660), `playtest-voice-${stamp}.wav`);
      } catch (e) {
        jobs.stop();
        t.problem('bug', `could not upload tones: ${e.message || e}`);
        t.finish('stuck');
        return;
      }
      t.metric('musicUploaded', musicAsset?.id ? 1 : 0);
      t.metric('voiceUploaded', voiceAsset?.id ? 1 : 0);
      t.event('tones-uploaded');
      made = await newScene('video', { title: `Playtest audio-mix ${new Date().toISOString().slice(0, 16)}` });
      if (!await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000)) {
        jobs.stop(); t.note('the new scene did not open'); t.finish('stuck'); return;
      }
      const musicTr = tracks().find((x) => /music/i.test(x.name))?.id;
      const voiceTr = tracks().find((x) => /voice/i.test(x.name))?.id;
      if (!musicTr || !voiceTr) { jobs.stop(); t.problem('bug', 'Music or Voice track missing on a new video'); t.finish('stuck'); return; }
      const musicDur = musicAsset.duration || 20;
      const voiceDur = voiceAsset.duration || 4;
      const music = addClip({ track: musicTr, asset: musicAsset.id, kind: 'audio', duration: musicDur, start: 0, label: 'music tone', history: false });
      setClip(music.id, { start: 0, in: 0, out: Math.min(20, musicDur), volume: 1 }, { history: false });
      const voice = addClip({ track: voiceTr, asset: voiceAsset.id, kind: 'audio', duration: voiceDur, start: 8, label: 'voice tone', history: false });
      setClip(voice.id, { start: 8, in: 0, out: Math.min(4, voiceDur) }, { history: false });
      await until(() => document.querySelector(`#tlTracks .clip[data-id="${music.id}"]`), 5000, 50);
      // 1 Waveform on the music clip (peaks cached once per asset).
      const waveEl = () => document.querySelector(`#tlTracks .clip[data-id="${music.id}"] canvas.clip-wave`);
      const peaked = await peaks(musicAsset.id);
      t.metric('peaksCached', peaked?.values?.length ? 1 : 0);
      const same = await peaks(musicAsset.id);
      t.metric('peaksOnce', same === peaked ? 1 : 0);
      const waved = await until(() => {
        const cv = waveEl();
        if (!cv || cv.width < 2 || cv.height < 2) return false;
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
        return false;
      }, 8000, 100);
      t.metric('waveformDrawn', waved ? 1 : 0);
      t.event(waved ? 'waveform-on-clip' : 'waveform-missing');
      if (!waved) t.problem('bug', 'audio clip has no drawn waveform on the timeline');
      // 2 Fade-in handle: drag the top-left fade dot so the start is quiet.
      const el = document.querySelector(`#tlTracks .clip[data-id="${music.id}"]`);
      const fade = el?.querySelector('.fade-h.in');
      t.metric('fadeHandle', fade ? 1 : 0);
      if (!fade) { jobs.stop(); t.problem('bug', 'no fade-in handle on the music clip'); t.finish('stuck'); return; }
      // Real pointer press first so audio unlocks and the drag registers.
      const r = fade.getBoundingClientRect();
      const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
      const px = () => el.getBoundingClientRect().width / Math.max(0.1, clipLength(music));
      fade.dispatchEvent(new PointerEvent('pointerdown', { clientX: x0, clientY: y0, button: 0, pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true }));
      for (let i = 1; i <= 10; i++) {
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x0 + (1.2 * px() * i) / 10, clientY: y0, pointerId: 1, pointerType: 'mouse', bubbles: true }));
        await sleep(30);
      }
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: x0 + 1.2 * px(), clientY: y0, pointerId: 1, pointerType: 'mouse', bubbles: true }));
      await sleep(150);
      const faded = (P.doc.clips.find((c) => c.id === music.id)?.fadeIn ?? 0) >= 0.8;
      t.metric('fadeInSet', faded ? 1 : 0);
      t.event(faded ? 'fade-in-dragged' : 'fade-in-missing');
      const musicNow = () => P.doc.clips.find((c) => c.id === music.id);
      const g0 = clipGain(musicNow(), 0.05);
      const gMid = clipGain(musicNow(), (musicNow()?.fadeIn ?? 1) / 2);
      const g1 = clipGain(musicNow(), Math.max(1.5, (musicNow()?.fadeIn ?? 1) + 0.2));
      const fadeSmooth = faded && g0 < gMid && gMid < g1 && g0 < g1 * 0.35 && g1 > 0.7;
      t.metric('fadeSmooth', fadeSmooth ? 1 : 0);
      t.event(fadeSmooth ? 'fade-smooth' : `fade-not-smooth g0=${g0.toFixed(3)} g1=${g1.toFixed(3)}`);
      if (!faded) t.problem('bug', 'dragging the fade handle did not set fadeIn');
      if (faded && !fadeSmooth) t.problem('bug', 'fade-in gain is not a smooth ramp');
      // 3 Auto-duck: Voice under Music → ~10 dB in the preview maths and in an offline mixdown loudness readout.
      const spans = dialogueSpans(P.doc.clips, trackOf, clipEnd);
      const openG = duckAt(2, spans);
      const underG = duckAt(10, spans);
      const afterG = duckAt(14, spans);
      const duckedDb = -20 * Math.log10(Math.max(1e-9, underG / Math.max(1e-9, openG)));
      t.metric('duckOpen', Math.round(openG * 1000) / 1000);
      t.metric('duckUnder', Math.round(underG * 1000) / 1000);
      t.metric('duckAfter', Math.round(afterG * 1000) / 1000);
      t.metric('duckDb', Math.round(duckedDb * 10) / 10);
      const duckOk = Math.abs(openG - 1) < 0.02 && Math.abs(underG - DUCK_TO) < 0.03 && Math.abs(afterG - 1) < 0.05 && duckedDb > 9 && duckedDb < 11;
      t.metric('autoDuckPreview', duckOk ? 1 : 0);
      t.event(duckOk ? 'auto-duck-preview' : `auto-duck-preview-bad open=${openG} under=${underG}`);
      if (!duckOk) t.problem('bug', `preview duck is ${duckedDb.toFixed(1)} dB (want ~10)`);
      // Export plan (video.compose audio rows): Music ducks under Voice; a muted Voice does not.
      const plan = composeAudioPlan(P.doc.clips.filter((c) => c.kind === 'audio' && c.asset), trackOf, { lengthOf: clipLength });
      const musicRow = plan.find((r) => r.duck);
      const voiceRow = plan.find((r) => r.dialogue);
      t.metric('exportDuck', musicRow?.duck && Math.abs((musicRow.duckTo ?? 0) - DUCK_TO) < 0.01 ? 1 : 0);
      t.metric('exportDialogue', voiceRow ? 1 : 0);
      const mutedPlan = composeAudioPlan(
        P.doc.clips.filter((c) => c.kind === 'audio' && c.asset).map((c) => (c.id === voice.id ? { ...c, muted: true } : c)),
        trackOf,
        { lengthOf: clipLength },
      );
      const mutedOk = !mutedPlan.some((r) => r.dialogue) && !mutedPlan.some((r) => r.duck);
      t.metric('exportMutedNoDuck', mutedOk ? 1 : 0);
      t.event(musicRow && voiceRow && mutedOk ? 'export-plan-ok' : 'export-plan-bad');
      if (!(musicRow && voiceRow && mutedOk)) t.problem('bug', 'export audio plan missing duck/dialogue or ducks a muted voice');

      // Offline mix loudness: mute the voice in the mix so RMS is the music bed, but pass the real dialogue spans so ducking still applies.
      let mixOk = false;
      try {
        const duckSpans = dialogueSpans(P.doc.clips, trackOf, clipEnd, audible);
        setClip(voice.id, { muted: true }, { history: false });
        const buf = await mixdown(0, 20, 44100, duckSpans);
        const rms = (from, dur) => {
          const a = Math.floor(from * buf.sampleRate), n = Math.floor(dur * buf.sampleRate);
          let s = 0, c = 0;
          for (let ch = 0; ch < buf.numberOfChannels; ch++) {
            const d = buf.getChannelData(ch);
            for (let i = a; i < Math.min(d.length, a + n); i++) { s += d[i] * d[i]; c++; }
          }
          return 10 * Math.log10(s / Math.max(1, c) + 1e-20);
        };
        const openL = rms(1.5, 0.5);
        const underL = rms(9.5, 0.5);
        const afterL = rms(13.5, 0.5);
        const mixDb = openL - underL;
        t.metric('mixOpenDb', Math.round(openL * 10) / 10);
        t.metric('mixUnderDb', Math.round(underL * 10) / 10);
        t.metric('mixAfterDb', Math.round(afterL * 10) / 10);
        t.metric('mixDuckDb', Math.round(mixDb * 10) / 10);
        mixOk = mixDb > 8 && mixDb < 12 && Math.abs(openL - afterL) < 2.5;
        t.metric('autoDuckMixdown', mixOk ? 1 : 0);
        t.event(mixOk ? 'auto-duck-mixdown' : `auto-duck-mixdown-bad dip=${mixDb.toFixed(1)}`);
        if (!mixOk) t.problem('bug', `mixdown duck is ${mixDb.toFixed(1)} dB (want ~10)`);
        setClip(voice.id, { muted: false }, { history: false });
      } catch (e) {
        t.problem('bug', `mixdown failed: ${e.message || e}`);
        t.metric('autoDuckMixdown', 0);
        setClip(voice.id, { muted: false }, { history: false });
      }
      // Play the full 20 s cut so the footage covers open music → ducked under the line → back up (real Space).
      seek(0);
      press(' ');
      const through = await until(() => P.playhead >= 19.5, 45000, 100);
      if (isPlaying()) press(' ');
      t.metric('played20s', through ? 1 : 0);
      t.event(through ? 'played-20s-cut' : 'play-20s-stalled');
      if (!through) t.problem('bug', 'the 20-second test cut did not play through');
      const gpu = jobs.sent.filter((x) => !/^(media\.normalize)$/.test(x));
      jobs.stop();
      t.metric('jobsStarted', jobs.sent.length);
      if (gpu.length) t.problem('blocker', `audio-mix started a paid job: ${gpu.join(', ')}`);
      t.finish(waved && faded && fadeSmooth && duckOk && mixOk && musicRow && voiceRow && mutedOk && through && !gpu.length ? 'done' : 'stuck');
      return;
    }
    if (id === 'editing') {
      t.scene('Timeline editing');
      await until(() => activeScene(), 10000);
      // Setup shortcut (named): a fresh video scene with two color clips on a free track. Everything after is pointer and keys.
      made = await newScene('video', { title: `Playtest editing ${new Date().toISOString().slice(0, 16)}` });
      if (!await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000)) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      const track = addTrack({ name: 'Edit', role: 'any' }).id;
      const A = addClip({ track, kind: 'fill', color: '#203a5c', start: 0, seconds: 3, history: false });
      const B = addClip({ track, kind: 'fill', color: '#5c2040', start: 5, seconds: 3, history: false });
      setClip(A.id, { start: 0 }, { history: false }); setClip(B.id, { start: 5 }, { history: false });
      await until(() => document.querySelector(`#tlTracks .clip[data-id="${B.id}"]`), 5000, 50);
      const clipOf = (c) => P.doc.clips.find((x) => x.id === c.id);
      const elOf = (c) => document.querySelector(`#tlTracks .clip[data-id="${c.id}"]`);
      const pxPerSec = () => { const e = elOf(A); return e.getBoundingClientRect().width / 3; };
      /** A mouse drag by real pointer events: down on the element, moves in steps, up. */
      const drag = async (el, dxPx, { handle } = {}) => {
        const r = (handle ? el.querySelector(handle) : el).getBoundingClientRect();
        const x0 = handle === '.h-r' ? r.left + r.width / 2 : handle ? r.left + r.width / 2 : r.left + r.width / 2, y0 = r.top + r.height / 2;
        const ev = (type, x, target) => target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y0, button: 0, pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true }));
        ev('pointerdown', x0, handle ? el.querySelector(handle) : el);
        for (let i = 1; i <= 12; i++) { window.dispatchEvent(new PointerEvent('pointermove', { clientX: x0 + (dxPx * i) / 12, clientY: y0, pointerId: 1, pointerType: 'mouse', bubbles: true })); await sleep(30); }
        const lit = Boolean(document.querySelector('.tl-snap'));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: x0 + dxPx, clientY: y0, pointerId: 1, pointerType: 'mouse', bubbles: true }));
        await sleep(150);
        return lit;
      };
      // 1 Snap to a neighbour: B dragged to just short of where A ends (3 s) lands on it exactly.
      const before = snapStats.hits;
      const lit1 = await drag(elOf(B), (3.03 - 5) * pxPerSec());
      t.metric('snapToNeighbour', clipOf(B).start === 3 ? 1 : 0);
      t.metric('snapGuideShown', lit1 ? 1 : 0);
      t.event(clipOf(B).start === 3 ? 'snapped-to-neighbour' : `no-snap-to-neighbour start=${clipOf(B).start}`);
      // Snap to the playhead: park it at 9 s, drag B to just short of it.
      seek(9);
      const lit2 = await drag(elOf(B), (8.97 - 3) * pxPerSec());
      t.metric('snapToPlayhead', clipOf(B).start === 9 ? 1 : 0);
      t.event(clipOf(B).start === 9 ? 'snapped-to-playhead' : `no-snap-to-playhead start=${clipOf(B).start}`);
      t.metric('snapHits', snapStats.hits - before);
      t.metric('snapGuideShown2', lit2 ? 1 : 0);
      const snapped = clipOf(B).start === 9 && snapStats.hits - before >= 2;
      // 2 The shortcuts overlay: the ? key.
      press('?', { shiftKey: true });
      const overlay = await until(() => document.querySelector('#shortcutsPop kbd'), 3000, 50);
      t.metric('shortcutsOverlay', overlay ? 1 : 0);
      t.event(overlay ? 'shortcuts-overlay-open' : 'no-shortcuts-overlay');
      await sleep(800);
      press('?', { shiftKey: true });
      await until(() => !document.querySelector('#shortcutsPop'), 3000, 50);
      // 3 Undo and redo: move, trim, delete.
      const at = () => clipOf(B).start;
      press('z', { ctrlKey: true });
      t.metric('undoMove', at() === 3 ? 1 : 0);
      press('z', { ctrlKey: true, shiftKey: true });
      t.metric('redoMove', at() === 9 ? 1 : 0);
      t.event(`move undo/redo ${at() === 9 ? 'ok' : 'failed'}`);
      const len0 = clipOf(B).out - clipOf(B).in;
      await drag(elOf(B), -1 * pxPerSec(), { handle: '.h-r' });
      const trimmed = clipOf(B).out - clipOf(B).in;
      t.metric('trimmed', trimmed < len0 - 0.3 ? 1 : 0);
      press('z', { ctrlKey: true });
      t.metric('undoTrim', Math.abs(clipOf(B).out - clipOf(B).in - len0) < 0.01 ? 1 : 0);
      press('z', { ctrlKey: true, shiftKey: true });
      t.metric('redoTrim', Math.abs(clipOf(B).out - clipOf(B).in - trimmed) < 0.01 ? 1 : 0);
      t.event('trim undo/redo');
      await drag(elOf(B), 0);                      // a click selects it
      press('Delete');
      const gone = !clipOf(B);
      t.metric('deleted', gone ? 1 : 0);
      press('z', { ctrlKey: true });
      const back = Boolean(clipOf(B));
      t.metric('undoDelete', back ? 1 : 0);
      press('z', { ctrlKey: true, shiftKey: true });
      t.metric('redoDelete', !clipOf(B) ? 1 : 0);
      t.event('delete undo/redo');
      press('z', { ctrlKey: true });
      t.finish(snapped && overlay && gone && back ? 'done' : 'stuck');
      return;
    }
    if (id === 'transitions') {
      t.scene('Clip transitions');
      await until(() => activeScene(), 10000);
      // Setup shortcut (named): a fresh video with two adjacent color clips on the main track (3 s each).
      made = await newScene('video', { title: `Playtest transitions ${new Date().toISOString().slice(0, 16)}` });
      if (!await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000)) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      const track = mainTrack()?.id;
      const A = addClip({ track, kind: 'fill', color: '#1a5cff', start: 0, seconds: 3, history: false });
      const B = addClip({ track, kind: 'fill', color: '#ff5c1a', start: 3, seconds: 3, history: false });
      setClip(A.id, { start: 0 }, { history: false });
      setClip(B.id, { start: 3 }, { history: false });
      await until(() => document.querySelector(`.tl-join[data-join="${A.id}"], .tl-xf[data-join="${A.id}"]`), 5000, 50);
      t.event('join-ready');
      const clipOf = (c) => P.doc.clips.find((x) => x.id === c.id);
      const joinBtn = () => document.querySelector(`.tl-join[data-join="${A.id}"]`);
      const xfEl = () => document.querySelector(`.tl-xf[data-join="${A.id}"]`);
      /** Real pointer press (touch type so phone criteria count): down, optional moves, up. */
      const finger = async (el, { dx = 0, dy = 0, steps = 10 } = {}) => {
        const r = el.getBoundingClientRect();
        const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
        const opts = { pointerId: 1, pointerType: 'touch', bubbles: true, cancelable: true, button: 0 };
        el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x0, clientY: y0 }));
        for (let i = 1; i <= steps; i++) {
          window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x0 + (dx * i) / steps, clientY: y0 + (dy * i) / steps }));
          await sleep(25);
        }
        // Window listeners (drag / tap-to-open) and the element's own pointerup both need the lift.
        const up = new PointerEvent('pointerup', { ...opts, clientX: x0 + dx, clientY: y0 + dy });
        window.dispatchEvent(up);
        if (!dx && !dy) el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x0, clientY: y0 }));
        await sleep(120);
      };
      // 1 Add a crossfade: tap the + join, pick Crossfade from the menu.
      const plus = joinBtn();
      t.metric('joinPlus', plus ? 1 : 0);
      if (!plus) { t.problem('bug', 'no + join between adjacent main-track clips'); t.finish('stuck'); return; }
      await finger(plus, { steps: 1 });
      const menu = await until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => /Crossfade/i.test(b.textContent)), 3000, 50);
      t.metric('typeMenu', menu ? 1 : 0);
      if (!menu) { t.problem('bug', 'transition type menu did not open'); t.finish('stuck'); return; }
      menu.click(); // menu items are buttons; the open was a touch pointer on the join
      const added = await until(() => clipOf(A)?.transition === 'crossfade' && xfEl(), 3000, 50);
      t.metric('crossfadeAdded', added ? 1 : 0);
      t.event(added ? 'crossfade-added' : 'crossfade-missing');
      if (!added) { t.problem('bug', 'tapping Crossfade did not set a transition on the join'); t.finish('stuck'); return; }
      // 2 Resize by dragging the right edge of the block (about +0.4 s).
      const before = clipOf(A).transitionSeconds ?? 0.5;
      const handle = xfEl().querySelector('.tl-xf-h.right');
      const pxPerSec = () => {
        const e = document.querySelector(`#tlTracks .clip[data-id="${A.id}"]`);
        return e ? e.getBoundingClientRect().width / 3 : 60;
      };
      await finger(handle || xfEl(), { dx: 0.45 * pxPerSec() });
      const resized = (clipOf(A).transitionSeconds ?? 0) > before + 0.15;
      t.metric('resized', resized ? 1 : 0);
      t.metric('transitionSeconds', clipOf(A).transitionSeconds ?? 0);
      t.event(resized ? 'transition-resized' : `no-resize was=${before} now=${clipOf(A).transitionSeconds}`);
      // 3 Change type: tap the block, pick Dip to black.
      await finger(xfEl(), { steps: 1 });
      const dip = await until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => /Dip to black/i.test(b.textContent)), 3000, 50);
      if (dip) dip.click();
      const typed = clipOf(A)?.transition === 'fadeblack';
      t.metric('typeChanged', typed ? 1 : 0);
      t.event(typed ? 'type-dip-black' : `type=${clipOf(A)?.transition}`);
      // Put a crossfade back for the preview and export checks (criterion 1 + 2).
      await finger(xfEl(), { steps: 1 });
      const xfItem = await until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => /Crossfade/i.test(b.textContent)), 3000, 50);
      if (xfItem) xfItem.click();
      setClip(A.id, { transition: 'crossfade', transitionSeconds: 0.8 }, { history: false });
      await until(() => clipOf(A)?.transition === 'crossfade', 2000, 50);
      // 4 Preview: scrub into the join; transitionAt must report a blend (both alphas mid-range).
      const join = 3;
      const sec = clipOf(A).transitionSeconds ?? 0.8;
      seek(join - sec / 2);
      await sleep(200);
      const mid = transitionAt(P.playhead);
      const blended = Boolean(mid && mid.type === 'crossfade' && mid.sample.aOut > 0.2 && mid.sample.aIn > 0.2);
      t.metric('previewBlend', blended ? 1 : 0);
      t.metric('previewAOut', Math.round((mid?.sample.aOut ?? 0) * 100));
      t.metric('previewAIn', Math.round((mid?.sample.aIn ?? 0) * 100));
      t.event(blended ? 'preview-crossfade' : 'preview-no-blend');
      if (!blended) t.problem('bug', 'scrubbing the join did not show a crossfade blend in the preview maths');
      // 5 Export: browser path (fills) records the timeline; length stays the cut (fills force layered render).
      //    Also prove the compose plan would shorten by the transition when the cut is plain (ops already tested).
      const jobs = watchJobs();
      const action = await until(() => { const b = document.querySelector('#sceneAction'); return b && !b.hidden; }, 5000, 100);
      if (action) {
        click('#sceneAction');
        if (await until(() => document.querySelector('#exportDialog[open]'), 5000, 100)) {
          t.event(`export-sheet: ${document.querySelector('#exportNote')?.textContent.trim()}`);
          const go = document.querySelector('#exportGo');
          if (go && !go.disabled) {
            const t0 = performance.now();
            go.click();
            t.event('export-pressed');
            const video = await until(() => document.querySelector('#exportResult video'), 120000, 300);
            t.metric('exportSeconds', Math.round((performance.now() - t0) / 100) / 10);
            if (video) {
              await until(() => video.readyState >= 1 && video.duration > 0, 20000, 150);
              t.metric('fileSeconds', Math.round((video.duration || 0) * 10) / 10);
              // Layered (fills): duration ≈ timeline length. Compose would be shorter by the transition.
              const expect = docLength();
              const close = Math.abs((video.duration || 0) - expect) < 1.5;
              t.metric('exportMatchesJoin', close ? 1 : 0);
              t.event(close ? 'export-has-transition-cut' : `export-len ${video.duration} vs ${expect}`);
              if (!close) t.problem('bug', `exported length ${video.duration?.toFixed?.(1)} s does not match the cut (${expect} s)`);
              click('#exportClose');
            } else {
              t.problem('bug', `export gave no file${document.querySelector('#exportError:not([hidden])')?.textContent ? `: ${document.querySelector('#exportError').textContent}` : ''}`);
              click('#exportClose');
            }
          } else {
            t.note('Export video disabled for this cut');
            click('#exportClose');
          }
        }
      }
      const gpu = jobs.sent.filter((x) => !/^(video\.compose|video\.still|media\.normalize)$/.test(x));
      jobs.stop();
      t.metric('gpuJobsStarted', gpu.length);
      if (gpu.length) t.problem('blocker', `transitions export started a GPU job: ${gpu.join(', ')}`);
      const ok = added && resized && typed && blended && !gpu.length;
      t.finish(ok ? 'done' : 'stuck');
      return;
    }
    if (id === 'phoneperf') {
      t.scene('Phone speed');
      if (window.innerWidth > 900) { t.note('Not a phone-sized screen: run this scenario with mobile: true (390x844, touch)'); t.finish('stuck'); return; }
      const list = async (kind) => ((await api(`/v1/assets?${new URLSearchParams({ limit: '40', project: state.user.project, kind })}`).catch(() => null))?.items ?? []).filter((a) => a.meta?.duration > 1);
      const vids = await list('video');
      t.metric('videos', vids.length);
      await until(() => activeScene(), 10000);
      t.metric('sinceNavigationMs', Math.round(performance.now()));
      // Opening a project: from asking for the scene to the editor being usable (the tabs, the picture drawn, the
      // timeline's ruler there), measured with the page's own clock so the CPU slowdown counts.
      const t0 = performance.now();
      made = await newScene('video', { title: `Playtest phone speed ${new Date().toISOString().slice(0, 16)}` });
      const usable = () => activeScene()?.id === made?.id && P.active && P.id === made.id && document.querySelector('#mobileTabs')?.offsetHeight > 0
        && document.querySelector('#tlRuler')?.children.length > 0 && document.querySelector('#stage canvas')?.offsetHeight > 0;
      const opened = await until(usable, 15000, 20);
      const openMs = Math.round(performance.now() - t0);
      t.metric('openMs', openMs); t.event(`editor-usable ${openMs}ms`);
      if (!opened) { t.note('the new scene did not become usable'); t.finish('stuck'); return; }
      const canvasPx = document.querySelector('#stage canvas')?.width ?? 0;
      t.metric('canvasWidthPx', canvasPx);
      // Setup shortcut (named): three clips on the main track for 20 s (library clips, else colors), then words.
      const SEC = 20, n = 3, each = SEC / n, main = mainTrack()?.id;
      for (let i = 0; i < n; i++) {
        const at = i * each;
        if (vids.length) {
          const a = vids[i % vids.length], len = Math.min(each, a.meta.duration);
          const c = addClip({ track: main, asset: a.id, kind: 'video', duration: a.meta.duration, start: at, label: a.title || 'clip', history: false });
          setClip(c.id, { start: at, out: len }, { history: false });
        } else addClip({ track: main, kind: 'fill', color: ['#203a5c', '#5c2040', '#2c5c20'][i], start: at, seconds: each, history: false });
      }
      const len = Math.min(docLength(), SEC);
      t.metric('clips', P.doc.clips.length); t.event('three-clips-ready');
      await sleep(2500);
      resetPlaybackStats();
      press('Home');
      click('#playBtn');
      t.event('play-20s');
      const through = await until(() => P.playhead >= len - 0.1, Math.max(30000, len * 3000), 100);
      if (isPlaying()) click('#playBtn');
      const run = pacingStats();
      t.metric('fps', run.fps); t.metric('p5fps', run.p5fps); t.metric('worstFrameMs', run.worstMs); t.metric('frames', run.frames);
      t.event(through ? `played-20s p5=${run.p5fps}fps` : 'play-stalled');
      t.progress(0.7);
      // Scrubs with the finger: a touch on the ruler at five places; each time the new frame is drawn is measured.
      resetPlaybackStats();
      const ruler = document.querySelector('#tlRuler');
      const r = ruler.getBoundingClientRect();
      for (const f of [0.15, 0.7, 0.35, 0.9, 0.5]) {
        const before = pacingStats().scrubs;
        const x = r.left + Math.max(8, Math.min(r.width - 8, r.width * f));
        const o = { clientX: x, clientY: r.top + r.height / 2, pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
        ruler.dispatchEvent(new PointerEvent('pointerdown', o));
        window.dispatchEvent(new PointerEvent('pointerup', o));
        await until(() => pacingStats().scrubs > before, 3000, 10);
        await sleep(400);
      }
      const sc = pacingStats();
      t.metric('scrubMs', sc.scrubMs); t.metric('scrubs', sc.scrubs);
      t.event(`scrub-to-frame max ${sc.scrubMs}ms of ${sc.scrubs}`);
      const fine = openMs <= 5000 && run.p5fps > 30 && sc.scrubs >= 5 && sc.scrubMs <= 200;
      t.metric('withinBudget', fine ? 1 : 0);
      if (!fine) t.problem('bug', `phone speed over budget: open ${openMs} ms (5000), p5 ${run.p5fps} fps (>30), scrub ${sc.scrubMs} ms (200)`);
      t.finish(through ? 'done' : 'stuck');
      return;
    }
    if (id === 'playback4') {
      t.scene('Four tracks');
      const list = async (kind) => ((await api(`/v1/assets?${new URLSearchParams({ limit: '40', project: state.user.project, kind })}`).catch(() => null))?.items ?? []).filter((a) => a.meta?.duration > 1 || kind === 'image');
      const [vids, pics, sounds] = [await list('video'), await list('image'), await list('audio')];
      t.metric('videos', vids.length); t.metric('pictures', pics.length); t.metric('sounds', sounds.length);
      await until(() => activeScene(), 10000);
      // Setup shortcut (named): a fresh video scene with four tracks filled for 30 s from the library; what the
      // library lacks (no clips, no pictures, no sound) is stood in for by a color and words, never skipped.
      made = await newScene('video', { title: `Playtest 4 tracks ${new Date().toISOString().slice(0, 16)}` });
      if (!await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000)) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      const SEC = 30, STEP = 5;
      const main = mainTrack()?.id;
      const over = addTrack({ name: 'Overlay', role: 'any' }).id;
      const words = tracks().find((x) => x.role === 'text')?.id ?? addTrack({ name: 'Words', role: 'text' }).id;
      const music = tracks().find((x) => x.role === 'audio')?.id;
      for (let at = 0, i = 0; at < SEC; at += STEP, i++) {
        if (vids.length) {
          const a = vids[i % vids.length], len = Math.min(STEP, a.meta.duration);
          const c = addClip({ track: main, asset: a.id, kind: 'video', duration: a.meta.duration, start: at, label: a.title || 'clip', history: false });
          setClip(c.id, { start: at, out: len }, { history: false });
        } else addClip({ track: main, kind: 'fill', color: ['#203a5c', '#5c2040', '#2c5c20'][i % 3], start: at, seconds: STEP, history: false });
        // Overlay: a small picture in a corner (or a color panel), with words on the text track.
        const pic = pics[i % Math.max(1, pics.length)];
        const o = pic ? addClip({ track: over, asset: pic.id, kind: 'image', start: at, seconds: STEP, label: pic.title || 'picture', history: false }) : addClip({ track: over, kind: 'fill', color: '#ffffff', start: at, seconds: STEP, history: false });
        setClip(o.id, { start: at, x: 0.8, y: 0.2, w: 0.25, opacity: 0.9 }, { history: false });
        const w = addClip({ track: words, kind: 'text', text: `Shot ${i + 1}: a sentence of captions on screen`, start: at, seconds: STEP, history: false });
        setClip(w.id, { start: at }, { history: false });
      }
      if (sounds.length && music) { const a = sounds[0]; const c = addClip({ track: music, asset: a.id, kind: 'audio', duration: a.meta.duration, start: 0, label: a.title || 'sound', history: false }); setClip(c.id, { start: 0, out: Math.min(SEC, a.meta.duration) }, { history: false }); }
      const len = docLength();
      t.metric('tracks', new Set(P.doc.clips.map((c) => c.track)).size);
      t.metric('clips', P.doc.clips.length);
      t.event('four-tracks-ready');
      await sleep(2500); // let the clips load: the measure is playback, not first load
      resetPlaybackStats();
      press('Home');
      press(' ');
      t.event('play-30s');
      const through = await until(() => P.playhead >= len - 0.1, Math.max(20000, len * 3000), 100);
      if (isPlaying()) press(' ');
      const run = pacingStats();
      t.metric('fps', run.fps); t.metric('p5fps', run.p5fps); t.metric('worstFrameMs', run.worstMs); t.metric('frames', run.frames);
      t.metric('playHolds', playbackStats().holds);
      t.event(through ? `played-30s p5=${run.p5fps}fps` : 'play-stalled');
      t.progress(0.6);
      // Seek while playing, with the keys a person uses (Shift+Left/Right: a second each; Home: the start), then see
      // how long the playhead took to move on each time.
      resetPlaybackStats();
      press('Home');
      press(' ');
      await sleep(1500);
      const times = [];
      for (const [key, shiftKey] of [['ArrowRight', true], ['ArrowRight', true], ['ArrowLeft', true], ['Home', false], ['ArrowRight', true]]) {
        const before = pacingStats().seeks;
        press(key, { shiftKey });
        await until(() => pacingStats().seeks > before, 3000, 20);
        times.push(pacingStats().seekResumeMs);
        await sleep(1000);
      }
      if (isPlaying()) press(' ');
      const seeks = pacingStats();
      t.metric('seekResumeMs', seeks.seekResumeMs); t.metric('seeksResumed', seeks.seeks);
      t.event(`seek-resume max ${seeks.seekResumeMs}ms of ${seeks.seeks}`);
      t.progress(0.9);
      t.finish(through ? 'done' : 'stuck');
      return;
    }
    if (id === 'phone') {
      t.scene('Phone layout');
      const W = () => window.innerWidth;
      const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]'); };
      /** Is an ancestor clipping this element sideways (a scroller or overflow: hidden)? Then it can't make the page wider. */
      const clipped = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible' && p.getBoundingClientRect().right <= W() + 1) return true; } return false; };
      const label = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(el.textContent || el.title || '').trim().slice(0, 24)}"`;
      /** The page's sideways overflow: the document wider than the screen, and visible elements poking past the right edge. */
      const overflow = (root = document) => {
        const out = [];
        if (document.documentElement.scrollWidth > W() + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${W()})`);
        for (const el of root.querySelectorAll('body *')) {
          if (el.closest('svg, #toast')) continue;
          const r = el.getBoundingClientRect();
          if (r.width && r.height && r.right > W() + 1 && visible(el) && !clipped(el) && getComputedStyle(el).position !== 'fixed') out.push(`${label(el)} reaches ${Math.round(r.right)} of ${W()}`);
          if (out.length >= 6) break;
        }
        return out;
      };
      const inView = (el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= W() + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1; };
      /** Controls under 44 px tall in the open screen (timeline handles and mini buttons are content). */
      const small = (root) => [...root.querySelectorAll('button, select, summary, [role=tab], .chip, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=hidden])')]
        .filter((el) => visible(el) && !el.closest('#tlTracks, .tl-heads') && !el.matches('.tl-hb, .clip-act') && el.getBoundingClientRect().height < 43.5);
      let bad = 0;
      const visit = async (name, root = () => document, primary = () => []) => {
        await sleep(700);
        const r = root() ?? document;
        const of = overflow(r === document ? document : r);
        const off = primary().filter((el) => el && visible(el) && !inView(el));
        const tiny = small(r === document ? document.body : r).filter((el) => visible(el));
        t.metric(`${name}_overflow`, of.length); t.metric(`${name}_offscreenPrimary`, off.length); t.metric(`${name}_under44`, tiny.length);
        t.event(`screen-${name}`);
        for (const m of of) { bad++; t.problem('bug', `${name}: horizontal overflow: ${m}`); }
        for (const el of off) { bad++; t.problem('bug', `${name}: primary button not fully on screen: ${label(el)}`); }
        for (const el of tiny.slice(0, 5)) { bad++; t.problem('minor', `${name}: control under 44 px tall (${Math.round(el.getBoundingClientRect().height)}): ${label(el)}`); }
      };
      if (W() > 900) { t.note('Not a phone-sized screen: run this scenario with mobile: true (390x844, touch)'); t.finish('stuck'); return; }
      t.metric('viewportWidth', W());
      await until(() => activeScene(), 10000);
      made = await newScene('video', { title: `Playtest phone ${new Date().toISOString().slice(0, 16)}` });
      if (!await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000)) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      const tab = async (m) => { click(`#mobileTabs button[data-m="${m}"]`); await until(() => document.querySelector(`#mobileTabs button[data-m="${m}"].on`), 3000, 100); };
      await visit('edit', () => document, () => [document.querySelector('#sceneAction')].filter((b) => b && !b.hidden));
      await tab('media'); await visit('media', () => document, () => []);
      const tile = document.querySelector('#mediaGrid .tile:not(.busy)');
      if (tile) { tile.focus(); pressOn(tile, 'Enter'); if (await until(() => document.querySelector('#mediaDrawer .media-drawer'), 4000)) { await visit('drawer', () => document.querySelector('#mediaDrawer .media-drawer'), () => [document.querySelector('#drawerUse')]); pressOn(document.activeElement ?? document.body, 'Escape'); await until(() => !document.querySelector('#mediaDrawer'), 3000); } }
      else t.note('The test account has no media: the detail drawer was not visited');
      await tab('generate'); await visit('create', () => document, () => []);
      const row = document.querySelector('#createList .cat .cat-row:not(.director-row)');
      if (row) { row.click(); await sleep(600); await visit('create-form', () => document, () => [...document.querySelectorAll('.pane.left button.primary')]); await tab('generate'); }
      await tab('scenes'); await visit('scenes');
      await tab('kind'); await visit('inspector');
      await tab('ai'); await visit('ai', () => document, () => [document.querySelector('#aiSend, .ai-form button[type=submit], .ai-form .primary')].filter(Boolean));
      await tab('edit');
      // The timeline: a text clip on it, then the screen again with it there.
      press('t'); await sleep(500); await visit('timeline');
      click('#accountBtn');
      const acct = await until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => /account|credits/i.test(b.textContent)), 3000, 100);
      if (acct) { acct.click(); if (await until(() => document.querySelector('#accountDialog[open]'), 4000)) { await visit('account', () => document.querySelector('#accountDialog'), () => [document.querySelector('#accountClose')]); document.querySelector('#accountClose')?.click(); await until(() => !document.querySelector('#accountDialog[open]'), 3000); } }
      else { pressOn(document.body, 'Escape'); t.note('The account menu had no Account row'); }
      if (!document.querySelector('#sceneAction')?.hidden) {
        click('#sceneAction');
        if (await until(() => document.querySelector('#exportDialog[open]'), 4000)) { await visit('export', () => document.querySelector('#exportDialog'), () => [document.querySelector('#exportGo')]); document.querySelector('#exportClose')?.click(); }
      }
      // The five bottom tabs, the timeline on screen at the same time, and no page zoom.
      {
        const bar = document.querySelector('#mobileTabs');
        const names = [...(bar?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim());
        const need = [['media', /media/i], ['generate', /create/i], ['scenes', /scenes/i], ['kind', /inspect/i], ['ai', /^ai$/i]];
        const missing = need.filter(([m, re]) => { const b = bar?.querySelector(`button[data-m="${m}"]`); return !b || !visible(b) || !re.test(b.textContent.trim()) || !inView(b); });
        t.metric('bottomTabs', names.length); t.metric('bottomTabsMissing', missing.length);
        t.event(`bottom-tabs: ${names.join(' | ')}`);
        for (const [m] of missing) { bad++; t.problem('bug', `phone: the ${m} tab is missing or off screen`); }
        const atBottom = bar && Math.abs(bar.getBoundingClientRect().bottom - window.innerHeight) < 40;
        t.metric('tabsAtBottom', atBottom ? 1 : 0);
        if (!atBottom) { bad++; t.problem('bug', 'phone: the tabs are not at the bottom of the screen'); }
        for (const [m] of need) {
          await tab(m);
          const tl = document.querySelector('#timelinePane');
          const r = tl?.getBoundingClientRect();
          const ok = tl && visible(tl) && r.height >= 30 && r.top < window.innerHeight - 20;
          t.metric(`timelineOn_${m}`, ok ? 1 : 0);
          if (!ok) { bad++; t.problem('bug', `phone: the timeline is not on screen on the ${m} tab`); }
        }
        await tab('edit');
        const meta = document.querySelector('meta[name=viewport]')?.content ?? '';
        const noZoomTag = /user-scalable\s*=\s*no/.test(meta) && /maximum-scale\s*=\s*1(\.0)?\b/.test(meta);
        const wheel = new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true });
        document.body.dispatchEvent(wheel);
        const gesture = new Event('gesturestart', { bubbles: true, cancelable: true });
        document.body.dispatchEvent(gesture);
        const noZoom = noZoomTag && wheel.defaultPrevented && gesture.defaultPrevented && window.visualViewport?.scale <= 1.001;
        t.metric('noZoom', noZoom ? 1 : 0); t.metric('viewportScale', window.visualViewport?.scale ?? 1);
        t.event(noZoom ? 'zoom-blocked' : 'zoom-possible');
        if (!noZoom) { bad++; t.problem('bug', `phone: page zoom is possible (viewport "${meta}", pinch ${gesture.defaultPrevented ? 'stopped' : 'not stopped'}, ctrl+wheel ${wheel.defaultPrevented ? 'stopped' : 'not stopped'})`); }
        t.metric('pageScrollsSideways', document.documentElement.scrollWidth > W() + 1 ? 1 : 0);
      }
      // The detector must catch a deliberately overflowing element, so a quiet pass means something.
      const canary = document.createElement('div');
      canary.id = 'phone-canary'; canary.textContent = 'overflow canary';
      canary.style.cssText = `position:absolute;top:60px;left:0;width:${W() + 160}px;height:12px;background:#f0f;z-index:9999`;
      document.body.appendChild(canary);
      await sleep(300);
      const caught = overflow().some((m) => /phone-canary|sideways/.test(m));
      canary.remove();
      t.metric('canaryCaught', caught ? 1 : 0);
      t.event(caught ? 'canary-overflow-reported' : 'canary-missed');
      t.note(caught ? `Deliberate overflowing element (${W() + 160}px wide on a ${W()}px screen) was reported` : 'The overflow check missed the deliberate overflow');
      t.metric('phoneProblems', bad);
      t.finish(caught ? 'done' : 'stuck');
      return;
    }
    if (id === 'library') {
      t.scene('Library');
      click('#paneTabs button[data-pane="media"]');
      await until(() => document.querySelectorAll('#mediaGrid .tile:not(.busy)').length > 0 || document.querySelector('#mediaGrid .empty-note'), 15000);
      const real = () => [...document.querySelectorAll('#mediaGrid .tile:not(.busy)')];
      t.metric('tiles', real().length);
      t.metric('thumbs', real().filter((x) => x.querySelector('img, video')).length);
      t.event('grid');
      // Each filter chip narrows the grid to its kind (real clicks on the chips).
      const kinds = { image: 'kind-image', video: 'kind-video', audio: 'kind-audio', mesh: 'kind-mesh' };
      for (const [k, cls] of Object.entries(kinds)) {
        click(`#mediaFilter .chip[data-kind="${k}"]`);
        await until(() => document.querySelector(`#mediaFilter .chip[data-kind="${k}"].on`), 3000);
        await sleep(1200);
        const tiles = real();
        t.metric(`filter_${k}`, tiles.length);
        t.metric(`filter_${k}_pure`, tiles.every((x) => x.classList.contains(cls)) ? 1 : 0);
        t.event(`filtered-${k}`);
      }
      click('#mediaFilter .chip[data-kind="video"]');
      await sleep(1200);
      const vt = real().find((x) => x.querySelector('video'));
      if (vt) {
        const v = vt.querySelector('video');
        vt.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        v.dispatchEvent(new MouseEvent('mouseenter'));
        const playing = await until(() => !v.paused && v.currentTime > 0, 4000, 100);
        t.metric('hoverPlays', playing ? 1 : 0);
        t.event(playing ? 'hover-plays' : 'hover-no-play');
        v.dispatchEvent(new MouseEvent('mouseleave'));
      } else t.note('The test account has no clips to hover');
      click('#mediaFilter .chip[data-kind=""]');
      await sleep(1200);
      const first = real()[0];
      if (!first) { t.note('The library is empty: no asset to open'); t.finish('done'); return; }
      // Search: type the first tile's own first word (as the input event a keystroke fires), the grid keeps a match, then clear it.
      const word = (first.querySelector('.tile-cap')?.textContent ?? '').split(/\s+/).find((w) => w.length > 3);
      const box = document.querySelector('#mediaSearch');
      if (word && box) {
        box.value = word;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1500);
        t.metric('searchHits', real().length);
        t.event('searched');
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1500);
      }
      const target = real()[0] ?? first;
      target.focus();
      pressOn(target, 'Enter');
      const open = await until(() => document.querySelector('#mediaDrawer .media-drawer'), 5000);
      t.metric('drawerOpens', open ? 1 : 0);
      t.metric('drawerPrompt', document.querySelector('#mediaDrawer .dr-prompt')?.textContent ? 1 : 0);
      t.metric('drawerUse', document.querySelector('#drawerUse') ? 1 : 0);
      t.event('drawer-open');
      await sleep(800);
      pressOn(document.activeElement ?? document.body, 'Escape');
      t.metric('drawerCloses', await until(() => !document.querySelector('#mediaDrawer'), 3000) ? 1 : 0);
      t.finish(open ? 'done' : 'stuck');
      return;
    }
    if (id === 'mockproviders') {
      t.scene('Mock providers');
      // Reads /v1/health (no polling: one request) and, where providers are mocked, runs one job to see it finish with no wait.
      const h = await fetch('/v1/health').then((r) => r.json()).catch(() => null);
      const on = Boolean(h?.mock?.providers);
      t.metric('mockOn', on ? 1 : 0);
      t.metric('realCost', h?.mock?.realCost ?? -1);
      t.event(on ? 'providers-mocked' : 'providers-real');
      if (!on) { t.note(`Providers are real on this Gen (lane ${h?.lane}); no job was run`); t.finish('done'); return; }
      const t0 = performance.now();
      const job = await api('/v1/jobs', { method: 'POST', body: { tool: 'image.generate', params: { prompt: 'a playtest fox', seed: 4 }, labels: { playtest: true } } }).then((r) => r.jobs?.[0]).catch(() => null);
      t.event(job ? 'job-submitted' : 'job-refused');
      // One on-demand look after the job had a moment (the job runs in milliseconds; the app's event stream carries it).
      await sleep(1500);
      const j = job ? await api(`/v1/jobs/${job.id}`).catch(() => null) : null;
      const st = j?.job?.status ?? j?.status;
      t.metric('jobSeconds', Math.round((performance.now() - t0) / 100) / 10);
      t.metric('jobDone', st === 'done' ? 1 : 0);
      t.event(st === 'done' ? 'mock-job-done' : 'mock-job-not-done');
      const h2 = await fetch('/v1/health').then((r) => r.json()).catch(() => null);
      t.metric('realCostAfter', h2?.mock?.realCost ?? -1);
      t.finish(st === 'done' && (h2?.mock?.realCost ?? 1) === 0 ? 'done' : 'stuck');
      return;
    }
    if (id === 'signupcap') {
      t.scene('Starter-credit caps');
      const h = await fetch('/v1/health').then((r) => r.json()).catch(() => null);
      const sg = h?.signups;
      t.metric('signupsToday', sg?.today?.signups ?? -1);
      t.metric('refusedGrantsToday', sg?.today?.refusedGrants ?? -1);
      t.metric('signupsTotal', sg?.total?.signups ?? -1);
      t.metric('refusedGrantsTotal', sg?.total?.refusedGrants ?? -1);
      t.metric('perIpPerDay', sg?.limits?.perIpPerDay ?? -1);
      t.event(sg ? 'health-counts-signups' : 'health-missing-signups');
      t.note(`Health: ${JSON.stringify(sg ?? null)}. This account's balance: ${state.user?.credits ?? '?'} credits.`);
      t.finish(sg ? 'done' : 'stuck');
      return;
    }
    if (id === 'eventstreams') {
      // Four tabs' worth of GET /v1/events on this account (the page's own stream makes a fifth): the server keeps three
      // per account, closes the oldest with `bye`, and stream.js opens it again after its longest wait. No timer asks Gen
      // for anything; the streams are opened by the same client the page uses.
      t.scene('Event streams');
      const tabs = [];
      let byes = 0, reconnects = 0, opened = 0;
      for (let i = 0; i < 4; i++) {
        const tab = openStream({ bye: () => { byes++; t.event(`stream-${i}-bye`); } }, { onState: (st) => { if (st === 'live') opened++; }, onReconnect: () => { reconnects++; t.event(`stream-${i}-reconnected`); } });
        tabs.push(tab);
        await sleep(400);
      }
      t.metric('tabsOpened', 4);
      const gotBye = await until(() => byes >= 1, 15000);
      t.metric('byes', byes);
      t.event(gotBye ? 'oldest-closed-with-bye' : 'no-bye');
      if (!gotBye) t.problem('bug', 'a user\'s extra streams were never closed by the server');
      // The closed one waits 30 s and more, then comes back; that is the reconnect.
      const back = await until(() => reconnects >= 1, 60000, 500);
      t.metric('reconnects', reconnects);
      t.event(back ? 'closed-stream-reconnected' : 'no-reconnect');
      if (!back) t.problem('bug', 'the stream closed by the server did not open again by itself');
      for (const tab of tabs) tab.close();
      t.note(`${opened} opens, ${byes} bye(s), ${reconnects} reconnect(s)`);
      t.finish(gotBye && back ? 'done' : 'stuck');
      return;
    }
    if (id === 'trouble') {
      t.scene('When a call fails');
      await until(() => activeScene(), 10000);
      // Setup shortcut (named): a fresh video scene with one text clip, made before any call is forced to fail.
      made = await newScene('video', { title: `Playtest trouble ${new Date().toISOString().slice(0, 16)}` });
      if (!await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000)) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      const me = state.user;
      // Setup shortcut (named): every /v1 call but the session probe and the stream answers the way Gen does when it's in
      // that state (the junk in the bodies is what a raw error would have shown; none of it may reach the screen).
      const realFetch = window.fetch.bind(window);
      let mode = null;
      const junk = 'Traceback (most recent call last):\n  File "x.py", line 3\n{"error":"boom"} hg_0123456789abcdef sk-ant-oat01-abcdefghijkl';
      const answers = {
        offline: () => Promise.reject(new TypeError('Failed to fetch')),
        401: () => new Response(JSON.stringify({ error: junk }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
        402: () => new Response(JSON.stringify({ error: `not enough credits ${junk}` }), { status: 402, headers: { 'Content-Type': 'application/json' } }),
        429: () => new Response(JSON.stringify({ error: 'slow down', retryAfter: 7 }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' } }),
        503: () => new Response(JSON.stringify({ error: `no gpu available ${junk}` }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
      };
      window.fetch = (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        if (!mode || !path.startsWith('/v1/') || path === '/v1/users/me' || path.startsWith('/v1/events')) return realFetch(input, init);
        return Promise.resolve(answers[mode]());
      };
      const RAW = /[{}]|"error"|Traceback|File "|\bat \S+:\d+|hg_[0-9a-f]{6}|sk-ant|undefined|\[object/;
      const words = { offline: /Can.t reach Gen/, 401: /signed out/, 402: /out of credits.*\$10/, 429: /Too many requests, try again in 7 s/, 503: /busy or resting/ };
      const next = { offline: /Try again/, 401: /Sign in/, 402: /Add credits/, 429: /Try again/, 503: /Try again/ };
      const judge = (state_, surface, text, button) => {
        const ok = Boolean(text) && words[state_].test(text) && !RAW.test(text) && next[state_].test(button ?? '');
        t.metric(`${surface}-${state_}`, ok ? 1 : 0);
        t.event(`${surface}-${state_}-${ok ? 'ok' : 'bad'}`);
        if (!ok) t.problem('bug', `${surface} on ${state_}: "${String(text).slice(0, 160)}" / button "${button ?? ''}"`);
      };
      const toastNow = () => { const el = document.querySelector('#toast'); return el && !el.hidden ? { text: el.querySelector('span')?.textContent ?? '', button: el.querySelector('button')?.textContent ?? '' } : null; };
      for (const m of ['offline', 402, 429, 503, 401]) {
        const key = String(m);
        mode = null;
        t.scene(`State: ${key}`);
        state.user = me;
        if (m === 'offline') Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
        mode = key;
        if (m === 'offline') { window.dispatchEvent(new Event('offline')); const chip = document.querySelector('#netChip'); t.metric('offlineChip', chip && !chip.hidden && /offline/i.test(chip.textContent) ? 1 : 0); t.event('offline-chip'); }
        // The AI pane: type a message and press Enter.
        const box = document.querySelector('#aiInput');
        box.focus(); box.value = 'add a title'; box.dispatchEvent(new Event('input', { bubbles: true })); pressOn(box, 'Enter');
        await until(() => document.querySelector('#aiMessages .msg.err'), 8000, 100);
        const msg = [...document.querySelectorAll('#aiMessages .msg.err')].pop();
        judge(key, 'ai', msg?.textContent ?? '', msg?.querySelector('button')?.textContent ?? '');
        // Library: a filter click reloads Media, which can't.
        state.user = me;
        click('#paneTabs button[data-pane="media"]');
        const chips = [...document.querySelectorAll('#mediaFilter button')];
        (chips.find((b) => !b.classList.contains('on') && !b.classList.contains('active')) ?? chips[1])?.click();
        await until(() => document.querySelector('#mediaTrouble'), 5000, 100);
        const note = document.querySelector('#mediaTrouble');
        judge(key, 'library', note?.querySelector('p')?.textContent ?? '', note?.querySelector('button')?.textContent ?? '');
        chips[0]?.click();
        // Create: open a form and press its primary button.
        state.user = me;
        click('#paneTabs button[data-pane="generate"]');
        await until(() => document.querySelectorAll('#createList .cat .cat-row').length > 0, 8000);
        const row = [...document.querySelectorAll('#createList .cat .cat-row')].find((r) => !r.classList.contains('director-row'));
        if (row) { row.click(); await until(() => document.querySelector('#createBody .gen-foot .primary'), 5000, 100); }
        const runBtn = document.querySelector('#createBody .gen-foot .primary');
        if (runBtn) { runBtn.disabled = false; runBtn.click(); }
        await until(() => toastNow(), 6000, 100);
        const tc = toastNow();
        judge(key, 'create', tc?.text ?? '', tc?.button ?? '');
        click('#createBack');
        // Timeline: a change that can't be saved says so, with its next step.
        state.user = me;
        P.saveFailed = false;
        addClip({ track: mainTrack().id, kind: 'fill', color: '#203a5c', start: P.playhead, seconds: 2 });
        await until(() => document.querySelector('#saveState')?.dataset.s === 'error', 12000, 100);
        const tt = await until(() => toastNow(), 3000, 100) ? toastNow() : null;
        judge(key, 'timeline', tt?.text ?? '', tt?.button ?? '');
        mode = null;
        if (m === 'offline') { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); }
        await sleep(300);
      }
      // The stream dropping: the chip says so and clears by itself when it is live again (no fetch, no timer of ours).
      t.scene('State: stream drop');
      streamState('reconnecting');
      const chip = document.querySelector('#netChip');
      t.metric('reconnectingChip', chip && !chip.hidden && /Reconnecting…/.test(chip.textContent) ? 1 : 0);
      t.event('reconnecting-chip');
      await sleep(600);
      streamState('live');
      t.metric('chipClears', chip.hidden ? 1 : 0);
      t.event('chip-cleared');
      window.fetch = realFetch;
      state.user = me;
      t.finish('done');
      return;
    }
    if (id === 'aibusy') {
      t.scene('AI line');
      await until(() => activeScene(), 10000);
      // Setup shortcut (named): two canned answers; the first holds its AI slot for 45 s, like a slow Claude (needs HAWKESGEN_AI_MOCK=1).
      const q = await api('/v1/test/ai-mock', { method: 'POST', body: { answers: [{ match: 'slow first', holdMs: 45000, json: { say: 'Slow answer.', ops: [] } }, { match: 'second turn', json: { say: 'Second answer.', ops: [] } }] } }).catch((e) => ({ error: e.message }));
      if (!q?.queued) { t.event('mock-off'); t.note('The AI mock is off on this Gen (HAWKESGEN_AI_MOCK) or this is not a test sign-in session'); t.finish('done'); return; }
      made = await newScene('video', { title: `Playtest AI line ${new Date().toISOString().slice(0, 16)}` });
      await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000);
      // Setup shortcut (named): another AI turn of this account already holds the only slot (it is not awaited).
      void api(`/v1/editor/projects/${made.id}/assistant`, { body: { messages: [{ role: 'user', text: 'slow first' }] } }).catch(() => {});
      await sleep(1500);
      // Real input: type the second message in the AI pane and press Enter.
      const box = document.querySelector('#aiInput');
      box.focus();
      box.value = 'second turn: add a title';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      pressOn(box, 'Enter');
      t.event('asked-while-busy');
      const line = await until(() => /In line for the AI/.test(document.querySelector('#aiMessages')?.textContent ?? ''), 15000);
      t.metric('lineShown', line ? 1 : 0);
      t.event(line ? 'queue-position-shown' : 'no-queue-position');
      const gaveUp = await until(() => /The AI is busy right now|busy/.test(document.querySelector('#aiMessages .msg.err')?.textContent ?? ''), 50000);
      const words = document.querySelector('#aiMessages .msg.err')?.textContent ?? '';
      t.metric('gaveUp', gaveUp ? 1 : 0);
      t.event(gaveUp ? 'gave-up-plainly' : 'no-give-up');
      t.note(words.slice(0, 200));
      t.finish(line && gaveUp && !/[{}]|status|Error:/.test(words) ? 'done' : 'stuck');
      return;
    }
    if (id === 'uploads') {
      t.scene('Big uploads');
      await until(() => state.user && activeScene(), 15000);
      const mb = Math.max(1, Math.min(900, Number(options?.mb) || 64));
      // Setup shortcut (named): the files are made in memory by repeating one random block, as .mp4 named files; they go up
      // through the app's own upload path (the same one the Media button and a drop use), four started at the same moment.
      const block = new Uint8Array(1024 * 1024);
      crypto.getRandomValues(block.subarray(0, 65536));
      const make = (i) => new File(Array.from({ length: mb }, () => block), `playtest-big-${i}-${Date.now()}.mp4`, { type: 'video/mp4' });
      const health0 = await api('/v1/health').catch(() => ({}));
      t.event('uploading-four');
      const toasts = new Set();
      const watch = new MutationObserver(() => { const el = document.querySelector('#toast'); if (el && !el.hidden) toasts.add(el.textContent); });
      watch.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      click('#paneTabs button[data-pane="media"]');
      const files = [0, 1, 2, 3].map(make);
      // Not awaited: they run together. Each call is one drop of one file.
      const runs = files.map((f) => uploadFiles([f]));
      const sawPercent = await until(() => /Uploading \d+%/.test(document.querySelector('#mediaGrid, #media')?.textContent ?? document.body.textContent), 30000, 100);
      t.metric('progressShown', sawPercent ? 1 : 0);
      t.event(sawPercent ? 'progress-shown' : 'no-progress');
      const refused = await until(() => [...toasts].some((x) => /uploads at once/.test(x)), 60000, 200);
      t.metric('plain429', refused ? 1 : 0);
      t.event(refused ? 'fourth-refused-plainly' : 'no-429-message');
      if (!refused) t.problem('bug', 'a fourth upload at once did not show the "uploads at once" message');
      if (!sawPercent) t.problem('bug', 'no upload percentage was shown');
      await Promise.race([Promise.allSettled(runs), sleep(150000)]);
      watch.disconnect();
      // The server must still be the same process, with a bounded memory.
      const health1 = await api('/v1/health').catch(() => ({}));
      const restarted = Boolean(health0?.process?.pid && health1?.process?.pid && (health0.process.pid !== health1.process.pid || Math.abs(Date.parse(health0.process.startedAt) - Date.parse(health1.process.startedAt)) > 5000));
      t.metric('restarted', restarted ? 1 : 0);
      if (health1?.process?.rssMb != null) t.metric('serverRssMb', health1.process.rssMb);
      t.event(restarted ? 'server-restarted' : 'server-stayed-up');
      if (restarted) t.problem('blocker', 'the server restarted during the uploads');
      t.finish(refused && sawPercent && !restarted ? 'done' : 'stuck');
      return;
    }
    if (id === 'aimock') {
      t.scene('AI mock');
      await until(() => activeScene(), 10000);
      // Setup shortcut (named): queue one canned editor answer for this test account (needs HAWKESGEN_AI_MOCK=1 on this Gen).
      const q = await api('/v1/test/ai-mock', { method: 'POST', body: { match: 'canned hello', cost: 0, json: { say: 'Canned: added your title.', ops: [{ op: 'add', track: 'T1', kind: 'text', text: 'Hello from the mock', start: 0, duration: 3 }] } } }).catch((e) => ({ error: e.message }));
      t.metric('mockQueued', q?.queued ?? 0);
      t.event(q?.queued ? 'mock-queued' : 'mock-off');
      if (!q?.queued) { t.note('The AI mock is off on this Gen (HAWKESGEN_AI_MOCK) or this is not a test sign-in session'); t.finish('done'); return; }
      made = await newScene('video', { title: `Playtest AI mock ${new Date().toISOString().slice(0, 16)}` });
      await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000);
      const before = P.doc?.clips?.length ?? 0;
      // Real input: type the message in the AI pane and press Enter.
      const box = document.querySelector('#aiInput');
      box.focus();
      box.value = 'canned hello: add a title';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      pressOn(box, 'Enter');
      t.event('asked');
      const said = await until(() => /Canned: added your title/.test(document.querySelector('#aiMessages')?.textContent ?? ''), 15000);
      t.metric('answered', said ? 1 : 0);
      t.event(said ? 'canned-answer-shown' : 'no-answer');
      const added = await until(() => (P.doc?.clips?.length ?? 0) > before, 5000);
      t.metric('titleAdded', added ? 1 : 0);
      t.finish(said && added ? 'done' : 'stuck');
      return;
    }
    if (id === 'playback') {
      t.scene('Playback');
      // The test account's own clips (the bot makes none: no GPU). Fewer than two: nothing to cut together.
      const q = new URLSearchParams({ limit: '40', project: state.user.project, kind: 'video' });
      const r = await api(`/v1/assets?${q}`).catch(() => null);
      const vids = (r?.items ?? []).filter((a) => a.kind === 'video' && a.meta?.duration > 1).slice(0, 3);
      t.metric('videos', vids.length);
      if (vids.length < 2) { t.note('The test account has fewer than two clips in its library: nothing to cut together'); t.finish('done'); return; }
      await until(() => activeScene(), 10000);
      // Setup shortcut (named): a fresh video scene with the clips back to back on its main track, 3 s each.
      made = await newScene('video', { title: `Playtest playback ${new Date().toISOString().slice(0, 16)}` });
      const opened = await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000);
      if (!opened) { t.note('the new scene did not open'); t.finish('stuck'); return; }
      const track = mainTrack()?.id;
      for (const a of vids) {
        const c = addClip({ track, asset: a.id, kind: 'video', duration: a.meta.duration, label: a.title || 'clip' });
        setClip(c.id, { out: Math.min(a.meta.duration, 3) }, { history: false });
      }
      const len = docLength();
      t.metric('cuts', vids.length - 1);
      t.event('clips-added');
      // Play from the start through every cut (real keys: Home, Space); it stops by itself at the end.
      resetPlaybackStats();
      press('Home');
      press(' ');
      const through = await until(() => P.playhead >= len - 0.1, Math.max(15000, len * 3000), 100);
      if (isPlaying()) press(' ');
      t.event(through ? 'played-through' : 'play-stalled');
      const played = playbackStats();
      t.metric('playHolds', played.holds);
      t.metric('playMaxHoldMs', played.maxHoldMs);
      t.metric('playDriftSeeks', played.driftSeeks);
      t.metric('playBlankFrames', played.blankFrames);
      t.progress(0.6);
      // Scrub back over the cuts a second at a time (Shift+Left) to the start, then play across the first cut again.
      resetPlaybackStats();
      for (let i = 0; i < Math.ceil(len); i++) { press('ArrowLeft', { shiftKey: true }); await sleep(250); }
      await sleep(500);
      press(' ');
      const again = await until(() => P.playhead >= Math.min(len - 0.1, 3.5), 15000, 100);
      if (isPlaying()) press(' ');
      const back = playbackStats();
      t.metric('replayHolds', back.holds);
      t.metric('replayBlankFrames', back.blankFrames);
      t.event('scrubbed-back');
      t.progress(0.9);
      t.finish(through && again ? 'done' : 'stuck');
      return;
    }
    // smoke
    t.scene('Studio');
    t.progress(0.1);
    // Setup shortcut (named): a fresh video scene to play in, so the account's own scenes are never touched.
    // The workspace opens its own first tab on load; wait for it so the bot's scene is made after, not beside, it.
    await until(() => activeScene(), 10000);
    made = await newScene('video', { title: `Playtest ${new Date().toISOString().slice(0, 16)}` });
    const opened = await until(() => activeScene()?.id === made?.id && P.active && P.id === made.id, 15000);
    if (!opened) { t.note('the new scene did not open'); t.finish('stuck'); return; }
    t.event('scene-made');
    t.progress(0.3);
    const before = P.doc.clips.length;
    press('t');
    const texted = await until(() => P.doc.clips.length > before, 5000);
    t.metric('clips', P.doc.clips.length);
    if (texted) t.event('text-added');
    t.progress(0.6);
    press('Home');
    press(' ');
    await sleep(2000);
    press(' ');
    t.metric('playhead', Math.round(P.playhead * 100) / 100);
    if (P.playhead > 0.5) t.event('played');
    t.progress(0.9);
    t.finish(texted && P.playhead > 0.5 ? 'done' : 'stuck');
  },
  async stop() {
    // The scene the smoke made goes again (the test account doesn't fill up).
    if (made?.id) { const id = made.id; made = null; await api(`/v1/scenes/${id}`, { method: 'DELETE' }).catch(() => {}); }
    // Scenes the stage, scenes and world scenarios made beside it go too.
    while (extra.length) await api(`/v1/scenes/${extra.pop()}`, { method: 'DELETE' }).catch(() => {});
  },
});
