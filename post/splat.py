"""Gaussian Splatting (.splat) builder and preview renderer. Called by Hawkes Gen's local splat.build tool.

Writes standard 32-byte-per-splat binary files (Antimatter15 / Babylon.js GaussianSplattingMesh format):
  - 3 x float32 (12 bytes): position (x, y, z)
  - 3 x float32 (12 bytes): scale (sx, sy, sz)
  - 4 x uint8   (4 bytes):  color (r, g, b, a)
  - 4 x uint8   (4 bytes):  rotation quaternion (w, x, y, z) mapped from [-1, 1] via round(q * 128 + 128)

Also renders a 2D preview PNG of the splat cloud so Claude (library.judge) and the Library UI can inspect takes.
"""

import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)
DOORS_X = [2.3, 6.8, 11.2, 15.7]
DOOR_HALF = 0.65


def quat_from_normal(nx, ny, nz):
    """Unit quaternion (w, x, y, z) rotating +Z (0, 0, 1) onto (nx, ny, nz)."""
    dot = np.clip(nz, -1.0, 1.0)
    w = np.sqrt((1.0 + dot) * 0.5)
    # Axis is cross((0, 0, 1), (nx, ny, nz)) = (-ny, nx, 0)
    ax = -ny
    ay = nx
    az = np.zeros_like(nx)
    norm = np.hypot(ax, ay)
    s = np.sqrt(np.maximum(0.0, 1.0 - w * w))
    safe = np.where(norm > 1e-6, norm, 1.0)
    qx = np.where(norm > 1e-6, ax / safe * s, 0.0)
    qy = np.where(norm > 1e-6, ay / safe * s, 0.0)
    qz = az
    # Handle antiparallel case (nz ~ -1)
    anti = dot < -0.9999
    if np.any(anti):
        w = np.where(anti, 0.0, w)
        qx = np.where(anti, 1.0, qx)
        qy = np.where(anti, 0.0, qy)
    q_norm = np.sqrt(w * w + qx * qx + qy * qy + qz * qz)
    q_norm = np.where(q_norm > 1e-8, q_norm, 1.0)
    return w / q_norm, qx / q_norm, qy / q_norm, qz / q_norm


def pack_splats(pos, scales, rgba, quats, max_splats, rng):
    """Packs arrays into the 32-byte .splat binary format, subsampling if over max_splats."""
    n = pos.shape[0]
    if n == 0:
        return b"", np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.float32), np.zeros((0, 4), dtype=np.uint8)
    if n > max_splats:
        # Importance-weighted subsample by alpha * max_scale so key surfaces stay dense
        weights = (rgba[:, 3].astype(np.float32) / 255.0) * np.max(scales, axis=1)
        w_sum = float(weights.sum())
        if w_sum > 0:
            probs = weights / w_sum
            idx = rng.choice(n, size=max_splats, replace=False, p=probs)
        else:
            idx = rng.choice(n, size=max_splats, replace=False)
        idx.sort()
        pos = pos[idx]
        scales = scales[idx]
        rgba = rgba[idx]
        quats = quats[idx]
        n = max_splats

    dtype = np.dtype([
        ("pos", "<f4", (3,)),
        ("scale", "<f4", (3,)),
        ("rgba", "u1", (4,)),
        ("rot", "u1", (4,)),
    ])
    assert dtype.itemsize == 32
    out = np.empty(n, dtype=dtype)
    out["pos"] = pos.astype(np.float32)
    out["scale"] = np.maximum(scales, 1e-4).astype(np.float32)
    out["rgba"] = np.clip(rgba, 0, 255).astype(np.uint8)
    q_norm = np.linalg.norm(quats, axis=1, keepdims=True)
    q_unit = quats / np.where(q_norm > 1e-8, q_norm, 1.0)
    out["rot"] = np.clip(np.round(q_unit * 128.0 + 128.0), 0, 255).astype(np.uint8)
    return out.tobytes(), out["pos"], out["scale"], out["rgba"]


class CloudBuilder:
    def __init__(self, rng):
        self.rng = rng
        self.pos = []
        self.scales = []
        self.rgba = []
        self.quats = []

    def add_patch(self, x0, x1, y0, y1, z0, z1, count, color, alpha=235, scale=(0.06, 0.06, 0.02), normal=(0.0, 1.0, 0.0), jitter=0.015, color_var=10):
        if count <= 0:
            return
        u = self.rng.uniform(0.0, 1.0, count).astype(np.float32)
        v = self.rng.uniform(0.0, 1.0, count).astype(np.float32)
        w = self.rng.uniform(0.0, 1.0, count).astype(np.float32)
        px = x0 + (x1 - x0) * u + self.rng.normal(0.0, jitter, count).astype(np.float32)
        py = y0 + (y1 - y0) * v + self.rng.normal(0.0, jitter, count).astype(np.float32)
        pz = z0 + (z1 - z0) * w + self.rng.normal(0.0, jitter, count).astype(np.float32)
        p = np.column_stack([px, py, pz])

        sc = np.broadcast_to(np.array(scale, dtype=np.float32), (count, 3)).copy()
        sc *= self.rng.uniform(0.8, 1.25, (count, 1)).astype(np.float32)

        c = np.broadcast_to(np.array(color, dtype=np.float32), (count, 3)).copy()
        if color_var > 0:
            c += self.rng.normal(0.0, color_var, (count, 3)).astype(np.float32)
        a = np.full((count, 1), alpha, dtype=np.float32)
        col = np.clip(np.hstack([c, a]), 0, 255).astype(np.uint8)

        nx = np.full(count, normal[0], dtype=np.float32)
        ny = np.full(count, normal[1], dtype=np.float32)
        nz = np.full(count, normal[2], dtype=np.float32)
        qw, qx, qy, qz = quat_from_normal(nx, ny, nz)
        q = np.column_stack([qw, qx, qy, qz])

        self.pos.append(p)
        self.scales.append(sc)
        self.rgba.append(col)
        self.quats.append(q)

    def finish(self):
        if not self.pos:
            return (
                np.zeros((0, 3), dtype=np.float32),
                np.zeros((0, 3), dtype=np.float32),
                np.zeros((0, 4), dtype=np.uint8),
                np.zeros((0, 4), dtype=np.float32),
            )
        return (
            np.vstack(self.pos),
            np.vstack(self.scales),
            np.vstack(self.rgba),
            np.vstack(self.quats),
        )


def add_tunnel(b, density=1.0):
    """Subway tunnel outside the car: x=-4..22, z=+-2.55, trackbed below, concrete ribs, cables, warm lamps every 11m."""
    k = lambda n: max(8, int(round(n * density)))
    # Trackbed ballast and ties (y = -0.65, z = -2.55..2.55)
    b.add_patch(-4.0, 22.0, -0.68, -0.62, -2.55, 2.55, k(12000), (24, 22, 20), alpha=245, scale=(0.14, 0.03, 0.12), normal=(0, 1, 0), color_var=6)
    for tx in np.arange(-3.5, 21.8, 0.65):
        b.add_patch(float(tx - 0.12), float(tx + 0.12), -0.63, -0.60, -1.3, 1.3, k(70), (46, 38, 30), alpha=240, scale=(0.06, 0.02, 0.10), normal=(0, 1, 0), color_var=5)
    # Steel running rails + third rail
    for rz in (-0.72, 0.72, -1.15):
        b.add_patch(-4.0, 22.0, -0.58, -0.55, rz - 0.03, rz + 0.03, k(1400), (120, 124, 130), alpha=250, scale=(0.12, 0.02, 0.025), normal=(0, 1, 0), color_var=8)

    # Tunnel walls at z = -2.55 and z = +2.55, height y = -0.6..3.3
    for side in (-1.0, 1.0):
        wz = side * 2.55
        n = (0.0, 0.0, -side)
        b.add_patch(-4.0, 22.0, -0.6, 3.3, wz - 0.04, wz + 0.04, k(14000), (34, 35, 34), alpha=240, scale=(0.14, 0.14, 0.03), normal=n, color_var=8)
        # Concrete ribs every 1.5m
        for rx in np.arange(-3.0, 21.5, 1.5):
            b.add_patch(float(rx - 0.08), float(rx + 0.08), -0.5, 3.2, wz - side * 0.08, wz, k(240), (54, 55, 52), alpha=245, scale=(0.05, 0.11, 0.04), normal=n, color_var=6)
        # Conduit cables along the wall (y = 0.55, 0.70, 2.25)
        for cy in (0.55, 0.70, 2.25):
            b.add_patch(-4.0, 22.0, cy - 0.02, cy + 0.02, wz - side * 0.05, wz, k(900), (16, 16, 18), alpha=250, scale=(0.10, 0.02, 0.02), normal=n, color_var=3)
        # Tunnel lamps every 11m (staggered on south side)
        offset = 5.5 if side < 0 else 0.0
        for lx in np.arange(-2.0 + offset, 21.5, 11.0):
            # Warm halo + bright core
            b.add_patch(float(lx - 0.45), float(lx + 0.45), 1.45, 2.05, wz - side * 0.12, wz - side * 0.02, k(380), (235, 185, 115), alpha=150, scale=(0.12, 0.10, 0.05), normal=n, color_var=10)
            b.add_patch(float(lx - 0.15), float(lx + 0.15), 1.68, 1.82, wz - side * 0.14, wz - side * 0.06, k(180), (255, 238, 195), alpha=250, scale=(0.05, 0.04, 0.03), normal=n, color_var=5)

    # Green signal on the south wall
    b.add_patch(8.8, 9.1, 0.98, 1.15, -2.48, -2.40, k(220), (35, 245, 95), alpha=245, scale=(0.05, 0.05, 0.04), normal=(0, 0, 1), color_var=6)
    # Tunnel ceiling arch (y = 3.25..3.45)
    b.add_patch(-4.0, 22.0, 3.25, 3.40, -2.55, 2.55, k(6000), (20, 21, 23), alpha=235, scale=(0.18, 0.04, 0.16), normal=(0, -1, 0), color_var=4)


def add_station(b, density=1.0):
    """North station platform at z=1.9..6.5 (matches Level 7 stop: white/wet tiles, green band, blank name tablets, pillars, dark stairs)."""
    k = lambda n: max(8, int(round(n * density)))
    # Wet concrete platform deck (x = -2..20, y = -0.05..0.02, z = 1.9..6.5)
    b.add_patch(-2.0, 20.0, -0.04, 0.01, 1.95, 6.5, k(18000), (108, 106, 100), alpha=245, scale=(0.11, 0.02, 0.11), normal=(0, 1, 0), color_var=9)
    # Wet sheen / puddle reflections on the platform
    for px, pz in ((3.5, 2.9), (9.0, 3.4), (11.2, 2.6), (14.8, 3.8)):
        b.add_patch(px - 1.1, px + 1.1, 0.01, 0.02, pz - 0.7, pz + 0.7, k(700), (155, 165, 160), alpha=170, scale=(0.09, 0.01, 0.09), normal=(0, 1, 0), color_var=8)
    # Yellow tactile safety edge along z = 1.90..2.12
    b.add_patch(-2.0, 20.0, 0.0, 0.03, 1.90, 2.12, k(3200), (195, 155, 32), alpha=250, scale=(0.06, 0.015, 0.05), normal=(0, 1, 0), color_var=8)

    # Back station tile wall at z = 6.45, y = 0..2.85
    b.add_patch(-2.0, 20.0, 0.0, 2.85, 6.42, 6.50, k(16000), (216, 214, 202), alpha=245, scale=(0.09, 0.07, 0.025), normal=(0, 0, -1), color_var=10)
    # Classic subway green mosaic band (y = 1.55..1.75)
    b.add_patch(-2.0, 20.0, 1.55, 1.75, 6.39, 6.44, k(3200), (26, 94, 52), alpha=250, scale=(0.06, 0.04, 0.02), normal=(0, 0, -1), color_var=6)
    # Blank dark station name tablets every 9m (the stops past HAWKES ST stay unnamed)
    for tx in (0.5, 9.5, 18.5):
        b.add_patch(tx - 0.9, tx + 0.9, 1.05, 1.45, 6.37, 6.42, k(550), (22, 24, 24), alpha=250, scale=(0.05, 0.04, 0.02), normal=(0, 0, -1), color_var=4)

    # Steel station columns along z = 3.2
    for cx in (1.5, 6.0, 10.5, 15.0):
        b.add_patch(cx - 0.14, cx + 0.14, 0.0, 2.85, 3.06, 3.34, k(950), (72, 82, 78), alpha=248, scale=(0.04, 0.08, 0.04), normal=(0, 0, -1), color_var=7)

    # Dark exit stairs recessed at x = 12.6..15.2, z = 4.6..6.4
    b.add_patch(12.6, 15.2, 0.0, 2.4, 4.6, 6.4, k(2600), (28, 30, 33), alpha=235, scale=(0.08, 0.07, 0.08), normal=(0, 1, -0.5), color_var=6)

    # Overhead station ceiling and fluorescent light strips (z = 1.9..6.5, y = 2.82..2.92)
    b.add_patch(-2.0, 20.0, 2.84, 2.92, 1.9, 6.5, k(6500), (48, 50, 48), alpha=235, scale=(0.15, 0.03, 0.14), normal=(0, -1, 0), color_var=6)
    b.add_patch(-1.0, 19.0, 2.78, 2.83, 3.5, 3.75, k(2200), (235, 245, 232), alpha=245, scale=(0.08, 0.02, 0.04), normal=(0, -1, 0), color_var=5)


def add_car(b, density=1.0):
    """PH Origins Level 7 subway car interior: x=0..18, z=-1.5..1.5, y=0..2.42, doors at x=[2.3, 6.8, 11.2, 15.7]."""
    k = lambda n: max(8, int(round(n * density)))
    # Ribbed dark speckled floor (x = 0..18, z = -1.5..1.5, y = 0..0.02)
    b.add_patch(0.0, 18.0, 0.0, 0.02, -1.5, 1.5, k(16000), (44, 43, 41), alpha=248, scale=(0.08, 0.015, 0.07), normal=(0, 1, 0), color_var=7)
    # Yellow threshold plates at each door pair
    for dx in DOORS_X:
        for side in (-1.0, 1.0):
            z0 = side * 1.34
            z1 = side * 1.50
            b.add_patch(dx - DOOR_HALF, dx + DOOR_HALF, 0.015, 0.03, min(z0, z1), max(z0, z1), k(220), (165, 128, 24), alpha=250, scale=(0.04, 0.01, 0.03), normal=(0, 1, 0), color_var=6)

    # Bench spans between doors
    benches = []
    cur = 0.25
    for dx in DOORS_X:
        benches.append((cur, dx - DOOR_HALF - 0.1))
        cur = dx + DOOR_HALF + 0.1
    benches.append((cur, 17.75))

    for side in (-1.0, 1.0):
        wz = side * 1.5
        n = (0.0, 0.0, -side)
        for a, bx in benches:
            # Lower and upper wall panels (leaving window openings y = 1.0..1.85 clear)
            b.add_patch(a, bx, 0.0, 0.98, wz - 0.02, wz + 0.02, k(1100), (198, 195, 184), alpha=245, scale=(0.07, 0.06, 0.02), normal=n, color_var=6)
            b.add_patch(a, bx, 1.86, 2.26, wz - 0.03, wz + 0.02, k(750), (188, 186, 176), alpha=240, scale=(0.07, 0.05, 0.02), normal=n, color_var=8)
            # Molded blue benches (z = +-1.04 to +-1.48, y = 0.12..0.96)
            zf = side * 1.04
            zb = side * 1.44
            b.add_patch(a, bx, 0.42, 0.47, min(zf, zb), max(zf, zb), k(950), (52, 86, 136), alpha=248, scale=(0.05, 0.02, 0.05), normal=(0, 1, 0), color_var=7)
            b.add_patch(a, bx, 0.46, 0.96, side * 1.38, side * 1.47, k(850), (48, 80, 128), alpha=248, scale=(0.05, 0.05, 0.02), normal=n, color_var=7)

        # Doors (closed except north stop door at x=11.2 which stands open)
        for dx in DOORS_X:
            is_open_stop_door = (side > 0 and abs(dx - 11.2) < 0.1)
            if is_open_stop_door:
                # Door header only; doorway is open onto the platform
                b.add_patch(dx - DOOR_HALF, dx + DOOR_HALF, 2.05, 2.28, wz - 0.03, wz + 0.02, k(260), (46, 128, 66), alpha=245, scale=(0.05, 0.04, 0.02), normal=n, color_var=6)
            else:
                # Brushed steel door leaves below and above window
                b.add_patch(dx - DOOR_HALF, dx + DOOR_HALF, 0.0, 1.15, wz - 0.02, wz + 0.02, k(650), (134, 137, 140), alpha=245, scale=(0.05, 0.06, 0.02), normal=n, color_var=6)
                b.add_patch(dx - DOOR_HALF, dx + DOOR_HALF, 1.85, 2.25, wz - 0.02, wz + 0.02, k(320), (134, 137, 140), alpha=245, scale=(0.05, 0.04, 0.02), normal=n, color_var=6)

    # Center poles at each door (x = door, z = 0)
    for dx in DOORS_X:
        b.add_patch(dx - 0.03, dx + 0.03, 0.0, 2.40, -0.03, 0.03, k(420), (195, 200, 205), alpha=250, scale=(0.02, 0.06, 0.02), normal=(1, 0, 0), color_var=5)

    # Ceiling and twin fluorescent light strips (y = 2.36..2.42, z = +-0.62)
    b.add_patch(0.0, 18.0, 2.39, 2.43, -1.25, 1.25, k(8500), (216, 216, 208), alpha=240, scale=(0.10, 0.02, 0.09), normal=(0, -1, 0), color_var=5)
    for side in (-1.0, 1.0):
        b.add_patch(0.5, 17.5, 2.35, 2.39, side * 0.62 - 0.08, side * 0.62 + 0.08, k(2400), (245, 250, 238), alpha=250, scale=(0.07, 0.015, 0.04), normal=(0, -1, 0), color_var=4)

    # End walls at x = 0 and x = 18 with amber "6 UPTOWN" sign glow
    for ex, nx in ((0.0, 1.0), (18.0, -1.0)):
        b.add_patch(ex - 0.02, ex + 0.02, 0.0, 2.42, -1.5, -0.42, k(950), (192, 190, 180), alpha=245, scale=(0.02, 0.06, 0.06), normal=(nx, 0, 0), color_var=6)
        b.add_patch(ex - 0.02, ex + 0.02, 0.0, 2.42, 0.42, 1.5, k(950), (192, 190, 180), alpha=245, scale=(0.02, 0.06, 0.06), normal=(nx, 0, 0), color_var=6)
        b.add_patch(ex - 0.02, ex + 0.02, 2.08, 2.28, -0.38, 0.38, k(280), (255, 174, 28), alpha=250, scale=(0.02, 0.03, 0.04), normal=(nx, 0, 0), color_var=6)


def build_from_image(image_path, depth_path, bounds, density, splat_scale, mode, rng):
    """Lifts a 2D image (and optional depth map) into 3D oriented Gaussian splats."""
    im = Image.open(image_path).convert("RGBA")
    w0, h0 = im.size
    # Scale working grid by density so pixel count stays fast and crisp
    target_w = max(32, min(768, int(round(384 * math.sqrt(max(0.1, density))))))
    target_h = max(32, min(768, int(round(target_w * (h0 / max(1, w0))))))
    im_small = im.resize((target_w, target_h), Image.BILINEAR)
    rgba = np.asarray(im_small, dtype=np.uint8)
    rgb_f = rgba[:, :, :3].astype(np.float32) / 255.0

    if depth_path and os.path.exists(depth_path):
        d_im = Image.open(depth_path).convert("L").resize((target_w, target_h), Image.BILINEAR)
        depth = np.asarray(d_im, dtype=np.float32) / 255.0
    else:
        # Estimate smooth depth from luminance + vertical gradient
        luma = rgb_f @ LUMA
        v_grad = np.linspace(0.15, 0.85, target_h, dtype=np.float32)[:, None]
        depth = np.clip(0.65 * luma + 0.35 * v_grad, 0.0, 1.0)

    x_min, x_max, y_min, y_max, z_min, z_max = bounds
    uu, vv = np.meshgrid(
        np.linspace(0.0, 1.0, target_w, dtype=np.float32),
        np.linspace(0.0, 1.0, target_h, dtype=np.float32),
    )

    is_pano = mode == "panorama" or (mode == "auto" and w0 >= h0 * 1.75)
    if is_pano:
        # Cylindrical / equirectangular lift around the scene bounds
        theta = (uu - 0.5) * (2.0 * math.pi)
        cx = 0.5 * (x_min + x_max)
        cz = 0.5 * (z_min + z_max)
        rx = max(0.5, 0.5 * (x_max - x_min))
        rz = max(0.5, 0.5 * (z_max - z_min))
        rad_Factor = 0.75 + 0.25 * (1.0 - depth)
        px = cx + np.sin(theta) * rx * rad_Factor
        pz = cz + np.cos(theta) * rz * rad_Factor
        py = y_min + (1.0 - vv) * (y_max - y_min)
        nx = -np.sin(theta)
        ny = np.zeros_like(nx)
        nz = -np.cos(theta)
    else:
        # Relief / perspective lift across bounds
        px = x_min + uu * (x_max - x_min)
        py = y_min + (1.0 - vv) * (y_max - y_min)
        pz = z_min + (1.0 - depth) * (z_max - z_min)
        dz_dx = np.gradient(pz, axis=1)
        dz_dy = np.gradient(pz, axis=0)
        nx = -dz_dx
        ny = dz_dy
        nz = np.ones_like(pz) * 0.25
        n_len = np.sqrt(nx * nx + ny * ny + nz * nz)
        n_len = np.where(n_len > 1e-6, n_len, 1.0)
        nx, ny, nz = nx / n_len, ny / n_len, nz / n_len

    mask = rgba[:, :, 3] > 16
    px, py, pz = px[mask], py[mask], pz[mask]
    nx, ny, nz = nx[mask], ny[mask], nz[mask]
    cols = rgba[mask]

    n_pts = px.shape[0]
    pos = np.column_stack([px, py, pz]).astype(np.float32)
    cell_x = max(0.01, (x_max - x_min) / max(1, target_w)) * splat_scale
    cell_y = max(0.01, (y_max - y_min) / max(1, target_h)) * splat_scale
    cell_z = max(0.005, min(cell_x, cell_y) * 0.5)
    scales = np.column_stack([
        np.full(n_pts, cell_x, dtype=np.float32),
        np.full(n_pts, cell_y, dtype=np.float32),
        np.full(n_pts, cell_z, dtype=np.float32),
    ])
    qw, qx, qy, qz = quat_from_normal(nx, ny, nz)
    quats = np.column_stack([qw, qx, qy, qz]).astype(np.float32)
    return pos, scales, cols, quats


def render_preview(pos, scales, rgba, out_png, title=""):
    """Renders a 2-panel (3D perspective + top/side orthographic) preview PNG of the splat cloud."""
    w, h = 960, 540
    img = np.zeros((h, w, 3), dtype=np.float32)
    # Subtle dark studio gradient background
    bg_y = np.linspace(14.0, 26.0, h, dtype=np.float32)[:, None, None]
    img += bg_y

    if pos.shape[0] > 0:
        # Subsample up to 45k splats for fast software splatting
        step = max(1, pos.shape[0] // 45000)
        p = pos[::step]
        s = scales[::step]
        c = rgba[::step].astype(np.float32)

        # Left panel (640x540): 3D perspective camera looking along the scene
        pw, ph = 640, 540
        center = np.median(p, axis=0)
        span = np.maximum(np.percentile(p, 95, axis=0) - np.percentile(p, 5, axis=0), 1.0)
        cam = np.array([center[0] - span[0] * 0.55, center[1] + span[1] * 0.35 + 0.6, center[2] - span[2] * 0.65], dtype=np.float32)
        target = np.array([center[0] + span[0] * 0.1, center[1], center[2] + span[2] * 0.1], dtype=np.float32)
        fwd = target - cam
        fwd /= max(1e-6, float(np.linalg.norm(fwd)))
        right = np.cross(fwd, np.array([0.0, 1.0, 0.0], dtype=np.float32))
        right /= max(1e-6, float(np.linalg.norm(right)))
        up = np.cross(right, fwd)

        rel = p - cam
        cz = rel @ fwd
        vis = cz > 0.2
        if np.any(vis):
            rel_v = rel[vis]
            cz_v = cz[vis]
            col_v = c[vis]
            sc_v = np.max(s[vis], axis=1)
            order = np.argsort(-cz_v)  # back-to-front painter's algorithm
            rel_v = rel_v[order]
            cz_v = cz_v[order]
            col_v = col_v[order]
            sc_v = sc_v[order]

            fov = 340.0
            sx = np.round(pw * 0.5 + (rel_v @ right / cz_v) * fov).astype(np.int32)
            sy = np.round(ph * 0.5 - (rel_v @ up / cz_v) * fov).astype(np.int32)
            rad = np.clip(np.round((sc_v / cz_v) * fov), 1, 4).astype(np.int32)
            in_b = (sx >= 2) & (sx < pw - 2) & (sy >= 2) & (sy < ph - 2)
            sx, sy, col_v, rad = sx[in_b], sy[in_b], col_v[in_b], rad[in_b]
            alpha = (col_v[:, 3:4] / 255.0) * 0.55
            rgb = col_v[:, :3]
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    w_k = 0.85 if (dx == 0 and dy == 0) else 0.35
                    yy = np.clip(sy + dy, 0, ph - 1)
                    xx = np.clip(sx + dx, 0, pw - 1)
                    a_k = alpha * w_k
                    img[yy, xx] = img[yy, xx] * (1.0 - a_k) + rgb * a_k

        # Right panel top (320x270): Top-down X-Z map
        rx0, rw, rh = 640, 320, 270
        x_min, x_max = float(p[:, 0].min()), float(p[:, 0].max())
        z_min, z_max = float(p[:, 2].min()), float(p[:, 2].max())
        tx = np.clip(((p[:, 0] - x_min) / max(0.5, x_max - x_min) * (rw - 28) + 14).astype(np.int32), 0, rw - 1)
        tz = np.clip(((1.0 - (p[:, 2] - z_min) / max(0.5, z_max - z_min)) * (rh - 28) + 14).astype(np.int32), 0, rh - 1)
        img[tz, rx0 + tx] = np.clip(img[tz, rx0 + tx] * 0.35 + c[:, :3] * 0.65, 0, 255)

        # Right panel bottom (320x270): Side elevation X-Y
        ry0 = 270
        y_min, y_max = float(p[:, 1].min()), float(p[:, 1].max())
        ey = np.clip(((1.0 - (p[:, 1] - y_min) / max(0.5, y_max - y_min)) * (rh - 28) + 14).astype(np.int32), 0, rh - 1)
        img[ry0 + ey, rx0 + tx] = np.clip(img[ry0 + ey, rx0 + tx] * 0.35 + c[:, :3] * 0.65, 0, 255)

    pil = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(pil)
    draw.line([(640, 0), (640, 540)], fill=(60, 68, 78), width=2)
    draw.line([(640, 270), (960, 270)], fill=(60, 68, 78), width=2)
    draw.text((14, 12), f"3D SPLAT VIEW  ({pos.shape[0]:,} splats)  {title}", fill=(220, 228, 235))
    draw.text((652, 12), "TOP PLAN (X / Z)", fill=(180, 195, 205))
    draw.text((652, 282), "ELEVATION (X / Y)", fill=(180, 195, 205))
    pil.save(out_png)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-splat", required=True)
    ap.add_argument("--out-preview", required=True)
    ap.add_argument("--image", default="")
    ap.add_argument("--depth", default="")
    ap.add_argument("--preset-scene", default="auto")
    ap.add_argument("--max-splats", type=int, default=180000)
    ap.add_argument("--density", type=float, default=1.0)
    ap.add_argument("--splat-scale", type=float, default=1.0)
    ap.add_argument("--bounds", default="0,18,0,2.8,-2.6,6.5")
    ap.add_argument("--mode", default="auto")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    bounds = [float(x) for x in args.bounds.split(",")]
    if len(bounds) != 6:
        bounds = [0.0, 18.0, 0.0, 2.8, -2.6, 6.5]

    b = CloudBuilder(rng)
    scene = args.preset_scene

    if scene in ("subway-tunnel", "subway-station", "subway-car-full"):
        if scene in ("subway-tunnel", "subway-car-full"):
            add_tunnel(b, args.density)
        if scene in ("subway-station", "subway-car-full"):
            add_station(b, args.density)
        if scene == "subway-car-full":
            add_car(b, args.density)
        p0, s0, c0, q0 = b.finish()
        if args.image and os.path.exists(args.image):
            pi, si, ci, qi = build_from_image(args.image, args.depth, bounds, args.density * 0.6, args.splat_scale, args.mode, rng)
            p0 = np.vstack([p0, pi])
            s0 = np.vstack([s0, si])
            c0 = np.vstack([c0, ci])
            q0 = np.vstack([q0, qi])
    elif args.image and os.path.exists(args.image):
        p0, s0, c0, q0 = build_from_image(args.image, args.depth, bounds, args.density, args.splat_scale, args.mode, rng)
    else:
        # Default fallback: full subway car + station + tunnel
        add_tunnel(b, args.density)
        add_station(b, args.density)
        add_car(b, args.density)
        p0, s0, c0, q0 = b.finish()
        scene = "subway-car-full"

    s0 = s0 * float(args.splat_scale)
    raw, pos, scales, rgba = pack_splats(p0, s0, c0, q0, max(64, int(args.max_splats)), rng)
    with open(args.out_splat, "wb") as f:
        f.write(raw)

    render_preview(pos, scales, rgba, args.out_preview, title=scene if scene != "auto" else "image-lift")

    mins = pos.min(axis=0).round(3).tolist() if pos.shape[0] else [0, 0, 0]
    maxs = pos.max(axis=0).round(3).tolist() if pos.shape[0] else [0, 0, 0]
    info = {
        "splats": int(pos.shape[0]),
        "bytes": len(raw),
        "bytesPerSplat": 32,
        "presetScene": scene,
        "bounds": {"min": mins, "max": maxs},
    }
    print(json.dumps(info))


if __name__ == "__main__":
    main()
