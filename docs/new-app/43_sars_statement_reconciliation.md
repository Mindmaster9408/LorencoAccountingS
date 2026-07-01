# Codebox 43 — SARS Statement Reconciliation + Payment Case Duplicate Guard

> Module: Practice Management — SARS Recon
> Status: Complete (migration not yet applied to Supabase)
> Migration: 101 (must be applied to Supabase)
> Routes: `/api/practice/sars-recon/*`
> Patch 43A: `/api/practice/tax-payments` POST — duplicate guard

---

## Purpose

Allows practice staff to manually capture SARS statement lines (from eFiling account statements, SARS correspondence, or assessments) and reconcile them against the practice's own payment ledger events (Codebox 42). Produces a variance view — unmatched statement lines, unmatched practice events, total debits, total credits.

**This is NOT SARS API. NOT bank feed integration. NOT automatic statement import. All data is manually entered by practice staff.** It is the reconciliation layer above the manual payment register (Codebox 42), not a connection to SARS systems.

**Patch 43A** fixes a duplicate-prevention gap in the Codebox 42 payment router: `POST /api/practice/tax-payments` previously allowed a second active case with the same `submission_id + direction`. It now returns HTTP 409 with the existing case ID.

---

## Patch 43A — Duplicate Prevention (tax-payments.js)

Added an active-case check in `POST /api/practice/tax-payments` after `_verifySubmission` succeeds:

```
SELECT id FROM practice_tax_payments
WHERE company_id = cid
  AND submission_id = sid
  AND direction = direction
  AND status != 'cancelled'
LIMIT 1
```

If a row exists → return HTTP 409 `{ code: 'DUPLICATE_PAYMENT_CASE', existing_payment_id }`. The insert does not proceed. Multi-tenant safe — scoped to `company_id`.

---

## Migration 101

### `practice_sars_statement_lines` — one row per SARS statement line

Linked to `practice_tax_submissions` via `submission_id` and to `practice_tax_payments` via `payment_id` — both plain INTEGER, no FK constraint, matching the established cross-table convention from migrations 089 and 100. Ownership verified in application code.

| Constraint | Values |
|---|---|
| `tax_type` | `itr12`, `itr14`, `irp6`, `emp201`, `emp501`, `vat201`, `other` |
| `transaction_type` | `assessment`, `payment`, `refund`, `interest`, `penalty`, `adjustment`, `balance`, `other` |
| `reconciliation_status` | `unmatched`, `matched`, `partially_matched`, `disputed`, `ignored`, `cancelled` |

Stores `debit_amount` and `credit_amount` separately to mirror the SARS statement format (only one is usually non-zero per line). `running_balance` is optional — only when the SARS statement shows it.

`matched_payment_event_id` links to a `practice_tax_payment_events.id` row. `matched_at`/`matched_by` record who matched it and when.

Auto-updates `updated_at` via trigger `tg_pssl_updated_at`.

### `practice_sars_statement_reconciliation_events` — append-only audit log

One row per reconciliation action (create, match, unmatch, dispute, ignore, cancel). Never updated or deleted. Same append-only pattern as `practice_tax_payment_events`.

---

## Backend — `sars-statement-recon.js`

### Endpoints

| Method | Route | Purpose |
|---|---|---|
| GET | `/summary` | Status counts + total debits + credits + variance + unmatched line/event counts |
| GET | `/lines` | List with filters: client_id, submission_id, payment_id, tax_type, transaction_type, status, date_from, date_to, search |
| POST | `/lines` | Create a statement line (manual entry) |
| GET | `/lines/:id` | Single line |
| PUT | `/lines/:id` | Update non-status fields only |
| DELETE | `/lines/:id` | Soft cancel — blocked if status = matched |
| POST | `/lines/:id/match-payment-event` | Match to a practice payment event |
| POST | `/lines/:id/unmatch` | Remove match, return to unmatched |
| POST | `/lines/:id/dispute` | Mark as disputed (notes required) |
| POST | `/lines/:id/ignore` | Mark as ignored |
| GET | `/lines/:id/events` | Append-only event log for the line |
| GET | `/payment-events/unmatched` | Payment ledger events not yet matched to any statement line |

### Match Logic

`POST /lines/:id/match-payment-event`:
- Verifies both the statement line and the payment event belong to this company.
- Checks directional coherence: SARS debit → expect `payment_recorded`; SARS credit → expect `refund_recorded`. A mismatch does **not** hard-block — but if notes are absent, the endpoint returns HTTP 422 with `code: DIRECTION_MISMATCH` asking for explicit confirmation via notes. If notes are provided, the match proceeds.
- Sets `reconciliation_status = 'matched'`, `matched_payment_event_id`, `matched_at`, `matched_by`.
- No automatic matching. Every match requires an explicit user action.

### Variance Logic

`GET /summary` computes:
- `total_sars_debits` / `total_sars_credits` — sum of debit/credit amounts across all non-cancelled lines.
- `variance` = credits − debits (positive = SARS owes more; negative = practice owes more).
- `unmatched_line_count` — lines with status `unmatched`.
- `unmatched_event_count` — `payment_recorded` / `refund_recorded` events from `practice_tax_payment_events` with no matched statement line.

### Multi-Tenant Safety

- Every query scoped to `req.companyId`.
- `_verifyLine(id, cid)` re-checks company ownership before every read/update/cancel/action.
- `_verifyPaymentEvent(eventId, cid)` re-checks the payment event's `company_id` before any match.
- Client, submission, and payment ownership verified on POST /lines before insert.

### Audit Events Written

| Event | Trigger |
|---|---|
| `sars_statement_line_created` | POST /lines |
| `sars_statement_line_updated` | PUT /lines/:id |
| `sars_statement_line_matched` | POST /lines/:id/match-payment-event |
| `sars_statement_line_unmatched` | POST /lines/:id/unmatch |
| `sars_statement_line_disputed` | POST /lines/:id/dispute |
| `sars_statement_line_ignored` | POST /lines/:id/ignore |
| `sars_statement_line_cancelled` | DELETE /lines/:id |

---

## Payment Register Integration

`tax-payments.js` (frontend) `_renderFooter` now includes a **SARS Recon ↗** link in every payment case detail footer, pointing to `/practice/sars-recon.html?payment_id=<id>&client_id=<client_id>`. The recon page auto-applies this filter via `_checkUrlParams()`.

## Submission Register Integration

`tax-submissions.js` (frontend) Payments tab now includes a **SARS Recon ↗** link alongside the existing "Open Payment Register" link, pointing to `/practice/sars-recon.html?submission_id=<id>`.

---

## Frontend — `sars-recon.html` + `js/sars-recon.js`

### Page

- Summary cards (status counts, click-to-filter by status)
- Variance strip (SARS total debits, SARS total credits, variance, unmatched line count, unmatched event count)
- Filter bar: tax type, transaction type, status, date from/to, search, client ID, submission ID
- Statement lines table with columns: Date, Client ID, Tax Type, Transaction, Reference, Description, Debit, Credit, Balance, Status, Matched Event
- URL params auto-applied on load (`submission_id`, `payment_id`, `client_id` from querystring)
- Add Statement Line modal
- Detail modal, 2 tabs: Overview (all line fields), Events (reconciliation event log)
- Context-sensitive footer: Match to Event, Unmatch, Dispute, Ignore, Edit, Cancel Line
- Match modal (payment event ID + notes for direction-mismatch confirmation)
- Action modal (dispute / ignore / unmatch / edit forms)
- Unmatched Practice Events panel at the bottom — shows all `payment_recorded`/`refund_recorded` events not yet matched to any statement line

### No localStorage / KV

Zero usage of `localStorage`, `sessionStorage`, `indexedDB`, or `safeLocalStorage` in all new and modified files (confirmed via grep).

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/101_practice_sars_statement_reconciliation.sql` | 2 tables + trigger + all indexes |
| `backend/modules/practice/sars-statement-recon.js` | Backend router — 11 endpoints |
| `backend/frontend-practice/sars-recon.html` | Frontend page |
| `backend/frontend-practice/js/sars-recon.js` | Frontend IIFE |
| `docs/new-app/43_sars_statement_reconciliation.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_43_sars_recon.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/tax-payments.js` | Patch 43A: duplicate guard on POST / |
| `backend/modules/practice/index.js` | Mount `sars-statement-recon` router |
| `backend/frontend-practice/js/layout.js` | Add "SARS Recon" nav entry |
| `backend/frontend-practice/js/tax-payments.js` | Add SARS Recon link to payment case detail footer |
| `backend/frontend-practice/js/tax-submissions.js` | Add SARS Recon link to Payments tab |
