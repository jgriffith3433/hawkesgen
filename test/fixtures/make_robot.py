"""A hard-surface quadarm robot (body + 4 legs + 2 arms) for blender.character robot ops.

    blender -b --factory-startup -P make_robot.py -- out.glb

Separate mesh objects (connected split finds them); no armature yet — template builds it.
"""

import sys

import bpy
import mathutils

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)

mat = bpy.data.materials.new("metal")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.6, 0.65, 1)


def box(name, loc, scale):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    o.data.materials.append(mat)
    return o


def cyl(name, loc, depth, radius=0.06, axis="Z"):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=loc, vertices=12)
    o = bpy.context.active_object
    o.name = name
    if axis == "X":
        o.rotation_euler = (0, 1.5708, 0)
    elif axis == "Y":
        o.rotation_euler = (1.5708, 0, 0)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    o.data.materials.append(mat)
    return o


box("body", (0, 0, 0.45), (0.35, 0.45, 0.25))
box("head", (0, -0.05, 0.75), (0.18, 0.18, 0.16))
for name, x, y in (("leg_fl", -0.22, -0.25), ("leg_fr", 0.22, -0.25), ("leg_bl", -0.22, 0.25), ("leg_br", 0.22, 0.25)):
    cyl(name, (x, y, 0.22), 0.4, 0.05)
cyl("arm_l", (-0.45, 0, 0.5), 0.35, 0.045, "X")
cyl("arm_r", (0.45, 0, 0.5), 0.35, 0.045, "X")

objs = [o for o in bpy.data.objects if o.type == "MESH"]
lo = min((o.matrix_world @ mathutils.Vector(c)).z for o in objs for c in o.bound_box)
for o in objs:
    o.location.z -= lo
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False, export_animations=False)
print("wrote", out)
