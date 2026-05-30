# Dashboard — Pilot Action Queue Implementation Report

**Date:** 2026-05-28
**Module:** Accounting Dashboard (`dashboard.js`, `dashboard.html`)
**Status:** COMPLETE ✅

---

## 1. Summary

Added a "Pilot Action Queue" panel to the accounting app dashboard. The panel shows a prioritised list of items requiring attention for the selected company — unallocated bank transactions, open reconciliation sessions, overdue AR/AP invoices, unfinalized historical and opening-balance batches, recent audit errors, and blocked finalize attempts.

The implementation is **read-only throughout**: no posting logic, no bank allocation, no VAT calculations, no period locking, and no report calculations were modified. All queries are count-only SELECTs.

---

## 2. Files Changed

| File | Change |
|------|--------|
| `backend/modules/accounting/middleware/auth.js` | Added `dashboard.view` permission key (all four Lorenco roles) |
| `backend/modules/accounting/routes/dashboard.js` | New — `GET /action-queue` endpoint with `safeCount` helper and `buildActionQueueItems` pure function |
| `backend/modules/accounting/index.js` | Mounted `router.use('/dashboard', require('./routes/dashboard'))` |
| `frontend-accounting/dashboard.html` | Added action queue CSS, HTML panel, and `loadActionQueue()` JS function |
| `backend/tests/dashboard-action-queue.test.js` | New — 10 unit tests |

**Files NOT changed:**

- All posting logic — untouched
- Bank allocation logic — untouched
- VAT calculation logic — untouched
- Report calculation logic — untouched
- AR/AP business logic — untouched
- Period locking — untouched
- All payroll files — untouched

---

## 3. Endpoint

```
GET /api/accounting/dashboard/action-queue
```

**Auth:** `authenticate` + `hasPermission('dashboard.view')` — available to all four Lorenco roles (admin, accountant, bookkeeper, viewer).

**Response shape:**

```json
{
  "companyId": 5,
  "generatedAt": "2026-05-28T10:00:00.000Z",
  "items": [
    {
      "id": "bank-unmatched",
      "severity": "high",
      "title": "24 unmatched bank transactions",
      "description": "Transactions need to be allocated before reconciliation.",
      "count": 24,
      "link": "/accounting/bank.html"
    }
  ],
  "summary": {
    "criticalCount": 0,
    "highCount": 1,
    "warningCount": 3,
    "infoCount": 2,
    "totalActionable": 4
  }
}
```

Only items requiring action are included in `items` (zero-count items are omitted). `totalActionable` counts critical + high + warning only (info is excluded as it is non-urgent).

---

## 4. Action Items

| ID | Severity | Condition | Link |
|----|----------|-----------|------|
| `bank-unmatched` | `high` | `bank_transactions.status = 'unmatched'` count > 0 | `bank.html` |
| `bank-matched-unrecon` | `warning` | `bank_transactions.status = 'matched'` count > 0 | `bank-reconciliation.html` |
| `bank-recon-open` | `high` | `bank_recon_sessions.difference <> 0` count > 0 | `bank-reconciliation.html` |
| `ar-overdue` | `high` | `customer_invoices` past due, not paid/void/cancelled | `aged-debtors.html` |
| `ar-draft` | `warning` | `customer_invoices.status = 'draft'` count > 0 | `aged-debtors.html` |
| `ap-overdue` | `high` | `supplier_invoices` past due, not paid/void/cancelled | `aged-creditors.html` |
| `ap-draft` | `warning` | `supplier_invoices.status = 'draft'` count > 0 | `aged-creditors.html` |
| `historical-draft` | `info` | `historical_comparative_batches.status IN ('draft','validated')` | `historical-comparatives.html` |
| `opening-draft` | `info` | `opening_balance_batches.status IN ('draft','validated')` | `opening-balances.html` |
| `audit-errors` | `critical` | `accounting_audit_log.action_type = 'SYSTEM_ERROR'` last 7 days | `audit-trail.html` |
| `historical-blocked` | `warning` | `historical_comparative_audit_log.action = 'FINALIZED_EDIT_BLOCKED'` last 7 days | `historical-comparatives.html` |
| `vat-open` | `warning` | `vat_returns` not filed/cancelled (graceful fallback) | `vat-return.html` |

---

## 5. Failure Handling

Each query is executed independently inside `safeCount()`, which wraps `db.query()` in a `try/catch`. A failing query never crashes the endpoint — it returns `{ ok: false, count: null }`. The `buildActionQueueItems` function converts a failed result into a degraded item:

```json
{
  "id": "bank-unmatched",
  "severity": "warning",
  "title": "Unable to check: unmatched bank transactions",
  "description": "Query failed — check server logs.",
  "count": null,
  "link": null
}
```

All 12 queries run in `Promise.all` — no single slow query blocks the others. If the entire endpoint fails (auth error, network issue), `loadActionQueue()` in the frontend catches the error and hides the panel silently. The rest of the dashboard is unaffected.

---

## 6. Frontend Design

- Panel appears at the top of the dashboard, above the stat cards, so actionable items are immediately visible.
- Summary badges (coloured by severity) show counts at a glance.
- Each item has a left-border colour indicating severity (red = critical, orange = high, yellow = warning, blue = info).
- Items link directly to the relevant page via "Open →" button.
- Empty state: "No pending actions — all clear."
- Error state: panel is hidden (non-critical, existing dashboard unaffected).
- `escHtml()` helper escapes all server-sourced strings before DOM insertion (XSS prevention).

---

## 7. Severity Levels

| Level | Colour | Meaning |
|-------|--------|---------|
| `critical` | Red | Immediate investigation required (system errors in audit trail) |
| `high` | Orange | Blocking data integrity or compliance risk |
| `warning` | Yellow/amber | Pending action required, not yet critical |
| `info` | Blue | Non-urgent — informational only |

---

## 8. Architecture Notes

- All queries use the **pg pool** (`db.query()`), not the Supabase JS client, for consistent performance and direct SQL control.
- Every query includes `company_id = $1` — no cross-tenant data risk.
- The `safeCount` helper and `buildActionQueueItems` function are exported on the router object (`router.safeCount`, `router.buildActionQueueItems`) for unit testing without requiring a running server.
- No business data is written to or read from browser storage — the endpoint is a server-side aggregation of existing table state.

---

## 9. New Permission Key

| Key | Allowed Roles |
|-----|---------------|
| `dashboard.view` | `admin`, `accountant`, `bookkeeper`, `viewer` |

The key is validated at startup by `validatePermissionMap()` in `index.js`. An unknown or misconfigured key will cause a startup abort.

---

## 10. Tests

**Test file:** `backend/tests/dashboard-action-queue.test.js`

```
PASS tests/dashboard-action-queue.test.js
  Dashboard — Pilot Action Queue
    TEST-DASH-01: safeCount returns count and ok=true on success
      ✓ count: 24, ok: true
    TEST-DASH-02: safeCount returns ok=false and count=null when the query throws
      ✓ ok: false, count: null, message contains table name
    TEST-DASH-03: safeCount returns 0 when COUNT returns a zero row
      ✓ count: 0, ok: true
    TEST-DASH-04: buildActionQueueItems returns empty array when all counts are zero
      ✓ items = []
    TEST-DASH-05: bank-unmatched is severity "high" with correct count and link
      ✓ severity: high, count: 5, link: /accounting/bank.html
    TEST-DASH-06: bank-matched-unrecon is severity "warning"
      ✓ severity: warning, link: /accounting/bank-reconciliation.html
    TEST-DASH-07: audit-errors is severity "critical"
      ✓ severity: critical, link: /accounting/audit-trail.html
    TEST-DASH-08: historical-draft is severity "info"
      ✓ severity: info, link: /accounting/historical-comparatives.html
    TEST-DASH-09: degraded item returned when a query fails (ok=false)
      ✓ severity: warning, title contains "Unable to check", count: null, link: null
    TEST-DASH-10: summary counts are correct for a mixed result set
      ✓ critical: 1, high: 2, warning: 1, info: 1, totalActionable: 4

Tests: 10 passed, 10 total
```

---

## 11. Final Safety Check

- [x] No posting logic changed
- [x] No bank allocation logic changed
- [x] No VAT calculation logic changed
- [x] No report calculation logic changed
- [x] No AR/AP business logic changed
- [x] No period locking changed
- [x] All queries company-scoped (`company_id = $1`)
- [x] No crash on partial query failure — degraded item returned
- [x] No `localStorage` or `sessionStorage` used for business data
- [x] `escHtml()` applied to all server-sourced strings in DOM insertion
- [x] `dashboard.view` permission key added to PERMISSIONS map and validated at startup
- [x] `authenticate` runs before `hasPermission` — role mapping correct for all ECO roles
- [x] Frontend failure hides panel silently — existing dashboard stat cards and journals unaffected
