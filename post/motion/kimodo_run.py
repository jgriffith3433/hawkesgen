# Runs Kimodo's CLI for one prompt. The prompt and the durations stay in files so a quote in the
# text cannot break the shell. SOMA only: the SMPL-X checkpoint is a research license, not this tool.
#
#   python kimodo_run.py
# Reads prompt.txt, duration.txt, optional constraints.json. Writes out/kimodo*.bvh then copies
# them to out/bvhs/take-N.bvh.

import glob
import os
import shutil
import subprocess
import sys

MODEL = "Kimodo-SOMA-RP-v1.2"


def main():
    prompt = open("prompt.txt", encoding="utf-8").read().strip()
    duration = open("duration.txt", encoding="utf-8").read().strip()
    takes = open("takes.txt", encoding="utf-8").read().strip()
    seed = open("seed.txt", encoding="utf-8").read().strip()
    os.makedirs("out", exist_ok=True)
    cmd = [
        sys.executable, "-m", "kimodo.scripts.generate", prompt,
        "--model", MODEL,
        "--duration", duration,
        "--num_samples", takes,
        "--seed", seed,
        "--bvh", "--bvh_standard_tpose",
        "--output", "out/kimodo",
    ]
    if os.path.isfile("constraints.json"):
        cmd += ["--constraints", "constraints.json"]
    if MODEL.upper().find("SMPL") >= 0:
        raise SystemExit("refusing a SMPL Kimodo checkpoint")
    subprocess.check_call(cmd)
    found = sorted(glob.glob("out/kimodo*.bvh") + glob.glob("out/kimodo/**/*.bvh", recursive=True))
    if not found:
        raise SystemExit("Kimodo wrote no BVH")
    os.makedirs("out/bvhs", exist_ok=True)
    for i, src in enumerate(found):
        shutil.copyfile(src, f"out/bvhs/take-{i}.bvh")
    open("out/bvhs/backend.txt", "w").write("kimodo\n")
    print("kimodo takes", len(found))


if __name__ == "__main__":
    main()
