# Session Handoff — Codebox 43: SARS Statement Reconciliation + Payment Case Duplicate Guard

> Date: 2026-06-30
> Status: COMPLETE — migration NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Patch 43A — Duplicate Prevention (tax-payments.js backend)

`POST /api/practice/tax-payments` now checks for an existing active case with the same `company_id + submission_id + direction + status != 'cancelled'` before inserting. Returns HTTP 409 with the existing case ID if found. Additive only — all other validation and logic unchanged.

### Migration 101

**Must be applied to Supabase before the frontend will work.**

Creates:
- `practice_sars_statement_lines` — manual SARS statement register (tax_type, transaction_type, debit/credit amounts, running_balance, reconciliation_status; `matched_payment_event_id` links to `practice_tax_payment_events`; `tg_pssl_updated_at` trigger)
- `practice_sars_statement_reconciliation_events` — append-only audit log of all reconciliation actions

No existing tables modified. Fully additive.

### Backend Router — `sars-statement-recon.js`

11 endpoints on `/api/practice/sars-recon`. All routes scoped to `company_id`. `_verifyLine` + `_verifyPaymentEvent` re-verify ownership before every action.

Match logic: checks directional coherence between SARS line (debit/credit) and payment event type (payment_recorded/refund_recorded). Mismatch without notes → HTTP 422 with `code: DIRECTION_MISMATCH`. Mismatch with notes → allowed (manual override, audited).

Cancel blocked if status = matched — must unmatch first.

Dispute requires notes. Ignore does not.

`GET /payment-events/unmatched` returns `payment_recorded`/`refund_recorded` events from `practice_tax_payment_events` that have no `matched_payment_event_id` pointing to them in `practice_sars_statement_lines` — this drives the unmatched events panel on the frontend.

### `index.js` + `layout.js`

Router mounted after tax-payments block. "SARS Recon" nav entry added between "Tax Payments" and "Tax Config".

### Frontend — `sars-recon.html` + `js/sars-recon.js`

- Summary cards + variance strip (total debits, credits, variance, unmatched counts)
- Statement lines table with full filter bar (auto-applies URL params: submission_id, payment_id, client_id)
- Add line modal, detail modal (Overview + Events tabs), match modal, action modal
- Unmatched practice events panel (refreshable, shows all unmatched payment events as event cards)
- SARS Recon ↗ link added to tax-payments.js detail footer and tax-submissions.js Payments tab

---

## Nothing Regressed

- All existing practice routers: untouched
- Patch 43A in tax-payments.js: additive guard only — no existing logic modified
- tax-submissions.js: additive only — one extra link in `_renderPaymentsTab`
- tax-payments.js frontend: additive only — one extra link in `_renderFooter`
- Paytime: not touched
- No `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` in new or modified files (confirmed via grep)

---

## IMPORTANT: Migration 101 Must Be Applied

Apply in Supabase SQL Editor → New Query → paste `101_practice_sars_statement_reconciliation.sql` → Run.

Expected: "Success. No rows returned"

Note: Migration 100 (Codebox 42) must also be applied first if it has not been already.

---

## Testing Required

**None of the following has been browser-tested. No browser tooling is available in this environment. All verification was code-review and `node --check` syntax-validation only. Treat as untested until manually clicked through.**

1. Apply migrations 100 (if not yet done) and 101
2. Verify Tax Submissions and Tax Pipeline pages auto-load (LAYOUT.onReady fix from Codebox 42 — the first live test of this fix)
3. Test Patch 43A: open Tax Payments → create a payable case for a submission → try creating a second payable case for the same submission → confirm 409 is returned with `existing_payment_id`
4. Navigate to `/practice/sars-recon.html` — summary cards load, table loads empty
5. Add a statement line (debit transaction, manual amount) → confirm it appears as Unmatched
6. Open the line detail → Match to Event → enter a payment event ID from the unmatched events panel → confirm status becomes Matched and the event disappears from the unmatched panel
7. Open the same line → Unmatch → confirm status returns to Unmatched and event reappears in panel
8. Add a second line → Dispute (with notes) → confirm status becomes Disputed and it appears in disputed count
9. Add a third line → Ignore → confirm status becomes Ignored
10. Add a fourth line → Cancel Line → confirm soft-cancel (status = cancelled, excluded from debits/credits totals)
11. Try cancelling a Matched line → confirm it is blocked with an error
12. Try matching a credit line to a payment_recorded event without notes → confirm 422 direction mismatch error
13. Provide notes on the same mismatch → confirm match succeeds with warnings in response
14. Open Tax Payments → open any payment case detail → confirm SARS Recon ↗ link is present and goes to the correct filtered URL
15. Open Tax Submissions → open any submission → Payments tab → confirm SARS Recon ↗ link is present
16. Log in as different company — verify zero cross-company statement lines or reconciliation events
17. DevTools → Application → Storage — confirm no recon data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Partial matching not fully implemented
- Confirmed now: reconciliation_status includes 'partially_matched' and the match endpoint sets 'matched' only
- Not yet: A UI flow or endpoint to set 'partially_matched' with a partial amount (e.g. one statement line covers two payment events)
- Risk: Low — partially_matched is accessible via PUT /lines/:id for manual override; the enum is in place
- Recommended: Add partial-match flow in Codebox 44 or later if the practice needs to split a statement line across multiple events
```

```
FOLLOW-UP NOTE
- Area: Variance computation — does not yet subtract ignored lines from totals
- Confirmed now: total_sars_debits / total_sars_credits include ALL non-cancelled lines (including ignored ones)
- Not yet: Decision on whether ignored lines should be excluded from totals
- Risk: Low — "ignored" is a minority status; accountants will know what to expect
- Recommended: Review with a practitioner — either change the filter in the summary or make it configurable
```

```
FOLLOW-UP NOTE
- Area: Client ID display in table — shows raw integer, not client name
- Same limitation as tax-payments.js
- Risk: Low — functional but not ideal for UX
- Recommended: Add client name enrichment via a batch lookup on GET /lines response when the client endpoint is readily available
```

---

## Recommended Codebox 44

**Tax Assessment Objection + Correction Workflow Foundation**

After assessments and SARS statement differences exist, the practice needs:
- Correction required workflow (with due dates, evidence, responsible team member)
- Objection required workflow (NOO, ADR, Tax Court escalation levels)
- Dedicated action buttons in the Tax Submission detail ("Mark Correction Required", "Mark Objection Required", "Mark Completed") — flagged as a follow-up since Codebox 41 (Codebox 41 handoff, section "Follow-Up Notes")
- Dispute notes and deadline tracking per objection
- Evidence tracking for objection submissions
- No SARS API — all manual tracking
