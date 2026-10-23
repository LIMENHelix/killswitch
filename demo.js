(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const qs = new URLSearchParams(window.location.search);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? 40 : ms));

  const els = {
    intro: $('#intro'),
    form: $('#buildForm'),
    biz: $('#biz'),
    mic: $('#micBtn'),
    hint: $('#hint'),
    activity: $('#activity'),
    liveTag: $('#liveTag'),
    buildTag: $('#buildTag'),
    stepper: $('#stepper'),
    leadsCity: $('#leadsCity'),
    leadsList: $('#leadsList'),
    trace: $('#trace'),
    voiceLine: $('#voiceLine'),
    speakBtn: $('#speakBtn'),
    cta: $('#cta'),
    previewWrap: $('.preview-wrap'),
    preview: $('#sitePreview'),
    spName: $('#spName'),
    spTrade: $('#spTrade'),
    spHeadline: $('#spHeadline'),
    spSub: $('#spSub'),
    spGrid: $('#spGrid'),
    spAboutCity: $('#spAboutCity'),
    spFootCity: $('#spFootCity'),
  };

  const state = {
    running: false,
    listening: false,
    business: '',
    city: 'Kansas City',
    lastText: '',
    recognition: null,
  };

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

  function setActivity(text, live = false) {
    els.activity.textContent = text;
    els.activity.classList.toggle('live', live);
  }

  function resetSteps() {
    $$('li', els.stepper).forEach((li) => {
      li.className = '';
      const b = li.querySelector('b');
      if (b) b.textContent = '—';
    });
  }

  function setStep(name, stateName, label) {
    const li = els.stepper.querySelector(`[data-step="${name}"]`);
    if (!li) return;
    li.className = stateName;
    const b = li.querySelector('b');
    if (b && label) b.textContent = label;
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
    els.leadsCity.textContent = 'Local demand // ' + city;
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

  function renderTrace(city, key) {
    const cityKey = city.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const lines = [
      `trade=${key}`,
      `city=${cityKey}`,
      'intent=free_starter_site',
      'modules=hero,services,reviews,call,book',
      'constraint=no_template_no_wait',
      'next=claim_domain + google_profile',
    ];
    els.trace.textContent = lines.join('\n');
  }

  function renderSite(business, city, trade) {
    els.spName.textContent = business;
    els.spTrade.textContent = trade.label + ' · ' + city;
    els.spHeadline.textContent = trade.headline;
    els.spSub.textContent = `Serving ${city} and nearby. Call for a same-day quote.`;
    if (els.spAboutCity) els.spAboutCity.textContent = city;
    if (els.spFootCity) els.spFootCity.textContent = city;
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

  function resetPreview(business, city, trade) {
    els.spName.textContent = business;
    els.spTrade.textContent = trade.label + ' · ' + city;
    els.spHeadline.textContent = 'Forging your site…';
    els.spSub.textContent = 'Building the page from the business, the city and the trade.';
    if (els.spAboutCity) els.spAboutCity.textContent = city;
    if (els.spFootCity) els.spFootCity.textContent = city;
    els.spGrid.textContent = '';
    [['Loading', 'Your services'], ['Loading', 'Your proof'], ['Loading', 'Your next step']].forEach(([a, b]) => {
      const card = document.createElement('div');
      card.className = 'sp-card';
      const x = document.createElement('b'); x.textContent = a;
      const y = document.createElement('span'); y.textContent = b;
      card.append(x, y);
      els.spGrid.appendChild(card);
    });
  }

  async function runDemo(raw) {
    if (state.running) return;
    const { business, city } = parseInput(raw);
    const key = inferTrade(business);
    const trade = TRADES[key] || TRADES.default;
    state.business = business;
    state.city = city;
    state.running = true;

    els.biz.blur();
    els.hint.hidden = true;
    els.cta.hidden = true;
    els.liveTag.textContent = 'BUILDING';
    els.liveTag.className = 'tag building';
    els.buildTag.textContent = 'RUN';
    els.speakBtn.disabled = true;
    els.voiceLine.textContent = 'Building the summary…';
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    resetSteps();
    resetPreview(business, city, trade);

    setActivity('Scanning local demand…');
    setStep('scan', 'active', 'RUN');
    await sleep(650);
    renderLeads(trade, city, business);
    setStep('scan', 'done', 'OK');

    setActivity('Tracing the market…');
    setStep('trace', 'active', 'RUN');
    await sleep(650);
    renderTrace(city, key);
    setStep('trace', 'done', 'OK');

    setActivity('Forging the page…');
    setStep('forge', 'active', 'RUN');
    await sleep(800);
    renderSite(business, city, trade);
    setStep('forge', 'done', 'OK');

    setActivity('Verifying mobile, speed and schema…');
    setStep('verify', 'active', 'RUN');
    await sleep(600);
    setStep('verify', 'done', 'OK');

    setActivity('Publishing…');
    setStep('live', 'active', 'RUN');
    await sleep(600);
    setStep('live', 'done', 'OK');

    els.liveTag.textContent = 'LIVE';
    els.liveTag.className = 'tag live';
    els.buildTag.textContent = 'LIVE';
    state.lastText = `${business} in ${city}. I can have a starter site live today. Want the link?`;
    els.voiceLine.textContent = state.lastText;
    els.speakBtn.disabled = false;
    els.cta.hidden = false;
    setActivity('Live. The page is ready.', true);

    if (window.matchMedia('(max-width: 640px)').matches && els.previewWrap) {
      window.setTimeout(() => {
        els.previewWrap.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      }, 350);
    }
    state.running = false;
  }

  const VOICE_ERRORS = {
    'not-allowed': 'Microphone access is blocked. Allow the mic in your browser, then try again — or type the name.',
    'service-not-allowed': 'Speech recognition is blocked by this browser. Type the name instead.',
    'audio-capture': 'No microphone was found. Type the name instead.',
    network: 'Speech recognition could not reach the service. Type the name instead.',
    'no-speech': 'I did not hear anything. Try again, or type it.',
    aborted: 'Voice input stopped.',
  };

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const rec = new SpeechRecognition();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      state.listening = true;
      els.mic.classList.add('listening');
      els.mic.textContent = 'LISTEN';
      setActivity('Listening…');
    };
    rec.onresult = (event) => {
      const text = event.results && event.results[0] && event.results[0][0] && event.results[0][0].transcript;
      if (!text) return;
      els.biz.value = text;
      setActivity('Heard: ' + text);
      window.setTimeout(() => els.form.requestSubmit(), 300);
    };
    rec.onerror = (event) => {
      const msg = VOICE_ERRORS[event.error] || ('Voice input failed: ' + (event.error || 'unknown'));
      els.voiceLine.textContent = msg;
      setActivity('Voice blocked. Type it instead.');
      els.biz.focus({ preventScroll: true });
    };
    rec.onend = () => {
      state.listening = false;
      els.mic.classList.remove('listening');
      els.mic.textContent = 'MIC';
    };
    state.recognition = rec;
  }

  els.mic.addEventListener('click', () => {
    if (!state.recognition) {
      els.voiceLine.textContent = 'Voice input is not supported in this browser. Type the name instead.';
      setActivity('Voice not supported.');
      return;
    }
    if (state.listening) { state.recognition.stop(); return; }
    try { state.recognition.start(); }
    catch (_) { setActivity('Voice is busy. Try again.'); }
  });

  els.speakBtn.addEventListener('click', () => {
    if (!('speechSynthesis' in window)) {
      els.voiceLine.textContent = 'Speech output is not supported in this browser.';
      return;
    }
    if (!state.lastText) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(state.lastText);
    u.rate = 1;
    u.pitch = 0.95;
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((v) => /Google US English|Samantha|Daniel|Alex/i.test(v.name)) ||
      voices.find((v) => v.lang === 'en-US');
    if (preferred) u.voice = preferred;
    u.onstart = () => { els.speakBtn.textContent = 'SPEAKING…'; };
    u.onend = () => { els.speakBtn.textContent = 'HEAR THE PITCH'; };
    u.onerror = () => { els.speakBtn.textContent = 'HEAR THE PITCH'; };
    window.speechSynthesis.speak(u);
  });

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = els.biz.value.trim();
    if (!raw) {
      setActivity('Need a business name.');
      els.biz.focus();
      return;
    }
    runDemo(raw);
  });

  $$('.linklike').forEach((btn) => {
    btn.addEventListener('click', () => {
      els.biz.value = btn.dataset.example || '';
      els.form.requestSubmit();
    });
  });

  function afterIntro() {
    const biz = qs.get('biz');
    const city = qs.get('city');
    if (biz) {
      els.biz.value = biz + (city ? ', ' + city : '');
      window.setTimeout(() => els.form.requestSubmit(), 350);
      return;
    }
    els.biz.focus({ preventScroll: true });
  }

  if (reduce || !els.intro) {
    if (els.intro) els.intro.remove();
    afterIntro();
  } else {
    window.setTimeout(() => {
      els.intro.classList.add('done');
      window.setTimeout(() => els.intro.remove(), 500);
      afterIntro();
    }, 2200);
  }
})();
