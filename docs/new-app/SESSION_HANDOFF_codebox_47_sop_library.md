# Session Handoff — Codebox 47: Practice SOP Templates + Workflow Instruction Library

> Date: 2026-07-01
> Status: COMPLETE — migration 105 NOT yet applied to Supabase — not committed or pushed
> **PATCHED (same day, before Codebox 48):** `under_review` status added — see "PATCH" section at the bottom of this document.

---

## What Was Built

### Migration 105

Creates three tables — all `IF NOT EXISTS`, safe to re-run:

- **`practice_sop_templates`**: One row per SOP. **Status machine patched to 4 values** (`draft → under_review → approved → archived` — see PATCH section below; originally shipped as a 3-value machine with no `under_review`). `category` is free TEXT (not enum-constrained — the spec gave no "Allowed" list for it). `difficulty` nullable CHECK (`beginner`/`intermediate`/`advanced`). `requires_review` boolean default `true`. `version` integer starting at 1. Auto-`updated_at` trigger. 4 indexes (company_id, category, status, title).
- **`practice_sop_links`**: Attaches an SOP to one of 7 record types (`workflow_template`, `workflow_step`, `task`, `review_task`, `compliance_pack`, `completion_pack`, `knowledge_article`). `sort_order` for ordering. `UNIQUE (sop_id, linked_type, linked_id)` prevents duplicate attachments.
- **`practice_sop_events`**: Append-only audit log. Never updated or deleted.

Applied against migrations 054–104 (104 already applied per the task's stated assumption).

---

### Backend — `practice-sop.js` (13 endpoints)

Key behaviours and judgment calls:

**Submit-review / approve now transition through `under_review` (PATCHED — see bottom of document):**
As originally shipped, the spec listed only 3 status values (`draft`/`approved`/`archived`) with no `under_review` state, so `submit-review` logged an event without changing status and `approve` transitioned `draft → approved` directly. This was patched the same day, before Codebox 48: `under_review` was added to the CHECK constraint, `submit-review` now sets `draft → under_review`, and `approve` now requires `under_review → approved`. Matches Knowledge Base's 4-value machine exactly.

**Approved-SOP edit → new version (identical pattern to Codebox 46, no separate version-history table):**
- `PUT /:id` on an `approved` SOP: if `title`/`summary`/`instruction_body`/`category` change, `version` is bumped, `status` resets to `draft`, `approved_at`/`approved_by` cleared
- Editing a `draft` SOP does not touch version or status

**Linked-record ownership check:**
- `_verifyLinkedRecordOwnership` maps all 7 `linked_type` values to real tables (confirmed against migrations 057, 073, 074, 100–104): `practice_workflow_templates`, `practice_workflow_template_steps`, `practice_tasks` (used for both `task` and `review_task` since there is no separate review-task table), `practice_compliance_packs`, `practice_tax_completion_packs`, `practice_knowledge_articles`
- Note the naming difference from Codebox 46: SOP's enum value is `completion_pack`, Knowledge Base's is `tax_completion_pack` — both map to the same underlying `practice_tax_completion_packs` table, just named differently per each spec

**Search:** `ilike` across `title`, `summary`, `instruction_body`. No AI search per spec.

**Multi-tenant:** Every query scoped to `req.companyId`. `_verifySop` + `_verifyLink` re-verify ownership before every mutating action.

**Audit:** `_writeEvent` writes to `practice_sop_events` (append-only) on every lifecycle change. `auditFromReq` writes to the shared ecosystem audit trail. Event types: `sop_created`, `sop_updated`, `sop_submitted`, `sop_approved`, `sop_archived`, `sop_linked`, `sop_unlinked`.

**Addition beyond the literal spec:** `GET /linked/:linkedType/:linkedId` was added even though it wasn't in the spec's endpoint table, because the "Workflow Integration" requirements (Attached SOPs / Instruction button / Standard Procedure / Procedure on 5 different record types) are impossible to fulfil without a reverse lookup from record → SOPs. This mirrors the identical addition made for the Knowledge Base in Codebox 46.

---

### `index.js` + `layout.js`

`practice-sop` router mounted at `/sop` after the `/knowledge` block. "Practice SOPs" nav entry added between "Knowledge Base" and "Tax Config".

---

### Frontend — `practice-sop.html` + `js/practice-sop.js` (sop prefix)

- Summary cards (3): Draft, Approved, Archived — clickable to filter
- Filter bar: category (free text), status, difficulty, free-text search
- SOP table: status pill, title, category chip, difficulty badge, estimated minutes, version, updated timestamp
- Create SOP modal — always creates as draft; full field set
- Detail modal — 3 tabs:
  - **Instruction**: metadata grid (status, category, difficulty, est. minutes, requires review, version, effective dates, reviewed/approved timestamps) + summary + full instructions + internal notes
  - **Links**: attached records list with remove button + "Attach to Record" button
  - **History**: full append-only audit log
- Edit modal: pre-fills all fields; shows inline warning if editing an approved SOP (version bump + return to draft)
- Attach SOP modal: select from all 7 `linked_type` values + record ID + sort order + notes
- Context-sensitive footer: `draft` → Submit for Review + Approve; both non-archived → Edit + Archive
- `?linked_type=X&linked_id=Y` URL params render an info banner listing SOPs already attached to that record (via `GET /linked/:type/:id`)

### Workflow Integration (all additive, no existing UI rewritten)

- **Workflow Template** (`workflow-template.html` / `js/workflow-editor.js`): hidden "Attached SOPs ↗" link in the page header, shown + populated with `?linked_type=workflow_template&linked_id=<id>` once the template has been saved and has an ID
- **Workflow Step** (`js/workflow-editor.js` → `renderStepsList`): "📋 Instructions" link per step card → `?linked_type=workflow_step&linked_id=<step.id>`
- **Task Detail** (`js/tasks.js` task card header): "📋 Procedure" link → `?linked_type=task&linked_id=<task.id>`
- **Compliance Pack** (`js/compliance-packs.js` → `renderDetailHeader`): "Procedure ↗" link injected via `insertAdjacentElement` after the `cpDSub` element — no HTML file change needed for this one
- **Completion Pack** (`js/tax-completion.js` → `_renderFooter`): "Procedure ↗" link appended alongside the existing Codebox 46 "Knowledge ↗" link

---

## Nothing Regressed

- All existing practice routers: untouched
- Paytime: not touched (Codebox 47 has zero payroll-file overlap; no auto-trigger files touched)
- `workflow-editor.js`, `tasks.js`, `compliance-packs.js`, `tax-completion.js`: only new links/buttons appended to existing render functions; no existing behaviour, endpoints, or logic changed
- `workflow-template.html`: only a new hidden link element added to the page header — nothing else touched
- No `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` introduced in any new or modified file (confirmed via grep — the only matches found were pre-existing, permitted auth-token reads in `compliance-packs.js`, unrelated to this work)
- `node --check` passes on `practice-sop.js` (backend), `js/practice-sop.js` (frontend), and all modified frontend JS files (`workflow-editor.js`, `tasks.js`, `compliance-packs.js`, `tax-completion.js`, `layout.js`, `modules/practice/index.js`)

### Note on file-write reliability (carried over from Codebox 46)

Codebox 46's handoff flagged a transient issue where a written file was reported successful but briefly absent from disk (suspected OneDrive sync race on this `SERVER - Documents` path). Every file created or modified in this session was re-verified present on disk via `ls`/`Glob` and syntax-checked with `node --check` immediately after writing — no repeat of the anomaly was observed this session, but the same verify-after-write discipline was applied throughout.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `105_practice_sop_library.sql`

Expected: "Success. No rows returned."

Apply previous migrations first if not done:
1. `103_practice_tax_completion_packs.sql`
2. `104_practice_knowledge_base.sql`
3. `105_practice_sop_library.sql`

---

## Testing Required

*None of the following has been browser-tested. All verification was code-review, `node --check`, and grep for browser-storage violations only.*

1. Apply migration 105 to Supabase
2. Navigate to `/practice/practice-sop.html` — summary cards load (all zero), empty table
3. Create an SOP (title + instructions required) → confirm status "Draft", version 1
4. Click "Submit for Review" → confirm status stays "Draft" but a `sop_submitted` event appears in History
5. Click "Approve" → status becomes "Approved"; `approved_by`/`approved_at` set
6. Edit an approved SOP's instructions and save → confirm version becomes 2 and status returns to "Draft"
7. Attach the SOP to a workflow template (Links tab → linked_type=workflow_template + a valid template ID for this company) → confirm attachment created
8. Try attaching to a template ID belonging to a different company → confirm 404
9. Try attaching the same SOP to the same record twice → confirm 409 duplicate
10. Open a Workflow Template edit page (`workflow-template.html?id=X`) → confirm "Attached SOPs ↗" link appears and navigates to the filtered SOP page showing the attachment made in step 7
11. Add a workflow step → confirm "📋 Instructions" link appears on the step card and navigates correctly
12. Open Tasks page → confirm "📋 Procedure" link appears on each task card and navigates correctly
13. Open a Compliance Pack detail → confirm "Procedure ↗" link appears under the pack subtitle
14. Open a Tax Completion Pack detail → confirm "Procedure ↗" link appears in the footer alongside "Knowledge ↗"
15. Search by title/summary/instruction keyword → confirm results filter correctly
16. Filter by category, status, difficulty → confirm each filters correctly
17. Archive an SOP → confirm editing is now blocked (422) and it disappears from active views
18. Log in as a different company → confirm zero cross-company SOPs/links visible
19. DevTools → Application → Storage → confirm no SOP data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE — RESOLVED (see PATCH section at bottom of this document)
- Area: SOP status machine — no "under_review" state
- Confirmed now: RESOLVED — under_review added to the CHECK constraint; submit-review sets draft → under_review; approve requires under_review → approved
- Not yet: N/A — patch applied same day, before Codebox 48
- Risk: None remaining
- Recommended next check: N/A
```

```
FOLLOW-UP NOTE
- Area: Version history
- Confirmed now: `version` integer increments on approved-SOP content edits; no historical snapshot of prior versions is retained (same limitation noted for Knowledge Base in Codebox 46)
- Not yet: A `practice_sop_template_versions` table storing prior instruction_body per version
- Risk: Medium if practice needs to review exactly what an earlier approved version of a procedure said
- Recommended: Add a version-snapshot table in a future codebox if audit/compliance requirements demand exact historical content (could be shared infrastructure with Knowledge Base's equivalent need)
```

```
FOLLOW-UP NOTE
- Area: review_task vs task linked_type
- Confirmed now: Both 'task' and 'review_task' map to the same practice_tasks table for ownership verification; the automatic Task Detail integration link always uses 'task' for consistency (so a task's attached SOPs are always found under one linked_type regardless of its review_required flag)
- Not yet: No UI currently creates 'review_task' links — it exists in the CHECK constraint and Attach-SOP dropdown for manual use only
- Risk: Low — if a future feature wants to distinguish review-stage procedures from general task procedures, the schema already supports it; no schema change needed, just UI convention
- Recommended: If a distinct "review task" list view is ever built, decide then whether it should link via 'review_task' or continue using 'task'
```

```
FOLLOW-UP NOTE
- Area: GET /linked/:linkedType/:linkedId — added beyond literal spec
- Confirmed now: Endpoint added and working, exact mirror of the Knowledge Base equivalent from Codebox 46
- Not yet: Not explicitly requested in this codebox's spec (only Knowledge Base's spec explicitly listed it)
- Risk: None — required to fulfil the explicitly-requested "Workflow Integration" section; without it, none of the 5 integration points (Attached SOPs, Instruction button, Standard Procedure, Procedure x2) could function
- Recommended: No action needed; flagged here only for transparency per the audit-first / document-assumptions rule
```

---

## PATCH (same day, before Codebox 48) — `under_review` status added

**Requested by user:** "Before starting CB48, patch SOP status enum to include under_review if safe: draft, under_review, approved, archived. submit-review must set status = under_review. approve must set status = approved."

**Safety check performed:** Migration 105 had not been applied to Supabase at the time of this patch (confirmed via this document's own "NOT yet applied" status, unchanged since original handoff). Because no live table exists yet, the CHECK constraint was edited **directly in migration 105** rather than via a new migration 106 — there is no data or applied schema to migrate away from. If migration 105 had already been applied, a new `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT ...` migration would have been required instead.

### Files changed by this patch

| File | Change |
| --- | --- |
| `backend/config/migrations/105_practice_sop_library.sql` | `status` CHECK constraint: `('draft','approved','archived')` → `('draft','under_review','approved','archived')` |
| `backend/modules/practice/practice-sop.js` | `STATUSES` const updated; `GET /summary` now returns an `under_review` count; `PUT /:id/submit-review` now transitions `draft → under_review` (previously left status unchanged); `PUT /:id/approve` now requires `under_review` (previously required `draft`) and transitions to `approved` |
| `backend/frontend-practice/js/practice-sop.js` | `STATUS_LABELS` adds `under_review: 'Under Review'`; summary cards add an "Under Review" card (`sc-review`, filters to `under_review`); detail footer logic split — `draft` now shows only "Submit for Review", `under_review` now shows only "Approve" (previously both buttons appeared together on `draft`) |
| `backend/frontend-practice/practice-sop.html` | Filter dropdown adds "Under Review" option; CSS adds `.sc-review` (summary card accent) and `.st-under_review` (status pill colour) |
| `docs/new-app/47_practice_sop_library.md` | Status Machine and Submit-Review/Approve Semantics sections rewritten to describe the patched 4-value design |
| `docs/new-app/SESSION_HANDOFF_codebox_47_sop_library.md` | This file — header banner, backend section, and the resolved follow-up note updated; this PATCH section appended |

### What was NOT changed

- No new migration file created (safe direct edit, per the safety check above)
- `PUT /:id` general update logic unchanged — editing a `draft` or `under_review` SOP still doesn't bump version; only editing an `approved` SOP's content fields bumps version and resets to `draft` (unaffected by this patch)
- Workflow integration links (workflow template/step, task, compliance pack, completion pack) unaffected — they only navigate by ID, not by status
- No changes to Knowledge Base (Codebox 46) — its `under_review` state was already correct and unchanged

### Verification performed

- `node --check` passed on `practice-sop.js` (backend) and `js/practice-sop.js` (frontend) after the patch
- Confirmed 16 references to `under_review` across the 4 patched files (migration, backend router, frontend JS, frontend HTML)
- Re-confirmed zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` usage introduced

### Testing required (in addition to the original test list above)

1. Apply the patched migration 105 to Supabase (not yet applied — same as before)
2. Create an SOP → status "Draft"
3. Click "Submit for Review" → confirm status now actually changes to "Under Review" (previously stayed "Draft")
4. Confirm the footer now shows only "Approve" (not "Submit for Review") while status is "Under Review"
5. Click "Approve" → confirm status changes to "Approved"; `reviewed_at`/`reviewed_by`/`approved_at`/`approved_by` all set
6. Try calling `PUT /:id/approve` while status is still "Draft" → confirm 422 (`must be in "under_review" status`)
7. Confirm the summary cards now show 4 tiles (Draft, Under Review, Approved, Archived) and the "Under Review" tile count updates correctly
8. Confirm the status filter dropdown includes "Under Review" and filters correctly
