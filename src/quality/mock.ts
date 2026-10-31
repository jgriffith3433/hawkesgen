// The quality checks without Python, ffmpeg or Claude (HAWKESGEN_QUALITY_MOCK=1, or setQualityMock(true) in tests and
// the bench's mock runs): the same shapes, with scores made from a hash of the file and the question, so a run repeats
// exactly and still spreads over passes and failures. Never used for a real verdict.

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ChecklistResult, FaultResult, IdentityResult, OutputKind, StyleResult } from './index.ts';

let forced: boolean | null = null;
/** Turns mock checks on or off for this process (null: follow HAWKESGEN_QUALITY_MOCK). */
export function setQualityMock(on: boolean | null) { forced = on; }
const scope = new AsyncLocalStorage<boolean>();
/** Mock checks for this work only (a mock bench run beside real checks in the same service). */
export const withQualityMock = <T>(work: () => Promise<T>) => scope.run(true, work);
export const qualityMock = () => forced ?? scope.getStore() ?? process.env.HAWKESGEN_QUALITY_MOCK === '1';

/** A number in [0, 1) from the file's bytes (or its name when it can't be read) and some words. */
export function unit(file: string, salt: string): number {
  let body: Buffer | string = file;
  try { body = fs.readFileSync(file); } catch { /* a name is enough to be stable */ }
  const h = crypto.createHash('sha256').update(body).update('\0' + salt).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

/** A brief split into the things it asks for, as yes/no questions (4 to 8). */
export function mockQuestions(brief: string, kind: OutputKind): string[] {
  const parts = brief.split(/[.;,]| and | with | while /i).map((s) => s.trim().replace(/^(a|an|the)\s+/i, '')).filter((s) => s.length > 3);
  const qs = parts.slice(0, 6).map((p) => `Does it show ${p.charAt(0).toLowerCase()}${p.slice(1)}?`);
  const pad = kind === 'audio' ? ['Is the sound clean, without clicks or distortion?', 'Does it fit the brief’s mood?']
    : kind === 'mesh' ? ['Is the model a single clean object?', 'Does its shape read clearly from the front?']
    : ['Is the main subject clearly visible?', 'Is it free of obvious faults?'];
  for (const p of pad) if (qs.length < 4) qs.push(p);
  while (qs.length < 4) qs.push(`Does it match the brief (${qs.length + 1})?`);
  return qs.slice(0, 8);
}

export function mockChecklist(file: string, questions: string[]): ChecklistResult {
  const answers = questions.map((q) => {
    const yes = unit(file, q) > 0.12;
    return { q, yes, why: yes ? 'Mock: looks right.' : 'Mock: not visible in the frames.' };
  });
  return { score: answers.length ? answers.filter((a) => a.yes).length / answers.length : 1, answers };
}

export function mockIdentity(file: string, kind: 'image' | 'video', refs: string[]): IdentityResult {
  const n = kind === 'video' ? 8 : 1;
  const base = 0.06 + unit(file, 'identity:' + refs.join('|')) * 0.2;
  const perFrame = Array.from({ length: n }, (_, i) => Math.round((base + (unit(file, `frame${i}`) - 0.5) * 0.04) * 10000) / 10000);
  const m = perFrame.reduce((s, x) => s + x, 0) / n;
  const spread = Math.sqrt(perFrame.reduce((s, x) => s + (x - m) ** 2, 0) / n);
  return { distance: Math.round(m * 10000) / 10000, perFrame, spread: Math.round(spread * 10000) / 10000, faces: n, frames: n };
}

export function mockFaults(file: string, kind: OutputKind): FaultResult {
  const u = unit(file, 'faults:' + kind);
  const fault = kind === 'mesh' ? 'Mock: holes in the mesh' : kind === 'audio' ? 'Mock: clipping' : 'Mock: an extra finger on the left hand';
  return u > 0.88 ? { ok: false, faults: [fault] } : { ok: true, faults: [] };
}

export function mockStyle(file: string): StyleResult {
  const score = Math.round((0.6 + unit(file, 'style') * 0.38) * 100) / 100;
  return { score, why: score >= 0.7 ? 'Mock: close to the look.' : 'Mock: the palette is off.' };
}
