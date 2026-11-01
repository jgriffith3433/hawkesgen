// Quality checks every AI-made output passes before a person sees it (docs/worlds-roadmap.md, Phases 0-2).
//
// This file is the contract the bench, the making loop, identity and the showrunner share. The signatures are fixed
// (fields added since are optional). The checks live beside it: identity.ts (insightface on the CPU), judge.ts (the
// questions, their answers and the look, by a vision model), faults.ts, media.ts (frames, Python, ffmpeg) and mock.ts
// (HAWKESGEN_QUALITY_MOCK=1: the same shapes without Python, ffmpeg or Claude). docs/bench.md.
//
//   identity   ArcFace cosine distance from each face in a picture (or a video's frames) to a character's references
//   checklist  the brief as yes/no questions, answered by a vision model per output
//   faults     the obvious failures per kind (extra fingers, melted faces, garbled text, flicker, broken meshes)
//   style      how well an output matches a world's look
//   assess     all of the above for one output, with a pass/fail and a fix to try when it fails

import { identityScoreImpl } from './identity.ts';
import { checklistImpl, questionsForImpl, styleScoreImpl } from './judge.ts';
import { faultCheckImpl } from './faults.ts';

export { setQualityMock, qualityMock, withQualityMock } from './mock.ts';
export { setQualityAsk, meter, JUDGE_MODEL } from './judge.ts';

export type OutputKind = 'image' | 'video' | 'mesh' | 'audio';

export type IdentityResult = {
  /** Mean cosine distance to the references (lower is closer; real video scores about 0.08). Null when no face was found. */
  distance: number | null;
  /** Per checked frame (one entry for a picture). */
  perFrame: number[];
  /** Standard deviation of perFrame: how steady the identity is. */
  spread: number;
  /** Faces found in the candidate. */
  faces: number;
  /** Frames checked (1 for a picture). */
  frames?: number;
  /** Faces found in the references (0: the references show no face, so nothing could be compared). */
  refFaces?: number;
};
export type ChecklistAnswer = { q: string; yes: boolean; why: string };
export type ChecklistResult = {
  score: number;
  answers: ChecklistAnswer[];
  /** Why nothing was asked (a 3D model or a sound can't be judged by looking): the score is then 1 and claims nothing. */
  skipped?: string;
};
export type FaultResult = { ok: boolean; faults: string[] };
export type StyleResult = { score: number; why: string };

export type Thresholds = { identity: number; checklist: number; style: number };
export const DEFAULT_THRESHOLDS: Thresholds = { identity: 0.15, checklist: 0.85, style: 0.7 };

export type QualityReport = {
  identity?: IdentityResult;
  checklist?: ChecklistResult;
  faults?: FaultResult;
  style?: StyleResult;
  pass: boolean;
  /** When it fails: what to change on the next try, in words the making loop turns into a new prompt or settings. */
  fix?: string;
  /** Checks that couldn't run (no Python, no face models, Claude unavailable). They don't fail the output: they measured nothing. */
  errors?: string[];
};

export type AssessInput = {
  brief: string;
  kind: OutputKind;
  /** Local path of the output. */
  file: string;
  /** Local paths of the character references a face must match (none: identity isn't checked). */
  identityRefs?: string[];
  /** Local paths of the world's style board, or words describing the look. */
  style?: { refs?: string[]; words?: string };
  /** Questions to ask instead of ones made from the brief. */
  questions?: string[];
  thresholds?: Partial<Thresholds>;
};

/** Face identity of a candidate against reference pictures. */
export async function identityScore(candidate: { file: string; kind: 'image' | 'video' }, refs: string[], opts?: { frames?: number; signal?: AbortSignal; python?: (script: string, args: string[]) => Promise<string> }): Promise<IdentityResult> {
  return identityScoreImpl(candidate, refs, opts);
}

/** The yes/no questions a brief turns into ("Is she holding the lantern?", "Is it night?"). */
export async function questionsFor(brief: string, kind: OutputKind): Promise<string[]> {
  return questionsForImpl(brief, kind);
}

/** The questions answered for one output (videos are judged from a few frames). */
export async function checklist(a: { brief: string; kind: OutputKind; file: string; refs?: string[]; questions?: string[] }): Promise<ChecklistResult> {
  return checklistImpl(a);
}

/** The obvious failures for the output's kind. */
export async function faultCheck(a: { kind: OutputKind; file: string }): Promise<FaultResult> {
  return faultCheckImpl(a);
}

/** How well an output matches a look. */
export async function styleScore(a: { kind: OutputKind; file: string; refs?: string[]; words?: string }): Promise<StyleResult> {
  return styleScoreImpl(a);
}

/** Whether each check passes its threshold (a check that didn't run passes: it measured nothing). */
export function verdicts(r: Pick<QualityReport, 'identity' | 'checklist' | 'faults' | 'style'>, t: Thresholds = DEFAULT_THRESHOLDS) {
  return {
    identity: r.identity?.distance == null || r.identity.distance <= t.identity,
    checklist: !r.checklist || r.checklist.score >= t.checklist,
    faults: !r.faults || r.faults.ok,
    style: !r.style || r.style.score >= t.style,
  };
}

const HINTS: [RegExp, string][] = [
  [/finger|hand/i, 'Keep hands out of frame or holding something simple, and add "deformed hands, extra fingers" to the negative.'],
  [/face|melt|doubl/i, 'Frame the face larger, keep the motion slower, and give the character sheet as a reference.'],
  [/text|letter/i, 'Leave text out of the generation and add it afterwards as a title.'],
  [/flicker|blank|broken/i, 'Try another seed, and for a video fewer frames or less motion.'],
  [/triangle|budget/i, 'Ask for a lower-detail model, or use its level of detail.'],
  [/silen|clip|loud/i, 'Trim the silence and normalize the loudness (audio post-processing).'],
];

/** One sentence (or a few short ones) on what to change next try, from what failed. Empty when everything passed. */
export function fixFor(r: Pick<QualityReport, 'identity' | 'checklist' | 'faults' | 'style'>, t: Thresholds = DEFAULT_THRESHOLDS): string {
  const v = verdicts(r, t);
  const parts: string[] = [];
  if (!v.identity && r.identity?.distance != null) {
    const drifts = r.identity.spread > 0.05;
    parts.push(`The face is off-model (distance ${r.identity.distance.toFixed(2)}, needs ${t.identity.toFixed(2)} or less${drifts ? ', and it drifts between frames' : ''}): give the character's sheet as a reference, paste their fixed description unchanged, and ask to match the reference face${drifts ? '; shorten the shot or lower the motion' : ''}.`);
  }
  if (!v.checklist && r.checklist) {
    const missed = r.checklist.answers.filter((a) => !a.yes).map((a) => a.q.replace(/\?$/, ''));
    if (missed.length) parts.push(`Not following the brief: ${missed.slice(0, 4).map((m) => `"${m}" was no`).join('; ')}. Say each of these plainly, first, in the prompt.`);
  }
  if (!v.faults && r.faults?.faults.length) {
    const f = r.faults.faults.slice(0, 3).join('; ');
    const hint = HINTS.find(([re]) => re.test(f))?.[1];
    parts.push(`Faults: ${f}.${hint ? ` ${hint}` : ''}`);
  }
  if (!v.style && r.style) parts.push(`Off the look (${Math.round(r.style.score * 100)}%${r.style.why ? `: ${r.style.why.replace(/\.$/, '')}` : ''}): give the style board as references and repeat the world's style line.`);
  return parts.join(' ');
}

/** Every check that applies to one output, and whether it passes. */
export async function assess(a: AssessInput): Promise<QualityReport> {
  const t = { ...DEFAULT_THRESHOLDS, ...a.thresholds };
  const errors: string[] = [];
  const soft = <T>(name: string, p: Promise<T> | undefined): Promise<T | undefined> =>
    p ? p.catch((e) => { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); return undefined; }) : Promise.resolve(undefined);
  const [identity, list, faults, style] = await Promise.all([
    soft('identity', a.identityRefs?.length && (a.kind === 'image' || a.kind === 'video') ? identityScore({ file: a.file, kind: a.kind }, a.identityRefs) : undefined),
    soft('checklist', checklist({ brief: a.brief, kind: a.kind, file: a.file, questions: a.questions, refs: a.identityRefs })),
    soft('faults', faultCheck({ kind: a.kind, file: a.file })),
    soft('style', a.style ? styleScore({ kind: a.kind, file: a.file, ...a.style }) : undefined),
  ]);
  const parts = { ...(identity ? { identity } : {}), ...(list ? { checklist: list } : {}), ...(faults ? { faults } : {}), ...(style ? { style } : {}) };
  const v = verdicts(parts, t);
  const pass = v.identity && v.checklist && v.faults && v.style;
  const fix = pass ? '' : fixFor(parts, t);
  return { ...parts, pass, ...(fix ? { fix } : {}), ...(errors.length ? { errors } : {}) };
}
