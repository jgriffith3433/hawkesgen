"""Face identity: ArcFace cosine distance from the faces in a candidate's frames to a character's references.

    python identity.py --refs ref1.png [ref2.png ...] --frames f1.png [f2.png ...] [--models DIR]

Prints one JSON line: { distance, perFrame, spread, faces, frames, refFaces, backend }.
  distance  mean over checked frames of the best-matching face's mean cosine distance (1 - cos) to the references;
            null when no face was found in the frames or the references
  perFrame  that distance per frame that had a face
  spread    standard deviation of perFrame
  faces     faces found across the frames

The models are insightface's buffalo_l (SCRFD-10G detection, ArcFace R50 trained on WebFace600K), run on the CPU
with onnxruntime. They download on first use (about 280 MB) into --models (default ~/.insightface, insightface's own
root, so both share one copy). With the insightface package installed it is used; without it (no wheel for this
Python or this OS) the same two models run here directly: detection, the five-point alignment to ArcFace's 112x112
template, the embedding.
"""

import argparse
import json
import os
import sys
import urllib.request
import zipfile

import numpy as np

URL = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip'
# Where ArcFace expects the eyes, nose and mouth corners in its 112x112 input (insightface face_align.arcface_dst).
ARCFACE_DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


def model_dir(root):
    return os.path.join(root, 'models', 'buffalo_l')


def ensure_models(root):
    d = model_dir(root)
    need = ['det_10g.onnx', 'w600k_r50.onnx']
    if all(os.path.exists(os.path.join(d, f)) for f in need):
        return d
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, 'buffalo_l.zip.part')
    print(f'downloading the face models (about 280 MB) to {d}', file=sys.stderr)
    urllib.request.urlretrieve(URL, tmp)
    with zipfile.ZipFile(tmp) as z:
        for name in z.namelist():
            base = os.path.basename(name)
            if base.endswith('.onnx'):
                with z.open(name) as src, open(os.path.join(d, base), 'wb') as out:
                    out.write(src.read())
    os.remove(tmp)
    missing = [f for f in need if not os.path.exists(os.path.join(d, f))]
    if missing:
        raise SystemExit(f'the face model download is missing {missing}')
    return d


def read(path):
    import cv2
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        # cv2 can't read some formats (webp builds, gif): Pillow can.
        from PIL import Image
        img = cv2.cvtColor(np.array(Image.open(path).convert('RGB')), cv2.COLOR_RGB2BGR)
    return img


class Direct:
    """buffalo_l's detection and recognition models without the insightface package."""

    def __init__(self, d):
        import onnxruntime as ort
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.det = ort.InferenceSession(os.path.join(d, 'det_10g.onnx'), opts, providers=['CPUExecutionProvider'])
        self.rec = ort.InferenceSession(os.path.join(d, 'w600k_r50.onnx'), opts, providers=['CPUExecutionProvider'])

    def detect(self, img, thresh=0.5, size=640):
        import cv2
        h, w = img.shape[:2]
        if h / w > 1:
            nh, nw = size, max(1, int(size * w / h))
        else:
            nw, nh = size, max(1, int(size * h / w))
        scale = nh / h
        canvas = np.zeros((size, size, 3), dtype=np.uint8)
        canvas[:nh, :nw] = cv2.resize(img, (nw, nh))
        blob = cv2.dnn.blobFromImage(canvas, 1.0 / 128, (size, size), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.det.run(None, {self.det.get_inputs()[0].name: blob})
        # Nine outputs: scores, boxes and keypoints for strides 8, 16 and 32. Grouped by their row count and width so
        # the order the export happened to use doesn't matter.
        by = {}
        for o in outs:
            o = o.reshape(-1, o.shape[-1])
            by.setdefault(o.shape[0], {})[o.shape[1]] = o
        boxes, scores, kpss = [], [], []
        for stride in (8, 16, 32):
            g = size // stride
            n = g * g * 2
            if n not in by:
                continue
            s, b, k = by[n][1].reshape(-1), by[n][4] * stride, by[n][10] * stride
            centers = np.stack(np.mgrid[:g, :g][::-1], axis=-1).astype(np.float32).reshape(-1, 2) * stride
            centers = np.repeat(centers, 2, axis=0)
            keep = np.where(s >= thresh)[0]
            c = centers[keep]
            bb = np.stack([c[:, 0] - b[keep, 0], c[:, 1] - b[keep, 1], c[:, 0] + b[keep, 2], c[:, 1] + b[keep, 3]], axis=1)
            kp = np.stack([c[:, i % 2] + k[keep, i] for i in range(10)], axis=1).reshape(-1, 5, 2)
            boxes.append(bb / scale)
            kpss.append(kp / scale)
            scores.append(s[keep])
        if not boxes:
            return []
        boxes, scores, kpss = np.concatenate(boxes), np.concatenate(scores), np.concatenate(kpss)
        keep = nms(boxes, scores, 0.4)
        return [(boxes[i], scores[i], kpss[i]) for i in keep]

    def embed(self, img, kps):
        import cv2
        m, _ = cv2.estimateAffinePartial2D(kps.astype(np.float32), ARCFACE_DST, method=cv2.LMEDS)
        face = cv2.warpAffine(img, m, (112, 112), borderValue=0.0)
        blob = cv2.dnn.blobFromImage(face, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        e = self.rec.run(None, {self.rec.get_inputs()[0].name: blob})[0].reshape(-1)
        return e / (np.linalg.norm(e) + 1e-9)

    def faces(self, img):
        out = []
        for box, score, kps in self.detect(img):
            out.append({'box': box.tolist(), 'score': float(score), 'emb': self.embed(img, kps)})
        return out


class Packaged:
    """The insightface package, when it's installed."""

    def __init__(self, root):
        from insightface.app import FaceAnalysis
        self.app = FaceAnalysis(name='buffalo_l', root=root, allowed_modules=['detection', 'recognition'], providers=['CPUExecutionProvider'])
        self.app.prepare(ctx_id=-1, det_size=(640, 640))

    def faces(self, img):
        return [{'box': f.bbox.tolist(), 'score': float(f.det_score), 'emb': f.normed_embedding} for f in self.app.get(img)]


def nms(boxes, scores, thresh):
    order = scores.argsort()[::-1]
    area = (boxes[:, 2] - boxes[:, 0] + 1) * (boxes[:, 3] - boxes[:, 1] + 1)
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.maximum(0.0, xx2 - xx1 + 1) * np.maximum(0.0, yy2 - yy1 + 1)
        iou = inter / (area[i] + area[order[1:]] - inter)
        order = order[1:][iou <= thresh]
    return keep


def largest(faces):
    return max(faces, key=lambda f: (f['box'][2] - f['box'][0]) * (f['box'][3] - f['box'][1])) if faces else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refs', nargs='+', required=True)
    ap.add_argument('--frames', nargs='+', required=True)
    ap.add_argument('--engine', choices=['auto', 'insightface', 'direct'], default='auto')
    ap.add_argument('--models', default=os.environ.get('HAWKESGEN_FACE_MODELS') or os.path.join(os.path.expanduser('~'), '.insightface'))
    a = ap.parse_args()

    ensure_models(a.models)
    engine = None
    if a.engine != 'direct':
        try:
            import warnings
            warnings.simplefilter('ignore', FutureWarning)
            engine, backend = Packaged(a.models), 'insightface'
        except Exception:
            if a.engine == 'insightface':
                raise
    if engine is None:
        engine, backend = Direct(model_dir(a.models)), 'onnxruntime'

    # A reference is its largest face, or on a sheet (the character drawn several times at one size) every face.
    refs = []
    for r in a.refs:
        fs = engine.faces(read(r))
        if not fs:
            continue
        big = largest(fs)
        tall = big['box'][3] - big['box'][1]
        refs.extend(f['emb'] for f in fs if f['box'][3] - f['box'][1] >= 0.65 * tall)
    per, faces = [], 0
    if refs:
        R = np.stack(refs)
        for fr in a.frames:
            fs = engine.faces(read(fr))
            faces += len(fs)
            if not fs:
                continue
            # Several faces: the one that matches best is the character (the others are someone else in the shot).
            per.append(max(0.0, min(float(np.mean(1.0 - R @ f["emb"])) for f in fs)))
    dist = float(np.mean(per)) if per else None
    print(json.dumps({
        'distance': None if dist is None else round(dist, 4),
        'perFrame': [round(x, 4) for x in per],
        'spread': round(float(np.std(per)), 4) if per else 0.0,
        'faces': faces,
        'frames': len(a.frames),
        'refFaces': len(refs),
        'backend': backend,
    }))


if __name__ == '__main__':
    main()
