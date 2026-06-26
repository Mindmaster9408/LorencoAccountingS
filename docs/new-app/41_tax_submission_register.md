# Codebox 41 — Tax Submission Register + Evidence Tracking Foundation

> Module: Practice Management — Tax Submissions
> Status: Complete
> Migration: 089 (must be applied to Supabase)
> Routes: `/api/practice/tax-submissions/*`

---

## Purpose

Creates a formal submission register linked to the Tax Pipeline. Tracks what was submitted, when, how, by whom, what reference numbers were received, assessment outcomes, amounts, and supporting evidence notes. Manual entry only — no SARS/eFiling integration.

---

## Migration 089

### `practice_tax_submissions` — main register table

All fields as specified. Key constraints:

| Constraint | Values |
|---|---|
| `source_type` | `individual_tax_return`, `company_tax_return`, `provisional_tax_plan` |
| `submission_type` | `itr12`, `itr14`, `irp6_p1`, `irp6_p2`, `irp6_topup`, `emp501`, `custom` |
| `submission_status` | `draft`, `submitted`, `acknowledged`, `assessed`, `correction_required`, `objection_required`, `completed`, `cancelled` |
| `submission_method` | `efiling`, `branch`, `email`, `manual`, `other` (nullable) |
| `assessment_outcome` | `accepted`, `changed`, `additional_tax`, `refund`, `nil`, `disputed`, `unknown` (nullable) |

Auto-updates `updated_at` via PostgreSQL trigger `tg_pts_updated_at`.

### `practice_tax_submission_evidence` — evidence records

Per-submission evidence items (notes/links only — no file storage). Soft delete via `is_deleted`, `deleted_at`, `deleted_by` columns.

### `practice_tax_submission_events` — audit log

Append-only event log. One row per status change or evidence action.

---

## Backend — `tax-submissions.js`

### Route Ordering (critical)

`GET /summary` and `POST /create-from-pipeline` registered **before** `GET /:id` and `PUT /:id` to prevent Express treating "summary" and "create-from-pipeline" as id parameters.

### Endpoints

| Method | Route | Purpose |
|---|---|---|
| GET | `/summary` | Status counts + follow-up + payments due |
| POST | `/create-from-pipeline` | Create draft from pipeline (duplicate-safe) |
| GET | `/` | Paginated list with 9 filter params |
| POST | `/` | Create submission manually |
| GET | `/:id` | Single submission + evidence_count |
| PUT | `/:id` | Update allowed fields (status changes via action endpoints) |
| DELETE | `/:id` | Soft cancel (sets status = 'cancelled') |
| PUT | `/:id/mark-submitted` | Move draft → submitted |
| PUT | `/:id/record-acknowledgement` | Move submitted → acknowledged |
| PUT | `/:id/record-assessment` | Move submitted/acknowledged → assessed |
| PUT | `/:id/set-follow-up` | Set follow-up fields (any non-cancelled status) |
| GET | `/:id/evidence` | List evidence (excluding soft-deleted) |
| POST | `/:id/evidence` | Add evidence record |
| PUT | `/:id/evidence/:evidenceId` | Update evidence |
| PUT | `/:id/evidence/:evidenceId/verify` | Mark evidence verified |
| DELETE | `/:id/evidence/:evidenceId` | Soft delete evidence |
| GET | `/:id/events` | Submission event log |

### Status Progression

```
draft → submitted → acknowledged → assessed → correction_required / objection_required → completed
                ↓
           assessed (can skip acknowledged)

cancelled: from any non-completed, non-cancelled status
```

### Duplicate Prevention (create-from-pipeline)

Checks for existing active submission where `source_type + source_id + submission_type` match and `submission_status != 'cancelled'`. Returns `409` with existing ID if found.

### Multi-Tenant Safety

- All queries scoped to `req.companyId`
- `_verifySubmission(id, cid)` verifies ownership before every action
- `_verifyEvidence(submissionId, evidenceId, cid)` verifies nested ownership
- `_extractClientId(sourceType, sourceId, cid)` verifies source record belongs to company and derives `client_id`

### Audit Events Written

| Event | Trigger |
|---|---|
| `submission_created` | POST / or POST /create-from-pipeline |
| `submission_updated` | PUT /:id |
| `submission_marked_submitted` | PUT /:id/mark-submitted |
| `acknowledgement_recorded` | PUT /:id/record-acknowledgement |
| `assessment_recorded` | PUT /:id/record-assessment |
| `evidence_added` | POST /:id/evidence |
| `evidence_verified` | PUT /:id/evidence/:id/verify |
| `follow_up_set` | PUT /:id/set-follow-up |
| `submission_cancelled` | DELETE /:id |

---

## Pipeline Integration

When `tax-pipeline.js` (frontend) renders the detail modal and `filing_stage === 'submitted'`, a "Open Submission Register" link is shown. It navigates to `/practice/tax-submissions.html?source_type=X&source_id=Y&tax_year=Z`.

On load, `tax-submissions.js` reads these URL params and auto-opens the Create modal with the fields pre-filled. No auto-creation occurs — the user must confirm creation.

---

## Frontend — `tax-submissions.html` + `js/tax-submissions.js`

### Page

- Summary cards (click-to-filter by status)
- Filtered, paginated submission register table
- Create modal
- Detail modal with 6 tabs: Overview, Submission, Assessment, Evidence, Follow-up, Events

### Detail Modal Actions (context-sensitive by status)

| Status | Available Actions |
|---|---|
| draft | Mark Submitted, Cancel, Add Evidence, Follow-up |
| submitted | Record Acknowledgement, Record Assessment, Add Evidence, Follow-up |
| acknowledged | Record Assessment, Add Evidence, Follow-up |
| assessed+ | Add Evidence, Follow-up |

### URL Param Auto-fill

If page loaded with `?source_type=X&source_id=Y`, the Create modal opens automatically with those values pre-filled. This powers the pipeline → register flow.

### No localStorage / KV

All state is API-fetched on demand. `_currentSub` and `_currentId` are runtime-only JS variables. No `localStorage`, `sessionStorage`, or `safeLocalStorage` used.

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/089_practice_tax_submission_register.sql` | 3 tables + trigger + all indexes |
| `backend/modules/practice/tax-submissions.js` | Backend router — 17 endpoints |
| `backend/frontend-practice/tax-submissions.html` | Frontend page |
| `backend/frontend-practice/js/tax-submissions.js` | Frontend IIFE |
| `docs/new-app/41_tax_submission_register.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_41_tax_submissions.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/index.js` | Mount `tax-submissions` router |
| `backend/frontend-practice/js/layout.js` | Add "Tax Submissions" nav entry |
| `backend/frontend-practice/js/tax-pipeline.js` | Add "Open Submission Register" link in detail modal when stage = submitted |
