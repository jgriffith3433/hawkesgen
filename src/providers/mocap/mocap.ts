// Installs GEM-X on a fleet server the first time motion.from-video runs there (the 3D worker image already has it).

import { sshRun } from '../comfy/fleet.ts';
import { shq } from '../blender/blender.ts';
import { GenError } from '../../util.ts';
import { installScript, MOCAP_ROOT, READY_MARK } from './install.ts';

const installed = new Set<string>();

/** Installs GEM-X and its weights once per server. */
export async function ensureMocap(instanceId: string, step: (s: string) => void = () => {}) {
  if (installed.has(instanceId)) return;
  const have = (await sshRun(`cat ${MOCAP_ROOT}/READY 2>/dev/null || true`, instanceId)).trim();
  if (have !== READY_MARK) {
    step(`installing GEM-X on ${instanceId} (once: its venv and about 4 GB of weights)`);
    const out = await sshRun(`bash -c ${shq(installScript())} 2>&1 | tail -n 30`, instanceId, { timeoutMs: 60 * 60_000 });
    if (!out.includes(`mocap ready ${READY_MARK}`)) {
      throw new GenError(`GEM-X didn't install on ${instanceId}: ${out.trim().split('\n').slice(-8).join(' / ') || 'the install printed nothing (see /tmp/mocap-apt.log on the server)'}`);
    }
  }
  installed.add(instanceId);
}
