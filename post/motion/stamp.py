# After generation: record which model wrote the BVH, and point the retarget at the matching bone names.
# Kimodo's BVH is SOMA (already in spec.json). HY-Motion's BVH is SMPL joint names.

import json
import pathlib

backend = pathlib.Path("out/bvhs/backend.txt").read_text().strip()
want = int(pathlib.Path("takes.txt").read_text().strip())
got = len(list(pathlib.Path("out/bvhs").glob("take-*.bvh")))
if got != want:
    raise SystemExit(f"wanted {want} takes, got {got}")
spec = pathlib.Path("spec.json")
if spec.exists() and backend == "hymotion":
    p = json.loads(spec.read_text())
    for o in p.get("ops") or []:
        if o.get("op") == "retarget":
            o["from"] = "smpl"
    spec.write_text(json.dumps(p, indent=1))
print("backend", backend)
