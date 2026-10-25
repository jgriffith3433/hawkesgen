// The open audio models' installs on a GPU server (docs/audio.md). Not ComfyUI nodes and not on the fleet image: one
// Python 3.11 venv per model under /opt/hawkes-audio/<model>, installed the first time a job needs that model, the way
// motion.from-text and mesh.rig install. A venv per model keeps their pins apart (Qwen3-TTS pins transformers==4.57.3).
//
// The install is built to survive a Gen restart (the lesson from the half-written model files):
//   - it runs as a detached systemd unit, so dropping Gen's SSH session does not stop it; the next job finds the unit
//     running and waits for it instead of starting a second one;
//   - weights download into the Hugging Face cache (resumable), then verify.py refuses a cache holding .incomplete files
//     or a repo with fewer bytes than the hub lists; only then is READY written;
//   - READY holds `<code commit> <pip hash>`; a different pin reinstalls, anything else is skipped.
// Ubuntu 24.04 has no python3.11 package: the deadsnakes PPA is added when the plain install fails (the mesh.rig fix).

import { AUDIO_MODELS, type AudioModel } from '../../audio/registry.ts';
import { sha256 } from '../../util.ts';

export const AUDIO_ROOT = '/opt/hawkes-audio';
export const MIN_FREE_BYTES = 30 * 1024 ** 3;
export const ASR_ID = 'asr';
export const ASR_REPO = 'Systran/faster-whisper-small';

export const venvPython = (id: string) => `${AUDIO_ROOT}/${id}/venv/bin/python`;
export const pinOf = (m: AudioModel) => `${m.ref} ${sha256(JSON.stringify([m.pip, m.weights, m.repo])).slice(0, 12)}`;
export const unitOf = (id: string) => `hawkes-audio-install-${id}`;

/** Models with their own venv (the ones a GPU job runs: not music, which is a ComfyUI workflow). */
export const installable = (m: AudioModel) => Boolean(m.pip.length) && Boolean(m.weights.length) && !m.blocked;

/** The shell that installs one component (a model id, or `asr`). Idempotent. */
export function installScript(id: string, sudo = 'sudo '): string {
  const asr = id === ASR_ID;
  const m = asr ? null : AUDIO_MODELS.find((x) => x.id === id);
  if (!asr && (!m || !installable(m))) throw new Error(`${id} cannot be installed (not a runnable open model)`);
  const pip = asr ? ['faster-whisper'] : m!.pip;
  const repos = asr ? [ASR_REPO] : m!.weights;
  const mark = asr ? 'faster-whisper' : pinOf(m!);
  const dir = `${AUDIO_ROOT}/${id}`;
  const py = venvPython(id);
  const apt = `${sudo}apt-get -o DPkg::Lock::Timeout=600`;
  const pkgs = 'python3.11 python3.11-venv python3.11-dev git curl ca-certificates ffmpeg libsndfile1';
  // MOSS ships as a repository (no pip package): cloned at its ref; the others are pip packages that carry their code.
  const gitSrc = !asr && m!.id.startsWith('moss');
  return [
    'set -euo pipefail',
    `MARK='${mark}'`,
    `if [ "$(cat ${dir}/READY 2>/dev/null || true)" = "$MARK" ]; then echo "audio ready ${id}"; exit 0; fi`,
    `AVAIL=$(df -B1 --output=avail / | tail -1 | tr -d ' ')`,
    `if [ "$AVAIL" -lt ${MIN_FREE_BYTES} ]; then echo "audio install needs 30 GB free, have $AVAIL bytes" >&2; exit 1; fi`,
    `trap 'rc=$?; if [ $rc -ne 0 ]; then echo "audio install of ${id} failed (exit $rc) at: $BASH_COMMAND" >&2; tail -n 5 /tmp/audio-apt.log >&2 2>/dev/null || true; fi' EXIT`,
    `if ! ${apt} install -y ${pkgs} >/tmp/audio-apt.log 2>&1; then`,
    `  ${apt} update -y >>/tmp/audio-apt.log 2>&1 || true`,
    `  ${apt} install -y software-properties-common >>/tmp/audio-apt.log 2>&1`,
    `  ${sudo}add-apt-repository -y ppa:deadsnakes/ppa >>/tmp/audio-apt.log 2>&1`,
    `  ${apt} update -y >>/tmp/audio-apt.log 2>&1`,
    `  ${apt} install -y ${pkgs} >>/tmp/audio-apt.log 2>&1`,
    'fi',
    `${sudo}mkdir -p ${dir} ${AUDIO_ROOT}/hf && ${sudo}chown -R ubuntu:ubuntu ${AUDIO_ROOT}`,
    `export HF_HOME=${AUDIO_ROOT}/hf HF_HUB_ENABLE_HF_TRANSFER=0 PIP_DISABLE_PIP_VERSION_CHECK=1`,
    `if [ -f ${AUDIO_ROOT}/hf/token ]; then export HF_TOKEN="$(cat ${AUDIO_ROOT}/hf/token)"; fi`,
    // A pin change starts clean; the same pin keeps the venv and the cache (resumed downloads).
    `rm -f ${dir}/READY`,
    `if [ ! -x ${py} ]; then python3.11 -m venv ${dir}/venv; fi`,
    `${py} -m pip install -U pip`,
    ...(asr || !m!.pip.includes('torch') ? [] : [`${py} -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128`]),
    `${py} -m pip install huggingface_hub ${pip.filter((p) => p !== 'torch' && p !== 'torchaudio').map((p) => `"${p}"`).join(' ')}`,
    ...(gitSrc ? [
      `if [ ! -d ${dir}/src/.git ]; then git clone --depth 1 ${m!.repo} ${dir}/src; fi`,
      `git -C ${dir}/src fetch --depth 1 origin ${m!.ref} && git -C ${dir}/src checkout -q FETCH_HEAD`,
      `git -C ${dir}/src rev-parse HEAD > ${dir}/COMMIT`,
      `if [ -f ${dir}/src/requirements.txt ]; then ${py} -m pip install -r ${dir}/src/requirements.txt || true; fi`,
    ] : []),
    ...repos.map((r) => `${py} -c "from huggingface_hub import snapshot_download; snapshot_download('${r}')"`),
    // Never READY on a half-written cache: verify.py compares what is on disk with what the hub lists.
    `${py} ${dir}/verify.py ${repos.join(' ')}`,
    `printf %s "$MARK" > ${dir}/READY`,
    `echo "audio ready ${id}"`,
  ].join('\n');
}

/** verify.py: no .incomplete blobs, and every repo's files are all there with the sizes the hub lists. */
export const VERIFY_PY = `import sys, os, glob
from huggingface_hub import HfApi, snapshot_download
hf = os.environ.get('HF_HOME', '/opt/hawkes-audio/hf')
bad = glob.glob(os.path.join(hf, '**', '*.incomplete'), recursive=True)
if bad:
    print('incomplete downloads:', bad[:3]); sys.exit(1)
api = HfApi()
for repo in sys.argv[1:]:
    info = api.model_info(repo, files_metadata=True)
    root = snapshot_download(repo)
    for f in info.siblings:
        p = os.path.join(root, f.rfilename)
        if not os.path.exists(p):
            print('missing', repo, f.rfilename); sys.exit(1)
        if f.size is not None and os.path.getsize(p) != f.size:
            print('size mismatch', repo, f.rfilename, os.path.getsize(p), f.size); sys.exit(1)
print('verified')
`;

/** The runner (post/audio/run.py), asr.py and verify.py are copied to each model's folder at install; see audio.ts. */
