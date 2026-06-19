# SESSION HANDOFF — CODEBOX 08 — WORKFLOW-TO-DEADLINE LINKING

**Date:** June 2026
**Status:** Complete — migration 059 not yet applied by user

---

## Action Required Before Deploying

**Run migration 059 in Supabase SQL Editor:**

File: `backend/config/migrations/059_practice_workflow_deadline_linking.sql`

Must be run AFTER migration 058 (already applied per Codebox 07 handoff).

Safe to re-run: all `ADD COLUMN IF NOT EXISTS`.

The verification query at the bottom of the file will confirm all columns were added correctly.

---

## What Was Built

1. **Migration 059** — extends `practice_workflow_templates`, `practice_workflow_runs`, `practice_tasks` with linking columns
2. **workflowService.js rewrite** — deadline creation woven into `createRunAndGenerateTasks`; template body sanitizer added
3. **workflows.js backend enhanced** — generate route accepts deadline params; 3 new run/deadline endpoints added
4. **workflow-template.html rewrite** — broken page replaced with correct Practice Management layout + compliance defaults editor
5. **workflow-editor.js rewrite** — nav key fixed, compliance defaults section added, step CRUD uses modal, reorder fixed
6. **workflows.html enhanced** — toast added, generate modal expanded with all deadline fields
7. **js/workflows.js enhanced** — `openNewTemplate()` added, template defaults pre-fill, deadline section toggle, team members loaded

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/059_practice_workflow_deadline_linking.sql` | Database migration |
| `docs/CODEBOX-08-WORKFLOW-DEADLINE-LINKING.md` | Full codebox documentation |
| `docs/SESSION_HANDOFF_codebox_08_workflow_deadline_linking.md` | This file |

---

## Files Modified

| File | What Changed |
|---|---|
| `backend/modules/practice/services/workflowService.js` | Complete rewrite — deadline creation, template sanitizer, all enums moved in |
| `backend/modules/practice/workflows.js` | Enhanced generate route + 3 new run/deadline endpoints |
| `backend/frontend-practice/workflow-template.html` | Complete rewrite — broken paths fixed, compliance defaults section added |
| `backend/frontend-practice/js/workflow-editor.js` | Complete rewrite — nav key fixed, compliance section, step modal, reorder fixed |
| `backend/frontend-practice/workflows.html` | Toast added, generate modal expanded with full deadline fields |
| `backend/frontend-practice/js/workflows.js` | Added openNewTemplate(), team members load, template defaults pre-fill |

---

## New API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/practice/workflows/generate` | Enhanced — now accepts deadline params, returns `{ run, tasks, deadline }` |
| GET | `/api/practice/workflows/runs/:id/deadline` | Get the linked deadline for a run |
| PUT | `/api/practice/workflows/runs/:id/link-deadline` | Link an existing deadline to a run |
| PUT | `/api/practice/workflows/runs/:id/unlink-deadline` | Remove the link between run and deadline |

---

## Bug Fixes Confirmed

| Bug | Status |
|---|---|
| `workflow-template.html` used wrong CSS/JS paths — page was broken | FIXED |
| `LAYOUT.init('tasks')` in workflow-editor.js — wrong nav highlight | FIXED |
| `openNewTemplate()` was undefined — clicking "New Template" crashed | FIXED |
| `client_id` accepted in generate but never persisted on run row | FIXED (migration 059 adds column; service now writes it) |
| Template create/update had no body sanitizer — unknown fields passed to Supabase | FIXED |
| workflows.html had no `#toast` div — toasts silently failed | FIXED |

---

## Preserved Existing Behaviour

- All pre-existing workflow routes unchanged (templates CRUD, steps CRUD, runs list, run detail)
- Generating a workflow WITHOUT the deadline checkbox ticked behaves identically to Codebox 06 behaviour
- Soft-delete on templates unchanged
- Step reorder endpoint unchanged
- All compliance routes from Codebox 07 unchanged

---

## Risks

| Risk | Severity | Notes |
|---|---|---|
| Migration 059 must be applied before backend restart | HIGH | `client_id`, `deadline_id`, `workflow_run_id` columns must exist before service writes them |
| If migration 059 fails mid-way | MEDIUM | All statements are `IF NOT EXISTS` — safe to re-run after fixing |
| `practice_workflow_runs.id` is BIGINT; `practice_tasks.workflow_run_id` set to BIGINT | LOW | Type match confirmed — no cast needed |
| Deadline creation failure (step 4) returns warning not error | LOW | Run and tasks are preserved; deadline can be created manually from compliance calendar |

---

## Recommended Codebox 09

**Tasks Page Enhancement**

The tasks list page does not yet show which workflow run or compliance deadline a task belongs to. With the new typed FK columns (`workflow_run_id`, `deadline_id`) now populated, the tasks page should:

1. Show a "Workflow" badge/link on tasks generated from workflows
2. Show a "Deadline" badge/link on tasks linked to compliance deadlines
3. Allow filtering tasks by workflow run or deadline
4. Optionally: Add a "Tasks" sub-tab on the Run detail view

This does not require any further backend changes — the data is now in place.
