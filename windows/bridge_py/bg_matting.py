import os
import sys
import urllib.request
import cv2
import numpy as np
import onnxruntime as ort

MODEL_URL = "https://github.com/PeterL1n/BackgroundMattingV2/releases/download/v1.0.0/onnx_mobilenetv2_hd.onnx"
MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "onnx_mobilenetv2_hd.onnx")

class BackgroundMattingSegmenter:
    def __init__(self):
        self.session = None
        self._ensure_model_exists()
        
    def _ensure_model_exists(self):
        models_dir = os.path.dirname(MODEL_PATH)
        os.makedirs(models_dir, exist_ok=True)
        if not os.path.isfile(MODEL_PATH):
            sys.stderr.write(f"[BgMatting] Downloading ONNX model weights to {MODEL_PATH}...\n")
            try:
                # Add headers to avoid request block
                req = urllib.request.Request(
                    MODEL_URL,
                    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
                )
                with urllib.request.urlopen(req) as response, open(MODEL_PATH, 'wb') as out_file:
                    out_file.write(response.read())
                sys.stderr.write("[BgMatting] Download complete.\n")
            except Exception as e:
                sys.stderr.write(f"[BgMatting] ERROR downloading model: {e}\n")
                
        if os.path.isfile(MODEL_PATH):
            try:
                # Try CUDAExecutionProvider if GPU is available, fallback to CPUExecutionProvider
                self.session = ort.InferenceSession(
                    MODEL_PATH,
                    providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
                )
                sys.stderr.write(f"[BgMatting] Model loaded: {MODEL_PATH}\n")
            except Exception as e:
                sys.stderr.write(f"[BgMatting] ERROR loading ONNX model: {e}\n")
                
    def process_frame(self, frame_bgr, bgr_ref_bgr):
        """
        frame_bgr: current source frame [H, W, 3] in BGR24
        bgr_ref_bgr: background reference frame [H, W, 3] in BGR24
        Returns a float32 mask [H, W, 1] scaled 0.0 - 1.0.
        """
        if self.session is None:
            return None
            
        h, w = frame_bgr.shape[:2]
        
        # BackgroundMattingV2 works on multiples of 16/32. 
        # The HD model is trained on 1920x1080 or resized to standard aspect ratio.
        # We target the input width/height matching the frame resolution.
        # Ensure dimensions are divisible by 16 for stability
        target_w = (w // 16) * 16
        target_h = (h // 16) * 16
        
        # Resize to network dimensions
        src_resized = cv2.resize(frame_bgr, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
        bgr_resized = cv2.resize(bgr_ref_bgr, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
        
        src_rgb = cv2.cvtColor(src_resized, cv2.COLOR_BGR2RGB)
        bgr_rgb = cv2.cvtColor(bgr_resized, cv2.COLOR_BGR2RGB)
        
        src_inp = src_rgb.astype(np.float32) / 255.0
        bgr_inp = bgr_rgb.astype(np.float32) / 255.0
        
        # Transpose to [C, H, W]
        src_inp = np.transpose(src_inp, (2, 0, 1))
        bgr_inp = np.transpose(bgr_inp, (2, 0, 1))
        
        # Add batch dimension [1, C, H, W]
        src_inp = np.expand_dims(src_inp, axis=0)
        bgr_inp = np.expand_dims(bgr_inp, axis=0)
        
        try:
            # Inputs to model are: 'src' and 'bgr'
            outputs = self.session.run(["pha", "fgr"], {
                "src": src_inp,
                "bgr": bgr_inp
            })
            pha = outputs[0] # [1, 1, target_h, target_w]
            
            # Format alpha matte back to [target_h, target_w]
            mask = pha[0, 0, :, :]
            
            # Resize mask back to original resolution [H, W]
            if target_w != w or target_h != h:
                mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_LINEAR)
                
            mask = np.expand_dims(mask, axis=-1) # [H, W, 1]
            return mask
        except Exception as e:
            sys.stderr.write(f"[BgMatting] Inference error: {e}\n")
            return None
