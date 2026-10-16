"""Texture helpers for real-time materials (Babylon.js, Unity).

    python texture.py tile <image> <out.png> [blend]
        Makes an image tile seamlessly: it is crossfaded with a copy shifted by
        half its size, so the wrap seams land where the original is
        continuous. blend (0.05-0.5, default 0.25) is how wide the fade is.

    python texture.py maps <image> <outdir> [strength]
        From one albedo: albedo.png with baked lighting flattened, normal.png
        (height from luminance, OpenGL convention, +Y up) and roughness.png.
        Generalizes PH Origins' tools/derive_maps.py.
"""

import os
import sys

import numpy as np
from PIL import Image, ImageFilter

LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)


def tile(src, out, blend=0.25):
    im = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32)
    h, w, _ = im.shape
    shifted = np.roll(np.roll(im, h // 2, axis=0), w // 2, axis=1)

    def ramp(n):
        # 1 in the middle, falling to 0 at both edges.
        x = np.minimum(np.arange(n), np.arange(n)[::-1]) / max(1.0, n * blend)
        return np.clip(x, 0, 1)

    m = np.minimum.outer(ramp(h), ramp(w))[..., None]
    m = m * m * (3 - 2 * m)
    Image.fromarray(np.clip(im * m + shifted * (1 - m), 0, 255).astype(np.uint8)).save(out)


def blur(arr, radius):
    return np.asarray(Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0


def maps(src, outdir, strength=2.0):
    os.makedirs(outdir, exist_ok=True)
    img = Image.open(src).convert("RGB")
    a = np.asarray(img, dtype=np.float32) / 255.0
    lum = a @ LUMA
    # Flatten baked lighting: divide out a large blur of the luminance.
    low = blur(lum, max(4, min(img.size) // 8))
    flat = np.clip(a * (lum.mean() / np.maximum(low, 0.05))[..., None], 0, 1)
    Image.fromarray((flat * 255).astype(np.uint8)).save(os.path.join(outdir, "albedo.png"))
    # Height from the flattened luminance; differences wrap at the edges so tiles stay seamless.
    hgt = flat @ LUMA
    dx = (np.roll(hgt, -1, axis=1) - np.roll(hgt, 1, axis=1)) * strength
    dy = (np.roll(hgt, -1, axis=0) - np.roll(hgt, 1, axis=0)) * strength
    n = np.dstack([-dx, dy, np.ones_like(hgt)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8)).save(os.path.join(outdir, "normal.png"))
    # Rough where the surface is busy, a little smoother where it is flat and bright.
    detail = np.abs(hgt - blur(hgt, 2))
    rough = np.clip(0.55 + detail * 4 - (hgt - hgt.mean()) * 0.3, 0.05, 1)
    Image.fromarray((rough * 255).astype(np.uint8)).save(os.path.join(outdir, "roughness.png"))
    print(outdir)


def main():
    cmd, a = sys.argv[1], sys.argv[2:]
    if cmd == "tile":
        tile(a[0], a[1], float(a[2]) if len(a) > 2 else 0.25)
    elif cmd == "maps":
        maps(a[0], a[1], float(a[2]) if len(a) > 2 else 2.0)
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
