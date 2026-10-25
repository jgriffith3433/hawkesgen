// Installs the rigging venvs on a GPU server the first time mesh.rig runs there. The job itself uses
// blender.render's workspace (a folder under /var/tmp/hawkes-blender, detached from SSH).

import { sshRun } from '../comfy/fleet.ts';
import { shq } from '../blender/blender.ts';
import { GenError } from '../../util.ts';
import { installScript, READY_MARK, RIG_ROOT } from './install.ts';

const installed = new Set<string>();

/** Installs Make-It-Animatable and SkinTokens once per server (the download is several GB). */
export async function ensureRig(instanceId: string, step: (s: string) => void = () => {}) {
  if (installed.has(instanceId)) return;
  const have = (await sshRun(`cat ${RIG_ROOT}/READY 2>/dev/null || true`, instanceId)).trim();
  // A ready server still runs the script: it checks the Python imports and pip-installs what an older venv lacks.
  if (have !== READY_MARK) step(`installing the rigging models on ${instanceId} (once: Make-It-Animatable and SkinTokens, several GB)`);
  const out = await sshRun(`bash -c ${shq(installScript())} 2>&1 | tail -n 30`, instanceId, { timeoutMs: 70 * 60_000 });
  if (!out.includes(`rig ready ${READY_MARK}`)) {
    throw new GenError(`The rigging models didn't install on ${instanceId}: ${out.trim().split('\n').slice(-8).join(' / ') || 'the install printed nothing (see /tmp/rig-apt.log on the server)'}`);
  }
  installed.add(instanceId);
}
