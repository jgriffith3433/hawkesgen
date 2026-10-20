# HY-Motion 1.0 fallback. No prompt rewriter (that is a third model) and no FBX SDK: the runtime
# still saves an npz of SMPL-H poses, and smplh_to_bvh.py turns the body joints into a BVH.
# SMPL body-model weights are not downloaded.
#
#   python hymotion_run.py <repo> <model_dir>

import os
import sys

import numpy as np


def main():
    repo, model = sys.argv[1], sys.argv[2]
    sys.path.insert(0, repo)
    os.environ.setdefault("USE_HF_MODELS", "1")
    prompt = open("prompt.txt", encoding="utf-8").read().strip()
    # One duration for the whole clip. Key-pose beats are already written into the prompt.
    seconds = float(open("seconds.txt", encoding="utf-8").read().strip())
    takes = int(open("takes.txt", encoding="utf-8").read().strip())
    seed = int(open("seed.txt", encoding="utf-8").read().strip())
    seeds = [seed + i for i in range(takes)]
    from hymotion.utils.t2m_runtime import T2MRuntime
    cfg = os.path.join(model, "config.yml")
    ckpt = os.path.join(model, "latest.ckpt")
    runtime = T2MRuntime(config_path=cfg, ckpt_name=ckpt, device_ids=[0], disable_prompt_engineering=True)
    os.makedirs("out/hy", exist_ok=True)
    runtime.generate_motion(
        text=prompt, seeds_csv=",".join(str(s) for s in seeds), duration=seconds, cfg_scale=5.0,
        output_format="dict", output_dir="out/hy", output_filename="take", original_text=prompt,
    )
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
