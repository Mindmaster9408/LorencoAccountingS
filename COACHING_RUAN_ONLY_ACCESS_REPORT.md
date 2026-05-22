# COACHING RUAN-ONLY ACCESS REPORT

**Date:** 2026-05-xx  
**Task:** HARD-LOCK COACHING APP VISIBILITY TO RUAN ONLY  
**Authorised identity:** `ruanvlog@lorenco.co.za` — `users.has_coaching_access = true`

---

## 1. Files Inspected

| File | Purpose |
|------|---------|
| `backend/sean/coaching-routes.js` | Sean coaching API routes + `requireCoachingAccess` middleware |
| `backend/shared/routes/auth.js` | Login, company selection, SSO launch |
| `frontend-ecosystem/dashboard.html` | Main dashboard — app tile rendering + SSO launch trigger |
| `frontend-coaching/index.html` | Coaching app entry page |
| `frontend-coaching/js/app.js` | Coaching app init — calls `isAuthenticated()` guard |
| `frontend-coaching/js/api.js` | Token read/write — `auth_token` key |
| `frontend-coaching/js/login.js` | Coaching login page — SSO token redirect |
| `backend/modules/coaching/middleware/auth.js` | Coaching module own JWT middleware |
| `backend/modules/coaching/routes/auth.js` | Coaching module auth routes (login, /me) |
| `backend/config/migrations/025_sean_coaching_access.sql` | DB migration — `has_coaching_access` column |

---

## 2. Current Coaching Visibility Source (Before Changes)

### How the coaching tile appeared on the dashboard:
```javascript
// BEFORE — BROKEN
const userCanAccess = (app.key === 'coaching')
    ? (!userAppsAccess || userAppsAccess.includes('coaching'))
    : ...;
```
This check relied on the company-level `apps_access` column. A `null` value (common for super-admin companies) meant ALL apps were accessible — including Coaching. Any super admin could see the tile.

### How `isActive` was gated:
```javascript
// BEFORE — BROKEN
const isActive = userCanAccess && (isSuperAdmin || companyModules.includes(app.key));
```
Super admins bypassed the `modules_enabled` check, so the tile was clickable for any super admin.

### How the Sean coaching API was guarded:
```javascript
// BEFORE — BROKEN
async function requireCoachingAccess(req, res, next) {
    if (req.user?.isSuperAdmin === true) {
        return next(); // Super admins bypassed the DB check entirely
    }
    // ...
}
```

### How the coaching app token was issued:
```javascript
// BEFORE — NO GUARD
// sso-launch issued a coaching appToken to ANY authenticated user without checking has_coaching_access
```

### Coaching module's own SSO token mapping:
```javascript
// BEFORE — SECURITY GAP
// If ecosystem SSO token didn't match by userId or email in coaching_users,
// the middleware fell back to the FIRST admin user in coaching_users.
// This allowed any user with a valid ecosystem JWT to impersonate the coaching admin.
```

---

## 3. Changes Made

### Change 1 — Remove super admin bypass in `requireCoachingAccess`
**File:** `backend/sean/coaching-routes.js`  
**Before:** `if (req.user?.isSuperAdmin === true) return next();` — bypassed DB check  
**After:** DB check always runs. No role or flag bypasses `has_coaching_access` verification.

### Change 2 — Coaching hard-lock in `sso-launch`
**File:** `backend/shared/routes/auth.js`  
**Added immediately after user fetch in `POST /api/auth/sso-launch`:**
```javascript
if (targetApp === 'coaching' && !user.has_coaching_access) {
    return res.status(403).json({
        error: 'Coaching access not authorised for this account',
        code: 'NO_COACHING_ACCESS',
    });
}
```
Non-Ruan users cannot obtain a coaching `appToken` under any circumstances.

### Change 3 — Add `hasCoachingAccess` to login response
**File:** `backend/shared/routes/auth.js`  
**Added to user object in `POST /api/auth/login` response:**
```javascript
hasCoachingAccess: !!(user.has_coaching_access),
```
The login uses `select('*')` so this field is always available. It is stored in `eco_user` localStorage (auth/session data — permitted under CLAUDE.md Part D).

### Change 4 — Fix coaching tile visibility check
**File:** `frontend-ecosystem/dashboard.html`  
**Before:**
```javascript
const userCanAccess = (app.key === 'coaching')
    ? (!userAppsAccess || userAppsAccess.includes('coaching'))
    : ...;
```
**After:**
```javascript
// Coaching HARD LOCK: tile only ever shows when the authenticated user
// has hasCoachingAccess = true (sourced from login response / DB flag).
const userCanAccess = (app.key === 'coaching')
    ? (currentUser?.hasCoachingAccess === true)
    : ...;
```

### Change 5 — Fix coaching `isActive` check
**File:** `frontend-ecosystem/dashboard.html`  
**Before:** `const isActive = userCanAccess && (isSuperAdmin || companyModules.includes(app.key));`  
**After:**
```javascript
const isActive = app.key === 'coaching'
    ? userCanAccess
    : userCanAccess && (isSuperAdmin || companyModules.includes(app.key));
```
Coaching bypasses `modules_enabled` gating — it is active whenever the DB flag says yes.

### Change 6 — Remove coaching admin fallback in coaching module `authenticateToken`
**File:** `backend/modules/coaching/middleware/auth.js`  
**Before:** If an SSO token's userId wasn't found in `coaching_users` and email lookup also failed, the code fell back to the first `coaching_users` row with `role = 'admin'`. Any ecosystem user could impersonate the coaching admin.  
**After:** Fallback removed. If the email does not match a `coaching_users` row, the middleware returns `401 User not found`. The `sso-launch` guard ensures only Ruan ever gets an SSO token for coaching, so legitimate SSO tokens always match by email.

### Change 7 — Inline auth guard in coaching `index.html`
**File:** `frontend-coaching/index.html`  
**Added in `<head>` before any content renders:**
```javascript
(function () {
    var token = localStorage.getItem('auth_token');
    if (!token) {
        window.location.replace('/');
    }
}());
```
If a user navigates directly to `/coaching/index.html` without a valid `auth_token`, they are immediately redirected to the ecosystem root (`/`) before any content or API call is attempted.

---

## 4. Database Foundation

Migration `025_sean_coaching_access.sql` (applied in a prior session):
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_coaching_access BOOLEAN NOT NULL DEFAULT false;
UPDATE users SET has_coaching_access = true
WHERE email = 'ruanvlog@lorenco.co.za' AND has_coaching_access = false;
CREATE INDEX IF NOT EXISTS idx_users_has_coaching_access ON users (has_coaching_access) WHERE has_coaching_access = true;
```

- `DEFAULT false` — every new user is blocked by default
- Only `ruanvlog@lorenco.co.za` has `has_coaching_access = true`
- No manual DB change required to block a user — default is already blocked

---

## 5. Access Flow (After Changes)

### Ruan (authorised):
1. Logs in → `hasCoachingAccess: true` in login response → stored in `eco_user`
2. Dashboard renders Coaching tile (visible and active)
3. Clicks Coaching → `sso-launch` checks `has_coaching_access` → passes → issues `appToken`
4. Stores `appToken` as `auth_token` → navigates to `/coaching`
5. `login.html` sees `auth_token` → redirects to `index.html`
6. `app.js` `isAuthenticated()` → passes
7. All API calls carry the appToken → coaching module's `authenticateToken` matches by email → grants access
8. `requireCoachingAccess` on Sean coaching routes → DB check passes

### Any other user (blocked at every layer):
1. Logs in → `hasCoachingAccess: false` in login response
2. Dashboard: Coaching tile is **never rendered** (`currentUser?.hasCoachingAccess === true` is false)
3. Even if they manually call `sso-launch` with `targetApp: 'coaching'` → **403 NO_COACHING_ACCESS**
4. Even if they navigate directly to `/coaching/index.html` → **inline guard redirects to `/`** (no `auth_token`)
5. Even if they somehow have a stale `auth_token` → all Sean coaching API routes run DB check → **403** (no `has_coaching_access`)
6. Even if they have a valid ecosystem JWT and somehow bypass all above → coaching module `authenticateToken` requires email match in `coaching_users` — no fallback admin → **401**

---

## 6. Tests

| # | Test | Expected | Layer |
|---|------|----------|-------|
| T1 | Ruan logs in | Coaching tile visible and clickable | Frontend |
| T2 | Ruan clicks Coaching tile | SSO launch succeeds, coaching app opens | Backend + Frontend |
| T3 | Super admin logs in | Coaching tile absent from dashboard | Frontend |
| T4 | Accountant/admin/user logs in | Coaching tile absent from dashboard | Frontend |
| T5 | Any non-Ruan user calls `POST /api/auth/sso-launch` with `targetApp: 'coaching'` | 403 `NO_COACHING_ACCESS` | Backend |
| T6 | Navigate directly to `/coaching/index.html` without token | Redirect to `/` | Frontend |
| T7 | Call any `GET /api/sean/coaching/*` route as super admin (no DB flag) | 403 | Backend |
| T8 | Send ecosystem SSO JWT for non-Ruan user to `/api/coaching/*` | 401 `User not found` (email not in coaching_users) | Backend |
| T9 | No payroll or business data in localStorage | Pass | Architecture |
| T10 | `hasCoachingAccess` in `eco_user` is a display flag, not business data | Permitted under CLAUDE.md Part D | Architecture |

---

## 7. Remaining Risks

| Risk | Severity | Notes |
|------|----------|-------|
| `coaching_users` table could have non-Ruan email rows | LOW | If another user is inserted into `coaching_users` directly (DB), they could use the coaching app's own `/api/coaching/auth/login` endpoint with email+password. This is separate from the ecosystem auth. The fix is to ensure `coaching_users` only contains Ruan. |
| `auth_token` can be manually set in browser DevTools | LOW | If someone pastes a valid ecosystem JWT as `auth_token`, they bypass the frontend check. However, all API calls still fail: (1) ecosystem JWT decoded userId won't match coaching_users, (2) email fallback only works for Ruan, (3) Sean coaching routes always check `has_coaching_access`. They would see the blank coaching shell with all API calls returning 403/401. |
| `eco_user.hasCoachingAccess` could be tampered in localStorage | LOW | Only affects tile display (frontend). SSO launch guard (backend) is the authoritative control. A tampered flag would make the tile appear but `sso-launch` would still return 403. |

---

## 8. No Regressions

- All other app tiles unchanged: the non-coaching path `isSuperAdmin || !userAppsAccess || userAppsAccess.includes(app.key)` is identical to before
- Payroll module: untouched, all 14 regression tests remain valid
- Login flow: only additive change (`hasCoachingAccess` field added — no existing field changed)
- SSO launch: only adds a guard before existing logic — no existing app launch path changed
- `requireCoachingAccess` middleware: only removes a bypass — makes it stricter, not weaker

---

*Report generated end of session — all 7 changes committed and pushed.*
