# Codebox 65 — Cashier PIN Login + User PIN Management
## Checkout Charlie — Workstream 18

**Status:** Implemented  
**Date:** 2026-06-25  
**Scope:** Full PIN authentication system for cashier-level POS users

---

## What Was Implemented

### 1. Database Tables (pos-schema.js)

Two new tables auto-migrated on server startup via `ensurePosSchema()`:

**`user_pos_pins`**
- Stores bcrypt-hashed (12 rounds) PINs per user per company
- Unique constraint: `(company_id, user_id)` — one active PIN per user per company
- Fields: `id, company_id, user_id, pin_hash, is_active, created_at, updated_at, created_by, updated_by`
- Soft-deactivate on removal (`is_active = false`) — PIN hash is preserved for audit but PIN is non-functional

**`pos_pin_attempts`**
- Append-only log of all PIN login attempts (success and failure)
- Used for lockout enforcement: ≥ 5 failures in 15 minutes blocks further attempts
- Fields: `id, company_id, user_id, attempted_identifier, success, failure_reason, ip_address, user_agent, created_at`
- Indexed on `(company_id, user_id, success, created_at DESC)` for fast lockout queries

### 2. Audit Events (posAuditLogger.js)

Five new POS_EVENTS added:

| Event | Category | When Written |
|-------|----------|--------------|
| `USER_PIN_SET` | `pin` | Manager sets or replaces a user's PIN |
| `USER_PIN_REMOVED` | `pin` | Manager removes a user's PIN |
| `PIN_LOGIN_SUCCESS` | `auth` | Cashier successfully logs in with PIN |
| `PIN_LOGIN_FAILED` | `auth` | Wrong PIN or no PIN set |
| `PIN_LOGIN_LOCKED` | `auth` | Account locked (≥5 failures in 15 min) |

Note: `PIN_LOGIN_SUCCESS`, `PIN_LOGIN_FAILED`, `PIN_LOGIN_LOCKED` are logged via `pos_pin_attempts` table (from auth.js). `USER_PIN_SET` and `USER_PIN_REMOVED` are logged via `posAuditFromReq` from pin.js.

### 3. Backend Routes

#### PIN Management (`accounting-ecosystem/backend/modules/pos/routes/pin.js`, NEW)

Mounted at `/api/pos/users/` via `pos/index.js`. All require `authenticateToken` (from POS mount) + `SETTINGS.EDIT` permission.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/pos/users/:userId/pin-status` | Check if user has an active PIN |
| `POST` | `/api/pos/users/:userId/pin` | Set or replace a user's PIN |
| `DELETE` | `/api/pos/users/:userId/pin` | Remove (deactivate) a user's PIN |

**Security enforced in pin.js:**
- Target user must be in the same company as the caller (`req.companyId`)
- Target user must have a PIN-eligible role (cashier, senior_cashier, shift_supervisor, assistant_manager)
- PIN validated: 4–6 digits, not a known weak pattern
- bcrypt 12 rounds — same policy as password hashing
- Upsert pattern: if PIN exists it's replaced; if not, inserted

**Weak PIN rejection list:** `0000, 1111, ... 9999, 1234, 9876, and all-same-digit patterns`

#### PIN Login (`accounting-ecosystem/backend/shared/routes/auth.js`, ADDED)

`POST /api/auth/pos/pin-login`

**Why in auth.js (not POS routes):** The POS mount applies `authenticateToken` globally. A login endpoint cannot require pre-auth, so it lives in auth.js alongside other auth flows.

**Request body:**
```json
{
  "company_id": 1,          // number — preferred
  "company_name": "...",    // string — fallback if company_id not known
  "user_identifier": "jsmith",  // username, email, or employee_id
  "pin": "1234"
}
```

**Response (success):**
```json
{
  "success": true,
  "token": "...",           // JWT — same shape as select-company response
  "companyId": 1,
  "role": "cashier",
  "loginMethod": "pin",
  "company": { "id": 1, "company_name": "...", "modules_enabled": [...] },
  "user": { "id": 5, "username": "jsmith", "fullName": "John Smith" }
}
```

**Lockout flow:**
```
Request → resolve company → find user (username / email / employee_id)
       → check role is PIN-eligible
       → fetch PIN hash from user_pos_pins
       → bcrypt.compare (timing-safe dummy if user not found)
       → check lockout (≥5 failures in 15 min from pos_pin_attempts)
       → if pinMatches AND not locked → return JWT
       → else → log attempt with reason, return error
```

**Timing attack protection:**
```javascript
// Always runs bcrypt compare regardless of whether user/PIN was found
const TIMING_DUMMY = bcrypt.hashSync('__cc_pin_timing_dummy__', 10); // computed once at module load
const hashToCompare = (pinRecord && pinRecord.is_active) ? pinRecord.pin_hash : TIMING_DUMMY;
const pinMatches = await bcrypt.compare(pin, hashToCompare);
// Business logic checked AFTER the compare — not before
```

### 4. Frontend — Login Screen

Added PIN Login tab to the login box (`id="loginBox"`) in `index.html`.

**Tab switching (`switchLoginTab(tab)`):**
- Toggles visibility of `#passwordLoginSection` and `#pinLoginSection`
- Changes tab button active state
- When switching to PIN: auto-displays company name if `currentCompanyId` is already known (SSO/prior login), otherwise shows text input for company name/ID

**PIN keypad features:**
- 12-button numeric grid (1–9, C, 0, ⌫)
- Dot display (4 circles — fill purple as digits entered)
- Auto-submit on 4th digit entry (200ms delay for UX)
- Clear (C) and backspace (⌫) buttons
- `_pinLoginEntry` — in-memory string only, cleared immediately before `fetch()` call

**PIN login success path:**
```javascript
// After successful POST /api/auth/pos/pin-login:
token = result.token;
localStorage.setItem('token', token);  // auth token only — compliant with CLAUDE.md Part D
userRole           = result.role;
userPermissions    = result.permissions || {};
currentCompanyId   = result.companyId || result.company?.id;
currentCompanyName = result.company?.company_name;
currentUser        = result.user;
completeLogin();  // same function used by password login and SSO
```

**Note:** `currentCompanyId` and `currentCompanyName` are in-memory variables, NOT in localStorage. Token is in localStorage (permitted — auth token only, per CLAUDE.md Part D Rule D2).

### 5. Frontend — Settings → Users PIN Management

**PIN button in user table:** Each PIN-eligible user row (`cashier`, `senior_cashier`, `shift_supervisor`, `assistant_manager`) now shows a "PIN" button (blue) alongside the existing "Remove" button. Management roles do not get a PIN button.

**PIN Modal (`id="pinModal"`):** Opens via `showPinModal(userId, companyId)`:
1. Calls `GET /api/pos/users/:id/pin-status` to fetch current status
2. Shows user name, role, and status badge ("Active" / "Not set")
3. Inputs: New PIN (numeric, 4–6 digits) + Confirm PIN
4. "Set PIN" button → `POST /api/pos/users/:id/pin`
5. "Remove PIN" button (visible only if PIN is active) → `DELETE /api/pos/users/:id/pin`
6. On success: closes modal + shows notification

---

## Security Review

| Requirement | Implementation |
|-------------|---------------|
| PINs never stored plain | bcrypt.hash(pin, 12) — hash only |
| PINs never returned by API | No field in any response payload |
| PINs never logged | No console.log/error with pin value |
| Timing attack protection | Always bcrypt.compare — dummy hash if user/PIN not found |
| Rate/lockout server-side only | pos_pin_attempts count query — no client-side state |
| Company isolation | All DB queries scoped to `req.companyId` (from JWT) |
| No localStorage for business data | `_pinLoginEntry` is in-memory only; only `token` in localStorage |
| Role gate | PIN login only for cashier/senior_cashier/shift_supervisor/assistant_manager |
| Weak PIN rejection | Set of known weak patterns rejected server-side |
| No auth rewrite | login() function unchanged; SSO path unchanged |
| No broad frontend rewrite | Tabs added to existing loginBox; users table row augmented only |

---

## Files Changed

| File | Type | Change |
|------|------|--------|
| `backend/config/pos-schema.js` | Modified | Added `user_pos_pins` and `pos_pin_attempts` tables |
| `backend/modules/pos/services/posAuditLogger.js` | Modified | Added 5 PIN event constants + categories |
| `backend/modules/pos/routes/pin.js` | **New** | PIN management endpoints (status/set/remove) |
| `backend/modules/pos/index.js` | Modified | Mounted pin routes at `/users` |
| `backend/shared/routes/auth.js` | Modified | Added `POST /api/auth/pos/pin-login` endpoint |
| `frontend-pos/index.html` | Modified | Login PIN tab + PIN management modal + PIN button in users table |

---

## Known Prerequisite

**Tables require `DATABASE_URL` migration to run.** If `DATABASE_URL` is not set in Zeabur, `ensurePosSchema()` cannot create the new tables via direct pg connection. Supabase REST API will return "table not found" errors on PIN login attempts.

**Resolution:** Set `DATABASE_URL` in Zeabur environment variables. The migration runs automatically on next server startup.

As an alternative, the two tables can be created manually in the Supabase dashboard SQL editor using the DDL in `pos-schema.js`.

---

## Not In Scope (Future)

- PIN change self-service by the cashier (currently manager-only)
- PIN expiry / forced rotation policy
- Hardware barcode-scanner or NFC badge login (separate workstream)
- PIN login attempt history UI endpoint (`GET /api/pos/pin-attempts`)
