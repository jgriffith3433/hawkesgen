// The job queue: one for every project, so games never fight over the GPU.
//
// A job is one tool run: params, input files, and how many takes. Jobs wait
// in lanes by provider. The GPU lane runs one job per ready server and, to
// avoid swapping models (about a minute each time), gives a free server the
// oldest job of the family it already has loaded before anything else. API
// lanes (ElevenLabs, Claude) and the local lane run a few at once.
//
// Jobs survive a restart: one that was running goes back in the line and
// keeps the outputs it already saved. A caller can give a job a key; sending
// the same key again returns the existing job (so a game that restarts
// mid-batch doesn't pay twice).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { db, parseRow, J } from './db.ts';
import { paths, loadSettings, ROOT, DATA_DIR } from './config.ts';
import { getTool } from './tools/index.ts';
import { validateParams } from './tools/validate.ts';
import type { RunContext, Tool, Output } from './tools/types.ts';
import { putAsset, getAsset, blobPath, findAllByRecipe, recipeKey, type Recipe } from './library.ts';
import { recordUsage } from './usage.ts';
import { applyPreset } from './presets.ts';
import { canProject, type Client } from './auth.ts';
import { comfyEndpoints, fleetStatus, startServer, launchServer, imageAvailable, syncServer, installModels, markModelsUsed, type Endpoint } from './providers/comfy/fleet.ts';
import type { ModelRef } from './workflows/convert.ts';
import { Comfy } from './providers/comfy/client.ts';
import { id as newId, sha256File, GenError, run } from './util.ts';

export const events = new EventEmitter();
events.setMaxListeners(100);

export type Job = {
  id: string; key: string | null; client: string; project: string; tool: string; params: Record<string, any>; inputs: Record<string, any>;
  labels: Record<string, unknown>; priority: number; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; detail: string; log: string[];
  outputs: { asset: string; seed: number | null; mime: string; kind: string; title?: string | null }[]; result: unknown; error: string | null;
  server: string | null; family: string | null; gpu_seconds: number; cost: number; graphs: string[]; resumed: number; created: number; started: number | null; finished: number | null;
};
const JSON_COLS = ['params', 'inputs', 'labels', 'log', 'outputs', 'result', 'graphs'];

export function getJob(jobId: string): Job | null {
  return parseRow<Job>(db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId), JSON_COLS) ?? null;
}

export function listJobs(q: { project?: string; status?: string; client?: string; tool?: string; limit?: number; projects?: string[] } = {}) {
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  if (q.project) { where.push('project = :project'); args.project = q.project; }
  if (q.status) { where.push(`status IN (${q.status.split(',').map((s) => `'${s.replace(/[^a-z]/g, '')}'`).join(',')})`); }
  if (q.client) { where.push('client = :client'); args.client = q.client; }
  if (q.tool) { where.push('tool = :tool'); args.tool = q.tool; }
  if (q.projects && !q.projects.includes('*')) where.push(`project IN (${q.projects.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')})`);
  const limit = Math.max(1, Math.min(500, q.limit ?? 100));
  return db.prepare(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created DESC LIMIT ${limit}`).all(args as any).map((r) => parseRow<Job>(r, JSON_COLS));
}

function save(job: Job, fields: (keyof Job)[]) {
  const sets = fields.map((f) => `${f} = :${f}`).join(', ');
  const args: Record<string, any> = { id: job.id };
  for (const f of fields) args[f] = JSON_COLS.includes(f) ? J(job[f]) : (job[f] as any);
  db.prepare(`UPDATE jobs SET ${sets} WHERE id = :id`).run(args);
  events.emit('job', summary(job));
}

/** A job without its log, for lists and events. */
export const summary = (j: Job) => ({ ...j, log: undefined, logLines: j.log.length });

// ------------------------------------------------------------------ submit

export type JobSpec = {
  tool?: string;
  /** A preset name ("enemy" in this project, or "project/name"): the project's art direction. */
  preset?: string; project: string; params?: Record<string, unknown>; inputs?: Record<string, unknown>;
  labels?: Record<string, unknown>; key?: string; priority?: number;
  /**
   * Hand back a finished job that already made exactly this recipe (same tool version, params and inputs; any seed)
   * instead of paying for it again. `exclude` lists asset ids the caller already has (other takes of a best-of-N).
   */
  reuse?: boolean | { exclude?: string[] };
};

/** Turns an input reference into a local path: a path (local callers only), "asset:<id>" or "blob:<sha256>". */
function resolveInput(client: Client, ref: unknown): string {
  if (typeof ref !== 'string' || !ref) throw new GenError('An input must be a file path, asset:<id> or blob:<sha256>');
  if (ref.startsWith('asset:')) {
    const a = getAsset(ref.slice(6));
    if (!a) throw new GenError(`No asset ${ref.slice(6)}`, { status: 404 });
    if (!canProject(client, a.project)) throw new GenError(`No access to ${ref}`, { status: 403 });
    return a.path;
  }
  if (ref.startsWith('blob:')) {
    const p = blobPath(ref.slice(5));
    if (!p) throw new GenError(`No blob ${ref.slice(5)} (upload it to /v1/blobs first)`, { status: 404 });
    return p;
  }
  // Raw paths only for callers on this machine with owner rights (games running here).
  if (client.role !== 'owner') throw new GenError('Remote callers send files as blob:<sha256> (POST /v1/blobs) or asset:<id>', { status: 403 });
  const abs = path.resolve(ref);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new GenError(`No file at ${abs}`, { status: 404 });
  return abs;
}

function resolveInputs(client: Client, tool: Tool, raw: Record<string, unknown> = {}) {
  const out: Record<string, string | string[]> = {};
  for (const k of Object.keys(raw)) if (!(k in tool.inputs)) throw new GenError(`${tool.id} has no input "${k}" (it takes: ${Object.keys(tool.inputs).join(', ') || 'none'})`);
  for (const [name, spec] of Object.entries(tool.inputs)) {
    const v = raw[name];
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) {
      if (spec.required) throw new GenError(`${tool.id} needs the input "${name}"`);
      continue;
    }
    if (spec.multiple) {
      const list = Array.isArray(v) ? v : [v];
      if (spec.max && list.length > spec.max) throw new GenError(`${name} takes at most ${spec.max} files`);
      out[name] = list.map((x) => resolveInput(client, x));
    } else {
      if (Array.isArray(v)) throw new GenError(`${name} takes one file`);
      out[name] = resolveInput(client, v);
    }
  }
  return out;
}

export function submit(client: Client, spec0: JobSpec): Job {
  const project0 = String(spec0.project ?? '').trim();
  // A preset (the project's art direction) fills in the tool, params and inputs.
  const applied = applyPreset({ ...spec0, project: project0 }, (id) => getTool(id)?.params ?? null);
  const spec: JobSpec = { ...spec0, tool: applied.tool ?? spec0.tool, params: applied.params, inputs: applied.inputs, labels: applied.preset ? { ...(spec0.labels ?? {}), preset: applied.preset } : spec0.labels };
  const tool = getTool(spec.tool ?? '');
  if (!tool) throw new GenError(`Unknown tool: ${spec.tool}`, { status: 404 });
  const project = project0;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(project)) throw new GenError('project is required (letters, numbers, . _ -)');
  if (!canProject(client, project)) throw new GenError(`No access to project ${project}`, { status: 403 });
  if (spec.key) {
    const existing = db.prepare('SELECT id FROM jobs WHERE client = ? AND key = ?').get(client.id, String(spec.key)) as { id: string } | undefined;
    if (existing) return getJob(existing.id)!;
  }
  const params = validateParams(tool, spec.params ?? {});
  const inputs = resolveInputs(client, tool, spec.inputs ?? {});
  if (spec.reuse) {
    const found = reusable(tool, project, params, inputs, typeof spec.reuse === 'object' ? spec.reuse.exclude ?? [] : []);
    if (found) return found;
  }
  return createJob(client, tool, { project, params, inputs, labels: spec.labels, key: spec.key, priority: spec.priority });
}

const sha256Sync = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The recipe key a job with these params and inputs would give its outputs (as runJob computes it). */
export function jobRecipeKey(tool: Tool, params: Record<string, any>, inputs: Record<string, string | string[]>) {
  const hashes: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(inputs)) hashes[k] = Array.isArray(v) ? v.map(sha256Sync) : sha256Sync(v);
  return recipeKey({ tool: tool.id, version: tool.version, params, inputs: hashes, models: tool.models?.(params) } as Recipe);
}

/** A finished job in this project whose first output has this recipe and isn't one the caller already has. */
function reusable(tool: Tool, project: string, params: Record<string, any>, inputs: Record<string, string | string[]>, exclude: string[]): Job | null {
  const skip = new Set(exclude.map((x) => String(x).replace(/^asset:/, '')));
  for (const a of findAllByRecipe(jobRecipeKey(tool, params, inputs), project)) {
    if (skip.has(a.id) || !a.job) continue;
    const j = getJob(a.job);
    if (!j || j.status !== 'done' || j.outputs?.[0]?.asset !== a.id) continue;
    return { ...j, reused: true } as Job;
  }
  return null;
}

function createJob(client: Client, tool: Tool, s: { project: string; params: Record<string, any>; inputs: Record<string, any>; labels?: Record<string, unknown>; key?: string; priority?: number }): Job {
  const { project, params, inputs } = s;
  const spec = s;
  const family = tool.provider === 'comfy' ? (typeof tool.family === 'function' ? tool.family(params) : tool.family) ?? null : null;
  const job: Job = {
    id: newId('j', 6), key: spec.key ? String(spec.key) : null, client: client.id, project, tool: tool.id, params, inputs,
    labels: spec.labels ?? {}, priority: Math.max(-10, Math.min(10, Math.round(Number(spec.priority) || 0))), status: 'queued', detail: 'queued',
    log: [], outputs: [], result: null, error: null, server: null, family, gpu_seconds: 0, cost: 0, graphs: [], resumed: 0, created: Date.now(), started: null, finished: null,
  };
  db.prepare(`INSERT INTO jobs (id, key, client, project, tool, params, inputs, labels, priority, status, detail, log, outputs, result, error, server, family, gpu_seconds, cost, graphs, resumed, created)
              VALUES (:id, :key, :client, :project, :tool, :params, :inputs, :labels, :priority, :status, :detail, :log, :outputs, :result, :error, :server, :family, :gpu_seconds, :cost, :graphs, :resumed, :created)`).run({
    id: job.id, key: job.key, client: job.client, project: job.project, tool: job.tool, params: J(params), inputs: J(inputs), labels: J(job.labels),
    priority: job.priority, status: job.status, detail: job.detail, log: '[]', outputs: '[]', result: null, error: null, server: null, family: job.family,
    gpu_seconds: 0, cost: 0, graphs: '[]', resumed: 0, created: job.created,
  });
  events.emit('job', summary(job));
  queue.pump();
  return job;
}

export function cancel(jobId: string) {
  const j = getJob(jobId);
  if (!j) throw new GenError('No such job', { status: 404 });
  if (j.status === 'queued') {
    Object.assign(j, { status: 'cancelled', detail: 'cancelled before it started', finished: Date.now() });
    save(j, ['status', 'detail', 'finished']);
  } else if (j.status === 'running') {
    queue.aborts.get(j.id)?.abort();
  }
  return getJob(jobId);
}

/** Queues a job again with the same tool, params and inputs: a new seed unless sameSeed. */
export function rerun(client: Client, jobId: string, { sameSeed = false } = {}) {
  const j = getJob(jobId);
  if (!j) throw new GenError('No such job', { status: 404 });
  const params = { ...j.params };
  if (!sameSeed) delete params.seed;
  else params.seed = j.outputs[0]?.seed ?? params.seed;
  return createJob(client, getTool(j.tool)!, { project: j.project, params, inputs: j.inputs, labels: j.labels, priority: j.priority });
}

export function clearFinished(project?: string) {
  const r = project
    ? db.prepare("DELETE FROM jobs WHERE status IN ('done','failed','cancelled') AND project = ?").run(project)
    : db.prepare("DELETE FROM jobs WHERE status IN ('done','failed','cancelled')").run();
  return Number(r.changes);
}

// ------------------------------------------------------------------- queue

const PYTHON = [path.join(ROOT, '.venv', 'Scripts', 'python.exe'), path.join(ROOT, '.venv', 'bin', 'python')].find((p) => fs.existsSync(p)) ?? (process.platform === 'win32' ? 'python' : 'python3');

class Queue {
  /** Server id -> job id running on it. */
  busy = new Map<string, string>();
  /** Provider -> running job ids (API and local lanes). */
  lanes = new Map<string, Set<string>>();
  aborts = new Map<string, AbortController>();
  /** Server id -> the model family it last loaded. */
  families = new Map<string, string>();
  /** Server id -> content hash -> uploaded name. */
  uploads = new Map<string, Map<string, string>>();
  pumping = false;
  again = false;
  timer: NodeJS.Timeout | null = null;
  lastAutoStart = 0;
  waitReason = '';
  /** Whether a GPU server was ready for playtest browsers, checked at most every 30 s. */
  gpuSeen = { at: 0, ready: false, limit: 3 };

  start() {
    // Jobs that were running when Hawkes Gen stopped go back in the line.
    for (const j of listJobs({ status: 'running', limit: 500 })) {
      j.status = 'queued';
      j.resumed += 1;
      j.detail = `picked up again after a restart (${j.outputs.length} done)`;
      j.log.push(j.detail);
      save(j, ['status', 'resumed', 'detail', 'log']);
    }
    this.pump();
  }

  queued() {
    return db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created").all().map((r) => parseRow<Job>(r, JSON_COLS));
  }

  pump() {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    this.again = false;
    void this.fill().finally(() => {
      this.pumping = false;
      if (this.again) this.pump();
    });
  }

  async fill() {
    const waiting = this.queued();
    if (!waiting.length) return;
    const settings = loadSettings();
    const toolOf = (j: Job) => getTool(j.tool)!;
    // Playtests whose browser runs on the playtester (T4, 16 GB) fit two at a time, on a GPU fleet server three; on this PC or
    // in software, one (playtest.run also keeps the local browser to one at a time itself).
    const playtestLimit = async (j: Job) => {
      if (process.platform === 'win32' || j.params.gpu === 'off') return 1;
      if (Date.now() - this.gpuSeen.at > 30_000) {
        const { playtesterTarget } = await import('./providers/playtester/playtester.ts');
        const pt = await playtesterTarget().catch(() => null);
        this.gpuSeen = { at: Date.now(), ready: Boolean(pt) || (await comfyEndpoints().catch(() => [])).length > 0, limit: pt ? 2 : 3 };
      }
      return this.gpuSeen.ready ? this.gpuSeen.limit : 1;
    };

    // API and local lanes.
    for (const j of waiting.filter((x) => toolOf(x).provider !== 'comfy')) {
      const provider = toolOf(j).provider as 'elevenlabs' | 'anthropic' | 'local' | 'builder' | 'playtest' | 'pipeline';
      const lane = this.lanes.get(provider) ?? new Set();
      this.lanes.set(provider, lane);
      // One build server. Pipelines only wait on other jobs, so several can run.
      const limit = provider === 'builder' ? 1 : provider === 'playtest' ? await playtestLimit(j) : provider === 'pipeline' ? 6 : settings.concurrency[provider];
      if (lane.size >= limit) {
        this.wait(j, `waiting: ${lane.size} ${provider} jobs already running`);
        continue;
      }
      // A Gen deploy is waiting for the build server to be free (hawkesstudio/deploy/hawkes-pull.mjs drops this file):
      // don't start another build until it's done, so the deploy gets its moment.
      if (provider === 'builder' && fs.existsSync(path.join(DATA_DIR, 'deploy-pending'))) {
        this.wait(j, 'waiting: Hawkes Gen is about to update (a few minutes)');
        continue;
      }
      lane.add(j.id);
      void this.runJob(j, null).finally(() => {
        lane.delete(j.id);
        this.pump();
      });
    }

    // The GPU lane.
    const gpu = waiting.filter((x) => toolOf(x).provider === 'comfy');
    if (!gpu.length) return;
    let endpoints: Endpoint[] = [];
    try {
      endpoints = await comfyEndpoints();
      this.waitReason = endpoints.length ? '' : 'no GPU server is ready. Start one (dashboard Fleet tab, or `hawkesgen fleet start`).';
    } catch (e: any) {
      this.waitReason = e.message;
    }
    const cap = settings.fleet.servers;
    let free = endpoints.filter((ep) => !this.busy.has(ep.id)).slice(0, Math.max(0, cap - this.busy.size));
    const taken = new Set<string>();
    // A server keeps its models loaded between jobs: give each free server the oldest job of the family it already has.
    for (const ep of [...free]) {
      const fam = this.families.get(ep.id);
      const next = gpu.find((j) => !taken.has(j.id) && j.family === fam);
      if (!next) continue;
      taken.add(next.id);
      free = free.filter((x) => x !== ep);
      void this.runOn(next, ep);
    }
    for (const ep of free) {
      const next = gpu.find((j) => !taken.has(j.id));
      if (!next) break;
      taken.add(next.id);
      void this.runOn(next, ep);
    }
    const left = gpu.filter((j) => !taken.has(j.id));
    for (const j of left) {
      this.wait(j, endpoints.length ? `waiting for a free GPU server (${this.busy.size} of ${Math.min(cap, endpoints.length)} busy)` : `waiting: ${this.waitReason}`);
    }
    if (left.length) {
      if (endpoints.length < Math.min(cap, left.length + this.busy.size)) void this.autoStart(left.length + this.busy.size);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.pump(), endpoints.length ? 10_000 : 30_000);
    }
  }

  wait(j: Job, detail: string) {
    if (j.detail === detail) return;
    j.detail = detail;
    save(j, ['detail']);
  }

  /**
   * With auto start on: starts stopped servers until there is one per job, and once the fleet image exists launches
   * from it (one per round) when there's none left to start: disposable servers aren't kept stopped. Without the image it
   * never launches (that's a 30-45 minute install). At most every two minutes.
   */
  async autoStart(want: number) {
    const fleet = loadSettings().fleet;
    if (!fleet.auto || Date.now() - this.lastAutoStart < 120_000) return;
    this.lastAutoStart = Date.now();
    try {
      const all = await fleetStatus();
      const up = all.filter((st) => ['running', 'pending'].includes(st.state!)).length;
      const short = Math.max(0, Math.min(fleet.servers, want) - up);
      const stopped = all.filter((st) => st.state === 'stopped' && !st.imageSource && !st.purpose).slice(0, short);
      for (const st of stopped) await startServer(st.id).catch((e) => console.warn(`[queue] couldn't start ${st.id}: ${e.message}`));
      if (stopped.length) console.log(`[queue] started ${stopped.length} server(s) for waiting jobs`);
      if (stopped.length < short && all.length < fleet.servers && (await imageAvailable())) {
        const r = await launchServer({ idleMinutes: fleet.idleMinutes, type: 'auto' }).catch((e) => console.warn(`[queue] couldn't launch from the image: ${e.message}`));
        if (r) console.log(`[queue] launched ${r.id} from the image for waiting jobs`);
      }
    } catch (e: any) {
      console.warn(`[queue] auto start: ${e.message}`);
    }
  }

  async runOn(job: Job, ep: Endpoint) {
    if (this.busy.has(ep.id)) return;
    this.busy.set(ep.id, job.id);
    try {
      await this.runJob(job, ep);
    } finally {
      this.busy.delete(ep.id);
      this.pump();
    }
  }

  async runJob(job: Job, ep: Endpoint | null) {
    const tool = getTool(job.tool)!;
    const abort = new AbortController();
    this.aborts.set(job.id, abort);
    const tmpDir = path.join(paths.tmp, job.id);
    fs.mkdirSync(tmpDir, { recursive: true });
    Object.assign(job, { status: 'running', started: Date.now(), server: ep?.id ?? null, detail: ep ? `connecting to the GPU server in ${ep.region}` : 'starting' });
    save(job, ['status', 'started', 'server', 'detail']);
    const step = (detail: string) => {
      job.detail = detail;
      job.log.push(`${new Date().toISOString().slice(11, 19)} ${detail}`);
      job.log = job.log.slice(-300);
      save(job, ['detail', 'log']);
    };
    // The recipe parts that don't change between outputs.
    const inputHashes: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(job.inputs)) inputHashes[k] = Array.isArray(v) ? await Promise.all(v.map(sha256File)) : await sha256File(v);
    const baseRecipe: Omit<Recipe, 'seed'> = { tool: tool.id, version: tool.version, params: job.params, inputs: inputHashes, models: tool.models?.(job.params) };

    const ctx: RunContext = {
      job: { id: job.id, client: job.client, project: job.project, tool: job.tool, labels: job.labels },
      params: job.params,
      inputs: job.inputs,
      done: job.outputs.length,
      outputs: job.outputs,
      signal: abort.signal,
      step,
      log: (line) => {
        job.log.push(line);
        save(job, ['log']);
      },
      tmp: (name) => path.join(tmpDir, name),
      emit: async (out: Output) => {
        const asset = putAsset({
          data: out.data, mime: out.mime, ext: out.ext, job: job.id, client: job.client, project: job.project, tool: tool.id,
          seed: out.seed ?? null, recipe: { ...baseRecipe, params: { ...job.params, seed: out.seed ?? job.params.seed } }, labels: job.labels, title: out.title, meta: out.meta,
        });
        job.outputs.push({ asset: asset.id, seed: asset.seed, mime: asset.mime, kind: asset.kind, title: asset.title });
        save(job, ['outputs']);
      },
      result: (value) => {
        job.result = value;
        save(job, ['result']);
      },
      seed: (n) => (job.params.seed ? Number(job.params.seed) + n : crypto.randomInt(1, 2 ** 31)),
      usage: (u) => {
        recordUsage({ client: job.client, project: job.project, job: job.id, ...u });
        job.cost = Math.round((job.cost + (u.cost ?? 0)) * 10000) / 10000;
        save(job, ['cost']);
      },
      python: (script, args) => run(PYTHON, [path.join(paths.post, script), ...args], { signal: abort.signal }),
    };

    try {
      if (ep) ctx.comfy = await this.comfyRun(job, ep, step, abort.signal);
      await tool.run(ctx);
      Object.assign(job, { status: 'done', finished: Date.now(), detail: `done: ${job.outputs.length} output${job.outputs.length === 1 ? '' : 's'}${job.result ? ' and a result' : ''}` });
    } catch (e: any) {
      const cancelled = abort.signal.aborted || e.message === 'Cancelled';
      Object.assign(job, { status: cancelled ? 'cancelled' : 'failed', finished: Date.now(), error: cancelled ? null : e.message, detail: cancelled ? 'cancelled' : e.message });
      job.log.push(`error: ${e.message}`);
    } finally {
      if (ep && job.gpu_seconds) {
        const cost = (job.gpu_seconds / 3600) * ep.price;
        recordUsage({ client: job.client, project: job.project, job: job.id, provider: 'aws-gpu', unit: 'gpu_seconds', amount: job.gpu_seconds, cost, detail: ep.region });
        job.cost = Math.round((job.cost + cost) * 10000) / 10000;
      }
      this.aborts.delete(job.id);
      removeLater(tmpDir);
      save(job, ['status', 'finished', 'error', 'detail', 'log', 'gpu_seconds', 'cost']);
    }
  }

  /** What a ComfyUI tool gets: uploads (cached per server), graph runs (kept and timed), downloads. */
  async comfyRun(job: Job, ep: Endpoint, step: (d: string) => void, signal: AbortSignal) {
    const comfy = new Comfy(ep);
    const fam = job.family ?? 'other';
    if (this.families.get(ep.id) !== fam) {
      step(`unloading the last models to make room for ${fam}`);
      await comfy.free().catch(() => undefined);
    }
    this.families.set(ep.id, fam);
    const cache = this.uploads.get(ep.id) ?? new Map<string, string>();
    this.uploads.set(ep.id, cache);
    const uploadBuffer = async (data: Buffer, name: string) => {
      const h = crypto.createHash('sha256').update(data).digest('hex');
      const hit = cache.get(h);
      if (hit) return hit;
      const remote = await comfy.upload(data, `${h.slice(0, 16)}${path.extname(name)}`);
      cache.set(h, remote);
      return remote;
    };
    return {
      comfy,
      server: { id: ep.id, region: ep.region, price: ep.price },
      upload: (file: string) => uploadBuffer(fs.readFileSync(file), file),
      uploadBuffer,
      runGraph: async (graph: any) => {
        const name = `${job.id}-${job.graphs.length + 1}.json`;
        fs.writeFileSync(path.join(paths.graphs, name), JSON.stringify(graph, null, 1));
        job.graphs.push(name);
        save(job, ['graphs']);
        const t = Date.now();
        try {
          const result = await comfy.run(graph, { signal, onProgress: (d) => { job.detail = d; events.emit('job', summary(job)); } });
          return result.files;
        } catch (e: any) {
          if (e.missingModels?.length) {
            throw new GenError(`${e.message}\nThis server doesn't have every model yet. Run "hawkesgen fleet sync" (or Sync models in the dashboard) to download them.`);
          }
          throw e;
        } finally {
          job.gpu_seconds = Math.round((job.gpu_seconds + (Date.now() - t) / 1000) * 10) / 10;
          save(job, ['gpu_seconds']);
        }
      },
      download: (file: any) => comfy.download(file),
      timed: async <T>(work: () => Promise<T>) => {
        const t = Date.now();
        try {
          return await work();
        } finally {
          job.gpu_seconds = Math.round((job.gpu_seconds + (Date.now() - t) / 1000) * 10) / 10;
          save(job, ['gpu_seconds']);
        }
      },
      ensureModels: async (models: ModelRef[]) => {
        const installed = await installModels(ep.id, models, step);
        markModelsUsed(ep.id, models);
        if (installed.length) {
          step(`installed ${installed.length} model${installed.length > 1 ? 's' : ''} on ${ep.id}`);
          comfy.info = null;
        }
      },
    };
  }
}

/**
 * Removes a job's scratch folder. On Windows a browser or ffmpeg can still hold a file for a moment after a job
 * ends, so a failed removal is retried later instead of throwing (an uncaught error here once took the service down).
 */
function removeLater(dir: string, tries = 0) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e: any) {
    if (tries < 10) setTimeout(() => removeLater(dir, tries + 1), 30_000).unref();
    else console.warn(`[jobs] couldn't remove ${dir}: ${e.code ?? e.message}`);
  }
}

export const queue = new Queue();

/** Downloads models a family needs onto a server (exposed for the fleet sync action). */
export const syncModels = syncServer;
