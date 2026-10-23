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
      if (r.status === 404) { setChip(healthChip, 'NO ENDPOINT', 'warn'); return; }
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) { setChip(healthChip, 'PROTECTED', 'warn'); return; }
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
      const ct = r.headers.get('content-type') || '';
      const xml = await r.text();
      if (!ct.includes('xml') && !xml.includes('<urlset')) { setChip(sitemapChip, 'SITEMAP PROTECTED', 'warn'); return; }
      const count = (xml.match(/<loc>/g) || []).length;
      setChip(sitemapChip, count ? 'SITEMAP ' + count : 'SITEMAP EMPTY', count ? '' : 'warn');
    } catch (_) {
      setChip(sitemapChip, 'SITEMAP ERR', 'warn');
    }
  }

  /* ---------- the red pill: heavy matrix rain ---------- */
  const rain = document.getElementById('rain');
  const rctx = rain ? rain.getContext('2d', { alpha: true }) : null;
  const qs = new URLSearchParams(window.location.search);
  const reduce = qs.get('motion') !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ:・."=*+-<>¦｜';
  const FONT = 16;
  let cols = 0;
  let drops = [];
  let lastFrame = 0;

  function resizeRain() {
    if (!rain || !rctx) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    rain.width = Math.floor(w * dpr);
    rain.height = Math.floor(h * dpr);
    rain.style.width = w + 'px';
    rain.style.height = h + 'px';
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / FONT);
    drops = Array.from({ length: cols }, () => Math.random() * (-h / FONT));
    if (reduce) drawStaticRain();
  }

  function drawStaticRain() {
    if (!rctx) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    rctx.clearRect(0, 0, w, h);
    rctx.font = FONT + 'px monospace';
    rctx.fillStyle = 'rgba(57,255,20,.55)';
    for (let i = 0; i < 260; i++) {
      const ch = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      rctx.fillText(ch, Math.random() * w, Math.random() * h);
    }
  }

  function drawRain(ts) {
    if (!rctx || reduce) return;
    window.requestAnimationFrame(drawRain);
    if (document.hidden) return;
    if (ts - lastFrame < 33) return;
    lastFrame = ts;
    const w = window.innerWidth;
    const h = window.innerHeight;
    rctx.fillStyle = 'rgba(0,6,3,.075)';
    rctx.fillRect(0, 0, w, h);
    rctx.font = FONT + 'px monospace';
    for (let i = 0; i < cols; i++) {
      const ch = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      const x = i * FONT;
      const y = drops[i] * FONT;
      if (y > 0) {
        rctx.fillStyle = Math.random() > 0.96 ? '#eaffea' : '#39ff14';
        rctx.globalAlpha = 0.45 + Math.random() * 0.55;
        rctx.fillText(ch, x, y);
        rctx.globalAlpha = 1;
      }
      if (y > h && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 1;
    }
  }

  function tickClock() {
    if (!clock) return;
    clock.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  tickClock();
  window.setInterval(tickClock, 1000);
  resizeRain();
  window.addEventListener('resize', resizeRain, { passive: true });
  drawStaticRain();
  if (!reduce) window.requestAnimationFrame(drawRain);
  checkHealth();
  checkSitemap();
})();
