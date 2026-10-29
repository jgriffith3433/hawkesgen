// The display games draw on, and the GPU self-test (docs/play-native.md, "The display").
//
// One X display per worker, chosen once by the self-test and kept for every run (a worker plays one run at a time):
// - xorg-nvidia: Xorg on the NVIDIA driver with no monitor (xorg-nvidia.conf). Games get GLX and Vulkan on the GPU and
//   x11grab reads the frames. Needs the driver's Xorg module (driver.mjs fetches it on RunPod).
// - xvfb: a framebuffer in memory. GL is Mesa's llvmpipe; Vulkan is NVIDIA's when it can present to a non-NVIDIA X
//   server, else lavapipe. The fallback, and what local tests on a PC without an NVIDIA GPU use.
// The self-test proves the chosen display draws: vulkaninfo and glxinfo name the devices, vkcube runs, and one frame
// grabbed from the screen must not be black. In GPU mode a display passes only when Vulkan's device is the NVIDIA
// GPU; HAWKES_ALLOW_SOFTWARE=1 lets software pass (local tests, the CPU fallback).

import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { gpuInfo, NVIDIA_ICD, LAVAPIPE_ICD, nvencWorks } from './driver.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 'gpu' for a hardware renderer, 'software' for Mesa's and others' CPU paths, else 'unknown'. */
export function classifyRenderer(renderer) {
  const r = String(renderer ?? '');
  if (!r || /^(unknown|none)$/i.test(r)) return 'unknown';
  if (/llvmpipe|lavapipe|softpipe|swiftshader|software|virgl/i.test(r)) return 'software';
  if (/nvidia|geforce|quadro|tesla|\bL4\b|\bL40|RTX|\bA\d{2,4}\b/i.test(r)) return 'gpu';
  return 'unknown';
}

/** Gray-frame statistics: mean and standard deviation of 0..255 pixels. */
export function frameStats(buf) {
  if (!buf?.length) return { mean: 0, sd: 0 };
  let sum = 0;
  for (const v of buf) sum += v;
  const mean = sum / buf.length;
  let sq = 0;
  for (const v of buf) sq += (v - mean) ** 2;
  return { mean: Math.round(mean * 10) / 10, sd: Math.round(Math.sqrt(sq / buf.length) * 10) / 10 };
}

/** Black (or one flat color close to it): what a game that never drew leaves on the screen. */
export const isBlack = (s) => s.mean < 6 && s.sd < 3;

/** Mean absolute difference of two gray frames (0 = identical). */
export function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return Math.round((d / a.length) * 100) / 100;
}

export const GRAY_W = 64;
export const GRAY_H = 36;

/** One frame of the screen as GRAY_W x GRAY_H gray bytes (null when the grab failed). */
export function grabGray(display) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-i', display, '-frames:v', '1', '-vf', `scale=${GRAY_W}:${GRAY_H},format=gray`, '-f', 'rawvideo', '-'], { timeout: 15_000, maxBuffer: 1 << 20 });
  return r.status === 0 && r.stdout?.length === GRAY_W * GRAY_H ? r.stdout : null;
}

/** One frame of the screen as a JPEG file. */
export function grabJpeg(display, file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-i', display, '-frames:v', '1', '-q:v', '4', file], { timeout: 15_000 });
  return r.status === 0;
}

async function waitForX(display, proc, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (proc.exitCode !== null) return false;
    if (spawnSync('xdpyinfo', ['-display', display], { stdio: 'ignore', timeout: 5000 }).status === 0) return true;
    await delay(250);
  }
  return false;
}

/**
 * Starts one X server. kind: 'xorg-nvidia' | 'xvfb'. Resolves { kind, display, proc, log() } or { error }.
 * The X server is root's; games (another user) reach it through the unix socket (-ac: no auth on a socket nobody
 * else can reach: nothing listens on TCP).
 */
export async function startDisplay(kind, { num = 0, width = 1280, height = 720, log = () => {} } = {}) {
  const display = `:${num}`;
  try { fs.rmSync(`/tmp/.X${num}-lock`, { force: true }); fs.rmSync(`/tmp/.X11-unix/X${num}`, { force: true }); } catch { /* none */ }
  let args;
  let cmd;
  const lines = [];
  if (kind === 'xorg-nvidia') {
    const gpu = gpuInfo();
    if (!gpu?.busId) return { error: 'no NVIDIA GPU bus id (nvidia-smi)' };
    if (!fs.existsSync('/usr/lib/xorg/modules/drivers/nvidia_drv.so')) return { error: 'no NVIDIA Xorg driver (driver.mjs ensureDriver)' };
    const conf = fs.readFileSync(new URL('./xorg-nvidia.conf', import.meta.url), 'utf8')
      .replace('__BUSID__', gpu.busId).replace('__W__', String(width)).replace('__H__', String(height));
    fs.mkdirSync('/etc/X11', { recursive: true });
    fs.writeFileSync('/etc/X11/xorg-hawkes.conf', conf);
    cmd = 'Xorg';
    args = [display, '-config', '/etc/X11/xorg-hawkes.conf', '-noreset', '-nolisten', 'tcp', '-ac', '-novtswitch', '-sharevts', '-logfile', '/tmp/Xorg.hawkes.log', '+extension', 'GLX', '+extension', 'RANDR', '+extension', 'MIT-SHM'];
  } else {
    cmd = 'Xvfb';
    args = [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-ac', '-noreset', '+extension', 'GLX', '+extension', 'RANDR', '+extension', 'MIT-SHM'];
  }
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [proc.stdout, proc.stderr]) s.on('data', (d) => { lines.push(...String(d).split('\n').filter(Boolean)); if (lines.length > 200) lines.splice(0, lines.length - 200); });
  proc.on('error', (e) => lines.push(String(e?.message ?? e)));
  const up = await waitForX(display, proc);
  if (!up) {
    proc.kill('SIGKILL');
    const xlog = kind === 'xorg-nvidia' ? fs.existsSync('/tmp/Xorg.hawkes.log') ? fs.readFileSync('/tmp/Xorg.hawkes.log', 'utf8').split('\n').filter((l) => /\(EE\)|Fatal|error/i.test(l)).slice(-8) : [] : [];
    return { error: `${cmd} did not start: ${[...lines.slice(-6), ...xlog].join(' | ').slice(0, 1200)}` };
  }
  log(`${kind} up on ${display} (${width}x${height})`);
  return { kind, display, proc, width, height, log: () => lines.slice() };
}

/** vulkaninfo --summary's device names under one ICD file. */
export function vulkanDevices(display, icd) {
  const env = { ...process.env, DISPLAY: display, ...(icd ? { VK_ICD_FILENAMES: icd, VK_DRIVER_FILES: icd } : {}) };
  const r = spawnSync('vulkaninfo', ['--summary'], { env, encoding: 'utf8', timeout: 30_000 });
  const devices = [...String(r.stdout ?? '').matchAll(/deviceName\s*=\s*(.+)/g)].map((m) => m[1].trim());
  const api = /apiVersion\s*=\s*([\d.]+)/.exec(r.stdout ?? '')?.[1] ?? null;
  return { ok: r.status === 0 && devices.length > 0, devices, api, error: r.status === 0 ? null : String(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-2).join(' ').slice(0, 300) };
}

/** glxinfo -B's renderer on the display. */
export function glRenderer(display) {
  const r = spawnSync('glxinfo', ['-B'], { env: { ...process.env, DISPLAY: display }, encoding: 'utf8', timeout: 20_000 });
  return { ok: r.status === 0, renderer: /OpenGL renderer string:\s*(.+)/.exec(r.stdout ?? '')?.[1]?.trim() ?? null, version: /OpenGL version string:\s*(.+)/.exec(r.stdout ?? '')?.[1]?.trim() ?? null };
}

/** vkcube on the display for a few seconds, and one frame grabbed while it draws. */
export async function drawTest(display, icd, ms = 4000) {
  const env = { ...process.env, DISPLAY: display, ...(icd ? { VK_ICD_FILENAMES: icd, VK_DRIVER_FILES: icd } : {}) };
  const p = spawn('vkcube', ['--c', '100000'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err = (err + d).slice(-500)));
  await delay(ms);
  const a = grabGray(display);
  await delay(300);
  const b = grabGray(display);
  const alive = p.exitCode === null;
  p.kill('SIGKILL');
  const s = frameStats(a);
  return { ok: alive && Boolean(a) && !isBlack(s), alive, frame: s, moving: frameDiff(a, b) > 0, error: alive ? null : err.trim().split('\n').slice(-2).join(' ').slice(0, 300) };
}

/**
 * The whole self-test: start the first display that works, find the Vulkan ICD to use (NVIDIA's when it names the GPU,
 * else lavapipe), prove it draws. Returns { ok, display (the live display object), report }.
 */
export async function selfTest({ width = 1280, height = 720, allowSoftware = false, log = () => {}, driver = null } = {}) {
  const t0 = Date.now();
  const gpu = gpuInfo();
  const kinds = (process.env.HAWKES_DISPLAY ? [process.env.HAWKES_DISPLAY] : gpu ? ['xorg-nvidia', 'xvfb'] : ['xvfb']);
  const tried = [];
  for (const kind of kinds) {
    const d = await startDisplay(kind, { width, height, log });
    if (d.error) { tried.push({ kind, ok: false, error: d.error }); log(`display ${kind}: ${d.error}`); continue; }
    const icds = [gpu && fs.existsSync(NVIDIA_ICD) ? NVIDIA_ICD : null, fs.existsSync(LAVAPIPE_ICD) ? LAVAPIPE_ICD : null].filter(Boolean);
    let chosen = null;
    const vk = [];
    for (const icd of icds) {
      const v = vulkanDevices(d.display, icd);
      const kind_ = classifyRenderer(v.devices[0]);
      const draw = v.ok ? await drawTest(d.display, icd) : { ok: false, error: 'no Vulkan device' };
      vk.push({ icd, ...v, kind: kind_, draw });
      if (v.ok && draw.ok && (kind_ === 'gpu' || allowSoftware)) { chosen = { icd, device: v.devices[0], kind: kind_, api: v.api, draw }; break; }
    }
    const gl = glRenderer(d.display);
    const entry = { kind, ok: Boolean(chosen), vulkan: vk, gl: { ...gl, kind: classifyRenderer(gl.renderer) } };
    tried.push(entry);
    if (chosen) {
      const report = {
        at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10, ok: true,
        display: { kind, display: d.display, width, height }, vulkan: chosen, gl: entry.gl,
        gpu, driver, software: chosen.kind !== 'gpu', nvenc: gpu ? nvencWorks() : { ok: false, error: 'no NVIDIA GPU' },
        mangohud: fs.existsSync('/usr/share/vulkan/implicit_layer.d/MangoHud.x86_64.json') || fs.existsSync('/usr/share/vulkan/implicit_layer.d/MangoHud.json'),
        proton: (() => { try { return fs.readFileSync('/opt/proton/hawkes-version', 'utf8').trim(); } catch { return null; } })(),
        tried,
      };
      return { ok: true, display: d, report };
    }
    d.proc.kill('SIGKILL');
  }
  return { ok: false, display: null, report: { at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10, ok: false, gpu, driver, tried } };
}
