(() => {
  'use strict';

  const healthChip = document.getElementById('healthChip');
  const sitemapChip = document.getElementById('sitemapChip');
  const clock = document.getElementById('clock');

  function setChip(el, text, tone = '') {
    if (!el) return;
    el.className = 'chip' + (tone ? ' ' + tone : '');
    const dot = document.createElement('i');
    el.replaceChildren(dot, document.createTextNode(' ' + text));
  }

  async function checkHealth() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const j = await r.json();
      if (r.ok && j.ok) setChip(healthChip, 'ONLINE');
      else setChip(healthChip, 'DEGRADED', 'warn');
    } catch (_) {
      setChip(healthChip, 'OFFLINE', 'bad');
    }
  }

  async function checkSitemap() {
    try {
      const r = await fetch('/sitemap.xml', { cache: 'no-store' });
      if (!r.ok) throw new Error('status ' + r.status);
      const xml = await r.text();
      const count = (xml.match(/<loc>/g) || []).length;
      setChip(sitemapChip, count ? 'SITEMAP ' + count : 'SITEMAP EMPTY', count ? '' : 'warn');
    } catch (_) {
      setChip(sitemapChip, 'SITEMAP ERR', 'warn');
    }
  }

  function tickClock() {
    if (!clock) return;
    clock.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  tickClock();
  window.setInterval(tickClock, 1000);
  checkHealth();
  checkSitemap();
})();
