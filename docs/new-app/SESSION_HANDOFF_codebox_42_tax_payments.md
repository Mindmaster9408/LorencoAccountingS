# Session Handoff — Codebox 42: Tax Payment Tracking + SARS Statement Reconciliation Foundation

> Date: 2026-06-30
> Status: COMPLETE — migration NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Migration 100

**Must be applied to Supabase before the frontend will work.**

Creates:
- `practice_tax_payments` — payment case register (direction: payable/refundable; running ledger columns; status state machine; `updated_at` trigger `tg_ptp_updated_at`)
- `practice_tax_payment_events` — append-only ledger of every payment/refund/interest/penalty/creation/cancellation movement, with `balance_before`/`balance_after` recorded on each row

No existing tables modified. Fully additive. Linked to `practice_tax_submissions` via plain INTEGER `submission_id` (no FK constraint), matching the existing cross-table convention from migration 089 — ownership is verified in application code, not the database.

### Backend Router — `tax-payments.js`

11 endpoints: `GET /summary`, `GET /`, `POST /`, `GET /:id`, `PUT /:id`, `DELETE /:id` (soft cancel only), `PUT /:id/record-payment`, `PUT /:id/record-refund`, `PUT /:id/add-interest`, `PUT /:id/add-penalty`, `GET /:id/events`.

Critical multi-tenant pattern: every action uses `_verifyPayment(id, cid)` or `_verifySubmission(submissionId, cid)` — no cross-company access possible. `_verifySubmission` also derives `client_id`/`tax_year` from the submission rather than trusting client-supplied values.

All four ledger-movement endpoints (record-payment, record-refund, add-interest, add-penalty) share one internal handler, `_applyLedgerMovement`, with balance/status derivation centralized in `_recalcBalance`/`_deriveStatus` — single source of truth, no duplicated math.

Cancellation (`DELETE /:id`) is blocked with an error if `amount_settled > 0` — a case with any money already moved through it cannot be soft-cancelled, it must be resolved through the normal ledger instead.

### Submission Register Integration — `tax-submissions.js` (frontend)

Added a 5th tab, **Payments**, to the existing 4-tab (now 5-tab) submission detail modal. Fetches `GET /api/practice/tax-payments?submission_id=<id>`:
- No case yet + submission has `amount_payable`/`refund_amount` → one-click "Create Payable/Refundable Case" button, pre-filled amount
- Case exists → shows direction, status, original/settled/balance, due date
- Always links to `/practice/tax-payments.html?submission_id=<id>` for full management

### Pipeline Integration — `tax-pipeline.js` (backend + frontend)

Backend: new `_fetchPaymentSummary(sourceType, sourceId, cid)` helper, called only when `filing_stage === 'completed'`. Looks up the latest linked submission, then any payment cases against it, returns as `payment_summary` in the pipeline detail response — both queries scoped to `company_id`.

Frontend: renders a "Payment Summary" section in the detail modal (mirrors the existing Submission Register link pattern) when `filing_stage === 'completed'`, with status pills and a link to the full Payment Register.

### Frontend — `tax-payments.html` + `js/tax-payments.js`

- Summary cards (status counts, total outstanding payable, total pending refund, overdue count) with click-to-filter
- Filter bar: direction, status, tax year, submission ID (auto-applied from `?submission_id=` URL param)
- Payment case table
- Create modal (submission ID, direction, original amount, due date, notes)
- Detail modal, 2 tabs: Overview, Events
- Context-sensitive footer: Record Payment / Add Interest / Add Penalty (payable), Record Refund (refundable), Edit, Cancel Case (only when `amount_settled == 0`)

### `index.js` + `layout.js`

Router mounted in `modules/practice/index.js`. "Tax Payments" nav entry added between "Tax Submissions" and "Tax Config" in `layout.js`.

---

## Bug Found and Fixed (Out of Original Scope): `LAYOUT.onReady`

`tax-submissions.js` and `tax-pipeline.js` (both already-shipped in Codeboxes 40/41) call `LAYOUT.onReady(callback)` on `DOMContentLoaded`. `layout.js` never defined `onReady` — only `init` was exported. This call would throw `TypeError: LAYOUT.onReady is not a function`, meaning `tslLoad()` and `tplLoad()` never ran automatically — **both the Tax Submissions and Tax Pipeline pages have never auto-populated their data since they shipped**, independent of anything in this session.

Fixed by adding a trivial synchronous `onReady(cb) { cb(); }` to `layout.js` and exporting it: `window.LAYOUT = { init: init, onReady: onReady };`. Purely additive — `init()` itself untouched. `tax-payments.js` was written to use the same (now-working) convention.

**This needs to be verified in a live browser as part of testing** — see Testing Required below. It was not possible to confirm in this environment (no browser tooling available), only confirmed by static reading of `layout.js` plus `git show HEAD:...` showing the broken call sites predate this session.

---

## Nothing Else Regressed

- All existing practice routers: untouched
- `practice_tax_submissions` schema and existing `tax-submissions.js` endpoints: untouched (only additive tab + 1 new export)
- Pipeline backend: only additive (`_fetchPaymentSummary` is a new function; existing route handler gained one new field on the response object)
- Pipeline frontend: only additive (new block in `_renderDetail`, new CSS classes)
- Paytime: not touched
- No `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` usage anywhere in new or modified files (confirmed via grep — zero matches)

---

## IMPORTANT: Migration 100 Must Be Applied

Apply in Supabase SQL Editor → New Query → paste `100_practice_tax_payment_tracking.sql` → Run.

Expected: "Success. No rows returned"

---

## Testing Required

**None of the following has been executed in a live browser in this session — no browser testing tool is available in this environment. All verification below was code-review and `node --check` syntax-validation only. This must be treated as untested until manually clicked through.**

1. Apply migration 100
2. Navigate to `/practice/tax-submissions.html` and `/practice/tax-pipeline.html` — confirm summary cards and tables now populate automatically on page load (validates the `LAYOUT.onReady` fix; previously these pages likely appeared stuck on "Loading…")
3. Navigate to `/practice/tax-payments.html` directly — confirm summary cards + table load with no `submission_id` filter
4. From a submission with `amount_payable` set, open its detail → Payments tab → click "Create Payable Case" → confirm case appears, amount pre-filled correctly
5. Open the new case in the Payment Register → Record Payment (partial amount) → confirm `balance_outstanding` decreases correctly and status becomes `partially_paid`
6. Record a second payment that brings settled = original → confirm status becomes `paid_in_full`
7. Record a payment that overshoots → confirm status becomes `overpaid` and balance goes negative as expected
8. Create a refundable case from a submission's `refund_amount` → Record Refund (partial, then full) → confirm `refund_pending` → `refund_received` transition
9. Add Interest and Add Penalty on a payable case → confirm `interest_accrued`/`penalty_accrued` increase and balance recalculates to include both
10. Open Events tab → confirm every action above appears in order with correct `balance_before`/`balance_after`
11. Attempt to Cancel a case with `amount_settled > 0` → confirm blocked with an error
12. Cancel a fresh case with `amount_settled == 0` → confirm soft-cancel, status becomes `cancelled`, case excluded from active filters where applicable
13. From Tax Pipeline, open a `completed`-stage item with a linked submission and payment case → confirm "Payment Summary" section renders with correct status pill and balance, and the link opens the Payment Register filtered to that submission
14. Log in as a different company — verify zero cross-company payment cases, events, or summary figures are visible
15. DevTools → Application → Storage — confirm no payment data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: LAYOUT.onReady fix
- Confirmed now: onReady added to layout.js, additive only, node --check passes on all touched files
- Not yet confirmed: Live browser verification that tax-submissions.html and tax-pipeline.html now actually auto-load (item 2 in Testing Required)
- Risk if wrong: If onReady's synchronous-callback assumption is ever invalidated by a future async init() change, both pages silently break again
- Recommended next check: Manual browser test immediately after migration 100 is applied; if init() ever becomes async, onReady must be updated to wait for completion
```

```
FOLLOW-UP NOTE
- Area: Payment case creation — no duplicate-prevention check
- Confirmed now: POST / will create a new payment case for the same submission_id+direction even if one already exists (unlike tax-submissions.js's create-from-pipeline 409 pattern)
- Not yet: Any guard against accidentally creating two payable cases for the same submission
- Risk: Medium — could create confusing duplicate ledgers if a user double-clicks "Create Case" or reopens the tab
- Recommended: Add a uniqueness check (active case per submission_id+direction) in Codebox 43, mirroring the 409 pattern from Codebox 41
```

```
FOLLOW-UP NOTE
- Area: responsible/actor identification on events
- Same limitation as Codebox 41 — `actor_user_id` is stored but not enriched with a display name in the Events tab UI
- Risk: Low — functional but not ideal for UX
- Recommended: Add name enrichment when a team member lookup endpoint is available (same follow-up carried from Codebox 41)
```

---

## Recommended Codebox 43

**SARS Statement Reconciliation**

Now that manual payment cases and an append-only event ledger exist, the practice needs a way to reconcile this manual register against an actual SARS account statement:
- Manual entry of SARS statement lines (date, description, amount, reference) per client/tax type
- Matching UI: suggest matches between statement lines and `practice_tax_payment_events`, allow manual confirm/reject
- Variance report: payments recorded in the register with no matching statement line (and vice versa)
- Still no SARS API — all statement data is manually entered or manually pasted in
- Duplicate-prevention guard on payment case creation (see Follow-Up Notes above) should be picked up here or earlier if it surfaces in testing
