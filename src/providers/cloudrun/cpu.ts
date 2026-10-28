// The CPU suite on Cloud Run (docs/cpu-cloudrun.md): when settings.cpu sends a CPU tool to Cloud Run, its job is ONE
// request to the gen-cpu service (light tools) or gen-cpu-heavy (heavy ones). The service runs the tool's own run()
// (the same code as here, src/cpu/suite.ts) against the job's inputs in Cloud Storage and streams back NDJSON:
//
//   {t:'step', detail} {t:'log', line}   the job's progress, as if it ran here
//   {t:'emit', i, uri, ext, mime, seed, title, meta, bytes}   output i, written to gs://<bucket>/cpu/runs/<key>/
//   {t:'result', value}                  ctx.result
//   {t:'done', seconds, cold, startupSeconds}  or  {t:'error', message, user}
//
// Here every emit is read back from the bucket and filed in the library with ctx.emit, so outputs, recipes, levels of
// detail and credits work exactly as for a local run. The run key is sha256(job id, tool, version, params, inputs): a
// run that finished left manifest.json, which answers a retry (a Gen restart) without running again; outputs the job
// already has (ctx.outputs) are skipped by index on both sides. A service that can't be reached, or whose image is
// older than this tool, runs the job here instead (nothing is lost but the trip). Cancelling closes the request, and
// the service kills the tool's processes.
//
// The LOD system's level making (src/lod.ts) goes through cpuExec(): POST /exec runs post/lod.py or src/lod-mesh.ts
// on the service, and the levels come back to the library folder Gen would have written them to.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RunContext, Tool } from '../../tools/types.ts';
import { paths, type Settings } from '../../config.ts';
import { suiteTool, inSuite, STAYS_LOCAL, describeSuite, type ExecKind } from '../../cpu/suite.ts';
import { gcs, gcpTokens, type Gcs } from '../gcp/gcs.ts';
import { ndjson, stableJson } from './run.ts';
import { GenError } from '../../util.ts';

export type CpuClass = 'light' | 'heavy';
export type CpuSpec = {
  repository: string; image: string; region: string;
  prices: { billing: string; cpuPerVcpuSecond: number; memoryPerGibSecond: number; perMillionRequests: number; freePerMonth?: Record<string, number>; verified?: boolean; source?: string };
  classes: Record<CpuClass, { name: string; cpu: number; memoryGi: number; concurrency: number; maxInstances: number; timeoutSeconds: number; why?: string }>;
};
/** A service a job goes to. pricePerSecond: the instance's vCPUs and memory while a request runs. */
export type CpuService = { cls: CpuClass; name: string; url: string; bucket: string; pricePerSecond: number; timeoutSeconds: number };

export const SPEC_FILE = () => path.join(paths.server, 'cpu-cloudrun', 'service.json');
let cached: { mtime: number; spec: CpuSpec } | null = null;
export function loadCpuSpec(file = SPEC_FILE()): CpuSpec {
  const mtime = fs.statSync(file).mtimeMs;
  if (cached?.mtime === mtime) return cached.spec;
  cached = { mtime, spec: JSON.parse(fs.readFileSync(file, 'utf8')) as CpuSpec };
  return cached.spec;
}

/** A class's instance price per second (request-based billing: vCPUs and memory only while a request runs). */
export const classPrice = (spec: CpuSpec, cls: CpuClass) => spec.classes[cls].cpu * spec.prices.cpuPerVcpuSecond + spec.classes[cls].memoryGi * spec.prices.memoryPerGibSecond;

/** Which class a tool's service is: heavy tools want a whole instance, the rest share a small one. */
export const classOf = (toolId: string): CpuClass => (suiteTool(toolId)?.weight === 'heavy' || toolId === 'asset.lod' ? 'heavy' : 'light');

/** Where settings put this tool: its own entry, else the backend. */
export const cpuBackendOf = (toolId: string, s: Pick<Settings, 'cpu'>) => s.cpu.tools[toolId] ?? s.cpu.backend;

export type CpuRoute = { service: CpuService; why?: undefined } | { service: null; why: string };

/** The service a CPU job goes to, or why it runs here. asset.lod routes its level making (cpuExec), not its run(). */
export function cpuRoute(toolId: string, s: Pick<Settings, 'cpu'>, spec?: CpuSpec): CpuRoute {
  const here = (why: string): CpuRoute => ({ service: null, why });
  if (!inSuite(toolId) && toolId !== 'asset.lod') return here(STAYS_LOCAL[toolId] ?? 'not in the CPU suite');
  if (cpuBackendOf(toolId, s) !== 'cloudrun') return here('settings.cpu runs it here');
  const { urls, bucket } = s.cpu.cloudrun;
  if (!bucket) return here('settings.cpu.cloudrun.bucket is not set');
  const want = classOf(toolId);
  const cls: CpuClass | null = urls[want] ? want : urls[want === 'heavy' ? 'light' : 'heavy'] ? (want === 'heavy' ? 'light' : 'heavy') : null;
  if (!cls) return here('no CPU service is deployed (settings.cpu.cloudrun.urls)');
  let sp: CpuSpec;
  try {
    sp = spec ?? loadCpuSpec();
  } catch (e: any) {
    return here(`server/cpu-cloudrun/service.json: ${e.message}`);
  }
  const c = sp.classes[cls];
  return { service: { cls, name: c.name, url: urls[cls]!, bucket, pricePerSecond: classPrice(sp, cls), timeoutSeconds: c.timeoutSeconds } };
}

/** Is anything routed to Cloud Run (so the queue skips the routing work when it's all local)? */
export const cpuCloudEnabled = (s: Pick<Settings, 'cpu'>) => s.cpu.backend === 'cloudrun' || Object.values(s.cpu.tools).includes('cloudrun');

// ------------------------------------------------------------------ the request

export type CpuDeps = {
  store: Pick<Gcs, 'stat' | 'read' | 'readJson' | 'write'>;
  fetch: typeof fetch;
  idToken: (audience: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};
let override: CpuDeps | null = null;
/** Tests swap in a fake service and bucket. */
export function setCpuDeps(d: CpuDeps | null) {
  override = d;
}
const deps = (): CpuDeps => override ?? {
  store: gcs(),
  fetch: (i, init) => fetch(i, init),
  idToken: (aud) => gcpTokens().id(aud),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/** How long a job waits for a free instance (the service at max instances answers 429) before running here. */
const WAIT_FOR_INSTANCE_MS = 10 * 60_000;

export type InputRef = { uri: string; name: string };
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Puts a local file in the bucket by content (once), keeping its name for the tool (cutout.py reads extensions). */
async function upload(d: CpuDeps, bucket: string, file: string): Promise<InputRef & { sha: string }> {
  const data = fs.readFileSync(file);
  const sha = sha256(data);
  const uri = `gs://${bucket}/cpu/inputs/${sha}${path.extname(file).toLowerCase()}`;
  if (!(await d.store.stat(uri))) await d.store.write(uri, data);
  return { uri, name: path.basename(file), sha };
}

/** A failure of the trip, not of the tool: the job can still run here. */
class Unavailable extends Error {}

/** Recent requests, for GET /v1/cpu. */
const recent: { tool: string; service: string; seconds: number; wall: number; cold: boolean; ok: boolean; at: number; error?: string }[] = [];
const remember = (r: (typeof recent)[number]) => {
  recent.push(r);
  if (recent.length > 100) recent.shift();
};

export type CpuHooks = { addSeconds(seconds: number, cold: boolean, startupSeconds: number): void };

/**
 * Runs a CPU job on its Cloud Run service. Returns false when the service couldn't take it (unreachable, older image,
 * no instance in 10 minutes) before any output, so the caller runs it here; throws the tool's own errors.
 */
export async function runCpuRemote(job: { id: string }, tool: Tool, ctx: RunContext, svc: CpuService, hooks: CpuHooks, d: CpuDeps = deps()): Promise<boolean> {
  const started = d.now();
  const inputs: Record<string, InputRef | InputRef[]> = {};
  const shas: Record<string, string | string[]> = {};
  ctx.step(`sending the inputs to Cloud Run (${svc.name})`);
  for (const [k, v] of Object.entries(ctx.inputs ?? {})) {
    if (Array.isArray(v)) {
      const list = await Promise.all(v.map((f: string) => upload(d, svc.bucket, f)));
      inputs[k] = list.map(({ uri, name }) => ({ uri, name }));
      shas[k] = list.map((x) => x.sha);
    } else if (typeof v === 'string') {
      const one = await upload(d, svc.bucket, v);
      inputs[k] = { uri: one.uri, name: one.name };
      shas[k] = one.sha;
    }
  }
  const key = crypto.createHash('sha256').update(stableJson({ job: job.id, tool: tool.id, version: tool.version, params: ctx.params, inputs: shas })).digest('hex');
  const out = `gs://${svc.bucket}/cpu/runs/${key}/`;
  let emitted = false;

  const onEvent = async (ev: any) => {
    if (ev.t === 'step') ctx.step(String(ev.detail));
    else if (ev.t === 'log') ctx.log(String(ev.line));
    else if (ev.t === 'emit') {
      if (Number(ev.i) < ctx.outputs.length) return; // the job has it already (a retry)
      const data = await d.store.read(String(ev.uri));
      if (!data) throw new Error(`${svc.name}: output ${ev.i} is missing from ${ev.uri}`);
      emitted = true;
      await ctx.emit({ data, ext: ev.ext, mime: ev.mime, seed: ev.seed ?? null, title: ev.title ?? undefined, meta: ev.meta ?? undefined });
    } else if (ev.t === 'result') ctx.result(ev.value);
    else if (ev.t === 'usage' && ev.usage) ctx.usage(ev.usage);
  };

  const finish = (ev: any) => {
    const seconds = Number(ev.seconds) || 0;
    hooks.addSeconds(seconds, !!ev.cold, Number(ev.startupSeconds) || 0);
    remember({ tool: tool.id, service: svc.name, seconds, wall: (d.now() - started) / 1000, cold: !!ev.cold, ok: ev.t === 'done', at: d.now(), error: ev.t === 'done' ? undefined : String(ev.message).slice(0, 200) });
    if (ev.t === 'done') return true;
    if (ev.stale && !emitted) throw new Unavailable(`${svc.name} has an older ${tool.id} (${ev.message})`);
    // The tool's own refusal (bad params, no frames) reads as it would here; anything else names the service.
    throw ev.user ? new GenError(String(ev.message)) : new Error(`${svc.name}: ${ev.message}`);
  };

  try {
    for (let posts = 0; posts < 3; posts++) {
      if (ctx.signal.aborted) throw new Error('Cancelled');
      // Finished before (Gen restarted after the run ended): the answer is in the bucket.
      const done = await d.store.readJson(`${out}manifest.json`).catch(() => null);
      if (done?.t === 'done') {
        ctx.step(`${svc.name}: this run already finished (answer from its manifest)`);
        for (const ev of done.events ?? []) await onEvent(ev);
        return finish({ ...done, seconds: 0, cold: false });
      }
      const body = JSON.stringify({ key, job: job.id, tool: tool.id, version: tool.version, params: ctx.params, inputs, done: ctx.outputs.length, seeds: ctx.outputs.map((o) => o.seed), out });
      const end = await post(d, svc, body, ctx, onEvent);
      if (end) return finish(end);
      ctx.step(`${svc.name}: the connection ended before the answer; asking again`);
    }
    throw new Unavailable(`the connection to ${svc.name} broke 3 times`);
  } catch (e: any) {
    if (e instanceof Unavailable && !emitted && !ctx.signal.aborted) {
      remember({ tool: tool.id, service: svc.name, seconds: 0, wall: (d.now() - started) / 1000, cold: false, ok: false, at: d.now(), error: e.message });
      ctx.step(`${e.message}: running it here instead`);
      return false;
    }
    throw e;
  }
}

/** One POST: the final event, or null when the stream broke first. Throws Unavailable when the service can't take it. */
async function post(d: CpuDeps, svc: CpuService, body: string, ctx: Pick<RunContext, 'signal' | 'step'>, onEvent: (ev: any) => Promise<void>, route = '/tool'): Promise<any | null> {
  const until = d.now() + WAIT_FOR_INSTANCE_MS;
  for (let told = false; ; told = true) {
    if (ctx.signal.aborted) throw new Error('Cancelled');
    let r: Response;
    try {
      r = await d.fetch(`${svc.url}${route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await d.idToken(svc.url)}`, 'Content-Type': 'application/json' },
        body,
        signal: ctx.signal,
      });
    } catch (e: any) {
      if (ctx.signal.aborted) throw new Error('Cancelled');
      throw new Unavailable(`couldn't reach ${svc.name} (${e.cause?.code ?? e.message})`);
    }
    // Every instance busy (max instances x concurrency) or one still starting: wait our turn, then give up to here.
    if (r.status === 429 || r.status === 503) {
      await r.body?.cancel().catch(() => undefined);
      if (d.now() > until) throw new Unavailable(`no ${svc.name} instance came free in ${WAIT_FOR_INSTANCE_MS / 60_000} minutes`);
      if (!told) ctx.step(`${svc.name}: waiting for a free instance`);
      await d.sleep(5_000);
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      throw new GenError(`${svc.name} refused Gen's identity (${r.status}): Gen's service account needs roles/run.invoker on it (tools/cpu-cloudrun/deploy.mjs grants it), and ADC must be able to mint ID tokens (docs/cloudrun.md, "Credentials").`);
    }
    if (!r.ok || !r.body) throw new Unavailable(`${svc.name}${route}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
    try {
      for await (const ev of ndjson(r.body)) {
        if (ev.t === 'done' || ev.t === 'error') return ev;
        await onEvent(ev);
      }
    } catch (e: any) {
      if (ctx.signal.aborted) throw new Error('Cancelled');
      if (e instanceof SyntaxError) throw new Unavailable(`${svc.name} answered something that isn't the CPU protocol: ${e.message}`);
      if (e instanceof GenError || /is missing from gs:/.test(e.message)) throw e;
      // The stream broke: ask again (the manifest answers a run that finished meanwhile).
    }
    return null;
  }
}

// ------------------------------------------------------------------ the LOD system's level making

/**
 * Runs one of the LOD system's commands on the service and brings the files back where Gen would have made them.
 * `plan` is what src/lod.ts would give the command here; every `in`/`source` file is uploaded, every `out` stem is
 * replaced by the service's, and each level's `path` comes back as this machine's `<out stem><suffix>`.
 * Returns the command's answer (the last JSON line), as if it ran here.
 */
export async function cpuExec(kind: ExecKind, plan: any, svc: CpuService, o: { signal?: AbortSignal; log?: (s: string) => void } = {}, d: CpuDeps = deps()): Promise<any> {
  const signal = o.signal ?? new AbortController().signal;
  const up = (f: string) => upload(d, svc.bucket, f).then(({ uri, name }) => ({ uri, name }));
  const outs: string[] = [];
  let sent: any;
  if (kind === 'lod-images') {
    sent = { images: await Promise.all((plan.images as { in: string; out: string }[]).map(async (im) => { outs.push(im.out); return { in: await up(im.in), out: path.basename(im.out) }; })) };
  } else {
    outs.push(plan.out);
    sent = { in: await up(plan.in), out: path.basename(plan.out), source: plan.source && fs.existsSync(plan.source) ? await up(plan.source) : undefined };
  }
  const key = crypto.createHash('sha256').update(stableJson({ kind, sent })).digest('hex');
  const out = `gs://${svc.bucket}/cpu/exec/${key}/`;
  const body = JSON.stringify({ key, kind, plan: sent, out });
  const t0 = d.now();
  let end: any = null;
  for (let i = 0; i < 3 && !end; i++) end = await post(d, svc, body, { signal, step: (s) => o.log?.(s) }, async (ev) => { if (ev.t === 'log') o.log?.(String(ev.line)); }, '/exec');
  if (!end) throw new Error(`the connection to ${svc.name} broke 3 times`);
  remember({ tool: `asset.lod:${kind}`, service: svc.name, seconds: Number(end.seconds) || 0, wall: (d.now() - t0) / 1000, cold: !!end.cold, ok: end.t === 'done', at: d.now(), error: end.t === 'done' ? undefined : String(end.message).slice(0, 200) });
  if (end.t !== 'done') throw new Error(`${svc.name}: ${end.message}`);
  // Levels back to this machine: `<out stem><suffix>` beside the asset, exactly where a local run writes them.
  const bring = async (levels: any[] | undefined, stem: string) => {
    for (const l of levels ?? []) {
      const data = await d.store.read(String(l.uri));
      if (!data) throw new Error(`${svc.name}: level ${l.suffix} is missing from ${l.uri}`);
      const file = `${stem}${l.suffix}`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      l.path = file;
      delete l.uri;
      delete l.suffix;
    }
  };
  const result = end.result;
  if (kind === 'lod-images') for (const [i, r] of (result.images ?? []).entries()) await bring(r.levels, outs[i]);
  else await bring(result.levels, outs[0]);
  return result;
}

// ------------------------------------------------------------------ GET /v1/cpu

/** Where each CPU tool runs now, the services, prices and the last requests. */
export function cpuStatus(s: Pick<Settings, 'cpu'>) {
  let spec: CpuSpec | null = null;
  try {
    spec = loadCpuSpec();
  } catch { /* shown as missing */ }
  const services = spec ? Object.fromEntries((Object.keys(spec.classes) as CpuClass[]).map((cls) => [cls, {
    ...spec!.classes[cls], url: s.cpu.cloudrun.urls[cls] ?? null, pricePerSecond: classPrice(spec!, cls), pricePerHour: Math.round(classPrice(spec!, cls) * 3600 * 1000) / 1000,
  }])) : null;
  const done = recent.filter((r) => r.ok);
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  return {
    backend: s.cpu.backend,
    tools: s.cpu.tools,
    bucket: s.cpu.cloudrun.bucket,
    concurrent: s.cpu.cloudrun.concurrent,
    services,
    prices: spec?.prices ?? null,
    suite: describeSuite().map((t) => {
      const r = cpuRoute(t.id, s, spec ?? undefined);
      return { ...t, runs: r.service ? `cloudrun:${r.service.name}` : 'local', why: r.why, class: classOf(t.id) };
    }),
    lod: (() => { const r = cpuRoute('asset.lod', s, spec ?? undefined); return { runs: r.service ? `cloudrun:${r.service.name}` : 'local', why: r.why }; })(),
    staysLocal: STAYS_LOCAL,
    recent: {
      requests: recent.length,
      failures: recent.filter((r) => !r.ok).length,
      coldStarts: recent.filter((r) => r.cold).length,
      medianWallSeconds: median(done.map((r) => r.wall)),
      medianBilledSeconds: median(done.map((r) => r.seconds)),
      last: recent.slice(-20).reverse(),
    },
  };
}
