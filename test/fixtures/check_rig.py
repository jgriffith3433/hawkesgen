"""Reads back a rigged GLB from hawkes_rig.py for test/rig.test.ts and prints what it has as one JSON line:

    blender -b --factory-startup -P check_rig.py -- rigged.glb clip.glb Wave

the bones, the animations, how much of the mesh each deforming bone moves, and, for the named animation, where the
left hand is at its first frame and a third of the way in, on the rig and on the clip's own skeleton.
"""

import json
import sys

import bpy

rigged, clip, name = sys.argv[sys.argv.index("--") + 1:][:3]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def load(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def hand(arm, action, frames):
    ad = arm.animation_data_create()
    for t in list(ad.nla_tracks):
        t.mute = True
    ad.action = action
    if hasattr(ad, "action_slot") and len(action.slots):
        ad.action_slot = action.slots[0]
    out = []
    pb = [p for p in arm.pose.bones if p.name.split(":")[-1] == "LeftHand"][0]
    for f in frames:
        scene.frame_set(f)
        out.append(list(arm.matrix_world @ pb.head))
    return out


objs = load(rigged)
arm = [o for o in objs if o.type == "ARMATURE"][0]
mesh = [o for o in objs if o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers)][0]
acts = sorted(a.name for a in bpy.data.actions)
action = bpy.data.actions[name]
a0, a1 = action.frame_range
mid = int(a0 + (a1 - a0) / 2)
got = {
    "bones": [b.name for b in arm.data.bones],
    "actions": acts,
    "range": [a0, a1],
    "skinned": any(m.object == arm for m in mesh.modifiers if m.type == "ARMATURE"),
    "groups": {g.name: 0 for g in mesh.vertex_groups},
}
for v in mesh.data.vertices:
    for g in v.groups:
        if g.weight > 0.2:
            got["groups"][mesh.vertex_groups[g.group].name] += 1
got["hand"] = hand(arm, action, [int(a0), mid])
# The mesh follows: its evaluated left side reaches higher or lower with the hand.
dg = bpy.context.evaluated_depsgraph_get()
ev = mesh.evaluated_get(dg)
got["leftTop"] = max((mesh.matrix_world @ v.co).z for v in ev.data.vertices if (mesh.matrix_world @ v.co).x > 0.45)

src_objs = load(clip)
src = [o for o in src_objs if o.type == "ARMATURE"][0]
src_act = src.animation_data.action if src.animation_data and src.animation_data.action else bpy.data.actions[0]
got["clipHand"] = hand(src, src_act, [int(src_act.frame_range[0]), int(src_act.frame_range[0] + (src_act.frame_range[1] - src_act.frame_range[0]) / 2)])
print("CHECK " + json.dumps(got))
