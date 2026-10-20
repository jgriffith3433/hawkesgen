"""Hard-surface robot / creature helpers for blender.character (split, template, procedural clips).

Imported by hawkes_character.py on the GPU server. Templates: spider (6 legs), quadarm (4 legs + 2 arms,
Yo Bot style), biped, and a generic chain. Parts are labelled (caller / Claude) or guessed from the mesh;
each part binds rigidly to one bone, with a short blend only where parts meet.
"""

from __future__ import annotations

import math
import re

import numpy as np
from mathutils import Matrix, Quaternion, Vector

KINDS = ("spider", "quadarm", "biped", "chain")
GAITS = ("tripod", "wave")
ATTACKS = ("stab", "swipe", "slam")
CLIP_TYPES = ("walk", "run", "idle", "attack", "hit", "death", "jump")


def part_roles(kind: str, segments: int = 6) -> list[str]:
    """The part names a template expects (what Claude labels, or what heuristics invent)."""
    if kind == "spider":
        return ["body"] + [f"leg{i}" for i in range(1, 7)]
    if kind == "quadarm":
        return ["body", "head", "leg_fl", "leg_fr", "leg_bl", "leg_br", "arm_l", "arm_r"]
    if kind == "biped":
        return ["hips", "spine", "head", "arm_l", "arm_r", "leg_l", "leg_r"]
    if kind == "chain":
        n = max(2, min(24, int(segments)))
        return [f"seg{i}" for i in range(n)]
    raise ValueError(f"unknown template {kind!r}")


def bone_tree(kind: str, segments: int = 6) -> list[tuple[str, str | None, str]]:
    """(bone, parent, role) parents-first. role drives procedural clips."""
    if kind == "spider":
        out: list[tuple[str, str | None, str]] = [("Root", None, "root"), ("Body", "Root", "body")]
        for i in range(1, 7):
            out.append((f"Leg{i}", "Body", "leg_upper"))
            out.append((f"Leg{i}Tip", f"Leg{i}", "leg_lower"))
        return out
    if kind == "quadarm":
        out = [("Root", None, "root"), ("Body", "Root", "body"), ("Head", "Body", "head")]
        for tag, role_u, role_l in (
            ("LegFL", "leg_upper", "leg_lower"), ("LegFR", "leg_upper", "leg_lower"),
            ("LegBL", "leg_upper", "leg_lower"), ("LegBR", "leg_upper", "leg_lower"),
            ("ArmL", "arm_upper", "arm_lower"), ("ArmR", "arm_upper", "arm_lower"),
        ):
            out.append((tag, "Body", role_u))
            out.append((f"{tag}Tip", tag, role_l))
        return out
    if kind == "biped":
        return [
            ("Hips", None, "hips"), ("Spine", "Hips", "spine"), ("Head", "Spine", "head"),
            ("ArmL", "Spine", "arm_upper"), ("ArmLTip", "ArmL", "arm_lower"),
            ("ArmR", "Spine", "arm_upper"), ("ArmRTip", "ArmR", "arm_lower"),
            ("LegL", "Hips", "leg_upper"), ("LegLTip", "LegL", "leg_lower"),
            ("LegR", "Hips", "leg_upper"), ("LegRTip", "LegR", "leg_lower"),
        ]
    if kind == "chain":
        n = max(2, min(24, int(segments)))
        out = [("Root", None, "root")]
        prev = "Root"
        for i in range(n):
            name = f"Seg{i}"
            out.append((name, prev, "segment"))
            prev = name
        return out
    raise ValueError(f"unknown template {kind!r}")


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def match_part(label: str, roles: list[str]) -> str | None:
    """Map a free-form label (body, front-left-leg, Leg_1...) onto a template role."""
    n = _norm(label)
    by = {_norm(r): r for r in roles}
    if n in by:
        return by[n]
    # Common synonyms Claude uses.
    aliases = {
        "torso": "body", "chest": "body", "abdomen": "body", "thorax": "body", "core": "body", "pelvis": "hips",
        "hip": "hips", "trunk": "body", "lid": "head", "cap": "head", "dome": "head", "skull": "head",
        "frontleftleg": "leg_fl", "frontrightleg": "leg_fr", "backleftleg": "leg_bl", "backrightleg": "leg_br",
        "leftfrontleg": "leg_fl", "rightfrontleg": "leg_fr", "leftbackleg": "leg_bl", "rightbackleg": "leg_br",
        "rearleftleg": "leg_bl", "rearrightleg": "leg_br", "leftleg": "leg_l", "rightleg": "leg_r",
        "leftarm": "arm_l", "rightarm": "arm_r", "leftforeleg": "leg_fl", "rightforeleg": "leg_fr",
    }
    if n in aliases and aliases[n] in by:
        return aliases[n]
    for i in range(1, 7):
        if n in (f"leg{i}", f"limb{i}", f"leg{i}l", f"spiderleg{i}") and f"leg{i}" in by:
            return f"leg{i}"
    for i, r in enumerate(roles):
        if n == f"seg{i}" or n == f"segment{i}":
            return r
    # Fuzzy: role contained in label or the other way.
    for r in roles:
        rn = _norm(r)
        if rn and (rn in n or n in rn):
            return r
    return None


def guess_centers(coords: np.ndarray, kind: str, segments: int = 6) -> dict[str, np.ndarray]:
    """Part centers from a vertex cloud when Claude didn't label them. coords: (N, 3) world XYZ."""
    roles = part_roles(kind, segments)
    if len(coords) < 3:
        c = coords.mean(axis=0) if len(coords) else np.zeros(3)
        return {r: c.copy() for r in roles}
    lo, hi = coords.min(0), coords.max(0)
    mid = (lo + hi) * 0.5
    size = np.maximum(hi - lo, 1e-4)
    xy = coords[:, :2] - mid[:2]
    ang = np.arctan2(xy[:, 0], -xy[:, 1])  # 0 = front (-Y), increases toward +X
    rad = np.linalg.norm(xy, axis=1)
    r_body = np.percentile(rad, 35) if len(rad) else 0.1

    centers: dict[str, np.ndarray] = {}
    if kind == "spider":
        body_m = rad <= max(r_body, size[0] * 0.15)
        centers["body"] = coords[body_m].mean(0) if body_m.any() else mid.copy()
        for i in range(6):
            a0 = -math.pi + (i + 0.5) * (2 * math.pi / 6) - math.pi / 6
            a1 = a0 + 2 * math.pi / 6
            # Wrap-friendly sector mask.
            a = (ang - a0 + math.pi) % (2 * math.pi) - math.pi
            m = (a >= 0) & (a < (a1 - a0)) & (rad > r_body * 0.6)
            centers[f"leg{i + 1}"] = coords[m].mean(0) if m.any() else mid + np.array([
                math.sin(-math.pi + (i + 0.5) * (2 * math.pi / 6)) * size[0] * 0.4,
                -math.cos(-math.pi + (i + 0.5) * (2 * math.pi / 6)) * size[1] * 0.4,
                mid[2] - size[2] * 0.1,
            ])
        return centers

    if kind == "quadarm":
        centers["body"] = mid.copy()
        centers["head"] = mid + np.array([0, 0, size[2] * 0.35])
        for name, sx, sy in (
            ("leg_fl", -1, -1), ("leg_fr", 1, -1), ("leg_bl", -1, 1), ("leg_br", 1, 1),
        ):
            centers[name] = mid + np.array([sx * size[0] * 0.35, sy * size[1] * 0.35, -size[2] * 0.15])
        centers["arm_l"] = mid + np.array([-size[0] * 0.45, 0, size[2] * 0.1])
        centers["arm_r"] = mid + np.array([size[0] * 0.45, 0, size[2] * 0.1])
        # Snap each to nearest real vertices for a better fit.
        for k, c in list(centers.items()):
            d = np.linalg.norm(coords - c, axis=1)
            centers[k] = coords[int(d.argmin())]
        return centers

    if kind == "biped":
        centers["hips"] = mid + np.array([0, 0, -size[2] * 0.05])
        centers["spine"] = mid + np.array([0, 0, size[2] * 0.15])
        centers["head"] = mid + np.array([0, 0, size[2] * 0.4])
        centers["arm_l"] = mid + np.array([-size[0] * 0.4, 0, size[2] * 0.2])
        centers["arm_r"] = mid + np.array([size[0] * 0.4, 0, size[2] * 0.2])
        centers["leg_l"] = mid + np.array([-size[0] * 0.15, 0, -size[2] * 0.3])
        centers["leg_r"] = mid + np.array([size[0] * 0.15, 0, -size[2] * 0.3])
        for k, c in list(centers.items()):
            d = np.linalg.norm(coords - c, axis=1)
            centers[k] = coords[int(d.argmin())]
        return centers

    # chain: along the longest axis
    axis = int(np.argmax(size))
    order = np.argsort(coords[:, axis])
    n = len(roles)
    for i, r in enumerate(roles):
        lo_i = int(i * len(order) / n)
        hi_i = int((i + 1) * len(order) / n)
        chunk = coords[order[lo_i:max(hi_i, lo_i + 1)]]
        centers[r] = chunk.mean(0)
    return centers


def assign_vertices(coords: np.ndarray, centers: dict[str, np.ndarray]) -> np.ndarray:
    """Nearest-center part index per vertex. Returns int array length N."""
    names = list(centers)
    C = np.stack([centers[n] for n in names], axis=0)
    # (N, K)
    d = ((coords[:, None, :] - C[None, :, :]) ** 2).sum(-1)
    return d.argmin(axis=1)


def bone_placements(kind: str, centers: dict[str, np.ndarray], segments: int = 6) -> list[tuple[str, str | None, Vector, Vector, str]]:
    """(name, parent, head, tail, role) for edit-bones, fitted to part centers."""
    tree = bone_tree(kind, segments)
    roles = part_roles(kind, segments)
    # Map bone -> part center used for its head.
    part_of = {}
    if kind == "spider":
        part_of = {"Body": "body", **{f"Leg{i}": f"leg{i}" for i in range(1, 7)}, **{f"Leg{i}Tip": f"leg{i}" for i in range(1, 7)}}
    elif kind == "quadarm":
        part_of = {
            "Body": "body", "Head": "head",
            "LegFL": "leg_fl", "LegFLTip": "leg_fl", "LegFR": "leg_fr", "LegFRTip": "leg_fr",
            "LegBL": "leg_bl", "LegBLTip": "leg_bl", "LegBR": "leg_br", "LegBRTip": "leg_br",
            "ArmL": "arm_l", "ArmLTip": "arm_l", "ArmR": "arm_r", "ArmRTip": "arm_r",
        }
    elif kind == "biped":
        part_of = {
            "Hips": "hips", "Spine": "spine", "Head": "head",
            "ArmL": "arm_l", "ArmLTip": "arm_l", "ArmR": "arm_r", "ArmRTip": "arm_r",
            "LegL": "leg_l", "LegLTip": "leg_l", "LegR": "leg_r", "LegRTip": "leg_r",
        }
    elif kind == "chain":
        part_of = {f"Seg{i}": f"seg{i}" for i in range(len(roles))}

    pts = {r: Vector(centers.get(r, np.zeros(3))) for r in roles}
    body = pts.get("body") or pts.get("hips") or pts.get("seg0") or Vector((0, 0, 0.5))
    ground_z = min(float(p.z) for p in pts.values()) if pts else 0.0
    root = Vector((body.x, body.y, ground_z))

    heads: dict[str, Vector] = {"Root": root}
    tails: dict[str, Vector] = {}
    roles_by = {n: r for n, _, r in tree}

    for name, parent, role in tree:
        if name == "Root":
            tails[name] = root + Vector((0, 0, max(0.05, (body.z - ground_z) * 0.25)))
            continue
        if name == "Body" or name == "Hips":
            heads[name] = Vector(pts.get("body", pts.get("hips", body)))
            if name == "Body":
                heads[name] = body
            up = pts.get("spine") or pts.get("head") or (heads[name] + Vector((0, 0, 0.15)))
            tails[name] = Vector((heads[name].x, heads[name].y, max(heads[name].z + 0.08, float(Vector(up).z))))
            continue
        if name == "Spine":
            heads[name] = pts.get("spine", body + Vector((0, 0, 0.12)))
            tails[name] = pts.get("head", heads[name] + Vector((0, 0, 0.2)))
            continue
        if name == "Head":
            heads[name] = pts.get("head", body + Vector((0, 0, 0.3)))
            tails[name] = heads[name] + Vector((0, 0, 0.12))
            continue
        if role == "segment":
            idx = int(name.replace("Seg", ""))
            heads[name] = pts.get(f"seg{idx}", body)
            nxt = pts.get(f"seg{idx + 1}")
            tails[name] = Vector(nxt) if nxt is not None else heads[name] + Vector((0, 0.1, 0))
            continue
        # Limb upper / lower: tip bones point from mid-limb toward extremity.
        part = part_of.get(name)
        c = Vector(pts[part]) if part and part in pts else body + Vector((0.2, 0, 0))
        parent_head = heads.get(parent, body)
        if role in ("leg_upper", "arm_upper"):
            heads[name] = parent_head.lerp(c, 0.25) if parent else c
            tails[name] = parent_head.lerp(c, 0.7)
        else:  # lower / tip
            heads[name] = tails.get(parent, parent_head.lerp(c, 0.7))
            # Tip toward the part's farthest point from the body (approx: past the center).
            tails[name] = c + (c - body).normalized() * max(0.06, (c - body).length * 0.35)
        # Degenerate bones: nudge.
        if (tails[name] - heads[name]).length < 1e-4:
            tails[name] = heads[name] + Vector((0, 0.05, 0))

    out = []
    for name, parent, role in tree:
        out.append((name, parent, heads[name], tails[name], role))
    return out


def quat_axis_angle(axis: Vector, degrees: float) -> tuple[float, float, float, float]:
    q = Quaternion(axis.normalized(), math.radians(degrees))
    return (q.w, q.x, q.y, q.z)


def slerp_q(a, b, t: float):
    qa = Quaternion(a)
    qb = Quaternion(b)
    if qa.dot(qb) < 0:
        qb = -qb
    return tuple(qa.slerp(qb, t))


def procedural_clip(
    clip_type: str,
    kind: str,
    bone_names: list[str],
    roles: list[str],
    fps: int,
    *,
    gait: str = "tripod",
    attack: str = "stab",
    seconds: float | None = None,
    name: str | None = None,
) -> dict:
    """Build a clip dict {rot, loc, source} in CHAR['bones'] order. rot (F,B,4), loc (F,B,3)."""
    B = len(bone_names)
    role_of = {bone_names[i]: roles[i] for i in range(B)}
    idx = {n: i for i, n in enumerate(bone_names)}

    def frames_for(default: float) -> int:
        sec = float(seconds) if seconds is not None else default
        return max(2, int(round(sec * fps)) + 1)

    if clip_type == "run":
        F = frames_for(0.6)
        amp, speed = 28.0, 2.0
    elif clip_type == "walk":
        F = frames_for(1.0)
        amp, speed = 18.0, 1.0
    elif clip_type == "idle":
        F = frames_for(2.0)
        amp, speed = 4.0, 0.5
    elif clip_type == "jump":
        F = frames_for(0.7)
        amp, speed = 0.0, 1.0
    elif clip_type == "hit":
        F = frames_for(0.45)
        amp, speed = 0.0, 1.0
    elif clip_type == "death":
        F = frames_for(1.2)
        amp, speed = 0.0, 1.0
    elif clip_type == "attack":
        F = frames_for(0.7)
        amp, speed = 0.0, 1.0
        if attack not in ATTACKS:
            attack = "stab"
    else:
        raise ValueError(f"unknown clip type {clip_type!r}")

    rot = np.zeros((F, B, 4), dtype=np.float32)
    rot[:, :, 0] = 1.0
    loc = np.zeros((F, B, 3), dtype=np.float32)

    uppers = [n for n, r in role_of.items() if r == "leg_upper"]
    lowers = [n for n, r in role_of.items() if r == "leg_lower"]
    arms_u = [n for n, r in role_of.items() if r == "arm_upper"]
    arms_l = [n for n, r in role_of.items() if r == "arm_lower"]
    body_bones = [n for n, r in role_of.items() if r in ("body", "hips", "spine", "root")]
    head_bones = [n for n, r in role_of.items() if r == "head"]
    segments = [n for n, r in role_of.items() if r == "segment"]
    root_i = idx.get("Root", idx.get("Hips", 0))

    x_axis, y_axis, z_axis = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))

    for f in range(F):
        t = f / max(F - 1, 1)
        phase = t * math.pi * 2 * speed

        if clip_type in ("walk", "run"):
            for li, name in enumerate(uppers):
                if gait == "wave":
                    ph = phase + li * (2 * math.pi / max(len(uppers), 1))
                else:  # tripod: alternate halves
                    ph = phase + (0 if li % 2 == 0 else math.pi)
                swing = math.sin(ph) * amp
                lift = max(0.0, math.sin(ph)) * amp * 0.45
                rot[f, idx[name]] = quat_axis_angle(z_axis, swing)
                tip = name + "Tip" if name + "Tip" in idx else (lowers[li] if li < len(lowers) else None)
                if tip and tip in idx:
                    rot[f, idx[tip]] = quat_axis_angle(x_axis, -lift - abs(swing) * 0.2)
            for name in arms_u:
                side = 1 if "L" in name else -1
                rot[f, idx[name]] = quat_axis_angle(z_axis, math.sin(phase) * amp * 0.4 * side)
            # Slight forward travel on the root.
            loc[f, root_i] = (0.0, -t * (0.8 if clip_type == "run" else 0.45), 0.0)

        elif clip_type == "idle":
            sway = math.sin(phase) * amp
            for name in body_bones:
                rot[f, idx[name]] = quat_axis_angle(y_axis, sway * 0.4)
            for li, name in enumerate(uppers):
                rot[f, idx[name]] = quat_axis_angle(z_axis, math.sin(phase + li) * amp * 0.3)
            for name in head_bones:
                rot[f, idx[name]] = quat_axis_angle(z_axis, sway)

        elif clip_type == "jump":
            # Crouch, launch, hang, land.
            if t < 0.25:
                u = t / 0.25
                crouch = u * 25
                hop = 0.0
            elif t < 0.45:
                u = (t - 0.25) / 0.2
                crouch = 25 * (1 - u)
                hop = u * 0.35
            elif t < 0.7:
                crouch = 0.0
                hop = 0.35
            else:
                u = (t - 0.7) / 0.3
                crouch = u * 15
                hop = 0.35 * (1 - u)
            for name in uppers + [n for n, r in role_of.items() if r == "leg_upper"]:
                rot[f, idx[name]] = quat_axis_angle(x_axis, crouch)
            for name in lowers:
                rot[f, idx[name]] = quat_axis_angle(x_axis, -crouch * 1.2)
            loc[f, root_i] = (0.0, 0.0, hop)

        elif clip_type == "hit":
            flinch = math.sin(min(1.0, t / 0.35) * math.pi) * 18
            for name in body_bones:
                rot[f, idx[name]] = quat_axis_angle(x_axis, -flinch)
            for name in head_bones:
                rot[f, idx[name]] = quat_axis_angle(x_axis, -flinch * 1.4)
            loc[f, root_i] = (0.0, flinch * 0.002, 0.0)

        elif clip_type == "death":
            # Collapse: legs buckle, body tips, settles.
            u = min(1.0, t / 0.85)
            tip = u * 55
            for name in body_bones:
                rot[f, idx[name]] = quat_axis_angle(x_axis, tip * 0.7)
            for name in uppers:
                rot[f, idx[name]] = quat_axis_angle(x_axis, tip)
            for name in lowers:
                rot[f, idx[name]] = quat_axis_angle(x_axis, -tip * 0.8)
            for name in segments:
                rot[f, idx[name]] = quat_axis_angle(x_axis, tip * 0.5)
            loc[f, root_i] = (0.0, u * 0.15, -u * 0.12)

        elif clip_type == "attack":
            # Wind-up then strike on the first arm or first front legs.
            strikers = arms_u or uppers[:2] or body_bones[:1]
            if t < 0.35:
                u = t / 0.35
                ang = -25 * u if attack != "slam" else 20 * u
            elif t < 0.55:
                u = (t - 0.35) / 0.2
                ang = (-25 + 70 * u) if attack != "slam" else (20 - 50 * u)
            else:
                u = (t - 0.55) / 0.45
                ang = (45 * (1 - u)) if attack != "slam" else (-30 * (1 - u))
            axis = z_axis if attack == "swipe" else x_axis
            for name in strikers:
                rot[f, idx[name]] = quat_axis_angle(axis, ang)
                tip = name + "Tip"
                if tip in idx:
                    rot[f, idx[tip]] = quat_axis_angle(x_axis, -abs(ang) * 0.4)

        # Soft chain undulation for chain kind on locomotion / idle.
        if kind == "chain" and clip_type in ("walk", "run", "idle"):
            for si, name in enumerate(segments):
                rot[f, idx[name]] = quat_axis_angle(z_axis, math.sin(phase + si * 0.6) * (amp if clip_type != "idle" else amp))

    label = name or (f"{clip_type}_{attack}" if clip_type == "attack" else clip_type)
    label = re.sub(r"[^\w .-]", "", label).strip()[:60] or clip_type
    return {"rot": rot, "loc": loc, "source": f"procedural:{clip_type}", "name": label.capitalize() if label.islower() else label}


def default_clip_list(kind: str) -> list[dict]:
    """A sensible starter set for a robot template."""
    clips = [
        {"type": "idle"},
        {"type": "walk", "gait": "tripod" if kind == "spider" else "wave"},
        {"type": "run", "gait": "tripod" if kind == "spider" else "wave"},
        {"type": "attack", "attack": "stab"},
        {"type": "attack", "attack": "swipe", "name": "Swipe"},
        {"type": "attack", "attack": "slam", "name": "Slam"},
        {"type": "hit"},
        {"type": "death"},
        {"type": "jump"},
    ]
    return clips
