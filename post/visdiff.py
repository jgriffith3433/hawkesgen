"""Perceptual difference between screenshots of the same moment in two playtest runs. Called by playtest.run.

    python visdiff.py <pairs.json> <out_dir>
        pairs.json is a list of {"a": previous.jpg, "b": current.jpg}. Prints a JSON list, one per pair:
        {"score": 0..1 (1 - SSIM: 0 = the same, 1 = nothing alike), "ssim", "changed" (share of the screen that
        changed visibly), "diff": out_dir/diff-<i>.jpg (previous | current | current with the changes in red)}.

Both images are compared in grayscale at 320 px wide, after a light blur, so compression noise and a few moved pixels
don't count; layout, color and content changes do.
"""

import json
import os
import sys

import numpy as np
from PIL import Image

WIDTH = 320


def box(x, r=3):
    """Mean over a (2r+1)^2 window (edges repeated), with an integral image."""
    k = 2 * r + 1
    p = np.pad(x, r, mode="edge")
    c = np.pad(p.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def gray(im, size):
    return np.asarray(im.convert("L").resize(size, Image.BILINEAR), dtype=np.float64)


def compare(a_path, b_path, out):
    b_im = Image.open(b_path).convert("RGB")
    a_im = Image.open(a_path).convert("RGB")
    h = max(1, round(WIDTH * b_im.height / b_im.width))
    size = (WIDTH, h)
    a = box(gray(a_im, size), 1)
    b = box(gray(b_im, size), 1)
    mu_a, mu_b = box(a), box(b)
    va = box(a * a) - mu_a ** 2
    vb = box(b * b) - mu_b ** 2
    cov = box(a * b) - mu_a * mu_b
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    ssim_map = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (va + vb + c2))
    ssim = float(np.clip(ssim_map.mean(), -1, 1))
    changed_mask = (np.abs(mu_a - mu_b) > 20) | (ssim_map < 0.5)
    changed = float(changed_mask.mean())

    # previous | current | current, dimmed, with the changes in red
    a_small = a_im.resize(size, Image.BILINEAR)
    b_small = b_im.resize(size, Image.BILINEAR)
    heat = np.asarray(b_small, dtype=np.float64) * 0.45
    heat[changed_mask] = heat[changed_mask] * 0.4 + np.array([255, 40, 40]) * 0.6
    sheet = Image.new("RGB", (WIDTH * 3 + 8, h), (20, 24, 28))
    sheet.paste(a_small, (0, 0))
    sheet.paste(b_small, (WIDTH + 4, 0))
    sheet.paste(Image.fromarray(heat.astype(np.uint8)), (WIDTH * 2 + 8, 0))
    sheet.save(out, quality=85)
    return {"score": round(min(1.0, max(0.0, 1 - ssim)), 4), "ssim": round(ssim, 4), "changed": round(changed, 4), "diff": out}


def main():
    pairs = json.load(open(sys.argv[1], encoding="utf-8"))
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    results = []
    for i, pair in enumerate(pairs):
        try:
            results.append(compare(pair["a"], pair["b"], os.path.join(out_dir, f"diff-{i:03d}.jpg")))
        except Exception as e:  # one unreadable image doesn't spoil the rest
            results.append({"score": 0, "ssim": None, "changed": 0, "diff": None, "error": str(e)[:200]})
    print(json.dumps(results))


if __name__ == "__main__":
    main()
