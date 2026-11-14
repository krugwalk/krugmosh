#!/usr/bin/env python3
"""
mosh_server.py - local helper the Premiere Pro panel talks to.

Premiere panels can't run programs directly, so the panel sends jobs here over
http://127.0.0.1:8765 and this server runs mosh.py's pipeline.

  GET  /health                -> {"ok": true, "ffmpeg": "..."}
  POST /mosh                  -> {"job": "<id>"}      body: see run_job()
  POST /scan                  -> {"job": "<id>"}      list keyframes (result.keyframes)
  GET  /jobs/<id>/thumb/<f>   -> keyframe thumbnail from a scan job
  GET  /jobs/<id>             -> {"state": "running"|"done"|"error"|"cancelled", "log": [...], "result": {...}}
  POST /jobs/<id>/cancel      -> stop a running job
  GET  /jobs/<id>/preview.png -> strip of frames around the cut
  POST /jobs/<id>/reveal      -> show the rendered file in Explorer

Run:  python mosh_server.py   (leave the window open while using the panel)
"""
import json
import os
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import mosh

HOST, PORT = "127.0.0.1", int(os.environ.get("DATAMOSH_PORT", "8765"))
VERSION = 10  # bump when the panel needs new helper features (panel checks this)
JOBS = {}      # id -> JSON-safe job state
CANCELS = {}   # id -> threading.Event
LOCK = threading.Lock()
SEEN_CLIENTS = set()
PREVIEW_DIR = Path(tempfile.gettempdir()) / "datamosh_previews"
RENDER_DIR = Path(tempfile.gettempdir()) / "datamosh_renders"


PRESET_NAME = "Datamosh ProRes 422 HQ (Match Source).epr"


def make_preset():
    """Copy Premiere's own 'Apple ProRes 422 HQ' preset with Match Source switched on,
    so Premiere renders the selection at the sequence's own size and frame rate."""
    out = Path(__file__).parent / "presets" / PRESET_NAME
    if out.exists():
        return out
    roots = sorted(Path(os.environ.get("ProgramFiles", r"C:\Program Files"), "Adobe")
                   .glob("Adobe Premiere Pro*"), reverse=True)
    for root in roots:
        for src in root.glob("MediaIO/systempresets/*/Apple ProRes 422 HQ.epr"):
            text = src.read_text(encoding="utf-8")
            # <ParamIdentifier>ADBEVideoMatchSource</ParamIdentifier> ... <ParamValue>false</ParamValue>
            i = text.find("<ParamIdentifier>ADBEVideoMatchSource</ParamIdentifier>")
            if i == -1:
                continue
            j = text.find("<ParamValue>false</ParamValue>", i)
            k = text.find("</ExporterParam>", i)
            if j == -1 or j > k:
                continue
            text = text[:j] + "<ParamValue>true</ParamValue>" + text[j + len("<ParamValue>false</ParamValue>"):]
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text, encoding="utf-8")
            return out
    raise FileNotFoundError("Couldn't find Premiere's 'Apple ProRes 422 HQ' preset to base the render on.")


def wait_for_file(path, log, cancel, timeout=1800):
    """Premiere may still be writing a render: wait until the file exists and stops growing."""
    p = Path(path)
    start, last, stable = time.time(), -1, 0
    told = False
    while time.time() - start < timeout:
        if cancel.is_set():
            raise mosh.Cancelled("cancelled")
        size = p.stat().st_size if p.exists() else -1
        if size > 0 and size == last:
            stable += 1
            if stable >= 3:          # unchanged for ~1.5 s
                return
        else:
            stable = 0
            if size >= 0 and last >= 0 and not told:
                log(f"Waiting for Premiere to finish writing {p.name}...")
                told = True
        last = size
        time.sleep(0.5)
    raise TimeoutError(f"{p.name} never finished writing")


def run_job(job_id, req):
    job = JOBS[job_id]

    def log(msg):
        with LOCK:
            job["log"].append(msg)
        print(f"[{job_id}] {msg}", flush=True)

    try:
        clips = req["clips"]
        if not clips:
            raise ValueError("no clips")
        for path in sorted({c["path"] for c in clips}):
            if req.get("rendered"):   # a fresh Premiere render: make sure it's complete
                wait_for_file(path, log, CANCELS[job_id])
            if not Path(path).exists():
                raise ValueError(f"file not found: {path}")

        out_dir = Path(req.get("outputDir") or Path.home() / "Videos" / "Datamosh Renders")
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output = out_dir / f"moshed_{stamp}.mov"
        avi = out_dir / f"moshed_{stamp}.avi" if req.get("keepAvi") else None
        size = tuple(req["size"]) if req.get("size") else None
        PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

        cuts = req.get("cuts")
        common = dict(quant=int(req.get("quant", 2)), size=size, fps=req.get("fps"),
                      cuts=[bool(c) for c in cuts] if cuts else None,
                      trim_b=int(req.get("trimB", 0)), heal_after=int(req.get("healAfter", 0)),
                      gop=max(1, int(req.get("gop", 999))),
                      log=log, cancel=CANCELS[job_id])

        if job["kind"] == "scan":
            result = mosh.scan_clips(clips, thumbs_dir=PREVIEW_DIR / job_id, **common)
        else:
            rng = req.get("range")
            result = mosh.mosh_clips(
                clips, output, trim_a=int(req.get("trimA", 0)),
                only_joins=bool(req.get("onlyJoins", False)), avi=avi,
                preview=PREVIEW_DIR / f"{job_id}.png",
                mode="manual" if req.get("mode") == "manual" else "auto",
                keyframes=req.get("keyframes"),
                frame_range=(float(rng[0]), float(rng[1])) if rng else None,
                timeline_starts=req.get("timelineStarts"),
                bloom=int(req.get("bloom", 0)), bloom_at=int(req.get("bloomAt", 0)),
                bloom_auto=bool(req.get("bloomAuto", True)),
                bloom_smooth=bool(req.get("bloomSmooth", True)),
                bloom_points=req.get("bloomPoints") or None,
                bloom_cuts=[bool(b) for b in req["bloomCuts"]] if req.get("bloomCuts") else None,
                smear_frames=int(req.get("smearFrames", 0)),
                smear_repeat=int(req.get("smearRepeat", 1)),
                color=req.get("color") or None,
                audio=bool(req.get("audio", True)),
                **common)
        with LOCK:
            job["result"] = result
            job["state"] = "done"
    except mosh.Cancelled:
        log("Cancelled.")
        with LOCK:
            job["state"] = "cancelled"
    except BaseException as e:  # mosh.py uses sys.exit() for tool errors
        log(f"ERROR: {e}")
        with LOCK:
            job["state"] = "error"
            job["error"] = str(e)
    finally:
        with LOCK:
            job["finished"] = time.time()


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, ctype):
        data = Path(path).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _job_route(self):
        """'/jobs/<id>/<action>' -> (id, job, action)."""
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) < 2 or parts[0] != "jobs":
            return None, None, None
        return parts[1], JOBS.get(parts[1]), (parts[2] if len(parts) > 2 else "")

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path == "/health":
            agent = self.headers.get("User-Agent", "unknown client")
            if agent not in SEEN_CLIENTS:
                SEEN_CLIENTS.add(agent)
                print(f"Panel connected ({agent})", flush=True)
            try:
                ff = mosh.find_tool("ffmpeg")
                self._send(200, {"ok": True, "ffmpeg": ff, "version": VERSION})
            except SystemExit as e:
                self._send(200, {"ok": False, "error": str(e)})
            return
        if self.path == "/test-dir":  # used by the panel's browser preview mode
            return self._send(200, {"dir": str(Path(__file__).parent / "test-output")})
        if self.path == "/render-path":  # where Premiere should write the selection render
            RENDER_DIR.mkdir(parents=True, exist_ok=True)
            now = time.time()
            for old in RENDER_DIR.glob("*.mov"):     # renders are throwaway: keep a day
                try:
                    if now - old.stat().st_mtime > 24 * 3600:
                        old.unlink()
                except OSError:
                    pass
            name = f"render_{datetime.now():%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:4]}.mov"
            return self._send(200, {"path": str(RENDER_DIR / name)})
        if self.path == "/preset":    # export preset for rendering the selection in Premiere
            try:
                return self._send(200, {"path": str(make_preset())})
            except Exception as e:
                return self._send(500, {"error": str(e)})

        job_id, job, action = self._job_route()
        if not job:
            return self._send(404, {"error": "not found"})
        if action == "":
            with LOCK:
                return self._send(200, dict(job, log=list(job["log"])))
        if action == "preview.png":
            preview = (job.get("result") or {}).get("preview")
            if preview and Path(preview).exists():
                return self._send_file(preview, "image/png")
        if action == "thumb":  # /jobs/<id>/thumb/<name>.png  (keyframe picker)
            name = self.path.split("?")[0].rsplit("/", 1)[-1]
            thumb = PREVIEW_DIR / job_id / name
            if name.endswith(".png") and "/" not in name and "\\" not in name and thumb.exists():
                return self._send_file(thumb, "image/png")
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path in ("/mosh", "/scan"):
            try:
                length = int(self.headers.get("Content-Length", 0))
                req = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self._send(400, {"error": "bad json"})
            job_id = uuid.uuid4().hex[:8]
            CANCELS[job_id] = threading.Event()
            JOBS[job_id] = {"state": "running", "log": [], "result": None, "kind": self.path[1:],
                            "error": None, "started": time.time(), "finished": None}
            threading.Thread(target=run_job, args=(job_id, req), daemon=True).start()
            return self._send(200, {"job": job_id})

        job_id, job, action = self._job_route()
        if not job:
            return self._send(404, {"error": "not found"})
        if action == "cancel":
            CANCELS[job_id].set()
            return self._send(200, {"ok": True})
        if action == "reveal":
            out = (job.get("result") or {}).get("output")
            if out and Path(out).exists() and os.name == "nt":
                subprocess.Popen(["explorer", "/select,", str(Path(out))])
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "no output to show"})
        return self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # keep the console quiet except job logs
        pass


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR would let a second helper bind the same port; don't.
    allow_reuse_address = os.name != "nt"
    daemon_threads = True


def already_running():
    """True if a helper already answers on our port."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/health", timeout=1) as r:
            return json.loads(r.read()).get("ok") is not None
    except Exception:
        return False


def main():
    if already_running():
        print(f"A Datamosh helper is already running on port {PORT}; not starting another.")
        return
    try:
        server = Server((HOST, PORT), Handler)
    except OSError as e:
        print(f"Port {PORT} is busy ({e}); is another helper running?")
        return
    print(f"Datamosh helper v{VERSION} listening on http://{HOST}:{PORT}  (Ctrl+C to stop)")
    try:
        print(f"ffmpeg: {mosh.find_tool('ffmpeg')}")
    except SystemExit as e:
        print(f"WARNING: {e}")
    server.serve_forever()


if __name__ == "__main__":
    main()
