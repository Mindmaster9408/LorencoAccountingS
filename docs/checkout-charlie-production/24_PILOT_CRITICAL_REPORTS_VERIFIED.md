# 24 — PILOT-CRITICAL REPORTS VERIFIED
## Checkout Charlie — Workstream 6C Code Audit

**Date:** 2026-05-21
**Status:** ✅ Pilot-safe — 1 low-severity gap, 2 known limitations
**Files Audited:**
- `accounting-ecosystem/backend/modules/pos/routes/reports.js`
- `accounting-ecosystem/frontend-pos/index.html` (render functions + data flow)

---

## Audit Method

Full code read of every pilot-critical route and every corresponding frontend render function. No running server was required — all findings are from source code inspection.

---

## Checklist Results

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | Till Summary uses `pos_recon_snapshots` first | ✅ PASS | Both tables queried in parallel; snapshot wins per session |
| 2 | Till Summary marks `has_snapshot` true/false on every row | ✅ PASS | Every row has `has_snapshot: true/false`; frontend shows `(est.)` badge on fallback rows |
| 3 | Summary totals do not mix snapshot and fallback estimates | ✅ PASS | `const snapped = sessions.filter(s => s.has_snapshot)` — all totals computed only from `snapped` |
| 4 | Split payments use `sale_payments`, not `sales.payment_method` | ✅ PASS | Snapshot columns `payment_cash/card/eft` sourced from `pos_recon_snapshots`; fallback returns `null` (never derived from `sales.payment_method`) |
| 5 | Negative Stock shows current live negative products | ✅ PASS | `products WHERE stock_quantity < 0` — live query, not historical |
| 6 | Negative Stock includes company policy state | ✅ PASS | `company_settings.allow_negative_stock_sales` queried; returned as `stock_policy` object |
| 7 | Recovery report uses real POS_EVENTS constants only | ✅ PASS | All 7 event types match canonical constants in `posAuditLogger.js` |
| 8 | Recovery unresolved count is accurate | ⚠ GAP | `OFFLINE_CONFLICT` events omitted from `unresolved_count` — see Bug 1 below |
| 9 | Audit Activity excludes `SALE_CREATED` noise by default | ✅ PASS | `MANAGER_AUDIT_TYPES` (13 types) does not include `SALE_CREATED`, `LOGIN_SUCCESS`, `RECEIPT_PRINTED` |
| 10 | Cashier Performance has correct average transaction | ✅ PASS | `avg_transaction = total_revenue / completed_sales`, rounded to 2 dp, null-safe |
| 11 | Voids/refunds do not corrupt totals | ✅ PASS | `total_revenue` incremented only inside `status === 'completed'`; voids and refunds counted separately |
| 12 | Reports have safe limits and date filters | ✅ PASS | All routes date-bounded; row limits enforced (see detail below) |
| 13 | No localStorage/sessionStorage business truth added | ✅ PASS | All report data fetched from API per request; render functions receive data as parameters; no localStorage read/write in report path |

---

## Detailed Findings Per Route

### Till Summary — `GET /api/reports/till-summary`

**Data flow verified:**
- Both `till_sessions` and `pos_recon_snapshots` queried in parallel via `Promise.all` (line 277)
- Snapshot query date-bounded by `session_opened_at` (matches the session's `opened_at` — same concept) ✅
- Deduplication: snapshots ordered `DESC` by `id`; first hit per `till_session_id` wins → latest snapshot per session ✅
- `has_snapshot: true` returned for sessions with a matched snapshot (line 321) ✅
- `has_snapshot: false` returned for open or not-yet-cashed-up sessions (line 350) ✅
- Fallback payment columns explicitly `null` (lines 360–365) — not guessed from `sales.payment_method` ✅
- Summary totals: `fn()` reducer operates on `sessions.filter(s => s.has_snapshot)` only (line 377–393) ✅
- Frontend warning banner shown when `snapshotted_sessions < total_sessions` (line 6445–6449) ✅
- Footer footnote: "Payment breakdown sourced from `sale_payments`" (line 6536) ✅

**Trust:** HIGH for cashed-up sessions. MEDIUM (estimate) for open/pending sessions — correctly labelled.

---

### Negative Stock — `GET /api/reports/negative-stock`

**Data flow verified:**
- Three parallel queries: live negative products, audit events in period, company policy (lines 416–442) ✅
- `products WHERE stock_quantity < 0` — live state (line 422) ✅
- Policy sourced from `company_settings.allow_negative_stock_sales` via `maybeSingle()` (lines 437–441) ✅
- `went_negative_at` populated from `NEGATIVE_STOCK_CREATED` events in the *same period* (lines 452–459) — limitation documented below
- Frontend: Policy banner rendered first, colour-coded by policy state ✅
- Frontend: `went_negative_at = null` shown as "Not recorded in period" (line 6574) — not blank, not broken ✅

**Known limitation (documented in doc 23):** If a product went negative before the selected date window, `went_negative_at` will be `null`. This is honest — the event exists in the audit log but falls outside the filter. Not a bug.

---

### Recovery / Sync Health — `GET /api/reports/recovery-sync`

**Data flow verified:**
- Recovery event types: `RECOVERY_RETRY_TRIGGERED`, `RECOVERY_MARKED_FAILED`, `RECOVERY_NOTE_ADDED`, `SUPERVISOR_OVERRIDE_GRANTED`, `ABANDONED_SESSION_DETECTED` — all match `POS_EVENTS` in `posAuditLogger.js` ✅
- Sync event types: `OFFLINE_SYNC_RECEIVED`, `OFFLINE_CONFLICT` — both match `POS_EVENTS` ✅
- Stale sessions: `status=open AND opened_at <= now()-8h` — live state, always current (line 533) ✅
- Pending cashup: `status=closed AND closing_balance IS NULL` — correct signal for sessions not yet cashed up (line 542) ✅
- `age_hours` computed in the response mapper (line 570) ✅
- Frontend: all 7 stat cards rendered; recovery + sync events merged and re-sorted newest-first (line 6676) ✅

**Bug 1 found:** `unresolved_count` computation (lines 560–563):

```javascript
unresolved_count:
    staleSessions.length +
    pendingCashup.length +
    recoveryEvents.filter(e => e.action_type === 'RECOVERY_MARKED_FAILED').length,
```

`OFFLINE_CONFLICT` events are counted in `summary.offline_conflicts` but NOT added to `unresolved_count`. A manager seeing `unresolved_count: 0` could miss active conflicts.

**Severity:** LOW. The `Offline Conflicts` stat card is visible separately. Offline conflicts also often self-resolve on next sync. Not blocking for pilot, but the count is technically understated.

---

### Audit Activity — `GET /api/reports/audit-activity`

**Data flow verified:**
- `MANAGER_AUDIT_TYPES` array (lines 584–598) contains exactly 13 event types ✅
- `SALE_CREATED` is absent ✅ (confirmed by reading all 13 entries)
- `LOGIN_SUCCESS`, `RECEIPT_PRINTED` absent ✅
- Default filter path: `.in('action_type', MANAGER_AUDIT_TYPES)` (line 629) ✅
- `?action_type=X` bypasses default filter intentionally (explicit override by manager) ✅
- `?category=X` filters by `action_category` column ✅
- Hard 500-row limit with `truncated: true` signal (line 644) ✅
- Frontend: truncation warning banner shown when `truncated` is set (lines 6719–6723) ✅
- `by_type` frequency map computed server-side and shown as badge strip in frontend ✅

---

### Cashier Performance — `GET /api/reports/cashier-performance`

**Data flow verified:**
- `total_revenue` accumulated only inside `if (sale.status === 'completed')` (line 159–161) ✅
- `voided_sales` counted separately inside `else if (sale.status === 'voided')` (line 162–163) — never added to revenue ✅
- `avg_transaction = Math.round((total_revenue / completed_sales) * 100) / 100` (lines 183–185) ✅
- Guard: returns `0` when `completed_sales === 0` — no NaN or Infinity ✅
- Refunds (`SALE_RETURNED`) counted from audit events, separately from sales totals ✅
- Three parallel queries; all date-bounded ✅

**Minor gap (not a bug):** Cashiers who opened sessions but made zero sales in the period are not included in the report. The `cashierMap` is built from the `sales` query; if a cashier has no sales in the window, they have no entry. This is acceptable for a pilot — zero-sales cashiers are not operationally interesting.

---

## Row Limits and Date Filter Summary

| Route | Limit | Date Filter Boundary |
|---|---|---|
| `till-summary` | Unbounded (always small per company/period) | `opened_at` on sessions; `session_opened_at` on snapshots |
| `negative-stock` (events) | 250 rows | `created_at` on audit events |
| `negative-stock` (products) | Unbounded — intentional (live negative set is always small) | None (live state) |
| `recovery-sync` (events) | 200 each (recovery + sync) | `created_at` |
| `recovery-sync` (stale sessions) | Unbounded — intentional (managers must resolve these) | `opened_at <= now()-8h` (live) |
| `recovery-sync` (pending cashup) | 50 rows | None (live state) |
| `audit-activity` | 500 rows, `truncated` flag on hit | `created_at` |
| `cashier-performance` | Unbounded — small (one row per cashier) | `created_at` / `opened_at` per table |

All limits are appropriate for pilot scale.

---

## localStorage / sessionStorage Check

**Result: CLEAN ✅**

The entire report data path in `frontend-pos/index.html`:

```
showReport(type) → loadCurrentReport() → fetch(API_URL/reports/{type}) → renderReport(type, result) → renderXReport(data, container)
```

No localStorage reads or writes occur in this path. Data enters via `fetch()` response and exits via `container.innerHTML`. All localStorage accesses in the file are auth tokens only (`token`, `user`, `company`, `isSuperAdmin`, `sso_source`).

---

## Bugs Found

### Bug 1 — `unresolved_count` omits `OFFLINE_CONFLICT` events

| Field | Value |
|---|---|
| Route | `GET /api/reports/recovery-sync` |
| File | `backend/modules/pos/routes/reports.js` line 560–563 |
| Severity | LOW |
| Pilot-blocking | No |

**Current:**
```javascript
unresolved_count:
    staleSessions.length +
    pendingCashup.length +
    recoveryEvents.filter(e => e.action_type === 'RECOVERY_MARKED_FAILED').length,
```

**Impact:** If there are offline conflicts, `unresolved_count` understates by that number. The `offline_conflicts` stat card still displays the correct count — the bug is only in the aggregate `unresolved_count` field.

**Fix (one line):**
```javascript
unresolved_count:
    staleSessions.length +
    pendingCashup.length +
    recoveryEvents.filter(e => e.action_type === 'RECOVERY_MARKED_FAILED').length +
    syncEvents.filter(e => e.action_type === 'OFFLINE_CONFLICT').length,
```

**Decision for pilot:** Acceptable to leave as-is. The stat cards give the correct breakdown. Only the aggregate is slightly understated.

---

## Known Limitations (Not Bugs)

| Limitation | Route | Doc Reference |
|---|---|---|
| `went_negative_at` is null for products that went negative before the selected period | `negative-stock` | Documented in doc 23 — frontend shows "Not recorded in period" |
| Cashiers with zero sales in period do not appear in cashier performance | `cashier-performance` | Acceptable — zero-sales cashiers are not operationally relevant |
| `till-summary` fallback `expected_cash_in_drawer` uses `sess.expected_balance` | `till-summary` | Low-trust for non-snapshotted sessions — already marked `has_snapshot: false` |
| `sales-summary` (old analytics route) still uses `sales.payment_method` | `sales-summary` | Not a pilot-critical report; not changed; correctly out-of-scope |

---

## Remaining Report Gaps (Deferred — Not Pilot-Critical)

These sidebar items are wired but return 404 or stubs. They are out of scope for the pilot and correctly deferred.

| Report | Endpoint | Blocker |
|---|---|---|
| Gross Profit | `/api/reports/gross-profit` | Cost price data quality not validated |
| Gross Profit by Person | `/api/reports/gross-profit-by-person` | Same |
| Gross Profit by Product | `/api/reports/gross-profit-by-product` | Same |
| Sales Daily Summary | `/api/reports/daily-summary` | Covered by dashboard + till summary |
| Sales Audit Trail | `/api/reports/audit-trail` | Covered by audit-activity |
| Forensic Audit Log | Custom | Covered by audit-activity + recon endpoint |
| Payment Methods | Custom | Covered by till summary payment breakdown |
| Suspicious Activity | `/api/audit/suspicious-activity` | Returns stub — rule set not defined |
| VAT Detail | `/api/reports/vat-detail` | Finance sign-off required |
| VAT Summary | `/api/reports/vat-summary` | Finance sign-off required |
| Inventory Sync | `/api/reports/inventory-sync` | Integration not live |
| Accounting Sync | `/api/reports/accounting-sync` | Integration not live |

---

## Pilot-Safe Assessment

**The 5 pilot-critical reports are pilot-safe.**

| Report | Pilot-Safe? | Confidence |
|---|---|---|
| Till Summary | ✅ Yes | HIGH — snapshot-first, correctly labelled, no payment_method corruption |
| Negative Stock | ✅ Yes | HIGH — live product state, policy visible, honest null for pre-period events |
| Recovery / Sync Health | ✅ Yes (minor gap) | HIGH — correct event types, live session state, `unresolved_count` slightly understates when offline conflicts exist |
| Audit Activity | ✅ Yes | HIGH — noise excluded, truncation warned, category/type filters work |
| Cashier Performance | ✅ Yes | HIGH — revenue void-safe, avg_transaction correct, parallel queries |

**One bug to fix post-pilot or before if offline sync conflicts are frequent in the deployment environment:** `unresolved_count` in recovery-sync should include `OFFLINE_CONFLICT` events.

**No localStorage violations found.**
