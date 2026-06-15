"""
frame_sender.py — Python pyvirtualcam helper

Reads raw BGR24 video frames from stdin (piped from FFmpeg)
and pushes them to the OBS Virtual Camera via pyvirtualcam.

Requirements:
    pip install pyvirtualcam

OBS Virtual Camera must be STARTED before running this script.
"""

import sys
import numpy as np
import pyvirtualcam
import queue
import threading
import time

# ─── TUNE: Must match Android encoder + FFmpeg scale settings ─────────────────
WIDTH  = 1280
HEIGHT = 720
FPS    = 30

# Parse command line arguments if provided (width height)
if len(sys.argv) >= 3:
    try:
        WIDTH  = int(sys.argv[1])
        HEIGHT = int(sys.argv[2])
    except ValueError:
        pass
# ─────────────────────────────────────────────────────────────────────────────

# Each raw BGR24 frame = WIDTH * HEIGHT * 3 bytes
FRAME_SIZE = WIDTH * HEIGHT * 3

vcam_queue = queue.Queue(maxsize=1)
running = True
py_cam = None

def vcam_sender_worker():
    global py_cam, running
    while running:
        try:
            # Block with timeout to check running flag periodically
            frame = vcam_queue.get(timeout=0.1)
        except queue.Empty:
            continue
        
        if py_cam and running:
            try:
                py_cam.send(frame)
            except Exception:
                pass

def main():
    global py_cam, running
    print(f"[PySender] Starting virtual camera {WIDTH}x{HEIGHT} @ {FPS}fps", flush=True)

    try:
        py_cam = pyvirtualcam.Camera(width=WIDTH, height=HEIGHT, fps=FPS, print_fps=False, backend='obs')
        print(f"[PySender] Virtual camera opened: {py_cam.device}", flush=True)
    except Exception as e:
        print(f"[PySender] Error opening camera: {e}", flush=True, file=sys.stderr)
        sys.exit(1)

    # Start non-blocking background sender thread
    sender_th = threading.Thread(target=vcam_sender_worker, name="WebVCamSenderThread", daemon=True)
    sender_th.start()

    stdin_buf = sys.stdin.buffer  # binary stdin

    try:
        while True:
            # Read exactly one frame's worth of bytes from FFmpeg stdout
            raw = b''
            while len(raw) < FRAME_SIZE:
                chunk = stdin_buf.read(FRAME_SIZE - len(raw))
                if not chunk:
                    # stdin closed — FFmpeg exited
                    print("[PySender] stdin closed, exiting.", flush=True)
                    running = False
                    return
                raw += chunk

            # Reshape bytes into a numpy array (H, W, 3) in BGR order
            frame_bgr = np.frombuffer(raw, dtype=np.uint8).reshape((HEIGHT, WIDTH, 3))

            # Convert BGR → RGB for pyvirtualcam
            frame_rgb = frame_bgr[:, :, ::-1].copy()

            # Push latest frame to non-blocking VCam queue (discards older frames to avoid latency)
            try:
                vcam_queue.put_nowait(frame_rgb)
            except queue.Full:
                try:
                    vcam_queue.get_nowait()
                except queue.Empty:
                    pass
                try:
                    vcam_queue.put_nowait(frame_rgb)
                except queue.Full:
                    pass

            # Print log every 30 frames
            if py_cam.frames_sent % 30 == 0:
                print(f"[PySender] Sent frame #{py_cam.frames_sent}", flush=True)

    except KeyboardInterrupt:
        print("[PySender] Interrupted.", flush=True)
    finally:
        running = False
        if py_cam:
            try:
                py_cam.close()
            except Exception:
                pass

if __name__ == '__main__':
    main()
