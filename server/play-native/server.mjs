// hawkes-play-native's server (docs/play-native.md): one desktop playtest run per WebSocket session, on a RunPod
// serverless load-balancer worker with an NVIDIA GPU (or a PC with Docker, in software, for tests).
//
//   GET  /ping       RunPod's health check (PORT_HEALTH): 204 while the self-test runs, then 200 (with "no GPU path"
//                    when it found none: /session then refuses with 412, which Gen doesn't retry)
//   GET  /healthz    liveness: 200
//   GET  /ready      200 once the self-test proved a display that draws on the GPU (or software, when allowed)
//   GET  /selftest   the self-test's report (JSON); ?fresh=1 runs it again (not during a run)
//   GET  /session    WebSocket: one run (session.mjs). One at a time per worker (429 while busy).
//
// Every route but /ping and /healthz needs X-Hawkes-Token = HAWKES_TOKEN (RunPod's gateway checks Gen's RunPod key
// and drops Authorization; this is the second lock, as in the browser runner). The image holds no cloud credentials:
// a run gets its build and its upload targets as signed URLs in `start`.
//
// The session protocol (JSON text frames; the live view's JPEG frames are binary frames):
//   client -> runner   {type:"start", build:{url, sha256?, headers?}, target:"linux"|"proton", exe?, args?, env?,
//                        scenario?, options?, limits?, live?:{fps, width, frames}, upload?:{video, report, logs,
//                        dumps, shots:[...]}}   (each upload target: a signed URL, or {url, headers, method})
//                      {type:"input", id?, kind:"key"|"pointer"|"pad"|"text"|"action", ...}   (Run.input)
//                      {type:"stop"}
//   runner -> client   {type:"status", phase}, {type:"log", source, line}, {type:"hello"}, {type:"state"},
//                      {type:"event"}, {type:"problem"}, {type:"first-frame"}, {type:"exit"}, {type:"ack", re},
//                      binary JPEG frames, and last {type:"result", result}; then the runner closes (1000).

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { ensureDriver, gpuInfo } from './driver.mjs';
import { selfTest } from './display.mjs';
import { Run, startProblem, killPlayer, PREFIX_TEMPLATE, PLAYER_UID, PLAYER_GID } from './session.mjs';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.HAWKES_TOKEN || '';
const ALLOW_SOFTWARE = process.env.HAWKES_ALLOW_SOFTWARE === '1';
const ALLOW_HTTP = process.env.HAWKES_ALLOW_HTTP === '1'; // builds and uploads over plain http (local tests only)
const MAX_SECONDS = Math.max(60, Number(process.env.HAWKES_MAX_SECONDS || 3600));
const WIDTH = Number(process.env.HAWKES_WIDTH || 1280);
const HEIGHT = Number(process.env.HAWKES_HEIGHT || 720);

const log = (...a) => console.log(JSON.stringify({ severity: 'INFO', message: a.join(' ') }));
const tokenOk = (req) => {
  if (!TOKEN) return true;
  const got = Buffer.from(String(req.headers['x-hawkes-token'] ?? ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

const ctx = { display: null, selftest: null, input: null, maxSeconds: MAX_SECONDS, allowHttp: ALLOW_HTTP, prefix: null };
let testing = null;
let run = null;
let started = Date.now();

/** The input helper (input.py), restarted when it dies. send(obj) resolves its one-line answer. */
function inputHelper(display) {
  let proc = null;
  let queue = [];
  let rest = '';
  let n = 0;
  const helper = { status: null };
  const boot = () => new Promise((resolve) => {
    proc = spawn('python3', [new URL('./input.py', import.meta.url).pathname], { env: { ...process.env, DISPLAY: display }, stdio: ['pipe', 'pipe', 'pipe'] });
    let first = true;
    proc.stderr.on('data', (d) => log(`input: ${String(d).trim().slice(0, 300)}`));
    proc.stdout.on('data', (d) => {
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const l of lines) {
        let m;
        try { m = JSON.parse(l); } catch { continue; }
        if (first) { first = false; helper.status = m; resolve(m); continue; }
        queue.shift()?.(m);
      }
    });
    proc.on('exit', () => { for (const q of queue) q({ ok: false, error: 'input helper exited' }); queue = []; proc = null; if (first) resolve({ ready: false }); });
  });
  helper.ready = boot();
  helper.send = async (obj) => {
    if (!proc) helper.ready = boot();
    await helper.ready;
    if (!proc) return { ok: false, error: 'no input helper' };
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'input helper timed out' }), 10_000);
      queue.push((m) => { clearTimeout(timer); resolve(m); });
      proc.stdin.write(`${JSON.stringify({ ...obj, n: ++n })}\n`);
    });
  };
  return helper;
}

/**
 * A warmed Wine prefix: Proton makes one on first launch (~10-60 s of wineboot); doing it once per worker and copying
 * it per run takes that off every run. The template is root's and read-only to the player (a run must not change
 * the next run's prefix); each run gets its own copy.
 */
async function warmPrefix(display) {
  if (process.env.HAWKES_WARM_PREFIX === '0' || !fs.existsSync('/opt/proton/proton')) return { ok: false, why: 'off' };
  if (fs.existsSync(`${PREFIX_TEMPLATE}/pfx/system.reg`)) return { ok: true, why: 'there' };
  const t0 = Date.now();
  const dir = '/run/play/warm';
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ['compat', 'steam', 'home', 'tmp']) fs.mkdirSync(`${dir}/${d}`, { recursive: true });
  spawnSync('chown', ['-R', `${PLAYER_UID}:${PLAYER_GID}`, dir]);
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: `${dir}/home`, USER: 'player', DISPLAY: display, XDG_RUNTIME_DIR: `${dir}/tmp`,
    STEAM_COMPAT_DATA_PATH: `${dir}/compat`, STEAM_COMPAT_CLIENT_INSTALL_PATH: `${dir}/steam`, SteamAppId: '0', SteamGameId: '0',
    WINEDEBUG: '-all', WINEDLLOVERRIDES: 'winemenubuilder.exe=d', PROTON_NO_ESYNC: '1',
    ...(ctx.selftest?.vulkan?.icd ? { VK_ICD_FILENAMES: ctx.selftest.vulkan.icd } : {}),
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
  };
  const out = await new Promise((resolve) => {
    const p = spawn('python3', ['/opt/proton/proton', 'run', 'cmd.exe', '/c', 'exit'], { env, uid: PLAYER_UID, gid: PLAYER_GID, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o = (o + d).slice(-2000)));
    p.stderr.on('data', (d) => (o = (o + d).slice(-2000)));
    const timer = setTimeout(() => p.kill('SIGKILL'), 300_000);
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, out: o }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out: e.message }); });
  });
  killPlayer('KILL');
  if (!fs.existsSync(`${dir}/compat/pfx/system.reg`)) return { ok: false, why: `no prefix made (exit ${out.code}): ${out.out.trim().split('\n').slice(-4).join(' | ').slice(0, 600)}`, seconds: Math.round((Date.now() - t0) / 1000) };
  fs.rmSync(PREFIX_TEMPLATE, { recursive: true, force: true });
  fs.renameSync(`${dir}/compat`, PREFIX_TEMPLATE);
  spawnSync('chown', ['-R', 'root:root', PREFIX_TEMPLATE]);
  spawnSync('chmod', ['-R', 'go-w', PREFIX_TEMPLATE]);
  fs.rmSync(dir, { recursive: true, force: true });
  const size = spawnSync('du', ['-sm', PREFIX_TEMPLATE], { encoding: 'utf8' }).stdout.split('\t')[0];
  return { ok: true, seconds: Math.round((Date.now() - t0) / 1000), sizeMB: Number(size) };
}

async function runSelfTest() {
  testing ??= (async () => {
    const driver = gpuInfo() ? await ensureDriver({ log }).catch((e) => ({ done: false, why: String(e?.message ?? e) })) : null;
    if (driver) log(`driver: ${driver.done ? `fetched (${driver.seconds} s)` : driver.why}`);
    if (ctx.display?.proc) ctx.display.proc.kill('SIGKILL');
    const r = await selfTest({ width: WIDTH, height: HEIGHT, allowSoftware: ALLOW_SOFTWARE, log, driver });
    ctx.display = r.display;
    ctx.selftest = r.report;
    if (r.ok) {
      const rep = r.report;
      log(`self-test: ${rep.display.kind}, Vulkan on ${rep.vulkan.device} (${rep.vulkan.kind}), GL ${rep.gl.renderer}, nvenc ${rep.nvenc.ok ? 'yes' : 'no'}, ${rep.seconds} s`);
      ctx.input = inputHelper(rep.display.display);
      const st = await ctx.input.ready;
      rep.input = { xtest: Boolean(st?.ready), pad: Boolean(st?.pad), padError: st?.padError ?? null };
      ctx.prefix = warmPrefix(rep.display.display).then((p) => { rep.prefix = p; log(`wine prefix: ${p.ok ? `warm (${p.seconds ?? 0} s${p.sizeMB ? `, ${p.sizeMB} MB` : ''})` : p.why}`); return p; });
    } else log(`self-test: no display that draws (${r.report.tried.map((t) => `${t.kind}: ${t.error ?? t.vulkan?.map((v) => `${v.devices?.[0] ?? v.error} ${v.draw?.ok ? 'drew' : 'no draw'}`).join(', ')}`).join('; ')})`);
    return r.report;
  })().finally(() => { testing = null; });
  return testing;
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname === '/ping') {
      if (!ctx.selftest) { res.writeHead(204); return res.end(); }
      return send(res, 200, ctx.selftest.ok && (!ctx.selftest.software || ALLOW_SOFTWARE) ? 'ok' : 'no GPU path');
    }
    if (!tokenOk(req)) return send(res, 401, 'bad token');
    if (url.pathname === '/ready') {
      const ok = ctx.selftest?.ok && (!ctx.selftest.software || ALLOW_SOFTWARE);
      return send(res, ok ? 200 : 503, { ok: Boolean(ok), testing: Boolean(testing), busy: Boolean(run), selftest: ctx.selftest });
    }
    if (url.pathname === '/selftest') {
      if ((url.searchParams.get('fresh') === '1' && !run) || !ctx.selftest) await runSelfTest();
      return send(res, 200, { ...ctx.selftest, busy: Boolean(run), upSeconds: Math.round((Date.now() - started) / 1000) });
    }
    return send(res, 404, 'not found');
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: String(e?.message ?? e) });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const refuse = (status, why) => socket.end(`HTTP/1.1 ${status} ${why}\r\nRetry-After: 5\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  if (!tokenOk(req)) return refuse(401, 'Unauthorized');
  if (url.pathname !== '/session') return refuse(404, 'Not Found');
  if (!ctx.selftest || testing) return refuse(503, 'Starting');
  if (!ctx.selftest.ok || (ctx.selftest.software && !ALLOW_SOFTWARE)) return refuse(412, 'No GPU');
  if (run) return refuse(429, 'Busy');
  wss.handleUpgrade(req, socket, head, (ws) => session(ws, String(req.headers['x-hawkes-job'] ?? '').slice(0, 40)));
});

/** One session: wait for start, play the run, close. */
function session(ws, job) {
  const t0 = Date.now();
  let liveFrames = true;
  const out = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const io = {
    send: out,
    sendFrame: (jpeg) => { if (liveFrames && ws.readyState === 1 && ws.bufferedAmount < 4 * 1024 * 1024) ws.send(jpeg, { binary: true }); },
    log: (line) => log(`session ${job || '?'}: ${line}`),
  };
  let mine = null;
  const startTimer = setTimeout(() => { if (!mine) ws.close(4008, 'no start within 60 s'); }, 60_000);
  const ping = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 20_000);
  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(String(data)); } catch { return out({ type: 'error', error: 'not JSON' }); }
    if (m.type === 'start') {
      if (mine || run) return out({ type: 'error', error: 'a run is already going' });
      const why = startProblem(m, { allowHttp: ALLOW_HTTP });
      if (why) { out({ type: 'error', error: why }); return ws.close(4002, why.slice(0, 120)); }
      clearTimeout(startTimer);
      liveFrames = m.live?.frames !== false;
      mine = run = new Run(m, io, ctx);
      // A Proton run waits for the worker's warm prefix (the first minute after a cold start), at most 4 minutes.
      if (m.target === 'proton' && ctx.prefix) await Promise.race([ctx.prefix, new Promise((r) => setTimeout(r, 240_000))]);
      log(`session ${job || '?'}: run ${mine.id} (${m.target}) started`);
      const result = await mine.play();
      log(`session ${job || '?'}: run ${mine.id} ended ${result?.outcome} after ${Math.round((Date.now() - t0) / 1000)} s`);
      run = null;
      if (ws.readyState === 1) ws.close(1000, 'done');
    } else if (m.type === 'input') {
      if (!mine) return out({ type: 'ack', re: m.id, ok: false, error: 'no run' });
      const r = await mine.input(m).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (m.id != null) out({ type: 'ack', re: m.id, ok: Boolean(r?.ok), ...(r?.error ? { error: r.error } : {}) });
    } else if (m.type === 'stop') {
      mine?.stop();
    }
  });
  ws.on('close', () => {
    clearTimeout(startTimer);
    clearInterval(ping);
    // The conductor went away: end the run (it still uploads what it has to its signed URLs).
    if (mine && run === mine) mine.stop();
  });
}

started = Date.now();
fs.mkdirSync('/run/play', { recursive: true });
server.listen(PORT, () => log(`hawkes-play-native on :${PORT}${TOKEN ? '' : ' (no HAWKES_TOKEN: open)'}`));
runSelfTest().catch((e) => log(`self-test failed: ${e?.stack ?? e}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log(`${sig}: closing`); run?.stop(); server.close(); setTimeout(() => { killPlayer('KILL'); process.exit(0); }, 3000).unref(); });
