"""An unrigged humanoid mesh for test/rig.test.ts, like the ones mesh.from-image and mesh.textured make: one object,
Y-up GLB, standing on the ground, facing the viewer, arms out in an A-pose. Built from overlapping primitives (a
generated mesh is one closed shell, so the pile is remeshed into one, about 1 cm voxels: dense, like theirs).

    blender -b --factory-startup -P make_humanoid.py -- out.glb
"""

import math
import sys

import bpy

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)


def limb(a, b, r, caps=True):
    """A cylinder from point a to point b, radius r, with a ball at each end."""
    a, b = [float(x) for x in a], [float(x) for x in b]
    d = [b[i] - a[i] for i in range(3)]
    length = math.sqrt(sum(x * x for x in d))
    mid = [(a[i] + b[i]) / 2 for i in range(3)]
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=length, location=mid, vertices=16)
    o = bpy.context.active_object
    o.rotation_mode = "QUATERNION"
    import mathutils
    o.rotation_quaternion = mathutils.Vector((0, 0, 1)).rotation_difference(mathutils.Vector(d).normalized())
    for p in (a, b) if caps else ():
        bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=p, segments=16, ring_count=8)


# 1.8 m tall, arms 40 degrees below horizontal.
drop = math.radians(40)
for s in (1, -1):
    sh = (0.19 * s, 0, 1.45)
    el = (sh[0] + 0.28 * math.cos(drop) * s, 0, sh[2] - 0.28 * math.sin(drop))
    wr = (el[0] + 0.25 * math.cos(drop) * s, 0, el[2] - 0.25 * math.sin(drop))
    tip = (wr[0] + 0.15 * math.cos(drop) * s, 0, wr[2] - 0.15 * math.sin(drop))
    limb(sh, el, 0.05)
    limb(el, wr, 0.045)
    limb(wr, tip, 0.04)
    limb((0.1 * s, 0, 0.92), (0.1 * s, 0, 0.5), 0.075)
    limb((0.1 * s, 0, 0.5), (0.1 * s, 0, 0.09), 0.06)
    limb((0.1 * s, 0.02, 0.05), (0.1 * s, -0.16, 0.05), 0.05)
limb((0, 0, 0.86), (0, 0, 1.47), 0.16, caps=False)  # torso
limb((0, 0, 1.4), (0, 0, 1.58), 0.05)  # neck
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.12, location=(0, 0, 1.68), segments=24, ring_count=12)

meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join()
bpy.context.active_object.name = "character"
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
rm = bpy.context.active_object.modifiers.new("remesh", "REMESH")
rm.mode = "VOXEL"
rm.voxel_size = 0.012
bpy.ops.object.modifier_apply(modifier=rm.name)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB")
print("made", out)
