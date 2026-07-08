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
  let _customPets = [];
  let _skins = [];
  let _targetPetIndex = null;
  let _skinFilterMode = 'all';
  let _favorites = JSON.parse(localStorage.getItem('neko_favorites') || '[]');

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
      if (el('camera-facing-select')) el('camera-facing-select').value = cfg.cameraFacing || 'back';
      if (el('controller-oneko-checkbox')) el('controller-oneko-checkbox').checked = cfg.onekoEnabled !== false;
      if (el('controller-oneko-size-range')) {
        el('controller-oneko-size-range').value = cfg.onekoSize ?? 2.0;
        onOnekoSizeChange(cfg.onekoSize ?? 2.0);
      }

      const ledOneko = el('led-oneko');
      if (ledOneko) ledOneko.classList.toggle('active', cfg.onekoEnabled !== false);

      _customPets = cfg.customPets || [];
      if (!Array.isArray(_customPets)) {
        _customPets = [];
      }
      if (_customPets.length === 0) {
        _customPets = [{ skin: cfg.customOnekoSkin || 'socks', enabled: !!cfg.customOnekoEnabled }];
      }
      await loadSkinsList();
      renderCustomPets();

      // Virtual background
      const bgMode = cfg.bgMode || 'none';
      const bgImg  = cfg.bgImage || '';
      _applyBgModeToUI(bgMode, bgImg);

      const segSelect = el('controller-seg-engine-select');
      if (segSelect) {
        segSelect.value = cfg.segmentationEngine || 'mediapipe';
        onSegEngineChange(cfg.segmentationEngine || 'mediapipe');
      }

      // RVM quality slider
      const rvmRatio = cfg.rvmDownsampleRatio ?? 0.25;
      const rvmRangeEl = el('rvm-downsample-range');
      if (rvmRangeEl) rvmRangeEl.value = Math.round(rvmRatio * 100);
      const rvmValEl = el('rvm-downsample-val');
      if (rvmValEl) rvmValEl.textContent = rvmRatio.toFixed(2) + '×';

      // Face touch-up
      const ftEnabled = cfg.faceTouchupEnabled ?? false;
      const ftCheckbox = el('controller-face-touchup-checkbox');
      if (ftCheckbox) ftCheckbox.checked = ftEnabled;
      const ftStrength = cfg.faceTouchupStrength ?? 35;
      const ftRange = el('face-touchup-strength-range');
      if (ftRange) ftRange.value = ftStrength;
      const ftVal = el('face-touchup-strength-val');
      if (ftVal) ftVal.textContent = ftStrength + '%';
      _applyFaceTouchupUI(ftEnabled);
      const ledFt = el('led-face-touchup');
      if (ledFt) ledFt.classList.toggle('active', ftEnabled);

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
    const mirrorActive = el('controller-mirror-checkbox')?.checked || el('mirror-checkbox')?.checked || false;
    const vcamActive   = el('controller-vcam-checkbox')?.checked   || el('vcam-checkbox')?.checked   || false;

    const ledMirror = el('led-mirror');
    if (ledMirror) {
      ledMirror.classList.toggle('active', mirrorActive);
    }
    const ledVcam = el('led-vcam');
    if (ledVcam) {
      ledVcam.classList.toggle('active', vcamActive);
    }
    const ledOneko = el('led-oneko');
    if (ledOneko) {
      ledOneko.classList.toggle('active', el('controller-oneko-checkbox')?.checked || false);
    }
  }

  function _syncUIFromStandard() {
    // Sync checkboxes
    const mirrorVal = el('mirror-checkbox') ? !!el('mirror-checkbox').checked : !!el('controller-mirror-checkbox')?.checked;
    const vcamVal   = el('vcam-checkbox') ? el('vcam-checkbox').checked !== false : el('controller-vcam-checkbox')?.checked !== false;

    if (el('controller-mirror-checkbox')) el('controller-mirror-checkbox').checked = mirrorVal;
    if (el('mirror-checkbox')) el('mirror-checkbox').checked = mirrorVal;

    // Sync orientation
    const oriVal = el('orientation-select')?.value || el('controller-orientation-select')?.value || '0';
    if (el('controller-orientation-select')) el('controller-orientation-select').value = oriVal;
    if (el('orientation-select')) el('orientation-select').value = oriVal;

    // Sync Zoom
    const zoomVal = el('zoom-select')?.value || el('controller-zoom-select')?.value || '1.0';
    if (el('controller-zoom-select')) el('controller-zoom-select').value = zoomVal;
    if (el('zoom-select')) el('zoom-select').value = zoomVal;
    const ztxt = parseFloat(zoomVal).toFixed(1) + 'x';
    if (el('controller-zoom-val')) el('controller-zoom-val').textContent = ztxt;
    if (el('zoom-val')) el('zoom-val').textContent = ztxt;
    _updateZoomKnob(zoomVal);

    // Sync Resolution
    const resVal = el('resolution-select')?.value || el('controller-resolution-select')?.value || 'auto';
    if (el('controller-resolution-select')) el('controller-resolution-select').value = resVal;
    if (el('resolution-select')) el('resolution-select').value = resVal;

    // Sync FPS
    const fpsVal = el('fps-select')?.value || el('controller-fps-select')?.value || '30';
    if (el('controller-fps-select')) el('controller-fps-select').value = fpsVal;
    if (el('fps-select')) el('fps-select').value = fpsVal;

    // Sync Camera Facing
    const camVal = el('camera-facing-select')?.value || el('controller-camera-facing-select')?.value || 'back';
    if (el('controller-camera-facing-select')) el('controller-camera-facing-select').value = camVal;
    if (el('camera-facing-select')) el('camera-facing-select').value = camVal;

    _updateLEDs();
  }

  // ── Orientation ───────────────────────────────────────────────────────────

  function onOrientationChange() {
    const deg = parseInt(el('orientation-select')?.value || el('controller-orientation-select')?.value || 0, 10);
    if (el('controller-orientation-select')) el('controller-orientation-select').value = String(deg);
    Stream.setOrientation(deg);
    update();
  }

  function onOrientationChangeFromController() {
    const deg = parseInt(el('controller-orientation-select')?.value || el('orientation-select')?.value || 0, 10);
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
    if (el('controller-fps-select')) el('controller-fps-select').value = '30';

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
    const resVal    = el('controller-resolution-select')?.value || 'auto';
    const fpsVal    = el('controller-fps-select')?.value || '30';

    if (el('mirror-checkbox')) el('mirror-checkbox').checked = mirrorVal;
    if (el('vcam-checkbox'))   el('vcam-checkbox').checked = vcamVal;
    if (el('resolution-select')) el('resolution-select').value = resVal;
    if (el('fps-select')) el('fps-select').value = fpsVal;

    _updateLEDs();
    update();
  }

  // ── Virtual Background ────────────────────────────────────────────────────

  let _bgMode = 'none';
  let _bgImage = '';
  let _bgImagesLoaded = false;

  function _applyBgModeToUI(mode, image) {
    _bgMode = mode;
    _bgImage = image;

    // Update pill buttons
    document.querySelectorAll('.bg-mode-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Show/hide sub-sections
    const blurHint = el('bg-blur-hint');
    const gridWrap = el('bg-image-grid-wrap');
    if (blurHint) blurHint.style.display = mode === 'blur'    ? '' : 'none';
    if (gridWrap) gridWrap.style.display  = mode === 'replace' ? '' : 'none';

    // Load background images when entering replace mode for the first time
    if (mode === 'replace' && !_bgImagesLoaded) {
      loadBackgrounds(image);
    } else if (mode === 'replace') {
      _syncGridSelection(image);
    }
  }

  function setBgMode(mode) {
    _bgMode = mode;
    _applyBgModeToUI(mode, _bgImage);
    update();
  }

  async function loadBackgrounds(selectedImage) {
    _bgImagesLoaded = true;
    const grid = el('bg-image-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="bg-grid-loading">Loading backgrounds…</div>';
    try {
      const res = await fetch('/api/backgrounds');
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      const items = data.backgrounds || [];
      if (items.length === 0) {
        grid.innerHTML = '<div class="bg-grid-loading">No backgrounds found. Add images to the <code>backgrounds/</code> folder.</div>';
        return;
      }
      grid.innerHTML = '';
      items.forEach(item => {
        const thumb = document.createElement('div');
        const curSelected = selectedImage !== undefined ? selectedImage : _bgImage;
        thumb.className = 'bg-thumb' + (item.filename === curSelected ? ' selected' : '');
        thumb.dataset.filename = item.filename;
        const label = item.filename.replace(/\.[^.]+$/, '');
        thumb.innerHTML = `
          <img src="${item.url}" alt="${label}" loading="lazy">
          <div class="bg-thumb-label">${label}</div>
          <div class="selected-tick">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        `;
        thumb.addEventListener('click', () => _selectBackground(item.filename));
        grid.appendChild(thumb);
      });
    } catch (err) {
      grid.innerHTML = `<div class="bg-grid-loading">Failed to load backgrounds: ${err.message}</div>`;
    }
  }

  function _selectBackground(filename) {
    _bgImage = filename;
    _syncGridSelection(filename);
    update();
  }

  function _syncGridSelection(filename) {
    document.querySelectorAll('.bg-thumb').forEach(t => {
      t.classList.toggle('selected', t.dataset.filename === filename);
    });
  }

  // ── Save / Update ─────────────────────────────────────────────────────────

  async function update() {
    _syncUIFromStandard();

    const payload = {
      resolution:  el('controller-resolution-select')?.value || el('resolution-select')?.value || 'auto',
      mirror:      (el('controller-mirror-checkbox') ? el('controller-mirror-checkbox').checked : (el('mirror-checkbox')?.checked || false)),
      orientation: Number(el('controller-orientation-select')?.value || el('orientation-select')?.value || 0),
      vcamEnabled: (el('controller-vcam-checkbox') ? el('controller-vcam-checkbox').checked : (el('vcam-checkbox')?.checked !== false)),
      zoom:        parseFloat(el('controller-zoom-select')?.value || el('zoom-select')?.value || 1.0),
      brightness:  parseFloat(el('controller-brightness-range')?.value || el('brightness-range')?.value || 0.0),
      contrast:    parseFloat(el('controller-contrast-range')?.value || el('contrast-range')?.value || 1.0),
      saturation:  parseFloat(el('controller-saturation-range')?.value || el('saturation-range')?.value || 1.0),
      sharpness:   parseFloat(el('controller-sharpness-range')?.value || el('sharpness-range')?.value || 0.0),
      blur:        parseInt(el('controller-blur-range')?.value || el('blur-range')?.value || 0, 10),
      targetFps:   parseInt(el('controller-fps-select')?.value || el('fps-select')?.value || 30, 10),
      cameraFacing: el('controller-camera-facing-select')?.value || el('camera-facing-select')?.value || 'back',
      bgMode:      _bgMode,
      bgImage:     _bgImage,
      onekoEnabled: (el('controller-oneko-checkbox') ? el('controller-oneko-checkbox').checked : true),
      onekoSize:   parseFloat(el('controller-oneko-size-range')?.value || 2.0),
      customPets:  _customPets,
      customOnekoEnabled: _customPets[0] ? _customPets[0].enabled : false,
      customOnekoSkin: _customPets[0] ? _customPets[0].skin : 'socks',
      segmentationEngine: el('controller-seg-engine-select')?.value || 'mediapipe',
      rvmDownsampleRatio:  parseFloat((parseInt(el('rvm-downsample-range')?.value || 25, 10) / 100).toFixed(2)),
      faceTouchupEnabled:  el('controller-face-touchup-checkbox')?.checked || false,
      faceTouchupStrength: parseInt(el('face-touchup-strength-range')?.value || 35, 10),
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

  let onekoSizeTimeout = null;
  function onOnekoSizeChange(val) {
    const span = el('controller-oneko-size-val');
    if (span) span.textContent = parseFloat(val).toFixed(1) + 'x';
    const range = el('controller-oneko-size-range');
    if (range) range.value = val;

    if (_loading) return;
    clearTimeout(onekoSizeTimeout);
    onekoSizeTimeout = setTimeout(update, 250);
  }

  async function loadSkinsList() {
    if (_skins.length > 0) return;
    try {
      const res = await fetch('/api/skins');
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      _skins = data.skins || [];
    } catch (err) {
      console.error('Failed to load skins list:', err);
    }
  }

  function renderCustomPets() {
    const list = el('controller-custom-pets-list');
    if (!list) return;
    list.innerHTML = '';

    if (_customPets.length === 0) {
      list.innerHTML = '<div style="font-size: 11px; color: #6b7280; text-align: center; padding: 6px; border: 1px dashed rgba(255,255,255,0.06); border-radius: 6px;">No custom pets active.</div>';
      return;
    }

    _customPets.forEach((pet, index) => {
      const row = document.createElement('div');
      row.style = 'background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); padding: 8px 10px; border-radius: 8px; display: flex; flex-direction: column; gap: 8px; margin-bottom: 4px;';

      const header = document.createElement('div');
      header.style = 'display: flex; align-items: center; justify-content: space-between; width: 100%;';

      const titleLeft = document.createElement('div');
      titleLeft.style = 'display: flex; align-items: center; gap: 6px;';

      const led = document.createElement('div');
      led.className = 'status-led' + (pet.enabled ? ' active' : '');
      led.id = `led-custom-oneko-${index}`;

      const label = document.createElement('span');
      label.textContent = `Custom Pet #${index + 1}`;
      label.style = 'font-size: 11px; font-weight: 600; color: #e2e8f0; font-family: "Inter", sans-serif;';

      titleLeft.appendChild(led);
      titleLeft.appendChild(label);

      const rightControls = document.createElement('div');
      rightControls.style = 'display: flex; align-items: center; gap: 8px;';

      const swLabel = document.createElement('label');
      swLabel.className = 'switch-mech';
      const swInput = document.createElement('input');
      swInput.type = 'checkbox';
      swInput.checked = !!pet.enabled;
      swInput.onchange = (e) => {
        pet.enabled = e.target.checked;
        led.classList.toggle('active', pet.enabled);
        update();
      };
      const swSpan = document.createElement('span');
      swSpan.className = 'slider-mech';
      swLabel.appendChild(swInput);
      swLabel.appendChild(swSpan);

      const delBtn = document.createElement('button');
      delBtn.innerHTML = '&times;';
      delBtn.style = 'background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: #ef4444; border-radius: 4px; padding: 0px 6px; font-size: 14px; cursor: pointer; display: flex; align-items: center; line-height: 1; border: none; height: 18px;';
      delBtn.onclick = () => removeCustomPet(index);

      rightControls.appendChild(swLabel);
      rightControls.appendChild(delBtn);
      header.appendChild(titleLeft);
      header.appendChild(rightControls);

      const selectorRow = document.createElement('div');
      selectorRow.style = 'display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 6px;';

      const selSelect = document.createElement('select');
      selSelect.className = 'ctrl-select ctrl-select-mech';
      selSelect.style = 'background: #0f172a; color: #f3f4f6; border: 1px solid rgba(255,255,255,0.08); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; cursor: pointer; outline: none; flex: 1; height: 24px; min-width: 0; text-align: center;';

      // Sort skins: favorites first, then alphabetical
      const sortedSkinsForDropdown = [..._skins].sort((a, b) => {
        const isAFav = _favorites.includes(a);
        const isBFav = _favorites.includes(b);
        if (isAFav && !isBFav) return -1;
        if (!isAFav && isBFav) return 1;
        return a.localeCompare(b);
      });

      sortedSkinsForDropdown.forEach(skin => {
        const opt = document.createElement('option');
        opt.value = skin;
        opt.textContent = (skin + (_favorites.includes(skin) ? ' ❤️' : ''));
        if (skin === pet.skin) opt.selected = true;
        selSelect.appendChild(opt);
      });

      selSelect.onchange = (e) => {
        pet.skin = e.target.value;
        update();
      };

      const browseBtn = document.createElement('button');
      browseBtn.className = 'mech-press-btn btn-silver';
      browseBtn.textContent = 'Browse 🎨';
      browseBtn.style = 'padding: 0px 8px; font-size: 10px; border-radius: 4px; height: 24px; display: flex; align-items: center; justify-content: center;';
      browseBtn.onclick = () => openSkinModal(index);

      selectorRow.appendChild(selSelect);
      selectorRow.appendChild(browseBtn);

      row.appendChild(header);
      row.appendChild(selectorRow);
      list.appendChild(row);
    });
  }

  function addCustomPet() {
    _customPets.push({ skin: 'socks', enabled: true });
    renderCustomPets();
    update();
  }

  function removeCustomPet(index) {
    _customPets.splice(index, 1);
    renderCustomPets();
    update();
  }

  function openSkinModal(petIndex) {
    _targetPetIndex = petIndex;
    const modal = el('skin-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    setTimeout(() => {
      modal.style.opacity = '1';
      const content = el('skin-modal-content');
      if (content) content.style.transform = 'scale(1)';
    }, 10);
    renderSkinsGrid();
  }

  function closeSkinModal() {
    const modal = el('skin-modal');
    if (!modal) return;
    modal.style.opacity = '0';
    const content = el('skin-modal-content');
    if (content) content.style.transform = 'scale(0.95)';
    setTimeout(() => {
      modal.style.display = 'none';
    }, 200);
  }

  function setSkinFilter(mode) {
    _skinFilterMode = mode;
    const btnAll = el('filter-btn-all');
    const btnFav = el('filter-btn-fav');
    if (mode === 'all') {
      if (btnAll) {
        btnAll.style.background = '#06b6d4';
        btnAll.style.color = '#fff';
      }
      if (btnFav) {
        btnFav.style.background = 'transparent';
        btnFav.style.border = '1px solid rgba(255,255,255,0.1)';
        btnFav.style.color = '#9ca3af';
      }
    } else {
      if (btnAll) {
        btnAll.style.background = 'transparent';
        btnAll.style.border = '1px solid rgba(255,255,255,0.1)';
        btnAll.style.color = '#9ca3af';
      }
      if (btnFav) {
        btnFav.style.background = '#06b6d4';
        btnFav.style.color = '#fff';
        btnFav.style.border = 'none';
      }
    }
    renderSkinsGrid();
  }

  function filterSkins() {
    renderSkinsGrid();
  }

  function toggleFavorite(skinName, event) {
    event.stopPropagation();
    const idx = _favorites.indexOf(skinName);
    if (idx === -1) {
      _favorites.push(skinName);
    } else {
      _favorites.splice(idx, 1);
    }
    localStorage.setItem('neko_favorites', JSON.stringify(_favorites));
    renderSkinsGrid();
    renderCustomPets(); // update dropdown list labels
  }

  let previewInterval = null;
  function renderSkinsGrid() {
    const grid = el('skin-modal-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const query = el('skin-search-input')?.value.toLowerCase().trim() || '';

    // Sort skins: favorites first, then alphabetical
    const sortedSkins = [..._skins].sort((a, b) => {
      const isAFav = _favorites.includes(a);
      const isBFav = _favorites.includes(b);
      if (isAFav && !isBFav) return -1;
      if (!isAFav && isBFav) return 1;
      return a.localeCompare(b);
    });

    const filtered = sortedSkins.filter(skin => {
      if (_skinFilterMode === 'fav' && !_favorites.includes(skin)) return false;
      if (query && !skin.toLowerCase().includes(query)) return false;
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #6b7280; font-size: 11px; padding: 20px;">No skins found.</div>';
      return;
    }

    filtered.forEach(skin => {
      const isFav = _favorites.includes(skin);
      const card = document.createElement('div');
      card.style = 'background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 10px 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; position: relative; transition: all 0.2s ease;';

      card.onmouseenter = () => {
        card.style.background = 'rgba(255,255,255,0.06)';
        card.style.borderColor = '#06b6d4';
        
        let phase = 1;
        if (previewInterval) clearInterval(previewInterval);
        previewInterval = setInterval(() => {
          img.src = `/skins/${skin}/${phase === 1 ? 'erun1' : 'erun2'}.png`;
          phase = phase === 1 ? 2 : 1;
        }, 150);
      };
      card.onmouseleave = () => {
        card.style.background = 'rgba(255,255,255,0.03)';
        card.style.borderColor = 'rgba(255,255,255,0.06)';
        if (previewInterval) {
          clearInterval(previewInterval);
          previewInterval = null;
        }
        img.src = `/skins/${skin}/still.png`;
      };

      const heart = document.createElement('button');
      heart.style = 'position: absolute; top: 4px; right: 4px; background: none; border: none; outline: none; cursor: pointer; padding: 2px; display: flex; align-items: center; justify-content: center;';
      heart.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="${isFav ? '#ef4444' : 'none'}" stroke="${isFav ? 'none' : '#9ca3af'}" stroke-width="2">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
        </svg>
      `;
      heart.onclick = (e) => toggleFavorite(skin, e);

      const img = document.createElement('img');
      img.src = `/skins/${skin}/still.png`;
      img.alt = skin;
      img.style = 'width: 32px; height: 32px; image-rendering: pixelated; margin-bottom: 6px;';

      const name = document.createElement('div');
      name.textContent = skin;
      name.style = 'font-size: 9px; font-weight: 500; color: #cbd5e1; text-align: center; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: "Inter", sans-serif;';

      card.onclick = () => selectSkin(skin);

      card.appendChild(heart);
      card.appendChild(img);
      card.appendChild(name);
      grid.appendChild(card);
    });
  }

  function selectSkin(skinName) {
    if (_targetPetIndex !== null && _targetPetIndex < _customPets.length) {
      _customPets[_targetPetIndex].skin = skinName;
      renderCustomPets();
      update();
    }
    closeSkinModal();
  }

  function onSegEngineChange(val) {
    const select = el('controller-seg-engine-select');
    if (select) select.value = val;

    const rvmCtrls = el('rvm-controls');
    if (rvmCtrls) {
      rvmCtrls.style.display = (val === 'rvm') ? 'flex' : 'none';
    }

    if (!_loading) {
      update();
    }
  }

  function onRvmQualityChange(rawVal) {
    const ratio = (parseInt(rawVal, 10) / 100).toFixed(2);
    const valEl = el('rvm-downsample-val');
    if (valEl) valEl.textContent = ratio + '×';
    if (!_loading) update();
  }

  function _applyFaceTouchupUI(enabled) {
    const row = el('face-touchup-strength-row');
    const hint = el('face-touchup-hint');
    if (row)  row.style.display  = enabled ? 'flex' : 'none';
    if (hint) hint.style.display = enabled ? 'block' : 'none';
  }

  function onFaceTouchupChange() {
    const enabled = el('controller-face-touchup-checkbox')?.checked || false;
    const strength = parseInt(el('face-touchup-strength-range')?.value || 35, 10);
    // Update strength label
    const valEl = el('face-touchup-strength-val');
    if (valEl) valEl.textContent = strength + '%';
    // Show/hide strength row
    _applyFaceTouchupUI(enabled);
    // Update LED
    const led = el('led-face-touchup');
    if (led) led.classList.toggle('active', enabled);
    if (!_loading) update();
  }

  async function uploadBackground(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    Toast.show('Uploading custom background...', 'info');
    try {
      const res = await fetch(`/api/upload_background?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: file
      });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      if (data.success) {
        Toast.show('✓ Custom background uploaded successfully!', 'success');
        await loadBackgrounds(data.filename);
        update();
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      Toast.show(`⚠️ Upload failed: ${err.message}`, 'error');
    }
  }

  return {
    load,
    update,
    updateFromController,
    resetProcessing,
    resetSingle,
    onProcessingChange,
    onOrientationChange,
    onOrientationChangeFromController,
    onZoomChange,
    setBgMode,
    onSegEngineChange,
    onRvmQualityChange,
    onFaceTouchupChange,
    uploadBackground,
    loadBackgrounds,
    onOnekoSizeChange,
    addCustomPet,
    removeCustomPet,
    openSkinModal,
    closeSkinModal,
    filterSkins,
    setSkinFilter,
    toggleFavoriteSkin: toggleFavorite,
  };
})();
