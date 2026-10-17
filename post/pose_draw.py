"""Draws OpenPose body skeletons (the colors and limb order ControlNet, DWPose and the video control models expect)
from the keypoints Blender wrote (post/blender/hawkes_blender.py, pose.json).

    python pose_draw.py <pose.json> <out_dir> [start_frame]

Writes <out_dir>/00001.png ... (numbered from start_frame, like Blender's frames), black where there is nobody.
Runs with any Python that has Pillow: Hawkes Gen's .venv, or ComfyUI's on a GPU server.
"""

import json
import math
import os
import sys

from PIL import Image, ImageDraw

COLORS = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0),
          (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255),
          (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85)]
# Pairs of keypoints (0-based), in OpenPose's drawing order.
LIMBS = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13),
         (1, 0), (0, 14), (14, 16), (0, 15), (15, 17)]


def limb(draw, a, b, width, col):
    """A filled ellipse from a to b, `width` across (OpenPose's stick)."""
    (x1, y1), (x2, y2) = a, b
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    length = math.hypot(x2 - x1, y2 - y1) / 2
    ang = math.atan2(y2 - y1, x2 - x1)
    pts = []
    for k in range(24):
        t = 2 * math.pi * k / 24
        ex, ey = length * math.cos(t), width * math.sin(t)
        pts.append((mx + ex * math.cos(ang) - ey * math.sin(ang), my + ex * math.sin(ang) + ey * math.cos(ang)))
    draw.polygon(pts, fill=col)


def frame(people, w, h):
    im = Image.new("RGB", (w, h), (0, 0, 0))
    draw = ImageDraw.Draw(im)
    stick = max(3, round(min(w, h) / 128))
    for kps in people:
        for i, (a, b) in enumerate(LIMBS):
            if kps[a][2] > 0 and kps[b][2] > 0:
                limb(draw, kps[a][:2], kps[b][:2], stick, tuple(int(c * 0.6) for c in COLORS[i]))
        for i, (x, y, c) in enumerate(kps):
            if c > 0:
                r = stick
                draw.ellipse((x - r, y - r, x + r, y + r), fill=COLORS[i])
    return im


def main():
    src, out = sys.argv[1], sys.argv[2]
    start = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    pose = json.load(open(src))
    os.makedirs(out, exist_ok=True)
    w, h = pose["width"], pose["height"]
    for i, people in enumerate(pose["frames"]):
        frame(people, w, h).save(os.path.join(out, f"{start + i:05d}.png"))
    print(len(pose["frames"]))


if __name__ == "__main__":
    main()
