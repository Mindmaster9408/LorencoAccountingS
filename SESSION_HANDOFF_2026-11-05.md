# Session Handoff — 2026-11-05

## Sean bank allocations, Phase 1 (commit ccf85a6)

### What changed
| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/sean/bank-allocation-engine.js` (new) | Read-only engine that suggests an account and VAT per unmatched bank line. Sources in order: the client's own posted history (all import sources), then approved global patterns (only when the client's account has the same code and meaning), then starter knowledge resolved by account name (50%, shown but never prefilled). It never suggests transfers, 1100/2000, or inactive/non-postable accounts. |
| `accounting-ecosystem/backend/modules/accounting/routes/bank.js` | New `POST /api/accounting/bank/sean-suggestions`. The learning event now stores the bank's name, not the bank account's name (which is the client's company name). |
| `accounting-ecosystem/frontend-accounting/bank.html` | Sean prefills untouched rows at ≥70% **after** bank rules and payroll matches, with a banner that says why. The AI panel shows the reason and alternatives. "Mass-Accept" now only **selects** Sean's lines at ≥X%, and you still post with "Allocate Selected". The hardcoded regex rules and the localStorage "teach Sean" store are removed. Bulk allocate now sends VAT, through the same resolver as single allocate. |
| `accounting-ecosystem/backend/tests/sean-bank-allocation-engine.test.js` (new) | 16 tests, all with fictional data. |

### Root causes fixed
- The old "Sean AI" used hardcoded account codes that don't match Leo's default chart: bank charges went to 6500 = Computer & IT, salaries to 6400 = Office Supplies, and SARS to 2100 = Short-term Loans. These came at 89–96% confidence, so they fell within the Mass-Accept default. Checked in the DB: no posted allocation was affected.
- Sean's per-client learning was never used. Only super-admin-approved global patterns were, and there are 0 of them.
- Bulk allocate dropped VAT.
- The "global" learning table stored client company names.

### Confirmed
- Backtest on real posted data: each client's older 80% trains the engine, which then predicts the newest 20% (4 companies, 250 lines). Result: 182 lines prefilled, 181 of them correct (99.5%).
- Engine run against live Supabase: works.
- Lint: 0 errors.
- Full Jest suite: the only failures are 4 suites that fail the same without this change: supplier-invoice-ocr-drafts, historical-comparatives-dashboard, teach-paytime and payroll-employee-sync.

### Not changed
- Nothing posts automatically (Phase 1 decision).
- bank-learning.js global flow is untouched.
- Customer/supplier invoice matching (Phase 2) is not built.

### Testing required (Ruan)
- On DroneDog or Pennygrow, open Bank and check the following:
  - Lines are filled with a 🤖 Sean banner.
  - Changing a line shows "You changed Sean's suggestion".
  - "Select Sean's Lines" ticks the right rows, and "Allocate Selected" posts them.
  - On a VAT-registered company, bulk allocate keeps the VAT setting.
- Hard refresh (Ctrl+F5) after deploy.

```
FOLLOW-UP NOTE
- Area: sean_bank_allocation_patterns.bank_name (existing 299 rows)
- Dependency: Ruan's approval for a data change
- What was done now: code no longer writes client names there
- What still needs to be checked: existing rows still hold client company names → set bank_name = NULL where it is not a bank
- Risk if not checked: client names remain in a cross-client table (privacy rule in bank-learning.js)
- Recommended next review point: next Sean session
```

```
FOLLOW-UP NOTE
- Area: Sean Phase 2+
- Dependency: Phase 1 live feedback
- What was done now: prefill + review only
- What still needs to be checked: per-client auto-post for strongly confirmed lines (never VAT decisions / transfers / customer-supplier payments); matching payments to open invoices; split allocations are learned by their first line only (none exist today)
- Risk if not checked: none now (human posts everything)
- Recommended next review point: after Ruan has used Phase 1 on a few statements
```
