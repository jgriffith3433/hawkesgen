// Turns a ComfyUI workflow as the editor saves it (the "UI" format: nodes with
// widgets_values, links, subgraphs, reroutes, primitives, bypassed nodes) into
// the API format the server runs (node id -> class_type + inputs). This is the
// conversion ComfyUI's frontend does on "Queue" / "Export (API)", done here so
// any template or any workflow J builds in ComfyUI can become a Hawkes Gen tool.
//
// Needs the server's node definitions (/object_info) to know which inputs are
// widgets and in what order their values are stored.
//
// Handles: subgraphs (nested too; promoted widgets keep the inner value unless
// the instance input is linked), Reroute, PrimitiveNode, bypassed nodes (mode 4:
// inputs pass through to outputs of the same type), muted nodes (mode 2: dropped),
// notes, seed "control after generate" values, and pruning everything that
// doesn't feed an output node.

export type ApiGraph = Record<string, { class_type: string; inputs: Record<string, any>; _meta?: { title?: string } }>;
export type ModelRef = { file: string; dir: string; url: string };

type UiNode = { id: number | string; type: string; mode?: number; title?: string; inputs?: any[]; outputs?: any[]; widgets_values?: any; properties?: any };
type Link = { id: number; origin_id: number | string; origin_slot: number; target_id: number | string; target_slot: number; type?: string };
type Scope = { prefix: string; nodes: Map<string, UiNode>; links: Map<string, Link>; def: any | null; parent: Scope | null; instance: UiNode | null };
type Source = { ref: [string, number] } | { value: unknown } | null;

const VIRTUAL = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode']);
const CONTROL = new Set(['fixed', 'increment', 'decrement', 'randomize']);
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

function toLink(l: any): Link {
  return Array.isArray(l) ? { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] } : l;
}

/** Is this input spec a widget (a value saved in widgets_values) rather than a link? */
export function isWidget(spec: any) {
  const [type, opts] = spec;
  if (opts?.forceInput || opts?.rawLink) return false;
  if (Array.isArray(type) || WIDGET_TYPES.has(type) || type === 'COMFY_DYNAMICCOMBO_V3' || opts?.widgetType) return true;
  // A widget with no socket (ImageCropV2's crop_region, a BOUNDING_BOX; ImageCropToMask's background, a COLOR) is saved in
  // widgets_values like any other. Dropping it made ComfyUI use its default: mesh.views3d cropped the same top-left
  // 512x512 corner of the sheet for all four views (2026-10-23).
  if (opts?.socketless) return true;
  // Another type the frontend draws as a widget (an editor: CreateBoundingBoxes' editor_state) has a real default value;
  // link types (IMAGE, MASK...) have none, or null.
  if (typeof type === 'string' && opts && opts.default !== undefined && opts.default !== null && !type.includes(',')) return true;
  // A type that accepts several primitives ("FLOAT,INT": LTXVEmptyLatentAudio's frame_rate) is still a widget; missing it
  // shifts every later widget value (batch_size got the frame rate, 25, and the sampler failed).
  return typeof type === 'string' && type.includes(',') && type.split(',').every((t) => WIDGET_TYPES.has(t.trim()));
}

/** The widget inputs of a node type, in the order their values are saved (dynamic sub-inputs not expanded). */
export function widgetInputs(def: any): { name: string; spec: any; control: boolean }[] {
  const out: { name: string; spec: any; control: boolean }[] = [];
  const order = def.input_order ?? { required: Object.keys(def.input?.required ?? {}), optional: Object.keys(def.input?.optional ?? {}) };
  for (const group of ['required', 'optional'] as const) {
    for (const name of order[group] ?? []) {
      const spec = def.input?.[group]?.[name];
      if (!spec || !isWidget(spec)) continue;
      const control = (spec[0] === 'INT' && (spec[1]?.control_after_generate || name === 'seed' || name === 'noise_seed')) as boolean;
      out.push({ name, spec, control });
    }
  }
  return out;
}

/**
 * Widget name -> saved value, for a UI node. Dynamic combos (V3) save the
 * chosen option and then that option's own widgets, which the API names with
 * dots ("format", "format.codec", "format.codec.crf").
 */
function widgetValues(node: UiNode, def: any): Record<string, unknown> {
  const wv = node.widgets_values;
  if (wv && !Array.isArray(wv)) return { ...wv };
  const values = Array.isArray(wv) ? wv : [];
  const out: Record<string, unknown> = {};
  let i = 0;
  const walk = (inputs: { name: string; spec: any; control: boolean }[], prefix: string) => {
    for (const w of inputs) {
      if (i >= values.length) return;
      const key = `${prefix}${w.name}`;
      const v = values[i++];
      out[key] = v;
      if (w.control && typeof values[i] === 'string' && CONTROL.has(values[i])) i++;
      const opts = w.spec[1] ?? {};
      // Upload widgets save the button's value right after the file name.
      if ((opts.image_upload || opts.video_upload || opts.audio_upload || opts.upload) && typeof values[i] === 'string' && ['image', 'video', 'audio', 'file'].includes(values[i])) i++;
      if (w.spec[0] === 'COMFY_DYNAMICCOMBO_V3') {
        const option = (opts.options ?? []).find((o: any) => o.key === v);
        if (option) walk(widgetInputs({ input: option.inputs ?? {} }), `${key}.`);
      }
    }
  };
  walk(widgetInputs(def), '');
  return out;
}

export type ConvertResult = { graph: ApiGraph; models: ModelRef[]; problems: string[]; titles: Record<string, string> };

export function convertUiWorkflow(wf: any, objectInfo: Record<string, any>): ConvertResult {
  // Already in API format?
  if (!Array.isArray(wf.nodes) && Object.values(wf).every((n: any) => n && typeof n === 'object' && 'class_type' in n)) {
    return { graph: wf, models: [], problems: [], titles: Object.fromEntries(Object.entries<any>(wf).map(([k, n]) => [k, n._meta?.title ?? n.class_type])) };
  }
  const defs = new Map<string, any>((wf.definitions?.subgraphs ?? []).map((s: any) => [s.id, s]));
  const problems: string[] = [];
  const models = new Map<string, ModelRef>();
  const graph: ApiGraph = {};
  const titles: Record<string, string> = {};

  const makeScope = (nodes: UiNode[], links: any[], def: any, parent: Scope | null, instance: UiNode | null, prefix: string): Scope => ({
    prefix, def, parent, instance,
    nodes: new Map(nodes.map((n) => [String(n.id), n])),
    links: new Map((links ?? []).map(toLink).map((l) => [String(l.id), l])),
  });
  const children = new Map<Scope, Map<string, Scope>>();
  const childScope = (scope: Scope, node: UiNode) => {
    let m = children.get(scope);
    if (!m) children.set(scope, (m = new Map()));
    let c = m.get(String(node.id));
    if (!c) {
      const def = defs.get(node.type)!;
      c = makeScope(def.nodes, def.links, def, scope, node, `${scope.prefix}${node.id}:`);
      m.set(String(node.id), c);
    }
    return c;
  };

  const seen = new Set<string>();
  function resolveLink(scope: Scope, linkId: unknown): Source {
    if (linkId === null || linkId === undefined) return null;
    const l = scope.links.get(String(linkId));
    if (!l) return null;
    return resolveOutput(scope, l.origin_id, l.origin_slot);
  }

  function resolveOutput(scope: Scope, nodeId: number | string, slot: number): Source {
    const key = `${scope.prefix}${nodeId}#${slot}`;
    if (seen.has(key)) return null; // a cycle through reroutes or bypasses
    seen.add(key);
    try {
      // The subgraph's input node: go out to the instance's input in the parent.
      if (String(nodeId) === '-10' && scope.def && scope.instance && scope.parent) {
        const defInput = scope.def.inputs?.[slot];
        const name = defInput?.name;
        const inp = (scope.instance.inputs ?? []).find((i: any) => i.name === name);
        if (inp?.link != null) return resolveLink(scope.parent, inp.link);
        // A promoted widget: its value is saved on the instance, in the order of the subgraph's widget inputs.
        const wv = scope.instance.widgets_values;
        if (wv && !Array.isArray(wv) && name in wv) return { value: (wv as any)[name] };
        if (Array.isArray(wv) && wv.length) {
          // A subgraph input is a promoted widget when the instance shows it as one, or when the
          // instance has no slot for it and it is a widget type. Values are saved in that order.
          const instInputs = scope.instance.inputs ?? [];
          const widgetIns = (scope.def.inputs ?? []).filter((i: any) => {
            const slot = instInputs.find((x: any) => x.name === i.name);
            return slot ? Boolean(slot.widget) : WIDGET_TYPES.has(i.type);
          });
          const k = widgetIns.findIndex((i: any) => i.name === name);
          // Only trust the order when the counts line up; otherwise keep the inner widget's own value.
          if (k >= 0 && widgetIns.length === wv.length) return { value: wv[k] };
        }
        return null;
      }
      const node = scope.nodes.get(String(nodeId));
      if (!node) return null;
      if (node.mode === 2) return null;
      if (node.mode === 4) {
        // Bypassed (a subgraph too): an input of the same type passes straight through.
        const type = node.outputs?.[slot]?.type;
        const inputs = node.inputs ?? [];
        const same = inputs[slot]?.type === type ? inputs[slot] : inputs.find((i: any) => i.type === type && i.link != null);
        return same ? resolveLink(scope, same.link) : null;
      }
      if (defs.has(node.type)) {
        const child = childScope(scope, node);
        const out = child.def.outputs?.[slot];
        const linkId = out?.linkIds?.[0];
        return linkId === undefined ? null : resolveLink(child, linkId);
      }
      if (node.type === 'Reroute') return resolveLink(scope, node.inputs?.[0]?.link);
      if (node.type === 'PrimitiveNode') {
        const v = Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined;
        return v === undefined ? null : { value: v };
      }
      return { ref: [`${scope.prefix}${node.id}`, slot] };
    } finally {
      seen.delete(key);
    }
  }

  function emit(scope: Scope) {
    for (const node of scope.nodes.values()) {
      if (node.mode === 2 || node.mode === 4 || VIRTUAL.has(node.type)) continue;
      for (const m of node.properties?.models ?? []) {
        if (m?.name && m?.url && m?.directory) models.set(`${m.directory}/${m.name}`, { file: m.name, dir: m.directory, url: m.url });
      }
      if (defs.has(node.type)) {
        emit(childScope(scope, node));
        continue;
      }
      const def = objectInfo[node.type];
      if (!def) {
        problems.push(`${node.type} (node ${scope.prefix}${node.id}) is not installed on the server`);
        continue;
      }
      const flatId = `${scope.prefix}${node.id}`;
      const inputs: Record<string, any> = widgetValues(node, def);
      for (const inp of node.inputs ?? []) {
        const name = inp.widget?.name ?? inp.name;
        if (inp.link === null || inp.link === undefined) continue;
        const src = resolveLink(scope, inp.link);
        if (src && 'ref' in src) inputs[name] = src.ref;
        else if (src && 'value' in src) inputs[name] = src.value;
        else if (!inp.widget) delete inputs[name];
      }
      graph[flatId] = { class_type: node.type, inputs, _meta: { title: node.title ?? def.display_name ?? node.type } };
      titles[flatId] = node.title ?? def.display_name ?? node.type;
    }
  }

  emit(makeScope(wf.nodes, wf.links, null, null, null, ''));

  // Outputs: files we can collect. Previews and comparisons are for the editor;
  // they become saves only when a workflow has nothing else.
  for (const n of Object.values(graph)) {
    if (n.class_type === 'Save3DAdvanced') {
      n.class_type = 'SaveGLB';
      n.inputs = { mesh: n.inputs.model_3d, filename_prefix: n.inputs.filename_prefix ?? '3d/hawkesgen' };
    }
  }
  const isPreview = (t: string) => /Preview|ImageCompare/.test(t);
  let roots = Object.entries(graph).filter(([, n]) => objectInfo[n.class_type]?.output_node && !isPreview(n.class_type)).map(([k]) => k);
  if (!roots.length) {
    const swap: Record<string, [string, string]> = { PreviewImage: ['SaveImage', 'images'], PreviewAudio: ['SaveAudio', 'audio'] };
    for (const [k, n] of Object.entries(graph)) {
      if (n.class_type === 'MaskPreview') {
        graph[`${k}:image`] = { class_type: 'MaskToImage', inputs: { mask: n.inputs.mask }, _meta: { title: 'Mask to image' } };
        graph[k] = { class_type: 'SaveImage', inputs: { images: [`${k}:image`, 0], filename_prefix: 'hawkesgen/mask' }, _meta: n._meta };
        roots.push(k);
        continue;
      }
      const to = swap[n.class_type];
      if (!to) continue;
      graph[k] = { class_type: to[0], inputs: { [to[1]]: n.inputs[to[1]], filename_prefix: 'hawkesgen/preview' }, _meta: n._meta };
      roots.push(k);
    }
  }

  // Keep only what feeds an output node.
  const keep = new Set<string>();
  const visit = (nodeId: string) => {
    if (keep.has(nodeId) || !graph[nodeId]) return;
    keep.add(nodeId);
    for (const v of Object.values(graph[nodeId].inputs)) if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && graph[v[0]]) visit(v[0]);
  };
  for (const nodeId of roots) visit(nodeId);
  for (const nodeId of Object.keys(graph)) if (!keep.has(nodeId)) delete graph[nodeId];
  if (!keep.size) problems.push('The workflow has no output node (SaveImage, SaveVideo, SaveAudio, SaveGLB...)');

  // Only models the kept nodes actually name.
  const named = new Set<string>();
  for (const n of Object.values(graph)) for (const v of Object.values(n.inputs)) if (typeof v === 'string') named.add(v);
  const used = [...models.values()].filter((m) => named.has(m.file));
  return { graph, models: used, problems, titles };
}

/**
 * Checks an API graph against node definitions without a server: unknown
 * nodes, missing required inputs, inputs a node doesn't take, and combo values
 * that aren't allowed (model files are reported separately, as they can be
 * installed).
 */
export function checkGraph(graph: ApiGraph, objectInfo: Record<string, any>) {
  const problems: string[] = [];
  const missingModels = new Set<string>();
  for (const [nodeId, node] of Object.entries(graph)) {
    const def = objectInfo[node.class_type];
    if (!def) {
      problems.push(`node ${nodeId}: ${node.class_type} is not installed`);
      continue;
    }
    for (const [name, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number' && !graph[v[0]]) problems.push(`node ${nodeId} (${node.class_type}): ${name} comes from node ${v[0]}, which is missing`);
    }
    const required = def.input?.required ?? {};
    const optional = def.input?.optional ?? {};
    const keys = Object.keys(node.inputs);
    for (const [name, spec] of Object.entries<any>(required)) {
      if (name in node.inputs || keys.some((k) => k.startsWith(`${name}.`))) continue;
      const [type, opts] = spec;
      if (Array.isArray(type) || (opts && 'default' in opts) || type === 'COMFY_AUTOGROW_V3') continue;
      problems.push(`node ${nodeId} (${node.class_type}): missing ${name}`);
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      const root = name.split('.')[0];
      const spec = required[name] ?? optional[name];
      if (!spec) {
        const rootSpec = required[root] ?? optional[root];
        if (name.includes('.') && rootSpec && /^COMFY_(DYNAMICCOMBO|AUTOGROW)_V3$/.test(rootSpec[0])) continue;
        if (!def.input?.hidden?.[name]) problems.push(`node ${nodeId} (${node.class_type}): no input called ${name}`);
        continue;
      }
      // Example files in the template; real runs replace them with uploads.
      if (spec[1]?.image_upload || spec[1]?.video_upload || spec[1]?.audio_upload || spec[1]?.upload) continue;
      const choices = Array.isArray(spec[0]) ? spec[0] : spec[0] === 'COMBO' ? spec[1]?.options : null;
      if (choices && choices.length && typeof value === 'string' && !choices.includes(value)) {
        if (/\.(safetensors|ckpt|pt|pth|onnx|gguf|bin|sft)$/i.test(value)) missingModels.add(value);
        else problems.push(`node ${nodeId} (${node.class_type}): ${name} "${value}" is not an option`);
      }
    }
  }
  return { problems, missingModels: [...missingModels] };
}
