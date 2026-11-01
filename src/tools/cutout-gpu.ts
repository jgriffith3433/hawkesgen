// Remove background on a GPU server (J, 2026-11-01: "Yes.. do that", run it on the GPU workers instead of BiRefNet on
// CPU). BiRefNet needs about 8.5 GB of memory on a CPU (post/cutout.py) and beta Gen's machine has 4 GB, so there it fell
// back to the lighter ISNet. On a GPU it needs a few GB and a second or two.
//
// image.cutout hands a BiRefNet call to image.cutout-gpu at submit (Tool.route) when a GPU provider can take it now:
// RunPod, Modal or a Cloud Run GPU service in settings.gpu (src/providers/gpu/route.ts). The AWS fleet doesn't count (a
// cutout would wait for a server to start). The GPU makes the mask with the image.remove-background workflow's graph;
// glow, crop and pad then run here in post/cutout.py --mask, so the result matches image.cutout's. When the GPU run
// fails for any other reason than "this provider can't take it now" (which moves the job to the next provider), the
// cutout is made here on the CPU instead (ISNet where BiRefNet won't fit), and the job log says so.
// HAWKESGEN_CUTOUT_GPU=0 keeps every cutout on the CPU.

import fs from 'node:fs';
import type { Tool } from './types.ts';
import { cutoutTool } from './local.ts';
import { env, loadSettings } from '../config.ts';
import { getWorkflow } from '../workflows/registry.ts';
import { loadServiceMap } from '../providers/cloudrun/services.ts';
import { gpuCandidates } from '../providers/gpu/route.ts';

export const CUTOUT_GPU = 'image.cutout-gpu';
const WORKFLOW = 'image.remove-background';
const FAMILY = 'birefnet';

/** Modes the GPU makes: BiRefNet's mask (glow works from it). ISNet and union stay on the CPU (ISNet is light there). */
const gpuMode = (params: Record<string, any>) => (params.mode ?? 'birefnet') === 'birefnet';

/** Why a cutout stays on the CPU, or null when a GPU provider can take it now. `deps` are for tests. */
export function cutoutStaysLocal(params: Record<string, any>, deps: { settings?: ReturnType<typeof loadSettings>; map?: ReturnType<typeof loadServiceMap> | null; get?: (k: string) => string | undefined } = {}): string | null {
  const get = deps.get ?? env;
  if (get('HAWKESGEN_CUTOUT_GPU') === '0') return 'HAWKESGEN_CUTOUT_GPU=0';
  if (!gpuMode(params)) return `mode ${params.mode} runs on the CPU`;
  if (!getWorkflow(WORKFLOW)) return `the ${WORKFLOW} workflow isn't loaded`;
  let settings, map;
  try {
    settings = deps.settings ?? loadSettings();
    map = deps.map !== undefined ? deps.map : loadServiceMap();
  } catch (e: any) {
    return `no GPU settings: ${e.message}`;
  }
  const { choices, skipped } = gpuCandidates({ family: FAMILY, params, labels: {} }, cutoutGpuTool, settings, map, Date.now(), get);
  if (choices.some((c) => c.kind === 'service')) return null;
  return `no GPU provider can take it now (${skipped.join('; ') || 'only the fleet'})`;
}

/** image.cutout's route: the GPU when a provider can take it, else stay on the CPU. */
export const routeCutout = (params: Record<string, any>) => (cutoutStaysLocal(params) ? null : CUTOUT_GPU);

const passOn = (e: any, ctx: { signal: AbortSignal }) => ctx.signal.aborted || e?.message === 'Cancelled' || e?.unavailable || e?.overLimit;

export const cutoutGpuTool: Tool = {
  id: CUTOUT_GPU,
  version: 1,
  title: 'Cut out the subject (GPU)',
  description: 'image.cutout with BiRefNet on a GPU server: the same result (crop, pad, glow), a second or two instead of up to a minute. image.cutout sends BiRefNet calls here when a GPU provider is up.',
  provider: 'comfy',
  family: FAMILY,
  output: 'image',
  inputs: cutoutTool.inputs,
  params: cutoutTool.params,
  models: () => (getWorkflow(WORKFLOW)?.manifest.models ?? []).map((m) => m.file),
  gpuSeconds: () => 3,
  async run(ctx) {
    const wf = getWorkflow(WORKFLOW);
    const c = ctx.comfy!;
    const out = ctx.tmp('cutout.png');
    const local = ['--mode', ctx.params.mode, '--pad', String(ctx.params.pad)];
    if (ctx.params.glow) local.push('--glow');
    if (!ctx.params.crop) local.push('--no-crop');
    let maskFile: string | null = null;
    let seconds = 0;
    try {
      if (!wf) throw new Error(`the ${WORKFLOW} workflow isn't loaded`);
      const t0 = Date.now();
      ctx.step('cutting out with BiRefNet on the GPU');
      if (wf.manifest.models.length) await c.ensureModels(wf.manifest.models);
      const graph = structuredClone(wf.graph) as Record<string, any>;
      // Only the mask comes back: the cutout itself is made here, so crop, pad and glow match image.cutout.
      for (const [id, n] of Object.entries(graph)) if (n.class_type === 'SaveImage' && id !== '20') delete graph[id];
      delete graph.cut;
      delete graph.inv;
      graph['20'].inputs.filename_prefix = `hawkesgen/${ctx.job.project}/${CUTOUT_GPU}`;
      const [node, field] = wf.manifest.inputs.image.targets[0];
      graph[node].inputs[field] = await c.upload(ctx.inputs.image);
      const files = await c.runGraph(graph);
      if (!files.length) throw new Error('the GPU finished without a mask');
      maskFile = ctx.tmp('mask.png');
      fs.writeFileSync(maskFile, await c.download(files.find((f) => f.node === '20') ?? files[0]));
      seconds = Math.round((Date.now() - t0) / 100) / 10;
      ctx.log(`BiRefNet mask made on the GPU (${c.server.id}) in ${seconds} s, with any cold start and model download`);
    } catch (e: any) {
      if (passOn(e, ctx)) throw e;
      ctx.log(`the GPU couldn't make the mask (${e.message}); cutting out here on the CPU instead`);
      ctx.step('cutting out on the CPU');
      maskFile = null;
    }
    const args = [ctx.inputs.image, out, ...local, ...(maskFile ? ['--mask', maskFile] : [])];
    const info = JSON.parse((await ctx.python('cutout.py', args)).trim().split('\n').pop() || '{}');
    if (maskFile) Object.assign(info, { model: 'birefnet', gpu: true, seconds });
    else if (info.fallback) ctx.log(info.fallback);
    await ctx.emit({ data: fs.readFileSync(out), ext: '.png', meta: info });
    ctx.result(info);
  },
};
