/**
 * config.js — Load / save config via REST API
 *
 * Handles all settings: resolution, mirror, orientation, zoom,
 * and the new video-processing controls (brightness, contrast,
 * saturation, sharpness, targetFps).
 */
const Config = (() => {
  // ── Helpers ──────────────────────────────────────────────────────────────

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

      Terminal.addLine('system', `Config loaded: res=${cfg.resolution}, mirror=${cfg.mirror}, ori=${cfg.orientation}°, zoom=${zoom}x`);
    } catch (err) {
      Terminal.addLine('system', `Failed to load config: ${err.message}`);
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
    setSlider('contrast-range',   contrast);
    setSlider('saturation-range', saturation);
    setSlider('sharpness-range',  sharpness);
    setSlider('blur-range',       blur);
    if (el('fps-select')) el('fps-select').value = String(targetFps);

    if (el('brightness-val')) el('brightness-val').textContent = parseFloat(brightness).toFixed(2);
    if (el('contrast-val'))   el('contrast-val').textContent   = parseFloat(contrast).toFixed(2);
    if (el('saturation-val')) el('saturation-val').textContent = parseFloat(saturation).toFixed(2);
    if (el('sharpness-val'))  el('sharpness-val').textContent  = parseFloat(sharpness).toFixed(1);
    if (el('blur-val'))       el('blur-val').textContent       = parseInt(blur) === 0 ? 'Off' : parseInt(blur) + 'px';
  }

  // ── Orientation ───────────────────────────────────────────────────────────

  function onOrientationChange() {
    const deg = parseInt(el('orientation-select')?.value || 0, 10);
    Stream.setOrientation(deg);
    update();
  }

  // ── Zoom ─────────────────────────────────────────────────────────────────

  let zoomTimeout = null;

  function onZoomChange(val) {
    if (el('zoom-val')) el('zoom-val').textContent = parseFloat(val).toFixed(1) + 'x';
    clearTimeout(zoomTimeout);
    zoomTimeout = setTimeout(update, 400);
  }

  // ── Video Processing ──────────────────────────────────────────────────────

  let processingTimeout = null;

  function onProcessingChange() {
    // Update labels live
    const b = el('brightness-range')?.value ?? 0;
    const c = el('contrast-range')?.value   ?? 1;
    const s = el('saturation-range')?.value ?? 1;
    const sh = el('sharpness-range')?.value ?? 0;
    const bl = el('blur-range')?.value      ?? 0;
    if (el('brightness-val')) el('brightness-val').textContent = parseFloat(b).toFixed(2);
    if (el('contrast-val'))   el('contrast-val').textContent   = parseFloat(c).toFixed(2);
    if (el('saturation-val')) el('saturation-val').textContent = parseFloat(s).toFixed(2);
    if (el('sharpness-val'))  el('sharpness-val').textContent  = parseFloat(sh).toFixed(1);
    if (el('blur-val'))       el('blur-val').textContent       = parseInt(bl) === 0 ? 'Off' : parseInt(bl) + 'px';

    // Debounce API call (avoid rapid pipeline restarts while dragging)
    clearTimeout(processingTimeout);
    processingTimeout = setTimeout(update, 600);
  }

  function resetProcessing() {
    if (el('brightness-range')) el('brightness-range').value = 0.0;
    if (el('contrast-range'))   el('contrast-range').value   = 1.0;
    if (el('saturation-range')) el('saturation-range').value = 1.0;
    if (el('sharpness-range'))  el('sharpness-range').value  = 0.0;
    if (el('blur-range'))       el('blur-range').value       = 0;
    if (el('fps-select'))       el('fps-select').value       = '30';
    if (el('brightness-val')) el('brightness-val').textContent = '0.00';
    if (el('contrast-val'))   el('contrast-val').textContent   = '1.00';
    if (el('saturation-val')) el('saturation-val').textContent = '1.00';
    if (el('sharpness-val'))  el('sharpness-val').textContent  = '0.0';
    if (el('blur-val'))       el('blur-val').textContent       = 'Off';
    Terminal.addLine('system', 'Processing reset to defaults - applying...');
    update();
  }

  // ── Save / Update ─────────────────────────────────────────────────────────

  async function update() {
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

    Terminal.addLine('system',
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
        Terminal.addLine('system', '✓ Config saved — pipeline restarting…');
      } else {
        Terminal.addLine('system', `Config save failed: ${res.statusText}`);
      }
    } catch (err) {
      Terminal.addLine('system', `Config error: ${err.message}`);
    }
  }

  return { load, update, onOrientationChange, onZoomChange, onProcessingChange, resetProcessing };
})();
