# CODEBOX 09 — TASK REVIEW / APPROVAL FLOW FOUNDATION

**App:** Lorenco Practice Management
**Codebox:** 09 of ±80
**Date:** June 2026
**Status:** Complete — migration 060 must be applied in Supabase before using review features

---

## 1. Summary

Codebox 09 adds a three-tier QA review and approval flow to tasks in Lorenco Practice Management. Tasks can now be configured to require a reviewer sign-off, a final approver sign-off, or both, before they reach QA-approved or QA-locked status.

The flow integrates with the workflow template step system introduced in Codebox 06 — steps can carry `requires_review` and `requires_approval` flags, which are inherited by the generated tasks when a workflow run is created.

**What was built:**
- Migration 060: 21 new columns on `practice_tasks`, 2 on `practice_workflow_template_steps`, 1 new append-only audit table `practice_task_review_events`
- 9 new backend API endpoints for the review state machine
- Server-side pagination added to `GET /tasks`
- `tasks.html` rewritten: all inline JS extracted to `js/tasks.js`, 5 new review modals added, review section added to task form, QA/review badges added to task cards, review action buttons rendered per task state
- `js/tasks.js` created: full task CRUD + complete review/approval flow + team member selects (preparer/reviewer/approver) with `m.id` as value (not `m.user_id`)
- `workflow-editor.js` + `workflow-template.html` enhanced: review checkboxes in step modal
- Missing CSS utility classes added to `practice.css`

**What was NOT built (excluded by CLAUDE.md permanent rules):**
- SARS or CIPC API integrations
- Tax calculations
- Sean AI integrations
- Cross-app integrations
- Cron/scheduler automation

---

## 2. Database Changes (migration 060)

### A. `practice_tasks` — 21 new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `preparer_team_member_id` | INTEGER FK | NULL | Team member doing the work |
| `reviewer_team_member_id` | INTEGER FK | NULL | Team member performing review |
| `approver_team_member_id` | INTEGER FK | NULL | Team member giving final approval |
| `review_required` | BOOLEAN | false | Whether reviewer sign-off is needed |
| `approval_required` | BOOLEAN | false | Whether final approver sign-off is needed |
| `review_status` | TEXT | 'not_required' | not_required / pending / in_review / approved / rejected |
| `approval_status` | TEXT | 'not_required' | not_required / pending / approved / rejected |
| `ready_for_review_at` | TIMESTAMPTZ | NULL | When submitted for review |
| `reviewed_at` | TIMESTAMPTZ | NULL | When review was completed (approved or rejected) |
| `approved_at` | TIMESTAMPTZ | NULL | When final approval was granted |
| `rejected_at` | TIMESTAMPTZ | NULL | When a review or approval was rejected |
| `reviewed_by` | INTEGER | NULL | User ID of reviewer |
| `approved_by` | INTEGER | NULL | User ID of approver |
| `rejected_by` | INTEGER | NULL | User ID who rejected |
| `review_notes` | TEXT | NULL | Notes from reviewer |
| `approval_notes` | TEXT | NULL | Notes from approver |
| `rejection_reason` | TEXT | NULL | Required reason when rejecting |
| `qa_status` | TEXT | 'none' | none / required / pending_review / rejected / approved / locked |
| `qa_locked` | BOOLEAN | false | Hard lock — blocks general PUT edits |

### B. `practice_workflow_template_steps` — 2 new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `requires_review` | BOOLEAN | false | Inherited by generated tasks |
| `requires_approval` | BOOLEAN | false | Inherited by generated tasks |

### C. `practice_task_review_events` — new append-only table

Append-only audit log. `task_id` is nullable so events survive task hard-deletion. Never hard-delete rows from this table.

Event types: `ready_for_review`, `review_started`, `review_approved`, `review_rejected`, `approval_approved`, `approval_rejected`, `qa_locked`, `qa_unlocked`, `review_fields_updated`, `created`

---

## 3. QA State Machine

```
qa_status transitions:
  none
    → required          (task created with review_required=true)

  required
    → pending_review    (submit-review endpoint called)

  pending_review
    → rejected          (reject-review endpoint — task goes back to in_progress)
    → approved          (approve-review — if no approval_required, done here)
    → required          (approve-review — if approval_required, goes back to required while waiting for approver)

  approved
    → locked            (qa-lock endpoint)

  locked
    → approved          (qa-unlock endpoint)

  rejected
    → pending_review    (preparer resubmits)
```

`review_status` transitions:
```
  not_required → pending → in_review → approved
                                    → rejected → pending (after fix)
```

`approval_status` transitions:
```
  not_required → pending → approved
                        → rejected → pending (after review cycle resets)
```

---

## 4. Backend API Endpoints

All endpoints are under `/api/practice/tasks`.

### Existing — enhanced

| Method | Path | Change |
|---|---|---|
| GET | `/tasks` | Added pagination (`page`, `limit`), `qa_status`/`review_status`/`approval_status`/`reviewer_id`/`preparer_id` filters, Supabase `count: 'exact'` |
| GET | `/tasks/:id` | Added joins for preparer/reviewer/approver display_name |
| POST | `/tasks` | Accepts review fields; sets `qa_status='required'` when `review_required=true` |
| PUT | `/tasks/:id` | Blocks if `qa_locked=true`; validates team member IDs; extended allowed fields; logs `review_fields_updated` event |

### New — review endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/tasks/:id/review-events` | Returns append-only audit log for a task |
| PUT | `/tasks/:id/submit-review` | Preparer: sets `review_status='pending'`, `qa_status='pending_review'`, logs event |
| PUT | `/tasks/:id/start-review` | Reviewer: sets `review_status='in_review'`, logs event |
| PUT | `/tasks/:id/approve-review` | Reviewer: sets `review_status='approved'`; if `approval_required` → `approval_status='pending'`; else `qa_status='approved'` |
| PUT | `/tasks/:id/reject-review` | Reviewer: requires `rejection_reason`; sets `qa_status='rejected'`; resets task `status='in_progress'` if was 'review' |
| PUT | `/tasks/:id/approve-final` | Approver: requires review already approved; sets `approval_status='approved'`, `qa_status='approved'` |
| PUT | `/tasks/:id/reject-final` | Approver: requires `rejection_reason`; sets `approval_status='rejected'`, resets `review_status='not_required'` so cycle restarts |
| PUT | `/tasks/:id/qa-lock` | Requires `qa_status='approved'`; sets `qa_locked=true`, `qa_status='locked'` |
| PUT | `/tasks/:id/qa-unlock` | Sets `qa_locked=false`, `qa_status='approved'` |

### Security
- All endpoints: `req.companyId` from JWT (never accepted from body)
- All endpoints: company ownership verified before mutation
- `actor_user_id` stored from `req.user.userId` in every review event

---

## 5. Frontend Changes

### `tasks.html`
- All inline JS removed — now served from `/practice/js/tasks.js`
- Task form: added Review & Approval section with `review_required`/`approval_required` checkboxes, preparer/reviewer/approver selects, review notes field
- Task cards: QA status badge, review status badge, review action buttons rendered per state
- 5 new modals: Approve Review, Reject Review, Final Approve, Final Reject, Review History

### `js/tasks.js`
- `loadTeamMembersForReview()` — populates preparer/reviewer/approver selects using `m.id` (team member ID, not `m.user_id`)
- `renderTasks()` — renders QA/review badges and contextual review action buttons per task state
- `buildReviewActions(t)` — returns the correct set of review action buttons for a task's current state
- `openReviewModal(action, taskId)` — opens the correct review modal for the given action
- `submitReviewAction(action)` — calls the backend review endpoint with correct body
- `openReviewHistory(taskId)` — fetches and renders the review event timeline

### `workflow-editor.js` + `workflow-template.html`
- Step modal: added `requires_review` and `requires_approval` checkboxes
- `openAddStep()` resets both flags; `openEditStep()` populates from step data; `submitStepForm()` includes them in the request body

### `css/practice.css`
- Added: `.task-grid`, `.task-card-header`, `.task-card-title`, `.task-card-meta`, `.task-card-desc`, `.task-review-actions`, `.empty-state`

---

## 6. Key Design Decisions

### `task_id` nullable on review events
`practice_task_review_events.task_id` has no FK constraint so rows survive task hard-deletion. Review history is preserved even if the task is deleted — it is append-only and must never be hard-deleted.

### Separate selects for assigned_to vs review roles
- `assigned_to` uses `m.user_id` (must have a user account to receive task assignments)
- `preparer_team_member_id`, `reviewer_team_member_id`, `approver_team_member_id` use `m.id` (any active team member can hold these roles, regardless of whether they have a user account)

### QA lock blocks general PUT
When `qa_locked=true`, `PUT /tasks/:id` returns 400. Only the dedicated review endpoints (`qa-unlock`, etc.) can operate on locked tasks. This prevents accidental mutation of audited, closed tasks.

### Partial final state for generated tasks
When a workflow step has `requires_review=true`, generated tasks are created with `review_status='not_required'` and `qa_status='required'`. The `submit-review` endpoint then kicks off the flow when the preparer is done.

---

## 7. Migration Command

Apply migration 060 manually in Supabase SQL editor:

```
File: accounting-ecosystem/backend/config/migrations/060_practice_task_review_approval.sql
```

Verify after applying:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'practice_tasks'
  AND column_name IN (
    'preparer_team_member_id', 'reviewer_team_member_id', 'approver_team_member_id',
    'review_required', 'approval_required', 'review_status', 'approval_status',
    'qa_status', 'qa_locked'
  );

SELECT table_name FROM information_schema.tables
WHERE table_name = 'practice_task_review_events';
```
