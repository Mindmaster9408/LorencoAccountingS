# Workstream 93 — Partial Return Financial Integrity (IMPLEMENTED)

## Background

Workstream 90 proved account sales correctly charge the customer. Workstream 91 proved full voids correctly reverse that charge. Investigating `POST /:id/return` during Workstream 91 (documented, not fixed then — out of that ticket's scope) found the same underlying gap in a different route: a return, partial or full, never touched `customers.current_balance` or `customer_account_transactions` at all, regardless of the original sale's payment method. This workstream closes that gap.

## Architecture

Same three-object model as Workstream 91 — nothing about sales, returns, or customer accounts is redesigned:

- **The return record** (`pos_returns`) — unchanged in content and meaning, gains one new column (`idempotency_key`).
- **The original charge** (`customer_account_transactions`, `type: 'charge'`) — never edited.
- **A new reversal entry per return** (`customer_account_transactions`, `type: 'return_reversal'`) — appended, one per `pos_returns` row.

```
Original charge        +1000   balance_after: 1000
Return 200 reversal     -200   balance_after:  800
Return 300 reversal     -300   balance_after:  500
```

## Reused Core, One New Wrapper

Workstream 91 generalized the Workstream 90 balance-adjustment function into `adjustCustomerAccountLedger()`, the single place the compare-and-swap balance update and ledger insert happen. This workstream adds a third thin wrapper, `reverseAccountChargeForReturn()`, alongside the existing `postAccountCharge()` and `reverseAccountCharge()` — no duplicated CAS logic.

## Idempotency Guard — Generalized for Multiple Returns Per Sale

Workstream 91's reversal was keyed on `{ sale_id, type: 'charge_reversal' }` — correct for a full-sale void, where there is exactly one possible reversal per sale. A sale can have **many** returns over time (the ticket's Scenario C), so keying a return's reversal on `sale_id` alone would make the second return against the same sale look like a duplicate of the first and silently skip it — a real bug that would have been introduced by copying Workstream 91's guard unchanged.

Fixed by generalizing `adjustCustomerAccountLedger`'s `idempotencyGuard` parameter from a hardcoded `{ saleId, type }` check into an arbitrary set of exact-match column/value pairs. `reverseAccountCharge` (void) still guards on `{ sale_id, type: 'charge_reversal' }`, unchanged. `reverseAccountChargeForReturn` guards on `{ reference: 'RETURN-<pos_returns.id>' }` — unique per return, not per sale. This is a behaviour-preserving generalization for the existing void path (confirmed by re-reading the resulting query construction) and the enabling change for correct multi-return support.

## Split-Payment Allocation — Proportional, Documented Explicitly

The ticket's primary worked example is a 100%-account sale: return R600 of a R1,000 account sale, reverse exactly R600. Unambiguous.

For a split-payment sale (cash R300 + account R700), the ticket states "only the account-funded portion may affect the customer balance" without specifying an exact split algorithm for a *partial* return that doesn't map cleanly to one tender or the other. This schema has no per-item tender attribution (a sale's `payments` are recorded as whole-sale totals per method, not tied to specific line items), and building that tracking would be exactly the kind of structural change the ticket forbids ("do not redesign returns"). The fix instead uses **proportional allocation**, the standard approach for split-tender refunds without item-level tender data:

```
accountShareRatio = accountTenderTotal / saleTotal
accountPortionOfReturn = round(refundAmount × accountShareRatio, 2)
```

A 100%-account sale has `accountShareRatio = 1.0`, correctly collapsing to the ticket's primary example. A 100%-cash sale has `accountShareRatio = 0`, correctly reversing nothing (cash refunds follow whatever existing cash-drawer logic already applies via `refund_method` — untouched). This is computed fresh from `sale_payments` on every return, so it is correct regardless of how many prior returns have already been processed against the same sale.

## Manager-Tier Gate

Identical rule to Workstream 91: a return with zero account-funded portion still only requires `SALES.VOID` (supervisor, unchanged). A return that reverses a real amount off a customer's balance additionally requires `SALES.REFUND` (management), checked before any write — so a supervisor-only user cannot process a partial return and have it silently skip the reversal, the exact partial-failure mode this whole line of workstreams (90 → 91 → 93) exists to close.

## Idempotency at the Route Level (New — Closes a Second, Related Gap)

`POST /:id/return` had no idempotency protection at all before this workstream — a retried request would create a second `pos_returns` row, double-restore stock via `restore_stock_for_return`, and (now that the ledger reversal exists) double-reverse the customer's balance. This is the same class of gap Workstream 90 found and fixed on the account-payment endpoint, applied here via the identical pattern: an optional `idempotency_key` (new `pos_returns.idempotency_key` column + partial unique index on non-null values), checked before any write; a retried request with the same key returns the original return record unchanged, with `reversal: null` and `wasDuplicate: true`, rather than processing again.

This is deliberately in scope even though the ticket is titled "Partial Return Financial Integrity" and this is a stock/route-level fix rather than a ledger-level one: a duplicated return **is** a financial integrity failure (double refund, double stock restoration, double ledger reversal) — fixing only the ledger-reversal side while leaving the return itself unprotected against retries would still leave the exact "duplicate reversals" failure mode the ticket's "Double Return" section explicitly requires be prevented.

## Multiple Partial Returns (Scenario C)

Because the CAS balance update always reads the customer's **current** balance (never a cached or original value) and each return's reversal is keyed independently, sequential partial returns compose correctly without any special-casing:

```
Sale (all-account):        balance 1000
Return 200 -> reversal -200: balance  800
Return 300 -> reversal -300: balance  500
```

No validation was added to cap cumulative returned quantity against what remains unreturned per item — that is a pre-existing, separate concern (stock/quantity validation on `/return`, not customer-ledger correctness) and was not proven to block this ticket's objective; touching it would be a `/return` redesign, explicitly out of scope.

## Audit Events

Five new events in `posAuditLogger.js`:

| Event | Category | Fires when |
|---|---|---|
| `CUSTOMER_ACCOUNT_RETURN_MANAGER_APPROVED` | `customer_account` | The management-tier gate passes for a return with an account-funded portion |
| `CUSTOMER_ACCOUNT_RETURN_REVERSED` | `customer_account` | The reversal ledger row + balance update succeed |
| `CUSTOMER_ACCOUNT_RETURN_REVERSAL_REPLAYED` | `customer_account` | The idempotency guard returns an existing return-reversal instead of creating a new one |
| `CUSTOMER_ACCOUNT_RETURN_REVERSAL_FAILED` | `customer_account` | CRITICAL — the return is recorded but the reversal write failed; logged loudly, needs manual reconciliation |
| `RETURN_REPLAYED` | `sale` | The route-level idempotency guard returns an existing `pos_returns` row instead of creating a duplicate |

## Security

- Every write remains scoped by `req.companyId` — unchanged.
- The manager-tier gate is enforced server-side via `hasPermission(req.user.role, 'SALES', 'REFUND')` before any write.
- No business truth is written to `localStorage`/`sessionStorage` anywhere in this workstream's code.
