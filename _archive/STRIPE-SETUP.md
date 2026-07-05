# KILLSWITCH — Stripe Setup (start taking payments)

You can be accepting cards within ~30 minutes. Three parts: create the account,
send invoices (for quoted work), make payment links (for the website buttons).

---

## PART 1 — Create your account (~10 min)

1. Go to **stripe.com** → click **Start now / Sign up**. Enter email, name, password.
2. **Confirm your email** (check inbox, click the link).
3. Stripe asks you to **activate** the account — fill in:
   - **Business type:** Individual / Sole proprietor (or LLC if you have one).
   - **Your details:** legal name, address, date of birth, last 4 of SSN (identity/tax — required).
   - **Industry:** "Computer software" or "Web development / IT services".
   - **Business website:** killswitch.domains
   - **Bank account for payouts:** routing + account number — *this is where your money lands.*
   - **Statement descriptor:** what shows on a customer's card statement → `KILLSWITCH`.
4. Done. You're in **Live mode** and can take real cards.
   - **Fee:** 2.9% + 30¢ per successful charge (US). e.g. $499 → you net ~$484.

---

## PART 2 — Get paid for quoted work: INVOICES  ← use this most

Best for any custom/quoted project. No website needed.

1. Dashboard → confirm you're in **Live mode** (toggle, top — NOT "Test mode").
2. Left sidebar → **Invoices** → **Create invoice**.
3. **Customer:** Add new → their name + email.
4. **Add item:** description + amount. Example for a $2,500 build:
   - Line 1: "Business website — 50% deposit to start" → **$1,250**
   - (Send the second 50% invoice at launch.)
5. (Optional) add a due date + memo ("Balance due at launch").
6. Click **Send invoice** → customer gets an email with a **Pay** button → pays by card →
   money hits your bank in ~2 business days.

**Standard structure: 50% deposit up front, 50% at launch.** Don't start work until the deposit clears.

---

## PART 3 — Website buttons: PAYMENT LINKS

For your fixed offers so people can click & pay from the site.

1. Dashboard → **Payment Links** (left sidebar, or search "payment links") → **+ New**.
2. Create each of these (it'll have you make a "product" each time):
   - **Starter Website** — one-time — **$499**
   - **Care Plan** — choose **Recurring / Subscription**, monthly — **$99**
   - **Project Deposit** — one-time — turn on **"Let customers choose what they pay"**
     (so you can reuse it for any deposit amount)
3. After creating each, Stripe gives you a link like `https://buy.stripe.com/xxxxxxxx`. Click **Copy**.
4. **Send me those 3 links** and I'll wire the site's "Get started" / "Add a care plan"
   buttons to them — done, people pay on the site.

---

## PART 4 — Good to know

- **Test before live:** flip to **Test mode** (toggle top-right), use card `4242 4242 4242 4242`
  (any future expiry, any CVC, any ZIP) to try an invoice/link with fake money. Then switch back to Live.
- **First payout** takes ~7 days (Stripe's initial hold); after that it's automatic, ~2 business days to your bank.
- **Refunds:** Dashboard → find the payment → **Refund**. One click.
- **Taxes:** Stripe sends you a 1099-K. Keep records; talk to a tax pro about quarterly taxes / LLC as you grow.

---

## Do this now (in order)
1. Sign up + activate + add your bank (Part 1).
2. Make the 3 Payment Links (Part 3) → **send me the URLs**.
3. Land a client → send your first deposit invoice (Part 2).

That's it. You can take money today.
