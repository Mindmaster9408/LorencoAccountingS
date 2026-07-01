# Codebox 42 — Tax Payment Tracking + SARS Statement Reconciliation Foundation

> Module: Practice Management — Tax Payments
> Status: Complete (migration not yet applied to Supabase)
> Migration: 100 (must be applied to Supabase)
> Routes: `/api/practice/tax-payments/*`

---

## Purpose

A manual tax payment register linked to the Tax Submission Register (Codebox 41). Tracks amounts payable to SARS and refunds due from SARS per submission, payments/refunds actually received, interest, penalties, and running balances.

**This is NOT SARS integration. This is NOT bank reconciliation. This is NOT automatic payment importing. Everything is manually entered by practice staff.** It is a foundation: a clean, auditable manual ledger that a future SARS-statement-reconciliation feature could reconcile against — but no such reconciliation exists yet.

---

## Migration 100

### `practice_tax_payments` — one row per payable/refundable obligation

Linked to `practice_tax_submissions` via `submission_id` (plain INTEGER, no FK constraint — matches the cross-table convention established in migration 089, since ownership is verified in application code via `_verifySubmission`).

| Constraint | Values |
|---|---|
| `direction` | `payable`, `refundable` |
| `status` | `outstanding`, `partially_paid`, `paid_in_full`, `overpaid`, `refund_pending`, `refund_received`, `cancelled` |

Running ledger columns (`original_amount`, `interest_accrued`, `penalty_accrued`, `amount_settled`, `balance_outstanding`) are maintained exclusively by the backend — never recalculated ad hoc, never written to directly by the frontend. Auto-updates `updated_at` via trigger `tg_ptp_updated_at`.

### `practice_tax_payment_events` — append-only ledger

One row per payment, refund, interest, or penalty movement, plus case creation/cancellation. Never updated or deleted — full audit trail per SARS 7-year retention requirement. Records `balance_before`/`balance_after` on every movement so the ledger history is independently reconstructable.

---

## Backend — `tax-payments.js`

### Endpoints

| Method | Route | Purpose |
|---|---|---|
| GET | `/summary` | Status counts + total outstanding payable + total pending refund + overdue count |
| GET | `/` | List with filters: `client_id`, `submission_id`, `tax_year`, `direction`, `status` |
| POST | `/` | Create a payment case from a submission |
| GET | `/:id` | Single payment case |
| PUT | `/:id` | Update non-financial fields only (`due_date`, `notes`, `internal_notes`) |
| DELETE | `/:id` | Soft cancel only — blocked if `amount_settled > 0` |
| PUT | `/:id/record-payment` | Payable cases only — adds to `amount_settled` |
| PUT | `/:id/record-refund` | Refundable cases only — adds to `amount_settled` |
| PUT | `/:id/add-interest` | Payable cases only — adds to `interest_accrued` |
| PUT | `/:id/add-penalty` | Payable cases only — adds to `penalty_accrued` |
| GET | `/:id/events` | Append-only event log for the case |

### Ledger Logic

All four ledger-movement endpoints share one internal handler, `_applyLedgerMovement`, so balance recalculation and status derivation have a single source of truth (`_recalcBalance`, `_deriveStatus`):

```
payable:    balance = original_amount + interest_accrued + penalty_accrued - amount_settled
refundable: balance = original_amount - amount_settled
```

### Status Derivation

```
payable:    outstanding → partially_paid → paid_in_full   (balance < 0 → overpaid)
refundable: refund_pending → refund_received               (balance <= 0)
both:       → cancelled (soft delete, only when amount_settled == 0)
```

### Multi-Tenant Safety

- Every query is scoped to `req.companyId` (`.eq('company_id', cid)`), including the events table and the summary aggregation.
- `_verifyPayment(id, cid)` re-verifies company ownership before every read/update/cancel/ledger-movement action.
- `_verifySubmission(submissionId, cid)` re-verifies the linked submission belongs to the same company before a payment case can be created against it, and derives `client_id`/`tax_year` from the submission rather than trusting client input.

### Audit Events Written

| Event | Trigger |
|---|---|
| `payment_created` | POST / |
| `UPDATE` | PUT /:id |
| `payment_recorded` | PUT /:id/record-payment |
| `refund_recorded` | PUT /:id/record-refund |
| `interest_added` | PUT /:id/add-interest |
| `penalty_added` | PUT /:id/add-penalty |
| `tax_payment_cancelled` | DELETE /:id |

---

## Submission Register Integration

`tax-submissions.js` (frontend) gained a 5th tab, **Payments**, in the submission detail modal. It calls `GET /api/practice/tax-payments?submission_id=<id>` and:

- If no payment case exists yet and the submission has `amount_payable` or `refund_amount` set, shows a one-click "Create Payable/Refundable Case" button pre-filled with that amount.
- If a case exists, shows direction, status, original/settled/balance amounts, and due date.
- Always links out to `/practice/tax-payments.html?submission_id=<id>` for full management (record payment/refund, add interest/penalty, view events).

## Pipeline Integration

`tax-pipeline.js` (backend) gained a read-only lookup, `_fetchPaymentSummary`, fired only when `filing_stage === 'completed'`. It finds the latest linked `practice_tax_submissions` row by `source_type`+`source_id`, then any payment cases against it, and returns them as `payment_summary` in the pipeline detail response.

`tax-pipeline.js` (frontend) renders this as a "Payment Summary" section in the detail modal — mirroring the existing "Submission Register" link block pattern — showing each case's status pill, direction, and balance, with a link to the full Payment Register.

---

## Frontend — `tax-payments.html` + `js/tax-payments.js`

### Page

- Summary cards (status counts + total outstanding payable + total pending refund + overdue count; click-to-filter by status)
- Filter bar: direction, status, tax year, submission ID
- Payment case table
- Create modal (submission ID, direction, original amount, due date, notes)
- Detail modal with 2 tabs: Overview, Events
- Context-sensitive footer actions: Record Payment / Add Interest / Add Penalty (payable cases), Record Refund (refundable cases), Edit, Cancel Case (only when `amount_settled == 0`)

### No localStorage / KV

All state is API-fetched on demand. `_currentItem` and `_currentId` are runtime-only JS variables. No `localStorage`, `sessionStorage`, or `safeLocalStorage` used anywhere in this feature.

---

## Pre-Existing Bug Found and Fixed: `LAYOUT.onReady`

While wiring up the boot sequence for the new page, an audit of `layout.js` found that `tax-submissions.js` and `tax-pipeline.js` (both from earlier, already-shipped Codeboxes) call `LAYOUT.onReady(callback)` on `DOMContentLoaded`, but `layout.js` only ever exported `{ init }` — `onReady` did not exist. This meant the call threw a `TypeError` on every page load of Tax Submissions and Tax Pipeline, silently preventing `tslLoad()` / `tplLoad()` from ever running — i.e. both pages' summary cards and tables never populated automatically (most likely surfaced to a user as "stuck on Loading…" indefinitely, until a manual filter action triggered a load).

**Fix applied:** added a trivial `onReady(cb)` function to `layout.js` (since `init()` is fully synchronous, it just invokes the callback immediately) and exported it on the `LAYOUT` object. This is additive only — no existing behavior was changed, and it makes the already-written calling code in both prior Codeboxes work as originally intended. `tax-payments.js` uses the same now-working convention for consistency.

This was not part of the Codebox 42 spec but blocks Codebox 42's own deliverable (the page would never load), and it was a regression affecting Codeboxes 40/41 from the moment they shipped — see `SESSION_HANDOFF_codebox_42_tax_payments.md` for the full flag.

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/100_practice_tax_payment_tracking.sql` | 2 tables + trigger + all indexes |
| `backend/modules/practice/tax-payments.js` | Backend router — 11 endpoints |
| `backend/frontend-practice/tax-payments.html` | Frontend page |
| `backend/frontend-practice/js/tax-payments.js` | Frontend IIFE |
| `docs/new-app/42_tax_payment_tracking.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_42_tax_payments.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/index.js` | Mount `tax-payments` router |
| `backend/frontend-practice/js/layout.js` | Add "Tax Payments" nav entry; add missing `onReady` (bug fix, see above) |
| `backend/frontend-practice/js/tax-submissions.js` | Add "Payments" tab to submission detail modal |
| `backend/modules/practice/tax-pipeline.js` | Add `_fetchPaymentSummary` lookup, included in detail response when completed |
| `backend/frontend-practice/js/tax-pipeline.js` | Render "Payment Summary" section in detail modal when completed |
| `backend/frontend-practice/tax-pipeline.html` | Add `.pay-pill`/`.pay-*` CSS classes for payment status pills |
