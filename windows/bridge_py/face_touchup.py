"""
face_touchup.py — MediaPipe Face Mesh based skin-smoothing touch-up.

Builds a skin-region mask from facial landmarks (face oval, minus eyes,
eyebrows, lips, and nostrils), applies a bilateral filter within that mask,
and blends the result back at configurable strength (0-1).

This replicates the subtle "Meet/Zoom beauty" effect — just enough smoothing
to look natural without the plasticky over-smoothed look.

Requires: pip install mediapipe
"""

import sys
import cv2
import numpy as np


# ---------------------------------------------------------------------------
# MediaPipe face mesh landmark index sets
# ---------------------------------------------------------------------------

# Outer face oval (36 points)
FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172,  58, 132,  93, 234, 127, 162,  21,  54, 103,  67, 109,
]

# Left eye contour (exclusion zone)
LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]

# Right eye contour (exclusion zone)
RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173]

# Left eyebrow (exclusion)
LEFT_BROW = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336]

# Right eyebrow (exclusion)
RIGHT_BROW = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107]

# Lips outer contour (exclusion)
LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]

# Nostril region (exclusion) — approximate
NOSTRILS = [48, 115, 220, 45, 275, 440, 344, 278]


def _pts(landmarks, indices, w, h):
    """Extract pixel coordinates for given landmark indices."""
    return np.array(
        [[int(landmarks[i].x * w), int(landmarks[i].y * h)] for i in indices],
        dtype=np.int32,
    )


class FaceTouchup:
    def __init__(self):
        self._face_mesh = None
        self._load()

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def _load(self):
        try:
            import mediapipe as mp
            self._face_mesh = mp.solutions.face_mesh.FaceMesh(
                static_image_mode=False,
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            sys.stderr.write("[FaceTouchup] MediaPipe Face Mesh loaded.\n")
        except Exception as e:
            sys.stderr.write(f"[FaceTouchup] ERROR loading Face Mesh: {e}\n")

    # ------------------------------------------------------------------
    # Per-frame processing
    # ------------------------------------------------------------------

    def process_frame(self, frame_rgb: np.ndarray, strength: float = 0.35) -> np.ndarray:
        """
        Args:
            frame_rgb: uint8 RGB [H, W, 3]
            strength:  blend opacity 0.0 (off) → 1.0 (full)

        Returns:
            Processed frame_rgb with skin smoothing applied.
        """
        if self._face_mesh is None or strength < 0.01:
            return frame_rgb

        try:
            h, w = frame_rgb.shape[:2]
            results = self._face_mesh.process(frame_rgb)

            if not results.multi_face_landmarks:
                return frame_rgb

            lm = results.multi_face_landmarks[0].landmark

            # ── Build skin mask ──────────────────────────────────────────
            skin_mask = np.zeros((h, w), dtype=np.uint8)

            # Fill the face oval
            oval = _pts(lm, FACE_OVAL, w, h)
            hull = cv2.convexHull(oval)
            cv2.fillConvexPoly(skin_mask, hull, 255)

            # Punch out exclusion zones (eyes, brows, lips, nostrils)
            excl_kernel = np.ones((7, 7), np.uint8)
            for region in (LEFT_EYE, RIGHT_EYE, LEFT_BROW, RIGHT_BROW, LIPS, NOSTRILS):
                pts = _pts(lm, region, w, h)
                excl_mask = np.zeros((h, w), dtype=np.uint8)
                cv2.fillConvexPoly(excl_mask, cv2.convexHull(pts), 255)
                # Dilate exclusion zones to give a clean boundary
                excl_mask = cv2.dilate(excl_mask, excl_kernel, iterations=2)
                skin_mask = cv2.bitwise_and(skin_mask, cv2.bitwise_not(excl_mask))

            # Slightly erode outer edge for a soft boundary
            skin_mask = cv2.erode(skin_mask, np.ones((3, 3), np.uint8), iterations=1)

            # ── Apply bilateral filter (skin-smoothing pass) ──────────────
            smoothed = cv2.bilateralFilter(frame_rgb, d=9, sigmaColor=75, sigmaSpace=75)

            # ── Soft-edge blend mask ──────────────────────────────────────
            # Blur the hard mask so the blending has a feathered edge
            soft_mask = cv2.GaussianBlur(skin_mask.astype(np.float32) / 255.0, (21, 21), 0)
            soft_mask_3d = np.stack([soft_mask] * 3, axis=-1) * float(strength)

            # ── Composite ─────────────────────────────────────────────────
            result = (
                frame_rgb.astype(np.float32) * (1.0 - soft_mask_3d)
                + smoothed.astype(np.float32) * soft_mask_3d
            ).astype(np.uint8)

            return result

        except Exception as e:
            sys.stderr.write(f"[FaceTouchup] Error: {e}\n")
            return frame_rgb
