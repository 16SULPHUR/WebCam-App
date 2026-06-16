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
      });
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
