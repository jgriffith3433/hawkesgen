// A small client for the ComfyUI HTTP API, through a GPU server's nginx
// proxy. Ported from Dose Of Destruction's tools/gpu/comfy.mjs.
//
//   upload()   puts an image or video in ComfyUI's input folder
//   prepare()  fills unset node settings from the server's own defaults and
//              checks every node, input and model file exists before queueing
//   run()      queues a graph, waits for it, and returns its output files
//
// ComfyUI restarts behind the server's nginx (a server just started, which says "ready" from its last boot before
// ComfyUI is up; a crash, often out of memory): nginx answers 502 meanwhile. Requests wait that out (up to waitMs)
// instead of failing the job (2026-10-19: half of Yooba Land's mesh.textured jobs failed on "/upload/image: 502").

import type { Endpoint } from './fleet.ts';

/** What nginx answers while ComfyUI is down or starting behind it. */
const STARTING = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ComfyFile = { filename: string; subfolder: string; type: string; node?: string };
export type Graph = Record<string, { class_type: string; inputs: Record<string, any> }>;

export class Comfy {
  url: string;
  headers: Record<string, string>;
  info: any = null;
  /** How long a request waits for ComfyUI to come back, and the pause between tries. */
  waitMs: number;
  pauseMs: number;

  constructor({ url, headers }: Pick<Endpoint, 'url' | 'headers'>, { waitMs = 180_000, pauseMs = 5000 } = {}) {
    this.url = url.replace(/\/$/, '');
    this.headers = headers;
    this.waitMs = waitMs;
    this.pauseMs = pauseMs;
  }

  async request(route: string, init: RequestInit = {}) {
    const until = Date.now() + this.waitMs;
    // A 504 may mean ComfyUI got the graph and was slow to answer: queueing it again would run it twice.
    const retryable = (status: number) => STARTING.has(status) && !(status === 504 && route === '/prompt');
    for (;;) {
      let r: Response;
      try {
        r = await fetch(`${this.url}${route}`, { ...init, headers: { ...this.headers, ...((init.headers as any) ?? {}) } });
      } catch (e: any) {
        // Refused or reset: the server is booting or ComfyUI restarting.
        if (Date.now() < until && !init.signal?.aborted) {
          await sleep(this.pauseMs);
          continue;
        }
        throw new Error(`ComfyUI ${route}: ${e.cause?.code ?? e.message}`);
      }
      if (r.ok) return r;
      const body = await r.text().catch(() => '');
      if (retryable(r.status) && Date.now() < until && !init.signal?.aborted) {
        await sleep(this.pauseMs);
        continue;
      }
      if (STARTING.has(r.status)) {
        throw new Error(`ComfyUI ${route}: ${r.status} for ${Math.round(this.waitMs / 1000)} s: ComfyUI isn't answering on the server (still starting, or it crashed: often out of memory; the server log says which)`);
      }
      throw new Error(`ComfyUI ${route}: ${r.status} ${body.slice(0, 600)}`);
    }
  }

  /**
   * Waits until ComfyUI answers (up to timeoutMs). onWait is called once if it doesn't straight away. A server started
   * from stopped says "ready" from its last boot while ComfyUI is still loading its custom nodes.
   */
  async ready({ timeoutMs = 300_000, onWait, signal }: { timeoutMs?: number; onWait?: () => void; signal?: AbortSignal } = {}) {
    const until = Date.now() + timeoutMs;
    for (let told = false; ; told = true) {
      const r = await fetch(`${this.url}/system_stats`, { headers: this.headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (r?.ok) return;
      const status = r?.status ?? 0;
      await r?.body?.cancel().catch(() => undefined);
      if (status && !STARTING.has(status)) throw new Error(`ComfyUI /system_stats: ${status}`);
      if (signal?.aborted) throw new Error('Cancelled');
      if (Date.now() >= until) throw new Error(`ComfyUI didn't answer on the server within ${Math.round(timeoutMs / 60_000)} minutes (still starting, or it keeps crashing; the server log says which)`);
      if (!told) onWait?.();
      await sleep(this.pauseMs);
    }
  }

  async json(route: string, init?: RequestInit) {
    return (await this.request(route, init)).json();
  }

  /** Unloads every model from the GPU so another family of models fits. */
  async free() {
    await this.request('/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
  }

  async stats() {
    return this.json('/system_stats');
  }

  async objectInfo() {
    this.info ??= await this.json('/object_info');
    return this.info;
  }

  /** Uploads a file into input/<subfolder>/ and returns the name nodes refer to it by. */
  async upload(buffer: Buffer, filename: string, subfolder = 'hawkesgen') {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(buffer)]), filename);
    form.append('subfolder', subfolder);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const r = await this.json('/upload/image', { method: 'POST', body: form });
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }

  /**
   * Checks a graph against the server's node definitions. Required settings a
   * graph leaves out get the node's default; anything else wrong is reported
   * before the GPU spends time on it. Returns the model files the graph names
   * that the server doesn't have (so the caller can sync them).
   */
  async prepare(graph: Graph) {
    const info = await this.objectInfo();
    const problems: string[] = [];
    const missingModels: string[] = [];
    for (const [nodeId, node] of Object.entries(graph)) {
      const def = info[node.class_type];
      if (!def) {
        problems.push(`node ${nodeId}: ${node.class_type} is not installed on the server`);
        continue;
      }
      const required = def.input?.required ?? {};
      const optional = def.input?.optional ?? {};
      const keys = Object.keys(node.inputs);
      for (const [name, spec] of Object.entries<any>(required)) {
        if (name in node.inputs || keys.some((k) => k.startsWith(`${name}.`))) continue;
        const [type, opts] = spec;
        if (type === 'COMFY_AUTOGROW_V3') continue;
        if (Array.isArray(type)) node.inputs[name] = opts?.default ?? type[0];
        else if (opts && 'default' in opts) node.inputs[name] = opts.default;
        else problems.push(`node ${nodeId} (${node.class_type}): missing ${name}`);
      }
      for (const name of Object.keys(node.inputs)) {
        if (name in required || name in optional) continue;
        // ComfyUI's dynamic inputs (V3) are sent with dotted names: "format.codec", "values.a".
        const root = required[name.split('.')[0]] ?? optional[name.split('.')[0]];
        if (name.includes('.') && root && /^COMFY_(DYNAMICCOMBO|AUTOGROW)_V3$/.test(root[0])) continue;
        if (def.input?.hidden?.[name]) continue;
        problems.push(`node ${nodeId} (${node.class_type}): no input called ${name}`);
      }
      for (const [name, value] of Object.entries(node.inputs)) {
        const spec = required[name] ?? optional[name];
        const choices = Array.isArray(spec?.[0]) ? spec[0] : spec?.[0] === 'COMBO' ? spec?.[1]?.options : null;
        if (choices && typeof value === 'string' && /\.(safetensors|ckpt|pt|pth|onnx|gguf)$/.test(value) && !choices.includes(value)) {
          missingModels.push(value);
          problems.push(`node ${nodeId} (${node.class_type}): ${value} is not on the server`);
        }
      }
    }
    if (problems.length) {
      const e: any = new Error(`The workflow doesn't match the server:\n  ${problems.join('\n  ')}`);
      e.missingModels = missingModels;
      throw e;
    }
    return graph;
  }

  /** Queues a graph and waits for it. Returns the output files it saved. */
  async run(graph: Graph, { onProgress, timeoutMs = 60 * 60 * 1000, signal }: { onProgress?: (s: string) => void; timeoutMs?: number; signal?: AbortSignal } = {}) {
    await this.prepare(graph);
    const queued = await this.json('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: 'hawkesgen' }),
    });
    if (queued.node_errors && Object.keys(queued.node_errors).length) {
      throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(queued.node_errors).slice(0, 800)}`);
    }
    const promptId = queued.prompt_id;
    const started = Date.now();
    // Polls in a row where the graph was neither in the history nor in the queue: ComfyUI restarted and lost it.
    let gone = 0;
    for (;;) {
      if (signal?.aborted) {
        await this.request('/interrupt', { method: 'POST' }).catch(() => undefined);
        throw new Error('Cancelled');
      }
      if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for ComfyUI');
      const hist = await this.json(`/history/${promptId}`);
      const entry = hist[promptId];
      if (entry) {
        const st = entry.status ?? {};
        if (st.status_str === 'error') {
          const err = (st.messages ?? []).find((m: any) => m[0] === 'execution_error')?.[1];
          throw new Error(`ComfyUI failed in ${err?.node_type ?? 'a node'}: ${err?.exception_message ?? 'see the server log'}`);
        }
        if (st.completed || entry.outputs) return { id: promptId, files: outputFiles(entry.outputs ?? {}), seconds: (Date.now() - started) / 1000 };
      } else {
        const q = await this.json('/queue').catch(() => null);
        const inQueue = (list: any) => (Array.isArray(list) ? list : []).some((p: any) => p?.[1] === promptId);
        gone = q && !inQueue(q.queue_running) && !inQueue(q.queue_pending) ? gone + 1 : 0;
        if (gone >= 3) throw Object.assign(new Error('ComfyUI restarted while running the workflow and lost it (it most likely ran out of memory)'), { lost: true });
        const ahead = q ? (q.queue_pending ?? []).findIndex((p: any) => p[1] === promptId) : -1;
        onProgress?.(ahead > 0 ? `waiting behind ${ahead} job${ahead > 1 ? 's' : ''} on the server` : `running for ${Math.round((Date.now() - started) / 1000)}s`);
      }
      await sleep(3000);
    }
  }

  async download(file: ComfyFile) {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' });
    return Buffer.from(await (await this.request(`/view?${q}`)).arrayBuffer());
  }
}

function outputFiles(outputs: Record<string, any>): ComfyFile[] {
  // Every file any node saved, whatever it calls its list (images, gifs, videos, audio, 3d...).
  const files: ComfyFile[] = [];
  for (const [node, out] of Object.entries(outputs)) {
    for (const list of Object.values(out ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const f of list) {
        if (f && typeof f === 'object' && typeof f.filename === 'string' && (f.type ?? 'output') === 'output') files.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output', node });
      }
    }
  }
  return files;
}
