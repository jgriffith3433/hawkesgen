"""Prints CHECK {json}: which way a rigged GLB's skeleton points, its height and its materials.

    blender -b --factory-startup -P check_upright.py -- rigged.glb
"""
import json
import sys

import bpy

path = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
meshes = [o for o in bpy.data.objects if o.type == "MESH" and not o.name.startswith("Icosphere")]
bone = lambda n: next(b for b in arm.data.bones if b.name.endswith(n))
W = arm.matrix_world
up = (W @ bone("Head").head_local - W @ bone("Hips").head_local).normalized()
fwd = W @ bone("LeftToeBase").head_local - W @ bone("LeftFoot").head_local
left = W @ bone("LeftArm").head_local - W @ bone("RightArm").head_local
zs = [(o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices]
print("CHECK " + json.dumps({
    "up": list(up), "forward": list(fwd.normalized()), "left": list(left.normalized()),
    "height": max(zs) - min(zs), "bottom": min(zs), "meshes": len(meshes),
    "materials": sorted({m.name for o in meshes for m in o.data.materials if m}),
}))
