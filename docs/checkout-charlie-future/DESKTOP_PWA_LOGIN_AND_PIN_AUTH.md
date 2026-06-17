# Checkout Charlie — Desktop/PWA Login & Cashier PIN Auth

**Status:** DESIGN ONLY — do not implement until explicitly instructed  
**Date:** 2026-06-17  
**Scope:** `accounting-ecosystem/frontend-pos/index.html` + `backend/shared/routes/auth.js` + new migration

---

## 1. Current State Audit

### What exists today

| Area | Current State |
|---|---|
| Login method | Username/email + password only |
| JWT | 8h expiry, carries `userId`, `companyId`, `role`, `isSuperAdmin` |
| Session resume | `localStorage.token` checked on `window.load`; if valid → skip login, resume POS |
| PWA | Service worker registered, `manifest.json` linked, `forceUpdatePending` flag gates checkout |
| Force update | SW version check → `onForceUpdateRequired()` → sets `forceUpdatePending = true` → blocks `addToCart`/checkout |
| PIN | **Zero existing PIN code anywhere** — clean slate |
| Audit | `audit_log` table with `auditFromReq()` — action_type, entity_type, metadata, IP, user-agent |
| Roles | `cashier` (20), `senior_cashier` (30), `shift_supervisor` (40), `assistant_manager` (50), `store_manager` (70), `super_admin` (100) |

### Current session resume gap (desktop/PWA problem)

When POS is launched as a PWA or desktop shortcut, `window.onload` runs. If `localStorage.token` is present and not expired, `completeLogin()` is called immediately — **no login screen is shown**.

This means:
- Anyone who finds an open device walks straight into the active session
- Cashier shift-change requires the previous session to log out manually
- Expired tokens (past 8h) correctly show login, but valid tokens bypass it entirely

**This must change for desktop/PWA deployment.** The correct model: token proves the user is enrolled, but the device must still show a login/PIN screen on each app launch.

---

## 2. Recommended Architecture

### Core principle

```
Device launches POS
       ↓
Always show login screen
       ↓
User authenticates (password OR PIN)
       ↓
Server validates → issues JWT → completeLogin()
       ↓
Till session flow (resume / open / warn)
```

The existing session resume shortcut (`localStorage.token` → skip login) should be **disabled for standalone PWA mode**. In browser tabs (normal usage), it can remain to preserve the current eco-dashboard SSO flow.

### Two login methods

```
┌─────────────────────────────────────────────┐
│           CHECKOUT CHARLIE LOGIN             │
│                                              │
│  ┌──────────────┐  ┌───────────────────┐    │
│  │  PASSWORD    │  │   CASHIER PIN     │    │
│  │  (Tab 1)     │  │   (Tab 2)         │    │
│  └──────────────┘  └───────────────────┘    │
│                                              │
│  Password tab:          PIN tab:             │
│  • Username field       • Username field     │
│  • Password field       • 4-6 digit keypad  │
│  • Login button         • Backspace/Clear    │
│                         • Submit on 4th/6th  │
└─────────────────────────────────────────────┘
```

- **Password tab**: existing login, unchanged. For managers, admins, store owners.
- **PIN tab**: new. For cashiers. Username field + numeric keypad. Optional: pre-populated username list for the company.

---

## 3. Database Changes Required

### New table: `user_pos_pins`

```sql
CREATE TABLE user_pos_pins (
    user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id  INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    pin_hash    TEXT         NOT NULL,          -- bcrypt hash, 12 rounds
    is_active   BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by  INTEGER      REFERENCES users(id),  -- who set/reset the PIN
    PRIMARY KEY (user_id, company_id)
);
```

**Design notes:**
- Composite primary key `(user_id, company_id)` — one PIN per user per company. Same user can have different PINs in different branches/companies.
- `pin_hash` — bcrypt with 12 rounds. Never store plain text. Never return in API responses.
- `created_by` — audit trail: who reset this PIN and when.
- No `pin_value` column, no plain-text column, no reversible encryption.

### New table: `pos_pin_attempts`

```sql
CREATE TABLE pos_pin_attempts (
    id              SERIAL       PRIMARY KEY,
    user_id         INTEGER      REFERENCES users(id),  -- null if user not found
    company_id      INTEGER      NOT NULL,
    ip_address      TEXT,
    attempted_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    success         BOOLEAN      NOT NULL
);

-- Index for lockout checks (recent failures per user+company)
CREATE INDEX idx_pin_attempts_lookup
    ON pos_pin_attempts (user_id, company_id, attempted_at DESC)
    WHERE success = false;
```

**Design notes:**
- Even if the username is wrong, log the attempt (with `user_id = null`) for IP-based rate limiting.
- No PIN value or attempt value stored — just success/fail.
- Retention: `pos_pin_attempts` older than 30 days can be pruned (not audit-critical; the `audit_log` table holds the compliance copy via `PIN_LOGIN_FAILED` events).

---

## 4. API Endpoints Required

### 4.1 POST `/api/auth/pin-login`

**Purpose:** Authenticate a user by username + PIN. Returns same JWT structure as `/login`.

**Auth required:** None (public endpoint — it IS the authentication)

**Request body:**
```json
{
  "username": "jane.smith",
  "pin": "1234",
  "companyId": 42
}
```

**Response (success 200):**
```json
{
  "success": true,
  "token": "eyJ...",
  "user": { "id": 7, "username": "jane.smith", "fullName": "Jane Smith" },
  "selectedCompany": { "id": 42, "company_name": "City Store", "role": "cashier" },
  "loginMethod": "pin"
}
```

**Response (failure 401 — all failures):**
```json
{ "error": "Invalid credentials" }
```

**Response (locked 429):**
```json
{ "error": "Too many failed attempts. Try again in 15 minutes." }
```

**Server logic:**

```
1. Validate: username, pin (4-6 digits), companyId present
2. Find user: SELECT from users WHERE (username OR email) = :username AND is_active = true
3. Check user is linked to companyId: SELECT from user_company_access WHERE user_id = :id AND company_id = :companyId AND is_active = true
4. Check role is PIN-eligible: role must be in [cashier, senior_cashier, shift_supervisor, assistant_manager, trainee]
   — store_manager and above must use password login
5. Check lockout: SELECT count(*) from pos_pin_attempts WHERE user_id = :id AND company_id = :companyId AND success = false AND attempted_at > now() - interval '10 minutes'
   — if count >= 5: INSERT failed attempt; audit PIN_LOGIN_LOCKED; return 429
6. Find PIN record: SELECT from user_pos_pins WHERE user_id = :id AND company_id = :companyId AND is_active = true
7. If no PIN record: INSERT failed attempt; audit PIN_LOGIN_FAILED; return 401 generic
8. bcrypt.compare(pin, pin_hash)
9. If mismatch: INSERT failed attempt; audit PIN_LOGIN_FAILED; return 401 generic
10. Success: INSERT success attempt; audit PIN_LOGIN_SUCCESS with loginMethod: 'pin'
11. Build JWT (same structure as /login, companyId embedded)
12. Return token + user + selectedCompany
```

**Security rules:**
- Never reveal whether the user exists, PIN exists, or PIN is wrong. `"Invalid credentials"` for all failure cases.
- Never reveal remaining attempts count in the error response (reveals user existence).
- Do not log the submitted PIN value anywhere (not even partially).

---

### 4.2 POST `/api/auth/users/:userId/pin`

**Purpose:** Manager creates or resets a cashier's PIN.

**Auth required:** `authenticateToken` + `requireCompany` + role check (must be `store_manager` or above)

**Request body:**
```json
{ "pin": "5678" }
```

Or omit `pin` to have the server generate a random 4-digit PIN.

**Response (200):**
```json
{
  "success": true,
  "pin": "5678",
  "message": "PIN set. Show this to the cashier — it will not be displayed again."
}
```

**Server logic:**

```
1. Authenticate caller; verify caller's role >= store_manager
2. Verify target userId belongs to caller's companyId (cross-company PIN reset is blocked)
3. Verify target user's role is PIN-eligible (cannot set PIN for another manager)
4. Generate or validate PIN: 4-6 digits
5. bcrypt.hash(pin, 12)
6. UPSERT into user_pos_pins (user_id, company_id, pin_hash, created_by, updated_at)
7. Audit: PIN_RESET, entityType: 'user', entityId: userId, metadata: { resetBy: caller.userId }
8. Return { success: true, pin: rawPin }
```

**Note:** Raw PIN is returned once, in the response only. Caller must display it to the cashier. It is never stored and cannot be retrieved again.

---

### 4.3 DELETE `/api/auth/users/:userId/pin`

**Purpose:** Deactivate a cashier's PIN (forces password login or PIN reset before next PIN login).

**Auth required:** `authenticateToken` + `requireCompany` + role check

**Response:** `{ "success": true }`

**Server logic:** UPDATE `user_pos_pins SET is_active = false` where `user_id = :userId AND company_id = req.companyId`. Audit `PIN_DEACTIVATED`.

---

### 4.4 GET `/api/auth/users/:userId/pin-status`

**Purpose:** Check whether a cashier has a PIN set (for the Settings → Users UI).

**Auth required:** `authenticateToken` + manager role

**Response:**
```json
{ "hasPIN": true, "lastUpdated": "2026-06-15T10:22:00Z" }
```

Does NOT return the hash. Never returns hash.

---

## 5. Frontend Login Flow

### 5.1 PWA/Desktop startup detection

```javascript
function isStandaloneMode() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;  // iOS Safari PWA
}
```

On `window.onload`:

```
if (sso_source === 'ecosystem') {
    → pickup SSO token (existing flow, unchanged)
    → completeLogin() immediately
    return;
}

if (isStandaloneMode()) {
    → ALWAYS show login screen, even if token exists in localStorage
    → pre-fill username from localStorage if available (UX only — does not skip auth)
    → do NOT call completeLogin() without new authentication
} else {
    → resume existing session if token valid (current browser behavior, unchanged)
}
```

This preserves the ecosystem dashboard SSO path and the browser session resume path, while enforcing login on desktop/PWA launch.

---

### 5.2 Login screen UI changes

**Add:** a PIN tab to the existing login box.

```html
<!-- Tab switcher (add to existing loginBox) -->
<div id="loginTabs">
    <button onclick="switchLoginTab('password')" id="tabPassword" class="tab active">Password</button>
    <button onclick="switchLoginTab('pin')" id="tabPIN" class="tab">Cashier PIN</button>
</div>

<!-- PIN tab content (new, hidden by default) -->
<div id="pinLoginBox" style="display:none;">
    <input type="text" id="pinUsername" placeholder="Username or email" autocomplete="username" />
    <div id="pinDisplay">• • • •</div>  <!-- shows dots as PIN entered -->
    <div id="pinKeypad">
        <button onclick="pinKey('1')">1</button>
        <button onclick="pinKey('2')">2</button>
        <button onclick="pinKey('3')">3</button>
        <button onclick="pinKey('4')">4</button>
        <button onclick="pinKey('5')">5</button>
        <button onclick="pinKey('6')">6</button>
        <button onclick="pinKey('7')">7</button>
        <button onclick="pinKey('8')">8</button>
        <button onclick="pinKey('9')">9</button>
        <button onclick="pinClear()">C</button>
        <button onclick="pinKey('0')">0</button>
        <button onclick="pinBackspace()">⌫</button>
    </div>
    <div id="pinError" style="display:none;"></div>
</div>
```

**PIN entry logic:**

```javascript
let pinBuffer = '';
const PIN_LENGTH = 4;  // configurable: 4 or 6

function pinKey(digit) {
    if (pinBuffer.length >= PIN_LENGTH) return;
    pinBuffer += digit;
    updatePinDisplay();
    if (pinBuffer.length === PIN_LENGTH) {
        submitPinLogin();
    }
}

function pinBackspace() {
    pinBuffer = pinBuffer.slice(0, -1);
    updatePinDisplay();
}

function pinClear() {
    pinBuffer = '';
    updatePinDisplay();
}

function updatePinDisplay() {
    const dots = '•'.repeat(pinBuffer.length) + '○'.repeat(PIN_LENGTH - pinBuffer.length);
    document.getElementById('pinDisplay').textContent = dots;
}

async function submitPinLogin() {
    const username = document.getElementById('pinUsername').value.trim();
    if (!username) {
        showPinError('Enter your username first');
        pinClear();
        return;
    }
    try {
        const res = await fetch(`${API_URL}/auth/pin-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, pin: pinBuffer, companyId: selectedCompanyId || null })
        });
        const data = await res.json();
        if (res.ok && data.token) {
            token = data.token;
            currentUser = data.user;
            selectedCompanyId = data.selectedCompany?.id;
            currentCompanyId = data.selectedCompany?.id;
            currentCompanyName = data.selectedCompany?.company_name;
            userRole = data.selectedCompany?.role;
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(currentUser));
            localStorage.setItem('company', JSON.stringify(data.selectedCompany));
            completeLogin();
        } else if (res.status === 429) {
            showPinError('Too many failed attempts. Wait 15 minutes.');
        } else {
            showPinError('Invalid credentials');
            pinClear();
        }
    } catch (e) {
        showPinError('Connection error. Check network.');
        pinClear();
    }
}
```

**Note:** `companyId` from the PIN login request: the cashier must log in to a specific company. If `selectedCompanyId` is not yet set at login time, the PIN endpoint needs the company. Two options:
- Option A: Show company selector before PIN entry (existing company selector screen is already implemented in the POS)
- Option B: Embed company in PIN tab based on a company code or display list
- **Recommended: Option A** — reuse existing company selector flow, then show PIN/password choice.

---

### 5.3 Session expiry guard

Currently, API 401/403 responses are handled inconsistently. A global intercept should be added:

```javascript
async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    if (res.status === 401 || res.status === 403) {
        const body = await res.json().catch(() => ({}));
        if (body.error === 'Invalid or expired token') {
            handleSessionExpiry();
            return null;
        }
    }
    return res;
}

function handleSessionExpiry() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('company');
    token = null;
    currentUser = null;
    showNotification('Session expired. Please log in again.', 'warning');
    showLoginScreen();
}
```

This is a new helper. Implementation should audit the existing `fetch()` calls and migrate to `apiFetch()` progressively, or wrap at least the most critical paths (checkout, cashup, void).

---

### 5.4 Force update + login

Current: `forceUpdatePending` blocks `addToCart` and checkout. It does **not** block login.

**Correct behavior for desktop/PWA:**
- Force update should block checkout and new sales (existing)
- Force update should **not** block the login screen from appearing
- After login, if `forceUpdatePending`, show a persistent banner and disable checkout until refresh

No change needed to the `forceUpdatePending` gate. The existing implementation is correct — it blocks `addToCart()` which prevents any sale from completing. Login still works so cashiers can still log in and check prior sales/reports.

---

## 6. PIN Reset Flow

### 6.1 Manager sets PIN for a cashier (Settings → Users)

```
Manager opens Settings → Users
     ↓
Selects cashier row → sees "PIN Status: Set / Not Set"
     ↓
Clicks "Reset PIN" or "Set PIN"
     ↓
Modal: "Generate PIN automatically" toggle + optional manual PIN entry
     ↓
Confirm → POST /api/auth/users/:userId/pin
     ↓
Response shows generated PIN once in a highlighted box
"PIN: 4821 — Show this to the cashier. It cannot be retrieved again."
     ↓
Manager tells cashier the PIN (in person — not by message/email for security)
     ↓
Cashier uses PIN at next login
```

### 6.2 Cashier self-service PIN change

Not included in initial design. Cashiers cannot change their own PIN without manager involvement. This prevents PIN social engineering. If needed in future: add `POST /api/auth/pin/change` requiring `current_pin` + `new_pin` + authentication.

### 6.3 PIN deactivation

Manager can deactivate a cashier's PIN via `DELETE /api/auth/users/:userId/pin`. This forces the cashier back to password login until a new PIN is set. Use case: cashier leaves, PIN is decommissioned immediately.

---

## 7. Audit Events

All events go to the existing `audit_log` table via `logAudit()`.

| Event `action_type` | `entity_type` | Trigger | `metadata` |
|---|---|---|---|
| `PIN_LOGIN_SUCCESS` | `user` | Successful PIN login | `{ companyId, loginMethod: 'pin', role }` |
| `PIN_LOGIN_FAILED` | `user` | Wrong PIN or user not found | `{ companyId, reason: 'invalid_credentials' }` |
| `PIN_LOGIN_LOCKED` | `user` | Lockout threshold reached | `{ companyId, attemptCount: N, lockoutUntil }` |
| `PIN_SET` | `user` | Manager creates PIN for cashier | `{ setBy: managerId, companyId }` |
| `PIN_RESET` | `user` | Manager resets PIN | `{ resetBy: managerId, companyId }` |
| `PIN_DEACTIVATED` | `user` | Manager deactivates PIN | `{ deactivatedBy: managerId, companyId }` |
| `LOGIN` | `user` | Existing password login (already logged) | `{ loginMethod: 'password' }` (add to existing) |
| `SESSION_EXPIRED` | `user` | Token expiry on frontend (optional — client-side only) | — |

**Existing `LOGIN` event:** The `POST /api/auth/login` route already calls `auditFromReq(req, 'LOGIN', ...)`. Add `loginMethod: 'password'` to its metadata to distinguish from PIN logins in the audit trail.

---

## 8. Security Rules

### 8.1 Rate limiting and lockout

| Parameter | Value | Rationale |
|---|---|---|
| Lockout threshold | 5 failed attempts | Industry standard; low enough to deter brute force |
| Lockout window | 10 minutes rolling | Measured from first failed attempt in the window |
| Lockout duration | 15 minutes | Auto-expires; manager cannot override (prevents social engineering) |
| Max PIN length | 6 digits | 4-digit = 10,000 combinations; 6-digit = 1,000,000 |
| Min PIN length | 4 digits | Ergonomic minimum for keypad entry |

**10,000 combinations / 5 attempts per 15 minutes = 1.1 years to brute-force a 4-digit PIN under lockout.**  
This is adequate for a company-network terminal. If the device is shared externally, require 6-digit PINs.

### 8.2 Forbidden PINs

On PIN creation/reset, reject:
- Sequential: `1234`, `2345`, `3456`, `4567`, `5678`, `6789`, `9876`, etc.
- Repeated: `0000`, `1111`, `2222`, `9999`, etc.
- Common: `1234`, `0000`, `1111`, `1212`, `2580`, `2468`

Enforce server-side in `POST /api/auth/users/:userId/pin`. Return `{ error: "PIN is too simple. Choose a less predictable combination." }`.

### 8.3 Timing attack protection

Use `bcrypt.compare()` even when no PIN record exists, to prevent timing-based user enumeration:

```javascript
const dummyHash = '$2a$12$invalidhashforcomparisononlyXXXXXXXXXXXXXXXXXXXXXXXXX';
await bcrypt.compare(pin, pinRecord?.pin_hash || dummyHash);
```

This ensures the response time is consistent whether or not the user/PIN exists.

### 8.4 Role restriction

Only these roles may use PIN login:
- `trainee` (5)
- `cashier` (20)
- `senior_cashier` (30)
- `shift_supervisor` (40)
- `assistant_manager` (50)

These roles may NOT use PIN login (must use password):
- `store_manager` (70) and above

Rationale: managers have access to voids, refunds, user management, and financial reports. Higher-risk access requires stronger authentication. A PIN on a shared device is not strong enough for management access.

### 8.5 Company-scoped PIN isolation

- `user_pos_pins` has `company_id` in primary key
- `POST /api/auth/pin-login` requires `companyId` in request body
- PIN login endpoint verifies `user_company_access` exists for `(user_id, companyId)` before checking PIN
- A PIN set in Company A does not work in Company B, even for the same user

### 8.6 PIN in transit

- HTTPS only (Zeabur enforces this)
- PIN sent as plain string in POST body over HTTPS — acceptable
- Never log the PIN value anywhere: not in `audit_log`, not in `pos_pin_attempts`, not in console
- `pin_hash` never returned in API responses

### 8.7 Device security (out of scope for server)

Document for pilot:
- POS devices should not be left logged in and unattended
- Physical lock screens are the device operator's responsibility
- PIN login is designed for shift-start identification, not for securing the physical device
- After idle timeout (recommended: 10 minutes), force re-authentication via PIN or password

---

## 9. Till Flow After PIN Login

The `completeLogin()` function is called identically after PIN login and password login. No changes needed to the till flow:

```
completeLogin()
    ↓
Check forceUpdatePending → show banner if true
    ↓
manageSession()
    ↓
GET /api/pos/sessions/current
    ↓
┌──────────────────────────────────────────────────────┐
│ Open session found?                                  │
│   Yes → resume till screen                          │
│   No  → show "Open Till" screen                     │
│                                                      │
│ Selected till locked?                               │
│   → show warning, prompt till selection             │
│                                                      │
│ Printer degraded (from SW/service)?                 │
│   → show warning banner (non-blocking)              │
│                                                      │
│ Sync paused (offline)?                              │
│   → show offline banner (existing behavior)         │
└──────────────────────────────────────────────────────┘
```

No till flow changes required for PIN auth.

---

## 10. Settings → Users PIN Management UI

Add to the existing Settings → Users section:

```
Users table — add column: PIN Status
┌──────────────┬──────────┬────────────┬─────────────────────────────────────┐
│ User         │ Role     │ PIN Status │ Actions                             │
├──────────────┼──────────┼────────────┼─────────────────────────────────────┤
│ Jane Smith   │ cashier  │ ✅ Set     │ [Edit] [Reset PIN] [Deactivate PIN] │
│ Tom Brown    │ cashier  │ ⚠️ Not set │ [Edit] [Set PIN]                    │
│ Ruan V.      │ manager  │ N/A        │ [Edit] (PIN not available)          │
└──────────────┴──────────┴────────────┴─────────────────────────────────────┘
```

PIN actions only show for PIN-eligible roles. Manager rows show "N/A — managers use password login."

**PIN modal:**
```
Set PIN for Jane Smith
────────────────────────
○ Generate PIN automatically (recommended)
● Enter PIN manually: [____]

[Cancel]  [Set PIN]
```

After save, show once:
```
✅ PIN set successfully
────────────────────────
PIN: 4821

Give this PIN to Jane Smith in person.
It will not be shown again.

[Copy to Clipboard]  [Done]
```

---

## 11. Pilot Rollout Plan

### Phase 1 — Backend only (no frontend visible change)
1. Apply DB migration: create `user_pos_pins` and `pos_pin_attempts` tables
2. Deploy `POST /api/auth/pin-login` endpoint
3. Deploy `POST /api/auth/users/:userId/pin` endpoint
4. Deploy `DELETE /api/auth/users/:userId/pin`
5. Deploy `GET /api/auth/users/:userId/pin-status`
6. Test endpoints directly (API testing only, no UI)

### Phase 2 — Settings UI (manager-facing)
7. Add PIN Status column to Settings → Users table
8. Add Set PIN / Reset PIN modal
9. Manager can set PINs for cashiers
10. Test: set PIN → verify `user_pos_pins` row created with hash

### Phase 3 — Login screen PIN tab (cashier-facing)
11. Add PIN tab to login screen
12. Numeric keypad component
13. `submitPinLogin()` function
14. Test: cashier PIN login → reaches till screen with correct role
15. Test: lockout after 5 failed attempts

### Phase 4 — PWA startup gating
16. Add `isStandaloneMode()` check
17. In standalone mode: disable session resume shortcut, always show login
18. Test: install PWA → open → login screen appears, not POS directly
19. Test: valid token + standalone → still shows login

### Phase 5 — Session expiry guard
20. Add `apiFetch()` wrapper for critical paths
21. Test: expire token manually → verify login screen appears on next API call

### Rollback plan
- PIN tables can be dropped without affecting any existing functionality
- Login screen PIN tab is additive — removing it restores original login
- Session resume gating is behind `isStandaloneMode()` — browser users unaffected

---

## 12. What This Design Does NOT Cover

| Item | Notes |
|---|---|
| Biometric login (fingerprint/face) | Future — WebAuthn API when hardware supports it |
| QR code / NFC badge login | Future — requires physical hardware provisioning |
| Cashier self-service PIN change | Excluded by design — requires manager to prevent social engineering |
| Device registration / trusted device list | Future — would reduce PIN entry frequency on known devices |
| Push notification on failed PIN attempts | Future — notify manager when lockout triggered |
| TOTP / 2FA for managers | Future — add to manager password flow separately |
| Offline PIN login | Not possible — PIN verification requires server (hash comparison). Offline mode: existing session only. |

---

## 13. File Impact When Built

| File | Change |
|---|---|
| `backend/shared/routes/auth.js` | Add 4 new routes; add `loginMethod` to existing LOGIN audit |
| `backend/middleware/auth.js` | No change |
| `backend/config/permissions.js` | No change (PIN eligibility checked by role level, not permission) |
| `frontend-pos/index.html` | Add PIN tab to login box; add `isStandaloneMode()` check; add `apiFetch()` wrapper; add PIN keypad JS |
| `frontend-pos/manifest.json` | Review — ensure `display: standalone` is set |
| DB migration | `user_pos_pins` table + `pos_pin_attempts` table + index |

**Paytime auto-trigger files: NONE TOUCHED.** This design does not affect any payroll-related files.

---

*This is a design document. No code is to be written until explicitly instructed.*
