(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const qs = new URLSearchParams(window.location.search);
  const reduce = qs.get('motion') !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? Math.min(ms, 40) : ms));

  const els = {
    log: $('#log'),
    form: $('#promptForm'),
    input: $('#biz'),
    hint: $('#hint'),
    windows: $('#windows'),
    cta: $('#cta'),
    voiceLine: $('#voiceLine'),
    speakBtn: $('#speakBtn'),
    againBtn: $('#againBtn'),
    micBtn: $('#micBtn'),
    soundBtn: $('#soundBtn'),
    meter: $('#meter'),
    clock: $('#clock'),
    leadsList: $('#leadsList'),
    leadsCity: $('#leadsCity'),
    trace: $('#trace'),
    spName: $('#spName'),
    spTrade: $('#spTrade'),
    spHeadline: $('#spHeadline'),
    spSub: $('#spSub'),
    spGrid: $('#spGrid'),
  };

  const state = {
    sound: false,
    running: false,
    listening: false,
    business: '',
    city: 'Kansas City',
    trade: 'default',
    lastText: '',
    recognition: null,
    audio: null,
  };

  /* ---------- copy / data ---------- */

  const TRADES = {
    auto: {
      label: 'Auto Repair',
      test: /auto|car|tire|brake|muffler|transmission|oil change/i,
      keywords: [['auto repair near me', 1900], ['brake repair', 720], ['oil change near me', 880]],
      headline: 'Keep your car on the road.',
      services: [['Brakes', 'Pads, rotors, lines'], ['Oil & fluid', 'Fast, clean, honest'], ['Diagnostics', 'Check-engine light']],
    },
    plumber: {
      label: 'Plumbing',
      test: /plumb|drain|pipe|water heater/i,
      keywords: [['plumber near me', 1600], ['emergency plumber', 990], ['water heater repair', 540]],
      headline: 'When it leaks, we answer.',
      services: [['Emergency', '24/7 call-outs'], ['Repairs', 'Leaks, drains, pipes'], ['Water heaters', 'Repair & install']],
    },
    hvac: {
      label: 'HVAC',
      test: /hvac|heating|air condition|furnace|ac repair/i,
      keywords: [['ac repair near me', 1200], ['furnace repair', 760], ['hvac company', 480]],
      headline: 'Comfort, fixed today.',
      services: [['AC repair', 'Same-day service'], ['Heating', 'Furnace & boiler'], ['Maintenance', 'Seasonal tune-ups']],
    },
    roof: {
      label: 'Roofing',
      test: /roof|shingle|gutter/i,
      keywords: [['roof repair', 680], ['roof replacement', 420], ['storm damage roof', 260]],
      headline: 'A roof you stop thinking about.',
      services: [['Repairs', 'Leaks & storm damage'], ['Replacement', 'Full tear-off'], ['Inspections', 'Free roof check']],
    },
    electric: {
      label: 'Electrical',
      test: /electric|wiring|panel|ev charger/i,
      keywords: [['electrician near me', 1100], ['panel upgrade', 390], ['ev charger install', 310]],
      headline: 'Power, done safely.',
      services: [['Repairs', 'Outlets & wiring'], ['Panels', 'Upgrades & safety'], ['EV chargers', 'Install & setup']],
    },
    clean: {
      label: 'Cleaning',
      test: /clean|maid|janitor/i,
      keywords: [['house cleaning near me', 880], ['office cleaning', 420], ['deep clean', 360]],
      headline: 'Walk into a place that feels new.',
      services: [['Homes', 'Weekly or one-time'], ['Offices', 'Contracts & one-offs'], ['Deep clean', 'Move-in / move-out']],
    },
    salon: {
      label: 'Salon',
      test: /salon|hair|stylist/i,
      keywords: [['hair salon near me', 740], ['balayage', 390], ['haircut near me', 620]],
      headline: 'Look like the best version of you.',
      services: [['Cuts', 'All ages'], ['Color', 'Balayage & gloss'], ['Styling', 'Events & photos']],
    },
    barber: {
      label: 'Barbershop',
      test: /barber|fade|shave/i,
      keywords: [['barber near me', 680], ['fade haircut', 310], ['beard trim', 220]],
      headline: 'Sharp. On time. Every time.',
      services: [['Cuts', 'Classic & fade'], ['Beard', 'Trim & shape'], ['Hot towel', 'The full reset']],
    },
    landscape: {
      label: 'Landscaping',
      test: /landscap|lawn|garden|tree/i,
      keywords: [['landscaping near me', 520], ['lawn care', 780], ['tree removal', 340]],
      headline: 'The yard they slow down for.',
      services: [['Lawn', 'Mow & maintain'], ['Design', 'Beds & stone'], ['Trees', 'Trim & remove']],
    },
    paint: {
      label: 'Painting',
      test: /paint|drywall/i,
      keywords: [['house painter near me', 480], ['interior painting', 350], ['cabinet painting', 210]],
      headline: 'A finish that makes the room.',
      services: [['Interior', 'Walls & ceilings'], ['Exterior', 'Siding & trim'], ['Cabinets', 'Spray & refinish']],
    },
    default: {
      label: 'Local Services',
      test: null,
      keywords: [['local services near me', 640], ['same day service', 380], ['free quote', 290]],
      headline: 'A name worth calling.',
      services: [['Fast response', 'Same-day service'], ['Upfront pricing', 'No surprises'], ['Book online', 'One tap']],
    },
  };

  const BOOT = [
    ['LIMEN BRAIN // BOOT', 'sys'],
    ['[ OK ]  kernel ......... loaded', 'ok'],
    ['[ OK ]  lattice ........ ready', 'ok'],
    ['[ OK ]  voice .......... armed', 'ok'],
    ['[ OK ]  operator ....... present', 'ok'],
    ['[ WAIT ] target ........ unidentified', 'dim'],
    ['> identify business_', 'cmd'],
  ];

  /* ---------- utilities ---------- */

  function line(text, cls = 'cmd') {
    const div = document.createElement('div');
    div.className = 'line ' + cls;
    div.textContent = text;
    els.log.appendChild(div);
    els.log.scrollTop = els.log.scrollHeight;
    return div;
  }

  function seeded(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0);
  }

  function parseInput(raw) {
    const clean = String(raw || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    let business = clean;
    let city = 'Kansas City';
    const comma = clean.split(/\s*,\s*/);
    if (comma.length > 1) {
      business = comma[0];
      city = comma.slice(1).join(', ');
    } else {
      const m = clean.match(/^(.*?)\s+(?:in|near)\s+(.+)$/i);
      if (m) { business = m[1]; city = m[2]; }
    }
    return { business: business || 'Your Business', city: city || 'Kansas City' };
  }

  function inferTrade(name) {
    const s = String(name || '');
    for (const [key, t] of Object.entries(TRADES)) {
      if (t.test && t.test.test(s)) return key;
    }
    return 'default';
  }

  function cityLabel(city) {
    return city.toUpperCase().replace(/\s+/g, ' ');
  }

  function beep(freq = 440, dur = 0.06) {
    if (!state.sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.audio = state.audio || new AC();
      const ctx = state.audio;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.value = 0.025;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + dur);
    } catch (_) { /* audio is optional */ }
  }

  /* ---------- matrix rain ---------- */

  const canvas = $('#rain');
  const ctx = canvas.getContext('2d', { alpha: true });
  const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:・."=*+-<>¦｜';
  let rainChars = GLYPHS;
  let cols = 0;
  let drops = [];
  let lastFrame = 0;
  const fontSize = 14;

  function setRainText(text) {
    const clean = String(text || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    rainChars = (clean + ' ' + GLYPHS).slice(0, 160);
  }

  function resizeRain() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / fontSize);
    drops = Array.from({ length: cols }, () => Math.random() * (-h / fontSize));
    if (reduce) drawStaticRain();
  }

  function drawStaticRain() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.font = fontSize + 'px monospace';
    ctx.fillStyle = 'rgba(57,255,20,.5)';
    for (let i = 0; i < 140; i++) {
      const ch = rainChars[Math.floor(Math.random() * rainChars.length)] || '0';
      ctx.fillText(ch, Math.random() * window.innerWidth, Math.random() * window.innerHeight);
    }
  }

  function drawRain(ts) {
    if (reduce) return;
    window.requestAnimationFrame(drawRain);
    if (document.hidden) return;
    if (ts - lastFrame < 55) return;
    lastFrame = ts;
    ctx.fillStyle = 'rgba(2,5,3,.06)';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.font = fontSize + 'px monospace';
    for (let i = 0; i < cols; i++) {
      const ch = rainChars[Math.floor(Math.random() * rainChars.length)] || '0';
      const x = i * fontSize;
      const y = drops[i] * fontSize;
      if (y > 0) {
        ctx.fillStyle = Math.random() > 0.975 ? '#d9ffd2' : '#39ff14';
        ctx.globalAlpha = 0.35 + Math.random() * 0.6;
        ctx.fillText(ch, x, y);
        ctx.globalAlpha = 1;
      }
      if (y > window.innerHeight && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 1;
    }
  }

  /* ---------- rendering ---------- */

  function revealWin(id) {
    els.windows.hidden = false;
    const el = document.getElementById(id);
    if (el) el.classList.add('show');
  }

  function addLead(name, volText, pct, gap = false) {
    const li = document.createElement('li');
    li.className = 'lead' + (gap ? ' gap' : '');
    const n = document.createElement('span');
    n.className = 'lead-name';
    n.textContent = name;
    const v = document.createElement('span');
    v.className = 'lead-vol';
    v.textContent = volText;
    const barWrap = document.createElement('span');
    barWrap.className = 'lead-bar';
    const bar = document.createElement('i');
    bar.style.width = Math.max(8, Math.min(100, pct)) + '%';
    barWrap.appendChild(bar);
    li.append(n, v, barWrap);
    els.leadsList.appendChild(li);
  }

  function renderLeads(trade, city, business) {
    els.leadsCity.textContent = 'LOCAL DEMAND // ' + cityLabel(city);
    els.leadsList.textContent = '';
    const rows = trade.keywords.map(([name, base]) => ({
      name,
      vol: base + (seeded(name + city) % 430),
    }));
    const max = Math.max(...rows.map((r) => r.vol));
    rows.forEach((r) => addLead(r.name, r.vol.toLocaleString('en-US'), (r.vol / max) * 100));
    const gap = 3 + (seeded('gap' + city + business) % 5);
    addLead(`${gap} of 10 local competitors have no mobile site`, 'GAP', 62, true);
  }

  function renderTrace(business, city, key) {
    const cityKey = city.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const lines = [
      `TRACE  trade=${key}`,
      `TRACE  city=${cityKey}`,
      'TRACE  intent=free_starter_site',
      'TRACE  modules=hero,services,reviews,call,book',
      'TRACE  constraint=no_template_no_wait',
      'TRACE  next=claim_domain + google_profile',
      '[ OK ] trace complete',
    ];
    els.trace.textContent = lines.join('\n');
  }

  function renderSite(business, city, trade) {
    els.spName.textContent = business;
    els.spTrade.textContent = trade.label + ' · ' + city;
    els.spHeadline.textContent = trade.headline;
    els.spSub.textContent = `Serving ${city} and nearby areas. Call for a same-day quote.`;
    els.spGrid.textContent = '';
    trade.services.forEach(([name, desc]) => {
      const card = document.createElement('div');
      card.className = 'sp-card';
      const b = document.createElement('b');
      b.textContent = name;
      const s = document.createElement('span');
      s.textContent = desc;
      card.append(b, s);
      els.spGrid.appendChild(card);
    });
  }

  /* ---------- boot / run ---------- */

  async function bootSeq() {
    els.log.textContent = '';
    for (const [text, cls] of BOOT) {
      line(text, cls);
      await sleep(170);
    }
  }

  async function runDemo(raw) {
    if (state.running) return;
    const { business, city } = parseInput(raw);
    const key = inferTrade(business);
    const trade = TRADES[key] || TRADES.default;
    state.business = business;
    state.city = city;
    state.trade = key;
    state.running = true;

    setRainText(`${business} ${city} ${trade.label}`);
    els.input.blur();
    els.hint.hidden = true;
    els.windows.hidden = false;
    $$('.win').forEach((w) => { w.classList.remove('show'); w.style.transform = ''; });
    els.cta.hidden = true;
    els.cta.classList.remove('show');
    els.speakBtn.disabled = true;
    els.voiceLine.textContent = 'Building the summary…';
    if (window.speechSynthesis) window.speechSynthesis.cancel();

    els.log.textContent = '';
    line('LIMEN BRAIN // ONLINE', 'sys');
    line('> TARGET ' + business.toUpperCase() + ' // ' + cityLabel(city), 'cmd');
    await sleep(260);

    line('> SCAN ............... local demand', 'cmd');
    await sleep(620);
    line(`[ OK ] demand mapped ...... ${trade.label.toLowerCase()} / ${city}`, 'ok');
    renderLeads(trade, city, business);
    revealWin('win-leads');
    beep(240);

    await sleep(260);
    line('> TRACE .............. competitors', 'cmd');
    await sleep(640);
    line('[ OK ] competitors indexed', 'ok');
    renderTrace(business, city, key);
    revealWin('win-brain');
    beep(300);

    await sleep(260);
    line('> FORGE .............. site.v1', 'cmd');
    await sleep(760);
    renderSite(business, city, trade);
    revealWin('win-site');
    line('[ OK ] site.v1 rendered ..... 4.18s', 'ok');
    beep(380);

    await sleep(260);
    line('> VERIFY ............. mobile / speed / schema', 'cmd');
    await sleep(580);
    line('[ OK ] mobile 98 / speed 99 / schema valid', 'ok');
    revealWin('win-voice');
    beep(460);

    await sleep(260);
    line('> LIVE ............... publishing', 'cmd');
    await sleep(640);
    line('[ OK ] site is live', 'ok');
    beep(620);

    line(' ', 'dim');
    line('> ' + business + ' is ready.', 'sys');
    state.lastText = `${business} in ${city}. I can have a starter site live today. Want the link?`;
    els.voiceLine.textContent = state.lastText;
    els.speakBtn.disabled = false;
    els.cta.hidden = false;
    window.requestAnimationFrame(() => els.cta.classList.add('show'));
    state.running = false;
  }

  /* ---------- voice ---------- */

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const rec = new SpeechRecognition();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      state.listening = true;
      els.micBtn.classList.add('listening');
      els.micBtn.textContent = 'LISTEN';
      line('> listening ...', 'dim');
    };
    rec.onresult = (event) => {
      const text = event.results && event.results[0] && event.results[0][0] && event.results[0][0].transcript;
      if (!text) return;
      els.input.value = text;
      line('> heard: ' + text, 'cmd');
      window.setTimeout(() => els.form.requestSubmit(), 350);
    };
    rec.onerror = (event) => {
      line('[ FAIL ] voice input: ' + (event.error || 'unavailable'), 'err');
    };
    rec.onend = () => {
      state.listening = false;
      els.micBtn.classList.remove('listening');
      els.micBtn.textContent = 'MIC';
    };
    state.recognition = rec;
  }

  els.micBtn.addEventListener('click', () => {
    if (!state.recognition) {
      line('voice input is not supported in this browser. type it instead.', 'warn');
      return;
    }
    if (state.listening) {
      state.recognition.stop();
      return;
    }
    try { state.recognition.start(); }
    catch (_) { line('voice input is busy. try again.', 'warn'); }
  });

  els.speakBtn.addEventListener('click', () => {
    if (!('speechSynthesis' in window)) {
      line('speech output is not supported in this browser.', 'warn');
      return;
    }
    if (!state.lastText) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(state.lastText);
    u.rate = 1;
    u.pitch = 0.9;
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((v) => /Google US English|Samantha|Daniel|Alex/i.test(v.name)) ||
      voices.find((v) => v.lang === 'en-US');
    if (preferred) u.voice = preferred;
    u.onstart = () => els.meter.classList.add('speaking');
    u.onend = () => els.meter.classList.remove('speaking');
    u.onerror = () => els.meter.classList.remove('speaking');
    window.speechSynthesis.speak(u);
  });

  /* ---------- interactions ---------- */

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = els.input.value.trim();
    if (!raw) {
      line('> need a business name.', 'warn');
      els.input.focus();
      return;
    }
    runDemo(raw);
  });

  els.soundBtn.addEventListener('click', () => {
    state.sound = !state.sound;
    els.soundBtn.setAttribute('aria-pressed', String(state.sound));
    els.soundBtn.textContent = state.sound ? 'SOUND ON' : 'SOUND OFF';
    if (state.sound) beep(660);
  });

  els.againBtn.addEventListener('click', async () => {
    els.windows.hidden = true;
    els.cta.hidden = true;
    els.cta.classList.remove('show');
    els.hint.hidden = false;
    els.input.value = '';
    state.lastText = '';
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    await bootSeq();
    els.input.focus({ preventScroll: true });
  });

  $$('.linklike').forEach((btn) => {
    btn.addEventListener('click', () => {
      els.input.value = btn.dataset.example || '';
      els.form.requestSubmit();
    });
  });

  /* ---------- draggable windows (desktop) ---------- */

  if (window.matchMedia('(min-width: 821px)').matches) {
    let z = 10;
    $$('.win').forEach((win) => {
      const bar = win.querySelector('.win-bar');
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      win.addEventListener('pointerdown', () => { win.style.zIndex = String(++z); });
      bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        win.classList.add('dragging');
        sx = e.clientX;
        sy = e.clientY;
        try {
          const m = new DOMMatrixReadOnly(getComputedStyle(win).transform);
          ox = m.m41;
          oy = m.m42;
        } catch (_) { ox = 0; oy = 0; }
        try { bar.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      bar.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        win.style.transform = `translate(${ox + e.clientX - sx}px, ${oy + e.clientY - sy}px)`;
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        win.classList.remove('dragging');
        try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
      };
      bar.addEventListener('pointerup', end);
      bar.addEventListener('pointercancel', end);
      bar.addEventListener('dblclick', () => { win.style.transform = ''; });
    });
  }

  /* ---------- clock / boot ---------- */

  function tickClock() {
    const d = new Date();
    els.clock.textContent = d.toLocaleTimeString('en-US', { hour12: false });
  }
  tickClock();
  window.setInterval(tickClock, 1000);

  window.addEventListener('resize', resizeRain, { passive: true });
  resizeRain();
  if (!reduce) window.requestAnimationFrame(drawRain);

  (async () => {
    await bootSeq();
    const biz = qs.get('biz');
    const city = qs.get('city');
    if (biz) {
      els.input.value = biz + (city ? ', ' + city : '');
      await sleep(400);
      els.form.requestSubmit();
      return;
    }
    els.input.focus({ preventScroll: true });
  })();
})();
