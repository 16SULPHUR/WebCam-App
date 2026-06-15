"""
web_server.py — HTTP server for the USB Webcam Bridge dashboard.

Built on Python's standard-library ThreadingHTTPServer.
Each request runs in its own thread (safe for long-lived SSE / video streams).

Routes:
  GET  /                    → index.html
  GET  /css/*, /js/*        → static files from public/
  GET  /api/config          → current config JSON
  POST /api/config          → update config + trigger pipeline restart
  POST /api/reconnect       → trigger manual pipeline restart
  POST /api/record/start    → begin H.264 → MP4 recording
  POST /api/record/stop     → end recording
  GET  /api/status          → one-shot status JSON
  GET  /logs                → Server-Sent Events stream (long-lived)
  GET  /video_feed          → MJPEG multipart stream (long-lived)
"""

import json
import mimetypes
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import urlparse

from .broadcaster import EventBroadcaster, SseClient, VideoClient
from .config import ConfigManager
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
    config:      ConfigManager      = None   # type: ignore[assignment]
    broadcaster: EventBroadcaster   = None   # type: ignore[assignment]
    _pipeline_ref = None                     # set by BridgeServer
    recorder:    RecordingManager   = None   # type: ignore[assignment]
    public_dir:  str                = ""

    # ── Logging ───────────────────────────────────────────────────────────────

    def log_message(self, fmt, *args):
        pass  # silence default HTTP access log

    # ── Routing ───────────────────────────────────────────────────────────────

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                self._serve_file("index.html")
            elif path.startswith("/css/") or path.startswith("/js/"):
                self._serve_file(path.lstrip("/"))
            elif path == "/api/config":
                self._json(self.config.to_dict())
            elif path == "/api/status":
                self._json({
                    **self.broadcaster.get_stats(),
                    "config": self.config.to_dict(),
                })
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
        try:
            if path == "/api/config":
                self._handle_config_update()
            elif path == "/api/reconnect":
                self._json({"success": True})
                threading.Thread(
                    target=self._pipeline_ref.restart,
                    args=("Manual reconnect requested",),
                    daemon=True,
                ).start()
            elif path == "/api/record/start":
                self._handle_record_start()
            elif path == "/api/record/stop":
                self._handle_record_stop()
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
            self.config.update(data)
            self._json({"success": True})
            self.broadcaster.broadcast_log(
                "system",
                f"Config saved — restarting pipeline…",
            )
            threading.Thread(
                target=self._pipeline_ref.restart,
                args=(f"Config updated",),
                daemon=True,
            ).start()
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
            path = self.recorder.start()
            self._json({"success": True, "file": path})
            self.broadcaster.broadcast_log("system", f"✓ Recording started → {path}")
        except Exception as exc:
            self._json({"error": str(exc)}, 500)

    def _handle_record_stop(self) -> None:
        if not self.recorder.is_recording:
            self._json({"error": "Not recording"}, 400)
            return
        try:
            path = self.recorder.stop()
            self._json({"success": True, "file": path})
            self.broadcaster.broadcast_log("system", f"✓ Recording stopped → {path}")
        except Exception as exc:
            self._json({"error": str(exc)}, 500)

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
        port:        int = 3000,
    ) -> None:
        self._port    = port
        self._server: Optional[ThreadingBridgeHTTPServer] = None

        # Inject shared state into the handler class
        BridgeHandler.config      = config
        BridgeHandler.broadcaster = broadcaster
        BridgeHandler.recorder    = recorder
        BridgeHandler.public_dir  = os.path.realpath(public_dir)

    def set_pipeline(self, pipeline) -> None:
        """Wire up the Pipeline reference (avoids circular imports)."""
        BridgeHandler._pipeline_ref = pipeline

    def start(self) -> None:
        """Start the HTTP server (blocking — call from a daemon thread)."""
        self._server = ThreadingBridgeHTTPServer(("0.0.0.0", self._port), BridgeHandler)
        self._server.daemon_threads = True
        print(f"[Web] Dashboard -> http://localhost:{self._port}")
        self._server.serve_forever()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
