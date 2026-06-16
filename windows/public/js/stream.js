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
    feedContainer: () => {
      if (document.body.classList.contains('controller-mode-active')) {
        return document.getElementById('controller-preview-box');
      }
      return document.getElementById('feed-container');
    },
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
  function setOrientation(deg) {
    currentOrientation = parseInt(deg, 10) || 0;
    const img = el.feedImg();
    if (!img) return;
    img.classList.remove('rot-0', 'rot-90', 'rot-180', 'rot-270');
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
        if (connTransitioned) {
          _reloadFeed();
          _startFeedKeepalive();
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

    // Sync mobile controller recording UI
    const ctrlBtn = document.getElementById('controller-btn-record');
    const ctrlLed = document.getElementById('led-record');
    if (ctrlBtn) ctrlBtn.classList.toggle('active', active);
    if (ctrlLed) ctrlLed.classList.toggle('active', active);
  }

  async function toggleRecording() {
    try {
      if (!isRecording) {
        const res = await fetch('/api/record/start', { method: 'POST' });
        const json = await res.json();
        if (res.ok) {
          Toast.show(`✓ Recording started → ${json.file}`, 'success');
          _setRecordingUI(true);
        } else {
          Toast.show(`⚠️ Record start failed: ${json.error}`, 'error');
        }
      } else {
        const res = await fetch('/api/record/stop', { method: 'POST' });
        const json = await res.json();
        if (res.ok) {
          Toast.show(`✓ Recording stopped. Saved: ${json.file}`, 'success');
          _setRecordingUI(false);
        } else {
          Toast.show(`⚠️ Record stop failed: ${json.error}`, 'error');
        }
      }
    } catch (err) {
      Toast.show(`Recording error: ${err.message}`, 'error');
    }
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────
  async function reconnect() {
    Toast.show('Requesting pipeline reconnect...');
    setStatus('connecting', 'Reconnecting…');
    try {
      const res = await fetch('/api/reconnect', { method: 'POST' });
      if (res.ok) Toast.show('✓ Reconnect command sent.', 'success');
      else        Toast.show(`Reconnect failed: ${res.statusText}`, 'error');
    } catch (err) {
      Toast.show(`Reconnect error: ${err.message}`, 'error');
    }
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────
  function snapshot() {
    const img = el.feedImg();
    if (!img || img.style.display === 'none') {
      Toast.show('⚠️ No active stream to snapshot.', 'error'); return;
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
      Toast.show('✓ Snapshot saved.', 'success');
    } catch (err) {
      Toast.show(`Snapshot error: ${err.message}`, 'error');
    }
  }

  // ── Fullscreen (Native HTML5 API) ─────────────────────────────────────────
  async function toggleFullscreen() {
    const container = el.feedContainer();
    if (!container) return;
    try {
      if (!document.fullscreenElement) {
        if (container.requestFullscreen) {
          await container.requestFullscreen();
        } else if (container.webkitRequestFullscreen) {
          await container.webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch (err) {
      console.error('Fullscreen error:', err);
      Toast.show(`Fullscreen error: ${err.message}`, 'error');
    }
  }

  // Listen to fullscreen changes to update class and UI state
  document.addEventListener('fullscreenchange', () => {
    isFullscreen = !!document.fullscreenElement;
    const container = el.feedContainer();
    if (container) {
      container.classList.toggle('fullscreen-mode', isFullscreen);
    }
  });

  // ── Picture in Picture ────────────────────────────────────────────────────
  async function togglePiP() {
    const img = el.feedImg();
    if (!img || img.style.display === 'none') {
      Toast.show('⚠️ PiP requires an active stream.', 'error'); return;
    }

    try {
      const video = document.getElementById('pip-video');
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        Toast.show('✓ Exited PiP.', 'success');
        return;
      }

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
      Toast.show('✓ PiP activated.', 'success');

      video.addEventListener('leavepictureinpicture', () => {
        cancelAnimationFrame(animId);
        video.srcObject = null;
      }, { once: true });
    } catch (err) {
      Toast.show(`PiP error: ${err.message}`, 'error');
    }
  }

  return { setStatus, handleStatus, setOrientation, reconnect, snapshot, toggleFullscreen, togglePiP, toggleRecording };
})();
