# USB Webcam Bridge — Windows Side

## Requirements

### 1. Node.js (18+)
Download from https://nodejs.org

### 2. FFmpeg
Download a static build from https://ffmpeg.org/download.html (e.g. gyan.dev builds).
Extract and add the `bin/` folder to your system PATH.

Verify:
```bash
ffmpeg -version
```

### 3. Python 3.8+ with pyvirtualcam
```bash
pip install pyvirtualcam
```

### 4. OBS Studio with Virtual Camera
- Install OBS from https://obsproject.com
- Launch OBS → click **"Start Virtual Camera"** in the Controls panel.
- The virtual camera must be running BEFORE you start the Node.js bridge.

### 5. ADB (Android Platform Tools)
Download from https://developer.android.com/studio/releases/platform-tools
Add `platform-tools/` folder to your system PATH.

---

## Setup Steps

```bash
# 1. Plug in your Android phone (USB debugging must be enabled)
adb forward tcp:8080 tcp:8080

# 2. Start the Android app and tap "Start Streaming"

# 3. Install Node dependencies (first time only)
npm install

# 4. Run the bridge
npm start
```

---

## Configuration

All tunable parameters are marked with `// TUNE:` comments in `index.js` and `frame_sender.py`.

Key parameters:
| Parameter | Location | Default |
|---|---|---|
| Resolution | `index.js` + `frame_sender.py` | 1280x720 |
| Framerate | `frame_sender.py` | 24 fps |
| FFmpeg input format | `index.js` | h264 |

---

## How It Works

```
Node.js
  └─ TCP connect → localhost:8080 (forwarded by adb to phone :8080)
  └─ pipe H.264 bytes → ffmpeg (stdin)
       └─ ffmpeg decodes → raw BGR24 frames (stdout)
            └─ pipe → Python (stdin)
                  └─ pyvirtualcam → OBS Virtual Camera device
```
