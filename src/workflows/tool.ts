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

// ------------------------------------------------------------------ every node setting
// A workflow's graph is more than its params: every node's own settings (a sampler's steps and scheduler, a LoRA's
// strength, a guide's frame, a decode's tile size) can be changed per job through the `nodes` param, keyed
// "<node>.<input>". Files, models, prompts and paths stay locked (a param or an input sets those); a setting a param
// already drives is changed through that param. src/knowledge.ts shows them to people and the AI.

export type NodeSetting = { key: string; node: string; class: string; title: string; input: string; value: unknown; type: 'number' | 'boolean' | 'string'; drivenBy: string | null; editable: boolean };
const LOCKED = /(file|image|video|audio|path|url|prefix|ckpt|lora_name|model|text|expression|encoder|device|unet|vae|clip_name|^format|codec)/i;
const OPEN_STRINGS = new Set(['sampler_name', 'scheduler']);

/** Every literal setting on the graph's nodes, which param drives it (if any), and whether `nodes` may change it. */
export function nodeSettings(wf: Workflow): NodeSetting[] {
  const driven = new Map<string, string>();
  for (const [name, p] of Object.entries(wf.manifest.params)) for (const [n, f] of p.targets) driven.set(`${n}.${f}`, name);
  for (const [name, i] of Object.entries(wf.manifest.inputs)) for (const [n, f] of i.targets) driven.set(`${n}.${f}`, `input:${name}`);
  const out: NodeSetting[] = [];
  for (const [node, n] of Object.entries(wf.graph as Record<string, any>)) {
    for (const [input, value] of Object.entries(n.inputs ?? {})) {
      if (Array.isArray(value) || value === null || typeof value === 'object') continue;
      const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : typeof value === 'string' ? 'string' : null;
      if (!type) continue;
      const key = `${node}.${input}`;
      const drivenBy = driven.get(key) ?? null;
      const fileish = type === 'string' && (/[\\/]|\.\w{2,12}$/.test(String(value)) || String(value).length > 80);
      const editable = !drivenBy && (type !== 'string' || OPEN_STRINGS.has(input) || (!LOCKED.test(input) && !fileish));
      out.push({ key, node, class: String(n.class_type ?? ''), title: String(n._meta?.title ?? n.class_type ?? node), input, value, type, drivenBy, editable });
    }
  }
  return out;
}

/** Writes a job's `nodes` overrides into the graph, refusing anything that isn't an editable setting of the right type. */
export function applyNodeOverrides(graph: Record<string, any>, overrides: unknown, settings: NodeSetting[]) {
  if (overrides == null) return;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('nodes: an object of "<node>.<input>": value');
  const by = new Map(settings.map((x) => [x.key, x]));
  for (const [key, v] of Object.entries(overrides as Record<string, unknown>)) {
    const s = by.get(key);
    if (!s) throw new Error(`nodes: ${key} is not a setting of this workflow`);
    if (!s.editable) throw new Error(`nodes: ${key} can't be changed here${s.drivenBy ? ` (use ${s.drivenBy.replace(/^input:/, 'the input ')})` : ' (files, models and prompts are locked)'}`);
    if (s.type === 'number' && !(typeof v === 'number' && Number.isFinite(v))) throw new Error(`nodes: ${key} takes a number`);
    if (s.type === 'boolean' && typeof v !== 'boolean') throw new Error(`nodes: ${key} takes true or false`);
    if (s.type === 'string' && !(typeof v === 'string' && v.length <= 80 && !/[\\/]/.test(v))) throw new Error(`nodes: ${key} takes a short word`);
    graph[s.node].inputs[s.input] = v;
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
  const settings = nodeSettings(wf);
  if (settings.some((x) => x.editable)) params.nodes = { type: 'json', advanced: true, description: 'Change any node\'s own settings: { "<node>.<input>": value } (GET /v1/knowledge/tools/<id> lists them).' };
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
      applyNodeOverrides(graph, ctx.params.nodes, settings);
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
