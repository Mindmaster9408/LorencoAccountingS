# Session Handoff — 2026-03-15 (Company Sync + VAT + Nav Switcher + Isolation Fix)

## Summary

Five-task session: **polyfills crash fix**, **VAT recon dark theme + data wiring + UX**, **company dropdown client switcher**, **company details bidirectional sync (accounting ↔ ECO Hub)**, and **practice isolation security fix**.

All work committed and pushed to GitHub.

---

## Commits This Session

| Commit | Description |
|---|---|
| `373a972` | fix: polyfills storageAvailable missing + accounting_kv_store auto-migration |
| `363998b` / `9ab6485` | fix: dark theme for VAT recon section — action bar, summary bar, alert, checklist |
| `db8c0b4` | fix: vat.html loadVATReconData — replace safeLocalStorage with real API |
| `6189bc1` | feat: vat.html — auto-load current period, period dropdown, live stat cards |
| `72f4cc0` | feat: company dropdown — switch accounting clients from the nav bar |
| `08549c4` / `a52bb4d` | fix: company details bidirectional sync — accounting ↔ ECO Hub |
| `f4dbc26` | debug: expose company/list error detail in response + alert |
| `970858f` | fix: company routes — switch from pg Pool to Supabase JS client |
| `4202e49` | fix: company list — enforce practice isolation, no cross-practice data leak |

---

## What Was Changed

### 1. `frontend-accounting/js/polyfills.js` (commit 373a972)

**Bug fixed**: `window.storageAvailable is not a function` at line 737.

`window.hasFeature('localStorage')` called `window.storageAvailable()` which was never defined. Added the MDN storage availability test function before `window.hasFeature`.

**Note**: If user still sees this error after deployment, it is a **browser cache** issue. Hard refresh (Ctrl+Shift+R) fixes it.

---

### 2. `backend/config/accounting-schema.js` (commit 373a972)

**Bug fixed**: `GET /api/accounting/kv` was returning 500 because `accounting_kv_store` table didn't exist.

Added `CREATE TABLE IF NOT EXISTS accounting_kv_store` as section 24 in `ensureAccountingSchema()`. Table columns: `company_id TEXT, key TEXT, value JSONB, updated_at TIMESTAMPTZ, PRIMARY KEY (company_id, key)`.

---

### 3. `frontend-accounting/vat.html` (commits 363998b, db8c0b4, 6189bc1)

**Dark theme**: Added class names to 4 inline-styled elements so `dark-theme.css` can target them: `vat-action-bar`, `vat-summary-bar`, `vat-recon-alert`, `vat-checklist-card`, `vat-checklist-title`.

**Data wiring**: Replaced broken `loadVATReconData()` (read from safeLocalStorage journals) with 4-line API delegator that calls `loadTrialBalanceForPeriod()`.

**UX improvements**:
- Replaced dead "Actions" select with `<select id="periodSelect">` populated by `setupPeriodSelector()` (last 12 months)
- `#vatReconSection` now always visible (removed `display:none`)
- Stat cards show "Loading…" then update with live data
- DOMContentLoaded: `setupPeriodSelector()` → `selectVATPeriod()` → auto-loads current period

---

### 4. `frontend-accounting/js/navigation.js` (commit 72f4cc0)

**New feature**: Company name in nav bar is now a clickable dropdown that lists the current practice's accounting clients.

- `toggleCompanyDropdown()` — opens/closes dropdown, lazy-loads client list on first open
- `loadAccountingClients()` — `GET /api/eco-clients?app=accounting` using `eco_token`, filters to clients with `client_company_id`, renders items with active/shared badges
- `switchToClient(companyId)` — `POST /api/auth/select-company`, stores new JWT as `token`, reloads page
- Click-outside handler closes both user dropdown and company dropdown

---

### 5. `backend/modules/accounting/routes/company.js` (commits a52bb4d, 970858f, 4202e49)

**Three separate fixes applied:**

**a) Access check fixed** — Replaced `user_company_access` DB join (SSO users have no rows there) with `req.companyId === companyId` JWT comparison.

**b) Switched from pg Pool to Supabase JS client** — Root cause of 500 errors: `ACCOUNTING_DATABASE_URL` / `DATABASE_URL` env vars not configured in Zeabur. All other accounting routes use the same pg Pool! This is a systemic risk (see Open Issues below). Company.js was the first one discovered because it was the first page tested. Fixed by replacing `db = require('../config/database')` (pg Pool) with `supabase = require('../../../config/database')` (Supabase JS client). Added `mapCompanyRow()` helper to translate snake_case → camelCase.

**c) Practice isolation security fix** — Super admin flag was bypassing all filtering, returning ALL companies in the DB including other practices' companies and unrelated clients. Now uses 3-step isolation: (1) resolve practice company from JWT companyId via eco_clients lookup, (2) get all client_company_ids for that practice, (3) return only those companies. Super admin status no longer bypasses this.

**Also added**:
- `company_name` field to UPDATE (was silently omitted — name saves now actually persist)
- `authorize('admin', 'accountant')` lowercase fix (mapRole outputs lowercase; `'ADMIN'` never matched)
- eco_clients bidirectional sync: PUT now updates `eco_clients.name/email/phone/address/id_number WHERE client_company_id = companyId`

---

### 6. `frontend-accounting/company.html` (commits a52bb4d, f4dbc26)

- Fixed 3 wrong URLs: `/api/company/*` → `/api/accounting/company/*`
- `loadCurrentCompany()` now seeds `activeCompanyId` into localStorage from first returned company (fixes "No company selected" error after SSO login)
- Error alert now shows actual server error message for debugging

---

## Open Issues — CRITICAL

### pg Pool DATABASE_URL not configured in Zeabur

**ALL** accounting routes use `db = require('../config/database')` (the accounting pg Pool):
- `accounts.js`, `journals.js`, `bank.js`, `vatRecon.js`, `suppliers.js`, `reports.js`, `pos-bridge.js`, `payeConfig.js`, `payeReconciliation.js`, `ai.js`

If `ACCOUNTING_DATABASE_URL` / `COACHING_DATABASE_URL` / `DATABASE_URL` are not set in Zeabur, ALL of these fail with 500 "No database URL configured".

**Option A (quick)**: Add `DATABASE_URL` to Zeabur environment variables — use the Supabase direct connection string (port 5432). Found in Supabase → Project Settings → Database → Connection string (URI, direct connection).

**Option B (proper)**: Migrate all remaining accounting routes from pg Pool to Supabase JS client, same as company.js was fixed this session. Larger change but eliminates the environment variable dependency.

---

## What Was NOT Changed

- Other accounting routes (journals, accounts, bank, suppliers, etc.) — still use pg Pool, may fail in production if DATABASE_URL is not set
- `reports.html` P&L frontend — still uses legacy flat income/expense arrays, doesn't show Gross Profit / Operating Profit subtotals (this is a pre-existing gap from the 2026-03-15 COA session)
- Segment reporting UI — schema ready, no UI
- Sean learning system — architecture only

---

## Testing Required

- [ ] Hard refresh (Ctrl+Shift+R) on accounting pages to clear cached polyfills.js
- [ ] Company page loads company list (should show only this practice's clients)
- [ ] Company page populates form fields from DB
- [ ] Save company → verify name/address/VAT etc. saved in Supabase `companies` table
- [ ] Save company → verify same fields updated in `eco_clients` table for that client
- [ ] Company dropdown in nav bar → shows client list → click client → page reloads scoped to that client
- [ ] Verify journals/accounts/bank pages work (confirm DATABASE_URL is set in Zeabur, or migrate to Supabase client)
- [ ] VAT page → auto-loads current period on open, stat cards populate from trial balance

---

## Follow-up Notes

```
FOLLOW-UP NOTE
- Area: Accounting routes — pg Pool DATABASE_URL in Zeabur
- What was done: company.js switched to Supabase JS client (working)
- What still needs to be checked: journals, accounts, bank, suppliers, reports, vatRecon all use pg Pool
- Risk if not checked: ALL of those routes return 500 in production if DATABASE_URL is not set
- Recommended next: either (A) add DATABASE_URL to Zeabur environment, or (B) migrate remaining routes to Supabase client

FOLLOW-UP NOTE
- Area: reports.html P&L
- What was done: reports.js returns structured grossProfit/operatingProfit/netProfit sections
- What still needs to be checked: reports.html doesn't consume structured data yet
- Risk if not checked: users see flat list without Gross Profit / Operating Profit subtotals
- Recommended next: update reports.html to render SA 3-tier P&L

FOLLOW-UP NOTE
- Area: Segment reporting
- What was done: schema ready (journal_lines.segment_value_id, coa_segments, coa_segment_values)
- What still needs to be checked: no UI for tagging, no filter in reports API
- Recommended next: add segment_value_id to journal entry UI and segmentValueId filter to /reports/profit-loss
```
