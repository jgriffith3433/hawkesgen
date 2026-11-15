# Runs hawkes_character.py's bone-naming part (canon_map and its tables) without Blender, on fake armatures.
# usage: python check_canon_map.py post/blender/hawkes_character.py   -> prints JSON
import json, re, sys, types

src = open(sys.argv[1], encoding="utf-8").read()
a = src.index("# ---------------------------------------------------------------- bone names")
b = src.index("# ---------------------------------------------------------------- the character")
ns = {"re": re}
def fail(msg):
    raise SystemExit("fail: " + msg)
ns["fail"] = fail
exec(src[a:b], ns)

def rig(names):
    bones = {n: types.SimpleNamespace(name=n) for n in names}
    class Bones(list):
        def __contains__(self, n):
            return n in bones
    return types.SimpleNamespace(name="Rig", data=types.SimpleNamespace(bones=Bones(bones.values())))

SIDES = ("Left", "Right")
unity = ["Hips", "Spine", "Chest", "Neck", "Head"]
for s in SIDES:
    unity += [f"{s}Shoulder", f"{s}UpperArm", f"{s}LowerArm", f"{s}Hand", f"{s}UpperLeg", f"{s}LowerLeg", f"{s}Foot", f"{s}Toes"]
mixamo_fingers = [f"{s}Hand{f}{k}" for s in SIDES for f in ("Thumb", "Index", "Middle", "Ring", "Pinky") for k in (1, 2, 3, 4)]
mixamo = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"]
for s in SIDES:
    mixamo += [f"{s}Shoulder", f"{s}Arm", f"{s}ForeArm", f"{s}Hand", f"{s}UpLeg", f"{s}Leg", f"{s}Foot", f"{s}ToeBase"]
mixamo = ["mixamorig:" + n for n in mixamo + mixamo_fingers]

out = {}
for name, names in (("unity", unity), ("mixed", unity + mixamo_fingers), ("mixamo", mixamo)):
    m, scheme = ns["canon_map"](rig(names))
    out[name] = {"scheme": scheme, "map": m, "limbs": [c for c in ns["LIMBS"] if c in m]}
# An explicit map still wins, and a scheme can still be forced.
m, scheme = ns["canon_map"](rig(unity + mixamo_fingers), "unity")
out["forced"] = {"scheme": scheme, "hasFinger": "LeftHandIndex1" in m}
print(json.dumps(out))
