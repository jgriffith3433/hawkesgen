// Workflows as data. Each folder in workflows/ is a ComfyUI workflow that
// Hawkes Gen runs as a tool, with no code:
//
//   workflows/<name>/
//     workflow.json   the manifest: tool id, title, description, family, models
//                     (with download links), inputs and params (and which graph
//                     node fields they set), outputs
//     graph.json      the ComfyUI API graph
//     source.json     the original workflow it came from (template or upload)
//
// Import any ComfyUI template from the GPU servers' library, or any workflow J
// builds in ComfyUI (UI or API format), and draftManifest() works out the
// inputs (Load Image/Video/Audio), the prompts (traced to positive/negative),
// seeds, sizes, frame counts, steps and the save nodes. Edit the manifest to
// rename, describe or expose more fields; bump its version when results change.
//
// Models install on a GPU server the first time a job needs them.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';
import type { Tool, ParamSpec, InputSpec } from '../tools/types.ts';
import type { ApiGraph, ModelRef } from './convert.ts';
import { GenError } from '../util.ts';

export const WORKFLOWS_DIR = path.join(ROOT, 'workflows');

type Target = [string, string];
export type WfParam = ParamSpec & { targets: Target[] };
/**
 * bypass: when this optional input isn't given, these nodes ([node, field]) are skipped: whatever used their first output
 * gets what came into their `field` instead (a guide frame in a chain of guides). Without it, a missing optional input's
 * load nodes are removed and every link to them dropped (an optional reference slot). See pruneMissing (tool.ts).
 */
export type WfInput = InputSpec & { targets: Target[]; bypass?: Target[] };
export type Manifest = {
  id: string;
  version: number;
  title: string;
  description: string;
  family: string;
  output: Tool['output'];
  models: ModelRef[];
  inputs: Record<string, WfInput>;
  params: Record<string, WfParam>;
  /** Save nodes whose files come back. */
  outputs: string[];
  /** Where it came from: { template, comfyui } or { upload }. */
  source?: Record<string, unknown>;
  /** Rough GPU seconds per output (for estimates). */
  seconds?: number;
  /** Steps run on this PC after the GPU: "seamless" (adds seamless/blend params; tiles image outputs). */
  post?: string[];
  tags?: string[];
};

export type Workflow = { dir: string; manifest: Manifest; graph: ApiGraph };

const workflows = new Map<string, Workflow>();

export function loadWorkflows() {
  workflows.clear();
  if (!fs.existsSync(WORKFLOWS_DIR)) return workflows;
  for (const name of fs.readdirSync(WORKFLOWS_DIR)) {
    const dir = path.join(WORKFLOWS_DIR, name);
    const mf = path.join(dir, 'workflow.json');
    if (!fs.existsSync(mf)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(mf, 'utf8')) as Manifest;
      const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8')) as ApiGraph;
      validateManifest(manifest, graph);
      workflows.set(manifest.id, { dir, manifest, graph });
    } catch (e: any) {
      console.warn(`[workflows] skipping ${name}: ${e.message}`);
    }
  }
  return workflows;
}

export const listWorkflows = () => [...workflows.values()];
export const getWorkflow = (toolId: string) => workflows.get(toolId) ?? null;

export function validateManifest(m: Manifest, graph: ApiGraph) {
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(m.id)) throw new GenError(`Tool id "${m.id}" must look like area.name (e.g. image.upscale)`);
  for (const [kind, map] of [['input', m.inputs], ['param', m.params]] as const) {
    for (const [name, spec] of Object.entries<any>(map ?? {})) {
      for (const [nodeId, field] of spec.targets ?? []) {
        if (!graph[nodeId]) throw new GenError(`${kind} ${name} targets node ${nodeId}, which isn't in the graph`);
        if (!field) throw new GenError(`${kind} ${name} has a target without a field`);
      }
    }
  }
  for (const o of m.outputs ?? []) if (!graph[o]) throw new GenError(`output node ${o} isn't in the graph`);
  if (!m.outputs?.length) throw new GenError('A workflow needs at least one output node');
}

export function saveWorkflow(folder: string, manifest: Manifest, graph: ApiGraph, source?: unknown) {
  validateManifest(manifest, graph);
  const dir = path.join(WORKFLOWS_DIR, folder.replace(/[^a-z0-9._-]/gi, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph, null, 1));
  if (source !== undefined) fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify(source));
  workflows.set(manifest.id, { dir, manifest, graph });
  return dir;
}

// ------------------------------------------------------------------ drafts

const SAVE_KIND: Record<string, Tool['output']> = {
  SaveImage: 'image', SaveImageAdvanced: 'image', SaveImageWithAlpha: 'image', SaveAnimatedWEBP: 'image', SaveAnimatedPNG: 'image', SaveSVGNode: 'image',
  SaveVideo: 'video', SaveWEBM: 'video', DecodeAndSaveVideo: 'video',
  SaveAudio: 'audio', SaveAudioMP3: 'audio', SaveAudioOpus: 'audio', SaveAudioAdvanced: 'audio',
  SaveGLB: 'mesh', SaveGaussianSplat: 'mesh', SavePointCloud: 'mesh',
  SaveText: 'text',
};
const LOADERS: Record<string, { kind: InputSpec['kind']; field: string }> = {
  LoadImage: { kind: 'image', field: 'image' },
  LoadImageMask: { kind: 'image', field: 'image' },
  LoadImageOutput: { kind: 'image', field: 'image' },
  LoadVideo: { kind: 'video', field: 'file' },
  LoadAudio: { kind: 'audio', field: 'audio' },
};
const TEXT_FIELDS = ['text', 'prompt', 'positive_prompt', 'tags', 'lyrics', 'string', 'value'];
const NEG_FIELDS = ['negative_prompt', 'negative'];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'input';

/** Which node ids each node's outputs feed, and through which input name. */
function consumers(graph: ApiGraph) {
  const out = new Map<string, { node: string; input: string }[]>();
  for (const [nodeId, n] of Object.entries(graph)) {
    for (const [name, v] of Object.entries(n.inputs)) {
      if (Array.isArray(v) && typeof v[0] === 'string' && graph[v[0]]) {
        const list = out.get(v[0]) ?? [];
        list.push({ node: nodeId, input: name });
        out.set(v[0], list);
      }
    }
  }
  return out;
}

/** Does this node's output reach an input called "negative" before anything else decides? */
function polarity(graph: ApiGraph, cons: ReturnType<typeof consumers>, start: string): 'positive' | 'negative' | null {
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const c of cons.get(n) ?? []) {
      if (/^negative/.test(c.input)) return 'negative';
      if (/^(positive|conditioning|cond)$/.test(c.input) && /Sampler|Guider|ToVideo|InfiniteTalk/.test(graph[c.node].class_type)) return 'positive';
      queue.push(c.node);
    }
  }
  return null;
}

/**
 * A first manifest for a converted graph: the inputs, prompts, seed, size,
 * length, steps and outputs it can find. Good enough to run; edit it to polish.
 */
export function draftManifest(id: string, title: string, description: string, graph: ApiGraph, models: ModelRef[], objectInfo: Record<string, any>, extra: Partial<Manifest> = {}): Manifest {
  const cons = consumers(graph);
  const inputs: Record<string, WfInput> = {};
  const params: Record<string, WfParam> = {};
  const add = (name: string, spec: Omit<WfParam, 'targets'>, target: Target) => {
    const p = (params[name] ??= { ...spec, targets: [] } as WfParam);
    if (!p.targets.some(([a, b]) => a === target[0] && b === target[1])) p.targets.push(target);
  };
  const usedNames = new Set<string>();
  const ids = Object.keys(graph).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const nodeId of ids) {
    const n = graph[nodeId];
    const loader = LOADERS[n.class_type];
    if (loader) {
      const title0 = n._meta?.title ?? '';
      let name = title0 && !/^load (image|video|audio)/i.test(title0) ? slug(title0) : loader.kind;
      for (let k = 2; usedNames.has(name); k++) name = `${loader.kind}${k}`;
      usedNames.add(name);
      inputs[name] = { kind: loader.kind, required: true, description: title0 || undefined, targets: [[nodeId, loader.field]] };
    }
  }

  for (const nodeId of ids) {
    const n = graph[nodeId];
    const def = objectInfo[n.class_type];
    if (!def) continue;
    const specOf = (field: string) => def.input?.required?.[field] ?? def.input?.optional?.[field];
    for (const [field, value] of Object.entries(n.inputs)) {
      if (Array.isArray(value)) continue;
      const spec = specOf(field);
      if (!spec) continue;
      const [type, opts] = spec;
      if (type === 'STRING' && opts?.multiline && (TEXT_FIELDS.includes(field) || NEG_FIELDS.includes(field))) {
        const neg = NEG_FIELDS.includes(field) || (field !== 'lyrics' && polarity(graph, cons, nodeId) === 'negative');
        if (field === 'lyrics') add('lyrics', { type: 'text', default: value, description: 'Song lyrics.' }, [nodeId, field]);
        else if (field === 'tags') add('prompt', { type: 'text', required: true, default: value, description: 'What to make.' }, [nodeId, field]);
        else if (neg) add('negative', { type: 'text', default: value ?? '', advanced: true }, [nodeId, field]);
        else add('prompt', { type: 'text', required: true, default: value, description: 'What to make.' }, [nodeId, field]);
      } else if ((field === 'seed' || field === 'noise_seed') && type === 'INT') {
        add('seed', { type: 'integer', min: 0, max: 2 ** 48, description: 'Seed for the first output; the next ones count up. Random when empty.' }, [nodeId, field]);
      } else if ((field === 'width' || field === 'height') && type === 'INT' && /Empty|Latent|ToVideo|Image(Only)?Conditioning/.test(n.class_type)) {
        add(field, { type: 'integer', min: opts?.min ?? 64, max: Math.min(opts?.max ?? 4096, 4096), default: value }, [nodeId, field]);
      } else if (field === 'length' && type === 'INT' && /Latent|ToVideo/.test(n.class_type)) {
        add('frames', { type: 'integer', min: opts?.min ?? 1, max: Math.min(opts?.max ?? 1000, 1000), default: value, description: 'Frame count.' }, [nodeId, field]);
      } else if (field === 'seconds' && /Latent|Audio/.test(n.class_type)) {
        add('seconds', { type: 'number', min: opts?.min ?? 1, max: opts?.max ?? 600, default: value, description: 'Length in seconds.' }, [nodeId, field]);
      } else if (field === 'fps' && /CreateVideo|SaveVideo/.test(n.class_type)) {
        add('fps', { type: 'number', min: 1, max: 60, default: value }, [nodeId, field]);
      } else if (field === 'steps' && type === 'INT' && /Sampler|Scheduler/.test(n.class_type)) {
        add('steps', { type: 'integer', min: 1, max: 200, default: value, advanced: true }, [nodeId, field]);
      } else if (field === 'cfg' && type === 'FLOAT' && /Sampler|Guider/.test(n.class_type)) {
        add('cfg', { type: 'number', min: 0, max: 30, default: value, advanced: true }, [nodeId, field]);
      }
    }
  }
  // Primitive nodes (PrimitiveInt, PrimitiveStringMultiline...) usually hold the knobs a
  // template author meant to expose: name them by what they feed, or by their title.
  const CANON: Record<string, string> = { seed: 'seed', noise_seed: 'seed', width: 'width', height: 'height', length: 'frames', duration: 'seconds', seconds: 'seconds', fps: 'fps', frame_rate: 'fps', steps: 'steps', text: 'prompt', prompt: 'prompt', tags: 'prompt', lyrics: 'lyrics', cfg: 'cfg' };
  for (const nodeId of ids) {
    const n = graph[nodeId];
    if (!/^Primitive/.test(n.class_type) || !('value' in n.inputs) || Array.isArray(n.inputs.value)) continue;
    const fed = (cons.get(nodeId) ?? []).map((c) => c.input.split('.').pop()!).filter((f) => !/^(on_true|on_false|switch|string_[a-z]|[a-z])$/.test(f));
    const byInput = fed.map((f) => CANON[f]).find(Boolean);
    // "Int (Steps)" -> "Steps"; "Enable 4 Steps LoRA?" stays.
    const rawTitle = n._meta?.title ?? '';
    const title = /^(Int|Float|String|Boolean|Primitive)\b.*\(([^)]+)\)/i.exec(rawTitle)?.[2] ?? rawTitle;
    const generic = /^(primitive|int|float|string|boolean)\b/i.test(title);
    const value = n.inputs.value;
    const type: WfParam['type'] = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? (Number.isInteger(value) && !/Float/.test(n.class_type) ? 'integer' : 'number') : /Multiline/.test(n.class_type) ? 'text' : 'string';
    let name = byInput ?? (!generic && title ? (CANON[slug(title)] ?? slug(title)) : fed[0] ? slug(fed[0]) : `value_${slug(nodeId)}`);
    if (name === 'prompt' && polarity(graph, cons, nodeId) === 'negative') name = 'negative';
    // Two different knobs with one name (e.g. steps with and without a speed LoRA): keep them apart.
    if (params[name] && name !== 'seed' && params[name].default !== value) {
      let k = 2;
      while (params[`${name}_${k}`]) k++;
      name = `${name}_${k}`;
    }
    if (name === 'seed') add('seed', { type: 'integer', min: 0, max: 2 ** 48, description: 'Seed for the first output; the next ones count up. Random when empty.' }, [nodeId, 'value']);
    else add(name, { type, default: value, description: title && !generic ? title : undefined, ...(name === 'prompt' ? { required: true } : {}), ...(['steps', 'cfg'].includes(name) ? { advanced: true } : {}) }, [nodeId, 'value']);
  }
  for (const p of Object.values(params)) if (p.type === 'text' && typeof p.default !== 'string') p.default = '';
  // A required prompt has no default; the template's own prompt becomes the example.
  for (const p of Object.values(params)) {
    if (p.required && p.default !== undefined) {
      p.example = p.default;
      delete p.default;
    }
  }
  // The order the dashboard shows them in.
  const ORDER = ['prompt', 'lyrics', 'negative', 'width', 'height', 'frames', 'seconds', 'fps', 'seed', 'steps', 'cfg'];
  const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)));

  const outputs = ids.filter((k) => SAVE_KIND[graph[k].class_type] || (objectInfo[graph[k].class_type]?.output_node && !/Preview|ImageCompare/.test(graph[k].class_type)));
  const kinds = outputs.map((k) => SAVE_KIND[graph[k].class_type]).filter(Boolean);
  return {
    id,
    version: 1,
    title,
    description,
    family: extra.family ?? id,
    output: kinds[0] ?? 'file',
    models,
    inputs,
    params: sorted,
    outputs,
    ...extra,
  };
}
