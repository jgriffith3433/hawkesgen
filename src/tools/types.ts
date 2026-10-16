// What a tool is. A tool is one generic capability ("edit an image", "image to
// video", "speak a line", "answer as JSON"). Games describe what they want in
// a tool's params and inputs; the tool decides how (graph, model, provider).
//
// Adding a tool: write it in src/tools/, add it to the list in
// src/tools/index.ts, and give it a version. Bump the version when the same
// params would now make a different result, so recipes made with the old one
// read as out of date.

import type { Comfy, ComfyFile, Graph } from '../providers/comfy/client.ts';
import type { ModelRef } from '../workflows/convert.ts';

export type ParamSpec = {
  type: 'string' | 'text' | 'number' | 'integer' | 'boolean' | 'json' | 'enum';
  description?: string;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  values?: string[];
  /** Hidden behind "more settings" in the dashboard. */
  advanced?: boolean;
  /** An example value (shown as a placeholder). */
  example?: unknown;
};

export type InputSpec = {
  kind: 'image' | 'video' | 'audio' | 'file';
  description?: string;
  required?: boolean;
  /** A list of files instead of one. */
  multiple?: boolean;
  max?: number;
};

export type Output = {
  data: Buffer;
  mime?: string;
  ext?: string;
  seed?: number | null;
  title?: string;
  meta?: Record<string, unknown>;
};

export type ComfyRun = {
  comfy: Comfy;
  server: { id: string; region: string; price: number };
  /** Uploads a local file (once per server; cached by content). Returns the name nodes use. */
  upload(file: string): Promise<string>;
  uploadBuffer(data: Buffer, name: string): Promise<string>;
  /** Runs a graph (kept with the job), counting GPU time. */
  runGraph(graph: Graph): Promise<ComfyFile[]>;
  download(file: ComfyFile): Promise<Buffer>;
  /** Installs any of these models the server doesn't have yet (the job shows the download). */
  ensureModels(models: ModelRef[]): Promise<void>;
};

export type RunContext = {
  job: { id: string; client: string; project: string; tool: string; labels: Record<string, unknown> };
  params: Record<string, any>;
  /** Input name -> local file path (or list of paths). */
  inputs: Record<string, any>;
  /** How many outputs a resumed job already made (skip them). */
  done: number;
  /** The outputs already made (with their seeds). */
  outputs: { seed: number | null }[];
  signal: AbortSignal;
  step(detail: string): void;
  log(line: string): void;
  /** A scratch file path for this job (removed when it ends). */
  tmp(name: string): string;
  /** Saves an output to the library as it is made. */
  emit(out: Output): Promise<void>;
  /** A value the job returns (text, JSON) as well as or instead of files. */
  result(value: unknown): void;
  /** The seed for the n-th output: params.seed counting up, else random. */
  seed(n: number): number;
  usage(u: { provider: string; unit: string; amount: number; cost?: number; detail?: string }): void;
  /** Runs a script in post/ with the project's Python (.venv). Resolves to stdout. */
  python(script: string, args: string[]): Promise<string>;
  comfy?: ComfyRun;
};

export type Tool = {
  id: string;
  version: number;
  title: string;
  description: string;
  provider: 'comfy' | 'elevenlabs' | 'anthropic' | 'local' | 'builder' | 'playtest' | 'pipeline';
  /** For ComfyUI tools: the set of models it loads (servers swap between families). */
  family?: string | ((params: Record<string, any>) => string);
  output: 'image' | 'video' | 'audio' | 'text' | 'json' | 'mesh' | 'file';
  inputs: Record<string, InputSpec>;
  params: Record<string, ParamSpec>;
  /** Model files the tool uses (recorded in recipes). */
  models?: (params: Record<string, any>) => string[];
  /** Rough GPU seconds per output, for estimates. */
  gpuSeconds?: (params: Record<string, any>) => number;
  /** Set for tools that come from a workflow folder (workflows/). */
  workflow?: { dir: string; source: unknown; models: ModelRef[]; tags: string[] };
  run(ctx: RunContext): Promise<void>;
};
