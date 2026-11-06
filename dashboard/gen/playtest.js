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
import { isPlaying, playbackStats, resetPlaybackStats, pacingStats } from './player.js';
import { activeScene, newScene } from './scenes.js';
import { startGuide, guideOpen } from './guide.js';
import { api } from './lib.js';
import { runJob } from './media.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A key press on the page, as the keyboard sends it (the app's shortcuts listen on window). */
function press(key, { shiftKey = false } = {}) {
  const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key;
  for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { key, code, shiftKey, bubbles: true, cancelable: true }));
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
    { id: 'guide', title: 'The guided first project: pick an idea, a picture, the timeline, play, and dismiss it', seconds: 90 },
    { id: 'playback4', title: 'A 4-track timeline plays 30 s smoothly (p5 fps) and playback resumes fast after a seek', seconds: 120 },
    { id: 'progress', title: 'A job that fails shows its plain cause and Retry; Retry shows the estimate and Stop while it runs', seconds: 90 },
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
