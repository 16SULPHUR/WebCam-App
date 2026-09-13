/**
 * app.js — Application entry point
 *
 * Dynamically loads modular HTML components on page load,
 * then bootstraps the dashboard SSE connection and event listeners.
 */

// Global Toast notification system
const Toast = {
  show(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    
    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Auto remove
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
};

(function () {
  'use strict';

  // ── Component Loader ───────────────────────────────────────────────────────
  async function loadComponents() {
    const elements = document.querySelectorAll('[data-component]');
    const promises = Array.from(elements).map(async (el) => {
      const componentName = el.getAttribute('data-component');
      try {
        const res = await fetch(`components/${componentName}.html`);
        if (!res.ok) throw new Error(`Failed to load ${componentName}: ${res.statusText}`);
        el.innerHTML = await res.text();
      } catch (err) {
        console.error(err);
        el.innerHTML = `<div class="component-error">Error loading component: ${componentName}</div>`;
      }
    });
    await Promise.all(promises);
  }

  // ── Initialise Application State & Listeners ───────────────────────────────
  function initializeApp() {
    Reactions.init();
    Config.load();

    // ── SSE Log Stream ──────────────────────────────────────────────────────────
    let logEventSource = null;

    function connectSSE() {
      if (logEventSource) {
        logEventSource.close();
      }

      logEventSource = new EventSource('/logs');

      logEventSource.onopen = () => {
        Stream.setStatus('connecting', 'Connecting...');
        console.log('[System] Connected to dashboard log stream.');
      };

      logEventSource.onerror = () => {
        Stream.setStatus('error', 'Disconnected');
        console.log('[System] Log stream disconnected - retrying...');
      };

      logEventSource.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (_) {
          return;
        }

        if (data.type === 'log') {
          console.log(`[${data.source.toUpperCase()}] ${data.message}`);
        } else if (data.type === 'status') {
          Stream.handleStatus(data);
        }
      };
    }

    connectSSE();

    // Wire up oneko toggle (if present in controller UI)
    const onekoToggle = document.getElementById('controller-oneko-checkbox');
    if (onekoToggle) {
      onekoToggle.addEventListener('change', () => {
        const led = document.getElementById('led-oneko');
        if (led) led.classList.toggle('active', onekoToggle.checked);
        Config.update();
      });
    }

    // ── Keyboard shortcuts ──────────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
      // F11 → fullscreen feed
      if (e.key === 'F11') {
        e.preventDefault();
        Stream.toggleFullscreen();
      }
    });

    // ── Page visibility — reconnect SSE if tab re-focused ──────────────────────
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (!logEventSource || logEventSource.readyState === EventSource.CLOSED) {
          console.log('[System] Tab re-focused - reconnecting log stream...');
          connectSSE();
        }
      }
    });

    // ── Rotary Zoom Knob Interaction ─────────────────────────────────────────
    const knobZone = document.getElementById('zoom-knob-drag-zone');
    const zoomInput = document.getElementById('controller-zoom-select');
    
    if (knobZone && zoomInput) {
      let isDragging = false;
      let startPointerAngle = 0;
      let startZoom = 1.0;

      knobZone.addEventListener('pointerdown', (e) => {
        isDragging = true;
        knobZone.setPointerCapture(e.pointerId);

        const rect = knobZone.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        startPointerAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180 / Math.PI;
        startZoom = parseFloat(zoomInput.value) || 1.0;

        e.preventDefault();
      });

      knobZone.addEventListener('pointermove', (e) => {
        if (!isDragging) return;

        const rect = knobZone.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const currPointerAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180 / Math.PI;
        
        let deltaAngle = currPointerAngle - startPointerAngle;
        if (deltaAngle > 180) deltaAngle -= 360;
        if (deltaAngle < -180) deltaAngle += 360;

        const deltaZoom = deltaAngle * (2.0 / 270);
        let newZoom = startZoom + deltaZoom;
        
        newZoom = Math.max(1.0, Math.min(3.0, newZoom));
        
        Config.onZoomChange(newZoom.toFixed(1));
      });

      const stopDrag = () => {
        isDragging = false;
      };

      knobZone.addEventListener('pointerup', stopDrag);
      knobZone.addEventListener('pointercancel', stopDrag);
    }
  }

  // Bootstrap components and application
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await loadComponents();
      initializeApp();
    } catch (err) {
      console.error("Initialization failed:", err);
    }
  });

})();
