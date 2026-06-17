# 60 — Settings Module Regression: Implemented

**Date:** 2026-06-17  
**File changed:** `accounting-ecosystem/frontend-pos/index.html`  
**Status:** ✅ IMPLEMENTED  
**Based on trace:** [59_CURRENT_COMPANY_TRACE.md](59_CURRENT_COMPANY_TRACE.md)

---

## Root Cause (from 59)

Commit `f359103` (May 23 2026) deleted 5 of 6 section-loader dispatch branches from the active `showSettings()` function, leaving only `customers`. It also reverted `loadMainCompanyInfo()`, `loadGeneralSettings()`, and `saveGeneralSettings()` to call a non-existent `/auth/company-info` endpoint.

---

## Changes Made

### Change 1 — Restore 5 deleted dispatch branches in active `showSettings()` (~line 7151)

**Before** (only customers survived f359103):
```javascript
if (section_element) {
    section_element.style.display = 'block';
    if (section === 'customers') {
        loadCustomers();
    }
}
```

**After** (all 6 handlers restored):
```javascript
if (section_element) {
    section_element.style.display = 'block';
    if (section === 'companies')  { loadCompanies(); }
    if (section === 'general')    { loadGeneralSettings(); }
    if (section === 'users')      { loadCompaniesForUserFilter(); }
    if (section === 'customers')  { loadCustomers(); }
    if (section === 'suppliers')  { loadSettingsSuppliers(); }
    if (section === 'tills')      { loadSettingsTills(); }
}
```

---

### Change 2 — Restore `loadMainCompanyInfo()` correct endpoint + hardening (~line 9152)

**Before:**
```javascript
async function loadMainCompanyInfo() {
    // conditional — stays "Loading..." if currentCompanyName is null
    if (currentCompanyName) {
        document.getElementById('mainCompanyName').textContent = currentCompanyName;
    }
    try {
        const res = await fetch(`${API_URL}/auth/company-info`, { ... });  // 404 — does not exist
        ...
    }
}
```

**After:**
```javascript
async function loadMainCompanyInfo() {
    const nameEl    = document.getElementById('mainCompanyName');
    const vatEl     = document.getElementById('mainCompanyVat');
    const detailsEl = document.getElementById('mainCompanyDetails');

    // Unconditional immediate clear — no path may leave "Loading..." on screen
    nameEl.textContent    = currentCompanyName || 'Loading company...';
    vatEl.textContent     = '-';
    detailsEl.textContent = '';

    if (!currentCompanyId) {
        console.warn('[POS] loadMainCompanyInfo: currentCompanyId is null — cannot load company details');
        nameEl.textContent = 'Current company unavailable';
        return;
    }

    try {
        const res = await fetch(`${API_URL}/companies/${currentCompanyId}`, { ... });  // ✅ exists
        if (res.ok) {
            const company = data.company || {};
            nameEl.textContent    = company.company_name || currentCompanyName || 'My Company';
            vatEl.textContent     = company.vat_number || '-';
            detailsEl.textContent = [company.trading_name, company.address ? '| ' + company.address : '']
                .filter(Boolean).join(' ').trim();
        } else {
            console.warn('[POS] loadMainCompanyInfo: API returned', res.status, 'for company', currentCompanyId);
            nameEl.textContent = currentCompanyName || 'Current company unavailable';
        }
    } catch (e) {
        console.warn('[POS] loadMainCompanyInfo error:', e.message);
        nameEl.textContent = currentCompanyName || 'Current company unavailable';
    }
}
```

**Endpoint changed:** `GET /auth/company-info` → `GET /companies/${currentCompanyId}`  
(`GET /api/companies/:id` exists in `backend/shared/routes/companies.js` line 94)

---

### Change 3 — Restore `loadGeneralSettings()` correct endpoint (~line 9906)

**Before:** `GET /auth/company-info` (404)  
**After:** `GET /companies/${currentCompanyId}` with null guard if no company id

---

### Change 4 — Restore `saveGeneralSettings()` correct endpoint (~line 9951)

**Before:** `PUT /auth/company-info` (404)  
**After:** `PUT /companies/${currentCompanyId}` with null guard (skips company save if no id)

---

### Change 5 — Guard null companyRes in saveGeneralSettings success check (~line 9990)

**Before:** `if (companyRes.ok && settingsRes.ok)` — TypeError if companyRes is null  
**After:** `if ((!companyRes || companyRes.ok) && settingsRes.ok)` — safe when no company id

---

## Endpoints Used

| Function | Endpoint | Backend file | Line |
|---|---|---|---|
| `loadMainCompanyInfo` | `GET /api/companies/:id` | `companies.js` | 94 |
| `loadGeneralSettings` | `GET /api/companies/:id` | `companies.js` | 94 |
| `saveGeneralSettings` | `PUT /api/companies/:id` | `companies.js` | 257 |

Response shape from `GET /api/companies/:id`: `{ company: { company_name, vat_number, trading_name, address, registration_number, contact_phone, contact_email, ... } }`

---

## Loading Fallback Behaviour (loadMainCompanyInfo)

| Condition | Card shows |
|---|---|
| Function called (any path) | Immediately shows `currentCompanyName` or "Loading company..." |
| `currentCompanyId` null | "Current company unavailable" (+ console.warn) |
| API returns 200 | `company.company_name` from DB |
| API returns non-200 | `currentCompanyName` or "Current company unavailable" |
| Network error | `currentCompanyName` or "Current company unavailable" |

No condition leaves "Loading..." stuck on screen.

---

## What Was NOT Changed

- No backend files touched
- No auth/payroll/migration files touched
- No `localStorage`/`sessionStorage` business data written
- Settings layout, HTML structure, CSS unchanged
- `loadLocations()` and `loadOtherCompanies()` unchanged (already using correct endpoints from doc 54)
- Dead first `showSettings()` definition at line 5611 left in place (unreachable dead code — safe to remove in future cleanup)

---

## Note on `PUT /api/companies/:id` Permission

`saveGeneralSettings()` calls `PUT /api/companies/:id` which requires `COMPANIES.EDIT` permission. POS `cashier` / `store_manager` roles may lack this permission and will receive a 403. This is pre-existing behaviour, not introduced by this fix. `saveGeneralSettings()` has error handling via the `(!companyRes || companyRes.ok)` check which will show "Some settings may not have saved".
