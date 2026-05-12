# Checkout Charlie — Workstream 2A Implementation Report
## Till Reconciliation + Report Trust Hardening

**Date:** 2026-05-12
**Scope:** Forensic-grade trust hardening on top of existing operational screens
**Policy:** No existing routes rewritten. No cash-up screens replaced. No existing reports touched.

---

## 1. Trust Gaps Found During Audit

Before this workstream, the following structural trust problems existed:

| Gap | Location | Detail |
|---|---|---|
| Wrong expected balance | `sessions.js` close route | `expected_balance = opening + ALL completed sales` — ignores payment method entirely. Card/EFT sales don't land in the physical drawer. For a pure cash reconciliation, this number is fundamentally incorrect. |
| Refunds not in expected balance | `sessions.js` close route | `pos_returns` table is never read during close/cashup. Refunds paid out in cash are not deducted from the expected cash figure. |
| No payment breakdown | `sessions.js` cashup route | `counted_cash + counted_card + counted_other` is counted in but the EXPECTED counterpart has no method split. The two sides of the cashup don't share a common basis. |
| No immutable snapshot | `till_sessions` table | On `complete-cashup`, totals are written to mutable columns (`closing_balance`, `variance`, `expected_balance`). These can be overwritten or corrupted. No DB-level protection. |
| No orphan/consistency detection | (none existed) | Payment total mismatches, sales with no payments, duplicate payments, and returns on voided sales were invisible. |
| No historical reproducibility | (none existed) | Running the same cashup query later (e.g., after more sales are added to the session by a late sync) would produce different numbers. The basis for historical totals was not frozen. |

---

## 2. What Was Built

### 2A. Migration 029 — `pos_recon_snapshots` table

**File:** [database/migrations/029_pos_recon_snapshots.sql](../../accounting-ecosystem/database/migrations/029_pos_recon_snapshots.sql)

Append-only table. UPDATE and DELETE are blocked at the engine level by triggers, identical to `pos_audit_events`. No FK constraints by design (same philosophy — audit records must survive parent deletion).

**Key columns:**

| Column | Purpose |
|---|---|
| `till_session_id`, `company_id`, `till_id` | Session linkage (no FK) |
| `cashier_user_id`, `generated_by_user_id` | Who was on the till, who triggered the snapshot |
| `triggered_by` | `'cashup'` (automatic) or `'manual'` (manager-triggered) |
| `opening_balance` | Float as recorded on the session |
| `sale_count`, `gross_sales`, `discount_total`, `vat_total` | From `sales` table — completed sales only |
| `void_count`, `void_total` | From `sales` table — voided sales |
| `payment_cash`, `payment_card`, `payment_eft`, `payment_account`, `payment_other` | From `sale_payments` — authoritative per-method breakdown |
| `refund_count`, `refund_total`, `refund_cash`, `refund_card` | From `pos_returns` |
| `net_sales` | `gross_sales - refund_total` |
| `expected_cash_in_drawer` | `opening_balance + payment_cash - refund_cash` (forensically correct) |
| `counted_cash`, `counted_card`, `counted_other`, `total_counted` | Physical count from cashup |
| `cash_variance` | `total_counted - expected_cash_in_drawer` |
| `payment_breakdown`, `refund_breakdown` | Full JSONB maps — forward-compatible with new payment methods |
| `is_consistent`, `consistency_issues` | Anomaly detection results |

**Two append-only triggers:**
- `pos_recon_no_update` — blocks UPDATE
- `pos_recon_no_delete` — blocks DELETE
- Both use `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER` (idempotent re-run safe)

---

### 2B. `posReconService.js` — Reusable Reconciliation Layer

**File:** [backend/modules/pos/services/posReconService.js](../../accounting-ecosystem/backend/modules/pos/services/posReconService.js)

Three exported functions:

#### `computeSessionRecon(sessionId, companyId)`

Pure read. No side effects. Derives authoritative totals from three tables:
- `sales` — completed/voided counts and amounts
- `sale_payments` — payment method breakdown (the ONLY authoritative source for per-method totals)
- `pos_returns` — refund amounts and methods

Returns:
```javascript
{
  session,              // raw session row
  saleCount, grossSales, discountTotal, vatTotal,
  voidCount, voidTotal,
  paymentCash, paymentCard, paymentEft, paymentAccount, paymentOther,
  paymentByMethod,      // full map { cash: N, card: N, ... }
  refundCount, refundTotal, refundCash, refundCard,
  refundByMethod,       // full map
  openingBalance,
  netSales,             // grossSales - refundTotal
  expectedCashInDrawer, // openingBalance + paymentCash - refundCash
}
```

Safe to call multiple times. Throws on DB error (caller handles).

#### `detectInconsistencies(sessionId, companyId)`

Pure read. Returns array of issue objects (empty = clean). Never throws — errors returned as `{ type: 'check_error', detail: '...' }`.

**Checks run:**

| Check | Impossible State Detected |
|---|---|
| `sale_no_payments` | Completed sale has no rows in `sale_payments` |
| `payment_total_mismatch` | SUM(`sale_payments.amount`) differs from `sales.total_amount` by more than 1¢ |
| `negative_sale_total` | Completed sale with `total_amount <= 0` |
| `duplicate_payment` | Same (sale_id, payment_method, amount) appears more than once in `sale_payments` |
| `return_on_voided_sale` | A `pos_returns` row references a sale that is `voided` |

Each issue object includes: `type`, affected IDs, amounts, and a human-readable `detail` field.

#### `createReconSnapshot(sessionId, companyId, generatedByUserId, generatedByEmail, triggeredBy, cashupData)`

Calls `computeSessionRecon` + `detectInconsistencies`, then inserts an immutable row into `pos_recon_snapshots`.

**Wrapped in try/catch. Never throws. Safe to fire-and-forget.**

Returns the created snapshot row (or `null` on failure — error logged to console).

---

### 2C. `reconciliation.js` — New API Routes

**File:** [backend/modules/pos/routes/reconciliation.js](../../accounting-ecosystem/backend/modules/pos/routes/reconciliation.js)

Mounted alongside `sessionsRoutes` in `pos/index.js`. Session routes take priority; unmatched paths fall through to reconciliation routes.

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET /api/pos/sessions/:id/reconciliation` | `INVENTORY.VIEW` | Live recon computed at request time — always reflects current DB state |
| `GET /api/pos/sessions/:id/snapshot` | `INVENTORY.VIEW` | Most recent immutable snapshot for this session |
| `GET /api/pos/sessions/:id/snapshots` | `INVENTORY.VIEW` | All snapshots for this session (history) |
| `POST /api/pos/sessions/:id/snapshot` | `SALES.VOID` | Manually create a new immutable snapshot |

**GET reconciliation response includes:**
- `session` — session state with legacy expected_balance for comparison
- `totals` — sales/void/refund totals
- `payments` — per-method breakdown from `sale_payments`
- `refunds` — per-method breakdown from `pos_returns`
- `cash_reconciliation` — `expected_cash_in_drawer` (correct) vs `legacy_expected_balance` (old), with the difference highlighted
- `consistency` — issue count + issue array
- `computed_at` — timestamp of computation

---

### 2D. Wire Into Cashup Completion

**File:** [backend/modules/pos/routes/sessions.js](../../accounting-ecosystem/backend/modules/pos/routes/sessions.js)

In `complete-cashup` route, after the `CASHUP_COMPLETED` and `CASH_VARIANCE_RECORDED` audit events are fired, a reconciliation snapshot is created:

```javascript
createReconSnapshot(
  req.params.id,
  req.companyId,
  req.user.userId,
  req.user.email || req.user.username,
  'cashup',
  { counted_cash, counted_card, counted_other, total_counted: totalCounted, variance }
);
```

**Non-blocking.** No `await`. Route handler continues to `res.json({ session: data })` immediately. `createReconSnapshot` has internal try/catch and never propagates exceptions. If snapshot creation fails, it logs to console and returns `null`. The cashup response is unaffected.

All existing cashup logic (calculation of `totalCounted`, `variance`, DB update, `auditFromReq`, `posAuditFromReq`) is unchanged.

---

### 2E. Route Registration

**File:** [backend/modules/pos/index.js](../../accounting-ecosystem/backend/modules/pos/index.js)

```javascript
router.use('/sessions', sessionsRoutes);
router.use('/sessions', reconciliationRoutes);  // falls through after sessionsRoutes
```

Express falls through from `sessionsRoutes` to `reconciliationRoutes` for any path not handled by sessions (i.e., `/:id/reconciliation`, `/:id/snapshot`, `/:id/snapshots`).

---

## 3. Reconciliation Architecture

```
POST /api/pos/sessions/:id/complete-cashup
    │
    ├── [existing] Fetch session
    ├── [existing] Calculate totalCounted, variance
    ├── [existing] DB UPDATE till_sessions (closing_balance, variance, status)
    ├── [existing] auditFromReq → audit_log
    ├── [existing] posAuditFromReq CASHUP_COMPLETED → pos_audit_events
    ├── [existing] posAuditFromReq CASH_VARIANCE_RECORDED → pos_audit_events
    │
    └── [NEW — non-blocking] createReconSnapshot()
            │
            ├── computeSessionRecon()
            │       ├── SELECT till_sessions WHERE id = sessionId
            │       ├── SELECT sales WHERE till_session_id = sessionId
            │       ├── SELECT sale_payments WHERE sale_id IN (session's sales)
            │       └── SELECT pos_returns WHERE original_sale_id IN (session's sales)
            │
            ├── detectInconsistencies()
            │       ├── Check: sale_no_payments
            │       ├── Check: payment_total_mismatch
            │       ├── Check: negative_sale_total
            │       ├── Check: duplicate_payment
            │       └── Check: return_on_voided_sale
            │
            └── INSERT pos_recon_snapshots (immutable, append-only)
```

---

## 4. Immutable Snapshot Design

The `pos_recon_snapshots` table is append-only at the database level:

- `prevent_recon_snapshot_modification()` trigger function raises EXCEPTION on any UPDATE or DELETE attempt, regardless of role or connection type (including service-role).
- Triggers fire BEFORE the operation reaches storage.
- The function name and exception message explicitly state the compliance reason.

Once a snapshot row is written, its totals are permanently frozen. Later sales, voids, or returns do not modify existing snapshots. If a manager needs to see the current state after further changes, they call `POST /api/pos/sessions/:id/snapshot` to create a NEW snapshot alongside the historical one.

**Historical totals are now reproducible:** The snapshot contains all the computed totals as columns (not just references to live data). Even if the underlying `sales` or `sale_payments` rows are later deleted, the snapshot row survives with the frozen figures.

---

## 5. Correct Cash-in-Drawer Expectation

The core fix for cash reconciliation trust:

```
expected_cash_in_drawer = opening_balance + payment_cash - refund_cash
```

This is the ONLY figure that represents what should physically be in the till drawer at cashup time.

**Why the legacy `expected_balance` was wrong:**

| Legacy formula | Problem |
|---|---|
| `opening_balance + SUM(completed sales)` | Includes card/EFT/account sales — money that never touched the drawer |
| No refund deduction | Cash refunds paid out are not subtracted |

**Effect:** On a session with R1,000 card sales and R200 cash sales and a R50 cash refund:
- Legacy `expected_balance` = opening + R1,200 (wrong — R1,000 was never in the drawer)
- Correct `expected_cash_in_drawer` = opening + R200 - R50 = opening + R150

The legacy `expected_balance` column in `till_sessions` is NOT changed. It remains for UI compatibility. The new `expected_cash_in_drawer` is stored in `pos_recon_snapshots` alongside it.

---

## 6. Consistency Checks — Impossible States Now Detectable

| State | Detection Method |
|---|---|
| Completed sale with no payment record | Session's sale IDs with no matching `sale_payments` rows |
| Payment total ≠ sale total | SUM(`sale_payments.amount`) vs `sales.total_amount`, >1¢ tolerance |
| Negative-total completed sale | `total_amount <= 0` in `sales` where `status = 'completed'` |
| Duplicate payment rows | Same (sale_id, method, amount) signature appearing >1 time |
| Return on a voided sale | `pos_returns.original_sale_id` pointing to a voided sale |

All checks are session-scoped (fast, bounded by session's sales). Results stored in `consistency_issues` JSONB array. `is_consistent = false` when any issue is found — the snapshot is still created; it records the anomaly rather than preventing the snapshot.

**Orphan checks not included in session-scoped detection** (global orphans — `sale_items` or `sale_payments` with no matching `sales` row at all — require a company-wide scan and are out of scope for per-session cashup. These are suitable for a nightly audit job, which is a future enhancement.)

---

## 7. Report Trust: What Is Now Reproducible

| Report | Historical Trust Before | Historical Trust After |
|---|---|---|
| Cash-in-drawer expected figure | Not reproducible — live recalculation | Frozen in snapshot at cashup time |
| Payment method breakdown | Not available in cashup | Frozen in snapshot from `sale_payments` |
| Refund deduction | Not in cashup figures | Frozen in snapshot from `pos_returns` |
| Void totals | Not in cashup figures | Frozen in snapshot |
| Discount/VAT breakdown | Not in cashup figures | Frozen in snapshot |
| Consistency state at cashup | Not recorded | Frozen as `is_consistent` + `consistency_issues` |

**Existing `reports.js` routes are unchanged.** `sales-summary`, `top-products`, `cashier-performance`, `inventory-value`, and `dashboard` all function exactly as before.

---

## 8. No localStorage / No Browser Storage

`posReconService.js` and `reconciliation.js` write only to `pos_recon_snapshots` via the Supabase client. No `localStorage`, `sessionStorage`, or KV bridge used anywhere in the reconciliation layer.

---

## 9. Remaining Trust Gaps (Known Limitations)

```
FOLLOW-UP NOTE
- Area: Global orphan detection
- Dependency: Nightly audit job (cron or admin endpoint)
- What was done now: Session-scoped orphan checks built; company-wide orphan scan excluded
- What still needs to be done: Build a nightly company-wide orphan scan
  (sale_items with no sales row, sale_payments with no sales row — full table scans)
- Risk if not done: Orphans created outside of normal session flow (e.g., failed RPC with partial writes)
  would go undetected
- Recommended next review point: When a nightly audit cron job infrastructure is built

FOLLOW-UP NOTE
- Area: Session close route expected_balance
- What was NOT changed: till_sessions.expected_balance is still written as
  opening + all-method completed sales (no refunds, no method split).
  The UI reads this figure for the close screen display.
- What still needs to be done: The close screen UI could display expected_cash_in_drawer
  instead of expected_balance for cashiers doing physical cash reconciliation.
  This is a frontend change only and does not affect any DB values.
- Risk if not done: Cashiers see a misleading expected figure during session close
  if the session has significant non-cash sales or refunds.
- Recommended next review point: When the POS cashup UI is reviewed for UX improvements

FOLLOW-UP NOTE
- Area: Offline sale source tracking in recon
- What was NOT changed: The 'source' field (online vs offline_sync) is stored in
  pos_audit_events but NOT in the sales table. The reconciliation service cannot
  break down sales by source (online vs offline) directly from the sales table.
- What still needs to be done: Add a 'source' column to the sales table and populate
  it via the create_sale_atomic RPC. Then offline sale counts can be included in recon.
- Risk if not done: Offline sync sales are included in totals but not separately
  identified in the snapshot. The audit event log can still identify them by source.
- Recommended next review point: When offline sync reporting requirements are formalized
```

---

## 10. Files Created / Modified

| File | Type | Change |
|---|---|---|
| `database/migrations/029_pos_recon_snapshots.sql` | NEW | Immutable snapshot table + append-only triggers |
| `backend/modules/pos/services/posReconService.js` | NEW | computeSessionRecon, detectInconsistencies, createReconSnapshot |
| `backend/modules/pos/routes/reconciliation.js` | NEW | 4 reconciliation API endpoints |
| `backend/modules/pos/routes/sessions.js` | MODIFIED | Added createReconSnapshot call in complete-cashup (non-blocking) |
| `backend/modules/pos/index.js` | MODIFIED | Registered reconciliationRoutes alongside sessionsRoutes |

**Files NOT touched:** `reports.js`, `sales.js`, `products.js`, `inventory.js`, `receipts.js`, `auth.js`, `posAuditLogger.js`, any frontend file, any existing report endpoint.

---

## 11. Implementation Readiness

- [x] Audit complete — no existing functionality removed or weakened
- [x] Snapshot is immutable — append-only trigger blocks UPDATE and DELETE at DB level
- [x] Snapshot creation is non-blocking — fire-and-forget, try/catch, never breaks cashup response
- [x] Historical totals frozen at cashup time — not recalculated from live data later
- [x] Payment method breakdown authoritative — from `sale_payments`, not from `sales.payment_method`
- [x] Refunds included in expected cash figure — from `pos_returns`
- [x] Consistency checks run at snapshot time — 5 impossible states detectable
- [x] Existing reports unchanged — `reports.js` not touched
- [x] Existing cashup screens unchanged — `sessions.js` existing routes not modified
- [x] No localStorage — all writes go to Supabase `pos_recon_snapshots` via API
- [x] Audit linkage — snapshot references `till_session_id`, `cashier_user_id`, `generated_by_user_id`, `company_id`, `till_id`, `triggered_by`
- [x] Migration idempotent — `CREATE TABLE IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`
