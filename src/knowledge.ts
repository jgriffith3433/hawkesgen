// What Gen knows about its tools, for people and the AI (J, 2026-10-29: "having knowledge of how models, workflows, and
// helper nodes and all parameters in the nodes all work together and what people have done to keep iterating on them
// ... expose all that in a way that's useful and not overwhelming to both the user and the AI").
//
// A tool's card joins three sources:
//  - the tool itself (src/tools/index.ts describeTool): params, inputs, outputs, family
//  - for a ComfyUI workflow, its folder (workflows/<dir>): the models it loads, every node in its graph, every literal
//    setting on those nodes, which param or input drives which node, and which settings `nodes` may change
//    (src/workflows/tool.ts nodeSettings)
//  - the craft notes in knowledge/tools.json: what it's for, what each input is in the picture, how the settings pull
//    on each other, what people change when a result is wrong, what it pairs with
// The app shows the card under "How it works" in Create and in Details; the AI editor and director read `toolMap`, a
// compact line per tool, and the full card of the tools a turn touches.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';
import { TOOLS, getTool, describeTool } from './tools/index.ts';
import { getWorkflow } from './workflows/registry.ts';
import { nodeSettings } from './workflows/tool.ts';
import { withMeasured } from './make/feedback.ts';

export type Notes = { role?: string; inputs?: Record<string, string>; settings?: Record<string, string>; iterate?: string[]; pairsWith?: string[]; measured?: boolean };

const NOTES_FILE = path.join(ROOT, 'knowledge', 'tools.json');
let cache: { mtime: number; notes: Record<string, Notes> } | null = null;

/** The craft notes (knowledge/tools.json), read again when the file changes. */
export function notes(): Record<string, Notes> {
  try {
    const mtime = fs.statSync(NOTES_FILE).mtimeMs;
    if (!cache || cache.mtime !== mtime) {
      const raw = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
      delete raw._about;
      cache = { mtime, notes: raw };
    }
    // With the measured notes the owner approved from the making loop's learning (src/make/feedback.ts).
    return withMeasured(cache.notes);
  } catch {
    return {};
  }
}

/** One tool's card: everything a person or the AI needs to use it well. Null for an unknown tool. */
export function toolCard(id: string) {
  const t = getTool(id);
  if (!t) return null;
  const d = describeTool(t);
  const n = notes()[id] ?? {};
  const wf = getWorkflow(id);
  const settings = wf ? nodeSettings(wf) : [];
  const graph: Record<string, any> = wf?.graph ?? {};
  const where = (targets: [string, string][] = []) => targets.map(([node, input]) => ({ node, input, class: String(graph[node]?.class_type ?? ''), title: String(graph[node]?._meta?.title ?? graph[node]?.class_type ?? node) }));
  const params = Object.fromEntries(Object.entries(d.params ?? {}).map(([k, p]: [string, any]) => [k, {
    ...p, ...(n.settings?.[k] ? { note: n.settings[k] } : {}), ...(wf?.manifest.params[k] ? { drives: where(wf.manifest.params[k].targets) } : {}),
  }]));
  const inputs = Object.fromEntries(Object.entries(d.inputs ?? {}).map(([k, i]: [string, any]) => [k, {
    ...i, ...(n.inputs?.[k] ? { note: n.inputs[k] } : {}), ...(wf?.manifest.inputs[k] ? { feeds: where(wf.manifest.inputs[k].targets) } : {}),
  }]));
  // The graph node by node, in the file's order, each with its settings.
  const nodes = wf ? Object.entries(graph).map(([node, g]) => ({
    node, class: String(g.class_type ?? ''), title: String(g._meta?.title ?? g.class_type ?? node),
    settings: settings.filter((s) => s.node === node).map((s) => ({ key: s.key, input: s.input, value: s.value, type: s.type, drivenBy: s.drivenBy, editable: s.editable, ...(n.settings?.[s.key] ? { note: n.settings[s.key] } : {}) })),
  })) : [];
  return {
    id, title: d.title, description: d.description, family: d.family, provider: d.provider, output: d.output,
    role: n.role ?? null, iterate: n.iterate ?? [], pairsWith: (n.pairsWith ?? []).filter((x) => getTool(x)), measured: n.measured ?? null,
    models: wf?.manifest.models.map((m: any) => ({ file: m.file, dir: m.dir })) ?? [],
    inputs, params, nodes,
    editable: settings.filter((s) => s.editable).length,
    source: wf?.manifest.source ?? null,
  };
}

const short = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The tool map for the AI: one line per tool (what it's for, its inputs and what they are, its main settings), so it can
 * plan chains across every tool and workflow this Gen has, new ones included. `only` limits it to those tools.
 */
export function toolMap(only?: (id: string) => boolean): string {
  const lines: string[] = [];
  for (const t of TOOLS) {
    if (only && !only(t.id)) continue;
    const n = notes()[t.id] ?? {};
    const ins = Object.entries(t.inputs ?? {}).map(([k, i]: [string, any]) => `${k}${i.required ? '' : '?'}:${i.kind}${i.multiple ? '[]' : ''}${n.inputs?.[k] ? ` (${short(n.inputs[k], 60)})` : ''}`);
    const ps = Object.entries(t.params ?? {}).filter(([k, p]: [string, any]) => !p.advanced && !['count', 'seed', 'provider', 'nodes'].includes(k)).slice(0, 8)
      .map(([k, p]: [string, any]) => `${k}${p.required ? '*' : ''}${p.default !== undefined ? `=${short(JSON.stringify(p.default), 16)}` : ''}`);
    const wf = getWorkflow(t.id);
    const nodes = wf ? nodeSettings(wf).filter((s) => s.editable).length : 0;
    lines.push(`- ${t.id}: ${short(n.role ?? t.description, 170)}${ins.length ? ` | in: ${ins.join(', ')}` : ''}${ps.length ? ` | params: ${ps.join(', ')}` : ''}${nodes ? ` | +${nodes} node settings` : ''}${n.pairsWith?.length ? ` | pairs: ${n.pairsWith.join(', ')}` : ''}`);
  }
  return lines.join('\n');
}

/** The full craft of a few tools for the AI: the notes on settings, what to change when a result is wrong, the node settings it may use. */
export function toolCraft(ids: string[]): string {
  const out: string[] = [];
  for (const id of [...new Set(ids)].slice(0, 6)) {
    const c = toolCard(id);
    if (!c) continue;
    const settingNotes = Object.entries(c.params).filter(([, p]: [string, any]) => p.note).map(([k, p]: [string, any]) => `  ${k}: ${p.note}`);
    const nodeNotes = c.nodes.flatMap((nd) => nd.settings.filter((s) => s.editable).map((s) => `  nodes["${s.key}"] (${nd.title} ${s.input}, now ${JSON.stringify(s.value)})${(s as any).note ? `: ${(s as any).note}` : ''}`));
    out.push(`${id}${c.role ? `: ${c.role}` : ''}\n${settingNotes.join('\n')}${c.iterate.length ? `\n  when it's wrong: ${c.iterate.join(' ')}` : ''}${nodeNotes.length ? `\n  node settings (params.nodes):\n${nodeNotes.slice(0, 30).join('\n')}` : ''}`);
  }
  return out.join('\n\n');
}
