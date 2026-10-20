"""Works on a 3D character for Hawkes Gen's blender.character tool. Runs inside Blender (5.0):

    blender -b --factory-startup --python-exit-code 1 -P hawkes_character.py -- spec.json

spec.json: { "out": folder, "files": [paths], "fps": 30, "device": "auto" | "cpu", "ops": [ { "op": ..., ... }, ... ] }

A fixed set of named ops, run in order on one character (no free-form bpy):

    import    the character (GLB/GLTF, FBX, OBJ): its meshes, its skeleton and the clips in the file
    clean     merge by distance, fix normals, decimate to a triangle budget (the original kept as the bake source)
    bake      new UVs (smart project) and base color / normal maps baked from the high-poly
    attach    a prop on a bone (a bat in RightHand), with an offset
    retarget  clips from another skeleton (FBX, GLB, BVH; Mixamo, Unity, Unreal, Rigify, SMPL/SOMA, BVH names),
              rest-pose aware: bone directions are matched in world space, so a T-pose clip plays on an A-pose rig
    trim, loop, inplace, speed, mirror, reverse, concat, pose, copy, rename, remove    clip edits
    split     hard-surface parts: by connected pieces and/or labelled centers (Claude or a guess for a template)
    template  fit a robot skeleton (spider / quadarm / biped / chain) to the parts and bind each part rigidly
    clips     procedural walk/run/idle/attack/hit/death/jump for that template
    export    FBX for Unity (Mixamo bone names, a take per clip, 1 unit = 1 m; bones: keep for Generic robots),
              GLB for the web (a clip per NLA track), or the .blend
    preview   writes the shots hawkes_blender.py renders afterwards: a turntable and one video per clip

Clips are kept as sampled poses (each bone's rotation and location relative to its rest, per frame) and written to
actions only for an export, so edits compose without resampling F-curves. Writes out/character.json (what each op
did, the bones and their names, the clips, warnings, the files made) and out/files/*. Lines starting with "HB " are
progress for Hawkes Gen. docs/3d-characters.md has the ops in full.
"""

import json
import math
import os
import re
import sys
import time

import bpy
import bmesh
import mathutils
import numpy as np
from mathutils.bvhtree import BVHTree

# Same folder on the GPU server (character.ts copies both scripts). Loaded when a robot op runs.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
robot = None


def need_robot(what):
    global robot
    if robot is None:
        try:
            import hawkes_robot as _robot
        except ImportError:
            fail(f"{what}: hawkes_robot.py is missing next to hawkes_character.py (Gen should have copied it)")
        robot = _robot
    return robot

V = mathutils.Vector
M = mathutils.Matrix
Q = mathutils.Quaternion


def say(*a):
    print("HB", *a, flush=True)


def fail(msg):
    say("error", msg)
    sys.exit(1)


ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not ARGV:
    fail("usage: blender -b -P hawkes_character.py -- spec.json")
SPEC = json.load(open(ARGV[0], encoding="utf-8"))
OUT = SPEC["out"]
FILES_OUT = os.path.join(OUT, "files")
os.makedirs(FILES_OUT, exist_ok=True)
FILES = SPEC.get("files") or []
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
FPS = int(SPEC.get("fps") or 30)
scene.render.fps = FPS
scene.render.fps_base = 1
info = {"blender": bpy.app.version_string, "fps": FPS, "warnings": [], "ops": [], "outputs": [], "previews": []}


def warn(msg):
    info["warnings"].append(msg)
    say("warning", msg)


def file_arg(ref, what):
    if isinstance(ref, int) or (isinstance(ref, str) and ref.isdigit()):
        i = int(ref)
        if 0 <= i < len(FILES):
            return FILES[i]
    fail(f"{what}: no file {ref!r} (give the index of one of the job's files, 0 to {len(FILES) - 1})")


def select(objs, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def import_file(path):
    """Imports a model or motion file at the scene's frame rate; returns the new objects and actions."""
    objs0, acts0 = set(bpy.data.objects), set(bpy.data.actions)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path, use_anim=True)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".bvh":
        bpy.ops.import_anim.bvh(filepath=path, use_fps_scale=True, update_scene_fps=False, update_scene_duration=False)
    else:
        fail(f"can't import {os.path.basename(path)} (glb, gltf, fbx, obj or bvh)")
    objs = [o for o in bpy.data.objects if o not in objs0]
    for o in list(objs):
        if o.type in ("CAMERA", "LIGHT"):
            bpy.data.objects.remove(o, do_unlink=True)
    objs = [o for o in bpy.data.objects if o not in objs0]
    return objs, [a for a in bpy.data.actions if a not in acts0]


def remove(objs):
    for o in objs:
        try:
            bpy.data.objects.remove(o, do_unlink=True)
        except ReferenceError:
            pass


def mesh_bounds(objs, dg=None):
    dg = dg or bpy.context.evaluated_depsgraph_get()
    lo, hi = V((1e9,) * 3), V((-1e9,) * 3)
    for o in objs:
        if o.type != "MESH":
            continue
        ev = o.evaluated_get(dg)
        for c in ev.bound_box:
            w = ev.matrix_world @ V(c)
            lo, hi = V(map(min, lo, w)), V(map(max, hi, w))
    return lo, hi


def triangles(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


# ---------------------------------------------------------------- bone names

# The canonical names are Mixamo's without the prefix. Each scheme maps a bone's key (its name lowercased, letters and
# digits only, without a "prefix:" and without Rigify's DEF-/ORG-) to one.
FINGERS = ("Thumb", "Index", "Middle", "Ring", "Pinky")
CANON = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "HeadTop_End"]
for _s in ("Left", "Right"):
    CANON += [f"{_s}Shoulder", f"{_s}Arm", f"{_s}ForeArm", f"{_s}Hand", f"{_s}UpLeg", f"{_s}Leg", f"{_s}Foot",
              f"{_s}ToeBase", f"{_s}Toe_End"]
    CANON += [f"{_s}Hand{f}{k}" for f in FINGERS for k in range(1, 5)]
# The joint each bone points at (its direction in the rest pose).
CHILD = {"Hips": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Neck", "Neck": "Head", "Head": "HeadTop_End"}
for _s in ("Left", "Right"):
    CHILD.update({f"{_s}Shoulder": f"{_s}Arm", f"{_s}Arm": f"{_s}ForeArm", f"{_s}ForeArm": f"{_s}Hand",
                  f"{_s}Hand": f"{_s}HandMiddle1", f"{_s}UpLeg": f"{_s}Leg", f"{_s}Leg": f"{_s}Foot",
                  f"{_s}Foot": f"{_s}ToeBase", f"{_s}ToeBase": f"{_s}Toe_End"})
    for f in FINGERS:
        for k in range(1, 4):
            CHILD[f"{_s}Hand{f}{k}"] = f"{_s}Hand{f}{k + 1}"
HUMANOID = ["Hips", "Spine", "Head", "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot",
            "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand"]


def key(name):
    n = name.split(":")[-1]
    n = re.sub(r"^(DEF|ORG|MCH)[-_.]", "", n)
    return "".join(ch for ch in n.lower() if ch.isalnum())


def _sides(table):
    """Expands {"{s}name": canon with {S}} for both sides, in the spellings rigs use (left/l prefix, .l/_l suffix)."""
    out = {}
    for k, v in table.items():
        if "{s}" not in k and "{S}" not in v:
            out[k] = v
            continue
        for S, longs, shorts in (("Left", "left", "l"), ("Right", "right", "r")):
            canon = v.replace("{S}", S)
            if k.startswith("{s}"):
                rest = k[3:]
                out[longs + rest] = canon
                out[shorts + rest] = canon
            else:
                out[k.replace("{s}", shorts)] = canon
    return out


SCHEMES = {
    "mixamo": {key(c): c for c in CANON},
    "unity": _sides({
        "hips": "Hips", "spine": "Spine", "chest": "Spine1", "upperchest": "Spine2", "neck": "Neck", "head": "Head",
        "{s}shoulder": "{S}Shoulder", "{s}upperarm": "{S}Arm", "{s}lowerarm": "{S}ForeArm", "{s}hand": "{S}Hand",
        "{s}upperleg": "{S}UpLeg", "{s}lowerleg": "{S}Leg", "{s}foot": "{S}Foot", "{s}toes": "{S}ToeBase",
        **{f"{{s}}{f.lower() if f != 'Pinky' else 'little'}{p}": f"{{S}}Hand{f}{k}"
           for f in FINGERS for k, p in ((1, "proximal"), (2, "intermediate"), (3, "distal"))},
    }),
    "unreal": _sides({
        "pelvis": "Hips", "spine01": "Spine", "spine02": "Spine1", "spine03": "Spine2", "neck01": "Neck", "head": "Head",
        "clavicle{s}": "{S}Shoulder", "upperarm{s}": "{S}Arm", "lowerarm{s}": "{S}ForeArm", "hand{s}": "{S}Hand",
        "thigh{s}": "{S}UpLeg", "calf{s}": "{S}Leg", "foot{s}": "{S}Foot", "ball{s}": "{S}ToeBase",
        **{f"{f.lower()}0{k}{{s}}": f"{{S}}Hand{f}{k}" for f in FINGERS for k in (1, 2, 3)},
    }),
    # hips/neck/head are the names Quaternius uses (DEF-hips, DEF-neck, DEF-head) on the same DEF- chain.
    # A classic Rigify rig has spine / spine.004 / spine.006 instead, and no separate hips bone, so those still win.
    "rigify": _sides({
        "spine": "Hips", "hips": "Hips", "spine001": "Spine", "spine002": "Spine1", "spine003": "Spine2",
        "spine004": "Neck", "neck": "Neck", "spine006": "Head", "head": "Head",
        "shoulder{s}": "{S}Shoulder", "upperarm{s}": "{S}Arm", "forearm{s}": "{S}ForeArm",
        "hand{s}": "{S}Hand", "thigh{s}": "{S}UpLeg", "shin{s}": "{S}Leg", "foot{s}": "{S}Foot", "toe{s}": "{S}ToeBase",
        **{f"thumb0{k}{{s}}": f"{{S}}HandThumb{k}" for k in (1, 2, 3)},
        **{f"f{f.lower()}0{k}{{s}}": f"{{S}}Hand{f}{k}" for f in FINGERS[1:] for k in (1, 2, 3)},
    }),
    # SMPL / SMPL-H / AMASS BVH: "shoulder" is the upper arm, "collar" the clavicle. Not Kimodo's SOMA skeleton.
    "smpl": _sides({
        "pelvis": "Hips", "spine1": "Spine", "spine2": "Spine1", "spine3": "Spine2", "neck": "Neck", "head": "Head",
        "{s}hip": "{S}UpLeg", "{s}knee": "{S}Leg", "{s}ankle": "{S}Foot", "{s}foot": "{S}ToeBase",
        "{s}collar": "{S}Shoulder", "{s}shoulder": "{S}Arm", "{s}elbow": "{S}ForeArm", "{s}wrist": "{S}Hand",
    }),
    # Kimodo's somaskel77 (motion.from-text). Mixamo-like names, but Spine1 is the first spine and LeftLeg is the thigh.
    "soma": _sides({
        "hips": "Hips", "spine1": "Spine", "spine2": "Spine1", "chest": "Spine2", "neck1": "Neck", "head": "Head",
        "{s}shoulder": "{S}Shoulder", "{s}arm": "{S}Arm", "{s}forearm": "{S}ForeArm", "{s}hand": "{S}Hand",
        "{s}leg": "{S}UpLeg", "{s}shin": "{S}Leg", "{s}foot": "{S}Foot", "{s}toebase": "{S}ToeBase",
        **{f"{{s}}hand{f.lower()}{k}": f"{{S}}Hand{f}{k}" for f in FINGERS for k in (1, 2, 3, 4)},
    }),
    # Classic BVH mocap names (Biovision, MotionBuilder exports): collar, shoulder, elbow, wrist; hip, knee, ankle.
    "bvh": _sides({
        "hips": "Hips", "abdomen": "Spine", "chest": "Spine1", "chest2": "Spine2", "neck": "Neck", "head": "Head",
        "{s}collar": "{S}Shoulder", "{s}shoulder": "{S}Arm", "{s}elbow": "{S}ForeArm", "{s}wrist": "{S}Hand",
        "{s}hip": "{S}UpLeg", "{s}knee": "{S}Leg", "{s}ankle": "{S}Foot", "{s}toe": "{S}ToeBase",
    }),
}


def canon_map(arm, scheme="auto", extra=None):
    """Canonical name -> this rig's bone, by the scheme that matches most of its bones (or the one given), plus any
    explicit {bone: canonical} pairs."""
    keys = {key(b.name): b.name for b in arm.data.bones}
    if scheme in (None, "", "auto"):
        best = max(SCHEMES, key=lambda s: sum(1 for k in keys if k in SCHEMES[s]))
    elif scheme in SCHEMES:
        best = scheme
    else:
        fail(f"unknown bone names {scheme!r} (auto, {', '.join(SCHEMES)})")
    out = {}
    for k, bone in keys.items():
        c = SCHEMES[best].get(k)
        if c and c not in out:
            out[c] = bone
    for bone, c in (extra or {}).items():
        if bone not in arm.data.bones:
            fail(f"map: no bone {bone!r} in {arm.name}")
        if c not in CANON:
            fail(f"map: {c!r} isn't a bone name this tool knows (Mixamo names without the prefix: Hips, LeftArm, ...)")
        out = {k: v for k, v in out.items() if v != bone}
        out[c] = bone
    return out, best


# ---------------------------------------------------------------- the character

CHAR = {
    "arm": None, "meshes": [], "props": [], "high": [], "map": {}, "scheme": None, "bones": [], "height": None,
    "parts": [],  # [{name, center, triangles}] after split
    "template": None,  # spider | quadarm | biped | chain
    "roles": [],  # per bone, same order as bones (for procedural clips)
}
CLIPS = {}  # name -> {"rot": (F, B, 4), "loc": (F, B, 3), "source": str}


def need_arm(what):
    if not CHAR["arm"]:
        fail(f"{what}: the character has no skeleton (rig it with mesh.rig first, or import a rigged file)")
    return CHAR["arm"]


def bone_index(name, what):
    """A bone by its canonical name (LeftHand) or its own (mixamorig7:LeftHand)."""
    bones = CHAR["bones"]
    if name in CHAR["map"]:
        return bones.index(CHAR["map"][name])
    if name in bones:
        return bones.index(name)
    k = key(name)
    for i, b in enumerate(bones):
        if key(b) == k:
            return i
    fail(f"{what}: no bone {name!r} (bones: {', '.join(sorted(CHAR['map']))[:400]})")


def rest_data(arm):
    """Per bone (in CHAR["bones"] order): rest matrix in armature space, parent index, and an order parents-first."""
    bones = [arm.data.bones[n] for n in CHAR["bones"]]
    idx = {b.name: i for i, b in enumerate(bones)}
    ml = [b.matrix_local.copy() for b in bones]
    par = [idx[b.parent.name] if b.parent else -1 for b in bones]
    rel = [(ml[par[i]].inverted() @ ml[i]) if par[i] >= 0 else ml[i] for i in range(len(bones))]
    order, seen = [], set()

    def visit(i):
        if i in seen:
            return
        if par[i] >= 0:
            visit(par[i])
        seen.add(i)
        order.append(i)

    for i in range(len(bones)):
        visit(i)
    return {"ml": ml, "par": par, "rel": rel, "order": order}


def fk(rest, rot, loc):
    """Posed armature-space matrices for one frame from the bones' rotations and locations relative to their rest."""
    P = [None] * len(rest["ml"])
    for i in rest["order"]:
        q = rot[i]
        basis = M.Translation(V(loc[i])) @ Q((q[0], q[1], q[2], q[3])).to_matrix().to_4x4()
        P[i] = (P[rest["par"][i]] @ rest["rel"][i] if rest["par"][i] >= 0 else rest["rel"][i]) @ basis
    return P


def solve(rest, want_rot, root=None, root_pos=None):
    """The rotations and locations (relative to rest) that give each bone in want_rot that armature-space rotation,
    and `root` its head at root_pos. Bones without a wanted rotation keep their rest relation to their parent."""
    n = len(rest["ml"])
    rot = np.zeros((n, 4))
    rot[:, 0] = 1
    loc = np.zeros((n, 3))
    P = [None] * n
    for i in rest["order"]:
        A = P[rest["par"][i]] @ rest["rel"][i] if rest["par"][i] >= 0 else rest["rel"][i]
        l = V((0, 0, 0))
        if i == root and root_pos is not None:
            l = A.inverted() @ V(root_pos)
        q = Q()
        if i in want_rot:
            q = (A.to_quaternion().inverted() @ want_rot[i]).normalized()
        rot[i] = (q.w, q.x, q.y, q.z)
        loc[i] = tuple(l)
        P[i] = A @ M.Translation(l) @ q.to_matrix().to_4x4()
    return rot, loc


def hips_index():
    if "Hips" in CHAR["map"]:
        return CHAR["bones"].index(CHAR["map"]["Hips"])
    arm = CHAR["arm"]
    roots = [b for b in arm.data.bones if not b.parent]
    return CHAR["bones"].index(roots[0].name) if roots else 0


def assign(obj, act):
    ad = obj.animation_data_create()
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    ad.action = act
    if hasattr(ad, "action_slot") and ad.action_slot is None and len(getattr(act, "slots", [])):
        for s in act.slots:
            if getattr(s, "target_id_type", "OBJECT") == "OBJECT":
                ad.action_slot = s
                break


def bone_action(act):
    try:
        from_layers = [fc for layer in act.layers for strip in layer.strips for cb in strip.channelbags for fc in cb.fcurves]
    except AttributeError:
        from_layers = list(getattr(act, "fcurves", []))
    return any(fc.data_path.startswith("pose.bones[") for fc in from_layers)


def frame_range(act):
    a0, a1 = act.frame_range
    return int(math.floor(a0)), max(int(math.floor(a0)) + 1, int(math.ceil(a1)))


def sample(arm, act):
    """The action's poses on this armature, frame by frame: (rot (F, B, 4), loc (F, B, 3))."""
    assign(arm, act)
    f0, f1 = frame_range(act)
    pbs = [arm.pose.bones[n] for n in CHAR["bones"]]
    rot = np.zeros((f1 - f0 + 1, len(pbs), 4))
    loc = np.zeros((f1 - f0 + 1, len(pbs), 3))
    for k, f in enumerate(range(f0, f1 + 1)):
        scene.frame_set(f)
        for i, pb in enumerate(pbs):
            mb = pb.matrix_basis
            q = mb.to_quaternion()
            rot[k, i] = (q.w, q.x, q.y, q.z)
            loc[k, i] = tuple(mb.translation)
    arm.animation_data.action = None
    return continuous(rot), loc


def continuous(rot):
    """Flips quaternions that took the long way round, so in-betweens stay short."""
    for k in range(1, len(rot)):
        flip = (rot[k] * rot[k - 1]).sum(-1) < 0
        rot[k][flip] *= -1
    return rot


def clip_name(name, used=None):
    name = re.sub(r"[^\w .-]", "", str(name)).strip()[:60] or "Clip"
    base, n = name, 2
    while name in CLIPS or (used and name in used):
        name = f"{base}{n}"
        n += 1
    return name


def action_label(act, path, objs=()):
    """A clip's name: the animation's. FBX imports name actions "<object>|<take>|<layer>" (Mixamo's take is always
    "mixamo.com"), so without those parts; with nothing left, the file's name (not a library file's hash)."""
    skip = {o.name for o in objs} | {"mixamo.com", "take 001", "armatureaction", "action", "scene", ""}
    parts = [x for x in act.name.split("|") if x.lower() not in skip and x not in skip and not re.fullmatch(r"(?i)layer\d+", x)]
    n = parts[-1] if parts else ""
    if not n:
        stem = os.path.splitext(os.path.basename(path))[0]
        n = "" if re.fullmatch(r"(\d+|[0-9a-f]{16,})", stem, re.I) else stem
    return n or "Clip"


def rest_pose(arm, on=True):
    if arm:
        arm.data.pose_position = "REST" if on else "POSE"
        bpy.context.view_layer.update()


def op_import(o):
    if CHAR["meshes"] or CHAR["arm"]:
        fail("import: there is already a character (one import per job; bring clips in with retarget)")
    path = file_arg(o.get("file"), "import")
    if path.lower().endswith(".bvh"):
        fail("import: a .bvh is motion only; import the character, then retarget the .bvh onto it")
    objs, acts = import_file(path)
    arms = [x for x in objs if x.type == "ARMATURE"]
    if len(arms) > 1:
        warn(f"import: {len(arms)} skeletons in the file; using {arms[0].name}")
    arm = arms[0] if arms else None
    meshes = [x for x in objs if x.type == "MESH"]
    if arm:
        # With a rig, keep what it deforms or carries (exports often ship a stray shape).
        meshes = [x for x in meshes if x.parent == arm or any(m.type == "ARMATURE" and m.object == arm for m in x.modifiers)] or meshes
        for x in arms[1:]:
            remove([x])
    if not meshes:
        fail(f"import: {os.path.basename(path)} has no mesh")
    keep = meshes + ([arm] if arm else [])
    for x in keep:
        if x.parent is not None and x.parent not in keep:
            mw = x.matrix_world.copy()
            x.parent = None
            x.matrix_world = mw
    remove([x for x in objs if x not in keep])
    CHAR.update(arm=arm, meshes=meshes)
    got = {"op": "import", "file": os.path.basename(path), "meshes": len(meshes), "rig": arm.name if arm else None}

    # Sample the file's clips before transforms are applied (their locations are in the old units; scaled below).
    sampled = []
    if arm:
        CHAR["bones"] = [b.name for b in arm.data.bones]
        CHAR["map"], CHAR["scheme"] = canon_map(arm, o.get("names") or "auto", o.get("map"))
        if o.get("clips", True):
            for a in [a for a in acts if bone_action(a)]:
                sampled.append((action_label(a, path, objs), *sample(arm, a)))
        ad = arm.animation_data_create()
        for t in list(ad.nla_tracks):
            ad.nla_tracks.remove(t)
        ad.action = None
        for pb in arm.pose.bones:
            pb.matrix_basis = M()
    for a in acts:
        bpy.data.actions.remove(a)

    # Bake the objects' transforms in (Mixamo FBX: rotated 90 degrees, scaled 0.01), so 1 unit = 1 m and the
    # armature's space is the world's.
    unit = arm.matrix_world.to_scale()[0] if arm else 1.0
    everything = ([arm] if arm else []) + meshes
    for x in meshes:
        x.animation_data_clear()
    rest_pose(arm)
    select(everything, arm or meshes[0])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Face front (-Y, the way Mixamo characters face), stand on the ground, centered, at the height asked.
    turn = 0.0
    face = o.get("facing", "auto")
    if face in (None, "auto"):
        if arm and all(k in CHAR["map"] for k in ("LeftUpLeg", "RightUpLeg")):
            left = arm.data.bones[CHAR["map"]["LeftUpLeg"]].head_local - arm.data.bones[CHAR["map"]["RightUpLeg"]].head_local
            if all(k in CHAR["map"] for k in ("LeftArm", "RightArm")):
                left = left + arm.data.bones[CHAR["map"]["LeftArm"]].head_local - arm.data.bones[CHAR["map"]["RightArm"]].head_local
            fwd = left.cross(V((0, 0, 1)))
            if fwd.length > 1e-6:
                turn = -math.pi / 2 - math.atan2(fwd.y, fwd.x)
                # A rig a few degrees off square is just asymmetric: snap to the nearest quarter turn.
                q = round(turn / (math.pi / 2)) * (math.pi / 2)
                if abs(turn - q) < math.radians(10):
                    turn = q
    else:
        turn = -math.radians(float(face))
    lo, hi = mesh_bounds(meshes)
    h = hi.z - lo.z
    if h < 1e-5:
        fail("import: the mesh is flat")
    s = float(o["height"]) / h if o.get("height") else 1.0
    T = M.Diagonal((s, s, s, 1)) @ M.Rotation(turn, 4, "Z") @ M.Translation((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
    for x in everything:
        if x.parent is None:
            x.matrix_world = T @ x.matrix_world
    select(everything, arm or meshes[0])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    rest_pose(arm, False)
    lo, hi = mesh_bounds(meshes)
    CHAR["height"] = hi.z - lo.z
    for name, rot, loc in sampled:
        n = clip_name(name)
        CLIPS[n] = {"rot": rot, "loc": loc * unit * s, "source": os.path.basename(path)}
    got.update(height=round(CHAR["height"], 3), turned=round(math.degrees(turn), 1), scale=round(unit * s, 5),
               triangles=sum(triangles(x) for x in meshes), clips=list(CLIPS), names=CHAR["scheme"],
               bones=len(CHAR["bones"]))
    if arm:
        miss = [c for c in HUMANOID if c not in CHAR["map"]]
        if miss:
            warn(f"import: no bone found for {', '.join(miss)} (name them with map)")
    return got


def need_char(what):
    if not CHAR["meshes"]:
        fail(f"{what}: import the character first")


# ---------------------------------------------------------------- clean, bake

def keep_high():
    """A copy of the meshes as they are now: what bake reads color and detail from after decimation."""
    if CHAR["high"]:
        return
    col = bpy.data.collections.new("hb_high")
    scene.collection.children.link(col)
    for x in CHAR["meshes"]:
        c = x.copy()
        c.data = x.data.copy()
        c.name = f"hb_high_{x.name}"
        col.objects.link(c)
        c.hide_render = True
        CHAR["high"].append(c)


def op_clean(o):
    need_char("clean")
    arm = CHAR["arm"]
    rest_pose(arm)
    keep_high()
    merge = float(o.get("merge", 0.0001))
    budget = int(o.get("triangles", 25000))
    before = sum(triangles(x) for x in CHAR["meshes"])
    merged = 0
    for x in CHAR["meshes"]:
        if x.data.shape_keys:
            warn(f"clean: {x.name} had shape keys (blend shapes); decimating drops them")
            select([x], x)
            x.shape_key_clear()
        bm = bmesh.new()
        bm.from_mesh(x.data)
        n0 = len(bm.verts)
        if merge > 0:
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge)
        merged += n0 - len(bm.verts)
        if o.get("normals", True):
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(x.data)
        bm.free()
        x.data.update()
    now = sum(triangles(x) for x in CHAR["meshes"])
    if budget and now > budget:
        say("step", f"decimating {now} triangles to {budget}")
        for x in CHAR["meshes"]:
            mod = x.modifiers.new("hb_decimate", "DECIMATE")
            mod.decimate_type = "COLLAPSE"
            mod.ratio = budget / now
            mod.use_collapse_triangulate = True
            select([x], x)
            bpy.ops.object.modifier_move_to_index(modifier=mod.name, index=0)
            bpy.ops.object.modifier_apply(modifier=mod.name)
    after = sum(triangles(x) for x in CHAR["meshes"])
    err = silhouette_error()
    rest_pose(arm, False)
    got = {"op": "clean", "trianglesBefore": before, "triangles": after, "merged": merged,
           "silhouette": {"max": round(err[0], 4), "p99": round(err[1], 4)}}
    if CHAR["height"] and err[1] > CHAR["height"] * 0.01:
        warn(f"clean: the surface moved up to {err[1] * 100:.1f} cm (99th percentile) from the original; raise triangles to keep more of the shape")
    return got


def silhouette_error():
    """How far the original's vertices are from the cleaned surface (max and 99th percentile, meters)."""
    if not CHAR["high"]:
        return 0.0, 0.0
    dg = bpy.context.evaluated_depsgraph_get()
    trees = [BVHTree.FromObject(x, dg) for x in CHAR["meshes"]]
    d = []
    for h in CHAR["high"]:
        mw = h.matrix_world
        vs = h.data.vertices
        step = max(1, len(vs) // 20000)
        for k in range(0, len(vs), step):
            p = mw @ vs[k].co
            hits = [t.find_nearest(p) for t in trees]
            d.append(min((x[3] for x in hits if x[0] is not None), default=0.0))
    if not d:
        return 0.0, 0.0
    a = np.array(d)
    return float(a.max()), float(np.percentile(a, 99))


def gpu_setup():
    if SPEC.get("device") == "cpu":
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
            return kind
    scene.cycles.device = "CPU"
    return "CPU"


def join_meshes():
    """The character's meshes as one object (one material set, one UV space: what baking needs)."""
    ms = CHAR["meshes"]
    if len(ms) > 1:
        select(ms, ms[0])
        bpy.ops.object.join()
        CHAR["meshes"] = [bpy.context.view_layer.objects.active]
    CHAR["meshes"][0].name = "Body"
    return CHAR["meshes"][0]


def op_bake(o):
    need_char("bake")
    arm = CHAR["arm"]
    size = max(64, min(2048, int(o.get("size", 2048))))
    maps = o.get("maps") or ["color", "normal"]
    bad = [m for m in maps if m not in ("color", "normal")]
    if bad:
        fail(f"bake: unknown map {bad[0]!r} (color, normal)")
    rest_pose(arm)
    if o.get("high") is not None:
        objs, acts = import_file(file_arg(o["high"], "bake.high"))
        for a in acts:
            bpy.data.actions.remove(a)
        high = [x for x in objs if x.type == "MESH"]
        remove([x for x in objs if x.type != "MESH"])
        for x in high:
            x.hide_render = True
        source = "file"
    else:
        keep_high()
        high = CHAR["high"]
        source = "original" if CHAR["high"] else "self"
    low = join_meshes()

    say("step", "unwrapping (smart UV project)")
    uv = low.data.uv_layers.new(name="baked")
    low.data.uv_layers.active = uv
    select([low], low)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=float(o.get("islandMargin", 0.003)))
    bpy.ops.object.mode_set(mode="OBJECT")

    mat = bpy.data.materials.new("baked")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    low.data.materials.clear()
    low.data.materials.append(mat)
    imgs = {}
    for m in maps:
        img = bpy.data.images.new(f"{low.name}_{m}", size, size, alpha=False)
        if m == "normal":
            img.colorspace_settings.name = "Non-Color"
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        imgs[m] = (img, node)

    scene.render.engine = "CYCLES"
    device = gpu_setup()
    scene.cycles.samples = int(o.get("samples", 8))
    bk = scene.render.bake
    bk.use_selected_to_active = True
    H = CHAR["height"] or 1.8
    bk.cage_extrusion = float(o.get("extrusion", H * 0.01))
    bk.max_ray_distance = float(o.get("distance", H * 0.03))
    bk.margin = int(o.get("margin", 16))
    for x in high:
        x.hide_render = False
        x.hide_set(False)
    for m in maps:
        img, node = imgs[m]
        nt.nodes.active = node
        say("step", f"baking {m} at {size}x{size} ({device})")
        select(list(high) + [low], low)
        if m == "color":
            bk.use_pass_direct = False
            bk.use_pass_indirect = False
            bk.use_pass_color = True
            bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True)
        else:
            bk.normal_space = "TANGENT"
            bpy.ops.object.bake(type="NORMAL", use_selected_to_active=True)
    for x in high:
        x.hide_render = True
    if "color" in imgs:
        nt.links.new(imgs["color"][1].outputs["Color"], bsdf.inputs["Base Color"])
    if "normal" in imgs:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(imgs["normal"][1].outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = float(o.get("roughness", 0.8))
    tex = os.path.join(OUT, "textures")
    os.makedirs(tex, exist_ok=True)
    for m, (img, _) in imgs.items():
        img.filepath_raw = os.path.join(tex, f"{low.name}_{m}.png")
        img.file_format = "PNG"
        img.save()
        img.pack()
    for layer in [u for u in low.data.uv_layers if u.name != "baked"]:
        low.data.uv_layers.remove(layer)
    rest_pose(arm, False)
    return {"op": "bake", "size": size, "maps": maps, "from": source, "device": device}


# ---------------------------------------------------------------- props

def op_attach(o):
    need_char("attach")
    arm = need_arm("attach")
    i = bone_index(str(o.get("bone") or ""), "attach")
    bone = CHAR["bones"][i]
    path = file_arg(o.get("file"), "attach")
    objs, acts = import_file(path)
    for a in acts:
        bpy.data.actions.remove(a)
    meshes = [x for x in objs if x.type == "MESH"]
    remove([x for x in objs if x.type != "MESH"])
    if not meshes:
        fail(f"attach: {os.path.basename(path)} has no mesh")
    for x in meshes:
        mw = x.matrix_world.copy()
        x.parent = None
        x.matrix_world = mw
        for m in list(x.modifiers):
            if m.type == "ARMATURE":
                x.modifiers.remove(m)
    select(meshes, meshes[0])
    if len(meshes) > 1:
        bpy.ops.object.join()
    prop = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    name = str(o.get("name") or os.path.splitext(os.path.basename(path))[0] or "prop")
    prop.name = re.sub(r"[^\w .-]", "", name)[:60] or "prop"
    # Where the prop is held: its own origin (file), or a point of its bounds.
    co = [V(v.co) for v in prop.data.vertices]
    lo = V((min(c.x for c in co), min(c.y for c in co), min(c.z for c in co)))
    hi = V((max(c.x for c in co), max(c.y for c in co), max(c.z for c in co)))
    origin = o.get("origin", "file")
    pivot = {"center": (lo + hi) / 2, "bottom": V(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z)),
             "top": V(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, hi.z))}.get(origin, V((0, 0, 0)))
    prop.data.transform(M.Translation(-pivot))
    if o.get("size"):
        s = float(o["size"]) / max(max(hi - lo), 1e-6)
    else:
        s = float(o.get("scale", 1.0))
    rest_pose(arm)
    head = arm.matrix_world @ arm.data.bones[bone].head_local
    R = (arm.matrix_world.to_quaternion() @ arm.data.bones[bone].matrix_local.to_quaternion()).normalized()
    off = V((list(o.get("offset") or [0, 0, 0]) + [0, 0, 0])[:3])
    rot = mathutils.Euler([math.radians(float(x)) for x in (list(o.get("rotation") or [0, 0, 0]) + [0, 0, 0])[:3]], "XYZ")
    want = M.Translation(head + R @ off) @ (R @ rot.to_quaternion()).to_matrix().to_4x4() @ M.Diagonal((s, s, s, 1))
    prop.parent = arm
    prop.parent_type = "BONE"
    prop.parent_bone = bone
    prop.matrix_parent_inverse = M()
    bpy.context.view_layer.update()
    prop.matrix_world = want
    rest_pose(arm, False)
    CHAR["props"].append(prop)
    return {"op": "attach", "prop": prop.name, "bone": bone, "size": round(max(hi - lo) * s, 3)}


# ---------------------------------------------------------------- retarget

def facing(arm, cmap):
    """The way a skeleton faces in the world at rest (from its hips and shoulders), on the ground plane."""
    W = arm.matrix_world
    left = V((0, 0, 0))
    for a, b in (("LeftUpLeg", "RightUpLeg"), ("LeftArm", "RightArm"), ("LeftShoulder", "RightShoulder")):
        if a in cmap and b in cmap:
            left += W @ arm.data.bones[cmap[a]].head_local - W @ arm.data.bones[cmap[b]].head_local
    f = left.cross(V((0, 0, 1)))
    f.z = 0
    return f.normalized() if f.length > 1e-6 else V((0, -1, 0))


def rest_dir(arm, cmap, c, W):
    """A bone's direction at rest in the world: toward the next joint along the body (its child's head), else its axis."""
    b = arm.data.bones[cmap[c]]
    nxt = CHILD.get(c)
    if nxt in cmap:
        d = W @ arm.data.bones[cmap[nxt]].head_local - W @ b.head_local
        if d.length > 1e-6:
            return d.normalized()
    return (W.to_quaternion() @ b.matrix_local.to_quaternion() @ V((0, 1, 0))).normalized()


def ground_height(arm, W):
    return min((W @ b.head_local).z for b in arm.data.bones)


def op_retarget(o):
    need_char("retarget")
    arm = need_arm("retarget")
    refs = o.get("file")
    if refs == "*":
        used = {int(x["file"]) for x in SPEC["ops"] if x.get("op") in ("import", "attach") and str(x.get("file", "")).isdigit()}
        used |= {int(x["high"]) for x in SPEC["ops"] if x.get("op") == "bake" and x.get("high") is not None}
        refs = [i for i in range(len(FILES)) if i not in used]
    elif not isinstance(refs, list):
        refs = [refs]
    if not refs:
        if o.get("file") == "*":
            warn("retarget: no clip files besides the character's (nothing to retarget)")
            return {"op": "retarget", "clips": []}
        fail("retarget: no clip files")
    made = []
    for ref in refs:
        made += retarget_file(o, file_arg(ref, "retarget"), len(refs) > 1)
    return {"op": "retarget", "clips": made}


def retarget_file(o, path, several):
    arm = CHAR["arm"]
    objs, acts = import_file(path)
    srcs = [x for x in objs if x.type == "ARMATURE"]
    if not srcs:
        remove(objs)
        fail(f"retarget: {os.path.basename(path)} has no skeleton")
    src = srcs[0]
    acts_b = [a for a in acts if bone_action(a)]
    want = o.get("action")
    if want:
        pick = [a for a in acts_b if a.name == want or a.name.split("|")[-1] == want or (len(a.name.split("|")) > 1 and a.name.split("|")[1] == want)]
        if not pick:
            fail(f"retarget: no animation {want!r} in {os.path.basename(path)}; it has {sorted(a.name for a in acts_b)}")
        acts_b = pick[:1]
    if not acts_b:
        fail(f"retarget: {os.path.basename(path)} has no animation")
    smap, scheme = canon_map(src, o.get("from") or "auto", o.get("map"))
    pairs = {c: smap[c] for c in CHAR["map"] if c in smap}
    if "Hips" not in pairs:
        fail(f"retarget: no hips in {os.path.basename(path)} ({scheme} names matched {sorted(smap)[:12]}); say which bone is which with map")
    rest = rest_data(arm)
    W = src.matrix_world.copy()
    Wq = W.to_quaternion()
    # Turn the source to face the way the character faces.
    fs, ft = facing(src, smap), facing(arm, CHAR["map"])
    Ry = Q(V((0, 0, 1)), math.atan2(fs.x * ft.y - fs.y * ft.x, fs.x * ft.x + fs.y * ft.y))
    tidx = {c: CHAR["bones"].index(CHAR["map"][c]) for c in pairs}
    Wt = arm.matrix_world  # identity after import, kept for clarity
    align = {}
    for c, sname in pairs.items():
        sb = src.data.bones[sname]
        qs0 = (Ry @ Wq @ sb.matrix_local.to_quaternion()).normalized()
        qt0 = (Wt.to_quaternion() @ arm.data.bones[CHAR["map"][c]].matrix_local.to_quaternion()).normalized()
        ds = Ry @ rest_dir(src, smap, c, W)
        dt = rest_dir(arm, CHAR["map"], c, Wt)
        # The character's rest rotation, swung so the bone points where the source's does at rest: then the source's
        # motion from its rest applies as is (a T-pose clip on an A-pose rig).
        align[c] = (qs0.inverted(), dt.rotation_difference(ds) @ qt0)
    s_hip0 = Ry @ (W @ src.data.bones[pairs["Hips"]].head_local)
    t_hip0 = arm.data.bones[CHAR["map"]["Hips"]].head_local.copy()
    sh = s_hip0.z - ground_height(src, W)
    scale = float(o["scale"]) if o.get("scale") else ((t_hip0.z - ground_height(arm, Wt)) / sh if sh > 1e-5 else 1.0)
    hip = tidx["Hips"]
    made = []
    for act in acts_b:
        one = o.get("name") and not several and len(acts_b) == 1
        name = clip_name(o["name"] if one else action_label(act, path, objs))
        say("step", f"retargeting {name} ({len(pairs)} bones, {scheme} names)")
        assign(src, act)
        f0, f1 = frame_range(act)
        rots, locs = [], []
        for f in range(f0, f1 + 1):
            scene.frame_set(f)
            want_rot = {}
            for c, (qs0i, qt0s) in align.items():
                qs = Ry @ Wq @ src.pose.bones[pairs[c]].matrix.to_quaternion()
                want_rot[tidx[c]] = Wt.to_quaternion().inverted() @ (qs @ qs0i @ qt0s)
            hp = Ry @ (W @ src.pose.bones[pairs["Hips"]].head)
            d = (hp - s_hip0) * scale
            if o.get("inPlace"):
                d.x = d.y = 0
            r, l = solve(rest, want_rot, hip, t_hip0 + d)
            rots.append(r)
            locs.append(l)
        CLIPS[name] = {"rot": continuous(np.array(rots)), "loc": np.array(locs), "source": os.path.basename(path)}
        missing = sorted(c for c in CHAR["map"] if c not in pairs and c in HUMANOID)
        got = {"name": name, "file": os.path.basename(path), "action": act.name, "names": scheme, "bones": len(pairs),
               "frames": f1 - f0 + 1, "missing": missing, "scale": round(scale, 4)}
        if missing:
            warn(f"retarget {name}: no source bone for {', '.join(missing)} (they hold their rest pose)")
        say("clip", json.dumps(got))
        made.append(got)
    remove(objs)
    for a in acts:
        bpy.data.actions.remove(a)
    return made


# ---------------------------------------------------------------- clip edits

def get_clip(name, what):
    if name not in CLIPS:
        fail(f"{what}: no clip {name!r} (clips: {', '.join(CLIPS) or 'none'})")
    return CLIPS[name]


def slerp(q0, q1, t):
    """Per-bone quaternion slerp between (B, 4) arrays; t a number or (B,) array."""
    t = np.broadcast_to(np.asarray(t, dtype=float), (q0.shape[0],))[:, None]
    d = (q0 * q1).sum(-1, keepdims=True)
    q1 = np.where(d < 0, -q1, q1)
    d = np.abs(d)
    out = np.empty_like(q0)
    near = (d > 0.9995)[:, 0]
    out[near] = q0[near] + (q1[near] - q0[near]) * t[near]
    far = ~near
    if far.any():
        th = np.arccos(np.clip(d[far], -1, 1))
        s = np.sin(th)
        out[far] = (np.sin((1 - t[far]) * th) * q0[far] + np.sin(t[far] * th) * q1[far]) / s
    return out / np.linalg.norm(out, axis=-1, keepdims=True)


def resample(clip, n):
    """The clip at n frames, in-betweens interpolated (slerp, lerp)."""
    F = len(clip["rot"])
    rot = np.zeros((n,) + clip["rot"].shape[1:])
    loc = np.zeros((n,) + clip["loc"].shape[1:])
    for k in range(n):
        t = k * (F - 1) / max(1, n - 1)
        a = int(math.floor(t))
        b = min(F - 1, a + 1)
        w = t - a
        rot[k] = slerp(clip["rot"][a], clip["rot"][b], w)
        loc[k] = clip["loc"][a] * (1 - w) + clip["loc"][b] * w
    return {"rot": continuous(rot), "loc": loc, "source": clip.get("source")}


def hips_track(clip):
    """The hips' head in armature (= world) space, per frame."""
    rest = rest_data(CHAR["arm"])
    h = hips_index()
    return rest, h, np.array([list(fk(rest, r, l)[h].translation) for r, l in zip(clip["rot"], clip["loc"])])


def set_hips(clip, rest, h, pos):
    """Moves the hips' head to pos (per frame), keeping every rotation."""
    for k in range(len(pos)):
        P = fk(rest, clip["rot"][k], clip["loc"][k])
        par = rest["par"][h]
        A = P[par] @ rest["rel"][h] if par >= 0 else rest["rel"][h]
        clip["loc"][k, h] = tuple(A.inverted() @ V(pos[k]))


def ease(t):
    return t * t * (3 - 2 * t)


def edit_trim(c, o):
    F = len(c["rot"])
    a = max(1, int(o.get("start", 1)))
    b = min(F, int(o.get("end", F)))
    if b <= a:
        fail(f"trim: end ({b}) must come after start ({a}); the clip has {F} frames")
    return {"rot": c["rot"][a - 1:b].copy(), "loc": c["loc"][a - 1:b].copy(), "source": c.get("source")}


def edit_reverse(c, o):
    return {"rot": c["rot"][::-1].copy(), "loc": c["loc"][::-1].copy(), "source": c.get("source")}


def edit_speed(c, o):
    f = float(o.get("factor", 1))
    if not 0.05 <= f <= 20:
        fail("speed: factor must be between 0.05 and 20")
    F = len(c["rot"])
    return resample(c, max(2, int(round((F - 1) / f)) + 1))


def edit_loop(c, o):
    """A seamless loop: the last `blend` frames cross-fade into the first ones, and the clip starts after them, so the
    last frame leads straight into the first. Root travel carries over (the loop's start is shifted to its end)."""
    F = len(c["rot"])
    N = int(o.get("blend", min(8, F // 4)))
    if N < 1 or N > F // 2:
        fail(f"loop: blend must be 1 to {F // 2} frames for this {F}-frame clip")
    rest, h, hp = hips_track(c)
    shift = hp[F - N] - hp[0]
    shift[2] = 0
    rot = c["rot"].copy()
    pos = hp.copy()
    for k in range(N):
        i = F - N + k
        w = ease((k + 1) / (N + 1))
        rot[i] = slerp(c["rot"][i], c["rot"][k], w)
        pos[i] = hp[i] * (1 - w) + (hp[k] + shift) * w
    out = {"rot": continuous(rot[N:].copy()), "loc": c["loc"][N:].copy(), "source": c.get("source")}
    set_hips(out, rest, h, pos[N:])
    return out


def edit_inplace(c, o):
    """Takes the walk out of a clip: the hips' straight-line travel on the ground (travel, the default; sway stays),
    or all ground movement (lock)."""
    rest, h, hp = hips_track(c)
    F = len(hp)
    pos = hp.copy()
    if o.get("mode", "travel") == "lock":
        pos[:, 0] = hp[0, 0]
        pos[:, 1] = hp[0, 1]
    else:
        for k in range(F):
            t = k / max(1, F - 1)
            pos[k, :2] = hp[k, :2] - (hp[-1, :2] - hp[0, :2]) * t
    out = {"rot": c["rot"].copy(), "loc": c["loc"].copy(), "source": c.get("source")}
    set_hips(out, rest, h, pos)
    out["removed"] = round(float(np.linalg.norm(hp[-1, :2] - hp[0, :2])), 3)
    return out


def partner_names():
    """Each bone's mirror twin (by canonical name, else by its own left/right spelling), or itself."""
    bones = CHAR["bones"]
    inv = {v: k for k, v in CHAR["map"].items()}
    out = []
    for b in bones:
        c = inv.get(b)
        twin = None
        if c:
            tc = c.replace("Left", "\0").replace("Right", "Left").replace("\0", "Right")
            twin = CHAR["map"].get(tc)
        if not twin:
            for a, z in ((r"Left", "Right"), (r"Right", "Left"), (r"(?<=[._])L$", "R"), (r"(?<=[._])R$", "L"),
                         (r"(?<=[._])l$", "r"), (r"(?<=[._])r$", "l"), (r"^L(?=[._])", "R"), (r"^R(?=[._])", "L")):
                if re.search(a, b):
                    cand = re.sub(a, z, b, count=1)
                    if cand in bones:
                        twin = cand
                        break
        out.append(bones.index(twin) if twin else bones.index(b))
    return out


def edit_mirror(c, o):
    """Left and right swapped, as in a mirror (a right-hand swing becomes a left-hand one)."""
    arm = CHAR["arm"]
    rest = rest_data(arm)
    twin = partner_names()
    m = CHAR["map"]
    if "LeftUpLeg" in m and "RightUpLeg" in m:
        n = arm.data.bones[m["LeftUpLeg"]].head_local - arm.data.bones[m["RightUpLeg"]].head_local
        center = (arm.data.bones[m["LeftUpLeg"]].head_local + arm.data.bones[m["RightUpLeg"]].head_local) / 2
    else:
        n, center = V((1, 0, 0)), V((0, 0, 0))
    n.normalize()
    S = M.Identity(3) - 2 * M((tuple(n * n.x), tuple(n * n.y), tuple(n * n.z)))
    restq = [x.to_quaternion() for x in rest["ml"]]
    h = hips_index()
    rots, locs = [], []
    for r, l in zip(c["rot"], c["loc"]):
        P = fk(rest, r, l)
        want = {}
        for i, j in enumerate(twin):
            delta = P[i].to_3x3().normalized() @ restq[i].to_matrix().inverted()
            want[j] = ((S @ delta @ S) @ restq[j].to_matrix()).to_quaternion()
        hp = P[h].translation
        pos = center + S @ (hp - center)
        rr, ll = solve(rest, want, h, pos)
        rots.append(rr)
        locs.append(ll)
    return {"rot": continuous(np.array(rots)), "loc": np.array(locs), "source": c.get("source")}


def edit_pose(c, o):
    """Sets (or adds to) bone rotations at a frame: Euler XYZ degrees in each bone's own axes, relative to its rest
    (Blender's pose-mode numbers), or {"quat": [w, x, y, z]}; eased over `ease` frames each side."""
    bones = o.get("bones") or {}
    if not isinstance(bones, dict) or not bones:
        fail("pose: bones must be { bone: [x, y, z] degrees, ... }")
    if c is None:
        n = int(o.get("length", 1))
        B = len(CHAR["bones"])
        rot = np.zeros((n, B, 4))
        rot[..., 0] = 1
        c = {"rot": rot, "loc": np.zeros((n, B, 3)), "source": "pose"}
    else:
        c = {"rot": c["rot"].copy(), "loc": c["loc"].copy(), "source": c.get("source")}
    F = len(c["rot"])
    frames = o.get("frames") or [o.get("frame", 1)]
    E = int(o.get("ease", 0))
    mode = o.get("mode", "set")
    for bname, v in bones.items():
        i = bone_index(bname, "pose")
        if isinstance(v, dict) and "quat" in v:
            q = Q([float(x) for x in v["quat"]]).normalized()
        elif isinstance(v, (list, tuple)) and len(v) == 3:
            q = mathutils.Euler([math.radians(float(x)) for x in v], "XYZ").to_quaternion()
        else:
            fail(f"pose: {bname} needs [x, y, z] degrees or {{\"quat\": [w, x, y, z]}}")
        for f in frames:
            f = int(f)
            if not 1 <= f <= F:
                fail(f"pose: frame {f} is outside the clip (1 to {F}); give length to make a new clip that long")
            for k in range(max(1, f - E), min(F, f + E) + 1):
                w = 1.0 if k == f else ease(1 - abs(k - f) / (E + 1))
                old = Q(c["rot"][k - 1, i])
                new = (old @ q) if mode == "add" else q
                nq = old.slerp(new, w)
                c["rot"][k - 1, i] = (nq.w, nq.x, nq.y, nq.z)
    c["rot"] = continuous(c["rot"])
    return c


EDITS = {"trim": edit_trim, "reverse": edit_reverse, "speed": edit_speed, "loop": edit_loop, "inplace": edit_inplace,
         "mirror": edit_mirror}


def op_edit(o):
    need_arm(o["op"])
    names = list(CLIPS) if o.get("clip") == "*" else [o.get("clip")]
    if o.get("clip") == "*" and o.get("as"):
        fail(f"{o['op']}: as needs one clip, not *")
    got = {"op": o["op"], "clips": []}
    for n in names:
        c = get_clip(n, o["op"])
        out = EDITS[o["op"]](c, o)
        dest = clip_name(o["as"]) if o.get("as") else n
        extra = {k: out.pop(k) for k in ("removed",) if k in out}
        CLIPS[dest] = out
        got["clips"].append({"name": dest, "frames": len(out["rot"]), **extra})
    return got


def op_pose(o):
    need_arm("pose")
    n = o.get("clip")
    if not n:
        fail("pose: give the clip (an existing one, or a new name with length)")
    c = CLIPS.get(n)
    if c is None and not o.get("length"):
        fail(f"pose: no clip {n!r}; to start a new one from the rest pose, give length (frames)")
    out = edit_pose(c, o)
    dest = clip_name(o["as"]) if o.get("as") else n
    CLIPS[dest] = out
    return {"op": "pose", "clip": dest, "frames": len(out["rot"]), "bones": list((o.get("bones") or {}).keys())}


def op_concat(o):
    need_arm("concat")
    names = o.get("clips") or []
    if len(names) < 2:
        fail("concat: give at least two clips")
    N = int(o.get("blend", 0))
    rest = rest_data(CHAR["arm"])
    h = hips_index()
    out = None
    for n in names:
        c = get_clip(n, "concat")
        c = {"rot": c["rot"].copy(), "loc": c["loc"].copy()}
        if out is None:
            out = c
            continue
        # The next clip starts where the last one ended on the ground.
        _, _, a = hips_track(out)
        _, _, b = hips_track(c)
        d = a[-1] - b[0]
        d[2] = 0
        set_hips(c, rest, h, b + d)
        if N:
            # The last N frames of what we have cross-fade into the next clip's first N.
            if N >= min(len(out["rot"]), len(c["rot"])):
                fail(f"concat: blend ({N}) must be shorter than each clip")
            _, _, a = hips_track(out)
            _, _, b = hips_track(c)
            tail = {"rot": out["rot"][-N:].copy(), "loc": out["loc"][-N:].copy()}
            pos = a[-N:].copy()
            for k in range(N):
                w = ease((k + 1) / (N + 1))
                tail["rot"][k] = slerp(out["rot"][-N + k], c["rot"][k], w)
                pos[k] = a[-N + k] * (1 - w) + b[k] * w
            set_hips(tail, rest, h, pos)
            out["rot"][-N:], out["loc"][-N:] = tail["rot"], tail["loc"]
            c = {"rot": c["rot"][N:], "loc": c["loc"][N:]}
        out = {"rot": continuous(np.concatenate([out["rot"], c["rot"]])), "loc": np.concatenate([out["loc"], c["loc"]])}
    name = clip_name(o.get("name") or "+".join(names))
    out["source"] = "concat"
    CLIPS[name] = out
    return {"op": "concat", "clip": name, "frames": len(out["rot"])}


def op_copy(o):
    c = get_clip(o.get("clip"), "copy")
    name = clip_name(o.get("name") or f"{o.get('clip')} copy")
    CLIPS[name] = {"rot": c["rot"].copy(), "loc": c["loc"].copy(), "source": c.get("source")}
    return {"op": "copy", "clip": name}


def op_rename(o):
    c = get_clip(o.get("clip"), "rename")
    name = str(o.get("name") or "")
    if not name:
        fail("rename: give the new name")
    del CLIPS[o["clip"]]
    name = clip_name(name)
    CLIPS[name] = c
    return {"op": "rename", "clip": name}


def op_remove(o):
    names = o.get("clips") or [o.get("clip")]
    for n in names:
        get_clip(n, "remove")
        del CLIPS[n]
    return {"op": "remove", "clips": names}


# ---------------------------------------------------------------- writing clips, exporting

def write_clips(names, bone_names):
    """Each clip as an action on its own NLA track (unmuted: the exporters take one track or strip at a time)."""
    arm = CHAR["arm"]
    ad = arm.animation_data_create()
    ad.action = None
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.matrix_basis = M()
    made = []
    for name in names:
        c = CLIPS[name]
        act = bpy.data.actions.new(name)
        ad.action = act  # F-curves are made for the slot the armature uses
        F = len(c["rot"])
        frames = np.arange(1, F + 1, dtype=np.float32)
        moving = set(np.nonzero(np.abs(c["loc"]).max(axis=0).max(axis=1) > 1e-6)[0].tolist())
        for i, b in enumerate(bone_names):
            chans = [("rotation_quaternion", c["rot"][:, i, :])]
            if i in moving:
                chans.append(("location", c["loc"][:, i, :]))
            for prop, vals in chans:
                path = f'pose.bones["{b}"].{prop}'
                for k in range(vals.shape[1]):
                    if hasattr(act, "fcurve_ensure_for_datablock"):
                        fc = act.fcurve_ensure_for_datablock(arm, path, index=k, group_name=b)
                    else:
                        fc = act.fcurves.new(path, index=k, action_group=b)
                    fc.keyframe_points.add(F)
                    co = np.empty(F * 2, dtype=np.float32)
                    co[0::2] = frames
                    co[1::2] = vals[:, k]
                    fc.keyframe_points.foreach_set("co", co)
                    fc.keyframe_points.foreach_set("interpolation", [1] * F)  # LINEAR
                    fc.update()
        slot = getattr(ad, "action_slot", None)
        ad.action = None
        track = ad.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, act)
        strip.name = name
        if slot is not None and hasattr(strip, "action_slot") and strip.action_slot is None:
            strip.action_slot = slot
        made.append(act)
    ad.action = None
    return made


def drop_actions(acts):
    arm = CHAR["arm"]
    if arm and arm.animation_data:
        for t in list(arm.animation_data.nla_tracks):
            arm.animation_data.nla_tracks.remove(t)
        arm.animation_data.action = None
    for a in acts:
        bpy.data.actions.remove(a)


def export_objects():
    return ([CHAR["arm"]] if CHAR["arm"] else []) + CHAR["meshes"] + CHAR["props"]


def which_clips(o):
    names = o.get("clips")
    if names in (None, True, "*"):
        return list(CLIPS)
    if names is False:
        return []
    for n in names:
        get_clip(n, o["op"])
    return list(names)


def export_glb(path, names):
    arm = CHAR["arm"]
    acts = write_clips(names, CHAR["bones"]) if arm and names else []
    select(export_objects(), arm or CHAR["meshes"][0])
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_skins=True,
        export_animations=bool(acts), export_animation_mode="NLA_TRACKS", export_force_sampling=True,
        export_anim_slide_to_zero=True, export_materials="EXPORT", export_apply=False,
    )
    drop_actions(acts)


def op_export(o):
    need_char("export")
    fmt = o.get("format", "glb")
    stem = re.sub(r"[^\w.-]", "", str(o.get("name") or "character"))[:60] or "character"
    names = which_clips(o)
    arm = CHAR["arm"]
    got = {"op": "export", "format": fmt, "clips": names}
    if fmt == "glb":
        path = os.path.join(FILES_OUT, f"{stem}.glb")
        say("step", f"writing {stem}.glb ({len(names)} clips)")
        export_glb(path, names)
    elif fmt == "fbx":
        path = os.path.join(FILES_OUT, f"{stem}.fbx")
        say("step", f"writing {stem}.fbx for Unity ({len(names)} takes)")
        renamed = {}
        bone_mode = o.get("bones", "mixamo")
        if bone_mode in ("keep", "generic", "robot"):
            bone_mode = "keep"
        if arm and bone_mode == "mixamo":
            for c, b in CHAR["map"].items():
                want = f"mixamorig:{c}"
                if b != want and want not in arm.data.bones:
                    arm.data.bones[b].name = want
                    renamed[want] = b
            miss = [c for c in HUMANOID if c not in CHAR["map"]]
            got["humanoid"] = not miss
            if miss:
                warn(f"export fbx: Unity's Humanoid needs {', '.join(miss)}; set the avatar up by hand (or name them with map at import)")
            if CHAR.get("template"):
                warn("export fbx: this is a robot template rig — use bones: \"generic\" (Unity Generic) instead of Mixamo/Humanoid")
        back = {b: want for want, b in renamed.items()}
        names_now = [back.get(b, b) for b in CHAR["bones"]]
        acts = write_clips(names, names_now) if arm and names else []
        select(export_objects(), arm or CHAR["meshes"][0])
        bpy.ops.export_scene.fbx(
            filepath=path, use_selection=True, object_types={"ARMATURE", "MESH", "EMPTY"},
            apply_unit_scale=True, apply_scale_options="FBX_SCALE_ALL", axis_forward="-Z", axis_up="Y",
            use_mesh_modifiers=False, mesh_smooth_type="FACE", add_leaf_bones=False,
            primary_bone_axis="Y", secondary_bone_axis="X", armature_nodetype="NULL",
            bake_anim=bool(acts), bake_anim_use_all_bones=True, bake_anim_use_nla_strips=True,
            bake_anim_use_all_actions=False, bake_anim_force_startend_keying=True, bake_anim_step=1.0,
            bake_anim_simplify_factor=0.0, path_mode="COPY", embed_textures=True,
        )
        drop_actions(acts)
        for want, b in renamed.items():
            arm.data.bones[want].name = b
        got["bones"] = "mixamo" if bone_mode == "mixamo" else "generic"
    elif fmt == "blend":
        path = os.path.join(FILES_OUT, f"{stem}.blend")
        say("step", f"writing {stem}.blend")
        acts = write_clips(names, CHAR["bones"]) if arm and names else []
        for a in acts:
            a.use_fake_user = True
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True)
        drop_actions(acts)
    else:
        fail(f"export: unknown format {fmt!r} (fbx, glb, blend)")
    title = str(o.get("title") or fmt).strip() or fmt
    info["outputs"].append({"file": os.path.basename(path), "title": title, "ext": f".{fmt}"})
    got["file"] = os.path.basename(path)
    return got


# ---------------------------------------------------------------- hard-surface robots (split, template, clips)

def world_verts(meshes):
    """All mesh vertices in world space as (N, 3) float64, plus (obj, local_index) for each."""
    coords, owners = [], []
    for o in meshes:
        mw = o.matrix_world
        for i, v in enumerate(o.data.vertices):
            coords.append(tuple(mw @ v.co))
            owners.append((o, i))
    if not coords:
        return np.zeros((0, 3)), []
    return np.asarray(coords, dtype=np.float64), owners


def separate_by_mask(obj, labels: np.ndarray, names: list[str]):
    """Split one mesh object into one object per label id (names[label]). Returns the new objects."""
    if not len(obj.data.vertices):
        return []
    # Island by face: a face goes with the majority of its verts' labels.
    me = obj.data
    face_lab = []
    for p in me.polygons:
        labs = [int(labels[v]) for v in p.vertices]
        face_lab.append(max(set(labs), key=labs.count))
    made = []
    src_mw = obj.matrix_world.copy()
    for lid, name in enumerate(names):
        faces = [i for i, L in enumerate(face_lab) if L == lid]
        if not faces:
            continue
        new_me = me.copy()
        new_o = bpy.data.objects.new(re.sub(r"[^\w.-]", "_", name)[:50] or f"part{lid}", new_me)
        scene.collection.objects.link(new_o)
        new_o.matrix_world = src_mw
        select([new_o], new_o)
        bpy.ops.object.mode_set(mode="EDIT")
        bm = bmesh.from_edit_mesh(new_me)
        bm.faces.ensure_lookup_table()
        keep = set(faces)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context="FACES")
        bmesh.update_edit_mesh(new_me)
        bpy.ops.object.mode_set(mode="OBJECT")
        # Drop loose verts left behind.
        select([new_o], new_o)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.delete_loose()
        bpy.ops.object.mode_set(mode="OBJECT")
        if len(new_o.data.vertices) == 0:
            remove([new_o])
            continue
        made.append(new_o)
    remove([obj])
    return made


def connected_parts(meshes):
    """Split every mesh into its loose connected pieces; return the new mesh list."""
    out = []
    for o in list(meshes):
        select([o], o)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.separate(type="LOOSE")
        bpy.ops.object.mode_set(mode="OBJECT")
        # separate(LOOSE) leaves the active plus new objects selected.
        parts = [x for x in bpy.context.selected_objects if x.type == "MESH"]
        if not parts:
            parts = [o]
        out.extend(parts)
    return out


def render_angles(size=512):
    """Four orthographic-ish stills (front, right, back, left) for Claude to label parts. Cycles, few samples."""
    need_char("split")
    adir = os.path.join(OUT, "angles")
    os.makedirs(adir, exist_ok=True)
    lo, hi = mesh_bounds(CHAR["meshes"])
    mid = (lo + hi) * 0.5
    H = max(float(hi.z - lo.z), 0.05)
    dist = max(float(hi.x - lo.x), float(hi.y - lo.y), H) * 2.2
    # Save and restore scene render settings.
    prev = (scene.render.engine, scene.render.resolution_x, scene.render.resolution_y,
            scene.cycles.samples if hasattr(scene, "cycles") else None,
            scene.camera)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 2
    scene.cycles.use_denoising = False
    scene.render.resolution_x = scene.render.resolution_y = int(size)
    scene.render.film_transparent = True
    # Lights
    lights = []
    for i, loc in enumerate(((dist, -dist, dist), (-dist, -dist * 0.5, dist * 0.6))):
        L = bpy.data.lights.new(f"hb_ang_L{i}", "AREA")
        L.energy = 200
        Lo = bpy.data.objects.new(f"hb_ang_L{i}", L)
        Lo.location = mid + V(loc) * 0.01 * dist  # noqa: scale via mid offset below
        Lo.location = V(loc) * 0.5 + mid
        scene.collection.objects.link(Lo)
        lights.append(Lo)
    cam_data = bpy.data.cameras.new("hb_ang_cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("hb_ang_cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    views = [("front", (0, -1)), ("right", (1, 0)), ("back", (0, 1)), ("left", (-1, 0))]
    files = []
    for name, (dx, dy) in views:
        cam.location = mid + V((dx * dist, dy * dist, H * 0.35))
        direction = mid - cam.location
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(adir, f"{name}.png")
        scene.render.filepath = path
        say("step", f"angle {name}")
        bpy.ops.render.render(write_still=True)
        files.append(os.path.basename(path))
        dest = os.path.join(FILES_OUT, f"angle-{name}.png")
        if os.path.isfile(path):
            import shutil
            shutil.copy2(path, dest)
            info["outputs"].append({"file": f"angle-{name}.png", "title": f"angle/{name}", "ext": ".png"})
    remove([cam] + lights)
    scene.render.engine, scene.render.resolution_x, scene.render.resolution_y, samp, scene.camera = prev
    if samp is not None:
        scene.cycles.samples = samp
    return files


def op_split(o):
    """Split the character mesh into named hard-surface parts.

    by: "connected" (loose pieces) and/or centres from parts: [{name, center:[x,y,z]}] or a template kind guess.
    angles: true writes four stills (front/right/back/left) for Claude to label.
    kind: when set and parts are missing, guess centres for that template (spider, quadarm, biped, chain).
    """
    need_char("split")
    if CHAR["arm"]:
        warn("split: the mesh already has a skeleton; parts are cut from the posed rest mesh")
        rest_pose(CHAR["arm"])
    by = o.get("by", "connected")
    if by not in ("connected", "centers", "both"):
        fail(f"split: by is connected, centers or both (got {by!r})")
    kind = o.get("kind")
    segments = int(o.get("segments", 6))
    R = need_robot("split") if (kind or o.get("parts") or by in ("centers", "both")) else None
    if kind and kind not in R.KINDS:
        fail(f"split: kind is {', '.join(R.KINDS)}")

    meshes = list(CHAR["meshes"])
    # Drop any old armature modifiers before cutting; template will rebind.
    for m in meshes:
        for mod in list(m.modifiers):
            if mod.type == "ARMATURE":
                m.modifiers.remove(mod)

    if by in ("connected", "both"):
        meshes = connected_parts(meshes)
        CHAR["meshes"] = meshes

    # Build centres: explicit parts, else one centre per connected piece, else a template guess on the whole cloud.
    coords, owners = world_verts(meshes)
    centers = {}
    raw_parts = o.get("parts") or []
    if isinstance(raw_parts, dict):
        raw_parts = [{"name": k, "center": v} for k, v in raw_parts.items()]
    roles = R.part_roles(kind, segments) if kind and R else []
    for p in raw_parts:
        if not isinstance(p, dict) or p.get("name") is None or p.get("center") is None:
            fail("split: parts is [{ name, center: [x,y,z] }, ...]")
        name = str(p["name"])
        if roles:
            mapped = R.match_part(name, roles)
            if mapped:
                name = mapped
        c = p["center"]
        if not (isinstance(c, (list, tuple)) and len(c) == 3):
            fail(f"split: part {name!r} center must be [x,y,z]")
        centers[name] = np.asarray(c, dtype=np.float64)

    if not centers and by == "connected" and len(meshes) > 1:
        for i, m in enumerate(meshes):
            lo, hi = mesh_bounds([m])
            name = roles[i] if roles and i < len(roles) else (m.name if not m.name.startswith("Mesh") else f"part{i + 1}")
            if roles and len(meshes) == len(roles):
                name = roles[i]
            centers[name] = np.asarray(((lo + hi) * 0.5), dtype=np.float64)
        # Rename objects to match.
        for m, name in zip(meshes, centers):
            m.name = re.sub(r"[^\w.-]", "_", name)[:50]

    if not centers and kind:
        centers = R.guess_centers(coords, kind, segments)
        by = "centers"

    if centers and (by in ("centers", "both") or len(meshes) == 1):
        names = list(centers)
        # Assign every vertex across all meshes, then split each mesh.
        # Build a global label array aligned with world_verts order.
        labels = R.assign_vertices(coords, centers)
        # Per-object local labels.
        new_meshes = []
        cursor = 0
        for m in list(meshes):
            n = len(m.data.vertices)
            local = labels[cursor:cursor + n]
            cursor += n
            # If the object is already a single part, just rename.
            used = sorted(set(int(x) for x in local))
            if len(used) <= 1:
                lid = used[0] if used else 0
                m.name = re.sub(r"[^\w.-]", "_", names[lid])[:50]
                new_meshes.append(m)
                continue
            new_meshes.extend(separate_by_mask(m, local, names))
        CHAR["meshes"] = new_meshes
        meshes = new_meshes

    # Record part stats.
    parts = []
    for m in CHAR["meshes"]:
        lo, hi = mesh_bounds([m])
        mid = (lo + hi) * 0.5
        parts.append({
            "name": m.name, "center": [round(float(x), 4) for x in mid],
            "size": [round(float(x), 4) for x in (hi - lo)],
            "triangles": triangles(m),
        })
    CHAR["parts"] = parts
    if kind:
        CHAR["template"] = kind

    got = {"op": "split", "by": by, "parts": parts, "kind": kind}
    if o.get("angles"):
        got["angles"] = render_angles(int(o.get("size", 512)))
    # Stand on ground again after cuts (origins may have drifted).
    lo, hi = mesh_bounds(CHAR["meshes"])
    CHAR["height"] = float(hi.z - lo.z)
    got["height"] = round(CHAR["height"], 3)
    return got


def op_template(o):
    """Fit a robot template skeleton to the parts and bind each part rigidly (smooth only at seams)."""
    need_char("template")
    R = need_robot("template")
    kind = o.get("kind") or CHAR.get("template")
    if kind not in R.KINDS:
        fail(f"template: kind is required ({', '.join(R.KINDS)})")
    segments = int(o.get("segments", 6))
    smooth = float(o.get("smooth", 0.02))
    if CHAR["arm"]:
        # Drop the old humanoid / SkinTokens rig; this op replaces it.
        old = CHAR["arm"]
        for m in CHAR["meshes"]:
            for mod in list(m.modifiers):
                if mod.type == "ARMATURE":
                    m.modifiers.remove(mod)
            while m.vertex_groups:
                m.vertex_groups.remove(m.vertex_groups[0])
            if m.parent == old:
                mw = m.matrix_world.copy()
                m.parent = None
                m.matrix_world = mw
        remove([old])
        CHAR["arm"] = None
        CLIPS.clear()

    # Centres from current part objects (preferred) or a guess.
    centers = {}
    roles = R.part_roles(kind, segments)
    if CHAR["parts"]:
        for p in CHAR["parts"]:
            mapped = R.match_part(p["name"], roles) or p["name"]
            centers[mapped] = np.asarray(p["center"], dtype=np.float64)
    for p in (o.get("parts") or []):
        if isinstance(p, dict) and p.get("name") is not None and p.get("center") is not None:
            mapped = R.match_part(str(p["name"]), roles) or str(p["name"])
            centers[mapped] = np.asarray(p["center"], dtype=np.float64)
    coords, _ = world_verts(CHAR["meshes"])
    for r, c in R.guess_centers(coords, kind, segments).items():
        centers.setdefault(r, c)

    # Rename mesh objects toward role names when we can match them.
    for m in CHAR["meshes"]:
        mapped = R.match_part(m.name, roles)
        if mapped:
            m.name = mapped

    placements = R.bone_placements(kind, centers, segments)
    data = bpy.data.armatures.new("Robot")
    arm = bpy.data.objects.new("Robot", data)
    scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    ebs = {}
    for name, parent, head, tail, role in placements:
        b = data.edit_bones.new(name)
        b.head, b.tail = head, tail
        if parent and parent in ebs:
            b.parent = ebs[parent]
            b.use_connect = False
        ebs[name] = b
    bpy.ops.object.mode_set(mode="OBJECT")

    # Bind: each part object → its bone (upper bone for a limb part); seam blend within `smooth` metres.
    bone_for_part = {}
    if kind == "spider":
        bone_for_part = {"body": "Body", **{f"leg{i}": f"Leg{i}" for i in range(1, 7)}}
    elif kind == "quadarm":
        bone_for_part = {
            "body": "Body", "head": "Head",
            "leg_fl": "LegFL", "leg_fr": "LegFR", "leg_bl": "LegBL", "leg_br": "LegBR",
            "arm_l": "ArmL", "arm_r": "ArmR",
        }
    elif kind == "biped":
        bone_for_part = {
            "hips": "Hips", "spine": "Spine", "head": "Head",
            "arm_l": "ArmL", "arm_r": "ArmR", "leg_l": "LegL", "leg_r": "LegR",
        }
    elif kind == "chain":
        bone_for_part = {f"seg{i}": f"Seg{i}" for i in range(segments)}

    # World-space points per part for seam detection.
    part_pts = {}
    for m in CHAR["meshes"]:
        role = R.match_part(m.name, roles) or m.name
        mw = m.matrix_world
        part_pts[role] = np.asarray([tuple(mw @ v.co) for v in m.data.vertices], dtype=np.float64)

    for m in CHAR["meshes"]:
        role = R.match_part(m.name, roles) or m.name
        bone = bone_for_part.get(role, "Body" if "Body" in arm.data.bones else arm.data.bones[0].name)
        while m.vertex_groups:
            m.vertex_groups.remove(m.vertex_groups[0])
        # Ensure a group for every bone (skinning needs them).
        for b in arm.data.bones:
            if b.name not in m.vertex_groups:
                m.vertex_groups.new(name=b.name)
        n = len(m.data.vertices)
        weights = {b.name: np.zeros(n, dtype=np.float32) for b in arm.data.bones}
        weights[bone][:] = 1.0
        if smooth > 0 and len(part_pts) > 1:
            mw = m.matrix_world
            pts = np.asarray([tuple(mw @ v.co) for v in m.data.vertices], dtype=np.float64)
            for other, opts in part_pts.items():
                if other == role or other not in bone_for_part:
                    continue
                ob = bone_for_part[other]
                # Distance from each of this part's verts to the other part's cloud (approximate: nearest of a sample).
                sample = opts if len(opts) <= 400 else opts[np.linspace(0, len(opts) - 1, 400).astype(int)]
                d = np.sqrt(((pts[:, None, :] - sample[None, :, :]) ** 2).sum(-1).min(axis=1))
                blend = np.clip(1.0 - d / smooth, 0.0, 1.0)
                weights[ob] = np.maximum(weights[ob], blend * 0.5)
                weights[bone] = np.maximum(weights[bone] - blend * 0.5, 0.0)
        # Normalize and apply.
        stack = np.stack([weights[b.name] for b in arm.data.bones], axis=1)
        s = stack.sum(axis=1, keepdims=True)
        s[s < 1e-8] = 1.0
        stack = stack / s
        for bi, b in enumerate(arm.data.bones):
            vg = m.vertex_groups[b.name]
            for vi in range(n):
                w = float(stack[vi, bi])
                if w > 1e-4:
                    vg.add([vi], w, "REPLACE")
        mod = m.modifiers.new("Armature", "ARMATURE")
        mod.object = arm
        m.parent = arm
        m.matrix_parent_inverse = arm.matrix_world.inverted()

    CHAR["arm"] = arm
    CHAR["bones"] = [b.name for b in arm.data.bones]
    role_map = {n: r for n, _, _, _, r in placements}
    CHAR["roles"] = [role_map[n] for n in CHAR["bones"]]
    CHAR["map"] = {}  # not Mixamo
    CHAR["scheme"] = f"robot:{kind}"
    CHAR["template"] = kind
    lo, hi = mesh_bounds(CHAR["meshes"])
    CHAR["height"] = float(hi.z - lo.z)
    return {
        "op": "template", "kind": kind, "bones": CHAR["bones"], "roles": CHAR["roles"],
        "height": round(CHAR["height"], 3), "parts": [p["name"] for p in CHAR["parts"]] or [m.name for m in CHAR["meshes"]],
    }


def op_clips(o):
    """Procedural clips for the current robot template: walk/run (tripod|wave), idle, attack, hit, death, jump."""
    need_arm("clips")
    R = need_robot("clips")
    kind = o.get("kind") or CHAR.get("template")
    if kind not in R.KINDS:
        fail(f"clips: need a template first (or pass kind: {', '.join(R.KINDS)})")
    if not CHAR["roles"] or len(CHAR["roles"]) != len(CHAR["bones"]):
        # Recover roles from bone names.
        tree = R.bone_tree(kind, int(o.get("segments", 6)))
        role_map = {n: r for n, _, r in tree}
        CHAR["roles"] = [role_map.get(n, "body") for n in CHAR["bones"]]
    specs = o.get("list")
    if specs is None:
        specs = o.get("clips")
    if specs in (None, True, "*"):
        specs = R.default_clip_list(kind)
    if not isinstance(specs, list) or not specs:
        fail("clips: list is [{ type: walk|run|idle|attack|hit|death|jump, ... }, ...] or omit for the default set")
    made = []
    for spec in specs:
        if isinstance(spec, str):
            spec = {"type": spec}
        if not isinstance(spec, dict) or not spec.get("type"):
            fail("clips: each entry needs type")
        ctype = str(spec["type"]).lower()
        if ctype not in R.CLIP_TYPES:
            fail(f"clips: type is {', '.join(R.CLIP_TYPES)} (got {ctype!r})")
        gait = str(spec.get("gait") or ("tripod" if kind == "spider" else "wave")).lower()
        if gait not in R.GAITS:
            fail(f"clips: gait is {', '.join(R.GAITS)}")
        attack = str(spec.get("attack") or "stab").lower()
        got = R.procedural_clip(
            ctype, kind, CHAR["bones"], CHAR["roles"], FPS,
            gait=gait, attack=attack, seconds=spec.get("seconds"), name=spec.get("name"),
        )
        name = clip_name(got.pop("name"))
        CLIPS[name] = got
        made.append({"name": name, "type": ctype, "frames": len(got["rot"])})
        say("clip", name, ctype, len(got["rot"]))
    return {"op": "clips", "kind": kind, "clips": made}


def op_angles(o):
    """Four stills (front, right, back, left) for judging a mesh without splitting it. Titles angle/front…"""
    need_char("angles")
    files = render_angles(int(o.get("size", 512)))
    return {"op": "angles", "files": files}


# ---------------------------------------------------------------- previews

def op_preview(o):
    """Writes the preview GLB and the shots for hawkes_blender.py: a turntable (rest pose, the camera going once
    around) and a video of each clip (three-quarter view; the camera follows a clip that travels)."""
    need_char("preview")
    names = which_clips(o) if CHAR["arm"] else []
    pdir = os.path.join(OUT, "previews")
    os.makedirs(pdir, exist_ok=True)
    glb = os.path.join(pdir, "preview.glb")
    export_glb(glb, names)
    size = int(o.get("size", 512))
    engine, samples = o.get("engine", "cycles"), int(o.get("samples", 16))
    H = round(CHAR["height"] or 1.8, 3)
    base = {"files": [glb], "width": size, "height": size, "passes": ["beauty"], "engine": engine, "samples": samples,
            "device": SPEC.get("device", "auto")}
    shots = []
    if o.get("turntable", True):
        frames = max(2, int(round(float(o.get("seconds", 6)) * 24)) + 1)
        shots.append(("turntable", 24, frames, {
            "characters": [{"file": 0, "height": H}],
            "camera": {"move": "orbit", "amount": 360, "angle": 180, "distance": 2.6 * H / 1.8}, "lights": "studio"}))
    for n in names:
        c = CLIPS[n]
        _, _, hp = hips_track(c)
        travel = float(np.linalg.norm(hp[-1, :2] - hp[0, :2]))
        frames = min(len(c["rot"]), int(o.get("maxFrames", 300)))
        shots.append((f"preview/{n}", FPS, frames, {
            "characters": [{"file": 0, "animation": n, "height": H, "loop": False}],
            "camera": {"move": "follow" if travel > 0.3 * H else "static", "angle": 35, "distance": 3.2 * H / 1.8},
            "lights": "studio"}))
    for k, (title, fps, frames, shot) in enumerate(shots):
        spec = dict(base, out=os.path.join(pdir, f"{k:02d}"), frames=frames, fps=fps, shot=shot)
        json.dump(spec, open(os.path.join(pdir, f"{k:02d}.json"), "w"), indent=1)
        with open(os.path.join(pdir, f"{k:02d}.args"), "w") as f:
            f.write(f"{fps} {frames}\n")
        info["previews"].append({"file": f"preview-{k:02d}.mp4", "title": title, "ext": ".mp4", "frames": frames, "fps": fps})
        if title == "turntable":
            info["previews"].append({"file": f"preview-{k:02d}.png", "title": "still", "ext": ".png"})
    return {"op": "preview", "videos": [s[0] for s in shots]}


# ---------------------------------------------------------------- repair, symmetry, retopology, LODs, quality report

def _components(bm):
    """The connected pieces of a bmesh, as lists of vertices."""
    bm.verts.index_update()
    seen, comps = set(), []
    for v0 in bm.verts:
        if v0.index in seen:
            continue
        stack, comp = [v0], []
        seen.add(v0.index)
        while stack:
            v = stack.pop()
            comp.append(v)
            for e in v.link_edges:
                w = e.other_vert(v)
                if w.index not in seen:
                    seen.add(w.index)
                    stack.append(w)
        comps.append(comp)
    return comps


def _comp_area(comp):
    return sum(f.calc_area() for f in {f for v in comp for f in v.link_faces})


def mesh_metrics(objs):
    """What makes a generated mesh messy, counted on the meshes as they are now (world space), with a 0-100 score."""
    tris = boundary = nonman = degen = thin = loose = shards = comps = 0
    pts = []
    for o in objs:
        if o.type != "MESH":
            continue
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bm.transform(o.matrix_world)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        tris += len(bm.faces)
        boundary += sum(1 for e in bm.edges if len(e.link_faces) == 1)
        nonman += sum(1 for e in bm.edges if len(e.link_faces) > 2)
        loose += sum(1 for v in bm.verts if not v.link_edges) + sum(1 for e in bm.edges if not e.link_faces)
        for f in bm.faces:
            a = f.calc_area()
            if a < 1e-10:
                degen += 1
            else:
                longest = max(e.calc_length() for e in f.edges)
                if longest * longest / a > 40:
                    thin += 1
        cs = [c for c in _components(bm) if any(v.link_faces for v in c)]
        areas = [_comp_area(c) for c in cs]
        comps += len(cs)
        top = max(areas, default=0)
        shards += sum(1 for a in areas if top and a < 0.02 * top)
        pts += [v.co.copy() for v in bm.verts if v.link_faces]
        bm.free()
    sym = 0.0
    height = 0.0
    if pts:
        from mathutils.kdtree import KDTree
        xs = [p.x for p in pts]
        zs = [p.z for p in pts]
        cx = sorted(xs)[len(xs) // 2]
        height = max(zs) - min(zs)
        step = max(1, len(pts) // 4000)
        kd = KDTree(len(pts))
        for i, p in enumerate(pts):
            kd.insert(p, i)
        kd.balance()
        ds = [kd.find((2 * cx - p.x, p.y, p.z))[2] for p in pts[::step]]
        sym = float(np.mean(ds)) / height if height > 0 else 0.0
    t = max(tris, 1)
    score = 100.0
    score -= min(30, 6 * shards)
    score -= min(20, 400 * boundary / t)
    score -= min(15, 300 * nonman / t)
    score -= min(15, 200 * thin / t)
    score -= min(10, 100 * degen / t)
    score -= min(10, 1000 * sym)
    score = max(0, round(score))
    return {"triangles": tris, "components": comps, "shards": shards, "boundaryEdges": boundary, "nonManifoldEdges": nonman,
            "looseParts": loose, "degenerate": degen, "thin": thin, "asymmetry": round(sym, 4), "height": round(height, 3),
            "score": score, "verdict": "clean" if score >= 80 else "usable" if score >= 60 else "messy"}


def op_report(o):
    need_char("report")
    got = {"op": "report", **mesh_metrics(CHAR["meshes"])}
    info["quality"] = {k: v for k, v in got.items() if k != "op"}
    return got


def op_fix(o):
    """Repair what generated meshes come with: floating shards, doubles, degenerate faces, loose bits, holes, flipped normals."""
    need_char("fix")
    shards = float(o.get("shards", 0.02))
    holes = int(o.get("holes", 32))
    merge = float(o.get("merge", 0.0001))
    smooth = int(o.get("smooth", 0))
    before = mesh_metrics(CHAR["meshes"])
    cut = filled = 0
    for x in CHAR["meshes"]:
        bm = bmesh.new()
        bm.from_mesh(x.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=merge)
        bmesh.ops.dissolve_degenerate(bm, dist=merge, edges=bm.edges[:])
        bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_edges], context="VERTS")
        if shards > 0:
            comps = _components(bm)
            if len(comps) > 1:
                areas = [_comp_area(c) for c in comps]
                top = max(areas)
                gone = [v for c, a in zip(comps, areas) if a < shards * top for v in c]
                cut += sum(1 for a in areas if a < shards * top)
                if gone:
                    bmesh.ops.delete(bm, geom=gone, context="VERTS")
        if holes > 0:
            edges = [e for e in bm.edges if len(e.link_faces) == 1]
            if edges:
                n0 = len(bm.faces)
                left = set(edges)
                while left:
                    loop, stack = set(), [left.pop()]
                    while stack:
                        e = stack.pop()
                        loop.add(e)
                        for v in e.verts:
                            for e2 in v.link_edges:
                                if e2 in left:
                                    left.discard(e2)
                                    stack.append(e2)
                    if len(loop) <= holes:
                        made = bmesh.ops.edgeloop_fill(bm, edges=list(loop))["faces"]
                        bmesh.ops.triangulate(bm, faces=made)
                filled += len(bm.faces) - n0
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        for _ in range(smooth):
            bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        bm.to_mesh(x.data)
        bm.free()
        x.data.update()
    after = mesh_metrics(CHAR["meshes"])
    return {"op": "fix", "shardsRemoved": cut, "holeFaces": filled, "before": before, "after": after}


def _apply_transforms(x):
    select([x], x)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def op_symmetrize(o):
    """Mirror the denser half onto the other so a generated A-pose figure is left/right the same (static meshes)."""
    need_char("symmetrize")
    if CHAR["arm"]:
        fail("symmetrize: do it before rigging (it rebuilds the mesh); put it before mesh.rig")
    x = join_meshes()
    _apply_transforms(x)
    bm = bmesh.new()
    bm.from_mesh(x.data)
    if o.get("center", True):
        xs = sorted(v.co.x for v in bm.verts)
        bmesh.ops.translate(bm, verts=bm.verts, vec=V((-xs[len(xs) // 2], 0, 0)))
    pos = sum(f.calc_area() for f in bm.faces if f.calc_center_median().x > 0)
    neg = sum(f.calc_area() for f in bm.faces if f.calc_center_median().x < 0)
    side = o.get("side", "auto")
    keep = "+X" if (side == "+X" or (side == "auto" and pos >= neg)) else "-X"
    n0 = len(bm.faces)
    # bmesh's direction names the half that is copied over the other one.
    bmesh.ops.symmetrize(bm, input=bm.verts[:] + bm.edges[:] + bm.faces[:], direction="-X" if keep == "+X" else "X", dist=float(o.get("merge", 0.0001)))
    bm.to_mesh(x.data)
    bm.free()
    x.data.update()
    return {"op": "symmetrize", "kept": keep, "faces": [n0, len(x.data.polygons)]}


def op_retopo(o):
    """A clean, even, low-poly surface from a generated mesh (Quadriflow quads, or a voxel remesh when it can't). The
    original stays as the bake source, so bake afterwards carries its color and detail onto the new surface."""
    need_char("retopo")
    if CHAR["arm"]:
        fail("retopo: do it before rigging (a remesh drops skin weights); put retopo before mesh.rig")
    keep_high()
    fixed = op_fix({"holes": 32}) if o.get("fix", True) else None
    x = join_meshes()
    _apply_transforms(x)
    faces = max(500, min(60000, int(o.get("faces", 8000))))
    before = triangles(x)
    if before > 300000:
        mod = x.modifiers.new("hb_pre", "DECIMATE")
        mod.ratio = 300000 / before
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    method = "quadriflow"
    if o.get("mode", "quad") == "voxel":
        method = "voxel"
    else:
        say("step", f"quad remesh to about {faces} faces")
        try:
            res = bpy.ops.object.quadriflow_remesh(target_faces=faces, use_mesh_symmetry=bool(o.get("symmetry", False)),
                                                   use_preserve_sharp=False, use_preserve_boundary=False,
                                                   smooth_normals=True, seed=int(o.get("seed", 0)))
            if "FINISHED" not in res or len(x.data.polygons) < faces * 0.3:
                method = "voxel"
        except Exception as e:  # not manifold, too thin: fall back rather than fail the job
            warn(f"retopo: quad remesh failed ({str(e).strip()[:80]}); used a voxel remesh")
            method = "voxel"
    if method == "voxel":
        H = CHAR["height"] or 1.8
        say("step", "voxel remesh")
        x.data.remesh_voxel_size = H / 160
        bpy.ops.object.voxel_remesh()
        now = triangles(x)
        if now > faces * 2:
            mod = x.modifiers.new("hb_post", "DECIMATE")
            mod.ratio = faces * 2 / now
            mod.use_collapse_triangulate = False
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.shade_smooth()
    err = silhouette_error()
    got = {"op": "retopo", "method": method, "trianglesBefore": before, "triangles": triangles(x), "polygons": len(x.data.polygons),
           "silhouette": {"max": round(err[0], 4), "p99": round(err[1], 4)}}
    if fixed:
        got["fixed"] = {"shardsRemoved": fixed["shardsRemoved"], "holeFaces": fixed["holeFaces"]}
    if CHAR["height"] and err[1] > CHAR["height"] * 0.01:
        warn(f"retopo: the surface moved up to {err[1] * 100:.1f} cm (99th percentile) from the original; raise faces to keep more of the shape")
    return got


def op_lod(o):
    """Lower-detail copies of the mesh as separate GLBs (name_LOD1.glb ...), each a ratio of the current triangles."""
    need_char("lod")
    levels = o.get("levels") or [0.5, 0.25, 0.1]
    if not isinstance(levels, list) or not all(isinstance(r, (int, float)) and 0.01 <= r < 1 for r in levels):
        fail("lod: levels is a list of ratios between 0.01 and 1, e.g. [0.5, 0.25, 0.1]")
    stem = re.sub(r"[^\w.-]", "", str(o.get("name") or "character"))[:60] or "character"
    base = join_meshes()
    tris = triangles(base)
    made = []
    for k, r in enumerate(levels, 1):
        copy = base.copy()
        copy.data = base.data.copy()
        copy.name = f"{stem}_LOD{k}"
        scene.collection.objects.link(copy)
        select([copy], copy)
        mod = copy.modifiers.new("hb_lod", "DECIMATE")
        mod.ratio = float(r)
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
        path = os.path.join(FILES_OUT, f"{stem}_LOD{k}.glb")
        say("step", f"writing {stem}_LOD{k}.glb ({triangles(copy)} triangles)")
        keep = ([CHAR["arm"]] if CHAR["arm"] else []) + [copy]
        select(keep, keep[0])
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True,
                                  export_skins=True, export_animations=False, export_materials="EXPORT", export_apply=False)
        info["outputs"].append({"file": os.path.basename(path), "title": f"LOD{k}", "ext": ".glb"})
        made.append({"level": k, "ratio": r, "triangles": triangles(copy), "file": os.path.basename(path)})
        remove([copy])
    return {"op": "lod", "from": tris, "levels": made}


VIEW_ANGLES = {"front": 0, "left": 90, "back": 180, "right": 270}


def _view_azimuth(v):
    a = v.get("view", v.get("angle", 0))
    if isinstance(a, str):
        if a not in VIEW_ANGLES:
            fail(f"project: view {a!r} is front, left, back, right or an angle in degrees (0 = the front, 90 = the character's left)")
        return VIEW_ANGLES[a]
    return float(a)


def _load_view(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    px = px.reshape(h, w, 4)
    return px


def _mask_of(px):
    """Where the character is in a view: its alpha, or else whatever differs from the border's color."""
    a = px[..., 3]
    if a.min() < 0.99:
        return a > 0.5
    border = np.concatenate([px[0, :, :3], px[-1, :, :3], px[:, 0, :3], px[:, -1, :3]])
    bg = np.median(border, axis=0)
    return np.abs(px[..., :3] - bg).max(axis=2) > 0.08


def _sample(px, u, v):
    h, w = px.shape[:2]
    x = np.clip(u * w - 0.5, 0, w - 1.001)
    y = np.clip(v * h - 0.5, 0, h - 1.001)
    x0, y0 = x.astype(int), y.astype(int)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    c = px[y0, x0] * (1 - fx) * (1 - fy) + px[y0, x0 + 1] * fx * (1 - fy) + px[y0 + 1, x0] * (1 - fx) * fy + px[y0 + 1, x0 + 1] * fx * fy
    return c


def op_project(o):
    """Paint the color texture from several pictures of the character (front, back, sides) projected onto the mesh,
    each texel taken from the views that see it head-on and nothing is in front of, blended by how squarely they see it.
    Views are cutouts (alpha) or plain backgrounds; each is fitted to the mesh by the character's height and center."""
    need_char("project")
    views = o.get("views")
    if not isinstance(views, list) or not views:
        fail("project: views is a list like [{ file: 1, view: 'front' }, { file: 2, view: 'back' }]")
    size = max(256, min(4096, int(o.get("size", 1024))))
    power = float(o.get("sharpness", 3))
    low = join_meshes()
    me = low.data
    if o.get("rebuild_uv") or not me.uv_layers:
        say("step", "unwrapping (smart UV project)")
        for layer in list(me.uv_layers):
            me.uv_layers.remove(layer)
        uv0 = me.uv_layers.new(name="baked")
        me.uv_layers.active = uv0
        select([low], low)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003)
        bpy.ops.object.mode_set(mode="OBJECT")
    uvl = me.uv_layers.active
    me.calc_loop_triangles()
    mw = low.matrix_world
    nm = mw.to_3x3().inverted_safe().transposed()
    lo, hi = mesh_bounds([low])
    zmin, zmax = lo.z, hi.z
    H = max(zmax - zmin, 1e-6)
    ctr = (lo + hi) / 2

    # Rasterize the UV triangles: each texel's 3D point and normal.
    pos = np.zeros((size, size, 3), dtype=np.float32)
    nor = np.zeros((size, size, 3), dtype=np.float32)
    have = np.zeros((size, size), dtype=bool)
    say("step", f"mapping {len(me.loop_triangles)} triangles to the {size}px texture")
    uvs = np.empty(len(me.loops) * 2, dtype=np.float32)
    uvl.uv.foreach_get("vector", uvs)
    uvs = uvs.reshape(-1, 2)
    for t in me.loop_triangles:
        l0, l1, l2 = t.loops
        p = uvs[[l0, l1, l2]] * size
        x0, y0 = np.floor(p.min(axis=0)).astype(int)
        x1, y1 = np.ceil(p.max(axis=0)).astype(int)
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, size - 1), min(y1, size - 1)
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (p[1, 1] - p[2, 1]) * (p[0, 0] - p[2, 0]) + (p[2, 0] - p[1, 0]) * (p[0, 1] - p[2, 1])
        if abs(d) < 1e-9:
            continue
        a = ((p[1, 1] - p[2, 1]) * (gx - p[2, 0]) + (p[2, 0] - p[1, 0]) * (gy - p[2, 1])) / d
        b = ((p[2, 1] - p[0, 1]) * (gx - p[2, 0]) + (p[0, 0] - p[2, 0]) * (gy - p[2, 1])) / d
        c = 1 - a - b
        inside = (a >= -0.001) & (b >= -0.001) & (c >= -0.001)
        if not inside.any():
            continue
        vs = [me.vertices[i].co for i in t.vertices]
        w = [mw @ v for v in vs]
        q = np.array([tuple(v) for v in w], dtype=np.float32)
        n = np.array(tuple((nm @ t.normal).normalized()), dtype=np.float32)
        ys, xs = np.nonzero(inside)
        aa, bb, cc = a[ys, xs][:, None], b[ys, xs][:, None], c[ys, xs][:, None]
        pos[y0 + ys, x0 + xs] = aa * q[0] + bb * q[1] + cc * q[2]
        nor[y0 + ys, x0 + xs] = n
        have[y0 + ys, x0 + xs] = True
    ys, xs = np.nonzero(have)
    P = pos[ys, xs]
    N = nor[ys, xs]
    dg = bpy.context.evaluated_depsgraph_get()
    tree = BVHTree.FromObject(low, dg)

    acc = np.zeros((len(P), 3), dtype=np.float64)
    wsum = np.zeros(len(P), dtype=np.float64)
    used = []
    for vw in views:
        az = math.radians(_view_azimuth(vw))
        cam = np.array([math.sin(az), -math.cos(az), 0.0])
        right = np.array([-cam[1], cam[0], 0.0])
        px = _load_view(file_arg(vw.get("file"), "project.views"))
        mask = _mask_of(px)
        rows = np.nonzero(mask.any(axis=1))[0]
        cols = np.nonzero(mask.any(axis=0))[0]
        if not len(rows):
            warn(f"project: view {vw.get('view', vw.get('angle'))} shows nothing (an empty cutout); skipped")
            continue
        h_img, w_img = px.shape[:2]
        top, bottom = rows.max() + 1, rows.min()
        scale = (top - bottom) / H
        # Horizontal fit: the cutout's center against the mesh's center along this view's right axis, widths agreeing.
        cx_img = (cols.max() + 1 + cols.min()) / 2
        coord = (P - np.array(tuple(ctr))) @ right
        u = (cx_img + coord * scale) / w_img
        v = (bottom + (P[:, 2] - zmin) * scale) / h_img
        facing = N @ cam
        ok = (facing > 0.1) & (u > 0) & (u < 1) & (v > 0) & (v < 1)
        idx = np.nonzero(ok)[0]
        say("step", f"view {vw.get('view', vw.get('angle'))}: {len(idx)} texels face it; checking what is in front")
        eps = H * 0.002
        camv = V(tuple(cam))
        vis = np.zeros(len(P), dtype=bool)
        for i in idx:
            origin = V(tuple(P[i])) + V(tuple(N[i])) * eps
            vis[i] = tree.ray_cast(origin, camv)[0] is None
        take = np.nonzero(vis)[0]
        if not len(take):
            continue
        col = _sample(px, u[take], v[take])
        inm = _sample(mask[..., None].astype(np.float32).repeat(4, axis=2), u[take], v[take])[:, 0] > 0.9
        w = np.power(np.clip(facing[take], 0, 1), power) * inm * float(vw.get("weight", 1))
        acc[take] += col[:, :3] * w[:, None]
        wsum[take] += w
        used.append(vw.get("view", vw.get("angle")))

    # Existing color (a bake) fills what no view reached; otherwise a flat gray, then the seams are grown out.
    name = f"{low.name}_color"
    base = None
    for im in bpy.data.images:
        if im.name == name and im.size[0] == size and im.size[1] == size:
            base = np.empty(size * size * 4, dtype=np.float32)
            im.pixels.foreach_get(base)
            base = base.reshape(size, size, 4)
    out = base.copy() if base is not None else np.full((size, size, 4), (0.5, 0.5, 0.5, 1.0), dtype=np.float32)
    seen = wsum > 1e-4
    out[ys[seen], xs[seen], :3] = (acc[seen] / wsum[seen][:, None]).astype(np.float32)
    covered = np.zeros((size, size), dtype=bool)
    covered[ys[seen], xs[seen]] = True
    margin = int(o.get("margin", 8))
    for _ in range(margin):
        grow = np.zeros_like(covered)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            src = np.roll(np.roll(covered, dy, 0), dx, 1)
            new = src & ~covered & ~grow
            if new.any():
                out[new, :3] = np.roll(np.roll(out, dy, 0), dx, 1)[new, :3]
                grow |= new
        covered |= grow
    img = bpy.data.images.get(name)
    if img is None or img.size[0] != size:
        if img is not None:
            bpy.data.images.remove(img)
        img = bpy.data.images.new(name, size, size, alpha=False)
    img.pixels.foreach_set(out.reshape(-1))
    mat = low.data.materials[0] if low.data.materials else bpy.data.materials.new("baked")
    if not low.data.materials:
        low.data.materials.append(mat)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    node = next((n for n in nt.nodes if n.type == "TEX_IMAGE" and n.image is not None and n.image.name == name), None) or nt.nodes.new("ShaderNodeTexImage")
    node.image = img
    nt.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
    tex = os.path.join(OUT, "files")
    os.makedirs(tex, exist_ok=True)
    img.filepath_raw = os.path.join(tex, f"{low.name}_color.png")
    img.file_format = "PNG"
    img.save()
    img.pack()
    info["outputs"].append({"file": f"{low.name}_color.png", "title": "texture/color", "ext": ".png"})
    return {"op": "project", "size": size, "views": used, "seen": round(float(seen.sum() / max(len(P), 1)), 3)}


BUDGETS = {
    "web": {"triangles": 15000, "materials": 2, "bones": 60, "texture": 1024},
    "mobile": {"triangles": 10000, "materials": 2, "bones": 50, "texture": 1024},
    "desktop": {"triangles": 60000, "materials": 4, "bones": 150, "texture": 2048},
    "hero": {"triangles": 120000, "materials": 6, "bones": 200, "texture": 4096},
}


def op_budget(o):
    """Checks the character against a game budget (target web | mobile | desktop | hero, any limit overridable) and reports pass/fail per limit."""
    need_char("budget")
    target = o.get("target", "web")
    if target not in BUDGETS:
        fail(f"budget: target {target!r} is not one of {', '.join(BUDGETS)}")
    limits = {**BUDGETS[target], **{k: o[k] for k in BUDGETS[target] if k in o}}
    meshes = CHAR["meshes"]
    tris = sum(sum(len(p.vertices) - 2 for p in m.data.polygons) for m in meshes)
    mats = {s.material.name for m in meshes for s in m.material_slots if s.material}
    tex = 0
    for img in bpy.data.images:
        if img.users and img.size[0] and img.type == "IMAGE" and img.name != "Render Result":
            tex = max(tex, img.size[0], img.size[1])
    bones = len(CHAR["bones"] or [])
    got = {"triangles": tris, "materials": len(mats), "bones": bones, "texture": tex}
    checks = {k: {"value": got[k], "limit": limits[k], "ok": got[k] <= limits[k]} for k in limits}
    ok = all(c["ok"] for c in checks.values())
    info["budget"] = {"target": target, "ok": ok, "checks": checks}
    if o.get("strict") and not ok:
        fail("budget: over " + ", ".join(f"{k} {c['value']}>{c['limit']}" for k, c in checks.items() if not c["ok"]))
    return {"op": "budget", "target": target, "ok": ok, "checks": checks}


OPS = {"import": op_import, "clean": op_clean, "bake": op_bake, "attach": op_attach, "retarget": op_retarget,
       "pose": op_pose, "concat": op_concat, "copy": op_copy, "rename": op_rename, "remove": op_remove,
       "fix": op_fix, "symmetrize": op_symmetrize, "retopo": op_retopo, "lod": op_lod, "project": op_project,
       "report": op_report, "budget": op_budget,
       "split": op_split, "template": op_template, "clips": op_clips, "angles": op_angles,
       "export": op_export, "preview": op_preview, **{k: op_edit for k in EDITS}}


def main():
    t0 = time.time()
    for k, o in enumerate(SPEC.get("ops") or []):
        name = o.get("op")
        if name not in OPS:
            fail(f"ops[{k}]: unknown op {name!r} ({', '.join(OPS)})")
        say("step", f"{k + 1}/{len(SPEC['ops'])} {name}")
        t = time.time()
        got = OPS[name](o)
        got["seconds"] = round(time.time() - t, 1)
        info["ops"].append(got)
        say("op", json.dumps(got))
    arm = CHAR["arm"]
    inv = {v: k for k, v in CHAR["map"].items()}
    if arm:
        info["bones"] = [{"name": b.name, "canonical": inv.get(b.name), "parent": b.parent.name if b.parent else None,
                          "head": [round(x, 4) for x in b.head_local],
                          # The bone's own axes at rest, in the world (+Z up, the character facing -Y): what a pose's
                          # [x, y, z] degrees turn about.
                          "axes": [[round(x, 3) for x in col] for col in b.matrix_local.to_3x3().transposed()]}
                         for b in arm.data.bones]
    info["names"] = CHAR["scheme"]
    info["height"] = round(CHAR["height"], 3) if CHAR["height"] else None
    info["triangles"] = sum(triangles(x) for x in CHAR["meshes"])
    info["props"] = [p.name for p in CHAR["props"]]
    info["clips"] = [{"name": n, "frames": len(c["rot"]), "seconds": round((len(c["rot"]) - 1) / FPS, 2), "source": c.get("source")}
                     for n, c in CLIPS.items()]
    info["seconds_total"] = round(time.time() - t0, 1)
    info["outputs"].sort(key=lambda o: str(o["title"]).startswith(("LOD", "texture/")))
    json.dump(info, open(os.path.join(OUT, "character.json"), "w"), indent=1)
    say("done", info["seconds_total"])


main()
