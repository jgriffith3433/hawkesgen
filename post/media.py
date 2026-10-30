"""Image normalizing for media.normalize (src/tools/media.ts). Prints one JSON line.

  media.py image <src> <out-base>   -> {file, ext, width, height} (PNG when it has transparency, else JPEG)

Phone rotation (EXIF) is applied, CMYK and palette images become RGB, an animated GIF or WebP keeps its first frame.
HEIC/HEIF/AVIF open when pillow-heif is installed; otherwise ffmpeg tries.
"""
import json
import subprocess
import sys

from PIL import Image, ImageOps

try:  # optional
    import pillow_heif  # type: ignore

    pillow_heif.register_heif_opener()
except Exception:  # noqa: BLE001
    pass


def open_any(src):
    try:
        im = Image.open(src)
        im.seek(0)
        im.load()
        return im
    except Exception:  # noqa: BLE001
        # ffmpeg reads some formats Pillow can't (HEIC without pillow-heif on ffmpeg builds that have it).
        tmp = src + ".ffmpeg.png"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-frames:v", "1", tmp], check=True)
        return Image.open(tmp)


def image(src, base):
    im = open_any(src)
    try:
        im = ImageOps.exif_transpose(im)
    except Exception:  # noqa: BLE001
        pass
    alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
    if alpha:
        im = im.convert("RGBA")
        if im.getchannel("A").getextrema()[0] == 255:
            alpha = False
            im = im.convert("RGB")
    elif im.mode == "L":
        pass
    else:
        im = im.convert("RGB")  # CMYK, YCbCr, P, I;16 ...
    if alpha:
        out, ext = base + ".png", ".png"
        im.save(out, optimize=True)
    else:
        out, ext = base + ".jpg", ".jpg"
        im.save(out, quality=92, subsampling=0)
    print(json.dumps({"file": out, "ext": ext, "width": im.width, "height": im.height}))


if __name__ == "__main__":
    try:
        if sys.argv[1] == "image":
            image(sys.argv[2], sys.argv[3])
        else:
            raise SystemExit(f"unknown command {sys.argv[1]}")
    except subprocess.CalledProcessError:
        print(json.dumps({"error": "Could not read the image (an unsupported format)"}))
