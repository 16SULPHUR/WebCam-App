/**
 * terminal.js — Console log rendering, filtering, and collapsing
 */
const Terminal = (() => {
  let activeFilter = 'all';
  let logCount = 0;
  let isCollapsed = false;

  const el = {
    body:       () => document.getElementById('terminal'),
    count:      () => document.getElementById('log-count'),
    info:       () => document.getElementById('terminal-info'),
    collapseIcon: () => document.getElementById('collapse-icon'),
    autoscroll: () => document.getElementById('autoscroll-cb'),
  };

  /** Escape HTML entities for safe insertion */
  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /** Classify log message for styling */
  function classifyMessage(source, message) {
    const lower = message.toLowerCase();
    const isError = source === 'error'
      || lower.includes('error')
      || lower.includes('failed')
      || lower.includes('crash')
      || lower.includes('❌');
    const isWarn  = lower.includes('warn') || lower.includes('⚠️') || lower.includes('restart');
    const isOk    = lower.includes('✓') || lower.includes('connected') || lower.includes('success');
    return { isError, isWarn, isOk };
  }

  /** Add a log line to the terminal */
  function addLine(source, message) {
    const body = el.body();
    const { isError, isWarn, isOk } = classifyMessage(source, message);

    // Map source for known prefixes
    const tag = source === 'error' ? 'error' : source;

    const line = document.createElement('div');
    line.className = 'log-line' + (isError ? ' is-error' : '');
    line.dataset.source = tag;
    line.dataset.isError = isError ? '1' : '0';

    const msgClass = isError ? 'is-error' : isWarn ? 'is-warn' : isOk ? 'is-ok' : '';

    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

    line.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-tag ${tag}">${tag}</span>
      <span class="log-msg ${msgClass}">${escapeHtml(message)}</span>
    `;

    // Apply active filter visibility
    if (activeFilter === 'error') {
      line.style.display = isError ? 'flex' : 'none';
    } else if (activeFilter !== 'all' && activeFilter !== tag) {
      line.style.display = 'none';
    }

    body.appendChild(line);
    logCount++;
    _updateCounters();

    // Auto-scroll
    const cb = el.autoscroll();
    if (!cb || cb.checked) {
      body.scrollTop = body.scrollHeight;
    }

    // Cap at 400 lines
    while (body.childElementCount > 400) {
      body.removeChild(body.firstChild);
    }
  }

  function _updateCounters() {
    const countEl = el.count();
    const infoEl  = el.info();
    if (countEl) countEl.textContent = logCount > 999 ? '999+' : logCount;
    if (infoEl)  infoEl.textContent  = `${logCount} lines`;
  }

  function setFilter(filter) {
    activeFilter = filter;

    // Update filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      const f = btn.dataset.filter;
      btn.classList.toggle('active', f === filter);
    });

    // Show/hide existing lines
    document.querySelectorAll('#terminal .log-line').forEach(line => {
      const src = line.dataset.source;
      const isError = line.dataset.isError === '1';
      let show = false;
      if (filter === 'all')   show = true;
      else if (filter === 'error') show = isError;
      else show = (src === filter);
      line.style.display = show ? 'flex' : 'none';
    });

    // Scroll to bottom after filter change
    const body = el.body();
    if (body) body.scrollTop = body.scrollHeight;
  }

  function clear() {
    const body = el.body();
    if (body) body.innerHTML = '';
    logCount = 0;
    _updateCounters();
  }

  return { addLine, setFilter, clear };
})();
