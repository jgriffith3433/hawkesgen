"""Runs NVIDIA GEM-X Body Motion on one video and writes what soma_to_bvh.py needs (motion.from-video).

    python gemx_run.py --video in/clip.mp4 --root /opt/hawkes-mocap/gemx/src --weights <dir>/weights --soma <dir>/soma \
                       --out out/mocap [--camera static|background] [--start 0] [--seconds 8]

Runs `gem-infer motion-video` (the native77 final775 release, Contact/IK postprocessing on: the feet stay planted),
then reads the world-space SOMA parameters and writes <out>/soma.npz:

    local_rot_mats  (T, 77, 3, 3)  each public joint's rotation (Hips first, then the 76 body joints), from the saved
                                   axis-angle global_orient and body_pose
    transl          (T, 3)         the body's world translation (meters, Y up)
    joints          (T, 77, 3)     every public joint's world position from SOMA's own forward kinematics: the truth
                                   the converter checks itself against
    fps             ()             30 (GEM-X normalises the clip to 30 Hz)

and <out>/gemx.json (frames, seconds, camera mode, what was postprocessed). Prints "HB step ..." lines for Gen.
"""

import argparse
import json
import os
import subprocess
import sys


def hb(msg):
    print(f"HB {msg}", flush=True)


def config_for(root, weights, camera):
    """The repository's native77 video configuration with every checkpoint pointed at the weights folder."""
    import yaml

    src = os.path.join(root, "docs", "configs", "body_video_native77.yaml")
    with open(src, encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    w = lambda name: os.path.join(weights, name)  # noqa: E731
    cfg["pose"]["checkpoint"] = w("body_s240000.ckpt")
    cfg["observations"]["checkpoint"] = w("vitpose.pth")
    cfg["detector"]["checkpoint"] = w("yolox_humanart.onnx")
    cfg["motion"]["checkpoint"] = w("motion_native77_e774_s292175.ckpt")
    cfg["motion"]["stats"] = w("motion_stats_raw.npz")
    cfg.setdefault("camera", {})["mode"] = camera
    for key, path in (("pose", cfg["pose"]["checkpoint"]), ("observations", cfg["observations"]["checkpoint"]),
                      ("detector", cfg["detector"]["checkpoint"]), ("motion", cfg["motion"]["checkpoint"])):
        if not os.path.isfile(path):
            raise SystemExit(f"GEM-X's {key} weights are missing: {path}")
    return cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--root", required=True)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--soma", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--camera", default="background", choices=["background", "static"])
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--seconds", type=float, default=0.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    import yaml

    cfg = config_for(a.root, a.weights, a.camera)
    cfg_path = os.path.join(a.out, "body_video.yaml")
    with open(cfg_path, "w", encoding="utf-8") as fh:
        yaml.safe_dump(cfg, fh)

    motion_pt = os.path.join(a.out, "motion.pt")
    gem_infer = os.path.join(os.path.dirname(sys.executable), "gem-infer")
    cmd = [gem_infer if os.path.exists(gem_infer) else "gem-infer", "motion-video", "--task", "body", "--input", a.video,
           "--config", cfg_path, "--device", "cuda", "--postprocess", "--soma-assets", a.soma,
           "--camera-mode", a.camera, "--output", motion_pt]
    if a.start > 0:
        cmd += ["--start", f"{a.start:.3f}"]
    if a.seconds > 0:
        cmd += ["--duration", f"{a.seconds:.3f}"]
    hb("step finding the person and reading their motion (GEM-X)")
    subprocess.check_call(cmd)

    import numpy as np
    import torch

    hb("step reading GEM-X's SOMA parameters")
    result = torch.load(motion_pt, map_location="cpu", weights_only=False)
    params = result["pred_soma_params_global"]
    if params["body_pose"].shape[0] != 1:
        raise SystemExit("GEM-X returned more than one sequence")
    length = int(torch.as_tensor(result["length"]).reshape(-1)[0].item())
    if length < 2:
        raise SystemExit("GEM-X found fewer than two frames of motion (is a whole person in the video?)")

    def aa_to_mat(aa):
        """Rodrigues: axis-angle (..., 3) to rotation matrices (..., 3, 3)."""
        aa = torch.as_tensor(aa, dtype=torch.float32)
        angle = aa.norm(dim=-1, keepdim=True).clamp_min(1e-8)
        axis = aa / angle
        x, y, z = axis.unbind(-1)
        c, s = torch.cos(angle[..., 0]), torch.sin(angle[..., 0])
        C = 1 - c
        return torch.stack([
            c + x * x * C, x * y * C - z * s, x * z * C + y * s,
            y * x * C + z * s, c + y * y * C, y * z * C - x * s,
            z * x * C - y * s, z * y * C + x * s, c + z * z * C,
        ], dim=-1).reshape(*aa.shape[:-1], 3, 3)

    root = params["global_orient"][0, :length]
    body = params["body_pose"][0, :length]
    body = body.reshape(length, 76, 3) if body.shape[-1] == 228 else body
    if body.shape[-2:] == (76, 3):
        rots = aa_to_mat(torch.cat([root.reshape(length, 1, 3), body], dim=1))
    else:
        raise SystemExit(f"unexpected body_pose shape {tuple(body.shape)}")
    transl = params["transl"][0, :length].float()

    hb("step computing SOMA's joint positions")
    from gem.motion.geometry import MotionGeometry

    try:
        from gem.motion.postprocess.api import ieee_geometry
    except Exception:  # noqa: BLE001
        from contextlib import nullcontext as ieee_geometry
    geometry = MotionGeometry(a.soma, device="cuda" if torch.cuda.is_available() else "cpu", chunk_size=32, apply_correctives=False)
    sliced = {k: (v[:, :length] if torch.is_tensor(v) and v.ndim >= 2 and v.shape[1] >= length and k in ("global_orient", "body_pose", "transl") else v)
              for k, v in params.items()}
    joints = np.empty((length, 77, 3), dtype=np.float32)
    with ieee_geometry():
        for start, chunk in geometry.iter_chunks(sliced):
            j = chunk["joints"][0].numpy()
            joints[start:start + len(j)] = j

    try:
        from gem.motion.frontend.joint_sets import SOMA77_JOINT_NAMES as names
    except Exception:  # noqa: BLE001 - the converter then assumes SOMA's public order (the same as Kimodo's somaskel77)
        names = ()
    np.savez(os.path.join(a.out, "soma.npz"), local_rot_mats=rots.numpy().astype(np.float32), transl=transl.numpy().astype(np.float32),
             joints=joints, fps=np.float32(30.0), names=np.array(list(names)))
    with open(os.path.join(a.out, "gemx.json"), "w") as fh:
        json.dump({"frames": length, "seconds": round(length / 30.0, 3), "camera": a.camera, "postprocessed": bool(result.get("postprocessing")),
                   "start": a.start, "requested": a.seconds or None}, fh)
    hb(f"mocap frames {length}")


if __name__ == "__main__":
    main()
