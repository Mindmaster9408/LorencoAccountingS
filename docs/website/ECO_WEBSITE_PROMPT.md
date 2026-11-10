# Website Prompt — Lorenco Ecosystem

> Paste everything below the line into a website builder / AI design tool (Claude, v0, Lovable, Framer AI, Webflow AI, etc.).
> Fill in the `[[PLACEHOLDERS]]` first. Do not add prices, client numbers or statistics that aren't real.
>
> **Where the brand colours and logos come from (source of truth in the repo):**
>
> - App accent colours: `accounting-ecosystem/frontend-ecosystem/dashboard.html`, lines ~409–425 (`.app-card.pos`, `.payroll`, `.accounting`, `.inventory`, `.practice`, `.sean`)
> - Base theme tokens (`:root`, body background, glows): same file, lines ~10–60
> - Logos: see the table below. Upload these files to the website builder together with the prompt.
>
> | Logo | Path (from repo root) |
> |---|---|
> | **Lorenco main logo** (used on our login + dashboard) | `accounting-ecosystem/frontend-ecosystem/lorenco-logo-exact-reference.png` |
> | Lorenco logo, cropped | `accounting-ecosystem/frontend-ecosystem/lorenco-logo-cropped.png` |
> | Lorenco logo, vector (SVG, 1024×1024 icon) | `accounting-ecosystem/frontend-ecosystem/logo.svg` |
> | Checkout Charlie, main | `accounting-ecosystem/frontend-ecosystem/assets/branding/checkout-charlie/checkout-charlie-logo-main.png` |
> | Checkout Charlie, secondary (used on dashboard card) | `accounting-ecosystem/frontend-ecosystem/assets/branding/checkout-charlie/checkout-charlie-logo-secondary.png` |
> | Paytime | `accounting-ecosystem/frontend-ecosystem/assets/branding/paytime/paytime-logo.png` |
> | Paytime, full | `accounting-ecosystem/frontend-payroll/assets/branding/paytime/paytime-logo-full.png` |
> | Paytime favicon / app icons | `accounting-ecosystem/frontend-payroll/assets/branding/paytime/` (`favicon.ico`, `icon-192x192.png`, `icon-512x512.png`, `apple-touch-icon.png`) |
> | Ledger Leo | `accounting-ecosystem/frontend-ecosystem/assets/branding/leo/leo-logo-full.png` |
> | Stockton | `accounting-ecosystem/frontend-ecosystem/assets/branding/stockton/stockton-logo-full.png` |
> | Firmflow | `accounting-ecosystem/frontend-ecosystem/assets/branding/firmflow/firmflow-logo-full.png` |
> | Checkout Charlie app icons | `accounting-ecosystem/frontend-pos/icons/` (`icon-192.png/.svg`, `icon-512.png/.svg`) |
> | Slip Capture app icons | `accounting-ecosystem/backend/frontend-slips/icons/` (`icon-192.png`, `icon-512.png`) |
> | Sean AI | No logo yet |
>
> The app logo PNGs are 1.5–2.3 MB each. Have the builder compress or resize them for the web (WebP, max ~600px wide), or the site will load slowly.
>
> If colours change in the dashboard, update section 5 of this prompt to match.
>
> Do **not** use the colour list around line ~4145 of dashboard.html (`#667eea` / `#f093fb` / `#4facfe`). That is only for the demo-data screen and isn't the brand colour set.

---

## PROMPT

Build a modern, premium marketing website for **the Lorenco Ecosystem** — one login that gives a South African business all of its business software in one place: point of sale, payroll, accounting, inventory, practice management, slip capture and a built-in AI assistant called Sean.

### 1. Who it's for

- **Small and medium South African businesses**: retailers, bakeries, shops, service businesses, manufacturers. They want their till, stock, payroll and books to talk to each other without paying for five separate subscriptions and re-typing data between them.
- **Accounting and bookkeeping practices**: they manage many clients and want one platform to run client books, payroll and deadlines, with each client's data kept fully separate.
- Secondary audience: UK businesses. The POS and inventory apps already support other currencies and jurisdictions. Mention this lightly, without making it the headline.

### 2. Core message

**Headline idea:** "Your whole business. One login."
**Sub-headline idea:** "Till, stock, payroll and books, built to work together and backed by an AI that learns how *your* business works."

Key points to land:
1. **One login, every app.** Sign in once and open any app from one dashboard. No separate passwords per app.
2. **Everything connects.** A sale at the till can flow to the books. Payroll can flow to the ledger as a journal. Stock moves update valuation. Less re-capturing and fewer mistakes.
3. **Built for South African compliance.** PAYE, UIF, SDL, IRP5 codes, VAT returns, SARS-ready reports.
4. **Your data stays in the cloud, not on one PC.** All business data lives in a secure central database. Nothing important lives on one device, so you can switch laptops or tills and lose nothing.
5. **Multi-company by design.** Run several companies (or, for practices, many clients), each fully separate. Switch between them in one click.
6. **AI that asks before it acts.** Sean learns from how you work and suggests things, but a person approves before anything changes across clients.

### 3. The apps (one section/card per app; each app has its own name and personality)

**Checkout Charlie — Point of Sale**
Fast till for retail counters. Barcode scanning, products, tills and cash-ups, customers and account sales, customer discounts, manager-PIN approvals for discounts and returns, cash paid-out tracking, receipts, serial-number tracking for high-value items, and a receiving-clerk role for staff who only book in deliveries. Multi-currency/jurisdiction ready. Tone: friendly, quick, reliable at the counter.

**Lorenco Paytime — Payroll**
Full South African payroll. Pay runs, payslips, PAYE, UIF and SDL worked out automatically, overtime and short time, once-off bonuses taxed correctly, attendance, leave, payroll items with IRP5 codes, PAYE reconciliation, and historical payroll import for businesses moving over from another system. Finalised pay runs are locked and can't be changed, which gives a clean audit trail. Tone: trustworthy, precise, compliance-first.

**Ledger Leo — Accounting**
The general ledger. Chart of accounts, journals, customer invoices, quotes, credit notes, customer receipts, suppliers, bank import (including PDF bank statements from the major SA banks) and bank reconciliation, VAT returns, trial balance, balance sheet, income statement, cash flow, aged debtors and creditors, sales and purchase analysis. Email invoices straight to customers. Tone: clear, calm, "your books under control".

**Stockton — Inventory**
Stock items, multiple warehouses, stock movements, suppliers, purchase orders, stock costing and valuation, plus work orders for basic manufacturing. Works with Checkout Charlie so the till and the stock room see the same numbers. Tone: organised, solid.

**Firmflow — Practice Management** *(for accounting practices)*
Client files, tasks, deadlines, team assignment and time tracking for accounting and bookkeeping firms. Tone: professional, "never miss a deadline".

**Slip Capture — Slips & Receipts**
Take a photo of a slip or supplier invoice on your phone and it's stored safely online for 7 years, the period SA record-keeping rules require. No more shoeboxes of fading till slips. Tone: simple, mobile-first.

**Sean AI — Smart Assistant**
The intelligence layer across the ecosystem. Helps allocate bank transactions, learns from your own data (e.g. which payroll item maps to which IRP5 code), and suggests improvements. **Important positioning:** Sean is *controlled* AI. It suggests and a person approves. It never overwrites a decision your accountant made on purpose. Tone: smart, careful, respectful of the user's judgement.

**Coming soon (optional small section):** Doc Collector (automated client document chasing with secure upload links) and Owner Reporting (simple business-owner dashboards). Label clearly as "coming soon".

### 4. Site structure: a MULTI-PAGE website, NOT a one-page scroll site

**This must be a real multi-page website.** Every item in the navigation bar is a tab that opens its **own separate page with its own URL**. Do NOT build a single long landing page with anchor links that scroll down (`#section`). Each page is a separate file/route with its own `<title>`, meta description and content.

#### Navigation bar (on every page, sticky at the top)

```
[Lorenco logo → Home]   Home   Apps ▾   For Businesses   For Practices   Sean AI   Security   Pricing   About   Contact      [Book a demo]  [Login]
```

- **Apps ▾** is a dropdown menu listing every app. Each app links to **its own page**.
- The tab for the page you're on is highlighted (active state).
- On mobile the nav collapses into a hamburger menu that holds the same links, plus the Login and Book a demo buttons.
- The footer repeats the main links on every page.

#### Pages and URLs

| Tab | URL | Content |
|---|---|---|
| Home | `/` | Hero, "one login" message, app grid (each card links to that app's own page), "how it all connects" diagram, why-us points, CTA |
| Apps (overview) | `/apps` | All apps in a grid, short blurb each, each linking to its own page |
| Checkout Charlie | `/apps/checkout-charlie` | Full POS page: features, screenshot placeholder, who it's for, CTA |
| Lorenco Paytime | `/apps/paytime` | Full payroll page |
| Ledger Leo | `/apps/ledger-leo` | Full accounting page |
| Stockton | `/apps/stockton` | Full inventory page |
| Firmflow | `/apps/firmflow` | Full practice-management page |
| Slip Capture | `/apps/slip-capture` | Full slip-capture page (mobile-first story) |
| Sean AI | `/sean-ai` | Controlled AI, how learning and approval works, privacy stance |
| For Businesses | `/for-businesses` | The SME story: till → stock → books → payroll in one place |
| For Practices | `/for-practices` | Multi-client, Firmflow, client separation, payroll and books for many clients from one login |
| Security | `/security` | Cloud database, every company's data kept separate, role-based access (owner, accountant, payroll admin, store manager, cashier, etc.), locked payroll, audit trails, 7-year slip retention |
| Pricing | `/pricing` | `[[PRICING — leave as "Contact us for pricing" if not decided]]`. Per app or as bundles, with Sean as an add-on |
| About | `/about` | Lorenco is part of **The Infinite Legacy**. Built by an accounting practice that uses the software daily on real clients, so it's made by accountants who know what goes wrong |
| Contact / Book a demo | `/contact` | Form: name, business, email, phone, which apps interest them, message. Plus contact details |

Every app page uses the same layout template (hero in the app's accent colour → features → screenshot placeholder → who it's for → "Works together with" links to the related app pages → CTA). Only the content and accent colour change.

#### Login: goes to OUR existing login page

The website does **not** build its own login screen or form. The **Login** button sends the user to our existing ecosystem login page:

**Login URL: `https://lorenco.zeabur.app/`** `[[CONFIRM — replace if the live domain is different]]`

- The **Login** button sits top-right in the nav on **every page** (and in the mobile menu).
- It is a plain link (`<a href="https://lorenco.zeabur.app/">`) that opens in the same tab.
- Also add a "Log in" link in the footer, and on the Home hero a secondary button: "Already a client? Log in".
- Each app page can also have an "Open [App name]" button that goes to the same login URL. After logging in, the user picks the app from our dashboard.
- Never collect usernames or passwords on the marketing website itself.

### 5. Visual design

- **Dark, premium "cosmic" look.** Solid near-black background (not a full-page purple gradient), small soft glow accents in purple/blue behind key elements, and a subtle star-field texture. Clean, high-contrast white text.
- **Use these exact colours.** They match our live app dashboard, so the website and the app look like one brand.

  **Base theme**

  | Token | Value | Use |
  |---|---|---|
  | Page background | `#090d18` | Body background (solid, near-black) |
  | Deep background | `#0f0c29` | Alternate section background |
  | Surface (cards) | `rgba(255,255,255,0.06)` | Card / panel fill |
  | Surface hover | `rgba(255,255,255,0.10)` | Card hover |
  | Border | `rgba(255,255,255,0.08)` | Card and divider borders |
  | Text | `#ffffff` | Main text |
  | Muted text | `rgba(255,255,255,0.5)` | Secondary text |
  | Brand accent | `#667eea` | Primary buttons, links, active tab |
  | Accent glow | `rgba(102,126,234,0.3)` | Button / focus glow |
  | Background glow 1 | `rgba(91,61,245,0.22)` | Large blurred purple glow, top-left |
  | Background glow 2 | `rgba(61,165,255,0.18)` | Large blurred blue glow, bottom-right |

  **App accent colours** (use on each app's card, its own page hero, and its icon)

  | App | Main colour | Dark / hover | Icon tint |
  |---|---|---|---|
  | Checkout Charlie | `#3b82f6` | `#2563eb` | `#60a5fa` |
  | Lorenco Paytime | `#10b981` | `#059669` | `#6ee7b7` |
  | Ledger Leo | `#f59e0b` | `#d97706` | `#fbbf24` |
  | Stockton | `#22d3ee` | `#06b6d4` | `#22d3ee` |
  | Firmflow | `#a78bfa` | `#7c3aed` | `#a78bfa` |
  | Sean AI | `#8b5cf6` | `#7c3aed` | `#a78bfa` |
  | Slip Capture | `[[NOT YET DEFINED — suggest a lime/green-teal e.g. #84cc16 and confirm]]` | | |

  Icon backgrounds use the app's main colour at 15% opacity (e.g. Charlie `rgba(59,130,246,0.15)`).

- Use the supplied logos: the **Lorenco main logo** in the header (links to Home), the footer and the favicon, and the app logos (Checkout Charlie, Paytime, Ledger Leo, Stockton, Firmflow) on each app's card and page. Slip Capture has an app icon (use that). Sean has no logo yet, so use a clean line icon in Sean's colour. Compress all logos for the web (WebP, sensible max width) and give every logo descriptive alt text.
- Modern sans-serif type (e.g. Inter, Plus Jakarta Sans). Generous spacing, rounded cards, soft shadows and glow on hover.
- A simple **"how it connects" diagram**: the dashboard/login in the centre, apps around it, arrows showing Till → Stock → Ledger and Payroll → Ledger, with Sean shown as a layer across all of them.
- Fully responsive, mobile-first (Slip Capture especially is a phone story). No horizontal scrolling on phones.
- Fast and accessible: proper heading structure, alt text, good contrast, keyboard navigable.

### 6. Tone of voice

- Plain, confident, warm. South African business English. Short sentences.
- Speak to owners and accountants, not developers. No technical jargon (no "multi-tenant", "JWT", "Supabase", "API").
- Honest. No invented statistics, testimonials, client logos or awards. Use clearly marked placeholders for testimonials: `[[TESTIMONIAL — real client quote with permission]]`.

### 7. Things NOT to do

- Don't claim features beyond what's listed above.
- Don't claim certifications (SOC 2, ISO, POPIA-certified, SARS-approved) unless provided: `[[COMPLIANCE CLAIMS IF ANY]]`.
- Don't show real client names, client data, or screenshots containing real financial figures.
- Don't promise that Sean "does your accounting for you". Position it as an assistant that suggests, with a human approving.
- Don't use stock photos of generic office handshakes. Prefer UI mockups, abstract cosmic visuals, and real-world SA small-business scenes (shop counters, bakeries, workshops).

### 8. Placeholders to fill in

| Placeholder | What to put |
|---|---|
| Login URL | Currently `https://lorenco.zeabur.app/`. Change it if the live domain is different |
| `[[PRICING]]` | Prices or "Contact us" |
| `[[CONTACT DETAILS]]` | Email, phone, physical address |
| Logo files | Upload the PNGs from `accounting-ecosystem/frontend-ecosystem/assets/branding/` together with the prompt |
| Slip Capture colour | Not defined anywhere in the app yet. Choose one, and preferably add it to dashboard.html too |
| `[[TESTIMONIAL]]` | Real client quotes (with permission) |
| `[[COMPLIANCE CLAIMS IF ANY]]` | Only verified claims |
| `[[DOMAIN]]` | Website domain |

### 9. Deliverable

A complete, responsive **multi-page** website (HTML/CSS/JS or your platform's equivalent):
- Every page in the table in section 4 is a separate page with its own URL. No single-page scroll site.
- The same sticky navigation bar on every page, with an **Apps** dropdown, an active-tab highlight, a **Book a demo** button (→ `/contact`) and a **Login** button (→ `https://lorenco.zeabur.app/`).
- A shared footer on every page with contact details, links to all pages and apps, a "Log in" link, and "Part of The Infinite Legacy".
- All internal links work: no dead `#` links, and no anchors pointing at sections of other pages.
