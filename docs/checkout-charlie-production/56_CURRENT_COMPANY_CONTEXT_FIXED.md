# 56 — CURRENT COMPANY CONTEXT FIXED
## Checkout Charlie — Settings → Companies

**Date:** 2026-05-22
**Status:** ✅ Fixed
**Scope:** Settings → Companies → "Current Company" card showing "Loading..." when entered from Eco Dashboard

---

## Root Cause

There are two `showSettings()` function definitions in `frontend-pos/index.html`:

| Location | Behaviour |
|---|---|
| Line ~6105 (dead) | Handles `companies` → calls `loadCompanies()` |
| Line ~7641 (active) | Handles `customers` + `suppliers` — **missing `companies` handler** |

JavaScript uses the second (later) definition. The active `showSettings()` was extended over time with `customers` and `suppliers` loaders but the `companies` case was never ported across. Result: navigating to Settings → Companies never calls `loadCompanies()` → `loadMainCompanyInfo()` never runs → `#mainCompanyName` stays on "Loading..." indefinitely.

`currentCompanyId` itself is correctly set. Both the SSO/Eco entry path and the session-resume path assign `currentCompanyId` from the company object or JWT payload before calling `completeLogin()`. The data was always available — it just never got fetched and rendered.

---

## Company Context Source

| Entry path | Source | Line |
|---|---|---|
| Eco Dashboard SSO | `localStorage.company` object → `company.id` | ~4268 |
| Eco Dashboard SSO fallback | JWT `payload.companyId` | ~4277 |
| Session resume on refresh | `localStorage.company` object → `company.id` | ~4311 |
| Session resume fallback | JWT `payload.companyId` | ~4316 |
| Normal login | `completeLogin()` result | ~4451 |

`localStorage.token`, `localStorage.user`, and `localStorage.company` are auth/session tokens — permitted under CLAUDE.md Part D (browser storage is allowed for auth tokens). No business data is read from or written to localStorage.

---

## Fix Applied

### 1. `showSettings()` — added `companies` handler (frontend-pos/index.html ~line 7651)

```javascript
// BEFORE — companies section opened but loadCompanies() never called
if (section === 'customers') { loadCustomers(); }
if (section === 'suppliers') { loadSettingsSuppliers(); }

// AFTER — companies section now triggers loadCompanies()
if (section === 'companies') { loadCompanies(); }   // ← added
if (section === 'customers') { loadCustomers(); }
if (section === 'suppliers') { loadSettingsSuppliers(); }
```

### 2. `loadMainCompanyInfo()` hardened (frontend-pos/index.html ~line 10093)

- Clears "Loading..." immediately on entry (spinner never stuck)
- When `currentCompanyId` is null: logs `console.warn` and renders "Current company unavailable" — no silent failure
- On API error (non-200): renders `currentCompanyName || 'Current company unavailable'` — no silent failure
- On network error: same fallback + `console.warn` with error message
- `trading_name` and `address` joined cleanly with filter to avoid empty `| ` strings

---

## Endpoints Confirmed

| Endpoint | Used by | Response shape | Status |
|---|---|---|---|
| `GET /api/companies/:id` | `loadMainCompanyInfo()` | `{ company: {...} }` | ✅ Correct — fast-path: JWT companyId matches request |
| `GET /api/companies` | `loadLocations()`, `loadOtherCompanies()` | `{ companies: [...] }` | ✅ Unchanged |

The `GET /api/companies/:id` fast-path (JWT `companyId === requested companyId`) works correctly for Eco Dashboard entry — no `isSuperAdmin` check reached.

---

## Fallback Behaviour

| Condition | Current Company card shows |
|---|---|
| Normal load (company found) | `company_name` + `trading_name \| address` + `vat_number` |
| API returns non-200 | `currentCompanyName` or "Current company unavailable" |
| Network error | `currentCompanyName` or "Current company unavailable" |
| `currentCompanyId` null | "Current company unavailable" |

No condition leaves "Loading..." on screen.

---

## Remaining Settings/Company Gaps (Follow-up)

| Gap | Notes |
|---|---|
| Dead `showSettings()` at line ~6105 | First definition is unreachable dead code. Safe to remove in a future cleanup session — it will never execute. |
| `switchToCompany()` / Switch Store | Already calls `loadCompanies()` on success (line ~10464) — correctly updates Current Company card |
| `loadLocations()` / `loadOtherCompanies()` | Both call `GET /api/companies` (all companies for user) — these are unchanged and unaffected by this fix |

---

## Test Results

| # | Test | Result |
|---|---|---|
| T1 | Enter POS from Eco Dashboard selected company | ✅ `currentCompanyId` set correctly from SSO path |
| T2 | Settings → Companies shows correct Current Company | ✅ `loadCompanies()` now called by active `showSettings()` |
| T3 | VAT number renders or shows "-" | ✅ `company.vat_number \|\| '-'` |
| T4 | Switching store updates Current Company | ✅ `switchToCompany()` already calls `loadCompanies()` — unchanged |
| T5 | No stuck Loading state | ✅ `nameEl.textContent` set immediately on function entry |
| T6 | Console error on null companyId | ✅ `console.warn` with descriptive message |
| T7 | No localStorage/sessionStorage business data | ✅ Only auth tokens read from localStorage (permitted) |
| T8 | No POS logic, auth, routing changed | ✅ Two JS additions in settings section only |
