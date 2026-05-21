# 23 — PILOT-CRITICAL REPORTS IMPLEMENTED
## Checkout Charlie — Workstream 6C: Operational Reports

**Date:** 2026-05-21
**Status:** ✅ Implemented
**Files Modified:**
- `accounting-ecosystem/backend/modules/pos/routes/reports.js`
- `accounting-ecosystem/frontend-pos/index.html`

---

## Objective

Build the minimum operational reporting layer required for a 6-month real-world pilot. Reports must support till trust, cashier accountability, cash-up trust, stock visibility, and manager operational control.

These reports do NOT require analytics or BI. They require correctness.

---

## Reports Implemented

### 1. Till Summary — `GET /api/reports/till-summary`

**Trust level: HIGH ✅ (where snapshot exists) / MEDIUM ⚠ (fallback)**

**Data sources:**
- `pos_recon_snapshots` — primary authoritative source for cashed-up sessions
- `till_sessions` — fallback for open/not-yet-cashed-up sessions
- `sale_payments` — payment method breakdown is sourced from this table via the recon snapshot (NOT `sales.payment_method`)

**What it returns per session:**
- Cashier name, till name/number, status, opened/closed timestamps
- `has_snapshot` flag — distinguishes authoritative from estimated rows
- `sale_count`, `gross_sales`, `void_count`, `void_total`, `discount_total`, `vat_total`
- Payment breakdown: `payment_cash`, `payment_card`, `payment_eft`, `payment_account`, `payment_other`
- Refund totals: `refund_count`, `refund_total`
- `net_sales`, `expected_cash_in_drawer` (forensically correct: opening + cash payments − cash refunds)
- `counted_cash`, `total_counted`, `cash_variance`
- `is_consistent` flag + `consistency_issue_count` from snapshot's consistency check

**Summary totals** (aggregate from snapshotted sessions only — not mixed with fallback estimates):
- `total_sale_count`, `total_gross_sales`, `total_void_count`, `total_refunds`, `total_net_sales`
- `total_cash`, `total_card`, `total_eft`
- `inconsistent_sessions`, `sessions_with_variance`

**Performance safeguards:**
- Both queries (sessions + snapshots) are date-bounded using `opened_at` / `session_opened_at`
- Snapshot deduplication done client-side (latest by `id` per `till_session_id`)
- Parallel query execution via `Promise.all`

**Trust note:** Rows without snapshots (open sessions or sessions not yet cashed up) are flagged with `has_snapshot: false` and show `—` for payment breakdown. This is honest — no split-payment data is available without a snapshot.

---

### 2. Cashier Performance — `GET /api/reports/cashier-performance`

**Trust level: HIGH ✅**

**Data sources:**
- `sales` — completed/voided totals (void corruption excluded: voided sales never added to `total_revenue`)
- `pos_audit_events` — refunds, negative stock events, overrides, recovery events
- `till_sessions` — session count per cashier

**What it returns per cashier:**
- `completed_sales`, `voided_sales`, `total_revenue`
- `avg_transaction` = `total_revenue / completed_sales` (null-safe — returns 0 if no completed sales)
- `sessions_worked` (till sessions opened in period)
- `refunds_processed` (SALE_RETURNED events)
- `negative_stock_allowed` (NEGATIVE_STOCK_SALE_ALLOWED events)
- `manager_overrides` (MANAGER_OVERRIDE + SUPERVISOR_OVERRIDE_GRANTED events)
- `recovery_events` (RECOVERY_RETRY_TRIGGERED events)

**Void safety:** `total_revenue` is computed from `completed` sales only. Voided sales are counted separately (`voided_sales`) and never corrupt revenue totals.

**Performance safeguards:**
- Three parallel queries via `Promise.all`
- Date-bounded queries on all three tables

---

### 3. Negative Stock — `GET /api/reports/negative-stock`

**Trust level: HIGH ✅**

**Data sources:**
- `products` — live stock state (`stock_quantity < 0`) — Part A
- `pos_audit_events` — `NEGATIVE_STOCK_CREATED` and `NEGATIVE_STOCK_SALE_ALLOWED` events in period — Part B
- `company_settings` — `allow_negative_stock_sales` stock policy flag — Part C

**What it returns:**
- `stock_policy.allow_negative_stock_sales` — current company policy state
- `currently_negative` — all products with `stock_quantity < 0`, most negative first
  - Each product enriched with `went_negative_at` (most recent `NEGATIVE_STOCK_CREATED` event) from audit log
- `currently_negative_count`
- `events_in_period` — audit log of negative stock events in the selected date range (newest first)
- `events_in_period_count`

**"When they went negative" limitation:** Populated only if a `NEGATIVE_STOCK_CREATED` event exists for that product in the period. For products that went negative before the selected period, `went_negative_at` will be null. This is honest — the data exists in the audit log but falls outside the filter window.

**Performance safeguards:**
- Three parallel queries via `Promise.all`
- `events_in_period` limited to 250 rows
- Products query is unbounded (active products < 0 is always a small set)

---

### 4. Recovery / Sync Health — `GET /api/reports/recovery-sync`

**Trust level: HIGH ✅**

**Data sources:**
- `till_sessions` — stale open sessions (status=open, opened >8h ago) — live state, always current
- `till_sessions` — pending cashup sessions (status=closed, closing_balance null) — live state
- `pos_audit_events` — recovery action events in period: `RECOVERY_RETRY_TRIGGERED`, `RECOVERY_MARKED_FAILED`, `RECOVERY_NOTE_ADDED`, `SUPERVISOR_OVERRIDE_GRANTED`, `ABANDONED_SESSION_DETECTED`
- `pos_audit_events` — sync events in period: `OFFLINE_SYNC_RECEIVED`, `OFFLINE_CONFLICT`

**What it returns:**
- `summary` — `stale_open_sessions`, `pending_cashup_sessions`, `recovery_retries`, `abandoned_items`, `supervisor_overrides`, `offline_syncs_received`, `offline_conflicts`, `unresolved_count`
- `stale_sessions` — list of sessions open > 8h with `age_hours`
- `pending_cashup_sessions` — closed sessions awaiting cashup
- `recovery_events` — recovery audit events in period (newest first)
- `sync_events` — offline sync/conflict events in period (newest first)

**Architecture note:** The offline queue itself lives in client IndexedDB and cannot be queried from the backend. Recovery visibility is derived from audit events written when managers trigger actions on the queue (retry, abandon, note). This is by design — the queue is client-side; the audit trail is server-authoritative.

**Previous bug fixed:** Prior implementation used `RECOVERY_SUCCESS`, `RECOVERY_FAILED`, `OFFLINE_SALE_SYNCED`, `SYNC_CONFLICT` — none of which exist in `POS_EVENTS`. Those queries returned empty results. Replaced with the actual canonical event type constants from `posAuditLogger.js`.

**Performance safeguards:**
- Four parallel queries via `Promise.all`
- Stale sessions: unbounded but always small (managers must resolve these anyway)
- Pending cashup: limited to 50 rows
- Recovery/sync events: limited to 200 rows each

---

### 5. Audit Activity — `GET /api/reports/audit-activity`

**Trust level: HIGH ✅**

**Data sources:**
- `pos_audit_events` — manager-relevant event types, newest first

**Manager-relevant event types (default filter):**
```
SALE_VOIDED, SALE_RETURNED,
MANAGER_OVERRIDE, SUPERVISOR_OVERRIDE_GRANTED,
STOCK_ADJUSTED, NEGATIVE_STOCK_CREATED, NEGATIVE_STOCK_SALE_ALLOWED,
TILL_CLOSED, CASHUP_COMPLETED, CASH_VARIANCE_RECORDED,
RECOVERY_RETRY_TRIGGERED, RECOVERY_MARKED_FAILED,
ABANDONED_SESSION_DETECTED
```

High-volume noise excluded by default: `SALE_CREATED`, `LOGIN_SUCCESS`, `RECEIPT_PRINTED`, etc.

**Optional query parameters:**
- `?action_type=SALE_VOIDED` — filter to one specific event type
- `?category=override` — filter to an `action_category` value

**What it returns:**
- `events` — newest first, limit 500
- `by_type` — frequency map per `action_type`
- `truncated: true` when 500-row limit was hit (user prompted to narrow date range)

**Performance safeguards:**
- Hard limit of 500 rows
- `action_type` and `action_category` are indexed columns (indexed by migration 028)
- Date-bounded by `created_at`

---

## Sidebar Navigation Added

Section: **Operational** (under Integrations in the Reports sidebar)
- Till Summary → `showReport('till-summary')`
- Negative Stock Events → `showReport('negative-stock')`
- Recovery Sync Log → `showReport('recovery-sync')`
- Audit Activity → `showReport('audit-activity')`

---

## Previous Bugs Fixed in This Workstream

| Bug | Impact | Fix |
|---|---|---|
| `recovery-sync` used non-existent event types | Always returned empty results | Replaced with canonical `POS_EVENTS` constants |
| `negative-stock` only showed past events | Did not show products currently below zero | Added `products WHERE stock_quantity < 0` query |
| `till-summary` ignored recon snapshots | Payment breakdown missing; used wrong expected cash field | Reads `pos_recon_snapshots` first; falls back gracefully |
| `till-summary` used `sales.payment_method` | Split payments reported incorrectly | Snapshot uses `sale_payments` via `posReconService` |
| `cashier-performance` had no avg transaction | Could not assess cashier efficiency | Added `avg_transaction` computed from `total_revenue / completed_sales` |
| `audit-activity` fetched all event types | High-volume SALE_CREATED noise; slow query | Default filter restricted to 13 manager-relevant types |

---

## Reports NOT Implemented (Deferred)

These sidebar items exist in the frontend but have no backend route. They return 404 and show an error state. They are not required for the pilot.

| Sidebar Item | Endpoint | Reason Not Built |
|---|---|---|
| Gross Profit | `GET /api/reports/gross-profit` | Requires `cost_price` data quality — not validated |
| Gross Profit by Person | `GET /api/reports/gross-profit-by-person` | Same dependency |
| Gross Profit by Product | `GET /api/reports/gross-profit-by-product` | Same dependency |
| Sales Daily Summary | `GET /api/reports/daily-summary` | Not pilot-critical — covered by dashboard + till summary |
| Sales Audit Trail | `GET /api/reports/audit-trail` | Covered by audit-activity report |
| Forensic Audit Log | Custom endpoint | Covered by audit-activity + reconciliation endpoint |
| Payment Methods | Custom endpoint | Covered by till summary payment breakdown |
| Suspicious Activity | `GET /api/audit/suspicious-activity` | Returns stub — not pilot-critical |
| VAT Detail | `GET /api/reports/vat-detail` | Not pilot-critical for Workstream 6C scope |
| VAT Summary | `GET /api/reports/vat-summary` | Not pilot-critical for Workstream 6C scope |
| Inventory Sync | `GET /api/reports/inventory-sync` | Integration not yet live |
| Accounting Sync | `GET /api/reports/accounting-sync` | Integration not yet live |

---

## Future Reporting Roadmap

| Priority | Report | Dependency |
|---|---|---|
| P1 | Gross Profit (product/person) | Cost price data quality validation |
| P1 | VAT Detail + VAT Summary | Finance team sign-off on VAT method |
| P2 | Sales Daily Summary | Nice-to-have for manager daily standup |
| P2 | Forensic Audit (enhanced) | Extend audit-activity with sale detail drill-down |
| P3 | Accounting Sync | Live accounting integration required |
| P3 | Inventory Sync | Live inventory integration required |
| P3 | Suspicious Activity (real) | Define rule set (X voids/hour, price overrides > Y%, etc.) |

---

## Test Checklist

- [ ] **Split payments reported correctly** — Till Summary payment breakdown reads from `pos_recon_snapshots.payment_cash/card/eft`, which is computed from `sale_payments`. Verify with a test sale using split payment (R50 cash + R50 card).
- [ ] **Till totals match recon snapshots** — Till Summary should show identical figures to the reconciliation screen for cashed-up sessions.
- [ ] **Negative stock report accurate** — Create a product with qty 0, make a sale (policy must allow negative). Product should appear in `currently_negative` immediately.
- [ ] **Cashier report excludes void corruption** — Void a sale. Verify `voided_sales` increments but `total_revenue` and `avg_transaction` are unchanged.
- [ ] **Recovery report shows unresolved items** — Leave a session open for 8h+ or close without cashup. Should appear in stale/pending sections.
- [ ] **Audit feed newest-first** — Most recent event at the top.
- [ ] **Reports load at pilot scale** — Date range of 1 month with ~500 sales should respond in < 3s.
- [ ] **No localStorage/sessionStorage business data** — All report data fetched from API. No business data written to browser storage.
