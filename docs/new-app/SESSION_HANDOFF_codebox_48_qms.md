# Session Handoff — Codebox 48: Practice Quality Management System (QMS)

> Date: 2026-07-01
> Status: COMPLETE — migration 106 NOT yet applied to Supabase — not committed or pushed

---

## Mandatory Patch 48A

**Requested:** Patch SOP status enum to `draft`/`under_review`/`approved`/`archived`; `submit-review` → `under_review`; `approve` → `approved`; don't break existing SOPs.

**Result:** Already done. This exact change was applied earlier in the same session (see the "PATCH" section at the bottom of `SESSION_HANDOFF_codebox_47_sop_library.md`), before Codebox 48 was requested. Audit at the start of this codebox confirmed:
- Migration 105's `status` CHECK constraint already lists all 4 values
- `practice-sop.js`'s `STATUSES` const, `submit-review` endpoint, and `approve` endpoint already implement the exact behaviour requested

No migration or code change was made for 48A — it was verified, not re-applied. Nothing was at risk of breaking since the constraint change is purely additive and migration 105 (with the patch already baked in) is what this codebox's stated assumption says has been applied.

---

## What Was Built

### Migration 106

Creates three tables — all `IF NOT EXISTS`, safe to re-run:

- **`practice_quality_reviews`**: One row per quality review. 7-status machine (`draft → in_review → passed/failed → completed`, with `needs_correction` reachable via finding auto-transition, and `cancelled` from any non-terminal state). `review_type` 8-value CHECK. `linked_type` nullable 4-value CHECK (`task`/`workflow`/`completion_pack`/`sop`) — reviews may have no linked source (internal inspections, client file reviews, custom). `quality_score` nullable 0–100. Auto-`updated_at` trigger. 5 indexes. **Partial unique index** `uq_pqr_active_linked_review` enforces at most one active review per linked record at the DB level (defense-in-depth behind the app-level 409).
- **`practice_quality_findings`**: Findings per review, with CAPA fields (`corrective_action`, `preventive_action`) stored directly on the row — no separate CAPA table needed at this scale. 8-value `finding_type` CHECK, 4-value `severity` CHECK, 6-value `status` CHECK. Auto-`updated_at` trigger.
- **`practice_quality_events`**: Append-only audit log covering both review-level and finding-level events (`finding_id` nullable).

---

### Backend — `quality-management.js` (19 endpoints)

Key behaviours and judgment calls:

**Auto-transition to `needs_correction` (judgment call):**
The spec's endpoint list only has `start`/`pass`/`fail`/`complete` — no dedicated endpoint reaches `needs_correction`. Since findings represent things that need fixing, `POST /reviews/:id/findings` automatically transitions the parent review from `in_review` to `needs_correction` when a finding is added. `PUT /reviews/:id/start` doubles as the re-review trigger (`needs_correction → in_review`), so no new endpoint was needed — this fits within the exact endpoint list given.

**Findings addressed by id alone, not nested under review id:**
Per spec, `PUT /findings/:findingId`, `/resolve`, `/verify`, and `DELETE /findings/:findingId` are top-level routes, not `/reviews/:id/findings/:findingId`. `_verifyFinding` scopes ownership to `company_id` only (the finding's own `review_id` column ties it back to its parent review for audit event linkage).

**Create-from-source helpers — client_id inheritance:**
- `create-from-task` and `create-from-completion-pack`: source tables (`practice_tasks`, `practice_tax_completion_packs`) carry a `client_id` column — inherited automatically unless overridden in the request body
- `create-from-workflow` and `create-from-sop`: source tables (`practice_workflow_runs`, `practice_sop_templates`) have no `client_id` column (confirmed via migrations 057 and 105) — `client_id` must be passed explicitly if wanted, otherwise stays null

**Duplicate guard:**
- Application layer: `_findActiveReviewForLink` checks for any non-terminal review with the same `(linked_type, linked_id)` before create — returns 409 with `existing_review_id`
- Database layer: partial unique index `uq_pqr_active_linked_review` as a race-condition safety net (same pattern used for Knowledge Base and SOP links in Codeboxes 46/47, but as a partial index here since "active" is a dynamic status condition rather than a static field)

**Multi-tenant:** Every query scoped to `req.companyId`. `_verifyReview` + `_verifyFinding` re-verify ownership before every mutating action. `_verifyLinkedRecordOwnership` maps all 4 `linked_type` values to real tables (`practice_tasks`, `practice_workflow_runs`, `practice_tax_completion_packs`, `practice_sop_templates`) confirmed against prior codeboxes' migrations.

**Audit:** `_writeEvent` writes to `practice_quality_events` (append-only) on every review and finding lifecycle change. `auditFromReq` writes to the shared ecosystem audit trail.

---

### `index.js` + `layout.js`

`quality-management` router mounted at `/qms` after the `/sop` block. "Quality" nav entry added between "Practice SOPs" and "Tax Config".

---

### Frontend — `quality-management.html` + `js/quality-management.js` (qms prefix)

- Summary cards (8): Draft, In Review, Needs Correction, Passed, Failed, Completed, Open Findings, Critical Open Findings — status cards clickable to filter
- Filter bar: review type, status, client ID, free-text search
- Reviews table: type badge, status pill, title, client, quality score, created timestamp
- Create Review modal — manual creation (title, type, client ID, assigned reviewer, notes)
- Detail modal — 3 tabs:
  - **Overview**: metadata grid (type, status, client, linked record, reviewer, score, reviewed/created timestamps) + notes
  - **Findings**: list with severity/type badges, CAPA blocks (root cause / corrective / preventive action), due dates, resolve/verify/cancel actions, "+ Add Finding"
  - **Events**: full append-only audit log
- Add Finding modal: type, severity, title, description, root cause, corrective action, preventive action, due date, responsible team member
- Shared Action modal for Pass/Fail/Complete: optional quality score (0–100) + notes
- Context-sensitive footer: draft/needs_correction → Start/Re-Review; in_review → Pass/Fail; passed/failed → Complete; all non-terminal → Cancel Review; linked reviews get an "All Reviews ↗" link
- `?linked_type=X&linked_id=Y` URL params render an info banner listing reviews for that record (fetched via `GET /reviews?linked_type=&linked_id=`), with a "Create one ↗" quick action that calls the matching `create-from-*` endpoint directly if none exist

### Integration Links (Codebox 48)

A small "QMS Review ↗" link was added in three places, additive only:
- `tasks.js` — task card header, alongside the existing "📋 Procedure" link (Codebox 47) → `?linked_type=task&linked_id=<id>`
- `practice-sop.js` — SOP detail footer → `?linked_type=sop&linked_id=<id>`
- `tax-completion.js` — completion pack footer, alongside the existing "Knowledge ↗" (Codebox 46) and "Procedure ↗" (Codebox 47) links → `?linked_type=completion_pack&linked_id=<id>`

---

## Nothing Regressed

- All existing practice routers: untouched
- Paytime: not touched (Codebox 48 has zero payroll-file overlap; no auto-trigger files touched)
- `tasks.js`, `practice-sop.js`, `tax-completion.js`: only a new link appended to each existing render function; no existing buttons, endpoints, or logic changed
- No `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` introduced in any new or modified file (confirmed via grep — the only match found was a pre-existing comment in `tax-completion.js`, not actual usage)
- `node --check` passes on `quality-management.js` (backend), `js/quality-management.js` (frontend), and all modified frontend JS files (`tasks.js`, `practice-sop.js`, `tax-completion.js`, `layout.js`, `modules/practice/index.js`)
- Every file re-verified present on disk via `ls` immediately after writing (per the file-write reliability discipline carried over from Codeboxes 46/47)

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `106_practice_qms_foundation.sql`

Expected: "Success. No rows returned."

Apply previous migrations first if not done:
1. `104_practice_knowledge_base.sql`
2. `105_practice_sop_library.sql` (with the `under_review` patch already included)
3. `106_practice_qms_foundation.sql`

---

## Testing Required

*None of the following has been browser-tested. All verification was code-review, `node --check`, and grep for browser-storage violations only.*

1. Apply migration 106 to Supabase
2. Navigate to `/practice/quality-management.html` — summary cards load (all zero), empty table
3. Create a manual review (title + type) → confirm status "Draft"
4. Click "Start Review" → status becomes "In Review"
5. Add a finding while in_review → confirm the review auto-transitions to "Needs Correction" and the finding appears in the Findings tab with CAPA fields
6. Resolve the finding → status "Resolved"; Verify the finding → status "Verified"
7. Click "Re-Review" (available because status is Needs Correction) → back to "In Review"
8. Click "Pass" (with an optional quality score) → status "Passed"
9. Click "Complete" → status "Completed"
10. Try adding a finding to a completed review → confirm 422
11. Create a review via `create-from-task` with a valid task ID for this company → confirm success and `client_id` auto-inherited from the task
12. Try `create-from-task` again with the same task ID → confirm 409 with `existing_review_id`
13. Create a review via `create-from-sop` → confirm `client_id` is null (SOPs carry no client_id) unless explicitly passed
14. From a Task card → click "QMS Review ↗" → confirm it lands on quality-management.html with the linked banner, offering "Create one ↗" if none exist
15. From an SOP detail → click "QMS Review ↗" → same check
16. From a Tax Completion Pack detail → click "QMS Review ↗" → same check
17. Cancel a review → confirm status "Cancelled"; confirm cancelled reviews no longer block the duplicate guard (a new review for the same linked record can now be created)
18. Log in as a different company → confirm zero cross-company reviews/findings visible
19. DevTools → Application → Storage → confirm no QMS data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: needs_correction auto-transition (judgment call)
- Confirmed now: Adding a finding to an in_review review auto-transitions it to needs_correction; PUT /reviews/:id/start doubles as the re-review trigger
- Not yet: Confirmation from the practice on whether ALL findings (including low-severity "observation" or "improvement" types) should trigger this, or only non_conformance/high-severity ones
- Risk: Low-medium — currently any finding type/severity triggers the transition, which may be too aggressive if staff want to log minor observations without derailing an in-progress review
- Recommended next check: If staff report the auto-transition firing too often for minor findings, restrict it to finding_type IN ('non_conformance','sop_not_followed') OR severity IN ('high','critical')
```

```
FOLLOW-UP NOTE
- Area: CAPA — no separate corrective/preventive action tracking table
- Confirmed now: corrective_action and preventive_action are free-text fields on the finding row; there's no due-date/owner/status tracking specific to the CAPA itself (only the finding's own due_date/responsible_team_member_id/status apply to both the finding AND its CAPA together)
- Not yet: A dedicated practice_quality_capa_actions table with independent status/due dates for corrective vs. preventive actions (useful if one is done before the other)
- Risk: Low at current scale — a single finding-level due date/owner is sufficient for most practices
- Recommended: If a practice needs independent CAPA tracking (e.g. corrective action done, preventive action still pending), split into a dedicated table in a future codebox
```

```
FOLLOW-UP NOTE
- Area: Quality score — no automatic calculation
- Confirmed now: quality_score is manually entered (via PUT /:id or the pass/fail/complete action bodies); no automatic scoring formula based on findings count/severity
- Not yet: An automatic scoring algorithm (e.g. deduct points per open finding by severity)
- Risk: Low — manual entry is standard for many practice QMS processes; automatic scoring can be added without breaking existing manually-scored reviews
- Recommended: If the practice wants computed scores, add an optional auto-calculate endpoint (similar to Codebox 45's completion_score recalculation) in a future iteration — keep manual override available
```

```
FOLLOW-UP NOTE
- Area: linked_type coverage — only 4 of 8 review_types have a create-from-source helper
- Confirmed now: task_review, workflow_review, completion_pack_review, sop_compliance_review all have dedicated create-from-* endpoints matching linked_type values 'task'/'workflow'/'completion_pack'/'sop'
- Not yet: tax_review, internal_inspection, client_file_review, and custom review types have no linked_type/create-from-source helper — they're always manual (client_id only, or fully ad-hoc)
- Risk: None — this matches the spec exactly (only 4 create-from-* endpoints were requested); tax_review likely warrants its own source type (practice_tax_submissions or practice_individual_tax_returns) if the practice wants it linked in a future codebox
- Recommended: If tax_review reviews need a linked source, add 'tax_submission' or similar to linked_type's CHECK constraint and a create-from-tax-submission helper then
```
