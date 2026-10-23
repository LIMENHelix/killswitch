// Admin panel app markup. Served only from api/admin.js action "shell" after
// the key validates (owner OR rep - reps legitimately work this call list),
// so the operational screens no longer ship in the publicly fetchable
// static admin.html. Keep in sync with the element ids that admin.html
// script wires up after injection.
export const APP_HTML = `
    <div class="top">
      <div><h1 id="pageTitle">Outreach autopilot</h1><div class="sub" id="pageSub">Mail runs on your approval, then work the calls. Board updates live as postcards go out.</div></div>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="whoami" id="whoami" hidden></span>
        <button class="btn ghost sm" id="signout">Sign out</button>
      </div>
    </div>

    <details class="runbook">
      <summary>How to run this system &mdash; read me first</summary>
      <div class="rb">

        <h3>The four screens</h3>
        <table class="rbt">
          <tr><td><a href="/" target="_blank">livelocalsites.com</a></td><td>The public site. The form on the front page is how new customers ask for a free website.</td></tr>
          <tr><td><a href="/admin" target="_blank">/admin</a></td><td>This page. The postcard machine and the lead board.</td></tr>
          <tr><td><a href="/master" target="_blank">/master</a></td><td>Customer accounts, live monthly revenue, and where you onboard someone after you build their site. <b>Owner sign-in only.</b></td></tr>
          <tr><td><a href="/panel" target="_blank">/panel</a></td><td>The customer's own screen. They reach it by a private link we email them. There is no password.</td></tr>
        </table>

        <h3>Two kinds of sign-in</h3>
        <table class="rbt">
          <tr><td>Owner</td><td>Everything: postage, the autopilot, /master, customer billing, onboarding.</td></tr>
          <tr><td>Rep</td><td>This call list only. Open a script, dial, log the outcome, take a note. A rep cannot spend postage, arm the mailer, or open /master or a customer's panel. Each rep has their <b>own</b> key, so whoever moves a lead is stamped on it in the Owner column, and taking one person's key away does not touch anyone else's.</td></tr>
        </table>
        <p class="warn">What the customer buys is the <b>work</b>, not the website. The site is a generic template, free forever, theirs to keep. Having us change it by hand is the <b>Care Plan</b> ($99/mo), and small edits come with <b>Hosting &amp; Maintenance</b> ($29/mo). A free customer asking for changes gets shown that offer, not a work order. Never promise free edits on a call.</p>

        <h3>How you find out something happened</h3>
        <table class="rbt">
          <tr><td class="ok">Email</td><td><b>Someone wants a free website.</b> Subject starts with &#128276; FREE SITE request. Their business name, phone and email are in it.</td></tr>
          <tr><td class="ok">Email</td><td><b>An existing customer wants a change to their site.</b> Subject is &ldquo;Live Local Sites &middot; site change request&rdquo;.</td></tr>
          <tr><td class="ok">Email</td><td><b>A customer switched a paid module ON.</b> Subject &ldquo;Switch change&rdquo;. It says whether billing has already started, or whether they only reached the Stripe checkout and have yet to pay.</td></tr>
          <tr><td class="ok">Email</td><td><b>A customer paid for the first time.</b> Subject starts with PAID. This is the moment they become a paying customer.</td></tr>
          <tr><td class="ok">Email</td><td><b>A customer switched a paid module OFF.</b> Subject &ldquo;Switch OFF&rdquo;. It keeps working until the end of the cycle they already paid for, then stops.</td></tr>
          <tr><td class="ok">Email</td><td><b>A booking came in</b> through a customer&rsquo;s website. The shop owner is emailed too.</td></tr>
        </table>
        <p class="warn">Every money event now emails you, so there is no weekly check to remember. Two things are still worth knowing: the emails are <b>notifications, not a record</b>, so /master remains the place to see who is actually paying and what renews when; and if an email ever fails to send, the switch still works &mdash; notifications can never block a customer.</p>

        <h3>What to do each day</h3>
        <ol>
          <li>Check email for the two subjects above.</li>
          <li><b>Free site request:</b> build their site, then go to <a href="/master" target="_blank">/master</a> &rarr; Onboard a customer &rarr; enter their email. That emails them a $0 receipt and their private panel link.</li>
          <li><b>Change request:</b> make the change, then open <a href="/master" target="_blank">/master</a> and mark its work order complete. The lifecycle advances and the customer is emailed automatically.</li>
          <li>Work the call list below. Every row has a <b>Script</b> button: it opens the five-step call, that shop's own hook, and the follow-up text ready to copy. Rows that say <b>Script + demo</b> already have a site built, so that call is a delivery. Rows that say only <b>Script</b> do not, and the script says so at the top rather than letting you promise a site that does not exist. Filter the list by <b>Has a demo built</b> to work the deliveries first.</li>
          <li><b>Once a week</b>, open <a href="/master" target="_blank">/master</a> to see the whole picture: who is paying, monthly revenue, and the Renews / Ends column. A date in red means that customer is winding down and will stop at the end of their cycle.</li>
        </ol>

        <h3>Their website already exists before you call</h3>
        <p>A draft site is built for every lead in the list. It is <b>invisible</b>: the address returns "not found" to anyone who tries it, including the business, including Google. That is what makes it safe to have built one for a shop that has never heard of us.</p>
        <table class="rbt">
          <tr><td>Draft &middot; 404</td><td>Built and waiting. Nobody can see it. This is where every generated site starts.</td></tr>
          <tr><td>Live &middot; noindex</td><td>You hit <b>Publish their site</b> on the call, so the link works and you can text it. Search engines are still kept out, because they have not signed up for anything yet.</td></tr>
          <tr><td>Customer</td><td>They said yes and got onboarded in /master. Now it is their site properly, and it can show up on Google.</td></tr>
        </table>
        <p class="warn"><b>Do not send a link before you publish.</b> The script will not let you copy the follow-up text until you have, because a link that 404s in front of a shop owner is worse than never calling. Publish, then copy, then send, while you are still on the phone.</p>

        <h3>The postcard machine, in plain terms</h3>
        <table class="rbt">
          <tr><td>K6 outreach panel</td><td>The <b>only</b> thing that sends postcards. Its switch, mode, channels, caps and spend limits arm the scheduled cron and both manual send buttons. Nothing mails while it is unarmed.</td></tr>
          <tr><td>Per-card reserve ¢</td><td>The budget each card counts against the spend caps. You choose the number; arming is impossible without it. It is a reservation, not a claim about Lob's price.</td></tr>
          <tr><td>Run K6 outreach now</td><td>Sends immediately instead of waiting for the scheduled run, through the same eligibility, caps and idempotency. Disabled while unarmed.</td></tr>
          <tr><td>Approve &amp; mail selected</td><td>Mails only the rows you ticked, through the same K6 path. Disabled while K6 is unarmed.</td></tr>
          <tr><td>Legacy autopilot</td><td>The pre-K6 panel. Historical only: its switch and ceiling no longer send anything. The mailed and spend counters above come from the lead ledger, so the history they show is real.</td></tr>
        </table>
        <p class="warn">Postage is billed by Lob per card actually sent. The K6 spend caps count the per-card reserve you set, never a guessed price.</p>

        <h3>How to stop things</h3>
        <table class="rbt">
          <tr><td>Stop the mail</td><td>Save the K6 outreach panel with its switch off. Nothing further is sent, and nothing is charged.</td></tr>
          <tr><td>Stop one contact everywhere</td><td>Use <b>Suppress</b> on their row. It immediately blocks postcards, call scripts, copied texts, and AI-written email sequences that match their lead, email, phone, or address. Only the owner can lift it.</td></tr>
          <tr><td>Stop a customer's paid module</td><td>They can switch it off themselves in their panel. It keeps running until the end of the cycle they already paid for, then stops. You can also cancel it in Stripe.</td></tr>
          <tr><td>Stop everything at once</td><td>K6 outreach off here, and pause the account in Stripe. The free websites stay online either way, and they belong to the customer.</td></tr>
        </table>

        <h3>What money is where</h3>
        <table class="rbt">
          <tr><td>Lob</td><td>Postage. Real money leaves here every time a postcard is sent. If it runs dry, sends just fail quietly.</td></tr>
          <tr><td>Stripe</td><td>Customer subscriptions, $19 to $29 a month per module. This is the income.</td></tr>
          <tr><td>The K6 spend caps on this page</td><td>A safety limit we set on ourselves. They do not hold money, they just stop the mailing.</td></tr>
        </table>

      </div>
    </details>

    <!-- LIVE STATUS BOARD -->
    <section class="board">
      <div class="board-head">
        <div class="live"><span class="dot"></span> <span id="liveLabel">Live · auto-refreshing</span></div>
        <div class="spend ownerOnly" id="spendWrap">Spend to date<b id="spend">$0</b></div>
      </div>
      <div class="prog-top">
        <span class="pct" id="pct">0%</span>
        <span class="cap">of your mailable list reached by postcard</span>
      </div>
      <div class="track"><div class="fill" id="fill"></div></div>
      <div class="prog-sub"><span id="mailedN">0</span> mailed · <span id="queueN">0</span> still in queue</div>
      <div class="tiles" id="tiles"></div>
    </section>

    <!-- LASER FUNNEL. Read-only, so reps see it too: the endpoint allows it and
         a caller who cannot see what is working cannot get better at it. -->
    <section class="laser" id="laser" hidden>
      <div class="laser-h">
        <h2>Funnel</h2>
        <span class="note">Ranked by lower-bound confidence, so one win from one try does not outrank forty from a hundred.</span>
      </div>
      <div class="stages" id="stages"></div>
      <div class="laser-sub" id="laserSub"></div>
      <div id="playsWrap"></div>
    </section>

    <!-- LEGACY AUTOPILOT (pre-K6) — HISTORICAL ONLY. This panel's switch, daily
         cap and budget ceiling stopped driving sends when every mail path moved
         onto the armed K6 control plane; the server now refuses writes to it.
         The stored values are shown read-only as a historical record. The
         mailed/spend counters come from the lead ledger itself and are real.
         The K6 outreach panel below is the ONLY sender. -->
    <section class="autopanel ownerOnly" id="autopanel">
      <div class="ap-head">
        <div class="ap-title">Legacy autopilot <span class="ap-state off" id="apState">SUPERSEDED</span></div>
      </div>
      <div class="ap-sub" id="apSub">This pre-K6 autopilot no longer sends anything — its switch and caps have no sender behind them. Every postcard, manual or scheduled, runs through the K6 outreach control plane below, and only that switch arms mail.</div>
      <div class="ap-budget" id="apBudgetNote"></div>
      <div class="ap-last" id="apLast"></div>
    </section>

    <!-- DISCOVERY (K4): bounded autonomous prospect discovery + ranking.
         Upstream only — this panel can NEVER mail, draft, publish or call from
         here. It shows what the discovery loop found and lets the owner arm or
         disarm it. -->
    <section class="autopanel" id="discpanel">
      <div class="ap-head">
        <div class="ap-title">Discovery <span class="ap-state off" id="discState">OFF</span></div>
      </div>
      <div class="ap-sub" id="discSub">Off. When armed, a cron discovers businesses from Google Places, dedupes them, excludes customers and suppressed contacts, ranks what is left, and stops. It never contacts anyone.</div>
      <div class="tiles" id="discTiles"></div>
      <div class="ap-last" id="discLast"></div>
      <div id="discTopWrap"></div>
      <div class="ap-grid ownerOnly" id="discCfgWrap" hidden>
        <label class="ap-f">Places calls / run<input type="number" id="discPerRun" min="0" step="1" class="f" placeholder="0"></label>
        <label class="ap-f">Places calls / day<input type="number" id="discDaily" min="0" step="10" class="f" placeholder="0"></label>
        <label class="ap-f">Plan slots / run<input type="number" id="discSlots" min="0" step="1" class="f" placeholder="0"></label>
        <label class="ap-f" style="grid-column:1/-1">Plan (one "trade | city" per line)<textarea id="discPlan" class="f" rows="4" placeholder="plumbers | Kansas City, MO"></textarea></label>
        <label class="switch"><input type="checkbox" id="discEnabled"><span class="slider"></span></label>
        <button class="btn sm" id="discSave">Save discovery settings</button>
      </div>
      <div class="ap-last" id="discMsg"></div>
    </section>

    <!-- DRAFT AUTONOMY (K5): ranked candidates → one unpublished site draft each.
         Still no contact, no publish, no customer entitlement. -->
    <section class="autopanel" id="draftpanel">
      <div class="ap-head">
        <div class="ap-title">Draft autonomy <span class="ap-state off" id="draftState">OFF</span></div>
      </div>
      <div class="ap-sub" id="draftSub">Off. When armed, a cron turns ranked discovery candidates into unpublished site drafts, one per business. Drafts are not published and nobody is contacted.</div>
      <div class="tiles" id="draftTiles"></div>
      <div class="ap-last" id="draftLast"></div>
      <div class="ap-grid ownerOnly" id="draftCfgWrap" hidden>
        <label class="ap-f">Drafts / run<input type="number" id="draftPerRun" min="0" step="1" class="f" placeholder="0"></label>
        <label class="ap-f">Minimum score<input type="number" id="draftMinScore" min="0" step="0.1" class="f" placeholder="0"></label>
        <label class="switch"><input type="checkbox" id="draftEnabled"><span class="slider"></span></label>
        <button class="btn sm" id="draftSave">Save draft settings</button>
      </div>
      <div class="ap-last" id="draftMsg"></div>
    </section>

    <!-- K6 OUTREACH: autonomous prospect contact. Owner-only config; manual trigger here, cron otherwise. -->
    <section class="autopanel ownerOnly" id="outreachpanel">
      <div class="ap-head">
        <div class="ap-title">K6 outreach <span class="ap-state off" id="outreachState">OFF</span></div>
      </div>
      <div class="ap-sub" id="outreachSub">Off. When armed, the autonomous outreach loop sends postcards to in-queue leads, bounded by caps and spend limits.</div>
      <div class="ap-last">Supported transport: postcard (Lob). Channels, mode, and caps are unset until the owner saves them here — nothing mails while they are blank.</div>
      <div class="tiles" id="outreachTiles"></div>
      <div class="ap-last" id="outreachBlockers"></div>
      <div class="ap-last" id="outreachLast"></div>
      <div class="ap-grid ownerOnly" id="outreachCfgWrap" hidden>
        <label class="switch"><input type="checkbox" id="outreachEnabled"><span class="slider"></span></label>
        <label class="ap-f">Mode<select id="outreachMode" class="f"><option value="autonomous">autonomous</option><option value="manual">manual</option><option value="test">test</option></select></label>
        <label class="ap-f" style="grid-column:1/-1">Channels (one per line)<textarea id="outreachChannels" class="f" rows="2" placeholder="postcard"></textarea></label>
        <label class="ap-f">Per-run cap<input type="number" id="outreachPerRun" min="0" step="1" class="f" placeholder="0"></label>
        <label class="ap-f">Daily cap<input type="number" id="outreachDaily" min="0" step="1" class="f" placeholder="0"></label>
        <label class="ap-f">Lifetime cap<input type="number" id="outreachLifetime" min="0" step="1" class="f" placeholder="0"></label>
        <label class="ap-f">Per-run spend cap ¢<input type="number" id="outreachPerRunSpend" min="0" step="1" class="f" placeholder="0"></label>
        <label class="ap-f">Daily spend cap ¢<input type="number" id="outreachDailySpend" min="0" step="1" class="f" placeholder="0"></label>
        <label class="ap-f">Per-card reserve ¢<input type="number" id="outreachReserve" min="0" step="1" class="f" placeholder="0"></label>
        <button class="btn sm" id="outreachSave">Save outreach settings</button>
        <button class="btn ghost sm" id="outreachRun">Run K6 outreach now</button>
      </div>
      <div class="ap-last" id="outreachRuns"></div>
      <div class="ap-last" id="outreachEffects"></div>
      <div class="ap-last" id="followupLine"></div>
      <div class="ap-last ownerOnly" id="readinessWrap" hidden>
        <button class="btn ghost sm" id="readinessCheck">Check canary readiness</button>
        <span id="readinessOut"></span>
      </div>
      <div class="ap-last" id="outreachMsg"></div>
    </section>

    <div class="bar">
      <input class="f" id="q" placeholder="Search business...">
      <select id="fTrade"><option value="">All trades</option></select>
      <select id="fState"><option value="">All states</option></select>
      <select id="fStatus"><option value="">All mail states</option></select>
      <select id="fStage"><option value="">All stages</option></select>
      <select id="fOwner"><option value="">Anyone's</option><option value="__me">Mine</option><option value="__none">Unclaimed</option></select>
      <select id="fDemo"><option value="">Demo or not</option><option value="1">Has a demo built</option><option value="0">No demo yet</option></select>
    </div>
    <div class="toolbar ownerOnly" id="mailbar">
      <button class="btn ghost sm" id="selAll">Select all shown &amp; mailable</button>
      <button class="btn ghost sm" id="selNone">Clear</button>
      <span class="n" id="selCount">0 selected</span>
      <button class="btn sm" id="mailBtn" disabled>📮 Approve &amp; mail selected</button>
      <span class="n" id="mailBtnNote"></span>
    </div>
    <div class="toolbar"><span class="n" id="count"></span></div>
    <div class="msg" id="msg"></div>
    <div class="wrapt" id="wrapt"><table><thead><tr>
      <th class="ownerOnly" id="thChk" style="cursor:default"><input type="checkbox" id="chkAll"></th>
      <th data-k="trade">Trade</th><th data-k="name">Business</th><th data-k="phone">Phone</th>
      <th style="cursor:default">Call</th>
      <th data-k="address">Address</th><th class="ownerOnly" data-k="status">Mail</th>
      <th style="cursor:default">Stage</th><th data-k="owner">Owner</th><th style="cursor:default">Notes</th>
    </tr></thead><tbody id="tb"></tbody></table></div>

  <!-- CALL SCRIPT -->
  <div class="modal" id="scriptModal">
    <div class="sheet">
      <h2 id="scTitle"></h2>
      <div class="who" id="scWho"></div>
      <div class="warn" id="scWarn"></div>
      <div id="scSteps"></div>
      <div class="foot">
        <button class="btn sm" id="scPublish" hidden>Publish their site</button>
        <button class="btn sm" id="scCopyText">Copy the follow-up text</button>
        <button class="btn ghost sm" id="scCalled">Mark called</button>
        <button class="btn ghost sm" id="scClose">Close</button>
        <span class="n" id="scNote"></span>
      </div>
    </div>
  </div>
`;
