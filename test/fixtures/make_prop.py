"""A tiny prop for test/blender.test.ts: a long bar with a bright tip, exported as GLB.

    blender -b --factory-startup -P make_prop.py -- out.glb

1 m long on Z (the grip is near z=0.25), 6 cm square.
"""

import sys

import bpy

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
bar = bpy.context.active_object
bar.name = "bar"
bar.scale = (0.06, 0.06, 1.0)
bpy.ops.object.transform_apply(scale=True)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB")
print("made", out)
