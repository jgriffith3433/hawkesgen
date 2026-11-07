"""The automatic check every generated humanoid clip gets before anyone watches it (motion.check, and inside
motion.from-text / motion.from-video). Plain Python, no packages: it runs in any Python on a worker, a fleet server or
Gen's own machine.

    python check.py clip.bvh [--loop] [--in-place] [--json out.json]

Reads a BVH (SOMA, SMPL, Mixamo or classic names; any rotation order), runs forward kinematics, and measures:

  footSkate      how fast a planted foot slides (m/s while it is on the ground and not lifting)
  penetration    how far a foot goes below the ground the clip stands on (m)
  pops           frames where a joint jumps more than a body part can move in one frame
  jitter         high-frequency shake: the mean jerk of the joints, scaled to the body (lower is smoother)
  loopSeam       with --loop: how far the last pose is from the first (m, root-relative)
  travel         how far the hips move over the ground (m); with --in-place it should be near 0
  heightRange    the hips' vertical range (a jump, a fall)

and prints {"ok", "problems": [...], "metrics": {...}, "fix": "..."} as JSON. A problem names the measurement, the
threshold and what to try ("more takes", "turn on inPlace", ...). The thresholds are for game clips at 24-60 fps.
"""

import json
import math
import sys

FOOT_WORDS = ("foot", "toe", "ankle")
LIMIT = {"footSkate": 0.25, "penetration": 0.03, "jitter": 1.0, "loopSeam": 0.05, "inPlaceTravel": 0.15}


def parse_bvh(text):
    lines = [ln.strip() for ln in text.splitlines()]
    joints, stack, i = [], [], 0
    while i < len(lines) and not lines[i].startswith("MOTION"):
        parts = lines[i].split()
        if not parts:
            i += 1
            continue
        if parts[0] in ("ROOT", "JOINT"):
            joints.append({"name": " ".join(parts[1:]), "parent": stack[-1] if stack else -1, "offset": (0.0, 0.0, 0.0), "channels": []})
            pending = len(joints) - 1
        elif parts[0] == "End":
            joints.append({"name": None, "parent": stack[-1], "offset": (0.0, 0.0, 0.0), "channels": []})
            pending = len(joints) - 1
        elif parts[0] == "{":
            stack.append(pending)
        elif parts[0] == "}":
            stack.pop()
        elif parts[0] == "OFFSET":
            joints[stack[-1]]["offset"] = tuple(float(x) for x in parts[1:4])
        elif parts[0] == "CHANNELS":
            joints[stack[-1]]["channels"] = parts[2:2 + int(parts[1])]
        i += 1
    if i >= len(lines):
        raise ValueError("no MOTION section")
    frames = int(lines[i + 1].split(":")[1])
    dt = float(lines[i + 2].split(":")[1])
    data = [[float(x) for x in ln.split()] for ln in lines[i + 3:i + 3 + frames] if ln]
    return joints, data, dt


def rot(axis, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    if axis == "X":
        return ((1, 0, 0), (0, c, -s), (0, s, c))
    if axis == "Y":
        return ((c, 0, s), (0, 1, 0), (-s, 0, c))
    return ((c, -s, 0), (s, c, 0), (0, 0, 1))


def mul(a, b):
    return tuple(tuple(sum(a[r][k] * b[k][c] for k in range(3)) for c in range(3)) for r in range(3))


def apply(m, v):
    return tuple(sum(m[r][k] * v[k] for k in range(3)) for r in range(3))


def fk(joints, data):
    """World positions per frame: [frame][joint] -> (x, y, z), BVH units."""
    out = []
    for row in data:
        k = 0
        world_r, world_p = [None] * len(joints), [None] * len(joints)
        for j, jt in enumerate(joints):
            local_p = list(jt["offset"])
            r = ((1, 0, 0), (0, 1, 0), (0, 0, 1))
            for ch in jt["channels"]:
                v = row[k]
                k += 1
                if ch.endswith("position"):
                    local_p["XYZ".index(ch[0])] = v + (jt["offset"]["XYZ".index(ch[0])] if jt["parent"] >= 0 else 0.0)
                else:
                    r = mul(r, rot(ch[0], v))
            if jt["parent"] < 0:
                world_r[j], world_p[j] = r, tuple(local_p)
            else:
                pr, pp = world_r[jt["parent"]], world_p[jt["parent"]]
                world_r[j] = mul(pr, r)
                q = apply(pr, local_p)
                world_p[j] = (pp[0] + q[0], pp[1] + q[1], pp[2] + q[2])
        out.append(world_p)
    return out


def dist(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def check(text, loop=False, in_place=False):
    joints, data, dt = parse_bvh(text)
    if len(data) < 3:
        raise ValueError("the clip has fewer than three frames")
    fps = 1.0 / dt
    names = [j["name"] for j in joints]
    pos = fk(joints, data)
    real = [i for i, n in enumerate(names) if n]
    # Hips: the first real joint that isn't a wrapper at the origin (Kimodo's BVH has a "Root" wrapper over Hips).
    hips = next((i for i in real if "hip" in names[i].lower() or "pelvis" in names[i].lower()), real[0])
    # Y up for BVH; scale from the standing body: hips height at the first frame over the lowest foot.
    feet = [i for i in real if any(w in names[i].lower() for w in FOOT_WORDS) and "end" not in names[i].lower()]
    up = 1
    lowest = lambda f: min(pos[f][i][up] for i in feet) if feet else min(pos[f][i][up] for i in real)  # noqa: E731
    hip_h = pos[0][hips][up] - lowest(0)
    # Units: meters if the hips stand under 3 units, else centimeters (Kimodo and Mixamo BVHs are in cm).
    unit = 1.0 if 0.3 < hip_h < 3.0 else 0.01
    n = len(pos)
    P = [[tuple(c * unit for c in pos[f][i]) for i in range(len(names))] for f in range(n)]
    body = max(0.5, hip_h * unit * 2.0)  # about the body's height, for scaling

    ground = sorted(min(P[f][i][up] for i in feet) for f in range(n))[max(0, n // 20)] if feet else 0.0
    metrics = {"frames": n, "fps": round(fps, 2), "seconds": round(n * dt, 3), "joints": len(real), "unitMeters": unit}

    # Foot skating: a foot within 3 cm of the ground and not rising is planted; how fast does it slide sideways?
    skate, planted = [], 0
    for i in feet:
        for f in range(1, n):
            a, b = P[f - 1][i], P[f][i]
            if b[up] - ground < 0.03 and abs(b[up] - a[up]) * fps < 0.1:
                planted += 1
                skate.append(math.hypot(b[0] - a[0], b[2] - a[2]) * fps)
    metrics["footSkate"] = round(sum(skate) / len(skate), 3) if skate else 0.0
    metrics["plantedShare"] = round(planted / max(1, len(feet) * (n - 1)), 3)
    metrics["penetration"] = round(max(0.0, ground - min(min(P[f][i][up] for i in feet) for f in range(n))), 3) if feet else 0.0

    # Pops: a joint moving faster than 12 m/s between two frames (no limb does in a game clip).
    pops = []
    for f in range(1, n):
        for i in real:
            if dist(P[f][i], P[f - 1][i]) * fps > 12.0:
                pops.append(f)
                break
    metrics["pops"] = len(pops)
    if pops:
        metrics["popFrames"] = pops[:10]

    # Jitter: mean third difference of the joints, in body heights per second cubed, scaled so smooth mocap sits near 0.1.
    jerk, count = 0.0, 0
    for f in range(3, n):
        for i in real:
            d = [P[f][i][c] - 3 * P[f - 1][i][c] + 3 * P[f - 2][i][c] - P[f - 3][i][c] for c in range(3)]
            jerk += math.sqrt(sum(x * x for x in d))
            count += 1
    metrics["jitter"] = round((jerk / max(1, count)) * fps ** 3 / body / 1000.0, 3)

    rel = lambda f: [tuple(P[f][i][c] - P[f][hips][c] for c in range(3)) for i in real]  # noqa: E731
    first, last = rel(0), rel(n - 1)
    metrics["loopSeam"] = round(sum(dist(first[k], last[k]) for k in range(len(real))) / len(real), 3)
    metrics["travel"] = round(math.hypot(P[-1][hips][0] - P[0][hips][0], P[-1][hips][2] - P[0][hips][2]), 3)
    hy = [P[f][hips][up] for f in range(n)]
    metrics["heightRange"] = round(max(hy) - min(hy), 3)

    problems, fixes = [], []
    if metrics["footSkate"] > LIMIT["footSkate"] and metrics["plantedShare"] > 0.05:
        problems.append(f"feet slide while planted ({metrics['footSkate']} m/s, over {LIMIT['footSkate']})")
        fixes.append("make more takes and keep the steadiest, or for a video source film the whole body with a still camera")
    if metrics["penetration"] > LIMIT["penetration"]:
        problems.append(f"a foot goes {metrics['penetration']} m below the ground (over {LIMIT['penetration']})")
        fixes.append("make another take")
    if metrics["pops"]:
        problems.append(f"{metrics['pops']} frame(s) where a joint jumps (first at frame {pops[0]})")
        fixes.append("make another take; for a video source, keep the person in frame the whole time")
    if metrics["jitter"] > LIMIT["jitter"]:
        problems.append(f"the motion shakes (jitter {metrics['jitter']}, over {LIMIT['jitter']})")
        fixes.append("make another take; for a video source, use a sharper, steadier clip")
    if loop and metrics["loopSeam"] > LIMIT["loopSeam"]:
        problems.append(f"the loop doesn't close (last pose {metrics['loopSeam']} m from the first)")
        fixes.append("ask for a cyclic move (an idle, a walk cycle) or let the loop op blend more frames")
    if in_place and metrics["travel"] > LIMIT["inPlaceTravel"]:
        problems.append(f"the clip travels {metrics['travel']} m but should stay in place")
        fixes.append("turn on inPlace (it removes the hips' travel after the retarget)")
    return {"ok": not problems, "problems": problems, "metrics": metrics, "fix": "; ".join(dict.fromkeys(fixes)) or None}


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    path = args[0]
    out = args[args.index("--json") + 1] if "--json" in args else None
    with open(path, encoding="utf-8", errors="replace") as fh:
        result = check(fh.read(), loop="--loop" in args, in_place="--in-place" in args)
    text = json.dumps(result)
    if out:
        with open(out, "w") as fh:
            fh.write(text)
    print(text)


if __name__ == "__main__":
    main()
