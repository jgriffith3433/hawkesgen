// motion.from-video's model: NVIDIA GEM-X (body motion from one ordinary video, on the SOMA skeleton). Not a ComfyUI
// node: one venv under /opt/hawkes-mocap, installed by the 3D worker image (server/gpu3d) or on a fleet server the first
// time a job needs it. Kept apart from the tool (no fleet or SSH imports) so tests can read the pins and the scripts.
//
// GEM-X writes SOMA parameters (77 public joints), the same skeleton Kimodo writes for motion.from-text, so
// post/motion/soma_to_bvh.py turns them into the BVH blender.character already retargets with bone names "soma".

/** NVlabs/GEM-X at the commit checked on 2026-11-07 (Body Motion native77, final775). */
export const GEMX_COMMIT = '4aef1452e5df171deff4f293c08e643eb450981e';
/** SOMA-X geometry the GEM-X runtime (py-soma-x 0.3.3) reads. */
export const SOMA_REVISION = 'v0.3.3';

export const MOCAP_ROOT = '/opt/hawkes-mocap';
export const GEMX_ROOT = `${MOCAP_ROOT}/gemx/src`;
export const GEMX_PYTHON = `${MOCAP_ROOT}/gemx/.venv/bin/python`;
/** Where the fleet keeps the weights (a worker uses $HAWKES_WEIGHTS/mocap instead). */
export const MOCAP_WEIGHTS = `${MOCAP_ROOT}/weights`;
export const READY_MARK = GEMX_COMMIT;

/** The venv (PyTorch 2.10) and the weights (ViTPose huge, the Body Pose and Motion checkpoints, SOMA geometry). */
export const MIN_FREE_BYTES = 30 * 1024 ** 3;

/** The GEM-X files motion.from-video downloads from nvidia/GEM-X (docs/PRETRAINED_MODELS.md at the pinned commit). */
export const GEMX_FILES = ['body_s240000.ckpt', 'vitpose.pth', 'motion_native77_e774_s292175.ckpt', 'motion_stats_raw.npz', 'body_video_native77.yaml'] as const;
/** SOMA-X v0.3.3 geometry: the rig and shape data, and the correctives the Contact/IK pass reads. */
export const SOMA_FILES = ['SOMA_neutral.npz', 'SOMA_template_rig.usda', 'SOMA_procedural_transforms.json', 'correctives_model.pt'] as const;
/** OpenMMLab's YOLOX-X HumanArt person detector (ONNX, run on the CPU), the archive GEM-X's docs name. */
export const YOLOX_URL = 'https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_x_8xb8-300e_humanart-a39d44ed.zip';

/**
 * What a commercial Hawkes product is allowed to run. Checked in test/mocap.test.ts. GVHMR, WHAM, TRAM and the SMPL
 * family are not installed: GVHMR's license is research and non-profit only, and SMPL's body weights are non-commercial.
 */
export const MOCAP_LICENSES = [
  {
    id: 'gem-x',
    use: 'video to body motion (SOMA, 77 joints)',
    commit: GEMX_COMMIT,
    code: 'Apache-2.0 (a few hand-processing files under OpenMDW-1.1; ATTRIBUTIONS.md)',
    weights: 'NVIDIA Open Model License',
    weightsRepo: 'nvidia/GEM-X',
    commercial: true,
    note: 'The model card says all training data and the SOMA body model are NVIDIA-owned or permissively licensed, ready for commercial use.',
  },
  {
    id: 'soma-x',
    use: 'the body model GEM-X and Kimodo share',
    code: 'py-soma-x 0.3.3',
    weights: 'NVIDIA (permissive)',
    weightsRepo: `nvidia/SOMA-X@${SOMA_REVISION}`,
    commercial: true,
  },
  {
    id: 'vitpose-77',
    use: '2D keypoints inside GEM-X',
    code: 'shipped in nvidia/GEM-X (vitpose.pth)',
    weights: 'NVIDIA Open Model License (with the GEM-X bundle)',
    weightsRepo: 'nvidia/GEM-X',
    commercial: true,
  },
  {
    id: 'yolox-x-humanart',
    use: 'person detector inside GEM-X',
    code: 'Apache-2.0 (OpenMMLab mmpose)',
    weights: 'Apache-2.0',
    weightsRepo: 'download.openmmlab.com (rtmposev1 onnx_sdk)',
    commercial: true,
  },
  {
    id: 'gvhmr',
    use: 'not installed',
    code: 'research and non-profit only',
    weights: 'research and non-profit only',
    commercial: false,
    note: 'Handles moving cameras well, but its license forbids commercial use.',
  },
  {
    id: 'smpl-body',
    use: 'not installed',
    code: 'SMPL non-commercial license',
    weights: 'not downloaded',
    commercial: false,
    note: 'WHAM, TRAM and most other video-to-motion models predict SMPL; GEM-X uses SOMA instead.',
  },
] as const;

/**
 * The shell that downloads the weights into `dir` (idempotent; a marker file skips it). Used by the fleet installer
 * (dir = MOCAP_WEIGHTS) and on a worker (dir = $HAWKES_WEIGHTS/mocap, under a lock: weightsScript).
 */
export function fetchWeights(dir: string, hfHome: string) {
  return [
    `mkdir -p "${dir}/weights" "${dir}/soma"`,
    `HF_HOME="${hfHome}" ${GEMX_PYTHON} -c "from huggingface_hub import hf_hub_download as d; [d('nvidia/GEM-X', f, local_dir='${dir}/weights') for f in ${JSON.stringify([...GEMX_FILES]).replace(/"/g, "'")}]"`,
    `HF_HOME="${hfHome}" ${GEMX_PYTHON} -c "from huggingface_hub import hf_hub_download as d; [d('nvidia/SOMA-X', f, revision='${SOMA_REVISION}', local_dir='${dir}/soma') for f in ${JSON.stringify([...SOMA_FILES]).replace(/"/g, "'")}]"`,
    `if [ ! -s "${dir}/weights/yolox_humanart.onnx" ]; then`,
    `  curl -fsSL --retry 3 -o "${dir}/weights/yolox_humanart.zip" ${YOLOX_URL}`,
    `  ${GEMX_PYTHON} -c "import shutil,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); m=next(n for n in z.namelist() if n.endswith('/end2end.onnx')); shutil.copyfileobj(z.open(m), open(sys.argv[2],'wb'))" "${dir}/weights/yolox_humanart.zip" "${dir}/weights/yolox_humanart.onnx"`,
    `  rm -f "${dir}/weights/yolox_humanart.zip"`,
    'fi',
  ].join('\n');
}

/** On a 3D worker (src/providers/workspace.ts weightsPrelude): GEM-X's weights into $HAWKES_WEIGHTS/mocap, once. */
export function weightsScript() {
  const w = '$HAWKES_WEIGHTS/mocap';
  const mark = `${w}/READY-${GEMX_COMMIT.slice(0, 12)}`;
  return [
    `mkdir -p "${w}"`,
    `(`,
    `  flock 9`,
    `  if [ ! -f "${mark}" ]; then`,
    `    echo "HB step downloading GEM-X (once per weights volume, about 4 GB)"`,
    ...fetchWeights(w, '$HAWKES_HF_HOME').split('\n').map((l) => `    ${l}`),
    `    touch "${mark}"`,
    `  fi`,
    `) 9>"${w}/.lock"`,
  ].join('\n');
}

/**
 * The shell that installs GEM-X's venv. Idempotent: a READY file with the commit skips it. `weights: false` is the
 * 3D worker image (code and venv only).
 */
export function installScript(sudo = 'sudo ', o: { weights?: boolean } = {}) {
  const weights = o.weights !== false;
  const apt = `${sudo}apt-get -o DPkg::Lock::Timeout=600`;
  return [
    'set -euo pipefail',
    `if [ "$(cat ${MOCAP_ROOT}/READY 2>/dev/null || true)" = "${READY_MARK}" ]; then echo "mocap ready ${READY_MARK}"; exit 0; fi`,
    `AVAIL=$(df -B1 --output=avail / | tail -1 | tr -d ' ')`,
    `${weights ? "" : "false && "}if [ "$AVAIL" -lt ${MIN_FREE_BYTES} ]; then echo "mocap install needs 30 GB free, have $AVAIL bytes" >&2; exit 1; fi`,
    `trap 'rc=$?; if [ $rc -ne 0 ]; then echo "mocap install failed (exit $rc) at: $BASH_COMMAND" >&2; tail -n 5 /tmp/mocap-apt.log >&2 2>/dev/null || true; fi' EXIT`,
    // Ubuntu 24.04's own Python (3.12) suits GEM-X (3.10 or newer).
    `${apt} install -y python3 python3-venv python3-dev git curl ca-certificates ffmpeg libglib2.0-0 libgomp1 >/tmp/mocap-apt.log 2>&1 || (${apt} update -y >>/tmp/mocap-apt.log 2>&1 && ${apt} install -y python3 python3-venv python3-dev git curl ca-certificates ffmpeg libglib2.0-0 libgomp1 >>/tmp/mocap-apt.log 2>&1)`,
    `${sudo}mkdir -p ${GEMX_ROOT} ${MOCAP_WEIGHTS}`,
    `${sudo}chown -R "$(id -un)":"$(id -gn)" ${MOCAP_ROOT}`,
    'export PIP_DISABLE_PIP_VERSION_CHECK=1',
    `if [ ! -d ${GEMX_ROOT}/.git ]; then git init ${GEMX_ROOT}; fi`,
    `git -C ${GEMX_ROOT} remote remove origin 2>/dev/null || true`,
    `git -C ${GEMX_ROOT} remote add origin https://github.com/NVlabs/GEM-X.git`,
    `git -C ${GEMX_ROOT} fetch --depth 1 origin ${GEMX_COMMIT}`,
    `git -C ${GEMX_ROOT} checkout --force FETCH_HEAD`,
    `if [ ! -x ${GEMX_PYTHON} ]; then python3 -m venv ${MOCAP_ROOT}/gemx/.venv; fi`,
    `${GEMX_PYTHON} -m pip install -U pip wheel`,
    // GEM-X wants PyTorch 2.10 or newer within 2.x; the cu128 wheels run on every GPU the providers offer.
    `${GEMX_PYTHON} -m pip install "torch>=2.10,<3" --index-url https://download.pytorch.org/whl/cu128`,
    `${GEMX_PYTHON} -m pip install -e "${GEMX_ROOT}[video]" huggingface_hub pyyaml`,
    `${GEMX_PYTHON} -c "import gem, soma, onnxruntime; print('gem-x ok, soma', soma.__version__)"`,
    ...(weights ? [fetchWeights(MOCAP_WEIGHTS, `${MOCAP_ROOT}/hf`)] : []),
    `echo "${READY_MARK}" > ${MOCAP_ROOT}/READY`,
    `echo "mocap ready ${READY_MARK}"`,
  ].join('\n');
}
