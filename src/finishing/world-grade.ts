// The grade a job asks for (src/finishing/grade.ts): its `grade` param (a preset or settings), a LUT input, else the
// grade of the world it names. Shared by video.compose and video.grade.

import type { RunContext } from '../tools/types.ts';
import { getAsset } from '../library.ts';
import { gradeFromWorld, parseGrade, GRADE_PRESETS, type Grade } from './grade.ts';
import { worldFor } from './export.ts';

function worldOfJob(ctx: RunContext) {
  const id = typeof ctx.params.world === 'string' ? ctx.params.world : null;
  return id ? worldFor(ctx.job.project, id) : null;
}

/** A grade from the params: `grade` (an object or a preset name), else the world's own grade. LUT files resolved. */
export function resolveGrade(ctx: RunContext): Grade | null {
  const p = ctx.params;
  const lutInput = ctx.inputs.lut as string | undefined;
  let g: Grade | null = null;
  if (typeof p.grade === 'string' && GRADE_PRESETS[p.grade]) g = structuredClone(GRADE_PRESETS[p.grade]);
  else if (p.grade) g = parseGrade(p.grade);
  else {
    const w = worldOfJob(ctx);
    const lut = w?.look.grade?.lut ? getAsset(w.look.grade.lut)?.path ?? null : null;
    g = gradeFromWorld(w?.look ?? null, lut);
  }
  if (lutInput) g = { ...(g ?? {}), lutFile: lutInput };
  if (g && p.grain != null) g.grain = Number(p.grain);
  if (g && p.vignette != null) g.vignette = Number(p.vignette);
  if (!g && (p.grain || p.vignette)) g = { grain: Number(p.grain) || 0, vignette: Number(p.vignette) || 0 };
  return g;
}

/**
 * At submit (video.compose's admit): a job naming a world and no grade gets the world's grade settings as `grade`, so
 * the job's recipe says which grade made it and compose needs no library where it runs. The world's LUT is an asset:
 * the caller passes it as the lut input.
 */
export function worldGradeAtSubmit(params: Record<string, any>, project: string): Record<string, any> {
  if (params.grade || typeof params.world !== 'string') return params;
  const w = worldFor(project, params.world);
  const g = w?.look.grade;
  if (!g) return params;
  const settings = g.params ? { params: g.params, ...(g.params.grain != null ? { grain: g.params.grain } : {}), ...(g.params.vignette != null ? { vignette: g.params.vignette } : {}) } : null;
  return { ...params, ...(settings ? { grade: settings } : {}) };
}
