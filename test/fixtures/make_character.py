"""A small skinned character for test/character.test.ts, exported as FBX the way Mixamo ships them:

    blender -b --factory-startup -P make_character.py -- out.fbx

Mixamo bone names ("mixamorig:Hips" ...) in a T-pose, a cylinder per bone (rigidly weighted to it, with UVs and a
UV-grid texture), and one action, "Wave", that lifts the left arm.
"""

import math
import sys

import bpy
import mathutils

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)

# name: (head, tail, parent)
BONES = {
    "Hips": ((0, 0, 0.95), (0, 0, 1.05), None),
    "Spine": ((0, 0, 1.05), (0, 0, 1.2), "Hips"),
    "Spine1": ((0, 0, 1.2), (0, 0, 1.32), "Spine"),
    "Spine2": ((0, 0, 1.32), (0, 0, 1.45), "Spine1"),
    "Neck": ((0, 0, 1.45), (0, 0, 1.55), "Spine2"),
    "Head": ((0, 0, 1.55), (0, 0, 1.75), "Neck"),
    "HeadTop_End": ((0, 0, 1.75), (0, 0, 1.8), "Head"),
}
for s, x in (("Left", 1), ("Right", -1)):
    BONES.update({
        f"{s}Shoulder": ((0.05 * x, 0, 1.42), (0.2 * x, 0, 1.42), "Spine2"),
        f"{s}Arm": ((0.2 * x, 0, 1.42), (0.45 * x, 0, 1.42), f"{s}Shoulder"),
        f"{s}ForeArm": ((0.45 * x, 0, 1.42), (0.7 * x, 0, 1.42), f"{s}Arm"),
        f"{s}Hand": ((0.7 * x, 0, 1.42), (0.8 * x, 0, 1.42), f"{s}ForeArm"),
        f"{s}UpLeg": ((0.1 * x, 0, 0.92), (0.1 * x, 0, 0.5), "Hips"),
        f"{s}Leg": ((0.1 * x, 0, 0.5), (0.1 * x, 0, 0.08), f"{s}UpLeg"),
        f"{s}Foot": ((0.1 * x, 0, 0.08), (0.1 * x, -0.12, 0.02), f"{s}Leg"),
        f"{s}ToeBase": ((0.1 * x, -0.12, 0.02), (0.1 * x, -0.2, 0.02), f"{s}Foot"),
    })

data = bpy.data.armatures.new("Armature")
arm = bpy.data.objects.new("Armature", data)
bpy.context.scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
for name, (h, t, parent) in BONES.items():
    b = data.edit_bones.new(f"mixamorig:{name}")
    b.head, b.tail = h, t
    if parent:
        b.parent = data.edit_bones[f"mixamorig:{parent}"]
        b.use_connect = False
bpy.ops.object.mode_set(mode="OBJECT")

img = bpy.data.images.new("grid", 256, 256)
img.generated_type = "COLOR_GRID"
img.pack()
mat = bpy.data.materials.new("skin")
mat.use_nodes = True
tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = img
mat.node_tree.links.new(tex.outputs["Color"], mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"])

parts = []
for name, (h, t, _) in BONES.items():
    if name.endswith("_End"):
        continue
    a, b = mathutils.Vector(h), mathutils.Vector(t)
    d = b - a
    r = 0.1 if name == "Head" else 0.07 if name.startswith("Spine") or name == "Hips" else 0.04
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=max(d.length, 0.02), location=(a + b) / 2, vertices=24)
    o = bpy.context.active_object
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = mathutils.Vector((0, 0, 1)).rotation_difference(d.normalized())
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.subdivide(number_cuts=3)
    bpy.ops.object.mode_set(mode="OBJECT")
    g = o.vertex_groups.new(name=f"mixamorig:{name}")
    g.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
    o.data.materials.append(mat)
    parts.append(o)
bpy.ops.object.select_all(action="DESELECT")
for o in parts:
    o.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
body = bpy.context.active_object
body.name = "Body"
body.parent = arm
mod = body.modifiers.new("Armature", "ARMATURE")
mod.object = arm

arm.animation_data_create()
act = bpy.data.actions.new("Wave")
arm.animation_data.action = act
pb = arm.pose.bones["mixamorig:LeftArm"]
pb.rotation_mode = "QUATERNION"
for f, angle in ((1, 0.0), (12, 1.2), (24, 0.0)):
    pb.rotation_quaternion = mathutils.Quaternion((0, 0, 1), angle)
    pb.keyframe_insert("rotation_quaternion", frame=f)
bpy.context.scene.frame_start, bpy.context.scene.frame_end = 1, 24
bpy.context.scene.render.fps = 30
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.fbx(filepath=out, add_leaf_bones=False, bake_anim=True, bake_anim_use_nla_strips=False,
                         bake_anim_use_all_actions=True, path_mode="COPY", embed_textures=True)
print("made", out)
