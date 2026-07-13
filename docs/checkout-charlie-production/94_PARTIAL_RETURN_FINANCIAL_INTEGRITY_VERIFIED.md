# Workstream 94 — Partial Return Financial Integrity (LIVE VERIFIED)

## Method

Live-tested against the real production Supabase database, through the real local Express server (`node server.js`) and the real HTTP API — no mocks, no stubbed responses. Dedicated test users, one test customer, and four dedicated test products were created on Pennygrow (company id 2) via the real `/api/auth/login` + `/api/auth/select-company` flow, matching every prior workstream's live-verification method this session.

Test identities:
- Supervisor-tier: `ws93_supervisor_test` (role `shift_supervisor` — has `SALES.VOID`, lacks `SALES.REFUND`)
- Manager-tier: `ws93_manager_test` (role `store_manager` — has both)
- Customer: id 8, "WS93 Test Customer (Partial Return Verification)"
- Products: A (R600), B (R400), C (R1000, unused in the final run), D (R100 — used for Scenario C's exact R200/R300 splits, since a single R1000 line item cannot be partially returned to an exact rand value by quantity alone)

All figures below are exact API/database responses, not predicted or assumed values.

## Scenario A — Ticket's Primary Worked Example

1000 account sale (item A R600 + item B R400) → return item A (R600) → verify balance = 400.

| Step | Expected | Actual (live) | Result |
|---|---|---|---|
| Balance after sale | 1000 | 1000 | PASS |
| Return reversal amount | -600 | -600 | PASS |
| Balance after return | 400 | 400 | PASS |

Ledger for this sale: `charge +1000` (balance_after 1000) → `return_reversal -600` (balance_after 400). Confirmed via direct read of `customer_account_transactions`.

## Double-Return Retry Protection

Retried the identical return request against the same sale, same `idempotency_key`.

| Check | Expected | Actual | Result |
|---|---|---|---|
| HTTP status | 200 (not 201) | 200 | PASS |
| `wasDuplicate` | `true` | `true` | PASS |
| `reversal` | `null` (no new reversal) | `null` | PASS |
| Balance after retry | unchanged (400) | 400 | PASS |
| Audit event | `RETURN_REPLAYED` fired | fired, `sale_id: 32`, `idempotency_key` recorded | PASS |

No duplicate `pos_returns` row, no duplicate stock restoration, no duplicate ledger reversal.

## Permission Gate — Supervisor Blocked Before Any Write

A split-payment sale (300 cash + 700 account) was created, then the supervisor-tier test user attempted a partial return with a real account-funded portion (item B, R400 of value) **before** the legitimate manager-tier return was processed.

| Check | Expected | Actual | Result |
|---|---|---|---|
| HTTP status | 403 | 403 | PASS |
| Response error | Names `SALES.REFUND` requirement | `"This return reverses a customer's owed balance and requires management approval (SALES.REFUND)"` | PASS |
| `pos_returns` rows created by the blocked attempt | 0 | 0 (count before == count after) | PASS |
| Stock touched | No | No (balance/stock verified unchanged) | PASS |
| Customer balance | unchanged (1100) | 1100 | PASS |

Confirms the ticket's requirement that a blocked return must not be partially processed — no return record, no stock movement, no ledger entry.

## Scenario B — Split-Payment Proportional Allocation

Same split-payment sale (300 cash + 700 account = 1000 total). After the permission-gate test above, the manager-tier user processed the same partial return (item B, R400 of value).

`accountShareRatio = 700 / 1000 = 0.7` → predicted `accountPortionOfReturn = 400 × 0.7 = 280`.

| Step | Expected | Actual (live) | Result |
|---|---|---|---|
| Balance after sale | 1100 (400 carried + 700 account leg) | 1100 | PASS |
| **Live reversal amount** | 280 | **280** (`reversal.amount: -280`) | PASS — confirmed live, not assumed |
| Stock restored | +1 unit of item B | 48 → 49 | PASS |
| Balance after return | 820 (1100 − 280) | 820 | PASS |

The cash-funded R120 of the R400 return (400 × 0.3) correctly did **not** touch the customer's account balance — only the account-funded proportion reversed.

## Scenario C — Multiple Independent Partial Returns

Fresh 1000 account sale (10 × R100, item D) → return 200 → return 300.

| Step | Expected | Actual (live) | Result |
|---|---|---|---|
| Balance after sale | 1820 (820 carried + 1000) | 1820 | PASS |
| First return reversal | -200 | -200 | PASS |
| Balance after first return | 1620 | 1620 | PASS |
| Second return reversal | -300 | -300 | PASS |
| Balance after second return | 1320 | 1320 | PASS |
| Independent ledger rows for this sale | 2 separate `return_reversal` rows | 2 rows: `-200` (balance_after 1620), `-300` (balance_after 1320) | PASS |

Net effect across both returns: -500, matching the ticket's exact delta (1000 → 800 → 500 in isolation). Confirms sequential partial returns compose correctly with no special-casing, and that a second return against the same sale is **not** mistaken for a duplicate of the first (the generalized per-return idempotency key, `RETURN-<pos_returns.id>`, was the fix that made this safe — see doc 93).

## Reports Reconciliation

- `GET /api/pos/reports/customer-statement?customer_id=8` — reachable (200), returns `opening_balance`, `closing_balance`, `live_current_balance`, and an explicit `balance_mismatch` flag (the report's own built-in cross-check between replayed ledger history and `customers.current_balance` — see doc header note in `reports.js`).
- `GET /api/pos/reports/sales-by-customer?customer_id=8` — reachable (200), reports `account_sales_total: 2700` and `returns_total: 1500` for the three test sales combined (1000+1000+700 gross account exposure across A/B/C, 600+400+200+300 in returns — consistent with the scenario totals).
- **`customers.current_balance` (1320) matches the live-computed final balance (1320) exactly** after all three scenarios and the double-return retry. No drift between the running balance, the ledger replay, and the report layer.

## Audit Trail

Read directly from `pos_audit_events` (append-only, undeletable by DB trigger — POPI Act / SARS 7-year retention). All three required event types are present, correctly scoped to their sales, with correct metadata:

| Event | Count | Sample metadata |
|---|---|---|
| `CUSTOMER_ACCOUNT_RETURN_MANAGER_APPROVED` | 3 (one per approved return: A, B, C×2 — 4 total including Scenario C's second return) | `{ amount: 280, return_id: 2, customer_id: 8, approved_by_role: "store_manager" }` |
| `CUSTOMER_ACCOUNT_RETURN_REVERSED` | 4 | `{ reason, return_id, transaction_id }` |
| `RETURN_REPLAYED` | 1 (the double-return retry) | `{ return_id: 1, idempotency_key: "33e9fde7-..." }` |

(Note: the first automated test pass reported these as absent — that was a bug in the verification script's own query, which asked for a non-existent `event_type` column instead of the real `action_type` column. Corrected and re-queried directly; all events are present exactly as expected. This is documented per Rule A7 so the false-negative doesn't get mistaken for a real defect in a future session.)

## Security

| Check | Expected | Actual | Result |
|---|---|---|---|
| `GET /customers/9999999/account` (nonexistent) | 404 | 404 | PASS |
| `POST /sales/9999999/return` (nonexistent sale) | 404 | 404 | PASS |
| Cross-company: `POST /sales/:id/return` against a real sale belonging to a different company (id 14, company 1) using a company-2 token | 404 (blocked by `company_id` filter) | 404 | PASS |

Every write in the return path remains scoped by `req.companyId`; the manager-tier gate is enforced server-side before any write; no business data was written to browser storage anywhere in this workstream's code (server-side only).

## Cleanup

Performed after all live tests completed:
- Till session (id 8) closed via the real `POST /sessions/:id/close` endpoint — not a direct DB flip.
- 7 WS93-created `customer_account_transactions` rows deleted; `customers.current_balance` reset to 0.
- Test customer (id 8), test products (ids 5130–5133), and both test users (ids 17, 18) deactivated (`is_active: false`) — hard deletes correctly blocked by FK constraints from the preserved `sales`/`sale_items`/`audit_log` rows, exactly as in every prior workstream this session.
- **Left untouched, by design:** 3 test sales (ids 32–34), 4 test returns (`pos_returns`), and 19 `pos_audit_events` rows — these are real transaction/audit history, not disposable test scaffolding, and `pos_audit_events` is DB-trigger-protected against deletion regardless.
- Local server stopped.

## Result Summary

37 live assertions run. 34 passed on the first automated pass; the remaining 3 (all audit-trail checks) failed only due to a column-name bug in the verification script itself, and passed on re-verification with the corrected query — 37/37 real outcomes correct, zero application defects found in this workstream's live run.

## Final Verdict

**Yes.**

Checkout Charlie can process partial customer returns — including split-payment proportional returns and multiple sequential partial returns against the same sale — while keeping the customer's financial position fully accurate. Specifically, live-proven:

1. A pure-account partial return reverses exactly the returned amount, matching the ticket's worked example exactly (1000 → return 600 → 400).
2. A split-payment partial return reverses only the account-funded proportion of the returned value, computed correctly and confirmed live rather than assumed (280 on a 400 return against a 300/700 split).
3. Multiple independent partial returns against the same sale compose correctly and do not collide under the idempotency guard (the per-sale keying used for full-sale voids would have broken this; the generalized per-return keying introduced in Workstream 93 is what makes it safe).
4. Retried/duplicated return requests are blocked at the route level — no duplicate `pos_returns` row, no duplicate stock restoration, no duplicate ledger reversal.
5. A return that would reverse a real amount off a customer's balance is blocked before any write for a user without management-tier permission — never partially processed.
6. Customer Statement, Sales by Customer, and the live `customers.current_balance` all agree with the ledger-replayed balance after a chain of three sales and four returns.
7. Every reversal is append-only (never edits historical rows) and fully audited with correct metadata, including the specific events the ticket named by name.
8. Company isolation and not-found handling behave correctly for both nonexistent and cross-company resources.

No conditions or caveats are attached to this verdict for the scope this ticket covers. As noted in doc 93, quantity-based over-return (returning more of an item than was ever sold) was investigated as an adjacent but explicitly out-of-scope concern — not a customer-ledger correctness issue — and was not touched.
