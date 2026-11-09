"""Turns GEM-X's SOMA motion (post/mocap/gemx_run.py's soma.npz) into the SOMA BVH that blender.character retargets
with bone names "soma": the same file Kimodo writes for motion.from-text (--bvh --bvh_standard_tpose). Runs in
Kimodo's venv, which has its SOMA skeleton (somaskel77) and BVH writer.

    python soma_to_bvh.py out/mocap/soma.npz out/bvhs/take-0.bvh out/mocap/convert.json

It checks itself. GEM-X's rotations are SOMA's own; Kimodo's local rotations are relative to its skeleton's rest pose.
Those should agree, but rather than trust that, each candidate convention is run through Kimodo's forward kinematics
and its bone directions are compared with SOMA's joint positions from GEM-X (directions, so the different body
proportions don't count). The best one is written; below 0.9 mean cosine the job fails and says so.
"""

import json
import sys

import numpy as np
import torch

# Fingers, eyes and the jaw are tiny bones whose directions are noise at this scale: the check uses the body.
SKIP = ("Thumb", "Index", "Middle", "Ring", "Pinky", "Eye", "Jaw", "End")


def main():
    src, out_bvh, report = sys.argv[1], sys.argv[2], sys.argv[3]
    from kimodo.exports.bvh import motion_to_bvh
    from kimodo.skeleton.definitions import SOMASkeleton77

    skel = SOMASkeleton77()
    d = np.load(src, allow_pickle=False)
    rots = torch.from_numpy(d["local_rot_mats"]).float()
    joints = torch.from_numpy(d["joints"]).float()
    fps = float(d["fps"])
    names = [str(n) for n in d["names"]] if "names" in d.files and len(d["names"]) else list(skel.bone_order_names)
    kimodo_names = list(skel.bone_order_names)
    if sorted(names) != sorted(kimodo_names):
        missing = sorted(set(kimodo_names) - set(names))
        raise SystemExit(f"GEM-X's joints are not Kimodo's somaskel77 (missing {missing[:6]})")
    if names != kimodo_names:
        order = [names.index(n) for n in kimodo_names]
        rots, joints = rots[:, order], joints[:, order]
    T = rots.shape[0]
    root = joints[:, skel.root_idx]
    parents = skel.joint_parents.cpu().numpy().astype(int)
    body = [i for i, n in enumerate(kimodo_names) if parents[i] >= 0 and not any(s in n for s in SKIP)]

    def directions(pos):
        v = pos[:, body] - pos[:, parents[body]]
        return v / v.norm(dim=-1, keepdim=True).clamp_min(1e-6)

    truth = directions(joints)

    def score(local):
        _, posed, _ = skel.fk(local, root)
        return float((directions(posed) * truth).sum(-1).mean())

    # Z-up to Y-up, should a release ever hand back Z-up world motion.
    zup = torch.tensor([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
    candidates = {"soma": rots}
    try:
        candidates["from-standard-tpose"] = skel.from_standard_tpose(rots)[0]
        candidates["to-standard-tpose"] = skel.to_standard_tpose(rots)[0]
    except Exception as e:  # noqa: BLE001 - the plain one still gets checked
        print(f"HB warning standard T-pose conversions unavailable: {e}", flush=True)
    for name in list(candidates):
        fixed = candidates[name].clone()
        fixed[:, skel.root_idx] = zup @ fixed[:, skel.root_idx]
        candidates[f"{name}+zup"] = fixed
    scores = {}
    for name, local in candidates.items():
        try:
            scores[name] = round(score(local), 4)
        except Exception as e:  # noqa: BLE001
            scores[name] = None
            print(f"HB warning convention {name} failed: {e}", flush=True)
    best = max((k for k in scores if scores[k] is not None), key=lambda k: scores[k])
    chosen = candidates[best]
    if best.endswith("+zup"):
        root = root @ zup.T
    result = {"frames": T, "fps": fps, "convention": best, "score": scores[best], "scores": scores}
    with open(report, "w") as fh:
        json.dump(result, fh, indent=1)
    if scores[best] < 0.9:
        raise SystemExit(f"GEM-X's motion did not convert cleanly onto the SOMA skeleton (best match {scores[best]} with {best}; "
                         f"scores {scores}): not writing a BVH that would twist the limbs")
    text = motion_to_bvh(chosen, root, skeleton=skel, fps=fps, standard_tpose=True)
    with open(out_bvh, "w", encoding="utf-8") as fh:
        fh.write(text)
    print(f"HB mocap converted with {best} (bone directions match {scores[best]:.3f})", flush=True)


if __name__ == "__main__":
    main()
