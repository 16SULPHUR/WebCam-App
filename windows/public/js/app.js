/**
 * app.js — Application entry point
 *
 * Dynamically loads modular HTML components on page load,
 * then bootstraps the dashboard SSE connection and event listeners.
 */
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
        Terminal.addLine('system', 'Connected to dashboard log stream.');
      };

      logEventSource.onerror = () => {
        Stream.setStatus('error', 'Disconnected');
        Terminal.addLine('system', 'Log stream disconnected - retrying...');
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
          Terminal.addLine('system', 'Tab re-focused - reconnecting log stream...');
          connectSSE();
        }
      }
    });

    // ── Tab Navigation ─────────────────────────────────────────────────────────
    const navTabs = document.querySelectorAll('.nav-tab');
    const tabContents = document.querySelectorAll('.tab-content');

    navTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;

        // Update active tab button class
        navTabs.forEach(t => t.classList.toggle('active', t === tab));

        // Update active tab content class
        tabContents.forEach(content => {
          const isActive = content.id === `tab-${targetTab}`;
          content.classList.toggle('active', isActive);
        });

        // Scroll terminal to bottom when selecting logs tab
        if (targetTab === 'logs') {
          const term = document.getElementById('terminal');
          if (term) term.scrollTop = term.scrollHeight;
        }
      });
    });

    // Close console redirects back to camera settings tab
    document.getElementById('btn-close-console')?.addEventListener('click', () => {
      document.querySelector('.nav-tab[data-tab="camera"]')?.click();
    });
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
