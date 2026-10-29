// The NVIDIA driver's user-space graphics half, for hosts that mount only compute and video (RunPod serverless).
//
// Adapted from server/playtest-cloudrun/gpu.mjs ensureGraphicsLibs (keep the two in step): fetch the .run installer of
// the exact version the host's kernel module runs (~300 MB), extract it only (nothing is installed or loaded into the
// kernel), and copy the graphics libraries to /opt/nvidia-gl. This runner also needs the Xorg driver
// (nvidia_drv.so) and the GLX server module (libglxserver_nvidia.so) for its headless Xorg (display.mjs), so those are
// copied into Xorg's module folders. Pure helpers are at the top; the fetch is ensureDriver().

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** The driver's graphics libraries (EGL, GLES, GLX, Vulkan, and what they load). */
export const GRAPHICS_LIBS = /^lib(EGL_nvidia|GLESv2_nvidia|GLESv1_CM_nvidia|GLX_nvidia|nvidia-(eglcore|glcore|glsi|gpucomp|glvkspirv|tls|egl-gbm|egl-wayland|rtcore|allocator|api|ngx))\.so\./;
export const DRIVER_URL = (v) => `https://download.nvidia.com/XFree86/Linux-x86_64/${v}/NVIDIA-Linux-x86_64-${v}.run`;
export const DRIVER_URL_DC = (v) => `https://us.download.nvidia.com/tesla/${v}/NVIDIA-Linux-x86_64-${v}.run`;
export const GL_DIR = '/opt/nvidia-gl';
export const XORG_DRIVERS = '/usr/lib/xorg/modules/drivers';
export const XORG_EXTENSIONS = '/usr/lib/xorg/modules/extensions';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

/** nvidia-smi's facts about the first GPU, or null without an NVIDIA GPU. busId is Xorg's "PCI:b:d:f" (decimal). */
export function gpuInfo() {
  const smi = spawnSync('nvidia-smi', ['--query-gpu=name,driver_version,pci.bus_id,memory.total', '--format=csv,noheader'], { encoding: 'utf8', timeout: 15_000 });
  let line = smi.status === 0 ? smi.stdout.trim().split('\n')[0] : '';
  if (!line) {
    const v = /Kernel Module\s+([0-9.]+)/.exec(read('/proc/driver/nvidia/version'))?.[1];
    return v ? { name: null, version: v, busId: null, memory: null } : null;
  }
  const [name, version, bus, memory] = line.split(',').map((s) => s.trim());
  return { name, version, busId: xorgBusId(bus), memory };
}

/** nvidia-smi's "00000000:3B:00.0" (hex) to Xorg's "PCI:59:0:0" (decimal). */
export function xorgBusId(bus) {
  const m = /([0-9a-f]+):([0-9a-f]+):([0-9a-f]+)\.([0-9a-f]+)$/i.exec(String(bus ?? ''));
  if (!m) return null;
  return `PCI:${parseInt(m[2], 16)}:${parseInt(m[3], 16)}:${parseInt(m[4], 16)}`;
}

/** Where the mounted (or fetched) EGL/GLX libraries are, if anywhere. */
export function mountedGraphics() {
  for (const d of ['/usr/lib/x86_64-linux-gnu', '/usr/local/nvidia/lib64', GL_DIR]) {
    const f = ls(d).find((x) => /^libGLX_nvidia\.so\.\d+\.\d+/.test(x));
    if (f) return { dir: d, version: f.replace(/^libGLX_nvidia\.so\./, '') };
  }
  return null;
}

/**
 * Makes sure this host has the graphics libraries and Xorg modules of its driver version. Returns what it did, for the
 * self-test report. HAWKES_FETCH_DRIVER=0 skips the fetch.
 */
export async function ensureDriver({ log = () => {}, xorg = true } = {}) {
  const gpu = gpuInfo();
  if (!gpu?.version) return { done: false, why: 'no NVIDIA driver here', gpu };
  const v = gpu.version;
  const haveGl = mountedGraphics();
  const haveXorg = fs.existsSync(`${XORG_DRIVERS}/nvidia_drv.so`) && ls(XORG_EXTENSIONS).some((f) => f.startsWith('libglxserver_nvidia.so'));
  if (haveGl && (!xorg || haveXorg)) return { done: false, why: 'already here', gpu, gl: haveGl };
  if (process.env.HAWKES_FETCH_DRIVER === '0') return { done: false, why: 'HAWKES_FETCH_DRIVER=0', gpu };
  const t0 = Date.now();
  const tmp = fs.mkdtempSync('/tmp/nvdrv-');
  try {
    let got = null;
    for (const url of [DRIVER_URL(v), DRIVER_URL_DC(v)]) {
      log(`fetching the NVIDIA ${v} user-space driver from ${url}`);
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
    if (!got) return { done: false, why: `NVIDIA has no ${v} installer at the known addresses`, gpu };
    const x = spawnSync('sh', [`${tmp}/d.run`, '--extract-only', '--target', `${tmp}/x`], { encoding: 'utf8', timeout: 300_000 });
    if (x.status !== 0) return { done: false, why: `extracting failed: ${(x.stderr || x.stdout).trim().slice(-300)}`, gpu };
    const src = `${tmp}/x`;
    if (!haveGl) {
      fs.mkdirSync(GL_DIR, { recursive: true });
      for (const f of ls(src)) if (GRAPHICS_LIBS.test(f)) fs.copyFileSync(`${src}/${f}`, `${GL_DIR}/${f}`);
      linkSonames(GL_DIR);
    }
    if (xorg && !haveXorg) {
      fs.mkdirSync(XORG_DRIVERS, { recursive: true });
      fs.mkdirSync(XORG_EXTENSIONS, { recursive: true });
      if (fs.existsSync(`${src}/nvidia_drv.so`)) fs.copyFileSync(`${src}/nvidia_drv.so`, `${XORG_DRIVERS}/nvidia_drv.so`);
      const glx = ls(src).find((f) => /^libglxserver_nvidia\.so\./.test(f));
      if (glx) {
        fs.copyFileSync(`${src}/${glx}`, `${XORG_EXTENSIONS}/${glx}`);
        try { fs.symlinkSync(glx, `${XORG_EXTENSIONS}/libglxserver_nvidia.so`); } catch { /* there */ }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const gl = mountedGraphics();
  pointLoadersAt(gl?.dir ?? GL_DIR);
  return { done: true, gpu, gl, xorgDriver: fs.existsSync(`${XORG_DRIVERS}/nvidia_drv.so`), seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

/** The sonames the loaders open (libEGL_nvidia.so.0, libGLX_nvidia.so.0, libGLESv2_nvidia.so.2, ...). */
function linkSonames(dir) {
  for (const f of ls(dir)) {
    const m = /^(lib[^.]+\.so)\.(\d+)\.\d+(\.\d+)?$/.exec(f);
    if (!m) continue;
    const so = { libEGL_nvidia: '0', libGLX_nvidia: '0', libGLESv2_nvidia: '2', libGLESv1_CM_nvidia: '1' }[m[1].replace(/\.so$/, '')];
    for (const link of [so ? `${m[1]}.${so}` : null, m[1]].filter(Boolean)) {
      try { fs.symlinkSync(f, `${dir}/${link}`); } catch { /* there */ }
    }
  }
}

/** The GLVND EGL vendor file and the Vulkan ICD file pointing at the NVIDIA libraries in `dir`. */
export function pointLoadersAt(dir) {
  const lib = (n) => (dir === '/usr/lib/x86_64-linux-gnu' ? n : `${dir}/${n}`);
  fs.mkdirSync('/usr/share/glvnd/egl_vendor.d', { recursive: true });
  fs.writeFileSync('/usr/share/glvnd/egl_vendor.d/10_nvidia.json', JSON.stringify({ file_format_version: '1.0.0', ICD: { library_path: lib('libEGL_nvidia.so.0') } }));
  fs.mkdirSync('/etc/vulkan/icd.d', { recursive: true });
  fs.writeFileSync(NVIDIA_ICD, JSON.stringify({ file_format_version: '1.0.1', ICD: { library_path: lib('libGLX_nvidia.so.0'), api_version: '1.3.0' } }));
  if (dir !== '/usr/lib/x86_64-linux-gnu') process.env.LD_LIBRARY_PATH = [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

export const NVIDIA_ICD = '/etc/vulkan/icd.d/nvidia_icd.json';
export const LAVAPIPE_ICD = ['/usr/share/vulkan/icd.d/lvp_icd.json', '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json'].find((f) => fs.existsSync(f)) ?? '/usr/share/vulkan/icd.d/lvp_icd.json';

/** Whether ffmpeg can encode H.264 on the GPU here (libnvidia-encode from the mounted driver). */
export function nvencWorks() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, error: r.status === 0 ? null : (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').slice(-2).join(' ').slice(0, 300) };
}
