"""Reads back a character exported by hawkes_character.py for test/character.test.ts and prints one JSON line:

    blender -b --factory-startup -P check_character.py -- out.glb|out.fbx [clip source.glb|.bvh source_clip]

the bones, the animations (FBX takes or glTF animations), the height, whether the mesh is skinned, each animation's
frame count, and with a clip: how closely its limbs point the way the source's do (the lowest cosine over the clip's
frames, per limb), and where the hips travel.
"""

import json
import re
import sys

import bpy
import mathutils

args = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30
LIMBS = [("LeftArm", "LeftForeArm"), ("LeftForeArm", "LeftHand"), ("RightArm", "RightForeArm"), ("RightForeArm", "RightHand"),
         ("LeftUpLeg", "LeftLeg"), ("LeftLeg", "LeftFoot"), ("RightUpLeg", "RightLeg"), ("RightLeg", "RightFoot"), ("Spine", "Neck")]
SMPL = {"LeftArm": "left_shoulder", "LeftForeArm": "left_elbow", "LeftHand": "left_wrist", "RightArm": "right_shoulder",
        "RightForeArm": "right_elbow", "RightHand": "right_wrist", "LeftUpLeg": "left_hip", "LeftLeg": "left_knee",
        "LeftFoot": "left_ankle", "RightUpLeg": "right_hip", "RightLeg": "right_knee", "RightFoot": "right_ankle",
        "Spine": "spine1", "Neck": "neck", "Hips": "pelvis"}


def load(path):
    objs0, acts0 = set(bpy.data.objects), set(bpy.data.actions)
    if path.endswith(".fbx"):
        bpy.ops.import_scene.fbx(filepath=path)
    elif path.endswith(".bvh"):
        bpy.ops.import_anim.bvh(filepath=path, use_fps_scale=True)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in objs0], [a for a in bpy.data.actions if a not in acts0]


def find(arm, canon):
    for b in arm.pose.bones:
        n = b.name.split(":")[-1]
        if n == canon or n == SMPL.get(canon):
            return b
    return None


def play(arm, act):
    ad = arm.animation_data_create()
    for t in ad.nla_tracks:
        t.mute = True
    ad.action = act
    if hasattr(ad, "action_slot") and ad.action_slot is None and len(act.slots):
        ad.action_slot = act.slots[0]


def short(name):
    """An animation's own name: FBX takes import as "Armature|Walk|Layer0"-ish, and a second "Walk" becomes "Walk.001"."""
    parts = name.split("|")
    n = parts[1] if len(parts) > 2 else parts[-1]
    return re.sub(r"\.\d{3}$", "", n)


def dirs(arm, act, frames):
    play(arm, act)
    out = []
    for f in frames:
        scene.frame_set(f)
        W = arm.matrix_world
        row = {}
        for a, b in LIMBS:
            pa, pb = find(arm, a), find(arm, b)
            if pa and pb:
                row[a] = (W @ pb.head - W @ pa.head).normalized()
        hips = find(arm, "Hips")
        row["_hips"] = W @ hips.head
        out.append(row)
    return out


objs, acts = load(args[0])
arm = [o for o in objs if o.type == "ARMATURE"][0]
# Skinned meshes only (the glTF importer adds an Icosphere to draw bones with).
meshes = [o for o in objs if o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers)]
for a in acts:
    a.use_fake_user = True
if arm.animation_data:
    for t in list(arm.animation_data.nla_tracks):
        arm.animation_data.nla_tracks.remove(t)
    arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.matrix_basis = mathutils.Matrix()
scene.frame_set(1)
dg = bpy.context.evaluated_depsgraph_get()
zs = [(o.evaluated_get(dg).matrix_world @ mathutils.Vector(c)).z for o in meshes for c in o.evaluated_get(dg).bound_box]
got = {
    "bones": [b.name for b in arm.data.bones],
    "actions": {short(a.name): round(a.frame_range[1] - a.frame_range[0] + 1) for a in acts},
    "height": round(max(zs) - min(zs), 3) if zs else None,
    "skinned": any(m.type == "ARMATURE" for o in meshes for m in o.modifiers),
    "groups": max((len(o.vertex_groups) for o in meshes), default=0),
    "meshes": [o.name for o in meshes],
    "children": [o.name for o in objs if o.parent == arm and o.parent_type == "BONE"],
    "images": [i.name for i in bpy.data.images if i.size[0] > 0],
}
if len(args) >= 4 and args[1] == "--mirror":
    # Clip B should be clip A in a mirror: B's right limbs point where A's left ones do, flipped across x = 0.
    a_act, b_act = [next(a for a in acts if short(a.name) == n) for n in args[2:4]]
    frames = [int(a_act.frame_range[0]) + k for k in range(0, int(a_act.frame_range[1] - a_act.frame_range[0]) + 1, 3)]
    A, B = dirs(arm, a_act, frames), dirs(arm, b_act, frames)
    flip = lambda v: mathutils.Vector((-v.x, v.y, v.z))
    got["mirror"] = {limb: round(min(flip(ra[limb]).dot(rb[limb.replace("Left", "Right")]) for ra, rb in zip(A, B)), 3)
                     for limb in ("LeftArm", "LeftForeArm", "LeftUpLeg", "LeftLeg")}
elif len(args) >= 4:
    clip, src_path, src_clip = args[1:4]
    act = next(a for a in acts if short(a.name) == clip)
    a0, a1 = act.frame_range
    sobjs, sacts = load(src_path)
    src = [o for o in sobjs if o.type == "ARMATURE"][0]
    sact = next((a for a in sacts if short(a.name) == src_clip), sacts[0])
    s0, s1 = sact.frame_range
    n = int(min(a1 - a0, s1 - s0))
    frames_t = [int(a0) + k for k in range(0, n + 1, max(1, n // 12))]
    frames_s = [int(s0) + k for k in range(0, n + 1, max(1, n // 12))]
    t = dirs(arm, act, frames_t)
    s = dirs(src, sact, frames_s)
    got["cos"] = {limb: round(min(rt[limb].dot(rs[limb]) for rt, rs in zip(t, s)), 3) for limb, _ in LIMBS if limb in t[0] and limb in s[0]}
    got["travel"] = round((t[-1]["_hips"] - t[0]["_hips"]).length, 3)
    got["srcTravel"] = round((s[-1]["_hips"] - s[0]["_hips"]).length, 3)
    got["hipsZ"] = [round(r["_hips"].z, 3) for r in t]
print("CHECK " + json.dumps(got))
