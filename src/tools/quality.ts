// The quality checks as tools (docs/bench.md), so jobs, asset.make and the making loop can run them like anything else:
//   quality.identity   a face against a character's references (quality-identity.ts: CPU, free)
//   quality.checklist  the brief as yes/no questions, answered from the output
//   quality.assess     every check that applies, a pass or fail, and what to fix next try
// Inputs are files, so a job names library assets (`asset:<id>`) as usual. Claude's calls are reported as usage.

import type { RunContext, Tool } from './types.ts';
import { assess, checklist, meter, type AssessInput } from '../quality/index.ts';
import { usageOf } from '../providers/anthropic.ts';
import { kindOfFile, qualityIdentityTool } from './quality-identity.ts';

export { qualityIdentityTool };

const list = (v: unknown): string[] => ([] as string[]).concat((v as any) ?? []).filter((x) => typeof x === 'string');
const questionsOf = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);

function report(ctx: RunContext, calls: { model: string; usage: any; cost: number; billing: any }[]) {
  for (const c of calls) ctx.usage(usageOf({ model: c.model, usage: c.usage, cost: c.cost, billing: c.billing ?? 'api' }, `quality: ${c.model}`));
}

export const qualityChecklistTool: Tool = {
  id: 'quality.checklist',
  version: 1,
  title: 'Check an output against its brief',
  description: 'Turns a brief into 4 to 8 concrete yes/no questions ("Is she holding the lantern?", "Is it night?") and answers each from the output (a clip is judged from 4 frames), with a short reason each. The score is the share answered yes; 0.85 is the bar. Pass `questions` to ask your own. Pictures and clips only (a 3D model or a sound returns skipped).',
  provider: 'anthropic',
  output: 'json',
  inputs: {
    file: { kind: 'file', required: true, description: 'The output to check.' },
    refs: { kind: 'image', multiple: true, max: 3, description: 'Who or what should appear, for the judge to compare with.' },
  },
  params: {
    brief: { type: 'text', required: true, description: 'What the output should be, in words.' },
    kind: { type: 'enum', values: ['auto', 'image', 'video', 'mesh', 'audio'], default: 'auto', advanced: true },
    questions: { type: 'json', advanced: true, description: 'Your own yes/no questions instead of ones made from the brief.' },
  },
  async run(ctx) {
    const kind = kindOfFile(ctx.inputs.file, ctx.params.kind);
    ctx.step('asking the brief\'s questions');
    const { value, calls } = await meter(() => checklist({ brief: String(ctx.params.brief), kind, file: ctx.inputs.file, refs: list(ctx.inputs.refs), questions: questionsOf(ctx.params.questions) }));
    report(ctx, calls);
    ctx.log(`${value.answers.filter((a) => a.yes).length} of ${value.answers.length} yes`);
    ctx.result(value);
  },
};

export const qualityAssessTool: Tool = {
  id: 'quality.assess',
  version: 1,
  title: 'Check an output (every check)',
  description: 'Every check that applies to one output: face identity against the character references (pictures and clips), the brief as yes/no questions, the obvious faults for its kind (hands, melted faces, garbled text, blank frames and flicker; a 3D model\'s geometry and triangle budget; a sound\'s silence and clipping) and the match to a style board or a look in words. Returns a pass or fail and, when it fails, `fix`: what to change on the next try. This is what the making loop and Gen Bench run on every take.',
  provider: 'anthropic',
  output: 'json',
  inputs: {
    file: { kind: 'file', required: true, description: 'The output to check.' },
    identityRefs: { kind: 'image', multiple: true, max: 8, description: 'The character\'s reference pictures (none: identity isn\'t checked).' },
    styleRefs: { kind: 'image', multiple: true, max: 4, description: 'The style board.' },
  },
  params: {
    brief: { type: 'text', required: true, description: 'What the output should be, in words.' },
    kind: { type: 'enum', values: ['auto', 'image', 'video', 'mesh', 'audio'], default: 'auto', advanced: true },
    style: { type: 'string', description: 'The look in words (with or instead of a style board).' },
    questions: { type: 'json', advanced: true, description: 'Your own yes/no questions instead of ones made from the brief.' },
    thresholds: { type: 'json', advanced: true, description: '{ identity: 0.15, checklist: 0.85, style: 0.7 } by default.' },
  },
  async run(ctx) {
    const kind = kindOfFile(ctx.inputs.file, ctx.params.kind);
    const styleRefs = list(ctx.inputs.styleRefs);
    const words = typeof ctx.params.style === 'string' ? ctx.params.style.trim() : '';
    const input: AssessInput = {
      brief: String(ctx.params.brief), kind, file: ctx.inputs.file,
      identityRefs: list(ctx.inputs.identityRefs),
      ...(styleRefs.length || words ? { style: { refs: styleRefs, words } } : {}),
      questions: questionsOf(ctx.params.questions),
      thresholds: ctx.params.thresholds && typeof ctx.params.thresholds === 'object' ? ctx.params.thresholds : undefined,
    };
    ctx.step('checking');
    const { value, calls } = await meter(() => assess(input));
    report(ctx, calls);
    ctx.log(value.pass ? 'passed' : `failed: ${value.fix ?? ''}`);
    for (const e of value.errors ?? []) ctx.log(`could not check ${e}`);
    ctx.result(value);
  },
};

export const QUALITY_TOOLS: Tool[] = [qualityIdentityTool, qualityChecklistTool, qualityAssessTool];
