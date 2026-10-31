// Quality checks every AI-made output passes before a person sees it (docs/worlds-roadmap.md, Phases 0-2).
//
// This file is the contract the bench, the making loop, identity and the showrunner share. The signatures are fixed;
// the bench work (Phase 0) replaces the placeholder bodies. Until then every check passes and measures nothing, so
// callers can be built and tested against it.
//
//   identity   ArcFace cosine distance from each face in a picture (or a video's frames) to a character's references
//   checklist  the brief as yes/no questions, answered by a vision model per output
//   faults     the obvious failures per kind (extra fingers, melted faces, garbled text, flicker, broken meshes)
//   style      how well an output matches a world's look
//   assess     all of the above for one output, with a pass/fail and a fix to try when it fails

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
};
export type ChecklistAnswer = { q: string; yes: boolean; why: string };
export type ChecklistResult = { score: number; answers: ChecklistAnswer[] };
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
export async function identityScore(_candidate: { file: string; kind: 'image' | 'video' }, _refs: string[]): Promise<IdentityResult> {
  return { distance: null, perFrame: [], spread: 0, faces: 0 };
}

/** The yes/no questions a brief turns into ("Is she holding the lantern?", "Is it night?"). */
export async function questionsFor(_brief: string, _kind: OutputKind): Promise<string[]> {
  return [];
}

/** The questions answered for one output (videos are judged from a few frames). */
export async function checklist(_a: { brief: string; kind: OutputKind; file: string; refs?: string[]; questions?: string[] }): Promise<ChecklistResult> {
  return { score: 1, answers: [] };
}

/** The obvious failures for the output's kind. */
export async function faultCheck(_a: { kind: OutputKind; file: string }): Promise<FaultResult> {
  return { ok: true, faults: [] };
}

/** How well an output matches a look. */
export async function styleScore(_a: { kind: OutputKind; file: string; refs?: string[]; words?: string }): Promise<StyleResult> {
  return { score: 1, why: '' };
}

/** Every check that applies to one output, and whether it passes. */
export async function assess(a: AssessInput): Promise<QualityReport> {
  const t = { ...DEFAULT_THRESHOLDS, ...a.thresholds };
  const [identity, list, faults, style] = await Promise.all([
    a.identityRefs?.length && (a.kind === 'image' || a.kind === 'video') ? identityScore({ file: a.file, kind: a.kind }, a.identityRefs) : undefined,
    checklist({ brief: a.brief, kind: a.kind, file: a.file, questions: a.questions }),
    faultCheck({ kind: a.kind, file: a.file }),
    a.style ? styleScore({ kind: a.kind, file: a.file, ...a.style }) : undefined,
  ]);
  const pass = (identity?.distance == null || identity.distance <= t.identity) && list.score >= t.checklist && faults.ok && (!style || style.score >= t.style);
  return { ...(identity ? { identity } : {}), checklist: list, faults, ...(style ? { style } : {}), pass };
}
