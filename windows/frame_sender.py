"""
frame_sender.py — Python stream processor.

Reads raw BGR24 video frames from stdin (piped from FFmpeg),
applies dynamic adjustments (zoom, mirror, orientation, color, unsharp, and background blur)
in real-time, and outputs them to the OBS Virtual Camera and web preview stdout.
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
import json

try:
    import pyvirtualcam
except ImportError:
    pyvirtualcam = None

# We read config path from argument
if len(sys.argv) < 2:
    sys.stderr.write("[PySender] ERROR: config.json path must be passed as the first argument.\n")
    sys.exit(1)

config_path = sys.argv[1]

# Dynamic settings (default values)
WIDTH = 1280
HEIGHT = 720
FPS = 30
mirror = False
orientation = 0
zoom = 1.0
brightness = 0.0
contrast = 1.0
saturation = 1.0
sharpness = 0.0
blur = 0
vcam_enabled = True

_prev_settings = {}

def log(msg):
    print(msg, file=sys.stderr, flush=True)

def load_config(initial=False):
    global WIDTH, HEIGHT, mirror, orientation, zoom, brightness, contrast, saturation, sharpness, blur, vcam_enabled, _prev_settings
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        
        # Resolution is parsed only once at startup or pipeline restarts
        if initial:
            res_str = cfg.get("resolution", "640x360")
            if not res_str or res_str == "auto":
                res_str = "1280x720"
            w, h = res_str.split("x")
            WIDTH = int(w)
            HEIGHT = int(h)
        
        mirror = cfg.get("mirror", False)
        orientation = int(cfg.get("orientation", 0))
        zoom = float(cfg.get("zoom", 1.0))
        brightness = float(cfg.get("brightness", 0.0))
        contrast = float(cfg.get("contrast", 1.0))
        saturation = float(cfg.get("saturation", 1.0))
        sharpness = float(cfg.get("sharpness", 0.0))
        blur = int(cfg.get("blur", 0))
        vcam_enabled = cfg.get("vcamEnabled", True)
        
        current_state = {
            "mirror": mirror, "orientation": orientation, "zoom": zoom,
            "brightness": brightness, "contrast": contrast, "saturation": saturation,
            "sharpness": sharpness, "blur": blur, "vcam_enabled": vcam_enabled
        }
        
        if not initial and current_state != _prev_settings:
            _prev_settings = current_state
            log(f"[PySender] Config updated dynamically: Zoom={zoom}x, Mirror={mirror}, "
                f"Ori={orientation}°, Brightness={brightness}, Contrast={contrast}, "
                f"Saturation={saturation}, Sharpness={sharpness}, Blur={blur}, VCamEnabled={vcam_enabled}")
        elif initial:
            _prev_settings = current_state
    except Exception as e:
        log(f"[PySender] Error loading config: {e}")

# Initial load of configuration
load_config(initial=True)

FRAME_SIZE = WIDTH * HEIGHT * 3

vcam_lock = threading.Lock()
py_cam = None
running = True

segmenter = None
segmenter_loading = False

def load_mediapipe_worker():
    global segmenter, segmenter_loading
    log("[PySender] Loading MediaPipe Selfie Segmentation in background...")
    try:
        import mediapipe as mp
        mp_selfie = mp.solutions.selfie_segmentation
        segmenter = mp_selfie.SelfieSegmentation(model_selection=0)
        log("[PySender] MediaPipe Selfie Segmentation loaded successfully.")
    except Exception as exc:
        log(f"[PySender] ERROR loading MediaPipe: {exc}")
    finally:
        segmenter_loading = False

# Color EQ precomputation table
last_applied_brightness = None
last_applied_contrast = None
lut = None

def apply_color_eq(frame_bgr, brightness, contrast):
    global last_applied_brightness, last_applied_contrast, lut
    if last_applied_brightness != brightness or last_applied_contrast != contrast:
        last_applied_brightness = brightness
        last_applied_contrast = contrast
        x = np.arange(256, dtype=np.float32)
        lut_data = (x - 128.0) * contrast + 128.0 + brightness * 255.0
        lut = np.clip(lut_data, 0, 255).astype(np.uint8)
    
    return cv2.LUT(frame_bgr, lut)

def main():
    global py_cam, running, segmenter_loading
    log(f"[PySender] Starting Python frame_sender: {WIDTH}x{HEIGHT} @ {FPS}fps")

    stdin_buf = sys.stdin.buffer
    frames_processed = 0

    try:
        while True:
            # Poll configuration changes every 10 frames (~300ms)
            if frames_processed % 10 == 0:
                load_config(initial=False)

            # Read raw BGR24 frame from stdin
            raw = b''
            while len(raw) < FRAME_SIZE:
                chunk = stdin_buf.read(FRAME_SIZE - len(raw))
                if not chunk:
                    log("[PySender] stdin closed, exiting.")
                    running = False
                    return
                raw += chunk

            # Convert bytes to BGR numpy array
            # Convert bytes to BGR numpy array and process
            try:
                frame_bgr = np.frombuffer(raw, dtype=np.uint8).reshape((HEIGHT, WIDTH, 3))

                # ─── 1. Crop-zoom ────────────────────────────────────────────────
                if zoom > 1.0:
                    cx, cy = WIDTH // 2, HEIGHT // 2
                    cw, ch = int(WIDTH / zoom), int(HEIGHT / zoom)
                    x1 = max(0, cx - cw // 2)
                    y1 = max(0, cy - ch // 2)
                    x2 = min(WIDTH, x1 + cw)
                    y2 = min(HEIGHT, y1 + ch)
                    cropped = frame_bgr[y1:y2, x1:x2]
                    frame_bgr = cv2.resize(cropped, (WIDTH, HEIGHT), interpolation=cv2.INTER_LINEAR)

                # ─── 2. Mirror ───────────────────────────────────────────────────
                if mirror:
                    frame_bgr = cv2.flip(frame_bgr, 1)

                # ─── 3. Rotation ─────────────────────────────────────────────────
                if orientation == 90:
                    frame_bgr = cv2.rotate(frame_bgr, cv2.ROTATE_90_CLOCKWISE)
                elif orientation == 180:
                    frame_bgr = cv2.rotate(frame_bgr, cv2.ROTATE_180)
                elif orientation == 270:
                    frame_bgr = cv2.rotate(frame_bgr, cv2.ROTATE_90_COUNTERCLOCKWISE)

                h_rot, w_rot = frame_bgr.shape[:2]

                # ─── 4. Brightness / Contrast ─────────────────────────────────────
                if abs(brightness) > 0.01 or abs(contrast - 1.0) > 0.01:
                    frame_bgr = apply_color_eq(frame_bgr, brightness, contrast)

                # ─── 5. Saturation ───────────────────────────────────────────────
                if abs(saturation - 1.0) > 0.01:
                    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
                    hsv[:, :, 1] = np.clip(hsv[:, :, 1].astype(np.float32) * saturation, 0, 255).astype(np.uint8)
                    frame_bgr = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)

                # ─── 6. Sharpness (Unsharp) ──────────────────────────────────────
                if sharpness > 0.05:
                    blurred = cv2.GaussianBlur(frame_bgr, (5, 5), 0)
                    frame_bgr = cv2.addWeighted(frame_bgr, 1.0 + sharpness, blurred, -sharpness, 0)

                # Convert BGR to RGB
                frame_rgb = frame_bgr[:, :, ::-1].copy()

                # ─── 7. Background Blur (MediaPipe) ──────────────────────────────
                if blur > 0:
                    if segmenter is None:
                        if not segmenter_loading:
                            segmenter_loading = True
                            threading.Thread(target=load_mediapipe_worker, name="MpLoader", daemon=True).start()
                    else:
                        try:
                            # Rescale target for MediaPipe segmentation
                            if w_rot >= h_rot:
                                seg_w = 640
                                seg_h = int(640 * h_rot / w_rot)
                            else:
                                seg_h = 640
                                seg_w = int(640 * w_rot / h_rot)
                            seg_w = (seg_w // 2) * 2
                            seg_h = (seg_h // 2) * 2

                            frame_seg_in = cv2.resize(frame_rgb, (seg_w, seg_h), interpolation=cv2.INTER_LINEAR)
                            results = segmenter.process(frame_seg_in)
                            if results.segmentation_mask is not None:
                                mask_small = results.segmentation_mask
                                mask = cv2.resize(mask_small, (w_rot, h_rot), interpolation=cv2.INTER_LINEAR)
                                mask_3d = np.stack((mask,) * 3, axis=-1)

                                ksize = blur * 2 + 1
                                if ksize % 2 == 0:
                                    ksize += 1
                                blurred_rgb = cv2.GaussianBlur(frame_rgb, (ksize, ksize), 0)
                                frame_rgb = (frame_rgb * mask_3d + blurred_rgb * (1.0 - mask_3d)).astype(np.uint8)
                        except Exception as e:
                            if frames_processed % 90 == 0:
                                log(f"[PySender] Segmentation error: {e}")

                # ─── 8. Send to Virtual Camera ───────────────────────────────────
                if vcam_enabled:
                    with vcam_lock:
                        if py_cam is None or py_cam.width != w_rot or py_cam.height != h_rot:
                            if py_cam:
                                try:
                                    py_cam.close()
                                except Exception:
                                    pass
                                py_cam = None
                            try:
                                if pyvirtualcam is not None:
                                    py_cam = pyvirtualcam.Camera(width=w_rot, height=h_rot, fps=FPS, print_fps=False, backend='obs')
                                    log(f"[PySender] Virtual camera opened: {py_cam.device} ({w_rot}x{h_rot})")
                                else:
                                    if frames_processed % 90 == 0:
                                        log("[PySender] pyvirtualcam module not found.")
                            except Exception as e:
                                if frames_processed % 90 == 0:
                                    log(f"[PySender] Error opening camera: {e}. Make sure OBS -> Virtual Camera is started.")
                                py_cam = None

                        if py_cam:
                            try:
                                py_cam.send(frame_rgb)
                            except Exception as e:
                                if frames_processed % 90 == 0:
                                    log(f"[PySender] Error writing to virtual camera: {e}")
                else:
                    with vcam_lock:
                        if py_cam is not None:
                            try:
                                py_cam.close()
                            except Exception:
                                pass
                            py_cam = None
                            log("[PySender] Virtual camera closed (disabled in config).")

                # ─── 9. Send to Web Preview (always active) ─────────────────────
                if w_rot >= h_rot:
                    preview_w = 640
                    preview_h = int(640 * h_rot / w_rot)
                else:
                    preview_h = 640
                    preview_w = int(640 * w_rot / h_rot)
                preview_w = (preview_w // 2) * 2
                preview_h = (preview_h // 2) * 2

                preview_frame = cv2.resize(frame_rgb, (preview_w, preview_h), interpolation=cv2.INTER_LINEAR)
                preview_frame_bgr = preview_frame[:, :, ::-1]
                _, jpeg_bytes_arr = cv2.imencode('.jpg', preview_frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
                jpeg_bytes = jpeg_bytes_arr.tobytes()
                
                binary_stdout.write(len(jpeg_bytes).to_bytes(4, byteorder='big'))
                binary_stdout.write(jpeg_bytes)
                binary_stdout.flush()
            except Exception as e:
                if frames_processed % 90 == 0:
                    log(f"[PySender] Frame processing loop exception: {e}")

            frames_processed += 1
            if frames_processed % 90 == 0:
                log(f"[PySender] Processed frame #{frames_processed}")

    except KeyboardInterrupt:
        log("[PySender] Interrupted.")
    finally:
        running = False
        with vcam_lock:
            if py_cam:
                try:
                    py_cam.close()
                except Exception:
                    pass
                py_cam = None

if __name__ == '__main__':
    main()
