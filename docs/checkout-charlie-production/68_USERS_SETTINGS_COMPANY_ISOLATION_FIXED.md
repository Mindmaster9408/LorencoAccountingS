# Codebox 68 — Users Settings Company Isolation Fix
## Checkout Charlie

**Status:** Fixed  
**Date:** 2026-06-25  
**Reported symptom:** Settings → Users company dropdown shows ALL ecosystem companies (Turkstra, Katlego, Lorenco Accounting, Infinite Legacy, etc.) instead of the active POS client only

---

## Trace

### 1. What was `loadCompaniesForUserFilter()` doing?

```javascript
async function loadCompaniesForUserFilter() {
    const res = await fetch(`${API_URL}/companies`, { ... });
    const data = await res.json();
    const companies = data.companies || [];
    // ALL companies populated into dropdown
    select.innerHTML = '<option value="">...</option>' + companies.map(...).join('');
    userSelect.innerHTML = opts;   // same list into Add User modal
    ...
}
```

### 2. Why did this show all companies?

`GET /api/companies` (backend `shared/routes/companies.js`):

```javascript
router.get('/', async (req, res) => {
    if (req.user.isSuperAdmin) {
        // Returns EVERY company in the ecosystem — no filter
        const { data } = await supabase.from('companies').select('*').order('company_name');
        return res.json({ companies: data });
    }
    // Non-admin: returns only companies the user has access to
    ...
});
```

Since Ruan, Anton, MJ, and Anrich are all `isSuperAdmin = true`, the endpoint returned the full ecosystem company list.

### 3. Was the company context (`currentCompanyId`) already correct?

Yes. `currentCompanyId` is always set from the JWT's `companyId` claim — embedded at select-company / pin-login. It is the authoritative active POS company context. The bug was that `loadCompaniesForUserFilter()` ignored it and went to the global API instead.

### 4. Was this a backend security issue?

The backend `GET /api/auth/companies/:companyId/users` uses `canManageCompanyUsers()`:

```javascript
function canManageCompanyUsers(req, companyId, accessRows) {
    if (req.user.isSuperAdmin || req.user.role === 'super_admin') return true;
    return accessRows.some(r => String(r.company_id) === String(companyId) && r.is_active);
}
```

A super_admin can fetch users for ANY company. This is intentional for the ECO admin context. The bug was the POS UI exposing this capability through a dropdown — presenting cross-company data in a single-client POS screen.

**Backend not changed.** The API behavior is correct for the ECO admin use case. The POS frontend must not expose it.

### 5. Which elements were affected?

| Element | Problem |
|---------|---------|
| `#userCompanyFilter` | Dropdown populated with all ecosystem companies |
| `#userCompanySelect` (Add User modal) | Same — user could create a user and assign to any company |
| Description text | Said "Select a company above" — implied multi-company scope |
| `viewCompanyUsers(companyId)` | Tried to pre-select an arbitrary company from the Companies section |

---

## Root Cause

> `loadCompaniesForUserFilter()` called `GET /api/companies` which returns all ecosystem companies for super_admin users. The active POS company (`currentCompanyId`) was ignored. Both the filter dropdown and Add User modal's company select were populated with the global list.

---

## Fixes Applied

### Fix 1 — `loadCompaniesForUserFilter()` — Complete rewrite (no API call)

```javascript
async function loadCompaniesForUserFilter() {
    // ISOLATION: Never calls /api/companies (returns all companies for super_admin).
    // Uses currentCompanyId from the JWT — the authoritative active POS company.
    const cId   = currentCompanyId;
    const cName = currentCompanyName || 'Active Company';

    // Update company label chip (visible in header)
    document.getElementById('userCompanyLabel').textContent = cName;

    // Set hidden selects to single option — loadCompanyUsers() / saveUser() read from these
    const singleOpt = `<option value="${cId}" selected>${cName}</option>`;
    document.getElementById('userCompanyFilter').innerHTML = singleOpt;
    document.getElementById('userCompanySelect').innerHTML = singleOpt;

    // Update Add User modal company display
    document.getElementById('userCompanyDisplay').textContent = cName;

    loadCompanyUsers();   // auto-load for currentCompanyId immediately
}
```

### Fix 2 — `#userCompanyFilter` — Hidden; replaced with company label chip

```html
<!-- Before: visible dropdown showing all companies -->
<select id="userCompanyFilter" onchange="loadCompanyUsers()">...</select>

<!-- After: company name chip (visible) + hidden select (JS compatibility) -->
<span id="userCompanyLabel" ...></span>
<select id="userCompanyFilter" style="display:none;"></select>
```

### Fix 3 — Add User modal `#userCompanySelect` — Hidden; replaced with read-only display

```html
<!-- Before: company dropdown in modal -->
<select id="userCompanySelect">...</select>

<!-- After: read-only company name display + hidden select for saveUser() -->
<div id="userCompanyDisplay" ...></div>
<select id="userCompanySelect" style="display:none;"></select>
```

Users can no longer assign a new user to a different company through the POS Settings.

### Fix 4 — `viewCompanyUsers()` — Simplified

Previously tried to pre-select an arbitrary `companyId` from the Companies list. Now simply navigates to Users section (which auto-loads the current company).

### Fix 5 — `loadCompanyUsers()` — `currentCompanyId` fallback

```javascript
const companyId = document.getElementById('userCompanyFilter')?.value || currentCompanyId;
```

Defensive fallback in case the element is not yet populated.

---

## Behaviour After Fix

### Normal POS client context (any role)
- Settings → Users shows a company name chip: e.g. `Turkstra`
- Users table auto-loads for Turkstra immediately — no dropdown interaction needed
- Add User modal shows "Turkstra" as read-only company — cannot change it
- Creating a user assigns them to Turkstra only

### Super admin in Turkstra POS context
- Settings → Users shows `Turkstra` only — same as any other user
- Cannot see or manage users from Katlego, Lorenco, etc. through this screen
- Global user management belongs in the ECO Admin dashboard — not the client POS

### Switch Store to Katlego
- `currentCompanyId` updates to Katlego's ID
- Next time Settings → Users is opened, it shows `Katlego` and loads Katlego users
- No stale cross-company data

### Cashier / non-management roles
- Users section is not accessible (role-gated via `manager-only` class and permissions)

---

## Data Flow (After Fix)

```
Login → JWT contains companyId for active POS company
       ↓
Settings → Users opened
       ↓
loadCompaniesForUserFilter()
  • reads currentCompanyId (from JWT, in memory)
  • sets label chip = currentCompanyName
  • sets hidden selects to single option = currentCompanyId
  • calls loadCompanyUsers()
       ↓
loadCompanyUsers()
  • reads companyId from hidden select (= currentCompanyId)
  • GET /api/auth/companies/:companyId/users (scoped to active company)
  • renders user table
```

---

## Security Constraints Enforced

| Constraint | Implementation |
|------------|---------------|
| No cross-company dropdown in POS Settings | `#userCompanyFilter` is hidden, set to `currentCompanyId` only |
| No global company listing in POS context | No `/api/companies` call |
| Active company from JWT only | `currentCompanyId` is set from the server-signed JWT |
| Add User scoped to active company | `#userCompanySelect` is hidden, always `currentCompanyId` |
| No hardcoded company IDs | All IDs from `currentCompanyId` (JWT) |
| No localStorage for company context | `currentCompanyId` is an in-memory JS variable set from JWT |
| Switch Store still works | `currentCompanyId` updates on company switch; re-opening Users reloads correctly |

---

## Files Changed

| File | Change |
|------|--------|
| `frontend-pos/index.html` | `loadCompaniesForUserFilter()` rewrite; usersSection header HTML; Add User modal HTML; `viewCompanyUsers()` simplification; `loadCompanyUsers()` fallback |

No backend changes required — the isolation fix is entirely frontend.
