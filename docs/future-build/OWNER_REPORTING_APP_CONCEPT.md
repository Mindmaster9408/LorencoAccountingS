# Owner Reporting App — Concept (Syft-style)

> Status: **CONCEPT ONLY — nothing built.** Recorded 2026-10-12 at Ruan's request.
> Working name: TBD (follows the Leo / Charlie / Stockton naming style).
> Reference product: [Syft Analytics](https://www.xero.com/za/syft-from-xero/) (now part of Xero).

---

## 1. What it is

A separate app in the ecosystem where **business owners log in and see their own business's reports**: clean, interactive and read-only. They don't have to learn accounting software.

- The **accountant/practice** keeps the books in Ledger Leo (and runs payroll in Paytime).
- The **owner** opens this app and sees how the business is doing: dashboards, KPIs, P&L, balance sheet, cash and trends, with drill-down to the transactions underneath.

Syft's core offering is the benchmark we want to match and then beat:
- Interactive financial reports with drill-down to transaction level
- KPI dashboards
- Multi-entity consolidation (eliminations, partial ownership, multi-currency)
- Forecasting and cash management
- Shareable/exportable report packs
- Department/segment reporting and budgeting

**Our advantage over Syft:** Syft only sees the accounting ledger. We own payroll (Paytime), POS (Charlie), inventory (Stockton) and the ledger (Leo) in **one database**. Our owner app can show "sales today from the till, stock value, payroll cost this month and the P&L" without any third-party connector.

---

## 2. Hard architectural rules for this app

1. **No duplicated report math.** The owner app must call the **same** report services Leo uses (`backend/modules/accounting/routes/reports.js` logic, extracted to a shared service if needed). An owner must never see a different number than the accountant sees in Leo.
   - Reason: the reversed-journal bug (2026-09-02) showed how easily parallel aggregation logic drifts. One engine, many views.
2. **Read-only for owners.** The owner role can view, comment and export. It never posts journals or edits data.
3. **No browser storage for business data (Part D).** Saved dashboards, custom report layouts, comments and shared packs live in SQL tables. Only UI preferences such as theme or collapsed panels may be stored locally.
4. **Super users see everything automatically (Rule F1).** The app is added to `APP_DEFS`, and the test company (id 51) gets it enabled by default (Rule H2).
5. **Dark-native UI** from the first line of CSS (Eco dark-cosmic pattern).
6. **Company isolation.** An owner sees only the companies they are linked to. A group owner can see several companies and a consolidated view across them.

---

## 3. What already exists that we build on

| Need | Existing piece | Notes |
|---|---|---|
| P&L, Balance Sheet, Cash Flow, TB, GL | `reports.js` endpoints (`/profit-loss`, `/balance-sheet`, `/cash-flow`, `/trial-balance`, `/general-ledger`) | PDF variants exist too |
| Trends / month-by-month | `/profit-loss/trend`, `/profit-loss/matrix` | Basis for charts |
| Departments / divisions | `segments.js`, `/division-profit-loss` | Basis for department reporting (and USALI for hotels) |
| Prior-year comparatives | `historicalComparatives.js` | Stores the **start** year (FY naming = end year, import as FY-1) |
| Dashboard data | `accounting/routes/dashboard.js` | Leo's own dashboard, reusable |
| Intercompany links | Company-link supplier↔customer mirroring | Starting point for consolidation eliminations |
| Multi-currency / jurisdiction | Jurisdiction config (shipped 2026-09-12) | Needed for currency translation in consolidation |
| Payroll cost | Paytime `payroll_snapshots` (locked = authoritative) | Only read **locked** snapshots for reported figures |
| Sales / stock | Charlie sales, Stockton valuation engine | Live operational KPIs |
| AI insights | Sean / SEVCO | Must respect the "no external LLM" intent and Part B governance |
| Email delivery | Resend integration | For "monthly pack sent to owner" (needs a real Resend key) |
| Owner invites | User profile + invite model idea (2026-10-01) | Not built. The owner-login model ties into it |

## 4. Gaps (must be built)

| Gap | Why it matters |
|---|---|
| **Budgets** | No budget tables exist in the accounting module (checked 2026-10-12). Budget vs actual is a core Syft feature |
| **Consolidation engine** | Combining entities with eliminations, ownership % and currency translation. Nothing like this exists yet |
| **Forecasting** | Cash-flow forecast (e.g. 13-week) and 3-way forecast (P&L + BS + cash) |
| **KPI definitions** | Configurable KPIs (gross margin %, debtor days, payroll % of revenue, and industry packs such as hotel RevPAR/ADR) |
| **Report packs** | Monthly management pack: selected reports + accountant commentary → PDF/link, sent to the owner |
| **Owner role + permissions** | New read-only role in `permissions.js`, mapped to company access |
| **Comments / collaboration** | Owner asks a question on a number and the accountant answers in context |

---

## 5. Suggested phases

**Phase 1 — Owner view of their own company (MVP)**
- Owner login + read-only role
- Dashboard: revenue, gross profit, net profit, cash in bank, debtors, creditors, with trends
- P&L / BS / Cash Flow with comparatives and drill-down to transactions
- Export to PDF/Excel

**Phase 2 — Practice-driven report packs**
- Accountant builds a monthly pack with commentary and publishes it to the owner
- Email notification via Resend
- Comments on reports

**Phase 3 — Budgets & KPIs**
- Budget capture (per account, per month, per segment), budget vs actual
- Configurable KPI library + industry KPI packs (hotel/USALI, retail, manufacturing)
- Cross-app KPIs (Charlie sales, Stockton stock, Paytime payroll cost)

**Phase 4 — Groups & consolidation**
- Multi-entity consolidation, eliminations (seeded from company-link data), ownership %, currency translation
- Group dashboards (important for the hotel group and any multi-company client)

**Phase 5 — Forecasting & Sean insights**
- Cash-flow and 3-way forecasts
- Sean-generated plain-language commentary ("Why is gross margin down this month?"), governed by Part B

**Later — external data sources (optional)**
- Import from Xero/Sage/QuickBooks so non-Leo businesses can use the app too. This makes it sellable on its own as well as part of Eco

---

## 6. Open questions for Ruan

1. Is it sold **per business owner**, included with the practice's service, or both?
2. Should it also work standalone for businesses that don't use Leo (Xero/Sage import)? This affects how early we need external connectors.
3. Name of the app?
4. Who builds report packs: only the accountant, or can owners build their own reports too?
5. Does the hotel group's owner reporting become the first real use case (USALI KPIs per property + consolidated group)?

```
FOLLOW-UP NOTE
- Area: Owner Reporting App (new)
- Dependency: Leo report services, segments, historical comparatives, user invite model
- What was done now: Concept recorded, existing building blocks mapped, gaps identified
- What still needs to be checked: Whether reports.js logic can be cleanly extracted into a shared
  service before a second consumer is added; owner role design vs permissions.js
- Risk if not checked: Owner app and Leo show different numbers for the same period
- Recommended next review point: Before Phase 1 build starts
```
