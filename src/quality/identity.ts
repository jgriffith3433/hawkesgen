// Face identity (docs/bench.md, "Identity"): ArcFace cosine distance from the best-matching face in each checked frame
// to a character's references, with insightface's buffalo_l on the CPU (post/quality/identity.py). Pure (no database),
// so the CPU suite's service can run it too.

import type { IdentityResult } from './index.ts';
import { framesOf, lastJson, runPython, scratch } from './media.ts';
import { mockIdentity, qualityMock } from './mock.ts';

/** Frames sampled from a video for identity: about 8, spread over the clip. */
export const IDENTITY_FRAMES = 8;

/** The standard deviation of a list (0 for fewer than two). */
export function spreadOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}

/** The script's answer as the contract's shape (with how many frames were checked). */
export function identityFromScript(r: any): IdentityResult {
  const perFrame = Array.isArray(r?.perFrame) ? r.perFrame.map(Number).filter(Number.isFinite) : [];
  const distance = typeof r?.distance === 'number' && Number.isFinite(r.distance) ? r.distance : null;
  return {
    distance,
    perFrame,
    spread: Math.round(spreadOf(perFrame) * 10000) / 10000,
    faces: Number(r?.faces ?? 0) || 0,
    frames: Number(r?.frames ?? perFrame.length) || 0,
    ...(typeof r?.refFaces === 'number' ? { refFaces: r.refFaces } : {}),
  };
}

export type IdentityOpts = { frames?: number; signal?: AbortSignal; python?: (script: string, args: string[]) => Promise<string> };

export async function identityScoreImpl(candidate: { file: string; kind: 'image' | 'video' }, refs: string[], o: IdentityOpts = {}): Promise<IdentityResult> {
  if (!refs.length) return { distance: null, perFrame: [], spread: 0, faces: 0 };
  if (qualityMock()) return mockIdentity(candidate.file, candidate.kind, refs);
  const s = scratch();
  try {
    const frames = await framesOf(candidate.file, candidate.kind, o.frames ?? IDENTITY_FRAMES, s.dir, o.signal);
    const args = ['--refs', ...refs, '--frames', ...frames];
    const out = o.python ? await o.python('quality/identity.py', args) : await runPython('quality/identity.py', args, o.signal);
    return identityFromScript(lastJson(out));
  } finally {
    s.done();
  }
}
