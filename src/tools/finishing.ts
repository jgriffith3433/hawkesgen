// Finishing tools (docs/finishing.md): what turns a pile of clips into a show, and a world into a game.
//   audio.score     music written to a cut (tempo fitted so the cuts land on beats, a mood per section, hit points)
//   audio.ambience  room tone and ambience per place across its shots
//   audio.mix       dialogue first, music ducked under it, ambience and effects; -14 LUFS, -1 dBTP; checked
//   edit.pace       trims, order, J-cuts and L-cuts from the beats and dialogue, as timeline ops (one undo step)
//   video.grade     a world's color grade (a LUT or simple params), grain and vignette on any clip
//   video.titles    a title card, end credits (the cast by character name, the made-with line), captions soft or burned
//   video.reframe   16:9, 9:16, 1:1, 4:5 deliverables with the subject kept in frame
//   video.thumbnails  Claude picks three strong frames; each gets a title treatment
//   video.trailer   a 30-60 s cut from an episode: Claude picks the moments, then the edit, music and title
//   video.deliver   the Export sheet in one job: titles and captions, the aspect ratios, thumbnails, a trailer, the sheet
//   world.export    a world as a zip for games: models, pictures, voices, skyboxes, sets, the look, world.json
// The ffmpeg work runs here on the CPU (free); GPU steps (music, ambience beds, the final upscale) are child jobs queued
// through Gen's own API, like asset.make and the chain tools (src/tools/chain.ts), so a resumed job finds its children.

import fs from 'node:fs';
import path from 'node:path';
import type { RunContext, Tool } from './types.ts';
import { GenError, run, filterScriptArgs } from '../util.ts';
import { ask, usageOf } from '../providers/anthropic.ts';
import { probeMedia, toSrt, toVtt, composeTool, setFinalPass, type Caption, type Probe } from './compose.ts';
import { genClient, child, firstAsset } from './chain.ts';
import { analyze, ff } from '../audio/post.ts';
import { getAsset } from '../library.ts';
import { getScene, sceneRef } from '../scenes.ts';
import {
  fitTempo, planSections, musicRequests, stitchGraph, hitPoints, snapCuts, cutPointsFrom, planAmbience, ambienceGraph,
  renderStem, mixStems, MIX, type CutPoint, type StoryBeat, type PlaceSpan, type StemKind, type StemPart,
} from '../finishing/sound.ts';
import { gradeFilters } from '../finishing/grade.ts';
import { resolveGrade, worldGradeAtSubmit } from '../finishing/world-grade.ts';
import { planPace } from '../finishing/cut.ts';
import {
  ASPECTS, planReframe, parseCaptions, shiftCaptions, planCredits, assScript, titleEvents, creditEvents, creditSeconds,
  candidateTimes, settlePicks, settleTrailer, trailerPrompt, deliverySheet, TRAILER_SCHEMA, PICKS_SCHEMA,
  type CastLine, type SubjectKey, type TrailerShot, type SheetEntry,
} from '../finishing/deliver.ts';
import { planPack, zip, paletteGpl, importNote, worldFor, slug } from '../finishing/export.ts';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const json = (v: unknown, name: string) => {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') return v as any;
  try { return JSON.parse(v); } catch { throw new GenError(`${name} is JSON`); }
};
const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []) as string[];
const ffmpeg = (ctx: RunContext, args: string[], cwd?: string) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { signal: ctx.signal, cwd });
const dirOf = (ctx: RunContext) => path.dirname(ctx.tmp('x'));
const canSee = (ctx: RunContext) => (p: string) => p === ctx.job.project || p === 'shared';

let askFn: typeof ask = ask;
/** Tests only: a fake Claude for the trailer and thumbnails (null puts the real one back). */
export function _setFinishingAsk(f: typeof ask | null) { askFn = f ?? ask; }

/** The world a job names, if it can be seen. */
function worldOfJob(ctx: RunContext) {
  const id = typeof ctx.params.world === 'string' ? ctx.params.world : null;
  return id ? worldFor(ctx.job.project, id) : null;
}

const GRADE_PARAMS = {
  grade: { type: 'json', orString: true, description: 'The color grade: a preset (natural, warm, cool, filmic, noir, vivid, faded) or { params: { contrast, saturation, warmth, tint, lift, gamma, gain, brightness }, grain, vignette }. Default: the world\'s grade.', example: 'filmic' },
  world: { type: 'string', description: 'The world (scene id): its grade when none is given.', advanced: true },
  grain: { type: 'number', min: 0, max: 1, description: 'Film grain (0 to 1).', advanced: true },
  vignette: { type: 'number', min: 0, max: 1, description: 'Vignette (0 to 1).', advanced: true },
} as const;

// ------------------------------------------------------------------------------------------------ audio.score

export const audioScoreTool: Tool = {
  id: 'audio.score',
  version: 1,
  title: 'Score a cut',
  description: 'Music written to a cut: a tempo picked so the important cuts land on beats, the music made at the cut\'s length with the right mood for each section (one piece, or sections stitched on downbeats with crossfades), and the hit points (each cut with its beat and bar). Give the cut (its length) and the cut points (or clip spans), plus story beats with moods. The music is made by audio.music.',
  provider: 'pipeline',
  family: 'ace-step',
  output: 'audio',
  inputs: { video: { kind: 'video', description: 'The cut (its length; optional when length is given).' } },
  params: {
    cuts: { type: 'json', description: 'Cut points: seconds, or { at, weight } (a story beat 3, a scene change 2, a cut 1).', example: [4.2, { at: 9.5, weight: 2 }] },
    spans: { type: 'json', description: 'Or the clips\' spans on the cut [{ start, end }] (video.compose returns them as clips).', advanced: true },
    beats: { type: 'json', description: 'Story beats [{ at, mood, label }]: a mood change starts a new section.', example: [{ at: 0, mood: 'mysterious' }, { at: 12, mood: 'tense', label: 'the chase' }] },
    length: { type: 'number', min: 2, max: 900, description: 'The cut\'s length in seconds (default: the video\'s).' },
    mood: { type: 'string', description: 'The mood when no beats give one (calm, tense, action, epic, hopeful, playful, sad...).', default: 'cinematic' },
    style: { type: 'text', description: 'The music\'s style ("orchestral with taiko drums", "lo-fi synths"). Default: a film score.' },
    key: { type: 'string', description: 'Musical key (e.g. D minor).', advanced: true },
    crossfade: { type: 'number', min: 0.2, max: 4, default: 1, description: 'Seconds sections crossfade over.', advanced: true },
    tolerance: { type: 'number', min: 0.02, max: 0.2, default: 0.06, description: 'How close (s) a cut must be to a beat to count as on it.', advanced: true },
    seed: { type: 'integer', min: 0, max: 2 ** 48, advanced: true },
  },
  gpuSeconds: (p) => 20 + 0.5 * (Number(p.length) || 60),
  async run(ctx) {
    const p = ctx.params;
    const video = ctx.inputs.video as string | undefined;
    const length = Number(p.length) || (video ? (await probeMedia(video, ctx.signal)).duration : 0);
    if (!(length > 1)) throw new GenError('Give the cut (video) or its length');
    const beats: StoryBeat[] = (json(p.beats, 'beats') ?? []).filter((b: any) => Number.isFinite(Number(b?.at))).map((b: any) => ({ at: Number(b.at), mood: b.mood, label: b.label }));
    const rawCuts: any[] = json(p.cuts, 'cuts') ?? [];
    const spans = json(p.spans, 'spans');
    const cuts: CutPoint[] = Array.isArray(spans) && spans.length
      ? cutPointsFrom(spans, beats)
      : [...rawCuts.map((c: any) => (typeof c === 'number' ? { at: c, weight: 1 } : { at: Number(c?.at), weight: Number(c?.weight) || 1 })), ...beats.filter((b) => b.at > 0).map((b) => ({ at: b.at, weight: 3 }))];
    const mood = String(p.mood || beats[0]?.mood || 'cinematic');
    const fit = fitTempo(cuts.filter((c) => c.at < length), { mood: beats.find((b) => b.mood)?.mood ?? mood, tolerance: Number(p.tolerance) || 0.06 });
    const sections = planSections(length, beats, { bpm: fit.bpm, mood, style: p.style });
    const xf = Number(p.crossfade) || 1;
    ctx.log(`tempo ${fit.bpm} BPM: ${Math.round(fit.score * 100)}% of the cuts' weight on a beat; ${sections.length} section(s)`);
    const gen = genClient(ctx);
    const takes: string[] = [];
    for (const req of musicRequests(sections, { bpm: fit.bpm, crossfade: xf, key: p.key, seed: p.seed })) {
      ctx.step(`music for section ${req.section + 1} of ${sections.length} (${sections[req.section].mood})`);
      takes.push((await firstAsset(await child(ctx, gen, `music-${req.section}`, { tool: 'audio.music', params: req.params, inputs: {} }), 'audio')).path);
    }
    ctx.step('fitting the music to the cut');
    const out = ctx.tmp('score.wav');
    await ff(['-y', ...takes.flatMap((f) => ['-i', f]), '-filter_complex', stitchGraph(sections, xf), '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s16le', out], { signal: ctx.signal });
    const a = await analyze(out, { signal: ctx.signal });
    const hits = hitPoints(fit, sections);
    const result = { bpm: fit.bpm, beat: fit.beat, onBeat: fit.score, seconds: a.seconds, lufs: a.lufs, sections: sections.map(({ prompt, ...s }) => s), hits, snap: snapCuts(cuts.map((c) => c.at), fit.beat) };
    if (ctx.done < 1) await ctx.emit({ data: fs.readFileSync(out), ext: '.wav', title: 'score', meta: { bpm: fit.bpm, seconds: a.seconds, hits: hits.cuts } });
    ctx.result(result);
  },
};

// ------------------------------------------------------------------------------------------------ audio.ambience

export const audioAmbienceTool: Tool = {
  id: 'audio.ambience',
  version: 1,
  title: 'Ambience for a cut',
  description: 'Room tone and ambience per place across its shots: one seamless bed per place (made by audio.sfx), laid under every stretch of shots in that place with short crossfades at the place changes. Give each shot\'s place and span; a world fills in what each place sounds like.',
  provider: 'pipeline',
  family: 'stable-audio',
  output: 'audio',
  inputs: {},
  params: {
    shots: { type: 'json', required: true, description: '[{ place, start, end, description }]: place is a world place id or a name.', example: [{ place: 'harbor', start: 0, end: 6, description: 'a windy night harbor, rigging creaking' }, { place: 'tavern', start: 6, end: 14 }] },
    length: { type: 'number', min: 1, max: 900, description: 'The cut\'s length (default: the end of the last shot).' },
    world: { type: 'string', description: 'The world (scene id): its places describe the beds.', advanced: true },
    crossfade: { type: 'number', min: 0.2, max: 3, default: 0.75, advanced: true },
  },
  gpuSeconds: (p) => 30 * Math.max(1, (json(p.shots, 'shots') ?? []).length),
  async run(ctx) {
    const p = ctx.params;
    const w = worldOfJob(ctx);
    const shots: PlaceSpan[] = (json(p.shots, 'shots') ?? []).map((s: any) => {
      const place = String(s?.place ?? '');
      const wp = w?.places.find((x) => x.id === place || x.title.toLowerCase() === place.toLowerCase());
      return { place: wp?.title ?? place, start: Number(s?.start), end: Number(s?.end), description: s?.description ?? wp?.description };
    });
    const plan = planAmbience(shots, { length: Number(p.length) || undefined });
    const gen = genClient(ctx);
    const beds: string[] = [];
    for (const [i, b] of plan.beds.entries()) {
      ctx.step(`ambience for ${b.place}`);
      beds.push((await firstAsset(await child(ctx, gen, `bed-${i}`, { tool: 'audio.sfx', params: { text: b.prompt, duration: b.seconds, loop: true, provider: 'open' }, inputs: {} }), 'audio')).path);
    }
    const out = ctx.tmp('ambience.wav');
    await ff(['-y', ...beds.flatMap((f) => ['-i', f]), '-filter_complex', ambienceGraph(plan, Number(p.crossfade) || 0.75), '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s16le', out], { signal: ctx.signal });
    if (ctx.done < 1) await ctx.emit({ data: fs.readFileSync(out), ext: '.wav', title: 'ambience', meta: { seconds: plan.length, spans: plan.spans } });
    ctx.result({ seconds: plan.length, beds: plan.beds, spans: plan.spans });
  },
};

// ------------------------------------------------------------------------------------------------ audio.mix

export const audioMixTool: Tool = {
  id: 'audio.mix',
  version: 1,
  title: 'Mix a cut\'s sound',
  description: 'The final mix: dialogue first (brought to a steady level), then music ducked under the dialogue (a compressor keyed by it), then ambience (ducked lightly) and effects; mastered to -14 LUFS (web) with true peaks held under -1 dBTP, then checked (loudness, peaks, clipping). Give a video to get it back with the mix. Free (CPU).',
  provider: 'local',
  output: 'audio',
  inputs: {
    dialogue: { kind: 'audio', multiple: true, max: 200, description: 'Voice lines (placed by placement.dialogue).' },
    music: { kind: 'audio', description: 'The score.' },
    ambience: { kind: 'audio', description: 'Room tone and ambience.' },
    sfx: { kind: 'audio', multiple: true, max: 200, description: 'Effects (placed by placement.sfx).' },
    video: { kind: 'video', description: 'The cut: comes back with the mix as its sound.' },
  },
  params: {
    placement: { type: 'json', description: '{ dialogue: [{ start, in, seconds, volume }] one per file, sfx: [...], music: { start, in }, ambience: { start } }. Unplaced files start at 0.', example: { dialogue: [{ start: 1.2 }, { start: 5.4 }], sfx: [{ start: 3 }] } },
    length: { type: 'number', min: 1, max: 3600, description: 'Length of the mix (default: the video, else the longest stem).' },
    targetLufs: { type: 'number', min: -30, max: -8, default: -14, description: 'Master loudness: -14 for the web, -16 for podcasts, -23/-24 for broadcast.' },
    truePeak: { type: 'number', min: -6, max: 0, default: -1, advanced: true },
    dialogueLufs: { type: 'number', min: -30, max: -10, default: -18, advanced: true, description: 'Where dialogue sits before the master (music and the rest sit under it).' },
    duck: { type: 'number', min: 2, max: 20, default: 6, advanced: true, description: 'How hard music ducks under dialogue (compression ratio).' },
  },
  async run(ctx) {
    const p = ctx.params;
    const place = json(p.placement, 'placement') ?? {};
    const video = ctx.inputs.video as string | undefined;
    const files: Record<string, string[]> = { dialogue: list(ctx.inputs.dialogue), music: list(ctx.inputs.music), ambience: list(ctx.inputs.ambience), sfx: list(ctx.inputs.sfx) };
    let length = Number(p.length) || 0;
    if (!length && video) length = (await probeMedia(video, ctx.signal)).duration;
    if (!length) {
      for (const [k, fs_] of Object.entries(files)) for (const [i, f] of fs_.entries()) {
        const d = (await probeMedia(f, ctx.signal)).duration;
        const at = Number((Array.isArray(place[k]) ? place[k][i] : place[k])?.start) || 0;
        length = Math.max(length, at + d);
      }
    }
    if (!(length > 0)) throw new GenError('Nothing to mix: give dialogue, music, ambience or effects');
    const stems: Partial<Record<StemKind, string>> = {};
    for (const k of ['dialogue', 'music', 'ambience', 'sfx'] as StemKind[]) {
      if (!files[k].length) continue;
      ctx.step(`placing the ${k}`);
      const parts: StemPart[] = files[k].map((f, i) => ({ file: f, ...((Array.isArray(place[k]) ? place[k][i] : place[k]) ?? {}) }));
      stems[k] = await renderStem(parts, length, ctx.tmp(`${k}.wav`), ctx.signal);
    }
    ctx.step('mixing and mastering');
    const mix = await mixStems(stems, ctx.tmp('mix.wav'), { targetLufs: Number(p.targetLufs), truePeak: Number(p.truePeak), dialogueLufs: Number(p.dialogueLufs), duckRatio: Number(p.duck), tmp: ctx.tmp, signal: ctx.signal });
    for (const prob of mix.verdict.problems) ctx.log(`check: ${prob}`);
    const report = { seconds: mix.master.seconds, lufs: mix.master.lufs, truePeak: mix.master.truePeak, target: Number(p.targetLufs), ok: mix.verdict.ok, problems: mix.verdict.problems, stems: mix.stems, passes: mix.passes };
    const emits: { make: () => Promise<Buffer> | Buffer; ext: string; title: string }[] = [{ make: () => fs.readFileSync(mix.file), ext: '.wav', title: 'mix' }];
    if (video) emits.push({
      ext: '.mp4', title: 'video with the mix',
      make: async () => {
        const out = ctx.tmp('mixed.mp4');
        await ffmpeg(ctx, ['-i', video, '-i', mix.file, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', out]);
        return fs.readFileSync(out);
      },
    });
    for (let i = ctx.done; i < emits.length; i++) await ctx.emit({ data: await emits[i].make(), ext: emits[i].ext, title: emits[i].title, meta: { lufs: report.lufs, truePeak: report.truePeak } });
    ctx.result(report);
  },
};

// ------------------------------------------------------------------------------------------------ edit.pace

export const editPaceTool: Tool = {
  id: 'edit.pace',
  version: 1,
  title: 'Pace the edit',
  description: 'Proposes the edit\'s pacing for a timeline scene: trims the air before and after the lines in each shot, holds silent shots no longer than asked, puts shots in the story\'s beat order, and adds J-cuts (a line starts a few frames before its shot) and L-cuts (a line trails over the next shot). Answers with timeline ops (the AI editor\'s ops), so applying them is one undo step. Free.',
  provider: 'local',
  output: 'json',
  inputs: {},
  params: {
    scene: { type: 'string', description: 'The video scene (id) to pace.' },
    timeline: { type: 'json', description: 'Or the timeline document itself.', advanced: true },
    beats: { type: 'json', description: 'Story beats in order [{ clip, label }] (a beat naming a clip orders it).' },
    dialogue: { type: 'json', description: 'Dialogue spans [{ start, end, clip }] (default: the Voice track).', advanced: true },
    leadFrames: { type: 'integer', min: 0, max: 24, default: 6, description: 'How many frames sound leads or trails the picture at a dialogue cut.' },
    head: { type: 'number', min: 0, max: 2, default: 0.35, advanced: true, description: 'Air kept before a shot\'s first line (s).' },
    tail: { type: 'number', min: 0, max: 3, default: 0.5, advanced: true, description: 'Air kept after a shot\'s last line (s).' },
    maxSilent: { type: 'number', min: 0, max: 30, default: 0, description: 'Hold a shot with no line at most this long (s; 0 leaves them).' },
  },
  async run(ctx) {
    const p = ctx.params;
    let doc = json(p.timeline, 'timeline');
    if (!doc) {
      const id = sceneRef(p.scene);
      if (!id) throw new GenError('Give the scene to pace (scene) or a timeline');
      doc = getScene(id, canSee(ctx)).doc;
    }
    const plan = planPace(doc, { beats: json(p.beats, 'beats'), dialogue: json(p.dialogue, 'dialogue'), leadFrames: p.leadFrames, head: p.head, tail: p.tail, maxSilent: p.maxSilent });
    for (const n of plan.notes) ctx.log(n);
    ctx.result({ scene: p.scene ?? null, ops: plan.ops, changes: plan.changes, before: plan.before, after: plan.after, notes: plan.notes });
  },
};

// ------------------------------------------------------------------------------------------------ video.grade

export const videoGradeTool: Tool = {
  id: 'video.grade',
  version: 1,
  title: 'Grade a video',
  description: 'One color grade on a clip or a cut: the world\'s grade, a preset, a LUT (.cube) or simple settings (contrast, saturation, warmth, tint, lift, gamma, gain), with optional film grain and vignette. Free (CPU). video.compose takes the same grade for a whole cut.',
  provider: 'local',
  output: 'video',
  inputs: { video: { kind: 'video', required: true }, lut: { kind: 'file', description: 'A .cube LUT.' } },
  params: { ...GRADE_PARAMS, crf: { type: 'integer', min: 12, max: 35, default: 18, advanced: true } },
  async run(ctx) {
    const g = resolveGrade(ctx);
    const filters = g ? gradeFilters(g) : [];
    if (!filters.length) throw new GenError('No grade to apply: give a grade, a LUT, or a world with a grade');
    const out = ctx.tmp('graded.mp4');
    const v = ctx.inputs.video as string;
    const src = await probeMedia(v, ctx.signal);
    await ffmpeg(ctx, ['-i', v, '-vf', [...filters, 'format=yuv420p'].join(','), '-c:v', 'libx264', '-crf', String(ctx.params.crf ?? 18), '-preset', 'medium', ...(src.audio ? ['-c:a', 'copy'] : []), '-movflags', '+faststart', out]);
    await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', title: 'graded', meta: { grade: g } });
    ctx.result({ filters, grade: g });
  },
};

// ------------------------------------------------------------------------------------------------ video.titles

/** The cast for credits: given, else the world's characters. */
function castFor(ctx: RunContext): CastLine[] {
  const given = json(ctx.params.cast, 'cast');
  if (Array.isArray(given)) return given.map((c: any) => (typeof c === 'string' ? { character: c } : { character: String(c?.character ?? c?.name ?? '') }));
  return (worldOfJob(ctx)?.characters ?? []).map((c) => ({ character: c.title }));
}

/** A black card of `seconds` with an ASS script burned in, silent stereo sound. */
async function card(ctx: RunContext, name: string, ass: string, size: { width: number; height: number; fps: number }, seconds: number) {
  const dir = dirOf(ctx);
  fs.writeFileSync(path.join(dir, `${name}.ass`), ass);
  const out = path.join(dir, `${name}.mp4`);
  await ffmpeg(ctx, ['-f', 'lavfi', '-i', `color=c=black:s=${size.width}x${size.height}:r=${size.fps}:d=${r3(seconds)}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', `ass=${name}.ass`, '-t', r3(seconds).toString(), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-shortest', `${name}.mp4`], dir);
  return out;
}

export const videoTitlesTool: Tool = {
  id: 'video.titles',
  version: 1,
  title: 'Titles, credits and captions',
  description: 'Finishes a cut for delivery: a title card at the start (the title, the story or world under it), end credits (the cast by character name, then "Made with Hawkes Gen"), and captions: soft (a .vtt and .srt beside it and a caption track in the mp4) or burned in. Titles and credits come from the world and story when not given. Free (CPU).',
  provider: 'local',
  output: 'video',
  inputs: { video: { kind: 'video', required: true }, captions: { kind: 'file', description: 'Captions as .srt or .vtt (or give captionList).' } },
  params: {
    title: { type: 'string', description: 'The title (default: the episode, story or world).' },
    story: { type: 'string', description: 'The story or series name (under the title).' },
    world: { type: 'string', description: 'The world (scene id): its name and characters.', advanced: true },
    cast: { type: 'json', description: 'Characters for the credits: ["Maya", "Tomas"] (default: the world\'s).' },
    by: { type: 'string', description: 'Created by (a name for the credits).' },
    titleCard: { type: 'boolean', default: true, description: 'A title card at the start.' },
    credits: { type: 'boolean', default: true, description: 'End credits.' },
    titleSeconds: { type: 'number', min: 1.5, max: 10, default: 3.5, advanced: true },
    captionList: { type: 'json', description: 'Captions [{ start, end, text }] on the cut (before the title card).', advanced: true },
    captionMode: { type: 'enum', values: ['soft', 'burn', 'both', 'none'], default: 'soft', description: 'Soft (files and a caption track: viewers switch them on) or burned into the picture.' },
    accent: { type: 'string', default: '#ffffff', description: 'Title color (hex).', advanced: true },
    crf: { type: 'integer', min: 12, max: 35, default: 18, advanced: true },
  },
  async run(ctx) {
    const p = ctx.params;
    const v = ctx.inputs.video as string;
    const src = await probeMedia(v, ctx.signal);
    if (!src.video || !src.width || !src.height) throw new GenError('That file has no picture');
    const size = { width: src.width - (src.width % 2), height: src.height - (src.height % 2), fps: Math.round(src.fps || 24) };
    const w = worldOfJob(ctx);
    const credits = planCredits({ title: p.title, world: w?.title ?? null, story: p.story ?? null, cast: castFor(ctx), by: p.by ?? null });
    const dir = dirOf(ctx);
    const parts: string[] = [];
    const lead = p.titleCard !== false ? Number(p.titleSeconds) || 3.5 : 0;
    ctx.step('making the title and credits');
    if (lead) parts.push(await card(ctx, 'title', assScript(size.width, size.height, titleEvents(credits, lead), { accent: p.accent }), size, lead));
    parts.push(v);
    const tailSec = p.credits !== false ? creditSeconds(credits) : 0;
    if (tailSec) parts.push(await card(ctx, 'credits', assScript(size.width, size.height, creditEvents(credits, tailSec)), size, tailSec));
    // Captions, moved by the title card.
    let caps: Caption[] = json(p.captionList, 'captionList') ?? [];
    if (ctx.inputs.captions) caps = parseCaptions(fs.readFileSync(ctx.inputs.captions as string, 'utf8'));
    const mode = caps.length ? p.captionMode : 'none';
    caps = shiftCaptions(caps.map((c) => ({ start: Number(c.start), end: Number(c.end), text: String(c.text) })), lead, lead + src.duration);
    const burn = mode === 'burn' || mode === 'both';
    const soft = mode === 'soft' || mode === 'both';
    if (caps.length) fs.writeFileSync(path.join(dir, 'captions.srt'), toSrt(caps));
    // One pass: every part fitted to the cut's size and rate, joined, captions burned if asked, a caption track if soft.
    const fit = `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${size.fps},format=yuv420p`;
    const afmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
    const g: string[] = [];
    const args: string[] = [];
    for (const [i, f] of parts.entries()) {
      args.push('-i', f);
      g.push(`[${i}:v]${fit}[v${i}]`);
    }
    let silent = parts.length;
    for (const [i, f] of parts.entries()) {
      const has = f === v ? src.audio : true;
      if (has) g.push(`[${i}:a]${afmt}[a${i}]`);
      else { args.push('-f', 'lavfi', '-t', r3(src.duration).toString(), '-i', 'anullsrc=r=48000:cl=stereo'); g.push(`[${silent}:a]${afmt}[a${i}]`); silent++; }
    }
    g.push(`${parts.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${parts.length}:v=1:a=1[vc][aout]`);
    g.push(`[vc]${burn ? `subtitles=captions.srt:force_style='FontName=Arial,FontSize=16,Outline=1.5,Shadow=0,MarginV=18,BorderStyle=1',` : ''}format=yuv420p[vout]`);
    fs.writeFileSync(path.join(dir, 'titles.filter'), g.join(';\n'));
    const subIn = soft && caps.length ? silent : -1;
    if (subIn >= 0) args.push('-i', 'captions.srt');
    ctx.step('joining the titles, the cut and the credits');
    await ffmpeg(ctx, [...args, ...filterScriptArgs('titles.filter'), '-map', '[vout]', '-map', '[aout]', ...(subIn >= 0 ? ['-map', `${subIn}:s`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng'] : []),
      '-c:v', 'libx264', '-crf', String(p.crf ?? 18), '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'titled.mp4'], dir);
    const made = await probeMedia(path.join(dir, 'titled.mp4'), ctx.signal);
    const emits: { data: () => Buffer; ext: string; title: string; meta?: Record<string, unknown> }[] = [
      { data: () => fs.readFileSync(path.join(dir, 'titled.mp4')), ext: '.mp4', title: 'master', meta: { duration: made.duration, width: made.width, height: made.height, titleSeconds: lead, creditSeconds: tailSec } },
    ];
    if (caps.length && mode !== 'none') {
      emits.push({ data: () => Buffer.from(toVtt(caps)), ext: '.vtt', title: 'captions (vtt)' }, { data: () => Buffer.from(toSrt(caps)), ext: '.srt', title: 'captions (srt)' });
    }
    for (let i = ctx.done; i < emits.length; i++) await ctx.emit({ data: emits[i].data(), ext: emits[i].ext, title: emits[i].title, meta: emits[i].meta });
    ctx.result({ duration: r3(made.duration), titleSeconds: lead, creditSeconds: tailSec, credits, captions: caps.length, captionMode: mode });
  },
};

// ------------------------------------------------------------------------------------------------ video.reframe

export const videoReframeTool: Tool = {
  id: 'video.reframe',
  version: 1,
  title: 'Reframe for every platform',
  description: 'Makes the aspect ratios each platform wants (16:9, 9:16, 1:1, 4:5) from one cut, cropping so the subject stays in frame: subject positions over time when known (a stage shot\'s cast), else the centre. The pan is smoothed. Free (CPU).',
  provider: 'local',
  output: 'video',
  inputs: { video: { kind: 'video', required: true } },
  params: {
    aspects: { type: 'json', default: ['9:16'], description: 'Which: ["9:16", "1:1", "4:5", "16:9"].', example: ['9:16', '1:1'] },
    subject: { type: 'json', description: 'Where the subject is: [{ t, x, y }] (0 to 1 of the frame) over time.', advanced: true },
    maxPan: { type: 'number', min: 0.02, max: 1, default: 0.25, advanced: true, description: 'Fastest pan, in frame widths a second.' },
    crf: { type: 'integer', min: 12, max: 35, default: 19, advanced: true },
  },
  async run(ctx) {
    const p = ctx.params;
    const v = ctx.inputs.video as string;
    const src = await probeMedia(v, ctx.signal);
    if (!src.width || !src.height) throw new GenError('That file has no picture');
    const aspects: string[] = (json(p.aspects, 'aspects') ?? ['9:16']).map(String);
    for (const a of aspects) if (!ASPECTS[a]) throw new GenError(`aspects are ${Object.keys(ASPECTS).join(', ')}`);
    const keys: SubjectKey[] = (json(p.subject, 'subject') ?? []).map((k: any) => ({ t: Number(k.t ?? 0), x: Number(k.x), ...(k.y != null ? { y: Number(k.y) } : {}) }));
    const plans = aspects.map((a) => planReframe(src.width!, src.height!, a, keys, { maxPan: p.maxPan }));
    for (let i = ctx.done; i < plans.length; i++) {
      const r = plans[i];
      ctx.step(`making ${r.aspect}`);
      const out = ctx.tmp(`reframe-${i}.mp4`);
      await ffmpeg(ctx, ['-i', v, '-vf', `${r.filter},format=yuv420p`, '-c:v', 'libx264', '-crf', String(p.crf ?? 19), '-preset', 'medium', ...(src.audio ? ['-c:a', 'copy'] : []), '-map_metadata', '-1', '-movflags', '+faststart', out]);
      await ctx.emit({ data: fs.readFileSync(out), ext: '.mp4', title: r.aspect, meta: { aspect: r.aspect, width: r.out.width, height: r.out.height, crop: r.crop, source: r.source, for: ASPECTS[r.aspect].for } });
    }
    ctx.result({ aspects: plans.map((r) => ({ aspect: r.aspect, width: r.out.width, height: r.out.height, source: r.source })) });
  },
};

// ------------------------------------------------------------------------------------------------ video.thumbnails

export const videoThumbnailsTool: Tool = {
  id: 'video.thumbnails',
  version: 1,
  title: 'Thumbnails',
  description: 'Three thumbnails for an episode: Claude looks at frames from across the cut and picks the three strongest (a clear face or subject, emotion, contrast, nothing given away), then each gets a bold title treatment at 1280x720.',
  provider: 'local',
  output: 'image',
  inputs: { video: { kind: 'video', required: true } },
  params: {
    title: { type: 'string', description: 'The text on the thumbnails (default: the title Claude suggests).' },
    spans: { type: 'json', description: 'The shots\' spans [{ start, end }]: one candidate per shot.', advanced: true },
    count: { type: 'integer', min: 1, max: 3, default: 3 },
    accent: { type: 'string', default: '#ffd84a', advanced: true, description: 'Title color (hex).' },
  },
  async run(ctx) {
    const p = ctx.params;
    const v = ctx.inputs.video as string;
    const src = await probeMedia(v, ctx.signal);
    const times = candidateTimes(src.duration, { spans: json(p.spans, 'spans') });
    ctx.step(`looking at ${times.length} frames`);
    const frames: string[] = [];
    for (const [i, t] of times.entries()) {
      const f = ctx.tmp(`cand-${i}.jpg`);
      await ffmpeg(ctx, ['-ss', r3(t).toString(), '-i', v, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', f]);
      frames.push(f);
    }
    let answer: any = null;
    try {
      const r = await askFn({ prompt: `These are ${frames.length} frames (0 to ${frames.length - 1}) from "${p.title || 'an episode'}". Pick the ${p.count} best for thumbnails: a clear face or subject, strong emotion or action, good contrast, readable at a small size, no spoilers. Different moments, not near-duplicates. Suggest a short title (2 to 5 words) for each.`, images: frames, schema: PICKS_SCHEMA, model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 2000 }, ctx.signal);
      ctx.usage(usageOf(r, `${r.model} thumbnails`));
      answer = JSON.parse(r.text);
    } catch (e: any) {
      ctx.log(`picking frames without Claude (${e.message}): spread across the cut`);
    }
    const picks = settlePicks(answer, frames.length, Number(p.count) || 3);
    const dir = dirOf(ctx);
    for (let i = ctx.done; i < picks.length; i++) {
      const k = picks[i];
      const text = String(p.title || k.title || '').trim();
      ctx.step(`thumbnail ${i + 1}`);
      fs.writeFileSync(path.join(dir, `thumb-${i}.ass`), assScript(1280, 720, text ? [{ start: 0, end: 5, text, style: 'Thumb' }] : [], { accent: p.accent }));
      await ffmpeg(ctx, ['-ss', r3(times[k.index]).toString(), '-i', v, '-frames:v', '1', '-vf', `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1${text ? `,ass=thumb-${i}.ass` : ''}`, `thumb-${i}.png`], dir);
      await ctx.emit({ data: fs.readFileSync(path.join(dir, `thumb-${i}.png`)), ext: '.png', title: `thumbnail ${i + 1}`, meta: { at: times[k.index], why: k.why, text } });
    }
    ctx.result({ picks: picks.map((k) => ({ at: times[k.index], why: k.why, title: p.title || k.title || null })) });
  },
};

// ------------------------------------------------------------------------------------------------ video.trailer

export const videoTrailerTool: Tool = {
  id: 'video.trailer',
  version: 1,
  title: 'Make a trailer',
  description: 'A 30-60 second trailer from an episode: Claude reads the script and shot list and picks the moments (a hook, the build, the climax, a button after the title) and a few text cards, then the edit is cut with fades, scored music under the episode\'s own dialogue, and a title card. Never gives away the ending.',
  provider: 'pipeline',
  family: 'ace-step',
  output: 'video',
  inputs: { video: { kind: 'video', required: true, description: 'The episode.' } },
  params: {
    title: { type: 'string', required: true },
    seconds: { type: 'integer', min: 15, max: 90, default: 45 },
    script: { type: 'text', description: 'The episode\'s script.' },
    shots: { type: 'json', description: 'The shot list [{ index, start, end, description, lines }].' },
    music: { type: 'boolean', default: true, description: 'Score it (audio.score).' },
    mood: { type: 'string', default: 'epic', description: 'The trailer music\'s mood.' },
    style: { type: 'text', description: 'The music\'s style.', advanced: true },
  },
  gpuSeconds: () => 60,
  async run(ctx) {
    const p = ctx.params;
    const v = ctx.inputs.video as string;
    const src = await probeMedia(v, ctx.signal);
    const size = { width: (src.width ?? 1280) - ((src.width ?? 1280) % 2), height: (src.height ?? 720) - ((src.height ?? 720) % 2), fps: Math.round(src.fps || 24) };
    const shots: TrailerShot[] = json(p.shots, 'shots') ?? [];
    ctx.step('choosing the moments');
    const r = await askFn({ prompt: trailerPrompt({ script: p.script, shots, length: src.duration, seconds: Number(p.seconds), title: p.title }), schema: TRAILER_SCHEMA, effort: 'high', maxTokens: 4000 }, ctx.signal);
    ctx.usage(usageOf(r, `${r.model} trailer`));
    const plan = settleTrailer(JSON.parse(r.text), src.duration, { seconds: Number(p.seconds), title: p.title });
    ctx.log(`trailer plan: ${plan.moments.length} moments, ${plan.cards.length} card(s), ${plan.seconds} s`);
    // Cards and the end title as clips; the moments are cuts of the episode.
    const cardFiles: string[] = [];
    for (const [i, c] of plan.cards.entries()) cardFiles.push(await card(ctx, `card-${i}`, assScript(size.width, size.height, [{ start: 0.15, end: 1.9, text: c.text, style: 'Title', fade: 0.3 }]), size, 2));
    const endText = plan.tagline ? `${plan.title}\n\n\n` : plan.title;
    const endEvents: Parameters<typeof assScript>[2] = [{ start: 0.2, end: 2.9, text: endText, style: 'Title', fade: 0.4 }];
    if (plan.tagline) endEvents.push({ start: 0.6, end: 2.9, text: `\n\n\n${plan.tagline}`, style: 'Sub', fade: 0.4 });
    const endFile = await card(ctx, 'end', assScript(size.width, size.height, endEvents), size, 3);
    const clips: any[] = [];
    plan.moments.forEach((m, i) => {
      clips.push({ clip: 0, in: m.start, out: m.end, dialogue: true, transition: i < plan.moments.length - 1 ? 'crossfade' : 'fadeblack', seconds: 0.25 });
      const c = plan.cards.findIndex((x) => x.after === i);
      if (c >= 0) clips.push({ clip: 1 + c, sound: false, transition: 'fadeblack', seconds: 0.3 });
    });
    clips.push({ clip: 1 + cardFiles.length, sound: false });
    const gen = genClient(ctx);
    const audio: string[] = [];
    const tl: any = { clips, fadeIn: 0.3, fadeOut: 0.8 };
    if (p.music !== false) {
      // Rough spans for the score's tempo (the compose's exact spans differ only by the short transitions).
      let t = 0;
      const spans = clips.map((c) => { const len = c.out != null ? c.out - c.in : c.clip === 1 + cardFiles.length ? 3 : 2; const s = { start: r3(t), end: r3(t + len) }; t += len; return s; });
      const score = await firstAsset(await child(ctx, gen, 'score', { tool: 'audio.score', params: { spans, length: r3(t), mood: p.mood || 'epic', ...(p.style ? { style: p.style } : {}) }, inputs: {} }), 'audio');
      audio.push(`asset:${score.id}`);
      tl.audio = [{ audio: 0, volume: 0.8, fadeOut: 1.5, duck: 'sidechain', duckTo: 0.35 }];
    }
    const cut = await child(ctx, gen, 'cut', { tool: 'video.compose', params: { timeline: tl, width: size.width, height: size.height, fps: size.fps, fit: 'crop', poster: false }, inputs: { clips: [v, ...cardFiles, endFile], ...(audio.length ? { audio } : {}) } });
    const made = await firstAsset(cut, 'video');
    if (ctx.done < 1) await ctx.emit({ data: fs.readFileSync(made.path), ext: '.mp4', title: 'trailer', meta: { from: made.id, seconds: cut.result?.duration ?? plan.seconds, title: plan.title } });
    ctx.result({ plan, seconds: cut.result?.duration ?? plan.seconds, cut: made.id });
  },
};

// ------------------------------------------------------------------------------------------------ video.deliver

const entryOf = (job: any, kind: string, extra: Partial<SheetEntry> = {}): SheetEntry[] => (job?.outputs ?? []).map((o: any) => {
  const a = getAsset(o.asset);
  const m = (a?.meta ?? {}) as any;
  const ext = a ? path.extname(a.path).slice(1) : undefined;
  return { kind: ext === 'vtt' || ext === 'srt' ? 'captions' : kind, title: a?.title ?? o.title ?? kind, asset: o.asset ?? null, job: job.id, format: ext, ...(m.width ? { width: m.width, height: m.height } : {}), ...(m.duration ? { seconds: m.duration } : {}), bytes: a?.bytes, ...(m.for ? { for: m.for } : {}), ...extra };
});

export const videoDeliverTool: Tool = {
  id: 'video.deliver',
  version: 1,
  title: 'Deliver a cut',
  description: 'Everything a finished episode ships with, in one job: the master with a title card, end credits and captions (soft or burned), the aspect ratios each platform wants (reframed so the subject stays in frame), three thumbnails, optionally a trailer, and a delivery sheet listing every file. The app\'s Export sheet runs this.',
  provider: 'pipeline',
  output: 'json',
  inputs: { video: { kind: 'video', required: true, description: 'The finished cut.' }, captions: { kind: 'file', description: 'Captions (.srt or .vtt).' } },
  params: {
    title: { type: 'string', required: true },
    story: { type: 'string' },
    world: { type: 'string', description: 'The world (scene id).', advanced: true },
    cast: { type: 'json', description: 'Characters for the credits (default: the world\'s).', advanced: true },
    titles: { type: 'boolean', default: true, description: 'A title card and end credits.' },
    captionList: { type: 'json', advanced: true, description: 'Captions [{ start, end, text }] on the cut.' },
    captionMode: { type: 'enum', values: ['soft', 'burn', 'both', 'none'], default: 'soft' },
    formats: { type: 'json', default: ['16:9', '9:16'], description: 'Aspect ratios: 16:9, 9:16, 1:1, 4:5.' },
    subject: { type: 'json', advanced: true, description: 'Where the subject is over time [{ t, x, y }] (for the reframes).' },
    thumbnails: { type: 'boolean', default: true },
    trailer: { type: 'boolean', default: false, description: 'Also cut a trailer (Claude and music: costs credits).' },
    trailerSeconds: { type: 'integer', min: 15, max: 90, default: 45, advanced: true },
    script: { type: 'text', advanced: true, description: 'The script (for the trailer).' },
    shots: { type: 'json', advanced: true, description: 'The shot list (for the trailer and thumbnails).' },
  },
  gpuSeconds: (p) => (p.trailer ? 60 : 0),
  async run(ctx) {
    const p = ctx.params;
    const v = ctx.inputs.video as string;
    const src: Probe = await probeMedia(v, ctx.signal);
    const gen = genClient(ctx);
    const entries: SheetEntry[] = [];
    const notes: string[] = [];
    const common = { ...(p.world ? { world: p.world } : {}) };
    let master = v;
    const wantCaptions = p.captionMode !== 'none' && (ctx.inputs.captions || json(p.captionList, 'captionList')?.length);
    if (p.titles !== false || wantCaptions) {
      ctx.step('titles, credits and captions');
      const job = await child(ctx, gen, 'titles', {
        tool: 'video.titles',
        params: { ...common, title: p.title, ...(p.story ? { story: p.story } : {}), ...(p.cast ? { cast: p.cast } : {}), titleCard: p.titles !== false, credits: p.titles !== false, captionMode: wantCaptions ? p.captionMode : 'none', ...(p.captionList ? { captionList: p.captionList } : {}) },
        inputs: { video: v, ...(ctx.inputs.captions ? { captions: ctx.inputs.captions } : {}) },
      });
      master = `asset:${(await firstAsset(job, 'video')).id}`;
      entries.push(...entryOf(job, 'master'));
    } else entries.push({ kind: 'master', title: 'master', asset: null, format: 'mp4', width: src.width, height: src.height, seconds: r3(src.duration), for: 'the cut as given' });
    const own = src.width && src.height ? Object.entries(ASPECTS).find(([, a]) => Math.abs(a.w / a.h - src.width! / src.height!) < 0.02)?.[0] : null;
    const formats = ((json(p.formats, 'formats') ?? []) as string[]).filter((f) => ASPECTS[f] && f !== own);
    if (formats.length) {
      ctx.step(`reframing for ${formats.join(', ')}`);
      const job = await child(ctx, gen, 'reframe', { tool: 'video.reframe', params: { aspects: formats, ...(p.subject ? { subject: p.subject } : {}) }, inputs: { video: master } });
      entries.push(...entryOf(job, 'aspect'));
    }
    if (p.thumbnails !== false) {
      ctx.step('thumbnails');
      const spans = (json(p.shots, 'shots') ?? []).map((s: any) => ({ start: Number(s.start), end: Number(s.end) }));
      const job = await child(ctx, gen, 'thumbnails', { tool: 'video.thumbnails', params: { title: p.title, ...(spans.length ? { spans } : {}) }, inputs: { video: v } });
      entries.push(...entryOf(job, 'thumbnail', { for: 'the episode page and feeds' }));
    }
    if (p.trailer) {
      ctx.step('the trailer');
      try {
        const job = await child(ctx, gen, 'trailer', { tool: 'video.trailer', params: { title: p.title, seconds: p.trailerSeconds ?? 45, ...(p.script ? { script: p.script } : {}), ...(p.shots ? { shots: p.shots } : {}) }, inputs: { video: v } });
        entries.push(...entryOf(job, 'trailer'));
      } catch (e: any) {
        notes.push(`The trailer wasn't made: ${e.message}`);
      }
    }
    const sheet = deliverySheet({ title: p.title, entries, world: p.world ?? null, notes });
    if (ctx.done < 1) await ctx.emit({ data: Buffer.from(JSON.stringify(sheet, null, 2)), ext: '.json', title: 'delivery sheet', meta: { files: sheet.count } });
    ctx.result(sheet);
  },
};

// ------------------------------------------------------------------------------------------------ world.export

export const worldExportTool: Tool = {
  id: 'world.export',
  version: 1,
  title: 'Take a world into a game',
  description: 'Packs a world for games: every character\'s rigged 3D model (GLB, and FBX when there is one), their pictures and voice samples; each place\'s panorama as a skybox, its 3D set and ambience; props\' models; the look (palette, LUT, style board); and world.json, a manifest with ids, names, descriptions, canon, file paths and every file\'s recipe. Unity (the Hawkes Gen package\'s world importer) and web games (clients/js/hawkes-world.mjs) load it. Free.',
  provider: 'local',
  output: 'file',
  inputs: {},
  params: {
    world: { type: 'string', required: true, description: 'The world (scene id).' },
    by: { type: 'string', description: 'Who made it (for the manifest).', advanced: true },
  },
  async run(ctx) {
    const p = ctx.params;
    const w = worldFor(ctx.job.project, String(p.world));
    if (!w) throw new GenError('That world was not found (or has nothing in it yet)');
    const see = canSee(ctx);
    const docOf = (id: string) => { try { return sceneRef(id) ? getScene(id, see).doc : null; } catch { return null; } };
    ctx.step('gathering the world');
    const { manifest, files } = planPack({ world: w, docOf }, { by: p.by });
    for (const m of manifest.missing) ctx.log(`missing: ${m}`);
    const root = slug(w.title, 'world');
    const entries = [
      { name: `${root}/world.json`, data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: `${root}/README.md`, data: Buffer.from(importNote(manifest)) },
      ...(w.look.palette.length ? [{ name: `${root}/look/palette.gpl`, data: Buffer.from(paletteGpl(w.title, w.look.palette)) }] : []),
      ...files.map((f) => ({ name: `${root}/${f.path}`, data: fs.readFileSync(f.file) })),
    ];
    ctx.step(`packing ${entries.length} files`);
    const data = zip(entries);
    await ctx.emit({ data, ext: '.zip', title: `${w.title} (world pack)`, meta: { files: entries.length, characters: manifest.characters.length, places: manifest.places.length, props: manifest.props.length, missing: manifest.missing.length } });
    await ctx.emit({ data: Buffer.from(JSON.stringify(manifest, null, 2)), ext: '.json', title: 'world.json' });
    ctx.result({ world: w.worldId, root, files: entries.length, bytes: data.length, characters: manifest.characters.length, places: manifest.places.length, props: manifest.props.length, missing: manifest.missing });
  },
};

export const FINISHING_TOOLS: Tool[] = [
  audioScoreTool, audioAmbienceTool, audioMixTool, editPaceTool, videoGradeTool, videoTitlesTool, videoReframeTool,
  videoThumbnailsTool, videoTrailerTool, videoDeliverTool, worldExportTool,
];

// video.compose on the control server: a world's grade becomes its `grade` param at submit, and the final pass is queued
// through Gen's own API (compose itself stays free of the library: it also runs in the CPU service).
const ownAdmit = composeTool.admit;
composeTool.admit = (call) => worldGradeAtSubmit(ownAdmit ? ownAdmit(call) : call.params, call.project);
setFinalPass(async (ctx, cut, poster) => {
  const gen = genClient(ctx);
  const up = await gen.submit('video.upscale', { params: {}, inputs: { video: cut }, labels: { parent: ctx.job.id, step: 'final-upscale' }, key: `${ctx.job.id}:final-upscale`, reuse: true });
  const restore = poster ? await gen.submit('image.restore', { params: {}, inputs: { image: poster }, labels: { parent: ctx.job.id, step: 'final-restore' }, key: `${ctx.job.id}:final-restore`, reuse: true }) : null;
  ctx.log(`final pass queued: video.upscale ${up.id}${restore ? `, image.restore ${restore.id}` : ''}`);
  return { upscale: up.id, ...(restore ? { restore: restore.id } : {}) };
});
