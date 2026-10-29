#!/usr/bin/env node
// A stand-in for Gen's conductor, for trying hawkes-play-native by hand (docs/play-native.md, "Local test"): it serves
// a build over HTTP, takes the run's uploads (PUT) into a folder, opens the runner's /session, sends `start`, prints
// what comes back and the result. No dependencies (Node 24's WebSocket).
//
//   node tools/play-native/test.mjs --build <file or folder> [--target linux|proton] [--exe path] [--scenario smoke]
//        [--runner http://127.0.0.1:8080] [--token t] [--host host.docker.internal] [--out dir] [--seconds n]
//        [--smoke-seconds n] [--hello-seconds n] [--options json] [--input] [--quiet]
//   (--options '{"via":"none"}' launches without the playtest address: a smoke run of a game that has the SDK)
//   node tools/play-native/test.mjs --pack <fake|cube|crash|hang|black> <out.tar.gz>    make a test "build"
//
// --build takes an archive, a bare executable, or a folder (packed with tar first). --input sends a few input
// messages during the run (keys, a click, a pad button, an action) and prints their acks.
// The runner must have HAWKES_ALLOW_HTTP=1 (builds and uploads over plain http).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

/** Test builds: a launcher script and what it needs, packed as a tar.gz. */
const PACKS = {
  // The contract's pretend game (no window: the screen stays black, which a contract run doesn't mind).
  fake: { 'fakegame.sh': '#!/bin/sh\ncd "$(dirname "$0")"\nexec node fake-game.mjs "$@"\n', 'fake-game.mjs': path.join(HERE, 'fake-game.mjs'), 'protocol.mjs': path.join(ROOT, 'server/play-native/contract/protocol.mjs') },
  // A Vulkan window that keeps drawing (the image's vkcube): a smoke run that should pass.
  cube: { 'cube.sh': '#!/bin/sh\nexec vkcube --c 1000000\n' },
  // Draws for 6 s, then exits with code 3: a crash.
  crash: { 'crash.sh': '#!/bin/sh\nvkcube --c 1000000 &\nsleep 6\nkill $!\necho "Segmentation fault (pretend)" >&2\nexit 3\n' },
  // Draws for 8 s, then freezes (SIGSTOP): a hang.
  hang: { 'hang.sh': '#!/bin/sh\nvkcube --c 1000000 &\nP=$!\nsleep 8\nkill -STOP $P\nsleep 600\n' },
  // Never opens a window: a black screen.
  black: { 'black.sh': '#!/bin/sh\nsleep 600\n' },
};

function pack(kind, outFile) {
  const files = PACKS[kind];
  if (!files) throw new Error(`--pack is one of ${Object.keys(PACKS).join(', ')}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pn-${kind}-`));
  for (const [name, v] of Object.entries(files)) {
    if (v.includes('\n')) fs.writeFileSync(path.join(dir, name), v, { mode: 0o755 });
    else fs.copyFileSync(v, path.join(dir, name));
  }
  tarDir(dir, outFile);
  fs.rmSync(dir, { recursive: true, force: true });
  return outFile;
}

function tarDir(dir, outFile) {
  // Windows' own tar (bsdtar): Git's GNU tar on the PATH reads "C:" as a remote host.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';
  const r = spawnSync(tar, ['-czf', path.resolve(outFile), '-C', dir, '.'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
}

if (flag('pack')) {
  const i = argv.indexOf('--pack');
  console.log(pack(argv[i + 1], argv[i + 2] ?? `${argv[i + 1]}.tar.gz`));
  process.exit(0);
}

const runner = new URL(arg('runner', 'http://127.0.0.1:8080'));
const token = arg('token', process.env.HAWKES_TOKEN || '');
const target = arg('target', 'linux');
const outDir = path.resolve(arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'pn-out-'))));
const quiet = flag('quiet');
fs.mkdirSync(outDir, { recursive: true });
let build = path.resolve(arg('build', ''));
if (!fs.existsSync(build)) { console.error('give --build <file or folder>'); process.exit(2); }
if (fs.statSync(build).isDirectory()) {
  const f = path.join(outDir, 'build.tar.gz');
  tarDir(build, f);
  build = f;
}

// The build and the uploads, over HTTP, reachable from the container.
const uploads = {};
const files = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/build') {
    res.writeHead(200, { 'content-length': fs.statSync(build).size });
    return fs.createReadStream(build).pipe(res);
  }
  if (req.method === 'PUT' && u.pathname.startsWith('/up/')) {
    const name = path.basename(decodeURIComponent(u.pathname.slice(4)));
    const ws = fs.createWriteStream(path.join(outDir, name));
    req.pipe(ws);
    ws.on('finish', () => { uploads[name] = fs.statSync(path.join(outDir, name)).size; res.writeHead(200); res.end(); });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => files.listen(0, '0.0.0.0', r));
const host = arg('host', 'host.docker.internal');
const base = `http://${host}:${files.address().port}`;
const up = (n) => `${base}/up/${encodeURIComponent(n)}`;

const limits = {};
if (arg('seconds')) limits.seconds = Number(arg('seconds'));
if (arg('smoke-seconds')) limits.smokeSeconds = Number(arg('smoke-seconds'));
if (arg('hello-seconds')) limits.helloSeconds = Number(arg('hello-seconds'));
if (arg('boot-seconds')) limits.bootSeconds = Number(arg('boot-seconds'));
const start = {
  type: 'start', build: { url: `${base}/build` }, target, scenario: arg('scenario', 'smoke'), limits,
  ...(arg('exe') ? { exe: arg('exe') } : {}),
  ...(arg('args') ? { args: arg('args').split(' ') } : {}),
  ...(arg('options') ? { options: JSON.parse(arg('options')) } : {}),
  live: { fps: 4, width: 640 },
  upload: { video: up('video.mp4'), report: up('report.json'), logs: up('logs.txt'), dumps: up('dumps.tar.gz'), shots: Array.from({ length: 24 }, (_, i) => up(`shot-${String(i + 1).padStart(2, '0')}.jpg`)) },
};

const wsUrl = `${runner.protocol === 'https:' ? 'wss' : 'ws'}://${runner.host}/session`;
const ws = new WebSocket(wsUrl, { headers: token ? { 'X-Hawkes-Token': token } : {} });
ws.binaryType = 'arraybuffer';
const t0 = Date.now();
const t = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
let frames = 0;
let frameBytes = 0;
let lastFrame = null;
let result = null;
let nextId = 1;
const acks = [];
const say = (s) => { if (!quiet) process.stderr.write(`${t()}s ${s}\n`); };

ws.onopen = () => { say(`connected to ${wsUrl}; build ${path.basename(build)} (${(fs.statSync(build).size / 1e6).toFixed(1)} MB)`); ws.send(JSON.stringify(start)); };
ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') { frames++; frameBytes += ev.data.byteLength; lastFrame = Buffer.from(ev.data); return; }
  const m = JSON.parse(ev.data);
  switch (m.type) {
    case 'status': say(`[${m.phase}]`); if (m.phase === 'smoke: pressing keys' || m.phase === 'playing') inputTest(); break;
    case 'log': if (m.source !== 'stdout' || !quiet) say(`${m.source}${m.level ? ` ${m.level}` : ''}: ${m.line}`); break;
    case 'state': break;
    case 'event': say(`event ${m.event.t}s ${m.event.type}${m.event.detail ? ` ${m.event.detail}` : ''}`); break;
    case 'hello': say(`hello: ${m.hello.product} (${m.hello.engine ?? '?'} ${m.hello.engineVersion ?? ''}, ${m.hello.sdk ?? ''}), scenarios ${m.hello.scenarios.map((s) => s.id).join(', ')}`); break;
    case 'ack': acks.push(m); break;
    case 'result': result = m.result; break;
    default: say(`${m.type}: ${JSON.stringify(m).slice(0, 300)}`);
  }
};
let inputSent = false;
function inputTest() {
  if (!flag('input') || inputSent) return;
  inputSent = true;
  const msgs = [{ kind: 'key', key: 'Return' }, { kind: 'key', key: 'Right', down: true }, { kind: 'key', key: 'Right', down: false }, { kind: 'pointer', x: 0.5, y: 0.5, click: true }, { kind: 'text', text: 'hi' }, { kind: 'pad', button: 'a' }, { kind: 'action', action: 'jump', down: true }];
  for (const m of msgs) ws.send(JSON.stringify({ type: 'input', id: nextId++, ...m }));
}
const closed = new Promise((r) => { ws.onclose = (e) => r(e); ws.onerror = (e) => say(`socket error: ${e.message ?? e.type}`); });
const close = await closed;
files.close();
if (lastFrame) fs.writeFileSync(path.join(outDir, 'last-live-frame.jpg'), lastFrame);
const summary = {
  close: { code: close.code, reason: close.reason }, seconds: Number(t()),
  live: { frames, kb: Math.round(frameBytes / 1024) }, acks: acks.map((a) => `${a.re}:${a.ok ? 'ok' : a.error}`),
  uploads, out: outDir, result,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(result ? 0 : 1);
