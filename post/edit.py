"""Pillow helpers for image.repaint and image.expand (src/tools/edit.ts). Every command prints one JSON line.

  edit.py bbox   <image> <mask>                                       -> {width, height, box | null, coverage}
  edit.py crop   <image> <mask> <x0,y0,x1,y1> <W> <H> <crop.png> <guide.png>
  edit.py paste  <image> <mask> <edited> <x0,y0,x1,y1> <feather> <out.png>
  edit.py pad    <image> <W> <H> <x,y,w,h> <out.png>
  edit.py seam   <image> <edited> <W> <H> <x,y,w,h> <feather> <out.png>

A mask may be either convention: white (or bright) on black, or opaque strokes on transparency. When the mask has real
transparency (some pixels clear, some solid) its alpha decides; otherwise its brightness does. Repaint where it is set.
"""
import json
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


def load_image(path):
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    return im


def mask_of(path, size):
    """The mask as 'L' (255 = repaint), at the image's size."""
    m = load_image(path)
    if m.mode in ("RGBA", "LA", "PA") or (m.mode == "P" and "transparency" in m.info):
        rgba = m.convert("RGBA")
        lo, hi = rgba.getchannel("A").getextrema()
        if lo < 128 <= hi:
            out = rgba.getchannel("A")
        else:
            out = rgba.convert("L")
    else:
        out = m.convert("L")
    if out.size != size:
        out = out.resize(size, Image.BILINEAR)
    return out


def binary(m):
    return m.point(lambda v: 255 if v >= 128 else 0)


def bbox(image, mask):
    im = load_image(image)
    m = binary(mask_of(mask, im.size))
    box = m.getbbox()
    hist = m.histogram()
    coverage = hist[255] / float(im.width * im.height)
    print(json.dumps({"width": im.width, "height": im.height, "box": list(box) if box else None, "coverage": round(coverage, 5)}))


def parse_box(s):
    return tuple(int(round(float(v))) for v in s.split(","))


def crop(image, mask, box, W, H, out, guide):
    im = load_image(image).convert("RGB")
    m = binary(mask_of(mask, im.size))
    b = parse_box(box)
    c = im.crop(b).resize((W, H), Image.LANCZOS)
    c.save(out)
    # The guide: the same crop with the area to change tinted and outlined in red, so the model knows where.
    cm = m.crop(b).resize((W, H), Image.NEAREST)
    tint = Image.new("RGB", (W, H), (255, 0, 0))
    g = Image.composite(Image.blend(c, tint, 0.35), c, cm)
    edge = cm.filter(ImageFilter.MaxFilter(5))
    edge = ImageChops.subtract(edge, cm.filter(ImageFilter.MinFilter(5)))
    g.paste(tint, (0, 0), edge)
    g.save(guide)
    print(json.dumps({"crop": list(b), "size": [W, H]}))


def soft_mask(m, feather):
    """Feathered inward: 0 at and outside the mask's edge, so nothing outside the mask changes."""
    if feather <= 0:
        return m
    r = max(1, int(feather // 2))
    inner = m.filter(ImageFilter.MinFilter(2 * r + 1)) if r > 0 else m
    soft = inner.filter(ImageFilter.GaussianBlur(r))
    return ImageChops.multiply(soft, m)


def paste(image, mask, edited, box, feather, out):
    src = load_image(image)
    has_alpha = src.mode in ("RGBA", "LA") or (src.mode == "P" and "transparency" in src.info)
    im = src.convert("RGBA")
    m = binary(mask_of(mask, im.size))
    b = parse_box(box)
    bw, bh = b[2] - b[0], b[3] - b[1]
    ed = load_image(edited).convert("RGBA").resize((bw, bh), Image.LANCZOS)
    # Never wider than a quarter of the mask's smaller side, or a thin mask would vanish.
    mb = m.getbbox()
    if mb:
        feather = min(feather, max(0, min(mb[2] - mb[0], mb[3] - mb[1]) // 4))
    alpha = soft_mask(m, feather).crop(b)
    layer = im.copy()
    region = im.crop(b)
    region = Image.composite(ed, region, alpha)
    if has_alpha:
        # Keep the original's transparency where it wasn't painted.
        a = Image.composite(Image.new("L", (bw, bh), 255), im.crop(b).getchannel("A"), alpha)
        region.putalpha(a)
    layer.paste(region, b[:2])
    if has_alpha:
        layer.save(out)
    else:
        layer.convert("RGB").save(out)
    print(json.dumps({"feather": feather}))


def edge_extend(im, W, H, x, y):
    """The image placed at (x, y) on a W x H canvas, its edge pixels stretched into the new area."""
    im = im.convert("RGB")
    w, h = im.size
    c = Image.new("RGB", (W, H))
    c.paste(im, (x, y))
    r, b = W - x - w, H - y - h
    if x:
        c.paste(im.crop((0, 0, 1, h)).resize((x, h)), (0, y))
    if r:
        c.paste(im.crop((w - 1, 0, w, h)).resize((r, h)), (x + w, y))
    # Rows above and below take the (already widened) first and last rows, so corners fill too.
    if y:
        c.paste(c.crop((0, y, W, y + 1)).resize((W, y)), (0, 0))
    if b:
        c.paste(c.crop((0, y + h - 1, W, y + h)).resize((W, b)), (0, y + h))
    return c


def pad(image, W, H, rect, out):
    x, y, w, h = parse_box(rect)
    im = load_image(image).convert("RGB").resize((w, h), Image.LANCZOS)
    ext = edge_extend(im, W, H, x, y)
    # Blur the new area hard (the stretched edges are streaks), keep the original sharp.
    blurred = ext.filter(ImageFilter.GaussianBlur(max(8, max(W, H) // 40)))
    canvas = blurred.copy()
    canvas.paste(im, (x, y))
    canvas.save(out)
    print(json.dumps({"size": [W, H], "rect": [x, y, w, h]}))


def seam(image, edited, W, H, rect, feather, out):
    x, y, w, h = parse_box(rect)
    im = load_image(image).convert("RGB").resize((w, h), Image.LANCZOS)
    ed = load_image(edited).convert("RGB").resize((W, H), Image.LANCZOS)
    # The original goes back over the model's picture, fading out only along sides that border new area.
    a = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(a)
    f = max(0, min(feather, w // 4, h // 4))
    sides = {"left": x > 0, "right": x + w < W, "top": y > 0, "bottom": y + h < H}
    for i in range(f):
        v = int(255 * (i + 1) / (f + 1))
        if sides["left"]:
            d.line([(i, 0), (i, h - 1)], fill=v)
        if sides["right"]:
            d.line([(w - 1 - i, 0), (w - 1 - i, h - 1)], fill=v)
    if f:
        # Top and bottom ramps multiply with the side ramps so the corners blend too.
        tb = Image.new("L", (w, h), 255)
        dt = ImageDraw.Draw(tb)
        for i in range(f):
            v = int(255 * (i + 1) / (f + 1))
            if sides["top"]:
                dt.line([(0, i), (w - 1, i)], fill=v)
            if sides["bottom"]:
                dt.line([(0, h - 1 - i), (w - 1, h - 1 - i)], fill=v)
        a = ImageChops.multiply(a, tb)
    ed.paste(im, (x, y), a)
    ed.save(out)
    print(json.dumps({"size": [W, H], "rect": [x, y, w, h], "feather": f}))


def main(argv):
    cmd = argv[0]
    if cmd == "bbox":
        bbox(argv[1], argv[2])
    elif cmd == "crop":
        crop(argv[1], argv[2], argv[3], int(argv[4]), int(argv[5]), argv[6], argv[7])
    elif cmd == "paste":
        paste(argv[1], argv[2], argv[3], argv[4], int(float(argv[5])), argv[6])
    elif cmd == "pad":
        pad(argv[1], int(argv[2]), int(argv[3]), argv[4], argv[5])
    elif cmd == "seam":
        seam(argv[1], argv[2], int(argv[3]), int(argv[4]), argv[5], int(float(argv[6])), argv[7])
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main(sys.argv[1:])
