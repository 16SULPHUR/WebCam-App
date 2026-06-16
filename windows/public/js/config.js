/**
 * config.js — Load / save config via REST API
 *
 * Handles all settings: resolution, mirror, orientation, zoom,
 * and the new video-processing controls (brightness, contrast,
 * saturation, sharpness, targetFps).
 */
const Config = (() => {
  // ── Helpers ──────────────────────────────────────────────────────────────

  let _loading = false;  // suppress spurious saves while load() applies slider values

  function el(id) { return document.getElementById(id); }

  function setSlider(id, val) {
    const input = el(id);
    if (input) input.value = val;
  }

  function setSliderLabel(labelId, val, suffix) {
    const span = el(labelId);
    if (span) span.textContent = parseFloat(val).toFixed(2).replace(/\.?0+$/, function(s) {
      // keep at least one decimal place
      return s === '.00' ? '.0' : s.length > 1 ? '.' + s.slice(1, 2) : s;
    }) + (suffix || '');
  }

  // ── Load ─────────────────────────────────────────────────────────────────

  async function load() {
    _loading = true;
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(res.statusText);
      const cfg = await res.json();

      // Basic controls
      if (el('resolution-select')) el('resolution-select').value = cfg.resolution || 'auto';
      if (el('mirror-checkbox'))   el('mirror-checkbox').checked  = !!cfg.mirror;
      if (el('orientation-select')) el('orientation-select').value = String(cfg.orientation ?? 0);
      if (el('vcam-checkbox'))     el('vcam-checkbox').checked    = cfg.vcamEnabled !== false;

      const zoom = cfg.zoom ?? 1.0;
      if (el('zoom-select')) el('zoom-select').value = zoom;
      if (el('zoom-val'))    el('zoom-val').textContent = parseFloat(zoom).toFixed(1) + 'x';

      // Video processing controls
      _applyProcessingToUI(cfg);

      // Apply orientation (server-side now, no CSS)
      Stream.setOrientation(cfg.orientation || 0);

      // Synchronize controller elements
      _syncUIFromStandard();

      console.log(`Config loaded: res=${cfg.resolution}, mirror=${cfg.mirror}, ori=${cfg.orientation}°, zoom=${zoom}x`);
    } catch (err) {
      console.error(`Failed to load config: ${err.message}`);
    } finally {
      _loading = false;
    }
  }

  function _applyProcessingToUI(cfg) {
    const brightness = cfg.brightness ?? 0.0;
    const contrast   = cfg.contrast   ?? 1.0;
    const saturation = cfg.saturation ?? 1.0;
    const sharpness  = cfg.sharpness  ?? 0.0;
    const blur       = cfg.blur       ?? 0;
    const targetFps  = cfg.targetFps  ?? 30;

    setSlider('brightness-range', brightness);
    setSlider('controller-brightness-range', brightness);
    setSlider('contrast-range',   contrast);
    setSlider('controller-contrast-range',   contrast);
    setSlider('saturation-range', saturation);
    setSlider('controller-saturation-range', saturation);
    setSlider('sharpness-range',  sharpness);
    setSlider('controller-sharpness-range',  sharpness);
    setSlider('blur-range',       blur);
    setSlider('controller-blur-range',       blur);
    if (el('fps-select')) el('fps-select').value = String(targetFps);

    const bText = parseFloat(brightness).toFixed(2);
    if (el('brightness-val')) el('brightness-val').textContent = bText;
    if (el('controller-brightness-val')) el('controller-brightness-val').textContent = bText;

    const cText = parseFloat(contrast).toFixed(2);
    if (el('contrast-val')) el('contrast-val').textContent = cText;
    if (el('controller-contrast-val')) el('controller-contrast-val').textContent = cText;

    const sText = parseFloat(saturation).toFixed(2);
    if (el('saturation-val')) el('saturation-val').textContent = sText;
    if (el('controller-saturation-val')) el('controller-saturation-val').textContent = sText;

    const shText = parseFloat(sharpness).toFixed(1);
    if (el('sharpness-val')) el('sharpness-val').textContent = shText;
    if (el('controller-sharpness-val')) el('controller-sharpness-val').textContent = shText;

    const blText = parseInt(blur) === 0 ? 'Off' : parseInt(blur) + 'px';
    if (el('blur-val')) el('blur-val').textContent = blText;
    if (el('controller-blur-val')) el('controller-blur-val').textContent = blText;
  }

  // ── Sync Helper ──────────────────────────────────────────────────────────
  function _updateZoomKnob(val) {
    const zoomVal = parseFloat(val) || 1.0;
    const minZoom = 1.0, maxZoom = 3.0;
    const minAngle = -135, maxAngle = 135;
    const angle = minAngle + ((zoomVal - minZoom) / (maxZoom - minZoom)) * (maxAngle - minAngle);
    const knob = el('zoom-rotary-knob');
    if (knob) {
      knob.style.transform = `rotate(${angle}deg)`;
    }
  }

  function _updateLEDs() {
    const mirrorActive = el('mirror-checkbox')?.checked || el('controller-mirror-checkbox')?.checked || false;
    const vcamActive   = el('vcam-checkbox')?.checked   || el('controller-vcam-checkbox')?.checked   || false;

    const ledMirror = el('led-mirror');
    if (ledMirror) {
      ledMirror.classList.toggle('active', mirrorActive);
    }
    const ledVcam = el('led-vcam');
    if (ledVcam) {
      ledVcam.classList.toggle('active', vcamActive);
    }
  }

  function _syncUIFromStandard() {
    // Sync checkboxes
    const mirrorVal = !!el('mirror-checkbox')?.checked;
    const vcamVal   = el('vcam-checkbox')?.checked !== false;

    if (el('controller-mirror-checkbox')) el('controller-mirror-checkbox').checked = mirrorVal;
    if (el('controller-vcam-checkbox'))   el('controller-vcam-checkbox').checked = vcamVal;

    // Sync orientation
    const oriVal = el('orientation-select')?.value || '0';
    if (el('controller-orientation-select')) el('controller-orientation-select').value = oriVal;

    // Sync Zoom
    const zoomVal = el('zoom-select')?.value || '1.0';
    if (el('controller-zoom-select')) el('controller-zoom-select').value = zoomVal;
    const ztxt = parseFloat(zoomVal).toFixed(1) + 'x';
    if (el('controller-zoom-val')) el('controller-zoom-val').textContent = ztxt;
    _updateZoomKnob(zoomVal);

    _updateLEDs();
  }

  // ── Orientation ───────────────────────────────────────────────────────────

  function onOrientationChange() {
    const deg = parseInt(el('orientation-select')?.value || 0, 10);
    if (el('controller-orientation-select')) el('controller-orientation-select').value = String(deg);
    Stream.setOrientation(deg);
    update();
  }

  function onOrientationChangeFromController() {
    const deg = parseInt(el('controller-orientation-select')?.value || 0, 10);
    if (el('orientation-select')) el('orientation-select').value = String(deg);
    Stream.setOrientation(deg);
    update();
  }

  // ── Zoom ─────────────────────────────────────────────────────────────────

  let zoomTimeout = null;

  function onZoomChange(val) {
    if (el('zoom-select')) el('zoom-select').value = val;
    if (el('controller-zoom-select')) el('controller-zoom-select').value = val;

    const txt = parseFloat(val).toFixed(1) + 'x';
    if (el('zoom-val')) el('zoom-val').textContent = txt;
    if (el('controller-zoom-val')) el('controller-zoom-val').textContent = txt;

    _updateZoomKnob(val);

    if (_loading) return;  // suppress saves during initial load
    clearTimeout(zoomTimeout);
    zoomTimeout = setTimeout(update, 800);
  }

  // ── Video Processing ──────────────────────────────────────────────────────

  let processingTimeout = null;

  function onProcessingChange() {
    const active = document.activeElement;
    let b, c, s, sh, bl;
    if (active && active.id && active.id.startsWith('controller-')) {
      // Read from controller
      b = el('controller-brightness-range')?.value ?? 0;
      c = el('controller-contrast-range')?.value   ?? 1;
      s = el('controller-saturation-range')?.value ?? 1;
      sh = el('controller-sharpness-range')?.value ?? 0;
      bl = el('controller-blur-range')?.value      ?? 0;

      // Sync to standard
      setSlider('brightness-range', b);
      setSlider('contrast-range',   c);
      setSlider('saturation-range', s);
      setSlider('sharpness-range',  sh);
      setSlider('blur-range',       bl);
    } else {
      // Read from standard
      b = el('brightness-range')?.value ?? 0;
      c = el('contrast-range')?.value   ?? 1;
      s = el('saturation-range')?.value ?? 1;
      sh = el('sharpness-range')?.value ?? 0;
      bl = el('blur-range')?.value      ?? 0;

      // Sync to controller
      setSlider('controller-brightness-range', b);
      setSlider('controller-contrast-range',   c);
      setSlider('controller-saturation-range', s);
      setSlider('controller-sharpness-range',  sh);
      setSlider('controller-blur-range',       bl);
    }

    // Update labels
    const bText = parseFloat(b).toFixed(2);
    if (el('brightness-val')) el('brightness-val').textContent = bText;
    if (el('controller-brightness-val')) el('controller-brightness-val').textContent = bText;

    const cText = parseFloat(c).toFixed(2);
    if (el('contrast-val')) el('contrast-val').textContent = cText;
    if (el('controller-contrast-val')) el('controller-contrast-val').textContent = cText;

    const sText = parseFloat(s).toFixed(2);
    if (el('saturation-val')) el('saturation-val').textContent = sText;
    if (el('controller-saturation-val')) el('controller-saturation-val').textContent = sText;

    const shText = parseFloat(sh).toFixed(1);
    if (el('sharpness-val')) el('sharpness-val').textContent = shText;
    if (el('controller-sharpness-val')) el('controller-sharpness-val').textContent = shText;

    const blText = parseInt(bl) === 0 ? 'Off' : parseInt(bl) + 'px';
    if (el('blur-val')) el('blur-val').textContent = blText;
    if (el('controller-blur-val')) el('controller-blur-val').textContent = blText;

    if (_loading) return;  // suppress saves during initial load

    // Debounce API call (avoid rapid pipeline restarts while dragging)
    clearTimeout(processingTimeout);
    processingTimeout = setTimeout(update, 1000);
  }

  function resetProcessing() {
    if (el('brightness-range')) el('brightness-range').value = 0.0;
    if (el('controller-brightness-range')) el('controller-brightness-range').value = 0.0;
    if (el('contrast-range'))   el('contrast-range').value   = 1.0;
    if (el('controller-contrast-range'))   el('controller-contrast-range').value   = 1.0;
    if (el('saturation-range')) el('saturation-range').value = 1.0;
    if (el('controller-saturation-range')) el('controller-saturation-range').value = 1.0;
    if (el('sharpness-range'))  el('sharpness-range').value  = 0.0;
    if (el('controller-sharpness-range'))  el('controller-sharpness-range').value  = 0.0;
    if (el('blur-range'))       el('blur-range').value       = 0;
    if (el('controller-blur-range'))       el('controller-blur-range').value       = 0;
    if (el('fps-select'))       el('fps-select').value       = '30';

    if (el('brightness-val')) el('brightness-val').textContent = '0.00';
    if (el('controller-brightness-val')) el('controller-brightness-val').textContent = '0.00';
    if (el('contrast-val'))   el('contrast-val').textContent   = '1.00';
    if (el('controller-contrast-val'))   el('controller-contrast-val').textContent   = '1.00';
    if (el('saturation-val')) el('saturation-val').textContent = '1.00';
    if (el('controller-saturation-val')) el('controller-saturation-val').textContent = '1.00';
    if (el('sharpness-val'))  el('sharpness-val').textContent  = '0.0';
    if (el('controller-sharpness-val'))  el('controller-sharpness-val').textContent  = '0.0';
    if (el('blur-val'))       el('blur-val').textContent       = 'Off';
    if (el('controller-blur-val'))       el('controller-blur-val').textContent       = 'Off';

    console.log('Processing reset to defaults - applying...');
    update();
  }

  function resetSingle(param) {
    let defaultVal;
    if (param === 'brightness') defaultVal = 0.0;
    else if (param === 'contrast') defaultVal = 1.0;
    else if (param === 'saturation') defaultVal = 1.0;
    else if (param === 'sharpness') defaultVal = 0.0;
    else if (param === 'blur') defaultVal = 0;

    // Reset standard and controller slider to default
    if (el(`${param}-range`)) el(`${param}-range`).value = defaultVal;
    if (el(`controller-${param}-range`)) el(`controller-${param}-range`).value = defaultVal;

    // Update labels
    const bText = param === 'sharpness' ? parseFloat(defaultVal).toFixed(1) : (param === 'blur' ? (parseInt(defaultVal) === 0 ? 'Off' : defaultVal + 'px') : parseFloat(defaultVal).toFixed(2));
    if (el(`${param}-val`)) el(`${param}-val`).textContent = bText;
    if (el(`controller-${param}-val`)) el(`controller-${param}-val`).textContent = bText;

    console.log(`Reset ${param} to ${defaultVal}`);
    update();
  }

  function updateFromController() {
    const mirrorVal = !!el('controller-mirror-checkbox')?.checked;
    const vcamVal   = el('controller-vcam-checkbox')?.checked !== false;

    if (el('mirror-checkbox')) el('mirror-checkbox').checked = mirrorVal;
    if (el('vcam-checkbox'))   el('vcam-checkbox').checked = vcamVal;

    _updateLEDs();
    update();
  }

  // ── Save / Update ─────────────────────────────────────────────────────────

  async function update() {
    _syncUIFromStandard();

    const payload = {
      resolution:  el('resolution-select')?.value            || 'auto',
      mirror:      el('mirror-checkbox')?.checked            || false,
      orientation: Number(el('orientation-select')?.value    || 0),
      vcamEnabled: el('vcam-checkbox')?.checked              !== false,
      zoom:        parseFloat(el('zoom-select')?.value       || 1.0),
      // Video processing
      brightness:  parseFloat(el('brightness-range')?.value || 0.0),
      contrast:    parseFloat(el('contrast-range')?.value   || 1.0),
      saturation:  parseFloat(el('saturation-range')?.value || 1.0),
      sharpness:   parseFloat(el('sharpness-range')?.value  || 0.0),
      blur:        parseInt(el('blur-range')?.value         || 0, 10),
      targetFps:   parseInt(el('fps-select')?.value         || 30, 10),
    };

    console.log(
      `Saving config: res=${payload.resolution}, mirror=${payload.mirror}, ` +
      `ori=${payload.orientation}°, zoom=${payload.zoom}x, fps=${payload.targetFps}, blur=${payload.blur}px`
    );

    try {
      const res = await fetch('/api/config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.restarted) {
          Toast.show('✓ Resolution/FPS changed. Restarting pipeline...', 'info');
          setTimeout(() => {
            const img = document.getElementById('feed-img');
            if (img && img.style.display !== 'none') {
              img.src = '/video_feed?' + Date.now();
            }
          }, 2500);
        } else {
          Toast.show('✓ Settings applied dynamically.', 'success');
        }
      } else {
        const errJson = await res.json().catch(() => ({}));
        Toast.show(`⚠️ Config save failed: ${errJson.error || res.statusText}`, 'error');
      }
    } catch (err) {
      Toast.show(`Config error: ${err.message}`, 'error');
    }
  }

  return { load, update, onOrientationChange, onZoomChange, onProcessingChange, resetProcessing, resetSingle, updateFromController, onOrientationChangeFromController };
})();

