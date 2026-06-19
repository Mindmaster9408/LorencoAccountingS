# CODEBOX 10 — TIMEKEEPING + BILLING READINESS FOUNDATION

**App:** Lorenco Practice Management
**Codebox:** 10 of ±80
**Date:** June 2026
**Status:** Complete — migration 061 must be applied in Supabase before using billing fields

---

## 1. Summary

Codebox 10 upgrades time tracking from a simple timesheet into a billing-ready accounting practice time system. Time entries can now carry classification, rates, billing values, and move through a billing approval lifecycle.

**What was built:**
- Migration 061: 14 new columns on `practice_time_entries`
- Enhanced `GET /time-entries` with pagination, billing/type filters, and workflow linkage
- Enhanced `POST /time-entries`: accepts billing fields, auto-calculates effective_rate and recoverable_value, validates client/task/workflow ownership
- Enhanced `PUT /time-entries/:id`: recalculates rates on edit, blocks edits on billed/written_off entries
- Enhanced `DELETE /time-entries/:id`: blocks deletion of billed/written_off entries
- `GET /time-entries/wip`: WIP dashboard data grouped by billing_status
- `GET /time-entries/summary`: utilization reporting (billable %, recoverable value)
- `PUT /time-entries/:id/submit-review`: submit for billing approval
- `PUT /time-entries/:id/approve`: partner approves entry for billing
- `PUT /time-entries/:id/reject`: reject with mandatory reason
- `time.html` rewritten: inline JS extracted to `js/time.js`, new billing fields, WIP dashboard, billing status filter, reject modal
- `js/time.js` created: full time + WIP + billing review logic
- Billing status + time type badges added to `practice.css`
- Audit logging on create, update, submit-review, approve, reject

**What was NOT built (excluded by CLAUDE.md permanent rules):**
- Invoice generation
- Accounting integration
- Sean AI
- Cross-app integrations
- Cron/scheduler automation

---

## 2. Database Changes (migration 061)

### `practice_time_entries` — 14 new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `workflow_run_id` | BIGINT FK | NULL | Link to a workflow run (e.g. VAT return) |
| `time_type` | TEXT NOT NULL | 'billable' | Classification: billable / non_billable / internal / admin |
| `standard_rate` | NUMERIC(12,2) | NULL | Default hourly rate for this engagement |
| `override_rate` | NUMERIC(12,2) | NULL | Per-entry manual rate override |
| `effective_rate` | NUMERIC(12,2) | NULL | Computed: override_rate ?? standard_rate (stored for query perf) |
| `recoverable_value` | NUMERIC(12,2) | NULL | hours × effective_rate (null for non-billable types) |
| `billed_value` | NUMERIC(12,2) | NULL | Amount actually invoiced (set in future invoice engine) |
| `writeoff_value` | NUMERIC(12,2) | NULL | Amount written off (set in future WIP management) |
| `billing_status` | TEXT NOT NULL | 'unbilled' | Billing lifecycle: unbilled → pending_review → approved → billed |
| `submitted_for_review_at` | TIMESTAMPTZ | NULL | When submitted for billing approval |
| `approved_at` | TIMESTAMPTZ | NULL | When approved for billing |
| `approved_by` | INTEGER | NULL | User ID of approving partner |
| `billing_notes` | TEXT | NULL | Billing/invoicing notes; also stores rejection reason on reject |
| `internal_notes` | TEXT | NULL | Internal staff notes, not surfaced in billing |

### Backward compatibility
- Existing `billable` BOOLEAN column preserved — kept in sync with `time_type` on write
- Existing `rate` column preserved — kept in sync with `effective_rate` on write (legacy field)

---

## 3. Rate Calculation Logic

```
effective_rate = override_rate ?? legacy_rate_field ?? standard_rate

recoverable_value = hours × effective_rate
                    (only calculated when time_type = 'billable')
                    (null for non_billable, internal, admin)
```

**On POST (create):**
- If frontend sends `override_rate` → that becomes the override
- If frontend sends old `rate` field only (legacy) → treated as override_rate
- `effective_rate` stored for query performance (avoids CASE expressions in reports)
- `rate` (legacy field) set = effective_rate for backward compatibility with old frontend

**On PUT (edit):**
- If any of `hours`, `standard_rate`, `override_rate` changes → `effective_rate` and `recoverable_value` recalculated automatically
- `billable` boolean kept in sync with `time_type`

---

## 4. Billing Status Lifecycle

```
unbilled
  │
  ├── submit-review → pending_review
  │                      │
  │                      ├── approve  → approved
  │                      │               │
  │                      │               └── [future: invoice engine] → billed
  │                      │
  │                      └── reject   → rejected
  │                                       │
  │                                       └── submit-review → pending_review (cycle)
  │
  └── [future: WIP management] → written_off
```

Only `billable` time type entries can be submitted for review. Internal/admin/non-billable entries stay at `unbilled` permanently (no review flow needed).

**Delete protection:** Entries with `billing_status = 'billed'` or `'written_off'` cannot be deleted or edited.

---

## 5. WIP Dashboard — `GET /time-entries/wip`

Filters: `client_id`, `user_id`, `workflow_run_id`, `date_from`, `date_to`

Only queries `time_type = 'billable'` entries (non-billable time has no WIP value).

Response:
```json
{
  "by_status": {
    "unbilled":       { "hours": 12.5, "recoverable_value": 18750.00 },
    "pending_review": { "hours": 3.0,  "recoverable_value": 4500.00 },
    "approved":       { "hours": 8.0,  "recoverable_value": 12000.00 },
    "rejected":       { "hours": 1.0,  "recoverable_value": 1500.00 },
    "billed":         { "hours": 20.0, "billed_value": 25000.00 },
    "written_off":    { "hours": 0.5,  "writeoff_value": 750.00 }
  },
  "total_unbilled_hours": 16.5,
  "total_recoverable": 36750.00
}
```

`total_recoverable` = unbilled + pending_review + approved recoverable values (what can still be billed).

---

## 6. Summary Report — `GET /time-entries/summary`

Filters: `client_id`, `user_id`, `date_from`, `date_to`

Response:
```json
{
  "billable_hours": 25.5,
  "non_billable_hours": 4.0,
  "internal_hours": 2.5,
  "admin_hours": 1.0,
  "total_hours": 33.0,
  "utilization_pct": 77.3,
  "recoverable_value": 38250.00
}
```

`utilization_pct` = `billable_hours / total_hours × 100` (rounded to 1 decimal). Zero if no hours.

---

## 7. Backend API Reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/practice/time-entries` | List entries — pagination, billing_status, time_type, workflow_run_id filters |
| POST | `/api/practice/time-entries` | Create — accepts all billing fields, auto-calculates rates |
| PUT | `/api/practice/time-entries/:id` | Update — recalculates rates, blocks billed/written_off |
| DELETE | `/api/practice/time-entries/:id` | Delete — blocks billed/written_off |
| GET | `/api/practice/time-entries/wip` | WIP dashboard aggregates |
| GET | `/api/practice/time-entries/summary` | Utilization summary |
| PUT | `/api/practice/time-entries/:id/submit-review` | Submit for billing approval |
| PUT | `/api/practice/time-entries/:id/approve` | Partner approves for billing |
| PUT | `/api/practice/time-entries/:id/reject` | Reject with mandatory reason |

### Multi-tenant safety
- All routes: company ownership enforced via `req.companyId` (JWT — never from body)
- POST/PUT: `client_id`, `task_id`, `workflow_run_id` verified against `req.companyId` before insert/update
- No cross-company data leakage possible

---

## 8. localStorage Audit Result

**Clean.** No business data in browser storage.

- `localStorage.getItem('token')` — auth token read only (permitted by Rule D2)
- `PracticeAPI.fetch()` used for all data operations
- All time entries, rates, billing values: DB-authoritative via API

---

## 9. Frontend Changes

### `time.html` — rewritten
- All inline JS (368 lines) extracted to `js/time.js`
- Added: WIP Dashboard (4 stat cards — unbilled, pending, approved, recoverable)
- Added to log form: time_type select, workflow_run select, standard_rate, override_rate, billing_notes
- Added: live rate calculator (effective rate + recoverable value display)
- Added: billing_status filter in filter bar
- Added: Reject modal (rejection reason required)
- Table columns: Date, Client, Task, Hours, Description, Type, Rate, Recoverable, Billing Status, Actions

### `js/time.js` — new
- `loadWorkflowsForClient()` — loads active workflow runs for selected client
- `updateRateCalc()` — live effective rate + recoverable value preview in log form
- `updateEditCalc()` — same for edit modal
- `loadWip()` — fetches and renders WIP dashboard cards
- `buildEntryActions(e)` — returns contextual action buttons per entry state
- `submitForReview(id)`, `approveEntry(id)`, `openRejectModal(id)`, `submitReject()` — review flow
- `loadEntries()` — includes billing_status and time_type filters
- `renderEntries()` — renders badge-billing-* and badge-time-* badges

### `css/practice.css` — enhanced
- Added: `.badge-billing-*` (6 billing status badges)
- Added: `.badge-time-*` (4 time type badges)
- Added: `.time-entry-actions` (flex row for action buttons)
- Added: `.modal-lg` (max-width: 620px)

---

## 10. Migration Command

Apply migration 061 manually in Supabase SQL editor:

```
File: accounting-ecosystem/backend/config/migrations/061_practice_time_billing_readiness.sql
```

Verify after applying:
```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'practice_time_entries'
  AND column_name IN (
    'workflow_run_id', 'time_type', 'standard_rate', 'override_rate', 'effective_rate',
    'recoverable_value', 'billed_value', 'writeoff_value',
    'billing_status', 'submitted_for_review_at', 'approved_at', 'approved_by',
    'billing_notes', 'internal_notes'
  )
ORDER BY ordinal_position;
```

---

## 11. Recommended Codebox 11

**Client Billing Preparation + WIP Management**

After time is billing-ready, the next codebox can build:
- WIP management UI (view, filter, write-off time)
- Billing pack preparation (group approved time by client for invoicing)
- Write-off workflow (partner writes off irrecoverable time)
- Realization reporting (billed vs recoverable ratio per client/period)
- Fee estimates vs actual time comparison per workflow run
