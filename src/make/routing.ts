// Routing as data (knowledge/routing.json, docs/make.md): which tool makes what, with fallbacks, the cheap preview's
// params and the default thresholds. Read again when the file changes, checked like knowledge/tools.json
// (test/make.test.ts checks every tool, param and input it names is real).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';
import { GenError } from '../util.ts';
import type { Thresholds } from '../quality/index.ts';
import type { MakeIntent, MakeRequest } from './index.ts';
import { withApprovedRouting } from './feedback.ts';

export type When = {
  depth?: boolean; dialogue?: boolean; sound?: boolean; refs?: boolean; lora?: boolean;
  people?: { min?: number; max?: number }; seconds?: { min?: number; max?: number };
};
export type Rule = { when?: When; tools: string[]; why?: string };
export type ToolRoute = {
  kind: 'image' | 'video' | 'mesh' | 'audio';
  /** The param the brief goes in (null: the tool takes no words). */
  prompt: string | null;
  /** Inputs identity references fill, in order. */
  refs?: string[];
  /** The cheap version's params, merged over the final's (null: no preview, the final is made straight away). */
  preview: Record<string, unknown> | null;
  steps?: string; strength?: string; negative?: string;
  /** The tool's input filled from a request input of another name: { start: "image" }. */
  inputs?: Record<string, string>;
  paid?: boolean;
};
export type RoutingData = {
  defaults: { thresholds: Thresholds; previews: number; heroCandidates: number; maxRetries: number };
  tools: Record<string, ToolRoute>;
  intents: Record<string, Rule[]>;
};

/** What the router knows about the request and about this Gen. Everything is optional: the request fills the rest. */
export type RouteContext = {
  depth?: boolean; dialogue?: boolean; sound?: boolean; people?: number; seconds?: number; lora?: boolean;
  /** Paid partner models may be routed to (the request and the owner both allow it). */
  allowPaid?: boolean;
  /** This Gen has the tool. */
  has?: (tool: string) => boolean;
  /** The tool can run now (false while the SSH fleet is down for a tool that needs it). */
  ready?: (tool: string) => boolean;
  /** The tool's inputs, to skip one whose required inputs the request can't fill. */
  inputsOf?: (tool: string) => Record<string, { required?: boolean }> | null;
  /** Tools to leave out (one that just failed with a provider error). */
  exclude?: string[];
  /** Routing data instead of the file (tests). */
  data?: RoutingData;
};

const FILE = path.join(ROOT, 'knowledge', 'routing.json');
let cache: { mtime: number; data: RoutingData } | null = null;

export function routingFile() {
  return FILE;
}

/** knowledge/routing.json, read again when it changes, with the owner's approved routing changes on top. */
export function routing(): RoutingData {
  return withApprovedRouting(routingRaw());
}

/** knowledge/routing.json as it is in the file. */
export function routingRaw(): RoutingData {
  const mtime = fs.statSync(FILE).mtimeMs;
  if (!cache || cache.mtime !== mtime) {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    delete raw._about;
    cache = { mtime, data: raw };
  }
  return cache.data;
}

/** Problems with routing data: unknown tools, params or inputs (empty when it's all real). */
export function checkRouting(d: RoutingData, tool: (id: string) => { params: Record<string, unknown>; inputs: Record<string, unknown> } | null): string[] {
  const bad: string[] = [];
  for (const [id, r] of Object.entries(d.tools)) {
    const t = tool(id);
    if (!t) { bad.push(`tools.${id}: no such tool`); continue; }
    if (!['image', 'video', 'mesh', 'audio'].includes(r.kind)) bad.push(`tools.${id}.kind: ${r.kind}`);
    for (const k of [r.prompt, r.steps, r.strength, r.negative]) if (k && !(k in t.params)) bad.push(`tools.${id}: no param ${k}`);
    for (const k of Object.keys(r.preview ?? {})) if (!(k in t.params)) bad.push(`tools.${id}.preview: no param ${k}`);
    for (const k of r.refs ?? []) if (!(k in t.inputs)) bad.push(`tools.${id}.refs: no input ${k}`);
    for (const k of Object.keys(r.inputs ?? {})) if (!(k in t.inputs)) bad.push(`tools.${id}.inputs: no input ${k}`);
  }
  for (const [intent, rules] of Object.entries(d.intents)) {
    if (!Array.isArray(rules) || !rules.length) bad.push(`intents.${intent}: no rules`);
    for (const r of rules ?? []) for (const id of r.tools) if (!d.tools[id]) bad.push(`intents.${intent}: ${id} has no tools entry`);
  }
  return bad;
}

/** What the request itself says about the shot (inputs and refs it carries, params it sets). */
export function contextOf(req: Pick<MakeRequest, 'inputs' | 'refs' | 'params'>): RouteContext {
  const ins = req.inputs ?? {};
  const p = req.params ?? {};
  const people = Number(p.people) || (req.refs?.identity?.length ?? 0) || (ins.image2 ? 2 : ins.image ? 1 : 0);
  return {
    depth: Boolean(ins.control),
    dialogue: Boolean(ins.audio),
    people,
    seconds: Number(p.seconds) || (Number(p.frames) && Number(p.fps) ? Number(p.frames) / Number(p.fps) : 0),
    lora: Boolean(p.lora),
  };
}

const inRange = (v: number, r?: { min?: number; max?: number }) => !r || ((r.min == null || v >= r.min) && (r.max == null || v <= r.max));

export function matches(w: When | undefined, c: RouteContext, hasRefs: boolean): boolean {
  if (!w) return true;
  if (w.depth !== undefined && Boolean(c.depth) !== w.depth) return false;
  if (w.dialogue !== undefined && Boolean(c.dialogue) !== w.dialogue) return false;
  if (w.sound !== undefined && Boolean(c.sound) !== w.sound) return false;
  if (w.lora !== undefined && Boolean(c.lora) !== w.lora) return false;
  if (w.refs !== undefined && hasRefs !== w.refs) return false;
  if (!inRange(c.people ?? 0, w.people)) return false;
  if (!inRange(c.seconds ?? 0, w.seconds)) return false;
  return true;
}

export type Routed = { tool: string; fallbacks: string[]; why: string; skipped: { tool: string; why: string }[] };

/** The tool order for a request: the first matching rule's tools, minus the ones that can't run here. */
export function pickTools(req: Pick<MakeRequest, 'intent' | 'inputs' | 'refs' | 'params'>, ctx: RouteContext = {}): Routed {
  const d = ctx.data ?? routing();
  const rules = d.intents[req.intent as MakeIntent];
  if (!rules) throw new GenError(`Nothing makes "${req.intent}" yet`);
  const c = { ...contextOf(req), ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => v !== undefined)) } as RouteContext;
  const hasRefs = Boolean(req.refs?.identity?.length);
  const given = new Set(Object.keys(req.inputs ?? {}).filter((k) => req.inputs![k] != null));
  const skipped: { tool: string; why: string }[] = [];
  for (const rule of rules) {
    if (!matches(rule.when, c, hasRefs)) continue;
    const ok: string[] = [];
    for (const id of rule.tools) {
      const tr = d.tools[id];
      const why = !tr ? 'no routing entry'
        : ctx.exclude?.includes(id) ? 'failed just now'
          : ctx.has && !ctx.has(id) ? 'not on this Gen'
            : ctx.ready && !ctx.ready(id) ? 'offline'
              : tr.paid && !c.allowPaid ? 'paid model not allowed'
                : missingInputs(id, tr, given, hasRefs ? req.refs!.identity!.length : 0, ctx);
      if (why) skipped.push({ tool: id, why });
      else ok.push(id);
    }
    if (ok.length) return { tool: ok[0], fallbacks: ok.slice(1), why: rule.why ?? 'rule', skipped };
  }
  const list = skipped.map((s) => `${s.tool} (${s.why})`).join(', ');
  throw new GenError(`Nothing can make this right now${list ? `: ${list}` : ''}`, { status: 503 });
}

/** Why a tool can't take this request ('' when it can): a required input that neither the request nor a reference fills. */
function missingInputs(id: string, tr: ToolRoute, given: Set<string>, refCount: number, ctx: RouteContext): string {
  const ins = ctx.inputsOf?.(id);
  if (!ins) return '';
  const fillable = new Set(given);
  for (const [k, from] of Object.entries(tr.inputs ?? {})) if (given.has(from)) fillable.add(k);
  (tr.refs ?? []).slice(0, refCount).forEach((k) => fillable.add(k));
  const missing = Object.entries(ins).filter(([k, s]) => s.required && !fillable.has(k)).map(([k]) => k);
  return missing.length ? `needs ${missing.join(', ')}` : '';
}
