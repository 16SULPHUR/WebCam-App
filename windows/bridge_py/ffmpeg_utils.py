"""
ffmpeg_utils.py — Build FFmpeg argument lists for VCam and Web MJPEG pipelines.

Mirrors the logic in index.js: buildVf(), getFfmpegVcamArgs(), getFfmpegWebArgs().
Adds new video-processing filters: eq (brightness/contrast/saturation) and
unsharp (sharpness), plus an fps throttle filter.
"""

from typing import List


def build_vf_filter(
    mirror: bool,
    orientation: int,
    width: int,
    height: int,
    zoom: float          = 1.0,
    brightness: float    = 0.0,
    contrast: float      = 1.0,
    saturation: float    = 1.0,
    sharpness: float     = 0.0,
    target_fps: int      = 30,
) -> str:
    """
    Compose a single FFmpeg -vf filter string.

    Order of operations (mirrors index.js buildVf):
      1. FPS throttle (fps=N) — applied first so later filters see fewer frames
      2. Crop-zoom (crop=iw/z:ih/z)
      3. Mirror (hflip)
      4. Rotation (transpose / vflip+hflip)
      5. Scale to output dimensions
      6. Colour eq (brightness / contrast / saturation)
      7. Sharpness (unsharp)
    """
    parts: List[str] = []

    # 1. FPS throttle — only add if below 30
    if target_fps < 30:
        parts.append(f"fps={target_fps}")

    # 2. Crop-zoom
    z = float(zoom) if zoom else 1.0
    if z > 1.0:
        parts.append(f"crop=iw/{z:.4f}:ih/{z:.4f}")

    # 3. Mirror
    if mirror:
        parts.append("hflip")

    # 4. Rotation
    rot = int(orientation or 0)
    if rot == 90:
        parts.append("transpose=1")          # 90° CW
    elif rot == 180:
        parts.append("vflip,hflip")          # 180°
    elif rot == 270:
        parts.append("transpose=2")          # 90° CCW

    # 5. Scale — swap dimensions for 90/270
    out_w = height if rot in (90, 270) else width
    out_h = width  if rot in (90, 270) else height
    parts.append(f"scale={out_w}:{out_h}")

    # 6. Colour eq — skip if all defaults
    eq_parts = []
    if abs(brightness) > 0.01:
        eq_parts.append(f"brightness={brightness:.3f}")
    if abs(contrast - 1.0) > 0.01:
        eq_parts.append(f"contrast={contrast:.3f}")
    if abs(saturation - 1.0) > 0.01:
        eq_parts.append(f"saturation={saturation:.3f}")
    if eq_parts:
        parts.append("eq=" + ":".join(eq_parts))

    # 7. Sharpness
    if sharpness > 0.05:
        parts.append(f"unsharp=5:5:{sharpness:.2f}:5:5:0.0")

    return ",".join(parts) if parts else "null"


def build_vcam_args(
    ffmpeg_path: str,
    width: int,
    height: int,
    mirror: bool,
    orientation: int,
    zoom: float,
    brightness: float,
    contrast: float,
    saturation: float,
    sharpness: float,
    target_fps: int,
) -> List[str]:
    """
    FFmpeg args: h264 pipe → raw BGR24 pipe (for pyvirtualcam).
    Output dimensions may be swapped if 90/270 rotation is applied.
    """
    vf = build_vf_filter(
        mirror=mirror, orientation=orientation,
        width=width, height=height,
        zoom=zoom, brightness=brightness, contrast=contrast,
        saturation=saturation, sharpness=sharpness, target_fps=target_fps,
    )
    return [
        ffmpeg_path,
        "-hide_banner", "-loglevel", "info",
        "-use_wallclock_as_timestamps", "1",
        "-fflags", "nobuffer+discardcorrupt",
        "-flags", "low_delay",
        "-threads", "1",
        "-analyzeduration", "200000",
        "-probesize", "200000",
        "-f", "h264", "-i", "pipe:0",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-fps_mode", "passthrough",
        "-vf", vf,
        "pipe:1",
    ]


def build_web_args(
    ffmpeg_path: str,
    mirror: bool,
    orientation: int,
    zoom: float,
    brightness: float,
    contrast: float,
    saturation: float,
    sharpness: float,
    target_fps: int,
    quality: int = 5,
) -> List[str]:
    """
    FFmpeg args: h264 pipe → MJPEG multipart pipe (for web dashboard).
    Preview base is 640×360; dimensions swap for 90/270 rotations.
    """
    base_w, base_h = 640, 360
    vf = build_vf_filter(
        mirror=mirror, orientation=orientation,
        width=base_w, height=base_h,
        zoom=zoom, brightness=brightness, contrast=contrast,
        saturation=saturation, sharpness=sharpness, target_fps=target_fps,
    )
    return [
        ffmpeg_path,
        "-hide_banner", "-loglevel", "info",
        "-use_wallclock_as_timestamps", "1",
        "-fflags", "nobuffer+discardcorrupt",
        "-flags", "low_delay",
        "-threads", "1",
        "-analyzeduration", "200000",
        "-probesize", "200000",
        "-f", "h264", "-i", "pipe:0",
        "-f", "mpjpeg",
        "-vf", vf,
        "-q:v", str(quality),
        "pipe:1",
    ]
