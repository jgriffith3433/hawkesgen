"""Headless Make-It-Animatable v2. Runs inside the rig venv, from any directory.

    python mia_run.py --input /job/in/prepared.glb --output /job/out/mia.fbx

The repo lives at $MIA_ROOT (default /opt/hawkes-rig/mia/src). Prints lines starting with "HB ".
"""

import argparse
import os
import shutil
import sys
import traceback
import types


def say(*parts):
    print("HB", *parts, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = os.environ.get("MIA_ROOT", "/opt/hawkes-rig/mia/src")
    if not os.path.isfile(os.path.join(root, "app_v2.py")):
        say("error", f"Make-It-Animatable is not installed at {root}")
        sys.exit(1)
    os.environ.setdefault("HF_HOME", "/opt/hawkes-rig/hf")
    # The Spaces decorator is a no-op here. Stub it so importing app_v2 never talks to Hugging Face Spaces.
    spaces = types.ModuleType("spaces")

    def GPU(fn=None, **_kwargs):
        if fn is None:
            return lambda f: f
        return fn

    spaces.GPU = GPU
    sys.modules["spaces"] = spaces

    os.chdir(root)
    sys.path.insert(0, root)
    say("step", "loading Make-It-Animatable v2")
    import app_v2

    # The pipeline's yields are shaped for Gradio. The names only need to exist; nothing reads them back.
    for name in (
        "state", "output_joints_coarse", "output_normed_input", "output_sample", "output_joints", "output_bw",
        "output_rest_lbs", "output_rest_vis", "output_anim_vis", "output_anim",
    ):
        if getattr(app_v2, name, None) is None:
            setattr(app_v2, name, name)
    app_v2.init_models()
    say("step", "rigging with Make-It-Animatable")
    stem = os.path.splitext(os.path.basename(args.input))[0]
    fbx = os.path.join(os.path.dirname(os.path.abspath(args.input)), stem, f"{stem}.fbx")
    db = app_v2.DB()
    try:
        for _ in app_v2._pipeline(
            os.path.abspath(args.input),
            no_fingers=False,
            rest_pose_type="No",
            ignore_pose_parts=None,
            input_normal=True,
            bw_fix=True,
            reset_to_rest=True,
            animation_file=None,
            retarget=False,
            inplace=True,
            restore_global=False,
            db=db,
        ):
            pass
    except Exception:
        if not (getattr(db, "anim_path", None) and os.path.isfile(db.anim_path)) and not os.path.isfile(fbx):
            raise
        traceback.print_exc()
        say("warning", "Make-It-Animatable finished the FBX and then failed on its preview convert; using the FBX")
    if getattr(db, "anim_path", None) and os.path.isfile(db.anim_path):
        fbx = db.anim_path
    if not os.path.isfile(fbx):
        say("error", f"Make-It-Animatable wrote no FBX (looked at {fbx})")
        sys.exit(1)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    shutil.copyfile(fbx, args.output)
    say("mia", args.output)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        traceback.print_exc()
        say("error", str(e))
        sys.exit(1)
