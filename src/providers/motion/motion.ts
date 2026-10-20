// Installs the motion venvs on a GPU server the first time motion.from-text runs there.
// The job itself uses blender.render's workspace (a folder under /var/tmp/hawkes-blender).

import { sshRun } from '../comfy/fleet.ts';
import { shq } from '../blender/blender.ts';
import { env } from '../../config.ts';
import { GenError } from '../../util.ts';
import { installScript, MOTION_ROOT, READY_MARK } from './install.ts';

const installed = new Set<string>();

/** Installs Kimodo and HY-Motion once per server. A Hugging Face token, if Gen has one, is written to the
 * server's token file and never printed. */
export async function ensureMotion(instanceId: string, step: (s: string) => void = () => {}) {
  if (installed.has(instanceId)) return;
  const token = env('HF_TOKEN') || env('HUGGING_FACE_HUB_TOKEN');
  if (token && !/[\r\n']/.test(token)) {
    await sshRun(`mkdir -p ${MOTION_ROOT}/hf && printf %s ${shq(token)} > ${MOTION_ROOT}/hf/token && chmod 600 ${MOTION_ROOT}/hf/token && echo token`, instanceId);
  }
  const have = (await sshRun(`cat ${MOTION_ROOT}/READY 2>/dev/null || true`, instanceId)).trim();
  if (have !== READY_MARK) {
    step(`installing motion models on ${instanceId} (once: Kimodo SOMA and HY-Motion, several GB)`);
    const out = await sshRun(`bash -c ${shq(installScript())} 2>&1 | tail -n 40`, instanceId, { timeoutMs: 90 * 60_000 });
    if (!out.includes(`motion ready ${READY_MARK}`)) {
      throw new GenError(`The motion models didn't install on ${instanceId}: ${out.trim().split('\n').slice(-8).join(' / ')}`);
    }
  }
  installed.add(instanceId);
}
