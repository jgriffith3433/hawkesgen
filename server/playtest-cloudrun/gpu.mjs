// The GPU self-test of the playtest service (docs/playtest-cloudrun.md, "How WebGL gets the GPU").
//
// Cloud Run mounts the NVIDIA driver's user-space libraries at /usr/local/nvidia/lib64 and appends that to
// LD_LIBRARY_PATH; nothing else. Chromium reaches the GPU through ANGLE, either on EGL (libEGL_nvidia, found through the
// GLVND vendor file the image ships in /usr/share/glvnd/egl_vendor.d/10_nvidia.json) or on Vulkan (libGLX_nvidia as the
// Vulkan ICD, /etc/vulkan/icd.d/nvidia_icd.json). Which one works on Cloud Run's driver is proved here, not assumed: at
// startup every candidate flag set launches headless Chromium, makes a WebGL2 context, draws, and reads the unmasked
// renderer. The first whose renderer names the NVIDIA GPU (not SwiftShader, llvmpipe or another software path) is used
// for every browser the instance launches. /ready stays 503 until one passes (unless HAWKES_ALLOW_SOFTWARE=1).
//
// The CPU variant (gen-playtest-cpu, HAWKES_GL_MODE=software; docs/playtest-cloudrun.md, "The CPU service") has no GPU
// at all: WebGL runs on SwiftShader, Chromium's own CPU implementation of Vulkan under ANGLE. Its candidates are
// SOFTWARE_CANDIDATES, and a candidate passes when it draws on SwiftShader (any renderer that draws, in fact: the
// point is that WebGL works). The same self-test then also times a small WebGL loop, so the report says how fast.
//
// Pure helpers (CANDIDATES, SOFTWARE_CANDIDATES, classifyRenderer, pickCandidate, candidatesFor) are tested in Gen's
// test/playtest-cloudrun.test.ts.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Flags every browser gets, whatever the GL path. --disable-dev-shm-usage: /dev/shm on Cloud Run is small and counts as memory. */
export const BASE_ARGS = ['--ignore-gpu-blocklist', '--enable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run'];

const EGL = ['--use-gl=angle', '--use-angle=gl-egl'];
const VULKAN = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE', '--disable-vulkan-surface'];

/**
 * In order of preference. The first is what the EC2 playtesters use on the T4 (proven there); Vulkan is the path
 * Chromium's own docs give for GPU in headless Linux without X. "chromium" is Playwright's new-headless channel (the full
 * browser), tried when the headless shell can't reach the GPU.
 */
export const CANDIDATES = [
  { id: 'angle-egl', channel: undefined, args: [...EGL, ...BASE_ARGS] },
  { id: 'angle-vulkan', channel: undefined, args: [...VULKAN, ...BASE_ARGS] },
  { id: 'angle-egl-chromium', channel: 'chromium', args: [...EGL, ...BASE_ARGS] },
  { id: 'angle-vulkan-chromium', channel: 'chromium', args: [...VULKAN, ...BASE_ARGS] },
];

/**
 * Software WebGL (no GPU): ANGLE on SwiftShader. --enable-unsafe-swiftshader keeps WebGL on SwiftShader allowed
 * (Chromium 137+ otherwise refuses the automatic fallback). Tried in Playwright's headless shell first, then in its
 * new-headless "chromium" channel.
 */
const SWIFTSHADER = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
export const SOFTWARE_CANDIDATES = [
  { id: 'swiftshader', channel: undefined, args: [...SWIFTSHADER, ...BASE_ARGS] },
  { id: 'swiftshader-chromium', channel: 'chromium', args: [...SWIFTSHADER, ...BASE_ARGS] },
];

/** 'gpu' (the default, the L4 service) or 'software' (gen-playtest-cpu). */
export const glMode = (v = process.env.HAWKES_GL_MODE) => (String(v ?? '').toLowerCase() === 'software' ? 'software' : 'gpu');

/** The candidates for a mode. */
export const candidatesFor = (mode) => (mode === 'software' ? SOFTWARE_CANDIDATES : CANDIDATES);

/** 'gpu' when the renderer names a hardware GPU, 'software' for Chromium's and Mesa's software paths, else 'unknown'. */
export function classifyRenderer(renderer) {
  const r = String(renderer ?? '');
  if (!r || /^(unknown|none)$/i.test(r)) return 'unknown';
  if (/swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|mesa offscreen/i.test(r)) return 'software';
  if (/nvidia|geforce|quadro|tesla|\bL4\b|RTX/i.test(r)) return 'gpu';
  return 'unknown';
}

/** The first candidate whose test drew on the GPU (or, in software mode, drew at all), or null. */
export function pickCandidate(results, mode = 'gpu') {
  return results.find((r) => r.ok && (mode === 'software' || classifyRenderer(r.renderer) === 'gpu')) ?? null;
}

/**
 * Runs in the page: a 1280x720 WebGL canvas drawing a full-screen fragment shader with some arithmetic per pixel for
 * `ms`, counting animation frames. A rough "how fast is WebGL here" next to a game's own fps (the real number is the
 * playtest's).
 */
export const PAGE_BENCH = `(async (ms) => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720; document.body.appendChild(c);
  const gl = c.getContext('webgl2'); if (!gl) return { fps: 0 };
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, '#version 300 es\\nin vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }'));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, '#version 300 es\\nprecision highp float; uniform float t; out vec4 o; void main(){ vec2 u = gl_FragCoord.xy / vec2(1280., 720.); float v = 0.; for (int i = 0; i < 24; i++) v += sin(u.x * float(i) * 9. + t) * cos(u.y * float(i) * 7. - t); o = vec4(u, .5 + .5 * sin(v), 1.); }'));
  gl.linkProgram(p); gl.useProgram(p);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(p, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tl = gl.getUniformLocation(p, 't');
  let frames = 0; const t0 = performance.now();
  await new Promise((done) => { const f = (now) => { gl.uniform1f(tl, now / 1000); gl.drawArrays(gl.TRIANGLES, 0, 3); frames++; if (now - t0 < ms) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
  return { fps: Math.round(frames / ((performance.now() - t0) / 1000) * 10) / 10 };
})`;

/** Runs in the page: a WebGL2 context, a clear and a readback (proves it draws), the unmasked vendor and renderer. */
export const PAGE_PROBE = `(() => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return { webgl: false };
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  gl.clearColor(0, 1, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return {
    webgl: true, webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    vendor: String(d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
    renderer: String(d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
    drew: px[1] === 255 && px[0] === 0,
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
})()`;

/**
 * One candidate, with a hard deadline: a GPU process that hangs inside WebGL (a broken driver) must fail the candidate,
 * not hold /ping at 204 forever (on RunPod the load balancer then holds every request; 2026-10-29).
 */
async function tryCandidate(chromium, cand, opts = {}) {
  const limit = (opts.timeoutMs ?? 45_000) + (opts.benchMs ?? 0) + 30_000;
  let timer;
  const holder = {};
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      holder.browser?.close().catch(() => {});
      resolve({ id: cand.id, channel: cand.channel ?? 'chromium-headless-shell', ok: false, error: `no answer in ${Math.round(limit / 1000)} s (the GPU process hung)`, ms: limit });
    }, limit);
  });
  try {
    return await Promise.race([tryCandidateOnce(chromium, cand, opts, holder), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function tryCandidateOnce(chromium, cand, { timeoutMs = 45_000, benchMs = 0 } = {}, holder = {}) {
  const t0 = Date.now();
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, channel: cand.channel, args: cand.args, timeout: timeoutMs });
    holder.browser = browser;
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>gpu</title>');
    const gl = await page.evaluate(PAGE_PROBE);
    // How fast WebGL draws here (software mode: SwiftShader on this instance's vCPUs).
    if (benchMs && gl.webgl) gl.bench = await page.evaluate(`(${PAGE_BENCH})(${Number(benchMs)})`).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
    // chrome://gpu, as a human would read it: the feature status lines ("WebGL: Hardware accelerated").
    let features = null;
    try {
      await page.goto('chrome://gpu', { timeout: 15_000 });
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body?.innerText ?? '');
      features = text.split('\n').filter((l) => /^(WebGL|WebGL2|WebGPU|Canvas|Rasterization|Video Decode|Video Encode|OpenGL|Vulkan)\b.*:/.test(l.trim())).slice(0, 20).map((l) => l.trim());
      const angle = /GL_RENDERER\s+(.+)/.exec(text)?.[1]?.trim();
      if (angle) features.push(`GL_RENDERER: ${angle}`);
    } catch {
      // Some builds refuse chrome:// URLs headless; the WebGL probe above is the proof that counts.
    }
    return { id: cand.id, channel: cand.channel ?? 'chromium-headless-shell', ok: Boolean(gl.webgl && gl.drew), ...gl, kind: classifyRenderer(gl.renderer), features, ms: Date.now() - t0 };
  } catch (e) {
    return { id: cand.id, channel: cand.channel ?? 'chromium-headless-shell', ok: false, error: String(e?.message ?? e).split('\n')[0].slice(0, 300), ms: Date.now() - t0 };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * What the platform gave us: the mounted driver libraries that matter for graphics and video, nvidia-smi's line.
 * Cloud Run mounts them at /usr/local/nvidia/lib64; the NVIDIA container runtime elsewhere (RunPod,
 * docs/playtest-runpod.md) puts them in the system library folder, the graphics ones only when
 * NVIDIA_DRIVER_CAPABILITIES asks for graphics (the image sets "all").
 */
export function driverFacts() {
  let dir = '/usr/local/nvidia/lib64';
  let libs = null;
  for (const [d, re] of [[dir, /EGL|GLX|GLES|vulkan|glcore|eglcore|encode|cuvid|nvidia-glsi|libcuda\.so/i], ['/usr/lib/x86_64-linux-gnu', /^lib(EGL_nvidia|GLX_nvidia|GLESv2_nvidia|nvidia-(eglcore|glcore|glsi|encode|gpucomp)|nvcuvid|cuda)\.so/i]]) {
    try {
      const found = fs.readdirSync(d).filter((f) => re.test(f)).sort();
      if (found.length || !libs) { dir = d; libs = found; }
      if (found.length) break;
    } catch {
      // Not on this platform.
    }
  }
  const smiBin = ['/usr/local/nvidia/bin/nvidia-smi', 'nvidia-smi'].find((b) => b.includes('/') ? fs.existsSync(b) : true);
  const smi = spawnSync(smiBin, ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'], { encoding: 'utf8', timeout: 15_000 });
  return { libDir: dir, libs, nvidiaSmi: smi.status === 0 ? smi.stdout.trim() : null, ldLibraryPath: process.env.LD_LIBRARY_PATH ?? null, capabilities: process.env.NVIDIA_DRIVER_CAPABILITIES ?? null,
    fetched: (() => { try { return fs.readdirSync('/opt/nvidia-gl').filter((f) => /^libEGL_nvidia\.so\.\d+\.\d+/.test(f)); } catch { return null; } })() };
}

/** The driver's graphics libraries (EGL, GLES, GLX, Vulkan): RunPod's serverless hosts mount none of them. */
export const GRAPHICS_LIBS = /^lib(EGL_nvidia|GLESv2_nvidia|GLESv1_CM_nvidia|GLX_nvidia|nvidia-(eglcore|glcore|glsi|gpucomp|glvkspirv|tls|egl-gbm|egl-wayland|rtcore))\.so\./;
export const DRIVER_URL = (v) => `https://download.nvidia.com/XFree86/Linux-x86_64/${v}/NVIDIA-Linux-x86_64-${v}.run`;
export const DRIVER_URL_DC = (v) => `https://us.download.nvidia.com/tesla/${v}/NVIDIA-Linux-x86_64-${v}.run`;

/** The kernel driver's version (nvidia-smi, else /proc/driver/nvidia/version), or null with no NVIDIA GPU. */
export function driverVersion() {
  const smi = spawnSync('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader'], { encoding: 'utf8', timeout: 15_000 });
  const v = smi.status === 0 ? smi.stdout.trim().split('\n')[0].trim() : (/Kernel Module\s+([0-9.]+)/.exec((() => { try { return fs.readFileSync('/proc/driver/nvidia/version', 'utf8'); } catch { return ''; } })())?.[1] ?? '');
  return /^\d+\.\d+(\.\d+)?$/.test(v) ? v : null;
}

/**
 * When the host gave the container the NVIDIA GPU but not its graphics libraries (RunPod serverless: compute and video
 * only, so EGL falls back to Mesa's llvmpipe), fetch the user-space half of the driver that matches the host's kernel
 * module from NVIDIA (the .run installer, ~300 MB, extracted only: nothing is installed or loaded into the kernel),
 * copy its graphics libraries to `dir`, and point the GLVND EGL and Vulkan vendor files at them. Chromium (launched
 * from this process) finds them through LD_LIBRARY_PATH. Skipped when the libraries are there (Cloud Run, Pods) or with
 * HAWKES_FETCH_DRIVER=0. Returns what it did, for the self-test report.
 */
export async function ensureGraphicsLibs({ dir = '/opt/nvidia-gl', log = () => {} } = {}) {
  if (process.env.HAWKES_FETCH_DRIVER === '0') return { done: false, why: 'HAWKES_FETCH_DRIVER=0' };
  const facts = driverFacts();
  if ((facts.libs ?? []).some((f) => /^libEGL_nvidia\.so/.test(f))) return { done: false, why: 'the host mounted the graphics libraries' };
  const version = driverVersion();
  if (!version) return { done: false, why: 'no NVIDIA driver here' };
  const have = (() => { try { return fs.readdirSync(dir); } catch { return []; } })();
  const t0 = Date.now();
  if (!have.some((f) => f === `libEGL_nvidia.so.${version}`)) {
    const tmp = fs.mkdtempSync('/tmp/nvdrv-');
    try {
      let got = null;
      for (const url of [DRIVER_URL(version), DRIVER_URL_DC(version)]) {
        log(`fetching the NVIDIA ${version} user-space graphics libraries from ${url}`);
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
          if (!r.ok || !r.body) continue;
          await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(`${tmp}/d.run`));
          got = url;
          break;
        } catch (e) {
          log(`fetching ${url}: ${e?.message ?? e}`);
        }
      }
      if (!got) return { done: false, why: `NVIDIA has no ${version} installer at the known addresses`, version };
      const x = spawnSync('sh', [`${tmp}/d.run`, '--extract-only', '--target', `${tmp}/x`], { encoding: 'utf8', timeout: 300_000 });
      if (x.status !== 0) return { done: false, why: `extracting failed: ${(x.stderr || x.stdout).trim().slice(-300)}`, version };
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(`${tmp}/x`)) if (GRAPHICS_LIBS.test(f)) fs.copyFileSync(`${tmp}/x/${f}`, `${dir}/${f}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  // The sonames the loaders open (libEGL_nvidia.so.0, libGLX_nvidia.so.0, libGLESv2_nvidia.so.2, ...).
  for (const f of fs.readdirSync(dir)) {
    const m = /^(lib[^.]+\.so)\.(\d+)\.\d+(\.\d+)?$/.exec(f);
    if (!m) continue;
    const so = { libEGL_nvidia: '0', libGLX_nvidia: '0', libGLESv2_nvidia: '2', libGLESv1_CM_nvidia: '1' }[m[1].replace(/\.so$/, '')];
    for (const link of [so ? `${m[1]}.${so}` : null, m[1]].filter(Boolean)) {
      try { fs.symlinkSync(f, `${dir}/${link}`); } catch { /* there */ }
    }
  }
  fs.mkdirSync('/usr/share/glvnd/egl_vendor.d', { recursive: true });
  fs.writeFileSync('/usr/share/glvnd/egl_vendor.d/10_nvidia.json', JSON.stringify({ file_format_version: '1.0.0', ICD: { library_path: `${dir}/libEGL_nvidia.so.0` } }));
  fs.mkdirSync('/etc/vulkan/icd.d', { recursive: true });
  fs.writeFileSync('/etc/vulkan/icd.d/nvidia_icd.json', JSON.stringify({ file_format_version: '1.0.1', ICD: { library_path: `${dir}/libGLX_nvidia.so.0`, api_version: '1.3.0' } }));
  process.env.LD_LIBRARY_PATH = [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return { done: true, version, dir, libs: fs.readdirSync(dir).filter((f) => !fs.lstatSync(`${dir}/${f}`).isSymbolicLink()).length, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

/** Whether ffmpeg can encode H.264 on the GPU here (libnvidia-encode from the mounted driver). */
export function nvencWorks() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, error: r.status === 0 ? null : (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').slice(-2).join(' ').slice(0, 300) };
}

/**
 * The whole self-test: every candidate of the mode (stops at the first that passes unless `all`), the driver facts and
 * NVENC (GPU mode only). `gl` is the chosen path; `gpu` is the same object, kept under its old name.
 */
export async function selfTest(chromium, { all = false, only = process.env.HAWKES_GL || '', mode = glMode() } = {}) {
  const t0 = Date.now();
  const all_ = candidatesFor(mode);
  const list = only ? all_.filter((c) => c.id === only) : all_;
  const results = [];
  for (const c of list) {
    const r = await tryCandidate(chromium, c, { benchMs: mode === 'software' ? 3000 : 0 });
    results.push(r);
    if (!all && pickCandidate([r], mode)) break;
  }
  const chosen = pickCandidate(results, mode);
  const gl = chosen
    ? { ok: true, id: chosen.id, renderer: chosen.renderer, vendor: chosen.vendor, kind: chosen.kind, fps: chosen.bench?.fps ?? null }
    : { ok: false, id: null, renderer: results.find((r) => r.renderer)?.renderer ?? null };
  return {
    at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10, mode,
    gl, gpu: gl,
    candidates: results,
    driver: mode === 'software' ? { libDir: null, libs: null, nvidiaSmi: null, ldLibraryPath: process.env.LD_LIBRARY_PATH ?? null } : driverFacts(),
    nvenc: mode === 'software' ? { ok: false, error: 'software mode: no GPU' } : nvencWorks(),
  };
}
