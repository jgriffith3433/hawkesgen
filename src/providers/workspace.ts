// Where the 3D tools (blender.character, mesh.rig, motion.from-text, motion.from-video, blender.render) run their
// scripts. Every one of them does the same four things: put files into a job folder, write a few small text files, run
// one bash script there, and bring a folder of results back. That folder lives in one of two places:
//
//   the fleet       a GPU server over SSH (src/providers/blender/blender.ts blenderWorkspace): installs on first use,
//                   the folder survives between runs of the same job
//   a GPU worker    any provider running the 3D worker image (server/gpu3d/, docs/3d-animation.md): RunPod, Modal or
//                   any HTTPS host. Each run() is ONE request ({ hawkes_job }) through the same protocol a ComfyUI graph
//                   uses (src/providers/cloudrun/run.ts): the files go up by content, the worker writes them into
//                   /var/tmp/hawkes-blender/<job>, runs the script, and sends back the folders asked for. Nothing
//                   survives between two runs, so every run carries every file and text written so far.
//
// The scripts are the same in both places: the image installs Blender, the rig, motion and mocap venvs at the paths the
// fleet installs use (/opt/blender, /opt/hawkes-rig, /opt/hawkes-motion, /opt/hawkes-mocap). Weights are fetched on the
// worker by the script's own weights step (HAWKES_WEIGHTS: a provider volume when one is mounted).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ComfyRun } from '../tools/types.ts';
import type { ComfyFile } from './comfy/client.ts';
import { GenError } from '../util.ts';
import { blenderWorkspace, ensureBlender } from './blender/blender.ts';

/** The job folder's root on a fleet server and on a worker (the scripts name absolute paths under it). */
export const JOB_ROOT = '/var/tmp/hawkes-blender';

export type Workspace = {
  /** The job's folder where the script runs (absolute; the specs name files under it). */
  dir: string;
  /** True when the folder survives between run() calls (the fleet). A worker starts each run from the files sent. */
  persistent: boolean;
  /** Where it runs, for steps ("the GPU server", "runpod-3d"). */
  where: string;
  /** Copies local files into the job's folder (name -> local path). */
  put(files: Record<string, string>): Promise<void>;
  /** Writes text files into the job's folder. */
  write(files: Record<string, string>): Promise<void>;
  /** Runs a bash script in the job's folder. `collect`: the folders get() will ask for (a worker sends only those back; default res). */
  run(script: string, opts: { onLine?: (line: string) => void; signal?: AbortSignal; timeoutMs?: number; collect?: string[] }): Promise<void>;
  /** Copies a folder of results back (relative to the job's folder) into a local folder. */
  get(remote: string, local: string): Promise<string[]>;
  /** Removes the job's folder. */
  clean(): Promise<void>;
};

const NAME = /^[\w./-]+$/;
const safeName = (name: string) => {
  if (!NAME.test(name) || name.includes('..') || name.startsWith('/')) throw new GenError(`Bad file name ${name}`);
  return name;
};

/** The request a worker runs instead of a graph (server/cloudrun/worker.py `_job`). */
export type JobRequest = {
  hawkes_job: {
    dir: string;
    script: string;
    /** Name in the job folder -> the uploaded input's name (the protocol sends the file along because the request names it). */
    files: Record<string, string>;
    texts: Record<string, string>;
    collect: string[];
  };
};

/** A worker's answer to a request it doesn't know (an image from before the 3D stack, or the ComfyUI image). */
const OLD_IMAGE = /hawkes_job/;

/**
 * The workspace on a GPU worker. `stage` is a local scratch folder (removed by clean()). Uploads are cached by local
 * path for the job, so a second run (blender.character's robot labelling) sends nothing twice.
 */
export function workerWorkspace(c: ComfyRun, jobId: string, stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkes-ws-'))): Workspace {
  if (!/^[\w-]+$/.test(jobId)) throw new GenError('Bad job id');
  const dir = `${JOB_ROOT}/${jobId}`;
  const files: Record<string, string> = {};
  const texts: Record<string, string> = {};
  const uploaded = new Map<string, string>();
  const where = c.server.id.replace(/^cloudrun:/, '');
  let fetched = new Set<string>();
  return {
    dir,
    persistent: false,
    where,
    async put(more) {
      for (const [name, local] of Object.entries(more)) {
        safeName(name);
        if (!fs.existsSync(local)) throw new GenError(`No such file to send: ${local}`);
        files[name] = local;
      }
    },
    async write(more) {
      for (const [name, text] of Object.entries(more)) texts[safeName(name)] = text;
    },
    async run(script, { onLine = () => {}, collect = ['res'] } = {}) {
      for (const d of collect) safeName(d);
      const sent: Record<string, string> = {};
      for (const [name, local] of Object.entries(files)) {
        let up = uploaded.get(local);
        if (!up) {
          up = await c.upload(local);
          uploaded.set(local, up);
        }
        sent[name] = up;
      }
      const req: JobRequest = { hawkes_job: { dir, script, files: sent, texts: { ...texts }, collect } };
      let out: ComfyFile[];
      try {
        out = await c.runGraph(req as any);
      } catch (e: any) {
        // The ComfyUI image (or a 3D image from before this request) hands it to ComfyUI, which refuses it: that
        // provider can't run 3D jobs; the queue cools it down and tries the next one.
        if (OLD_IMAGE.test(String(e?.message)) && /class_type|missing_node_type|not a graph|3D worker image/.test(String(e?.message))) {
          throw Object.assign(new Error(`${where} doesn't run the 3D worker image (server/gpu3d): give the 3D families their own endpoint (docs/3d-animation.md, "Setting it up")`), { unavailable: true });
        }
        throw e;
      }
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(stage, { recursive: true });
      fetched = new Set();
      let hb: string | null = null;
      for (const f of out) {
        const rel = safeName(String(f.filename).replace(/\\/g, '/'));
        const data = await c.download(f);
        if (rel === '_hb.txt') { hb = data.toString('utf8'); continue; }
        const dest = path.join(stage, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data);
        fetched.add(rel.split('/')[0]);
      }
      // The worker keeps the script's "HB ..." lines; the tool sees them as it would have live (warnings into the log).
      for (const line of (hb ?? '').split('\n')) if (line.startsWith('HB ')) onLine(line.slice(3));
    },
    async get(remote, local) {
      safeName(remote);
      const src = path.join(stage, remote);
      fs.rmSync(local, { recursive: true, force: true });
      fs.mkdirSync(local, { recursive: true });
      if (!fs.existsSync(src)) {
        if (!fetched.has(remote.split('/')[0])) throw new GenError(`${remote} was not collected from the worker (pass collect: ["${remote}"] to run)`);
        return [];
      }
      fs.cpSync(src, local, { recursive: true });
      return fs.readdirSync(local).map((f) => path.join(local, f));
    },
    async clean() {
      fs.rmSync(stage, { recursive: true, force: true });
    },
  };
}

/** The fleet's SSH workspace in the same shape. */
async function sshWorkspace(instanceId: string, jobId: string): Promise<Workspace> {
  const ws = await blenderWorkspace(instanceId, jobId);
  return {
    dir: ws.dir,
    persistent: true,
    where: instanceId,
    put: ws.put,
    write: ws.write,
    run: (script, opts) => ws.run(script, opts),
    get: ws.get,
    clean: ws.clean,
  };
}

/** The job's workspace wherever the queue placed it: a fleet server (ComfyUI client present) or a GPU worker. */
export async function jobWorkspace(c: ComfyRun, jobId: string): Promise<Workspace> {
  return c.comfy ? sshWorkspace(c.server.id, jobId) : workerWorkspace(c, jobId);
}

/** What a 3D job needs installed. On the fleet each is installed over SSH on first use; the worker image has them all. */
export type Need = 'blender' | 'rig' | 'motion' | 'mocap';

export async function prepare3d(c: ComfyRun, needs: Need[], step: (s: string) => void) {
  if (!c.comfy) return;
  if (needs.includes('blender')) await ensureBlender(c.server.id, step);
  // Imported lazily: each installer pulls in its own install script.
  if (needs.includes('rig')) await (await import('./rig/rig.ts')).ensureRig(c.server.id, step);
  if (needs.includes('motion')) await (await import('./motion/motion.ts')).ensureMotion(c.server.id, step);
  if (needs.includes('mocap')) await (await import('./mocap/mocap.ts')).ensureMocap(c.server.id, step);
}

/**
 * The first lines of every 3D job script: on a worker (HAWKES_WEIGHTS set) the weights each model needs are fetched
 * once into the weights folder (a provider volume when mounted) under a lock, then linked where the code expects them.
 * On the fleet the installers already put them there, and HAWKES_WEIGHTS is unset, so this does nothing.
 */
export function weightsPrelude(parts: string[]) {
  const body = parts.filter(Boolean);
  if (!body.length) return '';
  return [
    'if [ -n "${HAWKES_WEIGHTS:-}" ]; then',
    '  mkdir -p "$HAWKES_WEIGHTS/hf"',
    '  export HAWKES_HF_HOME="$HAWKES_WEIGHTS/hf"',
    ...body.map((b) => b.split('\n').map((l) => `  ${l}`).join('\n')),
    'fi',
  ].join('\n');
}
