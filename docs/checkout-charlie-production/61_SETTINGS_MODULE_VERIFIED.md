# 61 — Settings Module Regression: Verified

**Date:** 2026-06-17  
**Status:** ✅ PASS

---

## Verification: Settings section-loader regression fix (f359103 revert)

**Claim:** 5 deleted dispatch branches restored in active `showSettings()`; `loadMainCompanyInfo`, `loadGeneralSettings`, `saveGeneralSettings` moved from non-existent `/auth/company-info` to correct `/companies/:id` endpoints; loading fallback hardened.

**Method:** Git diff inspection + Node.js syntax check on extracted JS block + targeted grep verification of each fix point. Server not started (as instructed — this is a static JS file served by Zeabur; no compile step, no local server required for code verification).

---

## Steps

1. ✅ **Git diff confirms exactly 5 edits in `index.html`** — no other files in scope touched:
   - `@@ -7150` — showSettings dispatch block (+5 handlers)
   - `@@ -9147` — loadMainCompanyInfo rewrite (endpoint + hardening)
   - `@@ -9894` — loadGeneralSettings endpoint fix
   - `@@ -9937` — saveGeneralSettings endpoint fix
   - `@@ -9974` — null-safe `companyRes.ok` check

2. ✅ **Syntax check PASSED** — Node.js `--check` on the 404,381-char main JS block found zero parse errors.

3. ✅ **Point 1 — active `showSettings()` dispatch (line 7153–7158):**
   ```javascript
   if (section === 'companies')  { loadCompanies(); }
   if (section === 'general')    { loadGeneralSettings(); }
   if (section === 'users')      { loadCompaniesForUserFilter(); }
   if (section === 'customers')  { loadCustomers(); }
   if (section === 'suppliers')  { loadSettingsSuppliers(); }
   if (section === 'tills')      { loadSettingsTills(); }
   ```
   All 6 handlers present. `customers` preserved (was the only survivor of f359103). 5 deleted handlers restored.

4. ✅ **Point 2 — `loadMainCompanyInfo` endpoint (line 9169):**
   ```javascript
   const res = await fetch(`${API_URL}/companies/${currentCompanyId}`, {
   ```
   Old `/auth/company-info`: **zero occurrences in the entire file** (grep confirmed absent).

5. ✅ **Point 3 — `loadGeneralSettings` endpoint + null guard (lines 9906–9911):**
   ```javascript
   const companyRes = currentCompanyId
       ? await fetch(`${API_URL}/companies/${currentCompanyId}`, { ... })
       : null;
   if (companyRes && companyRes.ok) {
   ```
   Null guard present. Old endpoint absent.

6. ✅ **Point 4 — `saveGeneralSettings` endpoint + null guard + null-safe ok check (lines 9951–9990):**
   ```javascript
   const companyRes = currentCompanyId
       ? await fetch(`${API_URL}/companies/${currentCompanyId}`, { method: 'PUT', ... })
       : null;
   ...
   if ((!companyRes || companyRes.ok) && settingsRes.ok) {
   ```
   Null guard present. Null-safe check present. Old endpoint absent.

7. 🔍 **Probe — old `/auth/company-info` anywhere in file:** Zero matches. The endpoint is fully eliminated from all four functions that previously called it.

8. 🔍 **Probe — dead first `showSettings` not modified:** Line 5611–5651 first definition unchanged. It still has `companies` via `if/else if` chain and calls `loadCompanies()`. It remains dead code (overridden by second definition). No accidental changes to it.

9. 🔍 **Probe — no duplicate dispatch handlers:** Each section name appears exactly once in the active `showSettings` block (lines 7153–7158). No double-calls.

10. 🔍 **Probe — no localStorage/sessionStorage writes for business data introduced:** Diff contains no `localStorage.setItem`, `sessionStorage.setItem`, or `safeLocalStorage.setItem` calls. Compliant with CLAUDE.md Part D.

---

## Settings Section Behaviour After Fix

| Section | Handler in active showSettings | Data source | Expected result |
|---|---|---|---|
| Companies | `loadCompanies()` ✅ restored | `GET /api/companies/:id` | Current Company card populates |
| General | `loadGeneralSettings()` ✅ restored | `GET /api/companies/:id` + `GET /api/pos/settings` | Company fields pre-fill |
| Users | `loadCompaniesForUserFilter()` ✅ restored | `GET /api/auth/companies` | Company dropdown populates |
| Customers | `loadCustomers()` ✅ preserved | `GET /api/customers` | Unchanged — was working |
| Suppliers | `loadSettingsSuppliers()` ✅ restored | existing supplier endpoint | Supplier list loads |
| Tills | `loadSettingsTills()` ✅ restored | existing tills endpoint | Tills list loads |

---

## Loading Fallback States (loadMainCompanyInfo)

| Condition | Card shows | Stuck "Loading..."? |
|---|---|---|
| Function called with valid companyId | `currentCompanyName` instantly, then DB name | ❌ Never |
| `currentCompanyId` null | "Current company unavailable" (+ console.warn) | ❌ Never |
| API returns non-200 | `currentCompanyName` or "Current company unavailable" | ❌ Never |
| Network error | `currentCompanyName` or "Current company unavailable" | ❌ Never |

---

## Findings

- ⚠️ **`PUT /api/companies/:id` requires `COMPANIES.EDIT` permission** (line 257 of `companies.js`). POS `cashier` / `store_manager` roles likely lack this. Settings → General → Save will show "Some settings may not have saved" for those users. This is pre-existing, not introduced here. `PUT /api/pos/settings` (POS-specific settings) will still save even if company save is blocked.

- ⚠️ **`address` field in `saveGeneralSettings` body** maps to a column that `PUT /api/companies/:id` may not accept (doc 54 noted `address_street`/`address_suburb` columns, not `address`). The save silently ignores the field. Pre-existing issue, not in scope of this fix.

- 🔍 **Dead `showSettings` at line 5611**: Has a different structure (`if/else if` chain, explicit `display = 'block'` per section). Safe to remove in a future cleanup session. Not executable — second definition wins at runtime.

- 🔍 **`loadLocations()` (line 9182) still calls `GET /auth/locations`** which does not exist in auth.js (also a f359103 regression, or possibly pre-dating it). This affects the Locations tab in Settings → Companies. Out of scope for this fix — the Current Company card and General/Users/Suppliers/Tills are the critical paths.

---

## No Regressions Introduced

- Backend unchanged
- Payroll auto-trigger files not touched
- Auth flow unchanged
- No business data in browser storage
- No permissions weakened or tightened
- `loadCustomers()` behaviour preserved exactly
