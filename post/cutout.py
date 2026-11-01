"""Cuts a subject out of an image with a segmentation model (rembg).
Ported from Dose Of Destruction's tools/cutout.py.

    python cutout.py <image> <out.png> [--mode birefnet|isnet|union] [--glow] [--no-crop] [--pad 16]

Modes:
  birefnet  BiRefNet: the cleanest edges and solid dark clothing (default)
  isnet     ISNet: softer, keeps wisps but can let some backdrop through
  union     both masks combined, for wispy edges that fade into the backdrop
--glow      fire, lightning and glow on a black backdrop are light, not solid:
            their opacity comes from their brightness
Prints the crop box and size as JSON, and the model that made the mask.

BiRefNet needs about 8.5 GB of memory while it runs (measured 2026-11-01: 8.5 GB peak at 1024 px with onnxruntime's
arena off, 9.8 GB with it on); ISNet about 1.3 GB. A machine without room for BiRefNet (beta Gen's 4 GiB Cloud Run
instance) used to be killed mid-run with a blank error, so there the mask comes from ISNet and the JSON says so
("model", "fallback"). HAWKESGEN_BIREFNET_GB sets the room BiRefNet needs (default 9).
"""

import argparse
import json
import os

from PIL import Image, ImageChops, ImageFilter

MODELS = {"birefnet": "birefnet-general", "isnet": "isnet-general-use"}
_sessions = {}


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def free_gb():
    """Memory this process can still use, in GB: the container's limit (cgroup v2 or v1) and the machine's own."""
    seen = []
    info = {}
    for line in (_read("/proc/meminfo") or "").splitlines():
        k, _, v = line.partition(":")
        if v.strip().endswith("kB"):
            info[k] = int(v.split()[0]) * 1024
    if "MemAvailable" in info:
        seen.append(info["MemAvailable"])
    for limit, used, stat in (
        ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.stat"),
        ("/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory/memory.stat"),
    ):
        lim, cur = _read(limit), _read(used)
        if not lim or not cur or not lim.isdigit() or not cur.isdigit() or int(lim) >= 1 << 60:
            continue
        # Page cache the kernel can drop doesn't count as used.
        cache = 0
        for line in (_read(stat) or "").splitlines():
            k, _, v = line.partition(" ")
            if k in ("inactive_file", "total_inactive_file") and v.isdigit():
                cache = int(v)
        seen.append(int(lim) - max(0, int(cur) - cache))
        break
    return min(seen) / 1e9 if seen else None


def pick_mode(mode):
    """The mode to run here, and why it changed: BiRefNet only where it has room."""
    if mode == "isnet":
        return mode, None
    need = float(os.environ.get("HAWKESGEN_BIREFNET_GB") or 9)
    have = free_gb()
    if have is None or have >= need:
        return mode, None
    return "isnet", f"BiRefNet needs about {need:g} GB of memory and this machine has {have:.1f} GB free, so ISNet made the mask"


def mask(model, img):
    import onnxruntime as ort
    from rembg import new_session, remove

    if model not in _sessions:
        # No memory arena or pattern planning: the same speed, about 1.3 GB less at BiRefNet's peak.
        opts = ort.SessionOptions()
        opts.enable_cpu_mem_arena = False
        opts.enable_mem_pattern = False
        _sessions[model] = new_session(MODELS[model], sess_opts=opts)
    return remove(img, session=_sessions[model], only_mask=True)


def unmultiply_glow(img, a):
    """Lift light off a black backdrop: opacity from brightness, color divided by it."""
    r, g, b = img.split()
    peak = ImageChops.lighter(ImageChops.lighter(r, g), b)
    glow = peak.point(lambda v: 0 if v < 24 else min(255, int((v - 24) * 255 / 200)))
    alpha = ImageChops.lighter(a, glow)
    out = Image.new("RGBA", img.size)
    src, al, ml, dst = img.load(), alpha.load(), a.load(), out.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            av = al[x, y]
            if av == 0:
                dst[x, y] = (0, 0, 0, 0)
                continue
            rr, gg, bb = src[x, y]
            if ml[x, y] >= av:
                dst[x, y] = (rr, gg, bb, av)
            else:
                k = 255 / av
                dst[x, y] = (min(255, int(rr * k)), min(255, int(gg * k)), min(255, int(bb * k)), av)
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("out")
    p.add_argument("--mode", default="birefnet", choices=["birefnet", "isnet", "union"])
    p.add_argument("--glow", action="store_true")
    p.add_argument("--no-crop", action="store_true")
    p.add_argument("--pad", type=int, default=16)
    o = p.parse_args()
    img = Image.open(o.src).convert("RGB")
    mode, fallback = pick_mode(o.mode)
    a = ImageChops.lighter(mask("birefnet", img), mask("isnet", img)) if mode == "union" else mask(mode, img)
    # Drop the faint haze a model leaves in empty backdrop.
    a = a.resize(img.size, Image.BILINEAR).point(lambda v: 0 if v < 10 else v)
    if o.glow:
        out = unmultiply_glow(img, a)
        a = out.getchannel("A")
    else:
        out = img.convert("RGBA")
        out.putalpha(a)
    box = None
    if not o.no_crop:
        box = a.point(lambda v: 255 if v > 40 else 0).filter(ImageFilter.MaxFilter(5)).getbbox()
        if box:
            box = (max(0, box[0] - o.pad), max(0, box[1] - o.pad), min(out.width, box[2] + o.pad), min(out.height, box[3] + o.pad))
            out = out.crop(box)
    out.save(o.out)
    result = {"box": box, "size": out.size, "model": mode}
    if fallback:
        result["fallback"] = fallback
    print(json.dumps(result))


if __name__ == "__main__":
    main()
