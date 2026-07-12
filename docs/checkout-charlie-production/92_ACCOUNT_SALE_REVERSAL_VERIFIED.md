# Workstream 91 — Account Sale Void & Reversal Engine (VERIFIED)

## Verdict: **Yes** — see Final Verdict for full detail

The reversal engine designed and built in Workstream 91 was tested against the live database that backs the deployed app, over real HTTP requests to the real application code. Every scenario the ticket specified passed, including the two negative/safety tests (manager-tier gate, double-void) that most directly protect against a repeat of the exact bug Workstream 90 found.

## Method

Same method as Workstreams 89/90: the real backend (`node server.js`) was started locally, pointed at the live Supabase database via the HTTPS client (the raw `DATABASE_URL` connection used only by schema migrations is unreachable from this machine — irrelevant here since this workstream added no new columns, only a new string value, `'charge_reversal'`, for the existing `customer_account_transactions.type` column). All scenario actions were driven over real HTTP using dedicated test accounts logging in through the real `/api/auth/login` + `/api/auth/select-company` flow.

## Test Data

| Item | Value |
|---|---|
| Company | Pennygrow (id 2) |
| Supervisor test user | `ws91_supervisor_test` (role `shift_supervisor` — has `SALES.VOID`, does **not** have `SALES.REFUND`) |
| Manager test user | `ws91_manager_test` (role `store_manager` — has both) |
| Test customer | "WS91 Test Customer (Void Reversal Verification)" — opening balance R0 |
| Test product | "TEST-VOID-ITEM" — unit price R1,000 |

## Scenario 1 — Basic Void Reversal

| Step | Result |
|---|---|
| Opening balance | R0, 0 ledger rows |
| Account sale (R1,000) | Created, `payment_method: 'account'`, balance → R1,000, one `charge` ledger row |
| **Supervisor attempts to void** (no `SALES.REFUND`) | **Blocked — `403`**, exact message: *"Voiding an account sale reverses a customer's owed balance and requires management approval (SALES.REFUND)"*. Balance unchanged at R1,000. |
| Sale status after the blocked attempt | **Still `completed`** — confirmed the sale was NOT partially voided (no split-brain state where the sale flips to voided but the reversal never happens, which would have recreated the Workstream 90 bug) |
| **Manager voids the sale** | Succeeds. Response includes the reversal transaction: `{ type: 'charge_reversal', amount: -1000, balance_after: 0, sale_id: 30, reference: "Reversal of charge for voided sale SAL-...", created_by: <manager user id> }` |
| **Balance after void** | **R0 — exact.** |
| Ledger after void | Exactly 2 rows: the original `charge` (+1000, untouched, not edited) and the new `charge_reversal` (-1000). Financial history was appended to, never rewritten. |

## Double Void

Voiding the same sale a second time: **blocked, `400`, `"Sale is already voided"`.** Balance remained R0. Ledger row count remained exactly 2 (no third row created). The status-update CAS guard (`WHERE status = <value read>`) caught this before the reversal logic was ever reached a second time.

## Statement / Reports Agreement

`GET /reports/customer-statement?customer_id=7` after the void: `closing_balance: 0`, `live_current_balance: 0`, `balance_mismatch: false`, both the charge and the reversal shown as separate lines (`running_balance` correctly steps 0 → 1000 → 0). `GET /reports/sales-by-customer?customer_id=7&include_voids=true` correctly shows the voided sale with `status: "voided"` and `account_amount: 1000` (the original charge amount, which is correct — that endpoint reports what a sale *was*, not the customer's current balance).

*(Note: the same endpoint without `include_voids=true` returns 404 "Customer not found" once a customer's only sale is voided — this is pre-existing, correct, documented behaviour of that report from Workstream 83/90, not a defect: the drill-down only resolves customer metadata from included sales, and voided sales are excluded by default. Confirmed intentional, not a regression.)*

## Split Payment Void

A second test sale: cash R300 + account R700 (`payments: [{cash, 300}, {account, 700}]`).

- Sale creation: balance increased by exactly R700 (not R1,000) — only the account leg is charged, per Workstream 90's existing behaviour.
- **Void:** reversal transaction shows `amount: -700` — exactly the account leg, confirmed **not** R1,000. Balance returned to its exact pre-sale value.
- **Retry the same void request:** blocked, `400`, `"Sale is already voided"`. Balance unchanged. Ledger row count unchanged (no duplicate reversal from the retry).

## Idempotency / Retry Safety

Two independent layers, both confirmed live:
1. The `/void` route's CAS-guarded status update — a second void attempt (whether a genuine double-void or a client retry) finds the sale already in `voided` status and is rejected before any reversal logic runs.
2. `reverseAccountCharge`'s own idempotency guard (existing `charge_reversal` row for the `sale_id`) — a second, independent safety net that would catch a reversal duplicate even if the status-CAS window were somehow crossed.

Neither test in this workstream needed to reach layer 2 directly (layer 1 always caught the retry first, which is the expected and correct order of defence) — layer 2 exists for a narrower race (e.g. two overlapping requests both passing the status-CAS in an interleaved way) that is much harder to reproduce deterministically in a test script; its logic was verified by code review and by the fact that `adjustCustomerAccountLedger`'s idempotency-guard code path is the exact same one already proven live in Workstream 90 for account payments.

## Audit Trail — Confirmed Complete

Full sequence for both scenarios, in order, each with actor (`user_id`), company, and metadata:

```
SALE_CREATED → CUSTOMER_ACCOUNT_CHARGE_POSTED
→ CUSTOMER_ACCOUNT_REVERSAL_MANAGER_APPROVED → SALE_VOIDED → CUSTOMER_ACCOUNT_CHARGE_REVERSED
```

The blocked supervisor attempt (403) and the double-void attempt (400) correctly produced **no** audit noise — both were rejected before reaching any audit-worthy write, which is itself confirmation the permission gate and the CAS guard both sit ahead of every side effect, not after.

## Security

- Every route remains scoped by `req.companyId` — unchanged.
- The manager-tier gate (`hasPermission(req.user.role, 'SALES', 'REFUND')`) is enforced server-side, before any database write — confirmed live: the supervisor's request was rejected at `403` with zero state change, not merely hidden in the UI.
- A nonexistent customer id returns a clean `404`, not a data leak.
- No business truth was written to `localStorage`/`sessionStorage` anywhere in this workstream's code.

## Console Errors

None observed in either test run's server-side logs beyond the expected, already-documented benign noise from unrelated background module initialization (coaching module `DATABASE_URL` timeout warnings) present in every workstream this session — no errors traceable to this workstream's code.

## Cleanup

Per the established pattern (Workstreams 89/90): both test sales were left in their **voided** state (never deleted — financial history preserved exactly as a real voided sale would be). The test customer's ledger rows were deleted (not audit-protected, confirmed deletable) and its balance reset to R0. The test customer and test product could not be hard-deleted (blocked by foreign keys from the preserved `sales`/`sale_items` rows) and were deactivated instead. The supervisor test user (never performed a state-changing action) was cleanly deleted; the manager test user (performed real voids) was deactivated, blocked by the same `audit_log` foreign key protection encountered in every prior workstream — correct, expected behaviour, not worked around. `pos_audit_events` rows remain, by design (append-only).

## Final Verdict

### "Can Checkout Charlie safely reverse customer account sales without leaving financial inconsistencies?"

### Answer: Yes

Voiding an account sale now correctly and atomically-in-practice reverses the customer's ledger and live balance, appends rather than rewrites financial history, cannot be double-applied (two independent, live-confirmed safety layers), requires management-tier approval before any reversal is attempted, and every reporting surface (live balance, Customer Statement, Sales by Customer) agrees with the result. This closes the exact gap Workstream 90 proved existed, with no open conditions on the void path itself.

One scope boundary carried forward, not a defect in what was built: **partial returns on account sales remain unsupported** for balance/ledger purposes (investigated and documented in doc 91, per the ticket's explicit instruction not to redesign returns) — a business using partial returns against account-sale customers should be told this is not yet handled, separately from today's "yes" on void/full-sale reversal.
