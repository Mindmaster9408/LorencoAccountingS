# Workstream 82 — Device Identity System
## Checkout Charlie

**Status:** Implemented and verified (real headless-Chromium tests over a real local HTTP server, mocked API responses — see verification section)
**Date:** 2026-07-08
**Scope:** A production-grade, backend-authoritative device identity system. Once a manager activates a device, employees on that device only ever enter a PIN — no company, store, or till selection, ever again, until the device is revoked or replaced.

> **Note on doc numbering:** the ticket requested `82_DEVICE_IDENTITY_SYSTEM_IMPLEMENTED.md`, which collides numerically with the previous workstream's `82_INTER_COMPANY_STOCK_TRANSFER_V1_VERIFIED.md`. The filename is exactly as requested; the duplicate `82` prefix is a harmless naming collision (both files are uniquely named in full), not a versioning error — see the same note in Workstream 81's doc for the same reason.

---

## Audit — What Was There Before (and why it had to be replaced, not extended)

A "Device Lock" feature already existed (`Settings → 🔒 Device Lock`, `deviceLockMenuItem`) — but it was **entirely client-side**:

- `lockDeviceToCurrentCompany()` / `lockDeviceToSelectedCompany()` did nothing but `localStorage.setItem('pos_locked_company_id', ...)`.
- `applyDeviceLock()` read that same key back and hid the company selector.
- **No backend table, no backend route, no server-side check of any kind existed.** The comment above the old code even claimed *"Cashiers cannot switch companies on this device"* — untrue: any cashier could open DevTools, clear or edit `localStorage`, and defeat the entire lock. This is a direct violation of this codebase's own standing rule (`CLAUDE.md` Part D / this ticket's own "Backend authoritative. Frontend never trusted." requirement).

This is exactly the gap this ticket describes closing. Per Core Rule 1 ("root-cause fix > patch"), this workstream **replaces** that mechanism rather than building a second, parallel one alongside it. The new system reuses the *same* two localStorage keys (`pos_locked_company_id`/`pos_locked_company_name`) as a **display-layer cache only** — they now only ever get set as the *result* of a real backend validation, and the actual security boundary (whether PIN login succeeds) is enforced server-side on every single login attempt regardless of what's cached locally.

Also found and reused: a real, already-hardened PIN login endpoint (`POST /api/auth/pos/pin-login`, `backend/shared/routes/auth.js`) with timing-safe bcrypt comparison, per-user lockout, and full `user_pos_pins`/`pos_pin_attempts` infrastructure (Workstream 18). This workstream extends that endpoint rather than replacing it — see below.

---

## Architecture

**Core principle:** the device, not the browser session, is the trusted identity. A `pos_devices` row is the single source of truth for "which company/till does this physical device belong to." Every future POS capability the ticket names (till assignment, receipt printer, cash drawer, barcode scanner, offline queue, device health, shift control, cashups, audit trail) can attach to this same `pos_devices.id` — none of it needs a second identity concept.

```
┌─────────────────────────────────────────────────────────────────┐
│  Physical device (browser/PWA)                                  │
│  localStorage: pos_device_token (opaque, 256-bit random)        │
└───────────────────────────┬─────────────────────────────────────┘
                             │ GET /api/auth/pos/device/validate
                             │ (no JWT — device_token is the credential)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  pos_devices                                                     │
│  id · company_id · till_id · device_token_hash (SHA-256)        │
│  device_name · status (active/revoked) · last_seen_at           │
│  last_user_id · pin_fail_count · pin_locked_until/unlocked_at    │
└───────────────────────────┬─────────────────────────────────────┘
                             │ resolves company_id — never client-supplied
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  POST /api/auth/pos/pin-login                                   │
│  requires device_token + user_identifier + pin                  │
│  → validates device status, device-level lockout, user-level    │
│    lockout, bcrypt PIN — in that order                          │
└───────────────────────────────────────────────────────────────────┘
```

---

## Authentication Flow

### Flow 1 — First Device Activation
No new pre-login screen was built (see "Design Decision" below). Instead: a manager logs in **normally** (existing, unmodified password login — zero risk to the most safety-critical code path in the app). Right after a successful login, if this browser has no `pos_device_token` yet **and** the logged-in user has a management role, the app shows the **Activate This Device** modal: pick a till (optional), name the device (e.g. *"Turkstra Retail Counter 1"*), click **🔒 Lock This Device**. This calls `POST /api/pos/devices/register`, which returns a device token exactly once. The manager can also skip this and activate later from `Settings → Device Management`.

### Flow 2 — Normal Daily Login
App boots → `checkDeviceIdentity()` calls `GET /api/auth/pos/device/validate` with the stored token → on success, the company/till are shown read-only (*"🔒 Trusted Device — Turkstra Retail — Till 1"*), the PIN tab is the default, and the manual company-entry field is hidden. Employee enters PIN → `identifies user → opens shift → audit event → POS ready`, unchanged from the existing Workstream 18 flow, now additionally gated on the device.

### Flow 3 — Shift End
Logout returns to the same trusted-device PIN screen (`logout()`/`logoutFromCompanySelector()` re-render via the cached `trustedDevice` state — no re-validation network call needed for a same-session logout).

### Flow 4 — Manager Login
Unchanged and always available — the existing Password/PIN tab switcher on the login screen was not touched; a manager can always switch to password login regardless of device state (including a revoked device, so a manager can walk up to a "bricked" device and immediately re-activate it — see Flow 6).

### Flow 5 — Device Replacement
`Settings → Device Management` lists every device. **Replace** on an old device: the manager (now logged in *on the new physical device*) is prompted for a new device name; `POST /api/pos/devices/:id/replace` revokes the old row and creates a new one with the same `till_id`, returning a fresh token which this browser stores. Old device is immediately revoked as part of the same transaction-equivalent (two sequential writes, both audited).

### Flow 6 — Lost or Stolen Device
**Revoke** on any device: `POST /api/pos/devices/:id/revoke` sets `status = 'revoked'`. Every subsequent `pin-login` and `device/validate` call against that token now returns 403/`device_error: 'revoked'` — PIN login is blocked immediately, and the app clears its local token and shows the unknown-device state on next check. A revoked device is never un-revoked; only a fresh registration (Replace or a new Activate) brings the physical device back.

### Flow 7 — Cache Cleared
No `pos_device_token` found at boot → `checkDeviceIdentity()` short-circuits, shows the *"🆕 This device is not activated yet"* banner, and PIN login is client-side blocked with a clear message until a manager re-activates it (server-side, `pin-login` would reject with `unknown_device` regardless, even if the client check were bypassed).

### Flow 8 — Offline Mode
Documented honestly rather than half-built: if `device/validate` is unreachable at boot, the app falls back to the **last confirmed** company/till from the localStorage cache rather than forcing re-activation on a transient network blip. **Actual PIN login still requires a live connection** — this codebase's offline capability (IndexedDB sales queue) only ever activates *after* an already-authenticated session; there is no local credential store for PIN validation itself, and building one is a materially larger, separately-scoped security undertaking (see the future doc's "Not Built" section for the recommended design).

---

## Design Decision: Why No Dedicated Pre-Login "Activate Device" Screen

The ticket describes Flow 1 as a distinct screen shown *before* any login. This implementation instead offers activation as a modal immediately *after* a completely normal, unmodified password login. This was a deliberate risk-reduction choice:

- The login boot sequence is the single highest-blast-radius piece of code in this app — a bug there means **no one can use the POS at all**, at any company, on any device.
- Building a second, parallel pre-login screen would have meant either forking `login()`/`selectCompany()`/`completeLogin()` or writing a new manager-auth path from scratch — both meaningfully increase the surface area of a change to the riskiest code in the system.
- The chosen design achieves the *identical end-user outcome* the ticket cares about (device activated once → all future logins are PIN-only) while the only new code path in the existing login sequence is a single `if (pendingDeviceActivation && managementRole) showDeviceActivationModal()` at the very end of `completeLogin()` — everything before that point is completely untouched.

This is flagged here explicitly, not hidden, per CLAUDE.md's "never hide uncertainty" rule — if a literal pre-login branded screen is wanted, it is a small, low-risk follow-up now that the backend and modal already exist.

---

## Security Model

| Rule | Implementation |
|---|---|
| PIN login only on trusted devices | `pin-login` rejects outright (400) with no `device_token`; looks up the device by SHA-256(token) and rejects (401/403) if unknown or not `active` |
| Company is never client-supplied for PIN login | Company is *always* resolved from `device.company_id` server-side; the old `company_id`/`company_name` body fields were removed from the endpoint entirely |
| PIN never stored plaintext | Unchanged, pre-existing: bcrypt, 12 rounds (`user_pos_pins.pin_hash`) |
| PIN comparison rate-limited | Unchanged, pre-existing: 5 failures / 15 min per **user** |
| Device-level lockout ("Not only user lock. Device lock.") | **New**: 5 failures / 15 min per **device** (any user), independent of and in addition to the per-user check, scoped via a new `pos_pin_attempts.device_id` column. Manager unlock via `POST /api/pos/devices/:id/unlock` sets `pin_unlocked_at`, which immediately re-opens the lockout window regardless of the 15-minute timer — matching *"Manager unlock required"* literally. |
| Timing-safe comparisons | Unchanged, extended: `bcrypt.compare` against a dummy hash still runs on every unknown-device/revoked-device/lockout path so response timing never leaks which failure occurred |
| Backend authoritative, frontend never trusted | Every device-scoped fact (company, till, status) is re-fetched/re-validated server-side on every `pin-login` call — the frontend's cached `trustedDevice`/`localStorage` state is display-only |
| Device token storage | SHA-256 hash only, unique-indexed for fast exact-match lookup — **not** bcrypt, deliberately: the token is 256 bits of random entropy, not a human-guessable secret, so it needs fast deterministic lookup, not slow salted hashing (the same reasoning GitHub/Stripe apply to API-key storage) |
| No business data in localStorage | Only `pos_device_token` (an auth-token-equivalent, explicitly permitted under CLAUDE.md Part D2) and `pos_locked_company_id`/`pos_locked_company_name` (a display cache of an already-backend-validated fact, never itself the enforcement point) |

---

## Backend Model

**Schema** (`accounting-ecosystem/backend/config/pos-schema.js`, additive):
- `pos_devices` — id, company_id, till_id, device_token_hash (unique), device_name, status, platform, user_agent, app_version, registered_by/at, last_seen_at, last_user_id, pin_fail_count, pin_locked_until, pin_unlocked_at, revoked_by/at/reason, replaced_by_device_id, created_at, updated_at.
- `pos_pin_attempts.device_id` — new column, backs the device-level lockout.

**Routes:**
- `backend/shared/routes/auth.js` (pre-auth, alongside `pin-login`):
  - `GET /api/auth/pos/device/validate` — the boot-time check. Device-token-authenticated, no JWT.
  - `POST /api/auth/pos/pin-login` — extended (see Security Model above). **Change Impact Note**: this file is on the Paytime-protected shared-file list; assessed and confirmed LOW payroll risk — the change is scoped entirely to the POS-only `/pos/pin-login` route and one new route, neither touched by payroll's own login/select-company paths.
- `backend/modules/pos/routes/devices.js` (new file, mounted `/api/pos/devices`, standard JWT + `SETTINGS.EDIT` management-only gate):
  - `POST /register`, `GET /`, `PATCH /:id/rename`, `POST /:id/revoke`, `POST /:id/replace`, `POST /:id/unlock`.

**Audit events** (all 7, category `device`): `DEVICE_REGISTERED`, `DEVICE_RENAMED`, `DEVICE_REVOKED`, `DEVICE_REPLACED`, `DEVICE_PIN_LOCKED`, `DEVICE_UNLOCKED`, `DEVICE_VALIDATION_FAILED`. Also wired (previously defined but never actually fired): `PIN_LOGIN_SUCCESS`/`PIN_LOGIN_FAILED`/`PIN_LOGIN_LOCKED` now fire on every attempt.

## Frontend Model

- `checkDeviceIdentity()` — boot-time validator, replaces the old `applyDeviceLock()` direct call.
- `applyDeviceLock()` — now a pure renderer of already-validated state (company/till banner, PIN screen context).
- `showDeviceActivationModal()` / `submitDeviceActivation()` / `skipDeviceActivation()` — Flow 1's second step.
- `loginWithPin()` — sends `device_token`; on `unknown_device`/`revoked` responses, clears local state and reverts to the unknown-device banner.
- `Settings → Device Management` (`deviceLockSection`, function `loadDeviceSettings()`) — real device list from `GET /api/pos/devices`, with Rename/Replace/Revoke/Unlock-PIN actions, replacing the old insecure lock/unlock buttons entirely.

---

## Future Integrations (designed for, not built)

Every one of these can attach to `pos_devices.id` without a schema change to this table:
- **Receipt printer / cash drawer / customer display / kitchen printer / barcode scanner / scale / payment terminal** — each would be a `pos_device_peripherals` row referencing `device_id`, status tracked the same way `last_seen_at`/`pin_fail_count` are tracked here.
- **Device Dashboard** (✓ Till 1 Online / ⚠ Till 3 Offline) — `last_seen_at` already exists; a dashboard panel is a read query away, no new backend needed.
- **Fingerprint/facial recognition** — would replace or supplement the PIN as the *user* credential; the *device* trust layer built here is already the correct foundation for either.
- **Sean AI device health / remote support** — reads the same `pos_devices` table this workstream created.

See `docs/checkout-charlie-future/DEVICE_IDENTITY_MASTER_ARCHITECTURE.md` for the full specification.

---

## What Was Deliberately Not Built (v1 limitations, documented not hidden)

- No literal pre-login "Welcome to Checkout Charlie / Activate Device" screen — see Design Decision above.
- No true offline PIN authentication — Flow 8 documents the honest current behaviour and the follow-up design.
- No Device Dashboard UI (battery/printer/scanner status) — explicitly future-tagged in the ticket itself; `last_seen_at` is captured so this is a pure UI addition later, not a data-model change.
- No device fingerprinting beyond `platform`/`user_agent` strings captured at registration — sufficient for the audit trail, not used as a second factor of device trust (the token is the sole credential).
- `pin_fail_count` on `pos_devices` is a best-effort quick-glance counter for the Device Management screen; the actual lockout decision always uses the authoritative `pos_pin_attempts` window count, not this column — documented in the code as a deliberate two-tier design, not an inconsistency.

FOLLOW-UP NOTE
- Area: Offline PIN login (Flow 8)
- Dependency: No local credential store exists in this codebase for authentication (only for the post-auth sales queue)
- Confirmed now: device identity gracefully degrades to cached company/till display when offline at boot
- Not yet confirmed/built: PIN validation while genuinely offline
- Risk if wrong: a store with unreliable connectivity cannot process sales during an outage even with a trusted device
- Recommended next review point: if/when a pilot site reports this as a real operational problem — recommended design is a short-lived signed "offline session" issued after a successful *online* PIN login, valid for a bounded window (e.g. 12h), never a locally-stored PIN hash
