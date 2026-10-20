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
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
