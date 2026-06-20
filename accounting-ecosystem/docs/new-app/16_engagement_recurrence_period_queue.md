# Codebox 16 — Engagement Recurrence Rules + Manual Period Queue

**Date:** 2026-06-20
**Module:** Lorenco Practice Management
**Status:** Complete

---

## Purpose

Codebox 16 closes the loop between client engagements and recurring workflow generation by introducing:

1. **Recurrence Rules** on engagements — defines how a service recurs (monthly, quarterly, annual, once-off, or ad-hoc).
2. **Period Queue** — a manual queue of discrete service periods. Each period row represents one billing/compliance window that needs a workflow generated.

The key design principle is **manual control at every step**:
- Period rows are queued manually by the user (no cron, no background scheduler).
- Workflow generation from a period is triggered manually, one period at a time.
- No automatic invoice generation.
- No SARS tax date calculations.

---

## Recurrence Model

Recurrence is defined on `practice_client_engagements` via new columns:

| Column | Type | Purpose |
|---|---|---|
| `recurrence_type` | TEXT | monthly \| quarterly \| annual \| once_off \| ad_hoc |
| `recurrence_start_date` | DATE | Anchor for period generation |
| `recurrence_end_date` | DATE | Hard stop date |
| `recurrence_day` | INTEGER | Day of month (1–28) periods start on |
| `recurrence_month` | INTEGER | Month (1–12) for annual recurrences |
| `next_period_start/end/due_date` | DATE | Informational hints |
| `recurrence_notes` | TEXT | Free-text override instructions |

### Recurrence type behaviours

| Type | Period structure |
|---|---|
| `monthly` | One period per calendar month. period_start = 1st (or recurrence_day). period_end = last day of month. |
| `quarterly` | Q1 (Jan–Mar), Q2 (Apr–Jun), Q3 (Jul–Sep), Q4 (Oct–Dec). |
| `annual` | One period per calendar year. Respects recurrence_month for fiscal year start. |
| `once_off` | Single period covering the full from_date to to_date range. |
| `ad_hoc` | No automatic preview. User must supply exact dates manually. |

---

## Period Queue Architecture

### Table: `practice_engagement_periods`

| Column | Notes |
|---|---|
| `id` | Primary key |
| `company_id` | Multi-tenant gate |
| `engagement_id` | FK to practice_client_engagements |
| `client_id` | Denormalised for fast filtering |
| `service_id` | FK to practice_service_catalog (optional) |
| `period_label` | Human-readable e.g. "January 2026", "Q1 2026" |
| `period_start` / `period_end` | Inclusive date range |
| `due_date` | Compliance submission deadline (nullable) |
| `anchor_date` | Workflow task offset anchor |
| `status` | queued \| ready \| generated \| skipped \| cancelled |
| `workflow_run_id` | Populated after generate-workflow |
| `deadline_id` | Populated after generate-workflow (if deadline created) |
| `generated_at` / `generated_by` | Traceability |
| `skipped_at` / `skipped_by` / `skip_reason` | Traceability |
| `settings` | JSONB for future extension |

### Status lifecycle

```
queued ──→ ready ──→ generated
  │                     (terminal — workflow exists)
  └──→ skipped
  │       (terminal — user skipped with reason)
  └──→ cancelled
          (terminal — excluded from active queue)
          Note: cancelled periods are excluded from the unique index,
          allowing a period range to be re-queued after cancellation.
```

### Duplicate prevention

A partial unique index prevents duplicate active periods:

```sql
CREATE UNIQUE INDEX idx_uq_ep_engagement_range
  ON practice_engagement_periods(company_id, engagement_id, period_start, period_end)
  WHERE status != 'cancelled';
```

Duplicate detection also happens at the server layer — both in `generate-preview` (shows duplicates) and `generate` (silently skips duplicates, returns counts).

---

## API Endpoints

All endpoints are mounted under `/api/practice/` and require company-scoped JWT.

| Method | Path | Purpose |
|---|---|---|
| GET | `/engagement-periods` | List all periods with filters |
| GET | `/engagement-periods/:id` | Single period detail |
| POST | `/engagements/:id/periods/generate-preview` | Preview what would be created (no DB writes) |
| POST | `/engagements/:id/periods/generate` | Create queued period rows |
| POST | `/engagement-periods/:id/generate-workflow` | Generate workflow from one period |
| PUT | `/engagement-periods/:id/skip` | Skip a period (reason required) |
| PUT | `/engagement-periods/:id/cancel` | Cancel a period |

### generate-preview response

```json
{
  "engagement_id": 42,
  "recurrence_type": "monthly",
  "periods": [{ "period_label": "January 2026", "period_start": "2026-01-01", "period_end": "2026-01-31", "due_date": null, "anchor_date": "2026-01-01" }],
  "duplicates": [],
  "warnings": [],
  "can_create": true
}
```

### generate-workflow from period

Calls `workflowService.createRunAndGenerateTasks()` with `generation_source: 'engagement_period'`. On success, updates period to `generated` with `workflow_run_id` and `deadline_id`.

---

## Manual-Only Rule

**No background scheduler. No cron. No auto-generation. No automatic invoice creation.**

Every action requires an explicit user click:
1. Click "📅 Periods" on an engagement card → opens Generate Periods modal
2. Set date range → Preview → Create Queue → periods queued in DB
3. Go to Period Queue page → click "⚡ Generate" next to a period → workflow generated

---

## Workflow Generation from Period

The existing `workflowService.createRunAndGenerateTasks()` is reused unchanged. The period provides:

- `period_start`, `period_end` — passed as-is to the workflow run
- `anchor_date` (or `period_start` fallback) — used as the task due-date anchor
- `due_date` — passed to the deadline creation logic (or uses template offset)

The engagement must:
1. Be `active`
2. Have a `workflow_template_id` set

The workflow template drives everything else (task steps, deadline creation, compliance area, etc.).

---

## Multi-Tenant Safety

Every route enforces:
- `req.companyId` from JWT (never from request body)
- `engagement.company_id === req.companyId`
- `period.company_id === req.companyId`
- `client.company_id === req.companyId`

No cross-company data can be accessed.

---

## localStorage / KV Audit

**Finding:** Clean. No business data in localStorage or KV store.

Existing uses are all permitted:
- `localStorage.getItem('token')` / `localStorage.getItem('practice_token')` → auth tokens only (Rule D2 permitted)
- `localStorage.getItem('company')` → layout badge company name display only (not business data)

No period queue state is written to any browser storage. All state is server-side.

---

## Frontend Files

| File | Purpose |
|---|---|
| `frontend-practice/engagement-periods.html` | Period Queue page |
| `frontend-practice/js/engagement-periods.js` | Period Queue page JS |
| `frontend-practice/js/client-detail.js` | Enhanced: Generate Periods modal + buttons on engagement cards |
| `frontend-practice/js/layout.js` | Enhanced: Period Queue nav tab added |
| `frontend-practice/client-detail.html` | Enhanced: Generate Periods modal HTML |

---

## Audit Logging

All operations log to `practice_client_engagement_events`:

| Event type | When |
|---|---|
| `engagement_periods_previewed` | POST generate-preview |
| `engagement_periods_created` | POST generate (periods queued) |
| `engagement_period_workflow_generated` | POST generate-workflow success |
| `engagement_period_workflow_failed` | POST generate-workflow failure |
| `engagement_period_skipped` | PUT skip |
| `engagement_period_cancelled` | PUT cancel |

---

## Manual Tests

1. Create an active engagement with `recurrence_type = 'monthly'`.
2. Click "📅 Periods" on the engagement card → set From: 2026-01-01, To: 2026-03-31.
3. Click "Preview Periods" → should show 3 periods (Jan, Feb, Mar 2026).
4. Click "Create Queue" → confirm 3 periods queued.
5. Open Period Queue page, filter by engagement → confirm 3 rows with `queued` status.
6. Click "Preview Periods" again with same range → should show 0 new periods, 3 duplicates.
7. Click "⚡ Generate" on Jan 2026 → confirm workflow run + tasks created.
8. Confirm period status changes to `generated`, workflow_run_id populated.
9. Confirm "⚡ Generate" button is hidden for generated periods.
10. Click "Skip" on Feb 2026 → enter reason → confirm status = skipped.
11. Click "Cancel" on Mar 2026 → confirm status = cancelled.
12. Re-run Preview for Jan-Mar 2026 → confirm Jan shows as duplicate, Mar shows as new (cancelled was excluded from unique guard).
13. Confirm no period queue data appears in localStorage or KV store.
14. Switch to a different company → confirm Period Queue shows no rows from first company.

---

## Future Scheduler Readiness

The `practice_engagement_periods` table is designed to be consumed by a future cron/queue scheduler. When that is built:

- `status = 'queued'` rows with `due_date` approaching are the work items
- The scheduler would set `status = 'ready'` and then call the same `generate-workflow` endpoint
- The `generation_source` on the resulting `practice_workflow_runs` row should be `'engagement_period'` (already supported)
- No schema changes are required

This codebox deliberately does NOT build that scheduler.

---

## Remaining Risks

| Risk | Notes |
|---|---|
| `recurrence_type` not set on existing engagements | Preview endpoint returns a clear error. Users must set recurrence_type via the engagement edit modal. Currently the edit modal does not expose recurrence fields — this is a Codebox 17 candidate. |
| `due_date` not auto-calculated | Period due_dates are currently left null by the recurrence engine. The user must set them manually in the generate-workflow modal or rely on the workflow template's `default_deadline_offset_days`. |
| No recurrence fields in the engagement edit modal | The UI to set `recurrence_type` and related fields is not yet built. This is a follow-up. |

---

## FOLLOW-UP NOTE

```
FOLLOW-UP NOTE
- Area: Engagement edit modal (client-detail.html)
- Dependency: Recurrence fields (recurrence_type, recurrence_start_date, recurrence_day etc.) added to DB in migration 067 but not yet exposed in the engagement edit form
- What was done now: DB columns added, backend recurrence engine reads them
- What still needs to be checked: Add recurrence_type + recurrence_start_date fields to the engagement add/edit modal in client-detail.html and client-detail.js saveEngagement()
- Risk if not checked: Users cannot set recurrence type via UI — they would need direct DB access
- Recommended next review point: Codebox 17 or a quick patch before that
```
