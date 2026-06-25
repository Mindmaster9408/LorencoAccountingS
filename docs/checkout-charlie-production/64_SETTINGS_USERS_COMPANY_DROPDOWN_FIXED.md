# Codebox 64 — Settings → Users Company Dropdown Fix
## Checkout Charlie — Settings Regression

**Status:** Fixed  
**Date:** 2026-06-25  
**Scope:** Settings → Users tab — company dropdown shows "Select company..." with no options; users table stuck on "Select a company to view its users"

---

## Root Cause

`loadCompaniesForUserFilter()` called a non-existent API endpoint:

```javascript
// BROKEN — endpoint does not exist (returns 404)
const res = await fetch(`${API_URL}/auth/companies/all`, { ... });
```

**Why it was invisible:** The `if (res.ok)` check silently skipped the entire populate block on 404. The `catch` block only did `console.log` — no visible error. The dropdown was left with only the static `<option value="">Select company...</option>` in the HTML.

**The correct endpoint** is mounted at `/api/companies` (server.js line 228):

```javascript
app.use('/api/companies', authenticateToken, companiesRoutes);
```

`GET /api/companies` returns `{ companies: [...] }` — exactly what the existing `data.companies || []` mapping already expected. No backend change required.

---

## Fix Applied

**File:** `accounting-ecosystem/frontend-pos/index.html` — `loadCompaniesForUserFilter()` (~line 9560)

### Changes:

1. **Fixed endpoint URL** — `/auth/companies/all` → `/companies`

2. **Added auto-select + auto-load** — after populating the dropdown, if `currentCompanyId` is set, the active company is pre-selected and `loadCompanyUsers()` is called automatically. Users now load without any manual dropdown interaction when the current company context is already known.

3. **Added visible error states** — on non-ok response and on network error, the users table body now shows a red error message instead of silently staying empty.

### Before:
```javascript
async function loadCompaniesForUserFilter() {
    try {
        const res = await fetch(`${API_URL}/auth/companies/all`, {   // ← 404
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {                                                 // ← never entered
            const data = await res.json();
            const companies = data.companies || [];
            // ... populate dropdowns ...
        }
        // No auto-select. No auto-load. No user-visible error.
    } catch (e) {
        console.log('Error loading companies for filter:', e);        // ← silent
    }
}
```

### After:
```javascript
async function loadCompaniesForUserFilter() {
    try {
        const res = await fetch(`${API_URL}/companies`, {             // ← correct
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
            // surface error to user, not just console
            if (tbody) tbody.innerHTML = '<tr><td ...>Failed to load companies...</td></tr>';
            return;
        }
        const data = await res.json();
        const companies = data.companies || [];
        // ... populate dropdowns ...

        // Auto-select active company and load users
        if (currentCompanyId) {
            const match = companies.find(c => c.id === currentCompanyId || String(c.id) === String(currentCompanyId));
            if (match) {
                select.value = match.id;
                loadCompanyUsers();
            }
        }
    } catch (e) {
        console.error('[settings/users] loadCompaniesForUserFilter error:', e);
        if (tbody) tbody.innerHTML = '<tr><td ...>Failed to load companies — network error.</td></tr>';
    }
}
```

---

## Endpoint Confirmed

| Endpoint | Exists | Response shape | Notes |
|----------|--------|---------------|-------|
| `GET /api/auth/companies/all` | ❌ No — 404 | — | Was the broken call |
| `GET /api/companies` | ✅ Yes | `{ companies: [...] }` | Super admin → all companies; others → their accessible companies |
| `GET /api/auth/companies/:id/users` | ✅ Yes | `{ users: [...] }` | Used by `loadCompanyUsers()` — unchanged, already correct |

---

## Required Behaviour Checklist

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Settings → Users opens | ✅ Unchanged |
| 2 | Company dropdown loads companies | ✅ Fixed — calls correct endpoint |
| 3 | Current active company pre-selected if `currentCompanyId` exists | ✅ Added |
| 4 | Users for selected company load automatically | ✅ Added — `loadCompanyUsers()` called after auto-select |
| 5 | Empty state only shows if company genuinely has no users | ✅ Unchanged — `loadCompanyUsers()` existing logic handles this |
| 6 | No stuck "Select company..." when companies exist | ✅ Fixed |
| 7 | Clear error message if companies fail to load | ✅ Added — visible red error in table body |

---

## Security Review

- No backend change — endpoint security unchanged
- No hardcoded company IDs — `currentCompanyId` comes from JWT-decoded session context
- Company isolation preserved — `GET /api/companies` returns only companies the authenticated user has access to (super admin → all; others → their assigned companies via `user_company_access`)
- No localStorage/sessionStorage for business data — `currentCompanyId` is an in-memory JS variable set at login

---

## viewCompanyUsers() Chain — Not Broken

`viewCompanyUsers(companyId)` (called from the Companies settings list to jump to a specific company's users) chains `.then()` on `loadCompaniesForUserFilter()`. This still works:

```javascript
loadCompaniesForUserFilter().then(() => {
    document.getElementById('userCompanyFilter').value = companyId;  // overrides auto-select
    loadCompanyUsers();                                               // loads correct company
});
```

The auto-select inside `loadCompaniesForUserFilter()` triggers `loadCompanyUsers()` once (for `currentCompanyId`), then `.then()` immediately overrides the selection with `companyId` and calls `loadCompanyUsers()` again. Two lightweight GET requests, no visible flicker, correct final state.

---

## Remaining Settings Users Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| Duplicate `showSettings()` function defined twice in `index.html` (lines ~5611 and ~7139) | Low | Second definition shadows first. Both call `loadCompaniesForUserFilter()` for users section so behaviour is correct. Should be cleaned up in a future consolidation pass. |
| `userCompanySelect` (add-user modal dropdown) populated with same opts — null-guarded | Low | The `if (userSelect)` guard added avoids a crash if the modal element isn't in DOM yet. |
| No "Add User" permission gate on the button visibility | Low | The Add User button is visible to all authenticated users with Settings access. Backend POST correctly requires appropriate role — but the button should ideally be hidden for read-only roles. |
| User edit (role change / deactivate) not available in UI | Low | Remove is available; edit is not. Future workstream. |
