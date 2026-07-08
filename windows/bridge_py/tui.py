"""
tui.py — Interactive Terminal User Interface for USB Webcam Bridge.

Uses the `rich` library to render a live layout showing:
  1. GPU stats (utilization, VRAM, temperature) using nvidia-smi queries.
  2. Android stream status and network metrics.
  3. Interactive, colorized log stream.
"""

import os
import sys
import time
import queue
import threading
import subprocess
from typing import Optional

from rich.live import Live
from rich.layout import Layout
from rich.panel import Panel
from rich.text import Text
from rich.align import Align
from rich.table import Table

class TuiManager:
    _instance: Optional['TuiManager'] = None

    def __init__(self, broadcaster, config=None) -> None:
        self._bc = broadcaster
        self._cfg = config
        self._logs_queue: queue.Queue = queue.Queue()
        self._logs_list: list = []
        self._max_logs = 60
        self._start_time = time.monotonic()
        
        self.gpu_data = {
            "name": "Checking GPU...",
            "util": 0,
            "mem_used": 0,
            "mem_total": 1,
            "temp": 0,
            "available": False
        }
        
        self.running = False
        self._lock = threading.Lock()
        self._live: Optional[Live] = None
        self.layout: Optional[Layout] = None
        self._monitor_thread: Optional[threading.Thread] = None
        
        TuiManager._instance = self

    @classmethod
    def get_instance(cls) -> Optional['TuiManager']:
        return cls._instance

    # ── Context Manager API ───────────────────────────────────────────────────

    def __enter__(self) -> 'TuiManager':
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.stop()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        with self._lock:
            if self.running:
                return
            self.running = True
            
        # Add a startup log
        self.log("system", "Interactive Terminal TUI initialized.")

        # Spawn GPU status monitoring background thread
        self._monitor_thread = threading.Thread(
            target=self._monitor_gpu_loop,
            name="TuiGpuMonitor",
            daemon=True
        )
        self._monitor_thread.start()

        # Build Rich layout
        self.layout = self._build_layout()
        
        # Start Live render wrapper
        self._live = Live(self.layout, refresh_per_second=6, screen=True)
        self._live.start()

    def stop(self) -> None:
        with self._lock:
            if not self.running:
                return
            self.running = False
            
        if self._live:
            try:
                self._live.stop()
            except Exception:
                pass
            self._live = None

        TuiManager._instance = None
        print("\nTUI closed. Terminal state restored.\n")

    # ── Logs Ingestion ────────────────────────────────────────────────────────

    def log(self, source: str, message: str) -> None:
        ts = time.strftime("%H:%M:%S")
        self._logs_queue.put((ts, source, message))

    def _drain_logs(self) -> None:
        while not self._logs_queue.empty():
            try:
                ts, src, msg = self._logs_queue.get_nowait()
                # Clean up msg if it contains internal tags or escape codes
                self._logs_list.append((ts, src, msg))
                if len(self._logs_list) > self._max_logs:
                    self._logs_list.pop(0)
            except queue.Empty:
                break

    # ── GPU Monitoring Thread ──────────────────────────────────────────────────

    def _monitor_gpu_loop(self) -> None:
        while self.running:
            stats = self._query_nvidia_smi()
            with self._lock:
                self.gpu_data.update(stats)
            time.sleep(1.0)

    def _query_nvidia_smi(self) -> dict:
        try:
            # Query nvidia-smi for: name, utilization, used memory, total memory, temperature
            res = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                    "--format=csv,noheader,nounits"
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=0.8
            )
            stdout = res.stdout.strip()
            if not stdout:
                raise ValueError("Empty output")
            
            line = stdout.split("\n")[0]
            parts = [p.strip() for p in line.split(",")]
            
            return {
                "name": parts[0],
                "util": int(parts[1]),
                "mem_used": int(parts[2]),
                "mem_total": int(parts[3]),
                "temp": int(parts[4]),
                "available": True
            }
        except Exception:
            return {
                "name": "NVIDIA GPU (Offline)",
                "util": 0,
                "mem_used": 0,
                "mem_total": 4096,
                "temp": 0,
                "available": False
            }

    # ── Layout and Rendering ──────────────────────────────────────────────────

    def _build_layout(self) -> Layout:
        layout = Layout()
        layout.split_column(
            Layout(name="header", size=3),
            Layout(name="body"),
            Layout(name="footer", size=3)
        )
        layout["body"].split_row(
            Layout(name="sidebar", ratio=4),
            Layout(name="main", ratio=7)
        )
        return layout

    def update_render(self) -> None:
        """Call periodically (or let Live thread handle it) to refresh screen."""
        if not self.running or not self._live:
            return
        
        self._drain_logs()
        
        # Build views
        header_view = self._render_header()
        sidebar_view = self._render_sidebar()
        main_view = self._render_main()
        footer_view = self._render_footer()
        
        # Inject views into layout
        layout = self.layout
        if isinstance(layout, Layout):
            layout["header"].update(header_view)
            layout["sidebar"].update(sidebar_view)
            layout["main"].update(main_view)
            layout["footer"].update(footer_view)

    def _render_header(self) -> Panel:
        uptime = int(time.monotonic() - self._start_time)
        m, s = divmod(uptime, 60)
        h, m = divmod(m, 60)
        uptime_str = f"{h:02d}:{m:02d}:{s:02d}"
        
        # Fetch stats from broadcaster
        stats = self._bc.get_stats()
        conn_symbol = "🟢" if stats.get("androidConnected") else "🔴"
        conn_text = "Connected" if stats.get("androidConnected") else "Disconnected"
        
        text = Text.assemble(
            (" USB WEBCAM BRIDGE ", "bold reverse cyan"),
            "  |  Status: ",
            (f"{conn_symbol} {conn_text}", "bold green" if stats.get("androidConnected") else "bold red"),
            "  |  Uptime: ",
            (uptime_str, "bold yellow"),
            "  |  VCam Output: ",
            ("ACTIVE" if stats.get("vcamActive") else "INACTIVE", "bold green" if stats.get("vcamActive") else "bold dim")
        )
        
        return Panel(Align.center(text), border_style="cyan")

    def _render_sidebar(self) -> Table:
        # Layout multiple tables inside the sidebar Panel
        stats = self._bc.get_stats()
        cfg = self._cfg.to_dict() if self._cfg else {}
        
        # 1. Pipeline Status
        t_pipe = Table(show_header=False, expand=True, box=None)
        t_pipe.add_row("[bold cyan]STREAM STATISTICS[/bold cyan]")
        t_pipe.add_row(f"Resolution:  [bold white]{cfg.get('resolution', 'auto')}[/bold white]")
        t_pipe.add_row(f"Target FPS:  [bold white]{cfg.get('targetFps', 30)} fps[/bold white]")
        t_pipe.add_row(f"Net Bitrate: [bold white]{stats.get('bitrateKBs', 0.0)} KB/s[/bold white]")
        t_pipe.add_row(f"Total Frames: [bold white]{stats.get('decodedFrames', 0)}[/bold white]")
        t_pipe.add_row(f"Record Mode: [bold red]{'🔴 RECORDING' if stats.get('recording') else '⚪ IDLE'}[/bold red]")

        # 2. GPU Performance Dashboard
        with self._lock:
            gpu = dict(self.gpu_data)
            
        t_gpu = Table(show_header=False, expand=True, box=None)
        t_gpu.add_row("")
        t_gpu.add_row("[bold magenta]GPU HARDWARE PERFORMANCE[/bold magenta]")
        t_gpu.add_row(f"Model: [bold white]{gpu['name'][:24]}[/bold white]")
        
        # Utilization sparkline
        bar_w = 12
        filled_u = int(bar_w * (gpu['util'] / 100))
        util_color = "red" if gpu['util'] > 85 else ("yellow" if gpu['util'] > 50 else "green")
        util_bar = f"[{util_color}]" + "█" * filled_u + "░" * (bar_w - filled_u) + f"[/{util_color}]"
        t_gpu.add_row(f"GPU Load:  {util_bar} [bold white]{gpu['util']}%[/bold white]")
        
        # Memory sparkline
        mem_pct = (gpu['mem_used'] / gpu['mem_total'])
        filled_m = int(bar_w * mem_pct)
        mem_color = "red" if mem_pct > 0.85 else ("yellow" if mem_pct > 0.50 else "green")
        mem_bar = f"[{mem_color}]" + "█" * filled_m + "░" * (bar_w - filled_m) + f"[/{mem_color}]"
        t_gpu.add_row(f"VRAM Used: {mem_bar} [bold white]{gpu['mem_used']} / {gpu['mem_total']} MB[/bold white]")
        
        # Temperature
        temp = gpu['temp']
        if temp < 62:
            t_color = "green"
        elif temp < 78:
            t_color = "yellow"
        else:
            t_color = "red"
        t_gpu.add_row(f"GPU Temp:  [{t_color}]● {temp}°C[/{t_color}]")
        
        # Active Segmentation engine
        engine = cfg.get("segmentationEngine", "mediapipe")
        ft_active = "ON" if cfg.get("faceTouchupEnabled") else "OFF"
        t_gpu.add_row(f"Seg Engine: [bold cyan]{engine.upper()}[/bold cyan]")
        t_gpu.add_row(f"Face Mesh:  [bold pink]{ft_active}[/bold pink]")

        # 3. Outer container
        grid = Table(show_header=False, expand=True, box=None)
        grid.add_row(t_pipe)
        grid.add_row(t_gpu)
        
        return Panel(grid, title="System Health", border_style="magenta")

    def _render_main(self) -> Panel:
        text = Text()
        
        with self._lock:
            logs = list(self._logs_list)
            
        for ts, src, msg in logs:
            # Color code source labels
            src_lower = src.lower()
            if src_lower in ("system", "node"):
                src_style = "bold green"
                src_label = "SYSTEM"
            elif src_lower in ("python", "pysender"):
                src_style = "bold cyan"
                src_label = "PYTHON"
            elif src_lower in ("ffmpeg", "ffmpeg-vcam"):
                src_style = "bold magenta"
                src_label = "FFMPEG"
            elif "phone" in src_lower or "stats" in src_lower:
                src_style = "bold yellow"
                src_label = "PHONE "
            else:
                src_style = "bold white"
                src_label = src.upper()[:6].ljust(6)

            text.append(f"[{ts}] ", "dim")
            text.append(f"[{src_label}] ", src_style)
            
            # Substring styling for warning / error highlights in messages
            msg_lower = msg.lower()
            if "error" in msg_lower or "failed" in msg_lower:
                text.append(msg, "bold red")
            elif "warning" in msg_lower or "warn" in msg_lower:
                text.append(msg, "bold yellow")
            else:
                text.append(msg, "white")
            text.append("\n")
            
        return Panel(text, title="Interactive Log Stream", border_style="green", expand=True)

    def _render_footer(self) -> Panel:
        text = Text.assemble(
            (" Shortcuts: ", "bold yellow"),
            ("Ctrl + C", "bold white reverse"),
            (" Safe Shutdown  |  ", "dim"),
            ("Web Dashboard: ", "bold yellow"),
            ("http://localhost:3000", "bold underline cyan")
        )
        return Panel(Align.center(text), border_style="dim")


def run_tui_loop(tui: TuiManager) -> None:
    """Invoked to run the update render cycle regularly."""
    try:
        while tui.running:
            tui.update_render()
            time.sleep(0.15)
    except KeyboardInterrupt:
        pass
