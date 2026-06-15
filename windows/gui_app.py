import os
import sys
import json
import time
import socket
import threading
import subprocess
import queue
import numpy as np
import pyvirtualcam

from PyQt5.QtWidgets import (
    QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout,
    QCheckBox, QPushButton, QTextEdit, QFrame, QGridLayout
)
from PyQt5.QtCore import Qt, pyqtSignal, QObject
from PyQt5.QtGui import QImage, QPixmap

# ─── Global State ─────────────────────────────────────────────────────────────
running = True
tcp_sock = None
ffmpeg_proc = None
py_cam = None
decoded_frames_count = 0
current_config = {"mirror": False}
latest_frame = None
frame_lock = threading.Lock()
vcam_queue = queue.Queue(maxsize=1)

def clear_vcam_queue():
    while not vcam_queue.empty():
        try:
            vcam_queue.get_nowait()
        except queue.Empty:
            break

def push_to_vcam(frame):
    try:
        vcam_queue.put_nowait(frame)
    except queue.Full:
        try:
            vcam_queue.get_nowait()
        except queue.Empty:
            pass
        try:
            vcam_queue.put_nowait(frame)
        except queue.Full:
            pass

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

# ─── Path Resolution ─────────────────────────────────────────────────────────
def get_base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

CONFIG_PATH = os.path.join(get_base_dir(), 'config.json')

def load_config():
    global current_config
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                current_config = json.load(f)
    except Exception:
        pass

def save_config():
    try:
        with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(current_config, f, indent=2)
    except Exception:
        pass

def resolve_ffmpeg_path():
    base_dir = get_base_dir()
    # Check next to executable/script
    local_path = os.path.join(base_dir, "ffmpeg.exe")
    if os.path.exists(local_path):
        return local_path

    # Check local bin folder
    bin_folder = os.path.join(base_dir, "bin", "ffmpeg.exe")
    if os.path.exists(bin_folder):
        return bin_folder

    # Check hardcoded fallback
    hardcoded = r"F:\tools\ffmpeg\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
    if os.path.exists(hardcoded):
        return hardcoded

    return "ffmpeg"  # fallback to PATH

def get_config_dimensions():
    return 1280, 720

# ─── Signals for Thread Communication ─────────────────────────────────────────
class BridgeSignals(QObject):
    log_signal = pyqtSignal(str, str)         # source, message
    status_signal = pyqtSignal(str, str)      # state, text
    vcam_signal = pyqtSignal(str)             # status (ON/OFF)
    frames_signal = pyqtSignal(int)           # frame count

signals = BridgeSignals()

# ─── Pipeline Helper Functions ───────────────────────────────────────────────
def ffmpeg_log_worker(stderr_pipe):
    try:
        for line in iter(stderr_pipe.readline, b''):
            text = line.decode('utf-8', errors='ignore').strip()
            if text:
                signals.log_signal.emit("ffmpeg", text)
    except Exception:
        pass

def frame_reader_worker(stdout_pipe, width, height):
    global decoded_frames_count, py_cam, running
    frame_size = width * height * 3
    
    clear_vcam_queue()

    # Initialize virtual camera
    try:
        signals.log_signal.emit("python", f"Starting virtual camera {width}x{height} @ 30fps")
        py_cam = pyvirtualcam.Camera(width=width, height=height, fps=30, print_fps=False, backend='obs')
        signals.log_signal.emit("python", f"Virtual camera opened: {py_cam.device}")
        signals.vcam_signal.emit("ON")
    except Exception as e:
        signals.log_signal.emit("python", f"Error: Virtual Camera output could not be started: {e}")
        signals.log_signal.emit("python", "→ Make sure OBS Studio is completely closed (or virtual camera is stopped inside OBS)")
        signals.vcam_signal.emit("OFF")
        trigger_restart()
        return

    try:
        while running and ffmpeg_proc:
            # Read exactly frame_size bytes
            raw = b''
            while len(raw) < frame_size and running and ffmpeg_proc:
                chunk = stdout_pipe.read(frame_size - len(raw))
                if not chunk:
                    signals.log_signal.emit("python", "FFmpeg output closed.")
                    return
                raw += chunk

            if not running or not ffmpeg_proc:
                break

            # Reshape bytes to BGR Numpy array
            frame_bgr = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3))
            
            # Convert BGR -> RGB for pyvirtualcam and preview
            frame_rgb = frame_bgr[:, :, ::-1].copy()

            # Write to Virtual Camera
            py_cam.send(frame_rgb)
            decoded_frames_count += 1
            signals.frames_signal.emit(decoded_frames_count)

            # Store the latest frame for preview (main thread will pull via QTimer)
            global latest_frame
            with frame_lock:
                latest_frame = frame_rgb.copy()
            
            # Push latest frame to non-blocking VCam queue
            push_to_vcam(frame_rgb)
            
    except Exception as e:
        if running:
            signals.log_signal.emit("python", f"Frame reader exception: {e}")
    finally:
        if py_cam:
            try:
                py_cam.close()
            except Exception:
                pass
            py_cam = None
        signals.vcam_signal.emit("OFF")

def connection_worker():
    global running, tcp_sock, ffmpeg_proc
    
    while running:
        signals.log_signal.emit("adb", "Checking connection to phone...")
        signals.status_signal.emit("connecting", "Checking USB...")
        
        # 1. Wait for Android device
        try:
            subprocess.run(["adb", "wait-for-device"], check=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            signals.log_signal.emit("adb", "✓ Phone connected successfully!")
        except Exception as e:
            signals.log_signal.emit("adb", f"ADB wait failed: {e}. Retrying in 2s...")
            time.sleep(2)
            continue

        # 2. Launch Android app
        signals.log_signal.emit("adb", "Launching USB Webcam Bridge on phone...")
        try:
            subprocess.run([
                "adb", "shell", "am", "start", "-n",
                "com.example.usbwebcambridge/com.example.usbwebcambridge.MainActivity"
            ], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            signals.log_signal.emit("adb", "✓ App launched on phone!")
        except Exception as e:
            signals.log_signal.emit("adb", f"WARNING: Could not launch app automatically: {e}")

        # 3. Setup port forward
        signals.log_signal.emit("adb", "Setting up ADB port forward (tcp:8080 -> tcp:8080)...")
        try:
            subprocess.run(["adb", "forward", "tcp:8080", "tcp:8080"], check=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            signals.log_signal.emit("adb", "✓ Port forward ready!")
        except Exception as e:
            signals.log_signal.emit("adb", f"Port forward failed: {e}. Retrying in 2s...")
            time.sleep(2)
            continue

        # 4. Connect to TCP stream
        signals.log_signal.emit("android", "Connecting to phone stream at 127.0.0.1:8080...")
        signals.status_signal.emit("connecting", "Connecting to stream...")
        tcp_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        tcp_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1) # Disable Nagle's algorithm for sub-millisecond latency
        tcp_sock.settimeout(4.0)
        try:
            tcp_sock.connect(("127.0.0.1", 8080))
            signals.log_signal.emit("android", "✓ Connected to Android stream! Start streaming on your phone.")
            signals.status_signal.emit("connected", "Streaming Active")
        except Exception as e:
            signals.log_signal.emit("android", f"Connection failed: {e}. Make sure you tapped 'START STREAMING' on the phone app.")
            tcp_sock.close()
            tcp_sock = None
            time.sleep(2.0)
            continue

        # 5. Start pipeline
        start_pipeline()

        # 6. Pipe network stream bytes into FFmpeg stdin
        try:
            tcp_sock.settimeout(None)
            while running and tcp_sock and ffmpeg_proc:
                data = tcp_sock.recv(65536)
                if not data:
                    signals.log_signal.emit("android", "Android stream disconnected.")
                    break
                
                if ffmpeg_proc and ffmpeg_proc.stdin and ffmpeg_proc.stdin.writable:
                    try:
                        ffmpeg_proc.stdin.write(data)
                        ffmpeg_proc.stdin.flush() # Flush immediately to avoid internal python buffering delays
                    except OSError:
                        break  # FFmpeg exited
        except Exception as e:
            if running:
                signals.log_signal.emit("android", f"Stream reading exception: {e}")
        finally:
            signals.log_signal.emit("pc", "Cleaning up streaming pipeline...")
            cleanup_pipeline()
            signals.status_signal.emit("connecting", "Disconnected. Reconnecting...")
            time.sleep(2.0)

def start_pipeline():
    global ffmpeg_proc
    
    width, height = get_config_dimensions()
    mirror = current_config.get("mirror", False)
    
    ffmpeg_path = resolve_ffmpeg_path()
    vf = f"hflip,scale={width}:{height}" if mirror else f"scale={width}:{height}"
    
    signals.log_signal.emit("pc", f"Starting FFmpeg pipeline ({width}x{height}, Mirror={mirror})...")
    signals.log_signal.emit("pc", f"Using FFmpeg binary: {ffmpeg_path}")

    ffmpeg_cmd = [
        ffmpeg_path,
        '-hide_banner', '-loglevel', 'info',
        '-use_wallclock_as_timestamps', '1',
        '-fflags', 'nobuffer+discardcorrupt',
        '-flags', 'low_delay',
        '-threads', '1',              # LATENCY FIX: Disable frame-threaded decoding buffering
        '-analyzeduration', '200000', # LATENCY FIX: Lower analysis duration from 1s to 200ms
        '-probesize', '200000',       # LATENCY FIX: Lower probesize from 1MB to 200KB
        '-f', 'h264', '-i', 'pipe:0',
        '-f', 'rawvideo', '-pix_fmt', 'bgr24',
        '-vsync', '0',                # Pass frames directly without duplicating
        '-vf', vf,
        'pipe:1'
    ]

    try:
        ffmpeg_proc = subprocess.Popen(
            ffmpeg_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        )
    except Exception as e:
        signals.log_signal.emit("pc", f"CRITICAL: Failed to launch FFmpeg: {e}")
        return

    # Log reader thread
    log_th = threading.Thread(target=ffmpeg_log_worker, args=(ffmpeg_proc.stderr,), daemon=True)
    log_th.start()

    # Frame reader thread
    frame_th = threading.Thread(target=frame_reader_worker, args=(ffmpeg_proc.stdout, width, height), daemon=True)
    frame_th.start()

def cleanup_pipeline():
    global ffmpeg_proc, tcp_sock
    if tcp_sock:
        try:
            tcp_sock.close()
        except Exception:
            pass
        tcp_sock = None

    if ffmpeg_proc:
        try:
            ffmpeg_proc.stdin.close()
        except Exception:
            pass
        try:
            ffmpeg_proc.terminate()
            ffmpeg_proc.wait(timeout=1.5)
        except Exception:
            try:
                ffmpeg_proc.kill()
            except Exception:
                pass
        ffmpeg_proc = None

def trigger_restart():
    global tcp_sock
    if tcp_sock:
        try:
            tcp_sock.close()
        except Exception:
            pass
        tcp_sock = None

# ─── QSS Modern Dark Theme Stylesheet ────────────────────────────────────────
DARK_STYLESHEET = """
    QWidget {
        background-color: #0b0f19;
        color: #f3f4f6;
        font-family: 'Segoe UI', Arial, sans-serif;
        font-size: 13px;
    }
    QFrame#panel {
        background-color: #161e2e;
        border: 1px solid #273244;
        border-radius: 12px;
    }
    QLabel {
        background: transparent;
    }
    QLabel#header_text {
        font-size: 18px;
        font-weight: bold;
        color: #f3f4f6;
    }
    QLabel#status_badge {
        font-weight: bold;
        background-color: #1f293d;
        color: #9ca3af;
        border-radius: 4px;
        padding: 4px 10px;
    }
    QLabel#status_badge_connected {
        font-weight: bold;
        background-color: #10b981;
        color: #0b0f19;
        border-radius: 4px;
        padding: 4px 10px;
    }
    QLabel#status_badge_connecting {
        font-weight: bold;
        background-color: #f59e0b;
        color: #0b0f19;
        border-radius: 4px;
        padding: 4px 10px;
    }
    QLabel#title_label {
        font-size: 14px;
        font-weight: bold;
        color: #f3f4f6;
    }
    QLabel#muted_label {
        font-size: 11px;
        color: #9ca3af;
    }
    QLabel#stat_val {
        font-size: 18px;
        font-weight: bold;
        color: #06b6d4;
    }
    QCheckBox {
        spacing: 8px;
    }
    QCheckBox::indicator {
        width: 18px;
        height: 18px;
        border: 1px solid #273244;
        border-radius: 4px;
        background: #1f293d;
    }
    QCheckBox::indicator:checked {
        background: #06b6d4;
        border-color: #06b6d4;
    }
    QPushButton {
        background-color: #06b6d4;
        color: #0b0f19;
        font-weight: bold;
        border: none;
        border-radius: 6px;
        padding: 8px 16px;
    }
    QPushButton:hover {
        background-color: #22d3ee;
    }
    QPushButton:pressed {
        background-color: #0891b2;
    }
    QPushButton#clear_btn {
        background-color: transparent;
        color: #9ca3af;
        font-weight: normal;
        border: 1px solid #273244;
        border-radius: 6px;
        padding: 4px 10px;
    }
    QPushButton#clear_btn:hover {
        color: #f3f4f6;
        background-color: rgba(255,255,255,0.05);
    }
    QTextEdit {
        background-color: #030712;
        border: 1px solid #273244;
        border-radius: 8px;
        color: #e5e7eb;
        font-family: 'Consolas', 'Courier New', monospace;
        font-size: 11px;
        padding: 8px;
    }
"""

# ─── Main Window Class ────────────────────────────────────────────────────────
class WebcamBridgeApp(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("USB Webcam Bridge")
        
        # CHANGED: Allow window resizing and maximization
        self.setMinimumSize(1100, 680)
        self.setStyleSheet(DARK_STYLESHEET)

        # Grid Main Layout (2 Columns)
        main_layout = QHBoxLayout(self)
        main_layout.setContentsMargins(20, 20, 20, 20)
        main_layout.setSpacing(20)

        # Left Column Frame
        left_layout = QVBoxLayout()
        left_layout.setSpacing(15)

        # Header bar
        header_layout = QHBoxLayout()
        self.lbl_logo = QLabel("⬤")
        self.lbl_logo.setStyleSheet("color: #06b6d4; font-size: 16px;")
        header_layout.addWidget(self.lbl_logo)
        
        lbl_title = QLabel("USB Webcam Bridge")
        lbl_title.setObjectName("header_text")
        header_layout.addWidget(lbl_title)
        
        header_layout.addStretch()

        self.lbl_status = QLabel("Disconnected")
        self.lbl_status.setObjectName("status_badge")
        header_layout.addWidget(self.lbl_status)
        left_layout.addLayout(header_layout)

        # Video Panel QFrame
        self.panel_video = QFrame()
        self.panel_video.setObjectName("panel")
        self.panel_video_layout = QVBoxLayout(self.panel_video)
        self.panel_video_layout.setContentsMargins(10, 10, 10, 10)

        # Feed label
        self.lbl_feed = QLabel("Waiting for H.264 stream from Android phone...\n\nMake sure USB debugging is enabled in developer options, then tap 'START STREAMING' on your phone app.")
        self.lbl_feed.setAlignment(Qt.AlignCenter)
        self.lbl_feed.setWordWrap(True)
        self.lbl_feed.setStyleSheet("font-size: 14px; color: #9ca3af;")
        self.panel_video_layout.addWidget(self.lbl_feed)
        
        left_layout.addWidget(self.panel_video, stretch=6)

        # Stats QFrame
        panel_stats = QFrame()
        panel_stats.setObjectName("panel")
        stats_layout = QGridLayout(panel_stats)
        stats_layout.setContentsMargins(15, 12, 15, 12)
        
        lbl_vcam_title = QLabel("VIRTUAL CAMERA")
        lbl_vcam_title.setObjectName("muted_label")
        stats_layout.addWidget(lbl_vcam_title, 0, 0, Qt.AlignCenter)
        self.lbl_stat_vcam = QLabel("OFF")
        self.lbl_stat_vcam.setObjectName("stat_val")
        self.lbl_stat_vcam.setStyleSheet("color: #f59e0b;")
        stats_layout.addWidget(self.lbl_stat_vcam, 1, 0, Qt.AlignCenter)

        lbl_frames_title = QLabel("DECODED FRAMES")
        lbl_frames_title.setObjectName("muted_label")
        stats_layout.addWidget(lbl_frames_title, 0, 1, Qt.AlignCenter)
        self.lbl_stat_frames = QLabel("0")
        self.lbl_stat_frames.setObjectName("stat_val")
        stats_layout.addWidget(self.lbl_stat_frames, 1, 1, Qt.AlignCenter)

        lbl_conn_title = QLabel("CONNECTION TYPE")
        lbl_conn_title.setObjectName("muted_label")
        stats_layout.addWidget(lbl_conn_title, 0, 2, Qt.AlignCenter)
        lbl_stat_conn = QLabel("USB (ADB)")
        lbl_stat_conn.setObjectName("stat_val")
        lbl_stat_conn.setStyleSheet("color: #10b981;")
        stats_layout.addWidget(lbl_stat_conn, 1, 2, Qt.AlignCenter)

        left_layout.addWidget(panel_stats, stretch=1)
        main_layout.addLayout(left_layout, stretch=6)

        # Right Column Layout
        right_layout = QVBoxLayout()
        right_layout.setSpacing(15)

        # Camera Controls QFrame
        panel_controls = QFrame()
        panel_controls.setObjectName("panel")
        controls_layout = QVBoxLayout(panel_controls)
        controls_layout.setContentsMargins(16, 16, 16, 16)
        controls_layout.setSpacing(10)

        lbl_ctrl_title = QLabel("CAMERA CONTROLS")
        lbl_ctrl_title.setObjectName("title_label")
        controls_layout.addWidget(lbl_ctrl_title)

        row_actions = QHBoxLayout()
        self.chk_mirror = QCheckBox("Mirror Video Feed")
        self.chk_mirror.setChecked(current_config.get("mirror", False))
        self.chk_mirror.stateChanged.connect(self.on_config_changed)
        row_actions.addWidget(self.chk_mirror)

        row_actions.addStretch()

        self.btn_restart = QPushButton("Restart Stream")
        self.btn_restart.setCursor(Qt.PointingHandCursor)
        self.btn_restart.clicked.connect(self.on_restart_clicked)
        row_actions.addWidget(self.btn_restart)
        controls_layout.addLayout(row_actions)

        right_layout.addWidget(panel_controls)

        # Console Logs QFrame
        panel_logs = QFrame()
        panel_logs.setObjectName("panel")
        logs_layout = QVBoxLayout(panel_logs)
        logs_layout.setContentsMargins(16, 16, 16, 16)
        logs_layout.setSpacing(10)

        header_logs_layout = QHBoxLayout()
        lbl_logs_title = QLabel("CONSOLE LOGS")
        lbl_logs_title.setObjectName("title_label")
        header_logs_layout.addWidget(lbl_logs_title)
        
        header_logs_layout.addStretch()

        btn_clear = QPushButton("Clear")
        btn_clear.setObjectName("clear_btn")
        btn_clear.setCursor(Qt.PointingHandCursor)
        btn_clear.clicked.connect(self.clear_logs)
        header_logs_layout.addWidget(btn_clear)
        logs_layout.addLayout(header_logs_layout)

        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setLineWrapMode(QTextEdit.WidgetWidth)
        logs_layout.addWidget(self.log_text)

        right_layout.addWidget(panel_logs)
        main_layout.addLayout(right_layout, stretch=4)

        # Wire Signals to UI Methods
        signals.log_signal.connect(self.append_log)
        signals.status_signal.connect(self.update_status_ui)
        signals.vcam_signal.connect(self.update_vcam_ui)
        signals.frames_signal.connect(self.update_frames_ui)

        # Setup preview polling timer
        from PyQt5.QtCore import QTimer
        self.preview_timer = QTimer(self)
        self.preview_timer.timeout.connect(self.update_preview_tick)
        self.preview_timer.start(30) # ~33 FPS

    def append_log(self, source, msg):
        time_str = time.strftime("%H:%M:%S")
        
        # Default neutral grey color for all sources (prevents normal FFmpeg output from showing up in red!)
        color = {
            "pc": "#06b6d4",
            "adb": "#a7f3d0",
            "android": "#10b981",
            "ffmpeg": "#9ca3af",
            "python": "#9ca3af"
        }.get(source, "#e5e7eb")
        
        # CHANGED: Show actual error strings in bright red, warnings in orange
        msg_lower = msg.lower()
        if "error" in msg_lower or "failed" in msg_lower or "exception" in msg_lower or "critical" in msg_lower:
            color = "#f43f5e"
        elif "warning" in msg_lower or "warn" in msg_lower:
            color = "#f59e0b"
        
        html = f'<font color="#555861">[ {time_str} ]</font> <font color="{color}"><b>[ {source.upper()} ]</b> {msg}</font>'
        self.log_text.append(html)
        self.log_text.ensureCursorVisible()

    def clear_logs(self):
        self.log_text.clear()

    def update_status_ui(self, state, text):
        self.lbl_status.setText(text)
        if state == "connected":
            self.lbl_status.setObjectName("status_badge_connected")
        elif state == "connecting":
            self.lbl_status.setObjectName("status_badge_connecting")
        else:
            self.lbl_status.setObjectName("status_badge")
        self.lbl_status.style().unpolish(self.lbl_status)
        self.lbl_status.style().polish(self.lbl_status)

    def update_vcam_ui(self, val):
        self.lbl_stat_vcam.setText(val)
        if val == "ON":
            self.lbl_stat_vcam.setStyleSheet("color: #10b981;")
        else:
            self.lbl_stat_vcam.setStyleSheet("color: #f59e0b;")

    def update_frames_ui(self, val):
        self.lbl_stat_frames.setText(str(val))

    def update_preview_tick(self):
        global latest_frame
        frame = None
        with frame_lock:
            if latest_frame is not None:
                frame = latest_frame
                latest_frame = None  # Consume frame
        
        if frame is not None:
            h, w, ch = frame.shape
            bytes_per_line = ch * w
            q_img = QImage(frame.data, w, h, bytes_per_line, QImage.Format_RGB888)
            w_panel = max(self.panel_video.width() - 4, 320)
            h_panel = max(self.panel_video.height() - 4, 180)
            # Use FastTransformation for ultra low latency (SmoothTransformation is too slow and blocks event loop)
            pixmap = QPixmap.fromImage(q_img).scaled(
                w_panel, h_panel, Qt.KeepAspectRatio, Qt.FastTransformation
            )
            self.lbl_feed.setPixmap(pixmap)

    def on_config_changed(self):
        global current_config
        mirror = self.chk_mirror.isChecked()
        
        current_config["mirror"] = mirror
        
        save_config()
        self.append_log("pc", f"Config updated: mirror={mirror}. Reinitializing stream...")
        
        self.lbl_feed.clear()
        self.lbl_feed.setText("Re-spawning camera stream...")
        self.lbl_feed.setStyleSheet("font-size: 14px; color: #9ca3af; padding: 20px;")
        
        trigger_restart()

    def on_restart_clicked(self):
        self.append_log("pc", "Restarting streaming worker thread...")
        self.lbl_feed.clear()
        self.lbl_feed.setText("Re-spawning camera stream...")
        self.lbl_feed.setStyleSheet("font-size: 14px; color: #9ca3af; padding: 20px;")
        trigger_restart()

    def closeEvent(self, event):
        global running
        running = False
        cleanup_pipeline()
        event.accept()

# ─── Main Program Loop ────────────────────────────────────────────────────────
def main():
    load_config()
    
    app = QApplication(sys.argv)
    window = WebcamBridgeApp()
    window.show()

    # Log initial diagnostic text
    signals.log_signal.emit("pc", "=== USB Webcam Bridge Desktop GUI App ===")
    signals.log_signal.emit("pc", f"Local Dir: {get_base_dir()}")
    signals.log_signal.emit("pc", f"FFmpeg:    {resolve_ffmpeg_path()}")

    # Launch background connection thread
    conn_thread = threading.Thread(target=connection_worker, name="ADBConnectionThread", daemon=True)
    conn_thread.start()

    # Launch background VCam sender thread to decouple sending from decoding
    vcam_sender_th = threading.Thread(target=vcam_sender_worker, name="VCamSenderThread", daemon=True)
    vcam_sender_th.start()

    sys.exit(app.exec_())

if __name__ == '__main__':
    main()
