// Sound for a cut (docs/finishing.md): music written to the cut (a tempo whose beats land on the important cuts, sections
// with their own mood, the hit points), room tone and ambience per place, and the mix (dialogue first, music ducked
// under it, then ambience and effects, mastered to -14 LUFS with a true-peak ceiling).
//
// The plans are pure (no I/O) so the tests check the numbers directly; renderStem/mixStems run ffmpeg on the CPU.

import fs from 'node:fs';
import { analyze, ff, loudnessGain, judge, type Analysis } from '../audio/post.ts';
import { GenError } from '../util.ts';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ------------------------------------------------------------------------------------------------ tempo

/** A cut point: seconds into the cut, and how much it matters (a story beat 3, a scene change 2, any other cut 1). */
export type CutPoint = { at: number; weight?: number };

export type Hit = { at: number; beat: number; error: number; weight: number; onBeat: boolean };

export type TempoFit = {
  bpm: number;
  /** Seconds per beat. */
  beat: number;
  /** Share of the cuts' weight that lands within `tolerance` of a beat (0 to 1). */
  score: number;
  hits: Hit[];
};

/** The tempo range each mood sits in (a calm scene doesn't get 160 BPM because its cuts happen to fit). */
export const MOOD_TEMPO: Record<string, [number, number]> = {
  calm: [60, 92], sad: [60, 85], tender: [64, 92], mysterious: [70, 100], tense: [90, 128], dark: [70, 110],
  hopeful: [84, 118], warm: [76, 108], playful: [100, 132], epic: [80, 120], action: [120, 170], triumphant: [96, 132],
};
export const moodRange = (mood?: string | null): [number, number] => MOOD_TEMPO[String(mood ?? '').toLowerCase()] ?? [70, 140];

/**
 * The whole-number tempo (what the music model takes) whose beats land closest to the cuts. The music starts on a
 * downbeat at 0, so beats fall at k * 60/bpm. A cut within `tolerance` seconds of a beat counts in full at 0 error and
 * falls off linearly; a cut on a half beat counts a quarter. Ties go to the tempo nearest the middle of the mood's range.
 */
export function fitTempo(cuts: CutPoint[], o: { mood?: string | null; range?: [number, number]; tolerance?: number } = {}): TempoFit {
  const [lo, hi] = o.range ?? moodRange(o.mood);
  const tol = num(o.tolerance, 0.06);
  const pts = cuts.filter((c) => Number.isFinite(c.at) && c.at > 0.05).map((c) => ({ at: c.at, weight: Math.max(0.1, num(c.weight, 1)) }));
  const total = pts.reduce((s, c) => s + c.weight, 0) || 1;
  const mid = (lo + hi) / 2;
  let best: TempoFit | null = null;
  let bestKey = -Infinity;
  for (let bpm = Math.ceil(lo); bpm <= Math.floor(hi); bpm++) {
    const beat = 60 / bpm;
    let score = 0;
    const hits: Hit[] = pts.map((c) => {
      const k = Math.round(c.at / beat);
      const error = Math.abs(c.at - k * beat);
      const half = Math.abs(c.at - (Math.floor(c.at / beat) + 0.5) * beat);
      const on = error <= tol ? 1 - error / tol : 0;
      const offHalf = half <= tol ? 0.25 * (1 - half / tol) : 0;
      score += c.weight * Math.max(on, offHalf);
      return { at: r3(c.at), beat: k, error: r3(error), weight: c.weight, onBeat: error <= tol };
    });
    // Score first; a small pull towards the middle of the range breaks near-ties.
    const key = score / total - Math.abs(bpm - mid) / (hi - lo + 1) * 0.02;
    if (key > bestKey) { bestKey = key; best = { bpm, beat: r3(beat), score: r3(score / total), hits }; }
  }
  if (!best) throw new GenError(`no tempo between ${lo} and ${hi} BPM`);
  return best;
}

/** Moves each cut to its nearest beat when that's within `maxShift` seconds (an edit nudged to the music). */
export function snapCuts(cuts: number[], beat: number, maxShift = 0.25): { from: number; to: number }[] {
  return cuts.map((at) => {
    const to = Math.round(at / beat) * beat;
    return { from: r3(at), to: Math.abs(to - at) <= maxShift ? r3(to) : r3(at) };
  });
}

// ------------------------------------------------------------------------------------------------ sections

/** A story beat with a mood ("the chase starts", tense), at a time in the cut. */
export type StoryBeat = { at: number; mood?: string; label?: string };

export type Section = { start: number; end: number; mood: string; label?: string; prompt: string };

/**
 * The cut divided into musical sections where the mood changes. Each section starts on the bar nearest its beat
 * (4 beats a bar), so a new section begins on a downbeat. Sections under two bars merge into the one before.
 */
export function planSections(length: number, beats: StoryBeat[], o: { bpm: number; mood?: string; style?: string; barBeats?: number }): Section[] {
  const bar = (60 / o.bpm) * (o.barBeats ?? 4);
  const base = o.mood || beats.find((b) => b.mood)?.mood || 'cinematic';
  const marks = [{ at: 0, mood: base, label: undefined as string | undefined }];
  for (const b of [...beats].sort((x, y) => x.at - y.at)) {
    if (!b.mood || b.at <= 0 || b.at >= length) continue;
    const at = Math.round(b.at / bar) * bar;
    const last = marks[marks.length - 1];
    if (b.mood === last.mood) continue;
    if (at - last.at < bar * 2) { if (marks.length > 1) { last.mood = b.mood; last.label = b.label; } continue; }
    marks.push({ at, mood: b.mood, label: b.label });
  }
  return marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : length;
    return { start: r3(m.at), end: r3(end), mood: m.mood, ...(m.label ? { label: m.label } : {}), prompt: musicPrompt(o.style, m.mood, o.bpm) };
  }).filter((s) => s.end - s.start > 0.05);
}

/** The music model's style tags for a section. */
export function musicPrompt(style: string | undefined, mood: string, bpm: number) {
  const s = String(style ?? '').trim() || 'cinematic film score, orchestral and synth textures';
  return `${s}, ${mood} mood, ${bpm} BPM, instrumental, no vocals, written for picture`;
}

/** What audio.music is asked for: one request when the cut has one mood, else one per section (stitched here). */
export function musicRequests(sections: Section[], o: { bpm: number; crossfade: number; key?: string; seed?: number }) {
  const one = sections.length === 1;
  return sections.map((s, i) => {
    const want = s.end - s.start + (one || i === sections.length - 1 ? 0.5 : o.crossfade + 0.5);
    return { section: i, params: { prompt: s.prompt, seconds: Math.min(240, Math.max(10, Math.ceil(want))), bpm: o.bpm, ...(o.key ? { key: o.key } : {}), ...(o.seed != null ? { seed: o.seed + i } : {}) } };
  });
}

/**
 * The ffmpeg graph that stitches section takes into one track of `length` seconds: each section trimmed to its length
 * (plus the crossfade for all but the last), equal-power crossfades on the section boundaries, a fade out at the end.
 */
export function stitchGraph(sections: Section[], crossfade: number, fadeOut = 1.5): string {
  const parts: string[] = [];
  const n = sections.length;
  const length = sections[n - 1].end;
  sections.forEach((s, i) => {
    const len = s.end - s.start + (i < n - 1 ? crossfade : 0);
    parts.push(`[${i}:a]atrim=end=${r3(len)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${r3(len)}[s${i}]`);
  });
  let acc = 's0';
  for (let i = 1; i < n; i++) {
    parts.push(`[${acc}][s${i}]acrossfade=d=${r3(crossfade)}:c1=qsin:c2=qsin[x${i}]`);
    acc = `x${i}`;
  }
  const fo = Math.min(fadeOut, length / 4);
  parts.push(`[${acc}]atrim=end=${r3(length)},afade=t=out:st=${r3(length - fo)}:d=${r3(fo)}[out]`);
  return parts.join(';');
}

/** The hit points a score reports: every cut with the beat it lands on, plus each section start. */
export function hitPoints(fit: TempoFit, sections: Section[]) {
  return {
    cuts: fit.hits.map((h) => ({ at: h.at, beat: h.beat, bar: Math.floor(h.beat / 4) + 1, onBeat: h.onBeat, error: h.error })),
    sections: sections.map((s) => ({ at: s.start, mood: s.mood, ...(s.label ? { label: s.label } : {}) })),
  };
}

// ------------------------------------------------------------------------------------------------ cuts from a timeline

/** Cut points from a compose timeline's clip spans (the joins) and story beats (weighted up). */
export function cutPointsFrom(spans: { start: number; end: number }[], beats: StoryBeat[] = []): CutPoint[] {
  const pts: CutPoint[] = spans.slice(1).map((s) => ({ at: s.start, weight: 1 }));
  for (const b of beats) {
    const near = pts.find((p) => Math.abs(p.at - b.at) < 0.3);
    if (near) near.weight = 3;
    else pts.push({ at: b.at, weight: 2 });
  }
  return pts.sort((a, b) => a.at - b.at);
}

// ------------------------------------------------------------------------------------------------ ambience

/** A shot and the place it's in (a world place's id or a name), with its span in the cut. */
export type PlaceSpan = { place: string; start: number; end: number; description?: string };

export type AmbiencePlan = {
  /** One bed per place: what audio.sfx is asked for. */
  beds: { place: string; prompt: string; seconds: number }[];
  /** Consecutive shots in one place merged into one stretch. */
  spans: { place: string; start: number; end: number }[];
  length: number;
};

export function ambiencePrompt(place: string, description?: string) {
  const what = String(description ?? '').trim() || place;
  return `room tone and ambience of ${what}, steady background atmosphere, no music, no voices, seamless loop`;
}

export function planAmbience(shots: PlaceSpan[], o: { length?: number; maxBed?: number } = {}): AmbiencePlan {
  const sorted = shots.filter((s) => s.place && s.end > s.start).sort((a, b) => a.start - b.start);
  if (!sorted.length) throw new GenError('No shots with a place: give each shot its place');
  const spans: AmbiencePlan['spans'] = [];
  for (const s of sorted) {
    const last = spans[spans.length - 1];
    if (last && last.place === s.place && s.start - last.end < 0.5) last.end = Math.max(last.end, s.end);
    else spans.push({ place: s.place, start: r3(s.start), end: r3(s.end) });
  }
  const length = r3(o.length ?? spans[spans.length - 1].end);
  const desc = new Map<string, string | undefined>();
  for (const s of sorted) if (!desc.get(s.place)) desc.set(s.place, s.description);
  const maxBed = o.maxBed ?? 30;
  const beds = [...new Set(spans.map((s) => s.place))].map((place) => {
    const longest = Math.max(...spans.filter((s) => s.place === place).map((s) => s.end - s.start));
    // Short stretches play the bed as is; longer ones loop a bed made seamless.
    return { place, prompt: ambiencePrompt(place, desc.get(place)), seconds: Math.min(maxBed, Math.max(4, Math.ceil(Math.min(longest, 20)))) };
  });
  return { beds, spans, length };
}

/** The graph that lays each place's (looped) bed over its stretches with short crossfades, `length` seconds long. */
export function ambienceGraph(plan: AmbiencePlan, xf = 0.75): string {
  const idx = new Map(plan.beds.map((b, i) => [b.place, i]));
  const parts: string[] = [`anullsrc=r=48000:cl=stereo,atrim=end=${r3(plan.length)}[bed]`];
  const labels: string[] = [];
  plan.spans.forEach((s, k) => {
    const i = idx.get(s.place)!;
    const a = Math.max(0, s.start - (k ? xf / 2 : 0));
    const b = Math.min(plan.length, s.end + (k < plan.spans.length - 1 ? xf / 2 : 0));
    const len = b - a;
    parts.push(`[${i}:a]aloop=loop=-1:size=2147483647,atrim=end=${r3(len)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:d=${r3(k ? xf : 0.3)},afade=t=out:st=${r3(Math.max(0, len - xf))}:d=${r3(xf)},adelay=delays=${Math.round(a * 1000)}:all=1[p${k}]`);
    labels.push(`[p${k}]`);
  });
  parts.push(`[bed]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:normalize=0,atrim=end=${r3(plan.length)}[out]`);
  return parts.join(';');
}

// ------------------------------------------------------------------------------------------------ the mix

export type StemKind = 'dialogue' | 'music' | 'ambience' | 'sfx';
/** One file placed on the cut. */
export type StemPart = { file: string; start?: number; in?: number; seconds?: number; volume?: number };

/** Where each stem sits against the dialogue (LU below it), and the master. Web delivery: -14 LUFS, -1 dBTP. */
export const MIX = {
  dialogueLufs: -18,
  /** Music sits 9 LU under dialogue before ducking; ambience 18; effects 4. */
  under: { music: 9, ambience: 18, sfx: 4 } as Record<Exclude<StemKind, 'dialogue'>, number>,
  /** Without dialogue, music leads at this level and the others sit under it. */
  musicAloneLufs: -16,
  targetLufs: -14,
  truePeak: -1,
  toleranceLufs: 1,
};

/** The order stems are leveled in: dialogue first, then music, then ambience and effects. */
export const MIX_ORDER: StemKind[] = ['dialogue', 'music', 'ambience', 'sfx'];

/** The level each stem is brought to, from the stems there are (dialogue first; without it, music leads). */
export function stemTargets(present: StemKind[], o: { dialogueLufs?: number; under?: Partial<typeof MIX.under> } = {}): Partial<Record<StemKind, number>> {
  const under = { ...MIX.under, ...(o.under ?? {}) };
  const out: Partial<Record<StemKind, number>> = {};
  const lead = present.includes('dialogue') ? num(o.dialogueLufs, MIX.dialogueLufs) : present.includes('music') ? MIX.musicAloneLufs + under.music : MIX.dialogueLufs;
  for (const k of MIX_ORDER) {
    if (!present.includes(k)) continue;
    out[k] = k === 'dialogue' ? lead : r3(lead - under[k]);
  }
  return out;
}

/** The graph that places one stem's parts on a silent bed of `length` seconds. */
export function stemGraph(parts: StemPart[], length: number): string {
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const g: string[] = [`anullsrc=r=48000:cl=stereo,atrim=end=${r3(length)}[bed]`];
  parts.forEach((p, i) => {
    const at = Math.max(0, num(p.start, 0));
    const tin = Math.max(0, num(p.in, 0));
    const chain = [`atrim=start=${r3(tin)}${p.seconds ? `:end=${r3(tin + p.seconds)}` : ''}`, 'asetpts=PTS-STARTPTS', fmt];
    if (p.volume !== undefined) chain.push(`volume=${r3(num(p.volume, 1))}`);
    chain.push(`adelay=delays=${Math.round(at * 1000)}:all=1`);
    g.push(`[${i}:a]${chain.join(',')}[p${i}]`);
  });
  g.push(`[bed]${parts.map((_, i) => `[p${i}]`).join('')}amix=inputs=${parts.length + 1}:duration=first:normalize=0,atrim=end=${r3(length)}[out]`);
  return g.join(';');
}

/**
 * The graph that mixes leveled stems (inputs in MIX_ORDER, those present): dialogue as is; music and ambience through
 * a compressor keyed by the dialogue (they dip while someone speaks); effects as they are. `gains` are dB per stem.
 */
export function mixGraph(present: StemKind[], gains: Partial<Record<StemKind, number>>, o: { duckRatio?: number } = {}): string {
  const g: string[] = [];
  const idx = (k: StemKind) => present.indexOf(k);
  const lab: Partial<Record<StemKind, string>> = {};
  for (const k of present) {
    g.push(`[${idx(k)}:a]volume=${r3(gains[k] ?? 0)}dB[g_${k}]`);
    lab[k] = `g_${k}`;
  }
  const ducked = present.filter((k) => k === 'music' || k === 'ambience');
  const out: string[] = [];
  if (present.includes('dialogue') && ducked.length) {
    g.push(`[g_dialogue]asplit=${ducked.length + 1}[dia]${ducked.map((k) => `[key_${k}]`).join('')}`);
    out.push('dia');
    for (const k of ducked) {
      const ratio = k === 'music' ? num(o.duckRatio, 6) : 3;
      g.push(`[g_${k}][key_${k}]sidechaincompress=threshold=0.03:ratio=${ratio}:attack=15:release=400:makeup=1[d_${k}]`);
      out.push(`d_${k}`);
    }
  } else {
    for (const k of ducked) out.push(lab[k]!);
    if (lab.dialogue) out.push(lab.dialogue);
  }
  if (lab.sfx) out.push(lab.sfx);
  g.push(`${out.map((x) => `[${x}]`).join('')}amix=inputs=${out.length}:duration=longest:normalize=0[out]`);
  return g.join(';');
}

/** The master's filters for a measured premix: one gain to the target, then a limiter under the true-peak ceiling. */
export function masterFilters(premix: Pick<Analysis, 'lufs' | 'truePeak'>, o: { targetLufs?: number; truePeak?: number } = {}): string[] {
  const target = num(o.targetLufs, MIX.targetLufs);
  const ceiling = num(o.truePeak, MIX.truePeak);
  const gain = loudnessGain(premix, target, ceiling - 0.5).filter((f) => !f.startsWith('alimiter'));
  // Always a limiter: true peaks between samples run past a sample-peak ceiling, so it sits half a dB lower.
  return [...gain, `alimiter=limit=${Math.pow(10, (ceiling - 0.5) / 20).toFixed(4)}:level=false:attack=2:release=60`];
}

const run = (args: string[], signal?: AbortSignal) => ff(['-y', ...args], { signal });

/** Renders a stem's parts to a 48 kHz float WAV. */
export async function renderStem(parts: StemPart[], length: number, out: string, signal?: AbortSignal) {
  const graph = stemGraph(parts, length);
  await run([...parts.flatMap((p) => ['-i', p.file]), '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_f32le', out], signal);
  return out;
}

export type MixResult = {
  file: string;
  stems: { kind: StemKind; before: number | null; target: number; gain: number }[];
  premix: Analysis;
  master: Analysis;
  verdict: { ok: boolean; problems: string[] };
  passes: number;
};

/**
 * The mix: each stem measured and brought to its level (dialogue first, the others relative to it), music and ambience
 * ducked under the dialogue, then the master to the target loudness under the true-peak ceiling. One corrective pass if
 * the limiter pulled the loudness off target.
 */
export async function mixStems(stems: Partial<Record<StemKind, string>>, out: string, o: { targetLufs?: number; truePeak?: number; dialogueLufs?: number; duckRatio?: number; tmp: (n: string) => string; signal?: AbortSignal }): Promise<MixResult> {
  const present = MIX_ORDER.filter((k) => stems[k]);
  if (!present.length) throw new GenError('Nothing to mix: give dialogue, music, ambience or effects');
  const targets = stemTargets(present, { dialogueLufs: o.dialogueLufs });
  const gains: Partial<Record<StemKind, number>> = {};
  const report: MixResult['stems'] = [];
  for (const k of present) {
    const a = await analyze(stems[k]!, { signal: o.signal });
    const g = a.lufs == null || a.lufs < -70 ? 0 : targets[k]! - a.lufs;
    gains[k] = r3(Math.max(-40, Math.min(30, g)));
    report.push({ kind: k, before: a.lufs, target: targets[k]!, gain: gains[k]! });
  }
  const pre = o.tmp('premix.wav');
  await run([...present.flatMap((k) => ['-i', stems[k]!]), '-filter_complex', mixGraph(present, gains, { duckRatio: o.duckRatio }), '-map', '[out]', '-c:a', 'pcm_f32le', pre], o.signal);
  const premix = await analyze(pre, { signal: o.signal });
  if (premix.silent) throw new GenError('The mix is silent: the stems have no sound');
  const target = num(o.targetLufs, MIX.targetLufs);
  // Always from the premix; a second pass aims past the target by what the limiter took off the first.
  let aim = target;
  let master: Analysis = premix;
  let passes = 0;
  while (passes < 3) {
    passes++;
    const f = masterFilters(premix, { targetLufs: aim, truePeak: o.truePeak });
    await run(['-i', pre, '-af', f.join(','), '-ar', '48000', '-c:a', 'pcm_s16le', out], o.signal);
    master = await analyze(out, { signal: o.signal });
    if (master.lufs == null || Math.abs(master.lufs - target) <= 0.5) break;
    aim += target - master.lufs;
  }
  fs.rmSync(pre, { force: true });
  const verdict = judge(master, { targetLufs: target, toleranceLufs: MIX.toleranceLufs, maxSilence: 9999 });
  const ceiling = num(o.truePeak, MIX.truePeak);
  if (master.truePeak != null && master.truePeak > ceiling + 0.3) { verdict.ok = false; verdict.problems.push(`true peak ${master.truePeak.toFixed(1)} dBTP, ceiling ${ceiling}`); }
  return { file: out, stems: report, premix, master, verdict, passes };
}
