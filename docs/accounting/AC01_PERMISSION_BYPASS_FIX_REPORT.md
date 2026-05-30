# AC-01 — Permission Bypass Fix Report

**Date:** 2026-05-27  
**Severity:** HIGH  
**Status:** FIXED  
**File changed:** `accounting-ecosystem/backend/modules/accounting/middleware/auth.js`

---

## 1. Summary

A security bypass existed in `hasPermission()` where any unknown or misspelled
permission key silently allowed the request through (`return next()`). This meant
a typo in a route's permission string, or a missing PERMISSIONS entry, granted
unrestricted access instead of blocking it. The fix makes unknown permissions
hard-fail with HTTP 403 and logs the event at ERROR level.

---

## 2. Root Cause

In `hasPermission()`, the lookup `PERMISSIONS[permission]` was checked for
falsy-ness, and on falsy the code issued:

```js
console.warn(`Unknown permission: ${permission}`);
return next();   // ← SECURITY BYPASS
```

JavaScript object key lookups return `undefined` for missing keys. A `undefined`
value is falsy, so any of the following silently passed:

- Typo: `hasPermission('accoutn.view')` instead of `hasPermission('account.view')`
- Deleted key: permission removed from PERMISSIONS map but still referenced in a route
- New route added with a not-yet-created permission key
- Casing error: `hasPermission('Account.View')`

All of these granted full access to the route.

---

## 3. Previous Dangerous Behaviour

```js
if (!allowedRoles) {
  console.warn(`Unknown permission: ${permission}`);
  return next();  // Any unknown permission = full access bypass
}
```

**Impact:**
- Any route using a non-existent or misspelled permission string was effectively
  public to any authenticated user regardless of role.
- The only logged signal was a `WARN`, which is easily missed in production logs.
- No HTTP error was returned, so API clients had no indication of the misconfiguration.

---

## 4. New Secure Behaviour

```js
if (!allowedRoles) {
  console.error('[accounting] Unknown permission', {
    permission,
    path: req.originalUrl,
    userId: req.user?.id
  });
  return res.status(403).json({
    error: 'Unknown permission configuration',
    permission
  });
}
```

**What changed:**
- Unknown permission → HTTP 403 (hard deny). Never `next()`.
- Logged at `ERROR` level with structured context: permission name, route path, user ID.
- Existing valid permissions are completely unaffected — the `allowedRoles` lookup
  path and role-array check are unchanged.

---

## 5. Files Changed

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/accounting/middleware/auth.js` | `hasPermission()` bypass removed; unknown permission now returns 403 |
| `accounting-ecosystem/backend/modules/accounting/middleware/auth.js` | `validatePermissionMap()` added and exported |
| `accounting-ecosystem/backend/modules/accounting/index.js` | `validatePermissionMap()` imported and called at module load; throws on failure so server startup aborts loudly |

No other files were modified. Route wiring, JWT logic, role model, and company
scoping are untouched.

---

## 6. Logging Improvements

**Before:**  
`console.warn(\`Unknown permission: ${permission}\`)` — plain string, WARN level,
no context.

**After:**  
```js
console.error('[accounting] Unknown permission', {
  permission,       // exact string passed to hasPermission()
  path: req.originalUrl,   // full route path of the request
  userId: req.user?.id     // authenticated user ID (if available)
});
```

This makes the event discoverable in log aggregators by:
- Severity: ERROR
- Module prefix: `[accounting]`
- Structured fields: permittable for filtering and alerting

---

## 7. Tests Required

The following manual and automated tests must pass:

| # | Test | Expected Result |
|---|---|---|
| 1 | Valid permission (`account.view`) — role `accountant` | 200 — access granted |
| 2 | Invalid permission (`account.typo`) — any role | 403 — `Unknown permission configuration` |
| 3 | Valid permission (`account.view`) — role `viewer` | 200 — access granted |
| 4 | Valid permission (`account.delete`) — role `viewer` | 403 — `Insufficient permissions` |
| 5 | Admin user (`isGlobalAdmin: true`) — any permission | 200 — global admin bypass intact |
| 6 | Accountant on `journal.post` | 200 — correct role allowed |
| 7 | Bookkeeper on `journal.post` | 403 — bookkeeper not in `journal.post` roles |
| 8 | Unknown permission — check server logs | ERROR log with permission + path + userId |
| 9 | Company scope after permission check | No regression to `enforceCompanyScope` |
| 10 | `authorize()` middleware — unchanged | Behaves identically to pre-fix |
| 11 | Server starts with valid PERMISSIONS map | Startup log: `PERMISSIONS map OK — N entries validated` |
| 12 | Temporarily set a PERMISSIONS entry to `[]` — restart | Server throws, process exits non-zero, no routes served |
| 13 | Restore valid entry — restart | Server starts cleanly, all auth routes work |

---

## 8. Remaining Risks

| Risk | Severity | Notes |
|---|---|---|
| Routes with stale permission strings not yet discovered | MEDIUM | `validatePermissionMap()` does not yet scan route files for unknown string references. See TODO in `validatePermissionMap()` for future extension. |
| `validatePermissionMap()` wired at startup | ~~LOW~~ **CLOSED** | Wired in `modules/accounting/index.js` — throws on any structural error, aborting server startup. |
| Global admin bypass unchanged — intentional | INFO | `isGlobalAdmin: true` still bypasses all permission checks. This is by design and unchanged. Verify GLOBAL_ADMIN_EMAILS env var is restricted to trusted addresses in production. |

---

### Final Safety Confirmation

- [x] Unknown permissions can never silently pass — confirmed hard 403
- [x] Unknown permissions now produce ERROR logs with full context
- [x] Existing valid permissions still function — only the falsy-branch changed
- [x] No auth weakening occurred — no roles elevated, no JWT logic touched
- [x] `validatePermissionMap()` added to catch structural PERMISSIONS issues at startup
- [x] `validatePermissionMap()` wired in `modules/accounting/index.js` — throws on error, aborts startup loudly
