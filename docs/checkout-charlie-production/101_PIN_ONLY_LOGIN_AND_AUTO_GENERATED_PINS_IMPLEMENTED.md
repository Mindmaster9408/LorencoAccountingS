# Workstream 101 — PIN-Only Login on Locked Devices + Auto-Generated PINs — Implemented + Live Verified

## Background

Came out of a question about the locked-device PIN screen: does entering a PIN alone identify and verify the employee, or is a username/employee code still required? Audited the code and confirmed the answer was **no** — on a locked device the Company field correctly disappears (derived from the device token), but the "Username or Employee Code" field did not; PIN login always required BOTH an identifier and the PIN, the identifier used to look up one specific user and the PIN only to verify against that user's hash.

Confirmed scope to change this: on a locked/trusted device, the employee code field should also disappear — the PIN alone resolves and verifies the employee. Combined with a second request: when a manager sets a PIN for an employee, the system should auto-generate a random PIN rather than the manager (or employee) inventing one, both for convenience and because random PINs are safer than human-chosen ones.

**Explicit constraint this workstream was built under**: real staff are using the live, currently-deployed POS system today with the existing employee-code+PIN flow. Nothing may be pushed/deployed until tonight. All work stayed local; verification used a fully synthetic, disposable test company against production Supabase, never touching any real company/user/PIN.

## Why PIN-only login is an acceptable security trade-off

Dropping the requirement to type an employee code removes a piece of *identifying* information, but it was never a secret (employee codes are often known/guessable, e.g. `EMP-001`) — it only narrowed which single PIN hash got checked. The actual security boundary in this system is, and remains: **(1) a registered/trusted device token, (2) the PIN itself, (3) lockout policy.**

Two lockouts already existed and are both untouched by this change:
- **Per-user lockout** (5 failed attempts / 15 min) — still applies once a specific user is identified (old-style login, or a successful pin-only match).
- **Device-level lockout** (5 failed attempts / 15 min, *any* user, only lifted by a manager or 15 min) — this was already user-blind by design ("Device lock. Not only user lock.", Workstream 82). It becomes the primary brute-force defense for pin-only login, and needed no changes at all.

The one new risk PIN-only login introduces — two employees sharing the same PIN making the scan ambiguous — is closed by a new **company-wide PIN uniqueness check** enforced at set-time (see below), for both manual and auto-generated PINs.

## What changed

**`backend/modules/pos/routes/pin.js`**
- New `findPinCollision(companyId, candidatePin, excludeUserId)` — bcrypt-compares a candidate PIN against every other active PIN hash in the company (hashes are salted, so this can't be an index lookup; company staff counts are small enough for this to be cheap).
- `POST /:userId/pin` (existing manual set) now calls this and rejects with 409 on a collision. Everything else about this route is untouched.
- New `POST /:userId/pin/generate` — server generates a random 4-digit PIN via `crypto.randomInt` (not `Math.random`), rejects weak/sequential PINs and collisions, retries up to 30 times, hashes and stores it exactly like the manual path, and returns the **plaintext PIN once** in the response only (never logged, never stored, never retrievable again afterwards — same "PINs never returned" invariant as the rest of the file, with this one intentional exception at the moment of creation).

**`backend/shared/routes/auth.js` (`POST /pos/pin-login`)**
- `user_identifier` is now **optional** instead of required.
- When provided: 100% unchanged — same three-step username→email→employee_id lookup, same single-user PIN verification. This path is what real staff are using today and had to stay byte-for-byte identical.
- When omitted: scans every active-role user in the device's company (`cashier`, `senior_cashier`, `shift_supervisor`, `assistant_manager` — same login-eligible role list as before) with an active PIN, bcrypt-comparing until one matches. Implemented as two independent queries (`user_pos_pins` joined to `users`, and `user_company_access` filtered to eligible roles) rather than one embedded query, because there is no foreign key between `user_company_access` and `user_pos_pins` for PostgREST to embed directly.
- Failed pin-only attempts are logged with `user_id: null` (no identity was claimed), same as the existing "device not found"/"user not found" failure paths already do.

**`frontend-pos/index.html`**
- `applyDeviceLock()` now also hides the "Username or Employee Code" row (`pinUsernameRow`) once a device is locked — mirroring how it already hides the Company row.
- `loginWithPin()` only requires/sends `user_identifier` when that row is still visible (i.e., on an unlocked device); on a locked device the request body is just `{ pin, device_token }`.
- Settings → Users → Manage PIN modal gets a new "🎲 Generate PIN automatically" button that calls the new endpoint and displays the resulting PIN prominently with a "write it down now" notice. The existing manual entry fields are completely untouched and still work exactly as before — this is a pure addition, not a replacement.

## Live Verification

Fully synthetic test company + 4 synthetic users (never real data) against production Supabase, cleaned up immediately after (hard-delete blocked by the `audit_log` foreign key from the login/PIN-set activity itself — deactivated instead, same resolution used for every prior workstream this session). 26/26 assertions passed:

| Check | Result |
|---|---|
| Manual PIN set | PASS |
| Setting a second user's PIN to an already-used PIN in the same company → rejected (409) | PASS |
| Auto-generate PIN → valid 4-digit, not weak, not colliding | PASS |
| Regenerating a PIN overwrites the old one — the old PIN stops working | PASS |
| PIN-only login (no identifier) resolves to the *correct* user for 3 different cashiers, each by their own distinct PIN | PASS |
| PIN-only login with a valid-format PIN nobody has → rejected (401), no crash | PASS |
| A management-role user's PIN (store_manager) does **not** work via pin-only login — role eligibility for PIN *login* (not just PIN *possession*) is still enforced | PASS |
| Old-style `user_identifier` + `pin` login still works completely unchanged, including correctly rejecting a wrong PIN for a real user | PASS |
| Device-level lockout still triggers after 5 failed attempts, shared across both pin-only and old-style attempts | PASS |

## Deployment note

**Not pushed as part of this workstream.** Per explicit instruction, staff are working on the live system today with the current (unchanged) employee-code+PIN flow; this change stays local until pushed tonight.
