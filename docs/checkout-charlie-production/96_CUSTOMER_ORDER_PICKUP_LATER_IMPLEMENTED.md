# Workstream 96 — Customer "Order" (Pay-Later Pickup) — Implemented + Live Verified

## Background

Request: a customer wants to place an order now and collect it later, rather than taking the goods immediately. Named "Order" rather than "layby" per explicit direction. No such capability existed anywhere in Checkout Charlie before this workstream (confirmed — no `layby`/`hold`/`reserve`/`pickup` logic anywhere in the POS module).

## Design Decisions

**Stock is reserved immediately, not at pickup.** Chosen over the alternative (reserve only at pickup) because the alternative risks selling the same stock to a second customer while the first customer's order is still pending — the ticket-level tradeoff was discussed and this was the agreed direction.

**A separate `POST /api/pos/sales/orders` endpoint, not a flag on the regular `POST /` sale-creation route.** The regular sale-creation path is a heavily-audited, live-verified, correct flow (Workstreams 89–93). Branching new "maybe-partial-payment, maybe-different-terminal-status" logic into it risks regressing a proven path (Rule A4 — no blind replacements). The new endpoint reuses `create_sale_atomic` and `postAccountCharge()` completely unchanged — only what happens to the resulting row *after* the RPC returns is new.

**Two dimensions of state, both already existing columns — no new columns needed:**
- `sales.status`: `'on_order'` (new value; column has no CHECK constraint restricting values — confirmed empirically via a live insert/update probe before writing any code) → `'completed'` (fulfilled) or `'voided'` (cancelled, reusing the exact same terminal status void already uses, so every existing report/query that already distinguishes completed vs voided sales handles a cancelled order correctly with zero additional changes).
- `sales.payment_status`: `'unpaid'` / `'partial'` / `'completed'` — tracks how much of the order has been paid, independent of whether it's been collected.

**Amount still owed is computed, not stored** — `total_amount - SUM(sale_payments.amount)` — so there's no risk of a stored "amount owed" field drifting out of sync with the actual payment rows.

## Endpoints

### `POST /api/pos/sales/orders` — place an order
Body: same shape as the regular sale-creation route, plus `deposit_amount` (defaults to 0). Validates stock, computes totals identically to a regular sale, calls `create_sale_atomic` with a single payment leg equal to the deposit (even when zero, rather than omitting `p_payments` — the RPC's empty-array behaviour is unproven and untested, so a zero-amount leg was used instead of guessing). Immediately after the RPC succeeds, flips the row from the RPC's internal default (`'completed'`) to `'on_order'` and sets `payment_status` accordingly. If the deposit was paid on account, `postAccountCharge()` is called for exactly the deposit amount — identical to a regular account sale.

### `POST /api/pos/sales/:id/fulfill` — customer collects, pays what's owed
CAS-guarded (`WHERE status = 'on_order'`) — a retried/double-tapped fulfil request finds zero rows updated the second time and gets a clean "not an open order" response, the same double-submit protection `/void` already uses. No separate idempotency key needed: unlike returns (where multiple returns against one sale are legitimate), fulfilment is a one-time terminal transition per order, so the status CAS alone is sufficient. Inserts a new `sale_payments` row for whatever remains owed (this is the first place in the codebase writing to `sale_payments` outside the atomic RPC — confirmed the table's columns support a direct insert cleanly). If the final payment is on account, charges it via `postAccountCharge()`.

### `POST /api/pos/sales/:id/cancel-order` — order never collected
Reuses `restore_stock_for_return` (the exact RPC `/return` uses) to give back every reserved unit, and `reverseAccountCharge()` (the exact function `/void` uses) to reverse any account-funded deposit. Manager-tier gate mirrors `/void` exactly: `SALES.VOID` (supervisor) is enough for an order with no account deposit; an order with a real account-funded deposit additionally requires `SALES.REFUND` (management), checked before any write.

### `GET /api/pos/sales?status=on_order`
No change needed — the existing sales-list endpoint already supports filtering by `status`; reused as-is to list open orders.

## Frontend

- **"📦 Place as Order (Pickup Later)"** button added next to "Complete Sale" in the cart panel. Opens a small modal (order total, optional deposit amount) and posts to the new endpoint using the same cart/payment-method/customer state the regular checkout button already reads — no parallel cart logic.
- **"📦 Orders"** button added next to "Switch Store" in the top nav. Opens a modal listing every open order (sale number, total, balance owing) with **Fulfil (Collect)** and **Cancel Order** actions per row, built using the same dark-theme-native pattern (`var(--surface)`, `var(--border)`, `var(--text)` etc.) already fixed for Switch Store in this session — new UI here is dark-theme-correct from the first line, per this repo's standing dark-theme rule.
- Fulfilment payment method and cancellation reason both use `prompt()`, matching the existing convention already used for void reasons and PO/transfer rejection reasons elsewhere in this file, rather than introducing a new interaction pattern.

## Live Verification

Ran against the real local server connected to production Supabase, using dedicated test users (`ws96_supervisor_test` — `shift_supervisor`, has `SALES.VOID` not `SALES.REFUND`; `ws96_manager_test` — `store_manager`, has both), a test customer, and a test product (R500). 27 assertions, all passed:

| Scenario | Result |
|---|---|
| Zero-deposit order: stock reserved immediately (2 units), appears in `?status=on_order` | PASS |
| Fulfil with nothing paid: collects full R1000, stock unchanged by fulfilment (already reserved at order time) | PASS |
| Re-fulfilling an already-completed order | Blocked, 400 |
| Partial-deposit order (R500 total, R200 deposit) → fulfil collects exactly R300 via a different payment method (card) than the deposit (cash) | PASS |
| Full-deposit account order: customer balance charged exactly R500 at order time; fulfil needs no `payment_method` and returns `final_payment: null` | PASS |
| Cancel an uncollected order: stock restored to the exact pre-order level | PASS |
| Re-cancelling an already-cancelled order | Blocked, 400 |
| Supervisor attempts to cancel an order with a real account deposit | Blocked, 403; order remained `on_order`; stock untouched by the blocked attempt | PASS |
| Manager cancels the same order properly | Succeeds; account deposit reversed back to the exact pre-order balance | PASS |
| Retried order-creation request with the same idempotency key | Returns `wasDuplicate: true`, no second row created | PASS |
| Fulfil/cancel a nonexistent order | 404 | PASS |
| Fulfil a regular (non-order) completed sale | Blocked, 400 ("not an open order") | PASS |

## What Was Not Independently Browser-Tested

The backend is fully live-verified via direct API calls matching the exact payload shapes the new frontend code sends (confirmed by reading the frontend code that builds each request). The new frontend JS was syntax-checked (no errors) and confirmed served correctly by the running server. No browser automation tool was available in this session to click through the actual UI end-to-end — this should be smoke-tested in a real browser before relying on it for a live pilot, per this repo's standing rule that UI changes need an actual browser check where possible.

## Cleanup

Test till session closed via the real `/sessions/:id/close` endpoint; test `customer_account_transactions` rows deleted and balance reset to 0; test customer/product/users deactivated (hard delete correctly blocked by FK from the sales rows they're now genuinely referenced by). Test sales (8 rows spanning all scenarios) and their audit trail left untouched — real transaction/audit history, not disposable scaffolding.

## Related

See `95_PAYMENT_METHOD_CASE_SENSITIVITY_CRITICAL_FIX.md` for a critical, separate bug found while building this feature — real browser-driven account sales were never posting ledger charges due to an uppercase/lowercase mismatch, unrelated to Orders but fixed in the same session since the fix lives in the same shared code path (`normaliseSaleBody`) both the regular sale route and this workstream's order route parse through.
