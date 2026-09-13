# USB Webcam Bridge — MVP

Stream your Android phone's camera to your Windows PC over USB, appearing as a virtual webcam in Zoom, OBS, Teams, and more.

---

## Architecture

```
Android Phone                        Windows PC
┌──────────────────────┐            ┌──────────────────────────────────────┐
│  Camera2 API         │            │  adb forward tcp:8080 tcp:8080       │
│      ↓               │  USB       │           ↓                          │
│  MediaCodec H.264    │ ─────────► │  Node.js TCP client (localhost:8080) │
│  TCP Server :8080    │            │      ↓                               │
└──────────────────────┘            │  FFmpeg → raw BGR24 frames           │
                                    │      ↓                               │
                                    │  Python (pyvirtualcam) → Virtual Cam │
                                    └──────────────────────────────────────┘
```

---

## Prerequisites

### Android Side
- Android 5.0+ device with USB debugging enabled
- Android Studio (to build & install the APK)

### Windows Side
| Requirement | Install |
|---|---|
| Node.js 18+ | https://nodejs.org |
| FFmpeg (on PATH) | https://ffmpeg.org/download.html — add `bin/` to system PATH |
| Python 3.8+ | https://python.org |
| pyvirtualcam | `pip install pyvirtualcam` |
| MediaPipe (backgrounds, touch-up, reactions) | `pip install mediapipe` |
| Pillow (custom reaction emoji — optional) | `pip install pillow` |
| OBS Studio + Virtual Camera | https://obsproject.com — OBS must be running with Virtual Camera **started** |
| ADB (Android Platform Tools) | https://developer.android.com/studio/releases/platform-tools |

---

## Quick Start

### Step 1 — Build & Run the Android App
1. Open `android/` in Android Studio.
2. Build and install on your phone (`Run ▶`).
3. Grant Camera permission when prompted.
4. Tap **Start Streaming**.

### Step 2 — Connect via USB & Forward Port
Plug your phone in via USB, then run:
```bash
adb forward tcp:8080 tcp:8080
```

### Step 3 — Start the Windows Bridge
```bash
cd windows
npm install
npm start
```

### Step 4 — Use the Virtual Camera
In Zoom / Teams / OBS, select **"OBS Virtual Camera"** as your video input device.

---

## Reaction Overlays 🎭

Throw a thumbs-up, a peace sign, heart-hands or a big smile at the camera and the
matching emoji (or your own meme) animates onto the stream — virtual camera
included. Off by default; everything lives behind **Controller → REACTIONS →
CONFIG** in the dashboard: master switch, detection tuning, and the full list of
gesture → artwork mappings.

Bundled triggers: thumbs up/down, peace, wave, fist, OK, rock horns, shaka,
pointing up, heart hands, both hands up, smile, surprise, wink, eyebrow raise.
Add your own gestures, animations and artwork — see
[`windows/reactions/README.md`](windows/reactions/README.md).

## Folder Structure
```
/
├── README.md            ← this file
├── android/             ← Android Studio project (Kotlin)
│   └── ...
└── windows/             ← Node.js bridge
    ├── package.json
    ├── index.js         ← main bridge script
    ├── frame_sender.py  ← Python pyvirtualcam helper
    └── README.md        ← Windows-specific detail
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `adb: command not found` | Add platform-tools to PATH |
| `Connection refused` on Node | Ensure phone is streaming AND `adb forward` ran |
| Black screen in virtual cam | OBS Virtual Camera must be **started** before running `npm start` |
| High latency | Lower bitrate in `CameraStreamer.kt` or try `zerolatency` preset in `index.js` |
| Camera permission denied | Grant in Android Settings → Apps → USB Webcam Bridge → Permissions |
