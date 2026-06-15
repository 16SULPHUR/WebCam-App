/**
 * app.js — Application entry point
 *
 * Bootstraps SSE connection, wires modules together.
 */
(function () {
  'use strict';

  // ── Initialise ──────────────────────────────────────────────────────────────
  Config.load();
  Terminal.init();

  // ── SSE Log Stream ──────────────────────────────────────────────────────────
  let logEventSource = null;

  function connectSSE() {
    if (logEventSource) {
      logEventSource.close();
    }

    logEventSource = new EventSource('/logs');

    logEventSource.onopen = () => {
      Stream.setStatus('connecting', 'Connecting…');
      Terminal.addLine('system', 'Connected to dashboard log stream.');
    };

    logEventSource.onerror = () => {
      Stream.setStatus('error', 'Disconnected');
      Terminal.addLine('system', '⚠️ Log stream disconnected — retrying…');
    };

    logEventSource.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (data.type === 'log') {
        Terminal.addLine(data.source, data.message);
      } else if (data.type === 'status') {
        Stream.handleStatus(data);
      }
    };
  }

  connectSSE();

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Ctrl+L → clear logs
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      Terminal.clear();
    }
    // Ctrl+R → reconnect
    if (e.ctrlKey && e.key === 'r' && !e.shiftKey) {
      // Don't prevent default (allow normal reload), only handle if focused on dashboard
    }
    // F11 → fullscreen feed (alternative)
    if (e.key === 'F11') {
      e.preventDefault();
      Stream.toggleFullscreen();
    }
  });

  // ── Page visibility — reconnect SSE if tab re-focused ──────────────────────
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!logEventSource || logEventSource.readyState === EventSource.CLOSED) {
        Terminal.addLine('system', 'Tab re-focused — reconnecting log stream…');
        connectSSE();
      }
    }
  });

})();
