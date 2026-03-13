# Accounting App Company Context Fix

**Date:** March 2026
**Root-caused by:** Full audit of company context isolation across accounting frontend
**Status:** Implemented and verified

---

## CHANGE IMPACT NOTE

- **Area being changed:** Accounting frontend — company context isolation, demo data removal
- **Files/services involved:** `dashboard.html`, `company.html`, `polyfills.js`, 11 report pages, `paye-reconciliation.html`, `customers.html`, `profile.html`
- **Current behaviour identified:** Accounting app always loaded company ID 1 (THEKSTRA BAKKERT demo) regardless of which client account was selected. Multiple pages silently showed demo data on API failure.
- **Required behaviours to preserve:** All data isolation per company, SSO launch flow, KV store namespacing, JWT auth
- **Risk of regression:** High if SSO path is broken; low for report page company name display
- **Related dependencies:** `polyfills.js` KV namespace prefixing depends on `activeCompanyId`
- **Safe implementation plan:** Fix SSO at source (dashboard.html), then remove downstream fallbacks

---

## Root Cause Analysis

### BUG 1 — SSO never sets `activeCompanyId` (PRIMARY ROOT CAUSE)

Both SSO launch paths in `dashboard.html` (`launchApp` and `launchClientApp`) opened the accounting app without writing `activeCompanyId` to localStorage.

`company.html` read:
```javascript
const activeCompanyId = parseInt(localStorage.getItem('activeCompanyId')) || 1;
```

Since `activeCompanyId` was never set, this always fell back to `|| 1` — which is  the first/demo company in the database. Every client always saw company 1's data.

### BUG 2 — `eco_company_name` never set in SSO

The accounting app navigation bar reads `eco_company_name` from localStorage.
SSO never wrote it → top nav bar always showed blank.

### BUG 3 — Path A SSO removed `selectedCompanyId`

`launchApp` called `localStorage.removeItem('selectedCompanyId')` without setting `activeCompanyId` first. This meant `polyfills.js` `_companyId()` returned `''`, so all KV data was stored without company prefix — mixing data across companies.

### BUG 4 — Demo data silently replaced real data on API failure

`company.html` `loadCompanies()` and `loadCompanyDetails()` — on any API error, functions populated the page with hardcoded `THEKSTRA BAKKERT` data instead of showing an error.

### BUG 5 — Report pages hardcode company name

11 report pages (`reports.html`, `trial-balance.html`, `balance-sheet.html`, `cashflow.html`, `aged-debtors.html`, `aged-creditors.html`, `vat-return.html`, `sales-analysis.html`, `purchase-analysis.html`, `paye.html`, `paye-reconciliation.html`) contained literal company names.

### BUG 6 — `polyfills.js` `_companyId()` lacked JWT fallback

If both `activeCompanyId` and `selectedCompanyId` were missing from localStorage, the KV layer had no company context and stored all data without namespacing.

### BUG 7 — `customers.html` injected demo customers into live LedgerSystem

`loadPOSDemoData()` pushed `CUST-DEMO-ABC` and `CUST-DEMO-TECH` directly into `safeLocalStorage` (`lorenco_customers` key) — which writes to Supabase cloud storage. Demo customers appeared in real client data.

### BUG 8 — `profile.html` showed hardcoded demo user

HTML `value=""` attributes and JS fallbacks showed `"Demo"`, `"demo@lorenco.com"`, `"Demo Company Ltd"` instead of real user data.

---

## Fixes Implemented

### `accounting-ecosystem/frontend-ecosystem/dashboard.html`

**Path A (`launchApp`):** Now writes all three keys after SSO:
```javascript
localStorage.setItem('activeCompanyId',   cid);
localStorage.setItem('selectedCompanyId', cid);
localStorage.setItem('eco_company_name',  cname);
```

**Path B (`launchClientApp`):** Same — now sets `activeCompanyId` and `eco_company_name` (were missing before).

### `accounting-ecosystem/frontend-accounting/company.html`

- Removed `|| 1` fallback in `renderCompanyList()`, `loadCurrentCompany()`, `saveCompany()` → replaced with `|| null`
- Added `selectedCompanyId` as secondary fallback before null
- Added guard in `saveCompany()`: if no company context, show error instead of silently saving to wrong company
- Removed entire `THEKSTRA BAKKERT` demo data object from `loadCompanies()` error handler
- Removed entire `demoData` object from `loadCompanyDetails()` error handler
- Both error handlers now show a proper user-facing error message

### `accounting-ecosystem/frontend-accounting/js/polyfills.js`

Added `_jwtCompanyId()` function that decodes the JWT token and extracts `companyId` as a last-resort fallback:

```javascript
function _jwtCompanyId() {
    // Decodes companyId from JWT payload — used when localStorage keys are absent
}

function _companyId() {
    return _nGet('activeCompanyId') || _nGet('selectedCompanyId') || _jwtCompanyId() || '';
}
```

### Report pages (11 files)

All 9 `<h2>Demo Company Ltd</h2>` occurrences replaced with:
```html
<h2 id="reportCompanyName"></h2>
<script>var _rcn=document.getElementById('reportCompanyName');if(_rcn)_rcn.textContent=localStorage.getItem('eco_company_name')||'My Company';</script>
```

`paye.html`: `<p>January 2026 - Demo Company Ltd</p>` → dynamic span populated via inline script.

`paye-reconciliation.html`: `<div id="companyName">THEKSTRA BAKKERT...</div>` → cleared, populated via inline script.

### `accounting-ecosystem/frontend-accounting/customers.html`

Removed the demo customer injection block from `loadPOSDemoData()`:
- Lines that pushed `CUST-DEMO-ABC` and `CUST-DEMO-TECH` into `safeLocalStorage` were removed
- This prevents demo customers from being written to Supabase for real client accounts

### `accounting-ecosystem/frontend-accounting/profile.html`

- Removed hardcoded `value="Demo"`, `value="demo@lorenco.com"`, `value="Demo Company Ltd"` from HTML inputs
- Updated JS to read from both `user` and `eco_user` localStorage keys
- Removed hardcoded `'Demo'`, `'demo@lorenco.com'`, `'Demo Company Ltd'` fallbacks from JS
- Company name now falls back to `eco_company_name` from localStorage

---

## Data Flow After Fix

```
User clicks "Open Accounting" for client X
→ dashboard.html launchClientApp()
→ POST /api/auth/sso-launch (returns { token, company: { id, name, ...} })
→ localStorage.setItem('activeCompanyId', company.id)    ← NEW
→ localStorage.setItem('selectedCompanyId', company.id)
→ localStorage.setItem('eco_company_name', company.name) ← NEW
→ accounting app opens
→ polyfills.js _companyId() returns company.id            ← correct
→ all KV keys namespaced as acct_<id>_*                   ← correct
→ company.html loadCurrentCompany() reads activeCompanyId ← correct
→ loads real client company data from Supabase            ← correct
→ report pages display eco_company_name from localStorage ← correct
```

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: customers.html — loadDemoData() function
- What was done now: Removed CUST-DEMO customer injection into cloud storage
- What still needs checking: loadDemoData() still populates in-memory `customers[]` array
  with hardcoded demo entries (ABC Corporation, XYZ Trading, etc.). This is used
  for the customers list UI. Evaluate whether this should be replaced with real
  API data from the backend.
- Risk if not checked: Customer list page shows demo accounts instead of real client customers
- Recommended next review: When building the customer API endpoint for the accounting module

FOLLOW-UP NOTE
- Area: report pages — date ranges are still hardcoded
- What was done now: Company names are now dynamic
- What still needs checking: All report pages still show hardcoded date ranges like
  "01 January 2026 to 14 January 2026". These should be driven by filter inputs.
- Risk if not checked: Reports always show same date range regardless of selection
- Recommended next review: When implementing live report data generation

FOLLOW-UP NOTE
- Area: profile.html — password change
- What was done now: Removed demo user values
- What still needs checking: changePassword() is a stub (just shows an alert).
  A real password change API call needs to be implemented.
- Risk: Users cannot actually change their password
- Recommended next review: When implementing user account management features
```
