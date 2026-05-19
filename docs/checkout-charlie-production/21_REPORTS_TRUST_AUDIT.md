# 21 — REPORTS TRUST AUDIT
## Checkout Charlie — Workstream 6A: Pilot Readiness Audit

**Date:** 2026-05-12
**Audit method:** Full code read — reports.js, sessions.js, reconciliation.js, posReconService.js, recovery.js, frontend index.html (all report functions, cash-up flow, dashboard JS)
**Auditor note:** No code was changed. This is observation-only. All findings are recommendations for the next workstream.

---

## Summary

| Category | Count |
|---|---|
| Pilot-safe reports (accurate, working) | 7 |
| Reports with accuracy issues (need correction) | 3 |
| Critical bugs blocking pilot trust | 3 |
| Reports not implemented (stub or 404) | 12 |
| localStorage/sessionStorage business truth violations | 0 |

**Pilot verdict:** Core cash-up flow is trustworthy. Dashboard, pending cashup, and split-payment reporting have blocking bugs. 12 sidebar reports are unimplemented stubs. Do not rely on any report beyond the confirmed-safe set without fixing the issues documented here.

---

## Reports Inventory

### Reports with a working backend

| Report | Endpoint | Frontend trigger |
|---|---|---|
| Sales Summary | `GET /api/reports/sales-summary` | Not exposed in sidebar (backend only) |
| Top Products | `GET /api/reports/top-products` | Not exposed in sidebar |
| Cashier Performance | `GET /api/reports/cashier-performance` | Not exposed in sidebar |
| Inventory Value | `GET /api/reports/inventory-value` | Not exposed in sidebar |
| Dashboard | `GET /api/analytics/dashboard` | Dashboard tab → `loadDashboard()` |
| Session List | `GET /api/pos/sessions` | Implicit (Cash Up tab loads current session) |
| Live Reconciliation | `GET /api/pos/sessions/:id/reconciliation` | Cash Up tab → `loadCashUpSession()` |
| Recon Snapshot | `GET /api/pos/sessions/:id/snapshot` | Management only, no direct UI button |
| Session Health | `GET /api/pos/recovery/sessions` | Recovery tab → `loadRecovery()` |
| Pending Cashups | `GET /api/pos/sessions/pending-cashup` | Cash Up tab → `loadPendingCashups()` |

### Sidebar reports (12 items) — backend status

| Sidebar label | Call | Backend status |
|---|---|---|
| Gross Profit | `GET /api/reports/gross-profit` | ❌ 404 — no such route |
| Gross Profit by Person | `GET /api/reports/gross-profit-by-person` | ❌ 404 |
| Gross Profit by Product | `GET /api/reports/gross-profit-by-product` | ❌ 404 |
| Sales Daily Summary | `GET /api/reports/daily-summary` | ❌ 404 |
| Sales Audit Trail | `GET /api/reports/audit-trail` | ❌ 404 |
| Forensic Audit Log | `GET /api/audit/forensic` | ❌ 404 — no `/forensic` route in audit.js |
| Payment Methods | `GET /api/pos/reports/payment-methods` | ❌ 404 — POS router has no `/reports/` subrouter |
| Suspicious Activity | `GET /api/audit/suspicious-activity` | ⚠️ Returns `{ activities: [] }` stub (wrong field name) |
| VAT Detail | `GET /api/reports/vat-detail` | ❌ 404 |
| VAT Summary | `GET /api/reports/vat-summary` | ❌ 404 |
| Inventory Sync | `GET /api/reports/inventory-sync` | ❌ 404 |
| Accounting Sync | `GET /api/reports/accounting-sync` | ❌ 404 |

All 12 sidebar reports will display an error message or blank state when clicked. No sidebar report is pilot-safe.

---

## Pilot-Safe Reports

These reports are accurate and can be used in pilot without changes.

---

### REPORT-01 — Cash Up (Main Flow)
**Trust level: HIGH ✅**

**Surface:** Cash Up tab → `loadCashUpSession()` → `loadCurrentReport()` (inside cashup)

**Calculation source:**
- Calls `GET /api/pos/sessions/:id/reconciliation` which invokes `posReconService.computeSessionRecon()`
- Payment breakdown comes from `sale_payments` table (not `sales.payment_method`) → split payments handled correctly
- Expected cash = `opening_balance + cash_payments - cash_refunds` (forensically correct)
- Void count shown alongside sale count
- Cash refunds row displayed when refunds > 0

**What it shows:**
- Total Sales (gross, completed only)
- Sale count + void count
- Expected Cash in Drawer (cash-method only, correct)
- Payment breakdown: Cash / Card / EFT / Account (from `sale_payments`)
- Cash refunds (from `pos_returns`)

**Offline sync:** Sale source not shown, but totals are correct regardless of source.

**Fallback:** If reconciliation endpoint fails, falls back to opening balance only with a `console.warn`. Fallback is conservative (shows 0.00 totals), not misleading. Cashier cannot proceed with wrong figures.

**Confirmed correct:** Split payments, refunds, void labelling, expected cash figure. ✅

---

### REPORT-02 — Session Reconciliation (Live)
**Trust level: HIGH ✅**

**Surface:** `GET /api/pos/sessions/:id/reconciliation` — management endpoint

**Calculation source:** `posReconService.computeSessionRecon()` + `detectInconsistencies()`

**What it shows:**
- Sale totals (completed + voided separately)
- Payment breakdown from `sale_payments` (authoritative)
- Refund breakdown from `pos_returns`
- Forensic expected cash vs legacy expected balance (comparison shown)
- Consistency issues (orphan payments, mismatches, duplicates, returns on voided sales)

**Confirmed correct:** Split payments, refunds, forensic vs legacy comparison, consistency checks. ✅

---

### REPORT-03 — Reconciliation Snapshot
**Trust level: HIGH ✅**

**Surface:** `GET /api/pos/sessions/:id/snapshot` — management endpoint

Immutable record created on cashup. Same computation as live reconciliation but frozen at cashup time. Append-only, tamper-proof. ✅

---

### REPORT-04 — Session Health / Recovery View
**Trust level: HIGH ✅**

**Surface:** Recovery tab → `GET /api/pos/recovery/sessions`

Shows open sessions, stale sessions (>8h), and closed-not-cashed-up sessions. No financial calculations — pure session status. Fires `ABANDONED_SESSION_DETECTED` audit event for each stale session found. ✅

---

### REPORT-05 — Top Products
**Trust level: MEDIUM-HIGH ✅ (with noted limitation)**

**Surface:** Backend only — `GET /api/reports/top-products`

**Calculation source:** `sale_items` joined to `sales` — completed sales only (`status = 'completed'`). Aggregates `quantity` and `line_total` per `product_id`.

**Correct:** Only completed sales. Excludes voided.

**Limitation:** Refunds are not subtracted. A product returned after sale still counts in units sold and revenue. For pilot scale with few returns this is acceptable. Document for later fix.

---

### REPORT-06 — Cashier Performance
**Trust level: MEDIUM ✅ (with noted limitation)**

**Surface:** Backend only — `GET /api/reports/cashier-performance`

**Calculation source:** `sales` table — tracks `completed_sales`, `voided_sales`, `total_revenue` per `user_id`.

**Correct:** Separates completed vs voided counts per cashier. Revenue only from completed sales.

**Limitation:** Does not subtract refunds from cashier revenue. If cashier processes a return, their revenue total is not adjusted downward. Acceptable for pilot — flag for later.

---

### REPORT-07 — Inventory Value
**Trust level: HIGH ✅**

**Surface:** Backend only — `GET /api/reports/inventory-value`

**Calculation source:** `products` table — active products only (`is_active = true`). Computes `stock_quantity × cost_price` (cost value) and `stock_quantity × unit_price` (retail value).

**Correct:** Active products only. Consistent with `idx_products_company_active`. ✅

---

## Reports with Accuracy Issues (Need Correction Before Pilot)

---

### ISSUE-01 — Dashboard KPIs Show All Zeros
**Risk: HIGH — misleads managers at a glance**

**Surface:** Dashboard tab → `loadDashboard()` reads from `GET /api/analytics/dashboard`

**The bug:** The frontend reads field names that don't exist in the API response.

Backend response (`GET /api/analytics/dashboard`):
```json
{
  "today": {
    "sales_count": 42,
    "revenue": 15000.00,
    "voided": 2
  },
  "low_stock_count": 5
}
```

Frontend reads (`loadDashboard()`, lines 7818–7824):
```javascript
t.net_sales          // undefined → "R 0.00"
t.transaction_count  // undefined → "0 transactions"
t.gross_profit       // undefined → "R 0.00"
t.avg_transaction_value // undefined → "R 0.00"
t.avg_basket_size    // undefined → "0 items avg"
```

**Effect:** Every KPI card on the Dashboard shows zeros. A manager opening the dashboard sees no meaningful data.

**Also:** `loadDashboard()` calls `/api/loss-prevention/alerts` — server.js stubs this as `res.json({ alerts: [] })` permanently. Dashboard alerts section always shows "No active alerts."

**Fix required:** Either align the frontend field names to match the backend, or extend the backend to return the additional fields. Both the field names and the missing fields (`gross_profit`, `avg_transaction_value`, `avg_basket_size`) need to be resolved.

---

### ISSUE-02 — Sales Summary and Audit Trail: Wrong Payment Method for Split Sales
**Risk: MEDIUM — incorrect payment breakdown in management reports**

**Surface:** `GET /api/reports/sales-summary` → `payment_breakdown` field; `GET /api/reports/audit-trail` → `sale.payment_method` column

**The bug:** Both reports read from `sales.payment_method` — a single-value column that stores only the primary payment method at sale creation time.

```javascript
// reports.js sales-summary, line 50-54
const method = s.payment_method || 'cash';
acc[method] = (acc[method] || 0) + parseFloat(s.total_amount || 0);
```

```javascript
// frontend renderAuditTrailReport, line 6163
<td>${sale.payment_method}</td>
```

**Effect for split-payment sales:** A split sale of R1,000 (R600 cash + R400 card) is attributed entirely to whichever method was first in the `payments` array. The cash total is overstated; card total understated. The audit trail shows "CASH" for this sale, not "SPLIT".

**The correct source is `sale_payments`** — this is what the cash-up reconciliation already uses. The reports need to join `sale_payments` for the payment breakdown.

**Impact:** Any sales-summary report used by an owner to understand "how much was paid by card this month" will be wrong if any split-payment sales occurred.

---

### ISSUE-03 — Pending Cashup: Wrong Expected Figure + Silent Data Corruption
**Risk: HIGH — wrong variance stored in DB, broken UX**

**Surface:** Cash Up tab → Pending Cashups section → `showPendingCashupModal()` → `completePendingCashup()`

**Two separate bugs:**

**Bug A — Wrong expected figure shown to user:**
```javascript
// index.html line 4314
Expected: R ${parseFloat(session.expected_balance || 0).toFixed(2)}
```
`session.expected_balance` is the legacy figure from `till_sessions`: `opening_balance + all_completed_sales_total`. This is an all-methods total. A cashier counting only cash drawer cash is being compared to a figure that includes card payments. This will show a consistent short every time card payments exist.

The correct figure is `expected_cash_in_drawer` from `posReconService`. The main cashup flow correctly uses this — pending cashup does not.

**Bug B — Payload mismatch corrupts stored closing_balance:**
```javascript
// completePendingCashup sends:
body: JSON.stringify({ closing_balance: closingBalance, notes: notes })

// complete-cashup endpoint reads:
const { counted_cash, counted_card, counted_other, notes } = req.body;
const totalCounted = (counted_cash || 0) + (counted_card || 0) + (counted_other || 0);
```

`closing_balance` from the frontend is ignored. `counted_cash` is `undefined → 0`. Result:
- `closing_balance` stored in DB = 0
- `variance` stored = `0 - session.expected_balance` = large negative number
- The reconciliation snapshot created will show wrong figures

**Bug C — Success notification never fires:**
```javascript
const result = await response.json();
if (result.success) {   // result = { session: data }, not { success: true }
    showNotification(`Cashup completed. Variance: R ${result.variance.toFixed(2)}`, 'success');
} else {
    showNotification(result.error || 'Failed to complete cashup', 'error');  // always fires
}
```

The endpoint returns `{ session: data }`. `result.success` is falsy. The cashier always sees "Failed to complete cashup" even when the session was successfully updated. `result.variance` is also undefined, which would throw a TypeError before the success message anyway.

**Combined effect:** Pending cashup sessions get corrupted data in the DB, the cashier thinks it failed, and the manager sees wrong reconciliation figures.

---

## Critical Bugs Summary Table

| Bug | Location | Impact | Severity |
|---|---|---|---|
| Dashboard KPI field name mismatch | `loadDashboard()` vs dashboard endpoint | All KPIs show zeros | HIGH |
| Pending cashup payload mismatch | `completePendingCashup()` vs complete-cashup endpoint | closing_balance=0, variance wrong | HIGH |
| Pending cashup success check broken | `completePendingCashup()` result.success | Always shows "Failed" UX | HIGH |
| Split-payment reports use wrong column | `reports.js` + audit trail render | Payment breakdown wrong for split sales | MEDIUM |
| Pending cashup expected figure wrong | `showPendingCashupModal` uses expected_balance | Misleads cashier on variance | MEDIUM |

---

## Report-by-Report: Trust Level and Risk

| Report | Surface | Trust | Source | Voids handled | Refunds | Split payments | Offline visible |
|---|---|---|---|---|---|---|---|
| Cash Up (main) | Cash Up tab | ✅ HIGH | sale_payments | ✅ counted | ✅ deducted | ✅ correct | ❌ not shown |
| Live Recon | API only | ✅ HIGH | sale_payments | ✅ | ✅ | ✅ | ❌ |
| Recon Snapshot | API only | ✅ HIGH | sale_payments | ✅ | ✅ | ✅ | ❌ |
| Session Health | Recovery tab | ✅ HIGH | till_sessions | N/A | N/A | N/A | N/A |
| Top Products | API only | ✅ MEDIUM | sale_items | ✅ excluded | ❌ not deducted | ✅ | ❌ |
| Cashier Performance | API only | ✅ MEDIUM | sales | ✅ separated | ❌ not deducted | ✅ (revenue) | ❌ |
| Inventory Value | API only | ✅ HIGH | products | N/A | N/A | N/A | N/A |
| Dashboard KPIs | Dashboard tab | ❌ BROKEN | analytics/dashboard | N/A | N/A | N/A | N/A |
| Sales Summary (API) | API only | ⚠️ PARTIAL | sales.payment_method | ✅ | ❌ | ❌ split wrong | ❌ |
| Pending Cashup | Cash Up tab | ❌ BROKEN | session.expected_balance | N/A | ❌ | ❌ | ❌ |
| Gross Profit | Sidebar | ❌ 404 | - | - | - | - | - |
| Gross Profit by Person | Sidebar | ❌ 404 | - | - | - | - | - |
| Gross Profit by Product | Sidebar | ❌ 404 | - | - | - | - | - |
| Daily Summary | Sidebar | ❌ 404 | - | - | - | - | - |
| Sales Audit Trail | Sidebar | ❌ 404 | - | - | - | - | - |
| Forensic Audit Log | Sidebar | ❌ 404 | - | - | - | - | - |
| Payment Methods | Sidebar | ❌ 404 | - | - | - | - | - |
| Suspicious Activity | Sidebar | ⚠️ STUB | Empty stub | - | - | - | - |
| VAT Detail | Sidebar | ❌ 404 | - | - | - | - | - |
| VAT Summary | Sidebar | ❌ 404 | - | - | - | - | - |
| Inventory Sync | Sidebar | ❌ 404 | - | - | - | - | - |
| Accounting Sync | Sidebar | ❌ 404 | - | - | - | - | - |

---

## Specific Checks Requested

### Reports using `till_sessions.expected_balance`
- **Pending Cashup modal (`showPendingCashupModal`)** — uses `session.expected_balance` as the comparison figure. RISK: this is opening + all-methods sales, not cash-only. Misleads cashiers counting only the cash drawer.
- **Session close endpoint** — stores `expected_balance` computed as `opening + all_completed_sales`. This legacy figure is retained in the session record. The correct figure (`expected_cash_in_drawer`) exists only in the recon snapshot.
- **Pending cashup list UI** — shows `session.expected_balance` as "Expected" without qualification. A manager reviewing pending cashups sees the all-methods figure, not cash-only.

### Reports using `sales.payment_method` instead of `sale_payments`
- **`GET /api/reports/sales-summary`** — `payment_breakdown` field computed from `sales.payment_method`. Wrong for split-payment sales.
- **Sales Audit Trail frontend render** — column `sale.payment_method` shown as "Payment" column. Shows primary method only.
- **`GET /api/reports/cashier-performance`** — does not use payment_method at all (only revenue totals). Not affected.
- **Cash Up** — uses `sale_payments` correctly. Not affected.

### Reports excluding/including voids incorrectly
- **`GET /api/reports/sales-summary`** — correctly separates completed vs voided. Both are fetched, filtered in-app. Voided totals surfaced in `voided_count` and `voided_amount`. ✅
- **`GET /api/reports/cashier-performance`** — correctly counts `voided_sales` separately from `completed_sales` per cashier. ✅
- **`GET /api/reports/top-products`** — explicitly filters `sales.status = 'completed'` in the join. Voided sales excluded. ✅
- **Dashboard** — fetches all sales since midnight, filters completed in-app. Voided count also surfaced. ✅ (broken by field name mismatch, but logic is correct)

### Reports ignoring refunds
- **All reports except cash-up and live reconciliation** — no report joins `pos_returns`. Refunded sales count as revenue, refunded items count as sold units. Specifically:
  - Top Products: refunded product units still count in total_qty
  - Cashier Performance: cashier revenue includes sales that were later returned
  - Sales Summary: revenue total includes sales later returned
  - Dashboard revenue: includes returned sales
- **Cash Up (main)** — correctly deducts refunds. ✅
- **Reconciliation** — correctly computes refund totals. ✅

### Reports ignoring offline_sync/source
- No report filters by or displays `sales.source` ('online' vs 'offline_sync').
- A manager cannot distinguish between real-time sales and replayed offline sales in any report.
- Offline sales that fail to sync never appear in any report. No report surfaces unsynced queue length.
- The offline banner and Recovery tab show queue state, but no financial report shows offline-vs-online breakdown.

### Reports that can mislead a manager
1. **Dashboard KPIs** — shows R 0.00 for all revenue figures. Manager concludes no sales happened even when they did.
2. **Pending Cashup** — shows wrong expected amount and wrong variance. Manager sees "Failed" on success.
3. **Sales Summary payment breakdown** — split-payment sales inflated in cash, under-reported in card. Manager makes incorrect cash-handling decisions.
4. **Suspicious Activity** — always shows "No Suspicious Activity Detected" even when suspicious events occurred (stub endpoint + field name mismatch). Manager has false sense of security.
5. **Loss Prevention Alerts** — always shows "No active alerts" (permanent stub in server.js line 267). Same false-security problem.

---

## Performance Concerns at Pilot Scale

These are all pre-existing issues documented for completeness — indexes from migration 033 have already addressed the DB-level performance. The remaining concerns are application-level aggregation patterns.

| Report | Pattern | Risk |
|---|---|---|
| Top Products | Fetches all matching `sale_items` rows, aggregates in JS | Medium at 1000+ daily sales |
| Sales Summary | Fetches all sales in period, filters in JS | Low at pilot scale |
| Cashier Performance | Fetches all sales in period, aggregates by user in JS | Low at pilot scale |
| Inventory low-stock | Fetches all active products, filters in JS | Low (< 1000 SKUs at pilot) |

No performance concerns block pilot launch.

---

## No localStorage/sessionStorage Business Truth ✅ CONFIRMED

All POS frontend `localStorage` writes verified:

| Key | Category | Verdict |
|---|---|---|
| `token` | JWT auth | ✅ Permitted |
| `user` | Auth identity | ✅ Permitted |
| `company` | SSO handoff | ✅ Permitted |
| `isSuperAdmin` | Auth flag | ✅ Permitted |
| `sso_source` | SSO routing | ✅ Permitted |

No business data (sale amounts, payment totals, stock levels, variance figures, customer records) in localStorage or sessionStorage. ✅

`companyStockPolicy` in-memory only:
```javascript
// index.html line 3226-3229
// Never read from localStorage; always sourced from the API on each login.
let companyStockPolicy = { allowNegativeStock: false };
```
✅ Compliant.

IndexedDB is used for: product catalog cache (offline), customer cache (offline), offline sales queue, session state. All of these are operational caches for offline-first functionality, not business truth. The DB remains the source of truth for all financial records. ✅

---

## Recommended Fix Order

### Before pilot launch (blocking)

| Priority | Fix | Effort | Risk |
|---|---|---|---|
| P1 | Fix pending cashup payload: change `closing_balance` to `counted_cash` in `completePendingCashup()` | Low | Low |
| P1 | Fix pending cashup success check: check `result.session` not `result.success` | Low | Low |
| P1 | Fix pending cashup expected figure: call reconciliation endpoint instead of using `session.expected_balance` | Medium | Low |
| P2 | Fix dashboard KPI field names: align `loadDashboard()` to use `revenue`, `sales_count`, `voided` from API — or extend API to return the missing fields | Low-Medium | Low |

### Shortly after pilot starts (high-value fixes)

| Priority | Fix | Effort |
|---|---|---|
| P3 | Fix sales-summary payment breakdown to use `sale_payments` instead of `sales.payment_method` | Medium |
| P3 | Fix audit trail `payment_method` column to show split breakdown from `sale_payments` | Medium |
| P4 | Add refund deductions to top-products and cashier performance | Medium |

### Future workstream (non-blocking)

| Fix | Notes |
|---|---|
| Implement missing sidebar reports (Gross Profit, VAT, Daily Summary, etc.) | Large scope — separate workstream |
| Implement forensic audit log endpoint (`/api/audit/forensic`) | Audit.js has the infra, needs the route |
| Implement payment methods report backend | Needs `sale_payments` GROUP BY |
| Add `sales.source` visibility to reports | Offline vs online breakdown |
| Add refund-aware revenue across all reports | Needs `pos_returns` join |
| Add gross profit calculation (needs cost_price) | Requires cost_price data quality |
| Implement Loss Prevention Alerts | Large feature scope |
| Replace app-side aggregation with DB GROUP BY | Performance headroom before needed |

---

## Appendix: Backend Routes Confirmed Missing

The following API paths return 404 (not stubbed, not implemented):

```
GET /api/reports/gross-profit
GET /api/reports/gross-profit-by-person
GET /api/reports/gross-profit-by-product
GET /api/reports/daily-summary
GET /api/reports/audit-trail
GET /api/reports/vat-detail
GET /api/reports/vat-summary
GET /api/reports/inventory-sync
GET /api/reports/accounting-sync
GET /api/audit/forensic
GET /api/pos/reports/payment-methods
```

The following return empty stubs that will never show data:
```
GET /api/audit/suspicious-activity  → { activities: [] }  (frontend reads .alerts)
GET /api/loss-prevention/alerts     → { alerts: [] }       (permanent stub)
```
