"""Cuts a subject out of an image with a segmentation model (rembg).
Ported from Dose Of Destruction's tools/cutout.py.

    python cutout.py <image> <out.png> [--mode birefnet|isnet|union] [--glow] [--no-crop] [--pad 16]

Modes:
  birefnet  BiRefNet: the cleanest edges and solid dark clothing (default)
  isnet     ISNet: softer, keeps wisps but can let some backdrop through
  union     both masks combined, for wispy edges that fade into the backdrop
--glow      fire, lightning and glow on a black backdrop are light, not solid:
            their opacity comes from their brightness
Prints the crop box and size as JSON.
"""

import argparse
import json

from PIL import Image, ImageChops, ImageFilter

MODELS = {"birefnet": "birefnet-general", "isnet": "isnet-general-use"}
_sessions = {}


def mask(model, img):
    from rembg import new_session, remove

    if model not in _sessions:
        _sessions[model] = new_session(MODELS[model])
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
    a = ImageChops.lighter(mask("birefnet", img), mask("isnet", img)) if o.mode == "union" else mask(o.mode, img)
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
    print(json.dumps({"box": box, "size": out.size}))


if __name__ == "__main__":
    main()
