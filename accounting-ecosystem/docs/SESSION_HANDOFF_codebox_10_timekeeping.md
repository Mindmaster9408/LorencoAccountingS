# SESSION HANDOFF — Codebox 10: Timekeeping + Billing Readiness Foundation

**Date:** 2026-06-19
**Status:** Code complete — migration 061 must be applied before using billing fields

---

## What Was Changed

### `backend/config/migrations/061_practice_time_billing_readiness.sql` — NEW
14 new columns added to `practice_time_entries`:
- `workflow_run_id` BIGINT FK (links to practice_workflow_runs)
- `time_type` TEXT NOT NULL DEFAULT 'billable' (billable/non_billable/internal/admin)
- `standard_rate`, `override_rate`, `effective_rate` NUMERIC(12,2)
- `recoverable_value`, `billed_value`, `writeoff_value` NUMERIC(12,2)
- `billing_status` TEXT NOT NULL DEFAULT 'unbilled'
- `submitted_for_review_at`, `approved_at` TIMESTAMPTZ
- `approved_by` INTEGER
- `billing_notes`, `internal_notes` TEXT
- 6 new performance indexes

Existing columns kept intact: `billable` (boolean), `rate` (NUMERIC 10,2)

### `backend/modules/practice/index.js` — ENHANCED (time entries section replaced)

New helpers added:
- `computeTimeRates(hours, standardRate, overrideRate, legacyRate)` — returns effectiveRate, recoverableValue
- `deriveTimeType(timeType, billable)` — converts old billable boolean to new time_type
- `verifyClientBelongsToCompany(companyId, clientId)` — ownership check
- `verifyTaskBelongsToCompany(companyId, taskId)` — ownership check
- `verifyWorkflowRunBelongsToCompany(companyId, runId)` — ownership check

`GET /time-entries` enhanced:
- Added pagination (`page`, `limit`, Supabase `count: 'exact'` + `.range()`)
- Added filters: `billing_status`, `time_type`, `workflow_run_id`
- Returns `total` count in response

`GET /time-entries/wip` — NEW
- Aggregates billable time by billing_status
- Filters: client_id, user_id, workflow_run_id, date_from, date_to
- Returns by_status breakdown + total_unbilled_hours + total_recoverable

`GET /time-entries/summary` — NEW
- Returns billable/non-billable/internal/admin hours, total, utilization_pct, recoverable_value
- Filters: client_id, user_id, date_from, date_to

`POST /time-entries` enhanced:
- Accepts: workflow_run_id, time_type, standard_rate, override_rate, billing_notes, internal_notes
- Validates client/task/workflow_run belong to req.companyId
- Auto-calculates effective_rate (override ?? legacy rate ?? standard)
- Auto-calculates recoverable_value (hours × effective_rate, billable only)
- Sets billable boolean from time_type for backward compat
- Sets rate (legacy field) = effective_rate for backward compat
- Audit logs: time_entry_created

`PUT /time-entries/:id` enhanced:
- Fetches current entry first to validate ownership and billing_status
- Blocks edits if billing_status is 'billed' or 'written_off'
- Validates time_type if supplied
- Recalculates effective_rate and recoverable_value if hours/rates change
- Keeps billable and rate (legacy) in sync
- Audit logs: time_entry_updated

`DELETE /time-entries/:id` enhanced:
- Fetches current entry first
- Blocks deletion if billing_status is 'billed' or 'written_off'

`PUT /time-entries/:id/submit-review` — NEW
- Requires billing_status in ['unbilled', 'rejected']
- Sets billing_status → 'pending_review', submitted_for_review_at → NOW()
- Audit logs: time_submitted_review

`PUT /time-entries/:id/approve` — NEW
- Requires billing_status = 'pending_review'
- Sets billing_status → 'approved', approved_at → NOW(), approved_by → req.user.userId
- Audit logs: time_approved

`PUT /time-entries/:id/reject` — NEW
- Requires `reason` in body
- Allows rejection from 'pending_review' or 'approved'
- Sets billing_status → 'rejected', billing_notes → reason
- Audit logs: time_rejected

### `backend/frontend-practice/time.html` — REWRITTEN
- All inline JS (368 lines) extracted to `js/time.js`
- WIP Dashboard: 4 stat cards (unbilled hours, pending hours+value, approved hours+value, total recoverable)
- Log form: added time_type, workflow_run, standard_rate, override_rate, billing_notes
- Added live rate calculator (effective rate + recoverable value display)
- Added billing_status filter in filter bar
- Table: 10 columns (added Type, Recoverable, Billing Status)
- Added Reject modal with required reason field
- All `display:none` replaced with `.hidden` class
- All filter selects have `aria-label` for accessibility

### `backend/frontend-practice/js/time.js` — NEW
Complete time tracking page logic including:
- `loadWorkflowsForClient()` — loads workflow runs for selected client
- `updateRateCalc()` / `updateEditCalc()` — live rate preview
- `loadWip()` — WIP dashboard data
- `loadEntries()` — with billing_status + time_type filters
- `renderEntries()` — billing/time-type badges + contextual action buttons
- `buildEntryActions(e)` — renders Submit/Approve/Reject per billing_status
- `submitForReview()`, `approveEntry()`, `openRejectModal()`, `submitReject()`

### `backend/frontend-practice/css/practice.css` — ENHANCED
- `.badge-billing-*` — 6 billing status badge variants
- `.badge-time-*` — 4 time type badge variants
- `.time-entry-actions` — flex row for action buttons
- `.modal-lg` — max-width: 620px

---

## What Was NOT Changed
- `workflows.html`, `deadlines.html`, `clients.html` — unchanged
- `tasks.html`, `js/tasks.js` — unchanged
- Payroll module — not touched
- Auth middleware — not touched
- `rate` and `billable` columns on `practice_time_entries` — preserved (backward compat)

---

## Audit Findings

### localStorage — CLEAN
Only `localStorage.getItem('token')` in old inline JS for auth check — replaced by `AUTH.requireAuth()` in new `js/time.js`. No business data in browser storage.

### Multi-tenant safety — VERIFIED
- All time entry routes: `req.companyId` from JWT
- POST/PUT: client, task, and workflow_run verified against company before write
- `approved_by` stored from `req.user.userId` (never from frontend body)

### Existing data protection
- Existing `rate` and `billable` columns kept in sync on all writes
- `billing_status` defaults to 'unbilled' — all existing entries are safe
- `time_type` defaults to 'billable' — existing billable entries default correctly

---

## Testing Steps

1. **Apply migration 061** in Supabase SQL editor. Run the verification query in the codebox doc.

2. **Log billable entry:**
   - Set time_type = Billable, add standard_rate = 1500, hours = 2
   - Confirm effective_rate preview = R1500/hr, recoverable = R3000
   - Submit — confirm entry appears with `billing_status = unbilled`

3. **Log non-billable entry:**
   - Set time_type = Non-Billable
   - Confirm rate calculator hidden
   - Confirm no recoverable_value in DB

4. **Review flow:**
   - Submit for review → confirm billing_status = pending_review
   - Approve → confirm billing_status = approved, approved_by set
   - Reject (from pending_review) → confirm rejection reason required, billing_notes set

5. **WIP dashboard:**
   - After creating entries in various statuses, confirm WIP cards update correctly
   - Total Recoverable should exclude billed/written_off

6. **Edit protection:**
   - Manually set billing_status = 'billed' in DB
   - Try to edit → confirm 400 error received

7. **Multi-tenant isolation:**
   - Log entry for company A, confirm not visible for company B

---

## Remaining Risks / Follow-ups

- `billed_value` and `writeoff_value` columns exist but no write path yet — will be set by Codebox 11 (WIP management)
- Workflow run select in time log form requires `GET /api/practice/workflows/runs` to be available — verify this route exists
- No bulk-approve UI yet — approvals are per-entry only
- `approved_by` stores user_id but there's no display-name join yet in list view
