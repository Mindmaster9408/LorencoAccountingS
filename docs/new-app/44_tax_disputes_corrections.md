# Codebox 44 — Tax Dispute / Correction / Objection Workflow Foundation

> Module: Practice Management — Tax Disputes
> Status: Complete (migrations 100–102 not yet applied to Supabase)
> Migration: 102 (must be applied to Supabase)
> Routes: `/api/practice/tax-disputes/*`
> Patch 44A: sars-statement-recon.js (client enrichment + ignored-line variance fix)
> Tax Submissions backend: 3 new status endpoints (mark-correction-required, mark-objection-required, mark-completed)

---

## Purpose

Allows practice staff to manually track assessment corrections, formal objections, NOO, ADR, appeal, and Tax Court escalation cases — all linked back to the relevant Tax Submission, SARS Statement Line, or Assessment Reference.

**This is NOT SARS API. NOT eFiling objection submission. This is manual internal tracking only.** It is the case-management layer above the Tax Submission and SARS Recon registers (Codeboxes 41–43), not a connection to SARS systems.

---

## Patch 44A — Three Improvements to Existing Modules (Low-Risk)

### 44A-1: LAYOUT.onReady Confirmed (Code Review)

`layout.js` line 90: `function onReady(cb) { cb(); }` — confirmed present and working. The Codebox 42 bug fix is intact. No code change required. Documented here as confirmation.

### 44A-2: Client Name Enrichment in SARS Recon

`GET /api/practice/sars-recon/lines` now returns `client_name` on each row via batch lookup from `practice_clients`. Additive only — new field, no existing field changed.

`sars-recon.js` frontend table and detail modal updated to display `client_name` (with fallback to `#client_id`).

### 44A-3: Partial-Match Endpoint (Deferred)

Evaluated as medium-risk: no `matched_amount` field in migration 101, no UI design for splitting one statement line across multiple events. Deferred to Codebox 45 or later. `partially_matched` status remains accessible via `PUT /lines/:id` for manual override.

### 44A-4: Exclude Ignored Lines from Variance Totals

`GET /api/practice/sars-recon/summary` now excludes `ignored` lines from `total_sars_debits` / `total_sars_credits` computation (previously excluded only `cancelled`). Low-risk additive filter change.

---

## Migration 102

### `practice_tax_dispute_cases` — one row per tracked dispute/correction/objection

| Field | Notes |
|---|---|
| `source_type` | `tax_submission`, `sars_statement_line`, `assessment`, `payment_case`, `manual` |
| `case_type` | `correction`, `objection`, `noo`, `adr`, `appeal`, `tax_court`, `manual_review` |
| `case_status` | 12-value state machine: `open → pending_submission → submitted → acknowledged → under_review → response_received → accepted/rejected → escalated/appealing → completed/cancelled` |
| `client_id` | Plain INTEGER (no FK), ownership verified in code |
| `source_id` | Plain INTEGER reference to source entity |
| `submission_id` | Plain INTEGER reference to `practice_tax_submissions` |
| Dates | `date_opened`, `submission_deadline`, `response_deadline`, `sars_response_date` |
| Outcome | `outcome`, `outcome_amount`, `outcome_notes` populated when resolved |
| `priority` | `low`, `medium`, `high`, `urgent` |

Auto-updates `updated_at` via `tg_ptdc_updated_at` trigger.

### `practice_tax_dispute_evidence` — supporting documents per case

- `evidence_type`: 8 values including `sars_correspondence`, `objection_form`, `legal_advice`, `tax_calculation`
- `is_verified` / `verified_by` / `verified_at`: verification workflow

### `practice_tax_dispute_events` — append-only audit log

Never updated or deleted. 7-year audit retention aligned with SARS compliance requirements.

---

## Backend — `tax-disputes.js`

### Endpoints

| Method | Route | Purpose |
|---|---|---|
| GET | `/summary` | Status counts, type counts, open count, overdue count |
| GET | `/` | Paginated list with full filter set + client name enrichment |
| POST | `/create-from-submission` | Create case sourced from a tax submission (auto-title, duplicate guard) |
| POST | `/create-from-sars-line` | Create case sourced from a SARS statement line (auto-title, duplicate guard) |
| POST | `/create-from-assessment` | Create case from an assessment reference |
| POST | `/` | General create (manual) |
| GET | `/:id` | Single case (enriched with client name) |
| PUT | `/:id` | Update non-status fields |
| DELETE | `/:id` | Soft cancel (blocked if completed) |
| PUT | `/:id/mark-submitted` | Status → submitted |
| PUT | `/:id/record-acknowledgement` | Status → acknowledged |
| PUT | `/:id/record-response` | Status → response_received |
| PUT | `/:id/accept` | Status → accepted (outcome fields) |
| PUT | `/:id/reject` | Status → rejected |
| PUT | `/:id/escalate` | Status → escalated (notes required) |
| PUT | `/:id/complete` | Status → completed (outcome fields) |
| GET | `/:id/evidence` | List evidence records |
| POST | `/:id/evidence` | Add evidence |
| DELETE | `/:id/evidence/:evidenceId` | Remove evidence |
| PUT | `/:id/evidence/:evidenceId/verify` | Verify evidence |
| GET | `/:id/events` | Append-only event log |

### State Machine

Terminal states: `completed`, `cancelled`. All action endpoints block transitions from terminal states. `_applyAction` helper enforces per-action `allowedFrom` constraints. Escalate is allowed from any non-terminal status.

### Duplicate Active Case Guard

`POST /`, `create-from-submission`, `create-from-sars-line` all check for an active (non-terminal) case with the same `company_id + client_id + source_type + source_id + case_type`. Returns HTTP 409 with `existing_case_id` if found.

### Multi-Tenant Safety

Every query scoped to `req.companyId`. `_verifyCase(id, cid)` and `_verifyEvidence(id, caseId, cid)` re-verify ownership before every action. Client ownership verified on create.

### Audit Events Written

| Event | Trigger |
|---|---|
| `dispute_case_created` | POST / and create-from-* helpers |
| `dispute_case_updated` | PUT /:id |
| `dispute_submitted` | PUT /:id/mark-submitted |
| `dispute_acknowledged` | PUT /:id/record-acknowledgement |
| `dispute_response_received` | PUT /:id/record-response |
| `dispute_accepted` | PUT /:id/accept |
| `dispute_rejected` | PUT /:id/reject |
| `dispute_escalated` | PUT /:id/escalate |
| `dispute_completed` | PUT /:id/complete |
| `dispute_case_cancelled` | DELETE /:id |
| `evidence_added` | POST /:id/evidence |
| `evidence_removed` | DELETE /:id/evidence/:evidenceId |
| `evidence_verified` | PUT /:id/evidence/:evidenceId/verify |

---

## Tax Submissions Backend — 3 New Status Endpoints (Codebox 44)

Added to `tax-submissions.js`:

- `PUT /:id/mark-correction-required` → `submission_status = 'correction_required'` (from any non-terminal status)
- `PUT /:id/mark-objection-required` → `submission_status = 'objection_required'` (from any non-terminal status)
- `PUT /:id/mark-completed` → `submission_status = 'completed'` (from any non-cancelled status)

These transition to statuses that were already defined in `SUBMISSION_STATUSES` but had no action endpoints. All three follow the existing `_writeEvent` + `auditFromReq` pattern.

---

## Integration

### Tax Submission Frontend Integration

`tax-submissions.js` detail footer (`_renderFooter`) now includes:

- **Mark Correction** button (shown for assessed/correction_required status): calls `PUT /mark-correction-required`
- **Mark Objection** button (shown for assessed/correction_required/objection_required status): calls `PUT /mark-objection-required`
- **Mark Completed** button (shown for all non-completed/cancelled status): calls `PUT /mark-completed`
- **Open Disputes ↗** link (always shown): navigates to `/practice/tax-disputes.html?submission_id=<id>`

### SARS Recon Frontend Integration

`sars-recon.js` line detail footer (`_renderFooter`) now includes:

- **+ Dispute Case** button: calls `POST /api/practice/tax-disputes/create-from-sars-line` with the current line ID. If 409 (duplicate), prompts to navigate to existing case.
- **Open Disputes ↗** link: navigates to `/practice/tax-disputes.html?source_type=sars_statement_line&source_id=<id>`

---

## Frontend — `tax-disputes.html` + `js/tax-disputes.js`

### Page

- Summary cards (Open Cases, Overdue, Submitted, Response Received, Completed, Cancelled) — clickable to filter
- Case type strip (Correction, Objection, NOO, ADR, Appeal, Tax Court, Manual Review) with counts — clickable to filter
- Filter bar: case type, status, priority, tax type, client ID, submission ID, date from/to, search, active-only checkbox
- Paginated cases table (Case #, Type, Status, Title, Client, Tax Type, Tax Year, Priority, Deadline — overdue highlighted in red)
- Create Case modal (all fields including source type, source ID, deadlines, priority)
- Case Detail modal: 3 tabs (Overview, Evidence, Events)
- Context-sensitive footer buttons based on current status
- Action modal (mark-submitted, record-acknowledgement, record-response, accept, reject, escalate, complete, add-evidence)

### No localStorage / KV

Zero usage of `localStorage`, `sessionStorage`, `indexedDB`, or `safeLocalStorage` in all new and modified files (confirmed via syntax check).

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/102_practice_tax_dispute_cases.sql` | 3 tables + triggers + all indexes |
| `backend/modules/practice/tax-disputes.js` | Backend router — 21 endpoints |
| `backend/frontend-practice/tax-disputes.html` | Frontend page |
| `backend/frontend-practice/js/tax-disputes.js` | Frontend IIFE (`td` prefix) |
| `docs/new-app/44_tax_disputes_corrections.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_44_tax_disputes.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/sars-statement-recon.js` | Patch 44A-2 (client enrichment in GET /lines) + 44A-4 (exclude ignored from variance) |
| `backend/frontend-practice/js/sars-recon.js` | Patch 44A-2 (client_name display) + dispute integration footer |
| `backend/modules/practice/tax-submissions.js` | 3 new status endpoints (mark-correction-required, mark-objection-required, mark-completed) |
| `backend/frontend-practice/js/tax-submissions.js` | Dispute integration buttons in _renderFooter |
| `backend/modules/practice/index.js` | Mount tax-disputes router |
| `backend/frontend-practice/js/layout.js` | Add "Tax Disputes" nav entry |
