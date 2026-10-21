"""Reads a shot.blend made by hawkes_blender.py (spec "save": true) and prints what a film shot test checks, as one line:

    blender -b shot.blend --factory-startup -P check_film.py

RESULT {"held": [...], "mover": [...], "energy": [...], "ground": {...}, "dof": ...}
"""

import json

import bpy

scene = bpy.context.scene
res = {}

arm = bpy.data.objects["rig"]
palm = arm.pose.bones["rig:RightHand"]
orient = bpy.data.objects["hb_orient_0_0"]
bar = next(o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("bar"))
mover = bpy.data.objects["hb_mover_0"]
flash = bpy.data.lights["hb_vfx_0_muzzle-flash"]
res["held"], res["inside"], res["mover"], res["energy"] = [], [], [], []
for f in (1, 7, 13, 19, 25):
    scene.frame_set(f)
    mid = arm.matrix_world @ ((palm.head + palm.tail) / 2)
    res["held"].append(round((orient.matrix_world.translation - mid).length, 4))
    # The palm is inside the prop's box (the grip is on the hand).
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for c in bar.bound_box:
        w = bar.matrix_world @ __import__("mathutils").Vector(c)
        for k in range(3):
            lo[k], hi[k] = min(lo[k], w[k]), max(hi[k], w[k])
    res["inside"].append(all(lo[k] - 0.02 <= mid[k] <= hi[k] + 0.02 for k in range(3)))
    res["mover"].append([f, round(mover.matrix_world.translation.x, 3), round(mover.matrix_world.translation.y, 3)])
    res["energy"].append([f, round(flash.energy, 1)])
ground = bpy.data.objects["hb_ground"]
mat = ground.data.materials[0]
kinds = sorted(n.bl_idname for n in mat.node_tree.nodes)
res["ground"] = {
    "images": kinds.count("ShaderNodeTexImage"), "normalMap": "ShaderNodeNormalMap" in kinds,
    "colorspaces": sorted(n.image.colorspace_settings.name for n in mat.node_tree.nodes if n.bl_idname == "ShaderNodeTexImage"),
    "uvMax": round(max(l.uv[0] for l in ground.data.uv_layers[0].data), 2),
}
res["wall"] = bpy.data.objects["hb_wall_0"].data.materials[0].name
cam = scene.camera
res["dof"] = [cam.data.dof.use_dof, round(cam.data.dof.aperture_fstop, 1)]
res["beam"] = "hb_vfx_1_flashlight_beam" in bpy.data.objects
print("RESULT " + json.dumps(res))
