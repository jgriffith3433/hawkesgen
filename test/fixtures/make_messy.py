"""A messy "generated" character for test/character-art.test.ts, exported as GLB:

    blender -b --factory-startup -P make_messy.py -- out.glb [front.png back.png]

A lopsided humanoid blob (a heavier left arm), a floating shard, a hole in the torso and doubled vertices: what
image-to-3D models hand back. With two image paths it also writes a red front and a blue back cutout (alpha) fitted
to the figure for the projection test.
"""

import sys

import bmesh
import bpy
import numpy as np

args = sys.argv[sys.argv.index("--") + 1:]
out = args[0]
bpy.ops.wm.read_factory_settings(use_empty=True)


def add(kind, loc, scale):
    if kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, location=loc)
    else:
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, location=loc)
    o = bpy.context.active_object
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return o


parts = [
    add("cyl", (0, 0, 1.0), (0.22, 0.14, 0.45)),
    add("sphere", (0, 0, 1.62), (0.13, 0.13, 0.16)),
    add("cyl", (0.1, 0, 0.35), (0.08, 0.08, 0.35)),
    add("cyl", (-0.1, 0, 0.35), (0.08, 0.08, 0.35)),
    add("cyl", (0.4, 0, 1.15), (0.09, 0.09, 0.3)),
    add("cyl", (-0.34, 0, 1.15), (0.06, 0.06, 0.28)),
]
shard = add("sphere", (1.2, 0.6, 0.4), (0.03, 0.03, 0.03))
bpy.ops.object.select_all(action="DESELECT")
for p in parts + [shard]:
    p.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
body = bpy.context.active_object
body.name = "Body"
bm = bmesh.new()
bm.from_mesh(body.data)
front = [f for f in bm.faces if f.calc_center_median().y < -0.1 and 0.9 < f.calc_center_median().z < 1.1 and abs(f.calc_center_median().x) < 0.1]
bmesh.ops.delete(bm, geom=front[:6], context="FACES")
bm.to_mesh(body.data)
bm.free()
mat = bpy.data.materials.new("m")
body.data.materials.append(mat)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False)

if len(args) >= 3:
    # Cutouts: a silhouette of the figure from the front/back (x extent -0.45..0.5 by z 0..1.78), alpha 1 inside.
    W, H = 512, 1024
    for path, col in ((args[1], (1.0, 0.0, 0.0)), (args[2], (0.0, 0.0, 1.0))):
        px = np.zeros((H, W, 4), dtype=np.float32)
        top = int(H * 0.9)
        bottom = int(H * 0.05)
        px[bottom:top, W // 4: 3 * W // 4] = (*col, 1.0)
        img = bpy.data.images.new("v", W, H, alpha=True)
        img.pixels.foreach_set(px.reshape(-1))
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
