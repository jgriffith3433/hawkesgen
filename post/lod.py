"""The LOD system's image work (src/lod.ts): an image's smaller copies, and the textures inside a GLB's levels.

python lod.py <plan.json>
Prints one JSON line: { "images": [...], "textures": [...] }, each in the plan's order.

plan.json:
  images    [{ "in": file, "out": "<folder>/<stem>" }]: every power-of-two size below the image's long side (128, 256,
            512, 1024, 2048) as WebP, keeping its shape (a 2:1 sky stays 2:1) and its transparency, plus the full size
            as WebP when the original isn't WebP and the WebP is smaller. Pixel art (few colours) is scaled with nearest
            neighbour and saved lossless, so it stays crisp. Animated GIFs and images we can't read are skipped.
  textures  [{ "in": file, "out": file, "max": px }]: one texture of a model, at most `max` px on its long side, as
            WebP (or as it was when that is smaller and it needed no resize).
"""
import json
import os
import sys

from PIL import Image, ImageChops

SIZES = [128, 256, 512, 1024, 2048]
QUALITY = 82
FULL_MAX = 8192


def has_alpha(im):
    return im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)


def normal(im):
    """RGB or RGBA, whatever the file was (palette, greyscale, 16-bit)."""
    if has_alpha(im):
        return im.convert('RGBA')
    return im.convert('RGB')


def pixel_art(im):
    """Drawn as pixels (a sprite from image.transform's pixelate, a tile): few colours, and either tiny or made of
    blocks of at least 4x4 (scaled up with nearest neighbour). Noise of a few colours has neither."""
    if max(im.size) > 2048 or im.getcolors(maxcolors=64) is None:
        return False
    if max(im.size) <= 128:
        return True
    w, h = im.size
    if w % 4 or h % 4:
        return False
    back = im.resize((w // 4, h // 4), Image.NEAREST).resize((w, h), Image.NEAREST)
    return ImageChops.difference(im.convert('RGBA'), back.convert('RGBA')).getbbox(alpha_only=False) is None


def fit(w, h, size):
    if w >= h:
        return size, max(1, round(h * size / w))
    return max(1, round(w * size / h)), size


def save_webp(im, path, lossless=False):
    im.save(path, 'WEBP', quality=QUALITY, method=4, lossless=lossless, exact=has_alpha(im))
    return os.path.getsize(path)


def image_levels(job):
    src = job['in']
    try:
        im = Image.open(src)
        fmt = (im.format or '').upper()
        if getattr(im, 'is_animated', False) and getattr(im, 'n_frames', 1) > 1:
            return {'skipped': 'animated (its frames are kept as they are)'}
        im.load()
    except Exception as e:
        return {'skipped': f'not an image we can read ({e})'}
    w, h = im.size
    long = max(w, h)
    if long <= 0 or long > 16384:
        return {'skipped': f'{w}x{h} is out of range', 'width': w, 'height': h}
    im = normal(im)
    pixel = pixel_art(im)
    resample = Image.NEAREST if pixel else Image.LANCZOS
    out = []
    for s in SIZES:
        if s >= long:
            break
        tw, th = fit(w, h, s)
        path = f"{job['out']}.{s}.webp"
        b = save_webp(im.resize((tw, th), resample), path, lossless=pixel)
        out.append({'level': s, 'path': path, 'width': tw, 'height': th, 'bytes': b})
    # The full size again as WebP, when it isn't one already and that is smaller (a 1 MB PNG is about 150 KB).
    if fmt != 'WEBP' and long <= FULL_MAX:
        path = f"{job['out']}.{long}.webp"
        b = save_webp(im, path, lossless=pixel)
        if b < os.path.getsize(src):
            out.append({'level': long, 'path': path, 'width': w, 'height': h, 'bytes': b})
        else:
            os.remove(path)
    return {'width': w, 'height': h, 'alpha': im.mode == 'RGBA', 'pixel': pixel, 'format': fmt.lower(), 'levels': out}


def texture(job):
    src, dst, cap = job['in'], job['out'], int(job['max'])
    im = Image.open(src)
    im.load()
    w, h = im.size
    resized = max(w, h) > cap
    im = normal(im)
    if resized:
        im = im.resize(fit(w, h, cap), Image.LANCZOS)
    b = save_webp(im, dst)
    if not resized and b >= os.path.getsize(src):
        os.remove(dst)
        return {'width': w, 'height': h, 'kept': True}
    return {'width': im.width, 'height': im.height, 'bytes': b}


def main():
    plan = json.load(open(sys.argv[1], encoding='utf-8'))
    res = {'images': [], 'textures': []}
    for job in plan.get('images', []):
        try:
            res['images'].append(image_levels(job))
        except Exception as e:  # one bad image never stops the batch
            res['images'].append({'error': str(e)})
    for job in plan.get('textures', []):
        try:
            res['textures'].append(texture(job))
        except Exception as e:
            res['textures'].append({'error': str(e)})
    print(json.dumps(res))


if __name__ == '__main__':
    main()
