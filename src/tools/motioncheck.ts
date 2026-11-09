// motion.check: measures a humanoid clip (a BVH) before anyone watches it, on Gen's own machine (free, no GPU).
// The same post/motion/check.py runs inside motion.from-text and motion.from-video on every take; this tool checks any
// BVH (a library clip, an upload, a take from an older job). Foot slide, ground penetration, pops, jitter, loop seam,
// travel. Judging motion means watching it move, never a still (J saw bad motion called good twice): this is the
// numbers half; library.judge on the preview video is the eyes half.

import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import path from 'node:path';

export const motionCheckTool: Tool = {
  id: 'motion.check',
  version: 1,
  title: 'Check a humanoid clip (foot slide, ground, pops, jitter)',
  description:
    'Measures a humanoid clip given as a BVH (from motion.from-text, motion.from-video or anywhere: SOMA, SMPL, Mixamo or classic bone names): how fast ' +
    'planted feet slide, how far feet sink below the ground, frames where a joint jumps, high-frequency shake, how well a loop closes and how far the ' +
    'hips travel. Returns { ok, problems, metrics, fix }. Free, on Gen itself, seconds. Pair it with library.judge on the preview video (judge motion ' +
    'moving, never from a still).',
  provider: 'local',
  output: 'json',
  inputs: {
    clip: { kind: 'file', required: true, description: 'The clip as a BVH (the bvh output of motion.from-text or motion.from-video).' },
  },
  params: {
    loop: { type: 'boolean', default: false, description: 'It should loop: also check the last pose meets the first.' },
    inPlace: { type: 'boolean', default: false, description: 'It should stay in place: flag travel of the hips.' },
  },
  async run(ctx) {
    const clip: string | undefined = ctx.inputs.clip;
    if (!clip) throw new GenError('Give the clip (a BVH)');
    if (path.extname(clip).toLowerCase() !== '.bvh') throw new GenError('clip must be a .bvh (the bvh output of motion.from-text or motion.from-video)');
    ctx.step('measuring the motion');
    const args = [clip, ...(ctx.params.loop ? ['--loop'] : []), ...(ctx.params.inPlace ? ['--in-place'] : [])];
    const out = await ctx.python(path.join('motion', 'check.py'), args);
    const line = out.trim().split('\n').pop() ?? '';
    let result: any;
    try { result = JSON.parse(line); } catch { throw new GenError(`The motion check printed something unexpected: ${line.slice(0, 300)}`); }
    if (!result.ok) ctx.log(`problems: ${result.problems.join('; ')}`);
    ctx.result(result);
  },
};
