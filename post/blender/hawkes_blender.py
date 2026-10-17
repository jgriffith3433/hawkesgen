"""Renders a shot for Hawkes Gen's blender.render tool. Runs inside Blender (5.0):

    blender -b [scene.blend] --factory-startup --python-exit-code 1 -P hawkes_blender.py -- spec.json

It opens the .blend (or starts empty), builds the shot the spec describes on top (characters, props, ground, sky,
lights, camera move), then writes each pass as a PNG sequence under spec["out"]:

    beauty/   the scene as it renders (Cycles, EEVEE or Workbench)
    depth/    inverse depth, white near and black far (what Depth Anything and MoGe make), one range for the shot
    normal/   camera-space normals (+X right, +Y up, +Z toward the camera; 0.5 grey is zero)
    mask/     the characters white on black (other objects hide them where they are in front)
    pose.json OpenPose body keypoints (18) of every rigged character, per frame, in pixels

plus info.json (frames, fps, size, the depth range, the camera, what each character resolved to). The control
videos (pose drawing, edges, mp4s) are made from these by post/pose_draw.py and ffmpeg, outside Blender.

Lines starting with "HB " are progress for Hawkes Gen; everything else is Blender's own log.
"""

import json
import math
import os
import re
import sys
import time

import bpy
import mathutils
from bpy_extras.object_utils import world_to_camera_view

try:
    import numpy as np
except ImportError:  # Blender ships numpy; this is only for linters
    np = None


def say(*a):
    print("HB", *a, flush=True)


def fail(msg):
    say("error", msg)
    sys.exit(1)


ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not ARGV:
    fail("usage: blender -b [file.blend] -P hawkes_blender.py -- spec.json")
SPEC = json.load(open(ARGV[0], encoding="utf-8"))
OUT = SPEC["out"]
FILES = SPEC.get("files") or []
SHOT = SPEC.get("shot") or None
os.makedirs(OUT, exist_ok=True)
if not SPEC.get("blend"):
    # Started without a file: Blender's startup scene has a cube, a light and a camera. Start from nothing.
    bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
info = {"blender": bpy.app.version_string, "characters": [], "warnings": []}


def warn(msg):
    info["warnings"].append(msg)
    say("warning", msg)


def file_arg(ref, what):
    """A shot's file reference: an index into the job's files."""
    if isinstance(ref, int) or (isinstance(ref, str) and ref.isdigit()):
        i = int(ref)
        if 0 <= i < len(FILES):
            return FILES[i]
    fail(f"{what}: no file {ref!r} (give the index of one of the job's files, 0 to {len(FILES) - 1})")


def color(hex_, default=(0.5, 0.5, 0.5)):
    if not hex_:
        return default
    h = str(hex_).lstrip("#")
    if len(h) != 6:
        return default
    # sRGB hex to linear
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


# ---------------------------------------------------------------- importing

def import_file(path):
    """Imports a model file; returns the new objects."""
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext in (".usd", ".usda", ".usdc", ".usdz"):
        bpy.ops.wm.usd_import(filepath=path)
    elif ext == ".blend":
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            dst.objects = list(src.objects)
        for o in dst.objects:
            if o is not None and o.type != "CAMERA":
                scene.collection.objects.link(o)
    else:
        fail(f"can't import {os.path.basename(path)} (glb, gltf, fbx, obj, usd or blend)")
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.name not in scene.collection.all_objects:
            try:
                scene.collection.objects.link(o)
            except RuntimeError:
                pass
    return new


def alive(objs):
    """The objects of a list that haven't been deleted."""
    out = []
    for o in objs:
        try:
            o.name
        except ReferenceError:
            continue
        out.append(o)
    return out


def group(objs, name):
    """Parents the top-level objects of an import to one empty, so it moves, turns and scales as one."""
    root = bpy.data.objects.new(name, None)
    scene.collection.objects.link(root)
    for o in objs:
        if o.parent is None or o.parent not in objs:
            o.parent = root
            o.matrix_parent_inverse = root.matrix_world.inverted()
    return root


def descendants(root):
    out, stack = [], list(root.children)
    while stack:
        o = stack.pop()
        out.append(o)
        stack.extend(o.children)
    return out


def bounds(objs):
    """World bounding box (min, max) of the evaluated meshes, as they are at the current frame."""
    dg = bpy.context.evaluated_depsgraph_get()
    lo = mathutils.Vector((1e9, 1e9, 1e9))
    hi = mathutils.Vector((-1e9, -1e9, -1e9))
    found = False
    for o in objs:
        if o.type != "MESH" or o.hide_render:
            continue
        ev = o.evaluated_get(dg)
        for c in ev.bound_box:
            w = ev.matrix_world @ mathutils.Vector(c)
            lo = mathutils.Vector(map(min, lo, w))
            hi = mathutils.Vector(map(max, hi, w))
            found = True
    return (lo, hi) if found else (mathutils.Vector((0, 0, 0)), mathutils.Vector((0, 0, 0)))


# ---------------------------------------------------------------- actions (Blender 4.4+ slotted actions)

def fcurves_of(action):
    """Every F-curve of an action, through its layers and slots (Blender 4.4+), or the legacy list."""
    out = []
    layers = getattr(action, "layers", None)
    if layers:
        for layer in layers:
            for strip in layer.strips:
                for slot in action.slots:
                    try:
                        cb = strip.channelbag(slot)
                    except Exception:
                        cb = None
                    if cb:
                        out.extend(cb.fcurves)
        return out
    return list(getattr(action, "fcurves", []))


def bone_key(name):
    """A bone name without its rig prefix ("mixamorig7:LeftArm" -> "leftarm")."""
    n = name.split(":")[-1]
    return "".join(ch for ch in n.lower() if ch.isalnum())


def retarget(action, arm):
    """Points an action's bone channels at this armature's bones when only the prefix differs (Mixamo rigs
    exported separately get mixamorig:, mixamorig7:, ...). Works on a copy."""
    names = {bone_key(b.name): b.name for b in arm.data.bones}
    act = action.copy()
    act.name = f"{action.name}->{arm.name}"
    hit = miss = 0
    for fc in fcurves_of(act):
        p = fc.data_path
        if not p.startswith('pose.bones["'):
            continue
        src = p[len('pose.bones["'):p.index('"]')]
        if src in arm.data.bones:
            hit += 1
            continue
        dst = names.get(bone_key(src))
        if dst:
            fc.data_path = p.replace(f'pose.bones["{src}"]', f'pose.bones["{dst}"]', 1)
            hit += 1
        else:
            miss += 1
    return act, hit, miss


def play(arm, action, start, frames, loop=True, speed=1.0):
    """Plays an action on an armature from frame `start` for `frames` frames, looping it if it's shorter."""
    ad = arm.animation_data_create()
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    ad.action = None
    a0, a1 = action.frame_range
    length = max(1.0, (a1 - a0) / max(0.05, speed))
    track = ad.nla_tracks.new()
    strip = track.strips.new(action.name, int(start), action)
    if hasattr(strip, "action_slot") and action.slots and strip.action_slot is None:
        strip.action_slot = action.slots[0]
    strip.scale = 1 / max(0.05, speed)
    if loop:
        strip.repeat = max(1.0, math.ceil(frames / length))
    strip.extrapolation = "HOLD"
    return length


# ---------------------------------------------------------------- the shot

def new_keys(kind):
    bpy.context.preferences.edit.keyframe_new_interpolation_type = kind


def add_character(i, c, start, frames, fps):
    path = file_arg(c.get("file"), f"characters[{i}]")
    objs = import_file(path)
    arms = [o for o in objs if o.type == "ARMATURE"]
    arm = arms[0] if arms else None
    # Junk shipped with some exports (a stray sphere, a light probe) would throw off the size: with a rig, keep what
    # the rig deforms or carries.
    if arm and not c.get("keepAll"):
        keep = set([arm] + descendants(arm))
        for o in objs:
            if o.type == "MESH" and o not in keep and not any(m.type == "ARMATURE" for m in o.modifiers):
                bpy.data.objects.remove(o, do_unlink=True)
        objs = alive(objs)
    for o in objs:
        if o.type in ("CAMERA", "LIGHT"):
            bpy.data.objects.remove(o, do_unlink=True)
    objs = alive(objs)
    root = group(objs, f"hb_character_{i}")
    got = {"index": i, "file": os.path.basename(path), "rig": arm.name if arm else None, "objects": len(objs)}

    action = None
    if arm:
        want = c.get("animation")
        if c.get("animationFile") is not None:
            extra = import_file(file_arg(c["animationFile"], f"characters[{i}].animationFile"))
            src = None
            for o in extra:
                if o.type == "ARMATURE" and o.animation_data and o.animation_data.action:
                    src = o.animation_data.action
            if want:
                src = bpy.data.actions.get(want) or src
            for o in extra:
                bpy.data.objects.remove(o, do_unlink=True)
            if not src:
                fail(f"characters[{i}].animationFile has no animation")
            action, hit, miss = retarget(src, arm)
            got["retargeted"] = {"bones": hit, "missing": miss}
            if not hit:
                fail(f"characters[{i}]: the animation's bones don't match the character's rig")
        elif want:
            action = bpy.data.actions.get(want)
            if not action:
                names = sorted(a.name for a in bpy.data.actions)
                fail(f"characters[{i}]: no animation {want!r}; this file has {names}")
        if action:
            got["animation"] = action.name
            got["animationFrames"] = round(play(arm, action, start, frames, c.get("loop", True), float(c.get("speed", 1))), 1)
        elif arm.animation_data:
            # No animation asked for: the rest pose, not whatever clip the importer left on.
            for t in list(arm.animation_data.nla_tracks):
                arm.animation_data.nla_tracks.remove(t)
            arm.animation_data.action = None
            for pb in arm.pose.bones:
                pb.matrix_basis = mathutils.Matrix()
        got["animations"] = sorted(a.name for a in bpy.data.actions if "->" not in a.name)[:40]

    # Size and place it: scaled to `height`, feet on the ground at `position`, turned to `facing` (degrees; 0 faces
    # the default camera, which looks along +Y).
    scene.frame_set(start)
    lo, hi = bounds(objs)
    h = hi.z - lo.z
    if c.get("height") and h > 1e-4:
        s = float(c["height"]) / h
        root.scale = (s, s, s) if not c.get("scale") else (s * c["scale"],) * 3
    elif c.get("scale"):
        root.scale = (float(c["scale"]),) * 3
    bpy.context.view_layer.update()
    scene.frame_set(start)
    lo, hi = bounds(objs)
    pos = mathutils.Vector((list(c.get("position", [0, 0, 0])) + [0, 0, 0])[:3])
    root.location += mathutils.Vector((pos.x - (lo.x + hi.x) / 2, pos.y - (lo.y + hi.y) / 2, pos.z - lo.z))
    face = math.radians(float(c.get("facing", 0)))
    # Rotate about the character's own spot.
    pivot = mathutils.Vector((pos.x, pos.y, 0))
    rot = mathutils.Matrix.Rotation(face, 4, "Z")
    root.matrix_world = mathutils.Matrix.Translation(pivot) @ rot @ mathutils.Matrix.Translation(-pivot) @ root.matrix_world
    bpy.context.view_layer.update()
    lo, hi = bounds(objs)
    got["height"] = round(hi.z - lo.z, 3)

    # Walking forward with an in-place cycle: `travel` meters per second along its facing.
    travel = float(c.get("travel", 0) or 0)
    if travel:
        fwd = rot @ mathutils.Vector((0, -1, 0))
        new_keys("LINEAR")
        root.keyframe_insert("location", frame=start)
        root.location += fwd * travel * (frames - 1) / fps
        root.keyframe_insert("location", frame=start + frames - 1)
        root.location -= fwd * travel * (frames - 1) / fps
        new_keys("BEZIER")
    info["characters"].append(got)
    say("character", json.dumps(got))
    return {"root": root, "arm": arm, "objs": objs, "rot": rot, "pos": pos, "height": got["height"]}


def add_prop(i, p, start):
    objs = import_file(file_arg(p.get("file"), f"props[{i}]"))
    for o in objs:
        if o.type in ("CAMERA", "LIGHT"):
            bpy.data.objects.remove(o, do_unlink=True)
    objs = alive(objs)
    root = group(objs, f"hb_prop_{i}")
    scene.frame_set(start)
    lo, hi = bounds(objs)
    if p.get("size") and max(hi - lo) > 1e-4:
        s = float(p["size"]) / max(hi - lo)
        root.scale = (s, s, s)
    elif p.get("scale"):
        root.scale = (float(p["scale"]),) * 3
    bpy.context.view_layer.update()
    lo, hi = bounds(objs)
    pos = mathutils.Vector((list(p.get("position", [0, 0, 0])) + [0, 0, 0])[:3])
    root.location += mathutils.Vector((pos.x - (lo.x + hi.x) / 2, pos.y - (lo.y + hi.y) / 2, pos.z - lo.z))
    root.rotation_euler.z = math.radians(float(p.get("facing", 0)))
    return objs


def add_ground(g):
    size = float(g.get("size", 60)) if isinstance(g, dict) else 60
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    plane = bpy.context.active_object
    plane.name = "hb_ground"
    mat = bpy.data.materials.new("hb_ground")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color(g.get("color") if isinstance(g, dict) else None, (0.18, 0.18, 0.18)), 1)
        bsdf.inputs["Roughness"].default_value = 0.8
    plane.data.materials.append(mat)
    return plane


def set_background(b):
    world = scene.world or bpy.data.worlds.new("hb_world")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = float(b.get("strength", 1))
    if b.get("file") is not None:
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(file_arg(b["file"], "background.file"))
        if b.get("rotation"):
            coord = nt.nodes.new("ShaderNodeTexCoord")
            mapn = nt.nodes.new("ShaderNodeMapping")
            mapn.inputs["Rotation"].default_value[2] = math.radians(float(b["rotation"]))
            nt.links.new(coord.outputs["Generated"], mapn.inputs["Vector"])
            nt.links.new(mapn.outputs["Vector"], env.inputs["Vector"])
        nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    else:
        bg.inputs["Color"].default_value = (*color(b.get("color"), (0.05, 0.05, 0.06)), 1)
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def add_lights(kind, center, size):
    if kind == "none":
        return

    def light(name, typ, energy, loc, col=(1, 1, 1), sz=None):
        d = bpy.data.lights.new(name, typ)
        d.energy = energy
        d.color = col
        if sz and typ == "AREA":
            d.size = sz
        o = bpy.data.objects.new(name, d)
        scene.collection.objects.link(o)
        o.location = center + mathutils.Vector(loc)
        con = o.constraints.new("TRACK_TO")
        tgt = bpy.data.objects.new(name + "_aim", None)
        scene.collection.objects.link(tgt)
        tgt.location = center + mathutils.Vector((0, 0, size * 0.5))
        con.target = tgt
        return o

    s = max(1.0, size)
    if kind == "sun":
        light("hb_sun", "SUN", 3.5, (2 * s, -3 * s, 5 * s), (1, 0.95, 0.88))
        light("hb_fill", "AREA", 150 * s * s, (-3 * s, -2 * s, 2 * s), (0.7, 0.8, 1), 3 * s)
    elif kind == "night":
        light("hb_moon", "SUN", 0.4, (-2 * s, 3 * s, 5 * s), (0.6, 0.7, 1))
        light("hb_key", "AREA", 120 * s * s, (2 * s, -2 * s, 2.5 * s), (1, 0.75, 0.5), 1 * s)
    else:  # studio
        light("hb_key", "AREA", 400 * s * s, (2.5 * s, -3 * s, 3 * s), (1, 0.97, 0.92), 2 * s)
        light("hb_fill", "AREA", 120 * s * s, (-3 * s, -2 * s, 1.8 * s), (0.85, 0.9, 1), 3 * s)
        light("hb_rim", "AREA", 300 * s * s, (0, 3.5 * s, 3 * s), (1, 1, 1), 1.5 * s)


def hips_bone(arm):
    for b in arm.data.bones:
        if bone_key(b.name) in ("hips", "pelvis", "hip", "root"):
            return b.name
    return arm.data.bones[0].name if arm.data.bones else None


def add_camera(cs, chars, start, frames, fps):
    """A camera with a move: static, push-in, pull-out, orbit, pan, truck, crane-up, crane-down or follow, aimed at a
    character (by index) or a point."""
    move = cs.get("move", "static")
    tgt_ref = cs.get("target", 0 if chars else [0, 0, 1])
    char = chars[tgt_ref] if isinstance(tgt_ref, int) and 0 <= tgt_ref < len(chars) else None
    if char:
        h = char["height"] or 1.7
        aim = char["pos"] + mathutils.Vector((0, 0, h * float(cs.get("aimHeight", 0.55))))
        base_rot = char["rot"]
    else:
        aim = mathutils.Vector((list(tgt_ref) + [0, 0, 0])[:3]) if isinstance(tgt_ref, (list, tuple)) else mathutils.Vector((0, 0, 1))
        h = 1.7
        base_rot = mathutils.Matrix.Identity(4)
    dist = float(cs.get("distance", max(2.5, h * 2.2)))
    height = float(cs.get("height", aim.z))
    angle = math.radians(float(cs.get("angle", 0)))

    cam_data = bpy.data.cameras.new("hb_camera")
    cam_data.lens = float(cs.get("lens", 35))
    cam_data.clip_start = 0.05
    cam_data.clip_end = 500
    cam = bpy.data.objects.new("hb_camera", cam_data)
    scene.collection.objects.link(cam)
    target = bpy.data.objects.new("hb_camera_target", None)
    scene.collection.objects.link(target)
    con = cam.constraints.new("TRACK_TO")
    con.target = target
    con.track_axis = "TRACK_NEGATIVE_Z"
    con.up_axis = "UP_Y"
    scene.camera = cam

    def place(a, d, z, offset=mathutils.Vector((0, 0, 0)), t_off=mathutils.Vector((0, 0, 0))):
        # 0 degrees is in front of the character (characters face -Y before their own turn).
        dirv = base_rot @ mathutils.Matrix.Rotation(a, 4, "Z") @ mathutils.Vector((0, -1, 0))
        cam.location = mathutils.Vector((aim.x, aim.y, 0)) + dirv * d + mathutils.Vector((0, 0, z)) + offset
        target.location = aim + t_off

    side = base_rot @ mathutils.Matrix.Rotation(angle, 4, "Z") @ mathutils.Vector((1, 0, 0))
    end = start + frames - 1
    amt = cs.get("amount")
    new_keys("BEZIER")

    def key(f):
        cam.keyframe_insert("location", frame=f)
        target.keyframe_insert("location", frame=f)

    if move == "push-in":
        place(angle, dist, height); key(start)
        place(angle, dist * (1 - float(amt if amt is not None else 0.35)), height); key(end)
    elif move == "pull-out":
        place(angle, dist, height); key(start)
        place(angle, dist * (1 + float(amt if amt is not None else 0.5)), height); key(end)
    elif move == "orbit":
        sweep = math.radians(float(amt if amt is not None else 40))
        steps = 8
        for k in range(steps + 1):
            place(angle - sweep / 2 + sweep * k / steps, dist, height)
            key(start + round((end - start) * k / steps))
    elif move == "pan":
        a = float(amt if amt is not None else dist * 0.35)
        place(angle, dist, height, t_off=-side * a); key(start)
        place(angle, dist, height, t_off=side * a); key(end)
    elif move == "truck":
        a = float(amt if amt is not None else 1.5)
        place(angle, dist, height, offset=-side * a / 2, t_off=-side * a / 2); key(start)
        place(angle, dist, height, offset=side * a / 2, t_off=side * a / 2); key(end)
    elif move in ("crane-up", "crane-down"):
        a = float(amt if amt is not None else 1.0) * (1 if move == "crane-up" else -1)
        place(angle, dist, height - a / 2); key(start)
        place(angle, dist, height + a / 2); key(end)
    elif move == "follow" and char and char["arm"]:
        # The camera rig rides along with the character's hips (ground plane only).
        place(angle, dist, height)
        rig = bpy.data.objects.new("hb_follow", None)
        scene.collection.objects.link(rig)
        rig.location = (aim.x, aim.y, 0)
        cl = rig.constraints.new("COPY_LOCATION")
        cl.target = char["arm"]
        cl.subtarget = hips_bone(char["arm"]) or ""
        cl.use_z = False
        cl.use_offset = False
        for o in (cam, target):
            o.parent = rig
            o.location -= mathutils.Vector((aim.x, aim.y, 0))
    else:
        if move not in ("static", "follow"):
            warn(f"unknown camera move {move!r}; static")
        place(angle, dist, height)

    # Handheld: a slow, smooth wobble of the aim and a little of the body, keyed every frame.
    shake = float(cs.get("handheld", 0) or 0)
    if shake > 0:
        new_keys("LINEAR")
        scene.frame_set(start)
        rnd = [hash((k, "hb")) % 1000 / 1000 * 6.28 for k in range(12)]
        for f in range(start, end + 1):
            scene.frame_set(f)
            t = (f - start) / fps
            w = lambda k, sp: math.sin(t * sp + rnd[k]) + 0.5 * math.sin(t * sp * 2.3 + rnd[k + 6])
            target.location += mathutils.Vector((w(0, 1.1), w(1, 0.9), w(2, 1.3))) * 0.012 * shake * dist
            cam.location += mathutils.Vector((w(3, 0.7), w(4, 0.8), w(5, 0.6))) * 0.005 * shake * dist
            key(f)
            target.location -= mathutils.Vector((w(0, 1.1), w(1, 0.9), w(2, 1.3))) * 0.012 * shake * dist
            cam.location -= mathutils.Vector((w(3, 0.7), w(4, 0.8), w(5, 0.6))) * 0.005 * shake * dist
        new_keys("BEZIER")
    return cam


def build_shot(shot, start, frames, fps):
    chars, char_objs = [], []
    for i, c in enumerate(shot.get("characters") or []):
        ch = add_character(i, c, start, frames, fps)
        chars.append(ch)
        char_objs += ch["objs"]
    for i, p in enumerate(shot.get("props") or []):
        add_prop(i, p, start)
    ground = shot.get("ground", not SPEC.get("blend"))
    if ground:
        add_ground(ground if isinstance(ground, dict) else {})
    if shot.get("background") is not None or not SPEC.get("blend"):
        set_background(shot.get("background") or {})
    center = chars[0]["pos"] if chars else mathutils.Vector((0, 0, 0))
    size = max([c["height"] for c in chars] + [1.7]) / 1.7
    lights = shot.get("lights", "studio" if not SPEC.get("blend") else "none")
    add_lights(lights, center, size)
    if shot.get("camera") is not None or not scene.camera:
        add_camera(shot.get("camera") or {}, chars, start, frames, fps)
    return chars, char_objs


# ---------------------------------------------------------------- render settings

def gpu_setup():
    """Cycles on the GPU when there is one (OptiX, then CUDA, then the rest)."""
    want = SPEC.get("device", "auto")
    if want == "cpu":
        scene.cycles.device = "CPU"
        return "CPU"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except KeyError:
        return "CPU"
    for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        devs = [d for d in prefs.devices if d.type == kind]
        if devs:
            for d in prefs.devices:
                d.use = d.type == kind
            scene.cycles.device = "GPU"
            return f"{kind} ({', '.join(d.name for d in devs)})"
    scene.cycles.device = "CPU"
    return "CPU"


def set_engine(kind):
    if kind == "eevee":
        for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            try:
                scene.render.engine = e
                return e
            except TypeError:
                continue
    if kind == "workbench":
        scene.render.engine = "BLENDER_WORKBENCH"
        return "BLENDER_WORKBENCH"
    scene.render.engine = "CYCLES"
    return "CYCLES"


def emission_material(name, build):
    """A material whose surface is emission only, built by build(nodes, links) -> the color socket."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = 1.0
    sock = build(nt.nodes, nt.links)
    if isinstance(sock, tuple):
        em.inputs["Color"].default_value = (*sock, 1)
    else:
        nt.links.new(sock, em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return mat


def math_node(nodes, links, op, a, b):
    n = nodes.new("ShaderNodeMath")
    n.operation = op
    for k, v in enumerate((a, b)):
        if isinstance(v, (int, float)):
            n.inputs[k].default_value = v
        else:
            links.new(v, n.inputs[k])
    return n.outputs[0]


def depth_material(near, far):
    """Inverse depth over the shot's range: 1 at `near`, 0 at `far` (and beyond)."""
    inv_n, inv_f = 1 / near, 1 / far

    def build(nodes, links):
        cam = nodes.new("ShaderNodeCameraData")
        inv = math_node(nodes, links, "DIVIDE", 1.0, cam.outputs["View Z Depth"])
        d = math_node(nodes, links, "SUBTRACT", inv, inv_f)
        v = math_node(nodes, links, "MULTIPLY", d, 1 / (inv_n - inv_f))
        clamp = nodes.new("ShaderNodeClamp")
        links.new(v, clamp.inputs["Value"])
        comb = nodes.new("ShaderNodeCombineColor")
        for k in range(3):
            links.new(clamp.outputs["Result"], comb.inputs[k])
        return comb.outputs["Color"]

    return emission_material("hb_depth", build)


def normal_material():
    def build(nodes, links):
        geo = nodes.new("ShaderNodeNewGeometry")
        vt = nodes.new("ShaderNodeVectorTransform")
        vt.vector_type = "NORMAL"
        vt.convert_from = "WORLD"
        vt.convert_to = "CAMERA"
        links.new(geo.outputs["Normal"], vt.inputs["Vector"])
        # Blender's camera space looks down -Z; flip Z so faces toward the camera are blue.
        flip = nodes.new("ShaderNodeVectorMath")
        flip.operation = "MULTIPLY"
        flip.inputs[1].default_value = (0.5, 0.5, -0.5)
        links.new(vt.outputs["Vector"], flip.inputs[0])
        add = nodes.new("ShaderNodeVectorMath")
        add.operation = "ADD"
        add.inputs[1].default_value = (0.5, 0.5, 0.5)
        links.new(flip.outputs["Vector"], add.inputs[0])
        return add.outputs["Vector"]

    return emission_material("hb_normal", build)


def black_world():
    w = bpy.data.worlds.new("hb_black")
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0, 0, 0, 1)
        bg.inputs["Strength"].default_value = 0
    return w


def near_far(start, frames):
    """The depth range of what the camera sees over the shot (sampled frames, robust percentiles)."""
    cam = scene.camera
    pts = []
    tanx = tany = 1.0
    if cam.data.type == "PERSP":
        fov = cam.data.angle
        aspect = scene.render.resolution_x / scene.render.resolution_y
        if aspect >= 1:
            tanx = math.tan(fov / 2) * 1.05
            tany = tanx / aspect
        else:
            tany = math.tan(fov / 2) * 1.05
            tanx = tany * aspect
    step = max(1, frames // 10)
    for f in range(start, start + frames, step):
        scene.frame_set(f)
        dg = bpy.context.evaluated_depsgraph_get()
        inv = cam.matrix_world.inverted()
        for o in scene.objects:
            if o.type != "MESH" or o.hide_render or not o.visible_get():
                continue
            ev = o.evaluated_get(dg)
            me = ev.to_mesh()
            n = len(me.vertices)
            if n:
                co = np.empty(n * 3, dtype=np.float32)
                me.vertices.foreach_get("co", co)
                co = co.reshape(-1, 3)
                if n > 40000:
                    co = co[:: n // 40000 + 1]
                m = np.array(inv @ ev.matrix_world, dtype=np.float32)
                cs = co @ m[:3, :3].T + m[:3, 3]
                z = -cs[:, 2]
                ok = (z > cam.data.clip_start) & (np.abs(cs[:, 0]) < z * tanx) & (np.abs(cs[:, 1]) < z * tany)
                pts.append(z[ok])
            ev.to_mesh_clear()
    z = np.concatenate(pts) if pts else np.array([])
    if z.size < 10:
        return 0.5, 50.0
    near = max(cam.data.clip_start, float(np.percentile(z, 0.5)) * 0.9)
    far = max(near * 1.5, float(np.percentile(z, 99.5)) * 1.1)
    return near, far


# ---------------------------------------------------------------- pose (OpenPose body 18)

# OpenPose order: nose, neck, r shoulder, r elbow, r wrist, l shoulder, l elbow, l wrist, r hip, r knee, r ankle,
# l hip, l knee, l ankle, r eye, l eye, r ear, l ear.
# Bone name words that say nothing about the joint: rig prefixes (Biped's Bip01, Rigify's DEF/ORG/MCH, Mixamo's
# mixamorig) and Biped's per-skin suffix (S0).
_NOISE = {"bip01", "bip001", "bip", "def", "org", "mch", "mixamorig", "rig", "jnt", "joint", "bn", "bone", "b", "s0", "s1"}
_SLOTS = [  # (words joined, slot); first match wins, so the specific names come first
    (("forearm", "lowerarm", "elbow", "armlower", "arm2"), "elbow"),
    (("upperarm", "armupper", "uparm", "arm", "arm1"), "shoulder"),
    (("hand", "wrist"), "wrist"),
    (("thigh", "upleg", "upperleg", "legupper", "leg1"), "hip"),
    (("calf", "shin", "lowerleg", "leglower", "knee", "leg", "leg2"), "knee"),
    (("foot", "ankle"), "ankle"),
    (("eye",), "eye"),
]


def bone_words(name):
    """A bone's name as lowercase words, without rig prefixes: "Bip01_L_UpperArmS0" -> ["l", "upperarm"],
    "mixamorig7:LeftForeArm" -> ["left", "forearm"], "upper_arm.L" -> ["upper", "arm", "l"]."""
    n = name.split(":")[-1]
    n = re.sub(r"S\d+$", "", n)  # Biped skin suffix
    n = re.sub(r"(?<=[a-z0-9])(?=[A-Z][a-z])", "_", n)  # CamelCase
    words = [w.lower() for w in re.split(r"[^A-Za-z0-9]+", n) if w]
    return [w for w in words if w not in _NOISE and not re.fullmatch(r"bip0*\d+", w)]


def find_bones(arm):
    """Maps the rig's bones to the joints OpenPose draws, by name: Mixamo, 3ds Max Biped, Rigify, Unreal and most
    hand-made rigs (left/right as a word, a prefix or a .L/_R suffix)."""
    found = {}
    for b in arm.data.bones:
        words = bone_words(b.name)
        side = None
        rest = []
        for w in words:
            if w in ("l", "left") and side is None:
                side = "l"
            elif w in ("r", "right") and side is None:
                side = "r"
            elif w.startswith("left") and side is None:
                side, w = "l", w[4:]
                rest.append(w)
            elif w.startswith("right") and side is None:
                side, w = "r", w[5:]
                rest.append(w)
            else:
                rest.append(w)
        part = "".join(x for x in rest if x)
        if side:
            # finger chains, twist and helper bones aren't body joints
            if any(x in part for x in ("thumb", "index", "middle", "ring", "pinky", "finger", "twist", "toe", "clavicle", "shoulder", "roll", "ik", "pole", "end", "nub")):
                continue
            for names, slot in _SLOTS:
                if part in names:
                    found.setdefault(f"{side}_{slot}", b.name)
                    break
        else:
            if part in ("head",):
                found.setdefault("head", b.name)
            elif part in ("headtopend", "headtop", "headend", "headtip", "headnub"):
                found.setdefault("headtop", b.name)
            elif part in ("neck", "neck1", "neck01"):
                found.setdefault("neck", b.name)
    return found


def keypoints(arm, bones, cam, w, h):
    """The 18 OpenPose keypoints [x, y, confidence] in pixels for the current frame (0 confidence when missing or
    off screen)."""
    M = arm.matrix_world
    pb = arm.pose.bones

    def J(name, tail=False):
        b = pb.get(bones.get(name, "")) if bones.get(name) else None
        if not b:
            return None
        return M @ (b.tail if tail else b.head)

    pts = {s: J(s) for s in ("r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow", "l_wrist",
                             "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle", "r_eye", "l_eye")}
    head = J("head")
    top = J("headtop") or (J("head", tail=True) if head else None)
    neck = (pts["r_shoulder"] + pts["l_shoulder"]) / 2 if pts["r_shoulder"] and pts["l_shoulder"] else J("neck")
    face = {}
    if head and top and pts["l_shoulder"] and pts["r_shoulder"]:
        up = top - head
        hh = up.length
        up.normalize()
        across = pts["l_shoulder"] - pts["r_shoulder"]
        fwd = across.cross(up).normalized()
        side = up.cross(fwd).normalized()  # toward the character's left
        face["nose"] = head + up * 0.40 * hh + fwd * 0.55 * hh
        face["r_eye"] = pts["r_eye"] or head + up * 0.55 * hh + fwd * 0.45 * hh - side * 0.18 * hh
        face["l_eye"] = pts["l_eye"] or head + up * 0.55 * hh + fwd * 0.45 * hh + side * 0.18 * hh
        face["r_ear"] = head + up * 0.45 * hh - side * 0.45 * hh
        face["l_ear"] = head + up * 0.45 * hh + side * 0.45 * hh
    order = [face.get("nose"), neck, pts["r_shoulder"], pts["r_elbow"], pts["r_wrist"], pts["l_shoulder"],
             pts["l_elbow"], pts["l_wrist"], pts["r_hip"], pts["r_knee"], pts["r_ankle"], pts["l_hip"],
             pts["l_knee"], pts["l_ankle"], face.get("r_eye"), face.get("l_eye"), face.get("r_ear"), face.get("l_ear")]
    out = []
    for p in order:
        if p is None:
            out.append([0, 0, 0])
            continue
        v = world_to_camera_view(scene, cam, p)
        x, y = v.x * w, (1 - v.y) * h
        ok = v.z > 0 and -0.02 <= v.x <= 1.02 and -0.02 <= v.y <= 1.02
        out.append([round(x, 1), round(y, 1), 1 if ok else 0])
    return out


# ---------------------------------------------------------------- main

def main():
    t0 = time.time()
    fps = int(SPEC.get("fps", 24))
    scene.render.fps = fps
    scene.render.fps_base = 1
    start = int(SPEC["start"]) if SPEC.get("start") is not None else (scene.frame_start if SPEC.get("blend") else 1)
    frames = int(SPEC.get("frames") or 0) or (scene.frame_end - scene.frame_start + 1 if SPEC.get("blend") else fps * 5 + 1)
    scene.frame_start = start
    scene.frame_end = start + frames - 1
    w, h = int(SPEC.get("width", 1280)), int(SPEC.get("height", 704))
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.render.resolution_percentage = 100

    chars, char_objs = [], []
    if SHOT:
        chars, char_objs = build_shot(SHOT, start, frames, fps)
    if SPEC.get("camera"):
        cam = bpy.data.objects.get(SPEC["camera"])
        if not cam or cam.type != "CAMERA":
            fail(f"no camera {SPEC['camera']!r}; cameras here: {[o.name for o in bpy.data.objects if o.type == 'CAMERA']}")
        scene.camera = cam
    if not scene.camera:
        fail("the scene has no camera (add one, name one with camera, or give the shot a camera)")
    cam = scene.camera
    # Characters for the mask and the pose: the shot's, or every rig in the file.
    rigs = [c["arm"] for c in chars if c["arm"]]
    if not chars:
        rigs = [o for o in scene.objects if o.type == "ARMATURE" and not o.hide_render]
        for r in rigs:
            char_objs += [r] + descendants(r)
            for o in scene.objects:
                if o.type == "MESH" and any(m.type == "ARMATURE" and m.object == r for m in o.modifiers):
                    char_objs.append(o)

    passes = SPEC.get("passes") or ["beauty", "depth", "pose"]
    device = gpu_setup()
    info.update({"frames": frames, "start": start, "fps": fps, "width": w, "height": h, "camera": cam.name,
                 "device": device, "passes": passes})
    say("shot", json.dumps({"frames": frames, "start": start, "fps": fps, "size": [w, h], "camera": cam.name, "device": device}))
    if SPEC.get("save"):
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "shot.blend"), copy=True)

    near, far = SPEC.get("near"), SPEC.get("far")
    if "depth" in passes and not (near and far):
        n2, f2 = near_far(start, frames)
        near, far = near or n2, far or f2
    info["near"], info["far"] = near, far
    total = frames * len([p for p in passes if p in ("beauty", "depth", "normal", "mask")])
    done = [0]

    def on_frame(*_):
        done[0] += 1
        say("frame", done[0], total)

    bpy.app.handlers.render_post.append(on_frame)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.use_compositing = False
    scene.render.use_sequencer = False

    def render(name):
        scene.render.filepath = os.path.join(OUT, name, "#####")
        t = time.time()
        say("pass", name)
        bpy.ops.render.render(animation=True, write_still=False)
        info.setdefault("seconds", {})[name] = round(time.time() - t, 1)

    world0 = scene.world
    view0, look0 = scene.view_settings.view_transform, scene.view_settings.look

    if "beauty" in passes:
        info["engine"] = set_engine(SPEC.get("engine", "cycles"))
        if scene.render.engine == "CYCLES":
            scene.cycles.samples = int(SPEC.get("samples", 32))
            scene.cycles.use_denoising = True
            if not SPEC.get("blend") or SHOT:
                scene.view_settings.view_transform = "AgX"
        render("beauty")

    # The data passes: Cycles, emission only, a couple of samples, no bounces, no color management.
    if any(p in passes for p in ("depth", "normal", "mask")):
        set_engine("cycles")
        gpu_setup()
        scene.cycles.samples = 4
        scene.cycles.use_denoising = False
        scene.cycles.use_adaptive_sampling = False
        scene.cycles.max_bounces = 0
        scene.view_settings.view_transform = "Raw" if "Raw" in [i.identifier for i in scene.view_settings.bl_rna.properties["view_transform"].enum_items] else "Standard"
        scene.view_settings.look = "None"
        scene.world = black_world()
        vl = bpy.context.view_layer
        if "depth" in passes:
            vl.material_override = depth_material(near, far)
            render("depth")
        if "normal" in passes:
            vl.material_override = normal_material()
            render("normal")
        if "mask" in passes:
            vl.material_override = emission_material("hb_white", lambda n, l: (1.0, 1.0, 1.0))
            keep = set(char_objs)
            held = []
            for o in scene.objects:
                if o.type == "MESH" and o not in keep and not o.is_holdout:
                    o.is_holdout = True
                    held.append(o)
            scene.render.film_transparent = True
            scene.render.image_settings.color_mode = "RGBA"
            render("mask")
            for o in held:
                o.is_holdout = False
            scene.render.film_transparent = False
            scene.render.image_settings.color_mode = "RGB"
        vl.material_override = None
        scene.world = world0
        scene.view_settings.view_transform, scene.view_settings.look = view0, look0

    if "pose" in passes:
        say("pass", "pose")
        if not rigs:
            warn("no rigged character in the shot, so the pose video is blank")
        maps = [find_bones(r) for r in rigs]
        for r, m in zip(rigs, maps):
            missing = [k for k in ("head", "r_shoulder", "l_shoulder", "r_hip", "l_hip", "r_elbow", "l_elbow", "r_knee", "l_knee") if k not in m]
            if missing:
                warn(f"{r.name}: no bone found for {missing}")
        pose = {"width": w, "height": h, "frames": []}
        for f in range(start, start + frames):
            scene.frame_set(f)
            pose["frames"].append([keypoints(r, m, cam, w, h) for r, m in zip(rigs, maps)])
        info["poseBones"] = maps
        json.dump(pose, open(os.path.join(OUT, "pose.json"), "w"))

    info["seconds_total"] = round(time.time() - t0, 1)
    json.dump(info, open(os.path.join(OUT, "info.json"), "w"), indent=1)
    say("done", round(time.time() - t0, 1))


main()
