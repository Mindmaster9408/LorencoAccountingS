# Paytime Company Access Propagation Fix

> Implemented: March 2026
> File changed: `backend/shared/routes/auth.js`
> Area: `sso-launch` and `select-company` endpoints — eco_clients delegated access path

---

## CHANGE IMPACT NOTE

- **Area being changed:** SSO launch flow and select-company flow — cross-company access gate in `auth.js`
- **Files/services involved:** `backend/shared/routes/auth.js` only
- **Current behaviour identified:** When a user with a restricted role (e.g. `employee`, `cashier`, `viewer`) at a practice tried to launch a client app via SSO, the `ALLOWED_CROSS_ROLES` gate blocked them with "You do not have access to this company" — even when an admin had explicitly granted them `user_app_access` for that app and `user_client_access` for that client.
- **Required behaviours to preserve:** Superadmin bypass unchanged. Direct `user_company_access` path unchanged. `ALLOWED_CROSS_ROLES` still blocks unrestricted cross-practice access for restricted roles. Only the explicit-grant delegated path is new.
- **Risk of regression:** Low — additive check only. If no explicit grants exist, the existing 403 is returned as before.
- **Safe implementation plan:** After `ALLOWED_CROSS_ROLES` check fails, run a secondary check against `user_app_access` (sso-launch) and `user_client_access` (both endpoints). Proceed only if both conditions are satisfied. No data mutations.

---

## 1. Root Cause

### The symptom

After an admin used the Admin Panel to:
1. Set Johan (business owner) on a client company
2. Set Johan's employee (role: `employee` or similar) to have app access to Paytime + client visibility for that client

...the employee could see the client card and the Paytime app button in the ecosystem dashboard, but clicking "Open Lorenco Paytime" produced:

> **Failed to open Lorenco Paytime. You do not have access to this company.**

### The blocker

Both `POST /api/auth/sso-launch` and `POST /api/auth/select-company` have this cross-practice gate:

```javascript
const ALLOWED_CROSS_ROLES = ['business_owner', 'accountant', 'super_admin', 'store_manager'];
if (!practiceAccess || !ALLOWED_CROSS_ROLES.includes(practiceAccess.role)) {
    return res.status(403).json({ error: 'You do not have access to this company' });
}
```

This gate exists to prevent any user who merely belongs to a practice from freely SSO-ing into all clients. That is correct.

**But:** The gate was a binary pass/fail — it never checked whether the admin had explicitly granted the user app-level or client-level access. The `user_app_access` and `user_client_access` tables were checked later in the flow (app-level gate at lines 718+), but they were never reached because the role gate fired first.

---

## 2. The Fix

### `sso-launch` — delegated access path

When `ALLOWED_CROSS_ROLES` check fails but the user **does** have a practice role (i.e. `practiceAccess` is not null), check:

1. Does the user have an explicit `user_app_access` row for `targetApp` at the practice company?
2. Does the user have explicit `user_client_access` rows for this eco_client — OR zero rows (unrestricted)?

If both are true → allow. The user's role from `practiceAccess` is used in the issued JWT (just as it is for allowed roles).

```javascript
// New delegated access path in sso-launch
if (practiceAccess && targetApp) {
    const [appGrantResult, clientRowsResult] = await Promise.all([
        supabase.from('user_app_access').select('id')
            .eq('user_id', user.id)
            .eq('company_id', ecoClient.company_id)
            .eq('app_key', targetApp)
            .maybeSingle(),
        supabase.from('user_client_access').select('eco_client_id')
            .eq('user_id', user.id)
            .eq('company_id', ecoClient.company_id),
    ]);
    if (appGrantResult.data) {
        const clientAccessRows = clientRowsResult.data || [];
        if (clientAccessRows.length === 0) {
            delegatedAccess = true; // unrestricted
        } else {
            delegatedAccess = clientAccessRows.some(r => r.eco_client_id === ecoClient.id);
        }
    }
}
```

### `select-company` — delegated access path

Same logic but without `targetApp` (select-company is company-scoped, not app-scoped):

1. Does the user have explicit `user_client_access` rows — OR zero rows (unrestricted)?

```javascript
// New delegated access path in select-company
if (practiceAccess) {
    const { data: clientAccessRows } = await supabase
        .from('user_client_access').select('eco_client_id')
        .eq('user_id', userId)
        .eq('company_id', ecoClient.company_id);
    const rows = clientAccessRows || [];
    if (rows.length === 0) {
        delegatedAccess = true; // unrestricted
    } else {
        delegatedAccess = rows.some(r => r.eco_client_id === ecoClient.id);
    }
}
```

---

## 3. Permission Model After Fix

| Scenario | Access granted? | Reason |
|---|---|---|
| Role in `ALLOWED_CROSS_ROLES` (accountant, business_owner, etc.) | ✅ Yes | Existing path, unchanged |
| Role NOT in `ALLOWED_CROSS_ROLES` + no practice access row at all | ❌ No | Cannot delegate without practice membership |
| Role NOT in `ALLOWED_CROSS_ROLES` + practice row exists + no explicit app grant | ❌ No | No delegation without app grant |
| Role NOT in `ALLOWED_CROSS_ROLES` + practice row + app grant + zero client rows | ✅ Yes | Delegated: unrestricted client visibility |
| Role NOT in `ALLOWED_CROSS_ROLES` + practice row + app grant + client row for THIS client | ✅ Yes | Delegated: explicit client visibility |
| Role NOT in `ALLOWED_CROSS_ROLES` + practice row + app grant + client rows but NOT this client | ❌ No | Explicit restrict to other clients |

### Key security properties preserved

- A user at a practice with no practice role cannot gain cross-client access (delegated path requires `practiceAccess` to be non-null).
- A user with a practice role but no explicit app grant cannot reach restricted clients via SSO.
- Multi-tenant isolation is preserved: `client_company_id` is never changed; the eco_client chain is scoped to practices the user actually belongs to.

---

## 4. Related Tables

| Table | Role in this flow |
|---|---|
| `user_company_access` | Practice membership + role. Required for delegated path. |
| `user_app_access` | Explicit per-user, per-practice, per-app grant. Required for `sso-launch` delegation. |
| `user_client_access` | Explicit per-user, per-practice, per-eco_client visibility. Zero rows = unrestricted. |
| `eco_clients` | Maps `client_company_id` → `company_id` (practice). Used to find the practice. |

---

## 5. Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: user_app_access app_key values
- Dependency: app_key in user_app_access must exactly match the targetApp strings used in sso-launch
  ('pos', 'payroll', 'accounting', 'sean', 'coaching')
- Confirmed now: sso-launch validates targetApp against these values before reaching the access check
- Not yet confirmed: Whether the Admin Panel's "App Access" UI writes the correct app_key values
- Risk if wrong: Delegated access would silently fail (appGrantResult.data would be null)
- Recommended next check: Audit the app access grant write path in users.html or admin-panel.js

FOLLOW-UP NOTE
- Area: select-company delegated path — no app_key check
- What was done: select-company delegated path only checks user_client_access, not user_app_access
- Why: select-company is company-scoped. The app check happens further down in the sso-launch flow.
  Duplicate app checking in select-company would be redundant for the Paytime scenario.
- Risk: A delegated user can select-company into a client silo even without an app grant for that app.
  This is acceptable — selecting a company without launching an app does nothing harmful.
- Recommended: No change needed. The app gate remains in sso-launch where it belongs.
```

---

## 6. Testing Checklist

**Delegated access (employee role):**
- [ ] Employee with `user_app_access(app_key='payroll')` + zero `user_client_access` rows → can open Paytime for any client ✅
- [ ] Employee with `user_app_access(app_key='payroll')` + explicit `user_client_access` for Client A → can open Paytime for Client A ✅
- [ ] Employee with `user_app_access(app_key='payroll')` + explicit `user_client_access` for Client A → cannot open Paytime for Client B ❌ (blocked)
- [ ] Employee with NO `user_app_access` + zero `user_client_access` rows → cannot open Paytime ❌ (blocked)
- [ ] Employee with NO practice membership at all → cannot open Paytime ❌ (blocked)

**Regression — existing roles:**
- [ ] Accountant at practice can still SSO into all clients ✅
- [ ] Business owner can still SSO into all clients ✅
- [ ] Super admin can still SSO into any company ✅
- [ ] User with NO practice role and NO eco_client chain cannot access any client ❌ (blocked)
