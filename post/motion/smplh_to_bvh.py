# HY-Motion writes SMPL-H pose parameters (axis-angle, 30 fps). This turns those into a BVH on the 22 body
# joints, with the names blender.character's "smpl" scheme already retargets. It does not load an SMPL body
# model: the rest pose is a standing skeleton, and each joint's pose is the model's own rotation.
#
#   blender -b --factory-startup --python-exit-code 1 -P smplh_to_bvh.py -- <npz-or-dir> <out-dir>
#   blender -b --factory-startup --python-exit-code 1 -P smplh_to_bvh.py -- --selftest <out-dir>

import math
import sys

import bpy
import mathutils
import numpy as np

FPS = 30
# SMPL body order. "shoulder" is the upper arm, "collar" the clavicle.
JOINTS = [
    "pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2",
    "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot", "neck",
    "left_collar", "right_collar", "head", "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow", "left_wrist", "right_wrist",
]
PARENT = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19]
# Standing A-pose, Y-up, meters. Arms hang down and out so a zero pose is a person, not a T.
REST = {
    "pelvis": (0, 0.95, 0),
    "left_hip": (0.09, 0.90, 0), "right_hip": (-0.09, 0.90, 0),
    "spine1": (0, 1.08, 0),
    "left_knee": (0.09, 0.50, 0), "right_knee": (-0.09, 0.50, 0),
    "spine2": (0, 1.20, 0),
    "left_ankle": (0.09, 0.08, 0), "right_ankle": (-0.09, 0.08, 0),
    "spine3": (0, 1.34, 0),
    "left_foot": (0.09, 0.03, 0.12), "right_foot": (-0.09, 0.03, 0.12),
    "neck": (0, 1.48, 0),
    "left_collar": (0.06, 1.40, 0), "right_collar": (-0.06, 1.40, 0),
    "head": (0, 1.58, 0),
    "left_shoulder": (0.20, 1.36, 0), "right_shoulder": (-0.20, 1.36, 0),
    "left_elbow": (0.36, 1.12, 0), "right_elbow": (-0.36, 1.12, 0),
    "left_wrist": (0.48, 0.92, 0), "right_wrist": (-0.48, 0.92, 0),
}
# Y-up column vector -> Blender Z-up.
_Y2Z = mathutils.Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))


def rodrigues(aa):
    x, y, z = (float(v) for v in aa)
    th = math.sqrt(x * x + y * y + z * z)
    if th < 1e-8:
        return mathutils.Matrix.Identity(3)
    x, y, z = x / th, y / th, z / th
    c, s = math.cos(th), math.sin(th)
    C = 1 - c
    return mathutils.Matrix((
        (c + x * x * C, x * y * C - z * s, x * z * C + y * s),
        (y * x * C + z * s, c + y * y * C, y * z * C - x * s),
        (z * x * C - y * s, z * y * C + x * s, c + z * z * C),
    ))


def yup_to_zup_rot(R):
    return _Y2Z @ R @ _Y2Z.transposed()


def build_armature():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    arm_data = bpy.data.armatures.new("motion")
    arm = bpy.data.objects.new("motion", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    arm.rotation_euler = (math.radians(90), 0, 0)
    bpy.context.view_layer.update()
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    bones = {}
    for j, name in enumerate(JOINTS):
        b = arm_data.edit_bones.new(name)
        head = mathutils.Vector(REST[name])
        kids = [k for k in range(len(JOINTS)) if PARENT[k] == j]
        if kids:
            tail = mathutils.Vector(REST[JOINTS[kids[0]]])
        else:
            parent = mathutils.Vector(REST[JOINTS[PARENT[j]]])
            tail = head + (head - parent).normalized() * 0.08
        local = lambda v: mathutils.Vector((v.x, v.y, -v.z))
        b.head, b.tail = local(head), local(tail)
        if PARENT[j] >= 0:
            b.parent = bones[JOINTS[PARENT[j]]]
        bones[name] = b
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    return arm


def apply_clip(arm, poses, trans):
    """Each SMPL local rotation is applied in that bone's own axes. A zero pose stays the rest pose,
    and a parent rotation is not applied twice (Blender's hierarchy carries it)."""
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = 1, len(poses)
    Wr = arm.matrix_world.to_3x3()
    rests = {b.name: arm.data.bones[b.name].matrix_local.to_3x3() for b in arm.pose.bones}
    for f in range(len(poses)):
        scene.frame_set(f + 1)
        for j, name in enumerate(JOINTS):
            R = yup_to_zup_rot(rodrigues(poses[f, j]))
            world = Wr.inverted() @ R @ Wr
            arm.pose.bones[name].rotation_euler = (rests[name].inverted() @ world @ rests[name]).to_euler("XYZ")
        delta = mathutils.Vector((float(trans[f, 0]), -float(trans[f, 2]), float(trans[f, 1])))
        hips = arm.pose.bones["pelvis"]
        hips.location = rests["pelvis"].inverted() @ Wr.inverted() @ delta
        for pb in arm.pose.bones:
            pb.keyframe_insert("rotation_euler", frame=f + 1)
        hips.keyframe_insert("location", frame=f + 1)


def write_bvh(arm, path, n):
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.export_anim.bvh(filepath=path, frame_start=1, frame_end=n, rotate_mode="XYZ", root_transform_only=True)


def load_npz(path):
    z = np.load(path, allow_pickle=True)
    poses = np.asarray(z["poses"], dtype=np.float64)
    if poses.ndim == 2:
        poses = poses.reshape(poses.shape[0], -1, 3)
    poses = poses[:, :22, :]
    trans = np.asarray(z["trans"], dtype=np.float64) if "trans" in z.files else np.zeros((len(poses), 3))
    if trans.ndim == 1:
        trans = trans.reshape(-1, 3)
    return poses, trans


def convert_file(npz_path, bvh_path):
    poses, trans = load_npz(npz_path)
    arm = build_armature()
    apply_clip(arm, poses, trans)
    write_bvh(arm, bvh_path, len(poses))
    print("bvh", bvh_path, "frames", len(poses))


def convert_dir(src, dst):
    import os
    os.makedirs(dst, exist_ok=True)
    if os.path.isfile(src) and src.endswith(".npz"):
        files = [src]
    else:
        files = sorted(os.path.join(src, n) for n in os.listdir(src) if n.endswith(".npz"))
    if not files:
        raise SystemExit(f"no npz in {src}")
    for i, f in enumerate(files):
        convert_file(f, os.path.join(dst, f"take-{i}.bvh"))


def _motion_rows(path):
    lines = open(path).read().splitlines()
    start = lines.index("MOTION")
    rows = []
    for line in lines[start + 3:]:
        if line.strip():
            rows.append([float(x) for x in line.split()])
    return rows


def selftest(dst):
    import os
    os.makedirs(dst, exist_ok=True)
    n = 6
    poses = np.zeros((n, 22, 3))
    trans = np.zeros((n, 3))
    trans[:, 0] = np.linspace(0, 1, n)
    zero = os.path.join(dst, "zero.npz")
    np.savez(zero, poses=poses.reshape(n, -1), trans=trans)
    convert_file(zero, os.path.join(dst, "zero.bvh"))
    text = open(os.path.join(dst, "zero.bvh")).read()
    for name in ("pelvis", "left_hip", "left_shoulder", "left_elbow", "left_wrist"):
        if f"JOINT {name}" not in text and f"ROOT {name}" not in text:
            raise SystemExit(f"missing {name}")
    rows = _motion_rows(os.path.join(dst, "zero.bvh"))
    if len(rows) != n:
        raise SystemExit(f"expected {n} frames, got {len(rows)}")
    # Root channels are the first 6; the rest are rotations and should stay near zero for a zero pose.
    for row in rows:
        if max(abs(v) for v in row[3:]) > 1.5:
            raise SystemExit(f"zero pose wrote a rotation: {row[:12]}")
    bent = poses.copy()
    bent[:, 18, 2] = 1.0  # left_elbow
    np.savez(os.path.join(dst, "elbow.npz"), poses=bent.reshape(n, -1), trans=trans)
    convert_file(os.path.join(dst, "elbow.npz"), os.path.join(dst, "elbow.bvh"))
    a = _motion_rows(os.path.join(dst, "zero.bvh"))[-1]
    b = _motion_rows(os.path.join(dst, "elbow.bvh"))[-1]
    changed = [i for i, (x, y) in enumerate(zip(a, b)) if abs(x - y) > 2]
    if not changed:
        raise SystemExit("elbow rotation did not change the BVH")
    print("selftest ok", "changed channels", len(changed))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    if not argv:
        raise SystemExit("usage: smplh_to_bvh.py -- <npz-or-dir> <out-dir> | --selftest <out-dir>")
    if argv[0] == "--selftest":
        selftest(argv[1])
    else:
        convert_dir(argv[0], argv[1])


if __name__ == "__main__":
    main()
