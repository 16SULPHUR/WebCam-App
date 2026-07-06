"""
rvm_matting.py — Robust Video Matting segmentation engine.

Uses PeterL1n/RobustVideoMatting (PyTorch, MobileNetV3 variant) for real-time
background matting with recurrent temporal stability. Unlike single-frame models,
recurrent states (`rec`) are carried across frames, eliminating flicker entirely
without needing EMA post-processing or a background reference image.

Requires: pip install torch torchvision
"""

import sys
import os
import cv2
import numpy as np


class RVMSegmenter:
    def __init__(self, downsample_ratio: float = 0.25):
        self.model = None
        self.device = None
        self.rec = [None] * 4          # recurrent states carried across frames
        self.downsample_ratio = downsample_ratio
        self._last_h: int | None = None
        self._last_w: int | None = None
        self._load_model()

    # ------------------------------------------------------------------
    # Model loading
    # ------------------------------------------------------------------

    def _load_model(self):
        try:
            import torch
        except ImportError:
            sys.stderr.write(
                "[RVM] torch not installed. Run:\n"
                "  pip install torch torchvision "
                "--index-url https://download.pytorch.org/whl/cu121\n"
            )
            return

        try:
            sys.stderr.write("[RVM] Loading RobustVideoMatting (mobilenetv3) via torch.hub…\n")
            model = torch.hub.load(
                "PeterL1n/RobustVideoMatting",
                "mobilenetv3",
                trust_repo=True,
            )
            if torch.cuda.is_available():
                model = model.cuda()
                self.device = torch.device("cuda")
                sys.stderr.write("[RVM] Model loaded on CUDA GPU.\n")
            else:
                self.device = torch.device("cpu")
                sys.stderr.write("[RVM] CUDA not available — running on CPU (slower).\n")
            self.model = model.eval()
        except Exception as e:
            sys.stderr.write(f"[RVM] ERROR loading model: {e}\n")

    # ------------------------------------------------------------------
    # Per-frame inference
    # ------------------------------------------------------------------

    def reset_states(self):
        """Reset recurrent states (call when resolution or engine changes)."""
        self.rec = [None] * 4

    def process_frame(self, frame_rgb: np.ndarray, downsample_ratio: float | None = None) -> np.ndarray | None:
        """
        Args:
            frame_rgb: uint8 RGB image [H, W, 3]
            downsample_ratio: override instance default (0.1 = fastest, 0.5 = best quality)

        Returns:
            float32 alpha matte [H, W, 1], values in [0, 1], or None on failure.
        """
        if self.model is None:
            return None

        import torch

        ratio = downsample_ratio if downsample_ratio is not None else self.downsample_ratio
        h, w = frame_rgb.shape[:2]

        # Reset recurrent state if resolution changed (prevents ghosting on resize)
        if h != self._last_h or w != self._last_w:
            self.reset_states()
            self._last_h = h
            self._last_w = w

        try:
            # [1, 3, H, W] float32, normalised to [0, 1]
            tensor = (
                torch.from_numpy(frame_rgb)
                .float()
                .div(255.0)
                .permute(2, 0, 1)
                .unsqueeze(0)
                .to(self.device)
            )

            with torch.no_grad():
                fgr, pha, *self.rec = self.model(tensor, *self.rec, ratio)

            # pha: [1, 1, H, W] — squeeze to [H, W]
            alpha = pha[0, 0].cpu().numpy().astype(np.float32)

            # Feather mask edges to avoid hard "cut-out" look (3 px)
            alpha = cv2.GaussianBlur(alpha, (5, 5), 0)

            return np.expand_dims(alpha, axis=-1)   # [H, W, 1]

        except Exception as e:
            sys.stderr.write(f"[RVM] Inference error: {e}\n")
            return None
