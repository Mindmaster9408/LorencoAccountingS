# Codebox 48 — Practice Quality Management System (QMS)

> Module: Practice Management — QMS
> Status: Complete (migration 106 not yet applied to Supabase)
> Migration: 106
> Routes: `/api/practice/qms/*`

---

## Purpose

Practice-wide quality control: quality reviews over tasks, workflow runs, tax
completion packs, SOPs, and ad-hoc internal inspections / client file reviews,
with non-conformance findings and CAPA (corrective/preventive action) tracking.

**This is NOT AI. NOT a disciplinary workflow. NOT Sean AI.**
It verifies that work meets quality standards and tracks issues to
resolution — it does not evaluate staff performance or automate judgment.

---

## Mandatory Patch 48A — SOP Review Status

**Requested:** Patch SOP status enum to support `draft`/`under_review`/`approved`/`archived`, with `submit-review` setting `under_review` and `approve` setting `approved`, without breaking existing SOPs.

**Result: already satisfied — no action taken.** This exact patch was applied earlier the same session (documented in `docs/new-app/SESSION_HANDOFF_codebox_47_sop_library.md`, "PATCH" section). Audit confirmed:
- `105_practice_sop_library.sql` — `status` CHECK already includes all 4 values
- `practice-sop.js` — `STATUSES` array already includes `under_review`; `submit-review` already sets `draft → under_review`; `approve` already requires `under_review → approved`

No existing SOPs are affected since this is purely additive to the CHECK constraint and migration 105 has now been applied per this codebox's stated assumption (no live data depended on the narrower 3-value set, since the migration was applied with the patch already in place).

---

## Migration 106

### `practice_quality_reviews` — one row per quality review

| Field | Notes |
|---|---|
| `review_type` | 8-value CHECK: `task_review`, `workflow_review`, `tax_review`, `completion_pack_review`, `sop_compliance_review`, `internal_inspection`, `client_file_review`, `custom` |
| `linked_type` | Nullable, CHECK `IS NULL OR IN ('task','workflow','completion_pack','sop')` — reviews may be manual/ad-hoc with no linked source (e.g. `internal_inspection`, `client_file_review`, `custom`) |
| `linked_id` | Nullable — paired with `linked_type` |
| `status` | 7-value CHECK: `draft`, `in_review`, `passed`, `failed`, `needs_correction`, `completed`, `cancelled` |
| `quality_score` | Nullable INTEGER, CHECK 0–100 |

Auto-updates `updated_at` via `tg_pqr_updated_at` trigger. A **partial unique index** (`uq_pqr_active_linked_review`) enforces at most one active (non-terminal) review per `(company_id, linked_type, linked_id)` — defense-in-depth behind the app-level 409 duplicate check.

### `practice_quality_findings` — findings + CAPA per review

| Field | Notes |
|---|---|
| `finding_type` | 8-value CHECK: `non_conformance`, `observation`, `improvement`, `risk`, `missing_evidence`, `sop_not_followed`, `review_note`, `custom` |
| `severity` | 4-value CHECK: `low`, `medium`, `high`, `critical` |
| `status` | 6-value CHECK: `open`, `in_progress`, `resolved`, `verified`, `dismissed`, `cancelled` |
| `corrective_action` / `preventive_action` | Free text — CAPA fields stored directly on the finding row (no separate CAPA table; not required at this scale) |

### `practice_quality_events` — append-only audit log

Covers both review-level and finding-level events (`finding_id` nullable — null for review-level events).

---

## Backend — `quality-management.js`

### Endpoints (19 total, all from spec)

| Method | Route | Purpose |
|---|---|---|
| GET | `/summary` | Status counts + open/critical-open finding counts |
| GET | `/reviews` | Paginated list — filters: search, review_type, status, linked_type, linked_id, client_id |
| POST | `/reviews` | Manual create (optionally with `linked_type`/`linked_id` — ownership + duplicate checked) |
| GET | `/reviews/:id` | Single review, enriched with client name |
| PUT | `/reviews/:id` | Update non-status fields (title, client, reviewer, notes, quality_score) |
| DELETE | `/reviews/:id` | Soft cancel |
| PUT | `/reviews/:id/start` | draft/needs_correction → in_review |
| PUT | `/reviews/:id/pass` | in_review → passed |
| PUT | `/reviews/:id/fail` | in_review → failed |
| PUT | `/reviews/:id/complete` | passed/failed → completed |
| GET | `/reviews/:id/findings` | List findings for a review |
| POST | `/reviews/:id/findings` | Add finding (see auto-transition below) |
| PUT | `/findings/:findingId` | Update non-status fields |
| PUT | `/findings/:findingId/resolve` | open/in_progress → resolved |
| PUT | `/findings/:findingId/verify` | resolved → verified |
| DELETE | `/findings/:findingId` | Soft cancel |
| GET | `/reviews/:id/events` | Append-only event log |
| POST | `/create-from-task` | Create review from a `practice_tasks` row |
| POST | `/create-from-workflow` | Create review from a `practice_workflow_runs` row |
| POST | `/create-from-completion-pack` | Create review from a `practice_tax_completion_packs` row |
| POST | `/create-from-sop` | Create review from a `practice_sop_templates` row |

Note: `PUT /findings/:findingId*` routes are **not** nested under `/reviews/:id/` in the URL (per spec) — findings are addressed by id alone; the finding's own `review_id` column is used to scope audit events back to its parent review.

### Review Status Machine

```
draft ──────────────┐
                     ├─(start)──> in_review ──(pass)──> passed ───┐
needs_correction ────┘                │                          ├─(complete)──> completed
                                       └──(fail)──> failed ───────┘
(any non-terminal) ──(cancel)──> cancelled
```

`needs_correction` is reached automatically (see below), not via a dedicated endpoint — the spec's endpoint list only has start/pass/fail/complete. `start` doubles as the re-review trigger from `needs_correction`.

### Auto-Transition: Finding Added While In Review → Needs Correction

`POST /reviews/:id/findings` — if the parent review's status is `in_review` when a finding is added, the review automatically transitions to `needs_correction` (a finding means something needs to be fixed before the review can pass). Staff re-open with `PUT /reviews/:id/start` once the finding is addressed. This was a judgment call (see follow-up notes) since the spec's endpoint list has no dedicated "flag for correction" action — findings themselves are the trigger.

### Create-From-Source Helpers

All four helpers verify the source record belongs to `req.companyId`, apply the same duplicate guard as manual creation (409 with `existing_review_id`), and default the review title to `"<Prefix> — #<id>"` (overridable). `client_id` is inherited automatically from the source row where that table carries one:
- `create-from-task` / `create-from-completion-pack`: inherit `client_id` from the source row
- `create-from-workflow` / `create-from-sop`: source tables have no `client_id` column — accepts an optional `client_id` in the request body instead

### Duplicate Guard

`_findActiveReviewForLink` checks for any review with the same `(linked_type, linked_id)` whose status is not `completed`/`cancelled`. Enforced both at the application layer (friendly 409 with `existing_review_id`) and at the database layer (partial unique index) for race-condition safety.

### Multi-Tenant Safety

Every query scoped to `req.companyId`. `_verifyReview` and `_verifyFinding` re-check ownership before every mutating action. `_verifyLinkedRecordOwnership` confirms the source record belongs to the company before creating a review or applying the duplicate guard.

---

## Frontend — `quality-management.html` + `js/quality-management.js`

### Page

- Summary cards (Draft, In Review, Needs Correction, Passed, Failed, Completed, Open Findings, Critical Open) — status cards clickable to filter
- Filter bar: review type, status, client ID, free-text search
- Paginated reviews table (type, status, title, client, quality score, created)
- Create Review modal (manual — title, review type, client ID, assigned reviewer, notes)
- Review Detail modal — 3 tabs: **Overview** (metadata + notes), **Findings** (list + add + resolve/verify/cancel + CAPA display), **Events** (append-only log)
- Add Finding modal (type, severity, title, description, root cause, corrective/preventive action, due date, responsible team member)
- Action modal (shared for Pass/Fail/Complete — optional quality score + notes)
- Context-sensitive footer: draft/needs_correction → Start/Re-Review; in_review → Pass/Fail; passed/failed → Complete; all non-terminal → Cancel Review
- `?linked_type=X&linked_id=Y` URL param renders an info banner listing reviews for that record, with a "Create one ↗" quick-action if none exist yet (calls the matching `create-from-*` endpoint directly)

### No localStorage / KV

Zero browser storage usage in any new file. `node --check` passed on all new/modified JS files.

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/106_practice_qms_foundation.sql` | 3 tables + 2 triggers + indexes + partial unique index |
| `backend/modules/practice/quality-management.js` | Backend router — 19 endpoints |
| `backend/frontend-practice/quality-management.html` | Frontend page |
| `backend/frontend-practice/js/quality-management.js` | Frontend IIFE (`qms` prefix) |
| `docs/new-app/48_quality_management_system.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_48_qms.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/index.js` | Mount QMS router at `/qms` after `/sop` |
| `backend/frontend-practice/js/layout.js` | Add "Quality" nav between Practice SOPs and Tax Config |
| `backend/frontend-practice/js/tasks.js` | Add "QMS Review ↗" link per task card, alongside the existing "📋 Procedure" link |
| `backend/frontend-practice/js/practice-sop.js` | Add "QMS Review ↗" link to SOP detail footer |
| `backend/frontend-practice/js/tax-completion.js` | Add "QMS Review ↗" link to `_renderFooter`, alongside the existing "Knowledge ↗" and "Procedure ↗" links |
