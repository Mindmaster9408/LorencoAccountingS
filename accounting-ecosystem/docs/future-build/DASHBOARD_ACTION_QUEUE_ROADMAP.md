# Dashboard Action Queue — Future Roadmap

**Date:** 2026-05-28
**Module:** Accounting Dashboard (`dashboard.js`, `dashboard.html`)
**Pilot implementation status:** COMPLETE ✅
**Source:** Codebox — Accounting Dashboard Pilot Action Queue

---

## Overview

The pilot action queue ships 12 read-only count queries that surface the most important pending actions for a company. This document tracks the remaining improvements organised into work phases. Nothing here is urgently blocking — the panel is functional for pilot use.

---

## Phase 3 — Before General Release

### AQ-01 — AR/AP aged-amount totals in the action items

**Current:** AR/AP items show a count of overdue invoices only.
**Improvement:** Include total overdue amount (e.g. "5 overdue AR invoices — R 42,300 outstanding").
**Complexity:** LOW

**Implementation notes:**
- Replace `COUNT(*)` with `COUNT(*), SUM(total_inc_vat - amount_paid) AS overdue_amount` in the AR/AP overdue queries.
- Return `amount` field alongside `count` in the item object.
- Frontend: render `R ${formatCurrency(item.amount)}` in the item title or description.
- Requires confirming column names: `total_inc_vat`, `amount_paid` (already confirmed in audit phase).

---

### AQ-02 — Bank recon session detail (which bank accounts have open sessions)

**Current:** Shows only count of open sessions with a difference.
**Improvement:** List the bank account names with open differences.
**Complexity:** MEDIUM

**Implementation notes:**
- Replace the single COUNT query with a SELECT that returns `bank_account_name, difference` for open sessions.
- Return `accounts: [{name, difference}]` in the item payload.
- Frontend: render as a sub-list under the item description.
- Requires `bank_recon_sessions` to have a `bank_account_name` or a join to `bank_accounts`.

---

### AQ-03 — VAT return period name in the open-VAT item

**Current:** Shows count of open VAT returns.
**Improvement:** Show the tax period(s) that are open (e.g. "Feb 2026 VAT return unfiled").
**Complexity:** LOW

**Implementation notes:**
- Add a SELECT for the earliest open VAT period date alongside the count.
- Return `earliestPeriod` in the item payload.
- Frontend: append period to the description.

---

### AQ-04 — Client-side refresh button

**Current:** Action queue loads once on page load. No way to refresh without a full page reload.
**Improvement:** Add a small "Refresh" link next to the "Pilot Action Queue" heading.
**Complexity:** LOW

**Implementation notes:**
- Add `<button id="actionQueueRefreshBtn" class="action-queue-refresh">↻ Refresh</button>` to the header.
- On click: re-call `loadActionQueue()`.
- Show a spinner or "Refreshing…" text during the fetch.
- CSS: small, ghost-style button.

---

### AQ-05 — Auto-refresh on visibility change

**Current:** Action queue is stale if the accountant leaves the tab and returns.
**Improvement:** Re-fetch when the user returns to the dashboard tab (Page Visibility API).
**Complexity:** LOW

**Implementation notes:**
- Add `document.addEventListener('visibilitychange', () => { if (!document.hidden) loadActionQueue(); })`.
- Debounce: skip re-fetch if last fetch was less than 60 seconds ago.
- Prevents stale counts when the accountant has processed items in another tab.

---

## Phase 4 — Post-Pilot Improvements

### AQ-06 — Dismiss/snooze individual items

**Risk addressed:** High-count items that the accountant is aware of (e.g. a known backlog) create noise.
**Complexity:** MEDIUM

**Implementation notes:**
- Add a `POST /api/accounting/dashboard/action-queue/:id/snooze` endpoint.
- Snoozed items are stored in a new `dashboard_snooze_log` table: `(company_id, item_id, snoozed_until, snoozed_by)`.
- The GET endpoint excludes items where `snoozed_until > NOW()`.
- Frontend: show a "Snooze 24h" link on each item.
- Items re-appear automatically after the snooze expires — no permanent dismissal of real issues.

---

### AQ-07 — Control account reconciliation check

**Current:** No check for AR/AP control account differences.
**Improvement:** Add an item that fires when the AR or AP control account balance in the GL does not match the sum of open invoices.
**Complexity:** HIGH

**Implementation notes:**
- Requires joining `accounts` (control account balance) against `customer_invoices`/`supplier_invoices` open totals.
- Must use the correct AR/AP control account codes from `company` settings (or a known standard COA code).
- Significant query complexity — recommend adding to `diagnosticsService` and calling from the action queue.
- Severity: `critical` if control difference is non-zero.

---

### AQ-08 — PAYE reconciliation open periods

**Current:** No payroll integration.
**Improvement:** Show open PAYE periods (processed but not yet reconciled/submitted).
**Complexity:** MEDIUM

**Implementation notes:**
- Query `paye_reconciliation` table for periods with `status NOT IN ('submitted','closed')`.
- Follow Rule E (Paytime stability lock) — this query is read-only on the payroll tables and does not touch payroll-engine or calculation files. It is a dashboard read only.
- Severity: `warning`.
- Link: `/accounting/paye-reconciliation.html`.

---

### AQ-09 — Unposted bank cash/card POS entries

**Current:** No POS bridge check.
**Improvement:** Show count of POS cash/card reconciliation entries that haven't been posted to the GL.
**Complexity:** LOW

**Implementation notes:**
- Query `pos_reconciliation_entries` (or equivalent POS bridge table) for `status = 'pending'`.
- Severity: `warning`.
- Link: `/accounting/pos-bridge.html` or equivalent.

---

### AQ-10 — Trend badge (delta from yesterday)

**Current:** Snapshot only — no trend context.
**Improvement:** Show whether the action count is better or worse than yesterday.
**Complexity:** MEDIUM

**Implementation notes:**
- Store a daily snapshot of `summary` counts in a new `dashboard_action_queue_snapshots` table: `(company_id, snapshot_date, critical_count, high_count, warning_count)`.
- Write the snapshot once per day (first load after midnight, or a background cron).
- On GET, compare today's counts to yesterday's snapshot and return `trend: { delta, direction: 'up'|'down'|'same' }` in the summary.
- Frontend: show ▲3 / ▼2 / ─ next to the summary badges.

---

## Architectural Notes

### AQ-ARCH-01 — All queries must remain read-only

The action queue endpoint must never write to financial tables. It may write only to:
- `dashboard_snooze_log` (AQ-06, if implemented)
- `dashboard_action_queue_snapshots` (AQ-10, if implemented)

Under no circumstances should the endpoint post journals, change invoice status, or trigger any financial workflow.

### AQ-ARCH-02 — Each query must include `company_id = $1`

The pg pool bypasses Postgres RLS. Any new query added to the action queue must include `AND company_id = $1`. This is an absolute requirement — omitting it exposes cross-tenant data.

### AQ-ARCH-03 — New items must use `safeCount` or equivalent

Any new check added to the action queue must use the `safeCount` wrapper (or an equivalent try/catch boundary). A single new query that throws must never break the entire response.

### AQ-ARCH-04 — `buildActionQueueItems` must stay a pure function

The item-building logic must have no I/O side effects. New items are added by extending the parameter object and adding a new `if (!x.ok) ... else if (x.count > 0)` block. This keeps the function testable without a database.

### AQ-ARCH-05 — `escHtml()` must be applied to all server-sourced string fields

Any new item fields rendered into the DOM must be passed through `escHtml()`. This applies to `title`, `description`, `link`, and any future fields. Counts (integers) are safe without escaping.

---

## Open Questions

1. **AQ-07 (control account recon)** — Which chart of accounts code identifies the AR control account and AP control account in the standard Lorenco COA? Is this stored in a `company` settings column or assumed from a standard code?

2. **AQ-08 (PAYE)** — What is the exact table/column for PAYE period status? Is `paye_reconciliation` the correct table name?

3. **AQ-06 (snooze)** — Should snooze be per-user or per-company? (i.e. if one accountant snoozes a noisy bank item, should it be hidden for all users of that company, or only for that user?)

4. **AQ-10 (trend)** — Should the snapshot be written by the dashboard endpoint on first load, or by a server-side scheduled job? The cron approach is more reliable but requires a scheduler. The endpoint approach is simpler but misses companies that don't load the dashboard on any given day.
