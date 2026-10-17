// Playtests: play a game in a real browser (Playwright + Chromium) and record it, then have Claude
// review the footage. Games expose the Hawkes playtest contract (window.hawkesPlaytest, spec in
// C:\Projects\hawkesstudio\docs\playtest.md); pages without it get a generic smoke test, and static
// sites a crawl of their pages.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Tool, RunContext } from './types.ts';
import { GenError, run as runProc, sleep } from '../util.ts';
import { listAssets, getAsset } from '../library.ts';
import { db } from '../db.ts';
import { ask, DEFAULT_MODEL } from '../providers/anthropic.ts';
import { openPlaytestHost, GPU_LINUX_ARGS, type PlaytestHost } from '../providers/comfy/playtestHost.ts';
import { awsConfig } from '../providers/comfy/fleet.ts';
import { ScreencastRecorder, mjpegToMp4Args, remoteEncodeScript, SCREENCAST_FPS } from './screencast.ts';

type Shot = { t: number; reason: string; scene?: string; file: string };
type Problem = { severity: string; message: string; source: string };

const TERMINAL = new Set(['won', 'lost', 'done', 'stuck', 'error']);

/** Injected into every page: a frame counter the runner reads (works with or without the contract). */
const FPS_SCRIPT = `(() => {
  const s = { frames: 0, last: performance.now(), samples: [] };
  window.__hawkesRunnerFps = s;
  const tick = (t) => { s.frames++; if (t - s.last >= 1000) { s.samples.push(Math.round(s.frames * 1000 / (t - s.last))); if (s.samples.length > 3600) s.samples.shift(); s.frames = 0; s.last = t; } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})();`;

export const playtestRunTool: Tool = {
  id: 'playtest.run',
  version: 3,
  title: 'Playtest a game in the browser',
  description:
    'Opens a game or site in Chromium and plays it: through the Hawkes playtest contract (window.hawkesPlaytest: the game\'s ' +
    'own bot plays a scenario), or a generic smoke test (click, keys) when the page has none, or a crawl of every page ' +
    '(mode "site"). Records the video, screenshots every few seconds and at events, console errors, failed requests, ' +
    'load time and frame rate. Outputs the video, screenshots and a report (the video and report also go to S3); give a ' +
    'baseline (the previous run) to compare screenshots at matching events. A hung browser, tunnel or page ends the run as ' +
    '"stuck" with what was recorded. Follow it with playtest.review.',
  provider: 'playtest',
  output: 'video',
  inputs: {},
  params: {
    url: { type: 'string', required: true, description: 'The page: a local dev server, a local build, or the live site', example: 'http://localhost:8089/' },
    scenario: { type: 'string', default: 'smoke', description: 'The contract scenario to play (the game lists them)' },
    mode: { type: 'enum', values: ['auto', 'contract', 'generic', 'site'], default: 'auto', description: 'auto: the contract if the page has it, else the generic smoke test' },
    seed: { type: 'integer', default: 1, min: 0, max: 2147483647 },
    speed: { type: 'number', default: 1, min: 0.25, max: 16, description: 'Asks the game to run faster (if it supports it)' },
    options: { type: 'json', description: 'Scenario options the game understands, passed to hawkesPlaytest.start with seed and speed: e.g. { "stage": "city-top" } (Dose Of Destruction). Content playtests use this to play the new content (Sick Of It needs none: its scenarios are level-<n>).' },
    timeout: { type: 'integer', min: 10, max: 7200, description: 'Seconds before the run counts as stuck (default: twice the scenario\'s length, or 5 min)' },
    bootTimeout: { type: 'integer', default: 150, min: 5, max: 900, description: 'Seconds to wait for the game to load', advanced: true },
    shotEvery: { type: 'number', default: 5, min: 1, max: 120, description: 'Seconds between screenshots', advanced: true },
    width: { type: 'integer', default: 1280, min: 320, max: 3840, advanced: true },
    height: { type: 'integer', default: 720, min: 240, max: 2160, advanced: true },
    mobile: { type: 'boolean', default: false, description: 'Emulate a phone (touch, 390x844)', advanced: true },
    headed: { type: 'boolean', default: false, description: 'Show the browser window (WebGL runs on the real GPU either way)', advanced: true },
    gpu: { type: 'enum', values: ['auto', 'require', 'off'], default: 'auto', description: 'Where the browser runs. auto: this PC if it has a GPU (Windows), else the playtester (T4) if it is running, else a ready GPU fleet server, else here in software. require: one of those GPU machines or fail. off: here.', advanced: true },
    maxPages: { type: 'integer', default: 40, min: 1, max: 300, description: 'Site mode: how many pages to visit', advanced: true },
    recorder: { type: 'enum', values: ['auto', 'screencast', 'playwright'], default: 'auto', description: 'How the video is made. screencast: every frame Chromium draws, kept at 30 fps, encoded after the run on the browser\'s machine (smooth). playwright: Playwright\'s recordVideo (25 fps, encoded on the browser\'s machine). auto: screencast when the browser runs on a GPU machine, else playwright.', advanced: true },
    baseline: { type: 'string', description: 'A previous playtest.run job of the same scenario: screenshots at matching events (scene changes, the end) are compared with a perceptual diff', advanced: true, example: 'j_0123456789ab' },
  },
  async run(ctx) {
    const p = ctx.params;
    // Loaded lazily so the service starts without Playwright's browsers installed.
    const { chromium, devices } = await import('playwright');
    const videoDir = ctx.tmp('video');
    fs.mkdirSync(videoDir, { recursive: true });
    const viewport = p.mobile ? { width: 390, height: 844 } : { width: p.width, height: p.height };

    // Every await below has a hard limit, and a watchdog kills the browser (and the tunnel) if the run as a whole
    // overruns: whatever hangs then rejects, and the run ends as "stuck" with what it recorded.
    let browser: any = null;
    let host: PlaytestHost | null = null;
    // Why a game played in software on this machine instead of on a GPU (the result says so; frame rates mean nothing then).
    let softwareBecause: string | null = null;
    let killed = '';
    const kill = async (why: string) => {
      if (killed) return;
      killed = why;
      ctx.log(`stopping the browser: ${why}`);
      await within(browser?.close() ?? Promise.resolve(), 15_000, 'closing the browser').catch(() => {});
      host?.close();
    };
    const onAbort = () => void kill('cancelled');
    ctx.signal.addEventListener('abort', onAbort);
    let watchdog: NodeJS.Timeout | null = null;
    const arm = (ms: number) => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => void kill(`the run went past its ${Math.round(ms / 1000)} s limit`), ms);
    };
    let release: (() => void) | null = null;

    const problems: Problem[] = [];
    const consoleLines: { type: string; text: string; t: number }[] = [];
    const failed: { url: string; status: number | string }[] = [];
    const shots: Shot[] = [];
    const timeline: any[] = [];
    let t0 = Date.now();
    const T = () => Math.round((Date.now() - t0) / 100) / 10;
    let report: any = null;
    let outcome = 'done';
    let contract = false;
    let scenarios: any[] = [];
    let loadSeconds: number | null = null;
    let pages: any[] = [];
    let stuck: string | null = null;
    let page: any = null;
    let context: any = null;
    let screencast: ScreencastRecorder | null = null;
    let recorder: any = null;

    try {
      // The control server (Linux) has no GPU: games run on a GPU fleet server's browser when one is ready.
      if (p.gpu === 'require' || (p.gpu === 'auto' && process.platform !== 'win32')) {
        const u = new URL(p.url);
        const localPorts = /^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? [Number(u.port || (u.protocol === 'https:' ? 443 : 80))] : [];
        // Installing the browser on a server takes a few minutes the first time.
        // Games (anything but a site crawl) start the playtester if it's off.
        const opening = openPlaytestHost(localPorts, ctx.step, { startPlaytester: p.mode !== 'site' });
        host = await within(opening, 20 * 60_000, 'opening the GPU server\'s browser').catch((e) => {
          opening.then((h) => h?.close(), () => {});
          if (p.gpu === 'require') throw e;
          ctx.log(`no GPU browser (${e.message}); playing here in software`);
          softwareBecause = String(e.message ?? e).slice(0, 300);
          return null;
        });
        if (!host && p.gpu === 'require') throw new GenError('No GPU server is ready for the playtest (start one, or use gpu: auto)', { kind: 'gpu' });
        if (!host && !softwareBecause && p.mode !== 'site') softwareBecause = 'no GPU machine was ready (the playtester did not start and no GPU server was running)';
      }
      if (!host) {
        // This machine has one browser to give: playtests that run here take turns.
        ctx.step('waiting for this machine\'s browser');
        release = await localSlot(ctx.signal);
      }
      ctx.step(host ? `opening Chromium on ${host.server}` : 'opening Chromium');
      browser = await within(host
        ? chromium.connect(host.wsEndpoint, { timeout: 90_000, headers: { 'x-playwright-launch-options': JSON.stringify({ headless: true, args: GPU_LINUX_ARGS }) } })
        : chromium.launch({
          headless: !p.headed,
          timeout: 90_000,
          args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
        }), 120_000, 'starting the browser');
      if (host) ctx.log(`browser on the GPU server ${host.server}`);
      // From here: loading, playing (the scenario's limit) and wrapping up, with room to spare.
      arm((p.bootTimeout + (p.timeout ?? 3600) + 300) * 1000);

      // The video: a screencast (every frame, 30 fps) where it can, else Playwright's recordVideo, which has to be
      // asked for when the tab opens: a screencast that won't start reopens the tab with it.
      const openTab = async (video: boolean) => {
        context = await within(browser.newContext({
          ...(p.mobile ? { ...devices['iPhone 13'], deviceScaleFactor: 2 } : {}),
          viewport,
          ...(video ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
          ignoreHTTPSErrors: true,
        }), 30_000, 'opening a browser tab');
        await within(context.addInitScript(FPS_SCRIPT), 15_000, 'preparing the tab');
        page = await within(context.newPage(), 30_000, 'opening a browser tab');
      };
      const wantScreencast = p.recorder === 'screencast' || (p.recorder === 'auto' && Boolean(host));
      await openTab(!wantScreencast);
      recorder = { kind: 'playwright', fps: 25 };
      if (wantScreencast) {
        const sc = new ScreencastRecorder(ctx.tmp('screen.mjpeg'), viewport);
        const why = await within(sc.start(context, page), 30_000, 'starting the screencast').catch((e: any) => e.message as string);
        if (why) {
          ctx.log(`the screencast didn't start (${why}); recording with Playwright instead`);
          await sc.stop();
          await within(context.close(), 30_000, 'closing the tab').catch(() => {});
          await openTab(true);
        } else {
          screencast = sc;
          recorder = { kind: 'screencast', fps: SCREENCAST_FPS };
        }
      }
      t0 = Date.now();
      page.setDefaultTimeout(30_000);
      page.on('console', (m: any) => {
        const type = m.type();
        if (type === 'error' || type === 'warning') {
          consoleLines.push({ type, text: m.text().slice(0, 500), t: T() });
          if (consoleLines.length > 500) consoleLines.shift();
        }
      });
      page.on('pageerror', (e: any) => problems.push({ severity: 'bug', message: `page error: ${e.message.slice(0, 300)}`, source: 'browser' }));
      page.on('crash', () => problems.push({ severity: 'bug', message: 'the page crashed (the browser tab died)', source: 'browser' }));
      // ERR_ABORTED is a request cancelled by the page itself (a navigation, a stopped media load, or the runner closing
      // the browser), not a failure a player would see.
      page.on('requestfailed', (r: any) => {
        const why = r.failure()?.errorText ?? 'failed';
        if (!/ERR_ABORTED/.test(why) && !killed) failed.push({ url: r.url().slice(0, 300), status: why });
      });
      page.on('response', (r: any) => { if (r.status() >= 400) failed.push({ url: r.url().slice(0, 300), status: r.status() }); });

      const shot = async (reason: string, scene?: string) => {
        if (killed) return;
        const file = ctx.tmp(`shot-${String(shots.length).padStart(3, '0')}.jpg`);
        try {
          await within(page.screenshot({ path: file, type: 'jpeg', quality: 80, timeout: 15_000 }), 20_000, 'a screenshot');
          shots.push({ t: T(), reason, scene, file });
        } catch {
          // The page may be navigating.
        }
      };
      /** page.evaluate with a limit: a page that stops answering is stuck. */
      const ev = <R>(f: any, arg?: any, ms = 15_000): Promise<R> => within(page.evaluate(f, arg), ms, 'the page');

      try {
        const target = host ? host.mapUrl(withParams(p.url, {})) : withParams(p.url, {});
        ctx.step(`loading ${target}`);
        const resp = await within<any>(page.goto(target, { waitUntil: 'load', timeout: p.bootTimeout * 1000 }), p.bootTimeout * 1000 + 15_000, 'loading the page').catch((e: any) => {
          if (e instanceof Stuck) throw e;
          problems.push({ severity: 'bug', message: `the page did not load: ${e.message.split('\n')[0]}`, source: 'browser' });
          return null;
        });
        loadSeconds = T();
        if (resp && resp.status() >= 400) problems.push({ severity: 'bug', message: `the page answered HTTP ${resp.status()}`, source: 'browser' });
        await shot('loaded');

        if (p.mode === 'site') {
          pages = await crawl(page, target, p.maxPages, ctx, shot, problems, () => killed);
          outcome = 'done';
        } else {
          // Wait for the contract (Unity games register it once the player has loaded).
          const bootEnd = Date.now() + p.bootTimeout * 1000;
          if (p.mode !== 'generic') {
            ctx.step('waiting for the game to load');
            while (Date.now() < bootEnd && !killed) {
              const has = await ev<boolean>(() => typeof (window as any).hawkesPlaytest === 'object').catch(() => false);
              if (has) {
                contract = true;
                break;
              }
              if (p.mode !== 'contract' && Date.now() - t0 > Math.min(30_000, p.bootTimeout * 1000) && !(await looksLikeUnity(page))) break;
              await sleep(500);
            }
          }
          if (p.mode === 'contract' && !contract) throw new GenError(`The page never exposed window.hawkesPlaytest (waited ${p.bootTimeout} s)`, { kind: 'contract' });

          if (contract) {
            scenarios = await ev<any[]>(() => (window as any).hawkesPlaytest.scenarios()).catch(() => []);
            const sc = scenarios.find((s: any) => s.id === p.scenario);
            if (!sc) throw new GenError(`No scenario "${p.scenario}". This game has: ${scenarios.map((s: any) => s.id).join(', ') || 'none'}`, { kind: 'contract' });
            const limit = (p.timeout ?? Math.max(60, Math.round((sc.seconds || 150) * 2))) * 1000;
            // Now that the scenario's length is known, tighten the watchdog: what's left of loading, the limit, wrapping up.
            arm(Math.max(0, bootEnd - Date.now()) + limit + 300_000);
            ctx.step(`waiting for the game to be ready`);
            while (Date.now() < bootEnd && !killed) {
              const ready = await ev<boolean>(() => (window as any).hawkesPlaytest.state().ready).catch(() => false);
              if (ready) break;
              await sleep(500);
            }
            await shot('ready');
            ctx.step(`playing "${sc.title ?? sc.id}"`);
            // Some games' start() resolves only when the scenario ends: start it without waiting, then follow state().
            // A start() that throws or rejects is kept and reported.
            await ev((a: any) => {
              const w = window as any;
              w.__hawkesStartError = null;
              try {
                const r = w.hawkesPlaytest.start(a[0], { ...(a[3] ?? {}), seed: a[1], speed: a[2] });
                if (r && typeof r.then === 'function') r.then(null, (e: any) => { w.__hawkesStartError = String(e?.stack ?? e); });
              } catch (e: any) {
                w.__hawkesStartError = String(e?.stack ?? e);
              }
              return true;
            }, [p.scenario, p.seed, p.speed, p.options && typeof p.options === 'object' ? p.options : null], 30_000);
            const start = Date.now();
            let nextShot = Date.now() + p.shotEvery * 1000;
            let lastScene: string | undefined;
            let lastProblems = 0;
            let lastDetail = '';
            let lastAnswer = Date.now();
            let st: any = null;
            for (;;) {
              if (killed) throw new Stuck(killed);
              await sleep(500);
              st = await ev<any>(() => {
                const w = window as any;
                const s = w.hawkesPlaytest?.state();
                return w.__hawkesStartError ? { ...(s ?? {}), status: 'error', __startError: w.__hawkesStartError } : s;
              }, undefined, 10_000).catch((e: any) => {
                if (killed) throw new Stuck(killed);
                return e instanceof Stuck ? undefined : null;
              });
              if (st === undefined) {
                // The page stopped answering. A minute of that is a hung page.
                if (Date.now() - lastAnswer > 60_000) throw new Stuck('the page stopped answering for a minute');
              } else {
                lastAnswer = Date.now();
              }
              if (st) {
                timeline.push({ t: T(), status: st.status, scene: st.scene, progress: st.progress, fps: st.fps, note: st.note, metrics: st.metrics });
                if (timeline.length > 5000) timeline.splice(0, 1000);
                if (st.scene && st.scene !== lastScene) {
                  lastScene = st.scene;
                  await shot('scene', st.scene);
                }
                const detail = `${sc.id}: ${st.scene ?? ''}${st.progress != null ? ` ${Math.round(st.progress * 100)}%` : ''}${st.note ? ` (${st.note})` : ''}`;
                if (detail !== lastDetail) {
                  lastDetail = detail;
                  ctx.step(detail);
                }
                if (st.__startError) problems.push({ severity: 'bug', message: `hawkesPlaytest.start() failed: ${String(st.__startError).slice(0, 400)}`, source: 'game' });
                if (TERMINAL.has(st.status)) {
                  outcome = st.status;
                  break;
                }
              }
              const nProblems = problems.length + consoleLines.filter((c) => c.type === 'error').length;
              if (nProblems > lastProblems) {
                lastProblems = nProblems;
                await shot('problem', lastScene);
              }
              if (Date.now() >= nextShot) {
                nextShot = Date.now() + p.shotEvery * 1000;
                await shot('every', lastScene);
              }
              if (Date.now() - start > limit) {
                outcome = 'stuck';
                problems.push({ severity: 'bug', message: `the scenario didn't finish within ${Math.round(limit / 1000)} s`, source: 'runner' });
                await ev(() => (window as any).hawkesPlaytest?.stop?.(), undefined, 10_000).catch(() => {});
                break;
              }
              if (ctx.signal.aborted) throw new GenError('cancelled', { kind: 'cancelled' });
            }
            await sleep(1000);
            await shot('end', lastScene);
            report = await ev<any>(() => (window as any).hawkesPlaytest?.report()).catch(() => null);
            if (report?.outcome) outcome = report.outcome;
            for (const pr of report?.problems ?? []) problems.push({ severity: pr.severity, message: pr.message, source: 'game' });
          } else {
            outcome = await genericSmoke(page, ctx, shot, p, () => killed);
          }
        }
      } catch (e: any) {
        // Errors that are the caller's (no such scenario, no contract) or a cancel end the job. Anything else (a hung
        // or crashed browser, page or tunnel) ends the run with what it recorded.
        if (ctx.signal.aborted) throw new GenError('cancelled', { kind: 'cancelled' });
        if (e instanceof GenError) throw e;
        stuck = killed || e.message?.split('\n')[0] || String(e);
        outcome = e instanceof Stuck || killed ? 'stuck' : 'error';
        problems.push({ severity: 'bug', message: `the run ${outcome === 'stuck' ? 'got stuck' : 'broke'}: ${stuck}`, source: 'runner' });
        ctx.log(`run ended early (${outcome}): ${stuck}`);
        // A frozen page won't take a screenshot either.
        if (outcome !== 'stuck') await shot('end');
      }

      // Wrapping up: none of it may hang either.
      // (A page that stopped answering is asked nothing more.)
      const asleep = Boolean(killed || stuck);
      const fpsSamples: number[] = asleep ? [] : await ev<number[]>(() => (window as any).__hawkesRunnerFps?.samples ?? []).catch(() => []);
      // Which GPU the browser drew with: SwiftShader/llvmpipe means software rendering, where frame rates mean nothing.
      const renderer: string = asleep ? 'unknown' : await ev<string>(() => {
        try {
          const gl = document.createElement('canvas').getContext('webgl');
          const d = gl?.getExtension('WEBGL_debug_renderer_info');
          return String(d ? gl!.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) ?? 'none');
        } catch {
          return 'unknown';
        }
      }).catch(() => 'unknown');
      const software = /swiftshader|llvmpipe|software|basic render/i.test(renderer);
      if (screencast) {
        const r = await within(screencast.stop(), 30_000, 'stopping the screencast').catch((e: any) => {
          ctx.log(`screencast: ${e.message}`);
          return null;
        });
        if (r) Object.assign(recorder, { frames: r.frames, written: r.written, seconds: Math.round(r.seconds * 10) / 10 });
      }
      const video = page.video();
      await within(context.close(), 60_000, 'closing the tab').catch((e: any) => ctx.log(`closing the tab: ${e.message}`));
      // saveAs works for local and remote (GPU server) browsers alike. If the browser died, a local recording is
      // still on disk (as far as it got).
      let webm: string | null = null;
      if (video && !killed) {
        webm = ctx.tmp('video.webm');
        await within(video.saveAs(webm), 120_000, 'saving the video').catch((e: any) => { ctx.log(`video: ${e.message}`); webm = null; });
      }
      if (!webm || !fs.existsSync(webm)) webm = newestFile(videoDir, '.webm');
      if (watchdog) clearTimeout(watchdog);

      // Results.
      const errors = consoleLines.filter((c) => c.type === 'error');
      for (const e of dedupe(errors.map((c) => c.text))) problems.push({ severity: 'bug', message: `console error: ${e}`, source: 'console' });
      for (const f of dedupeBy(failed, (x) => x.url).slice(0, 20)) problems.push({ severity: 'bug', message: `request failed (${f.status}): ${f.url}`, source: 'network' });
      for (const s of shots) {
        if (fs.statSync(s.file).size < 9_000) problems.push({ severity: 'warning', message: `the screen looks blank at ${s.t} s (${s.reason})`, source: 'runner' });
      }
      const fps = summarizeFps(fpsSamples);
      if (fps.average && fps.average < 30 && !software) problems.push({ severity: 'warning', message: `low frame rate: ${fps.average} fps on average (worst ${fps.worst}) in this browser`, source: 'runner' });

      const result: any = {
        url: p.url, mode: contract ? 'contract' : p.mode === 'site' ? 'site' : 'generic', scenario: contract ? p.scenario : null, outcome,
        stuck, device: p.mobile ? 'phone' : 'desktop', viewport, browser: host ? `GPU server ${host.server}` : 'this machine',
        seconds: T(), loadSeconds, fps, renderer, software, softwareBecause, contract, scenarios,
        metrics: report?.metrics ?? {}, events: report?.events ?? [], log: report?.log ?? [],
        problems: dedupeBy(problems, (x) => x.message),
        console: { errors: errors.length, warnings: consoleLines.length - errors.length, first: consoleLines.slice(0, 30) },
        failedRequests: dedupeBy(failed, (x) => x.url).slice(0, 50),
        pages, timeline: thin(timeline, 400), recorder,
        shots: shots.map((s, i) => ({ i, t: s.t, reason: s.reason, scene: s.scene, asset: null as string | null })),
        video: null as string | null,
        visual: null as any,
        s3: null as any,
      };
      // The browser is done with: let the next playtest have it while this one saves.
      await within(browser.close(), 15_000, 'closing the browser').catch(() => {});
      host?.close();
      release?.();
      release = null;

      ctx.step('saving the recording');
      const lastAsset = () => (ctx.outputs[ctx.outputs.length - 1] as any)?.asset ?? null;
      let mp4: string | null = null;
      const title = `Playtest video (${result.scenario ?? result.mode}${p.mobile ? ', phone' : ''})`;
      const mjpeg = screencast && fs.existsSync(screencast.file) && fs.statSync(screencast.file).size > 0 ? screencast.file : null;
      if (mjpeg) {
        const out = ctx.tmp('playtest.mp4');
        try {
          // On the machine that recorded it (this server's two cores stay free for the agents), else here.
          let encoded = false;
          if (host) {
            ctx.step(`encoding the video on ${host.server}`);
            try {
              const encoder = await encodeRemotely(host.ssh, remoteEncodeScript(viewport), mjpeg, out, AbortSignal.any([ctx.signal, AbortSignal.timeout(20 * 60_000)]));
              Object.assign(recorder, { encodedOn: host.server, encoder });
              encoded = true;
            } catch (e: any) {
              if (ctx.signal.aborted) throw e;
              ctx.log(`video: encoding on ${host.server} failed (${e.message}); encoding here instead`);
            }
          }
          if (!encoded) {
            ctx.step('encoding the video');
            await runProc('ffmpeg', mjpegToMp4Args(mjpeg, out, viewport), { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20 * 60_000)]) });
            Object.assign(recorder, { encodedOn: 'this machine', encoder: 'libx264' });
          }
          mp4 = out;
          await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', mime: 'video/mp4', title, meta: { playtest: 'video' } });
          result.video = lastAsset();
        } catch (e: any) {
          ctx.log(`video: ${e.message}`);
        }
        fs.rmSync(mjpeg, { force: true });
      } else if (webm && fs.existsSync(webm)) {
        const out = ctx.tmp('playtest.mp4');
        try {
          await runProc('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10 * 60_000)]) });
          mp4 = out;
          await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', mime: 'video/mp4', title, meta: { playtest: 'video' } });
        } catch {
          await ctx.emit({ data: fs.readFileSync(webm), ext: '.webm', mime: 'video/webm', title, meta: { playtest: 'video' } });
        }
        result.video = lastAsset();
      }
      for (const [i, s] of shots.entries()) {
        await ctx.emit({ data: fs.readFileSync(s.file), ext: '.jpg', mime: 'image/jpeg', title: `${s.t}s ${s.reason}${s.scene ? ` — ${s.scene}` : ''}`, meta: { playtest: 'shot', t: s.t, reason: s.reason, scene: s.scene ?? null } });
        result.shots[i].asset = lastAsset();
      }

      // Visual regression: the same events in the previous run.
      if (p.baseline) {
        ctx.step('comparing screenshots with the previous run');
        result.visual = await within(visualDiff(ctx, shots, p.baseline, lastAsset), 3 * 60_000, 'the screenshot comparison').catch((e: any) => {
          ctx.log(`visual diff: ${e.message}`);
          return { baseline: p.baseline, error: String(e.message).slice(0, 300), pairs: [] };
        });
      }

      // The video and report to S3, so they outlive the local library.
      const s3 = playtestBucket();
      if (s3) {
        ctx.step('uploading the video to S3');
        const prefix = `${ctx.job.project}/${new Date().toISOString().slice(0, 10)}/${ctx.job.id}`;
        result.s3 = { bucket: s3, region: S3_REGION, prefix, video: mp4 || webm ? `${prefix}/playtest${mp4 ? '.mp4' : '.webm'}` : null, report: `${prefix}/report.json` };
        try {
          await within(ensureBucket(s3), 60_000, 'checking the S3 bucket');
          if (result.s3.video) await within(putS3(s3, result.s3.video, fs.readFileSync((mp4 ?? webm)!), mp4 ? 'video/mp4' : 'video/webm'), 5 * 60_000, 'uploading the video');
          await within(putS3(s3, result.s3.report, Buffer.from(JSON.stringify(result, null, 2)), 'application/json'), 60_000, 'uploading the report');
        } catch (e: any) {
          ctx.log(`S3: ${e.message}`);
          result.s3.error = String(e.message).slice(0, 300);
        }
      }
      await ctx.emit({ data: Buffer.from(JSON.stringify(result, null, 2)), ext: '.json', mime: 'application/json', title: 'Playtest report', meta: { playtest: 'report' } });
      result.report = lastAsset();
      ctx.result(result);
      ctx.log(`${result.mode}${result.scenario ? ` ${result.scenario}` : ''}: ${outcome} in ${result.seconds} s, ${result.problems.length} problems, ${fps.average ?? '?'} fps${result.s3?.error ? ' (S3 upload failed)' : ''}`);
    } catch (e: any) {
      // Hung before there was a page (the tunnel, the browser, the tab): a stuck run with nothing recorded.
      if (!(e instanceof Stuck) || ctx.signal.aborted || page) throw e;
      const result = {
        url: p.url, mode: p.mode === 'site' ? 'site' : 'generic', scenario: null, outcome: 'stuck', stuck: e.message, device: p.mobile ? 'phone' : 'desktop', viewport,
        browser: host ? `GPU server ${host.server}` : 'this machine', seconds: 0, loadSeconds: null, fps: summarizeFps([]), contract: false, scenarios: [], metrics: {}, events: [], log: [],
        problems: [{ severity: 'bug', message: `the run got stuck before the page opened: ${e.message}`, source: 'runner' }],
        console: { errors: 0, warnings: 0, first: [] }, failedRequests: [], pages: [], timeline: [], shots: [], video: null, visual: null, s3: null,
      };
      ctx.log(`stuck: ${e.message}`);
      await ctx.emit({ data: Buffer.from(JSON.stringify(result, null, 2)), ext: '.json', mime: 'application/json', title: 'Playtest report', meta: { playtest: 'report' } });
      ctx.result(result);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      ctx.signal.removeEventListener('abort', onAbort);
      await screencast?.stop().catch(() => {});
      await within(browser?.close() ?? Promise.resolve(), 15_000, 'closing the browser').catch(() => {});
      host?.close();
      release?.();
    }
  },
};

/**
 * Runs the encode script on a playtest machine over SSH: the MJPEG goes up on stdin, the mp4 comes back on stdout into
 * `out`. Resolves with the encoder it used; rejects (and kills ssh) on failure, a bad exit or the signal.
 */
export function encodeRemotely(target: { args: string[]; dest: string }, script: string, input: string, out: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // The script travels base64-encoded, so no quoting survives into the remote shell.
    const command = `bash -c "$(printf %s ${Buffer.from(script).toString('base64')} | base64 -d)"`;
    const child = spawn('ssh', [...target.args, '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', target.dest, command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const file = fs.createWriteStream(out);
    let err = '';
    let failed: Error | null = null;
    const fail = (e: Error) => { failed ??= e; child.kill(); };
    const onAbort = () => fail(new Error(signal.reason?.message ?? 'cancelled'));
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort);
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.stdin.on('error', () => {});
    file.on('error', fail);
    // ssh that never started (not installed) doesn't always emit close.
    child.on('error', (e) => { fail(e); if (!child.pid) { file.end(); exited(-1); } });
    fs.createReadStream(input).on('error', fail).pipe(child.stdin);
    child.stdout.pipe(file);
    // Done when ssh has exited and the mp4 is flushed to disk (stdout's end closes the file).
    let code: number | null = null;
    let pending = 2;
    const settle = () => {
      if (--pending) return;
      signal.removeEventListener('abort', onAbort);
      const encoder = /encoder: (\S+)/.exec(err)?.[1] ?? 'unknown';
      const lines = err.split('\n').filter((l) => l.trim() && !l.startsWith('encoder:'));
      if (failed) reject(failed);
      else if (code !== 0) reject(new Error(lines.slice(-2).join(' ') || `exit ${code}`));
      else if (!fs.existsSync(out) || fs.statSync(out).size === 0) reject(new Error('no video came back'));
      else resolve(encoder);
    };
    let gone = false;
    const exited = (c: number | null) => { if (!gone) { gone = true; code = c; settle(); } };
    file.on('close', settle);
    child.on('close', exited);
  });
}

/** A step that hangs past its limit. The run ends as "stuck" (with what it recorded), not failed. */
class Stuck extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Stuck';
  }
}

/** Rejects with Stuck after ms. The work itself isn't stopped: killing the browser (the watchdog) does that. */
export function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Stuck(`${what} hung for ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The local browser (this PC's GPU, or software on the server) is one at a time; GPU servers take several. */
let localTurn: Promise<void> = Promise.resolve();
async function localSlot(signal: AbortSignal): Promise<() => void> {
  const before = localTurn;
  let release!: () => void;
  localTurn = new Promise<void>((r) => (release = r));
  // A cancel while waiting gives up this turn (once the one before ends, so turns never overlap).
  const aborted = new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  await Promise.race([before, aborted]);
  if (signal.aborted) {
    void before.then(release);
    throw new GenError('cancelled', { kind: 'cancelled' });
  }
  let done = false;
  return () => {
    if (!done) release();
    done = true;
  };
}

function newestFile(dir: string, ext: string) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).size > 0);
    return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ S3 (videos and reports)

const S3_REGION = 'us-east-1';
/** HAWKES_PLAYTEST_BUCKET picks another bucket; "off" keeps playtests local. */
const playtestBucket = () => {
  const b = process.env.HAWKES_PLAYTEST_BUCKET ?? 'hawkes-playtests-028793236279';
  return b && b !== 'off' ? b : null;
};

let s3client: any = null;
async function s3() {
  if (!s3client) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3client = new S3Client({ ...awsConfig(), region: S3_REGION });
  }
  return s3client;
}

const bucketsReady = new Map<string, Promise<void>>();
/** Creates the bucket if it's missing: private, no versioning, objects to Infrequent Access after 30 days. Once per process. */
function ensureBucket(bucket: string) {
  let ready = bucketsReady.get(bucket);
  if (!ready) {
    ready = (async () => {
      const S = await import('@aws-sdk/client-s3');
      const c = await s3();
      let exists = true;
      try {
        await c.send(new S.HeadBucketCommand({ Bucket: bucket }));
      } catch (e: any) {
        if (e?.$metadata?.httpStatusCode !== 404 && e?.name !== 'NotFound') throw e;
        exists = false;
      }
      if (!exists) {
        await c.send(new S.CreateBucketCommand({ Bucket: bucket, ObjectOwnership: 'BucketOwnerEnforced' }));
        await c.send(new S.PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
        console.log(`[playtest] created the S3 bucket ${bucket}`);
      }
      // The lifecycle rule, also on a bucket made before it existed.
      const has = await c.send(new S.GetBucketLifecycleConfigurationCommand({ Bucket: bucket })).then((r: any) => (r.Rules ?? []).some((x: any) => x.ID === 'infrequent-after-30-days'), () => false);
      if (!has) {
        await c.send(new S.PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: { Rules: [{ ID: 'infrequent-after-30-days', Status: 'Enabled', Filter: { Prefix: '' }, Transitions: [{ Days: 30, StorageClass: 'STANDARD_IA' }] }] },
        }));
      }
    })();
    ready.catch(() => bucketsReady.delete(bucket));
    bucketsReady.set(bucket, ready);
  }
  return ready;
}

async function putS3(bucket: string, key: string, body: Buffer, contentType: string) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await (await s3()).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

// ------------------------------------------------------------ visual regression

/** Screenshots at the same events in two runs: each scene's first shot, the load, ready and the end (pages in site mode). */
const eventKey = (reason: string, scene?: string | null) =>
  reason === 'scene' ? `scene: ${scene}` : reason === 'page' ? `page: ${scene}` : ['loaded', 'ready', 'end'].includes(reason) ? reason : null;

async function visualDiff(ctx: RunContext, shots: Shot[], baselineJob: string, lastAsset: () => string | null) {
  const before = new Map<string, any>();
  for (const a of listAssets({ job: baselineJob, limit: 500 }).items.filter((x: any) => x.meta?.playtest === 'shot').sort((x: any, y: any) => (x.meta.t ?? 0) - (y.meta.t ?? 0))) {
    const k = eventKey(a.meta.reason as string, a.meta.scene as string);
    if (k && !before.has(k) && fs.existsSync(a.path)) before.set(k, a);
  }
  const seen = new Set<string>();
  const pairs: { key: string; t: number; current: string; baseline: string; baselineAsset: string; shot: number }[] = [];
  for (const [i, s] of shots.entries()) {
    const k = eventKey(s.reason, s.scene);
    if (!k || seen.has(k) || !before.has(k)) continue;
    seen.add(k);
    pairs.push({ key: k, t: s.t, current: s.file, baseline: before.get(k).path, baselineAsset: before.get(k).id, shot: i });
  }
  if (!pairs.length) return { baseline: baselineJob, pairs: [], big: 0, note: before.size ? 'no matching events' : 'the baseline has no screenshots' };
  const list = ctx.tmp('visdiff.json');
  const outDir = ctx.tmp('visdiff');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(list, JSON.stringify(pairs.slice(0, 24).map((x) => ({ a: x.baseline, b: x.current }))));
  const scores = JSON.parse(await ctx.python('visdiff.py', [list, outDir]));
  const out: any[] = [];
  for (const [i, sc] of scores.entries()) {
    const pr = pairs[i];
    const row: any = { key: pr.key, t: pr.t, shot: pr.shot, baseline: pr.baselineAsset, score: sc.score, ssim: sc.ssim, changed: sc.changed, big: sc.score >= BIG_CHANGE, diff: null };
    if (row.big && sc.diff && fs.existsSync(sc.diff)) {
      await ctx.emit({ data: fs.readFileSync(sc.diff), ext: '.jpg', mime: 'image/jpeg', title: `Changed since the last run: ${pr.key} (${Math.round(sc.score * 100)}%)`, meta: { playtest: 'diff', key: pr.key, t: pr.t, score: sc.score } });
      row.diff = lastAsset();
    }
    out.push(row);
  }
  return { baseline: baselineJob, pairs: out, big: out.filter((x) => x.big).length };
}
/** 1 - SSIM at which a screenshot counts as a big change from the previous run. */
const BIG_CHANGE = 0.25;

function withParams(url: string, extra: Record<string, string>) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

async function looksLikeUnity(page: any) {
  return within(page.evaluate(() => Boolean((window as any).createUnityInstance || document.querySelector('#unity-canvas, #unity-container'))), 10_000, 'the page').catch(() => false);
}

/** Input that may hang with the page: limited, and a failure is ignored (the page may be navigating). */
const act = (work: Promise<unknown>) => within(work, 10_000, 'input').catch(() => {});

/** No contract: load, click (or tap, on a phone) the middle, press the usual keys for ~30 s, screenshot as it goes. */
async function genericSmoke(page: any, ctx: RunContext, shot: (r: string, s?: string) => Promise<void>, p: any, killed: () => string) {
  ctx.step(p.mobile ? 'generic smoke test: tapping' : 'generic smoke test: clicking and pressing keys');
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const press = (x: number, y: number) => act(p.mobile ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
  await press(vp.width / 2, vp.height / 2);
  await sleep(1500);
  await shot('clicked');
  const keys = ['Enter', 'Space', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Escape', 'Enter'];
  const end = Date.now() + 30_000;
  let i = 0;
  let next = Date.now() + p.shotEvery * 1000;
  while (Date.now() < end) {
    if (killed()) throw new Stuck(killed());
    if (p.mobile) {
      i++;
      await press(vp.width * (0.15 + Math.random() * 0.7), vp.height * (0.2 + Math.random() * 0.6));
      await sleep(700);
    } else {
      const k = keys[i++ % keys.length];
      await act(page.keyboard.down(k));
      await sleep(350);
      await act(page.keyboard.up(k));
      if (i % 5 === 0) await press(vp.width * (0.3 + Math.random() * 0.4), vp.height * (0.3 + Math.random() * 0.4));
    }
    if (Date.now() >= next) {
      next = Date.now() + p.shotEvery * 1000;
      await shot('every');
    }
  }
  await shot('end');
  return 'done';
}

/** Site mode: visit every same-origin page reachable from the start, up to maxPages. */
async function crawl(page: any, start: string, maxPages: number, ctx: RunContext, shot: (r: string, s?: string) => Promise<void>, problems: Problem[], killed: () => string) {
  const origin = new URL(start).origin;
  const queue = [new URL(start).toString()];
  const seen = new Set<string>(queue);
  const out: any[] = [];
  while (queue.length && out.length < maxPages) {
    if (killed()) throw new Stuck(killed());
    const url = queue.shift()!;
    ctx.step(`page ${out.length + 1}: ${url}`);
    const t = Date.now();
    let status: number | string = 'failed';
    try {
      const r = await within<any>(page.goto(url, { waitUntil: 'load', timeout: 45_000 }), 60_000, `loading ${url}`);
      status = r?.status() ?? 'none';
    } catch (e: any) {
      problems.push({ severity: 'bug', message: `page failed to load: ${url} (${e.message.split('\n')[0]})`, source: 'site' });
    }
    if (typeof status === 'number' && status >= 400) problems.push({ severity: 'bug', message: `page answers HTTP ${status}: ${url}`, source: 'site' });
    await sleep(800);
    const info = await within(page.evaluate(() => ({
      title: document.title,
      links: [...document.querySelectorAll('a[href]')].map((a: any) => a.href),
      images: [...document.images].filter((i: any) => i.complete && i.naturalWidth === 0).map((i: any) => i.currentSrc || i.src),
      text: document.body?.innerText?.length ?? 0,
    })), 15_000, 'the page').catch(() => ({ title: '', links: [] as string[], images: [] as string[], text: 0 })) as { title: string; links: string[]; images: string[]; text: number };
    for (const img of info.images) problems.push({ severity: 'bug', message: `broken image on ${url}: ${img}`, source: 'site' });
    if (!info.text) problems.push({ severity: 'warning', message: `page has no text: ${url}`, source: 'site' });
    await shot('page', info.title || url);
    out.push({ url, status, title: info.title, seconds: Math.round((Date.now() - t) / 100) / 10, brokenImages: info.images.length });
    for (const href of info.links) {
      try {
        const u = new URL(href);
        u.hash = '';
        if (u.origin !== origin || seen.has(u.toString())) continue;
        if (/\.(png|jpe?g|gif|webp|mp4|mp3|zip|pdf|unityweb|wasm|data)$/i.test(u.pathname)) continue;
        seen.add(u.toString());
        queue.push(u.toString());
      } catch {
        // Not a URL.
      }
    }
  }
  return out;
}

function summarizeFps(samples: number[]) {
  const s = samples.slice(2); // skip the loading seconds
  if (!s.length) return { average: null as number | null, worst: null as number | null, p5: null as number | null };
  const sorted = [...s].sort((a, b) => a - b);
  return { average: Math.round(s.reduce((a, b) => a + b, 0) / s.length), worst: sorted[0], p5: sorted[Math.floor(sorted.length * 0.05)] };
}

const dedupe = (xs: string[]) => [...new Set(xs)].slice(0, 30);
function dedupeBy<T>(xs: T[], key: (x: T) => string) {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}
function thin<T>(xs: T[], max: number) {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  return Array.from({ length: max }, (_, i) => xs[Math.floor(i * step)]);
}

// ----------------------------------------------------------------- review
//
// Reviews converge: a review reports at most a few findings (worst first; polish and ideas only when there is nothing
// worse), never one already in the caller's list of known findings (it says by id which of those look fixed or still
// there instead), and judges the build against the product's quality bar when one is given. Its mode says what the run
// is for: "full" (the daily review), "verify" (did this change work, did anything regress) or "regression" (only what
// got worse, and blockers). The caps and the mode are enforced on the answer too (settleReview), not only asked for.

const SEVERITIES = ['blocker', 'bug', 'polish', 'idea'];
const SEVERITY_RANK: Record<string, number> = { blocker: 0, bug: 1, polish: 2, idea: 3 };

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'verdict', 'scores', 'findings', 'known', 'meetsBar', 'changeWorked'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences: how the run went and what matters most.' },
    verdict: { type: 'string', enum: ['ship', 'fix-first', 'broken'] },
    scores: {
      type: 'object', additionalProperties: false,
      required: ['stability', 'visuals', 'clarity', 'feel', 'polish'],
      properties: Object.fromEntries(['stability', 'visuals', 'clarity', 'feel', 'polish'].map((k) => [k, { type: 'integer', description: '1 (bad) to 10 (excellent)' }])),
    },
    findings: {
      type: 'array',
      description: 'NEW problems only (none already in KNOWN FINDINGS), worst first, within the limit. An empty list is a fine answer.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'area', 'title', 'detail', 'evidence', 'fix', 'regression'],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          area: { type: 'string', description: 'gameplay, ui, art, audio, performance, story, onboarding, tech' },
          title: { type: 'string', description: 'Short, specific: what is wrong where.' },
          detail: { type: 'string' },
          evidence: { type: 'array', items: { type: 'integer' }, description: 'Indexes of the screenshots that show it.' },
          fix: { type: 'string', description: 'What to change, concretely (file or system if known).' },
          regression: { type: 'boolean', description: 'True only if this worked before and is now worse (the previous review, the visual changes or the change under test show it).' },
        },
      },
    },
    known: {
      type: 'array',
      description: 'Known findings this run says something about, by id: "fixed" when the evidence shows the problem is gone where it used to show, "present" when it is still there. Leave out the ones this run cannot judge.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'status', 'note'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['fixed', 'present'] },
          note: { type: 'string', description: 'One line: what in this run shows it.' },
        },
      },
    },
    meetsBar: { type: 'string', enum: ['yes', 'no', 'no-bar'], description: 'Does this build meet the QUALITY BAR? "no-bar" when none was given.' },
    changeWorked: { type: 'string', enum: ['yes', 'partly', 'no', 'n/a'], description: 'Verify mode: did the change under test do what it was meant to? Otherwise "n/a".' },
    changes: { type: 'array', items: { type: 'string' }, description: 'What got better or worse than the previous review, if one was given.' },
    criteria: {
      type: 'array',
      description: 'Only when ACCEPTANCE CRITERIA were given: one entry per criterion, in the same order.',
      items: {
        type: 'object', additionalProperties: false, required: ['criterion', 'met', 'evidence'],
        properties: {
          criterion: { type: 'string', description: 'The criterion, as given.' },
          met: { type: 'string', enum: ['yes', 'no', 'unclear'], description: 'yes: the run shows it; no: it shows it is not met or broken; unclear: the run never got to it.' },
          evidence: { type: 'string', description: 'What shows it: screenshot indexes, events, log lines (one or two sentences).' },
        },
      },
    },
    phone: {
      type: 'object', additionalProperties: false,
      description: 'Only for a phone run (390x844, touch): how it holds up on a phone.',
      required: ['touch', 'text', 'layout', 'notes'],
      properties: {
        touch: { type: 'integer', description: '1-10: on-screen touch controls exist, are big enough (about 44 px) and reachable; playable without a keyboard' },
        text: { type: 'integer', description: '1-10: text is readable at this size (not tiny, not cut off)' },
        layout: { type: 'integer', description: '1-10: everything fits the portrait screen: nothing cropped, overlapping or off-screen, no sideways scrolling' },
        notes: { type: 'string' },
      },
    },
  },
};

const REVIEW_SYSTEM = `You are the QA lead for a one-person game studio whose games are built and fixed by AI agents.
You review an automated playtest: screenshots from a real browser run plus the run's report (the game's own bot played it).
Every finding you report becomes work for an agent, so report what most needs fixing, not everything that could be better.
A short list that is right is worth more than a long one. "Nothing new" is a valid, good answer.
Be specific and visual: name what you see on screen, where, and when.

Rules:
- Report only what the evidence supports (screenshots, console errors, the report's problems and metrics). Don't invent.
- Blocker: the game can't be played or progressed. Bug: something is wrong (broken, wrong, missing, crashing).
  Polish: works but looks or feels unfinished. Idea: an improvement worth doing.
- At most the LIMIT findings, worst first. Polish and ideas only when you found no blocker or bug.
- Never report a problem that is already in KNOWN FINDINGS (same problem, even in other words): say in "known", by id,
  whether it looks fixed or is still present, and only when this run actually shows it.
- When a QUALITY BAR is given, judge against it: it says what "done" means for this product. Something the bar doesn't ask
  for is not a bug. A build that meets its bar gets "ship" and at most a couple of findings.
- "ship" comes with few or no findings and never with a blocker.
- Judge against the product's story and art direction when they are given. Flag anything off-tone.
- Ignore problems caused only by the automation (the bot's odd movement) unless a player could hit them.
- Don't comment on the runner's own frame-rate warning unless the screenshots also show stutter or the game reports low fps.
- If softwareRendering is true, the browser had no GPU: ignore frame rates and slowness entirely (they say nothing about players).
- Each fix says what to change, as concretely as you can.
- If VISUAL CHANGES are listed, the same moment looked different in the previous run. Say whether each big change is an
  improvement, a regression, or just a different moment (camera, animation, random content); report regressions.`;

const MODE_RULES: Record<string, string> = {
  full: `MODE: full review (the daily one). Find the worst new problems, within the limit.`,
  verify: `MODE: verify. This run checks a change (see FOCUS). Answer two questions: did the change do what it was meant to
("changeWorked", and "known" for the findings it was meant to fix), and did anything get worse? Report only regressions
(regression: true) and blockers. No polish, no ideas, no other old problems: this is not a full review.`,
  regression: `MODE: regression check (e.g. the live site after a deploy). Report only what is broken or got worse:
regressions (regression: true) and blockers. No polish, no ideas, nothing that was already like this.`,
};

const PHONE_RULES = `This run was on a PHONE: 390x844 CSS pixels, portrait, touch only (no keyboard or mouse). Judge it as a phone player:
- Touch controls: is there an on-screen way to do everything the game needs? Are tap targets big enough (about 44 px)
  and placed where thumbs reach? A game that needs a keyboard and says nothing about it is a bug on a phone.
- Text size: can every line be read at this size? Flag tiny, cramped or cut-off text.
- Layout: does everything fit the portrait screen? Flag cropped or off-screen UI, overlap, sideways scrolling, letterboxing
  that wastes most of the screen, and anything hidden under the browser's bars.
Fill "phone" with scores for these, and use area "mobile" for these findings.`;

export type KnownFinding = { id: string; title: string; severity?: string; status?: string };

/**
 * Holds a review to its mode and limits, whatever the model answered: findings worst first, polish and ideas only when
 * there is no blocker or bug, only regressions and blockers outside a full review, at most maxFindings (a "ship" verdict
 * at most 2 and never with a blocker); "known" only for ids that were given. What was cut is counted in review.trimmed.
 */
export function settleReview(review: any, { mode = 'full', maxFindings = 5, known = [] as KnownFinding[] } = {}) {
  const all: any[] = (Array.isArray(review.findings) ? review.findings : []).filter((f: any) => f?.title);
  let list = [...all].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  if (mode !== 'full') list = list.filter((f) => f.severity === 'blocker' || f.regression === true);
  if (list.some((f) => f.severity === 'blocker' || f.severity === 'bug')) list = list.filter((f) => f.severity === 'blocker' || f.severity === 'bug');
  if (review.verdict === 'ship' && list.some((f) => f.severity === 'blocker')) review.verdict = 'fix-first';
  const cap = Math.max(0, Math.min(maxFindings, review.verdict === 'ship' ? 2 : maxFindings));
  list = list.slice(0, cap);
  review.trimmed = all.length - list.length;
  review.findings = list;
  const ids = new Set(known.map((k) => k.id));
  const seen = new Set<string>();
  review.known = (Array.isArray(review.known) ? review.known : []).filter((k: any) => ids.has(k?.id) && ['fixed', 'present'].includes(k.status) && !seen.has(k.id) && seen.add(k.id));
  review.mode = mode;
  return review;
}

/** One answer per acceptance criterion given, in order ("unclear" when the model skipped one). */
export function settleCriteria(review: any, criteria: string[]) {
  if (!criteria.length) { delete review.criteria; return review; }
  const got: any[] = Array.isArray(review.criteria) ? review.criteria : [];
  review.criteria = criteria.map((c, i) => {
    const g = got.find((x) => String(x?.criterion ?? '').trim() === c.trim()) ?? got[i];
    const met = ['yes', 'no', 'unclear'].includes(g?.met) ? g.met : 'unclear';
    return { criterion: c, met, evidence: String(g?.evidence ?? 'not judged').slice(0, 600) };
  });
  return review;
}

export const playtestReviewTool: Tool = {
  id: 'playtest.review',
  version: 4,
  title: 'Review a playtest (Claude)',
  description:
    'Claude watches a playtest.run job (its screenshots, report, console and metrics) against the product\'s story, art ' +
    'direction and quality bar, and returns scores, a verdict and at most maxFindings new findings (blocker, bug, polish, ' +
    'idea; polish and ideas only when there is nothing worse) with the screenshots that show each one and how to fix it. ' +
    'Give the known findings (the backlog) and it reports only new problems, saying by id which known ones look fixed or ' +
    'still present. mode: full (daily), verify (did a change work, did anything regress: regressions and blockers only), ' +
    'regression (live checks: regressions and blockers only). Give a previous review to hear what changed. Give acceptance ' +
    'criteria (a task\'s "done when") and each is judged yes, no or unclear with its evidence (result.criteria).',
  provider: 'anthropic',
  output: 'json',
  inputs: {},
  params: {
    job: { type: 'string', required: true, description: 'The playtest.run job id', example: 'j_0123456789ab' },
    product: { type: 'string', description: 'What the product is (one paragraph): genre, goal, audience' },
    story: { type: 'text', description: 'The story doc or its key points (tone, characters, rules)' },
    focus: { type: 'text', description: 'What J wants checked this time' },
    mode: { type: 'enum', values: ['full', 'verify', 'regression'], default: 'full', description: 'full: the daily review. verify: did the change in focus work, and did anything regress. regression: only what got worse, and blockers (live checks)' },
    maxFindings: { type: 'integer', default: 5, min: 0, max: 20, description: 'At most this many new findings, worst first' },
    known: { type: 'json', description: 'Findings already known (the backlog, ideas and won\'t-fix): [{ id, title, severity, status }]. Not reported again; the review says which look fixed or are still present', advanced: true },
    bar: { type: 'text', description: 'The product\'s quality bar: what "done" means for it. The review judges against it and says whether the build meets it' },
    criteria: { type: 'json', description: 'Acceptance criteria to judge, e.g. ["The main menu shows Training"]: result.criteria says for each yes, no or unclear, with evidence', advanced: true },
    previous:{ type: 'json', description: 'A previous review of the same scenario, to report what changed', advanced: true },
    frames: { type: 'integer', default: 16, min: 4, max: 40, description: 'How many screenshots Claude sees', advanced: true },
    model: { type: 'string', default: DEFAULT_MODEL, advanced: true },
  },
  async run(ctx) {
    const p = ctx.params;
    const row = db.prepare('SELECT tool, status, result, project FROM jobs WHERE id = ?').get(p.job) as any;
    if (!row) throw new GenError(`No job ${p.job}`);
    if (row.tool !== 'playtest.run') throw new GenError(`${p.job} is a ${row.tool} job, not playtest.run`);
    if (row.status !== 'done') throw new GenError(`${p.job} is ${row.status}; review it once it's done`);
    const result = JSON.parse(row.result ?? 'null');
    const assets = listAssets({ job: p.job, limit: 500 }).items.filter((a: any) => a.meta?.playtest === 'shot').sort((a: any, b: any) => (a.meta.t ?? 0) - (b.meta.t ?? 0));
    if (!assets.length) throw new GenError(`${p.job} has no screenshots`);
    // Frames: every event shot (problems, scenes, the end) first, then even spacing.
    const important = assets.filter((a: any) => ['problem', 'scene', 'end', 'ready', 'loaded', 'page'].includes(a.meta.reason));
    const picked = new Set<any>(important.slice(0, Math.ceil(p.frames * 0.6)));
    const rest = assets.filter((a: any) => !picked.has(a));
    const want = p.frames - picked.size;
    for (let i = 0; i < want && rest.length; i++) picked.add(rest[Math.floor((i * rest.length) / Math.max(1, want))]);
    const frames = assets.filter((a: any) => picked.has(a));
    // The biggest visual changes since the previous run: their previous frames go after this run's (up to 4).
    const big = (result.visual?.pairs ?? []).filter((x: any) => x.big).sort((a: any, b: any) => b.score - a.score);
    const before = big.slice(0, 4).map((x: any) => ({ x, asset: getAsset(x.baseline) })).filter((b: any) => b.asset && fs.existsSync(b.asset.path));
    const legend = [
      ...frames.map((a: any, i: number) => `[${i}] t=${a.meta.t}s ${a.meta.reason}${a.meta.scene ? ` (${a.meta.scene})` : ''}`),
      ...before.map((b: any, i: number) => `[${frames.length + i}] PREVIOUS RUN at "${b.x.key}" (compare with this run's frame at t=${b.x.t}s)`),
    ].join('\n');
    const phone = result.device === 'phone';
    const brief = {
      url: result.url, mode: result.mode, scenario: result.scenario, outcome: result.outcome, seconds: result.seconds,
      loadSeconds: result.loadSeconds, fps: result.fps, renderer: result.renderer, softwareRendering: result.software, metrics: result.metrics, problems: result.problems?.slice(0, 40),
      console: result.console, failedRequests: result.failedRequests?.slice(0, 15), events: result.events?.slice(-80),
      log: result.log?.slice(-40), pages: result.pages?.slice(0, 60),
    };
    const known: KnownFinding[] = (Array.isArray(p.known) ? p.known : []).filter((k: any) => k?.id && k?.title).slice(0, 200);
    const mode = MODE_RULES[p.mode] ? p.mode : 'full';
    const criteria: string[] = (Array.isArray(p.criteria) ? p.criteria : []).map((c: any) => String(c ?? '').trim()).filter(Boolean).slice(0, 20);
    const prompt = [
      p.product ? `PRODUCT\n${p.product}` : '',
      p.bar ? `QUALITY BAR (what "done" means for this product)\n${String(p.bar).slice(0, 3000)}` : '',
      p.story ? `STORY AND ART DIRECTION\n${String(p.story).slice(0, 12000)}` : '',
      p.focus ? `FOCUS THIS TIME\n${p.focus}` : '',
      MODE_RULES[mode],
      `LIMIT\nAt most ${p.maxFindings} new findings.`,
      criteria.length ? `ACCEPTANCE CRITERIA (judge each one from this run; fill "criteria", one entry per line, same order; strict: "yes" only when the run shows it, "unclear" when it never got there)\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : '',
      known.length ? `KNOWN FINDINGS (already in the backlog, the ideas list or marked won't fix: never report these again)\n${known.map((k) => `- ${k.id} [${k.severity ?? '?'}, ${k.status ?? 'open'}] ${String(k.title).slice(0, 160)}`).join('\n')}` : '',
      `PLAYTEST REPORT\n${JSON.stringify(brief, null, 1).slice(0, 30000)}`,
      `SCREENSHOTS (in order; refer to them by index)\n${legend}`,
      p.previous ? `PREVIOUS REVIEW\n${JSON.stringify(p.previous).slice(0, 8000)}` : '',
      big.length ? `VISUAL CHANGES SINCE THE LAST RUN (perceptual difference of the same moment: 0 = same, 1 = different)\n${big.slice(0, 12).map((x: any) => `- ${x.key} at t=${x.t}s: ${Math.round(x.score * 100)}% different, ${Math.round((x.changed ?? 0) * 100)}% of the screen changed`).join('\n')}` : '',
      phone ? PHONE_RULES : '',
      'Review this playtest.',
    ].filter(Boolean).join('\n\n');
    ctx.step(`Claude is reviewing ${frames.length} screenshots`);
    const r = await ask({ prompt, system: REVIEW_SYSTEM, images: [...frames.map((a: any) => a.path), ...before.map((b: any) => b.asset.path)], model: p.model, effort: 'high', maxTokens: 16000, schema: REVIEW_SCHEMA }, ctx.signal);
    ctx.usage({ provider: 'anthropic', unit: 'tokens', amount: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), cost: r.cost, detail: r.model });
    const review = settleCriteria(settleReview(JSON.parse(r.text), { mode, maxFindings: p.maxFindings, known }), criteria);
    // Evidence indexes -> the library's asset ids, so reports can show the frames.
    const shown = [...frames.map((a: any) => a.id), ...before.map((b: any) => b.asset.id)];
    for (const f of review.findings) f.shots = (f.evidence ?? []).map((i: number) => shown[i]).filter(Boolean);
    if (!phone) delete review.phone;
    review.visual = big.length ? { big: big.length, top: big.slice(0, 6).map((x: any) => ({ key: x.key, score: x.score, diff: x.diff })) } : null;
    review.frames = frames.map((a: any) => ({ asset: a.id, t: a.meta.t, reason: a.meta.reason, scene: a.meta.scene }));
    review.playtest = { job: p.job, url: result.url, scenario: result.scenario, outcome: result.outcome, seconds: result.seconds, fps: result.fps, problems: result.problems?.length ?? 0, device: result.device ?? 'desktop' };
    review.model = r.model;
    await ctx.emit({ data: Buffer.from(JSON.stringify(review, null, 2)), ext: '.json', mime: 'application/json', title: 'Playtest review' });
    ctx.result(review);
    ctx.log(`${review.verdict} (${mode}): ${review.findings.length} findings${review.trimmed ? ` (${review.trimmed} cut)` : ''}, ${review.known.length} known judged${p.bar ? `, bar: ${review.meetsBar}` : ''}`);
  },
};

