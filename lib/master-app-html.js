// Master Panel app markup. Served only from api/master.js action "shell" after
// owner-key authentication, so the operational screens no longer ship in the
// publicly fetchable static master.html. Keep in sync with the element ids
// that master.html script wires up after injection.
export const APP_HTML = `
    <div class="top">
      <div><h1>Master Panel</h1><div class="sub">Every customer, their plan and switches, and revenue. Onboard a new one below.</div></div>
      <div class="links">
        <a class="btn ghost sm" href="/switch-brain" target="_blank" rel="noopener">AI sales rep →</a>
        <a class="btn ghost sm" href="/admin">Outreach admin →</a>
        <button class="btn ghost sm" id="signout">Sign out</button>
      </div>
    </div>

    <div class="tiles" id="tiles"></div>

    <div class="card" id="scorecardCard">
      <h2>Weekly operating scorecard</h2>
      <div class="h-sub" id="scPeriod">Loading the previous complete week…</div>
      <div class="tiles" id="scTiles" style="margin-bottom:12px"></div>
      <div class="onres" id="scMsg"></div>
      <div class="wrapt"><table><thead><tr><th>Source</th><th>Medium</th><th>Campaign</th><th>Trade</th><th>City</th><th>Valid signups</th></tr></thead><tbody id="scTb"></tbody></table></div>
      <div class="fine2" id="scGaps"></div>
    </div>

    <div class="card">
      <h2>Onboard a customer</h2>
      <div class="h-sub">Creates their free account and emails a $0 receipt with their portal link. No card, no Stripe.</div>
      <div class="row">
        <label class="f">Email<input id="oEmail" type="email" placeholder="owner@shop.com" /></label>
        <label class="f">Site<input id="oSite" type="text" placeholder="theirshop.com" /></label>
        <label class="f">Name<input id="oName" type="text" placeholder="First name" /></label>
        <label class="f">Their site slug<input id="oSlug" type="text" placeholder="daves-trusted-auto" list="slugList" /><datalist id="slugList"></datalist></label>
        <button class="btn sm" id="oBtn">Create &amp; send receipt</button>
      </div>
      <div class="onres" id="oRes"></div>
    </div>

    <div class="card" id="workCard">
      <h2>Customer work orders</h2>
      <div class="h-sub">Paid change requests stay here until the work is actually marked complete. Completion records the lifecycle event and emails the customer.</div>
      <div class="onres" id="wMsg"></div>
      <div class="wrapt"><table><thead><tr><th>Customer</th><th>Requested</th><th>Work</th><th>Status</th><th></th></tr></thead><tbody id="wTb"></tbody></table></div>
    </div>

    <div class="card" id="billingCard">
      <h2>Billing exceptions</h2>
      <div class="h-sub">Failed payments, refunds, and disputes from verified Stripe webhooks. These records remain here even after the issue is resolved.</div>
      <div class="onres" id="bMsg"></div>
      <div class="wrapt"><table><thead><tr><th>When</th><th>Event</th><th>Customer</th><th>Amount</th><th>Status / reason</th></tr></thead><tbody id="bTb"></tbody></table></div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div>
          <h2>Customer websites</h2>
          <div class="h-sub">One template, many sites. Fill in the details, tick the modules, publish. Turning a module off here removes it from their live site.</div>
        </div>
        <button class="btn ghost sm" id="sNew">+ New website</button>
      </div>

      <!-- TAKE A PAGE THAT ALREADY EXISTS AND MAKE IT THEIRS.
           This used to live inside the editor, which meant opening a record and
           retyping a business name that is already in the page's own <title>,
           to describe a site that is already built. Nothing here is a second
           website: the record is the container that lets /s/<slug> serve the
           page and lets their switches change it. Slug comes from the URL,
           business name comes from the title, content comes from the page. -->
      <div style="margin-top:16px;border:1px solid var(--line);border-radius:12px;padding:14px">
        <div class="rl">Step 1 &middot; Show the owner what we built</div>
        <div class="fine2">Point it at a page we have already built. It reads the business name off the page, puts it live at its own address, and emails the owner their panel link. <b>Google cannot see it yet</b>: the page carries noindex until you press Step 2, so if they go quiet, nothing of theirs was ever public. Nothing is retyped and nothing is duplicated.</div>
        <div class="row" style="margin-top:10px">
          <label style="flex:2 1 320px">Page
            <input id="gvSrc" placeholder="/demos/auto-tech-shawnee" />
          </label>
          <label style="flex:1 1 220px">Owner email
            <input id="gvEmail" type="email" placeholder="owner@theirshop.com" />
          </label>
          <label style="flex:1 1 150px">Owner name
            <input id="gvName" placeholder="First name" />
          </label>
        </div>
        <div class="row" style="margin-top:10px;align-items:center">
          <button class="btn" type="button" id="gvGo">Send it to the owner</button>
          <button class="btn ghost sm" type="button" id="gvCheck">Check settings</button>
        </div>
        <div class="onres" id="gvRes"></div>

        <!-- STEP 2, deliberately its own act. Claiming is the only thing that
             removes noindex, so it is the moment a business's name becomes
             public on a page they did not ask for if it is done too early. -->
        <div class="rl" style="margin-top:18px">Step 2 &middot; They said yes</div>
        <div class="fine2">Only press this once the owner has actually accepted. It removes the noindex, which is the point of no return: from here Google can find and keep their page. Everything before this is invisible to search.</div>
        <div class="row" style="margin-top:10px;align-items:center">
          <label style="flex:1 1 300px">Their web address (slug)
            <input id="gvClaimSlug" placeholder="their-business-name" />
          </label>
          <button class="btn" type="button" id="gvClaim" style="background:var(--amber);border-color:var(--amber);color:#161311">Accepted, let Google see it</button>
        </div>
        <div class="onres" id="gvClaimRes"></div>
      </div>

      <!-- Bulk drafting. A draft is a hard 404 until someone publishes it, which
           is what makes it safe to build one for a business that has agreed to
           nothing. Published-but-unclaimed is reachable by its link and noindex.
           Claimed, which happens when you onboard them, is the only indexable state. -->
      <div class="bulk" id="bulkBox">
        <div class="bulk-h">
          <b>Build a draft site for every lead</b>
          <span class="bulk-n" id="bulkCounts"></span>
        </div>
        <p class="bulk-p">Drafts are invisible: the URL returns 404 until you or a rep publishes it, which is how the delivery call and the postcard work. Nothing here is shown to a business or to Google until then.</p>
        <div class="bulk-row">
          <button class="btn sm" id="bulkGo">Generate drafts</button>
          <button class="btn ghost sm" id="bulkStop" disabled>Stop</button>
          <button class="btn ghost sm" id="sMigrate">Migrate old store</button>
          <span class="bulk-n" id="bulkMsg"></span>
        </div>
        <div class="track" id="bulkTrack" hidden><div class="fill" id="bulkFill"></div></div>
      </div>

      <!-- Lead finder. Runs Google Places and shows what the classifier makes of
           each result. Costs real money per search, so it is one click, one city,
           and it reports the split rather than silently adding rows. -->
      <div class="bulk" id="findBox">
        <div class="bulk-h">
          <b>Find leads</b>
          <span class="bulk-n">placeholder sites count as targets</span>
        </div>
        <p class="bulk-p">Searches Google Places for one trade in one city and sorts what it finds: no website, social only, a directory listing, or a site they built themselves. Businesses with a real website of their own are dropped, and permanently closed ones never appear.</p>
        <div class="bulk-row">
          <select id="fdTrade"></select>
          <input class="f" id="fdCity" placeholder="Overland Park, KS" style="min-width:200px">
          <button class="btn sm" id="fdGo">Search</button>
          <span class="bulk-n" id="fdMsg"></span>
        </div>
        <div class="wrapt" id="fdWrap" style="margin-top:12px;display:none"><table><thead><tr>
          <th>Business</th><th>Their "website"</th><th>Reputation</th><th>Looks like</th><th>Hours</th><th>Phone</th>
        </tr></thead><tbody id="fdTb"></tbody></table></div>
        <p class="bulk-p" id="fdDropped" style="margin-top:10px"></p>
      </div>

      <div class="bar" style="margin-top:14px">
        <input class="f" id="sQ" placeholder="Search business, slug or city...">
        <select id="sState"><option value="">Draft and live</option><option value="1">Live only</option><option value="0">Drafts only</option></select>
        <select id="sSrc"><option value="">Any source</option><option value="draft-bulk">Generated from a lead</option><option value="hand">Made by hand</option></select>
        <span class="bulk-n" id="sCount"></span>
      </div>

      <div class="wrapt" style="margin-top:12px"><table><thead><tr>
        <th>Business</th><th>Slug</th><th>Owner email</th><th>Modules on</th><th>State</th><th></th>
      </tr></thead><tbody id="sTb"></tbody></table></div>
      <div class="bulk-row" style="margin-top:10px">
        <button class="btn ghost sm" id="sMore" hidden>Show more</button>
      </div>

      <div id="sEd" style="display:none;margin-top:18px;border-top:1px solid var(--line);padding-top:16px">
        <h2 id="sEdT" style="margin-bottom:12px">New website</h2>
        <!-- THE FIELDS BELOW DO NOT ALWAYS RENDER. api/site.js serves site.html
             verbatim when the record has one and only falls back to the template
             when it is empty, so on an imported page every field here is inert.
             It said nothing about that, which made this whole screen a lie for
             exactly the customers whose pages we care most about. -->
        <div id="sHtmlWarn" hidden style="background:rgba(255,196,46,.12);border:1px solid rgba(255,196,46,.45);color:#ffe9a8;border-radius:10px;padding:10px 13px;font-size:.83rem;margin-bottom:12px"></div>

        <div class="grid2">
          <label class="f">Business name<input id="f_business" placeholder="Dave's Trusted Auto" /></label>
          <label class="f">Web address (slug)<input id="f_slug" placeholder="daves-trusted-auto" /></label>
          <label class="f">Owner email (links their panel)<input id="f_email" type="email" placeholder="dave@davesauto.com" /></label>
          <label class="f">Trade<input id="f_trade" placeholder="auto repair" /></label>
          <label class="f">Public phone<input id="f_phone" placeholder="(816) 555-0142" /></label>
          <label class="f">Public email<input id="f_email_public" placeholder="hello@davesauto.com" /></label>
          <label class="f">Street<input id="f_street" placeholder="123 Main St" /></label>
          <label class="f">City<input id="f_city" placeholder="Grandview" /></label>
          <label class="f">State<input id="f_state" placeholder="MO" /></label>
          <label class="f">ZIP<input id="f_zip" placeholder="64030" /></label>
          <label class="f">Brand colour<input id="f_accent" placeholder="#12703C" /></label>
          <label class="f">Google Business Profile<input id="f_googleBusinessProfile" placeholder="https://maps.app.goo.gl/..." /></label>
          <label class="f">Booking link (optional)<input id="f_bookingUrl" placeholder="https://calendly.com/..." /></label>
          <label class="f">Payment link (optional)<input id="f_payUrl" placeholder="https://buy.stripe.com/..." /></label>
        </div>

        <label class="f" style="margin-top:12px;display:block">One-line tagline<input id="f_tagline" style="width:100%" placeholder="Honest auto repair in Grandview since 1998." /></label>
        <label class="f" style="margin-top:12px;display:block">About<textarea id="f_about" rows="3" placeholder="Family run for 25 years..."></textarea></label>

        <div class="reps">
          <div>
            <div class="rl">Opening hours</div>
            <div id="r_hours"></div>
            <button class="btn ghost sm" type="button" data-add="hours">+ Add hours</button>
          </div>
          <div>
            <div class="rl">Services</div>
            <div id="r_services"></div>
            <button class="btn ghost sm" type="button" data-add="services">+ Add service</button>
          </div>
          <div>
            <div class="rl">Updates / posts <span style="color:var(--mute2);font-weight:400">(needs module P2)</span></div>
            <div id="r_posts"></div>
            <button class="btn ghost sm" type="button" data-add="posts">+ Add post</button>
          </div>
        </div>

        <div class="rl" style="margin-top:18px">Modules switched on</div>
        <div class="mods" id="f_mods"></div>
        <div class="fine2">P4, P5, P6, P10 and P11 are real products but back-office, so they change nothing on the page. They are listed so this screen matches what the customer is billed for.</div>

        <!-- Their page, editable. Whatever is in here IS the website when it is
             not empty; clearing it hands rendering back to the fields above. -->
        <div style="margin-top:18px">
          <div class="rl">Their page <span id="sHtmlSize" style="text-transform:none;letter-spacing:0"></span></div>
          <div class="fine2" id="sHtmlNote" style="margin-top:0;margin-bottom:8px"></div>
          <textarea id="f_html" rows="12" spellcheck="false" style="font-family:'IBM Plex Mono',monospace;font-size:.78rem" placeholder="Empty, so the fields above render this site from the shared template."></textarea>
          <div class="row" style="margin-top:8px;align-items:center">
            <button class="btn ghost sm" type="button" id="sTemplate">Use the shared template instead</button>
            <span class="fine2" style="margin:0">Clears their own page, so the fields above become the website again.</span>
          </div>
        </div>

        <div class="row" style="margin-top:18px;align-items:center">
          <label class="chk"><input type="checkbox" id="f_published" /> <span>Published (live to the public)</span></label>
          <button class="btn" id="sSave">Save website</button>
          <a class="btn ghost sm" id="sView" target="_blank" rel="noopener" style="display:none">View live →</a>
          <button class="btn ghost sm" type="button" id="sCancel">Cancel</button>
        </div>
        <div class="onres" id="sRes"></div>

        <!-- TAKING IT DOWN. Two different asks. Unpublish is what you want when
             an owner says "get it off the internet now": instant, a hard 404,
             and everything we built is still here when the conversation turns.
             Delete is for when it is over, and it asks first because it cannot
             be undone from this screen. -->
        <div class="row" style="margin-top:18px;align-items:center;gap:10px">
          <button class="btn ghost sm" type="button" id="sDown" style="border-color:var(--gold);color:var(--gold)">Take offline</button>
          <button class="btn ghost sm" type="button" id="sDel" style="border-color:var(--red);color:var(--red)">Delete permanently</button>
          <span class="fine2" style="margin:0">Take offline makes it a 404 and keeps the page. Delete removes the record for good.</span>
        </div>
        <div class="onres" id="sDelRes"></div>

      </div>
    </div>

    <div class="trunc" id="trunc"></div>
    <div class="msg" id="msg"></div>
    <div class="wrapt"><table><thead><tr>
      <th>Customer</th><th>Site</th><th>Switches on</th><th>MRR</th><th>Lifecycle</th><th>Renews / Ends</th><th>Joined</th><th>Portal</th><th>Website attached</th>
    </tr></thead><tbody id="tb"></tbody></table></div>
`;
