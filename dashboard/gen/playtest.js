// Hawkes Studio's playtest bot for the app (J, 2026-10-30: Studio plays Gen's app as a project; spec:
// hawkesstudio/docs/playtest.md). It plays through real input (keys and clicks, like a person) and spends no GPU: on
// Studio's beta playtests it's signed in as the project's test account (src/testsignin.ts).
//   smoke    the page opens; signed in, a new video scene, text added with T, played with Space, then removed
//   media    the Media pane lists the library and a tile can be picked (the AI's chip shows it)
//   signedout what someone who isn't signed in sees: the welcome, and Start free
//   playback two or three of the library's clips cut together, played through the cuts and scrubbed back over them:
//            how often and how long the clock waited for data, seeks while playing, frames with no picture
//   playback4 a 4-track timeline (video, picture or color, words, sound) played for 30 s, then seeked while playing:
//            fps and its 5th percentile (p5), the slowest frame, and how long each seek took to get the playhead moving
import { installPlaytest } from './playtest/hawkes-playtest.js';
import { state } from './account.js';
import { P, addClip, setClip, mainTrack, docLength, addTrack, tracks } from './project.js';
import { snapStats } from './timeline.js';
import { isPlaying, seek, playbackStats, resetPlaybackStats, pacingStats } from './player.js';
import { activeScene, newScene } from './scenes.js';
import { startGuide, guideOpen } from './guide.js';
import { api } from './lib.js';
import { runJob } from './media.js';

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

let made = null;
installPlaytest({
  product: 'hawkesgen-app',
  scenarios: [
    { id: 'smoke', title: 'Open the app, make a scene, add text, play it', seconds: 60, tags: ['smoke'] },
    { id: 'media', title: 'The Media pane lists the library and picks a tile for the AI', seconds: 40 },
    { id: 'signedout', title: 'Someone not signed in sees what Gen does, a Sign in with Google button and examples, with no /v1 call but /v1/users/me', seconds: 30 },
    { id: 'createprice', title: 'Every Create form shows its credit price when opened, and it changes when an option that changes the cost changes', seconds: 120 },
    { id: 'guide', title: 'The guided first project: pick an idea, a picture, the timeline, play, and dismiss it', seconds: 90 },
    { id: 'playback4', title: 'A 4-track timeline plays 30 s smoothly (p5 fps) and playback resumes fast after a seek', seconds: 120 },
    { id: 'progress', title: 'A job that fails shows its plain cause and Retry; Retry shows the estimate and Stop while it runs', seconds: 90 },
    { id: 'editing', title: 'Timeline editing: clips snap to neighbours and the playhead, ? shows the shortcuts, undo and redo move, trim and delete', seconds: 90 },
    { id: 'library', title: 'Library: thumbnails, video plays on hover, filter by image, video, audio and 3D, open an asset to see its prompt and Use in timeline', seconds: 90 },
    { id: 'aimock', title: 'The AI editor answers from a canned answer (test account only): a title appears from a typed message, with no Claude call', seconds: 60 },
    { id: 'phone', title: 'Phone (390x844, touch): every screen has no horizontal scroll, primary buttons fully on screen, controls at least 44 px; a deliberately overflowing element is reported', seconds: 120, tags: ['mobile'] },
    { id: 'playback', title: 'Clips cut together play through the cuts and scrub back without hitching', seconds: 90 },
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
      if (welcome && !state.user) {
        // What the first screen must say and show, and that it asked Gen for nothing but who's signed in.
        const L = document.querySelector('#landing');
        t.metric('signInWithGoogle', /Sign in with Google/.test(L.textContent) ? 1 : 0);
        t.metric('examples', L.querySelectorAll('.ld-ex').length);
        const v1 = performance.getEntriesByType('resource').map((e) => new URL(e.name, location.href).pathname).filter((p) => p.startsWith('/v1/') && p !== '/v1/users/me');
        t.metric('v1CallsSignedOut', v1.length);
        for (const p of v1) t.problem('bug', `signed-out load called ${p}`);
        t.event('welcome-checked');
      }
      t.finish(state.user ? 'done' : welcome ? 'done' : 'stuck');
      return;
    }
    if (!state.user) { t.note('Not signed in: the bot needs the test sign-in (Studio\'s beta playtests give it)'); t.finish('stuck'); return; }
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
  },
});
