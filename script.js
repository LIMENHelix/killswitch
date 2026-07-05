/* ============================================================
   KILLSWITCH Web Studio — interactions
   Everything here is vanilla JS. No build step, no dependencies.
   Clone the folder, change text, push to Vercel — it's live.
   ============================================================ */

/* ---------- Mobile nav ---------- */
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
navToggle?.addEventListener('click', () => navLinks.classList.toggle('open'));
navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => navLinks.classList.remove('open')));

/* ---------- FAQ accordion ---------- */
document.querySelectorAll('.faq__item').forEach(item => {
  const q = item.querySelector('.faq__q');
  const a = item.querySelector('.faq__a');
  q.addEventListener('click', () => {
    const open = item.classList.toggle('open');
    a.style.maxHeight = open ? a.scrollHeight + 'px' : null;
  });
});

/* ---------- Animated stat counters ---------- */
const counters = document.querySelectorAll('[data-count]');
const runCounter = el => {
  const target = +el.dataset.count;
  let n = 0;
  const step = Math.max(1, Math.ceil(target / 40));
  const tick = () => {
    n = Math.min(target, n + step);
    el.textContent = n;
    if (n < target) requestAnimationFrame(tick);
  };
  tick();
};

/* ---------- Reveal-on-scroll + fire counters ---------- */
const revealEls = document.querySelectorAll('.caps, .statement, .steps, .case, .dash, .tiers, .hero__stats, .contact');
revealEls.forEach(el => el.setAttribute('data-reveal', ''));
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    e.target.classList.add('in');
    e.target.querySelectorAll('[data-count]').forEach(c => { if (!c.dataset.done) { c.dataset.done = 1; runCounter(c); } });
    io.unobserve(e.target);
  });
}, { threshold: 0.2 });
revealEls.forEach(el => io.observe(el));
// hero stats fire immediately
document.querySelectorAll('.hero__stats [data-count]').forEach(c => { c.dataset.done = 1; runCounter(c); });

/* ---------- Live data feed (real Open-Meteo API, no key) ----------
   Proves a genuine live integration. Swap the endpoint for any data
   source — prices, inventory, bookings — same pattern. */
(async () => {
  const tEl = document.getElementById('wxTemp');
  const dEl = document.getElementById('wxDesc');
  if (!tEl) return;
  const codes = { 0:'Clear sky', 1:'Mostly clear', 2:'Partly cloudy', 3:'Overcast', 45:'Foggy', 48:'Foggy',
    51:'Light drizzle', 53:'Drizzle', 61:'Light rain', 63:'Rain', 65:'Heavy rain', 71:'Light snow',
    73:'Snow', 80:'Rain showers', 81:'Showers', 95:'Thunderstorm' };
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=39.10&longitude=-94.58&current=temperature_2m,weather_code&temperature_unit=fahrenheit');
    const j = await r.json();
    tEl.textContent = Math.round(j.current.temperature_2m) + '°';
    dEl.textContent = (codes[j.current.weather_code] || 'Live') + ' · updated just now';
  } catch (_) { dEl.textContent = 'live feed'; }
})();

/* Mini bookings bar chart */
const bars = document.getElementById('bars');
if (bars) [42, 65, 48, 80, 58, 92, 74].forEach(h => {
  const b = document.createElement('i');
  b.style.setProperty('--h', h + '%');
  bars.appendChild(b);
});

/* ---------- Forms → Web3Forms (client-side; your email stays hidden) ----------
   The key below is a Web3Forms "access key" — safe to expose. It maps to your
   email (limenhelix@proton.me) on Web3Forms' servers; the address itself never
   appears here. Web3Forms requires client-side submission (server calls are
   blocked unless on their Pro plan), so this runs in the browser. */
const WEB3FORMS_KEY = 'fd068540-d6c4-44e3-9f5b-3d46da7c44ed';
async function sendLead(payload, noteEl, formEl) {
  let ok = false, msg = '';
  try {
    const r = await fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        access_key: WEB3FORMS_KEY,
        subject: `🔔 New lead (${payload.source || 'website'}) — KILLSWITCH`,
        from_name: 'KILLSWITCH Website',
        ...payload,
      }),
    });
    const data = await r.json().catch(() => ({}));
    ok = !!data.success;
    msg = data.message || ('HTTP ' + r.status);
    console.log('[KILLSWITCH lead] status', r.status, data);
  } catch (e) { msg = String(e); }
  if (noteEl) {
    noteEl.hidden = false;
    if (ok) {
      noteEl.innerHTML = '✓ Sent! Skip the wait — <a href="https://calendly.com/chrishubbel72/30min" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">talk to a real, live human →</a>';
      noteEl.style.color = '';
    } else {
      noteEl.textContent = '⚠ Not sent: ' + msg;
      noteEl.style.color = '#ef4444';
    }
  }
  if (ok) formEl.reset();
}

const leadform = document.getElementById('leadform');
leadform?.addEventListener('submit', e => {
  e.preventDefault();
  const [name, email] = leadform.querySelectorAll('input');
  const message = leadform.querySelector('textarea');
  sendLead(
    { name: name.value, contact: email.value, message: message.value, source: 'lead form' },
    document.getElementById('leadNote'), leadform
  );
});

const contactForm = document.getElementById('contactForm');
contactForm?.addEventListener('submit', e => {
  e.preventDefault();
  const [name, contact, business] = contactForm.querySelectorAll('input');
  sendLead(
    { name: name.value, contact: contact.value, business: business.value, source: 'contact CTA' },
    document.getElementById('contactOk'), contactForm
  );
});

/* ============================================================
   THE "BOX ON THE BOTTOM" — AI concierge
   ------------------------------------------------------------
   Right now it runs on a local rules-based responder so the demo
   works with zero cost and zero backend. To make it a REAL AI
   concierge, replace `botReply()` with a fetch() to a serverless
   function that calls the Claude API (see README → "Go live AI").
   ============================================================ */
const chatLaunch = document.getElementById('chatLaunch');
const chatPanel  = document.getElementById('chatPanel');
const chatClose  = document.getElementById('chatClose');
const chatForm   = document.getElementById('chatForm');
const chatText   = document.getElementById('chatText');
const chatLog    = document.getElementById('chatLog');
let greeted = false;

/* Tiny, safe markdown renderer for bot bubbles — bold + links only.
   Escapes HTML first, then allows **bold** and [label](url) for http(s)
   or root-relative URLs. Nothing else is interpreted, so it can't inject. */
function renderMarkdown(text) {
  let s = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (m, label, url) => {
    const ext = /^https?:/i.test(url);
    return `<a href="${url}"${ext ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s.replace(/\n/g, '<br>');
}

function addMsg(text, who) {
  const div = document.createElement('div');
  div.className = `msg msg--${who}`;
  if (who === 'bot') div.innerHTML = renderMarkdown(text);
  else div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function openChat() {
  chatPanel.hidden = false;
  chatLaunch.style.display = 'none';
  if (!greeted) {
    greeted = true;
    setTimeout(() => addMsg("Hey! 👋 I'm the Killswitch assistant. Ask me about pricing, timelines, what we can build, or **Switch** (our AI sales rep).", 'bot'), 350);
  }
  setTimeout(() => chatText.focus(), 100);
}
function closeChat() { chatPanel.hidden = true; chatLaunch.style.display = ''; }
chatLaunch?.addEventListener('click', openChat);
chatClose?.addEventListener('click', closeChat);

/* Local responder — swap for a Claude API call to go fully live. */
function botReply(input) {
  const q = input.toLowerCase();
  if (/(price|cost|how much|pricing|\$)/.test(q))
    return "Builds start at $750 one-time, then $149/mo for the Care Plan — that includes hosting and unlimited small edits you just text us. Want me to grab your info for a custom quote?";
  if (/(time|long|fast|turnaround|when)/.test(q))
    return "Most new sites go live in about a week. After that, day-to-day edits are usually live the same day — often within minutes.";
  if (/(edit|change|update|adjust|text|demand)/.test(q))
    return "You just text or email us the change — 'new hours', 'add a promo', 'swap the photo' — and we make it live for you. No dashboards to learn. Scroll up to the 'Adjust live' section to try it yourself!";
  if (/(ai|concierge|chat|bot|box)/.test(q))
    return "This very chat box is the AI concierge we add to your site. It answers FAQs and captures leads 24/7, so you never miss a customer after hours.";
  if (/(book|appointment|consult|call|meeting)/.test(q))
    return "Happy to set that up. Drop your name and phone or email in the form below the pricing and we'll reach out within a business day.";
  if (/(demo|example|show|see)/.test(q))
    return "Everything on this page is a live component we'd build for you — stat bands, pricing cards, forms, galleries. The 'Adjust live' section even lets you change the color and headline yourself. 🎨";
  if (/(hello|hi|hey|yo)/.test(q))
    return "Hi there! What kind of business is the site for? I can point you to the right starting package.";
  if (/(thank|thanks|cool|nice|awesome)/.test(q))
    return "Anytime! Want me to have someone follow up with a plan and price?";
  return "Good question — a real person can give you the exact answer. Pop your contact in the form by the pricing and we'll get right back to you. Meanwhile, the pricing section above covers the basics. 🙂";
}

/* Real AI concierge — POSTs the conversation to /api/chat (Claude Haiku).
   Falls back to the local botReply() responder if the API isn't configured
   or errors, so the chat always works. */
const chatHistory = [];
chatForm?.addEventListener('submit', async e => {
  e.preventDefault();
  const text = chatText.value.trim();
  if (!text) return;
  addMsg(text, 'user');
  chatText.value = '';
  chatHistory.push({ role: 'user', content: text });
  const typing = addMsg('typing…', 'bot');
  typing.classList.add('msg--typing');

  let reply = '';
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory.slice(-8) }),
    });
    if (r.ok) {
      const data = await r.json();
      reply = (data && data.reply) ? data.reply : '';
    }
  } catch (_) { /* fall through to the local responder */ }

  typing.remove();
  if (!reply) reply = botReply(text);            // graceful fallback
  addMsg(reply, 'bot');
  chatHistory.push({ role: 'assistant', content: reply });
});

/* ============================================================
   The White Rabbit — scurries across the page; click to follow
   it down the hole (→ /menu). Skips the fine-dining Reserve room
   and anyone who prefers reduced motion.
   ============================================================ */
(function () {
  return; // White Rabbit retired for the serious version (kept here for easy revival)
  if (document.body.classList.contains('rsv')) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var rabbit = document.createElement('div');
  rabbit.className = 'wr';
  rabbit.title = 'Follow the white rabbit…';
  rabbit.innerHTML = '<div class="wr-bubble">I\'m late, I\'m late! ⏱</div><div class="wr-figure"><div class="wr-lottie"></div></div>';
  rabbit.addEventListener('click', function () { window.location.href = '/menu'; });

  var figure, ltr = true, started = false;

  function dash() {
    rabbit.classList.remove('run', 'run-rtl', 'show-bubble');
    figure.classList.toggle('left', !ltr);   // face the direction of travel
    void rabbit.offsetWidth;                  // reflow → restart the animation
    rabbit.classList.add(ltr ? 'run' : 'run-rtl');
    setTimeout(function () { rabbit.classList.add('show-bubble'); }, 1600);
    setTimeout(function () { rabbit.classList.remove('show-bubble'); }, 4200);
    ltr = !ltr;
  }
  rabbit.addEventListener('animationend', function () {
    rabbit.classList.remove('run', 'run-rtl', 'show-bubble');
  });
  function schedule() { if (started) return; started = true; dash(); setInterval(dash, 23000); }

  // Defer the player + JSON (~380KB) until the page has settled, then render
  // the Lottie rabbit. If the player can't load, quietly remove the rabbit.
  setTimeout(function () {
    document.body.appendChild(rabbit);
    figure = rabbit.querySelector('.wr-figure');
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js';
    s.onload = function () {
      try {
        var anim = window.lottie.loadAnimation({
          container: rabbit.querySelector('.wr-lottie'),
          renderer: 'svg', loop: true, autoplay: false, path: '/rabbit.json'
        });
        // Loop ONLY the running frames (0–132); skip the "rabbit stopped"
        // sit (133–207) so he's never gliding while seated.
        anim.addEventListener('DOMLoaded', function () { anim.playSegments([0, 132], true); });
        schedule();
      } catch (e) { rabbit.remove(); }
    };
    s.onerror = function () { rabbit.remove(); };
    document.head.appendChild(s);
  }, 3500);
})();
