"""
frame_sender.py — Python pyvirtualcam helper with background blur.

Reads raw BGR24 video frames from stdin (piped from FFmpeg)
and pushes them to the OBS Virtual Camera via pyvirtualcam.
Additionally processes background blur and outputs preview frames via stdout.
"""

import os
import sys

# ─── CRITICAL: Redirect standard output at the OS level to stderr ──────────────
# This prevents C++ libraries (MediaPipe, TensorFlow Lite, OpenCV) from writing
# info/warning logs to file descriptor 1 (stdout), which would corrupt the
# binary framing protocol and cause pipeline deadlocks.
try:
    stdout_fd = os.dup(1)
    binary_stdout = os.fdopen(stdout_fd, 'wb')
    os.dup2(2, 1)
except Exception as e:
    # Fallback to standard stdout buffer if redirect fails
    sys.stderr.write(f"[PySender] WARNING: Failed stdout OS redirect: {e}\n")
    binary_stdout = sys.stdout.buffer
# ─────────────────────────────────────────────────────────────────────────────

import numpy as np
import queue
import threading
import time
import cv2

try:
    import pyvirtualcam
except ImportError:
    pyvirtualcam = None

# ─── TUNE: Must match Android encoder + FFmpeg scale settings ─────────────────
WIDTH  = 1280
HEIGHT = 720
FPS    = 30
BLUR   = 0
VCAM_ENABLED = True

# Parse command line arguments if provided
if len(sys.argv) >= 3:
    try:
        WIDTH  = int(sys.argv[1])
        HEIGHT = int(sys.argv[2])
    except ValueError:
        pass

if len(sys.argv) >= 4:
    try:
        BLUR = int(sys.argv[3])
    except ValueError:
        pass

if len(sys.argv) >= 5:
    VCAM_ENABLED = sys.argv[4] == "1"
# ─────────────────────────────────────────────────────────────────────────────

# Each raw BGR24 frame = WIDTH * HEIGHT * 3 bytes
FRAME_SIZE = WIDTH * HEIGHT * 3

vcam_queue = queue.Queue(maxsize=1)
running = True
py_cam = None

segmenter = None
segmenter_loading = False

def log(msg):
    print(msg, file=sys.stderr, flush=True)

def load_mediapipe_worker():
    global segmenter, segmenter_loading
    log("[PySender] Loading MediaPipe Selfie Segmentation in background...")
    try:
        import mediapipe as mp
        mp_selfie = mp.solutions.selfie_segmentation
        # model_selection=0 is general/slower, model_selection=1 is landscape/faster
        segmenter = mp_selfie.SelfieSegmentation(model_selection=0)
        log("[PySender] MediaPipe Selfie Segmentation loaded successfully in background thread.")
    except Exception as exc:
        log(f"[PySender] ERROR loading MediaPipe in background: {exc}")
    finally:
        segmenter_loading = False

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
    global py_cam, running, BLUR, VCAM_ENABLED, segmenter_loading
    log(f"[PySender] Starting Python frame_sender: {WIDTH}x{HEIGHT} @ {FPS}fps, Blur={BLUR}, VCamEnabled={VCAM_ENABLED}")

    if VCAM_ENABLED:
        if pyvirtualcam is None:
            log("[PySender] ERROR: pyvirtualcam module not found.")
            sys.exit(1)
        try:
            py_cam = pyvirtualcam.Camera(width=WIDTH, height=HEIGHT, fps=FPS, print_fps=False, backend='obs')
            log(f"[PySender] Virtual camera opened: {py_cam.device}")
        except Exception as e:
            log(f"[PySender] Error opening camera: {e}")
            sys.exit(1)

    # Initialize Selfie Segmentation resolution and background loader
    preview_w, preview_h = 0, 0
    seg_w, seg_h = 0, 0
    if BLUR > 0:
        segmenter_loading = True
        threading.Thread(target=load_mediapipe_worker, name="MpLoader", daemon=True).start()

        # Calculate target preview dimensions keeping aspect ratio (max dimension 640)
        if WIDTH >= HEIGHT:
            preview_w = 640
            preview_h = int(640 * HEIGHT / WIDTH)
        else:
            preview_h = 640
            preview_w = int(640 * WIDTH / HEIGHT)
        preview_w = (preview_w // 2) * 2
        preview_h = (preview_h // 2) * 2

        # Calculate segmentation resolution (max dimension 640 for high performance)
        if WIDTH >= HEIGHT:
            seg_w = 640
            seg_h = int(640 * HEIGHT / WIDTH)
        else:
            seg_h = 640
            seg_w = int(640 * WIDTH / HEIGHT)
        seg_w = (seg_w // 2) * 2
        seg_h = (seg_h // 2) * 2

    if VCAM_ENABLED:
        # Start non-blocking background sender thread
        sender_th = threading.Thread(target=vcam_sender_worker, name="WebVCamSenderThread", daemon=True)
        sender_th.start()

    stdin_buf = sys.stdin.buffer  # binary stdin
    frames_processed = 0

    try:
        while True:
            # Read exactly one frame's worth of bytes from FFmpeg stdout
            raw = b''
            while len(raw) < FRAME_SIZE:
                chunk = stdin_buf.read(FRAME_SIZE - len(raw))
                if not chunk:
                    # stdin closed — FFmpeg exited
                    log("[PySender] stdin closed, exiting.")
                    running = False
                    return
                raw += chunk

            # Reshape bytes into a numpy array (H, W, 3) in BGR order
            frame_bgr = np.frombuffer(raw, dtype=np.uint8).reshape((HEIGHT, WIDTH, 3))

            # Convert BGR → RGB for pyvirtualcam and MediaPipe
            frame_rgb = frame_bgr[:, :, ::-1].copy()

            # Apply Background Blur if enabled and segmenter is loaded
            if BLUR > 0 and segmenter is not None:
                try:
                    # Downscale for segmentation to run extremely fast on CPU
                    frame_seg_in = cv2.resize(frame_rgb, (seg_w, seg_h), interpolation=cv2.INTER_LINEAR)
                    
                    # Process the downscaled frame
                    results = segmenter.process(frame_seg_in)
                    if results.segmentation_mask is not None:
                        mask_small = results.segmentation_mask
                        
                        # Upscale mask back to original resolution
                        mask = cv2.resize(mask_small, (WIDTH, HEIGHT), interpolation=cv2.INTER_LINEAR)
                        mask_3d = np.stack((mask,) * 3, axis=-1)
                        
                        # Apply Gaussian blur
                        ksize = BLUR * 2 + 1
                        if ksize % 2 == 0:
                            ksize += 1
                        blurred_rgb = cv2.GaussianBlur(frame_rgb, (ksize, ksize), 0)
                        
                        # Blend foreground and background
                        frame_rgb = (frame_rgb * mask_3d + blurred_rgb * (1.0 - mask_3d)).astype(np.uint8)
                except Exception as e:
                    if frames_processed % 30 == 0:
                        log(f"[PySender] Segmentation error: {e}")

            # Send to Virtual Camera
            if VCAM_ENABLED:
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

            # Send to Web Preview via stdout (if blur is enabled)
            if BLUR > 0:
                try:
                    # Resize to preview dimension
                    preview_frame = cv2.resize(frame_rgb, (preview_w, preview_h), interpolation=cv2.INTER_LINEAR)
                    # Convert RGB back to BGR for encoding
                    preview_frame_bgr = preview_frame[:, :, ::-1]
                    # Encode to JPEG
                    _, jpeg_bytes_arr = cv2.imencode('.jpg', preview_frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    jpeg_bytes = jpeg_bytes_arr.tobytes()
                    
                    # Write length header (4 bytes, big-endian) + payload
                    binary_stdout.write(len(jpeg_bytes).to_bytes(4, byteorder='big'))
                    binary_stdout.write(jpeg_bytes)
                    binary_stdout.flush()
                except Exception as e:
                    if frames_processed % 30 == 0:
                        log(f"[PySender] Preview encoding error: {e}")

            frames_processed += 1
            if frames_processed % 30 == 0:
                log(f"[PySender] Processed frame #{frames_processed}")

    except KeyboardInterrupt:
        log("[PySender] Interrupted.")
    finally:
        running = False
        if py_cam:
            try:
                py_cam.close()
            except Exception:
                pass

if __name__ == '__main__':
    main()
