/**
 * stream.js — Video feed, SSE status, FPS tracking, orientation CSS,
 *             snapshot, fullscreen, PiP, recording, sparkline chart.
 */
const Stream = (() => {
  const el = {
    statusDot:     () => document.getElementById('status-dot'),
    statusText:    () => document.getElementById('status-text'),
    feedImg:       () => document.getElementById('feed-img'),
    feedWrapper:   () => document.getElementById('feed-img-wrapper'),
    feedPH:        () => document.getElementById('feed-placeholder'),
    feedOverlay:   () => document.getElementById('feed-overlay'),
    overlayFps:    () => document.getElementById('overlay-fps'),
    feedBadge:     () => document.getElementById('feed-badge'),
    feedContainer: () => document.getElementById('feed-container'),
    hdrH264:       () => document.getElementById('hdr-h264'),
    hdrFrames:     () => document.getElementById('hdr-frames'),
    hdrFps:        () => document.getElementById('hdr-fps'),
    healthSignal:  () => document.getElementById('health-signal'),
    healthBitrate: () => document.getElementById('health-bitrate'),
    healthVcam:    () => document.getElementById('health-vcam'),
    healthRec:     () => document.getElementById('health-rec'),
    recIndicator:  () => document.getElementById('rec-indicator'),
    btnRecord:     () => document.getElementById('btn-record'),
    recordDot:     () => document.getElementById('record-dot'),
    recordLabel:   () => document.getElementById('record-label'),
    sparkline:     () => document.getElementById('fps-sparkline'),
  };

  let prevDecodedFrames = 0;
  let prevTimestamp = Date.now();
  let fpsHistory = [];
  let isFullscreen = false;
  let isRecording = false;
  let currentOrientation = 0;
  let wasAndroidConnected = false;
  let _feedReloadTimer = null;   // periodic keepalive timer
  let _feedRetryTimer = null;    // retry-on-error timer

  // ── Sparkline ────────────────────────────────────────────────────────────
  function drawSparkline() {
    const canvas = el.sparkline();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (fpsHistory.length < 2) return;

    const max = Math.max(30, ...fpsHistory);
    const step = W / (fpsHistory.length - 1);

    // Fill
    ctx.beginPath();
    ctx.moveTo(0, H);
    fpsHistory.forEach((fps, i) => {
      const x = i * step;
      const y = H - (fps / max) * H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(W, H);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(6,182,212,0.35)');
    grad.addColorStop(1, 'rgba(6,182,212,0.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    fpsHistory.forEach((fps, i) => {
      const x = i * step;
      const y = H - (fps / max) * H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // ── Orientation — server-side rotation ──────────────────────────────────────
  // NOTE: rotation is now applied server-side by FFmpeg.
  // This function just stores the current orientation value for reference.
  // No CSS transform rotation needed since the MJPEG stream itself is already rotated.
  function setOrientation(deg) {
    currentOrientation = parseInt(deg, 10) || 0;
    const img = el.feedImg();
    if (!img) return;
    // Remove any leftover rotation classes from old CSS-only approach
    img.classList.remove('rot-0', 'rot-90', 'rot-180', 'rot-270');
    // Reset transform — server handles rotation now
    img.style.transform = '';
    img.style.removeProperty('--rot-scale');
  }

  /** Force-reload the MJPEG feed URL so the browser opens a fresh connection. */
  function _reloadFeed() {
    const img = el.feedImg();
    if (!img) return;
    img.src = '/video_feed?' + Date.now();
  }

  /** Start periodic keepalive reload every 30 s to recover from silent stalls. */
  function _startFeedKeepalive() {
    _stopFeedKeepalive();
    _feedReloadTimer = setInterval(_reloadFeed, 30000);
  }

  function _stopFeedKeepalive() {
    if (_feedReloadTimer) { clearInterval(_feedReloadTimer); _feedReloadTimer = null; }
    if (_feedRetryTimer)  { clearTimeout(_feedRetryTimer);   _feedRetryTimer  = null; }
  }

  // ── Status updates ────────────────────────────────────────────────────────
  function setStatus(state, text) {
    const dot = el.statusDot(), txt = el.statusText();
    if (dot) dot.className = 'status-dot ' + state;
    if (txt) txt.textContent = text;
  }

  function handleStatus(data) {
    const now = Date.now();
    const img  = el.feedImg();
    const ph   = el.feedPH();
    const ov   = el.feedOverlay();
    const badge = el.feedBadge();

    const isConn = !!data.androidConnected;
    const connTransitioned = isConn && !wasAndroidConnected;
    wasAndroidConnected = isConn;

    if (isConn) {
      setStatus('connected', 'Streaming Active');
      if (img) {
        img.style.display = 'block';
        // Always reload the feed on reconnect so the browser opens a fresh
        // HTTP connection to the new pipeline's MJPEG stream.
        if (connTransitioned) {
          _reloadFeed();
          _startFeedKeepalive();
          // Wire up onerror so a stale/dropped stream auto-retries
          img.onerror = () => {
            if (wasAndroidConnected) {
              if (_feedRetryTimer) clearTimeout(_feedRetryTimer);
              _feedRetryTimer = setTimeout(_reloadFeed, 1500);
            }
          };
        }
      }
      if (ph)    ph.style.display  = 'none';
      if (ov)    ov.style.display  = 'block';
      if (badge) { badge.textContent = 'LIVE'; badge.className = 'card-badge live'; }
    } else {
      setStatus('connecting', 'Waiting for Stream');
      _stopFeedKeepalive();
      if (img)   { img.style.display = 'none'; if (img.onerror) img.onerror = null; }
      if (ph)    ph.style.display  = 'flex';
      if (ov)    ov.style.display  = 'none';
      if (badge) { badge.textContent = 'OFFLINE'; badge.className = 'card-badge'; }
    }

    // H.264 bytes
    if (data.h264ReceivedBytes !== undefined) {
      const kb = data.h264ReceivedBytes / 1024;
      const hdr = el.hdrH264();
      if (hdr) hdr.textContent = kb > 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB';
    }

    // Decoded frames + FPS
    if (data.decodedFrames !== undefined) {
      const hf = el.hdrFrames();
      if (hf) hf.textContent = data.decodedFrames;

      const dt = (now - prevTimestamp) / 1000;
      if (dt >= 0.5) {
        const fps = Math.round((data.decodedFrames - prevDecodedFrames) / dt);
        prevDecodedFrames = data.decodedFrames;
        prevTimestamp = now;

        if (fps >= 0) {
          fpsHistory.push(fps);
          if (fpsHistory.length > 30) fpsHistory.shift();
          const avgFps = Math.round(fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length);
          const hdrFps = el.hdrFps();
          if (hdrFps) hdrFps.textContent = avgFps;
          const oFps = el.overlayFps();
          if (oFps) oFps.textContent = avgFps + ' fps';
          drawSparkline();

          // Signal bar (30fps = 100%)
          const sig = el.healthSignal();
          if (sig) sig.style.width = Math.min(100, (avgFps / 30) * 100) + '%';
        }
      }
    }

    // Bitrate
    if (data.bitrateKBs !== undefined) {
      const hb = el.healthBitrate();
      if (hb) hb.textContent = data.bitrateKBs.toFixed(1) + ' KB/s';
    }

    // VCam
    if (data.vcamActive !== undefined) {
      const hv = el.healthVcam();
      if (hv) {
        hv.textContent = data.vcamActive ? 'ON' : 'OFF';
        hv.style.color = data.vcamActive ? 'var(--accent-emerald)' : 'var(--accent-rose)';
      }
    }

    // Recording indicator
    if (data.recording !== undefined) {
      _setRecordingUI(data.recording);
    }
  }

  // ── Recording ─────────────────────────────────────────────────────────────
  function _setRecordingUI(active) {
    isRecording = active;
    const btn   = el.btnRecord();
    const dot   = el.recordDot();
    const label = el.recordLabel();
    const ind   = el.recIndicator();
    const hr    = el.healthRec();

    if (btn)   btn.classList.toggle('recording', active);
    if (dot)   dot.classList.toggle('active', active);
    if (label) label.textContent = active ? 'Stop Rec' : 'Record';
    if (ind)   ind.style.display = active ? 'flex' : 'none';
    if (hr)    { hr.textContent = active ? 'REC' : 'IDLE'; hr.style.color = active ? 'var(--accent-red)' : 'var(--text-muted)'; }
  }

  async function toggleRecording() {
    try {
      if (!isRecording) {
        const res = await fetch('/api/record/start', { method: 'POST' });
        const json = await res.json();
        if (res.ok) {
          Terminal.addLine('system', `✓ Recording started → ${json.file}`);
          _setRecordingUI(true);
        } else {
          Terminal.addLine('system', `⚠️ Record start failed: ${json.error}`);
        }
      } else {
        const res = await fetch('/api/record/stop', { method: 'POST' });
        const json = await res.json();
        if (res.ok) {
          Terminal.addLine('system', `✓ Recording stopped. Saved: ${json.file}`);
          _setRecordingUI(false);
        } else {
          Terminal.addLine('system', `⚠️ Record stop failed: ${json.error}`);
        }
      }
    } catch (err) {
      Terminal.addLine('system', `Recording error: ${err.message}`);
    }
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────
  async function reconnect() {
    Terminal.addLine('system', 'Requesting pipeline reconnect...');
    setStatus('connecting', 'Reconnecting…');
    try {
      const res = await fetch('/api/reconnect', { method: 'POST' });
      if (res.ok) Terminal.addLine('system', '✓ Reconnect command sent.');
      else        Terminal.addLine('system', `Reconnect failed: ${res.statusText}`);
    } catch (err) {
      Terminal.addLine('system', `Reconnect error: ${err.message}`);
    }
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────
  function snapshot() {
    const img = el.feedImg();
    if (!img || img.style.display === 'none') {
      Terminal.addLine('system', '⚠️ No active stream to snapshot.'); return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth  || 640;
      canvas.height = img.naturalHeight || 360;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const link = document.createElement('a');
      link.download = `snapshot-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      Terminal.addLine('system', '✓ Snapshot saved.');
    } catch (err) {
      Terminal.addLine('system', `Snapshot error: ${err.message}`);
    }
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────
  function toggleFullscreen() {
    const container = el.feedContainer();
    if (!container) return;
    isFullscreen = !isFullscreen;
    container.classList.toggle('fullscreen-mode', isFullscreen);
    if (isFullscreen) {
      document.addEventListener('keydown', _escapeFullscreen);
      Terminal.addLine('system', 'Fullscreen enabled. Press Esc to exit.');
    } else {
      document.removeEventListener('keydown', _escapeFullscreen);
    }
    // Force image reload to fill new viewport dimensions
    const img = el.feedImg();
    if (img && img.style.display !== 'none') {
      setTimeout(() => { img.src = img.src; }, 100);
    }
  }
  function _escapeFullscreen(e) { if (e.key === 'Escape') toggleFullscreen(); }

  // ── Picture in Picture ────────────────────────────────────────────────────
  async function togglePiP() {
    const img = el.feedImg();
    if (!img || img.style.display === 'none') {
      Terminal.addLine('system', '⚠️ PiP requires an active stream.'); return;
    }

    // Use a hidden <video> element fed via MediaStream from canvas
    try {
      const video = document.getElementById('pip-video');
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        Terminal.addLine('system', '✓ Exited PiP.');
        return;
      }

      // Draw feed-img frames into a canvas → MediaStream → video → PiP
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let animId;
      function drawFrame() {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        animId = requestAnimationFrame(drawFrame);
      }
      drawFrame();

      const stream = canvas.captureStream(30);
      video.srcObject = stream;
      await video.play();
      await video.requestPictureInPicture();
      Terminal.addLine('system', '✓ PiP activated. Click the video to return.');

      video.addEventListener('leavepictureinpicture', () => {
        cancelAnimationFrame(animId);
        video.srcObject = null;
      }, { once: true });
    } catch (err) {
      Terminal.addLine('system', `PiP error: ${err.message}`);
    }
  }

  return { setStatus, handleStatus, setOrientation, reconnect, snapshot, toggleFullscreen, togglePiP, toggleRecording };
})();
