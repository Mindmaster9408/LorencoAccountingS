# SESSION HANDOFF — Codebox 09: Task Review / Approval Flow Foundation

**Date:** 2026-06-19
**Status:** Code complete — migration 060 must be applied before testing

---

## What Was Changed

### `backend/config/migrations/060_practice_task_review_approval.sql` — NEW
- Adds 21 columns to `practice_tasks` (review/approval state machine columns)
- Adds 2 columns to `practice_workflow_template_steps` (`requires_review`, `requires_approval`)
- Creates `practice_task_review_events` append-only audit table
- Not yet applied — user must run in Supabase SQL editor

### `backend/modules/practice/index.js` — ENHANCED
- Added `verifyTeamMember()` and `logReviewEvent()` helper functions
- Enhanced `GET /tasks`: pagination via `page`/`limit` query params using Supabase `count: 'exact'` + `.range(from, to)`; added `qa_status`, `review_status`, `approval_status`, `reviewer_id`, `preparer_id` filters; adds join to preparer/reviewer/approver display names
- Enhanced `GET /tasks/:id`: same joins added
- Enhanced `POST /tasks`: accepts review/approval fields, validates team member company ownership, sets `qa_status='required'` when `review_required=true`
- Enhanced `PUT /tasks/:id`: blocks if `qa_locked=true`; validates supplied team member IDs; logs `review_fields_updated` event when review fields change; extended allowed fields whitelist
- Added `GET /tasks/:id/review-events`
- Added `PUT /tasks/:id/submit-review`
- Added `PUT /tasks/:id/start-review`
- Added `PUT /tasks/:id/approve-review`
- Added `PUT /tasks/:id/reject-review`
- Added `PUT /tasks/:id/approve-final`
- Added `PUT /tasks/:id/reject-final`
- Added `PUT /tasks/:id/qa-lock`
- Added `PUT /tasks/:id/qa-unlock`

### `backend/modules/practice/services/workflowService.js` — ENHANCED
- Generated tasks now inherit `requires_review` and `requires_approval` from template steps
- `qa_status` set to `'required'` when `requires_review=true`, else `'none'`
- `review_status` and `approval_status` default to `'not_required'` on generated tasks

### `backend/frontend-practice/tasks.html` — REWRITTEN
- All inline JS removed (was ~397 lines inline starting at line 141)
- Now loads `/practice/js/tasks.js` as external script
- Added Review & Approval section to task form modal
- Added 5 new modals: Approve Review, Reject Review, Final Approve, Final Reject, Review History
- QA status filter added to filter bar
- Structure uses `.modal-overlay.show` CSS class pattern (not inline `style.display`)

### `backend/frontend-practice/js/tasks.js` — NEW
- Complete task list page logic (extracted from former inline JS + new review logic)
- `loadTeamMembersForReview()` — loads ALL active team members for preparer/reviewer/approver selects, using `m.id` as option value (not `m.user_id`)
- `renderTasks()` — renders QA badges, review badges, contextual review action buttons
- `buildReviewActions(t)` — returns correct button set for current task state
- `openReviewModal(action, taskId)` — dispatches to correct modal
- `submitReviewAction(action)` — calls correct backend endpoint with correct body
- `openReviewHistory(taskId)` — fetches and renders review event timeline
- Pagination: sends `page`/`limit` to backend, renders prev/next controls

### `backend/frontend-practice/workflow-template.html` — ENHANCED
- Step modal: added `requires_review` and `requires_approval` checkboxes

### `backend/frontend-practice/js/workflow-editor.js` — ENHANCED
- `openAddStep()`: resets both review checkboxes to unchecked
- `openEditStep()`: populates `sRequiresReview` and `sRequiresApproval` from step data
- `submitStepForm()`: includes `requires_review` and `requires_approval` in PUT/POST body

### `backend/frontend-practice/css/practice.css` — ENHANCED
- Added: `.task-grid`, `.task-card-header`, `.task-card-title`, `.task-card-meta`, `.task-card-desc`, `.task-review-actions`, `.empty-state`

---

## What Was NOT Changed

- `workflowService.js` generate deadline logic — unchanged
- `workflows.html` — unchanged
- `deadlines.html` — unchanged
- `clients.html` — unchanged
- Payroll module — not touched
- Auth middleware — not touched

---

## Testing Required Before Go-Live

1. **Apply migration 060** in Supabase SQL editor. Verify with the SQL in the codebox doc.

2. **Task Create with review:**
   - Create a task with "Requires Reviewer Sign-Off" checked
   - Confirm `qa_status = 'required'` in DB
   - Confirm review section shows in modal correctly

3. **Review flow end-to-end:**
   - Submit for review → confirm `qa_status = 'pending_review'`
   - Start review → confirm `review_status = 'in_review'`
   - Approve review (no approval required) → confirm `qa_status = 'approved'`
   - QA lock → confirm `qa_locked = true`
   - Try editing locked task → confirm 400 error

4. **Full three-tier flow:**
   - Create task with both checkboxes checked
   - Submit → start → approve-review → confirm `approval_status = 'pending'`
   - Final approve → confirm `qa_status = 'approved'`
   - Final reject → confirm `approval_status = 'rejected'` and `review_status = 'not_required'`

5. **Reject flow:**
   - Reject review → confirm `rejection_reason` required
   - Confirm task `status` resets to `'in_progress'`

6. **Review history modal:**
   - After running some actions, open history
   - Confirm events appear in timeline with correct types and timestamps

7. **Workflow step review flags:**
   - Open a template, add a step, check "Requires Review"
   - Generate a workflow run — confirm the generated task has `review_required = true`

8. **Pagination:**
   - If 26+ tasks exist, confirm page 2 loads the next batch correctly

---

## Open Follow-Up Items

- Notifications: no email/push notification system exists yet — reviewers and approvers must manually check the task list for pending actions
- Bulk review assignment: if many tasks need the same reviewer, there's no bulk-assign UI yet
- Review deadline: tasks with pending reviews don't have a separate review due date — the task's `due_date` is the only deadline signal
