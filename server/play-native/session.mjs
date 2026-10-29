// One playtest run of a desktop build (docs/play-native.md, "A run"): fetch and unpack the build, launch it as the
// unprivileged user `player` (a Linux build directly, a Windows .exe under Proton), play it through playtest contract
// v2's native transport (contract/protocol.mjs, the reference runner's own code), or, when the game never says hello,
// a smoke run (launch, wait for frames, press the usual keys, catch crash, hang and black screen from the frames).
// Everything it records goes to the signed upload URLs in `start`. Every wait has a hard limit.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { listen } from './contract/ws-server.mjs';
import { RunnerSession, CLOSE, launchWith } from './contract/protocol.mjs';
import { startCapture } from './capture.mjs';
import { frameStats, frameDiff, isBlack } from './display.mjs';

export const PLAYER_UID = 1000;
export const PLAYER_GID = 1000;
export const RUN_ROOT = '/run/play';
export const BUILD_CACHE = '/var/cache/hawkes-builds';
export const PREFIX_TEMPLATE = '/var/cache/hawkes-pfx';
const PROTON = `${process.env.PROTON_DIR || '/opt/proton'}/proton`;
const FINISHED = new Set(['won', 'lost', 'done', 'stuck', 'error']);
const MAX_SHOTS = 24;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const secs = (ms) => Math.round(ms / 100) / 10;
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);

/** The run's limits from `start.limits`, clamped to the worker's caps. */
export function runLimits(l = {}, target = 'linux', maxSeconds = 3600) {
  const proton = target === 'proton';
  return {
    seconds: clamp(l.seconds, 10, maxSeconds, 600), // the scenario (or smoke) itself
    bootSeconds: clamp(l.bootSeconds, 10, 900, proton ? 240 : 120), // launch to first frame / ready
    helloSeconds: clamp(l.helloSeconds, 5, 600, proton ? 120 : 45), // launch to the SDK's hello, else smoke
    smokeSeconds: clamp(l.smokeSeconds, 5, 600, 40),
    fetchSeconds: clamp(l.fetchSeconds, 10, 1800, 600),
    maxBuildBytes: clamp(l.maxBuildBytes, 1e6, 20e9, 8e9),
    hangSeconds: clamp(l.hangSeconds, 5, 300, 15),
  };
}

/** What `start` must hold; null when fine, else why not. */
export function startProblem(m, { allowHttp = false } = {}) {
  if (!m || typeof m !== 'object') return 'start is not an object';
  if (!['linux', 'proton'].includes(m.target)) return 'target is linux or proton';
  const url = typeof m.build === 'string' ? m.build : m.build?.url;
  if (typeof url !== 'string') return 'build.url is missing';
  let u;
  try { u = new URL(url); } catch { return 'build.url is not a URL'; }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return 'build.url must be https';
  if (m.build?.sha256 && !/^[0-9a-f]{64}$/i.test(m.build.sha256)) return 'build.sha256 is not a sha256';
  if (m.exe != null && (typeof m.exe !== 'string' || m.exe.includes('\0') || path.posix.isAbsolute(m.exe) || m.exe.split(/[\\/]/).includes('..'))) return 'exe must be a path inside the build';
  if (m.args != null && (!Array.isArray(m.args) || m.args.some((a) => typeof a !== 'string'))) return 'args is a list of strings';
  if (m.env != null && (typeof m.env !== 'object' || Object.values(m.env).some((v) => typeof v !== 'string'))) return 'env is an object of strings';
  return null;
}

/** The archive kind from the first bytes: zip, gzip, xz, zstd, bzip2, 7z, tar, or null (a bare file). */
export function archiveKind(head) {
  const b = Buffer.from(head ?? []);
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b[0] === 0xfd && b.subarray(1, 6).toString('latin1') === '7zXZ\0') return 'xz';
  if (b.length >= 4 && b.readUInt32LE(0) === 0xfd2fb528) return 'zstd';
  if (b.subarray(0, 3).toString('latin1') === 'BZh') return 'bzip2';
  if (b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  if (b.length >= 262 && b.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  return null;
}

const walk = (dir, depth = 3, out = []) => {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
};

const isElf = (f) => { try { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])); } catch { return false; } };

/**
 * The executable to run: `exe` when given (relative to the build), else the obvious one: on proton the one .exe that
 * isn't a crash handler, launcher helper or redistributable; on linux an *.x86_64 / *.x86 / *.sh, else one ELF at the
 * top. Null when it can't tell (the error then lists what it saw).
 */
export function findExe(root, target, exe) {
  if (exe) {
    const p = path.join(root, exe.replace(/\\/g, '/'));
    return p.startsWith(root + path.sep) && fs.existsSync(p) ? p : null;
  }
  const files = walk(root, 2).map((f) => ({ f, rel: path.relative(root, f), depth: path.relative(root, f).split(path.sep).length }));
  const byDepth = (a, b) => a.depth - b.depth || a.rel.length - b.rel.length;
  if (target === 'proton') {
    const exes = files.filter((x) => /\.exe$/i.test(x.f) && !/crash|unins|redist|vc_?redist|dxsetup|setup|helper|launcher|ue4prereq|dotnet/i.test(path.basename(x.f))).sort(byDepth);
    return exes[0]?.f ?? null;
  }
  const named = files.filter((x) => /\.(x86_64|x86|arm64|sh)$/i.test(x.f)).sort(byDepth);
  if (named[0]) return named[0].f;
  const elves = files.filter((x) => x.depth <= 2 && !/\.so(\.|$)/.test(x.f) && isElf(x.f)).sort(byDepth);
  return elves[0]?.f ?? null;
}

/** MangoHud's CSV log to { fpsAvg, fps1Low, frameTimeP99Ms, frameTimeMaxMs, samples }. */
export function parseMangoHud(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const h = lines.findIndex((l) => /^fps,frametime/i.test(l.trim()));
  if (h < 0) return null;
  const cols = lines[h].split(',');
  const fi = cols.indexOf('fps');
  const ti = cols.indexOf('frametime');
  const rows = lines.slice(h + 1).map((l) => l.split(',')).filter((r) => r.length >= cols.length - 1);
  const fps = rows.map((r) => Number(r[fi])).filter((v) => v > 0);
  const ft = rows.map((r) => Number(r[ti])).filter((v) => v > 0).sort((a, b) => a - b);
  if (!fps.length) return null;
  const sorted = fps.slice().sort((a, b) => a - b);
  const low = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 100)));
  const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {
    fpsAvg: Math.round((fps.reduce((a, b) => a + b, 0) / fps.length) * 10) / 10,
    fps1Low: Math.round((low.reduce((a, b) => a + b, 0) / low.length) * 10) / 10,
    frameTimeP99Ms: ft.length ? Math.round(pct(ft, 0.99) * 100) / 100 : null,
    frameTimeMaxMs: ft.length ? Math.round(ft[ft.length - 1] * 100) / 100 : null,
    samples: fps.length,
  };
}

/** CPU ticks and resident memory of every process the player user runs (the game, Wine and its helpers). */
export function playerUsage(uid = PLAYER_UID) {
  let ticks = 0;
  let rss = 0;
  let procs = 0;
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== uid) continue;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ticks += Number(f[11]) + Number(f[12]); // utime + stime
      rss += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      procs++;
    } catch { /* gone */ }
  }
  return { ticks, rssMB: Math.round(rss / 1024), procs };
}

/** Kills every process of the player user (the game, wineserver, anything it left). */
export function killPlayer(signal = 'KILL') {
  spawnSync('pkill', [`-${signal}`, '-u', String(PLAYER_UID)], { timeout: 10_000 });
}

/** Uploads one file to a signed URL (a string, or { url, headers, method }). */
async function upload(target, file, contentType) {
  const t = typeof target === 'string' ? { url: target } : target;
  if (!t?.url) return { ok: false, error: 'no URL' };
  const size = fs.statSync(file).size;
  const body = await fs.openAsBlob(file, { type: contentType });
  try {
    const r = await fetch(t.url, { method: t.method ?? 'PUT', headers: { 'content-type': contentType, ...(t.headers ?? {}) }, body, signal: AbortSignal.timeout(600_000) });
    return r.ok ? { ok: true, bytes: size } : { ok: false, status: r.status, error: (await r.text().catch(() => '')).slice(0, 300) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** The keys a smoke run presses, in turn (X keysym names), and what else it does between them. */
export const SMOKE_STEPS = [
  { key: 'Return' }, { wait: 1500 }, { key: 'space' }, { click: [0.5, 0.5] }, { key: 'Return' }, { pad: 'a' }, { pad: 'start' },
  { key: 'Right', hold: 600 }, { key: 'Left', hold: 600 }, { key: 'Up', hold: 400 }, { key: 'Down', hold: 400 },
  { key: 'd', hold: 600 }, { key: 'a', hold: 600 }, { key: 'w', hold: 400 }, { key: 's', hold: 400 },
  { key: 'space' }, { key: 'z' }, { key: 'x' }, { key: 'e' }, { key: 'j' }, { click: [0.3, 0.6] }, { click: [0.7, 0.4] },
  { key: 'Return' }, { key: 'Escape' }, { wait: 1000 }, { key: 'Escape' },
];

/**
 * One run. `io` is the session socket's side: { send(obj), sendFrame(jpeg), log(line) }. `ctx` is the worker:
 * { display (the live X display), selftest (report), input (the input helper), maxSeconds, allowHttp }.
 */
export class Run {
  constructor(start, io, ctx) {
    this.m = start;
    this.io = io;
    this.ctx = ctx;
    this.id = crypto.randomBytes(6).toString('hex');
    this.dir = path.join(RUN_ROOT, this.id);
    this.target = start.target;
    this.limits = runLimits(start.limits, start.target, ctx.maxSeconds ?? 3600);
    this.t0 = now();
    this.phase = 'starting';
    this.stopRequested = false;
    this.problems = [];
    this.smokeInputs = []; // what a smoke run pressed, and when (the report shows what came before a crash)
    this.shots = [];
    this.output = []; // the process's stdout/stderr, last 2000 lines
    this.lastJpeg = null;
    this.lastJpegAt = 0;
    this.frames = { first: null, lastChange: null, last: null, prev: null, blackSince: null, count: 0, drawn: 0 };
    this.perf = { samples: [], cpuPct: null, rssMBMax: 0, gpu: [] };
    this.child = null;
    this.exit = null;
    this.quitting = false;
    this.session = null;
    this.result = null;
  }

  t() { return secs(now() - this.t0); }
  setPhase(p) { this.phase = p; this.io.send({ type: 'status', phase: p, t: this.t() }); this.io.log(`[${this.id}] ${p}`); }
  problem(severity, message) { this.problems.push({ severity, message, t: this.t() }); this.io.send({ type: 'problem', severity, message, t: this.t() }); }
  runLog(line) { this.io.send({ type: 'log', source: 'runner', line, t: this.t() }); }

  /** Everything, with a hard limit; resolves the result (never throws). */
  async play() {
    const hard = (this.limits.fetchSeconds + this.limits.bootSeconds + this.limits.seconds + this.limits.smokeSeconds + 180) * 1000;
    let timer;
    const watchdog = new Promise((r) => { timer = setTimeout(() => r('watchdog'), hard); });
    let how;
    try {
      how = await Promise.race([this.#play().then(() => 'ok', (e) => { this.error = String(e?.message ?? e); return 'error'; }), watchdog]);
    } finally {
      clearTimeout(timer);
    }
    if (how === 'watchdog') {
      this.error = `the run passed its hard limit (${Math.round(hard / 1000)} s)`;
      this.outcome = 'stuck';
    }
    await this.#finish().catch((e) => { this.error ??= `finishing: ${e?.message ?? e}`; });
    return this.result;
  }

  stop() { this.stopRequested = true; this.io.send({ type: 'status', phase: 'stopping', t: this.t() }); }

  /** Input from the conductor: real OS input through the helper, or `action` to the game's own input() hook. */
  async input(msg) {
    const kind = msg.kind ?? (msg.action ? 'action' : msg.key ? 'key' : null);
    if (kind === 'action') {
      if (!this.session?.hello) return { ok: false, error: 'the game has no contract connection' };
      this.session.input(String(msg.action), msg.down !== false);
      return { ok: true };
    }
    const d = this.ctx.display;
    const px = (v, size) => (v <= 1 && v >= 0 && !Number.isInteger(v) ? Math.round(v * size) : Math.round(v));
    switch (kind) {
      case 'key': return this.ctx.input.send({ op: 'key', key: String(msg.key), down: msg.down });
      case 'pointer': {
        if (msg.x != null && msg.y != null) await this.ctx.input.send({ op: 'move', x: px(Number(msg.x), d.width), y: px(Number(msg.y), d.height) });
        if (msg.button != null || msg.click) return this.ctx.input.send({ op: 'button', button: msg.button ?? 1, down: msg.down });
        if (msg.scroll) return this.ctx.input.send({ op: 'scroll', dy: msg.scroll });
        return { ok: true };
      }
      case 'pad':
        return msg.axis ? this.ctx.input.send({ op: 'axis', axis: msg.axis, value: msg.value }) : this.ctx.input.send({ op: 'pad', button: msg.button, down: msg.down });
      case 'text': {
        const r = spawnSync('xdotool', ['type', '--delay', '25', '--', String(msg.text ?? '').slice(0, 2000)], { env: { ...process.env, DISPLAY: d.display }, timeout: 60_000 });
        return { ok: r.status === 0, error: r.status === 0 ? undefined : String(r.stderr).slice(0, 200) };
      }
      default:
        return { ok: false, error: `unknown input kind ${kind}` };
    }
  }

  async #play() {
    fs.mkdirSync(path.join(this.dir, 'out', 'shots'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'out', 'mangohud'), { recursive: true });
    for (const d of ['game', 'home', 'tmp']) fs.mkdirSync(path.join(this.dir, d), { recursive: true });

    this.setPhase('fetching');
    const archive = await this.#fetch();
    this.setPhase('unpacking');
    this.#unpack(archive);
    const exe = findExe(path.join(this.dir, 'game'), this.target, this.m.exe);
    if (!exe) {
      const seen = walk(path.join(this.dir, 'game'), 1).map((f) => path.relative(path.join(this.dir, 'game'), f)).slice(0, 30);
      throw new Error(`no ${this.target === 'proton' ? '.exe' : 'Linux executable'} found${this.m.exe ? ` at "${this.m.exe}"` : ''} in the build (top: ${seen.join(', ') || 'empty'})`);
    }
    this.exe = exe;
    if (this.target === 'linux') fs.chmodSync(exe, 0o755);
    if (this.target === 'proton') {
      this.setPhase('prefix');
      this.#prefix();
    }
    spawnSync('chown', ['-R', `${PLAYER_UID}:${PLAYER_GID}`, this.dir], { timeout: 120_000 });
    fs.chmodSync(this.dir, 0o755);

    // The contract server, before the game starts (the SDK connects at once).
    const token = crypto.randomBytes(18).toString('base64url');
    let connected;
    this.gotConnection = new Promise((r) => (connected = r));
    this.contract = await listen({
      token,
      onConnection: (c) => {
        this.conn = c;
        const s = new RunnerSession((text) => c.send(text));
        this.session = s;
        c.on('text', (text) => s.handle(text));
        c.on('binary', () => s.handle('\u0000binary'));
        c.on('close', (info) => s.closedBy(info));
        s.on('fatal', ({ code, reason }) => { this.runLog(`protocol: ${reason}`); this.problem('bug', `playtest contract: ${reason}`); c.close(code, reason); });
        s.on('hello', (h) => this.io.send({ type: 'hello', hello: { product: h.product, engine: h.engine, engineVersion: h.engineVersion, sdk: h.sdk, platform: h.platform, scenarios: h.scenarios }, t: this.t() }));
        s.on('state', (st) => this.io.send({ type: 'state', state: st, t: this.t() }));
        s.on('event', (e) => { this.io.send({ type: 'event', event: e, t: this.t() }); if (e.type === 'scene' || e.type === 'problem' || e.type === 'finish') this.#shot(`${e.type}${e.detail ? `-${e.detail}` : ''}`); });
        s.on('log', (e) => this.io.send({ type: 'log', source: 'game', level: e.level, line: e.line, t: this.t() }));
        connected();
      },
    });

    // The recording, before launch, so boot is on the video.
    const disp = this.ctx.display;
    const live = this.m.live ?? {};
    this.capture = startCapture({
      display: disp.display, width: disp.width, height: disp.height, file: path.join(this.dir, 'out', 'video.mp4'),
      nvenc: Boolean(this.ctx.selftest?.nvenc?.ok), liveFps: clamp(live.fps, 1, 15, 5), liveWidth: clamp(live.width, 160, 1920, 960),
      onJpeg: (j) => this.#onJpeg(j), onGray: (g) => this.#onGray(g),
    });

    this.setPhase('launching');
    this.#launch(this.contract.url);
    this.perfTimer = setInterval(() => this.#sample(), 1000);
    this.perfTimer.unref();

    // Contract or smoke: wait for the SDK's hello (or the process to end, or a stop).
    this.setPhase('booting');
    const hello = await this.#until(() => this.session?.hello || this.exit || this.stopRequested, this.limits.helloSeconds * 1000);
    if (this.session?.hello && !this.exit) {
      this.mode = 'contract';
      await this.#playContract();
    } else if (this.exit) {
      this.mode = this.session?.hello ? 'contract' : 'smoke';
      this.#exitedEarly();
    } else if (!this.stopRequested) {
      this.mode = 'smoke';
      if (!hello) this.runLog(`no hello from a playtest SDK in ${this.limits.helloSeconds} s: a smoke run`);
      await this.#playSmoke();
    }
  }

  async #fetch() {
    const b = typeof this.m.build === 'string' ? { url: this.m.build } : this.m.build;
    const want = b.sha256?.toLowerCase();
    fs.mkdirSync(BUILD_CACHE, { recursive: true });
    if (want && fs.existsSync(path.join(BUILD_CACHE, want))) {
      this.build = { cached: true, sha256: want, bytes: fs.statSync(path.join(BUILD_CACHE, want)).size, seconds: 0 };
      this.runLog(`build ${want.slice(0, 12)} from this worker's cache`);
      return path.join(BUILD_CACHE, want);
    }
    const t0 = now();
    const tmp = path.join(BUILD_CACHE, `.part-${this.id}`);
    const r = await fetch(b.url, { headers: b.headers ?? {}, signal: AbortSignal.timeout(this.limits.fetchSeconds * 1000) });
    if (!r.ok || !r.body) throw new Error(`fetching the build: HTTP ${r.status}`);
    const declared = Number(r.headers.get('content-length') || 0);
    if (declared > this.limits.maxBuildBytes) throw new Error(`the build is ${declared} bytes, over the ${this.limits.maxBuildBytes} limit`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const max = this.limits.maxBuildBytes;
    const counter = new TransformStream({
      transform(chunk, c) {
        bytes += chunk.length;
        if (bytes > max) throw new Error(`the build passed the ${max} byte limit`);
        hash.update(chunk);
        c.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(r.body.pipeThrough(counter)), fs.createWriteStream(tmp));
    const got = hash.digest('hex');
    if (want && got !== want) { fs.rmSync(tmp, { force: true }); throw new Error(`the build's sha256 is ${got}, not ${want}`); }
    const final = path.join(BUILD_CACHE, got);
    fs.renameSync(tmp, final);
    this.#trimCache();
    this.build = { cached: false, sha256: got, bytes, seconds: secs(now() - t0) };
    this.runLog(`build fetched: ${(bytes / 1e6).toFixed(1)} MB in ${this.build.seconds} s`);
    return final;
  }

  /** Keeps the build cache under HAWKES_BUILD_CACHE_GB (default 20), oldest use first. */
  #trimCache() {
    const cap = Number(process.env.HAWKES_BUILD_CACHE_GB || 20) * 1e9;
    const files = fs.readdirSync(BUILD_CACHE).filter((f) => /^[0-9a-f]{64}$/.test(f)).map((f) => { const s = fs.statSync(path.join(BUILD_CACHE, f)); return { f, size: s.size, at: s.atimeMs }; }).sort((a, b) => b.at - a.at);
    let total = 0;
    for (const x of files) { total += x.size; if (total > cap) fs.rmSync(path.join(BUILD_CACHE, x.f), { force: true }); }
  }

  #unpack(archive) {
    const t0 = now();
    const fd = fs.openSync(archive, 'r');
    const head = Buffer.alloc(512);
    fs.readSync(fd, head, 0, 512, 0);
    fs.closeSync(fd);
    const kind = archiveKind(head);
    const dest = path.join(this.dir, 'game');
    if (!kind) {
      // A bare executable (an AppImage, a single .exe, a static binary).
      const name = this.m.exe ? path.basename(this.m.exe) : this.target === 'proton' ? 'game.exe' : 'game';
      fs.copyFileSync(archive, path.join(dest, name));
    } else {
      // bsdtar reads zip, tar and every compression here; it refuses ".." and strips leading "/" by default.
      const x = spawnSync('bsdtar', ['-xf', archive, '-C', dest, '--no-same-owner', '--no-same-permissions'], { encoding: 'utf8', timeout: 900_000 });
      if (x.status !== 0) throw new Error(`unpacking the build (${kind}) failed: ${(x.stderr || '').trim().slice(-300)}`);
      // One top folder (a zipped folder): play from inside it.
      const top = fs.readdirSync(dest);
      if (top.length === 1 && fs.statSync(path.join(dest, top[0])).isDirectory() && !this.m.exe) {
        const inner = path.join(dest, top[0]);
        for (const f of fs.readdirSync(inner)) fs.renameSync(path.join(inner, f), path.join(dest, f));
        fs.rmdirSync(inner);
      }
    }
    spawnSync('chmod', ['-R', 'u+rwX,go+rX', dest]);
    this.unpackSeconds = secs(now() - t0);
  }

  /** A fresh Wine prefix: a copy of the worker's warmed template when it has one (server.mjs warmPrefix). */
  #prefix() {
    const t0 = now();
    const compat = path.join(this.dir, 'compat');
    if (fs.existsSync(path.join(PREFIX_TEMPLATE, 'pfx'))) {
      const r = spawnSync('cp', ['-a', PREFIX_TEMPLATE, compat], { timeout: 300_000 });
      this.prefix = { from: 'template', ok: r.status === 0 };
    } else {
      fs.mkdirSync(compat, { recursive: true });
      this.prefix = { from: 'new' };
    }
    fs.mkdirSync(path.join(this.dir, 'steam'), { recursive: true });
    this.prefix.seconds = secs(now() - t0);
  }

  #env(url) {
    const disp = this.ctx.display;
    const st = this.ctx.selftest ?? {};
    const out = path.join(this.dir, 'out');
    const env = {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: path.join(this.dir, 'home'), USER: 'player', LOGNAME: 'player',
      LANG: 'C.UTF-8', TMPDIR: path.join(this.dir, 'tmp'), XDG_RUNTIME_DIR: path.join(this.dir, 'tmp'), DISPLAY: disp.display,
      SDL_JOYSTICK_DISABLE_UDEV: '1', SDL_AUDIODRIVER: 'dummy', __GL_SHADER_DISK_CACHE_PATH: path.join(this.dir, 'tmp'),
      ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
      ...(st.vulkan?.icd ? { VK_ICD_FILENAMES: st.vulkan.icd, VK_DRIVER_FILES: st.vulkan.icd } : {}),
      __EGL_VENDOR_LIBRARY_DIRS: '/usr/share/glvnd/egl_vendor.d',
    };
    if (st.mangohud && this.m.options?.mangohud !== false) {
      // MangoHud writes its CSV when logging stops, not as it goes (a killed game leaves none), so it logs a window:
      // from 5 s after launch for HAWKES_MANGOHUD_SECONDS (60) or the run's limit. Vulkan games only (DXVK and
      // VKD3D are Vulkan; a native OpenGL game would need LD_PRELOAD).
      const window = Math.max(10, Math.min(Number(process.env.HAWKES_MANGOHUD_SECONDS || 60), this.limits.seconds));
      Object.assign(env, { MANGOHUD: '1', MANGOHUD_CONFIG: `no_display,autostart_log=5,log_duration=${window},log_interval=0,output_folder=${path.join(out, 'mangohud')}` });
    }
    if (this.target === 'proton') {
      Object.assign(env, {
        STEAM_COMPAT_DATA_PATH: path.join(this.dir, 'compat'), STEAM_COMPAT_CLIENT_INSTALL_PATH: path.join(this.dir, 'steam'),
        SteamAppId: '0', SteamGameId: '0', WINEDEBUG: this.m.options?.wineDebug ?? '-all', DXVK_LOG_LEVEL: 'warn', VKD3D_DEBUG: 'none',
        WINEDLLOVERRIDES: 'winemenubuilder.exe=d', PROTON_NO_ESYNC: '1',
        ...(this.m.options?.wined3d ? { PROTON_USE_WINED3D: '1' } : {}),
      });
    }
    // The customer's own variables, except the ones that steer the runner.
    for (const [k, v] of Object.entries(this.m.env ?? {})) if (!/^(HAWKES_PLAYTEST|DISPLAY|HOME|STEAM_COMPAT_.*|XDG_RUNTIME_DIR)$/.test(k)) env[k] = v;
    return launchWith(url, this.m.options?.via ?? 'env', env, this.m.args ?? []);
  }

  #launch(url) {
    const { env, args } = this.#env(url);
    const [cmd, argv] = this.target === 'proton' ? ['python3', [PROTON, 'run', this.exe, ...args]] : [this.exe, args];
    const fd = fs.openSync(path.join(this.dir, 'out', 'output.log'), 'a');
    this.outFd = fd;
    this.launchedAt = now();
    const child = spawn(cmd, argv, { cwd: path.dirname(this.exe), env, uid: PLAYER_UID, gid: PLAYER_GID, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => { this.exit = { code, signal, t: this.t() }; this.io.send({ type: 'exit', code, signal, t: this.t() }); resolve(this.exit); });
      child.on('error', (e) => { this.exit = { code: null, signal: null, error: e.message, t: this.t() }; resolve(this.exit); });
    });
    for (const [s, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      let rest = '';
      s.setEncoding('utf8');
      s.on('data', (d) => {
        try { fs.writeSync(fd, d); } catch { /* closed */ }
        const lines = (rest + d).split(/\r?\n/);
        rest = lines.pop();
        for (const line of lines) {
          this.output.push(`${name}: ${line}`);
          if (this.output.length > 2000) this.output.shift();
          this.io.send({ type: 'log', source: name, line: line.slice(0, 2000), t: this.t() });
        }
      });
    }
    this.runLog(`launched ${this.target === 'proton' ? 'under Proton: ' : ''}${path.relative(path.join(this.dir, 'game'), this.exe)} ${args.join(' ')}`.trim());
  }

  /** Resolves true when test() turns true (checked every 200 ms), false after ms. */
  async #until(test, ms) {
    const t0 = now();
    while (now() - t0 < ms) {
      if (test()) return true;
      await delay(200);
    }
    return Boolean(test());
  }

  async #playContract() {
    const s = this.session;
    this.setPhase('ready?');
    await this.#until(() => s.state?.ready === true || this.exit || s.closed || this.stopRequested, this.limits.bootSeconds * 1000);
    if (this.exit || s.closed) return this.#exitedEarly();
    if (this.stopRequested) return;
    if (s.state?.ready !== true) {
      this.outcome = 'stuck';
      this.problem('bug', `the game never said ready within ${this.limits.bootSeconds} s`);
      return;
    }
    this.readyAt = this.t();
    const scenario = this.m.scenario ?? 'smoke';
    const sc = s.scenarios.find((x) => x.id === scenario);
    const limit = Math.min(this.limits.seconds, this.m.limits?.seconds ? this.limits.seconds : Math.max(30, (sc?.seconds ?? 60) * 2));
    this.setPhase('playing');
    const started = await s.start(scenario, this.m.options?.run ?? this.m.runOptions ?? { seed: 1, speed: 1 }).catch((e) => ({ ok: false, error: e.message }));
    if (!started.ok) this.runLog(`start refused: ${started.error ?? 'no reason'}`);
    this.runLog(`playing ${scenario} (limit ${limit} s)`);
    const ended = await this.#until(() => FINISHED.has(s.state?.status) || (s.report && FINISHED.has(s.report.outcome)) || s.closed || this.exit || this.stopRequested, limit * 1000);
    if (this.exit || s.closed) {
      await Promise.race([this.exited, delay(1500)]);
      return this.#exitedEarly();
    }
    if (!ended) {
      this.runLog(`no finish within ${limit} s: stopping (stuck)`);
      await s.stop().catch(() => {});
      this.outcome = 'stuck';
    } else if (this.stopRequested && !FINISHED.has(s.state?.status)) {
      await s.stop().catch(() => {});
    }
    const report = await s.getReport().catch(() => s.report);
    this.report = report ?? s.report;
    this.outcome ??= this.report?.outcome ?? s.state?.status ?? 'error';
    if (!this.report && !started.ok) this.error = started.error ?? 'start refused';
    this.#shot('end');
    this.quitting = true;
    await s.quit().catch(() => {});
    this.conn?.close(CLOSE.normal, 'done');
  }

  #exitedEarly() {
    const e = this.exit;
    this.crashed = true;
    this.outcome = 'error';
    this.report = this.session?.report ?? null;
    const how = e ? (e.error ?? (e.signal ? `signal ${e.signal}` : `exit code ${e.code}`)) : 'the connection dropped';
    const tail = this.output.filter((l) => /error|exception|fault|fatal|abort|segmentation|unhandled/i.test(l) && !/\[MANGOHUD\]/.test(l)).slice(-6);
    this.problem('bug', `the game ${e ? 'exited' : 'dropped the playtest connection'} at ${e?.t ?? this.t()} s (${how})${this.frames.first == null ? ', before drawing anything' : ''}${tail.length ? `: ${tail.join(' | ').slice(0, 600)}` : ''}`);
    this.#shot('exit');
  }

  async #playSmoke() {
    this.setPhase('smoke: waiting for frames');
    await this.#until(() => this.frames.first != null || this.exit || this.stopRequested || this.session?.hello, this.limits.bootSeconds * 1000);
    if (this.exit) return this.#exitedEarly();
    if (this.session?.hello) { this.runLog('the game said hello late: playing the contract'); this.mode = 'contract'; return this.#playContract(); }
    if (this.stopRequested) return;
    if (this.frames.first == null) {
      this.outcome = 'error';
      this.problem('bug', `black screen: nothing drawn within ${this.limits.bootSeconds} s of launch`);
      return;
    }
    this.#shot('first-frame');
    this.setPhase('smoke: pressing keys');
    const pad = Boolean(this.ctx.input.status?.pad);
    const end = now() + this.limits.smokeSeconds * 1000;
    let i = 0;
    let lastShot = now();
    const hang = { since: null, ticks: null };
    while (now() < end && !this.exit && !this.stopRequested && !this.session?.hello) {
      const step = SMOKE_STEPS[i++ % SMOKE_STEPS.length];
      const what = step.key ? `key ${step.key}${step.hold ? ` (${step.hold} ms)` : ''}` : step.click ? `click ${step.click.join(',')}` : step.pad ? (pad ? `pad ${step.pad}` : null) : null;
      if (what) { this.smokeInputs.push({ t: this.t(), input: what }); this.io.send({ type: 'smoke-input', input: what, t: this.t() }); }
      if (step.key) {
        if (step.hold) { await this.ctx.input.send({ op: 'key', key: step.key, down: true }); await delay(step.hold); await this.ctx.input.send({ op: 'key', key: step.key, down: false }); }
        else await this.ctx.input.send({ op: 'key', key: step.key });
      } else if (step.click) {
        await this.input({ kind: 'pointer', x: step.click[0], y: step.click[1], click: true });
      } else if (step.pad && pad) {
        await this.ctx.input.send({ op: 'pad', button: step.pad });
      } else if (step.wait) await delay(step.wait);
      await delay(500);
      if (now() - lastShot > 10_000) { this.#shot('smoke'); lastShot = now(); }
      // A hang: the screen hasn't changed for hangSeconds and the game's processes used (almost) no CPU meanwhile.
      const still = this.frames.lastChange != null && now() - this.frames.lastChange > this.limits.hangSeconds * 1000;
      const u = playerUsage();
      if (still) {
        hang.since ??= now();
        hang.ticks ??= u.ticks;
        const pct = ((u.ticks - hang.ticks) / 100) / Math.max(1, (now() - hang.since) / 1000) * 100;
        if (now() - hang.since > 5000 && pct < 2) {
          this.outcome = 'error';
          this.problem('bug', `hang: the screen hasn't changed for ${Math.round((now() - this.frames.lastChange) / 1000)} s and the game uses no CPU (${pct.toFixed(1)}%)`);
          this.#shot('hang');
          break;
        }
      } else { hang.since = null; hang.ticks = null; }
    }
    if (this.session?.hello && !this.exit) { this.runLog('the game said hello late: playing the contract'); this.mode = 'contract'; return this.#playContract(); }
    if (this.exit) return this.#exitedEarly();
    const f = this.frames;
    if (f.lastChange != null && now() - f.lastChange > this.limits.hangSeconds * 1000 && !this.problems.some((p) => p.message.startsWith('hang'))) {
      this.problem('warning', `the screen didn't change for the last ${Math.round((now() - f.lastChange) / 1000)} s, even with input`);
    }
    if (f.blackSince != null && now() - f.blackSince > 5000) this.problem('warning', `the screen went black ${Math.round((now() - f.blackSince) / 1000)} s ago and stayed black`);
    this.#shot('end');
    this.outcome ??= 'done';
  }

  #onJpeg(j) {
    this.lastJpeg = j;
    this.lastJpegAt = now();
    this.io.sendFrame(j);
  }

  #onGray(g) {
    const f = this.frames;
    const s = frameStats(g);
    f.count++;
    const black = isBlack(s);
    if (!black) {
      f.drawn++;
      if (f.first == null && this.launchedAt) { f.first = this.t(); this.firstFrameSeconds = secs(now() - this.launchedAt); this.io.send({ type: 'first-frame', t: this.t(), seconds: this.firstFrameSeconds }); }
      f.blackSince = null;
    } else if (f.first != null) f.blackSince ??= now();
    if (f.prev && frameDiff(f.prev, g) > 0.4) f.lastChange = now();
    else if (f.lastChange == null && f.first != null) f.lastChange = now();
    f.prev = g;
    f.last = s;
  }

  #shot(label) {
    if (!this.lastJpeg || this.shots.length >= MAX_SHOTS) return;
    const name = `${String(this.shots.length + 1).padStart(2, '0')}-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.jpg`;
    try {
      fs.writeFileSync(path.join(this.dir, 'out', 'shots', name), this.lastJpeg);
      this.shots.push({ name, label, t: this.t() });
    } catch { /* full */ }
  }

  #sample() {
    const u = playerUsage();
    const p = this.perf;
    const t = now();
    if (p.last) p.samples.push({ t: this.t(), cpuPct: Math.round(((u.ticks - p.last.ticks) / 100) / ((t - p.last.at) / 1000) * 1000) / 10, rssMB: u.rssMB, procs: u.procs });
    if (p.samples.length > 3600) p.samples.shift();
    p.last = { ticks: u.ticks, at: t };
    p.rssMBMax = Math.max(p.rssMBMax, u.rssMB);
    if (this.ctx.selftest?.gpu && (p.samples.length % 2 === 0)) {
      const q = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits']);
      let o = '';
      q.stdout.on('data', (d) => (o += d));
      q.on('close', () => { const [util, mem] = o.trim().split(',').map((x) => Number(x)); if (Number.isFinite(util)) { p.gpu.push({ t: this.t(), util, memMB: mem }); if (p.gpu.length > 1800) p.gpu.shift(); } });
      q.on('error', () => {});
    }
  }

  /** Stop everything, collect, upload, and build the result. */
  async #finish() {
    this.setPhase('stopping');
    clearInterval(this.perfTimer);
    if (this.child && !this.exit) {
      if (!this.quitting && this.session?.hello && !this.session.closed) await this.session.quit(2000).catch(() => {});
      await Promise.race([this.exited, delay(3000)]);
      try { process.kill(-this.child.pid, 'SIGTERM'); } catch { /* gone */ }
      await Promise.race([this.exited, delay(3000)]);
    }
    killPlayer('KILL');
    const video = this.capture ? await this.capture.stop() : null;
    try { this.contract?.close(); } catch { /* closed */ }
    if (this.outFd != null) try { fs.closeSync(this.outFd); } catch { /* closed */ }

    this.setPhase('collecting');
    const out = path.join(this.dir, 'out');
    const collected = this.#collect(out);
    const perf = this.#perf(out);

    const outcome = this.outcome ?? (this.stopRequested ? 'done' : this.error ? 'error' : 'done');
    const report = {
      runner: 'hawkes-play-native', version: 1, id: this.id, target: this.target, mode: this.mode ?? null, scenario: this.m.scenario ?? 'smoke',
      outcome, crashed: Boolean(this.crashed), error: this.error ?? null,
      exitCode: this.exit?.code ?? null, signal: this.exit?.signal ?? null, exitAt: this.exit?.t ?? null,
      seconds: this.t(), firstFrameSeconds: this.firstFrameSeconds ?? null, readyAt: this.readyAt ?? null,
      build: this.build ?? null, unpackSeconds: this.unpackSeconds ?? null, prefix: this.prefix ?? null,
      exe: this.exe ? path.relative(path.join(this.dir, 'game'), this.exe) : null,
      hello: this.session?.hello ? { product: this.session.hello.product, engine: this.session.hello.engine, engineVersion: this.session.hello.engineVersion, sdk: this.session.hello.sdk, platform: this.session.hello.platform } : null,
      report: this.report ?? null, problems: this.problems, smokeInputs: this.smokeInputs, events: this.session?.events ?? [], logs: this.session?.logs ?? [],
      timeline: this.session?.timeline ?? [], output: this.output.slice(-200),
      frames: { sampled: this.frames.count, drawn: this.frames.drawn, last: this.frames.last },
      perf, shots: this.shots, video: video ? { encoder: video.encoder, bytes: video.bytes, error: video.error } : null,
      files: collected,
      machine: { display: this.ctx.selftest?.display?.kind ?? null, vulkan: this.ctx.selftest?.vulkan?.device ?? null, gl: this.ctx.selftest?.gl?.renderer ?? null, software: Boolean(this.ctx.selftest?.software), gpu: this.ctx.selftest?.gpu?.name ?? null, proton: this.target === 'proton' ? this.ctx.selftest?.proton ?? null : null },
    };
    const reportFile = path.join(out, 'report.json');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    // Gen's protocol (genproto.mjs): every file back over the session, then its result; no upload URLs.
    if (this.m.inband && this.io.finish) {
      this.setPhase('sending');
      const files = [];
      if (video?.bytes && video.file) files.push({ name: 'video.mp4', kind: 'video', mime: 'video/mp4', path: video.file });
      for (const s of this.shots) files.push({ name: s.name, kind: 'shot', mime: 'image/jpeg', path: path.join(out, 'shots', s.name), t: s.t, reason: s.label });
      if (collected.logs) files.push({ name: collected.logs, kind: 'log', mime: 'text/plain', path: path.join(out, collected.logs) });
      if (collected.dumps) files.push({ name: collected.dumps, kind: 'dump', mime: 'application/gzip', path: path.join(out, collected.dumps) });
      files.push({ name: 'report.json', kind: 'report', mime: 'application/json', path: reportFile });
      await this.io.finish(report, files);
      const { output: _o, timeline, logs, ...brief } = report;
      this.result = { ...brief, perf: { ...brief.perf, samples: brief.perf.samples.length }, timeline: timeline.length, logs: logs.length };
      this.setPhase('done');
      if (process.env.HAWKES_KEEP_RUNS !== '1') fs.rmSync(this.dir, { recursive: true, force: true });
      return;
    }

    this.setPhase('uploading');
    const up = this.m.upload ?? {};
    const uploads = {};
    const put = async (key, target, file, type) => { if (target && file && fs.existsSync(file)) uploads[key] = await upload(target, file, type); };
    await put('video', up.video, video?.bytes ? video.file : null, 'video/mp4');
    await put('logs', up.logs, collected.logs ? path.join(out, collected.logs) : null, 'text/plain; charset=utf-8');
    await put('dumps', up.dumps, collected.dumps ? path.join(out, collected.dumps) : null, 'application/gzip');
    const shotUrls = Array.isArray(up.shots) ? up.shots : [];
    for (let i = 0; i < this.shots.length && i < shotUrls.length; i++) await put(`shot:${this.shots[i].name}`, shotUrls[i], path.join(out, 'shots', this.shots[i].name), 'image/jpeg');
    report.uploads = uploads;
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    await put('report', up.report, reportFile, 'application/json');
    const { output, timeline, logs, ...brief } = report;
    this.result = { ...brief, perf: { ...brief.perf, samples: brief.perf.samples.length }, uploads, timeline: timeline.length, logs: logs.length };
    this.io.send({ type: 'result', result: this.result });
    this.setPhase('done');
    if (process.env.HAWKES_KEEP_RUNS !== '1') fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** The logs (process output, the game's own log files, Proton's) into one text file, and crash dumps into a tarball. */
  #collect(out) {
    const roots = [path.join(this.dir, 'home'), path.join(this.dir, 'game'), path.join(this.dir, 'compat'), path.join(this.dir, 'tmp')];
    const found = [];
    const dumps = [];
    const visit = (dir, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (depth > 0 && !/^(windows|Program Files.*|ProgramData|dosdevices)$/i.test(e.name)) visit(p, depth - 1); continue; }
        if (!e.isFile()) continue;
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs < this.t0 - 1000) continue;
        if (/(^Player(-prev)?\.log$|^godot.*\.log$|^output_log\.txt$|^steam-\d+\.log$|\.log$)/i.test(e.name) && st.size < 50e6) found.push(p);
        if (/\.(dmp|mdmp)$|^core(\.\d+)?$/i.test(e.name) && st.size < 2e9) dumps.push(p);
      }
    };
    for (const r of roots) visit(r, 9);
    const logFile = path.join(out, 'logs.txt');
    const parts = [`# hawkes-play-native run ${this.id} (${this.target})\n`, `## process output\n`, (() => { try { return fs.readFileSync(path.join(out, 'output.log'), 'utf8'); } catch { return ''; } })()];
    if (this.session?.logs?.length) parts.push('\n## the game (playtest SDK)\n', this.session.logs.map((l) => `${l.t}s [${l.level}] ${l.line}`).join('\n'), '\n');
    for (const f of found) {
      const text = fs.readFileSync(f, 'utf8');
      parts.push(`\n## ${path.relative(this.dir, f)}\n`, text.length > 5e6 ? `${text.slice(0, 1e6)}\n... (${text.length} chars, cut) ...\n${text.slice(-4e6)}` : text);
    }
    fs.writeFileSync(logFile, parts.join(''));
    let dumpFile = null;
    if (dumps.length) {
      dumpFile = 'dumps.tar.gz';
      spawnSync('tar', ['-czf', path.join(out, dumpFile), '-C', this.dir, ...dumps.map((d) => path.relative(this.dir, d))], { timeout: 300_000 });
    }
    return { logs: 'logs.txt', logFiles: found.map((f) => path.relative(this.dir, f)), dumps: dumpFile, dumpFiles: dumps.map((d) => path.relative(this.dir, d)) };
  }

  #perf(out) {
    const p = this.perf;
    let mangohud = null;
    try {
      const dir = path.join(out, 'mangohud');
      const csv = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
      if (csv) mangohud = parseMangoHud(fs.readFileSync(csv, 'utf8'));
    } catch { /* no MangoHud log (an OpenGL game, or MangoHud off) */ }
    const cpu = p.samples.map((s) => s.cpuPct);
    const gameFps = (this.session?.timeline ?? []).map((x) => x.state?.fps).filter((v) => typeof v === 'number' && v > 0);
    return {
      frameTimes: mangohud,
      gameFps: gameFps.length ? { avg: Math.round((gameFps.reduce((a, b) => a + b, 0) / gameFps.length) * 10) / 10, min: Math.min(...gameFps) } : null,
      cpuPctAvg: cpu.length ? Math.round((cpu.reduce((a, b) => a + b, 0) / cpu.length) * 10) / 10 : null,
      cpuPctMax: cpu.length ? Math.max(...cpu) : null,
      memoryMBMax: p.rssMBMax || null,
      gpuUtilAvg: p.gpu.length ? Math.round(p.gpu.reduce((a, b) => a + b.util, 0) / p.gpu.length) : null,
      gpuMemMBMax: p.gpu.length ? Math.max(...p.gpu.map((g) => g.memMB)) : null,
      samples: p.samples.slice(-600),
    };
  }
}
