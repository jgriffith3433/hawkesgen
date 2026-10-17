// Blender on the GPU fleet. A GPU server renders Blender shots (Cycles on the NVIDIA GPU through OptiX) between
// ComfyUI jobs: the queue gives a blender.render job a server like any GPU job, and ComfyUI's models are unloaded
// first (family "blender"), so the two never fight for the GPU.
//
// Blender is installed on a server the first time it's needed (a 374 MB download, about a minute) into
// /opt/blender-<version>, linked as /opt/blender. server/bootstrap.sh installs it too, so new servers and the next
// fleet image have it. A render runs detached from SSH (a transient systemd unit), in /var/tmp/hawkes-blender/<job>,
// and Hawkes Gen follows its log: a dropped connection doesn't stop it and a cancelled job stops it.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sshRun, sshTarget } from '../comfy/fleet.ts';
import { GenError } from '../../util.ts';
import { BLENDER, BLENDER_VERSION, installScript } from './install.ts';

export { BLENDER, BLENDER_VERSION };

const WORK = '/var/tmp/hawkes-blender';

const installed = new Set<string>();

/** Installs Blender on a server once (about a minute). */
export async function ensureBlender(instanceId: string, step: (s: string) => void = () => {}) {
  if (installed.has(instanceId)) return;
  const have = (await sshRun(`${BLENDER} --version 2>/dev/null | head -1 || true`, instanceId)).trim();
  if (!have.includes(`Blender ${BLENDER_VERSION}`)) {
    step(`installing Blender ${BLENDER_VERSION} on ${instanceId} (once, about a minute)`);
    const out = await sshRun(`bash -c ${shq(installScript())} 2>&1 | tail -n 5`, instanceId, { timeoutMs: 15 * 60_000 });
    if (!out.includes(`Blender ${BLENDER_VERSION}`)) throw new GenError(`Blender didn't install on ${instanceId}: ${out.trim().split('\n').slice(-3).join(' / ')}`);
  }
  installed.add(instanceId);
}

/** Single-quotes a string for bash. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function scp(args: string[], instanceId: string) {
  const { ip, key } = await sshTarget(instanceId);
  const full = ['-i', key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-q', ...args.map((a) => a.replace('@HOST:', `ubuntu@${ip}:`))];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('scp', full, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new GenError(`Couldn't run scp (${e.message}).`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new GenError(`scp failed: ${err.trim() || `exit ${code}`}`))));
  });
}

export type BlenderRun = {
  /** The job's folder on the server. */
  dir: string;
  /** Copies local files into the job's folder (name -> local path). */
  put(files: Record<string, string>): Promise<void>;
  /** Writes text files into the job's folder. */
  write(files: Record<string, string>): Promise<void>;
  /** Runs a bash script in the job's folder, detached; resolves when it ends (throws with the log's tail if it fails). */
  run(script: string, opts: { onLine?: (line: string) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  /** Copies a folder of results back (remote, relative to the job's folder) into a local folder. */
  get(remote: string, local: string): Promise<string[]>;
  /** Removes the job's folder. */
  clean(): Promise<void>;
};

/** A workspace on a server for one job. */
export async function blenderWorkspace(instanceId: string, jobId: string): Promise<BlenderRun> {
  if (!/^[\w-]+$/.test(jobId)) throw new GenError('Bad job id');
  const dir = `${WORK}/${jobId}`;
  const unit = `hawkes-blender-${jobId}`;
  await sshRun(`sudo mkdir -p ${WORK} && sudo chown ubuntu:ubuntu ${WORK} && mkdir -p ${dir}/in && echo ok`, instanceId);
  const write = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      if (!/^[\w./-]+$/.test(name) || name.includes('..')) throw new GenError(`Bad file name ${name}`);
      await sshRun(`printf '%s' '${Buffer.from(text).toString('base64')}' | base64 -d > ${dir}/${name} && echo ok`, instanceId);
    }
  };
  return {
    dir,
    async put(files) {
      for (const [name, local] of Object.entries(files)) {
        if (!/^[\w./-]+$/.test(name) || name.includes('..')) throw new GenError(`Bad file name ${name}`);
        await scp([local, `@HOST:${dir}/${name}`], instanceId);
      }
    },
    write,
    async run(script, { onLine = () => {}, signal, timeoutMs = 60 * 60_000 }) {
      await write({ 'run.sh': script });
      await sshRun([
        `sudo systemctl stop ${unit} 2>/dev/null; sudo systemctl reset-failed ${unit} 2>/dev/null`,
        `rm -f ${dir}/exit ${dir}/log.txt`,
        `sudo systemd-run --unit ${unit} --uid ubuntu --setenv=HOME=/home/ubuntu --working-directory=${dir} bash -c 'bash run.sh > log.txt 2>&1; echo $? > exit'`,
        'echo started',
      ].join('; '), instanceId);
      const stop = () => void sshRun(`sudo systemctl stop ${unit}`, instanceId).catch(() => {});
      signal?.addEventListener('abort', stop, { once: true });
      const end = Date.now() + timeoutMs;
      let seen = 0;
      try {
        for (;;) {
          if (signal?.aborted) throw new Error('Cancelled');
          await new Promise((r) => setTimeout(r, 4000));
          // The server's idle stop only watches ComfyUI; a render counts as activity.
          const out = await sshRun(
            `for d in /var/lib/dod /var/lib/gen; do [ -d $d ] && sudo touch $d/last_busy; done; echo "EXIT=$(cat ${dir}/exit 2>/dev/null)"; grep -a -c '' ${dir}/log.txt 2>/dev/null; grep -a -n '^HB ' ${dir}/log.txt 2>/dev/null | tail -n 4`,
            instanceId,
          ).catch(() => '');
          const lines = out.split('\n');
          for (const l of lines.slice(2)) {
            const m = /^(\d+):(HB .*)$/.exec(l.trim());
            if (m && Number(m[1]) > seen) {
              seen = Number(m[1]);
              onLine(m[2].slice(3));
            }
          }
          const code = /^EXIT=(\d*)/.exec(lines[0] ?? '')?.[1];
          if (code) {
            if (code === '0') return;
            const tail = await sshRun(`grep -a -v -E '^(Fra:|HB frame|  )' ${dir}/log.txt | tail -n 25`, instanceId).catch(() => '');
            throw new GenError(`Blender failed (exit ${code}):\n${tail.trim()}`);
          }
          if (Date.now() > end) {
            stop();
            throw new GenError(`The render ran over ${Math.round(timeoutMs / 60_000)} minutes and was stopped`);
          }
        }
      } finally {
        signal?.removeEventListener('abort', stop);
      }
    },
    async get(remote, local) {
      // scp -r into a folder that doesn't exist yet copies the remote folder's contents into it.
      fs.rmSync(local, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(local), { recursive: true });
      await scp(['-r', `@HOST:${dir}/${remote}`, local], instanceId);
      return fs.readdirSync(local).map((f) => path.join(local, f));
    },
    async clean() {
      await sshRun(`rm -rf ${dir}`, instanceId).catch(() => {});
    },
  };
}
