/* ============================================================
   KILLSWITCH — shared light-up FX (interior pages)
   Brightens the whole screen the more switches/phases are on,
   darkens as they turn off. No sound, no lightning — just the
   cumulative glow + a quick flicker. Pairs with #pglow + ks.css.
   ============================================================ */
(function () {
  // Ensure the glow layer exists (pages should include it, but be safe).
  var glow = document.getElementById('pglow');
  if (!glow) {
    glow = document.createElement('div');
    glow.id = 'pglow';
    glow.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(glow, document.body.firstChild);
  }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Every purchasable pick on the page = one "on" switch when checked.
  function picks() {
    return document.querySelectorAll('.pick input, .path__pick input, .mcb, .path__cb');
  }
  function level() {
    var n = 0;
    document.querySelectorAll('.klsw.on').forEach(function () { n++; });
    picks().forEach(function (cb) { if (cb.checked) n++; });
    return n;
  }
  function glowNow() {
    document.body.style.setProperty('--power', level());
  }
  function flick() {
    if (reduce) return;
    document.body.classList.add('zap');
    setTimeout(function () { document.body.classList.remove('zap'); }, 180);
  }

  picks().forEach(function (cb) {
    cb.addEventListener('change', function () {
      if (cb.checked) flick();
      glowNow();
    });
  });
  document.querySelectorAll('.klsw').forEach(function (sw) {
    sw.addEventListener('click', function () { setTimeout(glowNow, 0); flick(); });
  });

  glowNow(); // reflect any pre-checked state on load
  window.ksGlowNow = glowNow;
})();
