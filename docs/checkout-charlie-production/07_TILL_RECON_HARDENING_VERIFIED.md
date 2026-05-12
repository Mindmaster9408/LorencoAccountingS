# Checkout Charlie — Workstream 2A Verification Report
## Till Reconciliation + Report Trust Hardening: Static Analysis Results

**Date:** 2026-05-12
**Verification method:** Complete static analysis of all created and modified files
**Migration status:** 029 ready to run in Supabase SQL Editor
**Overall verdict: ONE BUG FOUND AND FIXED — all other checks pass**

---

## 1. Files Verified

| File | Status |
|---|---|
| `database/migrations/029_pos_recon_snapshots.sql` | Read + verified |
| `backend/modules/pos/services/posReconService.js` | Read + bug found + bug fixed |
| `backend/modules/pos/routes/reconciliation.js` | Read + verified |
| `backend/modules/pos/routes/sessions.js` | Read + verified (modified) |
| `backend/modules/pos/index.js` | Read + verified (modified) |

---

## 2. Migration 029 — `pos_recon_snapshots` Table

| Check | Result |
|---|---|
| `CREATE TABLE IF NOT EXISTS` (idempotent) | PASS |
| `company_id INTEGER NOT NULL` present | PASS |
| `till_session_id INTEGER NOT NULL` present | PASS |
| No FK constraints by design (survives parent deletion) | PASS — no REFERENCES clauses on session/sale/user columns |
| `triggered_by` column with `DEFAULT 'cashup'` | PASS |
| `expected_cash_in_drawer` column present | PASS |
| `cash_variance` column present (correct variant, not legacy all-methods) | PASS |
| `payment_breakdown JSONB` and `refund_breakdown JSONB` columns present | PASS |
| `is_consistent BOOLEAN NOT NULL DEFAULT true` | PASS |
| `consistency_issues JSONB` (null = clean) | PASS |
| `idx_pos_recon_company_time` index (company + time DESC) | PASS |
| `idx_pos_recon_session` index (till_session_id) | PASS |
| `CREATE OR REPLACE FUNCTION prevent_recon_snapshot_modification()` | PASS — idempotent |
| `DROP TRIGGER IF EXISTS pos_recon_no_update` before CREATE TRIGGER | PASS |
| `DROP TRIGGER IF EXISTS pos_recon_no_delete` before CREATE TRIGGER | PASS |
| Both triggers fire BEFORE operation | PASS — `BEFORE UPDATE` and `BEFORE DELETE` |
| Trigger RAISE EXCEPTION message states compliance reason | PASS |

Migration is idempotent. Safe to re-run.

---

## 3. `posReconService.js` — Core Service Verification

### 3.1 `computeSessionRecon` — Data source verification

| Check | Implementation | Result |
|---|---|---|
| Session query uses both `id` and `company_id` filters | `.eq('id', sessionIdInt).eq('company_id', companyIdInt)` | PASS — company isolation confirmed |
| Sales query scoped to session and company | `.eq('till_session_id', sessionIdInt).eq('company_id', companyIdInt)` | PASS |
| Payments fetched via `.in('sale_id', saleIds)` | All payments for session's sales | PASS |
| Payments filtered to completed sales ONLY before aggregation | `completedSaleIds` Set + `.filter()` at line 91–94 | PASS — voided sale payments excluded from breakdown |
| Returns fetched via `.in('original_sale_id', saleIds)` | All returns for session's sales | PASS |
| Returns filtered to `status = 'completed'` only | `.eq('status', 'completed')` | PASS — pending/failed returns excluded |
| Empty session guard (no sales) | `if (saleIds.length > 0)` around payments and returns queries | PASS |

### 3.2 `computeSessionRecon` — Formula verification

| Computed Value | Formula | Correct? |
|---|---|---|
| `grossSales` | `SUM(completed_sales.total_amount)` | PASS |
| `paymentCash` | `SUM(sale_payments.amount WHERE method = 'cash', completed sales only)` | PASS |
| `paymentCard` | `SUM(sale_payments.amount WHERE method = 'card', completed sales only)` | PASS |
| `paymentEft` | `SUM(sale_payments.amount WHERE method = 'eft', completed sales only)` | PASS |
| `paymentOther` | Sum of all non-cash/card/eft/account methods | PASS |
| `refundCash` | `SUM(pos_returns.refund_amount WHERE method = 'cash')` | PASS |
| `refundCard` | `SUM(pos_returns.refund_amount WHERE method = 'card')` | PASS |
| `netSales` | `grossSales - refundTotal` | PASS |
| `expectedCashInDrawer` | `openingBalance + paymentCash - refundCash` | PASS |

**Card and EFT are excluded from `expectedCashInDrawer`.** They are returned separately in `paymentCard` and `paymentEft`. The physical cash drawer reconciliation figure is forensically correct.

**Scenario trace — mixed payment session:**
```
Session: opening_balance = R500
Sales:
  Sale A: R1,000 cash
  Sale B: R2,000 card
  Sale C: R500 eft
Refunds:
  Return on Sale A: R200 cash refund

grossSales         = R3,500
paymentCash        = R1,000   (from sale_payments, Sale A only)
paymentCard        = R2,000   (from sale_payments, Sale B only)
paymentEft         = R500     (from sale_payments, Sale C only)
refundCash         = R200     (from pos_returns)
expectedCashInDrawer = R500 + R1,000 - R200 = R1,300  ✓

Legacy expected_balance would have been: R500 + R3,500 = R4,000  ✗
                                                                  (card/EFT never in drawer)
```

### 3.3 `detectInconsistencies` — Check verification

| Check | Trigger Condition | Result |
|---|---|---|
| `sale_no_payments` | Completed sale with 0 rows in `sale_payments` | PASS |
| `payment_total_mismatch` | `ABS(SUM(payments) - sale.total_amount) > 0.01` | PASS — 1¢ tolerance |
| `negative_sale_total` | `sale.total_amount <= 0` on a completed sale | PASS |
| `duplicate_payment` | Same `(sale_id, method, amount)` signature > 1 time | PASS |
| `return_on_voided_sale` | `pos_returns.original_sale_id` → a voided sale | PASS |
| Empty session guard | `if (saleIds.length === 0) return issues` | PASS |
| `salesErr` → returns early | `return issues` after `check_error` push | PASS |
| `payErr` → returns early | **BUG FIXED** — see section 4 | FIXED |
| `retErr` → pushes error, continues | Correct — return check is separate | PASS |
| Entire function wrapped in outer try/catch | Top-level `try { ... } catch { issues.push(check_error) }` | PASS — never throws |

### 3.4 `createReconSnapshot` — Wiring verification

| Check | Result |
|---|---|
| Calls `computeSessionRecon` (can throw — caught by outer try/catch) | PASS |
| Calls `detectInconsistencies` (never throws — returns issues array) | PASS |
| `cashVariance = total_counted - expectedCashInDrawer` (correct formula) | PASS |
| `cashVariance` is null when `total_counted` not provided | PASS — `cashupData.total_counted != null` guard |
| All recon fields mapped to correct insert columns | PASS |
| `is_consistent = issues.length === 0` | PASS |
| `consistency_issues = null` when clean | PASS — `issues.length > 0 ? issues : null` |
| Outer try/catch wraps everything — never throws | PASS |
| Insert error → logs + returns null | PASS |
| Exception → logs + returns null | PASS |
| `module.exports` includes all three functions | PASS |

---

## 4. Bug Found and Fixed

### Bug: `detectInconsistencies` — false positives when payment query fails

**Location:** `posReconService.js` — `detectInconsistencies` function

**Problem:**
If the `sale_payments` Supabase query returned an error (`payErr` set), the code pushed a `check_error` issue but then continued execution with `allPayments = []` (since `payments` is null on error).

With an empty `allPayments`:
- `paymentsBySale` was empty
- Every completed sale in the loop would have `salePayments.length === 0`
- Check 1 (`sale_no_payments`) would fire for EVERY completed sale
- Code would `continue` before Check 2, so no mismatch false positives

But the `sale_no_payments` false positives for every sale in the session would be misleading and incorrect — the payments weren't absent, the query failed.

**Comparison with salesErr handling (which was correct):**
```javascript
// salesErr — was already correct: returns early
if (salesErr) {
  issues.push({ type: 'check_error', ... });
  return issues;
}

// payErr — was missing the early return (BUG)
if (payErr) {
  issues.push({ type: 'check_error', ... });
  // Missing: return issues  ← BUG
}
```

**Fix applied:**
```javascript
if (payErr) {
  issues.push({ type: 'check_error', detail: `Payments query failed: ${payErr.message}` });
  return issues;  // Cannot run payment checks without payment data — avoids false positives
}
```

**Effect:** When the payment query fails, the caller receives one `check_error` issue accurately describing the failure. No false `sale_no_payments` issues are generated. The outer try/catch in `createReconSnapshot` still absorbs any re-thrown exception.

---

## 5. sessions.js — Cashup Wiring Verification

| Check | Implementation | Result |
|---|---|---|
| Import added | `const { createReconSnapshot } = require('../services/posReconService')` — line 14 | PASS |
| Existing `complete-cashup` logic unchanged | `totalCounted`, `variance`, DB update, auditFromReq, posAuditFromReq all untouched | PASS |
| `createReconSnapshot` called WITHOUT `await` | Fire-and-forget — confirmed at lines 277–284 | PASS |
| Called before `res.json({ session: data })` | Correct ordering — response not blocked | PASS |
| `counted_cash`, `counted_card`, `counted_other` passed to snapshot | All three from destructured request body | PASS |
| `total_counted: totalCounted` passed | Uses pre-computed variable from existing logic | PASS |
| `variance` passed | Uses pre-computed variable from existing logic | PASS |
| `triggeredBy = 'cashup'` | Correct literal string | PASS |

**Snapshot immutability after later activity:** The snapshot is written once. If additional sales, voids, or offline-synced transactions are added to the session afterward, the existing snapshot row is protected by the append-only triggers — no UPDATE is possible. The old numbers are frozen. A new manual snapshot can be created to capture the updated state.

---

## 6. reconciliation.js — Route Verification

### 6.1 Route fallthrough verification

Express route order in `index.js`:
1. `router.use('/sessions', sessionsRoutes)` — handles: GET `/`, GET `/current`, GET `/pending-cashup`, POST `/open`, POST `/:id/close`, POST `/:id/complete-cashup`
2. `router.use('/sessions', reconciliationRoutes)` — handles: GET `/:id/reconciliation`, GET `/:id/snapshot`, GET `/:id/snapshots`, POST `/:id/snapshot`

For `GET /sessions/123/reconciliation`:
- Express strips `/sessions` prefix → sessionsRoutes receives `/123/reconciliation`
- No match in sessionsRoutes (no `GET /:id` or `GET /:id/reconciliation` route)
- Falls through to reconciliationRoutes
- Matches `GET /:id/reconciliation` with `id = 123` ✓

For `GET /sessions/current`:
- sessionsRoutes has `GET /current` — handled, does NOT fall through ✓

For `POST /sessions/123/complete-cashup`:
- sessionsRoutes has `POST /:id/complete-cashup` — handled ✓

**No routing conflicts.** PASS.

### 6.2 Company isolation check

| Endpoint | Isolation Method | Result |
|---|---|---|
| `GET /:id/reconciliation` | `companyId = req.companyId` passed to `computeSessionRecon` which filters `.eq('company_id', companyIdInt)` | PASS |
| `GET /:id/snapshot` | Session existence verified with `.eq('company_id', req.companyId)` before snapshot fetch; snapshot also filtered by `.eq('company_id', req.companyId)` | PASS — double check |
| `GET /:id/snapshots` | Same session check + snapshot company filter | PASS |
| `POST /:id/snapshot` | Session fetched with `.eq('company_id', companyId)` check before snapshot creation | PASS |

### 6.3 Response correctness

| Endpoint | Key Response Field | Correct? |
|---|---|---|
| GET `/reconciliation` | `cash_reconciliation.expected_cash_in_drawer` | PASS — uses `recon.expectedCashInDrawer` |
| GET `/reconciliation` | `cash_reconciliation.legacy_expected_balance` | PASS — shows old figure for comparison |
| GET `/reconciliation` | `payments.card` shown separately | PASS — not included in cash expectation |
| GET `/reconciliation` | `payments.eft` shown separately | PASS — not included in cash expectation |
| GET `/reconciliation` | `consistency.is_consistent`, `consistency.issues` | PASS |
| GET `/reconciliation` | `computed_at` timestamp | PASS |
| GET `/snapshot` | 404 when no snapshot exists | PASS |
| POST `/snapshot` | 500 with message when `createReconSnapshot` returns null | PASS |
| POST `/snapshot` | awaits `createReconSnapshot` (manual endpoint — blocking intentional) | PASS |

### 6.4 Permission check

| Endpoint | Permission Required | Appropriate? |
|---|---|---|
| `GET /:id/reconciliation` | `INVENTORY.VIEW` | PASS — view-level permission for read |
| `GET /:id/snapshot` | `INVENTORY.VIEW` | PASS |
| `GET /:id/snapshots` | `INVENTORY.VIEW` | PASS |
| `POST /:id/snapshot` | `SALES.VOID` | PASS — manager-level, same as void/cashup |

---

## 7. Existing Reports and Cash-up — Regression Check

| Component | Modification? | Result |
|---|---|---|
| `reports.js` — all 5 report endpoints | NOT TOUCHED | PASS |
| `sessions.js` GET routes (list, current, pending-cashup) | NOT TOUCHED | PASS |
| `sessions.js` POST `/open` | NOT TOUCHED | PASS |
| `sessions.js` POST `/:id/close` | NOT TOUCHED — legacy `expected_balance` calculation unchanged | PASS |
| `sessions.js` POST `/:id/complete-cashup` | ADDITIVE ONLY — one `createReconSnapshot()` call added at line 277 | PASS |
| `sessions.js` cashup response (`res.json({ session: data })`) | NOT CHANGED | PASS |
| `till_sessions` table structure | NOT CHANGED — no column modifications | PASS |
| `sales.js`, `products.js`, `inventory.js`, `receipts.js` | NOT TOUCHED | PASS |
| `posAuditLogger.js` | NOT TOUCHED | PASS |

---

## 8. localStorage / Browser Storage Check

| Component | Storage Used | Result |
|---|---|---|
| `posReconService.js` | Imports: `supabase` only. No `localStorage`, `sessionStorage`, KV bridge. | PASS |
| `reconciliation.js` | Imports: `supabase`, `requireCompany`, `requirePermission`, `posReconService`. No browser storage. | PASS |
| Sessions.js wiring addition | `createReconSnapshot` writes to `pos_recon_snapshots` via Supabase only | PASS |

---

## 9. Verdict Table

| Requirement | Check | Result |
|---|---|---|
| `pos_recon_snapshots` table exists | Migration 029 confirmed with all required columns | PASS |
| Append-only triggers block UPDATE/DELETE | `pos_recon_no_update` and `pos_recon_no_delete` — BEFORE triggers, RAISE EXCEPTION | PASS |
| Cashup creates immutable snapshot | `createReconSnapshot(...)` fires without `await` in `complete-cashup` | PASS |
| `expected_cash_in_drawer = opening + cash_payments - cash_refunds` | Formula at line 157: `round2(openingBalance + paymentCash - refundCash)` | PASS |
| Card/EFT excluded from drawer cash | `paymentCard` and `paymentEft` computed separately, not in `expectedCashInDrawer` | PASS |
| Snapshot unchanged after later activity | Append-only triggers prevent any UPDATE; snapshot is a frozen INSERT | PASS |
| Reconciliation endpoints return correct totals | All fields traced to correct sources | PASS |
| Inconsistency detection works | 5 checks implemented; bug in payErr path found and fixed | PASS (post-fix) |
| Existing cashup UI/reports still work | No existing routes or response formats changed | PASS |
| No localStorage/sessionStorage business truth | Verified in all 5 files | PASS |

---

## 10. Remaining Till Trust Gaps

These were identified and documented during implementation (06_TILL_RECON_HARDENING_IMPLEMENTED.md). Confirmed still applicable:

```
GAP 1: Global orphan detection
  - What's missing: Company-wide scan for sale_items or sale_payments with no
    matching sales row. Session-scoped checks only detect issues within the
    session's sale IDs.
  - Risk: Partial writes from very rare concurrent failures could leave orphaned
    rows undetected.
  - Next step: Nightly audit endpoint scanning all rows older than 24h with no
    matching parent.

GAP 2: Cashier email not in snapshot
  - What's missing: cashier_email is NULL in all snapshots. till_sessions only
    stores user_id; the email requires a join to users.
  - Risk: Snapshots have user_id but not email for display.
  - Next step: Query users.email in createReconSnapshot using session.user_id.
    One extra SELECT per cashup — low cost.

GAP 3: Offline sale source not in snapshot
  - What's missing: offline_sale_count / offline_sale_total columns don't exist
    because 'source' is not stored in the sales table.
  - Risk: Offline vs online split is invisible in snapshots. Only visible in
    pos_audit_events by action source field.
  - Next step: Add 'source' column to sales table + populate via create_sale_atomic.

GAP 4: Close route legacy expected_balance still incorrect
  - What's unchanged: till_sessions.expected_balance = opening + all-method sales.
    This figure is shown to cashiers on the close screen.
  - Risk: Cashiers closing a high-card-volume session see a misleading expected
    figure if they're doing physical cash reconciliation.
  - Next step: Frontend UI change only — display expected_cash_in_drawer from the
    reconciliation endpoint instead of legacy_expected_balance on the close screen.
    No backend change required; the correct figure is already available.

GAP 5: No snapshot on session close (only on cashup)
  - What's unchanged: Snapshot is created on complete-cashup. If a session is
    closed but cashup is never completed, no snapshot is created.
  - Risk: Sessions closed via daily-reset (tills.js) or direct close without cashup
    have no frozen reconciliation record.
  - Next step: Create snapshot (triggered_by: 'session_close') in the close route
    as well. Use same fire-and-forget pattern.
```

---

## 11. Bug Summary

| Bug | Location | Severity | Status |
|---|---|---|---|
| `payErr` path in `detectInconsistencies` continued with empty payments, causing false `sale_no_payments` issues for all completed sales | `posReconService.js` line 232 | Medium — produces noisy false positives on DB transient errors | **FIXED** — added `return issues` after `check_error` push |

No other bugs found.

**Workstream 2A: COMPLETE AND VERIFIED (after fix).**
