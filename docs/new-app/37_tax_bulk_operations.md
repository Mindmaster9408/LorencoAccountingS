# Codebox 37 — Tax Season Bulk Operations Foundation

**Module:** Lorenco Practice Management  
**Date:** June 2026  
**Status:** Complete

---

## Purpose

Allow practice users to prepare tax season work in controlled batches — selecting clients by filter, previewing the affected list, and explicitly executing only after review.

This is NOT cron automation. NOT background execution. NOT SARS/eFiling. NOT AI.  
Every operation is user-triggered, preview-first, execute-on-confirm.

---

## What Was Built

### Migration: `086_practice_tax_bulk_operations.sql`

Three tables:

**`practice_tax_bulk_operations`**

| Field | Purpose |
|---|---|
| `operation_name` | Human-readable label |
| `operation_type` | One of 7 types (see below) |
| `operation_status` | draft → previewed → running → completed/failed/cancelled |
| `tax_year` | Optional scope |
| `source_filter` | JSONB: client filter criteria used |
| `options` | JSONB: what to create/assign |
| `preview_snapshot` | JSONB: client list + warnings captured at preview time |
| `result_summary` | JSONB: total/created/skipped/failed/warnings after execute |
| `started_at`, `completed_at`, `cancelled_at` | Timing fields |

**Operation Types:**
- `create_compliance_packs` — create compliance pack per client
- `apply_tax_checklist` — create doc requests per client from template
- `create_document_requests` — same as above, doc-requests-only label
- `assign_tax_owners` — set responsible_team_member_id on clients
- `assign_reviewers` — set reviewer_team_member_id on returns
- `create_tax_actions` — create one tax action per client
- `mixed_tax_season_setup` — create pack + apply checklist + assign owner

**`practice_tax_bulk_operation_items`**

Per-client result rows, created after execute:

| Field | Purpose |
|---|---|
| `item_status` | pending / success / warning / skipped / failed |
| `created_records` | JSONB: what was created (pack_id, doc_requests_created, etc.) |
| `message` | Human-readable outcome |
| `error_detail` | Error message if failed |

**`practice_tax_bulk_operation_events`** — append-only audit log

---

### Backend: `tax-bulk-operations.js`

Endpoints at `/api/practice/tax-bulk-operations`:

| Route | Purpose |
|---|---|
| `GET /` | List operations (type/status/tax_year filters, pagination) |
| `POST /preview` | Build preview — NO DB save |
| `POST /` | Save operation with preview snapshot |
| `GET /:id` | Single operation |
| `GET /:id/items` | Per-client results |
| `GET /:id/events` | Audit log |
| `POST /:id/execute` | Execute (must be previewed or draft) |
| `PUT /:id/cancel` | Cancel (cannot cancel running) |

---

### Preview Logic

`POST /preview` runs these filters against `practice_clients`:

| Filter | Implementation |
|---|---|
| `client_type` | Direct `.eq()` on practice_clients |
| `responsible_team_member_id` | Direct `.eq()` on practice_clients |
| `provisional_taxpayer` | Join via practice_taxpayer_profiles.provisional_taxpayer |
| `has_taxpayer_profile` | Filter to clients that have a profile row |
| `has_active_engagement` | Join via practice_client_engagements.status IN (active, pending) |
| `missing_compliance_pack` | Filter out clients with existing pack for pack_type + tax_year |

Returns: `{ clients, warnings, estimated_outputs, client_count }` — NOT saved to DB.

---

### Execute Logic

`POST /:id/execute` reads `preview_snapshot.clients` for the client list, then runs per-client functions:

**A. `create_compliance_packs` / `mixed_tax_season_setup`:**
- Duplicate check: existing pack for client + pack_type + tax_year + not cancelled
- If exists: `created_records.pack_skipped = true`
- If not: insert to `practice_compliance_packs`

**B. `apply_tax_checklist` / `mixed_tax_season_setup`:**
- Loads template items where `target_type = 'document_request'`
- Non-document items: logged as warning (skipped in bulk mode — no per-client pack/return ID available)
- Duplicate check: existing doc request titles (case-insensitive)
- Inserts to `practice_document_requests` with `request_status = 'requested'`

**C. `create_document_requests`:**
- Same as apply_tax_checklist (doc-request items from template)

**D. `assign_tax_owners`:**
- Updates `practice_clients.responsible_team_member_id`
- Skips if already set and `!override_existing`

**E. `assign_reviewers`:**
- Updates `practice_individual_tax_returns.reviewer_team_member_id`
- Updates `practice_company_tax_returns.reviewer_team_member_id`
- Filters by tax_year if specified
- Skips existing reviewers unless `override_existing = true`

**F. `create_tax_actions`:**
- Duplicate check: existing open action for client + action_type
- Inserts to `practice_tax_work_actions` with `action_status = 'open'`

---

### Per-Client Failure Isolation

One client failing does NOT abort the entire operation. Each client is processed independently:
- Success → `item_status = 'success'`
- Caught exception → `item_status = 'failed'`, error recorded
- Warnings (skipped items) → `item_status = 'warning'`

Final operation status:
- All failed → `failed`
- Any failed or warning → `completed_with_warnings`
- All success → `completed`

---

### Frontend Wizard (5 Steps)

**Step 1 — Operation Type:** 7 clickable cards, operation name field.

**Step 2 — Filters:** Client type, tax year, responsible owner, provisional taxpayer flag, has active engagement flag, missing compliance pack flag.

**Step 3 — Options:** Shown/hidden by operation type:
- Pack type + period dates (create_compliance_packs, mixed)
- Checklist template + due date (apply_tax_checklist, create_document_requests, mixed)
- Owner assignment (create_compliance_packs, assign_tax_owners, mixed)
- Reviewer assignment (create_compliance_packs, assign_reviewers, mixed)
- Override existing checkbox (assign_tax_owners, assign_reviewers)
- Action type + title + due date (create_tax_actions)

**Step 4 — Preview:** Client list table (max 50 shown), warning box, estimated outputs summary. "Re-preview" button to adjust without going back.

**Step 5 — Execute:** Operation summary + warning banner + "Execute Now" button. After execute: per-client results table (success/warning/failed counts + inline item table).

**Operations list:** Always visible at top. Shows existing operations with Execute/Cancel/Results buttons.

---

### Router Mount + Nav

**`index.js`:** `router.use('/tax-bulk-operations', taxBulkOperationsRouter);`

**`layout.js`:** `{ key: 'tax-bulk-ops', label: 'Tax Bulk Ops', href: '/practice/tax-bulk-operations.html' }` (after Tax Checklists)

---

## Multi-Tenant Safety

- All queries scoped by `req.companyId`
- Preview filters client ownership before returning
- Execute re-fetches clients from DB using `companyId` to prevent stale preview data from creating cross-company records
- Team member validation via `verifyOwn(cid, 'practice_team_members', id)` before saving

## localStorage / KV

None. All operation data goes to SQL via `PracticeAPI.fetch()`.

## Audit Trail

Every operation emits events:
- `bulk_operation_created` — on save
- `bulk_operation_executed` — at start of execute
- `bulk_operation_completed` / `bulk_operation_failed` — on finish
- `bulk_operation_cancelled` — on cancel

Plus standard `auditFromReq` calls for CREATE/UPDATE.

---

## Migration Required

Run `086_practice_tax_bulk_operations.sql` in Supabase SQL Editor before using.

Expected: `Success. No rows returned`

---

## Files Created / Modified

| File | Change |
|---|---|
| `backend/config/migrations/086_practice_tax_bulk_operations.sql` | NEW |
| `backend/modules/practice/tax-bulk-operations.js` | NEW — 8 endpoints |
| `backend/modules/practice/index.js` | MODIFIED — mounts taxBulkOperationsRouter |
| `backend/frontend-practice/tax-bulk-operations.html` | NEW |
| `backend/frontend-practice/js/tax-bulk-operations.js` | NEW |
| `backend/frontend-practice/js/layout.js` | MODIFIED — Tax Bulk Ops nav entry |

---

## Limitations / Bulk-Mode Restrictions

- `apply_tax_checklist` in bulk only creates `document_request` target type items; compliance_pack_items and individual/company_tax_items are skipped (no per-client pack/return ID available at bulk time)
- `assign_reviewers` only updates returns that already exist — does not create returns
- `mixed_tax_season_setup` does not add pack items to newly created packs (follow-up: apply pack items after pack creation)

---

## Recommended CB38: Tax Season Progress Reporting + Partner Summary Foundation

After bulk operations exist, managers need reporting:
- Tax season progress % per client
- Outstanding documents by client/reviewer
- Returns by status across the practice
- Packs by status with readiness scores
- Reviewer workload bottlenecks
- Partner/client group summaries and KPIs
