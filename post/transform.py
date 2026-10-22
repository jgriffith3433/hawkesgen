"""image.transform: everyday image fixes for game art, as a list of steps applied in order (Pillow, no GPU).

python transform.py <in> <out> <ops json> <format> [quality]
Prints a JSON line: the final size and what each step did.

Steps ({"op": ...}):
  resize   width, height, fit: contain|cover|stretch (default contain), pixel: true for nearest-neighbour
  scale    factor (0.05-16), pixel
  crop     x, y, width, height
  trim     pad (px): crop to the visible pixels (transparency, else the corner color)
  pad      width, height, color (hex; omit for transparent): centered on a bigger canvas
  square   color: pad to a square
  pot      color: pad to power-of-two sides (textures)
  flip     axis: h|v
  rotate   degrees (counter-clockwise), expand: true
  pixelate size (longest side, px), colors (palette size, 0 = keep), upscale (factor, nearest)
  colors   count: reduce to a palette
  outline  width (px), color (hex): a sprite outline around the visible shape
  tint     color (hex), amount (0-1)
  grayscale
"""
import json
import sys

from PIL import Image, ImageChops, ImageFilter, ImageOps


def hex_rgba(h, default=(0, 0, 0, 0)):
    if not h:
        return default
    h = str(h).lstrip('#')
    if len(h) == 6:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (255,)
    if len(h) == 8:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4, 6))
    raise ValueError(f'bad color {h}')


def visible_box(im):
    if im.mode == 'RGBA' and im.getchannel('A').getextrema()[0] < 255:
        return im.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    bg = Image.new(im.mode, im.size, im.getpixel((0, 0)))
    diff = ImageChops.difference(im.convert('RGB'), bg.convert('RGB')).convert('L').point(lambda v: 255 if v > 12 else 0)
    return diff.getbbox()


def canvas(im, w, h, color):
    out = Image.new('RGBA', (w, h), hex_rgba(color))
    out.paste(im, ((w - im.width) // 2, (h - im.height) // 2), im)
    return out


def step(im, s):
    op = s.get('op')
    rs = Image.NEAREST if s.get('pixel') else Image.LANCZOS
    if op == 'resize':
        w, h = int(s.get('width') or 0), int(s.get('height') or 0)
        if not w and not h:
            raise ValueError('resize needs width or height')
        w = w or round(im.width * h / im.height)
        h = h or round(im.height * w / im.width)
        fit = s.get('fit', 'contain')
        if fit == 'stretch':
            return im.resize((w, h), rs)
        if fit == 'cover':
            return ImageOps.fit(im, (w, h), rs)
        return canvas(ImageOps.contain(im, (w, h), rs), w, h, s.get('color'))
    if op == 'scale':
        f = max(0.05, min(16, float(s.get('factor', 1))))
        return im.resize((max(1, round(im.width * f)), max(1, round(im.height * f))), rs)
    if op == 'crop':
        x, y = int(s.get('x', 0)), int(s.get('y', 0))
        return im.crop((x, y, x + int(s['width']), y + int(s['height'])))
    if op == 'trim':
        box = visible_box(im)
        if not box:
            return im
        p = int(s.get('pad', 0))
        return im.crop((max(0, box[0] - p), max(0, box[1] - p), min(im.width, box[2] + p), min(im.height, box[3] + p)))
    if op == 'pad':
        return canvas(im, max(im.width, int(s.get('width', im.width))), max(im.height, int(s.get('height', im.height))), s.get('color'))
    if op == 'square':
        side = max(im.size)
        return canvas(im, side, side, s.get('color'))
    if op == 'pot':
        up = lambda n: 1 << (n - 1).bit_length()
        return canvas(im, up(im.width), up(im.height), s.get('color'))
    if op == 'flip':
        return ImageOps.mirror(im) if s.get('axis', 'h') == 'h' else ImageOps.flip(im)
    if op == 'rotate':
        return im.rotate(float(s.get('degrees', 90)), resample=Image.BICUBIC, expand=s.get('expand', True))
    if op == 'pixelate':
        size = max(4, min(1024, int(s.get('size', 64))))
        small = ImageOps.contain(im, (size, size), Image.BOX)
        colors = int(s.get('colors', 16))
        if colors:
            small = quantize(small, colors)
        up = int(s.get('upscale', 1))
        return small.resize((small.width * up, small.height * up), Image.NEAREST) if up > 1 else small
    if op == 'colors':
        return quantize(im, int(s.get('count', 16)))
    if op == 'outline':
        width = max(1, min(32, int(s.get('width', 2))))
        alpha = im.getchannel('A')
        grown = alpha.filter(ImageFilter.MaxFilter(width * 2 + 1)).point(lambda a: 255 if a > 8 else 0)
        under = Image.new('RGBA', (im.width + width * 2, im.height + width * 2), (0, 0, 0, 0))
        ring = Image.new('RGBA', im.size, hex_rgba(s.get('color', '000000')))
        ring.putalpha(grown)
        under.paste(ring, (width, width), ring)
        under.alpha_composite(im, (width, width))
        return under
    if op == 'tint':
        color = Image.new('RGBA', im.size, hex_rgba(s.get('color', 'ff0000')))
        mixed = Image.blend(im, color, max(0.0, min(1.0, float(s.get('amount', 0.3)))))
        mixed.putalpha(im.getchannel('A'))
        return mixed
    if op == 'grayscale':
        g = ImageOps.grayscale(im).convert('RGBA')
        g.putalpha(im.getchannel('A'))
        return g
    raise ValueError(f'unknown op {op}')


def quantize(im, colors):
    """A palette of `colors`, keeping hard transparency (pixel art has no half-transparent pixels)."""
    alpha = im.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
    q = im.convert('RGB').quantize(colors=max(2, min(256, colors)), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGBA')
    q.putalpha(alpha)
    return q


def main():
    src, out, ops, fmt = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), sys.argv[4]
    quality = int(sys.argv[5]) if len(sys.argv) > 5 else 90
    im = Image.open(src)
    im.load()
    im = im.convert('RGBA')
    done = []
    for s in ops:
        im = step(im, s)
        done.append({'op': s.get('op'), 'size': [im.width, im.height]})
    if fmt == 'jpg':
        flat = Image.new('RGB', im.size, (255, 255, 255))
        flat.paste(im, mask=im.getchannel('A'))
        flat.save(out, 'JPEG', quality=quality)
    elif fmt == 'webp':
        im.save(out, 'WEBP', quality=quality)
    else:
        im.save(out, 'PNG', optimize=True)
    print(json.dumps({'width': im.width, 'height': im.height, 'steps': done}))


if __name__ == '__main__':
    main()
