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
  /** json params: a string that isn't JSON is kept as that string (playtest.run's build: "blob:<sha>" or an object). */
  orString?: boolean;
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
  /** The fleet server's ComfyUI client (absent on Cloud Run, where every graph is one request: docs/cloudrun.md). */
  comfy?: Comfy;
  server: { id: string; region: string; price: number };
  /** Uploads a local file (once per server; cached by content). Returns the name nodes use. */
  upload(file: string): Promise<string>;
  uploadBuffer(data: Buffer, name: string): Promise<string>;
  /** Runs a graph (kept with the job), counting GPU time. */
  runGraph(graph: Graph): Promise<ComfyFile[]>;
  download(file: ComfyFile): Promise<Buffer>;
  /** Installs any of these models the server doesn't have yet (the job shows the download). */
  ensureModels(models: ModelRef[]): Promise<void>;
  /** Counts other work on the server as GPU time (a Blender render over SSH). */
  timed<T>(work: () => Promise<T>): Promise<T>;
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
  /** Saves a file on this disk as an output by streaming it into the library: for big ones, never read whole into memory. */
  emitFile?(out: Omit<Output, 'data'> & { file: string }): Promise<void>;
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
  provider: 'comfy' | 'elevenlabs' | 'anthropic' | 'gemini' | 'local' | 'builder' | 'playtest' | 'pipeline';
  /** A lane of its own instead of its provider's (asset.lod: `lod`, one at a time). `yieldTo`: it waits while any job of
   *  those lanes runs or waits (customers' CPU work first). */
  lane?: { name: string; limit: () => number; yieldTo?: string[] };
  /** `ssh`: the tool also works on the GPU server itself over SSH (Blender, venvs, copying files), so it always runs on a
   *  fleet server, never on Cloud Run (src/providers/cloudrun/services.ts). */
  server?: 'ssh';
  /** `3d`: the tool runs a script in a job folder (src/providers/workspace.ts) on a fleet server over SSH, or on a GPU
   *  worker running the 3D image (server/gpu3d: Blender, the rig, motion and mocap venvs). Only endpoints that name its
   *  family run it ("*" is the ComfyUI image); Cloud Run's ComfyUI services never do (src/providers/gpu/route.ts).
   *  `unity-render`: the same, on the unity-render image (server/unity-render: a Linux Unity editor), never the fleet. */
  image?: '3d' | 'unity-render';
  /** For ComfyUI tools: the set of models it loads (servers swap between families). */
  family?: string | ((params: Record<string, any>) => string);
  output: 'image' | 'video' | 'audio' | 'text' | 'json' | 'mesh' | 'file';
  inputs: Record<string, InputSpec>;
  params: Record<string, ParamSpec>;
  /** Model files the tool uses (recorded in recipes). */
  models?: (params: Record<string, any>) => string[];
  /** Rough GPU seconds per output, for estimates. */
  gpuSeconds?: (params: Record<string, any>, inputs?: Record<string, any>) => number;
  /** Which kind of run a job is, when one tool's cost splits by it (motion.from-text with a character or BVH only).
   * Estimates take their history, and their default, from jobs of the same mode. `inputs` is undefined when the caller
   * of an estimate didn't say. */
  estimateMode?: (params: Record<string, any>, inputs?: Record<string, any>) => string;
  /** Set for tools that come from a workflow folder (workflows/). */
  workflow?: { dir: string; source: unknown; models: ModelRef[]; tags: string[] };
  /** Refuses a call before it is queued (throw a GenError saying what to do instead). Runs at submit, after the params are checked. */
  guard?(call: { params: Record<string, any>; inputs: Record<string, string | string[]>; labels?: Record<string, unknown> }): void;
  /**
   * Checks a call against its caller at submit and returns the params to store (playtest.run: a customer's build must be
   * its own and its URL public; a GitHub token is moved out of the params into memory). `customer` is a customer's job
   * (the same rule as callScope: a user key in a customer project). Throw a GenError to refuse.
   */
  admit?(call: { params: Record<string, any>; client: { id: string; role: string; projects: string[] }; project: string; customer: boolean }): Record<string, any>;
  /** Hands a call to another tool at submit (audio.voice -> the open-model tool). Returns the tool id to run, or null to stay. Both tools take the same params. */
  route?(params: Record<string, any>): string | null;
  /** Prices the call itself instead of the estimate (make.checked: the whole loop's worst case, capped by its budget).
   *  `child` prices one child job; null falls back to the estimate. */
  quote?(params: Record<string, any>, q: { project: string; child: (tool: string, params: Record<string, any>) => number; getTool: (id: string) => Tool | null }): { credits: number; breakdown: { label: string; credits: number }[]; tool?: string } | null;
  run(ctx: RunContext): Promise<void>;
};
