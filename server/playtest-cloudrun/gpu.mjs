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
// Pure helpers (CANDIDATES, classifyRenderer, pickCandidate) are tested in Gen's test/playtest-cloudrun.test.ts.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

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

/** 'gpu' when the renderer names a hardware GPU, 'software' for Chromium's and Mesa's software paths, else 'unknown'. */
export function classifyRenderer(renderer) {
  const r = String(renderer ?? '');
  if (!r || /^(unknown|none)$/i.test(r)) return 'unknown';
  if (/swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|mesa offscreen/i.test(r)) return 'software';
  if (/nvidia|geforce|quadro|tesla|\bL4\b|RTX/i.test(r)) return 'gpu';
  return 'unknown';
}

/** The first candidate whose test drew on the GPU, or null. */
export function pickCandidate(results) {
  return results.find((r) => r.ok && classifyRenderer(r.renderer) === 'gpu') ?? null;
}

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

async function tryCandidate(chromium, cand, timeoutMs = 45_000) {
  const t0 = Date.now();
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, channel: cand.channel, args: cand.args, timeout: timeoutMs });
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>gpu</title>');
    const gl = await page.evaluate(PAGE_PROBE);
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

/** What the platform gave us: the mounted driver libraries that matter for graphics and video, nvidia-smi's line. */
export function driverFacts() {
  const dir = '/usr/local/nvidia/lib64';
  let libs = [];
  try {
    libs = fs.readdirSync(dir).filter((f) => /EGL|GLX|GLES|vulkan|glcore|eglcore|encode|cuvid|nvidia-glsi|libcuda\.so/i.test(f)).sort();
  } catch {
    libs = null;
  }
  const smiBin = ['/usr/local/nvidia/bin/nvidia-smi', 'nvidia-smi'].find((b) => b.includes('/') ? fs.existsSync(b) : true);
  const smi = spawnSync(smiBin, ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'], { encoding: 'utf8', timeout: 15_000 });
  return { libDir: dir, libs, nvidiaSmi: smi.status === 0 ? smi.stdout.trim() : null, ldLibraryPath: process.env.LD_LIBRARY_PATH ?? null };
}

/** Whether ffmpeg can encode H.264 on the GPU here (libnvidia-encode from the mounted driver). */
export function nvencWorks() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, error: r.status === 0 ? null : (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').slice(-2).join(' ').slice(0, 300) };
}

/** The whole self-test: every candidate (stops at the first GPU one unless `all`), the driver facts, NVENC. */
export async function selfTest(chromium, { all = false, only = process.env.HAWKES_GL || '' } = {}) {
  const t0 = Date.now();
  const list = only ? CANDIDATES.filter((c) => c.id === only) : CANDIDATES;
  const results = [];
  for (const c of list) {
    const r = await tryCandidate(chromium, c);
    results.push(r);
    if (!all && r.ok && r.kind === 'gpu') break;
  }
  const chosen = pickCandidate(results);
  return {
    at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10,
    gpu: chosen ? { ok: true, id: chosen.id, renderer: chosen.renderer, vendor: chosen.vendor } : { ok: false, id: null, renderer: results.find((r) => r.renderer)?.renderer ?? null },
    candidates: results, driver: driverFacts(), nvenc: nvencWorks(),
  };
}
