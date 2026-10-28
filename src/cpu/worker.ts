// The CPU service's work (server/cpu-cloudrun/server.ts is only its HTTP door; docs/cpu-cloudrun.md has the protocol):
// run one suite tool, or one of the LOD system's commands, against inputs in Cloud Storage, writing outputs there and
// telling each event to `send`. Kept apart from the HTTP layer so the tests run real tools through it with a folder
// standing in for the bucket. Imports only the suite (pure tools), the seed rule and util: no database, no settings.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Output, RunContext } from '../tools/types.ts';
import { suiteTool, EXEC_KINDS, type ExecKind } from './suite.ts';
import { jobSeed } from '../providers/cloudrun/run.ts';
import { run, GenError } from '../util.ts';

export type Store = {
  write(uri: string, data: Buffer | string, contentType?: string): Promise<unknown>;
  writeJson(uri: string, value: unknown): Promise<unknown>;
  download(uri: string, dest: string): Promise<unknown>;
};
export type WorkerEnv = {
  store: Store;
  /** The Python with Pillow, rembg and numpy (the image's venv). */
  python: string;
  /** Gen's folder in the image (src/, post/). */
  root: string;
  signal: AbortSignal;
  send(ev: Record<string, unknown>): void;
  /** Where the work folders go (the instance's in-memory disk). */
  tmpRoot?: string;
};

type Ref = { uri: string; name: string };
export type ToolRequest = { key: string; job: string; tool: string; version: number; params: Record<string, any>; inputs: Record<string, Ref | Ref[]>; done: number; seeds?: (number | null)[]; out: string };
export type ExecRequest = { key: string; kind: ExecKind; plan: any; out: string };

/** A file name that can't climb out of its folder. */
const safeName = (n: string) => (path.basename(String(n)).replace(/[^\w.\- ]/g, '_') || 'file').slice(0, 120);
const lastJson = (s: string) => JSON.parse(s.trim().split('\n').pop() || '{}');
const mkWork = (env: WorkerEnv) => fs.mkdtempSync(path.join(env.tmpRoot ?? os.tmpdir(), 'cpu-'));

/** Runs one tool to the end. Resolves to the done event, or an error event (never throws). */
export async function runTool(req: ToolRequest, env: WorkerEnv): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const entry = suiteTool(req.tool);
  if (!entry) return { t: 'error', message: `${req.tool} isn't in this service's CPU suite`, stale: true };
  const tool = entry.tool;
  if (tool.version !== req.version) return { t: 'error', message: `this image has ${tool.id} v${tool.version}, Gen asked for v${req.version}: rebuild and deploy the image (tools/cpu-cloudrun/build.mjs)`, stale: true };
  const work = mkWork(env);
  const events: Record<string, unknown>[] = [];
  const keep = (ev: Record<string, unknown>) => { events.push(ev); env.send(ev); };
  try {
    // Inputs, under their own names (tools read extensions), one folder per input so names never collide.
    const inputs: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.inputs ?? {})) {
      const get = async (ref: Ref, i: number) => {
        const dest = path.join(work, 'in', safeName(k), String(i), safeName(ref.name));
        await env.store.download(ref.uri, dest);
        return dest;
      };
      inputs[k] = Array.isArray(v) ? await Promise.all(v.map(get)) : await get(v, 0);
    }
    fs.mkdirSync(path.join(work, 'tmp'), { recursive: true });
    let n = 0;
    const done = Math.max(0, Number(req.done) || 0);
    const ctx: RunContext = {
      job: { id: req.job, client: 'cpu-service', project: '', tool: tool.id, labels: {} },
      params: req.params ?? {},
      inputs,
      done,
      outputs: Array.from({ length: done }, (_, i) => ({ seed: req.seeds?.[i] ?? null })),
      signal: env.signal,
      step: (detail) => env.send({ t: 'step', detail }),
      log: (line) => env.send({ t: 'log', line }),
      tmp: (name) => path.join(work, 'tmp', name),
      emit: async (o: Output) => {
        // A closed request (a cancel, or Gen gone) stops the tool at its next output, even between processes.
        if (env.signal.aborted) throw new Error('Cancelled');
        const i = n++;
        if (i < done) return; // Gen has it already (a retry)
        const ext = o.ext ?? '';
        const uri = `${req.out}${i}${/^\.[\w]{1,8}$/.test(ext) ? ext : ''}`;
        await env.store.write(uri, o.data, o.mime ?? 'application/octet-stream');
        keep({ t: 'emit', i, uri, ext: o.ext, mime: o.mime, seed: o.seed ?? null, title: o.title ?? null, meta: o.meta ?? null, bytes: o.data.length });
      },
      result: (value) => keep({ t: 'result', value }),
      // The same seeds Gen gives a Cloud Run job: params.seed counting up, else derived from the job id.
      seed: (k) => (req.params?.seed ? Number(req.params.seed) + k : jobSeed(req.job, k)),
      usage: (usage) => keep({ t: 'usage', usage }),
      python: (script, args) => run(env.python, [path.join(env.root, 'post', script), ...args], { signal: env.signal }),
    };
    await tool.run(ctx);
    if (env.signal.aborted) throw new Error('Cancelled');
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    // The answer stays in the bucket: a retry after a broken connection (or a Gen restart) reads it instead of running.
    await env.store.writeJson(`${req.out}manifest.json`, { t: 'done', events, seconds, at: Date.now() });
    return { t: 'done', seconds };
  } catch (e: any) {
    const cancelled = env.signal.aborted;
    return { t: 'error', message: cancelled ? 'Cancelled' : String(e?.message ?? e).slice(0, 2000), user: e instanceof GenError, cancelled, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Runs one of the LOD system's commands (src/lod.ts) with this image's Python and Node: `lod-images` (post/lod.py on
 * a batch of images) or `lod-mesh` (src/lod-mesh.ts on one GLB). Each level file goes to the bucket, and the answer
 * gives it as `uri` plus `suffix` (what follows the out stem), so Gen puts it at its own `<stem><suffix>`.
 */
export async function runExec(req: ExecRequest, env: WorkerEnv): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  if (!EXEC_KINDS.includes(req.kind)) return { t: 'error', message: `unknown command ${req.kind}` };
  const work = mkWork(env);
  try {
    const getIn = async (ref: Ref, dir: string) => {
      const dest = path.join(work, dir, safeName(ref.name));
      await env.store.download(ref.uri, dest);
      return dest;
    };
    const planFile = path.join(work, 'plan.json');
    const ship = async (levels: any[] | undefined, stem: string, prefix: string) => {
      for (const l of levels ?? []) {
        const file = String(l.path);
        if (!file.startsWith(stem)) throw new Error(`a level outside its stem: ${file}`);
        l.suffix = file.slice(stem.length);
        l.uri = `${req.out}${prefix}${path.basename(file)}`;
        await env.store.write(l.uri, fs.readFileSync(file), l.suffix.endsWith('.glb') ? 'model/gltf-binary' : 'image/webp');
        delete l.path;
      }
    };
    let result: any;
    if (req.kind === 'lod-images') {
      const images = req.plan?.images as { in: Ref; out: string }[];
      if (!Array.isArray(images) || !images.length) throw new Error('lod-images needs images');
      const local = await Promise.all(images.map(async (im, i) => ({ in: await getIn(im.in, `in/${i}`), out: path.join(work, 'out', String(i), safeName(im.out)) })));
      for (const l of local) fs.mkdirSync(path.dirname(l.out), { recursive: true });
      fs.writeFileSync(planFile, JSON.stringify({ images: local }));
      env.send({ t: 'log', line: `making the levels of ${local.length} image${local.length === 1 ? '' : 's'}` });
      result = lastJson(await run(env.python, [path.join(env.root, 'post', 'lod.py'), planFile], { signal: env.signal }));
      for (const [i, r] of (result.images ?? []).entries()) await ship(r.levels, local[i].out, `${i}/`);
    } else {
      const p = req.plan ?? {};
      const stem = path.join(work, 'out', safeName(p.out));
      fs.mkdirSync(path.dirname(stem), { recursive: true });
      const plan = { in: await getIn(p.in, 'in/model'), out: stem, python: env.python, script: path.join(env.root, 'post', 'lod.py'), source: p.source ? await getIn(p.source, 'in/source') : undefined };
      fs.writeFileSync(planFile, JSON.stringify(plan));
      env.send({ t: 'log', line: 'making the model\'s levels' });
      result = lastJson(await run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(env.root, 'src', 'lod-mesh.ts'), planFile], { signal: env.signal }));
      await ship(result.levels, stem, '');
    }
    return { t: 'done', result, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } catch (e: any) {
    return { t: 'error', message: env.signal.aborted ? 'Cancelled' : String(e?.message ?? e).slice(0, 2000), cancelled: env.signal.aborted, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
