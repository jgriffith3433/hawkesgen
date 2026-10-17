"""Hawkes Gen client for Python 3.8+ (standard library only), e.g. for Blender
scripts and asset tooling. Copy this file next to your script.

    from hawkesgen import HawkesGen
    gen = HawkesGen(project="phorigins")
    job = gen.run(preset="material", params={"prompt": "cracked concrete floor"})
    gen.download(job["outputs"][0]["asset"], "concrete.png")

    job = gen.run("mesh.textured", inputs={"image": r"C:\\path\\to\\prop.png"}, params={"faces": 60000})

Inputs are local file paths (from this PC), "asset:<id>" or "blob:<sha256>".
The service must be running (C:\\Projects\\hawkesgen\\auto-start.bat).
Source of truth: C:\\Projects\\hawkesgen\\clients\\python\\hawkesgen.py.
"""

import json
import os
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request

CLIENT_VERSION = 6


class HawkesGenError(Exception):
    def __init__(self, message, status=None, kind=None, job=None):
        super().__init__(message)
        self.status, self.kind, self.job = status, kind, job


class HawkesGen:
    def __init__(self, url=None, key=None, project=None):
        # The arguments, else HAWKESGEN_URL / HAWKESGEN_KEY, else ~/.hawkes/client.json, else this PC.
        cfg = {}
        try:
            with open(os.path.join(os.path.expanduser("~"), ".hawkes", "client.json"), encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            pass
        self.url = (url or os.environ.get("HAWKESGEN_URL") or cfg.get("genUrl") or "http://127.0.0.1:8790").rstrip("/")
        self.key = key or os.environ.get("HAWKESGEN_KEY") or cfg.get("genKey")
        self.project = project
        self.local = urllib.parse.urlparse(self.url).hostname in ("127.0.0.1", "localhost", "::1")

    def request(self, path, method="GET", body=None, raw=False, headers=None):
        h = {"X-Hawkes-Client": "py/%d" % CLIENT_VERSION, **(headers or {})}
        data = None
        if body is not None:
            if isinstance(body, (bytes, bytearray)):
                data = bytes(body)
            else:
                data = json.dumps(body).encode("utf-8")
                h["Content-Type"] = "application/json"
        if self.key:
            h["Authorization"] = "Bearer " + self.key
        req = urllib.request.Request(self.url + "/v1" + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                payload = r.read()
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8"))
            except Exception:
                err = {}
            raise HawkesGenError(err.get("error", f"HTTP {e.code}"), e.code, err.get("kind"))
        except urllib.error.URLError as e:
            raise HawkesGenError(f"Can't reach Hawkes Gen at {self.url} ({e.reason}). Start it: C:\\Projects\\hawkesgen\\auto-start.bat", 0, "offline")
        return payload if raw else json.loads(payload.decode("utf-8") or "{}")

    def health(self):
        return self.request("/health")

    def tools(self):
        return self.request("/tools")["tools"]

    def presets(self, project=None):
        return self.request("/presets/" + (project or self.project))

    def upload(self, path):
        with open(path, "rb") as f:
            return self.request("/blobs", "POST", f.read(), headers={"X-Filename": os.path.basename(path)})["blob"]

    def _inputs(self, inputs):
        if self.local or not inputs:
            return inputs or {}
        out = {}
        for k, v in inputs.items():
            one = lambda x: x if str(x).startswith(("asset:", "blob:")) else self.upload(x)
            out[k] = [one(x) for x in v] if isinstance(v, list) else one(v)
        return out

    def submit(self, tool=None, params=None, inputs=None, preset=None, labels=None, key=None, project=None):
        body = {"tool": tool, "project": project or self.project, "params": params or {}, "inputs": self._inputs(inputs), "preset": preset, "labels": labels, "key": key}
        if not body["project"]:
            raise HawkesGenError("Give a project (HawkesGen(project=...) or project=...)")
        return self.request("/jobs", "POST", {k: v for k, v in body.items() if v is not None})["jobs"][0]

    def job(self, job_id):
        return self.request("/jobs/" + job_id)

    def wait(self, job_id, timeout=7200, poll=1.5, on_update=None, raise_on_fail=True):
        end, last = time.time() + timeout, None
        while True:
            j = self.job(job_id)
            sig = (j["status"], j.get("detail"), len(j.get("outputs") or []))
            if sig != last:
                last = sig
                if on_update:
                    on_update(j)
            if j["status"] in ("done", "failed", "cancelled"):
                if raise_on_fail and j["status"] != "done":
                    raise HawkesGenError(f"{j['tool']} {j['status']}: {j.get('error') or j.get('detail')}", kind=j["status"], job=j)
                return j
            if time.time() > end:
                raise HawkesGenError(f"Timed out waiting for {job_id}", kind="timeout", job=j)
            time.sleep(poll)

    def run(self, tool=None, timeout=7200, on_update=None, **kw):
        return self.wait(self.submit(tool, **kw)["id"], timeout=timeout, on_update=on_update)

    def asset(self, asset_id):
        return self.request("/assets/" + asset_id)

    def download(self, asset_id, dest):
        os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
        if self.local:
            a = self.asset(asset_id)
            if a.get("path") and os.path.exists(a["path"]):
                shutil.copyfile(a["path"], dest)
                return dest
        with open(dest, "wb") as f:
            f.write(self.request("/files/" + asset_id, raw=True))
        return dest

    # ------------------------------------------------------------ the library (docs/library.md)
    # Entities ("doseofdestruction/break"), their slots ("side", "pose/air") and every version of each slot.

    @staticmethod
    def _slot_path(entity_id, slot):
        return "/entities/" + entity_id + "/slots/" + "/".join(urllib.parse.quote(p, safe="") for p in str(slot).split("/"))

    def entities(self, project=None, kind=None, q=None, limit=100):
        query = {k: v for k, v in {"project": project or self.project, "kind": kind, "q": q, "limit": limit}.items() if v}
        return self.request("/entities?" + urllib.parse.urlencode(query))

    def entity(self, entity_id):
        return self.request("/entities/" + entity_id)

    def create_entity(self, name, kind, project=None, slug=None, data=None, upsert=False):
        body = {"project": project or self.project, "name": name, "kind": kind, "slug": slug, "data": data, "upsert": upsert}
        return self.request("/entities", "POST", {k: v for k, v in body.items() if v is not None})

    def update_entity(self, entity_id, **patch):
        return self.request("/entities/" + entity_id, "PATCH", patch)

    def slot(self, entity_id, slot):
        return self.request(self._slot_path(entity_id, slot))

    def current(self, entity_id, slot):
        return (self.entity(entity_id).get("slots", {}).get(slot) or {}).get("current")

    def add_version(self, entity_id, slot, file, note=None, status=None, title=None):
        """file: a local path (uploaded), "asset:<id>" or "blob:<sha256>"."""
        ref = file if str(file).startswith(("asset:", "blob:")) else self.upload(file)
        body = {k: v for k, v in {"file": ref, "note": note, "status": status, "title": title}.items() if v is not None}
        return self.request(self._slot_path(entity_id, slot) + "/versions", "POST", body)

    def pick(self, version_id, note=None):
        body = {"status": "current"}
        if note is not None:
            body["note"] = note
        return self.request("/versions/" + version_id, "PATCH", body)

    def discard(self, version_id):
        return self.request("/versions/" + version_id, "PATCH", {"status": "discarded"})

    def note(self, version_id, note):
        return self.request("/versions/" + version_id, "PATCH", {"note": note})

    def make(self, entity_id, slot, make=None, feedback=None, count=None, params=None, note=None):
        """New takes for a slot (its own recipe unless make is given). Returns the job; wait() on it."""
        body = {k: v for k, v in {"make": make, "feedback": feedback, "count": count, "params": params, "note": note}.items() if v is not None}
        return self.request(self._slot_path(entity_id, slot) + "/make", "POST", body)

    def revise(self, entity_id, slot, feedback, version=None, count=None):
        body = {k: v for k, v in {"feedback": feedback, "version": version, "count": count}.items() if v is not None}
        return self.request(self._slot_path(entity_id, slot) + "/revise", "POST", body)
