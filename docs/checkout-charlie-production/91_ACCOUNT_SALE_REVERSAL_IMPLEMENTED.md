# Workstream 91 — Account Sale Void & Reversal Engine (IMPLEMENTED)

## Background

Workstream 90 proved (live, against the deployed database) that account sales correctly post a customer charge, payments correctly reduce the balance, and statements reconcile — but also proved, live, that **voiding an account sale does not reverse the customer's balance or ledger**: a sale that charged R1,000 left the customer at R1,000 even after being voided. This workstream closes that gap.

## Architecture

Three objects stay exactly as they were — this is a fix, not a redesign:

- **The original sale** (`sales`) — untouched in content, only its `status` changes to `voided`.
- **The original charge** (`customer_account_transactions`, `type: 'charge'`) — **never edited**. Financial history is only ever appended to, never rewritten.
- **The customer's live balance** (`customers.current_balance`) — adjusted by a new, independent write.

What's new is a fourth object: the **reversal entry** — a second `customer_account_transactions` row, `type: 'charge_reversal'`, with a negative amount equal in magnitude to the original charge. The running ledger now reads:

```
Original charge     +1000   balance_after: 1000
Reversal (void)      -1000   balance_after: 0
```

Never `UPDATE customer_account_transactions SET amount = ...` on an existing row. This is the same principle already established for stock adjustments and for account payments in Workstream 90 — append, never mutate.

## Shared Ledger-Write Core

`sales.js` had one CAS-protected balance-adjustment function from Workstream 90 (`postAccountCharge`). Rather than write a second, near-identical function for reversal, it was generalized into `adjustCustomerAccountLedger({ companyId, customerId, saleId, amount, type, reference, notes, userId, idempotencyGuard })` — the single place the compare-and-swap balance update (read `current_balance`, `UPDATE ... WHERE current_balance = <value read>`, bounded 5-attempt retry loop) and the ledger insert happen. `postAccountCharge` is now a two-line wrapper (`amount: +amount, type: 'charge'`) preserving its exact external behaviour — Workstream 90's already-proven code path is unchanged. `reverseAccountCharge` is the new wrapper (`amount: -amount, type: 'charge_reversal'`), the only genuinely new logic.

## Idempotency Guard — Prevents Double-Void and Unsafe Retries

`adjustCustomerAccountLedger` accepts an optional `idempotencyGuard: { saleId, type }`. Before touching anything, it checks whether a `customer_account_transactions` row already exists matching that `(sale_id, type)` pair — if so, that row is returned unchanged (`wasDuplicate: true`) instead of applying the delta again. `reverseAccountCharge` always sets this guard to `{ saleId, type: 'charge_reversal' }`.

This is deliberately a second, independent safety net on top of the void route's own protection:

1. **The `/void` route's status update is CAS-guarded** — `UPDATE sales SET status='voided' ... WHERE status = <value just read>`. Two concurrent void requests for the same sale can never both succeed; the loser's update affects zero rows and gets a clean "already voided" response before any reversal logic runs.
2. **`reverseAccountCharge`'s idempotency guard** catches the remaining case: a client retries the *same* void request after a network timeout, believing it failed, when the server actually completed it (or is completing it in an overlapping window). The reversal row already exists, so the retry returns it unchanged rather than reversing the same charge twice.

## Manager-Tier Gate

Voiding a plain cash/card sale still only requires `SALES.VOID` (supervisor tier) — unchanged, per the ticket's "do not redesign checkout." Voiding a sale that has a real account-tender component to reverse **additionally** requires `SALES.REFUND` (management tier) — reusing the existing permission already defined for exactly this class of action ("reversing money"), rather than inventing a new permission category. The check happens **before any write**: if the caller only has `SALES.VOID`, the request is rejected with a 403 outright. This specifically prevents the worst partial-failure mode — a supervisor voids the sale (succeeds, since they have `SALES.VOID`) while the reversal silently never happens (which is exactly the pre-existing bug this workstream fixes) because they lacked permission to trigger it.

A `CUSTOMER_ACCOUNT_REVERSAL_MANAGER_APPROVED` audit event fires immediately once this gate is passed, recording the approving user's role — this is the durable record of "a manager authorized this financial reversal," satisfying the ticket's `MANAGER_APPROVAL` audit requirement without adding a separate approval workflow (the permission check *is* the approval, for a supervisor-vs-management-tier system where there's no separate maker/checker step elsewhere in this codebase).

## Split Payments

The reversal amount is computed from `sale_payments` at void time — `sum(amount) WHERE payment_method = 'account'` for that sale — never the sale's `total_amount`. A sale that was cash R400 + account R600 reverses exactly R600 from the customer's balance; the cash portion is untouched (there is no cash-drawer reversal mechanism in this codebase to trigger, and none was added — out of scope, matches "do not redesign checkout").

## Partial Returns — Investigated, Documented, Not Fixed

Per the ticket's explicit instruction not to redesign returns and to only fix a "proven blocker," `POST /:id/return` was read in full rather than assumed. Finding: **account-sale reversal via partial return is completely unsupported.** The route:

- Never references `customers.current_balance` or `customer_account_transactions` anywhere.
- Defaults `refund_method` to `'cash'` even when the original sale's `payment_method` was `'account'` — there is no logic anywhere in the route that inspects the original sale's payment method at all.
- Has `sale.customer_id` available (it's part of the fetched sale row) but never reads it.

This is the same class of gap void had before this workstream, but for partial/full returns specifically, and it is a **separate route** — fixing it is not required to close the void gap this ticket targets, and building it (deciding how a *partial* return should partially reverse a ledger charge, how it interacts with a later full void of the same sale, etc.) is meaningfully more design work than "the smallest safe fix." **Status: unsupported. Not fixed. Flagged as a follow-up.**

```
FOLLOW-UP NOTE
- Area: POST /api/pos/sales/:id/return — account-sale ledger/balance reversal
- Dependency: none on this workstream; return is architecturally independent of void
- Confirmed now: returning an account sale (partial or full) never touches the
  customer's ledger or balance, regardless of the original payment method
- Not yet confirmed: the correct partial-reversal model (e.g. does a partial return
  reverse a proportional amount, and how does that interact with a full void of the
  same sale later reversing the same charge again via reverseAccountCharge's
  sale_id-based idempotency guard, which is keyed on the whole sale, not per-item)
- Risk if wrong: a customer given an account-sale partial refund at the till currently
  keeps the full original charge on their account balance — a real, live financial
  discrepancy for any business that uses partial returns against account sales
- Recommended next check: a dedicated workstream, scoped and live-verified the same
  way as this one, once partial-return-on-account-sale is confirmed to be in active use
```

## Audit Events

Four new events in `posAuditLogger.js`, category `customer_account`:

| Event | Fires when |
|---|---|
| `CUSTOMER_ACCOUNT_REVERSAL_MANAGER_APPROVED` | The management-tier gate is passed for a sale with an account-tender component |
| `CUSTOMER_ACCOUNT_CHARGE_REVERSED` | The reversal ledger row + balance update succeed |
| `CUSTOMER_ACCOUNT_REVERSAL_REPLAYED` | The idempotency guard returns an existing reversal instead of creating a new one (double-void or retry) |
| `CUSTOMER_ACCOUNT_REVERSAL_FAILED` | CRITICAL — the sale is already voided but the reversal write failed; needs manual reconciliation, logged loudly (never silent) |

The ticket's requested `ACCOUNT_CHARGE_CREATED` and `SALE_VOIDED` events already exist from Workstream 90 (`CUSTOMER_ACCOUNT_CHARGE_POSTED`) and pre-existing code (`POS_EVENTS.SALE_VOIDED`) respectively — not duplicated under new names.

## Security

- Every write remains scoped by `req.companyId` — unchanged from the existing pattern, no new cross-company surface introduced.
- The manager-tier gate is enforced server-side via `hasPermission(req.user.role, 'SALES', 'REFUND')` before any write — the frontend cannot bypass it by simply not showing a confirmation dialog.
- No business truth is written to `localStorage`/`sessionStorage` anywhere in this workstream's code.
