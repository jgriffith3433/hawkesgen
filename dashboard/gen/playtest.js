// Hawkes Studio's playtest bot for the app (J, 2026-10-30: Studio plays Gen's app as a project; spec:
// hawkesstudio/docs/playtest.md). It plays through real input (keys and clicks, like a person) and spends no GPU: on
// Studio's beta playtests it's signed in as the project's test account (src/testsignin.ts).
//   smoke    the page opens; signed in, a new video scene, text added with T, played with Space, then removed
//   media    the Media pane lists the library and a tile can be picked (the AI's chip shows it)
//   signedout what someone who isn't signed in sees: the welcome, and Start free
import { installPlaytest } from './playtest/hawkes-playtest.js';
import { state } from './account.js';
import { P } from './project.js';
import { activeScene, newScene } from './scenes.js';
import { api } from './lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A key press on the page, as the keyboard sends it (the app's shortcuts listen on window). */
function press(key) {
  const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key;
  for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
}
/** Waits for a condition, up to `ms`. */
async function until(fn, ms = 15000, step = 200) {
  const end = performance.now() + ms;
  while (performance.now() < end) { try { if (fn()) return true; } catch { /* not yet */ } await sleep(step); }
  return false;
}
const click = (sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; };

let made = null;
installPlaytest({
  product: 'hawkesgen-app',
  scenarios: [
    { id: 'smoke', title: 'Open the app, make a scene, add text, play it', seconds: 60, tags: ['smoke'] },
    { id: 'media', title: 'The Media pane lists the library and picks a tile for the AI', seconds: 40 },
    { id: 'signedout', title: 'Someone not signed in sees the welcome', seconds: 30 },
  ],
  // Ready once the account is known (signed in or not) and the app has drawn.
  isReady: () => Boolean(document.querySelector('#app')) && performance.now() > 1500,
  async start(id, options, t) {
    // The account is known once it's there, or the welcome for someone not signed in is.
    await until(() => state.user || document.querySelector('#landing:not([hidden])'), 10000);
    t.metric('signedIn', state.user ? 1 : 0);
    if (id === 'signedout') {
      t.scene('Welcome');
      const welcome = await until(() => document.querySelector('#landing:not([hidden]), .landing:not([hidden])'), 8000);
      t.metric('welcome', welcome ? 1 : 0);
      t.finish(state.user ? 'done' : welcome ? 'done' : 'stuck');
      return;
    }
    if (!state.user) { t.note('Not signed in: the bot needs the test sign-in (Studio\'s beta playtests give it)'); t.finish('stuck'); return; }
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
  },
});
