# Session Handoff — Codebox 44: Tax Dispute / Correction / Objection Workflow Foundation

> Date: 2026-07-01
> Status: COMPLETE — migrations NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Patch 44A — Four Improvements Across Existing Modules

**44A-1: LAYOUT.onReady (Code Review Only)**
Confirmed via code review: `layout.js` line 90 has `function onReady(cb) { cb(); }`. The Codebox 42 fix is intact. No change needed.

**44A-2: Client Name Enrichment in SARS Recon**
`GET /api/practice/sars-recon/lines` now batch-fetches client names from `practice_clients` after loading lines and returns `client_name` on each row. `sars-recon.js` frontend updated: table column and detail overview now display `client_name` with fallback to `#client_id`.

**44A-3: Partial Match (Deferred)**
Evaluated as medium-risk (no `matched_amount` field in schema, no UI design for partial splits). Deferred to Codebox 45. `partially_matched` status remains available via `PUT /lines/:id` for manual override.

**44A-4: Exclude Ignored Lines from Variance Totals**
`GET /api/practice/sars-recon/summary` now excludes both `cancelled` and `ignored` lines from `total_sars_debits` / `total_sars_credits`. Previously only `cancelled` was excluded.

---

### Migration 102

**Must be applied to Supabase before the frontend will work.**

Creates:
- `practice_tax_dispute_cases` — main case register; 12-status state machine; `tg_ptdc_updated_at` trigger; 7 indexes including partial index on active cases
- `practice_tax_dispute_evidence` — supporting documents per case; `tg_ptde_updated_at` trigger
- `practice_tax_dispute_events` — append-only audit log; 3 indexes

No existing tables modified. Fully additive.

---

### Backend Router — `tax-disputes.js`

21 endpoints on `/api/practice/tax-disputes`. All routes scoped to `company_id`.

Key behaviours:
- Duplicate guard on all create paths (409 with `existing_case_id` if active non-terminal case exists with same client_id + source_type + source_id + case_type)
- `_applyAction` shared helper enforces terminal state blocks and `allowedFrom` constraints
- Escalate requires notes (returns 400 if absent)
- Evidence: hard-delete (not soft-cancel — evidence is a document log, not a financial record)
- Create-from-submission, create-from-sars-line, create-from-assessment: auto-generate title from source data; verify source ownership before insert
- Client name enrichment via `_enrichWithClientNames` on all list and single-case endpoints

---

### Tax Submissions Backend — 3 New Endpoints

`PUT /:id/mark-correction-required` → `submission_status = 'correction_required'`
`PUT /:id/mark-objection-required` → `submission_status = 'objection_required'`
`PUT /:id/mark-completed` → `submission_status = 'completed'`

These complete the status machine for `SUBMISSION_STATUSES` (which already listed these values but had no transition endpoints).

---

### `index.js` + `layout.js`

`tax-disputes` router mounted after sars-recon block. "Tax Disputes" nav entry added between "SARS Recon" and "Tax Config".

---

### Frontend — `tax-disputes.html` + `js/tax-disputes.js`

- Summary cards + type strip with click-to-filter
- Full filter bar (8 filters + active-only checkbox) + pagination
- Case table (overdue deadlines highlighted in red)
- Create Case modal (all fields)
- Case Detail modal: Overview / Evidence / Events tabs
- Context-sensitive footer buttons (mark-submitted, record-acknowledgement, record-response, accept, reject, escalate, complete, add-evidence, cancel-case)
- Action modal with dynamic form per action type
- Evidence add / verify / remove

### Tax Submissions Frontend Integration

`_renderFooter` in `tax-submissions.js` frontend now includes:
- Mark Correction / Mark Objection / Mark Completed buttons (status-gated)
- **Open Disputes ↗** link (always shown; opens tax-disputes.html filtered by submission_id)

### SARS Recon Frontend Integration

`_renderFooter` in `sars-recon.js` now includes:
- **+ Dispute Case** button → calls `create-from-sars-line`; 409 prompts to open existing case
- **Open Disputes ↗** link → tax-disputes.html filtered by source_type=sars_statement_line

---

## Nothing Regressed

- All existing practice routers: untouched
- Paytime: not touched
- Patch 44A items: additive only (new field returned, filter narrowed)
- tax-submissions.js backend: new endpoints added after existing ones; no existing logic changed
- tax-submissions.js frontend: new buttons added to existing `_renderFooter` block; no existing buttons changed
- sars-recon.js frontend: new buttons appended to existing `_renderFooter`; `srCreateDisputeFromLine` is a new export
- No `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` in any new or modified file

---

## IMPORTANT: Migrations Must Be Applied in Order

Apply in Supabase SQL Editor → New Query → paste each → Run:
1. `100_practice_tax_payment_tracking.sql` (if not done — Codebox 42)
2. `101_practice_sars_statement_reconciliation.sql` (if not done — Codebox 43)
3. `102_practice_tax_dispute_cases.sql` (Codebox 44 — new)

Expected: "Success. No rows returned" for each.

---

## Testing Required

**None of the following has been browser-tested. No browser tooling is available in this environment. All verification was code-review and `node --check` syntax-validation only. Treat as untested until manually clicked through.**

1. Apply all three migrations in order
2. Navigate to `/practice/tax-disputes.html` — summary cards load (all zero), empty table
3. Create a new case (manual source type, any client) — confirm it appears in table with correct type/status badges
4. Open the case → Overview tab shows all fields correctly
5. Evidence tab: add evidence record → appears as Unverified → click Verify → becomes Verified
6. Events tab: shows `dispute_case_created` and `evidence_added` events
7. Footer: click "Mark Submitted" → action modal appears → submit → status updates to Submitted; repeat for Record Acknowledgement → Acknowledged, Record Response → Response Received, Accept → Accepted, Complete → Completed
8. Try escalating from Open → confirm escalate without notes is blocked with 400 error
9. Try cancelling a Completed case → confirm blocked with 422
10. Create second case with same client + source → confirm 409 with `existing_case_id`
11. Open Tax Submissions → open any assessed submission → "Mark Correction" button visible → click → confirm modal → status changes to correction_required
12. "Mark Objection" button → status changes to objection_required
13. "Mark Completed" button → status changes to completed
14. "Open Disputes ↗" link → navigates to tax-disputes.html?submission_id=X with filter applied
15. Open SARS Recon → open any statement line → "+ Dispute Case" button → click → dispute case created → prompt to navigate
16. "Open Disputes ↗" in SARS Recon footer → opens filtered dispute list
17. SARS Recon table: confirm Client column now shows name (not raw ID) after Patch 44A-2
18. SARS Recon summary: add an Ignored line → confirm its debit/credit is excluded from variance totals (Patch 44A-4)
19. Log in as different company — confirm zero cross-company dispute cases or events
20. DevTools → Application → Storage — confirm no dispute data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Partial matching for SARS statement lines
- Confirmed now: reconciliation_status includes 'partially_matched'; PUT /lines/:id can set it manually
- Not yet: Dedicated endpoint with matched_amount field; UI to split one statement line across multiple payment events
- Risk: Low — manually settable; most lines are fully matched or unmatched
- Recommended: Design matched_amount field and UI flow in Codebox 45 if partial matching is needed in practice
```

```
FOLLOW-UP NOTE
- Area: Tax Dispute pagination — GET / defaults to 50 per page
- Confirmed now: page + per_page query params work
- Not yet: Frontend pagination currently shows "prev/next" but resets on filter change — could lose page state
- Risk: Low — typical practice will have fewer than 50 active disputes
- Recommended: Acceptable as-is; revisit if dispute volume grows
```

```
FOLLOW-UP NOTE
- Area: Tax Submission "Mark Completed" — no back-transition available
- Confirmed now: completed submissions are blocked from cancellation
- Not yet: A re-open or un-complete path
- Risk: Low — "completed" should be terminal; if an error occurs user can audit-trail a new submission
- Recommended: Treat completed as terminal; log the follow-up if a practitioner needs reversal
```

```
FOLLOW-UP NOTE
- Area: Dispute case — responsible_team_member_id is stored but not displayed
- Confirmed now: field stored in DB; returned in API response
- Not yet: Team member name enrichment (similar to client_name enrichment in Patch 44A-2)
- Risk: Cosmetic only
- Recommended: Add team member name lookup in Codebox 45 or when team management module is ready
```

---

## Recommended Codebox 45

**Tax Compliance Finalization + Completion Evidence Pack**

After corrections, objections, and disputes are tracked (Codebox 44), the practice needs:
- Completion evidence requirements per submission type (checklist of required documents)
- Finalization sign-off workflow (partner/reviewer must approve before submission is marked complete)
- Evidence completeness check gate (block Mark Completed if required evidence not verified)
- Deadline alert / overdue escalation view (dashboard-level)
- Possible: partial-match UI for SARS statement lines (deferred from Patch 44A)
- Possible: team member name enrichment across all modules that store responsible_team_member_id
