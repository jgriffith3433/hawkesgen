#!/usr/bin/env python3
"""Hawkes Gen GPU worker for Cloud Run: ComfyUI on this instance, plus a small HTTP wrapper.

One request runs one ComfyUI graph to the end on this instance's own ComfyUI, so a job never depends on reaching the
same instance twice: the inputs come in as gs:// URIs, the outputs go out to gs://<bucket>/cloudrun/runs/<key>/ and
the answer lists them. Gen (src/providers/cloudrun/run.ts) sends one request per graph its tool runs; for most tools
(every workflow tool, image.edit, video.i2v...) one graph is one take of the job.

  GET  /ready     200 once the models are in place and ComfyUI answers (the startup probe), else 503
  GET  /healthz   200 while the wrapper runs (liveness)
  POST /run       {key, graph, files, models, out, timeoutSeconds, extra} -> NDJSON stream:
                  {"t":"progress","detail":...} lines (one at least every 15 s, so nothing idles the stream out), then
                  {"t":"done","files":[{filename,subfolder,type,node,uri,bytes}],"seconds":..,"cold":{..}|null,
                  "vram":{peakMB,totalMB,gpu}} or
                  {"t":"error","message":..,"lost":bool,"overLimit":bool,"missingModels":[..]}

Idempotent by key: the final line is also written to <out>manifest.json, so the same key again (Gen restarted, the
connection dropped) answers from it without touching the GPU, and a request for a key this instance is still running
attaches to that run. While a run is going, <out>heartbeat.json moves every 15 s (Gen polls it after a restart) and
<out>cancel, when Gen writes it, interrupts the run. A client that just goes away does not cancel: a restart of Gen
must not throw away the GPU work.

Models: MODEL_LOAD=download copies the service's models from gs://<bucket>/models/<dir>/<file> into ComfyUI's models
folder at startup (parallel ranged reads; the files live in the instance's in-memory filesystem, so they count against
its memory), MODEL_LOAD=mount symlinks them from a Cloud Storage FUSE volume (MODELS_MOUNT, read lazily, no memory).
docs/cloudrun.md says which services use which, and why.

Standard library only (no pip packages beyond ComfyUI's own): Cloud Storage through its JSON API with the metadata
server's token.

Elsewhere (RunPod, Modal, any GPU host: Gen's docs/gpu-providers.md) the same image runs with no Google identity. Then
a request carries "store": {"broker": <Gen's /v1/gpu/broker URL>, "token": <this run's token>}, and every gs:// read and
write of the run goes through Gen's broker instead: models and inputs download from short-lived signed URLs (or through
Gen when it can't sign), outputs, the heartbeat and the manifest are PUT to Gen. The token is good for this run's folder
and for reading inputs and models, for a few hours, and nothing else. STORAGE=broker skips the boot preloads (there is
no bucket to read before a request brings a token); MODELS_MOUNT on a provider's network volume still works.

  GET  /ping      RunPod's load balancer health check: 200 when ready, 204 while starting
  WORKER_TOKEN    when set, POST /run needs the same value in X-Hawkes-Worker-Token (Gen's GPU_WORKER_TOKEN)

Besides graphs, two requests run code of Gen's own instead of a graph (same files, answer and manifest):
  {"hawkes_audio": spec}  an open voice model's run.py in its venv (Gen's src/tools/audio-open.ts)
  {"hawkes_job": spec}    a 3D tool's bash script in /var/tmp/hawkes-blender/<job> (Gen's src/providers/workspace.ts):
                          Blender, the rig, motion and mocap venvs. spec = {dir, script, files: {name: input name},
                          texts: {name: text}, collect: [folders]}; the answer is every file under the collected folders
                          (filename = its path in the job folder) and _hb.txt (the script's "HB ..." lines).
HAWKES_COMFY=0 is the 3D worker image (server/gpu3d/Dockerfile): no ComfyUI, ready at once, hawkes_job requests only.
HAWKES_WEIGHTS is where 3D jobs keep model weights between runs: a provider's network volume when one is mounted
(/runpod-volume, MODELS_MOUNT), else the container disk. A request's extra.hf_token (Gen's HF_TOKEN, never kept with
the job) reaches the script as HF_TOKEN for gated weights.
"""

import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COMFY_DIR = os.environ.get("COMFY_DIR", "/opt/comfy")
COMFY_URL = "http://127.0.0.1:8188"
PORT = int(os.environ.get("PORT", "8080"))
BUCKET = os.environ.get("HAWKES_BUCKET", "")
SERVICE = os.environ.get("HAWKES_SERVICE", "gen-gpu")
MODEL_LOAD = os.environ.get("MODEL_LOAD", "download")  # download | mount | none
STORAGE = os.environ.get("STORAGE", "gcs")  # gcs (this service's own identity) | broker (each request brings Gen's token)
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")
MODELS_MOUNT = os.environ.get("MODELS_MOUNT", "/mnt/models")
# "dir/file" entries, comma separated: what this service preloads (deploy.mjs sets it from services.json).
PRELOAD = [m for m in os.environ.get("HAWKES_MODELS", "").split(",") if m.strip()]
COMFY_FLAGS = os.environ.get("COMFY_FLAGS", "--disable-pinned-memory").split()
# The open voice models (Gen's docs/audio.md): one venv per model under here, made in the image (Dockerfile), with
# post/audio/run.py and asr.py beside them. Their weights come from Hugging Face on first use into the cache below
# (on the provider's volume when one is mounted, so a cold worker skips the download).
AUDIO_ROOT = os.environ.get("AUDIO_ROOT", "/opt/hawkes-audio")
NO_COMFY = os.environ.get("HAWKES_COMFY", "1") == "0"
JOB_ROOT = "/var/tmp/hawkes-blender"
HEARTBEAT_S = 15
CANCEL_CHECK_S = 5
CHUNK = 64 * 1024 * 1024
DIRECT_UPLOAD_BYTES = 8 * 1024 * 1024  # bigger files go straight to Cloud Storage (signed URL), not through Gen's broker
PROXY_WRITE_MAX = 30 * 1024 * 1024  # Cloud Run refuses request bodies over 32 MiB
BOOT = time.time()

state = {"ready": False, "detail": "starting", "readyAt": None, "cold": True, "error": None}
comfy_proc = None
object_info = None
gpu_lock = threading.Lock()
active = {}  # key -> Run
active_lock = threading.Lock()


def log(msg):
    print(f"[worker] {msg}", flush=True)


# ------------------------------------------------------------------ Cloud Storage

_token = {"value": None, "until": 0}
_token_lock = threading.Lock()


def token():
    with _token_lock:
        if _token["value"] and time.time() < _token["until"]:
            return _token["value"]
        req = urllib.request.Request(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
            headers={"Metadata-Flavor": "Google"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            t = json.load(r)
        _token["value"] = t["access_token"]
        _token["until"] = time.time() + int(t.get("expires_in", 300)) - 120
        return _token["value"]


def split_uri(uri):
    if not uri.startswith("gs://"):
        raise ValueError(f"not a gs:// URI: {uri}")
    b, _, name = uri[5:].partition("/")
    return b, name


def gcs_request(method, url, data=None, headers=None, timeout=120):
    h = {"Authorization": f"Bearer {token()}"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    return urllib.request.urlopen(req, timeout=timeout)


def obj_url(bucket, name):
    return f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{urllib.parse.quote(name, safe='')}"


def gcs_stat(uri):
    b, name = split_uri(uri)
    try:
        with gcs_request("GET", obj_url(b, name)) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def gcs_read(uri):
    b, name = split_uri(uri)
    try:
        with gcs_request("GET", obj_url(b, name) + "?alt=media") as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def gcs_write(uri, data, content_type="application/octet-stream"):
    b, name = split_uri(uri)
    url = f"https://storage.googleapis.com/upload/storage/v1/b/{b}/o?uploadType=media&name={urllib.parse.quote(name, safe='')}"
    for attempt in range(4):
        try:
            with gcs_request("POST", url, data=data, headers={"Content-Type": content_type, "Content-Length": str(len(data))}, timeout=600) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 3:
                raise
            log(f"upload {uri}: {e}; again")
            time.sleep(2 * (attempt + 1))


def gcs_download(uri, dest, parallel=16):
    """Copies an object to a local file with parallel ranged reads (the fast path Google's GPU guide recommends)."""
    meta = gcs_stat(uri)
    if meta is None:
        raise FileNotFoundError(uri)
    b, name = split_uri(uri)
    url = obj_url(b, name) + f"?alt=media&generation={meta['generation']}"
    return ranged_download(lambda h, timeout: gcs_request("GET", url, headers=h, timeout=timeout), int(meta["size"]), dest, name, parallel)


def ranged_download(get, size, dest, name, parallel=16):
    """Fills dest with `size` bytes from get(headers, timeout) (one Range at a time, CHUNK each, `parallel` at once)."""
    if os.path.exists(dest) and os.path.getsize(dest) == size:
        return size
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    fd = os.open(part, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        os.ftruncate(fd, size)

        def piece(start):
            end = min(size, start + CHUNK) - 1
            for attempt in range(5):
                try:
                    with get({"Range": f"bytes={start}-{end}"}, 300) as r:
                        off = start
                        while True:
                            buf = r.read(4 * 1024 * 1024)
                            if not buf:
                                break
                            os.pwrite(fd, buf, off)
                            off += len(buf)
                    if off != end + 1:
                        raise IOError(f"short read at {start}: {off - start} of {end - start + 1}")
                    return
                except Exception as e:  # noqa: BLE001 - every network error is worth a retry
                    if attempt == 4:
                        raise
                    log(f"{name} bytes {start}-{end}: {e}; again")
                    time.sleep(2 * (attempt + 1))

        with ThreadPoolExecutor(max_workers=parallel) as ex:
            list(ex.map(piece, range(0, size, CHUNK)))
    finally:
        os.close(fd)
    os.replace(part, dest)
    return size


class GcsStore:
    """Cloud Storage with this service's own identity (Cloud Run)."""

    stat = staticmethod(gcs_stat)
    read = staticmethod(gcs_read)
    write = staticmethod(gcs_write)
    download = staticmethod(gcs_download)


class BrokerStore:
    """Cloud Storage through Gen (/v1/gpu/broker) with one run's token: for hosts without a Google identity."""

    def __init__(self, broker, tok):
        if not broker.startswith("https://") and not broker.startswith("http://127.0.0.1"):
            raise ValueError("store.broker must be an https URL")
        self.broker = broker
        self.tok = tok

    def _req(self, op, uri, method="GET", data=None, headers=None, timeout=120):
        h = {"X-Hawkes-Run-Token": self.tok}
        h.update(headers or {})
        url = f"{self.broker}?op={op}&uri={urllib.parse.quote(uri, safe='')}"
        return urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=h), timeout=timeout)

    def stat(self, uri):
        try:
            with self._req("stat", uri) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def read(self, uri):
        try:
            with self._req("read", uri, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def write(self, uri, data, content_type="application/octet-stream"):
        # Cloud Run refuses request bodies over 32 MiB (HTTP 413), so anything sizeable goes straight to Cloud Storage
        # with a signed URL from the broker; small files (heartbeats, manifests) stay on the broker's own write.
        if len(data) > DIRECT_UPLOAD_BYTES:
            where = self._signed_put(uri)
            if where:
                return self._put_signed(where, uri, data, content_type)
            if len(data) > PROXY_WRITE_MAX:
                raise RuntimeError(f"{uri} is {len(data) // (1024 * 1024)} MB: over Cloud Run's 32 MB request limit and Gen gave no signed upload link (it can't sign)")
        for attempt in range(4):
            try:
                with self._req("write", uri, "PUT", data, {"Content-Type": content_type, "Content-Length": str(len(data))}, 600) as r:
                    return json.load(r)
            except (urllib.error.URLError, TimeoutError) as e:
                if isinstance(e, urllib.error.HTTPError):
                    log(f"upload {uri} ({len(data)} bytes) through the broker: HTTP {e.code} {e.reason}")
                    if e.code < 500:
                        raise
                if attempt == 3:
                    raise
                log(f"upload {uri}: {e}; again")
                time.sleep(2 * (attempt + 1))

    def _signed_put(self, uri):
        try:
            with self._req("put", uri) as r:
                return json.load(r).get("url")
        except urllib.error.HTTPError as e:
            log(f"signed upload link for {uri}: HTTP {e.code} {e.reason}")
            if e.code < 500:
                raise
            return None

    def _put_signed(self, url, uri, data, content_type):
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, data=data, method="PUT", headers={"Content-Type": content_type, "Content-Length": str(len(data))})
                with urllib.request.urlopen(req, timeout=900) as r:
                    r.read()
                return {"ok": True, "direct": True}
            except (urllib.error.URLError, TimeoutError) as e:
                if isinstance(e, urllib.error.HTTPError):
                    log(f"upload {uri} ({len(data)} bytes) to Cloud Storage: HTTP {e.code} {e.reason}")
                    if e.code < 500:
                        raise
                if attempt == 3:
                    raise
                log(f"upload {uri}: {e}; again")
                time.sleep(2 * (attempt + 1))

    def download(self, uri, dest, parallel=16):
        """Straight from Cloud Storage with a signed URL when Gen gives one (models are GBs), else through Gen."""
        try:
            with self._req("url", uri) as r:
                where = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise FileNotFoundError(uri) from None
            raise
        size = int(where["size"])
        name = split_uri(uri)[1]
        if where.get("url"):
            signed = where["url"]
            return ranged_download(lambda h, timeout: urllib.request.urlopen(urllib.request.Request(signed, headers=h), timeout=timeout), size, dest, name, parallel)
        return ranged_download(lambda h, timeout: self._req("read", uri, headers=h, timeout=timeout), size, dest, name, min(parallel, 4))


def store_for(req):
    """The run's storage: Gen's broker when the request brings one, else this service's own Cloud Storage access."""
    st = req.get("store") or {}
    if st.get("broker") and st.get("token"):
        return BrokerStore(str(st["broker"]), str(st["token"]))
    if STORAGE == "broker":
        raise ValueError("this worker reaches storage through Gen (STORAGE=broker) and the request has no store")
    return GcsStore


# ------------------------------------------------------------------ models


def model_dest(entry):
    d, _, f = entry.partition("/")
    return os.path.join(COMFY_DIR, "models", d, f)


def mounted():
    return os.path.isdir(MODELS_MOUNT) and bool(os.listdir(MODELS_MOUNT))


def place_model(entry, preload=False, store=GcsStore, bucket=None):
    """Puts one model (dir/file) where ComfyUI finds it: the service's preloads by its load mode; a model a job asks
    for beyond them from the mount when the service has one (no memory), else downloaded."""
    dest = model_dest(entry)
    if os.path.exists(dest):
        return 0
    if MODEL_LOAD == "mount" or (not preload and mounted()):
        src = os.path.join(MODELS_MOUNT, entry)
        if not os.path.exists(src):
            raise FileNotFoundError(f"{entry} is not in the models bucket (run tools/cloudrun/models-sync.mjs)")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        os.symlink(src, dest)
        return 0
    return store.download(f"gs://{bucket or BUCKET}/models/{entry}", dest)


MODEL_EXT = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx", ".sft")


def graph_models(graph):
    """Model files a graph names (string inputs ending in a model extension) that this instance doesn't have yet but
    the mounted bucket does, as dir/file entries. Code-built tools on the fleet rely on core models being installed;
    here anything in the bucket is found by name."""
    names = set()

    def walk(v):
        if isinstance(v, str) and v.lower().endswith(MODEL_EXT):
            names.add(v)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)

    for node in graph.values():
        walk(node.get("inputs", {}))
    if not names or not os.path.isdir(MODELS_MOUNT):
        return []
    models_root = os.path.join(COMFY_DIR, "models")
    dirs = [d for d in os.listdir(MODELS_MOUNT) if os.path.isdir(os.path.join(MODELS_MOUNT, d))]
    found = []
    for n in sorted(names):
        if any(os.path.exists(os.path.join(models_root, d, n)) for d in os.listdir(models_root)):
            continue
        for d in dirs:
            if os.path.exists(os.path.join(MODELS_MOUNT, d, n)):
                found.append(f"{d}/{n}")
                break
    return found


# ------------------------------------------------------------------ disk
# A provider's worker (RunPod, Modal) has one container disk and no models mount: every model a job needs is downloaded
# onto it, and before 2026-10-30 nothing ever left, so as jobs moved between families the disk filled ("[Errno 28] No
# space left on device", J). Before anything is downloaded: leftovers of earlier runs go, then the least recently used
# downloaded models until MIN_FREE is free (a model is downloaded again when a job needs it).
MIN_FREE = float(os.environ.get("HAWKES_MIN_FREE_GB", "12")) * 1e9
SCRATCH = ("input/hawkesgen", "output", "temp")


def free_bytes():
    return shutil.disk_usage(COMFY_DIR).free


def tidy_scratch(max_age=600):
    """Inputs, outputs and previews older than max_age seconds: leftovers of finished or failed runs."""
    now = time.time()
    for sub in SCRATCH:
        root = os.path.join(COMFY_DIR, sub)
        for d, _, files in os.walk(root):
            for f in files:
                p = os.path.join(d, f)
                try:
                    if now - os.path.getmtime(p) > max_age:
                        os.remove(p)
                except OSError:
                    pass


def models_size(entries, store=GcsStore, bucket=None):
    """Bytes the bucket says these models take (0 for any it can't say: the margin covers small ones)."""
    total = 0
    for e in entries:
        try:
            meta = store.stat(f"gs://{bucket or BUCKET}/models/{e}")
            total += int((meta or {}).get("size") or 0)
        except Exception:  # noqa: BLE001 - a size we can't read only makes the room smaller
            pass
    return total


def make_room(keep=(), need=None, on_step=None):
    """Frees disk for what comes next: old scratch first, then downloaded models (never symlinks, never `keep`), the least
    recently used first, until `need` bytes are free. Returns the bytes it freed."""
    need = MIN_FREE if need is None else need
    if free_bytes() >= need:
        return 0
    tidy_scratch()
    freed = 0
    if free_bytes() >= need:
        return freed
    keep = {os.path.abspath(k) for k in keep}
    models = []
    for d, _, files in os.walk(os.path.join(COMFY_DIR, "models")):
        for f in files:
            p = os.path.join(d, f)
            if os.path.islink(p) or os.path.abspath(p) in keep or not f.lower().endswith(MODEL_EXT):
                continue
            try:
                st = os.stat(p)
                models.append((max(st.st_atime, st.st_mtime), st.st_size, p))
            except OSError:
                pass
    for _, size, p in sorted(models):
        if free_bytes() >= need:
            break
        try:
            os.remove(p)
            freed += size
            if on_step:
                on_step(f"made room: removed {os.path.basename(p)} ({size // 1_000_000} MB)")
        except OSError:
            pass
    if free_bytes() < need:
        # Removed models ComfyUI still holds open keep their space until it lets go of them.
        try:
            comfy("/free", {"unload_models": True, "free_memory": True})
            time.sleep(2)
        except Exception:  # noqa: BLE001 - ComfyUI not up yet: nothing of it is held open
            pass
    if freed:
        log(f"made room: {freed / 1e9:.1f} GB of models removed, {free_bytes() / 1e9:.1f} GB free")
    if free_bytes() < need and on_step:
        on_step(f"only {free_bytes() / 1e9:.1f} GB free of the {need / 1e9:.1f} GB this job needs")
    return freed


def place_models(entries, on_step=None, preload=False, store=GcsStore, bucket=None):
    # The models this job uses count as just used (the least recently used go first when room is needed).
    for e in entries:
        try:
            os.utime(model_dest(e))
        except OSError:
            pass
    todo = [e for e in entries if not os.path.exists(model_dest(e))]
    if not todo:
        return
    if MODEL_LOAD != "mount" and not (not preload and mounted()):
        # Room for everything this job downloads plus the margin (2026-11-07: a fixed 12 GB let a 30 GB video family
        # start downloading onto 12 GB, and the job died with "No space left on device" in SaveVideo).
        make_room(keep=[model_dest(e) for e in entries], need=MIN_FREE + models_size(todo, store, bucket), on_step=on_step)
    t = time.time()
    total = [0]

    def one(e):
        if on_step:
            on_step(f"loading model {e}")
        total[0] += place_model(e, preload, store, bucket)

    # A few files at once, each one in parallel ranges.
    with ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(one, todo))
    gb = total[0] / 1e9
    log(f"placed {len(todo)} model(s), {gb:.1f} GB in {time.time() - t:.0f} s ({MODEL_LOAD})")


# ------------------------------------------------------------------ ComfyUI


def comfy(route, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(COMFY_URL + route, data=data, method="POST" if data is not None else "GET",
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def start_comfy():
    global comfy_proc, object_info
    object_info = None
    args = [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch", *COMFY_FLAGS]
    log(f"starting ComfyUI: {' '.join(args[1:])}")
    comfy_proc = subprocess.Popen(args, cwd=COMFY_DIR)
    for _ in range(600):
        if comfy_proc.poll() is not None:
            raise RuntimeError(f"ComfyUI exited with {comfy_proc.returncode} while starting")
        try:
            comfy("/system_stats", timeout=5)
            return
        except Exception:  # noqa: BLE001 - not up yet
            time.sleep(1)
    raise RuntimeError("ComfyUI did not answer within 10 minutes")


def comfy_alive():
    return comfy_proc is not None and comfy_proc.poll() is None


def comfy_ok():
    """Health: ComfyUI is up, or this image has none (the 3D worker)."""
    return NO_COMFY or comfy_alive()


def weights_dir():
    """Where 3D jobs keep weights: HAWKES_WEIGHTS, else a provider volume (RunPod mounts network volumes at
    /runpod-volume), else the models mount, else the container disk."""
    if os.environ.get("HAWKES_WEIGHTS"):
        return os.environ["HAWKES_WEIGHTS"]
    for base in ("/runpod-volume", MODELS_MOUNT):
        if base and os.path.isdir(base) and os.access(base, os.W_OK):
            return os.path.join(base, "hawkes-weights")
    return "/opt/hawkes-weights"


def free_comfy():
    """Lets go of what ComfyUI's last graph left on the GPU (nothing to do in the 3D image)."""
    if NO_COMFY or not comfy_alive():
        return
    try:
        comfy("/free", {"unload_models": True, "free_memory": True})
    except Exception:  # noqa: BLE001
        pass


def failure_tail(lines):
    """The useful end of a failed script's log: its last plain lines, and the last Python traceback whole."""
    plain = [ln for ln in lines if ln and not ln.startswith(("Fra:", "HB frame", "  "))][-20:]
    tb, inside = [], False
    for ln in lines:
        if ln.startswith("Traceback"):
            tb, inside = [ln], True
        elif inside:
            tb.append(ln)
    text = " / ".join(plain)
    if tb:
        text += "\n--- last Python traceback ---\n" + "\n".join(tb[-30:])
    return text[-3500:]


def get_object_info(refresh=False):
    global object_info
    if object_info is None or refresh:
        object_info = comfy("/object_info", timeout=120)
    return object_info


def fill_defaults(graph):
    """What Gen's Comfy.prepare does: a required setting a graph leaves out gets the node's own default."""
    info = get_object_info()
    for node in graph.values():
        d = info.get(node.get("class_type"))
        if not d:
            continue
        inputs = node.setdefault("inputs", {})
        for name, spec in (d.get("input", {}).get("required") or {}).items():
            if name in inputs or any(k.startswith(name + ".") for k in inputs):
                continue
            typ = spec[0] if spec else None
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            if typ == "COMFY_AUTOGROW_V3":
                continue
            if isinstance(typ, list) and typ:
                inputs[name] = opts.get("default", typ[0])
            elif "default" in opts:
                inputs[name] = opts["default"]
    return graph


def output_files(outputs):
    files = []
    for node, out in (outputs or {}).items():
        for lst in (out or {}).values():
            if not isinstance(lst, list):
                continue
            for f in lst:
                if isinstance(f, dict) and isinstance(f.get("filename"), str) and f.get("type", "output") == "output":
                    files.append({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": "output", "node": node})
    return files


class Lost(Exception):
    """ComfyUI restarted (out of memory, most often) and the graph went with it."""


class Cancelled(Exception):
    pass


class OverLimit(Exception):
    pass


class VramWatch:
    """Samples ComfyUI's /system_stats while a graph runs: the GPU memory in use at its peak (device-wide, what PyTorch
    holds included), so Gen can log what a tool really needs on the card."""

    def __init__(self, every=0.2):
        self.every, self.peak, self.total, self.name = every, 0, 0, None
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._loop, daemon=True)

    def _sample(self):
        try:
            dev = (comfy("/system_stats", timeout=5).get("devices") or [{}])[0]
            total, free = int(dev.get("vram_total") or 0), int(dev.get("vram_free") or 0)
            if total:
                self.total, self.name = total, dev.get("name")
                self.peak = max(self.peak, total - free)
        except Exception:  # noqa: BLE001 - a missed sample is only a missed sample
            pass

    def _loop(self):
        while not self._stop.wait(self.every):
            self._sample()

    def __enter__(self):
        self._sample()
        self._t.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._t.join(timeout=2)
        self._sample()

    def report(self):
        if not self.total:
            return None
        return {"peakMB": self.peak // 2**20, "totalMB": self.total // 2**20, "gpu": self.name}


def run_graph(graph, extra, run):
    """Queues a graph and waits for it, checking cancel, heartbeat and the time limit. -> output files."""
    with VramWatch() as watch:
        try:
            return _run_graph(graph, extra, run)
        finally:
            vram = watch.report()
            if vram:
                prev = getattr(run, "vram", None) or {}
                vram["peakMB"] = max(vram["peakMB"], prev.get("peakMB", 0))
                run.vram = vram


def _run_graph(graph, extra, run):
    body = {"prompt": graph, "client_id": "hawkesgen"}
    if extra:
        body["extra_data"] = extra
    try:
        queued = comfy("/prompt", body, timeout=120)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:1500]
        missing = []
        try:
            errs = json.loads(detail).get("node_errors", {})
            for ne in errs.values():
                for er in ne.get("errors", []):
                    v = str(er.get("extra_info", {}).get("received_value", ""))
                    if v.endswith((".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".onnx")):
                        missing.append(v)
        except Exception:  # noqa: BLE001 - not JSON
            pass
        raise RuntimeError(f"ComfyUI rejected the workflow: {detail}") from (Missing(missing) if missing else None)
    if queued.get("node_errors"):
        raise RuntimeError(f"ComfyUI rejected the workflow: {json.dumps(queued['node_errors'])[:1500]}")
    pid = queued["prompt_id"]
    started = time.time()
    while True:
        if run.cancelled():
            try:
                comfy("/interrupt", {})
            except Exception:  # noqa: BLE001
                pass
            raise Cancelled()
        if time.time() - started > run.limit:
            try:
                comfy("/interrupt", {})
            except Exception:  # noqa: BLE001
                pass
            raise OverLimit()
        if not comfy_alive():
            raise Lost()
        try:
            hist = comfy(f"/history/{pid}", timeout=30) or {}
        except Exception:  # noqa: BLE001 - ComfyUI busy or restarting; the alive check decides
            time.sleep(2)
            continue
        entry = hist.get(pid)
        if entry:
            st = entry.get("status") or {}
            if st.get("status_str") == "error":
                err = next((m[1] for m in st.get("messages", []) if m[0] == "execution_error"), {}) or {}
                raise RuntimeError(f"ComfyUI failed in {err.get('node_type', 'a node')}: {err.get('exception_message', 'see the service log')}")
            if st.get("completed") or entry.get("outputs"):
                return output_files(entry.get("outputs"))
        run.progress(f"running for {int(time.time() - started)}s")
        time.sleep(1)


class Missing(Exception):
    def __init__(self, models):
        super().__init__(", ".join(models))
        self.models = models


# ------------------------------------------------------------------ runs


class Run:
    def __init__(self, req):
        self.key = req["key"]
        self.out = req["out"].rstrip("/") + "/"
        self.bucket = split_uri(self.out)[0]
        self.store = store_for(req)
        self.limit = max(30, min(3540, int(req.get("timeoutSeconds") or 3500)))
        self.req = req
        self.events = []
        self.cond = threading.Condition()
        self.finished = False
        self.detail = "starting"
        self._cancel_checked = 0
        self._cancelled = False
        self._beat = 0

    def emit(self, ev):
        with self.cond:
            self.events.append(ev)
            if ev["t"] in ("done", "error"):
                self.finished = True
            self.cond.notify_all()

    def progress(self, detail):
        self.detail = detail
        now = time.time()
        if now - self._beat >= HEARTBEAT_S:
            self._beat = now
            self.emit({"t": "progress", "detail": detail})
            try:
                self.store.write(self.out + "heartbeat.json", json.dumps({"at": int(now * 1000), "detail": detail, "service": SERVICE,
                                                                    "instance": os.environ.get("K_REVISION", "") + "/" + str(os.getpid())}).encode(), "application/json")
            except Exception as e:  # noqa: BLE001 - a missed heartbeat only makes a restarted Gen wait less
                log(f"heartbeat: {e}")

    def step(self, detail):
        self._beat = 0
        self.progress(detail)

    def cancelled(self):
        if self._cancelled:
            return True
        now = time.time()
        if now - self._cancel_checked >= CANCEL_CHECK_S:
            self._cancel_checked = now
            try:
                self._cancelled = self.store.stat(self.out + "cancel") is not None
            except Exception:  # noqa: BLE001
                pass
        return self._cancelled

    def execute(self):
        t0 = time.time()
        cold = None
        if state["cold"]:
            state["cold"] = False
            cold = {"startupSeconds": round((state["readyAt"] or t0) - BOOT, 1)}
        try:
            final = self._execute()
        except Cancelled:
            final = {"t": "error", "message": "Cancelled", "cancelled": True}
        except OverLimit:
            final = {"t": "error", "message": f"ran past this service's {self.limit} s limit", "overLimit": True}
        except Lost:
            final = {"t": "error", "message": "ComfyUI restarted while running the workflow and lost it (it most likely ran out of memory)", "lost": True}
        except Exception as e:  # noqa: BLE001 - every failure goes back to Gen as an error line
            traceback.print_exc()
            final = {"t": "error", "message": str(e)}
            if isinstance(e.__cause__, Missing):
                final["missingModels"] = e.__cause__.models
        if final.get("t") == "error" and getattr(self, "sizes", None):
            final["outputs"] = self.sizes
        final["seconds"] = round(time.time() - t0, 1)
        final["cold"] = cold
        if getattr(self, "vram", None):
            final["vram"] = self.vram
        final["service"] = SERVICE
        if not final.get("cancelled"):
            try:
                self.store.write(self.out + "manifest.json", json.dumps(final).encode(), "application/json")
            except Exception as e:  # noqa: BLE001
                log(f"manifest for {self.key}: {e}")
        self.emit(final)

    def _audio(self, spec, written):
        """An open audio model's job (Gen's src/tools/audio-open.ts synthesize): run.py in the model's venv, not a graph.
        The same request, files and answer as a graph; the outputs are run.py's out/ folder (takes, result.json and the
        transcripts when asked)."""
        model = str(spec.get("model", ""))
        py = os.path.join(AUDIO_ROOT, model, "venv", "bin", "python")
        if not re.fullmatch(r"[\w.-]+", model) or not os.path.exists(py):
            have = sorted(d for d in os.listdir(AUDIO_ROOT) if os.path.exists(os.path.join(AUDIO_ROOT, d, "venv"))) if os.path.isdir(AUDIO_ROOT) else []
            raise RuntimeError(f"this worker image has no open audio model {model!r} (it has {', '.join(have) or 'none'}): build the GPU image again")
        work = tempfile.mkdtemp(prefix="audio-")
        try:
            items = []
            for it in spec.get("items") or []:
                it = dict(it)
                if it.get("ref"):
                    it["ref"] = os.path.join(COMFY_DIR, "input", it["ref"])
                items.append(it)
            with open(os.path.join(work, "spec.json"), "w") as fh:
                json.dump({**spec, "items": items}, fh)
            # The GPU is ComfyUI's too: let go of what its last graph left loaded.
            free_comfy()
            mounted_hf = os.path.join(MODELS_MOUNT, "hf")
            env = {**os.environ, "HF_HOME": mounted_hf if os.path.isdir(mounted_hf) else os.path.join(AUDIO_ROOT, "hf"), "HF_HUB_ENABLE_HF_TRANSFER": "0", "PYTHONUNBUFFERED": "1"}
            self.step(f"{'making sounds' if spec.get('task') == 'sfx' else 'speaking'} with {model}")
            self._proc([py, os.path.join(AUDIO_ROOT, "run.py"), "spec.json"], work, env)
            outdir = os.path.join(work, "out")
            asr_py = os.path.join(AUDIO_ROOT, "asr", "venv", "bin", "python")
            if spec.get("asr") and os.path.exists(asr_py):
                self.step("checking each take says its text")
                for name in sorted(os.listdir(outdir)):
                    if not name.endswith(".wav"):
                        continue
                    dest = os.path.join(outdir, name[:-4] + ".asr.json")
                    try:
                        r = subprocess.run([asr_py, os.path.join(AUDIO_ROOT, "asr.py"), os.path.join(outdir, name), str(spec.get("language") or "en")],
                                           cwd=work, env={**env, "ASR_DEVICE": "cpu"}, capture_output=True, text=True, timeout=300)
                        if r.returncode == 0 and r.stdout.strip():
                            line = r.stdout.strip().splitlines()[-1]
                        else:
                            line = json.dumps({"text": "", "error": f"exit {r.returncode}: " + " / ".join((r.stderr or "").strip().splitlines()[-6:])})
                    except Exception as e:  # noqa: BLE001 - an unchecked take is still a take (Gen says it wasn't checked)
                        line = json.dumps({"text": "", "error": str(e)})
                    with open(dest, "w") as fh:
                        fh.write(line)
            out = []
            for i, name in enumerate(sorted(os.listdir(outdir))):
                with open(os.path.join(outdir, name), "rb") as fh:
                    data = fh.read()
                uri = f"{self.out}{i:02d}-{name}"
                self.store.write(uri, data)
                out.append({"filename": name, "subfolder": "", "type": "output", "node": "audio", "uri": uri, "bytes": len(data)})
            return {"t": "done", "files": out}
        finally:
            shutil.rmtree(work, ignore_errors=True)
            for p in written:
                try:
                    os.remove(p)
                except OSError:
                    pass

    def _job(self, spec, written):
        """A 3D tool's script (Gen's src/providers/workspace.ts): the files and texts into the job folder, bash run.sh
        there, then every file under the collected folders back, plus _hb.txt (the script's HB lines)."""
        d = str(spec.get("dir", ""))
        if not re.fullmatch(re.escape(JOB_ROOT) + r"/[\w-]+", d):
            raise ValueError(f"bad job folder {d!r}")
        script = spec.get("script")
        if not isinstance(script, str) or not script.strip():
            raise ValueError("hawkes_job needs a script")

        def inside(name):
            if not isinstance(name, str) or not re.fullmatch(r"[\w./-]+", name) or ".." in name or name.startswith("/"):
                raise ValueError(f"bad file name {name!r}")
            p = os.path.normpath(os.path.join(d, name))
            if not p.startswith(d + os.sep):
                raise ValueError(f"bad file name {name!r}")
            return p

        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(os.path.join(d, "in"), exist_ok=True)
        try:
            inbox = os.path.join(COMFY_DIR, "input")
            for name, up in (spec.get("files") or {}).items():
                src = os.path.normpath(os.path.join(inbox, str(up)))
                if not src.startswith(inbox + os.sep) or not os.path.isfile(src):
                    raise ValueError(f"input {up!r} for {name} did not arrive")
                dest = inside(name)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copyfile(src, dest)
            for name, text in (spec.get("texts") or {}).items():
                dest = inside(name)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "w", encoding="utf-8") as fh:
                    fh.write(str(text))
            with open(os.path.join(d, "run.sh"), "w", encoding="utf-8") as fh:
                fh.write(script)
            free_comfy()
            weights = weights_dir()
            os.makedirs(weights, exist_ok=True)
            env = {**os.environ, "HAWKES_WEIGHTS": weights, "PYTHONUNBUFFERED": "1", "HOME": os.environ.get("HOME") or "/root"}
            token = (self.req.get("extra") or {}).get("hf_token")
            if token:
                env["HF_TOKEN"] = env["HUGGING_FACE_HUB_TOKEN"] = str(token)
            self.step("running the job's script")
            lines = self._proc(["bash", "run.sh"], d, env, label="the 3D job")
            out = []
            n = 0
            for folder in spec.get("collect") or ["res"]:
                root = inside(folder)
                if not os.path.isdir(root):
                    continue
                for base, _dirs, names in os.walk(root):
                    for name in sorted(names):
                        full = os.path.join(base, name)
                        rel = os.path.relpath(full, d).replace(os.sep, "/")
                        with open(full, "rb") as fh:
                            data = fh.read()
                        uri = f"{self.out}{n:03d}-{re.sub(r'[^A-Za-z0-9_.-]', '_', rel)}"
                        n += 1
                        self.step(f"saving {rel} ({len(data) // 1024} KB)")
                        self.store.write(uri, data)
                        out.append({"filename": rel, "subfolder": "", "type": "output", "node": "job", "uri": uri, "bytes": len(data)})
            hb = "\n".join(ln for ln in lines if ln.startswith("HB ")).encode()
            uri = f"{self.out}{n:03d}-_hb.txt"
            self.store.write(uri, hb, "text/plain")
            out.append({"filename": "_hb.txt", "subfolder": "", "type": "output", "node": "job", "uri": uri, "bytes": len(hb)})
            return {"t": "done", "files": out}
        finally:
            shutil.rmtree(d, ignore_errors=True)
            for p in written:
                try:
                    os.remove(p)
                except OSError:
                    pass

    def _proc(self, cmd, cwd, env, label="the audio model"):
        """Runs a command, passing its "HB step ..." lines on as steps (and "HB frame i n" as progress), with the run's
        cancel and time limit. Returns the log's lines."""
        logf = os.path.join(cwd, "run.log")
        started = time.time()
        with open(logf, "w") as lf:
            p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=lf, stderr=subprocess.STDOUT)
        seen = 0
        while True:
            code = p.poll()
            with open(logf, errors="replace") as fh:
                lines = fh.read().splitlines()
            for line in lines[seen:]:
                if line.startswith("HB step "):
                    self.step(line[8:])
                elif line.startswith("HB frame "):
                    self.progress("frame " + line[9:].replace(" ", " of ", 1))
            seen = len(lines)
            if code is not None:
                if code != 0:
                    raise RuntimeError(f"{label} failed (exit {code}): " + failure_tail(lines))
                return lines
            if self.cancelled():
                p.kill()
                raise Cancelled()
            if time.time() - started > self.limit:
                p.kill()
                raise OverLimit()
            self.progress(f"running for {int(time.time() - started)}s")
            time.sleep(1)

    def _execute(self):
        done = self.store.read(self.out + "manifest.json")
        if done:
            m = json.loads(done)
            if m.get("t") == "done":
                self.step("already done (answered from the manifest)")
                return m
        req = self.req
        if req.get("models"):
            self.step(f"loading {len(req['models'])} more model(s)")
            place_models([f"{m['dir']}/{m['file']}" for m in req["models"]], self.step, store=self.store, bucket=self.bucket)
        # Inputs go straight into ComfyUI's input folder under the names the graph uses (room made first).
        make_room(on_step=self.step)
        written = []
        for name, uri in (req.get("files") or {}).items():
            dest = os.path.normpath(os.path.join(COMFY_DIR, "input", name))
            if not dest.startswith(os.path.join(COMFY_DIR, "input")):
                raise ValueError(f"bad input name {name}")
            if not os.path.exists(dest):
                self.step(f"fetching input {name}")
                self.store.download(uri, dest, parallel=4)
                written.append(dest)
        if isinstance(req["graph"], dict) and "hawkes_audio" in req["graph"]:
            return self._audio(req["graph"]["hawkes_audio"], written)
        if isinstance(req["graph"], dict) and "hawkes_job" in req["graph"]:
            return self._job(req["graph"]["hawkes_job"], written)
        if NO_COMFY:
            raise RuntimeError("this is the 3D worker image (no ComfyUI): it runs hawkes_job requests, not graphs")
        more = graph_models(req["graph"])
        if more:
            self.step(f"linking {len(more)} model(s) from the bucket")
            place_models(more, self.step, store=self.store, bucket=self.bucket)
        graph = fill_defaults(req["graph"])
        self.step("queued on the GPU")
        files = []
        try:
            try:
                files = run_graph(graph, req.get("extra"), self)
            except Lost:
                # Once more, like Gen does on the fleet: the inputs are still on this instance's disk.
                self.step("ComfyUI restarted (out of memory?); restarting it and running the graph once more")
                restart_comfy()
                files = run_graph(graph, req.get("extra"), self)
            out = []
            self.sizes = []
            for i, f in enumerate(files):
                src = os.path.join(COMFY_DIR, "output", f["subfolder"], f["filename"])
                self.sizes.append({"filename": f["filename"], "bytes": os.path.getsize(src)})
            for i, f in enumerate(files):
                src = os.path.join(COMFY_DIR, "output", f["subfolder"], f["filename"])
                with open(src, "rb") as fh:
                    data = fh.read()
                uri = f"{self.out}{i:02d}-{f['filename']}"
                self.step(f"saving {f['filename']} ({len(data) // 1024} KB)")
                try:
                    self.store.write(uri, data)
                except Exception as e:  # noqa: BLE001 - say which file and how big, then fail as before
                    raise RuntimeError(f"saving {f['filename']} ({len(data) // 1024} KB) failed: {e}") from e
                out.append({**f, "uri": uri, "bytes": len(data)})
            return {"t": "done", "files": out}
        finally:
            # The instance's disk is its memory: nothing of this run stays behind, done or failed.
            for f in files:
                try:
                    os.remove(os.path.join(COMFY_DIR, "output", f["subfolder"], f["filename"]))
                except OSError:
                    pass
            for p in written:
                try:
                    os.remove(p)
                except OSError:
                    pass


def restart_comfy():
    global comfy_proc
    if comfy_proc and comfy_proc.poll() is None:
        comfy_proc.kill()
        comfy_proc.wait(30)
    start_comfy()


def begin_run(req):
    """The run for this key: the one in progress here, or a new one started on a thread (one GPU run at a time)."""
    with active_lock:
        r = active.get(req["key"])
        if r and not r.finished:
            return r, True
        r = Run(req)
        active[req["key"]] = r

    def go():
        if not gpu_lock.acquire(blocking=False):
            r.emit({"t": "progress", "detail": "waiting for this instance's earlier run to finish"})
            gpu_lock.acquire()
        try:
            r.execute()
        finally:
            # Nothing of a run stays on the disk, done or failed (a failed graph's partial outputs used to stay until
            # the disk was nearly full). Safe here: this instance runs one run at a time and this one holds the lock.
            try:
                tidy_scratch(max_age=0)
            except Exception as e:  # noqa: BLE001
                log(f"tidy: {e}")
            gpu_lock.release()
            with active_lock:
                if active.get(r.key) is r:
                    del active[r.key]

    threading.Thread(target=go, daemon=True).start()
    return r, False


# ------------------------------------------------------------------ HTTP


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter: one line per request
        if not self.path.startswith(("/ready", "/healthz", "/ping")):
            log(f"{self.command} {self.path} {fmt % args}")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            return self._json(200, {"ok": True})
        if self.path == "/ping":
            return self._json(200 if state["ready"] and comfy_ok() else 204, {"ready": state["ready"]})
        if self.path == "/ready":
            ok = state["ready"] and comfy_ok()
            return self._json(200 if ok else 503, {"ready": ok, "detail": state["detail"], "error": state["error"], "service": SERVICE,
                                                   "uptime": round(time.time() - BOOT, 1), "models": MODEL_LOAD})
        return self._json(404, {"error": "not found"})

    def _chunk(self, obj):
        data = (json.dumps(obj) + "\n").encode()
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def do_POST(self):
        if self.path != "/run":
            return self._json(404, {"error": "not found"})
        if WORKER_TOKEN and not hmac.compare_digest(self.headers.get("X-Hawkes-Worker-Token", ""), WORKER_TOKEN):
            return self._json(401, {"error": "no valid worker token"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n))
            for k in ("key", "graph", "out"):
                if not req.get(k):
                    raise ValueError(f"{k} is required")
            if not req["out"].startswith("gs://"):
                raise ValueError("out must be a gs:// prefix")
            # A hawkes_job is a bash script: only a caller holding the worker token may send one (Cloud Run's own IAM
            # counts, where the service has its Google identity and no broker).
            if isinstance(req["graph"], dict) and "hawkes_job" in req["graph"] and not WORKER_TOKEN and STORAGE == "broker" \
                    and os.environ.get("HAWKES_ALLOW_UNTOKENED_JOBS") != "1":
                raise ValueError("this worker has no WORKER_TOKEN, so it refuses hawkes_job scripts (set GPU_WORKER_TOKEN in Gen and WORKER_TOKEN here)")
            store_for(req)
        except Exception as e:  # noqa: BLE001
            return self._json(400, {"error": str(e)})
        if not state["ready"]:
            return self._json(503, {"error": f"not ready: {state['detail']}"})
        run, attached = begin_run(req)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        sent = 0
        try:
            if attached:
                self._chunk({"t": "progress", "detail": f"attached to the run already going here ({run.detail})"})
            while True:
                with run.cond:
                    while sent >= len(run.events):
                        if not run.cond.wait(timeout=HEARTBEAT_S):
                            break
                    batch = run.events[sent:]
                sent += len(batch)
                if not batch:
                    self._chunk({"t": "progress", "detail": run.detail})
                for ev in batch:
                    self._chunk(ev)
                if run.finished and sent >= len(run.events):
                    break
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # Gen went away (a restart, a deploy): the run goes on and leaves its manifest for Gen to find.
            log(f"client left run {run.key[:12]}; it keeps going")


def boot():
    try:
        if MODEL_LOAD != "none" and PRELOAD and STORAGE != "broker":
            if MODEL_LOAD == "download" and not BUCKET:
                raise RuntimeError("HAWKES_BUCKET is not set")
            state["detail"] = f"loading {len(PRELOAD)} models ({MODEL_LOAD})"
            place_models(PRELOAD, preload=True)
        if not NO_COMFY:
            state["detail"] = "starting ComfyUI"
            start_comfy()
            get_object_info()
        state["ready"] = True
        state["readyAt"] = time.time()
        state["detail"] = "ready"
        log(f"ready in {time.time() - BOOT:.0f} s")
    except Exception as e:  # noqa: BLE001 - /ready says what failed; the startup probe then fails the instance
        traceback.print_exc()
        state["error"] = str(e)
        state["detail"] = f"failed: {e}"


def main():
    os.makedirs(os.path.join(COMFY_DIR, "input", "hawkesgen"), exist_ok=True)
    os.makedirs(os.path.join(COMFY_DIR, "output"), exist_ok=True)
    threading.Thread(target=boot, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    log(f"listening on :{PORT} ({SERVICE}, models {MODEL_LOAD}, {len(PRELOAD)} preloaded)")
    srv.serve_forever()


if __name__ == "__main__":
    os.umask(0o022)
    main()
