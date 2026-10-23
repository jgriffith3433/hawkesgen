// video.review: a critic that watches and listens. Gemini gets the cut itself, picture and sound, and judges it as an
// experience (J, 2026-10-22: the videos fall short on "pacing, voices, lipsync, movement and script"; a review of
// contact sheets can see none of that). Critique mode: scores, a verdict and timecoded notes, each with the fix it asks
// for (the same asks as Studio's Screening timeline). Pick mode: several takes of one scene ranked, the best named.
// A reference clip (what good looks like to J) calibrates the bar.

import fs from 'node:fs';
import type { Tool } from './types.ts';
import { askJson, mediaPart, costOf, REVIEW_MODEL } from '../providers/gemini.ts';
import { GenError, run } from '../util.ts';

/** What a note can ask for: Studio's timeline asks (videos.ts NOTE_ACTIONS), so a note lands on the timeline as one. */
export const ASKS = ['shorter', 'longer', 'redo', 'lipsync', 'closer', 'wider', 'angle', 'reaction', 'camera', 'expression', 'voice', 'look', 'action', 'sound', 'caption', 'cut', 'script'];
export const ASPECTS = ['story', 'pacing', 'voices', 'lipsync', 'movement', 'consistency', 'sound'];

const NOTE = {
  type: 'OBJECT',
  properties: {
    at: { type: 'NUMBER', description: 'Seconds into the video where the problem starts' },
    to: { type: 'NUMBER', nullable: true, description: 'Where it ends (null for a moment)' },
    ask: { type: 'STRING', enum: ASKS },
    note: { type: 'STRING', description: 'What is wrong as the viewer experiences it, and the concrete fix' },
  },
  required: ['at', 'ask', 'note'],
};
export const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    pass: { type: 'BOOLEAN' },
    score: { type: 'NUMBER', description: '1-10 overall: would this sell the product it advertises?' },
    summary: { type: 'STRING' },
    scores: { type: 'OBJECT', properties: Object.fromEntries(ASPECTS.map((a) => [a, { type: 'NUMBER' }])), required: ASPECTS },
    experience: { type: 'STRING', description: 'One paragraph: what watching it feels like, second by second, where attention goes and drifts' },
    notes: { type: 'ARRAY', items: NOTE },
    best: { type: 'INTEGER', nullable: true, description: 'Pick mode: the index of the best take (0-based)' },
    ranking: { type: 'ARRAY', items: { type: 'OBJECT', properties: { take: { type: 'INTEGER' }, score: { type: 'NUMBER' }, why: { type: 'STRING' } }, required: ['take', 'score', 'why'] } },
  },
  required: ['pass', 'score', 'summary', 'scores', 'experience', 'notes'],
};

/** The critic's instructions: the video as a lived experience first, then the five things J named, then the craft. */
export function reviewInstructions(o: { brief: string; takes: number; reference: boolean; focus?: string; maxNotes: number }) {
  return `You are a film editor and director reviewing ${o.takes > 1 ? `${o.takes} takes of the same scene` : 'a short video'} before it goes to the person who ordered it. You watch it and listen to it, at full length. Be the strict, specific reviewer a good editor is: this video will advertise a product, and other tools already make videos that need little editing. If it isn't that good, say exactly what keeps it from being that good.

Judge it as an experience that unfolds in time, not as a sequence of shots:
- Every moment should change something: what the viewer knows, expects, feels, notices, or how they read what comes next. For each stretch ask: where does attention go, what does the viewer expect, what actually changes, what carries forward.
- Pacing is a pulse, not a tempo: quiet stretches make the peaks matter; important actions get room to unfold; routine is compressed; reactions are held; a cut comes when the moment is experienced, not merely when the information is delivered. Flag mechanical cutting (a cut every couple of seconds or on every sentence for its own sake), constant escalation, dead air, and moments that overstay or are rushed.
- Five clocks: physical time (actions take as long as they take), psychological time (how long a moment feels to the character), social time (turn-taking, a beat before a hard answer, the listener's face after the line), environmental time (the world keeps moving: light, steam, background), editorial time (what is kept, skipped, held).
- Behavior is causally coherent: people react a fraction late, look away, hesitate, carry an emotion into the next beat; objects stay where they were put. Overdirected, on-cue acting and arbitrary "imperfection" both fail.

Then the five things the client named, each scored 1-10:
- story/script: is the point clear to a stranger in one watch, does every line earn its place, is there a turn and a payoff, does it end on the payoff?
- pacing: as above.
- voices: does each character have their own fitting voice, delivered like a person (not read), with natural turn-taking, interruptions, breaths and emotion? Robotic gaps between lines, the same flat read, or a voice that doesn't fit the face fail.
- lipsync: do the speaker's lips match the words the whole way through, is it the right mouth moving, does sync drift at joins?
- movement: do bodies and faces act (weight, gesture, reaction, cause and effect), or are they still images with a slow zoom, floaty, morphing, or frozen?
Also score consistency (each character on-model, one look, one place and light; no jumps at joins) and sound (mix, effects on actions, music under, nothing missing).

Notes: up to ${o.maxNotes}, worst first. Each has the second it starts (at), where it ends (to, or null), the fix it asks for (ask: one of ${ASKS.join(', ')}), and the note: what is wrong as the viewer experiences it and the concrete fix ("4.0-6.5 s: the Mechanic's reply comes instantly after the question, so it plays as recited; hold a beat on him before he speaks and let him look at the bolt first"). No vague notes like "improve pacing". pass is true only when it is good enough to post as is (score 8 or more and no note that a viewer would notice in one watch).
${o.takes > 1 ? `\nPick mode: the files are takes 0 to ${o.takes - 1} of the same scene, in order. Rank every take (ranking: take, score, why) and name the best (best). The notes and scores are for the best take.\n` : ''}${o.reference ? `\nThe last file is a REFERENCE the client considers good enough to sell with. Hold the video to it: say what the reference does (pacing, delivery, movement, sound) that this doesn't. Never review the reference itself.\n` : ''}${o.focus ? `\nLook especially at: ${o.focus}\n` : ''}
What the video is meant to be (the brief: script, story, beat sheet, earlier notes):
${o.brief.slice(0, 20000)}`;
}

export const videoReviewTool: Tool = {
  id: 'video.review',
  version: 1,
  title: 'Review a video (watches and listens)',
  description: 'Gemini watches the video with its sound and reviews it as an experience: story, pacing, voices, lip sync, movement, consistency and sound scored 1-10, a pass/fail, what watching it feels like, and timecoded notes each with the fix it asks for (shorter, redo, lipsync, closer, angle, reaction, voice, look...). Several videos: takes of one scene ranked, the best named. A reference clip (what good looks like) sets the bar. Give the brief: the script, the story, the beat sheet, earlier notes.',
  provider: 'gemini',
  output: 'json',
  inputs: {
    video: { kind: 'video', required: true, multiple: true, max: 4, description: 'The cut, or up to 4 takes of one scene to pick from' },
    reference: { kind: 'video', description: 'A clip that is good enough (the bar)' },
  },
  params: {
    brief: { type: 'text', required: true, description: 'What it is meant to be: script, story, beat sheet, earlier notes' },
    focus: { type: 'text', description: 'Something to look at especially (a fix that was asked for)' },
    notes: { type: 'integer', min: 1, max: 12, default: 8, description: 'How many notes at most' },
    model: { type: 'string', default: REVIEW_MODEL, advanced: true, description: 'A Gemini model that takes video' },
  },
  async run(ctx) {
    const p = ctx.params;
    const files = (Array.isArray(ctx.inputs.video) ? ctx.inputs.video : [ctx.inputs.video]).filter(Boolean) as string[];
    if (!files.length) throw new GenError('Give the video');
    const ref = ctx.inputs.reference as string | undefined;
    ctx.step(`sending ${files.length + (ref ? 1 : 0)} video(s) to Gemini`);
    const parts: Record<string, unknown>[] = [];
    for (const [i, f] of files.entries()) {
      if (files.length > 1) parts.push({ text: `Take ${i}:` });
      parts.push(await mediaPart(f, ctx.signal));
    }
    if (ref) parts.push({ text: 'REFERENCE (the bar, not under review):' }, await mediaPart(ref, ctx.signal));
    parts.push({ text: reviewInstructions({ brief: String(p.brief), takes: files.length, reference: Boolean(ref), focus: p.focus, maxNotes: p.notes }) });
    ctx.step('watching');
    const r = await askJson({ parts, schema: REVIEW_SCHEMA, model: p.model }, ctx.signal);
    ctx.usage({ provider: 'gemini', unit: 'tokens', amount: Number(r.usage.totalTokenCount ?? 0), cost: costOf(r.model, r.usage), detail: r.model });
    const seconds = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', files[0]], { signal: ctx.signal }).catch(() => '')).trim()) || undefined;
    ctx.result({ ...settle(r.value, files.length, p.notes, seconds), seconds, model: r.model, bytes: files.reduce((n, f) => n + fs.statSync(f).size, 0) });
  },
};

/** The answer kept in bounds: scores 1-10, notes capped and ordered as given, asks from the list, best in range. */
export function settle(v: any, takes: number, maxNotes: number, seconds?: number) {
  const clamp = (x: unknown) => Math.max(1, Math.min(10, Number(x) || 1));
  // A time past the end is a guess: drop the note when it starts past the end, trim it when it runs past.
  const end = seconds && seconds > 0 ? seconds : Infinity;
  const notes = (Array.isArray(v?.notes) ? v.notes : []).map((n: any) => ({
    at: Math.max(0, Number(n?.at) || 0), to: n?.to === null || n?.to === undefined || !Number.isFinite(Number(n.to)) ? null : Math.min(end, Number(n.to)),
    ask: ASKS.includes(n?.ask) ? n.ask : 'redo', note: String(n?.note ?? '').slice(0, 800),
  })).filter((n: any) => n.note && n.at < end).slice(0, maxNotes);
  const best = takes > 1 && Number.isInteger(v?.best) && v.best >= 0 && v.best < takes ? v.best : takes > 1 ? 0 : null;
  return {
    pass: Boolean(v?.pass) && clamp(v?.score) >= 8, score: clamp(v?.score), summary: String(v?.summary ?? '').slice(0, 1200),
    scores: Object.fromEntries(ASPECTS.map((a) => [a, clamp(v?.scores?.[a])])), experience: String(v?.experience ?? '').slice(0, 2000),
    notes, best, ranking: Array.isArray(v?.ranking) ? v.ranking.slice(0, takes).map((x: any) => ({ take: Number(x?.take) || 0, score: clamp(x?.score), why: String(x?.why ?? '').slice(0, 400) })) : [],
  };
}
