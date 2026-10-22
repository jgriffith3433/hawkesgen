// Turns a workflow folder into a Tool: uploads the inputs into their Load
// nodes, writes the params into their fields, installs missing models on the
// server, runs one graph per take (seeds counting up) and keeps every file the
// save nodes write.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool, ParamSpec } from '../tools/types.ts';
import type { Workflow } from './registry.ts';

/**
 * Takes an optional input that wasn't given out of a graph: its bypassed nodes hand their `field` input on to whatever
 * used their first output, then its load nodes and the bypassed ones are removed, and links to anything removed are
 * dropped (an optional slot like ref_audios.ref_audio_1 simply goes). Nodes left feeding only removed ones stay; ComfyUI
 * runs what the outputs need.
 */
export function pruneMissing(graph: Record<string, any>, spec: { targets: [string, string][]; bypass?: [string, string][] }) {
  const gone = new Set(spec.targets.map(([node]) => node));
  for (const [node, field] of spec.bypass ?? []) {
    const pass = graph[node]?.inputs?.[field];
    if (pass === undefined) continue;
    for (const n of Object.values(graph)) {
      for (const [k, v] of Object.entries(n.inputs ?? {})) {
        if (Array.isArray(v) && v.length === 2 && v[0] === node && v[1] === 0) n.inputs[k] = pass;
      }
    }
    gone.add(node);
  }
  for (const id of gone) delete graph[id];
  for (const n of Object.values(graph)) {
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && gone.has(v[0])) delete n.inputs[k];
    }
  }
}

export function workflowTool(wf: Workflow): Tool {
  const m = wf.manifest;
  const params: Record<string, ParamSpec> = {};
  for (const [name, p] of Object.entries(m.params)) {
    const { targets: _t, ...spec } = p;
    params[name] = spec;
  }
  params.count ??= { type: 'integer', min: 1, max: 8, default: 1, description: 'How many takes (one graph run each, seeds counting up).' };
  if (m.post?.includes('seamless')) {
    params.seamless = { type: 'boolean', default: false, description: 'Make image outputs tile seamlessly (textures).' };
    params.blend = { type: 'number', min: 0.05, max: 0.5, default: 0.25, description: 'How wide the seamless crossfade is.', advanced: true };
  }
  if (!m.params.seed) params.seed = { type: 'integer', min: 0, max: 2 ** 48, description: 'Not used by this workflow (it has no seed).', advanced: true };
  const inputs: Tool['inputs'] = {};
  for (const [name, i] of Object.entries(m.inputs)) {
    const { targets: _t, bypass: _b, ...spec } = i;
    inputs[name] = spec;
  }

  return {
    id: m.id,
    version: m.version,
    title: m.title,
    description: m.description,
    provider: 'comfy',
    family: m.family,
    output: m.output,
    inputs,
    params,
    models: () => m.models.map((x) => x.file),
    gpuSeconds: () => m.seconds ?? 30,
    workflow: { dir: path.basename(wf.dir), source: m.source ?? null, models: m.models, tags: m.tags ?? [] },
    async run(ctx) {
      const c = ctx.comfy!;
      if (m.models.length) await c.ensureModels(m.models);
      const graph = structuredClone(wf.graph);
      for (const [name, spec] of Object.entries(m.inputs)) {
        const files = ctx.inputs[name];
        if (!files) {
          if (!spec.required && spec.targets.length) pruneMissing(graph, spec);
          continue;
        }
        const list = Array.isArray(files) ? files : [files];
        ctx.step(`uploading ${name}`);
        const uploaded: string[] = [];
        for (const f of list) uploaded.push(await c.upload(f));
        spec.targets.forEach(([node, field], k) => (graph[node].inputs[field] = uploaded[Math.min(k, uploaded.length - 1)]));
      }
      for (const [name, p] of Object.entries(m.params)) {
        if (name === 'seed' || ctx.params[name] === undefined) continue;
        for (const [node, field] of p.targets) graph[node].inputs[field] = ctx.params[name];
      }
      for (const o of m.outputs) if ('filename_prefix' in graph[o].inputs) graph[o].inputs.filename_prefix = `hawkesgen/${ctx.job.project}/${m.id}`;

      const n = ctx.params.count ?? 1;
      const doneRuns = new Set(ctx.outputs.map((o) => o.seed)).size;
      for (let i = doneRuns; i < n; i++) {
        const seed = ctx.seed(i);
        for (const [node, field] of m.params.seed?.targets ?? []) graph[node].inputs[field] = seed;
        ctx.step(`${m.title}: take ${i + 1} of ${n}`);
        const files = await c.runGraph(graph);
        if (!files.length) throw new Error('The workflow finished without saving anything');
        for (const f of files) {
          let data = await c.download(f);
          const ext = path.extname(f.filename) || '.bin';
          if (ctx.params.seamless && /\.(png|jpe?g|webp)$/i.test(ext)) {
            const src = ctx.tmp(`raw-${seed}${ext}`);
            const out = ctx.tmp(`tiled-${seed}.png`);
            fs.writeFileSync(src, data);
            await ctx.python('texture.py', ['tile', src, out, String(ctx.params.blend ?? 0.25)]);
            data = fs.readFileSync(out);
          }
          await ctx.emit({ data, ext: ctx.params.seamless && /\.(jpe?g|webp)$/i.test(ext) ? '.png' : ext, seed, title: f.node ? graph[f.node]?._meta?.title : undefined, meta: { comfyName: f.filename, node: f.node } });
        }
      }
    },
  };
}
