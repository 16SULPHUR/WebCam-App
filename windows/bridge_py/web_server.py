"""
web_server.py — HTTP server for the USB Webcam Bridge dashboard.

Built on Python's standard-library ThreadingHTTPServer.
Each request runs in its own thread (safe for long-lived SSE / video streams).

Routes:
  GET  /                       → index.html
  GET  /css|js|components|img  → static files from public/
  GET  /api/config          → current config JSON
  POST /api/config          → update config + trigger pipeline restart
  POST /api/reconnect       → trigger manual pipeline restart
  POST /api/record/start    → begin H.264 → MP4 recording
  POST /api/record/stop     → end recording
  GET  /api/status          → one-shot status JSON
  GET  /logs                → Server-Sent Events stream (long-lived)
  GET  /video_feed          → MJPEG multipart stream (long-lived)
  GET  /api/reactions/catalog  → triggers, animations, artwork, current config
  POST /api/reactions/upload   → store meme artwork
  POST /api/reactions/preview  → fire one overlay into the live frame
  GET  /reactions/assets/*     → reaction artwork files
"""

import json
import mimetypes
import os
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import unquote, urlparse

from .broadcaster import EventBroadcaster, SseClient, VideoClient
from .config import DASHBOARD_PORT, ConfigManager
from .recorder import RecordingManager


# ── Request handler ───────────────────────────────────────────────────────────

class BridgeHandler(BaseHTTPRequestHandler):
    """
    Class-level attributes injected by BridgeServer.init_handler():
      - config      : ConfigManager
      - broadcaster : EventBroadcaster
      - pipeline    : Pipeline (set via property to avoid circular import)
      - recorder    : RecordingManager
      - public_dir  : str — absolute path to the public/ folder
    """
    config:        ConfigManager      = None   # type: ignore[assignment]
    broadcaster:   EventBroadcaster   = None   # type: ignore[assignment]
    _pipeline_ref  = None                      # set by BridgeServer
    _tcp_client_ref = None                     # set by BridgeServer
    recorder:      RecordingManager   = None   # type: ignore[assignment]
    public_dir:    str                = ""
    backgrounds_dir: str              = ""     # absolute path to backgrounds/ folder
    reactions_dir: str                = ""     # absolute path to reactions/assets/ folder

    # ── Logging ───────────────────────────────────────────────────────────────

    def log_message(self, fmt, *args):
        pass  # silence default HTTP access log

    # ── Routing ───────────────────────────────────────────────────────────────

    def do_GET(self):
        path = urlparse(self.path).path
        print(f"[Web] GET {path}", flush=True)
        try:
            if path in ("/", "/index.html"):
                self._serve_file("index.html")
            elif path.startswith("/css/") or path.startswith("/js/") or path.startswith("/components/") or path.startswith("/img/"):
                self._serve_file(path.lstrip("/"))
            elif path == "/api/config":
                self._json(self.config.to_dict())
            elif path == "/api/status":
                self._json({
                    **self.broadcaster.get_stats(),
                    "config": self.config.to_dict(),
                })
            elif path == "/api/backgrounds":
                self._handle_list_backgrounds()
            elif path == "/api/skins":
                self._handle_list_skins()
            elif path.startswith("/backgrounds/"):
                self._handle_serve_background(path)
            elif path.startswith("/skins/"):
                self._handle_serve_skin(path)
            elif path == "/api/reactions/catalog":
                self._handle_reactions_catalog()
            elif path.startswith("/reactions/assets/"):
                self._handle_serve_reaction_asset(path)
            elif path.startswith("/video_feed"):
                self._handle_video()
            elif path == "/logs":
                self._handle_sse()
            else:
                self.send_error(404)
        except Exception as exc:
            self.broadcaster.broadcast_log("node", f"[Web] Handler error: {exc}")

    def do_POST(self):
        path = urlparse(self.path).path
        print(f"[Web] POST {path}", flush=True)
        try:
            if path == "/api/config":
                self._handle_config_update()
            elif path == "/api/reconnect":
                self._json({
                    "success": True,
                    **self.broadcaster.get_stats(),
                    "config": self.config.to_dict(),
                })
                threading.Thread(
                    target=self._pipeline_ref.restart,
                    args=("Manual reconnect requested",),
                    daemon=True,
                ).start()
            elif path == "/api/record/start":
                self._handle_record_start()
            elif path == "/api/record/stop":
                self._handle_record_stop()
            elif path == "/api/record/toggle":
                self._handle_record_toggle()
            elif path == "/api/record/snapshot":
                self._handle_record_snapshot()

            elif path == "/api/upload_background":
                self._handle_upload_background()
            elif path == "/api/reactions/upload":
                self._handle_upload_reaction_asset()
            elif path == "/api/reactions/preview":
                self._handle_reaction_preview()
            else:
                self.send_error(404)
        except Exception as exc:
            self.broadcaster.broadcast_log("node", f"[Web] POST error: {exc}")

    def do_OPTIONS(self):
        """CORS preflight support."""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ── Static file serving ───────────────────────────────────────────────────

    def _serve_file(self, rel_path: str) -> None:
        abs_path = os.path.normpath(os.path.join(self.public_dir, rel_path))
        # Prevent directory traversal
        if not abs_path.startswith(os.path.realpath(self.public_dir)):
            self.send_error(403)
            return
        if not os.path.isfile(abs_path):
            self.send_error(404)
            return
        mime, _ = mimetypes.guess_type(abs_path)
        with open(abs_path, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ── SSE — long-lived event stream ─────────────────────────────────────────

    def _handle_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        # Send initial status so dashboard doesn't wait for next broadcast
        stats = self.broadcaster.get_stats()
        init  = json.dumps({"type": "status", **stats})
        try:
            self.wfile.write(f"data: {init}\n\n".encode("utf-8"))
            self.wfile.flush()
        except Exception:
            return

        client: SseClient = self.broadcaster.add_sse_client()
        try:
            while client.alive:
                try:
                    payload = client.q.get(timeout=15.0)
                    self.wfile.write(payload)
                    self.wfile.flush()
                except queue.Empty:
                    # Heartbeat comment to keep connection alive
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
        except Exception:
            pass
        finally:
            self.broadcaster.remove_sse_client(client)

    # ── MJPEG video feed — long-lived ─────────────────────────────────────────

    def _handle_video(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=ffmpeg")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Pragma", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        client: VideoClient = self.broadcaster.add_video_client()
        try:
            while client.alive:
                try:
                    chunk = client.q.get(timeout=5.0)
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except queue.Empty:
                    pass  # no frame yet — keep waiting
        except Exception:
            pass
        finally:
            self.broadcaster.remove_video_client(client)

    # ── API handlers ──────────────────────────────────────────────────────────

    def _handle_config_update(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length)
        try:
            data = json.loads(body)
            
            # Handle relative deltas if present
            if "zoom_delta" in data:
                current_zoom = self.config.get("zoom", 1.0)
                data["zoom"] = max(1.0, min(3.0, current_zoom + data["zoom_delta"]))
                del data["zoom_delta"]
                
            if "brightness_delta" in data:
                current_brightness = self.config.get("brightness", 0.0)
                data["brightness"] = max(-1.0, min(1.0, current_brightness + data["brightness_delta"]))
                del data["brightness_delta"]

            old_res = self.config.get("resolution")
            old_fps = self.config.get("targetFps")
            
            new_res = data.get("resolution", old_res)
            new_fps = data.get("targetFps", old_fps)
            
            needs_restart = (old_res != new_res) or (old_fps != new_fps)
            
            self.config.update(data)
            
            # Forward camera switch commands to the streamer device via TCP command channel
            camera_facing = data.get("cameraFacing")
            if camera_facing and self._tcp_client_ref:
                self._tcp_client_ref.send_command(json.dumps({
                    "action": "switch_camera",
                    "cameraFacing": camera_facing
                }))

            self._json({
                "success": True,
                "restarted": needs_restart,
                **self.broadcaster.get_stats(),
                "config": self.config.to_dict(),
            })
            
            if needs_restart:
                self.broadcaster.broadcast_log(
                    "system",
                    f"Config saved — restarting pipeline (resolution/FPS change)...",
                )
                threading.Thread(
                    target=self._pipeline_ref.restart,
                    args=(f"Config updated (resolution/FPS change)",),
                    daemon=True,
                ).start()
            else:
                self.broadcaster.broadcast_log(
                    "system",
                    f"Config saved — settings applied dynamically.",
                )
        except Exception as exc:
            self._json({"error": str(exc)}, 400)

    def _handle_record_start(self) -> None:
        if self.recorder.is_recording:
            self._json({"error": "Already recording", "file": self.recorder.filepath}, 409)
            return
        if not self.broadcaster.get_stats().get("androidConnected"):
            self._json({"error": "No active stream to record"}, 400)
            return
        try:
            fps = self.config.get("targetFps", 30)
            path = self.recorder.start(fps=fps)
            self._json({
                "success": True,
                "file": path,
                **self.broadcaster.get_stats(),
                "config": self.config.to_dict(),
            })
            self.broadcaster.broadcast_log("system", f"Recording started -> {path}")
        except Exception as exc:
            self._json({"error": str(exc)}, 500)

    def _handle_record_stop(self) -> None:
        if not self.recorder.is_recording:
            self._json({"error": "Not recording"}, 400)
            return
        try:
            path = self.recorder.stop()
            self._json({
                "success": True,
                "file": path,
                **self.broadcaster.get_stats(),
                "config": self.config.to_dict(),
            })
            self.broadcaster.broadcast_log("system", f"Recording stopped -> {path}")
        except Exception as exc:
            self._json({"error": str(exc)}, 500)

    def _handle_record_toggle(self) -> None:
        if self.recorder.is_recording:
            self._handle_record_stop()
        else:
            self._handle_record_start()

    def _handle_record_snapshot(self) -> None:
        jpeg_data = self._pipeline_ref.latest_jpeg if self._pipeline_ref else None
        if not jpeg_data:
            self._json({"error": "No active stream to capture"}, 400)
            return
        try:
            ts = time.strftime("%Y-%m-%dT%H-%M-%S")
            filename = f"snapshot-{ts}.jpg"
            path = os.path.join(self.recorder._out_dir, filename)
            with open(path, "wb") as fh:
                fh.write(jpeg_data)
            self._json({
                "success": True,
                "file": path,
                **self.broadcaster.get_stats(),
                "config": self.config.to_dict(),
            })
            self.broadcaster.broadcast_log("system", f"Snapshot saved -> {path}")
        except Exception as exc:
            self._json({"error": str(exc)}, 500)


    def _handle_upload_background(self) -> None:
        """Accept raw file upload and save it as a background image."""
        from urllib.parse import parse_qs
        query = urlparse(self.path).query
        params = parse_qs(query)
        filename = params.get("filename", [""])[0]
        if not filename:
            self._json({"success": False, "error": "Missing filename parameter"}, 400)
            return
        filename = os.path.basename(filename)
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)
        
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        bg_path = os.path.join(base_dir, "windows", "backgrounds", filename)
        try:
            with open(bg_path, "wb") as f:
                f.write(data)
            self._json({"success": True, "filename": filename})
            self.broadcaster.broadcast_log("system", f"Uploaded custom background: {filename}")
        except Exception as e:
            self._json({"success": False, "error": str(e)}, 500)

    # ── Reaction overlays ─────────────────────────────────────────────────────

    def _handle_reactions_catalog(self) -> None:
        """Triggers, animations, placements, artwork — everything the dialog needs."""
        from .reactions import catalog_payload
        payload = catalog_payload(self.reactions_dir)
        payload["config"] = self.config.get("reactions", {})
        self._json(payload)

    def _handle_serve_reaction_asset(self, path: str) -> None:
        rel = unquote(path[len("/reactions/assets/"):])
        abs_path = os.path.realpath(os.path.join(self.reactions_dir, rel))
        if not abs_path.startswith(os.path.realpath(self.reactions_dir)) or not os.path.isfile(abs_path):
            self.send_error(404)
            return
        mime, _ = mimetypes.guess_type(abs_path)
        with open(abs_path, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _handle_upload_reaction_asset(self) -> None:
        """Accept a raw image upload and store it as reaction artwork."""
        from urllib.parse import parse_qs
        params = parse_qs(urlparse(self.path).query)
        filename = os.path.basename(params.get("filename", [""])[0])
        ext = os.path.splitext(filename)[1].lower()
        if not filename or ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
            self._json({"success": False, "error": "Unsupported or missing filename"}, 400)
            return
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)
        try:
            os.makedirs(self.reactions_dir, exist_ok=True)
            with open(os.path.join(self.reactions_dir, filename), "wb") as fh:
                fh.write(data)
            self._json({"success": True, "filename": filename})
            self.broadcaster.broadcast_log("system", f"Uploaded reaction artwork: {filename}")
        except Exception as exc:
            self._json({"success": False, "error": str(exc)}, 500)

    def _handle_reaction_preview(self) -> None:
        """Fire one overlay into the live frame without performing the gesture."""
        length = int(self.headers.get("Content-Length", 0))
        try:
            mapping = json.loads(self.rfile.read(length)) if length else {}
        except Exception as exc:
            self._json({"success": False, "error": str(exc)}, 400)
            return
        reactions = dict(self.config.get("reactions", {}) or {})
        reactions["testFire"] = {"ts": time.time(), "mapping": mapping}
        self.config.update({"reactions": reactions})
        self._json({"success": True})

    # ── Backgrounds ───────────────────────────────────────────────────────────

    def _handle_list_backgrounds(self) -> None:
        """Return JSON list of background images available in the backgrounds/ folder."""
        bg_dir = self.backgrounds_dir
        images = []
        if os.path.isdir(bg_dir):
            for fname in sorted(os.listdir(bg_dir)):
                ext = os.path.splitext(fname)[1].lower()
                if ext in (".jpg", ".jpeg", ".png", ".webp"):
                    images.append({"filename": fname, "url": f"/backgrounds/{fname}"})
        self._json({"backgrounds": images})

    def _handle_serve_background(self, path: str) -> None:
        """Serve a background image file from the backgrounds/ directory."""
        filename = os.path.basename(unquote(path))  # sanitise — no path traversal
        abs_path = os.path.join(self.backgrounds_dir, filename)
        if not os.path.isfile(abs_path):
            self.send_error(404)
            return
        mime, _ = mimetypes.guess_type(abs_path)
        mime = mime or "application/octet-stream"
        with open(abs_path, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _handle_serve_skin(self, path: str) -> None:
        """Serve a skin PNG frame file from neko/2023-icon-library/."""
        parts = [p for p in unquote(path).split("/") if p]
        if len(parts) < 3:
            self.send_error(404)
            return
        skin_name = parts[1]
        filename = parts[2]
        # Sanitise
        if ".." in skin_name or ".." in filename:
            self.send_error(400)
            return
            
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        abs_path = os.path.join(base_dir, "neko", "2023-icon-library", skin_name, filename)
        
        if not os.path.isfile(abs_path):
            self.send_error(404)
            return
            
        with open(abs_path, "rb") as fh:
            data = fh.read()
            
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _handle_list_skins(self) -> None:
        """Return JSON list of skin names in the neko/2023-icon-library directory."""
        # Since web_server.py is in WebCam App/windows/bridge_py/, its grand-parent is WebCam App/
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        skins_dir = os.path.join(base_dir, "neko", "2023-icon-library")
        skins = []
        if os.path.isdir(skins_dir):
            for name in sorted(os.listdir(skins_dir)):
                if os.path.isdir(os.path.join(skins_dir, name)) and not name.startswith("."):
                    skins.append(name)
        self._json({"skins": skins})

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _json(self, data: dict, status: int = 200) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


# ── Server ────────────────────────────────────────────────────────────────────

class ThreadingBridgeHTTPServer(ThreadingHTTPServer):
    """
    Subclass to suppress traceback prints for common client connection drops
    (e.g., ConnectionAbortedError / ConnectionResetError on browser page reload).
    """
    def handle_error(self, request, client_address):
        import sys
        exc_type, _, _ = sys.exc_info()
        if exc_type in (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            return
        super().handle_error(request, client_address)


class BridgeServer:
    """
    Wraps ThreadingBridgeHTTPServer and injects shared services into BridgeHandler.
    """

    def __init__(
        self,
        config:      ConfigManager,
        broadcaster: EventBroadcaster,
        recorder:    RecordingManager,
        public_dir:  str,
        port:        int = DASHBOARD_PORT,
    ) -> None:
        self._port    = port
        self._server: Optional[ThreadingBridgeHTTPServer] = None

        # Inject shared state into the handler class
        BridgeHandler.config          = config
        BridgeHandler.broadcaster     = broadcaster
        BridgeHandler.recorder        = recorder
        BridgeHandler.public_dir      = os.path.realpath(public_dir)
        # Backgrounds folder sits next to public_dir (i.e. windows/backgrounds/)
        BridgeHandler.backgrounds_dir = os.path.realpath(
            os.path.join(os.path.dirname(public_dir), "backgrounds")
        )
        BridgeHandler.reactions_dir = os.path.realpath(
            os.path.join(os.path.dirname(public_dir), "reactions", "assets")
        )

    def set_pipeline(self, pipeline) -> None:
        """Wire up the Pipeline reference (avoids circular imports)."""
        BridgeHandler._pipeline_ref = pipeline

    def set_tcp_client(self, tcp_client) -> None:
        """Wire up the TCP client reference."""
        BridgeHandler._tcp_client_ref = tcp_client

    def start(self) -> None:
        """Start the HTTP server (blocking — call from a daemon thread)."""
        self._server = ThreadingBridgeHTTPServer(("0.0.0.0", self._port), BridgeHandler)
        self._server.daemon_threads = True
        print(f"[Web] Dashboard -> http://localhost:{self._port}")
        self._server.serve_forever()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
