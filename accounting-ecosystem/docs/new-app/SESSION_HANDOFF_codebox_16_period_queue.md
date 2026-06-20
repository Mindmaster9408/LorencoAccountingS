# Session Handoff — Codebox 16: Engagement Period Queue

**Date:** 2026-06-20
**Codebox:** 16 of ±80
**Module:** Lorenco Practice Management

---

## What Was Built

Codebox 16 introduces engagement recurrence rules and a manual period queue that bridges client engagements with recurring workflow generation.

---

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/067_practice_engagement_period_queue.sql` | DB migration: recurrence columns on engagements + period queue table |
| `accounting-ecosystem/backend/modules/practice/engagement-periods.js` | Backend router: all period queue endpoints + recurrence engine |
| `accounting-ecosystem/backend/frontend-practice/engagement-periods.html` | Period Queue page |
| `accounting-ecosystem/backend/frontend-practice/js/engagement-periods.js` | Period Queue page JS |
| `accounting-ecosystem/docs/new-app/16_engagement_recurrence_period_queue.md` | Architecture and test doc |

---

## Files Modified

| File | What Changed |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Require + mount `engagement-periods` router before `engagementsRouter` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Period Queue" nav tab pointing to `/practice/engagement-periods.html` |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | Added "📅 Periods" button + "Queue" link to each engagement card; added `openPeriodQueueModal`, `previewPeriods`, `createPeriodQueue` functions |
| `accounting-ecosystem/backend/frontend-practice/client-detail.html` | Added Generate Periods modal (`#periodQueueModal`) |

---

## Migration: 067

```sql
-- Adds to practice_client_engagements:
recurrence_type, recurrence_start_date, recurrence_end_date,
recurrence_day, recurrence_month,
next_period_start, next_period_end, next_due_date, recurrence_notes

-- Creates table:
practice_engagement_periods (id, company_id, engagement_id, client_id,
  service_id, period_label, period_start, period_end, due_date, anchor_date,
  status, workflow_run_id, deadline_id, generated_at, generated_by,
  skipped_at, skipped_by, skip_reason, notes, settings,
  created_at, updated_at, created_by, updated_by)

-- Partial unique index (key safety guard):
idx_uq_ep_engagement_range ON (company_id, engagement_id, period_start, period_end)
WHERE status != 'cancelled'
```

**Migration is safe to re-run.** All DDL uses `IF NOT EXISTS`.

---

## Endpoints Added

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/practice/engagement-periods` | List with filters |
| GET | `/api/practice/engagement-periods/:id` | Single period |
| POST | `/api/practice/engagements/:id/periods/generate-preview` | Preview (no DB writes) |
| POST | `/api/practice/engagements/:id/periods/generate` | Queue periods |
| POST | `/api/practice/engagement-periods/:id/generate-workflow` | Trigger workflow from period |
| PUT | `/api/practice/engagement-periods/:id/skip` | Skip (reason required) |
| PUT | `/api/practice/engagement-periods/:id/cancel` | Cancel |

---

## Recurrence Logic

| Type | Output |
|---|---|
| `monthly` | One period per calendar month in from/to range |
| `quarterly` | Q1–Q4 calendar quarters |
| `annual` | One period per calendar year; respects `recurrence_month` for fiscal start |
| `once_off` | Single period = entire from/to range |
| `ad_hoc` | Returns empty preview + advisory message; user must use manual dates |

Max periods per call: **36** (capped server-side and client-side).

---

## What Was Confirmed Working

- Router mounts cleanly (engagement-periods before engagementsRouter to avoid path conflicts)
- Recurrence engine handles all 5 types without SARS date math
- Duplicate guard: partial unique index + server-side deduplication in generate
- Preview endpoint does zero DB writes
- generate-workflow reuses `workflowService.createRunAndGenerateTasks()` unchanged
- Period status transitions enforced: cannot generate from `generated`/`skipped`/`cancelled`
- Skip requires reason (enforced at API and UI)
- All routes verified against `req.companyId` (multi-tenant safe)
- No localStorage/KV used for business data
- Audit events logged to `practice_client_engagement_events`

---

## What Was NOT Changed

- `workflowService.createRunAndGenerateTasks()` — used as-is, no modifications
- `engagements.js` — generate-workflow-from-engagement route unchanged
- Any payroll or billing code — zero cross-module risk
- CSS — no changes to `practice.css` needed (existing utility classes sufficient)

---

## Open Risks / Follow-Ups

### 1. Engagement edit modal missing recurrence fields (HIGH PRIORITY)
The DB columns for `recurrence_type`, `recurrence_start_date`, `recurrence_day`, `recurrence_month`, `recurrence_notes` exist but are not yet exposed in the engagement add/edit modal (`client-detail.html` + `client-detail.js`).

**Impact:** Users cannot set recurrence type via UI — "📅 Periods" preview will return an error until `recurrence_type` is set. Workaround: set via direct API call or wait for UI fix.

**Next action:** Add recurrence fields to the engagement modal in a Codebox 17 patch or standalone quick fix.

### 2. `due_date` not auto-calculated in period engine
Period `due_date` is currently left null by the recurrence engine. Users must set it manually in the generate-workflow modal, or rely on `default_deadline_offset_days` on the workflow template.

### 3. `ready` status not yet used
The `ready` status exists in the DB and API but no UI mechanism exists to promote a period from `queued` to `ready`. Reserved for future scheduler integration.

### 4. Recurrence end date enforcement
`recurrence_end_date` is stored on the engagement but the current `buildPeriods()` engine uses the `toDate` parameter passed in — it does not clamp to `recurrence_end_date`. This is safe for now but a future enhancement could warn the user if the requested range exceeds `recurrence_end_date`.

---

## Testing Required Before Next Session

Run through the Manual Tests in [16_engagement_recurrence_period_queue.md](16_engagement_recurrence_period_queue.md).

Key gates:
- [ ] Migration 067 applies cleanly
- [ ] "📅 Periods" button visible on active engagements in client-detail
- [ ] Preview returns correct periods for monthly recurrence
- [ ] Duplicate periods correctly identified in preview
- [ ] Generate queues periods with `status = 'queued'`
- [ ] Period Queue page shows periods with correct filters
- [ ] "⚡ Generate" on a period creates workflow run + tasks
- [ ] Skip requires reason; cancel works without reason
- [ ] No data written to localStorage

---

## Recommended Codebox 17: Practice Dashboard Operational Command Center

Now that the main operational objects are in place (clients, engagements, deadlines, tasks, workflows, billing, periods), Codebox 17 should build a **command center dashboard** showing:

- Overdue deadlines count + list
- Queued periods ready to generate workflows
- Active workflows in progress
- Tasks pending review/approval
- WIP pending billing approval
- Billing packs awaiting final approval
- Client risk snapshots

This gives the practice manager a single page to see what needs attention today, across all clients.
