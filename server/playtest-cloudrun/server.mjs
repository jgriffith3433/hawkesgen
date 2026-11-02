// The playtest service on Cloud Run (docs/playtest-cloudrun.md): a Playwright browser per WebSocket connection, on
// the instance's NVIDIA L4 (gen-playtest), or with WebGL on the CPU through SwiftShader (gen-playtest-cpu: the same
// file with HAWKES_GL_MODE=software, built from Dockerfile.cpu). Gen connects with chromium.connect('wss://<service>/pw', { headers: { Authorization:
// 'Bearer <Google ID token>' } }); Cloud Run checks the token (only Gen's service account is an invoker) before
// anything here sees the request.
//
//   GET  /ready      startup probe: 200 once the self-test found a GL path that draws (GPU mode: on the NVIDIA GPU;
//                    software mode: on SwiftShader)
//   GET  /healthz    liveness: 200
//   GET  /ping       RunPod's load-balancer health check: 204 while the self-test runs, 200 once it passed
//                    (docs/playtest-runpod.md: the same image as a RunPod serverless endpoint, with HAWKES_TOKEN)
//   GET  /selftest   the self-test's report (JSON); ?fresh=1 runs it again (?all=1 tries every candidate)
//   GET  /pw         WebSocket: one Chromium (launchServer with the chosen GPU flags) for this connection, proxied
//                    byte for byte; the browser closes when the connection does. One connection = one tab: a
//                    multiplayer playtest opens one per player, so Cloud Run's concurrency counts tabs.
//   GET  /encode     WebSocket: an MJPEG stream in (?w=&h=, the viewport), an H.264 mp4 out: NVENC when the self-test
//                    found it, else libx264 (encodeSession has the message protocol).
//
// A /pw connection with X-Hawkes-Site (a customer's build: site.mjs) first fetches that build's archive from its signed
// link, unpacks it and serves it here on 127.0.0.1; the browser maps build.hawkes.test to it. Gen serves nothing.
// J's local builds never reach this machine (Gen serves them through Playwright's routing over the same connection).
// Unpacked builds are kept per instance (by checksum) while it lives, so the tabs of a run share one.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { selfTest, candidatesFor, glMode, BASE_ARGS, ensureGraphicsLibs, browserHandshake, wsDeflateAllowed } from './gpu.mjs';
import { parseSiteHeader, openSite, siteArg } from './site.mjs';

// The image installs ws; elsewhere (Gen's tests run this file from the repo) Playwright's bundled copy does.
const WebSocketServer = await import('ws').then((m) => m.WebSocketServer ?? m.default.WebSocketServer, async () => (await import('playwright-core/lib/utilsBundle')).default.wsServer);
const encoder = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

const PORT = Number(process.env.PORT || 8080);
const MODE = glMode();
const ALLOW_SOFTWARE = process.env.HAWKES_ALLOW_SOFTWARE === '1';
const MAX_SESSIONS = Math.max(1, Number(process.env.HAWKES_TABS || 4));
// On RunPod (docs/playtest-runpod.md) RunPod's gateway checks Gen's RunPod API key and drops the Authorization header;
// HAWKES_TOKEN is a second lock of our own: every /pw, /encode and /selftest must carry it as X-Hawkes-Token. Unset on
// Cloud Run, where only Gen's service account may call the service at all.
const TOKEN = process.env.HAWKES_TOKEN || '';
const tokenOk = (req) => {
  if (!TOKEN) return true;
  const got = Buffer.from(String(req.headers['x-hawkes-token'] ?? ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const FPS = 30;

let report = null;
let testing = null;
let sessions = 0;
let started = 0;

const log = (...a) => console.log(JSON.stringify({ severity: 'INFO', message: a.join(' ') }));

let graphics = null;

async function runSelfTest(opts = {}) {
  // A host without the driver's graphics libraries (RunPod serverless) gets them first (gpu.mjs ensureGraphicsLibs).
  testing ??= (MODE === 'gpu' && !graphics ? ensureGraphicsLibs({ log }).catch((e) => ({ done: false, why: String(e?.message ?? e) })) : Promise.resolve(graphics)).then((g) => {
    if (g && !graphics) { graphics = g; log(`driver graphics libraries: ${g.done ? `fetched ${g.version} (${g.libs} files, ${g.seconds} s)` : g.why}`); }
    return selfTest(chromium, opts);
  }).then((r) => {
    report = { ...r, graphics };
    if (!r.gl.ok) log(`driver: ${JSON.stringify(r.driver)}`);
    log(`self-test (${r.mode}): ${r.gl.ok ? `WebGL via ${r.gl.id} (${r.gl.renderer})${r.gl.fps ? `, ${r.gl.fps} fps on the bench` : ''}` : `no GL path (${r.candidates.map((c) => `${c.id}: ${c.renderer ?? c.error}`).join('; ')})`}, nvenc ${r.nvenc.ok ? 'yes' : 'no'}, ${r.seconds} s`);
    return r;
  }).finally(() => { testing = null; });
  return testing;
}

/** The launch options for every browser: the self-test's winner, else (only when allowed) Chromium's defaults. */
function launchOptions() {
  const c = candidatesFor(MODE).find((x) => x.id === report?.gl?.id);
  return c ? { headless: true, channel: c.channel, args: c.args } : { headless: true, args: BASE_ARGS };
}

/** The container's CPUs and memory as its cgroup limits them (what sizes tabs per instance), next to the host's. */
function machineSize() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
  const [quota, period] = (read('/sys/fs/cgroup/cpu.max') ?? 'max').split(/\s+/);
  const mem = read('/sys/fs/cgroup/memory.max');
  return {
    cpus: quota && quota !== 'max' ? Math.round((Number(quota) / Number(period || 100000)) * 10) / 10 : null,
    memoryGiB: mem && mem !== 'max' ? Math.round((Number(mem) / 2 ** 30) * 10) / 10 : null,
    hostCpus: os.availableParallelism?.() ?? os.cpus().length,
    hostMemoryGiB: Math.round(os.totalmem() / 2 ** 30),
  };
}

const send = (res, status, body, headers = {}) => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
  res.end(data);
};

/** The scale and pad filter (the same as Gen's sizeFilter in src/tools/screencast.ts). */
function sizeFilter(width, height) {
  const w = Math.ceil(width / 2) * 2;
  const h = Math.ceil(height / 2) * 2;
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

/**
 * The video encode, over a WebSocket (an HTTP/1 request body on Cloud Run is capped at 32 MiB; a 3-minute MJPEG is
 * ~200-300 MB, and WebSocket messages have no such cap). Gen sends the MJPEG as binary messages and then the text
 * "end"; this answers {"encoder","bytes"} as text, the mp4 as binary messages, then "done" (or {"error"} and closes).
 */
function encodeSession(ws, url) {
  const w = Math.max(16, Math.min(3840, Number(url.searchParams.get('w')) || 1280));
  const h = Math.max(16, Math.min(2160, Number(url.searchParams.get('h')) || 720));
  const nvenc = Boolean(report?.nvenc?.ok) && url.searchParams.get('encoder') !== 'libx264';
  const enc = nvenc ? ['h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '28', '-b:v', '0'] : ['libx264', '-preset', 'veryfast', '-crf', '28'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-'));
  const out = path.join(dir, 'out.mp4');
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0', '-vf', sizeFilter(w, h), '-c:v', ...enc, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  let finished = false;
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  ff.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
  ff.stdin.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Back-pressure: hold the socket while ffmpeg's pipe is full.
      if (!ff.stdin.write(data)) { ws.pause?.(); ff.stdin.once('drain', () => ws.resume?.()); }
    } else if (String(data) === 'end') ff.stdin.end();
  });
  ws.on('close', () => { if (!finished) ff.kill('SIGKILL'); });
  ff.on('close', async (code) => {
    finished = true;
    try {
      if (code !== 0 || ws.readyState !== 1) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ error: `ffmpeg exit ${code}: ${err.trim().split('\n').slice(-2).join(' ')}` }));
        return ws.close(1000);
      }
      const bytes = fs.statSync(out).size;
      ws.send(JSON.stringify({ encoder: enc[0], bytes }));
      for await (const chunk of fs.createReadStream(out, { highWaterMark: 1 << 20 })) {
        await new Promise((r, j) => ws.send(chunk, { binary: true }, (e) => (e ? j(e) : r())));
      }
      ws.send('done');
      ws.close(1000);
    } catch (e) {
      log(`encode: ${e?.message ?? e}`);
      ws.terminate?.();
    } finally {
      cleanup();
    }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    // RunPod's load balancer health check (PORT_HEALTH): 204 while the self-test runs (initializing: no traffic yet),
    // then 200 whatever it found. A worker whose /ping never says 200 gets no traffic and RunPod holds every request
    // for it until the client gives up (2026-10-29), so a worker without a GPU path answers instead: /pw refuses with
    // 412 No GPU, which Gen doesn't retry (it moves on to the CPU service at once).
    if (url.pathname === '/ping') {
      if (report) return send(res, 200, report.gl.ok ? 'ok' : 'no GPU path');
      res.writeHead(204);
      return res.end();
    }
    if (!tokenOk(req)) return send(res, 401, 'bad token');
    if (url.pathname === '/ready') {
      if (report && (report.gl.ok || ALLOW_SOFTWARE)) return send(res, 200, { ok: true, mode: MODE, gl: report.gl.id, renderer: report.gl.renderer });
      return send(res, 503, { ok: false, testing: Boolean(testing), report });
    }
    if (url.pathname === '/selftest') {
      if (url.searchParams.get('fresh') === '1' || !report) await runSelfTest({ all: url.searchParams.get('all') === '1' });
      return send(res, 200, { ...report, sessions, maxSessions: MAX_SESSIONS, machine: machineSize(), upSeconds: Math.round((Date.now() - started) / 1000), launch: launchOptions() });
    }
    return send(res, 404, 'not found');
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: String(e?.message ?? e) });
    else res.destroy();
  }
});

// A browser per connection: launchServer with the GPU flags (run-server would take the client's options, and
// Chromium then renders in software), on a random local port and path, and the client's socket piped to it.
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const refuse = (status, why) => {
    socket.end(`HTTP/1.1 ${status} ${why}\r\nRetry-After: 5\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  };
  if (!tokenOk(req)) return refuse(401, 'Unauthorized');
  if (url.pathname === '/encode') return encoder.handleUpgrade(req, socket, head, (ws) => encodeSession(ws, url));
  if (url.pathname !== '/pw') return refuse(404, 'Not Found');
  if (!report) return refuse(503, 'Starting');
  if (!report.gl.ok && !ALLOW_SOFTWARE) return refuse(412, MODE === 'software' ? 'No WebGL' : 'No GPU');
  // Cloud Run's concurrency already caps connections per instance; this guards a misconfigured deploy.
  if (sessions >= MAX_SESSIONS) return refuse(429, 'Too Many Tabs');
  sessions++;
  const job = String(req.headers['x-hawkes-job'] ?? '').slice(0, 40);
  const t0 = Date.now();
  let browserServer = null;
  let site = null;
  let done = false;
  const finish = (why) => {
    if (done) return;
    done = true;
    sessions--;
    socket.destroy();
    browserServer?.close().catch(() => {});
    site?.close().catch(() => {});
    log(`session ${job || '?'} ended (${why}) after ${Math.round((Date.now() - t0) / 1000)} s; ${sessions} open`);
  };
  socket.on('error', () => finish('client error'));
  socket.on('close', () => finish('client closed'));
  try {
    const wsPath = `/${crypto.randomBytes(12).toString('hex')}`;
    // A customer's build: fetched, unpacked and served here before the browser starts (site.mjs).
    const want = req.headers['x-hawkes-site'];
    if (want) {
      const s = parseSiteHeader(want);
      if (!s) {
        refuse(400, 'Bad Site');
        return finish('bad site header');
      }
      site = await openSite(s, { log });
      if (done) return site.close().catch(() => {});
    }
    const opts = launchOptions();
    browserServer = await chromium.launchServer({ ...opts, ...(site ? { args: [...(opts.args ?? []), siteArg(site.port)] } : {}), host: '127.0.0.1', port: 0, wsPath });
    if (done) return browserServer.close().catch(() => {});
    browserServer.process().on('exit', () => finish('browser exited'));
    const port = Number(new URL(browserServer.wsEndpoint()).port);
    const upstream = net.connect(port, '127.0.0.1');
    upstream.on('error', () => finish('browser connection error'));
    upstream.on('close', () => finish('browser connection closed'));
    upstream.on('connect', () => {
      // The client's handshake, re-addressed to the browser server's path (its key and version headers kept).
      // Behind Modal's relay without permessage-deflate (gpu.mjs wsDeflateAllowed): it can't read compressed frames.
      const lines = [`GET ${wsPath} HTTP/1.1`, ...browserHandshake(req.rawHeaders, port)];
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
      log(`session ${job || '?'} started (${sessions} open, ${report?.gl?.id ?? 'default flags'})`);
    });
  } catch (e) {
    log(`session ${job || '?'}: ${site === null && req.headers['x-hawkes-site'] ? 'the build' : 'the browser'} didn't start: ${e?.message ?? e}`);
    if (!done) {
      // A build that can't be fetched or unpacked is the customer's to fix, not a reason to try another runner.
      refuse(site === null && req.headers['x-hawkes-site'] ? 422 : 500, site === null && req.headers['x-hawkes-site'] ? 'Build Failed' : 'Browser Failed');
      finish('launch failed');
    }
  }
});

started = Date.now();
server.listen(PORT, () => log(`playtest service (${MODE}) on :${PORT}, up to ${MAX_SESSIONS} tabs${wsDeflateAllowed() ? '' : ', WebSocket compression off'}`));
// The self-test before traffic: the startup probe (/ready) waits for it.
runSelfTest().catch((e) => log(`self-test failed: ${e?.message ?? e}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log(`${sig}: closing`); server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
