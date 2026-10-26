"""Writes what a rigger's file can look like, and the textured mesh it was given:

    blender -b --factory-startup -P make_lying.py -- rigged.glb mesh.glb lying.glb source.glb

lying.glb: the rigged GLB turned to lie along Y, scaled up, facing the side, with its materials dropped.
source.glb: mesh.glb (the same faces) with a material named "painted", as a textured input would have.
"""
import math
import sys

import bpy
import mathutils

rigged, mesh, lying, source = sys.argv[sys.argv.index("--") + 1:]


def only(kinds):
    objs = [o for o in bpy.data.objects if o.type in kinds and not o.name.startswith("Icosphere")]
    for o in list(bpy.data.objects):
        if o not in objs:
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    return objs


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=mesh)
objs = only({"MESH"})
mat = bpy.data.materials.new("painted")
for o in objs:
    o.data.materials.clear()
    o.data.materials.append(mat)
bpy.ops.export_scene.gltf(filepath=source, export_format="GLB", use_selection=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=rigged)
objs = only({"MESH", "ARMATURE"})
turn = mathutils.Matrix.Rotation(math.radians(70), 4, "Z") @ mathutils.Matrix.Rotation(math.radians(-90), 4, "X") @ mathutils.Matrix.Scale(1.7, 4)
for o in objs:
    if o.type == "MESH":
        o.data.materials.clear()
    if o.parent is None:
        o.matrix_world = turn @ o.matrix_world
bpy.context.view_layer.objects.active = next(o for o in objs if o.type == "ARMATURE")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.export_scene.gltf(filepath=lying, export_format="GLB", use_selection=True, export_skins=True, export_animations=False)
