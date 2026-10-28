// The playtest service on Cloud Run (docs/playtest-cloudrun.md): a Playwright browser per WebSocket connection, on
// the instance's NVIDIA L4. Gen connects with chromium.connect('wss://<service>/pw', { headers: { Authorization:
// 'Bearer <Google ID token>' } }); Cloud Run checks the token (only Gen's service account is an invoker) before
// anything here sees the request.
//
//   GET  /ready      startup probe: 200 once the GPU self-test found a GL path that draws on the NVIDIA GPU
//   GET  /healthz    liveness: 200
//   GET  /selftest   the self-test's report (JSON); ?fresh=1 runs it again (?all=1 tries every candidate)
//   GET  /pw         WebSocket: one Chromium (launchServer with the chosen GPU flags) for this connection, proxied
//                    byte for byte; the browser closes when the connection does. One connection = one tab: a
//                    multiplayer playtest opens one per player, so Cloud Run's concurrency counts tabs.
//   GET  /encode     WebSocket: an MJPEG stream in (?w=&h=, the viewport), an H.264 mp4 out: NVENC when the self-test
//                    found it, else libx264 (encodeSession has the message protocol).
//
// Nothing here keeps state between connections; local builds never reach this machine (Gen serves them through
// Playwright's routing over the same connection).

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { selfTest, CANDIDATES, BASE_ARGS } from './gpu.mjs';

// The image installs ws; elsewhere (Gen's tests run this file from the repo) Playwright's bundled copy does.
const WebSocketServer = await import('ws').then((m) => m.WebSocketServer ?? m.default.WebSocketServer, async () => (await import('playwright-core/lib/utilsBundle')).default.wsServer);
const encoder = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

const PORT = Number(process.env.PORT || 8080);
const ALLOW_SOFTWARE = process.env.HAWKES_ALLOW_SOFTWARE === '1';
const MAX_SESSIONS = Math.max(1, Number(process.env.HAWKES_TABS || 4));
const FPS = 30;

let report = null;
let testing = null;
let sessions = 0;
let started = 0;

const log = (...a) => console.log(JSON.stringify({ severity: 'INFO', message: a.join(' ') }));

async function runSelfTest(opts = {}) {
  testing ??= selfTest(chromium, opts).then((r) => {
    report = r;
    log(`self-test: ${r.gpu.ok ? `GPU via ${r.gpu.id} (${r.gpu.renderer})` : `no GPU path (${r.candidates.map((c) => `${c.id}: ${c.renderer ?? c.error}`).join('; ')})`}, nvenc ${r.nvenc.ok ? 'yes' : 'no'}, ${r.seconds} s`);
    return r;
  }).finally(() => { testing = null; });
  return testing;
}

/** The launch options for every browser: the self-test's winner, else (only when allowed) software. */
function launchOptions() {
  const c = CANDIDATES.find((x) => x.id === report?.gpu?.id);
  return c ? { headless: true, channel: c.channel, args: c.args } : { headless: true, args: BASE_ARGS };
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
    if (url.pathname === '/ready') {
      if (report && (report.gpu.ok || ALLOW_SOFTWARE)) return send(res, 200, { ok: true, gl: report.gpu.id, renderer: report.gpu.renderer });
      return send(res, 503, { ok: false, testing: Boolean(testing), report });
    }
    if (url.pathname === '/selftest') {
      if (url.searchParams.get('fresh') === '1' || !report) await runSelfTest({ all: url.searchParams.get('all') === '1' });
      return send(res, 200, { ...report, sessions, maxSessions: MAX_SESSIONS, upSeconds: Math.round((Date.now() - started) / 1000), launch: launchOptions() });
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
  if (url.pathname === '/encode') return encoder.handleUpgrade(req, socket, head, (ws) => encodeSession(ws, url));
  if (url.pathname !== '/pw') return refuse(404, 'Not Found');
  if (!report || (!report.gpu.ok && !ALLOW_SOFTWARE)) return refuse(503, 'No GPU');
  // Cloud Run's concurrency already caps connections per instance; this guards a misconfigured deploy.
  if (sessions >= MAX_SESSIONS) return refuse(429, 'Too Many Tabs');
  sessions++;
  const job = String(req.headers['x-hawkes-job'] ?? '').slice(0, 40);
  const t0 = Date.now();
  let browserServer = null;
  let done = false;
  const finish = (why) => {
    if (done) return;
    done = true;
    sessions--;
    socket.destroy();
    browserServer?.close().catch(() => {});
    log(`session ${job || '?'} ended (${why}) after ${Math.round((Date.now() - t0) / 1000)} s; ${sessions} open`);
  };
  socket.on('error', () => finish('client error'));
  socket.on('close', () => finish('client closed'));
  try {
    const wsPath = `/${crypto.randomBytes(12).toString('hex')}`;
    browserServer = await chromium.launchServer({ ...launchOptions(), host: '127.0.0.1', port: 0, wsPath });
    if (done) return browserServer.close().catch(() => {});
    browserServer.process().on('exit', () => finish('browser exited'));
    const port = Number(new URL(browserServer.wsEndpoint()).port);
    const upstream = net.connect(port, '127.0.0.1');
    upstream.on('error', () => finish('browser connection error'));
    upstream.on('close', () => finish('browser connection closed'));
    upstream.on('connect', () => {
      // The client's handshake, re-addressed to the browser server's path (its key and version headers kept).
      const lines = [`GET ${wsPath} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (/^(authorization|x-forwarded-.*|x-cloud-trace-context|traceparent|forwarded|via)$/i.test(k)) continue;
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? `127.0.0.1:${port}` : req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
      log(`session ${job || '?'} started (${sessions} open, ${report?.gpu?.id ?? 'software'})`);
    });
  } catch (e) {
    log(`session ${job || '?'}: the browser didn't start: ${e?.message ?? e}`);
    if (!done) {
      refuse(500, 'Browser Failed');
      finish('launch failed');
    }
  }
});

started = Date.now();
server.listen(PORT, () => log(`playtest service on :${PORT}, up to ${MAX_SESSIONS} tabs`));
// The self-test before traffic: the startup probe (/ready) waits for it.
runSelfTest().catch((e) => log(`self-test failed: ${e?.message ?? e}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log(`${sig}: closing`); server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
