# HY-Motion 1.0 fallback. No prompt rewriter (that is a third model) and no FBX SDK: the runtime
# still saves an npz of SMPL-H poses, and smplh_to_bvh.py turns the body joints into a BVH.
# SMPL body-model weights are not downloaded.
#
#   python hymotion_run.py <repo> <model_dir>

import os
import sys

import numpy as np


WOODEN = os.path.join("scripts", "gradio", "static", "assets", "dump_wooden")


def lfs_assets(repo):
    """The wooden body template HY-Motion loads is in Git LFS: a shallow fetch leaves 130-byte pointers. Replace each
    pointer with the real file from GitHub's LFS media URL at the checked-out commit (once; they stay in the repo)."""
    import subprocess
    import urllib.request

    folder = os.path.join(repo, WOODEN)
    if not os.path.isdir(folder):
        return
    commit = subprocess.check_output(["git", "-C", repo, "rev-parse", "HEAD"], text=True).strip()
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        with open(path, "rb") as fh:
            head = fh.read(64)
        if not head.startswith(b"version https://git-lfs"):
            continue
        url = f"https://media.githubusercontent.com/media/Tencent-Hunyuan/HY-Motion-1.0/{commit}/{WOODEN.replace(os.sep, '/')}/{name}"
        print(f"HB step fetching HY-Motion's body template ({name})", flush=True)
        with urllib.request.urlopen(url, timeout=120) as r:
            data = r.read()
        if data.startswith(b"version https://git-lfs"):
            raise SystemExit(f"{name}: GitHub returned the LFS pointer, not the file")
        with open(path, "wb") as fh:
            fh.write(data)


def main():
    repo, model = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    job = os.getcwd()
    sys.path.insert(0, repo)
    os.environ.setdefault("USE_HF_MODELS", "1")
    prompt = open("prompt.txt", encoding="utf-8").read().strip()
    # One duration for the whole clip. Key-pose beats are already written into the prompt.
    seconds = float(open("seconds.txt", encoding="utf-8").read().strip())
    takes = int(open("takes.txt", encoding="utf-8").read().strip())
    seed = int(open("seed.txt", encoding="utf-8").read().strip())
    seeds = [seed + i for i in range(takes)]
    lfs_assets(repo)
    # HY-Motion opens its assets by paths relative to its repo: run from there, write into the job folder.
    os.chdir(repo)
    from hymotion.utils.t2m_runtime import T2MRuntime
    cfg = os.path.join(model, "config.yml")
    ckpt = os.path.join(model, "latest.ckpt")
    runtime = T2MRuntime(config_path=cfg, ckpt_name=ckpt, device_ids=[0], disable_prompt_engineering=True)
    out = os.path.join(job, "out", "hy")
    os.makedirs(out, exist_ok=True)
    runtime.generate_motion(
        text=prompt, seeds_csv=",".join(str(s) for s in seeds), duration=seconds, cfg_scale=5.0,
        output_format="dict", output_dir=out, output_filename="take", original_text=prompt,
    )
    os.chdir(job)
    files = sorted(n for n in os.listdir("out/hy") if n.endswith(".npz"))
    if not files:
        raise SystemExit("HY-Motion wrote no npz")
    # Keep the original prompt on the npz's neighbor so the BVH step can find every sample.
    print("hymotion npz", len(files))
    open("out/hy/count.txt", "w").write(str(len(files)) + "\n")
    # Touch a marker the shell reads. Poses stay in the npz (T, 156) with trans.
    z = np.load(os.path.join("out/hy", files[0]))
    if "poses" not in z.files:
        raise SystemExit(f"{files[0]} has no poses ({list(z.files)})")


if __name__ == "__main__":
    main()
