# Device Identity — Master Architecture
## Checkout Charlie / Lorenco Ecosystem

**Status:** Foundation implemented (Workstream 82). This is the master specification for what exists and what future work builds on.
**Last updated:** 2026-07-08

---

## Why Device Identity Exists

Every retail POS platform worth the name — NCR, Lightspeed, Square, Toast, Revel — treats the **physical till** as a first-class, permanent identity, not a disposable browser session. The device is set up once, by a manager, and from that point on it *knows* where it lives. A cashier never tells the till which store it's in; the till already knows.

Checkout Charlie's original design did the opposite: every login started from zero — company selector, then user credentials, then (for PIN users) a free-text company field. This is fine for an office worker with a laptop who moves between clients. It is wrong for a fixed till that sits on a counter for years and is used by dozens of different cashiers a week, none of whom should ever need to know or care what "company ID" means.

**The device becomes a permanent identity inside Checkout Charlie.** Not "PIN login" — a *trusted POS device*, of which PIN login is the first and most visible feature built on top.

---

## How It Works

```
pos_devices                                inter_company_relationships (Workstream 80)
  id                                          (unrelated table — different concept:
  company_id ─────────┐                        trust between two DIFFERENT companies)
  till_id              │
  device_token_hash    │   pos_devices.company_id is a normal FK into companies —
  device_name          │   ONE company per device, always, permanently, until
  status                │   revoked/replaced. This is the till's home, not a
  last_seen_at          │   cross-company trust relationship.
  last_user_id          │
  pin_fail_count        │
  ...                  ▼
                     companies
```

A device is a row, not a token alone. The token (256 bits random, SHA-256-hashed at rest, returned to the client exactly once at registration) is merely *how the device proves which row it is* — the row itself carries everything that matters: which company, which till, its human-readable name, its current trust status, and a running history of who last used it and when.

**Lifecycle:** `active` → (`revoked` | `replaced_by_device_id → new row`). There is no "paused" or "suspended" state in v1 — a device is either trusted or it isn't; anything in between is handled by the *till's* own lock state (already existing, separate concept — see "Relationship to Existing Till Locking" below).

---

## Why It Is Better Than Company Selection

| Company selection (old) | Device identity (new) |
|---|---|
| Every login re-asks "which company?" — a question the till already knows the answer to | Asked once, by a manager, at setup. Never asked again on that device. |
| A cashier could (accidentally or otherwise) select the wrong company if they have multi-company access | The device physically cannot present any company but its own — the backend derives it from the device row, full stop |
| "Lock" was a client-side localStorage flag with zero server enforcement — spoofable by clearing browser storage | Every login independently re-validates the device server-side; the client-side cache is a display convenience only |
| No concept of "this specific till is compromised" — only "this user's password is compromised" | A specific physical device can be revoked in one action, independent of any user's credentials |
| No audit trail of *which till* a sale/login/action happened on | Every PIN login, and every future action built on this foundation, carries a `device_id` |

---

## Relationship to Existing Till Locking

This codebase already has `tills.is_locked`/`locked_reason`/`locked_by_email` (Workstream 11B, "Emergency Manager Controls") — a **different, narrower** concept: a manager can lock a specific *till* (a cash drawer/register concept — `tills` table) mid-shift, e.g. because of a suspected discrepancy, independent of which physical device is plugged into it.

**These are not the same thing and must not be merged:**
- `pos_devices` = *which company/till does this browser/hardware belong to, permanently*
- `tills.is_locked` = *is this specific till currently allowed to open a session, right now, today*

A device can be perfectly trusted (`pos_devices.status = 'active'`) while its assigned till is emergency-locked (`tills.is_locked = true`) — session opening would still correctly fail at the existing till-lock check, downstream of successful PIN login. No changes were made to till locking in Workstream 82; the two systems compose correctly without modification to either.

---

## How Future Lorenco Apps Can Reuse This Concept

The pattern generalizes beyond POS: any Lorenco app running on a fixed, shared piece of hardware (a Paytime kiosk, a warehouse scanning tablet, a self-service terminal) has the identical problem — "which company/context does this hardware belong to" is a question that should be answered once, not on every login.

The reusable shape is:
1. A `{app}_devices` table (or a shared `ecosystem_devices` table with an `app` discriminator column, if/when a second app needs this) with `company_id`, a hashed high-entropy token, a human name, and a status.
2. A pre-auth "validate this device" endpoint, authenticated by the token alone.
3. A per-credential-type login endpoint (PIN, password, badge scan, whatever the app uses) that derives company context from the validated device rather than accepting it from the client.
4. A management screen to register/rename/revoke/replace devices.

Checkout Charlie's implementation (this document's companion, `docs/checkout-charlie-production/82_DEVICE_IDENTITY_SYSTEM_IMPLEMENTED.md`) is the reference implementation. A second app adopting this pattern should reuse the *shape*, not necessarily the literal `pos_devices` table — company-scoped, single-purpose tables per app are simpler to reason about than one shared table serving unrelated apps with different lifecycle needs, unless a genuine cross-app device concept emerges later (e.g. one physical tablet running both POS and a future kitchen-display app, which would then legitimately want to share one device identity across two app contexts — not built, not needed yet, but the schema shape above supports it if it becomes real).

---

## What Must Never Change About This Model

- **The device never chooses its own company.** Registration derives `company_id` from the registering manager's already-authenticated, already-company-scoped JWT — never from a client-supplied value, at registration or at login.
- **Revocation is one-directional.** A revoked device cannot be un-revoked; it can only be replaced or freshly re-registered. This is deliberate — it forces a conscious re-activation action rather than a silent "un-revoke" that could be triggered accidentally.
- **The token is bearer-only and single-purpose.** It identifies a device for PIN-login gating. It is never treated as a user credential, never granted permissions of its own, and never substitutes for the JWT a logged-in user still receives.
- **Backend authoritative, always.** Every capability built on this foundation (till assignment, printer status, cash drawer, scanner, offline queue tie-in) must re-derive its company/device context from the validated `pos_devices` row server-side — never trust a client-supplied `device_id` or `company_id` for an authorization decision.

---

## What Is NOT Built Yet (honest status, not aspirational)

- Receipt printer / cash drawer / customer display / kitchen printer / barcode scanner / scale / payment terminal integration — schema-ready (attach via `device_id`), zero code.
- Device Dashboard UI (online/offline status grid, battery, current cashier at a glance) — `last_seen_at`/`last_user_id` are captured; the dashboard view itself is not built.
- True offline PIN authentication — see the FOLLOW-UP NOTE in the companion implementation doc.
- Fingerprint/facial recognition as a user credential — the device-trust layer this document describes is the correct foundation for either, but neither is built.
- Sean AI device health monitoring / remote support tooling — would read `pos_devices` (and a future `{table}_peripherals`) as its data source; not built.
- Cross-app shared device identity (one tablet, multiple Lorenco apps) — schema shape supports it if it becomes a real requirement; not built, not currently needed.
