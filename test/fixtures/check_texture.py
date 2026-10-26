"""Prints CHECK {json}: a GLB's triangles, skin, and each image's size and share of black texels.

    blender -b --factory-startup -P check_texture.py -- model.glb
"""
import json
import sys

import bpy
import numpy as np

path = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)
meshes = [o for o in bpy.data.objects if o.type == "MESH" and not o.name.startswith("Icosphere")]
images = {}
for o in meshes:
    for m in o.data.materials:
        for n in (m.node_tree.nodes if m and m.node_tree else []):
            if n.type == "TEX_IMAGE" and n.image and n.image.name not in images:
                w, h = n.image.size
                px = np.empty(w * h * 4, dtype=np.float32)
                n.image.pixels.foreach_get(px)
                rgb = px.reshape(-1, 4)[:, :3]
                images[n.image.name] = {"size": [w, h], "black": float((rgb.max(axis=1) < 0.02).mean())}
tris = 0
for o in meshes:
    o.data.calc_loop_triangles()
    tris += len(o.data.loop_triangles)
print("CHECK " + json.dumps({
    "triangles": tris, "images": images,
    "skinned": any(any(m.type == "ARMATURE" for m in o.modifiers) or o.parent and o.parent.type == "ARMATURE" for o in meshes),
}))
