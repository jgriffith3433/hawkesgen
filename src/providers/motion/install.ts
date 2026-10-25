// motion.from-text's models. Not on the fleet image and not a ComfyUI node: two venvs under
// /opt/hawkes-motion, installed the first time a job needs them, the same way mesh.rig installs.
//
// Kimodo-SOMA-RP-v1.2 is the one that runs. Its BVH is the SOMA skeleton (somaskel77), not SMPL.
// Kimodo-SMPLX is a NVIDIA research license and is not installed. HY-Motion 1.0 is the fallback
// when Kimodo does not write a BVH. Its output is SMPL-H pose numbers, written to a BVH here;
// the SMPL body model (the non-commercial mesh weights) is never downloaded.

export const KIMODO_COMMIT = 'e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954';
export const HY_COMMIT = '4e426f5a1021cbcf7f375458c37b840ee7225229';
export const KIMODO_MODEL = 'Kimodo-SOMA-RP-v1.2';

export const MOTION_ROOT = '/opt/hawkes-motion';
export const KIMODO_PYTHON = `${MOTION_ROOT}/kimodo/.venv/bin/python`;
export const HY_PYTHON = `${MOTION_ROOT}/hymotion/.venv/bin/python`;
export const HY_ROOT = `${MOTION_ROOT}/hymotion/src`;
export const HY_MODEL = `${MOTION_ROOT}/hymotion/ckpts/tencent/HY-Motion-1.0`;
export const READY_MARK = `${KIMODO_COMMIT} ${HY_COMMIT}`;

/** Weights, two PyTorch venvs, Llama 3 8B (Kimodo's text encoder) and Qwen3-8B (HY-Motion's). */
export const MIN_FREE_BYTES = 60 * 1024 ** 3;

/**
 * What a commercial Hawkes product may run. Checked in test/motion.test.ts.
 * NVIDIA Open Model License (the text at nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/):
 * a perpetual, worldwide, no-charge license to use, sell and distribute the model and its outputs.
 * NVIDIA claims no ownership of outputs. Use has to stay inside NVIDIA's Trustworthy AI terms.
 * Kimodo-SOMA-RP-v1.2's own card says it is ready for commercial use, including game animation.
 * The text encoder is Meta-Llama-3-8B-Instruct (Llama 3 Community License: commercial use under 700 million
 * monthly users). It is gated: the GPU server needs a Hugging Face token that has been granted that repo,
 * in /opt/hawkes-motion/hf/token. Without it Kimodo cannot start and the job uses HY-Motion.
 */
export const MOTION_LICENSES = [
  {
    id: 'kimodo-soma-rp-v1.2',
    use: 'text to a humanoid clip (SOMA skeleton)',
    commit: KIMODO_COMMIT,
    code: 'Apache-2.0',
    weights: 'NVIDIA Open Model License',
    weightsRepo: 'nvidia/Kimodo-SOMA-RP-v1.2',
    commercial: true,
    note: 'Commercial use is granted (use, sell, distribute; NVIDIA claims no ownership of outputs). Not the SMPL-X checkpoint.',
  },
  {
    id: 'llama-3-8b-instruct',
    use: 'Kimodo text encoder only',
    code: 'Llama 3 Community License',
    weights: 'Llama 3 Community License',
    weightsRepo: 'meta-llama/Meta-Llama-3-8B-Instruct',
    commercial: true,
    note: 'Gated. Commercial use under 700 million monthly users. A token with access is required or Kimodo is skipped.',
  },
  {
    id: 'hy-motion-1.0',
    use: 'fallback when Kimodo writes no BVH',
    commit: HY_COMMIT,
    code: 'Tencent HY-Motion 1.0 Community License',
    weights: 'same community license',
    weightsRepo: 'tencent/HY-Motion-1.0 (HY-Motion-1.0, about 1B)',
    commercial: true,
    note: 'Commercial use under 1 million monthly users, outside the EU, the UK and South Korea. Same shape of terms as Hunyuan3D, which mesh.from-image already runs. Pose output only: no SMPL body weights.',
  },
  {
    id: 'qwen3-8b',
    use: 'HY-Motion text encoder',
    code: 'Apache-2.0',
    weights: 'Apache-2.0',
    weightsRepo: 'Qwen/Qwen3-8B',
    commercial: true,
  },
  {
    id: 'clip-vit-large-patch14',
    use: 'HY-Motion text encoder',
    code: 'MIT',
    weights: 'MIT',
    weightsRepo: 'openai/clip-vit-large-patch14',
    commercial: true,
  },
  {
    id: 'kimodo-smplx',
    use: 'not installed',
    code: 'NVIDIA R&D Model License',
    weights: 'NVIDIA R&D Model License',
    commercial: false,
    note: 'Research license. motion.from-text never selects it. SOMA stays clear of SMPL.',
  },
  {
    id: 'smpl-body',
    use: 'not installed',
    code: 'SMPL non-commercial license',
    weights: 'not downloaded',
    commercial: false,
    note: 'The SMPL mesh and blend-shape weights are not downloaded. HY-Motion pose numbers are written to a BVH with joint names only.',
  },
] as const;

/** Kimodo unless it produced nothing, then HY-Motion. There is no SMPL checkpoint in the list. */
export function chooseBackend(kimodoBvh: boolean): 'kimodo' | 'hymotion' {
  return kimodoBvh ? 'kimodo' : 'hymotion';
}

/** The shell that installs both venvs. Idempotent: a READY file with these commits skips the work. */
export function installScript(sudo = 'sudo ') {
  const apt = `${sudo}apt-get -o DPkg::Lock::Timeout=600`;
  const pkgs = 'python3.11 python3.11-venv python3.11-dev git curl ca-certificates';
  return [
    'set -euo pipefail',
    `MARK='${READY_MARK}'`,
    `if [ "$(cat ${MOTION_ROOT}/READY 2>/dev/null || true)" = "$MARK" ]; then`,
    `  echo "motion ready ${READY_MARK}"`,
    '  exit 0',
    'fi',
    `AVAIL=$(df -B1 --output=avail / | tail -1 | tr -d ' ')`,
    `if [ "$AVAIL" -lt ${MIN_FREE_BYTES} ]; then echo "motion install needs 60 GB free, have $AVAIL bytes" >&2; exit 1; fi`,
    // Ubuntu 24.04 has no python3.11: add the deadsnakes PPA when the plain install fails, and show the apt log if it still does.
    `trap 'rc=$?; if [ $rc -ne 0 ]; then echo "motion install failed (exit $rc) at: $BASH_COMMAND" >&2; tail -n 5 /tmp/motion-apt.log >&2 2>/dev/null || true; fi' EXIT`,
    `if ! ${apt} install -y ${pkgs} >/tmp/motion-apt.log 2>&1; then`,
    `  ${apt} update -y >>/tmp/motion-apt.log 2>&1 || true`,
    `  ${apt} install -y software-properties-common >>/tmp/motion-apt.log 2>&1`,
    `  ${sudo}add-apt-repository -y ppa:deadsnakes/ppa >>/tmp/motion-apt.log 2>&1`,
    `  ${apt} update -y >>/tmp/motion-apt.log 2>&1`,
    `  ${apt} install -y ${pkgs} >>/tmp/motion-apt.log 2>&1`,
    'fi',
    `${sudo}mkdir -p ${MOTION_ROOT}/hf ${MOTION_ROOT}/kimodo ${HY_ROOT} ${MOTION_ROOT}/hymotion/ckpts`,
    `${sudo}chown -R ubuntu:ubuntu ${MOTION_ROOT}`,
    `export HF_HOME=${MOTION_ROOT}/hf`,
    'export HF_HUB_ENABLE_HF_TRANSFER=0',
    'export PIP_DISABLE_PIP_VERSION_CHECK=1',
    'if [ -f ' + MOTION_ROOT + '/hf/token ]; then export HF_TOKEN="$(cat ' + MOTION_ROOT + '/hf/token)"; export HUGGING_FACE_HUB_TOKEN="$HF_TOKEN"; fi',
    `if [ ! -x ${KIMODO_PYTHON} ]; then python3.11 -m venv ${MOTION_ROOT}/kimodo/.venv; fi`,
    `${KIMODO_PYTHON} -m pip install -U pip`,
    `${KIMODO_PYTHON} -m pip install torch==2.7.0 torchvision==0.22.0 --index-url https://download.pytorch.org/whl/cu128`,
    // Base package only. kimodo[soma] pulls SOMA-X; the SMPL-X weights are a different download and are not requested.
    `${KIMODO_PYTHON} -m pip install "kimodo @ git+https://github.com/nv-tlabs/kimodo.git@${KIMODO_COMMIT}"`,
    `${KIMODO_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('${'nvidia/' + KIMODO_MODEL}')" || echo "Kimodo weights download failed; the first job will try again"`,
    `${KIMODO_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('meta-llama/Meta-Llama-3-8B-Instruct')" || echo "Llama 3 8B is gated: put a Hugging Face token with access in ${MOTION_ROOT}/hf/token and run the job again. Until then Kimodo is skipped."`,
    `if [ ! -d ${HY_ROOT}/.git ]; then git init ${HY_ROOT}; fi`,
    `git -C ${HY_ROOT} remote remove origin 2>/dev/null || true`,
    `git -C ${HY_ROOT} remote add origin https://github.com/Tencent-Hunyuan/HY-Motion-1.0.git`,
    `git -C ${HY_ROOT} fetch --depth 1 origin ${HY_COMMIT}`,
    `git -C ${HY_ROOT} checkout --force FETCH_HEAD`,
    `if [ ! -x ${HY_PYTHON} ]; then python3.11 -m venv ${MOTION_ROOT}/hymotion/.venv; fi`,
    `${HY_PYTHON} -m pip install -U pip`,
    `${HY_PYTHON} -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124`,
    // fbxsdkpy needs a private index and is only used for their wooden FBX. The BVH writer does not use it.
    `grep -v -E 'fbxsdkpy|extra-index-url' ${HY_ROOT}/requirements.txt > ${MOTION_ROOT}/hymotion/requirements.txt`,
    `${HY_PYTHON} -m pip install -r ${MOTION_ROOT}/hymotion/requirements.txt`,
    `${HY_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('tencent/HY-Motion-1.0', allow_patterns=['HY-Motion-1.0/*'], local_dir='${MOTION_ROOT}/hymotion/ckpts/tencent')"`,
    `${HY_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('openai/clip-vit-large-patch14')"`,
    `${HY_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-8B')"`,
    `echo "$MARK" > ${MOTION_ROOT}/READY`,
    `echo "motion ready ${READY_MARK}"`,
  ].join('\n');
}
