"""Rigs a generated humanoid mesh for Hawkes Gen's mesh.rig tool. Runs inside Blender (5.0):

    blender -b --factory-startup --python-exit-code 1 -P hawkes_rig.py -- spec.json

spec.json: { "mesh": path, "clips": [{ "file": path, "name": "Walk", "action": null }], "out": folder,
             "height": meters or null, "facing": degrees, "fps": 30, "weights": "proxy" | "direct", "voxel": null }

It imports the mesh (GLB/GLTF, FBX, OBJ), stands it on the ground facing -Y (the front, the way Mixamo characters
face), finds the body's joints from its shape (legs, crotch, neck, arm span, feet), builds a Mixamo skeleton there
("mixamorig:Hips" ... "mixamorig:LeftToe_End", no fingers), skins the mesh with Blender's automatic weights (bone
heat), and bakes each clip onto it as its own action. Clips are retargeted by bone name in world space, so a Mixamo
clip in a T-pose plays on a rig built in an A-pose, and its root motion is scaled to this character's legs.

Writes out/rigged.glb (one animation per clip, by name) and out/rig.json (the joints, the weighting, each clip).
Lines starting with "HB " are progress for Hawkes Gen.
"""

import json
import math
import os
import sys
import time

import bpy
import mathutils
import numpy as np

V = mathutils.Vector
M = mathutils.Matrix


def say(*a):
    print("HB", *a, flush=True)


def fail(msg):
    say("error", msg)
    sys.exit(1)


ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not ARGV:
    fail("usage: blender -b -P hawkes_rig.py -- spec.json")
SPEC = json.load(open(ARGV[0], encoding="utf-8"))
OUT = SPEC["out"]
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
FPS = int(SPEC.get("fps") or 30)
scene.render.fps = FPS
scene.render.fps_base = 1
info = {"blender": bpy.app.version_string, "warnings": [], "clips": []}
PREFIX = "mixamorig:"


def warn(msg):
    info["warnings"].append(msg)
    say("warning", msg)


def import_file(path):
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    else:
        fail(f"can't import {os.path.basename(path)} (glb, gltf, fbx or obj)")
    return [o for o in bpy.data.objects if o not in before]


def select(objs, active):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


# ---------------------------------------------------------------- the mesh

def load_mesh(path):
    """Imports the character as one mesh object with its transforms applied, feet at z = 0, centered, facing -Y."""
    objs = import_file(path)
    meshes = [o for o in objs if o.type == "MESH"]
    if not meshes:
        fail(f"{os.path.basename(path)} has no mesh")
    # Whatever rig or parents the file had: keep the meshes where they are, in their rest shape.
    for o in meshes:
        for m in list(o.modifiers):
            if m.type == "ARMATURE":
                o.modifiers.remove(m)
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    for o in objs:
        if o not in meshes:
            bpy.data.objects.remove(o, do_unlink=True)
    for o in meshes:
        o.vertex_groups.clear()
        if o.data.shape_keys:
            o.shape_key_clear()
    select(meshes, meshes[0])
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "character"
    obj.data.name = "character"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Turn it to face -Y (facing: which way it faces now, in degrees, 0 = already -Y), scale it, stand it up.
    face = float(SPEC.get("facing") or 0)
    if face:
        obj.data.transform(M.Rotation(math.radians(-face), 4, "Z"))
    co = verts(obj)
    lo, hi = co.min(0), co.max(0)
    h = hi[2] - lo[2]
    if h < 1e-5:
        fail("the mesh is flat")
    s = float(SPEC["height"]) / h if SPEC.get("height") else 1.0
    obj.data.transform(M.Diagonal((s, s, s, 1)) @ M.Translation((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2])))
    obj.data.update()
    return obj


def verts(obj):
    co = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
    obj.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


# ---------------------------------------------------------------- finding the joints

def band(co, z0, z1):
    return co[(co[:, 2] >= z0) & (co[:, 2] <= z1)]


def joints(co):
    """Joint positions (Blender space, character facing -Y, its left at +X) found from the mesh's shape."""
    H = float(co[:, 2].max())
    sl = H * 0.02
    # The legs: two columns of vertices around shin height.
    shin = band(co, H * 0.12, H * 0.32)
    if len(shin) < 10 or (shin[:, 0] > 0).sum() < 3 or (shin[:, 0] < 0).sum() < 3:
        warn("couldn't find two legs; using standard proportions")
        lx, ly = H * 0.055, 0.0
    else:
        lx = (shin[shin[:, 0] > 0][:, 0].mean() - shin[shin[:, 0] < 0][:, 0].mean()) / 2
        ly = float(shin[:, 1].mean())
    # The crotch: going up from the shins, the last slice that still has a gap between the legs.
    crotch = None
    for z in np.arange(H * 0.2, H * 0.62, sl / 2):
        s = band(co, z - sl / 2, z + sl / 2)
        if len(s) and (np.abs(s[:, 0]) < lx * 0.2).sum() == 0:
            crotch = float(z)
        elif crotch is not None or z > H * 0.3:
            break
    if crotch is None or crotch < H * 0.3:
        warn("couldn't find the crotch (legs together?); using standard proportions")
        crotch = H * 0.46
    hip_z = min(H * 0.6, crotch + H * 0.035)
    # The neck: the narrowest part of the upper body (above the arms in a T-pose, between the shoulders in an A-pose),
    # at its base.
    widths = []
    for z in np.arange(max(hip_z + H * 0.15, H * 0.55), H * 0.95, sl / 2):
        s = band(co, z - sl / 2, z + sl / 2)
        s = s[np.abs(s[:, 0]) < H * 0.2]
        if len(s) >= 4:
            widths.append((float(z), float(np.percentile(np.abs(s[:, 0]), 95))))
    if widths:
        w_min = min(w for _, w in widths)
        neck_z = min(z for z, w in widths if w <= w_min * 1.15)
    else:
        neck_z = H * 0.8
    neck_z = min(max(neck_z, hip_z + H * 0.2), H * 0.9)
    # The hands: the farthest vertex out to each side, above the crotch.
    upper = co[co[:, 2] > crotch]
    tips = []
    for side in (1, -1):
        sx = upper[:, 0] * side
        k = int(np.argmax(sx))
        tips.append(V((abs(upper[k, 0]), upper[k, 1], upper[k, 2])))
    tip = V(((tips[0].x + tips[1].x) / 2, (tips[0].y + tips[1].y) / 2, (tips[0].z + tips[1].z) / 2))
    sh_z = neck_z - H * 0.015
    sh_x = min(max(lx * 2.0, H * 0.06), max(tip.x * 0.45, H * 0.06))
    if tip.x < sh_x + H * 0.1:
        warn("the arms are close to the body; the rig expects a T-pose or an A-pose")
        tip = V((sh_x + H * 0.3, ly, sh_z - H * 0.25))

    def y_at(z, x0, x1):
        s = band(co, z - sl, z + sl)
        s = s[(s[:, 0] >= x0) & (s[:, 0] <= x1)]
        return float(s[:, 1].mean()) if len(s) else ly

    spine_y = y_at((hip_z + neck_z) / 2, -sh_x, sh_x)
    j = {}
    j["Hips"] = V((0, y_at(hip_z, -lx * 2, lx * 2), hip_z))
    span = neck_z - hip_z
    for name, t in (("Spine", 0.2), ("Spine1", 0.44), ("Spine2", 0.7)):
        j[name] = V((0, spine_y, hip_z + span * t))
    j["Neck"] = V((0, y_at(neck_z, -H * 0.06, H * 0.06), neck_z))
    j["Head"] = V((0, j["Neck"].y, neck_z + (H - neck_z) * 0.3))
    j["HeadTop_End"] = V((0, j["Neck"].y, H))
    feet = co[co[:, 2] < H * 0.06]
    for side, pre in ((1, "Left"), (-1, "Right")):
        shoulder = V((sh_x * side, spine_y, sh_z))
        hand = V((tip.x * side, tip.y, tip.z))
        arm = hand - shoulder
        j[pre + "Shoulder"] = V((H * 0.025 * side, spine_y, j["Spine2"].z + (sh_z - j["Spine2"].z) * 0.6))
        j[pre + "Arm"] = shoulder
        j[pre + "ForeArm"] = shoulder + arm * 0.42
        j[pre + "Hand"] = shoulder + arm * 0.76
        j[pre + "Hand_End"] = hand
        x = lx * side
        j[pre + "UpLeg"] = V((x, j["Hips"].y, hip_z - H * 0.03))
        j[pre + "Leg"] = V((x, ly, hip_z * 0.53))
        j[pre + "Foot"] = V((x, ly, hip_z * 0.09))
        f = feet[(feet[:, 0] * side > lx * 0.3)] if len(feet) else feet
        toe_y = float(f[:, 1].min()) if len(f) else ly - H * 0.08
        j[pre + "ToeBase"] = V((x, ly + (toe_y - ly) * 0.6, H * 0.015))
        j[pre + "Toe_End"] = V((x, toe_y, H * 0.015))
    return j, H


# name: (head joint, tail joint, parent, deforms)
BONES = [
    ("Hips", "Hips", "Spine", None, True),
    ("Spine", "Spine", "Spine1", "Hips", True),
    ("Spine1", "Spine1", "Spine2", "Spine", True),
    ("Spine2", "Spine2", "Neck", "Spine1", True),
    ("Neck", "Neck", "Head", "Spine2", True),
    ("Head", "Head", "HeadTop_End", "Neck", True),
    ("HeadTop_End", "HeadTop_End", None, "Head", False),
]
for _p in ("Left", "Right"):
    BONES += [
        (f"{_p}Shoulder", f"{_p}Shoulder", f"{_p}Arm", "Spine2", True),
        (f"{_p}Arm", f"{_p}Arm", f"{_p}ForeArm", f"{_p}Shoulder", True),
        (f"{_p}ForeArm", f"{_p}ForeArm", f"{_p}Hand", f"{_p}Arm", True),
        (f"{_p}Hand", f"{_p}Hand", f"{_p}Hand_End", f"{_p}ForeArm", True),
        (f"{_p}UpLeg", f"{_p}UpLeg", f"{_p}Leg", "Hips", True),
        (f"{_p}Leg", f"{_p}Leg", f"{_p}Foot", f"{_p}UpLeg", True),
        (f"{_p}Foot", f"{_p}Foot", f"{_p}ToeBase", f"{_p}Leg", True),
        (f"{_p}ToeBase", f"{_p}ToeBase", f"{_p}Toe_End", f"{_p}Foot", True),
        (f"{_p}Toe_End", f"{_p}Toe_End", None, f"{_p}ToeBase", False),
    ]


def build_armature(j, H):
    data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("Armature", data)
    scene.collection.objects.link(arm)
    select([arm], arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones
    for name, head, tail, parent, deform in BONES:
        b = eb.new(PREFIX + name)
        b.head = j[head]
        if tail:
            b.tail = j[tail]
        else:
            # End bones point on along their parent.
            pj = [x for x in BONES if x[0] == parent][0]
            d = j[head] - j[pj[1]]
            b.tail = j[head] + (d.normalized() if d.length > 1e-6 else V((0, 0, 1))) * H * 0.04
        if (b.tail - b.head).length < H * 0.005:
            b.tail = b.head + V((0, 0, H * 0.02))
        b.use_deform = deform
        if parent:
            b.parent = eb[PREFIX + parent]
            b.use_connect = False
        # Rolls: limbs' Z toward the front of the body (-Y), spine's toward the front too.
        b.align_roll(V((0, -1, 0)) if abs((b.tail - b.head).normalized().y) < 0.9 else V((0, 0, 1)))
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


# ---------------------------------------------------------------- weights

def unweighted(obj):
    n = 0
    for v in obj.data.vertices:
        if not any(g.weight > 1e-4 for g in v.groups):
            n += 1
    return n


def auto_weights(obj, arm):
    select([obj, arm], arm)
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def nearest_weights(obj, arm, only_empty=True):
    """Weights by distance to the bones (inverse-square over the two nearest), for vertices bone heat left empty."""
    bones = [b for b in arm.data.bones if b.use_deform]
    heads = np.array([list(b.head_local) for b in bones])
    tails = np.array([list(b.tail_local) for b in bones])
    co = verts(obj)
    seg = tails - heads
    t = np.clip(np.einsum("vbk,bk->vb", co[:, None, :] - heads[None], seg) / np.maximum((seg * seg).sum(1), 1e-9), 0, 1)
    p = heads[None] + t[..., None] * seg[None]
    d = np.linalg.norm(co[:, None, :] - p, axis=2)
    groups = {b.name: (obj.vertex_groups.get(b.name) or obj.vertex_groups.new(name=b.name)) for b in bones}
    n = 0
    for i, v in enumerate(obj.data.vertices):
        if only_empty and any(g.weight > 1e-4 for g in v.groups):
            continue
        order = np.argsort(d[i])[:2]
        w = 1 / np.maximum(d[i][order], 1e-4) ** 2
        w = w / w.sum()
        for k, wk in zip(order, w):
            groups[bones[k].name].add([i], float(wk), "REPLACE")
        n += 1
    return n


def skin(obj, arm, H):
    method = SPEC.get("weights") or "proxy"
    say("step", f"weighting the mesh ({method})")
    t = time.time()
    if method == "direct":
        auto_weights(obj, arm)
    else:
        # Generated meshes have holes, inner faces and loose bits that make bone heat fail. Weight a clean, closed
        # copy (voxel remesh), then copy its weights onto the real mesh by nearest surface.
        proxy = obj.copy()
        proxy.data = obj.data.copy()
        proxy.name = "hb_proxy"
        scene.collection.objects.link(proxy)
        mod = proxy.modifiers.new("remesh", "REMESH")
        mod.mode = "VOXEL"
        mod.voxel_size = float(SPEC.get("voxel") or H / 110)
        select([proxy], proxy)
        bpy.ops.object.modifier_apply(modifier=mod.name)
        info["proxyVertices"] = len(proxy.data.vertices)
        auto_weights(proxy, arm)
        for g in [g.name for g in proxy.vertex_groups]:
            if not obj.vertex_groups.get(g):
                obj.vertex_groups.new(name=g)
        dt = obj.modifiers.new("weights", "DATA_TRANSFER")
        dt.object = proxy
        dt.use_vert_data = True
        dt.data_types_verts = {"VGROUP_WEIGHTS"}
        dt.vert_mapping = "POLYINTERP_NEAREST"
        dt.layers_vgroup_select_src = "ALL"
        dt.layers_vgroup_select_dst = "NAME"
        select([obj], obj)
        bpy.ops.object.modifier_apply(modifier=dt.name)
        bpy.data.objects.remove(proxy, do_unlink=True)
        obj.parent = arm
        obj.matrix_parent_inverse = M()
        am = obj.modifiers.new("Armature", "ARMATURE")
        am.object = arm
    empty = unweighted(obj)
    if empty:
        warn(f"bone heat left {empty} of {len(obj.data.vertices)} vertices unweighted; those follow the nearest bones")
        nearest_weights(obj, arm)
    # Normalize to 4 influences (what glTF and most engines take).
    select([obj], obj)
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    info["weights"] = {"method": method, "nearestVertices": empty, "seconds": round(time.time() - t, 1)}


# ---------------------------------------------------------------- clips

def bone_key(name):
    n = name.split(":")[-1]
    return "".join(ch for ch in n.lower() if ch.isalnum())


def order(arm):
    out, stack = [], [b for b in arm.data.bones if not b.parent]
    while stack:
        b = stack.pop(0)
        out.append(b)
        stack.extend(b.children)
    return out


def compat(q, prev):
    if prev is not None and q.dot(prev) < 0:
        q.negate()
    return q


def bake_clip(arm, clip, k):
    """Imports a clip's file, retargets its animation onto the rig by bone name and bakes it as an action."""
    name = clip.get("name") or f"Clip{k + 1}"
    acts0 = set(bpy.data.actions)
    objs = import_file(clip["file"])
    new_acts = [a for a in bpy.data.actions if a not in acts0]
    srcs = [o for o in objs if o.type == "ARMATURE"]
    if not srcs:
        fail(f"clip {name}: {os.path.basename(clip['file'])} has no skeleton")
    src = None
    act = None
    want = clip.get("action")
    if want:
        act = bpy.data.actions.get(want)
        if not act:
            fail(f"clip {name}: no animation {want!r} in {os.path.basename(clip['file'])}; it has {sorted(a.name for a in new_acts)}")
    for o in srcs:
        if o.animation_data and o.animation_data.action and (act is None or o.animation_data.action == act):
            src, act = o, o.animation_data.action
            break
    if act is None and new_acts:
        act = new_acts[0]
    if src is None:
        src = srcs[0]
    if act is None:
        fail(f"clip {name}: {os.path.basename(clip['file'])} has no animation")
    ad = src.animation_data_create()
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    ad.action = act
    if hasattr(ad, "action_slot") and ad.action_slot is None and len(act.slots):
        ad.action_slot = act.slots[0]

    tgt = {bone_key(b.name): b for b in arm.data.bones}
    pairs = {}
    for sb in src.data.bones:
        tb = tgt.get(bone_key(sb.name))
        if tb is not None:
            pairs[tb.name] = sb.name
    missing = sorted(bone_key(b.name) for b in arm.data.bones if b.use_deform and b.name not in pairs)
    if PREFIX + "Hips" not in pairs:
        fail(f"clip {name}: no Hips bone in {os.path.basename(clip['file'])} (it needs a Mixamo-named skeleton)")
    say("step", f"baking {name} ({len(pairs)} bones)")

    a0, a1 = act.frame_range
    f0, f1 = int(math.floor(a0)), int(math.ceil(a1))
    scene.frame_set(f0)
    W = src.matrix_world.copy()
    Wr = W.to_quaternion()
    rest = {}  # target bone -> (source rest world rotation, target rest rotation swung onto the source's direction)
    src_keys = {bone_key(b.name): b for b in src.data.bones}
    tails = {PREFIX + b[0]: b[2] for b in BONES}
    for tname, sname in pairs.items():
        sb, tb = src.data.bones[sname], arm.data.bones[tname]
        qs0 = (Wr @ sb.matrix_local.to_quaternion()).normalized()
        qt0 = tb.matrix_local.to_quaternion()
        # Each bone's direction from its joint to the next one (the next joint's position, not the bone's axis:
        # FBX imports don't always point bones along the limb). A hand points at its middle finger.
        tail = tails.get(tname)
        nxt = src.data.bones.get(pairs.get(PREFIX + tail, "")) if tail else None
        if nxt is None and tail and tail.endswith("Hand_End"):
            nxt = src_keys.get(bone_key(tail.replace("_End", "Middle1")))
        ds = (W @ nxt.head_local - W @ sb.head_local) if nxt is not None else qs0 @ V((0, 1, 0))
        dt = tb.tail_local - tb.head_local
        if ds.length < 1e-6 or dt.length < 1e-6:
            ds, dt = qs0 @ V((0, 1, 0)), qt0 @ V((0, 1, 0))
        rest[tname] = (qs0, dt.normalized().rotation_difference(ds.normalized()) @ qt0)
    shb = src.data.bones[pairs[PREFIX + "Hips"]]
    s_hip0 = W @ shb.head_local
    t_hip0 = arm.data.bones[PREFIX + "Hips"].head_local
    scale = t_hip0.z / s_hip0.z if s_hip0.z > 1e-4 else 1.0

    tarm = arm.animation_data_create()
    tarm.action = None
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    tarm.action = action
    bones = order(arm)
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    prev = {}
    for f in range(f0, f1 + 1):
        scene.frame_set(f)
        want_q = {}
        for b in bones:
            pb = arm.pose.bones[b.name]
            R = b.matrix_local.to_quaternion()
            if b.name in rest:
                qs0, qt0s = rest[b.name]
                qs = (Wr @ src.pose.bones[pairs[b.name]].matrix.to_quaternion()).normalized()
                q = qs @ qs0.inverted() @ qt0s
            elif b.parent:
                # Not in the clip: follows its parent.
                pr = b.parent.matrix_local.to_quaternion()
                q = want_q[b.parent.name] @ pr.inverted() @ R
            else:
                q = R
            want_q[b.name] = q
            if b.parent:
                pr = b.parent.matrix_local.to_quaternion()
                basis = R.inverted() @ pr @ want_q[b.parent.name].inverted() @ q
            else:
                basis = R.inverted() @ q
            basis = compat(basis.normalized(), prev.get(b.name))
            prev[b.name] = basis.copy()
            pb.rotation_quaternion = basis
            pb.keyframe_insert("rotation_quaternion", frame=f - f0 + 1, group=b.name)
            if not b.parent:
                # Root motion: the source hips' travel, scaled to this character's leg length.
                hip = W @ src.pose.bones[pairs[b.name]].head
                loc_arm = t_hip0 + (hip - s_hip0) * scale
                pb.location = b.matrix_local.inverted() @ loc_arm
                pb.keyframe_insert("location", frame=f - f0 + 1, group=b.name)
    # Leave it on the rig for the exporter: one NLA track per clip.
    tarm.action = None
    track = tarm.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, action)
    if hasattr(strip, "action_slot") and strip.action_slot is None and len(action.slots):
        strip.action_slot = action.slots[0]
    track.mute = True
    source = act.name
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    for a in new_acts:
        bpy.data.actions.remove(a)
    # Named only now: the clip's own action may have had the same name.
    action.name = name
    strip.name = name
    for pb in arm.pose.bones:
        pb.matrix_basis = M()
    got = {"name": name, "file": os.path.basename(clip["file"]), "source": source,
           "frames": f1 - f0 + 1, "seconds": round((f1 - f0) / FPS, 2), "bones": len(pairs), "missing": missing}
    info["clips"].append(got)
    say("clip", json.dumps(got))


# ---------------------------------------------------------------- main

def main():
    t0 = time.time()
    say("step", "reading the mesh")
    obj = load_mesh(SPEC["mesh"])
    co = verts(obj)
    j, H = joints(co)
    info["height"] = round(H, 3)
    info["vertices"] = len(obj.data.vertices)
    info["joints"] = {k: [round(x, 3) for x in v] for k, v in j.items()}
    say("step", "building the skeleton")
    arm = build_armature(j, H)
    skin(obj, arm, H)
    names = set()
    for k, clip in enumerate(SPEC.get("clips") or []):
        if clip.get("name") in names:
            fail(f"two clips are named {clip.get('name')!r}")
        names.add(clip.get("name"))
        bake_clip(arm, clip, k)
    scene.frame_set(1)
    say("step", "writing the GLB")
    select([obj, arm], arm)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, "rigged.glb"), export_format="GLB", use_selection=True,
        export_animations=bool(info["clips"]), export_animation_mode="ACTIONS", export_skins=True,
        export_anim_slide_to_zero=True, export_force_sampling=True, export_yup=True,
    )
    info["bones"] = [b.name for b in arm.data.bones]
    info["seconds_total"] = round(time.time() - t0, 1)
    json.dump(info, open(os.path.join(OUT, "rig.json"), "w"), indent=1)
    say("done", round(time.time() - t0, 1))


main()
