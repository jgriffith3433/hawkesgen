// Installs an open audio model on a GPU server on first use, and follows an install already under way.

import path from 'node:path';
import { makeRoom, sshRun } from '../comfy/fleet.ts';
import { shq } from '../blender/blender.ts';
import { env, paths } from '../../config.ts';
import { GenError, sleep } from '../../util.ts';
import { AUDIO_MODELS } from '../../audio/registry.ts';
import { ASR_ID, AUDIO_ROOT, VERIFY_PY, installScript, pinOf, requiredBytes, soxScript, unitOf } from './install.ts';

const ready = new Set<string>();
const b64 = (s: string) => Buffer.from(s).toString('base64');

export const markOf = (id: string) => (id === ASR_ID ? 'faster-whisper' : pinOf(AUDIO_MODELS.find((m) => m.id === id)!));

/**
 * Makes sure `id` (a model id, or `asr`) is installed on the server. The install runs detached (systemd), so a Gen
 * restart mid install leaves it running; a job that arrives meanwhile (or after the restart) waits for that unit.
 */
export async function ensureAudio(instanceId: string, id: string, step: (s: string) => void = () => {}, signal?: AbortSignal) {
  const key = `${instanceId}/${id}`;
  if (ready.has(key)) return;
  const dir = `${AUDIO_ROOT}/${id}`;
  const mark = markOf(id);
  const have = async () => (await sshRun(`cat ${dir}/READY 2>/dev/null || true`, instanceId)).trim() === mark;
  if (!(await have())) {
    const unit = unitOf(id);
    const running = (await sshRun(`systemctl is-active ${unit} 2>/dev/null || true`, instanceId)).trim() === 'active';
    if (!running) {
      // Free the room first (least recently used models, never a core one or one in use), instead of failing on the disk check.
      await makeRoom(instanceId, requiredBytes(id), step);
      step(`installing ${id} on ${instanceId} (once; several GB)`);
      const token = env('HF_TOKEN') || env('HUGGING_FACE_HUB_TOKEN');
      if (token && !/[\r\n']/.test(token)) await sshRun(`sudo mkdir -p ${AUDIO_ROOT}/hf && sudo chown -R ubuntu:ubuntu ${AUDIO_ROOT} && printf %s ${shq(token)} > ${AUDIO_ROOT}/hf/token && chmod 600 ${AUDIO_ROOT}/hf/token && echo token`, instanceId);
      await sshRun(`sudo mkdir -p ${dir} && sudo chown -R ubuntu:ubuntu ${AUDIO_ROOT} && printf %s ${shq(b64(VERIFY_PY))} | base64 -d > ${dir}/verify.py && printf %s ${shq(b64(installScript(id)))} | base64 -d > ${dir}/install.sh && echo ok`, instanceId);
      await sshRun(`sudo systemctl reset-failed ${unit} 2>/dev/null; sudo systemd-run --unit ${unit} --uid ubuntu --setenv=HOME=/home/ubuntu bash -c 'bash ${dir}/install.sh > ${dir}/install.log 2>&1; echo $? > ${dir}/install.exit'`, instanceId);
    } else step(`waiting for the ${id} install already running on ${instanceId}`);
    const end = Date.now() + 90 * 60_000;
    for (;;) {
      if (signal?.aborted) throw new Error('Cancelled');
      await sleep(8000);
      // The idle stop only watches ComfyUI; an install counts as activity.
      const out = await sshRun(`for d in /var/lib/dod /var/lib/gen; do [ -d $d ] && sudo touch $d/last_busy; done; echo "EXIT=$(cat ${dir}/install.exit 2>/dev/null)"; systemctl is-active ${unit} 2>/dev/null || true`, instanceId).catch(() => '');
      if (await have().catch(() => false)) break;
      const code = /^EXIT=(\d*)/.exec(out)?.[1];
      if (code && code !== '0') {
        const tail = await sshRun(`tail -n 12 ${dir}/install.log`, instanceId).catch(() => '');
        await sshRun(`rm -f ${dir}/install.exit`, instanceId).catch(() => {});
        throw new GenError(`${id} didn't install on ${instanceId} (exit ${code}): ${tail.trim().split('\n').slice(-6).join(' / ')}`, { status: 503 });
      }
      if (Date.now() > end) throw new GenError(`${id} is still installing on ${instanceId} after 90 minutes; the install keeps running, try the job again later`, { status: 503 });
    }
  }
  // Servers whose model was installed before sox was required (or that never had it) get it now.
  if (id !== ASR_ID) {
    try { await sshRun(soxScript(), instanceId, { timeoutMs: 10 * 60_000 }); }
    catch (e) { throw new GenError(`${id} needs sox on ${instanceId}: ${e instanceof Error ? e.message : String(e)}`, { status: 503 }); }
  }
  // The runner and the checker are small and change with Gen: refresh them every job.
  const files: [string, string][] = [['run.py', 'run.py'], ['asr.py', 'asr.py']];
  for (const [name] of files) {
    const text = (await import('node:fs')).readFileSync(path.join(paths.post, 'audio', name), 'utf8');
    await sshRun(`printf %s ${shq(b64(text))} | base64 -d > ${AUDIO_ROOT}/${name}`, instanceId);
  }
  ready.add(key);
}
