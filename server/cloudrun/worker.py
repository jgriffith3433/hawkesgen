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
                  {"t":"done","files":[{filename,subfolder,type,node,uri,bytes}],"seconds":..,"cold":{..}|null} or
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
"""

import json
import os
import subprocess
import sys
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
MODELS_MOUNT = os.environ.get("MODELS_MOUNT", "/mnt/models")
# "dir/file" entries, comma separated: what this service preloads (deploy.mjs sets it from services.json).
PRELOAD = [m for m in os.environ.get("HAWKES_MODELS", "").split(",") if m.strip()]
COMFY_FLAGS = os.environ.get("COMFY_FLAGS", "--disable-pinned-memory").split()
HEARTBEAT_S = 15
CANCEL_CHECK_S = 5
CHUNK = 64 * 1024 * 1024
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
    size = int(meta["size"])
    if os.path.exists(dest) and os.path.getsize(dest) == size:
        return size
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    b, name = split_uri(uri)
    url = obj_url(b, name) + f"?alt=media&generation={meta['generation']}"
    fd = os.open(part, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        os.ftruncate(fd, size)

        def piece(start):
            end = min(size, start + CHUNK) - 1
            for attempt in range(5):
                try:
                    with gcs_request("GET", url, headers={"Range": f"bytes={start}-{end}"}, timeout=300) as r:
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


# ------------------------------------------------------------------ models


def model_dest(entry):
    d, _, f = entry.partition("/")
    return os.path.join(COMFY_DIR, "models", d, f)


def mounted():
    return os.path.isdir(MODELS_MOUNT) and bool(os.listdir(MODELS_MOUNT))


def place_model(entry, preload=False):
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
    return gcs_download(f"gs://{BUCKET}/models/{entry}", dest)


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


def place_models(entries, on_step=None, preload=False):
    todo = [e for e in entries if not os.path.exists(model_dest(e))]
    if not todo:
        return
    t = time.time()
    total = [0]

    def one(e):
        if on_step:
            on_step(f"loading model {e}")
        total[0] += place_model(e, preload)

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


def run_graph(graph, extra, run):
    """Queues a graph and waits for it, checking cancel, heartbeat and the time limit. -> output files."""
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
                gcs_write(self.out + "heartbeat.json", json.dumps({"at": int(now * 1000), "detail": detail, "service": SERVICE,
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
                self._cancelled = gcs_stat(self.out + "cancel") is not None
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
        final["seconds"] = round(time.time() - t0, 1)
        final["cold"] = cold
        final["service"] = SERVICE
        if not final.get("cancelled"):
            try:
                gcs_write(self.out + "manifest.json", json.dumps(final).encode(), "application/json")
            except Exception as e:  # noqa: BLE001
                log(f"manifest for {self.key}: {e}")
        self.emit(final)

    def _execute(self):
        done = gcs_read(self.out + "manifest.json")
        if done:
            m = json.loads(done)
            if m.get("t") == "done":
                self.step("already done (answered from the manifest)")
                return m
        req = self.req
        if req.get("models"):
            self.step(f"loading {len(req['models'])} more model(s)")
            place_models([f"{m['dir']}/{m['file']}" for m in req["models"]], self.step)
        # Inputs go straight into ComfyUI's input folder under the names the graph uses.
        written = []
        for name, uri in (req.get("files") or {}).items():
            dest = os.path.normpath(os.path.join(COMFY_DIR, "input", name))
            if not dest.startswith(os.path.join(COMFY_DIR, "input")):
                raise ValueError(f"bad input name {name}")
            if not os.path.exists(dest):
                self.step(f"fetching input {name}")
                gcs_download(uri, dest, parallel=4)
                written.append(dest)
        more = graph_models(req["graph"])
        if more:
            self.step(f"linking {len(more)} model(s) from the bucket")
            place_models(more, self.step)
        graph = fill_defaults(req["graph"])
        self.step("queued on the GPU")
        try:
            files = run_graph(graph, req.get("extra"), self)
        except Lost:
            # Once more, like Gen does on the fleet: the inputs are still on this instance's disk.
            self.step("ComfyUI restarted (out of memory?); restarting it and running the graph once more")
            restart_comfy()
            files = run_graph(graph, req.get("extra"), self)
        out = []
        for i, f in enumerate(files):
            src = os.path.join(COMFY_DIR, "output", f["subfolder"], f["filename"])
            with open(src, "rb") as fh:
                data = fh.read()
            uri = f"{self.out}{i:02d}-{f['filename']}"
            self.step(f"saving {f['filename']} ({len(data) // 1024} KB)")
            gcs_write(uri, data)
            out.append({**f, "uri": uri, "bytes": len(data)})
            # The instance's disk is its memory: nothing stays behind.
            try:
                os.remove(src)
            except OSError:
                pass
        for p in written:
            try:
                os.remove(p)
            except OSError:
                pass
        return {"t": "done", "files": out}


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
        if not self.path.startswith(("/ready", "/healthz")):
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
        if self.path == "/ready":
            ok = state["ready"] and comfy_alive()
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
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n))
            for k in ("key", "graph", "out"):
                if not req.get(k):
                    raise ValueError(f"{k} is required")
            if not req["out"].startswith("gs://"):
                raise ValueError("out must be a gs:// prefix")
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
        if MODEL_LOAD != "none" and PRELOAD:
            if MODEL_LOAD == "download" and not BUCKET:
                raise RuntimeError("HAWKES_BUCKET is not set")
            state["detail"] = f"loading {len(PRELOAD)} models ({MODEL_LOAD})"
            place_models(PRELOAD, preload=True)
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
    threading.Thread(target=boot, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    log(f"listening on :{PORT} ({SERVICE}, models {MODEL_LOAD}, {len(PRELOAD)} preloaded)")
    srv.serve_forever()


if __name__ == "__main__":
    os.umask(0o022)
    main()
