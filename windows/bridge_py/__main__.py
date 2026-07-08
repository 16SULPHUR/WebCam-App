"""
__main__.py — Entry point for the USB Webcam Bridge Python stack.

Usage:
    python -m bridge_py

Starts:
  1. ConfigManager  — loads config.json
  2. EventBroadcaster  — SSE + video hub
  3. RecordingManager  — H.264 → MP4 recording
  4. BridgeServer  — HTTP dashboard on :3000
  5. Pipeline  — FFmpeg VCam + Web + Python frame_sender
  6. AndroidTcpClient  — connects to Android over ADB

Resolves FFmpeg and Python tool paths via PATH and known fallback locations.
"""

import os
import sys
import signal
import threading

# ── Path setup ────────────────────────────────────────────────────────────────
# When run as "python -m bridge_py" from the windows/ directory,
# __file__ is windows/bridge_py/__main__.py
BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DIR  = os.path.join(BASE_DIR, "public")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
SCRIPT_PATH = os.path.join(BASE_DIR, "frame_sender.py")


def resolve_tool(name: str, *fallbacks: str) -> str:
    """Return the first existing path, or just the name (let PATH resolve it)."""
    for p in fallbacks:
        if p and os.path.isfile(p):
            return p
    return name  # fallback: expect it in PATH


FFMPEG_PATH = resolve_tool(
    "ffmpeg",
    os.path.join(BASE_DIR, "ffmpeg.exe"),
    os.path.join(BASE_DIR, "bin", "ffmpeg.exe"),
    r"F:\tools\ffmpeg\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe",
)

PYTHON_PATH = resolve_tool(
    sys.executable,          # prefer current interpreter
    os.path.join(BASE_DIR, "python.exe"),
    r"F:\tools\python312\python.exe",
)
# ─────────────────────────────────────────────────────────────────────────────

from .config      import ConfigManager
from .broadcaster import EventBroadcaster
from .recorder    import RecordingManager
from .pipeline    import Pipeline
from .tcp_client  import AndroidTcpClient
from .web_server    import BridgeServer
from .phone_stats  import PhoneStatsCollector


def main() -> None:
    print("=" * 56)
    print("  USB Webcam Bridge - Python Stack")
    print("=" * 56)
    print(f"  Base:    {BASE_DIR}")
    print(f"  FFmpeg:  {FFMPEG_PATH}")
    print(f"  Python:  {PYTHON_PATH}")
    print(f"  Script:  {SCRIPT_PATH}")
    print(f"  Config:  {CONFIG_PATH}")
    print()

    # ── 1. Core services ──────────────────────────────────────────────────────
    config      = ConfigManager(CONFIG_PATH)
    broadcaster = EventBroadcaster()
    recorder    = RecordingManager(FFMPEG_PATH, BASE_DIR, broadcaster)

    # Initialize TUI
    from .tui import TuiManager, run_tui_loop
    use_tui = sys.stdout.isatty() and "--no-tui" not in sys.argv
    tui = TuiManager(broadcaster, config) if use_tui else None

    # ── 2. HTTP server ────────────────────────────────────────────────────────
    server = BridgeServer(config, broadcaster, recorder, PUBLIC_DIR, port=3000)

    # ── 3. Pipeline ───────────────────────────────────────────────────────────
    pipeline = Pipeline(
        config      = config,
        broadcaster = broadcaster,
        recorder    = recorder,
        ffmpeg_path = FFMPEG_PATH,
        python_path = PYTHON_PATH,
        script_path = SCRIPT_PATH,
        base_dir    = BASE_DIR,
    )
    server.set_pipeline(pipeline)

    # ── 3b. Phone stats collector (ADB-based) ────────────────────────────────
    phone_stats = PhoneStatsCollector(broadcaster)

    # ── 4. TCP client (connects to Android) ───────────────────────────────────
    def on_disconnect():
        broadcaster.update_stats(androidConnected=False)
        broadcaster.broadcast_status()
        recorder.clear_codec_config()
        pipeline.restart("Android disconnected - pipeline reset")

    tcp_client = AndroidTcpClient(
        broadcaster   = broadcaster,
        data_callback = pipeline.feed,
        on_connect    = None,
        on_disconnect = on_disconnect,
    )
    pipeline.set_on_stop(lambda: tcp_client.disconnect())
    server.set_tcp_client(tcp_client)

    # ── 5. Shutdown handler ───────────────────────────────────────────────────
    def shutdown(sig=None, frame=None):
        print("\n[Bridge] Shutting down...")
        phone_stats.stop()
        tcp_client.stop()
        pipeline.stop("Shutdown")
        recorder.kill()
        server.stop()
        if use_tui and tui:
            tui.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT,  shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # ── 6. Start everything ───────────────────────────────────────────────────
    if use_tui and tui:
        with tui:
            # Spawn TUI rendering update thread
            tui_thread = threading.Thread(target=run_tui_loop, args=(tui,), daemon=True, name="TuiLoop")
            tui_thread.start()

            # HTTP server in a daemon thread
            threading.Thread(target=server.start, daemon=True, name="WebServer").start()

            # Pipeline starts immediately (waits for Android data via feed())
            pipeline.start()

            # TCP client starts connecting in background
            tcp_client.start()

            # Phone stats collector starts polling via ADB
            phone_stats.start()

            # Block main thread
            try:
                threading.Event().wait()
            except KeyboardInterrupt:
                shutdown()
    else:
        # Fallback raw terminal layout
        threading.Thread(target=server.start, daemon=True, name="WebServer").start()
        pipeline.start()
        tcp_client.start()
        phone_stats.start()

        print(f"\nDashboard -> http://localhost:3000")
        print("Press Ctrl+C to stop.\n")

        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            shutdown()


if __name__ == "__main__":
    main()
