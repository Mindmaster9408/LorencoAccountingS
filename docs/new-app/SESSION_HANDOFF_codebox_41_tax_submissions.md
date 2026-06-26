# Session Handoff — Codebox 41: Tax Submission Register + Evidence Tracking

> Date: 2026-06-23
> Status: COMPLETE — migration NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Migration 089

**Must be applied to Supabase before the frontend will work.**

Creates:
- `practice_tax_submissions` — main submission register (31+ fields, 11 indexes, updated_at trigger)
- `practice_tax_submission_evidence` — evidence items per submission (soft delete via `is_deleted`)
- `practice_tax_submission_events` — append-only audit log

No existing tables modified. Fully additive.

### Backend Router — `tax-submissions.js`

17 endpoints. Key route ordering: `/summary` and `/create-from-pipeline` registered before `/:id` routes.

Critical multi-tenant pattern: every action uses `_verifySubmission(id, cid)` or `_verifyEvidence(submissionId, evidenceId, cid)` — no cross-company access possible.

Duplicate prevention on `POST /create-from-pipeline`: returns 409 with existing ID if an active submission already exists for the same source + submission_type combination.

Status action endpoints enforce their own pre-conditions:
- `mark-submitted`: only from `draft`
- `record-acknowledgement`: only from `submitted`
- `record-assessment`: from `submitted` or `acknowledged`

Evidence is soft-deleted — `is_deleted = true`, never hard deleted. `GET /:id/evidence` always filters `is_deleted = false`.

### Pipeline Integration — `tax-pipeline.js` (frontend)

Added "Open Submission Register" link in `_renderDetail()` — only visible when `filing_stage === 'submitted'`. Link carries `source_type`, `source_id`, `tax_year` as URL params. No auto-creation. User explicitly creates from the register page.

### Frontend

`tax-submissions.html` + `js/tax-submissions.js`:
- Summary cards with click-to-filter
- Paginated register table (50 per page)
- Create modal (pre-filled from URL params if arriving from pipeline)
- 6-tab detail modal: Overview, Submission, Assessment, Evidence, Follow-up, Events
- Context-sensitive footer action buttons based on current status
- Evidence: Add, Verify, Soft-delete
- Cancel: prompt for reason, soft-sets status = 'cancelled'

### `index.js` + `layout.js`

Router mounted after tax-pipeline block. "Tax Submissions" nav entry added between "Tax Pipeline" and "Tax Config".

---

## Nothing Regressed

- All existing practice routers: untouched
- Pipeline backend (`tax-pipeline.js`): untouched
- Pipeline frontend (`tax-pipeline.html`): untouched
- Pipeline frontend JS: additive only — `_renderDetail()` gets one new block when `filing_stage === 'submitted'`
- Paytime: not touched

---

## IMPORTANT: Migration 089 Must Be Applied

Apply in Supabase SQL Editor → New Query → paste `089_practice_tax_submission_register.sql` → Run.

Expected: "Success. No rows returned"

---

## Testing Required

1. Apply migration 089
2. Navigate to `/practice/tax-submissions.html`
3. Summary cards render (all zeros for clean DB)
4. Click "+ New Submission" → create form opens
5. Fill in source type, source ID, submission type → Create
6. Open submission detail → 6 tabs render
7. From Overview tab, click "Mark Submitted" in footer → fill submitted_at → Save → status changes to submitted
8. Click "Record Acknowledgement" → fill in reference + date → Save → status = acknowledged
9. Click "Record Assessment" → fill outcome, amounts, payment due date → Save → status = assessed
10. Click "Add Evidence" → select type, fill title → Save → Evidence tab shows item
11. Click "Verify" on evidence item → badge changes to Verified
12. Click "Remove" on evidence → confirm → item disappears (soft deleted, not hard deleted)
13. Set follow-up: Follow-up tab → follow_up_required = Yes, set date
14. Events tab shows all actions in chronological order
15. Go to Tax Pipeline, open a submitted-stage item → "Open Submission Register" link appears → click → Submission page opens with create form pre-filled
16. Test `POST /create-from-pipeline` with same source+type twice — second attempt should return 409
17. Verify no localStorage/KV: devtools → Application → Storage shows no tax submission data
18. Log in as different company — verify no cross-company submissions visible

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Mark Submitted — submitted_by_team_member_id not exposed in action form
- Confirmed now: submitted_at, method, reference, evidence_summary are in the form
- Not yet: team member picker for submitted_by_team_member_id
- Risk: Low — field optional, can be updated via PUT /:id later
- Recommended: Add team member dropdown when team member list endpoint is available
```

```
FOLLOW-UP NOTE
- Area: submission_status transitions correction_required / objection_required / completed
- Confirmed now: These statuses exist in the DB and can be set via PUT /:id (general update)
- Not yet: Dedicated action buttons for these transitions (would require spec for when/why)
- Risk: Low — statuses are accessible via general PUT; action buttons are a UX enhancement
- Recommended: Add "Mark Correction Required", "Mark Objection Required", "Mark Completed" to footer in Codebox 42 or later
```

```
FOLLOW-UP NOTE
- Area: responsible_team_member_id — shown as "#ID" not name
- Same limitation as pipeline board — no team member name enrichment yet
- Risk: Low — functional but not ideal for UX
- Recommended: Add name enrichment when team member endpoint is available
```

---

## Recommended Codebox 42

**Tax Payment Tracking + SARS Statement Reconciliation Foundation**

After assessment records exist (amount_payable, payment_due_date), the practice needs:
- Payment tracking per submission (payment reference, payment date, proof note)
- SARS account balance notes
- Refund tracking with expected vs received date
- Statement reconciliation readiness (manual input of SARS statement data)
- Payment follow-up queue

No SARS API required. All manual entry, linked to `practice_tax_submissions.amount_payable` and `payment_due_date`.
