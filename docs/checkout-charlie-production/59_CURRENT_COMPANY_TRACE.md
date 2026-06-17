# 59 — CURRENT COMPANY CARD: DEEP TRACE REPORT

**Date:** 2026-06-17  
**File:** `accounting-ecosystem/frontend-pos/index.html`  
**Status:** ROOT CAUSE CONFIRMED — not yet fixed

---

## Executive Summary

The "Loading..." state in Settings → Companies → Current Company card is caused by a **regression in commit `f359103`** (May 23 2026) which stripped all section-loader dispatch branches from the active `showSettings()` function except `customers`. `loadCompanies()` is therefore never called, `loadMainCompanyInfo()` never executes, and `#mainCompanyName` retains its initial "Loading..." text forever.

This is a two-level failure: even if the dispatch is restored, `loadMainCompanyInfo()` still calls the wrong backend endpoint (also reverted by `f359103`).

---

## Full Chain Trace

```
User clicks Settings → Companies
  ↓
showSettings('companies', event)    ← called at sidebar click (HTML line 2246)
  ↓
Second definition executes          ← line 7139, ACTIVE (first at 5611 is dead)
  ↓
Hides all *Section elements         ← ✅ correct
Shows companiesSection              ← ✅ correct
  ↓
Dispatch block runs:
  if (section === 'customers') { ... }    ← only surviving handler
  [companies handler: DELETED]            ← removed in f359103
  ↓
loadCompanies()                     ← NEVER CALLED ← CHAIN BREAKS HERE
  ↓
loadMainCompanyInfo()               ← NEVER CALLED
  ↓
#mainCompanyName                    ← stuck at "Loading..." forever
```

---

## Answers to Trace Questions

| Question | Answer |
|---|---|
| Is `loadMainCompanyInfo` executing? | **NO** — never called |
| What is `currentCompanyId`? | **Correctly set** during login (SSO path lines ~3914-3916, session-resume ~3958, normal login ~4098). Not null for any logged-in user. |
| What endpoint is called? | **None** — the function never executes |
| Does endpoint return 200? | **N/A** — no fetch issued |
| What fields are returned? | **N/A** |
| What fields does renderer expect? | `company.company_name`, `company.vat_number`, `company.trading_name`, `company.address` |
| Is render executed? | **NO** |
| Is render overwritten later? | **N/A** |

---

## Root Cause: Commit `f359103`

**Commit:** `f359103` `fix(historical-comparatives): fix account search 500 error and capture grid empty state`  
**Date:** May 23 2026  
**Author:** Ruan van Loggerenberg

This commit made 112 diff hunks across 3935 diff lines in `index.html`. It was nominally a fix for the historical-comparatives module, but its restructuring of `index.html` deleted 5 of 6 section-loader dispatch branches from the active `showSettings()`.

**Exact deletion** (from commit diff, hunk `@@ -8125,24 +7150,9 @@`):

```diff
 if (section_element) {
     section_element.style.display = 'block';
-    if (section === 'companies') {
-        loadCompanies();
-    }
-    if (section === 'general') {
-        loadGeneralSettings();
-    }
-    if (section === 'users') {
-        loadCompaniesForUserFilter();
-    }
     if (section === 'customers') {
         loadCustomers();
     }
-    if (section === 'suppliers') {
-        loadSettingsSuppliers();
-    }
-    if (section === 'tills') {
-        loadSettingsTills();
-    }
 }
```

**5 handlers deleted:**
- `companies` → `loadCompanies()` ← causes this bug
- `general` → `loadGeneralSettings()`
- `users` → `loadCompaniesForUserFilter()`
- `suppliers` → `loadSettingsSuppliers()`
- `tills` → `loadSettingsTills()`

**1 handler survived:**
- `customers` → `loadCustomers()`

---

## Prior Fix History (Why Previous Fixes Did Not Stick)

| Commit | Date | Fix Applied | Still Present? |
|---|---|---|---|
| `c64f52f` | May 22 22:10 | Added `companies` handler to second `showSettings`; fixed `loadMainCompanyInfo` endpoint to `GET /companies/:id` | **Deleted by `f359103`** |
| `fe77a83` | May 22 21:26 | Added `users` handler to second `showSettings` | **Deleted by `f359103`** |
| `2136f51` | May 22 ~21:15 | Added `tills` handler to second `showSettings` | **Deleted by `f359103`** |
| `95a2f25` | May 22 ~21:40 | Added `general` handler to second `showSettings` | **Deleted by `f359103`** |

All four prior fixes to `showSettings` were in the file at the time `f359103` ran on May 23. The sweep deleted all of them.

---

## Two-Level Failure

Even if the dispatch is restored (Fix 1), `loadMainCompanyInfo` still has the wrong endpoint (Fix 2 needed too).

### Level 1 — showSettings dispatch (BLOCKING)

**Current state** (line 7139, active `showSettings`):
```javascript
if (section_element) {
    section_element.style.display = 'block';
    if (section === 'customers') {
        loadCustomers();
    }
    // ← companies handler MISSING
}
```

**Required state** (restoring c64f52f + all prior fixes):
```javascript
if (section_element) {
    section_element.style.display = 'block';
    if (section === 'companies') { loadCompanies(); }
    if (section === 'general') { loadGeneralSettings(); }
    if (section === 'users') { loadCompaniesForUserFilter(); }
    if (section === 'customers') { loadCustomers(); }
    if (section === 'suppliers') { loadSettingsSuppliers(); }
    if (section === 'tills') { loadSettingsTills(); }
}
```

### Level 2 — loadMainCompanyInfo endpoint (BLOCKING if Level 1 fixed)

**Current state** (line 9156):
```javascript
const res = await fetch(`${API_URL}/auth/company-info`, {
```

`/auth/company-info` does NOT exist in `backend/shared/routes/auth.js`. Returns 404.

**Required state** (restoring c64f52f):
```javascript
const res = await fetch(`${API_URL}/companies/${currentCompanyId}`, {
```

`GET /api/companies/:id` EXISTS in `backend/shared/routes/companies.js` line ~94. Returns `{ company: { company_name, vat_number, trading_name, ... } }`.

Also required: immediate unconditional fallback at function entry (not conditional on `currentCompanyName`):
```javascript
// CURRENT (conditional — stays "Loading..." if currentCompanyName is null):
if (currentCompanyName) {
    document.getElementById('mainCompanyName').textContent = currentCompanyName;
}

// REQUIRED (unconditional — no path leaves "Loading..." on screen):
const nameEl = document.getElementById('mainCompanyName');
nameEl.textContent = currentCompanyName || 'Loading company...';
if (!currentCompanyId) {
    console.warn('[POS] loadMainCompanyInfo: currentCompanyId is null');
    nameEl.textContent = 'Current company unavailable';
    return;
}
```

---

## State of `currentCompanyId` (Confirmed Not the Problem)

`currentCompanyId` is declared once at line 10492: `let currentCompanyId = null;`  
`currentCompanyName` is declared once at line 10493: `let currentCompanyName = null;`

Both are set before any user interaction reaches Settings:

| Entry path | Where set | Variable set |
|---|---|---|
| SSO/Eco Dashboard | Line ~3914 | `currentCompanyId = company.id; currentCompanyName = company.company_name` |
| SSO fallback (JWT) | Line ~3924 | `currentCompanyId = payload.companyId` (name may be null here) |
| Session resume | Line ~3958 | `currentCompanyId = company.id; currentCompanyName = company.company_name` |
| Normal login | Line ~4098 | `currentCompanyId = result.company.id; currentCompanyName = result.company.company_name` |

`currentCompanyId` is **not null** for any logged-in user. The data was always available — it simply never gets fetched and rendered because `loadCompanies()` is never called.

---

## Collateral Damage from `f359103`

The same deletion affects all other Settings sections. Navigate to any of these and nothing loads:

| Section | Handler removed | Symptom |
|---|---|---|
| Settings → General | `loadGeneralSettings()` | Company fields always blank |
| Settings → Users | `loadCompaniesForUserFilter()` | Company dropdown empty |
| Settings → Suppliers | `loadSettingsSuppliers()` | Supplier list never loads |
| Settings → Tills | `loadSettingsTills()` | Tills list never loads |

Only Settings → Customers works (its handler survived).

---

## Scope of Fix Required

This is a focused restoration of deleted code. Two changes needed:

1. **Restore 5 deleted dispatch branches** in the second `showSettings()` (line ~7153 in current file, inside the `if (section_element)` block)

2. **Restore `loadMainCompanyInfo()` endpoint and hardening** (line ~9156 in current file):
   - Change `${API_URL}/auth/company-info` → `${API_URL}/companies/${currentCompanyId}`
   - Make initial fallback unconditional (not gated on `if (currentCompanyName)`)
   - Add null-guard with `console.warn` if `currentCompanyId` is absent

No backend changes required. No auth/payroll files touched.

---

## Verification Required After Fix

| Test | Expected |
|---|---|
| T1 — Enter Settings → Companies | `loadCompanies()` called; card shows company name immediately |
| T2 — Company name from DB | `#mainCompanyName` shows `company.company_name` from `GET /api/companies/:id` |
| T3 — VAT renders | `#mainCompanyVat` shows `company.vat_number` or "-" |
| T4 — No "Loading..." left on screen | Card never shows "Loading..." under any condition |
| T5 — Settings → General loads | Company fields pre-populated from `GET /api/companies/:id` |
| T6 — Settings → Users loads | Company dropdown populated |
| T7 — Settings → Suppliers loads | Supplier list appears |
| T8 — Settings → Tills loads | Tills list appears |
| T9 — `currentCompanyId` null path | Shows "Current company unavailable", not "Loading..." |
| T10 — No payroll/auth files changed | `git diff` shows only `frontend-pos/index.html` changed |
