// The checks a vision model answers (docs/bench.md): the brief as yes/no questions and their answers per output, the
// match to a look, and the obvious faults a picture shows. Every call goes through src/providers/anthropic.ts ask() on a
// Sonnet-class model with few frames (the roadmap's "keep the checks cheap"), so a customer's job runs on its own Claude
// like any other. Tests swap the asker (setQualityAsk) and never call Claude.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChecklistAnswer, ChecklistResult, OutputKind, StyleResult } from './index.ts';
import { framesOf, scratch } from './media.ts';
import { mockChecklist, mockQuestions, mockStyle, qualityMock } from './mock.ts';

/** The model the checks use. */
export const JUDGE_MODEL = 'claude-sonnet-5-5';
/** Frames a video is judged from. */
export const JUDGE_FRAMES = 4;

export type AskFn = (p: { prompt: string; system?: string; images?: string[]; model?: string; effort?: string; maxTokens?: number; schema?: Record<string, unknown> }) =>
  Promise<{ text: string; model: string; usage?: any; cost?: number; billing?: any }>;

let asker: AskFn | null = null;
/** Replaces Claude for the quality checks (tests); null restores it. */
export function setQualityAsk(fn: AskFn | null) { asker = fn; }

/** Every Claude call a check made inside meter(): what tools report as usage and the bench as cost. */
const calls = new AsyncLocalStorage<{ calls: { model: string; usage: any; cost: number; billing: any }[] }>();
export async function meter<T>(work: () => Promise<T>): Promise<{ value: T; calls: { model: string; usage: any; cost: number; billing: any }[] }> {
  const box = { calls: [] as { model: string; usage: any; cost: number; billing: any }[] };
  const value = await calls.run(box, work);
  return { value, calls: box.calls };
}

async function askJson(p: Parameters<AskFn>[0]): Promise<any> {
  const fn: AskFn = asker ?? (async (q) => (await import('../providers/anthropic.ts')).ask(q as any));
  const r = await fn({ model: JUDGE_MODEL, effort: 'low', maxTokens: 4000, ...p });
  calls.getStore()?.calls.push({ model: r.model, usage: r.usage ?? null, cost: Number(r.cost ?? 0), billing: r.billing ?? null });
  try {
    return JSON.parse(r.text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(r.text);
    if (m) return JSON.parse(m[0]);
    throw new Error(`The judge's answer wasn't JSON: ${r.text.slice(0, 200)}`);
  }
}

const KIND_WORDS: Record<OutputKind, string> = {
  image: 'a picture', video: 'a video clip (you will see a few frames from it, in order)', mesh: 'a 3D model', audio: 'a sound file',
};

/** The words before a brief's questions: the rules the questions follow. */
export const QUESTION_RULES = [
  'Turn the brief into concrete yes/no questions a viewer can answer by looking at the output alone.',
  'Each question checks one thing the brief asks for: who or what is there, what they wear or hold, the action, the setting, the time of day, the framing, any text.',
  'Phrase them so that "yes" means the brief was followed. No questions about quality or taste, no compound questions.',
  'Between 4 and 8 questions, the most important first.',
].join(' ');

export function cleanQuestions(list: unknown): string[] {
  const qs = (Array.isArray(list) ? list : []).map((q) => String(q ?? '').trim()).filter((q) => q.length > 3).map((q) => (q.endsWith('?') ? q : `${q}?`));
  return [...new Set(qs)].slice(0, 8);
}

export async function questionsForImpl(brief: string, kind: OutputKind): Promise<string[]> {
  if (!brief.trim()) return [];
  if (qualityMock()) return mockQuestions(brief, kind);
  const r = await askJson({
    system: QUESTION_RULES,
    prompt: `The output is ${KIND_WORDS[kind]}.\n\nBrief:\n${brief}\n\nAnswer as JSON: {"questions": ["..."]}`,
    schema: { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 8 } } },
  });
  return cleanQuestions(r?.questions);
}

/** The share of questions answered yes (1 when there were none). */
export const yesShare = (answers: ChecklistAnswer[]) => (answers.length ? Math.round((answers.filter((a) => a.yes).length / answers.length) * 1000) / 1000 : 1);

/** The judge's answers matched back to the questions asked, in order (a missing answer counts as no). */
export function matchAnswers(questions: string[], got: unknown): ChecklistAnswer[] {
  const list = Array.isArray(got) ? got : [];
  return questions.map((q, i) => {
    // By the question, else by position when that answer isn't another question's.
    const at = list[i] as any;
    const a = list.find((x: any) => String(x?.q ?? '').trim() === q) ?? (at && !questions.includes(String(at?.q ?? '').trim()) ? at : undefined);
    return { q, yes: a?.yes === true, why: String(a?.why ?? (a ? '' : 'Not answered.')).slice(0, 240) };
  });
}

async function seeable<T>(a: { kind: OutputKind; file: string }, work: (images: string[]) => Promise<T>): Promise<T> {
  const s = scratch();
  try {
    const images = a.kind === 'image' || a.kind === 'video' ? await framesOf(a.file, a.kind, JUDGE_FRAMES, s.dir) : [];
    return await work(images);
  } finally {
    s.done();
  }
}

export async function checklistImpl(a: { brief: string; kind: OutputKind; file: string; refs?: string[]; questions?: string[] }): Promise<ChecklistResult> {
  if (a.kind !== 'image' && a.kind !== 'video' && !qualityMock()) {
    // The judge can't see a 3D model or hear a sound: nothing is claimed (the faults check measures those).
    return { score: 1, answers: [], skipped: `A ${a.kind === 'mesh' ? '3D model' : 'sound'} can't be judged by looking; its faults are measured instead.` };
  }
  const questions = a.questions?.length ? cleanQuestions(a.questions) : await questionsForImpl(a.brief, a.kind);
  if (!questions.length) return { score: 1, answers: [] };
  if (qualityMock()) return mockChecklist(a.file, questions);
  return seeable(a, async (frames) => {
    const refs = (a.refs ?? []).slice(0, 3);
    const r = await askJson({
      system: 'You check generated media against its brief. Answer each question strictly from what is visible: when something cannot be seen, the answer is no. One short reason each.',
      images: [...frames, ...refs],
      prompt: [
        `The first ${frames.length} image${frames.length > 1 ? 's are' : ' is'} ${KIND_WORDS[a.kind]}.`,
        refs.length ? `The last ${refs.length} ${refs.length > 1 ? 'are references' : 'is a reference'} for who or what should appear (not the output).` : '',
        `\nBrief:\n${a.brief}\n\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
        '\nAnswer as JSON: {"answers": [{"q": "<the question, exactly>", "yes": true|false, "why": "<one short reason>"}]} in the same order.',
      ].join('\n'),
      schema: {
        type: 'object', additionalProperties: false, required: ['answers'],
        properties: { answers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'yes', 'why'], properties: { q: { type: 'string' }, yes: { type: 'boolean' }, why: { type: 'string' } } } } },
      },
    });
    const answers = matchAnswers(questions, r?.answers);
    return { score: yesShare(answers), answers };
  });
}

/** A 0-10 grade (or a 0-1 share) as a share, clamped. */
export const asShare = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n > 1 ? n / 10 : n)) * 100) / 100;
};

export async function styleScoreImpl(a: { kind: OutputKind; file: string; refs?: string[]; words?: string }): Promise<StyleResult> {
  if (qualityMock()) return mockStyle(a.file);
  if (a.kind !== 'image' && a.kind !== 'video') return { score: 1, why: `A ${a.kind === 'mesh' ? '3D model' : 'sound'}'s look isn't judged yet.` };
  if (!a.refs?.length && !a.words?.trim()) return { score: 1, why: 'No look to match.' };
  return seeable(a, async (frames) => {
    const refs = (a.refs ?? []).slice(0, 4);
    const r = await askJson({
      system: 'You are an art director checking whether generated media matches a world\'s look: palette, lighting, rendering style, texture, lens and mood. Not the content or the subject. Grade 0 to 10 (10: indistinguishable from the style board; 7: clearly the same look with small drift; 4: a different look). One sentence on what is off, if anything.',
      images: [...frames, ...refs],
      prompt: [
        `The first ${frames.length} image${frames.length > 1 ? 's are' : ' is'} the output.`,
        refs.length ? `The last ${refs.length} ${refs.length > 1 ? 'are' : 'is'} the style board.` : '',
        a.words?.trim() ? `The look in words: ${a.words.trim()}` : '',
        '\nAnswer as JSON: {"grade": 0-10, "why": "<one sentence>"}',
      ].filter(Boolean).join('\n'),
      schema: { type: 'object', additionalProperties: false, required: ['grade', 'why'], properties: { grade: { type: 'number' }, why: { type: 'string' } } },
    });
    return { score: asShare(r?.grade), why: String(r?.why ?? '').slice(0, 300) };
  });
}

/** What the vision check looks for, per kind. */
export const FAULT_LIST: Record<'image' | 'video', string[]> = {
  image: [
    'hands with extra, missing, fused or bent-backwards fingers',
    'a melted, smeared, doubled or asymmetric face; eyes looking different ways',
    'extra or missing limbs; bodies merging into each other or into objects',
    'garbled, misspelled or nonsense text and lettering',
    'obvious seams, tiling, smears or a broken patch in the picture',
  ],
  video: [
    'hands with extra, missing, fused or bent-backwards fingers in any frame',
    'a face that melts, smears, doubles or changes into someone else between frames',
    'limbs or bodies that merge, appear or vanish between frames',
    'garbled or nonsense text and lettering',
    'a broken frame: a smear, a blank or corrupted frame, a sudden jump to a different picture',
  ],
};

export async function visualFaults(a: { kind: 'image' | 'video'; file: string }): Promise<string[]> {
  return seeable(a, async (frames) => {
    const r = await askJson({
      system: 'You find obvious generation faults in media, the kind any viewer would notice at a glance. Report only clear faults, not taste or small imperfections. An empty list is the usual answer for a good result.',
      images: frames,
      prompt: [
        `${frames.length > 1 ? `These ${frames.length} frames are from one video clip, in order.` : 'This is a generated picture.'}`,
        `Look for:\n${FAULT_LIST[a.kind].map((f) => `- ${f}`).join('\n')}`,
        '\nAnswer as JSON: {"faults": ["<what and where, in a few words>"]}',
      ].join('\n'),
      schema: { type: 'object', additionalProperties: false, required: ['faults'], properties: { faults: { type: 'array', items: { type: 'string' }, maxItems: 6 } } },
    });
    return (Array.isArray(r?.faults) ? r.faults : []).map((f: unknown) => String(f).trim()).filter(Boolean).slice(0, 6);
  });
}
