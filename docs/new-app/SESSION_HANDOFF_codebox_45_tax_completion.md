# Session Handoff — Codebox 45: Tax Compliance Finalization + Completion Evidence Pack

> Date: 2026-07-01
> Status: COMPLETE — migration 103 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Migration 103

Creates three tables — all `IF NOT EXISTS`, safe to re-run:

- **`practice_tax_completion_packs`**: One pack per tax matter. 5-status machine (`draft → review_pending → approved → completed / cancelled`). Stores `completion_score` (0–100), `completion_snapshot` JSONB (immutable, set at completion), `settings` JSONB (stores partner_overrides), `approved_by`, `approved_at`, `completion_date`. Auto-updated_at trigger. 6 indexes including partial index on active packs.

- **`practice_tax_completion_items`**: Checklist items per pack. `item_type` (12-value CHECK), `item_name`, `required`, `completed`, `completed_at`, `completed_by`, `notes`, `sort_order`. 2 indexes.

- **`practice_tax_completion_events`**: Append-only audit log. Never updated or deleted. 3 indexes.

---

### Backend — `tax-completion.js` (18 endpoints)

Key behaviours:

**Quality gate (PUT /:id/complete):**
- HARD blocks (unoverridable): `incomplete_checklist` (score < 100), `not_approved` (status ≠ approved)
- SOFT blocks (partner-overridable): `outstanding_payments`, `unmatched_sars_lines`, `open_disputes`
- Returns HTTP 422 with structured block arrays if gate fails
- Partner overrides stored in `settings.partner_overrides[]`; `PUT /:id/partner-override` to add

**Completion snapshot:**
- Built at completion time: pack metadata, all items, all overrides, payments, SARS recon counts, disputes
- Stored in `completion_snapshot JSONB` — never modified after setting

**Score calculation:**
- `required = items WHERE required = true`
- `done = items WHERE required = true AND completed = true`
- `score = required.length === 0 ? 100 : round(done / required * 100)`
- Recalculated on every item add, update, or delete

**Default items by source_type:**
- `individual_tax`: 7 items
- `company_tax`: 9 items (includes AFS Review + Tax Adjustments Review)
- `provisional_tax`: 5 items
- `vat`: 6 items (Input/Output Recon required; Working Papers optional)
- `payroll`: 6 items (PAYE + UIF/SDL payments separate; Working Papers optional)

**create-from-submission:**
- Verifies client + submission ownership against company_id
- Generates default items for source_type automatically
- Duplicate guard: 409 if an active (non-terminal) pack already exists for the same submission_id

**Multi-tenant:** Every query scoped to `req.companyId`. `_verifyPack` + `_verifyItem` re-verify ownership before every action.

**Audit:** `_writeEvent` writes to `practice_tax_completion_events` (append-only) on every state change. `auditFromReq` writes to the shared audit trail.

---

### `index.js` + `layout.js`

`tax-completion` router mounted after tax-disputes block. "Tax Completion" nav entry added between "Tax Disputes" and "Tax Config".

---

### Frontend — `tax-completion.html` + `js/tax-completion.js` (tc prefix)

- Summary cards (6): Draft, Review Pending, Approved, Completed, Low Score (<50%), Near Complete (75-99%)
- Filter bar: status, source type, client ID, submission ID, active-only checkbox
- Packs table with inline animated score progress bars (colour-coded: red/amber/yellow/green)
- Create Pack modal: routes to `create-from-submission` if submission_id provided (auto-items), else manual `POST /`
- Detail modal — 2 tabs:
  - **Checklist & Status**: pack overview grid → completion snapshot (if done) → quality gate panel (hard/soft blocks with Override buttons) → score bar → interactive checklist (click to tick/untick) → inline add-item form
  - **Events**: full audit log
- Partner Override modal: reason required, stores in DB, updates quality gate display
- Context-sensitive footer per status: draft → Submit for Review; review_pending → Approve; approved → Complete + Cancel
- `tcComplete()` catch handler: parses 422 quality gate error and shows structured alert, then re-loads detail to refresh gate display
- "Open Disputes ↗" link in footer when submission_id is set
- URL param pre-fill: `?submission_id=X` from tax-submissions.html pre-fills fSubmissionId filter

### Tax Submissions Frontend Integration

`_renderFooter` in `tax-submissions.js` now appends a **Completion Pack ↗** link (dark green #1a4d2e / #68d391) after the existing Open Disputes ↗ link. Links to `/practice/tax-completion.html?submission_id=<id>`.

---

## Nothing Regressed

- All existing practice routers: untouched
- Paytime: not touched
- tax-submissions.js: only a new link appended to existing `_renderFooter`; no existing buttons changed
- No `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` in any new or modified file
- `node --check` passes on both `tax-completion.js` backend and `js/tax-completion.js` frontend

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `103_practice_tax_completion_packs.sql`

Expected: "Success. No rows returned."

Apply previous migrations first if not done:
1. `100_practice_tax_payment_tracking.sql`
2. `101_practice_sars_statement_reconciliation.sql`
3. `102_practice_tax_dispute_cases.sql`
4. `103_practice_tax_completion_packs.sql`

---

## Testing Required

*None of the following has been browser-tested. All verification was code-review and `node --check` only.*

1. Apply migration 103 to Supabase
2. Navigate to `/practice/tax-completion.html` — summary cards load (all zero), empty table
3. Create pack via "New Completion Pack" with client ID + source type + submission ID → confirm pack created and default items generated
4. Open pack detail → Checklist tab shows score 0%, all items unchecked
5. Tick all required items → score updates to 100%
6. Quality gate panel shows "✓ Quality Gate Passed" once score = 100% and status is approved
7. Click "Submit for Review" → status changes to review_pending
8. Click "Approve" (enter notes) → status changes to approved; approved_by + approved_at set
9. Click "Complete" → pack completes; completion_snapshot frozen; completion_date set
10. Verify completion_snapshot in Supabase table: contains checklist_items, payments_at_completion, sars_recon_at_completion
11. Try completing with score < 100% → 422 with `incomplete_checklist` hard block
12. Try completing with status = draft → 422 with `not_approved` hard block
13. Add a submission with outstanding payment → try complete → `outstanding_payments` soft block displayed
14. Click Override for soft block → reason prompt → override saved → quality gate refreshes, block moves to "Overrides applied"
15. Now complete → succeeds; override recorded in snapshot
16. Cancel a pack → status = cancelled; events tab shows cancel event
17. Try cancel a completed pack → blocked with 422
18. Add custom item → item appears in list; score recalculates
19. Remove item → score recalculates
20. Navigate from Tax Submissions → "Completion Pack ↗" link → lands on tax-completion.html with submission_id filter pre-filled
21. Log in as different company → confirm zero cross-company packs
22. DevTools → Application → Storage → confirm no completion pack data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Completion pack recalculate-score endpoint
- Confirmed now: POST /:id/recalculate-score endpoint exists and updates DB
- Not yet: No UI button exposed for manual score recalculation (auto-recalc happens on every item change)
- Risk: Low — auto-recalc covers all normal paths; manual recalc is a recovery tool for edge cases
- Recommended: Add a "Recalculate Score" button to the detail footer if score drift is ever reported
```

```
FOLLOW-UP NOTE
- Area: Completion pack — no "Return to Draft" from review_pending
- Confirmed now: review_pending → approved is the only forward path; cancellation is always available
- Not yet: A "send back for revision" flow (review_pending → draft)
- Risk: Low — practice can cancel and re-create, or the reviewer can approve and let staff continue editing items
- Recommended: Add PUT /:id/return-to-draft endpoint if reviewers frequently need to reject with comments
```

```
FOLLOW-UP NOTE
- Area: Partner overrides — no removal mechanism
- Confirmed now: PUT /:id/partner-override replaces existing override of same type
- Not yet: Explicit override removal endpoint
- Risk: Low — overrides are replaced on re-submit; they don't accumulate
- Recommended: If needed, add DELETE /:id/partner-override/:type later
```

```
FOLLOW-UP NOTE
- Area: Partial-match SARS lines — deferred from Codebox 44A-3
- Still outstanding: matched_amount field, UI for partial line splits
- Risk: Medium if practice uses partial matching frequently
- Recommended: Design in a future Codebox when the need is confirmed
```
