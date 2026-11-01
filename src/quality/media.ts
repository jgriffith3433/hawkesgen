// What the quality checks need from files: Python (post/quality/*.py), frames sampled from a video, and ffmpeg's
// per-frame picture statistics. Pure: no database, no settings, so the CPU suite's service can import it
// (src/cpu/suite.ts, quality.identity).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenError, run } from '../util.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const POST_DIR = path.join(ROOT, 'post');

/** Gen's Python: HAWKES_PYTHON (the service image), else the project's .venv, else the system's. */
export function pythonPath() {
  if (process.env.HAWKES_PYTHON) return process.env.HAWKES_PYTHON;
  return [
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
    path.join(ROOT, '..', 'hawkesgen', '.venv', 'bin', 'python'),
  ].find((p) => fs.existsSync(p)) ?? (process.platform === 'win32' ? 'python' : 'python3');
}

/** Runs a script in post/ and resolves to its stdout; a failure quotes the last lines it printed. */
export function runPython(script: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath(), [path.join(POST_DIR, script), ...args], { signal, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new GenError(`Python is not available: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new GenError(`${script} failed: ${err.trim().split('\n').slice(-3).join(' / ')}`))));
  });
}

/** The last JSON line a script printed. */
export const lastJson = (out: string) => JSON.parse(out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() ?? '{}');

/** A scratch folder for one check, removed by the caller (`done`). */
export function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkes-quality-'));
  return { dir, file: (name: string) => path.join(dir, name), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A video's length in seconds (0 when ffprobe can't tell). */
export async function videoSeconds(file: string, signal?: AbortSignal): Promise<number> {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { signal });
    const s = Number(out.trim());
    return Number.isFinite(s) ? s : 0;
  } catch {
    return 0;
  }
}

/** Where to take n frames from a clip of `seconds`: evenly spread, never on the very first or last frame. */
export function sampleTimes(seconds: number, n: number): number[] {
  if (!(seconds > 0) || n < 1) return [0];
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * seconds * 1000) / 1000);
}

/** n frames of a video as PNG files in `dir` (a picture is itself: one frame). */
export async function framesOf(file: string, kind: 'image' | 'video', n: number, dir: string, signal?: AbortSignal): Promise<string[]> {
  if (kind === 'image') return [file];
  const times = sampleTimes(await videoSeconds(file, signal), n);
  const out: string[] = [];
  for (const [i, t] of times.entries()) {
    const f = path.join(dir, `frame${i}.png`);
    try {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", f], { signal });
      if (fs.existsSync(f) && fs.statSync(f).size > 0) out.push(f);
    } catch { /* past the end of a short clip: fewer frames */ }
  }
  if (!out.length) throw new GenError(`No frames could be read from ${path.basename(file)}`);
  return out;
}

export type FrameStat = { yavg: number; ymin: number; ymax: number; ydif: number };

/** ffmpeg signalstats lines (metadata=print) to one entry per frame. */
export function parseSignalStats(text: string): FrameStat[] {
  const out: FrameStat[] = [];
  let cur: Partial<FrameStat> | null = null;
  for (const line of text.split('\n')) {
    if (/^frame:\d+/.test(line)) { if (cur) out.push(cur as FrameStat); cur = { yavg: 0, ymin: 0, ymax: 0, ydif: 0 }; continue; }
    const m = /lavfi\.signalstats\.(YAVG|YMIN|YMAX|YDIF)=([\d.]+)/.exec(line);
    if (m && cur) (cur as any)[m[1].toLowerCase()] = Number(m[2]);
  }
  if (cur) out.push(cur as FrameStat);
  return out;
}

/** Per-frame luminance statistics of a picture or (up to 10 s of) a video, downscaled: cheap. */
export async function frameStats(file: string, signal?: AbortSignal): Promise<FrameStat[]> {
  const s = scratch();
  try {
    const meta = s.file('stats.txt');
    // The metadata filter writes to a file path; ffmpeg's filter syntax needs the drive colon escaped on Windows.
    const target = meta.replace(/\\/g, '/').replace(/:/g, '\\:');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-t', '10', '-i', file, '-vf', `scale=160:-2,signalstats,metadata=print:file='${target}'`, '-f', 'null', '-'], { signal });
    return parseSignalStats(fs.existsSync(meta) ? fs.readFileSync(meta, 'utf8') : '');
  } finally {
    s.done();
  }
}

/** A flat frame (one color: black, white, a solid fill) is a broken render. */
export const isFlat = (f: FrameStat) => f.ymax - f.ymin < 10;

/**
 * Flicker: the brightness jumping and coming back between neighbouring frames (a-b-a), which real lighting changes
 * don't do. Returns how many such frames, and the biggest jump in luminance levels (0-255).
 */
export function flickerOf(stats: FrameStat[], jump = 12): { frames: number; worst: number } {
  let frames = 0;
  let worst = 0;
  for (let i = 1; i + 1 < stats.length; i++) {
    const a = stats[i].yavg - stats[i - 1].yavg;
    const b = stats[i + 1].yavg - stats[i].yavg;
    if (Math.abs(a) >= jump && Math.abs(b) >= jump && Math.sign(a) !== Math.sign(b)) {
      frames++;
      worst = Math.max(worst, Math.min(Math.abs(a), Math.abs(b)));
    }
  }
  return { frames, worst: Math.round(worst * 10) / 10 };
}
