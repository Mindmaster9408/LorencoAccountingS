# Workstream 90 — Live Customer Account Sale + Payment + Statement Verification

## Verdict: **Yes, with conditions** — see Final Verdict for full detail

The full chain (Account Sale → Customer Charge → Live Balance → Account Payment → Statement → Closing Balance) was tested against the live database that backs the deployed app, over real HTTP requests to the real application code — no mocks used as proof. This resolved the exact open question flagged in Workstream 83's follow-up note ("whether `create_sale_atomic` posts ACCOUNT-sale charges to `customer_account_transactions` is unconfirmed"). It was unconfirmed because the answer was **no** — a real, critical defect, now fixed and re-verified live, along with two further defects the scenario surfaced along the way.

## Test Data

| Item | Value |
|---|---|
| Company | Pennygrow (id 2) |
| Test user | `ws90_pennygrow_test` (id 14, role `store_manager`) |
| Test customer | "WS90 Test Customer (Live Financial Verification)" (id 6), opening balance R0, credit limit R5,000 |
| Test product | "TEST-ACCOUNT-ITEM" (id 5128), unit price R1,000 |
| Controlled amounts | Account sale R1,000; account payment R400; expected final balance R600 |

## Critical Ledger Check — Answered With Live Evidence

> Does `create_sale_atomic` or the account-sale route post the account charge?

**No — confirmed empirically.** A real R1,000 account sale was created (sale id 22, `payment_method: 'account'`, `sale_payments` row correctly showing `amount: 1000, payment_method: 'account'`), and immediately after: `customers.current_balance` was still `0`, and `customer_account_transactions` still had `0` rows for that customer. The opaque RPC (source not in this repository, never modified) does not touch either. The other four questions in the ticket therefore collapse to one answer each:

- **Is the posting atomic with the sale?** N/A — no posting is attempted at all.
- **Can the sale succeed while the charge fails?** Worse than failing — it never tries.
- **Can the charge duplicate on retry?** N/A — nothing to duplicate.
- **Is the transaction linked to the sale by `sale_id`?** N/A.

## Bugs Found and Fixed

### Bug 1 (CRITICAL): no account-sale charge ever posted

Confirmed above. **Fix:** `sales.js` gained `postAccountCharge()`, called immediately after a successful, non-duplicate `create_sale_atomic` call. It sums only the `account`-tender portion of the sale's `payments` array (so a split payment only charges the account leg — see Edge Test 6), then performs a compare-and-swap balance update (read `current_balance`, `UPDATE ... WHERE current_balance = <value read>`, bounded retry loop — the same pattern already established for stock in `stockCAS.js`) followed by the `customer_account_transactions` insert. True same-transaction atomicity with the opaque RPC isn't achievable without modifying it (out of scope — no source available, and the ticket's "do not change the sale RPC unless proven" doesn't extend to rewriting a function whose source isn't in this repo). This is the smallest safe fix reachable from the application layer: the charge now lands in the same request as the sale. If it still fails (CAS exhausted, or a DB error), the sale is **not** rolled back — it has already been returned to the client — but a `CUSTOMER_ACCOUNT_CHARGE_FAILED` audit event fires and the error is logged loudly, so the gap is always discoverable, never silent.

**Re-verified live:** balance and ledger both update correctly on every real account sale; retrying the sale's idempotency key does not double-charge (gated on `!was_duplicate`).

### Bug 2: account payment endpoint had zero idempotency protection

Code audit of `customers.js` `POST /:id/account/payment` found no idempotency key handling at all, and a two-step non-atomic sequence (update balance, then insert ledger row — in that order, the riskier order: an insert failure after the balance update leaves a wrong balance with no ledger trail). **Confirmed live** before any fix: two identical retry requests created two separate `-400` transaction rows.

**Fix:** added an optional `idempotency_key` (new `customer_account_transactions.idempotency_key` column + a partial unique index scoped to non-null values, so existing rows are unaffected), checked before any write — a repeated key returns the existing transaction instead of processing again. Flipped the order to insert-first: the ledger row is written before the balance update, using a pre-computed `balance_after` (required — the column is `NOT NULL`) that is corrected in place if the subsequent CAS balance update has to retry against a fresher value. This was caught and fixed once already during this verification: the first version of the fix inserted `balance_after: null` and violated the `NOT NULL` constraint immediately — found live, fixed, re-verified.

**Re-verified live:** a payment with an idempotency key correctly deducts the balance once; retrying the identical request returns `was_duplicate: true` with the balance unchanged.

### Bug 3: Sales by Customer / Customer Statement silently miscategorized every account sale

Found while investigating why Phase 3's statement showed an empty transaction list for a sale that definitely existed. `reports.js` (this session's own Workstream 83 code) declared `const ACCOUNT_PAYMENT_METHOD = 'ACCOUNT'` — uppercase — compared against the real value, `'account'` (lowercase, confirmed live and consistent with `sales.js`'s own documented convention). The mismatch meant:
- Sales by Customer's account/cash-card split always categorized real account sales as cash/card (`account_amount: 0` for an actual R1,000 account sale).
- The Customer Statement's own charge-synthesis query (`.eq('payment_method', 'ACCOUNT')`) matched zero rows — explaining the empty statement despite a real, completed sale.
- The statement's "paid in full, no effect on balance" reference-line query (`.neq('payment_method', 'ACCOUNT')`) had the inverse problem — a real account sale would have been mislabeled as already paid in full.

**Fix:** one-line change, `'ACCOUNT'` → `'account'`. Re-verified live: `account_sales_total` and the statement's transaction list both now correctly reflect real account sales.

## Phase Results (final clean run)

| Phase | Result |
|---|---|
| **1 — Opening state** | Balance R0, 0 ledger rows, credit limit R5,000 — confirmed clean before touching anything. |
| **2 — Account sale (R1,000)** | Sale created (`payment_method: 'account'`), exactly one `sale_payments` row, stock decremented by exactly 1, balance → R1,000, exactly one `charge` ledger row linked via `sale_id`. |
| **3 — Reports** | Sales by Customer: `account_sales_total: 1000, cash_card_sales_total: 0`. Statement: `opening_balance: 0, closing_balance: 1000, balance_mismatch: false`, one transaction shown. |
| **4 — Account payment (R400)** | Payment recorded with an idempotency key; ledger row `amount: -400, balance_after: 600`. |
| **5 — Final reconciliation** | Live balance R600, statement closing balance R600, statement's live-balance comparison R600, `balance_mismatch: false`, Sales by Customer account total still correctly R1,000 (undiscounted by the payment, as it should be — payments and sales are different lines). **Every source agrees.** |

## Negative / Edge Tests

| # | Test | Result |
|---|---|---|
| 1 | Retry same account-sale idempotency key | ✅ `wasDuplicate: true`, balance and ledger row count both unchanged |
| 2 | Retry same payment idempotency key | ✅ `was_duplicate: true`, balance and ledger row count both unchanged (after Bug 2's fix) |
| 3 | Account sale that would exceed credit limit | ⚠️ **Allowed — no credit-limit enforcement exists anywhere in the sale-creation path.** A R5,000 sale against a customer already at R1,000 with a R5,000 limit (would reach R6,000) was accepted with no warning, no block, no override prompt. Documented per the ticket's "according to current rules" instruction — current rules are: none. Not fixed; implementing credit-limit enforcement is a feature addition, not a narrow bug fix, and out of this ticket's scope. |
| 4 | Invalid/missing customer_id | ✅ Failed safely — the RPC's own foreign-key constraint (`sales_customer_id_fkey`) rejected it, the whole transaction rolled back atomically (no orphaned sale/items/stock change), clean 500 response. |
| 5 | Void an account sale | ⚠️ **Confirmed: void does NOT reverse the ledger or balance.** Live test: balance R1,000 before and after voiding the sale that created it. `sales.js`'s `/:id/void` and `/:id/return` routes only ever touch `sales.status`/`pos_returns` — neither references `customers.current_balance` or `customer_account_transactions` anywhere. Documented, not fixed — per the ticket's "document if this is not yet implemented" instruction and "do not redesign customer accounts": correct reversal semantics (a new offsetting ledger entry vs. adjusting the original, interaction with partial returns) is a design decision, not a bug fix. |
| 6 | Split payment containing ACCOUNT (cash R300 + account R700) | ✅ Balance increased by exactly R700 — confirming `postAccountCharge()`'s `payments.filter(p => p.payment_method === 'account')` correctly isolates only the account-tender portion. |

## Atomicity Verdict

Not achievable as true single-transaction atomicity with `create_sale_atomic` (opaque, source unavailable, out of scope to rewrite). The smallest safe fix was implemented instead: the charge-posting call happens immediately after the RPC succeeds and before the HTTP response is sent, so the gap window is a few milliseconds of application-layer code rather than "never happens at all" (the pre-fix state). A failure in that narrow window is not silent — it fires `CUSTOMER_ACCOUNT_CHARGE_FAILED` with full context (sale id, customer id, amount) rather than being swallowed, matching the ticket's explicit "do not patch only the report layer" instruction: the fix is in the write path, not a reporting workaround.

## Audit Trail — Confirmed Complete

Every event required by the ticket exists in `pos_audit_events` with actor (`user_id`), company, timestamp, and amount/reference metadata (no payment credentials of any kind are logged):

```
SALE_CREATED → CUSTOMER_ACCOUNT_CHARGE_POSTED → SALE_REPLAYED (retry)
→ SALE_CREATED → CUSTOMER_ACCOUNT_CHARGE_POSTED → SALE_REPLAYED (retry)
→ CUSTOMER_ACCOUNT_PAYMENT_RECORDED → CUSTOMER_ACCOUNT_PAYMENT_REPLAYED (retry)
```

Two new event types (`CUSTOMER_ACCOUNT_CHARGE_POSTED`/`CUSTOMER_ACCOUNT_CHARGE_FAILED`) and two more (`CUSTOMER_ACCOUNT_PAYMENT_RECORDED`/`CUSTOMER_ACCOUNT_PAYMENT_REPLAYED`) were added to `posAuditLogger.js` — none existed before this workstream.

## Security

- Confirmed live: every customer/account/payment/statement route filters by `req.companyId` server-side (`.eq('company_id', req.companyId)`) — the frontend cannot influence which company's data is touched by supplying a different id.
- Confirmed live: a nonexistent customer id returns a clean `404` (`{"error":"Customer not found"}`), not a leak of another company's data or a stack trace.
- No business truth was written to `localStorage`/`sessionStorage` anywhere in this workstream's code paths — everything is server-authoritative SQL, consistent with CLAUDE.md Part D.

## Cleanup

Per the ticket's explicit instruction, immutable audit evidence was never touched. What was done:

- All 7 test sales (ids 22–29, including the credit-limit edge-test sale and the split-payment test) were **voided through the normal `POST /:id/void` API** — not deleted. Their financial history remains queryable exactly as a real voided sale would.
- `customer_account_transactions` rows for the test customer were deleted directly (not audit-protected — confirmed deletable, unlike `pos_audit_events`), and the customer's `current_balance` was reset to `0`.
- The test customer and test product could **not** be hard-deleted — both are referenced by the (correctly preserved) voided `sales`/`sale_items` rows via foreign keys. Both were deactivated (`is_active: false`) instead, so neither appears in any real workflow again.
- The test user could not be hard-deleted either, blocked by a foreign key from the ecosystem-wide `audit_log` table recording its login events (same protection encountered in Workstream 89) — deactivated instead of forcing the deletion through by removing audit rows.
- `pos_audit_events` rows from this verification remain — by design, this table is append-only at the database level ("governed by POPI Act and SARS 7-year retention requirements"), and correctly so.
- The local test server was stopped; all scratch diagnostic scripts were removed.

Net effect: no test data is reachable through any real workflow, but the full evidence trail proving this verification took place — both the audit log and the voided sales themselves — remains intact.

## Final Verdict

### "Can Checkout Charlie safely process real customer account sales and payments today?"

### Answer: Yes, with conditions

1. **Yes** — after the three fixes in this workstream, an account sale correctly charges the customer's ledger and live balance atomically-in-practice with the sale, a payment correctly and safely reduces it, both are protected against duplicate processing on retry, and every number-producing surface (live balance, Sales by Customer, Customer Statement) now agrees. This was proven with real HTTP requests against the real deployed database, not assumed and not mocked.
2. **Condition:** voiding or returning an account sale does not reverse the customer's balance or ledger. Until this is deliberately designed and built, any account sale that gets voided will leave the customer's balance permanently overstated by that sale's value — staff must be told this and handle it as a manual correction (e.g., a manual account credit) until a proper fix exists.
3. **Condition:** there is no credit-limit enforcement anywhere in the sale-creation path. A customer can be sold on account for any amount regardless of their configured limit. If credit limits are meant to mean anything operationally, this needs a deliberate decision (hard block vs. management-override prompt) as a separate, scoped piece of work.
