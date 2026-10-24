"""Prepares inputs for GPU workflows. Called by Hawkes Gen's local tools.
Ported from Dose Of Destruction's tools/gpu/prep.py.

    python prep.py frame <image> <out.png> <width> <height> [fill] [color] [bottom]
        The image fitted into a width x height frame on a flat color (default
        green), feet near the bottom. Transparent cutouts are composited on.
        fill is the share of the frame's height the figure takes (0.78).

    python prep.py motion <video> <out.mp4> <width> <height> <max_frames> [fps]
        A driving video resampled to fps (16, the rate Wan makes), fitted into
        the frame and cut to at most max_frames. Prints the frame count.

    python prep.py canvas <out.png> <width> <height> [color]
        A flat canvas to paint on.

    python prep.py split <sheet> <n> <out1> ... <outn>
        A sheet of n views side by side cut into n equal panels by its width, left to right.

    python prep.py views <size> <pad> <in1> ... <in4> <out1> ... <out4>
        Views of one object framed the way Pixal3D wants them: each cut out (its alpha, or what differs from the
        border's color), on black, square, every view at the same scale (the object's height is the same in each,
        as it is from any side at eye level) and the widest spanning 1/pad of the frame. Prints JSON per view.

    python prep.py panel <image> <out.png> <cell> <n> <index> [color]
        A canvas of n square cells side by side on a flat color with the image fitted into cell index.

    python prep.py inspect <image>
        JSON: size, whether it has transparency, and whether it looks like a black and white mask.
"""

import json
import subprocess
import sys

from PIL import Image


def rgb(color):
    color = color.lstrip("#")
    return tuple(int(color[i:i + 2], 16) for i in (0, 2, 4))


def frame(src, out, width, height, fill=0.78, color="00ff00", bottom=0.06):
    im = Image.open(src).convert("RGBA")
    box = im.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox()
    if box:
        im = im.crop(box)
    scale = min(height * fill / im.height, width * 0.92 / im.width)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (width, height), (*rgb(color), 255))
    canvas.alpha_composite(im, ((width - im.width) // 2, height - round(height * bottom) - im.height))
    canvas.convert("RGB").save(out)


def fit(src, out, width, height, color="e6e6e6"):
    im = Image.open(src).convert("RGBA")
    scale = min(width / im.width, height / im.height)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (width, height), (*rgb(color), 255))
    canvas.alpha_composite(im, ((width - im.width) // 2, (height - im.height) // 2))
    canvas.convert("RGB").save(out)


def motion(src, out, width, height, max_frames, fps=16):
    vf = f"fps={fps},scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vf", vf, "-frames:v", str(max_frames),
                    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", out], check=True)
    probe = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "json", out],
                           check=True, capture_output=True, text=True)
    print(json.loads(probe.stdout)["streams"][0]["nb_read_frames"])


def canvas(out, width, height, color="808080"):
    Image.new("RGB", (width, height), rgb(color)).save(out)


def cutout(im):
    """(RGBA on black, alpha) for a view: its own alpha when it has transparency, else what differs from the border."""
    from PIL import ImageChops
    im = im.convert("RGBA")
    alpha = im.getchannel("A")
    if alpha.getextrema()[0] >= 250:
        rgbim = im.convert("RGB")
        w, h = rgbim.size
        border = [rgbim.getpixel((x, y)) for x in (0, w // 2, w - 1) for y in (0, h // 2, h - 1) if (x, y) != (w // 2, h // 2)]
        bg = max(set(border), key=border.count)
        diff = ImageChops.difference(rgbim, Image.new("RGB", rgbim.size, bg))
        r, g, b = diff.split()
        d = ImageChops.lighter(ImageChops.lighter(r, g), b)
        alpha = d.point(lambda v: 0 if v < 10 else 255 if v > 34 else (v - 10) * 255 // 24)
    black = Image.new("RGBA", im.size, (0, 0, 0, 255))
    black.paste(im.convert("RGB"), (0, 0), alpha)
    return black.convert("RGB"), alpha


def split(sheet, n, outs):
    im = Image.open(sheet)
    w, h = im.size
    for i, out in enumerate(outs[:n]):
        im.crop((round(i * w / n), 0, round((i + 1) * w / n), h)).save(out)


def views(size, pad, ins, outs):
    cuts = []
    for f in ins:
        rgbim, alpha = cutout(Image.open(f))
        box = alpha.point(lambda v: 255 if v > 127 else 0).getbbox()
        if not box:
            sys.exit(f"no object found in {f} (empty or the same color as its background)")
        cuts.append((rgbim, alpha, box))
    # In units of each view's own object height: the frame is the widest view (or the height) times pad.
    extent = max(max((b[2] - b[0]) / (b[3] - b[1]), 1.0) for _, _, b in cuts) * pad
    info = []
    for (rgbim, alpha, b), out in zip(cuts, outs):
        bw, bh = b[2] - b[0], b[3] - b[1]
        k = size / (extent * bh)
        obj = rgbim.crop(b).resize((max(1, round(bw * k)), max(1, round(bh * k))), Image.LANCZOS)
        a = alpha.crop(b).resize(obj.size, Image.LANCZOS)
        frame = Image.new("RGB", (size, size), (0, 0, 0))
        frame.paste(obj, ((size - obj.width) // 2, (size - obj.height) // 2), a)
        frame.save(out)
        info.append({"box": list(b), "height": bh, "scale": round(k, 4), "size": [obj.width, obj.height]})
    hs = [x["height"] for x in info]
    print(json.dumps({"views": info, "heightRatio": round(max(hs) / min(hs), 3)}))


def panel(src, out, cell, n, index, color="e6e6e6"):
    im = Image.open(src).convert("RGBA")
    scale = min(cell / im.width, cell / im.height)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (cell * n, cell), (*rgb(color), 255))
    canvas.alpha_composite(im, (index * cell + (cell - im.width) // 2, (cell - im.height) // 2))
    canvas.convert("RGB").save(out)


def inspect(f):
    im = Image.open(f)
    rgba = im.convert("RGBA")
    transparent = rgba.getchannel("A").getextrema()[0] < 250
    small = rgba.convert("RGB").resize((64, 64))
    raw = small.tobytes()
    px = [raw[i:i + 3] for i in range(0, len(raw), 3)]
    bw = sum(1 for p in px if max(p) - min(p) < 12 and (max(p) < 24 or min(p) > 232))
    print(json.dumps({"width": im.width, "height": im.height, "transparent": transparent, "mask": (not transparent) and bw / len(px) > 0.97}))


def main():
    cmd, a = sys.argv[1], sys.argv[2:]
    if cmd == "frame":
        frame(a[0], a[1], int(a[2]), int(a[3]), float(a[4]) if len(a) > 4 else 0.78, a[5] if len(a) > 5 else "00ff00", float(a[6]) if len(a) > 6 else 0.06)
    elif cmd == "fit":
        fit(a[0], a[1], int(a[2]), int(a[3]), a[4] if len(a) > 4 else "e6e6e6")
    elif cmd == "motion":
        motion(a[0], a[1], int(a[2]), int(a[3]), int(a[4]), int(a[5]) if len(a) > 5 else 16)
    elif cmd == "canvas":
        canvas(a[0], int(a[1]), int(a[2]), a[3] if len(a) > 3 else "808080")
    elif cmd == "split":
        split(a[0], int(a[1]), a[2:])
    elif cmd == "views":
        n = (len(a) - 2) // 2
        views(int(a[0]), float(a[1]), a[2:2 + n], a[2 + n:2 + 2 * n])
    elif cmd == "panel":
        panel(a[0], a[1], int(a[2]), int(a[3]), int(a[4]), a[5] if len(a) > 5 else "e6e6e6")
    elif cmd == "inspect":
        inspect(a[0])
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
