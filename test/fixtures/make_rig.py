"""A tiny rigged character for test/blender.test.ts, made in Blender and exported as GLB:

    blender -b --factory-startup -P make_rig.py -- out.glb

Mixamo-style bone names behind a different prefix ("rig:"), a box on each limb (parented to its bone) and one
action, "Wave", that lifts the left arm.
"""

import sys

import bpy

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)

# name: (head, tail, parent)
BONES = {
    "Hips": ((0, 0, 0.95), (0, 0, 1.05), None),
    "Spine": ((0, 0, 1.05), (0, 0, 1.35), "Hips"),
    "Neck": ((0, 0, 1.45), (0, 0, 1.55), "Spine"),
    "Head": ((0, 0, 1.55), (0, 0, 1.70), "Neck"),
    "HeadTop_End": ((0, 0, 1.75), (0, 0, 1.80), "Head"),
    "LeftArm": ((0.2, 0, 1.42), (0.45, 0, 1.42), "Spine"),
    "LeftForeArm": ((0.45, 0, 1.42), (0.7, 0, 1.42), "LeftArm"),
    "LeftHand": ((0.7, 0, 1.42), (0.8, 0, 1.42), "LeftForeArm"),
    "RightArm": ((-0.2, 0, 1.42), (-0.45, 0, 1.42), "Spine"),
    "RightForeArm": ((-0.45, 0, 1.42), (-0.7, 0, 1.42), "RightArm"),
    "RightHand": ((-0.7, 0, 1.42), (-0.8, 0, 1.42), "RightForeArm"),
    "LeftUpLeg": ((0.1, 0, 0.95), (0.1, 0, 0.5), "Hips"),
    "LeftLeg": ((0.1, 0, 0.5), (0.1, 0, 0.08), "LeftUpLeg"),
    "LeftFoot": ((0.1, 0, 0.08), (0.1, -0.12, 0.0), "LeftLeg"),
    "RightUpLeg": ((-0.1, 0, 0.95), (-0.1, 0, 0.5), "Hips"),
    "RightLeg": ((-0.1, 0, 0.5), (-0.1, 0, 0.08), "RightUpLeg"),
    "RightFoot": ((-0.1, 0, 0.08), (-0.1, -0.12, 0.0), "RightLeg"),
}

arm_data = bpy.data.armatures.new("rig")
arm = bpy.data.objects.new("rig", arm_data)
bpy.context.scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
for name, (h, t, parent) in BONES.items():
    b = arm_data.edit_bones.new(f"rig:{name}")
    b.head, b.tail = h, t
    if parent:
        b.parent = arm_data.edit_bones[f"rig:{parent}"]
bpy.ops.object.mode_set(mode="OBJECT")

# A box along each bone, parented to it.
for name, (h, t, _) in BONES.items():
    if name == "HeadTop_End":
        continue
    mid = [(a + b) / 2 for a, b in zip(h, t)]
    length = max(0.08, sum((a - b) ** 2 for a, b in zip(h, t)) ** 0.5)
    bpy.ops.mesh.primitive_cube_add(size=1, location=mid)
    box = bpy.context.active_object
    box.name = f"box_{name}"
    horizontal = abs(h[0] - t[0]) > abs(h[2] - t[2])
    box.scale = (length, 0.12, 0.12) if horizontal else (0.12, 0.12, length) if name != "Head" else (0.2, 0.22, 0.25)
    bpy.ops.object.transform_apply(scale=True)
    mw = box.matrix_world.copy()
    box.parent = arm
    box.parent_type = "BONE"
    box.parent_bone = f"rig:{name}"
    box.matrix_world = mw

# "Wave": the left arm goes up and down.
bpy.context.view_layer.objects.active = arm
arm.animation_data_create()
act = bpy.data.actions.new("Wave")
arm.animation_data.action = act
pb = arm.pose.bones["rig:LeftArm"]
pb.rotation_mode = "XYZ"
for f, angle in ((1, 0.0), (12, 1.2), (24, 0.0)):
    pb.rotation_euler = (0, 0, angle)
    pb.keyframe_insert("rotation_euler", frame=f)
bpy.context.scene.frame_end = 24
bpy.ops.export_scene.gltf(filepath=out, export_animations=True, export_format="GLB")
print("made", out)
