"""A mocap clip for test/character.test.ts, exported as BVH: an SMPL-named skeleton ("pelvis", "left_shoulder" for
the upper arm, "left_collar" for the clavicle ...) standing in an A-pose (arms 45 degrees down: not the target's
T-pose), facing -Y. Over 20 frames the left arm swings forward and up, the right knee bends and the pelvis walks 1 m
forward. The file is Y-up, like mocap BVH files: the skeleton is built in a Y-up armature turned upright in Blender.

    blender -b --factory-startup -P make_mocap.py -- out.bvh
"""

import math
import sys

import bpy
import mathutils

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
c45 = math.cos(math.radians(45))

BONES = {
    "pelvis": ((0, 0, 0.9), (0, 0, 1.0), None),
    "spine1": ((0, 0, 1.0), (0, 0, 1.15), "pelvis"),
    "spine2": ((0, 0, 1.15), (0, 0, 1.28), "spine1"),
    "spine3": ((0, 0, 1.28), (0, 0, 1.4), "spine2"),
    "neck": ((0, 0, 1.4), (0, 0, 1.5), "spine3"),
    "head": ((0, 0, 1.5), (0, 0, 1.68), "neck"),
}
for s, x in (("left", 1), ("right", -1)):
    sh = (0.17 * x, 0, 1.36)
    el = (sh[0] + 0.24 * c45 * x, 0, sh[2] - 0.24 * c45)
    wr = (el[0] + 0.23 * c45 * x, 0, el[2] - 0.23 * c45)
    BONES.update({
        f"{s}_collar": ((0.04 * x, 0, 1.36), sh, "spine3"),
        f"{s}_shoulder": (sh, el, f"{s}_collar"),
        f"{s}_elbow": (el, wr, f"{s}_shoulder"),
        f"{s}_wrist": (wr, (wr[0] + 0.07 * c45 * x, 0, wr[2] - 0.07 * c45), f"{s}_elbow"),
        f"{s}_hip": ((0.09 * x, 0, 0.88), (0.09 * x, 0, 0.47), "pelvis"),
        f"{s}_knee": ((0.09 * x, 0, 0.47), (0.09 * x, 0, 0.07), f"{s}_hip"),
        f"{s}_ankle": ((0.09 * x, 0, 0.07), (0.09 * x, -0.11, 0.02), f"{s}_knee"),
        f"{s}_foot": ((0.09 * x, -0.11, 0.02), (0.09 * x, -0.18, 0.02), f"{s}_ankle"),
    })

yup = lambda v: (v[0], v[2], -v[1])
data = bpy.data.armatures.new("mocap")
arm = bpy.data.objects.new("mocap", data)
bpy.context.scene.collection.objects.link(arm)
arm.rotation_euler = (math.radians(90), 0, 0)
bpy.context.view_layer.update()
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
for name, (h, t, parent) in BONES.items():
    b = data.edit_bones.new(name)
    b.head, b.tail = yup(h), yup(t)
    if parent:
        b.parent = data.edit_bones[parent]
bpy.ops.object.mode_set(mode="OBJECT")

arm.animation_data_create()
arm.animation_data.action = bpy.data.actions.new("Raise")
for pb in arm.pose.bones:
    pb.rotation_mode = "XYZ"
Wr = arm.matrix_world.to_3x3()
for f in range(1, 21):
    t = (f - 1) / 19
    bpy.context.scene.frame_set(f)
    # The left upper arm swings forward and up (about the world X axis), in the bone's own space.
    up = arm.pose.bones["left_shoulder"]
    rest = arm.data.bones["left_shoulder"].matrix_local.to_3x3()
    world = Wr.inverted() @ mathutils.Matrix.Rotation(math.radians(-80) * t, 3, "X") @ Wr
    up.rotation_euler = (rest.inverted() @ world @ rest).to_euler("XYZ")
    up.keyframe_insert("rotation_euler", frame=f)
    knee = arm.pose.bones["right_knee"]
    rest = arm.data.bones["right_knee"].matrix_local.to_3x3()
    world = Wr.inverted() @ mathutils.Matrix.Rotation(math.radians(60) * t, 3, "X") @ Wr
    knee.rotation_euler = (rest.inverted() @ world @ rest).to_euler("XYZ")
    knee.keyframe_insert("rotation_euler", frame=f)
    hips = arm.pose.bones["pelvis"]
    hips.location = arm.data.bones["pelvis"].matrix_local.to_3x3().inverted() @ Wr.inverted() @ mathutils.Vector((0, -1.0 * t, 0))
    hips.keyframe_insert("location", frame=f)
bpy.context.scene.frame_start, bpy.context.scene.frame_end = 1, 20
bpy.context.scene.render.fps = 30
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_anim.bvh(filepath=out, frame_start=1, frame_end=20)
print("made", out)
