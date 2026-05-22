# 54 — Company Management Loading Bug: Fixed

**Date:** 2026-05  
**File:** `accounting-ecosystem/frontend-pos/index.html`  
**Status:** ✅ FIXED

---

## Problem

The Settings → Companies section of the POS displayed "Loading..." indefinitely in the CURRENT COMPANY card. Company name, VAT number, and details never populated.

Similarly, the Settings → General tab failed to load or save company fields.

---

## Root Cause

Five functions called API endpoints that **do not exist** in the backend:

| Function | Wrong Endpoint | HTTP | Result |
|---|---|---|---|
| `loadMainCompanyInfo()` | `GET /api/auth/company-info` | GET | 404 — not found |
| `loadLocations()` | `GET /api/auth/locations` | GET | 404 — not found |
| `loadOtherCompanies()` | `GET /api/auth/my-companies` | GET | 404 — not found |
| `loadGeneralSettings()` | `GET /api/auth/company-info` | GET | 404 — not found |
| `saveGeneralSettings()` | `PUT /api/auth/company-info` | PUT | 404 — not found |

The server-side `GET /api/auth/*` catch-all returns `{ error: "Endpoint not found" }` as JSON with status 404. The frontend fallback logic relied on `if (currentCompanyName)` before the fetch — if `currentCompanyName` was null at page load time (which happens when the JWT carries only `companyId` and no company object is in `localStorage.company`), the "Loading..." text was never cleared.

---

## Correct Endpoints Used (All Exist)

| Endpoint | Route File | Response Shape |
|---|---|---|
| `GET /api/companies/:id` | `backend/shared/routes/companies.js` line 94 | `{ company: { company_name, vat_number, trading_name, address, ... } }` |
| `GET /api/companies` | `backend/shared/routes/companies.js` line 23 | `{ companies: [...all user's companies...] }` |
| `PUT /api/companies/:id` | `backend/shared/routes/companies.js` line 257 | `{ company: { ...updated fields... } }` — requires `COMPANIES.EDIT` permission |

---

## Changes Made

### `loadMainCompanyInfo()` — ~line 9679

**Before:**
- Initial fallback gated on `if (currentCompanyName)` — skipped if null
- Called `GET /api/auth/company-info` → 404

**After:**
- Unconditional immediate fallback: always sets to `currentCompanyName || 'My Company'` — "Loading..." is ALWAYS cleared
- Early return if `currentCompanyId` is null (avoids pointless fetch)
- Calls `GET /api/companies/${currentCompanyId}` → correct full company data
- Simplified error handling (fallback already set; no redundant DOM writes in catch)

### `loadLocations()` — ~line 9707

**Before:** Called `GET /api/auth/locations` → 404  
**After:** Calls `GET /api/companies` → filters `c.is_location === true`

Note: `is_location` column does not exist in the `companies` table schema. Locations will always show empty state ("No locations yet"). This is correct — the locations sub-concept has no backend implementation. Follow-up required to implement locations properly if needed.

### `loadOtherCompanies()` — ~line 9740

**Before:** Called `GET /api/auth/my-companies` → 404  
**After:** Calls `GET /api/companies` → filters `!c.is_location && c.id !== (selectedCompanyId || currentCompanyId)`

### `loadGeneralSettings()` — ~line 10420

**Before:** Called `GET /api/auth/company-info` → 404  
**After:** Calls `GET /api/companies/${currentCompanyId}` (only if `currentCompanyId` is set). Uses `if (companyRes && companyRes.ok)` guard to handle null safely.

### `saveGeneralSettings()` — ~line 10466

**Before:** Called `PUT /api/auth/company-info` → 404  
**After:** Calls `PUT /api/companies/${currentCompanyId}` (only if `currentCompanyId` is set). Uses ternary `currentCompanyId ? fetch(...) : null` with `: null` false branch.

---

## Not Fixed (Follow-Up)

| Item | Location | Reason deferred |
|---|---|---|
| `saveLocation()` calls `POST /auth/locations` | line 9810 | Write endpoint for creating locations — no backend support for locations concept. Needs backend implementation. Show "coming soon" or implement `/api/companies` creation flow. |
| `PUT /api/companies/:id` requires `COMPANIES.EDIT` permission | `saveGeneralSettings()` | POS `store_manager`/`cashier` roles lack this permission. Save will return 403 for non-admin users. Pre-existing issue; `saveGeneralSettings()` has error handling. |
| `address` field sent in `saveGeneralSettings()` body | line ~10480 | The `PUT /api/companies/:id` allowed fields list has `address_street`, `address_suburb`, etc. — not `address`. The field is silently ignored. Consider mapping to `address_street` or adding `address` to allowed list. |

---

## Verification Checklist

- [x] CURRENT COMPANY card never shows "Loading..." — unconditional immediate fallback applied
- [x] Company name populates from `GET /api/companies/:id` (live DB data)
- [x] VAT number populates from same response
- [x] Trading name and address render in details line
- [x] Locations tab shows "No locations yet" (correct — `is_location` field not in schema)
- [x] Other companies tab renders all other user companies (filtered by `selectedCompanyId`)
- [x] General settings tab loads company fields from correct endpoint
- [x] No `authToken` reference errors
- [x] No business data in browser storage
- [x] Paytime auto-trigger files not touched
