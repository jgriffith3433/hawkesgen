"""Renders a shot for Hawkes Gen's blender.render tool. Runs inside Blender (5.0):

    blender -b [scene.blend] --factory-startup --python-exit-code 1 -P hawkes_blender.py -- spec.json

It opens the .blend (or starts empty), builds the shot the spec describes on top (characters, props, ground, sky,
lights, camera move), then writes each pass as a PNG sequence under spec["out"]:

    beauty/   the scene as it renders (Cycles, EEVEE or Workbench)
    depth/    inverse depth, white near and black far (what Depth Anything and MoGe make), one range for the shot
    normal/   camera-space normals (+X right, +Y up, +Z toward the camera; 0.5 grey is zero)
    mask/     the characters white on black (other objects hide them where they are in front)
    layer0/.. each character alone, white on black (other characters and objects hold it out), for layered compositing
    stills/   frames of the shot as PNGs (spec "stills": fractions of the shot), for contact sheets and turntables
    pose.json OpenPose body keypoints (18) of every rigged character, per frame, in pixels

plus info.json (frames, fps, size, the depth range, the camera, what each character resolved to). The control
videos (pose drawing, edges, mp4s) are made from these by post/pose_draw.py and ffmpeg, outside Blender.

Lines starting with "HB " are progress for Hawkes Gen; everything else is Blender's own log.
"""

import json
import math
import os
import re
import shutil
import sys
import time

import bpy
import mathutils
from mathutils.bvhtree import BVHTree
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


def set_interp(owner, path, kind):
    """Sets the interpolation of every key on a property's curves (the new-key preference above isn't honored by
    keyframe_insert in Blender 5.0, so a "linear" move would still ease)."""
    ad = getattr(owner, "animation_data", None)
    if not ad or not ad.action:
        return
    for fc in fcurves_of(ad.action):
        if fc.data_path == path:
            for kp in fc.keyframe_points:
                kp.interpolation = kind


def get_action(i, arm, want, anim_file, got):
    """The action a character plays: one of the file's by name, or another file's retargeted onto this rig."""
    if anim_file is not None:
        extra = import_file(file_arg(anim_file, f"characters[{i}].animationFile"))
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
        return action
    if want:
        action = bpy.data.actions.get(want)
        if not action:
            names = sorted(a.name for a in bpy.data.actions)
            fail(f"characters[{i}]: no animation {want!r}; this file has {names}")
        return action
    return None


def use_action(ad, action):
    """Makes an action the animation data's active one (and picks its slot, Blender 4.4+)."""
    ad.action = action
    if action is not None and hasattr(ad, "action_slot") and action.slots and ad.action_slot is None:
        ad.action_slot = action.slots[0]


def stance_speed(arm, action):
    """How fast the planted foot slides back past the hips in a clip, in meters per action frame (world units, as the
    rig is now), or None when the clip doesn't step. Matching it to the ground speed is what stops foot sliding."""
    bones = find_bones(arm)
    hips = hips_bone(arm)
    la, ra = bones.get("l_ankle"), bones.get("r_ankle")
    if not (hips and la and ra):
        return None
    ad = arm.animation_data_create()
    saved = (ad.action, [t.mute for t in ad.nla_tracks])
    for t in ad.nla_tracks:
        t.mute = True
    use_action(ad, action)
    a0, a1 = action.frame_range
    rows = []
    try:
        for f in range(int(a0), int(a1) + 1):
            scene.frame_set(f)
            M = arm.matrix_world
            pb = arm.pose.bones
            rows.append((M @ pb[hips].head, M @ pb[la].head, M @ pb[ra].head))
    finally:
        use_action(ad, saved[0])
        for t, m in zip(ad.nla_tracks, saved[1]):
            t.mute = m
    if len(rows) < 4:
        return None
    speeds = []
    for k in (1, 2):
        z = [r[k].z for r in rows]
        lo, hi = min(z), max(z)
        if hi - lo < 0.02:
            continue
        limit = lo + 0.25 * (hi - lo)
        for f in range(len(rows) - 1):
            if z[f] <= limit and z[f + 1] <= limit:
                a = rows[f][k] - rows[f][0]
                b = rows[f + 1][k] - rows[f + 1][0]
                speeds.append(math.hypot(b.x - a.x, b.y - a.y))
    if not speeds:
        return None
    speeds.sort()
    v = speeds[len(speeds) // 2]
    return v if v > 1e-5 else None


def build_timeline(arm, segs, actions, stance, scale, start, frames, fps, info_c):
    """Plays a character's resolved timeline: one NLA strip per segment, alternating between two tracks so neighbours
    overlap and blend. A moving segment's clip is sped up or slowed down until its stance foot keeps pace with the
    ground (stance speed x scale x fps x playback = the segment's m/s), so the feet don't slide."""
    ad = arm.animation_data_create()
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    ad.action = None
    tracks = [ad.nla_tracks.new(), ad.nla_tracks.new()]
    n = len(segs)
    bounds_f = [(start + int(round(g["t0"] * fps)), start + int(round(g["t1"] * fps))) for g in segs]
    bounds_f[-1] = (bounds_f[-1][0], max(bounds_f[-1][1], start + frames - 1))
    report = []
    for k, g in enumerate(segs):
        action = actions[k]
        f0, f1 = bounds_f[k]
        if action is None or f1 <= f0:
            continue
        nat = max(1.0, action.frame_range[1] - action.frame_range[0])
        speed = g.get("speed")
        note = None
        if speed is None:
            speed = 1.0
            if g.get("ground", 0) > 1e-4:
                sp = stance[k]
                if sp:
                    want = g["ground"] / (sp * scale * fps)
                    speed = min(2.5, max(0.35, want))
                    if speed != want:
                        note = f"clamped: the {action.name} stride wants {want:.2f}x"
                else:
                    note = f"{action.name} has no measurable stride, played at 1x"
        speed = max(0.05, float(speed))
        length = nat / speed
        blend = 0
        if k > 0:
            blend = int(max(0, min(4, (f1 - f0) // 2, (bounds_f[k - 1][1] - bounds_f[k - 1][0]) // 2)))
        span = (f1 - f0) + (blend if k < n - 1 else 0)
        track = tracks[k % 2]
        strip = None
        for tr in (track, tracks[(k + 1) % 2]):
            try:
                strip = tr.strips.new(f"{action.name}_{k}", int(f0), action)
            except RuntimeError:
                strip = None
            if strip:
                break
        if not strip:
            note = (note or "") + " no room for the strip"
            continue
        if hasattr(strip, "action_slot") and action.slots and strip.action_slot is None:
            strip.action_slot = action.slots[0]
        strip.scale = 1.0 / speed
        strip.repeat = max(0.01, span / length) if g.get("loop", True) else 1.0
        strip.extrapolation = "HOLD" if k == 0 else "HOLD_FORWARD"
        if blend:
            strip.blend_in = blend
        stance_ms = (stance[k] or 0) * scale * fps * speed
        rep = {"animation": action.name, "from": round(f0 - start), "to": round(f1 - start), "ground": round(g.get("ground", 0), 3), "playback": round(speed, 3)}
        if g.get("ground", 0) > 1e-4 and stance[k]:
            rep["footSpeed"] = round(stance_ms, 3)
            rep["slide"] = round(stance_ms / g["ground"], 3)
        if note:
            rep["note"] = note
            warn(f"characters[{info_c['index']}] {note}")
        report.append(rep)
    info_c["segments"] = report


def key_mover(mover, segs, start, fps, frames):
    """Moves and turns the mover empty along the timeline: linear travel, eased turns."""
    new_keys("LINEAR")
    last = start + frames - 1
    for k, g in enumerate(segs):
        f0 = start + int(round(g["t0"] * fps))
        f1 = start + int(round(g["t1"] * fps))
        if k == len(segs) - 1:
            f1 = max(f1, last)
        mover.location = (g["from"][0], g["from"][1], 0)
        mover.keyframe_insert("location", frame=f0)
        mover.location = (g["to"][0], g["to"][1], 0)
        mover.keyframe_insert("location", frame=f1)
    set_interp(mover, "location", "LINEAR")
    new_keys("BEZIER")
    for k, g in enumerate(segs):
        f0 = start + int(round(g["t0"] * fps))
        mover.rotation_euler.z = math.radians(g["faceFrom"])
        mover.keyframe_insert("rotation_euler", index=2, frame=f0)
        turn = max(1, int(round(g.get("turn", 0) * fps))) if abs(g["faceTo"] - g["faceFrom"]) > 1e-6 else 0
        if turn:
            mover.rotation_euler.z = math.radians(g["faceTo"])
            mover.keyframe_insert("rotation_euler", index=2, frame=f0 + turn)


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

    # The beats' resolved timeline (the tool plans it: where the character is, which way it faces, which clip, when).
    segs = c.get("timeline") or None
    seg_actions, seg_stance = [], []
    action = None
    raw_stance = None
    if arm:
        if segs:
            cache = {}
            moving = {(g.get("animation"), g.get("animationFile")) for g in segs if g.get("ground", 0) > 1e-4 and g.get("speed") is None}
            for g in segs:
                key = (g.get("animation"), g.get("animationFile"))
                if key not in cache:
                    a = get_action(i, arm, g.get("animation"), g.get("animationFile"), got)
                    cache[key] = (a, stance_speed(arm, a) if (a and key in moving) else None)
                seg_actions.append(cache[key][0])
                seg_stance.append(cache[key][1])
            action = next((a for a in seg_actions if a), None)
            if action:
                got["animation"] = action.name
                play(arm, action, start, frames, True, 1.0)
        else:
            action = get_action(i, arm, c.get("animation"), c.get("animationFile"), got)
            if action:
                got["animation"] = action.name
                if float(c.get("travel", 0) or 0) > 1e-4 and c.get("speed") is None:
                    raw_stance = stance_speed(arm, action)
                got["animationFrames"] = round(play(arm, action, start, frames, c.get("loop", True), float(c.get("speed", 1))), 1)
        if not action and arm.animation_data:
            # No animation asked for: the rest pose, not whatever clip the importer left on.
            for t in list(arm.animation_data.nla_tracks):
                arm.animation_data.nla_tracks.remove(t)
            arm.animation_data.action = None
            for pb in arm.pose.bones:
                pb.matrix_basis = mathutils.Matrix()
        got["animations"] = sorted(a.name for a in bpy.data.actions if "->" not in a.name and not a.name.startswith("hb_"))[:40]

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
    # matrix_world is stale until the scene updates; without this the turn below throws the move away.
    bpy.context.view_layer.update()
    face = math.radians(float(c.get("facing", 0)))
    # Rotate about the character's own spot.
    pivot = mathutils.Vector((pos.x, pos.y, 0))
    rot = mathutils.Matrix.Rotation(face, 4, "Z")
    root.matrix_world = mathutils.Matrix.Translation(pivot) @ rot @ mathutils.Matrix.Translation(-pivot) @ root.matrix_world
    bpy.context.view_layer.update()
    lo, hi = bounds(objs)
    got["height"] = round(hi.z - lo.z, 3)

    mover = None
    if segs:
        # The mover empty carries the character along its path: parent it so the character stays where it is now.
        mover = bpy.data.objects.new(f"hb_mover_{i}", None)
        scene.collection.objects.link(mover)
        mover.location = (pos.x, pos.y, 0)
        mover.rotation_euler = (0, 0, face)
        bpy.context.view_layer.update()
        root.parent = mover
        root.matrix_parent_inverse = mover.matrix_world.inverted()
        key_mover(mover, segs, start, fps, frames)
        if arm and any(seg_actions):
            build_timeline(arm, segs, seg_actions, seg_stance, root.scale.x, start, frames, fps, got)
        got["timeline"] = len(segs)
    else:
        # Walking forward with an in-place cycle: `travel` meters per second along its facing.
        travel = float(c.get("travel", 0) or 0)
        if travel:
            if arm and action and c.get("speed") is None:
                if raw_stance:
                    want = travel / (raw_stance * root.scale.x * fps)
                    spd = min(2.5, max(0.35, want))
                    got["animationFrames"] = round(play(arm, action, start, frames, c.get("loop", True), spd), 1)
                    stance_ms = raw_stance * root.scale.x * fps * spd
                    rep = {"animation": action.name, "from": 0, "to": frames - 1, "ground": round(travel, 3), "playback": round(spd, 3), "footSpeed": round(stance_ms, 3), "slide": round(stance_ms / travel, 3)}
                    if spd != want:
                        rep["note"] = f"clamped: the {action.name} stride wants {want:.2f}x"
                        warn(f"characters[{i}] {rep['note']}")
                    got["segments"] = [rep]
                else:
                    note = f"{action.name} has no measurable stride, played at 1x"
                    got["segments"] = [{"animation": action.name, "from": 0, "to": frames - 1, "ground": round(travel, 3), "playback": 1.0, "note": note}]
                    warn(f"characters[{i}] {note}")
            fwd = rot @ mathutils.Vector((0, -1, 0))
            new_keys("LINEAR")
            root.keyframe_insert("location", frame=start)
            root.location += fwd * travel * (frames - 1) / fps
            root.keyframe_insert("location", frame=start + frames - 1)
            root.location -= fwd * travel * (frames - 1) / fps
            set_interp(root, "location", "LINEAR")
            new_keys("BEZIER")
    info["characters"].append(got)
    say("character", json.dumps(got))
    body_meshes = [o for o in objs if o.type == "MESH" and not o.hide_render]
    return {"root": root, "mover": mover, "arm": arm, "objs": objs, "body_meshes": body_meshes, "segs": segs, "spec": c, "attached": [], "rot": rot, "pos": pos, "height": got["height"], "index": i}


SHOT_START = [1]
PROPS = []  # {"root", "objs", "orient"} per props[] entry, so attachments and effects can find them


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
    state = {"root": root, "objs": objs, "orient": None}
    PROPS.append(state)
    return state


# Words people use for a bone -> the joint find_bones() knows it by.
BONE_SLOTS = {
    "right hand": "r_wrist", "left hand": "l_wrist", "right wrist": "r_wrist", "left wrist": "l_wrist",
    "right foot": "r_ankle", "left foot": "l_ankle", "right ankle": "r_ankle", "left ankle": "l_ankle",
    "right elbow": "r_elbow", "left elbow": "l_elbow", "right knee": "r_knee", "left knee": "l_knee",
    "right shoulder": "r_shoulder", "left shoulder": "l_shoulder", "right hip": "r_hip", "left hip": "l_hip",
    "head": "head", "neck": "neck",
}
# Where along the bone (head 0 to tail 1) an attachment sits unless it says: the palm, the top of the head.
HEAD_TAIL = {"r_wrist": 0.5, "l_wrist": 0.5, "head": 1.0}


def resolve_bone(arm, ref):
    """A rig's bone for a name: its own exact name, then plain words ("right hand", "head", "hips", "spine")."""
    ref = str(ref or "right hand")
    names = [b.name for b in arm.data.bones]
    if ref in names:
        return ref, None
    low = {n.lower(): n for n in names}
    if ref.lower() in low:
        return low[ref.lower()], None
    key = " ".join(re.findall(r"[a-z]+", ref.lower().replace("_", " ").replace(".", " ")))
    key = key.replace("l hand", "left hand").replace("r hand", "right hand")
    slots = find_bones(arm)
    slot = BONE_SLOTS.get(key)
    if slot and slot in slots:
        return slots[slot], slot
    if key in ("hips", "hip", "pelvis", "root"):
        return hips_bone(arm), None
    if key in ("spine", "chest", "torso", "back"):
        spine = [b.name for b in arm.data.bones if any(w.startswith(("spine", "chest")) for w in bone_words(b.name))]
        if spine:
            return spine[-1] if key in ("chest", "back") else spine[0], None
    bk = bone_key(ref)
    for n in names:
        if bone_key(n) == bk:
            return n, None
    fail(f"no bone for {ref!r} on {arm.name}; its bones: {names[:60]}")


def bone_holder(arm, bone, name, head_tail=0.0):
    """An empty that rides a bone: its location and turn (not its size). Things parented to it follow the bone."""
    holder = bpy.data.objects.new(name, None)
    scene.collection.objects.link(holder)
    cl = holder.constraints.new("COPY_LOCATION")
    cl.target, cl.subtarget, cl.head_tail = arm, bone, head_tail
    cr = holder.constraints.new("COPY_ROTATION")
    cr.target, cr.subtarget = arm, bone
    cr.target_space = cr.owner_space = "WORLD"
    return holder


def grip_point(state, grip):
    """The prop's grip as a point in its own box (a share of its size per axis), with the prop at the origin."""
    root = state["root"]
    root.location = (0, 0, 0)
    root.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    lo, hi = bounds(state["objs"])
    return mathutils.Vector(lo[k] + (hi[k] - lo[k]) * float(grip[k]) for k in range(3))


def find_hand_fingers(arm, hand_bone_name, slot=None):
    """Finds {finger: [bone1, bone2, bone3]} for Thumb, Index, Middle, Ring, Pinky on the given hand."""
    hb = arm.data.bones.get(hand_bone_name) if arm else None
    if not hb:
        return {}
    desc = []
    stack = list(hb.children)
    while stack:
        b = stack.pop(0)
        desc.append(b)
        stack.extend(b.children)
    if not desc:
        side = "l" if (slot == "l_wrist" or "left" in bone_key(hand_bone_name)) else "r"
        for b in arm.data.bones:
            w = bone_words(b.name)
            if side in w or any(x.startswith("left" if side == "l" else "right") for x in w):
                desc.append(b)
    groups = {f: [] for f in ("Thumb", "Index", "Middle", "Ring", "Pinky")}
    for b in desc:
        bk = bone_key(b.name)
        if any(bk.endswith(s) for s in ("4", "04", "end", "tip", "nub")):
            continue
        for f, match in (("Thumb", "thumb"), ("Index", "index"), ("Middle", "middle"), ("Ring", "ring"), ("Pinky", "pinky"), ("Pinky", "little")):
            if match in bk:
                groups[f].append(b)
                break
    out = {}
    for f, blist in groups.items():
        if not blist:
            continue

        def depth(b):
            d, cur = 0, b.parent
            while cur:
                d += 1
                cur = cur.parent
            return d

        blist.sort(key=lambda b: (depth(b), b.name))
        out[f] = [b.name for b in blist[:3]]
    return out


def palm_surface_offset(arm, hand_bone_name, fingers):
    """Computes the palm-surface offset in the hand bone's local frame (and palm normal in armature space) using
    the Thumb1 direction relative to the hand bone axis so the prop sits on the palm surface."""
    hb = arm.data.bones.get(hand_bone_name) if arm else None
    if not hb:
        return mathutils.Vector((0, 0, 0)), None
    h_vec = hb.tail_local - hb.head_local
    h_len = max(0.05, h_vec.length)
    h_axis = h_vec.normalized() if h_vec.length > 1e-6 else mathutils.Vector((0, 1, 0))
    thumb1 = (fingers.get("Thumb") or [None])[0]
    palm_dir = None
    if thumb1 and thumb1 in arm.data.bones:
        tb = arm.data.bones[thumb1]
        t_vec = tb.tail_local - hb.head_local
        t_perp = t_vec - h_axis * t_vec.dot(h_axis)
        idx1 = (fingers.get("Index") or [None])[0]
        pnk1 = (fingers.get("Pinky") or [None])[0]
        if idx1 and pnk1 and idx1 in arm.data.bones and pnk1 in arm.data.bones:
            across_k = arm.data.bones[idx1].head_local - arm.data.bones[pnk1].head_local
            n_palm = h_axis.cross(across_k)
            if n_palm.length > 1e-6:
                n_palm.normalize()
                if t_perp.length > 1e-6 and n_palm.dot(t_perp) < 0:
                    n_palm = -n_palm
                palm_dir = (n_palm * 0.8 + t_perp.normalized() * 0.2).normalized() if t_perp.length > 1e-6 else n_palm
        if palm_dir is None and t_perp.length > 1e-6:
            palm_dir = t_perp.normalized()
    if palm_dir is None:
        return mathutils.Vector((0, 0, 0)), None
    local_palm = hb.matrix_local.to_3x3().inverted() @ palm_dir
    if local_palm.length <= 1e-6:
        return mathutils.Vector((0, 0, 0)), palm_dir
    return local_palm.normalized() * min(0.015, 0.18 * h_len), palm_dir


def curl_grip_fingers(arm, fingers, palm_dir, ch_idx, att_idx):
    """Curls finger bones (Index1..3, Middle1..3, Ring1..3, Pinky1..3, Thumb1..2) around the grip."""
    curled = []
    targets = []
    for fname in ("Index", "Middle", "Ring", "Pinky"):
        for bname in (fingers.get(fname) or [])[:3]:
            targets.append((bname, math.radians(55)))
    for bname in (fingers.get("Thumb") or [])[:2]:
        targets.append((bname, math.radians(38)))
    if not targets:
        return curled
    for bname, angle in targets:
        if bname not in arm.data.bones or bname not in arm.pose.bones:
            continue
        fb = arm.data.bones[bname]
        fpb = arm.pose.bones[bname]
        local_axis = mathutils.Vector((1, 0, 0))
        if palm_dir is not None:
            by = fb.matrix_local.to_3x3() @ mathutils.Vector((0, 1, 0))
            c_world = by.cross(palm_dir)
            if c_world.length > 1e-6:
                local_axis = (fb.matrix_local.to_3x3().inverted() @ c_world).normalized()
        q_curl = mathutils.Quaternion(local_axis, angle)
        fpb.matrix_basis = fpb.matrix_basis @ q_curl.to_matrix().to_4x4()
        curled.append(bname)
    if curled and arm.animation_data and arm.animation_data.nla_tracks:
        ad = arm.animation_data
        saved_act = ad.action
        act = bpy.data.actions.new(f"hb_grip_curl_{ch_idx}_{att_idx}")
        use_action(ad, act)
        f0 = SHOT_START[0]
        for bname in curled:
            fpb = arm.pose.bones[bname]
            prop_path = "rotation_quaternion" if fpb.rotation_mode == "QUATERNION" else "rotation_euler"
            fpb.keyframe_insert(prop_path, frame=f0)
        use_action(ad, saved_act)
        tr = ad.nla_tracks.new()
        tr.name = act.name
        st = tr.strips.new(act.name, int(f0), act)
        if hasattr(st, "action_slot") and act.slots and st.action_slot is None:
            st.action_slot = act.slots[0]
        st.blend_type = "REPLACE"
        st.extrapolation = "HOLD"
    return curled


def attach_props(ch, attachments):
    """Puts props in a character's hands (or on its head, back...): the prop follows the bone through the whole shot.
    The grip point of the prop sits on the bone; `offset` (meters) and `rotation` (degrees) are in the bone's frame."""
    arm = ch["arm"]
    for k, a in enumerate(attachments or []):
        where = f"characters[{ch['index']}].attachments[{k}]"
        if not arm:
            warn(f"{where}: the character has no rig, so nothing to attach to")
            continue
        if a.get("prop") is not None:
            pi = int(a["prop"])
            if not (0 <= pi < len(PROPS)):
                fail(f"{where}: no prop {pi} (the shot has {len(PROPS)})")
            state = PROPS[pi]
        else:
            state = add_prop(f"att{ch['index']}_{k}", {"file": a.get("file"), "size": a.get("size"), "scale": a.get("scale")}, SHOT_START[0])
        bone, slot = resolve_bone(arm, a.get("bone"))
        ht = float(a["headTail"]) if a.get("headTail") is not None else HEAD_TAIL.get(slot, 0.0)
        if a.get("prop") is not None and (a.get("size") or a.get("scale")):
            lo, hi = bounds(state["objs"])
            state["root"].scale = (float(a["size"]) / max(hi - lo),) * 3 if a.get("size") else (float(a["scale"]),) * 3
            bpy.context.view_layer.update()
        G = grip_point(state, a.get("grip") or [0.5, 0.5, 0.5])
        is_hand = slot in ("r_wrist", "l_wrist") or "hand" in bone_key(bone) or "wrist" in bone_key(bone)
        fingers = find_hand_fingers(arm, bone, slot) if is_hand else {}
        palm_off, palm_dir = palm_surface_offset(arm, bone, fingers) if is_hand else (mathutils.Vector((0, 0, 0)), None)
        curled = curl_grip_fingers(arm, fingers, palm_dir, ch["index"], k) if (is_hand and a.get("gripCurl", True) is not False and fingers) else []
        holder = bone_holder(arm, bone, f"hb_hold_{ch['index']}_{k}", ht)
        orient = bpy.data.objects.new(f"hb_orient_{ch['index']}_{k}", None)
        scene.collection.objects.link(orient)
        orient.parent = holder
        orient.location = mathutils.Vector((list(a.get("offset") or [0, 0, 0]) + [0, 0, 0])[:3]) + palm_off
        orient.rotation_euler = [math.radians(float(x)) for x in (list(a.get("rotation") or [0, 0, 0]) + [0, 0, 0])[:3]]
        state["root"].parent = orient
        state["root"].matrix_parent_inverse = mathutils.Matrix.Identity(4)
        state["root"].location = -G
        state["orient"] = orient
        state["holder"] = holder
        ch["objs"] = list(ch["objs"]) + list(state["objs"])
        ch["attached"].append({"state": state, "bone": bone, "slot": slot, "fingers": fingers, "spec": a})
        att_info = {"prop": a.get("prop"), "bone": bone, "headTail": ht}
        if palm_off.length > 1e-6:
            att_info["palmOffset"] = [round(x, 4) for x in palm_off]
        if curled:
            att_info["curledFingers"] = curled
        info["characters"][ch["index"]].setdefault("attachments", []).append(att_info)
        say("attached", json.dumps({"character": ch["index"], "bone": bone, "prop": a.get("prop", a.get("file"))}))


def load_image(ref, what, data=False):
    img = bpy.data.images.load(file_arg(ref, what))
    if data:
        img.colorspace_settings.name = "Non-Color"
    return img


def pbr_material(name, m, tile=2.0):
    """A Principled material from texture maps (image.generate seamless + texture.maps: albedo, normal, roughness; or any
    PBR set). m: { albedo|color: file, normal, roughness, metallic, ao, height: files; tint: "#hex"; roughnessValue;
    normalFormat: "opengl"|"directx"; normalStrength; heightStrength }. The UVs are in tile units (set by the caller)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    links = nt.links

    def tex(ref, what, data):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = load_image(ref, f"{name}.{what}", data)
        n.extension = "REPEAT"
        return n

    base = m.get("albedo", m.get("color"))
    if base is not None and not str(base).startswith("#"):
        t = tex(base, "albedo", False)
        out = t.outputs["Color"]
        if m.get("ao") is not None:
            ao = tex(m["ao"], "ao", True)
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs["Factor"].default_value = 1.0
            links.new(t.outputs["Color"], mix.inputs["A"])
            links.new(ao.outputs["Color"], mix.inputs["B"])
            out = mix.outputs["Result"]
        if m.get("tint"):
            tint = nt.nodes.new("ShaderNodeMix")
            tint.data_type = "RGBA"
            tint.blend_type = "MULTIPLY"
            tint.inputs["Factor"].default_value = 1.0
            tint.inputs["B"].default_value = (*color(m["tint"], (1, 1, 1)), 1)
            links.new(out, tint.inputs["A"])
            out = tint.outputs["Result"]
        links.new(out, bsdf.inputs["Base Color"])
    elif base is not None:
        bsdf.inputs["Base Color"].default_value = (*color(base, (0.5, 0.5, 0.5)), 1)
    if m.get("roughness") is not None:
        links.new(tex(m["roughness"], "roughness", True).outputs["Color"], bsdf.inputs["Roughness"])
    else:
        bsdf.inputs["Roughness"].default_value = float(m.get("roughnessValue", 0.8))
    if m.get("metallic") is not None:
        links.new(tex(m["metallic"], "metallic", True).outputs["Color"], bsdf.inputs["Metallic"])
    nrm_in = None
    if m.get("normal") is not None:
        t = tex(m["normal"], "normal", True)
        col = t.outputs["Color"]
        if str(m.get("normalFormat", "opengl")).lower() == "directx":
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            inv = nt.nodes.new("ShaderNodeMath")
            inv.operation = "SUBTRACT"
            inv.inputs[0].default_value = 1.0
            comb = nt.nodes.new("ShaderNodeCombineColor")
            links.new(col, sep.inputs["Color"])
            links.new(sep.outputs["Green"], inv.inputs[1])
            links.new(sep.outputs["Red"], comb.inputs["Red"])
            links.new(inv.outputs["Value"], comb.inputs["Green"])
            links.new(sep.outputs["Blue"], comb.inputs["Blue"])
            col = comb.outputs["Color"]
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = float(m.get("normalStrength", 1.0))
        links.new(col, nm.inputs["Color"])
        nrm_in = nm.outputs["Normal"]
    if m.get("height") is not None:
        t = tex(m["height"], "height", True)
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = float(m.get("heightStrength", 0.4))
        links.new(t.outputs["Color"], bump.inputs["Height"])
        if nrm_in:
            links.new(nrm_in, bump.inputs["Normal"])
        nrm_in = bump.outputs["Normal"]
    if nrm_in:
        links.new(nrm_in, bsdf.inputs["Normal"])
    return mat


def quad(name, corners, uv_scale, mat):
    """A flat quad from four corners (world meters, counter-clockwise), UVs in tile units, with a material."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(c) for c in corners], [], [(0, 1, 2, 3)])
    me.update()
    uv = me.uv_layers.new(name="UVMap")
    a, b, c, d = [mathutils.Vector(x) for x in corners]
    w, h = (b - a).length / uv_scale, (d - a).length / uv_scale
    for loop, (u, v) in zip(me.polygons[0].loop_indices, ((0, 0), (w, 0), (w, h), (0, h))):
        uv.data[loop].uv = (u, v)
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    return ob


def add_ground(g):
    g = g if isinstance(g, dict) else {}
    size = float(g.get("size", 60))
    m = g.get("material")
    if isinstance(m, dict):
        tile = float(m.get("tile", 2.0))
        h = size / 2
        return quad("hb_ground", [(-h, -h, 0), (h, -h, 0), (h, h, 0), (-h, h, 0)], tile, pbr_material("hb_ground", m, tile))
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    plane = bpy.context.active_object
    plane.name = "hb_ground"
    mat = bpy.data.materials.new("hb_ground")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color(g.get("color"), (0.18, 0.18, 0.18)), 1)
        bsdf.inputs["Roughness"].default_value = 0.8
    plane.data.materials.append(mat)
    return plane


def add_walls(walls):
    """Wall quads: [{ from: [x, y], to: [x, y], height: 3, material: {...} | color }]. The texture tiles every `tile` meters."""
    out = []
    for i, w in enumerate(walls or []):
        a, b = list(w.get("from", [-5, 5])) + [0], list(w.get("to", [5, 5])) + [0]
        hgt = float(w.get("height", 3.0))
        m = w.get("material")
        tile = float((m or {}).get("tile", 2.0))
        if isinstance(m, dict):
            mat = pbr_material(f"hb_wall_{i}", m, tile)
        else:
            mat = bpy.data.materials.new(f"hb_wall_{i}")
            mat.use_nodes = True
            bsdf = mat.node_tree.nodes.get("Principled BSDF")
            bsdf.inputs["Base Color"].default_value = (*color(w.get("color"), (0.3, 0.3, 0.32)), 1)
            bsdf.inputs["Roughness"].default_value = 0.9
        out.append(quad(f"hb_wall_{i}", [(a[0], a[1], 0), (b[0], b[1], 0), (b[0], b[1], hgt), (a[0], a[1], hgt)], tile, mat))
    return out


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


CHARS = []  # the shot's built characters, so effects can find a character's rig
VFX_OBJS = []  # glow meshes and beams: seen in the beauty pass only


def glow_material(name, rgb, strength, beam=False, opacity=0.06):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*rgb, 1)
    em.inputs["Strength"].default_value = strength
    if beam:
        # A faint light cone: a see-through shader with a little emission mixed in.
        clear = nt.nodes.new("ShaderNodeBsdfTransparent")
        mix = nt.nodes.new("ShaderNodeMixShader")
        mix.inputs["Fac"].default_value = opacity
        nt.links.new(clear.outputs["BSDF"], mix.inputs[1])
        nt.links.new(em.outputs["Emission"], mix.inputs[2])
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
        try:
            mat.surface_render_method = "BLENDED"
        except (AttributeError, TypeError):
            pass
    else:
        nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return mat


def vfx_anchor(a, name):
    """Where an effect sits: (parent object or None, offset). On the grip of a prop a character holds (`prop`), on one
    of a character's bones (`character` + `bone`), or a spot in the world (`position`)."""
    a = a or {}
    off = mathutils.Vector((list(a.get("offset") or a.get("position") or [0, 0, 0]) + [0, 0, 0])[:3])
    if a.get("prop") is not None:
        pi = int(a["prop"])
        if not (0 <= pi < len(PROPS)) or not PROPS[pi].get("orient"):
            fail(f"{name}: prop {a.get('prop')} isn't held by anyone (attach it to a character first)")
        return PROPS[pi]["orient"], off
    if a.get("bone") is not None:
        ci = int(a.get("character", 0))
        if not (0 <= ci < len(CHARS)) or not CHARS[ci]["arm"]:
            fail(f"{name}: character {ci} has no rig for the bone {a.get('bone')!r}")
        bone, slot = resolve_bone(CHARS[ci]["arm"], a["bone"])
        return bone_holder(CHARS[ci]["arm"], bone, f"{name}_bone", HEAD_TAIL.get(slot, 0.0)), off
    return None, off


def times_of(v, default=(0.0,)):
    """`at` as seconds: a number, a list, or (with `every` and `count`) a run starting at `at`."""
    at = v.get("at", list(default))
    at = [at] if isinstance(at, (int, float)) else list(at)
    if v.get("every") and len(at) == 1:
        at = [at[0] + k * float(v["every"]) for k in range(int(v.get("count", 1)))]
    return sorted(float(x) for x in at)


def make_target(spec, name):
    """An empty to aim at: a point, or a character (it follows the character's hips)."""
    t = bpy.data.objects.new(name, None)
    scene.collection.objects.link(t)
    if isinstance(spec, dict) and spec.get("character") is not None:
        ci = int(spec["character"])
        ch = CHARS[ci] if 0 <= ci < len(CHARS) else None
        if not ch:
            fail(f"{name}: no character {ci}")
        if ch["arm"]:
            cl = t.constraints.new("COPY_LOCATION")
            cl.target, cl.subtarget = ch["arm"], hips_bone(ch["arm"]) or ""
        else:
            t.location = ch["pos"] + mathutils.Vector((0, 0, ch["height"] * 0.55))
    else:
        pt = spec.get("position") if isinstance(spec, dict) else spec
        t.location = mathutils.Vector((list(pt or [0, 0, 1]) + [0, 0, 0])[:3])
    return t


def key_pulse(target, prop, times, secs, high, start, fps, index=-1):
    """Keys a value to `high` for `secs` at each time and 0 elsewhere (sharp edges), on an object or light data."""
    new_keys("LINEAR")
    n = max(1, int(round(secs * fps)))
    zero = (0, 0, 0) if prop == "scale" else 0.0
    for t in times:
        f = start + int(round(t * fps))
        for fr, val in ((f - 1, zero), (f, high), (f + n - 1, high), (f + n, zero)):
            setattr(target, prop, val)
            target.keyframe_insert(prop, frame=fr)
    set_interp(target, prop, "LINEAR")
    new_keys("BEZIER")


def add_vfx(i, v, start, fps):
    kind = str(v.get("type", "")).lower()
    name = f"hb_vfx_{i}_{kind}"
    parent, off = vfx_anchor(v.get("attach") or v, name)
    rgb = color(v.get("color"), (1.0, 0.62, 0.25) if kind in ("muzzle-flash", "flash", "pulse") else (1.0, 0.95, 0.82))
    power = float(v.get("power", 900 if kind == "muzzle-flash" else 1500 if kind == "flashlight" else 2000))
    times = times_of(v)
    secs = float(v.get("seconds", 0.07))
    if kind in ("muzzle-flash", "flash", "pulse"):
        ld = bpy.data.lights.new(name, "POINT")
        ld.color, ld.energy, ld.shadow_soft_size = rgb, 0.0, 0.05
        lo = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(lo)
        lo.parent = parent
        lo.location = off
        key_pulse(ld, "energy", times, secs, power, start, fps)
        if kind == "muzzle-flash" or v.get("ball"):
            size = float(v.get("size", 0.1))
            bpy.ops.mesh.primitive_ico_sphere_add(radius=size, subdivisions=2)
            ball = bpy.context.active_object
            ball.name = name + "_glow"
            ball.data.materials.append(glow_material(name, rgb, 40.0))
            ball.parent = parent
            ball.location = off
            ball.scale = (0, 0, 0)
            ball["hb_vfx"] = 1
            key_pulse(ball, "scale", times, secs, (1.0, 1.0, 1.0), start, fps)
            VFX_OBJS.append(ball)
    elif kind == "flashlight":
        ld = bpy.data.lights.new(name, "SPOT")
        ld.color, ld.energy = rgb, power
        ld.spot_size = math.radians(min(170.0, max(5.0, float(v.get("angle", 30)))))
        ld.spot_blend = float(v.get("blend", 0.35))
        ld.shadow_soft_size = 0.04
        lo = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(lo)
        lo.parent = parent
        lo.location = off
        tgt = make_target(v.get("target", [0, 0, 1]), name + "_aim")
        con = lo.constraints.new("TRACK_TO")
        con.target = tgt
        con.track_axis = "TRACK_NEGATIVE_Z"
        con.up_axis = "UP_Y"
        win = None
        if v.get("from") is not None or v.get("to") is not None:
            win = (float(v.get("from", 0)), float(v.get("to", 1e6)))
            frames_total = SPEC.get("frames") or 0
            end_s = max(win[0] + 0.1, min(win[1], (frames_total - 1) / fps if frames_total else win[1]))
            key_pulse(ld, "energy", [win[0]], end_s - win[0], power, start, fps)
        if v.get("beam", True):
            length = float(v.get("length", 8.0))
            radius = length * math.tan(ld.spot_size / 2)
            bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=radius, radius2=0.0, depth=length)
            cone = bpy.context.active_object
            cone.name = name + "_beam"
            cone.data.materials.append(glow_material(name + "_beam", rgb, 2.0, beam=True, opacity=float(v.get("beamOpacity", 0.04))))
            cone.parent = lo
            cone.location = (0, 0, -length / 2)
            cone["hb_vfx"] = 1
            if win:
                cone.scale = (0, 0, 0)
                key_pulse(cone, "scale", [win[0]], end_s - win[0], (1.0, 1.0, 1.0), start, fps)
            VFX_OBJS.append(cone)
    else:
        fail(f"vfx[{i}]: unknown type {kind!r} (muzzle-flash, flashlight, pulse)")
    say("vfx", json.dumps({"type": kind, "times": times}))


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
    elif move == "turntable":
        # A full turn about the target at a steady rate (for turntable stills and LoRA training sets).
        steps = 24
        new_keys("LINEAR")
        for k in range(steps + 1):
            place(angle + math.radians(float(amt if amt is not None else 360)) * k / steps, dist, height)
            key(start + round((end - start) * k / steps))
        set_interp(cam, "location", "LINEAR")
        set_interp(target, "location", "LINEAR")
        new_keys("BEZIER")
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

    # Depth of field: focus on what the camera aims at (or a distance), at an f-stop.
    dof = cs.get("dof")
    if dof:
        dof = {} if dof is True else dof
        cam_data.dof.use_dof = True
        cam_data.dof.aperture_fstop = float(dof.get("fstop", 2.8))
        focus = dof.get("focus", "target")
        if isinstance(focus, (int, float)) and not isinstance(focus, bool):
            cam_data.dof.focus_distance = float(focus)
        else:
            cam_data.dof.focus_object = target

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


def look_target_empty(spec, name, ch, head_level=True):
    """Creates an Empty in the scene for head/spine gaze (`lookAt`) or weapon aiming (`aimAt`)."""
    if isinstance(spec, str) and spec.lower() == "camera":
        t = bpy.data.objects.new(name, None)
        scene.collection.objects.link(t)
        if scene.camera:
            cl = t.constraints.new("COPY_LOCATION")
            cl.target = scene.camera
        else:
            t.location = (0, -4, (ch.get("height") or 1.7) * 0.9)
        return t
    if (isinstance(spec, int) and not isinstance(spec, bool)) or (isinstance(spec, dict) and spec.get("character") is not None):
        ci = spec if isinstance(spec, int) else int(spec["character"])
        if 0 <= ci < len(CHARS):
            other = CHARS[ci]
            o_arm = other.get("arm")
            if o_arm:
                o_bones = find_bones(o_arm)
                bname = (o_bones.get("head") if head_level else None) or hips_bone(o_arm)
                if bname:
                    return bone_holder(o_arm, bname, name, 0.5 if bname == o_bones.get("head") else 0.0)
            t = bpy.data.objects.new(name, None)
            scene.collection.objects.link(t)
            carrier = other.get("mover") or other["root"]
            t.parent = carrier
            t.location = (0, 0, (other.get("height") or 1.7) * (0.9 if head_level else 0.65))
            return t
    pt = list(spec.get("position") if isinstance(spec, dict) else (spec if isinstance(spec, (list, tuple)) else [0, 0, 1]))
    if len(pt) == 2:
        pt = [pt[0], pt[1], ch["pos"].z + (ch.get("height") or 1.7) * (0.9 if head_level else 0.75)]
    else:
        pt = (pt + [0, 0, 1])[:3]
    t = bpy.data.objects.new(name, None)
    scene.collection.objects.link(t)
    t.location = mathutils.Vector((float(pt[0]), float(pt[1]), float(pt[2])))
    return t


def bone_forward_track_axis(arm, bone_name):
    """Finds the local non-length axis (X, -X, Z, -Z) of a head/spine bone that faces forward at rest."""
    bones = find_bones(arm)
    fwd_local = mathutils.Vector((0, -1, 0))
    l_sh, r_sh = bones.get("l_shoulder"), bones.get("r_shoulder")
    if l_sh and r_sh and l_sh in arm.data.bones and r_sh in arm.data.bones:
        across = arm.data.bones[l_sh].head_local - arm.data.bones[r_sh].head_local
        f = across.cross(mathutils.Vector((0, 0, 1)))
        if f.length > 1e-6:
            fwd_local = f.normalized()
    b = arm.data.bones.get(bone_name)
    if not b:
        return "TRACK_Z"
    mat3 = b.matrix_local.to_3x3()
    candidates = (
        ("TRACK_X", mathutils.Vector((1, 0, 0))),
        ("TRACK_NEGATIVE_X", mathutils.Vector((-1, 0, 0))),
        ("TRACK_Z", mathutils.Vector((0, 0, 1))),
        ("TRACK_NEGATIVE_Z", mathutils.Vector((0, 0, -1))),
    )
    return max(candidates, key=lambda item: (mat3 @ item[1]).dot(fwd_local))[0]


def setup_gaze_and_aim(chars, start, frames, fps):
    """Adds DAMPED_TRACK constraints on Head (0.65) and Neck/Spine2 (0.3) for lookAt, and on hand/forearm bones for aimAt."""
    for ch in chars:
        arm = ch.get("arm")
        if not arm:
            continue
        c = ch.get("spec") or {}
        segs = ch.get("segs") or c.get("beats") or []
        bones = find_bones(arm)
        pb = arm.pose.bones
        head_bone = bones.get("head")
        neck_spine = bones.get("neck") or next((b.name for b in arm.data.bones if bone_key(b.name) in ("spine2", "upperchest", "chest", "spine1", "spine")), None)

        # Collect lookAt targets from c.lookAt or beats/segments
        look_specs = []
        if c.get("lookAt") is not None:
            look_specs.append((c["lookAt"], None))
        for g in segs:
            if isinstance(g, dict) and g.get("lookAt") is not None:
                look_specs.append((g["lookAt"], g))
        if look_specs and (head_bone or neck_spine):
            spec_val = look_specs[-1][0]
            tgt = look_target_empty(spec_val, f"hb_look_{ch['index']}", ch, head_level=True)
            cons = []
            if head_bone and head_bone in pb:
                con_h = pb[head_bone].constraints.new("DAMPED_TRACK")
                con_h.name = "hb_look_head"
                con_h.target = tgt
                con_h.track_axis = bone_forward_track_axis(arm, head_bone)
                con_h.influence = 0.65
                cons.append((pb[head_bone], con_h, 0.65))
            if neck_spine and neck_spine in pb and neck_spine != head_bone:
                con_s = pb[neck_spine].constraints.new("DAMPED_TRACK")
                con_s.name = "hb_look_spine"
                con_s.target = tgt
                con_s.track_axis = bone_forward_track_axis(arm, neck_spine)
                con_s.influence = 0.3
                cons.append((pb[neck_spine], con_s, 0.3))
            # If lookAt only appears on some timed segments (and not set globally on the character), keyframe influence per segment
            if c.get("lookAt") is None and ch.get("segs") and any(g.get("lookAt") is None for g in ch["segs"]):
                for pbone, con, max_inf in cons:
                    for g in ch["segs"]:
                        f0 = start + int(round(g["t0"] * fps))
                        f1 = start + int(round(g["t1"] * fps))
                        val = max_inf if g.get("lookAt") is not None else 0.0
                        con.influence = val
                        pbone.keyframe_insert(f'constraints["{con.name}"].influence', frame=f0)
                        if f1 > f0:
                            pbone.keyframe_insert(f'constraints["{con.name}"].influence', frame=f1)
                    if ch["segs"][-1].get("lookAt") is not None:
                        con.influence = max_inf

        # Weapon/prop aiming (aimAt on attachment, character, or beat)
        aim_entries = []
        for att in ch.get("attached") or []:
            a_spec = att.get("spec") or {}
            if a_spec.get("aimAt") is not None:
                aim_entries.append((att["bone"], a_spec["aimAt"]))
        char_aim = c.get("aimAt")
        if char_aim is None:
            for g in segs:
                if isinstance(g, dict) and g.get("aimAt") is not None:
                    char_aim = g["aimAt"]
        if char_aim is not None and not aim_entries:
            hold_bone = ch["attached"][0]["bone"] if ch.get("attached") else resolve_bone(arm, "right hand")[0]
            aim_entries.append((hold_bone, char_aim))
        for k, (hold_bone, aim_spec) in enumerate(aim_entries):
            if hold_bone not in pb:
                continue
            aim_tgt = look_target_empty(aim_spec, f"hb_aim_{ch['index']}_{k}", ch, head_level=False)
            pb_hand = pb[hold_bone]
            if pb_hand.parent and any(x in bone_key(pb_hand.parent.name) for x in ("forearm", "lowerarm", "elbow", "arm")):
                con_fa = pb_hand.parent.constraints.new("DAMPED_TRACK")
                con_fa.name = "hb_aim_forearm"
                con_fa.target = aim_tgt
                con_fa.track_axis = "TRACK_Y"
                con_fa.influence = 0.7
            con_h = pb_hand.constraints.new("DAMPED_TRACK")
            con_h.name = "hb_aim_hand"
            con_h.target = aim_tgt
            con_h.track_axis = "TRACK_Y"
            con_h.influence = 1.0


def declip_attached_props(chars, start, frames):
    """Checks 3D mesh overlap with BVHTree.FromObject on sampled frames and nudges attached props out of forearm/torso intersections."""
    sample_frames = sorted({start, start + frames // 2, start + max(0, frames - 1)})
    for ch in chars:
        arm = ch.get("arm")
        if not arm or not ch.get("attached"):
            continue
        body_meshes = [o for o in ch.get("body_meshes") or [] if o.type == "MESH" and not o.hide_render]
        if not body_meshes:
            continue
        for att in ch["attached"]:
            state = att["state"]
            hand_bone = att["bone"]
            finger_set = {hand_bone} | {b for blist in (att.get("fingers") or {}).values() for b in blist}
            prop_meshes = [o for o in state["objs"] if o.type == "MESH" and not o.hide_render]
            if not prop_meshes:
                continue
            # Exclude meshes rigidly parented to the gripping hand or its fingers
            check_meshes = [o for o in body_meshes if not (o.parent_type == "BONE" and o.parent_bone in finger_set)]
            if not check_meshes:
                continue
            for _step in range(6):
                push_world = mathutils.Vector((0, 0, 0))
                hits = 0
                for sf in sample_frames:
                    scene.frame_set(sf)
                    dg = bpy.context.evaluated_depsgraph_get()
                    pb_h = arm.pose.bones.get(hand_bone)
                    hand_center = (arm.matrix_world @ ((pb_h.head + pb_h.tail) / 2)) if pb_h else None
                    hand_rad = (arm.matrix_world.to_3x3() @ (pb_h.tail - pb_h.head)).length * 1.15 if pb_h else 0.12
                    p_trees = []
                    for pm in prop_meshes:
                        try:
                            p_trees.append((pm, BVHTree.FromObject(pm, dg)))
                        except Exception:
                            pass
                    for bm in check_meshes:
                        try:
                            b_tree = BVHTree.FromObject(bm, dg)
                        except Exception:
                            continue
                        ev_b = bm.evaluated_get(dg)
                        me_b = ev_b.to_mesh()
                        mw_b = ev_b.matrix_world
                        for pm, pt in p_trees:
                            ov = pt.overlap(b_tree)
                            for _pi, bi in ov:
                                if bi < len(me_b.polygons):
                                    fc = mw_b @ me_b.polygons[bi].center
                                    # Ignore polygons inside the gripping palm/finger sphere on a single-skin mesh
                                    if hand_center is not None and (fc - hand_center).length <= hand_rad:
                                        continue
                                    p_lo, p_hi = bounds([pm])
                                    p_mid = (p_lo + p_hi) / 2
                                    diff = p_mid - fc
                                    if diff.length > 1e-6:
                                        push_world += diff.normalized()
                                        hits += 1
                        ev_b.to_mesh_clear()
                if not hits or push_world.length <= 1e-6:
                    break
                scene.frame_set(start)
                orient = state.get("orient")
                if orient:
                    local_dir = (orient.matrix_world.to_3x3().inverted() @ push_world.normalized()).normalized()
                    state["root"].location += local_dir * 0.015
                    bpy.context.view_layer.update()
    scene.frame_set(start)


def jump_offset(ch, t_sec):
    """Parabolic gravity arc z(t) = v0*t - 0.5*9.81*t^2 when a beat/segment has jumpHeight > 0."""
    segs = ch.get("segs") or (ch.get("spec") or {}).get("beats") or []
    t_cur = 0.0
    for g in segs:
        if not isinstance(g, dict):
            continue
        t0 = float(g.get("t0", g.get("at", t_cur)))
        t1 = float(g.get("t1", t0 + float(g.get("seconds") or 0)))
        t_cur = t1
        jh = float(g.get("jumpHeight") or 0)
        if jh > 0 and t0 - 1e-6 <= t_sec <= t1 + 1e-6:
            dt = max(0.0, t_sec - t0)
            v0 = math.sqrt(2.0 * 9.81 * jh)
            return max(0.0, v0 * dt - 0.5 * 9.81 * dt * dt)
    return 0.0


def clamp_ground_and_gravity(chars, start, frames, fps):
    """Clamps grounded characters per-frame so the evaluated mesh lowest point lo.z stays on the floor (z = pos.z)
    across the shot, while allowing parabolic gravity arcs when a beat has jumpHeight > 0."""
    if not chars:
        return
    new_keys("LINEAR")
    for f in range(start, start + frames):
        scene.frame_set(f)
        t_sec = (f - start) / fps
        for ch in chars:
            ms = ch.get("body_meshes") or ch["objs"]
            if not ms:
                continue
            lo, _ = bounds(ms)
            want_z = ch["pos"].z + jump_offset(ch, t_sec)
            dz = want_z - lo.z
            if abs(dz) > 1e-5 or f == start or f == start + frames - 1 or jump_offset(ch, t_sec) > 0:
                ch["root"].location.z += dz
            ch["root"].keyframe_insert("location", index=2, frame=f)
    for ch in chars:
        set_interp(ch["root"], "location", "LINEAR")
    new_keys("BEZIER")
    scene.frame_set(start)


def build_shot(shot, start, frames, fps):
    SHOT_START[0] = start
    chars = []
    for i, c in enumerate(shot.get("characters") or []):
        chars.append(add_character(i, c, start, frames, fps))
    for i, p in enumerate(shot.get("props") or []):
        add_prop(i, p, start)
    CHARS[:] = chars
    # Props in hands (and on heads, backs...): after the props exist, before the effects that ride on them.
    for ch, c in zip(chars, shot.get("characters") or []):
        if c.get("attachments"):
            attach_props(ch, c["attachments"])
    char_objs = [o for ch in chars for o in ch["objs"]]
    ground = shot.get("ground", not SPEC.get("blend"))
    if ground:
        add_ground(ground if isinstance(ground, dict) else {})
    if shot.get("walls"):
        add_walls(shot["walls"])
    if shot.get("background") is not None or not SPEC.get("blend"):
        set_background(shot.get("background") or {})
    center = chars[0]["pos"] if chars else mathutils.Vector((0, 0, 0))
    size = max([c["height"] for c in chars] + [1.7]) / 1.7
    lights = shot.get("lights", "studio" if not SPEC.get("blend") else "none")
    add_lights(lights, center, size)
    for i, v in enumerate(shot.get("vfx") or []):
        add_vfx(i, v, start, fps)
    if shot.get("camera") is not None or not scene.camera:
        add_camera(shot.get("camera") or {}, chars, start, frames, fps)
    setup_gaze_and_aim(chars, start, frames, fps)
    clamp_ground_and_gravity(chars, start, frames, fps)
    declip_attached_props(chars, start, frames)
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
            if o.type != "MESH" or o.hide_render or not o.visible_get() or o.get("hb_vfx"):
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


def still_frames(spec, start, frames):
    """[(share of the shot, frame)] for the `stills` asked for: a list of shares (0 to 1), or a count spread evenly."""
    if not spec:
        return []
    if isinstance(spec, (int, float)) and not isinstance(spec, bool):
        n = max(1, int(spec))
        shares = [0.0] if n == 1 else [k / (n - 1) for k in range(n)]
    else:
        shares = [min(1.0, max(0.0, float(x))) for x in spec]
    return [(sh, start + int(round(sh * (frames - 1)))) for sh in shares]


def char_state(ch):
    """Where a character stands and which way it faces at the current frame (for the director gate): its mover's spot
    when it follows beats, else the middle of its body; facing from the posed shoulder/pelvis bones when rigged."""
    lo, hi = bounds(ch["objs"])
    carrier = ch.get("mover") or ch["root"]
    yaw = math.degrees(carrier.matrix_world.to_euler().z)
    arm = ch.get("arm")
    if arm:
        bones = find_bones(arm)
        M = arm.matrix_world
        pb = arm.pose.bones
        across = mathutils.Vector((0, 0, 0))
        for lk, rk in (("l_shoulder", "r_shoulder"), ("l_hip", "r_hip")):
            lb, rb = bones.get(lk), bones.get(rk)
            if lb and rb and lb in pb and rb in pb:
                across += (M @ pb[lb].head) - (M @ pb[rb].head)
                break
        fwd = across.cross(mathutils.Vector((0, 0, 1)))
        if fwd.x * fwd.x + fwd.y * fwd.y > 1e-8:
            yaw = math.degrees(math.atan2(fwd.x, -fwd.y))
    yaw = (yaw + 180) % 360 - 180
    if ch.get("mover"):
        x, y = carrier.matrix_world.translation.x, carrier.matrix_world.translation.y
    else:
        x, y = (lo.x + hi.x) / 2, (lo.y + hi.y) / 2
    return {"index": ch["index"], "x": round(x, 3), "y": round(y, 3), "facing": round(yaw, 1), "height": round(hi.z - lo.z, 3)}


def char_overlaps(chars):
    """Checks 3D mesh overlap between pairs of characters at the current frame using BVHTree.FromObject."""
    if len(chars) < 2:
        return []
    dg = bpy.context.evaluated_depsgraph_get()
    boxes = []
    trees = []
    for ch in chars:
        ms = [o for o in ch.get("body_meshes") or ch["objs"] if o.type == "MESH" and not o.hide_render]
        boxes.append(bounds(ms) if ms else None)
        tlist = []
        for o in ms:
            try:
                tlist.append(BVHTree.FromObject(o, dg))
            except Exception:
                pass
        trees.append(tlist)
    overlaps = []
    for a in range(len(chars)):
        for b in range(a + 1, len(chars)):
            if not boxes[a] or not boxes[b] or not trees[a] or not trees[b]:
                continue
            lo_a, hi_a = boxes[a]
            lo_b, hi_b = boxes[b]
            if any(hi_a[k] < lo_b[k] or hi_b[k] < lo_a[k] for k in range(3)):
                continue
            faces = sum(len(ta.overlap(tb)) for ta in trees[a] for tb in trees[b])
            if faces > 0:
                overlaps.append({"a": chars[a]["index"], "b": chars[b]["index"], "faces": faces})
    return overlaps


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

    passes = SPEC.get("passes") if SPEC.get("passes") is not None else ["beauty", "depth", "pose"]
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
    total = frames * len([p for p in passes if p in ("beauty", "depth", "normal", "mask")]) + frames * (len(chars) if "layers" in passes else 0)
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

    stills = still_frames(SPEC.get("stills"), start, frames)
    if stills:
        total += len(stills) if "beauty" not in passes else 0

    def beauty_setup():
        info["engine"] = set_engine(SPEC.get("engine", "cycles"))
        if scene.render.engine == "CYCLES":
            scene.cycles.samples = int(SPEC.get("samples", 32))
            scene.cycles.use_denoising = True
            if not SPEC.get("blend") or SHOT:
                scene.view_settings.view_transform = "AgX"

    if "beauty" in passes:
        beauty_setup()
        render("beauty")
    elif stills:
        beauty_setup()
    if stills:
        os.makedirs(os.path.join(OUT, "stills"), exist_ok=True)
        info["stills"] = []
        for k, (fr, f) in enumerate(stills):
            dest = os.path.join(OUT, "stills", f"{k + 1:02d}.png")
            src = os.path.join(OUT, "beauty", f"{f:05d}.png")
            if "beauty" in passes and os.path.exists(src):
                shutil.copy(src, dest)
            else:
                scene.frame_set(f)
                scene.render.filepath = os.path.join(OUT, "stills", f"{k + 1:02d}")
                bpy.ops.render.render(write_still=True)
            scene.frame_set(f)
            info["stills"].append({"t": round(fr, 4), "frame": f, "file": f"stills/{k + 1:02d}.png", "characters": [char_state(c) for c in chars], "overlaps": char_overlaps(chars)})

    # The data passes: Cycles, emission only, a couple of samples, no bounces, no color management.
    if any(p in passes for p in ("depth", "normal", "mask", "layers")):
        for o in VFX_OBJS:
            o.hide_render = True
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
        if "layers" in passes:
            # Each character alone, white on black, with everything else (other characters too) holding it out.
            if len(chars) < 1:
                warn("layers needs a shot with characters")
            vl.material_override = emission_material("hb_white", lambda n, l: (1.0, 1.0, 1.0))
            scene.render.film_transparent = True
            scene.render.image_settings.color_mode = "RGBA"
            for ci, ch in enumerate(chars):
                keep = set(ch["objs"])
                held = []
                for o in scene.objects:
                    if o.type == "MESH" and o not in keep and not o.is_holdout:
                        o.is_holdout = True
                        held.append(o)
                render(f"layer{ci}")
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
