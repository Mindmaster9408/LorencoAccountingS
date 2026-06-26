# Codebox 40 — Tax Filing Pipeline Foundation

> Module: Practice Management — Tax Pipeline
> Status: Complete
> Migration: 088 (must be applied to Supabase)
> Routes: `/api/practice/tax-pipeline/*`

---

## Purpose

Creates a unified 11-stage filing lifecycle that spans all three tax entity types: Individual Tax Returns, Company Tax Returns, and Provisional Tax Plans.

**This is operational workflow tracking only. Not SARS integration. Not eFiling. Not submission automation.**

---

## Pipeline Stages

| # | Stage | Label |
|---|---|---|
| 1 | `not_started` | Not Started |
| 2 | `docs_requested` | Docs Requested |
| 3 | `docs_received` | Docs Received |
| 4 | `data_captured` | Data Captured |
| 5 | `calculation_completed` | Calculation Done |
| 6 | `review_pack_generated` | Review Pack |
| 7 | `under_review` | Under Review |
| 8 | `ready_to_submit` | Ready To Submit |
| 9 | `submitted` | Submitted |
| 10 | `completed` | Completed |
| 11 | `cancelled` | Cancelled |

---

## Migration 088

### New Table: `practice_tax_pipeline_events`

Append-only audit log. One row per stage change.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto identity |
| `company_id` | INTEGER | Multi-tenant scope |
| `source_type` | TEXT | `individual_tax_return` / `company_tax_return` / `provisional_tax_plan` |
| `source_id` | INTEGER | FK to the specific return/plan (no DB FK — cross-table) |
| `old_stage` | TEXT NULL | Previous stage (null for first transition) |
| `new_stage` | TEXT | New stage |
| `actor_user_id` | INTEGER NULL | Who made the change |
| `notes` | TEXT NULL | Required for cancellations and backward moves |
| `metadata` | JSONB | `{ move_type: 'forward' / 'backward' / 'cancel' }` |
| `created_at` | TIMESTAMPTZ | Event timestamp |

### Columns Added to Existing Tables

Added to all three entity tables:

| Column | Type | Default |
|---|---|---|
| `filing_stage` | TEXT NOT NULL | `'not_started'` |
| `filing_stage_updated_at` | TIMESTAMPTZ NULL | — |
| `filing_stage_updated_by` | INTEGER NULL | — |

Tables altered:
- `practice_individual_tax_returns`
- `practice_company_tax_returns`
- `practice_provisional_tax_plans`

All existing rows default to `filing_stage = 'not_started'`.

**Existing `status` columns are unchanged.** `filing_stage` is an additive, parallel field.

---

## Backend — `tax-pipeline.js`

### Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/practice/tax-pipeline/summary` | Count per stage across all 3 entity types |
| GET | `/api/practice/tax-pipeline` | Combined pipeline list with filters |
| GET | `/api/practice/tax-pipeline/:sourceType/:sourceId` | Detail + history + allowed next stages |
| PUT | `/api/practice/tax-pipeline/:sourceType/:sourceId/stage` | Change stage with validation |

### Stage Transition Rules

**Forward moves:** Always allowed in sequence (each stage can advance to the next).

**Backward moves:** Only these three pairs are permitted:
- `submitted` → `ready_to_submit`
- `ready_to_submit` → `under_review`
- `under_review` → `review_pack_generated`

**Cancellation:** Allowed from any active stage.

**Terminal stages:** `completed` and `cancelled` — no further changes permitted.

**Notes required for:** cancellations and any backward move.

### Auto-Validation Checks

| Target Stage | Check | Source Types |
|---|---|---|
| `calculation_completed` | Calculation record exists (`practice_individual_tax_calculations` / `practice_company_tax_calculations`) | Individual, Company |
| `review_pack_generated` | Review pack record exists | Individual, Company |
| `ready_to_submit` | Review pack with `pack_status IN ('reviewed', 'approved')` exists | Individual, Company |
| `submitted` | `readiness_status != 'blocked'` | Individual, Company |

Provisional tax plans skip all auto-validation checks (no linked calculation or review pack tables).

### Multi-Tenant Safety

- All queries scoped to `req.companyId` from JWT
- Record ownership verified before any stage change (`company_id = req.companyId`)
- No frontend-supplied `company_id` accepted

### Audit Logging

| Event | Trigger |
|---|---|
| `tax_pipeline_stage_changed` | Forward stage move |
| `tax_pipeline_cancelled` | Move to `cancelled` |
| `tax_pipeline_reopened` | Backward stage move |

---

## Frontend — `tax-pipeline.html` + `js/tax-pipeline.js`

### Page Sections

1. **Summary Cards** — click-to-filter stage counts
2. **Pipeline Board** — kanban, 10 columns (cancelled excluded from board), horizontal scroll
3. **Pipeline List** — tabular view, toggle with Board
4. **Detail Modal** — current stage, history with arrow notation, allowed next stages
5. **Stage Change Modal** — dropdown of allowed stages only, notes field, required indicator for cancellations/backward moves

### Board

- 10 columns (not_started → completed; cancelled items excluded)
- Each card: name, client name, type badge, year, responsible member
- Cards click through to detail modal

### Stage Change Flow

1. Click card → detail modal opens
2. Click "Change Stage" → stage change modal opens with pre-filtered allowed stages dropdown
3. Select new stage → notes field shows required indicator for cancellation/backward
4. Submit → `PUT /stage` — success: toast + close + reload; failure: inline error message

### No localStorage / KV

All state is fetched from API on demand. `_items` and `_currentDetail` are runtime-only JS variables. No `localStorage`, `sessionStorage`, or `safeLocalStorage` used anywhere.

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/088_practice_tax_filing_pipeline.sql` | Migration — events table + 3 ALTER TABLE statements |
| `backend/modules/practice/tax-pipeline.js` | Backend router — 4 endpoints |
| `backend/frontend-practice/tax-pipeline.html` | Frontend page |
| `backend/frontend-practice/js/tax-pipeline.js` | Frontend IIFE |
| `docs/new-app/40_tax_pipeline_foundation.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_40_tax_pipeline.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/index.js` | Mount `tax-pipeline` router |
| `backend/frontend-practice/js/layout.js` | Add "Tax Pipeline" nav entry |
