// The rigging models mesh.rig installs on a GPU server the first time a job needs them.
// Kept apart from the tool (no fleet or SSH imports) so tests can read the pins and the script.
//
// Not part of the fleet image and not a ComfyUI node: each model has its own venv under /opt/hawkes-rig,
// installed on first use, the way Blender is. A new image is not required.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Make-It-Animatable v2 (Hunyuan3D-2.1 ShapeVAE backbone). Code MIT, weights Apache-2.0. */
export const MIA_COMMIT = 'bbd8b158d88879c310ad130f9b25056935d221e9';
/** SkinTokens / TokenRig. Code and weights MIT. Successor to UniRig. */
export const SKIN_COMMIT = '273b691d35989d71cd17ff2895fdc735097b92d1';

export const RIG_ROOT = '/opt/hawkes-rig';
export const MIA_ROOT = `${RIG_ROOT}/mia/src`;
export const SKIN_ROOT = `${RIG_ROOT}/skin/src`;
export const MIA_PYTHON = `${RIG_ROOT}/mia/.venv/bin/python`;
export const SKIN_PYTHON = `${RIG_ROOT}/skin/.venv/bin/python`;
export const READY_MARK = `${MIA_COMMIT} ${SKIN_COMMIT}`;

/** Refuse to install onto a disk with less than this free. Weights are about 6 GB before the two PyTorch venvs. */
export const MIN_FREE_BYTES = 30 * 1024 ** 3;
/** SkinTokens' own minimum. An L40S (48 GB) is the fleet machine. */
export const SKIN_MIN_VRAM_MIB = 14 * 1024;

/**
 * What a commercial Hawkes product is allowed to run. UniRig's code and weights are MIT too; it is not installed
 * because SkinTokens replaces it (one venv, one download). The gated Mixamo dataset is not downloaded: the skeleton
 * template is generated (post/rig/make_template.py). Hunyuan3D-2.1's community license allows commercial use under
 * 1 million monthly users, outside the EU, UK and South Korea; mesh.from-image already runs that model.
 */
export const RIG_LICENSES = [
  {
    id: 'make-it-animatable',
    use: 'humanoid',
    commit: MIA_COMMIT,
    code: 'MIT',
    weights: 'Apache-2.0',
    weightsRepo: 'jasongzy/Make-It-Animatable (output/best/v2, about 3.05 GB)',
    commercial: true,
  },
  {
    id: 'hunyuan3d-2.1-shapevae',
    use: 'encoder inside Make-It-Animatable v2',
    code: 'Tencent Hunyuan 3D 2.1 Community License',
    weights: 'same community license (hunyuan3d-vae-v2-1, about 625 MB)',
    commercial: true,
  },
  {
    id: 'skintokens',
    use: 'fallback and non-humanoid',
    commit: SKIN_COMMIT,
    code: 'MIT',
    weights: 'MIT',
    weightsRepo: 'VAST-AI/SkinTokens (about 1.6 GB) plus the Qwen3-0.6B config only (Apache-2.0; the checkpoint is SkinTokens\')',
    commercial: true,
  },
  {
    id: 'unirig',
    use: 'not installed',
    code: 'MIT',
    weights: 'MIT',
    commercial: true,
    note: 'Skipped as the predecessor. SkinTokens is the successor and does skeleton and skinning in one model.',
  },
] as const;

/** Which model rigs this mesh. `humanoid` always uses Make-It-Animatable. `auto` uses it for a biped and SkinTokens otherwise, and SkinTokens again if Make-It-Animatable fails. */
export function chooseBackend(kind: string, humanoid: boolean, miaFailed = false): 'mia' | 'skin' {
  if (kind !== 'humanoid' && kind !== 'auto') throw new Error(`kind must be humanoid or auto, not ${kind}`);
  if (kind === 'humanoid') return 'mia';
  if (!humanoid || miaFailed) return 'skin';
  return 'mia';
}

/** SkinTokens' beam count. 10 is their default and wants a large GPU; fewer beams stay inside a 24 GB card. */
export function beamsForVram(totalMib: number): number {
  if (totalMib < 20_000) return 2;
  if (totalMib < 32_000) return 4;
  return 10;
}

/**
 * Third-party modules each venv must import at run time, as `module:pip-name`. Read from the imports of the pinned
 * code (SkinTokens' src/ and demo.py, Make-It-Animatable's app code and our mia_run.py). Their requirements.txt files
 * leave several out (scipy first: SkinTokens imports it in six files, and it only arrives by luck with other packages),
 * so a missing one is pip-installed after the requirements, and again on a server whose venv predates this list.
 * torch, bpy and flash-attn are left out: they have their own install steps (flash-attn is optional).
 */
export const SKIN_IMPORTS = [
  'numpy:numpy', 'scipy:scipy', 'trimesh:trimesh', 'einops:einops', 'omegaconf:omegaconf', 'lightning:lightning',
  'transformers:transformers', 'diffusers:diffusers', 'huggingface_hub:huggingface_hub', 'box:python-box', 'addict:addict',
  'open3d:open3d', 'gradio:gradio', 'bottle:bottle', 'tornado:tornado', 'requests:requests', 'tqdm:tqdm', 'yaml:pyyaml',
  'safetensors:safetensors', 'sklearn:scikit-learn', 'PIL:pillow',
] as const;
export const MIA_IMPORTS = [
  'numpy:numpy', 'scipy:scipy', 'trimesh:trimesh', 'einops:einops', 'omegaconf:omegaconf', 'timm:timm',
  'pytorch_lightning:pytorch-lightning', 'transformers:transformers', 'diffusers:diffusers', 'huggingface_hub:huggingface_hub',
  'safetensors:safetensors', 'yaml:pyyaml', 'tqdm:tqdm', 'requests:requests', 'PIL:pillow', 'cv2:opencv-contrib-python',
  'skimage:scikit-image', 'sklearn:scikit-learn', 'matplotlib:matplotlib', 'plyfile:plyfile', 'shapely:shapely', 'mcubes:PyMCubes',
] as const;

/** Shell that makes sure every module in `list` imports in `py`, pip-installing the ones that don't, then checks again. */
function verifyImports(py: string, label: string, list: readonly string[]) {
  const mods = list.map((x) => x.split(':')[0]);
  const pairs = list.join(' ');
  return [
    `for pair in ${pairs}; do`,
    `  mod="\${pair%%:*}"; pkg="\${pair##*:}"`,
    `  if ! ${py} -c "import $mod" >/dev/null 2>&1; then echo "rig: ${label} venv lacks $mod, installing $pkg"; ${py} -m pip install "$pkg" || echo "rig: pip install $pkg failed" >&2; fi`,
    'done',
    `${py} -c "import ${mods.join(', ')}"`,
  ].join('\n');
}

/** The verify step: imports the full list in each venv and installs whatever fails. Runs on every install and on every ready server. */
export function verifyScript() {
  return [
    verifyImports(MIA_PYTHON, 'mia', MIA_IMPORTS),
    verifyImports(SKIN_PYTHON, 'skin', SKIN_IMPORTS),
    'echo "rig deps ok"',
  ].join('\n');
}

const TEMPLATE_PY = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../post/rig/make_template.py'));

function measureB64() {
  const py = `
import json, os, subprocess
root = ${JSON.stringify(RIG_ROOT)}
def du(p):
    if not os.path.exists(p):
        return 0
    return int(subprocess.check_output(["du", "-sb", p], text=True).split()[0])
mem = {}
for line in open("/proc/meminfo"):
    k, v = line.split(":")
    if k in ("MemTotal", "MemAvailable"):
        mem[k] = int(v.strip().split()[0]) * 1024
vram = None
try:
    row = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"], text=True).strip().splitlines()[0]
    vram = int(row.strip())
except Exception as e:
    vram = str(e)
doc = {"diskBytes": du(root), "memTotalBytes": mem.get("MemTotal"), "memAvailableBytes": mem.get("MemAvailable"), "vramTotalMib": vram, "mia": ${JSON.stringify(MIA_COMMIT)}, "skintokens": ${JSON.stringify(SKIN_COMMIT)}}
open(os.path.join(root, "resources.json"), "w").write(json.dumps(doc))
print(json.dumps(doc))
`;
  return Buffer.from(py).toString('base64');
}

/**
 * The shell that installs both venvs. Idempotent: a READY file with these commits skips the work. `weights: false` is
 * the 3D worker image (server/gpu3d/Dockerfile): code, venvs, the generated template and FBX2glTF, no model weights
 * (a worker fetches them into its weights folder on first use: weightsScript).
 */
export function installScript(sudo = 'sudo ', o: { weights?: boolean } = {}) {
  const weights = o.weights !== false;
  const apt = `${sudo}apt-get -o DPkg::Lock::Timeout=600`;
  const b64 = TEMPLATE_PY.toString('base64');
  return [
    'set -euo pipefail',
    `MARK='${READY_MARK}'`,
    `if [ "$(cat ${RIG_ROOT}/READY 2>/dev/null || true)" = "$MARK" ]; then`,
    // Ready servers still get the verify step: a venv made before a package was added to the lists gets it now.
    `  ${verifyScript().replace(/\n/g, '\n  ')}`,
    `  echo "rig ready ${READY_MARK}"`,
    '  exit 0',
    'fi',
    `AVAIL=$(df -B1 --output=avail / | tail -1)`,
    `${weights ? "" : "false && "}if [ "$AVAIL" -lt ${MIN_FREE_BYTES} ]; then echo "rig install needs 30 GB free, have $AVAIL bytes" >&2; exit 1; fi`,
    // Ubuntu 24.04 has no python3.11: add the deadsnakes PPA when the plain install fails, and show the apt log if it still does.
    `PKGS='python3.11 python3.11-venv python3.11-dev git curl ca-certificates'`,
    `trap 'rc=$?; if [ $rc -ne 0 ]; then echo "rig install failed (exit $rc) at: $BASH_COMMAND" >&2; tail -n 5 /tmp/rig-apt.log >&2 2>/dev/null || true; fi' EXIT`,
    `if ! ${apt} install -y $PKGS >/tmp/rig-apt.log 2>&1; then`,
    `  ${apt} update -y >>/tmp/rig-apt.log 2>&1 || true`,
    `  ${apt} install -y software-properties-common >>/tmp/rig-apt.log 2>&1`,
    `  ${sudo}add-apt-repository -y ppa:deadsnakes/ppa >>/tmp/rig-apt.log 2>&1`,
    `  ${apt} update -y >>/tmp/rig-apt.log 2>&1`,
    `  ${apt} install -y $PKGS >>/tmp/rig-apt.log 2>&1`,
    'fi',
    `${sudo}mkdir -p ${RIG_ROOT}/hf ${MIA_ROOT} ${SKIN_ROOT}`,
    `${sudo}chown -R ubuntu:ubuntu ${RIG_ROOT}`,
    'export HF_HOME=' + RIG_ROOT + '/hf',
    'export PIP_DISABLE_PIP_VERSION_CHECK=1',
    `if [ ! -d ${MIA_ROOT}/.git ]; then git init ${MIA_ROOT}; fi`,
    `git -C ${MIA_ROOT} remote remove origin 2>/dev/null || true`,
    `git -C ${MIA_ROOT} remote add origin https://github.com/jasongzy/Make-It-Animatable.git`,
    `git -C ${MIA_ROOT} fetch --depth 1 origin ${MIA_COMMIT}`,
    `git -C ${MIA_ROOT} checkout --force FETCH_HEAD`,
    // The Auto-Rig Pro submodule is a paid addon. Only the Hunyuan loader is needed, and only its code.
    `git -C ${MIA_ROOT} submodule update --init --depth 1 util/Hunyuan3D_21`,
    `if [ ! -x ${MIA_PYTHON} ]; then python3.11 -m venv ${RIG_ROOT}/mia/.venv; fi`,
    `${MIA_PYTHON} -m pip install -U pip`,
    `${MIA_PYTHON} -m pip install -r ${MIA_ROOT}/requirements.txt`,
    verifyImports(MIA_PYTHON, 'mia', MIA_IMPORTS),
    `printf '%s' '${b64}' | base64 -d > ${RIG_ROOT}/make_template.py`,
    `mkdir -p ${MIA_ROOT}/data/Mixamo`,
    `${MIA_PYTHON} ${RIG_ROOT}/make_template.py ${MIA_ROOT}/data/Mixamo/bones.fbx`,
    `curl -fsSL --retry 3 -o ${MIA_ROOT}/util/FBX2glTF https://github.com/facebookincubator/FBX2glTF/releases/download/v0.9.7/FBX2glTF-linux-x64`,
    `chmod +x ${MIA_ROOT}/util/FBX2glTF`,
    ...(weights ? [
      `${MIA_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('jasongzy/Make-It-Animatable', allow_patterns=['output/best/v2/*'], local_dir='${MIA_ROOT}')"`,
      `${MIA_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('tencent/Hunyuan3D-2.1', allow_patterns=['hunyuan3d-vae-v2-1/*'])"`,
    ] : []),
    `if [ ! -d ${SKIN_ROOT}/.git ]; then git init ${SKIN_ROOT}; fi`,
    `git -C ${SKIN_ROOT} remote remove origin 2>/dev/null || true`,
    `git -C ${SKIN_ROOT} remote add origin https://github.com/VAST-AI-Research/SkinTokens.git`,
    `git -C ${SKIN_ROOT} fetch --depth 1 origin ${SKIN_COMMIT}`,
    `git -C ${SKIN_ROOT} checkout --force FETCH_HEAD`,
    `if [ ! -x ${SKIN_PYTHON} ]; then python3.11 -m venv ${RIG_ROOT}/skin/.venv; fi`,
    `${SKIN_PYTHON} -m pip install -U pip`,
    `${SKIN_PYTHON} -m pip install torch==2.7.0 torchvision==0.22.0 torchaudio==2.7.0 --index-url https://download.pytorch.org/whl/cu128`,
    `${SKIN_PYTHON} -m pip install -r ${SKIN_ROOT}/requirements.txt`,
    verifyImports(SKIN_PYTHON, 'skin', SKIN_IMPORTS),
    // flash-attn often fails to build. TokenRig uses PyTorch attention when it is absent.
    `${SKIN_PYTHON} -m pip install flash-attn --no-build-isolation || echo "flash-attn skipped"`,
    ...(weights ? [
      `cd ${SKIN_ROOT} && ${SKIN_PYTHON} download.py --model`,
      `${MIA_PYTHON} -c "import base64; exec(base64.b64decode('${measureB64()}').decode())"`,
    ] : []),
    `echo "$MARK" > ${RIG_ROOT}/READY`,
    `echo "rig ready ${READY_MARK}"`,
  ].join('\n');
}

/** Links `link` (a path the code reads) to `target` (in the weights folder), replacing whatever was there. */
export const linkTo = (target: string, link: string) => `mkdir -p "${target}"; if [ ! -L "${link}" ]; then rm -rf "${link}"; fi; ln -sfn "${target}" "${link}"`;

/**
 * On a 3D worker (src/providers/workspace.ts weightsPrelude): the rigging weights, fetched once into $HAWKES_WEIGHTS
 * (a provider volume when mounted) under a lock, then linked where Make-It-Animatable and SkinTokens look for them.
 * About 5.3 GB: Make-It-Animatable v2, Hunyuan3D 2.1's shape VAE (into the Hugging Face cache) and SkinTokens.
 */
export function weightsScript() {
  const w = '$HAWKES_WEIGHTS/rig';
  const mark = `${w}/READY-${MIA_COMMIT.slice(0, 12)}-${SKIN_COMMIT.slice(0, 12)}`;
  return [
    `mkdir -p "${w}"`,
    `(`,
    `  flock 9`,
    `  if [ ! -f "${mark}" ]; then`,
    `    echo "HB step downloading the rigging models (once per weights volume, about 5 GB)"`,
    `    HF_HOME="$HAWKES_HF_HOME" ${MIA_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('jasongzy/Make-It-Animatable', allow_patterns=['output/best/v2/*'], local_dir='${w}/mia')"`,
    `    HF_HOME="$HAWKES_HF_HOME" ${MIA_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('tencent/Hunyuan3D-2.1', allow_patterns=['hunyuan3d-vae-v2-1/*'])"`,
    `    mkdir -p "${w}/skin" && (cd "${w}/skin" && HF_HOME="$HAWKES_HF_HOME" ${SKIN_PYTHON} ${SKIN_ROOT}/download.py --model)`,
    `    touch "${mark}"`,
    `  fi`,
    `) 9>"${w}/.lock"`,
    linkTo(`${w}/mia/output`, `${MIA_ROOT}/output`),
    linkTo(`${w}/skin/experiments`, `${SKIN_ROOT}/experiments`),
    linkTo(`${w}/skin/models`, `${SKIN_ROOT}/models`),
  ].join('\n');
}
