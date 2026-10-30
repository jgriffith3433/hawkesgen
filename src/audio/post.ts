// Post-processing and checks for generated audio, all ffmpeg on the control server (CPU, free):
// analyze (loudness LUFS, true peak, clipping, leading/trailing silence, duration), process (trim silence, fade,
// loudness normalise, resample, convert), loop making and the loop-point check, intro + loop split.
// The parsers are pure so the tests need no audio.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { GenError } from '../util.ts';

/** Runs ffmpeg and resolves to what it printed on stderr (where its measurements go). */
export function ff(args: string[], opts: { signal?: AbortSignal; stdout?: 'buffer' } = {}): Promise<{ stderr: string; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostats', ...args], { signal: opts.signal, windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new GenError(`ffmpeg is not available: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve({ stderr: err, stdout: Buffer.concat(out) }) : reject(new GenError(`ffmpeg failed: ${err.trim().split('\n').slice(-3).join(' / ')}`))));
  });
}

export type Analysis = {
  seconds: number;
  /** Integrated loudness (LUFS) and true peak (dBTP), null when ffmpeg could not measure (silence). */
  lufs: number | null;
  truePeak: number | null;
  loudnessRange: number | null;
  /** Sample peak in dBFS and how many samples sit at full scale. */
  peakDb: number | null;
  clippedSamples: number;
  clipped: boolean;
  /** Seconds of silence at the start and the end, and whether the whole file is silent. */
  leadingSilence: number;
  trailingSilence: number;
  silent: boolean;
};

export function parseEbur128(stderr: string) {
  const sum = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = (re: RegExp) => { const m = re.exec(sum); const v = m ? Number(m[1]) : NaN; return Number.isFinite(v) ? v : null; };
  return { lufs: num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/), loudnessRange: num(/LRA:\s+(-?[\d.]+)\s+LU/), truePeak: num(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/) };
}

export function parseAstats(stderr: string) {
  const all = stderr.slice(stderr.lastIndexOf('Overall'));
  const peak = /Peak level dB:\s+(-?[\d.]+|-inf)/.exec(all)?.[1];
  const clipped = /Number of samples at (?:full scale|peak)[^:]*:\s+(\d+)/i.exec(all)?.[1] ?? /Peak count:\s+(\d+)/.exec(all)?.[1];
  return { peakDb: peak === undefined || peak === '-inf' ? null : Number(peak), peakCount: Number(clipped ?? 0) };
}

/** silencedetect lines to [{start, end}]; an open interval at the end of the file gets `end: null`. */
export function parseSilence(stderr: string): { start: number; end: number | null }[] {
  const out: { start: number; end: number | null }[] = [];
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) out.push({ start: Math.max(0, Number(s[1])), end: null });
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && out.length) out[out.length - 1].end = Number(e[1]);
  }
  return out;
}

export async function durationOf(file: string, signal?: AbortSignal): Promise<number> {
  const { stderr } = await ff(['-i', file, '-f', 'null', '-'], { signal });
  const t = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  return t ? Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) : 0;
}

/** A file's sample rate (ffmpeg's stream line), or null. */
export async function rateOf(file: string, signal?: AbortSignal): Promise<number | null> {
  const { stderr } = await ff(['-i', file, '-f', 'null', '-'], { signal });
  const m = /Audio: .*?, (\d+) Hz/.exec(stderr);
  return m ? Number(m[1]) : null;
}

export async function analyze(file: string, opts: { silenceDb?: number; signal?: AbortSignal } = {}): Promise<Analysis> {
  const th = opts.silenceDb ?? -50;
  const a = await ff(['-i', file, '-af', 'ebur128=peak=true,astats=measure_perchannel=none:measure_overall=Peak_level+Number_of_samples+Peak_count,silencedetect=n=' + th + 'dB:d=0.05', '-f', 'null', '-'], { signal: opts.signal });
  const seconds = await durationOf(file, opts.signal);
  const l = parseEbur128(a.stderr);
  const s = parseAstats(a.stderr);
  const sil = parseSilence(a.stderr);
  const lead = sil[0] && sil[0].start < 0.02 ? (sil[0].end ?? seconds) : 0;
  const tail = sil.length && sil[sil.length - 1].end === null ? seconds - sil[sil.length - 1].start : sil.length && Math.abs((sil[sil.length - 1].end ?? 0) - seconds) < 0.05 ? seconds - sil[sil.length - 1].start : 0;
  const silent = lead >= seconds - 0.02 && seconds > 0;
  const peakCount = s.peakCount;
  return {
    seconds: Math.round(seconds * 1000) / 1000, lufs: l.lufs, truePeak: l.truePeak, loudnessRange: l.loudnessRange, peakDb: s.peakDb,
    clippedSamples: peakCount, clipped: (s.peakDb ?? -99) >= -0.05 && peakCount >= 3,
    leadingSilence: Math.round(lead * 1000) / 1000, trailingSilence: Math.round(tail * 1000) / 1000, silent,
  };
}

export type Verdict = { ok: boolean; problems: string[] };

/** The automatic gate: silent, clipped, wrong loudness, long silence at either end. */
export function judge(a: Analysis, o: { targetLufs?: number; toleranceLufs?: number; maxSilence?: number; expectSeconds?: number } = {}): Verdict {
  const problems: string[] = [];
  if (a.silent) problems.push('the file is silent');
  if (a.clipped) problems.push(`clipping: ${a.clippedSamples} samples at full scale`);
  if (o.targetLufs !== undefined && a.lufs !== null && Math.abs(a.lufs - o.targetLufs) > (o.toleranceLufs ?? 2)) problems.push(`loudness ${a.lufs.toFixed(1)} LUFS, target ${o.targetLufs}`);
  const ms = o.maxSilence ?? 0.6;
  if (a.leadingSilence > ms && !a.silent) problems.push(`${a.leadingSilence.toFixed(2)} s of silence at the start`);
  if (a.trailingSilence > ms && !a.silent) problems.push(`${a.trailingSilence.toFixed(2)} s of silence at the end`);
  if (o.expectSeconds && a.seconds > 0 && (a.seconds < o.expectSeconds * 0.3 || a.seconds > o.expectSeconds * 3)) problems.push(`length ${a.seconds.toFixed(1)} s, expected about ${o.expectSeconds.toFixed(1)} s`);
  return { ok: !problems.length, problems };
}

export const FORMATS = ['wav', 'mp3', 'ogg', 'flac'] as const;
export type Format = (typeof FORMATS)[number];

export type ProcessOptions = {
  /** Loudness target in LUFS (null: leave as is). */
  targetLufs?: number | null;
  /** The ceiling for true peak in dBTP. */
  truePeak?: number;
  trimSilence?: boolean;
  silenceDb?: number;
  /** Seconds of air kept at each end after trimming. */
  keep?: number;
  fadeIn?: number;
  fadeOut?: number;
  format?: Format;
  sampleRate?: number;
  channels?: 1 | 2;
  /** mp3 / ogg quality. */
  quality?: number;
};

/** ffmpeg arguments (without input/output) for one pass of the filters that do not need a measurement. */
export function filterChain(o: ProcessOptions, seconds: number | null): string[] {
  const f: string[] = [];
  if (o.trimSilence) {
    const th = `${o.silenceDb ?? -50}dB`;
    // Trim the start, reverse, trim the other end, reverse back. `keep` is the air left at each end.
    const k = Math.max(0, o.keep ?? 0.03);
    f.push(`silenceremove=start_periods=1:start_threshold=${th}:start_silence=${k}`, 'areverse', `silenceremove=start_periods=1:start_threshold=${th}:start_silence=${k}`, 'areverse');
  }
  if (o.fadeIn && o.fadeIn > 0) f.push(`afade=t=in:d=${o.fadeIn}`);
  if (o.fadeOut && o.fadeOut > 0 && seconds) f.push(`afade=t=out:st=${Math.max(0, seconds - o.fadeOut).toFixed(3)}:d=${o.fadeOut}`);
  return f;
}

export function codecArgs(o: ProcessOptions): string[] {
  const fmt = o.format ?? 'wav';
  const q = o.quality;
  const base = fmt === 'wav' ? ['-c:a', 'pcm_s16le'] : fmt === 'flac' ? ['-c:a', 'flac'] : fmt === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', String(q ?? 2)] : ['-c:a', 'libvorbis', '-q:a', String(q ?? 5)];
  return [...base, ...(o.sampleRate ? ['-ar', String(o.sampleRate)] : []), ...(o.channels ? ['-ac', String(o.channels)] : [])];
}

export async function processAudio(input: string, output: string, o: ProcessOptions, signal?: AbortSignal): Promise<{ before: Analysis; after: Analysis; options: ProcessOptions }> {
  const before = await analyze(input, { silenceDb: o.silenceDb, signal });
  // Trim first, so the fade and the loudness are measured on what is kept.
  const trimmed = output + '.trim.wav';
  const pre = filterChain({ trimSilence: o.trimSilence, silenceDb: o.silenceDb, keep: o.keep }, null);
  await ff(['-y', '-i', input, ...(pre.length ? ['-af', pre.join(',')] : []), '-c:a', 'pcm_f32le', trimmed], { signal });
  try {
    const len = await durationOf(trimmed, signal);
    const post = filterChain({ fadeIn: o.fadeIn, fadeOut: o.fadeOut }, len);
    let norm = '';
    if (o.targetLufs != null) {
      // Two-pass loudnorm: measure, then apply linearly so dynamics are kept.
      const m = await ff(['-i', trimmed, '-af', `loudnorm=I=${o.targetLufs}:TP=${o.truePeak ?? -1.5}:LRA=11:print_format=json`, '-f', 'null', '-'], { signal });
      const j = /\{[\s\S]*"input_i"[\s\S]*?\}/.exec(m.stderr)?.[0];
      if (j) {
        const v = JSON.parse(j);
        norm = `loudnorm=I=${o.targetLufs}:TP=${o.truePeak ?? -1.5}:LRA=11:measured_I=${v.input_i}:measured_LRA=${v.input_lra}:measured_TP=${v.input_tp}:measured_thresh=${v.input_thresh}:offset=${v.target_offset}:linear=true`;
      }
    }
    const chain = [...post, ...(norm ? [norm] : [])];
    // loudnorm resamples to 192 kHz unless told otherwise: keep the source's rate when the caller didn't ask for one.
    const rate = o.sampleRate ?? (norm ? await rateOf(input, signal) : null) ?? undefined;
    await ff(['-y', '-i', trimmed, ...(chain.length ? ['-af', chain.join(',')] : []), ...codecArgs({ ...o, sampleRate: rate }), output], { signal });
  } finally {
    fs.rmSync(trimmed, { force: true });
  }
  return { before, after: await analyze(output, { silenceDb: o.silenceDb, signal }), options: o };
}

/** Mono 16-bit samples of a file, normalised to -1..1 (for the loop-point check). */
export async function samplesOf(file: string, rate = 44100, signal?: AbortSignal): Promise<Float32Array> {
  const { stdout } = await ff(['-i', file, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { signal });
  const n = Math.floor(stdout.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = stdout.readInt16LE(i * 2) / 32768;
  return out;
}

export type LoopCheck = { ok: boolean; jump: number; jumpRatio: number; rmsHead: number; rmsTail: number; levelDiffDb: number; problems: string[] };

/**
 * Is the end of this file a clean lead-in to its start? Compares the step from the last sample to the first against the
 * typical step inside the file (a click shows as a jump many times the usual one), and the level of the last and
 * first 50 ms (a bed that fades out before it repeats shows as a level drop).
 */
export function checkLoopSamples(x: Float32Array, rate: number): LoopCheck {
  const win = Math.max(8, Math.round(rate * 0.05));
  const problems: string[] = [];
  if (x.length < win * 4) return { ok: false, jump: 0, jumpRatio: 0, rmsHead: 0, rmsTail: 0, levelDiffDb: 0, problems: ['too short to loop'] };
  const rms = (a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
  let step = 0;
  for (let i = 1; i < x.length; i++) step += Math.abs(x[i] - x[i - 1]);
  step /= x.length - 1;
  const jump = Math.abs(x[0] - x[x.length - 1]);
  const jumpRatio = step > 1e-9 ? jump / step : jump > 1e-4 ? 99 : 0;
  const rmsHead = rms(0, win);
  const rmsTail = rms(x.length - win, x.length);
  const levelDiffDb = 20 * Math.log10((rmsTail + 1e-9) / (rmsHead + 1e-9));
  if (jumpRatio > 8) problems.push(`click at the loop point (the step is ${jumpRatio.toFixed(0)}x the usual one)`);
  if (Math.abs(levelDiffDb) > 6) problems.push(`level jumps ${levelDiffDb.toFixed(1)} dB at the loop point`);
  return { ok: !problems.length, jump, jumpRatio, rmsHead, rmsTail, levelDiffDb, problems };
}

export async function checkLoop(file: string, signal?: AbortSignal): Promise<LoopCheck> {
  return checkLoopSamples(await samplesOf(file, 44100, signal), 44100);
}

/** ffmpeg filter graph that turns a clip of `seconds` into a seamless loop of `seconds - xf`: the tail crossfaded into the head. */
export function loopGraph(seconds: number, xf: number): string {
  if (!(xf > 0) || xf * 3 > seconds) throw new GenError(`the crossfade (${xf} s) must be under a third of the clip (${seconds.toFixed(2)} s)`);
  const t = seconds.toFixed(4);
  const x = xf.toFixed(4);
  return [
    `[0:a]atrim=start=${x}:end=${(seconds - xf).toFixed(4)},asetpts=PTS-STARTPTS[body]`,
    // acrossfade returns nothing when its inputs are exactly as long as the fade (ffmpeg 6), so the equal-power fade is built by hand.
    `[0:a]atrim=start=${(seconds - xf).toFixed(4)}:end=${t},asetpts=PTS-STARTPTS,afade=t=out:d=${x}:curve=qsin[tail]`,
    `[0:a]atrim=start=0:end=${x},asetpts=PTS-STARTPTS,afade=t=in:d=${x}:curve=qsin[head]`,
    `[tail][head]amix=inputs=2:duration=longest:normalize=0[mix]`,
    `[body][mix]concat=n=2:v=0:a=1[out]`,
  ].join(';');
}

export async function makeLoop(input: string, output: string, o: { crossfade?: number; format?: Format; sampleRate?: number } = {}, signal?: AbortSignal) {
  const seconds = await durationOf(input, signal);
  const xf = Math.min(o.crossfade ?? 1, seconds / 3.2);
  await ff(['-y', '-i', input, '-filter_complex', loopGraph(seconds, xf), '-map', '[out]', ...codecArgs({ format: o.format, sampleRate: o.sampleRate }), output], { signal });
  return { seconds: seconds - xf, crossfade: xf };
}

/** Cuts [from, to) out of a file (to: end of file). */
export async function cut(input: string, output: string, from: number, to: number | null, o: ProcessOptions = {}, signal?: AbortSignal) {
  await ff(['-y', '-i', input, '-ss', String(from), ...(to != null ? ['-to', String(to)] : []), ...codecArgs(o), output], { signal });
}

export const hasFfmpeg = () => { try { return Boolean(fs.existsSync('/usr/bin/ffmpeg') || fs.existsSync('/usr/local/bin/ffmpeg') || process.env.PATH?.split(':').some((d) => fs.existsSync(`${d}/ffmpeg`))); } catch { return false; } };
