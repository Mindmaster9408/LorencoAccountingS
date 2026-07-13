# Workstream 97 — Store Manager Cashup-on-Behalf-Of — Implemented + Live Verified

## Request

"As store manager, I want to be able to choose whose cashup I want to do, so I can do the cashiers' cashups for the day." Scope confirmed explicitly: the cashier closes their own till first (existing self-service flow, unchanged); the manager then picks that session from a list and completes the final cash count/reconciliation on their behalf.

## What Already Existed

A "Pending Cashups" list and a `complete-cashup` action were already built and partially wired — this was not a from-scratch feature. Auditing it before changing anything (per standing rule) surfaced three real, pre-existing defects that would have made the requested capability effectively unusable even though the pieces looked present:

### Defect 1 — No permission check at all (security gap)
Neither `POST /:id/close` nor `POST /:id/complete-cashup` had any permission gate — not even a role check. Any authenticated user, including a trainee, could close or cash up **any other cashier's** till session by session ID. Given the request specifically frames this as a store-manager action, this was a real gap, not just a missing feature.

### Defect 2 — The pending-cashup list would almost never show anything
`GET /pending-cashup` filtered `status = 'closed' AND closing_balance IS NULL`. But `/close` accepts an optional `closing_balance`, and the existing self-service "close till" UI (`manageSession()`) always prompts for and sends one. The instant a cashier closes their own till the normal way, `closing_balance` becomes non-null — and the session would then **never** appear in the pending list, regardless of whether it had actually been reconciled. `status` is the real state machine (`open` → `closed` → `cashed_up`, only `/complete-cashup` sets `cashed_up`), so the correct filter is `status = 'closed'` alone.

### Defect 3 — The list's own display was broken
The query joins `tills(till_name, till_number)` and `users:user_id(username, full_name)`, returning **nested** objects — but the frontend read `session.till_name` / `session.user_name` (flat, non-existent paths) and a `session.total_sales` / `session.sale_count` the backend never computed at all. Every pending-cashup card has always rendered `undefined - undefined` for the till and cashier name and `R NaN (undefined transactions)` for sales — precisely the information a manager needs to know *whose* cashup they're looking at.

All three were found live before writing any fix code, per the audit-first rule, and are fixed together since they compound: fixing only the permission gate would have left an empty, and even then illegible, list.

## The Fix

**Backend (`sessions.js`):**
- `POST /:id/close` and `POST /:id/complete-cashup`: closing/completing your **own** session (`session.user_id === req.user.userId`) remains completely unrestricted — no behaviour change for the existing self-service flow. Acting on **someone else's** session now requires `hasPermission(req.user.role, 'TILLS', 'MANAGE')` — the existing `TILLS.MANAGE` permission tier (management roles only) already defined in `permissions.js`, reused rather than inventing a new one.
- `GET /pending-cashup`: now requires `TILLS.MANAGE` outright, since it exposes every cashier's till figures across the company — a cashier's own cashup screen still calls this unconditionally on load, and a 403 there is already handled gracefully by the existing frontend code (the section just stays hidden, which is also the correct behaviour for a non-manager).
- `GET /pending-cashup`'s query: dropped the `closing_balance IS NULL` condition — now correctly `status = 'closed'` alone.

**Frontend (`index.html`):**
- The pending-cashups card now reads `session.tills?.till_name` / `session.users?.full_name` (the real nested paths) and drops the fabricated sales-count line the backend never populated.
- `showPendingCashupModal()` was rebuilt from a single crude `prompt()` (which only ever asked for one lump "cash counted" figure and silently zeroed out card/EFT tender when reconciling someone else's till) into a proper modal that fetches the same authoritative `/sessions/:id/reconciliation` breakdown the cashier's own cashup screen already uses (gross sales, per-payment-method totals, refunds, expected cash), with separate Counted Cash / Counted Card / Counted Other inputs pre-filled from the reconciliation data — matching real accuracy parity with the self-service cashup screen instead of a cash-only guess. New markup is dark-theme-native (`var(--surface)`, `var(--border)`, `var(--text)` etc.), matching this session's standing dark-theme rule.

## Live Verification

Two test cashiers and a `store_manager` test user, on the two real Pennygrow tills. 15 assertions, all passed:

| Check | Result |
|---|---|
| Cashier A blocked from closing Cashier B's still-open session | 403 |
| Cashier B's session confirmed still open after the blocked attempt | PASS |
| Each cashier closes their own session (self-service, unrestricted) | 200 |
| Cashier blocked from `GET /pending-cashup` | 403 |
| Manager can list pending cashups | 200 |
| Both closed sessions appear in the manager's pending list | PASS |
| Pending session's nested till/user join data reads correctly (the display bug) | PASS — `users.full_name` and `tills.till_name` both populated |
| Cashier A blocked from completing Cashier B's cashup | 403 |
| Manager fetches the reconciliation breakdown for Cashier A's session | 200 |
| Manager completes Cashier A's cashup on their behalf | 200, `status: 'cashed_up'` |
| Manager completes Cashier B's cashup on their behalf | 200, `status: 'cashed_up'` |
| Both sessions correctly disappear from the pending list once cashed up | PASS |

## Cleanup

Test users (two cashiers, one store manager) deactivated. Test till sessions are real completed cashups (`status: 'cashed_up'`) and left untouched, per the standing rule that resolved transaction/reconciliation history is not disposable test scaffolding.
