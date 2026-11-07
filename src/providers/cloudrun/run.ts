// What a ComfyUI tool gets (ctx.comfy) when its job runs on a Cloud Run GPU service instead of a fleet server
// (docs/cloudrun.md). The tool's code is the same: it uploads, runs graphs and downloads. Underneath:
//
//   upload     the file goes to gs://<bucket>/cloudrun/inputs/<sha256><ext> (once per content); the graph refers to it
//              by the same name a fleet server would give it (hawkesgen/<sha16><ext>)
//   runGraph   ONE request to the service runs the graph to the end on whichever instance takes it, with every input
//              it names as a gs:// URI: nothing depends on reaching the same instance twice. The answer streams progress
//              and lists the outputs, which the instance wrote to gs://<bucket>/cloudrun/runs/<key>/
//   download   reads an output back from the bucket
//   ensureModels   models the service doesn't preload ride along with each request (the instance fetches them)
//
// The run key is sha256(job id + graph). Jobs on Cloud Run get seeds derived from their id (jobs.ts), so a job picked
// up again after a restart rebuilds the same graphs and the same keys: a run that finished is answered from its
// manifest.json without the GPU, and one still going (its heartbeat.json moved in the last minute) is waited for.
// Cancelling writes runs/<key>/cancel, which the instance checks every few seconds; a client that merely disconnects
// (a Gen restart) does not cancel.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ComfyRun } from '../../tools/types.ts';
import type { ComfyFile, Graph } from '../comfy/client.ts';
import type { ModelRef } from '../../workflows/convert.ts';
import type { CloudService } from './services.ts';
import { gcs, gcpTokens, type Gcs } from '../gcp/gcs.ts';
import { env } from '../../config.ts';
import { GenError } from '../../util.ts';
import { brokerToken, brokerUrl } from '../gpu/broker.ts';
import { runpodCreditProblem } from '../gpu/credit.ts';
import { healthOf } from '../gpu/health.ts';

/** A heartbeat younger than this means the run is still going on some instance. */
const FRESH_MS = 60_000;
/** How long a job waits for a free instance (the service at max instances answers 429) before failing. */
const WAIT_FOR_INSTANCE_MS = 45 * 60_000;
/** How long past its wait a provider's cold worker may take to answer at all (its first pull of a new image). */
const COLD_START_MS = 12 * 60_000;
// An endpoint that ran a job this recently still has a worker up (Modal's scaledown_window is 20 minutes); after that, a
// wait is a worker starting from cold (pulling the image, starting ComfyUI: several minutes), not a queue.
const WARM_MS = 20 * 60_000;

export type CloudFile = ComfyFile & { uri: string; bytes?: number };
export type RunDeps = {
  store: Pick<Gcs, 'stat' | 'read' | 'readJson' | 'write' | 'writeJson'>;
  fetch: typeof fetch;
  idToken: (audience: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

let override: RunDeps | null = null;
/** Tests swap in a fake service and bucket. */
export function setCloudDeps(d: RunDeps | null) {
  override = d;
}

export const defaultDeps = (): RunDeps => override ?? ({
  store: gcs(),
  fetch: (input, init) => fetch(input, init),
  idToken: (aud) => gcpTokens().id(aud),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
});

/** JSON with sorted keys, so the same graph always hashes the same. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

export const runKey = (jobId: string, graph: unknown) => crypto.createHash('sha256').update(`${jobId}\n${stableJson(graph)}`).digest('hex');

/** A random-looking seed that is the same every time for this job and take (Cloud Run jobs' runs stay idempotent). */
export const jobSeed = (jobId: string, n: number) => (crypto.createHash('sha256').update(`${jobId}:${n}`).digest().readUInt32BE(0) % (2 ** 31 - 2)) + 1;

/** Every input name the graph uses (string values that contain one of the uploaded names). */
export function inputsOf(graph: unknown, names: Map<string, string>): Record<string, string> {
  const used: Record<string, string> = {};
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const [name, uri] of names) if (v.includes(name)) used[name] = uri;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(graph);
  return used;
}

/** Reads an NDJSON stream line by line. */
export async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim());
}

export type CloudHooks = {
  step(detail: string): void;
  /** Progress that shouldn't fill the log (each poll). */
  progress(detail: string): void;
  /** Keeps the graph with the job (dashboard -> job). */
  keepGraph(graph: Graph): void;
  /** Instance seconds a run took (and the cold start it paid for), for the job's cost. */
  addSeconds(seconds: number, startupSeconds: number): void;
  signal: AbortSignal;
};

export type CloudComfyRun = ComfyRun & { service: CloudService };

export function cloudComfyRun(job: { id: string }, svc: CloudService, hooks: CloudHooks, deps: RunDeps = defaultDeps()): CloudComfyRun {
  const base = `gs://${svc.bucket}/cloudrun`;
  /** Input name -> gs:// URI. */
  const names = new Map<string, string>();
  const known = new Set<string>();
  const pending = new Map<string, ModelRef>();

  const uploadBuffer = async (data: Buffer, name: string) => {
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const ext = path.extname(name).toLowerCase();
    const uri = `${base}/inputs/${sha}${ext}`;
    if (!known.has(uri)) {
      if (!(await deps.store.stat(uri))) await deps.store.write(uri, data);
      known.add(uri);
    }
    const local = `hawkesgen/${sha.slice(0, 16)}${ext}`;
    names.set(local, uri);
    return local;
  };

  const cancelled = (key: string) => {
    void deps.store.write(`${base}/runs/${key}/cancel`, 'cancel', 'text/plain').catch(() => undefined);
    return new Error('Cancelled');
  };

  /** The final line of a run: its files, or an error that says what happened. */
  const finish = (m: any): CloudFile[] => {
    hooks.addSeconds(Number(m.seconds) || 0, Number(m.cold?.startupSeconds) || 0);
    // What the graph held on the card at its peak (the worker samples it; older images don't send it).
    if (m.vram?.peakMB) hooks.step(`${svc.name}: GPU memory at peak ${(m.vram.peakMB / 1024).toFixed(1)} GB of ${(m.vram.totalMB / 1024).toFixed(0)} GB${m.vram.gpu ? ` (${m.vram.gpu})` : ''}, ${m.seconds} s on the worker`);
    if (m.t === 'done') return (m.files ?? []) as CloudFile[];
    if (m.cancelled) throw new Error('Cancelled');
    if (m.missingModels?.length) {
      throw new GenError(`${m.message}\n${svc.name} doesn't have ${m.missingModels.join(', ')}: copy it into the models bucket (node tools/cloudrun/models-sync.mjs --apply) and add it to the service in server/cloudrun/services.json.`);
    }
    // The worker's disk is full (a provider's container disk, models and voices filling it): that worker can't take the
    // job, so the provider cools down and the job goes to the next one in its order, as when no GPU is free (J,
    // 2026-10-30: audio failed on "runpod: [Errno 28] No space left on device").
    if (/No space left on device|Errno 28|ENOSPC/i.test(String(m.message ?? ''))) throw unavailable(`${svc.name}: the ${where} worker ran out of disk`, { diskFull: true });
    throw Object.assign(new Error(`${svc.name}: ${m.message}`), { lost: !!m.lost, overLimit: !!m.overLimit });
  };

  const runGraph = async (graph: Graph): Promise<CloudFile[]> => {
    hooks.keepGraph(graph);
    const key = runKey(job.id, graph);
    const out = `${base}/runs/${key}/`;
    // Secrets ride in `extra`, never in the graph (which is kept with the job and makes the run key). A 3D job's script
    // gets Gen's Hugging Face token for gated weights (Kimodo's Llama 3 text encoder).
    const hf = (graph as any)?.hawkes_job ? env('HF_TOKEN') || env('HUGGING_FACE_HUB_TOKEN') : '';
    const extra = env('COMFY_ORG_API_KEY') || hf ? { ...(env('COMFY_ORG_API_KEY') ? { api_key_comfy_org: env('COMFY_ORG_API_KEY') } : {}), ...(hf ? { hf_token: hf } : {}) } : undefined;
    // Elsewhere (no preloads) every model of the family's service that the graph names rides along too.
    const models = new Map([...pending.values()].map(({ dir, file }) => [`${dir}/${file}`, { dir, file }]));
    if (svc.broker) {
      const text = JSON.stringify(graph);
      for (const id of svc.familyModels ?? []) {
        const [dir, ...rest] = id.split('/');
        const file = rest.join('/');
        if (file && text.includes(file) && !models.has(id)) models.set(id, { dir, file });
      }
    }
    // A worker without a Google identity reaches the bucket through Gen with this run's token (gpu/broker.ts).
    const store = svc.broker ? { broker: brokerUrl(), token: brokerToken(key, svc.bucket) } : undefined;
    const body = JSON.stringify({ key, graph, files: inputsOf(graph, names), models: [...models.values()], out, timeoutSeconds: svc.graphLimitSeconds, extra, store });
    const started = deps.now();
    let posts = 0;
    let waitedSince = 0;
    for (;;) {
      if (hooks.signal.aborted) throw cancelled(key);
      // Finished before (Gen restarted after the run ended): the answer is in the bucket.
      const done = await deps.store.readJson(`${out}manifest.json`).catch(() => null);
      if (done?.t === 'done') {
        hooks.step(`${svc.name}: this graph already ran (answer from its manifest)`);
        return finish(done);
      }
      // Still going on an instance (a Gen restart, or the connection dropped): wait for it rather than run it twice.
      const beat = await deps.store.readJson(`${out}heartbeat.json`).catch(() => null);
      if (beat && deps.now() - Number(beat.at) < FRESH_MS) {
        if (!waitedSince) {
          waitedSince = deps.now();
          hooks.step(`${svc.name}: the graph is still running on Cloud Run (${beat.detail ?? 'running'}); waiting for it`);
        } else hooks.progress(`${svc.name}: ${beat.detail ?? 'running'}`);
        await deps.sleep(10_000);
        continue;
      }
      if (posts >= 3) throw new Error(`${svc.name}: the connection to Cloud Run broke ${posts} times and the run left no answer`);
      posts++;
      waitedSince = 0;
      const result = await post(key, body);
      if (result) return finish(result);
      // The stream ended with no answer: loop to read the manifest or follow the heartbeat.
      if (deps.now() - started > (svc.graphLimitSeconds + 300) * 1000) {
        throw Object.assign(new Error(`${svc.name}: the run passed Cloud Run's time limit`), { overLimit: true });
      }
      hooks.step(`${svc.name}: the connection ended before the answer; checking the run`);
    }
  };

  const where = svc.provider && svc.provider !== 'cloudrun' ? svc.provider : 'Cloud Run';
  /** The provider can't take the job now: the queue cools it down and hands the job to the next one (gpu/route.ts). */
  const unavailable = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { unavailable: true, ...extra });
  const headers = async (): Promise<Record<string, string>> => {
    if (svc.headers) return { ...svc.headers(), 'Content-Type': 'application/json' };
    return { Authorization: `Bearer ${await deps.idToken(svc.url)}`, 'Content-Type': 'application/json' };
  };

  /** One POST /run. -> the final line, or null when the stream broke first. */
  const post = async (key: string, body: string): Promise<any | null> => {
    const elsewhere = Boolean(svc.provider && svc.provider !== 'cloudrun');
    const lastOk = healthOf(svc.lane ?? svc.name).lastOk;
    const cold = elsewhere && (!lastOk || deps.now() - lastOk > WARM_MS);
    const until = deps.now() + (svc.waitForInstanceMs ?? WAIT_FOR_INSTANCE_MS);
    // Said up front: a provider's gateway may hold the request the whole time without a word.
    if (cold) hooks.step(`${svc.name}: starting a ${where} GPU (none has run for a while; a cold start takes several minutes)`);
    for (let told = false; ; told = true) {
      if (hooks.signal.aborted) throw cancelled(key);
      // An empty RunPod balance starts no worker and its gateway just waits (gpu/credit.ts): hand the job on.
      const broke = svc.provider === 'runpod' ? runpodCreditProblem() : null;
      if (broke) throw unavailable(`${svc.name}: ${broke}`, { capacity: true });
      let r: Response;
      try {
        r = await deps.fetch(`${svc.url}/run`, { method: 'POST', headers: await headers(), body, signal: hooks.signal });
      } catch (e: any) {
        if (hooks.signal.aborted) throw cancelled(key);
        if (e.unavailable) throw e;
        // A provider's gateway holds the request while a worker starts; a new image's first start on a host pulls it
        // (minutes), past fetch's 5-minute wait for headers. That is a worker on its way, not an unreachable service.
        const starting = e.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' && elsewhere && deps.now() < until + COLD_START_MS;
        hooks.step(starting ? `${svc.name}: a ${where} GPU is still starting (a first start pulls the image); waiting` : `${svc.name}: ${e.cause?.code ?? e.message}; trying again`);
        await deps.sleep(10_000);
        if (!starting && deps.now() > until) throw unavailable(`${svc.name}: couldn't reach the service (${e.cause?.code ?? e.message})`);
        continue;
      }
      // Every instance busy (max instances) or one still starting: Cloud Run says 429 or 503, RunPod's load balancer
      // 400 "failed to assign worker" (no GPU of its types free right now). Wait our turn.
      const noWorker = r.status === 400 && svc.provider === 'runpod' && /failed to assign worker/i.test(await r.clone().text().catch(() => ''));
      if (r.status === 429 || r.status === 503 || noWorker) {
        await r.body?.cancel().catch(() => undefined);
        // A worker starting from cold answers 429/503 until it is up: it gets the cold start's time too. RunPod's "failed
        // to assign worker" is no GPU free, not a start.
        const limit = until + (cold && !noWorker ? COLD_START_MS : 0);
        if (deps.now() > limit) throw unavailable(`${svc.name}: no ${where} GPU came free in ${Math.round((limit - until + (svc.waitForInstanceMs ?? WAIT_FOR_INSTANCE_MS)) / 60_000)} minutes`, { capacity: true });
        if (!told && !(cold && !noWorker)) hooks.step(`${svc.name}: waiting for a free ${where} GPU`);
        await deps.sleep(15_000);
        continue;
      }
      if ((r.status === 401 || r.status === 403) && svc.provider && svc.provider !== 'cloudrun') {
        throw unavailable(`${svc.name} (${svc.provider}) refused Gen's credentials (${r.status}): check its key in Gen's environment (docs/gpu-providers.md)`, { auth: true });
      }
      if (r.status === 401 || r.status === 403) {
        throw new GenError(`${svc.name} refused Gen's identity (${r.status}): Gen's service account needs roles/run.invoker on it (tools/cloudrun/deploy.mjs grants it), and ADC must be able to mint ID tokens (docs/cloudrun.md, "Credentials").`);
      }
      if (!r.ok || !r.body) throw new Error(`${svc.name} /run: ${r.status} ${(await r.text().catch(() => '')).slice(0, 400)}`);
      try {
        for await (const ev of ndjson(r.body)) {
          if (ev.t === 'progress') hooks.progress(`${svc.name}: ${ev.detail}`);
          else if (ev.t === 'done' || ev.t === 'error') return ev;
        }
      } catch (e: any) {
        if (hooks.signal.aborted) throw cancelled(key);
        if (e instanceof SyntaxError) throw new Error(`${svc.name} answered something that isn't the run protocol: ${e.message}`);
        // The stream broke: the run may still be going on the instance (it keeps going without us).
      }
      return null;
    }
  };

  return {
    service: svc,
    server: { id: `cloudrun:${svc.name}`, region: 'gcp', price: svc.pricePerSecond * 3600 },
    upload: (file: string) => uploadBuffer(fs.readFileSync(file), file),
    uploadBuffer,
    runGraph,
    async download(file: ComfyFile) {
      const uri = (file as CloudFile).uri;
      if (!uri) throw new Error(`${file.filename} has no Cloud Storage copy`);
      const data = await deps.store.read(uri);
      if (!data) throw new Error(`${uri} is gone from the bucket`);
      return data;
    },
    async ensureModels(models: ModelRef[]) {
      for (const m of models) {
        const id = `${m.dir}/${m.file}`;
        if (!svc.preload.has(id)) pending.set(id, m);
      }
    },
    // Nothing here runs outside a request (a 3D job's script is one request too: src/providers/workspace.ts).
    timed: <T>(work: () => Promise<T>) => work(),
  };
}
