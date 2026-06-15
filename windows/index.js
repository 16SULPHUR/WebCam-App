/**
 * USB Webcam Bridge — Windows Bridge (index.js)
 *
 * Pipelines:
 *   1. TCP → ffmpegVcamProc (decode to BGR24) → pythonProc (pyvirtualcam)
 *   2. TCP → ffmpegWebProc (decode to MJPEG) → HTTP Web Dashboard
 *
 * Web Dashboard served on http://localhost:3000
 */

'use strict';

const net    = require('net');
const { spawn } = require('child_process');
const path   = require('path');
const http   = require('http');
const fs     = require('fs');

// ─── Tool paths ───────────────────────────────────────────────────────────────
const isPackaged = typeof process.pkg !== 'undefined';
const baseDir = isPackaged ? path.dirname(process.execPath) : __dirname;

function resolveBinaryPath(binaryName, fallbackPath) {
  const localPath = path.join(baseDir, binaryName);
  if (fs.existsSync(localPath)) return localPath;

  const binFolder = path.join(baseDir, 'bin', binaryName);
  if (fs.existsSync(binFolder)) return binFolder;

  if (fallbackPath && fs.existsSync(fallbackPath)) return fallbackPath;

  return binaryName;
}

const FFMPEG_PATH  = resolveBinaryPath('ffmpeg.exe', 'F:\\tools\\ffmpeg\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe');
const PYTHON_PATH  = resolveBinaryPath('python.exe', 'F:\\tools\\python312\\python.exe');
// ─────────────────────────────────────────────────────────────────────────────

// ─── Configuration settings ──────────────────────────────────────────────────
const CONFIG_PATH = path.join(baseDir, 'config.json');
let currentConfig = { resolution: 'auto', mirror: false, orientation: 0, vcamEnabled: true, zoom: 1.0 };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      currentConfig = JSON.parse(data);
      console.log(`[Config] Loaded saved settings: Resolution=${currentConfig.resolution}, Mirror=${currentConfig.mirror}`);
    }
  } catch (err) {
    console.error(`[Config] Failed to load config: ${err.message}`);
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Config] Failed to save config: ${err.message}`);
  }
}

// Initial load
loadConfig();

function getDimensions() {
  if (!currentConfig.resolution || currentConfig.resolution === 'auto') {
    return { width: 1280, height: 720 };
  }
  const parts = currentConfig.resolution.split('x');
  if (parts.length === 2) {
    const width = parseInt(parts[0], 10);
    const height = parseInt(parts[1], 10);
    if (!isNaN(width) && !isNaN(height)) {
      return { width, height };
    }
  }
  return { width: 1280, height: 720 };
}

const ADB_HOST = '127.0.0.1';
const ADB_PORT = 8080;                 // must match Android TCP port
const RECONNECT_DELAY_MS    = 2000;   // ms between Android reconnect attempts
const PIPELINE_RESTART_DELAY_MS = 1500; // ms before restarting crashed pipeline

function buildVf(mirror, orientation, width, height, zoom) {
  const parts = [];
  const z = parseFloat(zoom || 1.0);
  if (z > 1.0) {
    parts.push(`crop=iw/${z}:ih/${z}`);
  }
  if (mirror) parts.push('hflip');
  const rot = parseInt(orientation || 0, 10);
  if (rot === 90)  parts.push('transpose=1');   // 90° CW
  else if (rot === 180) parts.push('vflip,hflip'); // 180°
  else if (rot === 270) parts.push('transpose=2'); // 90° CCW
  // KEY FIX: for 90/270, the frame flips to portrait — swap scale dimensions
  const outW = (rot === 90 || rot === 270) ? height : width;
  const outH = (rot === 90 || rot === 270) ? width  : height;
  parts.push(`scale=${outW}:${outH}`);
  return parts.join(',');
}

function getFfmpegVcamArgs(width, height, mirror, orientation, zoom) {
  const vf = buildVf(mirror, orientation, width, height, zoom);
  return [
    '-hide_banner', '-loglevel', 'info',
    '-use_wallclock_as_timestamps', '1',
    '-fflags', 'nobuffer+discardcorrupt',
    '-flags', 'low_delay',
    '-threads', '1',
    '-analyzeduration', '200000',
    '-probesize',       '200000',
    '-f', 'h264',       '-i', 'pipe:0',
    '-f', 'rawvideo',   '-pix_fmt', 'bgr24',
    '-vsync', '0',
    '-vf', vf, 'pipe:1'
  ];
}

// Web MJPEG: apply same rotation as VCam so preview matches the actual video output
function getFfmpegWebArgs(mirror, orientation, zoom) {
  // Web preview uses 640x360 base, but swap if 90/270 rotation
  const baseW = 640, baseH = 360;
  const isRotated = (orientation === 90 || orientation === 270);
  const outW = isRotated ? baseH : baseW;
  const outH = isRotated ? baseW : baseH;
  const vf = buildVf(mirror, orientation, baseW, baseH, zoom);
  return [
    '-hide_banner', '-loglevel', 'info',
    '-use_wallclock_as_timestamps', '1',
    '-fflags', 'nobuffer+discardcorrupt',
    '-flags', 'low_delay',
    '-threads', '1',
    '-analyzeduration', '200000',
    '-probesize',       '200000',
    '-f', 'h264',       '-i', 'pipe:0',
    '-f', 'mpjpeg',     '-vf', vf, '-q:v', '5', 'pipe:1'
  ];
}

const PYTHON_SCRIPT  = path.join(baseDir, 'frame_sender.py');
const PUBLIC_DIR     = path.join(__dirname, 'public');

// MIME type map for static files
const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
};

let ffmpegVcamProc          = null;
let ffmpegWebProc           = null;
let pythonProc              = null;
let recordingProc           = null;
let recordingFilePath       = null;
let tcpSocket               = null;
let isShuttingDown          = false;
let isRestarting            = false;

// ─── VCam failure circuit-breaker ────────────────────────────────────────────
let vcamFailureCount        = 0;
let vcamLastFailureTime     = 0;
let vcamDisabledForSession  = false;
const VCAM_MAX_FAILURES     = 3;       // disable after this many fast failures
const VCAM_FAILURE_WINDOW   = 15000;   // ms — failures within this window count

// ─── Stream Stats & State ────────────────────────────────────────────────────
let totalStdinBytesCumulative = 0;
let decodedFramesCount        = 0;

// ─── Web Clients list ────────────────────────────────────────────────────────
const sseClients   = new Set();
const videoClients = new Set();

/**
 * Capture and broadcast logs to Web Dashboard via Server-Sent Events (SSE).
 */
function broadcastLog(source, message) {
  const cleanMsg = message.trim();
  if (!cleanMsg) return;
  const data = JSON.stringify({ type: 'log', source, message: cleanMsg });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

/**
 * Send stream stats (health, bytes, frames) to Web Dashboard.
 */
function broadcastStatus() {
  const now = Date.now();
  if (!broadcastStatus._last) broadcastStatus._last = { bytes: 0, ts: now };
  const dt = (now - broadcastStatus._last.ts) / 1000;
  const bitrateKBs = dt > 0
    ? (totalStdinBytesCumulative - broadcastStatus._last.bytes) / 1024 / dt
    : 0;
  broadcastStatus._last = { bytes: totalStdinBytesCumulative, ts: now };

  const data = JSON.stringify({
    type: 'status',
    androidConnected: tcpSocket !== null,
    h264ReceivedBytes: totalStdinBytesCumulative,
    decodedFrames: decodedFramesCount,
    vcamActive: pythonProc !== null && !pythonProc.killed,
    bitrateKBs: Math.max(0, bitrateKBs),
    recording: recordingProc !== null,
  });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// ─── Intercept Console Outputs ───────────────────────────────────────────────
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => {
  const msg = args.join(' ');
  originalLog(msg);
  broadcastLog('node', msg);
};
console.warn = (...args) => {
  const msg = args.join(' ');
  originalWarn(msg);
  broadcastLog('node', '⚠️ ' + msg);
};
console.error = (...args) => {
  const msg = args.join(' ');
  originalError(msg);
  broadcastLog('node', '❌ ' + msg);
};

/**
 * Destroy existing pipeline processes and the TCP connection,
 * then schedule a restart.
 */
function destroyPipelineAndRestart(reason) {
  if (isShuttingDown) return;
  if (isRestarting) return;
  isRestarting = true;

  console.warn(`[Pipeline] Triggering restart due to: ${reason}`);

  // 1. Close/destroy TCP socket so Android app reconnects (gets new SPS/PPS)
  if (tcpSocket) {
    console.log('[Bridge] Closing TCP socket to force stream reset...');
    try { tcpSocket.destroy(); } catch (_) {}
    tcpSocket = null;
  }

  // 2. Kill FFmpeg VCam
  if (ffmpegVcamProc) {
    console.log('[Pipeline] Stopping FFmpeg VCam...');
    try {
      ffmpegVcamProc.removeAllListeners('exit');
      ffmpegVcamProc.kill();
    } catch (_) {}
    ffmpegVcamProc = null;
  }

  // 3. Kill FFmpeg Web
  if (ffmpegWebProc) {
    console.log('[Pipeline] Stopping FFmpeg Web...');
    try {
      ffmpegWebProc.removeAllListeners('exit');
      ffmpegWebProc.kill();
    } catch (_) {}
    ffmpegWebProc = null;
  }

  // 4. Kill Python
  if (pythonProc) {
    console.log('[Pipeline] Stopping Python frame sender...');
    try {
      pythonProc.removeAllListeners('exit');
      pythonProc.kill();
    } catch (_) {}
    pythonProc = null;
  }

  // Clear video clients since stream stopped
  for (const client of videoClients) {
    try { client.end(); } catch (_) {}
  }
  videoClients.clear();

  broadcastStatus();

  console.log(`[Pipeline] Restarting in ${PIPELINE_RESTART_DELAY_MS}ms...`);
  setTimeout(() => {
    isRestarting = false;
    spawnPipeline();
  }, PIPELINE_RESTART_DELAY_MS);
}

/**
 * Spawn FFmpeg + Python and wire stdout→stdin.
 */
function spawnPipeline() {
  if (isShuttingDown || isRestarting) return;

  console.log('[Pipeline] Starting FFmpeg + Python...');
  
  decodedFramesCount = 0;
  totalStdinBytesCumulative = 0;

  const { width, height } = getDimensions();
  const mirror      = !!currentConfig.mirror;
  const orientation = currentConfig.orientation || 0;
  const vcamEnabled = currentConfig.vcamEnabled !== false;

  // For 90/270° rotation, the VCam output frame dimensions are SWAPPED
  const pyWidth  = (orientation === 90 || orientation === 270) ? height : width;
  const pyHeight = (orientation === 90 || orientation === 270) ? width  : height;

  const zoom        = currentConfig.zoom || 1.0;

  const vcamArgs = getFfmpegVcamArgs(width, height, mirror, orientation, zoom);
  const webArgs  = getFfmpegWebArgs(mirror, orientation, zoom); // Web also applies rotation server-side

  console.log(`[Pipeline] Config: VCam=${width}x${height} → rotated output ${pyWidth}x${pyHeight}, Mirror=${mirror}, Orientation=${orientation}°, Zoom=${zoom}x, VCamEnabled=${vcamEnabled}`);

  // ── FFmpeg VCam ─────────────────────────────────────────────────────────────
  ffmpegVcamProc = spawn(FFMPEG_PATH, vcamArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  ffmpegVcamProc.on('error', (err) => {
    console.error(`[FFmpeg VCam] Failed to start: ${err.message}`);
    destroyPipelineAndRestart(`FFmpeg VCam startup failed: ${err.message}`);
  });

  // Handle stdin errors to prevent EPIPE unhandled crash
  ffmpegVcamProc.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE' && err.code !== 'EOF') {
      console.error(`[FFmpeg VCam stdin] Error: ${err.message}`);
    }
  });

  ffmpegVcamProc.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      originalLog(`[FFmpeg VCam] ${text}`);
      broadcastLog('node', `[FFmpeg VCam] ${text}`);
    }
  });

  ffmpegVcamProc.on('exit', (code) => {
    destroyPipelineAndRestart(`FFmpeg VCam exited with code ${code}`);
  });

  // ── FFmpeg Web ──────────────────────────────────────────────────────────────
  ffmpegWebProc = spawn(FFMPEG_PATH, webArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  ffmpegWebProc.on('error', (err) => {
    console.error(`[FFmpeg Web] Failed to start: ${err.message}`);
    destroyPipelineAndRestart(`FFmpeg Web startup failed: ${err.message}`);
  });

  ffmpegWebProc.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE' && err.code !== 'EOF') {
      console.error(`[FFmpeg Web stdin] Error: ${err.message}`);
    }
  });

  ffmpegWebProc.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      originalLog(`[FFmpeg Web] ${text}`);
      broadcastLog('node', `[FFmpeg Web] ${text}`);
    }
  });

  ffmpegWebProc.on('exit', (code) => {
    destroyPipelineAndRestart(`FFmpeg Web exited with code ${code}`);
  });

  // ── Python (only if vcamEnabled) ──────────────────────────────────────────
  if (vcamEnabled) {
    // Use rotated output dimensions so pyvirtualcam creates camera at correct size
    pythonProc = spawn(PYTHON_PATH, [PYTHON_SCRIPT, pyWidth.toString(), pyHeight.toString()], {
      stdio: ['pipe', 'pipe', 'inherit'] // stdout (logs) -> Node, stderr -> console
    });

    pythonProc.on('error', (err) => {
      console.error(`[Python] Failed to start: ${err.message}`);
      destroyPipelineAndRestart(`Python startup failed: ${err.message}`);
    });

    pythonProc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          originalLog(trimmed);
          broadcastLog('python', trimmed);
        }
      }
    });

    pythonProc.on('exit', (code) => {
      pythonProc = null;
      if (isShuttingDown || isRestarting) return;

      const now = Date.now();
      if (code !== 0) {
        // Check if this failure is within the fast-failure window
        if (now - vcamLastFailureTime < VCAM_FAILURE_WINDOW) {
          vcamFailureCount++;
        } else {
          vcamFailureCount = 1; // reset counter if gap was long
        }
        vcamLastFailureTime = now;

        console.warn(`[Python] ⚠️  VCam failure ${vcamFailureCount}/${VCAM_MAX_FAILURES}: exited code ${code}`);

        if (vcamFailureCount >= VCAM_MAX_FAILURES) {
          vcamDisabledForSession = true;
          currentConfig.vcamEnabled = false;
          console.error('[Python] ❌ VCam disabled for this session after repeated failures.');
          console.error('[Python]    Make sure OBS Virtual Camera is STARTED before launching the bridge.');
          console.error('[Python]    Web preview is still active. Restart the bridge to retry VCam.');
          broadcastLog('node', '❌ VCam disabled — OBS Virtual Camera not available. Web preview still running.');
          // Do NOT restart the whole pipeline — just continue without VCam
          return;
        }
      } else {
        vcamFailureCount = 0; // clean exit — reset counter
      }

      // Restart pipeline only if not at failure cap
      if (!vcamDisabledForSession) {
        destroyPipelineAndRestart(`Python exited with code ${code}`);
      }
    });
  } else {
    console.log('[Pipeline] Virtual camera disabled by user config — skipping Python.');
  }

  // Wire: ffmpeg VCam stdout → python stdin
  // frameSize uses ROTATED dimensions (pyWidth × pyHeight) since that's what FFmpeg outputs
  let totalStdoutBytes = 0;
  const frameSize = pyWidth * pyHeight * 3;
  ffmpegVcamProc.stdout.on('data', (chunk) => {
    totalStdoutBytes += chunk.length;
    if (totalStdoutBytes >= frameSize) {
      decodedFramesCount += Math.floor(totalStdoutBytes / frameSize);
      totalStdoutBytes = totalStdoutBytes % frameSize;
      broadcastStatus();
    }
    if (pythonProc && pythonProc.stdin && pythonProc.stdin.writable) {
      pythonProc.stdin.write(chunk);
    }
  });

  // Wire: ffmpeg Web stdout (mjpeg stream) → web clients
  ffmpegWebProc.stdout.on('data', (chunk) => {
    for (const res of videoClients) {
      try {
        res.write(chunk);
      } catch (_) {
        videoClients.delete(res);
      }
    }
  });

  console.log('[Pipeline] Ready — waiting for frames from Android...');

  // Connect to Android once processes are ready
  connectToAndroid();
  broadcastStatus();
}

/**
 * Connect to Android TCP server via ADB port forward.
 */
function connectToAndroid() {
  if (isShuttingDown || isRestarting) return;
  if (!ffmpegVcamProc || !ffmpegWebProc) return;
  if (tcpSocket) return; // connection attempt already in progress

  tcpSocket = new net.Socket();
  let isConnectedToAndroid = false;

  let bytesReceivedThisSec = 0;
  let intervalId = setInterval(() => {
    if (bytesReceivedThisSec > 0) {
      console.log(`[Bridge] Data flow: ${(bytesReceivedThisSec / 1024).toFixed(1)} KB/s (Total: ${(totalStdinBytesCumulative / 1024).toFixed(1)} KB)`);
      bytesReceivedThisSec = 0;
    }
  }, 1000);

  tcpSocket.connect(ADB_PORT, ADB_HOST, () => {
    tcpSocket.setNoDelay(true); // Disable Nagle's algorithm for sub-millisecond transmission latency
    console.log('[Bridge] ✓ Connected to Android stream!');
    isConnectedToAndroid = true;
    broadcastStatus();
  });

  let totalStdinBytes = 0;
  tcpSocket.on('data', (chunk) => {
    bytesReceivedThisSec += chunk.length;
    totalStdinBytes += chunk.length;
    totalStdinBytesCumulative += chunk.length;
    
    if (totalStdinBytes >= 100000) {
      broadcastLog('android', `Receiving H.264 stream... (${(totalStdinBytesCumulative / 1024).toFixed(0)} KB total)`);
      totalStdinBytes = 0;
    }
    broadcastStatus();

    // Write chunk to VCam FFmpeg
    if (ffmpegVcamProc && ffmpegVcamProc.stdin && ffmpegVcamProc.stdin.writable) {
      ffmpegVcamProc.stdin.write(chunk);
    }

    // Write chunk to Web FFmpeg
    if (ffmpegWebProc && ffmpegWebProc.stdin && ffmpegWebProc.stdin.writable) {
      ffmpegWebProc.stdin.write(chunk);
    }

    // Write chunk to Recording FFmpeg (if active)
    if (recordingProc && recordingProc.stdin && recordingProc.stdin.writable) {
      recordingProc.stdin.write(chunk);
    }
  });

  tcpSocket.on('close', () => {
    console.log('[Bridge] TCP connection closed');
    clearInterval(intervalId);
    const wasConnected = isConnectedToAndroid;
    isConnectedToAndroid = false;
    tcpSocket = null;
    broadcastStatus();
    if (!isShuttingDown && !isRestarting) {
      if (wasConnected) {
        destroyPipelineAndRestart('Android TCP socket closed');
      } else {
        setTimeout(connectToAndroid, RECONNECT_DELAY_MS);
      }
    }
  });

  tcpSocket.on('error', (err) => {
    clearInterval(intervalId);
    if (err.code === 'ECONNREFUSED') {
      process.stdout.write('\r[Bridge] Waiting for Android app to start streaming...   ');
    } else {
      console.error(`[Bridge] TCP error: ${err.message}`);
    }
  });
}

// ─── JSON body parser helper ──────────────────────────────────────────────────
function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        resolve({});
      }
    });
  });
}

// ─── Static file helper ───────────────────────────────────────────────────────
function serveStaticFile(filePath, res) {
  const ext  = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    }
  });
}

// ─── HTTP Web Server ─────────────────────────────────────────────────────────
const webServer = http.createServer((req, res) => {
  // Strip query string for routing
  const urlPath = req.url.split('?')[0];

  // ── Static Dashboard files ──────────────────────────────────────────────
  if (urlPath === '/' || urlPath === '/index.html') {
    return serveStaticFile(path.join(PUBLIC_DIR, 'index.html'), res);
  }

  // Serve css/, js/ sub-paths directly
  if (urlPath.startsWith('/css/') || urlPath.startsWith('/js/')) {
    const safePath = path.join(PUBLIC_DIR, urlPath);
    // Prevent directory traversal
    if (!safePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    return serveStaticFile(safePath, res);
  }

  // ── API: config (GET / POST) ────────────────────────────────────────────
  if (urlPath === '/api/config') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(currentConfig));
    }
    if (req.method === 'POST') {
      return parseJsonBody(req).then(body => {
        if (body.resolution !== undefined) {
          currentConfig.resolution  = body.resolution;
          currentConfig.mirror      = !!body.mirror;
          currentConfig.orientation = parseInt(body.orientation || 0, 10);
          currentConfig.vcamEnabled = body.vcamEnabled !== false;
          currentConfig.zoom        = parseFloat(body.zoom || 1.0);
          currentConfig.brightness  = parseFloat(body.brightness  != null ? body.brightness  : 0.0);
          currentConfig.contrast    = parseFloat(body.contrast    != null ? body.contrast    : 1.0);
          currentConfig.saturation  = parseFloat(body.saturation  != null ? body.saturation  : 1.0);
          currentConfig.sharpness   = parseFloat(body.sharpness   != null ? body.sharpness   : 0.0);
          currentConfig.targetFps   = parseInt(body.targetFps     != null ? body.targetFps   : 30, 10);
          saveConfig(currentConfig);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          destroyPipelineAndRestart(
            `Config updated: res=${body.resolution}, mirror=${body.mirror}, orientation=${body.orientation}°, vcam=${body.vcamEnabled}, zoom=${body.zoom}x`
          );
        } else {
          res.writeHead(400); res.end('Invalid request');
        }
      });
    }
  }

  // ── API: manual reconnect ───────────────────────────────────────────────
  if (urlPath === '/api/reconnect' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    destroyPipelineAndRestart('Manual reconnect requested by user');
    return;
  }

  // ── API: recording start/stop ────────────────────────────────────────────
  if (urlPath === '/api/record/start' && req.method === 'POST') {
    if (recordingProc) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Already recording', file: recordingFilePath }));
    }
    if (!tcpSocket) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No active stream to record' }));
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    recordingFilePath = path.join(baseDir, `recording-${ts}.mp4`);
    recordingProc = spawn(FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'warning',
      '-f', 'h264', '-i', 'pipe:0',
      '-c:v', 'copy',
      '-movflags', '+faststart',
      recordingFilePath
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    recordingProc.stderr.on('data', d => broadcastLog('node', `[Record] ${d.toString().trim()}`));
    recordingProc.on('error', err => {
      console.error(`[Record] Failed: ${err.message}`);
      recordingProc = null; recordingFilePath = null;
    });
    recordingProc.on('exit', () => {
      console.log(`[Record] Stopped. File: ${recordingFilePath}`);
      broadcastStatus();
      recordingProc = null;
    });
    console.log(`[Record] Started → ${recordingFilePath}`);
    broadcastStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, file: recordingFilePath }));
  }

  if (urlPath === '/api/record/stop' && req.method === 'POST') {
    if (!recordingProc) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not recording' }));
    }
    const savedFile = recordingFilePath;
    try { recordingProc.stdin.end(); } catch (_) {}
    try { recordingProc.kill('SIGINT'); } catch (_) {}
    recordingProc = null; recordingFilePath = null;
    broadcastStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, file: savedFile }));
  }

  if (urlPath === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      androidConnected: tcpSocket !== null,
      vcamActive: pythonProc !== null && !pythonProc.killed,
      recording: recordingProc !== null,
      recordingFile: recordingFilePath,
      decodedFrames: decodedFramesCount,
      h264ReceivedBytes: totalStdinBytesCumulative,
      config: currentConfig,
    }));
  }

  // ── MJPEG video feed ────────────────────────────────────────────────────
  if (urlPath.startsWith('/video_feed')) {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Pragma': 'no-cache'
    });
    videoClients.add(res);
    req.on('close', () => videoClients.delete(res));
    return;
  }

  // ── SSE log stream ──────────────────────────────────────────────────────
  if (urlPath === '/logs') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    sseClients.add(res);
    // Send initial status immediately
    const initData = JSON.stringify({
      type: 'status',
      androidConnected: tcpSocket !== null,
      h264ReceivedBytes: totalStdinBytesCumulative,
      decodedFrames: decodedFramesCount,
      vcamActive: pythonProc !== null && !pythonProc.killed,
      bitrateKBs: 0,
    });
    res.write(`data: ${initData}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

webServer.listen(3000, '0.0.0.0', () => {
  originalLog('=== USB Webcam Bridge (Windows) ===');
  originalLog('Dashboard available at: http://localhost:3000');
  originalLog(`  - baseDir: ${baseDir}`);
  originalLog(`  - FFmpeg:  ${FFMPEG_PATH}`);
  originalLog(`  - Python:  ${PYTHON_PATH}`);
  originalLog(`  - Script:  ${PYTHON_SCRIPT}`);
  originalLog(`  - Config:  ${CONFIG_PATH}`);
  originalLog('');
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown() {
  console.log('[Bridge] Shutting down...');
  isShuttingDown = true;
  try { tcpSocket?.destroy(); }  catch (_) {}
  try { ffmpegVcamProc?.kill(); } catch (_) {}
  try { ffmpegWebProc?.kill(); }  catch (_) {}
  try { pythonProc?.kill(); }     catch (_) {}
  try { webServer.close(); }     catch (_) {}
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
// ─────────────────────────────────────────────────────────────────────────────

// Start the pipeline
spawnPipeline();
// ─────────────────────────────────────────────────────────────────────────────
