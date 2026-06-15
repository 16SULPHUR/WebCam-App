/**
 * config.js — Load / save config via REST API
 *
 * Orientation is special:
 *   - Applies CSS immediately via Stream.setOrientation() (instant, no restart)
 *   - Also sent to server so VCam FFmpeg pipeline uses correct rotation
 */
const Config = (() => {
  async function load() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(res.statusText);
      const cfg = await res.json();

      const resSel  = document.getElementById('resolution-select');
      const mirCb   = document.getElementById('mirror-checkbox');
      const oriSel  = document.getElementById('orientation-select');
      const vcamCb  = document.getElementById('vcam-checkbox');

      if (resSel) resSel.value  = cfg.resolution  || 'auto';
      if (mirCb)  mirCb.checked = !!cfg.mirror;
      if (oriSel) oriSel.value  = String(cfg.orientation !== undefined ? cfg.orientation : 0);
      if (vcamCb) vcamCb.checked = cfg.vcamEnabled !== false;

      // Apply orientation CSS immediately (no pipeline restart)
      Stream.setOrientation(cfg.orientation || 0);

      Terminal.addLine('system', `Config loaded: res=${cfg.resolution}, mirror=${cfg.mirror}, orientation=${cfg.orientation}°`);
    } catch (err) {
      Terminal.addLine('system', `Failed to load config: ${err.message}`);
    }
  }

  /** Called when orientation dropdown changes — instant CSS, + server notify */
  function onOrientationChange() {
    const oriSel = document.getElementById('orientation-select');
    const deg = parseInt(oriSel ? oriSel.value : 0, 10);

    // 1. Apply CSS rotation immediately (no server, no restart)
    Stream.setOrientation(deg);

    // 2. Send to server so VCam pipeline uses correct rotation
    update();
  }

  async function update() {
    const resSel  = document.getElementById('resolution-select');
    const mirCb   = document.getElementById('mirror-checkbox');
    const oriSel  = document.getElementById('orientation-select');
    const vcamCb  = document.getElementById('vcam-checkbox');

    const payload = {
      resolution:  resSel  ? resSel.value              : 'auto',
      mirror:      mirCb   ? mirCb.checked              : false,
      orientation: oriSel  ? Number(oriSel.value)       : 0,
      vcamEnabled: vcamCb  ? vcamCb.checked             : true,
    };

    Terminal.addLine('system', `Saving config: res=${payload.resolution}, mirror=${payload.mirror}, orientation=${payload.orientation}°, vcam=${payload.vcamEnabled}`);

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        Terminal.addLine('system', '✓ Config saved — VCam pipeline restarting…');
      } else {
        Terminal.addLine('system', `Config save failed: ${res.statusText}`);
      }
    } catch (err) {
      Terminal.addLine('system', `Config error: ${err.message}`);
    }
  }

  return { load, update, onOrientationChange };
})();
